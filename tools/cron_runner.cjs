const __ROOT = require('path').resolve(__dirname, '..')
const fs = require('fs')
const { spawnSync } = require('child_process')
const cfg = require('./shared_config.cjs')

const taskId = process.argv[2]
if (!taskId) { console.error('用法: node cron_runner.cjs "taskId"'); process.exit(1) }

const TF = __ROOT + '/workspace/scheduled_tasks.json'
const SQ = __ROOT + '/tools/send_qq.cjs'

function read() { try { return JSON.parse(fs.readFileSync(TF, 'utf-8')).tasks || [] } catch { return [] } }
function write(t) { fs.writeFileSync(TF, JSON.stringify({ tasks: t }, null, 2)) }

async function main() {
  const tasks = read()
  const task = tasks.find(t => t.id === taskId)
  if (!task) { console.log(`任务 ${taskId} 不存在`); return }

  console.log(`[Cron] 执行: ${task.name || task.id} | ${task.prompt.slice(0, 60)}`)

  let result
  try {
    const r = spawnSync('claude', ['-p', task.prompt, '--dangerously-skip-permissions'], {
      cwd: __ROOT + '/workspace', env: process.env,
      timeout: 300000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    result = r.status === 0 ? (r.stdout.trim() || '（执行完毕）') : `定时任务失败: ${(r.stderr || '').slice(0, 200)}`
  } catch (e) { result = `定时任务失败: ${e.message}` }

  if (task.userId) {
    const msg = task.name ? `⏰「${task.name}」\n\n${result.slice(0, 1800)}` : `⏰ 提醒\n\n${result.slice(0, 1800)}`
    try {
      spawnSync('node', [SQ, task.userId], { input: msg, timeout: 30000, encoding: 'utf-8' })
    } catch (e) { console.error('QQ发送失败:', e.message) }
  }

  task.lastFiredAt = Date.now()
  if (!task.recurring) {
    write(tasks.filter(t => t.id !== taskId))
    try { spawnSync('bash', ['-c', `crontab -l 2>/dev/null | grep -v "${taskId}" | crontab -`]) } catch {}
  } else { write(tasks) }
}
main().catch(e => console.error(e))
