import { useCallback, useEffect, useRef, useState } from "react";

type SkillSummary = { name: string; description: string };
type Role = "user" | "assistant";
type ToolLine = { name: string; ok: boolean; preview: string };
type PipeAgent = {
  id: string;
  name: string;
  status: "pending" | "running" | "done";
  summary?: string;
  tools: ToolLine[];
};
type Msg = { id: string; role: Role; content: string };
type RetrievalHit = {
  path: string;
  book: string;
  kind: string;
  snippet: string;
  source?: string;
};
type InterruptPayload = {
  type: "approve_writes";
  writes: { agent: string; path: string; bytes: number; preview: string }[];
};

const THREAD_KEY = "story-agent-thread";
const QUICK = [
  { label: "写长篇", text: "/写长篇 我想开一本长篇，先帮我确认题材和卖点。" },
  { label: "写短篇", text: "/写短篇 我想写一篇盐选风短篇，先帮我定故事核。" },
  { label: "去AI味", text: "/去AI味\n\n（在下方粘贴需要润色的正文）" },
  { label: "拆文", text: "/story-long-analyze 对照拆文库，帮我看黄金三章与爽点节奏。" },
];

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadThreadId() {
  const existing = localStorage.getItem(THREAD_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(THREAD_KEY, id);
  return id;
}

async function parseSSE(
  res: Response,
  handlers: {
    onSkill?: (data: {
      skill: string;
      degraded: string | null;
      references: string[];
      threadId?: string;
    }) => void;
    onPlan?: (data: {
      intent: string;
      agents: { id: string; name: string }[];
      source?: string;
    }) => void;
    onRetrieval?: (data: { hits: RetrievalHit[] }) => void;
    onAgentStart?: (data: { id: string; name: string }) => void;
    onTool?: (data: {
      agent: string;
      name: string;
      ok: boolean;
      preview: string;
    }) => void;
    onAgentDone?: (data: {
      id: string;
      name: string;
      summary: string;
      tools: ToolLine[];
    }) => void;
    onInterrupt?: (data: { payload: InterruptPayload }) => void;
    onToken?: (token: string) => void;
    onError?: (message: string) => void;
    onDone?: () => void;
  }
) {
  if (!res.body) throw new Error("无响应流");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      let event = "message";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        const json = JSON.parse(data);
        if (event === "skill") handlers.onSkill?.(json);
        else if (event === "plan") handlers.onPlan?.(json);
        else if (event === "retrieval") handlers.onRetrieval?.(json);
        else if (event === "agent_start") handlers.onAgentStart?.(json);
        else if (event === "tool") handlers.onTool?.(json);
        else if (event === "agent_done") handlers.onAgentDone?.(json);
        else if (event === "interrupt") handlers.onInterrupt?.(json);
        else if (event === "token") handlers.onToken?.(json.token || "");
        else if (event === "error") handlers.onError?.(json.message || "未知错误");
        else if (event === "done") handlers.onDone?.();
      } catch {
        // ignore
      }
    }
  }
}

