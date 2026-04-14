import type { ToolDef } from '../engine/types.js'
import type { TaskManager } from '../engine/tasks/taskManager.js'

export function taskStopTool(
  manager: TaskManager,
  getUserId: () => string,
): ToolDef {
  return {
    name: 'task_stop',
    isReadOnly: false,
    isConcurrencySafe: false,
    description: [
      '停止一个正在运行或排队的后台任务。',
      '任务会被级联取消——如果正在跑某个工具（比如 bash 命令），那个工具也会被中断。',
      '已终止的任务不能再停止。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '要停止的任务 ID' },
      },
      required: ['task_id'],
    },
    async execute(args, _ctx) {
      const taskId = String(args.task_id ?? '').trim()
      if (!taskId) return '[错误] task_id 不能为空'

      const userId = getUserId()
      const result = manager.stop(taskId, userId)
      if (!result.ok) return `[错误] ${result.reason}`

      return `🛑 任务 ${taskId} 已停止`
    },
  }
}