/**
 * 记忆系统 prompt 模板
 *
 * 参考: Claude Code 的 SessionMemory/prompts.ts 和 compact/prompt.ts
 *
 * 9 个固定 section：
 *   1. 会话标题      — 只在首次创建时写入
 *   2. 当前状态      — 每次更新必须刷新
 *   3. 任务规格      — 追加合并，不覆盖
 *   4. 已完成工作    — 按时间顺序追加
 *   5. 下一步        — 完成的条目移除
 *   6. 关键文件与资源 — 追加去重
 *   7. 错误与修正    — 追加
 *   8. 决策与理由    — 追加
 *   9. 用户偏好      — 追加覆盖
 */

// ============================================================
// Section 定义（单一数据源）
// ============================================================

export interface SectionSpec {
  /** markdown 标题（不含 # 号） */
  header: string
  /** 斜体描述行（写入模板，模型不得修改） */
  description: string
  /** 更新策略 */
  updatePolicy: 'refresh' | 'merge' | 'append' | 'append-remove' | 'once'
  /** 该 section 允许的最大字符数（近似 = token × 4） */
  maxChars: number
}

/** 9 个 section 的定义，顺序即笔记中的顺序 */
export const SECTION_SPECS: SectionSpec[] = [
  {
    header: '会话标题',
    description: '_5-10 字概括本次对话主题，首次写入后不再修改_',
    updatePolicy: 'once',
    maxChars: 100,
  },
  {
    header: '当前状态',
    description: '_现在正在进行的事情。每次更新必须刷新此段。用进行时：〈正在…〉〈刚刚完成…〉_',
    updatePolicy: 'refresh',
    maxChars: 600,
  },
  {
    header: '任务规格',
    description: '_用户的完整请求：目标、约束、期望的输出形式。防止细节在后续对话中丢失。用户追加新要求时在此处合并而非覆盖。_',
    updatePolicy: 'merge',
    maxChars: 1500,
  },
  {
    header: '已完成工作',
    description: '_按时间顺序列出已做的事，每条一行。格式：`- [工具名] 简述（关键参数/结果）`_',
    updatePolicy: 'append',
    maxChars: 2000,
  },
  {
    header: '下一步',
    description: '_明确的待办清单，每条一行。完成的条目从此处移除（搬到「已完成工作」）。_',
    updatePolicy: 'append-remove',
    maxChars: 1000,
  },
  {
    header: '关键文件与资源',
    description: '_本次对话涉及的文件路径、URL、ID、人名、数字、日期等。按类型分组。出现过的不要删。_',
    updatePolicy: 'append',
    maxChars: 1500,
  },
  {
    header: '错误与修正',
    description: '_遇到的报错、模型的误解、用户的纠正。每条一行：`- [问题] → [解决方式]`_',
    updatePolicy: 'append',
    maxChars: 1500,
  },
  {
    header: '决策与理由',
    description: '_做出的选择及其原因。便于后续一致地执行相同判断。格式：`- 选择 X（因为 Y）`_',
    updatePolicy: 'append',
    maxChars: 1500,
  },
  {
    header: '用户偏好',
    description: '_本次对话中观察到的用户风格偏好：语言/语气/详略/输出格式/回答长度等。_',
    updatePolicy: 'merge',
    maxChars: 800,
  },
]

// ============================================================
// 模板生成
// ============================================================

