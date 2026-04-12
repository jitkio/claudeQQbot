import { spawn, spawnSync } from 'child_process'
import { existsSync, writeFileSync, readFileSync, mkdirSync, openSync, closeSync } from 'fs'
import { randomUUID } from 'crypto'
import { CONFIG, PROJECT_ROOT } from './config.js'
import { runAgent } from './engine/agentEngine.js'
import type { ModelConfig } from './engine/types.js'
import { MemoryManager } from './engine/memory/memoryManager.js'

import { PermissionModeManager } from './engine/permission/permissionMode.js'
import { UserConfirmBridge } from './engine/permission/userConfirmBridge.js'
import { AuditLog } from './engine/permission/auditLog.js'
import { DEFAULT_PERMISSION_CONTEXT } from './engine/permission/permissionTypes.js'
import type { PermissionContext } from './engine/permission/permissionTypes.js'

// 进度文件管理
const PROGRESS_DIR = `${PROJECT_ROOT}/workspace/progress`
function writeProgress(taskId: string, data: any) {
  try {
    const { mkdirSync, writeFileSync } = require('fs')
    mkdirSync(PROGRESS_DIR, { recursive: true })
    writeFileSync(PROGRESS_DIR + '/' + taskId + '.json', JSON.stringify(data))
  } catch {}
}
function cleanProgress(taskId: string) {
  setTimeout(() => {
    try { require('fs').unlinkSync(PROGRESS_DIR + '/' + taskId + '.json') } catch {}
  }, 300000)
}


// 从 Claude 回复中检测生成的文件路径
function detectOutputFiles(resp: string): string[] {
  const files: string[] = []
  const re = new RegExp(`${PROJECT_ROOT.replace(/[\\/]/g, "\\\\")}\\/workspace\\/(?:output|uploads)\\/\\S+\\.\\w+`, "g")
  for (const m of resp.match(re) || []) {
    const c = m.replace(/[。，、；：）\]）}'"]+$/, '')
    if (existsSync(c) && !files.includes(c)) files.push(c)
  }
  return files
}


// ==================== 权限系统全局单例 ====================

const modeManager = new PermissionModeManager(CONFIG.claude.workDir)
const auditLog = new AuditLog(CONFIG.claude.workDir)

/** 发送 QQ 消息的辅助函数（给 confirmBridge 用） */
function sendQQMessage(targetId: string, text: string): void {
  const smartSend = `${PROJECT_ROOT}/tools/send_qq_smart.cjs`
  try {
    spawnSync('node', [smartSend, targetId, 'c2c'], {
      input: text,
      timeout: 15000,
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
    })
  } catch {}
}

const confirmBridge = new UserConfirmBridge(
  async (userId, text) => { sendQQMessage(userId, text) },
  60000,
)

/** 导出 modeManager 和 confirmBridge 供 index.ts 使用 */
export { modeManager, confirmBridge }

// ==================== 类型 ====================

export interface Task {
  id: string
  prompt: string
  sessionKey: string
  userId: string
  msgType: 'c2c' | 'group'
  targetId: string
  status: 'pending' | 'running' | 'done' | 'failed'
  result?: string
  error?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  retried?: boolean
  pushed?: boolean          // 防止重复推送
}

// ==================== 状态 ====================

const QUEUE_FILE = `${PROJECT_ROOT}/task_queue.json`
const SESSION_FILE = `${PROJECT_ROOT}/sessions.json`
const MAX_CONCURRENT = 2
const MAX_PER_USER = 5
const TASK_TIMEOUT = 10 * 60 * 1000

let tasks: Task[] = []
let runningCount = 0

// 会话管理
let sessions: Record<string, { uuid: string; created: string }> = {}
try { if (existsSync(SESSION_FILE)) sessions = JSON.parse(readFileSync(SESSION_FILE, 'utf-8')) } catch {}

function saveQueue() {
  try { writeFileSync(QUEUE_FILE, JSON.stringify(tasks.filter(t =>
    t.status === 'pending' || t.status === 'running' ||
    (t.completedAt && Date.now() - t.completedAt < 3600000)
  ), null, 2)) } catch {}
}

function saveSessions() {
  try { writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2)) } catch {}
}

