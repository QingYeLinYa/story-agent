import { vectorBackend, type VectorStore } from "./types.js";
import { createChromaStore } from "./chromaStore.js";
import { createMilvusStore } from "./milvusStore.js";

let store: VectorStore | null | undefined;
let lastError: string | null = null;

export async function getVectorStore(): Promise<VectorStore | null> {
  if (store !== undefined) return store;
  const backend = vectorBackend();
  if (backend === "sqlite") {
    store = null;
    return null;
  }
  try {
    store =
      backend === "milvus"
        ? await createMilvusStore()
        : await createChromaStore();
    lastError = null;
    console.log(`[retrieval] vector backend: ${store.backend}`);
    return store;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn(
      `[retrieval] ${backend} unavailable (${lastError}); vector search falls back to SQLite`
    );
    store = null;
    return null;
  }
}

export function resetVectorStore(): void {
  store = undefined;
  lastError = null;
}

export async function vectorStoreStatus() {
  const backend = vectorBackend();
  const live = await getVectorStore();
  let count = 0;
  if (live) {
    try {
      count = await live.count();
    } catch {
      count = 0;
    }
  }
  return {
    configured: backend,
    connected: Boolean(live),
    using: live?.backend || "sqlite",
    count,
    error: lastError,
  };
}