export default function App() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [lockedSkill, setLockedSkill] = useState<string | null>(null);
  const [activeSkill, setActiveSkill] = useState<string>("story");
  const [degraded, setDegraded] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [pipeline, setPipeline] = useState<PipeAgent[]>([]);
  const [intent, setIntent] = useState<string | null>(null);
  const [planSource, setPlanSource] = useState<string | null>(null);
  const [hits, setHits] = useState<RetrievalHit[]>([]);
  const [interrupt, setInterrupt] = useState<InterruptPayload | null>(null);
  const [threadId, setThreadId] = useState<string>("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [hitl, setHitl] = useState(true);
  const assistantIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setThreadId(loadThreadId());
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy, pipeline, interrupt]);

  useEffect(() => {
    (async () => {
      try {
        const [sRes, hRes] = await Promise.all([
          fetch("/api/skills"),
          fetch("/api/health"),
        ]);
        const sJson = await sRes.json();
        const hJson = await hRes.json();
        if (!sRes.ok) throw new Error(sJson.error || "加载 skills 失败");
        setSkills(sJson.skills || []);
        setHasKey(Boolean(hJson.hasKey));
        setHitl(hJson.hitlWrites !== false);
        if ((sJson.skills || []).some((x: SkillSummary) => x.name === "story")) {
          setActiveSkill("story");
        }
      } catch (e) {
        setBootError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const attachSse = useCallback(
    async (res: Response, assistantId: string) => {
      await parseSSE(res, {
        onSkill: (data) => {
          setActiveSkill(data.skill);
          setDegraded(data.degraded);
          if (data.threadId) {
            setThreadId(data.threadId);
            localStorage.setItem(THREAD_KEY, data.threadId);
          }
        },
        onPlan: (data) => {
          setIntent(data.intent);
          setPlanSource(data.source || null);
          setPipeline(
            (data.agents || []).map((a) => ({
              id: a.id,
              name: a.name,
              status: "pending",
              tools: [],
            }))
          );
        },
        onRetrieval: (data) => setHits(data.hits || []),
        onAgentStart: (data) => {
          setPipeline((prev) =>
            prev.map((a) =>
              a.id === data.id ? { ...a, status: "running" } : a
            )
          );
        },
        onTool: (data) => {
          setPipeline((prev) =>
            prev.map((a) =>
              a.id === data.agent
                ? {
                    ...a,
                    tools: [
                      ...a.tools,
                      {
                        name: data.name,
                        ok: data.ok,
                        preview: data.preview,
                      },
                    ],
                  }
                : a
            )
          );
        },
        onAgentDone: (data) => {
          setPipeline((prev) =>
            prev.map((a) =>
              a.id === data.id
                ? {
                    ...a,
                    status: "done",
                    summary: data.summary,
                    tools: data.tools?.length ? data.tools : a.tools,
                  }
                : a
            )
          );
        },
        onInterrupt: (data) => setInterrupt(data.payload),
        onToken: (token) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content + token }
                : m
            )
          );
        },
        onError: (message) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: m.content
                      ? `${m.content}\n\n[错误] ${message}`
                      : `[错误] ${message}`,
                  }
                : m
            )
          );
        },
      });
    },
    []
  );

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || busy) return;

      const userMsg: Msg = { id: uid(), role: "user", content };
      const assistantId = uid();
      assistantIdRef.current = assistantId;
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantId, role: "assistant", content: "" },
      ]);
      setInput("");
      setBusy(true);
      setDegraded(null);
      setPipeline([]);
      setHits([]);
      setInterrupt(null);

      const history = [...messages, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: history,
            skill: lockedSkill,
            threadId,
          }),
        });

        if (!res.ok && res.headers.get("content-type")?.includes("application/json")) {
          const err = await res.json();
          throw new Error(err.error || `HTTP ${res.status}`);
        }

        await attachSse(res, assistantId);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: `[错误] ${message}` } : m
          )
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, lockedSkill, messages, threadId, attachSse]
  );

  const resume = useCallback(
    async (action: "approve" | "reject") => {
      if (!threadId || busy) return;
      setBusy(true);
      const assistantId = assistantIdRef.current || uid();
      if (!assistantIdRef.current) {
        assistantIdRef.current = assistantId;
        setMessages((prev) => [
          ...prev,
          { id: assistantId, role: "assistant", content: "" },
        ]);
      }
      try {
        const res = await fetch("/api/chat/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId, action }),
        });
        if (!res.ok && res.headers.get("content-type")?.includes("application/json")) {
          const err = await res.json();
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        setInterrupt(null);
        await attachSse(res, assistantId);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setMessages((prev) => [
          ...prev,
          { id: uid(), role: "assistant", content: `[错误] ${message}` },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [threadId, busy, attachSse]
  );

  const newThread = () => {
    const id = crypto.randomUUID();
    localStorage.setItem(THREAD_KEY, id);
    setThreadId(id);
    setMessages([]);
    setPipeline([]);
    setHits([]);
    setInterrupt(null);
    setIntent(null);
    setPlanSource(null);
  };

  const activePipe = pipeline.filter((a) => a.status === "running")[0];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <p className="brand-mark">Story Agent</p>
          <p className="brand-sub">LangGraph · LLM 规划 · 人审 / 拆文混合检索</p>
        </div>

        <div className="sidebar-section">
          <p className="section-label">Skills</p>
          <ul className="skill-list">
            {skills.map((s) => {
              const active = (lockedSkill || activeSkill) === s.name;
              const locked = lockedSkill === s.name;
              return (
                <li key={s.name}>
                  <button
                    type="button"
                    className={`skill-item${active ? " active" : ""}`}
                    title={s.description}
                    onClick={() =>
                      setLockedSkill((prev) =>
                        prev === s.name ? null : s.name
                      )
                    }
                  >
                    <span className="skill-name">{s.name}</span>
                    {locked ? <span className="lock">锁定</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <button type="button" className="chip sidebar-new" onClick={newThread}>
          新会话
        </button>
        <p className="hint">
          会话绑定 thread_id，写入默认要人审。拆文走 FTS 检索。
        </p>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1 className="title">网文工作台</h1>
            <p className="status">
              当前 skill：<strong>{activeSkill}</strong>
              {lockedSkill ? "（已锁定）" : ""}
              {intent
                ? ` · 编排：${intent}${planSource === "llm" ? "（LLM）" : planSource === "rules" ? "（规则）" : ""}`
                : ""}
              {hitl ? " · 写入审批开" : ""}
              {hasKey === false ? (
                <span className="warn"> · 未配置 DEEPSEEK_API_KEY</span>
              ) : null}
            </p>
          </div>
          <div className="chips">
            {QUICK.map((q) => (
              <button
                key={q.label}
                type="button"
                className="chip"
                disabled={busy}
                onClick={() => send(q.text)}
              >
                {q.label}
              </button>
            ))}
          </div>
        </header>

        {degraded ? <div className="banner">{degraded}</div> : null}
        {bootError ? <div className="banner error">{bootError}</div> : null}

        {interrupt ? (
          <div className="banner hitl">
            <p>
              人机打断：{interrupt.writes.length} 个文件待写入，批准后才会落盘。
            </p>
            <ul className="write-list">
              {interrupt.writes.map((w) => (
                <li key={w.path}>
                  <strong>{w.path}</strong>（{w.bytes} 字，{w.agent}）
                  <div className="write-preview">{w.preview}</div>
                </li>
              ))}
            </ul>
            <div className="chips">
              <button
                type="button"
                className="chip"
                disabled={busy}
                onClick={() => resume("approve")}
              >
                批准写入
              </button>
              <button
                type="button"
                className="chip"
                disabled={busy}
                onClick={() => resume("reject")}
              >
                拒绝
              </button>
            </div>
          </div>
        ) : null}

        {pipeline.length > 0 ? (
          <div className="pipeline" aria-live="polite">
            {pipeline.map((a) => (
              <span key={a.id} className={`pipe-chip ${a.status}`}>
                {a.name}
              </span>
            ))}
          </div>
        ) : null}

        {hits.length > 0 ? (
          <p className="tool-live">
            拆文检索 {hits.length} 条
            {hits[0]?.source ? ` · ${hits[0].source}` : ""}
            {hits[0]?.book ? ` · ${hits[0].book}` : ""} · {hits[0]?.path}
          </p>
        ) : null}

        {activePipe?.tools.length ? (
          <p className="tool-live">
            {activePipe.name} · {activePipe.tools[activePipe.tools.length - 1].preview}
          </p>
        ) : null}

        <section className="transcript" aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty">
              <p className="empty-brand">Story Agent</p>
              <p>
                LangGraph 图：规划 → 拆文混合检索（FTS + 向量）→ 专科 Agent → 写入审批 → 综合写手。
                检查点在本地 SQLite，刷新后同一会话可恢复中断。
              </p>
            </div>
          ) : (
            messages.map((m) => (
              <article
                key={m.id}
                className={`bubble ${m.role}`}
              >
                <p className="bubble-role">
                  {m.role === "user" ? "你" : "综合写手"}
                </p>
                <pre className="bubble-body">{m.content || (busy ? "…" : "")}</pre>
              </article>
            ))
          )}
          <div ref={bottomRef} />
        </section>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="写下你的需求，或粘贴正文… Enter 发送，Shift+Enter 换行"
            rows={3}
            disabled={busy || Boolean(interrupt)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          <button type="submit" className="send" disabled={busy || !input.trim() || Boolean(interrupt)}>
            {busy ? "编排中…" : interrupt ? "待审批" : "发送"}
          </button>
        </form>
      </main>
    </div>
  );
}
