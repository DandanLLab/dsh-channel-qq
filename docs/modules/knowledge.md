# knowledge.ts — 会话内知识库

**文件**: `src/knowledge.ts`（319 行）

## 职责
轻量会话内知识库（区别于 life 组件的 KB 向量库）：条目化记忆（类型/内容/标签/来源/
权重/命中数），权重随命中强化，关键词检索 Top-K 注入上下文。

## 关键机制
- `KnowledgeStore`：addMany 去重持久化 / search（关键词×3+权重×2+新近度）/ reinforce /
  size——原子写
- `tempOf`：记忆温度（life 记忆状态机的会话内侧）
- `redact`：脱敏（外发纪律）
- 捕获：管理员消息经 captureFromMessage 自动入库（bridge 层调用）
- 每日 04:40 scheduler 注入【知识提取任务】，模型自读日记用 extract 入库

## 模块连接
- **上游**: bridge.ts（knowledgeHint 注入/管理员捕获）、scheduler.ts（提取任务）
- **下游**: tools.ts（检索工具）
- **数据**: `workspace/knowledge/entries.json`
