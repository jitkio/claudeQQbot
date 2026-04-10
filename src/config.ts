import { config } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = resolve(__dirname, '..')

// 加载 .env
config({ path: resolve(PROJECT_ROOT, '.env') })

function env(key: string, fallback?: string): string {
  const v = process.env[key]
  if (v !== undefined && v !== '') return v
  if (fallback !== undefined) return fallback
  throw new Error(`缺少环境变量: ${key}，请运行 node setup.mjs 配置`)
}

export const CONFIG = {
  modelProvider: env('MODEL_PROVIDER', 'claude_code'),
  qq: {
    appId: env('QQ_APP_ID'),
    clientSecret: env('QQ_CLIENT_SECRET'),
    authUrl: 'https://bots.qq.com/app/getAppAccessToken',
    apiBase: 'https://api.sgroup.qq.com',
    intents: (1 << 25),
  },
  claude: {
    apiKey: process.env.CLAUDE_API_KEY || '',
    timeoutMs: parseInt(env('TASK_TIMEOUT_SEC', '600')) * 1000,
    workDir: resolve(PROJECT_ROOT, 'workspace'),
    uploadsDir: resolve(PROJECT_ROOT, 'workspace/uploads'),
    outputDir: resolve(PROJECT_ROOT, 'workspace/output'),
    toolsDir: resolve(PROJECT_ROOT, 'tools'),
  },
  maxConcurrent: parseInt(env('MAX_CONCURRENT', '2')),
  message: {
    maxLength: parseInt(env('MSG_MAX_LENGTH', '2000')),
    chunkDelay: 600,
  },
}
