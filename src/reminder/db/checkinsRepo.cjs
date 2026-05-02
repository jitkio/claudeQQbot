/**
 * 打卡记录 CRUD
 */
const { getDB } = require('./database.cjs')
const { dateStr } = require('../utils/time.cjs')

function create(taskId, { note = null, source = 'user', checkedAt = Date.now() } = {}) {
  const db = getDB()
  const info = db.prepare(`
    INSERT INTO checkins (task_id, checked_at, note, source)
    VALUES (?, ?, ?, ?)
  `).run(taskId, checkedAt, note, source)
  return info.lastInsertRowid
}

function listByTask(taskId, limit = 30) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM checkins
    WHERE task_id = ?
    ORDER BY checked_at DESC
    LIMIT ?
  `).all(taskId, limit)
}

// 最近 N 天每天是否打卡（用于显示 ✓✗✓✗ 记录）
function recentDays(taskId, days = 7) {
  const db = getDB()
  const since = Date.now() - days * 86400000
  const rows = db.prepare(`
    SELECT checked_at FROM checkins
    WHERE task_id = ? AND checked_at >= ?
    ORDER BY checked_at ASC
  `).all(taskId, since)

  const checkedDates = new Set(rows.map(r => dateStr(r.checked_at)))
  const result = []
  for (let i = days - 1; i >= 0; i--) {
    const day = dateStr(Date.now() - i * 86400000)
    result.push({ date: day, checked: checkedDates.has(day) })
  }
  return result
}

// 今天是否已经打过卡
function checkedToday(taskId) {
  const db = getDB()
  const today = dateStr()
  const todayStart = new Date(today).getTime()
  const todayEnd = todayStart + 86400000
  const row = db.prepare(`
    SELECT COUNT(*) as c FROM checkins
    WHERE task_id = ? AND checked_at >= ? AND checked_at < ?
  `).get(taskId, todayStart, todayEnd)
  return row.c > 0
}

function countByTask(taskId) {
  const db = getDB()
  return db.prepare('SELECT COUNT(*) as c FROM checkins WHERE task_id = ?')
    .get(taskId).c
}

module.exports = { create, listByTask, recentDays, checkedToday, countByTask }
