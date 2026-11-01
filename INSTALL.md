# dsh-channel-qq 完整安装教程

> 从零到"agent 住在 QQ 里"的全流程。约 15 分钟（含 NapCat 登录）。

## 0. 你需要准备什么

| 东西 | 说明 |
|---|---|
| 一个 QQ 号 | 专门给 bot 用的**小号最稳**（个人号协议有风控，主号被封不心疼） |
| 一台能跑 Node.js 22+ 的机器 | Windows / Linux / macOS 都行 |
| dsh（DeepSeek Harness）| 已装好并能启动，`dsh --version` 正常 |
| NapCat | OneBot v11 协议端，负责登录 QQ 收发消息（下文 1.2 装它） |

架构一句话：**dsh（大脑） ←OneBot v11 WebSocket→ NapCat（QQ 协议端） ←→ QQ 服务器**。本插件跑在 dsh 里，NapCat 单独跑，两者通过本机 WS 通信。

---

## 1. 装协议端（QQ 客户端）——完整步骤

本插件不直接连腾讯服务器，而是通过 **OneBot v11 协议端**（俗称"QQ 客户端"）收发消息。
协议端负责登录 QQ 号、维持会话；插件只跟协议端的本机 WebSocket 通信。下面以
**NapCat** 为例（社区最活跃、本插件的扩展能力最全），其他客户端见 1.4。

### 1.1 Windows：NapCat Shell（推荐，最省事）

