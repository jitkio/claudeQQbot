/**
 * MCP 传输层
 *
 * 支持两种传输：
 *   1. stdio  — 本地子进程通过 stdin/stdout 交换 JSON-RPC
 *   2. http/sse — 远程 HTTP 服务器，Streamable HTTP 规范
 *
 * 不支持（第一版）：
 *   - WebSocket（非 MCP 标准）
 *   - OAuth2 认证流程（见 types.ts 上方注释说明）
 */

import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import type {
  JsonRpcMessage,
  McpServerConfig,
  StdioServerConfig,
  SseServerConfig,
  TransportEvent,
} from './types.js'

// ============================================================
// 统一接口
// ============================================================

export interface Transport {
  /** 启动连接（stdio 拉起进程 / sse 建立 HTTP 长连接） */
  start(): Promise<void>

  /** 发送一条 JSON-RPC 消息 */
  send(message: JsonRpcMessage): Promise<void>

  /** 监听来自服务器的消息/错误/关闭事件 */
  on(listener: (event: TransportEvent) => void): void

  /** 关闭连接 */
  close(): Promise<void>

  /** 是否已启动且未关闭 */
  isOpen(): boolean
}

// ============================================================
// 工厂函数
// ============================================================

export function createTransport(config: McpServerConfig): Transport {
  if (config.type === 'stdio') {
    return new StdioTransport(config)
  }
  if (config.type === 'sse' || config.type === 'http') {
    return new HttpSseTransport(config)
  }
  throw new Error(`未知的 MCP 传输类型: ${(config as any).type}`)
}

// ============================================================
// stdio 传输实现
// ============================================================

class StdioTransport implements Transport {
  private config: StdioServerConfig
  private proc: ChildProcess | null = null
  private emitter = new EventEmitter()
  private stdoutBuffer = ''   // 行缓冲，JSON-RPC over stdio 按行分隔
  private closed = false

  constructor(config: StdioServerConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    if (this.proc) throw new Error('StdioTransport 已经启动过')

    const env = { ...process.env, ...this.config.env }

    const proc = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Windows 上 npx 等命令需要 shell=true 才能找到
      shell: process.platform === 'win32',
    })

    this.proc = proc

    // 等待进程真正启动（spawn 失败会立刻触发 error 事件）
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const onSpawn = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const onError = (err: Error) => {
        if (settled) return
        settled = true
        reject(new Error(`启动 MCP 服务器失败 (${this.config.command}): ${err.message}`))
      }
      proc.once('spawn', onSpawn)
      proc.once('error', onError)

      // 兜底超时 2 秒：有些 shell 包装器不触发 spawn 事件
      setTimeout(() => {
        if (!settled) {
          settled = true
          resolve()  // 乐观放行
        }
      }, 2000)
    })

    // 绑定数据流
    proc.stdout?.setEncoding('utf-8')
    proc.stdout?.on('data', (chunk: string) => this.onStdoutChunk(chunk))
    proc.stderr?.setEncoding('utf-8')
    proc.stderr?.on('data', (chunk: string) => this.onStderrChunk(chunk))

    proc.on('exit', (code, signal) => {
      if (this.closed) return
      this.closed = true
      const reason = `进程退出 code=${code} signal=${signal}`
      this.emitter.emit('event', { kind: 'close', reason } satisfies TransportEvent)
    })

    proc.on('error', (err) => {
      this.emitter.emit('event', { kind: 'error', error: err } satisfies TransportEvent)
    })
  }

  private onStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk
    // 按换行切分 —— MCP stdio 约定每条消息一行
    let nl: number
    while ((nl = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, nl).trimEnd()
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1)
      if (!line) continue
      this.dispatchLine(line)
    }
  }

  private onStderrChunk(chunk: string): void {
    // MCP 服务器约定：stderr 是日志通道，不是错误通道
    // 只在首字符看起来像是 JSON 时才处理（有的服务器实现误写到 stderr）
    const trimmed = chunk.trim()
    if (trimmed.startsWith('{')) {
      this.dispatchLine(trimmed)
    } else if (trimmed.length > 0) {
      // 默认当作日志，打到本地 stderr，不作为消息
      process.stderr.write(`[MCP:${this.config.command}] ${trimmed}\n`)
    }
  }

  private dispatchLine(line: string): void {
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(line)
    } catch (e: any) {
      this.emitter.emit('event', {
        kind: 'error',
        error: new Error(`无法解析 MCP 消息: ${e.message}\n原始内容: ${line.slice(0, 200)}`),
      } satisfies TransportEvent)
      return
    }
    this.emitter.emit('event', { kind: 'message', message: msg } satisfies TransportEvent)
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error('StdioTransport 已关闭，无法发送消息')
    if (!this.proc?.stdin) throw new Error('StdioTransport 未启动')

    const line = JSON.stringify(message) + '\n'
    const ok = this.proc.stdin.write(line, 'utf-8')
    if (!ok) {
      // 背压：等 drain
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => { cleanup(); resolve() }
        const onError = (err: Error) => { cleanup(); reject(err) }
        const cleanup = () => {
          this.proc?.stdin?.off('drain', onDrain)
          this.proc?.stdin?.off('error', onError)
        }
        this.proc?.stdin?.once('drain', onDrain)
        this.proc?.stdin?.once('error', onError)
      })
    }
  }

  on(listener: (event: TransportEvent) => void): void {
    this.emitter.on('event', listener)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.proc?.stdin?.end()
    } catch {}
    // 给进程 3 秒优雅退出，否则 SIGTERM
    const proc = this.proc
    if (proc && proc.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try { proc.kill('SIGTERM') } catch {}
          resolve()
        }, 3000)
        proc.once('exit', () => { clearTimeout(timer); resolve() })
      })
    }
    this.proc = null
  }

  isOpen(): boolean {
    return !this.closed && this.proc !== null && this.proc.exitCode === null
  }
}

