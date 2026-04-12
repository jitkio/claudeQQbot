import type { ToolDef } from '../types.js'
import type { ToolSelectionResult } from './orchestratorTypes.js'

type Category = 'always' | 'file' | 'web' | 'code' | 'system' | 'agent' | 'schedule'

interface ToolProfile {
  tool: ToolDef
  keywords: string[]
  category: Category
  // 该工具上下文成本的粗估值（token 数），用于小模型场景限制总量
  tokenCost: number
}

export class ToolSelector {
  private profiles: ToolProfile[] = []

  register(tool: ToolDef, profile: Omit<ToolProfile, 'tool'>): void {
    this.profiles.push({ tool, ...profile })
  }

  /** 根据用户消息和 provider 挑选合适的工具 */
  select(userMessage: string, provider: string): ToolSelectionResult {
    const lower = userMessage.toLowerCase()
    const selected: ToolDef[] = []
    const dropped: string[] = []

    // Step 1: always 类工具始终选中
    for (const p of this.profiles) {
      if (p.category === 'always') {
        selected.push(p.tool)
      }
    }

    // Step 2: 按关键词匹配
    for (const p of this.profiles) {
      if (p.category === 'always') continue
      const matched = p.keywords.some(k => lower.includes(k))

      // 隐式触发：文件路径特征 → 自动加文件类工具
      const hasFilePath = /[\/\\][\w.-]+\.\w+/.test(lower) || /文件|目录|路径|folder|directory/i.test(lower)
      const hasUrl = /https?:\/\//.test(lower) || /网址|链接|url/i.test(lower)

      if (matched || (hasFilePath && p.category === 'file') || (hasUrl && p.category === 'web')) {
        selected.push(p.tool)
      } else {
        dropped.push(p.tool.name)
      }
    }

    // Step 3: 如果只有 always 类工具且没有行动意图，不传工具
    if (selected.length <= 1 && !hasActionIntent(lower)) {
      return { selected: [], dropped: dropped, reason: '纯对话模式（未触发工具）' }
    }

    // Step 4: 按 provider 裁剪
    let finalSelected = selected
    let reason = `基于关键词匹配，命中 ${selected.length} 个工具`

    const isSmallModel = provider === 'openai'
    if (isSmallModel && selected.length > 5) {
      // 按 tokenCost 升序，只保留最便宜的 5 个
      finalSelected = [...selected]
        .sort((a, b) => {
          const ca = this.profiles.find(p => p.tool.name === a.name)?.tokenCost ?? 999
          const cb = this.profiles.find(p => p.tool.name === b.name)?.tokenCost ?? 999
          return ca - cb
        })
        .slice(0, 5)
      reason = `小模型 provider ${provider}，从 ${selected.length} 个候选中保留 5 个`
    }

    return {
      selected: finalSelected,
      dropped,
      reason,
    }
  }
}

/** 判断消息是否有执行意图（而非纯聊天） */
function hasActionIntent(msg: string): boolean {
  const actionKeywords = [
    '帮我', '帮忙', '请', '能不能', '可以', '找', '查', '看', '给我', '告诉', '找', '查', '看', '给我', '告诉',
    '搜索', '查找', '查询', '搜一下', '看看',
    '执行', '运行', '安装', '下载', '创建', '生成', '写', '编辑', '修改', '删除',
    '读取', '打开', '分析', '处理',
    '提醒', '定时', '计划', '日程',
    '文件', '代码', '脚本', '程序',
    '翻译', '总结', '整理',
  ]
  return actionKeywords.some(kw => msg.includes(kw))
}

/** 工厂函数：创建一个预配置了所有默认工具 profile 的选择器 */
export function createOrchestratorSelector(tools: ToolDef[]): ToolSelector {
  const selector = new ToolSelector()
  const byName = new Map(tools.map(t => [t.name, t]))

  const defaults: Array<{
    name: string
    category: Category
    keywords: string[]
    tokenCost: number
  }> = [
    { name: 'bash', category: 'always', keywords: ['执行', '运行', '命令', '安装', '下载', 'python', 'pip', 'npm', 'apt', '代码', '脚本', '编译', '部署', '启动', '停止', '重启', '服务'], tokenCost: 80 },
    { name: 'read_file', category: 'file', keywords: ['文件', '读取', '看看', '打开', '图片', '分析', '文档', '内容', '配置', '日志', 'log', '读', '查看'], tokenCost: 50 },
    { name: 'write_file', category: 'file', keywords: ['写入', '创建文件', '保存', '生成文件', '导出', '写文件', '新建'], tokenCost: 50 },
    { name: 'edit_file', category: 'file', keywords: ['修改', '编辑', '替换', '更新文件', '改文件', '改一下'], tokenCost: 60 },
    { name: 'glob', category: 'file', keywords: ['查找文件', '文件列表', '目录', '文件名', '找文件', '哪些文件', '列出文件'], tokenCost: 40 },
    { name: 'grep', category: 'file', keywords: ['搜索内容', '查找文本', '包含', 'grep', '搜索代码', '在文件中找'], tokenCost: 45 },
    { name: 'web_search', category: 'web', keywords: ['搜索', '查找', '最新', '新闻', '怎么样', '价格', '天气', '百科', '是什么', '谁是', '搜一下', '查一下', '了解', '调研', '找', '热搜', '榜', '排行', '推荐', '评价', '对比', 'b站', 'bilibili', '百度', '知乎', '微博', '今天', '最近', '现在', '目前', '实时', '多少钱', '哪个', '哪里', '什么时候', '找', '热搜', '榜', '排行', '推荐', '评价', '对比', 'b站', 'bilibili', '百度', '知乎', '微博', '今天', '最近', '现在', '目前', '实时', '多少钱', '哪个', '哪里', '什么时候'], tokenCost: 60 },
    { name: 'web_fetch', category: 'web', keywords: ['网页', '链接', 'url', '抓取', '网站', '打开网页', '访问'], tokenCost: 55 },
    { name: 'web_extract', category: 'web', keywords: ['网页', '页面', '链接', '内容', '帮我看看', '提取', '抓取', '分析网页', '分析页面'], tokenCost: 60 },
    { name: 'python', category: 'code', keywords: ['python', '计算', '数据分析', '画图', '图表', 'matplotlib', '数学', '统计', 'pandas', 'numpy', '爬虫'], tokenCost: 70 },
    { name: 'sub_agent', category: 'system', keywords: ['调研', '分析', '对比', '总结', '深入研究', '详细调查', '全面了解', '复杂'], tokenCost: 100 },
  ]

  for (const d of defaults) {
    const tool = byName.get(d.name)
    if (tool) {
      selector.register(tool, {
        category: d.category,
        keywords: d.keywords,
        tokenCost: d.tokenCost,
      })
    }
  }

  return selector
}
