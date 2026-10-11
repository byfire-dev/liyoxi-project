# 通知域

## 成员门店范围调整源码阶段

`entity_member.stores_changed` 仅接老板调整范围的 producer：strict body 的 invitationId 为 null 或未给时，读取 tenant 当前有效成员及仍可进入的店，沿原 m.member_changed 派发给该店员，深链为有效店的 store.members。移出旧当前店不会漏通知；已失效成员无消息。按原 outbox.id 区分每次调整，重投同事件不重复，后续真实调整仍通知。

非空 invitationId 的未来邀请接受分支明确跳过，不误通知店员；joined/removed/promoted 等其他成员事件仍待所属 producer 接入。本片当前仅源码与轻静态准备，真实消费/回滚、类型与必要检查待独占验证，真实微信模板与平台送达未验。

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

场景关闭/待办已处理/归属失效取消且不补发；无配置、无额度、永久失败等只按正式回退原因补 SMS。普通通知短信同号码自然日上限复用私有 smsDayUsage：本日真实 callStartedAt 调用，或本日 keepalive 的 sending/未开始/有效租约预约，互斥计数且终态不退款。同场景折叠与企微 10 条/分钟仍在真实 callStartedAt 记录上计数；费用限频或折叠不转交付经理。manager escalation 从原 notification 取得受支持真实 guard 引用，重读当前业务和经理，只有非人工 SMS 与订阅均未成功才生成员工待办。

普通员工企微通知即使场景配置 immediate，也按当前工作日历及 work.start/work.end 顺延；仅正式 s.kf_response_overdue 可全天发送。站内消息不等待工作时段。组合根经 SLA 公开读口提供下一可工作时刻，T2 再读当前日历和参数；工作时段已变则清租约并恢复该次 attempt，未外呼且不扣发送额度。

`render.ts` 仅有已接 M2 槽位的固定表达式，微信 field.name/type 与短信 param.name/maxLen 必须匹配；未知字段受控 unconfigured，不把 label 当取值规则。付款金额来自真实 fen，积分变动来自正式数量，文字按字段类型截断。默认 seed 的模板未配置，不能声称实际发送成功。

API 的 awaited startupChecks 和 worker.selfCheck 检查真实场景行及已配置的 M2 槽位字段。默认 unconfigured 空字段允许；test/stg 配置错误拒绝启动，prod 只记固定场景键与技术原因的告警，发送仍按原固定字段规则受控跳过且不扣额度。校验不打印模板 ID、标签、配置原文或环境值。付款站内文案按同 TX 的购买模式定格：in_app 显示真实单据金额；offline_contract/hidden 用真实付款类型派生“服务已开通/已续期”，不带金额且只落 wallet.home，无付款订阅投递。

通知检查依赖本次 db.connect 成功；断库仍只报告原连接失败，不重复报告配置读取失败。注册场景的种子行必须存在，整表未初始化不同于正式 unconfigured 空模板；启动兼容性测试使用既有完整种子支架，缺场景的配置守卫仍保留。

`sendDirect` 是无场景的短信能力：敏感 phone/params 只活在调用栈，持久化只有 HMAC 引用与脱敏目标。验证码/激活码同手机号 60 秒 1 条、小时 5 条、日 10 条，普通通知自然日总上限读取参数；唯一 directKey 不重新调用 Provider。员工激活仍保留正式八字符协议，没有为了外部六位模板缩短。W2-22 恢复分支接腾讯驱动与真实结果协议，原八字符激活协议仍与腾讯验证码限制不兼容，具体见下文；不声称员工短信到达完成。

## 提醒与不变量

R4 样片等待及实际员工待审批/跟进事实已接；R1→W4-05、R7→W3-10，R2/R3/R5/R6 等仍等原所属业务包。R4 使用上海自然日、真实 pushed 时间范围与当前版本守卫，节点/版本/接收人去重；当前工单已暂停或不再待确认即取消。跟进到期使用正式 follow_up.next_follow_at 的日期，从该日 09:00 起，仅当前在职 owner 且仍待跟进；改派、改期后重新读取当前事实。必要补登单一 `s.followup_due`，source_rule=followup_due、biz_type=follow_up、merchant.detail {entityId}，不复用转移超时场景。

N1（消息对应 inbox sent）、N2（lease）、N3（停用槽位后的实际发送）和 N15（manual_reminder_log 的真实多态对象存在）按原模式登记。N15 经 ad/order/delivery/publish/billing 的六个 keyed exists 事实，不在 notify 直接查询上层表。docs.N5 通过 billing/order/ad 的三个交易/同意事实端口验证实际协议、同意人和同意时刻，不缺注册恒真。默认组合根按本 scope 的 Assembly 闭包接入，两个运行时不互串，关一个不解绑另一个。

