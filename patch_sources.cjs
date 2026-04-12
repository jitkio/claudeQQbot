/**
 * AgentForge 源码补丁脚本
 * 用 Node.js 做精确的字符串替换，避免 sed/bash 转义问题
 * 
 * 用法: node patch_sources.js /path/to/claudeqqbot
 */

const fs = require('fs');
const path = require('path');

const PROJECT = process.argv[2] || '/home/ubuntu/Magent/claudeqqbot';
let patchCount = 0;

function patch(relPath, description, fn) {
  const filePath = path.join(PROJECT, relPath);
  if (!fs.existsSync(filePath)) {
    console.log(`  [!] 文件不存在: ${relPath}`);
    return;
  }
  const original = fs.readFileSync(filePath, 'utf-8');
  const modified = fn(original);
  if (modified !== original) {
    fs.writeFileSync(filePath, modified);
    console.log(`  [✓] ${description}`);
    patchCount++;
  } else {
    console.log(`  [=] ${relPath} 无变化（可能已修复）`);
  }
}

// ═══════════════════════════════════════════════════════════════
// 补丁 1: toolSelector.ts — 关键词补全
// ═══════════════════════════════════════════════════════════════
console.log('\n── 补丁 1: toolSelector.ts 关键词 ──');

patch('src/engine/orchestrator/toolSelector.ts', 'web_search 关键词补全 (+25词)', code => {
  // web_search 关键词
  code = code.replace(
    `'搜索', '查找', '最新', '新闻', '怎么样', '价格', '天气', '百科', '是什么', '谁是', '搜一下', '查一下', '了解', '调研'`,
    `'搜索', '查找', '最新', '新闻', '怎么样', '价格', '天气', '百科', '是什么', '谁是', '搜一下', '查一下', '了解', '调研', '找', '热搜', '榜', '排行', '推荐', '评价', '对比', 'b站', 'bilibili', '百度', '知乎', '微博', '今天', '最近', '现在', '目前', '实时', '多少钱', '哪个', '哪里', '什么时候'`
  );
  // hasActionIntent 关键词
  code = code.replace(
    `'帮我', '帮忙', '请', '能不能', '可以',`,
    `'帮我', '帮忙', '请', '能不能', '可以', '找', '查', '看', '给我', '告诉',`
  );
  return code;
});

// ═══════════════════════════════════════════════════════════════
// 补丁 2: openai.ts — extractToolCallsFromContent 重写
// ═══════════════════════════════════════════════════════════════
console.log('\n── 补丁 2: openai.ts content 工具调用解析 ──');

