# services.ts — dsh 底座类型胶水

**文件**: `src/services.ts`（141 行）

## 职责
与 dsh harness 类型系统的适配：SessionId 品牌类型、消息块（TextBlock/ImageBlock）、
AgentPresetsService 形状——让插件代码与底座版本解耦的隔离层。

## 模块连接
- **被依赖**: bridge.ts（会话句柄类型）、tools.ts（preset 查询）
- **设计**: 底座 API 变更时只改这一层
