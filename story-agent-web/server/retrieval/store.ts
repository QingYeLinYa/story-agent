import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { RetrievalHit } from "../agents/types.js";
import { embeddingModelName, embedTexts } from "./embed.js";
import {
  blobToVector,
  cosine,
  rrfMerge,
  vectorToBlob,
} from "./hybrid.js";
import { getVectorStore } from "./vector/index.js";
import { recordId, type VectorRecord } from "./vector/types.js";

export type { RetrievalHit };

const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

export function toFtsBody(text: string): string {
  const compact = text.replace(/\s+/g, "");
  const grams: string[] = [];
  const chars = [...compact];
  for (let i = 0; i < chars.length - 1; i++) {
    grams.push(chars[i] + chars[i + 1]);
  }
  const ascii = text.match(/[A-Za-z0-9_]+/g) || [];
  return [...grams.slice(0, 4000), ...ascii].join(" ");
}

export function toFtsQuery(query: string): string {
  const compact = query.replace(/\s+/g, "");
  const grams: string[] = [];
  const chars = [...compact];
  for (let i = 0; i < chars.length - 1 && grams.length < 24; i++) {
    const g = chars[i] + chars[i + 1];
    if (/^[\s\p{P}]+$/u.test(g)) continue;
    grams.push(g);
  }
  const ascii = query.match(/[A-Za-z0-9_]+/g) || [];
  const tokens = [...grams, ...ascii].map((t) => `"${t.replace(/"/g, "")}"`);
  return tokens.join(" OR ") || '""';
}

function kindOf(rel: string): string {
  const n = rel.replace(/\\/g, "/");
  if (n.includes("/章节/") || /摘要|情节点/.test(n)) return "chapter";
  if (n.includes("/角色/")) return "character";
  if (n.includes("/设定/") || n.includes("/世界观/") || n.includes("/势力/"))
    return "setting";
  if (n.includes("/_agg/") || n.includes("聚合")) return "aggregate";
  if (/黄金三章|拆文报告/.test(n)) return "report";
  return "other";
}

function bookOf(rel: string): string {
  const n = rel.replace(/\\/g, "/");
  const m = n.match(/拆文库\/([^/]+)/);
  return m?.[1] || "";
}

export function isCorpusFile(rel: string): boolean {
  const n = rel.replace(/\\/g, "/");
  if (!n.endsWith(".md")) return false;
  return (
    n.includes("/拆文库/") ||
    n.includes("拆文库/") ||
    /黄金三章|深度拆解|拆文报告|情节点/.test(n)
  );
}

function walkMd(dir: string, acc: string[], cap: number): void {
  if (acc.length >= cap) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (acc.length >= cap) return;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(full, acc, cap);
    else if (e.isFile() && e.name.endsWith(".md")) acc.push(full);
  }
}

function chunkText(text: string, size = 900, overlap = 80): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= size) return [clean];
  const out: string[] = [];
  let i = 0;
  while (i < clean.length) {
    out.push(clean.slice(i, i + size));
    i += size - overlap;
  }
  return out.slice(0, 24);
}

function hashChunk(model: string, snippet: string): string {
  return createHash("sha256")
    .update(model)
    .update("\0")
    .update(snippet)
    .digest("hex");
}

type VectorRow = {
  path: string;
  book: string;
  kind: string;
  snippet: string;
  vec: Float32Array;
};

let vectorCache: VectorRow[] | null = null;

export function invalidateVectorCache(): void {
  vectorCache = null;
}

export function openRetrievalDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      chunk_i INTEGER NOT NULL,
      book TEXT,
      kind TEXT,
      snippet TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding BLOB,
      UNIQUE(path, chunk_i)
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      path UNINDEXED,
      book UNINDEXED,
      kind UNINDEXED,
      snippet UNINDEXED,
      body
    );
  `);
  return db;
}

function rebuildFts(db: Database.Database): void {
  db.exec("DROP TABLE IF EXISTS chunks_fts");
  db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(
    path UNINDEXED,
    book UNINDEXED,
    kind UNINDEXED,
    snippet UNINDEXED,
    body
  )`);
  const insert = db.prepare(
    "INSERT INTO chunks_fts (path, book, kind, snippet, body) VALUES (?, ?, ?, ?, ?)"
  );
  const rows = db
    .prepare("SELECT path, book, kind, snippet FROM chunks")
    .all() as {
    path: string;
    book: string;
    kind: string;
    snippet: string;
  }[];
  for (const r of rows) {
    insert.run(r.path, r.book, r.kind, r.snippet, toFtsBody(r.snippet));
  }
}

