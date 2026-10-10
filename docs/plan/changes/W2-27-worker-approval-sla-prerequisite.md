# W2-27 先交独立 worker 的审批 SLA 装配前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 在 W2-27a 本机 Redis 恢复演练前，单独交付 ops/worker 审批 SLA 固定实例装配及成对关闭；W2-27 任务书第 4、5 节原本不改业务代码，此经调度明确批准的 owner 前置独立实现与审查，不藏进部署脚本。 |
| 原因 | accepted main 89116 的独立 buildWorkerServices 没有绑定 approval 日历订阅者所需 SLA，原 I1/I3 类型绑定也依赖另建 createApproval；真实 calendar.imported 恢复事件不能靠 API 进程或假样例补齐。 |
| 影响的包 | W2-27；原环境泳道、a/b 依赖、HTTP/page/x01 归属、包数和里程碑退出条件不变。日志轮转、查日志、统计、Redis 演练、告警与错误接线仍未交付。 |
| 类别 | 顺序 |
| PR | 本地分支 codex/w2-27-worker-approval-sla；待唯一非作者审查与本地合流，不代表远端或预发接通。 |

固定包装只调用 approval 已公开的日历重算、到点处理和 I1/I3；类型 map 来自本次真实装配。仅替换审批订阅者、审批 timer subject 和两项校验的运行时依赖，保留原登记元数据与 staff/delivery 委派。正常 stop、自检失败、`--check` 三条路径释放本实例；不加框架、类型、DDL、依赖或审批业务算法。

验收源覆盖真实 calendar.import、同 event 两 subscriber.done、重复投递/导入、正式资格提交与门店改派的非空重算/原快照/旧 timer 取消/真实 worker 到点、producer 与 subscriber 事务回滚、I1/I3 非空错配检测、实例关闭隔离及真实队列关闭等待。没有虚构 outerTx，也不直接插出站事件、投递行或 timer 作为业务 producer。

当前仅源码准备；重检查排队，测试与类型尚未执行。实际接受的 C/A main 将普通合入本分支后，再对最新源执行所需检查并冻结；唯一非作者审查通过后才合本地 main。
