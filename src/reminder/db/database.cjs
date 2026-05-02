/**
 * SQLite 连接单例
 * 整个进程共用同一个 db 对象
 */
const Database = require('better-sqlite3')
const fs = require('fs')
const path = require('path')
const config = require('../config.cjs')
const { createLogger } = require('../utils/logger.cjs')

const log = createLogger('db')

let _db = null

function getDB() {
  if (_db) return _db

  // 确保目录存在
  const dir = path.dirname(config.DB_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  // 如果 db 文件不存在，说明没跑 step2 init，报错提示
  if (!fs.existsSync(config.DB_PATH)) {
    throw new Error(
      `数据库不存在: ${config.DB_PATH}\n` +
      `请先跑 step2 建立 schema`
    )
  }

  _db = new Database(config.DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  _db.pragma('synchronous = NORMAL')
  _db.pragma('busy_timeout = 5000')  // 遇到锁等 5 秒

  log.info('db connected', { path: config.DB_PATH })
  return _db
}

function closeDB() {
  if (_db) {
    _db.close()
    _db = null
    log.info('db closed')
  }
}

// 进程退出时优雅关闭
process.on('exit', closeDB)
process.on('SIGINT', () => { closeDB(); process.exit(0) })
process.on('SIGTERM', () => { closeDB(); process.exit(0) })

module.exports = { getDB, closeDB }
