# emoji-library.ts — 表情收藏库

**文件**: `src/emoji-library.ts`（265 行）

## 职责
Agent 自己的表情收藏库：MD5 去重入库、标签/描述索引、语义搜索。

## 关键机制
- 入库：魔数嗅探真实格式（伪装后缀拒收），MD5 指纹去重
- 索引：文件名/标签/描述三路匹配；分词检索（空白/标点切词、单字降权 0.4）
- 搜索：`search(desc, n)` → 按 tags+desc 匹配排序——chain.ts 与 qq_search_emojis 共用

## 模块连接
- **上游**: index.ts（装配）、emoji.ts（偷取入库）、tools.ts（search/send）、chain.ts（查库）
- **数据**: `<dshHome>/channel-qq/emoji-index.json` + 图片目录（config.emoji.dir）
