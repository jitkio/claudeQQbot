const __ROOT = require('path').resolve(__dirname, '..')
// ============================================================
//  智能提醒管理器 — 三种模式: daily / once / deadline
// ============================================================

const fs = require('fs')
const crypto = require('crypto')

const TASKS_FILE = __ROOT + '/workspace/scheduled_tasks.json'
const DAY_MS = 86400000

function readTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8')).tasks || [] }
  catch { return [] }
}
function writeTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks, updatedAt: Date.now() }, null, 2))
}
function genId() { return crypto.randomUUID().slice(0, 8) }

function parseTime(str) {
  const [h, m] = (str || '07:30').split(':').map(Number)
  return { hour: h || 7, minute: m || 30 }
}
function parseDateTime(str) {
  const d = new Date(str)
  if (isNaN(d.getTime())) { console.error('无法解析日期: ' + str); process.exit(1) }
  return d.getTime()
}
function formatDate(ts) {
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
}
function formatDateTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })
}
function daysRemaining(deadline) { return Math.max(0, (deadline - Date.now()) / DAY_MS) }

// ---- Deadline 频率算法 ----
// 前半段低频(总天数/6间隔，最少2天) -> 后半段>3天每2天 -> <=3天每天 -> <2天每8h -> <1天每4h
function calcNextRemind(task) {
  const now = Date.now()
  const remaining = task.deadline - now
  const total = task.deadline - task.createdAt
  const totalDays = total / DAY_MS
  const remainingDays = remaining / DAY_MS
  const progress = (now - task.createdAt) / total
  if (remainingDays <= 0) return -1
  let intervalMs
  if (remainingDays < 1)          intervalMs = 4 * 3600000
  else if (remainingDays < 2)     intervalMs = 8 * 3600000
  else if (progress < 0.5)        intervalMs = Math.max(2, Math.ceil(totalDays / 6)) * DAY_MS
  else if (remainingDays > 3)     intervalMs = 2 * DAY_MS
  else                            intervalMs = DAY_MS
  let next = now + intervalMs
  // 避开 23:00-07:00
  const d = new Date(next); const h = d.getHours()
  if (h >= 23 || h < 7) { if (h >= 23) d.setDate(d.getDate() + 1); d.setHours(7, 30, 0, 0); next = d.getTime() }
  // 不超过截止时间
  if (next > task.deadline) { next = task.deadline - 3600000; if (next < now) next = now + 1800000 }
  return next
}

// ---- 模糊匹配 ----
function findTask(tasks, query, userId) {
  let t = tasks.find(x => x.id === query && x.status === 'active')
  if (t) return t
  const q = query.toLowerCase()
  const cs = tasks.filter(x => {
    if (x.status !== 'active') return false
    if (userId && x.userId !== userId) return false
    return x.name.toLowerCase().includes(q) || q.includes(x.name.toLowerCase())
  })
  if (cs.length === 1) return cs[0]
  if (cs.length > 1) { const e = cs.find(x => x.name.toLowerCase() === q); return e || cs[0] }
  return tasks.find(x => x.status === 'active' && (x.name.toLowerCase().includes(q) || x.id.includes(query)))
}

// ===================== 命令路由 =====================
const action = process.argv[2]

