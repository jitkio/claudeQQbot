/**
 * 会话笔记管理器
 *
 * 参考: Claude Code 的 SessionMemory/sessionMemory.ts
 *
 * 核心机制：
 * 1. 结构化模板：9 个固定 section 的 markdown（定义见 prompts.ts）
 * 2. 基于阈值的触发：token 增长 + 工具调用次数
 * 3. 独立 API 调用来更新笔记
 * 4. 写回时硬性约束：section 超长自动压缩
 * 5. 结构化查询：可按 section 名提取具体内容
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import {
  SESSION_NOTES_TEMPLATE,
  buildNotesUpdatePrompt,
  parseNotesSections,
  validateNotesStructure,
  enforceSectionLimits,
  SECTION_SPECS,
} from './prompts.js'
import type { MemoryConfig } from './memoryTypes.js'
import { DEFAULT_MEMORY_CONFIG } from './memoryTypes.js'
import { safeSessionKey } from '../utils/sessionKey.js'

export class SessionNotesManager {
  private notesDir: string
  private notesPath: string
  private config: MemoryConfig

  // 状态追踪（参照 sessionMemoryUtils.ts 的模块状态）
  private initialized = false
  private tokensAtLastUpdate = 0
  private toolCallsSinceLastUpdate = 0
  private isExtracting = false
  private updateCount = 0

  constructor(sessionKey: string, baseDir: string, config?: Partial<MemoryConfig>) {
    this.notesDir = `${baseDir}/memory/${safeSessionKey(sessionKey)}`
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
   * 按 section 名获取具体内容。
   * 未找到或为空返回 null，方便调用方做条件判断。
   *
   * 示例：
   *   notes.getSection('下一步')    → "- [ ] 修复 bash 权限 bug\n- [ ] 测试 MCP"
   *   notes.getSection('用户偏好')  → "偏好简短回复，要求用中文"
   */
  getSection(headerName: string): string | null {
    const raw = this.getCurrentNotes()
    if (!raw) return null
    const sections = parseNotesSections(raw)
    const content = sections[headerName]
    return content && content.trim() ? content.trim() : null
  }

  /** 获取所有 section 的结构化字典 */
  getAllSections(): Record<string, string> {
    return parseNotesSections(this.getCurrentNotes())
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
   * 在 QQ bot 中没有 Claude Code 那样的 forked subagent 机制，
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
      let updatedNotes = await generateFn(fullPrompt)

      // 清理：有些模型会无视指令包一层 ```markdown ... ```
      updatedNotes = stripMarkdownFence(updatedNotes)

      // 结构校验：必须包含全部 9 个 section
      const validation = validateNotesStructure(updatedNotes)
      if (!validation.valid) {
        console.warn(
          `[SessionNotes] 模型返回缺少 section: ${validation.missing.join(', ')}，尝试修复`,
        )
        // 尝试从旧笔记继承缺失的 section，而不是完全放弃这次更新
        updatedNotes = mergeMissingSections(updatedNotes, currentNotes)
        const revalidation = validateNotesStructure(updatedNotes)
        if (!revalidation.valid) {
          console.warn(`[SessionNotes] 修复后仍缺少: ${revalidation.missing.join(', ')}，跳过更新`)
          return
        }
      }

      // 硬性大小约束（代码兜底，防止模型忘记压缩）
      const enforced = enforceSectionLimits(updatedNotes)

      writeFileSync(this.notesPath, enforced)
      this.updateCount++
      console.log(
        `[SessionNotes] 笔记已更新 #${this.updateCount} (${enforced.length} 字, ${currentTokenCount} tokens)`,
      )

      // 更新追踪状态
      this.tokensAtLastUpdate = currentTokenCount
      this.toolCallsSinceLastUpdate = 0

    } catch (e: any) {
      console.error(`[SessionNotes] 更新失败: ${e.message}`)
    } finally {
      this.isExtracting = false
    }
  }

  /** 构建注入到对话中的记忆上下文 */
  buildContextInjection(): string {
    const notes = this.getCurrentNotes()
    if (!notes || notes.trim() === SESSION_NOTES_TEMPLATE.trim()) return ''

    // 检测笔记是否"实质性为空"——每个 section 都没有内容
    const sections = parseNotesSections(notes)
    const hasAnyContent = Object.values(sections).some(v => v && v.trim().length > 0)
    if (!hasAnyContent) return ''

    return `<session_memory>
以下是本次会话的结构化笔记，帮助你了解之前的进展。优先参考「当前状态」和「下一步」来判断该做什么。

${notes}
</session_memory>`
  }

  /** 获取更新次数（调试用） */
  getUpdateCount(): number {
    return this.updateCount
  }

  /** 重置（新对话） */
  reset() {
    this.initialized = false
    this.tokensAtLastUpdate = 0
    this.toolCallsSinceLastUpdate = 0
    this.updateCount = 0
    if (existsSync(this.notesPath)) {
      writeFileSync(this.notesPath, SESSION_NOTES_TEMPLATE)
    }
  }
}

// ============================================================
// 辅助函数
// ============================================================

/** 去掉模型返回值外面可能包裹的 markdown 代码块 */
function stripMarkdownFence(s: string): string {
  let out = s.trim()
  out = out.replace(/^```(?:markdown|md)?\s*\n/i, '')
  out = out.replace(/\n\s*```\s*$/i, '')
  return out.trim()
}

/**
 * 当模型返回的笔记缺少某些 section 时，从旧笔记继承这些 section 的内容，
 * 尽可能挽救这次更新而不是完全放弃。
 */
function mergeMissingSections(newNotes: string, oldNotes: string): string {
  const newSections = parseNotesSections(newNotes)
  const oldSections = parseNotesSections(oldNotes)

  const out: string[] = []
  for (const spec of SECTION_SPECS) {
    out.push(`# ${spec.header}`)
    out.push(spec.description)
    const content =
      (newSections[spec.header] && newSections[spec.header].trim()) ||
      (oldSections[spec.header] && oldSections[spec.header].trim()) ||
      ''
    out.push(content)
    out.push('')
  }
  return out.join('\n').trimEnd() + '\n'
}