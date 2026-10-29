# W4-20：M5 工作包唯一映射

| 项 | 内容 |
| --- | --- |
| 改了什么 | 将 08 §7.5 的 G5-A 5、G5-B 4、G5-C 5、合流 1、交 M6 拆包 1 固定为 W5-01–16；逐项分配 62 API、4 新页、11 主体化 x01 和 11 留桩，新增实现数为 0。 |
| 原因 | W4-19 代码验收 actual 后，W4-20 先冻结唯一归属再交九节任务书；澄清样片旧桩的播放器/时间点误述，遵从主规范 §11、m05 A31 与 actual typed schema，默认不做播放器，商家仅 compose 意见、note/截图及查看证据；后台经理既有可选 feedbackTimeMs 按 a05 保留。 |
| 影响的包 | W5-01–16 的任务书、未开工状态与共享面移交；页面原登记组、接口权限/能力/路径、x01 名字及里程碑、原进入/退出条件均保留。旧样片桩待 W5-10 实际回补时按事实更正，本纯文档包不修改冻结源。 |
| 类别 | 拆并（包数 16→16；资源归属不增减；既有页增量单列） |
| PR | —（调度创建后回填） |

## 1. 基线、计数和进入边界

基线是 actual main `ac377de07fba7f65c04b75e7df7d9fe8a03cd670`；W4-19 已完成，本分支为 `codex/w420-task-map`。依据为 [W4-20](../tasks/W4-20.md)、[08 §6.8/7.5](../../08-development-plan.md)、`packages/contract/generated/routes.json`、[pages](../pages.md)、[x01-map](../x01-map.md) 和 `docs/plan/stubs/` 的实际集合。领域依据为 a05/m05/m06、09/10/13 数据模型、03 §3/7/8.3、x01 和 ADR-042。

| 组 | 包数 | 新归属 API | 新登记页 | x01 | 留桩唯一接收数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| G5-A / W5-01–05 | 5 | 32 | 0 | 6 | 4 |
| G5-B / W5-06–09 | 4 | 30 | 0 | 5 | 5 |
| G5-C / W5-10–14 | 5 | 0 | 4 | 0 | 2 |
| 合流 / W5-15 | 1 | 0 | 0 | 0 | 0 |
| M6 拆包 / W5-16 | 1 | 0 | 0 | 0 | 0 |
| 合计 | 16 | 62 | 4 | 11 | 11 |

这里的“新”指原登记归属集合，不代表已实现。M5 actual API=48 a05＋5 m05＋9 m06；消费者引用不重复计数。页面交付书统一在 G5-C，原 pages 中我的短剧 G5-A、两广告页 G5-B、后台广告任务 G5-C 的历史登记组保留，不改冻结 metadata。下表级别/规模/依赖是分书的唯一源；乙最多 20 API，丙最多 8 页（新旧合计），甲一个机制、非生成非测试源码约 600 行，实际需要超限时由调度裁定，不在任务书预设豁免。

**M5 业务开工仍需 08 §6.8 的 M2/M3/M4 代码退出，以及 Q9 明确答复或业主书面接受默认及返工。** Q9决定已于2026-10-27登记，见[业主清单§3.1](../owner-checklist.md)；样片新方案仍待后续变更包落实；W4-20 只能交文档，不能据此启动 M5 业务实现。每包另列具体代码依赖，不把“全 M4”机械地加到每个依赖栏。授权书另需 X-03 actual 结论；E8/E11、签名后 V12 仍外部未验，图片章/返回原字节不等于机构数字签名，生产不许静默降级。V12 已有渲染证据可复用，签后表现最晚 M8 进入前关闭。

样片相关旧默认保留为Q9答复前的拆包记录；后续变更包须按业主清单§3.1同PR修改方案文档与代码，落实小程序内播放、入口收敛和后端“我已查看”校验。本次只同步答复事实，不表示这些行为已交付，也不解除各包实际依赖或外部验收。

