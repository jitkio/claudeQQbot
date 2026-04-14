#!/usr/bin/env node
const __ROOT = require('path').resolve(__dirname, '..')
// 课程提醒脚本
// 用法: node remind_class.cjs [day] [week]
// day: 1=周一 2=周二 3=周三 4=周四 5=周五 0=周一(周提醒)
// week: 当前周数

const CONFIG = {
  qq: {
    appId: require(__ROOT + '/tools/shared_config.cjs').appId,
    clientSecret: require(__ROOT + '/tools/shared_config.cjs').clientSecret,
    authUrl: 'https://bots.qq.com/app/getAppAccessToken',
    apiBase: 'https://api.sgroup.qq.com',
  },
  userOpenId: require(__ROOT + '/tools/shared_config.cjs').userOpenId,
}

// 课程表数据
// 格式: { weeks: [起, 止], slots: "节次描述", room: "教室", teacher: "教师", name: "课程名" }
const SCHEDULE = {
  1: [ // 周一
    { name: 'DSP技术及应用', slots: '3-4节', room: '实3(306)', teacher: '舒森', weeks: [1,8] },
    { name: '电气职业道德修养', slots: '5-6节', room: '教14(510)', teacher: '王爽/张健/刘宗其', weeks: [1,8] },
    { name: '高电压技术', slots: '7-8节', room: '教14(608)', teacher: '闫福标', weeks: [1,6] },
  ],
  2: [ // 周二
    { name: '开关电源及储能技术', slots: '1-2节', room: '教14(607)', teacher: '王爽', weeks: [1,6] },
    { name: 'DSP技术及应用', slots: '3-4节', room: '实3(306)', teacher: '舒森', weeks: [1,8] },
    { name: '新能源发电与控制技术', slots: '5-6节', room: '教14(610)', teacher: '杨静', weeks: [1,10] },
    { name: '电力系统继电保护', slots: '7-8节', room: '实3(104)', teacher: '张健', weeks: [1,8] },
  ],
  3: [ // 周三
    { name: '就业指导', slots: '5-7节', room: '教1(316)', teacher: '焦小萱', weeks: [5,7] },
    { name: '大学数学拓展(1)', slots: '9-11节', room: '教14(106)', teacher: '左学武', weeks: [4,13] },
  ],
  4: [ // 周四
    { name: '电力系统继电保护', slots: '5-6节', room: '实3(104)', teacher: '张健', weeks: [1,8] },
    { name: '新能源发电与控制技术', slots: '7-8节', room: '教14(604)', teacher: '杨静', weeks: [1,10] },
  ],
  5: [ // 周五
    { name: '开关电源及储能技术', slots: '5-6节', room: '教14(507)', teacher: '王爽', weeks: [1,6] },
    { name: '高电压技术', slots: '7-8节', room: '教14(506)', teacher: '闫福标', weeks: [1,6] },
  ],
}

// 实践课/其他课程（每周一提醒一次）
const PRACTICE = [
  { name: '电气CAD实训', weeks: [1,5], note: '集中实训' },
  { name: '中国抗日战争史(慕课)', weeks: [3,10], note: '智慧树在线完成' },
  { name: '电气专业实训', weeks: [12,12], note: '集中实周' },
  { name: '新能源系统综合实训', weeks: [15,16], note: '集中实训' },
]

async function getToken() {
  const resp = await fetch(CONFIG.qq.authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: CONFIG.qq.appId, clientSecret: CONFIG.qq.clientSecret }),
  })
  const data = await resp.json()
  return data.access_token
}

async function sendMessage(content) {
  const token = await getToken()
  const resp = await fetch(`${CONFIG.qq.apiBase}/v2/users/${CONFIG.userOpenId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `QQBot ${token}` },
    body: JSON.stringify({ content, msg_type: 0 }),
  })
  const result = await resp.json()
  console.log('[提醒] 发送结果:', JSON.stringify(result))
  return result
}

function buildDailyMessage(day, week) {
  const dayNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
  const courses = SCHEDULE[day] || []
  const todayCourses = courses.filter(c => week >= c.weeks[0] && week <= c.weeks[1])
  const activePractice = PRACTICE.filter(p => week >= p.weeks[0] && week <= p.weeks[1])

  let msg = `📅 第${week}周 ${dayNames[day]} 课程提醒\n\n`

  if (todayCourses.length === 0) {
    msg += '今天没有课，好好休息！'
  } else {
    todayCourses.forEach(c => {
      msg += `📚 ${c.name}\n`
      msg += `   ⏰ ${c.slots} | 📍 ${c.room}\n`
      msg += `   👨‍🏫 ${c.teacher}\n\n`
    })
  }

  if (day === 1 && activePractice.length > 0) {
    msg += '\n📋 本周实践课/慕课：\n'
    activePractice.forEach(p => {
      msg += `■ ${p.name}（${p.note}）\n`
    })
  }

  return msg.trim()
}

function buildWeeklyMessage(week) {
  const activePractice = PRACTICE.filter(p => week >= p.weeks[0] && week <= p.weeks[1])
  let msg = `📋 第${week}周 实践课提醒\n\n`
  if (activePractice.length === 0) {
    msg += '本周无实践课任务。'
  } else {
    activePractice.forEach(p => {
      msg += `■ ${p.name}（${p.note}）\n`
    })
  }
  return msg.trim()
}

async function main() {
  const args = process.argv.slice(2)
  const mode = args[0] // 'daily' or 'weekly'
  const day = parseInt(args[1]) // 1-5
  const week = parseInt(args[2]) // 当前周数

  let message
  if (mode === 'weekly') {
    message = buildWeeklyMessage(week)
  } else {
    message = buildDailyMessage(day, week)
  }

  console.log('[提醒内容]\n' + message)
  await sendMessage(message)
}

main().catch(console.error)
