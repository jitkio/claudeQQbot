/**
 * Reminder 命令处理器
 * 支持的命令：
 *   /remind once  <时间> <标题>       一次性提醒
 *   /remind daily <时间> <标题>       每日提醒 (时间=HH:MM)
 *   /remind deadline <日期> <标题>     截止日期任务
 *   /remind todo  <标题>              无提醒的 TODO
 *   /done <tk_xxx> [备注]             完成（持续任务=打卡）
 *   /snooze <时长> <tk_xxx>           推迟 (30m/2h/1d)
 *   /cancel <tk_xxx>                  取消
 *   /list [active|done|all]           列表
 *   /stats                            统计
 *   /help                             命令帮助
 *
 * 时间格式支持：
 *   相对时间: 2m / 30m / 2h / 1d
 *   绝对时间: 15:00 / 明天15:00 / tomorrow 15:00
 *   日期:     2026-05-01 / 05-01
 */
const taskSvc = require('../api/taskService.cjs')
const tasksRepo = require('../db/tasksRepo.cjs')
const { formatCN } = require('../utils/time.cjs')
const { createLogger } = require('../utils/logger.cjs')
const config = require('../config.cjs')

const log = createLogger('cmd')

// --- 时间解析 ---
function parseTime(str) {
  if (!str) return null
  str = str.trim()

  // 相对时间: 2m, 30m, 2h, 1d, 30s
  const rel = str.match(/^(\d+)(s|m|h|d)$/i)
  if (rel) {
    const n = parseInt(rel[1], 10)
    const unit = rel[2].toLowerCase()
    const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit]
    return Date.now() + n * mult
  }

  // 明天 HH:MM / tomorrow HH:MM
  const tom = str.match(/^(明天|tomorrow)\s*(\d{1,2}):(\d{2})$/i)
  if (tom) {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(parseInt(tom[2]), parseInt(tom[3]), 0, 0)
    return d.getTime()
  }

  // 今天 HH:MM
  const tod = str.match(/^(今天|today)\s*(\d{1,2}):(\d{2})$/i)
  if (tod) {
    const d = new Date()
    d.setHours(parseInt(tod[2]), parseInt(tod[3]), 0, 0)
    return d.getTime()
  }

  // 纯 HH:MM -> 今天或明天
  const hm = str.match(/^(\d{1,2}):(\d{2})$/)
  if (hm) {
    const d = new Date()
    d.setHours(parseInt(hm[1]), parseInt(hm[2]), 0, 0)
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
    return d.getTime()
  }

  // YYYY-MM-DD [HH:MM]
  const dateFull = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (dateFull) {
    const d = new Date(parseInt(dateFull[1]), parseInt(dateFull[2]) - 1, parseInt(dateFull[3]))
    d.setHours(dateFull[4] ? parseInt(dateFull[4]) : 9, dateFull[5] ? parseInt(dateFull[5]) : 0, 0, 0)
    return d.getTime()
  }

  // MM-DD [HH:MM]
  const dateShort = str.match(/^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/)
  if (dateShort) {
    const now = new Date()
    const d = new Date(now.getFullYear(), parseInt(dateShort[1]) - 1, parseInt(dateShort[2]))
    d.setHours(dateShort[3] ? parseInt(dateShort[3]) : 9, dateShort[4] ? parseInt(dateShort[4]) : 0, 0, 0)
    if (d.getTime() < now.getTime() - 86400000) d.setFullYear(d.getFullYear() + 1)
    return d.getTime()
  }

  return null
}

function parseDuration(str) {
  if (!str) return null
  const m = str.trim().match(/^(\d+)(m|h|d)$/i)
  if (!m) return null
  const n = parseInt(m[1])
  const mult = { m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()]
  return n * mult
}

// --- 命令识别 ---
const CMD_PREFIXES = [
  '/remind', '/done', '/snooze', '/cancel', '/list', '/stats', '/export', '/help',
]

function isReminderCommand(text) {
  if (!text) return false
  const t = text.trim()
  for (const p of CMD_PREFIXES) {
    if (t === p || t.startsWith(p + ' ')) return true
  }
  return false
}