## 2. 十六包、具体依赖与验收边界

| 编号 | 组 | 标题 | 级别/规模 | 具体代码依赖（均须 actual main） | API/新页/x01/桩 | 验收概要 |
| --- | --- | --- | --- | --- | --- | --- |
| W5-01 | G5-A | 取消执行与积分回退单机制 | 甲/L | W1-06、W1-10、W1-15、W1-16a、W1-17、W2-10、W4-05 | 1/0/0/0 | 沿现有 order/ad 取消公口加厚唯一执行器；六阶段实际积分去向、开工对取消并发、幂等/故障/锁序；只扣一次、只建一工单，不另写现金退款算法。 |
| W5-02 | G5-A | 取消申请审批与资质驳回后续 | 乙/M | W5-01、W2-11、W2-17 | 9/0/1/1 | 报价快照、人工扣除依据、发起/异人审批/撤回代撤/作废；非终局七日跟进与终局 qualification_cancel 分支；整店试算只读，批准执行复用 01。 |
| W5-03 | G5-A | 交付暂停改派改期补发与环节 SLA | 乙/L | W5-01、W1-16a、W1-17、W2-03、W2-05、W2-17 | 11/0/3/3 | 暂停原因叠加/恢复、显式剪辑师与发布人指派、补发替换、改期、强迁与重新求值；日历/SLA重算、重复求值零副作用、卡死工单0；复用原唯一循环。 |
| W5-04 | G5-A | 制作人工入口、取料与下载记录 | 乙/L | W5-03、W3-01、W3-03、W3-04、W3-07、W3-14 | 7/0/0/0 | 事实查询/规格化/重检/补标四入口和 master_checkout，真实签发取料及下载来源；沿 M3 流水线与处理器，不复制算法或自动采纳衍生产物。 |
| W5-05 | G5-A | 样片反馈与订单后续事实 | 乙/M | W5-02、W5-03、W5-04、W1-15、W1-16b、W1-20、W2-05、W2-17 | 4/0/2/0 | 查看证据、过期版拒绝、商家compose反馈与markSent；后台代录整条API归08；重传确认链、订单后台试算/活动、日历与许可缩短；R4只读提醒与场景落地。 |
| W5-06 | G5-B | 授权事实收敛与注入事实端口 | 甲/L | W5-03、W5-05、W2-12、X-03 | 0/0/1/0 | 一个 ensureLetters/收敛机制，锁订单项→信件，按当前事实处理重复/乱序/账号移除/取消；docs L1不读L3表，delivery.getLicenseFacts 注入单源，N6/N16真实检查。 |
| W5-07 | G5-B | 授权书 PDF、签名适配、修订与查询 | 乙/M | W5-06、W5-02、W3-01、W3-03、W1-16b | 8/0/2/1 | 不可变版次/指纹、事务外渲染签名、租约与attempt fencing、真实成品hash和私有下载审计；certificate/stamp准确区分，docs队列并发2与原sweep恢复；回补订单售后/授权投影。 |
| W5-08 | G5-B | 商家广告生命周期、计费与订购事实 | 乙/L | W5-01、W5-02、W5-03、W5-05、W5-06、W5-07、W2-10、W2-17、W3-07、W3-14、W4-05、W4-07 | 12/0/1/4 | 含admin.sample.requestChange整条代录API的compose/ad_content两支与既有可选feedbackTimeMs；复用05商家compose公共口；广告正式创建/提交/确认/修改、真实冻结和扣减、免费次数快照/超额再扣；广告取消复用01/02；选广告、身份/档案计数及广告/授权就绪读口真实，取消不能复活。 |
| W5-09 | G5-B | 后台广告任务、版本与查看证据 | 甲/M（PR1甲＋PR2乙） | W5-08、W5-04、W2-03、W2-17 | 10/0/1/0 | 实际指派/退回/版本登记推送/四种查看证据/代录修改/催办，R5、SLA主体ad；同编号PR1甲只扩ad可表达的typed来源/分派支持及对应test，保原已投产五来源required失败语义，不能提前强制ad或注册恒零；actual后PR2乙交本10API、真实ad来源countOpen/list/reassign及移交，并在注册到位后启用ad完整性要求，两PR齐才完成，计数不恒0。 |
| W5-10 | G5-C | 我的短剧与既有订购样片增量 | 丙/M | W5-02、W5-03、W5-05、W5-07、W5-08、W1-18、W1-20 | 0/1/0/2 | 我的短剧新页；checkout选广告、sample反馈与查看证据/失效版、商家订单详情售后授权既有增量；不新增播放器/商家time字段，后台经理既有可选feedbackTimeMs保留；平台购买约束/服务端actions。 |
| W5-11 | G5-C | 商家广告列表与详情 | 丙/M | W5-08、W5-09 | 0/2/0/0 | 两页含原M42弹层，真实quote/同意/提交/修改/确认/下载，版本与未知key保护；已有“我的”/建档广告角标消费真实投影，不新建角标页。 |
| W5-12 | G5-C | 合同页授权书增量 | 丙/S | W5-07、W4-16 | 0/0/0/0 | 既有contracts页授权书列表/状态/历史版/有效期与逐份下载；不引入M6 ZIP/电脑页/分享验真新页。 |
| W5-13 | G5-C | 后台工单余下表单与取消审批增量 | 丙/L | W5-02、W5-03、W5-04、W5-05、W5-07、W5-09、W1-19、W2-06 | 0/0/0/0 | 已有工单详情含强迁/求值/改派/补发/取料/人工制作入口；已有订单详情售后授权投影与已有我的待审批取消类型；真实权限/stepup/版本/原key及截图，不新增独立取消页。 |
| W5-14 | G5-C | 后台广告制作任务页 | 丙/M | W5-08、W5-09、W5-04、W2-02 | 0/1/0/0 | 单广告任务工作台含详情面板、指派/版本/证据/修改/取消链接，上传复用原M3公口；空态与迟到/同key/版本守卫，不造独立广告详情路由。 |
| W5-15 | M5合流 | M5端到端、demo:m5、计数与归属核对 | 丙/M | W5-01、W5-02、W5-03、W5-04、W5-05、W5-06、W5-07、W5-08、W5-09、W5-10、W5-11、W5-12、W5-13、W5-14 | 0/0/0/0 | 真接口取消/修改/广告/授权链、全不变量、actual main十轮≤90秒/失败即停、两次demo同意图零新增；62/4/11/11逐项清零与真机/外部未验分列。 |
| W5-16 | M6拆包 | M6发布与电脑端下载任务书 | 丙/M | W5-15 | 0/0/0/0 | 只拆M6约14包（后端7/页5/合流1/M7余组拆1），逐项actual55API/12页/9x01/8桩，排除已交W7-01–08；不实现M6业务或越范围拆M8/生产G2-E。 |

