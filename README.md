# pi-context

让 Pi agent 主动维护自己的上下文，而不是等窗口耗尽后被动压缩。

`pi-context` 是由 KorenKrita 维护的第三方 Pi 扩展。核心理念是**压缩即智能**：理解一段过程，就是能把它说得更短而不丢失关键信息。扩展让 agent 能够：

- **Save** — 在高风险操作、验证过的 baseline、策略分叉前建立可恢复的语义 save point；
- **Orient** — 查看当前会话 spine、历史分支、checkpoint 与上下文占用；
- **Fold** — 把已经提炼完的过程折叠成可通过 cold start 检验的 handoff；
- **Rebase** — 在 summary 堆叠或竞争时合并到更早的安全基底，重新获得浅层、低负载的 working set；
- **Rehydrate / Fork** — travel 到归档分支取回精确细节再返回，或从 save point 分叉探索后折回；
- 在 travel 后同步持久会话树、下一轮模型上下文与 live AgentSession；同步只发生在 `agent_settled`，不打断当前 run 的 tool-call 连续性。

Guidance 采用道/术/度分层：always-on CORE 注入判断力与 cadence 偏好，工具描述和 result cue 携带机制，advanced Skill 只在复杂场景按需加载。没有强制 preflight、固定 transition 表或后缀状态机——agent 自主判断何时压缩。

## 为什么需要它

长任务的问题不只是 token 数量。

即使每个阶段都做了局部摘要，summary 仍可能一层层堆在 active spine 上：

```text
root → summary A → summary B → summary C → current work
```

这些历史 handoff 会持续占用上下文和注意力。`pi-context` 不把压缩当作单纯的 token 操作，而是按**语义边界**管理 working set：保留下一步真正需要的内容，把已完成过程移到可恢复的 archive。

## 三个工具

| Tool | 作用 |
|---|---|
| `acm_checkpoint` | 给会话节点建立唯一、可恢复的语义 save point |
| `acm_timeline` | 查看 active spine、checkpoint catalog、全文搜索、完整树和 summary depth |
| `acm_travel` | 将已提炼的过程折叠为七槽 handoff、把累计 summaries rebase 到最早安全基底，或 rehydrate 归档分支 |

扩展会通过 Pi 的公开 prompt hook 注入精简的 always-on CORE。复杂的 target selection、archive round trip 和异常恢复按需从 advanced Skill 加载，不会把整套 playbook 常驻在上下文里。

### `acm_travel` v3 structured handoff

`3.0.0` 将 agent-facing travel 参数从自由字符串 `summary` 改为 required structured `handoff`。Runtime 负责验证字段并生成持久化的七槽文本，模型不再手写 header、顺序、冒号或 line-start grammar。

旧调用：

```json
{
  "target": "parser-baseline",
  "summary": "Goal: ...\nState: ...\nEvidence: ...\nExternal: none\nExclusions: none\nRecover: parser-raw\nNEXT: ..."
}
```

新调用：

```json
{
  "target": "parser-baseline",
  "handoff": {
    "goal": "完成 parser migration 并保持现有行为。",
    "state": "实现已完成，测试通过；仍需更新 README 示例。",
    "evidence": "bun test；src/parser.ts；test/parser.test.ts",
    "external": "src/parser.ts 已修改，尚未提交。",
    "exclusions": "不再尝试 recursive-descent 方案。",
    "recover": "parser-raw",
    "next": "更新 README 中的 parser 示例。"
  },
  "backupCurrentHeadAs": "parser-raw"
}
```

七个字段都必须存在。`goal`、`state`、`next` 必须包含真实内容；其余字段为空时显式写 `none`。字段值可以多行，没有人为 handoff 长度上限。`backupCurrentHeadAs` 成功时，runtime 会把 raw archive alias 确定性地写入持久 handoff 的 `Recover`。

首选 wire shape 始终是上面的 nested object。少数 provider 会把 nested tool argument 整体序列化成 JSON string；runtime 也接受**同一个七字段对象的精确 JSON 编码**作为兼容 fallback，再走完全相同的字段验证与 canonicalization。普通自由文本、旧七行 DSL 或任意 `summary` 字符串仍不是有效 handoff。

既有 session 中的 `branch_summary.summary` 仍作为 opaque historical text 使用，无需迁移或重写；breaking change 只影响新的 `acm_travel` tool call payload。

