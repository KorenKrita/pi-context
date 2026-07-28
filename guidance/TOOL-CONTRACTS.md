# ACM 工具文案

工具描述、prompt 片段、结果提示、恢复文案的唯一来源。改完跑 `bun run generate:guidance` 重新生成。

## 工具描述

<!-- ACM:TOOL_CHECKPOINT:START -->
存档：给会话当前位置起个名字，之后可以用 acm_travel 回来。免费、瞬间完成、不改变上下文。不传 `target` 就标记当前位置（推荐）；传节点 ID 或已有存档名可以标记更早的位置。
<!-- ACM:TOOL_CHECKPOINT:END -->

<!-- ACM:TOOL_TIMELINE:START -->
查看会话。选一个视图：`active`（当前上下文里的内容）、`checkpoints`（存档列表）、`search`（全树搜索，含已折叠的历史）、`tree`（分支结构）。同时报告 token 用量和同步状态。
<!-- ACM:TOOL_TIMELINE:END -->

<!-- ACM:TOOL_TRAVEL:START -->
折叠：回到 `target`（存档名、节点 ID 或 'root'），把那之后的历史替换成交接单（goal/state/next 必填，evidence/external/exclusions/recover 按需），上下文随之变小。原始历史留在会话树里可以找回。只折叠已经做完的事；如果还欠用户一个答复，先答复再折。单独调用，不要和其他工具放在同一批。回执：applied / not_applied / indeterminate。
<!-- ACM:TOOL_TRAVEL:END -->

## 结果提示

<!-- ACM:CUE_CHECKPOINT:START -->
存档完成，上下文无变化。之后可用 acm_travel 回到这里。
<!-- ACM:CUE_CHECKPOINT:END -->

<!-- ACM:CUE_TRAVEL:START -->
折叠完成。交接单就是当前工作状态：直接执行 next，不要回头重读折掉的内容；缺某个细节时用 recover 指针找回。
<!-- ACM:CUE_TRAVEL:END -->

<!-- ACM:CUE_REBASE_CHECK:START -->
这条路径已叠多层折叠摘要。可以合并：回到更早的干净位置，写一份装下全部存活信息的交接单。
<!-- ACM:CUE_REBASE_CHECK:END -->

<!-- ACM:CUE_TIMELINE_ACTIVE:START -->
以上是当前上下文。已经做完、只剩结论有用的段落可以用 acm_travel 折掉。
<!-- ACM:CUE_TIMELINE_ACTIVE:END -->

<!-- ACM:CUE_TIMELINE_CHECKPOINTS:START -->
折叠目标选在要折内容之前最近的干净点。标 raw archive 的存档指向折叠前的完整历史，用于找回旧细节，不要当折叠目标。
<!-- ACM:CUE_TIMELINE_CHECKPOINTS:END -->

<!-- ACM:CUE_TIMELINE_SEARCH:START -->
搜索覆盖整棵树，含已折叠的历史。结果里的节点 ID 可直接作为 acm_travel 或 acm_checkpoint 的目标。
<!-- ACM:CUE_TIMELINE_SEARCH:END -->

<!-- ACM:CUE_TIMELINE_TREE:START -->
分支结构用于确认目标的先后关系；不要把折叠目标选在要折的范围里。
<!-- ACM:CUE_TIMELINE_TREE:END -->

## 手动 /tree 摘要指令

用户在 /tree 里选 "Summarize" 且没写自定义指令时，注入这份摘要提示，让原生分支摘要也长成交接单的样子。

<!-- ACM:TREE_SUMMARY_INSTRUCTIONS:START -->
把这条被放弃的对话分支总结成一份交接单，给以后回来的人看。

只写下面七行，按顺序，每行一个字段，不要其他标题：

Goal: 这条分支想完成什么。
State: 确定了什么（附依据）、还有什么不确定。写清仍然相关的 exact file paths、符号和数值。
Evidence: 可直接核实的指针——文件路径、命令、ID。没有写 none。
External: 留下的外部影响——改过的文件、跑过的命令、动过的系统。没有写 none。
Exclusions: 试过并放弃的方向，避免重蹈。没有写 none。
Recover: 最有用的存档名或节点 ID。没有写 none。
NEXT: 恢复这项工作时最具体的下一步。

保留 exact file paths、函数名、报错信息和数字，它们比描述重要。整体保持简短。
<!-- ACM:TREE_SUMMARY_INSTRUCTIONS:END -->

## 恢复文案

<!-- ACM:RECOVERY_NAME_COLLISION:START -->
这个名字已被占用。保留原有存档，换个新名字（加个范围、序号或日期）。
<!-- ACM:RECOVERY_NAME_COLLISION:END -->

<!-- ACM:RECOVERY_HOST_CAPABILITY:START -->
宿主缺少所需能力，什么都没有改。报告这个能力错误；确认 Pi 版本是否是本扩展支持的版本。
<!-- ACM:RECOVERY_HOST_CAPABILITY:END -->

<!-- ACM:RECOVERY_ROLLBACK_FAILED:START -->
备份标签还留在树里。重试前先记下它的名字和条目 ID。
<!-- ACM:RECOVERY_ROLLBACK_FAILED:END -->

<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:START -->
折叠在改动任何东西之前就失败了，备份标签已回滚。先解决报告的宿主错误再重试。
<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:END -->

<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:START -->
自动回滚备份不安全，备份标签保留了。记下备份指针，重试前先用 acm_timeline 确认当前位置。
<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:END -->

<!-- ACM:RECOVERY_REFRESH_PENDING:START -->
折叠已生效，但重建后的上下文还没确认。如果下一轮不对劲，用 acm_timeline 查看同步状态。
<!-- ACM:RECOVERY_REFRESH_PENDING:END -->

<!-- ACM:RECOVERY_RESTORED_HISTORY:START -->
这次 travel 恢复了旧历史（上下文变大而不是变小）。如果是来取某个细节的，拿到后立刻 travel 回你的返回存档。只有当你有意把这条分支当作新的工作状态时才留下。
<!-- ACM:RECOVERY_RESTORED_HISTORY:END -->

<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:START -->
上下文重建重试次数用尽。重新加载会话，用 acm_timeline 查看同步状态，确认活动分支无误后再继续。
<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:END -->
