/**
 * 上下文压缩器
 *
 * 参考: Claude Code 的 compact/autoCompact.ts, microCompact.ts, compact.ts
 *
 * 两阶段压缩：
 * 1. 微压缩（不调 API）：分层清理旧工具结果，零成本
 * 2. 完整压缩（调 API）：生成结构化摘要 + 保留最近 N 轮原始对话
 */
import type { Message } from '../types.js'
import { buildCompactPrompt, extractCompactSummary } from './prompts.js'

// ============================================================
// 常量
// ============================================================

/** 可清理的只读工具名（结果可在需要时删除或截断） */
const CLEARABLE_READONLY_TOOLS = new Set([
  'bash',           // 只读 bash 结果由 isReadOnly 判断，这里先列入
  'web_search',
  'web_fetch',
  'glob',
  'grep',
  'read_file',
  'file_read',      // 兼容老名字
  'python',
  'content_extract',
  'browser_action',
])

/** 绝对不可清理的工具名（这些工具改变了系统状态，结果是行为记录） */
const PROTECTED_TOOLS = new Set([
  'write_file',
  'file_write',
  'edit_file',
  'file_edit',
  'todo_write',
  'enter_plan_mode',
  'exit_plan_mode',
  'verify_task',
  'sub_agent',
])

/** 已被 microCompact 处理过的标记前缀（用于幂等检测） */
const COMPRESSED_MARKER = '[[COMPACTED:'

/** 默认最近保留数量（完全不动的近期工具结果数量） */
const DEFAULT_KEEP_RECENT = 3

/** 工具结果被认为"大"的阈值（字符数）——小于此值的结果不参与清理 */
const LARGE_RESULT_THRESHOLD = 800

/** 截断时保留的头尾字符数 */
const TRUNCATE_HEAD = 400
const TRUNCATE_TAIL = 200

