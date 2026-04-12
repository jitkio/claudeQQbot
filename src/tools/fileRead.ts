import type { ToolDef } from '../engine/types.js'
import { readFileSync, statSync } from 'fs'

export const fileReadTool: ToolDef = {
  name: 'read_file',
  isReadOnly: true,
  isConcurrencySafe: true,
  description: '读取文件内容。支持文本文件、代码文件等。返回文件内容字符串。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对于工作目录或绝对路径）' },
      maxLines: { type: 'number', description: '最多读取行数，默认不限' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const { resolve } = await import('path')
    const filePath = resolve(ctx.workDir, args.path)

    try {
      const stat = statSync(filePath)
      if (stat.isDirectory()) return `[错误] ${filePath} 是目录，不是文件`
      if (stat.size > 1024 * 1024) return `[警告] 文件过大 (${(stat.size / 1024).toFixed(0)}KB)，只读取前 1MB`

      let content = readFileSync(filePath, 'utf-8')
      if (args.maxLines) {
        const lines = content.split('\n')
        if (lines.length > args.maxLines) {
          content = lines.slice(0, args.maxLines).join('\n') + `\n... (共 ${lines.length} 行，只显示前 ${args.maxLines} 行)`
        }
      }
      return content
    } catch (e: any) {
      return `[错误] 读取文件失败: ${e.message}`
    }
  },
}
