import type { ParsedCommand, SubCommand } from './permissionTypes.js'

/** Shell 分段字符：; && || | */
const SEGMENT_SPLITTER = /(?:;|&&|\|\||\|)/

/** 安全 wrapper 列表 —— 可以剥离后判断内部命令 */
const SAFE_WRAPPERS = new Set(['timeout', 'env', 'nice', 'nohup', 'time', 'xargs'])

/** 危险的 shell 元字符组合 */
const DANGEROUS_META_PATTERNS: RegExp[] = [
  /\$\(/,        // $() 命令替换
  /`/,           // 反引号命令替换
  /\$\{[^}]+\}/, // ${VAR} 参数展开（有限制地允许 $VAR）
  /<\(/,         // <() 进程替换
  />\(/,         // >() 进程替换
  /=\(/,         // =() zsh 进程替换
]

/**
 * 解析一个 bash 命令字符串
 *
 * 注意：这不是安全边界，只是启发式的。真正的安全依靠下游的白名单。
 */
export function parseCommand(raw: string): ParsedCommand {
  const subcommands = splitIntoSubcommands(raw).map(parseSubcommand)
  const hasShellMeta = DANGEROUS_META_PATTERNS.some(p => p.test(raw))
  const { hasRedirect, targets } = extractRedirections(raw)

  return {
    raw,
    subcommands,
    hasShellMeta,
    hasRedirect,
    redirectTargets: targets,
  }
}

/** 按 ;/&&/||/| 切分 */
function splitIntoSubcommands(raw: string): string[] {
  // 简化实现：不考虑引号内的分隔符（够用，极端情况由白名单兜底）
  const parts: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    const next = raw[i + 1]

    if (ch === '\\' && next) {
      current += ch + next
      i++
      continue
    }
    if (ch === "'" && !inDoubleQuote) inSingleQuote = !inSingleQuote
    if (ch === '"' && !inSingleQuote) inDoubleQuote = !inDoubleQuote

    if (!inSingleQuote && !inDoubleQuote) {
      // 检查分隔符
      if (ch === ';') { parts.push(current.trim()); current = ''; continue }
      if (ch === '&' && next === '&') { parts.push(current.trim()); current = ''; i++; continue }
      if (ch === '|' && next === '|') { parts.push(current.trim()); current = ''; i++; continue }
      if (ch === '|') { parts.push(current.trim()); current = ''; continue }
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts.filter(Boolean)
}

/** 解析单个子命令 */
function parseSubcommand(raw: string): SubCommand {
  const tokens = tokenize(raw)
  const envPrefix: Record<string, string> = {}
  let i = 0

  // 剥离前导环境变量 FOO=bar BAR=baz cmd ...
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) {
    const [k, v] = tokens[i].split('=', 2)
    envPrefix[k] = v || ''
    i++
  }

  // 剥离 wrapper
  let wrapper: string | undefined
  if (i < tokens.length && SAFE_WRAPPERS.has(tokens[i])) {
    wrapper = tokens[i]
    i++
    // timeout 的第一个参数是秒数或字符串，跳过
    if (wrapper === 'timeout' && i < tokens.length) i++
  }

  const baseCommand = tokens[i] || ''
  const args = tokens.slice(i + 1)

  return { raw, baseCommand, args, envPrefix, wrapper }
}

/** 粗略的 shell tokenization —— 不支持完整 POSIX 规则，够用就行 */
function tokenize(cmd: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]

    if (ch === '\\' && cmd[i + 1]) {
      current += cmd[i + 1]
      i++
      continue
    }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) { tokens.push(current); current = '' }
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

/** 判断是否为 /dev 下的特殊设备文件（/dev/null 等），重定向到它们是纯丢弃/转发操作，不算写入用户文件 */
function isSpecialDevice(path: string): boolean {
  return /^\/dev\/(null|stdout|stderr|tty|zero|random|urandom|full)$/.test(path)
}

/** 提取重定向目标（> file, >> file, 2> file 等） */
function extractRedirections(raw: string): { hasRedirect: boolean; targets: string[] } {
  const targets: string[] = []
  const re = /(?:^|\s)(?:\d*>{1,2}|<)\s*(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    if (match[1] && match[1] !== '&1' && match[1] !== '&2' && !isSpecialDevice(match[1])) {
      targets.push(match[1])
    }
  }
  return { hasRedirect: targets.length > 0, targets }
}
