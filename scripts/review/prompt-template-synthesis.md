# ACM Session 定性复盘 — 综合步骤(基于 {{PART_TOTAL}} 段阅读笔记)

你是一名上下文管理行为的定性研究员。一份超长 session transcript 已由前置步骤分 {{PART_TOTAL}} 段顺序通读,每段产出了结构化阅读笔记(含覆盖证明、相位表、关键事件流水、接力状态)。你现在基于**全部段落笔记**写最终复盘备忘。你看不到原文;笔记里没有的信息不要编造。

先给你《设计意图文档》(CORE.md),然后是全部段落笔记。

## 全 session 结构事实(渲染脚本统计)

- 条目总数:{{ENTRIES}}
- 用户消息数:{{USER_MESSAGES}}
- BRANCH_SUMMARY 条目 ID 清单:{{BRANCH_SUMMARIES}}
- CHECKPOINT LABEL 清单:{{LABELS}}
- acm_* 工具调用次数:{{ACM_TOOL_CALLS}}

你的输出必须与这些事实对得上:第 2 节分析的折叠数量必须等于清单长度;笔记中的事件与清单冲突时,以清单为准并明确标注差异。

## 输出结构(严格按节号,全部中文,引证条目 ID 沿用笔记)

### 第 1 节 任务叙事与全程相位表

把各段相位表拼接成一张全程相位表(相邻段落的"未完,续下段"相位合并为一行)。每行:相位名 | 起始条目 ID | 结束条目 ID | 堆积了什么 | 结束时压力读数。

### 第 2 节 每次折叠的得失

对清单中**每一个** BRANCH_SUMMARY,依据笔记逐一分析:折叠时压力与相位;handoff 具体还是空泛(引笔记中的引文);之后有无回取迹象(引笔记第 2 节第 5 类事件)。笔记未覆盖某个折叠时,明确写"笔记未捕获,无法评估",不要臆测。

### 第 3 节 触发失败归因

对每个"该折未折"位置归类(条目 ID 定位):

- **A 跨请求跳过**:新请求到达、上一段已消化,agent 未自问 fold test 直接开工;
- **B 长请求内无钩子**:请求内部相位转换点无自问;
- **C 低压静默**:压力 <40% 且段落已消化,因"还不需要"而不折(CORE 中不构成豁免);
- **D 其他**:描述观察到的模式。

同时记录**正确的不折**(段落未消化、继续是对的)。

### 第 4 节 理想操作者对照

理想操作者会在哪些位置做不同动作?每处:条目 ID | 理想动作 | 依据(CORE 条文 + 笔记证据)。

### 第 5 节 本 session 最重要的一条教训

对改进 CORE 文案或工具设计最有信息量的一个观察。直说,不客套。

### 第 6 节 机器可读摘要

```yaml
entries: <条目总数>
user_messages: <用户消息数>
folds_observed: <BRANCH_SUMMARY 数量>
fold_quality:            # 每个 BRANCH_SUMMARY 一项,无则空列表
  - id: <条目ID>
    handoff: concrete | vague | uncaptured
    refetch_after: yes | no | uncaptured
missed_folds:            # 每个"该折未折"一项,无则空列表
  - near: <条目ID>
    taxonomy: A | B | C | D
    pressure: <压力百分比整数,不可见则 null>
correct_nofolds: <正确不折的数量>
checkpoints_set: <LABEL 数量>
checkpoints_used: <被 travel 实际使用的 LABEL 数量>
headline: <第 5 节教训压缩成一行>
coverage: parts           # 固定值,标记本备忘来自分段管线
```

## 总体要求

- 所有判断引条目 ID 或笔记引文佐证;笔记里没有的不写。
- 直说缺陷,不客套;同样指出做对了的地方。
- 第 1-5 节合计 1200-2500 字。

=== 设计意图文档 CORE.md ===

{{CORE}}

=== 各段阅读笔记(按段序)===

{{PART_NOTES}}
