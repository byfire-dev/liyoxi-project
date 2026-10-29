# M4 支付与回调安全走查

- 日期：2026-10-27。走查对象：本地main `2f5b91652497fc41914732ee331502c97e784582` 的Git对象，避免把并行未提交内容带入结论。
- 依据：[08计划§10.2](../../08-development-plan.md)（`docs/08-development-plan.md:1006`）要求M4做支付与回调安全走查。本报告是该里程碑的专项只读结论，不替代各PR业务审查、当前CI或真实渠道验收。
- 先查已有记录：W4各包状态/变更及M4回顾有验签、并发、权限和脱敏的分项审查证据，但未找到可直接引用的独立“M4支付与回调安全走查”结论。因此补查下面几条跨包边界，未重复全部PR审查。
- 方法：阅读实际生产入口、Provider、回调收件、入账/退款及管理资金守卫，并对照既有测试断言；未运行测试、类型、构建、安装、生成或网络操作，未读.env、真实证书或密钥。读取的密码学材料仅为入库的公开合成测试夹具。

**结论：本次范围内未发现需要修复的实质安全漏洞，未发现P1/P2阻断项。** 未见未验签报文能写入资金、错误商户/主体能借回调入账、原单号重放重复履约/退款、后台资金操作绕过权限或自批守卫的可达路径。该结论限于所列源码与既有反例，不能表述为真实支付、云端配置或外部安全验收已通过。

## 1. 验签、解密与签名原文

核到HTTP在IP限流后流式读取最多1MiB原始字节，再交验签；为下游恢复的是同一串字节，不解析重序列化后验签。签名前置槽只准备上下文，OpenAPI解析在后；未经成功prepare的对象不能直接进入accept。

Provider按四头、已配置serial身份、RSA-SHA256原文签名、±5分钟时间窗、外层结构、AES-256-GCM认证解密的顺序判别；密文篡改/未知密钥返回失败。SIGNTEST只标记失败探测，不会变成可信事件。密钥轮换按实际kid恢复旧收件，不靠重新信任明文。

- 源码：[HTTP原文读取](../../../apps/api/src/http/webhook.ts)（`apps/api/src/http/webhook.ts:62`）、[限流后prepare](../../../apps/api/src/http/webhook.ts)（`apps/api/src/http/webhook.ts:103`）、[同实例验签结果约束](../../../packages/services/src/security/webhooks/runtime.ts)（`packages/services/src/security/webhooks/runtime.ts:334`）。
- 密码学：[签名串](../../../packages/services/src/providers/wechat-pay/sign.ts)（`packages/services/src/providers/wechat-pay/sign.ts:31`）、[验签到解密顺序](../../../packages/services/src/providers/wechat-pay/notification.ts)（`packages/services/src/providers/wechat-pay/notification.ts:50`）、[GCM认证标签与AAD](../../../packages/services/src/providers/wechat-pay/keyring.ts)（`packages/services/src/providers/wechat-pay/keyring.ts:74`）。
- 既有反例：[改正文/时间戳/nonce、重序列化、缺头、过期、错serial及错密钥](../../../packages/services/src/providers/wechat-pay/notification.test.ts)（`packages/services/src/providers/wechat-pay/notification.test.ts:188`）、[真实HTTP先验签及坏JSON零业务写](../../../apps/api/test/webhook-framework.test.ts)（`apps/api/test/webhook-framework.test.ts:117`）。

## 2. 订单、商户、主体、付款人与金额归属

商家预支付、sync/cancel要求当前owner成员关系，订单按当前主体查找；付款openid来自当前会话。支付金额、attach和原付款单号取持久化尝试，不由HTTP调用者自由覆盖。

支付回调处理再次核AppID/mchid，只匹配已存在、有关联且为wechat_jsapi的交易；未知单号不会凭通知虚造付款单。资金事实入口核outTradeNo、渠道流水唯一、成功时间和整数分；apply在锁后重读订单/主体/渠道，金额或付款人/attach不符只开差异，不给权益。

