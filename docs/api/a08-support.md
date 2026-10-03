# 后台：客服工单

| 项 | 内容 |
| --- | --- |
| 范围 | 客服工单池 A:Service（页首摘要、状态页签与计数、筛选、分配弹窗、登记工单弹窗；“导出”走 a02 的统一导出）；工单详情 A:ServiceDetail（处理记录时间线、回复商家与内部备注、转派、提交处理结果、关闭工单、服务时效、工单信息与改类型、改优先级、关联业务与补关联、移除关联）；商家详情 A:MerchantDetail 的“客服工单”页签与角标；人工纠偏（流程运维，原型无画板）；V1.1 占位：快捷回复 |
| 接口数 | 14（V1.0 13，V1.1 1） |
| 依据 | 数据模型 12 分组（`service_ticket`、`service_ticket_entry`、`service_ticket_ref` 的字段、状态机、定时器、快照结构）；另读 03 分组（`staff`、`staff_role`、`assignment_pool_member`、`assignment_cursor`、`assignment_history`、`approval_request`、`audit_log`）、01 分组（`status_transition`、`timer`、`outbox_event`、`biz_sequence`）、02 分组（`store`、`entity_member`、`merchant_user`）、04 分组（`store_profile`）、06 分组（`file_object`、`file_ref`）、05、08、09、10 分组（关联业务的展示列）、14 分组（`dict_item`、参数）。草案 d3-flow 第 18 节、7.9 节与附录 B；d4-identity 第 7.1、7.3 节；d6-notify-docs-data 第 2.8 节；d7-platform 第 5 节；PRD 7.8；原型梳理 proto-admin-c 第 8、9 节；画板 `admin/src/Service.dc.html`、`admin/src/ServiceDetail.dc.html`；接口裁决 A1–A146（第二轮按第十节 A76–A120、第三轮按第十二节 A127–A146 修订）；通用约定 C1–C87 |

本文路径一律省略 `/api/v1`。引用写法：`12-support.md:151` 指 `docs/data-model/12-support.md` 第 151 行；`d3-flow.md:2536` 指 `docs/appendix/design/d3-flow.md`；`proto-admin-c.md:371` 指 `docs/appendix/research/proto-admin-c.md`。

## 1. 概览

商家的售后问题有两个入口：小程序提交（m08-support-misc 的 `m.serviceTicket.create`，进入“待受理”），和客服在后台按来电、在线客服会话登记（本文 `admin.serviceTicket.create`，直接进入“处理中”）。之后的处理都在后台：首次回复商家使工单进入处理中，提交处理结果使它进入待商家确认，3 个自然日内商家未确认的由定时器自动解决；“关闭”只用于重复、无效或商家撤回的工单。每一步按 12 分组的状态机表（`12-support.md:147-162`）逐行实现，写状态历史、活动流审计与出站事件。

在线客服用微信客服接待，会话内容不落库（05-risks-and-open-issues.md:24）；需要跟进的会话由客服在这里登记成工单，来源记 `online_chat`。

全部接口 `x-auth = staff`，后台不区分店员视图。查看类不设权限点，用模块等级表达（模块 `service` ≥ v，C66）；写接口各有权限点。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `admin.serviceTicket.list` | `GET /admin/service-tickets` | 工单池列表；商家详情“客服工单”页签 | staff；模块 `service` ≥ v；数据范围 `task` | none（查询） |
| `admin.serviceTicket.summary` | `GET /admin/service-tickets/summary` | 页首摘要与页签计数；商家详情页签角标 | staff；模块 `service` ≥ v；数据范围 `task` | none（查询） |
| `admin.serviceTicket.create` | `POST /admin/service-tickets` | 登记工单（电话、在线客服） | staff；`service.ticket.register` | required（结果脱敏） |
| `admin.serviceTicket.get` | `GET /admin/service-tickets/{serviceTicketId}` | 工单详情 | staff；模块 `service` ≥ v；数据范围 `task` | none（查询） |
| `admin.serviceTicket.update` | `PATCH /admin/service-tickets/{serviceTicketId}` | 改问题类型、优先级（A92） | staff；`service.ticket.reply`；带 `lockVersion` | required（结果脱敏） |
| `admin.serviceTicket.entry.create` | `POST /admin/service-tickets/{serviceTicketId}/entries` | 回复商家、写内部备注 | staff；`service.ticket.reply` | required（结果脱敏） |
| `admin.serviceTicket.ref.create` | `POST /admin/service-tickets/{serviceTicketId}/refs` | 处理中补关联业务（A92） | staff；`service.ticket.reply` | required（结果脱敏） |
| `admin.serviceTicket.ref.batchRemove` | `POST /admin/service-tickets/{serviceTicketId}/refs/remove` | 移除关联错的业务（A92，物理删除） | staff；`service.ticket.reply` | required（结果脱敏） |
| `admin.serviceTicket.submitResult` | `POST /admin/service-tickets/{serviceTicketId}/submit-result` | 提交处理结果 | staff；`service.ticket.reply`；负责人规则 | required（结果脱敏） |
| `admin.serviceTicket.close` | `POST /admin/service-tickets/{serviceTicketId}/close` | 关闭工单 | staff；`service.ticket.close`；负责人规则 | required（结果脱敏） |
| `admin.serviceTicket.assign` | `POST /admin/service-tickets/{serviceTicketId}/assign` | 给没有负责人的工单分配负责人 | staff；`service.ticket.assign`（仅主管） | required（结果脱敏） |
| `admin.serviceTicket.reassign` | `POST /admin/service-tickets/{serviceTicketId}/reassign` | 转派 | staff；`service.ticket.transfer`；负责人规则 | required（结果脱敏） |
| `admin.serviceTicket.forceTransition` | `POST /admin/service-tickets/{serviceTicketId}/force-transition` | 人工纠偏：误关闭的工单重新打开 | staff；`flow.admin.transition`（要求再验证） | required（结果脱敏） |
| `admin.quickReply.list` | `GET /admin/quick-replies` | V1.1：快捷回复 | staff；模块 `service` ≥ v | none（查询） |

路由注册顺序（A8、C12）：`GET /admin/service-tickets/summary` 是字面段，先于 `GET /admin/service-tickets/{serviceTicketId}` 注册。`POST …/refs/remove` 是 `refs` 集合上的动作（`service_ticket_ref` 没有单列 id，不按 id 访问，`resources.json` 的 `refs` 一项），与 `POST …/refs` 不冲突；按 C14 集合动作加 `batch` 前缀，operationId 为 `admin.serviceTicket.ref.batchRemove`。

本文用到的权限点（d4-identity.md:1191-1192 的注册表与增补表，A13、A45）：`service.ticket.register`、`service.ticket.reply`、`service.ticket.close`、`service.ticket.transfer`（客服、交付经理）；`service.ticket.assign`（客服，仅主管）；`flow.admin.transition`（增补表，默认只授予超级管理员，再验证标“要”，与 a05 的增补表一致，C66）。A92 补的改类型与优先级、关联业务增删沿用 `service.ticket.reply`（处理工单的员工），不另设新键，不进增补表。另引用：`pii.phone.reveal`（a01 的明文查看）、`service.export`（a02 的导出，增补）。两个键的含义按 A129 定（以 07 主文档的注册表为准，d4 附录的旧表（d4-identity.md:1192 写的“改派”）不再回改）：`service.ticket.assign` 是“分配无负责人的工单（仅主管）”，待分配池登记为 `service_ticket`；`service.ticket.transfer` 是“负责人转出；主管可改派任意工单”，即本文的转派加负责人规则。`service.ticket.assign` 默认只授予客服主管，其数据范围为“全部”，待分配池不改变它的可见集合；客服工单的数据范围谓词按 A129 记为任务范围、不拼待分配池分支（1.1“数据范围”）。

### 1.1 本文通用口径

| 事项 | 规则 | 出处 |
| --- | --- | --- |
| 模块等级 | 模块 `service`：客服、交付经理“编辑”，内容运营、财务“查看”，超级管理员“编辑”；等级为 `n` 返回 403 `PERMISSION_DENIED` | PRD 第 3.3 节矩阵；d4-identity.md:1227 |
| 数据范围 | 按 A92：角色范围为“全部”的（客服、财务、内容运营、超级管理员）看全部工单；范围为“本人 / 本组”的（交付经理）看两类工单的并集：门店由本人或本组负责（`store.delivery_manager_id` 在员工集合内），或负责人（`service_ticket.owner_staff_id`）在员工集合内（被转派到别人门店的工单仍可见）。即 d4 的 `taskScope`：`store` 传 `managedStore(s)`，`assignees = [{ col: owner_staff_id }]`，不带待分配池；本文除快捷回复外的全部路由声明 `scope: task`（写接口按同一谓词取工单行）。d4-identity.md:1278 把客服工单列在 `byStore` 的注释里，A129 已裁为任务范围（门店 = 本人负责的门店，负责人 = `service_ticket.owner_staff_id`，无待分配池），以 07 主文档为准，d4 附录不回改。范围外与不存在不区分，一律 404 `NOT_FOUND` | A92、A129；C58；d4-identity.md:1222、1232-1347 |
| 负责人规则 | 提交处理结果、关闭、转派要求观察者是当前负责人（`service_ticket.owner_staff_id`），或是主管（`staff.is_lead`），或是超级管理员（A92 采纳）；工单没有负责人时，持有该权限点即可。不满足返回 403 `SERVICE_TICKET_NOT_OWNER`。回复与内部备注、改类型与优先级、关联业务增删只要持有 `service.ticket.reply`（负责人为空时也可回复，回复人不因此成为负责人，`12-support.md:151`） | A92；`12-support.md:153`、`158`、`160` 的“触发者”；d3-flow.md:2509-2517 |
| 可接手的员工 | 分配、转派、登记时指定的负责人必须：`staff.status = 'active'`；其角色持有 `service.ticket.reply`（默认客服、交付经理；超级管理员拥有全部权限点）；操作人的范围不是“全部”时，须在操作人的员工集合内（d4-identity.md:1324 第 4 条）。不满足返回 409 `ASSIGNEE_INVALID`（a05 定义的共用码，A77、C28），`details.reason` 取 a05 的 `not_active`（未启用）、`role_mismatch`（岗位不能接手客服工单）、`same_as_current`（就是当前负责人），以及 `out_of_scope`（不在操作人可指派的员工集合内；已请 a05 补登这个取值与可选的 `details.staffId`） | A77；`12-support.md:159-160`；d4-identity.md:1135 |
| 选人 | 分配、转派、登记“指定负责人”的候选：a01 `admin.staff.list?pool=cs,delivery_manager&withLoad=true`（两个池的启用成员，含不当班的；a01 已放开 `service.ticket.assign`、`service.ticket.transfer` 持有人对这两个池的只读）。“待处理 N 单”取 `openWorkBySource` 里 `source = service_ticket_owner`、`subjectType = service_ticket` 的一项（没有即 0）；“该商家服务经理”按行或详情的 `storeDeliveryManager` 标注，“当前负责人”按 `owner` 标注。登记弹窗的“本次轮到 X”另调 `admin.staff.list?recommendPool=cs`，取 `isRecommended = true` 的一位（只含当班成员；没有人当班时不显示） | a01-system 2.5、3.12；Service.dc.html:277-288 |
| 加锁顺序 | 轮流分配先锁 `assignment_cursor`（`lock_rank = 10`），再对选中员工 `FOR SHARE`；分配、转派先对目标员工行 `FOR SHARE` 并校验启用，再锁工单行（`lock_rank = 270`） | `12-support.md:52`；03-staff-authz-audit.md:389；d3-flow.md:647-653 |
| 状态迁移 | 一律经 `flow.transition()`（`machine = 'service_ticket'`、`state_field = 'status'`），写 `status_transition` 并在同一事务里写一条活动流审计（M31）；不改状态的分配、转派写 `from_state = to_state` 的一行。行锁 + 状态守卫；状态机表的守卫没有列 `lock_version`，状态迁移的请求体不带 `lockVersion`（A21、C53） | `12-support.md:130` |
| 幂等 | 写接口一律 `required`（A17）：同键重放返回上次成功的结果 | C47 |
| 结果脱敏 | 写接口的响应 `AdminServiceTicketWriteResult`（2.5）带图片签名地址，按 C50“结果脱敏”处理（A80、A124）：幂等记录只存置空后的结果，路由元数据 `x-redact-on-replay` = [`images[].url`, `images[].expiresAt`, `entries[].images[].url`, `entries[].images[].expiresAt`]，这四处在写接口的响应 schema 里声明为可空；响应带 `replayed: boolean`（首次执行为 `false`，同键重放为 `true` 且上述字段为 `null`），端上见到 `true` 时重调 `admin.serviceTicket.get` 取地址 | C50、C75；A80、A124 |
| 审计 | 状态迁移与不改状态的分配、转派由 `flow.transition()` 在同一事务里写活动流审计（M31）。不经 `transition()` 的内容编辑（改类型与优先级、补关联、移除关联）由用例写一行 `audit_log`：`stream = activity`、`category = service_ticket`、`target_type = service_ticket`、`target_id` = 工单 id，带前后值（类别 `service_ticket` 按 A107、A146 进 07 主文档的待回写清单；a02 第 2.7 节“类别 → 菜单模块”已登记为 `service`，a02-workbench-report.md:220）。人工纠偏写 `ops` 审计（`category = flow`，与 a05 交付工单的人工纠偏同一写法） | `12-support.md:130`、`351`；03-staff-authz-audit.md:570、931 |
| 图片 | 员工上传的图片先经 a01 的 `admin.file.create` → 直传 → `admin.file.complete` 拿到已入库的 `fileId`，分类 `ticket_attachment`（a01 的后台上传对这一分类按 `service.ticket.reply` 判权，a01-system.md:581；登记工单的员工须同时持有该键才能带图）；本文接口在业务事务里调 `files.link()`（`ref_type` 为 `service_ticket` 或 `service_ticket_entry`，角色 `image`）。不可用（未入库、分类不符、被拦截、不是本人上传）返回 400 `FILE_NOT_USABLE`（m03 定义）。读地址随响应现签，30 分钟对齐窗口（C60、C61），表达为 `ImageRef` | `12-support.md:173-179`；d5-media.md:278 |
| 手机号 | 只返回脱敏串 `contactPhoneMask`；明文走 a01 的 `admin.piiReveal.create`（`subjectType = service_ticket`、`field = contactPhone`，权限点 `pii.phone.reveal`），GET 不写库（A19、C40） | a01-system 3.41 的对照表 |
| 时刻 | ISO 8601、UTC、以 `Z` 结尾（C34）。“剩 21 分钟”“超时 8 分钟”这类倒计时由前端按截止时刻与本机时钟算，接口不下发分钟数 | C34；proto-admin-c.md:378 |
| 开放枚举 | 响应里的状态、类型、阶段类枚举都标 `x-open-enum`，前端对未知值兜底展示（C37） | C37 |
| 限流 | 全部 `admin.global` | C68 |
| 轮询 | 工单池计数每 30 秒静默刷新（d7-platform.md:1052）；详情页建议 30 秒轮询，商家补充消息到达时即可看到（proto-admin-c.md:432）。商家补充说明（m08 `m.serviceTicket.entry.create`）写一条 `merchant_message` / `supplement` 条目并发 `service_ticket.supplemented`（不改状态、不写状态历史），通知订阅者给负责人发 `s.kf_supplemented`（a09-ops.md:567）；该事件已进 12 分组事件清单（`12-support.md:191`，A144），x01 目录待补登 | A144；`12-support.md:191` |

