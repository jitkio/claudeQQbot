/**
 * 多搜索引擎实现
 *
 * 参照 OpenManus 的 search/ 目录：
 * - bing_search.py — Bing HTML 解析
 * - duckduckgo_search.py — DuckDuckGo 搜索
 * - google_search.py — Google 搜索
 */
import type { SearchEngine, SearchResult, SearchOptions } from './webTypes.js'
import { BrowserPool } from './browserPool.js'

/**
 * Bing 搜索引擎
 *
 * 参照 $OM/app/tool/search/bing_search.py 的 HTML 解析实现，
 * 但改用 Playwright（因为项目已经依赖 Playwright）
 */
export class BingSearch implements SearchEngine {
  name = 'bing'

  async search(query: string, numResults = 5, options?: SearchOptions): Promise<SearchResult[]> {
    const pool = BrowserPool.getInstance()
    const page = await pool.getPage()

    try {
      const lang = options?.lang || 'zh-Hans'
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=${lang}`

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await page.waitForTimeout(1500)

      // 解析搜索结果 — 对应 $OM bing_search.py 的 _parse_html 方法
      const results = await page.evaluate(() => {
        const items: Array<{ title: string; url: string; description: string }> = []
        document.querySelectorAll('.b_algo').forEach((el, i) => {
          if (i >= 10) return  // 最多取 10 条
          const h2 = el.querySelector('h2')
          const title = (h2 as HTMLElement)?.innerText || ''
          const link = h2?.querySelector('a')?.getAttribute('href') || ''
          const desc = (el.querySelector('.b_caption p, .b_lineclamp2') as HTMLElement)?.textContent || ''
          if (link) items.push({ title, url: link, description: desc })
        })
        return items
      })

      return results.slice(0, numResults).map((r, i) => ({
        position: i + 1,
        url: r.url,
        title: r.title,
        description: r.description,
        source: 'bing',
      }))
    } catch (e: any) {
      console.warn(`[BingSearch] 搜索失败: ${e.message}`)
      return []
    } finally {
      await pool.releasePage(page)
    }
  }
}

/**
 * DuckDuckGo 搜索（无需 API Key）
 *
 * 参照 $OM/app/tool/search/duckduckgo_search.py
 * 用 DuckDuckGo 的 lite 版本避免 JS 渲染问题
 */
export class DuckDuckGoSearch implements SearchEngine {
  name = 'duckduckgo'

  async search(query: string, numResults = 5): Promise<SearchResult[]> {
    const pool = BrowserPool.getInstance()
    const page = await pool.getPage()

    try {
      await page.goto(
        `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
        { waitUntil: 'domcontentloaded', timeout: 15000 },
      )
      await page.waitForTimeout(1000)

      const results = await page.evaluate(() => {
        const items: Array<{ title: string; url: string; description: string }> = []
        // DuckDuckGo lite 版用表格布局
        const links = document.querySelectorAll('a.result-link')
        const snippets = document.querySelectorAll('.result-snippet')
        links.forEach((a, i) => {
          if (i >= 10) return
          items.push({
            title: a.textContent?.trim() || '',
            url: (a as HTMLAnchorElement).href || '',
            description: snippets[i]?.textContent?.trim() || '',
          })
        })
        // 如果 lite 版解析失败，尝试标准结果格式
        if (items.length === 0) {
          document.querySelectorAll('.result__a').forEach((a, i) => {
            if (i >= 10) return
            const snippet = a.closest('.result')?.querySelector('.result__snippet')
            items.push({
              title: a.textContent?.trim() || '',
              url: (a as HTMLAnchorElement).href || '',
              description: snippet?.textContent?.trim() || '',
            })
          })
        }
        return items
      })

      return results.slice(0, numResults).map((r, i) => ({
        position: i + 1, url: r.url, title: r.title, description: r.description, source: 'duckduckgo',
      }))
    } catch (e: any) {
      console.warn(`[DuckDuckGoSearch] 搜索失败: ${e.message}`)
      return []
    } finally {
      await pool.releasePage(page)
    }
  }
}

/**
 * Google 搜索
 * 注意：Google 反爬较严，在服务器上经常被 block
 * 建议作为降级方案的最后选项
 */
export class GoogleSearch implements SearchEngine {
  name = 'google'

  async search(query: string, numResults = 5): Promise<SearchResult[]> {
    const pool = BrowserPool.getInstance()
    const page = await pool.getPage()

    try {
      await page.goto(
        `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=zh-CN`,
        { waitUntil: 'domcontentloaded', timeout: 15000 },
      )
      await page.waitForTimeout(2000)

      const results = await page.evaluate(() => {
        const items: Array<{ title: string; url: string; description: string }> = []
        document.querySelectorAll('#search .g').forEach((el, i) => {
          if (i >= 10) return
          const a = el.querySelector('a') as HTMLAnchorElement | null
          const h3 = el.querySelector('h3')
          // Google 的摘要在不同结构中
          const desc = el.querySelector('.VwiC3b, [data-sncf], .st')
          if (a?.href) {
            items.push({
              title: h3?.textContent || '',
              url: a.href,
              description: desc?.textContent || '',
            })
          }
        })
        return items
      })

      return results.slice(0, numResults).map((r, i) => ({
        position: i + 1, url: r.url, title: r.title, description: r.description, source: 'google',
      }))
    } catch (e: any) {
      console.warn(`[GoogleSearch] 搜索失败: ${e.message}`)
      return []
    } finally {
      await pool.releasePage(page)
    }
  }
}
