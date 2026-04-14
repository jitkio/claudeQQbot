import type { ToolDef } from '../engine/types.js'
import type { TaskManager } from '../engine/tasks/taskManager.js'
import { isTerminal } from '../engine/tasks/taskTypes.js'

export function taskListTool(
  manager: TaskManager,
  getUserId: () => string,
): ToolDef {
  return {
    name: 'task_list',
    isReadOnly: true,
    isConcurrencySafe: true,
    description: [
      '列出当前用户的所有后台任务。按创建时间倒序。',
      '默认只显示活跃任务（pending/running），用 include_finished=true 可以一起显示已完成的。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        include_finished: {
          type: 'boolean',
          description: '是否包含已终止的任务（done/failed/stopped/timeout），默认 false',
        },
        limit: {
          type: 'number',
          description: '最多返回多少条，默认 20',
        },
      },
    },
    async execute(args, _ctx) {
      const userId = getUserId()
      const includeFinished = Boolean(args.include_finished)
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(100, args.limit)) : 20

      let all = manager.listByUser(userId)
      if (!includeFinished) {
        all = all.filter(t => !isTerminal(t.status))
      }

      if (all.length === 0) {
        return includeFinished
          ? '(你目前没有任何后台任务)'
          : '(你没有活跃的后台任务；用 include_finished=true 可以查看历史)'
      }

      const shown = all.slice(0, limit)
      const lines: string[] = []
      const activeCount = all.filter(t => !isTerminal(t.status)).length
      lines.push(`你的后台任务（共 ${all.length} 个${includeFinished ? '' : '活跃'}，其中 ${activeCount} 个未完成）:`)
      lines.push('')

      for (const t of shown) {
        const icon = statusIcon(t.status)
        const title = t.title ?? t.description.slice(0, 40).replace(/\n/g, ' ')
        const age = humanAge(Date.now() - t.createdAt)
        lines.push(`${icon} ${t.id}  ${title}`)
        lines.push(`    创建 ${age}前` + (t.status === 'running' && t.startedAt
          ? `，已运行 ${humanAge(Date.now() - t.startedAt)}`
          : ''))
      }

      if (all.length > limit) {
        lines.push('')
        lines.push(`...还有 ${all.length - limit} 个未显示，调大 limit 或用 task_get 查具体任务`)
      }

      return lines.join('\n')
    },
  }
}

function statusIcon(s: string): string {
  return {
    pending: '⏳',
    running: '🔄',
    done: '✅',
    failed: '❌',
    stopped: '🛑',
    timeout: '⏱',
  }[s] ?? '❔'
}

function humanAge(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时`
  return `${Math.floor(hr / 24)}天`
}