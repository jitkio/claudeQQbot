/**
 * 极简日志工具
 * 按日期分文件，大小轮转（单文件 5MB 上限）
 */
const fs = require('fs')
const path = require('path')
const config = require('../config.cjs')

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const currentLevel = LEVELS[config.LOG_LEVEL] ?? 1

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function ts() {
  const d = new Date()
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

function formatMsg(level, tag, msg, extra) {
  const extraStr = extra ? ' ' + JSON.stringify(extra) : ''
  return `[${ts()}] [${level.toUpperCase()}] [${tag}] ${msg}${extraStr}\n`
}

function rotateIfNeeded(filePath, maxBytes = 5 * 1024 * 1024) {
  try {
    const st = fs.statSync(filePath)
    if (st.size > maxBytes) {
      fs.renameSync(filePath, filePath + '.old')
    }
  } catch { /* 文件不存在也算正常 */ }
}

function write(level, tag, msg, extra) {
  if (LEVELS[level] < currentLevel) return
  ensureDir(config.LOG_DIR)

  const line = formatMsg(level, tag, msg, extra)
  const logFile = path.join(config.LOG_DIR, `${tag}.log`)
  rotateIfNeeded(logFile)
  fs.appendFileSync(logFile, line)

  // 同时输出到 console（info 以上级别）
  if (LEVELS[level] >= LEVELS.info) {
    process.stdout.write(line)
  } else {
    // debug 只写文件
  }
}

function createLogger(tag) {
  return {
    debug: (msg, extra) => write('debug', tag, msg, extra),
    info:  (msg, extra) => write('info', tag, msg, extra),
    warn:  (msg, extra) => write('warn', tag, msg, extra),
    error: (msg, extra) => write('error', tag, msg, extra),
  }
}

module.exports = { createLogger }
