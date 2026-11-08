<div align="center">

⏰ **scheduler** ｜ [← affection](./affection.md) ｜ [📚 总索引](./README.md) ｜ [sent-log →](./sent-log.md)

</div>

---

# scheduler.ts — 主动出击调度

**文件**: `src/scheduler.ts`（225 行）

## 职责
Agent 的自主节律：patrol 巡逻 / dm-proactive 私聊主动 / dream 睡梦（04:xx）/
knowledge-extract（04:40 知识提取任务）/ evolve 六期进化。

## 关键机制
- `timeContext()`：时段感知（深夜/清晨/…，注入上下文的（当前时段：…）——实时时间感
  由这里在 **user 消息层**补充，不碰 system 前缀（缓存率设计的一部分）
- jittered 调度（9min/22min 抖动）防机械感
- tick 经 bridge.adminPrompt 注入会话；turn in flight 时不打断

## 模块连接
- **上游**: index.ts（装配）
- **下游**: bridge.ts（submit/adminPrompt）
- **配置**: 频率硬编码于启动日志（patrol 9min jittered 等）