function getOrCreateSession(key: string): string {
  if (sessions[key]) return sessions[key].uuid
  const uuid = randomUUID()
  sessions[key] = { uuid, created: new Date().toISOString() }
  saveSessions()
  return uuid
}

export function resetSession(key: string) {
  sessions[key] = { uuid: randomUUID(), created: new Date().toISOString() }
  saveSessions()
  // 重置新版记忆系统（会话笔记重置，用户画像保留）
  try {
    const memory = new MemoryManager(key, '', CONFIG.claude.workDir, CONFIG.model.maxTokens || 8192)
    memory.notes.reset()
  } catch {}
}

// 启动时加载队列
try {
  if (existsSync(QUEUE_FILE)) {
    const loaded = JSON.parse(readFileSync(QUEUE_FILE, 'utf-8')) as Task[]
    tasks = loaded.map(t => t.status === 'running' ? { ...t, status: 'pending' as const } : t)
    saveQueue()
  }
} catch {}

// ==================== 队列操作 ====================

export function addTask(opts: {
  prompt: string
  sessionKey: string
  userId: string
  msgType: 'c2c' | 'group'
  targetId: string
}): { taskId: string; position: number } | { error: string } {
  // ** 防重复：同一用户如果已有相同内容的 pending/running 任务，直接跳过 **
  const dupTask = tasks.find(t =>
    t.sessionKey === opts.sessionKey &&
    (t.status === 'pending' || t.status === 'running') &&
    t.prompt === opts.prompt
  )
  if (dupTask) {
    console.log(`[Queue] 跳过重复任务: ${opts.prompt.slice(0, 40)}`)
    const position = tasks.filter(t => t.status === 'pending').length
    return { taskId: dupTask.id, position: Math.max(position, 1) }
  }

  // 检查用户队列是否已满
  const userTasks = tasks.filter(t =>
    t.sessionKey === opts.sessionKey &&
    (t.status === 'pending' || t.status === 'running')
  )
  if (userTasks.length >= MAX_PER_USER) {
    return { error: `你已有 ${userTasks.length} 个任务在排队，请等完成后再发` }
  }

  const task: Task = {
    id: randomUUID().slice(0, 8),
    prompt: opts.prompt,
    sessionKey: opts.sessionKey,
    userId: opts.userId,
    msgType: opts.msgType,
    targetId: opts.targetId,
    status: 'pending',
    createdAt: Date.now(),
  }

  tasks.push(task)
  saveQueue()

  const position = tasks.filter(t => t.status === 'pending').length
  console.log(`[Queue] 任务入队 [${task.id}] 位置${position}: ${opts.prompt.slice(0, 60)}`)

  processNext()

  return { taskId: task.id, position }
}

export function getUserTasks(sessionKey: string): Task[] {
  return tasks.filter(t =>
    t.sessionKey === sessionKey &&
    (t.status === 'pending' || t.status === 'running' ||
     (t.status === 'done' && t.completedAt && Date.now() - t.completedAt < 300000))
  )
}

export function getQueueStatus(): { pending: number; running: number; total: number } {
  return {
    pending: tasks.filter(t => t.status === 'pending').length,
    running: tasks.filter(t => t.status === 'running').length,
    total: tasks.length,
  }
}

export function cancelTask(taskId: string, sessionKey: string): boolean {
  const task = tasks.find(t => t.id === taskId && t.sessionKey === sessionKey)
  if (!task || task.status !== 'pending') return false
  task.status = 'failed'
  task.error = '已取消'
  task.completedAt = Date.now()
  saveQueue()
  return true
}

// ==================== 任务执行 ====================

