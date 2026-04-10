// 集中配置 — 所有工具从这里读取
// 配置来源: 项目根目录 .env 文件
const fs = require('fs')
const path = require('path')
const __ROOT = path.resolve(__dirname, '..')

// 读取 .env
const _env = {}
try {
  const envFile = path.join(__ROOT, '.env')
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (m) _env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
} catch {}

module.exports = {
  progressUrl: _env.PROGRESS_URL || 'http://127.0.0.1:3456',
  appId: _env.QQ_APP_ID || '',
  clientSecret: _env.QQ_CLIENT_SECRET || '',
  authUrl: 'https://bots.qq.com/app/getAppAccessToken',
  apiBase: 'https://api.sgroup.qq.com',
  userOpenId: _env.DEFAULT_USER_OPENID || '',
  async getToken() {
    const r = await fetch(this.authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
    })
    const data = await r.json()
    return data.access_token
  },
  async sendC2C(userId, content) {
    const token = await this.getToken()
    const r = await fetch(`${this.apiBase}/v2/users/${userId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `QQBot ${token}` },
      body: JSON.stringify({ content, msg_type: 0 }),
    })
    return r.ok
  },
  async sendGroup(groupId, content) {
    const token = await this.getToken()
    const r = await fetch(`${this.apiBase}/v2/groups/${groupId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `QQBot ${token}` },
      body: JSON.stringify({ content, msg_type: 0 }),
    })
    return r.ok
  },
}
