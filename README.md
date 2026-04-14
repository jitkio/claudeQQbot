# 🤖 ClaudeQQBot v0.2.0

基于自研 Agent Engine 的智能 QQ 机器人。支持多模型适配、异步任务队列、权限系统、自规划系统、子 Agent 派生。

## 架构概览

```
用户消息 → QQ WebSocket → 异步任务队列 → Agent Engine → 模型 API
                                              ↕
                                    工具编排器 (并发/串行)
                                              ↕
                              bash / web / file / planning / sub_agent
```

## v0.2.0 新特性

- **Agent Engine**: 自研对话循环引擎，替代 Claude Code CLI 直接调用
- **多模型适配**: OpenAI / Anthropic / DeepSeek / Claude Code CLI 四种 provider
- **权限系统**: 4 种模式 (default / plan / strict / auto)，命令级只读检测
- **自规划系统**: TodoStore + TodoReminder + VerifyTask，Agent 自主拆解和验证任务
- **子 Agent**: 主 Agent 可派生隔离子 Agent 执行子任务，递归深度限制
- **工具编排器**: 自动识别并发安全的工具调用，批量并行执行
- **记忆系统**: 用户画像 + 会话笔记 + 上下文压缩
- **安全加固**: safeSessionKey 路径防注入、FileMutex 写锁、TimedSet 防内存泄漏

## 快速开始

```bash
git clone https://github.com/jitkio/claudeQQbot.git
cd claudeQQbot
npm install

# 交互式配置
node setup.mjs

# 启动
npm run start:node
```

## 配置

在 `.env` 中配置：

```env
# QQ Bot
QQ_APPID=你的AppID
QQ_SECRET=你的Secret

# 模型 (选一种)
MODEL_PROVIDER=openai          # openai / anthropic / claude_code
OPENAI_API_KEY=你的Key
OPENAI_BASE_URL=https://api.deepseek.com   # DeepSeek 兼容
MODEL_NAME=deepseek-chat

# 或 Anthropic
# MODEL_PROVIDER=anthropic
# ANTHROPIC_API_KEY=你的Key
```

## 命令

| 命令 | 说明 |
|------|------|
| /help | 查看帮助 |
| /status | Bot 运行状态 |
| /tasks | 查看任务队列 |
| /cancel ID | 取消任务 |
| /new | 开始新对话 |
| /todos | 查看待办清单 |
| /mode | 查看权限模式 |
| /plan | 切换规划模式（只读） |
| /auto | 切换自动模式 |
| /strict | 切换严格模式 |
| /free | 切换默认模式 |
| /memory | 查看 AI 记忆 |
| /forget | 清除记忆 |
| /remind | 查看提醒列表 |
| /done 名称 | 打卡完成 |

## 项目结构

```
src/
├── index.ts                    # 入口 + 命令路由
├── config.ts                   # 配置（读 .env）
├── qq.ts                       # QQ Bot WebSocket
├── taskQueue.ts                # 异步任务队列 + Agent 调度
├── adapters/                   # 模型适配器
│   ├── base.ts                 # 适配器接口
│   ├── openai.ts               # OpenAI/DeepSeek 适配
│   ├── anthropic.ts            # Anthropic 适配
│   └── claudeCode.ts           # Claude Code CLI 适配
├── engine/
│   ├── agentEngine.ts          # Agent 对话循环引擎
│   ├── types.ts                # 核心类型定义
│   ├── toolRegistry.ts         # 工具注册表
│   ├── orchestrator/           # 工具编排器（并发/串行）
│   ├── memory/                 # 记忆系统（画像+笔记+压缩）
│   ├── permission/             # 权限系统（4模式+命令解析）
│   ├── planning/               # 自规划系统（Todo+Reminder+Verify）
│   └── utils/                  # 工具类（FileMutex, TimedSet, safeSessionKey）
├── tools/
│   ├── bash.ts                 # Shell 执行
│   ├── subAgent.ts             # 子 Agent 派生
│   ├── enterPlanMode.ts        # 进入规划模式
│   ├── exitPlanMode.ts         # 退出规划模式
│   ├── todoWrite.ts            # 待办清单操作
│   ├── verifyTask.ts           # 任务验证
│   ├── glob.ts / grep.ts       # 文件搜索
│   └── web/                    # Web 工具（搜索/抓取/提取）
├── tools/                      # Node.js 工具脚本
│   ├── web_search.cjs          # 网页搜索
│   ├── audio_transcribe.cjs    # 音频转写
│   └── reminder_manager.cjs    # 提醒管理
└── workspace/
    ├── prompts/                # 分模型 system prompt
    └── output/                 # 生成的文件
```

## 版本历史

| 版本 | 说明 |
|------|------|
| v0.2.0 | Agent Engine + 多模型 + 权限 + 自规划 + 子Agent + 集成加固 |
| v0.1.0 | 初版，基于 Claude Code CLI 直接调用 |

## License

MIT
