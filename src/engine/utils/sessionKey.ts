/**
 * 把 sessionKey sanitize 成安全的文件名片段。
 * 只允许字母、数字、下划线、连字符，其他字符替换为下划线，长度限制在 100。
 *
 * 防御性措施：正常情况下 sessionKey 格式是 `c2c_xxx` / `group_xxx`，
 * 但任何拼接路径的代码都应该走这个函数，避免路径穿越漏洞。
 */
export function safeSessionKey(sessionKey: string): string {
  if (!sessionKey || typeof sessionKey !== 'string') return 'unknown'
  return sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)
}
