# settings-api.ts — Web 管理面板 API

**文件**: `src/settings-api.ts`（193 行）

## 职责
dsh Web 侧的管理 API（/channel-qq-api，loopback only）：连接状态、客户端能力矩阵、
配置可观测。

## 模块连接
- **上游**: index.ts（装配，传入 client 身份/连接状态）
- **依赖**: client-compat.ts（describeClient/capabilityMatrixOf 展示）
- **安全**: 仅 loopback——不暴露公网
