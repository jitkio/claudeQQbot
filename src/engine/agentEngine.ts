import type { Message, ModelResponse, ModelConfig } from './types.js'
import type { ModelAdapter } from '../adapters/base.js'
import { OpenAIAdapter } from '../adapters/openai.js'
import { AnthropicAdapter } from '../adapters/anthropic.js'
import { ClaudeCodeAdapter } from '../adapters/claudeCode.js'
import { ToolRegistry, createDefaultRegistry } from './toolRegistry.js'
import { createOrchestratorSelector } from './orchestrator/toolSelector.js'
import { getUsageTracker } from './usageTracker.js'
import type { MemoryManager } from './memory/memoryManager.js'
import type { PermissionContext } from './permission/permissionTypes.js'
import type { UserConfirmBridge } from './permission/userConfirmBridge.js'
import type { AuditLog } from './permission/auditLog.js'
import { ToolOrchestrator } from './orchestrator/toolOrchestrator.js'
import type { ToolCallInfo, ToolExecutionContext } from './orchestrator/orchestratorTypes.js'

// 规划系统
import type { TodoStore } from './planning/todoStore.js'
import { TodoReminderTracker } from './planning/todoReminder.js'

export interface AgentEngineOptions {
  modelConfig: ModelConfig
  systemPrompt?: string
  maxTurns?: number       // 最大工具调用循环轮数，默认 20
  timeoutMs?: number      // 总超时，默认 300000 (5分钟)
  workDir: string         // 工具工作目录
  toolTimeout?: number    // 单个工具超时，默认 60000
  registry?: ToolRegistry // 自定义工具注册表（默认使用内置工具）
  userId?: string         // 用户 ID（用于用量追踪和画像）
  sessionKey?: string     // 会话 Key（用于用量追踪）
  onStream?: (chunk: string) => void  // 流式输出回调
  memory?: MemoryManager  // 记忆管理器（会话笔记 + 上下文压缩 + 用户画像）
  permissionContext?: PermissionContext   // 权限审查上下文
  confirmBridge?: UserConfirmBridge       // QQ 二次确认桥
  auditLog?: AuditLog                     // 审计日志

  // 规划系统
  todoStore?: TodoStore                    // TodoList 存储
  /** 外部共享的 toolHistory 数组引用，让 verify_task 能拿到 */
  toolHistorySink?: Array<{ name: string; input: any; output: string }>
  /** 父 Agent 的 abort 信号，用于级联取消子 Agent */
  parentAbortSignal?: AbortSignal
  /** 标记当前是否为子 Agent（影响 verification nudge 等行为） */
  isSubAgent?: boolean
  /** 当前 Agent 的递归深度（0=主 Agent，每层子 Agent +1） */
  agentDepth?: number
}

export interface AgentResult {
  content: string         // 最终文本回复
  toolCallCount: number   // 工具调用总次数
  turnCount: number       // 对话循环轮数
}

/**
 * Agent 对话循环引擎
 *
 * 核心循环：
 *   用户消息 → 发给模型 → 模型返回
 *     如果有 toolCalls → 执行工具 → 把结果发回模型 → 继续
 *     如果是纯文本 → 返回最终结果
 *     循环最多 maxTurns 轮
 */
