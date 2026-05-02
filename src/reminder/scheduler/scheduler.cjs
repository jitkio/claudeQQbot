/**
 * 调度核心
 * 职责：根据任务配置，决定"什么时候该触发下一次提醒"
 *      把 BullMQ 的 job 生命周期和 tasks 表状态关联起来
 */
const tasksRepo = require('../db/tasksRepo.cjs')
const queue = require('./queue.cjs')
const { avoidQuietHour } = require('../utils/time.cjs')
const { createLogger } = require('../utils/logger.cjs')

const log = createLogger('scheduler')

// ---- 根据任务类型，计算下一次 remind_at ----
function calcNextRemind(task) {
  const now = Date.now()
  const rule = task.remind_rule || {}

  switch (task.type) {
    case 'once':
      // 一次性：就按 remind_at 触发，触发完就不再调度
      return task.remind_at && task.remind_at > now ? task.remind_at : null

    case 'daily': {
      // 每日：每天 hh:mm 触发
      const hour = rule.hour ?? 8
      const minute = rule.minute ?? 0
      const d = new Date(now)
      d.setHours(hour, minute, 0, 0)
      if (d.getTime() <= now) d.setDate(d.getDate() + 1)
      return d.getTime()
    }

    case 'deadline': {
      // 截止日期：接近截止越频繁
      if (!task.due_at) return null
      const remaining = task.due_at - now
      if (remaining <= 0) return null

      const totalSpan = task.due_at - task.created_at
      const remainingDays = remaining / 86400000

      let nextDelayMs
      if (remainingDays < 0.5) nextDelayMs = 2 * 3600000   // <12h: 每 2h
      else if (remainingDays < 1) nextDelayMs = 4 * 3600000  // <24h: 每 4h
      else if (remainingDays < 3) nextDelayMs = 12 * 3600000 // <3天: 每 12h
      else if (remainingDays < 7) nextDelayMs = 24 * 3600000 // <1周: 每天
      else nextDelayMs = Math.max(2 * 86400000, Math.floor(totalSpan / 6))  // 否则 总期/6

      let next = now + nextDelayMs
      // 不能超过截止
      if (next > task.due_at) next = task.due_at - 1800000  // 截止前半小时最后一次
      if (next < now) next = now + 60000
      return avoidQuietHour(next)
    }

    case 'periodic': {
      // 周期性（每周N次）: 简化处理，遵循 remind_rule.hour
      const hour = rule.hour ?? 8
      const minute = rule.minute ?? 0
      const d = new Date(now)
      d.setHours(hour, minute, 0, 0)
      if (d.getTime() <= now) d.setDate(d.getDate() + 1)
      return d.getTime()
    }

    case 'todo':
      // TODO 任务不主动提醒
      return null

    default:
      return null
  }
}

// ---- 安排一个任务的下一次提醒（核心函数）----
async function schedule(taskId) {
  const task = tasksRepo.get(taskId)
  if (!task) {
    log.warn('schedule: task not found', { taskId })
    return null
  }
  if (task.status !== 'active') {
    log.debug('schedule: task inactive, skipping', { taskId, status: task.status })
    return null
  }

  // 先清除该任务的所有旧 job
  await queue.removeJobsOfTask(taskId)

  const nextAt = calcNextRemind(task)
  if (!nextAt) {
    log.debug('schedule: no next remind', { taskId, type: task.type })
    // 清空 remind_at
    tasksRepo.update(taskId, { remind_at: null })
    return null
  }

  const adjusted = avoidQuietHour(nextAt)
  tasksRepo.update(taskId, { remind_at: adjusted })

  const jobId = await queue.scheduleJob(
    queue.JOB_TYPES.REMIND,
    { taskId, ownerOpenId: task.owner_open_id },
    adjusted,
  )

  log.info('scheduled', {
    taskId,
    type: task.type,
    fireAt: new Date(adjusted).toISOString(),
    jobId,
  })
  return { jobId, fireAt: adjusted }
}

// ---- 取消任务的所有调度（任务完成/取消时用）----
async function unschedule(taskId) {
  const removed = await queue.removeJobsOfTask(taskId)
  log.info('unscheduled', { taskId, removed })
  return removed
}

// ---- 推迟（snooze）----
async function snooze(taskId, delayMs) {
  const task = tasksRepo.get(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)

  const newRemindAt = avoidQuietHour(Date.now() + delayMs)
  tasksRepo.update(taskId, {
    remind_at: newRemindAt,
    snooze_count: (task.snooze_count || 0) + 1,
    last_snoozed_at: Date.now(),
  })

  await queue.removeJobsOfTask(taskId)
  const jobId = await queue.scheduleJob(
    queue.JOB_TYPES.REMIND,
    { taskId, ownerOpenId: task.owner_open_id },
    newRemindAt,
  )

  log.info('snoozed', { taskId, newRemindAt: new Date(newRemindAt).toISOString() })
  return { jobId, fireAt: newRemindAt }
}

module.exports = {
  calcNextRemind,
  schedule,
  unschedule,
  snooze,
}
