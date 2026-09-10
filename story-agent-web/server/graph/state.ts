import { Annotation } from "@langchain/langgraph";
import type {
  ChatTurn,
  InterruptPayload,
  PendingWrite,
  Plan,
  RetrievalHit,
  WorkerResult,
  WriteDecision,
} from "../agents/types.js";

function last<T>(fallback: T) {
  return Annotation<T>({
    reducer: (_left: T, right: T) => right,
    default: () => fallback,
  });
}

export const StoryState = Annotation.Root({
  history: last<ChatTurn[]>([]),
  lastUser: last(""),
  skillName: last(""),
  degraded: last<string | undefined>(undefined),
  references: last<{ path: string; content: string }[]>([]),
  hitlWrites: last(true),
  intent: last(""),
  plan: last<Plan>({ intent: "direct", steps: [], retrieve: false, source: "rules" }),
  retrieval: last<RetrievalHit[]>([]),
  workers: last<WorkerResult[]>([]),
  pendingWrites: last<PendingWrite[]>([]),
  writeDecision: last<WriteDecision | null>(null),
  appliedWrites: last<string[]>([]),
  interruptPayload: last<InterruptPayload | null>(null),
});

export type StoryStateType = typeof StoryState.State;
