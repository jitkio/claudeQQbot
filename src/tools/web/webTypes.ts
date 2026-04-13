/** 单条搜索结果 */
export interface SearchResult {
  position: number
  url: string
  title: string
  description: string
  source: string           // 'bing' | 'duckduckgo' | 'google' | 'baidu'
  rawContent?: string      // 可选：抓取的页面正文
}

/** 搜索响应 */
export interface SearchResponse {
  query: string
  results: SearchResult[]
  totalResults: number
  engine: string           // 实际使用的引擎
  error?: string
}

/** 页面抓取结果 */
export interface FetchResult {
  url: string
  title: string
  content: string          // 清理后的正文（markdown 或纯文本）
  wordCount: number
  fetchTimeMs: number
  error?: string
}

/** AI 抽取结果 */
export interface ExtractionResult {
  url: string
  goal: string
  extractedContent: any    // 结构化 JSON
  source: string
}

/** 搜索引擎接口 */
export interface SearchEngine {
  name: string
  search(query: string, numResults: number, options?: SearchOptions): Promise<SearchResult[]>
}

export interface SearchOptions {
  lang?: string
  country?: string
}


/** 页面可交互元素 */
export interface InteractiveElement {
  index: number
  tag: string
  text: string
  type?: string
  href?: string
  role?: string
}

/** 页面状态快照 */
export interface PageSnapshot {
  url: string
  title: string
  elements: InteractiveElement[]
  scrollPosition: {
    pixelsAbove: number
    pixelsBelow: number
    totalHeight: number
    viewportHeight: number
  }
  screenshot?: string
}

/** 浏览器动作类型 */
export type BrowserAction =
  | 'goto'
  | 'click'
  | 'type'
  | 'scroll_down'
  | 'scroll_up'
  | 'screenshot'
  | 'extract'
  | 'wait'
