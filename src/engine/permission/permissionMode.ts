import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import type { PermissionMode } from './permissionTypes.js'
import { safeSessionKey } from '../utils/sessionKey.js'

/**
 * 会话级的权限模式管理
 *
 * 每个 sessionKey 有独立的模式，持久化到文件，服务重启后恢复
 */
export class PermissionModeManager {
  private modeDir: string

  constructor(baseDir: string) {
    this.modeDir = `${baseDir}/permission_modes`
    mkdirSync(this.modeDir, { recursive: true })
  }

  private pathFor(sessionKey: string): string {
    return `${this.modeDir}/${safeSessionKey(sessionKey)}.json`
  }

  /** 读取某会话当前模式 */
  getMode(sessionKey: string): PermissionMode {
    const p = this.pathFor(sessionKey)
    if (!existsSync(p)) return 'default'
    try {
      const raw = readFileSync(p, 'utf-8')
      const parsed = JSON.parse(raw)
      return parsed.mode ?? 'default'
    } catch {
      return 'default'
    }
  }

  /** 设置某会话的模式 */
  setMode(sessionKey: string, mode: PermissionMode): void {
    const p = this.pathFor(sessionKey)
    writeFileSync(p, JSON.stringify({ mode, updatedAt: Date.now() }, null, 2))
  }

  /**
   * 校验模式切换是否被允许
   * - bypass 只能在环境变量 BYPASS_PERMISSIONS=true 时启用
   * - 从 bypass 切换到其他模式无需限制
   */
  canSwitchTo(newMode: PermissionMode): { allowed: boolean; reason?: string } {
    if (newMode === 'bypass' && process.env.BYPASS_PERMISSIONS !== 'true') {
      return {
        allowed: false,
        reason: 'bypass 模式需要设置环境变量 BYPASS_PERMISSIONS=true 才能启用',
      }
    }
    return { allowed: true }
  }
}
