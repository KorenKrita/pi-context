// 由 scripts/generate-guidance.mjs 从 guidance/CORE.md 与 guidance/TOOL-CONTRACTS.md 生成。
// 不要直接编辑。

export const ACM_CORE_MARKER = "<!-- PI-CONTEXT:ACM-CORE:v1 -->";

export const ACM_CORE = "## 上下文管理工具\n\n你有三个工具管理自己的对话上下文。它们是普通工具，你自己判断、自己用，不用汇报。\n\n- **`acm_checkpoint`** — 存档。给当前位置起个名字，免费、瞬间完成、不改变任何东西。重要节点、危险操作前、大量读文件前，随手存一个。\n- **`acm_timeline`** — 查看。看当前上下文里有什么（`active`）、有哪些存档（`checkpoints`）、搜历史（`search`）、看分支结构（`tree`），顺便报告用量。\n- **`acm_travel`** — 折叠。回到之前某个点，把那之后的历史压缩成一份简短的交接单。上下文变小，原始历史仍留在会话树里，随时可以回去查。\n\n**什么时候折叠**：一段工作做完了、结论已经拿到、过程不再需要的时候。比如调试结束只剩结论有用、读了一堆文件已经提炼完、新请求只需要之前的结果不需要过程。还没做完、还没想明白的不要折——折了还得回头重读，得不偿失。\n\n工具结果末尾可能出现 `[ctx 51% used · fold→22%]`：当前用量，以及折叠上一段后（fold）大约降到多少。它只是个数字，用不用你决定。\n\n**交接单**（travel 的 handoff 参数）共 7 个字段，标准是：一个没看过前文的人只读它就能接着干。\n\n基础用法——读了一堆代码，提炼完了，折掉过程：\n\n```json\n{\n  \"goal\": \"给 parser 加上对嵌套注释的支持\",\n  \"state\": \"解析入口在 src/parser.ts:parseComment（第 88 行），现有逻辑不处理嵌套；测试文件是 test/parser.test.ts\",\n  \"evidence\": \"src/parser.ts:88\",\n  \"external\": \"none\",\n  \"exclusions\": \"none\",\n  \"recover\": \"parser-survey\",\n  \"next\": \"修改 parseComment 用深度计数支持嵌套，然后跑 bun test test/parser.test.ts\"\n}\n```\n\n复杂用法——排查进行到一半，但前一段路已经走完，带着假设折叠：\n\n```json\n{\n  \"goal\": \"找出 v2.3.0 之后 checkout 接口 p99 延迟翻倍的原因\",\n  \"state\": \"已排除数据库（查询耗时与 7-01 基线持平）。剩两个嫌疑：连接池耗尽（错误数相关但证据弱）、payments 客户端新加的重试循环（v2.3.0 引入，未验证）。关键值：连接池上限 50（config/prod.yaml:23）；重试代码 commit 9f31c2a\",\n  \"evidence\": \"dashboards/checkout-p99.json；git log v2.2.0..v2.3.0 -- services/payments\",\n  \"external\": \"none\",\n  \"exclusions\": \"数据库索引已确认健康，不要再查\",\n  \"recover\": \"latency-scan\",\n  \"next\": \"读 services/payments/client.ts 的重试循环，对照连接池上限 50 检查退避参数\"\n}\n```\n\n写不具体就说明这段还没消化完，先别折。反面例子：\"排查了延迟问题，排除了一些方向，继续看\"——假设、证据、关键数值全丢了，接手的人没法干活。\n\n**折叠之后**：看结果回执，applied 就直接执行 next，别回头重读折掉的内容自我确认。travel 只改对话上下文，文件、进程、外部系统都不受影响。";

export const TOOL_DESCRIPTIONS = {
  "checkpoint": "存档：给会话当前位置起个名字，之后可以用 acm_travel 回来。免费、瞬间完成、不改变上下文。不传 `target` 就标记当前位置（推荐）；传节点 ID 或已有存档名可以标记更早的位置。",
  "timeline": "查看会话。选一个视图：`active`（当前上下文里的内容）、`checkpoints`（存档列表）、`search`（全树搜索，含已折叠的历史）、`tree`（分支结构）。同时报告 token 用量和同步状态。",
  "travel": "折叠：回到 `target`（存档名、节点 ID 或 'root'），把那之后的历史替换成你的 7 字段交接单，上下文随之变小。原始历史仍留在会话树里可以找回。只折叠已经做完的事；如果还欠用户一个答复，先答复再折。这个工具要单独调用，不要和其他工具放在同一批。调用后看结果回执：applied / not_applied / indeterminate。"
} as const;

export const GUIDANCE_CUES = {
  "checkpoint": "存档完成，上下文没有变化。之后可以用 acm_travel 回到这里。",
  "travel": "折叠完成。交接单就是你现在的工作状态——直接执行它的 next。不要回头重读折掉的内容自我确认；确实缺某个细节时再去找回。",
  "rebaseCheck": "这条路径上已经叠了多层折叠摘要。可以考虑合并一次：回到更早的干净位置，写一份把所有还有用的信息都装进去的交接单。",
  "timelineActive": "这就是你当前上下文里的内容。哪一段已经做完、只剩结论有用，就可以用 acm_travel 折掉它。",
  "timelineCheckpoints": "这些是你的存档。选折叠目标看位置——要折的内容之前最近的干净点。标了 raw archive 的存档指向折叠前的完整历史，用于找回旧细节，不要当折叠目标。",
  "timelineSearch": "搜索覆盖整棵树，包括已折叠的历史。结果里的节点 ID 可以直接作为 acm_travel 或 acm_checkpoint 的目标。",
  "timelineTree": "这是分支结构。用它确认目标的先后关系，别把目标选在要折叠的范围里。"
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
