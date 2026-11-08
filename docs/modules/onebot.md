<div align="center">

📡 **onebot** ｜ [← segments](./segments.md) ｜ [📚 总索引](./README.md) ｜ [client-compat →](./client-compat.md)

</div>

---

# onebot.ts — OneBot 传输层

**文件**: `src/onebot.ts`（256 行）

## 职责
与 NapCat 的全部 WS 通信：reverse（dsh 开 server 监听 8082）/forward（主动连）双模式、
心跳看门狗、action 调用、事件转发、空消息总闸。

## 关键机制
- `startReverseServer()`：dsh 侧监听（NapCat 作为 client 反连），accessToken Bearer 鉴权
- 心跳：`no pong for 65s` 判僵尸链路，主动 teardown 等 NapCat 5 秒回连
- **空消息总闸**（1107）：`send_*_msg` 的 message 数组若无任何可渲染内容直接拒发——
  NapCat 不拦空帧，QQ 客户端只会显示"该消息不支持显示"
- `call(action, params, timeoutMs)`：统一 action 出口；能力矩阵路由（client-compat）
- 断连宽限：重连窗口 12 秒内不甩失败给 agent

## 模块连接
- **上游**: NapCat WS 帧
- **下游**: bridge.ts（事件）、outbound.ts/chain.ts/tools.ts（action 调用）
- **依赖**: ws、client-compat.ts（识别与能力）、config.ts（ConnectionConfig）、types.ts
- **运维**: 8082 LISTENING + NapCat ESTABLISHED + channel-qq.log 增长 = 链路铁证
