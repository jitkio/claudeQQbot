import { parseCommand } from './commandParser.js'
import { isParsedCommandReadOnly } from './readOnlyRegistry.js'
import { checkWritePath, extractPathArgs, isDangerousPath } from './pathGuard.js'
import { detectDestructive } from './destructiveDetector.js'
import type { PermissionContext, PermissionDecision, ParsedCommand } from './permissionTypes.js'

/**
 * 审查一次 bash 工具调用，返回决策
 *
 * 决策链（从严到宽）：
 * 1. bypass 模式 → allow
 * 2. critical 破坏性 → ask（即使是 auto 模式也要问）
 * 3. plan 模式 + 非只读 → deny
 * 4. strict 模式 + bash → ask
 * 5. 命令只读 + 无危险路径 → allow
 * 6. 写路径不在 workspace → ask
 * 7. 命中危险路径黑名单 → deny
 * 8. 默认 → allow
 */
export function checkBashCommand(
  command: string,
  ctx: PermissionContext,
  cwd: string,
): PermissionDecision {
  // Step 1: 解析
  const parsed = parseCommand(command)
  const warnings: string[] = []

  // Step 2: bypass 优先
  if (ctx.mode === 'bypass' && ctx.bypassEnvFlag) {
    return { behavior: 'allow', reason: 'bypass 模式，全部放行' }
  }

  // Step 3: shell 元字符检测
  if (parsed.hasShellMeta) {
    warnings.push('命令包含 shell 元字符（$() ${} <() 等），有注入风险')
  }

  // Step 4: 破坏性检测（最高优先级）
  const destructive = detectDestructive(command)
  if (destructive.length > 0) {
    warnings.push(...destructive.map(d => `⚠️ ${d.warning}`))

    if (destructive.some(d => d.severity === 'critical')) {
      // critical 级别：plan/strict/default/auto 都要 ask，只有 bypass 才会放行
      return {
        behavior: 'ask',
        reason: `检测到高危操作：${destructive.find(d => d.severity === 'critical')!.warning}`,
        warnings,
      }
    }
  }

  // Step 5: plan 模式 —— 只允许只读
  const isReadOnly = isParsedCommandReadOnly(parsed)
  if (ctx.mode === 'plan') {
    if (isReadOnly) {
      return { behavior: 'allow', reason: 'plan 模式，命令为只读' }
    }
    return {
      behavior: 'deny',
      reason: 'plan 模式下只允许只读命令。如需执行写操作，请先切换到 default 或 auto 模式（发送 /auto）',
    }
  }

  // Step 6: strict 模式 —— 任何 bash 都要确认
  if (ctx.mode === 'strict') {
    return {
      behavior: 'ask',
      reason: 'strict 模式下所有 bash 命令都需要确认',
      warnings,
    }
  }

  // Step 7: 只读命令直接放行（default / auto 模式）
  if (isReadOnly) {
    return { behavior: 'allow', reason: '只读命令' }
  }

  // Step 8: 路径检查 —— 检查 rm / mv / cp / > 重定向等写操作的目标路径
  const pathsToCheck = collectWritePaths(parsed)
  for (const p of pathsToCheck) {
    // 危险路径直接拒绝
    if (isDangerousPath(p)) {
      return { behavior: 'deny', reason: `目标路径极度危险：${p}` }
    }
    // workspace 边界检查
    const check = checkWritePath(p, ctx, cwd)
    if (!check.allowed) {
      if (check.isDangerous) {
        return { behavior: 'deny', reason: check.reason }
      }
      warnings.push(`路径超出 workspace：${check.path}`)
      // 不在 workspace 内 → 在 default/strict 下 ask，在 auto 下 ask
      return { behavior: 'ask', reason: check.reason, warnings }
    }
  }

  // Step 9: auto 模式 —— 通过前面所有检查就放行
  if (ctx.mode === 'auto') {
    return { behavior: 'allow', reason: 'auto 模式，通过所有自动检查' }
  }

  // Step 10: default 模式 —— 写操作要 ask
  return {
    behavior: 'ask',
    reason: 'default 模式下写操作需要确认',
    warnings,
  }
}

/** 从解析后的命令中收集所有写路径 */
function collectWritePaths(parsed: ParsedCommand): string[] {
  const paths: string[] = []

  // 重定向目标（> >> 写入）
  paths.push(...parsed.redirectTargets)

  // 各子命令的写路径参数
  for (const sc of parsed.subcommands) {
    const writeCommands = ['rm', 'rmdir', 'mv', 'cp', 'dd', 'tee', 'touch', 'mkdir']
    if (writeCommands.includes(sc.baseCommand)) {
      paths.push(...extractPathArgs(sc.args))
    }
    // sed -i 是隐蔽写
    if (sc.baseCommand === 'sed' && sc.args.includes('-i')) {
      const fileArgs = sc.args.filter(a => !a.startsWith('-') && !a.startsWith("'") && !a.startsWith('"'))
      paths.push(...fileArgs.slice(1))  // 第一个非 flag 是表达式
    }
  }

  return paths
}
