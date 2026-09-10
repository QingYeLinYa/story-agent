import path from "node:path";
import { resolveDataDir } from "../runtimePaths.js";

export function embeddingEnabled(): boolean {
  const v = (process.env.STORY_EMBEDDING ?? "local").toLowerCase();
  return v !== "off" && v !== "0" && v !== "false";
}

export function embeddingModelName(): string {
  return process.env.STORY_EMBEDDING_MODEL || "Xenova/bge-small-zh-v1.5";
}

/** BGE query instruction; passages stay raw. */
const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";

type Extractor = (
  text: string,
  opts: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array | number[] }>;

let extractor: Extractor | null = null;
let loadFailed = false;

export function embeddingStatus(): {
  enabled: boolean;
  model: string;
  mode: "off" | "http" | "local";
  ready: boolean;
} {
  const http = Boolean(process.env.STORY_EMBEDDING_BASE_URL);
  return {
    enabled: embeddingEnabled(),
    model: embeddingModelName(),
    mode: !embeddingEnabled() ? "off" : http ? "http" : "local",
    ready: Boolean(extractor) || http,
  };
}

async function getLocalExtractor(): Promise<Extractor | null> {
  if (loadFailed) return null;
  if (extractor) return extractor;
  try {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = path.join(resolveDataDir(), "models");
    env.allowLocalModels = true;
    env.allowRemoteModels = true;

    const hosts = [
      process.env.STORY_HF_ENDPOINT,
      process.env.HF_ENDPOINT,
      "https://huggingface.co",
      "https://hf-mirror.com",
    ]
      .filter((h): h is string => Boolean(h))
      .map((h) => (h.endsWith("/") ? h : `${h}/`));
    const unique = [...new Set(hosts)];

    let lastErr: unknown;
    for (const host of unique) {
      try {
        env.remoteHost = host;
        const pipe = (await pipeline(
          "feature-extraction",
          embeddingModelName()
        )) as (text: string, opts: { pooling: "mean"; normalize: boolean }) => Promise<{
          data?: Float32Array | number[];
        }>;
        extractor = async (text, opts) => {
          const out = await pipe(text, opts);
          return { data: out.data || [] };
        };
        console.log(
          `[retrieval] embedding model ready: ${embeddingModelName()} via ${host}`
        );
        return extractor;
      } catch (err) {
        lastErr = err;
        console.warn(`[retrieval] load via ${host} failed, trying next`);
      }
    }
    throw lastErr;
  } catch (err) {
    loadFailed = true;
    console.error("[retrieval] local embedding model failed, FTS-only", err);
    return null;
  }
}

async function embedHttp(texts: string[]): Promise<Float32Array[] | null> {
  const base = (process.env.STORY_EMBEDDING_BASE_URL || "").replace(/\/$/, "");
  const url = `${base}/embeddings`;
  const key = process.env.STORY_EMBEDDING_API_KEY || "";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model: process.env.STORY_EMBEDDING_MODEL || "nomic-embed-text",
      input: texts,
    }),
  });
  if (!res.ok) {
    throw new Error(`embedding HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    data?: { embedding: number[]; index: number }[];
  };
  const rows = [...(json.data || [])].sort((a, b) => a.index - b.index);
  if (rows.length !== texts.length) return null;
  return rows.map((r) => Float32Array.from(r.embedding));
}

export async function embedTexts(
  texts: string[],
  isQuery = false
): Promise<Float32Array[] | null> {
  if (!embeddingEnabled() || !texts.length) return null;
  const prepared = texts.map((t) => {
    const cut = t.replace(/\s+/g, " ").slice(0, 1200);
    return isQuery ? QUERY_PREFIX + cut : cut;
  });

  if (process.env.STORY_EMBEDDING_BASE_URL) {
    try {
      return await embedHttp(prepared);
    } catch (err) {
      console.error("[retrieval] HTTP embedding failed", err);
      return null;
    }
  }

  const pipe = await getLocalExtractor();
  if (!pipe) return null;
  const out: Float32Array[] = [];
  for (const text of prepared) {
    const result = await pipe(text, { pooling: "mean", normalize: true });
    out.push(Float32Array.from(result.data));
  }
  return out;
}

export async function embedQuery(query: string): Promise<Float32Array | null> {
  const vecs = await embedTexts([query], true);
  return vecs?.[0] || null;
}
