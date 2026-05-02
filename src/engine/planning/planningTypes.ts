/**
 * Agent 自规划系统 - 类型定义
 *
 */

/**
 * 单个待办项
 */
export interface TodoItem {
  /** 祈使句描述："搜索 X 的资料" */
  content: string
  /** 进行时描述："正在搜索 X 的资料" —— 进行中显示这个 */
  activeForm: string
  /** 状态 */
  status: 'pending' | 'in_progress' | 'completed'
}

export type TodoList = TodoItem[]

/**
 * 一次 TodoWrite 调用的结果
 */
export interface TodoWriteResult {
  oldTodos: TodoList
  newTodos: TodoList
  /** 是否需要在工具回执中追加 verification nudge */
  verificationNudgeNeeded: boolean
}

/**
 * Reminder 配置 —— 控制何时往对话里塞当前 todo 列表
 */
export interface TodoReminderConfig {
  /** 距上次 TodoWrite 调用至少多少轮才允许触发提醒 */
  turnsSinceWrite: number
  /** 两次提醒之间至少间隔多少轮 */
  turnsBetweenReminders: number
}

export const DEFAULT_TODO_REMINDER_CONFIG: TodoReminderConfig = {
  turnsSinceWrite: 6,         // QQ 对话比 IDE 短，从 10 降到 6
  turnsBetweenReminders: 6,
}

/**
 * Plan Mode 的状态记录
 */
export interface PlanState {
  /** 是否处于 plan mode */
  inPlanMode: boolean
  /** 进入时间戳（用于超时回退到 default） */
  enteredAt?: number
  /** 已生成的方案文本（ExitPlanMode 时填充） */
  pendingPlan?: string
  /** 用户是否已批准 */
  planApproved?: boolean
}

/**
 * 核验请求的结果
 */
export interface VerificationResult {
  /** 总体判断 */
  verdict: 'PASS' | 'PARTIAL' | 'FAIL'
  /** 检查项 */
  checks: VerificationCheck[]
  /** 总结 */
  summary: string
}

export interface VerificationCheck {
  item: string                   // 对应原 todo 项
  passed: boolean
  evidence: string               // 实际命令输出或观察证据
}
