/**
 * 拒绝追踪器
 *
 * 参考: Claude Code 的 deniedToolUseTracker 机制
 *
 * 目标：session 内被拒绝过的命令/工具调用，bot 不要反复尝试。
 *
 * 设计要点：
 *   1. 按 sessionKey 分桶，内存存储，不落盘
 *   2. 使用"归一化指纹"做相似度判定（避免模型换个空格绕过）
 *   3. 有 TTL，过期自动清理（默认 30 分钟）
 *   4. 自动内存上限（每 session 最多 100 条，超过 FIFO 淘汰）
 */

// ============================================================
// 类型
// ============================================================

export type DenyReason = 'rule' | 'user' | 'explicit'

export interface DenyRecord {
  fingerprint: string       // 归一化后的指纹
  originalInput: string     // 原始命令/参数字符串（用于给 bot 看诊断）
  toolName: string
  reason: DenyReason        // 谁拒的
  message: string           // 拒绝时的消息，原样回传给 bot
  deniedAt: number          // Unix ms 时间戳
}

export interface DenyCheckResult {
  denied: boolean
  record?: DenyRecord       // 命中的记录
  age?: number              // 命中记录的年龄（ms）
}

// ============================================================
// 常量
// ============================================================

const DEFAULT_TTL_MS = 30 * 60 * 1000   // 30 分钟
const MAX_RECORDS_PER_SESSION = 100
const SWEEP_INTERVAL_MS = 5 * 60 * 1000  // 每 5 分钟扫描一次过期记录

// ============================================================
// 主类
// ============================================================

export class DenyTracker {
  private buckets = new Map<string, DenyRecord[]>()
  private ttlMs: number
  private lastSweepAt = 0

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs
  }

  /**
   * 记录一次拒绝
   *
   * @param sessionKey  会话隔离键
   * @param toolName    工具名（bash / edit_file / 等）
   * @param input       工具入参——bash 就是 command 字符串，其他工具用 JSON.stringify
   * @param reason      谁拒的
   * @param message     拒绝原因（原样回传给 bot）
   */
  record(
    sessionKey: string,
    toolName: string,
    input: string,
    reason: DenyReason,
    message: string,
  ): void {
    this.maybeSweep()

    const fingerprint = normalizeFingerprint(toolName, input)
    const bucket = this.buckets.get(sessionKey) ?? []

    // 如果已存在相同指纹，刷新时间戳（但保留原 reason 和 message——user 拒过的不能被 rule 覆盖）
    const existing = bucket.findIndex(r => r.fingerprint === fingerprint)
    if (existing >= 0) {
      const old = bucket[existing]
      // user/explicit 的记录权重更高，不被 rule 覆盖
      if (old.reason === 'user' || old.reason === 'explicit') {
        old.deniedAt = Date.now()  // 只刷新时间
        return
      }
      bucket.splice(existing, 1)  // 删掉旧的，按新的重新插入
    }

    bucket.push({
      fingerprint,
      originalInput: input.slice(0, 500),
      toolName,
      reason,
      message,
      deniedAt: Date.now(),
    })

    // FIFO 淘汰
    while (bucket.length > MAX_RECORDS_PER_SESSION) {
      bucket.shift()
    }

    this.buckets.set(sessionKey, bucket)
  }

  /**
   * 检查某个工具调用是否之前被拒过
   */
  check(sessionKey: string, toolName: string, input: string): DenyCheckResult {
    this.maybeSweep()

    const bucket = this.buckets.get(sessionKey)
    if (!bucket || bucket.length === 0) return { denied: false }

    const fingerprint = normalizeFingerprint(toolName, input)
    const now = Date.now()

    for (const record of bucket) {
      if (record.fingerprint !== fingerprint) continue
      const age = now - record.deniedAt
      if (age > this.ttlMs) continue  // 过期的跳过（sweep 会清）
      return { denied: true, record, age }
    }

    return { denied: false }
  }

  /**
   * 显式清除某条记录——用户改变主意时可以调用
   */
  clear(sessionKey: string, toolName: string, input: string): boolean {
    const bucket = this.buckets.get(sessionKey)
    if (!bucket) return false
    const fp = normalizeFingerprint(toolName, input)
    const idx = bucket.findIndex(r => r.fingerprint === fp)
    if (idx < 0) return false
    bucket.splice(idx, 1)
    return true
  }

  /** 清除整个 session 的所有拒绝记录（新对话时调用） */
  resetSession(sessionKey: string): void {
    this.buckets.delete(sessionKey)
  }

  /** 获取某 session 的当前拒绝列表（调试/审计用） */
  list(sessionKey: string): DenyRecord[] {
    return (this.buckets.get(sessionKey) ?? []).slice()
  }

  /** 定期扫描：清除过期记录和空 bucket */
  private maybeSweep(): void {
    const now = Date.now()
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return
    this.lastSweepAt = now

    for (const [key, bucket] of this.buckets) {
      const alive = bucket.filter(r => now - r.deniedAt <= this.ttlMs)
      if (alive.length === 0) {
        this.buckets.delete(key)
      } else if (alive.length !== bucket.length) {
        this.buckets.set(key, alive)
      }
    }
  }
}