W5-01 的执行器可消费已合 ad 取消/指针公口，不借 W5-08/09 未合创建实现；08/09 actual 后补真实广告创建后的集成，不能让01反向依赖08/09。03→04是既有delivery共享契约/入口的串行交接；08明确等07，确保就绪守卫检验真实已渲染授权版，不以pending信件替代。前九包API数依次为 1、9、11、7、4、0、8、12、10。admin.sample.requestChange整条归08并显式依05，避免05等待广告writer而06/08又反依05的隐藏环；后台compose/ad_content不分裂成两个owner。W5-09整本级别甲/M，沿已批准同编号两PR形态：PR1只交静态typed owner表达/分派兼容前置，PR2乙等PR1 actual后交广告业务，不增加第17包、不在W4-20写kernel代码；原锁、幂等、调度规则不变。

## 3. 六十二条 API 唯一归属

只按 actual operationId 计owner；方法/路径/权限/能力/里程碑不随拆包改动。各书须写完整ID、当前请求/响应 schema 及真实验收；当前meta-only条目由该owner补本域typed结构和薄路由，不冒充已挂载。页面只是消费者。

| operationId | 唯一owner |
| --- | --- |
| `admin.cancelRequest.execute` | W5-01 |
| `admin.cancelRequest.approve` | W5-02 |
| `admin.cancelRequest.get` | W5-02 |
| `admin.cancelRequest.list` | W5-02 |
| `admin.cancelRequest.reject` | W5-02 |
| `admin.cancelRequest.summary` | W5-02 |
| `admin.cancelRequest.void` | W5-02 |
| `admin.cancelRequest.withdraw` | W5-02 |
| `admin.order.cancelQuote` | W5-02 |
| `admin.order.cancelRequest.create` | W5-02 |
| `admin.deliveryTicket.activity.list` | W5-03 |
| `admin.deliveryTicket.assignEditor` | W5-03 |
| `admin.deliveryTicket.assignPublisher` | W5-03 |
| `admin.deliveryTicket.forceTransition` | W5-03 |
| `admin.deliveryTicket.reevaluate` | W5-03 |
| `admin.deliveryTicket.reissue.create` | W5-03 |
| `admin.deliveryTicket.remind` | W5-03 |
| `admin.deliveryTicket.rework` | W5-03 |
| `admin.orderItem.rescheduleLaunch` | W5-03 |
| `admin.reissue.cancel` | W5-03 |
| `admin.reissue.publish` | W5-03 |
| `admin.deliveryTicket.material.downloadUrls` | W5-04 |
| `admin.deliveryTicket.material.list` | W5-04 |
| `admin.orderItem.download.list` | W5-04 |
| `admin.productionRecord.list` | W5-04 |
| `admin.productionRecord.normalize` | W5-04 |
| `admin.productionRecord.recheck` | W5-04 |
| `admin.productionRecord.restamp` | W5-04 |
| `admin.order.activity.list` | W5-05 |
| `admin.order.quote` | W5-05 |
| `admin.sample.markSent` | W5-05 |
| `admin.sample.requestChange` | W5-08 |
| `m.sample.requestChange` | W5-05 |
| `admin.licenseLetter.correct` | W5-07 |
| `admin.licenseLetter.void` | W5-07 |
| `admin.licenseLetterRevision.rerender` | W5-07 |
| `admin.orderItem.licenseLetter.list` | W5-07 |
| `m.licenseLetter.downloadUrls` | W5-07 |
| `m.licenseLetter.get` | W5-07 |
| `m.licenseLetter.list` | W5-07 |
| `m.licenseLetter.summary` | W5-07 |
| `admin.ad.cancelQuote` | W5-08 |
| `admin.ad.cancelRequest.create` | W5-08 |
| `m.ad.confirm` | W5-08 |
| `m.ad.create` | W5-08 |
| `m.ad.downloadUrls` | W5-08 |
| `m.ad.get` | W5-08 |
| `m.ad.list` | W5-08 |
| `m.ad.quote` | W5-08 |
| `m.ad.requestChange` | W5-08 |
| `m.ad.submit` | W5-08 |
| `m.playable.get` | W5-08 |
| `admin.ad.adVersion.create` | W5-09 |
| `admin.ad.assign` | W5-09 |
| `admin.ad.get` | W5-09 |
| `admin.ad.list` | W5-09 |
| `admin.ad.remind` | W5-09 |
| `admin.ad.requestChange` | W5-09 |
| `admin.ad.return` | W5-09 |
| `admin.ad.summary` | W5-09 |
| `admin.adVersion.markSent` | W5-09 |
| `admin.adVersion.push` | W5-09 |

