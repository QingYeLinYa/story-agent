# Story Agent

对话型网文创作 Agent：Web 界面加载 [oh-story](https://github.com/worldwonderer/oh-story-claudecode) 的写作 Skill，经 DeepSeek 流式对话完成开书、拆文、去 AI 味、审查等流程。

## 结构

| 目录 | 说明 |
|------|------|
| `story-agent-web/` | 本仓库的 Web UI + API（Hono + React） |
| `oh-story/` | 网文 Skill 包（MIT，上游 oh-story-claudecode） |

## 启动

```bash
cd story-agent-web
cp .env.example .env
# 填写 DEEPSEEK_API_KEY
# OH_STORY_SKILLS_DIR 默认 ../oh-story/skills
npm install
npm run dev
```

- 前端：http://127.0.0.1:5173
- API：http://127.0.0.1:8787

不要把 `.env` 提交进仓库。
