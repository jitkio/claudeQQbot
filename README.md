# 🤖 AI Agent Bot

基于 Claude Code 的智能 QQ 机器人，支持异步任务队列、工具调用、文件处理、定时提醒等。

## 快速开始

### Ubuntu / Debian

```bash
git clone https://github.com/你的用户名/claude-qq-bot.git
cd claude-qq-bot
bash install.sh
```

### 手动安装

```bash
# 1. 安装依赖
npm install

# 2. 交互式配置（会引导你输入 API Key、QQ Bot 信息）
node setup.mjs

# 3. 启动
npm run start:node
# 或者用 Bun
bun run start
```

## 你需要准备什么

| 项目 | 获取方式 |
|------|---------|
| Claude API Key | https://console.anthropic.com/settings/keys |
| QQ Bot AppID | https://q.qq.com → 创建机器人 → 开发设置 |
| QQ Bot ClientSecret | 同上 |
| Claude Code CLI | 安装脚本会自动安装 |

## 功能

- 💬 QQ 私聊 / 群聊消息处理
- 🔄 异步任务队列（多任务不阻塞）
- 🌐 网页搜索 / 截图 / 自动化
- 📎 图片、音频、视频、文件识别
- ⏰ 智能提醒（每日习惯 / 一次性 / 截止日期）
- 📊 文件生成（图表、文档等）
- 🧠 会话记忆（自动维护上下文）

## 命令

| 命令 | 说明 |
|------|------|
| /help | 查看帮助 |
| /status | Bot 运行状态 |
| /tasks | 查看任务队列 |
| /cancel ID | 取消任务 |
| /new | 开始新对话 |
| /remind | 查看提醒列表 |
| /done 名称 | 打卡完成 |

## 项目结构

```
├── setup.mjs          # 交互式配置向导
├── install.sh         # Ubuntu 一键安装
├── .env.example       # 配置模板
├── src/
│   ├── index.ts       # 入口 + 命令路由
│   ├── config.ts      # 配置（读 .env）
│   ├── qq.ts          # QQ Bot WebSocket
│   └── taskQueue.ts   # 异步任务队列
├── tools/             # 工具集
│   ├── shared_config.cjs   # 工具共享配置
│   ├── web_search.cjs      # 网页搜索
│   ├── audio_transcribe.cjs # 音频处理
│   └── ...
└── workspace/
    ├── CLAUDE.md      # AI 系统提示词
    ├── memory/        # 持久记忆
    └── output/        # 生成的文件
```

## 后续计划

- [ ] 多模型支持（OpenAI / DeepSeek / GLM / MiniMax...）
- [ ] 多平台支持（微信 / Telegram / Discord...）
- [ ] Windows 支持
- [ ] Web 管理面板

## License

MIT