// --- 命令处理器 ---
async function cmdRemind(args, ownerOpenId) {
  if (args.length < 2) return HELP_REMIND
  const sub = args[0].toLowerCase()

  // /remind todo 标题...
  if (sub === 'todo') {
    const title = args.slice(1).join(' ')
    const task = await taskSvc.create({ ownerOpenId, title, type: 'todo' })
    return `✓ TODO 已创建 ${task.id}\n${task.title}\n(不会主动提醒，用 /done 完成)`
  }

  // /remind once <时间> <标题>
  if (sub === 'once') {
    if (args.length < 3) return HELP_REMIND
    const timeStr = args[1]
    const title = args.slice(2).join(' ')
    const remindAt = parseTime(timeStr)
    if (!remindAt) return `❌ 无法解析时间: "${timeStr}"\n支持格式: 2m / 30m / 2h / 15:00 / 明天15:00`
    if (remindAt <= Date.now()) return '❌ 提醒时间必须在未来'
    const task = await taskSvc.create({
      ownerOpenId, title, type: 'once', remindAt,
    })
    return `✓ 一次性提醒已创建 ${task.id}\n${task.title}\n时间: ${formatCN(remindAt)}`
  }

  // /remind daily <HH:MM> <标题>
  if (sub === 'daily') {
    if (args.length < 3) return HELP_REMIND
    const hm = args[1].match(/^(\d{1,2}):(\d{2})$/)
    if (!hm) return '❌ daily 时间必须是 HH:MM 格式，比如 07:30'
    const title = args.slice(2).join(' ')
    const task = await taskSvc.create({
      ownerOpenId, title, type: 'daily',
      remindRule: { hour: parseInt(hm[1]), minute: parseInt(hm[2]) },
    })
    return `✓ 每日提醒已创建 ${task.id}\n${task.title}\n每天 ${args[1]} 提醒`
  }

  // /remind deadline <日期> <标题>
  if (sub === 'deadline') {
    if (args.length < 3) return HELP_REMIND
    const dueAt = parseTime(args[1])
    if (!dueAt) return `❌ 无法解析截止时间: "${args[1]}"`
    if (dueAt <= Date.now()) return '❌ 截止时间必须在未来'
    const title = args.slice(2).join(' ')
    const task = await taskSvc.create({
      ownerOpenId, title, type: 'deadline', dueAt, remindAt: null,
    })
    return `✓ 截止任务已创建 ${task.id}\n${task.title}\n截止: ${formatCN(dueAt)}\n(越接近截止提醒频率越高)`
  }

  // /remind periodic <HH:MM> <每周N次> <标题>
  if (sub === 'periodic') {
    if (args.length < 4) return HELP_REMIND
    const hm = args[1].match(/^(\d{1,2}):(\d{2})$/)
    if (!hm) return '❌ 时间必须是 HH:MM 格式'
    const target = parseInt(args[2])
    if (!target || target < 1) return '❌ 次数必须是正整数'
    const title = args.slice(3).join(' ')
    const task = await taskSvc.create({
      ownerOpenId, title, type: 'periodic',
      remindRule: { hour: parseInt(hm[1]), minute: parseInt(hm[2]) },
      targetCount: target, targetPeriod: 'week',
    })
    return `✓ 周期任务已创建 ${task.id}\n${task.title}\n每周 ${target} 次，每天 ${args[1]} 提醒`
  }

  return HELP_REMIND
}

async function cmdDone(args, ownerOpenId) {
  if (args.length < 1) return '❌ 用法: /done tk_xxx [备注]'
  const taskId = args[0]
  const task = tasksRepo.get(taskId)
  if (!task) return `❌ 找不到任务 ${taskId}`
  if (task.owner_open_id !== ownerOpenId) return '❌ 这不是你的任务'

  const note = args.slice(1).join(' ') || null
  const updated = await taskSvc.complete(taskId, { note })

  if (task.type === 'daily' || task.type === 'periodic') {
    const progress = updated.progress_count || 0
    const target = updated.target_count || '-'
    return `✓ 打卡成功 ${taskId}\n${task.title}\n进度: ${progress}/${target}`
  }
  return `✓ 已完成 ${taskId}\n${task.title}`
}

async function cmdSnooze(args, ownerOpenId) {
  if (args.length < 2) return '❌ 用法: /snooze <时长> <tk_xxx>\n示例: /snooze 30m tk_abc / /snooze 2h tk_abc'
  const delay = parseDuration(args[0])
  if (!delay) return `❌ 无法解析时长: "${args[0]}"`
  const taskId = args[1]
  const task = tasksRepo.get(taskId)
  if (!task) return `❌ 找不到任务 ${taskId}`
  if (task.owner_open_id !== ownerOpenId) return '❌ 这不是你的任务'

  const r = await taskSvc.snooze(taskId, delay)
  return `✓ 已推迟 ${taskId}\n${task.title}\n下次提醒: ${formatCN(r.fireAt)}`
}

async function cmdCancel(args, ownerOpenId) {
  if (args.length < 1) return '❌ 用法: /cancel tk_xxx'
  const taskId = args[0]
  const task = tasksRepo.get(taskId)
  if (!task) return `❌ 找不到任务 ${taskId}`
  if (task.owner_open_id !== ownerOpenId) return '❌ 这不是你的任务'

  await taskSvc.cancel(taskId)
  return `✓ 已取消 ${taskId}\n${task.title}`
}

