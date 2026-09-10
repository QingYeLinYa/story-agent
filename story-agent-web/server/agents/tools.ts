import fs from "node:fs";
import path from "node:path";
import type { OpenAITool } from "../deepseek.js";
import type { PendingWrite } from "./types.js";
import {
  ensureDir,
  resolveSandboxPath,
  type SandboxRoots,
} from "./sandbox.js";

export const TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "list_dir",
      description: "列出沙箱内某个目录（默认项目根）。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "相对路径，默认 .",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "读取沙箱内文本文件。可用 offset/limit 按行切片。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number", description: "起始行，从 1 起" },
          limit: { type: "number", description: "最多读取行数" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "写入 novels 项目沙箱中的文本文件（覆盖）。只读 Agent 不可用。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "grep_files",
      description: "在沙箱内用正则搜索文件内容。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript 正则" },
          path: { type: "string", description: "起始目录，默认 ." },
          glob: {
            type: "string",
            description: "文件名过滤，如 *.md",
          },
        },
        required: ["pattern"],
      },
    },
  },
];

const MAX_LIST = 80;
const MAX_READ_CHARS = 24_000;
const MAX_WRITE_CHARS = 80_000;
const MAX_GREP = 40;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-web"]);

export type ToolResult = { ok: boolean; preview: string; payload: string };

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function matchGlob(file: string, glob?: string): boolean {
  if (!glob) return true;
  const g = glob.trim();
  if (g === "*" || g === "*.*") return true;
  if (g.startsWith("*.") && !g.includes("/", 1)) {
    return file.toLowerCase().endsWith(g.slice(1).toLowerCase());
  }
  return path.basename(file) === g;
}

function walkFiles(dir: string, acc: string[], cap: number): void {
  if (acc.length >= cap) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (acc.length >= cap) return;
    if (e.name.startsWith(".") && e.name !== ".cursor") continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, acc, cap);
    else if (e.isFile()) acc.push(full);
  }
}

export type ToolExecOptions = {
  deferWrites?: boolean;
  pendingWrites?: PendingWrite[];
  agentId?: string;
};

export function executeTool(
  roots: SandboxRoots,
  name: string,
  rawArgs: string,
  canWrite: boolean,
  opts?: ToolExecOptions
): ToolResult {
  const args = parseArgs(rawArgs);

  try {
    if (name === "list_dir") {
      const userPath = String(args.path || ".");
      const resolved = resolveSandboxPath(roots, userPath, "read");
      if (!resolved.ok) return fail(resolved.error);
      if (!fs.existsSync(resolved.full)) {
        return fail(`目录不存在：${resolved.relative}`);
      }
      const stat = fs.statSync(resolved.full);
      if (!stat.isDirectory()) return fail("不是目录");
      const names = fs
        .readdirSync(resolved.full, { withFileTypes: true })
        .slice(0, MAX_LIST)
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
      const text = names.join("\n") || "(空目录)";
      return ok(text, `列出 ${resolved.relative}（${names.length}）`);
    }

    if (name === "read_file") {
      const userPath = String(args.path || "");
      const resolved = resolveSandboxPath(roots, userPath, "read");
      if (!resolved.ok) return fail(resolved.error);
      if (!fs.existsSync(resolved.full) || !fs.statSync(resolved.full).isFile()) {
        return fail(`文件不存在：${resolved.relative}`);
      }
      let text = fs.readFileSync(resolved.full, "utf8");
      const offset = Number(args.offset || 1);
      const limit = Number(args.limit || 0);
      if (limit > 0 || offset > 1) {
        const lines = text.split(/\r?\n/);
        const start = Math.max(0, (offset || 1) - 1);
        const end = limit > 0 ? start + limit : lines.length;
        text = lines.slice(start, end).join("\n");
      }
      const clipped =
        text.length > MAX_READ_CHARS
          ? text.slice(0, MAX_READ_CHARS) + "\n…(截断)"
          : text;
      return ok(clipped, `读取 ${resolved.relative}（${clipped.length} 字）`);
    }

    if (name === "write_file") {
      if (!canWrite) return fail("当前 Agent 只读，不能写文件");
      const userPath = String(args.path || "");
      const content = String(args.content ?? "");
      if (content.length > MAX_WRITE_CHARS) {
        return fail(`内容过长（>${MAX_WRITE_CHARS}）`);
      }
      const resolved = resolveSandboxPath(roots, userPath, "write");
      if (!resolved.ok) return fail(resolved.error);
      if (opts?.deferWrites && opts.pendingWrites) {
        opts.pendingWrites.push({
          agent: opts.agentId || "unknown",
          path: resolved.relative,
          content,
        });
        return ok(
          `已排队等待人工批准：${resolved.relative}（${content.length} 字）`,
          `排队写入 ${resolved.relative}`
        );
      }
      ensureDir(resolved.full);
      fs.writeFileSync(resolved.full, content, "utf8");
      return ok(
        `已写入 ${resolved.relative}（${content.length} 字）`,
        `写入 ${resolved.relative}`
      );
    }

    if (name === "grep_files") {
      const pattern = String(args.pattern || "");
      if (!pattern) return fail("缺少 pattern");
      let re: RegExp;
      try {
        re = new RegExp(pattern, "i");
      } catch {
        return fail("非法正则");
      }
      const userPath = String(args.path || ".");
      const glob = args.glob ? String(args.glob) : undefined;
      const resolved = resolveSandboxPath(roots, userPath, "read");
      if (!resolved.ok) return fail(resolved.error);
      if (!fs.existsSync(resolved.full)) {
        return fail(`路径不存在：${resolved.relative}`);
      }

      const files: string[] = [];
      const startStat = fs.statSync(resolved.full);
      if (startStat.isFile()) files.push(resolved.full);
      else walkFiles(resolved.full, files, 200);

      const hits: string[] = [];
      for (const file of files) {
        if (!matchGlob(file, glob)) continue;
        let body: string;
        try {
          body = fs.readFileSync(file, "utf8");
        } catch {
          continue;
        }
        const lines = body.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          const rel = path.relative(
            resolved.root === "project" ? roots.projectRoot : roots.skillsDir,
            file
          );
          hits.push(`${rel}:${i + 1}:${lines[i].slice(0, 200)}`);
          if (hits.length >= MAX_GREP) break;
        }
        if (hits.length >= MAX_GREP) break;
      }
      const text = hits.join("\n") || "(无匹配)";
      return ok(text, `grep ${hits.length} 条`);
    }

    return fail(`未知工具：${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message);
  }
}

function ok(payload: string, preview: string): ToolResult {
  return { ok: true, payload, preview };
}

function fail(error: string): ToolResult {
  return { ok: false, payload: `错误：${error}`, preview: error };
}

export function toolSchemasFor(canWrite: boolean): OpenAITool[] {
  const list = canWrite
    ? TOOL_SCHEMAS
    : TOOL_SCHEMAS.filter((t) => t.function.name !== "write_file");
  return list as OpenAITool[];
}

export function applyPendingWrites(
  roots: SandboxRoots,
  writes: PendingWrite[]
): { path: string; ok: boolean; error?: string }[] {
  return writes.map((w) => {
    const resolved = resolveSandboxPath(roots, w.path, "write");
    if (!resolved.ok) return { path: w.path, ok: false, error: resolved.error };
    try {
      ensureDir(resolved.full);
      fs.writeFileSync(resolved.full, w.content, "utf8");
      return { path: resolved.relative, ok: true };
    } catch (err) {
      return {
        path: w.path,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
