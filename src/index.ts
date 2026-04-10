import { startBot, replyMessage, splitMessage, downloadAttachment } from './qq.js'
import type { IncomingMessage } from './qq.js'
import { addTask, getUserTasks, getQueueStatus, cancelTask, resetSession } from './taskQueue.js'
import { CONFIG, PROJECT_ROOT } from './config.js'
import { existsSync } from 'fs'
import { basename } from 'path'

// ==================== 辅助函数 ====================

function getSessionKey(msg: IncomingMessage): string {
  if (msg.type === 'c2c') return `c2c_${msg.userOpenId}`
  return `group_${msg.groupOpenId}`
}

function getTargetId(msg: IncomingMessage): string {
  if (msg.type === 'c2c') return msg.userOpenId || ''
  return msg.groupOpenId || ''
}

// ==================== 即时命令（不进队列） ====================

function isInstantCommand(text: string): string | null {
  const t = text.trim().toLowerCase()
  if (t === '/status' || t === '状态') return 'status'
  if (t === '/new' || t === '新对话') return 'new'
  if (t === '/help' || t === '帮助') return 'help'
  if (t === '/tasks' || t === '任务列表' || t === '任务进度') return 'tasks'
  if (t.startsWith('/cancel ')) return 'cancel'
  if (t === '/remind' || t === '提醒列表') return 'remind'
  if (t.startsWith('/done ') || t.startsWith('完成 ')) return 'done'
  return null
}

async function handleInstant(cmd: string, text: string, msg: IncomingMessage): Promise<string> {
  const sk = getSessionKey(msg)

  switch (cmd) {
    case 'status': {
      const u = process.uptime(), h = Math.floor(u / 3600), m = Math.floor((u % 3600) / 60)
      const q = getQueueStatus()
      return `🤖 AI 秘书状态\n运行: ${h}h${m}m\n队列: ${q.running}运行中 / ${q.pending}等待中\n模式: 异步队列（不阻塞）`
    }

    case 'new':
      resetSession(sk)
      return '已开启全新对话。'

    case 'help':
      return `🤖 你的 AI 秘书\n\n发消息就行，我会立刻收下然后后台处理，完成后主动通知你。\n\n📎 发图片/文件 → 识别分析\n🔍 搜索信息 → 浏览器搜索\n📅 课程表 → 自动设提醒\n📊 图表/文档 → 生成文件\n⏰ 定时任务 → 自然语言\n\n指令:\n/tasks - 查看任务队列\n/cancel ID - 取消任务\n/new - 新对话\n/status - 状态\n/done 名称 - 打卡完成\n/remind - 提醒列表\n/help - 帮助`

    case 'tasks': {
      const userTasks = getUserTasks(sk)
      if (userTasks.length === 0) return '当前没有任务在跑。'

      const lines = userTasks.map(t => {
        const status = t.status === 'running' ? '🔄' : t.status === 'pending' ? '⏳' : t.status === 'done' ? '✅' : '❌'
        const elapsed = t.startedAt ? `${((Date.now() - t.startedAt) / 1000).toFixed(0)}s` : ''
        return `${status} [${t.id}] ${t.prompt.slice(0, 40)}… ${elapsed}`
      })
      return `📋 你的任务:\n${lines.join('\n')}\n\n取消任务: /cancel 任务ID`
    }

    case 'cancel': {
      const taskId = text.trim().split(' ')[1]
      if (!taskId) return '用法: /cancel 任务ID'
      const ok = cancelTask(taskId, sk)
      return ok ? `已取消任务 ${taskId}` : `找不到可取消的任务 ${taskId}`
    }

    case 'remind': {
      try {
        const { execSync } = require('child_process')
        const out = execSync('node ${PROJECT_ROOT}/tools/reminder_manager.cjs list', { encoding: 'utf-8', timeout: 10000 })
        return out.trim() || '当前没有提醒任务'
      } catch { return '查询失败' }
    }

    case 'done': {
      try {
        const { execSync } = require('child_process')
        const target = text.replace(/^\/done\s*/i, '').replace(/^完成\s*/, '').trim()
        if (!target) return '用法: /done 任务名 或 /done 任务ID'
        const uid = msg.userOpenId || ''
        const cmd = `node ${PROJECT_ROOT}/tools/reminder_manager.cjs done "${target}" "${uid}"`
        const out = execSync(cmd, { encoding: 'utf-8', timeout: 10000 })
        return out.trim() || '操作完成'
      } catch (e) { return '操作失败' }
    }

    default: return ''
  }
}

