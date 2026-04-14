import type { ToolDef } from '../types.js'
import type {
  ToolCallInfo,
  ToolCallResult,
  ExecutionBatch,
  RunToolsResult,
  ToolExecutionContext,
} from './orchestratorTypes.js'
import { getMaxConcurrency, getDefaultToolTimeout } from './concurrencyConfig.js'

/**
 * 核心调度器：接收一轮 tool_calls，返回一轮 tool_results
 *
 * 参照 $CC/services/tools/toolOrchestration.ts 的 runTools 函数（第 19-82 行）
 * 但不使用 async generator 模式，改用简单的 Promise 聚合
 */
export class ToolOrchestrator {
  private tools: Map<string, ToolDef>

  constructor(tools: ToolDef[]) {
    this.tools = new Map(tools.map(t => [t.name, t]))
  }

  /**
   * 执行一整轮 tool_calls
   *
   * 算法：
   * 1. partitionToolCalls 把 calls 分成批次
   * 2. 每个批次按 isConcurrencySafe 选并发或串行策略
   * 3. 所有批次的结果按原始输入顺序合并
   */
  async runTools(
    calls: ToolCallInfo[],
    context: ToolExecutionContext,
  ): Promise<RunToolsResult> {
    const startTime = Date.now()

    if (calls.length === 0) {
      return {
        results: [],
        totalDurationMs: 0,
        batchCount: 0,
        concurrentCallCount: 0,
        serialCallCount: 0,
        abortedCallCount: 0,
      }
    }

    const batches = this.partitionToolCalls(calls)
    const resultMap = new Map<string, ToolCallResult>()

    let concurrentCount = 0
    let serialCount = 0
    let abortedCount = 0

    for (const batch of batches) {
      // 检查上层是否已中止
      if (context.abortSignal.aborted) {
        // 把后续还没跑的都标记为 aborted
        for (const call of batch.calls) {
          resultMap.set(call.id, {
            id: call.id,
            name: call.name,
            success: false,
            content: '[工具执行已取消]',
            errorMessage: 'aborted by parent',
            durationMs: 0,
          })
          abortedCount++
        }
        continue
      }

      if (batch.isConcurrencySafe && batch.calls.length > 1) {
        concurrentCount += batch.calls.length
        const results = await this.runBatchConcurrently(batch.calls, context)
        for (const r of results) resultMap.set(r.id, r)
      } else {
        serialCount += batch.calls.length
        const results = await this.runBatchSerially(batch.calls, context)
        for (const r of results) resultMap.set(r.id, r)
      }
    }

    // 按原始顺序回填
    const orderedResults = calls.map(c =>
      resultMap.get(c.id) ?? this.missingToolResult(c)
    )

    return {
      results: orderedResults,
      totalDurationMs: Date.now() - startTime,
      batchCount: batches.length,
      concurrentCallCount: concurrentCount,
      serialCallCount: serialCount,
      abortedCallCount: abortedCount,
    }
  }

  /**
   * 把一轮 tool_calls 分成批次
   *
   * 严格参照 $CC/services/tools/toolOrchestration.ts 第 91-116 行 partitionToolCalls：
   * - 连续的 concurrency-safe 调用合并为一个并发批次
   * - 非并发安全的调用单独成批
   * - 保持原始顺序
   */
  private partitionToolCalls(calls: ToolCallInfo[]): ExecutionBatch[] {
    const batches: ExecutionBatch[] = []

    for (const call of calls) {
      const tool = this.tools.get(call.name)
      const isSafe = tool
        ? this.checkConcurrencySafety(tool, call.input)
        : false

      const lastBatch = batches[batches.length - 1]
      if (isSafe && lastBatch?.isConcurrencySafe) {
        // 合并到现有并发批次
        lastBatch.calls.push(call)
      } else {
        // 新开一个批次
        batches.push({ isConcurrencySafe: isSafe, calls: [call] })
      }
    }

    return batches
  }

