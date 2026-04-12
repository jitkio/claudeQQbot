import type { ToolDef, ToolContext } from '../engine/types.js'
import { spawn } from 'child_process'
import { checkBashCommand } from '../engine/permission/permissionEngine.js'
import { interpretExitCode } from '../engine/permission/commandSemantics.js'
import type { PermissionContext } from '../engine/permission/permissionTypes.js'

export const bashTool: ToolDef = {
  name: 'bash',
  /**
   * bash 的只读性取决于命令内容，动态判定
   * 参照 readOnlyRegistry.isParsedCommandReadOnly 的逻辑
   */
  isReadOnly: (input: any) => {
    const cmd = (input?.command || '').trim().toLowerCase()
    const readOnlyPrefixes = ['ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'file', 'which', 'whoami', 'pwd', 'echo', 'date', 'uptime', 'df', 'du', 'free', 'env', 'printenv', 'type', 'stat', 'uname']
    const firstWord = cmd.split(/\s+/)[0]?.replace(/^(sudo\s+)/, '') || ''
    return readOnlyPrefixes.includes(firstWord)
  },
  /**
   * bash 的并发安全性 = 只读命令才安全
   * 写操作（rm、mv、cp、apt install 等）必须串行
   */
  isConcurrencySafe: (input: any) => {
    const cmd = (input?.command || '').trim().toLowerCase()
    const readOnlyPrefixes = ['ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'file', 'which', 'whoami', 'pwd', 'echo', 'date', 'uptime', 'df', 'du', 'free', 'env', 'printenv', 'type', 'stat', 'uname']
    const firstWord = cmd.split(/\s+/)[0]?.replace(/^(sudo\s+)/, '') || ''
    return readOnlyPrefixes.includes(firstWord)
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
    const command = args.command as string
    const timeout = (args.timeout as number) || 30000
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