function cmdList(args, ownerOpenId) {
  const mode = (args[0] || 'active').toLowerCase()

  let tasks = []
  if (mode === 'all') tasks = taskSvc.listAll(ownerOpenId, { limit: 100 })
  else if (mode === 'done') tasks = taskSvc.listByStatus(ownerOpenId, 'done').slice(0, 30)
  else tasks = taskSvc.listActive(ownerOpenId)

  if (tasks.length === 0) return '📋 没有任务\n用 /remind 创建一个'

  // 分组：按 status
  const groups = {
    active: [], done: [], overdue: [], cancelled: [], shelved: [],
  }
  for (const t of tasks) groups[t.status] = groups[t.status] || [], groups[t.status].push(t)

  const lines = [`📋 任务 (${tasks.length})`]

  function fmtTask(t) {
    // 状态图标优先
    const statusIcon = {
      done: '✓', cancelled: '×', overdue: '!', shelved: '💤',
    }[t.status]
    const typeIcon = { once: '○', daily: '▣', deadline: '⚑', periodic: '✎', todo: '◦' }[t.type] || '·'
    const icon = statusIcon || typeIcon
    let line = `${icon} ${t.title}`
    if (t.type === 'deadline' && t.dueAtDisplay) line += ` [截止 ${t.dueAtDisplay}]`
    else if (t.type === 'once' && t.remindAtDisplay) line += ` [${t.remindAtDisplay}]`
    else if (t.type === 'daily' && t.remind_rule) line += ` [每日 ${String(t.remind_rule.hour).padStart(2,'0')}:${String(t.remind_rule.minute || 0).padStart(2,'0')}]`
    else if (t.type === 'periodic' && t.progressBar) line += ` ${t.progressBar}`
    line += ` ${t.id}`
    return line
  }

  if (groups.active.length) {
    lines.push(`\n⏳ 进行中 (${groups.active.length})`)
    groups.active.slice(0, 15).forEach(t => lines.push(fmtTask(t)))
    if (groups.active.length > 15) lines.push(`  (另有 ${groups.active.length - 15} 条)`)
  }
  if (groups.overdue.length) {
    lines.push(`\n⚠️ 逾期 (${groups.overdue.length})`)
    groups.overdue.slice(0, 10).forEach(t => lines.push(fmtTask(t)))
  }
  if (mode !== 'active') {
    if (groups.done.length) {
      lines.push(`\n✅ 已完成 (${groups.done.length})`)
      groups.done.slice(0, 10).forEach(t => lines.push(fmtTask(t)))
    }
    if (groups.shelved.length) {
      lines.push(`\n💤 搁置 (${groups.shelved.length})`)
      groups.shelved.slice(0, 5).forEach(t => lines.push(fmtTask(t)))
    }
    if (groups.cancelled.length) {
      lines.push(`\n× 已取消 (${groups.cancelled.length})`)
    }
  }

  return lines.join('\n')
}

function cmdStats(args, ownerOpenId) {
  const s = taskSvc.stats(ownerOpenId)
  return `📊 任务统计\n` +
    `进行中: ${s.active}\n` +
    `已完成: ${s.done}\n` +
    `逾期: ${s.overdue}\n` +
    `搁置: ${s.shelved}\n` +
    `取消: ${s.cancelled}\n` +
    `总计: ${s.total}`
}

const HELP_REMIND =
`提醒创建用法:
/remind once <时间> <标题>        一次性
/remind daily <HH:MM> <标题>      每日
/remind deadline <日期> <标题>    截止
/remind periodic <HH:MM> <次数> <标题>  周期(每周N次)
/remind todo <标题>              无提醒TODO

时间格式:
- 2m/30m/2h/1d 相对时间
- 15:00 今天/明天
- 明天15:00
- 2026-05-01 / 05-01`

const HELP_ALL =
`📌 提醒系统命令:
/remind ... 创建任务 (发 /remind 查详情)
/done tk_xxx [备注]  完成 (持续任务=打卡)
/snooze 30m tk_xxx   推迟
/cancel tk_xxx       取消
/list [done|all]     列表
/stats               统计
/help                帮助`

// --- 主入口 ---
async function handleCommand(text, ownerOpenId) {
  const t = text.trim()
  const parts = t.split(/\s+/)
  const cmd = parts[0].toLowerCase()
  const args = parts.slice(1)

  try {
    switch (cmd) {
      case '/remind':
        if (args.length === 0) return HELP_REMIND
        return await cmdRemind(args, ownerOpenId)
      case '/done':
        return await cmdDone(args, ownerOpenId)
      case '/snooze':
        return await cmdSnooze(args, ownerOpenId)
      case '/cancel':
        return await cmdCancel(args, ownerOpenId)
      case '/list':
        return cmdList(args, ownerOpenId)
      case '/stats':
        return cmdStats(args, ownerOpenId)
      case '/export':
        return '⏳ /export 功能将在 Phase 2 实现'
      case '/help':
        return HELP_ALL
      default:
        return null  // 不是提醒命令
    }
  } catch (e) {
    log.error('handleCommand failed', { cmd, err: e.message })
    return `❌ 命令执行失败: ${e.message}`
  }
}

module.exports = { isReminderCommand, handleCommand }
