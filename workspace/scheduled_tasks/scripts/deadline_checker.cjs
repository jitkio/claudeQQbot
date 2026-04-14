#!/usr/bin/env node
// deadline_checker.cjs - 每天早上7点检查截止任务（随课程提醒一起，但也可单独运行）
// 也用于：添加新截止任务、临时提醒
// 用法:
//   node deadline_checker.cjs add-deadline "任务名" "2026-04-15" "备注"
//   node deadline_checker.cjs add-reminder "2026-04-05" "14:00" "去图书馆还书"
//   node deadline_checker.cjs list

const fs = require('fs')
const path = require('path')

const DEADLINES_FILE = path.join(__dirname, '../deadlines/deadlines.json')
const REMINDERS_FILE = path.join(__dirname, '../reminders/reminders.json')

const sharedConfig = require(__dirname + '/../../../tools/shared_config.cjs')
const config = {
  appId: sharedConfig.appId,
  clientSecret: sharedConfig.clientSecret,
  authUrl: 'https://bots.qq.com/app/getAppAccessToken',
  apiBase: 'https://api.sgroup.qq.com',
  userOpenId: sharedConfig.userOpenId,
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch { return [] }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}

async function getToken() {
  const resp = await fetch(config.authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: config.appId, clientSecret: config.clientSecret }),
  })
  const data = await resp.json()
  return data.access_token
}

async function sendMessage(content) {
  const token = await getToken()
  const resp = await fetch(`${config.apiBase}/v2/users/${config.userOpenId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `QQBot ${token}` },
    body: JSON.stringify({ content, msg_type: 0 }),
  })
  const text = await resp.text()
  if (!resp.ok) { console.error('发送失败:', text.slice(0,200)); return false }
  console.log('发送成功')
  return true
}

const cmd = process.argv[2]

if (cmd === 'add-deadline') {
  const [, , , name, due, note] = process.argv
  if (!name || !due) { console.error('用法: node deadline_checker.cjs add-deadline "任务名" "YYYY-MM-DD" "备注"'); process.exit(1) }
  const deadlines = readJSON(DEADLINES_FILE)
  deadlines.push({ id: Date.now(), name, due, note: note || '', created: new Date().toISOString() })
  deadlines.sort((a, b) => a.due.localeCompare(b.due))
  writeJSON(DEADLINES_FILE, deadlines)
  console.log(`已添加截止任务: ${name} (${due})`)
  sendMessage(`✅ 已添加截止任务：${name}\n📅 截止时间：${due}${note ? '\n📝 备注：' + note : ''}`)

} else if (cmd === 'add-reminder') {
  const [, , , date, time, content] = process.argv
  if (!date || !content) { console.error('用法: node deadline_checker.cjs add-reminder "YYYY-MM-DD" "HH:MM" "内容"'); process.exit(1) }
  const reminders = readJSON(REMINDERS_FILE)
  reminders.push({ id: Date.now(), date, time: time || '', content, created: new Date().toISOString() })
  reminders.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
  writeJSON(REMINDERS_FILE, reminders)
  console.log(`已添加提醒: ${date} ${time} ${content}`)
  sendMessage(`✅ 已添加提醒：${date} ${time}\n📌 ${content}`)

} else if (cmd === 'list') {
  const deadlines = readJSON(DEADLINES_FILE)
  const reminders = readJSON(REMINDERS_FILE)
  const now = new Date()
  console.log('\n=== 截止任务 ===')
  const upcoming = deadlines.filter(d => new Date(d.due) >= now)
  if (upcoming.length === 0) console.log('(暂无)')
  for (const d of upcoming) {
    const days = Math.ceil((new Date(d.due) - now) / 86400000)
    console.log(`  ${d.name}  截止:${d.due}  剩余:${days}天  ${d.note || ''}`)
  }
  console.log('\n=== 临时提醒 ===')
  const futureReminders = reminders.filter(r => r.date >= now.toISOString().slice(0,10))
  if (futureReminders.length === 0) console.log('(暂无)')
  for (const r of futureReminders) {
    console.log(`  ${r.date} ${r.time}  ${r.content}`)
  }

} else if (cmd === 'remove-deadline') {
  const id = parseInt(process.argv[3])
  const deadlines = readJSON(DEADLINES_FILE)
  const filtered = deadlines.filter(d => d.id !== id)
  writeJSON(DEADLINES_FILE, filtered)
  console.log(`已删除 id=${id}`)

} else {
  console.log(`用法:
  node deadline_checker.cjs add-deadline "任务名" "YYYY-MM-DD" "备注"
  node deadline_checker.cjs add-reminder "YYYY-MM-DD" "HH:MM" "内容"
  node deadline_checker.cjs list
  node deadline_checker.cjs remove-deadline <id>`)
}