export async function indexCorpus(
  db: Database.Database,
  projectRoot: string,
  options?: { embed?: boolean }
): Promise<{
  files: number;
  chunks: number;
  embedded: number;
  reused: number;
  vectorSynced: number;
}> {
  if (!fs.existsSync(projectRoot)) {
    return { files: 0, chunks: 0, embedded: 0, reused: 0, vectorSynced: 0 };
  }

  const files: string[] = [];
  walkMd(projectRoot, files, 6000);
  const selected = files.filter((full) =>
    isCorpusFile(path.relative(projectRoot, full))
  );

  const model = embeddingModelName();
  const seen = new Set<string>();
  const upsert = db.prepare(`
    INSERT INTO chunks (path, chunk_i, book, kind, snippet, hash, embedding)
    VALUES (@path, @chunk_i, @book, @kind, @snippet, @hash, @embedding)
    ON CONFLICT(path, chunk_i) DO UPDATE SET
      book=excluded.book,
      kind=excluded.kind,
      snippet=excluded.snippet,
      hash=excluded.hash,
      embedding=CASE
        WHEN chunks.hash = excluded.hash THEN chunks.embedding
        ELSE NULL
      END
  `);
  const existing = db.prepare(
    "SELECT hash, embedding FROM chunks WHERE path = ? AND chunk_i = ?"
  );

  let chunks = 0;
  let reused = 0;
  const tx = db.transaction(() => {
    for (const full of selected) {
      const rel = path.relative(projectRoot, full).replace(/\\/g, "/");
      let raw = "";
      try {
        raw = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (raw.length > 400_000) raw = raw.slice(0, 400_000);
      const book = bookOf(rel);
      const kind = kindOf(rel);
      const parts = chunkText(raw);
      parts.forEach((snippet, chunk_i) => {
        const hash = hashChunk(model, snippet);
        const key = `${rel}::${chunk_i}`;
        seen.add(key);
        const prev = existing.get(rel, chunk_i) as
          | { hash: string; embedding: Buffer | null }
          | undefined;
        if (prev?.hash === hash && prev.embedding) reused += 1;
        upsert.run({
          path: rel,
          chunk_i,
          book,
          kind,
          snippet,
          hash,
          embedding: prev?.hash === hash ? prev.embedding : null,
        });
        chunks += 1;
      });
    }

    const all = db.prepare("SELECT id, path, chunk_i FROM chunks").all() as {
      id: number;
      path: string;
      chunk_i: number;
    }[];
    const del = db.prepare("DELETE FROM chunks WHERE id = ?");
    for (const row of all) {
      if (!seen.has(`${row.path}::${row.chunk_i}`)) del.run(row.id);
    }

    rebuildFts(db);
    db.prepare(
      "INSERT INTO meta(key, value) VALUES ('indexed_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(new Date().toISOString());
    db.prepare(
      "INSERT INTO meta(key, value) VALUES ('chunks', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(String(chunks));
    db.prepare(
      "INSERT INTO meta(key, value) VALUES ('embed_model', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(model);
  });
  tx();

  let embedded = 0;
  let vectorSynced = 0;
  if (options?.embed !== false) {
    embedded = await embedMissing(db);
  }
  vectorSynced = await pushSqliteVectors(db);

  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('vectors', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(
    String(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL"
          )
          .get() as { n: number }
      ).n
    )
  );

  invalidateVectorCache();
  return { files: selected.length, chunks, embedded, reused, vectorSynced };
}

async function embedMissing(db: Database.Database): Promise<number> {
  const pending = db
    .prepare(
      "SELECT id, path, chunk_i, book, kind, snippet FROM chunks WHERE embedding IS NULL ORDER BY id"
    )
    .all() as {
    id: number;
    path: string;
    chunk_i: number;
    book: string;
    kind: string;
    snippet: string;
  }[];
  if (!pending.length) return 0;

  const update = db.prepare("UPDATE chunks SET embedding = ? WHERE id = ?");
  let done = 0;
  const batchSize = 8;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vecs = await embedTexts(batch.map((b) => b.snippet), false);
    if (!vecs) {
      console.warn(
        `[retrieval] embeddings unavailable, left ${pending.length - done} chunks on FTS-only`
      );
      break;
    }
    const write = db.transaction(() => {
      batch.forEach((row, j) => {
        if (vecs[j]) update.run(vectorToBlob(vecs[j]), row.id);
      });
    });
    write();
    done += batch.length;
    if (done % 64 === 0 || done === pending.length) {
      console.log(`[retrieval] embedded ${done}/${pending.length}`);
    }
  }
  return done;
}

export async function pushSqliteVectors(db: Database.Database): Promise<number> {
  const store = await getVectorStore();
  if (!store) return 0;
  const rows = db
    .prepare(
      "SELECT path, chunk_i, book, kind, snippet, embedding FROM chunks WHERE embedding IS NOT NULL"
    )
    .all() as {
    path: string;
    chunk_i: number;
    book: string;
    kind: string;
    snippet: string;
    embedding: Buffer;
  }[];
  if (!rows.length) return 0;
  const records: VectorRecord[] = rows.map((r) => ({
    id: recordId(r.path, r.chunk_i),
    path: r.path,
    book: r.book || "",
    kind: r.kind,
    snippet: r.snippet,
    embedding: Array.from(blobToVector(Buffer.from(r.embedding))),
  }));
  await store.upsert(records);
  return records.length;
}

export function searchCorpus(
  db: Database.Database,
  query: string,
  limit = 8
): RetrievalHit[] {
  const match = toFtsQuery(query);
  if (!match || match === '""') return [];
  const rows = db
    .prepare(
      `SELECT path, book, kind, snippet, rank AS score
       FROM chunks_fts
       WHERE chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(match, limit) as {
    path: string;
    book: string;
    kind: string;
    score: number;
    snippet: string;
  }[];
  return rows.map((r) => ({
    path: r.path,
    book: r.book || "",
    kind: r.kind,
    score: Number(r.score),
    snippet: r.snippet.slice(0, 500),
    source: "fts" as const,
  }));
}

function loadVectors(db: Database.Database): VectorRow[] {
  if (vectorCache) return vectorCache;
  const rows = db
    .prepare(
      "SELECT path, book, kind, snippet, embedding FROM chunks WHERE embedding IS NOT NULL"
    )
    .all() as {
    path: string;
    book: string;
    kind: string;
    snippet: string;
    embedding: Buffer;
  }[];
  vectorCache = rows.map((r) => ({
    path: r.path,
    book: r.book || "",
    kind: r.kind,
    snippet: r.snippet,
    vec: blobToVector(Buffer.from(r.embedding)),
  }));
  return vectorCache;
}

export function searchVectors(
  db: Database.Database,
  queryVec: Float32Array,
  limit = 20
): RetrievalHit[] {
  const rows = loadVectors(db);
  if (!rows.length) return [];
  return rows
    .map((r) => ({
      path: r.path,
      book: r.book,
      kind: r.kind,
      snippet: r.snippet.slice(0, 500),
      score: cosine(queryVec, r.vec),
      source: "vector" as const,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function searchHybrid(
  db: Database.Database,
  query: string,
  queryVec: Float32Array | null,
  limit = 8
): Promise<RetrievalHit[]> {
  const fts = searchCorpus(db, query, Math.max(limit * 3, 16));
  if (!queryVec) return fts.slice(0, limit);
  const store = await getVectorStore();
  const vectors = store
    ? await store.search(Array.from(queryVec), Math.max(limit * 3, 16))
    : searchVectors(db, queryVec, Math.max(limit * 3, 16));
  if (!vectors.length) return fts.slice(0, limit);
  return rrfMerge([fts, vectors], limit);
}

export function corpusStats(db: Database.Database): {
  chunks: number;
  vectors: number;
  indexedAt: string | null;
  embedModel: string | null;
} {
  const n = db
    .prepare("SELECT value FROM meta WHERE key='chunks'")
    .get() as { value: string } | undefined;
  const v = db
    .prepare("SELECT value FROM meta WHERE key='vectors'")
    .get() as { value: string } | undefined;
  const row = db
    .prepare("SELECT value FROM meta WHERE key='indexed_at'")
    .get() as { value: string } | undefined;
  const model = db
    .prepare("SELECT value FROM meta WHERE key='embed_model'")
    .get() as { value: string } | undefined;
  return {
    chunks: n ? Number(n.value) : 0,
    vectors: v ? Number(v.value) : 0,
    indexedAt: row?.value || null,
    embedModel: model?.value || null,
  };
}
