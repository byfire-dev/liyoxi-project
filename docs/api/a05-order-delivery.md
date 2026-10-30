# 后台：订购、取消、交付与广告任务

| 项 | 内容 |
| --- | --- |
| 文档 | `a05-order-delivery` |
| 范围 | 运营后台“订单管理”的订购单（A:Orders 订购单子页签、A:OrderDetail，含 A:MerchantDetail 的“订购单”子页签）与取消申请（A:Refunds 的订购取消、广告取消、资质相关取消；A:OrderDetail、A:ServiceDetail 的“发起取消”）；“交付管理”的交付工单（A:Tickets、A:TicketDetail、A:Delivery 的左侧队列与“推送成片包”、A:Calendar、A:Overdue 的“提醒上线”）、交付方案与改期、样片与质检、成片登记与质检、补发、制作素材与制作文件、成片下载记录与授权书（A:OrderDetail 的授权书区）、广告制作任务（A:AdTasks）；单剧积分价页（A:Pricing）的订购积分试算；原型没画的“流程运维”页里工单的重新求值与人工纠偏 |
| 接口数 | 66（V1.0 66，V1.1 0） |
| 依据 | 数据模型 `09-order-ad.md`（订购单、订单项、广告位、取消申请与明细、广告、版本、修改轮次）、`10-delivery.md`（工单、环节、暂停、方案、样片、成片、质检、成片包、补发、下载授权与记录）、`13-notify-docs.md` 2.9、2.13、2.14（人工催办、授权书与版次）；另读 `03-staff-authz-audit.md` 2.12（审批单）、`06-media.md` 2.9、2.10（制作留痕、取料记录）、`07-billing-ledger.md`（价目、冻结单）；草案 `d3-flow.md` 第 5–11、16、17 节与附录 A、B，`d5-media.md` 第 12 节，`d6-notify-docs-data.md` 第 3.6 节，`d1-ledger.md` 第 5 节，`d4-identity.md` 第 7 节；接口裁决 A1–A156（第二轮按第十节 A76–A120、第三轮按第十二节 A127–A146、第四轮按第十四节 A151–A156 修订）；通用约定 C1–C87；事件目录 `x01-events-jobs`；设计规范第 11、12 节；原型梳理 `proto-admin-a.md` 第 2–6、9 节，`proto-admin-b.md` 第 4、5 节，`proto-admin-c.md` 第 6 节，`proto-admin-d.md` 第 2 节 |
| 状态 | 第四轮修订（2026-10-03） |

> Q9 样片当期覆盖（2026-10-29）：新推送仅 weapp；includeWecom/markWecomSent=true 拒绝，关闭开关或真实水印未就绪拒绝。四种历史 enum/字段/快照与已确认记录保留，不自动迁移；广告查看规则不变。见 [Q9 工作包](../plan/changes/plan-q9-sample-player.md)。

## 1. 概览

本文是运营后台围绕“订购—交付—广告—取消”的全部接口。订购单是商家确认订购后生成的头单，一单多部剧，每部剧一个订单项，开工后一部剧一张交付工单；订购单与订单项的状态由工单步骤和在途取消推导，后台没有直接改它们的接口。交付经理在工单上分配、推方案、质检与推送样片、代录修改意见；剪辑师登记样片与成片、制作广告版本；发布专员推送成片包、发布补发。取消与终止走“试算 → 发起 → 财务审批 → 财务执行”，申请、审批、执行都挂在 `cancel-requests` 这一个资源上（A14、A63）；退款管理页与“我的待审批”页跨文档引用本文的 operationId。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| **订购单** | | | | |
| `admin.order.list` | `GET /admin/orders` | 订购单列表 | staff；模块查看 order | none（查询） |
| `admin.order.summary` | `GET /admin/orders/summary` | 订购单状态筛选条计数 | staff；模块查看 order | none（查询） |
| `admin.order.quote` | `POST /admin/orders/quote` | 订购积分试算（单剧积分价页） | staff；模块查看 billing | none（试算） |
| `admin.order.get` | `GET /admin/orders/{orderId}` | 订购单详情 | staff；模块查看 order | none（查询） |
| `admin.order.activity.list` | `GET /admin/orders/{orderId}/activities` | 订购单操作日志 | staff；模块查看 order | none（查询） |
| `admin.order.cancelQuote` | `POST /admin/orders/{orderId}/cancel-quote` | 订购取消试算 | staff；`order.refund.request` | none（试算） |
| `admin.order.cancelRequest.create` | `POST /admin/orders/{orderId}/cancel-requests` | 发起订购取消 | staff；`order.refund.request` | required |
| **取消申请** | | | | |
| `admin.cancelRequest.list` | `GET /admin/cancel-requests` | 取消申请列表 | staff；模块查看 order 或 finance | none（查询） |
| `admin.cancelRequest.summary` | `GET /admin/cancel-requests/summary` | 取消申请页签计数与指标 | staff；模块查看 order 或 finance | none（查询） |
| `admin.cancelRequest.get` | `GET /admin/cancel-requests/{cancelRequestId}` | 取消申请详情 | staff；模块查看 order 或 finance | none（查询） |
| `admin.cancelRequest.approve` | `POST /admin/cancel-requests/{cancelRequestId}/approve` | 审批通过 | staff；`finance.refund.approve` | required |
| `admin.cancelRequest.reject` | `POST /admin/cancel-requests/{cancelRequestId}/reject` | 驳回 | staff；`finance.refund.approve` | required |
| `admin.cancelRequest.withdraw` | `POST /admin/cancel-requests/{cancelRequestId}/withdraw` | 撤回（审批前） | staff；处理器内判定 | required |
| `admin.cancelRequest.void` | `POST /admin/cancel-requests/{cancelRequestId}/void` | 作废（通过后、执行前） | staff；`order.refund.request` + 申请人本人 | required |
| `admin.cancelRequest.execute` | `POST /admin/cancel-requests/{cancelRequestId}/execute` | 执行退回积分 | staff；`finance.refund.execute` | required |
| **交付工单** | | | | |
| `admin.deliveryTicket.list` | `GET /admin/delivery-tickets` | 工单池（也供成片交付队列、流程运维） | staff；模块查看 delivery | none（查询） |
| `admin.deliveryTicket.summary` | `GET /admin/delivery-tickets/summary` | 页头统计与状态页签计数 | staff；模块查看 delivery | none（查询） |
| `admin.deliveryTicket.get` | `GET /admin/delivery-tickets/{deliveryTicketId}` | 工单详情聚合 | staff；模块查看 delivery | none（查询） |
| `admin.deliveryTicket.activity.list` | `GET /admin/delivery-tickets/{deliveryTicketId}/activities` | 工单操作日志 | staff；模块查看 delivery | none（查询） |
| `admin.deliveryTicket.assignManager` | `POST /admin/delivery-tickets/{deliveryTicketId}/assign-manager` | 分配交付经理 | staff；`merchant.manager.assign` | required |
| `admin.deliveryTicket.assignEditor` | `POST /admin/delivery-tickets/{deliveryTicketId}/assign-editor` | 指派或改派剪辑师 | staff；`delivery.ticket.assign_editor` | required |
| `admin.deliveryTicket.assignPublisher` | `POST /admin/delivery-tickets/{deliveryTicketId}/assign-publisher` | 改派发布专员 | staff；`delivery.ticket.assign_publisher` | required |
| `admin.deliveryTicket.remind` | `POST /admin/delivery-tickets/{deliveryTicketId}/remind` | 人工催办商家（方案、样片、上线） | staff；处理器内判定 | required |
| `admin.deliveryTicket.rework` | `POST /admin/delivery-tickets/{deliveryTicketId}/rework` | 主管返工 | staff；`delivery.ticket.rework` | required |
| `admin.deliveryTicket.reevaluate` | `POST /admin/delivery-tickets/{deliveryTicketId}/reevaluate` | 重新求值（流程运维） | staff；`flow.ops.manage` | required |
| `admin.deliveryTicket.forceTransition` | `POST /admin/delivery-tickets/{deliveryTicketId}/force-transition` | 人工纠偏（流程运维） | staff；`flow.admin.transition` | required |
| `admin.deliveryTicket.material.list` | `GET /admin/delivery-tickets/{deliveryTicketId}/materials` | 制作素材清单 | staff；模块查看 delivery | none（查询） |
| `admin.deliveryTicket.material.downloadUrls` | `POST /admin/delivery-tickets/{deliveryTicketId}/materials/download-urls` | 签发制作素材下载地址并留取料记录 | staff；`delivery.download` | none（签发短时地址） |
| `admin.deliveryTicket.episodeOutput.list` | `GET /admin/delivery-tickets/{deliveryTicketId}/episode-outputs` | 成片剧集（成片包格子） | staff；模块查看 delivery | none（查询） |
| `admin.deliveryTicket.episodeOutput.create` | `POST /admin/delivery-tickets/{deliveryTicketId}/episode-outputs` | 登记成片剧集（批量；换版；补发替换集） | staff；`delivery.episode.register` | required |
| `admin.deliveryTicket.inspectEpisodes` | `POST /admin/delivery-tickets/{deliveryTicketId}/inspect-episodes` | 逐集质检（批量） | staff；`delivery.episode.qc` | required |
| `admin.deliveryTicket.inspectPackage` | `POST /admin/delivery-tickets/{deliveryTicketId}/inspect-package` | 成片包级质检 | staff；`delivery.episode.qc` | required |
| `admin.deliveryTicket.pushPackage` | `POST /admin/delivery-tickets/{deliveryTicketId}/push-package` | 推送成片包与发布清单 | staff；`publish.package.push` | required |
| **方案与改期** | | | | |
| `admin.deliveryPlan.get` | `GET /admin/delivery-plans/{deliveryPlanId}` | 方案：草稿、版本、修改请求 | staff；模块查看 delivery | none（查询） |
| `admin.deliveryPlan.draft.replace` | `PUT /admin/delivery-plans/{deliveryPlanId}/draft` | 保存方案草稿 | staff；`delivery.plan.edit` | required |
| `admin.deliveryPlan.push` | `POST /admin/delivery-plans/{deliveryPlanId}/push` | 推送方案给商家确认 | staff；`delivery.plan.push` | required |
| `admin.orderItem.rescheduleLaunch` | `POST /admin/order-items/{orderItemId}/reschedule-launch` | 改约定上线日 | staff；`delivery.plan.reschedule` | required |
| **样片** | | | | |
| `admin.deliveryTicket.sample.create` | `POST /admin/delivery-tickets/{deliveryTicketId}/samples` | 登记样片新版本 | staff；`delivery.sample.upload` | required |
| `admin.sample.inspect` | `POST /admin/samples/{sampleId}/inspect` | 样片质检 | staff；`delivery.sample.qc` | required |
| `admin.sample.markSent` | `POST /admin/samples/{sampleId}/mark-sent` | 登记已经企业微信发送水印版 | staff；`delivery.sample.push` | required |
| `admin.sample.push` | `POST /admin/samples/{sampleId}/push` | 推送样片给商家确认 | staff；`delivery.sample.push` | required |
| `admin.sample.requestChange` | `POST /admin/samples/{sampleId}/request-change` | 代录样片修改意见 | staff；`delivery.sample.feedback_on_behalf` | required |
| **补发** | | | | |
| `admin.deliveryTicket.reissue.create` | `POST /admin/delivery-tickets/{deliveryTicketId}/reissues` | 发起补发 | staff；`delivery.package.reissue` | required |
| `admin.reissue.cancel` | `POST /admin/reissues/{reissueId}/cancel` | 取消补发 | staff；`delivery.package.reissue` + 发起人或主管 | required |
| `admin.reissue.publish` | `POST /admin/reissues/{reissueId}/publish` | 发布补发 | staff；`publish.package.push` | required |
| **下载记录与授权书** | | | | |
| `admin.orderItem.download.list` | `GET /admin/order-items/{orderItemId}/downloads` | 成片包、下载授权与下载记录 | staff；模块查看 delivery | none（查询） |
| `admin.orderItem.licenseLetter.list` | `GET /admin/order-items/{orderItemId}/license-letters` | 订单项的授权书与版次 | staff；模块查看 order | none（查询） |
| `admin.licenseLetter.correct` | `POST /admin/license-letters/{licenseLetterId}/correct` | 更正并重出（编号不变） | staff；`order.license_letter.manage` | required |
| `admin.licenseLetter.void` | `POST /admin/license-letters/{licenseLetterId}/void` | 作废并重出 | staff；`order.license_letter.manage` | required |
| `admin.licenseLetterRevision.rerender` | `POST /admin/license-letter-revisions/{licenseLetterRevisionId}/rerender` | 渲染失败后重新生成 | staff；`order.license_letter.manage` | required |
| **广告任务** | | | | |
| `admin.ad.list` | `GET /admin/ads` | 广告制作任务队列 | staff；模块查看 delivery | none（查询） |
| `admin.ad.summary` | `GET /admin/ads/summary` | 广告任务页签计数 | staff；模块查看 delivery | none（查询） |
| `admin.ad.get` | `GET /admin/ads/{adId}` | 广告任务详情 | staff；模块查看 delivery | none（查询） |
| `admin.ad.assign` | `POST /admin/ads/{adId}/assign` | 指派剪辑师（冻结转扣减） | staff；`delivery.ad.assign` | required |
| `admin.ad.return` | `POST /admin/ads/{adId}/return` | 退回补充素材 | staff；`delivery.ad.return` | required |
| `admin.ad.adVersion.create` | `POST /admin/ads/{adId}/ad-versions` | 登记第 N 版 | staff；`delivery.ad.upload` | required |
| `admin.adVersion.markSent` | `POST /admin/ad-versions/{adVersionId}/mark-sent` | 登记已经企业微信发送 | staff；`delivery.sample.push` | required |
| `admin.adVersion.push` | `POST /admin/ad-versions/{adVersionId}/push` | 推送版本给商家确认 | staff；`delivery.ad.upload` | required |
| `admin.ad.remind` | `POST /admin/ads/{adId}/remind` | 催办商家确认广告 | staff；处理器内判定 | required |
| `admin.ad.requestChange` | `POST /admin/ads/{adId}/request-change` | 代录广告修改意见（免费次数内） | staff；`delivery.sample.feedback_on_behalf` | required |
| `admin.ad.cancelQuote` | `POST /admin/ads/{adId}/cancel-quote` | 广告取消试算 | staff；`order.refund.request` | none（试算） |
| `admin.ad.cancelRequest.create` | `POST /admin/ads/{adId}/cancel-requests` | 发起广告取消 | staff；`order.refund.request` | required |
| **制作文件** | | | | |
| `admin.productionRecord.list` | `GET /admin/production-records` | 制作文件事实查询 | staff；模块查看 delivery | none（查询） |
| `admin.productionRecord.normalize` | `POST /admin/production-records/{productionRecordId}/normalize` | 云端规格化 | staff；`production.normalize` | required |
| `admin.productionRecord.restamp` | `POST /admin/production-records/{productionRecordId}/restamp` | 补标 AI 隐式标识 | staff；`production.restamp` | required |
| `admin.productionRecord.recheck` | `POST /admin/production-records/{productionRecordId}/recheck` | 规则升级后重检 | staff；`production.recheck` | required |

字面段先于参数段注册（A8、C12）：`/admin/orders/quote`、`/admin/orders/summary` 先于 `/admin/orders/{orderId}`；`/admin/cancel-requests/summary` 先于 `/admin/cancel-requests/{cancelRequestId}`；`/admin/delivery-tickets/summary` 先于 `/admin/delivery-tickets/{deliveryTicketId}`；`/admin/ads/summary` 先于 `/admin/ads/{adId}`。

### 1.1 本文通用规则

| 事项 | 规则 |
| --- | --- |
| 鉴权 | 全部 `x-auth: staff`（C2）。查看类不设权限点，按模块等级（`order`、`delivery`、`finance`、`billing` 的查看等级）判定（`d4-identity.md:1163`；C66）；写接口的权限点逐条列出，都在注册表（`d4-identity.md:1141-1185`）或增补表（1.2）里。再验证（step-up）只由注册表决定，接口不另行声明（A13）：本文涉及的要求再验证的权限点是 `finance.refund.approve`、`finance.refund.execute`（注册表标“要”），所以取消申请的通过、执行与代撤要求再验证；驳回按 C86 登记为 `x-step-up: skip`，不检查再验证（A127；`03-staff-authz-audit.md:806`）；`flow.admin.transition` 建议在增补表里标“要”（`d3-flow.md:3498`）。权限取决于对象的接口声明 `permission: assert-in-handler`（A45），规则写在该接口的说明里；处理器取到的权限点在注册表里标了再验证的，处理器同样校验 `stepup_at`，不满足返回 403 `STEP_UP_REQUIRED`（C66） |
| 数据范围 | 订购单、取消申请、工单、广告都按归属门店套员工的数据范围（`all` / `group` / `own`）；`own` 时：订购单与工单看 `delivery_manager_id` 为本人的门店，广告看 `editor_id` 为本人或所属门店的交付经理为本人。模块等级为 `o`（本人任务）的剪辑师、发布专员：工单列表只返回 `editor_id` 或 `publisher_id` 为本人的工单，广告只返回 `editor_id` 为本人的广告，普通员工写操作只允许作用于本人任务，否则 403 `PERMISSION_DENIED`（`d4-identity.md:1366`；C58）；样片/成片制作入口沿已实现的主管与超级管理员代办规则（1.3、3.30、3.38），仍须操作权限和自身数据范围，不改变负责人。不在范围内的对象一律 404 `NOT_FOUND`（C24）。取消申请另外让发起人看得到自己发起的（`d3-flow.md:2357`） |
| 审批决定的守卫顺序 | 与 a03 第 1.1 节相同（C7；`d4-identity.md:1360-1364`），用于 3.11–3.13：路由级的模块等级、权限点 403 `PERMISSION_DENIED` → 再验证 403 `STEP_UP_REQUIRED`（驳回按 C86 跳过）→ 服务层取对象（范围外 404）→ 审批单不是 `pending` 409 `APPROVAL_NOT_PENDING` → 审批人是发起人 403 `APPROVAL_SELF_FORBIDDEN` → 处理器追加的权限判定（代撤）403 → `lockVersion`（只有通过带）409 `VERSION_CONFLICT` → `confirm` 409 `CONFIRM_MISMATCH` → 事务内重算前提，变了回滚并 409 `PRECONDITION_CHANGED` |
| 指派的范围 | 分配类写操作（3.20–3.22、3.54）：被指派的员工须启用、角色对口，且在操作人的员工集合内（`authz.scopeOf().staffIds`；主管只能指派给本组的人，范围为“全部”的不受限，`d4-identity.md:1324` 第 4 条）；不满足一律 409 `ASSIGNEE_INVALID`，`details.reason` 分别为 `not_active`、`role_mismatch`、`out_of_scope`，与现任相同为 `same_as_current`（第 5 节） |
| 待分配池 | 持有 `merchant.manager.assign` 且是主管的员工，工单列表能看到 `delivery_manager_id` 为空的工单；持有 `delivery.ad.assign` 的主管能看到 `editor_id` 为空的广告（`d4-identity.md:1189-1192` 的“待分配池”） |
| 员工称呼 | 后台显示员工姓名 `staff.name`；对商家展示的称呼（`display_name`）只在商家端用。下文写作“员工姓名” |
| 字典名称 | 补发原因（`reissue_reason`）、定制重点（`custom_focus`）、宣传重点（`ad_promo_point`）、驳回原因（`reject_reason`）、题材（`genre`）、地区（`region`）等编码的名称取 `dict_item.name`（按 `dict_type_key` + `code`），停用项照常显示；多值的字典字段按 C85 出入：响应 `DictRef[]`（字段名不带 `Codes`），请求收编码数组（带 `Codes`）；单值的字典字段（A151）响应 `xxx: DictRef \| null`（不带 `Code`，如 `city`、`district`、`reason`），请求收 `xxxCode`。取消原因不是字典（M55，`14-config-data.md:134`）：`CancelReason` 是 `cancel_request`、`order_item`、`ad` 上 `reason_code` 的枚举，显示名取 `packages/contract` 的枚举标签，接口只返回编码 |
| 清单条目 | 质检、交付前检查的逐项结论数组为 `[{ key, result, note }]`；条目名称取 `checklist_template.items[].label`（按记录上的 `checklist_code` + `checklist_version_no`）。后台返回全部条目，另带 `merchantVisible` 标记（`AdminChecklistItemView`）；提交时按“当前启用的版本”（`checklist_template.status = active`）校验（`d3-flow.md:1499`） |
| 签名地址 | 一律 `{ url, expiresAt }`（C60）。随数据返回、不留痕的：海报、缩略图、截图（30 分钟对齐窗口）、样片与广告的后台预览（60 分钟，C61）。单独签发、逐次留痕的：制作素材下载（30 分钟，3.28）；授权书 PDF、样片原版与样片水印版（`AdminSampleView.watermark.fileId`）等其他文件经 `admin.file.downloadUrls`（a01-system；证照与授权书 5 分钟、样片与广告 60 分钟、成片 30 分钟）。后台 GET 一律不写访问记录（A19） |
| 结果脱敏 | 响应带签名地址的 `required` 写接口按 C50“结果脱敏”（A80）：幂等记录只存脱敏后的结果，同键重放时下列字段为 `null`，响应 `data` 另带 `replayed: true`（首次调用为 `false`），前端需要地址时重新取详情。登记的路由与字段（`x-redact-on-replay`）：返回 `DeliveryTicketDetail` 的 3.20、3.21、3.22、3.24、3.26 置空 `currentSample.preview`、`currentSample.decision.feedbackImages`；返回 `AdminSampleView` 的 3.38–3.42 置空 `preview`、`decision.feedbackImages`；返回 `AdTaskDetail` 的 3.54、3.55、3.56、3.58、3.60 置空 `versions[].preview`、`revisions[].screenshots`、`referenceFiles[].thumbnail`；返回 `AdminAdVersionView` 的 3.57 置空 `preview`。这些字段在 schema 里都声明为可空；`SignedUrl`、`ImageRef` 内的 `url` 不可空（C87），所以整个对象或整个图片数组置空（图片数组只在重放里为 `null`） |
| 工单暂停 | 工单 `pause_count > 0` 时，属于这张工单的写操作（样片、成片、质检、成片包与补发、返工、人工纠偏）一律 409 `TICKET_ON_HOLD`（m05-delivery-publish 定义），`details.reasons` 给出 `cancel_review` / `plan_amendment`（`d3-flow.md:879`）。分配交付经理同样受通用守卫“工单未暂停”约束（`10-delivery.md:168`）。改派剪辑师与发布专员、改期不受暂停限制；催办按场景守卫（确认方案、确认样片在暂停时不可催办）；重新求值在暂停时直接返回、不迁移 |
| 订购单在售后中 | 订购单 `open_cancel_request_id` 非空时，方案推送返回 409 `ORDER_IN_AFTER_SALE`（m05-delivery-publish 定义；`10-delivery.md:413`），不能再发起订购取消（同一个码） |
| 广告在途取消 | 广告 `open_cancel_request_id` 非空时，指派、退回、登记与推送版本、代录修改、再发起取消都返回 409 `AD_CANCEL_IN_PROGRESS`（m06-ad 定义；`09-order-ad.md:811`） |
| 幂等 | 写接口除签发与试算外全部 `required`（A17）；状态迁移的重放返回上次成功的结果。键在打开确认弹层时生成（C48） |
| 并发 | 只有守卫列了锁版本的迁移带锁版本（A21、C53）：审批通过带审批单的 `lockVersion`；方案草稿保存与推送带 `draftLockVersion`（C52 的例外列 `delivery_plan.draft_lock_version`）。其余迁移靠事务内行锁与状态守卫；按 `d3-flow.md:925-944` 的全局锁序加锁（广告在订购单之前） |
| 二次确认 | 财务审批与执行、人工纠偏要求请求体带 `confirm` 回显（C54），与库中当前值不一致返回 409 `CONFIRM_MISMATCH`；界面上的强制勾选项随请求提交为 `confirmChecks`，写进审批单或取消申请与审计 |
| 列表 | 后台页码分页：`page`、`pageSize`（默认 20，上限 100），响应 a01 的 `AdminPage<T>`（C43、C87）。操作日志读只增大表，用游标：`cursor`、`limit`，响应 a01 的 `AdminCursorPage<T>`（A22）。授权书列表（3.47）是有界小集合，响应 `{ items }`（C43，A139）。页签计数由各资源的 `summary` 给（A23） |
| 可执行动作 | 卡片与详情带 `actions: string[]`（C16），取 C12 的动作词；前端只据此显示按钮，判定同时考虑状态、权限点与数据范围 |
| 状态历史与审计 | 每次状态迁移写 `status_transition`（machine 与 `state_field` 按数据模型），并在 `audit_log` 恰好一行（M31；`03-staff-authz-audit.md:636-641`）：用例要 `ops` 审计时把内容传给 `transition()`，只写这一行 `ops`；否则补一行 `activity`。迁移行的 `action` 取迁移事件码（如 `ticket.assign`、`ad.push_version`），`target_type` / `target_id` 为迁移的对象；随审批单联动的取消申请迁移并入审批单那一行（`target_type = approval_request`）。不是迁移的员工动作（登记版本、标记已发送、催办、指派剪辑师等）同事务写一行 `activity`，`action` 为 `<领域>.<对象>.<动作>`。活动流的类别按模块登记：订购单与取消申请 `order`、交付 `delivery`、广告 `ad`（`03-staff-authz-audit.md:931`“各业务模块的活动流类别随模块登记”）。下文“副作用”不再逐条重复这两项，只写额外的审计（`ops` 流、带 `meta` 的行） |
| 广告的审计行 | 商家端广告时间线读广告迁移的审计行（m06-ad 2.13）：`target_type = ad`，`action` ∈ {`ad.assign`、`ad.return`、`ad.push_version`、`ad.request_revision`、`ad.cancel`}；`ad.push_version` 带 `meta.versionNo`，`ad.request_revision`（员工代录、样片反馈的广告内容类）带 `meta.versionNo`（= `on_version_no`）与 `meta.revisionNo`，`ad.return` 的 `reason_text` = 退回原因。这些行的 `summary` 写给商家看得懂的话，不含员工真实姓名（写“剪辑师”“服务经理”），商家端按 `action` 渲染标题 |
| 事件 | 出站事件名一律取 x01 事件目录（A95）；一个用例对同一事实只发一个事件（x01 E2），随主迁移联动的从属迁移不另发 |
| 限流 | 全部 `admin.global`（C68） |

### 1.2 权限点

本文用到的后台权限点。“注册表”指 d4-identity.md 第 7.1 节；“增补”是注册表里没有、按 A13、A45 汇总进增补表的建议（键、模块、默认角色、再验证、待分配池），由汇总人统一。

| 权限点 | 来源 | 菜单模块 | 默认授予 | 再验证 | 待分配池 | 用在 |
| --- | --- | --- | --- | --- | --- | --- |
| `order.refund.request` | 注册表 | 订单管理 | 客服 | 否 | — | 3.6、3.7、3.14、3.61、3.62 |
| `finance.refund.approve` | 注册表 | 财务管理 | 财务 | 要（通过、代撤要；驳回按 C86 `x-step-up: skip` 不要，A127） | — | 3.11、3.12（3.13 代撤） |
| `finance.refund.execute` | 注册表 | 财务管理 | 财务 | 要 | — | 3.15 |
| `merchant.manager.assign` | 注册表 | 商家管理 | 交付经理（仅主管） | 否 | `store_manager` | 3.20 |
| `delivery.ticket.assign_editor` | 注册表 | 交付管理 | 交付经理 | 否 | `ticket_editor` | 3.21 |
| `delivery.ticket.assign_publisher` | 注册表 | 交付管理 | 交付经理、发布专员（仅主管） | 否 | `ticket_publisher` | 3.22 |
| `delivery.ticket.rework` | 注册表 | 交付管理 | 交付经理（仅主管） | 否 | — | 3.24 |
| `delivery.plan.edit`、`delivery.plan.push`、`delivery.plan.reschedule` | 注册表（`delivery.plan.*`） | 交付管理 | 交付经理 | 否 | — | 3.35、3.36、3.37 |
| `delivery.sample.upload`、`delivery.sample.qc`、`delivery.sample.push`、`delivery.sample.feedback_on_behalf` | 注册表（`delivery.sample.*`） | 交付管理 | 上传：剪辑师（本人任务）；其余：交付经理 | 否 | — | 3.38–3.42、3.60；`delivery.sample.push` 另用于 3.57（交付经理登记广告版本的企业微信发送，与样片同一类线下提供） |
| `delivery.episode.register`、`delivery.episode.qc` | 注册表（`delivery.episode.*`） | 交付管理 | 登记：剪辑师（本人任务）；质检：交付经理 | 否 | — | 3.30–3.32 |
| `delivery.ad.assign`、`delivery.ad.upload`、`delivery.ad.return` | 注册表 | 交付管理 | 指派：交付经理；上传：剪辑师（本人任务）；退回：剪辑师、交付经理 | 否 | `ad_editor`（指派） | 3.54–3.56、3.58 |
| `delivery.download` | 注册表 | 交付管理 | 交付经理、剪辑师、发布专员 | 否 | — | 3.28 |
| `publish.package.push` | 注册表 | 发布管理 | 发布专员、交付经理 | 否 | — | 3.33、3.45 |
| `delivery.package.reissue` | 增补（d3-flow.md 附录 A） | 交付管理 | 交付经理 | 否 | — | 3.43、3.44 |
| `flow.ops.manage` | 增补（C66 已列） | 系统设置 | 仅超级管理员 | 否 | — | 3.25 |
| `flow.admin.transition` | 增补（C66 已列） | 系统设置 | 仅超级管理员 | 要（d3-flow.md:3498“需第二因子复核”） | — | 3.26 |
| `order.license_letter.manage` | 增补（C66 已列） | 订单管理 | 客服（仅主管） | 否 | — | 3.48–3.50 |
| `production.normalize` | 增补（C66 已列；d5-media.md:2143） | 交付管理 | 交付经理 | 否 | — | 3.64 |
| `production.restamp` | 增补（C66 已列；d5-media.md:2143） | 交付管理 | 交付经理 | 否 | — | 3.65 |
| `production.recheck` | 增补（C66 已列） | 交付管理 | 交付经理 | 否 | — | 3.66 |

处理器内判定（`permission: assert-in-handler`，A45）的三条：`admin.deliveryTicket.remind`（3.23）、`admin.ad.remind`（3.59）、`admin.cancelRequest.withdraw`（3.13）。`admin.cancelRequest.void`（3.14）、`admin.reissue.cancel`（3.44）在路由上声明权限点，处理器再判“申请人本人”“发起人或主管”。

导出（a02 的 `admin.exportJob.create`）：`orders.list` 要 `order.export`，`delivery_tickets.list` 要 `delivery.export`（A88 增补，默认授予有交付模块查看权的角色，不要求再验证）；两个导出键的 `params` 与 3.1、3.16 的查询参数同构（去掉分页参数），由同一个查询构造函数生成。

### 1.3 交给其他模块的端口与计数函数（非 HTTP）

本模块在代码里登记、供其他文档引用的函数。它们与本文的列表或 `summary` 共用同一个带范围的查询构造函数，保证“别处看到的数”等于“点进本文页面看到的数”。

| 端口或函数 | 调用方 | 规则 |
| --- | --- | --- |
| `delivery.authorizeUpload` | a04 的成片批次 `admin.uploadBatch.create`（`purpose = final_release`）；a01 `admin.file.create`（分类 `final_episode`、`sample_video`、`ad_video`） | 成片（批次与单个文件）：调用者持有 `delivery.episode.register`，且通过工单数据范围校验；已指派时普通剪辑师须为本人，持有同一权限的主管或超级管理员可在自身范围内代办，代办不认领或更改 `editor_id`；工单在 `batch_compose`、`delivering`（未推送），或在待上线、上线核验、使用中且有在途补发单；未暂停。批次另返回 `expectedCount`（订购集数；补发时为补发单的集数）、`production_ctx = { headAdVersionId, tailAdVersionId, productionTier }`（片头、片尾取钉住版本或广告当前确认版本；`productionTier` = `order_item.production_model`，06-media.md 4.7）、`targetLabel`（“《剧名》· 工单号”：`order_item.drama_snapshot.title` + `delivery_ticket.ticket_no`，工单号含订单号）。样片文件：`delivery.sample.upload`，同一工单范围与代办规则，工单在 `sample_making`。广告文件：`delivery.ad.upload`，广告的 `editor_id` 是本人，广告在 `producing`、`revising`。不满足返回 403 `PERMISSION_DENIED`，步骤不对返回 409 `EPISODE_REGISTER_NOT_ALLOWED`（成片）或 `STATE_NOT_ALLOWED` |
| `order.previewFinalReject`（`QualificationImpactPort`） | a03 的终局驳回试算 | 与系统生成整店取消（`qualification_cancel`）同一口径：本门店 `status = pending_start` 且无在途取消的订购单，`status = pending_assign` 或 `returned`（`returned_from = pending_assign`）且无在途取消的广告（09-order-ad.md:808）；逐项按 `cancelLine` 的 `release` 全额算；返回 `{ pendingStartOrderCount, pendingAssignAdCount, heldPoints, orders: [{ orderId, orderNo, heldPoints }], ads: [{ adId, adNo, heldPoints }], computedAt }`；只读 |
| 交付经理转移的改派实现 | a03 `admin.store.reassignDeliveryManager`、a01 员工禁用移交 | 在调用方事务里：本门店未结订购单（`status` 不在 `ended`、`cancelled`、`refunded`）的 `drama_order.delivery_manager_id`、未归档未终止工单的 `delivery_ticket.delivery_manager_id` 等于原负责人的改为接收人，逐对象写 `assignment_history`（`source = store_manager`，`subject_type` 为 `drama_order`、`delivery_ticket`，同一 `batch_id`）；为空的订购单同步为接收人、不写记录；`assigning` 步骤的工单不动（仍由 3.20 分配） |
| 门店首次分配交付经理的工单分配实现 | a03 `admin.store.assignDeliveryManager`（3.8a）；本文 3.20 | 与 3.20 共用一个实现：在调用方事务里把本门店未暂停、`step = assigning` 的工单逐张按 `ticket.assign` 迁移到 `plan_confirm`（写 `delivery_manager_id`、`assigned_at`，开环节与时限），同步未结订购单的 `drama_order.delivery_manager_id`；不写 `assignment_history`、不登记联系时限（首次分配没有原负责人）；每张工单一条 `ticket.assigned`。暂停中的工单留在待分配，恢复后由 3.20 分配 |
| 工作台待办的计数函数（a02 2.3 待办来源登记表的键） | a02 `admin.workbench.todo.get` | 见下表 |

| 来源键（a02） | 条件 | 副指标 | 与本文同口径的查询（跳转目标与预置筛选） |
| --- | --- | --- | --- |
| `ticket_assign` | `delivery_ticket.step = assigning` | `nearest_due`：最早的 `step_due_at` | `admin.deliveryTicket.list?tab=assigning`；`summary.tabs.assigning` |
| `release_deliver` | `delivery_ticket.step = delivering` | `overdue`：`step_due_at` 已过的条数 | `admin.deliveryTicket.list?tab=delivering`；`summary.tabs.delivering` |
| `plan_push` | 工单在 `plan_confirm` 且 `waiting_on = staff`（方案草稿待推送，或商家提了修改待答复） | `nearest_due`：最早的 `step_due_at` | `admin.deliveryTicket.list?todo=plan_push` |
| `sample_qc` | 工单在 `sample_making`、未暂停，“活着”的样片 `status = uploaded` 且制作留痕 `pipeline_state = ready` | `nearest_due` | `admin.deliveryTicket.list?todo=sample_qc` |
| `staff_assign` | 工单在 `ad_prep`、`sample_making` 而 `editor_id` 为空，或在 `delivering` 而 `publisher_id` 为空（d3-flow.md:992-993） | `none` | `admin.deliveryTicket.list?todo=staff_assign` |
| `ad_produce` | `ad.status` ∈ {`pending_assign`、`producing`、`revising`}（剪辑师只计本人；`pending_assign` 只对持 `delivery.ad.assign` 者计入） | `due_today`：`due_at` 落在今天的条数 | `admin.ad.list?tab=todo`；`admin.ad.summary` 的 `tabs.todo` |
| `ad_waiting_qualification` | `ad.status = pending_assign` 且门店资质未通过 | `none` | `admin.ad.list?isWaitingQualification=true`；`waitingQualificationCount` |
| `ad_returned_stale` | `ad.status = returned` 且 `returned_at` 早于 现在 − 参数 `ad.returned_stale_days` 个自然日（与定时器 `ad.returned_stale` 的触发条件相同） | `earliest`：最早的 `returned_at` | `admin.ad.list?tab=returned&isReturnedStale=true` |
| `order_rejected_stale` | `drama_order.status = pending_start`、`sub_status = qualification_rejected`，门店最近一次资质驳回（`approval_request.kind = qualification`、`status = rejected` 的 `decided_at`）早于 现在 − 参数 `order.rejected_stale_days` 个自然日（与定时器 `order.rejected_stale` 相同） | `earliest` | `admin.order.list?tab=pending_start&isRejectedStale=true` |
| `refund_approval`（取消一侧） | `cancel_request.status` ∈ {`pending_approval`、`pending_execution`} | `points_total`：`total_refund_points` 之和 | `admin.cancelRequest.summary` 的 `inProgressCount`；列表 `tab=pending_approval` / `pending_execution` |

a02 2.3 为交付侧来源暂定的归属角色与可见条件，本文确认照用：`plan_push`、`sample_qc`、`staff_assign`、`ad_waiting_qualification` 归 `delivery_manager`，可见条件依次为 `delivery.plan.push`、`delivery.sample.qc`、`delivery.ticket.assign_editor` 或 `delivery.ticket.assign_publisher`、`delivery.ad.assign`；`ad_returned_stale` 归 `cs`，可见条件为模块 `delivery` ≥ v（跳转目标 `admin.ad.list` 的查看门槛）；`order_rejected_stale` 归 `cs`，可见条件为模块 `order` ≥ v。计数一律套调用者的数据范围，与跳转后列表的 `total` 相同。

## 2. 公共结构

类型写法按写作规范：`string(uuid)`、`string(date-time)`、`string(date)`、`string(bigint)`、`integer`、`integer(积分)`、`integer(万分比)`、`enum(…)`、`boolean`、`array<…>`、`object`，可空写 `| null`。“来源”一列写表列或计算规则。后台不分观察者角色，没有店员视图。

### 2.1 通用片段

#### 引用的公共结构（C87）

本文不再定义分页外壳与签名地址，直接引用归属文档的结构：

| 结构 | 归属 | 形态 | 本文用在 |
| --- | --- | --- | --- |
| `AdminPage<T>` | a01-system 2.1 | `{ items, page, pageSize, total }`（C43） | 3.1、3.8、3.16、3.46 的 `logs`、3.51、3.63（原 `AdminPage<X>`） |
| `AdminCursorPage<T>` | a01-system 2.1 | `{ items, nextCursor, hasMore, totalApprox }`（A22） | 3.5、3.19 操作日志（原 `CursorResult<X>`） |
| `SignedUrl` | a01-system 2.17 | `{ url, expiresAt }`，`url` 不可空；需要可空时整个对象可空（C60） | 缩略图、预览等随数据现签的地址 |
| `ImageRef` | m08-support-misc 2.1 | `{ fileId, url, expiresAt }` | 样片反馈图片、广告修改截图（原写作 `SignedUrl & { fileId }`） |
| `ApprovalDecisionView` | a01-system 2.10 | 审批决定信息（`reasons` 带名称） | `CancelRequestDetail.approval` |
| `DictRef` | 约定通用结构（C85、C87，A150） | `{ code, name }`（C85） | 多值：题材 `genres`、定制重点 `focus`、宣传重点 `promoPoints`；单值（A151）：`AdminStoreBrief.city` / `district`、侧栏 `province` / `industry` / `category`、补发原因 `reason`；请求里收编码（如 `focusCodes`、`reasonCode`） |

#### `StaffBrief`

不在本文定义：直接引用 a01-system 2.2 的 `StaffBrief`（`staffId`、`staffNo`、`name`、`roleKey`、`isLead`、`status`），后台全仓一份。页面上的“唐悦（客服主管）”由 `roleKey` 的角色名与 `isLead` 拼出；已禁用的员工照常返回，标“已停用”。

#### `AdminStoreBrief`

后台交付侧用的门店摘要，本文为归属文档（C87）；a06 等文档直接引用，名字与形状保持稳定。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `storeId` | string(uuid) | 是 | 门店 | `store.id` |
| `storeName` | string \| null | 是 | 门店名称（草稿门店可能为空） | `store.name` |
| `entityId` | string(uuid) | 是 | 经营主体 | `store.entity_id` |
| `entityName` | string \| null | 是 | 主体名称 | `entity.name` |
| `city` | `DictRef` \| null | 是 | 门店所在市（C85、A151；`city.code` 即选人下拉的 `recommendCityCode`） | `store_profile.city_code` + 字典 `region` |
| `district` | `DictRef` \| null | 是 | 门店所在区县（工单池分配弹窗的“门店区域：成都市龙泉驿区”= `city.name` + `district.name`） | `store_profile.district_code` + 字典 `region` |
| `qualificationStatus` | enum(`unsubmitted`,`pending`,`rejected`,`verified`) | 是 | 门店资质状态（广告“等待资质审核”、订购单子状态的依据） | `store.qualification_status` |

#### `AdminChecklistItemView`

后台的清单条目视图，本文为归属文档（C87）；a06 直接引用。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `key` | string | 是 | 条目键 | 结论数组的 `key` |
| `label` | string | 是 | 条目名称 | `checklist_template.items[].label` |
| `result` | enum(`pass`,`fail`,`na`) | 是 | 结论 | 结论数组的 `result` |
| `note` | string \| null | 是 | 说明（`fail` 必有） | 结论数组的 `note` |
| `merchantVisible` | boolean | 是 | 是否向商家展示 | `checklist_template.items[].merchantVisible` |

#### `ChecklistResultInput`（请求体片段）

提交质检或交付前检查时用（本文为归属文档，C87；a06 直接引用）；服务端按“当前启用的版本”校验：必填条目都有结论、`fail` 有说明、`na` 只出现在 `allowNa` 的条目上（`d3-flow.md:1499`；`14-config-data.md:1149`）。

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `checklistVersionNo` | integer | 是 | 等于该清单编码当前启用的版本号 | 前端加载清单时取得（`admin.checklistTemplate.list`，a01-system）；不等返回 409 `CHECKLIST_VERSION_STALE`（a01-system 定义） |
| `results` | array<{ `key`, `result`, `note` }> | 是 | `key` 属于该版本；`result` ∈ `pass` / `fail` / `na`；`note` ≤ 200 字 | 逐项结论，原样落库 |

#### `ActivityItem`

操作日志的一行（本文为归属文档，C87；a04 的操作日志直接引用，名字与形状保持稳定）。来源是活动流审计（`audit_log.stream = activity`，M31：每次状态迁移同事务补写一条）；属于状态迁移的行另带迁移信息（同一 `request_id`、同一对象的 `status_transition` 行）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `activityId` | string(uuid) | 是 | 日志行 | `audit_log.id` |
| `occurredAt` | string(date-time) | 是 | 发生时间 | `audit_log.created_at` |
| `actorType` | enum(`merchant`,`staff`,`system`,`partner`) | 是 | 操作人类型（“系统 / 员工 / 商家”） | `audit_log.actor_type` |
| `actorName` | string \| null | 是 | 操作人显示名（系统为空） | `audit_log.actor_name` |
| `actorRole` | string \| null | 是 | 操作人角色（员工角色键或商家角色） | `audit_log.actor_role` |
| `client` | enum(`weapp`,`portal`,`admin`,`cli`) \| null | 是 | 客户端来源 | `audit_log.client` |
| `action` | string | 是 | 审计动作 `<领域>.<对象>.<动作>` | `audit_log.action` |
| `summary` | string | 是 | 一句话内容（“生成工单，分配给专属交付经理林晓”） | `audit_log.summary` |
| `targetType` | string | 是 | 对象类型（表名） | `audit_log.target_type` |
| `targetId` | string(uuid) \| null | 是 | 对象 | `audit_log.target_id` |
| `targetLabel` | string \| null | 是 | 对象标签（单号、版本号） | `audit_log.target_label` |
| `reasonText` | string \| null | 是 | 原因或说明 | `audit_log.reason_text` |
| `transition` | object \| null | 是 | 状态迁移：`{ machine, stateField, fromState, toState, event, isForced }` | `status_transition.machine`、`state_field`、`from_state`、`to_state`、`event`、`is_forced` |

#### `ReturnBreakdownView`

账本的退回去向（`09-order-ad.md` 4.5 的 `ReturnBreakdown`）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `qty` | integer(积分) | 是 | 请求退回或释放的数量 | `preview_snapshot.qty` / `result_snapshot.qty` |
| `backToOriginal` | integer(积分) | 是 | 回到原批次可用（“回到本期套餐积分”） | `….backToOriginal` |
| `convertedToAddon` | integer(积分) | 是 | 原周期已结束、转为加购积分 | `….convertedToAddon` |
| `forfeited` | integer(积分) | 是 | 原周期已结束、不予退回 | `….forfeited` |
| `lots` | array<{ `lotKind`: enum(`plan`,`addon`), `expiresAt`: string(date-time) \| null, `qty`: integer, `route`: enum(`original`,`converted`,`forfeited`) }> | 是 | 逐批次去向（“回到本期套餐积分 X（10-17 清零）”） | `….lots` |

#### `ReferenceFileView`

订购单、广告登记的一个参考文件（M20：参考素材统一登记在 `file_ref`，`role = reference`；来自素材库的另有一行 `store_asset_usage`，来自门店档案媒体的只有 `file_ref`）。订购单详情、广告详情、制作素材清单共用。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `fileId` | string(uuid) | 是 | 文件 | `file_ref.file_id` |
| `source` | enum(`store_asset`,`profile_media`) | 是 | 来源：素材库、门店档案媒体 | 有同文件的 `store_asset_usage`（`used_by_type` = 引用方、`role = reference`）为 `store_asset`，否则 `profile_media` |
| `storeAssetId` | string(uuid) \| null | 是 | 素材库素材（仅 `store_asset`） | `store_asset_usage.store_asset_id` |
| `title` | string \| null | 是 | 素材标题（仅 `store_asset`） | `store_asset.title` |
| `usability` | enum(同数据模型 `store_asset.usability`) \| null | 是 | 素材可用性（仅 `store_asset`；剪辑师据此判断能否用于成片） | `store_asset.usability` |
| `mediaGroup` | enum(`door`,`interior`,`product`,`promo`) \| null | 是 | 档案媒体的分组：门头、店内环境、产品（菜品）、宣传（仅 `profile_media`；“门头照片 1 张、主推菜品图 2 张”） | 同门店 `store_profile_media.media_group`（按 `store_id` + `file_id`，含已移除的行） |
| `type` | enum(同数据模型 `store_asset.type`) | 是 | 素材类型；档案媒体只有 `image`、`video` | `store_asset.type` / `store_profile_media.media_kind` |
| `thumbnail` | `SignedUrl` \| null | 是 | 缩略图（30 分钟对齐窗口，不留痕）；文件已不可读时为空 | `file_object` 的缩略图现签 |

### 2.2 订购单

#### `AdminOrderCard`

`admin.order.list` 的元素。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderId` | string(uuid) | 是 | 订购单 | `drama_order.id` |
| `orderNo` | string | 是 | 订单号 `LYX…` | `drama_order.order_no` |
| `submittedAt` | string(date-time) | 是 | 下单时间 | `drama_order.submitted_at` |
| `store` | `AdminStoreBrief` | 是 | 商家（门店）与主体 | `drama_order.store_id` → 2.1 |
| `planCode` | string | 是 | 下单时的套餐版本编码 | `drama_order.plan_code` |
| `planName` | string \| null | 是 | 套餐版本名称（“专业版”） | `plan.name`（`plan.code = drama_order.plan_code`） |
| `itemCount` | integer | 是 | 剧目数 | `drama_order.item_count` |
| `firstDramaTitle` | string | 是 | 首部剧名（“《X》等 2 部”） | `item_no = 1` 的 `order_item.drama_snapshot.title` |
| `firstEpisodeCount` | integer | 是 | 首部剧集数（“整部 80 集 · 门店定制”） | `item_no = 1` 的 `order_item.episode_count` |
| `platforms` | array<enum(`douyin`,`wechat_channels`)> | 是 | 发布账号平台（去重） | `order_item_account.platform` |
| `productionModels` | array<enum(`standard`,`advanced`,`top`)> | 是 | 制作模型（去重） | `order_item.production_model` |
| `discountBp` | integer(万分比) | 是 | 折扣（“9 折”） | `drama_order.discount_bp` |
| `isTopModel` | boolean | 是 | 是否勾选顶级模型 | `drama_order.is_top_model` |
| `surchargeBp` | integer(万分比) | 是 | 加扣比例（“顶级 ＋20%”） | `drama_order.surcharge_bp` |
| `totalChargePoints` | integer(积分) | 是 | 应扣积分合计 | `drama_order.total_charge_points` |
| `status` | enum(见 4.1 `OrderStatus`) | 是 | 订单状态（8 种） | `drama_order.status` |
| `subStatus` | enum(见 4.1 `OrderSubStatus`) \| null | 是 | 子状态 | `drama_order.sub_status` |
| `statusChangedAt` | string(date-time) | 是 | 最近一次状态变化 | `drama_order.status_changed_at` |
| `deliveryManager` | `StaffBrief` \| null | 是 | 交付经理 | `drama_order.delivery_manager_id` |
| `openCancelRequest` | object \| null | 是 | 在途取消：`{ cancelRequestId, requestNo, status }`（“取消审批中 · 退回 N 积分”另取 `totalRefundPoints`） | `drama_order.open_cancel_request_id` → `cancel_request.id`、`cancel_request.status`、`cancel_request.total_refund_points`；`approval_request.request_no` |
| `actions` | array<string> | 是 | `cancel`（发起取消：有 `order.refund.request`、无在途取消、至少一个订单项可取消） | 计算 |

`openCancelRequest` 的完整结构：`{ cancelRequestId: string(uuid), requestNo: string, status: enum(4.2 CancelStatus), totalRefundPoints: integer }`。

#### `AdminOrderItemRow`

订单项（剧目明细表的一行；工单详情也用）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderItemId` | string(uuid) | 是 | 订单项 | `order_item.id` |
| `itemNo` | integer | 是 | 单内序号（工单号后缀） | `order_item.item_no` |
| `dramaId` | string(uuid) | 是 | 剧目 | `order_item.drama_id` |
| `dramaTitle` | string | 是 | 剧名（下单快照） | `order_item.drama_snapshot.title` |
| `genres` | array<`DictRef`> | 是 | 题材（“都市温情 · 整部 80 集”） | `order_item.drama_snapshot.genreCodes` + 字典 `genre` |
| `episodeCount` | integer | 是 | 整部集数 | `order_item.episode_count` |
| `productionModel` | enum(`standard`,`advanced`,`top`) | 是 | 制作模型 | `order_item.production_model` |
| `listPricePoints` | integer(积分) | 是 | 剧目积分价 P | `order_item.list_price_points` |
| `discountBp` | integer(万分比) | 是 | 折扣 R | `order_item.discount_bp` |
| `surchargeBp` | integer(万分比) | 是 | 加扣 T | `order_item.surcharge_bp` |
| `chargePoints` | integer(积分) | 是 | 应扣 S（“2,700 = 3,000 × 0.9”） | `order_item.charge_points` |
| `phase` | enum(见 4.1 `ItemPhase`) | 是 | 订单项阶段 | `order_item.phase` |
| `phaseChangedAt` | string(date-time) | 是 | 最近一次阶段变化 | `order_item.phase_changed_at` |
| `capturedAt` | string(date-time) \| null | 是 | 冻结转扣减的时间（开工） | `order_item.captured_at` |
| `agreedLaunchDate` | string(date) \| null | 是 | 约定上线日；空 = 待确认 | `order_item.agreed_launch_date` |
| `usageStartDate` | string(date) \| null | 是 | 上线首日；空 = 未上线 | `order_item.usage_start_date` |
| `usageEndDate` | string(date) | 是 | 使用期止日 | `order_item.usage_end_date` |
| `usageEndSource` | enum(`license`,`early_end`,`expired`) | 是 | 止日来源 | `order_item.usage_end_source` |
| `liveEpisodeCount` | integer | 是 | 已核验上线集数 | `order_item.live_episode_count` |
| `accounts` | array<{ `channelAccountId`, `platform`, `accountName`, `accountUid`, `status` }> | 是 | 发布账号（“抖音 @XX火锅”） | `order_item_account` 联 `channel_account.account_name`、`account_uid`、`status` |
| `placements` | array<{ `slot`, `adId`, `adNo`, `durationSec`, `boundVersionNo`, `pinnedAt` }> | 是 | 广告位绑定；`boundVersionNo` 为空 = 浮动 | `order_item_placement.slot`、`ad_id`、`duration_sec`、`bound_version_no`、`pinned_at`；`ad.ad_no` |
| `refundRequestedPoints` | integer(积分) | 是 | 已请求退回累计 | `order_item.refund_requested_points` |
| `returnedPoints` | integer(积分) | 是 | 实际回到原批次 | `order_item.returned_points` |
| `convertedPoints` | integer(积分) | 是 | 转为加购积分 | `order_item.converted_points` |
| `forfeitedPoints` | integer(积分) | 是 | 不予退回 | `order_item.forfeited_points` |
| `cancelReasonCode` | enum(见 4.2 `CancelReason`) \| null | 是 | 取消或终止原因 | `order_item.cancel_reason_code` |
| `cancelledAt` | string(date-time) \| null | 是 | 取消或终止时间 | `order_item.cancelled_at` |
| `ticket` | object \| null | 是 | 交付工单 `{ deliveryTicketId, ticketNo, step, isPaused }`；待开工、开工前已取消为空 | `delivery_ticket.id`、`ticket_no`、`step`；`delivery_ticket.pause_count > 0` |
| `pointHold` | object | 是 | 冻结单 `{ pointHoldId, status, heldAt, capturedAt }` | `order_item.point_hold_id` → `point_hold.id`、`status`、`held_at`、`captured_at` |

#### `AdminOrderDetail`

`admin.order.get` 的响应。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| （`AdminOrderCard` 的全部字段） | — | 是 | 同上 | 同上 |
| `startedAt` | string(date-time) \| null | 是 | 开始制作（积分扣减） | `drama_order.started_at` |
| `closedAt` | string(date-time) \| null | 是 | 进入已结束、已取消、已退回积分的时间 | `drama_order.closed_at` |
| `focus` | array<`DictRef`> | 是 | 定制重点 | `drama_order.focus_codes` + 字典 `custom_focus` |
| `note` | string \| null | 是 | 补充说明 | `drama_order.note` |
| `expectedLaunchDate` | string(date) \| null | 是 | 期望上线日；空 = 成片交付后尽快上线 | `drama_order.expected_launch_date` |
| `referenceFiles` | array<`ReferenceFileView`> | 是 | 参考素材，素材库与门店档案两种来源都列（“商家档案：门头与店内环境 8 张、菜品实拍 5 张”由前端按 `source`、`mediaGroup` 汇总） | `file_ref`（`ref_type = drama_order`、`ref_id` = 本单、`role = reference`、`state = live`），见 2.1 `ReferenceFileView`（M20：素材库来源另有 `store_asset_usage`，档案媒体只登记 `file_ref`） |
| `subscriptionTerm` | object | 是 | 下单时的周期 `{ subscriptionTermId, startDate, endDate }`（“所属周期 专业版 09-13 至 10-12”） | `drama_order.subscription_term_id` → `subscription_term.start_date`、`end_date` |
| `items` | array<`AdminOrderItemRow`> | 是 | 剧目明细，按 `itemNo` | 2.2 |
| `deliveryPlan` | object \| null | 是 | 交付方案摘要 `{ deliveryPlanId, status, currentVersionNo, confirmedVersionNo, pushedAt, confirmedAt, launchMode }`；开工前为空；详情走 `admin.deliveryPlan.get` | `delivery_plan.id`、`status`、`current_version_no`、`confirmed_version_no`、`pushed_at`、`confirmed_at`；`launchMode` 取 `current_version_no` 那一版 `delivery_plan_version.content_snapshot.launchMode` |
| `pointsBreakdown` | object | 是 | 积分明细：`{ listPriceTotalPoints, discountDeltaPoints, surchargeDeltaPoints, totalChargePoints, planPoints, addonPoints }`（“剧目积分价合计 5,000、专业版 9 折 −500、应扣 4,500、扣减来源 套餐积分 4,500”） | Σ`order_item.list_price_points`；Σ(round(P×R) − P)；Σ(S − round(P×R))；`drama_order.total_charge_points`；`point_hold_alloc.qty` 按 `lot_kind` 求和 |
| `pointsEvents` | array<{ `opType`: enum(`hold`,`capture`,`release`,`refund`), `occurredAt`, `points`, `planPoints`, `addonPoints` }> | 是 | 冻结与扣减时间线（同一事务的多部剧合为一行） | `ledger_operation.op_type`、`occurred_at`、`plan_delta_qty`、`addon_delta_qty`（`point_hold_id` 属于本单各订单项） |
| `agreements` | array<{ `agreementKey`, `title`, `versionLabel`, `consentedAt`, `method` }> | 是 | 协议：本单的《定制内容授权使用协议》、所绑广告的《广告制作与交付服务协议》（按版本去重） | `drama_order.agreement_consent_id`、`ad.agreement_consent_id` → `agreement_consent.agreement_key`、`agreement_version_id`、`consented_at`、`method`；`agreement.name`；`agreement_version.major`、`minor` |
| `licenseLetterCount` | integer | 是 | 未作废的授权书份数（“《定制内容授权书》× 2”） | `license_letter`（`drama_order_id` = 本单、`status <> voided`）计数 |
| `licenseLetters` | array<object> | 是 | 协议区逐封列出未作废的授权书（“剧 × 账号”一封）：`{ licenseLetterId, orderItemId, dramaTitle, letterNo, platform, accountName, status, isExpired, periodStart, periodEnd, currentRevision: { licenseLetterRevisionId, revNo, renderStatus, fileId } \| null }`；版次历史与操作走 3.47（每单至多“剧数 × 2 个平台”封，不分页） | `license_letter`（`drama_order_id` = 本单、`status <> voided`）联 `channel_account.account_name`、`order_item.drama_snapshot.title`；`current_revision_id` → `license_letter_revision` |
| `merchant` | object | 是 | 侧栏“商家与负责人”：`{ contactName, contactPhoneMask, currentPlanName, currentTermEndDate, spendablePoints, planAvailablePoints, addonAvailablePoints, sourceType }`（“套餐 专业版 · 10-12 到期”“可用积分 2,920（套餐 1,920 · 加购 1,000）”）；没有生效周期时套餐两项为空 | `store_profile.contact_name`、`contact_phone_mask`；`billing_account.current_subscription_term_id` → `subscription_term.plan_id` → `plan.name`、`subscription_term.end_date`；`billing_account.plan_available_qty`、`addon_available_qty` 及其和；`entity.source_type` |
| `cancelRequests` | array<`CancelRequestCard`> | 是 | 本单的取消申请（含已关闭），按提交时间倒序 | `cancel_request`（`drama_order_id` = 本单） |
| `lockVersion` | integer | 是 | 订购单的乐观锁版本（只读，本文没有带它的写接口） | `drama_order.lock_version` |

#### `OrderSummary`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `tabs` | object | 是 | 键与列表的 `tab` 取值一致：`all`、`pending_start`、`producing`、`to_launch`、`live`、`ended`、`cancelled`、`after_sale`、`refunded`，值为订购单数 | `drama_order` 按 `status` 计数（`ix_drama_order_status_submitted_at`） |

#### `OrderQuoteResult`

`admin.order.quote` 的响应（与商家端 `m.order.quote` 用同一个计价函数 `quoteDramaItem`，`d1-ledger.md` 5.1）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `quotedAt` | string(date-time) | 是 | 计价时刻 | 账本时钟 |
| `dramaId` | string(uuid) | 是 | 剧目 | 请求 |
| `dramaTitle` | string | 是 | 剧名 | `drama.title` |
| `heatTier` | enum(`S`,`A`,`B`,`C`) \| null | 是 | 热度等级 | `drama.heat_tier` |
| `priceMode` | enum(`template`,`custom`) | 是 | 定价方式 | 当时生效的 `drama_price_revision.mode`；没有修订为 `template` |
| `listPricePoints` | integer(积分) \| null | 是 | 剧目积分价 P；算不出（无等级且无单剧价）为空 | `drama_price_revision.custom_points`，或 `price_tier_revision.points`（按 `drama.heat_tier`） |
| `planCode` | string | 是 | 套餐版本 | 请求 |
| `planName` | string | 是 | 版本名称 | `plan.name` |
| `discountBp` | integer(万分比) | 是 | 折扣 R | 当前 `plan_revision.discount_bp` |
| `productionModel` | enum(`standard`,`advanced`,`top`) | 是 | 该版本的默认制作模型 | 当前 `plan_revision.production_model` |
| `isTopModelSelected` | boolean | 是 | 是否按次选用顶级模型；版本默认即顶级（旗舰版）时恒为真且锁定 | 请求，或 `production_model = top` |
| `surchargeBp` | integer(万分比) | 是 | 实际适用的加扣 T：版本默认顶级为 0；按次选用为参数值；否则 0 | `billing_param`（键 `topModelSurchargeBp`）当前值 |
| `discountedPoints` | integer(积分) \| null | 是 | round(P × R) | 计算 |
| `chargePoints` | integer(积分) \| null | 是 | 应扣 S = round(P × R × (1 + T)) | `quoteDramaItem` |
| `formula` | string \| null | 是 | 算式文本（“2,600 × 0.9 × (1 + 20%) = 2,808”） | 计算 |
| `orderable` | boolean | 是 | 剧目此刻是否可订（不影响试算） | `content.getOrderability` |
| `unorderableReason` | string \| null | 是 | 不可订原因（取 m04-mall-order 的 `DRAMA_NOT_ORDERABLE` 的 `reason` 取值） | 同上 |

#### `CancelQuote`

订购取消与广告取消的试算结果（`admin.order.cancelQuote`、`admin.ad.cancelQuote`），也是发起时的重算口径。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `quotedAt` | string(date-time) | 是 | 试算时刻 | 账本时钟 |
| `reasonCode` | enum(见 4.2 `CancelReason`) | 是 | 取消原因（切换原因即重算） | 请求 |
| `lines` | array<`CancelQuoteLine`> | 是 | 逐项核算：订购取消按剧，广告取消一行 | `cancelLine`（`d3-flow.md:2112-2134`）+ `billing.previewReturn` |
| `totalBasePoints` | integer(积分) | 是 | 基数合计 Σ（应扣 − 已请求退回） | 计算 |
| `totalDeductPoints` | integer(积分) | 是 | 扣除合计 | 计算 |
| `totalRefundPoints` | integer(积分) | 是 | 退回或释放合计（“合计退回”） | 计算 |
| `destination` | `ReturnBreakdownView` | 是 | 各行去向之和（“退回去向：套餐积分，本期内有效”） | 各行 `preview` 求和 |
| `needsManualDeduct` | boolean | 是 | 有“样片确认后至上线前”且快照没有比例的行，须填扣除数与依据 | 任一行 `isManualDeduct` |
| `blockers` | array<{ `orderItemId`: string(uuid) \| null, `reason`: enum(`item_closed`,`live_not_refundable`,`item_expired`,`in_other_request`,`ad_confirmed`,`ad_cancelled`,`ad_in_use`) }> | 是 | 不能取消的对象及原因；订购取消时这些订单项不进 `lines` | `cancelLine` 的 `invalid` 分支；`ad.status`；`order_item_placement` |
| `expect` | object | 是 | `{ totalRefundPoints }`，发起时原样带回，服务端重算不等返回 `CANCEL_QUOTE_CHANGED` | 计算 |

#### `CancelQuoteLine`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `targetType` | enum(`order_item`,`ad`) | 是 | 对象类型 | 计算（落 `cancel_request_line.target_type`） |
| `targetId` | string(uuid) | 是 | 订单项或广告 | `order_item.id` / `ad.id` |
| `label` | string | 是 | 显示名：剧名，或“片头贴片 5 秒 · GG…” | `order_item.drama_snapshot.title`；`ad.type`、`ad.duration_sec`、`ad.ad_no` |
| `episodeCount` | integer \| null | 是 | 仅订单项：整部集数（“《夜巷疑云》整部 45 集 · 高级模型 · 抖音”） | `order_item.episode_count` |
| `productionModel` | enum(`standard`,`advanced`,`top`) \| null | 是 | 仅订单项：制作模型 | `order_item.production_model` |
| `platforms` | array<enum(`douyin`,`wechat_channels`)> | 是 | 仅订单项：发布账号平台；广告行为空数组 | `order_item_account.platform` |
| `mode` | enum(`release`,`refund`,`terminate_only`) | 是 | 账本动作 | 计算 |
| `stage` | enum(见 4.2 `CancelStage`) | 是 | 核算阶段（“方案确认阶段”） | 工单步骤或广告状态映射（`09-order-ad.md:1029-1040`） |
| `stepAtSubmit` | string \| null | 是 | 当前工单步骤或广告状态；待开工为空 | `delivery_ticket.step` / `ad.status` |
| `reasonClass` | enum(`merchant`,`platform`,`qualification`) | 是 | 账本原因类别 | 由 `reasonCode` 固定映射 |
| `chargePoints` | integer(积分) | 是 | 应扣 S | `order_item.charge_points` / `ad.charge_points` |
| `priorRequestedPoints` | integer(积分) | 是 | 已请求退回累计 | `order_item.refund_requested_points` / `ad.refund_requested_points` |
| `ratioBp` | integer(万分比) \| null | 是 | 扣除比例（计价快照里的值；平台原因为 0）；释放、已上线、人工录入为空 | `order_item.pricing_snapshot.cancelDeductionBp.<阶段键>` / `ad.pricing_snapshot.cancelDeductionBp.adInProduction` |
| `isManualDeduct` | boolean | 是 | 须人工录入扣除数（`post_sample` 且快照为 null） | 计算 |
| `deductPoints` | integer(积分) | 是 | 扣除数量；人工录入的行取请求值，未填时为 0 | 计算 |
| `deductNote` | string \| null | 是 | 人工录入的依据说明 | 请求 |
| `refundPoints` | integer(积分) | 是 | 本次请求退回或释放的数量 | 计算 |
| `terminationDate` | string(date) \| null | 是 | 仅已上线：终止日 | 请求，缺省为今天 |
| `usageStartDate` | string(date) \| null | 是 | 仅已上线：上线首日 | `order_item.usage_start_date` |
| `usageEndDate` | string(date) \| null | 是 | 仅已上线：使用期止日 | `order_item.usage_end_date` |
| `usageEndSource` | enum(`license`,`early_end`,`expired`) \| null | 是 | 仅已上线：止日来源 | `order_item.usage_end_source` |
| `capturedAt` | string(date-time) \| null | 是 | 扣减时间（“09-25 09:56 开始制作”） | `order_item.captured_at` / `ad.captured_at` |
| `preview` | `ReturnBreakdownView` | 是 | 账本去向预览 | `billing.previewReturn` |

### 2.3 取消申请

#### `CancelRequestCard`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `cancelRequestId` | string(uuid) | 是 | 取消申请 | `cancel_request.id` |
| `requestNo` | string | 是 | 申请单号 `TK…` | `approval_request.request_no` |
| `kind` | enum(`order_cancel`,`ad_cancel`,`qualification_cancel`) | 是 | 类型 | `cancel_request.kind` |
| `store` | `AdminStoreBrief` | 是 | 商家 | `cancel_request.store_id` |
| `target` | object | 是 | 对象 `{ type: enum(drama_order, ad, store), id, no, label }`：订购单号与“《X》等 N 部”；广告编号与“片头贴片 5 秒”；整店取消为门店名 | `cancel_request.drama_order_id` → `drama_order.order_no`；`cancel_request.ad_id` → `ad.ad_no`、`ad.type`、`ad.duration_sec`；`store.name` |
| `reasonCode` | enum(见 4.2 `CancelReason`) | 是 | 取消原因 | `cancel_request.reason_code` |
| `lineCount` | integer | 是 | 明细行数 | `cancel_request.line_count` |
| `totalBasePoints` | integer(积分) | 是 | 基数合计（已扣积分） | `cancel_request.total_base_points` |
| `totalDeductPoints` | integer(积分) | 是 | 扣除合计 | `cancel_request.total_deduct_points` |
| `totalRefundPoints` | integer(积分) | 是 | 退回或释放合计 | `cancel_request.total_refund_points` |
| `isFullReturn` | boolean | 是 | 全额退回（队列标签“全额退回积分 / 按阶段退回积分”） | `total_deduct_points = 0` |
| `status` | enum(见 4.2 `CancelStatus`) | 是 | 执行状态 | `cancel_request.status` |
| `closeReason` | enum(`rejected`,`withdrawn`,`voided`) \| null | 是 | 未执行即关闭的原因 | `cancel_request.close_reason` |
| `approvalStatus` | enum(`pending`,`approved`,`rejected`,`withdrawn`) | 是 | 审批单状态 | `approval_request.status` |
| `submittedAt` | string(date-time) | 是 | 申请时间 | `approval_request.submitted_at` |
| `requester` | `StaffBrief` \| null | 是 | 发起人（“唐悦（客服主管）”取 `roleKey`、`isLead`）；整店取消记为作出终局驳回的审核人 | `approval_request.requester_staff_id` |
| `isSystemSubmitted` | boolean | 是 | 系统生成（整店取消） | `approval_request.submit_actor_type = system` |
| `approvalDueAt` | string(date-time) \| null | 是 | 审批时限 | `approval_request.due_at` |
| `decidedAt` | string(date-time) \| null | 是 | 审批通过、驳回或撤回的时间（“审批通过于 / 驳回于”） | `approval_request.decided_at` |
| `execDueAt` | string(date-time) \| null | 是 | 执行时限 | `cancel_request.exec_due_at` |
| `executedAt` | string(date-time) \| null | 是 | 执行时间（“退回于”） | `cancel_request.executed_at` |
| `isOverdue` | boolean | 是 | 待审批超过 `approvalDueAt`，或待执行超过 `execDueAt` | 计算 |
| `actions` | array<string> | 是 | 见 `CancelRequestDetail.actions` | 计算 |

#### `CancelLineView`

`CancelQuoteLine` 的全部字段（取自 `cancel_request_line` 的同名列：`target_type`、`target_id`、`mode`、`stage`、`step_at_submit`、`reason_class`、`charge_points`、`prior_requested_points`、`ratio_bp`、`deduct_points`、`deduct_note`、`refund_points`、`termination_date`、`usage_start_date`、`usage_end_date`、`usage_end_source`；`preview` 取 `preview_snapshot`；`label`、`episodeCount`、`productionModel`、`platforms` 按 `target_id` 现取订单项或广告），另加：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `cancelRequestLineId` | string(uuid) | 是 | 明细行 | `cancel_request_line.id` |
| `result` | object \| null | 是 | 执行结果 `{ executedAt, returnedPoints, convertedPoints, forfeitedPoints, breakdown: ReturnBreakdownView }`；未执行为空 | `cancel_request_line.executed_at`、`returned_points`、`converted_points`、`forfeited_points`、`result_snapshot` |
| `targetState` | string | 是 | 对象当前状态（订单项阶段或广告状态） | `order_item.phase` / `ad.status` |

#### `CancelRequestDetail`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| （`CancelRequestCard` 的全部字段） | — | 是 | 同上 | 同上 |
| `note` | string | 是 | 申请说明 | `cancel_request.note` |
| `lines` | array<`CancelLineView`> | 是 | 逐项核算 | `cancel_request_line` |
| `destination` | `ReturnBreakdownView` | 是 | 提交时的去向之和（财务审批时看到的就是这一份） | 各行 `preview_snapshot` 求和 |
| `resultTotals` | object \| null | 是 | 执行后的实际去向合计 `{ returnedPoints, convertedPoints, forfeitedPoints }`（“积分将即时退回”之后显示） | 各行实际数量求和 |
| `approval` | `ApprovalDecisionView` | 是 | 沿a01-system 2.10公共审批字段：`approvalId`、`lockVersion`（通过时带回）、`dueAt`、`decidedBy`、`isDecidedBySystem`、`decidedAt`、`decisionNote`、`reasons`（`[{ code, name }]`，字典 `reject_reason`）等；仅取消详情由`CancelRequestDetailSchema`沿`ApprovalDecisionViewSchema`派生，`actions`按`CancelActionsSchema`使用本领域五动作，与本结构的`actions`相同，不改变公共审批列表动作 | `approval_request`（来源同 a01 `ApprovalItem`） |
| `confirmChecks` | array<`ConfirmCheck`> | 是 | 审批通过时勾选的核对项（`ApprovalDecisionView` 不含此项，单列）；没有为 `[]` | `approval_request.confirm_checks` |
| `execution` | object \| null | 是 | 执行：`{ executedBy: StaffBrief \| null, isExecutedBySystem, executedAt, execConfirmChecks }`；未执行为空 | `cancel_request.executed_by_staff_id`、`is_executed_by_system`、`executed_at`、`exec_confirm_checks` |
| `closeNote` | string \| null | 是 | 作废说明 | `cancel_request.close_note` |
| `recheckLog` | object | 是 | 最近一次重新校验：`{ approve, execute }`，各为 `{ at, ok, diffs: [{ lineId, field, expected, actual }] }` 或空（待执行队列展示与排查） | `cancel_request.recheck_log`（`09-order-ad.md` 4.6） |
| `order` | object \| null | 是 | 订购取消时：`{ orderId, orderNo, status, subStatus, planName, discountBp }`（“专业版 9 折”） | `drama_order.*`；`plan.name` |
| `ad` | object \| null | 是 | 广告取消时：`{ adId, adNo, type, durationSec, status, planName, discountBp }` | `ad.*`；`ad.pricing_snapshot.planId` → `plan.name` |
| `serviceTickets` | array<{ `serviceTicketId`, `ticketNo`, `status` }> | 是 | 关联的客服工单 | `service_ticket_ref`（`ref_type = approval_request`、`ref_id` = 审批单 id）联 `service_ticket.ticket_no`、`status` |
| `timeline` | array<{ `at`, `action`: enum(`submitted`,`approved`,`rejected`,`withdrawn`,`voided`,`executed`), `actorName`: string \| null, `note`: string \| null }> | 是 | 处理记录 | `approval_request.submitted_at`、`decided_at`、`decision_note`；`cancel_request.updated_at`（作废）、`close_note`、`executed_at`；`staff.name` |
| `lockVersion` | integer | 是 | 取消申请行的锁版本（只读；作废与执行的守卫未列锁版本，不带回） | `cancel_request.lock_version` |
| `actions` | array<string> | 是 | `approve`、`reject`（`pending_approval`，有 `finance.refund.approve`，调用者不是发起人）；`withdraw`（`pending_approval`，调用者是发起人；或发起人已不是启用状态、或对象已失效（3.13），且调用者有 `finance.refund.approve`）；`void`（`pending_execution`，调用者是发起人）；`execute`（`pending_execution`，有 `finance.refund.execute`）。按钮显示不看再验证窗口，通过、执行、代撤点后由接口返回 `STEP_UP_REQUIRED` 弹出再验证（驳回不检查，C86） | 计算 |

#### `CancelRequestSummary`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `tabs` | object | 是 | `{ pending_approval, pending_execution, processed }`：待审批、待执行、已处理（`done` 与 `not_executed`） | `cancel_request.status` 计数 |
| `monthReturnedPoints` | integer(积分) | 是 | 本月（北京时间）已执行的实际退回积分（回到原批次 ＋ 转加购） | `status = done` 且 `executed_at` 在本月的明细 `returned_points + converted_points` 之和 |
| `monthDoneCount` | integer | 是 | 本月已执行笔数 | 同上计数 |
| `inProgressCount` | integer | 是 | 审批与执行中（待审批 ＋ 待执行） | 计数 |
| `monthRejectedCount` | integer | 是 | 本月驳回笔数 | `close_reason = rejected` 且 `closed_at` 在本月 |
| `overdueCount` | integer | 是 | 超时的待审批与待执行 | 计算 |

### 2.4 交付工单

#### `DeliveryTicketCard`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `deliveryTicketId` | string(uuid) | 是 | 工单 | `delivery_ticket.id` |
| `ticketNo` | string | 是 | 工单号 `JF…-1` | `delivery_ticket.ticket_no` |
| `step` | enum(见 4.3 `TicketStep`) | 是 | 步骤（`in_service` 对外显示“使用中”） | `delivery_ticket.step` |
| `stepEnteredAt` | string(date-time) | 是 | 进入当前步骤的时间 | `delivery_ticket.step_entered_at` |
| `stepDueAt` | string(date-time) \| null | 是 | 当前环节的员工侧截止时间 | `delivery_ticket.step_due_at` |
| `waitingOn` | enum(`staff`,`merchant`,`none`) | 是 | 等待方（“等待商家”） | `delivery_ticket.waiting_on` |
| `urgency` | enum(`normal`,`due_today`,`overdue`) | 是 | 紧急程度（行底色）：`stepDueAt` 已过、或在待上线与上线核验且约定上线日早于今天为 `overdue`；截止或约定上线日在今天为 `due_today` | 计算（北京时间） |
| `isPaused` | boolean | 是 | 暂停中 | `delivery_ticket.pause_count > 0` |
| `pauseReasons` | array<enum(`cancel_review`,`plan_amendment`)> | 是 | 未解除的暂停原因 | `delivery_ticket_pause.reason`（`released_at` 为空） |
| `isStuck` | boolean | 是 | 被补偿扫描判为“条件已满足仍停在原步骤”且未处理 | 存在 `invariant_violation`（`code = flow.STUCK_TICKET`、`subject_type = delivery_ticket`、`subject_id` = 本单、`resolved_at` 为空） |
| `store` | `AdminStoreBrief` | 是 | 商家 | `delivery_ticket.store_id` |
| `order` | object | 是 | `{ orderId, orderNo }` | `delivery_ticket.drama_order_id` → `drama_order.order_no` |
| `orderItemId` | string(uuid) | 是 | 订单项 | `delivery_ticket.order_item_id` |
| `dramaTitle` | string | 是 | 剧名 | `order_item.drama_snapshot.title` |
| `episodeCount` | integer | 是 | 集数 | `order_item.episode_count` |
| `productionModel` | enum(`standard`,`advanced`,`top`) | 是 | 制作模型 | `order_item.production_model` |
| `platforms` | array<enum(`douyin`,`wechat_channels`)> | 是 | 发布账号平台 | `order_item_account.platform` |
| `agreedLaunchDate` | string(date) \| null | 是 | 约定上线日；空显示“待确认” | `order_item.agreed_launch_date` |
| `usageEndDate` | string(date) | 是 | 使用期止日（使用中显示“使用期至 …”） | `order_item.usage_end_date` |
| `schedulePriority` | enum(`standard`,`priority`,`rush`) | 是 | 制作排期 | `delivery_ticket.schedule_priority` |
| `deliveryManager` | `StaffBrief` \| null | 是 | 交付经理；空显示“未分配” | `delivery_ticket.delivery_manager_id` |
| `editor` | `StaffBrief` \| null | 是 | 剪辑师 | `delivery_ticket.editor_id` |
| `publisher` | `StaffBrief` \| null | 是 | 发布专员 | `delivery_ticket.publisher_id` |
| `deliveryTargetAt` | string(date-time) | 是 | 成片交付目标 | `delivery_ticket.delivery_target_at` |
| `deliveredAt` | string(date-time) \| null | 是 | 成片包首次推送（“今日已交付”） | `delivery_ticket.delivered_at` |
| `createdAt` | string(date-time) | 是 | 生成时间（开工） | `delivery_ticket.created_at` |
| `actions` | array<string> | 是 | 列表行只给 `assign-manager`（待分配，调用者有 `merchant.manager.assign` 且是主管） | 计算 |

#### `TicketStageView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `step` | enum(`TicketStep` 的前 11 个) | 是 | 环节 | `delivery_ticket_stage.step` |
| `visitNo` | integer | 是 | 第几次进入 | `delivery_ticket_stage.visit_no` |
| `enteredAt` | string(date-time) | 是 | 进入时间 | `delivery_ticket_stage.entered_at` |
| `dueAt` | string(date-time) \| null | 是 | 员工侧截止 | `delivery_ticket_stage.due_at` |
| `completedAt` | string(date-time) \| null | 是 | 完成时间（进度条每步的时间） | `delivery_ticket_stage.completed_at` |
| `exitEvent` | string \| null | 是 | 离开事件 | `delivery_ticket_stage.exit_event` |
| `pausedMinutes` | integer | 是 | 暂停的工作分钟 | `delivery_ticket_stage.paused_minutes` |
| `isBreached` | boolean | 是 | 是否超时 | `delivery_ticket_stage.is_breached` |

#### `DeliveryTicketDetail`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| （`DeliveryTicketCard` 的全部字段，`actions` 见下） | — | 是 | 同上 | 同上 |
| `pauses` | array<{ `reason`, `refType`, `refId`, `actorType`, `createdAt` }> | 是 | 未解除的暂停原因明细（取消审批中引用审批单；方案修订引用方案版本） | `delivery_ticket_pause.reason`、`ref_type`、`ref_id`、`actor_type`、`created_at`（`released_at` 为空） |
| `pausedAt` | string(date-time) \| null | 是 | 开始暂停 | `delivery_ticket.paused_at` |
| `pauseRemainingMin` | integer \| null | 是 | 暂停时环节剩余工作分钟 | `delivery_ticket.pause_remaining_min` |
| `sampleRoundNo` | integer | 是 | 样片返修轮次 | `delivery_ticket.sample_round_no` |
| `currentSampleVersionNo` | integer \| null | 是 | 最近推送的样片版本号 | `delivery_ticket.current_sample_version_no` |
| `milestones` | object | 是 | `{ assignedAt, planConfirmedAt, adsReadyAt, sampleFirstPushedAt, sampleConfirmedAt, composedAt, deliveredAt, linksSubmittedAt, liveAt, usageEndedAt, archivedAt, terminatedAt }` | `delivery_ticket` 同名列 |
| `stages` | array<`TicketStageView`> | 是 | 环节记录（11 步进度条） | `delivery_ticket_stage` |
| `lockVersion` | integer | 是 | 工单锁版本（只读） | `delivery_ticket.lock_version` |
| `orderItem` | `AdminOrderItemRow` | 是 | 本工单的订单项（`ticket` 字段为空） | 2.2 |
| `order` | object | 是 | 侧栏“订购单”：`{ orderId, orderNo, submittedAt, totalChargePoints, itemCount, status, siblings: [{ deliveryTicketId, ticketNo, dramaTitle, step }] }`（“2 部共扣 4,500 积分”与同单工单） | `drama_order.*`；同 `drama_order_id` 的其他 `delivery_ticket` |
| `merchant` | object | 是 | 侧栏“商家”：`{ store: AdminStoreBrief, province: DictRef \| null, industry: DictRef \| null, category: DictRef \| null, contactName, contactPhoneMask, isWecomAdded }`（单值字典按 C85、A151；区县取其中 `store` 的 `district` 字段） | `store_profile.province_code`（字典 `region`）、`industry_code`、`category_code`（字典 `industry`）、`contact_name`、`contact_phone_mask`；`isWecomAdded` = 该门店老板（`entity_member.role = owner`）与本单交付经理之间存在 `wecom_contact`（`removed_at` 为空） |
| `plan` | object \| null | 是 | 交付方案区：`{ deliveryPlanId, status, currentVersionNo, confirmedVersionNo, pushedAt, pushedBy: StaffBrief \| null, confirmedAt, item: PlanItemContentView \| null }`；`item` 取已确认版本（无则当前版本）里本订单项的行；约定上线日以 `item.currentAgreedLaunchDate`（订单项现值）为准，改期不出方案版本，快照里的 `agreedLaunchDate` 可能已过时；开工前不存在 | `delivery_plan`；`delivery_plan_version.pushed_by_staff_id`、`content_snapshot`；`order_item.agreed_launch_date` |
| `ads` | array<object> | 是 | 广告视频区：`{ slot, adId, adNo, type, durationSec, copy, status, confirmedVersionNo, confirmedAt, boundVersionNo, freeRevisionsLeft, inUseItemCount, sameOrderItemCount, sameOrderTickets, dueAt }`（“剩余免费修改次数”“使用中：5 部剧（含本单 2 部）”“同单《二次开业》共用上述两条广告”）；`sameOrderTickets` 为 `array<{ deliveryTicketId, ticketNo, dramaTitle }>`，不含本工单 | `order_item_placement` 联 `ad.*`；`freeRevisionsLeft = max(0, ad.free_revision_quota − ad.revision_count)`；`inUseItemCount` = 绑定该广告、阶段不在 `cancelled`、`refunded`、`terminated`、`ended` 的订单项数；`sameOrderItemCount` = 其中属本订购单的数；`sameOrderTickets` = 本订购单其他绑定该广告的订单项的工单 |
| `currentSample` | `AdminSampleView` \| null | 是 | 当前样片（“活着”的版本，没有则最近一个版本） | `sample`（`uq_sample_live` 覆盖的行，或 `version_no` 最大） |
| `samples` | array<{ `sampleId`, `versionNo`, `status`, `uploadedAt`, `pushedAt` }> | 是 | 样片版本历史，按版本号倒序 | `sample` |
| `episodeProgress` | object | 是 | 成片区：`{ totalEpisodes, currentPassedCount, uploadedCount, rejectedCount, packageQc: QcRecordView \| null }`（“成片包 80 集 · 待批量合成”） | `order_item.episode_count`；`episode_output` 按 `is_current`、`status` 计数；`qc_record`（`target_type = delivery_ticket`）最近一条 |
| `release` | object \| null | 是 | 生效中的成片包：`{ deliveryReleaseId, releaseNo, kind, pushedAt, episodeCount, totalBytes, savedEpisodeCount, grantExpiresAt }`；`totalBytes` 为 string(bigint) | `delivery_release`（`state = pushed`）；`delivery_download_log`（`client_ack = saved`）不同集数；`download_grant.expires_at`（`state = active`） |
| `openReissue` | (`ReissueView` & { `deliveryReissueId`: uuid }) \| null | 是 | 在途补发单；`deliveryReissueId` 保留旧读侧字段，与标准 `reissueId` 相同 | `delivery_reissue`（`status = open`） |
| `openUploadBatches` | array<{ `uploadBatchId`, `state`, `scope`, `expectedCount`, `createdBy`: StaffBrief, `expiresAt` }> | 是 | 本订单项在途的成片批次（刷新页面后找回批次续传；做法同 a04 `MediaReadiness.openUploadBatches`） | `upload_batch`（`purpose = final_release`、`target_id` = 本订单项、`state` ∈ {`matching`,`uploading`,`verifying`,`ready`}，`ix_upload_batch_purpose_target_id`） |
| `publishList` | object \| null | 是 | 发布清单（详情在 a06 `admin.deliveryTicket.publishList.get`）：`{ publishListId, savedAt, isComplete }`；进入成片交付前为空 | `publish_list`（`uq_publish_list_delivery_ticket_id`）；`isComplete` 由 publish 模块的完整性判定给出（与 3.33 守卫的 `publish_list_incomplete` 同一函数） |
| `launch` | object | 是 | 上线任务：`{ taskCount, liveCount, verifyingCount, needFixCount, pendingCount, tasks }`；`tasks` 为 `array<{ launchTaskId, channelAccountId, platform, accountName, reviewStatus, isLive, currentRoundNo, currentLaunchSubmissionId }>`，供跳转 a06 的核验详情；`currentLaunchSubmissionId` 在 `currentRoundNo = 0` 时为空 | `launch_task` 按 `is_live`、`review_status` 计数（`void_reason` 为空）；`tasks` 取未作废的行联 `channel_account.account_name`；`currentLaunchSubmissionId` = `launch_submission`（`launch_task_id`、`round_no = current_round_no`，`uq_launch_submission_launch_task_id_round_no`） |
| `remindScenes` | array<enum(`confirm_plan`,`confirm_sample`,`golive`)> | 是 | 此刻可催办且今天未催办的场景（行内按钮点后变“已提醒”） | 3.23 的守卫；`manual_reminder_log` 当日行 |
| `actions` | array<string> | 是 | `assign-manager`；`assign-editor`；`assign-publisher`；`remind`（`remindScenes` 非空）；`rework`（批量合成或成片交付、未交付、未暂停、主管）；`reissue`（待上线、上线核验、使用中，使用期内、未暂停、无在途补发）；`push-package`（成片交付）；`reevaluate`（`flow.ops.manage`，暂停或终态时只返回跳过原因）；`force-transition`（`flow.admin.transition`，未暂停且有当前步骤的纠偏白名单目标）。各动作同时按实际路由模块等级与权限投影，不用编辑等级替代发布主管的查看等级指派权限 | 计算 |

#### `PlanItemContentView`

方案内容里一个订单项的行（工单详情与方案页共用）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderItemId` | string(uuid) | 是 | 订单项 | `PlanContent.items[].orderItemId` |
| `dramaTitle` | string | 是 | 剧名 | `order_item.drama_snapshot.title` |
| `episodeCount` | integer | 是 | 集数 | `order_item.episode_count` |
| `allowedPlacements` | array<enum(`opening`,`ending`)> | 是 | 该剧允许的植入形式 | `order_item.drama_snapshot.allowedPlacements` |
| `accounts` | array<{ `channelAccountId`, `platform`, `accountName`, `accountUid`, `status` }> | 是 | 上线账号（“已核验”即 `available`） | `PlanContent.items[].accounts` 联 `channel_account` |
| `placements` | array<{ `slot`, `adId`, `adNo`, `durationSec`, `adStatus`, `confirmedVersionNo`, `copy` }> | 是 | 植入形式与所用广告及文案 | `PlanContent.items[].placements` 联 `ad.ad_no`、`ad.status`、`ad.confirmed_version_no`、`ad.copy` |
| `agreedLaunchDate` | string(date) \| null | 是 | 该版本内容里的约定上线日（草稿可为空） | `PlanContent.items[].agreedLaunchDate` |
| `currentAgreedLaunchDate` | string(date) \| null | 是 | 订单项当前的约定上线日（改期后与快照不同，页面以它为准） | `order_item.agreed_launch_date` |
| `expectedDeliveryDate` | string(date) \| null | 是 | 成片交付预计日 | `PlanContent.items[].expectedDeliveryDate` |

### 2.5 方案

#### `AdminPlanContentView`

后台的方案内容（与 m05 的商家端 `PlanContentView` 字段不同，另起名字）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `focus` | array<`DictRef`> | 是 | 定制重点 | `PlanContent.focusTags` + 字典 `custom_focus` |
| `referenceAssets` | array<{ `storeAssetId`, `type`, `title` }> | 是 | 参考素材（素材库）。方案内容只含素材库素材：`PlanContent.referenceAssetIds` 是 `store_asset.id`（10-delivery.md:1271）；订购时引用的档案媒体不进方案内容，仍登记在订购单上（见 `AdminOrderDetail.referenceFiles`） | `PlanContent.referenceAssetIds` 联 `store_asset` |
| `note` | string \| null | 是 | 补充说明 | `PlanContent.note` |
| `launchMode` | enum(`merchant_self`) | 是 | 上线方式（商家自助发布） | `PlanContent.launchMode` |
| `items` | array<`PlanItemContentView`> | 是 | 逐剧的行 | `PlanContent.items` |

#### `PlanContentInput`（请求体）

草稿保存用；服务端补齐 `platform`（取账号平台）与 `durationSec`（取广告时长）后落 `delivery_plan.draft`（`PlanContent`，`10-delivery.md` 第 4 节）。

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `focusCodes` | array<string> | 是 | ≥ 1 项，字典 `custom_focus` 的启用编码 | 落 `focusTags` |
| `referenceAssetIds` | array<string(uuid)> | 是 | 可为空数组；素材库素材（`store_asset.id`），属本门店、未删除、未拦截、`usability ≠ need_reshoot`；档案媒体不在此列 | 落 `referenceAssetIds`。方案确认时同步订购单上的引用（10-delivery.md:423），只增删素材库来源的行，订购时登记的档案媒体行不动 |
| `note` | string \| null | 否 | ≤ 200 字 | 补充说明 |
| `launchMode` | enum(`merchant_self`) | 是 | V1.0 只此一值 | 上线方式 |
| `items` | array<object> | 是 | 每个未取消的订单项一行，`orderItemId` 不重复 | 见下 |
| `items[].orderItemId` | string(uuid) | 是 | 属本订购单 | 订单项 |
| `items[].channelAccountIds` | array<string(uuid)> | 是 | 每平台至多 1 个 | 发布账号 |
| `items[].placements` | array<{ `slot`: enum(`opening`,`ending`), `adId`: string(uuid) }> | 是 | `slot` 不重复 | 植入形式与广告 |
| `items[].agreedLaunchDate` | string(date) \| null | 否 | — | 约定上线日（草稿可不填，推送时必填） |
| `items[].expectedDeliveryDate` | string(date) \| null | 否 | — | 成片交付预计日 |

草稿只做结构校验（`VALIDATION_FAILED`）；业务校验（账号状态、广告归属、日期范围、工单已离开待分配）在推送时做（3.36）。

#### `AdminDeliveryPlanDetail`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `deliveryPlanId` | string(uuid) | 是 | 方案 | `delivery_plan.id` |
| `orderId` | string(uuid) | 是 | 订购单 | `delivery_plan.drama_order_id` |
| `orderNo` | string | 是 | 订单号 | `drama_order.order_no` |
| `store` | `AdminStoreBrief` | 是 | 商家 | `delivery_plan.store_id` |
| `status` | enum(`drafting`,`pending_confirm`,`revising`,`confirmed`) | 是 | 方案状态 | `delivery_plan.status` |
| `draft` | `AdminPlanContentView` | 是 | 正在编辑的草稿 | `delivery_plan.draft` |
| `draftLockVersion` | integer | 是 | 草稿锁版本；保存与推送都带回 | `delivery_plan.draft_lock_version` |
| `currentVersionNo` | integer | 是 | 最近推送的版本号；0 = 未推送 | `delivery_plan.current_version_no` |
| `confirmedVersionNo` | integer \| null | 是 | 已确认的最新版本 | `delivery_plan.confirmed_version_no` |
| `pushedAt` | string(date-time) \| null | 是 | 最近推送时间 | `delivery_plan.pushed_at` |
| `confirmedAt` | string(date-time) \| null | 是 | 最近确认时间 | `delivery_plan.confirmed_at` |
| `staffDueAt` | string(date-time) \| null | 是 | 应推送或应答复修改的时间 | `delivery_plan.staff_due_at` |
| `isOrderInAfterSale` | boolean | 是 | 订购单有在途取消，推送不可用 | `drama_order.open_cancel_request_id` 非空 |
| `versions` | array<object> | 是 | 版本历史（倒序）：`{ versionNo, pushedAt, pushedBy: StaffBrief, changeSummary, decision, decidedAt, decideActorType, content: AdminPlanContentView }` | `delivery_plan_version.version_no`、`pushed_at`、`pushed_by_staff_id`、`change_summary`、`decision`、`decided_at`、`decide_actor_type`、`content_snapshot` |
| `changeRequests` | array<object> | 是 | 商家修改请求：`{ changeRequestId, onVersionNo, kinds, note, createdAt, createdByName, resolvedByVersionNo }` | `delivery_plan_change_request.*`；`createdByName` = 提出人在主体内的称呼 `entity_member.display_name`（空时取 `merchant_user.display_name`） |
| `itemWindows` | array<{ `orderItemId`, `step`, `canChangeContent`, `canChangeAccounts`, `canReschedule` }> | 是 | 确认后的变更窗口（`d3-flow.md:1167-1172`）：内容（定制、植入、广告）到样片确认为止；账号到成片包推送前；上线日到首个账号核验通过前（走改期） | 各订单项工单的 `step`、`delivered_at`；`order_item.usage_start_date` |
| `lockVersion` | integer | 是 | 方案行锁版本（只读） | `delivery_plan.lock_version` |
| `actions` | array<string> | 是 | `push`（有 `delivery.plan.push`，订购单不在售后中，且非 `confirmed` 或仍在变更窗口内） | 计算 |

### 2.6 样片与质检

#### `QcRecordView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `qcRecordId` | string(uuid) | 是 | 质检记录 | `qc_record.id` |
| `targetType` | enum(`sample`,`episode_output`,`delivery_ticket`) | 是 | 对象：样片、单集、成片包级 | `qc_record.target_type` |
| `targetId` | string(uuid) | 是 | 对象 id | `qc_record.target_id` |
| `checklistCode` | enum(`qc.sample`,`qc.episode`,`qc.package`) | 是 | 清单编码 | `qc_record.checklist_code` |
| `checklistVersionNo` | integer | 是 | 清单版本 | `qc_record.checklist_version_no` |
| `verdict` | enum(`pass`,`fail`) | 是 | 结论 | `qc_record.verdict` |
| `rejectReason` | string \| null | 是 | 不通过原因 | `qc_record.reject_reason` |
| `items` | array<`AdminChecklistItemView`> | 是 | 逐项结论 | `qc_record.results` |
| `inspectedBy` | `StaffBrief` | 是 | 质检人 | `qc_record.inspected_by_staff_id` |
| `inspectedAt` | string(date-time) | 是 | 质检时间 | `qc_record.inspected_at` |

#### `ProductionFactsBrief`

制作文件的入库与体检摘要（样片、成片、广告版本共用）；完整事实走 `admin.productionRecord.list`。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `pipelineState` | enum(`uploading`,`checking`,`ready`,`rejected`) | 是 | 入库流水线进度；`ready` 才可质检 | `production_record.pipeline_state` |
| `gate` | enum(`pass`,`reject`) \| null | 是 | 体检门禁结论 | `media_check.gate` |
| `softWarnCount` | integer | 是 | 预警项数 | `media_check.soft` 的条数 |
| `aigcState` | enum(`not_required`,`pending`,`verified`,`failed`) | 是 | AI 隐式标识状态（质检清单“AI 隐式标识”一项据此自动判定） | `production_record.aigc_state` |

#### `AdminSampleView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `sampleId` | string(uuid) | 是 | 样片版本 | `sample.id` |
| `deliveryTicketId` | string(uuid) | 是 | 工单 | `sample.delivery_ticket_id` |
| `versionNo` | integer | 是 | 版本号（“版本 1”） | `sample.version_no` |
| `status` | enum(见 4.4 `SampleStatus`) | 是 | 状态 | `sample.status` |
| `fileId` | string(uuid) | 是 | 样片原版文件（下载走 `admin.file.downloadUrls`） | `sample.file_id` |
| `durationMs` | integer \| null | 是 | 时长；体检通过前为空 | `sample.duration_ms` |
| `adSlots` | array<{ `slot`, `startMs`, `endMs`, `label` }> | 是 | 植入位置（“片头 00:00～00:05 · 片尾 01:55～02:05”） | `sample.ad_slots` |
| `adsUsed` | array<{ `slot`, `adId`, `adNo`, `versionNo`, `isCurrentConfirmed` }> | 是 | 所用广告版本；`isCurrentConfirmed` 为假时推送会被拒（`AD_CHANGED`） | `sample.ad_versions_used`；`ad.ad_no`、`ad.confirmed_version_no` |
| `uploadedBy` | `StaffBrief` | 是 | 制作（剪辑师） | `sample.uploaded_by_staff_id` |
| `uploadedAt` | string(date-time) | 是 | 上传时间 | `sample.uploaded_at` |
| `production` | `ProductionFactsBrief` \| null | 是 | 入库与体检 | `production_record`（`file_id = sample.file_id`）；`media_check` |
| `qc` | `QcRecordView` \| null | 是 | 最近一次质检 | `sample.qc_record_id` |
| `pushedBy` | `StaffBrief` \| null | 是 | 推送人 | `sample.pushed_by_staff_id` |
| `pushedAt` | string(date-time) \| null | 是 | 推送时间 | `sample.pushed_at` |
| `previewChannels` | array<enum(见 4.4 `PreviewChannel`)> | 是 | 推送时确定的查看方式 | `sample.preview_channels` |
| `offlineSentAt` | string(date-time) \| null | 是 | 已经企业微信发送水印版的时间 | `sample.offline_sent_at` |
| `offlineSentBy` | `StaffBrief` \| null | 是 | 点“已发送”的员工 | `sample.offline_sent_by_staff_id` |
| `firstViewedAt` | string(date-time) \| null | 是 | 商家首次经相册保存或下载页预览访问 | `sample.first_viewed_at` |
| `viewedAckAt` | string(date-time) \| null | 是 | 商家勾选“我已查看” | `sample.viewed_ack_at` |
| `decision` | object \| null | 是 | 决定：`{ decidedAt, decideClient, decidedByName, onBehalfBy: StaffBrief \| null, viewedVia, feedbackKind, feedbackNote, feedbackTimeMs, feedbackImages: array<ImageRef> \| null }`（`ImageRef` 归 m08，C87；图片数组只在结果脱敏的重放里为 `null`，平时没有图片为 `[]`）；`viewedVia` 与 m05、x01 同名 | `sample.decided_at`、`decide_client`、`decided_by_user_id`（称呼取 `entity_member.display_name`）、`on_behalf_staff_id`、`confirm_viewed_via`、`feedback_kind`、`feedback_note`、`feedback_time_ms`、`feedback_file_ids`（现签 30 分钟） |
| `confirmDueRemindAt` | string(date-time) \| null | 是 | 推送后自动提醒商家的时刻（推送 + 2 个自然日，“样片确认截止”一栏） | `pushed_at` + 2 天（纯提醒，不建定时器行，R6） |
| `watermark` | object \| null | 是 | 明水印版：`{ playableAssetId, state, fileId }`；`fileId` 在 `state = ready` 时才有，交给 `admin.file.downloadUrls`（a01，留痕）下载后经企业微信发送；体检通过前或未生成为空 | `playable_asset`（`kind = sample`、`owner_type = order_item`、`owner_id` = 本单订单项、`source_file_id = sample.file_id`）的 `id`、`state`、`renditions[0].fileId`（06-media.md 4.9；10-delivery.md:1313） |
| `preview` | object \| null | 是 | 后台预览：`{ url, expiresAt, posterUrl }`；指向原版文件，60 分钟，不留痕；结果脱敏的重放里为空（1.1） | `sample.file_id` 现签；`media_info.cover_file_id` |
| `actions` | array<string> | 是 | `inspect`（`uploaded`、`production.pipelineState = ready`、调用者不是上传人）；`mark-sent`（`qc_passed` 或 `pushed` 且未登记）；`push`（`qc_passed` 且工单在样片制作）；`recover_legacy`（当前无 weapp 的未决历史版本，工单在样片确认，具备推送/质检权限及可用源质检、水印与当前广告）；`request-change`（`pushed`） | 计算 |

### 2.7 成片、成片包与补发

#### `EpisodeOutputView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `episodeOutputId` | string(uuid) | 是 | 剧集版本行 | `episode_output.id` |
| `episodeNo` | integer | 是 | 集号 | `episode_output.episode_no` |
| `variant` | enum(`common`,`douyin`,`wechat_channels`) | 是 | 平台变体（V1.0 只有 `common`） | `episode_output.variant` |
| `revisionNo` | integer | 是 | 修订号 | `episode_output.revision_no` |
| `fileId` | string(uuid) | 是 | 成片文件 | `episode_output.file_id` |
| `fileName` | string \| null | 是 | 原始文件名 | `file_object.original_name` |
| `sizeBytes` | string(bigint) | 是 | 文件大小 | `episode_output.size_bytes` |
| `durationMs` | integer \| null | 是 | 时长 | `episode_output.duration_ms` |
| `source` | enum(`manual_upload`,`normalized`,`sample_adopted`,`restamped`,`auto_compose`) | 是 | 来源（`normalized` 为云端规格化产物，A142） | `episode_output.source` |
| `status` | enum(见 4.4 `EpisodeStatus`) | 是 | 版本状态 | `episode_output.status` |
| `isCurrent` | boolean | 是 | 是否当前版本 | `episode_output.is_current` |
| `deliveryReissueId` | string(uuid) \| null | 是 | 所属补发单（替换行） | `episode_output.delivery_reissue_id` |
| `production` | `ProductionFactsBrief` \| null | 是 | 入库与体检 | `production_record`（`file_id`）；`media_check` |
| `qc` | object \| null | 是 | 最近质检 `{ qcRecordId, verdict, rejectReason, inspectedAt, inspectedBy: StaffBrief }` | `episode_output.qc_record_id` → `qc_record` |
| `uploadedBy` | `StaffBrief` | 是 | 上传人 | `episode_output.uploaded_by_staff_id` |
| `uploadedAt` | string(date-time) | 是 | 上传时间 | `episode_output.uploaded_at` |

#### `EpisodeGrid`

`admin.deliveryTicket.episodeOutput.list` 的响应（成片包格子）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `totalEpisodes` | integer | 是 | 订购集数 | `order_item.episode_count` |
| `currentPassedCount` | integer | 是 | 当前版本且质检通过的集数（“质检通过 45/45”） | `episode_output`（`is_current`、`status = qc_passed`）计数 |
| `currentTotalBytes` | string(bigint) | 是 | 当前版本合计大小（“3.1 GB”） | Σ`episode_output.size_bytes`（`is_current`） |
| `episodes` | array<object> | 是 | 1..N 逐集：`{ episodeNo, current: EpisodeOutputView \| null, latest: EpisodeOutputView \| null, replacement: EpisodeOutputView \| null }`；`latest` 为该集最新修订（可能待质检或不通过），`replacement` 为在途补发单下的替换行 | `episode_output` |
| `packageQc` | `QcRecordView` \| null | 是 | 最近一次成片包级质检 | `qc_record`（`target_type = delivery_ticket`，`ix_qc_record_delivery_ticket_id_target_type`） |
| `fileNamePattern` | string | 是 | 推送时的文件命名（“夜巷疑云_第01集.mp4”） | `剧名_第NN集.mp4`（`d5-media.md:1568`） |

#### `ReleaseAdminView`

本文为归属文档（C87）；a06 的 `DeliveryReleaseDetail` 由它扩展，名字与形状保持稳定。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `deliveryReleaseId` | string(uuid) | 是 | 成片包 | `delivery_release.id` |
| `releaseNo` | integer | 是 | 推送序号 | `delivery_release.release_no` |
| `kind` | enum(`initial`,`reissue`) | 是 | 首次推送、补发 | `delivery_release.kind` |
| `state` | enum(`pushed`,`superseded`,`closed`) | 是 | 生效中、已被取代、已关闭 | `delivery_release.state` |
| `variant` | enum(`common`,`douyin`,`wechat_channels`) | 是 | 平台变体 | `delivery_release.variant` |
| `episodeCount` | integer | 是 | 集数 | `delivery_release.episode_count` |
| `totalBytes` | string(bigint) | 是 | 总大小 | `delivery_release.total_bytes` |
| `changedEpisodeNos` | array<integer> | 是 | 相对上一包变更的集 | `delivery_release.changed_episode_nos` |
| `precheck` | array<`AdminChecklistItemView`> | 是 | 交付前检查结论 | `delivery_release.precheck_results`（`checklist_code = delivery.precheck`、`checklist_version_no`） |
| `reason` | `DictRef` \| null | 是 | 补发原因（C85、A151；首次推送为 `null`） | `delivery_release.reason_code` + 字典 `reissue_reason` |
| `note` | string \| null | 是 | 推送或补发说明 | `delivery_release.note` |
| `pushedBy` | `StaffBrief` | 是 | 推送人 | `delivery_release.pushed_by_staff_id` |
| `pushedAt` | string(date-time) | 是 | 推送时间 | `delivery_release.pushed_at` |
| `supersededAt` | string(date-time) \| null | 是 | 被取代时间 | `delivery_release.superseded_at` |
| `closedAt` | string(date-time) \| null | 是 | 关闭时间 | `delivery_release.closed_at` |
| `closeReason` | enum(`cancelled`,`usage_ended`) \| null | 是 | 关闭原因 | `delivery_release.close_reason` |
| `savedEpisodeCount` | integer | 是 | 商家已存相册的集数（“已保存 45 / 80”） | `delivery_download_log`（本包、`client_ack = saved`）不同 `episode_no` 计数 |

#### `ReissueView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `reissueId` | string(uuid) | 是 | 补发单 | `delivery_reissue.id` |
| `deliveryTicketId` | string(uuid) | 是 | 工单 | `delivery_reissue.delivery_ticket_id` |
| `status` | enum(`open`,`published`,`cancelled`) | 是 | 在途、已发布、已取消 | `delivery_reissue.status` |
| `episodeNos` | array<integer> | 是 | 计划替换的集 | `delivery_reissue.episode_nos` |
| `reason` | `DictRef` | 是 | 补发原因（错别字、广告版本、AI 标识、画面问题、其他；C85、A151） | `delivery_reissue.reason_code` + 字典 `reissue_reason` |
| `note` | string | 是 | 补发说明 | `delivery_reissue.note` |
| `openedBy` | `StaffBrief` | 是 | 发起人 | `delivery_reissue.opened_by_staff_id` |
| `openedAt` | string(date-time) | 是 | 发起时间 | `delivery_reissue.opened_at` |
| `closedAt` | string(date-time) \| null | 是 | 发布或取消时间 | `delivery_reissue.closed_at` |
| `publishedDeliveryReleaseId` | string(uuid) \| null | 是 | 发布生成的成片包 | `delivery_reissue.published_delivery_release_id` |
| `replacements` | array<{ `episodeNo`, `episodeOutputId`, `status` }> | 是 | 已登记的替换行（每集取最新修订） | `episode_output`（`delivery_reissue_id` = 本单） |
| `actions` | array<string> | 是 | `publish`（`open`，有 `publish.package.push` 与发布编辑等级，未暂停且在合法补发步骤及使用期内，每集最新替换行都有真实通过质检与制作就绪，合并后当前集完整）；`cancel`（`open`，有 `delivery.package.reissue` 与交付编辑等级，调用者是发起人或主管）。写时仍重新核验 | 计算 |

### 2.8 授权书

#### `LicenseLetterRevisionView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `licenseLetterRevisionId` | string(uuid) | 是 | 版次 | `license_letter_revision.id` |
| `revNo` | integer | 是 | 第 N 版 | `license_letter_revision.rev_no` |
| `reason` | enum(`initial`,`go_live`,`period_changed`,`correction`,`resign`) | 是 | 出版原因 | `license_letter_revision.reason` |
| `renderStatus` | enum(`queued`,`rendering`,`ready`,`failed`) | 是 | 渲染状态 | `license_letter_revision.render_status` |
| `renderAttemptNo` | integer | 是 | 认领次数 | `license_letter_revision.render_attempt_no` |
| `fileId` | string(uuid) \| null | 是 | PDF 文件（`ready` 才有；下载走 `admin.file.downloadUrls`，5 分钟，逐次留痕） | `license_letter_revision.file_id` |
| `contentFp` | string | 是 | 内容指纹（页脚） | `license_letter_revision.content_fp` |
| `templateVersion` | string | 是 | 模板版本 | `license_letter_revision.template_version` |
| `signMode` | enum(`platform_cert`,`esign_seal`,`stamp`) \| null | 是 | 签署方式 | `license_letter_revision.sign_mode` |
| `platformSignedAt` | string(date-time) \| null | 是 | 平台签署时间 | `license_letter_revision.platform_signed_at` |
| `readyAt` | string(date-time) \| null | 是 | 出件时间 | `license_letter_revision.ready_at` |
| `createdAt` | string(date-time) | 是 | 入队时间 | `license_letter_revision.created_at` |
| `actions` | array<string> | 是 | `rerender`（`failed`，有 `order.license_letter.manage`） | 计算 |
| `renderIssue` | `LicenseRenderIssue` \| null | 是 | 本版次的缺字诊断，结构见下文 | 判权后按有效认领读取审计投影 |

`renderIssue` 为必有的 `LicenseRenderIssue | null`：最新有效失败认领的缺字诊断；
成功、再次认领、作废后为空。缺字项包含具体字符 `character`、`U+` 码点 `codePoint`、
固定字段路径 `fields`（最多4项）；`missing` 最多32个不同码点，
`totalMissingCodePoints` 是总数，`truncated` 标识超出部分。诊断不含整段主体资料，
服务重启后仍按同版次持久结果读取。类型结构以实际契约为准。

#### `AdminLicenseLetterView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `licenseLetterId` | string(uuid) | 是 | 授权书 | `license_letter.id` |
| `letterNo` | string | 是 | 编号 `SQ…-1-DY` | `license_letter.letter_no` |
| `orderItemId` | string(uuid) | 是 | 订单项 | `license_letter.order_item_id` |
| `channelAccountId` | string(uuid) | 是 | 被授权账号 | `license_letter.channel_account_id` |
| `platform` | enum(`douyin`,`wechat_channels`) | 是 | 平台 | `license_letter.platform` |
| `accountName` | string | 是 | 账号名称（当前值；文件里印的是出件时的快照） | `channel_account.account_name` |
| `status` | enum(`pending_effective`,`effective`,`voided`) | 是 | 状态 | `license_letter.status` |
| `isExpired` | boolean | 是 | 已失效（派生：生效中且止日早于今天） | `status = effective` 且 `period_end < 今天` |
| `periodStart` | string(date) \| null | 是 | 使用期起 | `license_letter.period_start` |
| `periodEnd` | string(date) | 是 | 使用期止 | `license_letter.period_end` |
| `voidReason` | enum(`cancelled`,`terminated`,`account_removed`,`manual`) \| null | 是 | 作废原因 | `license_letter.void_reason` |
| `voidedAt` | string(date-time) \| null | 是 | 作废时间 | `license_letter.voided_at` |
| `createdAt` | string(date-time) | 是 | 生成时间 | `license_letter.created_at` |
| `currentRevision` | `LicenseLetterRevisionView` \| null | 是 | 当前出件的版次；首版出件前为空 | `license_letter.current_revision_id` |
| `revisions` | array<`LicenseLetterRevisionView`> | 是 | 全部版次（倒序；含排队中、失败的） | `license_letter_revision` |
| `actions` | array<string> | 是 | `correct`、`void`（未作废，有 `order.license_letter.manage`） | 计算 |

### 2.9 广告任务

#### `AdTaskCard`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `adId` | string(uuid) | 是 | 广告 | `ad.id` |
| `adNo` | string | 是 | 任务编号 `GG…` | `ad.ad_no` |
| `store` | `AdminStoreBrief` | 是 | 商家 | `ad.store_id` |
| `planName` | string \| null | 是 | 套餐版本（“胖哥冒菜 · 专业版”） | `ad.pricing_snapshot.planId` → `plan.name` |
| `type` | enum(`opening`,`ending`,`corner`,`mid_roll`) | 是 | 类型（V1.0 只有前两个） | `ad.type` |
| `durationSec` | integer | 是 | 时长 | `ad.duration_sec` |
| `status` | enum(见 4.5 `AdStatus`) | 是 | 状态 | `ad.status` |
| `isWaitingQualification` | boolean | 是 | 待指派且门店资质未通过（“等待资质审核”） | `status = pending_assign` 且 `store.qualification_status ≠ verified`（`profile.storeGate ≠ full`） |
| `editor` | `StaffBrief` \| null | 是 | 剪辑师；空显示“待指派” | `ad.editor_id` |
| `chargePoints` | integer(积分) | 是 | 应扣积分 | `ad.charge_points` |
| `isCaptured` | boolean | 是 | 已扣（否则“已冻结”） | `ad.captured_at` 非空 |
| `submittedAt` | string(date-time) | 是 | 提交时间 | `ad.submitted_at` |
| `dueAt` | string(date-time) \| null | 是 | 当前应交付时间（截止）；待补充为空 | `ad.due_at` |
| `firstDueAt` | string(date-time) | 是 | 首版应交付时间 | `ad.first_due_at` |
| `isFirstBreached` | boolean | 是 | 首版已超时 | `ad.first_breached_at` 非空 |
| `urgency` | enum(`normal`,`due_today`,`overdue`) | 是 | 紧急程度（紧急的排前） | 按 `dueAt` 计算 |
| `latestVersionNo` | integer | 是 | 最新版本号 | `ad.latest_version_no` |
| `confirmedVersionNo` | integer \| null | 是 | 已确认版本号 | `ad.confirmed_version_no` |
| `revisionCount` | integer | 是 | 已修改次数 | `ad.revision_count` |
| `freeRevisionQuota` | integer | 是 | 免费修改次数 | `ad.free_revision_quota` |
| `openCancelRequest` | object \| null | 是 | 在途取消 `{ cancelRequestId, requestNo, status, totalRefundPoints }` | `ad.open_cancel_request_id` → `cancel_request`；`approval_request.request_no` |
| `linkedTicketNos` | array<string> | 是 | 关联工单号；空显示“暂未关联，可在后续订购中选用” | `order_item_placement`（`ad_id`）→ `delivery_ticket.ticket_no` |
| `actions` | array<string> | 是 | 见 `AdTaskDetail.actions` | 计算 |

#### `AdminAdVersionView`

后台的广告版本（比 m06 的商家端 `AdVersionView` 多出文件、上传人、制作留痕、预览与动作，另起名字）。广告视频不加水印（A97）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `adVersionId` | string(uuid) | 是 | 版本 | `ad_version.id` |
| `versionNo` | integer | 是 | 第 N 版 | `ad_version.version_no` |
| `fileId` | string(uuid) | 是 | 视频文件 | `ad_version.file_id` |
| `durationMs` | integer | 是 | 时长 | `ad_version.duration_ms` |
| `width` | integer | 是 | 宽 | `ad_version.width` |
| `height` | integer | 是 | 高 | `ad_version.height` |
| `segments` | array<{ `index`, `fromMs`, `toMs`, `label` }> | 是 | 分段（供修改意见选时间段）；未填为空数组 | `ad_version.segments` |
| `uploadedBy` | `StaffBrief` | 是 | 上传人 | `ad_version.uploaded_by_staff_id` |
| `uploadedAt` | string(date-time) | 是 | 上传时间 | `ad_version.uploaded_at` |
| `production` | `ProductionFactsBrief` \| null | 是 | 入库与体检 | `production_record`（`file_id`）；`media_check` |
| `pushedAt` | string(date-time) \| null | 是 | 推送时间 | `ad_version.pushed_at` |
| `previewChannels` | array<enum(`PreviewChannel`)> | 是 | 查看方式 | `ad_version.preview_channels` |
| `offlineSentAt` | string(date-time) \| null | 是 | 已经企业微信发送 | `ad_version.offline_sent_at` |
| `offlineSentBy` | `StaffBrief` \| null | 是 | 点“已发送”的员工 | `ad_version.offline_sent_by_staff_id` |
| `decision` | enum(`confirmed`,`revision_requested`,`superseded`) \| null | 是 | 商家决定 | `ad_version.decision` |
| `decidedAt` | string(date-time) \| null | 是 | 决定时间 | `ad_version.decided_at` |
| `viewedVia` | enum(`PreviewChannel`) \| null | 是 | 确认时声明的查看方式（与 m06、x01 同名） | `ad_version.confirm_viewed_via` |
| `viewedAckAt` | string(date-time) \| null | 是 | 勾选“我已查看” | `ad_version.viewed_ack_at` |
| `preview` | object \| null | 是 | 后台预览 `{ url, expiresAt, posterUrl }`（60 分钟，不留痕）；结果脱敏的重放里为空 | `ad_version.file_id` 现签；`media_info.cover_file_id` |
| `actions` | array<string> | 是 | `mark-sent`（未决、未登记，调用者有 `delivery.sample.push`，即交付经理）；`push`（最新且未推送、未决，调用者是本广告的剪辑师） | 计算 |

#### `AdminAdRevisionView`

后台的修改轮次（比 m06 的 `AdRevisionView` 多出 id、提出人、客户端、超时与满足版本，另起名字）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `adRevisionId` | string(uuid) | 是 | 修改轮次 | `ad_revision.id` |
| `revisionNo` | integer | 是 | 第几次修改 | `ad_revision.revision_no` |
| `onVersionNo` | integer | 是 | 针对的版本 | `ad_revision.on_version_no` |
| `source` | enum(`ad_page`,`sample_feedback`,`staff_on_behalf`) | 是 | 来源 | `ad_revision.source` |
| `isChargeable` | boolean | 是 | 是否计费 | `ad_revision.is_chargeable` |
| `chargePoints` | integer(积分) | 是 | 超次扣减积分 | `ad_revision.charge_points` |
| `note` | string | 是 | 修改意见 | `ad_revision.note` |
| `segmentIndex` | integer \| null | 是 | 所选分段 | `ad_revision.segment_index` |
| `timeStartMs` | integer \| null | 是 | 时间段起 | `ad_revision.time_start_ms` |
| `timeEndMs` | integer \| null | 是 | 时间段止 | `ad_revision.time_end_ms` |
| `screenshots` | array<`ImageRef`> \| null | 是 | 截图（30 分钟窗口；`ImageRef` 归 m08，C87）；没有为 `[]`，只在结果脱敏的重放里为 `null` | `ad_revision.screenshot_file_ids` |
| `actorType` | enum(`merchant`,`staff`,`system`,`partner`) | 是 | 提出人类型 | `ad_revision.actor_type` |
| `actorName` | string \| null | 是 | 提出人：商家取主体内称呼，员工取姓名 | `ad_revision.actor_id` → `entity_member.display_name` / `staff.name` |
| `client` | enum(`weapp`,`portal`,`admin`) \| null | 是 | 客户端来源 | `ad_revision.client` |
| `dueAt` | string(date-time) | 是 | 修改版应交付时间 | `ad_revision.due_at` |
| `breachedAt` | string(date-time) \| null | 是 | 超时标记 | `ad_revision.breached_at` |
| `fulfilledByVersionNo` | integer \| null | 是 | 由哪个版本满足 | `ad_revision.fulfilled_by_version_no` |
| `createdAt` | string(date-time) | 是 | 提出时间 | `ad_revision.created_at` |

#### `AdTaskDetail`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| （`AdTaskCard` 的全部字段，`actions` 见下） | — | 是 | 同上 | 同上 |
| `promoPoints` | array<`DictRef`> | 是 | 宣传重点 | `ad.promo_point_codes` + 字典 `ad_promo_point` |
| `copy` | string \| null | 是 | 广告文案；空显示“未填写，由剪辑师依据档案撰写” | `ad.copy` |
| `remark` | string \| null | 是 | 备注 | `ad.remark` |
| `referenceFiles` | array<`ReferenceFileView`> | 是 | 参考素材（素材库或档案媒体；“档案素材：门头照片 1 张、主推菜品图 2 张”按 `source`、`mediaGroup` 汇总） | `file_ref`（`ref_type = ad`、`role = reference`）；`store_asset_usage`（`used_by_type = ad`）；`store_profile_media`，见 2.1 |
| `returnedFrom` | enum(`pending_assign`,`producing`) \| null | 是 | 退回前状态 | `ad.returned_from` |
| `returnedAt` | string(date-time) \| null | 是 | 最近退回时间 | `ad.returned_at` |
| `returnReason` | string \| null | 是 | 退回原因 | `ad.return_reason` |
| `resubmitCount` | integer | 是 | 补充后重新提交次数 | `ad.resubmit_count` |
| `pricing` | object | 是 | `{ unitPricePoints, discountBp, chargePoints, freeRevisionQuota }`（“超出后每次扣 45 积分（专业版）”的单价另由当前价目算，见说明） | `ad.unit_price_points`、`discount_bp`、`charge_points`、`free_revision_quota` |
| `pointHold` | object | 是 | 冻结单 `{ pointHoldId, status, heldAt, capturedAt }` | `ad.point_hold_id` → `point_hold` |
| `refunds` | object | 是 | `{ refundRequestedPoints, returnedPoints, convertedPoints, forfeitedPoints }` | `ad` 同名四列 |
| `capturedAt` | string(date-time) \| null | 是 | 扣减时间（指派即扣） | `ad.captured_at` |
| `confirmedAt` | string(date-time) \| null | 是 | 最近确认时间 | `ad.confirmed_at` |
| `cancelReasonCode` | enum(`CancelReason`) \| null | 是 | 取消原因 | `ad.cancel_reason_code` |
| `cancelledAt` | string(date-time) \| null | 是 | 取消时间 | `ad.cancelled_at` |
| `versions` | array<`AdminAdVersionView`> | 是 | 版本（倒序） | `ad_version` |
| `revisions` | array<`AdminAdRevisionView`> | 是 | 修改轮次（倒序） | `ad_revision` |
| `usages` | array<{ `orderItemId`, `orderNo`, `deliveryTicketId`, `ticketNo`, `dramaTitle`, `slot`, `boundVersionNo`, `phase` }> | 是 | 被哪些订单项引用（“使用中 N 部剧”） | `order_item_placement`（`ad_id`）联 `order_item`、`drama_order.order_no`、`delivery_ticket` |
| `agreement` | object | 是 | `{ agreementKey, versionLabel, consentedAt, method }`（《广告制作与交付服务协议》） | `ad.agreement_consent_id` → `agreement_consent`；`agreement_version.major`、`minor` |
| `cancelRequests` | array<`CancelRequestCard`> | 是 | 本广告的取消申请 | `cancel_request`（`ad_id`） |
| `serviceTickets` | array<{ `serviceTicketId`, `ticketNo`, `status` }> | 是 | 关联的客服工单（客服工单详情跳转来源） | `service_ticket_ref`（`ref_type = ad`） |
| `recentActivities` | array<`ActivityItem`> | 是 | 最近 50 条操作日志（“版本与修改记录”时间线） | `audit_log`（`target_type` ∈ {`ad`,`ad_version`,`ad_revision`}，属本广告） |
| `lockVersion` | integer | 是 | 广告锁版本（只读） | `ad.lock_version` |
| `actions` | array<string> | 是 | `assign`（待指派、无在途取消、有 `delivery.ad.assign`，资质未通过时置灰）；`return`（待指派或制作中）；`create-version`（制作中或修改中，调用者是剪辑师本人）；`remind`（待确认、今天未催办）；`request-change`（待确认或已确认、还有免费次数）；`cancel`（未确认、未取消、无在途取消、有 `order.refund.request`） | 计算 |

#### `AdSummary`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `tabs` | object | 是 | 键与列表的 `tab` 一致：`todo`（待指派 ＋ 制作中 ＋ 修改中）、`pending_confirm`、`confirmed`、`returned`（待补充）、`cancelled` | `ad.status` 计数 |
| `overdueCount` | integer | 是 | 待处理中已过 `due_at` 的 | 计算 |
| `waitingQualificationCount` | integer | 是 | 待指派且门店资质未通过的 | 计算 |

### 2.10 制作文件与制作素材

#### `ProductionRecordView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `productionRecordId` | string(uuid) | 是 | 等于文件 id | `production_record.file_id` |
| `kind` | enum(`sample`,`final`,`ad`) | 是 | 文件种类 | `production_record.kind` |
| `orderItemId` | string(uuid) \| null | 是 | 订单项（样片、成片） | `production_record.order_item_id` |
| `adId` | string(uuid) \| null | 是 | 广告 | `production_record.ad_id` |
| `episodeNo` | integer \| null | 是 | 集号 | `production_record.episode_no` |
| `variant` | enum(`common`,`douyin`,`wechat_channels`) | 是 | 平台变体 | `production_record.variant` |
| `source` | enum(`manual_upload`,`normalized`,`restamped`,`render`,`ai_assisted`) | 是 | 产物来源 | `production_record.source` |
| `derivedFromFileId` | string(uuid) \| null | 是 | 规格化、补标产物的来源文件 | `production_record.derived_from_file_id` |
| `productionTier` | enum(`standard`,`advanced`,`top`) \| null | 是 | 档位快照（A98；广告为空） | `production_record.production_tier` |
| `master` | object \| null | 是 | 所用原片 `{ dramaEpisodeMasterId, revNo, masterSource }` | `production_record.drama_episode_master_id` → `drama_episode_master.rev_no`；`production_record.master_source` |
| `headAdVersionId` | string(uuid) \| null | 是 | 所用片头广告版本 | `production_record.head_ad_version_id` |
| `tailAdVersionId` | string(uuid) \| null | 是 | 所用片尾广告版本 | `production_record.tail_ad_version_id` |
| `aiUsage` | object | 是 | AI 使用声明 `{ used, tools: [{ name, version, usedFor }], declaredBy, declaredAt, forcedByDrama }` | `production_record.ai_usage`（`06-media.md` 4.6） |
| `aigcState` | enum(`not_required`,`pending`,`verified`,`failed`) | 是 | 隐式标识状态 | `production_record.aigc_state` |
| `aigcOrigin` | enum(`upstream`,`stamped`) \| null | 是 | 标识来源 | `production_record.aigc_origin` |
| `aigcMeta` | object \| null | 是 | 回读到的隐式标识（GB 45438-2025 七个字段，键名原样） | `media_info.aigc_meta` |
| `pipelineState` | enum(`uploading`,`checking`,`ready`,`rejected`) | 是 | 入库流水线进度 | `production_record.pipeline_state` |
| `check` | object \| null | 是 | 体检结论 `{ profile, ruleVersion, gate, hard: [{ code, pass, actual, expected }], soft: [{ code, level, actual, note }], checkedAt }` | `media_check.profile`、`rule_version`、`gate`、`hard`、`soft`、`checked_at` |
| `media` | object \| null | 是 | 探测事实 `{ durationMs, width, height, displayWidth, displayHeight, vcodec, acodec, bitrateKbps, isFaststart }` | `media_info` 同名列 |
| `uploadedBy` | `StaffBrief` \| null | 是 | 上传员工；系统产物为空 | `production_record.uploaded_by_staff_id` |
| `createdAt` | string(date-time) | 是 | 登记时间 | `production_record.created_at` |
| `actions` | array<string> | 是 | `normalize`（成片或广告，`ready` 或 `rejected`）；`restamp`（`ai_usage.used = false`，`ready` 或 `rejected`）；`recheck`（`ready` 或 `rejected`；真实人工重检任务失败/取消且无进行中任务时可恢复重检） | 计算 |

#### `ProductionJobAccepted`

规格化、补标、重检的响应：建好任务即返回，结果由媒体任务异步产出（C63）；前端按 `productionRecordId` 轮询 `admin.productionRecord.list`。规格化、补标的产物体检通过（`pipelineState = ready`）后，由剪辑师按产物的 `fileId` 经 3.30（成片）或 3.56（广告）登记为新修订或新版本，重新质检；V1.0 不自动登记（x01 第 8 节第 10 项不注册 `media.production.derived` 的订阅者）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `sourceFileId` | string(uuid) | 是 | 来源文件 | 路径参数 |
| `productionRecordId` | string(uuid) | 是 | 跟踪的制作留痕：规格化、补标为新产物的行（等于新文件 id）；重检为原行 | `production_record.file_id` |
| `pipelineState` | enum(`uploading`,`checking`) | 是 | 当前进度 | `production_record.pipeline_state` |
| `mediaJobId` | string(uuid) | 是 | 媒体任务 | `media_job.id` |
| `jobKind` | enum(`normalize`,`restamp`,`probe`) | 是 | 任务种类 | `media_job.kind` |
| `jobState` | enum(`queued`,`running`,`submitting`,`submitted`,`succeeded`,`failed`,`canceled`) | 是 | 任务状态 | `media_job.state` |

#### `MaterialList`

`admin.deliveryTicket.material.list` 的响应。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `masters` | array<object> | 是 | 逐集原片：`{ episodeNo, dramaEpisodeMasterId, revNo, durationMs, sizeBytes, myLastCheckout: { checkedOutAt, checkoutCount, dramaEpisodeMasterId } \| null }`；`sizeBytes` 为 string(bigint)；`myLastCheckout` 为调用者本人对该集最近一次取料（版本与当前不同时前端提示“原片已更新”） | `drama_episode_master`（`drama_id`、`is_current`）；`file_object.size_bytes`；`master_checkout`（`order_item_id`、`episode_no`、`staff_id` = 本人） |
| `ads` | array<{ `slot`, `adId`, `adNo`, `adVersionId`, `versionNo`, `durationMs`, `copy` }> | 是 | 所用广告版本：已钉住取钉住版本，浮动取当前确认版本；尚未确认的不列 | `order_item_placement`；`ad.confirmed_version_no`；`ad_version` |
| `storeAssets` | array<{ `storeAssetId`, `type`, `title`, `usability` }> | 是 | 素材库参考素材（方案已确认版本的 `referenceAssetIds`，无则订购单登记的素材库来源） | `delivery_plan_version.content_snapshot.referenceAssetIds`；`store_asset_usage`；`store_asset.type`、`title`、`usability` |
| `profileMedia` | array<`ReferenceFileView`> | 是 | 订购单登记的门店档案媒体参考（`source = profile_media`；门头、店内环境、产品、宣传照片与视频），下载经 3.28 的 `kind = profile_media` | `file_ref`（`ref_type = drama_order`、`role = reference`、没有对应 `store_asset_usage` 的行）；`store_profile_media.media_group`、`media_kind` |
| `profileText` | object | 是 | 档案文字（剪辑师据此撰写文案）：`{ brandName, brandIntro, promoText, groupBuyText, sellingNote, bannedTerms }` | `store_profile.brand_name`、`brand_intro`、`promo_text`、`group_buy_text`、`selling_note`、`banned_terms` |

## 3. 接口

每条接口按写作规范第 2 节的格式写；通用错误码（C27）只列有特殊含义的。“画板”一行写原型画板，原型没画的写“原型无”。

### 3.1 admin.order.list　订购单列表

`GET /admin/orders`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `order`（v）＋ 数据范围（1.1） |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:Orders（订购单子页签）；A:MerchantDetail（“订单”页签下的“订购单”子页签，A29，带 `storeId` 或 `entityId`） |
| 出处 | 路线图 `a05.orders.list`；d3-flow.md:3522；09-order-ad.md:158、183；proto-admin-b.md:170-190 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum(`all` 或 4.1 `OrderStatus` 的 8 个取值) | 否 | 缺省 `all` | 状态页签（A24） |
| 查询 | `q` | string | 否 | 1–40 字 | 订单号、商家（门店名）或剧名（下单快照） |
| 查询 | `storeId` | string(uuid) | 否 | — | 门店 |
| 查询 | `entityId` | string(uuid) | 否 | — | 主体（商家详情） |
| 查询 | `deliveryManagerId` | string(uuid) \| `none` | 否 | — | 交付经理；`none` = 未分配 |
| 查询 | `dramaId` | string(uuid) | 否 | — | 剧目 |
| 查询 | `submittedFrom` / `submittedTo` | string(date) | 否 | 两端都含 | 下单日期范围（“今天 / 近 7 天 / 近 30 天”由前端换算） |
| 查询 | `isRejectedStale` | boolean | 否 | — | 只看“待开工超期未补正”（工作台待办 `order_rejected_stale` 的预置筛选，口径见 1.3） |
| 查询 | `sort` | enum(`-submittedAt`,`submittedAt`,`-statusChangedAt`) | 否 | 缺省 `-submittedAt` | 排序（C44） |
| 查询 | `page`、`pageSize` | integer | 否 | `pageSize` ≤ 100，缺省 20 | 原型每页 10 条 |

**响应**：`AdminPage<AdminOrderCard>`。

**错误**：只有 `VALIDATION_FAILED`（400，参数不合法）。

**副作用**：无。

**说明**

- `q` 的匹配：订单号前缀；门店名、剧名包含（`drama_order.order_no`、`store.name`、`order_item.drama_snapshot.title`）。
- 订单状态与子状态是推导后物化在 `drama_order` 上的（09-order-ad.md:183），列表只读列，不现算。
- 导出走 `admin.exportJob.create`（a02-workbench-report），`exportKey = orders.list`（权限点 `order.export`），`params` 与本接口的查询参数同构（C46）。

### 3.2 admin.order.summary　订购单状态计数

`GET /admin/orders/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `order`（v）＋ 数据范围 |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:Orders（状态筛选条“全部 1,081、待开工 4 …”） |
| 出处 | 路线图 `a05.orders.summary`（d3 写作 `/orders/stats`）；proto-admin-b.md:172；C83 |

**请求**：查询参数与 3.1 相同，去掉 `tab`、`sort`、`page`、`pageSize`。

**响应**：`OrderSummary`。

**错误**：`VALIDATION_FAILED`。

**副作用**：无。

**说明**：计数口径与列表一致（同一套筛选与数据范围）；键与 `tab` 取值一一对应（C83）。

### 3.3 admin.order.quote　订购积分试算

`POST /admin/orders/quote`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `billing`（v） |
| 幂等 | none（试算，不写库、不缓存，A18、A20） |
| 乐观锁 | 不适用 |
| 对应画板 | A:Pricing（“积分试算”：剧目、套餐版本、是否按次选用顶级模型 → P、R、T、S 与算式） |
| 出处 | 路线图 `a05.orders.quote`（原 `a04.quotes.order`，按资源归属移到本文，C10）；d1-ledger.md:676-698、1709；proto-admin-c.md:264、275 |

**请求体**（`AdminOrderQuoteBody`）

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `dramaId` | string(uuid) | 是 | 剧目存在（含草稿、已下架） | 试算的剧 |
| `planCode` | string | 是 | `plan.code` 之一 | 套餐版本 |
| `isTopModel` | boolean | 否 | 缺省 false | 是否按次选用顶级模型；版本默认顶级（旗舰版）时忽略 |

**响应**：`OrderQuoteResult`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `PLAN_NOT_AVAILABLE` | 409 | `planCode` 没有此刻生效的价目修订（m07-billing 定义）；未上架但有生效价目的版本照常试算 |
| `NOT_FOUND` | 404 | 剧目不存在 |
| `VALIDATION_FAILED` | 400 | 参数不合法 |

**副作用**：无。

**说明**

- 与商家端 `m.order.quote`（m04-mall-order）、确认订购用同一个计价函数（d1 5.1；`S = round(P × R × (1 + T))`），本接口只换掉了 R 与 T 的来源：R 取所选版本当前价目的 `plan_revision.discount_bp`，不取某个商家的订阅周期。
- 剧目没有可用价格（无热度等级、也没有生效的单剧调整）时不报错，`listPricePoints`、`chargePoints`、`formula` 为空，页面显示“未定价”。
- 剧目不可订购不影响试算，`orderable` 与 `unorderableReason` 只作提示。

### 3.4 admin.order.get　订购单详情

`GET /admin/orders/{orderId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `order`（v）＋ 数据范围 |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:OrderDetail；A:TicketDetail、A:ServiceDetail 的“订购单”跳转 |
| 出处 | 路线图 `a05.orders.get`（草案按 `{no}` 取，按 A3、A4 改为 uuid）；d3-flow.md:3522；proto-admin-b.md:211-219 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderId` | string(uuid) | 是 | 在数据范围内 | 订购单；按单号查找用 3.1 的 `q` |

**响应**：`AdminOrderDetail`。

**错误**：`NOT_FOUND`（404）。

**副作用**：无（A19：GET 不写访问记录）。

**说明**

- 页头“取消审批中 · 退回 N 积分”徽标取 `openCancelRequest`；进度条 6 步（提交订购 → 开始制作 → 制作中 → 待上线 → 上线中 → 已结束）由 `submittedAt`、`startedAt`、各订单项阶段与 `closedAt` 得出，前端绘制。
- 协议区的授权书逐封列在 `licenseLetters`（下载传 `currentRevision.fileId` 给 `admin.file.downloadUrls`，a01-system）；版次历史、更正与作废走 `admin.orderItem.licenseLetter.list`（3.47）；“已下载 2 份”的打包下载暂不提供（第 6 节第 5 项）。
- 参考素材：`referenceFiles` 按 `file_ref` 列出素材库与档案媒体两种来源，前端按 `source`、`mediaGroup` 汇总成“商家档案：门头与店内环境 8 张、菜品实拍 5 张”。

### 3.5 admin.order.activity.list　订购单操作日志

`GET /admin/orders/{orderId}/activities`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `order`（v）＋ 数据范围 |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:OrderDetail（操作日志） |
| 出处 | 路线图 `a05.orders.activities`；proto-admin-b.md:218；M31 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderId` | string(uuid) | 是 | 在数据范围内 | 订购单 |
| 查询 | `cursor` | string | 否 | — | 游标，首页不传 |
| 查询 | `limit` | integer | 否 | 1–100，缺省 20 | 每页条数 |

**响应**：`AdminCursorPage<ActivityItem>`，按时间倒序。

**错误**：`NOT_FOUND`。

**副作用**：无。

**说明**

- 范围是对象属于本订购单的 `ops`、`activity` 流审计行（`access` 流不在内）：`drama_order`（本单）、`order_item`、`delivery_ticket`（本单的工单，如“生成工单 2 个并分配给林晓”）、`delivery_plan`、`sample`（本单各工单的样片，如“推送第 1 集样片待商家确认”）、`license_letter`（“生成《定制内容授权书》2 份”）、`cancel_request` 与其审批单 `approval_request`（取消申请随审批单联动的迁移并入审批单那一行，`03-staff-authz-audit.md:641`）。
- 取法：先查出本单各类子对象的 id（订单项、工单、方案、样片、授权书、取消申请与审批单，都按 `drama_order_id` 或经订单项、工单一层关联），再按 `(target_type, target_id)` 逐类走 `ix_audit_log_target` 取一页，按 `(created_at, seq)` 倒序归并后截断；游标编码最后一行的 `(created_at, seq)`。不按门店整表过滤。
- 各工单更细的日志（成片、质检、补发、发布清单）在 `admin.deliveryTicket.activity.list`（3.19）。

### 3.6 admin.order.cancelQuote　订购取消试算

`POST /admin/orders/{orderId}/cancel-quote`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `order.refund.request`；对象在数据范围内 |
| 幂等 | none（试算，A20） |
| 乐观锁 | 不适用 |
| 对应画板 | A:OrderDetail（“发起取消”弹窗：按剧逐行核算、合计退回、退回去向；切换原因即重算） |
| 出处 | 路线图 `a05.orders.cancel-quote`；d3-flow.md:2072-2152、3522；09-order-ad.md:1029-1040；proto-admin-b.md:225；05-risks-and-open-issues.md:209 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderId` | string(uuid) | 是 | 在数据范围内 | 订购单 |

请求体（`OrderCancelQuoteBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `reasonCode` | enum(`merchant_request`,`store_closed`,`platform_fault`) | 是 | `qualification_final` 只由系统生成，不接受 | 取消原因 |
| `orderItemIds` | array<string(uuid)> | 否 | 属本单，不重复 | 只取消其中几部；缺省为全部未关闭的订单项（后台默认全选，d3-flow.md:2084） |
| `terminationDate` | string(date) | 否 | 不早于该项上线首日，不晚于今天与使用期止日 | 只对已上线的订单项有意义（平台原因终止日）；缺省为今天（北京时间） |
| `manualDeducts` | array<{ `orderItemId`, `deductPoints`: integer, `deductNote`: string }> | 否 | `deductPoints` 在 0 到该项剩余数量之间；`deductNote` 1–200 字 | “样片确认后至上线前”且快照没有比例的行，由客服填写扣除数与依据（05-risks-and-open-issues.md:209） |

**响应**：`CancelQuote`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `ORDER_IN_AFTER_SALE` | 409 | 订购单已有在途的取消申请（`drama_order.open_cancel_request_id` 非空；m05-delivery-publish 定义），`details.orderId` |
| `VALIDATION_FAILED` | 400 | 原因取 `qualification_final`；`orderItemIds` 不属本单；终止日越界；人工扣除数越界或缺说明（`fieldErrors` 指向对应字段） |
| `NOT_FOUND` | 404 | 订购单不在范围内 |

**副作用**：无（`billing.previewReturn` 只读）。

**说明**

- 逐项核算按 `cancelLine`（d3-flow.md:2112-2134）：待开工 → `release` 全额；制作中、待上线 → 按工单步骤取阶段与快照比例（`order_item.pricing_snapshot.cancelDeductionBp`，平台原因为 0），`扣除 = min(剩余, round(S × 比例))`，退回 > 0 为 `refund`，否则 `terminate_only`；已上线 → 只接受平台原因，按“剩余天数 ÷ 总天数”折算（`refund = min(剩余, round(S × 终止日次日至止日的天数 ÷ 上线首日至止日的天数))`），商家原因进 `blockers`（`live_not_refundable`）；工单在到期下架且从未上线 → `item_expired`；已关闭（已取消、已退回积分、已终止、已结束）→ `item_closed`。恒有 `扣除 + 退回 = 应扣 − 已请求退回`。
- `post_sample` 阶段快照比例为 null 时该行 `isManualDeduct = true`：未给 `manualDeducts` 时按扣除 0 试算，并置 `needsManualDeduct`；发起时必须给（3.7）。
- 去向（回到本期、转加购、不予退回）由账本按冻结单与快照计算，退回数额以服务端为准；`expect` 原样带到发起接口。

### 3.7 admin.order.cancelRequest.create　发起订购取消

`POST /admin/orders/{orderId}/cancel-requests`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `order.refund.request`（客服；d3 的 `order.cancel.submit` 已并入）；对象在数据范围内 |
| 幂等 | required |
| 乐观锁 | 不带；在订购单行锁下检查 `open_cancel_request_id` 与部分唯一索引 `uq_cancel_request_drama_order_id_open` |
| 对应画板 | A:OrderDetail（“发起取消”提交）；A:ServiceDetail（从客服工单发起） |
| 出处 | 路线图 `a05.orders.cancel-requests.create`；09-order-ad.md:547、555-558；d3-flow.md:2075-2092；03-staff-authz-audit.md:804；proto-admin-b.md:225；proto-admin-d.md:130 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderId` | string(uuid) | 是 | 在数据范围内 | 订购单 |

请求体（`OrderCancelRequestCreateBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `reasonCode` | enum(`merchant_request`,`store_closed`,`platform_fault`) | 是 | — | 落 `cancel_request.reason_code`；决定各行 `reason_class` |
| `note` | string | 是 | 5–200 字 | 申请说明，落 `cancel_request.note` |
| `orderItemIds` | array<string(uuid)> | 否 | 同 3.6 | 缺省为全部可取消的订单项 |
| `terminationDate` | string(date) | 否 | 同 3.6 | 已上线行的终止日，落 `cancel_request_line.termination_date` |
| `manualDeducts` | array<{ `orderItemId`, `deductPoints`, `deductNote` }> | 条件 | 同 3.6；每个 `isManualDeduct` 的行都必须给 | 落 `cancel_request_line.deduct_points`、`deduct_note` |
| `expect` | object `{ totalRefundPoints: integer }` | 是 | — | 3.6 返回的 `expect` 原样带回 |
| `serviceTicketId` | string(uuid) | 否 | 属同一门店 | 从客服工单发起时带上，写 `service_ticket_ref` |

**响应**：`CancelRequestDetail`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `ORDER_IN_AFTER_SALE` | 409 | 订购单已有在途取消（同一订购单只允许一张在途申请，含整店取消） |
| `CANCEL_ITEM_NOT_ALLOWED` | 409 | 明确选了不能取消的订单项，或一个可取消的订单项都没有；`details.lines` 列出原因 |
| `CANCEL_QUOTE_CHANGED` | 409 | 服务端重算的 `totalRefundPoints` 与 `expect` 不等（如提交前工单推进到下一步）；`details.quote` 带新的 `CancelQuote` |
| `VALIDATION_FAILED` | 400 | 说明不足 5 字或超 200 字；人工扣除缺失、越界或缺说明；终止日越界 |
| `NOT_FOUND` | 404 | 订购单或客服工单不在范围内 |

**副作用**（同一事务；09-order-ad.md:555-558）

- `approval_request`：（新建）→ `pending`（`submit`，`kind = order_cancel`，`category = approval`，`subject_type = drama_order`，`round_no = 1`，`request_no` 取 `TK` 号，`requester_staff_id` 与提交人三列为本人，`submit_client = admin`，`dedupe_key` 为空，`idempotency_key` 取请求头；`summary_snapshot` 由本模块注册的处理器生成，如“订购取消 LYX… · 3 部”、`points = total_refund_points`、`domain = { type: cancel_request, id }`）；写 `due_at`、`sla_snapshot`（策略 `review.refund_approve`），登记决定时限定时器 `sla.breach`（主体为审批单，`dedupe_key` 带 `:decision`）。
- `cancel_request`：（新建）→ `pending_approval`（`cancel.submit`，09-order-ad.md:547），写合计三列与 `line_count`；`cancel_request_line` 逐行插入（`preview_snapshot` 为本次重算的去向）。
- `drama_order.open_cancel_request_id` = 本申请；`drama_order.status` 重新推导为 `after_sale`（子状态 `cancel_reviewing`）。
- 工单在步骤 1～9 的：`delivery_ticket.step` 不变（`ticket.hold`，10-delivery.md:189 第 17 行），插入暂停原因 `cancel_review`（`delivery_ticket_pause.ref_type = approval_request`、`ref_id` = 审批单 id、操作人为本人、`client = admin`），`pause_count + 1`；集合由空变非空时写 `paused_at`、`pause_remaining_min`，取消本环节的 `sla.breach`。已上线的不暂停（终止日已固定）。
- 带 `serviceTicketId` 时插入 `service_ticket_ref`（`ref_type = approval_request`）。
- 出站事件 `approval.submitted`、`cancel.submitted`、`order.status_changed`、每张被暂停的工单 `ticket.held`（事件名取 x01 事件目录）。
- 免审批开关 `refund.points.auto_approve_before_production` 打开、且全部明细为 `release` 并预览全额回到原批次时，同一事务由系统审批并执行（`cancel.auto_execute`，09-order-ad.md:553）：审批单 `pending → approved`（`is_decided_by_system = true`），`cancel_request` 直接到 `done`（`is_executed_by_system = true`），执行的写入同 3.15（此时只有待开工的订单项：`order_item.phase` `pending_start → cancelled`，冻结单 `held → released`；没有工单可暂停）；响应里 `status = done`。这一分支另发 `approval.approved`（`isDecidedBySystem = true`）、`cancel.executed`（`isAutoExecuted = true`）、`approval.executed`、每个订单项一条 `order.item.cancelled`，账本发 `billing.points.returned`；`order.status_changed` 只发一次，载荷是最终状态（E2）。

**说明**

- 发起时在锁内按 3.6 的口径重算，数额以重算为准；与 `expect` 不等即拒绝，避免客服告知商家的数字与提交的不同。
- 审批与执行在 A:Refunds 处理（3.11–3.15）；审批与执行各有 1 个工作日时限（`sla.review.refund_approve`、`sla.review.refund_execute`）。
- 取消原因“平台原因无法交付”时比例为 0，全额退回（proto-admin-b.md:225）。

### 3.8 admin.cancelRequest.list　取消申请列表

`GET /admin/cancel-requests`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `order` 或 `finance`（任一 ≥ v，与 a01 审批类型表 `order_cancel` / `ad_cancel` / `qualification_cancel` 的查看门槛一致）＋ 数据范围；发起人可见自己发起的（d3-flow.md:2357） |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:Refunds（积分一侧的队列：待审批、待执行、已处理） |
| 出处 | 路线图 `a05.cancel-requests.list`（A26）；proto-admin-d.md:92-123；09-order-ad.md:504 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum(`pending_approval`,`pending_execution`,`processed`,`all`) | 否 | 缺省 `pending_approval` | 页签（`processed` = `done` 与 `not_executed`） |
| 查询 | `q` | string | 否 | 1–40 字 | 申请单号、订购单号、广告编号或商家名 |
| 查询 | `kind` | array<enum(`order_cancel`,`ad_cancel`,`qualification_cancel`)> | 否 | 逗号分隔 | 类型 |
| 查询 | `reasonCode` | enum(4.2 `CancelReason`) | 否 | — | 原因 |
| 查询 | `storeId` / `entityId` | string(uuid) | 否 | — | 商家 |
| 查询 | `requesterId` | string(uuid) \| `me` | 否 | — | 发起人；`me` = 本人 |
| 查询 | `overdueOnly` | boolean | 否 | — | 只看超时的待审批与待执行 |
| 查询 | `submittedFrom` / `submittedTo` | string(date) | 否 | 两端都含 | 申请日期 |
| 查询 | `sort` | enum(`urgency`,`-submittedAt`,`execDueAt`) | 否 | 缺省 `urgency`（超时在前，再按时限升序） | 排序 |
| 查询 | `page`、`pageSize` | integer | 否 | `pageSize` ≤ 100 | — |

**响应**：`AdminPage<CancelRequestCard>`。

**错误**：`VALIDATION_FAILED`。

**副作用**：无。

**说明**：退款管理页把现金退款（`admin.refundRequest.list`，a07-billing-finance）与本列表并排展示，各调各的列表与 `summary`（C83），不做合并接口；“待执行”页签用本接口，不再经 `admin.approval.list` 取领域行（路线图备注）。

### 3.9 admin.cancelRequest.summary　取消申请计数与指标

`GET /admin/cancel-requests/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `order` 或 `finance`（任一 ≥ v）＋ 数据范围（同 3.8） |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:Refunds（KPI“本月退回积分（积分 / 笔数）、审批与执行中、本月驳回”与页签计数） |
| 出处 | 路线图 `a05.cancel-requests.summary`（A26、A23）；proto-admin-d.md:93 |

**请求**：查询参数与 3.8 相同，去掉 `tab`、`sort`、`page`、`pageSize`。

**响应**：`CancelRequestSummary`。

**错误**：`VALIDATION_FAILED`。

**副作用**：无。

**说明**：“本月”按北京时间自然月；现金一侧的“本月已退款金额”由 `admin.refundRequest.summary` 给。

### 3.10 admin.cancelRequest.get　取消申请详情

`GET /admin/cancel-requests/{cancelRequestId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `order` 或 `finance`（任一 ≥ v）＋ 数据范围；发起人可见自己发起的（同 3.8；只有订单查看权的客服从订购单详情的取消记录点进来也能看） |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:Refunds（右侧详情）；A:OrderDetail（取消记录）；“我的待审批”页（A16，从 `admin.approval.get` 的 `domain` 跳来） |
| 出处 | 路线图 `a05.cancel-requests.get`（A26）；09-order-ad.md:547；proto-admin-d.md:97-118 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `cancelRequestId` | string(uuid) | 是 | 在范围内 | 取消申请 |

**响应**：`CancelRequestDetail`。

**错误**：`NOT_FOUND`。

**副作用**：无。

**说明**：“退回方式：退回积分账户（套餐积分，本期 10-17 到期）”与“提示：并入本期套餐积分，随本期于 … 清零”由 `destination.lots` 得出；积分类申请不涉及开票，页面固定文案。

### 3.11 admin.cancelRequest.approve　审批通过

`POST /admin/cancel-requests/{cancelRequestId}/approve`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `finance.refund.approve`（注册表标再验证，超出 10 分钟窗口返回 403 `STEP_UP_REQUIRED`）；回显 `confirm`（C54）；调用者不能是发起人 |
| 幂等 | required |
| 乐观锁 | 带审批单的 `lockVersion`（03-staff-authz-audit.md:805 的守卫列了 `lock_version`；A21、C53） |
| 对应画板 | A:Refunds（“确认审批通过”弹层，须勾选“已核对所处阶段、适用规则与退回数额”）；“我的待审批”页 |
| 出处 | 路线图 `a05.cancel-requests.approve`（A14，原 `a01.approvals.approve` 的三类取消）；09-order-ad.md:548、559；03-staff-authz-audit.md:805；d3-flow.md:2095-2104、2368；proto-admin-d.md:125 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `cancelRequestId` | string(uuid) | 是 | 在范围内 | 取消申请 |

请求体（`CancelApproveBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `lockVersion` | integer | 是 | 等于 `approval_request.lock_version` | 审批单的锁版本（详情 `approval.lockVersion`） |
| `confirm` | object `{ requestNo: string, totalRefundPoints: integer }` | 是 | 与库中当前值一致 | 二次确认回显 |
| `confirmChecks` | array<string> | 是 | ≥ 1 项，取值见 4.2 `ConfirmCheck` | 勾选的核对项，落 `approval_request.confirm_checks` |

**响应**：`CancelRequestDetail`（`status = pending_execution`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `APPROVAL_NOT_PENDING` | 409 | 审批单已不是 `pending`（已被他人处理、已撤回）；a03-merchant 定义（d4-identity.md:1494） |
| `APPROVAL_SELF_FORBIDDEN` | 403 | 调用者是发起人（超级管理员也不例外）；a03-merchant 定义（d4-identity.md:1412） |
| `STEP_UP_REQUIRED` | 403 | 再验证窗口已过（通用码，C27） |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符 |
| `CONFIRM_MISMATCH` | 409 | `confirm` 与当前单号或退回合计不一致 |
| `PRECONDITION_CHANGED` | 409 | 重新校验不一致（对象不在提交时的状态、暂停原因已不在、已请求退回累计变了、去向三个数变了，最常见的是套餐周期在审批期间结束）；`details.diffs` 同 `recheckLog.approve.diffs`；申请保持原状态，由审批人驳回或申请人撤回后重新发起 |
| `VALIDATION_FAILED` | 400 | `confirmChecks` 为空或含未知值 |

**副作用**（同一事务）

- `approval_request.status`：`pending` → `approved`（`approve`，03-staff-authz-audit.md:805），写 `decided_by_staff_id`、`decided_at`、`confirm_checks`，`lock_version + 1`；取消决定时限定时器（`…:decision`）。
- `cancel_request.status`：`pending_approval` → `pending_execution`（`approval.approved`，09-order-ad.md:548），同一条 UPDATE 写 `exec_due_at`（1 个工作日）与 `sla_snapshot`（策略 `review.refund_execute`）；登记执行时限定时器 `sla.breach`（主体为审批单，`dedupe_key` 带 `:execution`，M71）。
- 重新校验的结果写 `cancel_request.recheck_log.approve`；不一致时在独立的小事务里写入后返回 409（09-order-ad.md:489）。
- 审计：`ops` 流，`category = refund`，动作 `order.cancel_request.approve`；出站事件 `approval.approved`（通知申请人、客服工单时间线）、`cancel.approved`。

**说明**：审批不动积分与工单（工单继续暂停到执行或关闭）。审批人可以执行自己批准的申请（d3-flow.md:2367 默认；数据模型没有“执行人不同于审批人”的参数，见第 6 节第 2 项）。

### 3.12 admin.cancelRequest.reject　驳回

`POST /admin/cancel-requests/{cancelRequestId}/reject`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `finance.refund.approve`；调用者不能是发起人；守卫顺序见 1.1 |
| 回显 | 无 `confirm`；`x-step-up: skip`（C86 登记，A127：驳回不要求再验证，维持 03-staff-authz-audit.md:806，即使权限点在注册表标了再验证也不检查） |
| 幂等 | required |
| 乐观锁 | 不带（驳回的守卫未列 `lock_version`，A21）；审批单行锁 ＋ 状态守卫 |
| 对应画板 | A:Refunds（驳回弹层：单选原因 ＋ 说明，“驳回后订购单恢复原状态，继续履约；驳回原因同步给申请人和关联的客服工单”） |
| 出处 | 路线图 `a05.cancel-requests.reject`（A14）；09-order-ad.md:549、560；03-staff-authz-audit.md:806；proto-admin-d.md:126 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `cancelRequestId` | string(uuid) | 是 | 在范围内 | 取消申请 |

请求体（`CancelRejectBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `note` | string | 是 | 1–200 字 | 驳回说明，落 `approval_request.decision_note` |
| `reasonCodes` | array<string> | 否 | 0–1 项；字典 `reject_reason` 的启用编码 | 驳回原因（不符合退款规则、金额核算有误、说明不充分、其他），落 `approval_request.reason_codes`（字典 `reject_reason` 的场景“取消与退款驳回”，A156） |

**响应**：`CancelRequestDetail`（`status = not_executed`，`closeReason = rejected`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `APPROVAL_NOT_PENDING` | 409 | 审批单已不是 `pending` |
| `APPROVAL_SELF_FORBIDDEN` | 403 | 调用者是发起人 |
| `VALIDATION_FAILED` | 400 | 说明为空或超长；原因编码不存在或已停用 |

**副作用**（同一事务；`onRejected`，09-order-ad.md:560）

- `approval_request.status`：`pending` → `rejected`（`reject`），写 `decided_by_staff_id`、`decided_at`、`decision_note`、`reason_codes`；取消决定时限定时器。
- `cancel_request.status`：`pending_approval` → `not_executed`（`approval.rejected`，`close_reason = rejected`），写 `closed_at`。
- 解除本申请加的暂停原因：`delivery_ticket_pause.released_at`、`release_event = rejected`；`delivery_ticket.step` 不变（`ticket.resume`，第 18 行），集合变空时按 `pause_remaining_min` 重算 `step_due_at`、重设定时器并 `reevaluate`（10-delivery.md:190）。
- 清空 `drama_order.open_cancel_request_id` 与（整店取消时）各广告的 `ad.open_cancel_request_id`；订购单重新推导状态（`after_sale` → 推导出的原状态）；待开工且资质已通过的订购单以原键重新登记 `order.start`（`skipped` 行复活，09-order-ad.md:210）。
- 出站事件 `approval.rejected`（通知申请人、客服工单时间线）、`cancel.rejected`、`order.status_changed`、`ticket.resumed`。

**说明**：`reject_reason` 字典的“取消与退款驳回”场景与 4 个种子项由数据模型 14 分组补（A156）；`reasonCodes` 选填。

### 3.13 admin.cancelRequest.withdraw　撤回

`POST /admin/cancel-requests/{cancelRequestId}/withdraw`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`permission: assert-in-handler`（A45）。处理器的判定：① 调用者是发起人本人（`approval_request.requester_staff_id`），直接放行；② 否则为代撤（A15）：须“发起人已不是启用状态（`staff.status ≠ active`）”或“对象已失效”二者之一，且调用者持有 `finance.refund.approve`；代撤取到的权限点在注册表标了再验证，处理器校验 `stepup_at`，超出 10 分钟窗口返回 403 `STEP_UP_REQUIRED`（C66）。都不满足 403 `APPROVAL_WITHDRAW_FORBIDDEN`（a03-merchant 定义）。“对象已失效”指申请里至少一个对象已不能按申请执行：订单项已关闭（已取消、已退回积分、已终止、已结束）或广告已取消、已确认（与 `cancelLine` 的 `invalid` 分支同一判定） |
| 幂等 | required |
| 乐观锁 | 不带（03-staff-authz-audit.md:807 的守卫未列锁版本） |
| 对应画板 | A:Refunds、A:OrderDetail、A:ServiceDetail（原型未画按钮；“我的待审批”页同样可代撤） |
| 出处 | 路线图 `a05.cancel-requests.withdraw`（A14、A15，原 `a01.approvals.withdraw`）；09-order-ad.md:550、560；03-staff-authz-audit.md:807、816-822 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `cancelRequestId` | string(uuid) | 是 | 在范围内 | 取消申请 |

请求体（`CancelWithdrawBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `note` | string | 否 | ≤ 200 字 | 撤回说明，落 `approval_request.decision_note` |

**响应**：`CancelRequestDetail`（`status = not_executed`，`closeReason = withdrawn`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `APPROVAL_NOT_PENDING` | 409 | 审批单已不是 `pending`（已通过的改走作废 3.14） |
| `APPROVAL_WITHDRAW_FORBIDDEN` | 403 | 调用者不是发起人，也不满足代撤条件（a03-merchant 定义） |
| `STEP_UP_REQUIRED` | 403 | 代撤时再验证窗口已过（通用码，C27） |

**副作用**（同一事务；`onWithdrawn` 与驳回相同，09-order-ad.md:560）

- `approval_request.status`：`pending` → `withdrawn`（`withdraw`），写 `decided_at`、`decision_note`（审批人列为空）；取消决定时限定时器。
- `cancel_request.status`：`pending_approval` → `not_executed`（`approval.withdrawn`，`close_reason = withdrawn`）。
- 暂停解除（`release_event = withdrawn`）、清空对象指针、订购单重新推导、重新登记 `order.start`：同 3.12。
- 出站事件 `approval.withdrawn`、`cancel.withdrawn`、`order.status_changed`、`ticket.resumed`。

**说明**：对象失效时的系统代撤不经本接口（由归属模块在自己的事务里调 `approval.withdraw`，`is_decided_by_system = true`）。

### 3.14 admin.cancelRequest.void　作废

`POST /admin/cancel-requests/{cancelRequestId}/void`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `order.refund.request`，且调用者是该申请的发起人（A15；路线图原写的“或 `finance.refund.approve`”的放宽不采用）；不满足 403 `PERMISSION_DENIED` |
| 幂等 | required |
| 乐观锁 | 不带（09-order-ad.md:552 的守卫只要求说明） |
| 对应画板 | 原型无（A:Refunds 待执行项上的“作废”按钮，按 A15 只对发起人显示） |
| 出处 | 路线图 `a05.cancel-requests.void`（原 `a07.cancel-requests.void`，A63）；09-order-ad.md:552、560；M54 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `cancelRequestId` | string(uuid) | 是 | 在范围内 | 取消申请 |

请求体（`CancelVoidBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `note` | string | 是 | 1–200 字 | 作废说明，落 `cancel_request.close_note` |

**响应**：`CancelRequestDetail`（`status = not_executed`，`closeReason = voided`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 申请不在 `pending_execution`（未审批的用撤回，已执行的不可作废） |
| `PERMISSION_DENIED` | 403 | 调用者不是发起人 |
| `VALIDATION_FAILED` | 400 | 说明为空或超长 |

**副作用**（同一事务）

- `cancel_request.status`：`pending_execution` → `not_executed`（`cancel.void`，09-order-ad.md:552），同一条 UPDATE 写 `close_reason = voided`、`close_note`、`closed_at`；审批单保持 `approved`（M54）；取消执行时限定时器（`…:execution`）。
- 暂停解除（`release_event = voided`，10-delivery.md:305）、清空对象指针、订购单重新推导、重新登记 `order.start`：同 3.12。
- 出站事件 `cancel.voided`、`order.status_changed`、`ticket.resumed`。

**说明**：作废与撤回都把业务恢复到申请前；区别是作废发生在审批通过之后，审批单留在 `approved`。

### 3.15 admin.cancelRequest.execute　执行退回积分

`POST /admin/cancel-requests/{cancelRequestId}/execute`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `finance.refund.execute`（注册表标再验证）；回显 `confirm`；参数 `refund.require_distinct_executor`（14 分组，默认 false，A156）为 true 时执行人不得是本申请的审批人（与 a07 退款执行同一个键） |
| 幂等 | required（账本另按 `refund:{明细 id}`、`release:point_hold:{id}` 去重，d3-flow.md:2189） |
| 乐观锁 | 不带（09-order-ad.md:551 的守卫是执行权限、二次确认与重新校验） |
| 对应画板 | A:Refunds（“确认执行退回”弹层：勾选“已核对订购单与退回积分”；“积分将即时退回商家账户，执行后不可撤销；订购单变为‘已退回积分’，交付工单关闭”） |
| 出处 | 路线图 `a05.cancel-requests.execute`（原 `a07.cancel-requests.execute`，A63）；09-order-ad.md:551、561；d3-flow.md:2154-2191；10-delivery.md:191-204；07-billing-ledger.md:845-846；proto-admin-d.md:127 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `cancelRequestId` | string(uuid) | 是 | 在范围内 | 取消申请 |

请求体（`CancelExecuteBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `confirm` | object `{ requestNo: string, totalRefundPoints: integer }` | 是 | 与库中当前值一致 | 二次确认回显 |
| `confirmChecks` | array<string> | 是 | ≥ 1 项，取值见 4.2 `ConfirmCheck` | 落 `cancel_request.exec_confirm_checks` |

**响应**：`CancelRequestDetail`（`status = done`，`resultTotals` 为账本实际结果）。

W5-01 的正式执行响应与资金写入在同一事务内生成并保存为幂等回执。`lines[].result.breakdown` 的数量全部取真实账本 `ReturnResult`；当前账本未返回逐批执行明细，故其 `lots` 为 `[]`，不复制提交时预览冒充最终逐批结果。`destination` 仍保留提交时的预览，二者可区分查看。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 申请不在 `pending_execution` |
| `STEP_UP_REQUIRED` | 403 | 再验证窗口已过（通用码，C27） |
| `PRECONDITION_CHANGED` | 409 | 重新校验不一致（同 3.11，结果写 `recheck_log.execute`）；状态不变 |
| `CONFIRM_MISMATCH` | 409 | 回显不一致 |
| `ACCOUNT_BUSY` | 503 | 积分账户锁等待超时（m07-billing 定义，可重试，用同一幂等键） |
| `REFUND_EXECUTOR_CONFLICT` | 403 | 职责分离开关开启且执行人是审批人（a07-billing-finance 定义，44114） |
| `VALIDATION_FAILED` | 400 | `confirmChecks` 为空或含未知值 |

**副作用**（同一事务；唯一执行入口 `order.executeCancel`，d3-flow.md:2156；锁序“审批单 → 本表与明细 → 广告 → 订购单 → 订单项 → 工单 → 子表”，M32）

- 先完成全部状态迁移：
  - 待开工的订单项写 `cancelled_at`、`cancel_reason_code`（09-order-ad.md:323“取消或终止留痕”）。
  - 工单在步骤 1～9：`delivery_ticket.step` → `terminated`（`ticket.terminate`，10-delivery.md:191 第 19 行），写 `terminated_at`；解除全部暂停原因（`release_event = terminated`）；同事务调 publish 收尾（未上线任务 `launch.void`，`void_reason = terminated`；成片包推送过的 `ensureTakedownTasks`，10-delivery.md:198-202）；撤销下载授权（`download_grant` → `revoked`）、成片包关闭（`delivery_release` → `closed`，`close_reason = cancelled`）并调 media 作废该包的 ZIP 缓存（`zip_bundle.zip_state` → `none`，06-media.md:975）；删除广告位绑定；在办补发单的跟进关闭。
  - 已上线（使用中、到期下架）：`delivery_ticket.step` → `takedown`（第 20 行，已在该步则不变）；`order_item.usage_end_date` 改为明细里的终止日、`usage_end_source = early_end`；`ensureTakedownTasks` 改写未核查的下架任务（`trigger_kind = platform_termination`，`due_date` = 执行日 + 1）。
  - 广告：`ad.status` → `cancelled`（`ad.cancel`，09-order-ad.md:808-809），同一条 UPDATE 写 `cancelled_at`、`cancel_reason_code` 并清空 `open_cancel_request_id`。
- 再逐行调账本：`release` → `point_hold.status` `held` → `released`；`refund` → `captured` / `refunded_partial` → `refunded_partial` / `refunded_full`（07-billing-ledger.md:845-846）；`terminate_only` 不调用。按返回的 `ReturnResult` 一次写明细行的执行结果五列，并累加订单项或广告的四个退回数量。
- `order_item.phase`：`pending_start` → `cancelled`；`producing`、`to_launch` → `refunded`（实际退回 > 0）或 `terminated`（= 0）；已上线的留在 `live`，归档时再定（09-order-ad.md:353-360）。凡被本申请取消或终止的订单项（含留在 `live` 的平台原因终止项），`cancelled_at` = 执行时间、`cancel_reason_code` = 申请的 `reason_code`，与四个退回数量、阶段写在同一条 UPDATE 里（`ck_order_item_cancelled`；09-order-ad.md:281、323），订单明细据此显示“取消或终止原因”。
- 清空 `drama_order.open_cancel_request_id`，重新推导订购单状态（`cancelled`、`refunded` 或剩余订单项的阶段），关闭时写 `closed_at`；仍待开工且资质已通过的重新登记 `order.start`。
- `cancel_request.status`：`pending_execution` → `done`（`cancel.execute`），同一条 UPDATE 写 `executed_by_staff_id`、`executed_at`、`exec_confirm_checks`、`closed_at`；取消执行时限定时器。
- 审计：`ops` 流，`category = refund`；出站事件 `cancel.executed`、`approval.executed`、`order.item.cancelled` / `order.item.refunded` / `order.item.terminated`（每个订单项一条，载荷带三个实际数量）、已上线项的 `order.item.usage_end_changed`、`ad.cancelled`、`order.status_changed`、`ticket.terminated`；账本发 `billing.points.returned`，publish 收尾发 `launch.voided`、`launch.settled`、`takedown.created`（x01 事件目录）。授权书由文书模块订阅这些事件对齐作废（`void_reason` 为 `cancelled` 或 `terminated`，13-notify-docs.md:946），不在本事务。

**说明**

- 展示、状态与对账一律用账本返回的实际数量（`returned_points + converted_points` 才是“已退回 N 积分”）；`forfeited_points > 0` 时同时显示“原周期已结束，Z 积分不予退回”（d3-flow.md:2188）。
- 积分退回在同一个数据库事务里完成，没有“执行中”状态，也不是三段式用例。

### 3.16 admin.deliveryTicket.list　交付工单池

`GET /admin/delivery-tickets`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `delivery`（v；`o` 级只返回 `editor_id` 或 `publisher_id` 为本人的工单）＋ 数据范围；未分配的工单只有待分配池的主管可见（1.1） |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:Tickets（工单池）；A:Delivery（左侧队列：`tab=delivering`“待交付”、`tab=delivered_today`“今日已交付”）；A:MerchantDetail（工单页签，带 `storeId`）；流程运维（原型无：`isStuck`、`isPaused`、`pausedBefore`） |
| 出处 | 路线图 `a05.delivery-tickets.list`；d3-flow.md:3523、3273-3288；10-delivery.md:121、136；proto-admin-a.md:102-131、262-275 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum(4.3 `TicketTab`) | 否 | 缺省 `processing` | 状态页签（A24）：`processing` 处理中（步骤不在 `in_service`、`archived`、`terminated`）；11 个步骤各一个；`closed`（已归档、已终止）；`delivered_today`（今天首次推送成片包）；`all` |
| 查询 | `q` | string | 否 | 1–40 字 | 工单号、商家（门店名）或剧名 |
| 查询 | `deliveryManagerId` | string(uuid) \| `none` | 否 | — | 交付经理；`none` = 未分配 |
| 查询 | `editorId` / `publisherId` | string(uuid) | 否 | — | 剪辑师、发布专员 |
| 查询 | `productionModel` | enum(`standard`,`advanced`,`top`) | 否 | — | 制作模型 |
| 查询 | `platform` | enum(`douyin`,`wechat_channels`) | 否 | — | 发布账号平台 |
| 查询 | `overdueOnly` | boolean | 否 | — | 仅看超时与逾期（`urgency = overdue`） |
| 查询 | `storeId` / `entityId` / `orderId` | string(uuid) | 否 | — | 门店、主体、订购单 |
| 查询 | `agreedLaunchFrom` / `agreedLaunchTo` | string(date) | 否 | 两端都含 | 约定上线日范围 |
| 查询 | `isPaused` | boolean | 否 | — | 只看暂停中（流程运维；原 `opsView=paused`，C45） |
| 查询 | `pausedBefore` | string(date-time) | 否 | — | 暂停开始早于该时刻（“因取消审批暂停超过 3 个工作日”的单列，前端按工作日历换算） |
| 查询 | `isStuck` | boolean | 否 | — | 只看补偿扫描判为卡住且未处理的（原 `opsView=stuck`） |
| 查询 | `todo` | enum(`plan_push`,`sample_qc`,`staff_assign`) | 否 | — | 工作台待办的预置筛选（a02 来源键，口径见 1.3）；与 `tab` 可同时给，取交集 |
| 查询 | `sort` | enum(`urgency`,`-createdAt`,`stepDueAt`,`agreedLaunchDate`) | 否 | 缺省 `urgency` | `urgency` = 超时或逾期 → 今日截止 → 截止时间升序，再按制作排期（加急、优先、标准）（C44；10-delivery.md:96） |
| 查询 | `page`、`pageSize` | integer | 否 | `pageSize` ≤ 100 | 原型每页 10 条 |

**响应**：`AdminPage<DeliveryTicketCard>`。

**错误**：`VALIDATION_FAILED`。

**副作用**：无。

**说明**

- 截止时间的显示：在办步骤显示 `stepDueAt`（“今天 11:12”“已超时 16 小时”）；待上线、上线核验显示约定上线日（逾期按“已逾期 N 天”）；使用中显示“使用期至 `usageEndDate`”。
- 导出走 `admin.exportJob.create`，`exportKey = delivery_tickets.list`（导出键按 `ck_export_job_export_key` 的点分写法，C64；权限点 `delivery.export`，A88），`params` 与本接口查询参数同构。
- 卡住的判定来自 `flow.reevaluate_sweep` 写的 `invariant_violation`（d3-flow.md:1022；15-integration-ops.md:380）；处理方式是 `admin.deliveryTicket.reevaluate`（3.25）或纠偏（3.26），违规行的“标记已处理”在流程运维的不变量接口（a09-ops）。

### 3.17 admin.deliveryTicket.summary　工单页头统计与页签计数

`GET /admin/delivery-tickets/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | 同 3.16 |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:Tickets（页头“处理中 N 个 · 超时或逾期 N 个 · 今日截止 N 个”与状态页签计数）；A:Delivery（“待交付 N、今日已交付 N”） |
| 出处 | 路线图 `a05.delivery-tickets.summary`（d3 写作 `/tickets/stats`）；proto-admin-a.md:106-107、262；C83 |

**请求**：查询参数与 3.16 相同，去掉 `tab`、`sort`、`page`、`pageSize`。

**响应 `data`**（`DeliveryTicketSummary`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `tabs` | object | 是 | 键与 `tab` 的取值一致（`processing`、11 个步骤、`closed`、`delivered_today`、`all`），值为工单数 | `delivery_ticket.step`、`delivered_at` 计数（`ix_delivery_ticket_step_step_due_at`） |
| `header` | object | 是 | `{ processing, overdue, dueToday }` | 与 `urgency` 同口径 |

**错误**：`VALIDATION_FAILED`。

**副作用**：无。

**说明**：队列页每 30 秒静默刷新计数（d7-platform.md:1052），窗口不可见时暂停。

### 3.18 admin.deliveryTicket.get　工单详情

`GET /admin/delivery-tickets/{deliveryTicketId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `delivery`（v）＋ 数据范围（`o` 级只看本人任务） |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:TicketDetail（标题、11 步进度、方案、广告、样片与质检、成片与发布、侧栏商家 / 订购单 / 负责人 / 时效）；A:Delivery（右侧详情的工单部分）；A:ServiceDetail、A:Calendar 的跳转 |
| 出处 | 路线图 `a05.delivery-tickets.get`（`{ticketId}` 按 A4 改为 `{deliveryTicketId}`）；d3-flow.md:3523；proto-admin-a.md:151-165 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | 在范围内 | 工单 |

**响应**：`DeliveryTicketDetail`。

**错误**：`NOT_FOUND`。

**副作用**：无（后台预览地址随数据返回，不写访问记录，A19）。

**说明**

- 状态标签“样片确认 · 等待商家”= `step` ＋ `waitingOn`；“样片制作 · 修改中”= `step = sample_making` 且 `sampleRoundNo > 0`。
- 发布清单、上线任务与核验的详情分别在 a06-publish 的 `admin.deliveryTicket.publishList.get`、`admin.launchTask.*`；本接口只给摘要。

### 3.19 admin.deliveryTicket.activity.list　工单操作日志

`GET /admin/delivery-tickets/{deliveryTicketId}/activities`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `delivery`（v）＋ 数据范围 |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:TicketDetail（操作日志：时间、操作人（系统 / 员工 / 商家）、内容） |
| 出处 | 路线图 `a05.delivery-tickets.activities`；proto-admin-a.md:161；M31 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | 在范围内 | 工单 |
| 查询 | `cursor` | string | 否 | — | 游标 |
| 查询 | `limit` | integer | 否 | 1–100，缺省 20 | 每页条数 |

**响应**：`AdminCursorPage<ActivityItem>`，按时间倒序。

**错误**：`NOT_FOUND`。

**副作用**：无。

**说明**：范围是对象为本工单或与它相关的 `ops`、`activity` 流审计行：`delivery_ticket`、`sample`、`episode_output`、`qc_record`、`delivery_release`、`delivery_reissue`、`publish_list`，以及本订购单的交付方案 `delivery_plan`（“配置交付方案并推送商家确认”“在小程序确认交付方案”，同单各工单都显示）；取法同 3.5（逐类按 `(target_type, target_id)` 走 `ix_audit_log_target` 后归并）。所绑广告的日志在广告详情（3.53），不在这里重复。人工纠偏的行 `transition.isForced = true`。

### 3.20 admin.deliveryTicket.assignManager　分配交付经理

`POST /admin/delivery-tickets/{deliveryTicketId}/assign-manager`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.manager.assign`（仅主管；d3 的 `delivery.ticket.assign` 并入此键，d4-identity.md:1168） |
| 幂等 | required |
| 乐观锁 | 不带（10-delivery.md:172 的守卫只要求被分配人是启用的交付经理，A21）；防重复分配靠状态守卫与幂等 |
| 对应画板 | A:Tickets（分配弹窗：单选交付经理，显示“进行中 N 单”与“轮询推荐”，说明 ≤ 100 字） |
| 出处 | 路线图 `a05.delivery-tickets.assign-manager`；10-delivery.md:172；d3-flow.md:834、994；09-order-ad.md:219；proto-admin-a.md:127 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | 在范围内 | 工单 |

请求体（`AssignManagerBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `staffId` | string(uuid) | 是 | 启用的交付经理（`staff.staff_role_key = delivery_manager`、`staff.status = active`），在操作人的员工集合内（1.1“指派的范围”） | 被分配人；候选与在办量、推荐标记取 `admin.staff.list`（a01-system，`recommendPool=delivery_manager&recommendCityCode=<store.city.code>&withLoad=true`；城市取工单的 `store.city.code`；“进行中 N 单”取 `StaffListItem.openWorkBySource` 里 `store_manager` / `delivery_ticket` 的一项，不用合计；路线图原写的 `recommendFor` 已由 a01 取消） |
| `note` | string | 否 | ≤ 100 字 | 分配说明，落审计行的 `reason_text` |

**响应**：`DeliveryTicketDetail`（结果脱敏见 1.1）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 工单不在 `assigning` |
| `TICKET_ON_HOLD` | 409 | 工单暂停中（通用守卫，10-delivery.md:168） |
| `ASSIGNEE_INVALID` | 409 | 被分配人未启用（`not_active`）、不是交付经理（`role_mismatch`）、不在操作人的员工集合内（`out_of_scope`）；`details = { staffId, reason }` |

**副作用**（同一事务；事务开头对被分配人员工行 `FOR SHARE` 并校验启用，d3-flow.md:994）

- `delivery_ticket.step`：`assigning` → `plan_confirm`（`ticket.assign`，10-delivery.md:172），写 `delivery_manager_id`、`assigned_at`；关 `assigning` 环节、开 `plan_confirm` 环节（`due_at` = 1 个工作日，策略 `ticket.plan_confirm`），重设 `sla.breach`。
- 门店还没有交付经理时：一并写 `store.delivery_manager_id`，同门店其他未暂停的待分配工单同样分配并迁移；该门店未结订购单的 `drama_order.delivery_manager_id` 同步（09-order-ad.md:219）。这与 a03 `admin.store.assignDeliveryManager`（A91）是同一条规则的两个入口；门店已有交付经理而所选不是他时照常分配本工单，不改门店。
- 不写 `assignment_history`：首次分配没有原负责人（`assignment_history.from_staff_id` 非空，`ck_assignment_history_from_to`），“1 个工作日内联系商家”的时限也只挂在改派记录上（03-staff-authz-audit.md:420），与 a03 3.8a 一致。分配留痕在状态历史与审计行（`target_type = delivery_ticket`，`reason_text` = 说明）。
- 订购单子状态重新推导（`producing` 的子状态随最靠前工单的步骤）。
- 出站事件：每张被分配的工单一条 `ticket.assigned`（通知交付经理；x01 只把它用于第 1 行，E2：同一迁移不再发 `ticket.step_changed`）；订购单子状态变化不发 `order.status_changed`（`status` 不变）。

**说明**：轮询推荐只是候选排序，服务端不强制选推荐人。

### 3.21 admin.deliveryTicket.assignEditor　指派或改派剪辑师

`POST /admin/delivery-tickets/{deliveryTicketId}/assign-editor`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.ticket.assign_editor`（交付经理） |
| 幂等 | required（改负责人并写改派记录，复核意见 47） |
| 乐观锁 | 不带；工单行锁 |
| 对应画板 | A:TicketDetail（侧栏“负责人”；表单原型未画，05-risks-and-open-issues.md:270） |
| 出处 | 路线图 `a05.delivery-tickets.assign-editor`；d3-flow.md:992、994；03-staff-authz-audit.md 2.8 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | 在范围内 | 工单 |

请求体（`AssignStaffBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `staffId` | string(uuid) | 是 | 启用的剪辑师（`staff_role_key = editor`），在操作人的员工集合内，不同于现任 | 新负责人；候选取 `admin.staff.list`（`recommendPool=editor&withLoad=true`，标出轮询的下一位，默认推荐在办最少者；在办量取 `openWorkBySource` 里 `ticket_editor` / `delivery_ticket` 的一项） |
| `reasonCode` | enum(`workload`,`merchant_request`,`staff_change`,`other`) | 条件 | 改派（原来已有剪辑师）时必填；首次指派不传 | 落 `assignment_history.reason_code` |
| `note` | string | 否 | ≤ 200 字 | 改派时落 `assignment_history.note`；首次指派落审计行的 `reason_text` |

**响应**：`DeliveryTicketDetail`（结果脱敏见 1.1）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 工单已归档或已终止 |
| `ASSIGNEE_INVALID` | 409 | 未启用（`not_active`）、不是剪辑师（`role_mismatch`）、与现任相同（`same_as_current`）、不在操作人的员工集合内（`out_of_scope`）；`details = { staffId, reason }` |
| `VALIDATION_FAILED` | 400 | 改派缺原因 |

**副作用**：`delivery_ticket.editor_id` 改为新值（不改步骤，不写状态历史）；改派（原来已有剪辑师）时写 `assignment_history` 一行（`source = ticket_editor`，`subject_type = delivery_ticket`，`from_staff_id` = 原负责人，`reason_code`、`note`）；首次指派不写（`from_staff_id` 非空），留痕在审计行；活动流审计（`action = delivery.ticket.assign_editor`）。不发出站事件（x01 的 `ticket.assigned` 只用于分配交付经理）；新剪辑师从工作台待办看到任务（a02），需要推送通知时请 x01 另登记事件。

**说明**：暂停中允许改派（不是工单子对象的写操作）。广告任务的剪辑师单独指派（3.54）。

### 3.22 admin.deliveryTicket.assignPublisher　改派发布专员

`POST /admin/delivery-tickets/{deliveryTicketId}/assign-publisher`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.ticket.assign_publisher`（交付经理、发布专员主管） |
| 幂等 | required |
| 乐观锁 | 不带；工单行锁 |
| 对应画板 | A:TicketDetail、A:Delivery（负责人位；表单原型未画） |
| 出处 | 路线图 `a05.delivery-tickets.assign-publisher`；d3-flow.md:993-994 |

**请求**：路径 `deliveryTicketId`；请求体 `AssignStaffBody`（同 3.21，`staffId` 须是启用的发布专员，`staff_role_key = publisher`，在操作人的员工集合内；候选取 `admin.staff.list?recommendPool=publisher&withLoad=true`，在办量取 `openWorkBySource` 里 `ticket_publisher` / `delivery_ticket` 的一项）。

**响应**：`DeliveryTicketDetail`（结果脱敏见 1.1）。

**错误**：同 3.21（`STATE_NOT_ALLOWED`、`ASSIGNEE_INVALID`、`VALIDATION_FAILED`）；与现任相同同样是 `ASSIGNEE_INVALID`（`same_as_current`）。

**副作用**：`delivery_ticket.publisher_id` 改为新值；改派时写 `assignment_history`（`source = ticket_publisher`），首次指派不写（同 3.21）；活动流审计；不发出站事件（同 3.21）。核验、巡检、下架核查的处理人读工单的 `publisher_id`，改派即随之转移（d3-flow.md:994）。

**说明**：发布专员在开工时已按池轮询指派（池为空时留空，进入成片交付时生成“待指派发布专员”待办），本接口用于首次指派与改派。

### 3.23 admin.deliveryTicket.remind　人工催办商家

`POST /admin/delivery-tickets/{deliveryTicketId}/remind`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`permission: assert-in-handler`：工单在调用者数据范围内，且调用者是本单的交付经理或发布专员（`golive` 场景），或是交付模块的主管；否则 403 `PERMISSION_DENIED` |
| 幂等 | required（对外发送的写接口，复核意见 69） |
| 乐观锁 | 不适用 |
| 对应画板 | A:TicketDetail（“催办商家”：确认方案、确认样片）；A:Calendar、A:Overdue（“提醒商家上线”，点后变“已提醒”并禁用） |
| 出处 | 路线图 `a05.delivery-tickets.remind`；d3-flow.md:1827-1833；13-notify-docs.md:612-642、141；proto-admin-a.md:172、319、434-435 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | 在范围内 | 工单 |

请求体（`TicketRemindBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `scene` | enum(`confirm_plan`,`confirm_sample`,`golive`) | 是 | 见说明的场景守卫 | 催办场景（`manual_reminder_log.scene`；路线图写的 `plan_confirm`、`sample_confirm` 按数据模型取值改名） |

**响应 `data`**（`AdminRemindResult`；与 a07 的续费补发结果不同构，另起名字）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `scene` | enum | 是 | 场景 | 请求 |
| `subjectType` | enum(`delivery_ticket`,`order_item`,`ad`) | 是 | 限频对象类型 | `manual_reminder_log.subject_type` |
| `subjectId` | string(uuid) | 是 | 限频对象 | `manual_reminder_log.subject_id` |
| `remindedAt` | string(date-time) | 是 | 催办时间 | `manual_reminder_log.created_at` |
| `nextAvailableDate` | string(date) | 是 | 下次可催办的日期（明天） | `biz_date` + 1 |

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `REMINDED_TODAY` | 409 | 同一对象同一场景今天已催办过（`uq_manual_reminder_log_subject_scene_biz_date`）；不发通知；通用码（C27，40920，A76），`details = { scene, nextAvailableDate }`（A131，与 `AdminRemindResult` 同名字段），端上按钮变“已提醒”、不重试 |
| `REMIND_NOT_APPLICABLE` | 409 | 场景与工单当前状态不符；`details.reason` |
| `PERMISSION_DENIED` | 403 | 不满足处理器内的判定 |

**副作用**（同一事务）

- 插入 `manual_reminder_log`：`confirm_plan`、`confirm_sample` 的 `subject_type = delivery_ticket`、`subject_id` = 本工单；`golive` 的 `subject_type = order_item`、`subject_id` = 本单订单项（`ck_manual_reminder_log_scene_subject`）；`biz_date` = 今天（北京时间），`sent_by_staff_id` = 本人。唯一冲突即返回 `REMINDED_TODAY`、整体回滚。
- 出站事件 `manual_reminder.sent`（聚合类型 `manual_reminder_log`，x01 事件目录），通知模块按场景映射派发：`confirm_plan` → `m.plan_pending`，`confirm_sample` → `m.sample_pending`，`golive` → `m.launch_remind`，节点 `M`，订阅消息 ＋ 短信补发（13-notify-docs.md:141）。
- 活动流审计（`action = delivery.ticket.remind`，“已通过订阅消息和短信提醒商家确认样片”）。

**说明**（场景守卫）

- `confirm_plan`：方案 `delivery_plan.status = pending_confirm`，工单在 `plan_confirm`，未暂停。
- `confirm_sample`：工单在 `sample_confirm`，当前样片 `pushed`，未暂停。
- `golive`：成片包已推送（工单在 `awaiting_launch` 或 `launch_verify`），且有未作废、未上线、`review_status` ∈ {`pending`,`need_fix`} 的上线任务；未交付的行显示“待成片交付”，不可催办。
- 原型写的“写日志、非幂等”按约定改为带键的 `required`：双击、重试复用同一个键时直接返回第一次的结果，不会因限频闸报 `REMINDED_TODAY`。

### 3.24 admin.deliveryTicket.rework　主管返工

`POST /admin/delivery-tickets/{deliveryTicketId}/rework`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.ticket.rework`（交付主管） |
| 幂等 | required |
| 乐观锁 | 不带；锁序：涉及的广告 `FOR SHARE` → 订购单 → 订单项 → 工单 → 样片与剧集（d3-flow.md:942） |
| 对应画板 | 原型无（A:TicketDetail 的主管操作；05-risks-and-open-issues.md 第 4 节“工单详情的大部分表单没有原型”） |
| 出处 | 路线图 `a05.delivery-tickets.rework`；10-delivery.md:181、649、730；d3-flow.md:843、1358 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | 在范围内 | 工单 |

请求体（`ReworkBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `reason` | string | 是 | 1–200 字 | 返工原因，落状态历史的 `note` 与审计 |

**响应**：`DeliveryTicketDetail`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 工单不在 `batch_compose` 或 `delivering` |
| `TICKET_ON_HOLD` | 409 | 工单暂停中 |
| `VALIDATION_FAILED` | 400 | 原因为空或超长 |

**副作用**（同一事务；10-delivery.md:181 第 10 行）

- `delivery_ticket.step`：`batch_compose` / `delivering` → `sample_making`（广告全部就绪）或 `ad_prep`（不就绪）（`ticket.rework`）；关旧开新环节、重设定时器。
- 解除本订单项各广告位的钉住（`order_item_placement.bound_version_no`、`pinned_at` 置空）。
- `sample.status`：`confirmed` → `superseded`（`sample.superseded`，10-delivery.md:649）。
- `episode_output`：当前且质检通过的行 → `replaced`、`is_current = false`（10-delivery.md:730）。
- 活动流审计；出站事件 `ticket.step_changed`（迁移键 `transition = ticket.rework`，返工报表按它识别；x01 的载荷没有 `rework` 字段）、被取代的样片 `sample.superseded`。

**说明**：成片包推送之后发现问题走补发（3.43），不走返工。已登记但未质检通过的剧集保持原状，返工后重新登记即换版（第 6 节第 6 项）。

### 3.25 admin.deliveryTicket.reevaluate　重新求值

`POST /admin/delivery-tickets/{deliveryTicketId}/reevaluate`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `flow.ops.manage`（增补表） |
| 幂等 | required（重放返回第一次的结果） |
| 乐观锁 | 不适用；按 `reevaluate()` 的锁序加锁并复核广告集合（d3-flow.md:996-1013） |
| 对应画板 | 原型无（流程运维页，05-risks-and-open-issues.md 第 4 节） |
| 出处 | 路线图 `a05.delivery-tickets.reevaluate`（原 `a01.delivery-tickets.reevaluate`，按资源归属移到本文，C10）；d3-flow.md:996-1022、3273-3288；10-delivery.md:168 |

**请求**：路径 `deliveryTicketId`（string(uuid)，在范围内）；请求体为空对象 `{}`。

**响应 `data`**（`ReevaluateResult`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `transitions` | array<{ `event`, `fromStep`, `toStep` }> | 是 | 本次求值发生的迁移（最多 4 轮）；没有迁移为空数组 | 本次写入的 `status_transition` |
| `skippedReason` | enum(`paused`,`terminal`) \| null | 是 | 跳过求值的原因：暂停中、已归档或已终止 | 计算 |
| `ticket` | `DeliveryTicketCard` | 是 | 求值后的工单 | 2.4 |

**错误**：`NOT_FOUND`。

**副作用**：按求值结果迁移 `delivery_ticket.step`（只走状态机表里标“系统求值”的行：第 2、3、8、9、12–15、15b、16 行）及其副作用，与定时器、订阅者触发的求值同一个 `reevaluate()`：

- 第 8 行（广告重新打开）：该工单“活着”的样片（`uploaded`、`qc_passed`、`pushed`）置 `superseded`（`sample.superseded`，10-delivery.md:648）。
- 第 15、15b 行（进入到期下架；15b 是从未上线、已过使用期止日）：同事务调 publish 收尾——未上线的上线任务 `launch.void`（`void_reason = usage_expired`），已上线停在核验中或需补充的 `launch.settle`，再 `ensureTakedownTasks`；第 15b 行另撤销下载授权（`download_grant` → `revoked`）；在办补发单的跟进关闭（10-delivery.md:198-204）。
- 有迁移时发 `ticket.step_changed`，及随之的 `sample.superseded`、`launch.voided`、`launch.settled`、`takedown.created`；没有迁移时不写库。

`ops` 流审计一行（`category = system_ops`，A107；`action = delivery.ticket.reevaluate`，`meta.transitions` 记本次迁移）。

**说明**：卡住的工单由补偿扫描每 5 分钟自动求值并告警（d3-flow.md:1022），本接口是人工补一次；`invariant_violation` 的处理标记不在这里写。

### 3.26 admin.deliveryTicket.forceTransition　人工纠偏

`POST /admin/delivery-tickets/{deliveryTicketId}/force-transition`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `flow.admin.transition`（增补表；默认只授予超级管理员，建议标再验证，d3-flow.md:3498）；回显 `confirm` |
| 幂等 | required |
| 乐观锁 | 不带；工单行锁 ＋ 白名单守卫 |
| 对应画板 | 原型无（流程运维页） |
| 出处 | 路线图 `a05.delivery-tickets.force-transition`（复核意见 42：原 `POST /admin/status-transitions` 改为针对对象的动作，动作词 `force-transition` 已由 A44 登记）；10-delivery.md:194；d3-flow.md:1024-1047；01-kernel-flow.md:476 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | 在范围内 | 工单 |

请求体（`ForceTransitionBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `toStep` | enum(4.3 `TicketStep`) | 是 | 与当前步骤构成白名单内的一对（见说明） | 目标步骤 |
| `note` | string | 是 | 10–200 字 | 纠偏原因，落 `status_transition.note` 与审计 |
| `newUsageEndDate` | string(date) | 条件 | `takedown → in_service` 时必填：晚于今天，不晚于剧目当前授权止日 | 版权续期合同晚于到期日补录时由操作人填写的新止日，落 `order_item.usage_end_date` |
| `confirm` | object `{ ticketNo: string, fromStep: string }` | 是 | 与当前值一致 | 二次确认回显 |

**响应**：`DeliveryTicketDetail`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `CORRECTION_NOT_ALLOWED` | 409 | （当前步骤, 目标步骤）不在白名单；或更正后结构性不变量（I1、I3、I5、I6 中相关的）不成立而整体回滚；`details.reason`、`allowedSteps`、`failedInvariants` |
| `CONFIRM_MISMATCH` | 409 | 回显的工单号或当前步骤不符 |
| `TICKET_ON_HOLD` | 409 | 工单暂停中（先处理暂停来源） |
| `VALIDATION_FAILED` | 400 | 原因不足 10 字；缺 `newUsageEndDate` 或越界 |

**副作用**（同一事务）

- `delivery_ticket.step`：当前 → `toStep`（`admin.force`，10-delivery.md:194），`status_transition.is_forced = true`；按新步骤关旧开新环节、重设定时器。
- `takedown → in_service` 时写 `order_item.usage_end_date`（`usage_end_source = license`）并同步未核查的下架任务（11-publish.md:670）。
- 从不调用账本（积分的纠正只能走调整或退回审批）。
- `ops` 流审计（`category = system_ops`，A107；动作 `delivery.ticket.force_transition`）；出站事件 `ticket.step_changed`（载荷 `isForced = true`，默认不通知商家）。

**说明**（V1.0 白名单，d3-flow.md:1041）：方案确认至成片交付（步骤 2～7）之间退到任一更靠前的步骤；`in_service → launch_verify`（超过撤销时限后的误核验）；`takedown → in_service`（版权续期补录）。白名单是代码常量 `ADMIN_CORRECTIONS`。

### 3.27 admin.deliveryTicket.material.list　制作素材清单

`GET /admin/delivery-tickets/{deliveryTicketId}/materials`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `delivery`（v）＋ 数据范围（剪辑师 `o` 级只看本人任务） |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | 原型无（工单“制作素材”页，d5-media.md:1194、1964） |
| 出处 | 路线图 `a05.delivery-tickets.materials.list`；06-media.md:805-840；A19（原“读即 upsert `master_checkout`”的写法取消） |

**请求**：路径 `deliveryTicketId`（string(uuid)，在范围内）。

**响应**：`MaterialList`。

**错误**：`NOT_FOUND`。

**副作用**：无（不签发地址、不写取料记录）。

**说明**：原片只列已提交批次中就绪的当前版本；参考素材分素材库（`storeAssets`）与门店档案媒体（`profileMedia`）两组列出；下载与取料留痕走 3.28。

### 3.28 admin.deliveryTicket.material.downloadUrls　签发制作素材下载地址

`POST /admin/delivery-tickets/{deliveryTicketId}/materials/download-urls`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.download`（交付经理、剪辑师、发布专员）；工单在数据范围内（剪辑师 `o` 级只限本人任务） |
| 幂等 | none（签发短时地址，结果不进幂等记录，A18） |
| 乐观锁 | 不适用 |
| 对应画板 | 原型无（“制作素材”页的逐文件下载与“下载到文件夹”） |
| 出处 | 路线图 `a05.delivery-tickets.materials.download-urls`（A19）；06-media.md:807；d5-media.md:1194；C61 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | 在范围内 | 工单 |

请求体（`MaterialDownloadBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `kind` | enum(`master`,`ad_version`,`store_asset`,`profile_media`) | 是 | — | 要哪类素材 |
| `episodeNos` | array<integer> | 条件 | `kind = master` 时必填；1–50 个，在 1..集数内 | 原片集号（一次可签多集） |
| `adVersionId` | string(uuid) | 条件 | `kind = ad_version` 时必填；须是 `MaterialList.ads` 里的版本 | 广告版本 |
| `storeAssetId` | string(uuid) | 条件 | `kind = store_asset` 时必填；须是 `MaterialList.storeAssets` 里的素材 | 门店素材 |
| `fileId` | string(uuid) | 条件 | `kind = profile_media` 时必填；须是 `MaterialList.profileMedia` 里的文件 | 门店档案媒体 |

**响应 `data`**（`MaterialDownloadResult`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `items` | array<{ `kind`, `episodeNo`: integer \| null, `fileId`, `fileName`, `sizeBytes`: string(bigint), `url`, `expiresAt` }> | 是 | 每个文件一条，30 分钟有效（员工下载原片，C61）；原片文件名按“剧名_第NN集_原片.mp4”签进下载头 | `drama_episode_master.file_id`；`ad_version.file_id`；`store_asset_file.file_id`；档案媒体为请求里的 `fileId`（`store_profile_media.file_id`）；`file_object.size_bytes` |

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `MATERIAL_NOT_AVAILABLE` | 409 | 某集没有就绪的当前原片；广告版本不在本单所用版本里；素材已删除或被拦截；`details.kind`、`details.reason` |
| `VALIDATION_FAILED` | 400 | 缺对应参数或集号越界 |
| `NOT_FOUND` | 404 | 工单不在范围内 |

**副作用**（同一事务）

- `kind = master`：逐集 upsert `master_checkout`（键 `(order_item_id, episode_no, staff_id)`，写 `drama_episode_master_id` = 当前原片版本、`checked_out_at`、`checkout_count + 1`），之后上传成片时据此认定所用原片版本（06-media.md:807）。
- 每个文件写一条访问流审计（`audit_log.stream = access`、`target_type = file_object`、`meta.fileCategory`、`meta.urlTtlSec`）。

**说明**：本员工取料窄口的门店素材与档案媒体下载地址固定 30 分钟（不沿通用图片窗口扩大有效期）。签名在事务外生成，之后在访问审计与原片取料同一事务中重新核对本人任务、父对象范围、当前集合和真实文件版本；任一变化拒绝返回地址。档案媒体已从档案移除（`store_profile_media.removed_at` 非空）但订购单仍引用的，照常签发。

### 3.29 admin.deliveryTicket.episodeOutput.list　成片剧集

`GET /admin/delivery-tickets/{deliveryTicketId}/episode-outputs`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `delivery`（v）＋ 数据范围 |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:TicketDetail（成片与发布）；A:Delivery（成片包“质检通过 45/45 · 3.1 GB”、逐集格子） |
| 出处 | 路线图 `a05.delivery-tickets.episode-outputs.list`；10-delivery.md:673-751；proto-admin-a.md:265 |

**请求**：路径 `deliveryTicketId`（string(uuid)，在范围内）。

**响应**：`EpisodeGrid`（一部剧至多 100 集左右，不分页）。

**错误**：`NOT_FOUND`。

**副作用**：无。

**说明**：格子的颜色：当前版本质检通过、最新修订待质检、最新修订不通过或体检拒收、在途补发的替换行；文件大小 `bigint` 出接口为字符串（C33）。

### 3.30 admin.deliveryTicket.episodeOutput.create　登记成片剧集

`POST /admin/delivery-tickets/{deliveryTicketId}/episode-outputs`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.episode.register`；普通剪辑师限本人任务，持有该权限的主管或超级管理员可在自身数据范围内代办；不认领或更改剪辑师 |
| 幂等 | required |
| 乐观锁 | 不带；工单行锁（同一集再登记即换版） |
| 对应画板 | A:TicketDetail（“上传成片（逐集）”，原型未画表单） |
| 出处 | 路线图 `a05.delivery-tickets.episode-outputs.create`（草案 `episodes:register`）；10-delivery.md:723、729；d3-flow.md:1549-1553、1672；d5-media.md:1964-1967 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | 本人任务 | 工单 |

请求体（`EpisodeRegisterBody`；`items` 与 `uploadBatchId` 二选一）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | array<object> | 条件 | 1–100 条，集号不重复 | 逐集登记 |
| `items[].episodeNo` | integer | 是 | 1..订购集数 | 集号 |
| `items[].fileId` | string(uuid) | 条件 | 与 `sampleId` 二选一；已入库（`stored`）、分类 `final_episode`、制作留痕属本订单项且 `kind = final`、集号与制作留痕一致；可以是规格化或补标的产物（制作留痕 `source` ∈ {`manual_upload`,`normalized`,`restamped`}） | 成片文件 |
| `items[].sampleId` | string(uuid) | 条件 | 只用于第 1 集：本单已确认的样片 | 样片采用为第 1 集（`source = sample_adopted`，不复制文件，d5-media.md:1966） |
| `items[].variant` | enum(`common`) | 否 | V1.0 只接受 `common` | 平台变体（M38） |
| `uploadBatchId` | string(uuid) | 条件 | 成片批次：`upload_batch.purpose = final_release`、`target_id` = 本订单项、`state = ready` | 批量登记：经 `media.consumeBatch()` 取条目的集号与文件（批次的建立、上传与续传在 a04-content 的 `admin.uploadBatch.*`，鉴权与制作上下文由本模块的 `delivery.authorizeUpload` 给，1.3） |
| `reissueId` | string(uuid) | 条件 | 本工单在途的补发单；集号须在 `episode_nos` 内 | 交付后补发的替换集 |
| `adoptedStoreAssetIds` | array<string(uuid)> | 否 | 本门店素材，`usability` 为 `ready` 或 `reference_only`；≤ 20 个 | 本次成片采用的门店素材，写“已采用”记录（06-media.md:1190） |

**响应 `data`**（`EpisodeRegisterResult`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `items` | array<`EpisodeOutputView`> | 是 | 新登记的行 | `episode_output` |

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `EPISODE_REGISTER_NOT_ALLOWED` | 409 | 步骤不允许登记：批量合成、成片交付（未推送）可直接登记与换版；待上线、上线核验、使用中只能带 `reissueId`；集号不在补发单范围内；`details.step`、`details.reason` |
| `TICKET_ON_HOLD` | 409 | 工单暂停中 |
| `FILE_NOT_USABLE` | 400 | 文件不可用（m03-profile-asset 定义，`details.reason` 按 m03 的取值）：未入库或已删除 `not_stored`；分类不是 `final_episode` `category_mismatch`；制作留痕不属本订单项、不是 `kind = final` 或集号不符 `context_mismatch`；被拦截 `blocked`；同一请求重复 `duplicate` |
| `PRODUCTION_NOT_READY` | 409 | 制作留痕已被体检拒收（`pipeline_state = rejected`，`details.gate = reject`）；入库或体检未完成的照常登记，等体检结论 |
| `BATCH_PURPOSE_MISMATCH` | 409 | `uploadBatchId` 是原片批次（`purpose = drama_master`），原片批次只能在 a04 提交（a04-content 定义，49215） |
| `STATE_NOT_ALLOWED` | 409 | 成片批次不在 `ready`（还在上传、体检，或已提交、已取消、已过期） |
| `PERMISSION_DENIED` | 403 | 调用者不是本单剪辑师 |
| `NOT_FOUND` | 404 | 批次不存在或目标不是本订单项 |
| `VALIDATION_FAILED` | 400 | `items` 与 `uploadBatchId` 同时给或都没给；集号越界或重复；采用的素材不属本门店或不可用 |

**副作用**（同一事务；10-delivery.md:723）

- 带 `uploadBatchId` 时先调 `media.consumeBatch()`：`upload_batch.state`：`ready` → `committed`，写 `committed_at`（06-media.md:529“成片：delivery 调 `media.consumeBatch()`”），批次对条目文件的引用随之释放；取到的条目按集号逐行登记。
- `episode_output`：每集插入一行，状态（新建）→ `uploaded`，`revision_no` = 该集该变体最大修订号 + 1，`is_current = false`，补发时写 `delivery_reissue_id`；`source` 按来源：样片采用 `sample_adopted`，其余按文件制作留痕的 `production_record.source` 照写 `manual_upload`、`normalized`（规格化产物）、`restamped`（补标产物）（10-delivery.md:689；A142）；文件引用登记（`file_ref`：`ref_type = episode_output`、`role = main`）。
- 非补发的登记即换版：同一集未决的旧修订 → `replaced`；在批量合成、成片交付两步里，旧的当前行 → `replaced` 并取消当前（先改旧行、再插新行）。补发登记不动当前版本。
- `adoptedStoreAssetIds`：逐个写 `store_asset_usage`（`used_by_type = order_item`、`used_by_id` = 本订单项、`role = adopted`，已有同键行跳过），media 同事务 `store_asset.adopted_count + 1` 并发 `asset.adopted`（06-media.md:1190；x01）。
- 成片的“所用原片版本”在制作留痕上按取料记录认定（06-media.md 2.9），本接口不另写。
- 活动流审计（逐集合并为一条“登记第 N–M 集”）。

**说明**：新登记的行须等 `media.production.checked(gate = pass)` 后才能质检；体检拒收时由订阅者置 `check_rejected`（10-delivery.md:724）。规格化、补标的产物（3.64、3.65）体检通过后，由剪辑师用本接口把产物的 `fileId` 登记为该集的新修订，重新质检（V1.0 不自动登记）。

### 3.31 admin.deliveryTicket.inspectEpisodes　逐集质检

`POST /admin/delivery-tickets/{deliveryTicketId}/inspect-episodes`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.episode.qc`（交付经理） |
| 幂等 | required |
| 乐观锁 | 不带；工单行锁 ＋ 版本行状态守卫 |
| 对应画板 | A:TicketDetail（质检清单逐项；不通过退回并注明原因，PRD 7.6(4)；原型未画成片质检表单） |
| 出处 | 路线图 `a05.delivery-tickets.inspect-episodes`（草案 `episodes:qc`）；10-delivery.md:725-728、180；d3-flow.md:1554-1556；d5-media.md:1987 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | 在范围内 | 工单 |

请求体（`InspectEpisodesBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `episodeOutputIds` | array<string(uuid)> | 是 | 1–100 个；本工单下、状态 `uploaded`、是该集最新修订 | 本次质检的行 |
| `checklistVersionNo` | integer | 是 | `qc.episode` 当前启用版本 | 清单版本 |
| `defaultResults` | array<{ `key`, `result`, `note` }> | 是 | 同 `ChecklistResultInput.results` | 默认结论，作用于全部行 |
| `defaultRejectReason` | string | 条件 | 默认结论含 `fail` 时必填，1–200 字 | 默认的不通过原因 |
| `exceptions` | array<{ `episodeOutputId`, `results`, `rejectReason` }> | 否 | `episodeOutputId` 属 `episodeOutputIds`；`results` 全量覆盖默认结论；含 `fail` 时 `rejectReason` 必填 | 个别集的例外 |

**响应 `data`**（`InspectEpisodesResult`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `results` | array<{ `episodeOutputId`, `episodeNo`, `verdict`, `qcRecordId` }> | 是 | 逐行结论 | `qc_record` |
| `ticket` | `DeliveryTicketCard` | 是 | 质检后的工单（全部通过且成片包级质检已过时已进入成片交付） | 2.4 |

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 某行不是 `uploaded`；工单不在批量合成或成片交付，且该行也不是在途补发单的替换行 |
| `EPISODE_NOT_LATEST` | 409 | 某行不是该集的最新修订（质检只能作用于最新修订，d5-media.md:1987）；`details` 带最新行 |
| `PRODUCTION_NOT_READY` | 409 | 某行的文件体检未通过或未完成（`production_record.pipeline_state ≠ ready`） |
| `QC_SELF_INSPECTION` | 409 | 参数 `qc.episode.four_eyes` 为真且质检人是上传人 |
| `CHECKLIST_VERSION_STALE` | 409 | 清单版本不是当前启用版本 |
| `TICKET_ON_HOLD` | 409 | 工单暂停中 |
| `VALIDATION_FAILED` | 400 | 结论不全、`fail` 无说明、`na` 用在不允许的条目上、缺不通过原因 |

**副作用**（同一事务）

- 每行插入一条 `qc_record`（`target_type = episode_output`、`checklist_code = qc.episode`、`results`、`verdict`、`reject_reason`、质检人与时间）。
- `episode_output`：通过 → `qc_passed`；非补发行同时置当前（同集旧的当前行先置 `replaced`），补发替换行保持 `is_current = false`；不通过 → `qc_rejected`；回写 `qc_record_id`。
- 之后 `reevaluate`：批量合成且当前有效剧集数 = 订购集数、全部通过、成片包级质检已过 → `delivery_ticket.step` `batch_compose` → `delivering`（`episodes.all_passed`，10-delivery.md:180 第 9 行），写 `composed_at`，建发布清单行（`publish_list`，进入成片交付时创建），无发布专员时生成“待指派发布专员”待办。
- 出站事件：迁移时 `ticket.step_changed`；有不通过的行时发一条 `ticket.episode_qc_failed`（聚合为工单，载荷 `{ deliveryTicketId, orderItemId, episodeNos, qcRecordIds }`，通知剪辑师；x01 3.10）。

**说明**：质检人是否须不同于上传人由参数 `qc.episode.four_eyes` 定，默认否（d3-flow.md:1554）。清单里“AI 隐式标识”一项由制作留痕的 `aigc_state` 自动判定，前端预填、服务端复核。

### 3.32 admin.deliveryTicket.inspectPackage　成片包级质检

`POST /admin/delivery-tickets/{deliveryTicketId}/inspect-package`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.episode.qc`（交付经理） |
| 幂等 | required |
| 乐观锁 | 不带；工单行锁 |
| 对应画板 | A:TicketDetail（质检清单第 5 项“成片包集数完整”，标注“批量合成后检查”） |
| 出处 | 路线图 `a05.delivery-tickets.inspect-package`（草案 `/tickets/{id}/package-qc`）；10-delivery.md:763、799、180；d3-flow.md:1506、1555 |

**请求**：路径 `deliveryTicketId`；请求体（`InspectPackageBody`）为 `ChecklistResultInput`（`qc.package` 的当前版本）加 `rejectReason`（string，含 `fail` 时必填，1–200 字）。

**响应 `data`**（`InspectPackageResult`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `qcRecord` | `QcRecordView` | 是 | 本次质检记录 | `qc_record` |
| `ticket` | `DeliveryTicketCard` | 是 | 质检后的工单 | 2.4 |

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 工单不在 `batch_compose` |
| `CHECKLIST_VERSION_STALE` | 409 | 清单版本不是当前启用版本 |
| `TICKET_ON_HOLD` | 409 | 工单暂停中 |
| `VALIDATION_FAILED` | 400 | 结论不全或缺原因 |

**副作用**：插入 `qc_record`（`target_type = delivery_ticket`、`target_id` = 本工单、`checklist_code = qc.package`）；之后 `reevaluate`，满足第 9 行即 `delivery_ticket.step` `batch_compose` → `delivering`（同 3.31）。

**说明**：“成片包级质检通过”= 该工单最近一条 `target_type = delivery_ticket` 的记录 `verdict = pass`（10-delivery.md:799）。

### 3.33 admin.deliveryTicket.pushPackage　推送成片包与发布清单

`POST /admin/delivery-tickets/{deliveryTicketId}/push-package`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.package.push`（发布专员；注册表另含交付经理） |
| 幂等 | required；请求头的幂等键同时落 `delivery_release.idempotency_key`（`uq_delivery_release_order_item_id_idempotency_key`） |
| 乐观锁 | 不带；工单行锁（发布清单的锁版本由 a06 的保存接口管，推送时读当前值） |
| 对应画板 | A:Delivery（交付前检查 4 项全勾才可推送；“推送后只读；工单进入待上线；生成上线任务；通知商家；下载链接 7 天有效”） |
| 出处 | 路线图 `a05.delivery-tickets.push-package`（原 `a06.delivery-tickets.push-package`，按资源归属移到本文，C10、复核意见 44）；10-delivery.md:182、880；11-publish.md:299、653；d3-flow.md:1637-1661；proto-admin-a.md:266、280；设计规范 11 节（整包下载引导到电脑端） |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | 在范围内 | 工单 |

请求体（`PushPackageBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `precheck` | `ChecklistResultInput` | 是 | `delivery.precheck` 当前版本；全部条目须为 `pass` 或允许的 `na` | 交付前检查（集数完整且与订购一致、文件按集命名并与清单对应、清单已填写、发布账号与授权书一致），落 `delivery_release.precheck_results` |
| `ackAbnormalAccount` | boolean | 否 | 有被手动标记异常的发布账号时须为 `true` | 确认账号异常不影响交付（d3-flow.md:1644） |
| `note` | string | 否 | ≤ 200 字 | 推送说明，落 `delivery_release.note` |

**响应 `data`**（`PushPackageResult`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `release` | `ReleaseAdminView` | 是 | 新成片包 | `delivery_release` |
| `grantExpiresAt` | string(date-time) | 是 | 下载授权到期（“下载链接 7 天有效”） | `download_grant.expires_at` |
| `launchTaskCount` | integer | 是 | 生成的上线任务数 | `launch_task` |
| `ticket` | `DeliveryTicketCard` | 是 | 推送后的工单（待上线） | 2.4 |

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `PACKAGE_PUSH_BLOCKED` | 409 | 守卫不通过；`details.blockers` 逐项列出（见 5 节） |
| `CHECKLIST_NOT_PASSED` | 400 | 交付前检查没有全部通过：缺结论、有不通过项、在不允许的条目上填了不适用（a01-system 定义，A77、C28） |
| `CHECKLIST_VERSION_STALE` | 409 | 交付前检查清单版本已变 |
| `STATE_NOT_ALLOWED` | 409 | 工单不在 `delivering` |
| `TICKET_ON_HOLD` | 409 | 工单暂停中 |

**副作用**（同一事务；10-delivery.md:182 第 11 行）

- `delivery_release`：（新建）→ `pushed`（`kind = initial`，`release_no` 递增，`manifest_snapshot` 取各集当前版本并按“剧名_第NN集.mp4”命名，`publish_list_text` 按发布清单渲染，`checklist_code = delivery.precheck`）；同订单项上一个 `pushed` 的包（返工后再次推送时）先置 `superseded` 并作废其 ZIP 缓存；清单内文件登记引用（`file_ref`：`ref_type = delivery_release`、`role = ep`）。
- 预打包：同事务调 `media.ensureZip`（与 a06 `admin.deliveryRelease.pack` 同一个调用）：`zip_bundle`（新建）→ `building`，建打包任务（06-media.md:962“或推送时预打包”；x01 06:962-970）；打包在事务外异步进行，失败不影响推送，下载时按 C65 重试（A99）。
- `download_grant`：（新建）→ `active`（`actor_type = system`，`valid_days` 取参数 `package.link_ttl_days` 的快照，`expires_at` = 现在 + 天数）。
- `launch_task`：每个发布账号一行（新建）→ `pending`（`launch.create`，11-publish.md:299）。
- `delivery_ticket.step`：`delivering` → `awaiting_launch`（`package.pushed`），首次推送写 `delivered_at`；`order_item.phase`：`producing` → `to_launch`；订购单重新推导。
- 定时器（以订单项为主体，01 分组 3.3）：`usage.end`；`takedown.create`（已在 30 天窗口内则不登记，直接 `ensureTakedownTasks`，同时登记各下架任务的 `takedown.overdue`）。上线提醒、下架提醒是纯提醒，不建定时器行（R6）。
- 出站事件 `package.delivered`（通知商家：订阅消息 ＋ 短信）、`launch.created`、`ticket.step_changed`、`order.status_changed`；30 天窗口内直接建下架任务时 `takedown.created`；`docs.ensureLetters` 补建授权书时 `license_letter.revision_queued`。

**说明**

- 守卫（d3-flow.md:1641-1644）：工单在成片交付、未暂停；当前有效剧集数 = 订购集数且全部质检通过，成片包级质检通过；今天未过使用期止日；发布清单完整（合集名称、封面、简介已填，每集能得到非空标题，话题至少 1 个；清单本身由 a06-publish 编辑）；交付前检查全部通过（否则 400 `CHECKLIST_NOT_PASSED`）；每个发布账号未解绑且有未作废的授权书（同事务调 `docs.ensureLetters` 先对齐再判断），约定上线日已确定；被手动标记异常的账号要求 `ackAbnormalAccount = true`，并通知交付经理与商家处理账号。
- ZIP 在推送时预打包（与 x01、a06 对齐，初稿“首次请求整包时才打包”的写法作废）；商家或下载页请求整包时仍经 `media.ensureZip` 取，打包中返回“打包中”（10-delivery.md:888）；小程序内逐集保存，整包引导到电脑端下载页（设计规范 11 节）。
- 成片交付页跨文档引用本 operationId（a06-publish）。

### 3.34 admin.deliveryPlan.get　交付方案

`GET /admin/delivery-plans/{deliveryPlanId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `delivery`（v）＋ 数据范围（门店） |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:TicketDetail（交付方案区与“配置方案”，配置表单原型未画，05-risks-and-open-issues.md:270） |
| 出处 | 路线图 `a05.delivery-plans.get`（草案 `GET /delivery/orders/{id}/plan/draft`）；10-delivery.md:360-540；d3-flow.md:3524 |

**请求**：路径 `deliveryPlanId`（string(uuid)，在范围内；从工单详情 `plan.deliveryPlanId` 或订购单详情取）。

**响应**：`AdminDeliveryPlanDetail`。

**错误**：`NOT_FOUND`。

**副作用**：无。

**说明**：方案按订购单一份，同单各工单共用；`itemWindows` 告诉前端哪些剧此刻还能改内容或账号（确认后的变更窗口，d3-flow.md:1167-1172）。

### 3.35 admin.deliveryPlan.draft.replace　保存方案草稿

`PUT /admin/delivery-plans/{deliveryPlanId}/draft`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.plan.edit`（交付经理） |
| 幂等 | required（带锁版本的 PUT，A17） |
| 乐观锁 | 带 `draftLockVersion`（C52 的例外列 `delivery_plan.draft_lock_version`，`UPDATE … WHERE draft_lock_version = ?`，d3-flow.md:1160） |
| 对应画板 | 原型无（方案配置表单：植入形式与广告位、定制重点、发布账号、约定上线日、上线方式） |
| 出处 | 路线图 `a05.delivery-plans.draft.replace`；10-delivery.md:371-372；d3-flow.md:1092-1106、1160 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryPlanId` | string(uuid) | 是 | 在范围内 | 方案（单例子资源 `…/draft` 是登记过的别名，`resources.json`） |

请求体（`PlanDraftReplaceBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `draftLockVersion` | integer | 是 | 等于当前 `draft_lock_version` | 草稿锁版本 |
| `content` | `PlanContentInput` | 是 | 见 2.5 | 整份草稿（整体替换） |

**响应**：`AdminDeliveryPlanDetail`（`draftLockVersion` 已加 1）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VERSION_CONFLICT` | 409 | `draftLockVersion` 不符（“内容已被他人修改，请刷新”）；`details.draftLockVersion` 为最新值 |
| `VALIDATION_FAILED` | 400 | 结构不合法：订单项不属本单或重复、同平台多个账号、广告位重复、定制重点为空或编码无效 |

**副作用**：`delivery_plan.draft` 整体替换、`draft_lock_version + 1`（不是状态迁移，不写状态历史）；活动流审计（只记变更的项名，不记全文）。

**说明**：草稿保存不受订购单售后状态限制；业务校验在推送时做（3.36），保存时只做结构校验，便于交付经理分步填写。

### 3.36 admin.deliveryPlan.push　推送方案

`POST /admin/delivery-plans/{deliveryPlanId}/push`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.plan.push`（交付经理） |
| 幂等 | required |
| 乐观锁 | 带 `draftLockVersion`：守卫要求请求带的草稿版本号等于 `draft_lock_version`（10-delivery.md:417；A21；复核意见 29） |
| 对应画板 | 原型无（方案配置后的“推送商家确认”）；商家端 M:Plan 收到 |
| 出处 | 路线图 `a05.delivery-plans.push`；10-delivery.md:413-423、338；d3-flow.md:1128、1150-1156、1163-1174 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryPlanId` | string(uuid) | 是 | 在范围内 | 方案 |

请求体（`PlanPushBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `draftLockVersion` | integer | 是 | 等于当前值 | 推送的就是这一版草稿 |
| `changeSummary` | string | 否 | ≤ 200 字 | 相对上一版的变更摘要，落 `delivery_plan_version.change_summary` |

**响应**：`AdminDeliveryPlanDetail`（`status = pending_confirm`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `ORDER_IN_AFTER_SALE` | 409 | 订购单有在途取消申请（m05-delivery-publish 定义；10-delivery.md:413） |
| `VERSION_CONFLICT` | 409 | `draftLockVersion` 不符 |
| `PLAN_CONTENT_INVALID` | 409 | 内容校验不通过；`details.issues` 逐条给出 |
| `LAUNCH_DATE_OUT_OF_RANGE` | 400 | 约定上线日早于“订购日后第 7 个工作日”或晚于使用期止日 |
| `PLAN_CHANGE_WINDOW_CLOSED` | 409 | 从已确认修订（或修订周期内再推）时，改动超出该剧的变更窗口 |

**副作用**（同一事务；10-delivery.md:417、421）

- `delivery_plan.status`：`drafting` / `revising` / `pending_confirm` / `confirmed` → `pending_confirm`（`plan.push`）；`current_version_no + 1`，写 `pushed_at`，清 `staff_due_at`。
- 插入 `delivery_plan_version`（`content_snapshot` = 当前草稿，`pushed_by_staff_id` = 本人）；上一个未决版本 `decision` 置 `superseded`（`decide_actor_type = system`）；未解决的修改请求写 `resolved_by_version_no`。
- 从已确认修订、以及修订周期内的每次推送：对受影响的工单加入暂停原因 `plan_amendment`（引用新版本，`ticket.hold`），该方案原有未解除的 `plan_amendment` 以 `release_event = superseded` 解除（先加后解，10-delivery.md:338-340）。
- 处于方案确认的工单 `waiting_on` 改为 `merchant`。
- 出站事件 `plan.pushed`（通知商家）、加暂停时 `ticket.held`。

**说明**（内容校验，d3-flow.md:1150-1156）

- 每个未取消的订单项都有一行；每行至少 1 个广告位，且都在该剧允许的植入形式内（`drama_snapshot.allowedPlacements`）。
- 广告属于该门店、未取消、无在途取消，类型与广告位一致；广告此时不要求已确认。
- 账号属于该门店、状态 `available`、每平台至多 1 个、至少 1 个。
- 约定上线日已填，不早于订购日后第 7 个工作日、不晚于 `usage_end_date`；早于 `delivery_target_at` 时允许，但在响应的方案里由前端提示。
- 该订购单所有工单都已离开待分配。
- 已确认后的修订：定制重点、参考素材、补充说明、植入形式、所用广告只能在该剧工单不晚于样片确认时改；发布账号只能在成片包推送前改；约定上线日改期走 3.37，不走方案版本。

### 3.37 admin.orderItem.rescheduleLaunch　改约定上线日

`POST /admin/order-items/{orderItemId}/reschedule-launch`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.plan.reschedule` |
| 幂等 | required |
| 乐观锁 | 不带；订单项行锁 |
| 对应画板 | 原型无（A:TicketDetail、A:Calendar、A:Overdue 的“改期”入口） |
| 出处 | 路线图 `a05.order-items.reschedule-launch`（草案 `POST /delivery/order-items/reschedule`）；d3-flow.md:1171、1354；09-order-ad.md:275；11-publish.md:745 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderItemId` | string(uuid) | 是 | 在范围内 | 订单项 |

请求体（`RescheduleLaunchBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `agreedLaunchDate` | string(date) | 是 | 不早于今天与订购日后第 7 个工作日，不晚于 `usage_end_date`；与当前值不同 | 新的约定上线日 |
| `reason` | string | 是 | 1–200 字 | 改期原因（如“成片晚于约定上线日交付，与商家改期”） |

**响应**：`AdminOrderItemRow`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `LAUNCH_DATE_LOCKED` | 409 | 首个账号已核验上线（`usage_start_date` 非空），或订单项不在制作中、待上线 |
| `LAUNCH_DATE_OUT_OF_RANGE` | 400 | 日期越界；`details.minDate`、`details.maxDate` |
| `VALIDATION_FAILED` | 400 | 与当前值相同；原因为空 |

**副作用**（同一事务）

- `order_item.agreed_launch_date` 改为新值；方案草稿里该订单项的 `agreedLaunchDate` 同步改写（`delivery_plan.draft`，`draft_lock_version + 1`），避免下一次推送把旧日期带回。不生成方案版本（d3-flow.md:1171）。
- 审计行（a06 的近 30 天逾期指标据此还原改期前的约定上线日，a06-publish.md:1178）：`stream = activity`、`category = delivery`、`action = delivery.order_item.reschedule_launch`、`target_type = order_item`、`target_id` = 本订单项、`store_id`、`entity_id`；`before = { agreedLaunchDate: 旧值 }`、`after = { agreedLaunchDate: 新值 }`；`meta = { orderItemId, deliveryTicketId, prevDate, newDate }`（日期为 `YYYY-MM-DD`）；`reason_text` = 改期原因。
- 出站事件 `order.item.launch_rescheduled`（聚合 `order_item`，不是状态迁移，x01 E3；载荷 `{ orderItemId, dramaOrderId, prevDate, newDate }`，不带原因文本，P5），通知商家新的上线日。初稿的 `item.launch_rescheduled` 违反 x01 前缀规则 N3，按 `order.item.` 前缀改名（x01 3.9）。
- 上线提醒与逾期跟踪是按约定上线日派生的纯提醒（11-publish.md:745），没有定时器要取消或重登，按新日期自然生效。

**说明**：只改订单项的事实；工单步骤不变。成片晚于约定上线日交付时逾期跟踪标 `late_delivery` 提醒交付经理改期（d3-flow.md:1816），改期即本接口。

### 3.38 admin.deliveryTicket.sample.create　登记样片新版本

`POST /admin/delivery-tickets/{deliveryTicketId}/samples`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.sample.upload`；普通剪辑师限本人任务，持有该权限的主管或超级管理员可在自身数据范围内代办；不认领或更改剪辑师 |
| 幂等 | required |
| 乐观锁 | 不带；工单行锁（`uq_sample_live` 保证同一工单至多一个“活着”的版本） |
| 对应画板 | A:TicketDetail（“上传样片”：先经 `admin.file.create` 直传拿到 `fileId`，原型未画表单） |
| 出处 | 路线图 `a05.delivery-tickets.samples.create`；10-delivery.md:640、648；d3-flow.md:1519；d5-media.md:1965 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | 本人任务 | 工单 |

请求体（`SampleCreateBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `fileId` | string(uuid) | 是 | 已入库、分类 `sample_video`；制作留痕 `kind = sample`、属本订单项、未被体检拒收 | 样片原版文件 |
| `adSlots` | array<{ `slot`: enum(`opening`,`ending`), `startMs`: integer, `endMs`: integer, `label`: string }> | 是 | `slot` 不重复且属本订单项的广告位；`0 ≤ startMs < endMs`；`label` ≤ 20 字 | 广告位标记（商家端进度条与“植入位置”），落 `sample.ad_slots` |

**响应**：`AdminSampleView`（`status = uploaded`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 工单不在 `sample_making` |
| `TICKET_ON_HOLD` | 409 | 工单暂停中 |
| `FILE_NOT_USABLE` | 400 | 文件不可用（m03 定义）：未入库 `not_stored`、分类不是 `sample_video` `category_mismatch`、制作留痕不属本订单项或不是 `kind = sample` `context_mismatch`、被拦截 `blocked` |
| `PRODUCTION_NOT_READY` | 409 | 制作留痕已被体检拒收（入库或体检未完成的照常登记） |
| `PERMISSION_DENIED` | 403 | 调用者不是本单剪辑师 |
| `VALIDATION_FAILED` | 400 | 广告位标记不合法 |

**副作用**（同一事务）

- 该工单未决的旧版本（`uploaded`、`qc_passed`）先置 `superseded`（`sample.superseded`，10-delivery.md:648），再插入新版本：`sample.status`（新建）→ `uploaded`（`sample.uploaded`，10-delivery.md:640），`version_no` = 最大版本号 + 1，`uploaded_by_staff_id` = 本人。
- `sample.ad_versions_used`：按本订单项各广告位取所用版本——制作留痕上声明的片头、片尾广告版本（`production_record.head_ad_version_id`、`tail_ad_version_id`）优先，没有则取钉住版本或广告当前确认版本。
- 文件引用登记（`file_ref`：`ref_type = sample`、`role = main`）。
- 活动流审计；出站事件 `sample.uploaded`（通知交付经理去质检）、旧版本被取代时 `sample.superseded`。

**说明**：时长 `duration_ms` 在体检通过时由订阅者回写；体检拒收时版本置 `check_rejected`（10-delivery.md:641）。

M1（W1-16a）同步桩只处理匹配上下文的人工上传、已入库且 AI 未使用的记录；时长与尺寸取已有 `media_info`，不从 ready 状态推造元数据。没有真实时长的样片保持 `uploaded`；质检以 `PRODUCTION_NOT_READY` 拒绝且不追加 QC、状态历史、审计或事件。M3（G3-A）接真实体检与订阅者回补，样片播放桩当前档位指向原文件，不代表水印已生成。

### 3.39 admin.sample.inspect　样片质检

`POST /admin/samples/{sampleId}/inspect`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.sample.qc`（交付经理）；质检人不能是上传人 |
| 幂等 | required |
| 乐观锁 | 不带；样片行锁 ＋ 状态守卫 |
| 对应画板 | A:TicketDetail（样片与质检：清单逐项，通过或不通过并注明原因） |
| 出处 | 路线图 `a05.samples.inspect`（草案 `/samples/{id}/qc`）；10-delivery.md:642-643；d3-flow.md:1494-1511、1520；05-risks-and-open-issues.md:186 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `sampleId` | string(uuid) | 是 | 在范围内 | 样片版本 |

请求体（`SampleInspectBody`）：`ChecklistResultInput`（`qc.sample` 当前版本；PRD 的 7 项，做成可配置）加 `rejectReason`（string，含 `fail` 时必填，1–200 字）。

**响应**：`AdminSampleView`（`status` 为 `qc_passed` 或 `qc_rejected`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 样片不是 `uploaded`，或工单不在样片制作 |
| `PRODUCTION_NOT_READY` | 409 | 文件体检未通过或未完成 |
| `QC_SELF_INSPECTION` | 409 | 质检人是上传人（d3-flow.md:1520） |
| `CHECKLIST_VERSION_STALE` | 409 | 清单版本已变 |
| `TICKET_ON_HOLD` | 409 | 工单暂停中 |
| `VALIDATION_FAILED` | 400 | 结论不全、`fail` 无说明、缺原因 |

**副作用**：插入 `qc_record`（`target_type = sample`、`checklist_code = qc.sample`）；`sample.status`：`uploaded` → `qc_passed`（`sample.qc_passed`）或 `qc_rejected`（`sample.qc_failed`），同一条 UPDATE 写 `qc_record_id`；出站事件 `sample.qc_passed` 或 `sample.qc_failed`（不通过时工单留在样片制作，通知剪辑师）。

**说明**：向商家展示的质检结果取 `merchantVisible = true` 的条目（d3-flow.md:1511）；“AI 隐式标识”一项按 `production_record.aigc_state` 自动判定（d5-media.md:1965）。

### 3.40 admin.sample.markSent　登记已经企业微信发送

`POST /admin/samples/{sampleId}/mark-sent`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.sample.push`（交付经理） |
| 幂等 | required（写入确认守卫要用的证据，复核意见 47） |
| 乐观锁 | 不带；样片行锁 |
| 对应画板 | A:TicketDetail（推送弹窗之外的“已经企业微信发送水印版”登记；原型未画） |
| 出处 | 路线图 `a05.samples.mark-sent`（草案 `/samples/{id}/offline-sent`）；10-delivery.md:563-564、605；d3-flow.md:1535 |

**请求**：路径 `sampleId`（string(uuid)，在范围内）；请求体为空对象 `{}`。

**响应**：`AdminSampleView`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 样片不是 `qc_passed` 或 `pushed` |
| `TICKET_ON_HOLD` | 409 | 工单暂停中 |

**副作用**：`sample.offline_sent_at` = 现在、`offline_sent_by_staff_id` = 本人（同一条 UPDATE，`ck_sample_offline_sent`）；已登记过的不覆盖、直接返回当前值；活动流审计。

**说明**

- 先在后台下载带明水印的样片版本（取 `AdminSampleView.watermark.fileId` 调 `admin.file.downloadUrls`，留痕；水印版未就绪时按钮置灰），经企业微信发给老板，再点“已发送”（d3-flow.md:1535）。企业微信联系人是老板与本单交付经理之间的（`isWecomAdded`），所以登记人是交付经理。
- `wecom` 是否列为查看方式在推送时定（`preview_channels` 推送后不改）；推送后再登记只作证据，不会给商家增加查看方式。推送弹窗里也可以一并登记（3.41 的 `markWecomSent`）。
- 企业微信发送能否作为确认证据待法务（B4；第 6 节第 1 项）。

### 3.41 admin.sample.push　推送样片

`POST /admin/samples/{sampleId}/push`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.sample.push`（交付经理） |
| 幂等 | required |
| 乐观锁 | 不带；锁序：涉及的广告 `FOR SHARE` → 订购单 → 订单项 → 工单 → 样片（d3-flow.md:942） |
| 对应画板 | A:TicketDetail（“推送商家”；渠道“小程序订阅消息与短信”） |
| 出处 | 路线图 `a05.samples.push`；10-delivery.md:644、175、562；d3-flow.md:837、1532-1536；设计规范 11 节（Q9 一期仅小程序内查看） |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `sampleId` | string(uuid) | 是 | 在范围内 | 样片版本 |

请求体（`SamplePushBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `includeWecom` | boolean | 否 | 缺省 false；Q9 true 返回 VALIDATION_FAILED | 历史字段保留，新推送不接受企业微信查看渠道 |
| `markWecomSent` | boolean | 否 | 缺省 false；Q9 true 返回 VALIDATION_FAILED | 推送不再兼带线下发送登记；历史字段/记录保留 |
| `legacyRecovery` | object | 否 | `{ versionNo: 正整数, reason: 10–200字, quality: SampleInspectBody }` | 显式恢复当前无 weapp 的历史待确认版本；要求推送及质检权限、操作人非原上传人，质检按当前模板重新填写且须通过 |

**响应**：`AdminSampleView`（`status = pushed`）与 `replayed`。历史恢复返回新样片的 `sampleId` / `versionNo`，不是路径中的旧版本；同幂等键重放返回原新版本，不重复创建。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 普通推送不是 `qc_passed + sample_making`；历史恢复不是当前最新无 weapp 的未决 `pushed + sample_confirm`，或已有决定、工单/订单不可操作 |
| `AD_CHANGED` | 409 | 样片所用广告版本已不是各广告当前确认版本，或有广告位尚未就绪（m05-delivery-publish 定义）；`details.adIds` |
| `VALIDATION_FAILED` | 400 | includeWecom 或 markWecomSent 为 true；Q9 仅 weapp |
| `FEATURE_DISABLED` | 403 | 样片开关关闭 |
| `SAMPLE_PREVIEW_NOT_READY` | 409 | 真正水印版未 ready 或派生文件未 stored |
| `TICKET_ON_HOLD` | 409 | 工单暂停中 |
| `SAMPLE_VERSION_STALE` | 409 | 恢复请求版本不是当前版本 |
| `QC_SELF_INSPECTION` | 409 | 恢复操作人是原上传人 |
| `CHECKLIST_VERSION_STALE` / `CHECKLIST_NOT_PASSED` | 409 | 恢复质检未使用当前模板，或有缺失、不通过或非法不适用项 |
| `FILE_NOT_USABLE` | 400 | 源文件、制作记录或水印归属与工单不符 |

**副作用**（同一事务）

- `sample.status`：`qc_passed` → `pushed`（`sample.pushed`，10-delivery.md:644），同一条 UPDATE 写 `pushed_by_staff_id`、`pushed_at`、`preview_channels = [weapp]`；关停拒绝、不得写入相册/portal/企业微信查看渠道。
- `delivery_ticket.step`：`sample_making` → `sample_confirm`（`sample.pushed`，10-delivery.md:175 第 4 行），写 `current_sample_version_no`、首次推送写 `sample_first_pushed_at`，`waiting_on = merchant`；关旧开新环节（样片确认没有员工时限）。
- 出站事件 `sample.pushed`（载荷带 `deliveryTicketId`、`dramaOrderId`；通知商家：订阅消息 ＋ 短信）、`ticket.step_changed`。推送后 2 个自然日未处理的提醒是纯提醒，由通知规则派生，不建定时器行（R6）。

**说明**：Q9 新推送仅 weapp，推送前核真正水印版 ready/stored。关闭开关不提供替代查看渠道；历史推送快照不回改，不自动迁移。显式 `legacyRecovery` 在广告、工单、当前版本、源质检及真实水印核验通过后，将旧版经 `sample.superseded` 失效；复用原文件和广告快照创建下一版本，经 uploaded → qc_passed → pushed 写独立质检、状态历史及恢复原因审计，新快照仅 weapp。工单 sample_confirm 自循环只更新当前版本，不重置环节、轮次、首次推送或 SLA；新版本不继承查看/决定证据。普通推送不隐式走恢复。独立 markSent 仅作沟通记录；通用返工、商家修改意见与广告重开仍由 W5 后继实现。

### 3.42 admin.sample.requestChange　代录样片修改意见

`POST /admin/samples/{sampleId}/request-change`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.sample.feedback_on_behalf`（交付经理） |
| 幂等 | required |
| 乐观锁 | 不带；锁序：广告 `FOR UPDATE`（广告内容类）→ 订购单 → 订单项 → 工单 → 样片 |
| 对应画板 | A:TicketDetail（“代录修改意见”弹窗：修改类型单选（合成问题·不计次 / 广告内容·计入广告修改次数）、意见必填 ≤ 200 字；提交后退回样片制作，重新制作时限 1 个工作日） |
| 出处 | 路线图 `a05.samples.request-change`（A9：`request-revision` 改 `request-change`；草案 `POST /tickets/{id}/sample-feedback`）；10-delivery.md:646-647、177-178；09-order-ad.md:807；d3-flow.md:839-840、1325；A59 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `sampleId` | string(uuid) | 是 | 在范围内 | 样片版本 |

请求体（`AdminSampleRequestChangeBody`；与 m05 的商家端请求体不同构，另起名字）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `versionNo` | integer | 是 | 等于本行版本号且是当前已推送版本 | 针对的版本 |
| `feedbackKind` | enum(`compose`,`ad_content`) | 是 | 后台可选 `ad_content`（A59） | 修改类型，落 `sample.feedback_kind` |
| `adId` | string(uuid) | 条件 | `ad_content` 时必填；须是本样片所用广告之一 | 要改的广告 |
| `note` | string | 是 | 1–200 字 | 修改意见，落 `sample.feedback_note`；广告内容类同时落 `ad_revision.note` |
| `feedbackTimeMs` | integer | 否 | ≥ 0 | 指向的时间点 |
| `feedbackFileIds` | array<string(uuid)> | 否 | 0–3 个，已入库、分类 `ticket_attachment` | 截图，落 `sample.feedback_file_ids`（登记 `file_ref` 角色 `feedback`） |

**响应**：`AdminSampleView`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `SAMPLE_VERSION_STALE` | 409 | `versionNo` 不是当前已推送版本（m05-delivery-publish 定义） |
| `STATE_NOT_ALLOWED` | 409 | 样片不是 `pushed`，或工单不在 `sample_confirm`；广告内容类时广告不在待确认或已确认 |
| `AD_FREE_REVISION_EXHAUSTED` | 409 | 广告内容类而该广告的免费修改次数已用完（要扣积分的只能由商家在“我的广告”提出） |
| `AD_CANCEL_IN_PROGRESS` | 409 | 广告有在途取消（m06-ad 定义） |
| `TICKET_ON_HOLD` | 409 | 工单暂停中 |
| `VALIDATION_FAILED` | 400 | 缺 `adId`、意见为空、截图超限 |

**副作用**（同一事务）

- 合成问题：`sample.status`：`pushed` → `change_requested`（`sample.change_requested`，10-delivery.md:646），同一条 UPDATE 写 `decided_at`、`decide_client = admin`、`on_behalf_staff_id` = 本人与修改意见各列；`delivery_ticket.step`：`sample_confirm` → `sample_making`（第 6 行），`sample_round_no + 1`，样片制作环节时限 1 个工作日；通知剪辑师。
- 广告内容：`sample.status`：`pushed` → `superseded`（第 7 行对应的 `sample.change_requested`，10-delivery.md:647），同样写决定与意见各列；插入 `ad_revision`（`source = sample_feedback`、`actor_type = staff`、`client = admin`、`is_chargeable = false`、`on_version_no` 取样片所用版本、`due_at` = 1 个工作日）；`ad.status`：`pending_confirm` / `confirmed` → `revising`（`ad.request_revision`，09-order-ad.md:807），`revision_count + 1`，写 `due_at`、`sla_snapshot`，登记 `sla.breach`（键 `sla.breach:ad:{id}:rev:{revision_no}`）；广告在待确认时最新版本 `decision` 置 `revision_requested`；本工单 `sample_confirm` → `ad_prep`（第 7 行）；广告审计行带 `meta.versionNo`、`meta.revisionNo`（1.1“广告的审计行”）。
- 广告重新打开对其他工单的影响（`ad.reopened`，10-delivery.md:179 第 8 行，经同事务的 `reevaluate()`）：浮动绑定该广告、在样片制作或样片确认、未暂停的其他工单 → `ad_prep`，它们“活着”的样片（`uploaded`、`qc_passed`、`pushed`）置 `superseded`（`sample.superseded`，10-delivery.md:648）。暂停中的工单不求值，恢复后补求值时同样处理。
- 出站事件 `sample.change_requested`（载荷带 `deliveryTicketId`、`dramaOrderId`、`feedbackKind`）、`ticket.step_changed`（本工单）；广告内容类另发 `ad.revision_requested`，受影响的其他工单各发 `ticket.step_changed`，被取代的样片各发 `sample.superseded`。

**说明**：员工代录不会让商家被扣积分：广告内容类只在还有免费次数时允许（d3-flow.md:1325）。商家端只能提“合成问题”（A31），广告内容的修改到“我的广告”提出。

### 3.43 admin.deliveryTicket.reissue.create　发起补发

`POST /admin/delivery-tickets/{deliveryTicketId}/reissues`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.package.reissue`（交付经理或主管；增补表） |
| 幂等 | required |
| 乐观锁 | 不带；工单行锁 ＋ 部分唯一索引 `uq_delivery_reissue_open` |
| 对应画板 | 原型无（交付后发现成片有误的补发入口，05-risks-and-open-issues.md:228） |
| 出处 | 路线图 `a05.delivery-tickets.reissues.create`；10-delivery.md:920-983、962；d3-flow.md:1665-1681 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | 在范围内 | 工单 |

请求体（`ReissueCreateBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `episodeNos` | array<integer> | 是 | ≥ 1 个，不重复，在 1..集数内 | 计划替换的集 |
| `reasonCode` | string | 是 | 字典 `reissue_reason` 的启用编码 | 补发原因 |
| `note` | string | 是 | 1–200 字 | 补发说明 |

**响应**：`ReissueView`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `REISSUE_NOT_ALLOWED` | 409 | 工单不在待上线、上线核验或使用中；已过使用期；已有在途补发单（`details.openReissueId`） |
| `TICKET_ON_HOLD` | 409 | 工单暂停中 |
| `VALIDATION_FAILED` | 400 | 集号越界、原因编码无效、说明为空 |

**副作用**：`delivery_reissue`（新建）→ `open`（`opened_by_staff_id` = 本人、`opened_at`）；工单步骤不变（补发动作在状态历史里记在工单上：`delivery_ticket` 写一行 `from_state = to_state`，迁移事件码 `reissue.opened`，10-delivery.md:195、922；它是状态历史的事件码，不是出站事件名，x01 N4）；活动流审计；出站事件 `package.reissue_opened`（聚合 `delivery_reissue`，前缀 `package.` 按 x01 2.2 指 `delivery_release`、`delivery_reissue`；载荷 `{ deliveryReissueId, deliveryTicketId, orderItemId, episodeNos, reasonCode }`；通知剪辑师；初稿的 `reissue.opened` 违反 N3，已改名，x01 3.10）。

**说明**：替换集经 3.30 带 `reissueId` 登记、经 3.31 质检，发布前商家下载到的仍是旧的已通过版本（d3-flow.md:1672）。

### 3.44 admin.reissue.cancel　取消补发

`POST /admin/reissues/{reissueId}/cancel`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.package.reissue`，且调用者是发起人或主管（处理器内判定），否则 403 `PERMISSION_DENIED` |
| 幂等 | required |
| 乐观锁 | 不带；工单行锁 |
| 对应画板 | 原型无 |
| 出处 | 路线图 `a05.reissues.cancel`；10-delivery.md:964、729 |

**请求**：路径 `reissueId`（string(uuid)，所属工单在范围内）；请求体（`ReissueCancelBody`）`{ note?: string }`（≤ 200 字，记入审计）。

**响应**：`ReissueView`（`status = cancelled`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 补发单不是 `open` |
| `PERMISSION_DENIED` | 403 | 不是发起人也不是主管 |

**副作用**：`delivery_reissue.status`：`open` → `cancelled`，写 `closed_at`；该补发单下的替换行（`uploaded`、`qc_passed`、`qc_rejected`）→ `replaced`（10-delivery.md:729）；工单写一行 `from_state = to_state` 的状态历史（事件 `reissue.cancelled`，10:1377）；活动流审计。

**说明**：取消不影响商家当前可下载的成片包。

### 3.45 admin.reissue.publish　发布补发

`POST /admin/reissues/{reissueId}/publish`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.package.push`（发布专员） |
| 幂等 | required |
| 乐观锁 | 不带；工单 → 成片包 → 剧集行锁 |
| 对应画板 | A:TicketDetail、A:Delivery（原型未画补发的发布按钮） |
| 出处 | 路线图 `a05.reissues.publish`；10-delivery.md:963-968、880-881、728；d3-flow.md:1674-1681 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `reissueId` | string(uuid) | 是 | 所属工单在范围内 | 补发单 |

请求体（`ReissuePublishBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `precheck` | `ChecklistResultInput` | 是 | `delivery.precheck` 当前版本，全部通过 | 交付前检查（每次推送与补发都要过，10-delivery.md:909） |
| `note` | string | 否 | ≤ 200 字 | 补发说明（默认取补发单的说明），落 `delivery_release.note` |

**响应 `data`**（`ReissuePublishResult`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `reissue` | `ReissueView` | 是 | 已发布的补发单 | `delivery_reissue` |
| `release` | `ReleaseAdminView` | 是 | 新成片包（`kind = reissue`） | `delivery_release` |

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `REISSUE_INCOMPLETE` | 409 | 补发单里有集还没有质检通过的替换行；`details.missingEpisodeNos` |
| `PACKAGE_PUSH_BLOCKED` | 409 | 已过使用期（`usage_ended`） |
| `CHECKLIST_NOT_PASSED` | 400 | 交付前检查没有全部通过（a01-system 定义，A77、C28） |
| `STATE_NOT_ALLOWED` | 409 | 补发单不是 `open` |
| `CHECKLIST_VERSION_STALE` | 409 | 清单版本已变 |
| `TICKET_ON_HOLD` | 409 | 工单暂停中 |

**副作用**（同一事务；10-delivery.md:966-968）

- `episode_output`：旧的当前行 → `replaced`、取消当前；替换行置当前（先改旧行、再改新行，10-delivery.md:728）。
- `delivery_release`：旧的 `pushed` 包 → `superseded`（写 `superseded_at`，作废 ZIP 缓存，清单引用保留 30 天）；新包（新建）→ `pushed`（`kind = reissue`、`changed_episode_nos` = 补发集号、`reason_code`、`note`）。
- `download_grant`：旧授权 → `superseded`；新授权（新建）→ `active`，重新计期。
- `publish_list_episode.changed_in_release_no` 对应集写新的推送序号（商家端“已更新”）。
- `delivery_reissue.status`：`open` → `published`，写 `published_delivery_release_id`、`closed_at`；工单写一行 `from_state = to_state` 的状态历史（事件 `package.reissued`，10:195）。
- 该订单项已有上线任务通过核验时，写一条系统跟进待办 `follow_up`（`subject_type = delivery_reissue`，`channel = system`，`next_follow_at` = 现在，`owner_staff_id` = 门店交付经理，“补发后确认商家已替换”）。
- 出站事件 `package.reissued`（通知商家：“第 12、15 集已更新，请重新下载；已发布的请替换”，订阅消息 ＋ 短信）。

**说明**：补发全过程中“当前有效剧集数 = 订购集数且全部质检通过”始终成立（10-delivery.md:734）。

### 3.46 admin.orderItem.download.list　成片包、下载授权与下载记录

`GET /admin/order-items/{orderItemId}/downloads`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `delivery`（v）＋ 数据范围 |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:TicketDetail、A:OrderDetail（成片下载情况，“商家已保存 45 / 80”；排障与证据） |
| 出处 | 路线图 `a05.order-items.downloads.list`（草案 `/order-items/{id}/download-history`）；10-delivery.md:815-1119；d5-media.md:2115 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderItemId` | string(uuid) | 是 | 在范围内 | 订单项 |
| 查询 | `kind` | enum(`episode`,`zip`,`publish_list`) | 否 | — | 下载记录按内容筛选 |
| 查询 | `episodeNo` | integer | 否 | ≥ 1 | 下载记录按集筛选 |
| 查询 | `page`、`pageSize` | integer | 否 | `pageSize` ≤ 100 | 只对下载记录分页 |

**响应 `data`**（`DownloadHistory`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `releases` | array<`ReleaseAdminView`> | 是 | 全部成片包，按推送序号倒序 | `delivery_release`（`order_item_id`） |
| `grants` | array<object> | 是 | 下载授权：`{ downloadGrantId, deliveryReleaseId, state, expiresAt, isExpired, validDays, actorType, client, revokeReason, endedAt, createdAt }` | `download_grant` 同名列；`isExpired = now ≥ expires_at` |
| `logs` | `AdminPage<object>` | 是 | 下载记录（倒序）：`{ downloadId, deliveryReleaseId, kind, episodeNo, actorType, actorName, client, urlTtlSec, clientAck, clientAckAt, createdAt }` | `delivery_download_log.id`、`delivery_release_id`、`kind`、`episode_no`、`actor_type`、`actor_id`（商家取主体内称呼，员工取姓名）、`client`、`url_ttl_sec`、`client_ack`、`client_ack_at`、`created_at` |

**错误**：`NOT_FOUND`。

**副作用**：无。

**说明**：下载记录包括商家小程序（`client = weapp`）、电脑端下载页（`client = portal`）与员工后台（`client = admin`，`actorType = staff`）三种来源；整包 `zip` 与发布清单 `publish_list` 两类记录只来自下载页（p01-portal）。下载记录的 IP 与 UA 不返回（个人信息，排障需要时查访问审计）；`seq` 不出接口。

### 3.47 admin.orderItem.licenseLetter.list　订单项的授权书

`GET /admin/order-items/{orderItemId}/license-letters`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `order`（v）＋ 数据范围 |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:OrderDetail（协议与授权书：《定制内容授权书》× 2，每部剧 × 每个账号一份，“已生成”；“下载授权书”） |
| 出处 | 路线图 `a05.order-items.license-letters.list`；13-notify-docs.md:887-1058；d6-notify-docs-data.md:2257；proto-admin-b.md:216、224 |

**请求**：路径 `orderItemId`（string(uuid)，在范围内）；可选查询 `includeVoided`（boolean，缺省 true）。

**响应 `data`**（`LicenseLetterList`）：`{ items: array<AdminLicenseLetterView> }`（每个账号至多一封未作废的信加历史作废的，有界小集合、不分页；已登记在 C43 的不分页清单，A139）。

**错误**：`NOT_FOUND`。

**副作用**：无。

**说明**：下载 PDF 经 `admin.file.downloadUrls`（a01-system，按文件分类 `legal` 判权，5 分钟，逐次写访问审计，A19、A57），传 `currentRevision.fileId` 或某个历史版次的 `fileId`；授权书文件含统一社会信用代码明文，按敏感文件对待（13-notify-docs.md:1158）。

### 3.48 admin.licenseLetter.correct　更正并重出

`POST /admin/license-letters/{licenseLetterId}/correct`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `order.license_letter.manage`（增补表） |
| 幂等 | required |
| 乐观锁 | 不带；锁订单项 → 信件（13-notify-docs.md:951） |
| 对应画板 | 原型无（A:OrderDetail 授权书区的“更正并重出”） |
| 出处 | 路线图 `a05.license-letters.correct`（A26，复核意见 50）；13-notify-docs.md:951-953、983、1036；d6-notify-docs-data.md:1307 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `licenseLetterId` | string(uuid) | 是 | 在范围内 | 授权书 |

请求体（`LicenseLetterCorrectBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `correctionKinds` | array<enum(`licensee_name`,`store_name`,`account_name`,`other`)> | 是 | ≥ 1 项 | 更正的要素（主体更名、门店更名、账号名笔误、其他），记入审计 |
| `note` | string | 是 | 1–200 字 | 更正原因 |

**响应**：`AdminLicenseLetterView`（新版次 `renderStatus = queued`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 授权书已作废 |
| `LICENSE_LETTER_UNCHANGED` | 409 | 按当前事实生成的快照与最新版次内容指纹相同（源数据还没改，没有可更正的内容） |
| `VALIDATION_FAILED` | 400 | 缺更正要素或原因 |

**副作用**（同一事务）

- 调对齐函数，按当前事实重建 `letter_snapshot`，插入 `license_letter_revision`（新建）→ `queued`（`reason = correction`，`rev_no` = 最大 + 1，`trigger_ref` 为人工操作号），出站事件 `license_letter.revision_queued`；编号、验真码、状态、使用期都不变。
- `ops` 流审计（`category = docs`，带 `correctionKinds` 与原因；`docs` 已按 A155 补进 03 分组的审计类别清单）。

**说明**：更正不改业务事实本身：主体名称、门店名称、账号名称须先在各自的资源上改好（档案、渠道账号），本接口只重出文件。主体或门店名称变更后是否自动换版待法务（13-notify-docs.md 第 6 节第 2 项）。

### 3.49 admin.licenseLetter.void　作废并重出

`POST /admin/license-letters/{licenseLetterId}/void`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `order.license_letter.manage`（增补表） |
| 幂等 | required |
| 乐观锁 | 不带；锁订单项 → 信件 |
| 对应画板 | 原型无 |
| 出处 | 路线图 `a05.license-letters.void`；13-notify-docs.md:947、953；d6-notify-docs-data.md:2257 |

**请求**：路径 `licenseLetterId`（string(uuid)，在范围内）；请求体（`LicenseLetterVoidBody`）`{ note: string }`（1–200 字，作废原因）。

**响应 `data`**（`LicenseLetterVoidResult`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `voided` | `AdminLicenseLetterView` | 是 | 已作废的信 | `license_letter` |
| `reissued` | `AdminLicenseLetterView` \| null | 是 | 同一事务重建的新信（新编号、新验真码、首版排队）；账号已不在选定集合内时为空 | `license_letter` |

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 已作废 |
| `VALIDATION_FAILED` | 400 | 原因为空 |

**副作用**（同一事务）

- `license_letter.status`：`pending_effective` / `effective` → `voided`（人工作废并重出，`void_reason = manual`，写 `voided_at`，13-notify-docs.md:947）。
- 随即调对齐函数：账号仍在选定集合内时为同一“订单项 × 账号”建新信（`letter_no` 追加序号、新 `verify_code`），插入 `initial` 版次（`queued`），出站事件 `license_letter.revision_queued`。
- `ops` 流审计（`category = docs`，同 3.48）；出站事件 `license_letter.voided`。

**说明**：用途是让已流出的授权书（验真链接外泄、文件被改用）失效并换发；内容有误走更正（3.48）。作废后是否不再自动重出待定（13-notify-docs.md 第 6 节第 6 项，默认重出）。

### 3.50 admin.licenseLetterRevision.rerender　重新生成授权书版次

`POST /admin/license-letter-revisions/{licenseLetterRevisionId}/rerender`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `order.license_letter.manage`（增补表） |
| 幂等 | required |
| 乐观锁 | 不带；带原状态条件的单行 UPDATE |
| 对应画板 | 原型无（授权书区“生成失败 · 重新生成”） |
| 出处 | 路线图 `a05.license-letter-revisions.rerender`；13-notify-docs.md:1041 |

**请求**：路径 `licenseLetterRevisionId`（string(uuid)，所属信件在范围内）；请求体为空对象 `{}`。

**响应**：`LicenseLetterRevisionView`（`renderStatus = queued`）。

**错误**：`STATE_NOT_ALLOWED`（409，版次不是 `failed`）。

**副作用**：`license_letter_revision.render_status`：`failed` → `queued`，`render_attempt_no` 置 0、`render_lease_until` 清空（重新给满 4 次机会）；出站事件 `license_letter.revision_queued`（`docs.onRevisionQueued` 据此放入渲染队列）；活动流审计。

**说明**：签署驱动是“只贴印章图样”而参数 `docs.license.allow_stamp_only` 未开时，渲染任务不认领、停在排队（13-notify-docs.md:1037），这不是失败，不能用本接口处理。

### 3.51 admin.ad.list　广告制作任务队列

`GET /admin/ads`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `delivery`（v；剪辑师 `o` 级只看 `editor_id` 为本人的任务）＋ 数据范围；未指派的只对待分配池的主管与所属门店的交付经理可见 |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:AdTasks（三个页签；紧急的排前；点选切换右侧详情） |
| 出处 | 路线图 `a05.ads.list`；09-order-ad.md:683、736；d3-flow.md:3528；proto-admin-a.md:208-235 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum(`todo`,`pending_confirm`,`confirmed`,`returned`,`cancelled`,`all`) | 否 | 缺省 `todo` | 页签：`todo` = 待指派 ＋ 制作中 ＋ 修改中（A24） |
| 查询 | `q` | string | 否 | 1–40 字 | 广告编号或商家名 |
| 查询 | `editorId` | string(uuid) \| `none` | 否 | — | 剪辑师；`none` = 待指派 |
| 查询 | `type` | enum(`opening`,`ending`) | 否 | — | 类型 |
| 查询 | `storeId` / `entityId` | string(uuid) | 否 | — | 商家 |
| 查询 | `overdueOnly` | boolean | 否 | — | 只看已过 `due_at` 的 |
| 查询 | `isWaitingQualification` | boolean | 否 | — | 只看等待资质审核的待指派任务 |
| 查询 | `isReturnedStale` | boolean | 否 | — | 只看待补充超期的（工作台待办 `ad_returned_stale` 的预置筛选，口径见 1.3） |
| 查询 | `sort` | enum(`urgency`,`-submittedAt`,`dueAt`) | 否 | 缺省 `urgency`（已超时 → 今日截止 → `due_at` 升序；`ix_ad_status_due_at`） | 排序 |
| 查询 | `page`、`pageSize` | integer | 否 | `pageSize` ≤ 100 | — |

**响应**：`AdminPage<AdTaskCard>`。

**错误**：`VALIDATION_FAILED`。

**副作用**：无。

**说明**：页签计数由 `admin.ad.summary` 给（A23、A26）；队列页每 30 秒静默刷新计数（d7-platform.md:1052）。

### 3.52 admin.ad.summary　广告任务页签计数

`GET /admin/ads/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | 同 3.51（剪辑师 `o` 级只计本人任务） |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:AdTasks（页签计数“待处理、待商家确认、已确认”） |
| 出处 | 路线图 `a05.ads.summary`（A26、A23；复核意见 70）；proto-admin-a.md:212 |

**请求**：查询参数与 3.51 相同，去掉 `tab`、`sort`、`page`、`pageSize`。

**响应**：`AdSummary`。

**错误**：`VALIDATION_FAILED`。

**副作用**：无。

### 3.53 admin.ad.get　广告任务详情

`GET /admin/ads/{adId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `delivery`（v）＋ 数据范围 |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:AdTasks（右侧详情：需求、关联工单、积分、修改次数、预览、版本与修改记录）；A:TicketDetail（广告视频区跳转）；A:ServiceDetail |
| 出处 | 路线图 `a05.ads.get`；09-order-ad.md:677-1000；proto-admin-a.md:214-224 |

**请求**：路径 `adId`（string(uuid)，在范围内）。

**响应**：`AdTaskDetail`。

**错误**：`NOT_FOUND`。

**副作用**：无（预览地址随数据返回，不写访问记录，A19）。

**说明**：“超出后每次扣 45 积分（专业版）”按商家当前订阅周期的单价与折扣算（d3-flow.md:1310），本接口不返回现价；需要时前端按 `pricing` 的快照提示“以商家提交时的价目为准”（第 6 节第 7 项）。

### 3.54 admin.ad.assign　指派剪辑师

`POST /admin/ads/{adId}/assign`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.ad.assign`（交付经理或主管） |
| 幂等 | required（指派即扣积分，防重复扣减） |
| 乐观锁 | 不带；事务开头对剪辑师员工行 `FOR SHARE` 并校验启用，再锁广告行 |
| 对应画板 | A:AdTasks（“确认指派”：单选剪辑师，默认推荐在办最少者；指派后进入制作中，首版 2 个工作日） |
| 出处 | 路线图 `a05.ads.assign`；09-order-ad.md:770、802；07-billing-ledger.md:844；d3-flow.md:1284、1293-1295；05-risks-and-open-issues.md:187 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `adId` | string(uuid) | 是 | 在范围内 | 广告 |

请求体（`AdAssignBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `staffId` | string(uuid) | 是 | 启用的剪辑师（`staff_role_key = editor`），在操作人的员工集合内 | 剪辑师；候选取 `admin.staff.list?recommendPool=editor&withLoad=true`，“进行中 N 条”取 `openWorkBySource` 里 `ad_editor` / `ad` 的一项（a01 2.5；路线图原写的 `recommendFor` 已取消） |

**响应**：`AdTaskDetail`（`status = producing`；结果脱敏见 1.1）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 广告不是 `pending_assign` |
| `AD_WAITING_QUALIFICATION` | 409 | 门店资质未通过（`profile.storeGate ≠ full`）；资质未通过不指派、不扣减（d3-flow.md:1295） |
| `ASSIGNEE_INVALID` | 409 | 未启用（`not_active`）、不是剪辑师（`role_mismatch`）、不在操作人的员工集合内（`out_of_scope`）；`details = { staffId, reason }` |
| `AD_CANCEL_IN_PROGRESS` | 409 | 广告有在途取消（m06-ad 定义） |
| `ACCOUNT_BUSY` | 503 | 积分账户锁等待超时（m07-billing 定义，可重试） |

**副作用**（同一事务）

- `ad.status`：`pending_assign` → `producing`（`ad.assign`，09-order-ad.md:802），同一条 UPDATE 写 `editor_id`、`captured_at`（`ck_ad_assign_capture`）。
- `billing.capture`：`point_hold.status` `held` → `captured`（07-billing-ledger.md:844），写账本操作与流水（`ledger_operation.op_type = capture`）。
- 不写 `assignment_history`：首次指派没有原负责人（`from_staff_id` 非空）。
- 迁移审计行 `action = ad.assign`（商家端时间线“剪辑师开始制作”，1.1）；出站事件 `ad.assigned`（通知剪辑师），账本发 `billing.points.captured`。首版时限仍按提交（或补充）时刻起算，不因指派重算。

**说明**：指派即开始制作、即扣减，不另设“开始”动作（05-risks-and-open-issues.md:187）。V1.0 不提供广告剪辑师的单独改派入口（离职、调岗经员工移交，a01-system），见第 6 节第 8 项。

### 3.55 admin.ad.return　退回补充素材

`POST /admin/ads/{adId}/return`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.ad.return`（剪辑师、交付经理；剪辑师限本人任务） |
| 幂等 | required |
| 乐观锁 | 不带；广告行锁 |
| 对应画板 | 原型无（PRD 6.4.2 有，proto-admin-a.md:248） |
| 出处 | 路线图 `a05.ads.return`；09-order-ad.md:771、803；d3-flow.md:1285、1390 |

**请求**：路径 `adId`；请求体（`AdReturnBody`）`{ reason: string }`（1–200 字，落 `ad.return_reason`，商家端可见）。

**响应**：`AdTaskDetail`（`status = returned`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 广告不是 `pending_assign` 或 `producing` |
| `AD_CANCEL_IN_PROGRESS` | 409 | 有在途取消 |
| `PERMISSION_DENIED` | 403 | 剪辑师退回非本人的任务 |
| `VALIDATION_FAILED` | 400 | 原因为空或超长 |

**副作用**（同一事务；09-order-ad.md:771）

- `ad.status`：`pending_assign` / `producing` → `returned`（`ad.return`），同一条 UPDATE 写 `returned_from`、`returned_at`、`return_reason`，`due_at`、`sla_snapshot` 置空；取消首版时限定时器 `sla.breach`。
- 登记定时器 `ad.returned_stale`（退回满 `ad.returned_stale_days` 个自然日，默认 7，生成客服待办“广告待补充素材超期”）。
- 迁移审计行 `action = ad.return`、`reason_text` = 退回原因（商家端时间线读它，1.1）。
- 出站事件 `ad.returned`（载荷 `{ adId, returnedFrom }` ＋迁移键，通知商家补充）。退回原因是自由文本，不进载荷（x01 P5）；x01 目录里该事件的 `reasonCode` 没有来源列（`ad.return_reason` 是文本），已请 x01 删去。

**说明**：商家补充后重新提交（`m.ad.submit`，m06-ad）回到 `returned_from`，不重复冻结。

### 3.56 admin.ad.adVersion.create　登记广告版本

`POST /admin/ads/{adId}/ad-versions`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.ad.upload`（剪辑师，本人任务：调用者须是 `ad.editor_id`） |
| 幂等 | required |
| 乐观锁 | 不带；广告行锁（`uq_ad_version_ad_id_undecided`：同一时刻至多一个未决版本） |
| 对应画板 | A:AdTasks（“上传第 N 版”：竖屏 9:16、1080×1920、须标注“广告”；上传后按钮变“第 N 版已上传”） |
| 出处 | 路线图 `a05.ads.ad-versions.create`（A26：登记与推送拆成两步；A5：嵌套集合改 `ad-versions`）；09-order-ad.md:843-923、908；d5-media.md:1247 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `adId` | string(uuid) | 是 | 本人任务 | 广告 |

请求体（`AdVersionCreateBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `fileId` | string(uuid) | 是 | 经 `admin.file.create` 上传、分类 `ad_video`、已入库；制作留痕 `kind = ad`、`ad_id` = 本广告、`pipeline_state = ready`；可以是规格化或补标的产物（3.64、3.65） | 视频文件 |
| `segments` | array<{ `index`, `fromMs`, `toMs`, `label` }> | 否 | `index` 从 0 连续；`0 ≤ fromMs < toMs ≤ 时长`；`label` ≤ 20 字 | 分段（“标题与价格”），供商家选时间段提修改；登记后不可改 |
| `adoptedStoreAssetIds` | array<string(uuid)> | 否 | 本门店素材，`usability` 为 `ready` 或 `reference_only` | 本版采用的门店素材，写“已采用”记录 |

**响应**：`AdTaskDetail`（新版本未推送；结果脱敏见 1.1）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 广告不是 `producing` 或 `revising` |
| `AD_CANCEL_IN_PROGRESS` | 409 | 有在途取消 |
| `FILE_NOT_USABLE` | 400 | 文件不可用（m03 定义）：未入库 `not_stored`、分类不是 `ad_video` `category_mismatch`、制作留痕不属本广告或不是 `kind = ad` `context_mismatch`、被拦截 `blocked` |
| `PRODUCTION_NOT_READY` | 409 | 文件体检未完成或未通过（时长、宽高取探测结果） |
| `PERMISSION_DENIED` | 403 | 调用者不是本广告的剪辑师 |
| `VALIDATION_FAILED` | 400 | 分段不合法；素材不可用 |

**副作用**（同一事务）

- 旧的未决版本（上传后未推送的）`ad_version.decision` 置 `superseded`、写 `decided_at`（09-order-ad.md:908）。
- 插入 `ad_version`：`version_no = ad.latest_version_no + 1`，`duration_ms`、`width`、`height` 取 `media_info`，`segments`，`uploaded_by_staff_id` = 本人；`ad.latest_version_no + 1`；广告状态不变（本表没有状态机，09-order-ad.md:900）。
- 文件引用登记（`file_ref`：`ref_type = ad_version`、`role = main`）；`adoptedStoreAssetIds` 写 `store_asset_usage`（`used_by_type = ad_version`、`role = adopted`），media 发 `asset.adopted`。
- 活动流审计。

**说明**：规格（竖屏 9:16、1080×1920、时长与类型相符）在推送守卫里校验（3.58），不合规的可先“云端规格化”（3.64）。广告版本的可播放资产（`playable_asset`：`kind = ad`、`owner_type = ad`、`source_file_id` = 版本文件）由 media 在文件入库与体检时建立并置 `ready`（d5-media.md:1980），本接口不写。

### 3.57 admin.adVersion.markSent　登记广告版本已经企业微信发送

`POST /admin/ad-versions/{adVersionId}/mark-sent`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.sample.push`（交付经理；与样片的“已发送”登记同一类线下提供，不另设新键）；广告所属门店在数据范围内 |
| 幂等 | required（写入确认守卫要用的证据） |
| 乐观锁 | 不带；广告行锁 |
| 对应画板 | A:AdTasks（原型未画） |
| 出处 | 路线图 `a05.ad-versions.mark-sent`（A26，复核意见 52）；09-order-ad.md:862-864、889；A97 |

**请求**：路径 `adVersionId`（string(uuid)，所属广告在范围内）；请求体为空对象 `{}`。

**响应**：`AdminAdVersionView`（结果脱敏见 1.1）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 版本已有决定，或广告已取消 |
| `AD_CANCEL_IN_PROGRESS` | 409 | 有在途取消 |

**副作用**：`ad_version.offline_sent_at` = 现在、`offline_sent_by_staff_id` = 本人（同一条 UPDATE，`ck_ad_version_offline_sent`）；已登记的不覆盖；活动流审计（不进商家端时间线）。

**说明**

- 谁登记：企业微信联系人是老板与门店交付经理之间的（`DeliveryTicketDetail.merchant.isWecomAdded`），数据模型写明“已发送”由交付经理单独登记、不随推送迁移写（09-order-ad.md:904），员工只能补 `wecom`（09-order-ad.md:862），所以登记人是交付经理；推送仍由剪辑师本人（3.58，09-order-ad.md:805）。
- 广告视频不加水印（A97）：发给老板的就是版本文件本身（交付经理经 `admin.file.downloadUrls` 下载，留痕）。
- `preview_channels` 含 `wecom` 时 `offline_sent_at` 必有，所以须在剪辑师带 `includeWecom` 推送之前登记（3.58）。

### 3.58 admin.adVersion.push　推送广告版本

`POST /admin/ad-versions/{adVersionId}/push`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.ad.upload`（剪辑师，本人任务） |
| 幂等 | required |
| 乐观锁 | 不带；广告行 `FOR UPDATE` |
| 对应画板 | A:AdTasks（“推送商家确认”：未上传时禁用；推送后进入待商家确认，2 天后自动提醒） |
| 出处 | 路线图 `a05.ad-versions.push`（A26）；09-order-ad.md:805、904；d3-flow.md:1287、1532-1543；proto-admin-a.md:233 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `adVersionId` | string(uuid) | 是 | 所属广告在范围内 | 广告版本 |

请求体（`AdVersionPushBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `includeWecom` | boolean | 否 | 缺省 false；为 true 时该版本须已由交付经理登记“已发送”（3.57） | 是否把企业微信列为查看方式 |

**响应**：`AdTaskDetail`（`status = pending_confirm`；结果脱敏见 1.1）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 广告不是 `producing` 或 `revising`；该版本不是最新、已推送或已有决定 |
| `AD_VERSION_SPEC_INVALID` | 409 | 规格不符：不是竖屏 9:16、不是 1080×1920、时长与类型不符（片头 3–5 秒、片尾 5–10 秒，±0.5 秒）或文件未就绪；`details.checks` |
| `PREVIEW_OFFLINE_NOT_SENT` | 409 | `includeWecom = true`，但交付经理还没有登记该版本的企业微信发送 |
| `AD_CANCEL_IN_PROGRESS` | 409 | 有在途取消 |
| `PERMISSION_DENIED` | 403 | 调用者不是本广告的剪辑师 |

**副作用**（同一事务；09-order-ad.md:805、904）

- `ad_version`：同一条 UPDATE 写 `pushed_at`、`preview_channels`（开关 `weapp.video.ad.enabled` 开时 `weapp`，关时 `album`、`portal`；`includeWecom` 时加 `wecom`）。
- `ad.status`：`producing` / `revising` → `pending_confirm`（`ad.push_version`）；修改中时在途的修改轮次写 `fulfilled_by_version_no`；取消当前的 `sla.breach`（首版或该轮修改），首版推送后 `first_due_at` 不再变。迁移审计行 `action = ad.push_version`、`meta.versionNo`（1.1）。
- 出站事件 `ad.version_pushed`（通知商家；推送后 2 个自然日未确认的提醒是纯提醒，不建定时器行，R6）。

**说明**：以下是广告的既有口径（A97）；Q9 仅改变样片，不改变广告：`weapp`、`album`、`portal` 由系统按开关写入，员工只能补 `wecom`；开关关闭时系统已写入 `album`、`portal`，总有可用的查看方式；数据模型已按 A97 回写（09-order-ad.md:862“前三种由系统按推送时的开关写入……员工只能补 `wecom`”，904 写明“已发送”由交付经理单独登记，A142）。`wecom` 的“已发送”由交付经理登记（3.57），剪辑师推送时只决定是否列入；初稿推送请求体里的 `markWecomSent` 删除，因为剪辑师不是企业微信的发送人。商家端如何按查看方式确认见 m06-ad。

### 3.59 admin.ad.remind　催办商家确认广告

`POST /admin/ads/{adId}/remind`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`permission: assert-in-handler`：广告在调用者数据范围内，且调用者是该广告的剪辑师或所属门店的交付经理，或交付模块的主管 |
| 幂等 | required（对外发送） |
| 乐观锁 | 不适用 |
| 对应画板 | A:AdTasks（“催办商家”：待商家确认时可点） |
| 出处 | 路线图 `a05.ads.remind`；09-order-ad.md:813；13-notify-docs.md:640；proto-admin-a.md:234 |

**请求**：路径 `adId`；请求体为空对象 `{}`。

**响应**：`AdminRemindResult`（`scene = confirm_ad`，`subjectType = ad`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `REMINDED_TODAY` | 409 | 今天已催办过该广告；通用码（C27，40920，A76），`details = { scene, nextAvailableDate }`（A131） |
| `REMIND_NOT_APPLICABLE` | 409 | 广告不是 `pending_confirm` |
| `PERMISSION_DENIED` | 403 | 不满足处理器内的判定 |

**副作用**：插入 `manual_reminder_log`（`subject_type = ad`、`scene = confirm_ad`、`biz_date` = 今天）；出站事件 `manual_reminder.sent`，按 `m.ad_pending` 派发（订阅消息 ＋ 短信，节点 `M`）；活动流审计。

### 3.60 admin.ad.requestChange　代录广告修改意见

`POST /admin/ads/{adId}/request-change`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `delivery.sample.feedback_on_behalf`（路线图建议沿用；交付经理） |
| 幂等 | required |
| 乐观锁 | 不带；广告行 `FOR UPDATE` → 浮动绑定它的订购单、订单项、工单（加锁后重读并过滤，d3-flow.md:1299-1319） |
| 对应画板 | 原型无（交付经理代录商家电话或企业微信反馈） |
| 出处 | 路线图 `a05.ads.request-change`（A9：原 `a05.ads.request-revision`）；09-order-ad.md:807、906-907；d3-flow.md:1297-1326 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `adId` | string(uuid) | 是 | 在范围内 | 广告 |

请求体（`AdminAdRequestChangeBody`；比 m06 的商家端请求体少 `acceptChargePoints`，另起名字）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `versionNo` | integer | 是 | 待确认时等于 `latest_version_no`，已确认时等于 `confirmed_version_no` | 针对的版本，落 `ad_revision.on_version_no` |
| `note` | string | 是 | 1–200 字 | 修改意见 |
| `segmentIndex` | integer | 否 | 该版本 `segments` 里的 `index` | 选用的预置分段（起止从分段复制） |
| `timeStartMs` / `timeEndMs` | integer | 否 | 同有同无；`0 ≤ 起 < 止`；与 `segmentIndex` 二选一 | 自由输入的时间段 |
| `screenshotFileIds` | array<string(uuid)> | 否 | ≤ 1 个，已入库、分类 `ticket_attachment` | 截图（登记 `file_ref`：`ref_type = ad_revision`、`role = screenshot`） |

**响应**：`AdTaskDetail`（`status = revising`；结果脱敏见 1.1）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 广告不是 `pending_confirm` 或 `confirmed`（修改中不能再提，`uq_ad_revision_ad_id_unfulfilled`） |
| `AD_VERSION_STALE` | 409 | `versionNo` 不是应针对的版本（m06-ad 定义） |
| `AD_FREE_REVISION_EXHAUSTED` | 409 | 免费修改次数已用完（员工代录不产生扣减，要扣积分的只能由商家本人提交） |
| `AD_CANCEL_IN_PROGRESS` | 409 | 有在途取消 |
| `VALIDATION_FAILED` | 400 | 时间段或分段不合法；截图超限 |

**副作用**（同一事务；09-order-ad.md:807）

- 插入 `ad_revision`（`revision_no = revision_count + 1`、`source = staff_on_behalf`、`actor_type = staff`、`actor_id` = 本人、`client = admin`、`is_chargeable = false`、`charge_points = 0`、`due_at` = 1 个工作日）。
- `ad.status`：`pending_confirm` / `confirmed` → `revising`（`ad.request_revision`），`revision_count + 1`，写 `due_at`、`sla_snapshot`（策略 `ad.revision`），登记 `sla.breach`（键 `sla.breach:ad:{id}:rev:{revision_no}`）；从待确认提出时最新版本 `decision` 置 `revision_requested`，从已确认提出时不动版本行（09-order-ad.md:906-907）。迁移审计行 `action = ad.request_revision`，带 `meta.versionNo`（= `on_version_no`）、`meta.revisionNo`（1.1）。
- 广告重新打开（`ad.reopened`，10-delivery.md:179 第 8 行，经同事务的 `reevaluate()`）：浮动绑定该广告、工单在样片制作或样片确认且未暂停的 → `ad_prep`；这些工单“活着”的样片（`uploaded`、`qc_passed`、`pushed`）都置 `superseded`（`sample.superseded`，10-delivery.md:648）。暂停中的工单不求值，恢复后补求值时同样处理。
- 出站事件 `ad.revision_requested`；受影响的工单各发 `ticket.step_changed`，被取代的样片各发 `sample.superseded`。

### 3.61 admin.ad.cancelQuote　广告取消试算

`POST /admin/ads/{adId}/cancel-quote`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `order.refund.request`（客服；草案允许交付经理发起广告取消，注册表默认只授予客服，见第 6 节第 9 项） |
| 幂等 | none（试算，A20） |
| 乐观锁 | 不适用 |
| 对应画板 | 原型无（A:AdTasks、A:ServiceDetail 的“取消广告”入口） |
| 出处 | 路线图 `a05.ads.cancel-quote`（A20：原 GET 改 POST）；09-order-ad.md:1038-1040；d3-flow.md:1394-1408 |

**请求**：路径 `adId`；请求体（`AdCancelQuoteBody`）`{ reasonCode: enum(merchant_request, store_closed, platform_fault) }`。

**响应**：`CancelQuote`（一行，`targetType = ad`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `AD_CANCEL_IN_PROGRESS` | 409 | 已有在途取消 |
| `VALIDATION_FAILED` | 400 | 原因取值不合法 |
| `NOT_FOUND` | 404 | 不在范围内 |

**副作用**：无。

**说明**（d3-flow.md:1398-1406）：待指派、待补充（原为待指派）→ `ad_unassigned`，`release` 全额；制作中、修改中、待确认、待补充（原为制作中）→ `ad_in_production`：平台原因 `refund` 全额，商家原因按快照 `cancelDeductionBp.adInProduction`（占位 100%，此时 `terminate_only`，不动积分）；已确认、已取消、仍被在办订单项绑定的进 `blockers`（`ad_confirmed`、`ad_cancelled`、`ad_in_use`）。超次修改的扣减不进明细、不退回（09-order-ad.md:651）。

### 3.62 admin.ad.cancelRequest.create　发起广告取消

`POST /admin/ads/{adId}/cancel-requests`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `order.refund.request` |
| 幂等 | required |
| 乐观锁 | 不带；广告行锁下检查 `open_cancel_request_id` 与 `uq_cancel_request_ad_id_open` |
| 对应画板 | 原型无（A:AdTasks、A:ServiceDetail） |
| 出处 | 路线图 `a05.ads.cancel-requests.create`；09-order-ad.md:547、557；d3-flow.md:1394-1408、3528 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `adId` | string(uuid) | 是 | 在范围内 | 广告 |

请求体（`AdCancelRequestCreateBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `reasonCode` | enum(`merchant_request`,`store_closed`,`platform_fault`) | 是 | — | 取消原因 |
| `note` | string | 是 | 5–200 字 | 申请说明 |
| `expect` | object `{ totalRefundPoints: integer }` | 是 | — | 3.61 返回的 `expect` |
| `serviceTicketId` | string(uuid) | 否 | 属同一门店 | 从客服工单发起 |

**响应**：`CancelRequestDetail`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `AD_CANCEL_IN_PROGRESS` | 409 | 已有在途取消（含覆盖本广告的整店取消） |
| `AD_NOT_CANCELLABLE` | 409 | 已确认、已取消，或仍被在办订单项绑定（须先由交付经理修订方案换用其他广告）；`details.reason`、`details.boundOrderItemIds` |
| `CANCEL_QUOTE_CHANGED` | 409 | 重算的退回合计与 `expect` 不等；`details.quote` |
| `VALIDATION_FAILED` | 400 | 说明不合规 |

**副作用**（同一事务；09-order-ad.md:557）

- `approval_request`：（新建）→ `pending`（`kind = ad_cancel`、`subject_type = ad`，其余同 3.7）；`cancel_request`：（新建）→ `pending_approval`（`cancel.submit`，`ad_id` = 本广告，一行明细 `target_type = ad`）；`ad.open_cancel_request_id` = 本申请（广告保持提交时的状态，其他迁移一律拒绝，09-order-ad.md:811）。
- 带 `serviceTicketId` 时插入 `service_ticket_ref`（`ref_type = approval_request`、`ref_id` = 审批单 id，09-order-ad.md:557），客服工单详情的“取消待财务审批”与本申请详情的 `serviceTickets` 都据此反查。
- 出站事件 `approval.submitted`、`cancel.submitted`。
- 免审批开关打开且明细为 `release`、预览全额回到原批次时，同事务由系统审批并执行（`cancel.auto_execute`）：审批单 `pending → approved`（系统决定），`cancel_request` 直接到 `done`，`ad.status` → `cancelled`（同一条 UPDATE 写 `cancelled_at`、`cancel_reason_code`，清空 `open_cancel_request_id`），`point_hold` `held` → `released`；这一分支另发 `approval.approved`（`isDecidedBySystem = true`）、`cancel.executed`（`isAutoExecuted = true`）、`approval.executed`、`ad.cancelled`，账本发 `billing.points.returned`。

**说明**：审批与执行走 3.11–3.15，与订购取消同一套接口。

### 3.63 admin.productionRecord.list　制作文件事实查询

`GET /admin/production-records`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `delivery`（v）＋ 数据范围（按文件所属订单项或广告的门店判定） |
| 幂等 | none（查询） |
| 乐观锁 | 不适用 |
| 对应画板 | A:TicketDetail、A:AdTasks（质检页按文件读体检结论、AI 声明与标识状态、所用原片与广告版本） |
| 出处 | 路线图 `a05.production-records.list`（草案 `GET /admin/productions?fileIds=`）；06-media.md:720-804、432-470、375-430；d5-media.md:1965、1991 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `fileIds` | array<string(uuid)> | 条件 | 逗号分隔，1–100 个 | 按文件查（与下面两项至少给一项） |
| 查询 | `orderItemId` | string(uuid) | 条件 | — | 按订单项查样片与成片 |
| 查询 | `adId` | string(uuid) | 条件 | — | 按广告查 |
| 查询 | `kind` | enum(`sample`,`final`,`ad`) | 否 | — | 文件种类 |
| 查询 | `episodeNo` | integer | 否 | ≥ 1 | 集号 |
| 查询 | `pipelineState` | enum(`uploading`,`checking`,`ready`,`rejected`) | 否 | — | 流水线进度 |
| 查询 | `page`、`pageSize` | integer | 否 | `pageSize` ≤ 100 | — |

**响应**：`AdminPage<ProductionRecordView>`，按登记时间倒序。

**错误**：`VALIDATION_FAILED`（三个定位参数都没给）。

**副作用**：无。

**说明**：制作留痕的主键就是文件 id（`resources.json`：`{productionRecordId}` 取值等于文件 id）；原始探测输出 `media_info.raw` 不返回。

### 3.64 admin.productionRecord.normalize　云端规格化

`POST /admin/production-records/{productionRecordId}/normalize`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `production.normalize`（增补表；d5 推断） |
| 幂等 | required；媒体任务另按 `media_job.dedupe_key` 去重（同一来源的进行中任务直接返回，C63） |
| 乐观锁 | 不带；锁制作留痕行 |
| 对应画板 | A:TicketDetail、A:AdTasks（体检不合格时的补救按钮；原型未画） |
| 出处 | 路线图 `a05.production-records.normalize`（A4：`{fileId}` 改 `{productionRecordId}`）；06-media.md:779；d5-media.md:1247-1249、1288 |

**请求**：路径 `productionRecordId`（string(uuid)，来源文件）；请求体（`NormalizeBody`）`{ note?: string }`（≤ 200 字，记入审计）。

**响应**：`ProductionJobAccepted`（`jobKind = normalize`；`productionRecordId` 为新产物）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `PRODUCTION_ACTION_NOT_ALLOWED` | 409 | 文件种类不是成片或广告；流水线不在 `ready` / `rejected`；来源文件已不可用；`details.reason` |
| `NOT_FOUND` | 404 | 不在范围内 |

**副作用**（同一事务）

- 预先生成新文件：`file_object`（`status = pending`，分类同来源）。
- `production_record`：（新建）→ `uploading`（规格化产物登记，06-media.md:779），`source = normalized`、`derived_from_file_id` = 来源，订单项、广告、集号、变体、所用原片与广告版本、AI 声明从来源复制，`uploaded_by_staff_id` 为空（系统产物）。
- `media_job`：（新建）→ `queued`（`kind = normalize`，`subject_type = file_object` 为来源，`parent_type = production_record` 为新行，输入里带预先确定的输出键）。
- `ops` 流审计。

**说明**：数据万象转码模板 `lyx-final-normalize`（H.264 High、1080×1920、≤ 30fps、AAC 48k、MP4 faststart），产物声明用 AI 时补写隐式标识并回读，走同样的体检（d5-media.md:1288）。产物入库后由 media 的任务进程发 `media.production.derived`（不是本接口发的；x01 V1.0 不注册订阅者）；体检通过后由剪辑师经 3.30（成片，`episode_output.source = normalized`，10-delivery.md:689）或 3.56（广告）把产物登记为该集的新修订或广告的新版本，重新质检。V1.0 不做自动登记（若以后要自动登记，由 x01 补订阅者 `delivery.onProductionDerived`）。

### 3.65 admin.productionRecord.restamp　补标 AI 隐式标识

`POST /admin/production-records/{productionRecordId}/restamp`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `production.restamp`（增补表；d5 推断） |
| 幂等 | required；媒体任务按 `dedupe_key` 去重 |
| 乐观锁 | 不带；锁制作留痕行 |
| 对应画板 | 原型无 |
| 出处 | 路线图 `a05.production-records.restamp`；06-media.md:779、1716-1726；d5-media.md:1022、1971 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `productionRecordId` | string(uuid) | 是 | 在范围内 | 来源文件（AI 声明填错的那一版） |

请求体（`RestampBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `tools` | array<{ `name`, `version`, `usedFor` }> | 是 | ≥ 1 项，各 ≤ 50 字 | 更正后的 AI 使用声明（`used` 恒为 true），落新行的 `ai_usage` |
| `note` | string | 是 | 1–200 字 | 更正原因，记入审计 |

**响应**：`ProductionJobAccepted`（`jobKind = restamp`；`productionRecordId` 为新产物）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `PRODUCTION_ACTION_NOT_ALLOWED` | 409 | 来源已声明使用 AI（无需补标）；流水线不在 `ready` / `rejected`；来源文件不可用 |
| `VALIDATION_FAILED` | 400 | 工具为空 |

**副作用**：同 3.64，差别是新行 `source = restamped`、`ai_usage` 为更正后的声明（`declaredBy` = 本人、`declaredAt` = 现在、`aigc_state = pending`），任务 `kind = restamp`。原文件的声明不被修改（d5-media.md:1971）。

**说明**：产物体检通过后，由剪辑师经 3.30 登记为该集的新修订（`episode_output.source = restamped`）或经 3.56 登记为广告的新版本，重新质检；`media.production.derived` 由 media 的任务进程事后发出，不是本接口的事件，V1.0 也没有订阅者（同 3.64）。

### 3.66 admin.productionRecord.recheck　规则升级后重检

`POST /admin/production-records/{productionRecordId}/recheck`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `production.recheck`（增补表，建议） |
| 幂等 | required |
| 乐观锁 | 不带；锁制作留痕行 |
| 对应画板 | 原型无 |
| 出处 | 路线图 `a05.production-records.recheck`；06-media.md:784；d5-media.md:1982 |

**请求**：路径 `productionRecordId`（string(uuid)）；请求体为空对象 `{}`。

**响应**：`ProductionJobAccepted`（`jobKind = probe`；`productionRecordId` 为原行）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 流水线不在 `ready` 或 `rejected`（正在入库或体检） |
| `NOT_FOUND` | 404 | 不在范围内 |

**副作用**：`production_record.pipeline_state`：`ready` / `rejected` → `checking`（06-media.md:784）；登记体检任务 `media_job`（`kind = probe`，父对象为本行）；`ops` 流审计。体检完成后照常发 `media.production.checked`，版本行的状态由 delivery 的订阅者跟进。

**说明**：重检期间该文件不可质检（`PRODUCTION_NOT_READY`）。规则升级等导致上次人工重检任务真实失败或取消时，入口在原锁内核对当前文件上下文、该人工任务终态与不存在更新进行中任务，允许新意图发起新一轮实际体检；不把 `checking` 直接写成通过，成功仍仅由原 probe 回读/规则守卫产生。已经质检通过、已推送的版本不因重检回退，只在结论变为拒收时由订阅者告警给交付经理（待 x01 定义订阅行为）。

## 4. 枚举

本文用到的枚举。与数据模型同名枚举一致时写“同数据模型 `表.列`”；会增长的响应枚举标 `x-open-enum`（C37）。

### 4.1 订购单

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `OrderStatus` | 同数据模型 `drama_order.status` | `pending_start` 待开工、`producing` 制作中、`to_launch` 待上线、`live` 上线中、`ended` 已结束、`cancelled` 已取消、`after_sale` 售后处理中、`refunded` 已退回积分（x-open-enum） |
| `OrderSubStatus` | 同数据模型 `drama_order.sub_status`（09-order-ad.md:141-151 的 21 个取值） | 展示用子状态（x-open-enum） |
| `ItemPhase` | 同数据模型 `order_item.phase` | `pending_start`、`producing`、`to_launch`、`live`、`ended`、`cancelled`、`refunded`、`terminated`（x-open-enum） |
| `ProductionModel` | 同数据模型 `order_item.production_model` | `standard` 标准、`advanced` 高级、`top` 顶级 |
| `UsageEndSource` | 同数据模型 `order_item.usage_end_source` | `license`、`early_end`、`expired` |
| `Platform` | 同数据模型 `order_item_account.platform` | `douyin` 抖音、`wechat_channels` 视频号 |
| `PlacementSlot` | 同数据模型 `order_item_placement.slot` | V1.0 请求只接受 `opening`、`ending` |

### 4.2 取消申请

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `CancelReason` | 同数据模型 `cancel_request.reason_code`（与 `order_item.cancel_reason_code`、`ad.cancel_reason_code` 同一组；不是字典，显示名在 `packages/contract` 的枚举标签，M55） | `merchant_request` 商家申请取消、`store_closed` 门店停业或转让、`platform_fault` 平台原因无法交付、`qualification_final` 资质审核不通过且无法补正（只由系统生成，请求不接受） |
| `CancelKind` | 同数据模型 `cancel_request.kind` | `order_cancel`、`ad_cancel`、`qualification_cancel` |
| `CancelStatus` | 同数据模型 `cancel_request.status` | `pending_approval` 待审批、`pending_execution` 待执行、`done` 已执行、`not_executed` 未执行即关闭 |
| `CancelCloseReason` | 同数据模型 `cancel_request.close_reason` | `rejected`、`withdrawn`、`voided` |
| `CancelMode` | 同数据模型 `cancel_request_line.mode` | `release`、`refund`、`terminate_only` |
| `CancelStage` | 同数据模型 `cancel_request_line.stage` | `pending_start`、`plan_confirm`、`ad_and_sample`、`sample_pending`、`post_sample`、`live`、`ad_unassigned`、`ad_in_production` |
| `ReasonClass` | 同数据模型 `cancel_request_line.reason_class` | `merchant`、`platform`、`qualification` |
| `CancelTab` | 本文定义 | `pending_approval`、`pending_execution`、`processed`、`all` |
| `ConfirmCheck` | 本文定义（落 `approval_request.confirm_checks`、`cancel_request.exec_confirm_checks`，二者是 text[]） | 通过：`stage_rule_amount_checked`（已核对所处阶段、适用规则与退回数额）；执行：`order_points_checked`（已核对订购单与退回积分）（proto-admin-d.md:125、127） |
| `CancelBlockReason` | 本文定义 | `item_closed`、`live_not_refundable`、`item_expired`、`in_other_request`、`ad_confirmed`、`ad_cancelled`、`ad_in_use` |

### 4.3 交付工单

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `TicketStep` | 同数据模型 `delivery_ticket.step` | 13 个步骤（`in_service` 对外显示“使用中”，05-risks-and-open-issues.md 2.2）（x-open-enum） |
| `TicketTab` | 本文定义 | `processing`、`assigning`、`plan_confirm`、`ad_prep`、`sample_making`、`sample_confirm`、`batch_compose`、`delivering`、`awaiting_launch`、`launch_verify`、`in_service`、`takedown`、`closed`、`delivered_today`、`all` |
| `WaitingOn` | 同数据模型 `delivery_ticket.waiting_on` | `staff`、`merchant`、`none` |
| `SchedulePriority` | 同数据模型 `delivery_ticket.schedule_priority` | `standard`、`priority`、`rush` |
| `PauseReason` | 同数据模型 `delivery_ticket_pause.reason` | `cancel_review`、`plan_amendment` |
| `Urgency` | 本文定义 | `normal`、`due_today`、`overdue` |
| `RemindScene` | 同数据模型 `manual_reminder_log.scene` 的子集 | 工单：`confirm_plan`、`confirm_sample`、`golive`；广告：`confirm_ad` |
| `PlanStatus` | 同数据模型 `delivery_plan.status` | `drafting`、`pending_confirm`、`revising`、`confirmed` |
| `PlanVersionDecision` | 同数据模型 `delivery_plan_version.decision` | `confirmed`、`change_requested`、`superseded` |
| `PlanChangeKind` | 同数据模型 `delivery_plan_change_request.kinds` 的元素 | `launch_date`、`account`、`customization`、`placement`、`ad`、`other` |
| `AssignReason` | 同数据模型 `assignment_history.reason_code` 的子集 | `workload`、`merchant_request`、`staff_change`、`other` |
| `TicketTodo` | 本文定义（取值是 a02 `TodoSourceKey` 的子集） | `plan_push`、`sample_qc`、`staff_assign`（口径见 1.3） |
| `AssigneeInvalidReason` | 本文定义（`ASSIGNEE_INVALID.details.reason`，全仓共用，`x-open-enum`） | `not_active` 未启用、`role_mismatch` 角色不对口、`same_as_current` 与现任相同、`out_of_scope` 不在操作人的员工集合内 |

### 4.4 样片、质检、成片与下载

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `SampleStatus` | 同数据模型 `sample.status` | `uploaded`、`check_rejected`、`qc_rejected`、`qc_passed`、`pushed`、`confirmed`、`change_requested`、`superseded`（x-open-enum） |
| `PreviewChannel` | 同数据模型 `sample.preview_channels` 的元素（与 `ad_version.preview_channels` 同一组） | `weapp`、`album`、`portal`、`wecom` |
| `FeedbackKind` | 同数据模型 `sample.feedback_kind` | `compose` 合成问题、`ad_content` 广告内容 |
| `QcTargetType` | 同数据模型 `qc_record.target_type` | `sample`、`episode_output`、`delivery_ticket` |
| `QcVerdict` | 同数据模型 `qc_record.verdict` | `pass`、`fail` |
| `ChecklistResult` | 同数据模型 `qc_record.results[].result` | `pass`、`fail`、`na` |
| `EpisodeStatus` | 同数据模型 `episode_output.status` | `uploaded`、`check_rejected`、`qc_passed`、`qc_rejected`、`replaced` |
| `EpisodeSource` | 同数据模型 `episode_output.source` | `manual_upload`、`normalized`（规格化产物，A142）、`sample_adopted`、`restamped`、`auto_compose`（V1.1） |
| `Variant` | 同数据模型 `episode_output.variant` | V1.0 只有 `common` |
| `ReleaseKind` / `ReleaseState` / `ReleaseCloseReason` | 同数据模型 `delivery_release.kind`、`state`、`close_reason` | `initial` / `reissue`；`pushed` / `superseded` / `closed`；`cancelled` / `usage_ended` |
| `ReissueStatus` | 同数据模型 `delivery_reissue.status` | `open`、`published`、`cancelled` |
| `GrantState` | 同数据模型 `download_grant.state` | `active`、`superseded`、`revoked` |
| `DownloadKind` | 同数据模型 `delivery_download_log.kind` | `episode`、`zip`、`publish_list` |
| `ClientAck` | 同数据模型 `delivery_download_log.client_ack` | `saved`、`failed` |
| `MaterialKind` | 本文定义 | `master` 原片、`ad_version` 广告版本、`store_asset` 门店素材、`profile_media` 门店档案媒体 |
| `ReferenceSource` | 本文定义 | `store_asset` 素材库、`profile_media` 门店档案媒体（M20） |
| `ProfileMediaGroup` | 同数据模型 `store_profile_media.media_group` | `door` 门头、`interior` 店内环境、`product` 产品（菜品）、`promo` 宣传 |

### 4.5 广告

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `AdStatus` | 同数据模型 `ad.status` | `pending_assign` 待指派、`producing` 制作中、`returned` 待补充、`pending_confirm` 待商家确认、`revising` 修改中、`confirmed` 已确认、`cancelled` 已取消（x-open-enum） |
| `AdType` | 同数据模型 `ad.type` | `opening`、`ending`（V1.1：`corner`、`mid_roll`） |
| `AdTab` | 本文定义 | `todo`、`pending_confirm`、`confirmed`、`returned`、`cancelled`、`all` |
| `AdVersionDecision` | 同数据模型 `ad_version.decision` | `confirmed`、`revision_requested`、`superseded` |
| `AdRevisionSource` | 同数据模型 `ad_revision.source` | `ad_page`、`sample_feedback`、`staff_on_behalf` |

### 4.6 授权书

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `LetterStatus` | 同数据模型 `license_letter.status` | `pending_effective`、`effective`、`voided`（“已失效”是派生：`isExpired`） |
| `LetterVoidReason` | 同数据模型 `license_letter.void_reason` | `cancelled`、`terminated`、`account_removed`、`manual` |
| `RevisionReason` | 同数据模型 `license_letter_revision.reason` | `initial`、`go_live`、`period_changed`、`correction`、`resign` |
| `RenderStatus` | 同数据模型 `license_letter_revision.render_status` | `queued`、`rendering`、`ready`、`failed` |
| `SignMode` | 同数据模型 `license_letter_revision.sign_mode` | `platform_cert`、`esign_seal`、`stamp` |
| `CorrectionKind` | 本文定义（只进审计） | `licensee_name`、`store_name`、`account_name`、`other` |

### 4.7 制作文件

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `ProductionKind` | 同数据模型 `production_record.kind` | `sample`、`final`、`ad` |
| `ProductionTier` | 同数据模型 `production_record.production_tier`（`ck_production_record_production_tier`） | `standard`、`advanced`、`top`（A98：初稿的 `premium` 改为 `top`，与 `order_item.production_model` 同一组取值） |
| `ProductionSource` | 同数据模型 `production_record.source` | `manual_upload`、`normalized`、`restamped`、`render`（V1.1）、`ai_assisted`（V2.0） |
| `PipelineState` | 同数据模型 `production_record.pipeline_state` | `uploading`、`checking`、`ready`、`rejected` |
| `AigcState` | 同数据模型 `production_record.aigc_state` | `not_required`、`pending`、`verified`、`failed` |
| `ProductionJobKind` | 同数据模型 `media_job.kind` 的子集 | `normalize`、`restamp`、`probe` |

## 5. 错误码

本文新定义的领域错误码，数值取自 A70 分给本文的区间 45300–45499（45301–45324）。`retryable` 全部为否（C26）。

| 符号 | 数值 | HTTP | 含义 | `details` |
| --- | --- | --- | --- | --- |
| `CANCEL_ITEM_NOT_ALLOWED` | 45301 | 409 | 选中的订单项不能取消，或没有可取消的订单项（d3-flow.md:2115-2127 的 `invalid` 分支） | `{ lines: [{ orderItemId, reason: CancelBlockReason }] }` |
| `AD_NOT_CANCELLABLE` | 45302 | 409 | 广告已确认、已取消，或仍被在办订单项绑定（d3-flow.md:1404-1406） | `{ reason: 'ad_confirmed'\|'ad_cancelled'\|'ad_in_use', boundOrderItemIds: string[] }` |
| `CANCEL_QUOTE_CHANGED` | 45303 | 409 | 发起取消时重算的退回合计与试算时不同 | `{ quote: CancelQuote }` |
| `PLAN_CONTENT_INVALID` | 45304 | 409 | 方案内容校验不通过（d3-flow.md:1150-1156） | `{ issues: [{ orderItemId: string \| null, field, reason: 'item_missing'\|'placement_missing'\|'placement_not_allowed'\|'ad_invalid'\|'ad_type_mismatch'\|'account_invalid'\|'account_missing'\|'launch_date_missing'\|'ticket_unassigned'\|'reference_unusable' }] }` |
| `PLAN_CHANGE_WINDOW_CLOSED` | 45305 | 409 | 方案确认后的修订超出该剧的变更窗口（d3-flow.md:1167-1172） | `{ items: [{ orderItemId, step, changedKinds: PlanChangeKind[] }] }` |
| `LAUNCH_DATE_OUT_OF_RANGE` | 45306 | 400 | 约定上线日早于订购日后第 7 个工作日（或今天），或晚于使用期止日 | `{ orderItemId, minDate, maxDate }` |
| `LAUNCH_DATE_LOCKED` | 45307 | 409 | 首个账号已核验上线，或订单项不在制作中、待上线，不能改期 | `{ phase, usageStartDate: string \| null }` |
| `ASSIGNEE_INVALID` | 45308 | 409 | 接收人无效：未启用、角色不对口、与现任相同，或不在操作人的员工集合内（A77 归本文，a01、a03 引用；d4-identity.md:1324 第 4 条） | `{ staffId: string, reason: AssigneeInvalidReason }`（`not_active`\|`role_mismatch`\|`same_as_current`\|`out_of_scope`，`x-open-enum`） |
| `REMIND_NOT_APPLICABLE` | 45309 | 409 | 催办场景与对象当前状态不符 | `{ scene, reason }` |
| `CORRECTION_NOT_ALLOWED` | 45310 | 409 | 人工纠偏的步骤对不在白名单，或更正后结构性不变量不成立 | `{ reason: 'not_whitelisted'\|'invariant_failed', allowedSteps: string[], failedInvariants: string[] }` |
| `QC_SELF_INSPECTION` | 45311 | 409 | 质检人是上传人（样片恒禁止；剧集按参数 `qc.episode.four_eyes`） | 无 |
| `PRODUCTION_NOT_READY` | 45312 | 409 | 制作文件入库或体检未完成、或体检未通过，不能质检或登记 | `{ fileId, pipelineState, gate: 'pass'\|'reject'\|null }` |
| `PREVIEW_OFFLINE_NOT_SENT` | 45313 | 409 | 选了企业微信查看方式，但没有登记“已发送”（`ck_sample_offline_sent`、`ck_ad_version_offline_sent`） | 无 |
| `AD_FREE_REVISION_EXHAUSTED` | 45314 | 409 | 员工代录广告修改时免费次数已用完 | `{ adId, freeRevisionQuota, revisionCount }` |
| `EPISODE_REGISTER_NOT_ALLOWED` | 45315 | 409 | 当前步骤不允许登记成片，或补发集号不在补发单范围内（d3-flow.md:1549-1553） | `{ step, reason: 'step'\|'reissue_required'\|'not_in_reissue' }` |
| `EPISODE_NOT_LATEST` | 45316 | 409 | 质检只能作用于该集最新的修订（d5-media.md:1987） | `{ episodeNo, latestEpisodeOutputId }` |
| `PACKAGE_PUSH_BLOCKED` | 45317 | 409 | 推送成片包或发布补发的守卫不通过（d3-flow.md:1641-1644） | `{ blockers: [{ code: 'episodes_incomplete'\|'episode_qc_pending'\|'package_qc_pending'\|'publish_list_incomplete'\|'license_letter_missing'\|'account_unbound'\|'abnormal_account_ack_required'\|'launch_date_missing'\|'usage_ended', episodeNos?: integer[], channelAccountId?: string, checklistKeys?: string[] }] }` |
| `REISSUE_NOT_ALLOWED` | 45318 | 409 | 当前不能发起补发 | `{ reason: 'step'\|'usage_ended'\|'open_reissue_exists', openReissueId: string \| null }` |
| `REISSUE_INCOMPLETE` | 45319 | 409 | 补发单里还有集没有质检通过的替换行 | `{ missingEpisodeNos: integer[] }` |
| `MATERIAL_NOT_AVAILABLE` | 45320 | 409 | 要下载的制作素材不可用 | `{ kind: MaterialKind, reason: 'master_not_ready'\|'not_in_ticket'\|'asset_unavailable', episodeNos?: integer[] }` |
| `LICENSE_LETTER_UNCHANGED` | 45321 | 409 | 按当前事实生成的授权书与最新版次内容相同，无需更正 | `{ currentRevNo }` |
| `AD_WAITING_QUALIFICATION` | 45322 | 409 | 门店资质未通过，广告暂不能指派（指派即扣积分） | `{ storeId, qualificationStatus }` |
| `AD_VERSION_SPEC_INVALID` | 45323 | 409 | 广告版本规格不符（竖屏 9:16、1080×1920、时长与类型相符） | `{ checks: [{ code: 'aspect'\|'resolution'\|'duration'\|'file_not_ready', actual, expected }] }` |
| `PRODUCTION_ACTION_NOT_ALLOWED` | 45324 | 409 | 制作文件当前不能规格化或补标 | `{ action: 'normalize'\|'restamp', reason: 'kind'\|'pipeline_state'\|'already_declared'\|'file_unavailable' }` |

引用的其他文档的错误码：`ORDER_IN_AFTER_SALE`、`TICKET_ON_HOLD`、`SAMPLE_VERSION_STALE`、`AD_CHANGED`（m05-delivery-publish）；`AD_CANCEL_IN_PROGRESS`、`AD_VERSION_STALE`（m06-ad）；`ACCOUNT_BUSY`、`PLAN_NOT_AVAILABLE`（m07-billing）；`REFUND_EXECUTOR_CONFLICT`（a07-billing-finance，44114，3.15）；`FILE_NOT_USABLE`（m03-profile-asset，46001，`details.reason` 按 m03 的 `FileNotUsableReason` 取值，本文用到 `not_stored`、`category_mismatch`、`context_mismatch`、`blocked`、`duplicate`）；`BATCH_PURPOSE_MISMATCH`（a04-content，49215）；`APPROVAL_NOT_PENDING`、`APPROVAL_SELF_FORBIDDEN`、`APPROVAL_WITHDRAW_FORBIDDEN`（a03-merchant，统一审批单码 48201、48202、48204）；清单类 `CHECKLIST_VERSION_STALE`（47306）、`CHECKLIST_NOT_PASSED`（47307，400，`details` 以 a01 清单为准）都归 a01-system（A77、C28 的共用领域码归属表；a06 初稿的 46203 已释放）。通用码（C27）：`VALIDATION_FAILED`、`NOT_FOUND`、`PERMISSION_DENIED`、`STEP_UP_REQUIRED`、`STATE_NOT_ALLOWED`、`VERSION_CONFLICT`、`CONFIRM_MISMATCH`、`PRECONDITION_CHANGED`，以及 A76 新增的 `REMINDED_TODAY`（409，40920，人工催办共用；a06 初稿的 46201 已释放）。

`REMIND_NOT_APPLICABLE`、`ASSIGNEE_INVALID`、`PRODUCTION_NOT_READY` 的含义不限于本文的对象，a06、a07、a08 的催办、指派、质检类接口可以按符号引用，不另定义。`ASSIGNEE_INVALID` 是 C28 共用领域码归属表里登记的接收人无效码：a01 的 `HANDOVER_TARGET_INVALID`、a03 的 `TRANSFER_TARGET_INVALID` 已删除改引用；引用方取 `details.reason` 时按 `AssigneeInvalidReason`（a03 原来的 `not_delivery_manager` 即 `role_mismatch`）。

## 6. 待确认

| # | 问题 | 默认做法 | 由谁定 |
| --- | --- | --- | --- |
| 1 | Q9 样片已明确仅 weapp + 必须勾选；类目/提审/真机与法务仍未验。广告沿既有四渠道口径 | 样片新推送只 weapp，关停拒绝；独立发送记录只作沟通，历史字段/快照保留，不自动迁移 | 产品 + 法务 |
| 2 | ~~取消申请的审批人能否同时是执行人~~（已定，A156） | 14 分组补参数 `refund.require_distinct_executor`，默认 false（不限制）；为 true 时 3.15 返回 403 `REFUND_EXECUTOR_CONFLICT`（a07 定义） | 已关闭 |
| 3 | ~~取消与退款的驳回原因字典~~（已定，A156） | 14 分组在 `reject_reason` 下补场景“取消与退款驳回”，播种 4 项（不符合退款规则、金额核算有误、说明不充分、其他，proto-admin-d.md:126）；3.12 的 `reasonCodes` 选填 | 已关闭 |
| 4 | 样片确认后至上线前取消（`post_sample`）的扣除比例：快照为 null 时由客服填写扣除数与依据、财务核定（05-risks-and-open-issues.md:209） | 按此实现：试算标 `needsManualDeduct`，发起时必填扣除数与说明 | 业务 + 财务 |
| 5 | 订购单详情“已下载 2 份”是逐份下载还是打包下载授权书 | 逐份：每份经 `admin.file.downloadUrls` 签发；不提供打包 | 产品 |
| 6 | 主管返工时，已登记但未质检通过的剧集怎么处理（数据模型只写了当前且通过的行置 `replaced`） | 保持原状，返工后同一集再登记即换版、旧的未决修订一并置 `replaced`（10-delivery.md:723） | 产品 |
| 7 | 广告任务详情要不要显示“超出后每次扣 N 积分”的现价（按商家当前周期的单价与折扣算） | 不显示现价，只显示提交时的快照与已用次数；扣减金额以商家提交时弹窗的金额为准 | 产品 |
| 8 | 广告任务的剪辑师是否需要单独的改派入口（原型只有“指派”） | V1.0 不提供；离职、调岗经员工移交（a01-system） | 产品 |
| 9 | 广告取消能否由交付经理发起（d3-flow.md:2059 写“客服或交付经理”，注册表 `order.refund.request` 默认只授予客服） | 按注册表：默认客服；需要时在角色页给交付经理开 `order.refund.request` | 业务 |
| 10 | 交付工单的“使用中 / 服务中”叫法：PRD 与原型不一，05 文档定“使用中” | 枚举仍为 `in_service`，后台显示“使用中” | 产品 |

## 7. 修订记录

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：路线图 `doc = a05-order-delivery` 的 66 条接口（全部 V1.0）；新定义错误码 24 个（45301–45324）；权限点增补建议 7 个（1.2） | 写作规范；A1–A75；C1–C84；数据模型 09、10、13 分组，另读 03、06、07 分组 |
| 2026-10-03 | 路线图写法的调整：催办场景取数据模型取值（`confirm_plan`、`confirm_sample`、`golive`，不是 `plan_confirm`、`sample_confirm`）；工单列表的 `opsView` 拆成 `isPaused`、`pausedBefore`、`isStuck`；样片与广告版本的推送请求体可一并登记“已发送”（`markWecomSent`） | C45；10-delivery.md:563-605；09-order-ad.md:889；13-notify-docs.md:640 |
| 2026-10-03 | 与同期文档对齐：`REMINDED_TODAY` 改引 a06-publish（46201，429），`CHECKLIST_VERSION_STALE` 改引 a01-system（47306），审批码改引 a03-merchant（含撤回用 `APPROVAL_WITHDRAW_FORBIDDEN`），交付前检查未全过改用 a06 的 `CHECKLIST_NOT_PASSED`；本文错误码重排为 45301–45324；出站事件名对齐 x01 事件目录（`cancel.*`、`manual_reminder.sent` 等） | a01、a03、a06、x01 的清单 |

**第二轮（按裁决 A76–A120、其他文档的请求、两位复核员的意见与整体核对修订，2026-10-03）**

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 错误码：`REMINDED_TODAY` 改为通用码 409 / 40920（3.23、3.59），删去对 a06 46201 与 429 的引用，第 6 节原第 2 项删除；`CHECKLIST_NOT_PASSED` 改为 a01 定义（3.33、3.45）；`ASSIGNEE_INVALID` 的 `details` 改为 `{ staffId, reason }`，`reason` 补 `out_of_scope`，3.21、3.22 的“与现任相同”统一用它；3.30 补 `BATCH_PURPOSE_MISMATCH`（a04）、批次不在 `ready` 的 `STATE_NOT_ALLOWED`；`FILE_NOT_USABLE` 的拒绝原因按 m03 的 `FileNotUsableReason`（含 `context_mismatch`）写明，体检拒收改用 `PRODUCTION_NOT_READY`；驳回、代撤补 `STEP_UP_REQUIRED` | A76、A77；C27、C28；a04、m03 清单；复核 B |
| 2026-10-03 | 事件：初稿的 `item.launch_rescheduled`、`reissue.opened`、`episode.qc_failed` 按 x01 命名规则改为 `order.item.launch_rescheduled`、`package.reissue_opened`、`ticket.episode_qc_failed`（请 x01 补登）；3.20 只发 `ticket.assigned`（E2）；3.7、3.62 的免审批自动执行补齐事件，3.62 补 `cancel.submitted`；返工用迁移键识别、纠偏载荷用 `isForced`；3.64、3.65 的清单不再列 `media.production.derived`（media 事后发出，V1.0 无订阅者），规格化、补标产物改由剪辑师经 3.30、3.56 登记 | A95；x01 2.1、2.4、第 8 节第 10 项；api-check 第 3 节；复核 B |
| 2026-10-03 | 结构：`StaffBrief` 改引 a01 2.2；同名异构的改名为 `AdminStoreBrief`（补 `cityCode`、`districtName`）、`AdminChecklistItemView`、`AdminPlanContentView`、`AdminAdVersionView`、`AdminAdRevisionView`、`AdminRemindResult`、`AdminSampleRequestChangeBody`、`AdminAdRequestChangeBody`；`confirmViewedVia` 改名 `viewedVia`（与 m05、m06、x01 一致）；新增 `ReferenceFileView`，订购单详情、广告详情、制作素材清单按 `file_ref` 列出素材库与档案媒体两种参考素材（M20），3.28 补 `kind = profile_media` | A77；a01 2.2；M20；复核 A、B |
| 2026-10-03 | 页面字段：订购单详情补当前周期止日、套餐与加购分开的可用积分、题材名称、逐封授权书摘要；取消申请明细补集数、制作模型、平台；工单详情的方案区以订单项当前约定上线日为准（`currentAgreedLaunchDate`），广告区补同单占用，补发布清单、上线任务与当前核验单、在途成片批次；样片补水印版 `watermark`；制作档位取值改为 `standard`、`advanced`、`top` | A98；a04、a06 的请求；复核 A |
| 2026-10-03 | 流程：3.42、3.60 写明广告重新打开时受影响工单的样片（`uploaded`、`qc_passed`、`pushed`）置 `superseded`；3.25 的求值行补第 15b 行及到期下架的收尾；3.15 给被取消或终止的订单项都写 `cancelled_at`、`cancel_reason_code`，关闭成片包时作废 ZIP 缓存；3.33 推送时预打包；3.30 补批次 `ready → committed` 与成片的素材采用；3.20–3.22、3.54 补“被指派人须在操作人员工集合内”，并按 `ck_assignment_history_from_to`（`from_staff_id` 非空）改为首次指派不写改派记录 | 10-delivery.md:179、187、648；09-order-ad.md:281、323；06-media.md:529、962、975、1190；d4-identity.md:1324；复核 A、B |
| 2026-10-03 | 权限与审计：3.8–3.10 的查看门槛改为 `order` 或 `finance`（与 a01 审批类型表一致）；驳回与代撤按 A13 同样要求再验证，代撤补“对象已失效”的情形；广告版本“已发送”改由交付经理登记（`delivery.sample.push`），推送仍由剪辑师，推送请求体删去 `markWecomSent`，第 6 节原第 10 项删除；流程运维的审计类别改为 `system_ops`，授权书更正的 `docs` 请主负责人补登；改期写带 `before` / `after` / `meta` 的审计行供 a06 还原；广告迁移的审计行带 `meta.versionNo`、`meta.revisionNo`，`summary` 不含员工真实姓名（m06 时间线）；选人下拉改用 a01 的 `recommendPool`、`recommendCityCode` | A13、A15、A45、A97、A107；C66；a01、a06、m06 的请求；复核 A、B |
| 2026-10-03 | 其他：1.1 补“结果脱敏”（A80）、“指派的范围”、取消原因不是字典；1.2 补导出权限点；新增 1.3（成片批次的 `authorizeUpload`、终局驳回试算端口、交付经理转移的改派实现、工作台待办计数函数），3.1、3.16、3.51 补对应的预置筛选；3.46 写明下载记录的三种来源；3.47 不分页待登记进 C43；第 6 节只留产品、业务、法务问题并重新编号 | A78、A80、A88、A108；a02、a03、a04、p01 的请求 |
| 2026-10-03 | 路线图切片：`admin.deliveryTicket.remind`、`admin.ad.remind`、`admin.cancelRequest.withdraw` 的 `permission` 改为 `assert-in-handler`；`admin.adVersion.markSent` 改为 `delivery.sample.push`、摘要删去“带水印”；催办场景名、工单列表筛选名、改期与补发与推送的 `tables`、样片与广告推送的备注按作者建议改；各条 `transitions` 与文档对齐 | A45、A97；review/xdoc-a05-order-delivery.md |

**第三轮（按裁决 A127–A146、约定 C85–C87、其他文档的请求与整体核对修订，2026-10-03）**

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 再验证：3.12 驳回登记 `x-step-up: skip`（C86），错误表删去 `STEP_UP_REQUIRED`，1.1、1.2、`CancelRequestDetail.actions` 同步；1.1 补“审批决定的守卫顺序”（与 a03 1.1 相同）；清单与路线图切片的该条加 `xStepUp: skip` | A127；C7、C86；a03 的请求 |
| 2026-10-03 | 公共结构：删去本文的 `PageResult`、`CursorResult`、`SignedUrl`，改引 a01 的 `AdminPage<T>`、`AdminCursorPage<T>`、`SignedUrl`（`url` 不可空）；样片反馈图片、广告修改截图改用 m08 的 `ImageRef`，结果脱敏改为整个图片数组置空；`CancelRequestDetail.approval` 改用 a01 的 `ApprovalDecisionView`（`reasonCodes` 改为 `reasons`），勾选项单列 `confirmChecks`；字典多值字段改用 `DictRef`（C85）；`AdminStoreBrief`、`AdminChecklistItemView`、`ChecklistResultInput`、`ActivityItem`、`ReleaseAdminView` 注明本文为归属文档，删去与 a06 `StoreBrief` 的比较；清单补 `externalSchemas` | A132、A133；C85、C87；a01、a04、a06 的请求 |
| 2026-10-03 | 错误码：`REMINDED_TODAY` 的 `details` 写明 `{ scene, nextAvailableDate }`（3.23、3.59） | A131；a06 的请求 |
| 2026-10-03 | 数据模型回写后的核对：`episode_output.source` 补 `normalized`（`EpisodeOutputView.source`、3.30、3.64、4.4 `EpisodeSource`），规格化产物不再登记为 `manual_upload`；3.57、3.58 改引 09-order-ad.md:862、904 的现文；3.47 注明已登记进 C43 | A139、A142；10-delivery.md:689；09-order-ad.md:862、904 |
| 2026-10-03 | 选人与待办：3.20–3.22、3.54 的在办量取 a01 `StaffListItem.openWorkBySource` 的对应一项；1.3 补“门店首次分配交付经理的工单分配实现”（a03 3.8a 与 3.20 共用），确认 a02 交付侧六个待办来源的归属角色与可见条件 | a01、a02、a03 的请求 |

**第四轮（收尾，按裁决 A151–A156 与其他文档的请求修订，2026-10-03）**

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 单值字典改 `DictRef`：`AdminStoreBrief` 的 `cityCode` + `cityName` → `city`、`districtName` → `district`，订购单侧栏 `provinceName`、`industryName`、`categoryName` → `province`、`industry`、`category`（区县取其中 `store` 的 `district` 字段），`ReleaseAdminView.reasonCode` → `reason`，`ReissueView.reasonCode` + `reasonName` → `reason`；取消原因 `CancelReason` 是数据库枚举，不改。3.15 补参数 `refund.require_distinct_executor` 与 403 `REFUND_EXECUTOR_CONFLICT`（a07），第 6 节第 2、3 项关闭；`admin.store.reassignManager` → `admin.store.reassignDeliveryManager`；删去请 x01 补登事件的说明 | A151、A156、A136；a03、a06、x01 的请求 |
