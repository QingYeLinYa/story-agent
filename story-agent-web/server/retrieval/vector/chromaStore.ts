import type { RetrievalHit } from "../../agents/types.js";
import { collectionName, type VectorRecord, type VectorStore } from "./types.js";

export function chromaUrl(): string {
  return (process.env.CHROMA_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
}

export async function createChromaStore(): Promise<VectorStore> {
  const { ChromaClient } = await import("chromadb");
  const url = new URL(chromaUrl());
  const client = new ChromaClient({
    host: url.hostname,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 8000)),
    ssl: url.protocol === "https:",
  });

  await Promise.race([
    client.heartbeat(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Chroma heartbeat timeout")), 2500)
    ),
  ]);
  const collection = await client.getOrCreateCollection({
    name: collectionName(),
    metadata: { "hnsw:space": "cosine" },
    embeddingFunction: null,
  });

  return {
    backend: "chroma",
    async upsert(records: VectorRecord[]) {
      if (!records.length) return;
      const batch = 100;
      for (let i = 0; i < records.length; i += batch) {
        const slice = records.slice(i, i + batch);
        await collection.upsert({
          ids: slice.map((r) => r.id),
          embeddings: slice.map((r) => r.embedding),
          documents: slice.map((r) => r.snippet.slice(0, 2000)),
          metadatas: slice.map((r) => ({
            path: r.path,
            book: r.book,
            kind: r.kind,
          })),
        });
      }
    },
    async search(query: number[], limit: number): Promise<RetrievalHit[]> {
      const res = await collection.query({
        queryEmbeddings: [query],
        nResults: limit,
      });
      const ids = res.ids?.[0] || [];
      const docs = res.documents?.[0] || [];
      const metas = res.metadatas?.[0] || [];
      const dists = res.distances?.[0] || [];
      return ids.map((id, i) => {
        const meta = (metas[i] || {}) as {
          path?: string;
          book?: string;
          kind?: string;
        };
        const dist = Number(dists[i] ?? 1);
        return {
          path: meta.path || String(id),
          book: meta.book || "",
          kind: meta.kind || "other",
          snippet: (docs[i] || "").slice(0, 500),
          score: 1 - dist,
          source: "vector" as const,
        };
      });
    },
    async count() {
      return collection.count();
    },
  };
}