Travel 明确成功后，runtime 会登记 per-SessionManager persistent refresh 与 live-sync ticket。matching `tool_execution_end` 只确认本次 tool pair，originating assistant run 及其 automatic retry/tool loop 保留当前 live messages，不替换 `AgentSession` 或其 context，因此刚发生的 tool-call/result 连续性保持完整。仅在 `agent_settled` 时，adapter 才从最新已验证 active branch 重建并替换 native AgentSession；`agent_end`（尤其 provider error）不是 release/apply signal。persistent Context Packet rebuild 继续作为验证与 fallback 路径。失败或 indeterminate travel 不会开启 refresh/sync ticket，继续使用既有恢复路径。当队列里没有后来用户消息且 run 未 abort 时，matching `tool_result` 仍会通过一条隐藏的 post-travel `steer` 明确一次 `next`。这条消息不是新目标，也不重新验证 handoff；它只防止较弱模型把 pre-travel 的旧请求当成当前任务重放。有 pending later message 时跳过 transient steer，依赖原位 Context Packet，因此用户的新目标不会被旧 `NEXT` 排到后面覆盖。

如果 travel 发生在一个仍未给出 visible assistant response 的 user turn 内，runtime 还会持久记录 `currentUserTurnOpen`，并在 handoff authority、tool receipt 与 steer 中明确“State 不是交付、当前用户仍等着结果”。这只使用 session topology 的可观察事实，不尝试猜测答案语义。

## Semantic rebase

普通 fold 压缩一个局部阶段；rebase 处理长期累积的 summary depth。

agent 会在以下时机主动检查 rebase：

- 下一次 fold 会继续叠加 summary；
- 一个稳定 chain 或 subchain 已结束；
- 同一 session 即将开始新目标；
- context pressure 上升。

rebase 不等于强制跳到 `root`。agent 会从最早候选开始执行 **cold start** 检查：如果一个全新的 agent 只依赖当前 snapshot 和直接 evidence pointers 就能执行 `NEXT`，该基底才安全。root 是理想候选，不是默认答案。

Timeline 会提供事实证据：

- 当前 active summary depth；
- root structural candidate；
- 每个 checkpoint travel 后的 projected summary depth；
- usage、message count 与 branch topology。

Runtime 不会伪装成能判断语义完整性，也不会自动批准或执行 rebase.

## ACM 上下文占用提醒

扩展会在 active context 的 ACM working-budget pressure 首次进入 **30% / 50% / 70%** 档位时，通过 Pi 的 hidden custom message 向 agent 发送分级 ACM 提醒。工作预算按以下策略计算：

```text
workingBudgetTokens = min(contextWindow, 400K)
pressurePercent = activeTokens / workingBudgetTokens × 100
```

物理窗口不超过 400K 时沿用实际窗口；超过 400K 时统一使用 400K 工作预算。因此 200K、350K 模型的触发节奏不变，1M 模型在 120K / 200K / 280K active tokens 时分别触发 30% / 50% / 70%。真实 hard-window usage 仍单独保留，reminder details 与 `acm_timeline` dashboard 会同时展示 hard usage 和 ACM pressure，避免把工作预算误读成模型窗口容量。
- **30%**：离开舒适巡航区，重新运行 ACM Judgment：是否存在低价值高噪声的 Compression Candidate，未来仍需的信息能否显著更简练地表示；有未来返回价值时 checkpoint 是近似免费的 recovery option，topology evidence 有帮助时查看 timeline；
- **50%**：显式比较 Candidate、Compressibility、Attention effect、Recovery value 与 Transition effect，再从 continue、checkpoint、timeline、travel、rebase、rehydrate 中选择整体任务净效果最好的 move；
- **70%**：当前周期最后一次提醒，提高 attention interference 的权重但保持同一判断过程；存在正净收益就行动，当前 raw detail 仍是最佳 working set 时继续正确工作，并允许 native compaction 处理真正的长任务。

提醒对 agent 可见、在 TUI 中隐藏，并明确不是用户的新要求。它只建议根据当前任务要求判断 travel 是否合适，不自动执行 summary、fold、rebase 或 travel。正确性、任务连续性和可恢复性优先；真正的长任务继续增长并进入 Pi 原生 compaction 是可接受的。

同一上下文周期只提醒更高的新档位：普通 usage 回落不会重新触发旧档。一次采样跨越多个档位时只发送当前最高档。明确成功的 `acm_travel`、Pi 原生 compaction 或手动 `/tree` 导航才开启新周期；transition 后先用下一次真实 LLM prompt usage 建立无提醒基线，再继续观察后续增长。Session resume/reload 会从 active branch 中已持久化的 ACM reminder 恢复本周期最高档位，不会仅因重载而重复提醒。

## 手动 `/tree` 导航协同

用户手动通过 Pi 原生 `/tree` 跳转分支时，扩展保持一致的 ACM 语义：跳转后清空该会话的易失 runtime 状态并开启新的提醒周期；当用户选择 "Summarize"（且未提供自定义指令）时，注入七槽 handoff 形态的 summarization 指令，让 native branch summary 与 `acm_travel` 的 handoff 使用同一 cold-start 词汇。用户提供的自定义指令始终优先。

## `/context` 面板

Pi 版本保留独有的 `/context` 命令，用于查看当前上下文的分类占用、校准后的 token 估算和 compaction-aware 消息构成。该面板仅在 TUI mode 可用；RPC、JSON 与 print mode 会跳过 terminal UI。它是诊断界面，不会修改会话树。

