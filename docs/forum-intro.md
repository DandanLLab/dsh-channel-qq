# [开源] dsh-channel-qq v0.2.1 — 给 DeepSeek Harness 装上"住在 QQ 里的完整人生"

> GitHub: https://github.com/DandanLLab/dsh-channel-qq
> License: MIT（全部代码开源可查，含三个内置组件，均同 MIT） | TypeScript，编译即用
> 协议端：OneBot v11 标准——NapCat 实测演示，Lagrange/LLOneBot/go-cqhttp 系均可接（见 INSTALL.md 客户端兼容表）
> **一次安装全都有**：通道、图库、生活引擎随包集成，无需额外安装任何配套插件

## 这是什么

dsh（DeepSeek Harness）的 QQ 通道插件，但**不只是通道**。

市面上的接入插件解决的是"消息怎么进怎么出"，这个仓库解决的是接进来之后的事：一个 agent 住在一个 QQ 号里，要记事、要挑表情、要点歌、要分清哪个窗口该说什么话、要有自己的情绪和生活——这一整套都做进了一个包里：

- **v0.2.0 起**内置 [dsh-life-engine](https://github.com/DandanLLab/dsh-life-engine)（记忆状态机/内心独白/睡眠巩固/KB 检索）
- **v0.2.1 起**内置 [dsh-meme](https://github.com/yyh-001/dsh-meme)（图库管理/send_meme/learn_meme/管理面板）

装一个包，agent 在 QQ 里就有了完整的生活。所有组件都有独立开关（`config.lifeEngine.enabled` / `config.memeEngine.enabled`），不想要就关。

设计哲学一句话：**把 QQ 的世界映射进 Agent 上下文，把行动权交给 Agent 本身——插件不做任何代答。**

## 先说清楚：个人号接入 vs 官方机器人

很多人第一个问题是"QQ 不是有官方机器人 API 吗"。区别在这：

| | 官方 QQ Bot API（腾讯官方机器人） | 本插件（OneBot v11 个人号） |
|---|---|---|
| 身份 | 官方机器人账号，需资质注册审核 | 个人 QQ 号，就是你自己的号 |
| 加好友/私聊 | 受官方模板限制，主动私聊有强约束 | 和真人一样：好友列表里随便聊 |
| 群能力 | 官方事件子集（无戳一戳/精华/群文件/空间等大部分社交面） | **完整群能力**：戳一戳、精华、群文件、群管理、空间动态、正在输入 |
| 消息形态 | 官方规定的 markdown/按钮模板 | 原生 QQ 消息：文本、图片、语音条、json 卡片、转发 |
| 记忆/生活 | 机器人无状态为主 | 内置记忆状态机+生活引擎，长期陪伴 |
| 风控 | 官方接口，稳定 | **非官方协议，账号风控/掉线/要求验证是常态**（插件的看门狗和自动重连就是为此设计的） |

一句话选型：要官方身份和合规保障 → 用官方 [dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot)；要一个"住在群里"、有记忆有生活的个人号伴侣 → 用本插件。两者不冲突，可以并存。

## 能力全景

### 通道层

- **群聊 + 私聊**，注入模式（inject/steer，每条消息即时进上下文）或攒批模式（安静窗口攒包分析）可选
- **视觉**：入站图片自动附件化给多模态模型
- **语音**：语音条转文字走 **QQ 原生转写**（`fetch_ptt_text`，零配置零外部服务，收听即转好；不可用再回落自建 Whisper）+ TTS 语音回复 + **QQ 百变变声器**（`qq_get_ai_characters` 选音色 → `qq_send_ai_voice` 念文字发语音条，拿 URL 可发任意会话）
- **文件**：私聊/群文件收发、自动落盘
- **社交面**：戳一戳裁决制（耐心计数可戳回）、精华、群管理、群文件、**QQ 空间动态三件套**（发/读/删）
- **QQ 原生语音转文字工具** `qq_fetch_ptt_text`：事后补查任意历史语音的文字
- **QQ 客户端全能力**：个性签名（改自己签名）、昵称/资料/头像、在线状态+自定义状态（"状态改成摸鱼中"）、群打卡、合并转发卡片、收藏夹、群荣誉、最近联系人、自定义表情上传——这些走 NapCat 扩展 action，换客户端会明确报错不静默吞；另有 `qq_swarm` 共演算一键下发任意 OneBot action 当万能逃生门

### 防串窗三层锁（血泪换来的）

QQ 机器人最经典的事故是"私聊的话发进群"。这里三层封死：

1. **工具层硬校验**——群发送仅限配置的白名单群（primaryGroup + extraGroups），私聊仅限管理员好友列表，陌生目标直接抛错拒发
2. **上下文显式标注**——每轮组包内写死【本会话是QQ群/私聊】+ target
3. **发送前窗口验证**——发前查群信息/好友列表确认目标存在

配套的还有内心戏外泄拦截（"本轮不发/舞台指示"不当群消息发）、群聊代码禁令、签名词黑名单（防旧人格自称回潮）。

### 表情包完整管线（双引擎）

**入库侧（偷取管线）**：

```
入站图片 → 入库三闸 → MD5 去重 → 视觉打标（描述+情绪标签+类型分型）
```

- **三闸**：①字节魔数验真格式（webp/未知拒）②**EXIF 闸**——手机截图必带 EXIF，真表情包极少带，命中即拒 ③**形状闸**——长宽比 ≥1.9 的聊天记录/横幅拒收
- **发送严格后缀**：QQ native 按后缀选解码器，伪装错后缀 = gif 发成静态图。发送前再读魔数，不符就复制带真实后缀的临时文件再发，**原图字节零修改**

**图库侧（dsh-meme 组件）**：

- **send_meme**：agent 按情绪+关键词主动搜图发图，没命中给换词建议
- **learn_meme**：你说"收藏这张"，AI 自动识别分类/描述/关键词后收录
- **管理面板**：自包含 /memes-panel（ZIP 导入导出、跨图库管理），重启不丢
- 随包内置图库开箱即用；**零配置 QQ 发送**——组件直接桥接本插件的 OneBot 客户端，不再依赖独立配套插件
- **词法 MISS 不静默**：搜不到转语义兜底，三级全空明确记日志不发图——宁可空手不发驴唇不对马嘴的图

完整方案文档：[docs/emoji-pipeline.md](https://github.com/DandanLLab/dsh-channel-qq/blob/master/docs/emoji-pipeline.md)

### 音乐系统

- **网易云**：免登录可搜可发；VIP 歌扫码登录解锁（Cookie 持久化在本机）
- **正版音乐卡片**：官方 VIP 解析直链 → 签名站四级降级链
- **吞卡对账**：QQ 对私聊卡片有两道独立的门（提交关+下发关），签名合法的卡也会被服务端静默吞——发后自动查历史消息对账，卡没到**自动降级发语音条**
- **酷狗**：对接 KuGouMusicApi

### 情感引擎

- **好感冒泡**（affection.json）：随互动实时演化，token 保护的悬浮窗可视化
- **六维情感账本**：亲密/信任/心动/安全/默契/张力六个独立维度——**不用关键词触发器**（"亲/抱"匹配必误触发），增量由模型用 `qq_report_emotion` 自主上报——她知道刚才那轮对话属于什么情感事件，正则不知道

### 生活引擎组件（v0.2.0 并入）

[dsh-life-engine](https://github.com/DandanLLab/dsh-life-engine) 全量：**记忆状态机**（NEW→INDEXED→ACTIVE→DECAYING→ARCHIVED→FORGOTTEN）、睡眠巩固、内心独白、好奇心引擎、反思回路、每日自画像、防幻觉纪律、意图理解——加 `kb_search`（语义）/ `kb_deep_search`（会话考古带出处）/ `brain_search`（全脑路由）三档检索和 30+ 工具。身份外置（`agentName`/`familyMap` 全配置化），不绑任何人设。

## 安全与隐私（值得单独一节）

**这不是一个会偷偷往外发数据的插件。**具体说：

### 零遥测、零上报

- 插件**没有任何遥测、统计、崩溃上报**代码——全仓库可以搜，没有 analytics、没有 post-to-server 的埋点
- 全部对话数据、记忆、表情库、情感账本**只落你本机磁盘**（`<dshHome>/` 下），不进任何云端
- 唯一的外部请求是功能本身需要的：音乐签名站（点歌卡片）、QQ 图片 CDN（收发图）、你配置的 LLM 网关——每一处都在源码里可查

### 网络面全部锁在回环

- 好感度悬浮窗：仅绑 `127.0.0.1`，**每次重启轮换随机 token**，不带 token 一律 403
- 直发桥（8095）：仅绑 `127.0.0.1` + 环境变量 key 鉴权 + 收件人白名单双重校验
- 图库图片路由/管理面板（dsh-meme 组件）：**回环校验按 Host 头判定**（防 DNS rebinding——上游专门修过这个洞：Origin 头可伪造，Host 头由浏览器按实际连接目标写，伪造不了）
- 图库路由白名单按索引动态构建：磁盘上存在的文件不在索引里也 404

### 隐私边界

- **表情包入库三闸**的本质就是隐私防线：手机截图/私照特征（EXIF、竖屏比例、大体积）一律拒收，从机制上防止"群里谁的私照被偷进库"
- 会员 Cookie（网易云/酷狗）只存本机 `<dshHome>/channel-qq/*.txt`，扫码登录由你本人操作，插件只持久化不回传
- 日志（QQ 号/群号）只写本机日志文件

### 陌生人私聊门控（主人审计）

私聊不是谁都能聊起来的：admins 直通、QQ 好友自动放行、`allowList` 白名单直通；
**陌生人进待审**——给对方回一条统一说明（不进 agent、不耗一次模型调用），同时给主人
发待审通知（同号 10 分钟限一次 + 全局连发保护）。主人用 qq_dm_gate 工具一句话
放行或拒绝；拒绝进冷却，再发静默丢弃。状态持久化本机。

### 权限边界

- 工具审批策略**留在 dsh 本体的 permission presets**，插件不带也不绕过任何权限门——插件不做硬门控，也不越权代管
- 所有发送类工具先过窗口白名单再过发送验证，双重锁

**全部代码开源可查**：MIT，仓库里每一行都看得见——包括上面每一条安全声明对应的实现。不信任何 README，去看代码，这是开源的意义。

## 装起来多简单

```bash
git clone https://github.com/DandanLLab/dsh-channel-qq
cd dsh-channel-qq && npm install && npm run build
```

```yaml
# profile cordis.patch.yml
- insert:
    - id: channel-qq
      name: dsh-channel-qq
      config:
        connection: { mode: reverse, url: ws://127.0.0.1:8082 }
        selfId: 10000
        admins: [123456]
        primaryGroup: 789012
        persona:
          selfName: MyBot
          masterName: 主人
          pronoun: 咱
```

不需要装 dsh-companion、不需要单独装 dsh-meme 或 dsh-life-engine——**全部随包集成**，三个组件独立开关。角色性格写在 agent 预设的 persona 提示词里，与插件解耦。

## 致谢与出处

- 感谢 **Aegink/dsh-channel-qq** 的优质二改（分层架构、记忆 v2、评测基线）——融合对账见 [docs/upstream-fusion-ledger.md](https://github.com/DandanLLab/dsh-channel-qq/blob/master/docs/upstream-fusion-ledger.md)：软规则吸收，硬规则按定位不采纳
- 图库组件 = [dsh-meme](https://github.com/yyh-001/dsh-meme) by Selfloom（MIT，vendor 并入并附零配置 QQ 桥）
- 表情库入库思路来自 astrbot stealer/meme_manager（分析借鉴，未抄代码）
- 生活组件 = [dsh-life-engine](https://github.com/DandanLLab/dsh-life-engine)（Sleep-time Compute / Reflexion / mem0 / HippoRAG / CoVe / ToM）

## 谁适合用

- 想要一个**住在 QQ 群里**的长期陪伴/群运营机器人的
- 被串窗、表情包发错图、点歌卡被吞折腾过的（这三块的防呆都做穿了）
- 想 bot 真的"住进" QQ 号的：签名/状态/资料/打卡自己玩，不只是回话机器
- 在意隐私、想要"数据全在本机、代码全可查"的
- 在 dsh 生态想一站式拿到"通道 + 图库 + 生活"的

仓库在这儿，star 随意，issue 随提：

**https://github.com/DandanLLab/dsh-channel-qq**

---

*插件不做代答，只把世界递到 agent 手上。*
