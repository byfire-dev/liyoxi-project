# order：订剧、选剧单与订单读侧

## W5-05 订单后续事实

`order.adminQuote`只读取当前套餐价目、billing `priceAt` / `paramsAt` 与content可订提示，复用 `quoteDramaItem`；草稿/下架剧可试算，无价格返回null。`order.activityList`先按managedStore确认本单，再按本单真实订单项/工单/方案/样片/授权书/取消与审批对象读取ops/activity日志；游标绑定订单及(createdAt,seq)，不返回原始审计JSON，不写业务。

`order.onCalendarImported`持日历共享锁，按当前批次与计算窗口重算未完成广告首版/修改轮次、待执行取消时限并重排原sla.breach。`order.onLicenseShortened`只读当前版权修订及未结束订单，沿staff owned creator给当前可访问的内容运营与交付经理建立order_item系统待办，告警保留不可分派目标；订单止日与资金不变。同事务audit事实按当前revision/订单项/owner持久去重，用户内容不带技术键。

当前content写口仍拒绝shorten/改早correction。测试历史版权数据仅为初始条件，随后验证真实emit/expand/consume及待办list/complete，不表示缩短API已开放，不实现M6使用期writer。新机制定点为 `src/order/m5-facts.db.test.ts`；实际结果以W5-05状态页为准。

## 参考文件与终态留存补漏

现有 `referenceStoreAssetIds` 仍是唯一订购参考输入。提交在账户420之前按素材370、全部文件410整体排他预锁，再沿真实 `media.link` 为每个实际素材文件登记 `drama_order/reference`，素材使用记录仍按素材写入；文本素材没有文件时仅保留usage。底层文件不可用保留 `FILE_NOT_USABLE` 出口，任一link失败与资金、订单、同意和关联整笔回滚。不会将肖像授权材料加入参考文件。

`order.onReferencesClosed` 是本fix新增的1项M3关键订阅者（x01总订阅者34→35，M3 6→7），消费现有 `order.status_changed` 与 `cancel.executed`。它在出站消费自己的短事务回读真实父单终态和closedAt，按订单160→文件410整体锁定，仅释放本单当前live参考；未全终态不释放，重复消费不写业务行。取消事件通过真实申请明细定位全部父单，覆盖父状态事件被抑制的路径。保留基准为closedAt加90天，实际 `media.release` 继续按当前时钟最低期和已有keepUntil取最大值，迟到消费不会缩短留存；原素材引用或其他live引用仍阻挡清理。不新增扫描循环、不扩财务锁图。

`adminGet` 的参考文件投影以本单live `file_ref` 全集为准，复用W5-04已交付的media素材/文件、profile档案公口识别来源（素材usage优先，档案匹配包含已移除行）。未知来源不借档案分支签名；文本素材没有文件时仍只有usage。缩略图在事务外通过媒体公口签发，签名前后重读负责门店范围、本单引用、来源归属及文件/封面当前安全事实；当前不可读文件保留元数据、thumbnail为空，签名期间范围或事实变化拒绝旧URL。保留复制素材的crossStore政策，原文件和封面仍核各自真实范围；GET不登记引用、不写访问审计或取料记录。

定向验收源为 `src/order/reference-files.db.test.ts`：真实上传/素材创建、多素材交错UUID的全部文件、文本、跨店、底层拦截及真实link后故障回滚；三种终态、当前非终态拒绝释放、真实免审取消事件与重复零写。`apps/api/test/order-reference-files.test.ts` 走真实图片上传、素材创建、下单双关联、后台详情零写与缩略图、正式开工handler实际扣减、W5-04材料签发；另核已移除的历史档案引用及签名期间file/ref/scope变化。`delivery/materials.db.test.ts` 保留品牌素材A→B→C实际复制后本单取料的覆盖。验证结果以本fix实际PR/CI为准。历史usage缺file_ref回填与订单档案媒体producer缺输入约定均未实施；GET不补写、不自动复制档案。

## 统一取消执行（W5-01）

