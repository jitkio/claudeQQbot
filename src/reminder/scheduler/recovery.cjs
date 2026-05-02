/**
 * 启动补跑
 * Worker 重启时扫一遍所有活跃任务，找出"应该已经触发但没触发"的，补发
 * 这是 BullMQ 也要靠它 —— Redis 崩过之后，delayed jobs 可能丢
 */
const tasksRepo = require('../db/tasksRepo.cjs')
const scheduler = require('./scheduler.cjs')
const queue = require('./queue.cjs')
const { createLogger } = require('../utils/logger.cjs')

const log = createLogger('recovery')

// 启动时扫描所有活跃任务，检查 remind_at 和队列是否一致
async function scanAndRecover() {
  log.info('recovery scan started')

  const db = require('../db/database.cjs').getDB()
  const rows = db.prepare(`
    SELECT id, owner_open_id, type, remind_at, due_at, status
    FROM tasks
    WHERE status = 'active'
  `).all()

  const now = Date.now()
  let recovered = 0, rescheduled = 0, missed = 0

  for (const row of rows) {
    try {
      // 情况 1: remind_at 在过去 → 错过了，立刻触发
      if (row.remind_at && row.remind_at < now) {
        const gap = Math.floor((now - row.remind_at) / 60000)
        log.warn('missed reminder, firing now', { taskId: row.id, gapMinutes: gap })

        // 丢一个立即触发的 job
        await queue.scheduleJob(
          queue.JOB_TYPES.REMIND,
          { taskId: row.id, ownerOpenId: row.owner_open_id, recovered: true },
          now + 1000,  // 1 秒后触发，避免过度堆积
        )
        missed++

        // 并重新排下一次
        await scheduler.schedule(row.id)
        recovered++
      }
      // 情况 2: remind_at 在未来，但可能队列里没 job（Redis 崩过）
      // → 简单策略：所有活跃任务都重新 schedule 一次（会自动去重）
      else if (row.remind_at && row.remind_at > now) {
        await scheduler.schedule(row.id)
        rescheduled++
      }
      // 情况 3: remind_at 为空但任务活跃，计算一次
      else if (!row.remind_at) {
        await scheduler.schedule(row.id)
        rescheduled++
      }
    } catch (e) {
      log.error('recovery item failed', { taskId: row.id, err: e.message })
    }
  }

  // 逾期检查: deadline 类型任务 due_at 已过
  const overdueRows = db.prepare(`
    SELECT id FROM tasks
    WHERE status = 'active' AND type = 'deadline'
      AND due_at IS NOT NULL AND due_at < ?
  `).all(now)
  let overdue = 0
  for (const r of overdueRows) {
    tasksRepo.update(r.id, { status: 'overdue' })
    await queue.removeJobsOfTask(r.id)
    overdue++
  }

  log.info('recovery scan done', {
    total: rows.length,
    missed,          // 错过的已立即补发
    rescheduled,     // 重新排进队列的
    overdue,         // 逾期标记的
    recovered,
  })

  return { total: rows.length, missed, rescheduled, overdue }
}

module.exports = { scanAndRecover }
