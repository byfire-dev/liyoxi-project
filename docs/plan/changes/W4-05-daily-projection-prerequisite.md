# W4-05 历史日快照写者前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 独立交内部周期历史快照契约、捕获函数、真实流水估值及主体日投影；W4-05在actual main后接实际写者和日任务 |
| 原因 | 原subscription_event未保存可变周期与待发成本的完整历史，不能拍当前余额或从现行计划猜旧日价值 |
| 影响的包 | W4-05；未来W4-08延长/复活、W4-10退款等相关写者须同TX填快照 |
| 类别 | 顺序 |
| PR | — |

允许叶：contract/billing/subscription-snapshot.ts与窄出口；
services/billing/reporting/{snapshot,valuation,daily}.ts、单DB聚合及billing出口/README。
不改DDL、依赖、kernel、账本锁序、原只增流水、财务口径、runtime/任务登记或outbox载荷。

内部`subscription_event.payload.dailySnapshot`使用v1 strict schema；旧payload兼容由后继写者接线包保留。
新写者在该事件对应term/schedule变更完成后、同TX捕获；预约链顺移各term分别捕获已有extended事件。
daily按每term最后seq且bizDate≤D的快照恢复状态/MRR，scheduled不覆盖active；
未来预收只用当时pendingGrants成本，扣已真实入账grant_monthly来源的流水bizDate，
不读当前余额或当前可变schedule值。估值固定policy1、按真实seq回放，conversion验证origin entry与实际转出效果。

legacy任一相关事件缺快照抛`BillingDailyHistoryMissingError`；缺归属/发放/估值事实也明确失败但不属于可吞旧史异常。
已有投影不替换、旧史不补猜。调用方先advance，再以kernel.savepoint隔离projection失败，
保持业务推进提交并继续其它主体；不能把全主体失败当0值成功，也不能吞掉其它错误。
真实旧史的迁移/回填策略仍待后继，不宣称历史资料已经完整。

本片一个最小DB聚合沿现公开账本fixture：真实发放/冻结/消耗/退回与conversion，
独立手算历史日余额/价值、预约隔离、真实月发放扣预收、重算相同、错误归属回滚、legacy保存点隔离。
未接实际履约/升级/延长等事件写者，跨13个月整链由W4-05接线后验；不重复旧全量性质矩阵。
唯一ROOT独审87.628秒、9叶首尾hash一致、P1/P2/D=0；格式/lint/diff检查G。
Node24 services首类型G23.055秒；新DB聚合首R6.982秒：新fixture的2026年1月早于现模板计费参数生效，
尚未进入projection；仅新测试整体移至2040年后1/1G（Vitest7.13秒、tests2.53秒，外层单调7.756秒）。
生产hash保持，单worker/session=w405daily；唯一failed库经正式ownership与无在途核验精确清理，剩余0。
日志`/tmp/lyx-w405-daily-services-types.log`、`/tmp/lyx-w405-daily-target{1,2}.log`、
`/tmp/lyx-w405-daily-cleanup2.log`；无API装配变化，未跑API类型/旧性质矩阵/构建/真实外部。
不把本片前置通过冒称W4-05实际写者、sweep或13个月接线验收完成。
