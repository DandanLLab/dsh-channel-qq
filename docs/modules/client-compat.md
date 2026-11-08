# client-compat.ts — 客户端识别与能力矩阵

**文件**: `src/client-compat.ts`（126 行）

## 职责
连接握手时识别对端 OneBot 实现（NapCat/go-cqhttp/Lagrange/…），维护**能力矩阵**：
每个客户端支持哪些扩展 action。

## 关键机制
- `detectClient(handshake)` → ClientIdentity（kind/version）
- `capabilityOf(kind, action)` → 支持/不支持/未知
- tools.ts 调用扩展 action（如群荣誉、AI 声音）前先查能力——不支持时给 agent
  明确报错而不是超时悬挂

## 模块连接
- **被依赖**: onebot.ts（连接时识别）、tools.ts（调用前检查）、settings-api.ts（面板展示）
- **数据**: 纯内存矩阵，无落盘