## 安装

这个 fork 当前是 **GitHub-only package**，并通过 `package.json` 的 `private` 标记阻止误发布到 npm。未带 scope 的 npm 包名 `pi-context` 属于上游项目；不要用 `npm install pi-context` 安装本 fork。

### 本地安装

```bash
pi install .
```

### GitHub

```bash
pi install git:github.com/KorenKrita/pi-context
```

也可以临时直接加载 source-first 入口。只加载 `src/index.ts` 时，Pi 会注册三个 ACM tools 和 always-on CORE，但不会读取该项目 `package.json` 中声明的 `/context` 扩展或 advanced Skill：

```bash
pi -e /path/to/pi-context/src/index.ts
```

若要让临时运行与 package 安装暴露相同的资源，请显式加载两个 extension 和 skills 目录：

```bash
pi -e /path/to/pi-context/src/index.ts \
  -e /path/to/pi-context/src/context.ts \
  --skill /path/to/pi-context/skills
```

安装后无需手动调用命令。Agent 会依据 CORE 的压缩判断持续整合观察、按语义批次主动 fold；你也可以直接要求它创建 checkpoint、查看 timeline 或恢复某个 archive。

## 可观察性与恢复

每次操作都会返回可核对的结构事实：

- resolved target 与 entry ID；
- checkpoint aliases；
- branch summary leaf；
- backup checkpoint outcome；
- message、token、percentage-point 与 summary-depth delta；
- persistent context rebuild 和 settled-boundary live AgentSession sync 状态。
- travel target 的 protocol status/repairs/defects、surviving open-user、assistant tool-batch、old-summary 与 off-path warnings；无效 tool-call identity 的 target 会在任何 mutation 前被拒绝，其余 warning 不冒充语义 verdict。

Checkpoint 名称在整棵会话树中大小写敏感且必须唯一；同一节点可以拥有多个 alias。异常 mutation 明确区分 `not_applied`、`applied` 和 `indeterminate`，避免把未知状态伪装成成功或失败。

## 安全边界

- Travel 只改变 Pi 会话树和后续模型上下文。
- 它不会回滚文件、进程、浏览器、Git commit 或远端服务。
- 扩展不会取消、替换或延迟 Pi 原生 compaction。
- 如果当前任务仍依赖不可压缩的中间推理，agent 会保留 working set 或接受 native compaction，而不是为了降低数字强行 rebase。
- Host 不支持 live synchronization 时，持久 branch 和公开 Context Packet rebuild 仍然保留；结果会给出明确恢复指引。

## 验证

Pi 的 git package 安装路径使用 npm，因此根目录以 `package-lock.json` 作为依赖复现契约；测试与 source build 使用 Bun。CI 固定 Node `24.16.0`、npm `11.13.0` 和 Bun `1.3.14`。

```bash
npm ci --ignore-scripts
bun run verify:acm
```

`bun test` 只运行根目录 unit/guidance suite；`bunfig.toml` 会排除需要独立依赖与 source build 的 `test/host-fixture/`。完整 gate 会依次检查 generated guidance、全部根测试、TypeScript，以及使用自身 frozen `bun.lock` 的真实 Pi `0.80.7` host fixture；该 fixture 还会通过 exact `ExtensionRunner` 加载 `/context` 并使用 exact `pi-tui` 渲染面板。

Focused checks：

```bash
bun test
bun run test:guidance
bun run typecheck
bun run test:host
```

真实模型行为评估与 CI 分离。Runner 支持 `raw-control`、`core-only`、`product-isolated`、`full-env`；除 raw-control 外，相关模式在首个 prompt 前验证当前 checkout 的 Skill provenance：

```bash
bun eval/run.mjs \
  --env product-isolated \
  --id structured-handoff-continuation-and-skill \
  --model local-responses/gpt-5.6-sol \
  --thinking high

bun eval/run-flow.mjs \
  --environment-mode raw-control \
  --flow cadence-research-flow \
  --model local-responses/gpt-5.6-sol \
  --thinking high \
  --context-window 40000

bun eval/run.mjs \
  --env product-isolated \
  --id advanced-pointer-routing \
  --model local-openai/deepseek-v4-flash \
  --thinking high
```

Controlled strong/weak matrices and their scope limits are recorded in [`eval/evidence/`](eval/evidence/)；这些是独立 outcome evidence，不会被塞进每次 deterministic CI。

开发架构、Pi host compatibility、版本升级流程和维护契约见 [`AGENTS.md`](AGENTS.md)。

## 致谢

- [pi-context](https://github.com/ttttmr/pi-context) — 原始项目 by ttttmr
- [让 AI 主动管理自己的上下文](https://blog.xlab.app/p/6a966aeb/) — 设计思路

MIT License
