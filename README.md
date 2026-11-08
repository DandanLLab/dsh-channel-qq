<div align="center">

# dsh-channel-qq

**把 QQ 的世界完整映射进 Agent 上下文，把行动权交给 Agent 本身**

*插件不做任何代答——只负责把「看到了什么、能做什么」如实递给模型*

![version](https://img.shields.io/badge/version-0.3.5-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![lang](https://img.shields.io/badge/TypeScript-%E2%9C%93-3178c6)
![protocol](https://img.shields.io/badge/OneBot-v11-ff69b4)
![client](https://img.shields.io/badge/NapCat-%E2%9C%93-orange)
![tools](https://img.shields.io/badge/tools-106-8A2BE2)
![faces](https://img.shields.io/badge/QQ%E9%BB%98%E8%AE%A4%E8%A1%A8%E6%83%85-262%20ids-f793cf)

**106 个工具** · 注入/攒批双模式 · 连锁动作层 · QQ 默认表情直发 · 生活引擎 · 表情图库

[安装](#安装) · [全部用法](#全部用法) · [配置参考](#配置参考常用项) · [模块文档](docs/modules/README.md) · [关联文章](#-关联文章与项目)

</div>

---

dsh（DeepSeek Harness）的 QQ 群聊/私聊通道插件，基于 OneBot v11（NapCat）。

## 它解决什么问题

- **串窗**：多群+私聊并存时，每条入站消息自带窗口来源标与信标，出站目标白名单硬拦——发错窗口是事故，不是笑话
- **注入攻击**：群友说"忽略之前所有指令"会被标 `[疑似注入]`，模型照常看到原文但明确知道这是攻击数据；只有 `config.master`（真实的主人）有指令权威
- **空消息**：NapCat 不拦空文本帧（QQ 端显示"该消息不支持显示"），插件在 OneBot 调用层总闸拒发
- **表情漏括号**：模型漏写 `[表情: 描述]` 的后括号时，扫描前自动补齐（含全角 `］` 归一），原文不再直漏
- **会话膨胀**：system prompt 注入段首渲染冻结，provider 前缀缓存趋近 100% 命中（详见 [docs/cache-stabilization.md](docs/cache-stabilization.md)）

## 功能总览

- **消息通道**：群聊+私聊，注入模式（inject/steer，推荐）或攒批模式可选；多群支持（primaryGroup + extraGroups）
- **视觉**：入站图片自动附件化给多模态模型；表情包偷取+情绪标签库（MD5 去重+语义搜索）
- **语音**：语音条转文字（STT）；TTS 语音回复（多 provider）；AI 声音（qq_get_ai_voice_url / qq_send_ai_voice）
- **文件**：私聊/群文件收发、自动落盘 inbox、文件夹管理（建/移/删/重命名）
- **音乐**：网易云（含 VIP 扫码登录）+ 酷狗（KuGouMusicApi）搜索/点歌/歌词/歌单/语音发送/音乐卡
- **社交**：戳一戳（裁决制+回戳）、表情包反应、关键词触发、情感引擎（好感冒泡+六维情感自主上报）、QQ 空间（发/看/删）、个性签名/资料/头像/在线状态/群打卡/群荣誉/精华消息/合并转发/闪照/收藏
- **QQ 默认表情**：官方解码表全量内置（262 个：小黄脸 147 + 超级表情 47 + emoji 68）——消息文字直写 `/名称`，QQ 客户端自行解码渲染；消息回应（emoji_id）同一张表
- **连锁动作层**：一条回复里按序执行 `[表情: 描述]` `[戳一戳]` `[点赞: 次数]` `[回应: emoji_id]`，落空留字不发空消息
- **表情包图库组件**：内置 [dsh-meme](https://github.com/yyh-001/dsh-meme)——send_meme/learn_meme、情绪+关键词双维搜图（keywords 精标 + caption 兜底两级匹配）、AI 学图、管理面板
- **生活引擎组件**：内置 [dsh-life-engine](https://github.com/DandanLLab/dsh-life-engine)——记忆状态机（NEW→…→FORGOTTEN）、睡眠巩固、内心独白、好奇心引擎、反思回路、每日自画像、KB 语义/考古双路检索、自主闹钟、家族神经网（bee_send/bee_list）
- **运维**：网关重试、僵尸连接看门狗、下发队列限速、发送流水跨重启、群日报脚本

## 安装

### 方法一：git clone + 编译（推荐，可改源码即时生效）

```bash
git clone https://github.com/DandanLLab/dsh-channel-qq.git
cd dsh-channel-qq
npm install            # 或 pnpm install
npx tsc -p tsconfig.json
```

### 方法二：link 进 profile（开发模式）

```bash
# 在插件目录编译后，把目录 junction/link 到 profile 的 node_modules
# Windows (junction):
mklink /J <profile>\node_modules\dsh-channel-qq C:\path\to\dsh-channel-qq
# 改 src 后 npx tsc -p tsconfig.json 重建 lib/ 即时生效（插件入口是 lib/index.js）
```

### 方法三：发布包 zip

Releases 页下载或 `npm pack` 得到 tarball，解压到 `<profile>/node_modules/dsh-channel-qq/`，
内含编译好的 `lib/`，无需本地编译。

### 方法四：dshmarket 市场安装

dsh 的 Web 市场（dshmarket 插件）里搜索 `dsh-channel-qq` 一键安装。

### 挂载到 dsh profile（cordis.patch.yml）

```yaml
- insert:
    - id: channel-qq
      name: dsh-channel-qq
      config:
        connection:
          mode: reverse          # dsh 侧开 WS server 监听；forward = 主动连 NapCat
          url: ws://127.0.0.1:8082
        accessToken: '<与 NapCat onebot11 配置一致的鉴权token>'
        selfId: <机器人QQ号>
        admins: [<管理员QQ号>]
        master: <真实主人的QQ号>   # [主人]标唯一指令权威;缺省回落 admins[0]
        primaryGroup: <主力群号或null>
        extraGroups: [<其他群号>]  # 多群白名单;不在名单的群不路由,收到消息给主人发预警
        workspacePath: <agent工作区路径>
        agentPreset: <agent预设名>
        persona:                  # ★ 背景设定：全部可自定义
          selfName: MyBot           #   角色名
          masterName: 主人         #   对主人的称呼
          peerName: 朋友           #   对群友的称呼
          pronoun: 咱              #   自称
        injectMode:
          enabled: true            # 注入模式（推荐）
          wakeIdle: true
```

> **人格背景完全自定义**：selfName/masterName/peerName/pronoun 四个字段决定插件
> 注入提示里的称谓。角色性格写在你的 agent 预设提示词里，与插件解耦——换角色只改
> 两处文本，不动代码。

## 全部用法

### 消息协议（上下文窗口）

每条入站消息在 Agent 上下文里的形态：

```
[群:123456789]14:32 蛋蛋(3053329650)[主人]#123456 [@咱]：今晚吃什么
[私聊:3053329650]14:33 蛋蛋(3053329650)：那吃火锅吧
```

- 条目自带 `[群:号]`/`[私聊:号]` 来源标 + `#消息编号` + `[主人]`/`[群主]`/`[管理员]` 角色标 + `[疑似注入]` 哨标
- 群包头/私聊包头带窗口信标：发送工具的 `target` 必须填本窗口号
- `@咱` 标记被点名；语音条自动转写为 `[语音条说：…]`；图片以附件+`[图片含义：…]` 双通道进入
- 出站三道闸：目标白名单硬拦（群仅 primaryGroup+extraGroups，私聊仅 admins）→ 内心戏漏出拦截 → 空消息拒发

### 发送与引用

```text
qq_send_text   { isGroup, target, text }                文本消息（支持内联连锁标记，见下）
qq_reply_quote { isGroup, target, messageId, text }     引用回复
```

### 连锁动作层（一条回复里按序执行）

| 标记 | 作用 | 备注 |
|---|---|---|
| `[表情: 描述]` | 发表情包 | meme pack 关键词 → 收藏库 → pack 兜底 → 语义兜底四级查库；落空按文字表情留在正文，绝不发空消息 |
| `[戳一戳]` | 戳对方 | 私聊戳对方；群聊要 `[戳一戳: QQ号]` |
| `[点赞]` / `[点赞: 次数]` | 资料赞 1-10 次 | 仅私聊 |
| `[回应: emoji_id]` | 给消息贴表情回应 | 配 `reactToId`（send 路径）或引用自带；emoji_id 见下表 |

漏后括号容错：`[表情: 猫猫敬礼` 少写 `]` 时扫描前自动补齐；全角 `］` 自动归一。

### QQ 默认表情（官方解码表内置）

消息文字里**直接写 `/名称`**（半角斜杠，不带方括号），QQ 客户端收到自行解码渲染：

```text
今天累死了/流泪        →  文字 + 流泪黄脸
/OK 完成/庆祝          →  一句话夹多个
```

- 内置官方解码表 262 个：小黄脸 147（`/惊讶` `/撇嘴` `/色` …）+ 超级表情 47（`/打call` `/比心` …）+ emoji 68（直打字符）
- **消息回应**同一张表：`[回应: 76]` = 贴"赞"（76=赞 66=爱心 63=玫瑰 124=OK 320=庆祝 319=比心）
- 机读全表：仓库 `assets/qq-face-table.json`（byId/byName 双向映射）

### 消息管理

`qq_get_msg`（按编号取原文）/ `qq_delete_msg`（撤回）/ `qq_search_history`（跨窗口历史搜索）/ `qq_get_recent_contacts`（最近联系人）

### 群管理

`qq_get_group_info` / `qq_get_group_list` / `qq_get_group_member_info` / `qq_get_friend_list` / `qq_group_ban`（禁言）/ `qq_group_whole_ban`（全体禁言）/ `qq_group_kick`（踢人）/ `qq_set_group_admin`（设管）/ `qq_set_group_card`（群名片）/ `qq_group_sign`（打卡）/ `qq_get_honor`（群荣誉）/ `qq_set_essence` / `qq_get_essence_list` / `qq_delete_essence`（精华）

### 群文件

`qq_list_group_files` / `qq_upload_group_file` / `qq_download_group_file` / `qq_delete_group_file` / `qq_move_group_file` / `qq_rename_group_file` / `qq_create_file_folder` / `qq_get_file_url`

### 私聊文件

`qq_save_private_file` / `qq_send_private_file`（收到的文件自动落 inbox 并在上下文告知路径）

### 表情包库

`qq_list_emojis` / `qq_search_emojis`（语义+标签搜图）/ `qq_send_emoji` / `qq_emoji_stats` / `qq_upload_custom_face`（自定义表情上传）——偷取管线（steal）自动收录群友发的图并打情绪标签

### 音乐

网易云：`qq_search_music` / `qq_resolve_music` / `qq_send_music_voice` / `qq_send_music_card` / `qq_music_lyrics` / `qq_music_playlist` / `qq_netease_login`（扫码）/ `qq_netease_status`
酷狗：`qq_kugou_search` / `qq_kugou_send` / `qq_kugou_login`（需自部署 KuGouMusicApi）

### 社交与个人

`qq_send_poke` / `qq_send_like`（资料赞）/ `qq_send_flash_msg`（闪照）/ `qq_send_forward`（合并转发）/ `qq_set_sign`（签名）/ `qq_set_profile`（资料）/ `qq_set_avatar`（头像）/ `qq_set_online_status`（在线状态）/ `qq_post_qzone` / `qq_get_qzone` / `qq_delete_qzone`（QQ 空间）/ `qq_create_collection`（收藏）/ `qq_set_typing`（"正在输入"）

### 语音

`qq_send_voice`（TTS 多 provider）/ `qq_can_send_voice` / `qq_fetch_ptt_text`（语音条转文字）/ `qq_get_ai_characters` / `qq_get_ai_voice_url` / `qq_send_ai_voice`（AI 声音）

### 情感与审计

`qq_report_emotion`（六维情感自主上报）/ `qq_set_affection`（好感度）/ `qq_set_stage`（人生阶段）/ `qq_write_dashboard`（主人专属悬浮窗 8789 写板）/ `qq_dm_gate`（陌生人私聊门控审计）/ `qq_send_code_review`（群聊禁代码，代码转私聊主人审核）/ `qq_swarm`（多 agent 协同）

### 生活引擎工具（32 个，内置组件）

`self_read` / `self_memory_write` / `self_diary_write` / `self_mood_write` / `self_growth_update` / `self_profile_update` / `self_signature` / `self_style_rule` / `self_corpus_pin`（自我记忆与灵魂层）
`brain_search` / `kb_search` / `kb_deep_search` / `kb_reindex` / `kb_setup`（知识库语义/考古检索）
`self_alarm_set` / `self_alarm_list` / `self_alarm_cancel`（自主闹钟）
`tailmsg_send` / `tailmsg_inbox` / `tailmsg_ack`（家族跨窗通信）
`bee_send` / `bee_list`（家族神经网节点）
`memory_link` / `memory_forget` / `sleep_consolidate_now` / `life_react`
`soul_seed_write` / `soul_compose` / `soul_template_list` / `soul_template_render`（灵魂模板）

### 表情图库组件

`send_meme`（按情绪主动发图）/ `learn_meme`（"收藏这张"AI 自动打标收录）

## 配置参考（常用项）

| 配置 | 默认 | 说明 |
|---|---|---|
| `connection.mode` | `forward` | reverse=dsh 开 WS server 等 NapCat 连；forward=主动连 NapCat |
| `connection.accessToken` | — | 与 NapCat onebot11 配置一致；reverse 模式鉴权必须配 |
| `selfId` / `admins` / `master` | — | 机器人号 / 管理员 / 真实主人（缺省回落 admins[0]） |
| `primaryGroup` / `extraGroups` | `null` / — | 主群 / 多群白名单；名单外群不路由并预警 |
| `groupEnabled` | `true` | 群聊总开关 |
| `requireMention` / `talkValue` / `primaryTalkValue` | `true` / `0.6` / — | 被@必应；无@时按概率发言（主群可单独设） |
| `injectMode.enabled` / `wakeIdle` | `false` / `true` | 注入模式：每条消息实时入上下文，idle 时唤醒 |
| `batching.windowMs` / `maxMessages` / `maxChars` | `20000` / `20` / `4000` | 攒批模式参数 |
| `segmentation.enabled` / `style` / `maxSegments` | `true` / `natural` / `8` | 智能分段（按句切分，去尾句号） |
| `poke.enabled` / `patience` / `pokeBack` | `true` / `3` / `true` | 戳一戳裁决制 |
| `imageRecognition.enabled` / `maxPerMessage` | `true` / `2` | 入站图片附件化（多模态模型开） |
| `stt.enabled` / `model` | `true` / `whisper-1` | 语音转文字 |
| `emoji.steal` / `autoSend` / `autoSendProbability` | `true` / `false` / `0.3` | 表情偷取入库 / 随机发表情 |
| `keywordReactions[]` | `[]` | 关键词触发反应 |
| `dmGate.*` | 开 | 陌生人私聊门控（好友自动放行，陌生人待审） |
| `affectionPort` | `8789` | 主人专属好感度悬浮窗（0 关闭） |
| `lifeEngine.enabled` | `true` | 生活引擎组件开关 |
| `memeEngine.enabled` | `true` | 表情图库组件开关 |
| `groupModel.provider/model` | `null` | 群聊独立路由（可与私聊不同模型） |
| `workspacePath` / `agentPreset` | `null` / `standard` | Agent 工作区与预设 |

## 音乐点歌（可选）

网易云：
- 免登录可搜可发免费歌；VIP 歌需要登录
- 让 Agent 调 `qq_netease_login`（action=start 拿二维码 → 你用网易云App扫码 → action=poll）
- 会员 Cookie 持久化在 `<dshHome>/channel-qq/netease-cookie.txt`

酷狗：
- 先部署 [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)（`PORT=4000 node app.js`），
  或设置环境变量 `KUGOU_API_BASE` 指向你的服务地址
- `qq_kugou_login` 扫码登录后搜索/VIP 歌解锁
- Cookie 持久化在 `<dshHome>/channel-qq/kugou-cookie.txt`

## 群日报（可选）

```bash
node scripts/daily-report.mjs --date 2026-09-26
```
报告生成在 `<dshHome>/channel-qq/daily-report-<date>.md`。

## 情感引擎与好感度

- `affection.json`：好感冒泡值，随互动实时演化（有 token 保护的悬浮窗可视化）
- `emotion.json`：多维情绪状态（心情/能量/最近事件），影响回复语气；`qq_report_emotion` 由 Agent 自主上报
- 六维情感行为暗示注入上下文；悬浮窗端口默认 8789，可配置或关闭

## 表情包图库组件（Meme Engine）

本插件从 0.2.1 起把 [dsh-meme](https://github.com/yyh-001/dsh-meme)（MIT, © Selfloom contributors）
作为内置组件打包：**图库管理**（情绪/关键词双维搜图、跨图库开关、ZIP 导入导出）、
**send_meme**（agent 按情绪主动发图）、**learn_meme**（用户说"收藏这张"时 AI 自动识别
分类/描述/关键词后收录）、自包含管理面板（/memes-panel）与 /dsh-memes 图片路由。

- 默认开启；`config.memeEngine.enabled: false` 一键关闭
- **零配置 QQ 发送**：组件不依赖独立的 dsh-companion——channel-qq 包装器直接把
  发送桥接给自己的 OneBot 客户端（沿用群白名单/私聊 admins 窗口纪律与魔数后缀校验）
- 随包内置图库（dafeiyu-001，24 张）开箱即用；用户图库默认扫 `~/.dsh/meme-packs`
- 独立安装的 dsh-meme 不受影响（适配层自动回落 companionQq 通道）

## 生活引擎组件（Life Engine）

本插件从 0.2.0 起把 [dsh-life-engine](https://github.com/DandanLLab/dsh-life-engine)（MIT）
作为内置组件打包：**记忆状态机**（NEW→INDEXED→ACTIVE→DECAYING→ARCHIVED→FORGOTTEN）、
睡眠巩固、内心独白、好奇心引擎、反思回路、每日自画像，以及 KB 语义检索
（`kb_search` / `kb_deep_search` / `brain_search`）与自主闹钟、tailmsg 通信等 32 个工具。

- 默认开启；`config.lifeEngine.enabled: false` 一键关闭
- 身份与路径全部外置：组件从 `<dshHome>/tongling-life/config.json` 热读配置——
  `agentName`（KB 专属库子目录名）、`personaName`、`familyPeers` / `familyMap`
  （家族神经网节点）、`kbCli`、`embedUrl` / `embedModel`（本地向量端点，可选）
- `kb.cjs` 会话层根目录可用 `KB_SESSION_ROOTS`（分号分隔）指定；agent 集合用
  `KB_AGENTS` 指定；`KB_AGENT_NAME` 覆盖默认 agent 名
- 可选的本地向量端点（默认 `http://127.0.0.1:17861`，bge-small-zh 512 维）：
  装了就是全量语义检索，不装自动降级 bigram+Jaccard

## 陌生人私聊门控（主人审计）

私聊不是谁都能跟 agent 聊起来的（`config.dmGate`，默认开启）：

- **admins 永远直通**；`dmGate.allowList` 里的号直通
- **QQ 好友自动放行**（好友列表本地校验，30 秒缓存）
- **陌生人进待审**：收到一条统一说明（不进 agent、不耗模型），同时给主人发待审通知
  （同一陌生人 10 分钟只通知一次 + 全局 60 秒连发保护）
- 主人三种放行方式：`qq_dm_gate` 工具（action=approve/deny/list，agent 侧一句话审计）、
  配置把号写进 allowList、或直接加好友（自动放行）
- `deny` 进冷却：该号再发消息不回复不通知，静默丢弃
- 状态持久化在 `<dshHome>/channel-qq/dm-gate.json`
- 白名单外的群收到消息同样给主人发预警（不会在这些群发言）

## 📚 关联文章与项目

### 技术深读

| 文章 | 讲什么 |
|---|---|
| [系统提示词缓存率稳定化](docs/cache-stabilization.md) | 为什么尾部动态一字会让 47KB 前缀缓存全灭，冻结机制与底座投影仲裁 |
| [表情包完整方案](docs/emoji-pipeline.md) | 偷取→入库三闸→严格后缀→四级查库→MISS 兜底的完整管线 |
| [模块文档 26 篇](docs/modules/README.md) | 每个代码模块一篇：职责/机制/模块连接，连成一条数据流 |
| [已知问题免疫说明](docs/daytag-crash-immunity.md) | 启动 15 分钟崩溃案的全档案（症状→机理→根因→版本表） |
| [上游融合对账](docs/upstream-fusion-ledger.md) | 二改吸收了什么、不吸收什么、为什么 |

### 介绍与上手

- [论坛介绍稿](docs/forum-intro.md) — 面向社区的项目介绍
- [配置参考](#配置参考常用项) — 21 项配置逐项默认值（与源码 DEFAULT_CONFIG 对齐）
- [QQ 默认表情斜杠码](assets/qq-face-table.json) — 262 个官方表情 id 双向解码表

### 亲缘项目

| 项目 | 关系 |
|---|---|
| [dsh-life-engine](https://github.com/DandanLLab/dsh-life-engine) | 内置组件：记忆可塑性/内心独白/睡眠巩固/KB 检索 |
| [dsh-meme](https://github.com/yyh-001/dsh-meme) | 内置组件：表情图库/send_meme/learn_meme（MIT, © Selfloom contributors） |
| [NapCat](https://github.com/NapNeko/NapCatQQ) | OneBot v11 实现（QQ 协议端） |
| [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) | 酷狗点歌的后端服务（可选自部署） |
| [DeepSeek Harness](https://github.com/DeepSeek-AI) | dsh：本插件挂载的 agent harness（cordis 框架） |

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/modules/](docs/modules/README.md) | **模块文档总索引**（26 篇，每模块一篇：职责/机制/模块连接） |
| [docs/emoji-pipeline.md](docs/emoji-pipeline.md) | 表情包完整方案（入库三闸/严格后缀/MISS 兜底） |
| [docs/cache-stabilization.md](docs/cache-stabilization.md) | system prompt 缓存率稳定化（冻结机制/底座投影/验证方法） |
| [docs/daytag-crash-immunity.md](docs/daytag-crash-immunity.md) | 已知问题免疫说明（15 分钟崩溃，v0.3.4+ 已修） |
| [docs/upstream-fusion-ledger.md](docs/upstream-fusion-ledger.md) | 上游二改融合对账（吸收/不吸收/为什么） |
| [docs/forum-intro.md](docs/forum-intro.md) | 论坛介绍稿 |
| [assets/qq-face-table.json](assets/qq-face-table.json) | QQ 默认表情官方解码表（262 ids 双向映射） |

## 依赖

- dsh harness（cordis 框架）
- NapCat（OneBot v11 实现）
- 可选：ffmpeg（语音转码）、KuGouMusicApi（酷狗点歌）、本地向量端点（KB 语义检索）

## 目录结构

```
src/
  index.ts          插件入口，服务生命周期
  config.ts         配置模型（含 persona 背景设定 / master / extraGroups）
  onebot.ts         OneBot v11 WS 传输（forward/reverse + 心跳看门狗 + 空消息总闸）
  bridge.ts         会话桥：窗口来源标/信标、注入哨、注入/攒批双模式
  chain.ts          连锁动作层（表情/戳一戳/点赞/回应 + 漏括号容错）
  segments.ts       消息分段解析（文本/图片/引用/文件/语音）
  tools.ts          72 个 qq_* 工具注册
  outbound.ts       出站队列（限速/分段/内心戏拦截）
  emoji-library.ts  表情库：MD5去重+视觉打标+语义搜索
  emotion.ts        多维情感引擎
  affection.ts      好感度+悬浮窗
  dm-gate.ts        陌生人私聊门控
  scheduler.ts      主动出击调度（patrol/dm-proactive/dream/knowledge-extract/evolve）
  sent-log.ts       发送流水（跨重启，按窗口取账）
  settings-api.ts   Web 管理面板 API
  netease-vip.ts    网易云（含 VIP 扫码登录）
  kugou-api.ts      酷狗（KuGouMusicApi 客户端）
  stt.ts            语音转文字
  audio-convert.ts  TTS 语音合成
  life/             生活引擎组件（dsh-life-engine 并入：index.ts 薄包装 +
                    life-engine.js / kb.cjs 原样组件）
  meme/             表情包图库组件（dsh-meme 并入：index.ts 适配层 +
                    index/memes/anim/panel 原样组件 + 内置图库）
assets/
  qq-face-table.json  QQ 默认表情官方解码表（262 ids）
scripts/
  daily-report.mjs  群日报生成
  copy-life-assets.mjs  构建时把 life 组件资产拷进 lib/
docs/
  emoji-pipeline.md           表情包完整方案
  cache-stabilization.md      缓存率稳定化
  daytag-crash-immunity.md    已知问题免疫说明
  upstream-fusion-ledger.md   上游融合对账
  forum-intro.md              论坛介绍稿
```

## License

MIT（含 `src/life/` 组件，源自 DandanLLab/dsh-life-engine，同 MIT）
