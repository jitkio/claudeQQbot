import type { ToolDef } from '../engine/types.js'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

export const fileEditTool: ToolDef = {
  name: 'edit_file',
  isReadOnly: false,
  isConcurrencySafe: false,
  description: '编辑文件：在文件中查找指定文本并替换为新文本。适合精确修改文件的某一部分。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要被替换的原始文本（必须精确匹配）' },
      new_string: { type: 'string', description: '替换后的新文本' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(args, ctx) {
    const filePath = resolve(ctx.workDir, args.path)
    try {
      const content = readFileSync(filePath, 'utf-8')
      if (!content.includes(args.old_string)) {
        return `[错误] 在文件中未找到要替换的文本。请确认 old_string 完全匹配文件中的内容。`
      }
      const count = content.split(args.old_string).length - 1
      if (count > 1) {
        return `[错误] old_string 在文件中出现了 ${count} 次，请提供更多上下文使其唯一。`
      }
      const newContent = content.replace(args.old_string, args.new_string)
      writeFileSync(filePath, newContent, 'utf-8')
      return `文件已编辑: ${filePath}`
    } catch (e: any) {
      return `[错误] 编辑文件失败: ${e.message}`
    }
  },
}