// ============================================================
// HTTP / SSE 传输实现（Streamable HTTP）
// ============================================================
//
// Streamable HTTP 规范要点：
//   - 客户端 POST 请求消息到 <url>
//   - 服务器返回 200 + Content-Type: application/json（单条响应）
//     或返回 200 + Content-Type: text/event-stream（多条 SSE 流）
//   - 服务器还可能异步向客户端 POST 请求（需要客户端提供 GET 端点做 listener）
//
// 第一版我们实现"单向简化模式"：
//   - 客户端始终主动发送
//   - 服务器响应可以是 JSON 或 SSE
//   - 不支持服务器主动调客户端（roots/sampling 这些高级能力延后）
//
// 这足够覆盖 99% 的远程 MCP 服务器使用场景。
// ============================================================

class HttpSseTransport implements Transport {
  private config: SseServerConfig
  private emitter = new EventEmitter()
  private closed = false
  private sessionId: string | null = null    // 服务器在首次响应里可能给一个 mcp-session-id

  constructor(config: SseServerConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    // HTTP/SSE 不需要预先建立连接——每次 send 都是一次 POST。
    // 这里只是一个占位：将来要做 server-initiated request 时会在这里起 GET 长连接。
    if (this.closed) throw new Error('HttpSseTransport 已关闭')
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error('HttpSseTransport 已关闭，无法发送消息')

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...this.config.headers,
    }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId

    let resp: Response
    try {
      resp = await fetch(this.config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
      })
    } catch (e: any) {
      this.emitter.emit('event', {
        kind: 'error',
        error: new Error(`HTTP 请求失败: ${e.message}`),
      } satisfies TransportEvent)
      return
    }

    // 记录 sessionId（如果服务器下发了）
    const newSid = resp.headers.get('mcp-session-id')
    if (newSid) this.sessionId = newSid

    if (!resp.ok) {
      let body = ''
      try { body = await resp.text() } catch {}
      this.emitter.emit('event', {
        kind: 'error',
        error: new Error(`MCP HTTP 错误 ${resp.status}: ${body.slice(0, 500)}`),
      } satisfies TransportEvent)
      return
    }

    // Notification 没有 id，服务器可能返回 202 空响应
    if (resp.status === 202 || resp.headers.get('content-length') === '0') return

    const contentType = resp.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      await this.consumeSseStream(resp)
    } else {
      // 单条 JSON 响应
      try {
        const data = await resp.json() as JsonRpcMessage
        this.emitter.emit('event', { kind: 'message', message: data } satisfies TransportEvent)
      } catch (e: any) {
        this.emitter.emit('event', {
          kind: 'error',
          error: new Error(`无法解析 HTTP 响应体: ${e.message}`),
        } satisfies TransportEvent)
      }
    }
  }

  /** 消费 text/event-stream，逐条派发 */
  private async consumeSseStream(resp: Response): Promise<void> {
    const body = resp.body
    if (!body) return

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE 格式: 多行，每条记录以 \n\n 分隔，每行以 "field: value" 开头
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        this.dispatchSseEvent(rawEvent)
      }
    }
  }

  private dispatchSseEvent(raw: string): void {
    // 聚合多行 data: 字段
    const dataLines: string[] = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart())
      }
    }
    if (dataLines.length === 0) return
    const payload = dataLines.join('\n')
    try {
      const msg: JsonRpcMessage = JSON.parse(payload)
      this.emitter.emit('event', { kind: 'message', message: msg } satisfies TransportEvent)
    } catch (e: any) {
      this.emitter.emit('event', {
        kind: 'error',
        error: new Error(`SSE 事件 JSON 解析失败: ${e.message}`),
      } satisfies TransportEvent)
    }
  }

  on(listener: (event: TransportEvent) => void): void {
    this.emitter.on('event', listener)
  }

  async close(): Promise<void> {
    this.closed = true
    // HTTP/SSE 没有持久连接要关，直接置位即可
  }

  isOpen(): boolean {
    return !this.closed
  }
}