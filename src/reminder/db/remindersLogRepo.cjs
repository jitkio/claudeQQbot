/**
 * 提醒发送历史日志
 */
const { getDB } = require('./database.cjs')

function log({ taskId, channel, message, status, error = null, triggeredAt = Date.now() }) {
  const db = getDB()
  const info = db.prepare(`
    INSERT INTO reminders_log (task_id, triggered_at, channel, message, status, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(taskId, triggeredAt, channel, message, status, error)
  return info.lastInsertRowid
}

function listByTask(taskId, limit = 10) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM reminders_log
    WHERE task_id = ?
    ORDER BY triggered_at DESC
    LIMIT ?
  `).all(taskId, limit)
}

function recentFailed(limit = 20) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM reminders_log
    WHERE status = 'failed'
    ORDER BY triggered_at DESC
    LIMIT ?
  `).all(limit)
}

module.exports = { log, listByTask, recentFailed }
