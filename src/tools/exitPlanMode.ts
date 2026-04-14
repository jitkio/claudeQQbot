import type { ToolDef, ToolContext } from '../engine/types.js'
import type { PermissionModeManager } from '../engine/permission/permissionMode.js'
import type { UserConfirmBridge } from '../engine/permission/userConfirmBridge.js'

/**
 * ExitPlanMode 工具 —— 提交方案，请求用户审批
 *
 * 参考: $CC/tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts 第 77-145 行 schema + 第 243+ 行 call
 */
export function exitPlanModeTool(
  modeManager: PermissionModeManager,
  confirmBridge: UserConfirmBridge,
  getSessionKey: () => string,
  getUserId: () => string,
): ToolDef {
  return {
    name: 'exit_plan_mode',
    noPropagate: true,  // 子 Agent 不应该改全局模式
    description: '把规划好的方案提交给用户审批。审批通过后退出规划模式开始实施。',
    parameters: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description: '要提交的方案文本。应该包含：要做什么、分几步、每步具体做什么、预期产出。',
        },
      },
      required: ['plan'],
    },

    isReadOnly: false,    // 它会改 mode，所以不算只读
    isConcurrencySafe: false,

    execute: async (input: Record<string, any>, _ctx: ToolContext): Promise<string> => {
      const plan = input.plan as string
      const sessionKey = getSessionKey()
      const userId = getUserId()

      // 当前必须在 plan mode 中
      const currentMode = modeManager.getMode(sessionKey)
      if (currentMode !== 'plan') {
        return `[exit_plan_mode 错误] 当前不在规划模式（mode=${currentMode}），无需退出`
      }

      // 通过 UserConfirmBridge 推送方案给用户
      // 复用权限专项的二次确认机制
      const accepted = await confirmBridge.askConfirm({
        userId,
        command: '提交规划方案',
        reason: `Agent 已生成方案，请审批：\n\n${plan}\n\n通过后 Agent 将按方案执行`,
        warnings: [],
        timeoutMs: 300000,  // 方案审批给 5 分钟
      })

      if (!accepted) {
        return '[方案被拒绝] 用户没有批准这个方案。请进一步完善后重新提交，或继续在规划模式中探索。'
      }

      // 用户批准 → 切回 default 模式
      modeManager.setMode(sessionKey, 'default')

      return `方案已被用户批准。已退出规划模式（切换到 default）。现在可以开始实施方案。

请按方案中的步骤逐项执行。建议先调用 todo_write 把方案转成待办清单。`
    },
  }
}
