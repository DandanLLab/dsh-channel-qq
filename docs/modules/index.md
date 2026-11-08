# index.ts — 入口与生命周期

**文件**: `src/index.ts`（271 行）

## 职责
cordis Service 装配点：resolveConfig → 按序实例化全部组件并接线 → dispose 链。

## 启动顺序（=依赖顺序）
1. resolveConfig → 2. OneBotClient → 3. OutboundQueue → 4. ConversationBridge
5. registerQQTools（72 工具，sentLogFor 按窗口取账）→ 6. applyLifeEngine
7. applyMemeEngine → 8. Scheduler → 9. DmGate → 10. Affection 悬浮窗
11. registerSettingsApi → EmojiLibrary

## 模块连接
- **下游**: 全部模块（唯一装配点，dispose 反序拆卸）
- **日志**: channel-qq.log（启动序列全在这，运维验收看 QQ link ready）
