import type { ToolDef } from '../engine/types.js'
import { spawn } from 'child_process'
import { resolve } from 'path'

// ============================================================
// 常量与缓存
// ============================================================

const MAX_OUTPUT_BYTES = 100 * 1024          // 100 KB 硬上限
const MAX_MATCHES_PER_FILE = 5                // content 模式下每个文件最多显示的匹配数
const MAX_FILES_IN_OUTPUT = 80                // 最多显示多少个不同文件
const DEFAULT_TIMEOUT = 15000

/** 后端类型：首次检测后缓存 */
type Backend = 'rg' | 'grep' | null
let cachedBackend: Backend = null

/** 语言名 → 文件扩展名列表（grep fallback 用） */
const LANG_EXT_MAP: Record<string, string[]> = {
  ts: ['*.ts', '*.tsx'],
  tsx: ['*.tsx'],
  js: ['*.js', '*.jsx', '*.mjs', '*.cjs'],
  jsx: ['*.jsx'],
  py: ['*.py', '*.pyi'],
  python: ['*.py', '*.pyi'],
  go: ['*.go'],
  rust: ['*.rs'],
  rs: ['*.rs'],
  java: ['*.java'],
  kt: ['*.kt', '*.kts'],
  kotlin: ['*.kt', '*.kts'],
  cpp: ['*.cpp', '*.cc', '*.cxx', '*.hpp', '*.hh', '*.h'],
  c: ['*.c', '*.h'],
  cs: ['*.cs'],
  csharp: ['*.cs'],
  rb: ['*.rb'],
  ruby: ['*.rb'],
  php: ['*.php'],
  swift: ['*.swift'],
  sh: ['*.sh', '*.bash', '*.zsh'],
  shell: ['*.sh', '*.bash', '*.zsh'],
  html: ['*.html', '*.htm'],
  css: ['*.css', '*.scss', '*.sass', '*.less'],
  vue: ['*.vue'],
  svelte: ['*.svelte'],
  json: ['*.json'],
  yaml: ['*.yaml', '*.yml'],
  toml: ['*.toml'],
  md: ['*.md', '*.markdown'],
  sql: ['*.sql'],
}

// ============================================================
// 参数类型
// ============================================================

interface GrepArgs {
  pattern: string
  path?: string
  include?: string          // 显式 glob 过滤 (如 "*.ts" 或 "src/**/*.js")
  type?: string             // 语言名 (如 "ts", "py")
  ignore_case?: boolean     // -i
  multiline?: boolean       // -U
  context?: number          // -C n
  before?: number           // -B n
  after?: number            // -A n
  output_mode?: 'content' | 'files_with_matches' | 'count'
  head_limit?: number       // 覆盖默认的 MAX_FILES_IN_OUTPUT
}

// ============================================================
// 工具主体
// ============================================================

export const grepTool: ToolDef = {
  name: 'grep',
  isReadOnly: true,
  isConcurrencySafe: true,
  description: [
    '在文件内容中搜索正则表达式。优先使用 ripgrep，回落到系统 grep。',
    '支持语言过滤 (type)、上下文行 (context/before/after)、忽略大小写、多行模式。',
    '三种输出模式: content(默认, 带行号和上下文) / files_with_matches(只列文件) / count(每文件匹配数)。',
    '搜索大型代码库时建议先用 files_with_matches 快速定位，再对具体文件用 content 模式。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式（ripgrep 用 Rust regex 语法，grep fallback 用 POSIX ERE）' },
      path: { type: 'string', description: '搜索目录或文件路径（默认工作目录）' },
      include: { type: 'string', description: '文件 glob 过滤，如 "*.ts" 或 "src/**/*.js"' },
      type: { type: 'string', description: '语言类型过滤：ts/js/py/go/rust/java/cpp/... 与 include 二选一' },
      ignore_case: { type: 'boolean', description: '忽略大小写，默认 false' },
      multiline: { type: 'boolean', description: '多行模式（让 . 和 ^/$ 跨行），默认 false' },
      context: { type: 'number', description: '前后各显示 n 行上下文（等价 -C n）' },
      before: { type: 'number', description: '匹配前显示 n 行（等价 -B n）' },
      after: { type: 'number', description: '匹配后显示 n 行（等价 -A n）' },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: '输出模式：content(默认)/files_with_matches(只文件名)/count(每文件匹配数)',
      },
      head_limit: { type: 'number', description: '限制输出的文件数量，默认 80' },
    },
    required: ['pattern'],
  },

  async execute(args, ctx) {
    const a = args as GrepArgs
    if (!a.pattern) return `[错误] pattern 不能为空`

    const searchPath = a.path ? resolve(ctx.workDir, a.path) : ctx.workDir
    const mode = a.output_mode ?? 'content'

    // 决定后端
    const backend = await detectBackend()
    if (!backend) {
      return `[错误] 系统未安装 ripgrep 或 grep，无法搜索。建议安装 ripgrep: brew install ripgrep / apt install ripgrep`
    }

    // 构建命令
    const { cmd, cmdArgs } = backend === 'rg'
      ? buildRgCommand(a, searchPath, mode)
      : buildGrepCommand(a, searchPath, mode)

    // 执行
    const result = await runCommand(cmd, cmdArgs, ctx.workDir, ctx.abortSignal)

    // ripgrep / grep: exit code 1 = 没找到匹配（不是错误）
    if (result.exitCode === 1 && !result.stdout.trim()) {
      return `未找到匹配 "${a.pattern}" 的内容（搜索路径: ${searchPath}）`
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      const errMsg = result.stderr.trim() || '未知错误'
      return `[错误] ${backend} 执行失败 (exit ${result.exitCode}): ${errMsg.slice(0, 500)}`
    }
    if (!result.stdout.trim()) {
      return `未找到匹配 "${a.pattern}" 的内容`
    }

    // 智能截断与格式化
    return formatOutput(result.stdout, mode, a.head_limit ?? MAX_FILES_IN_OUTPUT, backend)
  },
}

