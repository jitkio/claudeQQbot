/**
 * 时间工具
 */
const config = require('../config.cjs')

// 是否在静音时段
function isQuietHour(date = new Date()) {
  const h = date.getHours()
  const { start, end } = config.QUIET_HOURS
  if (start > end) {
    // 跨零点 23-7
    return h >= start || h < end
  }
  return h >= start && h < end
}

// 如果时间在静音时段，推迟到静音结束
function avoidQuietHour(ts) {
  const d = new Date(ts)
  if (!isQuietHour(d)) return ts
  // 推到第二天 07:00
  if (d.getHours() >= config.QUIET_HOURS.start) {
    d.setDate(d.getDate() + 1)
  }
  d.setHours(config.QUIET_HOURS.end, 0, 0, 0)
  return d.getTime()
}

// 格式化为中文友好的日期时间
function formatCN(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const diffDays = Math.floor((d - now) / 86400000)

  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

  if (diffDays === 0 && d.getDate() === now.getDate()) return `今天 ${hm}`
  if (diffDays === 1) return `明天 ${hm}`
  if (diffDays === -1) return `昨天 ${hm}`
  if (diffDays > 1 && diffDays < 7) {
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `${week[d.getDay()]} ${hm}`
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

// 只返回日期部分 YYYY-MM-DD
function dateStr(ts = Date.now()) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 计算两个时间戳相差多少天
function daysBetween(a, b) {
  return Math.floor((b - a) / 86400000)
}

module.exports = { isQuietHour, avoidQuietHour, formatCN, dateStr, daysBetween }
