export type RouteResult = {
  skill: string;
  degraded?: string;
  lockedByCommand?: boolean;
};

const COMMAND_MAP: Record<string, string> = {
  "/story": "story",
  "/网文": "story",
  "/story-setup": "story-setup",
  "/准备写书": "story-setup",
  "/story-long-write": "story-long-write",
  "/写长篇": "story-long-write",
  "/story-short-write": "story-short-write",
  "/写短篇": "story-short-write",
  "/story-long-analyze": "story-long-analyze",
  "/story-short-analyze": "story-short-analyze",
  "/story-long-scan": "story-long-scan",
  "/story-short-scan": "story-short-scan",
  "/story-deslop": "story-deslop",
  "/去AI味": "story-deslop",
  "/去ai味": "story-deslop",
  "/story-review": "story-review",
  "/审查": "story-review",
  "/story-cover": "story-cover",
  "/封面": "story-cover",
  "/story-import": "story-import",
  "/导入小说": "story-import",
  "/browser-cdp": "browser-cdp",
};

const DEGRADED_SKILLS = new Set([
  "story-long-scan",
  "story-short-scan",
  "story-cover",
  "browser-cdp",
]);

const DEGRADE_MESSAGES: Record<string, string> = {
  "story-long-scan":
    "网页对话版暂不支持真实扫榜爬虫（起点/番茄/晋江）。可继续用对话做选题讨论与卖点推演；若要真实榜单请用 Claude Code + oh-story 原版。",
  "story-short-scan":
    "网页对话版暂不支持盐言/短篇真实扫榜。可继续用对话讨论题材风向；真实数据请用原版 skill + CDP。",
  "story-cover":
    "网页对话版暂不支持封面出图。可继续讨论封面文案、构图与书名；出图请用原版 /story-cover。",
  "browser-cdp":
    "网页对话版不支持浏览器 CDP 操控。请改用写作、拆文或去 AI 味等对话能力。",
};

type Rule = { skill: string; patterns: RegExp[] };

const KEYWORD_RULES: Rule[] = [
  {
    skill: "story-deslop",
    patterns: [/去\s*AI\s*味/i, /太\s*AI/i, /去味/, /AI\s*味/],
  },
  {
    skill: "story-cover",
    patterns: [/封面/, /封面图/],
  },
  {
    skill: "browser-cdp",
    patterns: [/浏览器操控/, /\bCDP\b/i, /扫码登录抓/],
  },
  {
    skill: "story-long-scan",
    patterns: [/长篇扫榜/, /起点排行/, /番茄排行/, /晋江排行/, /什么火/, /扫榜/],
  },
  {
    skill: "story-short-scan",
    patterns: [/短篇扫榜/, /盐言排行/, /知乎盐选排行/],
  },
  {
    skill: "story-long-analyze",
    patterns: [/长篇拆文/, /黄金三章/, /拆这本/, /分析这本书/],
  },
  {
    skill: "story-short-analyze",
    patterns: [/短篇拆文/, /拆短篇/, /分析这个故事/],
  },
  {
    skill: "story-import",
    patterns: [/导入小说/, /反向解析/, /把我的书导/],
  },
  {
    skill: "story-review",
    patterns: [/审稿/, /审查/, /一致性检查/],
  },
  {
    skill: "story-setup",
    patterns: [/准备写书/, /搭环境/, /初始化写作/],
  },
  {
    skill: "story-long-write",
    patterns: [
      /写长篇/,
      /开书/,
      /日更/,
      /续写/,
      /继续写/,
      /写大纲/,
      /回炉/,
      /重写第/,
      /修改第.+章/,
      /连载/,
    ],
  },
  {
    skill: "story-short-write",
    patterns: [/写短篇/, /盐言/, /盐选/, /一万字/, /短篇/],
  },
];

function matchCommand(text: string): string | null {
  const trimmed = text.trim();
  const first = trimmed.split(/\s+/)[0];
  if (COMMAND_MAP[first]) return COMMAND_MAP[first];

  for (const [cmd, skill] of Object.entries(COMMAND_MAP)) {
    if (trimmed.startsWith(cmd + " ") || trimmed === cmd) return skill;
  }
  return null;
}

export function routeSkill(
  userText: string,
  available: Set<string>,
  preferred?: string | null
): RouteResult {
  if (preferred && available.has(preferred)) {
    const degraded = DEGRADED_SKILLS.has(preferred)
      ? DEGRADE_MESSAGES[preferred]
      : undefined;
    return { skill: preferred, degraded, lockedByCommand: false };
  }

  const byCmd = matchCommand(userText);
  if (byCmd && available.has(byCmd)) {
    return {
      skill: byCmd,
      degraded: DEGRADED_SKILLS.has(byCmd)
        ? DEGRADE_MESSAGES[byCmd]
        : undefined,
      lockedByCommand: true,
    };
  }

  for (const rule of KEYWORD_RULES) {
    if (!available.has(rule.skill)) continue;
    if (rule.patterns.some((p) => p.test(userText))) {
      return {
        skill: rule.skill,
        degraded: DEGRADED_SKILLS.has(rule.skill)
          ? DEGRADE_MESSAGES[rule.skill]
          : undefined,
      };
    }
  }

  const fallback = available.has("story") ? "story" : [...available][0];
  return { skill: fallback || "story" };
}
