/**
 * 记忆管理器 — 统一入口
 *
 * 将三个子系统串联：
 * 1. SessionNotesManager — 结构化会话笔记
 * 2. ContextCompactor — 上下文压缩
 * 3. UserProfileManager — 用户画像
 */
import { SessionNotesManager } from './sessionNotes.js'
import { ContextCompactor } from './contextCompactor.js'
import { UserProfileManager } from './userProfile.js'
import type { MemoryConfig } from './memoryTypes.js'
import { DEFAULT_MEMORY_CONFIG } from './memoryTypes.js'

export class MemoryManager {
  public notes: SessionNotesManager
  public compactor: ContextCompactor
  public profiles: UserProfileManager
  private config: MemoryConfig

  constructor(
    sessionKey: string,
    userId: string,
    baseDir: string,
    maxModelTokens: number,
    config?: Partial<MemoryConfig>,
  ) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config }
    this.notes = new SessionNotesManager(sessionKey, baseDir, this.config)
    this.compactor = new ContextCompactor(maxModelTokens, this.config.compactThresholdRatio)
    this.profiles = new UserProfileManager(baseDir)
  }

  /**
   * 构建完整记忆上下文（9 section 全文注入）
   *
   * 适用于：
   *   - 新对话首轮，需要让模型完整了解历史
   *   - 长时间无新消息后的重启（跨天续聊）
   *
   * token 开销较大（典型 800-2000 tokens），慎用。
   */
  buildFullContext(userId: string): string {
    const parts: string[] = []

    const profileCtx = this.profiles.buildContextInjection(userId)
    if (profileCtx) parts.push(profileCtx)

    const notesCtx = this.notes.buildContextInjection()
    if (notesCtx) parts.push(notesCtx)

    return parts.join('\n\n')
  }

  /**
   * 构建紧凑记忆上下文（只注入 3 个关键 section）
   *
   * 关键 section：当前状态 / 下一步 / 用户偏好
   * 其余 section（已完成工作、决策理由等）留在磁盘上，通过 SessionMemory 的
   * 完整上下文机制在需要时按需加载。
   *
   * 适用于：
   *   - 常规的每轮对话注入（替代 buildFullContext）
   *   - token 预算紧张时
   *
   * 典型开销 100-400 tokens。
   */
  buildCompactContext(userId: string): string {
    const parts: string[] = []

    // 用户画像（用户是谁 / 偏好什么语气）
    const profileCtx = this.profiles.buildContextInjection(userId)
    if (profileCtx) parts.push(profileCtx)

    // 只取 3 个关键 section，而不是全文
    const state = this.notes.getSection('当前状态')
    const nextSteps = this.notes.getSection('下一步')
    const prefs = this.notes.getSection('用户偏好')

    const noteFragments: string[] = []
    if (state) noteFragments.push(`## 当前状态\n${state}`)
    if (nextSteps) noteFragments.push(`## 下一步（未完成的待办）\n${nextSteps}`)
    if (prefs) noteFragments.push(`## 用户偏好\n${prefs}`)

    if (noteFragments.length > 0) {
      parts.push(
        `<session_memory>\n以下是本次会话的关键笔记，帮助你了解当前进展：\n\n${noteFragments.join('\n\n')}\n</session_memory>`,
      )
    }

    return parts.join('\n\n')
  }

  /**
   * 构建系统指令级的「下一步」提醒
   *
   * 返回一段追加到 systemPrompt 末尾的文本。如果「下一步」为空返回空字符串。
   *
   * 与 buildCompactContext 的区别：
   *   - buildCompactContext 注入到 user 消息开头，提供信息
   *   - buildNextStepsReminder 注入到 system prompt，提供指令
   *
   * 两者配合使用能显著提升模型对待办事项的重视度。
   */
  buildNextStepsReminder(): string {
    const nextSteps = this.notes.getSection('下一步')
    if (!nextSteps) return ''

    return `

---
## 重要提醒：待办事项

以下是本次会话中尚未完成的事项，你曾在之前的对话中承诺过要做。除非用户明确改变了方向，否则你应当优先推进这些事项而不是重新规划：

${nextSteps}

如果你认为某个事项已经完成或不再需要，请在本轮回复中明确说明并让用户确认。`
  }
}

// 导出子模块方便单独使用
export { SessionNotesManager } from './sessionNotes.js'
export { ContextCompactor } from './contextCompactor.js'
export { UserProfileManager } from './userProfile.js'
export type { MemoryConfig, UserProfile, SessionNotes, CompactSummary, NoteSection } from './memoryTypes.js'
export { DEFAULT_MEMORY_CONFIG } from './memoryTypes.js'