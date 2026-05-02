import type { ToolDef, ToolContext } from '../../engine/types.js'
import type { BrowserAction, PageSnapshot } from './webTypes.js'
import { BrowserPool } from './browserPool.js'
import { getPageSnapshot, renderSnapshot } from './domSnapshot.js'
import type { Page } from 'playwright'

/** 会话级 Page 管理：同一 sessionKey 复用同一个 Page */
const sessionPages = new Map<string, { page: Page; lastUsed: number }>()

setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of sessionPages) {
    if (now - entry.lastUsed > 5 * 60 * 1000) {
      entry.page.close().catch(() => {})
      sessionPages.delete(key)
    }
  }
}, 60 * 1000)

async function getSessionPage(sessionKey: string): Promise<Page> {
  const existing = sessionPages.get(sessionKey)
  if (existing) {
    existing.lastUsed = Date.now()
    try { await existing.page.title(); return existing.page } catch { sessionPages.delete(sessionKey) }
  }
  const pool = BrowserPool.getInstance()
  const page = await pool.getPage()
  sessionPages.set(sessionKey, { page, lastUsed: Date.now() })
  return page
}

export const browserActionTool: ToolDef = {
  name: 'browser_action',
  isReadOnly: true,
  isConcurrencySafe: false,

  description: `操控浏览器执行复杂交互。用于需要点击、输入、滚动、截图的场景（如登录、填表单、抓取动态页面）。
每次调用后返回页面状态：URL、标题、可交互元素列表（带索引号）、滚动位置。
用元素索引号来指定 click 和 type 的目标。简单网页抓取请用 web_fetch。`,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['goto', 'click', 'type', 'scroll_down', 'scroll_up', 'screenshot', 'extract', 'wait'],
        description: '浏览器动作',
      },
      url: { type: 'string', description: 'goto 的目标 URL' },
      index: { type: 'number', description: 'click/type 的元素索引号' },
      text: { type: 'string', description: 'type 要输入的文本' },
      pixels: { type: 'number', description: 'scroll 像素数，默认 500' },
      goal: { type: 'string', description: 'extract 的提取目标' },
      ms: { type: 'number', description: 'wait 毫秒数，默认 2000' },
    },
    required: ['action'],
  },

  async execute(args: Record<string, any>, ctx: ToolContext): Promise<string> {
    const action = args.action as BrowserAction
    const sessionKey = (ctx as any).sessionKey || 'default'

    let page: Page
    try {
      page = await getSessionPage(sessionKey)
    } catch (e: any) {
      return `[browser_action 错误] 无法获取浏览器: ${e.message}`
    }

    try {
      switch (action) {
        case 'goto': {
          let url = args.url as string
          if (!url) return '[错误] goto 需要 url 参数'
          // 自动转手机版（绕过 PC 版反爬）
          const mobileRules: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
            [/^https?:\/\/(www\.)?zhihu\.com/,  () => url.replace(/\/\/(www\.)?zhihu\.com/, '//m.zhihu.com')],
            [/^https?:\/\/(www\.)?weibo\.com/,   () => url.replace(/\/\/(www\.)?weibo\.com/, '//m.weibo.cn')],
          ]
          for (const [re, fn] of mobileRules) {
            const m = url.match(re)
            if (m) { url = fn(m); console.log('[BrowserAction] 自动转手机版:', url); break }
          }
          await page.waitForTimeout(3500)
          // 自动关闭弹窗
          await page.evaluate(() => {
            const closeBtns = document.querySelectorAll('.Modal-closeButton, .close-button, [aria-label="关闭"], button[aria-label="Close"]')
            closeBtns.forEach(el => (el as HTMLElement).click())
            document.querySelectorAll('.Modal-wrapper, .Modal-overlay, .Modal-enter-done, .SignFlowModal').forEach(el => el.remove())
          }).catch(() => {})
          await page.waitForTimeout(500)
          const snapshot = await getPageSnapshot(page)
          return `已导航到: ${url}\n\n${renderSnapshot(snapshot)}`
        }

        case 'click': {
          const index = args.index as number
          if (index === undefined) return '[错误] click 需要 index 参数'
          const el = await page.$(`[data-agent-idx="${index}"]`)
          if (!el) return `[错误] 未找到索引 ${index} 的元素`
          await el.click()
          await page.waitForTimeout(1500)
          const snapshot = await getPageSnapshot(page)
          return `已点击元素 [${index}]\n\n${renderSnapshot(snapshot)}`
        }

        case 'type': {
          const index = args.index as number
          const text = args.text as string
          if (index === undefined || !text) return '[错误] type 需要 index 和 text 参数'
          const el = await page.$(`[data-agent-idx="${index}"]`)
          if (!el) return `[错误] 未找到索引 ${index} 的元素`
          await el.fill(text)
          const snapshot = await getPageSnapshot(page)
          return `已在元素 [${index}] 输入: "${text}"\n\n${renderSnapshot(snapshot)}`
        }

        case 'scroll_down': {
          const px = (args.pixels as number) || 500
          await page.evaluate((p: number) => window.scrollBy(0, p), px)
          await page.waitForTimeout(800)
          const snapshot = await getPageSnapshot(page)
          return `已向下滚动 ${px}px\n\n${renderSnapshot(snapshot)}`
        }

        case 'scroll_up': {
          const px = (args.pixels as number) || 500
          await page.evaluate((p: number) => window.scrollBy(0, -p), px)
          await page.waitForTimeout(800)
          const snapshot = await getPageSnapshot(page)
          return `已向上滚动 ${px}px\n\n${renderSnapshot(snapshot)}`
        }

        case 'screenshot': {
          const snapshot = await getPageSnapshot(page, true)
          if (snapshot.screenshot) {
            return `[截图已生成, base64 长度: ${snapshot.screenshot.length}]\n\n${renderSnapshot(snapshot)}\n\n[SCREENSHOT_BASE64]${snapshot.screenshot}[/SCREENSHOT_BASE64]`
          }
          return `截图失败\n\n${renderSnapshot(snapshot)}`
        }

        case 'extract': {
          await page.waitForTimeout(2000)
          const goal = args.goal as string || ''
          const content = await page.evaluate(() => {
            const removeSelectors = [
              'script', 'style', 'noscript', 'iframe', 'nav', 'footer', 'header',
              '.ad, .ads, .advertisement, .cookie-banner',
              '[role="navigation"]', '[role="banner"]',
              '.sidebar, aside, .popup, .modal, .overlay',
            ]
            const clone = document.body.cloneNode(true) as HTMLElement
            removeSelectors.forEach(sel => {
              clone.querySelectorAll(sel).forEach(el => el.remove())
            })
            const mainEl = clone.querySelector('article, main, [role="main"], .content, .post-content, .entry-content') || clone
            const text = (mainEl as HTMLElement).innerText || ''
            return text.replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim()
          })

          let output = `--- 页面内容 ---\nURL: ${page.url()}\n标题: ${await page.title()}\n`
          if (goal) output += `提取目标: ${goal}\n`
          output += `字数: ${content.length}\n--- 正文 ---\n`
          output += content.slice(0, 8000)
          if (content.length > 8000) output += '\n...(已截断)'
          return output
        }

        case 'wait': {
          const ms = Math.min((args.ms as number) || 2000, 10000)
          await page.waitForTimeout(ms)
          const snapshot = await getPageSnapshot(page)
          return `已等待 ${ms}ms\n\n${renderSnapshot(snapshot)}`
        }

        default:
          return `[错误] 未知动作: ${action}。支持: goto/click/type/scroll_down/scroll_up/screenshot/extract/wait`
      }
    } catch (e: any) {
      try {
        const snapshot = await getPageSnapshot(page)
        return `[browser_action 错误] ${e.message}\n\n当前状态:\n${renderSnapshot(snapshot)}`
      } catch {
        return `[browser_action 错误] ${e.message}`
      }
    }
  },
}
