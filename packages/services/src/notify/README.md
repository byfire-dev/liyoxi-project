# 通知域

PR1 的五条商家消息接口、消息可见性与幂等裁剪以及 PR2 的发送结果协议已经进入本地 main。PR3 在这些实际能力上生成消息和投递，消费实际 M2 producer；本页已按源码与本地验收收口，唯一独审已完成，两项 P2 经原加新九项真库回归关闭；最终本地合流待调度；真实平台到达另验。

## 场景与当前事实

`registry.ts` 把事件映射到场景与已登记的 `notifyReadPort` 事实。事件只供正式对象标识与积分变动的已验证数量快照；角色、归属、待办状态、版本、余额、实际付款金额、深链都取当前本域事实。通知当前事实缺登记或返回 null 视为不可派发；N15/N5 必要端口缺登记报受控检查错误。`SCENE_COVERAGE` 是枚举目录，不代表未来 producer 已实现。

只有现有 merchant_user.wechat_bound、store.qualification.submitted/approved/rejected、account.verified/abnormal 六种可重复发生的事件，用稳定 outbox event.id 区分本次通知。账号/门店当前 status 与 version 不能代表新的绑定或审核轮次；旧事件跨新轮次重放仍对应原通知。其余场景及积分原去重规则、当前归属/角色事实和同 TX 写入保持不变。

| 实际事件 | 场景 | 当前事实与接收人 |
| --- | --- | --- |
| order.submitted / order.started | m.order_submitted / m.order_progress | 订单域真实订单、当前主体老板；正式 order.detail |
| plan.pushed / sample.pushed | m.plan_pending / m.sample_pending | 真实待确认版本，当前主体老板；sample 还检查当前工单步骤与暂停 |
| package.delivered | m.delivered | 成片包、订单项与发布域实际任务；查不到合法发布深链不派发 |
| ticket.created / assigned / step_changed / episode_qc_failed | s.work_ticket_assigned / s.delivery_progress | 当前负责人；未分配工单只发当前在职交付主管 |
| plan.confirmed / change_requested、sample.qc_failed / confirmed | s.delivery_progress | 当前真实交付经理或剪辑师，不信事件中的旧负责人 |
| account.verified / abnormal、launch.verified / returned | m.channel_account_result / m.verify_result | 当前渠道账号或上线任务与老板 |
| billing_order.paid、billing.subscription.activated / renewal_scheduled | m.pay_success / m.plan_activated / m.plan_renewed | 真实付款单、金额或订阅期；购买策略在同一 caller TX 读取 |
| billing.points.granted / purchased / returned / adjusted / captured / expired | m.points_changed / captured / expired | 正式 payload 数量、当前账户余额与老板；不按模板 label 猜值 |
| transfer.proof_submitted / rejected、payment_exception.opened | s.receipt_pending / m.transfer_rejected / s.payment_exception | 当前凭证或差异单及真实在职财务；驳回落 payment.detail |
| approval.submitted / approved / rejected / sla_breached | s.approval_pending / decided / overdue | 当前审批事实和正式 authz 决定权；结果给当前在职申请人 |
| asset.adopted | m.asset_feedback | 素材仍存在、商家上传、真实上传人仍可进入门店；员工代传不产生商家接收人 |
| site_notice.announced / withdrawn | m.rule_change_notice / withdrawn | 全部正常主体的当前老板，主体分别定格；站内必达、无外部通道；V1 每账号仍至多一条 active 主体成员关系 |
| store.qualification.submitted / approved / rejected | m.store_review_submitted / m.review_result | 当前门店审核事实与老板 |
| merchant_user.wechat_bound | m.account_security | 当前有效账号的账号级消息；新绑定身份不能消费这次订阅额度 |

