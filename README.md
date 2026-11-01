# dsh-channel-qq

dsh（DeepSeek Harness）的 QQ 群聊/私聊通道插件，基于 OneBot v11（NapCat）。
把 QQ 的世界映射进 Agent 上下文，把行动权交给 Agent 本身——插件不做任何代答。

## 功能总览

- **消息通道**：群聊+私聊，注入模式（inject/steer）或攒批模式可选
- **视觉**：入站图片自动附件化给多模态模型；表情包偷取+情绪标签库（MD5 去重+语义搜索）
- **语音**：语音条转文字（STT）；TTS 语音回复（多 provider）
- **文件**：私聊/群文件收发、自动落盘 inbox
- **音乐**：网易云（含 VIP 扫码登录）+ 酷狗（KuGouMusicApi）点歌/歌单
- **社交**：戳一戳裁决制、表情包反应、关键词触发、情感引擎（好感冒泡）
- **QQ 客户端全能力**：个性签名/资料/头像/在线状态/群打卡/合并转发/收藏/群荣誉（NapCat 扩展 action；其他 OneBot 客户端不支持时明确报错）
- **表情包图库组件**：内置 [dsh-meme](https://github.com/yyh-001/dsh-meme)——send_meme/learn_meme、情绪+关键词搜图、AI 学图、管理面板（详见下文）
- **日程**：主动出击、每日群日报脚本
- **生活引擎组件**：内置 [dsh-life-engine](https://github.com/DandanLLab/dsh-life-engine)——记忆可塑性（状态机+睡眠巩固）、内心独白、好奇心引擎、反思回路、每日自画像、KB 语义/考古双路检索（详见下文）
- **运维**：网关重试、僵尸连接看门狗、下发队列限速、发送日志

## 安装

```bash
# 1. 克隆到任意目录
git clone <repo> dsh-channel-qq
cd dsh-channel-qq
npm install            # 或 pnpm install

# 2. 编译
npx tsc -p tsconfig.json
```

在 dsh profile 的 cordis.patch.yml 里挂载：

```yaml
- insert:
    - id: channel-qq
      name: dsh-channel-qq
      config:
        connection:
          mode: reverse          # 或 forward
          url: ws://127.0.0.1:8082
        selfId: <机器人QQ号>
        admins: [<管理员QQ号>]
        primaryGroup: <主力群号或null>
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

> **人格背景完全自定义**：selfName/masterName/peerName/pronoun 四个字段
> 决定插件注入提示里的称谓。角色性格本身写在你的 agent 预设的 persona
> 提示词里，与插件解耦——换角色只改两处文本，不动代码。

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
- `emotion.json`：多维情绪状态（心情/能量/最近事件），影响回复语气
- 悬浮窗端口默认 8789，可配置或关闭

## 表情包图库组件（Meme Engine）

本插件从 0.2.1 起把 [dsh-meme](https://github.com/yyh-001/dsh-meme)（MIT, © Selfloom contributors）
作为内置组件打包：**图库管理**（情绪/关键词双维搜图、跨图库开关、ZIP 导入导出）、
**send_meme**（agent 按情绪主动发图）、**learn_meme**（用户说"收藏这张"时 AI 自动识别
分类/描述/关键词后收录）、自包含管理面板（/memes-panel）与 /dsh-memes 图片路由。

- 默认开启；`config.memeEngine.enabled: false` 一键关闭
- **零配置 QQ 发送**：组件不再依赖独立的 dsh-companion——channel-qq 包装器直接把
  发送桥接给自己的 OneBot 客户端（沿用群白名单/私聊 admins 窗口纪律与魔数后缀校验）
- 随包内置图库（dafeiyu-001，24 张）开箱即用；用户图库默认扫 `~/.dsh/meme-packs`
- 独立安装的 dsh-meme 不受影响（适配层自动回落 companionQq 通道）

## 生活引擎组件（Life Engine）

本插件从 0.2.0 起把 [dsh-life-engine](https://github.com/DandanLLab/dsh-life-engine)（MIT）
作为内置组件打包：**记忆状态机**（NEW→INDEXED→ACTIVE→DECAYING→ARCHIVED→FORGOTTEN）、
睡眠巩固、内心独白、好奇心引擎、反思回路、每日自画像，以及 KB 语义检索
（`kb_search` / `kb_deep_search` / `brain_search`）与自主闹钟、tailmsg 通信等 30+ 工具。

- 默认开启；`config.lifeEngine.enabled: false` 一键关闭
- 身份与路径全部外置：组件从 `<dshHome>/tongling-life/config.json` 热读配置（目录名沿自组件历史，可在 config 内自定义 agentName）——
  `agentName`（KB 专属库子目录名）、`personaName`、`familyPeers` / `familyMap`
  （家族神经网节点）、`kbCli`、`embedUrl` / `embedModel`（本地向量端点，可选）
- `kb.cjs` 会话层根目录可用 `KB_SESSION_ROOTS`（分号分隔）指定；agent 集合用
  `KB_AGENTS` 指定
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

## 依赖

- dsh harness（cordis 框架）
- NapCat（OneBot v11 实现）
- 可选：ffmpeg（语音转码）、KuGouMusicApi（酷狗点歌）

## 目录结构

```
src/
  index.ts          插件入口，服务生命周期
  config.ts         配置模型（含 persona 背景设定）
  onebot.ts         OneBot v11 WS 传输（forward/reverse + 心跳看门狗）
  bridge.ts         会话桥：消息→上下文，注入/攒批双模式
  segments.ts       消息分段解析（文本/图片/引用/文件/语音）
  tools.ts          48+ qq_* 工具注册
  emoji-library.ts  表情库：MD5去重+视觉打标+语义搜索
  emotion.ts        多维情感引擎
  affection.ts      好感度+悬浮窗
  scheduler.ts      主动出击调度
  netease-vip.ts    网易云（含 VIP 扫码登录）
  kugou-api.ts      酷狗（KuGouMusicApi 客户端）
  stt.ts            语音转文字
  audio-convert.ts  TTS 语音合成
  life/             生活引擎组件（dsh-life-engine 并入：index.ts 薄包装 +
                    life-engine.js / kb.cjs 原样组件）
  meme/             表情包图库组件（dsh-meme 并入：index.ts 适配层 +
                    index/memes/anim/panel 原样组件 + 内置图库）
scripts/
  daily-report.mjs  群日报生成
  copy-life-assets.mjs  构建时把 life 组件资产拷进 lib/
docs/
  emoji-pipeline.md           表情包完整方案（入库三闸/严格后缀/MISS 兜底）
  upstream-fusion-ledger.md   上游二改融合对账（吸收/不吸收/为什么）
```

## License

MIT（含 `src/life/` 组件，源自 DandanLLab/dsh-life-engine，同 MIT）