- 源码：[owner及当前会话付款人](../../../packages/services/src/billing/payment/wechat-prepay.ts)（`packages/services/src/billing/payment/wechat-prepay.ts:40`）、[发给渠道的金额来源](../../../packages/services/src/billing/payment/wechat-prepay.ts)（`packages/services/src/billing/payment/wechat-prepay.ts:270`）、[sync/cancel当前归属](../../../packages/services/src/billing/payment/wechat-channel.ts)（`packages/services/src/billing/payment/wechat-channel.ts:45`）。
- 入账：[回调来源与既有交易](../../../packages/services/src/billing/payment/channel-webhook.ts)（`packages/services/src/billing/payment/channel-webhook.ts:110`）、[渠道事实校验](../../../packages/services/src/billing/payment/channel-success.ts)（`packages/services/src/billing/payment/channel-success.ts:95`）、[金额及付款人差异](../../../packages/services/src/billing/payment/apply.ts)（`packages/services/src/billing/payment/apply.ts:132`）。
- 既有反例：[同公钥/密钥但错误AppID的有效签名通知仅ignored、资金不变](../../../apps/api/test/billing-channel.test.ts)（`apps/api/test/billing-channel.test.ts:292`）、[金额矛盾不履约且不覆盖旧流水](../../../packages/services/src/billing/payment/channel.test.ts)（`packages/services/src/billing/payment/channel.test.ts:459`）。

其中，可信签名但错来源返回200并记ignored是既有协议行为，不表示认可该资金；本次核的是其后无资金/权益写入，不能把这条200误记为安全绕过。

## 3. 重放、事务入账与未知结果

收件按provider+eventId去重并锁行，终态重复不再运行handler；T1收件与领域处理在同一事务内。T1失败只能在独立T1′持久保存密文收件后ACK200，否则返回失败，不在无法持久化时伪成功。

apply以订单、付款行锁和appliedAt阻止重复入账，履约走同一事务和唯一业务opKey。普通写幂等同时绑定operationId、actor和请求hash；同键异正文明确拒绝，不把另一个主体的结果作为本次结果。

- 源码：[收件唯一键与锁](../../../packages/services/src/security/webhooks/runtime.ts)（`packages/services/src/security/webhooks/runtime.ts:222`）、[T1及T1′](../../../packages/services/src/security/webhooks/runtime.ts)（`packages/services/src/security/webhooks/runtime.ts:368`）、[apply重读及已应用返回](../../../packages/services/src/billing/payment/apply.ts)（`packages/services/src/billing/payment/apply.ts:38`）、[入账/履约同事务路径](../../../packages/services/src/billing/payment/apply.ts)（`packages/services/src/billing/payment/apply.ts:181`）、[幂等绑定与冲突](../../../packages/services/src/kernel/idempotency.ts)（`packages/services/src/kernel/idempotency.ts:159`）。
- 既有反例：[真实通知重放收件数和资金不变、履约仅一次](../../../apps/api/test/billing-channel.test.ts)（`apps/api/test/billing-channel.test.ts:323`）、[真实锁等待T1失败/T1′200及后续入账唯一](../../../apps/api/test/payment-callback-alerts.test.ts)（`apps/api/test/payment-callback-alerts.test.ts:233`）；真实竞争与性质证据索引见[V18](../external-verification/v18-ledger-tests.md)（`docs/plan/external-verification/v18-ledger-tests.md:24`）。

ACK200表示已接收或持久排队，不表示资金一定已入账；这一区分在fallback反例中有明确断言。

## 4. 退款可信事实与三阶段恢复

退款通知共用正式密码学Provider，再核mchid、事件/状态和成功时间，按已存在outRefundNo查退款交易。结果入库重新锁审批、退款申请、原付款与退款行，核原付款单号及唯一渠道退款号；非本单或未来成功时间拒绝。成功终态不被旧processing/失败覆盖，同结果重放不重复累计；可信金额异常单独留差异，不静默改写原申请金额。

