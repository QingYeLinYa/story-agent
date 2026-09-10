import fs from "node:fs";
import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { checkpointDbPath } from "../runtimePaths.js";

let saver: SqliteSaver | null = null;

export function getCheckpointer(): SqliteSaver {
  if (saver) return saver;
  const dbPath = checkpointDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  saver = SqliteSaver.fromConnString(dbPath);
  try {
    saver.db.pragma("journal_mode = WAL");
  } catch {
    // ignore
  }
  return saver;
}

export function checkpointPath(): string {
  return checkpointDbPath();
}
