<div align="center">

# 📚 模块文档

**每个代码模块一篇：职责 · 关键机制 · 模块连接**

`src/` 共 24 个模块文件 + 2 个组件目录，26 篇文档按数据流分组。

```
 NapCat(QQ)
   │ OneBot v11 WS
   ▼
 onebot ──事件──▶ segments ──解析──▶ bridge ◀── scheduler
 (传输/看门狗)     (消息分段解析)    (会话桥/窗口协议)  (主动出击)
                       │                │ │ │
                       │图片附件         │ │ └─▶ outbound ──▶ onebot.call()
                       ▼                │ │     (出站队列/分段/拦截)     │
                 bridge(多模态)          │ └──▶ chain(连锁动作) ─────────┘
                                        ▼           ▲
                                   dsh harness      │ 查库
                                        │           │
                                       tools(72 工具)│
                     ┌────────┬─────────┘  │  └────────┬──────────┐
                     ▼        ▼          ▼           ▼          ▼
               netease-vip kugou-api dm-gate  emotion  affection
               stt/audio-convert    knowledge  sent-log  settings-api
```

[⬅ 返回主 README](../..#-关联文章与项目)

</div>

---

### 🔌 入站链路

| 模块 | 文件 | 一句话 |
|---|---|---|
| 🧱 [types](./types.md) | `src/types.ts` (65 行) | 定义 OneBot v11 事件的 TypeScript 形状，是全插件与 Na |
| 🔍 [segments](./segments.md) | `src/segments.ts` (124 行) | 把 OneBot 事件原始数组段（text/face/image/at/reco |
| 📡 [onebot](./onebot.md) | `src/onebot.ts` (256 行) | 与 NapCat 的全部 WS 通信：reverse（dsh 开 server  |
| 🧭 [client-compat](./client-compat.md) | `src/client-compat.ts` (126 行) | 连接握手时识别对端 OneBot 实现（NapCat/go-cqhttp/Lag |
| ⚙️ [config](./config.md) | `src/config.ts` (234 行) | 全部配置项的 interface + `DEFAULT_CONFIG` + `r |
| 🌉 [bridge](./bridge.md) | `src/bridge.ts` (1118 行) | 入站事件 → Agent 上下文窗口包 → 提交 dsh harness 跑回合 |
| 🚪 [index](./index.md) | `src/index.ts` (271 行) | cordis Service 装配点：resolveConfig → 按序实例化 |
| 🔗 [services](./services.md) | `src/services.ts` (141 行) | 与 dsh harness 类型系统的适配：SessionId 品牌类型、消息块 |

### ⚡ 出站与行动

| 模块 | 文件 | 一句话 |
|---|---|---|
| ⛓️ [chain](./chain.md) | `src/chain.ts` (233 行) | 让 Agent 在**一条回复的文字里**内联动作标记，按出现顺序执行：发图/戳 |
| 📮 [outbound](./outbound.md) | `src/outbound.ts` (329 行) | Agent 全部出站消息的必经之路：限速、智能分段、超长硬切、内心戏拦截、发送执 |
| 🛠️ [tools](./tools.md) | `src/tools.ts` (2022 行) | Agent 的全部行动权：把 OneBot action / 本地能力包装成带描 |

### 💾 数据与状态

| 模块 | 文件 | 一句话 |
|---|---|---|
| 🖼️ [emoji-library](./emoji-library.md) | `src/emoji-library.ts` (265 行) | Agent 自己的表情收藏库：MD5 去重入库、标签/描述索引、语义搜索 |
| 🥷 [emoji](./emoji.md) | `src/emoji.ts` (139 行) | 群里别人发的表情/图片自动收录进收藏库（偷取），让 Agent 的图库随聊天自然 |
| 📖 [knowledge](./knowledge.md) | `src/knowledge.ts` (319 行) | 轻量会话内知识库（区别于 life 组件的 KB 向量库）：条目化记忆（类型/内 |
| 🚧 [dm-gate](./dm-gate.md) | `src/dm-gate.ts` (152 行) | 私聊不是谁都能跟 Agent 聊：admins/allowList/QQ 好友直 |
| 💗 [emotion](./emotion.md) | `src/emotion.ts` (282 行) | 多维情绪状态（心情/能量/最近事件）+ 六维情感（qq_report_emoti |
| 💞 [affection](./affection.md) | `src/affection.ts` (305 行) | 好感冒泡值（随互动实时演化）+ 主人专属悬浮窗（affectionPort 87 |
| ⏰ [scheduler](./scheduler.md) | `src/scheduler.ts` (225 行) | Agent 的自主节律：patrol 巡逻 / dm-proactive 私聊主 |
| 📜 [sent-log](./sent-log.md) | `src/sent-log.ts` (62 行) | Agent 每条出站的持久化流水，跨重启可查——防"这不是我发的"翻账 |

### 🧩 外设

| 模块 | 文件 | 一句话 |
|---|---|---|
| 🛰️ [settings-api](./settings-api.md) | `src/settings-api.ts` (193 行) | dsh Web 侧的管理 API（/channel-qq-api，loopbac |
| 🎙️ [stt](./stt.md) | `src/stt.ts` (123 行) | 语音条（ptt）→ 文字：QQ 语音是 silk 编码，先转 wav 再打 ST |
| 🔊 [audio-convert](./audio-convert.md) | `src/audio-convert.ts` (511 行) | 双向音频管线：入站 silk→wav（STT 前置）；出站文字→语音（TTS 多 |
| 🎵 [netease-vip](./netease-vip.md) | `src/netease-vip.ts` (173 行) | 网易云搜索/歌曲详情/直链/VIP 扫码登录，Cookie 持久化 |
| 🎶 [kugou-api](./kugou-api.md) | `src/kugou-api.ts` (134 行) | 酷狗搜索/直链/扫码登录——走自部署的 KuGouMusicApi 服务 |

### 📦 内置组件

| 模块 | 文件 | 一句话 |
|---|---|---|
| 🌱 [life](./life.md) | `src/life/index.ts` (58 行) | Agent 的"生活"：记忆可塑性、内心独白、好奇心、反思、自画像、灵魂模板、 |
| 😹 [meme](./meme.md) | `src/meme/index.ts` (112 行) | 图库管理（情绪/关键词双维搜图、ZIP 导入导出）、send_meme（按情绪发 |

---

**导航**：每篇顶部有 上一篇 / 总索引 / 下一篇；主 README 的[关联文章区](../../README.md)收录技术深读。