function processNext() {
  if (runningCount >= MAX_CONCURRENT) return

  const next = tasks.find(t => t.status === 'pending')
  if (!next) return

  runningCount++
  next.status = 'running'
  next.startedAt = Date.now()
  next.pushed = false   // 重置推送标记
  saveQueue()

  console.log(`[Queue] 开始执行 [${next.id}]: ${next.prompt.slice(0, 60)}`)
  writeProgress(next.id, { status: 'running', startedAt: next.startedAt, prompt: next.prompt.slice(0, 60) })

  executeTask(next).then(result => {
    next.status = 'done'
    next.result = result
    next.completedAt = Date.now()
    const elapsed = ((next.completedAt - (next.startedAt || next.createdAt)) / 1000).toFixed(1)
    console.log(`[Queue] 完成 [${next.id}] (${elapsed}s) ${result.length}字`)
    writeProgress(next.id, { status: 'done', startedAt: next.startedAt, prompt: next.prompt.slice(0, 60), result: result.slice(0, 500) })
    cleanProgress(next.id)

    // 推送结果（带防重复）
    safePushResult(next)

    runningCount--
    saveQueue()
    processNext()
  }).catch(err => {
    // 失败且未重试过：重试一次
    if (!next.retried) {
      console.warn(`[Queue] 失败 [${next.id}]，重试: ${err.message?.slice(0, 80)}`)
      next.retried = true
      next.status = 'pending'
      next.pushed = false
      runningCount--
      saveQueue()
      processNext()
      return
    }

    next.status = 'failed'
    next.error = err.message?.slice(0, 200) || '未知错误'
    next.completedAt = Date.now()
    console.error(`[Queue] 最终失败 [${next.id}]: ${next.error}`)
    writeProgress(next.id, { status: 'failed', startedAt: next.startedAt, prompt: next.prompt.slice(0, 60), error: next.error })
    cleanProgress(next.id)

    safePushResult(next)

    runningCount--
    saveQueue()
    processNext()
  })
}

async function executeTask(task: Task): Promise<string> {
  const provider = CONFIG.model.provider

  // 非 claude_code 模式 → 走 Agent Engine
  if (provider !== 'claude_code' && provider !== ('claude_code_proxy' as any)) {
    return executeWithAgentEngine(task)
  }

  // claude_code / claude_code_proxy 模式 → 走现有 spawn claude 逻辑
  return executeWithClaudeCode(task)
}

/** 使用新 Agent Engine 执行任务 */
async function executeWithAgentEngine(task: Task): Promise<string> {
  // 创建新版三层记忆管理器
  const memory = new MemoryManager(
    task.sessionKey,
    task.userId,
    CONFIG.claude.workDir,
    CONFIG.model.maxTokens || 8192,
  )

  // 读取系统提示词（分模型加载）
  let systemPrompt = ''
  try {
    const promptDir = `${PROJECT_ROOT}/workspace/prompts`
    const modelName = CONFIG.model.name.toLowerCase()
    const provider = CONFIG.model.provider

    // 优先级: 模型专用 > 厂商级 > 通用 > 旧版 CLAUDE.md
    const candidates = [
      `${promptDir}/${modelName}.md`,        // 如 deepseek-chat.md
      `${promptDir}/${provider}.md`,         // 如 openai.md / anthropic.md
      `${promptDir}/base.md`,               // 通用基础
      `${PROJECT_ROOT}/workspace/CLAUDE.md`, // 旧版兼容
    ]

    for (const p of candidates) {
      if (existsSync(p)) {
        systemPrompt = readFileSync(p, 'utf-8')
        console.log(`[Queue] 加载 prompt: ${p.replace(PROJECT_ROOT, '.')}`)
        break
      }
    }

    // DeepSeek 特殊处理: 如果用了 openai provider 且模型名包含 deepseek，优先用 deepseek.md
    if (provider === 'openai' && modelName.includes('deepseek') && existsSync(`${promptDir}/deepseek.md`)) {
      systemPrompt = readFileSync(`${promptDir}/deepseek.md`, 'utf-8')
      console.log(`[Queue] 加载 prompt: ./workspace/prompts/deepseek.md (DeepSeek 专用)`)
    }
  } catch {
    // 回退到旧版
    try { systemPrompt = readFileSync(`${PROJECT_ROOT}/workspace/CLAUDE.md`, 'utf-8') } catch {}
  }

  const modelConfig: ModelConfig = {
    provider: CONFIG.model.provider as 'anthropic' | 'openai',
    model: CONFIG.model.name,
    apiKey: CONFIG.model.apiKey,
    baseUrl: CONFIG.model.baseUrl || undefined,
    maxTokens: CONFIG.model.maxTokens,
    temperature: CONFIG.model.temperature,
  }

  console.log(`[Queue] Agent Engine 模式: ${modelConfig.provider}/${modelConfig.model}`)

  // 使用新版记忆系统：记忆上下文注入由 agentEngine 内部的 memory.buildFullContext 完成
  // 构建权限上下文
  const mode = modeManager.getMode(task.sessionKey)
  const permissionContext: PermissionContext = {
    ...DEFAULT_PERMISSION_CONTEXT,
    mode,
    userId: task.userId,
    sessionKey: task.sessionKey,
    workspaceRoot: CONFIG.claude.workDir,
    bypassEnvFlag: process.env.BYPASS_PERMISSIONS === 'true',
  }

  const result = await runAgent(task.prompt, {
    modelConfig,
    systemPrompt,
    maxTurns: 20,
    timeoutMs: TASK_TIMEOUT,
    workDir: CONFIG.claude.workDir,
    toolTimeout: 60000,
    userId: task.userId,
    sessionKey: task.sessionKey,
    memory,            // 传入三层记忆管理器
    permissionContext,  // 传入权限上下文
    confirmBridge,      // 传入二次确认桥
    auditLog,           // 传入审计日志
  })

  // 任务完成后，异步提取用户画像（不阻塞返回）
  const conversationSnippet = `用户: ${task.prompt.slice(0, 200)}\nAI: ${(result.content || '').slice(0, 300)}`
  memory.profiles.extractAndMerge(
    task.userId,
    conversationSnippet,
    async (p) => {
      const { OpenAIAdapter } = await import('./adapters/openai.js')
      const adapter = new OpenAIAdapter(modelConfig)
      const r = await adapter.chat([{ role: 'user', content: p }], [], {})
      return r.content
    },
  ).catch(() => {})  // 静默失败

  console.log(`[Queue] Agent 完成: ${result.turnCount} 轮, ${result.toolCallCount} 次工具调用`)
  return result.content || '（执行完毕）'
}