1. 到 [NapCat Releases](https://github.com/NapNeko/NapCatQQ/releases) 下载
   `NapCat.Shell.zip`（无头版，自带 QQ 运行时，不装官方 QQ 也行）；
   已装官方 QQ 也可以用 Framework 版挂载
2. 解压到任意目录（示例 `D:\\NapCat\\napcat-shell\`）
3. 双击 `NapCatWinBootMain.exe`（或按仓库说明的启动脚本），首次会让你选 QQ 安装路径
   ——选官方 QQ 的 `QQ.exe`；无 QQ 则 Shell 会引导下载
4. 控制台出现二维码 + 一个本地 WebUI 地址（默认 `http://127.0.0.1:6099`）
5. 用**给 bot 准备的小号**扫码登录（手机 QQ 扫一扫）
6. 登录成功 = 协议端就绪

### 1.2 Linux / 无桌面：Docker

```bash
docker run -d --name napcat \\
  -e NAPCAT_UID=$(id -u) -e NAPCAT_GID=$(id -g) \\
  -e ACCOUNT=<botQQ号> \\
  -p 3001:3001 \\
  -p 6099:6099 \\
  mlikiowa/napcat-docker:latest
```

看日志拿二维码：`docker logs -f napcat`，手机扫码。WebUI 在 `http://服务器IP:6099`。

### 1.3 配置 WebSocket（关键一步）

登录成功后进 NapCat WebUI（`http://127.0.0.1:6099`，token 在启动日志里）：

1. **网络配置 → 新建 → WebSocket 服务器**
2. 监听地址 `127.0.0.1`（**只许本机**）、端口 `3001`
3. 保存启用——这就是插件 `connection.url: ws://127.0.0.1:3001` 要连的口
4. ⚠️ `3001`/`6099` 都不要暴露公网；WebUI 的 token 不要外传

### 1.4 换别的客户端

本插件只讲 OneBot v11，不绑定任何客户端：

| 客户端 | 形态 | 说明 |
|---|---|---|
| [NapCat](https://github.com/NapNeko/NapCatQQ) | 无头/框架 | 本教程演示；扩展 action 最全（签名/闪照/合并转发/AI 语音等全支持） |
| [Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core) | 纯协议实现 | 不需要 QQ 客户端本体，轻量；扩展 action 子集 |
| [LLOneBot](https://github.com/LLOneBot/LLOneBot) | 官方 QQ 插件 | Liteloader 加载，嵌在官方 QQ 里跑 |
| go-cqhttp 系及二改 | 独立进程 | 老牌经典，注意挑还在维护的分支 |

兼容性分级：**标准 v11 动作**（消息/图片/语音/文件/戳一戳/群管理）所有客户端通吃；
**扩展动作**（个性签名、闪照、合并转发、收藏、群打卡、在线状态、AI 语音）NapCat 最全，
别的客户端调用会收到明确的"动作不支持"，不影响其他功能。换客户端只需改
`connection.url` 指向它的 WS 地址，插件零改动。

---

## 2. 装本插件

```bash
git clone https://github.com/DandanLLab/dsh-channel-qq
cd dsh-channel-qq
npm install
npm run build
```

构建成功后 `lib/` 目录就是可加载的插件本体（含三个内置组件，无需额外安装）。

---

## 3. 挂进 dsh profile

编辑 `<dshHome>/profiles/<你的profile>/cordis.patch.yml`（没有就新建），加：

```yaml
- insert:
    - id: channel-qq
      name: dsh-channel-qq
      config:
        connection:
          mode: forward              # 插件去连 NapCat 的 WS
          url: ws://127.0.0.1:3001   # 上一步 NapCat 监听的地址
        selfId: <bot的QQ号>
        admins: [<你的QQ号>]         # 主人；私聊直通+管理工具使用权
        primaryGroup: <主力群号或null>
        persona:
          selfName: MyBot           # bot 自称
          masterName: 主人          # 对主人的称呼
          peerName: 朋友            # 对群友的称呼
          pronoun: 咱               # 自称代词
```

> `dsh.bundle` manifest 已在插件 `package.json` 里声明，也可以用
> `dsh plugin --profile <profile> add <本仓库路径或 GitHub 地址>` 安装。

启动 dsh，日志里看到 `QQ link ready` 即通。给 bot 发条私信试试。

---

## 4. 组件开关（按需裁剪）

三个内置组件都有独立开关，默认全开：

```yaml
        lifeEngine:
          enabled: true       # 生活引擎：记忆状态机/睡眠巩固/KB 检索/内心独白
        memeEngine:
          enabled: true       # 图库：send_meme/learn_meme/管理面板/内置表情包
        dmGate:
          enabled: true       # 陌生人私聊门控（见下文第 6 节）
          allowList: []       # 额外放行的 QQ 号
          notifyAdmin: true   # 陌生人私信时通知主人
```

### 生活引擎的个性化配置

组件从 `<dshHome>/tongling-life/config.json` 热读配置（改完即生效，不用重启）：

```json
{
  "workspace": "<agent 工作区绝对路径>",
  "agentName": "myagent",
  "personaName": "我",
  "familyPeers": [],
  "familyMap": "",
  "embedUrl": "http://127.0.0.1:17861",
  "embedModel": "bge-small-zh"
}
```

- `agentName`：KB 专属库子目录名（记忆隔离的键），改成你的 agent 名
- `familyPeers` / `familyMap`：家族神经网节点（没有多 agent 就留空）
- `embedUrl`：**可选**的本地向量端点。不装则自动降级 bigram+Jaccard 关键词检索，装了就是全量语义检索

### 图库组件

- 内置图库随包分发，开箱即用；你自己的图库放 `~/.dsh/meme-packs/<packId>/`
- 管理面板 `http://<dsh-web>/memes-panel`（ZIP 导入导出、跨图库管理、AI 学图）

---

## 5. 可选能力

### 音乐点歌（网易云）

- 免登录即可搜歌、发免费歌的卡片和语音
- VIP 歌：让 agent 调 `qq_netease_login`（action=start 拿二维码 → 你用网易云 App 扫码 → action=poll），Cookie 持久化在本机 `<dshHome>/channel-qq/netease-cookie.txt`

### 酷狗

先起一个 [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi)（`PORT=4000 node app.js`），再让 agent 调 `qq_kugou_login` 扫码。端口不对就设环境变量 `KUGOU_API_BASE`。

### 语音转文字（QQ 原生，零配置）

**默认就有**：收到语音条时插件自动调 QQ 原生转写（`fetch_ptt_text`，QQ 服务端转写，
不依赖任何外部服务），文字直接注入对话——什么都不用配。

QQ 原生转写不可用（客户端不支持）时自动回落自建 Whisper 端点（可选）：

```yaml
        stt:
          enabled: true
          baseUrl: https://<你的OpenAI兼容转写服务>/v1
          apiKey: $MY_STT_KEY          # 或写明文，或 $ENV 读环境变量
          model: whisper-1
```

两条都不可用才提示"收到语音"。历史语音用 `qq_fetch_ptt_text` 工具事后补查。

### QQ 原生 AI 语音（百变变声器）

让 agent 调 `qq_get_ai_characters` 列出群开通的音色，再 `qq_send_ai_voice` 把文字
念成语音条发群里；`qq_get_ai_voice_url` 拿音频 URL 可转发任意会话。

### 环境变量一览

| 变量 | 用途 | 默认 |
|---|---|---|
| `DSH_HOME` | dsh 主目录 | `~/.dsh` |
| `CHANNEL_QQ_BRIDGE_KEY` | 直发桥（8095 环回端口）鉴权 key | 空=桥不启用 |
| `QQ_MEME_PACK_DIR` / `QQ_MEME_PACK_DB` | 图库目录/索引位置 | `~/.dsh/meme-packs/<你的agent名>`（代码内默认值，建议显式配置） |
| `QQ_SIGNATURE_BLOCKLIST_FILE` | 签名词黑名单扩展文件 | `~/.dsh/workspace/self/80-签名黑名单.txt` |
| `KB_SESSION_ROOTS` / `KB_AGENTS` / `KB_AGENT_NAME` | KB 会话根/agent 集合/agent 名（分号/逗号分隔） | 自动推导 |
| `QQ_AUTOCLAW_*` / `QQ_DOUBAO_*` | 桌面子代理桥接（不用就不配） | 空=工具报未配置 |

---

## 6. 安全机制怎么用

### 陌生人私聊门控（默认开）

- **你（admins）私聊永远直通**；`allowList` 里的号直通；**QQ 好友自动放行**
- 陌生人私信：对方收到一条统一说明（文案可改 `pendingReply`），**不会进入 agent、不耗模型**；同时你收到一条待审通知
- 审计：直接跟 agent 说"放行 QQ xxx / 拒绝 QQ xxx"（走 `qq_dm_gate` 工具），或把号写进 `allowList`，或加好友
- `deny` 后该号再发消息静默丢弃；状态存 `<dshHome>/channel-qq/dm-gate.json`

### 陌生群预警

机器人在非白名单群收到消息时（`primaryGroup`/`extraGroups` 之外的群），会自动私信你一条预警。不认识这个群就把它移出去。

### 好友请求 / 群邀请预警

插件**从不自动同意**任何请求。收到好友请求或群邀请会私信你一条预警，你在 QQ 里手动处理。

### 隐私边界

全部数据（对话、记忆、图库、情感账本、Cookie）只落你本机磁盘；插件没有遥测/统计/上报代码；所有监听端口仅绑回环且带 token/key。完整安全声明见 [README](README.md) 与论坛文稿。

---

## 7. 日常用法（装完之后）

- **聊天**：私聊直说；群里 @ 它或配的关键词触发（`requireMention`/`talkValue` 控制话痨程度）
- **点歌**：会说人话就行——"放一首 xxx""这个卡吞了，发语音版"
- **发表情**：正文写 `[表情: 描述]`，出站层自动换真图；或让它调 `send_meme` 主动斗图；看到好图说"收藏这张"进图库
- **记忆**：说"记住这个"进长期记忆；"当时我们怎么说的"它会考古会话原文
- **群管理**：禁言/踢人/精华/群文件，都是 `qq_*` 工具，自然语言调用
- **空间动态**：让它"发条空间动态说说 xxx"（`qq_post_qzone`）
- **玩自己的 QQ**：改个性签名（`qq_set_sign`）、换昵称/资料/头像（`qq_set_profile` / `qq_set_avatar`）、
  设在线状态甚至自定义状态（"把状态改成自定义·摸鱼中" → `qq_set_online_status`）、群打卡（`qq_group_sign`）、
  合并转发（"把这几段合成聊天记录发给群" → `qq_send_forward`）、收藏（`qq_create_collection`）、查群荣誉（`qq_get_honor`）
- **万能逃生门**：没接成工具的能力，`qq_swarm` 共演算可以直接下发任意 OneBot action（带窗口白名单）；
  客户端不支持的动作会明确报错，不会静默吞

---

## 8. 常见问题

**Q: 启动报 WebSocket 连不上**
NapCat 没起 / 端口不对 / 防火墙拦了回环。先看 NapCat WebUI 的网络配置，`url` 要和它监听的一致。

**Q: 消息收不到但 NapCat 有日志**
WS 僵尸链路（断线重连后半死）。重启 dsh，NapCat 会自动回连。

**Q: 发 gif 变静态图**
老版本问题；现在的发送管线发送前按字节魔数校验后缀，伪装错后缀会自动纠正。

**Q: VIP 歌发不出来 / 卡片被吞**
QQ 对私聊卡片有服务端风控。插件已带发后对账：卡没到自动降级发语音条。还不行就让它走 `mode: voice`。

**Q: 账号被风控/掉线**
个人号协议的常态。看门狗每 5 秒检测、自动重连；频繁掉线换小号 + 降低发言频率。

**Q: 想只当纯通道用**
`lifeEngine.enabled: false` + `memeEngine.enabled: false`，就是一个干净的 QQ 接入插件。

---

## 9. 升级

```bash
cd dsh-channel-qq
git pull
npm install && npm run build
```

重启 dsh 生效。`<dshHome>` 下的数据（记忆/图库/Cookie/门控状态）与仓库无关，升级不丢。
