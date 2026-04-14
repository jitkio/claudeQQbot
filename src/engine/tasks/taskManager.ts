/**
 * 后台任务管理器
 *
 * 职责：
 *   1. create() — 创建新任务（超配额则进入 pending）
 *   2. 启动子 agent 执行任务（完全独立，不污染主会话）
 *   3. 状态管理（pending/running/done/failed/stopped/timeout）
 *   4. stop() — 显式停止任务
 *   5. drainCompletedForUser() — 主循环拉取"已完成但未通知"的任务
 *   6. 并发控制：每用户最多 2 个同时运行
 *
 * 这个类是单例，在 taskQueue 模块加载时创建一次，在整个 bot 进程内共享。
 */

import type { ModelConfig, Message } from '../types.js'
import type { PermissionContext } from '../permission/permissionTypes.js'
import type { UserConfirmBridge } from '../permission/userConfirmBridge.js'
import type { AuditLog } from '../permission/auditLog.js'
import {
  PER_USER_RUNNING_LIMIT,
  GLOBAL_MAX_TASKS,
  DEFAULT_TASK_MAX_DURATION_MS,
  HARD_TASK_MAX_DURATION_MS,
  MAX_OUTPUT_BLOCKS_PER_TASK,
  MAX_OUTPUT_BLOCK_CHARS,
  isTerminal,
  type TaskRecord,
  type OutputBlock,
  type TaskStatus,
} from './taskTypes.js'
import { TaskStore } from './taskStore.js'

// 避免循环依赖：动态导入 runAgent
let _runAgent: any = null
async function getRunAgent() {
  if (!_runAgent) {
    const mod = await import('../agentEngine.js')
    _runAgent = mod.runAgent
  }
  return _runAgent
}

// ============================================================
// 依赖注入
// ============================================================

/**
 * TaskManager 在执行任务时需要一些"执行环境"
 * 这些依赖由 taskQueue 在创建 manager 时注入
 */
export interface TaskManagerDeps {
  workDir: string
  confirmBridge: UserConfirmBridge
  auditLog: AuditLog
}

// ============================================================
// 创建任务的参数（暴露给 task_create 工具）
// ============================================================

export interface CreateTaskParams {
  userId: string
  sessionKey: string
  notifyTarget: { kind: 'c2c' | 'group'; targetId: string }
  description: string
  title?: string
  maxDurationMs?: number
  modelConfig: ModelConfig
  permissionContext: PermissionContext
}

// ============================================================
// 主类
// ============================================================

export class TaskManager {
  private store: TaskStore
  private deps: TaskManagerDeps | null = null
  /** 运行中任务的 AbortController 映射（用于 stop） */
  private abortControllers = new Map<string, AbortController>()
  /** 运行中任务的超时定时器 */
  private timeoutTimers = new Map<string, NodeJS.Timeout>()
  /** 已启动标志 */
  private started = false

  constructor(baseDir: string) {
    this.store = new TaskStore(baseDir)
  }

  /**
   * 启动：恢复磁盘状态，清理孤儿任务
   * 必须在 bot 启动早期调用一次
   */
  start(deps: TaskManagerDeps): void {
    if (this.started) throw new Error('TaskManager 已启动过')
    this.started = true
    this.deps = deps

    const { orphaned, purged } = this.store.loadFromDisk()
    if (orphaned.length > 0) {
      console.warn(`[TaskManager] 重启前有 ${orphaned.length} 个未完成任务被标记为 failed: ${orphaned.join(', ')}`)
    }
    if (purged > 0) {
      console.log(`[TaskManager] 清理了 ${purged} 个过期任务`)
    }
  }

  // ============================================================
  // Create
  // ============================================================

  /**
   * 创建任务
   *
   * 如果用户已有的运行中任务 >= PER_USER_RUNNING_LIMIT，任务进入 pending 状态。
   * 否则立即进入 running 状态并开始执行。
   */
  create(params: CreateTaskParams): TaskRecord {
    if (!this.deps) throw new Error('TaskManager 未启动')

    // 全局上限检查
    const total = this.store.list().length
    if (total >= GLOBAL_MAX_TASKS) {
      throw new Error(`全局任务数已达上限 (${GLOBAL_MAX_TASKS})，请稍后再试`)
    }

    // 构造记录
    const id = this.store.generateId()
    const now = Date.now()
    const maxDuration = Math.min(
      params.maxDurationMs ?? DEFAULT_TASK_MAX_DURATION_MS,
      HARD_TASK_MAX_DURATION_MS,
    )

    const record: TaskRecord = {
      id,
      userId: params.userId,
      originSessionKey: params.sessionKey,
      notifyTarget: params.notifyTarget,
      description: params.description,
      title: params.title,
      status: 'pending',
      pendingUpdates: [],
      outputs: [],
      createdAt: now,
      maxDurationMs: maxDuration,
      notified: false,
      modelConfig: {
        provider: params.modelConfig.provider,
        model: params.modelConfig.model,
        apiKey: params.modelConfig.apiKey,
        baseUrl: params.modelConfig.baseUrl,
      },
      permissionMode: params.permissionContext.mode,
    }

    // 判断是否能立即启动
    const runningCount = this.store.countUserRunning(params.userId)
    if (runningCount >= PER_USER_RUNNING_LIMIT) {
      // 排队 —— 暂时不启动
      this.store.save(record)
      console.log(`[TaskManager] ${id} 创建但排队（用户 ${params.userId} 已有 ${runningCount} 个运行中）`)
      return record
    }

    // 立即启动
    this.store.save(record)
    this.launch(record, params.permissionContext)
    return record
  }