## 边界与验收记录

真实 DB、假 Provider 与本机取消只能证明代码事实；外部微信/企微/SMS 到达另记台账。现已完成的目标日志与首次失败保留在交接文件，本地登记门禁与两根构建已通过，唯一独审已完成，两项 P2 定点修复由集成负责人闭环，最终本地合流由其执行。

独立结构能力 notification_fanout 已实际合本地 main。公告先有界探测 batch+1，超过容量只写唯一分页任务；notify.fanout.batch 默认 1000，隔离测试设 2 只证明页边界。原 notify 队列承载 deliveryId/fanoutId，页 job key 包含 task、账号/主体二元游标、到期时刻与 attempt。纯 CAS 短事务认领后，业务事务按全部账号→全部主体→全部成员锁序读当前归属，再在 config 公开读口锁当前公告；站内消息与最后进度 CAS 同时提交，租约或 claim 失效全部回滚。每页失败最多三次，成功推进游标后归零 attempt；公告失效取消原任务，撤回有独立任务。分页五项真实 DB 反例已通过，不宣称 1000 接收人的性能达标。

虚构 DB 支架位于已有 testing/notify-dispatch.ts，并只从测试公共入口导出。最初私有夹具跨域入口造成的分层失败已保留；迁移只整理入口，真实领域/锁/Provider 和原八文件42项断言不变，迁移后全绿。runtime 也仅经 ops/index 消费两个装配工厂。

## 短信驱动、模板初始化与健康任务（W2-22）

本节保留 W2-22 的腾讯云驱动、严格模板初始化与两个既有日任务。商家派发、公共 sendDirect 见上文；短信到达回执由原所属包接续，同步受理不代表已送达。

## 1. 运行配置与初始化

`loadEnv()` 读取整组 `SMS_SECRET_ID_FILE`、`SMS_SECRET_KEY_FILE`、`SMS_SDK_APP_ID`、`SMS_REGION`；两份 FILE 文件存纯文本云 API 密钥，每个普通文件按实际字节至多4KiB读取并关闭句柄，任何环境不接受明文变量，部分配置启动失败。整组存在时两处真实组合根装配 `tencent`；未配时 local/test 保留原控制台三方法，stg/prod 为未配置。新控制台 sendTemplate 不造服务商编号、checkBalance 不造余量。

库先运行既有迁移与播种，准备九个未配置模板。初始化使用启用的超级管理员 staffId，通过镜像命令调用公开服务函数：

```sh
node apps/worker/dist/sms-init.js --config /run/config/sms-templates.json --staff-id <staffId> --apply
```

不新增 x01 CLI 名字。`--apply` 在 stg/prod 必须明确给出；配置文件是显式路径、大小至多64KiB，严格JSON。退出码0为完成，1为输入或服务守卫拒绝（包括显式配置文件IO、JSON或大小错误），2为环境或运行时存储失败；只输出变更数量，不打印配置、文件路径、号码、验证码或密钥。命令不申请/审批签名模板、不发送短信。

顶层只有 `{ "templates": [...] }`，必须恰好九个既有键且不重复。每项字段如下；下面仅说明形状，虚构平台编号和审批事实不能用于真实初始化：

```json
{
  "templateKey": "generic_todo",
  "kind": "notice",
  "providerTemplateId": "9999990000",
  "signName": "虚构测试平台",
  "params": [{ "name": "item", "maxLen": 6 }],
  "status": "active",
  "approval": {
    "templateApproved": true,
    "signApproved": true,
    "reference": "fictional-shape-example"
  }
}
```

真实 `approval` 表示业主已核对模板/签名获批事实与参数长度，不能用本文件的示例代替。模板编号为1–32位数字，与实际 sms_template 字段约束一致；33位起在事务和外呼前拒绝。签名按官方规则为2–12个中英文/数字；配置只接受 active 或 pending_carrier，pending_carrier 不发送。整批先严格校验，再同事务校验超级管理员、九个种子与 kind，原子写入。相同配置重跑不改时间、不重复审计。实际变化会清空旧 lastOkAt，重新开始闲置周期；ops/notify_config、notify.sms.init 对自然模板键写 target_key，留 cli.sms-init，审计只保存有限差分与数量，不保存正文或签名。

## 2. 固定变量与发送约束

变量顺序来自 D6 §2.10。英文变量名与下列业务上限是本实现的明确映射；真实可发长度取此上限和业主批准的 maxLen 两者较小值。通知变量并非默认可无限发送，也不能擅自都固定为6字。

