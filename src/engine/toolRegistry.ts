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

/** 创建包含所有内置工具的注册表 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
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
  return registry
}
