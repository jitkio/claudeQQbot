import { ModelAdapter } from './base.js'
import type { Message, ToolDef, ModelResponse, ModelConfig, ToolCall, MessageContentPart } from '../engine/types.js'
import { isMultimodal } from '../engine/types.js'

/**
 * 修复 DeepSeek 等模型返回的畸形 JSON
 * 常见问题: 尾逗号、缺闭括号、markdown 代码块包裹、缺引号
 */
function repairJSON(raw: string): Record<string, any> {
  if (!raw || !raw.trim()) return {}

  let s = raw.trim()

  // 1. 去除 markdown 代码块包裹: ```json ... ``` 或 ``` ... ```
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  s = s.trim()

  // 2. 去掉尾逗号: {a:1,} → {a:1}  和  [1,2,] → [1,2]
  s = s.replace(/,\s*([\]}])/g, '$1')

  // 3. 补全末尾缺失的花括号
  const opens = (s.match(/\{/g) || []).length
  const closes = (s.match(/\}/g) || []).length
  if (opens > closes) s += '}'.repeat(opens - closes)

  // 4. 补全末尾缺失的方括号
  const openBrackets = (s.match(/\[/g) || []).length
  const closeBrackets = (s.match(/\]/g) || []).length
  if (openBrackets > closeBrackets) s += ']'.repeat(openBrackets - closeBrackets)

  // 第一次尝试直接 parse
  try { return JSON.parse(s) } catch {}

  // 5. 尝试修复未加引号的 key: {command: "ls"} → {"command": "ls"}
  try {
    const fixed = s.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')
    return JSON.parse(fixed)
  } catch {}

  // 6. 最后手段：用正则提取 key=value 对
  const pairs: Record<string, any> = {}
  const re = /"?(\w+)"?\s*:\s*("(?:[^"\\]|\\.)*"|[\d.]+|true|false|null|\[.*?\])/gs
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    try { pairs[m[1]] = JSON.parse(m[2]) } catch { pairs[m[1]] = m[2].replace(/^"|"$/g, '') }
  }
  if (Object.keys(pairs).length > 0) return pairs

  // 完全无法解析
  return { _raw: raw }
}

/**
 * 从模型回复的 content 文本中提取工具调用
 * DeepSeek 有时会把工具调用写在 content 里而不是 tool_calls 字段
 */
function extractToolCallsFromContent(content: string): ToolCall[] {
  const calls: ToolCall[] = []
  if (!content) return calls

  // 模式1: 检测 ```json 包裹的工具调用格式
  // 例如: 我需要调用 bash 工具\n```json\n{"command": "ls"}\n```
  const toolPatterns = [
    // 检测明确提到工具名的模式
    /(?:调用|使用|执行)\s*(?:工具\s*)?[`"']?(\w+)[`"']?\s*(?:工具)?[，,.\s]*(?:参数[为是：:]\s*)?```(?:json)?\s*(\{[\s\S]*?\})\s*```/gi,
    // 检测 function call 格式
    /\{"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g,
  ]

  for (const pattern of toolPatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1]
      const argsStr = match[2]
      const args = repairJSON(argsStr)
      if (!args._raw) {
        calls.push({
          id: `extracted_${Date.now()}_${calls.length}`,
          name,
          arguments: args,
        })
      }
    }
    if (calls.length > 0) break
  }

  return calls
}

/**
 * OpenAI 兼容适配器
 * 支持: OpenAI GPT / DeepSeek / 通义千问 / Moonshot / GLM 等
 */
export class OpenAIAdapter extends ModelAdapter {
  private baseUrl: string

  constructor(config: ModelConfig) {
    super(config)
    this.baseUrl = (config.baseUrl || 'https://api.openai.com').replace(/\/+$/, '')
  }

