// 多模态消息内容
export interface MessageContentPart {
  type: 'text' | 'image'
  text?: string
  imageBase64?: string
  mediaType?: string   // 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

// 辅助函数：判断消息内容是否为多模态
export function isMultimodal(content: string | MessageContentPart[]): content is MessageContentPart[] {
  return Array.isArray(content)
}

// 统一消息格式
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | MessageContentPart[]   // 支持纯文本和多模态
  toolCalls?: ToolCall[]      // assistant 消息中的工具调用
  toolCallId?: string         // tool 消息对应的调用 ID
  name?: string               // tool 消息的工具名
}

// 工具调用
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, any>
}

// 工具定义
export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, any>  // JSON Schema
  execute(args: Record<string, any>, ctx: ToolContext): Promise<string>

  /** 是否为只读操作（不改变系统状态） */
  isReadOnly?: boolean | ((input: any) => boolean)

  /**
   * 是否可以与其他工具并发执行
   * 参照 $CC/services/tools/toolOrchestration.ts 第 96-108 行的判定逻辑
   *
   * 默认 undefined → 保守视为 false
   *
   * Bash 这种需要动态判定的用函数形式（根据 input 内容决定）
   */
  isConcurrencySafe?: boolean | ((input: any) => boolean)
}

// 工具执行上下文
export interface ToolContext {
  workDir: string
  timeout: number
  abortSignal?: AbortSignal
  permissionContext?: import('./permission/permissionTypes.js').PermissionContext
  confirmBridge?: import('./permission/userConfirmBridge.js').UserConfirmBridge
  auditLog?: import('./permission/auditLog.js').AuditLog
}

// 模型响应
export interface ModelResponse {
  content: string
  toolCalls: ToolCall[]
  usage?: { input: number; output: number }
  finishReason: 'stop' | 'tool_use' | 'length' | 'error'
}

// 模型配置
export interface ModelConfig {
  provider: 'anthropic' | 'openai' | 'claude_code'
  model: string
  apiKey: string
  baseUrl?: string
  maxTokens?: number
  temperature?: number
}