## 4. 页面与既有页增量

| 新登记key/路径 | 原登记组 | 唯一实现包 | 新页数 |
| --- | --- | --- | ---: |
| `sub/order/my-dramas/index` | G5-A | W5-10（G5-C交付） | 1 |
| `sub/ad/ads/index` | G5-B | W5-11（G5-C交付） | 1 |
| `sub/ad/ad-detail/index` | G5-B | W5-11（G5-C交付） | 1 |
| `delivery.ad_tasks` / `/delivery/ad-tasks` | G5-C | W5-14 | 1 |

| 既有页/读侧增量 | 唯一实现包 | 边界 |
| --- | --- | --- |
| checkout 广告选择；sample 修改/查看证据/版本失效；商家order-detail售后授权 | W5-10 | 复用正式quote和adIds、商家schema仅compose/note/截图，不新增商家feedback_time_ms；sample不默认增加播放器/时间点UI，后台经理既有可选feedbackTimeMs保留，电脑预览仍M6。 |
| 商家“我的”和建档广告角标导航 | W5-11 | 读08真实ad事实；不改identity/profile聚合算法，不造新页。 |
| `sub/billing/contracts/index` 授权书 | W5-12 | 沿W4-16协议/合同页增加授权域，0新页。 |
| `/delivery/tickets/$ticketNo`、已有后台订单详情、`/approvals`取消类型 | W5-13 | 三个既有页增量，工单强迁/求值不可遗漏；审批generic renderer保持，取消typed内容/处理链接由本包加。 |
| OrderDetail.afterSales/licenseLetters、AdminOrderDetail.cancelRequests/licenseLetters/licenseLetterCount | W5-07（后端投影）；页面消费分别10/13 | 取消事实读02、授权事实读06/07，不从页面造行、不跨层反读。 |

