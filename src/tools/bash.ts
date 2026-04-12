import type { ToolDef, ToolContext } from '../engine/types.js'
import { spawn } from 'child_process'
import { checkBashCommand } from '../engine/permission/permissionEngine.js'
import { interpretExitCode } from '../engine/permission/commandSemantics.js'
import { parseCommand } from '../engine/permission/commandParser.js'
import { isParsedCommandReadOnly } from '../engine/permission/readOnlyRegistry.js'
import type { PermissionContext } from '../engine/permission/permissionTypes.js'

interface BashArgs {
  command: string
  timeout?: number
}

export const bashTool: ToolDef = {
  name: 'bash',
  /**
   * bash 的只读性取决于命令内容，复用 permissionEngine 的完整判定
   */
  isReadOnly: (input: any) => {
    try {
      const cmd = (input?.command || '').trim()
      if (!cmd) return false
      const parsed = parseCommand(cmd)
      return isParsedCommandReadOnly(parsed)
    } catch {
      return false
    }
  },
  /**
   * 并发安全 = 只读（读操作可以并发，写操作绝对不能）
   * 但 apt/dpkg 等即使是 list 也涉及 dpkg 锁，不并发
   */
  isConcurrencySafe: (input: any) => {
    try {
      const cmd = (input?.command || '').trim()
      if (!cmd) return false
      const parsed = parseCommand(cmd)
      if (!isParsedCommandReadOnly(parsed)) return false
      // 包管理器即使只读也涉及锁文件，不并发
      const lockSensitive = ['apt', 'apt-get', 'dpkg', 'yum', 'dnf', 'pacman', 'brew']
      for (const sc of parsed.subcommands) {
        if (lockSensitive.includes(sc.baseCommand)) return false
      }
      return true
    } catch {
      return false
    }
  },
  description: '执行 shell 命令。可以运行任何 Linux/Windows 命令，如 ls、cat、grep、python、node 等。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      timeout: { type: 'number', description: '超时毫秒数，默认 30000' },
    },
    required: ['command'],
  },
  async execute(args: Record<string, any>, ctx: ToolContext): Promise<string> {
    const { command, timeout: argTimeout } = args as BashArgs
    const timeout = argTimeout || 30000
    const permCtx: PermissionContext | undefined = ctx.permissionContext

    // ========== 权限审查 ==========
    if (permCtx) {
      const decision = checkBashCommand(command, permCtx, ctx.workDir)

      // 记审计
      ctx.auditLog?.record({
        sessionKey: permCtx.sessionKey,
        userId: permCtx.userId,
        mode: permCtx.mode,
        toolName: 'bash',
        toolInput: command,
        decision: decision.behavior,
        reason: decision.reason,
        warnings: 'warnings' in decision ? decision.warnings : undefined,
      })

      if (decision.behavior === 'deny') {
        return `[权限拒绝] ${decision.reason}`
      }

      if (decision.behavior === 'ask') {
        const accepted = await ctx.confirmBridge?.askConfirm({
          userId: permCtx.userId,
          command,
          reason: decision.reason,
          warnings: decision.warnings,
        })
        if (!accepted) {
          return `[用户拒绝] ${decision.reason}`
        }
      }
    }

    // ========== 真正执行 ==========
    return new Promise((resolve) => {
      const proc = spawn(process.platform === 'win32' ? 'cmd' : 'sh',
        process.platform === 'win32' ? ['/c', command] : ['-c', command],
        { cwd: ctx.workDir, timeout, env: { ...process.env } }
      )

      let stdout = '', stderr = ''
      proc.stdout.on('data', (d: Buffer) => { stdout += d })
      proc.stderr.on('data', (d: Buffer) => { stderr += d })

      const timer = setTimeout(() => {
        proc.kill('SIGTERM')
        resolve(`[超时] 命令执行超过 ${timeout}ms 被终止\n${stdout}`)
      }, timeout)

      proc.on('close', (code) => {
        clearTimeout(timer)
        const exitCode = code ?? 1

        // 用 semantics 表重新解释 exit code
        const baseCommand = command.trim().split(/\s+/)[0] || ''
        const interp = interpretExitCode(baseCommand, exitCode, stdout, stderr)

        if (exitCode === 0) {
          resolve(stdout.trim() || '（命令执行成功，无输出）')
        } else if (!interp.isError) {
          // exit != 0 但语义上不是错误（比如 grep 没找到）
          const output = stdout.trim()
          resolve(output + (interp.note ? `\n[${interp.note}]` : '') || `[${interp.note || '非错误退出'}]`)
        } else {
          const output = stdout + (stderr ? `\n[stderr] ${stderr}` : '')
          resolve(`[退出码 ${exitCode}] ${output.trim()}`)
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        resolve(`[错误] ${err.message}`)
      })

      if (ctx.abortSignal) {
        ctx.abortSignal.addEventListener('abort', () => proc.kill('SIGTERM'))
      }
    })
  },
}
