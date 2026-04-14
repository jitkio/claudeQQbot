/**
 * MCP 客户端核心
 *
 * 职责：
 *   1. 与传输层协作，建立 MCP 会话（initialize 握手）
 *   2. 管理请求/响应生命周期（按 id 关联、超时、错误）
 *   3. 派发服务器主动发出的 notification（tools/list_changed 等）
 *   4. 提供高层便捷方法（listTools、callTool、listResources、readResource）
 *
 * 不负责：
 *   - 重连（由 manager.ts 处理）
 *   - 配置加载（由 config.ts 处理）
 *   - 工具桥接（由 toolBridge.ts 处理）
 */

import { EventEmitter } from 'events'
import type { Transport, TransportEvent } from './transport.js'
import {
  JSONRPC_VERSION,
  MCP_PROTOCOL_VERSION,
  JsonRpcErrorCodes,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type JsonRpcResponse,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
  type InitializeParams,
  type InitializeResult,
  type ServerCapabilities,
  type Implementation,
  type McpTool,
  type ListToolsResult,
  type CallToolParams,
  type CallToolResult,
  type McpResource,
  type ListResourcesResult,
  type ReadResourceParams,
  type ReadResourceResult,
} from './types.js'

// ============================================================
// 常量
// ============================================================

const DEFAULT_INIT_TIMEOUT_MS = 15000
const DEFAULT_CALL_TIMEOUT_MS = 30000

const CLIENT_INFO: Implementation = {
  name: 'claude-qqbot-mcp-client',
  version: '0.1.0',
}

const CLIENT_CAPABILITIES = {
  // 目前只做消费者角色，不提供 roots/sampling 能力
}

// ============================================================
// 类型
// ============================================================

export type ClientState = 'idle' | 'initializing' | 'ready' | 'failed' | 'closed'

export interface McpClientOptions {
  /** 客户端显示名（用于日志） */
  name: string
  /** 握手超时（ms） */
  initTimeoutMs?: number
  /** 默认调用超时（ms） */
  defaultCallTimeoutMs?: number
}

export interface PendingEntry {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  method: string
}

/** 客户端向外抛出的事件 */
export type ClientEvent =
  | { kind: 'notification'; method: string; params?: Record<string, unknown> }
  | { kind: 'transport_error'; error: Error }
  | { kind: 'closed'; reason?: string }

// ============================================================
// 主类
// ============================================================

export class McpClient {
  private transport: Transport
  private options: Required<McpClientOptions>
  private state: ClientState = 'idle'

  private nextId = 1
  private pending = new Map<number, PendingEntry>()

  private serverInfo: Implementation | null = null
  private serverCapabilities: ServerCapabilities | null = null
  private serverInstructions: string | null = null

  private emitter = new EventEmitter()

  constructor(transport: Transport, options: McpClientOptions) {
    this.transport = transport
    this.options = {
      name: options.name,
      initTimeoutMs: options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
      defaultCallTimeoutMs: options.defaultCallTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    }
  }

  // ============================================================
  // 公开属性
  // ============================================================

  getState(): ClientState {
    return this.state
  }

  getServerInfo(): Implementation | null {
    return this.serverInfo
  }

  getServerCapabilities(): ServerCapabilities | null {
    return this.serverCapabilities
  }

  getServerInstructions(): string | null {
    return this.serverInstructions
  }

  /** 订阅客户端事件（notification、transport_error、closed） */
  on(listener: (event: ClientEvent) => void): void {
    this.emitter.on('event', listener)
  }

  // ============================================================
  // 生命周期
  // ============================================================