`createCancelExecution(deps).execute(actor, id, body, idem)` 是后台 `admin.cancelRequest.execute` 的用例入口，沿用唯一 `executeCancel` 事务叶，支持订单、广告与资质整店取消。执行前验证当前员工启用状态、真实权限、再验证和门店范围；C50 已有回执也先核当前授权。事务里预读、依全局顺序预锁并复读整张目标图，核审批关系、确认单号/退款数和全部明细最新报价；有任一变化整笔回滚，仅在独立小事务里为仍待执行的申请追加 `recheck.execute` 证据，原幂等键可重试。

交付、发布、媒体和员工模块各经所属公口关闭暂停/工单、补发与系统跟进、下载授权、发布清单与巡检，建立或保留必要下架核验，并失效已有 ZIP 和释放文件引用。新 ZIP、下载接口、广告 producer 不在此包。所有 owner 收尾先于首笔积分退回；`billing.release/refund` 使用原冻结单/取消明细操作键与真实账本规则。订单项/广告终态和实际 returned/converted/forfeited 在同次 UPDATE 落库，订单取消指针与派生状态也在同次迁移更新，满足数据库约束。已上线项仍保持 live，记录提前使用止日，待真实下架核验。

`resultSnapshot` 和完整 `CancelRequestDetail` 来自实际 ReturnResult，分摊预览保留在原快照。账本未返回实际逐批明细，因此结果 breakdown 的 `lots=[]`，不复制预览来冒充实际；三个去向数与 qty 为真实账本值。完整 DTO 在资金事务内组装并作为 C50 持久回执，`replayed` 仅在通用响应 meta。审批执行事实通过 `approval.execution_facts` 端口由 order 提供，approval 不反向读取上层表。

W5-01目标：`cancel-execute.property/concurrency/fault.test.ts` 共26条，覆盖六阶段、原路/转加购/作废、零退款、两个真实客户端各3轮、整笔故障回滚和幂等；`apps/api/test/order-cancel-execute.test.ts` 7条验证实际鉴权、stepup、范围、职责分离和C50。该机制测试保留当时尚未交付的W5-02上游审批快照；订单、开工、账本、方案/样片/制作及媒体检验均走真实公共服务与Provider协议。下述W5-02场景使用正式申请producer；W5-03/08只扩各自领域事实，不复制资金逻辑。

广告取消财务代撤（A15）：活跃发起人的广告已确认/取消且指针按库约束清空时，真实财务可在完整目标图预锁及再验证后撤回；owner 在关闭回调再次核终局事实。只从 order 公口建立真实事务上下文；直接泛 approval、缺预锁或关联错配严格拒绝，外来指针不清理。本人、停用发起人代撤及实际system失效路径不变；该A15补片本身未新增HTTP或M5 producer，正式取消入口见下节。

## 取消申请与资质后续（W5-02）

`createCancelRequests(deps)` 提供 `quote(actor, orderId, body)`、`create(actor, orderId, body, idem)` 和 `approve/reject/withdraw/void(actor, cancelRequestId, body, idem)`。报价复用原只读 `quoteOrderCancel`；写入回包在同一事务调用 `readCancelRequestDetail`，将完整DTO作为C50回执。命中回执之前仍复核当前员工、权限与范围；本人撤回/作废允许原发起人范围例外，审批与执行仍要求当前对象范围。所有回包沿原员工身份读取，系统免审不会扩大读范围。

人工创建只收三个原因；在真实父项/工单全图锁与账本账户锁内重算expect，逐个校验手动扣除依据及明确选择项。新审批、申请、明细由本事务创建，预分配ID先登记锁顺序，并发互斥由真实父行锁、指针与部分唯一索引保证。订单进入/退出after_sale时指针与状态在同一迁移UPDATE更新。客服关联通过组合根注入的 `orderSubmissionCompanion(serviceTicketId)` 两阶段拥有者公口处理；缺装配显式失败，service270锁位于账户420之前。

`orderCancelKind`、`qualificationCancelKind` 使用统一approval：真实版本、确认回显、自批与权限守卫先由框架判断，再做取消重校验。通过只记pending_execution与执行SLA；失败证据在完整事务回滚后单独追加。驳回跳过再验证，本人撤回无需再验证，代撤仍核启用状态/对象失效、财务权限及再验证；作废仅发起人。关闭只释放本审批来源的cancel_review，不清其他暂停，再推导父单，真实full闸门的待开工单恢复原order.start键。

