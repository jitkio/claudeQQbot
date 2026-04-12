import type { ToolDef, ToolContext } from '../engine/types.js'
import { ToolRegistry, createDefaultRegistry } from '../engine/toolRegistry.js'

// 避免循环依赖：动态导入 runAgent
let _runAgent: any = null
async function getRunAgent() {
  if (!_runAgent) {
    const mod = await import('../engine/agentEngine.js')
    _runAgent = mod.runAgent
  }
  return _runAgent
}

/**
 * 子 Agent 工具
 *
 * 让主 Agent 能派生独立子 Agent 执行子任务
 * 子 Agent 有自己的工具集和上下文，完成后返回结果
 *
 * 灵感来源: Claude Code 的 AgentTool
 */
export const subAgentTool: ToolDef = {
  name: 'sub_agent',
  isReadOnly: false,
  isConcurrencySafe: false,
  description: '派生一个子 Agent 执行独立子任务。子 Agent 有自己的工具集和上下文，完成后返回结果。适用于：需要多步骤处理的复杂任务、需要隔离的文件操作、需要独立搜索的调研任务。不要用于简单的单步任务。',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: '子任务描述，要清晰具体，像给同事写 brief',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: '子 Agent 可用的工具列表，如 ["bash", "web_search", "file_read"]。默认: bash, file_read, web_search, web_fetch',
      },
      timeout: {
        type: 'number',
        description: '超时毫秒数，默认 120000 (2分钟)',
      },
    },
    required: ['task'],
  },

  async execute(args: Record<string, any>, ctx: ToolContext): Promise<string> {
    const { task, tools: toolNames, timeout = 120000 } = args

    if (!task || typeof task !== 'string') {
      return '[错误] 缺少 task 参数'
    }

    const runAgent = await getRunAgent()

    // 为子 Agent 创建隔离的工具注册表
    const globalRegistry = createDefaultRegistry()
    const subRegistry = new ToolRegistry()

    // 默认工具列表（不包含 sub_agent 自身，防止无限递归）
    const allowedTools = toolNames || ['bash', 'read_file', 'web_search', 'web_fetch']
    for (const name of allowedTools) {
      if (name === 'sub_agent') continue  // 防止递归
      const tool = globalRegistry.get(name)
      if (tool) subRegistry.register(tool)
    }

    // 子 Agent 用精简的 system prompt
    const subPrompt = `你是一个专注的子 Agent。你只需要完成以下任务并返回结果，不需要寒暄或多余解释。

任务完成后，给出简洁的结果报告，包含：
1. 做了什么
2. 关键发现或结果
3. 如果有错误，说明原因`

    console.log(`[SubAgent] 启动子 Agent: ${task.slice(0, 60)}`)
    console.log(`[SubAgent] 工具: ${subRegistry.names().join(', ')}`)

    try {
      // 从当前上下文获取 modelConfig（通过 ctx 传递）
      const modelConfig = (ctx as any).modelConfig || {
        provider: 'openai' as const,
        model: 'deepseek-chat',
        apiKey: process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || '',
        baseUrl: process.env.OPENAI_BASE_URL || 'https://api.deepseek.com',
      }

      const result = await runAgent(task, {
        modelConfig,
        systemPrompt: subPrompt,
        maxTurns: 10,         // 子 Agent 限制轮数
        timeoutMs: timeout,
        workDir: ctx.workDir,
        toolTimeout: 30000,
        registry: subRegistry,
      })

      console.log(`[SubAgent] 完成: ${result.turnCount} 轮, ${result.toolCallCount} 次工具调用`)

      return `[子Agent完成] ${result.turnCount}轮, ${result.toolCallCount}次工具调用\n\n${result.content}`
    } catch (e: any) {
      console.error(`[SubAgent] 失败: ${e.message}`)
      return `[子Agent失败] ${e.message}`
    }
  },
}
