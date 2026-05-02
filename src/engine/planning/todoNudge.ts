import type { TodoList, TodoWriteResult } from './planningTypes.js'

/**
 * 判定一次 TodoWrite 调用后是否应该追加 verification nudge
 *
 * - 主 agent（不是子 agent）
 * - 列表长度 >= 3
 * - 全部完成
 * - 没有任何一项内容包含 "verif"
 */
export function shouldNudgeVerification(
  newTodos: TodoList,
  isSubAgent: boolean,
): boolean {
  if (isSubAgent) return false
  if (newTodos.length < 3) return false

  const allDone = newTodos.every(t => t.status === 'completed')
  if (!allDone) return false

  const hasVerifyStep = newTodos.some(t =>
    /verif|核验|验证|检查|测试/i.test(t.content + ' ' + t.activeForm),
  )
  if (hasVerifyStep) return false

  return true
}

/**
 * 生成 nudge 的文本内容
 *
 * "NOTE: You just closed out 3+ tasks and none of them was a verification step.
 *  Before writing your final summary, spawn the verification agent...
 *  You cannot self-assign PARTIAL by listing caveats in your summary —
 *  only the verifier issues a verdict."
 */
export function buildVerificationNudge(): string {
  return `

NOTE: 你刚刚关闭了 3 项以上任务，但没有任何一项是核验步骤。在写最终总结之前，请调用 verify_task 工具进行一次核验。

你不能在总结里列一堆"但是"来给自己打 PARTIAL —— 只有核验工具能给出最终判定。`
}

/**
 * 渲染 TodoWrite 工具的完整回执
 *
 */
export function renderTodoWriteResult(result: TodoWriteResult): string {
  const base = '任务清单已更新成功。请继续使用 todo_write 跟踪进度，并按当前的 in_progress 项推进。'
  const nudge = result.verificationNudgeNeeded ? buildVerificationNudge() : ''
  return base + nudge
}