## 2. 公共结构

### 2.1 引用的共用结构

| 结构 | 定义处 | 本文用法 |
| --- | --- | --- |
| `StaffBrief` | a01-system 2.2 的后台版：`staffId`、`staffNo`、`name`、`roleKey`、`isLead`、`status`（m08 对商家展示的员工结构已改名 `MerchantStaffBrief`，不是这一个） | 负责人、登记人、员工条目的发送人、门店交付经理；前端渲染为“唐悦（客服主管）”（`roleKey` + `isLead`） |
| `AdminPage<T>` | a01-system 2.1：`items`、`page`、`pageSize`、`total` | 列表分页（C43） |
| `ImageRef` | m08-support-misc 2.1：`fileId`、`url`、`expiresAt` | 工单与条目图片；写接口的响应里 `url`、`expiresAt` 在同键重放时为 `null`（1.1“结果脱敏”） |
| `EntryLink` | m08-support-misc 2.1：`route`、`params`、`label` | 条目上的深链按钮（`service_ticket_entry.link`） |
| `DictRef` | 约定 C85、C87：`code`、`name` | 工单行与详情的 `type`、详情的 `withdrawReason`（A151）；请求仍收 `typeCode` |

### 2.2 `ServiceTicketRefBrief` 与 `ServiceTicketRefView` 关联业务

工单与业务对象的关联只在 `service_ticket_ref`（`12-support.md:329-370`）。support 不同步调用 order、delivery，关联对象的展示信息由路由层的读模型按 `ref_type` 组装（`12-support.md:481`）。

`ServiceTicketRefBrief`（工单池“商家与单号”一栏）：

| 字段 | 类型 | 必有 | 说明 | 来源（表.列 或计算规则） |
| --- | --- | --- | --- | --- |
| `refType` | enum(`ServiceTicketRefType`) | 是 | `drama_order` 或 `billing_order` | `service_ticket_ref.ref_type` |
| `refId` | string(uuid) | 是 | 对象 id | `service_ticket_ref.ref_id` |
| `no` | string | 是 | 订购单号（`LYX…`）或付款单号（`FK…`） | `drama_order.order_no`、`billing_order.order_no` |

取法：`ref_type` 为 `drama_order` 或 `billing_order` 的行里 `service_ticket_ref.created_at` 最早的一条；没有为 `null`（前端显示“未关联订单”）（`12-support.md:370`）。商家端 m08 的 `relatedOrder` 只取 `drama_order` 最早的一行，与本字段取法不同，两边各写各的查询，不共用。

`ServiceTicketRefView`（详情“关联业务”卡片，每个关联一行）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `refType` | enum(`ServiceTicketRefType`) | 是 | 五类之一 | `service_ticket_ref.ref_type` |
| `refId` | string(uuid) | 是 | 对象 id | `service_ticket_ref.ref_id` |
| `linkedAt` | string(date-time) | 是 | 建立关联的时间 | `service_ticket_ref.created_at` |
| `no` | string \| null | 是 | 对象的单号；审批单没有单号时为 `null` | 见下表 |
| `status` | string | 是 | 对象的当前状态，取值同各表的状态列（`x-open-enum`），前端按数据模型的取值显示中文 | 见下表 |
| `detail` | object | 是 | 按 `refType` 取下表之一 | 见下表 |

| `refType` | `no` | `status` | `detail` 的字段 |
| --- | --- | --- | --- |
| `drama_order` | `drama_order.order_no` | `drama_order.status` | `dramaTitles`：array<string>，各订单项的剧名（`order_item.drama_id` → `drama.title`，按 `order_item.item_no` 升序）；`itemCount`：`drama_order.item_count`；`totalChargePoints`：integer(积分)，`drama_order.total_charge_points`；`deliveryTickets`：array<{ `deliveryTicketId`（`delivery_ticket.id`）、`ticketNo`（`delivery_ticket.ticket_no`）、`dramaTitle`（`drama.title`）、`episodeCount`（`order_item.episode_count`）、`productionModel`（`order_item.production_model`）、`step`（`delivery_ticket.step`） }>，即该订购单名下的交付工单（`delivery_ticket.drama_order_id`），由读模型按订购单组装、不在关联表里补行（`12-support.md:333`；原型“交付工单 × 2”） |
| `billing_order` | `billing_order.order_no` | `billing_order.status` | `type`：`billing_order.type`；`amountFen`：integer(分)，`billing_order.amount_fen`；`channel`：`billing_order.channel` |
| `delivery_ticket` | `delivery_ticket.ticket_no` | `delivery_ticket.step` | `dramaTitle`：`drama.title`（`delivery_ticket.drama_id`）；`dramaOrderId`：`delivery_ticket.drama_order_id` |
| `ad` | `ad.ad_no` | `ad.status` | `type`：`ad.type`；`durationSec`：integer，`ad.duration_sec`；`copy`：string \| null，`ad.copy`（原型“片尾贴片 10 秒 · 国庆双人套餐”） |
| `approval_request` | `approval_request.request_no` | `approval_request.status` | `kind`：`approval_request.kind`；`submittedAt`：`approval_request.submitted_at` |

关联对象已不在数据模型里（被不变量 `support.S3` 报告的那类异常）时，该行 `no` 为 `null`、`status` 为 `unknown`、`detail` 为 `{}`，不让整个详情失败。点击跳转由前端按 `refType` 拼后台路由（订单详情、交付工单详情、广告任务、付款单、审批详情）。

关联行的来源与增删：登记时随 3.3 写入；处理中由员工补关联（3.12）、移除关联错的行（3.13，物理删除，M95），两者只处理 `drama_order`、`billing_order`、`delivery_ticket`、`ad` 四类（`ServiceTicketLinkableRefType`）。`approval_request` 行只由从工单发起取消、退款的接口写入（a05 `admin.order.cancelRequest.create`、`admin.ad.cancelRequest.create`，a07 `admin.paymentOrder.refundRequest.create`，请求体带 `serviceTicketId`），本文不增删这一类，前端对它不显示“移除”。

### 2.3 `ServiceTicketSlaView` 服务时效

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `phase` | enum(`ServiceSlaPhase`) | 是 | 时效阶段，列表“时效”一栏与详情时效卡的主状态，判定见下 | 计算 |
| `response` | object \| null | 是 | 响应时限这一段；工单没有 `sla_snapshot.response` 段（后台登记且从未重开）时为 `null` | 见下 |
| `response.dueAt` | string(date-time) \| null | 是 | 当前一轮的响应截止时间；已回复或已离开待受理、处理中时为 `null` | `service_ticket.response_due_at` |
| `response.limit` | `SlaLimit` | 是 | “时限 30 分钟” | `service_ticket.sla_snapshot` 的 `response` 段（`amount`、`unit`） |
| `response.firstResponseAt` | string(date-time) \| null | 是 | 首次回复商家的时间 | `service_ticket.first_response_at` |
| `response.firstResponseWorkMin` | integer \| null | 是 | 首次响应“用时 12 分钟”（工作分钟）；`firstResponseAt` 为空时为 `null` | 计算：`workingMinutesBetween(service_ticket.created_at, service_ticket.first_response_at)`（kernel 的工作日历函数），与“客服首次响应时长”指标同一口径（d3-flow.md:2595；`12-support.md:76`、`171`）。不取 `event = 'reply'` 那一行的 `elapsed_work_min`：按 A144 它是与同一链上一行之间的一段（待受理期间的分配、超时升级、日历重算等 from = to 的行照常切段，01-kernel-flow.md:444），不是首次响应用时 |
| `response.escalatedAt` | string(date-time) \| null | 是 | 最近一次响应超时、升级至客服主管的时间（可能是重开之前那一轮的；这一轮是否已升级看 2.4 的 `statusNotes`） | `service_ticket.escalated_at` |
| `solution` | object | 是 | 处理方案这一段 | 见下 |
| `solution.dueAt` | string(date-time) | 是 | 方案截止（创建 + 24 自然小时） | `service_ticket.solution_due_at` |
| `solution.limit` | `SlaLimit` | 是 | “时限 24 小时” | `service_ticket.sla_snapshot` 的 `solution` 段 |
| `solution.at` | string(date-time) \| null | 是 | 首次给出方案的时间 | `service_ticket.solution_at` |
| `solution.elapsedMin` | integer \| null | 是 | 方案“用时 18 小时 25 分钟”（自然分钟） | 计算：`solution_at` − `created_at`，向下取整到分钟 |
| `autoResolve` | object \| null | 是 | 等待商家确认这一段；从未进入待商家确认时为 `null` | 见下 |
| `autoResolve.awaitingConfirmAt` | string(date-time) | 是 | 最近一次进入待商家确认的时间 | `service_ticket.awaiting_confirm_at` |
| `autoResolve.autoResolveAt` | string(date-time) \| null | 是 | “10-03 10:32 前未确认将自动解决”；离开待商家确认后为 `null` | `service_ticket.auto_resolve_at` |
| `autoResolve.limit` | `SlaLimit` \| null | 是 | “3 天” | `service_ticket.sla_snapshot` 的 `autoResolve` 段 |

`SlaLimit`：`amount`（integer）、`unit`（enum：`work_minutes` / `work_days` / `natural_hours` / `natural_days` / `same_day_cutoff`），取自 `SlaSnapshot` 的同名键（`12-support.md:435-443`）。快照里的 `policy`、`calendarVersion`、`computedAt` 不下发。

`phase` 的判定（按顺序取第一条成立的）：

| 条件 | `phase` | 原型显示 |
| --- | --- | --- |
| `status = 'closed'` | `closed` | 已关闭 + `closedAt` |
| `status = 'resolved'` | `resolved` | 已解决 + `resolvedAt` |
| `status = 'awaiting_confirm'` | `awaiting_confirm` | 自动解决 + `autoResolveAt` |
| `response_due_at` 非空且早于当前时刻 | `response_overdue` | 超时 N 分钟（整行标红） |
| `response_due_at` 非空 | `response_pending` | 剩 N 分钟 · 响应截止 hh:mm |
| `solution_at` 非空 | `solution_given` | 已给出方案 + `solutionAt` |
| `solution_due_at` 早于当前时刻 | `solution_overdue` | 方案超时（原型没画，按超时色） |
| 其余 | `solution_pending` | 方案截止 + `solutionDueAt`（后台登记的工单） |

