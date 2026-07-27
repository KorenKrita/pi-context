// 草根版 - 简单直白的工具描述
// 不搞那些花里胡哨的，老老实实说清楚工具干嘛的

export const ACM_CORE_MARKER = "<!-- PI-CONTEXT:ACM-CORE:v1 -->";

export const ACM_CORE = `## 上下文管理工具

你有三个工具管理自己的对话上下文。它们是普通工具——需要时自己用。

### 三个工具

1. **acm_checkpoint** — 存档点。给当前状态起个名字，之后随时能回来。免费，不改变任何东西。拿不准就存一个。

2. **acm_timeline** — 看地图。查看当前对话(active)、存档点(checkpoints)、搜索历史(search)、分支结构(tree)。顺便告诉你现在用了多少token。

3. **acm_travel** — 收纳。跳回之前某个点，把中间的过程换成一份简短的交接单。历史原文还在树里，随时能回去取。

### 什么时候折叠

折叠当一段历史已经完成，你不用回头读就能说出它的结论。典型时刻：

- 调试/探索完了，只剩结论
- 读了一堆文件/日志，已经提取了需要的东西
- 新请求只需要之前工作的结果，不需要过程

**不要折叠还在进行中的工作**——你只会回头重读，花的比省的多。

工具结果末尾可能有 \`[ctx 51% used · fold→22%]\`：当前用量和折叠后会降到多少。只是数字，不是指令。

### 交接单怎么写

\`acm_travel\` 要写7个字段。写给"折叠之后的自己"，让一个完全不知道前情的新agent能无缝接着干：

\`\`\`json
{
  "goal": "当前目标，包括还没给用户的结果。",
  "state": "已知的、未知的、假设、关键值。写不清楚说明还没整理好。",
  "evidence": "支撑state的证据：文件路径、命令、ID。没有就写none。",
  "external": "外部状态：改了什么文件、跑了什么命令。没有就写none。",
  "exclusions": "放弃的方向：试过但不行的。没有就写none。",
  "recover": "恢复点：存档点名字或节点ID。没有就写none。",
  "next": "下一步：具体的、能立刻执行的动作。"
}
\`\`\`

文件路径、函数名、错误消息、数字要精确，比描述重要。

### 折叠之后

工具结果告诉你是否成功。如果成功，按\`next\`继续——别回头去读折叠掉的内容，那正是折叠要省的成本。如果真的缺某个细节，回去取那个细节，别重读整段。`;

export const TOOL_DESCRIPTIONS = {
  checkpoint: "存档点。给当前状态起个名字，之后随时能回来。免费，不改变任何东西。不传target就存当前位置，传了就存指定位置。",
  timeline: "看地图。查看当前对话(active)、存档点(checkpoints)、搜索历史(search)、分支结构(tree)。顺便告诉你现在用了多少token。",
  travel: "收纳。跳回之前某个点，把中间的过程换成一份简短的交接单。历史原文还在树里，随时能回去取。必须单独调用，不能和其他工具一起。结果只有三种：成功、没成功、不确定。"
} as const;

export const PROMPT_SNIPPETS = {
  checkpoint: "存档点（免费，不改东西）",
  timeline: "看对话历史、存档点、token用量",
  travel: "把已完成的历史折叠成简短摘要，释放空间"
} as const;

export const PROMPT_GUIDELINES = {
  checkpoint: "免费的，不改东西，拿不准就存一个。",
  timeline: "active=当前内容，checkpoints=存档点，search=搜索历史，tree=分支结构。",
  travel: "折叠已完成的工作。如果还欠用户答案，先给答案或者写进handoff的next字段。折叠不等于回答。"
} as const;

export const GUIDANCE_CUES = {
  checkpoint: "存档完成，内容没变。以后可以用acm_travel回到这里。",
  travel: "折叠完成。交接单现在是你的工作状态，按里面的next继续。别回头去读折叠掉的内容，除非真的缺某个细节。",
  rebaseCheck: "这条路径上已经堆了好几层交接单了。考虑合并一下：找个更早的干净点，写一个总的交接单。",
  advancedTargetPointer: "目标不好选？加载context-management Skill，读references/target-selection.md。",
  advancedExceptionalPointer: "想重试？加载context-management Skill，读references/exceptional-recovery.md。",
  timelineActive: "这是你当前的上下文。如果有一段已经完成、只剩结论，折叠它能释放空间。",
  timelineCheckpoints: "这些是你的存档点。选目标时看位置——找你想折叠的内容之前的最后一个干净点。",
  timelineSearch: "搜索覆盖整棵树，包括折叠掉的历史。节点ID可以直接用作acm_travel或acm_checkpoint的目标。",
  timelineTree: "这是分支结构。看看祖先关系再选目标。"
} as const;

export const TREE_SUMMARY_INSTRUCTIONS = `把这个废弃的对话分支总结成交接单，给以后回来的人看。

就写这七行，按顺序，不要加其他标题：

Goal: 这个分支想干嘛。
State: 解决了什么（带证据），还有什么没解决。写清楚文件、变量、值。
Evidence: 能验证的东西——文件路径、命令、ID。没有就写none。
External: 副作用——改了什么文件、跑了什么命令、动了什么系统。没有就写none。
Exclusions: 试过但放弃的方向，免得重蹈覆辙。没有就写none。
Recover: 最有用的存档点或节点ID。没有就写none。
NEXT: 如果继续，下一步具体干嘛。

文件路径、函数名、错误消息、数字要精确，比描述重要。保持简洁。`;

export const RECOVERY_GUIDANCE = {
  nameCollision: "名字被占了。保留现有的，换个新名字（加个范围、编号或日期）。",
  hostCapability: "宿主没这个能力。什么都没改。报告错误，检查Pi版本。",
  rollbackFailed: "备份标签还在树里。记下名字和节点ID，再试。",
  branchRolledBack: "折叠失败了，什么都没改。修复宿主错误再试。",
  rollbackSkipped: "自动回滚不安全，备份标签保留了。记下备份指针，检查当前叶子。",
  refreshPending: "折叠成功，但上下文还没确认。如果下一轮看起来不对，检查acm_timeline的同步状态。",
  restoredHistory: "这次旅行恢复了旧历史（上下文变大了）。如果只是取一个细节，取完就跳回去。",
  refreshExhausted: "上下文重建重试用完了。重新加载会话，检查acm_timeline同步状态。"
} as const;
