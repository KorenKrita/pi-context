# ACM Tool Contracts

这是工具描述、prompt metadata、result cue 和 recovery 文案的单一来源。改了要跑 `bun run generate:guidance` 重新生成 `src/generated-guidance.ts`。

## Tool descriptions

<!-- ACM:TOOL_CHECKPOINT:START -->
给当前会话状态起个名字存档，以后能用这个名字回到这个状态。不改变当前对话。省略 target 时自动存到调用前最近的有效位置；传 target 可以存指定的历史节点。
<!-- ACM:TOOL_CHECKPOINT:END -->

<!-- ACM:TOOL_TIMELINE:START -->
查看会话树。view 选 active(默认，看当前对话主线)、checkpoints(看所有存档点)、search(搜历史内容)、tree(看整棵树结构)。
<!-- ACM:TOOL_TIMELINE:END -->

<!-- ACM:TOOL_TRAVEL:START -->
把一段已完成的过程折叠成一份简短交接说明。对话变短，原文留在历史树里随时能取回。target 是折叠到哪个存档点或节点(那段过程开始之前的位置)，handoff 是写给折叠后的自己的交接说明。必须单独调用，不能和其他工具混在一个 batch。
<!-- ACM:TOOL_TRAVEL:END -->

## Prompt snippets

<!-- ACM:SNIPPET_CHECKPOINT:START -->
存档当前状态
<!-- ACM:SNIPPET_CHECKPOINT:END -->

<!-- ACM:SNIPPET_TIMELINE:START -->
查看会话树和存档点
<!-- ACM:SNIPPET_TIMELINE:END -->

<!-- ACM:SNIPPET_TRAVEL:START -->
折叠一段已完成的过程
<!-- ACM:SNIPPET_TRAVEL:END -->

## Prompt guidelines

<!-- ACM:GUIDELINE_CHECKPOINT:START -->
acm_checkpoint 随时可用，不改变当前对话，想存就存。
<!-- ACM:GUIDELINE_CHECKPOINT:END -->

<!-- ACM:GUIDELINE_TIMELINE:START -->
acm_timeline 的 view 按需要选:active 看主线，checkpoints 看存档点，search 搜内容，tree 看结构。
<!-- ACM:GUIDELINE_TIMELINE:END -->

<!-- ACM:GUIDELINE_TRAVEL:START -->
acm_travel 折叠后直接按 handoff 的 next 继续，不要重读刚折叠的内容;折叠不回滚文件或命令。
<!-- ACM:GUIDELINE_TRAVEL:END -->

## Result cues

<!-- ACM:CUE_CHECKPOINT:START -->
已存档。当前对话不变。需要时用这个名字回到这个状态。
<!-- ACM:CUE_CHECKPOINT:END -->

<!-- ACM:CUE_TRAVEL:START -->
已折叠。handoff 是现在的状态，按它的 next 继续。不要重读刚折叠的内容。
<!-- ACM:CUE_TRAVEL:END -->

<!-- ACM:CUE_REBASE_CHECK:START -->
当前对话已有一层交接说明，再折叠会再加一层。可以考虑把已有的几层合并成一份更早的，但不强制。
<!-- ACM:CUE_REBASE_CHECK:END -->

<!-- ACM:CUE_ADVANCED_TARGET_POINTER:START -->
如果 target 还是选不准，先把这段过程得出了什么结论、下一步做什么想清楚，再选它开始之前的存档点。
<!-- ACM:CUE_ADVANCED_TARGET_POINTER:END -->

<!-- ACM:CUE_ADVANCED_EXCEPTIONAL_POINTER:START -->
出错了先别急着重试。看清楚报错，确认折叠到底有没有生效，再决定怎么办。
<!-- ACM:CUE_ADVANCED_EXCEPTIONAL_POINTER:END -->

<!-- ACM:CUE_TIMELINE_ACTIVE:START -->
active 是当前对话主线。看看有没有已经不需要的过程可以折叠。
<!-- ACM:CUE_TIMELINE_ACTIVE:END -->