// ============================================================
// 指纹归一化
// ============================================================

/**
 * 把 toolName + input 映射成一个归一化指纹字符串。
 *
 * 目标：同一类"实质相同"的调用得到同一个指纹，防止模型换个空格/引号绕过。
 *
 * 规则：
 *   - bash: 提取基命令 + 主要位置参数，去除引号和多余空白，flag 排序
 *   - 其他工具: 提取关键字段（path、pattern 等），其他忽略
 */
function normalizeFingerprint(toolName: string, input: string): string {
  if (toolName === 'bash') {
    return `bash::${normalizeBashCommand(input)}`
  }

  // 其他工具：尝试解析 JSON，提取关键字段
  try {
    const obj = JSON.parse(input)
    const key = extractKeyFields(toolName, obj)
    return `${toolName}::${key}`
  } catch {
    // 非 JSON 直接压缩空白
    return `${toolName}::${input.replace(/\s+/g, ' ').trim().toLowerCase()}`
  }
}

function normalizeBashCommand(cmd: string): string {
  // 1. 去掉行尾注释
  let s = cmd.replace(/\s+#[^\n]*$/gm, '')

  // 2. 压缩空白
  s = s.replace(/\s+/g, ' ').trim()

  // 3. 去除可以安全移除的引号（不改变语义的单引号/双引号）
  //    例：rm -rf 'foo' → rm -rf foo
  s = s.replace(/(['"])([^'"\s]+)\1/g, '$2')

  // 4. 对 shell 管道分段，每段单独归一化
  const segments = s.split(/(\s*(?:;|&&|\|\||\|)\s*)/)
  const normalizedSegments: string[] = []
  for (const seg of segments) {
    if (/^\s*(?:;|&&|\|\||\|)\s*$/.test(seg)) {
      normalizedSegments.push(seg.trim())
      continue
    }
    normalizedSegments.push(normalizeSingleCommand(seg))
  }

  return normalizedSegments.join(' ').toLowerCase()
}

function normalizeSingleCommand(seg: string): string {
  const tokens = seg.trim().split(/\s+/)
  if (tokens.length === 0) return ''

  const base = tokens[0]
  const rest = tokens.slice(1)

  // 把 flag 和位置参数分开
  const flags: string[] = []
  const positional: string[] = []
  for (const t of rest) {
    if (t.startsWith('-')) flags.push(t)
    else positional.push(t)
  }

  // flag 排序，位置参数保持原序
  flags.sort()

  return [base, ...flags, ...positional].join(' ')
}

function extractKeyFields(toolName: string, obj: Record<string, any>): string {
  // 每个工具挑 1-2 个"标识性字段"做指纹
  const FIELD_MAP: Record<string, string[]> = {
    read_file: ['path'],
    write_file: ['path'],
    edit_file: ['path'],
    glob: ['pattern', 'path'],
    grep: ['pattern', 'path'],
    web_fetch: ['url'],
    web_search: ['query'],
    python: ['code'],
  }
  const fields = FIELD_MAP[toolName] ?? Object.keys(obj).slice(0, 3)
  const parts: string[] = []
  for (const f of fields) {
    const v = obj[f]
    if (v === undefined) continue
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    parts.push(`${f}=${s.replace(/\s+/g, ' ').trim().toLowerCase()}`)
  }
  return parts.join('|')
}

// ============================================================
// 单例
// ============================================================

/** 全局单例实例（按进程共享） */
let _globalInstance: DenyTracker | null = null

export function getGlobalDenyTracker(): DenyTracker {
  if (!_globalInstance) {
    _globalInstance = new DenyTracker()
  }
  return _globalInstance
}