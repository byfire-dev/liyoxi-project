# 后台：工作台、报表与导出

| 项 | 内容 |
| --- | --- |
| 范围 | 后台外壳与首页：A:Main（工作台：我的待办、今日数据、预警、实时动态；“近 7 日上线安排”调 a06 的 `admin.launchCalendar.get`）、全部后台页面共用的菜单角标、全局搜索与通知铃铛（原型只有入口，设计完成前隐藏，design-spec.md:907）；报表：A:RptOverview、A:RptPoints（V1.0），A:RptDramas、A:RptDelivery、A:RptAds、A:RptService、A:RptPartners（V1.1）；报表月度快照（原型无入口）；统一导出：各列表与报表的“导出”按钮（A:Tickets、A:Merchants、A:Orders、A:Payments、A:Reconcile、A:Service、A:SysLogs、A:Dramas、A:PointAccounts、A:Renewals 等）与页头“导出记录”抽屉（原型无） |
| 接口数 | 24（V1.0 19，V1.1 5） |
| 依据 | 数据模型 14 分组（`report_month_close`、`export_job`）、13 分组（`staff_message`、`notification`）、03 分组（`audit_log`、`approval_request`、`staff_role`、`follow_up`、`assignment_history`）、07 分组（`billing_entity_daily`、`point_lot`、`point_ledger_entry`、`point_entry_valuation`、`subscription_term`、`subscription_event`、`grant_schedule`、`point_hold`）、08 分组（`billing_order`、`payment_txn`、`refund_txn`、`refund_request`、`transfer_proof`、`invoice_request`、`payment_exception`），另读 02、04、05、09、10、11、12、15 分组的表；草案 d6 第 5.2–5.4、6 节，d3 第 19.2、23 节，d7 第 5.2、5.3、5.6 节，d4 第 7.1–7.3、8.5 节，d1 第 10 节；接口裁决 A1–A156（重点 A18、A19、A22、A23、A24、A45、A70；第二轮 A88、A90、A93、A101、A106、A107；第三轮 A132、A134、A145、A146；第四轮 A155）；通用约定 C1–C87（C87 公共结构登记；重点 C14、C43、C46、C50、C60、C63、C64、C66、C83）；资源登记表 `resources.json`（`workbench`、`nav-badges`、`search`、`reports` 为 `table: null` 的聚合视图） |

本文路径一律省略 `/api/v1`。引用写法：`d6:2133` 指 `docs/appendix/design/d6-notify-docs-data.md` 第 2133 行；`14-config-data.md:978` 指 `docs/data-model/14-config-data.md` 第 977 行；`proto-admin-a.md:64` 指 `docs/appendix/research/proto-admin-a.md`。

## 1. 概览

本文是后台的“横切”接口：工作台四块与菜单角标共用一份**待办来源登记表**（每类待办是领域表上的一条带数据范围的计数查询，不建待办表，d3:3061-3097）；报表在业务库上只读聚合，当月实时、已月结月份读月度快照（d6:2034-2043）；所有列表与报表的导出走同一条异步任务路径（`export_job`，d6:2137-2190；ADR-038）。

全部接口 `x-auth = staff`。查看类不设权限点，用模块等级表达（C66；d4-identity.md:1163）；本文的写接口只有标记已读、重出快照与导出任务四类。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `admin.workbench.todo.get` | `GET /admin/workbench/todos` | 我的待办（按岗位视角） | staff；模块 `workbench` ≥ v；卡片按来源裁剪；切换岗位视角另需 `sys.super_admin` | none（查询） |
| `admin.workbench.today.get` | `GET /admin/workbench/today` | 今日数据卡片 | staff；模块 `workbench` ≥ v；卡片按模块裁剪 | none（查询） |
| `admin.workbench.alert.get` | `GET /admin/workbench/alerts` | 预警 | staff；模块 `workbench` ≥ v；按来源模块与数据范围裁剪 | none（查询） |
| `admin.workbench.feed.list` | `GET /admin/workbench/feed` | 实时动态 | staff；模块 `workbench` ≥ v；按类别模块与数据范围裁剪 | none（查询） |
| `admin.navBadge.get` | `GET /admin/nav-badges` | 菜单与二级菜单角标 | staff；已登录即可；按来源裁剪 | none（查询） |
| `admin.search.get` | `GET /admin/search` | 全局搜索（商家、单号） | staff；已登录即可；按类型的模块等级与数据范围裁剪 | none（查询） |
| `admin.staffMessage.list` | `GET /admin/staff-messages` | 铃铛：本人的站内消息 | staff；本人 | none（查询） |
| `admin.staffMessage.summary` | `GET /admin/staff-messages/summary` | 铃铛未读数 | staff；本人 | none（查询） |
| `admin.staffMessage.read` | `POST /admin/staff-messages/{staffMessageId}/read` | 标记一条已读 | staff；本人 | required |
| `admin.staffMessage.batchRead` | `POST /admin/staff-messages/read` | 全部标记已读 | staff；本人 | required |
| `admin.report.overview.get` | `GET /admin/reports/overview` | 经营概览 | staff；模块 `report` ≥ v | none（查询） |
| `admin.report.points.get` | `GET /admin/reports/points` | 积分报表 | staff；模块 `report` ≥ v | none（查询） |
| `admin.reportMonthClose.list` | `GET /admin/report-month-closes` | 报表月度快照（各修订） | staff；模块 `report` ≥ v | none（查询） |
| `admin.reportMonthClose.reissue` | `POST /admin/report-month-closes/{reportMonthCloseId}/reissue` | 重出某月快照 | staff；`report.month_close.reissue`（增补） | required |
| `admin.exportJob.create` | `POST /admin/export-jobs` | 申请导出 | staff；`assert-in-handler`（按导出键） | natural（`uq_export_job_inflight`） |
| `admin.exportJob.list` | `GET /admin/export-jobs` | 我的导出记录 | staff；本人 | none（查询） |
| `admin.exportJob.get` | `GET /admin/export-jobs/{exportJobId}` | 导出任务状态（轮询） | staff；本人 | none（查询） |
| `admin.exportJob.cancel` | `POST /admin/export-jobs/{exportJobId}/cancel` | 取消排队中的任务 | staff；本人 | required |
| `admin.exportJob.downloadUrls` | `POST /admin/export-jobs/{exportJobId}/download-urls` | 签发 5 分钟下载地址；复核不通过时置过期并返回 `status = revoked` | staff；`assert-in-handler`（本人且仍有权限） | none（签发短时地址） |
| `admin.report.dramas.get` | `GET /admin/reports/dramas` | V1.1：短剧销售排行 | staff；模块 `report` ≥ v | none（查询） |
| `admin.report.delivery.get` | `GET /admin/reports/delivery` | V1.1：交付效率 | staff；模块 `report` ≥ v | none（查询） |
| `admin.report.ads.get` | `GET /admin/reports/ads` | V1.1：广告制作 | staff；模块 `report` ≥ v | none（查询） |
| `admin.report.service.get` | `GET /admin/reports/service` | V1.1：客服报表 | staff；模块 `report` ≥ v | none（查询） |
| `admin.report.partners.get` | `GET /admin/reports/partners` | V1.1：服务商业绩 | staff；模块 `report` ≥ v；渠道运营按本人负责的服务商 | none（查询） |

路由注册顺序（A8、C12）：`GET /admin/staff-messages/summary` 与 `POST /admin/staff-messages/read` 先于 `/admin/staff-messages/{staffMessageId}/…` 注册。

本文用到的权限点（d4-identity.md:1141-1207 的注册表，另加增补，A13、A45）：`merchant.qualification.review`、`merchant.manager.assign`、`merchant.account_change.approve`、`merchant.asset.review`、`delivery.ad.assign`、`delivery.plan.push`、`delivery.sample.qc`、`delivery.ticket.assign_editor`、`delivery.ticket.assign_publisher`、`publish.package.push`、`publish.link.verify`、`publish.account.verify`、`publish.patrol.do`、`publish.takedown.check`、`service.ticket.reply`、`finance.refund.approve`、`finance.refund.execute`、`finance.receipt.confirm`、`finance.invoice.issue`、`finance.recon.resolve`、`billing.adjust.approve`、`billing.extension.approve`、`order.export`、`finance.export`、`merchant.export`、`report.export`、`audit.export`、`export.unmasked`；增补表的键 `sys.super_admin`（A45，切换岗位视角）、`delivery.export`、`service.export`、`drama.export`、`billing.export`（A88）、`channel.export`（V1.1）、`report.month_close.reissue`（本文新增）、`flow.ops.view`（a01 登记，系统模块）。流程运维卡片的可见条件是“模块 `system` ≥ v 或持 `flow.ops.view`”，与 a01 的定时器、死信、不变量违规列表同一门槛（a01-system.md:96-101、130），保证有计数就能点进去。

## 2. 公共结构

### 2.1 本文通用口径

| 规则 | 内容 | 出处 |
| --- | --- | --- |
| 模块等级 | 后台 13 个模块键：`workbench`、`drama`、`billing`、`merchant`、`order`、`delivery`、`publish`、`service`、`finance`、`report`、`ops`、`system`、`channel`；等级取 `staff_role.module_levels`（`n` / `v` / `o` / `e`）。“模块 X ≥ v”指等级不为 `n`；不足返回 403 `PERMISSION_DENIED` | d7:955-1003；d4-identity.md:1227；03-staff-authz-audit.md:944 |
| 数据范围 | 列表、计数、搜索、预警、动态一律按员工的 `DataScope`（本人 / 本组 / 全部 + 待分配池）在服务端过滤，不是参数；范围外与不存在不区分（404） | d4-identity.md:1232-1347；C45、C58 |
| 报表范围 | 报表与今日数据是平台汇总口径（`scope: global`），有模块查看权即可见，不按负责人过滤；能下钻到商家明细行的报表导出按 `byStore` / `byEntity` 过滤（待业务确认，见第 6 节） | d4-identity.md:1306；d6:2133 |
| 日期边界 | “今日”“当月”“业务日”一律按北京时间（Asia/Shanghai）切分；积分与订阅按各表的 `biz_date`，收款按 `payment_txn.channel_success_at` 落日，退款按 `refund_txn.success_at` | d6:2041；d1:1609 |
| 金额 | 单个主体或单张单据的金额是 `integer(分)`；**跨主体的汇总金额**（报表、今日收款、待办副指标的合计金额）一律 `string(bigint)`，字段名仍以 `Fen` 结尾——月度快照 `report_month_close.payload` 与接口响应同构，快照里跨主体汇总金额就是字符串 | A90（C31 的例外）；14-config-data.md:1174；C33 |
| 积分 | `integer(积分)`；比例 `integer(万分比)`，字段名以 `Bp` 结尾 | C32 |
| 缓存 | 待办与角标按“员工 + 数据范围”缓存 30 秒；今日数据每张卡片各缓存 60 秒；当月报表缓存 60 秒。响应都带计算时刻（`updatedAt` / `asOfAt`），对应页面上的“数据更新于 10:30” | d3:3093-3097；d6:2039、2133 |
| 报表事务 | 每次报表计算在一个 `REPEATABLE READ, READ ONLY` 事务里完成，`statement_timeout = 5s`；超时返回 503 `BUSY` | d6:2038 |
| 轮询 | 待办、角标、动态、铃铛未读数建议 60 秒一次，窗口不可见时暂停；导出任务状态每 2 秒、至多 2 分钟 | d7:1005、1138-1151 |

### 2.2 `AdminLink` 后台页面链接

点击待办、预警、动态、搜索结果、站内消息后跳转的目标。与 `staff_message.link` 同一结构（13-notify-docs.md:1140）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `route` | enum(`AdminRouteKey`，x-open-enum) | 是 | 后台路由登记表（d7 第 5.2 节菜单登记表）的键，取值见第 4 节 | 计算；站内消息取 `staff_message.link` |
| `params` | object | 是 | 路由参数与筛选，如 `{ "tab": "assigning" }`、`{ "deliveryTicketId": "…" }`；没有为 `{}` | 计算 |

### 2.3 待办来源登记表

工作台“我的待办”与菜单角标共用的来源（d3:3061-3097）。每个来源由所属模块登记一个**计数函数**：与该队列的列表或 `summary` 接口共用同一个带范围的查询构造函数，保证“工作台上的数”等于“点进去看到的数”。下表 ①–⑩ 是原型的 10 张卡片（proto-admin-a.md:64、Main.dc.html），⑪–⑳ 是 d3:3089 列出的原型外来源中本文能落到数据模型的部分，㉑ 起是其他文档交给本文派生的来源：㉑ 待整理素材由 a03 提出（a03-merchant.md:1604）；㉒–㉗ 是交付侧来源，本表只定键、负责岗位、可见条件与角标，条件与副指标由 a05 登记计数函数（与 a05 的 `admin.deliveryTicket.list`、`admin.ad.list` 共用查询构造）。`TodoSourceKey` 归本文，新来源先在本表登记键再实现。

