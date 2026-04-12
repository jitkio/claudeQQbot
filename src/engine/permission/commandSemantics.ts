/** exit code 解释结果 */
export interface ExitInterpretation {
  isError: boolean
  note?: string  // 非错误但值得记录的说明，比如"未找到匹配"
}

type SemanticFn = (exitCode: number, stdout: string, stderr: string) => ExitInterpretation

const DEFAULT_SEMANTIC: SemanticFn = (exitCode) => ({
  isError: exitCode !== 0,
  note: exitCode !== 0 ? `Command failed with exit code ${exitCode}` : undefined,
})

/** 参照 $CC/tools/BashTool/commandSemantics.ts 第 31-89 行的 COMMAND_SEMANTICS Map */
const COMMAND_SEMANTICS = new Map<string, SemanticFn>([
  ['grep', (code) => ({ isError: code >= 2, note: code === 1 ? '未找到匹配' : undefined })],
  ['rg', (code) => ({ isError: code >= 2, note: code === 1 ? '未找到匹配' : undefined })],
  ['egrep', (code) => ({ isError: code >= 2, note: code === 1 ? '未找到匹配' : undefined })],
  ['fgrep', (code) => ({ isError: code >= 2, note: code === 1 ? '未找到匹配' : undefined })],
  ['find', (code) => ({ isError: code >= 2, note: code === 1 ? '部分目录不可访问' : undefined })],
  ['diff', (code) => ({ isError: code >= 2, note: code === 1 ? '文件有差异' : undefined })],
  ['test', (code) => ({ isError: code >= 2, note: code === 1 ? '条件为假' : undefined })],
  ['[',    (code) => ({ isError: code >= 2, note: code === 1 ? '条件为假' : undefined })],
  ['cmp',  (code) => ({ isError: code >= 2, note: code === 1 ? '文件不同' : undefined })],
])

/**
 * 根据命令名解释 exit code
 *
 * 参照 $CC/tools/BashTool/commandSemantics.ts 第 124-140 行 interpretCommandResult
 */
export function interpretExitCode(
  baseCommand: string,
  exitCode: number,
  stdout: string,
  stderr: string,
): ExitInterpretation {
  const fn = COMMAND_SEMANTICS.get(baseCommand) ?? DEFAULT_SEMANTIC
  return fn(exitCode, stdout, stderr)
}
