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

  /** 构建注入到 prompt 开头的完整记忆上下文 */
  buildFullContext(userId: string): string {
    const parts: string[] = []

    const profileCtx = this.profiles.buildContextInjection(userId)
    if (profileCtx) parts.push(profileCtx)

    const notesCtx = this.notes.buildContextInjection()
    if (notesCtx) parts.push(notesCtx)

    return parts.join('\n\n')
  }
}

// 导出子模块方便单独使用
export { SessionNotesManager } from './sessionNotes.js'
export { ContextCompactor } from './contextCompactor.js'
export { UserProfileManager } from './userProfile.js'
export type { MemoryConfig, UserProfile, SessionNotes, CompactSummary, NoteSection } from './memoryTypes.js'
export { DEFAULT_MEMORY_CONFIG } from './memoryTypes.js'
