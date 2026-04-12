import type { ToolDef } from '../engine/types.js'
import { readdirSync, statSync } from 'fs'
import { resolve, join, relative } from 'path'

interface GlobArgs {
  pattern: string
  path?: string
}

export const globTool: ToolDef = {
  name: 'glob',
  isReadOnly: true,
  isConcurrencySafe: true,
  description: '按文件名模式搜索文件。支持 * 和 ** 通配符。返回匹配的文件路径列表。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索模式，如 "*.ts"、"src/**/*.js"、"*.md"' },
      path: { type: 'string', description: '搜索目录（默认工作目录）' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    const { pattern, path: argPath } = args as GlobArgs
    const searchDir = argPath ? resolve(ctx.workDir, argPath) : ctx.workDir

    // 简单的 glob 实现
    const regex = patternToRegex(pattern)
    const results: string[] = []
    const maxResults = 100

    function walk(dir: string, depth: number) {
      if (depth > 10 || results.length >= maxResults) return
      try {
        const entries = readdirSync(dir)
        for (const entry of entries) {
          if (entry.startsWith('.') || entry === 'node_modules') continue
          const full = join(dir, entry)
          const rel = relative(searchDir, full)
          try {
            const stat = statSync(full)
            if (stat.isFile() && regex.test(rel)) {
              results.push(rel)
            } else if (stat.isDirectory()) {
              walk(full, depth + 1)
            }
          } catch {}
        }
      } catch {}
    }

    walk(searchDir, 0)

    if (results.length === 0) return `未找到匹配 "${pattern}" 的文件`
    return results.slice(0, maxResults).join('\n') +
      (results.length >= maxResults ? `\n... (结果已截断，共 ${maxResults}+ 个匹配)` : '')
  },
}

function patternToRegex(pattern: string): RegExp {
  let re = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${re}$`, 'i')
}