<!-- ACM:CUE_TIMELINE_CHECKPOINTS:START -->
checkpoints 列出所有存档点。折叠时选这段过程开始之前的那个存档点。
<!-- ACM:CUE_TIMELINE_CHECKPOINTS:END -->

<!-- ACM:CUE_TIMELINE_SEARCH:START -->
search 搜整棵历史树。缩小范围，找到要折叠的那段开始之前的节点。
<!-- ACM:CUE_TIMELINE_SEARCH:END -->

<!-- ACM:CUE_TIMELINE_TREE:START -->
tree 看树结构。别选要折叠的那段里面的节点，也别选另一条分支上的。
<!-- ACM:CUE_TIMELINE_TREE:END -->

## Manual navigation summary instructions

用户用 /tree 选 "Summarize" 且没给自定义指令时，作为完整摘要提示注入，让原生分支摘要也保持七槽交接说明的形态。用户给的指令永远优先。

<!-- ACM:TREE_SUMMARY_INSTRUCTIONS:START -->
把这条要放弃的对话分支总结成一份交接说明，让以后回来的人能接着干。

就写这七行，每行一个，按顺序，不要加别的标题:

Goal: 这条分支想干什么。
State: 这里得出了什么结论、有什么证据、还有什么没搞清楚的。写清楚还在用的文件、符号、数值。
Evidence: 能直接验证的线索——文件路径、命令、ID。没有就写 none。
External: 对话之外留下的改动——改了哪些文件、跑了什么命令。没有就写 none。
Exclusions: 这里试过但行不通的方向，免得重来。没有就写 none。
Recover: 最有用的存档点或节点 ID，方便回来。没有就写 none。
NEXT: 如果接着干，下一步具体做什么。

保留准确的文件路径、函数名、错误信息和数字，这些比描述重要。整体简短。
<!-- ACM:TREE_SUMMARY_INSTRUCTIONS:END -->

## Recovery guidance

<!-- ACM:RECOVERY_NAME_COLLISION:START -->
这个名字已经被别的存档点用了。换个名字——保留原意，加个序号、范围或日期。别覆盖原来的。
<!-- ACM:RECOVERY_NAME_COLLISION:END -->

<!-- ACM:RECOVERY_HOST_CAPABILITY:START -->
Pi 的 SessionManager 不支持这个操作。停下，报告这个错误，确认 Pi 版本支持后再试。
<!-- ACM:RECOVERY_HOST_CAPABILITY:END -->

<!-- ACM:RECOVERY_ROLLBACK_FAILED:START -->
备份存档点没删掉。记下它的名字和节点 ID 作为恢复线索，再重试。
<!-- ACM:RECOVERY_ROLLBACK_FAILED:END -->

<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:START -->
折叠没成功，备份存档点已经回滚。修好报的错再重试。
<!-- ACM:RECOVERY_BRANCH_ROLLED_BACK:END -->

<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:START -->
因为折叠可能已经生效，备份存档点没自动删。保留这个备份指针，先看看当前节点再重试。
<!-- ACM:RECOVERY_ROLLBACK_SKIPPED:END -->

<!-- ACM:RECOVERY_REFRESH_PENDING:START -->
折叠生效了，但重建对话内容还没完成。用报的 summary 节点作为备用，下次重建还不行就看 context sync 状态。
<!-- ACM:RECOVERY_REFRESH_PENDING:END -->

<!-- ACM:RECOVERY_RESTORED_HISTORY:START -->
这次 travel 恢复了之前的历史(context 变大了)。如果是有意的取回，拿走需要的细节就继续;如果是误操作，travel 回之前的存档点。
<!-- ACM:RECOVERY_RESTORED_HISTORY:END -->

<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:START -->
重建对话重试次数用完了。重新加载会话，确认当前分支对了再继续。
<!-- ACM:RECOVERY_REFRESH_EXHAUSTED:END -->
