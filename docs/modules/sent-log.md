<div align="center">

📜 **sent-log** ｜ [← scheduler](./scheduler.md) ｜ [📚 总索引](./README.md) ｜ [settings-api →](./settings-api.md)

</div>

---

# sent-log.ts — 发送流水

**文件**: `src/sent-log.ts`（62 行）

## 职责
Agent 每条出站的持久化流水，跨重启可查——防"这不是我发的"翻账。

## 关键机制
- 按**窗口**独立账本（key=group-xxx/dm-xxx）：1107 修掉 primarySentLog 写死主群、
  私聊流水串进群文件的串账 bug；bridge.sentLogFor(key) 开 public
- render()：尾部流水注入上下文（"自己最近发过什么"）

## 模块连接
- **上游**: bridge.ts（outbound 后记账）、tools.ts（取账本）
- **数据**: `<dshHome>/channel-qq/sent-log-<key>.log`
