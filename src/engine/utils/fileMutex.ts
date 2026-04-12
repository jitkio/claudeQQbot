/**
 * 进程内互斥锁，用于保护 per-key 的文件读写操作。
 *
 * 同一个 key 的写操作排队执行，不同 key 可以并发。
 * 适用于 userProfile、sessionNotes、todoStore、permissionMode 等
 * per-session/per-user 的文件操作。
 */
export class FileMutex {
  private locks = new Map<string, Promise<void>>()

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const next = new Promise<void>(r => { release = r })
    this.locks.set(key, prev.then(() => next))

    await prev
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(key) === next) this.locks.delete(key)
    }
  }
}

/** 全局单例 */
export const fileMutex = new FileMutex()
