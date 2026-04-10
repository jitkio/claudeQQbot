// Markdown → QQ 纯文本清洗
// 用法: echo "markdown文本" | node strip_markdown.cjs
// 或:   node strip_markdown.cjs "markdown文本"

function stripMarkdown(text) {
  return text
    // 代码围栏 → 保留内容，去掉 ```
    .replace(/```[\w]*\n?([\s\S]*?)```/g, '$1')
    // 行内代码 → 去掉反引号
    .replace(/`([^`]+)`/g, '$1')
    // 粗体+斜体 → 去掉 *** 或 ___
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/___(.+?)___/g, '$1')
    // 粗体 → 去掉 ** 或 __
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    // 斜体 → 去掉 * 或 _（注意不匹配文件路径中的下划线）
    .replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '$1')
    // 标题 → 去掉 # 号，保留文字
    .replace(/^#{1,6}\s+(.+)$/gm, '$1')
    // 水平线 → 去掉
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // 链接 [text](url) → text (url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    // 图片 ![alt](url) → [图片: alt]
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '[图片: $1]')
    // 引用块 → 去掉 > 前缀
    .replace(/^>\s?/gm, '')
    // 清理多余空行（3个以上连续空行 → 2个）
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 从 stdin 或 argv 读取
if (process.argv[2]) {
  console.log(stripMarkdown(process.argv[2]))
} else {
  let data = ''
  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', chunk => data += chunk)
  process.stdin.on('end', () => console.log(stripMarkdown(data)))
}
