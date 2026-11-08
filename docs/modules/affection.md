# affection.ts — 好感度 + 悬浮窗

**文件**: `src/affection.ts`（305 行）

## 职责
好感冒泡值（随互动实时演化）+ 主人专属悬浮窗（affectionPort 8789，token 保护）。

## 关键机制
- 账本：`<dshHome>/affection.json`（delta 记账，stage 人生阶段）
- 悬浮窗：/api/task?key=&prompt= 可给 DM 注入任务（key 每次重启轮换，从 channel-qq.log 抓）
- 悬浮窗 HTML 由 qq_write_dashboard 工具由 Agent 自己写（writeCustomHtml）
- 注入通道注意：turn in flight 时 admin prompt 会静默丢，需轮询重试

## 模块连接
- **上游**: index.ts（HTTP server 装配）、tools.ts（set_affection/set_stage/write_dashboard）
- **数据**: affection.json、affection-dashboard.html