免审批仅在开关开启、全部release且原批次全额退回时成立，由本事务真实system批准，并从同一 `executeCancel` 进入W5-01执行叶；没有模拟财务身份或第二套资金writer。中间after_sale不额外发订单状态事件，最终状态只发一次；每个非live取消项发与实际结果一致的cancelled/refunded/terminated事件。

广告沿原有父锁组合语义，不为本事务尚未创建的行追加逆序低锁；只有 `submitAdCancel` 在真实新行建立且免审条件命中后签发的私有事务见证，才能在唯一执行入口跳过本次新approval/request/line三行的锁。见证须逐ID吻合，且没有订单或额外审批目标；既有业务锁、重校验、账户和实际执行事实检查全部保留。Tx层对象失效的系统撤回/作废同样只认锁后真实事实，正常对象不能走此通道；HTTP用例始终要求真实员工。

`bindCancelRequests`为worker绑定真实依赖。资质订阅者在store130之前预读并取得staff20、approval30、cancel50、line60及后续全部业务锁，锁后重读当前轮次与目标图。终局只接受profile当前真实终局事实，系统代真实审核人生成整店申请，覆盖尚未被其他申请占用的待开工订购与未指派广告。非终局使用 `order.rejected_stale:drama_order:{id}:r{roundNo}`，在驳回时刻加参数自然日后提醒；处理器复核当前轮次、非终局结论、待开工与无在途取消，再发去重的 `order.rejected_stale`。新轮次、恢复资质或开工均跳旧提醒，绝不自动取消。

本地定点已覆盖 `cancel-requests.db.test.ts` 14项、`qualification-cancel.db.test.ts` 4项及 `cancel-read.db.test.ts` 4项；资格用真实profile提交/驳回事件驱动，七日通知沿真实runtime到在职客服主管，旧轮延迟消费零通知。受影响回归覆盖原广告核心128项、订阅者3项、三个连接20轮开工竞争；唯一执行另核正式kind注册后的提前recordExecuted拒绝与plan_confirm真实账本金额/订单项事件。失败修复只复跑对应场景，未重复原全矩阵；正式API与最终类型/分层由组合根验收。

W1-15a 交 `m.order.quote`、`m.order.create`；a 的 #91 已合主干；W1-15b 交选剧单与读侧 12 条。公开入口为 `createOrderService`、`OrderActor`、`OrderDeps`，API 只转交真实商家身份、当前门店和 `idemOf`。

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

提交入口只 freeze，不 capture、不建 placement/工单。首响应提交后签海报；幂等持久结果及重放 `items[].posterUrl` 为 null，重放不再签发。真正扣减与工单交给下述异步开工入口。

## 移交

- `profile.order_manager_sync` 已实现：调用方先持 store130，本端口再按 UUID 顺序锁未结 orders160，按明确 input.staffId 改写、返回实际 count。同值返回 0，结束/取消/已退单不改；不读取旧门店经理来猜目标。
- `order.start` 已登记真实 critical / rearmAfterSkip 处理器；下单、资质决定与补偿扫描仅 arm，处理器在每张单自己的事务内开工。
- 待办/售后/授权书/履约字段为已登记留桩。order.submitted 是 analytics 目录的 outbox 来源，M7 的 analytics.fromOutbox 尚未实现；不重复直记 order_submit 或声称已有 analytics 行。通知 orderForNotify 公共读端口尚为空。
- b 复用完整 DTO 和 read.ts，补常规列表/详情与阶段读侧。a 的 pointsEvents 验收覆盖实际冻结流水，后续 capture 的套餐/加购消费分拆及真实工单/方案内容由 W1-17 履约读侧补齐。

## 验收

公开测试前置在 `@liyoxi/services/testing` 的 prepareOrderFixture，接受真实 prisma / runtime.order / api.clock 及 API 已建主体、门店、老板，准备真实档案、订阅入账、账号、许可、协议；私有服务 harness 复用其档案/剧/协议准备。没有在应用测试跨入领域私有夹具。