### 2.4 `AdminServiceTicketRow` 工单池的一行

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `serviceTicketId` | string(uuid) | 是 | 工单 id | `service_ticket.id` |
| `ticketNo` | string | 是 | 工单号（`KF20260929011`） | `service_ticket.ticket_no` |
| `source` | enum(`ServiceTicketSource`) | 是 | 小程序 / 在线客服 / 电话 | `service_ticket.source` |
| `createdAt` | string(date-time) | 是 | 提交或登记时间 | `service_ticket.created_at` |
| `storeId` | string(uuid) | 是 | 门店 | `service_ticket.store_id` |
| `storeName` | string \| null | 是 | 门店名（“XX 火锅（万达店）”）；未建档完成的门店可能为空 | `store.name` |
| `primaryRef` | `ServiceTicketRefBrief` \| null | 是 | “商家与单号”一栏的单号 | 2.2 |
| `type` | `DictRef` | 是 | 问题类型 `{ code, name }`（字典 `ticket_type`；C85、A151；`type_code` 非空，恒有值；原 `typeCode` + `typeName` 合并）；名称按当前字典取，字典项停用后仍返回 | `service_ticket.type_code`，名称取 `dict_item.name`（`dict_item.dict_type_key = 'ticket_type'`；`12-support.md:63`） |
| `description` | string | 是 | 问题描述全文；表格截断显示，悬浮看全文 | `service_ticket.description` |
| `priority` | enum(`ServiceTicketPriority`) | 是 | 高 / 中 / 低 | `service_ticket.priority` |
| `status` | enum(`ServiceTicketStatus`) | 是 | 同数据模型 | `service_ticket.status` |
| `statusNotes` | array<enum(`ServiceTicketStatusNote`)> | 是 | 状态副说明，判定见下；没有为 `[]` | 计算 |
| `sla` | object | 是 | 列表用的时效摘要：`phase`（同 2.3）、`responseDueAt`、`solutionDueAt`、`solutionAt`、`autoResolveAt`、`resolvedAt`、`closedAt`（均为 string(date-time) \| null，`solutionDueAt` 必有） | `service_ticket` 同名蛇形列 |
| `owner` | `StaffBrief` \| null | 是 | 负责人；没有为 `null`（显示“待分配”） | `service_ticket.owner_staff_id` → `staff` |
| `storeDeliveryManager` | `StaffBrief` \| null | 是 | 门店的交付经理：分配弹窗给候选人标“该商家服务经理”，详情工单信息卡“服务经理 林晓”；门店未分配交付经理时为 `null` | `store.delivery_manager_id` → `staff` |
| `actions` | array<enum(`AdminServiceTicketAction`)> | 是 | 当前员工此刻可执行的动作（C16），列表只计算 `assign`、`reassign`（原型“分配”按钮：没有负责人时对应 `assign`，有负责人时对应 `reassign`） | 计算，规则同 2.5 |

`statusNotes` 的取值：

| 取值 | 条件 | 原型文案 |
| --- | --- | --- |
| `escalated` | 这一轮已超时升级：`service_ticket.escalated_at` 非空、`service_ticket.response_due_at` 非空（这一轮仍未响应），且 `escalated_at >= sla_snapshot.response.computedAt`（这一轮的起算时刻：提交或重新打开，日历重算不改它，`12-support.md:189`、`433`）。`escalated_at` 只存最近一次超时、回复与重开都不清空（`12-support.md:84`、`170`），不加第三个条件的话，上一轮升级过的工单一重开就会误显示 | 已升级至客服主管 |
| `with_store_manager` | 负责人是该门店的交付经理（`service_ticket.owner_staff_id = store.delivery_manager_id`） | 已转派交付经理 |
| `cancel_pending_approval` | 关联了 `approval_request.kind` ∈ (`order_cancel`, `ad_cancel`, `qualification_cancel`) 且 `approval_request.status = 'pending'` 的审批单 | 取消待财务审批 |
| `refund_pending_approval` | 关联了 `approval_request.kind = 'plan_refund'` 且 `approval_request.status = 'pending'` 的审批单 | 退款待财务审批（原型没画，同一口径补） |

两个审批类副说明是派生的（`12-support.md:90`），读 `service_ticket_ref`（`ref_type = 'approval_request'`）关联的审批单，不在工单上加列。

### 2.5 `AdminServiceTicketDetail` 工单详情

`admin.serviceTicket.get` 的响应；本文全部写接口的响应是它加 `replayed`（`AdminServiceTicketWriteResult`，见本节末尾）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| （`AdminServiceTicketRow` 除 `actions` 外的全部字段，含 `storeDeliveryManager`） | | 是 | 页头：工单号、状态、类型、优先级、商家、来源与提交时间、关联订购单链接；工单信息卡的“服务经理 林晓”即 `storeDeliveryManager` | 2.4 |
| `entityId` | string(uuid) | 是 | 所属主体 | `service_ticket.entity_id` |
| `storeTicketCount` | integer | 是 | “累计工单 3 个”：该门店的工单总数（含本单） | 计算：`service_ticket` 按 `store_id` 计数（`ix_service_ticket_store_id_created_at`） |
| `submitter` | object \| null | 是 | 提出问题的商家用户；后台登记未填时为 `null` | `service_ticket.submitter_user_id` |
| `submitter.merchantUserId` | string(uuid) | 是 | 商家用户 | `service_ticket.submitter_user_id` |
| `submitter.displayName` | string \| null | 是 | “王先生”：该用户在本主体的成员称呼，没有则取账号称呼；账号已注销为 `null` | `entity_member.display_name`（`entity_member.entity_id = service_ticket.entity_id`），为空取 `merchant_user.display_name` |
| `contactPhoneMask` | string \| null | 是 | 联系电话脱敏串（“138****5678”）；明文走 `admin.piiReveal.create` | `service_ticket.contact_phone_mask` |
| `registeredBy` | `StaffBrief` \| null | 是 | 后台登记人；小程序提交为 `null` | `service_ticket.registered_by_staff_id` → `staff` |
| `images` | array<`ImageRef`> | 是 | 问题图片；没有为 `[]` | `service_ticket.image_file_ids` |
| `slaDetail` | `ServiceTicketSlaView` | 是 | 服务时效卡 | 2.3 |
| `resolvedVia` | enum(`ServiceTicketResolvedVia`) \| null | 是 | 商家确认 / 到期自动解决 | `service_ticket.resolved_via` |
| `closeReason` | enum(`ServiceTicketCloseReason`) \| null | 是 | 关闭原因 | `service_ticket.close_reason` |
| `closeNote` | string \| null | 是 | 员工关闭时填的说明 | `service_ticket.close_note` |
| `withdrawReason` | `DictRef` \| null | 是 | 商家撤回时选的原因 `{ code, name }`（“问题已解决”取 `name`）；不是商家撤回为 `null`（C85、A151；原 `withdrawReasonCode` + `withdrawReasonName` 合并） | `service_ticket.withdraw_reason_code`（`12-support.md:72`），名称取 `dict_item.name`（`dict_item.dict_type_key = 'ticket_withdraw_reason'`） |
| `reopenedCount` | integer | 是 | 商家重新打开的次数（人工纠偏不计） | `service_ticket.reopened_count` |
| `refs` | array<`ServiceTicketRefView`> | 是 | 关联业务，按 `linkedAt` 升序；没有为 `[]` | 2.2 |
| `entries` | array<`AdminServiceTicketEntry`> | 是 | 处理记录（“共 N 条”），全部条目（含内部备注与只给后台看的系统事件），按 `created_at`、`id` 升序；前端倒序展示。单张工单的条目量有限，不分页 | `service_ticket_entry`（`ix_service_ticket_entry_service_ticket_id_created_at`） |
| `composeModes` | array<enum(`ServiceTicketEntryKind`)> | 是 | 输入区此刻可用的模式：`staff_reply`（状态为 `pending` 或 `processing`）、`internal_note`（状态为 `processing`），且观察者持有 `service.ticket.reply`；为 `[]` 时隐藏输入区（已关闭时显示“工单已关闭，不能继续回复；商家再次反馈时请新建工单”） | 计算（`12-support.md:151-152`） |
| `actions` | array<enum(`AdminServiceTicketAction`)> | 是 | 当前员工此刻可执行的动作（C16），规则见下 | 计算 |
| `lockVersion` | integer | 是 | 工单的乐观锁版本号；改类型、改优先级（3.11）时带回，其余接口不带（状态迁移与关联增删用行锁，C53） | `service_ticket.lock_version` |

`actions` 的判定（“负责人规则”见 1.1）：

| 动作 | 条件 |
| --- | --- |
| `assign` | 状态 ∈ (`pending`, `processing`, `awaiting_confirm`)，`owner_staff_id` 为空，观察者持有 `service.ticket.assign`（仅主管） |
| `reassign` | 状态同上，`owner_staff_id` 非空，观察者持有 `service.ticket.transfer` 且满足负责人规则 |
| `submit-result` | 状态 = `processing`，观察者持有 `service.ticket.reply` 且满足负责人规则；待商家确认时按钮显示“等待商家确认”、已关闭时显示“工单已关闭”（由 `status` 决定） |
| `close` | 状态 ∈ (`pending`, `processing`, `awaiting_confirm`)，观察者持有 `service.ticket.close` 且满足负责人规则 |
| `force-transition` | 状态 = `closed`，观察者持有 `flow.admin.transition` |
| `update` | 状态 ∈ (`pending`, `processing`, `awaiting_confirm`)，观察者持有 `service.ticket.reply`（工单信息卡“问题类型”“优先级”的编辑入口） |
| `create-ref` | 状态 = `processing`，观察者持有 `service.ticket.reply`（关联业务卡“添加关联”） |
| `remove-ref` | 状态 ∈ (`pending`, `processing`, `awaiting_confirm`)，观察者持有 `service.ticket.reply`，且至少有一行 `refType` 不是 `approval_request` 的关联（关联业务卡逐行“移除”，`approval_request` 行不显示） |

`AdminServiceTicketWriteResult`（全部写接口的响应）：`AdminServiceTicketDetail` 的全部字段，另加 `replayed`（boolean，必有：首次执行为 `false`，同键重放为 `true`）。按 1.1“结果脱敏”，这个 schema 里 `images[].url`、`images[].expiresAt`、`entries[].images[].url`、`entries[].images[].expiresAt` 声明为可空，只在 `replayed = true` 时为 `null`；其余字段与详情相同。

`AdminServiceTicketEntry`（处理记录的一条）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `entryId` | string(uuid) | 是 | 条目 id | `service_ticket_entry.id` |
| `kind` | enum(`ServiceTicketEntryKind`) | 是 | 商家消息 / 回复商家 / 内部备注 / 系统事件 | `service_ticket_entry.kind` |
| `tag` | enum(`ServiceTicketEntryTag`) \| null | 是 | 标签：“小程序提交”“补充说明”“回复商家”“处理结果”等 | `service_ticket_entry.tag` |
| `actorType` | enum | 是 | `merchant` / `staff` / `system` / `partner` | `service_ticket_entry.actor_type` |
| `staff` | `StaffBrief` \| null | 是 | 员工条目的发送人（“唐悦 · 客服主管”），读取时取当前值、不快照（`12-support.md:279`）；其余为 `null` | `service_ticket_entry.actor_id` → `staff` |
| `merchant` | object \| null | 是 | 商家条目的发送人：`merchantUserId`、`displayName`（取法同 `submitter.displayName`）；其余为 `null` | `service_ticket_entry.actor_id` → `entity_member`、`merchant_user` |
| `client` | enum \| null | 是 | `weapp` / `portal` / `admin`；系统动作为 `null` | `service_ticket_entry.client` |
| `body` | string \| null | 是 | 正文；系统事件是后台文案（带内部人名与原因） | `service_ticket_entry.body` |
| `merchantBody` | string \| null | 是 | 系统事件面向商家的文案；只有商家可见的系统事件才有 | `service_ticket_entry.merchant_body` |
| `images` | array<`ImageRef`> | 是 | 图片；没有为 `[]` | `service_ticket_entry.image_file_ids` |
| `link` | `EntryLink` \| null | 是 | 商家端的深链按钮，后台只展示；本文写的员工条目与系统事件条目（分配、转派、提交结果、关闭、人工纠偏）不带深链，为 `null`（商家就在工单详情里看到它们）；业务事件条目的深链与 `label` 由 `support.onBizEvent` 填 | `service_ticket_entry.link` |
| `isVisibleToMerchant` | boolean | 是 | 商家是否可见；内部备注恒为 `false` | `service_ticket_entry.is_visible_to_merchant` |
| `isSolution` | boolean | 是 | 是否计为“处理方案” | `service_ticket_entry.is_solution` |
| `createdAt` | string(date-time) | 是 | 条目时间；业务事件条目为源事件发生时刻 | `service_ticket_entry.created_at` |

后台登记的工单，提交条目（`tag = 'submit'`）由登记人代录：`actorType = 'staff'`、`staff` 为登记人，前端显示为“{登记人}代录”（`12-support.md:266`）。

## 3. 接口

### 3.1 admin.serviceTicket.list　工单池列表

