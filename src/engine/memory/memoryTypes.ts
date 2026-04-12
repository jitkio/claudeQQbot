/** 会话笔记的一个 section */
export interface NoteSection {
  header: string           // "# Current State"
  description: string      // italic 描述行（模板固定，不可改）
  content: string          // 实际内容（可更新）
}

/** 完整的会话笔记 */
export interface SessionNotes {
  sections: NoteSection[]
  lastUpdatedAt: number
  updateCount: number
  totalTokensAtLastUpdate: number
}

/** 上下文压缩的摘要 */
export interface CompactSummary {
  text: string
  createdAt: number
  originalMessageCount: number
  compressedTokens: number
}

/** 用户画像 */
export interface UserProfile {
  userId: string
  name?: string
  facts: string[]          // 从对话中提取的事实
  preferences: {
    responseStyle?: string // '简洁' | '详细'
    language?: string
    topics?: string[]      // 经常聊的话题
  }
  corrections: string[]    // 用户纠正过的错误
  lastActive: string       // ISO 时间
  createdAt: string
}

/** 记忆管理器配置 */
export interface MemoryConfig {
  /** 首次初始化笔记需要的最低 token 数 */
  minTokensToInit: number
  /** 两次笔记更新之间需要的最低 token 增长 */
  minTokensBetweenUpdates: number
  /** 两次笔记更新之间需要的最低工具调用次数 */
  toolCallsBetweenUpdates: number
  /** 每个笔记 section 的最大 token 数 */
  maxSectionTokens: number
  /** 笔记总最大 token 数 */
  maxTotalNoteTokens: number
  /** 触发上下文压缩的 token 阈值（占 maxTokens 的比例） */
  compactThresholdRatio: number
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  minTokensToInit: 3000,          // QQ 对话比 IDE 短，降低阈值
  minTokensBetweenUpdates: 2000,  // 同上
  toolCallsBetweenUpdates: 2,     // QQ 场景工具调用较少
  maxSectionTokens: 800,          // QQ 消息短，笔记也不需要太长
  maxTotalNoteTokens: 5000,
  compactThresholdRatio: 0.75,    // 上下文用了 75% 就开始压缩
}