丙类页数上限以新旧实际触及页面计，弹层不造路由；目前最大 W5-10 为1新＋3旧，W5-13为3旧，均≤8。各页包自行完成交付所需菜单/单源登记，由当期调度协调同一共享文件单owner串行合并；不等待15。15只做最终归属核对，不手改生成物。

## 5. 十一个 x01 处理项

| 类别 | actual名字/主体 | 唯一owner | 边界 |
| --- | --- | --- | --- |
| 订阅者 | `delivery.onCalendarImported` | W5-03 | 环节与工单SLA重算，非media/billing的日历订阅。 |
| 订阅者 | `docs.onLicenseFacts` | W5-06 | 当前事实收敛，不依赖事件先后/载荷旧快照。 |
| 订阅者 | `docs.onRevisionQueued` | W5-07 | 只入原授权渲染队列，重放/丢唤醒可回查。 |
| 订阅者 | `order.onCalendarImported` | W5-05 | 订单日历派生重算。 |
| 订阅者 | `order.onLicenseShortened` | W5-05 | 许可缩短、当前事实和幂等派生，不侵入M6发布写链。 |
| 定时器 | `ad.returned_stale` × `ad` | W5-08 | 当前退回轮次守卫，不取消新一轮。 |
| 定时器 | `order.rejected_stale` × `drama_order` | W5-02 | 非终局资质驳回七自然日后待办，轮次过期skipped，不主动整店取消。 |
| 定时器 | `sla.breach` × `ad` | W5-09 | 首版/修订主体化键；08生产者调共享服务，09接实际到期处理与完整集成。 |
| 定时器 | `sla.breach` × `delivery_ticket_stage` | W5-03 | 环节快照/日历/暂停恢复按当前版本。 |
| 循环 | `flow.reconcile_sweep`（实现别名`flow_reconcile_sweep`） | W5-03 | 同一个已登记循环加厚，沿原worker loop，不造第二扫描/自愈流程。 |
| 队列 | `docs`（并发2） | W5-07 | 框架/渲染算法单源，既有`docs.sweep`扩恢复分支，不新增同名cron。 |

R4样片提醒/查询与场景由05单写；R5广告确认提醒由09单写，复用W2-17 notify框架。各领域的事件解析、埋点和告警规则随所属写侧交，不另造x01条目凑数。

## 6. 十一个留桩唯一接收

