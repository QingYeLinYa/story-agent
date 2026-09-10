import { completeDeepseekChat, type DeepseekConfig } from "../deepseek.js";
import { llmPlannerEnabled } from "../runtimePaths.js";
import { AGENTS } from "./registry.js";
import type { ChatTurn, Plan, PlanStep } from "./types.js";

const WORKER_IDS = new Set<string>(Object.keys(AGENTS));

const DEGRADED_SKILLS = new Set([
  "story-long-scan",
  "story-short-scan",
  "story-cover",
  "browser-cdp",
]);

const MAX_STEPS = 4;

function step(
  id: PlanStep["id"],
  task: string,
  parallelGroup: number
): PlanStep {
  return { id, name: AGENTS[id].name, task, parallelGroup };
}

const WRITE_CHAPTER =
  /写第\s*\d+\s*章|日更|续写|继续写|回炉|重写第|修改第.+章/;
const OPEN_BOOK = /开书|写大纲|题材|人设|开一本|新书|黄金三章|卖点/;
const QUERY =
  /写到哪|查角色|伏笔|进度|设定|上下文|现在什么状态|出场/;
const RESEARCH = /查资料|调研|考证|核实/;
const DESLOP = /去\s*AI\s*味|去味|太\s*AI/i;
const REVIEW = /审查|审稿|一致性/;
const ANALYZE = /拆文|拆这|黄金三章|提取情节点|拆解/;
const RETRIEVE_HINT =
  /拆文|对标|黄金三章|拆文库|模块卡|爽点节奏|大奉/;

/** Rule planner. Used as fallback and for smoke tests. */
export function planPipeline(skill: string, userText: string): Plan {
  const t = userText;

  if (skill === "story-review" || REVIEW.test(t)) {
    return {
      intent: "review",
      retrieve: false,
      source: "rules",
      steps: [
        step("story-explorer", "加载项目设定、进度与相关正文位置", 0),
        step("consistency-checker", "核对事实、时间线与伏笔冲突", 1),
      ],
    };
  }

  if (skill === "story-deslop" || DESLOP.test(t)) {
    return {
      intent: "deslop",
      retrieve: false,
      source: "rules",
      steps: [
        step("narrative-writer", "按去 AI 味规则改写用户提供或项目中的正文", 0),
      ],
    };
  }

  if (
    skill === "story-long-analyze" ||
    skill === "story-short-analyze" ||
    ANALYZE.test(t)
  ) {
    return {
      intent: "analyze",
      retrieve: true,
      source: "rules",
      steps: [
        step(
          "chapter-extractor",
          "提取章节摘要、情节点与角色提及；有文件则先读正文/",
          0
        ),
      ],
    };
  }

  if (skill === "story-long-write" || skill === "story-short-write") {
    if (WRITE_CHAPTER.test(t)) {
      return {
        intent: "write_chapter",
        retrieve: false,
        source: "rules",
        steps: [
          step(
            "story-explorer",
            "加载细纲、上一章结尾、追踪上下文与出场角色",
            0
          ),
          step("narrative-writer", "按细纲写或改这一章正文，必要时写入 正文/", 1),
        ],
      };
    }
    if (OPEN_BOOK.test(t)) {
      return {
        intent: "open_book",
        retrieve: false,
        source: "rules",
        steps: [
          step(
            "story-architect",
            "确认题材卖点、世界观与大纲结构；可写入 设定/ 大纲/",
            0
          ),
          step("character-designer", "设计核心角色卡与关系；可写入 设定/角色/", 0),
        ],
      };
    }
    return {
      intent: "outline",
      retrieve: false,
      source: "rules",
      steps: [
        step("story-architect", "推进大纲/细纲，必要时先读已有项目文件", 0),
      ],
    };
  }

  if (skill === "story-import") {
    return {
      intent: "import",
      retrieve: true,
      source: "rules",
      steps: [
        step("chapter-extractor", "从用户文本或已有文件提取结构", 0),
        step("story-architect", "据此重建大纲与设定骨架", 1),
      ],
    };
  }

  if (RESEARCH.test(t) || skill === "browser-cdp") {
    return {
      intent: "research",
      retrieve: false,
      source: "rules",
      steps: [step("story-researcher", "提供可核对的资料要点并标明不确定处", 0)],
    };
  }

  if (QUERY.test(t) || skill === "story") {
    if (QUERY.test(t)) {
      return {
        intent: "query",
        retrieve: false,
        source: "rules",
        steps: [step("story-explorer", "检索项目进度、角色与设定", 0)],
      };
    }
  }

  if (DEGRADED_SKILLS.has(skill)) {
    return { intent: "degraded", retrieve: false, source: "rules", steps: [] };
  }

  return { intent: "direct", retrieve: false, source: "rules", steps: [] };
}

export function groupPlan(plan: Plan): PlanStep[][] {
  const groups = new Map<number, PlanStep[]>();
  const order: number[] = [];
  for (const s of plan.steps) {
    if (!groups.has(s.parallelGroup)) {
      groups.set(s.parallelGroup, []);
      order.push(s.parallelGroup);
    }
    groups.get(s.parallelGroup)!.push(s);
  }
  return order.map((g) => groups.get(g)!);
}

export function shouldRetrieve(skill: string, userText: string): boolean {
  if (
    skill === "story-long-analyze" ||
    skill === "story-short-analyze" ||
    skill === "story-import"
  ) {
    return true;
  }
  return RETRIEVE_HINT.test(userText);
}

