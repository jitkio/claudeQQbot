import type { ToolDef } from '../engine/types.js'
import type { TaskManager } from '../engine/tasks/taskManager.js'

export function taskGetTool(
  manager: TaskManager,
  getUserId: () => string,
): ToolDef {
  return {
    name: 'task_get',
    isReadOnly: true,
    isConcurrencySafe: true,
    description: '查询某个后台任务的当前状态。返回状态、运行时长、错误信息等元数据。完整输出用 task_output。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID（形如 task_abcd1234）' },
      },
      required: ['task_id'],
    },
    async execute(args, _ctx) {
      const taskId = String(args.task_id ?? '').trim()
      if (!taskId) return '[错误] task_id 不能为空'

      const record = manager.get(taskId)
      if (!record) return `[错误] 任务 ${taskId} 不存在（可能已被清理）`

      const userId = getUserId()
      if (record.userId !== userId) {
        return `[错误] 任务 ${taskId} 不是你创建的，无权查看`
      }

      const lines: string[] = []
      lines.push(`任务 ${record.id}`)
      if (record.title) lines.push(`  标题: ${record.title}`)
      lines.push(`  状态: ${formatStatus(record.status)}`)
      lines.push(`  描述: ${record.description.slice(0, 120)}${record.description.length > 120 ? '…' : ''}`)
      lines.push(`  创建于: ${formatTime(record.createdAt)}`)

      if (record.startedAt) {
        const runMs = (record.finishedAt ?? Date.now()) - record.startedAt
        lines.push(`  运行时长: ${formatDuration(runMs)}`)
      }

      if (record.pendingUpdates.length > 0) {
        lines.push(`  待合并指令: ${record.pendingUpdates.length} 条`)
      }

      if (record.status === 'done' && record.result) {
        lines.push(`  工具调用次数: ${record.result.toolCallCount}`)
        lines.push(`  对话轮数: ${record.result.turnCount}`)
        lines.push('')
        lines.push(`结果预览（前 500 字，完整内容用 task_output）:`)
        lines.push(record.result.content.slice(0, 500))
        if (record.result.content.length > 500) lines.push('…')
      }

      if ((record.status === 'failed' || record.status === 'timeout' || record.status === 'stopped') && record.error) {
        lines.push('')
        lines.push(`错误: ${record.error}`)
      }

      return lines.join('\n')
    },
  }
}

function formatStatus(s: string): string {
  const map: Record<string, string> = {
    pending: '⏳ 排队中',
    running: '🔄 运行中',
    done: '✅ 已完成',
    failed: '❌ 失败',
    stopped: '🛑 已停止',
    timeout: '⏱ 超时',
  }
  return map[s] ?? s
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return `${min}m${remSec}s`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return `${hr}h${remMin}m`
}