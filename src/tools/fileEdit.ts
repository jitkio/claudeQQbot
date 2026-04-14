import type { ToolDef } from '../engine/types.js'
import { readFileSync, writeFileSync, statSync } from 'fs'
import { resolve } from 'path'

// ============================================================
// 参数类型
// ============================================================

interface SingleEditSpec {
  old_string: string
  new_string: string
  replace_all?: boolean
}

interface EditArgs {
  path: string
  // 单次编辑（向后兼容老调用）
  old_string?: string
  new_string?: string
  replace_all?: boolean
  // 多次编辑（新能力）
  edits?: SingleEditSpec[]
}

// ============================================================
// 工具主体
// ============================================================

export const fileEditTool: ToolDef = {
  name: 'edit_file',
  isReadOnly: false,
  isConcurrencySafe: false,
  description: [
    '编辑文件：在文件中查找指定文本并替换。支持两种模式：',
    '1) 单次编辑：提供 old_string 和 new_string；',
    '2) 批量编辑：提供 edits 数组，按顺序应用多处替换（任一失败则全部回滚）。',
    '每条编辑可设 replace_all=true 来替换所有匹配；否则要求 old_string 在文件中唯一。',
    '使用前建议先用 read_file 读取带行号的内容，确保 old_string 精确匹配（含缩进和空格）。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对工作目录或绝对路径）' },
      old_string: { type: 'string', description: '[单次模式] 要被替换的原始文本（必须精确匹配）' },
      new_string: { type: 'string', description: '[单次模式] 替换后的新文本' },
      replace_all: { type: 'boolean', description: '[单次模式] 是否替换所有出现，默认 false' },
      edits: {
        type: 'array',
        description: '[批量模式] 编辑列表，按顺序应用。与单次模式二选一。',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string' },
            new_string: { type: 'string' },
            replace_all: { type: 'boolean' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path'],
  },

  async execute(args, ctx) {
    const a = args as EditArgs
    const filePath = resolve(ctx.workDir, a.path)

    // --- 1. 解析编辑列表（统一把单次模式转成 edits 数组）---
    const edits: SingleEditSpec[] = []
    if (Array.isArray(a.edits) && a.edits.length > 0) {
      edits.push(...a.edits)
    } else if (typeof a.old_string === 'string' && typeof a.new_string === 'string') {
      edits.push({
        old_string: a.old_string,
        new_string: a.new_string,
        replace_all: a.replace_all,
      })
    } else {
      return `[错误] 必须提供 old_string+new_string 或 edits 数组其中之一`
    }

    // --- 2. 验证每条编辑自身合法性 ---
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i]
      if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') {
        return `[错误] 第 ${i + 1} 条编辑缺少 old_string 或 new_string`
      }
      if (e.old_string === e.new_string) {
        return `[错误] 第 ${i + 1} 条编辑的 old_string 与 new_string 相同，无需编辑`
      }
      if (e.old_string === '') {
        return `[错误] 第 ${i + 1} 条编辑的 old_string 不能为空（如需创建文件请用 write_file）`
      }
    }

    // --- 3. 读取原文件 ---
    let original: string
    try {
      const stat = statSync(filePath)
      if (stat.isDirectory()) return `[错误] ${filePath} 是目录，不是文件`
      if (stat.size > 5 * 1024 * 1024) {
        return `[错误] 文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，不支持编辑`
      }
      original = readFileSync(filePath, 'utf-8')
    } catch (e: any) {
      if (e.code === 'ENOENT') return `[错误] 文件不存在: ${filePath}（如需新建请用 write_file）`
      return `[错误] 读取文件失败: ${e.message}`
    }

    // --- 4. 依次应用编辑（内存中，任一失败则全盘放弃）---
    let working = original
    const applied: { index: number; count: number }[] = []

    for (let i = 0; i < edits.length; i++) {
      const e = edits[i]
      const occurrences = countOccurrences(working, e.old_string)

      if (occurrences === 0) {
        // 给出诊断信息
        const hint = diagnoseFailedMatch(working, e.old_string)
        const header = edits.length > 1
          ? `[错误] 第 ${i + 1} 条编辑失败：未找到 old_string。整批编辑已取消，文件未改动。`
          : `[错误] 未找到要替换的文本。`
        return `${header}\n${hint}`
      }

      if (occurrences > 1 && !e.replace_all) {
        const header = edits.length > 1
          ? `[错误] 第 ${i + 1} 条编辑失败：old_string 出现了 ${occurrences} 次。`
          : `[错误] old_string 在文件中出现了 ${occurrences} 次。`
        return `${header}\n请提供更多上下文使其唯一，或设置 replace_all=true 以替换全部。`
      }

      working = e.replace_all
        ? replaceAll(working, e.old_string, e.new_string)
        : working.replace(e.old_string, e.new_string)

      applied.push({ index: i + 1, count: occurrences })
    }

    // --- 5. 没有任何改动？直接告知 ---
    if (working === original) {
      return `[提示] 编辑已应用但内容无变化（可能 new_string 与 old_string 在效果上等价）`
    }

    // --- 6. 写回文件 ---
    try {
      writeFileSync(filePath, working, 'utf-8')
    } catch (e: any) {
      return `[错误] 写入文件失败: ${e.message}`
    }

    // --- 7. 生成 diff 预览返回给模型 ---
    const diff = buildCompactDiff(original, working, 2, 40)
    const summary = edits.length > 1
      ? `文件已编辑: ${filePath}（应用了 ${edits.length} 条编辑，${applied.reduce((s, x) => s + x.count, 0)} 处替换）`
      : `文件已编辑: ${filePath}（${applied[0].count} 处替换）`

    return `${summary}\n\n${diff}`
  },
}

