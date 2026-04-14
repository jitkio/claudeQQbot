import type { ToolDef, ToolContext } from '../engine/types.js'
import { ToolRegistry, createDefaultRegistry } from '../engine/toolRegistry.js'
import type { PermissionContext } from '../engine/permission/permissionTypes.js'

// 避免循环依赖：动态导入 runAgent
let _runAgent: any = null
async function getRunAgent() {
  if (!_runAgent) {
    const mod = await import('../engine/agentEngine.js')
    _runAgent = mod.runAgent
  }
  return _runAgent
}

// ============================================================
// 子 Agent 类型定义
// ============================================================

export type SubAgentKind = 'general' | 'plan' | 'verify' | 'explore'

interface SubAgentSpec {
  kind: SubAgentKind
  /** 子 Agent 的默认工具白名单（如果 caller 没有显式指定） */
  defaultTools: string[]
  /** 要强制切换到的权限模式；undefined 表示沿用父 Agent */
  forcedPermissionMode?: 'plan' | 'strict' | 'default'
  /** 最大对话轮数 */
  defaultMaxTurns: number
  /** system prompt 生成函数 */
  buildSystemPrompt(context: SubAgentBuildContext): string
  /** 结果前缀标签（给调用方一眼看到是哪种 agent 的结果） */
  resultTag: string
}

interface SubAgentBuildContext {
  task: string
  /** 主 Agent 的工具历史摘要（仅 verify 类型使用） */
  toolHistorySummary?: string
  /** 主 Agent 的原始请求（仅 verify 类型使用） */
  originalRequest?: string
}

// ============================================================
// 四种人格的定义
// ============================================================

