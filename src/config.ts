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
  modelProvider: env('MODEL_PROVIDER', 'claude_code') as string,
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
  // 多模型 Agent Engine 配置
  model: {
    provider: env('MODEL_PROVIDER', 'claude_code') as 'anthropic' | 'openai' | 'claude_code',
    name: env('MODEL_NAME', ''),
    apiKey: env('MODEL_PROVIDER', 'claude_code') === 'anthropic'
      ? (process.env.ANTHROPIC_API_KEY || '')
      : (process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || ''),
    baseUrl: env('MODEL_PROVIDER', 'claude_code') === 'anthropic'
      ? (process.env.ANTHROPIC_BASE_URL || '')
      : (process.env.OPENAI_BASE_URL || ''),
    maxTokens: parseInt(env('MODEL_MAX_TOKENS', '4096')),
    temperature: parseFloat(env('MODEL_TEMPERATURE', '0.7')),
  },
  maxConcurrent: parseInt(env('MAX_CONCURRENT', '2')),
  message: {
    maxLength: parseInt(env('MSG_MAX_LENGTH', '2000')),
    chunkDelay: 600,
  },
  // 降级模型配置（可选）
  fallback: {
    provider: env('FALLBACK_PROVIDER', '') as string,
    model: env('FALLBACK_MODEL', '') as string,
    apiKey: env('FALLBACK_API_KEY', '') as string,
    baseUrl: env('FALLBACK_BASE_URL', '') as string,
  },
}