/** 使用现有 Claude Code CLI 执行任务（原有逻辑） */
async function executeWithClaudeCode(task: Task): Promise<string> {
  const uuid = getOrCreateSession(task.sessionKey)

  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn: Function, v: any) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(v)
    }

    // 读取会话笔记
    let enrichedPrompt = task.prompt
    try {
      const { spawnSync: spNotes } = require('child_process')
      const nr = spNotes('node', [`${PROJECT_ROOT}/tools/session_notes.cjs`, 'read', task.sessionKey], {
        encoding: 'utf-8', timeout: 5000,
      })
      const sessionNotes = (nr.stdout || '').trim()
      if (sessionNotes) {
        enrichedPrompt = `<session_context>\n以下是之前对话的记录，帮助你了解上下文：\n\n${sessionNotes}\n</session_context>\n\n用户当前消息: ${task.prompt}`
      }
    } catch {}

    const args = ['-p', enrichedPrompt, '--dangerously-skip-permissions']
    const sessionAge = sessions[task.sessionKey] ? Date.now() - new Date(sessions[task.sessionKey].created).getTime() : 0
    const hasExistingSession = sessionAge > 10000
    if (hasExistingSession) {
      args.push('--resume', uuid)
    } else {
      args.push('--session-id', uuid)
    }

    const devnull = openSync('/dev/null', 'r')
    const proc = spawn('claude', args, {
      cwd: CONFIG.claude.workDir,
      env: { ...process.env },
      stdio: [devnull, 'pipe', 'pipe'],
    })

    let stdout = '', stderr = ''
    proc.stdout.on('data', (d: Buffer) => stdout += d)
    proc.stderr.on('data', (d: Buffer) => stderr += d)

    proc.on('close', (code: number | null) => {
      try { closeSync(devnull) } catch {}
      if (code === 0) {
        settle(resolve, stdout.trim() || '（执行完毕）')
      } else if (hasExistingSession) {
        console.log(`[Queue] resume失败 [${task.id}]，新会话重试`)
        resetSession(task.sessionKey)
        const newUuid = getOrCreateSession(task.sessionKey)
        const retry = spawn('claude', ['-p', task.prompt, '--dangerously-skip-permissions', '--session-id', newUuid],
          { cwd: CONFIG.claude.workDir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
        let ro = '', re = ''
        retry.stdout.on('data', (d: Buffer) => ro += d)
        retry.stderr.on('data', (d: Buffer) => re += d)
        retry.on('close', (rc: number | null) => {
          if (rc === 0) settle(resolve, ro.trim() || '（执行完毕）')
          else settle(reject, new Error(re.slice(0, 500) || `退出码${rc}`))
        })
        retry.on('error', (e: Error) => settle(reject, e))
      } else {
        settle(reject, new Error(stderr.slice(0, 500) || `退出码${code}`))
      }
    })

    proc.on('error', (err: Error) => settle(reject, err))

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 5000)
      settle(reject, new Error('执行超时（10分钟）'))
    }, TASK_TIMEOUT)
  })
}

