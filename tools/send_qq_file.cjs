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

function getFileType(fp) {
  const ext = path.extname(fp).toLowerCase()
  if (['.jpg','.jpeg','.png','.gif','.webp','.bmp'].includes(ext)) return 1
  if (['.mp4','.avi','.mkv','.mov','.webm'].includes(ext)) return 2
  if (['.mp3','.wav','.ogg','.flac','.silk','.slk','.amr','.m4a'].includes(ext)) return 3
  return 4
}

async function main() {
  const token = await cfg.getToken()
  const fileType = getFileType(filePath)
  const base64Data = fs.readFileSync(filePath).toString('base64')
  const fileName = path.basename(filePath)

  console.log(`上传文件: ${fileName} (type=${fileType})`)

  const uploadEndpoint = msgType === 'group'
    ? `${cfg.apiBase}/v2/groups/${targetId}/files`
    : `${cfg.apiBase}/v2/users/${targetId}/files`

  const uploadResp = await fetch(uploadEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `QQBot ${token}` },
    body: JSON.stringify({ file_type: fileType, file_data: base64Data, srv_send_msg: false }),
  })

  if (!uploadResp.ok) {
    console.error(`上传失败(${uploadResp.status}): ${await uploadResp.text()}`)
    process.exit(1)
  }

  const uploadData = await uploadResp.json()
  const fileInfo = uploadData.file_info || uploadData.file_uuid
  if (!fileInfo) { console.error('未获得 file_info'); process.exit(1) }

  const sendEndpoint = msgType === 'group'
    ? `${cfg.apiBase}/v2/groups/${targetId}/messages`
    : `${cfg.apiBase}/v2/users/${targetId}/messages`

  const sendResp = await fetch(sendEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `QQBot ${token}` },
    body: JSON.stringify({ msg_type: 7, media: { file_info: fileInfo } }),
  })

  console.log(sendResp.ok ? `文件发送成功: ${fileName}` : `文件发送失败: ${await sendResp.text()}`)
}
main().catch(e => { console.error('文件发送异常:', e.message); process.exit(1) })