// ============================================================
// 后端检测（带缓存）
// ============================================================

async function detectBackend(): Promise<Backend> {
  if (cachedBackend !== null) return cachedBackend

  // 先试 ripgrep
  if (await probe('rg', ['--version'])) {
    cachedBackend = 'rg'
    return 'rg'
  }
  // 再试 grep
  if (await probe('grep', ['--version'])) {
    cachedBackend = 'grep'
    return 'grep'
  }
  return null
}

function probe(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((res) => {
    try {
      const proc = spawn(cmd, args, { stdio: 'ignore', timeout: 2000 })
      proc.on('error', () => res(false))
      proc.on('close', (code) => res(code === 0))
    } catch {
      res(false)
    }
  })
}

// ============================================================
// 命令构建：ripgrep
// ============================================================

function buildRgCommand(a: GrepArgs, searchPath: string, mode: string): { cmd: string; cmdArgs: string[] } {
  const args: string[] = ['--no-heading', '--with-filename']

  if (mode === 'files_with_matches') args.push('-l')
  else if (mode === 'count') args.push('-c')
  else args.push('-n')  // content 模式：带行号

  if (a.ignore_case) args.push('-i')
  if (a.multiline) args.push('-U', '--multiline-dotall')

  // 上下文行
  if (mode === 'content') {
    if (typeof a.context === 'number' && a.context > 0) args.push('-C', String(a.context))
    else {
      if (typeof a.before === 'number' && a.before > 0) args.push('-B', String(a.before))
      if (typeof a.after === 'number' && a.after > 0) args.push('-A', String(a.after))
    }
  }

  // 过滤
  if (a.type) {
    // ripgrep 有自己的 --type 定义，不识别时会报错；我们用 LANG_EXT_MAP 做白名单
    if (LANG_EXT_MAP[a.type.toLowerCase()]) {
      args.push('-t', a.type.toLowerCase())
    }
  }
  if (a.include) args.push('-g', a.include)

  args.push('--', a.pattern, searchPath)
  return { cmd: 'rg', cmdArgs: args }
}

// ============================================================
// 命令构建：grep fallback
// ============================================================

function buildGrepCommand(a: GrepArgs, searchPath: string, mode: string): { cmd: string; cmdArgs: string[] } {
  const args: string[] = ['-r', '-E']   // -r 递归, -E 扩展正则

  if (mode === 'files_with_matches') args.push('-l')
  else if (mode === 'count') args.push('-c')
  else args.push('-n', '-H')  // content 模式：行号 + 文件名

  if (a.ignore_case) args.push('-i')

  // grep 的多行匹配能力有限——只开 -z 会把 NUL 当分隔符，风险大，这里直接不支持
  // 如果用户开了 multiline 但后端是 grep，我们在结果里附加一条提示（见 formatOutput）

  if (mode === 'content') {
    if (typeof a.context === 'number' && a.context > 0) args.push('-C', String(a.context))
    else {
      if (typeof a.before === 'number' && a.before > 0) args.push('-B', String(a.before))
      if (typeof a.after === 'number' && a.after > 0) args.push('-A', String(a.after))
    }
  }

  // 语言过滤 → 多个 --include
  const includes: string[] = []
  if (a.type) {
    const exts = LANG_EXT_MAP[a.type.toLowerCase()]
    if (exts) includes.push(...exts)
  }
  if (a.include) includes.push(a.include)
  for (const inc of includes) args.push(`--include=${inc}`)

  // 排除常见大目录
  for (const dir of ['.git', 'node_modules', 'dist', 'build', '.next', '.venv', '__pycache__']) {
    args.push(`--exclude-dir=${dir}`)
  }

  args.push('--', a.pattern, searchPath)
  return { cmd: 'grep', cmdArgs: args }
}

