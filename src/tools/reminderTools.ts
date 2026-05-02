/**
 * 提醒系统的 LLM 工具定义
 *
 * 把 reminder 系统暴露给 LLM 调用，让 LLM 能：
 * - 创建任务
 * - 列出任务
 * - 标记完成
 * - 推迟
 * - 取消
 * - 修改
 *
 * 这些工具内部通过 createRequire 调用 reminder/api/taskService.cjs
 */
import type { ToolDef, ToolContext } from '../engine/types.js'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

// 懒加载 taskService，避免 ESM 启动时出问题
let _taskSvc: any = null
let _tasksRepo: any = null
function getSvc() {
  if (!_taskSvc) _taskSvc = require('../reminder/api/taskService.cjs')
  return _taskSvc
}
function getRepo() {
  if (!_tasksRepo) _tasksRepo = require('../reminder/db/tasksRepo.cjs')
  return _tasksRepo
}

// 从 ctx 里提取 ownerOpenId
function getOwnerId(ctx: ToolContext): string {
  const userId = ctx.userId || ''
  // userId 可能是 QQ openid (c2c 场景)
  // 如果不是标准的 openid 格式，尝试 config.OWNER_OPEN_ID 兜底
  if (userId && userId.length >= 30) return userId
  try {
    const cfg = require('../reminder/config.cjs')
    return cfg.OWNER_OPEN_ID || userId
  } catch {
    return userId
  }
}