| # | `key` | 名称 | 负责岗位 `ownerRole` | 来源与条件 | 副指标 `sub` | 可见条件（另需数据范围） | 角标 `NavBadgeKey` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ① | `qualification_review` | 待审核商家 | `cs` | `approval_request.kind = 'qualification'` 且 `approval_request.status = 'pending'` | `earliest_submitted`：最早的 `approval_request.submitted_at`（“最早 09-29 提交”） | `merchant.qualification.review` | `merchant.review` |
| ② | `receipt_confirm` | 待确认收款 | `finance` | `transfer_proof.review_status = 'pending'` | `amount_total`：所属付款单 `billing_order.amount_fen` 之和（“合计 ¥55,000.00”） | `finance.receipt.confirm` | `order.receipts` |
| ③ | `ticket_assign` | 待分配工单 | `delivery_manager` | `delivery_ticket.step = 'assigning'`；a05 1.3 登记的计数函数（a05-order-delivery.md:167，跳转 `admin.deliveryTicket.list?tab=assigning`） | `nearest_due`：最早的 `delivery_ticket.step_due_at`（“11:12 前分配”） | `merchant.manager.assign`（主管另见待分配池） | `delivery.tickets` |
| ④ | `ad_produce` | 待制作广告 | `editor` | `ad.status` ∈ (`pending_assign`, `producing`, `revising`)；剪辑师只计 `ad.editor_id` 为本人的，`pending_assign` 只对持 `delivery.ad.assign` 者计入；a05 1.3 登记的计数函数（a05-order-delivery.md:172，跳转 `admin.ad.list?tab=todo`） | `due_today`：`ad.due_at` 落在今日的条数（“今日截止 2 条”） | 模块 `delivery` ≥ o | `delivery.ad_tasks` |
| ⑤ | `release_deliver` | 待交付成片 | `publisher` | `delivery_ticket.step = 'delivering'`；属 a05 的工单队列，a05 1.3 登记的计数函数（a05-order-delivery.md:168，跳转 `admin.deliveryTicket.list?tab=delivering`） | `overdue`：`delivery_ticket.step_due_at` < 当前时刻的条数（“超时 1 条”） | `publish.package.push` | `publish.deliveries` |
| ⑥ | `launch_verify` | 待核验上线 | `publisher` | `approval_request.kind = 'launch_link'` 且 `status = 'pending'`；处理人取 `approval_request.delivery_ticket_id` 所指工单的发布专员 | `due_today`：`approval_request.due_at` 落在今日的条数 | `publish.link.verify` | `publish.verify` |
| ⑦ | `plan_expiring` | 套餐即将到期 | `delivery_manager` | `subscription_term.status = 'active'`、`subscription_term.ends_at` 晚于当前时刻、`subscription_term.end_date` ≤ 今日 + 6 天，且该主体没有 `scheduled` 的后续周期；与 `admin.subscriptionTerm.summary` 的“7 天内到期”同一计数函数 | `none`（固定文案“7 天内到期未续费”） | 模块 `order` ≥ v | `order.renewals` |
| ⑧ | `takedown_check` | 待核查下架 | `publisher` | `takedown_task.status = 'merchant_confirmed'`，或 `status = 'pending_merchant'` 且 `takedown_task.due_date` < 今日；与 a06 `admin.takedownTask.summary` 的 `pending` 同一计数函数 | `overdue`：其中 `pending_merchant` 且已过应完成日的条数（“逾期未下架 1”） | `publish.takedown.check` | `publish.offline` |
| ⑨ | `service_ticket` | 待处理工单 | `cs` | `service_ticket.status` ∈ (`pending`, `processing`)；与 a08 `admin.serviceTicket.summary` 的 `counts.open` 同一计数函数 | `overdue`：`service_ticket.response_due_at` 非空且早于当前时刻的个数（“响应超时 1 个”），与 a08 的 `responseOverdue` 同一计数函数；不看 `first_response_at`（重开的轮次已有首次响应时间但仍在等待响应，12-support.md:220） | 模块 `service` ≥ v | `service.tickets` |
| ⑩ | `refund_approval` | 退款审批 | `finance` | `approval_request.kind` ∈ (`order_cancel`, `ad_cancel`, `qualification_cancel`, `plan_refund`) 且（`status = 'pending'`，或 `status = 'approved'` 且领域行 `cancel_request.status` / `refund_request.status` ∈ (`pending_execution`, `executing`)）；取消一侧用 a05 1.3 登记的计数函数（a05-order-delivery.md:176，`admin.cancelRequest.summary` 的 `inProgressCount`），退款一侧用 a07 `admin.refundRequest.summary` 的同一查询 | `points_total`：`cancel_request.total_refund_points` 之和（“退回 2,430 积分”），另给现金退款 `refund_request.amount_fen` 之和 | `finance.refund.approve` 或 `finance.refund.execute` | `finance.refunds` |
| ⑪ | `account_verify` | 待核验账号 | `publisher` | `approval_request.kind = 'channel_account'` 且 `status = 'pending'` | `earliest_submitted` | `publish.account.verify` | `publish.accounts` |
| ⑫ | `patrol_pending` | 待巡检 | `publisher` | `patrol_task.status = 'pending'`（跨周，往周没做完的仍计入）；与 a06 `admin.patrolTask.summary`（`openOnly=true`）的 `pending` 同一计数函数 | `none` | `publish.patrol.do` | `publish.patrol` |
| ⑬ | `points_adjust_approval` | 积分调整审批 | `finance` | `approval_request.kind = 'points_adjust'` 且 `status = 'pending'` | `overdue`：待审超期条数（见说明“审批超期”） | `billing.adjust.approve` | `finance.credit_adjust` |
| ⑭ | `term_extend_approval` | 补偿延长审批 | `delivery_manager` | `approval_request.kind = 'subscription_extend'` 且 `status = 'pending'`，只计发起人所在组（`approval_request.requester_staff_group_id`）是本人所在组的（仅主管） | `overdue`：待审超期条数 | `billing.extension.approve`（仅主管） | —（计入 `approval.mine`，见 2.8） |
| ⑮ | `account_change_approval` | 账号变更审批 | `cs` | `approval_request.kind = 'account_change'` 且 `status = 'pending'` | `overdue`：待审超期条数 | `merchant.account_change.approve` | —（计入 `approval.mine`，见 2.8） |
| ⑯ | `invoice_issue` | 待开票 | `finance` | `invoice_request.status` ∈ (`pending`, `red_pending`) | `amount_total`：`invoice_request.amount_fen` 之和 | `finance.invoice.issue` | `finance.invoices` |
| ⑰ | `recon_diff` | 对账差异 | `finance` | `payment_exception.status = 'open'` | `amount_total`：`payment_exception.amount_fen` 之和 | `finance.recon.resolve` | `finance.reconcile` |
| ⑱ | `manager_first_contact` | 待联系商家 | `delivery_manager` | `assignment_history.to_staff_id` = 本人、`contact_due_at` 非空、`contacted_at` 与 `contact_voided_at` 都为空（`ix_assignment_history_contact_pending`）；卡片点击到商家详情，处理动作是 a03 的 `admin.assignmentHistory.markContacted` | `nearest_due`：最早的 `assignment_history.contact_due_at` | 本人 | — |
| ⑲ | `follow_up_due` | 跟进到期 | `null`（按人不按岗） | `follow_up.owner_staff_id` = 本人、`next_follow_at` ≤ 当前时刻、`done_at` 为空（`ix_follow_up_owner_open`；含补发后确认商家已替换等系统待办） | `earliest_due`：最早的 `follow_up.next_follow_at` | 本人 | — |
| ⑳ | `flow_ops` | 流程运维 | `super_admin` | `timer.status = 'failed'` 的定时器数 + `outbox_delivery.status = 'dead'` 的投递数 + `invariant_violation.resolved_at` 与 `auto_healed_at` 都为空的违规数（d3:3089）；三项依次取 a01 导出的计数函数 `timers.countFailed`、`outbox.countDead`、`invariants.countOpen`，与三个明细列表的默认筛选同一查询（a01-system.md:2954） | `none`；明细见 a01 的 `admin.timer.list`、`admin.outboxDelivery.list`、`admin.invariantViolation.list`（“系统 › 流程运维”页，d3:3275-3283） | 模块 `system` ≥ v 或 `flow.ops.view`（与 a01 三个明细列表同一门槛） | `system.flow_ops` |
| ㉑ | `store_asset_review` | 待整理素材 | `delivery_manager` | `store_asset.review_state = 'unreviewed'`、`due_at` 非空、`deleted_at` 为空（`ix_store_asset_review_due`），按门店的数据范围 | `nearest_due`：最早的 `store_asset.due_at` | `merchant.asset.review` | — |
| ㉒ | `plan_push` | 待推送方案 | `delivery_manager` | a05 1.3 登记（a05-order-delivery.md:169）；跳转 `admin.deliveryTicket.list?todo=plan_push` | `nearest_due`（a05 1.3） | `delivery.plan.push` | — |
| ㉓ | `sample_qc` | 待质检样片 | `delivery_manager` | a05 1.3 登记（a05-order-delivery.md:170）；跳转 `admin.deliveryTicket.list?todo=sample_qc` | `nearest_due`（a05 1.3） | `delivery.sample.qc` | — |
| ㉔ | `staff_assign` | 待指派剪辑师或发布专员 | `delivery_manager` | a05 1.3 登记（a05-order-delivery.md:171；d3:992-993）；跳转 `admin.deliveryTicket.list?todo=staff_assign` | `none` | `delivery.ticket.assign_editor` 或 `delivery.ticket.assign_publisher` | — |
| ㉕ | `ad_waiting_qualification` | 广告等待资质 | `delivery_manager` | a05 1.3 登记（a05-order-delivery.md:173，与 `admin.ad.summary` 的 `waitingQualificationCount` 同口径）；跳转 `admin.ad.list?isWaitingQualification=true` | `none` | `delivery.ad.assign` | — |
| ㉖ | `ad_returned_stale` | 广告待补充超期 | `cs` | a05 1.3 登记（a05-order-delivery.md:174；与定时器 `ad.returned_stale` 同条件，d3:1390）；跳转 `admin.ad.list?tab=returned&isReturnedStale=true` | `earliest`：最早的 `ad.returned_at` | 模块 `delivery` ≥ v（a05-order-delivery.md:178） | — |
| ㉗ | `order_rejected_stale` | 待开工超期未补正 | `cs` | a05 1.3 登记（a05-order-delivery.md:175；与定时器 `order.rejected_stale` 同条件，d3:2972）；跳转 `admin.order.list?tab=pending_start&isRejectedStale=true` | `earliest`：最早的资质驳回时刻 | 模块 `order` ≥ v（a05-order-delivery.md:178） | — |

说明：

- 审批类来源（①⑥⑪⑬⑭⑮）的计数与 a01 `admin.approval.summary` 该 `kind` 的 `todo` 同一计数函数，另按该 `kind` 的读权限与数据范围过滤（d3:3074）；有执行步的四类（⑩）在“审批与执行中”都计入，与退款管理页“审批与执行中”页签同口径（`admin.cancelRequest.summary`、`admin.refundRequest.summary`）。
- 审批超期（⑬⑭⑮ 的 `overdue`）：`status = 'pending'`，且 `approval_request.due_at` 非空并已过，或 `due_at` 为空（V1.0 不设决定时限的类型，A93）并且提交已超过参数 `approval.escalate_workdays` 个工作日（按工作日历，03-staff-authz-audit.md:832）；与 a01 `admin.approval.summary` 该类的 `overdue` 同一计数函数。
- `ownerRole` 为 `null` 的来源按人不按岗：只在 `tab = all` 出现，只计本人；⑱ 在超级管理员切到交付经理视角时按“全部”范围计（全体交付经理的待联系）。
- ㉑ 的跳转目标是跨门店的待整理素材队列（`AdminRouteKey` 的 `merchant.asset_review`），原型没有这一页（是否做由第 6 节第 5 项定）；a03 的 `admin.storeAsset.list`、`admin.storeAsset.summary` 已在 `tab = organizing` 时允许不传 `storeId`（跨门店队列，按门店的数据范围过滤，默认 `sort = reviewDueAt`，行带 `storeName`，与 ㉑ 共用同一个带范围的查询构造函数；a03-merchant.md:1651、1667）。
- ③④⑤、㉒–㉗ 与 ⑩ 的取消一侧的计数函数、跳转目标与预置筛选由 a05 1.3 登记（a05-order-delivery.md:163-178），上表照抄其跳转；㉖㉗ 的副指标 `earliest` 是 a05 新提的类型（第 4 节 `TodoSubKind` 已补）。㉒–㉗ 不挂角标，交付与订单菜单的角标仍只按原型的来源求和。
- 计数函数不读缓存列以外的派生值：逾期、今日截止都按请求时刻现算。
- “今日”按北京时间；“当前时刻”取服务端时钟。

### 2.4 `TodoBoard`、`TodoCard`、`TodoSub` 我的待办

`TodoBoard`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `tab` | enum(`WorkbenchTab`) | 是 | 本次的岗位视角 | 请求 |
| `availableTabs` | array<enum(`WorkbenchTab`)> | 是 | 本人可切换的视角：持 `sys.super_admin` 的为全部 6 个，其余员工只有 `all` | 权限点 `sys.super_admin`（A45、C66：不在处理器里写死角色判断） |
| `total` | integer | 是 | 本次返回的卡片计数之和（“共 N 项”） | 计算 |
| `items` | array<`TodoCard`> | 是 | 按 2.3 的序号排列；没有可见来源时为 `[]` | 计算 |
| `updatedAt` | string(date-time) | 是 | 各卡片计数中最早的计算时刻（缓存 30 秒） | 计算 |

`TodoCard`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `key` | enum(`TodoSourceKey`) | 是 | 来源键（2.3） | 登记表 |
| `label` | string | 是 | 卡片标题，如“待审核商家” | 登记表 |
| `ownerRole` | enum(`StaffRoleKey`) \| null | 是 | 负责岗位；视角切换按它过滤。`null` = 按人不按岗（⑲），只在 `tab = all` 返回 | 登记表；同数据模型 `staff_role.key` |
| `count` | integer | 是 | 计数（数据范围内） | 计数函数 |
| `sub` | `TodoSub` | 是 | 副指标；没有时 `kind = none` | 计数函数 |
| `link` | `AdminLink` | 是 | 点击直达的处理页与预置筛选 | 登记表 |
| `isDegraded` | boolean | 是 | 该来源本次计数失败或超时（返回上次缓存值或 0），前端显示“—” | 计算 |

`TodoSub`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `kind` | enum(`TodoSubKind`) | 是 | `earliest_submitted` / `earliest_due` / `nearest_due` / `earliest` 用 `at`；`amount_total` 用 `amountFen`；`due_today` / `overdue` 用 `count`；`points_total` 用 `points`（另可带 `amountFen`）；`none` 全空 | 登记表 |
| `at` | string(date-time) \| null | 是 | 时刻型副指标 | 计数函数 |
| `amountFen` | string(bigint) \| null | 是 | 合计金额（跨主体汇总） | 计数函数 |
| `points` | integer \| null | 是 | 合计积分 | 计数函数 |
| `count` | integer \| null | 是 | 条数型副指标 | 计数函数 |

### 2.5 `TodayBoard`、`TodayCard` 今日数据

只返回本人有权看到的卡片（d6:2121“没有权限的卡片不出现在响应里”）。卡片是全公司的聚合数，不随数据范围变化（d6:2133）。“今日”= 北京时间当日 00:00 至请求时刻。

`TodayBoard`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `date` | string(date) | 是 | 今日（北京时间） | 服务端时钟 |
| `updatedAt` | string(date-time) | 是 | 各卡片计算时刻中最早的一个（页头“数据更新于 10:30”） | 计算 |
| `cards` | array<`TodayCard`> | 是 | 按下表顺序 | 计算 |

`TodayCard`（按 `key` 判别）：

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `key` | enum(`TodayCardKey`) | 是 | 卡片键 |
| `state` | enum(`ok` / `unavailable`) | 是 | 单卡查询超过 300 毫秒或出错为 `unavailable`，`metrics` 为 null，前端显示“—”（d6:2133） |
| `updatedAt` | string(date-time) | 是 | 本卡的计算时刻（各卡缓存 60 秒） |
| `metrics` | object \| null | 是 | 按 `key` 取下表之一 |

| `key` | 可见条件 | `metrics` 字段 | 口径与来源 |
| --- | --- | --- | --- |
| `new_merchants` 今日新增商家 | 模块 `merchant` ≥ v | `count` integer；`yesterdayCount` integer（“较昨日 +3”由前端相减） | `entity.created_at` 落在今日（昨日）、`entity.lifecycle = 'active'` 的主体数（d6:2125） |
| `orders` 今日订购 | 模块 `order` ≥ v；两个积分字段另需模块 `billing` ≥ v，否则为 null | `submittedItemCount` integer；`startedItemCount` integer；`heldPoints` integer \| null；`capturedPoints` integer \| null | 提交部数：所属 `drama_order.submitted_at` 落在今日的订单项数；开工部数：`order_item.captured_at` 落在今日的订单项数（与月报“订购部数”同口径，d6:2060-2061）；冻结积分：`point_ledger_entry` 中 `available → held`、所属 `point_hold.purpose = 'order_item'`、`biz_date` 为今日的 `qty` 之和；扣减积分：同条件的 `held → consumed` |
| `receipts` 今日收款 | 模块 `report` 或 `finance` ≥ v | `amountFen` string(bigint)；`planAmountFen` string(bigint)；`topupAmountFen` string(bigint)；`newPlanCount` integer；`renewPlanCount` integer | `payment_txn.status = 'succeeded'`、`payment_txn.applied_at` 非空、`payment_txn.channel_success_at` 落在今日的 `channel_amount_fen` 之和；按入账付款单 `billing_order.type` 拆：套餐 = `plan_new`、`plan_renew`、`plan_upgrade`，加购 = `topup`；新开通、续费套餐数取当日订阅事件（d6:2127），与月报 `newCount`、`renewCount` 同一组指标函数：`subscription_event.biz_date` 为今日的 `activated`（所属 `subscription_term.origin = 'new'`），以及 `renewal_scheduled` 加 `activated`（`origin = 'resume'`），按主体去重。履约受阻的付款单没有订阅事件，只计入收款额（d1:1630） |
| `active_plans` 套餐生效商家 | 模块 `billing` ≥ v | `activeCount` integer；`expiringIn7dCount` integer；`expiredNotRenewedCount` integer | 生效：`subscription_term.status = 'active'` 且 `subscription_term.ends_at` 晚于当前时刻的主体数（按周期起止现算，不读 `billing_account.sub_status` 缓存，与 m07 同一规则）；7 天内到期与已过期未续费：与 `admin.subscriptionTerm.summary` 同一计数函数（7 天内到期未续费；过期 30 天内未续费） |
| `live_items` 上线中剧目 | 模块 `publish` ≥ v | `liveItemCount` integer | `order_item.phase = 'live'` 的订单项数（PRD §7.1 有、原型无，d6:2129） |

