/**
 * 任务表 CRUD
 */
const { getDB } = require('./database.cjs')
const { genTaskId } = require('../utils/id.cjs')

// ----------- 内部工具 -----------
function rowToTask(row) {
  if (!row) return null
  return {
    ...row,
    // meta 是 JSON 字符串，反序列化
    meta: row.meta ? JSON.parse(row.meta) : null,
    remind_rule: row.remind_rule ? JSON.parse(row.remind_rule) : null,
  }
}

// ----------- 创建 -----------
function createTask({
  ownerOpenId, title, description = null, type,
  category = null, priority = 'normal',
  dueAt = null, remindAt = null, remindRule = null,
  targetCount = null, targetPeriod = null,
  meta = null,
}) {
  const db = getDB()
  const id = genTaskId()
  const now = Date.now()

  db.prepare(`
    INSERT INTO tasks (
      id, owner_open_id, title, description, type,
      category, priority, created_at, updated_at, last_touched_at,
      due_at, remind_at, remind_rule,
      status, target_count, target_period,
      progress_count, consecutive_miss, snooze_count, meta
    ) VALUES (
      @id, @ownerOpenId, @title, @description, @type,
      @category, @priority, @now, @now, @now,
      @dueAt, @remindAt, @remindRuleJson,
      'active', @targetCount, @targetPeriod,
      0, 0, 0, @metaJson
    )
  `).run({
    id, ownerOpenId, title, description, type,
    category, priority, now,
    dueAt, remindAt,
    remindRuleJson: remindRule ? JSON.stringify(remindRule) : null,
    targetCount, targetPeriod,
    metaJson: meta ? JSON.stringify(meta) : null,
  })

  return get(id)
}

// ----------- 读取 -----------
function get(id) {
  const db = getDB()
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  return rowToTask(row)
}

function listActive(ownerOpenId, limit = 100) {
  const db = getDB()
  const rows = db.prepare(`
    SELECT * FROM tasks
    WHERE owner_open_id = ? AND status = 'active'
    ORDER BY
      CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
      COALESCE(due_at, remind_at, 9999999999999) ASC
    LIMIT ?
  `).all(ownerOpenId, limit)
  return rows.map(rowToTask)
}

function listByStatus(ownerOpenId, status, limit = 100) {
  const db = getDB()
  const rows = db.prepare(`
    SELECT * FROM tasks
    WHERE owner_open_id = ? AND status = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(ownerOpenId, status, limit)
  return rows.map(rowToTask)
}

function listAll(ownerOpenId, { startTs = null, endTs = null, limit = 500 } = {}) {
  const db = getDB()
  let sql = 'SELECT * FROM tasks WHERE owner_open_id = ?'
  const params = [ownerOpenId]
  if (startTs) { sql += ' AND created_at >= ?'; params.push(startTs) }
  if (endTs)   { sql += ' AND created_at <= ?'; params.push(endTs) }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limit)
  return db.prepare(sql).all(...params).map(rowToTask)
}

// 找到"下一个要触发提醒"的任务（调度器用）
function findDueReminders(beforeTs = Date.now()) {
  const db = getDB()
  const rows = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'active'
      AND remind_at IS NOT NULL
      AND remind_at <= ?
  `).all(beforeTs)
  return rows.map(rowToTask)
}

// ----------- 更新 -----------
function update(id, fields) {
  const db = getDB()
  const existing = get(id)
  if (!existing) throw new Error(`Task not found: ${id}`)

  const allowed = [
    'title', 'description', 'category', 'priority',
    'due_at', 'remind_at', 'remind_rule',
    'status', 'completed_at', 'shelved_at',
    'target_count', 'target_period',
    'progress_count', 'consecutive_miss',
    'snooze_count', 'last_snoozed_at',
    'meta',
  ]
  const sets = []
  const vals = {}
  for (const [k, v] of Object.entries(fields)) {
    // 驼峰转下划线
    const col = k.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
    if (!allowed.includes(col)) continue
    if (col === 'remind_rule' || col === 'meta') {
      sets.push(`${col} = @${col}`)
      vals[col] = v == null ? null : JSON.stringify(v)
    } else {
      sets.push(`${col} = @${col}`)
      vals[col] = v
    }
  }
  if (sets.length === 0) return existing

  sets.push('updated_at = @updated_at')
  vals.updated_at = Date.now()
  vals.id = id

  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(vals)
  return get(id)
}

function touch(id) {
  const db = getDB()
  db.prepare('UPDATE tasks SET last_touched_at = ? WHERE id = ?')
    .run(Date.now(), id)
}

// 标记完成
function markDone(id) {
  const now = Date.now()
  return update(id, { status: 'done', completed_at: now })
}

// 标记取消
function markCancelled(id) {
  return update(id, { status: 'cancelled' })
}

// 标记搁置（7 天没打卡自动触发）
function markShelved(id) {
  return update(id, { status: 'shelved', shelved_at: Date.now() })
}

// 重新激活
function reactivate(id) {
  return update(id, { status: 'active', shelved_at: null })
}

// ----------- 删除 -----------
function remove(id) {
  const db = getDB()
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
}

// ----------- 统计 -----------
function counts(ownerOpenId) {
  const db = getDB()
  const rows = db.prepare(`
    SELECT status, count(*) as c FROM tasks
    WHERE owner_open_id = ?
    GROUP BY status
  `).all(ownerOpenId)
  const result = { active: 0, done: 0, overdue: 0, cancelled: 0, shelved: 0, total: 0 }
  for (const r of rows) {
    result[r.status] = r.c
    result.total += r.c
  }
  return result
}

module.exports = {
  createTask,
  get, listActive, listByStatus, listAll,
  findDueReminders,
  update, touch,
  markDone, markCancelled, markShelved, reactivate,
  remove,
  counts,
}
