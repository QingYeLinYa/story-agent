import "dotenv/config";
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
import { buildSystemPrompt } from "./prompt.js";
import { streamDeepseekChat, type ChatMessage } from "./deepseek.js";

const skillsDir = resolveSkillsDir();
let skills: Map<string, SkillMeta>;

try {
  skills = loadSkills(skillsDir);
  console.log(
    `[story-agent] loaded ${skills.size} skills from ${skillsDir}`
  );
} catch (e) {
  console.error(e);
  skills = new Map();
}

const app = new Hono();
app.use(
  "*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    skills: skills.size,
    skillsDir,
    hasKey: Boolean(process.env.DEEPSEEK_API_KEY),
  })
);

app.get("/api/skills", (c) => {
  if (skills.size === 0) {
    return c.json(
      { error: `未加载到 skills，请检查路径：${skillsDir}` },
      500
    );
  }
  return c.json({ skills: listSkillSummaries(skills) });
});

type IncomingMessage = { role: "user" | "assistant"; content: string };

app.post("/api/chat", async (c) => {
  let body: {
    messages?: IncomingMessage[];
    skill?: string | null;
    references?: string[];
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

  // Gather references: client-requested + auto-detected from recent turns
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

  const system = buildSystemPrompt(skill, {
    degraded: routed.degraded,
    referenceSnippets,
  });

  const apiMessages: ChatMessage[] = [
    { role: "system", content: system },
    ...messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  const config = {
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
      }),
    });

    try {
      for await (const token of streamDeepseekChat(config, apiMessages)) {
        await stream.writeSSE({
          event: "token",
          data: JSON.stringify({ token }),
        });
      }
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({ ok: true }),
      });
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