export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asWorkerId(id: unknown): PlanStep["id"] | null {
  if (typeof id !== "string") return null;
  if (id === "synthesizer") return null;
  if (!WORKER_IDS.has(id)) return null;
  return id as PlanStep["id"];
}

export function sanitizePlannerOutput(
  raw: unknown,
  skill: string,
  userText: string
): Plan | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as {
    intent?: unknown;
    retrieve?: unknown;
    steps?: unknown;
  };

  if (DEGRADED_SKILLS.has(skill)) {
    return {
      intent: "degraded",
      retrieve: false,
      source: "llm",
      steps: [],
    };
  }

  const intent =
    typeof obj.intent === "string" && obj.intent.trim()
      ? obj.intent.trim().slice(0, 40)
      : "direct";

  const seen = new Set<string>();
  const steps: PlanStep[] = [];
  const list = Array.isArray(obj.steps) ? obj.steps : [];
  for (const item of list) {
    if (steps.length >= MAX_STEPS) break;
    if (!item || typeof item !== "object") continue;
    const row = item as {
      id?: unknown;
      task?: unknown;
      parallelGroup?: unknown;
    };
    const id = asWorkerId(row.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const groupRaw = Number(row.parallelGroup);
    const parallelGroup = Number.isFinite(groupRaw)
      ? Math.max(0, Math.min(2, Math.floor(groupRaw)))
      : steps.length;
    const task =
      typeof row.task === "string" && row.task.trim()
        ? row.task.trim().slice(0, 200)
        : AGENTS[id].role;
    steps.push(step(id, task, parallelGroup));
  }

  let retrieve =
    typeof obj.retrieve === "boolean"
      ? obj.retrieve
      : shouldRetrieve(skill, userText);
  if (intent === "direct" && steps.length === 0) retrieve = false;

  return { intent, steps, retrieve, source: "llm" };
}

const PLANNER_SYSTEM = `你是网文多 Agent 系统的规划器。只输出一个 JSON 对象，不要解释，不要 Markdown。

可用专科（禁止出现 synthesizer，综合写手固定最后执行）：
- story-architect：题材、世界观、大纲/细纲
- character-designer：角色卡与关系
- narrative-writer：正文、续写、去 AI 味
- consistency-checker：只读一致性检查
- story-explorer：只读项目检索（细纲、追踪、角色）
- chapter-extractor：拆章/情节点
- story-researcher：无浏览器的资料要点

JSON 字段：
{
  "intent": "open_book|write_chapter|outline|review|deslop|analyze|import|query|research|direct|degraded",
  "retrieve": false,
  "steps": [{ "id": "story-explorer", "task": "短任务说明", "parallelGroup": 0 }]
}

约束：
- steps 0～4 个，id 必须来自上面列表
- parallelGroup：同号并行，数字小的先跑（0 然后 1 然后 2）
- 写章：先 story-explorer，再 narrative-writer（后者 parallelGroup 更大）
- 开书：architect 与 character-designer 可同为 0 并行
- 审查：explorer 再 consistency-checker
- 去 AI 味：只需 narrative-writer
- 拆文/对标/黄金三章：chapter-extractor，retrieve=true
- 写本书、改人设、查伏笔：retrieve=false（人物卡走文件工具，不进拆文向量库）
- skill 为扫榜/封面/CDP，或 degraded 非空：steps=[]，intent=degraded，retrieve=false
- 闲聊、问好、谢谢：steps=[]，intent=direct，retrieve=false
- 「继续 / 按刚才的改 / 先别写」必须看对话历史，不要机械当成开书
- 不要发明 agent，不要把综合写手放进 steps`;

function formatHistory(history: ChatTurn[]): string {
  return history
    .slice(-6)
    .map((m) => {
      const role = m.role === "user" ? "用户" : "助手";
      return `${role}：${m.content.replace(/\s+/g, " ").slice(0, 400)}`;
    })
    .join("\n");
}

export async function planTurn(options: {
  llm: DeepseekConfig;
  skill: string;
  userText: string;
  history?: ChatTurn[];
  degraded?: string;
}): Promise<Plan> {
  const fallback = planPipeline(options.skill, options.userText);
  if (!llmPlannerEnabled() || !options.llm.apiKey) {
    return fallback;
  }

  try {
    const user = [
      `skill: ${options.skill}`,
      options.degraded ? `degraded: ${options.degraded}` : "",
      `本轮用户：${options.userText.slice(0, 2000)}`,
      options.history?.length
        ? `最近对话：\n${formatHistory(options.history)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    const result = await completeDeepseekChat(
      options.llm,
      [
        { role: "system", content: PLANNER_SYSTEM },
        { role: "user", content: user },
      ],
      {
        temperature: 0.1,
        timeoutMs: 20_000,
        json: true,
        maxTokens: 500,
      }
    );

    const parsed = sanitizePlannerOutput(
      extractJsonObject(result.content),
      options.skill,
      options.userText
    );
    if (!parsed) {
      console.warn("[planner] LLM JSON invalid, falling back to rules");
      return fallback;
    }

    if (
      parsed.steps.length === 0 &&
      fallback.steps.length > 0 &&
      fallback.intent !== "direct" &&
      fallback.intent !== "degraded"
    ) {
      console.warn(
        `[planner] LLM emptied a work request (${fallback.intent}), using rules`
      );
      return fallback;
    }

    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[planner] LLM failed (${message}); falling back to rules`);
    return fallback;
  }
}
