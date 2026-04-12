import type { StreamConfig, StreamChunk } from './orchestratorTypes.js'
import { DEFAULT_STREAM_CONFIG } from './orchestratorTypes.js'

/**
 * 文本流式推送管理器
 *
 * 职责：
 * 1. 接收 adapter 流式返回的 text_delta
 * 2. 按 buffer 大小 / 时间 / 段落边界做节流
 * 3. 通过 pushFn 发送给 QQ
 * 4. 保证 minGapMs 内最多推一次（QQ API 限流保护）
 */
export class OrchestratorStreamManager {
  private buffer = ''
  private lastFlushAt = 0
  private flushTimer?: ReturnType<typeof setTimeout>
  private pendingFlush = false
  private closed = false
  private config: StreamConfig
  private pushFn: (text: string) => Promise<void>
  private totalPushed = 0

  constructor(
    pushFn: (text: string) => Promise<void>,
    config?: Partial<StreamConfig>,
  ) {
    this.pushFn = pushFn
    this.config = { ...DEFAULT_STREAM_CONFIG, ...config }
  }

  /**
   * 接收一个 StreamChunk
   * 文本类型的 chunk 进入 buffer，工具类型的 chunk 暂时忽略（由 orchestrator 处理）
   */
  onChunk(chunk: StreamChunk): void {
    if (this.closed) return

    if (chunk.type === 'text_delta' && chunk.text) {
      this.buffer += chunk.text
      this.scheduleFlush()
    }

    if (chunk.type === 'message_stop') {
      this.finish().catch(() => {})
    }
  }

  /**
   * 接收原始文本 chunk（兼容已有的 adapter 接口）
   */
  onTextChunk(text: string): void {
    if (this.closed) return
    this.buffer += text
    this.scheduleFlush()
  }

  /** 根据配置决定是立即刷、延迟刷还是不刷 */
  private scheduleFlush(): void {
    // 条件 1：buffer 超过阈值
    if (this.buffer.length >= this.config.flushBufferChars) {
      this.tryFlush()
      return
    }

    // 条件 2：buffer 末尾是段落分隔符
    for (const delim of this.config.flushOnChars) {
      if (this.buffer.endsWith(delim)) {
        this.tryFlush()
        return
      }
    }

    // 条件 3：设置延时 flush（如果还没设过）
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined
        this.tryFlush()
      }, this.config.flushIntervalMs)
    }
  }

  /** 尝试立即 flush，但要遵守 minGapMs 间隔 */
  private tryFlush(): void {
    if (this.pendingFlush || !this.buffer) return

    const now = Date.now()
    const elapsed = now - this.lastFlushAt

    if (elapsed >= this.config.minGapMs) {
      // 可以立刻推
      this.doFlush().catch(() => {})
    } else {
      // 还没到推送间隔，安排下次
      this.pendingFlush = true
      setTimeout(() => {
        this.pendingFlush = false
        this.doFlush().catch(() => {})
      }, this.config.minGapMs - elapsed)
    }
  }

  private async doFlush(): Promise<void> {
    if (!this.buffer) return
    const text = this.buffer
    this.buffer = ''
    this.lastFlushAt = Date.now()
    this.totalPushed += text.length

    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }

    try {
      await this.pushFn(text)
    } catch (e: any) {
      console.error('[StreamManager] 推送失败:', e.message)
    }
  }

  /** 关闭流：flush 剩余 buffer 并拒绝后续 chunk */
  async finish(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    if (this.buffer) {
      await this.doFlush()
    }
  }

  getTotalPushed(): number {
    return this.totalPushed
  }
}
