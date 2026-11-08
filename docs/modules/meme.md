<div align="center">

😹 **meme** ｜ [← life](./life.md) ｜ [📚 总索引](./README.md)

</div>

---

# meme/ — 表情图库组件（dsh-meme 并入）

**目录**: `src/meme/`（index.ts 适配层 + meme-engine.js/memes.js/anim/panel 原样组件 + 内置图库）

## 职责
图库管理（情绪/关键词双维搜图、ZIP 导入导出）、send_meme（按情绪发图）、
learn_meme（AI 打标收录）、管理面板（/memes-panel）与 /dsh-memes 图片路由。

## 关键机制
- 零配置发送：适配层把发送桥接给插件自己的 OneBot 客户端（沿用窗口纪律+魔数后缀校验），
  不再依赖 dsh-companion
- 两级匹配：keywords 精标（阈值≥4）→ caption 全文兜底（阈值≥3/1107 降到 2 援救近失）
- 图库：内置 dafeiyu-001（24 张）开箱即用；用户库扫 `~/.dsh/meme-packs`；
  sqlite（path/caption/keywords）
- 发送后缀魔数校验：伪装后缀复制真实后缀临时文件发送（gif 才有动画）

## 模块连接
- **上游**: index.ts applyMemeEngine（装配）、tools.ts（chain 查库经 MEME_PACK_DIR）
- **下游**: onebot.ts（发送）、Web（/memes-panel 面板）