const NEW_EXTRACT_FUNC = `function extractToolCallsFromContent(content: string): ToolCall[] {
  const calls: ToolCall[] = []
  if (!content || content.length < 5) return calls

  // 格式1: {"action": "xxx", "args"/"action_input"/"parameters": {...}}
  // 这是 DeepSeek 最常用的格式
  try {
    const fmt1 = /\\{\\s*"action"\\s*:\\s*"(\\w+)"\\s*,\\s*"(?:args|action_input|parameters)"\\s*:\\s*(\\{[\\s\\S]*?\\})\\s*\\}/g
    let m: RegExpExecArray | null
    while ((m = fmt1.exec(content)) !== null) {
      const args = repairJSON(m[2])
      if (!args._raw) {
        calls.push({ id: \`extracted_\${Date.now()}_\${calls.length}\`, name: m[1], arguments: args })
      }
    }
  } catch {}
  if (calls.length > 0) { console.log(\`[OpenAI] 从 content 提取 \${calls.length} 个调用 (action/args)\`); return calls }

  // 格式2: <tool_call><tool_name>xxx</tool_name><parameter>{...}</parameter></tool_call>
  try {
    const fmt2 = /<tool_call>[\\s\\S]*?<tool_name>(\\w+)<\\/tool_name>[\\s\\S]*?<parameter>([\\s\\S]*?)<\\/parameter>[\\s\\S]*?<\\/tool_call>/g
    let m: RegExpExecArray | null
    while ((m = fmt2.exec(content)) !== null) {
      const args = repairJSON(m[2])
      calls.push({ id: \`extracted_\${Date.now()}_\${calls.length}\`, name: m[1], arguments: args._raw ? {} : args })
    }
  } catch {}
  if (calls.length > 0) { console.log(\`[OpenAI] 从 content 提取 \${calls.length} 个调用 (XML)\`); return calls }

  // 格式3: {"name"/"function"/"tool_name": "xxx", "arguments"/"params"/"input": {...}}
  try {
    const fmt3 = /\\{\\s*"(?:name|function|tool_name)"\\s*:\\s*"(\\w+)"\\s*,\\s*"(?:arguments|params|input)"\\s*:\\s*(\\{[\\s\\S]*?\\})\\s*\\}/g
    let m: RegExpExecArray | null
    while ((m = fmt3.exec(content)) !== null) {
      const args = repairJSON(m[2])
      if (!args._raw) {
        calls.push({ id: \`extracted_\${Date.now()}_\${calls.length}\`, name: m[1], arguments: args })
      }
    }
  } catch {}
  if (calls.length > 0) { console.log(\`[OpenAI] 从 content 提取 \${calls.length} 个调用 (name/arguments)\`); return calls }

  // 格式4: 整个 content 就是一个 JSON 对象（可能被 markdown 代码块包裹）
  try {
    const trimmed = content.trim().replace(/^\`\`\`(?:json)?\\s*/i, '').replace(/\\s*\`\`\`$/i, '').trim()
    if (trimmed.startsWith('{')) {
      const obj = JSON.parse(trimmed)
      const name = obj.action || obj.tool_name || obj.name || obj.function
      const args = obj.args || obj.action_input || obj.parameters || obj.arguments || obj.input || {}
      if (name && typeof name === 'string') {
        calls.push({ id: \`extracted_\${Date.now()}_0\`, name, arguments: typeof args === 'object' ? args : {} })
        console.log(\`[OpenAI] 从 content 提取 1 个调用 (完整JSON)\`)
        return calls
      }
    }
  } catch {}

  return calls
}`;

patch('src/adapters/openai.ts', 'extractToolCallsFromContent 重写 (支持4种DeepSeek格式)', code => {
  const startMarker = 'function extractToolCallsFromContent(content: string): ToolCall[]';
  const startIdx = code.indexOf(startMarker);
  if (startIdx === -1) return code;

  // 找到函数结束位置：追踪花括号匹配
  let depth = 0;
  let funcBodyStart = code.indexOf('{', startIdx);
  let funcEnd = -1;
  for (let i = funcBodyStart; i < code.length; i++) {
    if (code[i] === '{') depth++;
    if (code[i] === '}') depth--;
    if (depth === 0) { funcEnd = i + 1; break; }
  }
  if (funcEnd === -1) return code;

  return code.substring(0, startIdx) + NEW_EXTRACT_FUNC + code.substring(funcEnd);
});

// ═══════════════════════════════════════════════════════════════
// 补丁 3: webSearch.ts — count/numResults 参数兼容
// ═══════════════════════════════════════════════════════════════
console.log('\n── 补丁 3: webSearch.ts 参数兼容 ──');

patch('src/tools/web/webSearch.ts', '同时接受 numResults 和 count 参数', code => {
  const old = 'const { query, numResults = 5, fetchContent = false } = args';
  if (!code.includes(old)) return code;

  code = code.replace(
    old,
    'const { query, numResults, count, fetchContent = false } = args as any\n    const finalNum = numResults || count || 5'
  );
  // 替换所有对 numResults 的后续引用
  code = code.replace(/engine\.search\(query, numResults\)/g, 'engine.search(query, finalNum)');
  code = code.replace(/results\.slice\(0, numResults\)/g, 'results.slice(0, finalNum)');
  return code;
});

// ═══════════════════════════════════════════════════════════════
// 完成
// ═══════════════════════════════════════════════════════════════
console.log(`\n── 完成: ${patchCount} 个文件已修改 ──\n`);