  /**
   * 启动客户端：
   *   1. 启动底层传输
   *   2. 挂监听
   *   3. 发 initialize
   *   4. 发 notifications/initialized
   */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`[MCP:${this.options.name}] 已经启动过（当前状态: ${this.state}）`)
    }
    this.state = 'initializing'

    // 订阅传输事件
    this.transport.on((e) => this.onTransportEvent(e))

    try {
      await this.transport.start()
    } catch (e: any) {
      this.state = 'failed'
      throw new Error(`[MCP:${this.options.name}] 传输层启动失败: ${e.message}`)
    }

    // 发 initialize
    const initParams: InitializeParams = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: CLIENT_CAPABILITIES,
      clientInfo: CLIENT_INFO,
    }

    let initResult: InitializeResult
    try {
      initResult = await this.request<InitializeResult>('initialize', initParams, this.options.initTimeoutMs)
    } catch (e: any) {
      this.state = 'failed'
      await this.closeSilently()
      throw new Error(`[MCP:${this.options.name}] initialize 失败: ${e.message}`)
    }

    // 检查协议版本兼容性——不强求完全一致，只警告
    if (initResult.protocolVersion !== MCP_PROTOCOL_VERSION) {
      console.warn(
        `[MCP:${this.options.name}] 协议版本不一致 (client=${MCP_PROTOCOL_VERSION}, server=${initResult.protocolVersion})，尝试继续`,
      )
    }

    this.serverInfo = initResult.serverInfo
    this.serverCapabilities = initResult.capabilities
    this.serverInstructions = initResult.instructions ?? null

    // 发 initialized notification
    try {
      await this.notify('notifications/initialized', {})
    } catch (e: any) {
      this.state = 'failed'
      await this.closeSilently()
      throw new Error(`[MCP:${this.options.name}] 发送 initialized 通知失败: ${e.message}`)
    }

    this.state = 'ready'
    console.log(
      `[MCP:${this.options.name}] 就绪 — 服务器: ${initResult.serverInfo.name} ${initResult.serverInfo.version}`,
    )
  }

  /** 优雅关闭 */
  async close(): Promise<void> {
    if (this.state === 'closed') return
    const prevState = this.state
    this.state = 'closed'

    // 清空所有 pending 请求
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`[MCP:${this.options.name}] 客户端已关闭`))
      this.pending.delete(id)
    }

    // 关闭传输
    try {
      await this.transport.close()
    } catch (e: any) {
      console.warn(`[MCP:${this.options.name}] 关闭传输层时出错: ${e.message}`)
    }

    if (prevState !== 'failed') {
      this.emitter.emit('event', { kind: 'closed', reason: 'explicit close' } satisfies ClientEvent)
    }
  }

  /** 关闭但不派发事件（内部使用，用于失败路径） */
  private async closeSilently(): Promise<void> {
    try { await this.transport.close() } catch {}
  }

  // ============================================================
  // 低层：发送请求/通知
  // ============================================================

  /**
   * 发送一个 JSON-RPC 请求并等待响应
   *
   * @throws 超时、协议错误、客户端关闭、传输错误
   */
  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    if (this.state !== 'ready' && method !== 'initialize') {
      throw new Error(
        `[MCP:${this.options.name}] 状态 ${this.state} 下无法发送请求 ${method}`,
      )
    }

    const id = this.nextId++
    const msg: JsonRpcRequest = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }

    const effectiveTimeout = timeoutMs ?? this.options.defaultCallTimeoutMs

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`[MCP:${this.options.name}] 请求 ${method}#${id} 超时 (${effectiveTimeout}ms)`))
        }
      }, effectiveTimeout)

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
        method,
      })

      // 发送可能失败（背压/传输断）
      this.transport.send(msg).catch((err) => {
        if (this.pending.has(id)) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(new Error(`[MCP:${this.options.name}] 发送失败: ${err.message}`))
        }
      })
    })
  }

  /** 发送一个 JSON-RPC 通知（没有响应） */
  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const msg: JsonRpcNotification = {
      jsonrpc: JSONRPC_VERSION,
      method,
      ...(params !== undefined ? { params } : {}),
    }
    await this.transport.send(msg)
  }

  // ============================================================
  // 传输事件处理
  // ============================================================

  private onTransportEvent(e: TransportEvent): void {
    if (e.kind === 'message') {
      this.handleMessage(e.message)
    } else if (e.kind === 'error') {
      this.emitter.emit('event', { kind: 'transport_error', error: e.error } satisfies ClientEvent)
      // 传输错误不代表连接关闭，只是一条消息处理不了——继续工作
    } else if (e.kind === 'close') {
      this.handleTransportClose(e.reason)
    }
  }

  private handleTransportClose(reason?: string): void {
    if (this.state === 'closed') return
    const prevState = this.state
    this.state = 'closed'

    // 所有 pending 都 reject
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`[MCP:${this.options.name}] 连接已关闭 (${reason ?? 'unknown'})`))
      this.pending.delete(id)
    }

    this.emitter.emit('event', {
      kind: 'closed',
      reason: reason ?? (prevState === 'ready' ? 'transport closed' : 'failed before ready'),
    } satisfies ClientEvent)
  }

  private handleMessage(msg: JsonRpcMessage): void {
    // 1. 响应消息 (有 id 且有 result 或 error)
    if ('id' in msg && msg.id !== undefined && ('result' in msg || 'error' in msg)) {
      this.handleResponse(msg as JsonRpcResponse)
      return
    }

    // 2. 服务器发起的请求 (有 id 且有 method)
    if ('id' in msg && msg.id !== undefined && 'method' in msg) {
      this.handleServerRequest(msg as JsonRpcRequest)
      return
    }

    // 3. 通知 (有 method 但没有 id)
    if ('method' in msg) {
      this.handleNotification(msg as JsonRpcNotification)
      return
    }

    console.warn(`[MCP:${this.options.name}] 收到无法识别的消息:`, msg)
  }

  private handleResponse(resp: JsonRpcResponse): void {
    const id = resp.id
    if (typeof id !== 'number') {
      console.warn(`[MCP:${this.options.name}] 响应的 id 不是数字: ${JSON.stringify(id)}`)
      return
    }

    const entry = this.pending.get(id)
    if (!entry) {
      // 晚到的响应（可能因为超时已经 reject 过），丢弃
      return
    }
    this.pending.delete(id)
    clearTimeout(entry.timer)

    if ('error' in resp) {
      const errResp = resp as JsonRpcErrorResponse
      const msg = `JSON-RPC 错误 ${errResp.error.code}: ${errResp.error.message}`
      entry.reject(new Error(msg))
    } else {
      const okResp = resp as JsonRpcSuccessResponse
      entry.resolve(okResp.result)
    }
  }

  /**
   * 服务器主动发来的请求（sampling/createMessage, roots/list 等）
   * 我们不支持这些能力，统一回复 MethodNotFound
   */
  private handleServerRequest(req: JsonRpcRequest): void {
    console.log(`[MCP:${this.options.name}] 服务器发起请求 ${req.method}（不支持，回复 MethodNotFound）`)
    const errResp: JsonRpcErrorResponse = {
      jsonrpc: JSONRPC_VERSION,
      id: req.id,
      error: {
        code: JsonRpcErrorCodes.MethodNotFound,
        message: `方法 ${req.method} 未实现`,
      },
    }
    this.transport.send(errResp).catch((err) => {
      console.warn(`[MCP:${this.options.name}] 回复 MethodNotFound 失败: ${err.message}`)
    })
  }

  private handleNotification(notif: JsonRpcNotification): void {
    this.emitter.emit('event', {
      kind: 'notification',
      method: notif.method,
      params: notif.params as Record<string, unknown> | undefined,
    } satisfies ClientEvent)
  }

  // ============================================================
  // 高层 API：Tools
  // ============================================================

  /**
   * 列出服务器提供的所有工具。自动翻页。
   */
  async listTools(): Promise<McpTool[]> {
    if (!this.serverCapabilities?.tools) {
      // 服务器没声明 tools 能力——返回空表，不抛错
      return []
    }

    const all: McpTool[] = []
    let cursor: string | undefined

    for (let page = 0; page < 20; page++) {
      const params: Record<string, unknown> = {}
      if (cursor) params.cursor = cursor
      const result = await this.request<ListToolsResult>('tools/list', params)
      if (!result || !Array.isArray(result.tools)) break
      all.push(...result.tools)
      if (!result.nextCursor) break
      cursor = result.nextCursor
    }
    return all
  }

  /**
   * 调用一个工具
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<CallToolResult> {
    if (!this.serverCapabilities?.tools) {
      throw new Error(`[MCP:${this.options.name}] 服务器未声明 tools 能力`)
    }
    const params: CallToolParams = { name, arguments: args }
    const result = await this.request<CallToolResult>('tools/call', params, timeoutMs)

    // 协议要求返回一个对象；对一些实现不规范的服务器做兜底
    if (!result || typeof result !== 'object') {
      throw new Error(`[MCP:${this.options.name}] 工具 ${name} 返回了非对象: ${JSON.stringify(result)}`)
    }
    if (!Array.isArray(result.content)) {
      // 有些服务器直接返回单条 text content；我们把它包成数组
      const anyResult = result as any
      if (typeof anyResult.text === 'string') {
        return { content: [{ type: 'text', text: anyResult.text }], isError: false }
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false }
    }
    return result
  }

  // ============================================================
  // 高层 API：Resources
  // ============================================================

  /**
   * 列出服务器提供的资源。自动翻页。
   */
  async listResources(): Promise<McpResource[]> {
    if (!this.serverCapabilities?.resources) return []

    const all: McpResource[] = []
    let cursor: string | undefined

    for (let page = 0; page < 20; page++) {
      const params: Record<string, unknown> = {}
      if (cursor) params.cursor = cursor
      const result = await this.request<ListResourcesResult>('resources/list', params)
      if (!result || !Array.isArray(result.resources)) break
      all.push(...result.resources)
      if (!result.nextCursor) break
      cursor = result.nextCursor
    }
    return all
  }

  /**
   * 读取一个资源
   */
  async readResource(uri: string): Promise<ReadResourceResult> {
    if (!this.serverCapabilities?.resources) {
      throw new Error(`[MCP:${this.options.name}] 服务器未声明 resources 能力`)
    }
    const params: ReadResourceParams = { uri }
    return this.request<ReadResourceResult>('resources/read', params)
  }

  // ============================================================
  // 内省
  // ============================================================

  /** 当前 pending 请求数（调试用） */
  pendingCount(): number {
    return this.pending.size
  }
}