const __ROOT = require('path').resolve(__dirname, '..')
// 会话笔记管理工具
// 用法:
//   node session_notes.cjs read "sessionKey"           — 读取会话笔记
//   node session_notes.cjs append "sessionKey" "内容"   — 追加记录
//   node session_notes.cjs summary "sessionKey"         — 生成简短摘要头

const fs = require('fs')
const path = require('path')

const NOTES_DIR = __ROOT + '/workspace/session_notes'
const TEMPLATE = fs.readFileSync(path.join(NOTES_DIR, '_template.md'), 'utf-8').trim()
const MAX_NOTES_LENGTH = 3000  // 限制注入到 prompt 的最大长度

const action = process.argv[2]
const sessionKey = process.argv[3]

if (!action || !sessionKey) {
  console.error('用法: node session_notes.cjs read|append|summary "sessionKey" ["内容"]')
  process.exit(1)
}

// 安全化文件名
const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_')
const notesPath = path.join(NOTES_DIR, `${safeKey}.md`)

function readNotes() {
  try {
    return fs.readFileSync(notesPath, 'utf-8')
  } catch {
    return ''
  }
}

function writeNotes(content) {
  fs.writeFileSync(notesPath, content)
}

if (action === 'read') {
  const notes = readNotes()
  if (!notes) {
    console.log('')  // 空笔记
  } else {
    // 如果笔记太长，截取最后部分（保留模板头 + 最新记录）
    if (notes.length > MAX_NOTES_LENGTH) {
      const lines = notes.split('\n')
      // 保留前 5 行（模板头）+ 最后的内容
      const header = lines.slice(0, 6).join('\n')
      const tail = notes.slice(-MAX_NOTES_LENGTH + header.length)
      const lastNewline = tail.indexOf('\n')
      console.log(header + '\n\n[...早期记录已省略...]\n' + tail.slice(lastNewline))
    } else {
      console.log(notes)
    }
  }
} else if (action === 'append') {
  const content = process.argv[4]
  if (!content) { console.error('缺少追加内容'); process.exit(1) }

  let notes = readNotes()
  if (!notes) {
    // 首次创建：用模板初始化
    notes = TEMPLATE
  }

  const timestamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  const entry = `\n[${timestamp}] ${content}`

  // 追加到"工作日志"段落末尾
  const logSection = '# 工作日志'
  const logIdx = notes.indexOf(logSection)
  if (logIdx !== -1) {
    // 找到下一个 # 段落或文件末尾
    const nextSection = notes.indexOf('\n# ', logIdx + logSection.length)
    const insertAt = nextSection === -1 ? notes.length : nextSection
    notes = notes.slice(0, insertAt) + entry + '\n' + notes.slice(insertAt)
  } else {
    // 没有工作日志段落，追加到末尾
    notes += '\n\n# 工作日志\n' + entry
  }

  writeNotes(notes)
  console.log('已追加')
} else if (action === 'summary') {
  const notes = readNotes()
  if (!notes) {
    console.log('')
    process.exit(0)
  }

  // 提取"当前状态"段落作为摘要
  const lines = notes.split('\n')
  let inSection = false
  let summary = []
  for (const line of lines) {
    if (line.startsWith('# 当前状态')) { inSection = true; continue }
    if (line.startsWith('# ') && inSection) break
    if (inSection && line.trim() && !line.startsWith('_')) {
      summary.push(line.trim())
    }
  }
  console.log(summary.join(' ').slice(0, 200) || '（无当前状态记录）')
} else {
  console.error('未知操作:', action)
  process.exit(1)
}
