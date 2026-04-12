import type { Message, ModelConfig, ModelResponse, ToolDef } from '../engine/types.js'

export abstract class ModelAdapter {
  constructor(protected config: ModelConfig) {}

  abstract chat(
    messages: Message[],
    tools: ToolDef[],
    options?: { signal?: AbortSignal }
  ): Promise<ModelResponse>

  /**
   * 流式对话（可选实现）
   * 每产生一段文本就通过 onChunk 回调推送
   * 默认实现：调用 chat() 后一次性推送
   */
  async chatStream(
    messages: Message[],
    tools: ToolDef[],
    onChunk: (chunk: string) => void,
    options?: { signal?: AbortSignal }
  ): Promise<ModelResponse> {
    const response = await this.chat(messages, tools, options)
    if (response.content) onChunk(response.content)
    return response
  }

  abstract formatTools(tools: ToolDef[]): any[]

  abstract parseResponse(raw: any): ModelResponse
}
