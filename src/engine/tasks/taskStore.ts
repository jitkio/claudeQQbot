/**
 * 任务持久化存储
 *
 * 职责：
 *   1. 把 TaskRecord 写到磁盘（原子写）
 *   2. 读取单个任务 / 列出全部任务
 *   3. 启动时恢复磁盘上的任务（恢复到内存索引）
 *   4. 清理旧任务（超过 TASK_RETENTION_MS 的终止任务）
 *
 * 每个任务一个 JSON 文件：<baseDir>/tasks/<task_id>.json
 * 采用 write-then-rename 避免读到半截写的文件。
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import {
  TASK_ID_PREFIX,
  TASK_RETENTION_MS,
  isTerminal,
  type TaskRecord,
  type TaskStatus,
} from './taskTypes.js'

// ============================================================
// 主类
// ============================================================

export class TaskStore {
  private dir: string
  /** 内存索引：id -> 任务记录（避免每次都读盘） */
  private cache = new Map<string, TaskRecord>()

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'tasks')
    mkdirSync(this.dir, { recursive: true })
  }

  // ============================================================
  // 启动 / 恢复
  // ============================================================

  /**
   * 从磁盘加载全部任务到内存索引。
   * 同时做两件事：
   *   1. 把重启前处于 running/pending 状态的任务标记为 failed（进程没了）
   *   2. 清理超过 TASK_RETENTION_MS 的终止任务
   *
   * 返回"需要标记为失败"的任务 ID 列表（由 manager 决定是否通知用户）
   */
  loadFromDisk(): { orphaned: string[]; purged: number } {
    const orphaned: string[] = []
    let purged = 0
    const now = Date.now()

    let entries: string[]
    try {
      entries = readdirSync(this.dir)
    } catch {
      return { orphaned, purged }
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const path = join(this.dir, entry)
      let record: TaskRecord
      try {
        record = JSON.parse(readFileSync(path, 'utf-8'))
      } catch (e: any) {
        console.warn(`[TaskStore] 无法解析 ${entry}: ${e.message}，跳过`)
        continue
      }

      // 清理超龄的终止任务
      if (isTerminal(record.status) && record.finishedAt && now - record.finishedAt > TASK_RETENTION_MS) {
        try { unlinkSync(path) } catch {}
        purged++
        continue
      }

      // 孤儿任务（重启前正在跑的）
      if (record.status === 'running' || record.status === 'pending') {
        record.status = 'failed'
        record.error = '进程重启前任务未完成'
        record.finishedAt = now
        this.writeUnsafe(record)
        orphaned.push(record.id)
      }

      this.cache.set(record.id, record)
    }

    return { orphaned, purged }
  }

  // ============================================================
  // CRUD
  // ============================================================

  /** 生成新 ID（保证不与内存索引冲突） */
  generateId(): string {
    for (let i = 0; i < 10; i++) {
      const id = TASK_ID_PREFIX + randomBytes(4).toString('hex')
      if (!this.cache.has(id)) return id
    }
    // 10 次都冲突说明中了彩票
    throw new Error('无法生成唯一的任务 ID')
  }

  /** 读取任务（从内存缓存） */
  get(id: string): TaskRecord | undefined {
    return this.cache.get(id)
  }

  /** 列出满足条件的任务 */
  list(filter?: (t: TaskRecord) => boolean): TaskRecord[] {
    const all = Array.from(this.cache.values())
    return filter ? all.filter(filter) : all
  }

  /** 列出某个用户的所有任务（按 createdAt 倒序） */
  listByUser(userId: string): TaskRecord[] {
    return this.list(t => t.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 列出某个用户处于某个状态的任务 */
  countUserRunning(userId: string): number {
    let count = 0
    for (const t of this.cache.values()) {
      if (t.userId === userId && (t.status === 'running' || t.status === 'pending')) count++
    }
    return count
  }

  /** 写入新任务或更新现有任务 */
  save(record: TaskRecord): void {
    this.cache.set(record.id, record)
    this.writeUnsafe(record)
  }

  /** 删除任务（磁盘 + 内存） */
  delete(id: string): boolean {
    if (!this.cache.has(id)) return false
    this.cache.delete(id)
    try {
      unlinkSync(this.filePath(id))
    } catch {}
    return true
  }

  /** 更新状态快捷方法（保持原子性） */
  updateStatus(id: string, status: TaskStatus, patch?: Partial<TaskRecord>): TaskRecord | undefined {
    const current = this.cache.get(id)
    if (!current) return undefined
    const updated: TaskRecord = { ...current, ...patch, status }
    if (isTerminal(status) && !updated.finishedAt) updated.finishedAt = Date.now()
    this.save(updated)
    return updated
  }

  // ============================================================
  // 内部
  // ============================================================

  private filePath(id: string): string {
    return join(this.dir, id + '.json')
  }

  /** 原子写：先写临时文件，再 rename */
  private writeUnsafe(record: TaskRecord): void {
    const finalPath = this.filePath(record.id)
    const tmpPath = finalPath + '.tmp.' + process.pid
    try {
      writeFileSync(tmpPath, JSON.stringify(record, null, 2), 'utf-8')
      renameSync(tmpPath, finalPath)
    } catch (e: any) {
      console.error(`[TaskStore] 写入 ${record.id} 失败: ${e.message}`)
      // 清理残留临时文件
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch {}
    }
  }
}