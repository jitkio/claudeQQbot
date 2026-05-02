/**
 * Reminder Worker 主入口
 * 这个脚本被 pm2 作为独立进程启动
 *
 * 职责：
 * 1. 启动 BullMQ Worker 监听队列
 * 2. 启动时跑 recovery 扫描
 * 3. 定时任务（每天 8:00 搁置扫描）
 * 4. 优雅退出
 */
const { Worker } = require('bullmq')
const nodeSchedule = require('node-schedule')
const config = require('../config.cjs')
const queue = require('../scheduler/queue.cjs')
const recovery = require('../scheduler/recovery.cjs')
const { processJob } = require('./processor.cjs')
const { createLogger } = require('../utils/logger.cjs')
const { closeDB } = require('../db/database.cjs')

const log = createLogger('worker_main')

let worker = null
let recurringJobs = []

async function start() {
  log.info('================ Worker starting ================')
  log.info('config', {
    redis: `${config.REDIS.host}:${config.REDIS.port}`,
    httpTarget: `${config.HTTP.host}:${config.HTTP.port}`,
    owner: config.OWNER_OPEN_ID ? config.OWNER_OPEN_ID.slice(0, 8) + '...' : '(未设置)',
  })

  // 1. 启动补跑扫描
  try {
    const result = await recovery.scanAndRecover()
    log.info('recovery done', result)
  } catch (e) {
    log.error('recovery failed (continuing)', { err: e.message })
  }

  // 2. 启动 BullMQ Worker
  worker = new Worker(queue.QUEUE_NAME, processJob, {
    connection: config.REDIS,
    concurrency: 4,           // 同时处理 4 个 job
    lockDuration: 60000,      // 锁持续 60 秒
  })

  worker.on('ready', () => log.info('worker ready, listening for jobs'))
  worker.on('completed', (job, result) => {
    log.debug('job completed', { id: job.id, name: job.name, result })
  })
  worker.on('failed', (job, err) => {
    log.warn('job failed', { id: job?.id, name: job?.name, err: err?.message })
  })
  worker.on('error', (err) => {
    log.error('worker error', { err: err?.message })
  })

  // 3. 定时任务（在进程内，不依赖 BullMQ）
  scheduleRecurringTasks()

  log.info('================ Worker started ================')
}

function scheduleRecurringTasks() {
  // 每天 03:00 做一次 recovery 扫描（容错）
  const j1 = nodeSchedule.scheduleJob('0 3 * * *', async () => {
    log.info('periodic recovery scan')
    try { await recovery.scanAndRecover() }
    catch (e) { log.error('periodic recovery failed', { err: e.message }) }
  })
  recurringJobs.push(j1)

  // 每天 08:00 做搁置扫描（针对每个 owner；当前只有一个，从 config 读）
  if (config.OWNER_OPEN_ID) {
    const j2 = nodeSchedule.scheduleJob('0 8 * * *', async () => {
      log.info('periodic shelve check')
      try {
        await queue.scheduleJob('shelve', { ownerOpenId: config.OWNER_OPEN_ID }, Date.now() + 1000)
      } catch (e) { log.error('shelve schedule failed', { err: e.message }) }
    })
    recurringJobs.push(j2)

    // 每天 07:00 晨报（step6 实现逻辑，这里先入队占位）
    const j3 = nodeSchedule.scheduleJob(
      `${config.MORNING_REPORT_MINUTE} ${config.MORNING_REPORT_HOUR} * * *`,
      async () => {
        log.info('triggering morning report')
        try {
          await queue.scheduleJob('morning', { ownerOpenId: config.OWNER_OPEN_ID }, Date.now() + 1000)
        } catch (e) { log.error('morning schedule failed', { err: e.message }) }
      }
    )
    recurringJobs.push(j3)

    // 每天 20:00 晚间念叨（针对未打卡的持续任务）
    const j4 = nodeSchedule.scheduleJob(
      `0 ${config.EVENING_NAG_HOUR} * * *`,
      async () => {
        log.info('triggering evening nag')
        try {
          await queue.scheduleJob('nag', { ownerOpenId: config.OWNER_OPEN_ID }, Date.now() + 1000)
        } catch (e) { log.error('nag schedule failed', { err: e.message }) }
      }
    )
    recurringJobs.push(j4)
  }

  log.info('recurring tasks scheduled', { count: recurringJobs.length })
}

async function shutdown(signal) {
  log.info(`Worker shutting down (signal=${signal})`)
  for (const j of recurringJobs) { try { j.cancel() } catch {} }
  if (worker) { try { await worker.close() } catch {} }
  try { await queue.close() } catch {}
  closeDB()
  log.info('Worker stopped')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

process.on('unhandledRejection', (err) => {
  log.error('unhandledRejection', { err: err?.message, stack: err?.stack })
})
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { err: err?.message, stack: err?.stack })
})

// 启动
start().catch(err => {
  log.error('start failed', { err: err?.message, stack: err?.stack })
  process.exit(1)
})