export async function runAgent(
  prompt: string,
  options: AgentEngineOptions,
): Promise<AgentResult> {
  const {
    modelConfig,
    systemPrompt,
    maxTurns = 20,
    timeoutMs = 300000,
    workDir,
    toolTimeout = 60000,
    onStream,
  } = options

  // 递归深度保护：防止子 Agent 无限嵌套
  const MAX_AGENT_DEPTH = 3
  const currentDepth = options.agentDepth || 0
  if (currentDepth >= MAX_AGENT_DEPTH) {
    return {
      content: `[错误] Agent 递归深度超过上限 (${MAX_AGENT_DEPTH})，拒绝继续派生子 Agent。`,
      toolCallCount: 0,
      turnCount: 0,
    }
  }

  // 创建适配器
  const adapter = createAdapter(modelConfig, workDir)

  // 工具注册表
  const registry = options.registry || createDefaultRegistry()

  // 动态工具选择：根据用户消息和模型类型选择合适的工具
  const promptText = typeof prompt === 'string'
    ? prompt
    : Array.isArray(prompt) ? (prompt as any[]).filter((p: any) => p.type === 'text').map((p: any) => p.text || '').join(' ') : String(prompt)
  const allTools = registry.getAll()
  const selector = createOrchestratorSelector(allTools)
  const selection = selector.select(promptText, modelConfig.provider)
  let tools = selection.selected

  if (selection.dropped.length > 0) {
    console.log(`[Agent] 工具选择: ${selection.reason}，过滤掉: ${selection.dropped.join(', ')}`)
  }

  // plan 模式：物理移除所有写工具，即使模型想调也调不到
  // 但保留 exit_plan_mode（让模型能提交方案退出规划模式）
  if (options.permissionContext?.mode === 'plan') {
    const PLAN_MODE_ALLOWED = ['read_file', 'glob', 'grep', 'web_search', 'web_fetch', 'web_extract', 'bash', 'enter_plan_mode', 'exit_plan_mode', 'todo_write', 'verify_task']
    tools = tools.filter(t => PLAN_MODE_ALLOWED.includes(t.name))
    // bash 虽然在列表里，但 permissionEngine 会在命令层面再做只读过滤
    console.log(`[Agent] plan 模式，限制工具集: ${tools.map(t => t.name).join(', ')}`)
  }
  if (tools.length > 0) {
    console.log(`[Agent] 动态选择 ${tools.length} 个工具: ${tools.map(t => t.name).join(', ')}`)
  } else {
    console.log(`[Agent] 纯对话模式（未触发工具）`)
  }

  // 构建初始消息
  // 如果记忆里有「下一步」未完成事项，追加到 systemPrompt 末尾作为硬提醒
  const nextStepsReminder = options.memory?.buildNextStepsReminder() ?? ''
  const effectiveSystemPrompt = systemPrompt
    ? systemPrompt + nextStepsReminder
    : (nextStepsReminder ? nextStepsReminder.trim() : undefined)

  const messages: Message[] = []
  if (effectiveSystemPrompt) {
    messages.push({ role: 'system', content: effectiveSystemPrompt })
    if (nextStepsReminder) {
      console.log('[Agent] 已注入「下一步」系统提醒')
    }
  }

  // 工具执行编排器（复用于所有轮次）
  const orchestrator = new ToolOrchestrator(tools)

  // 注入记忆上下文（用户画像 + 会话笔记）
  let enrichedPrompt = prompt
  if (options.memory && options.userId) {
    const memoryContext = options.memory.buildCompactContext(options.userId)
    if (memoryContext && typeof prompt === 'string') {
      enrichedPrompt = `${memoryContext}\n\n用户当前消息: ${prompt}`
    }
  }

  messages.push({ role: 'user', content: enrichedPrompt })

  // 超时控制
  const abortController = new AbortController()
  const overallTimer = setTimeout(() => abortController.abort(), timeoutMs)
  // 级联取消：父 Agent 被取消时，子 Agent 也取消
  if (options.parentAbortSignal) {
    options.parentAbortSignal.addEventListener('abort', () => abortController.abort(), { once: true })
  }

  let toolCallCount = 0
  let turnCount = 0
  let consecutiveErrors = 0  // 连续工具错误计数

  // 规划系统：初始化 reminder tracker 和 toolHistory
  const reminderTracker = new TodoReminderTracker()
  const toolHistory: Array<{ name: string; input: any; output: string }> = options.toolHistorySink ?? []

  try {
    // Agent 循环
    for (let turn = 0; turn < maxTurns; turn++) {
      turnCount = turn + 1

      if (abortController.signal.aborted) {
        throw new Error('执行超时')
      }

      // 规划系统：每轮开始时递增 reminder 计数器
      reminderTracker.onTurnStart()

      // 调用模型
      console.log(`[Agent] 第 ${turnCount} 轮，发送 ${messages.length} 条消息`)

      // 规划系统：检查是否需要注入 todo reminder
      if (options.todoStore && options.sessionKey) {
        const currentTodos = options.todoStore.get(options.sessionKey)
        if (reminderTracker.shouldInject(currentTodos)) {
          const reminderText = reminderTracker.buildReminder(
            currentTodos,
            (t) => options.todoStore!.render(t),
          )
          // 作为一条 user 消息插入到历史末尾
          messages.push({ role: 'user', content: reminderText })
          reminderTracker.onReminderInjected()
          console.log('[Planning] 已注入 todo reminder')
        }
      }

      // ============================================================
      // 【改动 1】开轮前压缩：分档阈值 + 先微后全
      // ============================================================
      // 策略：
      //   - 75% 阈值 → 微压缩（零成本，几乎没副作用，每轮都可以做）
      //   - 90% 阈值 → 完整压缩（调 API，仅在必要时做）
      //   - 两者串联：即使微压缩压不下去，只要没到 90% 就先继续，避免过度调 API
      // ============================================================
      await applyCompaction(messages, options, adapter, abortController, 'turn-start')

      let response: ModelResponse

      // 第一轮且有流式回调 → 用流式接口
      if (turn === 0 && onStream && adapter.chatStream) {
        response = await adapter.chatStream(messages, tools, onStream, { signal: abortController.signal })
      } else {
        response = await adapter.chat(messages, tools, { signal: abortController.signal })
      }

      // 记录 token 用量
      if (response.usage) {
        const tracker = getUsageTracker(workDir)
        tracker.record({
          sessionKey: options.sessionKey || 'unknown',
          userId: options.userId || 'unknown',
          model: modelConfig.model,
          inputTokens: response.usage.input,
          outputTokens: response.usage.output,
          toolCalls: response.toolCalls.length,
        })
      }

      // 将 assistant 回复加入历史
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      })

      // 如果没有工具调用，返回最终结果
      if (response.toolCalls.length === 0 || response.finishReason === 'stop') {
        // 异步更新会话笔记（不阻塞返回）
        triggerNotesUpdate(options, messages, response, adapter, abortController)
        return { content: response.content, toolCallCount, turnCount }
      }

      // 执行工具调用 — 使用 ToolOrchestrator 进行并发/串行编排
      const callInfos: ToolCallInfo[] = response.toolCalls.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: tc.arguments,
      }))

      const execContext: ToolExecutionContext = {
        workDir,
        timeout: toolTimeout,
        abortSignal: abortController.signal,
        permissionContext: options.permissionContext,
        confirmBridge: options.confirmBridge,
        auditLog: options.auditLog,
        modelConfig,                          // 让子 Agent 继承主 Agent 的模型
        sessionKey: options.sessionKey,        // 让工具知道当前会话
        userId: options.userId,                // 让工具知道当前用户
        agentDepth: currentDepth,              // 让子 Agent 知道当前递归深度
        // 规划系统：透传给工具
        todoReminderTracker: reminderTracker,
        isSubAgent: options.isSubAgent || false,
        // 给 verify 子 Agent 看主 Agent 的历史（侧通道，不走 ToolContext 类型约束）
        _parentToolHistory: toolHistory,
        _parentOriginalRequest: promptText,
      } as any

      const runResult = await orchestrator.runTools(callInfos, execContext)

      console.log(`[Agent] 编排完成: ${runResult.batchCount} 批, 并发 ${runResult.concurrentCallCount} + 串行 ${runResult.serialCallCount}, 耗时 ${runResult.totalDurationMs}ms`)

      for (const result of runResult.results) {
        toolCallCount++
        options.memory?.notes.recordToolCall()
        console.log(`[Agent] 工具 ${result.name}: ${result.content.slice(0, 100)}${result.content.length > 100 ? '...' : ''}`)

        // 规划系统：追加 toolHistory（供 verify_task 使用）
        const matchingCall = callInfos.find(c => c.id === result.id)
        toolHistory.push({
          name: result.name,
          input: matchingCall?.input,
          output: result.content,
        })

        // 将工具结果加入消息历史
        messages.push({
          role: 'tool',
          content: result.content,
          toolCallId: result.id,
          name: result.name,
        })

        // 自动纠错：检测连续工具错误
        const isError = !result.success
        if (isError) {
          consecutiveErrors++
          console.warn(`[Agent] 工具连续错误 ${consecutiveErrors} 次`)
        } else {
          consecutiveErrors = 0
        }
      }

      // ============================================================
      // 【改动 2】工具结果 push 完之后，轻量微压缩一次
      // ============================================================
      // 原因：一次 grep/web_fetch 可能瞬间塞进 50KB，如果不立即压缩，
      // 下一轮开头的模型调用会带着这 50KB 走完整条流水线。
      // 这里只做微压缩（零成本），不触发完整压缩（那个有 API 成本，放在轮开头做）。
      // ============================================================
      if (options.memory?.compactor.shouldCompact(messages)) {
        const before = options.memory.compactor.estimateTokens(messages)
        const microCompacted = options.memory.compactor.microCompact(messages)
        messages.length = 0
        messages.push(...microCompacted)
        const after = options.memory.compactor.estimateTokens(messages)
        if (before !== after) {
          console.log(`[Agent] 工具结果后微压缩: ${before} → ${after} tokens`)
        }
      }

      // 纠错提示注入（移到批次结果循环之后）
      if (consecutiveErrors >= 2 && consecutiveErrors <= 3) {
        messages.push({
          role: 'user',
          content: `工具连续失败了 ${consecutiveErrors} 次。请分析原因，尝试不同的方法。常见原因：命令不存在、文件路径错误、权限不足、依赖未安装。`,
        })
      } else if (consecutiveErrors > 3) {
        messages.push({
          role: 'user',
          content: '工具连续失败超过 3 次，请不要再尝试相同的工具，直接用文字回复用户你遇到的问题和建议。',
        })
      }
    }

    // 达到最大轮数
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    // 异步更新会话笔记
    triggerNotesUpdate(options, messages, null, adapter, abortController)
    return {
      content: lastAssistant?.content || '（达到最大执行轮数）',
      toolCallCount,
      turnCount,
    }
  } finally {
    clearTimeout(overallTimer)
  }
}