/** 生成空笔记模板 */
export function buildEmptyTemplate(): string {
  const lines: string[] = []
  for (const spec of SECTION_SPECS) {
    lines.push(`# ${spec.header}`)
    lines.push(spec.description)
    lines.push('')  // 内容区占位
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/** 兼容旧代码：导出默认模板常量 */
export const SESSION_NOTES_TEMPLATE = buildEmptyTemplate()

// ============================================================
// Section 解析器
// ============================================================

/**
 * 把笔记 markdown 解析成 { sectionHeader → 内容 } 字典
 *
 * 解析规则：
 *   - 以 "# " 开头的行为 section 分隔符
 *   - section 下的第一个"以 _ 开头并以 _ 结尾"的行视为描述行，自动跳过
 *   - 剩余内容合并为该 section 的值，首尾空白去除
 */
export function parseNotesSections(notes: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = notes.split('\n')

  let currentSection: string | null = null
  let descriptionSkipped = false
  let buffer: string[] = []

  const flush = () => {
    if (currentSection !== null) {
      result[currentSection] = buffer.join('\n').trim()
    }
  }

  for (const line of lines) {
    const headerMatch = line.match(/^#\s+(.+?)\s*$/)
    if (headerMatch) {
      flush()
      currentSection = headerMatch[1]
      descriptionSkipped = false
      buffer = []
      continue
    }
    if (currentSection === null) continue

    // 第一个斜体描述行自动跳过
    if (!descriptionSkipped && /^_.*_\s*$/.test(line.trim())) {
      descriptionSkipped = true
      continue
    }
    // 非描述行的空行也算作跳过信号（有些模型会丢掉描述行）
    if (!descriptionSkipped && line.trim() === '') {
      descriptionSkipped = true
      continue
    }

    buffer.push(line)
  }
  flush()
  return result
}

/**
 * 验证笔记是否合法：必须包含所有 9 个 section 标题
 * 返回 { valid, missing }
 */
export function validateNotesStructure(notes: string): { valid: boolean; missing: string[] } {
  const missing: string[] = []
  for (const spec of SECTION_SPECS) {
    const re = new RegExp(`^#\\s+${escapeRegex(spec.header)}\\s*$`, 'm')
    if (!re.test(notes)) missing.push(spec.header)
  }
  return { valid: missing.length === 0, missing }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 对笔记做硬性大小约束：
 *   - 逐 section 检查，超过 maxChars 的头部截断，加压缩提示
 *   - 代码兜底，避免模型忘记压缩时笔记无限增长
 */
export function enforceSectionLimits(notes: string): string {
  const sections = parseNotesSections(notes)
  const out: string[] = []

  for (const spec of SECTION_SPECS) {
    out.push(`# ${spec.header}`)
    out.push(spec.description)

    let content = sections[spec.header] ?? ''
    if (content.length > spec.maxChars) {
      // 从开头裁剪，保留最近的内容（通常对话里靠后的更重要）
      const over = content.length - spec.maxChars
      const trimmed = content.slice(over)
      // 往回找最近的换行作为切口，避免切在单词/行中间
      const nlIdx = trimmed.indexOf('\n')
      content = `_[…早期内容已自动压缩，原长 ${content.length} 字]_\n` +
                (nlIdx >= 0 && nlIdx < 200 ? trimmed.slice(nlIdx + 1) : trimmed)
    }

    out.push(content)
    out.push('')
  }

  return out.join('\n').trimEnd() + '\n'
}

// ============================================================
// 更新 prompt 构建
// ============================================================

/**
 * 构造笔记更新的 prompt
 *
 * 设计要点：
 *   1. 明确告诉模型每个 section 的更新策略（refresh/merge/append/once）
 *   2. 禁止模型删除 section 标题和描述行
 *   3. 禁止写占位符
 *   4. 要求在超长时自己压缩旧内容
 *   5. 直接输出完整笔记，不加任何解释或 markdown 代码块包裹
 */
export function buildNotesUpdatePrompt(currentNotes: string, _notesPath?: string): string {
  // 按 section 生成策略说明
  const policyLines = SECTION_SPECS.map((s, i) => {
    const policyDesc = {
      once: '只在笔记完全为空时写一次，此后永远不改',
      refresh: '每次都必须改写，反映当前最新进展',
      merge: '与现有内容合并，新信息追加，旧细节保留',
      append: '在现有内容末尾追加新条目，不删旧的',
      'append-remove': '追加新条目；已完成的旧条目移除（搬到相应 section）',
    }[s.updatePolicy]
    return `${i + 1}. **${s.header}**（策略: ${s.updatePolicy}）— ${policyDesc}，上限约 ${s.maxChars} 字`
  }).join('\n')

  return `你是会话笔记更新助手。基于上方的对话历史，更新下面的会话笔记。

<current_notes>
${currentNotes}
</current_notes>

## 更新规则（严格遵守）

${policyLines}

## 通用约束

- **不要修改或删除** 任何 \`# 标题\` 行和紧随其后的 \`_斜体描述_\` 行
- **禁止占位符**：不要写"暂无"/"无"/"N/A"/"待补充"，没内容就留空
- **具体优于抽象**：写具体的文件名、行号、变量名、错误信息，不要写"改了一些文件"
- **压缩超长内容**：某个 section 接近上限时，把早期内容合并成一行摘要，给近期内容腾位置
- **不要提及笔记更新过程本身**，不要写"我更新了 X section"这类元描述
- **只输出完整的新笔记**，不要加解释、不要用代码块包裹、不要加任何前后缀文字

直接开始输出：`
}

// ============================================================
// 上下文压缩 prompt（沿用原实现）
// ============================================================

export function buildCompactPrompt(): string {
  return `请为以下对话创建一份详细摘要。这份摘要将用于在上下文窗口不够时替代原始对话历史。

先在 <analysis> 标签中分析对话要点，然后在 <summary> 标签中写出正式摘要。

摘要必须包含以下部分：
1. 用户的核心请求：用户想做什么？
2. 已完成的工作：做了哪些事，结果如何？
3. 遇到的问题：出了什么错，怎么修的？
4. 用户的所有消息：列出所有非工具结果的用户消息要点
5. 待办事项：还有什么没做完？
6. 当前进展：最近在做什么？做到哪了？

<analysis>
[你的分析过程]
</analysis>

<summary>
[正式摘要]
</summary>`
}

/** 从压缩结果中提取 summary，剥掉 analysis */
export function extractCompactSummary(raw: string): string {
  let result = raw.replace(/<analysis>[\s\S]*?<\/analysis>/i, '')
  const match = result.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (match) result = match[1].trim()
  return result.trim()
}

// ============================================================
// 用户画像提取 prompt（沿用原实现）
// ============================================================

export function buildProfileExtractionPrompt(conversation: string): string {
  return `分析以下对话，提取关于用户的新事实。

只输出 JSON，格式如下。如果没有新信息，对应字段为空数组。
{
  "name": "用户姓名（如果提到的话，否则 null）",
  "facts": ["事实1", "事实2"],
  "corrections": ["用户纠正的内容"],
  "preferences": {
    "topics": ["经常讨论的话题"]
  }
}

对话内容：
${conversation}

只输出 JSON，不要加任何解释。`
}