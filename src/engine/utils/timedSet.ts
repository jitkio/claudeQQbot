/**
 * 基于过期时间戳的 Set，替代 setTimeout + Set.delete 模式。
 * 避免大量 setTimeout 回调导致的内存泄漏风险。
 */
export class TimedSet {
  private items = new Map<string, number>()  // key → 过期时间戳
  private maxSize: number

  constructor(maxSize = 10000) {
    this.maxSize = maxSize
  }

  add(key: string, ttlMs: number): void {
    this.items.set(key, Date.now() + ttlMs)
    if (this.items.size > this.maxSize) this.sweep()
  }

  has(key: string): boolean {
    const exp = this.items.get(key)
    if (!exp) return false
    if (Date.now() > exp) {
      this.items.delete(key)
      return false
    }
    return true
  }

  private sweep(): void {
    const now = Date.now()
    for (const [k, exp] of this.items) {
      if (now > exp) this.items.delete(k)
    }
  }
}
