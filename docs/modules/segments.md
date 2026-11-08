<div align="center">

🔍 **segments** ｜ [← types](./types.md) ｜ [📚 总索引](./README.md) ｜ [onebot →](./onebot.md)

</div>

---

# segments.ts — 入站消息解析

**文件**: `src/segments.ts`（124 行）

## 职责
把 OneBot 事件原始数组段（text/face/image/at/record/file/reply）解析成结构化的
`ParsedInbound`，供 bridge 组装上下文。

## 关键机制
- `parseInbound(event)` → `{ text, atIds, isAtBot, imageUrls, imageSummaries, ... }`
- at 段收集：`@了谁`（含是否@机器人）→ 决定 calledLine（被点名必应）
- reply 段提取：被引用消息编号（quote 路径的回应目标）
- 图片段：URL 收集（多模态附件化的原料）

## 模块连接
- **上游**: onebot.ts 转发的 OneBotEvent
- **下游**: bridge.ts 消费解析结果组装窗口包；emoji 偷取管线读 imageUrls
- **依赖**: 仅 types.ts 类型
