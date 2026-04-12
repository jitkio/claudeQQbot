import type { ToolDef } from '../engine/types.js'
import { writeFileSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'

export const fileWriteTool: ToolDef = {
  name: 'write_file',
  isReadOnly: false,
  isConcurrencySafe: false,
  description: '写入文件内容。如果文件不存在会创建，如果存在会覆盖。自动创建父目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '要写入的内容' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    const filePath = resolve(ctx.workDir, args.path)
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, args.content, 'utf-8')
      return `文件已写入: ${filePath} (${args.content.length} 字符)`
    } catch (e: any) {
      return `[错误] 写入文件失败: ${e.message}`
    }
  },
}
