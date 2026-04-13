/**
 * 浏览器自动化专项 - 源码补丁
 * 修改 webTypes.ts, toolRegistry.ts, toolSelector.ts, contentFetcher.ts, deepseek.md
 *
 * 用法: node patch_browser.cjs /home/ubuntu/Magent/claudeqqbot
 */

const fs = require('fs');
const path = require('path');

const PROJECT = process.argv[2] || '/home/ubuntu/Magent/claudeqqbot';
let patchCount = 0;

function patch(relPath, description, fn) {
  const filePath = path.join(PROJECT, relPath);
  if (!fs.existsSync(filePath)) {
    console.log(`  [!] 文件不存在: ${relPath}`);
    return;
  }
  let original = fs.readFileSync(filePath, 'utf-8');
  // 统一换行符
  original = original.replace(/\r\n/g, '\n');
  const modified = fn(original);
  if (modified !== original) {
    fs.writeFileSync(filePath, modified);
    console.log(`  [✓] ${description}`);
    patchCount++;
  } else {
    console.log(`  [=] ${relPath} 无变化`);
  }
}

// ═══════════════════════════════════════════
// 1. webTypes.ts — 新增浏览器相关类型
// ═══════════════════════════════════════════
console.log('\n── 补丁 1/5: webTypes.ts 新增类型 ──');

patch('src/tools/web/webTypes.ts', '新增 InteractiveElement / PageSnapshot / BrowserAction 类型', code => {
  if (code.includes('InteractiveElement')) return code; // 已有

  code += `

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
`;
  return code;
});

// ═══════════════════════════════════════════
// 2. toolRegistry.ts — 注册 browserActionTool
// ═══════════════════════════════════════════
console.log('\n── 补丁 2/5: toolRegistry.ts 注册工具 ──');

patch('src/engine/toolRegistry.ts', '注册 browserActionTool', code => {
  if (code.includes('browserActionTool')) return code;

  // 加 import
  code = code.replace(
    "import { subAgentTool } from '../tools/subAgent.js'",
    "import { subAgentTool } from '../tools/subAgent.js'\nimport { browserActionTool } from '../tools/web/browserAction.js'"
  );

  // 加 register（在 subAgentTool 之后）
  code = code.replace(
    '  registry.register(subAgentTool)',
    '  registry.register(subAgentTool)\n  registry.register(browserActionTool)'
  );

  return code;
});

// ═══════════════════════════════════════════
// 3. toolSelector.ts — 加 browser_action 关键词
// ═══════════════════════════════════════════
console.log('\n── 补丁 3/5: toolSelector.ts 加关键词 ──');

patch('src/engine/orchestrator/toolSelector.ts', '注册 browser_action 到工具选择器', code => {
  if (code.includes("'browser_action'")) return code;

  // 在 sub_agent 那行之前插入
  const marker = "    { name: 'sub_agent'";
  const inject = `    { name: 'browser_action', category: 'web', keywords: ['点击', '登录', '填写', '表单', '按钮', '输入框', '滚动', '翻页', '截图', '动态', '交互', '操作', '浏览器', '知乎文章', '打开页面', '模拟'], tokenCost: 90 },\n`;

  code = code.replace(marker, inject + marker);
  return code;
});

// ═══════════════════════════════════════════
// 4. contentFetcher.ts — cleanHTML 输出改为 markdown
// ═══════════════════════════════════════════
console.log('\n── 补丁 4/5: contentFetcher.ts markdown 输出 ──');

patch('src/tools/web/contentFetcher.ts', 'cleanHTML 输出改为 markdown（保留标题/列表/链接结构）', code => {
  // 找到 "移除所有 HTML 标签" 那行并替换整段
  const oldBlock = `    // 移除所有 HTML 标签
    cleaned = cleaned.replace(/<[^>]+>/g, ' ')
    // 解码 HTML 实体
    cleaned = cleaned.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    // 清理空白
    cleaned = cleaned.replace(/\\s+/g, ' ').trim()`;

  const newBlock = `    // 转为 markdown（保留结构信息）
    cleaned = cleaned.replace(/<h1[^>]*>([\\s\\S]*?)<\\/h1>/gi, '\\n# $1\\n')
    cleaned = cleaned.replace(/<h2[^>]*>([\\s\\S]*?)<\\/h2>/gi, '\\n## $1\\n')
    cleaned = cleaned.replace(/<h3[^>]*>([\\s\\S]*?)<\\/h3>/gi, '\\n### $1\\n')
    cleaned = cleaned.replace(/<li[^>]*>([\\s\\S]*?)<\\/li>/gi, '- $1\\n')
    cleaned = cleaned.replace(/<a[^>]+href="([^"]*)"[^>]*>([\\s\\S]*?)<\\/a>/gi, '[$2]($1)')
    cleaned = cleaned.replace(/<p[^>]*>([\\s\\S]*?)<\\/p>/gi, '$1\\n\\n')
    cleaned = cleaned.replace(/<br\\s*\\/?>/gi, '\\n')
    // 移除剩余 HTML 标签
    cleaned = cleaned.replace(/<[^>]+>/g, '')
    // 解码 HTML 实体
    cleaned = cleaned.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    // 清理空白
    cleaned = cleaned.replace(/\\n{3,}/g, '\\n\\n').replace(/ {2,}/g, ' ').trim()`;

  if (!code.includes('移除所有 HTML 标签')) return code;
  code = code.replace(oldBlock, newBlock);
  return code;
});

// ═══════════════════════════════════════════
// 5. deepseek.md — 加浏览器工具说明
// ═══════════════════════════════════════════
console.log('\n── 补丁 5/5: deepseek.md 加工具说明 ──');

const promptPath = path.join(PROJECT, 'workspace/prompts/deepseek.md');
if (fs.existsSync(promptPath)) {
  let prompt = fs.readFileSync(promptPath, 'utf-8');
  if (!prompt.includes('browser_action')) {
    // 在 web_extract 后面加
    prompt = prompt.replace(
      '- web_extract: url（字符串）, goal（字符串，可选）',
      `- web_extract: url（字符串）, goal（字符串，可选）
- browser_action: 操控浏览器。参数 action（goto/click/type/scroll_down/scroll_up/screenshot/extract/wait）, url, index, text, goal
  - 适合需要登录、点击、填表、处理动态加载页面的场景
  - 每次操作后返回可交互元素列表，用索引号指定操作目标
  - 简单抓取用 web_fetch，复杂交互才用 browser_action`
    );
    fs.writeFileSync(promptPath, prompt);
    console.log('  [✓] deepseek.md 已加 browser_action 说明');
    patchCount++;
  } else {
    console.log('  [=] deepseek.md 已有 browser_action');
  }
} else {
  console.log('  [!] deepseek.md 不存在');
}

console.log(`\n── 完成: ${patchCount} 个文件已修改 ──\n`);
