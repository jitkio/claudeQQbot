#!/usr/bin/env node
// send_qq.cjs - 向用户发送QQ消息（主动消息，无 msgId 被动回复）
// 用法: node send_qq.cjs "消息内容"

const sharedConfig = require(__dirname + '/../../../tools/shared_config.cjs')
const config = {
  appId: sharedConfig.appId,
  clientSecret: sharedConfig.clientSecret,
  authUrl: 'https://bots.qq.com/app/getAppAccessToken',
  apiBase: 'https://api.sgroup.qq.com',
  userOpenId: sharedConfig.userOpenId,
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
  // 主动消息需要 event_id 或使用消息模板，这里用 msg_type=0 文本
  const resp = await fetch(`${config.apiBase}/v2/users/${config.userOpenId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `QQBot ${token}`,
    },
    body: JSON.stringify({
      content,
      msg_type: 0,
    }),
  })
  const text = await resp.text()
  let result
  try { result = JSON.parse(text) } catch { result = { raw: text } }
  if (!resp.ok) {
    console.error(`发送失败 (${resp.status}):`, text.slice(0, 500))
    process.exit(1)
  }
  console.log('发送成功:', JSON.stringify(result).slice(0, 200))
}

const content = process.argv[2]
if (!content) {
  console.error('用法: node send_qq.cjs "消息内容"')
  process.exit(1)
}

sendMessage(content).catch(e => {
  console.error('错误:', e.message)
  process.exit(1)
})