`src/order/quote.property.test.ts`：种子 115、116、117，各 200 轮真实库；三部逐次 HALF_UP、真实 expect 提交、套餐+加购预览与 hold 分摊。
`src/order/submit.concurrency.test.ts`：5 条独立连接、k=3 的 20 轮 n>k；同键两连接；实际账户锁 3–4 秒 ACCOUNT_BUSY。
`submit.test.ts` / `guards.test.ts` / `quote.test.ts` / `manager.test.ts` / `invariants.test.ts`：全/并行副作用、整单变价/同S标题变化、真实周期切换、跨零点 Tc/Tf、Tv 协议变化、16 守卫、只读边界、真实同步数及已登记 full 不变量。API 的 order.test 与 clerk 回放验证实际鉴权和 C50。

## 选剧单与读侧（b）

`cart.ts` 对同一店的新增、删除与接受变价持咨询锁50；新增先查自然唯一行，已有项原 P 和加入时间不变，即使已满50或已下架也返回该行。当前 P 来自公开 content/billing 读侧，套餐仅影响逐部 S：只改折扣而 P 不变仍 valid。接受价格必须提交当前 P，失效卡片不可接受；同P不写 priceAckedAt。接受首响应事务后签海报，持久幂等结果与重放海报为空，重放不再次签名。物理删除按门店/主体归属校验，通过 required 幂等使原 key 重放继续返回 null。

`merchant-read.ts` 按当前老板门店和主体查询，商家订单号按完整值匹配。订单按提交时间降序，订单项按上线中、待上线、已结束三组分别以使用期结束日升序、约定上线日升序（空值最后）、提交时间降序排列，UUID升序打破同刻并列。`cursor.ts` 绑定过滤条件与门店/主体；不合法或换条件的游标按 C42 回首屏。真实 SQL keyset 分页不会先取全表再切片。快照标题/标价/折扣/加扣保留订购时事实，当前渠道账号名称/UID/type 只读查询。remainingDays 只在 live 返回 max(0, 使用期结束日减北京今日)，其余阶段为 null。

`admin-read.ts` 与三个 defineAdminHandler 的 order:view、真实 all/group/own DataScope 接线；订单范围仅按负责门店，剪辑/发布任务不会额外扩大范围。页码默认20、上限100，三种排序均以 UUID 打破并列。summary 接同一筛选（不含tab），列表与总数取同一条件。下单日期按北京自然日双端包含；“只看资质驳回超期”取该门店最近一次真实 qualification rejected decidedAt，严格超过实时参数天数，false 不作此限制。详情复用已校验归属的公共账本流水读侧，不写资金、审计、状态历史或派生记录。

`counts.ts` 的公开 `countCartBadge(tx,storeId,at)`、`countOrderItemsByPhase(tx,storeId,orderId?)`、`countOpenOrdersByEntity(tx,entityId)`、`countBlockingStoreOrders(tx,storeId)` 为纯读。前者过滤下架、许可失效与非正价，显式接调用方时刻，空集合返回0；实体未结数排除 ended/cancelled/refunded，门店停用阻挡数只含 pending_start/producing/to_launch/after_sale。当前 tenant 尚无 StoreCloseGuard 注册口，交真实计数供后继接线，不声称停用守卫已落地。`register.ts` 的 order MerchantFacts 返回实际 live/producing+to_launch/cart，待办仍 M7 的0。商城首页三数量与详情 cartItemId 已回补，店员/游客裁剪保持。

b 的完整 AdminOrderDetail 声明参考素材、售后、授权书、工单/方案后继字段；参考素材/售后/授权书为登记过的空数组或0，工单/方案为null。openCancelRequest 卡片只读已存在的真实行，actions 在未有取消实现前为空。read.ts 的 detail 参数仅需 membership 的 storeId/entityId，后台在已完成实际 DataScope 归属判断后复用；未替换履约时间轴，W1-17 可普通同步后续接线。

