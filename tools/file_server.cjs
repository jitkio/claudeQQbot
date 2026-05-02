require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") })
// 本地文件服务器:把 workspace/output 下的文件通过 HTTP 暴露给 QQ 服务端拉取
// URL 格式: http://<host>:<port>/f/<token>/<原文件名>
// token 带过期时间,路径经过白名单 + realpath 双重校验

const http = require('http')
const fs   = require('fs')
const path = require('path')
const crypto = require('crypto')

const PORT        = parseInt(process.env.FILE_SERVER_PORT || '8787', 10)
const HOST        = '0.0.0.0'
const PROJECT_ROOT = path.resolve(__dirname, '..')
const OUTPUT_ROOT  = path.resolve(PROJECT_ROOT, 'workspace', 'output')
const UPLOAD_ROOT  = path.resolve(PROJECT_ROOT, 'workspace', 'uploads')
const ALLOWED_ROOTS = [OUTPUT_ROOT, UPLOAD_ROOT]
const TOKEN_DB    = path.resolve(PROJECT_ROOT, 'workspace', 'file_tokens.json')
const TTL_MS      = 7 * 24 * 3600 * 1000  // 7 天

function loadDB() {
  try { return JSON.parse(fs.readFileSync(TOKEN_DB, 'utf-8')) } catch { return {} }
}
function saveDB(db) {
  try { fs.writeFileSync(TOKEN_DB, JSON.stringify(db)) } catch (e) { console.error('[file_server] saveDB:', e.message) }
}
function gcDB() {
  const db = loadDB()
  const now = Date.now()
  let removed = 0
  for (const k of Object.keys(db)) {
    if (db[k].expireAt < now) { delete db[k]; removed++ }
  }
  if (removed) saveDB(db)
}

function inAllowedRoot(abs) {
  return ALLOWED_ROOTS.some(r => abs === r || abs.startsWith(r + path.sep))
}

// 给主进程 require 时调用:注册文件,返回可供 QQ 访问的 URL
function publish(absPath) {
  const normalized = path.resolve(absPath)
  if (!inAllowedRoot(normalized)) throw new Error(`path outside allowed roots: ${normalized}`)
  if (!fs.existsSync(normalized)) throw new Error(`file not found: ${normalized}`)
  const real = fs.realpathSync(normalized)
  if (!inAllowedRoot(real)) throw new Error(`realpath outside allowed roots: ${real}`)

  gcDB()
  const db = loadDB()
  const token = crypto.randomBytes(8).toString('hex')
  db[token] = { path: real, expireAt: Date.now() + TTL_MS }
  saveDB(db)

  const base = process.env.FILE_SERVER_PUBLIC_BASE || `http://localhost:${PORT}`
  const name = path.basename(real)
  // URL 末尾必须带原文件名,QQ 会用它作为收到的文件名
  return `${base}/f/${token}/${encodeURIComponent(name)}`
}

// HTTP 处理:/f/<token>/<filename>
function handler(req, res) {
  const m = req.url && req.url.match(/^\/f\/([a-f0-9]+)\/([^?]+)/)
  if (!m) { res.writeHead(404); return res.end('not found') }
  const token = m[1]
  const db = loadDB()
  const entry = db[token]
  if (!entry) { res.writeHead(404); return res.end('token invalid') }
  if (Date.now() > entry.expireAt) {
    delete db[token]; saveDB(db)
    res.writeHead(410); return res.end('expired')
  }
  let real
  try { real = fs.realpathSync(entry.path) } catch { res.writeHead(404); return res.end('file gone') }
  if (!inAllowedRoot(real)) { res.writeHead(403); return res.end('forbidden') }
  const stat = fs.statSync(real)
  const name = path.basename(real)
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  })
  fs.createReadStream(real).pipe(res)
  console.log(`[file_server] served ${token} → ${name} (${stat.size} bytes) to ${req.socket.remoteAddress}`)
}

// 如果这个文件被当作 pm2 进程的入口启动,就起 HTTP server
// 如果被 require,只导出 publish
if (require.main === module) {
  http.createServer(handler).listen(PORT, HOST, () => {
    console.log(`[file_server] listening on ${HOST}:${PORT}`)
    console.log(`[file_server] OUTPUT_ROOT=${OUTPUT_ROOT}`)
    console.log(`[file_server] PUBLIC_BASE=${process.env.FILE_SERVER_PUBLIC_BASE || '(unset, use localhost)'}`)
  })
  setInterval(gcDB, 3600 * 1000)
}

module.exports = { publish, PORT, OUTPUT_ROOT }
