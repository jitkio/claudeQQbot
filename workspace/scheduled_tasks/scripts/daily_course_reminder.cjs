#!/usr/bin/env node
// daily_course_reminder.cjs - 每天早上7点发当天课程提醒
// 用法: node daily_course_reminder.cjs

const path = require('path')
const fs = require('fs')

const SCHEDULE_FILE = path.join(__dirname, '../courses/schedule.json')
const DEADLINES_FILE = path.join(__dirname, '../deadlines/deadlines.json')
const REMINDERS_FILE = path.join(__dirname, '../reminders/reminders.json')

const sharedConfig = require(__dirname + '/../../../tools/shared_config.cjs')
const config = {
  appId: sharedConfig.appId,
  clientSecret: sharedConfig.clientSecret,
  authUrl: 'https://bots.qq.com/app/getAppAccessToken',
  apiBase: 'https://api.sgroup.qq.com',
  userOpenId: sharedConfig.userOpenId,
  semesterStart: new Date('2026-02-23'),
}

// 节次时间
const slotTimes = {
  '1-2节': '08:00-09:40',
  '3-4节': '10:00-11:40',
  '5-6节': '14:00-15:40',
  '5-7节': '14:00-16:30',
  '7-8节': '16:00-17:40',
  '9-11节': '19:00-21:30',
}

function getCurrentWeek(now) {
  const start = config.semesterStart
  const msPerWeek = 7 * 24 * 60 * 60 * 1000
  const diff = now - start
  if (diff < 0) return 0
  return Math.floor(diff / msPerWeek) + 1
}

function parseWeekRange(weekStr) {
  // "1-6" => [1,2,3,4,5,6]   "1-8" => [1..8]
  const parts = weekStr.split(',')
  const weeks = []
  for (const p of parts) {
    const m = p.trim().match(/^(\d+)(?:-(\d+))?$/)
    if (m) {
      const start = parseInt(m[1])
      const end = m[2] ? parseInt(m[2]) : start
      for (let i = start; i <= end; i++) weeks.push(i)
    }
  }
  return weeks
}

async function getToken() {
  const resp = await fetch(config.authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: config.appId, clientSecret: config.clientSecret }),
  })
  if (!resp.ok) throw new Error(`Token 获取失败: ${resp.status}`)
  const data = await resp.json()
  return data.access_token
}

async function sendMessage(content) {
  const token = await getToken()
  const resp = await fetch(`${config.apiBase}/v2/users/${config.userOpenId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `QQBot ${token}`,
    },
    body: JSON.stringify({ content, msg_type: 0 }),
  })
  const text = await resp.text()
  if (!resp.ok) {
    console.error(`发送失败 (${resp.status}):`, text.slice(0, 300))
    return false
  }
  console.log('发送成功')
  return true
}

function buildMessage(now) {
  const schedule = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'))
  const deadlines = JSON.parse(fs.readFileSync(DEADLINES_FILE, 'utf8'))
  const reminders = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'))

  const currentWeek = getCurrentWeek(now)
  const weekday = now.getDay() // 0=周日,1=周一...6=周六
  const weekdayNames = ['日', '一', '二', '三', '四', '五', '六']
  const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`

  if (currentWeek <= 0 || currentWeek > 20) {
    return null // 不在学期内
  }

  const lines = []
  lines.push(`早安！📅 ${dateStr} 周${weekdayNames[weekday]}  第${currentWeek}周`)
  lines.push('━━━━━━━━━━━━━━')

  // 今日课程
  const todayCourses = []
  for (const course of schedule.courses) {
    if (course.weekday !== weekday) continue
    const weeks = parseWeekRange(course.weeks)
    if (!weeks.includes(currentWeek)) continue
    todayCourses.push(course)
  }

  // 按节次排序（简单字符串比较）
  todayCourses.sort((a, b) => a.slots.localeCompare(b.slots))

  if (todayCourses.length > 0) {
    lines.push('📚 今日课程：')
    for (const c of todayCourses) {
      const time = slotTimes[c.slots] || c.slots
      lines.push(`  ${time} ${c.name}`)
      lines.push(`    📍${c.location}  👨‍🏫${c.teacher}`)
    }
  } else {
    lines.push('✅ 今天没有课，好好休息！')
  }

  // 临近截止任务（7天内）
  const urgentDeadlines = deadlines.filter(d => {
    const due = new Date(d.due)
    const diffDays = (due - now) / (1000 * 60 * 60 * 24)
    return diffDays >= 0 && diffDays <= 7
  })

  if (urgentDeadlines.length > 0) {
    lines.push('━━━━━━━━━━━━━━')
    lines.push('⏰ 近期截止任务：')
    for (const d of urgentDeadlines) {
      const due = new Date(d.due)
      const diffDays = Math.ceil((due - now) / (1000 * 60 * 60 * 24))
      const dueStr = d.due.slice(0, 10)
      const urgency = diffDays <= 1 ? '🔴' : diffDays <= 3 ? '🟡' : '🟢'
      lines.push(`  ${urgency} ${d.name}  截止:${dueStr}(还剩${diffDays}天)`)
    }
  }

  // 今日临时提醒
  const todayReminders = reminders.filter(r => r.date === dateStr)
  if (todayReminders.length > 0) {
    lines.push('━━━━━━━━━━━━━━')
    lines.push('📌 今日提醒：')
    for (const r of todayReminders) {
      lines.push(`  ${r.time ? r.time + ' ' : ''}${r.content}`)
    }
  }

  lines.push('━━━━━━━━━━━━━━')
  lines.push('加油！💪')

  return lines.join('\n')
}

async function main() {
  const now = new Date()
  console.log(`[${now.toISOString()}] 开始执行每日课程提醒`)

  const message = buildMessage(now)
  if (!message) {
    console.log('不在学期内，跳过')
    return
  }

  console.log('消息内容:\n' + message)
  await sendMessage(message)
}

main().catch(e => {
  console.error('执行失败:', e.message)
  process.exit(1)
})
