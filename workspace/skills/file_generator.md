# 文件生成技能

触发方式: 用户说"帮我画个xxx图"、"生成一个表格"、"做个PPT大纲"

执行类型:
1. **Mermaid 图表**: 流程图、架构图、时序图、甘特图
   - 生成 .mmd 文件到 workspace/output/
   - 同时输出 mermaid 代码让用户可以在线渲染

2. **表格**: CSV 或 Markdown 格式
   - 生成到 workspace/output/

3. **Python 图表**: 需要精确数据可视化时
   - 用 matplotlib 生成 PNG
   - 保存到 workspace/output/

4. **文档大纲**: Markdown 格式
   - 生成到 workspace/output/
