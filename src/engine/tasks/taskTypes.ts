/**
 * 后台任务系统的类型定义
 *
 * 设计参考: Claude Code 的 TaskCreate/Get/Update/Stop/List/Output 工具
 * 但简化了很多——我们只需要支持 bot 在 QQ 场景下的长任务代理
 */

// ============================================================
// 常量
// ============================================================

/** 任务 ID 前缀 */
export const TASK_ID_PREFIX = 'task_'

/** 每个用户同时运行的最大任务数 —— 超出进入 pending */
export const PER_USER_RUNNING_LIMIT = 2

/** 全局最大任务数（任何状态，防止磁盘被刷爆） */
export const GLOBAL_MAX_TASKS = 500

/** 单个任务默认的最大运行时长（ms） */
export const DEFAULT_TASK_MAX_DURATION_MS = 30 * 60 * 1000   // 30 分钟

/** 单个任务允许的绝对最大时长（ms） */
export const HARD_TASK_MAX_DURATION_MS = 2 * 60 * 60 * 1000  // 2 小时

/** 输出块最大长度（每个 block） */
export const MAX_OUTPUT_BLOCK_CHARS = 8 * 1024

/** 一个任务最多保留多少个输出块（超过就滚动丢弃最旧的） */
export const MAX_OUTPUT_BLOCKS_PER_TASK = 200

/** 任务磁盘保留时长：done/failed 状态超过这个时间的任务文件会被清理 */
export const TASK_RETENTION_MS = 24 * 60 * 60 * 1000  // 24 小时

// ============================================================
// 任务状态机
// ============================================================

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'stopped' | 'timeout'

/** 终止状态（一旦进入就不会再变） */
export const TERMINAL_STATUSES: TaskStatus[] = ['done', 'failed', 'stopped', 'timeout']

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

// ============================================================
// 核心数据结构
// ============================================================

/**
 * 任务记录——会被持久化到磁盘
 *
 * 每个字段都必须是 JSON 可序列化的（不能有函数、Map、Set 等）
 */
export interface TaskRecord {
  /** 任务 ID，格式 task_<8位hex> */
  id: string

  /** 发起用户的 userId（和 taskQueue 里的一致，通常是 QQ openid） */
  userId: string

  /** 发起用户的 sessionKey（用于关联原会话，通知用） */
  originSessionKey: string

  /** 用户原始发送的目标信息，通知用 */
  notifyTarget: {
    kind: 'c2c' | 'group'
    targetId: string       // c2c 是 userOpenId，group 是 groupOpenId
  }

  /** 任务描述（给子 agent 的 prompt） */
  description: string

  /** 用户可选的友好名（task_list 显示用） */
  title?: string

  /** 当前状态 */
  status: TaskStatus

  /** 结果（done/failed/timeout/stopped 时填充） */
  result?: {
    content: string           // 最终回复文本
    toolCallCount: number
    turnCount: number
  }

  /** 错误信息（仅 failed / timeout） */
  error?: string

  /** 追加的指令（task_update 写入，下次轮到 running 时合并到 prompt） */
  pendingUpdates: string[]

  /** 结构化输出块（增量产生的、按时间序追加） */
  outputs: OutputBlock[]

  /** 时间戳（全部 Unix ms） */
  createdAt: number
  startedAt?: number          // 首次 running 时设置
  finishedAt?: number         // 进入终止状态时设置
  maxDurationMs: number       // 最长运行时长

  /** 完成通知是否已经被 drain 过（主循环用） */
  notified: boolean

  /** 模型配置快照（避免运行过程中用户切换模型影响任务） */
  modelConfig: {
    provider: string
    model: string
    apiKey: string
    baseUrl?: string
  }

  /** 权限模式快照 */
  permissionMode: string
}

/** 任务产生的输出块——结构化、可增量追加 */
export interface OutputBlock {
  /** 时间戳 */
  at: number
  /** 输出类型 */
  kind: 'tool' | 'text' | 'error' | 'info'
  /** 内容（截断到 MAX_OUTPUT_BLOCK_CHARS） */
  content: string
  /** 关联的工具名（仅 kind=tool） */
  toolName?: string
}

// ============================================================
// 用户侧事件类型（仅给 TaskManager 内部使用）
// ============================================================

export type TaskEvent =
  | { kind: 'created'; task: TaskRecord }
  | { kind: 'started'; task: TaskRecord }
  | { kind: 'output'; taskId: string; block: OutputBlock }
  | { kind: 'finished'; task: TaskRecord }
  | { kind: 'updated'; task: TaskRecord }