### 2.6 `WorkbenchAlert` 预警

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `kind` | enum(`AlertKind`) | 是 | 四类之一 | 计算 |
| `subjectType` | string | 是 | 对象表名：`delivery_ticket`、`order_item`、`takedown_task`、`drama` | 计算 |
| `subjectId` | string(uuid) | 是 | 对象 id | 同上 |
| `storeId` | string(uuid) \| null | 是 | 门店；版权到期为 null | 对象的 `store_id` |
| `storeName` | string \| null | 是 | 门店名（“星河洗车”） | `store.name` |
| `dramaTitle` | string | 是 | 剧名（“夜巷疑云”） | `drama.title` |
| `detail` | object | 是 | 按 `kind` 取下表之一 | 计算 |
| `link` | `AdminLink` | 是 | “查看”跳转：工单详情、逾期跟踪、下架核查、短剧编辑 | 计算 |

| `kind` | 条件 | `detail` 字段 |
| --- | --- | --- |
| `ticket_overdue` 超时工单 | `delivery_ticket.step` 不是 `archived`、`terminated`，`delivery_ticket.paused_at` 为空，`delivery_ticket.step_due_at` < 当前时刻（d3:3091） | `ticketNo`（`delivery_ticket.ticket_no`）；`step`（同数据模型 `delivery_ticket.step`）；`dueAt`（`step_due_at`）；`overdueMinutes` integer（现算） |
| `launch_overdue` 逾期未上线 | 发布模块的只读端口 `publish.listOverdueLaunchItems` 的结果（派生判定，不落库；11-publish.md:313、673） | `orderItemId`；`agreedLaunchDate`（`order_item.agreed_launch_date`）；`overdueDays` integer；`isUsagePeriodExtended` boolean（恒为 false，对应“使用期不顺延”） |
| `takedown_overdue` 逾期未下架 | `takedown_task.status = 'pending_merchant'` 且 `takedown_task.due_date` < 今日 | `usageEndDate`（`takedown_task.usage_end_date`）；`dueDate`（`takedown_task.due_date`）；`escalatedAt`（`takedown_task.escalated_at`，非空即“已升级至交付主管”） |
| `copyright_expiring` 版权即将到期 | `drama.status = 'listed'` 且 a04 的 `isExpiringSoon` 为真：止日在今天起 N 天内（含今天），N = 参数 `remind.copyright.days`（默认 90，PRD §7.2）；与 a04 `admin.drama.summary` 的 `expiringSoon` 共用判定函数（a04-content.md:74-78） | `licenseEndDate`（`drama_copyright.license_end_date`）；`stopOrderDate`（停止订购日，同 a04 的 `stopOrderDate`：止日往前数计费参数 `minLicenseMonths` 个自然月，当月无此日取月末）；`liveItems`（integer \| null，`drama_stat.live_items`，同 a04 字段名；没有统计行为 null） |

### 2.7 `FeedItem` 实时动态

读审计日志的活动流（`audit_log` 的 `ops`、`activity` 两条流；03-staff-authz-audit.md:560“工作台实时动态统一读它”），只取与商家相关（`audit_log.entity_id` 非空）的行。

`FeedItem` = a01 的 `AuditLogItem`（a01-system.md 2.11，审计日志行的唯一结构）的全部字段，另加 `link`。同一行审计日志在操作日志、商家详情的动态与工作台里是同一个结构：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `auditLogId`、`logNo`、`createdAt`、`stream`、`category`、`action`、`summary`、`actor`、`target`、`entityId`、`storeId` | 同 `AuditLogItem` | 是 | `createdAt` 供前端按日分组（“今日”）；`summary` 是写入时渲染好的中文标题，如“好运来便利店创建付款单（开通基础版），待支付”；`actor` 为 `{ actorType, actorId, name, role, client }`；`target` 为 `{ type, id, key, label }` 或 null | 同 a01 2.11 |
| `link` | `AdminLink` \| null | 是 | 按 `target.type` 映射的详情页；没有对应页面为 null | 计算 |

**审计类别到菜单模块的对照**（实时动态按它裁剪：类别所属模块的等级为 `n` 的行不返回）。本表归本文维护；登记新的 `audit_log.category` 的文档同时在本表补一行，未登记模块的类别不返回（宁缺不漏）。

| `audit_log.category` | 所属菜单 `MenuKey` |
| --- | --- |
| `refund`、`points_adjust` | `finance` |
| `payment`、`invoice`、`recon`、`finance_config` | `finance`（a07 的付款单、凭证、开票、对账差异与收款账户配置；a09 的发票邮件重发） |
| `term_adjust` | `order`（套餐到期页在订单菜单） |
| `docs` | `order`（授权书更正、作废并重出，a05 3.48、3.49，权限点 `order.license_letter.manage`） |
| `delivery` | `delivery`（a05 的交付活动流，如改约定上线日） |
| `service_ticket` | `service`（a08 工单的内容编辑与分配） |
| `approval`、`review` | 按 `approval_request.kind` 所属模块（a01 审批类型表的查看模块；03-staff-authz-audit.md:640） |
| `flow` | `system`（人工纠偏，a08 3.10，权限点 `flow.admin.transition`） |
| `price_adjust`、`points_expire`、`points_grant`、`plan_config` | `billing` |
| `profile_edit`、`member`、`account_security`、`manager_assign`、`merchant_quota`、`merchant_lifecycle`、`referral_code` | `merchant` |
| `staff_authz`、`param`、`dict`、`export`、`pii_reveal`、`file_access`、`system_ops` | `system` |
| `report` | `report` |
| `ops_config`、`agreement`、`notify_config` | `ops` |
| 各业务模块的活动流类别（订购、广告、交付、发布、素材、客服等，03-staff-authz-audit.md:931“随模块登记”） | 登记时由该模块填写（订购 `order`；广告与交付 `delivery`；发布 `publish`；素材 `merchant`；客服 `service`；付款与发票 `finance`） |

`system_ops`、`report`、`merchant_quota`、`merchant_lifecycle`、`referral_code`、`ops_config`、`agreement`、`notify_config` 是 A107 要求补登的审计类别；`payment`、`invoice`、`recon`、`finance_config`、`docs`、`delivery`、`service_ticket`、`approval`、`review`、`flow` 是 A155 补登的类别；上表共 35 个类别（03 分组第 3 节的 17 个 + A107 的 8 个 + A155 的 10 个），按 A155 连同 A107 的一并回写数据模型 03 分组的类别清单（03-staff-authz-audit.md:931），与 a01 审计日志的类别筛选（a01-system.md 第 4 节 `auditCategory`）一致；`pii_reveal`、`file_access` 属 `access` 流，实时动态本来不读，列出只为对照完整。

### 2.8 `NavBadges` 菜单角标

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `updatedAt` | string(date-time) | 是 | 计算时刻（缓存 30 秒） | 计算 |
| `items` | array<object> | 是 | 二级菜单角标：本人有权看到的项全部返回（含 0，便于清除旧角标） | 计算 |
| `items[].key` | enum(`NavBadgeKey`) | 是 | 二级菜单项 | 登记表 |
| `items[].menu` | enum(`MenuKey`) | 是 | 所属一级菜单（模块键） | 登记表 |
| `items[].count` | integer | 是 | = 映射到该项的来源（2.3 最后一列）计数之和。例外：`approval.mine`（“我的待审批”）直接取 a01 `admin.approval.summary` 的 `total.todo`（全部本人可决定类型之和，与该页 `tab = todo`、不传 `kind` 同一查询，a01-system.md:1730、1768），不由 2.3 的来源求和 | 计数函数 |
| `menus` | array<object> | 是 | 一级菜单角标 | 计算 |
| `menus[].menu` | enum(`MenuKey`) | 是 | 一级菜单 | 登记表 |
| `menus[].count` | integer | 是 | = 该菜单下 `items[].count` 之和（原型“财务 8” = 1 + 2 + 4 + 1，proto-admin-d.md:31） | 计算 |

### 2.9 `SearchResult`、`SearchHit` 全局搜索

`SearchResult`：

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `q` | string | 是 | 规范化后的关键词（去首尾空白；单号部分转大写） |
| `groups` | array<object> | 是 | 每个本人可见的类型一组，按 `SearchHitType` 的顺序；没有命中的类型不返回 |
| `groups[].type` | enum(`SearchHitType`) | 是 | 类型 |
| `groups[].items` | array<`SearchHit`> | 是 | 至多 5 条 |
| `groups[].hasMore` | boolean | 是 | 是否还有更多；前端“查看全部”跳该类型的列表页并带 `q` |

`SearchHit`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `type` | enum(`SearchHitType`) | 是 | 类型 | 计算 |
| `id` | string(uuid) | 是 | 对象 id | 各表 `id` |
| `title` | string | 是 | 门店名，或单号。还没有店名的草稿门店（资质未提交，`store.name` 为空，`ck_store_name_required`）不进搜索结果，所以总有值 | `store.name`；`drama_order.order_no`、`billing_order.order_no`、`delivery_ticket.ticket_no`、`service_ticket.ticket_no` |
| `subtitle` | string \| null | 是 | 门店命中时为主体名；单号命中时为门店名（工单另加剧名） | `entity.name`、`store.name`、`drama.title` |
| `link` | `AdminLink` | 是 | 详情页 | 计算 |

### 2.10 `StaffMessageItem`、`StaffMessageSummary` 站内消息

`StaffMessageItem`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `staffMessageId` | string(uuid) | 是 | 消息 id | `staff_message.id` |
| `kind` | enum(`StaffMessageKind`) | 是 | 类别 | `staff_message.kind` |
| `title` | string | 是 | 标题（≤40 字） | `staff_message.title` |
| `body` | string | 是 | 正文（≤200 字） | `staff_message.body` |
| `link` | `AdminLink` | 是 | 跳转目标 | `staff_message.link` |
| `readAt` | string(date-time) \| null | 是 | 已读时间；null = 未读 | `staff_message.read_at` |
| `createdAt` | string(date-time) | 是 | 时间 | `staff_message.created_at` |

`StaffMessageSummary`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `unreadTotal` | integer | 是 | 未读总数（铃铛“5 条未读”、未读点） | `staff_message.read_at` 为空的行数（部分索引 `ix_staff_message_unread`） |
| `unreadByKind` | object | 是 | `{ todo, alert, approval, system }` 各自的未读数 | 同上按 `staff_message.kind` 分组 |

### 2.11 `OverviewReport` 经营概览

`billing`、`cash`、`orders`、`cross` 四块与月度快照 `report_month_close.payload` 同构（14-config-data.md:1165-1176）：已月结月份直接取快照，当月与未月结的历史月实时聚合后按同一结构返回。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `month` | string（`YYYY-MM`） | 是 | 报表月份 | 请求 |
| `monthRange` | object | 是 | `{ earliest, latest }`：可查询的月份范围（最早为有每日快照的首月，最晚为当月），供月份切换禁用 | `billing_entity_daily.biz_date` 的最小值；服务端时钟 |
| `source` | enum(`ReportSource`) | 是 | `snapshot` 已月结、取快照；`live` 实时聚合（当月，或尚未月结的历史月，页面标“未月结”） | 计算 |
| `asOfAt` | string(date-time) | 是 | `live` 为计算时刻（“本月数据更新于 09-30 10:30”）；`snapshot` 为 `report_month_close.closed_at`（“8 月数据已于 09-01 完成结算”） | 计算 |
| `close` | object \| null | 是 | 快照信息：`{ reportMonthCloseId, revisionNo, cutoffAt, closedAt }`；`live` 为 null | `report_month_close.id`、`revision_no`、`cutoff_at`、`closed_at` |
| `metricDefVersion` | integer | 是 | 指标口径版本 | `report_month_close.metric_def_version`；实时为代码常量 `METRIC_DEF_VERSION` |
| `finality` | object | 是 | 各指标是否最终值，如 `{ "renewalRate": "provisional" }`；未列出的为最终值 | `report_month_close.finality`；实时按“到期满 7 天”判定 |
| `billing` | `OverviewBilling` | 是 | 积分与订阅类，取计费口径 | 见下 |
| `cash` | `OverviewCash` | 是 | 收款与退款 | 见下 |
| `orders` | `OverviewOrders` | 是 | 订购部数等 | 见下 |
| `cross` | `OverviewCross` | 是 | 分布与跨域比率 | 见下 |
| `comparison` | object | 是 | 环比：`{ prevMonth, mrrFen, payingEntityCount }`，上月的对应值（上月已月结取快照）；上月超出范围时两值为 null | 计算 |
| `mrrTrend` | array<object> | 是 | 近 6 个月（含本月）：`{ month, mrrFen, source }` | 前 5 个月已月结的取快照，其余实时 |

`OverviewBilling`（d6:2049-2063；d1:1617-1630）：

| 字段 | 类型 | 必有 | 说明 | 来源（实时口径） |
| --- | --- | --- | --- | --- |
| `mrrFen` | string(bigint) | 是 | 月度经常性收入：月末（当月取最新一日）各主体 MRR 之和 | `billing_entity_daily.mrr_fen` 之和 |
| `payingEntityCount` | integer | 是 | 付费主体数：当月任一日生效的主体去重 | `billing_entity_daily.sub_status = 'active'` |
| `newCount` | integer | 是 | 新开通家数 | `subscription_event.type = 'activated'` 且所属 `subscription_term.origin = 'new'`，按 `subscription_event.biz_date` 落月，按主体去重 |
| `renewCount` | integer | 是 | 续费家数（当月发生的续费） | `subscription_event.type = 'renewal_scheduled'`，加 `activated` 且所属周期 `origin = 'resume'`（过期后重新开通），按 `biz_date` 落月、按主体去重（d1:1623）。`resumed` 事件是延长审批复活到期周期（x01-events-jobs.md:282），不是续费，不计入。今日卡片与 a07 的“本月续费”共用这一指标函数 |
| `upgradeCount` | integer | 是 | 升级家数（“另有升级 6 家”） | `subscription_event.type = 'upgraded'` |
| `renewalDueCount` | integer | 是 | 续费率分母：`subscription_term.end_date` 落在当月且未退款的主体（“到期 142 家”） | `subscription_term` |
| `renewalDoneCount` | integer | 是 | 续费率分子：其中下一周期的付款单在止日后 7 天内付清（含提前续费）（“续费 118 家”） | `subscription_term.source_billing_order_id` → `billing_order.paid_at` |
| `renewalRateBp` | integer \| null | 是 | 续费率；分母为 0 时 null；到期满 7 天前在 `finality` 里标 `provisional` | 计算 |
| `upgradeRateBp` | integer \| null | 是 | 升级率（PRD §7.10 有，原型未展示） | d1:1625 |
| `topupRateBp` | integer \| null | 是 | 加购率（PRD §9.1 有，原型未展示） | d1:1626 |
| `consumedPoints` | integer | 是 | 积分消耗（与 `PointsFlow.consumedPoints` 同一指标） | `point_ledger_entry` 中 `held → consumed`、`biz_date` 落在当月的 `qty` 之和 |
| `consumptionRateBp` | integer \| null | 是 | 消耗率 = 消耗 ÷（月初负债 + 当月发放 + 当月加购） | 月初负债取上月末 `billing_entity_daily.liability_points` 之和 |
| `payingEntitiesByPlan` | array<object> | 是 | 付费主体按版本：`{ planId, planName, count }`。人群与 `payingEntityCount` 相同（当月任一日生效的主体），各项之和等于付费主体数（原型 94 + 71 + 21 = 186） | 每个主体取当月最后一个 `sub_status = 'active'` 日的 `billing_entity_daily.plan_id`；`plan.name` |

