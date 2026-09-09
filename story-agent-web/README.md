# Story Agent Web

对话型网文 Agent：加载本地 [oh-story](../oh-story) 的 Skill，经 **DeepSeek** 流式对话。

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

## 环境变量

| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | 必填 |
| `DEEPSEEK_BASE_URL` | 默认 `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 默认 `deepseek-chat` |
| `OH_STORY_SKILLS_DIR` | 默认 `../oh-story/skills` |
| `PORT` | API 端口，默认 `8787` |

## 能力边界（MVP）

支持：写作 / 拆文 / 去 AI 味 / 审查等对话流程，按命令与关键词路由 skill。  
不支持：本地脚本、CDP 扫榜、封面出图、项目文件读写、子 Agent spawn。
