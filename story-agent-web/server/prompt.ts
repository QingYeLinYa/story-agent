import type { SkillMeta } from "./skillLoader.js";

const MAX_SKILL_CHARS = 80_000;

const WEB_RUNTIME = `你是 Story Agent（网页对话版网文助手），运行在浏览器聊天环境中。

硬性约束：
1. 没有 Bash、没有本地文件系统读写、不能 spawn 子 Agent、不能启动 dashboard-server、不能跑 skill 内的 Node/Python 脚本、不能 CDP 操控浏览器、不能真实爬榜或出封面图。
2. 遇到上述能力要求时：在对话里直接完成等价步骤（给大纲、正文、改写、拆解、检查清单），并简短说明网页版限制。
3. 不要假装已经爬取榜单或生成了图片文件；用文字交付结果。
4. 用户可用 /写长篇、/写短篇、/去AI味 等命令切换技能；按当前已加载 skill 的方法论执行。
5. 需要引用 references/*.md 时，用明确文件名写出（如 references/banned-words.md），系统可能在下一轮附上内容。`;

function sanitizeSkillBody(body: string): string {
  let text = body;

  // Soften agent-runtime-only blocks into web-compatible guidance
  text = text.replace(
    />\s*Agent 兼容性：[\s\S]*?(?=\n## |\n# |\n---\n|$)/g,
    "> 网页版：无自定义 agent / spawn。请在本对话中直接 solo 完成任务。\n\n"
  );
  text = text.replace(
    />\s*运行环境兼容性：[\s\S]*?(?=\n## |\n# |\n---\n|$)/g,
    "> 网页版：直接在对话中执行流程，不要依赖项目目录或子代理。\n\n"
  );
  text = text.replace(
    />\s*Spawn 版本提示[\s\S]*?(?=\n## |\n# |\n---\n|$)/g,
    ""
  );

  text = text.replace(
    /必须使用\s*Bash[^\n]*/gi,
    "（网页版无 Bash：请直接在回复中给出结果）"
  );
  text = text.replace(
    /spawn\s+[`']?[\w-]+[`']?\s*agent/gi,
    "在对话中直接完成（网页版无 spawn）"
  );
  text = text.replace(
    /dashboard-server\.mjs[^\n]*/gi,
    "（网页版无 Dashboard：用对话展示结构与进度）"
  );
  text = text.replace(
    /Skill\(["'][\w-]+["']\)/g,
    "（提示用户切换对应 skill 或继续在本对话完成）"
  );

  return text.trim();
}

export function buildSystemPrompt(
  skill: SkillMeta,
  options?: {
    degraded?: string;
    referenceSnippets?: { path: string; content: string }[];
  }
): string {
  let skillBody = sanitizeSkillBody(skill.body);
  let truncatedNote = "";
  if (skillBody.length > MAX_SKILL_CHARS) {
    skillBody = skillBody.slice(0, MAX_SKILL_CHARS);
    truncatedNote =
      "\n\n[系统] 该 skill 正文过长，已截断。优先执行已加载部分；完整规则见原 SKILL.md。";
  }

  const parts = [
    WEB_RUNTIME,
    "",
    `当前激活 skill：${skill.name}`,
    skill.description ? `简介：${skill.description}` : "",
    options?.degraded ? `\n[网页版降级提示]\n${options.degraded}` : "",
    "",
    "----- SKILL START -----",
    skillBody + truncatedNote,
    "----- SKILL END -----",
  ];

  if (options?.referenceSnippets?.length) {
    parts.push("", "----- REFERENCES -----");
    for (const ref of options.referenceSnippets) {
      const content =
        ref.content.length > 40_000
          ? ref.content.slice(0, 40_000) + "\n…(截断)"
          : ref.content;
      parts.push(`### ${ref.path}\n${content}`);
    }
    parts.push("----- END REFERENCES -----");
  }

  return parts.filter(Boolean).join("\n");
}
