/**
 * MCP 服务器生命周期管理
 *
 * 职责：
 *   1. 启动：读取 config，为每个 enabled 服务器创建 Transport+Client 并完成握手
 *   2. 工具缓存：握手完成后立即 listTools 并缓存 ToolDef 数组
 *   3. 热更新：监听 tools/list_changed notification，自动刷新工具缓存
 *   4. 重连：stdio 进程崩溃时指数退避重连
 *   5. 关闭：bot 退出时优雅关闭所有 client
 *
 * 使用方式（taskQueue 里）：
 *   const manager = new McpManager()
 *   await manager.start(workspaceDir)      // bot 启动时调用一次
 *   ...
 *   const registry = createDefaultRegistry(planningDeps)
 *   registry.registerFromMcp(manager)       // 每个任务创建 registry 时调
 */

import { createTransport } from './transport.js'
import type { Transport } from './transport.js'
import { McpClient, type ClientEvent } from './client.js'
import { loadMcpConfig, describeMcpConfig, type McpConfig } from './config.js'
import { bridgeToToolDefs } from './toolBridge.js'
import type { ToolDef } from '../engine/types.js'
import type { McpServerConfig, McpTool } from './types.js'

// ============================================================
// 常量
// ============================================================

const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 60000
const RECONNECT_MAX_ATTEMPTS = 5

// ============================================================
// 类型
// ============================================================

interface ServerInstance {
  alias: string
  config: McpServerConfig & { alias: string }
  transport: Transport | null
  client: McpClient | null
  tools: McpTool[]
  toolDefs: ToolDef[]
  state: 'starting' | 'ready' | 'reconnecting' | 'failed' | 'closed'
  lastError?: string
  reconnectAttempts: number
  reconnectTimer?: NodeJS.Timeout
}

export interface McpManagerOptions {
  /** 配置文件加载的 lenient 模式：配置错误只告警不抛 */
  lenient?: boolean
}

// ============================================================
// 主类
// ============================================================

export class McpManager {
  private servers = new Map<string, ServerInstance>()
  private started = false
  private workspaceDir = ''

  /**
   * 启动：加载配置并建立所有启用服务器的连接
   *
   * 单个服务器启动失败不会导致整体失败——其他服务器照样启动。
   * 所有服务器启动都失败时，manager 仍然算 started 成功，只是没工具。
   */
  async start(workspaceDir: string, options: McpManagerOptions = {}): Promise<void> {
    if (this.started) throw new Error('McpManager 已经启动过')
    this.started = true
    this.workspaceDir = workspaceDir

    const config = loadMcpConfig({
      workspaceDir,
      lenient: options.lenient ?? true,
    })

    if (config.servers.length === 0) {
      console.log('[MCP Manager] 无可用 MCP 服务器配置')
      return
    }

    console.log(`[MCP Manager] 正在启动 ${config.servers.length} 个服务器: ${describeMcpConfig(config)}`)

    // 并行启动所有服务器，允许部分失败
    const results = await Promise.allSettled(
      config.servers.map(cfg => this.startOne(cfg)),
    )

    let readyCount = 0
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      const alias = config.servers[i].alias
      if (r.status === 'fulfilled') {
        readyCount++
      } else {
        console.warn(`[MCP Manager] 服务器 ${alias} 启动失败: ${r.reason?.message ?? r.reason}`)
      }
    }

