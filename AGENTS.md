# AGENTS.md - pi-context 项目知识库

## 概述

**pi-context** 是 [pi-context (ttttmr)](https://github.com/ttttmr/pi-context) 的 fork，为 Pi agent 提供主动上下文管理能力，让 agent 能在长任务中自己打锚点、查看会话树、穿越时间线并在目标节点继续。同仓库另有 [omp-context](https://github.com/KorenKrita/omp-context) 作为 OMP (oh-my-pi) 适配版。

项目当前暴露三个工具：

| 工具 | 作用 |
|---|---|
| `acm_checkpoint` | 给会话历史节点打语义 checkpoint label |
| `acm_timeline` | 输出 active path / full tree / search 视图和 context HUD |
| `acm_travel` | 穿越到任意 checkpoint 或节点，创建 summary continuation branch |

另有 `/context` TUI 命令（`src/context.ts`）用于可视化 token 占用，与 ACM 工具互补。

## 技术栈

- TypeScript ESM (`"type": "module"`, `module: Node16`, `target: ES2022`, `strict: true`)
- `@earendil-works/pi-coding-agent` ExtensionAPI 作为 peer dependency（`^0.75.4`），由 Pi 运行时提供
- `@earendil-works/pi-ai`（TypeBox schema + token 类型）
- `@earendil-works/pi-tui`（`/context` TUI）
- 工具参数 schema 使用 `@earendil-works/pi-ai` 的 `Type.Object`
- Source-first: Pi 直接加载 `src/*.ts`，不打包 `dist/`

## 当前实现

### 扩展入口

`src/index.ts` 默认导出 `function(pi: ExtensionAPI): void`，在加载时注册三个工具和五个事件 handler（`context`、`turn_end`、`session_before_compact`、`session_compact`、`session_start`、`session_shutdown`）。

`src/context.ts` 单独注册 `/context` 命令。

`package.json` 的 `pi` 字段是 Pi 发现入口：

```json
{
  "extensions": ["./src/index.ts", "./src/context.ts"],
  "skills": ["./skills"]
}
```

### checkpoint 使用 appendLabelChange

不要用 `pi.setLabel(id, name)` 给会话节点打 label。`ctx.sessionManager` 类型是 `ReadonlySessionManager`，运行时是完整 `SessionManager`。

当前实现通过 guarded cast 调用：

```ts
sm.appendLabelChange(entryId, label)
```

`acm_checkpoint` 的默认 target 是 active branch 上最近的有意义 **USER/AI 消息**，跳过 tool result、bash/custom/system 消息、无可见文字的 internal-tool-only AI turn、空消息等。显式 `target` 可用任意节点 ID（含 tool result），但会 warning；**auto-resolve 仍只选 USER/AI**。

checkpoint / `backupCurrentHeadAs` **名称**在整棵树内必须唯一且**大小写敏感**（`Foo` ≠ `foo`），但**同一节点可挂多个别名**（多次 `acm_checkpoint` 或 `backupCurrentHeadAs` 追加 label journal entry，不覆盖旧名）。pi-context 通过扫描全部 `label` 条目重建别名索引。`acm_timeline` 的 `search` 对 label/内容**大小写不敏感**。

`list_checkpoints` 按**别名**逐条列出（同一 `entryId` 可出现多行）。timeline / `full_tree` 显示为 `checkpoint: foo, bar`。

`target: "root"` 解析为 **第一个 top-level 节点**；多根会话会 notify，优先用显式 checkpoint 名或节点 ID。

`acm_checkpoint` 的成功 tool result 会附带当前 context usage 和 **双目标 fold preview**（最近锚点 = phase fold 目标；active path 上最早的 `-start` 锚点 = task-chain fold 目标，各带估算），并声明 "preview 只测量、不选目标"（防止弱模型抄最近锚点导致折叠目标错误）。名字以 `-done` 结尾的 checkpoint 结果附带任务收尾指令（立即 fold 到对应 `-start` 并在 summary 分支上给最终回答）。checkpoint 和 travel 都是**事件绑定**动作（skill 面向弱模型设计，消灭判断词）：checkpoint 绑定任务开始/每条新用户请求/phase 首个动作前/**输出不可预估的工具调用前**（大 read、宽 search、日志、subagent）/危险操作前/里程碑后；fold 绑定六个 **fold moments**：(1) phase 产出结论且下一步要用；(2) 尝试失败或发现方向走错（无锚点时用裸 node ID 回退）；(3) 大段工具输出已提炼完毕；(4) batch item 完成；(5) **任务完成 → 先 fold 再给最终回答**——单次调用 `acm_travel({ target: "<task>-start", backupCurrentHeadAs: "<task>-done", summary })`，`-done` 作为折叠副产品自动产生；(6) 修复：新消息到达且历史上有漏折的完成任务 → fold 到该链**最早**的 `-start`（相关任务连成链回链头，多链堆叠用 root）。fold 是这些时刻的**默认动作**，唯一豁免条件是 fold preview 显示几乎不降。锚点命名：`-start` = 打点即承诺回折的 fold target；`-done` = 成果在手的双用途锚（后续失败时的撤退点 + 身前 raw 的 recovery bookmark）。**锚点是便利品不是前提**：`acm_travel`/`acm_checkpoint` 都接受裸 node ID，skill 内置无锚修复三步宏。summary 用六槽填空模板。三个工具的 description 内嵌这些触发规则；timeline HUD 的 travel cue 附可抄调用并提示 node-ID 部分折叠。

`acm_travel` 的 `backupCurrentHeadAs` 同样落在最近有意义的 USER/AI 消息上，而不是 raw HEAD（避免 backup 打在 `acm_timeline` 等 tool result 上）。若从 HEAD 回退，tool result 会写明 `backup@entryId (resolved from HEAD …)`。若 backup 已写入但 `branchWithSummary` 失败，extension 会 **best-effort 回滚** backup label；回滚失败时 error/details 会注明 label 仍留在树上。

### timeline 是会话树结构视图

`acm_timeline` 默认只展示 **active path**（LLM 实际看到的 spine），并附带 context HUD。`verbose: true` 仅在 **active path 模式**下显示 ACM 工具调用及 system/custom 元消息；`list_checkpoints` / `search` / `full_tree` 会忽略 `verbose`。

HUD 字段：

- context usage（official + last LLM prompt via `turn_end` 缓存，travel 后比 official 更准确）
- active path 节点数
- off-path summary 数（abandoned `branch_summary` 脚注，非所有分叉）
- 距离最近 checkpoint 的 step 数
- travel cue
- 大树提示：优先 `list_checkpoints` 或 `search`

**默认模式不再把 off-path 的 `branch_summary` / `compaction` 插进主序列。** 在分支点以 `[off-path]` 脚注标出，避免假线性叙事。

`list_checkpoints: true` 扫描整棵树上的 checkpoint（显示上限 50，可用 `search` 缩小）；深树时优先于 `full_tree`。

`full_tree: true` 会渲染 `sm.getTree()` 返回的整棵会话树，包含 off-path branch、checkpoint label、HEAD、`branch_summary` 的 `branchPoint` / `origin` 元数据等。深度/行数超限时会截断并提示用 `list_checkpoints` 或 `search`。

`search` **默认全树搜索**（active + off-path），按 label、节点 ID、内容匹配；传了 `search` 就不再限于 active path。`list_checkpoints` 可与 `search` 组合缩小清单。

**模式优先级**（多参数同时传时只跑一种，其余忽略）：`list_checkpoints` > `search` > `full_tree` > 默认 active path。

### travel 使用 branchWithSummary + context event

当前 travel 方案是同步执行：

1. 解析 `target`，支持 checkpoint 名、节点 ID、`root`。
2. 如传入 `backupCurrentHeadAs`，先给当前 HEAD 打恢复 label（不是 travel 目标）。
3. 构造 handoff summary（用户提供的 `summary` 正文）。
4. guarded cast 到完整 `SessionManager`，调用：

```ts
sm.branchWithSummary(targetId, summary, undefined, true)
```

5. 设置模块级 `refreshPending` 标志，并记录 `refreshTargetLeafId`。
6. `pi.on("context", ...)` 在**每次** LLM 调用前从 `sm.buildSessionContext()` 重建 messages 并覆盖发给模型的上下文。Pi 的 context 返回值默认只影响单次 LLM 调用，且 travel 后 SM leaf 可能被移回旧分支（tool result append），因此采用**持久覆盖**：travel 后每个 LLM turn 都 rebuild，直到 `session_start`/`session_shutdown`/`session_compact` 清除 pending。rebuild 时调用 `fixOrphanedToolUse` 修补孤立的 tool_use。rebuild 失败则 pass-through 原始 messages。`session_compact` 会清 pending 并 invalidate `cachedUsage`（compaction 内部已 sync agent state）。

travel tool result 为 3 行文本（比 omp 版精简）：完成摘要、`contextRefreshPending` 提示、执行 NEXT + 打 `<phase>-start` 锚点。`details` 含 `estimatedEffect`、`structuralEffect`、`messageDelta`、`summaryEntryId`、`contextRefreshPending`。

travel 改的是 Pi 会话历史树和发给模型的上下文，不会回滚磁盘文件、进程、浏览器状态、远端服务或任何外部副作用。

travel 不保证降 token：目标在噪音之前通常 structural `shrunk`，目标在大量 raw history 之后通常 structural `restored`。tool result 报告 `usageBefore` 与同步 **估算** `estimatedUsageAfter` / `estimatedEffect`（`buildSessionContext` + token 估算）；官方 % 在下一步 `acm_timeline` HUD 或 `turn_end` 缓存可确认。`list_checkpoints` 的 `~% est.` 仅估算 target path（不含 travel summary）。

### Pi 独有事件优化

| 事件 | 作用 |
|---|---|
| `turn_end` | 缓存 LLM response 的真实 prompt tokens，HUD 显示准确数值（解决 travel 后 official HUD 滞后） |
| `session_before_compact` | compaction 前自动打 `pre-compact-{timestamp}` checkpoint，事后能 travel 回来恢复细节 |
| `session_compact` | compaction 触发 replaceMessages 后同步状态（清 refreshPending + cachedUsage） |

### 已知限制：compaction 与 agent state

持久 context 覆盖修了 LLM outbound messages，但 Pi agent 内部的 `agent.state.messages` 在 travel 后可能仍滞后，直到 compaction 或下一轮 rebuild。`session_before_compact` 自动 checkpoint 提供恢复路径。`session_compact` 后 refresh pending 会清除，因为 compaction 已 sync state。

与 omp 版不同：pi 版**没有**按 session 隔离的 `ContextRefreshRegistry`（模块级 refresh 标志）。自 `211dd10d` 起已对齐 backup label 失败回滚与 `before_provider_request`（ACM 工具 `strict: false`）。

### 没有 /acm command

当前代码没有 `/acm` command、`navigateTree()`、`agent_end`/`session_before_tree` 流程，也没有 `session_stop` continuation。

## 关键设计决策

### 使用 guarded runtime cast

`ctx.sessionManager` 类型是 `ReadonlySessionManager`，但运行时是完整 `SessionManager`。当前实现为了获得必要能力，使用 guarded cast 调用内部方法：

- `appendLabelChange`
- `branchWithSummary`
- `buildSessionContext`

调用前必须检查方法存在，并在缺失时返回清晰错误。不要静默失败。

### BranchSummaryEntry.fromId 是 branch point，不是 origin

Pi 的 `fromId` 字段表示 branch point（travel target），不是旧 HEAD。timeline 渲染使用 `branchPoint` / `origin`（来自 `details`），不要把 `fromId` 显示成 `from`。

### TypeBox schema

`registerTool` 的参数使用 `@earendil-works/pi-ai` 的 `Type.Object` / `Type.String` 等，与 Pi 工具注册类型一致。不要用独立 zod 实例。

### 类型导入

从 `@earendil-works/pi-coding-agent` 主包导入 `ExtensionAPI`、`SessionManager`、`SessionEntry` 等类型。

### 工具命名使用 acm_ 前缀

三个工具名固定为 `acm_checkpoint`、`acm_timeline`、`acm_travel`。

### Context refresh 用模块级标志

与 omp 的 `ContextRefreshRegistry`（按 session 实例隔离）不同，pi 版用模块级 `refreshPending` / `refreshAttempts` / `refreshFailure` / `refreshTargetLeafId`。单进程多 session 并发时可能串扰（Pi 典型用法为单 session，可接受）。

## 结构

| 路径 | 作用 |
|---|---|
| `src/index.ts` | 三个工具注册、checkpoint label、timeline 渲染、同步 travel、context refresh、事件 handler |
| `src/lib.ts` | 可单测的纯逻辑（label maps、resolve、usage 估算、meaningful entry、timeline 模式） |
| `src/context.ts` | `/context` TUI 可视化 token 占用 |
| `src/utils.ts` | TUI 辅助（`formatTokens` 等） |
| `skills/context-management/SKILL.md` | 驱动 agent 使用 checkpoint/timeline/travel 的 prompt（事件绑定打点 + 六个 fold moments 含任务末尾默认折叠与无锚修复 + `-start`/`-done` 命名语义 + 六槽 summary 模板，面向弱模型，无判断词、无具体百分比示例） |
| `skills/context-management/references/playbook.md` | 单文件 playbook：fold moments 对照 + 八类场景 worked examples（含填好的 summary 模板与无锚 node-ID 回退示例）+ 兜底 |
| `README.md` | 面向用户的安装和功能说明 |

## 开发注意事项

- 改实现前先读 `src/index.ts` 中对应工具的完整 execute flow。
- 不要把 travel 解释成文件系统回滚。它只影响会话上下文。
- 验证类型用 `npm run typecheck`（`tsc --noEmit`）。
- 与 omp-context 对齐 skill/工具文案时，以 omp 的 `skills/` 和 `src/index.ts` 字符串为准；实现差异见上文「已知限制」。
