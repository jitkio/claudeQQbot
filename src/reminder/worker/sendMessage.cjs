/**
 * 消息发送客户端
 * 通过 HTTP 调用 qqbot 的内部接口
 *
 * 注意：qqbot 的 HTTP 接口在 step3d 才实现，本文件的 sendToQQ
 *       目前会在 HTTP 失败时 fallback 到"仅日志"模式，不会让 Worker 崩
 */
const http = require('http')
const config = require('../config.cjs')
const { createLogger } = require('../utils/logger.cjs')

const log = createLogger('sendMsg')

// 真正发送给 qqbot 的 HTTP 接口
function postInternal(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request({
      host: config.HTTP.host,
      port: config.HTTP.port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Internal-Token': config.HTTP.token,
      },
      timeout: 10000,
    }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data || '{}')) }
          catch { resolve({ raw: data }) }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('HTTP timeout')) })
    req.write(payload)
    req.end()
  })
}

/**
 * 给 QQ 用户发一条提醒消息
 * @param {string} ownerOpenId
 * @param {string} content
 * @param {object} opts - { taskId, source='remind'|'morning'|'nag' }
 * @returns {Promise<{status: 'sent' | 'failed' | 'dry', error?: string}>}
 */
async function sendToQQ(ownerOpenId, content, opts = {}) {
  try {
    const result = await postInternal('/internal/reminder', {
      openId: ownerOpenId,
      content,
      meta: opts,
    })
    log.info('sent', { taskId: opts.taskId, source: opts.source, len: content.length })
    return { status: 'sent', result }
  } catch (e) {
    // step3d 之前 qqbot 还没接入 HTTP 端点，会 connect refused
    // 这时走 fallback：只打日志，不认为是失败（Worker 不应崩）
    if (e.message.includes('ECONNREFUSED') || e.message.includes('ENOTFOUND')) {
      log.warn('qqbot HTTP 未就绪 (dry run)', { taskId: opts.taskId, content: content.slice(0, 60) })
      return { status: 'dry', error: e.message }
    }
    log.error('send failed', { taskId: opts.taskId, err: e.message })
    return { status: 'failed', error: e.message }
  }
}

module.exports = { sendToQQ }