// ============================================================
// 【改动 3】新辅助函数：分档压缩策略
// ============================================================

/**
 * 分档压缩：
 *   - 如果当前 token > fullCompact 阈值（90%）：先微压缩，如果还超再调 API 完整压缩
 *   - 如果当前 token > microCompact 阈值（75%）但 <= 90%：只做微压缩（零成本）
 *   - 否则：什么都不做
 *
 * 这个函数是幂等的——被 microCompact 处理过的消息会被 isAlreadyCompressed 跳过，
 * 所以在主循环的多个位置调用（开轮前、工具结果后）是安全的。
 */
async function applyCompaction(
  messages: Message[],
  options: AgentEngineOptions,
  adapter: ModelAdapter,
  abortController: AbortController,
  phase: 'turn-start' | 'post-tool',
): Promise<void> {
  if (!options.memory) return
  const compactor = options.memory.compactor

  // 优先检查高水位（90%）
  const needsFull = compactor.shouldFullCompact
    ? compactor.shouldFullCompact(messages)
    : compactor.shouldCompact(messages)  // 向后兼容：旧版 compactor 没有这个方法
  const needsMicro = compactor.shouldCompact(messages)

  if (!needsMicro) return  // 连 75% 都没到，不用压

  const before = compactor.estimateTokens(messages)

  // 先做微压缩（零成本）
  const microCompacted = compactor.microCompact(messages)
  messages.length = 0
  messages.push(...microCompacted)

  const afterMicro = compactor.estimateTokens(messages)
  if (afterMicro !== before) {
    console.log(`[Agent:${phase}] 微压缩: ${before} → ${afterMicro} tokens`)
  }

  // 如果高水位仍然没降下来 → 调 API 做完整压缩
  // 注意：我们用 shouldFullCompact 作为完整压缩的触发条件，不用 shouldCompact
  // 否则微压缩压到 76% 就立刻去完整压缩，太激进、太费钱
  const stillNeedsFull = compactor.shouldFullCompact
    ? compactor.shouldFullCompact(messages)
    : needsFull && compactor.shouldCompact(messages)

  if (stillNeedsFull) {
    console.log(`[Agent:${phase}] 微压缩后仍超高水位，执行完整压缩...`)
    const sessionNotes = options.memory.notes.getCurrentNotes()
    const fullCompacted = await compactor.fullCompact(
      messages,
      async (p) => {
        const r = await adapter.chat(
          [{ role: 'user', content: p }],
          [],
          { signal: abortController.signal },
        )
        return r.content
      },
      sessionNotes,
    )
    messages.length = 0
    messages.push(...fullCompacted)
    const afterFull = compactor.estimateTokens(messages)
    console.log(`[Agent:${phase}] 完整压缩: ${afterMicro} → ${afterFull} tokens`)
  }
}