`GET /admin/service-tickets`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.serviceTicket.list`（路线图 `a08.service-tickets.list`） |
| 鉴权 | `staff`；模块 `service` ≥ v；数据范围 `scope: task`（1.1，A92） |
| 回显 | 无 |
| 幂等 | `none`（纯查询，A19） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Service（状态页签、筛选、表格、分页）；A:MerchantDetail“客服工单”页签（带 `storeId`） |
| 出处 | proto-admin-c.md:357-375；proto-admin-b.md:81；d3-flow.md:3535；`12-support.md:98-100`、`126-127`、`360` |

**请求**：路径参数、请求体：无。查询参数 `AdminServiceTicketListQuery`（C43–C45）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `tab` | enum(`AdminServiceTicketTab`) | 否 | 默认 `open` | `open` 待处理（待受理 + 处理中）/ `pending` / `processing` / `awaiting_confirm` / `resolved` / `closed` / `all` |
| `q` | string | 否 | 1–40 字符 | 关键词：以 `KF` 开头按工单号前缀；以 `LYX`、`FK`、`JF`、`GG` 开头按关联单号精确匹配（先把单号换成对象 id，再经 `ix_service_ticket_ref_ref_type_ref_id` 反查工单）；以上前缀都可带预发环境的前缀 `T`（`TKF…`、`TLYX…`，01-kernel-flow.md:133），单号识别与 a02 全局搜索共用同一个单号解析函数（a02-workbench-report 3.6）；其余按门店名包含 |
| `no` | string | 否 | 工单号全文（可带预发前缀 `T`） | 按工单号精确查找（C11；后台路由 `/service/tickets/$ticketNo` 进详情前用它把单号换成 id，d7-platform.md:982） |
| `storeId` | string(uuid) | 否 | 范围内的门店 | 商家详情页签 |
| `typeCode` | string | 否 | 可多值，逗号分隔 | 问题类型（字典 `ticket_type`） |
| `priority` | enum(`ServiceTicketPriority`) | 否 | 可多值 | 优先级 |
| `source` | enum(`ServiceTicketSource`) | 否 | 可多值 | 来源 |
| `ownerStaffId` | string(uuid) | 否 | 可多值 | 负责人 |
| `isUnassigned` | boolean | 否 | — | 只看没有负责人的工单（`ix_service_ticket_unassigned`） |
| `isResponseOverdue` | boolean | 否 | — | 仅看响应超时：`service_ticket.response_due_at` 非空且早于当前时刻（`ix_service_ticket_response_due_at`） |
| `createdFrom`、`createdTo` | string(date) | 否 | 两端都含 | 提交时间范围（北京时间） |
| `sort` | enum(`AdminServiceTicketSort`) | 否 | 见下 | 不传时：`open`、`pending`、`processing` 页签按 `urgency`，其余按 `-createdAt` |
| `page`、`pageSize` | integer | 否 | `pageSize` 默认 20、上限 100 | 原型每页 10 条，由前端传 `pageSize = 10` |

`sort` 的取值：`urgency`（按时效紧急程度）、`-createdAt`（提交时间倒序）、`createdAt`。`urgency` 的顺序：① 响应超时的在前，按 `response_due_at` 升序（超时最久的在最前）；② 其余按“当前截止时刻”升序：`response_due_at` 非空取它，否则 `solution_at` 为空时取 `solution_due_at`，否则取 `auto_resolve_at`；③ 都没有的排最后，按 `created_at` 升序；最后追加 `id`（C44）。

**响应**：`AdminPage<AdminServiceTicketRow>`（2.4）。

**错误**：只有通用错误（`PERMISSION_DENIED`：模块等级为 `n`）。

**副作用**：无。

**说明**：
- 页签计数、页首摘要不在本接口返回，调 3.2 `admin.serviceTicket.summary`（A23、C83）。
- 商家详情的“客服工单”页签（工单号、类型、问题描述、状态 + “已转派交付经理”、提交时间、负责人，proto-admin-b.md:81）用同一接口带 `storeId`、`tab = all`。
- 原型“分配”按钮只在“待受理”行出现（proto-admin-c.md:389 第 6 条）；按数据模型，没有负责人的未结工单都可以分配（`12-support.md:159`、`127`），有负责人的走转派。前端按行的 `actions` 显示：含 `assign` 或 `reassign` 都显示“分配”，分别调 3.8、3.9。两条接口的请求体同构（`toStaffId`、必选 `reasonCode`、选填 `note` 1–100 字），同一个弹窗不必按行切换校验；候选人与“该商家服务经理”标注见 1.1“选人”，门店交付经理取行上的 `storeDeliveryManager`。
- 导出按当前筛选导出，走 a02 的 `admin.exportJob.create`，导出键 `service_tickets.list`，`params` 与本接口的查询参数同构（去掉 `page`、`pageSize`），权限点 `service.export`（a02-workbench-report 2.14）。原型的同步导出 toast 不采用（ADR-038）。
- “响应超时”整行底色、时效文字分色由 `sla.phase` 决定；倒计时由前端算（1.1“时刻”）。

### 3.2 admin.serviceTicket.summary　页首摘要与页签计数

`GET /admin/service-tickets/summary`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.serviceTicket.summary`（路线图 `a08.service-tickets.summary`；草案推断为 `/counts`） |
| 鉴权 | `staff`；模块 `service` ≥ v；数据范围 `scope: task`（1.1） |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Service（页首“待处理 N 个 · 响应超时 N 个 · 今日已解决 N 个”与七个页签的计数）；A:MerchantDetail“客服工单（3）”页签角标 |
| 出处 | proto-admin-c.md:360-361；d7-platform.md:1052；C83 |

**请求**：查询参数 `AdminServiceTicketSummaryQuery` 与 3.1 相同，去掉 `tab`、`sort`、`page`、`pageSize`（C83）。原型的页签计数与页首摘要不随筛选变化：工单池页不传筛选条件调用；商家详情只传 `storeId`。传了筛选条件时按同一口径计数。

**响应**：`AdminServiceTicketSummary`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `counts` | object | 是 | 按页签计数，键与 `tab` 的取值一致：`open`、`pending`、`processing`、`awaiting_confirm`、`resolved`、`closed`、`all`，值为 integer | `service_ticket.status` 计数（`ix_service_ticket_status_created_at`） |
| `responseOverdue` | integer | 是 | “响应超时 N 个”：`response_due_at` 非空且早于当前时刻的工单数（只可能是待受理、处理中） | `service_ticket.response_due_at` |
| `resolvedToday` | integer | 是 | “今日已解决 N 个”：`status = 'resolved'` 且 `resolved_at` 落在今日（北京时间）的工单数 | `service_ticket.resolved_at` |
| `unassigned` | integer | 是 | 没有负责人的未结工单数（客服主管待办，原型没画数字，供页首或筛选提示用） | `service_ticket.owner_staff_id`（`ix_service_ticket_unassigned`） |
| `asOf` | string(date-time) | 是 | 计数时刻 | 计算 |

**错误**：只有通用错误（`PERMISSION_DENIED`：模块等级为 `n`）。

**副作用**：无。

**说明**：
- 页首的时效说明“工作时间内 30 分钟响应、24 小时内给出处理方案”由前端按参数文案展示；数值以参数 `sla.service.first_response`、`sla.service.solution` 为准（14-config-data.md:294），需要动态显示时取 m08 的 `ServiceManagerView.responsePromise` 同一来源。
- 左侧菜单“客服”角标由 a02 的 `admin.navBadge.get` 给，口径与 `counts.open` 一致；工作台待办 ⑨ 的“响应超时 N 个”与本接口的 `responseOverdue` 用同一个计数函数：`response_due_at` 非空且早于当前时刻，不看 `first_response_at`（重开后这一轮还没回复的工单也算，`12-support.md:220`）。a02 第二轮已按此改写（a02-workbench-report 2.3 第 ⑨ 项）。
- 商家详情的页签角标只传 `storeId`（a03 的请求）；导出 `service_tickets.list` 的参数与 3.1 的查询参数同构（a02 的请求，`AdminServiceTicketListQuery` 去掉 `page`、`pageSize`）。

### 3.3 admin.serviceTicket.create　登记工单

