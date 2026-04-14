/**
 * MCP 工具桥接
 *
 * 把一个 MCP Client 暴露的所有工具转换成 ToolDef 数组，
 * 让它们能像内置工具一样被 ToolRegistry 注册、被 agent 调用。
 *
 * 关键职责：
 *   1. 命名空间前缀：alias__toolName，防止多个 MCP 服务器工具重名
 *   2. 把 MCP inputSchema 原样透传给 ToolDef.parameters（LLM 直接认）
 *   3. 根据 annotations.readOnlyHint 决定 isReadOnly/isConcurrencySafe
 *   4. 把 MCP CallToolResult 的 content 块转成字符串供 ToolDef 返回
 *   5. 错误转译：MCP 的 isError=true 或 JSON-RPC error 都统一成 "[错误] xxx"
 */

import type { ToolDef } from '../engine/types.js'
import type { McpClient } from './client.js'
import type { McpTool, CallToolResult, McpContentBlock } from './types.js'

// ============================================================
// 常量
// ============================================================

/** 工具名前缀分隔符——两个下划线，降低和合法名字冲突的概率 */
const NAMESPACE_SEP = '__'

/** 命名空间前缀上限字符数，防止 provider 对工具名长度有限制（OpenAI/Claude 都是 64） */
const MAX_TOOL_NAME_LENGTH = 60

/** MCP 工具默认超时（ms）——被 server 配置的 callTimeoutMs 覆盖 */
const DEFAULT_MCP_CALL_TIMEOUT_MS = 60000

// ============================================================
// 主入口
// ============================================================

export interface BridgeOptions {
  /** 命名空间前缀（通常就是 server alias） */
  namespace: string
  /** 单次 MCP 调用的超时 */
  callTimeoutMs?: number
}

/**
 * 从一个 McpClient 构造出所有 ToolDef
 *
 * 调用者负责先 client.listTools() 拿到 tool 列表，然后传进来——
 * 这里不主动拉取，让调用者能自己处理错误和缓存。
 */
export function bridgeToToolDefs(
  client: McpClient,
  mcpTools: McpTool[],
  options: BridgeOptions,
): ToolDef[] {
  const defs: ToolDef[] = []
  for (const tool of mcpTools) {
    try {
      defs.push(bridgeSingleTool(client, tool, options))
    } catch (e: any) {
      console.warn(
        `[MCP Bridge] 工具 ${options.namespace}/${tool.name} 桥接失败: ${e.message}`,
      )
    }
  }
  return defs
}

// ============================================================
// 单工具转换
// ============================================================

