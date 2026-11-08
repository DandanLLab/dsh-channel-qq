# life/ — 生活引擎组件（dsh-life-engine 并入）

**目录**: `src/life/`（index.ts 薄包装 + life-engine.js / kb.cjs 原样组件）

## 职责
Agent 的"生活"：记忆可塑性、内心独白、好奇心、反思、自画像、灵魂模板、
家族神经网、KB 双路检索——32 个 self_*/brain_*/kb_*/tailmsg_*/bee_*/soul_* 工具。

## 关键机制
- **记忆状态机**：NEW→INDEXED→ACTIVE→DECAYING→ARCHIVED→FORGOTTEN；30 天未命中降权/
  90 天归档；睡眠巩固（idle≥15min）+ 重放闭环（kb_recent 真文件入账）
- **KB 检索**：语义（本地向量端点 bge-small-zh@17861，可选）+ bigram/Jaccard 降级 +
  考古（graphRecall/家族 reindex）；KB_SESSION_ROOTS/KB_AGENTS/KB_AGENT_NAME 环境变量
- **毒化预检**（1102）：写入前检查回填缺口与全零 bin，硬失败不落盘
- **缓存率冻结**（1109）：regSection 本地注册器只冻结自己的 9 个 systemPrompt section
  （首渲染后值固定，进程生命周期 system 静态）——绝不替换共享 ctx.systemPrompt.section
  （1109 事故：替换共享方法后多会话 resume 全线 already registered 82 连炸）
- 配置热读：`<dshHome>/tongling-life/config.json`（agentName/personaName/familyPeers）

## 模块连接
- **上游**: index.ts applyLifeEngine（装配）、bridge.ts（systemPrompt scope 注入）
- **下游**: dsh harness（工具注册+section 注入）、knowledge 工作区文件（.life/、self/、.kb-recent）
- **双份同步纪律**: src/life 与 lib/life 是手动双写（lib 是运行入口），改一处必须同步另一处
