const fs = require('fs')
const cfg = require('./shared_config.cjs')

const userId = process.argv[2]
if (!userId) { console.error('用法: echo "消息" | node send_qq.cjs "openid"'); process.exit(1) }

async function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', chunk => data += chunk)
    process.stdin.on('end', () => resolve(data))
    setTimeout(() => resolve(data), 3000)
  })
}

async function main() {
  let content = await readStdin()
  if (!content || !content.trim()) content = process.argv[3] || ''
  if (!content.trim()) { console.error('没有消息内容'); process.exit(1) }

  const token = await cfg.getToken()
  const s = await fetch(`${cfg.apiBase}/v2/users/${userId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `QQBot ${token}` },
    body: JSON.stringify({ content, msg_type: 0 }),
  })
  console.log(s.ok ? '发送成功' : `失败: ${await s.text()}`)
}
main().catch(e => console.error(e.message))