| 留桩文件（docs/plan/stubs/） | 唯一回补包 | 目标与验收 |
| --- | --- | --- |
| `m5-identity-overview-ad.md` | W5-08 | ad merchant-facts 当前门店待确认真实数、范围与版本变化；identity只消费。 |
| `m5-weapp-order-ads.md` | W5-10 | checkout广告选择、原quote/adIds；仅选当前合法广告，旧选择过期停提。 |
| `m5-delivery-editor-claim.md` | W5-03 | 显式指派/改派取代首次登记隐式认领，实际staff集合与在办移交。 |
| `m5-order-aftersales-licenses.md` | W5-07 | 取消和授权真实投影补齐；GET零写、范围裁剪与计数对应，页面10/13只是消费者。 |
| `m5-delivery-stage-sla.md` | W5-03 | due_at/sla_snapshot/staff_due_at与工单step_due_at非空、跨假日/日历重算和定时器。 |
| `m5-delivery-pause-reissue-invariants.md` | W5-03 | 暂停原因叠加与恢复、返工补发守卫及delivery.I2/I14，不伪造自愈。 |
| `m5-order-ads.md` | W5-08 | 既有m.order.quote/create广告引用真校验/同单占用/版本钉住，不再恒空拒收。 |
| `m5-delivery-ad-license-ready.md` | W5-08 | 真实adsReady和licenseReady最终集成，消费06/07授权公口/真实ready版，两个条件均不得恒真。 |
| `m5-order-qualification-reject-followup.md` | W5-02 | 非终局定时跟进；终局资格整店取消复用01，未批准不提前取消。 |
| `m5-profile-overview-ads.md` | W5-08 | 建档确认/待确认/制作中及修改中广告口径真实；profile不直接反读L3。 |
| `W1-20-m5-sample-feedback.md` | W5-10 | 按design§11/A31及actual m05商家只接compose/note/截图、证据/失效版保护；旧桩播放器/时间点要求是误述，回补时更正，0新页，不擅写商家feedback_time_ms；后台经理既有可选feedbackTimeMs按a05保留。 |

每份桩只有上述一个闭桩owner；后端/页面配合不重复计数，不在本纯文档包提前改成已回补。

## 7. 允许目录与共享面单写

各包还可写本包任务/状态、所属README/对应领域文档、本域测试和必要testing私有夹具；不允许重写账本算法、权限矩阵、锁表、layers或DDL。路径中“新增叶”指允许在该具体目录新增本功能文件，不授权整目录重构。生成物必须由官方命令产生，不能手写；本W4-20映射不执行生成/类型/业务测试。

