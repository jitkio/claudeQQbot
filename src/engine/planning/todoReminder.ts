import type { TodoList, TodoReminderConfig } from './planningTypes.js'
import { DEFAULT_TODO_REMINDER_CONFIG } from './planningTypes.js'

/**
 * 判定是否应该在当前轮注入 todo reminder
 *
 * 参照 $CC/utils/attachments.ts 第 3300-3303 行的判定条件：
 *   turnsSinceLastTodoWrite >= TURNS_SINCE_WRITE
 *   AND turnsSinceLastReminder >= TURNS_BETWEEN_REMINDERS
 *
 * 在 AgentForge 的实现里，"turn"指的是 agentEngine.runAgent 的一轮内部循环，
 * 而不是用户的一次发言。每次 adapter.chat 算一轮。
 */
export class TodoReminderTracker {
  private config: TodoReminderConfig
  private turnsSinceLastTodoWrite = 0
  private turnsSinceLastReminder = 0
  private hasInitialized = false

  constructor(config?: Partial<TodoReminderConfig>) {
    this.config = { ...DEFAULT_TODO_REMINDER_CONFIG, ...config }
  }

  /** 每轮 agentEngine 循环开始时调用 */
  onTurnStart(): void {
    this.turnsSinceLastTodoWrite++
    this.turnsSinceLastReminder++
  }

  /** 模型在本轮调用了 TodoWriteTool —— 重置 write 计数器 */
  onTodoWriteCalled(): void {
    this.turnsSinceLastTodoWrite = 0
    this.hasInitialized = true
  }

  /** 已经在本轮注入 reminder —— 重置 reminder 计数器 */
  onReminderInjected(): void {
    this.turnsSinceLastReminder = 0
  }

  /**
   * 当前是否应该注入 reminder
   *
   * 严格参照 $CC/utils/attachments.ts 第 3300-3303 行
   */
  shouldInject(currentTodos: TodoList): boolean {
    // 没有任何 todo → 不需要 reminder
    if (currentTodos.length === 0) return false

    // 全部完成 → 不需要 reminder
    if (currentTodos.every(t => t.status === 'completed')) return false

    // 模型从未调用过 TodoWrite → 不需要（还没开始用清单）
    if (!this.hasInitialized) return false

    // 双阈值判定
    return (
      this.turnsSinceLastTodoWrite >= this.config.turnsSinceWrite &&
      this.turnsSinceLastReminder >= this.config.turnsBetweenReminders
    )
  }

  /** 生成要注入的 reminder 文本 */
  buildReminder(currentTodos: TodoList, render: (t: TodoList) => string): string {
    return `<system-reminder>
你已经超过 ${this.config.turnsSinceWrite} 轮没有更新任务清单了。请记住当前的待办事项：

${render(currentTodos)}

如果情况有变化，请调用 todo_write 工具更新清单。继续推进当前的 in_progress 项。
</system-reminder>`
  }
}