// ==================== 构建 prompt（含附件）====================

function buildPrompt(text: string, filePaths: string[]): string {
  if (!filePaths.length) return text
  const desc = filePaths.map(fp => {
    const ext = fp.split('.').pop()?.toLowerCase() || ''
    const IMG = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']
    const AUD = ['mp3', 'wav', 'ogg', 'flac', 'silk', 'slk', 'amr', 'm4a']
    const VID = ['mp4', 'avi', 'mkv', 'mov', 'webm']
    let type = '文件', hint = '用 Read 工具读取'
    if (IMG.includes(ext)) { type = '图片'; hint = '用 Read 工具读取分析图片内容' }
    else if (AUD.includes(ext)) { type = '语音'; hint = `先执行 node ${PROJECT_ROOT}/tools/audio_transcribe.cjs "${fp}"` }
    else if (VID.includes(ext)) { type = '视频'; hint = `先执行 node ${PROJECT_ROOT}/tools/video_process.cjs "${fp}"` }
    return `- [${type}] ${fp}\n  处理: ${hint}`
  }).join('\n')
  return `用户发送了文件:\n${desc}\n\n用户消息: ${text || '（请分析文件内容）'}`
}

// ==================== 消息去重 ====================

const recentMsgIds = new Set<string>()
const recentContentKeys = new Set<string>()

// ==================== 主消息处理（异步，永不阻塞）====================

async function handleMessage(msg: IncomingMessage) {
  // 按 msgId 去重
  if (recentMsgIds.has(msg.msgId)) {
    console.log(`[Dedup] 跳过重复msgId: ${msg.msgId}`)
    return
  }
  recentMsgIds.add(msg.msgId)
  setTimeout(() => recentMsgIds.delete(msg.msgId), 120000)

  // 按 用户+内容 去重（10秒窗口，防止 QQ 用不同msgId推送同一条消息）
  const contentKey = `${msg.userOpenId || msg.senderOpenId || 'unknown'}_${msg.content.trim().slice(0, 50)}`
  if (recentContentKeys.has(contentKey)) {
    console.log(`[Dedup] 跳过重复内容: ${contentKey}`)
    return
  }
  recentContentKeys.add(contentKey)
  setTimeout(() => recentContentKeys.delete(contentKey), 10000)

  // 清理群消息中的 @bot 标记
  const rawText = msg.content.replace(/<@!?\w+>/g, '').trim()
  const text = rawText
  const hasFiles = msg.attachments.length > 0
  if (!text && !hasFiles) return

  const sk = getSessionKey(msg)
  const tid = getTargetId(msg)

  // 1. 即时命令始终优先检查
  {
    const cmd = isInstantCommand(text)
    if (cmd) {
      await replyMessage(msg, await handleInstant(cmd, text, msg))
      return
    }
  }

  // 2. 下载附件
  const filePaths: string[] = []
  if (hasFiles) {
    for (const att of msg.attachments) {
      const p = await downloadAttachment(att)
      if (p) filePaths.push(p)
    }
  }

  // 3. 构建 prompt
  const prompt = buildPrompt(text, filePaths)

  // 4. 加入队列
  const result = addTask({
    prompt,
    sessionKey: sk,
    userId: msg.userOpenId || msg.senderOpenId || '',
    msgType: msg.type,
    targetId: tid,
  })

  // 5. 立刻回复用户
  if ('error' in result) {
    await replyMessage(msg, result.error)
  } else if (result.position <= 1) {
    await replyMessage(msg, "收到，正在处理…")
  } else {
    await replyMessage(msg, `收到，排在第 ${result.position} 位，前面还有 ${result.position - 1} 个任务`)
  }
}

// ==================== 启动 ====================

console.log('=========================================')
console.log('  Claude Code QQ Bot · 异步秘书模式')
console.log(`  最大并发: ${CONFIG.queue?.maxConcurrent || 2} | 超时: 10分钟`)
console.log('  你可以连续发多条消息，不会阻塞')
console.log('=========================================')

// 启动时清理残留的 claude 子进程
try {
  const { execSync } = require('child_process')
  const pids = execSync('pgrep -f "claude -p" 2>/dev/null || true', { encoding: 'utf-8' }).trim()
  if (pids) {
    const count = pids.split('\n').length
    execSync('pkill -f "claude -p" 2>/dev/null || true')
    console.log(`[启动] 清理了 ${count} 个残留 claude 进程`)
  }
} catch {}

startBot(handleMessage).catch(e => { console.error('启动失败:', e); process.exit(1) })
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