| 包 | 具体允许路径概要（分书须收窄到自己拥有功能） |
| --- | --- |
| W5-01 | `packages/services/src/order/cancel-*.ts`、`ad/cancel-*.ts`（既有公口定点复用）、`delivery/cancel-review-*.ts`必要事务接线；`apps/api/src/routes/admin/order-cancel*.ts`新增execute叶；contract `a05-order-delivery/cancel.schemas.ts`及`cancel-requests.ts`仅execute结构；本域性质/并发/故障/API测试。 |
| W5-02 | `packages/services/src/order/`新增cancel-request/qualification-followup叶及现cancel读/报价/订阅定点；`apps/api/src/routes/admin/order-cancel*.ts`仅本包9条；contract a05的cancel/orders所属结构、reject reasons；`delivery/cancel-review-*.ts`只调用现01/既有public；本包桩。 |
| W5-03 | `packages/services/src/delivery/`pause、reissue、assign、stage-sla、reevaluate与register/ports所属叶；`order/sweep.ts`必要调用接线；`apps/worker/src/loops/delivery-reevaluate.ts`及`domain-loops.ts`同一循环；`apps/api/src/routes/admin/delivery*.ts`新增所属叶；contract a05 delivery/reissues/order-items所属结构；本包3桩。 |
| W5-04 | `packages/services/src/media/`新增production-actions/master-checkout只接原处理器；`delivery/`新增material-read/download-record叶；API新增本域production/material薄路由；contract a05 `production.schemas.ts`/production-records及delivery-tickets materials、order-items download子集；不改M3任务算法。 |
| W5-05 | `delivery/`新增商家compose sample-feedback/viewing-evidence/R4叶（后台代录整条归08）；`order/`calendar/license-shortened/quote/activity与注入只读事实叶；`apps/api/src/routes/delivery.ts`、新增admin samples/order-read叶；contract a05 samples/orders及m05 samples所属结构；不写播放器或新增商家时间点body；后台经理既有可选feedbackTimeMs按a05保留。 |
| W5-06 | `packages/services/src/docs/`新增license-facts/converge叶与ports/register；`delivery/`新增license-facts读/父锁适配叶并注入既有端口；`packages/services/src/kernel/ports/`只扩已设计注入契约，不改鉴权/锁序；对应不变量/性质/乱序测试。 |
| W5-07 | `packages/services/src/docs/`新增license-read/render/revisions/jobs、既有jobs/sweep恢复分支；`providers/`仅EsignProvider适配新叶与选择接线、不改其他driver；`order/`新增售后/授权投影适配叶；`apps/worker/src/`新增docs queue薄执行器；API license-letters所属薄路由；contract a05/m05授权所属结构；本包1桩。 |
| W5-08 | `packages/services/src/ad/`新增merchant lifecycle/quote/read/price/revision叶与ad事实端口；`order/`广告quote/create合法选择及版本引用、`delivery/`ad/license-ready适配叶；identity/profile只经已设merchant-facts读口消费；`delivery/`新增sample-feedback-on-behalf叶复用05公共口，后台compose/ad_content及既有可选feedbackTimeMs只由本包实现；API新增m06/ad、admin/ad-cancel及admin.sample.requestChange叶；contract m06与a05仅本包ID；本包4桩。 |
| W5-09 | PR1仅`packages/services/src/kernel/ports/staff-work.ts`及必要typed分派接线/对应test扩ad可表达能力，0业务API，保既有五来源required失败语义、不提前强制ad、不注册恒零；PR2才可写`packages/services/src/ad/`新增admin tasks/assign/version/evidence/R5/SLA/staff-work叶；`staff/`仅绑定该真实typed source，不重写pickNext/移交框架；API新增admin ad/ad-version薄路由；contract a05本包ID；PR2真实ad注册到位才启用ad完整性要求，并验证staff source/移交；不改原锁/去重/调度。 |
| W5-10 | `apps/weapp/src/sub/order/my-dramas/`新增；既有`checkout/`、`sample/`、`order-detail/`，相关本域stores/lib适配；`apps/weapp/src/pages.ts`单源登记本页，`app.config.ts`沿buildRoutes派生、不手拼；本包2桩。 |
| W5-11 | `apps/weapp/src/sub/ad/ads/`、`ad-detail/`新增与本域store；已有mine/profile广告角标字段和导航适配叶，`apps/weapp/src/pages.ts`单源登记本包两页、`app.config.ts`沿buildRoutes派生，不改公共组件。 |
| W5-12 | `apps/weapp/src/sub/billing/contracts/`本域授权分区及typed adapter/模型，不写billing金额算法或新路由。 |
| W5-13 | `apps/admin/src/features/delivery/ticket-detail/`、`features/order/orders/`的详情售后授权、已有审批feature的取消typed adapter；`routes/delivery/ticket-detail.tsx`、`routes/order/detail.tsx`、`routes/workbench/approvals.tsx`所属接线；不改共享ConfirmPanel等构件。 |
| W5-14 | `apps/admin/src/features/delivery/ad-tasks/`及`routes/delivery/ad-tasks.tsx`新增；`routes/modules/delivery.ts`、菜单本页登记；复用原文件上传公共口，不新增后台第2广告页。 |
| W5-15 | `apps/api/test/e2e/m5*.ts`、`packages/services/src/testing/m5*.ts`、实际repeat/demo接线；根package/CLAUDE必要新增；M5演示回顾/runbook、计数/归属/外部台账，必要CI只增另列，不改业务算法。 |
| W5-16 | `docs/plan/tasks/W6-*.md`、对应未开工status、M6唯一map；08/任务README/状态README与移交本轮窄增，不修改W7-01–08，不写业务。 |

