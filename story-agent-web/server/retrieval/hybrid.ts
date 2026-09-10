import type { RetrievalHit } from "../agents/types.js";

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function rrfMerge(
  lists: RetrievalHit[][],
  limit: number,
  k = 60
): RetrievalHit[] {
  const scores = new Map<
    string,
    { hit: RetrievalHit; score: number; sources: Set<string> }
  >();

  for (const list of lists) {
    list.forEach((hit, i) => {
      const key = `${hit.path}\0${hit.snippet.slice(0, 80)}`;
      const add = 1 / (k + i + 1);
      const cur = scores.get(key);
      const src = hit.source || "fts";
      if (cur) {
        cur.score += add;
        cur.sources.add(src);
      } else {
        scores.set(key, {
          hit,
          score: add,
          sources: new Set([src]),
        });
      }
    });
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, score, sources }) => {
      const source: RetrievalHit["source"] =
        sources.size > 1 ? "hybrid" : ([...sources][0] as RetrievalHit["source"]);
      return { ...hit, score, source };
    });
}

export function blobToVector(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

export function vectorToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
