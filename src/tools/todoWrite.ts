import type { ToolDef, ToolContext } from '../engine/types.js'
import type { TodoStore } from '../engine/planning/todoStore.js'
import { shouldNudgeVerification, renderTodoWriteResult } from '../engine/planning/todoNudge.js'
import type { TodoList, TodoWriteResult } from '../engine/planning/planningTypes.js'
import type { TodoReminderTracker } from '../engine/planning/todoReminder.js'

/**
 * TodoWrite 工具的使用规则 prompt
 *
 * 缩减到适合 QQ Bot 场景
 */
export const TODO_WRITE_PROMPT = `用这个工具维护当前对话的待办清单。让你能跟踪进度、组织复杂任务、并向用户证明你认真对待了请求。

## 何时使用

主动使用以下场景：
1. 复杂多步任务 —— 需要 3 个以上独立步骤
2. 用户列了多件事 —— 用户用编号或逗号列出了多件事（"帮我搜 X、整理 Y、再 Z"）
3. 收到新指令时 —— 立即把用户需求转成 todo 项
4. 开始一个任务前 —— 把它标 in_progress（必须先标后做）
5. 完成一个任务后 —— 立即标 completed，发现新任务则追加

## 何时不用

跳过这个工具的场景：
1. 单步、琐碎的任务（"帮我查个天气"）
2. 纯对话（"你好"、"谢谢"）
3. 单次问答（"Python 怎么写 hello world"）

## 状态规则

三种状态：
- pending: 还没开始
- in_progress: 正在做（任何时候只能有 1 项）
- completed: 已完成

重要约束：
- 任何时候只能恰好有 1 项 in_progress
- 完成后立即标 completed，不要批量补
- 任务被阻塞或部分完成时，保持 in_progress，不能标 completed
- 只有真正完整完成才能标 completed

## 任务描述格式

每项必须有两种形式：
- content: 祈使句 —— "搜索 Python 教程"
- activeForm: 进行时 —— "正在搜索 Python 教程"

## 例子

### 应该用：
用户："帮我搜一下 React 18 的新特性，整理成简报，发给我"
你应该建：
1. {content:"搜索 React 18 新特性", activeForm:"正在搜索 React 18 新特性", status:"in_progress"}
2. {content:"整理成简报", activeForm:"正在整理简报", status:"pending"}
3. {content:"发送给用户", activeForm:"正在发送", status:"pending"}

### 不该用：
用户："今天北京天气怎么样？"
直接调 web_search，不需要 todo。`

/**
 * TodoWrite 工具执行上下文扩展
 * agentEngine 负责将这些字段注入到 ToolContext
 */
export interface TodoWriteContext extends ToolContext {
  todoReminderTracker?: TodoReminderTracker
  isSubAgent?: boolean
}

/**
 * 创建 TodoWrite 工具定义
 */
export function todoWriteTool(store: TodoStore, getSessionKey: () => string): ToolDef {
  return {
    name: 'todo_write',
    description: '更新当前对话的待办清单。用来跟踪复杂多步任务的进度。每次调用传入完整的 todo 列表（覆盖式）。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整的待办列表（覆盖式写入，每次传完整列表）',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '祈使句描述，如"搜索 Python 教程"' },
              activeForm: { type: 'string', description: '进行时描述，如"正在搜索 Python 教程"' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '状态' },
            },
            required: ['content', 'activeForm', 'status'],
          },
        },
      },
      required: ['todos'],
    },

    // TodoWrite 是无副作用的状态记录 → 标记为可并发（与编排专项配合）
    isReadOnly: true,
    isConcurrencySafe: true,

    execute: async (input: Record<string, any>, ctx: ToolContext): Promise<string> => {
      const todos = input.todos as TodoList
      const sessionKey = getSessionKey()
      const oldTodos = store.get(sessionKey)

      // 校验
      const validation = store.validate(todos)
      if (!validation.valid) {
        return `[todo_write 错误] ${validation.reason}`
      }

      // 写入（store 内部会处理"全部完成→清空"）
      store.set(sessionKey, todos)

      // 通知 reminder tracker
      const extCtx = ctx as TodoWriteContext
      extCtx.todoReminderTracker?.onTodoWriteCalled()

      // 判定是否需要 verification nudge
      // 注意：这里检查的是"调用方传入的 newTodos"是否全部完成
      // 而不是"store 写入后的状态"（写入后会清空）
      const result: TodoWriteResult = {
        oldTodos,
        newTodos: todos,
        verificationNudgeNeeded: shouldNudgeVerification(todos, !!extCtx.isSubAgent),
      }

      return renderTodoWriteResult(result)
    },
  }
}
