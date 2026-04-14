---
name: skill-creator
description: 创建、测试、改进自定义技能。当用户说"创建一个技能"、"做一个工作流"、"自动化这个流程"时使用。
---

# 技能创建器

帮助用户创建和迭代改进自定义技能的工具。

## 流程
1. 理解用户意图 → 2. 写技能草稿 → 3. 测试 → 4. 评估 → 5. 改进 → 重复

## 技能结构
```
skill-name/
├── SKILL.md (必需：YAML frontmatter + 指令)
├── scripts/ (可执行脚本)
├── references/ (参考文档)
└── assets/ (模板、资源)
```

## 工具
- 验证: `python3 /home/ubuntu/claudeqqbot/skill-creator/scripts/quick_validate.py <技能目录>`
- 打包: `python3 /home/ubuntu/claudeqqbot/skill-creator/scripts/package_skill.py <技能目录>`
- 基准: `python3 /home/ubuntu/claudeqqbot/skill-creator/scripts/aggregate_benchmark.py <目录>`

## 创建技能时
1. 在 workspace/skills/ 下创建目录
2. 写 SKILL.md（name + description + 指令）
3. 可选添加 scripts/、references/
4. 验证后告诉用户
