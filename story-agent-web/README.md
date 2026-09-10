# Story Agent Web

对话型网文 **多 Agent** 系统，落地形态对标企业常见三件套：

1. **持久化图状态** — LangGraph + SQLite checkpointer（`data/checkpoints.sqlite`），按 `thread_id` 恢复。
2. **人机打断** — 写入 `novels/` 前 `interrupt()`，前端批准 / 拒绝后 `Command.resume` 续跑。
3. **拆文检索** — FTS5 关键词 + BGE 向量，RRF 混合召回。向量库默认 **Chroma**（`npm run vector:up`），可切 **Milvus**（`npm run vector:up:milvus`）。服务不可用时回退 SQLite BLOB。DeepSeek 没有 embedding 接口，向量由本机 `Xenova/bge-small-zh-v1.5` 生成。

专科 Agent 仍走 DeepSeek function calling。检查点走 LangGraph。规划器默认也走 DeepSeek（结构化 JSON）；解析失败或关掉 `STORY_LLM_PLANNER` 时回退正则规划。

## 启动

```bash
cd story-agent-web
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY
npm install
npm run dev
```

- 前端：http://127.0.0.1:5173
- API：http://127.0.0.1:8787

```bash
npm run smoke
npm run vector:up   # 启动 Chroma（默认向量库，端口 8000）
npm run index        # 重建拆文 FTS + 写入向量库
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | 必填 |
| `DEEPSEEK_BASE_URL` | 默认 `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 默认 `deepseek-chat` |
| `OH_STORY_SKILLS_DIR` | 默认 `../oh-story/skills` |
| `STORY_PROJECT_ROOT` | 项目沙箱，默认 `../novels` |
| `STORY_DATA_DIR` | 检查点与检索库目录，默认 `./data` |
| `STORY_HITL_WRITES` | 默认 `true`；`false` 则写入不打断 |
| `STORY_LLM_PLANNER` | 默认 `true`；`false` 则只用正则规划器 |
| `STORY_EMBEDDING` | 默认 `local`（BGE）；`off` 则只用 FTS |
| `STORY_EMBEDDING_MODEL` | 默认 `Xenova/bge-small-zh-v1.5` |
| `STORY_EMBEDDING_BASE_URL` | 可选，OpenAI 兼容 `/embeddings`（如 Ollama） |
| `STORY_VECTOR_BACKEND` | 默认 `chroma`；`milvus` 或 `sqlite` |
| `CHROMA_URL` | 默认 `http://127.0.0.1:8000` |
| `MILVUS_ADDRESS` | 默认 `127.0.0.1:19530` |
| `STORY_VECTOR_COLLECTION` | 默认 `story_corpus` |
| `PORT` | API 端口，默认 `8787` |

## 图怎么跑

`plan`（LLM JSON，失败回退正则）→ `retrieve`（仅当计划 `retrieve=true`）→ `workers` → `hitl` → `apply` → `synthesize`

| 意图 | 子 Agent |
|------|---------|
| 开书 / 大纲 | 架构师 ∥ 角色设计师 → 写入审批 → 综合写手 |
| 写第 N 章 / 日更 | 资料查询 → 叙事写手 → 写入审批 → 综合写手 |
| 审查 | 资料查询 → 一致性检查 → 综合写手 |
| 拆文 / 对标 | FTS + 向量混合检索拆文库 → 章节提取 → 综合写手 |

SSE：`skill` → `thread` → `plan` → `retrieval` → `agent_*` / `tool` → `interrupt` 或 `token` → `done`。

续跑：`POST /api/chat/resume` `{ threadId, action: "approve" | "reject" }`。

## 仍不支持

真实扫榜爬虫、封面出图、Bash、浏览器 CDP、LangSmith 云追踪。本机未装 Docker 时 Chroma/Milvus 起不来，检索自动回退 SQLite。