| 模板键 | kind | 有序变量（业务上限，Unicode字符） |
| --- | --- | --- |
| verify_code | verify | code(6)，纯数字 |
| review_result | notice | result(12)、reason(64) |
| sample_pending | notice | item(12) |
| launch_remind | notice | date(10)、channel(20)、drama(40) |
| plan_expiring | notice | plan(40)、expiry_date(10)、points(12) |
| offline_remind | notice | drama(40)、offline_date(10) |
| generic_todo | notice | item(12)，固定枚举 |
| account_notice | notice | 无变量 |
| ops_alert | notice | rule_name(64) |

generic_todo 事项仅可选：样片确认、广告确认、成片交付、上线确认、资料审核、工单回复、积分变动、服务到期、下架确认、账号安全、付款成功、订购成功、方案确认、发票开具、成员变动、素材反馈、退款结果。原十项保留；后七项是恢复后实际十一种 generic 场景所需的有限增量。D6 §2.10 要求≤12字的固定枚举，并未定稿这十项具体值；本增量不修改冻结契约枚举。场景 SMS 只按稳定 notifySceneKey 映射，显示名不作变量；未知或未提供键、实际获批 maxLen 装不下完整事项时拒绝，不截断成另一值。未知/缺失/多余/继承字段、空值、控制字符、明确 URL 前缀或超长变量在外呼前拒绝，不截断变量。

| 实际 generic 场景 | 固定事项 |
| --- | --- |
| m.pay_success / m.order_submitted / m.plan_pending | 付款成功 / 订购成功 / 方案确认 |
| m.delivered / m.verify_result / m.ticket_reply | 成片交付 / 上线确认 / 工单回复 |
| m.invoice_issued / m.points_changed / m.member_changed | 发票开具 / 积分变动 / 成员变动 |
| m.asset_feedback / m.refund_result | 素材反馈 / 退款结果 |

真实 sendTemplate 每次一个中国大陆号码；旧 sendOncallAlert 的多个号码走一次腾讯批量请求，200上限、禁止重复号码，部分受理返回失败且受理不明，不假称全部成功。只把 title 作为固定规则名，不把详细告警 content 填成额外变量。旧三方法输入/void成功值保持兼容，并接实际主线 NotificationProviderResult/signal：预取消在模板读取和外呼前明确未受理，外层原 TX guard 先执行；目标已开始后的取消保留 unknown，迟到已完整解码的平台结果不被后来 abort 覆盖；不补发。

原生 fetch/node:crypto，固定 sms.tencentcloudapi.com、SendSms、2021-01-11、TC3-HMAC-SHA256。外部每次10s×1，无内部重试（包括限流、5xx和读查询）。响应体256KiB上限；信号覆盖请求和流，取消会释放 reader 与 timer。Code=Ok、匹配号码、真实 RequestId/SerialNo 完整才认同步受理；超时/断连/内部异常或部分批量受理不能自动再发。外层 Error 和逐号码 SendStatus 的 InternalError 或缺码均按 unavailable/unknown；批内任一受理不明不会被后续明确拒绝覆盖，只有全部明确拒绝才为 not_accepted。服务商原 Message 与 PhoneNumber 不进入错误/日志；保留有限官方错误码与真实追踪号。

## 3. 两个日任务

仅落地既有 `notify.sms_keepalive`、`notify.sms_balance`，每日10:20，job 模式，P3，单次，原 timer.result 保存受控摘要；不建 job_run。Worker 的 buildWorkerServices 与 services/runtime worker 分支创建各自健康服务，经实际 createNotifyAssembly 的 copy 绑定这两个 job；数组与 kind lookup 指向同一闭包。没有全局最后绑定。close 先拒绝新工作、中止自身 I/O 并等待认领/最终结算，再关闭自己的连接；原 siblings、循环和租约保留。

保活遵守全局 notify.sms.enabled、原 notify.window.start/end、notify.sms.keepalive_days、notify.sms.daily_cap 和 notify.test_recipients。只接受配置中启用员工的合法内部测试号；缺号、密钥、驱动、关闭开关或不在窗口均受控跳过。active notice 模板距上次同步成功（没有则距配置更新时间）达到间隔才候选，verify/disabled/pending_carrier/suspect 不发。测试值均固定；批准长度装不下测试值时跳过，不缩短。

