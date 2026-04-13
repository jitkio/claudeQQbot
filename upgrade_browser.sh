#!/bin/bash
###############################################################################
#  AgentForge 浏览器自动化升级脚本
#  放到项目根目录运行: bash upgrade_browser.sh
###############################################################################

set -euo pipefail

PROJECT="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="${PROJECT}/_backup_browser_$(date +%Y%m%d_%H%M%S)"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

echo ""
echo "============================================"
echo "  AgentForge 浏览器自动化升级"
echo "  新增: browser_action 工具 (8种动作)"
echo "  升级: contentFetcher markdown 输出"
echo "============================================"
echo ""

[ -d "$PROJECT/src/tools/web" ] || err "项目结构不对: 找不到 src/tools/web"

# ── 备份 ──
echo "── 步骤 1/4: 备份 ──"
mkdir -p "$BACKUP_DIR"
for f in \
  src/tools/web/webTypes.ts \
  src/tools/web/contentFetcher.ts \
  src/engine/toolRegistry.ts \
  src/engine/orchestrator/toolSelector.ts \
  workspace/prompts/deepseek.md
do
  [ -f "$PROJECT/$f" ] && { mkdir -p "$BACKUP_DIR/$(dirname "$f")"; cp "$PROJECT/$f" "$BACKUP_DIR/$f"; }
done
log "备份 → $BACKUP_DIR"
echo ""

# ── 创建新文件 ──
echo "── 步骤 2/4: 创建新文件 ──"

# === domSnapshot.ts ===
cat > "$PROJECT/src/tools/web/domSnapshot.ts" << 'TSEOF'
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
TSEOF
log "创建 src/tools/web/domSnapshot.ts (120行)"

# === browserAction.ts ===
cat > "$PROJECT/src/tools/web/browserAction.ts" << 'TSEOF'
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
          const url = args.url as string
          if (!url) return '[错误] goto 需要 url 参数'
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
          await page.waitForTimeout(1500)
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
TSEOF
log "创建 src/tools/web/browserAction.ts (170行)"
echo ""

# ── 补丁现有文件 ──
echo "── 步骤 3/4: 修改现有文件 ──"

PATCH_SCRIPT="$PROJECT/patch_browser.cjs"
if [ ! -f "$PATCH_SCRIPT" ]; then
  err "找不到 patch_browser.cjs，确保它和本脚本在同一目录"
fi

node "$PATCH_SCRIPT" "$PROJECT"
echo ""

# ── 重启 ──
echo "── 步骤 4/4: 重启服务 ──"
cd "$PROJECT"
pm2 restart all 2>/dev/null && log "pm2 已重启" || warn "pm2 重启失败，请手动重启"

echo ""
echo "============================================"
echo -e "  ${GREEN}浏览器自动化升级完成！${NC}"
echo "============================================"
echo ""
echo "  新增文件:"
echo "    src/tools/web/domSnapshot.ts     ← DOM 元素索引 + 页面快照"
echo "    src/tools/web/browserAction.ts   ← 8 种浏览器动作"
echo ""
echo "  修改文件:"
echo "    webTypes.ts       ← 新增类型"
echo "    toolRegistry.ts   ← 注册 browser_action"
echo "    toolSelector.ts   ← 加关键词"
echo "    contentFetcher.ts ← markdown 输出"
echo "    deepseek.md       ← 加工具说明"
echo ""
echo "  测试:"
echo "    QQ发送: 帮我打开知乎热榜看看有什么"
echo "    QQ发送: 用浏览器打开 https://www.bilibili.com 截个图"
echo ""
echo "  回滚: cp -r $BACKUP_DIR/* $PROJECT/"
echo ""
