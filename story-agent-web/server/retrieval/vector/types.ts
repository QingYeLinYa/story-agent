import type { RetrievalHit } from "../../agents/types.js";

export type VectorRecord = {
  id: string;
  path: string;
  book: string;
  kind: string;
  snippet: string;
  embedding: number[];
};

export type VectorStore = {
  backend: "chroma" | "milvus";
  upsert(records: VectorRecord[]): Promise<void>;
  search(query: number[], limit: number): Promise<RetrievalHit[]>;
  count(): Promise<number>;
};

export function collectionName(): string {
  return process.env.STORY_VECTOR_COLLECTION || "story_corpus";
}

export function vectorBackend(): "chroma" | "milvus" | "sqlite" {
  const v = (process.env.STORY_VECTOR_BACKEND || "chroma").toLowerCase();
  if (v === "milvus") return "milvus";
  if (v === "sqlite" || v === "off") return "sqlite";
  return "chroma";
}

export function recordId(path: string, chunkI: number): string {
  return `${path}::${chunkI}`;
}