function bridgeSingleTool(
  client: McpClient,
  tool: McpTool,
  options: BridgeOptions,
): ToolDef {
  if (!tool.name) throw new Error('MCP 工具缺少 name 字段')

  const fullName = makeNamespacedName(options.namespace, tool.name)
  const readOnly = Boolean(tool.annotations?.readOnlyHint)
  const destructive = Boolean(tool.annotations?.destructiveHint)

  // 描述里追加 MCP 身份和可选的 hint，让模型清楚这是远程工具
  const description = buildDescription(tool, options.namespace, readOnly, destructive)

  // inputSchema 可能为空或不完整——补一个兜底空 schema
  const parameters = normalizeSchema(tool.inputSchema)

  return {
    name: fullName,
    description,
    parameters,

    // 只读判断：如果 MCP server 明确声明 readOnlyHint=true，视为只读
    // 否则保守视为非只读（走正常的权限审查链路）
    isReadOnly: readOnly,

    // 并发安全：只读 + 非破坏性才能并发
    isConcurrencySafe: readOnly && !destructive,

    async execute(args, ctx) {
      // 客户端状态检查
      if (client.getState() !== 'ready') {
        return `[错误] MCP 服务器 ${options.namespace} 未就绪（当前状态: ${client.getState()}），请检查配置和日志`
      }

      // abortSignal 级联：Bot 主循环取消时，快速失败而不是等 MCP 超时
      if (ctx.abortSignal?.aborted) {
        return `[错误] 工具 ${fullName} 调用已被取消`
      }

      let result: CallToolResult
      try {
        result = await client.callTool(
          tool.name,                // 发给 MCP 的是原始工具名（不带前缀）
          (args ?? {}) as Record<string, unknown>,
          options.callTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
        )
      } catch (e: any) {
        return `[错误] MCP 调用失败 (${fullName}): ${e.message ?? String(e)}`
      }

      // 转译结果
      const text = contentBlocksToString(result.content)

      if (result.isError) {
        return `[错误] MCP 工具报告失败: ${text}`
      }

      // 结构化输出（2025-06 引入）单独附加一段，方便模型看到
      if (result.structuredContent !== undefined) {
        const structured = JSON.stringify(result.structuredContent, null, 2)
        return text ? `${text}\n\n[结构化输出]\n${structured}` : `[结构化输出]\n${structured}`
      }

      return text || '(MCP 工具返回空)'
    },
  }
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 构造带命名空间的工具名
 *
 * 规则：
 *   1. 统一为 <alias>__<toolName>
 *   2. 非法字符替换为下划线（保留字母、数字、下划线）
 *   3. 超长截断
 */
function makeNamespacedName(namespace: string, toolName: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_')
  let full = `${clean(namespace)}${NAMESPACE_SEP}${clean(toolName)}`
  if (full.length > MAX_TOOL_NAME_LENGTH) {
    // 保全原始 toolName 可读性，从 namespace 中间截
    const toolPart = clean(toolName)
    const nsBudget = MAX_TOOL_NAME_LENGTH - toolPart.length - NAMESPACE_SEP.length
    if (nsBudget >= 4) {
      const nsClean = clean(namespace)
      const head = nsClean.slice(0, Math.max(3, nsBudget - 3))
      full = `${head}${NAMESPACE_SEP}${toolPart}`
    } else {
      // toolName 本身就快占满了，直接暴力截断
      full = full.slice(0, MAX_TOOL_NAME_LENGTH)
    }
  }
  return full
}

/**
 * 把 MCP content 块数组转换成纯字符串
 *
 * 处理策略：
 *   - text: 直接用文本
 *   - image: 当前引擎不支持把图片结果喂回模型，只记录元信息（路径/大小）
 *   - audio: 同上
 *   - resource: 优先 text 内容，blob 只记录元信息
 *
 * 未来如果接入多模态，可以改成返回 MessageContentPart[]
 */
function contentBlocksToString(blocks: McpContentBlock[] | undefined): string {
  if (!blocks || blocks.length === 0) return ''

  const parts: string[] = []
  for (const b of blocks) {
    if (b.type === 'text') {
      parts.push(b.text)
      continue
    }
    if (b.type === 'image') {
      const size = typeof b.data === 'string' ? b.data.length : 0
      parts.push(`[图片: ${b.mimeType}, base64 长度 ${size}（当前不支持把图像结果传回模型）]`)
      continue
    }
    if (b.type === 'audio') {
      parts.push(`[音频: ${b.mimeType}（当前不支持）]`)
      continue
    }
    if (b.type === 'resource') {
      if (b.resource.text) {
        parts.push(`[资源: ${b.resource.uri}]\n${b.resource.text}`)
      } else if (b.resource.blob) {
        parts.push(`[资源: ${b.resource.uri}, 二进制, ${b.resource.blob.length} 字节 base64]`)
      } else {
        parts.push(`[资源: ${b.resource.uri}]`)
      }
      continue
    }
    // 未知块类型
    parts.push(`[未知 MCP 内容块: ${JSON.stringify(b).slice(0, 200)}]`)
  }
  return parts.join('\n\n')
}

function buildDescription(
  tool: McpTool,
  namespace: string,
  readOnly: boolean,
  destructive: boolean,
): string {
  const parts: string[] = []
  parts.push(`[MCP:${namespace}] ${tool.description ?? '（无描述）'}`)
  const hints: string[] = []
  if (readOnly) hints.push('只读')
  if (destructive) hints.push('⚠ 破坏性操作')
  if (tool.annotations?.idempotentHint) hints.push('幂等')
  if (tool.annotations?.openWorldHint) hints.push('影响外部世界')
  if (hints.length > 0) parts.push(`(${hints.join(', ')})`)
  return parts.join(' ')
}

/** 兜底的空 schema，防止某些 MCP 服务器返回 null inputSchema */
function normalizeSchema(schema: McpTool['inputSchema'] | undefined): Record<string, any> {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} }
  }
  if (schema.type !== 'object') {
    return { type: 'object', properties: {} }
  }
  return {
    type: 'object',
    properties: schema.properties ?? {},
    ...(schema.required ? { required: schema.required } : {}),
  }
}