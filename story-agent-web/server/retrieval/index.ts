import Database from "better-sqlite3";
import { retrievalDbPath } from "../runtimePaths.js";
import { embedQuery, embeddingStatus } from "./embed.js";
import { vectorStoreStatus } from "./vector/index.js";
import {
  corpusStats,
  indexCorpus,
  openRetrievalDb,
  searchHybrid,
  type RetrievalHit,
} from "./store.js";

let db: Database.Database | null = null;

export function getRetrievalDb(): Database.Database {
  if (db) return db;
  db = openRetrievalDb(retrievalDbPath());
  return db;
}

export async function reindexRetrieval(projectRoot: string) {
  return indexCorpus(getRetrievalDb(), projectRoot);
}

export async function retrieve(
  query: string,
  limit = 8
): Promise<RetrievalHit[]> {
  const vec = await embedQuery(query);
  return searchHybrid(getRetrievalDb(), query, vec, limit);
}

export async function retrievalStats() {
  return {
    ...corpusStats(getRetrievalDb()),
    embedding: embeddingStatus(),
    vector: await vectorStoreStatus(),
  };
}

export function formatRetrieval(hits: RetrievalHit[]): string {
  if (!hits.length) return "";
  return hits
    .map((h, i) => {
      const src = h.source ? ` · ${h.source}` : "";
      return `### [${i + 1}] ${h.book || "拆文"} · ${h.kind} · ${h.path}${src}\n${h.snippet}`;
    })
    .join("\n\n");
}