唯一键为 `sms_keepalive:<执行日Asia/Shanghai>:<template_key>`。每次认领按自然键排序锁既有 verify_code 与实际模板行，缺种子受控不发送，与普通 direct/场景 SMS 原技术锁协议相同；不新增咨询锁。以即时执行日和 paramsAt 核对当时窗口、日cap、内部号、员工状态、模板和间隔。有效未开始的本日预约已占同号日额度；过期认领不能 start，可释放其他发送名额，但同日唯一键仍保留。start/settle 仍各是独立短事务，按同模板排序→本 delivery 锁，再取真实当前时钟；start 复核原选中的 active 员工、内部号、配置、窗口与五日间隔。短事务认领 attempt1、30s lease、call_started_at=NULL、HMAC目标与 mask；发前守卫通过后，再按真实 id/attempt/status/有效 lease/未开始条件用短事务写即时 call_started_at，成功后立即事务外发一次。标记失败不调用；发前守卫失效取消。成功才更新对应未变的模板 lastOkAt；迟到结果不覆盖。自己至多100条/轮的过期sending区分未开始的 claim_exhausted 与已开始的 unknown_outcome，两种均不自动重发，同日唯一键保留。正文、验证码、手机号明文不入投递表。

失效判断：30天内最近至多10个 call_started_at 非空的真实发送终态（成功、provider_rejected 或 unknown_outcome；不含发前守卫拒绝/claim_exhausted），非空即计算失败率，严格 >50% 或最新连续5失败触发 suspect/alerts.raise；0样本无比率，正好50%不触发比率，连续5仍可单独触发。窗口是实现选择，没有额外最低样本门槛。固定告警键 `notify.sms_suspect`，P3，dimension=templateKey，detail={templateKey,criterion:"5_consecutive_or_recent_gt_half"}。告警口使用既有端口；W2-24真实外部告警尚未合流时不声称外部告警完成。

余额任务诚实返回 unsupported（或缺驱动/关闭/取消摘要）、queried=false；不发查询、不返回假0或无限、未登记余额阈值。配置驱动且开启时，通过既有 Alerts 一次报告固定规则 `notify.sms_balance_unconfigured`，P3，无dimension，detail={outcome:"unsupported",reason:"complete_package_scope_and_threshold_unconfigured",queried:false}。两规则的键、严重度和有限事实已移交W2-24；告警端口调用不代表外部到达。本轮不会新增 notify.sms.balance_threshold。

## 4. 官方事实与外部未验

获取日期 **2026-10-08**，官方primary：[SendSms](https://cloud.tencent.cn/document/api/382/55981)、[官方TC3 SMS Node demo](https://github.com/TencentCloud/signature-process-demo/blob/main/services/sms/signature-v3/nodejs/demo.js)、[错误码](https://cloud.tencent.com/document/api/382/52075)、[SmsPackagesStatistics](https://cloud.tencent.cn/document/api/382/55964)、[数据结构](https://cloud.tencent.com/document/api/382/52068)。固定签名期望来自独立 Python hashlib/hmac 对官方算法/公开虚构凭据/固定时间与官方同序 payload 的计算，非被测函数自产。

SmsPackagesStatistics 确实存在，但 BeginTime/EndTime 是套餐**创建**窗口，yyyymmddhh、小时精度，EndTime>BeginTime且早于当前时间。官方页未声明最大跨度；不能由此推定任意历史都保留或完整。Limit≤500、Offset分页，查询必须覆盖业主已确认的完整历史并拉完全部页，校验 PackageEffectiveTime/PackageExpiredTime/PackageType；CurrentUsage 是查询时观察值，页面没有事务快照或强一致/延迟保证。创建窗漏掉的、未生效或过期的包不能冒充当前可用量，使用量与时间点也不能省略；它不是人民币账号余额。当前没有账号全量范围、权限与正式阈值证据，故不实现虚假的总余量阈值告警；本地统计 wire 测试仅证明真实 Action/字段格式，不证明账号余量。

官方验证码模板变量至多6位纯数字；实际 staff 激活码仍为8位字母数字，真实驱动在外呼前 rejected，console local/test 原样。本包不改码、不截断、不改冻结模板种子或verify枚举、不转通知模板绕限制。需 W2-03/W2-17/业主继续解决外部选型与审批偏差，真实员工激活短信未闭环。

官方通知变量新/长期闲置账号默认至多6字符，具体账号以控制台为准，官方另列通知/营销模板不支持变量的错误。九个业务模板及参数配置不能据本地fake测试推定获批。真实签名/模板/内部号/密钥、一次授权发送、同步受理与到达/失败回执、套餐全量与阈值监测均保持外部未验，由业主提供脱敏事实后继续，不在本开发会话发真实短信。
