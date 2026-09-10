import {
  completeDeepseekChat,
  type ChatMessage,
  type DeepseekConfig,
} from "../deepseek.js";
import { AGENTS } from "./registry.js";
import { executeTool, toolSchemasFor } from "./tools.js";
import type { SandboxRoots } from "./sandbox.js";
import type {
  ChatTurn,
  PlanStep,
  PendingWrite,
  ToolCallTrace,
  WorkerResult,
} from "./types.js";

const MAX_TOOL_ROUNDS = 6;
const MAX_OUTPUT = 6_000;

export type ToolListener = (trace: ToolCallTrace) => void | Promise<void>;

export async function runWorker(options: {
  step: PlanStep;
  config: DeepseekConfig;
  roots: SandboxRoots;
  history: ChatTurn[];
  priorNotes: string;
  deferWrites?: boolean;
  onTool?: ToolListener;
}): Promise<WorkerResult> {
  const agent = AGENTS[options.step.id];
  const tools: ToolCallTrace[] = [];
  const pendingWrites: PendingWrite[] = [];

  const system = [
    agent.prompt,
    "",
    `项目沙箱（可写范围）：${options.roots.projectRoot}`,
    `技能资料（只读）：${options.roots.skillsDir}`,
    `本轮任务：${options.step.task}`,
    options.priorNotes
      ? `\n上游子 Agent 已产出：\n${options.priorNotes}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const recent = options.history.slice(-6);
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...recent.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await completeDeepseekChat(options.config, messages, {
        tools: toolSchemasFor(agent.canWrite),
        temperature: agent.id === "narrative-writer" ? 0.7 : 0.4,
      });

      if (result.toolCalls.length) {
        messages.push({
          role: "assistant",
          content: result.content || null,
          tool_calls: result.toolCalls,
        });

        for (const call of result.toolCalls) {
          const executed = executeTool(
            options.roots,
            call.function.name,
            call.function.arguments || "{}",
            agent.canWrite,
            {
              deferWrites: options.deferWrites,
              pendingWrites,
              agentId: agent.id,
            }
          );
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            args = {};
          }
          const trace: ToolCallTrace = {
            name: call.function.name,
            args,
            ok: executed.ok,
            preview: executed.preview,
          };
          tools.push(trace);
          await options.onTool?.(trace);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: executed.payload,
          });
        }
        continue;
      }

      const content = (result.content || "").slice(0, MAX_OUTPUT);
      return {
        id: agent.id,
        name: agent.name,
        content: content || "（无文本产出）",
        tools,
        pendingWrites,
      };
    }

    return {
      id: agent.id,
      name: agent.name,
      content: "工具轮次用尽，未能收束结论。",
      tools,
      pendingWrites,
      error: "max_tool_rounds",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: agent.id,
      name: agent.name,
      content: `子 Agent 失败：${message}`,
      tools,
      pendingWrites,
      error: message,
    };
  }
}
