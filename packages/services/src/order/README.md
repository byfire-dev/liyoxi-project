# order：订剧报价与原子建单

W1-15a 交 `m.order.quote`、`m.order.create`；W1-15b 待 a 合 main 后补选剧单与读侧 12 条。公开入口为 `createOrderService`、`OrderActor`、`OrderDeps`，API 只转交真实商家身份、当前门店和 `idemOf`。

阅读顺序：`checks.ts` / `accounts.ts` → `quote.ts` → `submit.ts` → `read.ts` → `register.ts` / `invariants.ts`。契约在 contract 的 m04 `order.schemas.ts`，完整 `OrderDetail` 与 C50 首响应/重放从 a 起共用。

## 报价

报价不锁账户、不推进周期、不写业务行或同意证据。生效权益和钱包来自 billing 的公共只读函数；逐部 HALF_UP 复用 shared/pricing，分摊预览复用 shared/alloc。退款处理中可花积分为 0，分摊为空、短缺为整单应冻数。档案、闸门、行业、账号和可订判定与提交同源；业务错误进入 blockers，请求形状错误仍拒绝。不存在的剧不捏造卡片，而返回对应 blocker 与空的逐部报价。发布配置缓存先在事务外读；当前开放广告位在事务内按实际参数求交集；图片签名在事务结束后。

渠道账号只读本域需要的 channel_account 列，不 import publish。查询先限定门店（保留解绑以区分 not_available），展示排除解绑；每个平台至多 1 个、只有 available 可选，选中顺序保留输入顺序。

## 同一事务

1. 幂等登记后按实际 entity100 → entity_member120 → store130 锁定；重核老板成员与当前档案、闸门、行业、订阅、账号、许可、素材/广告和上线日。
2. 预生成订单/项 id、LYX 单号与 immutable 整单账本标题；公共 Docs 在真实 Tc 追加同意证据。
3. 按请求顺序逐部调用真实 `billing.hold`，只传 `{kind: 'drama', dramaId, topModel}` 与该部 expectS；第一次 hold 才取得账户420锁，计价、周期推进、批次和操作键都归账本。
4. 捕获 QUOTE_CHANGED / POINTS_INSUFFICIENT 两种纯应用拒绝时，在已持有账户锁和账本时刻读取整单真实报价；不足余额加回本次已冻部分，使 details 使用提交前余额与 ΣS。向外抛错让幂等、同意、账本和整单全部回滚。其余异常原样抛出。
5. 首次 HoldResult.now 的复制为 Tf。再次核对不可变标题用到的 P/R/T（即使变化抵消为相同 S 也拒绝），并在公共 currentVersions 的真实 Tv 晚检协议版本；标准 stale 整笔回滚。Tc/Tf/Tv 不保证相等，既不回填证据也不预锁账户。
6. 以 Tf 插完整订单/项/账号行，fresh `created:true` 初始迁移的专用 Flow 仅把时钟适配为该真实 Tf，仍依赖实际 assembly/events；普通后继迁移继续用 runtime.clock。逐项与整单产生历史/审计，清理本次选剧单，full 闸门 arm 真正 scheduled 的 order.start，最后发唯一 order.submitted。parallel 不 arm，子状态 qualification_reviewing。

本包只 freeze，不 capture、不建 placement/工单。首响应提交后签海报；幂等持久结果及重放 `items[].posterUrl` 为 null，重放不再签发。

## 移交

- `profile.order_manager_sync` 已实现：调用方先持 store130，本端口再按 UUID 顺序锁未结 orders160，按明确 input.staffId 改写、返回实际 count。同值返回 0，结束/取消/已退单不改；不读取旧门店经理来猜目标。
- order.start 的契约 kind 已存在，arm 不要求业务 handler。本包真实登记 scheduled；W1-17b 必须登记 critical / rearmAfterSkip、实现开工与补偿扫描，不能把 a 的登记当作处理器已落地。
- 待办/售后/授权书/履约字段为已登记留桩。order.submitted 是 analytics 目录的 outbox 来源，M7 的 analytics.fromOutbox 尚未实现；不重复直记 order_submit 或声称已有 analytics 行。通知 orderForNotify 公共读端口尚为空。
- b 复用完整 DTO 和 read.ts，再补常规列表/详情与已开工读侧。a 的 pointsEvents 验收覆盖实际冻结流水，后续 capture 的套餐/加购消费分拆由履约读侧补齐。

## 验收

公开测试前置在 `@liyoxi/services/testing` 的 prepareOrderFixture，接受真实 prisma / runtime.order / api.clock 及 API 已建主体、门店、老板，准备真实档案、订阅入账、账号、许可、协议；私有服务 harness 复用其档案/剧/协议准备。没有在应用测试跨入领域私有夹具。

`src/order/quote.property.test.ts`：种子 115、116、117，各 200 轮真实库；三部逐次 HALF_UP、真实 expect 提交、套餐+加购预览与 hold 分摊。
`src/order/submit.concurrency.test.ts`：5 条独立连接、k=3 的 20 轮 n>k；同键两连接；实际账户锁 3–4 秒 ACCOUNT_BUSY。
`submit.test.ts` / `guards.test.ts` / `quote.test.ts` / `manager.test.ts` / `invariants.test.ts`：全/并行副作用、整单变价/同S标题变化、真实周期切换、跨零点 Tc/Tf、Tv 协议变化、16 守卫、只读边界、真实同步数及已登记 full 不变量。API 的 order.test 与 clerk 回放验证实际鉴权和 C50。
