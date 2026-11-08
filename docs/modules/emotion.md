<div align="center">

💗 **emotion** ｜ [← dm-gate](./dm-gate.md) ｜ [📚 总索引](./README.md) ｜ [affection →](./affection.md)

</div>

---

# emotion.ts — 情感引擎

**文件**: `src/emotion.ts`（282 行）

## 职责
多维情绪状态（心情/能量/最近事件）+ 六维情感（qq_report_emotion 自主上报），
影响回复语气。

## 关键机制
- `EmotionState`：随互动演化的情绪状态（持久化 emotion.json）
- 六维：模型用 qq_report_emotion 自主记账（10-21 owner 令：不做关键词自动触发），
  behaviorHint 注入上下文给语气暗示
- `setEmotionPersona`：称谓与 persona 配置联动

## 模块连接
- **上游**: bridge.ts（toneHint/behaviorHint 注入）、tools.ts（上报工具）
- **数据**: `<dshHome>/emotion.json`
