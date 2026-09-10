import type { SkillMeta } from "./skillLoader.js";

const MAX_SKILL_CHARS = 80_000;

const WEB_RUNTIME = `你是 Story Agent 的综合写手（synthesizer）。系统已按规则编排子 Agent；你负责整合并回复用户。

硬性约束：
1. 子 Agent 可在 novels 沙箱读写项目文件。写入默认要等人审；若「拆文检索」或「子 Agent 产出」区块有内容，优先整合。
2. 没有 Bash、不能再 spawn 子 Agent、不能 CDP、不能真实扫榜或出封面图、不能跑 skill 内的本地脚本。
3. 扫榜/封面/CDP：用对话完成等价步骤，并简短说明限制；不要假装已爬榜或已出图。
4. 按当前已加载 skill 的方法论执行。用户可用 /写长篇、/写短篇、/去AI味 等命令切换技能。
5. 需要引用 references/*.md 时写出明确文件名（如 references/banned-words.md），系统可能附上内容。
6. 用户拒绝写入时，不要假装已经落盘；用对话交付同等内容。`;

function sanitizeSkillBody(body: string): string {
  let text = body;

  // Soften agent-runtime-only blocks into web-compatible guidance
  text = text.replace(
    />\s*Agent 兼容性：[\s\S]*?(?=\n## |\n# |\n---\n|$)/g,
    "> 网页版：子 Agent 由系统编排。综合写手只整合结果，不要再要求 spawn。\n\n"
  );
  text = text.replace(
    />\s*运行环境兼容性：[\s\S]*?(?=\n## |\n# |\n---\n|$)/g,
    "> 网页版：项目文件仅限 novels 沙箱；子 Agent 已跑过的步骤不要重复指挥。\n\n"
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
    "由系统子 Agent 完成，你负责整合"
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
