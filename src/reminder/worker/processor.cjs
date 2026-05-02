/**
 * Job 处理器
 * 每种 job 类型对应一个处理函数
 */
const tasksRepo = require('../db/tasksRepo.cjs')
const logsRepo = require('../db/remindersLogRepo.cjs')
const taskSvc = require('../api/taskService.cjs')
const scheduler = require('../scheduler/scheduler.cjs')
const { sendToQQ } = require('./sendMessage.cjs')
const { formatCN } = require('../utils/time.cjs')
const { createLogger } = require('../utils/logger.cjs')

const log = createLogger('worker')

// ---- REMIND: 触发一次提醒 ----
async function handleRemind(job) {
  const { taskId, ownerOpenId, recovered } = job.data
  const task = tasksRepo.get(taskId)

  if (!task) {
    log.warn('REMIND: task not found, skip', { taskId })
    return { status: 'skipped', reason: 'task_deleted' }
  }
  if (task.status !== 'active') {
    log.info('REMIND: task no longer active, skip', { taskId, status: task.status })
    return { status: 'skipped', reason: task.status }
  }

  // 生成简单提醒文本（LLM 润色留到第 5 步）
  const content = buildReminderText(task, recovered)

  const result = await sendToQQ(ownerOpenId, content, { taskId, source: 'remind' })

  logsRepo.log({
    taskId,
    channel: 'qq_c2c',
    message: content,
    status: result.status === 'sent' ? 'sent' : (result.status === 'dry' ? 'skipped' : 'failed'),
    error: result.error || null,
  })

  // 处理完这次
  if (task.type === 'once') {
    // 一次性触发完，不再调度
    tasksRepo.update(taskId, { remind_at: null })
  } else if (task.type === 'daily' || task.type === 'periodic' || task.type === 'deadline') {
    // 重复型：排下一次
    try {
      await scheduler.schedule(taskId)
    } catch (e) {
      log.error('reschedule after remind failed', { taskId, err: e.message })
    }
  }

  return { status: result.status, taskId }
}

// ---- MORNING: 晨报（第 6 步接入 LLM）----
async function handleMorningReport(job) {
  const { ownerOpenId } = job.data
  log.info('MORNING: triggered (占位，step6 实现)', { ownerOpenId })
  // 暂时只打日志。等第 6 步接入 LLM 后，这里生成 7 种视图之一
  return { status: 'pending_impl' }
}

// ---- NAG: 晚间念叨 ----
async function handleEveningNag(job) {
  const { ownerOpenId } = job.data
  log.info('NAG: triggered (占位，step6 实现)', { ownerOpenId })
  return { status: 'pending_impl' }
}

// ---- SHELVE: 搁置检查（每天跑一次）----
async function handleShelveCheck(job) {
  const { ownerOpenId } = job.data
  const shelved = await taskSvc.runShelveCheck(ownerOpenId)
  log.info('SHELVE check done', { ownerOpenId, shelved })
  return { status: 'ok', shelved }
}

// ---- 生成提醒文本 ----
function buildReminderText(task, recovered) {
  const parts = []
  if (recovered) parts.push('⏰ (错过的提醒)')
  else parts.push('⏰ 提醒')

  parts.push(` ${task.title}`)

  if (task.due_at) {
    const now = Date.now()
    const diff = now - task.due_at
    if (diff > 5 * 60000) {
      // 真正逾期（超过 5 分钟）
      const hours = Math.floor(diff / 3600000)
      const mins = Math.floor((diff % 3600000) / 60000)
      parts.push(`\n⚠️ 已逾期 ${hours > 0 ? hours + 'h' : ''}${mins}m`)
    } else if (diff > -60000) {
      // 截止前后 1 分钟内，不显示冗余
    } else {
      // 截止还没到
      const hrs = Math.ceil(-diff / 3600000)
      if (hrs < 24) parts.push(`\n截止还剩 ${hrs} 小时`)
      else parts.push(`\n截止：${formatCN(task.due_at)}`)
    }
  }

  if (task.description) parts.push(`\n${task.description}`)

  parts.push(`\n\n任务 ID: ${task.id}`)
  parts.push('\n回复 /done ' + task.id + ' 完成')
  parts.push(' 或 /snooze 30m ' + task.id + ' 推迟')

  return parts.join('')
}

// 路由到对应的处理函数
async function processJob(job) {
  const started = Date.now()
  log.debug('processing job', { id: job.id, name: job.name })

  try {
    let result
    switch (job.name) {
      case 'remind':
        result = await handleRemind(job)
        break
      case 'morning':
        result = await handleMorningReport(job)
        break
      case 'nag':
        result = await handleEveningNag(job)
        break
      case 'shelve':
        result = await handleShelveCheck(job)
        break
      default:
        throw new Error(`unknown job type: ${job.name}`)
    }
    const ms = Date.now() - started
    log.debug('processed', { id: job.id, name: job.name, ms, result })
    return result
  } catch (e) {
    const ms = Date.now() - started
    log.error('job failed', { id: job.id, name: job.name, ms, err: e.message })
    throw e
  }
}

module.exports = { processJob, buildReminderText }
