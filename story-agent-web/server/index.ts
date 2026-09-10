import "dotenv/config";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  extractRequestedReferences,
  listSkillSummaries,
  loadSkills,
  readReference,
  resolveSkillsDir,
  type SkillMeta,
} from "./skillLoader.js";
import { routeSkill } from "./skillRouter.js";
import { listAgents } from "./agents/registry.js";
import { resolveProjectRoot } from "./agents/sandbox.js";
import type { WriteDecision } from "./agents/types.js";
import {
  getThreadSnapshot,
  initStoryGraph,
  resumeStoryTurn,
  runStoryTurn,
} from "./graph/run.js";
import { checkpointPath } from "./graph/checkpointer.js";
import { hitlWritesEnabled, llmPlannerEnabled } from "./runtimePaths.js";
import {
  reindexRetrieval,
  retrievalStats,
  retrieve,
} from "./retrieval/index.js";

const skillsDir = resolveSkillsDir();
const projectRoot = resolveProjectRoot();
let skills: Map<string, SkillMeta>;

try {
  skills = loadSkills(skillsDir);
  console.log(
    `[story-agent] loaded ${skills.size} skills from ${skillsDir}`
  );
  console.log(`[story-agent] project sandbox: ${projectRoot}`);
} catch (e) {
  console.error(e);
  skills = new Map();
}

initStoryGraph({
  skills,
  roots: { projectRoot, skillsDir },
  llm: {
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
  },
});

setTimeout(() => {
  void reindexRetrieval(projectRoot)
    .then((stats) => {
      console.log(
        `[story-agent] retrieval indexed ${stats.files} files / ${stats.chunks} chunks / ${stats.embedded} new vectors (reused ${stats.reused}, synced ${stats.vectorSynced})`
      );
    })
    .catch((err) => {
      console.error("[story-agent] retrieval index failed", err);
    });
}, 0);

const app = new Hono();
app.use(
  "*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

app.get("/api/health", async (c) => {
  const retrieval = await retrievalStats();
  return c.json({
    ok: true,
    skills: skills.size,
    skillsDir,
    projectRoot,
    agents: listAgents().length,
    hasKey: Boolean(process.env.DEEPSEEK_API_KEY),
    hitlWrites: hitlWritesEnabled(),
    checkpointDb: checkpointPath(),
    retrieval,
    graph: "langgraph",
    llmPlanner: llmPlannerEnabled(),
  });
});

app.get("/api/skills", (c) => {
  if (skills.size === 0) {
    return c.json(
      { error: `未加载到 skills，请检查路径：${skillsDir}` },
      500
    );
  }
  return c.json({ skills: listSkillSummaries(skills) });
});

app.get("/api/agents", (c) =>
  c.json({
    agents: listAgents(),
    projectRoot,
    skillsDir,
  })
);

app.get("/api/retrieval/search", async (c) => {
  const q = c.req.query("q") || "";
  if (!q.trim()) return c.json({ hits: [] });
  return c.json({ hits: await retrieve(q, Number(c.req.query("limit") || 8)) });
});

app.post("/api/retrieval/reindex", async (c) => {
  const stats = await reindexRetrieval(projectRoot);
  return c.json({ ok: true, ...stats });
});

app.get("/api/threads/:id", async (c) => {
  try {
    const snap = await getThreadSnapshot(c.req.param("id"));
    return c.json(snap);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 404);
  }
});

type IncomingMessage = { role: "user" | "assistant"; content: string };

async function writeEvents(
  stream: {
    writeSSE: (evt: { event: string; data: string }) => Promise<void>;
  },
  events: AsyncIterable<{ type: string }>
) {
  for await (const event of events) {
    await stream.writeSSE({
      event: event.type,
      data: JSON.stringify(event),
    });
  }
}

app.post("/api/chat", async (c) => {
  let body: {
    messages?: IncomingMessage[];
    skill?: string | null;
    references?: string[];
    threadId?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体必须是合法 JSON" }, 400);
  }

  const messages = body.messages || [];
  if (!messages.length) {
    return c.json({ error: "messages 不能为空" }, 400);
  }

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return c.json({ error: "需要至少一条 user 消息" }, 400);
  }

  if (skills.size === 0) {
    return c.json({ error: `未加载 skills：${skillsDir}` }, 500);
  }

  const available = new Set(skills.keys());
  const routed = routeSkill(
    lastUser.content,
    available,
    body.skill || null
  );

  const skill = skills.get(routed.skill);
  if (!skill) {
    return c.json({ error: `skill 不存在：${routed.skill}` }, 400);
  }

  const refPaths = new Set<string>();
  for (const r of body.references || []) refPaths.add(r);
  const recentText = messages
    .slice(-4)
    .map((m) => m.content)
    .join("\n");
  for (const r of extractRequestedReferences(recentText, skill.name)) {
    refPaths.add(r);
  }

  const referenceSnippets: { path: string; content: string }[] = [];
  for (const rp of [...refPaths].slice(0, 3)) {
    const content = readReference(skill, rp);
    if (content) {
      referenceSnippets.push({
        path: rp.startsWith("references/") ? rp : `references/${rp}`,
        content,
      });
    }
  }

  const threadId = body.threadId || randomUUID();
  const llm = {
    apiKey: process.env.DEEPSEEK_API_KEY || "",
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
  };

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "skill",
      data: JSON.stringify({
        skill: skill.name,
        degraded: routed.degraded || null,
        references: referenceSnippets.map((r) => r.path),
        threadId,
      }),
    });

    try {
      await writeEvents(
        stream,
        runStoryTurn({
          threadId,
          skill,
          degraded: routed.degraded,
          referenceSnippets,
          history: messages,
          lastUser: lastUser.content,
          config: llm,
          roots: { projectRoot, skillsDir },
        })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message }),
      });
    }
  });
});

app.post("/api/chat/resume", async (c) => {
  let body: { threadId?: string; action?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体必须是合法 JSON" }, 400);
  }
  if (!body.threadId) {
    return c.json({ error: "缺少 threadId" }, 400);
  }
  const action = body.action === "reject" ? "reject" : "approve";
  const decision: WriteDecision = { action };

  return streamSSE(c, async (stream) => {
    try {
      await writeEvents(
        stream,
        resumeStoryTurn({ threadId: body.threadId!, decision })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message }),
      });
    }
  });
});

const port = Number(process.env.PORT || 8787);
console.log(`[story-agent] listening on http://127.0.0.1:${port}`);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