`OverviewCash`（本模块自己算；d6:2041、2051-2053、2113）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `receivedFen` | string(bigint) | 是 | 收款额：渠道成功时间落在当月的已入账收款；对公以财务确认到账为准；退款单列、不冲减 | `payment_txn.channel_amount_fen`，条件 `status = 'succeeded'`、`applied_at` 非空、`channel_success_at` 落月；已月结月份另要求 `payment_txn.applied_at` ≤ `report_month_close.cutoff_at` |
| `receivedByType` | array<object> | 是 | `{ type, amountFen, count }`，`type` 同数据模型 `billing_order.type`（新开通、续费、升级补差、加购） | 入账付款单的 `billing_order.type` |
| `receivedByPlan` | array<object> | 是 | 套餐收款按版本：`{ planId, planName, amountFen }` | `billing_order.content_snapshot` 的 `planId`（升级取 `toPlanRevisionId` 所属套餐）；`plan.name` |
| `receivedByCycle` | array<object> | 是 | 套餐收款按购买周期：`{ months, amountFen }`。与“按版本”同一口径：三项都是套餐收款（新开通 + 续费 + 升级补差），各项之和等于套餐收款额（原型 452,800 + 174,000 + 72,000 = 171,000 + 516,000 + 11,800） | 套餐单取 `billing_order.content_snapshot` 的 `months`；升级补差单按被升级周期的购买月数归入：快照的 `termId` → `subscription_term.months` |
| `dailyReceipts` | array<object> | 是 | 每日收款额：`{ date, amountFen }`，当月每天一行（当月只到今日，今日为截至 `asOfAt`） | 按 `channel_success_at` 的北京时间日期分组 |
| `refundFen` | string(bigint) | 是 | 退款额（单列） | `refund_txn.status = 'succeeded'`、`refund_txn.success_at` 落月的 `amount_fen` 之和 |
| `refundCount` | integer | 是 | 退款笔数 | 同上 |
| `priorMonthAdjustment` | object | 是 | 上月调整：`{ amountFen, count }`——渠道成功时间属于上月、但上月月结截止后才入账的收款；上月未月结时两值为 `"0"` 与 0 | 上月快照的 `cutoff_at` 与本月入账的收款 |

`OverviewOrders`（14-config-data.md:1171）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `startedItemCount` | integer | 是 | 订购部数：当月开工（扣减）的订单项数 | `order_item.captured_at` 落月 |
| `submittedItemCount` | integer | 是 | 提交部数 | 所属 `drama_order.submitted_at` 落月的订单项数 |
| `orderCount` | integer | 是 | 订购单数（“订购单 305”） | `drama_order.submitted_at` 落月 |
| `adCount` | integer | 是 | 广告条数 = 当月提交的新广告 + 当月超额修改次数（“广告 311 条”） | `ad.submitted_at` 落月；`ad_revision.is_chargeable` 为真且 `ad_revision.created_at` 落月 |

`OverviewCross`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `payingEntitiesByIndustry` | array<object> | 是 | 付费主体按行业：`{ industryCode, count }`，前 4 名加“其他”（`industryCode = null`）；行业名由前端按字典 `industry` 渲染。人群与 `payingEntityCount` 相同，各项之和等于付费主体数（原型 92 + 23 + 18 + 15 + 38 = 186） | 当月任一日生效的主体的首店（`store.is_primary`）档案 `store_profile.industry_code`；没有档案或行业为空的计入“其他” |

### 2.12 `PointsReport` 积分报表

数字全部取计费口径（d6:2065-2080；d1:1568-1607）。V1.0 只有实时聚合：月度快照的 `report_key` 只有 `overview`（`ck_report_month_close_report_key`），计费月结表上线时不建（M10），历史月份由账本流水与每日快照现算（A106）；计费月结补建后已月结月份改读其结果（07 提供只读端口），响应结构不变。

折合预收款的取数（`liability.valueFen` 与 `PointsSourceRow.valueFen` 同一规则，07-billing-ledger.md:1140）：只取 `point_entry_valuation.valuation_policy_version_no = valuationPolicyVersionNo` 的行；每个 `point_lot_id` 取 `point_ledger_entry_seq` 最大的一行（索引 `ix_point_entry_valuation_lot_version_entry_seq` 倒序取第一行），再对 `remaining_value_fen` 求和；历史月另加 `biz_date` ≤ 月末。“当前版本”= `max(valuation_policy.version_no)`（07-billing-ledger.md:1635）。不加版本条件或不按批次取最新一行，会把历史行与多个版本的行一并加总，金额成倍放大。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `month` | string（`YYYY-MM`） | 是 | 报表月份 | 请求 |
| `monthRange` | object | 是 | 同 `OverviewReport.monthRange` | 计算 |
| `asOfAt` | string(date-time) | 是 | 计算时刻（“截至 09-30 10:30”） | 计算 |
| `valuationPolicyVersionNo` | integer | 是 | 折合预收款所用的估值口径版本 | `max(valuation_policy.version_no)` |
| `liability` | object | 是 | `{ points, valueFen, deferredPlanFeeFen, asOfAt }`：积分负债（可用 + 冻结，含停用的加购）、折合预收款、未发放月份的预收套餐款；当月取实时，历史月取月末快照 | 当月：`point_lot.available_qty` + `held_qty` 之和；折合预收款按上文规则（当前口径版本、每批次最新一条估值行）；`grant_schedule.status = 'pending'` 的 `value_fen` 之和。历史月：月末 `billing_entity_daily.liability_points`、`liability_value_fen`、`deferred_plan_fee_fen` 之和 |
| `flow` | `PointsFlow` | 是 | 当月积分流转（恒等式） | 见下 |
| `consumption` | object | 是 | 消耗构成：`{ dramaOrderPoints, adPoints, adRevisionPoints, topModelSurchargePoints, startedItemCount, newAdCount, overageRevisionCount }` | `held → consumed` 流水按 `point_hold.purpose` 拆；顶级模型加扣取 `point_hold.pricing_snapshot`（加扣 = S − round(P × R)，d1:1591） |
| `rates` | object | 是 | `{ consumptionRateBp, expiredOfGrantedBp }`：消耗率；清零占本月发放 | 计算 |
| `trend` | array<object> | 是 | 近 6 个月：`{ month, grantedPoints, consumedPoints, expiredPoints, consumptionRateBp }` | 按 `point_ledger_entry.biz_date` 归月 |
| `bySource` | array<`PointsSourceRow`> | 是 | 按积分来源：每个套餐版本一行，加购积分一行 | 见下 |
| `totals` | `PointsSourceRow` | 是 | 合计行（`sourceGroup = all`） | 计算 |

`PointsFlow`（d1:1570-1592；`point_ledger_entry` 的合法移动见 07-billing-ledger.md:1388-1407，按 `biz_date` 落月）：

| 字段 | 类型 | 必有 | 说明 | 移动 |
| --- | --- | --- | --- | --- |
| `openingPoints` | integer | 是 | 月初负债（上月末 24:00） | 上月末 `billing_entity_daily.liability_points` 之和 |
| `openingAt` | string(date-time) | 是 | 月初时点 | 计算 |
| `grantedPoints` | integer | 是 | 发放（月度发放 + 升级补发） | `external → available`，批次 `point_lot.source_type` ∈ (`grant_monthly`, `grant_upgrade`) |
| `upgradeGrantedPoints` | integer | 是 | 其中升级补发 | 同上，`grant_upgrade` |
| `purchasedPoints` | integer | 是 | 加购 | `external → available`，`purchase` |
| `purchaseCount` | integer | 是 | 加购笔数（“39 笔”） | 当月入账的 `purchase` 批次数 |
| `purchaseAmountFen` | string(bigint) | 是 | 加购金额 | 这些批次的 `point_lot.cost_basis_fen` 之和 |
| `returnedPoints` | integer | 是 | 退回（只计开工后退回） | `consumed → available` |
| `returnHoldCount` | integer | 是 | 有退回的冻结单数（“取消与售后 11 单”） | 上一行的 `point_ledger_entry.point_hold_id` 去重 |
| `adjustedInPoints` | integer | 是 | 调整增加 | `external → available`，`adjust` |
| `convertedInPoints` | integer | 是 | 转入加购（原周期已结束的退回） | `external → available`，`conversion` |
| `unexpiredPoints` | integer | 是 | 清零冲回（仅延长补批） | `expired → available` |
| `consumedPoints` | integer | 是 | 消耗 | `held → consumed` |
| `expiredPoints` | integer | 是 | 清零 | `available → expired`、`held → expired` |
| `convertedOutPoints` | integer | 是 | 转出 | `held → converted_out` |
| `adjustedOutPoints` | integer | 是 | 调整扣减 | `available → adjusted_out` |
| `revokedPoints` | integer | 是 | 套餐退款作废 | `available → revoked` |
| `releasedPoints` | integer | 是 | 开工前释放（不进恒等式，单列） | `held → available` |
| `closingPoints` | integer | 是 | 月末负债（当月为截至 `asOfAt`） | = 月初 + 增加各项 − 减少各项 |
| `closingAt` | string(date-time) | 是 | 月末时点或 `asOfAt` | 计算 |

`PointsSourceRow`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `sourceGroup` | enum(`PointSourceGroup`) | 是 | `plan` 套餐积分 / `addon` 加购积分 / `all` 合计 | `point_ledger_entry.lot_kind` |
| `planId` | string(uuid) \| null | 是 | 套餐版本；`addon`、`all` 为 null | `point_ledger_entry.plan_id` |
| `planName` | string \| null | 是 | 版本名（“专业版套餐积分”由前端拼） | `plan.name` |
| `inflowPoints` | integer | 是 | 当月发放或加购 | 同 `PointsFlow` |
| `consumedPoints` | integer | 是 | 当月消耗 | 同上 |
| `expiredPoints` | integer \| null | 是 | 当月清零；加购积分不清零为 null（“不清零”） | 同上 |
| `balancePoints` | integer | 是 | 余额（含冻结；退回计入原来源）：当月为当前余额，历史月为月末余额 | 当月同 `liability.points` 按来源拆；历史月按 `point_ledger_entry` 回放到月末（`biz_date` ≤ 月末）按来源累计 |
| `valueFen` | string(bigint) | 是 | 折合预收款（逐批结果，精确到分）。页面的折算单价 = `valueFen ÷ balancePoints`，前端显示到分，余额为 0 时显示“—”；与原型“余额 × 单价 = 折合预收款”自洽（d6:2075“来源分组内价值合计 ÷ 积分合计”） | 按 2.12 开头的规则，再按批次的来源（`point_lot.kind`、`point_lot.plan_id`）分组求和 |

### 2.13 `ReportMonthCloseItem` 报表月度快照

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `reportMonthCloseId` | string(uuid) | 是 | 快照行 id | `report_month_close.id` |
| `reportKey` | enum(`ReportKey`) | 是 | 报表键 | `report_month_close.report_key` |
| `month` | string（`YYYY-MM`） | 是 | 月份 | `report_month_close.month_date` 取年月 |
| `revisionNo` | integer | 是 | 修订号：1 正常、2 续费率定稿，重出继续递增 | `report_month_close.revision_no` |
| `status` | enum(`ReportMonthCloseStatus`) | 是 | 当前有效 / 已被取代 | `report_month_close.status` |
| `finality` | object | 是 | 各指标是否最终值 | `report_month_close.finality` |
| `metricDefVersion` | integer | 是 | 指标口径版本 | `report_month_close.metric_def_version` |
| `cutoffAt` | string(date-time) | 是 | 固化截止时刻（收款按它截止） | `report_month_close.cutoff_at` |
| `closedAt` | string(date-time) | 是 | 写入快照的时间 | `report_month_close.closed_at` |
| `closedBy` | object \| null | 是 | 重出快照的员工 `{ staffId, name }`；系统固化（月结订阅者、`reports.finalize` 定稿）为 null | `report_month_close.closed_by_staff_id`；`staff.name` |
| `reason` | string \| null | 是 | 重出原因 | `report_month_close.reason` |
| `billingMonthCloseId` | string(uuid) \| null | 是 | 所拷贝的计费月结行 | `report_month_close.billing_month_close_id` |
| `actions` | array<enum(`ReportMonthCloseAction`)> | 是 | 当前员工可执行的动作：`closed` 且持 `report.month_close.reissue` 时为 `["reissue"]`，否则 `[]` | 计算（C16） |

### 2.14 导出登记表与各导出键的参数

**登记表**（`exports.register({ key, permission, columns, query, sheets, sensitiveColumns })`，d6:2180）。列表类导出与该列表接口共用同一个带范围的查询构造函数（“导出的就是看到的”）；报表与对账类的参数与列表不同构（C46、A24；复核意见 67）。导出键按数据模型约束为小写点分 2–4 段、不超过 40 个字符（`ck_export_job_export_key`）。**命名规则**：列表类导出的第一段取该列表的资源名（`resources.json` 的 `resource`，短横线换下划线），第二段为 `list`（对账明细为 `detail`）；报表类为 `report.<报表>`。所以商家列表（`admin.store.list`，资源 `stores`）的键是 `stores.list`，不另起 `merchants.list`。下表是 V1.0 登记的键；PRD 要求所有列表可导出，原型未画导出按钮的其他列表（退款管理、发票、积分调整、审批、上线日历等）由各自文档按同一规则提出，在本表补登。

| `exportKey` | 页面 | `params` 的 schema | 权限点（另需该模块 ≥ v） | 默认格式 | 敏感列（`isMasked = true` 时脱敏） | 文件名 | 版本 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `delivery_tickets.list` | A:Tickets | 与 `admin.deliveryTicket.list` 的查询参数同构（去掉 `page`、`pageSize`；a05-order-delivery.md:151） | `delivery.export`（增补） | csv | 无 | `狸有戏交付工单_<申请日>.csv` | V1.0 |
| `stores.list` | A:Merchants | 同 `admin.store.list` 的 `StoreListQuery`（a03 2.2） | `merchant.export` | csv | 联系电话 | `狸有戏商家_<申请日>.csv` | V1.0 |
| `orders.list` | A:Orders（订购单） | 同 `admin.order.list` 的查询参数（去掉 `page`、`pageSize`；a05-order-delivery.md:151） | `order.export` | csv | 无 | `狸有戏订购单_<申请日>.csv` | V1.0 |
| `payment_orders.list` | A:Orders（付款单） | 同 `admin.paymentOrder.list` | `order.export` | csv | 无 | `狸有戏付款单_<申请日>.csv` | V1.0 |
| `payment_transactions.list` | A:Payments | 同 `admin.paymentTransaction.list` | `finance.export` | xlsx | 付款户名 | `狸有戏收款流水_<申请日>.xlsx` | V1.0 |
| `reconciliations.detail` | A:Reconcile | `ReconExportParams`（下） | `finance.export` | xlsx | 付款户名、退款收款账号 | `狸有戏对账明细_<月份或日期>.xlsx` | V1.0 |
| `service_tickets.list` | A:Service | 同 `admin.serviceTicket.list`（含 `no`、`storeId`、`isUnassigned`、`isResponseOverdue`；去掉 `page`、`pageSize`） | `service.export`（增补） | csv | 联系电话 | `狸有戏客服工单_<申请日>.csv` | V1.0 |
| `audit_logs.list` | A:SysLogs | 同 `admin.auditLog.list`（`stream`、`category`、`actorType` / `actorId`、`targetType` / `targetId` / `targetKey`、`entityId`、`storeId`、`q`、`createdFrom` / `createdTo`；去掉 `cursor`、`limit`） | `audit.export`（仅超级管理员，要再验证） | xlsx | 来源 IP | `狸有戏操作日志_<申请日>.xlsx` | V1.0 |
| `report.overview` | A:RptOverview | `ReportMonthParams` | `report.export` | xlsx | 无 | `狸有戏经营概览_<月份>.xlsx` | V1.0 |
| `report.points` | A:RptPoints | `PointsReportExportParams` | `report.export` | xlsx | 无 | `狸有戏积分报表_<月份>.xlsx` | V1.0 |
| `dramas.list` | A:Dramas | 同 `admin.drama.list` 的 `AdminDramaListQuery`（去掉 `page`、`pageSize`）；列同 `DramaRow`，不含签名地址与 `actions`（a04-content.md:495） | `drama.export`（增补，A88） | csv | 无 | `狸有戏短剧库_<申请日>.csv` | V1.0 |
| `point_accounts.list` | A:PointAccounts | 同 `admin.pointAccount.list` | `billing.export`（增补） | csv | 无 | `狸有戏积分账户_<申请日>.csv` | V1.0 |
| `subscription_terms.list` | A:Renewals | 同 `admin.subscriptionTerm.list` | `order.export` | csv | 无 | `狸有戏套餐到期_<申请日>.csv` | V1.0 |
| `report.dramas`、`report.delivery`、`report.ads`、`report.service`、`report.partners` | A:RptDramas 等 | `ReportMonthParams` | `report.export` | xlsx | 无 | `狸有戏<报表名>_<月份>.xlsx` | V1.1 |
| `partners.list`、`commission_statements.list` | A:Partners、A:PartnerSettle | 同各自列表 | `channel.export`（增补，V1.1） | csv | 银行账号 | — | V1.1 |

