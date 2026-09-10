import { Command, INTERRUPT, isInterrupted } from "@langchain/langgraph";
import type { DeepseekConfig } from "../deepseek.js";
import type { SkillMeta } from "../skillLoader.js";
import type { SandboxRoots } from "../agents/sandbox.js";
import type {
  ChatTurn,
  InterruptPayload,
  OrchestratorEvent,
  WriteDecision,
} from "../agents/types.js";
import { hitlWritesEnabled } from "../runtimePaths.js";
import { runWithEmit } from "./als.js";
import { compileStoryGraph, type GraphDeps } from "./compile.js";

let graph: ReturnType<typeof compileStoryGraph> | null = null;
let deps: GraphDeps | null = null;

export function initStoryGraph(next: GraphDeps): void {
  deps = next;
  graph = compileStoryGraph(next);
}

export function requireGraph() {
  if (!graph || !deps) {
    throw new Error("Story graph 尚未初始化");
  }
  return { graph, deps };
}

async function* emitFromQueue(
  run: (emit: (e: OrchestratorEvent) => void) => Promise<void>
): AsyncGenerator<OrchestratorEvent> {
  const events: OrchestratorEvent[] = [];
  let notify: (() => void) | null = null;
  let finished = false;

  const wake = () => {
    const n = notify;
    notify = null;
    n?.();
  };

  const emit = (e: OrchestratorEvent) => {
    events.push(e);
    wake();
  };

  const running = run(emit)
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message });
    })
    .finally(() => {
      finished = true;
      wake();
    });

  while (!finished || events.length) {
    if (!events.length) {
      await new Promise<void>((resolve) => {
        notify = resolve;
        if (events.length || finished) {
          notify = null;
          resolve();
        }
      });
    }
    while (events.length) yield events.shift()!;
  }
  await running;
}

function interruptPayloadOf(result: unknown): InterruptPayload | null {
  if (!isInterrupted(result)) return null;
  const raw = result[INTERRUPT][0]?.value;
  if (raw && typeof raw === "object" && (raw as InterruptPayload).type) {
    return raw as InterruptPayload;
  }
  return null;
}

export async function* runStoryTurn(options: {
  threadId: string;
  skill: SkillMeta;
  degraded?: string;
  referenceSnippets: { path: string; content: string }[];
  history: ChatTurn[];
  lastUser: string;
  config: DeepseekConfig;
  roots: SandboxRoots;
}): AsyncGenerator<OrchestratorEvent> {
  const { graph } = requireGraph();
  const config = { configurable: { thread_id: options.threadId } };

  yield* emitFromQueue(async (emit) => {
    emit({
      type: "thread",
      threadId: options.threadId,
      status: "running",
    });
    await runWithEmit(emit, async () => {
      const result = await graph.invoke(
        {
          history: options.history,
          lastUser: options.lastUser,
          skillName: options.skill.name,
          degraded: options.degraded,
          references: options.referenceSnippets,
          hitlWrites: hitlWritesEnabled(),
        },
        config
      );
      const payload = interruptPayloadOf(result);
      if (payload) {
        emit({ type: "interrupt", payload });
        emit({
          type: "thread",
          threadId: options.threadId,
          status: "interrupted",
        });
        emit({ type: "done", ok: true, status: "interrupted" });
        return;
      }
      emit({ type: "thread", threadId: options.threadId, status: "done" });
      emit({ type: "done", ok: true, status: "done" });
    });
  });
}

export async function* resumeStoryTurn(options: {
  threadId: string;
  decision: WriteDecision;
}): AsyncGenerator<OrchestratorEvent> {
  const { graph } = requireGraph();
  const config = { configurable: { thread_id: options.threadId } };

  yield* emitFromQueue(async (emit) => {
    emit({
      type: "thread",
      threadId: options.threadId,
      status: "running",
    });
    await runWithEmit(emit, async () => {
      const result = await graph.invoke(
        new Command({ resume: options.decision }),
        config
      );
      const payload = interruptPayloadOf(result);
      if (payload) {
        emit({ type: "interrupt", payload });
        emit({
          type: "thread",
          threadId: options.threadId,
          status: "interrupted",
        });
        emit({ type: "done", ok: true, status: "interrupted" });
        return;
      }
      emit({ type: "thread", threadId: options.threadId, status: "done" });
      emit({ type: "done", ok: true, status: "done" });
    });
  });
}

export async function getThreadSnapshot(threadId: string) {
  const { graph } = requireGraph();
  const snap = await graph.getState({
    configurable: { thread_id: threadId },
  });
  const values = (snap.values || {}) as Record<string, unknown>;
  const tasks = (snap.tasks || []) as {
    interrupts?: { value: unknown }[];
  }[];
  const interrupts = tasks.flatMap((t) => t.interrupts || []);
  return {
    threadId,
    next: snap.next,
    intent: values.intent,
    skillName: values.skillName,
    pendingWrites: values.pendingWrites,
    interrupts: interrupts.map((i) => i.value),
  };
}