执行要求required幂等；预检查及claim都重做授权，固定退款意图映射到原交易/原outRefundNo。外呼在事务外，settle回读当前事实，提前到达的回调成功不会被旧提交响应覆盖。未确认受理保持未知并查原号，不因普通网络404放弃。

- 源码：[退款通知校验](../../../packages/services/src/billing/refund/webhook.ts)（`packages/services/src/billing/refund/webhook.ts:37`）、[归属、渠道号与重放](../../../packages/services/src/billing/refund/result.ts)（`packages/services/src/billing/refund/result.ts:159`）、[同号外呼及旧响应保护](../../../packages/services/src/billing/refund/saga.ts)（`packages/services/src/billing/refund/saga.ts:160`）、[授权与持久意图](../../../packages/services/src/billing/refund/saga.ts)（`packages/services/src/billing/refund/saga.ts:218`）。
- 既有反例：[回调先于提交响应及中断重放](../../../packages/services/src/billing/refund/saga.test.ts)（`packages/services/src/billing/refund/saga.test.ts:104`）、[真实并发执行三轮](../../../packages/services/src/billing/refund/saga.test.ts)（`packages/services/src/billing/refund/saga.test.ts:263`）、[可信未受理与网络404区分](../../../packages/services/src/billing/refund/saga.test.ts)（`packages/services/src/billing/refund/saga.test.ts:293`）、[跨单/未来时间拒绝与金额差异](../../../packages/services/src/billing/refund/saga.test.ts)（`packages/services/src/billing/refund/saga.test.ts:344`）。

## 5. 后台资金权限、数据范围与异人审批

后台会话、同源Origin及X-LYX-Admin、模块/权限、step-up均在资金处理前装配。财务退款审批/执行、对公确认、差异处理、财务配置提议/批准登记了再次验证。领域还检查身份与当前员工、对象scope、版本和确认回显；不是只靠按钮隐藏。

公共审批拒绝发起人/实际提交人自批，super_admin也不例外，并重读员工、范围和审批版本。退款执行人必须与批准人不同只在既有require_distinct_executor参数开启时强制，本报告不把它说成所有退款固定三人。线下确认及复核均不能是开单人。积分调整、延长及财务配置使用公共审批；银行配置经批准后延迟24小时生效，账号密文保存、输出脱敏。线下退款还核当前员工本人上传的已存储回单、类别和主体，并封存收款账号。

