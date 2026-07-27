# 工具契约

## 工具描述

### acm_checkpoint
存档点。给当前状态起个名字，之后随时能回来。免费，不改变任何东西。不传target就存当前位置，传了就存指定位置。

### acm_timeline
看地图。查看当前对话(active)、存档点(checkpoints)、搜索历史(search)、分支结构(tree)。顺便告诉你现在用了多少token。

### acm_travel
收纳。跳回之前某个点，把中间的过程换成一份简短的交接单。历史原文还在树里，随时能回去取。必须单独调用，不能和其他工具一起。结果只有三种：成功、没成功、不确定。

## 参数

### acm_checkpoint
- `name`: 存档点名字，随便起，好记就行。不能叫root。
- `target`: 可选。不传就存当前位置，传节点ID或已有的存档点名字就存那个位置。

### acm_timeline
- `view`: 看哪个。active=当前内容，checkpoints=存档点，search=搜索，tree=分支。默认active。
- `limit`: 返回多少条。
- `verbose`: 是否显示所有消息，包括工具调用等内部消息。只对active有效。
- `filter`: 可选。过滤存档点，不区分大小写。只对checkpoints有效。
- `query`: 搜索关键词，搜标签、节点ID、内容都行，不区分大小写。view=search时必填。

### acm_travel
- `target`: 跳到哪里。传存档点名字、节点ID或root。选你想折叠的内容之前的最后一个干净点。
- `handoff`: 交接单，7个字段的对象或JSON字符串。
- `backupCurrentHeadAs`: 可选。给当前位置起个新名字，方便以后找回来。不影响跳到哪里。

## 交接单字段

- `goal`: 当前目标，包括还没给用户的结果。
- `state`: 给未来自己的活认知：已知的、未知的、假设、关键值。写不清楚说明还没整理好。可以多行。
- `evidence`: 支撑State的证据：文件路径、命令、ID。没有就写none。
- `external`: 外部状态：改了什么文件、跑了什么命令、动了什么系统。没有就写none。
- `exclusions`: 放弃的方向：试过但不行的，免得重蹈覆辙。没有就写none。
- `recover`: 恢复点：存档点名字或节点ID，想回去时用。没有就写none。
- `next`: 下一步：具体的、能立刻执行的动作。

## 工具返回

### 成功
- checkpoint: 存档完成，返回存档点名字、节点ID、上下文用量。
- timeline: 返回对应视图的内容。
- travel: 折叠成功，返回目标、新叶子节点、上下文变化。

### 失败
- checkpoint: 名字被占、目标找不到、会话为空等。
- travel: 目标找不到、已经在目标位置、交接单无效等。

### 恢复指导
- 名字被占：换个名字。
- 宿主没能力：检查Pi版本。
- 折叠失败：记下备份指针，再试。
- 折叠成功但上下文没确认：检查acm_timeline同步状态。

## 折叠交接单示例

```json
{
  "goal": "找出为什么checkout延迟翻倍了。",
  "state": "不是数据库——查询时间正常。两个假设：连接池耗尽（错误相关，证据弱）vs payments客户端新加的重试循环（v2.3.0加的，没测过）。关键值：pool max=50在config/prod.yaml:23；重试commit 9f31c2a。",
  "evidence": "dashboards/checkout-p99.json；git log v2.2.0..v2.3.0 -- services/payments。",
  "external": "none",
  "exclusions": "数据库索引——验证过没问题，别再查了。",
  "recover": "latency-hunt-scan",
  "next": "读services/payments/client.ts里的重试循环，检查backoff上限和pool max=50的关系。"
}
```
