# bridge.ts — 会话桥（插件心脏）

**文件**: `src/bridge.ts`（1099 行）

## 职责
入站事件 → Agent 上下文窗口包 → 提交 dsh harness 跑回合 → 出站行动权。
窗口协议、双模式、防串窗、注入哨全部在这。

## 关键机制
- **窗口来源标**：每条消息条目前缀 `[群:号]`/`[私聊:号]`；群/私聊包头带窗口信标
  （"target 必须填本窗口号"）——多群格局下防串窗第一层
- **角色与注入哨**：`[主人]`（config.master 唯一指令权威）/[群主]/[管理员]；
  非主人消息命中指令劫持话术正则 → `[疑似注入]` 标
- **双模式**：injectMode（每条实时入上下文+idle 唤醒，推荐）/ batching（windowMs 攒包）
- **跨窗口去重**：seenMessageIds Set（500 滚动）拦 QQ 重试/回声重复包
- **出站三道闸协同**：目标白名单硬拦（tools 层）+ 内心戏拦截（outbound 层）+ 空消息拒发（onebot 层）
- **system prompt 缓存**：经 life-engine 的 regSection 冻结（详见 docs/cache-stabilization.md）
- self-heal：启动时把存量 qq-* 会话 attach 回 workspace
- adminPrompt/injectNow：外部注入通道（换血交接卡走这里）

## 模块连接
- **上游**: onebot.ts（事件）、segments.ts（解析）、scheduler.ts（定时注入）、dm-gate.ts（放行信号）
- **下游**: dsh harness（submit 会话）、outbound.ts（回复出站）、sent-log.ts（流水记账）
- **依赖**: knowledge.ts（知识提示）、emotion.ts/sixDim（语气暗示）、emoji-library.ts
- **数据**: sessions 目录的 qq-group-*/qq-dm-* 会话文件（多帧 zstd jsonl）
