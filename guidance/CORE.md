# ACM 核心注入

<!-- ACM:CORE:START -->
## 上下文管理工具

三个工具管理你自己的对话上下文：

- **`acm_checkpoint`** — 存档。给当前位置起个名字，瞬间完成，不改变上下文。重要节点、危险操作前、大量读文件前值得存一个。
- **`acm_timeline`** — 查看。当前上下文（`active`）、存档列表（`checkpoints`）、全树搜索（`search`）、分支结构（`tree`），并报告用量。
- **`acm_travel`** — 折叠。回到之前某个点，把那之后的历史替换成一份交接单。上下文变小；原始历史留在会话树里，随时可查。

**什么时候折叠**：一段工作的结论已经拿到、过程不再需要——调试结束只剩结论有用、读了一堆文件已提炼完、新请求只需要之前的结果。判断标准：不回头重读就能把这段写成交接单，就可以折；写不具体，说明还没消化完，先不折。

工具结果末尾的 `[ctx 51% used · fold→22%]` 是当前用量和折叠上一段后的预计用量。

**交接单**（travel 的 handoff 参数）：`goal`（目标）、`state`（现状与关键值）、`next`（下一步）必填；`evidence`（证据指针）、`external`（外部副作用）、`exclusions`（已排除方向）、`recover`（找回历史的存档）按需要加。合格标准：没看过前文的人只读它就能接着干。

读完代码折掉过程，三个必填字段就够：

```json
{
  "goal": "给 parser 加上嵌套注释支持",
  "state": "解析入口 src/parser.ts:parseComment（88 行），现有逻辑不处理嵌套；测试在 test/parser.test.ts",
  "next": "改 parseComment 用深度计数支持嵌套，跑 bun test test/parser.test.ts"
}
```

排查到一半折叠前半程，就需要带上假设、排除项和证据：

```json
{
  "goal": "找出 v2.3.0 后 checkout p99 延迟翻倍的原因",
  "state": "已排除数据库（查询耗时与 7-01 基线持平）。剩两个嫌疑：连接池耗尽（证据弱）、payments 新加的重试循环（v2.3.0 引入，未验证）。关键值：池上限 50（config/prod.yaml:23）；重试代码 commit 9f31c2a",
  "next": "读 services/payments/client.ts 的重试循环，对照池上限 50 检查退避参数",
  "evidence": "dashboards/checkout-p99.json；git log v2.2.0..v2.3.0 -- services/payments",
  "exclusions": "数据库索引已确认健康，不要再查",
  "recover": "latency-scan"
}
```

反面例子："排查了延迟问题，排除了一些方向，继续看"——假设、证据、关键数值全丢，接手的人没法干活。

**折叠之后**：回执 applied 就直接执行 next，不要回头重读折掉的内容。travel 只改对话上下文；文件、进程、外部系统不受影响。
<!-- ACM:CORE:END -->
