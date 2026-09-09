import {
  loadSkills,
  resolveSkillsDir,
  readReference,
  extractRequestedReferences,
} from "./skillLoader.js";
import { routeSkill } from "./skillRouter.js";

const skills = loadSkills(resolveSkillsDir());
const available = new Set(skills.keys());

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const deslop = routeSkill("/去AI味 润色这段", available);
assert(deslop.skill === "story-deslop", `expected deslop got ${deslop.skill}`);

const longWrite = routeSkill("/写长篇 开书", available);
assert(
  longWrite.skill === "story-long-write",
  `expected long-write got ${longWrite.skill}`
);

const scan = routeSkill("帮我扫榜看看起点什么火", available);
assert(scan.skill === "story-long-scan", `expected long-scan got ${scan.skill}`);
assert(Boolean(scan.degraded), "scan should be degraded");

const cover = routeSkill("帮我做个封面", available);
assert(cover.skill === "story-cover", `expected cover got ${cover.skill}`);
assert(Boolean(cover.degraded), "cover should be degraded");

const locked = routeSkill("随便聊聊", available, "story-short-write");
assert(locked.skill === "story-short-write", "preferred skill lock failed");

const skill = skills.get("story-deslop")!;
const refs = extractRequestedReferences(
  "请按 references/banned-words.md 检查",
  "story-deslop"
);
assert(refs.length >= 1, "should extract reference path");
const content = readReference(skill, refs[0]);
assert(content && content.length > 10, "should read reference file");
assert(readReference(skill, "../SKILL.md") === null, "path traversal blocked");

console.log("ok: router + references checks passed");
console.log("skills:", skills.size);
