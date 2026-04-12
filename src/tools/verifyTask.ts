import type { ToolDef, ToolContext } from '../engine/types.js'
import { VERIFICATION_SYSTEM_PROMPT, buildVerificationRequest } from '../engine/planning/verificationPrompts.js'
import type { TodoList } from '../engine/planning/planningTypes.js'

/**
 * verify_task 工具的依赖注入接口
 */
export interface VerifyTaskDeps {
  /** 用来启动核验调用的回调（独立 API 调用，不带工具） */
  generate: (systemPrompt: string, userPrompt: string) => Promise<string>
  /** 获取当前会话的上下文 */
  getContext: () => {
    originalRequest: string
    todos: TodoList
    toolCallHistory: Array<{ name: string; input: any; output: string }>
  }
}

/**
 * 创建 verify_task 工具定义
 *
 * 实现思路（不依赖总纲的 sub_agent 工具）：
 * 1. 收集当前会话的：原始请求 + todo 列表 + 工具调用历史
 * 2. 用一个独立的 adapter.chat 调用（不带任何工具）发起核验
 * 3. 核验 prompt 强制要求 JSON 输出
 * 4. 解析 JSON，返回 verdict
 *
 * 与 sub_agent 的差异：sub_agent 让模型自己跑工具，verify_task 是
 * 一次性的"判官"调用，不允许它跑工具（避免再触发副作用）
 */
export function verifyTaskTool(deps: VerifyTaskDeps): ToolDef {
  return {
    name: 'verify_task',
    noPropagate: true,  // 只有主 Agent 在任务结束时核验
    description: '在你认为任务完成时调用此工具进行核验。核验工具会反向尝试找出问题，给出 PASS/PARTIAL/FAIL 判定。',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '简短说明为什么现在适合核验（如"所有 todo 项已完成"）',
        },
      },
      required: ['reason'],
    },

    isReadOnly: true,
    isConcurrencySafe: false,  // 调用本身串行，避免并发请求 API

    execute: async (_input: Record<string, any>, _ctx: ToolContext): Promise<string> => {
      const context = deps.getContext()

      if (context.todos.length === 0) {
        return '[verify_task] 当前没有待办清单，无需核验。如果任务完成请直接回复用户。'
      }

      // 渲染上下文
      const todosText = context.todos
        .map((t, i) => `${i + 1}. [${t.status}] ${t.content}`)
        .join('\n')

      const toolLogText = context.toolCallHistory
        .slice(-15)  // 只取最近 15 次调用，避免太长
        .map((c, i) => {
          const inputStr = typeof c.input === 'string'
            ? c.input.slice(0, 150)
            : JSON.stringify(c.input).slice(0, 150)
          const out = typeof c.output === 'string'
            ? c.output.slice(0, 300)
            : JSON.stringify(c.output).slice(0, 300)
          return `[${i + 1}] ${c.name}(${inputStr}) -> ${out}`
        })
        .join('\n\n')

      const userPrompt = buildVerificationRequest({
        originalRequest: context.originalRequest,
        todos: todosText,
        toolCallsLog: toolLogText || '（无工具调用记录）',
      })

      let verdict: any
      try {
        const raw = await deps.generate(VERIFICATION_SYSTEM_PROMPT, userPrompt)
        // 提取 JSON（模型可能在前后加 markdown）
        const jsonMatch = raw.match(/\{[\s\S]*\}/)
        verdict = jsonMatch
          ? JSON.parse(jsonMatch[0])
          : { verdict: 'PARTIAL', summary: raw.slice(0, 200), checks: [] }
      } catch (e: any) {
        return `[verify_task] 核验调用失败：${e.message}。请基于现有信息直接给用户回复。`
      }

      // 渲染结果
      const v = verdict.verdict || 'PARTIAL'
      const symbol = v === 'PASS' ? 'PASS' : v === 'PARTIAL' ? 'PARTIAL' : 'FAIL'
      let result = `[${symbol}] 核验结果: ${v}\n\n`
      result += `${verdict.summary || '(无总结)'}\n\n`

      if (Array.isArray(verdict.checks) && verdict.checks.length > 0) {
        result += '检查项:\n'
        for (const c of verdict.checks) {
          const sym = c.passed ? 'OK' : 'FAIL'
          result += `  [${sym}] ${c.item}\n    证据: ${c.evidence?.slice(0, 200) || '(无)'}\n`
        }
      }

      if (v === 'FAIL' || v === 'PARTIAL') {
        result += '\n注意: 核验未通过。请根据上面的失败项继续工作，不要在这一轮就给用户写"已完成"的总结。'
      }

      return result
    },
  }
}
