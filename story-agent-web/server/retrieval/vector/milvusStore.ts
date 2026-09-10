import type { RetrievalHit } from "../../agents/types.js";
import { collectionName, type VectorRecord, type VectorStore } from "./types.js";

export function milvusAddress(): string {
  return process.env.MILVUS_ADDRESS || "127.0.0.1:19530";
}

export async function createMilvusStore(): Promise<VectorStore> {
  const { MilvusClient, DataType, MetricType } = await import(
    "@zilliz/milvus2-sdk-node"
  );
  const client = new MilvusClient({ address: milvusAddress() });
  const name = collectionName();
  const dim = Number(process.env.STORY_EMBEDDING_DIM || 512);

  const has = await client.hasCollection({ collection_name: name });
  if (!has.value) {
    await client.createCollection({
      collection_name: name,
      fields: [
        {
          name: "id",
          data_type: DataType.VarChar,
          max_length: 256,
          is_primary_key: true,
        },
        {
          name: "path",
          data_type: DataType.VarChar,
          max_length: 512,
        },
        {
          name: "book",
          data_type: DataType.VarChar,
          max_length: 128,
        },
        {
          name: "kind",
          data_type: DataType.VarChar,
          max_length: 32,
        },
        {
          name: "snippet",
          data_type: DataType.VarChar,
          max_length: 2000,
        },
        {
          name: "embedding",
          data_type: DataType.FloatVector,
          dim,
        },
      ],
    });
    await client.createIndex({
      collection_name: name,
      field_name: "embedding",
      index_name: "embedding_hnsw",
      index_type: "HNSW",
      metric_type: MetricType.COSINE,
      params: { M: 16, efConstruction: 64 },
    });
  }
  await client.loadCollectionSync({ collection_name: name });

  return {
    backend: "milvus",
    async upsert(records: VectorRecord[]) {
      if (!records.length) return;
      const batch = 64;
      for (let i = 0; i < records.length; i += batch) {
        const slice = records.slice(i, i + batch);
        await client.upsert({
          collection_name: name,
          data: slice.map((r) => ({
            id: r.id.slice(0, 256),
            path: r.path.slice(0, 512),
            book: r.book.slice(0, 128),
            kind: r.kind.slice(0, 32),
            snippet: r.snippet.slice(0, 2000),
            embedding: r.embedding,
          })),
        });
      }
    },
    async search(query: number[], limit: number): Promise<RetrievalHit[]> {
      const res = await client.search({
        collection_name: name,
        data: [query],
        limit,
        output_fields: ["path", "book", "kind", "snippet"],
        metric_type: MetricType.COSINE,
      });
      const results = (res.results || []) as {
        score?: number;
        path?: string;
        book?: string;
        kind?: string;
        snippet?: string;
      }[];
      return results.map((r) => ({
        path: r.path || "",
        book: r.book || "",
        kind: r.kind || "other",
        snippet: (r.snippet || "").slice(0, 500),
        score: Number(r.score ?? 0),
        source: "vector" as const,
      }));
    },
    async count() {
      const stats = await client.getCollectionStatistics({
        collection_name: name,
      });
      const row = (stats.data || stats.stats || []) as {
        key?: string;
        value?: string;
      }[];
      const found = Array.isArray(row)
        ? row.find((x) => x.key === "row_count")
        : undefined;
      return Number(found?.value || 0);
    },
  };
}
