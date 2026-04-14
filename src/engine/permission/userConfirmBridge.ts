import { randomBytes } from 'crypto'
import { getGlobalDenyTracker } from './denyTracker.js'

/**
 * 等待中的确认请求
 */
interface PendingConfirmation {
  id: string
  userId: string
  sessionKey?: string       // 可选，用于在被拒时写入 denyTracker
  toolName: string          // 工具名（默认为 bash）
  command: string
  reason: string
  warnings: string[]
  createdAt: number
  resolve: (accepted: boolean) => void
}

/**
 * 通过 IM 通道发起二次确认
 *
 * 工作流程：
 * 1. 生成唯一 token
 * 2. 向用户推送一条消息，要求回复 "确认 <token>" 或 "取消 <token>"
 * 3. 在 index.ts 的消息处理器里截获这类消息，调用 resolveConfirmation
 * 4. 超时（默认 60 秒）自动当作拒绝
 *
 * 被拒（包括超时）时会自动向全局 DenyTracker 写入一条记录，
 * 这样同 session 内再出现相同命令时可以提前短路，避免反复骚扰用户。
 */
export class UserConfirmBridge {
  private pending = new Map<string, PendingConfirmation>()
  private sendFn: (userId: string, text: string) => Promise<void>
  private defaultTimeoutMs: number

  constructor(
    sendFn: (userId: string, text: string) => Promise<void>,
    defaultTimeoutMs = 60000,
  ) {
    this.sendFn = sendFn
    this.defaultTimeoutMs = defaultTimeoutMs
  }

  /** 发起确认请求，返回是否被允许 */
  async askConfirm(params: {
    userId: string
    command: string
    reason: string
    warnings: string[]
    timeoutMs?: number
    sessionKey?: string      // 新增：用于在被拒时写 denyTracker
    toolName?: string        // 新增：默认 'bash'
  }): Promise<boolean> {
    const id = randomBytes(3).toString('hex')  // 6 字符短 token
    const timeout = params.timeoutMs ?? this.defaultTimeoutMs
    const toolName = params.toolName ?? 'bash'

    const msg = this.formatConfirmMessage(id, params)
    await this.sendFn(params.userId, msg)

    return new Promise<boolean>((resolve) => {
      const pending: PendingConfirmation = {
        id,
        userId: params.userId,
        sessionKey: params.sessionKey,
        toolName,
        command: params.command,
        reason: params.reason,
        warnings: params.warnings,
        createdAt: Date.now(),
        resolve: (accepted: boolean) => {
          // 被拒时写入 denyTracker（前提：调用方提供了 sessionKey）
          if (!accepted && params.sessionKey) {
            getGlobalDenyTracker().record(
              params.sessionKey,
              toolName,
              params.command,
              'user',
              `用户拒绝：${params.reason}`,
            )
          }
          resolve(accepted)
        },
      }
      this.pending.set(id, pending)

      // 超时定时器
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          this.sendFn(params.userId, `⏱ 确认请求 ${id} 已超时（${timeout / 1000}s），自动取消`).catch(() => {})
          pending.resolve(false)  // 走包装后的 resolve，触发 tracker 写入
        }
      }, timeout)
    })
  }

  /** 由 index.ts 消息处理器调用：用户回复了确认/取消 */
  resolveConfirmation(userId: string, text: string): boolean {
    const m = text.match(/^(确认|取消|allow|deny|yes|no)\s*([a-f0-9]{6})?\s*$/i)
    if (!m) return false

    const action = m[1].toLowerCase()
    const id = m[2]
    const accepted = ['确认', 'allow', 'yes'].includes(action)

    if (id) {
      const p = this.pending.get(id)
      if (p && p.userId === userId) {
        this.pending.delete(id)
        p.resolve(accepted)
        return true
      }
    } else {
      // 没带 token —— 匹配这个用户最近的一条 pending
      const recent = [...this.pending.values()]
        .filter(p => p.userId === userId)
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      if (recent) {
        this.pending.delete(recent.id)
        recent.resolve(accepted)
        return true
      }
    }
    return false
  }

  private formatConfirmMessage(id: string, params: {
    command: string
    reason: string
    warnings: string[]
  }): string {
    const warns = params.warnings.length > 0
      ? '\n' + params.warnings.map(w => `  ${w}`).join('\n')
      : ''
    return `🔐 需要确认 [${id}]
命令: ${params.command}
原因: ${params.reason}${warns}

回复 "确认 ${id}" 或 "取消 ${id}" 来决定（60秒内）`
  }
}