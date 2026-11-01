# 上游二改（Aegink/dsh-channel-qq）融合对账

> 本仓库是 DandanLLab 原版。Aegink 仓库在其基础上做了大重构（分层架构、92 工具合并
> 18 动作组、管理后台 27 页）。感谢这位二改作者的优质工作——本文件逐项对账：
> 我们吸收什么、不吸收什么、为什么。**吸收的全部是"软规则"（数据/策略/文档层）；
> 不吸收"硬规则"（权限门/访问门控等改变宿主行为的强制层），因为那属于部署者的
> 选择，不是插件的义务。**

## 一、已吸收（0.2.0 起随本仓库）

| 能力 | 来源 | 落点 |
|---|---|---|
| 事实蒸馏思想：注入用短事实、chunk 块只给深召回 | fork `docs/memory.md` 实测结论（chunk 挤进 600 字注入预算 recall 反而归零） | life-engine 组件的注入段保持短事实，`kb_deep_search` 负责原文块 |
| 检索评测基线：60 题基准+退化告警的思路 | fork `memory.eval` job | 记入 `docs/memory-recipe.md` 待做清单（README 路线图） |
| emoji/image 分型：语义搜索时截图类沉底 | fork stickers type 字段 | 我们的表情库 `type` 字段 + docs/emoji-pipeline.md 第五节 |
| 学习闭环候选制：自动产物一律"候选→审核"，不自动改行为 | fork `learning-jobs.ts` 纪律 | life-engine 组件的反思/巩固产物全部走 events 注入线（agent 自己动笔），插件从不代笔——与候选制同构 |
| "原文回指"检索纪律 | fork `qq_memory_search` 带 文件+行号 | `kb_deep_search` 已带 [窗口/日期/时间/出处文件] |

## 二、明确不吸收（硬规则类）

| 能力 | 为什么不收 |
|---|---|
| 审批网关 L0–L3 + 一次性令牌 | 改变宿主权限行为的强制层。dsh 本体已有 permission presets；部署者要硬门控可自己加 |
| 访问门控（陌生人私聊只回"待主人批准"） | 同上。我们保留 `requireMention` / talkValue 这类软触发，不做硬拦 |
| 管理后台 27 页 | 形态不同：本仓库定位是"渠道+生活"插件，不带 GUI 运维面 |
| tools.v2 的 18 动作组强合并 | 工具命名是模型可见面，强合并破坏本仓库现有工具兼容性；可作为可选 preset 未来再议 |

## 三、已修复、无需再取 fork 的

- 表情包入库三闸 + 发送严格后缀 + MISS 三级兜底（我们更强，见 `docs/emoji-pipeline.md`）
- 点歌卡吞卡对账降语音、URL 保护分段、正在输入、六维情感自主上报
- qzone 三件套、qq_swarm、游历群白名单（fork 无对应物）

## 四、fork 的两条实测教训（比代码更值钱）

1. **自动注入的预算是零和的**：600 字预算塞进一块 400 字的 chunk，整回合只剩一条证据，
   recall 实测归零。注入层永远用短事实；原文块只走深召回工具。
2. **语料形状决定召回上限**：日记原文句子做语料，关键词 recall 0.04、向量 0.14——
   药方是事实蒸馏（更短的"一句话事实"），不是更大的块。

## 五、dsh-meme 组件并入（v0.2.1）

