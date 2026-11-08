# outbound.ts — 出站队列

**文件**: `src/outbound.ts`（329 行）

## 职责
Agent 全部出站消息的必经之路：限速、智能分段、超长硬切、内心戏拦截、发送执行。

## 关键机制
- **智能分段**（segmentReply）：按句号/问叹号切句（代码块/引号保护），每段独立发送，
  引用只挂第一段；`removeTrailingPeriod` 去尾句号——像人发消息
- **内心戏拦截**（isInnerMonologueLeak）："本轮不发/沉默决定/舞台指示占比>50%"等
  内部盘算漏出即拦，拒发打回
- **限速**：rateLimitMs（默认 800ms）队列节流，防风控
- **超长**：maxMessageLength（4000）硬切
- 打字拟真：私聊自动"正在输入"+打字延迟（900ms+字数×45ms 封顶 6s）

## 模块连接
- **上游**: bridge.ts（回复）、tools.ts（qq_send_* 系）
- **下游**: onebot.call()（唯一出口）
- **配置**: segmentation.* / rateLimitMs / maxMessageLength