// 时间解析（复用 commandHandler 的逻辑）
function parseTime(str: string): number | null {
  if (!str) return null
  str = String(str).trim()

  // 相对 2m/30m/2h/1d
  const rel = str.match(/^(\d+)(s|m|h|d)$/i)
  if (rel) {
    const n = parseInt(rel[1], 10)
    const mult = ({ s: 1000, m: 60000, h: 3600000, d: 86400000 } as any)[rel[2].toLowerCase()]
    return Date.now() + n * mult
  }

  // 明天/今天 HH:MM
  const tom = str.match(/^(明天|tomorrow)\s*(\d{1,2}):(\d{2})$/i)
  if (tom) {
    const d = new Date(); d.setDate(d.getDate() + 1)
    d.setHours(parseInt(tom[2]), parseInt(tom[3]), 0, 0)
    return d.getTime()
  }
  const tod = str.match(/^(今天|today)\s*(\d{1,2}):(\d{2})$/i)
  if (tod) {
    const d = new Date()
    d.setHours(parseInt(tod[2]), parseInt(tod[3]), 0, 0)
    return d.getTime()
  }

  // 纯 HH:MM
  const hm = str.match(/^(\d{1,2}):(\d{2})$/)
  if (hm) {
    const d = new Date()
    d.setHours(parseInt(hm[1]), parseInt(hm[2]), 0, 0)
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
    return d.getTime()
  }

  // ISO 8601 或 YYYY-MM-DD [HH:MM]
  const iso = Date.parse(str)
  if (!Number.isNaN(iso)) return iso

  const date = str.match(/^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (date) {
    const now = new Date()
    const d = new Date(now.getFullYear(), parseInt(date[1]) - 1, parseInt(date[2]))
    d.setHours(date[3] ? parseInt(date[3]) : 9, date[4] ? parseInt(date[4]) : 0, 0, 0)
    if (d.getTime() < now.getTime() - 86400000) d.setFullYear(d.getFullYear() + 1)
    return d.getTime()
  }

  return null
}

function formatCN(ts: number | null | undefined): string {
  if (!ts) return ''
  const { formatCN: f } = require('../reminder/utils/time.cjs')
  return f(ts)
}

// ============================================================
// Tool 1: reminder_create
// ============================================================
export const reminderCreateTool: ToolDef = {
  name: 'reminder_create',
  description: `创建一个提醒/任务。当用户说"提醒我..."、"明天X点做...""下周三要...""每天..."等有时间感的请求时使用。

类型说明：
- once: 一次性提醒（"明天3点开会"）
- daily: 每日定时提醒（"每天7点叫我起床"）
- deadline: 有截止日期的任务（"下周五前交论文"，会越接近截止提醒越频繁）
- periodic: 周期任务（"每周锻炼3次"）
- todo: 无时间的待办（"记一下要买生日礼物"）

时间格式支持：
- 相对: 2m / 30m / 2h / 1d
- 绝对: 15:00 / 明天15:00 / 今天15:00
- 日期: 2026-05-01 / 05-01 / 2026-05-01 15:00`,

  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '任务标题，简短清晰' },
      type: { type: 'string', enum: ['once', 'daily', 'deadline', 'periodic', 'todo'], description: '任务类型' },
      time: { type: 'string', description: '时间字符串。once/deadline 传具体时间；daily/periodic 传 HH:MM；todo 可空' },
      description: { type: 'string', description: '附加描述，可选' },
      priority: { type: 'string', enum: ['high', 'normal', 'low'], description: '优先级，默认 normal' },
      category: { type: 'string', description: '分类标签，如 工作/学习/生活' },
      targetCount: { type: 'integer', description: 'periodic 的每周次数，如每周3次传 3' },
    },
    required: ['title', 'type'],
  },

  isReadOnly: false,
  isConcurrencySafe: false,

  execute: async (input, ctx) => {
    const ownerOpenId = getOwnerId(ctx)
    if (!ownerOpenId) return '[reminder_create 错误] 未识别到用户 ID'

    const { title, type, time, description, priority, category, targetCount } = input
    const svc = getSvc()

    try {
      const opts: any = {
        ownerOpenId, title, type,
        description: description || null,
        priority: priority || 'normal',
        category: category || null,
      }

      if (type === 'once') {
        const ts = parseTime(time)
        if (!ts) return `[reminder_create 错误] 无法解析时间: "${time}"`
        if (ts <= Date.now()) return `[reminder_create 错误] 时间必须在未来`
        opts.remindAt = ts
      } else if (type === 'deadline') {
        const ts = parseTime(time)
        if (!ts) return `[reminder_create 错误] 无法解析截止时间: "${time}"`
        opts.dueAt = ts
      } else if (type === 'daily' || type === 'periodic') {
        const hm = String(time || '').match(/^(\d{1,2}):(\d{2})$/)
        if (!hm) return `[reminder_create 错误] ${type} 的时间必须是 HH:MM 格式`
        opts.remindRule = { hour: parseInt(hm[1]), minute: parseInt(hm[2]) }
        if (type === 'periodic') {
          if (!targetCount || targetCount < 1) return '[reminder_create 错误] periodic 需要 targetCount >= 1'
          opts.targetCount = targetCount
          opts.targetPeriod = 'week'
        }
      }

      const task = await svc.create(opts)

      // 返回给 LLM 看的结果
      let result = `✓ 已创建 ${task.id}\n标题: ${task.title}\n类型: ${task.type}`
      if (task.remind_at) result += `\n下次提醒: ${formatCN(task.remind_at)}`
      if (task.due_at) result += `\n截止: ${formatCN(task.due_at)}`
      return result
    } catch (e: any) {
      return `[reminder_create 错误] ${e?.message || e}`
    }
  },
}

// ============================================================
// Tool 2: reminder_list
// ============================================================
export const reminderListTool: ToolDef = {
  name: 'reminder_list',
  description: `列出用户的任务/提醒。当用户问"我有什么任务""列一下待办""最近要做什么"时使用。

filter 可选:
- active (默认): 仅进行中的
- done: 已完成的
- all: 所有状态
- overdue: 逾期
- shelved: 已搁置的（7 天未打卡）`,

  parameters: {
    type: 'object',
    properties: {
      filter: { type: 'string', enum: ['active', 'done', 'all', 'overdue', 'shelved'], description: '筛选条件，默认 active' },
      limit: { type: 'integer', description: '最多返回多少条，默认 30' },
    },
  },

  isReadOnly: true,
  isConcurrencySafe: true,

  execute: async (input, ctx) => {
    const ownerOpenId = getOwnerId(ctx)
    if (!ownerOpenId) return '[reminder_list 错误] 未识别到用户 ID'

    const filter = input.filter || 'active'
    const limit = input.limit || 30
    const svc = getSvc()

    let tasks: any[]
    if (filter === 'all') tasks = svc.listAll(ownerOpenId, { limit })
    else if (filter === 'active') tasks = svc.listActive(ownerOpenId)
    else tasks = svc.listByStatus(ownerOpenId, filter).slice(0, limit)

    if (tasks.length === 0) return '(当前没有任务)'

    // 用 JSON 返回给 LLM，LLM 自己加工成自然语言
    const simplified = tasks.map((t: any) => ({
      id: t.id,
      title: t.title,
      type: t.type,
      status: t.status,
      category: t.category,
      priority: t.priority,
      dueAt: t.dueAtDisplay || null,
      remindAt: t.remindAtDisplay || null,
      progress: t.progressBar || null,
      checkinStreak: t.checkinStreak || null,
    }))
    return JSON.stringify({ count: tasks.length, tasks: simplified }, null, 2)
  },
}

