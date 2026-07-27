// 草根版 ACM guidance - 简单直接，不整那些虚的

export const ACM_CORE_MARKER = "<!-- PI-CONTEXT:ACM-CORE:v1 -->";

export const ACM_CORE = `## Context 管理工具

你有三个工具来管理对话上下文：

### acm_checkpoint - 存档
给当前状态起个名字，以后可以回来。就像游戏存档。
- 重要节点存一下
- 要尝试危险操作前存一下
- 名字起得有意义，方便以后找

### acm_timeline - 查看
看看当前对话的状态：
- 用了多少 context
- 有哪些存档点
- 历史结构是什么样

### acm_travel - 压缩
context 太长了就用这个压缩一下。把之前的过程总结成一个简短的交接单，原始历史还在树里，随时能回去看。

压缩时要写一个交接单，包含：
- goal: 当前目标是什么
- state: 现在进展到哪了，知道了什么，还不确定什么
- next: 下一步要做什么

### 什么时候用

- **context 超过 50%** → 考虑用 travel 压缩一下
- **要做重要操作** → 先 checkpoint 存个档
- **不确定当前状态** → 用 timeline 看看`;

export const TOOL_DESCRIPTIONS = {
  checkpoint: "存档点。给当前状态起个名字，以后可以回来。不传 target 就存当前位置。",
  timeline: "查看对话状态。显示 context 用量、存档点列表、历史结构。",
  travel: "压缩 context。把之前的过程总结成交接单，释放空间。需要写 handoff 说明目标、现状、下一步。",
} as const;

export const PROMPT_SNIPPETS = {
  checkpoint: "存个档",
  timeline: "看看状态",
  travel: "压缩 context",
} as const;

export const PROMPT_GUIDELINES = {
  checkpoint: "checkpoint 很轻量，随便存。",
  timeline: "不确定就先 timeline 看看。",
  travel: "travel 会改变 context，压缩前确保当前工作告一段落。",
} as const;

export const GUIDANCE_CUES = {
  checkpoint: "存档完成。",
  travel: "压缩完成，从 NEXT 继续。",
  rebaseCheck: "",
  advancedTargetPointer: "",
  advancedExceptionalPointer: "",
  timelineActive: "",
  timelineCheckpoints: "",
  timelineSearch: "",
  timelineTree: "",
} as const;

export const TREE_SUMMARY_INSTRUCTIONS = `总结这段对话，写清楚：
1. Goal: 要做什么
2. State: 做到哪了，知道了什么
3. Next: 下一步做什么

保留关键的文件路径、命令、数字等具体信息。`;

export const RECOVERY_GUIDANCE = {
  nameCollision: "这个名字已经被用了，换一个。",
  hostCapability: "操作失败，检查 Pi 版本。",
  rollbackFailed: "回滚失败，记下当前状态再重试。",
  branchRolledBack: "分支创建失败，已回滚。",
  rollbackSkipped: "无法自动回滚，手动检查一下。",
  refreshPending: "压缩成功，context 同步中。",
  restoredHistory: "已恢复到历史状态。",
  refreshExhausted: "context 重建失败，重新加载 session 试试。",
} as const;