`POST /admin/service-tickets`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.serviceTicket.create`（路线图 `a08.service-tickets.create`） |
| 鉴权 | `staff`；权限点 `service.ticket.register`（客服、交付经理）；模块 `service` ≥ v；门店须在数据范围内（`scope: task` 的门店分支：范围为“全部”的员工任意门店，交付经理只限本人或本组负责的门店） |
| 回显 | 无 |
| 幂等 | `required`（创建并进入状态机，A17）；结果脱敏（1.1） |
| 乐观锁 | 无（新建） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Service“登记工单”弹窗 |
| 出处 | `12-support.md:150`、`176`、`185`、`449-451`；d3-flow.md:2508、2536、3535；proto-admin-c.md:372、385-386；PRD 7.8-1 |

**请求**：路径参数、查询参数：无。请求体 `AdminServiceTicketRegisterBody`：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `storeId` | string(uuid) | 是 | 范围内的门店 | 商家（门店下拉，候选取 a03 的 `admin.store.list?q=`）→ `service_ticket.store_id`；`entity_id` 从门店复制 |
| `source` | enum | 是 | `phone` / `online_chat`（不接受 `weapp`） | 来源 → `service_ticket.source` |
| `typeCode` | string | 是 | 字典 `ticket_type` 内且启用 | 问题类型 → `service_ticket.type_code` |
| `priority` | enum(`ServiceTicketPriority`) | 否 | `high` / `mid` / `low` | → `service_ticket.priority`；不传取字典项 `dict_item.ext.defaultPriority`（原型默认“中”） |
| `description` | string | 是 | 去掉首尾空白后 1–500 字 | 问题描述 → `service_ticket.description`，同时作为提交条目的正文 |
| `imageFileIds` | array<string(uuid)> | 否 | 0–9 个、不重复；分类 `ticket_attachment`、已入库、本人上传 | 问题图片 → `service_ticket.image_file_ids`（原型没画，数据模型允许） |
| `refs` | array<object> | 否 | 0–5 个，不重复 | 关联单号（原型“关联单号（按商家自动带出）”）→ `service_ticket_ref` |
| `refs[].refType` | enum(`ServiceTicketLinkableRefType`) | 是 | `drama_order` / `billing_order` / `delivery_ticket` / `ad` | 审批单的关联只由发起取消、退款的接口写入（2.2），这里不接受 |
| `refs[].refId` | string(uuid) | 是 | 对象属于该门店（付款单按主体比对，`billing_order.entity_id`） | 候选：a05 `admin.order.list?storeId=`、`admin.deliveryTicket.list?storeId=`、`admin.ad.list?storeId=`，a07 `admin.paymentOrder.list?entityId=` |
| `ownerMode` | enum(`ServiceTicketOwnerMode`) | 是 | `round_robin` / `specified` | 负责人：轮流分配或指定 |
| `ownerStaffId` | string(uuid) | 条件 | `ownerMode = specified` 时必填，须是可接手的员工（1.1）；`round_robin` 时不得传 | → `service_ticket.owner_staff_id` |
| `submitterUserId` | string(uuid) | 否 | 该门店所属主体的有效老板（`entity_member.role = 'owner'`、`entity_member.status = 'active'`） | 提出问题的商家用户 → `service_ticket.submitter_user_id`（候选取 a03 的 `admin.entity.member.list?role=owner`，响应 `{ items }`） |
| `phoneSource` | enum(`PhoneSource`) | 否 | `login` / `store_contact` / `input`（A25） | 联系电话的来源；不传则不记联系电话 |
| `contactPhone` | string | 条件 | `phoneSource = input` 时必填，中国大陆 11 位手机号；其余来源不得传 | 手填号码 |

联系电话由服务端补值（A25、C40）：`login` 取提交人的 `merchant_user.phone_enc` 解密（须同时传 `submitterUserId`）；`store_contact` 取 `store_profile.contact_phone_enc` 解密；`input` 取请求值。加密后写 `service_ticket.contact_phone_enc`，脱敏串写 `service_ticket.contact_phone_mask`。所选来源没有号码时 400 `VALIDATION_FAILED`（`fieldErrors.path = phoneSource`）。

**响应**：`AdminServiceTicketWriteResult`（2.5），即新工单加 `replayed`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `DICT_ITEM_DISABLED` | 409 | `typeCode` 不在字典里或已停用；`details = { dictTypeKey: 'ticket_type', code }`（m08 定义） |
| `ASSIGNEE_INVALID` | 409 | 指定的负责人不是可接手的员工（1.1）；`details.reason` 取 `not_active`、`role_mismatch`、`out_of_scope`（a05 定义） |
| `NOT_FOUND` | 404 | 门店不存在或不在数据范围内；`refs` 里的对象不存在或不属于该门店；`submitterUserId` 不是该主体的有效老板 |
| `FILE_NOT_USABLE` | 400 | 图片未入库、分类不是 `ticket_attachment`、不是本人上传或已被拦截（m03 定义） |
| `VALIDATION_FAILED` | 400 | 描述为空或超长；`source = weapp`；图片超过 9 张；`ownerStaffId` 与 `ownerMode` 不配；`phoneSource = login` 却没有 `submitterUserId`；号码格式不对或所选来源没有号码；`refs` 重复或类型不允许 |
| `PERMISSION_DENIED` | 403 | 没有 `service.ticket.register` |

**副作用**（同一事务）：
- 负责人：`round_robin` 时先调 `pickNext('cs', 'all')`（锁 `assignment_cursor`，在 `assignment_pool_member.pool = 'cs'`、`on_duty = true` 且员工启用的成员里轮流；d3-flow.md:647-653），没有人当班时负责人为空、进入客服主管待办（d3-flow.md:2536）；`specified` 时对目标员工行 `FOR SHARE` 并校验可接手。
- 状态迁移 `service_ticket.status: （新建）→ processing`（`register`，`12-support.md:150`）：工单号 `KF` + 8 位日期 + 3 位日流水（`biz_sequence`，当日超过 999 自动扩到 4 位）；`registered_by_staff_id` = 操作人；`solution_due_at` = 创建时刻 + 24 自然小时（参数 `sla.service.solution`）并写 `sla_snapshot.solution`；没有 `response_due_at` 与 `response` 段（后台登记的工单没有首次响应时限）。
- 写提交条目：`service_ticket_entry.kind = 'merchant_message'`、`tag = 'submit'`、`actor_type = 'staff'`（登记人代录）、`client = 'admin'`、`is_visible_to_merchant = true`，正文与图片同工单（`12-support.md:266`）。
- `refs` 各写一行 `service_ticket_ref`（`created_at` = 现在），之后发生的关联业务事件由订阅者 `support.onBizEvent` 追加进时间线（`12-support.md:335-350`）。
- 图片：工单与提交条目的图片各调一次 `files.link()`（`ref_type` 分别为 `service_ticket`、`service_ticket_entry`，`12-support.md:177`）。
- 定时器：登记 `service.solution_due`（去重键 `service.solution_due:service_ticket:{serviceTicketId}`，类型段用最终表名，A96、A144；与 `12-support.md:186` 一致）。
- `status_transition` 一行（`event = 'register'`，`payload` 带 `ownerStaffId`（可为 `null`）、`responseDueAt: null`、`solutionDueAt`，`12-support.md:459-461`）与活动流审计。
- 出站事件 `service_ticket.created`：通知订阅者给负责人发 `s.kf_assigned`（企业微信 + 站内）；字典项 `ext.notifyLead` 为真（“投诉建议”类）时另给客服主管发 `s.complaint_created`（d6-notify-docs-data.md:265-267）。埋点 `ticket_submit` 只计商家提交，不由本接口派生（x01-events-jobs 3.12）。

**说明**：
- 原型“登记后直接进入‘处理中’，须在 24 小时内给出处理方案”（proto-admin-c.md:372）；方案时限按自然时间（proto-admin-c.md:386 第 3 条），跨假期照算。
- “当班客服轮流分配，本次轮到唐悦”：弹窗打开时调 a01 的 `admin.staff.list?recommendPool=cs`，取 `isRecommended = true` 的那一位展示；真正分配在本接口事务里由 `pickNext` 决定，并发时可能不同（a01-system 3.12 说明）。选“指定”时的候选按 1.1“选人”（`pool=cs,delivery_manager&withLoad=true`，含不当班的人）。当班开关由 a01 的 `admin.staff.duty.update` 维护。
- 已停用门店也可以登记（停用门店的老板仍能查看工单，d4-identity.md:869），数据模型没有对应守卫。
- 在线客服用微信客服接待，后台只把它当来源登记，不接入会话内容（05-risks-and-open-issues.md:24）。

### 3.4 admin.serviceTicket.get　工单详情

`GET /admin/service-tickets/{serviceTicketId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.serviceTicket.get`（路线图 `a08.service-tickets.get`） |
| 鉴权 | `staff`；模块 `service` ≥ v；数据范围 `scope: task`（1.1） |
| 回显 | 无 |
| 幂等 | `none`（纯查询；GET 不写库，A19） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:ServiceDetail（页头、处理记录、服务时效、工单信息、关联业务、按钮可用性） |
| 出处 | proto-admin-c.md:398-439；d3-flow.md:3535；`12-support.md:234-279`、`328-360`、`415-441` |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `serviceTicketId` | string(uuid) | 是 | 范围内的工单 | — |

**响应**：`AdminServiceTicketDetail`（2.5）。`Cache-Control: no-store`（含签名地址，C18）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 工单不存在或不在数据范围内 |

**副作用**：无。

**说明**：
- 页面与字段的对应：页头（工单号、状态、类型、优先级、商家、来源与提交时间、关联订购单链接 = `primaryRef`）；处理记录（`entries`，图例四类：商家消息、回复商家、内部备注、系统事件）；服务时效（`slaDetail`：首次响应“09-29 15:32 · 用时 12 分钟（时限 30 分钟）”、处理方案“用时 18 小时 25 分钟（时限 24 小时）”、等待商家确认、已关闭）；工单信息（商家、服务经理 + 累计工单、问题类型、优先级、提交人 + 脱敏电话、负责人）；关联业务（`refs`）。
- 系统事件条目同时带后台文案 `body` 与商家文案 `merchantBody`，后台显示 `body`；`isVisibleToMerchant` 可用于在条目上标“商家可见”。
- 原型的状态映射只有处理中 / 待商家确认 / 已关闭（proto-admin-c.md:436 第 2 条）；本接口按数据模型返回五种状态，已解决与重新打开的呈现按 `status`、`reopenedCount` 补（设计规范第 12 节的默认做法）。
- 工单信息卡的“问题类型”“优先级”编辑调 3.11（带 `lockVersion`）；关联业务卡的“添加关联”“移除”调 3.12、3.13；入口按 `actions` 显示（原型没画，已列入设计规范第 12 节待补原型，A146）。
- 快捷回复入口（V1.1）调 3.14。

### 3.5 admin.serviceTicket.entry.create　回复商家、写内部备注

`POST /admin/service-tickets/{serviceTicketId}/entries`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.serviceTicket.entry.create`（路线图 `a08.service-ticket-entries.create`） |
| 鉴权 | `staff`；权限点 `service.ticket.reply`（负责人或有权限的员工，`12-support.md:151`）；模块 `service` ≥ v；数据范围 `scope: task`（1.1） |
| 回显 | 无 |
| 幂等 | `required`（防重复发送；首次回复是状态迁移，A17）；结果脱敏（1.1） |
| 乐观锁 | 不带 `lockVersion`（`12-support.md:151-152` 的守卫没有列锁版本，C53）；行锁 + 状态守卫 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:ServiceDetail 输入区（“回复商家 / 内部备注”切换、添加图片、“此回复为处理方案”） |
| 出处 | `12-support.md:151-152`、`176`、`184-185`、`269-273`；d3-flow.md:2509-2510、2516-2519；proto-admin-c.md:415-416 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `serviceTicketId` | string(uuid) | 是 | 范围内的工单 | — |
| 请求体（`AdminServiceTicketEntryCreateBody`） | `kind` | enum | 是 | `staff_reply` 回复商家 / `internal_note` 内部备注 | → `service_ticket_entry.kind` |
| 请求体 | `body` | string | 是 | 去掉首尾空白后 1–500 字 | → `service_ticket_entry.body`（原型要求有正文，“请输入内容后再发送”） |
| 请求体 | `imageFileIds` | array<string(uuid)> | 否 | 0–9 个；分类 `ticket_attachment`、已入库、本人上传 | → `service_ticket_entry.image_file_ids`（原型一次 1 张；数据模型员工回复同样至多 9 张，`12-support.md:521`） |
| 请求体 | `isSolution` | boolean | 否 | 默认 `false`；只对 `staff_reply` 有意义，`internal_note` 传 `true` 返回 400 | “此回复为处理方案” → `tag = 'solution'`、`is_solution = true` |

**响应**：`AdminServiceTicketWriteResult`（2.5）。首次回复会改变状态与时效，直接返回整张工单。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | `staff_reply`：工单不在 `pending`、`processing`；`internal_note`：工单不在 `processing`（数据模型只在这两行允许写条目，见第 6 节第 1 项） |
| `FILE_NOT_USABLE` | 400 | 图片不可用 |
| `NOT_FOUND` | 404 | 工单不存在或不在数据范围内 |
| `VALIDATION_FAILED` | 400 | 正文为空或超长；图片超过 9 张；内部备注勾了处理方案 |
| `PERMISSION_DENIED` | 403 | 没有 `service.ticket.reply` |

**副作用**（同一事务）：
- 写条目：`staff_reply` 时 `tag` 为 `solution`（勾选处理方案）或 `reply`，`is_visible_to_merchant = true`；`internal_note` 时 `tag` 为空、`is_visible_to_merchant = false`；`actor_type = 'staff'`、`actor_id` = 操作人、`client = 'admin'`。带图时 `files.link()`（`ref_type = 'service_ticket_entry'`，角色 `image`）。
- 回复且工单在 `pending`：状态迁移 `service_ticket.status: pending → processing`（`reply`，`12-support.md:151`）：写 `first_response_at`（只写一次）、清空 `response_due_at`；`status_transition` 一行（`event = 'reply'`；该行的 `elapsed_work_min` 只是与同一链上一行之间的一段，A144；首次响应用时按 `created_at` 到 `first_response_at` 的工作分钟算，见 2.3，与 `12-support.md:171` 一致）与活动流审计。回复人不因此成为负责人。
- 回复且工单在 `processing`：状态不变，不写状态历史（`12-support.md:152`）；`response_due_at` 非空（重新打开后这一轮还没回复）时清空。
- 回复清空了 `response_due_at` 时，取消这一轮的 `service.first_response_due`（去重键 `service.first_response_due:service_ticket:{serviceTicketId}:r{reopened_count}`，A96；`12-support.md:185`）。
- 勾选处理方案且 `solution_at` 为空：写 `solution_at`，取消 `service.solution_due`（`12-support.md:186`）。
- 出站事件：回复发 `service_ticket.replied`（载荷 `entryId`、`isFirstResponse`）；通知订阅者给提交人发 `m.ticket_reply`（站内消息必达，订阅消息有额度才发；后台登记、没有提交人的发给该门店老板，13-notify-docs.md:147；05-risks-and-open-issues.md:172）。内部备注不发事件、不通知商家。

**说明**：
- 原型提示“回复将通过小程序订阅消息通知商家”（proto-admin-c.md:415）；订阅消息受一次性授权额度限制，站内消息必达，文案按此调整。
- 处理方案的判定：勾选了“此回复为处理方案”的回复，或提交处理结果，取较早者（d3-flow.md:2521）。原型输入区没画勾选框（proto-admin-c.md:435 第 1 条），按数据模型补。
- 商家端只查商家可见的条目，内部备注从不下发（m08 `m.serviceTicket.get`）。

### 3.6 admin.serviceTicket.submitResult　提交处理结果

`POST /admin/service-tickets/{serviceTicketId}/submit-result`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.serviceTicket.submitResult`（路线图 `a08.service-tickets.submit-result`；草案 `POST …/result`） |
| 鉴权 | `staff`；权限点 `service.ticket.reply`；负责人规则（1.1）；模块 `service` ≥ v；数据范围 `scope: task` |
| 回显 | 无 |
| 幂等 | `required`（状态迁移，A17）；结果脱敏（1.1） |
| 乐观锁 | 不带 `lockVersion`（`12-support.md:153` 的守卫只有“结果非空”）；行锁 + 状态守卫 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:ServiceDetail“提交处理结果”弹窗 |
| 出处 | `12-support.md:153`、`186`、`271`、`421`；d3-flow.md:2511；proto-admin-c.md:419 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `serviceTicketId` | string(uuid) | 是 | 范围内的工单 | — |
| 请求体（`AdminServiceTicketSubmitResultBody`） | `result` | string | 是 | 去掉首尾空白后 1–500 字 | 处理结果 → 结果条目的正文 |

**响应**：`AdminServiceTicketWriteResult`（2.5）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 工单不是 `processing`（待商家确认时按钮显示“等待商家确认”） |
| `SERVICE_TICKET_NOT_OWNER` | 403 | 观察者不是当前负责人，也不是主管或超级管理员；`details = { ownerStaffId }` |
| `NOT_FOUND` | 404 | 工单不存在或不在数据范围内 |
| `VALIDATION_FAILED` | 400 | 结果为空或超长 |
| `PERMISSION_DENIED` | 403 | 没有 `service.ticket.reply` |

**副作用**（同一事务）：
- 状态迁移 `service_ticket.status: processing → awaiting_confirm`（`submit_result`，`12-support.md:153`）：`solution_at`（为空时写现在）；`awaiting_confirm_at` = 现在；`auto_resolve_at` = 现在 + 3 个自然日（参数 `sla.service.auto_resolve`，精确到分钟）并写 `sla_snapshot.autoResolve`；清空 `response_due_at`。
- 写两条条目：处理结果（`kind = 'staff_reply'`、`tag = 'result'`、`is_solution = true`、商家可见，正文为 `result`）；系统事件（`tag = 'status'`，`body`“状态变更为待商家确认；{autoResolveAt} 前未确认将自动解决”，`merchant_body`“处理结果已提交，请确认问题是否已解决”，商家可见）。
- 定时器：登记 `service.auto_resolve`（关键类，去重键 `service.auto_resolve:service_ticket:{serviceTicketId}:{awaiting_confirm_at 的 Unix 毫秒数}`，A96；`12-support.md:187`）；`response_due_at` 原本非空时取消这一轮的 `service.first_response_due`；`solution_at` 原本为空时取消 `service.solution_due`。
- `status_transition` 一行（`event = 'submit_result'`）与活动流审计；出站事件 `service_ticket.result_submitted`（载荷 `autoResolveAt`），通知订阅者给提交人发 `m.ticket_reply`（d6-notify-docs-data.md:243）。

**说明**：3 个自然日内商家未确认，由定时器 `service.auto_resolve` 自动解决（`awaiting_confirm → resolved`，`resolved_via = auto`，`12-support.md:155`），属非 HTTP 迁移，归 x01-events-jobs 的归属表。商家确认、重新打开在 m08（`m.serviceTicket.confirm`、`m.serviceTicket.reopen`）。

### 3.7 admin.serviceTicket.close　关闭工单

`POST /admin/service-tickets/{serviceTicketId}/close`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.serviceTicket.close`（路线图 `a08.service-tickets.close`） |
| 鉴权 | `staff`；权限点 `service.ticket.close`；负责人规则（1.1）；模块 `service` ≥ v；数据范围 `scope: task` |
| 回显 | 无（关闭弹窗即二次确认，proto-admin-c.md:420） |
| 幂等 | `required`（状态迁移，A17）；结果脱敏（1.1） |
| 乐观锁 | 不带 `lockVersion`（`12-support.md:158` 的守卫没有列锁版本）；行锁 + 状态守卫 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:ServiceDetail“关闭工单”弹窗 |
| 出处 | `12-support.md:158`、`71-73`、`177`、`184-186`；d3-flow.md:2516；proto-admin-c.md:420、438 第 4 条；PRD 7.8-3 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `serviceTicketId` | string(uuid) | 是 | 范围内的工单 | — |
| 请求体（`AdminServiceTicketCloseBody`） | `closeReason` | enum(`ServiceTicketCloseReason`) | 是 | `duplicate` 重复工单 / `invalid` 无效工单 / `withdrawn` 商家撤回 | → `service_ticket.close_reason` |
| 请求体 | `closeNote` | string | 是 | 去掉首尾空白后 1–200 字 | 说明 → `service_ticket.close_note` |

**响应**：`AdminServiceTicketWriteResult`（2.5）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 工单不在 `pending`、`processing`、`awaiting_confirm`（已解决、已关闭不能关闭） |
| `SERVICE_TICKET_NOT_OWNER` | 403 | 观察者不是当前负责人，也不是主管或超级管理员 |
| `NOT_FOUND` | 404 | 工单不存在或不在数据范围内 |
| `VALIDATION_FAILED` | 400 | 原因不在三个取值内；说明为空或超长 |
| `PERMISSION_DENIED` | 403 | 没有 `service.ticket.close` |

**副作用**（同一事务）：
- 状态迁移 `service_ticket.status: pending | processing | awaiting_confirm → closed`（`close`，`12-support.md:158`）：`closed_at` = 现在；`close_reason`；`close_note`；清空 `response_due_at`、`auto_resolve_at`。员工代为关闭（原因选“商家撤回”）时 `withdraw_reason_code` 仍为空（`12-support.md:72`）。
- 写系统事件条目（`tag = 'status'`，`body`“{操作人}关闭了工单，原因：{原因}；{说明}”，`merchant_body`“工单已关闭：{说明}”，商家可见）。
- 图片引用：本工单及其全部条目的图片 `files.release()`，`keep_until` = 迁移时刻 + 3 年（`12-support.md:178`）。
- 定时器：取消 `service.first_response_due`（这一轮）、`service.solution_due`、`service.auto_resolve`（有则取消，`12-support.md:185-187`）。
- `status_transition` 一行（`event = 'close'`，`reason_code` = 关闭原因）与活动流审计；出站事件 `service_ticket.closed`（载荷 `closeReason`）。

**说明**：
- 弹窗提示“仅用于重复、无效或商家主动撤回的工单；问题已处理完毕的，请使用‘提交处理结果’”（PRD 7.8-3）。关闭后不能再回复，商家再次反馈时须新建工单。
- 原型“工单已关闭，商家将收到通知”：商家通知走 `service_ticket.closed` 的 `notify.onEvent`，场景 `m.ticket_reply`（a09 已落地，a09-ops.md:517），条件为 `closeReason` ≠ `withdrawn`（商家自己撤回与员工代为按“商家撤回”关闭都不通知），接收人同工单回复（提交人，没有提交人发该门店老板）。x01 事件目录里这个事件的订阅者仍是“无”，已请 x01 补 `notify.onEvent`；补登之前商家只能在工单时间线看到系统事件“工单已关闭：{说明}”，弹窗提示不要写“商家将收到通知”；补登后，原因选“商家撤回”时也不写这句。
- 误关闭的工单只能由 3.10 人工纠偏重新打开。

### 3.8 admin.serviceTicket.assign　分配负责人

`POST /admin/service-tickets/{serviceTicketId}/assign`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.serviceTicket.assign`（路线图 `a08.service-tickets.assign`） |
| 鉴权 | `staff`；权限点 `service.ticket.assign`（客服，仅主管；含义按 A129 为“分配无负责人的工单”，待分配池 `service_ticket`，见第 1 节）；模块 `service` ≥ v；数据范围 `scope: task` |
| 回显 | 无 |
| 幂等 | `required`（写状态历史，A17）；结果脱敏（1.1） |
| 乐观锁 | 不带 `lockVersion`（`12-support.md:159` 的守卫没有列锁版本）；先对目标员工行 `FOR SHARE`，再锁工单行 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Service“分配工单”弹窗 |
| 出处 | `12-support.md:159`、`127`、`167`、`453`；d3-flow.md:2536；proto-admin-c.md:371、389 第 6 条 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `serviceTicketId` | string(uuid) | 是 | 范围内的工单 | — |
| 请求体（`AdminServiceTicketAssignBody`） | `toStaffId` | string(uuid) | 是 | 可接手的员工（1.1） | 新负责人 → `service_ticket.owner_staff_id` |
| 请求体 | `reasonCode` | string | 是 | 字典 `ticket_transfer_reason` 内且启用 | 分配原因 → `status_transition.reason_code` |
| 请求体 | `note` | string | 否 | 去掉首尾空白后 1–100 字 | 分配说明 → 内部备注条目（`tag = 'transfer'`） |

**响应**：`AdminServiceTicketWriteResult`（2.5）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `SERVICE_TICKET_ALREADY_ASSIGNED` | 409 | 工单已有负责人，应走转派；`details = { ownerStaffId }` |
| `ASSIGNEE_INVALID` | 409 | 目标员工未启用（`not_active`）、岗位不能接手客服工单（`role_mismatch`）、或不在操作人可指派的员工集合内（`out_of_scope`）；a05 定义 |
| `STATE_NOT_ALLOWED` | 409 | 工单已解决或已关闭 |
| `DICT_ITEM_DISABLED` | 409 | 原因编码不在字典里或已停用；`details = { dictTypeKey: 'ticket_transfer_reason', code }` |
| `NOT_FOUND` | 404 | 工单不存在或不在数据范围内 |
| `PERMISSION_DENIED` | 403 | 没有 `service.ticket.assign`（非主管） |

**副作用**（同一事务）：
- 状态不变：`service_ticket.status: 未结状态 → 同一状态`（`assign`，`12-support.md:159`）：写 `owner_staff_id`；时限不变。
- `status_transition` 一行（`from_state = to_state`，`event = 'assign'`，`reason_code` = 原因，`payload` 带 `fromStaffId: null`、`toStaffId`、`toStaffRoleKey`（目标员工当时的 `staff.staff_role_key`），`12-support.md:463`）与活动流审计。
- 写系统事件条目（`tag = 'transfer'`，`body`“{操作人}将工单分配给{新负责人}（{岗位}），原因：{原因}”）。新负责人是该门店的交付经理（`store.delivery_manager_id`）时对商家可见，`merchant_body`“工单已转给您的服务经理{称呼}跟进”（称呼取 `staff.display_name`，为空取 `staff.name`）；其余不可见（本文定，`12-support.md:167`）。
- 填了说明时另写一条内部备注（`kind = 'internal_note'`、`tag = 'transfer'`，正文“分配说明：{note}”）。
- 出站事件 `service_ticket.transferred`（`fromStaffId` 为空），通知订阅者给新负责人发 `s.kf_assigned`（企业微信提醒，d6-notify-docs-data.md:265）。
- 不写 `assignment_history`（A92）：该表只记员工禁用、移交、转移交付经理与不变量自动改派（03-staff-authz-audit.md:420）；人工分配的原因与前后负责人记在状态历史里。

**说明**：
- 候选人按 1.1“选人”：a01 的 `admin.staff.list?pool=cs,delivery_manager&withLoad=true`（两个池的启用成员，含不当班的；工单之所以没有负责人，往往正是因为没人当班，d3-flow.md:2536）；“待处理 N 单”取 `openWorkBySource` 的 `service_ticket_owner` / `service_ticket` 一项（客服工单在办量，不用合计 `openWorkCount`）；该门店的交付经理取行上的 `storeDeliveryManager`，前端标“该商家服务经理”。
- 原型弹窗只有“分配说明（选填）”、没有原因（proto-admin-c.md:371）；数据模型要求必选原因（`12-support.md:159`），前端补原因单选，按目标岗位带出默认值（客服 → 需客服跟进，交付经理 → 需交付侧评估）。
- 原型提示“分配后对方将收到企业微信提醒，响应时限不变”与本接口一致。

### 3.9 admin.serviceTicket.reassign　转派

`POST /admin/service-tickets/{serviceTicketId}/reassign`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.serviceTicket.reassign`（路线图 `a08.service-tickets.reassign`；原 `transfer`，按 C12 词表改为 `reassign`） |
| 鉴权 | `staff`；权限点 `service.ticket.transfer`（客服、交付经理）；负责人规则（1.1）；模块 `service` ≥ v；数据范围 `scope: task` |
| 回显 | 无 |
| 幂等 | `required`（写状态历史，A17）；结果脱敏（1.1） |
| 乐观锁 | 不带 `lockVersion`（`12-support.md:160`）；先对目标员工行 `FOR SHARE`，再锁工单行 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:ServiceDetail“转派工单”弹窗；A:Service 有负责人的行上的“分配” |
| 出处 | `12-support.md:160`、`167`、`273-274`、`453`；d3-flow.md:2517、2537；proto-admin-c.md:418；PRD 7.8-2 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `serviceTicketId` | string(uuid) | 是 | 范围内的工单 | — |
| 请求体（`AdminServiceTicketReassignBody`） | `toStaffId` | string(uuid) | 是 | 可接手的员工（1.1），且不是当前负责人 | 新负责人 → `service_ticket.owner_staff_id` |
| 请求体 | `reasonCode` | string | 是 | 字典 `ticket_transfer_reason` 内且启用 | 转派原因（需客服跟进、需交付侧评估、工作量调整、其他）→ `status_transition.reason_code` |
| 请求体 | `note` | string | 否 | 去掉首尾空白后 1–100 字（与 3.8 相同，工单池的“分配”弹窗对有负责人的行调本接口；详情页转派弹窗前端仍可限 60 字，ServiceDetail.dc.html:175） | 说明，“将写入内部备注”（条目正文上限 500 字，不受限） |

**响应**：`AdminServiceTicketWriteResult`（2.5）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `SERVICE_TICKET_NOT_ASSIGNED` | 409 | 工单没有负责人，应走分配 |
| `ASSIGNEE_INVALID` | 409 | 目标员工未启用（`not_active`）、岗位不能接手（`role_mismatch`）、就是当前负责人（`same_as_current`）、或不在可指派范围内（`out_of_scope`）；a05 定义 |
| `SERVICE_TICKET_NOT_OWNER` | 403 | 观察者不是当前负责人，也不是主管或超级管理员 |
| `STATE_NOT_ALLOWED` | 409 | 工单已解决或已关闭 |
| `DICT_ITEM_DISABLED` | 409 | 原因编码不在字典里或已停用 |
| `NOT_FOUND` | 404 | 工单不存在或不在数据范围内 |
| `PERMISSION_DENIED` | 403 | 没有 `service.ticket.transfer` |

**副作用**（同一事务）：
- 状态不变：`service_ticket.status: 未结状态 → 同一状态`（`transfer`，`12-support.md:160`）：改 `owner_staff_id`；时限不变。
- `status_transition` 一行（`from_state = to_state`，`event = 'transfer'`，`reason_code`，`payload` 带 `fromStaffId`、`toStaffId`、`toStaffRoleKey`）与活动流审计；报表“转派交付经理”按 `toStaffRoleKey` 统计（`12-support.md:169`）。
- 写系统事件条目（`tag = 'transfer'`，`body`“{操作人}将工单转派给{新负责人}（{岗位}），原因：{原因}”）；商家可见的条件与文案同 3.8。
- 填了说明时另写一条内部备注（`tag = 'transfer'`，正文“交接说明：{note}”，d3-flow.md:2517）。
- 出站事件 `service_ticket.transferred`，通知订阅者给新负责人发 `s.kf_assigned`。
- 不写 `assignment_history`（A92，同 3.8）。

**说明**：
- 候选人：原型列出除当前负责人外的客服与交付经理，显示岗位与待处理单量（proto-admin-c.md:418）；按 1.1“选人”取 a01 的 `admin.staff.list?pool=cs,delivery_manager&withLoad=true`，单量取 `openWorkBySource` 的客服工单一项，前端去掉当前负责人（工单池弹窗则标“当前负责人”）。选人后前端按目标岗位带出默认原因，用户改过不再覆盖（原型逻辑）。
- 字典 `ticket_type` 上 `transferable = true` 的问题类型（交付进度、内容修改等）可一键转给该门店的交付经理（d3-flow.md:2537；14-config-data.md:1069），即本接口带 `toStaffId = storeDeliveryManager.staffId`，前端可据此给快捷按钮。
- 员工禁用移交、转移交付经理（a03 `admin.store.reassignDeliveryManager`，A136 改名）与 `staff.I10` 自动改派由 staff 模块发起，经本模块注册的改派实现写同样的 `transfer` 状态历史与系统事件（`12-support.md:168`），不经本接口。转移交付经理只移交负责人为原交付经理的未结客服工单（负责人已是接收人的跳过），逐张发 `service_ticket.transferred`，通知订阅者给新负责人发 `s.kf_assigned`（a03 3.8；a09-ops.md:548）。

### 3.10 admin.serviceTicket.forceTransition　人工纠偏：重新打开误关闭的工单

`POST /admin/service-tickets/{serviceTicketId}/force-transition`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.serviceTicket.forceTransition`（路线图 `a08.service-tickets.force-transition`；原 `a01.status-transitions.force` 的客服工单部分，复核意见 42） |
| 鉴权 | `staff`；权限点 `flow.admin.transition`（增补表：默认只授予超级管理员，再验证标“要”，与 a05 增补表一致；数据模型把第二因子列为这条迁移的守卫，`12-support.md:162`、d3-flow.md:1030）；数据范围 `scope: task` |
| 回显 | 要求 `confirm`：`{ ticketNo }`，与库中当前值比对，不一致 409 `CONFIRM_MISMATCH`（C54） |
| 幂等 | `required`（状态迁移，A17）；结果脱敏（1.1） |
| 乐观锁 | 不带 `lockVersion`（`12-support.md:162` 的守卫没有列锁版本）；行锁 + 状态守卫 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 原型无（流程运维，d3-flow.md:1047；05-risks-and-open-issues.md 第 4 节）；入口建议放在已关闭工单的详情页更多操作里，按 `actions` 显示 |
| 出处 | `12-support.md:162`、`178`、`458`；01-kernel-flow.md:432、440、476；d3-flow.md:1026-1045 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `serviceTicketId` | string(uuid) | 是 | 范围内的工单 | — |
| 请求体（`AdminServiceTicketForceTransitionBody`） | `toStatus` | enum | 是 | 只有 `processing`（更正白名单 `closed → processing`，d3-flow.md:1045） | 目标状态，显式写出防误操作 |
| 请求体 | `note` | string | 是 | 去掉首尾空白后 10–500 字 | 纠偏原因 → `status_transition.note` |
| 请求体 | `confirm` | object | 是 | `{ ticketNo: string }` | 二次确认回显（C54） |

**响应**：`AdminServiceTicketWriteResult`（2.5）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 工单不是 `closed` |
| `CONFIRM_MISMATCH` | 409 | `confirm.ticketNo` 与工单号不符 |
| `STEP_UP_REQUIRED` | 403 | 会话的再验证时刻超出 10 分钟窗口（`flow.admin.transition` 要求再验证，C66）；弹再验证后用同一幂等键重放 |
| `NOT_FOUND` | 404 | 工单不存在或不在数据范围内 |
| `VALIDATION_FAILED` | 400 | 原因不足 10 字或超长；`toStatus` 不是 `processing` |
| `PERMISSION_DENIED` | 403 | 没有 `flow.admin.transition` |

**副作用**（同一事务）：
- 状态迁移 `service_ticket.status: closed → processing`（`admin.force`，`12-support.md:162`）：清空 `closed_at`、`close_reason`、`withdraw_reason_code`、`close_note`；`reopened_count` 不变（人工纠偏不计，`12-support.md:83`）；负责人与时限列不变。
- `status_transition` 一行：`event = 'admin.force'`、`is_forced = true`、`note` = 纠偏原因（`ck_status_transition_forced`，01-kernel-flow.md:476）；审计内容随 `transition()` 传入，写 `ops` 流一行（`category = flow`，动作 `support.service_ticket.force_transition`，记录纠偏前后的状态与原因；与 a05 交付工单的人工纠偏同一写法）。
- 图片引用：对本工单及其条目的图片再次 `files.link()`，回到 `live`（清空 `keep_until`、`released_at`，`12-support.md:179`）。
- 写系统事件条目（`tag = 'status'`，`body`“{操作人}将误关闭的工单重新打开，原因：{note}”，`merchant_body`“工单已重新打开，客服将继续处理”，商家可见）。
- 定时器：`solution_at` 为空且 `solution_due_at` 未过时，按原键（`service.solution_due:service_ticket:{serviceTicketId}`）重新登记 `service.solution_due`；其余时限不重设（`timers.I7` 按同一键自愈，`12-support.md:204`）。x01 4.1 的登记方还没有列本接口，已请 x01 补。
- 出站事件 `service_ticket.reopened`（载荷 `round` = 当前 `reopened_count`、`isForced = true`），通知订阅者提醒负责人。
- 不调用账本；更正后对该对象的状态历史连续性由 `flow.I12` 保证（01-kernel-flow.md:485）。

**说明**：负责人在关闭期间被禁用的，重开后由 `staff.I10` 自动改派（每日校验，`12-support.md:206`）；纠偏人也可以随后用 3.9 转派。

### 3.11 admin.serviceTicket.update　改问题类型、优先级

`PATCH /admin/service-tickets/{serviceTicketId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.serviceTicket.update`（路线图 `a08.service-tickets.update`；A92 补） |
| 鉴权 | `staff`；权限点 `service.ticket.reply`（处理工单的员工；不要求负责人规则）；模块 `service` ≥ v；数据范围 `scope: task` |
| 回显 | 无 |
| 幂等 | `required`（带 `lockVersion` 的 PATCH，A17）；结果脱敏（1.1） |
| 乐观锁 | 带 `lockVersion`（内容编辑一律带，A21、C53；`12-support.md:86` 为此留了锁版本）；不符 409 `VERSION_CONFLICT` |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:ServiceDetail 工单信息卡的“问题类型”“优先级”（原型只展示，没有编辑入口，已列入设计规范第 12 节待补原型，A146） |
| 出处 | A92；`12-support.md:63-64`、`85-86`；d6-notify-docs-data.md:1463 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `serviceTicketId` | string(uuid) | 是 | 范围内的工单 | — |
| 请求体（`AdminServiceTicketUpdateBody`） | `typeCode` | string | 否 | 字典 `ticket_type` 内且启用 | 问题类型 → `service_ticket.type_code` |
| 请求体 | `priority` | enum(`ServiceTicketPriority`) | 否 | `high` / `mid` / `low` | 优先级 → `service_ticket.priority` |
| 请求体 | `lockVersion` | integer | 是 | 详情返回的当前值 | 乐观锁 |

`typeCode`、`priority` 至少传一个。传的值都与当前值相同时不写库、不写审计，`lockVersion` 不变，直接返回当前详情。

**响应**：`AdminServiceTicketWriteResult`（2.5）；有改动时 `lockVersion` 加 1。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VERSION_CONFLICT` | 409 | `lockVersion` 与库中当前值不符；`details = { lockVersion }`（最新值，C52） |
| `STATE_NOT_ALLOWED` | 409 | 工单已解决或已关闭（只允许未结状态 `pending`、`processing`、`awaiting_confirm`） |
| `DICT_ITEM_DISABLED` | 409 | `typeCode` 不在字典里或已停用；`details = { dictTypeKey: 'ticket_type', code }`（m08 定义） |
| `NOT_FOUND` | 404 | 工单不存在或不在数据范围内 |
| `VALIDATION_FAILED` | 400 | `typeCode`、`priority` 都没传；`priority` 不在三个取值内 |
| `PERMISSION_DENIED` | 403 | 没有 `service.ticket.reply` |

**副作用**（同一事务）：
- 锁工单行（`lock_rank = 270`），校验未结状态与 `lock_version`；写 `type_code`、`priority`，`lock_version + 1`，`updated_at`。
- 不是状态机事件：不写 `status_transition`、不写时间线条目、不发出站事件。
- 审计：`audit_log` 一行（1.1“审计”，动作 `support.service_ticket.update`，前后值带 `typeCode`、`priority`）。
- 时限不变：`sla_snapshot`、`response_due_at`、`solution_due_at`、`auto_resolve_at` 都不重算（截止时间按创建与重开时的参数快照，`12-support.md:85`）；定时器不动。

**说明**：
- 改成 `ext.notifyLead` 为真的类型（投诉建议）不补发客服主管提醒：该提醒只由创建时的 `service_ticket.created` 触发（d6-notify-docs-data.md:265-267）。改成 `ext.transferable` 为真的类型后，“一键转给服务经理”按新类型显示（3.9 说明）。
- 商家端按当前 `type_code` 显示类型名（m08 `m.serviceTicket.get`），优先级不对商家展示。

### 3.12 admin.serviceTicket.ref.create　补关联业务

`POST /admin/service-tickets/{serviceTicketId}/refs`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.serviceTicket.ref.create`（路线图 `a08.service-ticket-refs.create`；A92 补） |
| 鉴权 | `staff`；权限点 `service.ticket.reply`；模块 `service` ≥ v；数据范围 `scope: task` |
| 回显 | 无 |
| 幂等 | `required`（A17）；结果脱敏（1.1） |
| 乐观锁 | 不带 `lockVersion`（关联行只在持有工单行锁的事务里增删，`12-support.md:352`）；行锁 + 状态守卫 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:ServiceDetail“关联业务”卡（原型只展示，没有“添加关联”，已列入设计规范第 12 节待补原型，A146） |
| 出处 | A92；`12-support.md:331`、`346`、`351`、`375`；C10（`refs` 只以工单嵌套访问） |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `serviceTicketId` | string(uuid) | 是 | 范围内的工单 | — |
| 请求体（`AdminServiceTicketRefCreateBody`） | `refType` | enum(`ServiceTicketLinkableRefType`) | 是 | `drama_order` / `billing_order` / `delivery_ticket` / `ad` | → `service_ticket_ref.ref_type`；`approval_request` 不接受（2.2） |
| 请求体 | `refId` | string(uuid) | 是 | 对象存在且属于工单的门店（`drama_order`、`delivery_ticket`、`ad` 比对 `store_id`；`billing_order` 按主体比对 `entity_id`，与不变量 `support.S3` 同一口径） | → `service_ticket_ref.ref_id`；候选同 3.3 的 `refs[].refId` |

**响应**：`AdminServiceTicketWriteResult`（2.5）；`refs` 多一行，补的是最早的订购单或付款单时 `primaryRef` 随之变化。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 工单不是 `processing`（数据模型写的是“处理中补关联”，`12-support.md:331`；待受理的工单首次回复后即进入处理中） |
| `SERVICE_TICKET_REF_EXISTS` | 409 | 这一行关联已存在（主键 `pk_service_ticket_ref`）；`details = { refType, refId }` |
| `NOT_FOUND` | 404 | 工单不存在或不在数据范围内；关联对象不存在或不属于工单的门店（主体） |
| `VALIDATION_FAILED` | 400 | `refType` 不在四个取值内（含 `approval_request`） |
| `PERMISSION_DENIED` | 403 | 没有 `service.ticket.reply` |

**副作用**（同一事务）：
- 锁工单行，校验状态；插入一行 `service_ticket_ref`（`created_at` = 现在）。
- 审计：`audit_log` 一行（1.1“审计”，动作 `support.service_ticket.ref_add`，后值带 `refType`、`refId` 与对象单号）。
- 不写状态历史与时间线条目，不发出站事件。之后发生的关联业务事件由 `support.onBizEvent` 追加进时间线；关联之前的历史事件不倒灌（`outbox_event.occurred_at >= service_ticket_ref.created_at`，`12-support.md:347`）。

### 3.13 admin.serviceTicket.ref.batchRemove　移除关联错的业务

`POST /admin/service-tickets/{serviceTicketId}/refs/remove`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.serviceTicket.ref.batchRemove`（路线图 `a08.service-ticket-refs.remove`；A92 补。路径按 A92、C12 用 `POST …/refs/remove`，不用 `DELETE`；它是 `refs` 集合上的动作，按 C14 加 `batch` 前缀） |
| 鉴权 | `staff`；权限点 `service.ticket.reply`；模块 `service` ≥ v；数据范围 `scope: task` |
| 回显 | 无 |
| 幂等 | `required`（A17）；结果脱敏（1.1） |
| 乐观锁 | 不带 `lockVersion`；行锁 + 状态守卫 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:ServiceDetail“关联业务”卡逐行“移除”（原型没画，已列入设计规范第 12 节待补原型，A146） |
| 出处 | A92；`12-support.md:352`（关联行只增删、可物理删除，增删都写审计）、M95；C12 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `serviceTicketId` | string(uuid) | 是 | 范围内的工单 | — |
| 请求体（`AdminServiceTicketRefRemoveBody`） | `refs` | array<object> | 是 | 1–5 个，不重复 | 要移除的关联行（界面逐行移除时只传一个） |
| 请求体 | `refs[].refType` | enum(`ServiceTicketLinkableRefType`) | 是 | 四类之一；`approval_request` 不接受 | 关联行的 `ref_type` |
| 请求体 | `refs[].refId` | string(uuid) | 是 | — | 关联行的 `ref_id` |

**响应**：`AdminServiceTicketWriteResult`（2.5）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 工单已解决或已关闭（只在未结状态移除；商家提交时选错的订购单在待受理阶段就可以移除） |
| `NOT_FOUND` | 404 | 工单不存在或不在数据范围内；`refs` 里某一行在本工单上不存在（整批不删） |
| `VALIDATION_FAILED` | 400 | `refs` 为空、超过 5 个或重复；`refType` 是 `approval_request` 或不在取值内 |
| `PERMISSION_DENIED` | 403 | 没有 `service.ticket.reply` |

**副作用**（同一事务）：
- 锁工单行，校验状态；物理删除这些 `service_ticket_ref` 行（M95；应用角色对本表有 DELETE 权限，`12-support.md:42`）。
- 审计：每行一条 `audit_log`（1.1“审计”，动作 `support.service_ticket.ref_remove`，前值带 `refType`、`refId`、建立关联的时间与对象单号）。
- 已因该关联写进时间线的业务事件条目保留（时间线是服务过程的证据，条目只增不改）；之后该对象的事件不再进本工单时间线。不写状态历史，不发出站事件。

**说明**：移除的是最早的订购单或付款单时，工单池的“商家与单号”（`primaryRef`）改取下一条；都没有了显示“未关联订单”。商家端“关联订单”同样按剩下的订购单取（m08）。

### 3.14 admin.quickReply.list　快捷回复（V1.1）

`GET /admin/quick-replies`

V1.1，细节待设计。详情页输入区“快捷回复”下拉：标题 + 文案，点击插入回复框、可继续编辑，“由客服主管维护”（proto-admin-c.md:417）。鉴权暂按 `staff` + 模块 `service` ≥ v，幂等 `none`（纯查询），响应暂定 `QuickReplyList`（`{ items }`，有界小集合不分页，A78）。届时补维护接口与表（数据模型 V1.0 没有快捷回复表，资源登记表 `quick-replies` 为 `table: null` 的 V1.1 占位），维护权限点建议 `service.quick_reply.manage`（客服，仅主管）。

## 4. 枚举

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `ServiceTicketStatus` | `pending` / `processing` / `awaiting_confirm` / `resolved` / `closed` | 同数据模型 `service_ticket.status`（与 m08 同名枚举同一份） |
| `ServiceTicketPriority` | `high` / `mid` / `low` | 同数据模型 `service_ticket.priority` |
| `ServiceTicketSource` | `weapp` / `online_chat` / `phone` | 同数据模型 `service_ticket.source`；登记接口只接受后两个 |
| `ServiceTicketCloseReason` | `duplicate` / `invalid` / `withdrawn` | 同数据模型 `service_ticket.close_reason` |
| `ServiceTicketResolvedVia` | `merchant` / `auto` | 同数据模型 `service_ticket.resolved_via` |
| `ServiceTicketEntryKind` | `merchant_message` / `staff_reply` / `internal_note` / `system_event` | 同数据模型 `service_ticket_entry.kind`；员工写入只用 `staff_reply`、`internal_note` |
| `ServiceTicketEntryTag` | `submit` / `supplement` / `reopen` / `reply` / `solution` / `result` / `transfer` / `status` / `biz_event` | 同数据模型 `service_ticket_entry.tag` |
| `ServiceTicketRefType` | `drama_order` / `billing_order` / `delivery_ticket` / `ad` / `approval_request` | 同数据模型 `service_ticket_ref.ref_type` |
| `ServiceTicketLinkableRefType` | `drama_order` / `billing_order` / `delivery_ticket` / `ad` | 本文新增：员工登记、补关联、移除关联可用的类型（`ServiceTicketRefType` 去掉 `approval_request`） |
| `SlaUnit` | `work_minutes` / `work_days` / `natural_hours` / `natural_days` / `same_day_cutoff` | 同数据模型 `SlaSnapshot.unit`（`12-support.md:441`） |
| `PhoneSource` | `login` / `store_contact` / `input` | 联系电话的来源（A25，与 m08 同一份） |
| `AdminServiceTicketTab` | `open` / `pending` / `processing` / `awaiting_confirm` / `resolved` / `closed` / `all` | 本文新增：工单池页签；`open` = 待受理 + 处理中 |
| `AdminServiceTicketSort` | `urgency` / `-createdAt` / `createdAt` | 本文新增：排序（C44 的具名排序） |
| `ServiceSlaPhase` | `response_pending` / `response_overdue` / `solution_pending` / `solution_overdue` / `solution_given` / `awaiting_confirm` / `resolved` / `closed` | 本文新增：时效阶段（2.3），`x-open-enum` |
| `ServiceTicketStatusNote` | `escalated` / `with_store_manager` / `cancel_pending_approval` / `refund_pending_approval` | 本文新增：状态副说明（2.4），`x-open-enum` |
| `AdminServiceTicketAction` | `assign` / `reassign` / `submit-result` / `close` / `force-transition` / `update` / `create-ref` / `remove-ref` | 本文新增：`actions`（C16），取 C12 的动作词与增删改查动词；附属对象写 `<动词>-<对象>`（`create-ref`、`remove-ref`，C12） |
| `ServiceTicketOwnerMode` | `round_robin` / `specified` | 本文新增：登记时的负责人方式 |

接收人无效的 `details.reason` 用 a05 `ASSIGNEE_INVALID` 的取值（`not_active` / `role_mismatch` / `same_as_current`，另请 a05 补 `out_of_scope`），本文不再定义自己的枚举（初稿的 `ServiceTicketAssigneeInvalidReason` 删除）。

不是枚举的编码（字典，按值引用）：问题类型 `ticket_type`（`service_ticket.type_code`）、撤回原因 `ticket_withdraw_reason`（`service_ticket.withdraw_reason_code`）、分配与转派原因 `ticket_transfer_reason`（`status_transition.reason_code`），名称一律取 `dict_item.name`，前端下拉取 a01 的 `admin.dictItem.list`（`12-support.md:413-419`；14-config-data.md:104-106）。

## 5. 错误码

本文在 A70 给 a08-support 的区间 45600–45699 内取号。

| 符号 | 数值 | HTTP | 可重试 | `details` | 含义（默认文案） |
| --- | --- | --- | --- | --- | --- |
| `SERVICE_TICKET_ALREADY_ASSIGNED` | 45601 | 409 | 否 | `{ ownerStaffId: string }` | 工单已有负责人，请使用“转派”（`12-support.md:159` 的守卫） |
| `SERVICE_TICKET_NOT_ASSIGNED` | 45602 | 409 | 否 | 无 | 工单还没有负责人，请使用“分配”（`12-support.md:160` 的守卫） |
| `SERVICE_TICKET_NOT_OWNER` | 45604 | 403 | 否 | `{ ownerStaffId: string }` | 只有当前负责人或主管可以执行这个操作 |
| `SERVICE_TICKET_REF_EXISTS` | 45605 | 409 | 否 | `{ refType: ServiceTicketRefType, refId: string }` | 这条业务已经关联在本工单上 |

初稿的 `SERVICE_TICKET_ASSIGNEE_INVALID`（45603）按 A77 删除，改引用 a05 的 `ASSIGNEE_INVALID`；45603 不复用。

引用其他文档或约定的错误码：`ASSIGNEE_INVALID`（45308，a05-order-delivery，共用领域码，C28）；`DICT_ITEM_DISABLED`（47001，m08-support-misc）；`FILE_NOT_USABLE`（46001，m03-profile-asset）；通用码 `VALIDATION_FAILED`、`NOT_FOUND`、`STATE_NOT_ALLOWED`、`PERMISSION_DENIED`、`STEP_UP_REQUIRED`、`CONFIRM_MISMATCH`、`VERSION_CONFLICT`（C27）。

## 6. 待确认

初稿第 6 节的处理：第 1、2、5、7 项由 A92 定（数据范围、负责人规则、改类型与优先级、关联业务增删），已写进 1.1、3.11–3.13；第 4、9 项按第十节导语接受默认做法（分配补必选原因见 3.8，员工回复接口按 9 张图见 3.5）；第 6 项（员工关闭后通知商家）不是产品问题，转给 x01、a09（3.7 说明）；第 8 项 a01 第二轮已落实（池的只读与按来源的在办量，见 1.1“选人”）。第三轮：第二轮的第 2 项（改类型、优先级与增删关联的原型入口）已由 A146 列入设计规范第 12 节待补原型，删去。下面只留需要业务决定的事项。

| # | 问题 | 默认做法 | 谁定 |
| --- | --- | --- | --- |
| 1 | 回复与内部备注允许的状态：数据模型只在待受理（回复）与处理中（回复、内部备注）有对应行；原型在“待商家确认”时仍显示输入区（proto-admin-c.md:424） | 按数据模型：回复限待受理、处理中，内部备注限处理中；`composeModes` 为空时隐藏输入区。业务若要在待商家确认时也能写内部备注（不改状态、商家不可见、不影响时限），需数据模型 12 分组补行后本文放开 | 业务（数据模型 12 分组随之回写） |

## 7. 修订记录

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：路线图 `doc = a08-support` 的 11 条接口（V1.0 10，V1.1 1）；工单池列表、计数、登记、详情、回复与备注、提交处理结果、关闭、分配、转派、人工纠偏逐条对上 12 分组状态机表；新增错误码 45601–45604 | API-WRITER-GUIDE；A1–A75；C1–C84 |
| 2026-10-03 | 第二轮。① 按 A92 补 3 条接口，共 14 条（V1.0 13，V1.1 1）：`admin.serviceTicket.update`（`PATCH`，改类型与优先级，带 `lockVersion`，未结状态）、`admin.serviceTicket.ref.create`（`POST …/refs`，处理中补关联，四类对象须属本门店，重复返回新码 `SERVICE_TICKET_REF_EXISTS` 45605）、`admin.serviceTicket.ref.batchRemove`（`POST …/refs/remove`，物理删除；作者初稿提的 `DELETE …/refs?refType=&refId=` 按 A92、C12 不采用；集合动作按 C14 加 `batch` 前缀）；三条都用 `service.ticket.reply`，写活动流审计（类别 `service_ticket`）；详情 `actions` 加 `update`、`create-ref`、`remove-ref`，`lockVersion` 用于 3.11。② 数据范围按 A92 改为 d4 的 `taskScope`（门店由本人或本组负责，或负责人在集合内，不带待分配池），全部路由声明 `scope: task`；负责人规则注明 A92 采纳；人工分配与转派不写 `assignment_history`（A92）。③ 错误码：`SERVICE_TICKET_ASSIGNEE_INVALID`（45603）删除，改引用 a05 的 `ASSIGNEE_INVALID`（A77、C28），`reason` 用 a05 取值，另请 a05 补 `out_of_scope`；`ServiceTicketAssigneeInvalidReason` 删除。④ 结果脱敏（A80、C50）：写接口返回 `AdminServiceTicketWriteResult`（详情 + `replayed`），`x-redact-on-replay` 为工单与条目图片的 `url`、`expiresAt`。⑤ 定时器去重键的类型段由 `st` 改为最终表名 `service_ticket`（A96），已请 x01 改 4.1、主负责人回写 12 分组 184–186 行。⑥ 页面与数据模型（复核意见 A）：“已升级至客服主管”加条件 `escalated_at >= sla_snapshot.response.computedAt`，重开后不再误显示；首次响应用时改为 `workingMinutesBetween(created_at, first_response_at)`，与 d3 指标同口径；`storeDeliveryManager` 移到工单池行结构，分配弹窗可直接标“该商家服务经理”；转派说明上限放宽到 100 字，与分配同构；`flow.admin.transition` 按增补表要求再验证，`STEP_UP_REQUIRED` 不再写成有条件的；人工纠偏写 `ops` 审计（`category = flow`）。⑦ 约定与跨文档（复核意见 B）：选人候选改为 `admin.staff.list?pool=cs,delivery_manager&withLoad=true`（含不当班的人），“本次轮到 X”调 `recommendPool=cs` 并读 `isRecommended`（a01 初稿的 `isNext` 已改名）；`q`、`no` 识别预发前缀 `T`，与 a02 全局搜索共用单号解析；`StaffBrief` 注明是 a01 的后台版（m08 已改名 `MerchantStaffBrief`）；summary 的 `responseOverdue` 与 a02 待办 ⑨ 已同口径（a02 第二轮已改，已核对）；员工关闭后的商家通知转请 x01、a09。⑧ 其他文档的请求：a02 导出参数同构、a03 按 `storeId` 计数，均已满足；a07 退款关联工单的时间线由 `support.onBizEvent` 订阅 `approval.*` 完成，不另订 `refund.*`（避免同一事实两条，E2），撤回另请 x01 补订 `approval.withdrawn`；m08 要的 `service_ticket.supplemented` 订阅者属 notify，转请 x01 补登。⑨ 路线图切片：assign、reassign 去掉 `assignment_history`；list 删“未分配池仅客服主管可见”；forceTransition 请求体与文档对齐、删过时备注；create 的迁移写作“（新建）→ processing（register）”；按文档补 tables 与 notes；新增 3 条。⑩ 第 6 节只留 2 项（见第 6 节导语） | A77、A80、A92、A95、A96、A108、A119、A120、A124；C10、C12、C14、C28、C50、C52、C53、C66、C75；复核意见 A、B；`review/xdoc-a08-support.md`；`review/api-check.md` |
| 2026-10-03 | 第三轮。① A129：第 1 节写明 `service.ticket.assign`（分配无负责人的工单，仅主管，待分配池 `service_ticket`）与 `service.ticket.transfer`（负责人转出；主管可改派任意工单）的含义，以 07 主文档注册表为准，删去“d4 第 7.1、7.3 节待回写”；数据范围记为任务范围、无待分配池；`flow.admin.transition` 要求再验证（已是）。② A136：引用改为 a03 `admin.store.reassignDeliveryManager`，3.9 说明补“只移交负责人为原交付经理的未结客服工单，逐张发 `service_ticket.transferred`”。③ A144：2.3 与 3.5 改写 `elapsed_work_min` 的口径（与同一链上一行之间的一段，`reply` 行不是首次响应用时；首次响应用时按 `created_at` 到 `first_response_at`，与 `12-support.md:171` 一致）；定时器键类型段已与 `12-support.md:185-187` 一致，删去“`st` 待改”；1.1“轮询”引用 `service_ticket.supplemented` 与 `s.kf_supplemented`。④ A146：改类型、优先级与增删关联的原型入口已列入设计规范第 12 节，第 6 节删去该项，3.4、3.11–3.13 改引 A146；审计类别 `service_ticket` 注明 A146 与 a02 2.7 的登记。⑤ 其他文档的请求：a03 提出人候选改 `admin.entity.member.list?role=owner`（`{ items }`）；a01 `isRecommended`、两个池的只读、`openWorkBySource` 已在第二轮落实，1.1“图片”补 `ticket_attachment` 按 `service.ticket.reply` 判权；a09 员工关单通知按 `m.ticket_reply`（`closeReason` ≠ `withdrawn`）改写 3.7 说明；m08 的 `relatedOrder` 与本文 `primaryRef` 取法不同，2.2 注明各写各的查询。⑥ C85–C87：本文没有多值字典字段；单值的 `typeCode` / `typeName`、`withdrawReasonCode` / `withdrawReasonName` 与 m08 同一写法，保留；没有驳回接口，不涉及 C86；清单补 `externalSchemas`（`StaffBrief`、`AdminPage`、`ImageRef`、`EntryLink`），`proposedPermissions` 按 A140 改为 `permissionSupplements`（加 `confirm`），`enums` 补齐本文新增的 5 个枚举；本文定义的结构与其他清单不重名。⑦ 路线图切片：assign、close、forceTransition、create 的备注同步 | A129、A136、A140、A144、A146；C85–C87；`review/r3-in-a08-support.md` |
| 2026-10-03 | 第四轮（收尾）。① A151、C85：`AdminServiceTicketRow`（及详情、写结果）的 `typeCode` + `typeName` → `type: DictRef`，详情的 `withdrawReasonCode` + `withdrawReasonName` → `withdrawReason: DictRef \| null`；请求与筛选仍收 `typeCode`；2.1 与清单 `externalSchemas` 补 `DictRef`。② a03 请求（3.9 引用 `admin.store.reassignDeliveryManager`，A136）第三轮已做到 | A136、A151；C85、C87；`review/r4-in-a08-support.md` |
