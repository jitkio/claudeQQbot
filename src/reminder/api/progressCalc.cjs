/**
 * 持续任务进度计算
 * 负责生成"进度条"和"打卡记录"两种可视化
 */
const checkinsRepo = require('../db/checkinsRepo.cjs')
const { dateStr, daysBetween } = require('../utils/time.cjs')

// 生成进度条字符串: ▓▓▓▓░░ 4/7
function progressBar(current, total, width = 6) {
  if (!total || total <= 0) return ''
  const ratio = Math.min(1, current / total)
  const filled = Math.round(width * ratio)
  const empty = width - filled
  return '▓'.repeat(filled) + '░'.repeat(empty) + ` ${current}/${total}`
}

// 生成打卡记录字符串: 周一✓ 周二✓ 周三✗ 周四✓ 周五○ 周六○ 周日○
function checkinStreak(taskId, days = 7) {
  const records = checkinsRepo.recentDays(taskId, days)
  const week = ['日','一','二','三','四','五','六']
  return records.map(r => {
    const d = new Date(r.date).getDay()
    const mark = r.checked ? '✓' : (new Date(r.date).getTime() > Date.now() ? '○' : '✗')
    return `周${week[d]}${mark}`
  }).join(' ')
}

// 根据 task 计算 progress_count 应当是多少（持续任务）
function calcProgressForPeriodic(task) {
  const now = Date.now()
  const period = task.target_period || 'week'

  let startTs
  if (period === 'week') {
    const d = new Date()
    d.setDate(d.getDate() - d.getDay())  // 本周日开始（兼容周一开始也行）
    d.setHours(0, 0, 0, 0)
    startTs = d.getTime()
  } else if (period === 'month') {
    const d = new Date()
    d.setDate(1); d.setHours(0, 0, 0, 0)
    startTs = d.getTime()
  } else {
    startTs = task.created_at
  }

  const db = require('../db/database.cjs').getDB()
  const count = db.prepare(`
    SELECT COUNT(*) as c FROM checkins
    WHERE task_id = ? AND checked_at >= ?
  `).get(task.id, startTs).c
  return count
}

// 判断一个任务是否该被"搁置"（7 天没打卡）
function shouldShelve(task, shelveAfterDays = 7) {
  if (task.type !== 'daily' && task.type !== 'periodic') return false
  const db = require('../db/database.cjs').getDB()
  const last = db.prepare(`
    SELECT checked_at FROM checkins
    WHERE task_id = ?
    ORDER BY checked_at DESC LIMIT 1
  `).get(task.id)

  const lastTs = last ? last.checked_at : task.created_at
  return daysBetween(lastTs, Date.now()) >= shelveAfterDays
}

// 最近一次打卡距离今天几天
function daysSinceLastCheckin(taskId) {
  const db = require('../db/database.cjs').getDB()
  const last = db.prepare(`
    SELECT checked_at FROM checkins
    WHERE task_id = ?
    ORDER BY checked_at DESC LIMIT 1
  `).get(taskId)
  if (!last) return null
  return daysBetween(last.checked_at, Date.now())
}

module.exports = {
  progressBar,
  checkinStreak,
  calcProgressForPeriodic,
  shouldShelve,
  daysSinceLastCheckin,
}