b 目标验收：`cart.test.ts`（两独立真连接49→50/51、P/S、自然重复、C50、跨店与店员）、`read.test.ts`（八状态、三组稳定分页、北京日期、最新驳回阈值、真实计数与零资金写）；API `order-read.test.ts` 覆盖12处理器及商城三事实、clerk全回放保留原黄金，admin矩阵只增本包3条。

## 原子开工与触发点（W1-17b）

`startOrder(tx,deps,id)` 先预读待开工/full/无在途取消，再把两池候选和现有经理按 UUID 升序取员工共享锁，锁后重验并调用真实分配口。先锁门店及指派可能同步的未结父单、项、工单，首次经理指派在账户锁之前完成。M1 的池仍按工号最小启用员工选人，城市和轮询由 G2-A 回补；池空时经理为空，工单进入 assigning。

整张单逐项调用真实 `ledger.capture`，只允许 held 冻结单，任一项失败整单回滚并告警一次。真实 capturedAt 来自账本账户锁后的写入；以首次捕获时点创建局部 Flow，订单项 captured_at/phase 和父单 started_at/status 在对应迁移的同一 UPDATE 写下。随后调同事务 `createTickets` 创建每项一工单和一份方案初稿，发携真实工单 ID 的唯一 `order.started`。资金、经理同步、工单、历史、审计和事件一起提交；等待期间订阅已过期仍开工。已非待开工的重试只返回 skipped。

两个 critical 订阅者分别处理资质决定与套餐生效。资质决定按当前门店事实逐单登记 `max(now,submittedAt+delay)`，重复不推迟既有 scheduled/dispatched 行；驳回仅改 qualification_rejected。套餐生效只给同主体启用且缺经理的门店指派、同步未结单，既有经理不动，池空不写。每 5 分钟的 tx 补偿只为 full/待开工/无取消且缺 scheduled/dispatched 的单补登记或复活 failed/skipped，每命中报 P3；不在补偿事务内直接扣减。

组合根绑定 `OrderStartBinding` 的真实公开依赖，关闭时解除本作用域；未绑定明确 INTERNAL。通知取数仍调 `orderForNotify` 空端口；正式 x01 的 `order.started` 下游为 docs/notify，授权书 M5、通知 M2；未登记的直记埋点不自造，M7 接收方再按正式事件目录接线。

`start.concurrency.test.ts` 用 3 条 max=1 的独立连接、实际 backend PID 和事务栅栏重复 20 轮：真实 skipped → 补偿同键复活后，重复定时器执行与资质订阅者并发，整单每项仅扣减/建工单/迁移一次。`start.fault.test.ts` 由子进程真实 capture 后停在断点，父进程发 SIGKILL；父连接在断点上看不到未提交写，连接死后整笔回滚，同条消息重试只扣减一次。既有 a 的状态推导与读侧验收不重复改写。
# 取消只读前置（W210 所属准备）

`quoteOrderCancel` / `quoteAdCancel` 接受员工数据范围、原始输入与注入时刻；
`previewFinalReject` 接受已由 profile 鉴权的 entity/store，且是无 fallback 的
`QualificationImpactPort.previewFinalReject` 真实实现。三者不拿业务行/账户锁，
不 advance、不写账本、timer、审计、快照或缓存。数量使用原计价快照和统一 HALF_UP，
去向全部调用 billing.previewReturn；超次广告修改不纳入取消目标。

`revalidateCancel` 只返回 `{ at, ok, diffs }`，不写 recheck_log、不代审批。
写调用者必须在同一 Tx 预锁全部申请和全部拥有者目标的 union：approval30 →
cancel_request50 → line60 → 资格轮次65（涉及时）→ entity100 → store130 →
profile135（需要时）→ drama140 → ad150 → 所有order160 → 所有item170 →
所有ticket180 → account190（涉及时）→ plan200及真实后继子对象 → file410 →
唯一主体 billing_account420 最后；每表主键升序。先读取候选图、再预锁、再重读；
候选/指针/hold关系/精确暂停cause/plan/cover新增或变化整笔拒绝重试，不能高锁后补低锁。
live 使用申请固定终止日，允许服务中进入到期下架，不比较今天；步骤1–9必须持本审批
active cancel_review，其他申请或 plan_amendment 不算。返回失败后，正式入口自行在
独立小事务持正确锁写最近一次复核日志，原审批/执行事务不迁移。

