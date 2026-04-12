/** 权限模式 —— 会话级状态 */
export type PermissionMode =
  | 'strict'      // 严格模式：所有写操作 + bash 都要二次确认
  | 'default'     // 默认：读取/搜索自动放行，写/bash 按规则决策
  | 'auto'        // 自动：按规则全自动决策，不弹确认（除非命中破坏性规则）
  | 'plan'        // 规划：只允许只读工具，任何写操作都拒绝
  | 'bypass'      // 绕过：全部放行（仅在 env BYPASS_PERMISSIONS=true 时可用）

/** 单次命令的审查结果 */
export type PermissionDecision =
  | { behavior: 'allow'; reason: string }
  | { behavior: 'ask'; reason: string; warnings: string[] }
  | { behavior: 'deny'; reason: string }

/** 审查引擎的上下文 */
export interface PermissionContext {
  mode: PermissionMode
  userId: string                    // 用来在二次确认时找人
  sessionKey: string                // 审计日志 session 标识
  workspaceRoot: string             // workspace 白名单根
  allowedDirs: string[]             // 额外允许写的目录（绝对路径）
  deniedPaths: string[]             // 永远禁止触碰的路径
  bypassEnvFlag: boolean            // 是否有 BYPASS_PERMISSIONS=true
}

/** 命令的结构化解析结果 */
export interface ParsedCommand {
  raw: string
  subcommands: SubCommand[]         // 按 ; && || | 分割后的每段
  hasShellMeta: boolean             // 是否包含 $() ${} <() 等 meta
  hasRedirect: boolean              // 是否有 > >> 重定向
  redirectTargets: string[]         // 重定向目标路径
}

export interface SubCommand {
  raw: string                       // 原始子命令字符串
  baseCommand: string               // 去掉 env 前缀和 wrapper 后的命令名
  args: string[]                    // 参数（已按 shell 规则分词）
  envPrefix: Record<string, string> // FOO=bar baz 的 { FOO: 'bar' }
  wrapper?: string                  // timeout 30 cmd 里的 'timeout'
}

/** 破坏性检测匹配结果 */
export interface DestructiveMatch {
  pattern: string                   // 正则规则名
  warning: string                   // 人类可读警告
  severity: 'note' | 'warn' | 'critical'
}

/** 路径守卫决策 */
export interface PathCheckResult {
  allowed: boolean
  path: string
  reason: string
  isDangerous: boolean              // 命中 isDangerousRemovalPath 之类的黑名单
}

/** 默认配置 */
export const DEFAULT_PERMISSION_CONTEXT: Omit<PermissionContext, 'userId' | 'sessionKey'> = {
  mode: 'default',
  workspaceRoot: '',                // 由外部注入
  allowedDirs: [],
  deniedPaths: [
    '/etc', '/boot', '/sys', '/proc',
    '~/.ssh', '~/.aws', '~/.config',
    '/var/log', '/var/lib',
  ],
  bypassEnvFlag: false,
}

export const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  strict: '严格模式：所有写操作和 bash 命令都需要你二次确认',
  default: '默认模式：读取操作自动放行，写操作按规则决策',
  auto: '自动模式：按规则全自动决策，仅破坏性命令才推送确认',
  plan: '规划模式：只允许只读工具（file_read、grep、glob、web_search），任何写操作都会被拒绝',
  bypass: '绕过模式：所有命令自动放行（需 BYPASS_PERMISSIONS=true 环境变量）',
}
