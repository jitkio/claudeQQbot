import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { PermissionDecision, PermissionMode } from './permissionTypes.js'

export interface AuditRecord {
  timestamp: string
  sessionKey: string
  userId: string
  mode: PermissionMode
  toolName: string
  toolInput: unknown          // bash 命令字符串或其他工具参数
  decision: PermissionDecision['behavior']
  reason: string
  warnings?: string[]
}

export class AuditLog {
  private path: string

  constructor(baseDir: string) {
    this.path = `${baseDir}/audit.jsonl`
    mkdirSync(dirname(this.path), { recursive: true })
  }

  record(data: Omit<AuditRecord, 'timestamp'>): void {
    const record: AuditRecord = {
      timestamp: new Date().toISOString(),
      ...data,
    }
    try {
      appendFileSync(this.path, JSON.stringify(record) + '\n')
    } catch (e: any) {
      console.error('[Audit] 写入失败:', e.message)
    }
  }
}
