import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/**
 * 用量记录
 */
interface UsageRecord {
  timestamp: number
  sessionKey: string
  userId: string
  model: string
  inputTokens: number
  outputTokens: number
  toolCalls: number
  estimatedCost: number    // 单位: 人民币元
}

/**
 * Token 用量追踪器
 * 记录每次 API 调用的 token 用量和费用
 * 存储为 JSONL 格式（每行一条记录）
 */
export class UsageTracker {
  private dbFile: string

  constructor(workDir: string) {
    this.dbFile = `${workDir}/usage.jsonl`
    // 确保目录存在
    const dir = dirname(this.dbFile)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  /**
   * 记录一次 API 调用
   */
  record(data: Omit<UsageRecord, 'timestamp' | 'estimatedCost'>) {
    const cost = this.calculateCost(data.model, data.inputTokens, data.outputTokens)
    const record: UsageRecord = { ...data, timestamp: Date.now(), estimatedCost: cost }
    try {
      appendFileSync(this.dbFile, JSON.stringify(record) + '\n')
    } catch (e: any) {
      console.error(`[UsageTracker] 写入失败: ${e.message}`)
    }
  }

  /**
   * 查询某用户的用量统计
   */
  getUserUsage(userId: string, days = 30): { totalCost: number; totalTokens: number; callCount: number; inputTokens: number; outputTokens: number } {
    const since = Date.now() - days * 86400000
    const records = this.loadRecords().filter(r => r.userId === userId && r.timestamp > since)
    return {
      totalCost: records.reduce((s, r) => s + r.estimatedCost, 0),
      totalTokens: records.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0),
      inputTokens: records.reduce((s, r) => s + r.inputTokens, 0),
      outputTokens: records.reduce((s, r) => s + r.outputTokens, 0),
      callCount: records.length,
    }
  }

  /**
   * 查询全局用量统计
   */
  getGlobalUsage(days = 30): { totalCost: number; totalTokens: number; callCount: number; topModels: Record<string, number> } {
    const since = Date.now() - days * 86400000
    const records = this.loadRecords().filter(r => r.timestamp > since)
    const topModels: Record<string, number> = {}
    for (const r of records) {
      topModels[r.model] = (topModels[r.model] || 0) + 1
    }
    return {
      totalCost: records.reduce((s, r) => s + r.estimatedCost, 0),
      totalTokens: records.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0),
      callCount: records.length,
      topModels,
    }
  }

  /**
   * 格式化用量报告
   */
  formatUsageReport(userId: string, days = 30): string {
    const usage = this.getUserUsage(userId, days)
    if (usage.callCount === 0) {
      return `最近 ${days} 天没有调用记录`
    }
    const costYuan = usage.totalCost.toFixed(4)
    const avgTokens = Math.round(usage.totalTokens / usage.callCount)
    return [
      `最近 ${days} 天用量统计`,
      `调用次数: ${usage.callCount} 次`,
      `总 Token: ${usage.totalTokens.toLocaleString()} (输入 ${usage.inputTokens.toLocaleString()} + 输出 ${usage.outputTokens.toLocaleString()})`,
      `平均每次: ${avgTokens.toLocaleString()} token`,
      `预估费用: ￥${costYuan}`,
    ].join('\n')
  }

  /**
   * 计算费用（人民币元）
   */
  private calculateCost(model: string, input: number, output: number): number {
    // 定价表: [输入价, 输出价] 单位: 元/百万token
    const pricing: Record<string, [number, number]> = {
      'deepseek-chat': [1, 2],
      'deepseek-reasoner': [4, 16],
      'claude-sonnet-4-20250514': [21, 105],
      'claude-3-5-sonnet-20241022': [21, 105],
      'claude-3-5-haiku-20241022': [7, 28],
      'gpt-4o': [17.5, 70],
      'gpt-4o-mini': [1.05, 4.2],
      'gpt-4-turbo': [70, 210],
      'qwen-plus': [2.8, 11.2],
      'qwen-turbo': [0.35, 1.4],
      'moonshot-v1-8k': [8.4, 8.4],
      'moonshot-v1-32k': [16.8, 16.8],
    }

    // 模糊匹配模型名
    let rates: [number, number] | undefined
    for (const [key, val] of Object.entries(pricing)) {
      if (model.includes(key) || key.includes(model)) {
        rates = val
        break
      }
    }
    if (!rates) rates = [7, 14]  // 默认定价

    const [inPrice, outPrice] = rates
    return (input * inPrice + output * outPrice) / 1_000_000
  }

  /**
   * 加载所有记录
   */
  private loadRecords(): UsageRecord[] {
    if (!existsSync(this.dbFile)) return []
    try {
      const content = readFileSync(this.dbFile, 'utf-8')
      return content
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          try { return JSON.parse(line) } catch { return null }
        })
        .filter(Boolean) as UsageRecord[]
    } catch {
      return []
    }
  }
}

// 全局单例
let _tracker: UsageTracker | null = null

export function getUsageTracker(workDir: string): UsageTracker {
  if (!_tracker) {
    _tracker = new UsageTracker(workDir)
  }
  return _tracker
}
