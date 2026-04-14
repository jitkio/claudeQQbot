import type { ToolDef } from '../engine/types.js'
import { readFileSync, statSync, openSync, readSync, closeSync } from 'fs'
import { resolve, extname } from 'path'

// ============================================================
// 常量
// ============================================================

const MAX_FILE_SIZE = 10 * 1024 * 1024       // 10 MB 硬上限
const DEFAULT_LIMIT = 2000                    // 默认最多读 2000 行
const MAX_LINE_LENGTH = 2000                  // 单行截断阈值
const BINARY_PROBE_BYTES = 8 * 1024           // 二进制检测采样 8KB

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'])
const BINARY_EXTS = new Set([
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.class',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.flac', '.mkv',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.db', '.sqlite', '.sqlite3',
])

// ============================================================
// 参数类型
// ============================================================

interface ReadArgs {
  path: string
  offset?: number     // 起始行号（1-indexed）
  limit?: number      // 最多读多少行
}

// ============================================================
// 工具主体
// ============================================================

export const fileReadTool: ToolDef = {
  name: 'read_file',
  isReadOnly: true,
  isConcurrencySafe: true,
  description: [
    '读取文件内容，返回带行号前缀的文本（格式 "   42→内容"），便于后续 edit_file 定位。',
    '可用 offset（起始行，从 1 开始）和 limit（最多行数）读取大文件的某一段。',
    '自动检测二进制/图片文件并给出元信息；.ipynb 笔记会解析成 cells。',
    '单行超过 2000 字符会被截断以防上下文爆炸。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对工作目录或绝对路径）' },
      offset: { type: 'number', description: '起始行号，从 1 开始，默认 1' },
      limit: { type: 'number', description: '最多读取行数，默认 2000' },
    },
    required: ['path'],
  },

  async execute(args, ctx) {
    const a = args as ReadArgs
    const filePath = resolve(ctx.workDir, a.path)

    // --- 1. stat 检查 ---
    let stat
    try {
      stat = statSync(filePath)
    } catch (e: any) {
      if (e.code === 'ENOENT') return `[错误] 文件不存在: ${filePath}`
      return `[错误] 读取文件失败: ${e.message}`
    }
    if (stat.isDirectory()) {
      return `[错误] ${filePath} 是目录，不是文件。用 glob 工具列出目录内容。`
    }
    if (stat.size === 0) {
      return `(文件为空: ${filePath})`
    }
    if (stat.size > MAX_FILE_SIZE) {
      return `[错误] 文件过大 (${formatBytes(stat.size)}，上限 ${formatBytes(MAX_FILE_SIZE)})。请用 grep 或 bash 处理。`
    }

    const ext = extname(filePath).toLowerCase()

    // --- 2. 图片文件：返回元信息，不读内容 ---
    if (IMAGE_EXTS.has(ext)) {
      const dims = tryReadImageDimensions(filePath, ext)
      const sizeStr = formatBytes(stat.size)
      const dimStr = dims ? `${dims.width}×${dims.height}` : '未知尺寸'
      return [
        `[图片文件] ${filePath}`,
        `类型: ${ext.slice(1).toUpperCase()}  大小: ${sizeStr}  尺寸: ${dimStr}`,
        `提示: 当前工具返回的是图片元信息。如需让视觉模型分析图片内容，请在回复中直接引用该路径。`,
      ].join('\n')
    }

    // --- 3. 已知二进制扩展名：直接拒绝 ---
    if (BINARY_EXTS.has(ext)) {
      return `[错误] ${ext} 是二进制文件格式 (${formatBytes(stat.size)})，无法作为文本读取。`
    }

    // --- 4. 未知扩展名：采样检测是否二进制 ---
    if (isLikelyBinary(filePath, stat.size)) {
      return `[错误] 文件疑似二进制内容 (${formatBytes(stat.size)})，无法作为文本读取。若确定是文本可用 bash 工具的 cat 命令。`
    }

    // --- 5. Jupyter Notebook 特殊处理 ---
    if (ext === '.ipynb') {
      try {
        const raw = readFileSync(filePath, 'utf-8')
        return renderNotebook(raw, filePath)
      } catch (e: any) {
        return `[错误] 解析 .ipynb 失败: ${e.message}`
      }
    }

    // --- 6. 普通文本文件：读取 + 行号化 ---
    let content: string
    try {
      content = readFileSync(filePath, 'utf-8')
    } catch (e: any) {
      return `[错误] 读取文件失败: ${e.message}`
    }

    // CRLF → LF 归一化（否则 edit_file 后续匹配容易踩坑）
    const normalized = content.replace(/\r\n/g, '\n')
    const allLines = normalized.split('\n')
    const totalLines = allLines.length

    // 解析 offset / limit
    const offset = Math.max(1, Math.floor(a.offset ?? 1))
    const limit = Math.max(1, Math.floor(a.limit ?? DEFAULT_LIMIT))

    if (offset > totalLines) {
      return `[错误] offset=${offset} 超出文件总行数 (${totalLines} 行)`
    }

    const startIdx = offset - 1
    const endIdx = Math.min(totalLines, startIdx + limit)
    const slice = allLines.slice(startIdx, endIdx)

    // 行号前缀宽度：按文件末行号算，保证对齐
    const numWidth = String(endIdx).length

    const numberedLines = slice.map((line, i) => {
      const lineNo = String(startIdx + i + 1).padStart(numWidth, ' ')
      let content = line
      if (content.length > MAX_LINE_LENGTH) {
        content = content.slice(0, MAX_LINE_LENGTH) + ` … [该行截断，原长 ${line.length} 字符]`
      }
      return `${lineNo}→${content}`
    })

    const body = numberedLines.join('\n')

    // --- 7. 头部/尾部元信息 ---
    const header: string[] = []
    if (offset > 1 || endIdx < totalLines) {
      header.push(`(显示 ${offset}-${endIdx} 行 / 共 ${totalLines} 行)`)
    }
    const footer: string[] = []
    if (endIdx < totalLines) {
      footer.push(`\n... (文件还有 ${totalLines - endIdx} 行未显示，使用 offset=${endIdx + 1} 继续读)`)
    }

    return [...header, body, ...footer].join('\n')
  },
}

