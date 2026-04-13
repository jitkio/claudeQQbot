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

// 规划系统工具
import { todoWriteTool } from '../tools/todoWrite.js'
import { enterPlanModeTool } from '../tools/enterPlanMode.js'
import { exitPlanModeTool } from '../tools/exitPlanMode.js'
import { verifyTaskTool } from '../tools/verifyTask.js'
import type { TodoStore } from './planning/todoStore.js'
import type { PermissionModeManager } from './permission/permissionMode.js'
import type { UserConfirmBridge } from './permission/userConfirmBridge.js'
import type { TodoList } from './planning/planningTypes.js'

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

/** 创建包含所有内置工具的注册表（无规划系统，向后兼容） */
export function createDefaultRegistry(): ToolRegistry

/** 创建包含所有内置工具 + 规划系统工具的注册表 */
export function createDefaultRegistry(planningDeps: PlanningDeps): ToolRegistry

export function createDefaultRegistry(planningDeps?: PlanningDeps): ToolRegistry {
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

  return registry
}