// ============================================================
// 辅助函数
// ============================================================

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = 0
  while ((idx = hay.indexOf(needle, idx)) !== -1) {
    count++
    idx += needle.length
  }
  return count
}

function replaceAll(hay: string, needle: string, replacement: string): string {
  if (!needle) return hay
  return hay.split(needle).join(replacement)
}

/**
 * 当 old_string 匹配失败时，给出诊断信息：
 * 1. 尝试空白归一化匹配——提示「可能是空格/缩进问题」
 * 2. 尝试用首行定位——告诉模型文件里类似的行在哪
 */
function diagnoseFailedMatch(fileContent: string, target: string): string {
  const lines: string[] = []

  // 策略 1: 空白归一化匹配
  const normFile = normalizeWhitespace(fileContent)
  const normTarget = normalizeWhitespace(target)
  if (normTarget && normFile.includes(normTarget)) {
    lines.push('诊断: 忽略空白字符后可以匹配到内容，很可能是缩进或空格数量不一致。')
    lines.push('建议: 先用 read_file 读取带行号的原文，按原样复制 old_string（注意 Tab/Space 和行首空格）。')
    return lines.join('\n')
  }

  // 策略 2: 首行定位
  const firstLine = target.split('\n')[0]?.trim()
  if (firstLine && firstLine.length >= 4) {
    const fileLines = fileContent.split('\n')
    const hits: number[] = []
    for (let i = 0; i < fileLines.length && hits.length < 3; i++) {
      if (fileLines[i].includes(firstLine)) hits.push(i + 1)
    }
    if (hits.length > 0) {
      lines.push(`诊断: 未找到完整匹配，但 old_string 的首行内容在文件第 ${hits.join(', ')} 行附近出现。`)
      lines.push('建议: 该处可能与 old_string 后续行存在差异（空白、换行、括号等），重新读取后再编辑。')
      return lines.join('\n')
    }
  }

  lines.push('诊断: 文件中完全找不到 old_string 的任何近似内容。')
  lines.push('建议: 先用 read_file 确认文件当前内容，old_string 可能已被之前的编辑修改过。')
  return lines.join('\n')
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 生成紧凑 diff 预览。
 * 只显示发生变化的区块（带 ctxLines 行上下文），避免把整个文件刷给模型。
 * maxLines 限制总输出行数。
 */
function buildCompactDiff(
  before: string,
  after: string,
  ctxLines: number,
  maxLines: number,
): string {
  const a = before.split('\n')
  const b = after.split('\n')

  // 找出第一处和最后一处不同行（粗粒度，够用）
  let firstDiff = -1
  let lastDiffA = -1
  let lastDiffB = -1

  const minLen = Math.min(a.length, b.length)
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) {
      if (firstDiff === -1) firstDiff = i
      lastDiffA = i
      lastDiffB = i
    }
  }
  if (a.length !== b.length) {
    if (firstDiff === -1) firstDiff = minLen
    lastDiffA = a.length - 1
    lastDiffB = b.length - 1
  }
  if (firstDiff === -1) return '(无可视差异)'

  const startA = Math.max(0, firstDiff - ctxLines)
  const endA = Math.min(a.length - 1, lastDiffA + ctxLines)
  const startB = Math.max(0, firstDiff - ctxLines)
  const endB = Math.min(b.length - 1, lastDiffB + ctxLines)

  const out: string[] = []
  out.push('--- 变更预览 ---')
  out.push(`@@ 修改前 ${startA + 1}-${endA + 1} / 修改后 ${startB + 1}-${endB + 1} @@`)

  let lineBudget = maxLines - 2

  // 修改前片段
  for (let i = startA; i <= endA && lineBudget > 0; i++, lineBudget--) {
    out.push(`- ${a[i]}`)
  }
  if (endA < a.length - 1 && lastDiffA > endA) out.push('  ...')

  // 修改后片段
  out.push('---')
  lineBudget = Math.max(lineBudget, Math.floor(maxLines / 2))
  for (let i = startB; i <= endB && lineBudget > 0; i++, lineBudget--) {
    out.push(`+ ${b[i]}`)
  }
  if (endB < b.length - 1 && lastDiffB > endB) out.push('  ...')

  return out.join('\n')
}