// ============================================================
// 主类
// ============================================================

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

  /** 估算单条消息的 token 数 */
  private estimateMessageTokens(msg: Message): number {
    return this.estimateTokens([msg])
  }

  /** 判断是否需要压缩（达到阈值比例） */
  shouldCompact(messages: Message[]): boolean {
    const tokens = this.estimateTokens(messages)
    return tokens > this.maxTokens * this.thresholdRatio
  }

  /** 判断是否需要触发完整压缩（达到 90%，微压缩已经救不了了） */
  shouldFullCompact(messages: Message[]): boolean {
    const tokens = this.estimateTokens(messages)
    return tokens > this.maxTokens * 0.9
  }

  // ============================================================
  // 微压缩：多阶段分层策略
  // ============================================================

  /**
   * 微压缩（不调 API，零成本）
   *
   * 参照 $CC/services/compact/microCompact.ts 的分层策略：
   *
   *   阶段 1: 清除「最近N条之外」的「大的只读工具结果」
   *   阶段 2: 若仍超阈值，截断「最近N条之外」的「中等只读工具结果」
   *   阶段 3: 若仍超阈值，截断 assistant 消息中过长的文本段
   *
   * 每个阶段后都重新估算，达标就立刻返回。
   */
  microCompact(messages: Message[]): Message[] {
    const targetTokens = Math.floor(this.maxTokens * this.thresholdRatio)
    let working = messages.map(m => ({ ...m }))  // 浅拷贝，避免改到调用方

    // 统计一下初始情况
    const initialTokens = this.estimateTokens(working)
    if (initialTokens <= targetTokens) return working  // 本来就够用，什么都不做

    // --- 阶段 1: 清除大的旧工具结果 ---
    working = this.stage1ClearLargeResults(working, targetTokens)
    if (this.estimateTokens(working) <= targetTokens) {
      this.logStageResult('stage1', initialTokens, working)
      return working
    }

    // --- 阶段 2: 截断中等的旧工具结果 ---
    working = this.stage2TruncateMediumResults(working, targetTokens)
    if (this.estimateTokens(working) <= targetTokens) {
      this.logStageResult('stage2', initialTokens, working)
      return working
    }

    // --- 阶段 3: 截断过长的 assistant 文本段 ---
    working = this.stage3TruncateAssistantText(working, targetTokens)
    this.logStageResult('stage3', initialTokens, working)
    return working
  }

  /**
   * 阶段 1: 按时间从旧到新，逐条清除「大的、只读的、已过期的」工具结果。
   * 每清一条就重估一次，达标立即停。
   */
  private stage1ClearLargeResults(messages: Message[], targetTokens: number): Message[] {
    // 收集候选索引：只读工具结果、不在最近 KEEP_RECENT 个之内、不是已压缩过的
    const keepRecent = DEFAULT_KEEP_RECENT
    const allToolResultIndices: number[] = []
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (this.isClearableToolResult(m)) allToolResultIndices.push(i)
    }
    // 最近 keepRecent 个不动
    const protectedRecent = new Set(allToolResultIndices.slice(-keepRecent))

    // 按时间从旧到新清理（旧的先走）
    for (const idx of allToolResultIndices) {
      if (protectedRecent.has(idx)) continue
      const m = messages[idx]
      if (this.isAlreadyCompressed(m)) continue

      const size = typeof m.content === 'string' ? m.content.length : 0
      if (size < LARGE_RESULT_THRESHOLD) continue  // 小的先放过

      messages[idx] = {
        ...m,
        content: this.makeCompressedMarker(m.name ?? 'tool', size, 'cleared'),
      }

      if (this.estimateTokens(messages) <= targetTokens) break
    }
    return messages
  }

  /**
   * 阶段 2: 如果阶段 1 后还超，对「中等大小的旧工具结果」做头尾截断（保留结构信息）。
   */
  private stage2TruncateMediumResults(messages: Message[], targetTokens: number): Message[] {
    const keepRecent = DEFAULT_KEEP_RECENT
    const allToolResultIndices: number[] = []
    for (let i = 0; i < messages.length; i++) {
      if (this.isClearableToolResult(messages[i])) allToolResultIndices.push(i)
    }
    const protectedRecent = new Set(allToolResultIndices.slice(-keepRecent))

    for (const idx of allToolResultIndices) {
      if (protectedRecent.has(idx)) continue
      const m = messages[idx]
      if (this.isAlreadyCompressed(m)) continue

      if (typeof m.content !== 'string') continue
      const len = m.content.length
      if (len <= TRUNCATE_HEAD + TRUNCATE_TAIL + 50) continue  // 太短了没必要截

      const head = m.content.slice(0, TRUNCATE_HEAD)
      const tail = m.content.slice(len - TRUNCATE_TAIL)
      messages[idx] = {
        ...m,
        content: `${head}\n\n${this.makeCompressedMarker(m.name ?? 'tool', len - TRUNCATE_HEAD - TRUNCATE_TAIL, 'truncated')}\n\n${tail}`,
      }

      if (this.estimateTokens(messages) <= targetTokens) break
    }
    return messages
  }

  /**
   * 阶段 3: 最后手段——截断过长的 assistant 文本内容。
   * 只针对「非最近一条 assistant」且「超过 2000 字符」的消息。
   */
  private stage3TruncateAssistantText(messages: Message[], targetTokens: number): Message[] {
    // 找到最后一条 assistant 的位置（保护它）
    let lastAssistantIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') { lastAssistantIdx = i; break }
    }

    for (let i = 0; i < messages.length; i++) {
      if (i === lastAssistantIdx) continue
      const m = messages[i]
      if (m.role !== 'assistant') continue
      if (typeof m.content !== 'string') continue
      if (m.content.length < 2000) continue
      if (this.isAlreadyCompressed(m)) continue

      const head = m.content.slice(0, 800)
      const tail = m.content.slice(m.content.length - 400)
      messages[i] = {
        ...m,
        content: `${head}\n\n${this.makeCompressedMarker('assistant', m.content.length - 1200, 'truncated')}\n\n${tail}`,
      }

      if (this.estimateTokens(messages) <= targetTokens) break
    }
    return messages
  }

  // ============================================================
  // 辅助判定
  // ============================================================

  /** 是否是可清理的只读工具结果 */
  private isClearableToolResult(msg: Message): boolean {
    if (msg.role !== 'tool') return false
    if (!msg.name) return false
    if (PROTECTED_TOOLS.has(msg.name)) return false
    if (CLEARABLE_READONLY_TOOLS.has(msg.name)) return true
    // 未知工具名：按保守策略不清理（比如用户自己加的工具，默认保留）
    return false
  }

  /** 检测消息是否已经被 microCompact 处理过，避免二次压缩 */
  private isAlreadyCompressed(msg: Message): boolean {
    if (typeof msg.content !== 'string') return false
    return msg.content.includes(COMPRESSED_MARKER)
  }

  /** 生成压缩标记文本 */
  private makeCompressedMarker(
    toolName: string,
    originalSize: number,
    kind: 'cleared' | 'truncated',
  ): string {
    const action = kind === 'cleared' ? '完整清除' : '中段省略'
    return `${COMPRESSED_MARKER}${toolName}:${action}:${originalSize}字符]]`
  }

  /** 日志输出 */
  private logStageResult(stage: string, initialTokens: number, messages: Message[]) {
    const finalTokens = this.estimateTokens(messages)
    const saved = initialTokens - finalTokens
    const pct = initialTokens > 0 ? Math.round((saved / initialTokens) * 100) : 0
    console.log(
      `[microCompact] ${stage}: ${initialTokens} → ${finalTokens} tokens (省 ${saved}, -${pct}%)`,
    )
  }

  // ============================================================
  // 完整压缩（沿用原实现，略作清理）
  // ============================================================

  /**
   * 完整压缩（调 API）
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

    if (toCompress.length === 0) return [...messages]

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

    console.log(`[Compact] 完整压缩: ${messages.length} 条消息 → ${compactedMessages.length} 条`)
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