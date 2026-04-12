#!/usr/bin/env node

/**
 * AI Agent QQ Bot 交互式安装脚本
 * 运行: node setup.mjs
 */

import { createInterface } from 'readline'
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs'

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise((r) => rl.question(q, r))

function printBanner() {
  console.log('')
  console.log('=========================================')
  console.log('   AI Agent QQ Bot - 交互式安装')
  console.log('=========================================')
  console.log('')
}

function printStep(n, title) {
  console.log(`\n--- 第 ${n} 步: ${title} ---\n`)
}

async function main() {
  printBanner()

  // 检查是否已有 .env，提示覆盖
  if (existsSync('.env')) {
    const overwrite = await ask('检测到已有 .env 配置文件，是否覆盖？(y/N) ')
    if (overwrite.toLowerCase() !== 'y') {
      console.log('已取消，保留现有配置。')
      rl.close()
      return
    }
  }

  const config = {}

  // ========== 第 1 步: 选择模型 ==========
  printStep(1, '选择 AI 模型')
  console.log('  1) DeepSeek      - 便宜好用，支持工具调用')
  console.log('  2) Anthropic     - Claude API 直连，走 Agent Engine')
  console.log('  3) OpenAI (GPT)  - GPT-4o 等模型')
  console.log('  4) 通义千问      - 阿里云大模型')
  console.log('  5) Moonshot      - 月之暗面')
  console.log('  6) Claude Code   - 原有 CLI 模式（需安装 claude 命令行）')
  console.log('')

  let providerChoice = ''
  while (!['1','2','3','4','5','6'].includes(providerChoice)) {
    providerChoice = await ask('请选择 (1-6): ')
  }

  const providerMap = {
    '1': { provider: 'openai', name: 'deepseek-chat', baseUrlDefault: 'https://api.deepseek.com', label: 'DeepSeek', keyEnv: 'OPENAI_API_KEY', baseEnv: 'OPENAI_BASE_URL' },
    '2': { provider: 'anthropic', name: 'claude-sonnet-4-20250514', baseUrlDefault: '', label: 'Anthropic', keyEnv: 'ANTHROPIC_API_KEY', baseEnv: 'ANTHROPIC_BASE_URL' },
    '3': { provider: 'openai', name: 'gpt-4o', baseUrlDefault: '', label: 'OpenAI', keyEnv: 'OPENAI_API_KEY', baseEnv: 'OPENAI_BASE_URL' },
    '4': { provider: 'openai', name: 'qwen-plus', baseUrlDefault: 'https://dashscope.aliyuncs.com/compatible-mode', label: '通义千问', keyEnv: 'OPENAI_API_KEY', baseEnv: 'OPENAI_BASE_URL' },
    '5': { provider: 'openai', name: 'moonshot-v1-8k', baseUrlDefault: 'https://api.moonshot.cn', label: 'Moonshot', keyEnv: 'OPENAI_API_KEY', baseEnv: 'OPENAI_BASE_URL' },
    '6': { provider: 'claude_code', name: '', baseUrlDefault: '', label: 'Claude Code CLI', keyEnv: '', baseEnv: '' },
  }

  const selected = providerMap[providerChoice]
  config.MODEL_PROVIDER = selected.provider
  config.MODEL_NAME = selected.name

  console.log(`\n已选择: ${selected.label}`)

  // 模型名确认
  if (selected.provider !== 'claude_code') {
    const customName = await ask(`模型名称 (回车使用默认 ${selected.name}): `)
    if (customName.trim()) config.MODEL_NAME = customName.trim()
  }

  // API Key
  if (selected.provider !== 'claude_code') {
    printStep(2, '配置 API Key')
    const apiKey = await ask(`请输入 ${selected.label} API Key: `)
    if (!apiKey.trim()) {
      console.log('警告: 未输入 API Key，启动后可能无法正常工作')
    }
    config[selected.keyEnv] = apiKey.trim()

    // Base URL
    if (selected.baseUrlDefault) {
      config[selected.baseEnv] = selected.baseUrlDefault
      console.log(`API 地址已自动设置: ${selected.baseUrlDefault}`)
    } else {
      const customBase = await ask('自定义 API 地址 (回车跳过，使用官方地址): ')
      if (customBase.trim()) config[selected.baseEnv] = customBase.trim()
    }
  } else {
    // Claude Code 模式可能需要 Anthropic key 给代理用
    printStep(2, '配置 API Key (可选)')
    const apiKey = await ask('Anthropic API Key (如果用代理填这个，回车跳过): ')
    if (apiKey.trim()) {
      config.ANTHROPIC_API_KEY = apiKey.trim()
      const baseUrl = await ask('代理地址 (回车跳过): ')
      if (baseUrl.trim()) config.ANTHROPIC_BASE_URL = baseUrl.trim()
    }
  }

  // ========== 第 3 步: QQ Bot ==========
  printStep(3, '配置 QQ Bot')
  console.log('在 https://q.qq.com 创建机器人获取以下信息\n')

  const appId = await ask('QQ Bot AppID: ')
  const clientSecret = await ask('QQ Bot ClientSecret: ')
  config.QQ_APP_ID = appId.trim()
  config.QQ_CLIENT_SECRET = clientSecret.trim()

  // ========== 第 4 步: 运行参数 ==========
  printStep(4, '运行参数 (回车使用默认值)')

  const maxConcurrent = await ask('最大并发任务数 (默认 2): ')
  const timeoutSec = await ask('任务超时秒数 (默认 600): ')
  const maxTokens = await ask('模型最大输出 tokens (默认 4096): ')

  config.MAX_CONCURRENT = maxConcurrent.trim() || '2'
  config.TASK_TIMEOUT_SEC = timeoutSec.trim() || '600'
  config.MSG_MAX_LENGTH = '2000'
  config.MODEL_MAX_TOKENS = maxTokens.trim() || '4096'
  config.MODEL_TEMPERATURE = '0.7'
  config.PLATFORM = 'qq'

  // ========== 生成 .env ==========
  const now = new Date().toLocaleString('zh-CN')
  let envContent = `# AI Agent Bot 配置\n# 由 setup.mjs 生成于 ${now}\n\n`
  envContent += `# --- AI 模型 ---\n`
  envContent += `MODEL_PROVIDER=${config.MODEL_PROVIDER}\n`
  envContent += `MODEL_NAME=${config.MODEL_NAME}\n`
  envContent += `MODEL_MAX_TOKENS=${config.MODEL_MAX_TOKENS}\n`
  envContent += `MODEL_TEMPERATURE=${config.MODEL_TEMPERATURE}\n`

  if (config.ANTHROPIC_API_KEY) envContent += `ANTHROPIC_API_KEY=${config.ANTHROPIC_API_KEY}\n`
  if (config.ANTHROPIC_BASE_URL) envContent += `ANTHROPIC_BASE_URL=${config.ANTHROPIC_BASE_URL}\n`
  if (config.OPENAI_API_KEY) envContent += `OPENAI_API_KEY=${config.OPENAI_API_KEY}\n`
  if (config.OPENAI_BASE_URL) envContent += `OPENAI_BASE_URL=${config.OPENAI_BASE_URL}\n`

  envContent += `\n# --- 消息平台 ---\n`
  envContent += `PLATFORM=${config.PLATFORM}\n`
  envContent += `QQ_APP_ID=${config.QQ_APP_ID}\n`
  envContent += `QQ_CLIENT_SECRET=${config.QQ_CLIENT_SECRET}\n`

  envContent += `\n# --- 运行参数 ---\n`
  envContent += `MAX_CONCURRENT=${config.MAX_CONCURRENT}\n`
  envContent += `TASK_TIMEOUT_SEC=${config.TASK_TIMEOUT_SEC}\n`
  envContent += `MSG_MAX_LENGTH=${config.MSG_MAX_LENGTH}\n`

  writeFileSync('.env', envContent)

  // 确保必要目录存在
  for (const dir of ['workspace', 'workspace/uploads', 'workspace/output', 'workspace/session_notes', 'workspace/progress', 'workspace/prompts', 'workspace/memory', 'workspace/profiles', 'logs']) {
    mkdirSync(dir, { recursive: true })
  }

  // ========== 第 5 步: 测试连接 ==========
  printStep(5, '测试连接')
  console.log('正在验证配置...\n')

  // 测试 AI 模型 API
  if (config.MODEL_PROVIDER !== 'claude_code') {
    try {
      const apiKey = config[selected.keyEnv]
      const baseUrl = config[selected.baseEnv] || (selected.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com')

      if (selected.provider === 'anthropic') {
        // Anthropic API 测试
        const testResp = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: config.MODEL_NAME,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5,
          }),
        })
        if (testResp.ok) {
          console.log(`  ✅ AI 模型连接成功 (${config.MODEL_NAME})`)
        } else {
          const errText = await testResp.text().catch(() => '')
          console.log(`  ❌ AI 模型连接失败 (${testResp.status}): ${errText.slice(0, 100)}`)
        }
      } else {
        // OpenAI 兼容 API 测试
        const testResp = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: config.MODEL_NAME,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5,
          }),
        })
        if (testResp.ok) {
          console.log(`  ✅ AI 模型连接成功 (${config.MODEL_NAME})`)
        } else {
          const errText = await testResp.text().catch(() => '')
          console.log(`  ❌ AI 模型连接失败 (${testResp.status}): ${errText.slice(0, 100)}`)
        }
      }
    } catch (e) {
      console.log(`  ⚠️ 无法测试 AI 模型连接: ${e.message}`)
    }
  } else {
    console.log('  ℹ️ Claude Code CLI 模式，跳过 API 连接测试')
  }

  // 测试 QQ Bot 认证
  if (config.QQ_APP_ID && config.QQ_CLIENT_SECRET) {
    try {
      const qqResp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: config.QQ_APP_ID,
          clientSecret: config.QQ_CLIENT_SECRET,
        }),
      })
      if (qqResp.ok) {
        const qqData = await qqResp.json().catch(() => ({}))
        if (qqData.access_token) {
          console.log('  ✅ QQ Bot 认证成功')
        } else {
          console.log('  ❌ QQ Bot 认证失败: 未获取到 access_token')
        }
      } else {
        console.log(`  ❌ QQ Bot 认证失败 (${qqResp.status})，请检查 AppID 和 ClientSecret`)
      }
    } catch (e) {
      console.log(`  ⚠️ 无法连接 QQ 服务器: ${e.message}`)
    }
  } else {
    console.log('  ⚠️ 未配置 QQ Bot 凭据，跳过认证测试')
  }

  console.log('')

  console.log('\n=========================================')
  console.log('  配置完成!')
  console.log('=========================================')
  console.log('')
  console.log('  .env 文件已生成')
  console.log(`  模型: ${selected.label} (${config.MODEL_NAME || 'CLI'})`)
  console.log('')
  console.log('  启动方式:')
  console.log('    bun run start          # 使用 bun')
  console.log('    npm run start:node     # 使用 node')
  console.log('    pm2 start ecosystem.config.cjs  # 使用 PM2')
  console.log('')

  rl.close()
}

main().catch((e) => { console.error('安装出错:', e.message); rl.close(); process.exit(1) })
