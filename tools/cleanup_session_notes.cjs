const __ROOT = require('path').resolve(__dirname, '..')
// 清理 30 天未更新的会话笔记
const fs = require('fs')
const path = require('path')

const NOTES_DIR = __ROOT + '/workspace/session_notes'
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000  // 30 天

try {
  const files = fs.readdirSync(NOTES_DIR)
  let cleaned = 0
  for (const f of files) {
    if (f === '_template.md') continue
    const fp = path.join(NOTES_DIR, f)
    const stat = fs.statSync(fp)
    if (Date.now() - stat.mtimeMs > MAX_AGE_MS) {
      fs.unlinkSync(fp)
      cleaned++
    }
  }
  if (cleaned > 0) console.log(`[清理] 删除了 ${cleaned} 个过期会话笔记`)
} catch (e) {
  console.error('会话笔记清理失败:', e.message)
}
