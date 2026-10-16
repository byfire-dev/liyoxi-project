# W4-05 只读历史重算公口前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 从既有估值/日写者抽同一只读计算结果，供W4-05 I11/I13与写者共同消费 |
| 原因 | 原snapshot/rebuild会调用账户锁入口并覆盖派生表，不能冒充巡检重算 |
| 影响的包 | W4-05；独立actual main后caller接不变量，不在本片登记 |
| 类别 | 顺序、范围 |
| PR | — |

仅reporting/daily.ts、valuation.ts与billing出口、原单DB聚合、本域README。
`computeEntityValuation(db,entityId,at)`返回完整policy1估值行；
`computeEntityDaily(db,entityId,through,at)`返回`{days,valuations}`同次计算结果。
db只接受真实源表find读能力，不含派生表/写操作/账户推进；at由调用方注入，读者应提供一致读视图。
保原历史bizDate/seq、逐term v1快照、conversion来源、未闭合日拒绝与typed缺史失败；
不拍当前余额、猜填旧史、不改财务口径、锁序/DDL/kernel。
原写者在正式账户锁与账本时钟下委托相同计算，全部成功后才覆盖本主体派生表。

原唯一DB聚合保留全部断言，追加待发放未推进时计算拒绝且源表/派生表零写，
正式advance后计算值与写者持久值完全一致；不新增全套矩阵。
唯一ROOT独审52.496秒，6叶首尾hash一致，P1/P2/D=0；格式/lint/diff G。
Node24 services首类型G20.862秒；原单聚合含新增只读证据首1/1G，
Vitest6.91秒/tests2.35秒、外层同进程单调7.514秒，无RED/failed库。
单worker/session=w405read，正式standalone核无在途/剩余库0，未用Redis；
日志`/tmp/lyx-w405-reporting-{services-type,daily-target,cleanup}.log`。
不新增测试矩阵或冒称W4-05实际不变量接线、主包/外部验收已完成。
