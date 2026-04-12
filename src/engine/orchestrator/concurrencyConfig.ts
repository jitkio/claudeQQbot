/**
 * 单个批次内最多同时跑多少个并发工具
 * 参照 $CC/services/tools/toolOrchestration.ts 第 8-12 行：
 *   默认 10，环境变量 CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY 可覆盖
 *
 * QQ Bot 场景：web_search 会受搜索 API 限流影响，适合降低到 5
 */
export function getMaxConcurrency(): number {
  const env = parseInt(process.env.AGENTFORGE_MAX_TOOL_CONCURRENCY || '', 10)
  return Number.isFinite(env) && env > 0 ? env : 5
}

/** 单个工具的默认执行超时 */
export function getDefaultToolTimeout(): number {
  return parseInt(process.env.AGENTFORGE_TOOL_TIMEOUT || '', 10) || 60000
}

/** 一轮 runTools 的整体超时（所有批次加起来） */
export function getOverallToolsTimeout(): number {
  return parseInt(process.env.AGENTFORGE_TOOLS_TOTAL_TIMEOUT || '', 10) || 180000
}
