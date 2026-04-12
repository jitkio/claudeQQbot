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

  // 创建适配器
  const adapter = createAdapter(modelConfig, workDir)

  // 工具注册表
  const registry = options.registry || createDefaultRegistry()

  // 动态工具选择：根据用户消息和模型类型选择合适的工具
  const promptText = typeof prompt === 'string' ? prompt : prompt
  const allTools = registry.getAll()
  const selector = createOrchestratorSelector(allTools)
  const selection = selector.select(promptText, modelConfig.provider)
  let tools = selection.selected

  if (selection.dropped.length > 0) {
    console.log(`[Agent] 工具选择: ${selection.reason}，过滤掉: ${selection.dropped.join(', ')}`)
  }

  // plan 模式：物理移除所有写工具，即使模型想调也调不到
  if (options.permissionContext?.mode === 'plan') {
    const READ_ONLY_TOOL_NAMES = ['read_file', 'glob', 'grep', 'web_search', 'web_fetch', 'web_extract', 'bash']
    tools = tools.filter(t => READ_ONLY_TOOL_NAMES.includes(t.name))
    // bash 虽然在列表里，但 permissionEngine 会在命令层面再做只读过滤
    console.log(`[Agent] plan 模式，限制工具集: ${tools.map(t => t.name).join(', ')}`)
  }
  if (tools.length > 0) {
    console.log(`[Agent] 动态选择 ${tools.length} 个工具: ${tools.map(t => t.name).join(', ')}`)
  } else {
    console.log(`[Agent] 纯对话模式（未触发工具）`)
  }

  // 构建初始消息
  const messages: Message[] = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }

  // 工具执行编排器（复用于所有轮次）
  const orchestrator = new ToolOrchestrator(tools)

  // 注入记忆上下文（用户画像 + 会话笔记）
  let enrichedPrompt = prompt
  if (options.memory && options.userId) {
    const memoryContext = options.memory.buildFullContext(options.userId)
    if (memoryContext && typeof prompt === 'string') {
      enrichedPrompt = `${memoryContext}\n\n用户当前消息: ${prompt}`
    }
  }

  messages.push({ role: 'user', content: enrichedPrompt })

  // 超时控制
  const abortController = new AbortController()
  const overallTimer = setTimeout(() => abortController.abort(), timeoutMs)

  let toolCallCount = 0
  let turnCount = 0
  let consecutiveErrors = 0  // 连续工具错误计数

  try {
    // Agent 循环
    for (let turn = 0; turn < maxTurns; turn++) {
      turnCount = turn + 1

      if (abortController.signal.aborted) {
        throw new Error('执行超时')
      }

      // 调用模型
      console.log(`[Agent] 第 ${turnCount} 轮，发送 ${messages.length} 条消息`)

      // 检查是否需要压缩上下文
      if (options.memory?.compactor.shouldCompact(messages)) {
        console.log('[Agent] 上下文接近上限，执行压缩...')
        // 先微压缩（零成本）
        const microCompacted = options.memory.compactor.microCompact(messages)
        messages.length = 0
        messages.push(...microCompacted)
        // 如果微压缩后还是超限，做完整压缩
        if (options.memory.compactor.shouldCompact(messages)) {
          const sessionNotes = options.memory.notes.getCurrentNotes()
          const fullCompacted = await options.memory.compactor.fullCompact(
            messages,
            async (p) => {
              const r = await adapter.chat([{ role: 'user', content: p }], [], { signal: abortController.signal })
              return r.content
            },
            sessionNotes,
          )
          messages.length = 0
          messages.push(...fullCompacted)
        }
      }

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
      }

      const runResult = await orchestrator.runTools(callInfos, execContext)

      console.log(`[Agent] 编排完成: ${runResult.batchCount} 批, 并发 ${runResult.concurrentCallCount} + 串行 ${runResult.serialCallCount}, 耗时 ${runResult.totalDurationMs}ms`)

      for (const result of runResult.results) {
        toolCallCount++
        options.memory?.notes.recordToolCall()
        console.log(`[Agent] 工具 ${result.name}: ${result.content.slice(0, 100)}${result.content.length > 100 ? '...' : ''}`)

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
