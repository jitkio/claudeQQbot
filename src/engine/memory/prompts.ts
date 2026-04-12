/**
 * 记忆系统 prompt 模板
 *
 * 参考: Claude Code 的 SessionMemory/prompts.ts 和 compact/prompt.ts
 */

// ==================== 会话笔记模板 ====================

export const SESSION_NOTES_TEMPLATE = `# 会话标题
_用5-10个字描述这次对话的核心主题_

# 当前状态
_用户当前在做什么？有什么待完成的事？下一步是什么？_

# 用户需求
_用户提出了什么请求？有什么设计决策或背景说明？_

# 关键信息
_对话中提到的重要事实：人名、地点、日期、数字、链接等_

# 错误与纠正
_遇到了什么问题？怎么解决的？用户纠正了什么？_

# 经验教训
_什么方法有效？什么无效？以后应该避免什么？_

# 重要结果
_如果用户要求了具体输出（答案、表格、方案等），在这里记录原文_

# 操作日志
_按时间顺序，每一步做了什么？非常简短_
`

// ==================== 笔记更新 prompt ====================

export function buildNotesUpdatePrompt(currentNotes: string, notesPath: string): string {
  return `你是一个笔记更新助手。基于上面的对话内容（不包括本条指令），更新会话笔记文件。

当前笔记内容：
<current_notes>
${currentNotes}
</current_notes>

更新规则：
1. 不要修改或删除 section 标题（# 开头的行）和斜体描述（_开头结尾的行）
2. 只更新描述行下面的实际内容
3. "当前状态"必须每次更新，反映最新进展
4. 每个 section 不超过 300 字，超了要压缩旧内容
5. 写具体的、有信息量的内容，不要写"暂无"之类的占位
6. 不要提及这个笔记更新过程本身
7. 如果某个 section 没有新内容可加，就不要改它

直接输出更新后的完整笔记内容，不要加任何解释。`
}

// ==================== 上下文压缩 prompt ====================

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
  // 剥掉 analysis 部分
  let result = raw.replace(/<analysis>[\s\S]*?<\/analysis>/i, '')
  // 提取 summary 内容
  const match = result.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (match) {
    result = match[1].trim()
  }
  return result.trim()
}

// ==================== 用户画像提取 prompt ====================

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
