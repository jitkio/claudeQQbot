/**
 * BullMQ 队列封装
 * 所有 job 操作都通过这里，避免散布 BullMQ 依赖
 */
const { Queue, QueueEvents } = require('bullmq')
const config = require('../config.cjs')
const { createLogger } = require('../utils/logger.cjs')

const log = createLogger('queue')

// --- 队列常量 ---
const QUEUE_NAME = 'reminders'
const JOB_TYPES = {
  REMIND: 'remind',           // 触发一次提醒
  MORNING_REPORT: 'morning',  // 生成晨报
  EVENING_NAG: 'nag',         // 晚间念叨
  SHELVE_CHECK: 'shelve',     // 检查搁置
}

let _queue = null
let _events = null

function getQueue() {
  if (_queue) return _queue
  _queue = new Queue(QUEUE_NAME, {
    connection: config.REDIS,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },  // 5s, 25s, 125s
      removeOnComplete: { age: 7 * 86400, count: 1000 },
      removeOnFail:     { age: 30 * 86400, count: 5000 },
    },
  })
  log.info('queue created', { name: QUEUE_NAME })
  return _queue
}

function getQueueEvents() {
  if (_events) return _events
  _events = new QueueEvents(QUEUE_NAME, { connection: config.REDIS })
  return _events
}

// 加一个"延迟到某时刻触发"的 job
async function scheduleJob(jobType, data, fireAt, customOpts = {}) {
  const delay = Math.max(0, fireAt - Date.now())
  const jobId = data.taskId ? `${jobType}:${data.taskId}:${fireAt}` : undefined

  const job = await getQueue().add(jobType, data, {
    delay,
    jobId,  // 相同 jobId 会被去重，避免同任务同时刻被加多次
    ...customOpts,
  })
  log.debug('job scheduled', { jobType, fireAt: new Date(fireAt).toISOString(), jobId, delay })
  return job.id
}

// 取消 job（任务完成/取消时用）
async function removeJob(jobId) {
  try {
    const job = await getQueue().getJob(jobId)
    if (job) {
      await job.remove()
      log.debug('job removed', { jobId })
      return true
    }
    return false
  } catch (e) {
    log.warn('removeJob failed', { jobId, err: e.message })
    return false
  }
}

// 取消某任务的所有相关 job
async function removeJobsOfTask(taskId) {
  const q = getQueue()
  // 删除 delayed 队列里匹配的
  const delayed = await q.getJobs(['delayed', 'waiting'], 0, 10000)
  let removed = 0
  for (const j of delayed) {
    if (j.data && j.data.taskId === taskId) {
      try { await j.remove(); removed++ } catch {}
    }
  }
  if (removed > 0) log.debug('removed jobs of task', { taskId, count: removed })
  return removed
}

async function getQueueStats() {
  const q = getQueue()
  const counts = await q.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed')
  return counts
}

async function close() {
  if (_events) await _events.close()
  if (_queue) await _queue.close()
  _events = null
  _queue = null
  log.info('queue closed')
}

module.exports = {
  QUEUE_NAME,
  JOB_TYPES,
  getQueue,
  getQueueEvents,
  scheduleJob,
  removeJob,
  removeJobsOfTask,
  getQueueStats,
  close,
}
