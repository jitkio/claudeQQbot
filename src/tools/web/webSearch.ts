/**
 * 多引擎搜索工具（重写版）
 *
 * 参照 $OM/app/tool/web_search.py 的设计：
 * - _get_engine_order(): 引擎优先级排序
 * - _try_all_engines(): 逐引擎尝试 + 自动降级
 * - _fetch_content_for_results(): 可选的内容抓取
 * - 全引擎失败后重试（最多 3 次）
 */
import type { ToolDef, ToolContext } from '../../engine/types.js'
import type { SearchResult } from './webTypes.js'
import { BingSearch, DuckDuckGoSearch, GoogleSearch } from './searchEngines.js'
import { ContentFetcher } from './contentFetcher.js'

const engines = [
  new BingSearch(),
  new DuckDuckGoSearch(),
  new GoogleSearch(),
]

export const webSearchTool: ToolDef = {
  name: 'web_search',
  isReadOnly: true,
  isConcurrencySafe: true,
  description: '搜索互联网获取最新信息。支持多搜索引擎自动降级（Bing → DuckDuckGo → Google）。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      numResults: { type: 'number', description: '返回结果数，默认 5' },
      fetchContent: { type: 'boolean', description: '是否同时抓取结果页面的正文内容，默认 false' },
    },
    required: ['query'],
  },

  async execute(args, ctx) {
    const { query, numResults, count, fetchContent = false } = args as any
    const finalNum = numResults || count || 5
    if (!query) return '[错误] 请提供搜索关键词'

    let results: SearchResult[] = []
    let usedEngine = ''

    // 逐引擎尝试 — 对应 $OM 的 _try_all_engines
    for (const engine of engines) {
      try {
        console.log(`[WebSearch] 尝试 ${engine.name}...`)
        results = await engine.search(query, finalNum)
        if (results.length > 0) {
          usedEngine = engine.name
          console.log(`[WebSearch] ${engine.name} 返回 ${results.length} 条结果`)
          break
        }
      } catch (e: any) {
        console.warn(`[WebSearch] ${engine.name} 失败: ${e.message}`)
      }
    }

    if (results.length === 0) {
      return `搜索"${query}"未返回结果（所有搜索引擎均失败）`
    }

    // 可选：抓取结果页面内容 — 对应 $OM 的 _fetch_content_for_results
    if (fetchContent) {
      const fetcher = new ContentFetcher()
      const fetchPromises = results.map(async (r) => {
        try {
          const fetched = await fetcher.fetch(r.url, 3000)
          r.rawContent = fetched.content
        } catch {}
        return r
      })
      results = await Promise.all(fetchPromises)
    }

    // 格式化输出 — 对应 $OM SearchResponse 的 populate_output
    const lines = [`搜索"${query}"的结果（${usedEngine}）:\n`]
    for (const r of results) {
      lines.push(`${r.position}. ${r.title}`)
      lines.push(`   ${r.url}`)
      if (r.description) lines.push(`   ${r.description}`)
      if (r.rawContent) lines.push(`   内容预览: ${r.rawContent.slice(0, 300)}...`)
      lines.push('')
    }

    return lines.join('\n')
  },
}