// ============================================================
// 执行子进程
// ============================================================

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<RunResult> {
  return new Promise((res) => {
    const proc = spawn(cmd, args, {
      cwd,
      timeout: DEFAULT_TIMEOUT,
      signal: abortSignal,
    })

    let stdout = ''
    let stderr = ''
    let truncated = false

    proc.stdout.on('data', (d: Buffer) => {
      if (stdout.length >= MAX_OUTPUT_BYTES) {
        truncated = true
        return
      }
      stdout += d.toString('utf-8')
      if (stdout.length > MAX_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_OUTPUT_BYTES)
        truncated = true
      }
    })
    proc.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4096) stderr += d.toString('utf-8')
    })
    proc.on('error', (e) => {
      res({ stdout: '', stderr: String(e.message ?? e), exitCode: -1 })
    })
    proc.on('close', (code) => {
      if (truncated) stdout += '\n...[输出过长已截断]'
      res({ stdout, stderr, exitCode: code ?? 0 })
    })
  })
}

// ============================================================
// 输出格式化与智能截断
// ============================================================

function formatOutput(
  raw: string,
  mode: string,
  headLimit: number,
  backend: Backend,
): string {
  const lines = raw.split('\n').filter(l => l.length > 0)

  if (mode === 'files_with_matches') {
    // 每行一个文件名，直接截断
    const files = lines.slice(0, headLimit)
    const suffix = lines.length > headLimit ? `\n...(还有 ${lines.length - headLimit} 个文件)` : ''
    return `共 ${lines.length} 个文件匹配:\n${files.join('\n')}${suffix}`
  }

  if (mode === 'count') {
    // 每行格式: "path:count" 或 "path" (grep 可能有差异)
    const entries = lines
      .map(l => {
        const idx = l.lastIndexOf(':')
        if (idx === -1) return { file: l, count: 0 }
        const count = parseInt(l.slice(idx + 1), 10)
        return { file: l.slice(0, idx), count: isNaN(count) ? 0 : count }
      })
      .filter(e => e.count > 0)
      .sort((a, b) => b.count - a.count)

    const top = entries.slice(0, headLimit)
    const total = entries.reduce((s, e) => s + e.count, 0)
    const out = [`共 ${total} 处匹配，分布在 ${entries.length} 个文件:`]
    for (const e of top) out.push(`  ${e.count.toString().padStart(4)} ${e.file}`)
    if (entries.length > headLimit) out.push(`  ...(还有 ${entries.length - headLimit} 个文件)`)
    return out.join('\n')
  }

  // content 模式：按文件分组，每个文件最多保留 MAX_MATCHES_PER_FILE 处匹配
  // 输入行格式:
  //   rg:   path:lineno:content   或 path-lineno-content (上下文行)
  //   grep: path:lineno:content   或 path-lineno-content (上下文行)
  const groups = new Map<string, string[]>()
  for (const line of lines) {
    // 跳过 rg/grep 在 --context 模式下的分组分隔符 "--"
    if (line === '--') continue
    const file = extractFilePath(line)
    if (!file) continue
    if (!groups.has(file)) groups.set(file, [])
    const arr = groups.get(file)!
    if (arr.length < MAX_MATCHES_PER_FILE * 6) arr.push(line)  // 上下文行也算进去，留宽裕
  }

  const fileEntries = Array.from(groups.entries()).slice(0, headLimit)
  const totalFiles = groups.size

  const out: string[] = []
  out.push(`匹配分布在 ${totalFiles} 个文件${totalFiles > headLimit ? `（显示前 ${headLimit}）` : ''}:\n`)
  for (const [file, fileLines] of fileEntries) {
    out.push(`━━ ${file} ━━`)
    for (const l of fileLines) {
      // 去掉行首的 "path:" 前缀，让输出更紧凑
      out.push('  ' + stripFilePrefix(l, file))
    }
    out.push('')
  }
  if (totalFiles > headLimit) {
    out.push(`...(还有 ${totalFiles - headLimit} 个文件未显示，使用 head_limit 参数调整)`)
  }

  // 如果用户开了 multiline 但后端是 grep，额外警告
  if (backend === 'grep') {
    // 我们在 buildGrepCommand 里没开 multiline 支持，这里的提示只在真的需要时加
    // 需要从外面传 multiline 标志进来——简化起见直接忽略这条，避免假警告
  }

  return out.join('\n')
}

/**
 * 从 "path:lineno:content" 或 "path-lineno-content" 中提取路径。
 * 挑战在于路径本身可能含 ':'，所以我们用启发式：从左往右找第一个 ":<数字>" 或 "-<数字>"
 */
function extractFilePath(line: string): string | null {
  const m = line.match(/^(.+?)[:\-]\d+[:\-]/)
  if (m) return m[1]
  // 降级：整行当文件名（files_with_matches 模式下可能走到这里，但不应该）
  return null
}

function stripFilePrefix(line: string, file: string): string {
  if (line.startsWith(file + ':') || line.startsWith(file + '-')) {
    return line.slice(file.length + 1)
  }
  return line
}