if (action === 'add-daily') {
  const name = process.argv[3], userId = process.argv[4], timeStr = process.argv[5] || '07:30'
  if (!name || !userId) { console.error('用法: add-daily <名称> <userId> [time]'); process.exit(1) }
  const time = parseTime(timeStr)
  const task = {
    id: genId(), type: 'daily', name, userId, status: 'active',
    createdAt: Date.now(), lastFiredAt: null, completedAt: null,
    time: String(time.hour).padStart(2,'0') + ':' + String(time.minute).padStart(2,'0'),
    streak: 0, lastCompletedDate: null,
  }
  const tasks = readTasks(); tasks.push(task); writeTasks(tasks)
  console.log('已创建每日任务\n  ID: ' + task.id + '\n  名称: ' + name + '\n  时间: 每天 ' + task.time + '\n  类型: 每日习惯\n  回复 /done ' + name + ' 打卡')

} else if (action === 'add-once') {
  const name = process.argv[3], fireAtStr = process.argv[4], userId = process.argv[5]
  if (!name || !fireAtStr || !userId) { console.error('用法: add-once <名称> <fireAt> <userId>'); process.exit(1) }
  const fireAt = parseDateTime(fireAtStr)
  if (fireAt <= Date.now()) { console.error('提醒时间已过'); process.exit(1) }
  const task = {
    id: genId(), type: 'once', name, userId, status: 'active',
    createdAt: Date.now(), lastFiredAt: null, completedAt: null, fireAt,
  }
  const tasks = readTasks(); tasks.push(task); writeTasks(tasks)
  console.log('已创建一次性提醒\n  ID: ' + task.id + '\n  名称: ' + name + '\n  时间: ' + formatDateTime(fireAt) + '\n  到时会自动提醒并清除')

} else if (action === 'add-deadline') {
  const name = process.argv[3], deadlineStr = process.argv[4], userId = process.argv[5]
  if (!name || !deadlineStr || !userId) { console.error('用法: add-deadline <名称> <deadline> <userId>'); process.exit(1) }
  const deadline = parseDateTime(deadlineStr)
  if (deadline <= Date.now()) { console.error('截止日期已过'); process.exit(1) }
  const totalDays = (deadline - Date.now()) / DAY_MS
  const task = {
    id: genId(), type: 'deadline', name, userId, status: 'active',
    createdAt: Date.now(), lastFiredAt: null, completedAt: null,
    deadline, nextRemindAt: null, remindCount: 0,
  }
  if (totalDays <= 2) { task.nextRemindAt = Date.now() + 3600000 }
  else { const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(7, 30, 0, 0); task.nextRemindAt = t.getTime() }
  const tasks = readTasks(); tasks.push(task); writeTasks(tasks)
  const rd = Math.ceil(totalDays)
  let phase = rd > 7 ? '前期每隔' + Math.max(2, Math.ceil(rd/6)) + '天提醒，后期越来越频繁'
            : rd > 3 ? '每1-2天提醒，越接近越频繁' : '时间紧迫，高频提醒'
  console.log('已创建截止日期任务\n  ID: ' + task.id + '\n  名称: ' + name + '\n  截止: ' + formatDate(deadline) + ' (还剩' + rd + '天)\n  策略: ' + phase + '\n  完成后回复: /done ' + name)

} else if (action === 'done') {
  const query = process.argv[3], userId = process.argv[4]
  if (!query) { console.error('用法: done <id或名称> [userId]'); process.exit(1) }
  const tasks = readTasks()
  const task = findTask(tasks, query, userId)
  if (!task) { console.log('找不到匹配的活跃任务: ' + query); process.exit(0) }
  const today = new Date().toISOString().slice(0, 10)
  if (task.type === 'daily') {
    if (task.lastCompletedDate === today) {
      console.log(task.name + ' 今天已经打过卡了，连续' + (task.streak || 0) + '天')
    } else {
      const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10)
      task.streak = (task.lastCompletedDate === yesterday) ? (task.streak || 0) + 1 : 1
      task.lastCompletedDate = today
      writeTasks(tasks)
      console.log(task.name + ' 打卡成功! 已连续' + task.streak + '天')
    }
  } else if (task.type === 'deadline') {
    task.status = 'completed'; task.completedAt = Date.now(); writeTasks(tasks)
    const daysLeft = Math.ceil((task.deadline - Date.now()) / DAY_MS)
    const usedDays = Math.ceil((Date.now() - task.createdAt) / DAY_MS)
    console.log(task.name + ' 已完成! 提前' + daysLeft + '天，用时' + usedDays + '天，共提醒' + (task.remindCount || 0) + '次')
  } else {
    task.status = 'completed'; task.completedAt = Date.now(); writeTasks(tasks)
    console.log(task.name + ' 已完成')
  }

} else if (action === 'list') {
  const userId = process.argv[3]
  const tasks = readTasks().filter(t => t.status === 'active' && (!userId || t.userId === userId))
  if (!tasks.length) { console.log('当前没有活跃的提醒任务'); process.exit(0) }
  const dailys = tasks.filter(t => t.type === 'daily')
  const onces = tasks.filter(t => t.type === 'once')
  const deadlines = tasks.filter(t => t.type === 'deadline')
  console.log('共 ' + tasks.length + ' 个活跃任务\n')
  if (dailys.length) {
    console.log('-- 每日习惯 --')
    const today = new Date().toISOString().slice(0, 10)
    for (const t of dailys) {
      const done = t.lastCompletedDate === today ? '(今日已打卡)' : '(今日未打卡)'
      console.log('[' + t.id + '] ' + t.name + ' | 每天' + t.time + ' | 连续' + (t.streak || 0) + '天 ' + done)
    }
    console.log('')
  }
  if (onces.length) {
    console.log('-- 一次性提醒 --')
    for (const t of onces) console.log('[' + t.id + '] ' + t.name + ' | ' + formatDateTime(t.fireAt))
    console.log('')
  }
  if (deadlines.length) {
    console.log('-- 截止日期任务 --')
    for (const t of deadlines) {
      const rd = Math.ceil(daysRemaining(t.deadline))
      const total = Math.ceil((t.deadline - t.createdAt) / DAY_MS)
      const pct = Math.round((1 - rd / total) * 100)
      let urg = rd <= 1 ? ' !!紧急!!' : rd <= 3 ? ' !注意' : ''
      console.log('[' + t.id + '] ' + t.name + ' | 截止' + formatDate(t.deadline) + ' | 剩' + rd + '天(' + pct + '%)' + urg)
    }
    console.log('')
  }

} else if (action === 'delete') {
  const id = process.argv[3]
  if (!id) { console.error('用法: delete <id>'); process.exit(1) }
  const tasks = readTasks(), before = tasks.length
  const remaining = tasks.filter(t => t.id !== id)
  if (remaining.length === before) console.log('任务 ' + id + ' 不存在')
  else { writeTasks(remaining); console.log('已删除任务 ' + id) }

} else if (action === 'status') {
  const query = process.argv[3]
  if (!query) { console.error('用法: status <id或名称>'); process.exit(1) }
  const tasks = readTasks()
  const task = tasks.find(t => t.id === query || t.name.includes(query))
  if (!task) { console.log('找不到任务: ' + query); process.exit(0) }
  const typeMap = { daily: '每日习惯', once: '一次性', deadline: '截止日期' }
  console.log('任务详情:\n  ID: ' + task.id + '\n  名称: ' + task.name + '\n  类型: ' + (typeMap[task.type] || task.type) + '\n  状态: ' + task.status + '\n  创建: ' + formatDateTime(task.createdAt))
  if (task.type === 'daily') {
    console.log('  时间: 每天 ' + task.time + '\n  连续: ' + (task.streak || 0) + '天\n  上次打卡: ' + (task.lastCompletedDate || '未打卡'))
  } else if (task.type === 'once') {
    console.log('  提醒时间: ' + formatDateTime(task.fireAt))
  } else if (task.type === 'deadline') {
    const rd = daysRemaining(task.deadline), total = (task.deadline - task.createdAt) / DAY_MS
    console.log('  截止: ' + formatDate(task.deadline) + '\n  剩余: ' + Math.ceil(rd) + '天\n  时间进度: ' + ((1 - rd / total) * 100).toFixed(1) + '%\n  已提醒: ' + (task.remindCount || 0) + '次\n  下次提醒: ' + (task.nextRemindAt ? formatDateTime(task.nextRemindAt) : '待计算'))
  }

} else if (action === 'clean-completed') {
  const tasks = readTasks(), cutoff = Date.now() - 7 * DAY_MS
  const remaining = tasks.filter(t => !(t.status === 'completed' && t.completedAt && t.completedAt < cutoff) && t.status !== 'expired')
  writeTasks(remaining)
  console.log('清理了 ' + (tasks.length - remaining.length) + ' 个旧任务')

} else {
  console.log('智能提醒管理器\n\n用法:\n  add-daily   <名称> <userId> [time]        每日习惯(默认07:30)\n  add-once    <名称> <fireAt> <userId>      一次性提醒\n  add-deadline <名称> <deadline> <userId>   截止日期任务\n  done        <id或名称> [userId]            打卡/完成\n  list        [userId]                      列出任务\n  delete      <id>                          删除\n  status      <id或名称>                    详情\n  clean-completed                           清理旧任务')
}
