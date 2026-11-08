# chain.ts — 连锁动作层

**文件**: `src/chain.ts`（233 行）

## 职责
让 Agent 在**一条回复的文字里**内联动作标记，按出现顺序执行：发图/戳一戳/点赞/回应，
剩余文字照常分段发送。

## 标记与查库
| 标记 | 行为 |
|---|---|
| `[表情: 描述]` | 四级查库：meme pack 关键词 → 收藏库(emoji-library.search) → pack 阈值1兜底 → 语义向量兜底；全落空则按文字表情留在正文（绝不发空消息） |
| `[戳一戳]` / `[戳一戳: QQ号]` | friend_poke / group_poke |
| `[点赞]` / `[点赞: 次数]` | send_like 1-10 次（仅私聊） |
| `[回应: emoji_id]` | set_msg_emoji_like（QQ 默认表情 id，76=赞 66=爱心 63=玫瑰 124=OK） |

## 关键机制
- **balanceTagBrackets**（1109）：扫描前补齐漏写的后括号——开标记到下一个 `[` 或串尾
  之间无闭合时，在第一个换行处或段尾补 `]`；全角 `］` 归一半角（含无参形态 `[戳一戳］`）。
  正文里的非标记方括号（如 `[1+2]`）不受影响。10 用例全过
- `lastHitSticker`：最近一次命中图，全查库落空时的最后兜底
- 落空留字：miss 的标记按 `[描述]` 文字形态留在正文（10-31 owner 令）

## 模块连接
- **上游**: tools.ts 的 qq_send_text/qq_reply_quote（text 进来先过这里）
- **下游**: onebot.call()（send_group_msg/send_private_msg/poke/like/emoji_like）、
  emoji-library.ts、meme/（查库）、outbound.ts（剩余文字的分段发送）
- **数据**: meme pack sqlite（node:sqlite DatabaseSync，path/caption/keywords 列）
