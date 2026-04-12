import type { ToolDef } from '../engine/types.js'
import { spawn } from 'child_process'
import { resolve } from 'path'

export const grepTool: ToolDef = {
  name: 'grep',
  isReadOnly: true,
  isConcurrencySafe: true,
  description: '在文件内容中搜索文本或正则表达式。返回匹配的文件名和行内容。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索的文本或正则表达式' },
      path: { type: 'string', description: '搜索目录（默认工作目录）' },
      include: { type: 'string', description: '文件名过滤，如 "*.ts"' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    const searchDir = args.path ? resolve(ctx.workDir, args.path) : ctx.workDir
    const pattern = args.pattern as string
    const include = args.include as string | undefined

    return new Promise((res) => {
      const cmdArgs = ['-rn', '--max-count=50']
      if (include) cmdArgs.push(`--include=${include}`)
      cmdArgs.push('--', pattern, searchDir)

      const proc = spawn('grep', cmdArgs, { cwd: ctx.workDir, timeout: 15000 })
      let output = ''
      proc.stdout.on('data', (d: Buffer) => {
        output += d
        if (output.length > 50000) output = output.slice(0, 50000)
      })
      proc.stderr.on('data', () => {})  // 忽略 stderr
      proc.on('close', () => {
        res(output.trim() || `未找到匹配 "${pattern}" 的内容`)
      })
      proc.on('error', () => {
        res(`[错误] grep 命令不可用，请使用 bash 工具手动搜索`)
      })
    })
  },
}
