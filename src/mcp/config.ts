/**
 * MCP 配置加载
 *
 * 从 workspace/mcp_servers.json 读取配置，支持两种格式：
 *
 * 1. Claude Desktop 兼容格式（推荐，社区 README 直接复制粘贴即可）：
 *    {
 *      "mcpServers": {
 *        "filesystem": {
 *          "command": "npx",
 *          "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
 *          "env": { "KEY": "value" }
 *        },
 *        "remote-api": {
 *          "url": "https://example.com/mcp",
 *          "headers": { "Authorization": "Bearer ${API_TOKEN}" }
 *        }
 *      }
 *    }
 *
 * 2. 扩展格式（显式 servers 数组，有更多控制字段）：
 *    {
 *      "servers": [
 *        {
 *          "alias": "filesystem",
 *          "type": "stdio",
 *          "command": "npx",
 *          "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
 *          "enabled": true,
 *          "initTimeoutMs": 15000,
 *          "callTimeoutMs": 30000
 *        }
 *      ]
 *    }
 *
 * 两种格式可以混用（同一个文件里同时有 "mcpServers" 和 "servers"）。
 *
 * 环境变量替换：
 *   配置里的 "${VAR_NAME}" 会被替换为 process.env.VAR_NAME 的值
 *   支持默认值：${VAR_NAME:-default-value}
 *   替换发生在字符串字段（command、args、url、headers、env value）
 */

import { readFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import type { McpServerConfig, StdioServerConfig, SseServerConfig } from './types.js'

// ============================================================
// 类型
// ============================================================

/** 加载后的 MCP 配置（传给 manager 用） */
export interface McpConfig {
  servers: Array<McpServerConfig & { alias: string }>
}

export interface LoadMcpConfigOptions {
  /** workspace 根目录（配置文件期望在 <workspace>/mcp_servers.json） */
  workspaceDir: string
  /** 覆盖默认路径：直接指定配置文件绝对路径 */
  configPath?: string
  /** 加载时是否静默跳过配置错误（默认 false，会抛错） */
  lenient?: boolean
}

// ============================================================
// 主入口
// ============================================================

/**
 * 加载 MCP 配置
 *
 * @returns 始终返回一个 McpConfig 对象（哪怕是空的）
 *          - 配置文件不存在：返回 { servers: [] }
 *          - 配置解析失败且 lenient=true：返回 { servers: [] } 并打告警
 *          - 配置解析失败且 lenient=false：抛错
 */
export function loadMcpConfig(options: LoadMcpConfigOptions): McpConfig {
  const configPath = options.configPath
    ? resolve(options.configPath)
    : resolve(join(options.workspaceDir, 'mcp_servers.json'))

  if (!existsSync(configPath)) {
    console.log(`[MCP Config] ${configPath} 不存在，MCP 功能未启用`)
    return { servers: [] }
  }

  let raw: string
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch (e: any) {
    const msg = `[MCP Config] 读取 ${configPath} 失败: ${e.message}`
    if (options.lenient) { console.warn(msg); return { servers: [] } }
    throw new Error(msg)
  }

  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    const msg = `[MCP Config] ${configPath} JSON 解析失败: ${e.message}`
    if (options.lenient) { console.warn(msg); return { servers: [] } }
    throw new Error(msg)
  }

  // 两种格式都可以共存于同一个文件
  const servers: Array<McpServerConfig & { alias: string }> = []
  const errors: string[] = []

  // --- 格式 1: mcpServers 对象（Claude Desktop 兼容） ---
  if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
    for (const [alias, entry] of Object.entries(parsed.mcpServers)) {
      try {
        const normalized = normalizeDesktopEntry(alias, entry as any)
        servers.push(normalized)
      } catch (e: any) {
        errors.push(`mcpServers.${alias}: ${e.message}`)
      }
    }
  }

  // --- 格式 2: servers 数组（扩展格式） ---
  if (Array.isArray(parsed.servers)) {
    for (let i = 0; i < parsed.servers.length; i++) {
      const entry = parsed.servers[i]
      try {
        const normalized = normalizeExtendedEntry(entry)
        servers.push(normalized)
      } catch (e: any) {
        errors.push(`servers[${i}] (${entry?.alias ?? '?'}): ${e.message}`)
      }
    }
  }

  if (errors.length > 0) {
    const joined = errors.map(e => `  - ${e}`).join('\n')
    const msg = `[MCP Config] ${configPath} 有 ${errors.length} 个服务器配置错误:\n${joined}`
    if (options.lenient) {
      console.warn(msg)
    } else if (servers.length === 0) {
      // 没有任何可用服务器且有错误 → 抛错
      throw new Error(msg)
    } else {
      // 有部分可用 → 警告但继续
      console.warn(msg)
    }
  }

  // 去重（按 alias）——后者覆盖前者
  const aliasMap = new Map<string, McpServerConfig & { alias: string }>()
  for (const s of servers) aliasMap.set(s.alias, s)
  const deduped = Array.from(aliasMap.values())

  // 环境变量替换
  const resolved = deduped.map(s => resolveEnvInServer(s))

  // 过滤被禁用的
  const enabled = resolved.filter(s => s.enabled !== false)

  console.log(
    `[MCP Config] 加载完成: ${enabled.length} 个启用服务器` +
    (deduped.length > enabled.length ? ` (${deduped.length - enabled.length} 个已禁用)` : ''),
  )

  return { servers: enabled }
}

