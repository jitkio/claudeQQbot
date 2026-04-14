/**
 * MCP (Model Context Protocol) 类型定义
 *
 * 协议版本: 2025-06-18
 * 参考: https://spec.modelcontextprotocol.io/specification/2025-06-18/
 *
 * 这里只列出客户端角色需要用到的类型，服务器端类型不包含。
 */

// ============================================================
// 协议元信息
// ============================================================

export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const JSONRPC_VERSION = '2.0'

// ============================================================
// JSON-RPC 2.0 基础消息
// ============================================================

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcSuccessResponse {
  jsonrpc: typeof JSONRPC_VERSION
  id: number | string
  result: unknown
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION
  id: number | string
  error: {
    code: number
    message: string
    data?: unknown
  }
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/** JSON-RPC 标准错误码 */
export const JsonRpcErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // MCP 扩展码
  ServerError: -32000,
} as const

// ============================================================
// Initialize 握手
// ============================================================

export interface ClientCapabilities {
  roots?: { listChanged?: boolean }
  sampling?: Record<string, never>
  experimental?: Record<string, unknown>
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean }
  resources?: { subscribe?: boolean; listChanged?: boolean }
  prompts?: { listChanged?: boolean }
  logging?: Record<string, never>
  experimental?: Record<string, unknown>
}

export interface Implementation {
  name: string
  version: string
}

export interface InitializeParams {
  protocolVersion: string
  capabilities: ClientCapabilities
  clientInfo: Implementation
}

export interface InitializeResult {
  protocolVersion: string
  capabilities: ServerCapabilities
  serverInfo: Implementation
  instructions?: string
}

// ============================================================
// Tools
// ============================================================

/** MCP 工具定义（从服务器返回） */
export interface McpTool {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
    [key: string]: unknown
  }
  /**
   * MCP 2025-06 引入的 annotations 字段，客户端可用它做权限决策
   * 最关键的是 readOnlyHint / destructiveHint
   */
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

export interface ListToolsResult {
  tools: McpTool[]
  nextCursor?: string
}

export interface CallToolParams {
  name: string
  arguments?: Record<string, unknown>
}

/** MCP 工具调用返回的内容块类型 */
export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }

export interface CallToolResult {
  content: McpContentBlock[]
  /** 是否为错误结果——注意这是"工具逻辑层错误"，协议层错误会走 JsonRpcErrorResponse */
  isError?: boolean
  /** MCP 2025-06 新增的结构化输出 */
  structuredContent?: unknown
}

// ============================================================
// Resources
// ============================================================

export interface McpResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface ListResourcesResult {
  resources: McpResource[]
  nextCursor?: string
}

export interface ReadResourceParams {
  uri: string
}

export interface ReadResourceResult {
  contents: Array<{
    uri: string
    mimeType?: string
    text?: string
    blob?: string
  }>
}

// ============================================================
// Prompts（最小支持）
// ============================================================

export interface McpPrompt {
  name: string
  description?: string
  arguments?: Array<{
    name: string
    description?: string
    required?: boolean
  }>
}

export interface ListPromptsResult {
  prompts: McpPrompt[]
  nextCursor?: string
}

// ============================================================
// 服务器配置（由 config.ts 读取后传给 manager）
// ============================================================

/** stdio 传输配置 */
export interface StdioServerConfig {
  type: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

/** SSE / Streamable HTTP 传输配置 */
export interface SseServerConfig {
  type: 'sse' | 'http'
  url: string
  headers?: Record<string, string>
}

export type McpServerConfig = (StdioServerConfig | SseServerConfig) & {
  /** 该服务器是否启用 */
  enabled?: boolean
  /** 连接超时（ms） */
  initTimeoutMs?: number
  /** 单次 tool 调用超时（ms） */
  callTimeoutMs?: number
  /** 服务器友好名——在 tool 名字加前缀时使用 */
  alias?: string
}

// ============================================================
// 客户端事件（传输层 → 客户端）
// ============================================================

export type TransportEvent =
  | { kind: 'message'; message: JsonRpcMessage }
  | { kind: 'error'; error: Error }
  | { kind: 'close'; reason?: string }