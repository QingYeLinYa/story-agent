import fs from "node:fs";
import path from "node:path";

export function resolveDataDir(): string {
  const fromEnv = process.env.STORY_DATA_DIR;
  const dir = fromEnv
    ? path.isAbsolute(fromEnv)
      ? fromEnv
      : path.resolve(process.cwd(), fromEnv)
    : path.resolve(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function checkpointDbPath(): string {
  const fromEnv = process.env.STORY_CHECKPOINT_DB;
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.resolve(process.cwd(), fromEnv);
  }
  return path.join(resolveDataDir(), "checkpoints.sqlite");
}

export function retrievalDbPath(): string {
  const fromEnv = process.env.STORY_RETRIEVAL_DB;
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.resolve(process.cwd(), fromEnv);
  }
  return path.join(resolveDataDir(), "retrieval.sqlite");
}

export function llmPlannerEnabled(): boolean {
  const v = (process.env.STORY_LLM_PLANNER ?? "true").toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

export function hitlWritesEnabled(): boolean {
  const v = (process.env.STORY_HITL_WRITES ?? "true").toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}