规则：

- 没有敏感列的键只接受 `isMasked = true`；传 false 返回 400 `VALIDATION_FAILED`。明文导出另需 `export.unmasked`、原因与再验证（C64；d6:2186）。
- 执行时按申请人**此刻**的状态、权限点与数据范围重查（d4-identity.md:1657；R10）；列表类按列表的默认排序或 `params.sort` 输出；行数上限参数 `export.max_rows`（默认 200,000），`xlsx` 超过 `export.xlsx_max_rows`（默认 50,000）时执行中改为 `csv`（d6:2182）。
- 单元格防公式注入：以 `=`、`+`、`-`、`@`、制表符、回车开头的字符串前加单引号（csv），xlsx 一律写字符串类型（d6:2185）。
- 文件名由响应头 `response-content-disposition` 给出（d6:2188）；`<申请日>` 为 `yyyyMMdd`。

`ReportMonthParams`：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `month` | string（`YYYY-MM`） | 是 | 在 `monthRange` 内 | 导出与页面同一月份；Sheet 与页面区块一一对应（KPI、每日收款、近 6 月、收款构成、付费主体分布） |

`PointsReportExportParams`：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `month` | string（`YYYY-MM`） | 是 | 在 `monthRange` 内 | 月份 |
| `includeEntityBalances` | boolean | 否 | 默认 true | 是否含“按主体的余额明细”Sheet（行数约为付费主体数，proto-admin-d.md:429） |
| `includeRecognitionDetail` | boolean | 否 | 默认 false | 是否另含收入确认明细（逐笔流水，`point_entry_valuation` 的 `recognize`、`recognize_breakage` 与各冲回效果，d1:1602） |

`ReconExportParams`（对账页导出弹层，proto-admin-d.md:284-285）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `granularity` | enum(`ReconExportGranularity`) | 是 | `day` / `month` | 按日或按月 |
| `month` | string（`YYYY-MM`） | 条件 | `granularity = month` 时必填，不晚于当月 | 月份 |
| `date` | string(date) | 条件 | `granularity = day` 时必填，不晚于今日 | 日期（行内“导出”预置为该日） |
| `contents` | array<enum(`ReconExportContent`)> | 是 | 至少 1 项，不重复；前端默认前三项 | 每项一个 Sheet：付款单明细、收款明细、退款明细、对账差异 |

### 2.15 `ExportJob` 导出任务

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `exportJobId` | string(uuid) | 是 | 任务 id | `export_job.id` |
| `jobNo` | string | 是 | 任务单号（`DC…`） | `export_job.job_no` |
| `exportKey` | enum(`ExportKey`) | 是 | 导出键 | `export_job.export_key` |
| `title` | string | 是 | 显示名，如“经营概览 2026-09” | 登记表 + `params` |
| `fileName` | string | 是 | 下载文件名（2.14 的规则，扩展名随最终格式） | 计算 |
| `format` | enum(`ExportFormat`) | 是 | 当前格式（`xlsx` 超行数时执行中已改为 `csv`） | `export_job.format` |
| `isMasked` | boolean | 是 | 是否脱敏 | `export_job.is_masked` |
| `reason` | string \| null | 是 | 明文导出原因 | `export_job.reason` |
| `params` | object | 是 | 申请时的参数（原样回显） | `export_job.params` |
| `status` | enum(`ExportJobStatus`) | 是 | 状态 | `export_job.status` |
| `rowCount` | integer \| null | 是 | 行数；成功后有值 | `export_job.row_count` |
| `sizeBytes` | string(bigint) \| null | 是 | 文件字节数 | `export_job.size_bytes` |
| `error` | string \| null | 是 | 失败原因摘要（可直接展示） | `export_job.error` |
| `createdAt` | string(date-time) | 是 | 申请时间 | `export_job.created_at` |
| `startedAt` | string(date-time) \| null | 是 | 最近一次开始执行 | `export_job.started_at` |
| `finishedAt` | string(date-time) \| null | 是 | 结束时间 | `export_job.finished_at` |
| `expiresAt` | string(date-time) \| null | 是 | 文件过期时间（完成 + `export.retention_hours`，默认 24 小时） | `export_job.expires_at` |
| `downloadCount` | integer | 是 | 下载次数 | `export_job.download_count` |
| `lastDownloadedAt` | string(date-time) \| null | 是 | 最近下载时间 | `export_job.last_downloaded_at` |
| `actions` | array<enum(`ExportJobAction`)> | 是 | `queued` → `["cancel"]`；`succeeded` 且未过期 → `["download"]`；其余 `[]` | 计算（C16） |

`ExportJobCreateResult` = `ExportJob` 加一个字段：`isExisting` boolean——同一申请人、同一导出键、同参数（含格式与是否脱敏）已有进行中的任务时为 true，返回的是那个任务（d6:2162）。

### 2.16 `ExportDownloadUrl` 下载地址

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `status` | enum(`ExportDownloadStatus`) | 是 | `issued` 已签发；`revoked` 下载时复核不通过（申请人已无该导出权限点或模块查看权，或明文文件已无 `export.unmasked`），任务已置过期，不给地址。按 C50、A101 的写法：需要落库的业务拒绝返回 200，在 `status` 里表达 | 计算 |
| `url` | string \| null | 是 | 5 分钟有效的签名读地址（带 `response-content-disposition`）；`revoked` 为 null | 现签（C61） |
| `expiresAt` | string(date-time) \| null | 是 | 地址过期时刻；`revoked` 为 null | 计算 |
| `fileName` | string | 是 | 文件名 | 计算 |
| `downloadCount` | integer | 是 | 本次计入后的下载次数（`revoked` 不计入） | `export_job.download_count` |

## 3. 接口

### 3.1 admin.workbench.todo.get　我的待办
`GET /admin/workbench/todos`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.workbench.todo.get`（路线图 `a02.workbench.todos`；C14：子资源用单数；第二轮改名，旧名见修订记录，尚未发布） |
| 鉴权 | `staff`；模块 `workbench` ≥ v；各卡片按 2.3 的可见条件与数据范围裁剪（处理器内）；`tab` 不是 `all` 时处理器另判权限点 `sys.super_admin`；数据范围 `task` / `store` / `entity` 按来源 |
| 回显 | 无 |
| 幂等 | `none`（纯查询，GET 不写库） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Main（我的待办，含“待办视角”分段按钮） |

**请求**：路径参数无；请求体无。

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum(`WorkbenchTab`) | 否 | 默认 `all` | 岗位视角：`all` 全部岗位、`cs` 客服、`delivery_manager` 交付经理、`editor` 剪辑师、`publisher` 发布专员、`finance` 财务（A24：原 `view=` 改 `tab=`） |

**响应**：`TodoBoard`（2.4）。不分页。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `PERMISSION_DENIED` | 403 | 模块 `workbench` 为 `n`；不持 `sys.super_admin` 却传了 `all` 以外的 `tab` |

**副作用**：无。

**说明**：

- 不持 `sys.super_admin`：`tab` 只能是 `all`，返回本人按 2.3 可见条件能看到的全部来源，计数按本人数据范围。
- 持 `sys.super_admin`（A45：只限超级管理员的操作用这个权限点，不写死角色判断）：`tab = all` 返回全部可见来源；切到某岗位时只返回 `ownerRole` 等于该岗位的来源，数据范围取“全部”（d3:3097）；`ownerRole` 为 `null` 的来源（⑲）只在 `all` 出现。原型按“待办 → 归属岗位”映射过滤（Main.dc.html 的 `owner` 表），本文的 `ownerRole` 即该映射；d3 写的是“用所选岗位的权限点集合过滤”，两者对原型的 10 张卡结果相同，本文取前者（第 6 节）。
- 卡片计数与菜单角标（3.5）、各队列的 `summary`（a01 审批、a06 下架与巡检、a07 套餐到期、a08 客服工单等，见 2.3）用同一个计数函数；结果按“员工 + 数据范围”在 Redis 缓存 30 秒（d3:3095-3096），缓存丢失即重查。单个来源出错或超时（300 毫秒）不让整个请求失败，该卡 `isDegraded = true`。
- “近 7 日上线安排”不在本接口：调 a06 的 `admin.launchCalendar.get`（`from` = 今日、`to` = 今日 + 6 天、`limit = 5`）。

### 3.2 admin.workbench.today.get　今日数据
`GET /admin/workbench/today`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.workbench.today.get`（路线图 `a02.workbench.today`） |
| 鉴权 | `staff`；模块 `workbench` ≥ v；每张卡片另按 2.5 的模块等级裁剪；数据范围 `global`（全公司聚合，d6:2133） |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Main（今日数据 4 卡；页头“数据更新于 10:30”） |

**请求**：无。

**响应**：`TodayBoard`（2.5）。

**错误**：无（只有通用错误）。

**副作用**：无。

**说明**：

- 与月报共用同一组指标函数：“今日收款”逐日累加等于经营概览的“每日收款额”，“今日开工部数”逐日累加等于“订购部数”，今日新开通、续费套餐数与月报的 `newCount`、`renewCount` 同取订阅事件（d6:2127、2133）；`active_plans` 与 a07 `admin.subscriptionTerm.summary` 同一计数函数（7 天内到期 = 生效中、`ends_at` 晚于当前时刻、`end_date` ≤ 今日 + 6、没有预约的后续周期；已过期未续费 = 过期 30 天内）。
- PRD §7.1 与原型的并集（d6 第 9 节冲突 21）：原型 4 卡，PRD 另有“上线中剧目”（`live_items`）与“新开通与续费套餐数”（并入 `receipts`）。按 PRD §3.3 的权限矩阵，剪辑师只看到 `new_merchants`，发布专员看到 `new_merchants` 与 `live_items`（d6:2131）。
- 原型“今日订购 6 部（扣减与冻结 11,568 积分）”把两类积分合成一个数；接口分开给 `heldPoints`、`capturedPoints`，显示方式见第 6 节。

### 3.3 admin.workbench.alert.get　预警
`GET /admin/workbench/alerts`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.workbench.alert.get`（路线图 `a02.workbench.alerts`；C14：子资源用单数；第二轮改名，旧名见修订记录。返回的是预警面板这一个视图，`items` 是面板上的前 `limit` 条，不是可翻页的集合，所以动作用 `get`） |
| 鉴权 | `staff`；模块 `workbench` ≥ v；`ticket_overdue` 另需模块 `delivery` ≥ v，`launch_overdue`、`takedown_overdue` 另需模块 `publish` ≥ v，`copyright_expiring` 另需模块 `drama` ≥ v；前三类按工单的数据范围过滤 |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Main（预警，标题带条数） |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `kind` | array<enum(`AlertKind`)> | 否 | 逗号分隔 | 只看某几类；默认全部可见类 |
| 查询 | `limit` | integer | 否 | 1–50，默认 10 | 返回条数 |

**响应**：

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `updatedAt` | string(date-time) | 是 | 计算时刻（与待办同一缓存周期，30 秒） |
| `total` | integer | 是 | 可见预警总数（标题“预警 4”） |
| `countsByKind` | object | 是 | `{ ticket_overdue, launch_overdue, takedown_overdue, copyright_expiring }`；不可见的类为 null |
| `items` | array<`WorkbenchAlert`> | 是 | 至多 `limit` 条：先按类（超时工单、逾期未上线、逾期未下架、版权到期），类内按超时或逾期程度降序、版权按止日升序 |

**错误**：无（只有通用错误）。

**副作用**：无。

**说明**：

- 四类预警的判定见 2.6（d3:3091；PRD §7.1）。逾期未上线是派生判定，由发布模块的只读端口给出，本接口不重复实现口径（11-publish.md:313）。
- 版权到期提醒窗口取参数 `remind.copyright.days`（默认 90，PRD §7.2），与 a04 的 `isExpiringSoon`、`admin.drama.summary` 的 `expiringSoon` 共用判定函数；“09-25 起已停止订购”即 a04 的 `stopOrderDate`（止日往前 `minLicenseMonths` 个自然月，计费参数，默认 3，07-billing-ledger.md:1448）。
- 完整清单分别在各页查看：超时工单 → A:Tickets（仅看超时）、逾期未上线 → A:Overdue、逾期未下架 → A:Offline、版权 → A:Dramas（仅看 N 天内授权到期，N 同上）。

### 3.4 admin.workbench.feed.list　实时动态
`GET /admin/workbench/feed`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.workbench.feed.list`（路线图 `a02.workbench.feed`；C14：游标集合用 `list`；第二轮改名，旧名见修订记录） |
| 鉴权 | `staff`；模块 `workbench` ≥ v；行按 `audit_log.store_id` / `entity_id` 套门店或主体的数据范围；类别所属模块（2.7 的对照表）的等级为 `n` 的行不返回（处理器内） |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Main（实时动态） |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `cursor` | string | 否 | 不透明，首页不传 | 游标（A22：审计日志是只增大表） |
| 查询 | `limit` | integer | 否 | 1–50，默认 20 | 每页条数 |

**响应**：`AdminCursorPage<FeedItem>`（a01 2.1，C87；C43：审计日志的游标列表带封顶 10,000 的近似总数），按 `(audit_log.created_at, audit_log.seq)` 倒序。

**错误**：无（只有通用错误）。

**副作用**：无。

**说明**：

- 取 `audit_log.stream` ∈ (`ops`, `activity`) 且 `entity_id` 非空的行：与门店活动流同一来源（03-staff-authz-audit.md:635），平台级操作（员工、参数、字典）不进工作台。路线图写的 `status_transition` 不再读：每次状态迁移在审计日志里恰有一行（M31），文案在写入时已渲染进 `audit_log.summary`。
- 页面不显示条数，`totalApprox` 仍按 C43 返回（与 `admin.auditLog.list` 同一封顶计数，数到 10,000 为止）；计数结果按“员工 + 数据范围”缓存 30 秒，60 秒一次的轮询不会每次都重数。
- 建议 60 秒轮询（proto-admin-a.md:744），首屏取 20 条；不做推送。
- 审计类别到菜单模块的对照见 2.7，由本文维护（a01 与数据模型 03 分组的类别登记表没有模块列）。

