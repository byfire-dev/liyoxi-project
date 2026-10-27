# 预发小额系统退款（W4-09，本地代码完成）

系统退款领域专口、实际任务装配及体验版付款入口CLI已完成本机最小定点验证；健康/发货与首错告警也已分片合入，W4-09代码与本机定点完成，真实外部事项仍pending。系统退款调用者必须消费 `loadEnv` 的实际 `APP_ENV` / `STAGING_PAY`，并使用 `stg.pay.autorefund` 的真实 system 身份；缺配、空名单、非 stg 均拒绝，名单不是启用任务的开关。

`createStagingRefunds(deps).refundOrder(ctx, orderId)` 每阶段回读真实订单与可信收款：仅明确名单内主体、`TFK` 付款单、1..100整数分、微信已入账且履约完成的开通/续费单，渠道成功满10分钟。首次申请复用原窗口报价，拒绝已用/升级/窗口外/已有退款或需红票的事实。新ops任务按envs仅stg登记；实际run索引同样仅stg构造，生产双排除已通过本机实际装配反例验证，未以领域权限守卫替代。

`staging_pay_refund` 复用原退款审批生命周期、SLA及领域状态链。真实 system 提交和决定，来源 `staging_probe`，原因保持结构约定的 NULL；不构造员工或勾选人工确认。提交事务账户最后锁，决定另开事务。原人工 `plan_refund`、step-up、确认、审批/执行人分离继续保持；Saga 人工执行/重试/确认未受理口明确拒绝新系统来源。

执行由原三段式 Saga 创建真实 `refund_txn`、原商户退款号、权益回收、审计/事件与受控轮询，只有建立意图时才记录 `is_executed_by_system`。共同保留可退余额、原路与发票守卫。缓存之外仍以永久系统申请和 `executeIntents` 找回原交易，关闭或完成的申请不自动新建。

未知结果先查询同一个 `out_refund_no`。恢复不能因为旧幂等缓存仍在而跳过当前名单/环境/金额/前缀检查。系统轮询只有渠道明确 `refundNotFound` 才能按原30秒间隔、至多两次自动提交预约补送；一般错误只保留未知与查单，不增加重试上限或另造退款号。人工原轮询路径不变。

当前新增 `writer.test.ts` 源码覆盖1分/100分真实PG与公开假Provider链、真实系统审批历史、永久去重、三保护/时间/配置拒绝的零渠道与零写，以及丢应答恢复与撤销名单。另补系统待执行申请经原人工线下入口明确拒绝且零业务写的反例。Node24、单worker/session=w409sys1下10个新增目标首次全绿；原人工线下登记相邻目标1绿/14未选，services类型一次通过。只用公开替身与隔离PG；不重跑其它已绿集。实际组装、扫描/并发任务及完整装配反例的后续结果见下文，不代表真实资金验证。

## 体验版支付入口CLI（本机定点通过）

`pnpm stg:pay-qr` 只从标准输入读取JSON，凭证不要放命令参数、聊天或shell history。用权限0600的本地私有文件重定向输入；输出目标必须是不曾存在的绝对路径，命令以0600独占创建，不覆盖已有文件。不要通过此命令改价、自动同意协议或模拟支付成功。

输入结构为 `{ "outputFile": "/绝对路径/本次入口码.png", "request": { "sessionToken": "现时老板opaque会话", "entityId": "真实主体UUIDv7", "storeId": "真实启用门店UUIDv7", "client": { "platform": "android", "appVersion": "当前体验版版本" }, "purchase": { "planId": "正式套餐UUIDv7", "months": 1, "expectAmountFen": 1, "agreementVersionIds": ["本人已阅读并明确同意的现行协议版本UUIDv7"] }, "idempotencyKey": "本次意图固定键" } }`。这些示意字符串不能作为真实输入；价格与协议均先从已有商家报价/协议界面确认。CLI再读真实同源quote，同TX以原创建写者校验金额、归属、协议与价目变化；需要重试时保留同一次body/幂等键，不能换键掩盖未知结果。

