import { spawn } from 'child_process'
import { writeFileSync, unlinkSync } from 'fs'
import type { ToolDef, ToolContext } from '../engine/types.js'

/**
 * Python REPL 工具
 * 执行 Python 代码，适合数据分析、数学计算、画图、数据处理
 */
export const pythonReplTool: ToolDef = {
  name: 'python',
  isReadOnly: false,
  isConcurrencySafe: false,
  description: '执行 Python 代码。适合数据分析、数学计算、画图（matplotlib）、数据处理、文本处理。代码在服务器上直接执行。',
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: '要执行的 Python 代码',
      },
      timeout: {
        type: 'number',
        description: '超时秒数，默认 30',
      },
    },
    required: ['code'],
  },

  async execute(args: Record<string, any>, ctx: ToolContext): Promise<string> {
    const { code, timeout = 30 } = args

    if (!code || typeof code !== 'string') {
      return '[错误] 缺少 code 参数'
    }

    const timestamp = Date.now()
    const scriptPath = `${ctx.workDir}/_temp_${timestamp}.py`

    // 注入安全头
    const safeCode = `import sys, os
os.chdir("${ctx.workDir.replace(/\\/g, '/')}")
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

${code}
`

    try {
      writeFileSync(scriptPath, safeCode, 'utf-8')
    } catch (e: any) {
      return `[错误] 无法写入临时脚本: ${e.message}`
    }

    return new Promise((resolve) => {
      const proc = spawn('python3', [scriptPath], {
        cwd: ctx.workDir,
        env: {
          ...process.env,
          MPLBACKEND: 'Agg',           // matplotlib 不弹窗
          PYTHONIOENCODING: 'utf-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let killed = false

      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

      // 超时处理
      const timer = setTimeout(() => {
        killed = true
        proc.kill('SIGTERM')
        setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 3000)
      }, timeout * 1000)

      proc.on('close', (exitCode: number | null) => {
        clearTimeout(timer)
        // 清理临时文件
        try { unlinkSync(scriptPath) } catch {}

        if (killed) {
          resolve(`[Python 超时] 执行超过 ${timeout} 秒被终止`)
          return
        }

        if (exitCode === 0) {
          const output = stdout.trim()
          resolve(output || '(执行成功，无输出)')
        } else {
          const errMsg = stderr.trim() || stdout.trim()
          resolve(`[Python 错误] 退出码 ${exitCode}\n${errMsg}`.slice(0, 3000))
        }
      })

      proc.on('error', (err: Error) => {
        clearTimeout(timer)
        try { unlinkSync(scriptPath) } catch {}
        resolve(`[Python 启动失败] ${err.message}。请确保服务器安装了 python3`)
      })
    })
  },
}
