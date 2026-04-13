/**
 * 浏览器单例池
 *
 * 全局只启动一个 Chromium 实例，所有工具共享。
 * 参照 OpenManus BrowserUseTool 的延迟初始化 + asyncio.Lock 思路。
 *
 * 对应 $OM/app/tool/browser_use_tool.py 第 141-188 行
 */
import { type Browser, type Page, chromium } from 'playwright'

export class BrowserPool {
  private static instance: BrowserPool | null = null
  private browser: Browser | null = null
  private initPromise: Promise<Browser> | null = null
  private pageCount = 0
  private maxPages = 5
  private idleTimer: NodeJS.Timeout | null = null
  private idleTimeoutMs = 5 * 60 * 1000  // 5 分钟无活动关闭

  static getInstance(): BrowserPool {
    if (!BrowserPool.instance) {
      BrowserPool.instance = new BrowserPool()
    }
    return BrowserPool.instance
  }

  /**
   * 获取浏览器实例（延迟初始化）
   * 参照 $OM 的 _ensure_browser_initialized 模式
   */
  async getBrowser(): Promise<Browser> {
    this.resetIdleTimer()

    if (this.browser?.isConnected()) {
      return this.browser
    }

    // 防止并发初始化（等效于 OpenManus 的 asyncio.Lock）
    if (this.initPromise) {
      return this.initPromise
    }

    this.initPromise = this.launchBrowser()
    try {
      this.browser = await this.initPromise
      return this.browser
    } finally {
      this.initPromise = null
    }
  }

  /** 获取一个新页面（带自动清理） */
  async getPage(): Promise<Page> {
    const browser = await this.getBrowser()

    // 限制同时打开的页面数
    if (this.pageCount >= this.maxPages) {
      const pages = browser.contexts()[0]?.pages() || []
      if (pages.length > 1) {
        await pages[0].close()
        this.pageCount--
      }
    }

    let context = browser.contexts()[0]
    if (!context) {
      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        locale: 'zh-CN',
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        hasTouch: false,
        javaScriptEnabled: true,
        bypassCSP: true,
      })
    }

    const page = await context.newPage()
    // 反 webdriver 检测
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })
      const originalQuery = window.navigator.permissions.query
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery(parameters)
    }).catch(() => {})
    this.pageCount++
    return page
  }

  /** 归还页面 */
  async releasePage(page: Page) {
    try {
      await page.close()
      this.pageCount--
    } catch {}
    this.resetIdleTimer()
  }

  private async launchBrowser(): Promise<Browser> {
    console.log('[BrowserPool] 启动 Chromium...')
    return chromium.launch({
      headless: true,
            executablePath: process.env.CHROMIUM_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--disable-web-security',
      ],
    })
  }

  private resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.shutdown(), this.idleTimeoutMs)
  }

  async shutdown() {
    if (this.browser) {
      console.log('[BrowserPool] 空闲超时，关闭浏览器')
      await this.browser.close().catch(() => {})
      this.browser = null
      this.pageCount = 0
    }
  }
}