// ============================================================
// Tool 3: reminder_complete
// ============================================================
export const reminderCompleteTool: ToolDef = {
  name: 'reminder_complete',
  description: `标记任务完成。对持续任务(daily/periodic)则是打卡 +1。

使用场景：用户说"X 做完了""我完成了 X""X 打卡了"等。

⚠️ 必须流程：先调用 reminder_list(filter=active) 拿到所有任务，按标题匹配找到目标任务的 id，再调用本工具。
绝不要让用户告诉你 ID —— 用户记不住 ID。
如果 list 后发现有多条同名任务，才反问用户是哪一条。`,

  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '任务 ID，如 tk_abc123' },
      note: { type: 'string', description: '完成备注，可选（如"今天跑了5km"）' },
    },
    required: ['taskId'],
  },

  isReadOnly: false,
  isConcurrencySafe: false,

  execute: async (input, ctx) => {
    const ownerOpenId = getOwnerId(ctx)
    const { taskId, note } = input
    const repo = getRepo()
    const task = repo.get(taskId)
    if (!task) return `[reminder_complete 错误] 找不到任务 ${taskId}`
    if (task.owner_open_id !== ownerOpenId) return '[reminder_complete 错误] 这不是该用户的任务'

    try {
      const updated = await getSvc().complete(taskId, { note })
      if (task.type === 'daily' || task.type === 'periodic') {
        return `✓ 打卡成功 ${taskId}  进度: ${updated.progress_count}/${updated.target_count || '-'}`
      }
      return `✓ 已完成 ${taskId}`
    } catch (e: any) {
      return `[reminder_complete 错误] ${e?.message || e}`
    }
  },
}

// ============================================================
// Tool 4: reminder_snooze
// ============================================================
export const reminderSnoozeTool: ToolDef = {
  name: 'reminder_snooze',
  description: `推迟某个提醒。用户说"等会再提醒我""推迟 30 分钟""晚点再说"等用到。

delay 格式: 30m / 2h / 1d`,
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '任务 ID' },
      delay: { type: 'string', description: '推迟时长，如 30m/2h/1d' },
    },
    required: ['taskId', 'delay'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,

  execute: async (input, ctx) => {
    const ownerOpenId = getOwnerId(ctx)
    const { taskId, delay } = input
    const repo = getRepo()
    const task = repo.get(taskId)
    if (!task) return `[reminder_snooze 错误] 找不到任务 ${taskId}`
    if (task.owner_open_id !== ownerOpenId) return '[reminder_snooze 错误] 这不是该用户的任务'

    const m = String(delay).match(/^(\d+)(m|h|d)$/i)
    if (!m) return `[reminder_snooze 错误] 无法解析时长: "${delay}"`
    const ms = parseInt(m[1]) * ({ m: 60000, h: 3600000, d: 86400000 } as any)[m[2].toLowerCase()]

    try {
      const r = await getSvc().snooze(taskId, ms)
      return `✓ 已推迟 ${taskId}  下次提醒: ${formatCN(r.fireAt)}`
    } catch (e: any) {
      return `[reminder_snooze 错误] ${e?.message || e}`
    }
  },
}