前置：实际 `APP_ENV=stg`，主体属于已解析的 `STAGING_PAY_ENTITY_IDS`，微信与支付配置完整且AppID一致，真实购买策略允许该设备/主体使用微信渠道，W4-07正式已生效价目令开通或同档续费的应付为1..100整数分。缺合法价目时受控拒绝，不自动改价；升级/降级/积分包不冒充可自动窗口退款的探针。`Plan.scope=entity`在V1.0只声明不写，白名单之外不可见须通过现有正式finance购买策略的entityIds首匹配与其余hidden配置完成，本命令不配置策略。正式单号仍由现有预发BizNoIssuer产生TFK；旧普通open单/金额类型不符在同TX协议写入前拒绝。

成功输出付款单ID/单号/整数分/到期时间、码的contentType和文件路径，不含session/openid/预支付签名。它是固定 `sub/order/result/index` 的体验版小程序入口码，scene仅32位UUIDv7 hex；不是Native支付二维码。扫码者须使用该主体老板账号，由原付款结果页检查真实actions/策略并点击“继续微信支付”，届时才调用原预支付公口和微信确认付款。命令本身不扣款、不入账、不标成功。小程序实际上传、真机扫码及真实资金回调/自动退款尚待业主外部验收。

开发入口为根目录`pnpm stg:pay-qr < /绝对路径/私有输入.json`；已有构建的镜像入口为`node apps/worker/dist/staging-pay-qr.js < /绝对路径/私有输入.json`。两者均不接受命令参数；退出0表示入口码已保存，1表示参数或业务拒绝，2表示环境/执行/输出或关闭失败。需要重试时保留原body与幂等键，并选择不存在的输出路径。

2026-10-19已完成worker入口5目标与weapp scene解析1目标，共6个独特目标，以及services/API/worker/weapp类型和worker构建；ROOT唯一源码/取消回滚/scene/重放标记增量审已闭环。2026-10-26复用这些结果，普通同步已独审的主干类型循环修复；该修复的正式depcheck零违规。未重复业务绿集，不把旧临时日志当作现存证据。其后支付回调首错独立前置已实际合入main `29d8af05`：四个真实Hono/PG/AlertFacts目标通过，含SIGNTEST零告警与T1′成功200零首错P1。真实微信/退款/发货、E5/V13账单与服务器事项仍pending。

## 自动退款实际任务装配（本机定点通过）

新增装配源码：ops拥有`stg.pay.autorefund`，每5分钟job；billing登记system kind且仅stg存在，RefundAssembly/API runtime/独立worker组合根各自绑定typed配置。生产构造不含job登记或实际run键，shipping各scope/关闭行保留。空名单返回disabled且零扫描/业务写/渠道调用；非空每期最多100单，真实成功满10分钟及名单/TFK/金额预筛后仍由writer重验。出错候选后排（内存上限1000，仅排队），不可退业务条件计skipped，未知故障隔离后本期失败，不把失败吞成成功。已执行/关闭申请不由扫描另起现金意图，仍交原rf.poll。

job要求运输取消信号与runTx；进入/提交业务事务前以及调用退款/查单方法前核取消，关闭本实例同步中止后续动作。恢复权威仍是永久业务行，不依赖内存集合。

实际装配7个独特目标已通过：三环境实际缺项、空名单/取消/close、API处理重放、正式worker job及两真实PG owner竞争3轮。首轮4绿3红来自新测试误读静态契约isJob，改查实际任务表后只复验3红通过，生产不变。services/API/worker类型各首次通过，官方registry生成零tracked差异，depcheck零违规；失败遗留库仅按本session官方清理。没有执行真实环境启动自检或真实配置/微信/资金/服务器验证；实际装配、CLI及首错告警已本机闭环，外部事项按[本地代码收尾](../../../../../docs/plan/changes/W4-09-local-code-close.md)独立保持pending。
