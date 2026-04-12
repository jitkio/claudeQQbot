/** 完全只读的命令集合（无需任何 flag 检查） */
const ALWAYS_READONLY = new Set<string>([
  // 文件查看
  'cat', 'head', 'tail', 'less', 'more', 'nl', 'wc', 'file', 'stat',
  // 文件列表
  'ls', 'dir', 'tree', 'pwd',
  // 搜索
  'grep', 'egrep', 'fgrep', 'rg', 'find', 'fd', 'fdfind', 'locate',
  // 文本处理（只读使用）
  'awk', 'cut', 'sort', 'uniq', 'tr', 'column', 'paste', 'tac', 'rev',
  // 编码/哈希
  'base64', 'md5sum', 'sha1sum', 'sha256sum', 'cksum', 'xxd', 'od', 'hexdump', 'strings',
  // 比较
  'diff', 'cmp',
  // 系统信息
  'whoami', 'id', 'uname', 'hostname', 'date', 'uptime', 'env', 'printenv',
  'df', 'du', 'free', 'ps', 'top', 'which', 'whereis', 'type', 'command',
  // 网络查询（不发起修改）
  'ping', 'traceroute', 'dig', 'nslookup', 'host',
  // 归档查看
  'tar', 'unzip', // 仅查看模式，flag 检查在下面
])

/**
 * 需要 flag 校验的只读命令
 * 参照 $CC/tools/BashTool/readOnlyValidation.ts 的 validateFlags 模式
 */
const FLAG_CHECKED_READONLY = new Map<string, FlagRule>([
  // git —— 只读子命令白名单
  ['git', {
    allowedSubcommands: [
      'status', 'log', 'diff', 'show', 'blame', 'branch', 'tag',
      'ls-files', 'ls-remote', 'describe', 'rev-parse', 'rev-list',
      'config',  // 只允许 --get / --list
      'remote',  // 只允许 -v
    ],
    subcommandFlags: {
      'config': { allowed: ['--get', '--list', '-l', '--show-origin'] },
      'remote': { allowed: ['-v', '--verbose', 'show'] },
      'branch': { forbidden: ['-d', '-D', '--delete', '-m', '-M', '--move'] },
    },
  }],
  // docker —— 只读子命令
  ['docker', {
    allowedSubcommands: ['ps', 'images', 'logs', 'inspect', 'stats', 'top', 'version', 'info', 'history'],
  }],
  // kubectl —— 只读
  ['kubectl', {
    allowedSubcommands: ['get', 'describe', 'logs', 'top', 'version', 'cluster-info', 'explain'],
  }],
  // npm —— 只读
  ['npm', {
    allowedSubcommands: ['list', 'ls', 'view', 'show', 'outdated', 'audit', 'doctor', 'ping', 'config'],
    subcommandFlags: {
      'config': { allowed: ['get', 'list', 'ls'] },
    },
  }],
  // curl —— 仅 GET 类请求（没有 -X POST/PUT/DELETE）
  ['curl', {
    forbiddenFlags: ['-X', '--request', '-T', '--upload-file', '-d', '--data', '--data-binary', '--data-raw'],
  }],
  // wget —— 只允许下载到标准输出或当前目录
  ['wget', {
    requiredFlags: [],  // 无要求，但要靠路径守卫限制写入位置
  }],
])

export interface FlagRule {
  allowedSubcommands?: string[]
  subcommandFlags?: Record<string, { allowed?: string[]; forbidden?: string[] }>
  forbiddenFlags?: string[]
  requiredFlags?: string[]
}

/**
 * 判定一个子命令是否只读
 *
 * 参照 $CC/tools/BashTool/readOnlyValidation.ts 第 1246 行 isCommandSafeViaFlagParsing
 */
export function isReadOnlyCommand(baseCommand: string, args: string[]): boolean {
  if (ALWAYS_READONLY.has(baseCommand)) return true

  const rule = FLAG_CHECKED_READONLY.get(baseCommand)
  if (!rule) return false

  // 子命令白名单
  if (rule.allowedSubcommands) {
    const subcmd = args[0]
    if (!subcmd || !rule.allowedSubcommands.includes(subcmd)) return false

    const flagRule = rule.subcommandFlags?.[subcmd]
    if (flagRule) {
      const remainingArgs = args.slice(1)
      if (flagRule.forbidden?.some(f => remainingArgs.includes(f))) return false
      if (flagRule.allowed && !remainingArgs.every(a => !a.startsWith('-') || flagRule.allowed!.includes(a))) return false
    }
    return true
  }

  // 禁止 flag 检查
  if (rule.forbiddenFlags?.some(f => args.includes(f))) return false

  return true
}

/** 判定整个命令（所有子命令都只读才算只读） */
export function isParsedCommandReadOnly(parsed: { subcommands: Array<{ baseCommand: string; args: string[] }> }): boolean {
  return parsed.subcommands.every(sc => isReadOnlyCommand(sc.baseCommand, sc.args))
}
