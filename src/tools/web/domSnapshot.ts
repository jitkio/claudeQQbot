import type { Page } from 'playwright'
import type { InteractiveElement, PageSnapshot } from './webTypes.js'

/**
 * 从 Playwright Page 提取可交互元素列表
 * 融合 OpenManus DOM index + OpenClaw 语义描述
 */
export async function getInteractiveElements(page: Page, maxElements = 50): Promise<InteractiveElement[]> {
  return page.evaluate((max: number) => {
    const elements: Array<{
      index: number; tag: string; text: string;
      type?: string; href?: string; role?: string
    }> = []

    const selectors = [
      'a[href]', 'button', 'input:not([type="hidden"])',
      'textarea', 'select', '[role="button"]', '[role="link"]',
      '[role="menuitem"]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
    ]

    const allElements = document.querySelectorAll(selectors.join(','))
    let idx = 0

    for (const el of allElements) {
      if (idx >= max) break
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const style = window.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue

      const tag = el.tagName.toLowerCase()
      const text = (
        (el as HTMLElement).innerText?.trim() ||
        (el as HTMLInputElement).placeholder ||
        (el as HTMLInputElement).value ||
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        ''
      ).slice(0, 80)

      if (!text && tag !== 'input' && tag !== 'textarea') continue

      elements.push({
        index: idx, tag, text,
        type: (el as HTMLInputElement).type || undefined,
        href: tag === 'a' ? (el as HTMLAnchorElement).href : undefined,
        role: el.getAttribute('role') || undefined,
      })

      el.setAttribute('data-agent-idx', String(idx))
      idx++
    }

    return elements
  }, maxElements)
}

export async function getScrollInfo(page: Page) {
  return page.evaluate(() => {
    const scrollY = window.scrollY || document.documentElement.scrollTop
    const viewportHeight = window.innerHeight
    const totalHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
    return {
      pixelsAbove: Math.round(scrollY),
      pixelsBelow: Math.max(0, Math.round(totalHeight - scrollY - viewportHeight)),
      totalHeight: Math.round(totalHeight),
      viewportHeight,
    }
  })
}

export async function getPageSnapshot(page: Page, includeScreenshot = false): Promise<PageSnapshot> {
  const [elements, scrollPosition, title] = await Promise.all([
    getInteractiveElements(page),
    getScrollInfo(page),
    page.title(),
  ])

  const url = page.url()

  let screenshot: string | undefined
  if (includeScreenshot) {
    const buf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false })
    screenshot = buf.toString('base64')
  }

  return { url, title, elements, scrollPosition, screenshot }
}

export function renderSnapshot(snapshot: PageSnapshot): string {
  const TAG_LABELS: Record<string, string> = {
    a: '链接', button: '按钮', input: '输入框', textarea: '文本框', select: '下拉框',
  }

  const lines: string[] = [
    `当前页面: ${snapshot.title}`,
    `URL: ${snapshot.url}`,
    `滚动: 上方 ${snapshot.scrollPosition.pixelsAbove}px / 下方 ${snapshot.scrollPosition.pixelsBelow}px`,
    '',
    `可交互元素 (${snapshot.elements.length} 个):`,
  ]

  for (const el of snapshot.elements) {
    const label = TAG_LABELS[el.tag] || el.tag
    let line = `  [${el.index}] ${label}`
    if (el.type && el.tag === 'input') line += `[${el.type}]`
    line += ` "${el.text}"`
    if (el.href) {
      try { const p = new URL(el.href).pathname; if (p !== '/') line += ` → ${p}` }
      catch { line += ` → ${el.href.slice(0, 60)}` }
    }
    lines.push(line)
  }

  return lines.join('\n')
}