    console.log(`[MCP Manager] 启动完成: ${readyCount}/${config.servers.length} 个服务器就绪`)
  }

  /**
   * 返回所有已就绪服务器的工具（扁平列表）
   *
   * 这是给 ToolRegistry 调用的主要接口——每次新建 registry 时调一次，
   * 拿到全部 ToolDef 直接 register。
   */
  getAllTools(): ToolDef[] {
    const all: ToolDef[] = []
    for (const instance of this.servers.values()) {
      if (instance.state === 'ready') all.push(...instance.toolDefs)
    }
    return all
  }

  /** 返回服务器状态概览（用于 /status 或诊断命令） */
  describeStatus(): Array<{ alias: string; state: string; toolCount: number; error?: string }> {
    const out: Array<{ alias: string; state: string; toolCount: number; error?: string }> = []
    for (const s of this.servers.values()) {
      out.push({
        alias: s.alias,
        state: s.state,
        toolCount: s.toolDefs.length,
        error: s.lastError,
      })
    }
    return out
  }

  /** 优雅关闭所有服务器（bot 退出时调） */
  async shutdown(): Promise<void> {
    const all = Array.from(this.servers.values())
    await Promise.allSettled(
      all.map(async (s) => {
        if (s.reconnectTimer) clearTimeout(s.reconnectTimer)
        s.state = 'closed'
        if (s.client) {
          try { await s.client.close() } catch {}
        }
      }),
    )
    this.servers.clear()
  }

  // ============================================================
  // 内部：单服务器启动
  // ============================================================

  private async startOne(config: McpServerConfig & { alias: string }): Promise<void> {
    const alias = config.alias
    const instance: ServerInstance = {
      alias,
      config,
      transport: null,
      client: null,
      tools: [],
      toolDefs: [],
      state: 'starting',
      reconnectAttempts: 0,
    }
    this.servers.set(alias, instance)

    try {
      await this.connectInstance(instance)
    } catch (e: any) {
      instance.state = 'failed'
      instance.lastError = e.message
      throw e
    }
  }

  private async connectInstance(instance: ServerInstance): Promise<void> {
    // 创建新的 transport 和 client（重连场景下旧的已 closed，直接丢弃）
    const transport = createTransport(instance.config)
    const client = new McpClient(transport, {
      name: instance.alias,
      initTimeoutMs: instance.config.initTimeoutMs,
      defaultCallTimeoutMs: instance.config.callTimeoutMs,
    })

    instance.transport = transport
    instance.client = client

    // 订阅客户端事件（重连、工具变更）
    client.on((e) => this.onClientEvent(instance, e))

    // 启动并等待就绪
    await client.start()

    // 拉取工具列表并桥接
    await this.refreshTools(instance)

    instance.state = 'ready'
    instance.reconnectAttempts = 0
    instance.lastError = undefined
  }

  // ============================================================
  // 事件处理
  // ============================================================

  private onClientEvent(instance: ServerInstance, e: ClientEvent): void {
    if (e.kind === 'notification') {
      this.onNotification(instance, e.method, e.params)
      return
    }
    if (e.kind === 'transport_error') {
      console.warn(`[MCP:${instance.alias}] 传输错误: ${e.error.message}`)
      return
    }
    if (e.kind === 'closed') {
      console.warn(`[MCP:${instance.alias}] 连接关闭: ${e.reason ?? 'unknown'}`)
      this.handleDisconnect(instance, e.reason)
      return
    }
  }

  private onNotification(
    instance: ServerInstance,
    method: string,
    _params?: Record<string, unknown>,
  ): void {
    if (method === 'notifications/tools/list_changed') {
      console.log(`[MCP:${instance.alias}] 工具列表变更，刷新中...`)
      this.refreshTools(instance).catch((err) => {
        console.warn(`[MCP:${instance.alias}] 刷新工具失败: ${err.message}`)
      })
      return
    }
    // 其他 notification（resources/list_changed、prompts/list_changed、message/log 等）
    // 暂时只打日志不做动作
    console.log(`[MCP:${instance.alias}] 收到通知: ${method}`)
  }

  // ============================================================
  // 工具刷新
  // ============================================================

  private async refreshTools(instance: ServerInstance): Promise<void> {
    if (!instance.client) return
    const tools = await instance.client.listTools()
    instance.tools = tools
    instance.toolDefs = bridgeToToolDefs(instance.client, tools, {
      namespace: instance.alias,
      callTimeoutMs: instance.config.callTimeoutMs,
    })
    console.log(
      `[MCP:${instance.alias}] 已注册 ${instance.toolDefs.length} 个工具: ${tools.map(t => t.name).join(', ') || '(空)'}`,
    )
  }

  // ============================================================
  // 断开重连
  // ============================================================

  private handleDisconnect(instance: ServerInstance, reason?: string): void {
    if (instance.state === 'closed') return   // 主动关闭，不重连

    instance.state = 'reconnecting'
    instance.lastError = reason

    // 只对 stdio 做重连（HTTP/SSE 没有"连接断开"的概念，每次调用都是独立 HTTP 请求）
    if (instance.config.type !== 'stdio') {
      instance.state = 'failed'
      return
    }

    if (instance.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      console.warn(
        `[MCP:${instance.alias}] 已达到最大重连次数 (${RECONNECT_MAX_ATTEMPTS})，放弃重连`,
      )
      instance.state = 'failed'
      return
    }

    instance.reconnectAttempts++
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, instance.reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    )

    console.log(
      `[MCP:${instance.alias}] ${delay}ms 后重连 (尝试 ${instance.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})`,
    )

    instance.reconnectTimer = setTimeout(async () => {
      if (instance.state !== 'reconnecting') return
      try {
        await this.connectInstance(instance)
        console.log(`[MCP:${instance.alias}] 重连成功`)
      } catch (e: any) {
        console.warn(`[MCP:${instance.alias}] 重连失败: ${e.message}`)
        // 再次触发重连循环
        this.handleDisconnect(instance, e.message)
      }
    }, delay)
  }
}

// ============================================================
// 全局单例
// ============================================================

let _globalManager: McpManager | null = null

export function getGlobalMcpManager(): McpManager {
  if (!_globalManager) _globalManager = new McpManager()
  return _globalManager
}