[yyh-001/dsh-meme](https://github.com/yyh-001/dsh-meme)（MIT, © Selfloom contributors）
以 vendor 方式整体并入 `src/meme/`（index/memes/anim/panel.html + 内置图库，LICENSE 保留）：

- **唯一代码改动** = QQ 发送通道适配：上游依赖独立的 dsh-companion 插件提供
  `companionQq.sendImage`；组件化后由本插件包装器注入 `ctx.qqChannel`，
  直接桥接自己的 OneBot 客户端——群白名单/私聊 admins 窗口纪律、魔数后缀校验
  全部复用本插件现有管线。独立安装的 dsh-meme 自动回落 companionQq，双向兼容。
- 宿主 API 逐项核实（dsh 0.2.1-alpha.5）：tools.register / webServer.register
  (exact+prefix) / webServer.tapIndex / attachments.readImage|saveImage /
  agentDefaultModel.currentSelection / system-prompt/assemble 全部在役。
- 内置图库（dafeiyu-001 24 张）随包分发；`config.memeEngine` 开关。

## 六、v0.3.2 实机修复两则（内部修改版与 GitHub 版对照记录）

> 以下两条都是实机跑出来的 bug（部署侧撞到的），修复前先在内部版定位、
> 再按"对外可读"的标准写回本仓库（上游 Aegink fork 的对应代码若还在旧逻辑，
> 请同步这两处）。

### 1. `send_meme` 跨窗口投递（meme/index.ts 发送适配器）

| | 内容 |
|---|---|
| 症状 | 任何会话窗口调 `send_meme`，表情图**一律投进主群**（私聊窗口的表情也进群） |
| 根因 | meme-engine 组件的发送桥是固定签名 `(path, caption) => qq.sendImage(path, caption)`，**不传 opts**；适配器旧默认 `target = opts.target ?? config.primaryGroup` → 无目标时全落主群 |
| 修复 | 默认目标改 `config.admins[0]`（管理员私聊）；**显式传群号才进群**（群白名单校验保留）；`isGroup` 推导同步收紧 |
| 移植判据 | 上游 fork 若把 send_meme 直连自己的发送层，检查"无 target 时的默认值"——**默认值永远不该是群** |

### 2. 表情标记查库落空吞字（tools.ts `[表情: 描述]` 管线）

| | 内容 |
|---|---|
| 症状 | 三级兜底全落空时，标记被剥掉、图也没发——情绪表达整条蒸发（消息只剩干巴巴的文字） |
| 根因 | 旧策略"MISS 即 `continue`"是防错图的正确保守，但把**文字表情这条退路也堵死了**；quote 路径更早（词法不中直接 `return ''`，连语义兜底都没有） |
| 修复 | 落空时标记按**文字表情原样发出**：`qq_send_text` 路径收集 `emojiMissTexts` 回填消息尾（独立成行，配合按行分段）；`qq_reply_quote` 路径 `return '[描述]'` 留在原位。查库三层照旧先行——**先查库、落空才落字** |
| 移植判据 | 上游 fork 的 `features/stickers` 若还有"MISS 即丢弃"分支，对照本文 emoji-pipeline.md 第四节第 3 条改 |

### 脱敏声明

本版本对外发布前已过脱敏终扫：无 QQ 号/群号/token/本机绝对路径/部署侧人格称谓；
配置一律 env 化或 config.json 热读。行为变更各一条（发图默认私聊、落空落字），
无接口变更，0.3.1 → 0.3.2 平滑升级。

## 七、v0.3.3 记忆温度生命周期 + 安装链修复（1101 对账）

### 行为新增（三件）
1. **knowledge.ts 记忆温度生命周期 v2**：hot(≤24h)/warm(≤7d)/cold(>7d) 温度分层；`superseded`（被新偏好取代，召回权重 ×0.15 不删档）与 `expired`（到期不召回留档）两态；偏好压顶（管理员纠正句式自动捕获，零 LLM、负向前瞻防"不要X"误捕）；`redact()` 入库脱敏（sk-/ghp_/Bearer/JWT/AWS/key=value → `<REDACTED:…>`）；`save()` 投影 entries-digest.md 供外部索引器覆盖（KB 连接面）。
2. **bridge.ts 记忆注入 v2**：私聊路径 knowledgeHintPre 接线复活（v0.2.x 后成死代码）——偏好压顶 ≤3 条 `[管理员的长期偏好·优先遵守]` + 相关召回 ≤400 字符 `[记忆召回·需全文用检索工具下钻]`，总预算 ≤400 字符；群聊维持不注入。
3. **scheduler.ts RSS 槽**：2h 间隔拉外部 RSSHub 进料落知识库（喂料脚本由宿主配置，插件只留时间槽与调用点）。

### 安装链修复（两路之一：prepare 路）
- `package.json` 补 `"prepare": "npm run build"` —— 从 GitHub 安装时自动编译（此前 main 指 lib/ 而 lib/ 在 .gitignore，装完即缺入口）。
- 修复 devDependencies 里 dsh-tools link 路径中的 U+000B 垂直制表符污染（`..\dsh\vendor\dsh-tools` 曾被转义成 `..dsh\x0bendordsh-tools`）。
- 补 `repository` 字段指向本仓库（npm 上 dsh-channel-qq@0.1.0 属于另一同名包，探测不再误挂）。
- 跨窗口会话查询的会话树目录 env 化：`CHANNEL_QQ_SESSION_ROOT`（未配置时工具明确降级提示，不再硬编码任何部署侧路径）。

### 历史欠账清理（0.3.2 遗留两处）
- 出处注释中性化（早期 OneBot 扩展表述，不含旧产品名）。
- 会话树硬编码路径 → env 化（见上）。

### 脱敏声明
本版本对外发布前已过脱敏终扫（七类违禁全零）：人格称谓/QQ 号/群号/token/本机绝对路径/旧产品名/供应商名。
0.3.2 → 0.3.3 平滑升级，无接口变更；`CHANNEL_QQ_SESSION_ROOT` 未配置仅影响跨窗口会话查询一项。
