import type { ToolDef } from '../engine/types.js'
import type { TaskManager } from '../engine/tasks/taskManager.js'

export function taskUpdateTool(
  manager: TaskManager,
  getUserId: () => string,
): ToolDef {
  return {
    name: 'task_update',
    isReadOnly: false,
    isConcurrencySafe: false,
    description: [
      '给一个后台任务追加额外指令。',
      '',
      '重要说明:',
      '- 如果任务处于 pending (排队中)：追加的指令会在真正启动时合并进 prompt',
      '- 如果任务处于 running (运行中)：追加的指令会被记录下来，但子 Agent 已经在它自己的对话循环里了——当前这次运行看不到新指令。',
      '  如果需要 running 中的任务立刻响应新指令，应该先 task_stop 再用新的 task_create 重新发起',
      '- 已终止的任务不能更新',
      '',
      '典型场景: 用户在排队等待时改主意，追加"顺便也处理一下 X"',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID' },
        instruction: { type: 'string', description: '要追加的额外指令' },
      },
      required: ['task_id', 'instruction'],
    },
    async execute(args, _ctx) {
      const taskId = String(args.task_id ?? '').trim()
      const instruction = String(args.instruction ?? '').trim()
      if (!taskId) return '[错误] task_id 不能为空'
      if (!instruction) return '[错误] instruction 不能为空'
      if (instruction.length > 2000) return '[错误] instruction 太长（上限 2000 字）'

      const userId = getUserId()
      const result = manager.update(taskId, userId, instruction)
      if (!result.ok) return `[错误] ${result.reason}`

      const record = manager.get(taskId)
      const warning = record?.status === 'running'
        ? '\n⚠ 注意: 任务正在运行中，此指令已记录但当前这次运行看不到。如需立即生效请先 task_stop 再重新 task_create。'
        : ''

      return `已为任务 ${taskId} 追加指令：${instruction.slice(0, 80)}${instruction.length > 80 ? '…' : ''}${warning}`
    },
  }
}