| 共享面 | 唯一初始owner与后继交接 | 不可越过的边界 |
| --- | --- | --- |
| 取消执行器、退积分计算、取消事务入口/锁 | W5-01；02只调公开请求/执行边界，08只接ad真实创建后的消费者 | 不造第二套ad/store取消writer；单账户最后锁，未合ad不成为01依赖。 |
| delivery通用DTO/reevaluate/ports/register、唯一flow loop | W5-03；04→05在前包actual后仅交接自身结构/薄路由子集，06/08新增私有适配叶后串行合入口 | 不并行写同一共享文件；算法不复制，不造另一个扫描。 |
| 授权当前事实端口/ensureLetters/收敛 | W5-06；07调用06机制，08调用ready reader | docs L1不读order/delivery L3表；逆向事实只注入，不借改layers放行。 |
| docs队列、渲染/签名、版次存储与下载 | W5-07；06只产生revision事实，07接消费 | 并发2；已有docs.sweep只扩；certificate/stamp保真、不可把原字节标为数字签名。 |
| 广告schema/模型/merchant-facts与order广告读口 | W5-08；09在08 actual后仅增admin/private version叶与所属API结构 | identity/profile不直接读ad表；引用与查看证据按真实版本，冻结报价/免费次数。 |
| 广告staff在办typed来源与R5/SLA | W5-09；PR1甲typed表达/分派兼容 actual后PR2乙接真实ad并启用完整性 | `countOpen/list/reassign`真实落地，不注册恒零来源；W2-03框架不重写。 |
| 页面菜单/app.config/route模块、聚合导出与生成物 | 各页包各自完成必要菜单/单源登记，由当期调度协调同文件单owner串行合并，不等W5-15；15仅最终归属核对 | 不让并行页面作者覆盖同文件、不手改pages/generated；原登记组保留。 |

## 8. DAG、核对与后继移交

M5内部拓扑可按以下层次读取，层内不代表必须并行（共享面仍单owner串行）：

`01 → {02,03} → 04 → 05 → 06 → 07 → 08 → 09 → 10–14 → 15 → 16`。

这是展示主边，完整有向边以第2节逐项依赖为准；例如04依03，05还依02，10/12不必等09，C包只等自己的typed后端actual。所有具体外部W/X编号已存在；不从待合分支借源码。W5-01/06各保单机制；W5-09的typed表达/分派兼容甲前置与后继10API乙分别成PR，不因共享边界把甲与页面/大CRUD混成一PR。

W4-20最终一次性只读脚本应从生成routes抽M5集合，与本表及每书“拥有接口”比set：62相等、owner恰一；pages=4且既有增量不增数；x01=11按主体计，docs并发2/flow别名不重复；stubs=11有唯一回补目标/allowed path/真实验收。再核16书每本九节90–170行、状态全未开工/PR—、规模级别依赖与本表一致、DAG无环、乙≤20API/丙≤8页。脚本仅本PR使用，不新增仓库门禁。

正式状态/契约/登记/页面检查由调度排一次，不占本映射写作阶段重槽；`contract:check`/`registry:check`内部会生成，不能以“只读核对”为名自行启动。Q9决定已于2026-10-27登记，见[业主清单§3.1](../owner-checklist.md)；最终台账仍保留样片变更包未落实、E8/E11与签后V12未验；完成只表示任务书已交，M5业务一项也未在此实现。W5-16未来交M6 actual约14包/55API/12页/9x01/8桩及后续M7余组，原G7-A W7-01–08不重拆。