  // ============================================================
  // Launch（内部）
  // ============================================================

  private launch(record: TaskRecord, permissionContext: PermissionContext): void {
    const id = record.id
    const abortController = new AbortController()
    this.abortControllers.set(id, abortController)

    // 更新状态到 running
    const runningRecord = this.store.updateStatus(id, 'running', {
      startedAt: Date.now(),
    })
    if (!runningRecord) return

    // 超时定时器
    const timer = setTimeout(() => {
      console.warn(`[TaskManager] ${id} 超时 (${runningRecord.maxDurationMs}ms)`)
      abortController.abort()
      this.finish(id, 'timeout', { error: `任务超过 ${runningRecord.maxDurationMs}ms 未完成` })
    }, runningRecord.maxDurationMs)
    this.timeoutTimers.set(id, timer)

    // fire-and-forget
    this.executeTask(runningRecord, abortController, permissionContext)
      .catch((e: any) => {
        console.error(`[TaskManager] ${id} 执行异常:`, e)
        this.finish(id, 'failed', { error: e.message ?? String(e) })
      })
  }

  // ============================================================
  // Execute（核心：实际派出一个独立 runAgent）
  // ============================================================

  private async executeTask(
    record: TaskRecord,
    abortController: AbortController,
    permissionContext: PermissionContext,
  ): Promise<void> {
    if (!this.deps) return

    const runAgent = await getRunAgent()

    // 为任务创建专属的 sessionKey（隔离 memory/todo）
    const taskSessionKey = `bgtask_${record.id}`

    // 构造完整的 prompt：描述 + 所有 pendingUpdates
    const prompt = this.composePrompt(record)

    // 任务专属 system prompt
    const systemPrompt = `你是一个后台任务执行子 Agent。你的任务是完全独立地完成用户派给你的工作，不能询问用户任何问题——用户不在这里。

你的任务:
${record.description}

约束:
- 这是后台任务，用户不会看到你的中间过程，只会看到最终结果
- 不要寒暄，直接开干
- 遇到不确定的地方按常识做决定并在最终报告里说明
- 每一步的重要决策和产出都要总结到最终回复里，这是用户唯一能看到的东西
- 如果需要生成文件，保存到 workspace/output/ 目录下

最终回复的格式:
1. 做了什么（按步骤）
2. 关键结果或发现（具体、有数字）
3. 如果有生成文件，列出路径
4. 如果遇到无法解决的问题，说明原因`

    // 后台任务使用发起时快照的权限模式
    const subPermissionContext: PermissionContext = {
      ...permissionContext,
      sessionKey: taskSessionKey,
      mode: record.permissionMode as any,
    }

    try {
      const result = await runAgent(prompt, {
        modelConfig: record.modelConfig as ModelConfig,
        systemPrompt,
        maxTurns: 30,  // 后台任务允许更多轮
        timeoutMs: record.maxDurationMs,
        workDir: this.deps.workDir,
        toolTimeout: 120000,
        userId: record.userId,
        sessionKey: taskSessionKey,
        permissionContext: subPermissionContext,
        confirmBridge: this.deps.confirmBridge,
        auditLog: this.deps.auditLog,
        parentAbortSignal: abortController.signal,
        isSubAgent: true,   // 让 agentEngine 知道这是子 agent
        agentDepth: 0,       // 后台任务是独立顶层，深度重置
      })

      // 正常完成
      this.finish(record.id, 'done', {
        result: {
          content: result.content,
          toolCallCount: result.toolCallCount,
          turnCount: result.turnCount,
        },
      })
    } catch (e: any) {
      if (abortController.signal.aborted) {
        // 已经被 stop 或 timeout 处理过了，不覆盖状态
        return
      }
      this.finish(record.id, 'failed', { error: e.message ?? String(e) })
    }
  }

  /**
   * 把 description + pendingUpdates 合并为最终 prompt
   */
  private composePrompt(record: TaskRecord): string {
    if (record.pendingUpdates.length === 0) {
      return record.description
    }
    const updates = record.pendingUpdates
      .map((u, i) => `${i + 1}. ${u}`)
      .join('\n')
    return `${record.description}\n\n---\n用户后续追加的指令（按顺序执行）:\n${updates}`
  }

  // ============================================================
  // Finish（内部）
  // ============================================================