// ============================================================
// Claude Desktop 格式归一化
// ============================================================

function normalizeDesktopEntry(
  alias: string,
  entry: Record<string, any>,
): McpServerConfig & { alias: string } {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`配置必须是对象`)
  }

  // HTTP/SSE: 有 url 字段
  if (typeof entry.url === 'string') {
    const cfg: SseServerConfig & { alias: string; enabled?: boolean; initTimeoutMs?: number; callTimeoutMs?: number } = {
      alias,
      type: entry.type === 'http' ? 'http' : 'sse',
      url: entry.url,
      headers: entry.headers && typeof entry.headers === 'object' ? { ...entry.headers } : undefined,
      enabled: entry.enabled,
      initTimeoutMs: entry.initTimeoutMs,
      callTimeoutMs: entry.callTimeoutMs,
    }
    return cfg
  }

  // stdio: 有 command 字段
  if (typeof entry.command === 'string') {
    const cfg: StdioServerConfig & { alias: string; enabled?: boolean; initTimeoutMs?: number; callTimeoutMs?: number } = {
      alias,
      type: 'stdio',
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : undefined,
      env: entry.env && typeof entry.env === 'object' ? { ...entry.env } : undefined,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
      enabled: entry.enabled,
      initTimeoutMs: entry.initTimeoutMs,
      callTimeoutMs: entry.callTimeoutMs,
    }
    return cfg
  }

  throw new Error(`必须有 command (stdio) 或 url (http/sse) 字段`)
}

// ============================================================
// 扩展格式归一化
// ============================================================

function normalizeExtendedEntry(
  entry: Record<string, any>,
): McpServerConfig & { alias: string } {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`配置必须是对象`)
  }
  if (typeof entry.alias !== 'string' || !entry.alias) {
    throw new Error(`缺少 alias 字段`)
  }

  const type = entry.type
  if (type === 'stdio') {
    if (typeof entry.command !== 'string') throw new Error(`stdio 服务器必须有 command 字段`)
    return {
      alias: entry.alias,
      type: 'stdio',
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : undefined,
      env: entry.env && typeof entry.env === 'object' ? { ...entry.env } : undefined,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
      enabled: entry.enabled,
      initTimeoutMs: entry.initTimeoutMs,
      callTimeoutMs: entry.callTimeoutMs,
    }
  }

  if (type === 'sse' || type === 'http') {
    if (typeof entry.url !== 'string') throw new Error(`${type} 服务器必须有 url 字段`)
    return {
      alias: entry.alias,
      type,
      url: entry.url,
      headers: entry.headers && typeof entry.headers === 'object' ? { ...entry.headers } : undefined,
      enabled: entry.enabled,
      initTimeoutMs: entry.initTimeoutMs,
      callTimeoutMs: entry.callTimeoutMs,
    }
  }

  throw new Error(`未知的 type: ${type}（必须是 stdio / sse / http）`)
}