其他已登记场景保留所属 M3–M6 producer，不把没有实际调用的事件映射当作完成。`billing.subscription.upgraded/resumed/extended` 当前没有实际 producer 与正式 payload，未接入。素材 review/demand、换绑手机号、成员变更、退款、客服、广告、巡检、授权书、人工催办等由实际业务写侧落地后按原场景接入，不能凭未来事件伪造通知。

协议公告通过 docs 的公开 `readAgreementNoticeLink` 读实际版本/key/siteNoticeId，config 的 `normalizeSiteNoticeLink` 返回严格 `agreement.view { key }`。撤回公告的消费处理及当前状态守卫可以生成“调整已取消”，但当前生产写侧尚未发出 `site_notice.withdrawn`，不视为真实端到端生产路径；首页公告条的 announced 过滤由首页读侧负责。不存在、错引用、状态不一致不产生可用链接。非协议公告仍验证原严格 DeepLink。

## 派发、发送与锁

`onEvent(tx,event)` 在调用方同一事务写 notification、站内消息、各通道 delivery；事务失败全部回滚。站内消息立即记 sent，外部通道仅记 pending，扫描器每五秒入既有 notify 队列，内核并发仍为 4。Redis 入队失败按原关键通道降级，小批调用同一 deliver，不另造调度框架。

外呼分三段：T1 条件认领并增加 attempt；T2 重新锁当前事实、判断守卫与限频，微信额度预扣且写 callStartedAt；Provider 调用在 TX 外；T3 使用同一顺序锁并按 attempt/status 条件记结果。未开始的过期认领可恢复 pending，已经开始而结果未知只记 unknown_outcome，不能重发或返还额度。只有明确未受理且 rate_limited/aborted 的失败可按 30/120 秒重试；最多三次。调用十秒预算与 close 通过 AbortController 收尾，不把未证明的取消当作未发送。迟到的真实成功可修正 unknown，并撤销尚未开始的补发。

close 等待整次 delivery/direct 调用，包括认领、准备、结算和直发最终读，之后才允许关闭连接。认领或准备提交后才观察到 close 且尚未调用 Provider，明确记 not_accepted/aborted，并沿既有结算条件归还额度、清租约；已经调用 Provider 的取消仍保留其真实接受状态。敏感参数只留在调用栈。

实际锁顺序为：staff20 / merchant_user80 → 必需 approval_request30（员工路径） → wechat_identity90 → entity100 → entity_member120 → store130 → 实际业务对象递增 rank → 固定 verify_code 与实际 SMS 模板按 key 排序 → WX 槽位 → delivery → quota/lastOkAt。identity90 在任何实体/业务对象锁之前。T2/T3/scan/注销清理共用顺序；quota-only 平台回执不反取模板。fixed SMS anchor 不存在受控不发送。所有者、成员、待办版本和当前角色都读真实锁定事实，不以注释代替锁。

场景关闭/待办已处理/归属失效取消且不补发；无配置、无额度、永久失败等只按正式回退原因补 SMS。通知短信同号码自然日上限、同场景折叠与企微 10 条/分钟均在真实 callStartedAt 记录上计数；费用限频或折叠不转交付经理。manager escalation 从原 notification 取得受支持真实 guard 引用，重读当前业务和经理，只有非人工 SMS 与订阅均未成功才生成员工待办。

普通员工企微通知即使场景配置 immediate，也按当前工作日历及 work.start/work.end 顺延；仅正式 s.kf_response_overdue 可全天发送。站内消息不等待工作时段。组合根经 SLA 公开读口提供下一可工作时刻，T2 再读当前日历和参数；工作时段已变则清租约并恢复该次 attempt，未外呼且不扣发送额度。

`render.ts` 仅有已接 M2 槽位的固定表达式，微信 field.name/type 与短信 param.name/maxLen 必须匹配；未知字段受控 unconfigured，不把 label 当取值规则。付款金额来自真实 fen，积分变动来自正式数量，文字按字段类型截断。默认 seed 的模板未配置，不能声称实际发送成功。

