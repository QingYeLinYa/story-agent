# Story Agent

对话型网文创作 **多 Agent**：Web 加载 oh-story Skill，LangGraph 持久化会话与写入人审；拆文检索为 FTS + BGE，向量库默认 Chroma（可切 Milvus）。

## 结构

| 目录 | 说明 |
|------|------|
| `story-agent-web/` | Web UI + API（Hono + React + 多 Agent 编排） |
| `oh-story/` | 网文 Skill 包（MIT，上游 oh-story-claudecode） |

## 启动

```bash
cd story-agent-web
cp .env.example .env
# 填写 DEEPSEEK_API_KEY
# OH_STORY_SKILLS_DIR 默认 ../oh-story/skills
# STORY_PROJECT_ROOT 默认 ../novels
npm install
npm run dev
```

- 前端：http://127.0.0.1:5173
- API：http://127.0.0.1:8787

不要把 `.env` 提交进仓库。
