import type { ToolDef, ToolContext } from '../engine/types.js'
import type { PermissionModeManager } from '../engine/permission/permissionMode.js'

/**
 * EnterPlanMode 的判定 prompt
 *
 * 简化版（去掉编辑器特有的例子）
 */
export const ENTER_PLAN_MODE_PROMPT = `当任务真正存在"该怎么做"的歧义、且让用户先确认方向能避免大量返工时，使用这个工具进入规划模式。

进入规划模式后，你将：
1. 使用只读工具（grep、glob、file_read、web_search）探索现状
2. 设计具体的实施方案
3. 用 exit_plan_mode 把方案提交给用户审批
4. 用户批准后，模式自动切回 default，你可以开始动手

## 何时使用

满足以下任一条件就建议进入：

1. 多种合理方案 —— 任务可以用几种不同方式完成，选择会显著影响结果
   例：用户说"帮我做一个数据备份方案" —— 可以是 cron + tar、也可以是 rsync、也可以是 git

2. 大改动需要先得到认可 —— 任务会改动多个文件或大量数据，先让用户看一眼方案能避免返工
   例：用户说"整理一下我的 workspace 目录" —— 先列出"准备删什么、移动什么"

3. 需求模糊 —— 你需要先探索一下才能理解全貌
   例：用户说"帮我看看哪些笔记可以删了" —— 你不知道用户的删除标准

## 何时不使用

- 单步任务："帮我搜个新闻"
- 用户已经给了非常具体的指令："把 a.txt 第 5 行改成 hello"
- 用户明确说"咱们开始做 X"或"赶紧开干" —— 用户想立刻看到行动
- 纯查询/解释类问题："Python 装饰器是什么"

## 重要

- 进入规划模式后，你不能调用任何写工具（file_write、file_edit、bash 写命令）
- 系统会强制阻止你 —— 请用 grep/glob/file_read/web_search/web_fetch/bash 只读命令探索
- 探索完成后必须调用 exit_plan_mode 把方案提交给用户审批，不要在 plan mode 里写最终答案`

/**
 * 创建 EnterPlanMode 工具定义
 */
export function enterPlanModeTool(
  modeManager: PermissionModeManager,
  getSessionKey: () => string,
): ToolDef {
  return {
    name: 'enter_plan_mode',
    noPropagate: true,  // 子 Agent 不应该改全局模式
    description: '进入规划模式：只能用只读工具探索，不能写。完成探索后用 exit_plan_mode 提交方案。',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '简短说明为什么需要进入规划模式',
        },
      },
      required: ['reason'],
    },

    isReadOnly: true,
    isConcurrencySafe: false,  // 模式切换是状态变更，不能并发

    execute: async (_input: Record<string, any>, _ctx: ToolContext): Promise<string> => {
      const sessionKey = getSessionKey()

      // 检查当前是否已经在 plan 模式
      const currentMode = modeManager.getMode(sessionKey)
      if (currentMode === 'plan') {
        return '已经在规划模式中了。请继续用只读工具探索，然后用 exit_plan_mode 提交方案。'
      }

      // 切换到 plan 模式（复用权限专项的 mode 切换）
      modeManager.setMode(sessionKey, 'plan')

      // 工具回执里强制注入工作流指令
      return `已进入规划模式。

接下来你应该：
1. 用 grep / glob / file_read / web_search / bash(只读命令) 充分探索
2. 理解现有结构和约束
3. 设计具体方案
4. 调用 exit_plan_mode 把方案提交给用户审批

在规划模式下：
- 不要写文件（file_write/file_edit 会被拒绝）
- 不要执行任何会改变状态的 bash 命令（rm/mv/cp/mkdir 等会被拒绝）
- 这是只读探索阶段，规划方案直到 exit_plan_mode 才提交`
    },
  }
}