### 3.5 admin.navBadge.get　菜单角标
`GET /admin/nav-badges`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.navBadge.get`（路线图 `a02.nav-badges.get`） |
| 鉴权 | `staff`；已登录即可（不要求 `workbench`）；每个角标按 2.3 的可见条件、所属菜单的模块等级与数据范围裁剪 |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Main 及全部后台页面的侧栏（一级与二级菜单角标） |

**请求**：无。

**响应**：`NavBadges`（2.8）。

**错误**：无（只有通用错误）。

**副作用**：无。

**说明**：

- 与“我的待办”共用来源与缓存（d3:3095）；合并了 d2 的 `/finance/todo-counts`（财务角标即其子集）。二级菜单项与来源的对应见 2.3 最后一列：如退款管理 = 待审批 + 待执行（proto-admin-d.md:737）；客服 = a08 `admin.serviceTicket.summary` 的 `counts.open`；“我的待审批”`approval.mine` = a01 `admin.approval.summary` 的 `total.todo`（2.8）；流程运维 `system.flow_ops` 指向“系统 › 流程运维”页（失败的定时器、死信、不变量违规，d3:3275-3283），不指向只有告警与不变量违规的系统健康页（d7:1003）。
- 铃铛未读数不在本接口，由 `admin.staffMessage.summary` 给（A23）；两者可在同一个 60 秒轮询里并发请求，窗口不可见时暂停（d7:1005）。
- 写操作之后前端按资源标签让 `badges` 失效（d7:1120），不等下一次轮询。

### 3.6 admin.search.get　全局搜索
`GET /admin/search`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.search.get`（路线图 `a02.search.query`；第二轮改名，旧名见修订记录：响应是按类型分组的一个结果对象、每组至多 5 条，不是可翻页的集合，C14 的 `list` 只用于集合，也就不必在 C43 登记不分页的例外） |
| 鉴权 | `staff`；已登录即可；每个类型另需对应模块 ≥ v：`store` → `merchant`，`drama_order`、`billing_order` → `order`，`delivery_ticket` → `delivery`，`service_ticket` → `service`；结果按各自列表的数据范围过滤 |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无（设计完成前前端隐藏入口，接口照列，design-spec.md:907） |
| 对应画板 | 无画板：顶栏全局搜索（“搜索商家、订单号、工单号”，proto-admin-a.md:79） |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `q` | string | 是 | 去首尾空白后 2–30 个字符 | 关键词（C45）。上限取各目标列表 `q` 上限的最小值（a03 `admin.store.list` 为 1–30），保证“查看全部”带着 `q` 跳过去不会被目标列表拒绝 |
| 查询 | `type` | array<enum(`SearchHitType`)> | 否 | 逗号分隔 | 只搜某几类；默认全部可见类 |

**响应**：`SearchResult`（2.9）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | `q` 为空或超长 |

**副作用**：无。

**说明**：

- 匹配规则：`q` 形如单号前缀（`LYX`、`FK`、`JF`、`KF`，可带预发前缀 `T`）时只按单号**前缀**匹配对应类型：`drama_order.order_no`、`billing_order.order_no`、`delivery_ticket.ticket_no`、`service_ticket.ticket_no`；否则按门店名与主体名**包含**匹配（`store.name`、`entity.name`，命中主体名时返回其名下已有店名的门店；`store.name` 为空的草稿门店不返回）。手机号等加密字段不参与搜索。d7 写的是“前缀匹配”，门店名多为“XX 火锅（万达店）”，名称按包含匹配；V1.0 数据量小直接查，量大时加 trigram 索引。
- 每类至多 5 条，按单号或门店名排序；“查看全部”跳该类型列表页并原样带 `q`。

### 3.7 admin.staffMessage.list　站内消息列表
`GET /admin/staff-messages`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.staffMessage.list`（路线图 `a02.staff-messages.list`） |
| 鉴权 | `staff`；只返回 `staff_message.staff_id` = 本人的行 |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无（通知面板设计完成前前端隐藏入口，design-spec.md:907） |
| 对应画板 | 无画板：顶栏通知面板（“5 条未读”） |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `kind` | array<enum(`StaffMessageKind`)> | 否 | 逗号分隔 | 按类别筛选 |
| 查询 | `unreadOnly` | boolean | 否 | 默认 false | 只看未读 |
| 查询 | `page` | integer | 否 | ≥1，默认 1 | 页码（C43） |
| 查询 | `pageSize` | integer | 否 | 1–100，默认 20 | 每页条数 |

**响应**：`AdminPage<StaffMessageItem>`（a01 2.1，C87），按 `staff_message.id` 倒序（UUID v7 即时间序；索引 `ix_staff_message_staff_id_id`）。

**错误**：无（只有通用错误）。

**副作用**：无（查看不标记已读，GET 不写库）。

**说明**：

- 消息由通知中心按员工场景派发时同事务写入（13-notify-docs.md:534；场景如 `s.work_ticket_assigned`、`s.approval_pending`、`s.export_ready`），本文只读与标记已读。
- A23：未读数由 `admin.staffMessage.summary` 给，列表不返回计数字段以外的统计。
- 铃铛面板是下拉列表，仍按 A22 用页码分页（`staff_message` 不是只增大表），面板首屏取 20 条、“查看更多”翻页。

### 3.8 admin.staffMessage.summary　未读数
`GET /admin/staff-messages/summary`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.staffMessage.summary`（路线图 `a02.staff-messages.summary`） |
| 鉴权 | `staff`；本人 |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 无画板：顶栏铃铛的未读点与“N 条未读”（design-spec.md:407） |

**请求**：无。

**响应**：`StaffMessageSummary`（2.10）。

**错误**：无（只有通用错误）。

**副作用**：无。

**说明**：走部分索引 `ix_staff_message_unread`；建议与 `admin.navBadge.get` 同一轮询周期。

### 3.9 admin.staffMessage.read　标记一条已读
`POST /admin/staff-messages/{staffMessageId}/read`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.staffMessage.read`（路线图 `a02.staff-messages.read`；A9：`mark-read` 改 `read`） |
| 鉴权 | `staff`；本人的消息 |
| 回显 | 无 |
| 幂等 | `required`（缺省；已读的再标一次直接返回原 `readAt`） |
| 乐观锁 | 无（`staff_message` 不是状态机表，没有 `lock_version`） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 无画板：通知面板点击消息 |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `staffMessageId` | string(uuid) | 是 | — | 消息 id（`resources.json`） |

请求体：无。

**响应**：`{ staffMessageId, readAt }`。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 消息不存在或不是本人的 |

**副作用**：`staff_message.read_at` 为空时写当前时刻并写 `updated_at`；已读的不改。不写审计，不发事件。

**说明**：前端点击消息时先调本接口再按 `link` 跳转；失败不阻塞跳转。

### 3.10 admin.staffMessage.batchRead　全部标记已读
`POST /admin/staff-messages/read`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.staffMessage.batchRead`（路线图 `a02.staff-messages.batch-read`；集合动作加 `batch` 前缀，A10） |
| 鉴权 | `staff`；本人 |
| 回显 | 无 |
| 幂等 | `required` |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 无画板：通知面板“全部已读” |

**请求**：路径参数无。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `upToStaffMessageId` | string(uuid) | 是 | — | 面板里最新一条的 id；只标记 id 不大于它的未读消息，避免把点“全部已读”之后才到的消息也标掉（UUID v7 按时间有序） |
| `kind` | array<enum(`StaffMessageKind`)> | 否 | — | 只标记某几类；默认全部 |

**响应**：`{ readCount: integer, readAt: string(date-time) }`。

**错误**：无（只有通用错误）。

**副作用**：本人 `staff_message.read_at` 为空且 `staff_message.id` ≤ `upToStaffMessageId`（与 `kind` 条件）的行写 `read_at`、`updated_at`。不写审计。

**说明**：`upToStaffMessageId` 不是本人的消息不报错，按 id 比较照常执行（只影响本人的行）。

### 3.11 admin.report.overview.get　经营概览
`GET /admin/reports/overview`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.report.overview.get`（路线图 `a02.reports.overview`） |
| 鉴权 | `staff`；模块 `report` ≥ v；数据范围 `global`（平台汇总口径，d4-identity.md:1306） |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:RptOverview（月份 ‹ ›、7 个 KPI、每日收款额、近 6 个月 MRR、收款构成 3 条、付费主体分布 2 组、指标口径） |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `month` | string（`YYYY-MM`） | 否 | 默认当月；在 `monthRange` 内 | 报表月份（C35） |

**响应**：`OverviewReport`（2.11）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | `month` 格式不对、晚于当月或早于最早月份（`fieldErrors.path = "month"`） |
| `BUSY` | 503 | 报表查询超过 5 秒（`statement_timeout`），可稍后重试 |

**副作用**：无。

**说明**：

- 取数（d6:2034-2063）：该月有 `report_month_close.status = 'closed'`、`report_key = 'overview'` 的行时取它的 `payload`（`source = snapshot`）；否则在一个只读事务里实时聚合（`source = live`，当月结果缓存 60 秒）。积分与订阅数字是计费口径，本模块只读不算：当月读每日快照 `billing_entity_daily`，已月结月份读快照里拷贝的计费月结结果（d6:2037）。
- 收款按渠道成功时间落月（微信 `success_time`，对公为财务确认到账），与对账、微信账单同日可比（d6:2041）；退款单列、不冲减收款额（原型口径）。履约受阻的付款单已收款，计入收款额，但不计入新开通、续费、升级家数（d1:1630）。
- 已月结月份的收款以快照截止时刻为界：按入账时间 `payment_txn.applied_at` ≤ `cutoff_at` 截止（`cutoff_at` 的定义是“入账时间不晚于它”，14-config-data.md:853；4.9 的 `cash` 口径同此，14-config-data.md:1170，A145）；之后才入账、渠道成功时间属于该月的收款计入下月的 `priorMonthAdjustment`（d6:2113）。不用 `billing_order.paid_at`（渠道成功时间，补入账的收款会永远落在原月）；不变量 `reports.N10` 每周重算时用同一列（14-config-data.md:894）。
- 历史月份在计费月结表建立之前由账本与每日快照现算（A106），`source = live`、页面标“未月结”。
- “续费 124”（`renewCount`，当月发生的续费）与“续费率分子 118”（`renewalDoneCount`）是两个口径，分开返回（proto-admin-d.md:386）；续费率到期满 7 天才是最终值，此前 `finality.renewalRate = provisional`。
- 指标口径仍待确认（PRD §12.3 第 5 项），口径改动提升 `metricDefVersion`，已固化的月份不受影响。
- 导出走 `admin.exportJob.create`（`exportKey = report.overview`，`params = { month }`）。

### 3.12 admin.report.points.get　积分报表
`GET /admin/reports/points`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.report.points.get`（路线图 `a02.reports.points`） |
| 鉴权 | `staff`；模块 `report` ≥ v；数据范围 `global` |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:RptPoints（6 个 KPI、积分流转、消耗构成、近 6 个月发放消耗清零、按积分来源表、指标口径） |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `month` | string（`YYYY-MM`） | 否 | 默认当月；在 `monthRange` 内 | 报表月份。本画板没有月份切换控件（proto-admin-d.md:428），接口仍支持 |

**响应**：`PointsReport`（2.12）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | `month` 不合法或超出范围 |
| `BUSY` | 503 | 报表查询超过 5 秒 |

**副作用**：无。

**说明**：

- 恒等式（d1:1570）：`closingPoints` = `openingPoints` + 发放 + 加购 + 调整增加 + 退回 + 转入 + 清零冲回 − 消耗 − 清零 − 转出 − 调整扣减 − 作废。原型没有“调整”“作废”两项，恒等式在有手工调整或套餐退款的月份不成立；本接口单列（d6:2072，第 9 节冲突 24）。
- “本月退回”只计开工后退回（`consumed → available`）；开工前取消释放的冻结另给 `releasedPoints`，不进恒等式（d1:1588）。
- 折合预收款按逐批估值求和（当前口径版本、每批次最新一条估值行，见 2.12），精确到分；与原型“余额 × 未取整单价”的估算可能差几分钱，以逐批为准（d6:2074）。页面的折算单价按 d6:2075 取 `valueFen ÷ balancePoints`，不取 d1:1599 的“入账成本 ÷ 入账数量”：后者在有不同价目修订、折扣或转加购批次（`cost_basis_fen` 为空，`ck_point_lot_cost_basis`）时与本行的余额、预收款对不上。另给“未发放月份的预收套餐款”（`liability.deferredPlanFeeFen`），原型没有，财务口径须展示（d6:2076）。
- “余额含冻结；退回的积分计入原来源”：转为加购的退回在 `plan` 来源记“转出”、`addon` 来源记“转入”，合计时两者之差并入退回（d1:1587）。
- 导出走 `admin.exportJob.create`（`exportKey = report.points`），含积分流转、按来源、按主体余额明细三个 Sheet（d6:2080）。

### 3.13 admin.reportMonthClose.list　报表月度快照
`GET /admin/report-month-closes`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.reportMonthClose.list`（路线图 `a02.report-month-closes.list`） |
| 鉴权 | `staff`；模块 `report` ≥ v；数据范围 `global` |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:RptOverview、A:RptPoints（“已结算”标记与历史月数据来源；修订列表原型无入口） |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `reportKey` | enum(`ReportKey`) | 否 | 默认 `overview` | 报表键 |
| 查询 | `month` | string（`YYYY-MM`） | 否 | — | 只看某月的各修订 |
| 查询 | `status` | array<enum(`ReportMonthCloseStatus`)> | 否 | 逗号分隔 | 默认全部 |
| 查询 | `page` | integer | 否 | ≥1，默认 1 | 页码 |
| 查询 | `pageSize` | integer | 否 | 1–100，默认 20 | 每页条数 |

**响应**：`AdminPage<ReportMonthCloseItem>`（a01 2.1，C87），按 `month_date` 倒序、同月 `revision_no` 倒序（唯一约束 `uq_report_month_close_report_key_month_date_revision_no` 覆盖）。快照内容 `payload` 不在列表里返回，由 `admin.report.overview.get` 按月读取。

**错误**：无（只有通用错误）。

**副作用**：无。

**说明**：首个计费月结之前没有数据（`billing_month_close` 上线时不建，M10；14-config-data.md:839）。

### 3.14 admin.reportMonthClose.reissue　重出月度快照
`POST /admin/report-month-closes/{reportMonthCloseId}/reissue`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.reportMonthClose.reissue`（路线图 `a02.report-month-closes.reissue`；A4：`{monthCloseId}` 改 `{reportMonthCloseId}`） |
| 鉴权 | `staff`；`x-permission: report.month_close.reissue`（增补表新键，菜单模块“数据报表”：默认授予财务，超级管理员拥有全部，不附带待分配池；建议要求再验证，以注册表为准）；数据范围 `global` |
| 回显 | 要求 `confirm`：`{ month, revisionNo }`，与该行当前值比对（C54） |
| 幂等 | `required` |
| 乐观锁 | 不带 `lockVersion`（表没有该列；并发由咨询锁串行化，守卫是 `status = 'closed'`） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 原型无入口（d6:2116） |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `reportMonthCloseId` | string(uuid) | 是 | — | 当前有效的快照行 |
| 请求体 | `reason` | string | 是 | 1–100 个字，非空白 | 重出原因（续费率定稿以外的口径修正、数据更正等），写进新行 `report_month_close.reason` |
| 请求体 | `confirm.month` | string（`YYYY-MM`） | 是 | — | 操作人看到的月份 |
| 请求体 | `confirm.revisionNo` | integer | 是 | — | 操作人看到的修订号 |

**响应**：`{ previous: ReportMonthCloseItem, current: ReportMonthCloseItem }`：被取代的旧行与新行。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `REPORT_CLOSE_NOT_CURRENT` | 409 | 该行已是 `superseded`（已被定稿或他人重出）；`details` 带当前有效行 |
| `CONFIRM_MISMATCH` | 409 | `confirm` 与该行的月份或修订号不一致 |
| `STEP_UP_REQUIRED` | 403 | 注册表对 `report.month_close.reissue` 标了再验证且超出 10 分钟窗口 |
| `BUSY` | 503 | 咨询锁等待或重算超时 |

**副作用**：

