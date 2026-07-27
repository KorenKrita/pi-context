# ACM 使用指南

你有三个工具来管理对话上下文，防止 context 太长导致变慢变贵。

## 三个工具

### acm_checkpoint - 存档
给当前状态起个名字，以后可以回来。
```
用法: acm_checkpoint(name: "my-checkpoint")
```

### acm_timeline - 查看状态  
看看 context 用了多少，有哪些存档点。
```
用法: acm_timeline()
用法: acm_timeline(view: "checkpoints")  // 只看存档点
```

### acm_travel - 压缩
把之前的过程压缩成一个简短的总结，释放 context 空间。
```
用法: acm_travel(
  target: "checkpoint-name",  // 压缩到哪个点
  handoff: {
    goal: "当前目标",
    state: "进展和发现",
    evidence: "相关文件路径等，没有写 none",
    external: "改过的文件，没有写 none", 
    exclusions: "试过不行的方向，没有写 none",
    recover: "可回退的存档点，没有写 none",
    next: "下一步做什么"
  }
)
```

## 什么时候用

1. **context 超过 50%** → 用 `acm_travel` 压缩一下
2. **要做重要/危险操作** → 先 `acm_checkpoint` 存个档
3. **不确定状态** → 用 `acm_timeline` 看看

## 注意事项

- checkpoint 很轻量，随便存，不影响当前工作
- travel 会改变 context，确保当前工作告一段落再压缩
- 压缩后的历史还在，随时可以通过 travel 回去看
