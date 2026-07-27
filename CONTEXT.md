# Agentic Context Management

`pi-context` 管理 agent 对会话历史的注意力分配。

## 核心概念

- **工作集** — 当前模型真正看到的内容，不是全部历史
- **存档点** — 用 `acm_checkpoint` 保存的语义状态，之后可以回来
- **handoff** — 用 `acm_travel` 折叠历史时写的七字段交接单
- **折叠** — 把一段已消化完的过程替换成 handoff，原始历史仍在树里可恢复
- **仪表** — 工具结果末尾的 `[ctx N%]`，显示上下文窗口使用率