- 状态：`report_month_close: closed → superseded`（旧行）；新插一行 `report_month_close: (新建) → closed`，`revision_no` = 旧行 + 1（14-config-data.md:890）。同一事务先把旧行置 `superseded` 再插新行（部分唯一索引 `uq_report_month_close_current` 立即检查，顺序不能反）。本表不是业务状态机，不写 `status_transition`。
- 新行内容：`billing` 重新拷贝该月计费月结的结果（含续费率定稿值）；`cash`、`orders`、`cross` 按当前代码口径重算，`metric_def_version` 取当前 `METRIC_DEF_VERSION`；`cutoff_at` 沿用旧行（保证与下月“上月调整”不重不漏）；`closed_at` = 当前时刻；`closed_by_staff_id` = 本人；`finality` 重新判定。
- 审计：同事务写一条 `ops` 审计，`category = report`（A107 补登的类别），`action = reports.month_close.reissue`，对象为新行，`reason_text` = 原因，`before` / `after` 记两行的修订号与 `metric_def_version`。
- 不发出站事件，不登记定时器。

**说明**：

- 只能对当前有效的行重出；同一报表同一月份至多一行 `closed`（`uq_report_month_close_current`）。
- 续费率定稿（`revision_no = 2`）由每日 00:30 的周期任务 `reports.finalize` 自动完成，不经本接口（x01 的非 HTTP 迁移归属表）。

### 3.15 admin.exportJob.create　申请导出
`POST /admin/export-jobs`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.exportJob.create`（路线图 `a02.export-jobs.create`） |
| 鉴权 | `staff`；`permission: assert-in-handler`（A45）：处理器按 `exportKey` 查登记表（2.14），要求该模块 ≥ v 且持有该键的导出权限点；`isMasked = false` 另需 `export.unmasked`；登记表或注册表标了再验证的权限点（`export.unmasked`、`audit.export`）要求会话 10 分钟内再验证过 |
| 回显 | 无 |
| 幂等 | `natural`：`x-idempotent-by: [uq_export_job_inflight]`（字符串数组，A49；同一申请人、同一导出键、同参数哈希的进行中任务至多一个，重复点击返回同一个，14-config-data.md:966）；不要求 `Idempotency-Key` |
| 乐观锁 | 无 |
| 限流 | `admin.global`；另受每名员工并发上限 `export.max_concurrent_per_staff`（默认 3） |
| 开关 | `export.enabled` 关闭时 403 `FEATURE_DISABLED`，前端隐藏导出按钮（d7:519、1149）；V1.1 的导出键在 V1.0 一律 `FEATURE_DISABLED` |
| 对应画板 | A:Tickets、A:Merchants、A:Orders、A:Payments、A:Reconcile、A:Service、A:SysLogs、A:RptOverview、A:RptPoints、A:Dramas、A:PointAccounts、A:Renewals（V1.1：A:RptDramas、A:RptDelivery、A:RptAds、A:RptService、A:RptPartners、A:Partners、A:PartnerSettle）的“导出”按钮与导出面板 |

**请求**：路径参数无。请求体（C64）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `exportKey` | enum(`ExportKey`) | 是 | 登记表里的键 | 导出键 |
| `format` | enum(`ExportFormat`) | 否 | `xlsx` / `csv`；默认取登记表的默认格式 | 文件格式（一般列表 CSV、财务对账类 XLSX，d7:1150） |
| `isMasked` | boolean | 否 | 默认 true | 是否脱敏（C39） |
| `reason` | string | 条件 | `isMasked = false` 时必填，1–100 个字、非空白；脱敏导出时传了忽略 | 明文导出原因 |
| `params` | object | 是 | 按 `exportKey` 的 schema 校验（2.14） | 列表类为当前筛选条件，报表类为月份等 |

**响应**：`ExportJobCreateResult`（2.15）。前端每 2 秒调 `admin.exportJob.get`，至多 2 分钟；成功后自动调 `admin.exportJob.downloadUrls` 下载，超时转入“导出记录”抽屉（d7:1138-1151）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 未登记的导出键；`params` 不合该键的 schema；没有敏感列的键传了 `isMasked = false`；明文导出缺原因 |
| `PERMISSION_DENIED` | 403 | 缺该键的导出权限点或模块查看权；明文导出缺 `export.unmasked` |
| `STEP_UP_REQUIRED` | 403 | 明文导出或操作日志导出，会话超出再验证窗口；再验证后用同一请求重放 |
| `FEATURE_DISABLED` | 403 | `export.enabled` 关闭，或 V1.1 的导出键 |
| `EXPORT_CONCURRENCY_LIMIT` | 409 | 本人进行中（`queued`、`running`）的任务已达上限；`details` 带上限与进行中的任务 |
| `EXPORT_ROW_LIMIT` | 409 | 列表类导出按当前筛选数出的行数超过 `export.max_rows`；`details` 带行数与上限，前端提示缩小筛选范围 |

**副作用**：

- 状态：`export_job: (新建) → queued`（14-config-data.md:978）；技术状态，不写 `status_transition`。
- 写入：`export_job` 新行——`job_no` 经 `biz_sequence` 取号（`DC` 前缀）；`export_key`、`params`、`format`、`is_masked`、`reason` 取请求；`params_hash` = sha256(规范化后的 `params` + `format` + `is_masked`)；`requested_by_staff_id` = 本人；`request_scope_snapshot` = `{ permissionKeys, dataScope }`（申请时的相关权限点与数据范围，只作审计，14-config-data.md:1181）。
- 审计：同事务写“导出申请”`ops` 审计（`category = export`，`action = exports.job.create`，对象 `export_job`，`meta` 带导出键、筛选条件、是否脱敏、原因、申请时的数据范围，d6:2188）。
- 不发出站事件。worker 按 `ix_export_job_queued` 认领执行；完成后由通知中心发后台铃铛 `s.export_ready`（这些迁移见 x01 的非 HTTP 迁移归属表）。

**说明**：

- 判定顺序：开关 → 登记表与 `params` 校验 → 权限与再验证 → 查同参数进行中的任务（命中即返回它，`isExisting = true`，不再查并发上限与行数）→ 并发上限 → 行数预估 → 建任务。重复点击因此总是拿到同一个任务。
- 同参数但原因不同的明文导出视为同一个进行中任务（`params_hash` 不含原因），返回已有任务，原因以首次为准。
- 行数预估只对列表类导出做；报表与对账类行数有界，不预估。页码列表用列表接口的同一个计数函数；游标列表（`audit_logs.list`）的 `totalApprox` 封顶 10,000，永远到不了 `export.max_rows`，所以改用同一查询构造做封顶计数：数到 `export.max_rows + 1` 行为止，超过即 `EXPORT_ROW_LIMIT`；封顶计数超过 2 秒不拒绝，交给执行阶段。执行中写满 `export.max_rows` 行仍有剩余的任务置 `failed`（`error` 写明“超过行数上限，请缩小筛选范围”），不生成残缺文件。
- 执行时的权限复核（申请人已禁用、已无导出权限点、明文导出已无 `export.unmasked` → 任务 `failed`，不生成文件）在 worker 里做，不在本接口（d4-identity.md:1657）。
- 操作日志导出仅超级管理员、要再验证，导出行为同样记入日志（proto-admin-e.md:446；d4-identity.md:1204、1656）；来源 IP 明文只在明文导出里出现（d4-identity.md:1651）。

### 3.16 admin.exportJob.list　我的导出记录
`GET /admin/export-jobs`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.exportJob.list`（路线图 `a02.export-jobs.list`） |
| 鉴权 | `staff`；只返回 `export_job.requested_by_staff_id` = 本人的任务 |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 无画板：页头“导出记录”抽屉（d7:1151） |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `status` | array<enum(`ExportJobStatus`)> | 否 | 逗号分隔 | 按状态筛选 |
| 查询 | `exportKey` | enum(`ExportKey`) | 否 | — | 按导出键筛选 |
| 查询 | `createdFrom` / `createdTo` | string(date) | 否 | 两端都含 | 申请日期范围（C45） |
| 查询 | `page` | integer | 否 | ≥1，默认 1 | 页码 |
| 查询 | `pageSize` | integer | 否 | 1–100，默认 20 | 每页条数 |

**响应**：`AdminPage<ExportJob>`（a01 2.1，C87），按 `export_job.created_at` 倒序（索引 `ix_export_job_requested_by_staff_id_created_at`）。

**错误**：无（只有通用错误）。

**副作用**：无。

**说明**：过期任务（`expired`）仍列出，`actions` 为空；文件保留 24 小时（`export.retention_hours`）。

### 3.17 admin.exportJob.get　导出任务状态
`GET /admin/export-jobs/{exportJobId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.exportJob.get`（路线图 `a02.export-jobs.get`） |
| 鉴权 | `staff`；申请人本人 |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 各导出按钮的进度提示；导出记录抽屉 |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `exportJobId` | string(uuid) | 是 | — | 任务 id |

**响应**：`ExportJob`（2.15）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 任务不存在或不是本人申请的 |

**副作用**：无。

**说明**：建议每 2 秒轮询、至多 2 分钟；`succeeded` 后调 `admin.exportJob.downloadUrls`。`running` 的任务租约过期会被 `export.sweep` 退回 `queued` 重试一次（14-config-data.md:982），前端只看 `status`。

### 3.18 admin.exportJob.cancel　取消导出
`POST /admin/export-jobs/{exportJobId}/cancel`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.exportJob.cancel`（路线图 `a02.export-jobs.cancel`） |
| 鉴权 | `staff`；申请人本人 |
| 回显 | 无 |
| 幂等 | `required`（状态迁移，A17） |
| 乐观锁 | 不带 `lockVersion`（守卫是带原状态条件的单行更新） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 无画板：导出记录抽屉的“取消” |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `exportJobId` | string(uuid) | 是 | — | 任务 id |

请求体：无。

**响应**：`ExportJob`（取消后的状态）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 任务不存在或不是本人申请的 |
| `STATE_NOT_ALLOWED` | 409 | 任务不是 `queued`（已开始执行、已结束） |

**副作用**：

- 状态：`export_job: queued → cancelled`，写 `finished_at`（14-config-data.md:980）；条件更新 `WHERE status = 'queued'`，与 worker 认领竞争时只有一方成功。
- 审计：写 `ops` 审计（`category = export`，`action = exports.job.cancel`）。

**说明**：执行中的任务不能取消（数据模型没有 `running → cancelled`）；多数任务几秒内完成。

### 3.19 admin.exportJob.downloadUrls　签发下载地址
`POST /admin/export-jobs/{exportJobId}/download-urls`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.exportJob.downloadUrls`（路线图 `a02.export-jobs.download-urls`；A19、C64：原 `sign-url`） |
| 鉴权 | `staff`；`permission: assert-in-handler`（A45）：只对申请人本人签发（他人的任务一律 404）；签发前复核申请人仍持有该导出键的权限点与模块查看权（明文文件另需仍持有 `export.unmasked`），复核不通过不报错，返回 `status = revoked`（见副作用）。已禁用的员工没有有效会话，到不了本接口 |
| 回显 | 无 |
| 幂等 | `none`（签发短时地址，结果不进幂等记录，A18） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 各导出按钮的自动下载；导出记录抽屉的“下载” |

**请求**：

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `exportJobId` | string(uuid) | 是 | — | 任务 id |

请求体：无（一个任务只有一个文件）。

**响应**：`ExportDownloadUrl`（2.16）：`status = issued` 时带地址；`status = revoked` 时 `url`、`expiresAt` 为 null，前端提示“你已没有该导出的权限，文件已失效”并刷新导出记录。`Cache-Control: no-store`（C18）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 任务不存在或不是本人申请的 |
| `EXPORT_NOT_DOWNLOADABLE` | 409 | 任务不是 `succeeded`（排队中、执行中、失败、已取消）；`details.status` 带当前状态 |
| `EXPORT_FILE_EXPIRED` | 410 | 任务已 `expired`（含此前复核不通过而提前过期的），或 `export_job.expires_at` 已过 |

**副作用**：

- 签发（`issued`）：`export_job.download_count` 加 1、写 `last_downloaded_at`；同事务写一条 `access` 流审计（`category = file_access`，对象 `export_job`，`meta` 带 `fileCategory = export`、`urlTtlSec = 300`、来源 IP 记在 `audit_log.ip`）（d6:2187-2188；03-staff-authz-audit.md:951）。
- 复核不通过（`revoked`）：同一个请求事务里把任务置 `export_job: succeeded → expired`（14-config-data.md:984“下载时复核不通过……提前置过期”；d6:2187），写一条 `ops` 审计（`category = export`，`action = exports.job.revoke`，`meta` 带复核不通过的原因：缺导出权限点、缺模块查看权或缺 `export.unmasked`），正常提交并返回 200。按 C50、A101 的写法：需要落库的业务拒绝用 200 + `data.status` 表达，不用错误码，所以不需要“独立事务提交后再报错”。文件对象在事务提交后删除，删除失败不影响结果，由文件清除流程按 `file_ref.keep_until` 兜底（06 分组）。下载次数不变。

**说明**：

- 地址有效期 5 分钟（C61“导出 5 分钟”）；过期后重新调用本接口。导出文件属 `secure` 桶、文件分类 `export`，不能经通用签发 `admin.file.downloadUrls` 取得（a01）。
- 申请人本人以外的人（含超级管理员）都不能下载他人的导出文件（d6:2187）。

### 3.20 admin.report.dramas.get　短剧销售排行（V1.1）
`GET /admin/reports/dramas`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.report.dramas.get`（路线图 `a02.reports.dramas`） |
| 鉴权 | `staff`；模块 `report` ≥ v |
| 幂等 | `none`（纯查询） |
| 对应画板 | A:RptDramas |

V1.1，细节待设计。用途：按订购次数、消耗积分、订购商家数对已上架短剧排行，热度等级分布，授权期与在播提醒（proto-admin-d.md:444-483）；查询参数 `month`。V1.0 不挂载路由。

**请求**：V1.1 定。**响应**：V1.1 定。**错误**：无。**副作用**：无。

### 3.21 admin.report.delivery.get　交付效率（V1.1）
`GET /admin/reports/delivery`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.report.delivery.get`（路线图 `a02.reports.delivery`） |
| 鉴权 | `staff`；模块 `report` ≥ v |
| 幂等 | `none`（纯查询） |
| 对应画板 | A:RptDelivery |

V1.1，细节待设计。用途：成片交付时长中位数、按时上线率、样片一次通过率、各环节用时、按交付经理、超时与逾期列表（proto-admin-d.md:485-516；取数见 d3:2585-2601，读 `delivery_ticket`、`delivery_ticket_stage` 与状态历史固化的用时）。V1.0 不挂载路由。

**请求**：V1.1 定。**响应**：V1.1 定。**错误**：无。**副作用**：无。

### 3.22 admin.report.ads.get　广告制作（V1.1）
`GET /admin/reports/ads`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.report.ads.get`（路线图 `a02.reports.ads`） |
| 鉴权 | `staff`；模块 `report` ≥ v |
| 幂等 | `none`（纯查询） |
| 对应画板 | A:RptAds |

V1.1，细节待设计。用途：新广告、消耗积分、平均修改次数、首版按时率、广告复用率、按剪辑师（proto-admin-d.md:520-553）。V1.0 不挂载路由。

**请求**：V1.1 定。**响应**：V1.1 定。**错误**：无。**副作用**：无。

### 3.23 admin.report.service.get　客服报表（V1.1）
`GET /admin/reports/service`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.report.service.get`（路线图 `a02.reports.service`） |
| 鉴权 | `staff`；模块 `report` ≥ v |
| 幂等 | `none`（纯查询） |
| 对应画板 | A:RptService |

V1.1，细节待设计。用途：工单量、平均首次响应、方案按时率、解决率、满意度、按客服（proto-admin-d.md:557-590）。V1.0 不挂载路由。

**请求**：V1.1 定。**响应**：V1.1 定。**错误**：无。**副作用**：无。

