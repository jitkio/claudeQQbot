const __ROOT = require('path').resolve(__dirname, '..')
const http = require('http')
const fs = require('fs')
const path = require('path')

const PORT = 3456
const PROG_DIR = __ROOT + '/workspace/progress'

// 读进度文件
function readProgress(taskId) {
  try {
    const fp = path.join(PROG_DIR, `${taskId}.json`)
    return JSON.parse(fs.readFileSync(fp, 'utf-8'))
  } catch { return null }
}

// 基于时间的平滑进度计算（对数曲线，90秒到~63%，180秒到~86%，完成时100%）
function calcProgress(data) {
  if (!data) return { percent: 0, stage: '等待中...', status: 'pending', result: null }
  if (data.status === 'done') return { percent: 100, stage: '完成', status: 'done', result: data.result || '' }
  if (data.status === 'failed') return { percent: 100, stage: '失败', status: 'failed', result: data.error || '未知错误' }

  const elapsed = (Date.now() - data.startedAt) / 1000
  const percent = Math.min(92, Math.round(90 * (1 - Math.exp(-elapsed / 90))))

  let stage = '正在启动 AI...'
  if (elapsed > 5) stage = '正在理解你的请求...'
  if (elapsed > 15) stage = '正在处理中...'
  if (elapsed > 40) stage = '正在整理回复...'
  if (elapsed > 90) stage = '还在努力中，请耐心等待...'
  if (elapsed > 180) stage = '任务比较复杂，仍在处理...'

  return { percent, stage, status: 'running', result: null }
}

// HTML 页面
function renderPage(taskId) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>任务进度</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    background: #0a0a0f;
    color: #e0e0e0;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 20px;
  }
  .container {
    width: 100%;
    max-width: 500px;
  }
  .header {
    text-align: center;
    margin-bottom: 40px;
  }
  .header h1 {
    font-size: 18px;
    font-weight: 400;
    color: #888;
    letter-spacing: 2px;
  }
  .progress-wrap {
    background: #1a1a2e;
    border-radius: 12px;
    height: 28px;
    overflow: hidden;
    position: relative;
    box-shadow: inset 0 2px 8px rgba(0,0,0,0.5);
  }
  .progress-bar {
    height: 100%;
    border-radius: 12px;
    background: linear-gradient(90deg, #667eea, #764ba2, #f953c6);
    background-size: 200% 100%;
    animation: shimmer 2s ease-in-out infinite;
    transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
  }
  .progress-bar::after {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.15) 50%, transparent 100%);
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  @keyframes pulse {
    0%,100% { opacity: 0; }
    50% { opacity: 1; }
  }
  .progress-bar.done {
    background: linear-gradient(90deg, #00c853, #69f0ae);
    animation: none;
  }
  .progress-bar.done::after { animation: none; opacity: 0; }
  .progress-bar.failed {
    background: linear-gradient(90deg, #ff1744, #ff8a80);
    animation: none;
  }
  .progress-bar.failed::after { animation: none; opacity: 0; }
  .info {
    display: flex;
    justify-content: space-between;
    margin-top: 16px;
    font-size: 14px;
  }
  .stage { color: #aaa; }
  .percent { color: #fff; font-weight: 600; font-variant-numeric: tabular-nums; }
  .result-box {
    margin-top: 32px;
    background: #12121f;
    border: 1px solid #2a2a3e;
    border-radius: 12px;
    padding: 20px;
    max-height: 60vh;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 14px;
    line-height: 1.7;
    display: none;
  }
  .result-box.show { display: block; }
  .prompt-box {
    text-align: center;
    margin-bottom: 24px;
    padding: 12px 20px;
    background: #12121f;
    border-radius: 8px;
    font-size: 14px;
    color: #bbb;
  }
  .elapsed {
    text-align: center;
    margin-top: 12px;
    font-size: 12px;
    color: #555;
  }
</style>
</head>
<body>
<div class="container">
  <div class="header"><h1>AI 秘书 · 任务进度</h1></div>
  <div class="prompt-box" id="prompt">加载中...</div>
  <div class="progress-wrap">
    <div class="progress-bar" id="bar" style="width:0%"></div>
  </div>
  <div class="info">
    <span class="stage" id="stage">连接中...</span>
    <span class="percent" id="pct">0%</span>
  </div>
  <div class="elapsed" id="elapsed"></div>
  <div class="result-box" id="result"></div>
</div>
<script>
const taskId = location.pathname.split('/').pop()
let startTime = null

const evtSrc = new EventSource('/task/' + taskId + '/stream')
evtSrc.onmessage = function(e) {
  const d = JSON.parse(e.data)
  if (!startTime && d.startedAt) startTime = d.startedAt

  document.getElementById('bar').style.width = d.percent + '%'
  document.getElementById('pct').textContent = d.percent + '%'
  document.getElementById('stage').textContent = d.stage
  if (d.prompt) document.getElementById('prompt').textContent = d.prompt

  const bar = document.getElementById('bar')
  bar.className = 'progress-bar'
  if (d.status === 'done') bar.classList.add('done')
  if (d.status === 'failed') bar.classList.add('failed')

  if (d.result) {
    const rb = document.getElementById('result')
    rb.textContent = d.result
    rb.classList.add('show')
  }

  if (d.status === 'done' || d.status === 'failed') {
    evtSrc.close()
    document.getElementById('elapsed').textContent = ''
  }
}
evtSrc.onerror = function() {
  document.getElementById('stage').textContent = '连接断开，刷新重试'
}

// 计时器
setInterval(() => {
  if (!startTime) return
  const s = Math.floor((Date.now() - startTime) / 1000)
  const m = Math.floor(s / 60)
  const ss = s % 60
  document.getElementById('elapsed').textContent = m > 0 ? m + '分' + ss + '秒' : ss + '秒'
}, 1000)
</script>
</body>
</html>`
}

// HTTP 服务
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')

  // GET /task/:id → HTML 页面
  if (parts.length === 2 && parts[0] === 'task') {
    const taskId = parts[1]
    const data = readProgress(taskId)
    if (!data) { res.writeHead(404); res.end('任务不存在'); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(renderPage(taskId))
    return
  }

  // GET /task/:id/stream → SSE
  if (parts.length === 3 && parts[0] === 'task' && parts[2] === 'stream') {
    const taskId = parts[1]
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    })

    const send = () => {
      const data = readProgress(taskId)
      if (!data) { res.write('data: {"percent":0,"stage":"任务不存在","status":"failed"}\n\n'); return }
      const prog = calcProgress(data)
      prog.prompt = (data.prompt || '').slice(0, 60)
      prog.startedAt = data.startedAt
      res.write(`data: ${JSON.stringify(prog)}\n\n`)

      // 任务结束后停止推送
      if (data.status === 'done' || data.status === 'failed') {
        clearInterval(timer)
      }
    }

    send() // 立即发一次
    const timer = setInterval(send, 1000) // 每秒推送

    req.on('close', () => clearInterval(timer))
    return
  }

  // 其他请求
  res.writeHead(404)
  res.end('Not Found')
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[进度服务] 已启动 http://0.0.0.0:${PORT}`)
})
