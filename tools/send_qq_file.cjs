// QQ 官方 Bot - 发送富媒体文件（基于 OpenClaw 发现的隐藏 file_name 字段）
const fs = require('fs')
const path = require('path')
const cfg = require('./shared_config.cjs')

const targetId = process.argv[2]
const filePath = process.argv[3]
const msgType = process.argv[4] || 'c2c'

if (!targetId || !filePath) {
  console.error('用法: node send_qq_file.cjs "openid" "/path/to/file" [c2c|group]')
  process.exit(1)
}
if (!fs.existsSync(filePath)) {
  console.error(`文件不存在: ${filePath}`)
  process.exit(1)
}

const API_BASE = cfg.apiBase
const UPLOAD_TIMEOUT_MS = 120_000
const SEND_TIMEOUT_MS = 30_000

function getFileType(fp) {
  const ext = path.extname(fp).toLowerCase()
  if (['.jpg','.jpeg','.png','.gif','.webp','.bmp'].includes(ext)) return 1
  if (['.mp4','.avi','.mkv','.mov','.webm'].includes(ext)) return 2
  if (['.mp3','.wav','.ogg','.flac','.silk','.slk','.amr','.m4a'].includes(ext)) return 3
  return 4
}

function sanitizeFileName(name) {
  if (!name) return name
  let r = String(name).trim()
  if (r.includes('%')) { try { r = decodeURIComponent(r) } catch {} }
  if (typeof r.normalize === 'function') r = r.normalize('NFC')
  r = r.replace(/[\x00-\x1F\x7F]/g, '')
  return r
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 30_000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try { return await fetch(url, { ...opts, signal: ctrl.signal }) }
  finally { clearTimeout(timer) }
}

async function uploadMedia({ token, fileType, fileName, base64Data, endpoint }) {
  const body = { file_type: fileType, file_data: base64Data, srv_send_msg: false }
  if (fileType === 4 && fileName) {
    body.file_name = sanitizeFileName(fileName)   // ★ 关键：隐藏字段
  }
  const resp = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `QQBot ${token}` },
    body: JSON.stringify(body),
  }, UPLOAD_TIMEOUT_MS)
  const text = await resp.text()
  if (!resp.ok) {
    const trace = resp.headers.get('x-tps-trace-id') || ''
    throw new Error(`上传失败 ${resp.status} ${text}${trace ? ` trace=${trace}` : ''}`)
  }
  const data = JSON.parse(text)
  const fileInfo = data.file_info || data.file_uuid
  if (!fileInfo) throw new Error(`响应中未包含 file_info: ${text.slice(0, 200)}`)
  return fileInfo
}

async function sendMediaMessage({ token, targetId, fileInfo, msgType }) {
  const endpoint = msgType === 'group'
    ? `${API_BASE}/v2/groups/${targetId}/messages`
    : `${API_BASE}/v2/users/${targetId}/messages`
  const resp = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `QQBot ${token}` },
    body: JSON.stringify({ msg_type: 7, media: { file_info: fileInfo } }),
  }, SEND_TIMEOUT_MS)
  const text = await resp.text()
  if (!resp.ok) throw new Error(`发送失败 ${resp.status} ${text}`)
  return text
}

async function main() {
  const fileType = getFileType(filePath)
  const fileName = path.basename(filePath)
  const stat = fs.statSync(filePath)
  if (msgType === 'group' && fileType === 4) {
    console.error('[错误] 群聊暂不支持 file_type=4')
    process.exit(2)
  }
  const token = await cfg.getToken()
  const base64Data = fs.readFileSync(filePath).toString('base64')
  const uploadEndpoint = msgType === 'group'
    ? `${API_BASE}/v2/groups/${targetId}/files`
    : `${API_BASE}/v2/users/${targetId}/files`
  console.log(`上传文件: ${fileName} (type=${fileType}, ${(stat.size / 1024).toFixed(1)}KB)`)
  const fileInfo = await uploadMedia({ token, fileType, fileName, base64Data, endpoint: uploadEndpoint })
  console.log(`上传成功`)
  await sendMediaMessage({ token, targetId, fileInfo, msgType })
  console.log(`文件发送成功: ${fileName}`)
}

main().catch(e => { console.error('文件发送异常:', e.message); process.exit(1) })
