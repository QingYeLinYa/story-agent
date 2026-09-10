export type AgentId =
  | "story-architect"
  | "character-designer"
  | "narrative-writer"
  | "consistency-checker"
  | "story-explorer"
  | "chapter-extractor"
  | "story-researcher"
  | "synthesizer";

export type AgentDef = {
  id: Exclude<AgentId, "synthesizer">;
  name: string;
  role: string;
  canWrite: boolean;
  prompt: string;
};

export type PlanStep = {
  id: Exclude<AgentId, "synthesizer">;
  name: string;
  task: string;
  parallelGroup: number;
};

export type PlanSource = "llm" | "rules";

export type Plan = {
  intent: string;
  steps: PlanStep[];
  retrieve?: boolean;
  source?: PlanSource;
};

export type ToolCallTrace = {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  preview: string;
};

export type WorkerResult = {
  id: Exclude<AgentId, "synthesizer">;
  name: string;
  content: string;
  tools: ToolCallTrace[];
  pendingWrites: PendingWrite[];
  error?: string;
};

export type PendingWrite = {
  agent: string;
  path: string;
  content: string;
};

export type WriteDecision = {
  action: "auto" | "approve" | "reject";
};

export type RetrievalHit = {
  path: string;
  book: string;
  kind: string;
  score: number;
  snippet: string;
  source?: "fts" | "vector" | "hybrid";
};

export type InterruptPayload = {
  type: "approve_writes";
  writes: {
    agent: string;
    path: string;
    bytes: number;
    preview: string;
  }[];
};

export type OrchestratorEvent =
  | {
      type: "thread";
      threadId: string;
      status: "running" | "interrupted" | "done";
    }
  | {
      type: "plan";
      intent: string;
      agents: { id: AgentId; name: string }[];
      source?: PlanSource;
      retrieve?: boolean;
    }
  | { type: "retrieval"; hits: RetrievalHit[] }
  | { type: "agent_start"; id: AgentId; name: string }
  | {
      type: "tool";
      agent: AgentId;
      name: string;
      args: Record<string, unknown>;
      ok: boolean;
      preview: string;
    }
  | {
      type: "agent_done";
      id: AgentId;
      name: string;
      summary: string;
      tools: ToolCallTrace[];
    }
  | { type: "interrupt"; payload: InterruptPayload }
  | { type: "token"; token: string }
  | { type: "done"; ok: true; status: "interrupted" | "done" }
  | { type: "error"; message: string };

export type ChatTurn = { role: "user" | "assistant"; content: string };
