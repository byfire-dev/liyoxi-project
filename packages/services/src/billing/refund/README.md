# 现金退款（W4-10）

本目录负责退款申请、权益回收、渠道交易三个层次。正式契约见 a07 §3.54–3.66、h01 §3.2；权益公口在 `billing/ledger/term-refund.ts`，现金退款不调用积分退回 `ledger.refund`。

申请冻结服务端核算与真实收款身份，经 `plan_refund` 审批。E1 在单主体事务内按 approval30/request70→order290→receipt300→refund320→invoice330/exception340→file410→account420 取锁；先回收权益、登记原退款号与执行意图后提交。外调在事务外；E2只记录受理/未知状态，现金成功由可信回调、查询（及后续账单公口）归并。提前到达的成功不被E2覆盖。旧执行幂等身份只保存哈希到 `recheck_log.executeIntents`，每项绑定本申请已经创建的交易；保留旧项，最多对应99个交易编号，恢复不猜“最新一笔”，也不换退款号。响应仍由既有幂等框架存储与重放。

自动提交默认采用正常内联一次、同原号补提交最多一次。每次外调前持久预约 `submit_count` 与 `last_submit_at`，第二次预约同时停止自动提交；订阅者只登记受控定时器，不在投递事务里外呼。`rf.poll` 的事务外准备阶段可补提交、之后只查询；已停止自动提交不停止查单。明确的人工 `retry` 才能再次提交，仍用原号并更新最后提交时间。仅在已停止自动提交满10分钟且专用查询取得验签/时间校验通过的 `RESOURCE_NOT_EXISTS` 证明后，才认定 `not_accepted`；普通404、未验签错误、网络超时均不释放未知态。没有新增隐式halt接口，也不在409响应中暗写停止状态。

失败回待执行时保留权益回收事实，不允许作废或恢复权益。晚到成功始终保存并只累计一次；金额不一致保留渠道事实并开差异，累计仍依 h01 按原交易金额。另一笔在途时不迁移申请；真实超退不受上限CHECK掩盖，开 `refund_over` 并让正式不变量报告真实异常。

发票联动复用真实发票公口，只处理入账收款。未执行关闭恢复闸门/暂停开票/差异，但不搬回已消费或已回收余额。日历只重算尚未执行的 `pending_execution`，取消旧timer与新快照/历史/timer同事务提交，失败后不重启时限。退款前移预约链时，根 `refunded`/`cancelled` 的 `affectedTerms` 保存同主体、唯一、仍为预约的实际快照，历史投影按同seq消费；它不能代替最初创建历史，不用默认预约数1造新增退款上限。

`submitExceptionRefund(tx, deps, identity, staff, input, idempotencyKey)` 是交W4-11的同TX公口，不增加HTTP接口。只从真实异常、回单、已退与在途交易推导金额和主体，重验异常仍open及回显/权限；未入账款不动付款单资金状态或发票。无主体收款仅全平台数据范围与正式差异处理权限可创建，审批/审计关联保留。W4-12的可信账单可调用 `recordRefundResult`；W4-13守卫仍由本包真实调用，未把兄弟包交付假称已完成。

`refund-abandon-txn` 只从stdin读取JSON。调用者分别提供一名财务及另一名超级管理员的有效opaque会话，双方回显同一TK单号/商户退款号；先经既有 `staffAuth.authenticate`，事务内再读现时角色、权限、会话有效期与stepup。只准放弃abnormal。`pay_receipt` 凭证须真实stored、分类/主体/上传人合法，永久media引用与含双方身份的审计同TX写入；凭证、会话均不进argv或输出。命令示例字段：`financeSession`、`administratorSession`、`refundTxnId`、`evidenceFileId`、`note`、`financeConfirm: {requestNo,outRefundNo}`、`administratorConfirm: {requestNo,outRefundNo}`。部署执行前仍需独立运维授权。

本机只用公开替身与隔离PG/Redis，不调用真实支付，不代表预发小额退款已验收。新增机制验证与当前状态见 `docs/plan/status/W4-10.md`。
