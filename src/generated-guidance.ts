// 由 scripts/generate-guidance.mjs 从 guidance/CORE.md 与 guidance/TOOL-CONTRACTS.md 生成。
// 不要直接编辑。

export const ACM_CORE_MARKER = "<!-- PI-CONTEXT:ACM-CORE:v1 -->";

export const ACM_CORE = "## 上下文管理工具\n\n你的上下文不是流水账，而是工作台：留有用的，收走用完的。三个工具帮你做这件事：\n\n- **`acm_checkpoint`** — 存档。给当前位置起个名字，瞬间完成，不改变上下文。\n- **`acm_timeline`** — 查看。当前上下文、存档、全树搜索、分支结构，附带用量。\n- **`acm_travel`** — 折叠。回到之前某个点，把那之后的历史换成一份交接单。上下文变小；原始历史留在会话树里，随时可回去。\n\n**什么时候折**：一段工作只剩结论有用、过程不再需要的时候。调试收尾、读完一批文件、新请求只依赖之前的结果——都是折叠点。检验方法只有一条：不回头重读，能把这段写成一份具体的交接单，就可以折；写出来含糊，说明还没消化完，先不折。\n\n工具结果末尾的 `[ctx 51% used · fold→22%]` 是当前用量和折掉上一段后的预计用量。数字只是参考，折不折由上面那条检验说了算。\n\n**交接单**：`goal`（在做什么）、`state`（知道什么，含接下来要用的具体值）、`next`（下一步做什么）必填；`evidence`（证据指针）、`external`（外部副作用）、`exclusions`（排除过的方向）、`recover`（找回历史的存档）用到才写。合格标准：没看过前文的人只读它就能接着干。\n\n简单情况——读完代码开始动手，过程折掉：\n\n```json\n{\n  \"goal\": \"给 parser 加上嵌套注释支持\",\n  \"state\": \"入口是 src/parser.ts:parseComment（88 行），现在不处理嵌套；测试在 test/parser.test.ts\",\n  \"next\": \"用深度计数改写 parseComment，跑 bun test test/parser.test.ts\"\n}\n```\n\n复杂情况——排查到一半折掉前半程，假设和排除项必须带上：\n\n```json\n{\n  \"goal\": \"找出 v2.3.0 后 checkout p99 延迟翻倍的原因\",\n  \"state\": \"数据库已排除（查询耗时与 7-01 基线持平）。剩两个嫌疑：连接池耗尽（证据弱）、payments 新加的重试循环（v2.3.0 引入，未验证）。关键值：池上限 50（config/prod.yaml:23）；重试代码 commit 9f31c2a\",\n  \"next\": \"读 services/payments/client.ts 的重试循环，对照池上限 50 检查退避参数\",\n  \"evidence\": \"dashboards/checkout-p99.json；git log v2.2.0..v2.3.0 -- services/payments\",\n  \"exclusions\": \"数据库索引确认健康，不用再查\",\n  \"recover\": \"latency-scan\"\n}\n```\n\n写成\"排查了延迟问题，排除了一些方向，继续看\"就是不合格——假设、证据、关键数值全丢了，接手的人干不了活。\n\n**拓展：回去取细节**。折叠不是删除。发现缺一个已折叠的细节（某段报错原文、某个精确数字），travel 到旧分支拿到它，再 travel 回来，交接单里带上取回的内容。每份交接单的 Recover 行都自动记着折叠前的位置，回程票是现成的；整个来回比重新推导便宜得多。\n\n**折叠之后**：回执 applied 就直接执行 next，不要回头重读折掉的内容。travel 只改对话上下文；文件、进程、外部系统都保持原样。";

export const TOOL_DESCRIPTIONS = {
  "checkpoint": "存档：给会话当前位置起个名字，之后可以用 acm_travel 回来。免费、瞬间完成、不改变上下文。不传 `target` 就标记当前位置；也可以传节点 ID 标记更早的位置。危险操作前、要折叠前，顺手存一个。",
  "timeline": "查看会话。四个视图选一个：`active`（当前上下文里有什么）、`checkpoints`（存档列表）、`search`（全树搜索，已折叠的历史也能搜到）、`tree`（分支结构）。附带 token 用量。",
  "travel": "折叠：回到 `target`（存档名、节点 ID 或 'root'），把那之后的历史换成交接单（goal/state/next 必填，其余字段用到才写）。上下文变小，原始历史留在会话树里可以找回。还欠用户答复时先答复再折；单独调用，不与其他工具同批。"
} as const;

export const GUIDANCE_CUES = {
  "checkpoint": "存档完成，上下文无变化。之后可用 acm_travel 回到这里。",
  "travel": "折叠完成。交接单就是你现在的全部状态：直接做 next；缺细节时用 recover 指回去取，不要凭记忆重读。",
  "rebaseCheck": "这条路径已叠多层折叠摘要。可以合并：回到更早的干净位置，写一份装下全部存活信息的交接单。",
  "timelineActive": "以上是当前上下文。已经做完、只剩结论有用的段落可以用 acm_travel 折掉。",
  "timelineCheckpoints": "折叠目标选在要折内容之前最近的干净点。标 raw archive 的存档指向折叠前的完整历史，用于找回旧细节，不要当折叠目标。",
  "timelineSearch": "搜索覆盖整棵树，含已折叠的历史。结果里的节点 ID 可直接作为 acm_travel 或 acm_checkpoint 的目标。",
  "timelineTree": "分支结构用于确认目标的先后关系；不要把折叠目标选在要折的范围里。"
} as const;

export const TREE_SUMMARY_INSTRUCTIONS = "把这条被放弃的对话分支总结成一份交接单，给以后回来的人看。\n\n只写下面七行，按顺序，每行一个字段，不要其他标题：\n\nGoal: 这条分支想完成什么。\nState: 确定了什么（附依据）、还有什么不确定。写清仍然相关的 exact file paths、符号和数值。\nEvidence: 可直接核实的指针——文件路径、命令、ID。没有写 none。\nExternal: 留下的外部影响——改过的文件、跑过的命令、动过的系统。没有写 none。\nExclusions: 试过并放弃的方向，避免重蹈。没有写 none。\nRecover: 最有用的存档名或节点 ID。没有写 none。\nNEXT: 恢复这项工作时最具体的下一步。\n\n保留 exact file paths、函数名、报错信息和数字，它们比描述重要。整体保持简短。";

export const RECOVERY_GUIDANCE = {
  "nameCollision": "这个名字已被占用。保留原有存档，换个新名字（加个范围、序号或日期）。",
  "hostCapability": "宿主缺少所需能力，什么都没有改。报告这个能力错误；确认 Pi 版本是否是本扩展支持的版本。",
  "rollbackFailed": "备份标签还留在树里。重试前先记下它的名字和条目 ID。",
  "branchRolledBack": "折叠在改动任何东西之前就失败了，备份标签已回滚。先解决报告的宿主错误再重试。",
  "rollbackSkipped": "自动回滚备份不安全，备份标签保留了。记下备份指针，重试前先用 acm_timeline 确认当前位置。",
  "refreshPending": "折叠已生效，但重建后的上下文还没确认。如果下一轮不对劲，用 acm_timeline 查看同步状态。",
  "restoredHistory": "这次 travel 恢复了旧历史（上下文变大而不是变小）。如果是来取某个细节的，拿到后立刻 travel 回你的返回存档。只有当你有意把这条分支当作新的工作状态时才留下。",
  "refreshExhausted": "上下文重建重试次数用尽。重新加载会话，用 acm_timeline 查看同步状态，确认活动分支无误后再继续。"
} as const;
