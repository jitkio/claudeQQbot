import type { ToolDef } from '../engine/types.js'
import type { TaskManager } from '../engine/tasks/taskManager.js'
import { DEFAULT_TASK_MAX_DURATION_MS, HARD_TASK_MAX_DURATION_MS } from '../engine/tasks/taskTypes.js'
import type { ModelConfig } from '../engine/types.js'
import type { PermissionContext } from '../engine/permission/permissionTypes.js'

/**
 * 提供给 task_create 工具的会话上下文获取器
 * 由 taskQueue.ts 在执行任务时绑定
 */
export interface TaskSessionContextGetter {
  (): {
    userId: string
    sessionKey: string
    notifyTarget: { kind: 'c2c' | 'group'; targetId: string }
    modelConfig: ModelConfig
    permissionContext: PermissionContext
  }
}

export function taskCreateTool(
  manager: TaskManager,
  getSessionContext: TaskSessionContextGetter,
): ToolDef {
  return {
    name: 'task_create',
    isReadOnly: false,
    isConcurrencySafe: false,
    description: [
      '创建一个后台任务。适用于预计需要 1 分钟以上的长任务，比如：',
      '  - 批量爬取网页 / 处理大量数据',
      '  - 生成长报告、整理大量文件',
      '  - 需要多步骤等待的流水线（如构建、测试）',
      '任务会在独立子 Agent 里异步运行。你立即拿到 task_id，任务完成时用户会在下次发消息时看到提醒。',
      '',
      '何时用:',
      '  - 任务预计超过 1 分钟，且你不希望让用户等在对话里',
      '  - 用户明确说"后台跑"、"慢慢弄"、"完了告诉我"',
      '',
      '何时不用:',
      '  - 快速问答（几秒就能回答的问题）',
      '  - 只需要几步就能完成的简单工具调用',
      '  - 需要用户在任务执行过程中回答问题的场景（后台任务看不到用户）',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: '给后台 Agent 的任务描述。必须完整、具体、自包含——后台 Agent 看不到当前对话历史，只能看到这段文字。',
        },
        title: {
          type: 'string',
          description: '任务的简短标题（10 字以内），用于用户在 task_list 里快速识别',
        },
        max_duration_minutes: {
          type: 'number',
          description: `最大运行时长（分钟），默认 ${DEFAULT_TASK_MAX_DURATION_MS / 60000}，上限 ${HARD_TASK_MAX_DURATION_MS / 60000}`,
        },
      },
      required: ['description'],
    },
    async execute(args, _ctx) {
      const description = String(args.description ?? '').trim()
      if (!description) return '[错误] description 不能为空'
      if (description.length < 10) {
        return '[错误] description 太短——后台 Agent 看不到对话历史，请写完整自包含的任务说明'
      }

      const title = args.title ? String(args.title).slice(0, 30) : undefined
      const maxMinutes = typeof args.max_duration_minutes === 'number'
        ? args.max_duration_minutes
        : undefined
      const maxDurationMs = maxMinutes ? maxMinutes * 60000 : undefined

      const sc = getSessionContext()

      let record
      try {
        record = manager.create({
          userId: sc.userId,
          sessionKey: sc.sessionKey,
          notifyTarget: sc.notifyTarget,
          description,
          title,
          maxDurationMs,
          modelConfig: sc.modelConfig,
          permissionContext: sc.permissionContext,
        })
      } catch (e: any) {
        return `[错误] 创建任务失败: ${e.message}`
      }

      const statusText = record.status === 'pending'
        ? '排队中（当前运行任务已达上限，完成一个后会自动启动）'
        : '已开始运行'

      return [
        `✅ 后台任务已创建`,
        `  任务 ID: ${record.id}`,
        `  标题: ${record.title ?? '(无)'}`,
        `  状态: ${statusText}`,
        `  最长运行: ${Math.round(record.maxDurationMs / 60000)} 分钟`,
        ``,
        `任务会在后台独立运行，完成时用户下次发消息会收到提醒。`,
        `查询进度可用 task_get ${record.id}，停止可用 task_stop ${record.id}。`,
      ].join('\n')
    },
  }
}