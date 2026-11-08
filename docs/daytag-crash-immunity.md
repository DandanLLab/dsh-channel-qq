# 已知问题免疫说明：启动后约 15 分钟崩溃（dayTag ReferenceError）

**状态：已修复，已随 v0.3.4 发布。升级到 v0.3.4 及以上（当前 v0.3.5）即免疫，无需任何额外操作。**

## 症状

进程启动后**恰好约 15 分钟**崩溃退出，日志尾部：

```
uncaught exception: ReferenceError: dayTag is not defined
    at appendLifeEvent (lib/life/life-engine.js)
    at sleepConsolidation (lib/life/life-engine.js)
    at Timeout._onTimeout (lib/life/life-engine.js)

dsh: fatal uncaught exception: ReferenceError: dayTag is not defined
Harness process exited (exit code 1)
```

带进程守护的部署（如 desktop 壳）会自动拉起，但拉起后再过 15 分钟又崩——形成"启动 → 15 分钟 → 崩 → 重启"的循环。

## 触发机理

- life-engine 的 30 秒巡检定时器每轮调用 `sleepConsolidation()`；
- **空闲 ≥ 15 分钟**时首次走"睡眠巩固"分支，必然调用 `appendLifeEvent` 写生活事件；
- `appendLifeEvent` 内部调用 `dayTag()` 生成日期目录名。

崩溃时间点稳定卡在启动后约 15 分钟，就是因为定时器从启动起数，第一个满 15 分钟空闲的巡检轮是这条代码路径的第一次执行。

## 根因

历史某次改动把 `dayTag()` 的函数定义落在了 `dailySelfPortrait()` 的函数体作用域内，而调用方 `appendLifeEvent()` 在共享作用域——`dayTag` 对它不可见，运行时抛 `ReferenceError`。

## 影响版本

| 版本 | 状态 |
| --- | --- |
| v0.3.3 及更早 | ❌ 携带此问题 |
| **v0.3.4+（当前 v0.3.5）** | ✅ 已免疫 |

## 修复与处置

- **2026-11-02 修复**：`dayTag` 提升到共享作用域，与调用方同层可见（另保留原位置的同实现副本，行为不变）。
- **v0.3.4（2026-11-08）起随仓库发布**。
- 处置：`git pull` 或重新安装到 v0.3.4+ 即可。崩溃本身无害（数据不受影响，重启即恢复），但升级前会一直循环，建议尽快升级。
- 不升级的临时缓解：保持会话活跃（无 15 分钟空闲）就不会触发——但这只是绕过，不是修复。
