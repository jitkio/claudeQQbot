import type { DestructiveMatch } from './permissionTypes.js'

interface Rule {
  pattern: RegExp
  warning: string
  severity: 'note' | 'warn' | 'critical'
}

/**
 * 破坏性命令规则库
 * 直接移植 $CC/tools/BashTool/destructiveCommandWarning.ts 第 12-89 行 DESTRUCTIVE_PATTERNS
 * 并新增几条针对 QQ Bot workspace 场景的规则
 */
const DESTRUCTIVE_RULES: Rule[] = [
  // ========== Git 数据丢失 ==========
  { pattern: /\bgit\s+reset\s+--hard\b/, warning: '可能丢弃未提交的改动', severity: 'warn' },
  { pattern: /\bgit\s+push\b[^;&|\n]*[ \t](--force|--force-with-lease|-f)\b/, warning: '可能覆盖远端历史', severity: 'critical' },
  { pattern: /\bgit\s+clean\b(?![^;&|\n]*(?:-[a-zA-Z]*n|--dry-run))[^;&|\n]*-[a-zA-Z]*f/, warning: '可能永久删除未跟踪的文件', severity: 'warn' },
  { pattern: /\bgit\s+checkout\s+(--\s+)?\.[ \t]*($|[;&|\n])/, warning: '可能丢弃所有工作区改动', severity: 'warn' },
  { pattern: /\bgit\s+restore\s+(--\s+)?\.[ \t]*($|[;&|\n])/, warning: '可能丢弃所有工作区改动', severity: 'warn' },
  { pattern: /\bgit\s+stash[ \t]+(drop|clear)\b/, warning: '可能永久删除 stash', severity: 'warn' },
  { pattern: /\bgit\s+branch\s+(-D[ \t]|--delete\s+--force)/, warning: '强制删除分支', severity: 'warn' },

  // ========== Git 安全绕过 ==========
  { pattern: /\bgit\s+(commit|push|merge)\b[^;&|\n]*--no-verify\b/, warning: '跳过了 git hooks', severity: 'note' },
  { pattern: /\bgit\s+commit\b[^;&|\n]*--amend\b/, warning: '会重写最后一次 commit', severity: 'note' },

  // ========== 文件删除 ==========
  { pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*f/, warning: '递归强制删除', severity: 'critical' },
  { pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, warning: '递归强制删除', severity: 'critical' },
  { pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*[rR]/, warning: '递归删除', severity: 'warn' },
  { pattern: /(^|[;&|\n]\s*)rm\s+-[a-zA-Z]*f/, warning: '强制删除', severity: 'warn' },
  { pattern: /\bdd\s+if=/, warning: 'dd 命令可能覆盖磁盘', severity: 'critical' },
  { pattern: /\bmkfs/, warning: '格式化文件系统', severity: 'critical' },
  { pattern: /:\(\)\s*\{\s*:\|\s*:&\s*\}/, warning: 'fork 炸弹', severity: 'critical' },

  // ========== 数据库 ==========
  { pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, warning: '删除数据库对象', severity: 'critical' },
  { pattern: /\bDELETE\s+FROM\s+\w+[ \t]*(;|"|'|\n|$)/i, warning: '删除整张表的所有行', severity: 'critical' },

  // ========== 基础设施 ==========
  { pattern: /\bkubectl\s+delete\b/, warning: '删除 Kubernetes 资源', severity: 'warn' },
  { pattern: /\bterraform\s+destroy\b/, warning: '销毁 Terraform 资源', severity: 'critical' },
  { pattern: /\bdocker\s+(rm|rmi|volume\s+rm|system\s+prune)\b/, warning: '删除 Docker 资源', severity: 'warn' },

  // ========== 网络 / 下载执行 ==========
  { pattern: /\bcurl\s+[^;|&\n]*\|\s*(sh|bash|zsh)/, warning: '从网络下载并执行脚本', severity: 'critical' },
  { pattern: /\bwget\s+[^;|&\n]*\|\s*(sh|bash|zsh)/, warning: '从网络下载并执行脚本', severity: 'critical' },

  // ========== 环境变量/配置 ==========
  { pattern: /\becho\s+.*\s*>\s*~?\/?\.ssh\/authorized_keys/, warning: '写入 SSH 授权文件', severity: 'critical' },
  { pattern: /\bchmod\s+(-R\s+)?777\b/, warning: 'chmod 777 极度开放', severity: 'warn' },
  { pattern: /\bchown\s+-R\b/, warning: '递归改变所有权', severity: 'warn' },
]

/**
 * 检测命令中的所有破坏性模式
 * 返回所有命中的规则列表（可能多条）
 */
export function detectDestructive(command: string): DestructiveMatch[] {
  const matches: DestructiveMatch[] = []
  for (const rule of DESTRUCTIVE_RULES) {
    if (rule.pattern.test(command)) {
      matches.push({
        pattern: rule.pattern.source,
        warning: rule.warning,
        severity: rule.severity,
      })
    }
  }
  return matches
}

/** 判定是否存在至少一条 critical 级别的匹配 */
export function hasCriticalDestructive(command: string): boolean {
  return detectDestructive(command).some(m => m.severity === 'critical')
}