  formatTools(tools: ToolDef[]): any[] {
    return tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: t.parameters.properties || {},
          required: t.parameters.required || [],
        },
      },
    }))
  }

  private formatMessages(messages: Message[]): any[] {
    const result: any[] = []
    for (const msg of messages) {
      if (msg.role === 'system') {
        result.push({ role: 'system', content: msg.content })
      } else if (msg.role === 'user') {
        // 支持多模态消息
        if (isMultimodal(msg.content)) {
          const content = msg.content.map((part: MessageContentPart) => {
            if (part.type === 'text') return { type: 'text', text: part.text || '' }
            if (part.type === 'image') {
              return {
                type: 'image_url',
                image_url: {
                  url: `data:${part.mediaType || 'image/png'};base64,${part.imageBase64 || ''}`,
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
        const entry: any = { role: 'assistant' }
        if (msg.content) entry.content = msg.content
        if (msg.toolCalls?.length) {
          entry.tool_calls = msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }))
          if (!entry.content) entry.content = null
        }
        result.push(entry)
      } else if (msg.role === 'tool') {
        result.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.content })
      }
    }
    return result
  }

  parseResponse(raw: any): ModelResponse {
    const choice = raw.choices?.[0]
    if (!choice) return { content: '', toolCalls: [], finishReason: 'error' }

    const message = choice.message
    const toolCalls: ToolCall[] = []

    // 1. 从 tool_calls 字段解析（使用 repairJSON 容错）
    if (message.tool_calls?.length) {
      for (const tc of message.tool_calls) {
        const args = repairJSON(tc.function.arguments || '{}')
        if (args._raw) {
          console.warn(`[OpenAI] JSON 修复失败，工具: ${tc.function.name}，原文: ${tc.function.arguments?.slice(0, 100)}`)
        }
        toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args })
      }
    }

    // 2. 如果 finish_reason 是 stop 但没有 tool_calls，尝试从 content 中提取
    //    DeepSeek 有时会把工具调用写在 content 里而不是 tool_calls 字段
    if (toolCalls.length === 0 && choice.finish_reason === 'stop' && message.content) {
      const extractedCalls = extractToolCallsFromContent(message.content)
      if (extractedCalls.length > 0) {
        console.log(`[OpenAI] 从 content 中提取到 ${extractedCalls.length} 个工具调用`)
        toolCalls.push(...extractedCalls)
      }
    }

    let finishReason: ModelResponse['finishReason'] = 'stop'
    if (choice.finish_reason === 'tool_calls' || toolCalls.length > 0) finishReason = 'tool_use'
    else if (choice.finish_reason === 'length') finishReason = 'length'

    return {
      content: message.content || '',
      toolCalls,
      usage: raw.usage ? { input: raw.usage.prompt_tokens || 0, output: raw.usage.completion_tokens || 0 } : undefined,
      finishReason,
    }
  }

  async chat(messages: Message[], tools: ToolDef[], options?: { signal?: AbortSignal }): Promise<ModelResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`
    const body: any = {
      model: this.config.model,
      messages: this.formatMessages(messages),
      max_tokens: this.config.maxTokens || 4096,
    }
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature
    if (tools.length > 0) {
      body.tools = this.formatTools(tools)
      body.tool_choice = 'auto'
    }

    console.log(`[OpenAI] 请求 ${this.config.model} (${messages.length}消息, ${tools.length}工具)`)

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.apiKey}` },
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`OpenAI API 错误 (${resp.status}): ${errText.slice(0, 500)}`)
    }

    const raw = await resp.json()
    const result = this.parseResponse(raw)
    if (result.usage) console.log(`[OpenAI] 完成: ${result.finishReason}, tokens: ${result.usage.input}+${result.usage.output}`)
    return result
  }

  /**
   * 流式对话 — 实时推送文本片段
   */
  async chatStream(
    messages: Message[],
    tools: ToolDef[],
    onChunk: (chunk: string) => void,
    options?: { signal?: AbortSignal }
  ): Promise<ModelResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`
    const body: any = {
      model: this.config.model,
      messages: this.formatMessages(messages),
      max_tokens: this.config.maxTokens || 4096,
      stream: true,
    }
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature
    if (tools.length > 0) {
      body.tools = this.formatTools(tools)
      body.tool_choice = 'auto'
    }

    console.log(`[OpenAI] 流式请求 ${this.config.model} (${messages.length}消息, ${tools.length}工具)`)

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.apiKey}` },
      body: JSON.stringify(body),
      signal: options?.signal,
    })

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`OpenAI API 错误 (${resp.status}): ${errText.slice(0, 500)}`)
    }

    // 读取 SSE 流
    let fullContent = ''
    const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>()
    let finishReason = 'stop'
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
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          const data = trimmed.slice(6)
          if (data === '[DONE]') break

          try {
            const chunk = JSON.parse(data)
            const delta = chunk.choices?.[0]?.delta
            const fr = chunk.choices?.[0]?.finish_reason

            if (delta?.content) {
              fullContent += delta.content
              onChunk(delta.content)
            }

            // 收集 tool_calls delta
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                if (!toolCallsMap.has(idx)) {
                  toolCallsMap.set(idx, { id: tc.id || '', name: tc.function?.name || '', arguments: '' })
                }
                const existing = toolCallsMap.get(idx)!
                if (tc.id) existing.id = tc.id
                if (tc.function?.name) existing.name = tc.function.name
                if (tc.function?.arguments) existing.arguments += tc.function.arguments
              }
            }

            if (fr) finishReason = fr
            if (chunk.usage) {
              usage = { input: chunk.usage.prompt_tokens || 0, output: chunk.usage.completion_tokens || 0 }
            }
          } catch {}
        }
      }
    } finally {
      reader.releaseLock()
    }

    // 组装工具调用
    const toolCalls: ToolCall[] = []
    for (const [_, tc] of toolCallsMap) {
      const args = repairJSON(tc.arguments || '{}')
      toolCalls.push({ id: tc.id, name: tc.name, arguments: args })
    }

    // 从 content 中提取工具调用（DeepSeek 兜底）
    if (toolCalls.length === 0 && fullContent) {
      const extracted = extractToolCallsFromContent(fullContent)
      if (extracted.length > 0) {
        console.log(`[OpenAI] 流式: 从 content 中提取到 ${extracted.length} 个工具调用`)
        toolCalls.push(...extracted)
      }
    }

    const resultFinishReason: ModelResponse['finishReason'] =
      (finishReason === 'tool_calls' || toolCalls.length > 0) ? 'tool_use' :
      finishReason === 'length' ? 'length' : 'stop'

    if (usage) console.log(`[OpenAI] 流式完成: ${resultFinishReason}, tokens: ${usage.input}+${usage.output}`)

    return { content: fullContent, toolCalls, usage, finishReason: resultFinishReason }
  }
}