const SPECS: Record<SubAgentKind, SubAgentSpec> = {

  // --------------------------------------------------------
  // general —— 通用（向后兼容原行为）
  // --------------------------------------------------------
  general: {
    kind: 'general',
    defaultTools: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'web_search', 'web_fetch'],
    forcedPermissionMode: undefined,  // 继承父 Agent 的模式
    defaultMaxTurns: 10,
    resultTag: '[子Agent·通用]',
    buildSystemPrompt: ({ task }) => `你是一个专注的通用子 Agent。你的职责是完成以下任务并返回结果，不需要寒暄或多余解释。

任务:
${task}

完成后输出简洁的结果报告，包含:
1. 你做了什么
2. 关键发现或输出
3. 如果遇到错误，说明原因

不要做任务范围之外的事。不要派生新的子 Agent。`,
  },

  // --------------------------------------------------------
  // plan —— 规划调研，只读
  // --------------------------------------------------------
  plan: {
    kind: 'plan',
    defaultTools: ['read_file', 'glob', 'grep', 'web_search', 'web_fetch', 'bash'],
    forcedPermissionMode: 'plan',  // 硬性只读
    defaultMaxTurns: 12,
    resultTag: '[子Agent·规划]',
    buildSystemPrompt: ({ task }) => `你是一个规划调研子 Agent。你不能修改任何文件或系统状态——你的所有工具都是只读的，任何写操作都会被引擎拒绝。

你的职责:
- 使用 read_file / glob / grep / web_search / web_fetch / 只读 bash 命令来彻底理解问题
- 识别出完成任务需要接触的所有文件、代码位置、外部依赖
- 评估可行性、风险点、需要额外信息的地方
- 输出一份**可执行的方案**，而不是含糊的建议

任务:
${task}

完成后必须按以下格式输出方案:

## 背景与目标
一段话描述你对问题的理解。

## 调研结果
列出关键发现，每条带上文件路径或行号。例如:
- src/tools/bash.ts:42 — 当前的超时是硬编码的 30000
- package.json — 未安装 xxx 依赖

## 执行步骤
具体的、有序的步骤列表。每步说明"改什么、为什么"。

## 风险与需要确认的事项
列出不确定的点，让主 Agent 和用户决定。

## 所需工具
列出执行阶段需要用到的工具。

禁止:
- 不要直接开始实施（你没有写权限）
- 不要派生新的子 Agent
- 不要在没调研的情况下给建议`,
  },

  // --------------------------------------------------------
  // verify —— 验证主 Agent 的工作
  // --------------------------------------------------------
  verify: {
    kind: 'verify',
    defaultTools: ['read_file', 'glob', 'grep', 'bash'],
    forcedPermissionMode: 'plan',  // 硬性只读——验证时绝不能再修改东西
    defaultMaxTurns: 8,
    resultTag: '[子Agent·验证]',
    buildSystemPrompt: ({ task, toolHistorySummary, originalRequest }) => {
      const historySection = toolHistorySummary
        ? `

## 主 Agent 的执行历史
主 Agent 已经执行了以下操作:
${toolHistorySummary}`
        : ''
      const requestSection = originalRequest
        ? `

## 用户的原始请求
${originalRequest}`
        : ''

      return `你是一个验证子 Agent。你的唯一职责是**独立核查**主 Agent 声称完成的工作是否真的完成了。你不能修改任何东西——所有写操作都会被引擎拒绝。

你**不能相信主 Agent 的自我报告**。你必须用工具实际验证每一个声明:
- 主 Agent 说"我改了 src/x.ts 的第 42 行"? 读这个文件看是不是真改了
- 主 Agent 说"我修复了 bug"? 读代码看逻辑是否正确，如果有测试就跑测试
- 主 Agent 说"我写了新文件"? 用 glob 确认文件真的存在
- 主 Agent 说"依赖已安装"? 用 bash 跑 \`cat package.json\` 或 \`pip list\` 确认

要验证的任务:
${task}${requestSection}${historySection}

完成核查后**必须**按以下格式输出结论:

## 验证结论
**PASS** 或 **FAIL** 或 **PARTIAL**（全部字母大写，单独一行）

## 核查项
每个要验证的点列一行，格式:
- [✓/✗] 验证项描述 — 证据（文件路径、行号、命令输出摘要）

## 发现的问题
如果是 FAIL 或 PARTIAL，列出具体哪里没做到。要具体到文件和行号。

## 建议
给主 Agent 的下一步建议。简短。

注意:
- 你的结论必须基于工具返回的实际证据，不能脑补
- 如果证据不足以判断，结论应为 PARTIAL 并说明缺什么证据
- 不要帮主 Agent 修复问题，只汇报`
    },
  },

  // --------------------------------------------------------
  // explore —— 代码库探索
  // --------------------------------------------------------
  explore: {
    kind: 'explore',
    defaultTools: ['read_file', 'glob', 'grep', 'bash'],
    forcedPermissionMode: 'plan',  // 纯读
    defaultMaxTurns: 10,
    resultTag: '[子Agent·探索]',
    buildSystemPrompt: ({ task }) => `你是一个代码库探索子 Agent。你的任务是用只读工具在代码库里找东西，然后汇报你找到了什么。你不下任何判断、不给任何建议——只报告发现。

探索目标:
${task}

使用的策略:
- 先用 glob 找可能相关的文件
- 用 grep 搜索关键字、符号、字符串
- 用 read_file 读最相关的几个文件
- 必要时用 bash 跑只读命令（如 \`tree\`、\`wc -l\`、\`git log\`）

完成后按以下格式输出:

## 发现清单
按相关度排序，每条格式:
- **文件路径:行号** — 这里有什么（一句话）

## 文件概览
对最相关的 3-5 个文件各写一段话说明它们的作用和关键结构。

## 未找到的事项
如果探索目标里有没找到的东西，列出来。

禁止:
- 不要给出"建议"或"结论"，只报告事实
- 不要试图理解"为什么"代码是这样的，只描述"是什么"
- 不要派生新的子 Agent`,
  },
}

// ============================================================
// 工具主体
// ============================================================

