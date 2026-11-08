<div align="center">

🛠️ **tools** ｜ [← outbound](./outbound.md) ｜ [📚 总索引](./README.md) ｜ [emoji-library →](./emoji-library.md)

</div>

---

# tools.ts — 72 个 qq_* 工具注册

**文件**: `src/tools.ts`（2022 行，插件最大的模块）

## 职责
Agent 的全部行动权：把 OneBot action / 本地能力包装成带描述的 dsh 工具。
**发送类工具内置窗口白名单硬拦**——群仅 primaryGroup+extraGroups、私聊仅 admins，
陌生目标抛错拒发（防串窗第二层）。

## 域分组（README「全部用法」与此一一对应）
发送引用/连锁标记入口（qq_send_text/qq_reply_quote → chain.ts）、消息管理（get_msg/
delete_msg/search_history/recent_contacts）、群管理（ban/kick/card/sign/honor/essence）、
群文件八件套、私聊文件、表情库五件套、音乐 11 件（netease 8 + kugou 3）、
社交个人 13 件（poke/like/flash/forward/sign/profile/avatar/status/qzone3/collection/typing）、
语音六件（TTS/STT/AI 声音）、情感审计七件（report_emotion/set_affection/set_stage/
write_dashboard/dm_gate/send_code_review/swarm）

## 关键机制
- 发送前窗口验证：群查 get_group_info、私聊查好友列表，验证不过拒发
- `sentLogFor(key)` 按窗口取发送流水（1107 修：不再串账）
- 能力矩阵前置检查（client-compat.capabilityOf）——不支持扩展 action 明确报错
- MEME_PACK_DIR：`QQ_MEME_PACK_DIR` 环境变量优先，默认 `~/.dsh/meme-packs/default`
- meme pack 两级匹配：keywords 精标(≥4 分) → caption 全文兜底(≥2 分)

## 模块连接
- **上游**: index.ts（装配）、bridge.ts（会话上下文注入）
- **下游**: onebot.ts（action）、chain.ts（连锁）、emoji-library.ts、netease-vip.ts、
  kugou-api.ts、dm-gate.ts、emotion.ts、affection.ts、knowledge.ts、sent-log.ts
