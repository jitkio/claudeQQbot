/**
 * ID 生成工具
 */
const crypto = require('crypto')

// 生成任务 ID：tk_xxxxxx (6 位 hex)
function genTaskId() {
  return 'tk_' + crypto.randomBytes(3).toString('hex')
}

// 生成短 ID (4 位 hex)，用于确认码等
function genShortId() {
  return crypto.randomBytes(2).toString('hex')
}

module.exports = { genTaskId, genShortId }
