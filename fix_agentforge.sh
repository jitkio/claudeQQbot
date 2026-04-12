#!/bin/bash
###############################################################################
#  AgentForge Bug 修复脚本
#  用法: bash fix_agentforge.sh
###############################################################################

set -euo pipefail

PROJECT="/home/ubuntu/Magent/claudeqqbot"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="${PROJECT}/_backup_$(date +%Y%m%d_%H%M%S)"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

echo ""
echo "============================================"
echo "  AgentForge Bug 修复"
echo "  根因: toolSelector 关键词不足"
echo "       + content 工具调用解析缺失"
echo "============================================"
echo ""

[ -d "$PROJECT/src" ] || err "项目不存在: $PROJECT/src"

# ── 步骤 1: 备份 ──
echo "── 步骤 1/4: 备份 ──"
mkdir -p "$BACKUP_DIR"
for f in \
  src/engine/orchestrator/toolSelector.ts \
  src/adapters/openai.ts \
  src/tools/web/webSearch.ts \
  workspace/prompts/deepseek.md
do
  if [ -f "$PROJECT/$f" ]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$f")"
    cp "$PROJECT/$f" "$BACKUP_DIR/$f"
  fi
done
log "备份 → $BACKUP_DIR"
echo ""

# ── 步骤 2: Node.js 源码补丁 ──
echo "── 步骤 2/4: 源码补丁 ──"

# 确保补丁脚本存在
PATCH_SCRIPT="$SCRIPT_DIR/patch_sources.cjs"
if [ ! -f "$PATCH_SCRIPT" ]; then
  err "找不到 patch_sources.cjs，请确保它和本脚本在同一目录"
fi

node "$PATCH_SCRIPT" "$PROJECT"
echo ""

# ── 步骤 3: 重写 deepseek.md ──
echo "── 步骤 3/4: 重写 deepseek.md ──"

cat > "$PROJECT/workspace/prompts/deepseek.md" << 'PROMPT_EOF'
# AI 秘书（DeepSeek 专用）

你是用户的私人 AI 秘书，通过 QQ Bot 服务。你能执行任务、搜索信息、处理文件。

## 行为规则
- 中文回复，直奔重点，先说结论
- 回复精炼（QQ 限 2000 字）
- 直接执行，不问"可以吗"
- 涉及实时信息必须先搜索
- 出错坦诚，尝试替代方案

## 输出格式
QQ 是纯文本，不支持 Markdown：
- 不要用 **粗体**、`代码块`、### 标题、```代码围栏```
- 列表用 1. 2. 3. 或 - 前缀
- 强调用【】包裹

## 工具使用（最重要）

你有工具可用，系统会自动提供工具定义。你必须且只能通过 function calling 机制调用工具。

严禁在回复文本里写 JSON 格式的工具调用！不要自己编造 {"action": ...} 这样的文本！直接使用系统提供的 tool_calls 功能。

关键规则：
1. 需要搜索信息时，调用 web_search 工具
2. 需要执行命令时，调用 bash 工具
3. 如果不确定该用什么工具，用 bash 执行命令
4. 不要试图调用不存在的工具
5. 一次只调用一个工具，等结果再决定下一步

工具参数名（必须精确匹配）：
- bash: command（字符串）
- read_file: file_path（字符串）
- write_file: file_path + content（字符串）
- web_search: query（字符串）, numResults（数字，可选）
- web_fetch: url（字符串）
- web_extract: url（字符串）, goal（字符串，可选）

## 搜索策略
- 用户要搜信息时，直接调用 web_search
- 搜索中国网站（B站、微博、知乎等）用中文关键词
- 需要看网页详情，先搜索拿URL，再用 web_fetch

## 文件处理
用户发文件时直接读取分析，不要问"要我做什么"。
生成的文件放 workspace/output/ 目录。
PROMPT_EOF

log "deepseek.md 已重写"
echo ""

# ── 步骤 4: Playwright 检查 ──
echo "── 步骤 4/4: Playwright 依赖 ──"

cd "$PROJECT"

if [ ! -d "node_modules/playwright" ]; then
  warn "playwright 未安装"
  if command -v bun &>/dev/null; then
    bun install 2>&1 | tail -3
  elif command -v npm &>/dev/null; then
    npm install 2>&1 | tail -3
  fi
fi

# 尝试安装 chromium（如果还没有）
if ! npx playwright install --dry-run chromium 2>&1 | grep -qi "already" 2>/dev/null; then
  echo "  安装 Chromium..."
  npx playwright install chromium 2>&1 | tail -5 || warn "Chromium 安装可能失败"
  if command -v apt-get &>/dev/null; then
    sudo npx playwright install-deps chromium 2>&1 | tail -5 || true
  fi
fi
log "Playwright 检查完成"

echo ""
echo "============================================"
echo -e "  ${GREEN}修复完成！${NC}"
echo "============================================"
echo ""
echo "  修改了 4 个文件:"
echo "    toolSelector.ts  — 关键词 '找/热搜/榜' 等 +25 词"
echo "    openai.ts        — content 解析支持 4 种 DeepSeek 格式"
echo "    deepseek.md      — 参数名修正 + 禁止文本工具调用"
echo "    webSearch.ts     — count/numResults 双参数兼容"
echo ""
echo "  重启: pm2 restart all  或  bun run start"
echo "  测试: QQ 发送「b站找今天热搜榜前20」"
echo ""
echo "  回滚: cp -r $BACKUP_DIR/* $PROJECT/"
echo ""
