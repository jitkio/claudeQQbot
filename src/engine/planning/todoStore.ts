import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import type { TodoList, TodoItem } from './planningTypes.js'
import { safeSessionKey } from '../utils/sessionKey.js'

/**
 * TodoList 的会话级存储
 *
 * 每个 sessionKey 一个 JSON 文件，存放当前的 todo 列表。
 * 全部任务完成时，文件内容清空（参照 $CC/tools/TodoWriteTool/TodoWriteTool.ts 第 69-70 行 allDone 处理）。
 */
export class TodoStore {
  private baseDir: string

  constructor(baseDir: string) {
    this.baseDir = `${baseDir}/todos`
    mkdirSync(this.baseDir, { recursive: true })
  }

  private pathFor(sessionKey: string): string {
    return `${this.baseDir}/${safeSessionKey(sessionKey)}.json`
  }

  /** 读取当前会话的 todo list */
  get(sessionKey: string): TodoList {
    const p = this.pathFor(sessionKey)
    if (!existsSync(p)) return []
    try {
      const raw = readFileSync(p, 'utf-8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /**
   * 覆盖式写入 —— 这是 TodoWrite 的核心语义：
   * 模型每次调用都传一份完整的列表，旧列表被新列表替换。
   *
   * 参照 $CC/tools/TodoWriteTool/TodoWriteTool.ts 第 88-94 行：
   *   context.setAppState(prev => ({ ...prev, todos: { [todoKey]: newTodos } }))
   */
  set(sessionKey: string, todos: TodoList): void {
    // 全部完成 → 清空（视为这一段任务结束）
    // 参照 $CC/tools/TodoWriteTool/TodoWriteTool.ts 第 69-70 行 allDone 逻辑
    const allDone = todos.length > 0 && todos.every(t => t.status === 'completed')
    const toSave = allDone ? [] : todos

    writeFileSync(this.pathFor(sessionKey), JSON.stringify(toSave, null, 2))
  }

  /** 清空（用户发 /new 时调用） */
  clear(sessionKey: string): void {
    writeFileSync(this.pathFor(sessionKey), '[]')
  }

  /**
   * 校验 todo 列表的状态约束
   *
   * 严格参照 $CC/tools/TodoWriteTool/prompt.ts 第 156-159 行的状态管理规则：
   * "Exactly ONE task must be in_progress at any time (not less, not more)"
   *
   * 但如果列表为空或全部完成，则放宽（无 in_progress 也可）
   */
  validate(todos: TodoList): { valid: boolean; reason?: string } {
    if (todos.length === 0) return { valid: true }

    const inProgress = todos.filter(t => t.status === 'in_progress')
    const allCompleted = todos.every(t => t.status === 'completed')

    if (allCompleted) return { valid: true }

    if (inProgress.length === 0) {
      return {
        valid: false,
        reason: '至少要有一项 in_progress（除非全部完成）',
      }
    }
    if (inProgress.length > 1) {
      return {
        valid: false,
        reason: `同时只能有 1 项 in_progress，目前有 ${inProgress.length} 项`,
      }
    }

    // 检查必填字段
    for (const t of todos) {
      if (!t.content?.trim()) return { valid: false, reason: '所有 todo 必须有 content' }
      if (!t.activeForm?.trim()) return { valid: false, reason: '所有 todo 必须有 activeForm' }
    }

    return { valid: true }
  }

  /** 渲染为人类可读的清单文本（用于 reminder 注入和 /todos 命令） */
  render(todos: TodoList): string {
    if (todos.length === 0) return '（无待办）'

    const symbols: Record<string, string> = {
      pending: '[ ]',
      in_progress: '[..]',
      completed: '[OK]',
    }

    return todos
      .map((t, i) => {
        const sym = symbols[t.status] ?? '[ ]'
        const text = t.status === 'in_progress' ? t.activeForm : t.content
        return `${sym} ${i + 1}. ${text}`
      })
      .join('\n')
  }
}
