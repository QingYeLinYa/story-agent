import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSkills,
  resolveSkillsDir,
  readReference,
  extractRequestedReferences,
} from "./skillLoader.js";
import { routeSkill } from "./skillRouter.js";
import {
  planPipeline,
  groupPlan,
  shouldRetrieve,
  extractJsonObject,
  sanitizePlannerOutput,
} from "./agents/planner.js";
import {
  indexCorpus,
  openRetrievalDb,
  searchCorpus,
  searchHybrid,
  toFtsQuery,
} from "./retrieval/store.js";
import { cosine, rrfMerge, vectorToBlob } from "./retrieval/hybrid.js";

process.env.STORY_VECTOR_BACKEND = "sqlite";
import {
  isInsideRoot,
  resolveProjectRoot,
  resolveSandboxPath,
} from "./agents/sandbox.js";
import { executeTool } from "./agents/tools.js";
import { listAgents } from "./agents/registry.js";

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

const openPlan = planPipeline("story-long-write", "/写长篇 我想开一本，先确认题材");
assert(openPlan.intent === "open_book", `open intent ${openPlan.intent}`);
assert(
  openPlan.steps.map((s) => s.id).join(",") ===
    "story-architect,character-designer",
  `open steps ${openPlan.steps.map((s) => s.id)}`
);
assert(groupPlan(openPlan).length === 1, "architect // designer should parallel");

const writePlan = planPipeline("story-long-write", "写第1章");
assert(writePlan.intent === "write_chapter", writePlan.intent);
assert(writePlan.steps[0].id === "story-explorer", "explorer first");
assert(writePlan.steps[1].id === "narrative-writer", "writer second");

const reviewPlan = planPipeline("story-review", "审查一下");
assert(reviewPlan.steps[1].id === "consistency-checker", "checker in review");

const scanPlan = planPipeline("story-long-scan", "扫榜");
assert(scanPlan.steps.length === 0, "scan has no workers");

const hiPlan = planPipeline("story", "你好");
assert(hiPlan.intent === "direct", "small talk is synthesizer-only");
assert(shouldRetrieve("story-long-analyze", "拆黄金三章"), "analyze retrieves");
assert(!shouldRetrieve("story", "你好"), "small talk skips retrieval");

const llmJson = extractJsonObject(
  '废话 {"intent":"write_chapter","retrieve":false,"steps":[{"id":"story-explorer","task":"读细纲","parallelGroup":0},{"id":"narrative-writer","task":"写第1章","parallelGroup":1},{"id":"synthesizer","task":"综合","parallelGroup":2},{"id":"ghost","task":"x","parallelGroup":0}]} 尾巴'
);
const llmPlan = sanitizePlannerOutput(
  llmJson,
  "story-long-write",
  "写第1章"
);
assert(llmPlan, "sanitize should accept JSON");
assert(llmPlan!.source === "llm", "sanitized plan is llm");
assert(
  llmPlan!.steps.map((s) => s.id).join(",") ===
    "story-explorer,narrative-writer",
  `dropped illegal agents, got ${llmPlan!.steps.map((s) => s.id)}`
);
const emptied = sanitizePlannerOutput(
  { intent: "degraded", retrieve: true, steps: [{ id: "narrative-writer" }] },
  "story-cover",
  "做个封面"
);
assert(emptied?.steps.length === 0, "cover skill cannot spawn writers");
assert(emptied?.retrieve === false, "cover skips retrieval");

assert(listAgents().length === 7, "seven specialist agents");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "story-agent-"));
const novels = path.join(tmp, "novels");
const skillsFake = path.join(tmp, "skills");
fs.mkdirSync(path.join(novels, "demo"), { recursive: true });
fs.writeFileSync(path.join(novels, "demo", "a.md"), "hello sand\n", "utf8");
fs.mkdirSync(path.join(skillsFake, "story-deslop", "references"), {
  recursive: true,
});
fs.writeFileSync(
  path.join(skillsFake, "story-deslop", "references", "banned-words.md"),
  "禁：微微一笑\n",
  "utf8"
);
const roots = { projectRoot: novels, skillsDir: skillsFake };

const listed = executeTool(roots, "list_dir", JSON.stringify({ path: "." }), false);
assert(listed.ok && listed.payload.includes("demo/"), listed.payload);

const readOk = executeTool(
  roots,
  "read_file",
  JSON.stringify({ path: "demo/a.md" }),
  false
);
assert(readOk.ok && readOk.payload.includes("hello"), readOk.payload);

const writeDenied = executeTool(
  roots,
  "write_file",
  JSON.stringify({ path: "demo/x.md", content: "nope" }),
  false
);
assert(!writeDenied.ok, "readonly agent cannot write");

const writeOk = executeTool(
  roots,
  "write_file",
  JSON.stringify({ path: "demo/x.md", content: "ok" }),
  true
);
assert(writeOk.ok, writeOk.payload);
assert(fs.readFileSync(path.join(novels, "demo", "x.md"), "utf8") === "ok", "write should persist");