export const subAgentTool: ToolDef = {
  name: 'sub_agent',
  isReadOnly: false,
  isConcurrencySafe: false,
  noPropagate: true,  // 子 Agent 不能再派子 Agent（防止无限递归）
  description: [
    '派生一个子 Agent 执行独立子任务。子 Agent 有自己的工具集和上下文，完成后返回结果。',
    '通过 kind 参数选择子 Agent 类型：',
    '  - general  : 通用（默认）。什么都能做，适合多步骤的具体工作',
    '  - plan     : 规划调研（只读）。先摸清问题、输出可执行方案，不直接改东西。适合"改 X 模块前先调研一下"',
    '  - verify   : 验证（只读）。独立核查主 Agent 声称完成的工作是否真的完成。适合"我改完了，请验证"',
    '  - explore  : 代码库探索（只读）。在项目中搜索文件/符号/内容，返回发现清单。适合"这个功能在哪里实现的？"',
    '注意：只读类型（plan/verify/explore）不能修改任何文件——不要用它们去"做事"，它们只负责"看"和"想"。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: '子任务描述。要清晰具体，像给同事写 brief。verify 类型要描述"要核查什么声明"。',
      },
      kind: {
        type: 'string',
        enum: ['general', 'plan', 'verify', 'explore'],
        description: '子 Agent 类型，默认 general',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: '自定义工具白名单。不提供时使用该 kind 的默认工具集',
      },
      timeout: {
        type: 'number',
        description: '超时毫秒数，默认 120000 (2分钟)',
      },
    },
    required: ['task'],
  },

  async execute(args: Record<string, any>, ctx: ToolContext): Promise<string> {
    const { task, tools: toolNames, timeout = 120000 } = args
    const kind: SubAgentKind = isValidKind(args.kind) ? args.kind : 'general'
    const spec = SPECS[kind]

    if (!task || typeof task !== 'string') {
      return '[错误] 缺少 task 参数'
    }

    const runAgent = await getRunAgent()

    // ========== 构造子 Agent 的工具注册表 ==========
    const globalRegistry = createDefaultRegistry()
    const subRegistry = new ToolRegistry()

    const allowedTools = Array.isArray(toolNames) && toolNames.length > 0
      ? toolNames
      : spec.defaultTools

    for (const name of allowedTools) {
      const tool = globalRegistry.get(name)
      if (!tool) continue
      if (tool.noPropagate) continue
      subRegistry.register(tool)
    }

    // ========== 构造 system prompt ==========
    // verify 类型需要额外的主 Agent 历史上下文
    let buildContext: SubAgentBuildContext = { task }
    if (kind === 'verify') {
      // 尝试从 ctx 里找到主 Agent 的 toolHistory
      // （ctx 上没有 toolHistory 字段，我们通过一个侧通道传入——见下方说明）
      const history = (ctx as any)._parentToolHistory as
        | Array<{ name: string; input: any; output: string }>
        | undefined
      const originalRequest = (ctx as any)._parentOriginalRequest as string | undefined

      if (history && history.length > 0) {
        buildContext.toolHistorySummary = summarizeToolHistory(history)
      }
      if (originalRequest) {
        buildContext.originalRequest = originalRequest
      }
    }

    const systemPrompt = spec.buildSystemPrompt(buildContext)

    console.log(`[SubAgent] 启动 ${kind} 类型子 Agent: ${task.slice(0, 60)}`)
    console.log(`[SubAgent] 工具: ${subRegistry.names().join(', ')}`)

    try {
      // 继承主 Agent 的 modelConfig
      const modelConfig = ctx.modelConfig || {
        provider: 'openai' as const,
        model: 'deepseek-chat',
        apiKey: process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || '',
        baseUrl: process.env.OPENAI_BASE_URL || 'https://api.deepseek.com',
      }

      // 子 Agent 的 sessionKey 要隔离，不能污染主 Agent 的 memory/todo
      const subSessionKey = ctx.sessionKey
        ? `${ctx.sessionKey}_sub_${kind}_${Math.random().toString(36).slice(2, 8)}`
        : undefined

      // ========== 权限上下文处理 ==========
      // 如果 spec 要求强制切换到只读模式，需要克隆 parent context 并修改 mode
      let subPermissionContext: PermissionContext | undefined = ctx.permissionContext
      if (subPermissionContext && spec.forcedPermissionMode) {
        subPermissionContext = {
          ...subPermissionContext,
          mode: spec.forcedPermissionMode,
          sessionKey: subSessionKey ?? subPermissionContext.sessionKey,
        }
      }

      const result = await runAgent(task, {
        modelConfig,
        systemPrompt,
        maxTurns: spec.defaultMaxTurns,
        timeoutMs: timeout,
        workDir: ctx.workDir,
        toolTimeout: 30000,
        registry: subRegistry,
        userId: ctx.userId,
        sessionKey: subSessionKey,
        permissionContext: subPermissionContext,
        confirmBridge: ctx.confirmBridge,
        auditLog: ctx.auditLog,
        parentAbortSignal: ctx.abortSignal,
        isSubAgent: true,
        agentDepth: (ctx.agentDepth || 0) + 1,
        // 子 Agent 不继承 memory 和 onStream
      })

      console.log(
        `[SubAgent] ${kind} 完成: ${result.turnCount} 轮, ${result.toolCallCount} 次工具调用`,
      )

      return `${spec.resultTag} ${result.turnCount}轮, ${result.toolCallCount}次工具调用

${result.content}`
    } catch (e: any) {
      console.error(`[SubAgent] ${kind} 失败:`, e)

      const isFatal = /401|403|invalid api key|account disabled/i.test(e.message || '')
      if (isFatal) {
        throw new Error(`子 Agent (${kind}) 致命错误: ${e.message}`)
      }

      const isTimeout = /timeout|aborted/i.test(e.message || '')
      if (isTimeout) {
        return `${spec.resultTag} [超时] 子任务在 ${timeout}ms 内未完成。请尝试拆解为更小的子任务。`
      }

      return `${spec.resultTag} [失败] ${e.message}`
    }
  },
}