// ==================== 推送结果（防重复） ====================

function safePushResult(task: Task) {
  if (task.pushed) {
    console.log(`[Queue] 跳过重复推送 [${task.id}]`)
    return
  }
  task.pushed = true
  pushResult(task)
}

function pushResult(task: Task) {
  const { spawnSync } = require('child_process')
  const smartSend = `${PROJECT_ROOT}/tools/send_qq_smart.cjs`

  let content: string
  if (task.status === 'done' && task.result) {
    content = `✅ 任务完成\n\n${task.result}`
  } else {
    const rawErr = task.error || '未知错误'
    let friendlyErr = '处理你的请求时出了点问题'
    if (rawErr.includes('超时')) friendlyErr = '这个任务太耗时了（超过10分钟），可以试试拆成更小的问题'
    else if (rawErr.includes('退出码')) friendlyErr = 'AI 助手处理时遇到了内部错误，请重试一次'
    else if (rawErr.includes('已取消')) friendlyErr = '任务已取消'
    else friendlyErr = '处理失败，请重新发送试试'
    content = `❌ ${friendlyErr}`
  }

  // Markdown → 纯文本
  try {
    const { spawnSync: sp } = require('child_process')
    const r = sp('node', [`${PROJECT_ROOT}/tools/strip_markdown.cjs`], {
      input: content, encoding: 'utf-8', timeout: 5000,
    })
    if (r.status === 0 && r.stdout.trim()) content = r.stdout.trim()
  } catch {}

  if (task.targetId) {
    try {
      const r = spawnSync('node', [smartSend, task.targetId, task.msgType], {
        input: content,
        timeout: 30000,
        encoding: 'utf-8',
        cwd: PROJECT_ROOT,
      })
      if (r.status === 0) {
        console.log(`[Queue] 已推送结果给 ${task.targetId.slice(0, 8)}... (${r.stdout.trim()})`)
      } else {
        console.error(`[Queue] 推送失败: ${r.stderr || r.stdout}`)
      }
    } catch (e: any) {
      console.error(`[Queue] 推送异常: ${e.message}`)
    }
  }

  // 检测文件并发送
  if (task.status === 'done' && task.result && task.targetId) {
    const outputFiles = detectOutputFiles(task.result)
    if (outputFiles.length > 0) {
      const { spawnSync: spFile } = require('child_process')
      const sendFileTool = `${PROJECT_ROOT}/tools/send_qq_file.cjs`
      for (const fp of outputFiles) {
        try {
          console.log(`[Queue] 发送文件: ${fp}`)
          const fr = spFile('node', [sendFileTool, task.targetId, fp, task.msgType], {
            timeout: 30000, encoding: 'utf-8', cwd: PROJECT_ROOT,
          })
          if (fr.status === 0) {
            console.log(`[Queue] 文件发送成功: ${fp}`)
          } else {
            console.error(`[Queue] 文件发送失败: ${fr.stderr || fr.stdout}`)
          }
        } catch (e: any) {
          console.error(`[Queue] 文件发送异常: ${e.message}`)
        }
      }
    }
  }
}

// 定时清理
setInterval(() => {
  const before = tasks.length
  tasks = tasks.filter(t =>
    t.status === 'pending' || t.status === 'running' ||
    (t.completedAt && Date.now() - t.completedAt < 3600000)
  )
  if (tasks.length < before) {
    console.log(`[Queue] 清理 ${before - tasks.length} 个旧任务`)
    saveQueue()
  }
}, 600000)

setInterval(() => {
  try {
    const { execSync } = require('child_process')
    execSync('node ${PROJECT_ROOT}/tools/cleanup_session_notes.cjs', { encoding: 'utf-8', timeout: 10000 })
  } catch {}
}, 86400000)
