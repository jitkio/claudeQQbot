const cfg = require('./shared_config.cjs')

const groupId = process.argv[2]
if (!groupId) { console.error('用法: echo "消息" | node send_qq_group.cjs "groupId"'); process.exit(1) }

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

  const ok = await cfg.sendGroup(groupId, content)
  console.log(ok ? '群消息发送成功' : '群消息发送失败')
}
main().catch(e => console.error(e.message))
