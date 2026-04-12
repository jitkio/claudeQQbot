import type { ToolDef, ToolContext } from '../types.js'

/** 模型返回的单个工具调用（在 adapter 层已经解析过） */
export interface ToolCallInfo {
  id: string
  name: string
  input: Record<string, unknown>
}

/** 工具执行的结果 */
export interface ToolCallResult {
  id: string                    // 对应 ToolCallInfo.id
  name: string
  success: boolean
  content: string               // 序列化后的输出
  errorMessage?: string
  durationMs: number
}

/** 一个执行批次 */
export interface ExecutionBatch {
  isConcurrencySafe: boolean
  calls: ToolCallInfo[]
}

/** 整轮 runTools 的返回 */
export interface RunToolsResult {
  results: ToolCallResult[]     // 顺序与输入一致
  totalDurationMs: number
  batchCount: number
  concurrentCallCount: number
  serialCallCount: number
  abortedCallCount: number
}

/** 工具执行的 context（透传给每个工具的 execute 方法），继承 ToolContext 的所有字段 */
export interface ToolExecutionContext extends ToolContext {
  memory?: unknown               // 由记忆专项填充
  // 规划系统字段（由 agentEngine 注入，todoWrite 工具使用）
  todoReminderTracker?: unknown   // TodoReminderTracker 实例
  isSubAgent?: boolean            // 是否为子 Agent（影响 verification nudge）
}

/** 流式文本 chunk */
export interface StreamChunk {
  type: 'text_delta' | 'tool_use_start' | 'tool_use_delta' | 'message_stop'
  text?: string                  // text_delta 的内容
  toolCallId?: string            // tool_use_* 的 id
  toolName?: string              // tool_use_start 的名字
  inputDelta?: string            // tool_use_delta 的 JSON 片段
}

/** 流式推送配置 */
export interface StreamConfig {
  /** 累计多少字符后立即 flush */
  flushBufferChars: number
  /** 距上次 flush 多少毫秒后强制 flush */
  flushIntervalMs: number
  /** 遇到这些字符时立即 flush（段落边界） */
  flushOnChars: string[]
  /** 每次 flush 之间的最小间隔（避免 QQ 限流） */
  minGapMs: number
}

export const DEFAULT_STREAM_CONFIG: StreamConfig = {
  flushBufferChars: 120,          // QQ 消息偏短，120 字比 500 字更合适
  flushIntervalMs: 3000,          // 3 秒没新内容就强制刷
  flushOnChars: ['\n\n', '。', '！', '？'],
  minGapMs: 1500,                 // QQ 消息每 1.5 秒最多推一条
}

/** 工具选择结果 */
export interface ToolSelectionResult {
  selected: ToolDef[]
  dropped: string[]               // 被过滤掉的工具名
  reason: string                  // 人类可读的选择依据
}
