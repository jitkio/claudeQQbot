const __ROOT = require('path').resolve(__dirname, '..')
// ============================================================
//  智能提醒调度器 — cron 每15分钟调用，自动判断触发
// ============================================================

const fs = require('fs')
const { spawnSync } = require('child_process')

const TASKS_FILE = __ROOT + '/workspace/scheduled_tasks.json'
const SEND_SMART = __ROOT + '/tools/send_qq_smart.cjs'
const DAY_MS = 86400000
const LOG = '[Reminder]'

function readTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8')).tasks || [] }
  catch { return [] }
}
function writeTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify({ tasks, updatedAt: Date.now() }, null, 2))
}

function sendMsg(userId, content) {
  try {
    const r = spawnSync('node', [SEND_SMART, userId, 'c2c'], {
      input: content, timeout: 30000, encoding: 'utf-8',
    })
    if (r.status === 0) { console.log(LOG + ' sent to ' + userId.slice(0, 8) + '...'); return true }
    console.error(LOG + ' send fail: ' + (r.stderr || '').slice(0, 100))
    return false
  } catch (e) { console.error(LOG + ' send error: ' + e.message); return false }
}

function todayStr() { return new Date().toISOString().slice(0, 10) }
function dateStr(ts) { return ts ? new Date(ts).toISOString().slice(0, 10) : '' }
function formatDate(ts) {
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
}
function isSilentHour() { const h = new Date().getHours(); return h >= 23 || h < 7 }

function isInTimeWindow(timeStr, windowMin) {
  const [th, tm] = timeStr.split(':').map(Number)
  const now = new Date(), target = new Date()
  target.setHours(th, tm, 0, 0)
  return Math.abs(now.getTime() - target.getTime()) <= windowMin * 60000
}

// Deadline 下次提醒
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
  const d = new Date(next); const h = d.getHours()
  if (h >= 23 || h < 7) { if (h >= 23) d.setDate(d.getDate() + 1); d.setHours(7, 30, 0, 0); next = d.getTime() }
  if (next > task.deadline) { next = task.deadline - 3600000; if (next < now) next = now + 1800000 }
  return next
}

// ===================== 消息模板 =====================

function buildDailyBatch(dailyTasks) {
  const lines = ['早上好，今日习惯:', '']
  for (let i = 0; i < dailyTasks.length; i++) {
    const t = dailyTasks[i]
    const s = t.streak > 0 ? ' (已连续' + t.streak + '天)' : ''
    lines.push((i + 1) + '. ' + t.name + s)
  }
  lines.push('', '完成后回复: /done 任务名')
  return lines.join('\n')
}

function buildOnceMsg(task) { return '提醒: ' + task.name }

function buildDeadlineMsg(task) {
  const remainingDays = (task.deadline - Date.now()) / DAY_MS
  const totalDays = (task.deadline - task.createdAt) / DAY_MS
  const rd = Math.ceil(remainingDays)
  let urgency
  if (remainingDays < 0.2)      urgency = '即将截止! 马上处理!'
  else if (rd <= 1)             urgency = '还剩不到' + Math.ceil(remainingDays * 24) + '小时，抓紧!'
  else if (rd <= 2)             urgency = '还剩' + rd + '天，尽快完成'
  else if (rd <= 3)             urgency = '还剩' + rd + '天，该动手了'
  else                          urgency = '还剩' + rd + '天 (时间进度' + Math.round((1 - remainingDays / totalDays) * 100) + '%)'
  const prefix = rd <= 1 ? '紧急' : '作业提醒'
  return prefix + ': ' + task.name + '\n截止: ' + formatDate(task.deadline) + '\n' + urgency + '\n\n完成后回复: /done ' + task.name
}

// ===================== 主逻辑 =====================

function main() {
  const tasks = readTasks()
  if (!tasks.length) return
  let changed = false
  const now = Date.now()
  const silent = isSilentHour()

  // 1. 静默期: 只处理12小时内截止的紧急 deadline
  if (silent) {
    for (const task of tasks) {
      if (task.type !== 'deadline' || task.status !== 'active') continue
      if ((task.deadline - now) / DAY_MS < 0.5 && task.nextRemindAt && now >= task.nextRemindAt) {
        sendMsg(task.userId, buildDeadlineMsg(task))
        task.lastFiredAt = now; task.remindCount = (task.remindCount || 0) + 1
        task.nextRemindAt = calcNextRemind(task)
        if (task.nextRemindAt === -1) task.status = 'expired'
        changed = true
      }
    }
    if (changed) writeTasks(tasks)
    return
  }

  // 2. 每日习惯 (同一用户批量合并一条消息)
  const dailyToFire = []
  for (const task of tasks) {
    if (task.type !== 'daily' || task.status !== 'active') continue
    if (isInTimeWindow(task.time, 10) && dateStr(task.lastFiredAt) !== todayStr()) {
      dailyToFire.push(task)
    }
  }
  if (dailyToFire.length) {
    const byUser = {}
    for (const t of dailyToFire) { (byUser[t.userId] = byUser[t.userId] || []).push(t) }
    for (const [userId, uTasks] of Object.entries(byUser)) {
      if (sendMsg(userId, buildDailyBatch(uTasks))) {
        for (const t of uTasks) { t.lastFiredAt = now; changed = true }
      }
    }
  }

  // 3. 一次性提醒
  for (const task of tasks) {
    if (task.type !== 'once' || task.status !== 'active') continue
    if (now >= task.fireAt) {
      if (sendMsg(task.userId, buildOnceMsg(task))) {
        task.status = 'completed'; task.lastFiredAt = now; task.completedAt = now
        changed = true
        console.log(LOG + ' once fired: ' + task.name)
      }
    }
  }

  // 4. 截止日期任务
  for (const task of tasks) {
    if (task.type !== 'deadline' || task.status !== 'active') continue
    if (task.deadline - now <= 0) {
      sendMsg(task.userId, task.name + ' 已过截止日期 (' + formatDate(task.deadline) + ')')
      task.status = 'expired'; changed = true; continue
    }
    if (task.nextRemindAt && now >= task.nextRemindAt) {
      if (sendMsg(task.userId, buildDeadlineMsg(task))) {
        task.lastFiredAt = now; task.remindCount = (task.remindCount || 0) + 1
        task.nextRemindAt = calcNextRemind(task)
        if (task.nextRemindAt === -1) task.status = 'expired'
        changed = true
        console.log(LOG + ' deadline #' + task.remindCount + ': ' + task.name)
      }
    }
  }

  if (changed) writeTasks(tasks)
}

try { main() } catch (e) { console.error(LOG + ' error: ' + e.message) }
