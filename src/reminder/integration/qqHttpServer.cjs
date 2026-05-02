/**
 * qqbot 进程内的 HTTP 服务器 (懒注入版)
 *
 * 启动流程:
 *   1. startHttpServer() 立刻起服务 (不需要 sender)
 *   2. setSender(fn) 在 qqbot 准备好后注入发消息函数
 *   3. 在 sender 注入前到达的请求会返回 503
 */
const http = require('http')
const config = require('../config.cjs')
const { createLogger } = require('../utils/logger.cjs')

const log = createLogger('http_server')

let server = null
let _sendFn = null

function setSender(fn) {
  _sendFn = fn
  log.info('sender injected')
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => { data += c; if (data.length > 100000) req.destroy() })
    req.on('end', () => {
      if (!data) return resolve({})
      try { resolve(JSON.parse(data)) }
      catch { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

async function handleInternalReminder(body) {
  const { openId, content, meta = {} } = body
  if (!openId || !content) {
    throw Object.assign(new Error('openId and content required'), { statusCode: 400 })
  }
  if (!_sendFn) {
    throw Object.assign(new Error('sender not ready'), { statusCode: 503 })
  }
  try {
    await _sendFn(openId, content)
  } catch (e) {
    log.error('sender failed', { err: e.message, taskId: meta.taskId })
    throw Object.assign(new Error(`send failed: ${e.message}`), { statusCode: 502 })
  }
  log.info('reminder sent', {
    taskId: meta.taskId, source: meta.source, len: content.length
  })
  return { ok: true }
}

async function handler(req, res) {
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1' && remote !== '::1') {
    res.writeHead(403); return res.end('forbidden')
  }
  const token = req.headers['x-internal-token']
  if (token !== config.HTTP.token) {
    res.writeHead(401); return res.end('unauthorized')
  }

  try {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({
        ok: true,
        senderReady: !!_sendFn,
        ts: Date.now(),
      }))
    }
    if (req.method === 'POST' && req.url === '/internal/reminder') {
      const body = await parseBody(req)
      const result = await handleInternalReminder(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(result))
    }
    res.writeHead(404); return res.end('not found')
  } catch (e) {
    const code = e && e.statusCode || 500
    const msg = e && e.message || 'internal error'
    res.writeHead(code, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: msg }))
  }
}

function startHttpServer() {
  if (server) return server
  server = http.createServer(handler)
  server.listen(config.HTTP.port, config.HTTP.host, () => {
    log.info('HTTP server listening', {
      host: config.HTTP.host, port: config.HTTP.port
    })
  })
  server.on('error', (e) => log.error('server error', { err: e.message }))
  return server
}

function stopHttpServer() {
  if (server) {
    try { server.close() } catch {}
    server = null
    _sendFn = null
    log.info('HTTP server stopped')
  }
}

module.exports = { startHttpServer, stopHttpServer, setSender }
