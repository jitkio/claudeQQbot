import { resolve, dirname, isAbsolute } from 'path'
import { homedir } from 'os'
import type { PathCheckResult, PermissionContext } from './permissionTypes.js'

/**
 * 危险删除路径黑名单
 * 参照 $CC/utils/permissions/pathValidation.ts 第 331-367 行 isDangerousRemovalPath
 */
export function isDangerousPath(path: string): boolean {
  const normalized = path.replace(/\\+/g, '/').replace(/\/+/g, '/')

  // 通配符
  if (normalized === '*' || normalized.endsWith('/*')) return true

  // 根目录
  const trimmed = normalized === '/' ? '/' : normalized.replace(/\/$/, '')
  if (trimmed === '/') return true

  // home 目录
  const home = homedir().replace(/\\+/g, '/')
  if (trimmed === home) return true

  // 根目录的直接子目录：/usr /tmp /etc /var /bin /sbin /lib ...
  if (dirname(trimmed) === '/') return true

  // Windows 盘符根
  if (/^[A-Za-z]:\/?$/.test(trimmed)) return true
  if (/^[A-Za-z]:\/[^/]+$/.test(trimmed)) return true

  return false
}

/** 解析用户输入的路径为绝对路径 */
function resolvePath(path: string, cwd: string): string {
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  if (path === '~') return homedir()
  if (isAbsolute(path)) return resolve(path)
  return resolve(cwd, path)
}

/**
 * 检查一个写路径是否被允许
 *
 * 策略：
 * 1. 命中 isDangerousPath → 拒绝
 * 2. 命中 ctx.deniedPaths → 拒绝
 * 3. 在 workspaceRoot 或 allowedDirs 之下 → 允许
 * 4. 其他 → ask（要求二次确认）
 */
export function checkWritePath(
  path: string,
  ctx: PermissionContext,
  cwd: string,
): PathCheckResult {
  const resolved = resolvePath(path, cwd)

  if (isDangerousPath(resolved)) {
    return {
      allowed: false,
      path: resolved,
      reason: `危险路径：${resolved}（系统关键目录）`,
      isDangerous: true,
    }
  }

  // 展开 deniedPaths 中的 ~
  const denied = ctx.deniedPaths.map(p => p.startsWith('~') ? resolvePath(p, cwd) : resolve(p))
  for (const d of denied) {
    if (resolved === d || resolved.startsWith(d + '/')) {
      return {
        allowed: false,
        path: resolved,
        reason: `路径在黑名单内：${d}`,
        isDangerous: true,
      }
    }
  }

  // 允许目录检查
  const allowedRoots = [ctx.workspaceRoot, ...ctx.allowedDirs].filter(Boolean).map(p => resolve(p))
  for (const root of allowedRoots) {
    if (resolved === root || resolved.startsWith(root + '/')) {
      return {
        allowed: true,
        path: resolved,
        reason: `在允许目录内：${root}`,
        isDangerous: false,
      }
    }
  }

  return {
    allowed: false,
    path: resolved,
    reason: `路径不在 workspace 内：${resolved}`,
    isDangerous: false,
  }
}

/**
 * 从命令参数中提取所有可能的路径（启发式）
 *
 * 参照 $CC/tools/BashTool/pathValidation.ts 的 PATH_EXTRACTORS 思路，
 * 但实现简化为：所有非 flag 的参数都当作候选路径
 */
export function extractPathArgs(args: string[]): string[] {
  return args.filter(a => !a.startsWith('-') && !a.startsWith('$'))
}