const grep = executeTool(
  roots,
  "grep_files",
  JSON.stringify({ pattern: "hello", path: "demo" }),
  false
);
assert(grep.ok && grep.payload.includes("a.md"), grep.payload);

const queued: { agent: string; path: string; content: string }[] = [];
const deferred = executeTool(
  roots,
  "write_file",
  JSON.stringify({ path: "demo/queued.md", content: "wait" }),
  true,
  {
    deferWrites: true,
    pendingWrites: queued,
    agentId: "narrative-writer",
  }
);
assert(deferred.ok && queued.length === 1, "write should queue under HITL");
assert(
  !fs.existsSync(path.join(novels, "demo", "queued.md")),
  "deferred write must not hit disk"
);

const escape = resolveSandboxPath(roots, "../etc/passwd", "read");
assert(!escape.ok, "parent path blocked");
const abs = resolveSandboxPath(roots, "C:/Windows/win.ini", "read");
assert(!abs.ok, "absolute path blocked");
assert(!isInsideRoot(novels, path.join(tmp, "outside.md")), "outside not inside");

const project = resolveProjectRoot("../novels");
assert(path.isAbsolute(project), "project root is absolute");

fs.rmSync(tmp, { recursive: true, force: true });

const rtmp = fs.mkdtempSync(path.join(os.tmpdir(), "story-fts-"));
const chapterDir = path.join(rtmp, "命簿小吏", "拆文库", "大奉打更人", "章节");
fs.mkdirSync(chapterDir, { recursive: true });
fs.writeFileSync(
  path.join(chapterDir, "第1章_摘要.md"),
  "许七安在京兆府大牢醒来，确认穿越，要税银案卷宗。",
  "utf8"
);
const rdb = openRetrievalDb(path.join(rtmp, "retrieval.sqlite"));
const indexed = await indexCorpus(rdb, rtmp, { embed: false });
assert(indexed.chunks >= 1, `expected chunks, got ${indexed.chunks}`);
assert(toFtsQuery("许七安").includes("许七"), "fts query has bigrams");
const hits = searchCorpus(rdb, "许七安 监牢");
assert(hits.length >= 1, `expected retrieval hit, query=${toFtsQuery("许七安 监牢")}`);
assert(hits[0].path.includes("第1章"), hits[0].path);

const same = new Float32Array([0.6, 0.8]);
assert(Math.abs(cosine(same, same) - 1) < 1e-6, "cosine self=1");
const ftsOnly = [
  {
    path: "a.md",
    book: "x",
    kind: "chapter",
    score: 1,
    snippet: "牢狱穿越",
    source: "fts" as const,
  },
];
const vecOnly = [
  {
    path: "a.md",
    book: "x",
    kind: "chapter",
    score: 0.9,
    snippet: "牢狱穿越",
    source: "vector" as const,
  },
  {
    path: "b.md",
    book: "x",
    kind: "chapter",
    score: 0.2,
    snippet: "合同条款",
    source: "vector" as const,
  },
];
const merged = rrfMerge([ftsOnly, vecOnly], 2);
assert(merged[0].path === "a.md", "rrf prefers overlap");
assert(merged[0].source === "hybrid", merged[0].source || "missing source");

const queryVec = new Float32Array([1, 0]);
rdb.prepare("UPDATE chunks SET embedding = ? WHERE id = 1").run(
  vectorToBlob(queryVec)
);
const hybridHits = await searchHybrid(rdb, "许七安", queryVec, 4);
assert(hybridHits.length >= 1, "hybrid search returns rows");
rdb.close();
fs.rmSync(rtmp, { recursive: true, force: true });

const {
  Annotation,
  Command,
  END,
  INTERRUPT,
  MemorySaver,
  START,
  StateGraph,
  interrupt,
  isInterrupted,
} = await import("@langchain/langgraph");

const Gate = Annotation.Root({
  flag: Annotation<string>({
    reducer: (_l: string, r: string) => r,
    default: () => "",
  }),
});
const g = new StateGraph(Gate)
  .addNode("gate", () => {
    const decision = interrupt({ type: "approve_writes" }) as {
      action: string;
    };
    return { flag: decision.action };
  })
  .addEdge(START, "gate")
  .addEdge("gate", END)
  .compile({ checkpointer: new MemorySaver() });

const cfg = { configurable: { thread_id: "smoke-hitl" } };
const paused = await g.invoke({ flag: "" }, cfg);
assert(isInterrupted(paused), "graph should interrupt");
if (isInterrupted(paused)) {
  const value = paused[INTERRUPT][0].value as { type?: string };
  assert(value.type === "approve_writes", "interrupt payload");
}
const resumed = await g.invoke(
  new Command({ resume: { action: "approve" } }),
  cfg
);
assert(
  (resumed as { flag: string }).flag === "approve",
  `resume got ${(resumed as { flag: string }).flag}`
);

console.log("ok: router + planner + llm-plan-sanitize + sandbox + tools + fts + langgraph interrupt");
console.log("skills:", skills.size);
console.log("agents:", listAgents().map((a) => a.id).join(", "));
