# W4-09 事务外订阅准备运输前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | events派发依赖新增可选beforeConsume；有效已知投递先短事务预检、事务外准备，再由原消费事务fence并提交 |
| 原因 | W4-09发货协议需要真实事务外HTTP，现subscriber.handle只在事务内运行，不能绕过Provider守卫 |
| 影响的包 | W4-09；独立运输前置供发货消费，旧无hook路径保持，发货与资金验收仍归原包 |
| 基线 | actual main `2fa686c087ebbe4e572ffb9ddb5c1139805cbc98`，原W4-09源码分支保留 |
| 范围 | dispatch.ts、其真实DB定点测试、events README与本说明；无DDL、契约、kernel、依赖或门禁改动 |
| 类别 | 调度批准的独立通用窄前置，不与资金/证书结构混包 |
| PR | — |

未配置钩子时不增加预检事务，旧派发/消费/失败规则保持。配置时预检真实leased、dispatchNo、lease_until及已知订阅者；未知事件仍延后，旧派发和已过期租约零准备。事务外准备期间失联或被新派发接管，最终事务不提交旧业务。准备抛错复用原recordFailure、退避、死信及旁路报告；队列和Redis降级的inProcess都走consumeDelivery。

这是至少一次准备，不是外部恰一次机制。后继发货领域仍须用既有sessionMutex按真实付款键跨派发串行、查询官方已发货事实并完整核对，未知结果先查；本片不包含发货Provider、证书配置、自动退款或任何真实资金/云操作。

新增定点覆盖：同派发并发准备允许重复而业务只提交一次、旧序号/过期/未知零准备、准备期间接管和租约到期的最终fence、错误退避与恢复、Redis降级同钩子、真实PG锁等待跨过租约期限。独审指出目标列表中的clock_timestamp可能在等锁前求值，已改为预检与最终两处均先锁行再用独立SQL读DB当前时间；旧无hook不增加查询。原退避/重复派发/性质轮数与等待不改。

本机singleworker/session=w409evt1：新增6目标与原无hook相邻2目标共8个独特目标已绿；首轮7绿，新增锁屏障因pg_sleep的void返回值不能反序列化失败，改为text投影后仅复验该例绿。该新增夹具最初直接使用Prisma事务被lint拒绝，已改用原createTxRunner，持锁链和消费链由外层并列启动；命令编排曾未挡住lint失败后的测试启动，已纠正。一次services类型检查、两TS的ESLint/Prettier与diffcheck通过；未重复7个已绿目标，未运行全历史套件或任何真实外呼。仅本session官方prune已完成，进程退出；后继发货/资金验收仍由W4-09承担。
