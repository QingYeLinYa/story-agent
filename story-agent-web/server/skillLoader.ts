import fs from "node:fs";
import path from "node:path";

export type SkillMeta = {
  name: string;
  description: string;
  body: string;
  dir: string;
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

function parseFrontmatter(raw: string): {
  name?: string;
  description?: string;
  body: string;
} {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { body: raw.trim() };

  const yaml = m[1];
  const body = m[2].trim();
  let name: string | undefined;
  let description: string | undefined;

  for (const line of yaml.split(/\r?\n/)) {
    const nm = line.match(/^name:\s*(.+)$/);
    if (nm) {
      name = nm[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }
    const dm = line.match(/^description:\s*(.+)$/);
    if (dm) {
      let v = dm[1].trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      description = v;
    }
  }

  return { name, description, body };
}

export function resolveSkillsDir(configured?: string): string {
  const fromEnv = configured || process.env.OH_STORY_SKILLS_DIR;
  if (fromEnv) {
    return path.isAbsolute(fromEnv)
      ? fromEnv
      : path.resolve(process.cwd(), fromEnv);
  }
  return path.resolve(process.cwd(), "../oh-story/skills");
}

export function loadSkills(skillsDir: string): Map<string, SkillMeta> {
  const map = new Map<string, SkillMeta>();
  if (!fs.existsSync(skillsDir)) {
    throw new Error(`Skills directory not found: ${skillsDir}`);
  }

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(skillsDir, entry.name);
    const skillPath = path.join(dir, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;

    const raw = fs.readFileSync(skillPath, "utf8");
    const parsed = parseFrontmatter(raw);
    const name = parsed.name || entry.name;
    map.set(name, {
      name,
      description: parsed.description || "",
      body: parsed.body,
      dir,
    });
  }

  return map;
}

export function listSkillSummaries(skills: Map<string, SkillMeta>) {
  return [...skills.values()]
    .map((s) => ({ name: s.name, description: s.description }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Only allow files under skills/<name>/references/ */
export function readReference(
  skill: SkillMeta,
  relativePath: string
): string | null {
  const cleaned = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleaned.includes("..") || path.isAbsolute(cleaned)) return null;

  const underRefs = cleaned.startsWith("references/")
    ? cleaned
    : `references/${cleaned}`;
  const full = path.resolve(skill.dir, underRefs);
  const refsRoot = path.resolve(skill.dir, "references");
  if (!full.startsWith(refsRoot + path.sep) && full !== refsRoot) return null;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return fs.readFileSync(full, "utf8");
}

export function extractRequestedReferences(
  text: string,
  skillName: string
): string[] {
  const found = new Set<string>();
  const patterns = [
    /references\/([\w./\-]+\.md)/gi,
    /按\s*[`"]?(references\/[\w./\-]+\.md)[`"]?/gi,
    new RegExp(
      `${skillName}/references/([\\w./\\-]+\\.md)`,
      "gi"
    ),
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const p = m[1].includes("references/")
        ? m[1]
        : `references/${m[1]}`;
      found.add(p.replace(/\\/g, "/"));
    }
  }
  return [...found].slice(0, 3);
}
