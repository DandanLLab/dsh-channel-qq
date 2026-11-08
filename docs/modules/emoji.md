<div align="center">

🥷 **emoji** ｜ [← emoji-library](./emoji-library.md) ｜ [📚 总索引](./README.md) ｜ [knowledge →](./knowledge.md)

</div>

---

# emoji.ts — 表情偷取管线

**文件**: `src/emoji.ts`（139 行）

## 职责
群里别人发的表情/图片自动收录进收藏库（偷取），让 Agent 的图库随聊天自然生长。

## 关键机制
- steal 触发：群消息带图且 config.emoji.steal 开
- 入库三闸（详见 docs/emoji-pipeline.md）：EXIF jpg 拒收 / 长宽比≥1.9 拒收 / webp 拒收
- MD5 已知不重复入库；下载走 CDP 截流（多媒体域名直连被掐的备援）
- `duplicate sticker (md5 known), not indexed again` 日志 = 去重命中

## 模块连接
- **上游**: bridge.ts（事件流）、segments.ts（imageUrls）
- **下游**: emoji-library.ts（入库）、tools.ts（stats）
