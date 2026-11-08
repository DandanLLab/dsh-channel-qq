# system prompt 缓存率稳定化（v0.3.5）

## 问题：provider 前缀缓存命中率归零

实测（活跃 DM 会话解包审计，272 回合）：

- `system/message` 事件 272 条，其中 **271 次是 surface replace**——几乎每回合都在重写 system 节点。
- system 文本约 47KB，逐回合长度 47101 → 47105 → 47143 → …（差几十字节），内容差异集中在尾部约 4KB 的动态区。
- 对 provider 的前缀缓存（prefix caching）来说，**system 消息每回合被整体替换 = 全部前缀缓存作废**。LLM 请求的计费与延迟按全量重算。

## 底座机制（为什么尾部动一下等于全部重写）

dsh 底座（agent-loop）每回合在 `step()` 里：

1. `systemPrompt.refreshContext(assembly, …)` 重新求值**全部**注册的 `systemPrompt.section`；
2. `renderPrompt(assembly)` 把预设与 sections 渲染成**一份** system 文本；
3. `SystemPromptProjection.project(rendered, …)` 与上一个 system 节点做**整份对比**：
   - 文本没变 → 零操作（缓存前缀保住）；
   - 文本变了 → replace 首节点（非 in-history 路由）或追加新 system 节点（in-history 路由，历史里每变一次多一份 47KB 副本）。

也就是说，**sections 是整份拼接后再对比的**——任何一个 section 动一个字节，整份 47KB 都算"变了"。位置无关、只看全文。

## 变化源本体：滚动窗口随对话滑动

life-engine 注入的动态段里，真正逐回合滚动的是：

| 段落 | 滚动源 | 频率 |
| --- | --- | --- |
| 认可语料（像这样说话） | `82-认可语料.jsonl` 尾部样本 | 她每说一句话就追加 |
| 最近交互（回复前自问三问） | `knowledge/interactions.jsonl` 尾部 3 条 | 每次交互 |
| 规则窗口（injectRules=10） | 新规则入窗、旧规则滑出 | 每次捕获 |
| 近 24h 生活事件 | `events.json` 时间窗过滤 | 分钟级 |
| 推理层·此刻 | `HH:MM` + 距上次对话 gap | 分钟级 |

对话本身就会驱动这些文件更新，于是"说话 → 文件变 → 下回合 system 变 → 缓存全灭"形成死循环。

## 修复：首渲染冻结（进程级）

`life-engine.js` 在注册 sections 前包一层冻结壳：

```js
const origSection = ctx.systemPrompt.section.bind(ctx.systemPrompt)
ctx.systemPrompt.section = (spec) => {
  if (spec && typeof spec.text === 'function') {
    const fn = spec.text
    let val = null, done = false
    spec.text = (context) => {
      if (!done) { try { val = fn(context) || '' } catch { val = '' } ; done = true }
      return val
    }
  }
  return origSection(spec)
}
```

每个 section 首次渲染后值固定，**进程生命周期内 system prompt 完全静态** → 前缀缓存命中率趋近 100%。

**时效性权衡**（为什么可以接受）：

- 本会话内新写的规则/语料/事件不再进入 system 注入——但这些信息就在对话历史里，模型自己看得见；
- 实时时间感由 bridge 层的 `（当前时段：…）` user 消息补充（消息级注入不碰 system 前缀）；
- dsh 重启或会话归档后，新会话的首渲染快照自然携带最新文件状态。

**不采用**的方案与原因：底座级 per-section 节点化投影（每个 section 独立 system 节点、只 replace 变化的尾部节点）可以同时保住静态前缀与动态时效，但要改底座 session surface 的节点语义，风险与收益不成比例；时间桶（15/30 分钟粒度）只降频不归零，仍是每桶一次全份重写。

## 验证方法

对活跃会话重跑解包审计：修复后新增回合不应再产生 `system/message` 的 replace 事件（首渲染快照之后 system 节点数恒定）。
