const cfg = require('./shared_config.cjs')

const targetId = process.argv[2]
const msgType = process.argv[3] || 'c2c'
const MAX_LEN = 1900
const CHUNK_DELAY = 800

if (!targetId) { console.error('用法: echo "消息" | node send_qq_smart.cjs "id" [c2c|group]'); process.exit(1) }

async function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', chunk => data += chunk)
    process.stdin.on('end', () => resolve(data))
    setTimeout(() => resolve(data), 5000)
  })
}

function smartSplit(text) {
  if (text.length <= MAX_LEN) return [text]
  const segments = []
  let current = ''
  for (const line of text.split('\n')) {
    if (line.length > MAX_LEN) {
      if (current) { segments.push(current); current = '' }
      for (let i = 0; i < line.length; i += MAX_LEN) segments.push(line.slice(i, i + MAX_LEN))
      continue
    }
    if ((current + '\n' + line).length > MAX_LEN) {
      if (current) segments.push(current)
      current = line
    } else {
      current += (current ? '\n' : '') + line
    }
  }
  if (current) segments.push(current)
  return segments
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  let content = await readStdin()
  if (!content || !content.trim()) content = process.argv[4] || ''
  if (!content.trim()) { console.error('没有消息内容'); process.exit(1) }

  const segments = smartSplit(content)
  const token = await cfg.getToken()
  let success = 0

  for (let i = 0; i < segments.length; i++) {
    let seg = segments[i]
    if (segments.length > 1 && i > 0) seg = `(续${i + 1}/${segments.length})\n${seg}`

    const endpoint = msgType === 'group'
      ? `${cfg.apiBase}/v2/groups/${targetId}/messages`
      : `${cfg.apiBase}/v2/users/${targetId}/messages`
    const s = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `QQBot ${token}` },
      body: JSON.stringify({ content: seg, msg_type: 0 }),
    })
    if (s.ok) success++
    else console.error(`第${i + 1}段发送失败`)
    if (i < segments.length - 1) await sleep(CHUNK_DELAY)
  }
  console.log(`发送完成: ${success}/${segments.length}段`)
}
main().catch(e => console.error(e.message))
