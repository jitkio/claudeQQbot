import type { ToolDef } from '../engine/types.js'
import { readdirSync, statSync, type Stats } from 'fs'
import { resolve, join, relative, sep } from 'path'

// ============================================================
// 常量
// ============================================================

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500
const MAX_DEPTH = 15

/** 默认跳过的目录名（除非显式搜索它们或开启 hidden） */
const DEFAULT_EXCLUDE_DIRS = new Set([
  '.git', '.hg', '.svn',
  'node_modules',
  'dist', 'build', 'out',
  '.next', '.nuxt', '.output',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  'target',             // rust/java
  '.turbo', '.cache',
  'coverage', '.nyc_output',
  '.idea', '.vscode',
  '.gradle',
])

// ============================================================
// 参数类型
// ============================================================

interface GlobArgs {
  pattern: string
  path?: string
  sort_by?: 'mtime' | 'path' | 'size'
  limit?: number
  hidden?: boolean       // 是否扫描 . 开头的文件/目录
}

// ============================================================
// 工具主体
// ============================================================

export const globTool: ToolDef = {
  name: 'glob',
  isReadOnly: true,
  isConcurrencySafe: true,
  description: [
    '按文件名模式搜索文件。支持 * 通配符、** 递归、? 单字符、{a,b} 花括号展开。',
    '默认按修改时间倒序（最新在前），用 sort_by 切换为 path/size。',
    '默认跳过常见构建/依赖目录（node_modules、.git、dist 等）。',
    '输出格式: "<相对时间> <大小> <路径>"，便于快速定位最近改过的文件。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: '搜索模式，如 "*.ts"、"src/**/*.{ts,tsx}"、"**/README.md"',
      },
      path: { type: 'string', description: '搜索目录（默认工作目录）' },
      sort_by: {
        type: 'string',
        enum: ['mtime', 'path', 'size'],
        description: '排序方式：mtime(默认,最新在前)/path(字母序)/size(最大在前)',
      },
      limit: { type: 'number', description: `结果数量上限，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}` },
      hidden: { type: 'boolean', description: '是否扫描以 . 开头的文件/目录，默认 false' },
    },
    required: ['pattern'],
  },

  async execute(args, ctx) {
    const a = args as GlobArgs
    if (!a.pattern) return `[错误] pattern 不能为空`

    const searchDir = a.path ? resolve(ctx.workDir, a.path) : ctx.workDir
    const sortBy = a.sort_by ?? 'mtime'
    const limit = Math.min(Math.max(1, Math.floor(a.limit ?? DEFAULT_LIMIT)), MAX_LIMIT)
    const includeHidden = !!a.hidden

    // 花括号展开 → 多个子 pattern → 合并正则
    const expanded = expandBraces(a.pattern)
    const regexes = expanded.map(p => patternToRegex(p))

    // 扫描
    const matches: Array<{ rel: string; abs: string; stat: Stats }> = []
    const stats = { dirsScanned: 0, filesScanned: 0, skippedDirs: 0 }

    function walk(dir: string, depth: number) {
      if (depth > MAX_DEPTH || matches.length >= limit * 3) return  // 预采 3 倍再排序截断
      stats.dirsScanned++

      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }

      for (const entry of entries) {
        if (!includeHidden && entry.startsWith('.')) continue

        const full = join(dir, entry)
        let st: Stats
        try {
          st = statSync(full)
        } catch {
          continue
        }

        if (st.isDirectory()) {
          if (!includeHidden && DEFAULT_EXCLUDE_DIRS.has(entry)) {
            stats.skippedDirs++
            continue
          }
          walk(full, depth + 1)
        } else if (st.isFile()) {
          stats.filesScanned++
          const rel = relative(searchDir, full) || entry
          // 统一用 / 作为路径分隔符参与匹配（跨平台一致）
          const relNorm = rel.split(sep).join('/')
          if (regexes.some(re => re.test(relNorm))) {
            matches.push({ rel: relNorm, abs: full, stat: st })
          }
        }
      }
    }

    try {
      walk(searchDir, 0)
    } catch (e: any) {
      return `[错误] 扫描失败: ${e.message}`
    }

    // 空结果时给诊断
    if (matches.length === 0) {
      return [
        `未找到匹配 "${a.pattern}" 的文件`,
        `诊断: 扫描了 ${stats.dirsScanned} 个目录 / ${stats.filesScanned} 个文件，跳过 ${stats.skippedDirs} 个默认排除目录。`,
        `建议: 检查通配符是否正确（** 递归、* 单层、{a,b} 花括号），或用 hidden=true 扫描隐藏目录。`,
      ].join('\n')
    }

    // 排序
    if (sortBy === 'mtime') {
      matches.sort((x, y) => y.stat.mtimeMs - x.stat.mtimeMs)
    } else if (sortBy === 'size') {
      matches.sort((x, y) => y.stat.size - x.stat.size)
    } else {
      matches.sort((x, y) => x.rel.localeCompare(y.rel))
    }

    const total = matches.length
    const shown = matches.slice(0, limit)

    // 计算列宽（时间列和大小列对齐）
    const timeCol = shown.map(m => formatRelTime(m.stat.mtimeMs))
    const sizeCol = shown.map(m => formatSize(m.stat.size))
    const timeWidth = Math.max(...timeCol.map(s => s.length), 1)
    const sizeWidth = Math.max(...sizeCol.map(s => s.length), 1)

    const lines: string[] = []
    lines.push(`匹配 ${total} 个文件${total > limit ? `（按 ${sortBy} 排序，显示前 ${limit}）` : `（按 ${sortBy} 排序）`}:`)
    for (let i = 0; i < shown.length; i++) {
      lines.push(
        `  ${timeCol[i].padStart(timeWidth)}  ${sizeCol[i].padStart(sizeWidth)}  ${shown[i].rel}`
      )
    }
    if (total > limit) {
      lines.push(`  ...(还有 ${total - limit} 个，调大 limit 或缩小 pattern 范围)`)
    }

    return lines.join('\n')
  },
}

