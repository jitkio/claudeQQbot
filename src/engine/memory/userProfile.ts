/**
 * 用户画像管理器
 *
 * 参考: Claude Code 的 memdir/ 记忆系统
 *
 * 为每个用户维护持久化的画像文件，包含：
 * - 从对话中自动提取的事实
 * - 用户偏好和纠正记录
 * - 跨会话保留
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import type { UserProfile } from './memoryTypes.js'
import { buildProfileExtractionPrompt } from './prompts.js'
import { safeSessionKey } from '../utils/sessionKey.js'
import { fileMutex } from '../utils/fileMutex.js'

export class UserProfileManager {
  private profileDir: string

  constructor(baseDir: string) {
    this.profileDir = `${baseDir}/profiles`
    mkdirSync(this.profileDir, { recursive: true })
  }

  private getPath(userId: string): string {
    return `${this.profileDir}/${safeSessionKey(userId)}.json`
  }

  load(userId: string): UserProfile {
    const path = this.getPath(userId)
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf-8'))
      } catch { /* 文件损坏，返回新 profile */ }
    }
    return {
      userId,
      facts: [],
      preferences: {},
      corrections: [],
      lastActive: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }
  }

  save(profile: UserProfile) {
    profile.lastActive = new Date().toISOString()
    writeFileSync(this.getPath(profile.userId), JSON.stringify(profile, null, 2))
  }

  /**
   * 从对话中自动提取用户信息并合并到画像
   *
   * 使用廉价模型做提取，异步执行不阻塞主流程
   */
  async extractAndMerge(
    userId: string,
    conversationSnippet: string,
    generateFn: (prompt: string) => Promise<string>,
  ): Promise<void> {
    await fileMutex.withLock(`profile_${userId}`, async () => {
    try {
      const prompt = buildProfileExtractionPrompt(conversationSnippet)
      const raw = await generateFn(prompt)

      // 清理 markdown 代码块包裹
      const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
      const extracted = JSON.parse(cleaned)

      const profile = this.load(userId)

      // 合并姓名
      if (extracted.name && !profile.name) {
        profile.name = extracted.name
      }

      // 合并事实（去重）
      if (Array.isArray(extracted.facts)) {
        for (const fact of extracted.facts) {
          if (fact && !profile.facts.includes(fact)) {
            profile.facts.push(fact)
          }
        }
        // 限制最多 20 条事实
        if (profile.facts.length > 20) {
          profile.facts = profile.facts.slice(-20)
        }
      }

      // 合并纠正
      if (Array.isArray(extracted.corrections)) {
        for (const c of extracted.corrections) {
          if (c && !profile.corrections.includes(c)) {
            profile.corrections.push(c)
          }
        }
        if (profile.corrections.length > 10) {
          profile.corrections = profile.corrections.slice(-10)
        }
      }

      // 合并话题偏好
      if (extracted.preferences?.topics) {
        const existingTopics = new Set(profile.preferences.topics || [])
        for (const t of extracted.preferences.topics) {
          existingTopics.add(t)
        }
        profile.preferences.topics = [...existingTopics].slice(-10)
      }

      this.save(profile)
      console.log(`[Profile] 用户画像已更新: ${userId.slice(0, 8)}... (${profile.facts.length} 条事实)`)
    } catch (e: any) {
      console.error(`[Profile] 画像提取失败: ${e.message}`)
    }
    }) // end withLock
  }

  /** 构建注入到 prompt 中的画像上下文 */
  buildContextInjection(userId: string): string {
    const profile = this.load(userId)
    if (!profile.name && profile.facts.length === 0 && profile.corrections.length === 0) {
      return ''
    }

    let ctx = '<user_profile>\n'
    if (profile.name) ctx += `用户称呼: ${profile.name}\n`
    if (profile.facts.length > 0) {
      ctx += `已知信息:\n${profile.facts.map(f => `- ${f}`).join('\n')}\n`
    }
    if (profile.corrections.length > 0) {
      ctx += `用户曾纠正过:\n${profile.corrections.map(c => `- ${c}`).join('\n')}\n`
    }
    if (profile.preferences.topics?.length) {
      ctx += `常聊话题: ${profile.preferences.topics.join(', ')}\n`
    }
    ctx += '</user_profile>'
    return ctx
  }

  /** 删除用户画像 */
  deleteProfile(userId: string) {
    const path = this.getPath(userId)
    try {
      if (existsSync(path)) {
        const { unlinkSync } = require('fs')
        unlinkSync(path)
      }
    } catch {}
  }
}