// ============================================================
// 环境变量替换
// ============================================================

/**
 * 在整个服务器配置中递归替换 ${VAR} 模式。
 *
 * 支持的语法：
 *   ${VAR}                — 未定义时报错
 *   ${VAR:-default}       — 未定义时用 default
 *   ${VAR:+value-if-set}  — 定义时用 value-if-set，未定义时留空
 */
function resolveEnvInServer<T extends McpServerConfig & { alias: string }>(server: T): T {
  const result: any = { ...server }

  if (result.type === 'stdio') {
    if (typeof result.command === 'string') {
      result.command = substituteEnv(result.command, `servers[${server.alias}].command`)
    }
    if (Array.isArray(result.args)) {
      result.args = result.args.map((a: string, i: number) =>
        substituteEnv(a, `servers[${server.alias}].args[${i}]`),
      )
    }
    if (result.env && typeof result.env === 'object') {
      const newEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(result.env)) {
        if (typeof v === 'string') {
          newEnv[k] = substituteEnv(v, `servers[${server.alias}].env.${k}`)
        } else {
          newEnv[k] = String(v)
        }
      }
      result.env = newEnv
    }
    if (typeof result.cwd === 'string') {
      result.cwd = substituteEnv(result.cwd, `servers[${server.alias}].cwd`)
    }
  } else {
    // http/sse
    if (typeof result.url === 'string') {
      result.url = substituteEnv(result.url, `servers[${server.alias}].url`)
    }
    if (result.headers && typeof result.headers === 'object') {
      const newHeaders: Record<string, string> = {}
      for (const [k, v] of Object.entries(result.headers)) {
        if (typeof v === 'string') {
          newHeaders[k] = substituteEnv(v, `servers[${server.alias}].headers.${k}`)
        } else {
          newHeaders[k] = String(v)
        }
      }
      result.headers = newHeaders
    }
  }

  return result as T
}

/**
 * 在单个字符串里做 ${VAR} 替换
 * 不认识的 ${VAR} 保留原样并在控制台打警告（而不是抛错——避免一个配置错误炸掉全部）
 */
function substituteEnv(input: string, fieldPath: string): string {
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([-+])([^}]*))?\}/g, (match, varName, op, opArg) => {
    const value = process.env[varName]

    if (op === '-') {
      // ${VAR:-default}  —— 未定义或空时用 default
      return value !== undefined && value !== '' ? value : opArg
    }
    if (op === '+') {
      // ${VAR:+value}  —— 定义且非空时用 value，否则空
      return value !== undefined && value !== '' ? opArg : ''
    }

    // 纯 ${VAR}
    if (value === undefined) {
      console.warn(
        `[MCP Config] 字段 ${fieldPath} 引用了未定义的环境变量 ${varName}，保留原样 ${match}`,
      )
      return match
    }
    return value
  })
}

// ============================================================
// 辅助：给外部用的便捷函数
// ============================================================

/** 列出配置里所有 alias（用于日志/调试） */
export function describeMcpConfig(config: McpConfig): string {
  if (config.servers.length === 0) return '(无服务器)'
  return config.servers
    .map(s => {
      if (s.type === 'stdio') return `${s.alias} [stdio: ${s.command}]`
      return `${s.alias} [${s.type}: ${s.url}]`
    })
    .join(', ')
}