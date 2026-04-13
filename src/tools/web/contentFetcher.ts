/**
 * 智能内容抓取器
 *
 * 参照 OpenManus 的两级抓取策略：
 * - $OM/app/tool/web_search.py 第 106-153 行 WebContentFetcher（轻量级）
 * - $OM/app/tool/crawl4ai.py（重量级，Playwright 渲染）
 *
 * 三级策略：
 * 1. 先尝试 fetch API（最快，不需要浏览器）
 * 2. 如果返回的是 JS 渲染页面，降级到 Playwright
 * 3. 两种方式都清理 HTML 噪音，输出干净文本
 */
import { BrowserPool } from './browserPool.js'
import type { FetchResult } from './webTypes.js'

export class ContentFetcher {
  private cache = new Map<string, { result: FetchResult; timestamp: number }>()
  private cacheTTL = 10 * 60 * 1000  // 10 分钟缓存

  /**
   * 抓取 URL 内容
   *
   * 参照 $OM WebContentFetcher 的清洗策略，但用 Playwright 的 evaluate 做 DOM 操作
   */
  async fetch(url: string, maxLength = 10000): Promise<FetchResult> {
    const startTime = Date.now()

    // 检查缓存
    const cached = this.cache.get(url)
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.result
    }

    // 策略1：先用轻量 fetch 尝试
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(10000),
      })

      if (resp.ok) {
        const html = await resp.text()
        // 检查是否是需要 JS 渲染的页面
        if (!this.needsJSRendering(html)) {
          const result = this.cleanHTML(html, url, maxLength, startTime)
          this.cache.set(url, { result, timestamp: Date.now() })
          return result
        }
      }
    } catch {}

    // 策略2：降级到 Playwright 渲染
    return this.fetchWithBrowser(url, maxLength, startTime)
  }

  /**
   * 用 Playwright 抓取（处理 JS 渲染页面）
   */
  private async fetchWithBrowser(url: string, maxLength: number, startTime: number): Promise<FetchResult> {
    const pool = BrowserPool.getInstance()
    const page = await pool.getPage()

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(2000)  // 等待 JS 渲染

      // 在页面内执行清洗 — 对应 $OM WebContentFetcher 的 soup.extract() 策略
      const result = await page.evaluate((ml: number) => {
        // 移除噪音元素（参照 $OM 的 excluded_tags + remove_overlay_elements）
        const removeSelectors = [
          'script', 'style', 'noscript', 'iframe',
          'nav', 'footer', 'header',
          '.ad, .ads, .advertisement, .cookie-banner',
          '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
          '.sidebar, aside, .popup, .modal, .overlay',
        ]
        removeSelectors.forEach(sel => {
          document.querySelectorAll(sel).forEach(el => el.remove())
        })

        const title = document.title || ''

        // 提取正文 — 优先找 article/main，其次 body
        const mainEl = document.querySelector('article, main, [role="main"], .content, .post-content, .entry-content')
        const contentEl = mainEl || document.body

        const text = (contentEl as HTMLElement).innerText || ''
        // 清理多余空白
        const cleaned = text.replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim()

        return { title, content: cleaned.slice(0, ml), wordCount: cleaned.split(/\s+/).length }
      }, maxLength)

      const fetchResult: FetchResult = {
        url,
        title: result.title,
        content: result.content || '（页面为空）',
        wordCount: result.wordCount,
        fetchTimeMs: Date.now() - startTime,
      }

      this.cache.set(url, { result: fetchResult, timestamp: Date.now() })
      return fetchResult

    } catch (e: any) {
      return { url, title: '', content: '', wordCount: 0, fetchTimeMs: Date.now() - startTime, error: e.message }
    } finally {
      await pool.releasePage(page)
    }
  }

  /**
   * 清洗 HTML（轻量版，不需要浏览器）
   * 参照 $OM WebContentFetcher 的 BeautifulSoup 策略，用正则替代
   */
  private cleanHTML(html: string, url: string, maxLength: number, startTime: number): FetchResult {
    // 提取 title
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i)
    const title = titleMatch ? titleMatch[1].trim() : ''

    // 移除 script, style, nav, footer, header
    let cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')

    // 转为 markdown（保留结构信息）
    cleaned = cleaned.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
    cleaned = cleaned.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    cleaned = cleaned.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    cleaned = cleaned.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    cleaned = cleaned.replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    cleaned = cleaned.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    cleaned = cleaned.replace(/<br\s*\/?>/gi, '\n')
    // 移除剩余 HTML 标签
    cleaned = cleaned.replace(/<[^>]+>/g, '')
    // 解码 HTML 实体
    cleaned = cleaned.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    // 清理空白
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim()

    return {
      url, title,
      content: cleaned.slice(0, maxLength),
      wordCount: cleaned.split(/\s+/).length,
      fetchTimeMs: Date.now() - startTime,
    }
  }

  /** 检测页面是否需要 JS 渲染 */
  private needsJSRendering(html: string): boolean {
    // 如果 body 中几乎没有文本内容，说明需要 JS 渲染
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
    if (!bodyMatch) return true
    const bodyText = bodyMatch[1].replace(/<[^>]+>/g, '').trim()
    return bodyText.length < 200
  }

  /** 清除缓存 */
  clearCache() {
    this.cache.clear()
  }
}
