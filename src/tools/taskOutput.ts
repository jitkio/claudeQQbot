import type { ToolDef } from '../engine/types.js'
import type { TaskManager } from '../engine/tasks/taskManager.js'

export function taskOutputTool(
  manager: TaskManager,
  getUserId: () => string,
): ToolDef {
  return {
    name: 'task_output',
    isReadOnly: true,
    isConcurrencySafe: true,
    description: [
      '获取后台任务的完整最终输出。',
      '只能在任务终止后（done/failed/timeout/stopped）调用。',
      '对运行中任务调用会返回错误——运行中请用 task_get 查看当前状态。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID' },
        max_chars: {
          type: 'number',
          description: '最多返回多少字符（截断），默认 8000',
        },
      },
      required: ['task_id'],
    },
    async execute(args, _ctx) {
      const taskId = String(args.task_id ?? '').trim()
      if (!taskId) return '[错误] task_id 不能为空'

      const maxChars = typeof args.max_chars === 'number'
        ? Math.max(500, Math.min(50000, args.max_chars))
        : 8000

      const record = manager.get(taskId)
      if (!record) return `[错误] 任务 ${taskId} 不存在`

      const userId = getUserId()
      if (record.userId !== userId) return `[错误] 任务 ${taskId} 不是你的`

      if (record.status === 'pending') return `[状态] 任务还在排队中，尚未开始运行`
      if (record.status === 'running') {
        const runMs = record.startedAt ? Date.now() - record.startedAt : 0
        return `[状态] 任务还在运行中（已运行 ${Math.round(runMs / 1000)} 秒）。完成后再调用 task_output 获取结果。`
      }

      // 终止状态
      const parts: string[] = []
      parts.push(`任务 ${record.id} 最终输出 (状态: ${record.status})`)
      parts.push('─'.repeat(40))

      if (record.result?.content) {
        let content = record.result.content
        if (content.length > maxChars) {
          content = content.slice(0, maxChars) + `\n\n…[内容被截断，原长 ${record.result.content.length} 字符，增大 max_chars 可看更多]`
        }
        parts.push(content)
      } else if (record.error) {
        parts.push(`❌ 错误: ${record.error}`)
      } else {
        parts.push('(无输出内容)')
      }

      if (record.result) {
        parts.push('─'.repeat(40))
        parts.push(`工具调用 ${record.result.toolCallCount} 次，对话 ${record.result.turnCount} 轮`)
      }

      return parts.join('\n')
    },
  }
}