/**
 * 任务业务层 (Service)
 * 上层（HTTP、bot 工具、Worker）都通过这个模块
 * 职责：组合 Repo + Scheduler，封装业务规则
 */
const tasksRepo = require('../db/tasksRepo.cjs')
const checkinsRepo = require('../db/checkinsRepo.cjs')
const scheduler = require('../scheduler/scheduler.cjs')
const progressCalc = require('./progressCalc.cjs')
const { createLogger } = require('../utils/logger.cjs')
const { formatCN } = require('../utils/time.cjs')

const log = createLogger('taskSvc')

// ---- 创建任务（会自动排调度）----
async function create(taskData) {
  const task = tasksRepo.createTask(taskData)
  try {
    await scheduler.schedule(task.id)
  } catch (e) {
    log.error('schedule after create failed', { taskId: task.id, err: e.message })
  }
  log.info('created', { taskId: task.id, type: task.type, title: task.title })
  return task
}

// ---- 更新任务（修改字段后重新调度）----
async function update(taskId, fields) {
  const task = tasksRepo.update(taskId, fields)
  // 如果修改了时间相关字段，重排调度
  const shouldReschedule = ['due_at', 'remind_at', 'remind_rule', 'type', 'status']
    .some(k => k in fields)
  if (shouldReschedule) {
    try { await scheduler.schedule(taskId) }
    catch (e) { log.error('reschedule failed', { taskId, err: e.message }) }
  }
  log.info('updated', { taskId, fields: Object.keys(fields) })
  return task
}

// ---- 完成 ----
async function complete(taskId, { note = null } = {}) {
  const task = tasksRepo.get(taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)

  // 对持续任务：完成是打卡，不是终结
  if (task.type === 'daily' || task.type === 'periodic') {
    checkinsRepo.create(taskId, { note, source: 'user' })
    tasksRepo.update(taskId, {
      progress_count: (task.progress_count || 0) + 1,
      consecutive_miss: 0,
      last_touched_at: Date.now(),
    })
    // 如果搁置了，重新激活
    if (task.status === 'shelved') {
      tasksRepo.reactivate(taskId)
      await scheduler.schedule(taskId)
    }
    log.info('checkin', { taskId, progress: (task.progress_count || 0) + 1 })
    return tasksRepo.get(taskId)
  }

  // 一次性：标记完成，取消调度
  tasksRepo.markDone(taskId)
  await scheduler.unschedule(taskId)
  log.info('completed', { taskId })
  return tasksRepo.get(taskId)
}

// ---- 取消 ----
async function cancel(taskId) {
  tasksRepo.markCancelled(taskId)
  await scheduler.unschedule(taskId)
  log.info('cancelled', { taskId })
  return tasksRepo.get(taskId)
}

// ---- 推迟 ----
async function snooze(taskId, delayMs) {
  const result = await scheduler.snooze(taskId, delayMs)
  tasksRepo.touch(taskId)
  return { task: tasksRepo.get(taskId), ...result }
}

// ---- 查询（带进度计算）----
function getWithProgress(taskId) {
  const task = tasksRepo.get(taskId)
  if (!task) return null
  return enrichTask(task)
}

function listActive(ownerOpenId) {
  return tasksRepo.listActive(ownerOpenId).map(enrichTask)
}

function listAll(ownerOpenId, opts = {}) {
  return tasksRepo.listAll(ownerOpenId, opts).map(enrichTask)
}

function listByStatus(ownerOpenId, status) {
  return tasksRepo.listByStatus(ownerOpenId, status).map(enrichTask)
}

// 给任务附加进度信息
function enrichTask(task) {
  const enriched = { ...task }
  if (task.type === 'daily' || task.type === 'periodic') {
    const target = task.target_count || 7
    const period = task.target_period || 'week'
    const progress = progressCalc.calcProgressForPeriodic(task)
    enriched.progressBar = progressCalc.progressBar(progress, target)
    enriched.checkinStreak = progressCalc.checkinStreak(task.id, 7)
    enriched.progressCount = progress
    enriched.targetCount = target
    enriched.targetPeriod = period
    enriched.daysSinceLastCheckin = progressCalc.daysSinceLastCheckin(task.id)
  }
  if (task.due_at) enriched.dueAtDisplay = formatCN(task.due_at)
  if (task.remind_at) enriched.remindAtDisplay = formatCN(task.remind_at)
  return enriched
}

// ---- 统计 ----
function stats(ownerOpenId) {
  return tasksRepo.counts(ownerOpenId)
}

// ---- 搁置扫描（每天跑一次）----
async function runShelveCheck(ownerOpenId, shelveAfterDays = 7) {
  const active = tasksRepo.listActive(ownerOpenId)
  let shelved = 0
  for (const t of active) {
    if (progressCalc.shouldShelve(t, shelveAfterDays)) {
      tasksRepo.markShelved(t.id)
      await scheduler.unschedule(t.id)
      shelved++
      log.info('shelved', { taskId: t.id, title: t.title })
    }
  }
  return shelved
}

module.exports = {
  create,
  update,
  complete,
  cancel,
  snooze,
  getWithProgress,
  listActive,
  listAll,
  listByStatus,
  stats,
  runShelveCheck,
  enrichTask,
}
