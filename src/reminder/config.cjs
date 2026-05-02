/**
 * 智能提醒系统 - 统一配置
 * 从 .env 读取，提供默认值
 */
const path = require('path')
const fs = require('fs')

// 加载项目根目录的 .env
const envPath = path.resolve(__dirname, '../../.env')
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath })
}

// Redis 密码从文件读取（优先）或从 .env（备选）
function readRedisPassword() {
  const passwordFile = path.join(require('os').homedir(), '.reminder_redis_password')
  if (fs.existsSync(passwordFile)) {
    return fs.readFileSync(passwordFile, 'utf-8').trim()
  }
  return process.env.REDIS_PASSWORD || ''
}

const PROJECT_ROOT = path.resolve(__dirname, '../..')

module.exports = {
  // --- 路径 ---
  PROJECT_ROOT,
  DB_PATH: path.join(PROJECT_ROOT, 'data/reminder/reminder.db'),
  EXPORT_DIR: path.join(PROJECT_ROOT, 'data/reminder/exports'),
  LOG_DIR: path.join(PROJECT_ROOT, 'logs/reminder'),

  // --- Redis ---
  REDIS: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: readRedisPassword(),
    maxRetriesPerRequest: null,  // BullMQ 要求
  },

  // --- HTTP 通信 (Worker 调 qqbot) ---
  HTTP: {
    host: '127.0.0.1',
    port: parseInt(process.env.REMINDER_HTTP_PORT || '8788', 10),
    token: process.env.REMINDER_INTERNAL_TOKEN || '',  // 内部认证 token
  },

  // --- 用户配置 ---
  OWNER_OPEN_ID: process.env.OWNER_OPEN_ID || '',  // 你的 QQ openid

  // --- 提醒规则 ---
  QUIET_HOURS: {
    start: 23,   // 23:00 开始静音
    end: 7,      // 07:00 结束静音
  },
  MORNING_REPORT_HOUR: 7,
  MORNING_REPORT_MINUTE: 0,
  SHELVE_AFTER_DAYS: 7,  // 连续不打卡 7 天后搁置
  EVENING_NAG_HOUR: 20,  // 20:00 对未打卡任务念叨

  // --- LLM (用主 bot 的配置) ---
  LLM: {
    provider: process.env.MODEL_PROVIDER || 'openai',
    model: process.env.MODEL_NAME || 'deepseek-v4-flash',
    apiKey: process.env.OPENAI_API_KEY || '',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.deepseek.com',
  },

  // --- 日志 ---
  LOG_LEVEL: process.env.REMINDER_LOG_LEVEL || 'info',
}