  /**
   * 判定一次工具调用是否可以并发
   *
   * 参照 $CC/services/tools/toolOrchestration.ts 第 96-108 行：
   * - 先尝试 parse input
   * - 再调用 tool.isConcurrencySafe(parsedInput)
   * - 任何异常都保守地返回 false
   */
  private checkConcurrencySafety(tool: ToolDef, input: unknown): boolean {
    try {
      if (typeof tool.isConcurrencySafe === 'function') {
        return Boolean(tool.isConcurrencySafe(input))
      }
      if (typeof tool.isConcurrencySafe === 'boolean') {
        return tool.isConcurrencySafe
      }
      // 未声明 → 保守视为非并发安全
      return false
    } catch {
      return false
    }
  }

  /**
   * 并发执行一个批次
   *
   * 参照 $CC/services/tools/toolOrchestration.ts 第 152-177 行 runToolsConcurrently
   * 简化：不使用 async generator，直接 Promise.all + 并发度限制
   */
  private async runBatchConcurrently(
    calls: ToolCallInfo[],
    context: ToolExecutionContext,
  ): Promise<ToolCallResult[]> {
    const maxConcurrency = getMaxConcurrency()
    const results: ToolCallResult[] = new Array(calls.length)

    // 简易并发池：每完成一个就拉下一个
    let cursor = 0
    const self = this
    async function worker() {
      while (cursor < calls.length) {
        const myIdx = cursor++
        if (myIdx >= calls.length) break
        results[myIdx] = await self.executeSingleTool(calls[myIdx], context)
      }
    }

    const workers = Array.from(
      { length: Math.min(maxConcurrency, calls.length) },
      () => worker(),
    )
    await Promise.all(workers)
    return results
  }

  /**
   * 串行执行一个批次
   *
   * 参照 $CC/services/tools/toolOrchestration.ts 第 118-150 行 runToolsSerially
   */
  private async runBatchSerially(
    calls: ToolCallInfo[],
    context: ToolExecutionContext,
  ): Promise<ToolCallResult[]> {
    const results: ToolCallResult[] = []
    for (const call of calls) {
      if (context.abortSignal.aborted) {
        results.push({
          id: call.id,
          name: call.name,
          success: false,
          content: '[工具执行已取消]',
          errorMessage: 'aborted',
          durationMs: 0,
        })
        continue
      }
      results.push(await this.executeSingleTool(call, context))
    }
    return results
  }

  /** 执行单个工具调用（含超时控制） */
  private async executeSingleTool(
    call: ToolCallInfo,
    context: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    const startTime = Date.now()
    const tool = this.tools.get(call.name)

    if (!tool) {
      return {
        id: call.id,
        name: call.name,
        success: false,
        content: `[错误] 未知工具: ${call.name}`,
        errorMessage: 'tool not found',
        durationMs: 0,
      }
    }

    // 超时控制
    const timeoutMs = context.timeout || getDefaultToolTimeout()
    const timeoutCtrl = new AbortController()
    const timer = setTimeout(() => timeoutCtrl.abort(), timeoutMs)

    try {
      const content = await Promise.race([
        tool.execute(call.input as Record<string, any>, context),
        new Promise<never>((_, reject) =>
          timeoutCtrl.signal.addEventListener('abort', () =>
            reject(new Error(`[超时] 工具 ${call.name} 超过 ${timeoutMs}ms`)),
          ),
        ),
      ])

      // 截断过长的工具结果
      let result = typeof content === 'string' ? content : JSON.stringify(content)
      if (result.length > 30000) {
        result = result.slice(0, 30000) + '\n...(结果已截断)'
      }

      return {
        id: call.id,
        name: call.name,
        success: true,
        content: result,
        durationMs: Date.now() - startTime,
      }
    } catch (e: any) {
      return {
        id: call.id,
        name: call.name,
        success: false,
        content: `[工具执行错误] ${e.message || String(e)}`,
        errorMessage: e.message || String(e),
        durationMs: Date.now() - startTime,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private missingToolResult(call: ToolCallInfo): ToolCallResult {
    return {
      id: call.id,
      name: call.name,
      success: false,
      content: '[错误] 调度器遗漏该工具调用',
      errorMessage: 'missing result',
      durationMs: 0,
    }
  }
}