/** 控制流工具，不应该写入会话笔记 */
const SKIP_TOOLS_FOR_NOTES = new Set(['todo_write', 'enter_plan_mode', 'exit_plan_mode', 'verify_task'])

/** 异步触发会话笔记更新（不阻塞主流程） */
function triggerNotesUpdate(
  options: AgentEngineOptions,
  messages: Message[],
  response: ModelResponse | null,
  adapter: ModelAdapter,
  abortController: AbortController,
) {
  if (!options.memory) return

  const tokens = options.memory.compactor.estimateTokens(messages)
  const lastAssistantHasTools = response ? response.toolCalls.length > 0 : false

  if (options.memory.notes.shouldUpdate(tokens, lastAssistantHasTools)) {
    const conversationText = messages
      .filter(m => m.role !== 'system')
      .filter(m => !(m.role === 'tool' && m.name && SKIP_TOOLS_FOR_NOTES.has(m.name)))
      .map(m => `[${m.role}] ${typeof m.content === 'string' ? m.content.slice(0, 300) : '(附件)'}`)
      .join('\n')

    // 异步执行，用 .catch 防止崩溃
    options.memory.notes.updateNotes(
      async (p) => {
        const r = await adapter.chat([{ role: 'user', content: p }], [], { signal: abortController.signal })
        return r.content
      },
      conversationText,
      tokens,
    ).catch(e => console.error('[Memory] 笔记更新异常:', e.message))
  }
}

/** 根据配置创建对应的模型适配器 */
function createAdapter(config: ModelConfig, workDir: string): ModelAdapter {
  switch (config.provider) {
    case 'openai':
      return new OpenAIAdapter(config)
    case 'anthropic':
      return new AnthropicAdapter(config)
    case 'claude_code':
      return new ClaudeCodeAdapter(config, workDir)
    default:
      throw new Error(`不支持的模型提供商: ${config.provider}`)
  }
}