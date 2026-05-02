import type { ToolDef } from './types.js'
import { bashTool } from '../tools/bash.js'
import { fileReadTool } from '../tools/fileRead.js'
import { fileWriteTool } from '../tools/fileWrite.js'
import { fileEditTool } from '../tools/fileEdit.js'
import { globTool } from '../tools/glob.js'
import { grepTool } from '../tools/grep.js'
import { webSearchTool } from '../tools/web/webSearch.js'
import { webFetchTool } from '../tools/web/webFetch.js'
import { contentExtractTool } from '../tools/web/contentExtractor.js'
import { pythonReplTool } from '../tools/pythonRepl.js'
import { subAgentTool } from '../tools/subAgent.js'
import { browserActionTool } from '../tools/web/browserAction.js'

// 规划系统工具
import { todoWriteTool } from '../tools/todoWrite.js'
import { enterPlanModeTool } from '../tools/enterPlanMode.js'
import { exitPlanModeTool } from '../tools/exitPlanMode.js'
import { verifyTaskTool } from '../tools/verifyTask.js'
import type { TodoStore } from './planning/todoStore.js'
import type { PermissionModeManager } from './permission/permissionMode.js'
import type { UserConfirmBridge } from './permission/userConfirmBridge.js'
import type { TodoList } from './planning/planningTypes.js'

// 后台任务系统工具
import { taskCreateTool, type TaskSessionContextGetter } from '../tools/taskCreate.js'
import { taskGetTool } from '../tools/taskGet.js'
import { taskListTool } from '../tools/taskList.js'
import { taskUpdateTool } from '../tools/taskUpdate.js'
import { taskStopTool } from '../tools/taskStop.js'
import { taskOutputTool } from '../tools/taskOutput.js'
import { reminderTools } from '../tools/reminderTools.js'
import type { TaskManager } from './tasks/taskManager.js'

// MCP（可选）
import type { McpManager } from '../mcp/manager.js'

/**
 * 工具注册表
 * 管理所有可用工具，提供注册、查找、列表功能
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDef>()

  register(tool: ToolDef) {
    this.tools.set(tool.name, tool)
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name)
  }

  getAll(): ToolDef[] {
    return Array.from(this.tools.values())
  }

  names(): string[] {
    return Array.from(this.tools.keys())
  }

  /**
   * 从 MCP manager 批量注册所有当前就绪的 MCP 工具
   */
  registerFromMcp(manager: McpManager): number {
    const mcpTools = manager.getAllTools()
    let registered = 0
    let skipped = 0
    for (const tool of mcpTools) {
      if (this.tools.has(tool.name)) {
        console.warn(
          `[ToolRegistry] MCP 工具 ${tool.name} 与已有工具重名，跳过注册`,
        )
        skipped++
        continue
      }
      this.tools.set(tool.name, tool)
      registered++
    }
    if (registered > 0 || skipped > 0) {
      console.log(`[ToolRegistry] MCP 工具注册: ${registered} 个成功${skipped > 0 ? `, ${skipped} 个跳过` : ''}`)
    }
    return registered
  }
}

/**
 * 规划系统工具所需的外部依赖
 */
export interface PlanningDeps {
  todoStore: TodoStore
  modeManager: PermissionModeManager
  confirmBridge: UserConfirmBridge
  /** 获取当前会话上下文（由 taskQueue 在执行时绑定） */
  getSessionContext: () => {
    sessionKey: string
    userId: string
    originalRequest: string
    toolHistory: Array<{ name: string; input: any; output: string }>
  }
  /** 用来给 verify_task 注入"无工具调用模型" */
  generateForVerification: (systemPrompt: string, userPrompt: string) => Promise<string>
}

/**
 * 后台任务系统工具所需的外部依赖
 *
 * 和 PlanningDeps 分开定义是为了让两个子系统独立注册：
 * 可以只注册规划系统、只注册任务系统、或两个都注册。
 */
export interface TaskDeps {
  taskManager: TaskManager
  /** 获取当前任务的完整会话上下文（task_create 要用） */
  getTaskSessionContext: TaskSessionContextGetter
}

/** 创建包含所有内置工具的注册表（无规划/任务系统，向后兼容） */
export function createDefaultRegistry(): ToolRegistry

/** 创建包含所有内置工具 + 规划系统工具的注册表 */
export function createDefaultRegistry(planningDeps: PlanningDeps): ToolRegistry

/** 创建包含内置工具 + 规划系统 + 后台任务系统的注册表 */
export function createDefaultRegistry(
  planningDeps: PlanningDeps,
  taskDeps: TaskDeps,
): ToolRegistry

export function createDefaultRegistry(
  planningDeps?: PlanningDeps,
  taskDeps?: TaskDeps,
): ToolRegistry {
  const registry = new ToolRegistry()

  // 原有内置工具
  registry.register(bashTool)
  registry.register(fileReadTool)
  registry.register(fileWriteTool)
  registry.register(fileEditTool)
  registry.register(globTool)
  registry.register(grepTool)
  registry.register(webSearchTool)
  registry.register(webFetchTool)
  registry.register(contentExtractTool)
  registry.register(pythonReplTool)
  registry.register(subAgentTool)
  registry.register(browserActionTool)

  // 提醒系统工具 (Phase 2)
  for (const t of reminderTools) registry.register(t)

  // 规划系统工具（需要外部依赖才能注册）
  if (planningDeps) {
    const { todoStore, modeManager, confirmBridge, getSessionContext, generateForVerification } = planningDeps

    registry.register(todoWriteTool(
      todoStore,
      () => getSessionContext().sessionKey,
    ))

    registry.register(enterPlanModeTool(
      modeManager,
      () => getSessionContext().sessionKey,
    ))

    registry.register(exitPlanModeTool(
      modeManager,
      confirmBridge,
      () => getSessionContext().sessionKey,
      () => getSessionContext().userId,
    ))

    registry.register(verifyTaskTool({
      generate: generateForVerification,
      getContext: () => {
        const ctx = getSessionContext()
        return {
          originalRequest: ctx.originalRequest,
          todos: todoStore.get(ctx.sessionKey),
          toolCallHistory: ctx.toolHistory,
        }
      },
    }))
  }

  // 后台任务系统工具（需要外部依赖才能注册）
  if (taskDeps) {
    const { taskManager, getTaskSessionContext } = taskDeps

    // 一个复用的"取用户 ID"回调，给只需要 userId 的工具用
    const getUserId = () => getTaskSessionContext().userId

    registry.register(taskCreateTool(taskManager, getTaskSessionContext))
    registry.register(taskGetTool(taskManager, getUserId))
    registry.register(taskListTool(taskManager, getUserId))
    registry.register(taskUpdateTool(taskManager, getUserId))
    registry.register(taskStopTool(taskManager, getUserId))
    registry.register(taskOutputTool(taskManager, getUserId))
  }

  return registry
}