import {
  END,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import { buildSystemPrompt } from "../prompt.js";
import { streamDeepseekChat, type DeepseekConfig } from "../deepseek.js";
import type { SkillMeta } from "../skillLoader.js";
import { groupPlan, planTurn } from "../agents/planner.js";
import { runWorker } from "../agents/runner.js";
import { applyPendingWrites } from "../agents/tools.js";
import type { SandboxRoots } from "../agents/sandbox.js";
import type {
  InterruptPayload,
  Plan,
  RetrievalHit,
  WorkerResult,
  WriteDecision,
} from "../agents/types.js";
import { emitEvent } from "./als.js";
import { getCheckpointer } from "./checkpointer.js";
import { StoryState, type StoryStateType } from "./state.js";
import { formatRetrieval, retrieve } from "../retrieval/index.js";

export type GraphDeps = {
  skills: Map<string, SkillMeta>;
  roots: SandboxRoots;
  llm: DeepseekConfig;
};

function brief(result: WorkerResult): string {
  const head = result.content.slice(0, 240).replace(/\s+/g, " ");
  return result.error ? `${head}（失败：${result.error}）` : head;
}

function formatNotes(results: WorkerResult[]): string {
  if (!results.length) return "";
  return results
    .map((r) => {
      const tools = r.tools.length
        ? `\n工具：${r.tools.map((t) => `${t.name}${t.ok ? "" : "×"}`).join("、")}`
        : "";
      return `### ${r.name}（${r.id}）\n${r.content}${tools}`;
    })
    .join("\n\n");
}

async function planNode(state: StoryStateType, deps: GraphDeps) {
  const plan = await planTurn({
    llm: deps.llm,
    skill: state.skillName,
    userText: state.lastUser,
    history: state.history,
    degraded: state.degraded,
  });
  const agents = [
    ...plan.steps.map((s) => ({
      id: s.id as (typeof s.id) | "synthesizer",
      name: s.name,
    })),
    { id: "synthesizer" as const, name: "综合写手" },
  ];
  emitEvent({
    type: "plan",
    intent: plan.intent,
    agents,
    source: plan.source,
    retrieve: Boolean(plan.retrieve),
  });
  return { intent: plan.intent, plan };
}

async function retrieveNode(state: StoryStateType) {
  const plan = state.plan as Plan;
  if (!plan.retrieve) {
    emitEvent({ type: "retrieval", hits: [] });
    return { retrieval: [] as RetrievalHit[] };
  }
  const hits = await retrieve(state.lastUser, 8);
  emitEvent({ type: "retrieval", hits });
  return { retrieval: hits };
}

async function workersNode(state: StoryStateType, deps: GraphDeps) {
  const collected: WorkerResult[] = [];
  const pending: WorkerResult["pendingWrites"] = [];
  const retrievalNotes = formatRetrieval(state.retrieval);

  for (const group of groupPlan(state.plan as Plan)) {
    const notes = [
      retrievalNotes,
      formatNotes(collected).slice(0, 8_000),
    ]
      .filter(Boolean)
      .join("\n\n");

    for (const step of group) {
      emitEvent({ type: "agent_start", id: step.id, name: step.name });
    }

    const results = await Promise.all(
      group.map((step) =>
        runWorker({
          step,
          config: deps.llm,
          roots: deps.roots,
          history: state.history,
          priorNotes: notes,
          deferWrites: state.hitlWrites,
          onTool: (trace) => {
            emitEvent({
              type: "tool",
              agent: step.id,
              name: trace.name,
              args: trace.args,
              ok: trace.ok,
              preview: trace.preview,
            });
          },
        })
      )
    );

    for (const result of results) {
      collected.push(result);
      pending.push(...result.pendingWrites);
      emitEvent({
        type: "agent_done",
        id: result.id,
        name: result.name,
        summary: brief(result),
        tools: result.tools,
      });
    }
  }

  return { workers: collected, pendingWrites: pending };
}

function hitlNode(state: StoryStateType) {
  if (!state.hitlWrites || state.pendingWrites.length === 0) {
    return {
      writeDecision: { action: "auto" } satisfies WriteDecision,
      interruptPayload: null,
    };
  }

  const payload: InterruptPayload = {
    type: "approve_writes",
    writes: state.pendingWrites.map((w) => ({
      agent: w.agent,
      path: w.path,
      bytes: Buffer.byteLength(w.content, "utf8"),
      preview: w.content.slice(0, 180),
    })),
  };

  const decision = interrupt(payload) as WriteDecision;
  return { writeDecision: decision, interruptPayload: payload };
}

function applyNode(state: StoryStateType, deps: GraphDeps) {
  const action = state.writeDecision?.action || "auto";
  if (action === "reject" || state.pendingWrites.length === 0) {
    return { appliedWrites: [] as string[] };
  }
  const results = applyPendingWrites(deps.roots, state.pendingWrites);
  return { appliedWrites: results.filter((r) => r.ok).map((r) => r.path) };
}

async function synthesizeNode(state: StoryStateType, deps: GraphDeps) {
  const skill = deps.skills.get(state.skillName);
  if (!skill) {
    emitEvent({ type: "error", message: `skill 不存在：${state.skillName}` });
    return {};
  }

  emitEvent({ type: "agent_start", id: "synthesizer", name: "综合写手" });

  const workerBlock = formatNotes(state.workers);
  const retrievalBlock = formatRetrieval(state.retrieval);
  const writeNote =
    state.writeDecision?.action === "reject"
      ? "用户拒绝了待写入文件，不要假装已经落盘。"
      : state.appliedWrites.length
        ? `已写入：${state.appliedWrites.join("、")}`
        : "";

  const system = [
    buildSystemPrompt(skill, {
      degraded: state.degraded,
      referenceSnippets: state.references,
    }),
    retrievalBlock
      ? `\n----- 拆文检索 -----\n${retrievalBlock.slice(0, 12_000)}\n----- END 检索 -----`
      : "",
    workerBlock
      ? `\n----- 子 Agent 产出 -----\n${workerBlock.slice(0, 24_000)}\n----- END -----`
      : "",
    writeNote,
    "请整合上述产出回复用户。子 Agent 已写入的文件据实说明路径；不要重复调用 spawn。",
  ]
    .filter(Boolean)
    .join("\n");

  const apiMessages = [
    { role: "system" as const, content: system },
    ...state.history.slice(-12).map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  let tokens = 0;
  for await (const token of streamDeepseekChat(deps.llm, apiMessages)) {
    tokens += token.length;
    emitEvent({ type: "token", token });
  }
  emitEvent({
    type: "agent_done",
    id: "synthesizer",
    name: "综合写手",
    summary: tokens ? `已流式回复 ${tokens} 字` : "无文本",
    tools: [],
  });
  return {};
}

export function compileStoryGraph(deps: GraphDeps) {
  return new StateGraph(StoryState)
    .addNode("plan", (s) => planNode(s, deps))
    .addNode("retrieve", (s) => retrieveNode(s))
    .addNode("workers", (s) => workersNode(s, deps))
    .addNode("hitl", (s) => hitlNode(s))
    .addNode("apply", (s) => applyNode(s, deps))
    .addNode("synthesize", (s) => synthesizeNode(s, deps))
    .addEdge(START, "plan")
    .addEdge("plan", "retrieve")
    .addEdge("retrieve", "workers")
    .addEdge("workers", "hitl")
    .addEdge("hitl", "apply")
    .addEdge("apply", "synthesize")
    .addEdge("synthesize", END)
    .compile({ checkpointer: getCheckpointer() });
}