未来关闭复用 delivery 的精确暂停释放（最后暂停恢复真实阶段 SLA、原求值和订单回调）、
ad 清指针、order 重新推导与 order.start 复活。真实执行还需要 ticket terminate、
发布/下架/下载授权/文件等完整拥有者出口，账户锁后不能首次获取低序对象或 timer 主体锁。
本片没有 cancel kind、提交/审批/执行/终局 producer、免审批路径、HTTP 或新配置，
不代表 W210 整包关闭收尾已完成。

## 广告取消内部写链（W210 所属准备）

`createAdCancel` 注入真实 approval/flow/ledger/events/timers/sla 与 TxRunner；提交、批准、驳回、撤回、作废仍只处理 `ad_cancel`。W5-01 将唯一 `executeCancel` 扩展到 `order_cancel`、`ad_cancel`、`qualification_cancel`，未增加订单提交审批 producer。六回调与执行时限读取由 order 静态注册；回调只接受本 Tx 的真实用例绑定，不缓存另一运行时。Tx-first 同名函数供同事务调用。facade 在事务确实回滚后另开小事务保存复核失败日志，且仅更新仍在对应待审批/待执行状态的申请，避免覆盖已完成记录；直接 Tx 调用者须在其外层回滚后履行同一日志责任。

提交先认真实启用员工和权限，审批引擎在自己的 validate 中进入真实整图锁和账户 Tf 核算，再建审批/header/line/自有指针。批准保留审批引擎 pending/self/version 原守卫，校验回显并复核；待执行保存原工作日 SLA 与真实 approval_request execution timer。自动路径只由真实提交中开关与全额原批次释放条件触发，系统 approve 后直接 auto_execute，不伪造 pending_execution。

`readAdCancelTargetGraph` / `prelockAdCancelTargets` 供未来关闭调用方整体预锁：staff20→approval30→request50→line60→entity100→store130→ad150→活跃绑定 order160/item170；每表 ID 升序，候选图重读不一致即整笔拒绝。所有相关既存 timer 在账户420前整体预锁；调用方必须合并其他 owner 目标后再锁，不得先持主体或高序锁再补本图。正常执行与 auto 都先迁移广告，再调用真实账本、写实际三去向及请求累计，最后完成 header 与 approval.executed；任一失败整笔回滚。广告不拥有 delivery_ticket，不创建假暂停。

内部 body 不接受 serviceTicketId；完整 HTTP 的 support 引用写口与 active requester 对象失效财务代撤另属前置。现仅本人撤回、既有 disabled requester 合法代撤、真实失效后的 system 撤回/作废。未实现其他取消 kind、广告创建/指派/版本 producer、主体关闭或 W210 整包。实际验证待独占窗口，源码阶段不标通过。

`tenant.entityAdCancelClose` 是本域登记的二阶段关闭伴随口，按 tenant README 的低序 union 与全部 tenant 行预锁协议调用。仅在调用方已真实关闭主体后，精确系统撤回该主体的 pending ad_cancel；沿现有六回调关闭 header/审批/自有指针/审批 timer，零账本变动，不造 delivery 暂停。API 复用其唯一 Approval 实例，worker 以原 registry 与真实依赖创建 Approval；既有 `bindOrder`/close 维护本实例作用域，无取消依赖则拒绝。本片不构成完整 tenant 关闭或其他 kind 实现。

广告取消提交新增可选成对 `AdCancelSubmissionCompanion`：`beforeAccount` 在真实目标170之后、首次 `ledger.lockAccount`420之前调用，`afterCreated` 在真实审批/header/line/指针/提交事件建立后、自动审批执行前调用。两个阶段收到同一个冻结目标对象及实际分配审批ID；应用可组合 support 专用引用 writer，order 不导入同层 support。未提供 companion 的原提交语义不变，单侧回调拒绝。HTTP 仍待后片，不接受后静默丢弃 `serviceTicketId`。
