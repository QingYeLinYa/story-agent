import { useCallback, useEffect, useRef, useState } from "react";

type SkillSummary = { name: string; description: string };
type Role = "user" | "assistant";
type Msg = { id: string; role: Role; content: string };

const QUICK = [
  { label: "写长篇", text: "/写长篇 我想开一本长篇，先帮我确认题材和卖点。" },
  { label: "写短篇", text: "/写短篇 我想写一篇盐选风短篇，先帮我定故事核。" },
  { label: "去AI味", text: "/去AI味\n\n（在下方粘贴需要润色的正文）" },
  { label: "拆文", text: "/story-long-analyze 我想拆解一本对标书的黄金三章与爽点节奏。" },
];

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function parseSSE(
  res: Response,
  handlers: {
    onSkill?: (data: {
      skill: string;
      degraded: string | null;
      references: string[];
    }) => void;
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
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

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
        if ((sJson.skills || []).some((x: SkillSummary) => x.name === "story")) {
          setActiveSkill("story");
        }
      } catch (e) {
        setBootError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || busy) return;

      const userMsg: Msg = { id: uid(), role: "user", content };
      const assistantId = uid();
      setMessages((prev) => [
        ...prev,
        userMsg,
        { id: assistantId, role: "assistant", content: "" },
      ]);
      setInput("");
      setBusy(true);
      setDegraded(null);

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
          }),
        });

        if (!res.ok && res.headers.get("content-type")?.includes("application/json")) {
          const err = await res.json();
          throw new Error(err.error || `HTTP ${res.status}`);
        }

        await parseSSE(res, {
          onSkill: (data) => {
            setActiveSkill(data.skill);
            setDegraded(data.degraded);
          },
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
    [busy, lockedSkill, messages]
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <p className="brand-mark">Story Agent</p>
          <p className="brand-sub">oh-story · 对话版</p>
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

        <p className="hint">
          点击 skill 可锁定；再点取消。未锁定时按命令/关键词自动路由。
        </p>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1 className="title">网文工作台</h1>
            <p className="status">
              当前 skill：<strong>{activeSkill}</strong>
              {lockedSkill ? "（已锁定）" : ""}
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

        <section className="transcript" aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty">
              <p className="empty-brand">Story Agent</p>
              <p>
                用自然语言写作，或输入 <code>/写长篇</code>、<code>/去AI味</code>。
                Skills 来自本地 oh-story，模型走 DeepSeek。
              </p>
            </div>
          ) : (
            messages.map((m) => (
              <article
                key={m.id}
                className={`bubble ${m.role}`}
              >
                <p className="bubble-role">
                  {m.role === "user" ? "你" : "Agent"}
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
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          <button type="submit" className="send" disabled={busy || !input.trim()}>
            {busy ? "生成中…" : "发送"}
          </button>
        </form>
      </main>
    </div>
  );
}
