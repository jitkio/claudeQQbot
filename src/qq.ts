import WebSocket from 'ws'
import { CONFIG } from './config.js'
import { writeFileSync } from 'fs'
import { basename, extname } from 'path'

export interface Attachment {
  content_type: string
  filename: string
  url: string
  localPath?: string
}

export interface IncomingMessage {
  type: 'c2c' | 'group'
  content: string
  msgId: string
  userOpenId?: string
  groupOpenId?: string
  senderOpenId?: string
  _seq: number
  attachments: Attachment[]
}

type MessageHandler = (msg: IncomingMessage) => void
interface AccessToken { token: string; expiresAt: number }
let accessToken: AccessToken | null = null

async function refreshAccessToken(): Promise<string> {
  if (accessToken && Date.now() < accessToken.expiresAt - 60_000) return accessToken.token
  const resp = await fetch(CONFIG.qq.authUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: CONFIG.qq.appId, clientSecret: CONFIG.qq.clientSecret }),
  })
  if (!resp.ok) throw new Error(`Token失败(${resp.status})`)
  const data = await resp.json() as { access_token: string; expires_in: number }
  accessToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }
  return accessToken.token
}

async function apiRequest(path: string, body: any): Promise<any> {
  const token = await refreshAccessToken()
  const resp = await fetch(`${CONFIG.qq.apiBase}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `QQBot ${token}` },
    body: JSON.stringify(body),
  })
  const text = await resp.text()
  try { return JSON.parse(text) } catch { return { raw: text } }
}

export async function downloadAttachment(att: Attachment): Promise<string> {
  const ts = Date.now()
  const ext = extname(att.filename || '.bin') || '.bin'
  const localName = `${ts}_${Math.random().toString(36).slice(2, 8)}${ext}`
  const localPath = `${CONFIG.claude.uploadsDir}/${localName}`
  try {
    const token = await refreshAccessToken()
    const resp = await fetch(att.url, { headers: { 'Authorization': `QQBot ${token}` } })
    if (!resp.ok) {
      // 无授权重试
      const resp2 = await fetch(att.url)
      if (!resp2.ok) throw new Error(`HTTP ${resp2.status}`)
      const buf = Buffer.from(await resp2.arrayBuffer())
      writeFileSync(localPath, buf)
    } else {
      const buf = Buffer.from(await resp.arrayBuffer())
      writeFileSync(localPath, buf)
    }
    console.log(`[QQ] 下载: ${att.filename} → ${localPath}`)
    return localPath
  } catch (e: any) {
    console.error(`[QQ] 下载失败: ${e.message}`)
    return ''
  }
}

export async function sendC2CMessage(uid: string, content: string, msgId?: string, seq?: number) {
  const body: any = { content, msg_type: 0 }
  if (msgId) body.msg_id = msgId
  if (seq !== undefined) body.msg_seq = seq
  return apiRequest(`/v2/users/${uid}/messages`, body)
}

export async function sendGroupMessage(gid: string, content: string, msgId?: string, seq?: number) {
  const body: any = { content, msg_type: 0 }
  if (msgId) body.msg_id = msgId
  if (seq !== undefined) body.msg_seq = seq
  return apiRequest(`/v2/groups/${gid}/messages`, body)
}

export async function replyMessage(msg: IncomingMessage, content: string) {
  msg._seq++
  if (msg.type === 'c2c' && msg.userOpenId) return sendC2CMessage(msg.userOpenId, content, msg.msgId, msg._seq)
  if (msg.type === 'group' && msg.groupOpenId) return sendGroupMessage(msg.groupOpenId, content, msg.msgId, msg._seq)
}

export function splitMessage(text: string): string[] {
  const ml = CONFIG.message.maxLength
  if (text.length <= ml) return [text]
  const segs: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    if (line.length > ml) {
      if (cur) { segs.push(cur); cur = '' }
      for (let i = 0; i < line.length; i += ml) segs.push(line.slice(i, i + ml))
      continue
    }
    if ((cur + '\n' + line).length > ml) { if (cur) segs.push(cur); cur = line }
    else cur += (cur ? '\n' : '') + line
  }
  if (cur) segs.push(cur)
  return segs
}

// ===== WebSocket =====
let ws: WebSocket | null = null, hbTimer: any = null, sid: string | null = null, seq: number | null = null
let handler: MessageHandler | null = null, reconn = 0

export async function startBot(onMsg: MessageHandler) { handler = onMsg; await connect() }

async function connect() {
  if (ws) { try { ws.removeAllListeners(); ws.close(); } catch {} ws = null as any }
  try {
    const token = await refreshAccessToken()
    const gw = await fetch(`${CONFIG.qq.apiBase}/gateway`, { headers: { 'Authorization': `QQBot ${token}` } })
    if (!gw.ok) throw new Error(`gateway ${gw.status}`)
    const { url } = await gw.json() as { url: string }
    ws = new WebSocket(url)
    ws.on('open', () => console.log('[QQ] 已连接'))
    ws.on('message', (r: Buffer) => { try { onWs(JSON.parse(r.toString())) } catch {} })
    ws.on('close', () => { stopHb(); recon() })
    ws.on('error', (e: Error) => console.error('[QQ] 错误:', e.message))
  } catch (e) { console.error('[QQ] 连接失败:', e); recon() }
}

function onWs(d: any) {
  if (d.s) seq = d.s
  switch (d.op) {
    case 10: startHb(d.d.heartbeat_interval); ident(); break
    case 11: break
    case 0: dispatch(d.t, d.d); break
    case 7: ws?.close(); break
    case 9: sid = null; setTimeout(ident, 2000); break
  }
}

async function ident() {
  const token = await refreshAccessToken()
  if (sid) ws?.send(JSON.stringify({ op: 6, d: { token: `QQBot ${token}`, session_id: sid, seq } }))
  else ws?.send(JSON.stringify({ op: 2, d: { token: `QQBot ${token}`, intents: CONFIG.qq.intents, shard: [0, 1] } }))
}

function parseAtts(data: any): Attachment[] {
  const atts: Attachment[] = []
  if (Array.isArray(data.attachments)) {
    for (const a of data.attachments) atts.push({ content_type: a.content_type || '', filename: a.filename || 'file', url: a.url || '' })
  }
  return atts
}

function dispatch(t: string, d: any) {
  switch (t) {
    case 'READY': sid = d.session_id; reconn = 0; console.log(`[QQ] 就绪! ${d.user?.username}`); break
    case 'RESUMED': reconn = 0; console.log('[QQ] 已恢复连接'); break
    case 'C2C_MESSAGE_CREATE':
      handler?.({ type: 'c2c', content: (d.content || '').trim(), msgId: d.id, userOpenId: d.author?.user_openid, _seq: 0, attachments: parseAtts(d) })
      break
    case 'GROUP_AT_MESSAGE_CREATE':
      handler?.({ type: 'group', content: (d.content || '').trim(), msgId: d.id, groupOpenId: d.group_openid, senderOpenId: d.author?.member_openid, _seq: 0, attachments: parseAtts(d) })
      break
  }
}

function startHb(ms: number) { stopHb(); hbTimer = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: seq })) }, ms) }
function stopHb() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null } }
function recon() { reconn++; const d = Math.min(1000 * 2 ** (reconn - 1), 30000); setTimeout(connect, d) }
