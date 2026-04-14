import { ModelAdapter } from './base.js'
import type { Message, ToolDef, ModelResponse, ModelConfig, ToolCall, MessageContentPart } from '../engine/types.js'
import { isMultimodal } from '../engine/types.js'

/**
 * Anthropic Claude API 适配器
 * 直接调用 Anthropic Messages API（不依赖 SDK）
 */
export class AnthropicAdapter extends ModelAdapter {
  private baseUrl: string

  constructor(config: ModelConfig) {
    super(config)
    this.baseUrl = (config.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')
  }

  formatTools(tools: ToolDef[]): any[] {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object',
        properties: t.parameters.properties || {},
        required: t.parameters.required || [],
      },
    }))
  }

  private formatMessages(messages: Message[]): { system: string; messages: any[] } {
    let system = ''
    const result: any[] = []

    for (const msg of messages) {
      if (msg.role === 'system') {
        system += (system ? '\n\n' : '') + msg.content
        continue
      }
      if (msg.role === 'user') {
        // 支持多模态消息
        if (isMultimodal(msg.content)) {
          const content = msg.content.map((part: MessageContentPart) => {
            if (part.type === 'text') return { type: 'text', text: part.text || '' }
            if (part.type === 'image') {
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: part.mediaType || 'image/png',
                  data: part.imageBase64 || '',
                },
              }
            }
            return { type: 'text', text: '' }
          })
          result.push({ role: 'user', content })
        } else {
          result.push({ role: 'user', content: msg.content })
        }
      } else if (msg.role === 'assistant') {
        const content: any[] = []
        if (msg.content) content.push({ type: 'text', text: msg.content })
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments })
          }
        }
        result.push({ role: 'assistant', content: content.length > 0 ? content : msg.content })
      } else if (msg.role === 'tool') {
        // Anthropic tool_result 是 user 角色
        result.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: msg.toolCallId, content: msg.content }],
        })
      }
    }

    return { system, messages: result }
  }

  parseResponse(raw: any): ModelResponse {
    const textParts: string[] = []
    const toolCalls: ToolCall[] = []

    if (Array.isArray(raw.content)) {
      for (const block of raw.content) {
        if (block.type === 'text') textParts.push(block.text)
        else if (block.type === 'tool_use') {
          toolCalls.push({ id: block.id, name: block.name, arguments: block.input || {} })
        }
      }
    }

    let finishReason: ModelResponse['finishReason'] = 'stop'
    if (raw.stop_reason === 'tool_use' || toolCalls.length > 0) finishReason = 'tool_use'
    else if (raw.stop_reason === 'max_tokens') finishReason = 'length'

    return {
      content: textParts.join('\n'),
      toolCalls,
      usage: raw.usage ? { input: raw.usage.input_tokens || 0, output: raw.usage.output_tokens || 0 } : undefined,
      finishReason,
    }
  }

  async chat(messages: Message[], tools: ToolDef[], options?: { signal?: AbortSignal }): Promise<ModelResponse> {
    const url = `${this.baseUrl}/v1/messages`
    const { system, messages: formatted } = this.formatMessages(messages)

    const body: any = {
      model: this.config.model,
      max_tokens: this.config.maxTokens || 4096,
      messages: formatted,
    }
    if (system) body.system = system
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature
    if (tools.length > 0) body.tools = this.formatTools(tools)

    console.log(`[Anthropic] 请求 ${this.config.model} (${formatted.length}消息, ${tools.length}工具)`)

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`Anthropic API 错误 (${resp.status}): ${errText.slice(0, 500)}`)
    }

    const raw = await resp.json()
    const result = this.parseResponse(raw)
    if (result.usage) console.log(`[Anthropic] 完成: ${result.finishReason}, tokens: ${result.usage.input}+${result.usage.output}`)
    return result
  }

  /**
   * 流式对话 — Anthropic SSE 格式
   */
  async chatStream(
    messages: Message[],
    tools: ToolDef[],
    onChunk: (chunk: string) => void,
    options?: { signal?: AbortSignal }
  ): Promise<ModelResponse> {
    const url = `${this.baseUrl}/v1/messages`
    const { system, messages: formatted } = this.formatMessages(messages)

    const body: any = {
      model: this.config.model,
      max_tokens: this.config.maxTokens || 4096,
      messages: formatted,
      stream: true,
    }
    if (system) body.system = system
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature
    if (tools.length > 0) body.tools = this.formatTools(tools)

    console.log(`[Anthropic] 流式请求 ${this.config.model} (${formatted.length}消息, ${tools.length}工具)`)

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`Anthropic API 错误 (${resp.status}): ${errText.slice(0, 500)}`)
    }

    // 解析 Anthropic SSE 流
    let fullContent = ''
    const toolCalls: ToolCall[] = []
    let currentToolId = ''
    let currentToolName = ''
    let currentToolArgs = ''
    let finishReason: ModelResponse['finishReason'] = 'stop'
    let usage: { input: number; output: number } | undefined

    const reader = resp.body?.getReader()
    if (!reader) throw new Error('无法获取响应流')

    const decoder = new TextDecoder()
    let remainder = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        remainder += decoder.decode(value, { stream: true })
        const lines = remainder.split('\n')
        remainder = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()

          // Anthropic SSE 格式: event: xxx\ndata: {...}
          if (!trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') break

          try {
            const event = JSON.parse(data)

            switch (event.type) {
              case 'content_block_start':
                if (event.content_block?.type === 'tool_use') {
                  currentToolId = event.content_block.id || ''
                  currentToolName = event.content_block.name || ''
                  currentToolArgs = ''
                }
                break

              case 'content_block_delta':
                if (event.delta?.type === 'text_delta' && event.delta.text) {
                  fullContent += event.delta.text
                  onChunk(event.delta.text)
                } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                  currentToolArgs += event.delta.partial_json
                }
                break

              case 'content_block_stop':
                if (currentToolId && currentToolName) {
                  let args: Record<string, any> = {}
                  try { args = JSON.parse(currentToolArgs || '{}') } catch { args = { _raw: currentToolArgs } }
                  toolCalls.push({ id: currentToolId, name: currentToolName, arguments: args })
                  currentToolId = ''
                  currentToolName = ''
                  currentToolArgs = ''
                }
                break

              case 'message_delta':
                if (event.delta?.stop_reason === 'tool_use') finishReason = 'tool_use'
                else if (event.delta?.stop_reason === 'max_tokens') finishReason = 'length'
                if (event.usage) {
                  usage = {
                    input: usage?.input || 0,
                    output: (usage?.output || 0) + (event.usage.output_tokens || 0),
                  }
                }
                break

              case 'message_start':
                if (event.message?.usage) {
                  usage = {
                    input: event.message.usage.input_tokens || 0,
                    output: event.message.usage.output_tokens || 0,
                  }
                }
                break
            }
          } catch {}
        }
      }
    } finally {
      reader.releaseLock()
    }

    if (toolCalls.length > 0 && finishReason === 'stop') finishReason = 'tool_use'
    if (usage) console.log(`[Anthropic] 流式完成: ${finishReason}, tokens: ${usage.input}+${usage.output}`)

    return { content: fullContent, toolCalls, usage, finishReason }
  }
}