// ============================================================
// 辅助
// ============================================================

function isValidKind(v: unknown): v is SubAgentKind {
  return v === 'general' || v === 'plan' || v === 'verify' || v === 'explore'
}

/**
 * 把主 Agent 的 toolHistory 压缩成一段易读的摘要文本
 * 给 verify 子 Agent 看——不能太长，重要是每一步"做了什么 + 结果摘要"
 */
function summarizeToolHistory(
  history: Array<{ name: string; input: any; output: string }>,
): string {
  if (history.length === 0) return '(无工具调用历史)'

  const MAX_ITEMS = 40
  const MAX_OUTPUT_CHARS = 120

  const items = history.slice(-MAX_ITEMS)  // 最近的 40 条
  const lines: string[] = []

  for (let i = 0; i < items.length; i++) {
    const h = items[i]
    const inputStr = formatInput(h.name, h.input)
    const output = (h.output ?? '').toString().replace(/\s+/g, ' ').trim()
    const outputShort = output.length > MAX_OUTPUT_CHARS
      ? output.slice(0, MAX_OUTPUT_CHARS) + '…'
      : output
    lines.push(`${i + 1}. ${h.name}(${inputStr}) → ${outputShort}`)
  }

  if (history.length > MAX_ITEMS) {
    lines.unshift(`(仅显示最近 ${MAX_ITEMS} 条，早先还有 ${history.length - MAX_ITEMS} 条操作)`)
  }

  return lines.join('\n')
}

function formatInput(toolName: string, input: any): string {
  if (!input || typeof input !== 'object') return String(input ?? '')
  // 针对常用工具挑"关键字段"
  const preferredFields: Record<string, string[]> = {
    bash: ['command'],
    read_file: ['path'],
    write_file: ['path'],
    edit_file: ['path'],
    glob: ['pattern'],
    grep: ['pattern', 'path'],
    web_fetch: ['url'],
    web_search: ['query'],
  }
  const fields = preferredFields[toolName] ?? Object.keys(input).slice(0, 2)
  const parts: string[] = []
  for (const f of fields) {
    const v = input[f]
    if (v === undefined) continue
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    const short = s.length > 60 ? s.slice(0, 60) + '…' : s
    parts.push(`${f}=${short}`)
  }
  return parts.join(', ')
}