import fs from "node:fs";
import path from "node:path";

export type SandboxRoots = {
  projectRoot: string;
  skillsDir: string;
};

export function resolveProjectRoot(configured?: string): string {
  const fromEnv = configured || process.env.STORY_PROJECT_ROOT;
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? path.resolve(fromEnv)
      : path.resolve(process.cwd(), fromEnv);
  }
  return path.resolve(process.cwd(), "../novels");
}

export function isInsideRoot(root: string, candidate: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  return c === r || c.startsWith(r + path.sep);
}

function looksUnsafe(userPath: string): boolean {
  const n = userPath.replace(/\\/g, "/");
  if (!n || n.includes("\0")) return true;
  if (path.isAbsolute(userPath)) return true;
  if (n.startsWith("/") || /^[a-zA-Z]:/.test(n)) return true;
  const parts = n.split("/").filter(Boolean);
  return parts.includes("..");
}

export type ResolvedPath =
  | { ok: true; full: string; root: "project" | "skills"; relative: string }
  | { ok: false; error: string };

/** Resolve a user-supplied relative path into the project or skills sandbox. */
export function resolveSandboxPath(
  roots: SandboxRoots,
  userPath: string,
  mode: "read" | "write"
): ResolvedPath {
  const cleaned = (userPath || ".").trim() || ".";
  if (looksUnsafe(cleaned)) {
    return { ok: false, error: "路径不合法：只允许沙箱内相对路径" };
  }

  const rel = cleaned.replace(/\\/g, "/");
  const projectFull = path.resolve(roots.projectRoot, rel);

  if (isInsideRoot(roots.projectRoot, projectFull)) {
    return { ok: true, full: projectFull, root: "project", relative: rel };
  }

  if (mode === "write") {
    return { ok: false, error: "写入只允许 novels 项目沙箱" };
  }

  const skillsFull = path.resolve(roots.skillsDir, rel);
  if (isInsideRoot(roots.skillsDir, skillsFull)) {
    return { ok: true, full: skillsFull, root: "skills", relative: rel };
  }

  return { ok: false, error: "路径超出可读沙箱（novels 与 skills）" };
}

export function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
