<div align="center">

🧱 **types** ｜ [📚 总索引](./README.md) ｜ [segments →](./segments.md)

</div>

---

# types.ts — OneBot 协议类型契约

**文件**: `src/types.ts`（65 行）

## 职责
定义 OneBot v11 事件的 TypeScript 形状，是全插件与 NapCat 通信的**类型契约层**——
零运行时逻辑，纯 interface。

## 关键内容
- `OneBotSender`：发送者（user_id/nickname/card/role/title）
- `OneBotEvent`：事件（post_type/message_type/group_id/user_id/message_id/message 数组段/time/sender）
- `OneBotActionPayload` / `OneBotApiResponse`：action 调用与响应（status/retcode/data）

## 模块连接
- **被依赖**: onebot.ts（传输层收发）、segments.ts（解析输入）、bridge.ts（事件消费）、
  tools.ts（action 调用参数）——全插件的公共词汇表
- **上游**: NapCat 的 JSON 帧（形态由本文件刻画）
- **下游**: 无（叶子类型库）