  private finish(id: string, status: TaskStatus, patch?: Partial<TaskRecord>): void {
    // 清理定时器
    const timer = this.timeoutTimers.get(id)
    if (timer) { clearTimeout(timer); this.timeoutTimers.delete(id) }
    this.abortControllers.delete(id)

    const updated = this.store.updateStatus(id, status, patch)
    if (!updated) return

    console.log(`[TaskManager] ${id} 完成，状态: ${status}`)

    // 唤醒该用户的下一个 pending 任务（如果有）
    this.dispatchNextPendingForUser(updated.userId)
  }

  /** 找到该用户下一个 pending 任务并启动它 */
  private dispatchNextPendingForUser(userId: string): void {
    const runningCount = this.store.countUserRunning(userId)
    if (runningCount >= PER_USER_RUNNING_LIMIT) return

    const pending = this.store
      .listByUser(userId)
      .filter(t => t.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)[0]  // FIFO

    if (!pending) return
    if (!this.deps) return

    // pending 任务启动时，我们没有原始的 permissionContext——
    // 用快照里的 mode 重建一个
    const permissionContext: PermissionContext = {
      mode: pending.permissionMode as any,
      userId: pending.userId,
      sessionKey: `bgtask_${pending.id}`,
      workspaceRoot: this.deps.workDir,
      allowedDirs: [],
      deniedPaths: [
        '/etc', '/boot', '/sys', '/proc',
        '~/.ssh', '~/.aws', '~/.config',
        '/var/log', '/var/lib',
      ],
      bypassEnvFlag: false,
    }

    console.log(`[TaskManager] 唤醒下一个 pending 任务 ${pending.id}`)
    this.launch(pending, permissionContext)
  }

  // ============================================================
  // Stop
  // ============================================================

  stop(id: string, userId: string): { ok: boolean; reason: string } {
    const record = this.store.get(id)
    if (!record) return { ok: false, reason: '任务不存在' }
    if (record.userId !== userId) return { ok: false, reason: '不是你的任务' }
    if (isTerminal(record.status)) return { ok: false, reason: `任务已经处于 ${record.status} 状态` }

    const controller = this.abortControllers.get(id)
    if (controller) controller.abort()
    this.finish(id, 'stopped', { error: '被用户停止' })
    return { ok: true, reason: '已停止' }
  }

  // ============================================================
  // Update
  // ============================================================

  /**
   * 给运行中或 pending 的任务追加指令
   * running 状态下：追加的指令会在当前 agent loop 的下一轮被看到（其实不会——子 agent 已经在跑了）
   * pending 状态下：追加的指令会在真正启动时合并进 prompt
   *
   * 注：running 状态追加是"记录以备后用"，不能实时注入——子 agent 已经在自己的对话循环里
   */
  update(id: string, userId: string, additionalInstruction: string): { ok: boolean; reason: string } {
    const record = this.store.get(id)
    if (!record) return { ok: false, reason: '任务不存在' }
    if (record.userId !== userId) return { ok: false, reason: '不是你的任务' }
    if (isTerminal(record.status)) return { ok: false, reason: `任务已经是 ${record.status} 状态，无法更新` }

    record.pendingUpdates.push(additionalInstruction)
    this.store.save(record)
    return { ok: true, reason: '已追加指令' }
  }

  // ============================================================
  // 查询接口
  // ============================================================

  get(id: string): TaskRecord | undefined {
    return this.store.get(id)
  }

  listByUser(userId: string): TaskRecord[] {
    return this.store.listByUser(userId)
  }

  /**
   * 主循环钩子：拉取指定用户"已完成但未通知"的任务
   *
   * 调用后这些任务的 notified 字段会被置为 true，下次调用就不会再返回。
   * 主循环在每次收到用户消息时调一次这个方法，把返回的任务提示给用户。
   */
  drainCompletedForUser(userId: string): TaskRecord[] {
    const unnotified = this.store.list(
      t => t.userId === userId && isTerminal(t.status) && !t.notified,
    )
    // 标记为已通知
    for (const t of unnotified) {
      t.notified = true
      this.store.save(t)
    }
    // 按完成时间排序
    return unnotified.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
  }

  // ============================================================
  // 输出块（给 task_output 工具用）
  // ============================================================

  /**
   * 向运行中任务追加一条输出块
   * （目前 agentEngine 并没有实时回调机制，这个方法暂时给未来扩展用）
   */
  appendOutput(id: string, block: OutputBlock): void {
    const record = this.store.get(id)
    if (!record) return
    if (isTerminal(record.status)) return

    const trimmed: OutputBlock = {
      ...block,
      content: block.content.slice(0, MAX_OUTPUT_BLOCK_CHARS),
    }
    record.outputs.push(trimmed)

    // 滚动丢弃最旧的
    while (record.outputs.length > MAX_OUTPUT_BLOCKS_PER_TASK) {
      record.outputs.shift()
    }
    this.store.save(record)
  }
}

// ============================================================
// 全局单例
// ============================================================

let _globalManager: TaskManager | null = null

export function getGlobalTaskManager(baseDir: string): TaskManager {
  if (!_globalManager) _globalManager = new TaskManager(baseDir)
  return _globalManager
}