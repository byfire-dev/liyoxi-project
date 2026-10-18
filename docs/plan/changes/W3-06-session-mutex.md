# W3-06 PR1 会话互斥机制

| 项 | 内容 |
| --- | --- |
| 改了什么 | PR1独立补专用pg.Client窄工厂、kernel SessionMutex及API/worker实例接线，不提前PR2媒体/HTTP/调度 |
| 原因 | 专用互斥不占业务池，已观察失锁时拒绝入口/写入/提交，保留原事务与Provider禁令及外部副作用边界 |
| 影响的包 | W3-06 PR1及必要db/kernel/组合根伴随；无依赖/DDL/锁表变化，PR2继续负责取消/复核/补偿 |
| 类别 | 拆并（同包分片） |
| PR | — |

- @db仅补专用pg.Client窄工厂，tryLock/isHeld/close/lost，无任意query/裸连接或业务池占用；无依赖/DDL/锁表变化。
- kernel公开SessionMutex.run/close、scope.signal/assertHeld与可判定错误；同key占用即拒绝，默认2会话和1秒真实探活，结束/异常/断连释放。
- ROOT授权必要tx.ts与内部ALS叶：捕获原作用域、复用既有句柄和惰性查询守卫，已观察失锁后拒入口/写/提交，不改普通TX/重试/幂等或Provider禁令。
- API/worker组合根实际注入，提前取消并收在途后再关业务池；不新增PR2媒体/HTTP/调度，scope不跨兄弟链复用。
- 仅2性质+4真DB风险组，ROOT重型与唯一独审；网络半断未被观察的check/commit窗口诚实保留，PR2仍需外部AbortSignal/复核/补偿，绝不宣称可撤销已发外部副作用。