API 的 awaited startupChecks 和 worker.selfCheck 检查真实场景行及已配置的 M2 槽位字段。默认 unconfigured 空字段允许；test/stg 配置错误拒绝启动，prod 只记固定场景键与技术原因的告警，发送仍按原固定字段规则受控跳过且不扣额度。校验不打印模板 ID、标签、配置原文或环境值。付款站内文案按同 TX 的购买模式定格：in_app 显示真实单据金额；offline_contract/hidden 用真实付款类型派生“服务已开通/已续期”，不带金额且只落 wallet.home，无付款订阅投递。

通知检查依赖本次 db.connect 成功；断库仍只报告原连接失败，不重复报告配置读取失败。注册场景的种子行必须存在，整表未初始化不同于正式 unconfigured 空模板；启动兼容性测试使用既有完整种子支架，缺场景的配置守卫仍保留。

`sendDirect` 是无场景的短信能力：敏感 phone/params 只活在调用栈，持久化只有 HMAC 引用与脱敏目标。验证码/激活码同手机号 60 秒 1 条、小时 5 条、日 10 条，普通通知自然日总上限读取参数；唯一 directKey 不重新调用 Provider。员工激活仍保留正式八字符协议，没有为了外部六位模板缩短。当前 W2-22 真 SMS 驱动未在本分支实际落地，不声称员工短信到达完成。

## 提醒与不变量

R4 样片等待及实际员工待审批/跟进事实已接；R1→W4-05、R7→W3-10，R2/R3/R5/R6 等仍等原所属业务包。R4 使用上海自然日、真实 pushed 时间范围与当前版本守卫，节点/版本/接收人去重；当前工单已暂停或不再待确认即取消。跟进到期使用正式 follow_up.next_follow_at 的日期，从该日 09:00 起，仅当前在职 owner 且仍待跟进；改派、改期后重新读取当前事实。必要补登单一 `s.followup_due`，source_rule=followup_due、biz_type=follow_up、merchant.detail {entityId}，不复用转移超时场景。

N1（消息对应 inbox sent）、N2（lease）、N3（停用槽位后的实际发送）和 N15（manual_reminder_log 的真实多态对象存在）按原模式登记。N15 经 ad/order/delivery/publish/billing 的六个 keyed exists 事实，不在 notify 直接查询上层表。docs.N5 通过 billing/order/ad 的三个交易/同意事实端口验证实际协议、同意人和同意时刻，不缺注册恒真。默认组合根按本 scope 的 Assembly 闭包接入，两个运行时不互串，关一个不解绑另一个。

## 边界与验收记录

真实 DB、假 Provider 与本机取消只能证明代码事实；外部微信/企微/SMS 到达另记台账。现已完成的目标日志与首次失败保留在交接文件，本地登记门禁与两根构建已通过，唯一独审已完成，两项 P2 定点修复由集成负责人闭环，最终本地合流由其执行。

独立结构能力 notification_fanout 已实际合本地 main。公告先有界探测 batch+1，超过容量只写唯一分页任务；notify.fanout.batch 默认 1000，隔离测试设 2 只证明页边界。原 notify 队列承载 deliveryId/fanoutId，页 job key 包含 task、账号/主体二元游标、到期时刻与 attempt。纯 CAS 短事务认领后，业务事务按全部账号→全部主体→全部成员锁序读当前归属，再在 config 公开读口锁当前公告；站内消息与最后进度 CAS 同时提交，租约或 claim 失效全部回滚。每页失败最多三次，成功推进游标后归零 attempt；公告失效取消原任务，撤回有独立任务。分页五项真实 DB 反例已通过，不宣称 1000 接收人的性能达标。

虚构 DB 支架位于已有 testing/notify-dispatch.ts，并只从测试公共入口导出。最初私有夹具跨域入口造成的分层失败已保留；迁移只整理入口，真实领域/锁/Provider 和原八文件42项断言不变，迁移后全绿。runtime 也仅经 ops/index 消费两个装配工厂。
