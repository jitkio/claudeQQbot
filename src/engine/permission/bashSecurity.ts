import type { ParsedCommand } from './permissionTypes.js'

// ============================================================
// 类型定义
// ============================================================

export type ThreatSeverity = 'critical' | 'high' | 'medium'

export type ThreatCategory =
  | 'reverse_shell'   // 反弹 shell / 远程控制
  | 'exfiltration'    // 数据外传
  | 'credential'      // 凭据窃取
  | 'evasion'         // 规避 / 逃逸检测
  | 'persistence'     // 持久化 / 植入后门
  | 'obfuscation'     // 混淆执行

export interface SecurityThreat {
  id: string
  severity: ThreatSeverity
  category: ThreatCategory
  message: string
  evidence: string   // 命令中触发规则的片段（截断至 80 字符）
}

interface Rule {
  id: string
  pattern: RegExp
  category: ThreatCategory
  severity: ThreatSeverity
  message: string
}

// ============================================================
// 规则库
// ============================================================
// 设计原则：
//   1. critical 规则必须几乎没有合法用例——一旦命中直接拒绝
//   2. high 规则有少量合法用例但必须人审——命中强制 ask
//   3. medium 规则只作为观察信号——不阻断，只在 warnings 里提示
// ============================================================

const RULES: Rule[] = [
  // ------------------------------------------------------------
  // CRITICAL —— 反弹 Shell
  // ------------------------------------------------------------
  {
    id: 'DEV_TCP_BACKDOOR',
    severity: 'critical',
    category: 'reverse_shell',
    message: 'bash /dev/tcp 伪设备反弹 shell',
    pattern: /\/dev\/(?:tcp|udp)\/[^\s/]+\/\d+/,
  },
  {
    id: 'NC_EXEC_BACKDOOR',
    severity: 'critical',
    category: 'reverse_shell',
    message: 'netcat -e / --exec / --sh-exec 执行外部命令（经典反弹 shell）',
    pattern: /\bn(?:c|cat)\b[^;&|\n]*(?:\s-e\b|--exec\b|--sh-exec\b|\s-c\b)/,
  },
  {
    id: 'SOCAT_EXEC_BACKDOOR',
    severity: 'critical',
    category: 'reverse_shell',
    message: 'socat + EXEC/SYSTEM 反弹 shell',
    pattern: /\bsocat\b[^;&|\n]*(?:EXEC|SYSTEM):/i,
  },
  {
    id: 'BASH_INTERACTIVE_REDIRECT',
    severity: 'critical',
    category: 'reverse_shell',
    message: '交互式 shell 重定向到 socket（反弹 shell 典型模式）',
    pattern: /\b(?:bash|sh|zsh)\s+-i\b[^;&|\n]*(?:>&|&>|1>&|<&)\s*\/dev\/(?:tcp|udp)/,
  },
  {
    id: 'PYTHON_REVERSE_SHELL',
    severity: 'critical',
    category: 'reverse_shell',
    message: 'Python socket + subprocess/os.dup2 反弹 shell',
    pattern: /\bpython[0-9.]*\s+-c\b[^;]*socket[^;]*(?:subprocess|os\.dup2|os\.fdopen|pty\.spawn)/s,
  },
  {
    id: 'PERL_REVERSE_SHELL',
    severity: 'critical',
    category: 'reverse_shell',
    message: 'Perl socket 反弹 shell',
    pattern: /\bperl\s+-e\b[^;]*(?:socket|IO::Socket)[^;]*(?:exec|system|open)/s,
  },
  {
    id: 'RUBY_REVERSE_SHELL',
    severity: 'critical',
    category: 'reverse_shell',
    message: 'Ruby socket 反弹 shell',
    pattern: /\bruby\s+-r\s*socket\s+-e\b/,
  },
  {
    id: 'PHP_REVERSE_SHELL',
    severity: 'critical',
    category: 'reverse_shell',
    message: 'PHP fsockopen 反弹 shell',
    pattern: /\bphp\s+-r\b[^;]*(?:fsockopen|stream_socket_client)/,
  },
  {
    id: 'MKFIFO_BACKPIPE',
    severity: 'critical',
    category: 'reverse_shell',
    message: 'mkfifo 命名管道 + nc 反弹 shell',
    pattern: /\bmkfifo\b[^;&|\n]+[;&|\n][^;]*\b(?:nc|ncat)\b/,
  },

  // ------------------------------------------------------------
  // CRITICAL —— 混淆执行
  // ------------------------------------------------------------
  {
    id: 'BASE64_PIPE_SHELL',
    severity: 'critical',
    category: 'obfuscation',
    message: 'base64 解码后管道给 shell 执行（典型混淆攻击）',
    pattern: /\bbase64\b[^|;&\n]*(?:-d|--decode|-D)\b[^|;\n]*\|\s*(?:bash|sh|zsh|csh|fish|ksh)\b/,
  },
  {
    id: 'XXD_PIPE_SHELL',
    severity: 'critical',
    category: 'obfuscation',
    message: 'xxd -r 反十六进制 + 管道 shell（二进制混淆执行）',
    pattern: /\bxxd\s+-r\b[^|;\n]*\|\s*(?:bash|sh|zsh)\b/,
  },
  {
    id: 'PRINTF_PIPE_SHELL',
    severity: 'critical',
    category: 'obfuscation',
    message: 'printf 生成转义字节 + 管道 shell（混淆执行）',
    pattern: /\bprintf\s+['"]\\x[0-9a-fA-F]{2}[^|]*\|\s*(?:bash|sh|zsh)\b/,
  },

  // ------------------------------------------------------------
  // CRITICAL —— 密码哈希文件
  // ------------------------------------------------------------
  {
    id: 'SHADOW_READ',
    severity: 'critical',
    category: 'credential',
    message: '访问 /etc/shadow 或 sudoers 配置（系统密码/提权文件）',
    pattern: /\/etc\/(?:shadow|gshadow|sudoers(?:\.d)?)\b/,
  },

  // ------------------------------------------------------------
  // CRITICAL —— SSH 后门植入
  // ------------------------------------------------------------
  {
    id: 'AUTHORIZED_KEYS_APPEND',
    severity: 'critical',
    category: 'persistence',
    message: '向 SSH authorized_keys 追加密钥（植入 SSH 后门）',
    pattern: />>\s*[~/][^;&|\s]*\.ssh\/authorized_keys/,
  },

  // ------------------------------------------------------------
  // HIGH —— 凭据窃取
  // ------------------------------------------------------------
  {
    id: 'SSH_PRIVATE_KEY_READ',
    severity: 'high',
    category: 'credential',
    message: '访问 SSH 私钥文件',
    pattern: /[~/]\.ssh\/(?:id_[a-z0-9_]+|identity)(?!\.pub)\b/i,
  },
  {
    id: 'AWS_CREDENTIALS_READ',
    severity: 'high',
    category: 'credential',
    message: '访问 AWS 凭据文件',
    pattern: /[~/]\.aws\/(?:credentials|config)\b/,
  },
  {
    id: 'KUBE_CONFIG_READ',
    severity: 'high',
    category: 'credential',
    message: '访问 Kubernetes 配置文件（含集群凭据）',
    pattern: /[~/]\.kube\/config\b/,
  },
  {
    id: 'DOCKER_CONFIG_READ',
    severity: 'high',
    category: 'credential',
    message: '访问 Docker 配置（含 registry 凭据）',
    pattern: /[~/]\.docker\/config\.json\b/,
  },
  {
    id: 'NETRC_READ',
    severity: 'high',
    category: 'credential',
    message: '访问 .netrc 文件（含 HTTP/FTP 凭据）',
    pattern: /[~/]\.netrc\b/,
  },
  {
    id: 'GNUPG_READ',
    severity: 'high',
    category: 'credential',
    message: '访问 GnuPG 密钥目录',
    pattern: /[~/]\.gnupg\//,
  },

  // ------------------------------------------------------------
  // HIGH —— 数据外传
  // ------------------------------------------------------------
  {
    id: 'CURL_UPLOAD_FILE',
    severity: 'high',
    category: 'exfiltration',
    message: 'curl 上传本地文件（可能的数据外传）',
    pattern: /\bcurl\b[^;&|\n]*(?:--upload-file|\s-T\s+|-F\s+['"]?\w+=@|--data-binary\s+@|\s-d\s+@)/,
  },
  {
    id: 'WGET_POST_FILE',
    severity: 'high',
    category: 'exfiltration',
    message: 'wget --post-file 上传本地文件',
    pattern: /\bwget\b[^;&|\n]*--post-file/,
  },
  {
    id: 'SCP_OUTBOUND',
    severity: 'high',
    category: 'exfiltration',
    message: 'scp 向远程主机传输文件',
    pattern: /\bscp\b[^;&|\n]*\s[\w.-]+@[\w.-]+:/,
  },

  // ------------------------------------------------------------
  // HIGH —— 动态链接器 / 环境注入
  // ------------------------------------------------------------
  {
    id: 'LD_PRELOAD_STRING',
    severity: 'high',
    category: 'evasion',
    message: '通过 LD_PRELOAD / LD_LIBRARY_PATH / LD_AUDIT 加载自定义动态库',
    pattern: /\b(?:LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT)=/,
  },
  {
    id: 'BASH_ENV_INJECTION',
    severity: 'high',
    category: 'evasion',
    message: '通过 BASH_ENV / ENV 环境变量预执行脚本',
    pattern: /\b(?:BASH_ENV|ENV)=[^\s]+/,
  },

  // ------------------------------------------------------------
  // HIGH —— eval / source 与非字面量组合
  // ------------------------------------------------------------
  {
    id: 'EVAL_COMMAND_SUB',
    severity: 'high',
    category: 'evasion',
    message: 'eval 命令中使用命令替换或进程替换（动态执行未知内容）',
    pattern: /\beval\b[^;&|\n]*(?:\$\(|`|<\()/,
  },
  {
    id: 'SOURCE_PROCESS_SUB',
    severity: 'high',
    category: 'evasion',
    message: 'source / . 加载来自进程替换的脚本',
    pattern: /(?:^|[;&|\s])(?:source|\.)\s+(?:<\(|\/dev\/fd\/)/,
  },

  // ------------------------------------------------------------
  // HIGH —— 持久化 / 后门植入
  // ------------------------------------------------------------
  {
    id: 'SHELL_RC_WRITE',
    severity: 'high',
    category: 'persistence',
    message: '写入 shell 启动文件（bashrc/zshrc/profile 等），可能植入持久化后门',
    pattern: />>?\s*[~/][^;&|\s]*\.(?:bashrc|zshrc|bash_profile|zprofile|profile|bash_login|zshenv|zlogin|bash_logout|zlogout)\b/,
  },
  {
    id: 'CRON_WRITE',
    severity: 'high',
    category: 'persistence',
    message: '写入 crontab 或 /etc/cron*（持久化计划任务）',
    pattern: /\bcrontab\s+-(?:$|\s)|>\s*\/etc\/cron(?:tab|\.d|\.daily|\.hourly|\.weekly|\.monthly)/,
  },
  {
    id: 'SYSTEMD_UNIT_WRITE',
    severity: 'high',
    category: 'persistence',
    message: '写入 systemd 单元文件（持久化服务）',
    pattern: />\s*\/(?:etc|lib|usr\/lib)\/systemd\/system\/[^;&|\s]+/,
  },
  {
    id: 'RC_LOCAL_WRITE',
    severity: 'high',
    category: 'persistence',
    message: '写入 /etc/rc.local（开机自启持久化）',
    pattern: />\s*\/etc\/rc\.local\b/,
  },

  // ------------------------------------------------------------
  // MEDIUM —— 混淆迹象（仅告警，不阻断）
  // ------------------------------------------------------------
  {
    id: 'HEX_ESCAPE_STRING',
    severity: 'medium',
    category: 'obfuscation',
    message: "使用 $'\\x..' 十六进制转义字符串（常见混淆手法）",
    pattern: /\$'(?:\\x[0-9a-fA-F]{2}){3,}/,
  },
  {
    id: 'LONG_BASE64_LITERAL',
    severity: 'medium',
    category: 'obfuscation',
    message: '命令包含超长 base64 字符串（可能是隐藏 payload）',
    pattern: /[A-Za-z0-9+/]{300,}={0,2}/,
  },
]

// ============================================================
// 检测函数
// ============================================================

/**
 * 扫描一个命令字符串，返回所有命中的安全威胁。
 *
 * 行为保证：
 *   - 不修改 command 或 parsed
 *   - 同一规则 ID 重复命中时只返回第一条（避免噪音）
 *   - 按 severity 稳定顺序：critical → high → medium
 *
 * 下游 permissionEngine 会基于 severity 决定 deny / ask / warn：
 *   - critical → deny（除 bypass 模式外）
 *   - high     → ask
 *   - medium   → 写入 warnings 但不阻断
 */
export function detectSecurityThreats(
  command: string,
  parsed?: ParsedCommand,
): SecurityThreat[] {
  const threats: SecurityThreat[] = []
  const seen = new Set<string>()

  // --- 规则库扫描 ---
  for (const rule of RULES) {
    if (seen.has(rule.id)) continue
    const m = command.match(rule.pattern)
    if (m) {
      seen.add(rule.id)
      threats.push({
        id: rule.id,
        severity: rule.severity,
        category: rule.category,
        message: rule.message,
        evidence: m[0].slice(0, 80),
      })
    }
  }

  // --- 子命令级检查（需要 parsed）---
  if (parsed) {
    for (const sc of parsed.subcommands) {
      // 1. 嵌套 shell -c 执行超长 payload（复杂命令替换常用于绕过静态分析）
      if (
        (sc.baseCommand === 'bash' || sc.baseCommand === 'sh' || sc.baseCommand === 'zsh' || sc.baseCommand === 'ksh') &&
        sc.args.length >= 2 &&
        sc.args[0] === '-c' &&
        typeof sc.args[1] === 'string' &&
        sc.args[1].length > 80
      ) {
        const id = 'NESTED_SHELL_EXEC'
        if (!seen.has(id)) {
          seen.add(id)
          threats.push({
            id,
            severity: 'high',
            category: 'evasion',
            message: `嵌套 ${sc.baseCommand} -c 执行复杂命令（${sc.args[1].length} 字符），可能绕过静态分析`,
            evidence: `${sc.baseCommand} -c '${sc.args[1].slice(0, 40)}...'`,
          })
        }
      }

      // 2. 环境变量前缀里的动态链接器劫持（补强上面的字符串规则）
      for (const key of Object.keys(sc.envPrefix)) {
        if (['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'BASH_ENV', 'ENV'].includes(key)) {
          const id = `ENV_PREFIX_${key}`
          if (!seen.has(id)) {
            seen.add(id)
            threats.push({
              id,
              severity: 'high',
              category: 'evasion',
              message: `通过 ${key} 环境变量前缀注入（${sc.baseCommand || '?'}）`,
              evidence: `${key}=${sc.envPrefix[key]}`.slice(0, 80),
            })
          }
        }
      }
    }
  }

  // 按 severity 排序（critical 优先）
  const order = { critical: 0, high: 1, medium: 2 }
  return threats.sort((a, b) => order[a.severity] - order[b.severity])
}

/** 快捷判断：是否存在至少一条 critical 威胁 */
export function hasCriticalSecurityThreat(command: string, parsed?: ParsedCommand): boolean {
  return detectSecurityThreats(command, parsed).some(t => t.severity === 'critical')
}