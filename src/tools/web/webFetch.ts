/**
 * 网页抓取工具（重写版）
 *
 * 替代原有的 src/tools/webFetch.ts，使用新的 ContentFetcher。
 * 自动清理广告、导航栏等噪音，返回干净的正文。
 */
import type { ToolDef } from '../../engine/types.js'
import { ContentFetcher } from './contentFetcher.js'

interface WebFetchArgs {
  url: string
  maxLength?: number
}

export const webFetchTool: ToolDef = {
  name: 'web_fetch',
  isReadOnly: true,
  isConcurrencySafe: true,
  description: '抓取指定 URL 的网页内容。自动清理广告、导航栏等噪音，返回干净的正文。支持 JS 渲染页面。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的网页 URL' },
      maxLength: { type: 'number', description: '最大返回字符数，默认 10000' },
    },
    required: ['url'],
  },
  async execute(args, ctx) {
    const { url, maxLength = 10000 } = args as WebFetchArgs
    if (!url) return '[错误] 请提供 URL'

    const fetcher = new ContentFetcher()
    const result = await fetcher.fetch(url, maxLength)

    if (result.error) return `[抓取失败] ${result.error}`
    return `[${result.title}]\n${result.content}`
  },
}
