/**
 * 上下文压缩器
 *
 * 参考: Claude Code 的 compact/autoCompact.ts, microCompact.ts, compact.ts
 *
 * 两阶段压缩：
 * 1. 微压缩（不调 API）：清理旧的工具调用结果，零成本
 * 2. 完整压缩（调 API）：生成结构化摘要 + 保留最近 N 轮原始对话
 */
import type { Message } from '../types.js'
import { buildCompactPrompt, extractCompactSummary } from './prompts.js'

export class ContextCompactor {
  private maxTokens: number
  private thresholdRatio: number

  constructor(maxTokens: number, thresholdRatio = 0.75) {
    this.maxTokens = maxTokens
    this.thresholdRatio = thresholdRatio
  }

  /** 估算消息的 token 数（粗略：中文 1 字 ≈ 2 token，英文 4 字符 ≈ 1 token） */
  estimateTokens(messages: Message[]): number {
    let total = 0
    for (const msg of messages) {
      const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      // 粗略估算：中文字符 ×2 + 英文字符 ×0.25
      const zhChars = (text.match(/[\u4e00-\u9fff]/g) || []).length
      const otherChars = text.length - zhChars
      total += zhChars * 2 + Math.ceil(otherChars / 4)
    }
    return total
  }

  /** 判断是否需要压缩 */
  shouldCompact(messages: Message[]): boolean {
    const tokens = this.estimateTokens(messages)
    return tokens > this.maxTokens * this.thresholdRatio
  }

  /**
   * 第一步：微压缩（不调 API，零成本）
   * 参照 $CC/services/compact/microCompact.ts 的策略
   *
   * 清理旧的工具调用结果，只保留最近的。
   * 可清理的工具：bash, web_search, web_fetch, glob, grep, file_read, python
   * 不可清理的：file_write, file_edit（这些改了文件，结果重要）
   */
  microCompact(messages: Message[]): Message[] {
    const CLEARABLE_TOOL_RESULTS = new Set([
      'bash', 'web_search', 'web_fetch', 'glob', 'grep', 'file_read', 'python'
    ])

    // 从后往前扫描，保留最近 3 个可清理的工具结果，清理更早的
    const toolResultIndices: number[] = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'tool' && msg.name && CLEARABLE_TOOL_RESULTS.has(msg.name)) {
        toolResultIndices.push(i)
      }
    }

    // 保留最近 3 个，清理更早的
    const indicesToClear = new Set(toolResultIndices.slice(3))

    return messages.map((msg, i) => {
      if (indicesToClear.has(i)) {
        return {
          ...msg,
          content: `[工具 ${msg.name} 的结果已压缩以节省上下文空间]`,
        }
      }
      return msg
    })
  }

  /**
   * 第二步：完整压缩（调 API）
   * 参照 $CC/services/compact/prompt.ts 的 BASE_COMPACT_PROMPT
   *
   * 将所有消息压缩为一条 system 级摘要 + 保留最近 N 轮原始对话
   */
  async fullCompact(
    messages: Message[],
    generateFn: (prompt: string) => Promise<string>,
    sessionNotes?: string,
  ): Promise<Message[]> {
    // 保留最近 3 轮完整对话
    const keepCount = this.findRecentTurnBoundary(messages, 3)
    const toCompress = messages.slice(0, messages.length - keepCount)
    const toKeep = messages.slice(messages.length - keepCount)

    if (toCompress.length === 0) return messages

    // 构造待压缩的对话文本
    const conversationText = toCompress
      .filter(m => m.role !== 'system')
      .map(m => `[${m.role}${m.name ? ':' + m.name : ''}] ${
        typeof m.content === 'string' ? m.content.slice(0, 500) : '(多模态内容)'
      }`)
      .join('\n\n')

    const compactPrompt = buildCompactPrompt()
    const fullPrompt = `${conversationText}\n\n---\n\n${compactPrompt}`

    const rawSummary = await generateFn(fullPrompt)
    const summary = extractCompactSummary(rawSummary)

    // 组装压缩后的消息列表
    const compactedMessages: Message[] = []

    // 保留原始 system message
    const systemMsg = messages.find(m => m.role === 'system')
    if (systemMsg) compactedMessages.push(systemMsg)

    // 加入压缩摘要作为 user 消息
    let summaryContent = `本次对话已进行了较长时间，以下是之前对话的摘要：\n\n${summary}`
    if (sessionNotes) {
      summaryContent += `\n\n会话笔记：\n${sessionNotes}`
    }
    summaryContent += '\n\n请基于以上上下文继续对话，不要复述摘要内容。'

    compactedMessages.push({ role: 'user', content: summaryContent })
    compactedMessages.push({ role: 'assistant', content: '好的，我已了解之前的对话内容，请继续。' })

    // 加入保留的最近几轮对话
    compactedMessages.push(...toKeep)

    console.log(`[Compact] 压缩完成: ${messages.length} 条消息 → ${compactedMessages.length} 条`)
    return compactedMessages
  }

  /** 从消息列表末尾往前找 N 个完整"轮"的边界 */
  private findRecentTurnBoundary(messages: Message[], turns: number): number {
    let turnCount = 0
    let count = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      count++
      if (messages[i].role === 'user') {
        turnCount++
        if (turnCount >= turns) return count
      }
    }
    return count
  }
}