- 通用边界：[中间件装配](../../../apps/api/src/routing/pipeline.ts)（`apps/api/src/routing/pipeline.ts:81`）、[CSRF](../../../apps/api/src/http/admin/csrf.ts)（`apps/api/src/http/admin/csrf.ts:47`）、[实际step-up](../../../apps/api/src/http/admin/authz.ts)（`apps/api/src/http/admin/authz.ts:62`）、[财务权限登记](../../../packages/contract/src/authz/permissions/finance.ts)（`packages/contract/src/authz/permissions/finance.ts:6`）。
- 审批/退款：[自批拒绝](../../../packages/services/src/approval/decide.ts)（`packages/services/src/approval/decide.ts:151`）、[退款当前员工和scope](../../../packages/services/src/billing/refund/context.ts)（`packages/services/src/billing/refund/context.ts:33`）、[退款通过与回显](../../../packages/services/src/billing/refund/index.ts)（`packages/services/src/billing/refund/index.ts:69`）、[执行人参数及金额守卫](../../../packages/services/src/billing/refund/saga.ts)（`packages/services/src/billing/refund/saga.ts:43`）、[线下退款文件及密文](../../../packages/services/src/billing/refund/offline.ts)（`packages/services/src/billing/refund/offline.ts:22`）。
- 其他资金操作：[开单人与确认/复核人分离](../../../packages/services/src/billing/payment/transfer-review.ts)（`packages/services/src/billing/payment/transfer-review.ts:100`）、[积分审批重验](../../../packages/services/src/billing/adjustments/kinds.ts)（`packages/services/src/billing/adjustments/kinds.ts:138`）、[延长同组权限](../../../packages/services/src/billing/adjustments/kinds.ts)（`packages/services/src/billing/adjustments/kinds.ts:236`）、[财务配置异人与24小时](../../../packages/services/src/billing/finance-config/index.ts)（`packages/services/src/billing/finance-config/index.ts:112`）、[账号密文投影](../../../packages/services/src/billing/finance-config/index.ts)（`packages/services/src/billing/finance-config/index.ts:160`）。
- 差异处理：[真实权限及scope预检查](../../../packages/services/src/billing/payment/exceptions/resolve.ts)（`packages/services/src/billing/payment/exceptions/resolve.ts:23`）、[矩阵/版本/核销额外权限](../../../packages/services/src/billing/payment/exceptions/state.ts)（`packages/services/src/billing/payment/exceptions/state.ts:11`）、[关联目标主体和金额](../../../packages/services/src/billing/payment/exceptions/resolve.ts)（`packages/services/src/billing/payment/exceptions/resolve.ts:55`）。
- 既有反例：[退款HTTP权限/旧验证/旧版本/错金额](../../../apps/api/test/billing-refunds.test.ts)（`apps/api/test/billing-refunds.test.ts:170`）、[线下四路由守卫零副作用](../../../apps/api/test/billing-transfer-review.test.ts)（`apps/api/test/billing-transfer-review.test.ts:316`）、[调整自批/版本/回显零写](../../../packages/services/src/billing/adjustments/approval.test.ts)（`packages/services/src/billing/adjustments/approval.test.ts:29`）、[配置异人/密文/24小时](../../../packages/services/src/billing/finance-config/approval.test.ts)（`packages/services/src/billing/finance-config/approval.test.ts:33`）、[差异权限/step-up/scope零写](../../../apps/api/test/billing-exceptions.test.ts)（`apps/api/test/billing-exceptions.test.ts:181`）。

系统预发退款是受控例外：要求stg、指定system job、显式名单、TFK、1–100分及真实成功履约事实，恢复时重查；人工入口拒staging_probe，不拿普通staff身份触发系统分支。[系统守卫](../../../packages/services/src/billing/staging-pay/guards.ts)（`packages/services/src/billing/staging-pay/guards.ts:8`）、[人工分支拒绝](../../../packages/services/src/billing/refund/saga.ts)（`packages/services/src/billing/refund/saga.ts:49`）。

## 6. 未认证回调失败、日志与凭据脱敏

未认证hook以渠道协议fail-closed：签名/时间窗/未知serial为401，未配置404，解密失败500；大包413、限流429。接口只回稳定错误符号，不回原文、私钥、密文或Provider原始错误。访问日志不记录请求体/全请求头，敏感查询键遮盖；Provider丢弃外部异常正文、底层错误和重定向，仅输出白名单错误摘要。

支付收件只保存摘要、密文和kid，openid不进入摘要；重新处理通过kid解密。首错P1只复制operationId、状态和去敏reqId，签名只用于探测分类，不持久化；告警写拒绝被接住，不能覆盖ACK或把真正fallback200误报首错。SIGNTEST仍拒绝且零告警，未放松验签。

