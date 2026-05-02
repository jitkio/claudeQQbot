/**
 * 晨报历史
 */
const { getDB } = require('./database.cjs')
const { dateStr } = require('../utils/time.cjs')

function getByDate(ownerOpenId, date = dateStr()) {
  const db = getDB()
  return db.prepare(`
    SELECT * FROM morning_reports
    WHERE owner_open_id = ? AND report_date = ?
  `).get(ownerOpenId, date)
}

function create({ ownerOpenId, date = dateStr(), viewType, content }) {
  const db = getDB()
  const now = Date.now()
  db.prepare(`
    INSERT OR REPLACE INTO morning_reports
      (owner_open_id, report_date, view_type, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(ownerOpenId, date, viewType, content, now)
  return getByDate(ownerOpenId, date)
}

function markSent(ownerOpenId, date = dateStr()) {
  const db = getDB()
  db.prepare(`
    UPDATE morning_reports SET sent_at = ?
    WHERE owner_open_id = ? AND report_date = ?
  `).run(Date.now(), ownerOpenId, date)
}

function isUnsent(ownerOpenId, date = dateStr()) {
  const report = getByDate(ownerOpenId, date)
  return report && !report.sent_at
}

// 返回过去 N 天的晨报日期（用于决定下一个视图轮换到哪种）
function recentDates(ownerOpenId, days = 7) {
  const db = getDB()
  return db.prepare(`
    SELECT report_date, view_type FROM morning_reports
    WHERE owner_open_id = ?
    ORDER BY report_date DESC
    LIMIT ?
  `).all(ownerOpenId, days)
}

module.exports = { getByDate, create, markSent, isUnsent, recentDates }
