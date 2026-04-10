const __ROOT = require('path').resolve(__dirname, '..')
// 系统信息查询工具
// 用法: node system_info.cjs [full|brief|tasks|disk|memory]
const { execSync } = require('child_process')
const fs = require('fs')

const mode = process.argv[2] || 'brief'

function safe(cmd) { try { return execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim() } catch { return '(获取失败)' } }

function brief() {
  const uptime = safe('uptime -p')
  const load = safe("cat /proc/loadavg | awk '{print $1, $2, $3}'")
  const memRaw = safe("free -m | awk '/Mem:/{printf \"%d/%dMB (%.0f%%)\", $3, $2, $3/$2*100}'")
  const disk = safe("df -h / | awk 'NR==2{printf \"%s/%s (%s)\", $3, $2, $5}'")
  console.log(`系统: ${uptime}`)
  console.log(`负载: ${load}`)
  console.log(`内存: ${memRaw}`)
  console.log(`磁盘: ${disk}`)
}

function tasks() {
  // QQ Bot 进程
  const pm2 = safe('pm2 jlist 2>/dev/null')
  try {
    const list = JSON.parse(pm2)
    for (const app of list) {
      console.log(`[PM2] ${app.name}: ${app.pm2_env?.status || 'unknown'} | CPU:${app.monit?.cpu || 0}% | MEM:${((app.monit?.memory || 0) / 1024 / 1024).toFixed(0)}MB | 重启:${app.pm2_env?.restart_time || 0}次`)
    }
  } catch {
    console.log('[PM2] 未运行或未安装')
  }

  // 定时任务
  const crontab = safe('crontab -l 2>/dev/null')
  const cronLines = crontab.split('\n').filter(l => l.trim() && !l.startsWith('#'))
  console.log(`[Cron] ${cronLines.length} 个定时任务`)

  // 任务队列
  try {
    const queue = JSON.parse(fs.readFileSync(__ROOT + '/task_queue.json', 'utf-8'))
    const pending = queue.filter(t => t.status === 'pending').length
    const running = queue.filter(t => t.status === 'running').length
    console.log(`[Queue] ${running} 运行中, ${pending} 等待`)
  } catch {
    console.log('[Queue] 队列为空')
  }
}

if (mode === 'brief') brief()
else if (mode === 'tasks') tasks()
else if (mode === 'full') { brief(); console.log(''); tasks() }
else if (mode === 'disk') console.log(safe('df -h'))
else if (mode === 'memory') console.log(safe('free -h'))
else console.log('用法: node system_info.cjs [full|brief|tasks|disk|memory]')