// ============================================================
// 辅助函数
// ============================================================

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/**
 * 通过采样文件头部字节判断是否二进制。
 * 规则：前 8KB 内出现 NUL 字节 或 非 UTF-8 控制字符比例 > 30%
 */
function isLikelyBinary(filePath: string, size: number): boolean {
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    const probeSize = Math.min(BINARY_PROBE_BYTES, size)
    const buf = Buffer.alloc(probeSize)
    readSync(fd, buf, 0, probeSize, 0)

    let nonText = 0
    for (let i = 0; i < probeSize; i++) {
      const b = buf[i]
      if (b === 0) return true  // NUL 字节 = 二进制铁证
      // 可打印 ASCII + 常见空白 + UTF-8 高位字节
      if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d || b >= 0x80) continue
      nonText++
    }
    return nonText / probeSize > 0.3
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
  }
}

/**
 * 读取图片尺寸（只支持 PNG/JPEG/GIF/BMP 的文件头解析，无依赖）
 * 失败返回 null，不影响主流程
 */
function tryReadImageDimensions(filePath: string, ext: string): { width: number; height: number } | null {
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(64)
    readSync(fd, buf, 0, 64, 0)

    if (ext === '.png') {
      // PNG: 宽高在第 16-23 字节（IHDR chunk）
      if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
      }
    }
    if (ext === '.gif') {
      // GIF: 宽高在第 6-9 字节（小端）
      if (buf.slice(0, 3).toString() === 'GIF') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
      }
    }
    if (ext === '.bmp') {
      if (buf.slice(0, 2).toString() === 'BM') {
        return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) }
      }
    }
    // JPEG 的尺寸需要扫描 SOF marker，复杂度较高，暂不解析
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
  }
}

/**
 * 把 .ipynb JSON 渲染成人类可读的文本
 */
function renderNotebook(raw: string, filePath: string): string {
  let nb: any
  try {
    nb = JSON.parse(raw)
  } catch (e: any) {
    return `[错误] .ipynb 不是合法 JSON: ${e.message}`
  }
  const cells = Array.isArray(nb.cells) ? nb.cells : []
  if (cells.length === 0) return `(空 notebook: ${filePath})`

  const out: string[] = [`[Jupyter Notebook] ${filePath}  共 ${cells.length} 个 cell\n`]
  cells.forEach((cell: any, i: number) => {
    const type = cell.cell_type ?? 'unknown'
    const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '')
    out.push(`--- Cell ${i + 1} [${type}] ---`)
    out.push(src.trim() || '(空)')

    // 代码 cell 可能有输出
    if (type === 'code' && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
      const textOut: string[] = []
      for (const o of cell.outputs) {
        if (o.text) textOut.push(Array.isArray(o.text) ? o.text.join('') : String(o.text))
        else if (o.data?.['text/plain']) {
          const t = o.data['text/plain']
          textOut.push(Array.isArray(t) ? t.join('') : String(t))
        }
      }
      if (textOut.length > 0) {
        out.push('--- 输出 ---')
        const combined = textOut.join('\n').trim()
        out.push(combined.length > 500 ? combined.slice(0, 500) + ' …[截断]' : combined)
      }
    }
    out.push('')
  })
  return out.join('\n')
}