### 3.24 admin.report.partners.get　服务商业绩（V1.1）
`GET /admin/reports/partners`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.report.partners.get`（路线图 `a02.reports.partners`） |
| 鉴权 | `staff`；模块 `report` ≥ v；渠道运营只看本人负责的服务商（PRD §3.3 注 1） |
| 幂等 | `none`（纯查询） |
| 开关 | `release.partner`（关闭时不挂载） |
| 对应画板 | A:RptPartners |

V1.1，细节待设计。用途：名下商家、名下实付（已扣除退款）、返佣（proto-admin-d.md:594-618）。服务商相关表 V1.0 不建（01-architecture.md:176）。

**请求**：V1.1 定。**响应**：V1.1 定。**错误**：无。**副作用**：无。

## 4. 枚举

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `StaffRoleKey` | `super_admin` / `cs` / `delivery_manager` / `editor` / `publisher` / `content_ops` / `channel_ops` / `finance` | 同数据模型 `staff_role.key`；`TodoCard.ownerRole` 另可为 null（按人不按岗） |
| `WorkbenchTab` | `all` / `cs` / `delivery_manager` / `editor` / `publisher` / `finance` | 本文新增：工作台岗位视角（原型的 6 个分段按钮；岗位取值是 `staff_role.key` 的子集） |
| `TodoSourceKey` | `qualification_review` / `receipt_confirm` / `ticket_assign` / `ad_produce` / `release_deliver` / `launch_verify` / `plan_expiring` / `takedown_check` / `service_ticket` / `refund_approval` / `account_verify` / `patrol_pending` / `points_adjust_approval` / `term_extend_approval` / `account_change_approval` / `invoice_issue` / `recon_diff` / `manager_first_contact` / `follow_up_due` / `flow_ops` / `store_asset_review` / `plan_push` / `sample_qc` / `staff_assign` / `ad_waiting_qualification` / `ad_returned_stale` / `order_rejected_stale` | 本文新增，`x-open-enum`（新来源先在 2.3 登记键再加值）：待办来源（2.3） |
| `TodoSubKind` | `earliest_submitted` / `earliest_due` / `nearest_due` / `earliest` / `amount_total` / `due_today` / `overdue` / `points_total` / `none` | 本文新增：待办副指标的类型；`earliest` 为最早的起算时刻（退回、驳回时刻，用 `at`；a05 1.3 的 ㉖㉗） |
| `TodayCardKey` | `new_merchants` / `orders` / `receipts` / `active_plans` / `live_items` | 本文新增：今日数据卡片 |
| `TodayCardState` | `ok` / `unavailable` | 本文新增：卡片取数结果 |
| `AlertKind` | `ticket_overdue` / `launch_overdue` / `takedown_overdue` / `copyright_expiring` | 本文新增：预警四类（PRD §7.1） |
| `MenuKey` | `workbench` / `drama` / `billing` / `merchant` / `order` / `delivery` / `publish` / `service` / `finance` / `report` / `ops` / `system` / `channel` | 本文新增：后台一级菜单（即模块键，d7:955-1003） |
| `NavBadgeKey` | `merchant.review` / `order.receipts` / `order.renewals` / `delivery.tickets` / `delivery.ad_tasks` / `publish.deliveries` / `publish.verify` / `publish.accounts` / `publish.offline` / `publish.patrol` / `service.tickets` / `finance.refunds` / `finance.credit_adjust` / `finance.invoices` / `finance.reconcile` / `approval.mine` / `system.flow_ops` | 本文新增，`x-open-enum`：带角标的二级菜单项（`approval.mine` 为“我的待审批”页，A16；`system.flow_ops` 为“系统 › 流程运维”页，d3:3275） |
| `AdminRouteKey` | `NavBadgeKey` 的全部取值，另加 `merchant.detail`、`merchant.asset_review`、`order.detail`、`order.payment_order`、`delivery.ticket_detail`、`publish.overdue`、`service.ticket_detail`、`drama.edit`、`system.health`、`export.records` | 本文新增，`x-open-enum`：`AdminLink.route` 用到的后台路由键；完整清单在后台路由登记表。`merchant.asset_review` 是跨门店的待整理素材队列（原型无，第 6 节）；`system.health` 是系统健康页（告警与不变量违规，d7:1003），不挂流程运维角标 |
| `SearchHitType` | `store` / `drama_order` / `billing_order` / `delivery_ticket` / `service_ticket` | 本文新增：全局搜索结果类型（取最终表名） |
| `StaffMessageKind` | `todo` / `alert` / `approval` / `system` | 同数据模型 `staff_message.kind` |
| `ReportSource` | `live` / `snapshot` | 本文新增：报表数据来源 |
| `MetricFinality` | `final` / `provisional` | 同数据模型 `report_month_close.finality` 的取值 |
| `ReportKey` | `overview` | 同数据模型 `report_month_close.report_key`（V1.1 按需加值） |
| `ReportMonthCloseStatus` | `closed` / `superseded` | 同数据模型 `report_month_close.status` |
| `ReportMonthCloseAction` | `reissue` | 本文新增：快照行的 `actions`（C16） |
| `BillingOrderType` | `plan_new` / `plan_renew` / `plan_upgrade` / `topup` | 同数据模型 `billing_order.type`（收款构成“按类型”） |
| `PointSourceGroup` | `plan` / `addon` / `all` | `plan`、`addon` 同数据模型 `point_ledger_entry.lot_kind`；`all` 为本文新增的合计行 |
| `ExportKey` | 2.14 登记表第一列的全部键 | 本文新增，`x-open-enum`：导出登记表；写法受 `ck_export_job_export_key` 约束 |
| `ExportFormat` | `xlsx` / `csv` | 同数据模型 `export_job.format` |
| `ExportJobStatus` | `queued` / `running` / `succeeded` / `failed` / `expired` / `cancelled` | 同数据模型 `export_job.status` |
| `ExportJobAction` | `cancel` / `download` | 本文新增：导出任务的 `actions`（C16）。`download` 对应 `…/download-urls`（C12 动作词表，A134） |
| `ExportDownloadStatus` | `issued` / `revoked` | 本文新增：签发下载地址的结果（2.16） |
| `ReconExportGranularity` | `day` / `month` | 本文新增：对账导出维度 |
| `ReconExportContent` | `payment_orders` / `payment_transactions` / `refunds` / `exceptions` | 本文新增：对账导出内容（付款单明细、收款明细、退款明细、对账差异） |

## 5. 错误码

区间 47200–47299（A70）。全部 `retryable = false`。

| 符号 | 数值 | HTTP | 含义 | `details` |
| --- | --- | --- | --- | --- |
| `EXPORT_CONCURRENCY_LIMIT` | 47201 | 409 | 同时进行中的导出任务已达上限，请等已有任务完成后再试（d6:2259） | `{ maxConcurrent: integer, inflightExportJobIds: string[] }` |
| `EXPORT_ROW_LIMIT` | 47202 | 409 | 导出行数超过上限，请缩小筛选范围后再导出（d6:2259） | `{ rowCount: integer, maxRows: integer }` |
| `EXPORT_NOT_DOWNLOADABLE` | 47203 | 409 | 导出任务尚未完成或未成功，暂不能下载（d6:2259） | `{ status: ExportJobStatus }` |
| `EXPORT_FILE_EXPIRED` | 47204 | 410 | 导出文件已过期，请重新导出 | `{ expiredAt: string(date-time) \| null }` |
| `REPORT_CLOSE_NOT_CURRENT` | 47205 | 409 | 该快照已被新的修订取代，请刷新后对当前有效的快照操作 | `{ currentReportMonthCloseId: string(uuid), currentRevisionNo: integer }` |

本文引用的通用码见约定 C27：`VALIDATION_FAILED`、`PERMISSION_DENIED`、`STEP_UP_REQUIRED`、`FEATURE_DISABLED`、`NOT_FOUND`、`STATE_NOT_ALLOWED`、`CONFIRM_MISMATCH`、`BUSY`。本文没有引用其他文档定义的领域码。

## 6. 待确认

只留需要产品、业务决定的问题；第一轮的其余条目已按裁决或本文定稿处理（见修订记录“第二轮”）。第三轮核对 A127–A146，下列各项都没有被裁决覆盖，保留。

| # | 问题 | 默认做法 | 由谁定 |
| --- | --- | --- | --- |
| 1 | 报表的数据范围：d4 默认平台汇总口径、不按负责人过滤，PRD 给了交付经理、客服报表查看权 | 汇总报表与今日数据 `scope: global`；能下钻到商家明细的导出（`report.points` 的按主体余额明细）按 `byEntity` 过滤 | 业务（d4 §12） |
| 2 | 待办视角的过滤：d3 写“用所选岗位的权限点集合过滤来源”，原型按“待办 → 归属岗位”映射 | 按映射（`ownerRole`）；两者对原型 10 张卡结果相同；按人不按岗的来源（⑲）只在“全部岗位”里出现 | 产品 |
| 3 | “今日订购”的积分：原型“扣减与冻结 11,568 积分”是一个数，当日冻结又开工的订单项会被算两次 | 接口分开给 `heldPoints`、`capturedPoints`；页面默认显示“冻结 a · 扣减 b” | 产品 |
| 4 | “我的待审批”（A16）在菜单里的位置没有定，角标 `approval.mine` 挂在哪个一级菜单 | 暂挂 `workbench`（工作台下的二级项）；角标数 = a01 `admin.approval.summary` 的 `total.todo`（本人可决定的全部类型，与该页同一查询） | 产品、设计（设计规范第 12 节） |
| 5 | 待整理素材（㉑）的跳转：a03 提出由工作台派生跨门店的整理队列，但原型没有这一页（接口侧 a03 已支持：待整理页签可不传 `storeId`） | 新增“待整理素材”页（`merchant.asset_review`）：调 a03 `admin.storeAsset.list` 的待整理页签、不传 `storeId`、`sort = reviewDueAt`（复核截止升序，行带 `storeName`）；不做这一页时卡片改跳商家列表 | 产品、设计 |
| 6 | 原型外的交付侧待办（㉒–㉗）是否计入交付、订单菜单的角标 | 不计入，菜单角标只按原型的来源求和，避免角标数与列表页签对不上；只在“我的待办”里出卡片 | 产品 |

## 7. 修订记录

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：路线图 `doc = a02-workbench-report` 的 24 条接口（V1.0 19，V1.1 5）；公共结构 16 节，含待办来源登记表与导出登记表；错误码 47201–47205 | A1–A75；C1–C84；14、13、03、07、08 分组；d6 第 5.2–5.4、6 节；d3 第 19.2、23 节；d7 第 5.2–5.6 节；d4 第 7、8.5 节；d1 第 10 节 |
| 2026-10-03 | 第二轮：① 按复核意见改口径——收款按购买周期计入升级补差（按被升级周期的月数）；今日新开通、续费套餐数改取订阅事件，与月报同一指标函数（不计履约受阻）；折合预收款限定当前口径版本、每批次取最新一条估值行，历史月加 `biz_date` ≤ 月末；付费主体按版本、按行业的人群与付费主体数相同；积分来源行删去 `costBasisFen`、`costBasisPoints`，折算单价改为 `valueFen ÷ balancePoints`（d6:2075）；`renewCount` 写明不含 `resumed`（延长复活），并与 a07 共用。② 待办来源：⑨ 响应超时改与 a08 `responseOverdue` 同口径；⑧⑫ 与 a06 的 summary 共用计数函数；⑬⑭⑮ 副指标改为审批超期（`approval.escalate_workdays`，A93）；`approval.mine` 改取 a01 `admin.approval.summary` 的 `total.todo`；⑲ 的 `ownerRole` 改为可空（按人不按岗）；⑳ 可见条件与 a01 的三个明细列表对齐（模块 `system` ≥ v 或 `flow.ops.view`，后者由 a01 登记），角标改为新键 `system.flow_ops`（流程运维页，不是系统健康页）；新增 ㉑ 待整理素材（a03）与 ㉒–㉗ 交付侧来源键（a05 登记计数函数）；视角切换改按权限点 `sys.super_admin`（A45）。③ 结构与命名：`FeedItem` 改为复用 a01 `AuditLogItem` 并补 `totalApprox`（C43），补审计类别到菜单模块的对照表（含 A107 补登的类别）；预警的版权窗口改读参数 `remind.copyright.days`，字段改名 `stopOrderDate`、`liveItems`（同 a04）；`pointsConsumed` → `consumedPoints`，报表 `asOf` → `asOfAt`（C15）；operationId 按 C14 改名：`admin.workbench.todos.get` → `admin.workbench.todo.get`、`admin.workbench.alerts.get` → `admin.workbench.alert.get`、`admin.workbench.feed.get` → `admin.workbench.feed.list`、`admin.search.list` → `admin.search.get`；全局搜索 `q` 上限改为 30、排除没有店名的草稿门店。④ 导出：下载时复核不通过改为 200 + `status = revoked`（C50、A101），不再“独立事务提交后返回 403”；操作日志导出的文件名改为申请日、`params` 列明与 `admin.auditLog.list` 同构的字段，游标列表改用封顶计数预估行数；登记导出键的命名规则（第一段取资源名，商家列表保持 `stores.list`）；`dramas.list`、`service_tickets.list` 的参数与列按 a04、a08 写明；`x-idempotent-by` 改为数组写法。⑤ 第 6 节删去已由裁决或本文定稿的条目（A88 导出权限点、A90 汇总金额为字符串、A106 历史月现算、A22 页码分页、路线图回改、搜索匹配、行数预估），新增待整理素材的跳转与交付侧待办的角标两问。⑥ 路线图切片按作者建议与复核意见补 `permission`、`transitions`、`tables`，`idempotentBy` 改为数组，改名的 operationId 同步 | A76–A126（A45、A49、A88、A90、A93、A101、A106、A107）；review/xdoc-a02-workbench-report.md；两位复核员的意见；api-check.md |
| 2026-10-03 | 第三轮：① 裁决落实：`ExportJobAction.download` 引用 C12 动作词表（A134）；报表现金口径的截止条件直接引用 14 分组（`payment_txn.applied_at <= cutoff_at`，14-config-data.md:853、1170，A145），删去回写请求；2.7 审计类别对照表按各接口文档实际写到的类别补 `payment`、`invoice`、`recon`、`finance_config`、`docs`、`delivery`、`service_ticket`、`approval`、`review`、`flow`（A146）。② 公共结构（C87、A132）：站内消息、月度快照、导出记录三个列表的响应改用 a01 `AdminPage<T>`，实时动态改用 a01 `AdminCursorPage<FeedItem>`，清单删去 `StaffMessageListResult`、`ReportMonthCloseListResult`、`ExportJobListResult`、`WorkbenchFeedResult`，补 `externalSchemas`。③ 待办来源：③④⑤、㉒–㉗ 与 ⑩ 取消一侧引用 a05 1.3 登记的计数函数与预置筛选（a05 的请求）；⑳ 三项写明 a01 的 `timers.countFailed`、`outbox.countDead`、`invariants.countOpen`（a01 的请求）；`TodoSubKind` 补 `earliest`（a05 ㉖㉗ 的副指标）。④ 导出登记：`dramas.list` 的参数改称 a04 的 `AdminDramaListQuery`；`orders.list`、`delivery_tickets.list` 注明与 a05 同构的出处。⑤ 正文的 operationId 只写现名（旧名只留在第二轮记录里）；引用写法示例的行号笔误改正。⑥ 第 6 节逐条核对 A127–A146，无可删条目 | A127–A146（A132、A134、A145、A146）；C85–C87；review/r3-in-a02-workbench-report.md；api-check.md |
| 2026-10-03 | 第四轮（收尾）：2.7 对照表的说明改按 A155（35 个类别回写数据模型 03 分组，与 a01 `auditCategory` 一致）；2.3 说明与第 6 节第 5 项按 a03 已放开的跨门店待整理队列（不传 `storeId`、`sort = reviewDueAt`、行带 `storeName`）改写；a01 关于 `approval.mine` 与审批超期的确认已落实，无需改动；依据范围改为 A1–A156 | A155；review/r4-in-a02-workbench-report.md |
