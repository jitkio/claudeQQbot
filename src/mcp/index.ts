/**
 * MCP 模块入口（barrel 导出）
 *
 * 外部代码应该只从这里导入 MCP 相关 API，不要直接从子文件导入。
 */
export { McpManager, getGlobalMcpManager } from './manager.js'
export { McpClient } from './client.js'
export { loadMcpConfig, describeMcpConfig, type McpConfig } from './config.js'
export type {
  McpServerConfig,
  StdioServerConfig,
  SseServerConfig,
  McpTool,
  CallToolResult,
  McpContentBlock,
} from './types.js'