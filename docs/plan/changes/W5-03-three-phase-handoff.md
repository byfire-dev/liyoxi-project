# W5-03：公共纠偏、交付核心与对账分三片移交

| 项 | 内容 |
| --- | --- |
| 改了什么 | 将08 §7.5、W4-20映射及W5-03任务书修为同编号三PR：PR1甲公共flow.adminTransition，PR2乙交付核心11API/两项M5 x01/三桩，PR3乙order/M5对账。W5-04/05/06仅等PR2验收并actual main，其余原下游仍等整包；包数16→16，API/页/x01/桩仍62/4/11/11。同步tasks/README及03–06状态的逐片依赖说明，不改汇总脚本。 |
| 原因 | actual源码只有M1 delivery的flow.reevaluate_sweep，尚无冻结M5 order的flow.reconcile_sweep实现。后者须消费W5-02取消创建、W5-05订单事实和W5-06 ensureLetters，而06原先经04/05反向等待03整包，形成隐藏环。flow README §9已要求人工纠偏由首用包实现，故先交独立公共单机制，再交可供04/05/06消费的交付核心，最后补对账。 |
| 影响的包 | W5-03整包级别甲/L，PR1甲、PR2/3乙逐片独审；W5-04/05/06的W5-03标准依赖编号保留，以PR2代码验收和实际合入回执核准。其他下游、M5进入/退出、外部验收与冻结metadata不变。 |
| 类别 | 拆并、顺序（同编号三PR，包数不变） |
| PR | —（调度创建后回填） |

## 1. 逐片依赖与验收

| 片 | actual main前置 | 交付与放行 |
| --- | --- | --- |
| PR1甲 | W0-12机器表、W0-14审计、W0-15事件、W0-16 flow、W1-01a authz/范围/再验证；均已完成，不依赖W5-01 | 仅flow.adminTransition首用公共单机制及性质/权限/回滚验证，0 API/页/x01/桩；不放行04/05/06 |
| PR2乙 | PR1、W5-01、W1-16a、W1-17、W2-03、W2-05、W2-17及原业务进入条件 | 完整11API、暂停/SLA/补发/指派公口，delivery.onCalendarImported、sla.breach × delivery_ticket_stage及三桩；代码验收且actual后放行04/05/06 |
| PR3乙 | PR2、W5-02、W5-05、W5-06 | 消费取消创建、当前订单事实与ensureLetters，补冻结order/M5 flow.reconcile_sweep；三片齐后才完成W5-03 |

PR1允许flow必要公共叶及runtime/repo/出口的首用接线；PR2允许shared delivery机器表补主文已要求的补发及SLA自循环，并同步主文机器表，不增加状态、DDL或门禁。PR3只调已合owner公口，不另造取消、授权或使用期writer。

## 2. 原文与冻结归属

- `packages/services/src/flow/README.md` §9：人工纠偏由第一个使用它的业务包实现；机器表/审计/事件/flow/authz对应W0-12/14/15/16、W1-01a，W0-14不是authz。
- `docs/data-model/10-delivery.md` §2 delivery_reissue及a05 §3.43–3.45：补发行status为普通业务状态，但reissue.opened、reissue.cancelled、package.reissued仍在delivery_ticket.step记from=to历史；不绕过flow补写历史。
- `docs/api/x01-events-jobs.md` §4.3与08 §8.4：M1 delivery的flow.reevaluate_sweep负责未暂停工单求值/卡死告警；M5 order的flow.reconcile_sweep处理开工缺授权、终局资质驳回缺取消申请及使用止日差异，止日仅自动顺延、缩短只告警。冻结registry、x01-map的名字/模块/里程碑保持不变，不把两循环合并或重复计数。

## 3. 状态与调度

W5-03非末片状态保持进行中，PR2/PR3未交付不冒称整包完成；只有实际合入的片才登记PR号、独审与验收。03原整包依赖字段保留legacy编号，由任务书细分表核准PR1可开工。04/05/06也保留标准W5-03编号，阻塞原因注明PR2，summary因此可能保守低估切片可开工；调度依tasks/README §7.2核对actual回执，不改脚本或虚造分片包号。