- 源码：[渠道响应映射](../../../packages/services/src/billing/payment/channel-webhook.ts)（`packages/services/src/billing/payment/channel-webhook.ts:137`）、[访问日志字段](../../../apps/api/src/http/access-log.ts)（`apps/api/src/http/access-log.ts:24`）、[Provider安全错误及禁止重定向](../../../packages/services/src/providers/wechat-pay/client.ts)（`packages/services/src/providers/wechat-pay/client.ts:125`）、[回调持久化投影](../../../packages/services/src/billing/payment/channel-webhook.ts)（`packages/services/src/billing/payment/channel-webhook.ts:98`）、[最终响应告警白名单](../../../packages/services/src/security/webhooks/runtime.ts)（`packages/services/src/security/webhooks/runtime.ts:253`）。
- 既有反例：[Provider业务/网络/验签失败不泄原文](../../../packages/services/src/providers/wechat-pay/redaction.test.ts)（`packages/services/src/providers/wechat-pay/redaction.test.ts:98`）、[回调失败对象不含敏感内容](../../../packages/services/src/providers/wechat-pay/redaction.test.ts)（`packages/services/src/providers/wechat-pay/redaction.test.ts:159`）、[SIGNTEST拒绝/零告警](../../../apps/api/test/payment-callback-alerts.test.ts)（`apps/api/test/payment-callback-alerts.test.ts:159`）、[404/真实解密500及去敏落库](../../../apps/api/test/payment-callback-alerts.test.ts)（`apps/api/test/payment-callback-alerts.test.ts:193`）。

## 7. 发现与既有验证的使用方式

| 分类 | 本轮结论 |
| --- | --- |
| 实质漏洞/阻断 | 无。上述范围内未发现可达的验签绕过、跨商户/主体资金写、重放重复资金写或管理资金越权/自批路径；无需据本报告修改代码。 |
| 索引缺口 | 既有包审查分散在状态/V18；本文件补齐计划要求的一次M4跨包安全走查结论。 |
| 本轮测试结果 | 无新测试运行。引用测试均为实际断言的只读核对，不新增“本轮G”或扩大历史样本数。 |
| 已有通过证据 | [W4-02原验签/kid/脱敏及HTTP证据](../status/W4-02.md)（`docs/plan/status/W4-02.md:26`）、[退款及差异V18索引](../external-verification/v18-ledger-tests.md)（`docs/plan/external-verification/v18-ledger-tests.md:24`）、[首错4目标与真实Hono/PG证据](../status/W4-09.md)（`docs/plan/status/W4-09.md:99`）、[完整资金链/后台消费](../status/W4-19.md)（`docs/plan/status/W4-19.md:30`）。既有未变目标复用，不重跑旧矩阵。 |

## 8. 仍未知、不能借此关闭的真实外部验证

1. **真实支付信任配置：** 商户号/AppID关联、实际平台公钥或证书、APIv3密钥、回调地址、证书轮换及真实商户签名联调未由本轮验证。验签证书有效期不在keyring调用时检查，按现有配置轮换设计处理；本报告不把测试身份当作生产信任根核验。[现有设计](../../../packages/services/src/providers/wechat-pay/keyring.ts)（`packages/services/src/providers/wechat-pay/keyring.ts:34`）、[E5状态](../owner-checklist.md)（`docs/plan/owner-checklist.md:40`）。
2. **真实资金与渠道：** 小额实付、实际退款到账、真实发货受理/未知恢复、商户限额及真实账单口径仍待E2/E5/E13与V13；公开替身和本机真实数据库不能替代这些结论。[外部表](../status/W4-09.md)（`docs/plan/status/W4-09.md:111`）、[V13](../external-verification/v13-wechatpay-bill.md)（`docs/plan/external-verification/v13-wechatpay-bill.md:13`）。
3. **实际部署及接收通道：** 真实反向代理是否完整保留请求字节、TLS/域名/受控密钥注入、线上日志落地策略、P1接收/值班与邮件送达未核验；E4/E18/E20及演练仍须独立记录。[E4](../owner-checklist.md)（`docs/plan/owner-checklist.md:39`）、[E18/E20](../owner-checklist.md)（`docs/plan/owner-checklist.md:53`）。
4. **退出状态：** 本次专项走查不替代全部远端PR/CI、业主演示确认或M4外部验收，不据此打m4-done；M5与样片/授权签名不在本次走查范围。[W4-19边界](../status/W4-19.md)（`docs/plan/status/W4-19.md:18`）。