// ============================================================
// 花括号展开: "src/**/*.{ts,tsx,js}" → ["src/**/*.ts", "src/**/*.tsx", "src/**/*.js"]
// 只支持一层花括号，够用且简单
// ============================================================

function expandBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/)
  if (!match) return [pattern]

  const options = match[1].split(',').map(s => s.trim()).filter(s => s.length > 0)
  if (options.length === 0) return [pattern]

  const prefix = pattern.slice(0, match.index!)
  const suffix = pattern.slice(match.index! + match[0].length)

  // 递归展开剩余的花括号
  const results: string[] = []
  for (const opt of options) {
    const expanded = expandBraces(prefix + opt + suffix)
    results.push(...expanded)
  }
  return results
}

// ============================================================
// glob pattern → RegExp
// 规则:
//   **   → 任意深度（含 0 层）
//   *    → 单层内任意字符（不含 /）
//   ?    → 单个字符（不含 /）
//   其他 → 字面量
// ============================================================

function patternToRegex(pattern: string): RegExp {
  // 如果 pattern 不含任何目录分隔符和 **，就当作"任意目录下的该文件名"
  const implicitRecursive = !pattern.includes('/') && !pattern.includes('**')
  const effective = implicitRecursive ? `**/${pattern}` : pattern

  let re = ''
  let i = 0
  while (i < effective.length) {
    const c = effective[i]
    if (c === '*') {
      if (effective[i + 1] === '*') {
        // ** : 匹配任意目录层（含 0 层）
        // 吃掉可能跟着的 /
        if (effective[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 3
        } else {
          re += '.*'
          i += 2
        }
      } else {
        // * : 单层任意字符
        re += '[^/]*'
        i += 1
      }
    } else if (c === '?') {
      re += '[^/]'
      i += 1
    } else if ('.+()|^$[]{}\\'.includes(c)) {
      re += '\\' + c
      i += 1
    } else {
      re += c
      i += 1
    }
  }

  return new RegExp(`^${re}$`, 'i')
}

// ============================================================
// 格式化辅助
// ============================================================

function formatRelTime(mtimeMs: number): string {
  const diff = Date.now() - mtimeMs
  if (diff < 0) return 'future'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour}h ago`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day}d ago`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month}mo ago`
  const year = Math.floor(day / 365)
  return `${year}y ago`
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`
}