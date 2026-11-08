<div align="center">

🚧 **dm-gate** ｜ [← knowledge](./knowledge.md) ｜ [📚 总索引](./README.md) ｜ [emotion →](./emotion.md)

</div>

---

# dm-gate.ts — 陌生人私聊门控

**文件**: `src/dm-gate.ts`（152 行）

## 职责
私聊不是谁都能跟 Agent 聊：admins/allowList/QQ 好友直通，陌生人进待审（不进 agent
不耗模型），主人三种放行方式。

## 关键机制
- 好友校验：好友列表本地比对（30 秒缓存）——加好友即自动放行
- 待审通知：同一陌生人 10 分钟一次 + 全局 60 秒连发保护
- deny 冷却：静默丢弃，不再回复不再通知
- 陌生群预警：非白名单群收到消息给主人发预警（bridge.ts 调 alert）
- 状态持久化：`<dshHome>/channel-qq/dm-gate.json`

## 模块连接
- **上游**: bridge.ts（私聊事件先过门）、index.ts（装配）
- **下游**: tools.ts（qq_dm_gate 审计工具）
