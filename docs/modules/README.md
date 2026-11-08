# 模块文档总索引

> 每个代码模块一篇，重点写「模块连接」——数据与控制流如何连成一条链。
> 全部依据真实源码（行数为写作时快照）。

## 模块连接总图（主链路）

```
 NapCat(QQ)
   │ OneBot v11 WS
   ▼
 onebot.ts ──事件──▶ segments.ts ──解析──▶ bridge.ts ◀── scheduler.ts(定时)
 (传输/看门狗)        (消息分段解析)        (会话桥/窗口协议)     (主动出击)
                        │                     │ │ │
                        │图片附件              │ │ └─▶ outbound.ts ──▶ onebot.call()
                        ▼                     │ │      (出站队列/分段/内心戏拦截)   │
                  bridge(多模态)              │ └──▶ chain.ts(连锁动作) ────────────┘
                                             ▼            ▲
                                        dsh harness       │ 查库
                                     (agent 会话/turn)    │
                                          │            emoji-library.ts / meme/
                                          ▼
                                     tools.ts (72 个 qq_* 工具注册)
                                       │   │   │
             ┌──────────────┬──────────┘   │   └──────────┬─────────────┐
             ▼              ▼              ▼              ▼             ▼
       netease-vip.ts   kugou-api.ts   dm-gate.ts    emotion.ts    affection.ts
       stt.ts / audio-convert.ts       knowledge.ts  sent-log.ts   settings-api.ts
```

## 生命周期（index.ts 视角）

```
index.ts resolveConfig ▶ OneBotClient ▶ OutboundQueue ▶ ConversationBridge
  ▶ registerQQTools ▶ applyLifeEngine ▶ applyMemeEngine ▶ Scheduler
  ▶ DmGate ▶ Affection(悬浮窗) ▶ registerSettingsApi ▶ EmojiLibrary
```

## 篇目

| 篇 | 模块 | 一句话 |
|---|---|---|
| [types](modules/types.md) | types.ts | OneBot 协议类型契约 |
| [segments](modules/segments.md) | segments.ts | 入站消息解析 |
| [onebot](modules/onebot.md) | onebot.ts | WS 传输+看门狗+空消息总闸 |
| [client-compat](modules/client-compat.md) | client-compat.ts | 客户端识别与能力矩阵 |
| [config](modules/config.md) | config.ts | 配置模型与默认值 |
| [bridge](modules/bridge.md) | bridge.ts | 会话桥：窗口协议与双模式 |
| [index](modules/index.md) | index.ts | 入口与生命周期 |
| [services](modules/services.md) | services.ts | dsh 底座类型胶水 |
| [chain](modules/chain.md) | chain.ts | 连锁动作层 |
| [outbound](modules/outbound.md) | outbound.ts | 出站队列 |
| [tools](modules/tools.md) | tools.ts | 72 工具注册 |
| [emoji-library](modules/emoji-library.md) | emoji-library.ts | 表情收藏库 |
| [emoji](modules/emoji.md) | emoji.ts | 表情偷取管线 |
| [knowledge](modules/knowledge.md) | knowledge.ts | 会话内知识库 |
| [dm-gate](modules/dm-gate.md) | dm-gate.ts | 陌生人私聊门控 |
| [emotion](modules/emotion.md) | emotion.ts | 情感引擎 |
| [affection](modules/affection.md) | affection.ts | 好感度+悬浮窗 |
| [scheduler](modules/scheduler.md) | scheduler.ts | 主动出击调度 |
| [sent-log](modules/sent-log.md) | sent-log.ts | 发送流水 |
| [settings-api](modules/settings-api.md) | settings-api.ts | Web 管理面板 |
| [stt](modules/stt.md) | stt.ts | 语音转文字 |
| [audio-convert](modules/audio-convert.md) | audio-convert.ts | 音频转码/TTS |
| [netease-vip](modules/netease-vip.md) | netease-vip.ts | 网易云 |
| [kugou-api](modules/kugou-api.md) | kugou-api.ts | 酷狗 |
| [life](modules/life.md) | life/ | 生活引擎组件 |
| [meme](modules/meme.md) | meme/ | 表情图库组件 |
