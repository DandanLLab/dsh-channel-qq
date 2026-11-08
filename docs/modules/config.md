# config.ts — 配置模型与默认值

**文件**: `src/config.ts`（231 行）

## 职责
全部配置项的 interface + `DEFAULT_CONFIG` + `resolveConfig`（profile patch 合并）。

## 关键内容
- 连接：`ConnectionConfig`（mode/url/accessToken）
- 身份：selfId/admins/**master**（真实主人，缺省回落 admins[0]）/extraGroups（多群白名单）
- 群协议：groupEnabled/requireMention(true)/talkValue(0.6)/primaryTalkValue
- 双模式：injectMode(enabled:false 默认, wakeIdle)/batching(windowMs:20000, maxMessages:20)
- 出站：segmentation(natural/maxSegments:8)/rateLimitMs(800)/maxMessageLength(4000)
- 感官：imageRecognition(enabled:true, maxPerMessage:2)/stt(whisper-1)/poke(patience:3)
- 表情：emoji.steal(true)/autoSend(false)/autoSendProbability(0.3)
- 组件：lifeEngine/memeEngine 开关、affectionPort(8789)、dmGate、keywordReactions
- 路由：groupModel（群聊独立 provider/model）

## 模块连接
- **被依赖**: 几乎所有模块（类型来源）；index.ts resolveConfig 是唯一装配点
- **权威源**: README 配置参考表与本文件 DEFAULT_CONFIG 逐项对齐（1109 校对）