// ============================================================
// Tool 5: reminder_cancel
// ============================================================
export const reminderCancelTool: ToolDef = {
  name: 'reminder_cancel',
  description: `取消一个任务。用户说"X 不去了/X 取消/不做了/算了 X"等触发。

⚠️ 必须流程：
1. 先调 reminder_list(filter=active) 找到 title 匹配的任务 id
2. 直接调用本工具取消（不要让用户报 ID）
3. 如果 list 返回多条匹配，才反问用户是哪条

注意区分：
- "X 做完了" → reminder_complete (这件事做了)
- "X 不去了/不做了/取消" → reminder_cancel (这件事不做了)`,
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '任务 ID' },
    },
    required: ['taskId'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,

  execute: async (input, ctx) => {
    const ownerOpenId = getOwnerId(ctx)
    const { taskId } = input
    const repo = getRepo()
    const task = repo.get(taskId)
    if (!task) return `[reminder_cancel 错误] 找不到任务 ${taskId}`
    if (task.owner_open_id !== ownerOpenId) return '[reminder_cancel 错误] 这不是该用户的任务'

    if (task.status === 'cancelled') return `(任务 ${taskId} 已经是取消状态)`

    try {
      // 即使是 done 状态也允许改成 cancelled（修正 LLM 误把"取消"当"完成"的情况）
      const wasDone = task.status === 'done'
      await getSvc().cancel(taskId)
      if (wasDone) return `✓ 已从"完成"改为"取消" ${taskId}  标题: ${task.title}`
      return `✓ 已取消 ${taskId}  标题: ${task.title}`
    } catch (e: any) {
      return `[reminder_cancel 错误] ${e?.message || e}`
    }
  },
}

// ============================================================
// Tool 6: reminder_update
// ============================================================
export const reminderUpdateTool: ToolDef = {
  name: 'reminder_update',
  description: `修改任务的标题、时间、优先级、分类等。

⚠️ 必须流程：
1. 先调 reminder_list 找到目标任务 id
2. 描述要修改的内容向用户确认（用户要求过修改要确认）
3. 用户确认后才调用本工具

支持字段：title, description, time (重算 remind_at 或 due_at), priority, category, targetCount`,
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '任务 ID' },
      title: { type: 'string' },
      description: { type: 'string' },
      time: { type: 'string', description: '新的时间 / 截止日期' },
      priority: { type: 'string', enum: ['high', 'normal', 'low'] },
      category: { type: 'string' },
      targetCount: { type: 'integer' },
    },
    required: ['taskId'],
  },
  isReadOnly: false,
  isConcurrencySafe: false,

  execute: async (input, ctx) => {
    const ownerOpenId = getOwnerId(ctx)
    const { taskId, title, description, time, priority, category, targetCount } = input
    const repo = getRepo()
    const task = repo.get(taskId)
    if (!task) return `[reminder_update 错误] 找不到任务 ${taskId}`
    if (task.owner_open_id !== ownerOpenId) return '[reminder_update 错误] 这不是该用户的任务'

    const fields: any = {}
    if (title !== undefined) fields.title = title
    if (description !== undefined) fields.description = description
    if (priority !== undefined) fields.priority = priority
    if (category !== undefined) fields.category = category
    if (targetCount !== undefined) fields.target_count = targetCount

    // 时间更新
    if (time !== undefined) {
      const ts = parseTime(time)
      if (!ts) return `[reminder_update 错误] 无法解析时间: "${time}"`
      if (task.type === 'deadline') fields.due_at = ts
      else fields.remind_at = ts
    }

    if (Object.keys(fields).length === 0) return '[reminder_update 错误] 没有任何要修改的字段'

    try {
      const updated = await getSvc().update(taskId, fields)
      let result = `✓ 已更新 ${taskId}`
      for (const k of Object.keys(fields)) {
        result += `\n  ${k}: ${typeof fields[k] === 'number' && fields[k] > 1e10 ? formatCN(fields[k]) : fields[k]}`
      }
      return result
    } catch (e: any) {
      return `[reminder_update 错误] ${e?.message || e}`
    }
  },
}

// 所有工具汇总导出
export const reminderTools: ToolDef[] = [
  reminderCreateTool,
  reminderListTool,
  reminderCompleteTool,
  reminderSnoozeTool,
  reminderCancelTool,
  reminderUpdateTool,
]
