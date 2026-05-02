import { ModelAdapter } from './base.js'
import type { Message, ToolDef, ModelResponse, ModelConfig } from '../engine/types.js'
import { spawn } from 'child_process'
import { openSync, closeSync } from 'fs'

/**
 */
export class ClaudeCodeAdapter extends ModelAdapter {
  private workDir: string

  constructor(config: ModelConfig, workDir: string) {
    super(config)
    this.workDir = workDir
  }

  formatTools(_tools: ToolDef[]): any[] { return [] }
  parseResponse(raw: any): ModelResponse {
    return { content: String(raw), toolCalls: [], finishReason: 'stop' }
  }

  async chat(messages: Message[], _tools: ToolDef[], options?: { signal?: AbortSignal }): Promise<ModelResponse> {
    // 从消息中提取最后一条 user 消息作为 prompt
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    const prompt = lastUser?.content || ''

    if (!prompt) {
      return { content: '（无输入）', toolCalls: [], finishReason: 'stop' }
    }

    const result = await this.runClaude(prompt, options?.signal)
    return { content: result, toolCalls: [], finishReason: 'stop' }
  }

  private runClaude(prompt: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['-p', prompt, '--dangerously-skip-permissions']

      let devnull: number | undefined
      try { devnull = openSync('/dev/null', 'r') } catch { devnull = undefined }

      const proc = spawn('claude', args, {
        cwd: this.workDir,
        env: { ...process.env },
        stdio: [devnull !== undefined ? devnull : 'ignore', 'pipe', 'pipe'],
      })

      let stdout = '', stderr = ''
      proc.stdout.on('data', (d: Buffer) => { stdout += d })
      proc.stderr.on('data', (d: Buffer) => { stderr += d })

      proc.on('close', (code: number | null) => {
        if (devnull !== undefined) try { closeSync(devnull) } catch {}
        if (code === 0) resolve(stdout.trim() || '（执行完毕）')
        else reject(new Error(stderr.slice(0, 500) || `退出码${code}`))
      })

      proc.on('error', (err: Error) => reject(err))

      if (signal) {
        signal.addEventListener('abort', () => {
          proc.kill('SIGTERM')
          setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 5000)
        })
      }
    })
  }
}
