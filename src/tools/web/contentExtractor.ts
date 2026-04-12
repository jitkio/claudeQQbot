/**
 * AI 智能内容抽取工具
 *
 * 参照 $OM/app/tool/browser_use_tool.py 第 374-444 行的 extract_content 实现：
 * 1. 先抓取页面内容（用 ContentFetcher）
 * 2. 构造 prompt 让模型根据 goal 提取信息
 * 3. 返回结构化结果
 *
 * 区别：$OM 在 extract_content 内部直接调 LLM，
 * 我们让 Agent Engine 的模型自己处理（把抓取内容返回给 Agent 循环）
 */
import type { ToolDef, ToolContext } from '../../engine/types.js'
import { ContentFetcher } from './contentFetcher.js'

export const contentExtractTool: ToolDef = {
  name: 'web_extract',
  isReadOnly: true,
  isConcurrencySafe: true,
  description: '抓取网页并提取指定信息。输入 URL 和提取目标，返回清洗后的页面内容。比 web_fetch 更智能：自动清理广告/导航/页脚，优先提取正文区域，支持 JS 渲染页面。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的网页 URL' },
      goal: { type: 'string', description: '提取目标，描述你想从页面中获取什么信息，比如"提取文章标题和发布日期"、"获取产品价格和规格"' },
      maxLength: { type: 'number', description: '返回内容的最大字符数，默认 8000' },
    },
    required: ['url'],
  },

  async execute(args, ctx) {
    const { url, goal, maxLength = 8000 } = args
    if (!url) return '[错误] 请提供 URL'

    const fetcher = new ContentFetcher()
    const result = await fetcher.fetch(url, maxLength)

    if (result.error) {
      return `[抓取失败] ${result.error}`
    }

    // 构造返回信息：让 Agent Engine 中的模型根据 goal 自行分析
    let output = `--- 网页内容 ---\n`
    output += `URL: ${result.url}\n`
    output += `标题: ${result.title}\n`
    output += `字数: ${result.wordCount}\n`
    output += `抓取耗时: ${result.fetchTimeMs}ms\n`
    if (goal) {
      output += `\n提取目标: ${goal}\n`
      output += `请根据以下内容提取所需信息：\n\n`
    }
    output += `--- 正文开始 ---\n${result.content}\n--- 正文结束 ---`

    return output
  },
}
