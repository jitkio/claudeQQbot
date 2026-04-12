/**
 * 会话笔记管理器
 *
 * 参考: Claude Code 的 SessionMemory/sessionMemory.ts
 *
 * 核心机制：
 * 1. 结构化模板：8 个固定 section 的 markdown
 * 2. 基于阈值的触发：token 增长 + 工具调用次数
 * 3. 独立 API 调用来更新笔记
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { SESSION_NOTES_TEMPLATE, buildNotesUpdatePrompt } from './prompts.js'
import type { MemoryConfig } from './memoryTypes.js'
import { DEFAULT_MEMORY_CONFIG } from './memoryTypes.js'

export class SessionNotesManager {
  private notesDir: string
  private notesPath: string
  private config: MemoryConfig

  // 状态追踪（参照 sessionMemoryUtils.ts 的模块状态）
  private initialized = false
  private tokensAtLastUpdate = 0
  private toolCallsSinceLastUpdate = 0
  private isExtracting = false

  constructor(sessionKey: string, baseDir: string, config?: Partial<MemoryConfig>) {
    this.notesDir = `${baseDir}/memory/${sessionKey}`
    this.notesPath = `${this.notesDir}/notes.md`
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config }
    mkdirSync(this.notesDir, { recursive: true })
  }

  /** 获取当前笔记内容（注入到 system prompt 或 user message 中） */
  getCurrentNotes(): string {
    if (!existsSync(this.notesPath)) return ''
    return readFileSync(this.notesPath, 'utf-8')
  }

  /**
   * 判断是否应该触发笔记更新
   * 参照 $CC/services/SessionMemory/sessionMemory.ts 第 115-170 行
   */
  shouldUpdate(currentTokenCount: number, hasToolCallsInLastTurn: boolean): boolean {
    if (this.isExtracting) return false

    // 首次初始化：需要足够的对话量
    if (!this.initialized) {
      if (currentTokenCount < this.config.minTokensToInit) return false
      this.initialized = true
    }

    // token 增长阈值
    const tokenGrowth = currentTokenCount - this.tokensAtLastUpdate
    const hasMetTokenThreshold = tokenGrowth >= this.config.minTokensBetweenUpdates

    // 工具调用阈值
    const hasMetToolCallThreshold =
      this.toolCallsSinceLastUpdate >= this.config.toolCallsBetweenUpdates

    // 触发条件（与 Claude Code 相同的逻辑）：
    // 1. token 阈值 AND 工具调用阈值都满足
    // 2. 或者：token 阈值满足 AND 最新一轮没有工具调用（自然间歇点）
    return (hasMetTokenThreshold && hasMetToolCallThreshold) ||
           (hasMetTokenThreshold && !hasToolCallsInLastTurn)
  }

  /** 记录一次工具调用（用于阈值计数） */
  recordToolCall() {
    this.toolCallsSinceLastUpdate++
  }

  /**
   * 执行笔记更新
   *
   * 在你的项目中，没有 Claude Code 那样的 forked subagent 机制，
   * 所以改为：构造一个独立的 API 调用来更新笔记。
   *
   * @param generateFn - 用于生成笔记的函数（调用模型 API）
   * @param conversationContext - 最近的对话内容（用于提取信息）
   * @param currentTokenCount - 当前上下文 token 数
   */
  async updateNotes(
    generateFn: (prompt: string) => Promise<string>,
    conversationContext: string,
    currentTokenCount: number,
  ): Promise<void> {
    if (this.isExtracting) return
    this.isExtracting = true

    try {
      // 初始化笔记文件
      if (!existsSync(this.notesPath)) {
        writeFileSync(this.notesPath, SESSION_NOTES_TEMPLATE)
      }

      const currentNotes = readFileSync(this.notesPath, 'utf-8')

      // 构造更新 prompt
      const updatePrompt = buildNotesUpdatePrompt(currentNotes, this.notesPath)

      // 发送给模型（用当前对话上下文 + 更新指令）
      const fullPrompt = `${conversationContext}\n\n---\n\n${updatePrompt}`
      const updatedNotes = await generateFn(fullPrompt)

      // 验证返回的笔记是否保留了 section 结构
      if (this.validateNotes(updatedNotes)) {
        writeFileSync(this.notesPath, updatedNotes)
        console.log(`[SessionNotes] 笔记已更新 (${updatedNotes.length} 字)`)
      } else {
        console.warn('[SessionNotes] 模型返回的笔记格式无效，跳过更新')
      }

      // 更新追踪状态
      this.tokensAtLastUpdate = currentTokenCount
      this.toolCallsSinceLastUpdate = 0

    } catch (e: any) {
      console.error(`[SessionNotes] 更新失败: ${e.message}`)
    } finally {
      this.isExtracting = false
    }
  }

  /** 验证笔记是否保留了必要的 section 结构 */
  private validateNotes(notes: string): boolean {
    const requiredSections = ['# 当前状态', '# 用户需求', '# 关键信息']
    return requiredSections.every(s => notes.includes(s))
  }

  /** 构建注入到对话中的记忆上下文 */
  buildContextInjection(): string {
    const notes = this.getCurrentNotes()
    if (!notes || notes === SESSION_NOTES_TEMPLATE) return ''

    return `<session_memory>
以下是本次会话的笔记，帮助你了解之前的对话：

${notes}
</session_memory>`
  }

  /** 重置（新对话） */
  reset() {
    this.initialized = false
    this.tokensAtLastUpdate = 0
    this.toolCallsSinceLastUpdate = 0
    if (existsSync(this.notesPath)) {
      writeFileSync(this.notesPath, SESSION_NOTES_TEMPLATE)
    }
  }
}
