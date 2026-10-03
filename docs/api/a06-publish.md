# 后台：发布与巡检

| 项 | 内容 |
| --- | --- |
| 文档 | `a06-publish` |
| 范围 | 后台“发布”菜单：成片交付页的发布清单与成片包（A:Delivery，A:TicketDetail 的“成片与发布”）、上线日历（A:Calendar，A:Main 的“近 7 日上线安排”）、链接核验（A:Verify）、账号核验（A:Accounts）、逾期跟踪（A:Overdue）、作品巡检（A:Patrol）、下架核查（A:Offline）；商家详情的“渠道账号”页签（A:MerchantDetail）；V1.1 的数据录入（A:DataEntry）占位 |
| 接口数 | 41（V1.0 35，V1.1 6） |
| 依据 | 数据模型 `11-publish.md`（渠道账号与核验提交、上线任务与回填、巡检批次与任务、下架任务）、`10-delivery.md`（工单步骤、成片包、发布清单、方案版本）、`03-staff-authz-audit.md` 2.12（审批单）、`06-media.md` 2.12（ZIP 缓存）、`09-order-ad.md`（订单项阶段）、`13-notify-docs.md` 2.9（人工催办限频）、`14-config-data.md`（清单模板、字典、参数）；草案 d3-flow.md 第 11–15 节与附录 B，d5-media.md 8.4 与第 12 节，d4-identity.md 第 7 节；接口裁决 A1–A126（第二轮按第十节 A76–A120 修订）；通用约定 C1–C84；事件目录 x01-events-jobs；公共片段引用 a01-system、a03-merchant、a05-order-delivery、m05-delivery-publish；原型梳理 proto-admin-a.md 第 5–12 节、proto-admin-b.md 第 2 节 |
| 状态 | 第二轮修订（2026-10-03） |

## 1. 概览

本文是发布专员（及交付经理、发布主管）在后台处理“成片交到商家手里之后”的全部接口：整理并保存发布清单、查看成片包与预打包 ZIP；按约定上线日看上线日历与逾期跟踪；核验商家回填的上线链接（通过、退回、撤销通过）；核验商家绑定的渠道账号、把可用账号人工标记为异常；每周巡检已上线作品；到期后核查商家是否已下架并留证。账号核验、链接核验的队列列表与页签计数走 a01 的 `admin.approval.list`、`admin.approval.summary`（A14、A16），本文只给领域详情与决定接口。推送成片包 `admin.deliveryTicket.pushPackage`、记录跟进 `admin.followUp.create`、提醒商家上线 `admin.deliveryTicket.remind` 分属 a05、a03，本文只引用。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `admin.channelAccount.list` | `GET /admin/channel-accounts` | 渠道账号列表（商家详情“渠道账号”页签） | staff；模块查看 publish 或 merchant | none（查询） |
| `admin.channelAccount.summary` | `GET /admin/channel-accounts/summary` | 渠道账号按状态计数 | staff；模块查看 publish 或 merchant | none（查询） |
| `admin.channelAccount.get` | `GET /admin/channel-accounts/{channelAccountId}` | 渠道账号详情与历次核验 | staff；模块查看 publish 或 merchant | none（查询） |
| `admin.channelAccount.markAbnormal` | `POST /admin/channel-accounts/{channelAccountId}/mark-abnormal` | 把可用账号人工标记为异常 | staff；`publish.account.mark_abnormal` | required |
| `admin.channelAccountSubmission.get` | `GET /admin/channel-account-submissions/{channelAccountSubmissionId}` | 账号核验详情（比对表、截图、历次记录） | staff；模块查看 publish | none（查询） |
| `admin.channelAccountSubmission.approve` | `POST /admin/channel-account-submissions/{channelAccountSubmissionId}/approve` | 账号核验通过 | staff；`publish.account.verify` | required |
| `admin.channelAccountSubmission.reject` | `POST /admin/channel-account-submissions/{channelAccountSubmissionId}/reject` | 账号核验驳回（标记异常） | staff；`publish.account.verify` | required |
| `admin.deliveryTicket.publishList.get` | `GET /admin/delivery-tickets/{deliveryTicketId}/publish-list` | 发布清单 | staff；模块查看 publish | none（查询） |
| `admin.deliveryTicket.publishList.replace` | `PUT /admin/delivery-tickets/{deliveryTicketId}/publish-list` | 保存发布清单 | staff；`publish.list.edit` | required |
| `admin.deliveryTicket.publishList.import` | `POST /admin/delivery-tickets/{deliveryTicketId}/publish-list/import` | 表格导入逐集内容 | staff；`publish.list.edit` | required |
| `admin.deliveryRelease.get` | `GET /admin/delivery-releases/{deliveryReleaseId}` | 成片包详情（清单、大小、下载授权） | staff；模块查看 publish | none（查询） |
| `admin.deliveryRelease.pack` | `POST /admin/delivery-releases/{deliveryReleaseId}/pack` | 预打包 ZIP | staff；`publish.package.push` | required |
| `admin.launchCalendar.get` | `GET /admin/launch-calendar` | 上线日历（按约定上线日聚合） | staff；模块查看 publish | none（查询） |
| `admin.launchTask.list` | `GET /admin/launch-tasks` | 逾期未上线、7 日内待上线；按工单或订单项查上线任务 | staff；模块查看 publish | none（查询） |
| `admin.launchTask.summary` | `GET /admin/launch-tasks/summary` | 逾期跟踪指标卡 | staff；模块查看 publish | none（查询） |
| `admin.launchSubmission.get` | `GET /admin/launch-submissions/{launchSubmissionId}` | 链接核验详情 | staff；模块查看 publish | none（查询） |
| `admin.launchSubmission.approve` | `POST /admin/launch-submissions/{launchSubmissionId}/approve` | 链接核验通过 | staff；`publish.link.verify` | required |
| `admin.launchSubmission.reject` | `POST /admin/launch-submissions/{launchSubmissionId}/reject` | 链接核验退回补充 | staff；`publish.link.verify` | required |
| `admin.launchSubmission.revoke` | `POST /admin/launch-submissions/{launchSubmissionId}/revoke` | 撤销核验通过并重开一轮 | staff；`publish.link.verify_revoke` | required |
| `admin.patrolTask.list` | `GET /admin/patrol-tasks` | 作品巡检列表 | staff；模块查看 publish | none（查询） |
| `admin.patrolTask.summary` | `GET /admin/patrol-tasks/summary` | 本周巡检页头与页签计数 | staff；模块查看 publish | none（查询） |
| `admin.patrolTask.get` | `GET /admin/patrol-tasks/{patrolTaskId}` | 巡检任务详情 | staff；模块查看 publish | none（查询） |
| `admin.patrolTask.create` | `POST /admin/patrol-tasks` | 手动发起巡检 | staff；`publish.patrol.do` | required |
| `admin.patrolTask.markNormal` | `POST /admin/patrol-tasks/{patrolTaskId}/mark-normal` | 巡检正常 | staff；`publish.patrol.do` | required |
| `admin.patrolTask.markAbnormal` | `POST /admin/patrol-tasks/{patrolTaskId}/mark-abnormal` | 发现异常并通知商家 | staff；`publish.patrol.do` | required |
| `admin.patrolTask.recover` | `POST /admin/patrol-tasks/{patrolTaskId}/recover` | 复查已恢复 | staff；`publish.patrol.do` | required |
| `admin.patrolTask.remind` | `POST /admin/patrol-tasks/{patrolTaskId}/remind` | 再次提醒商家处理异常 | staff；`publish.patrol.do` | required |
| `admin.takedownTask.list` | `GET /admin/takedown-tasks` | 下架核查队列 | staff；模块查看 publish | none（查询） |
| `admin.takedownTask.batchCheck` | `POST /admin/takedown-tasks/check` | 批量核查通过 | staff；`publish.takedown.check` | required |
| `admin.takedownTask.summary` | `GET /admin/takedown-tasks/summary` | 下架核查页签计数 | staff；模块查看 publish | none（查询） |
| `admin.takedownTask.get` | `GET /admin/takedown-tasks/{takedownTaskId}` | 下架任务详情 | staff；模块查看 publish | none（查询） |
| `admin.takedownTask.check` | `POST /admin/takedown-tasks/{takedownTaskId}/check` | 核查通过并留证 | staff；`publish.takedown.check` | required |
| `admin.takedownTask.escalate` | `POST /admin/takedown-tasks/{takedownTaskId}/escalate` | 逾期未下架手动升级 | staff；`publish.takedown.check` | required |
| `admin.takedownTask.markOnline` | `POST /admin/takedown-tasks/{takedownTaskId}/mark-online` | 抽查仍在线，退回并升级 | staff；`publish.takedown.check` | required |
| `admin.takedownTask.sendBreachNotice` | `POST /admin/takedown-tasks/{takedownTaskId}/send-breach-notice` | 发送违约提醒 | staff；`publish.takedown.breach_notice` | required |
| `admin.metricImport.create` | `POST /admin/metric-imports` | V1.1：上传 Excel 并逐行校验 | staff；V1.1 定 | required |
| `admin.metricImport.template.get` | `GET /admin/metric-imports/template` | V1.1：下载录入模板 | staff；模块查看 publish | none（查询） |
| `admin.metricImport.commit` | `POST /admin/metric-imports/{metricImportId}/commit` | V1.1：提交导入 | staff；V1.1 定 | required |
| `admin.metricSubmission.list` | `GET /admin/metric-submissions` | V1.1：作品数据提交队列 | staff；模块查看 publish | none（查询） |
| `admin.metricSubmission.approve` | `POST /admin/metric-submissions/{metricSubmissionId}/approve` | V1.1：录入指标并通过 | staff；V1.1 定 | required |
| `admin.metricSubmission.reject` | `POST /admin/metric-submissions/{metricSubmissionId}/reject` | V1.1：驳回数据提交 | staff；V1.1 定 | required |

字面段先于参数段注册（A8、C12）：`/admin/channel-accounts/summary` 先于 `/{channelAccountId}`；`/admin/patrol-tasks/summary` 先于 `/{patrolTaskId}`；`/admin/takedown-tasks/summary`、`/admin/takedown-tasks/check` 先于 `/{takedownTaskId}`；`/admin/metric-imports/template` 先于 `/{metricImportId}`。

### 1.1 本文通用规则

| 事项 | 规则 |
| --- | --- |
| 鉴权 | 全部 `x-auth: staff`（C2）。查看类不设权限点，按模块等级 `publish`（`v` 及以上）判定（d4-identity.md:1163；C66）；渠道账号的列表、计数与详情另接受 `merchant` 模块查看（商家详情“渠道账号”页签及行展开）。写接口的权限点取自注册表（d4-identity.md:1190）；`publish.link.verify_revoke` 与 `publish.metrics.enter`（V1.1）不在注册表，已按 A129 进增补表（C66；默认授予与“要求二次确认回显”见清单 `permissionSupplements`）。模块等级为 `o`（本人任务）的员工，写接口另校验任务归属：所属交付工单的 `delivery_ticket.publisher_id` 是本人，不是则 403 `PERMISSION_DENIED`（d4-identity.md:1364 的“o 级校验任务归属”）。账号核验没有任务归属，不做此项校验（11-publish.md:17） |
| 数据范围 | 任务类资源（链接核验、上线任务、上线日历、巡检、下架、发布清单、成片包）按所属交付工单取：`delivery_ticket.publisher_id`、`delivery_ticket.delivery_manager_id` 在有效范围的负责人集合内，或门店由我（们）负责；发布主管另含 `ticket_publisher` 待分配池（d4-identity.md:1265-1290 的 `taskScope`）。渠道账号按门店（`byStore`）。账号核验（`kind = channel_account`）的可见与可决定范围以 a01 2.10 的审批类型规则为准：它是角色队列，持有 `publish.account.verify` 即可看全部、决定全部，不套数据范围（11-publish.md:17）；不持有该权限点的员工看核验详情按门店套范围。a01 现文对所有 `kind` 套数据范围，已请 a01 在 2.10 为本类型注明例外，队列（`admin.approval.list`）、详情与决定三处同一口径。不在范围内一律 404 `NOT_FOUND`（C24、C58） |
| 员工姓名 | 后台显示 `staff.name`；引用员工一律用 a01 2.2 的 `StaffBrief` |
| 商家称呼 | 门店名 `store.name`，主体名 `entity.name`；商家用户显示该主体下的 `entity_member.display_name`（空时取 `merchant_user.display_name`） |
| 字典 | 原因、异常类型的名称取 `dict_item.name`（按 `dict_item.dict_type_key` + `dict_item.code`）；读历史不看 `dict_item.is_enabled`。写接口对提交的编码调 `dicts.assertEnabled`：编码不在字典里或已停用返回 409 `DICT_ITEM_DISABLED`（m08 定义，`details = { dictTypeKey, code }`，A77、C28）；编码存在但不属于对应场景（`reject_reason` 按 `dict_item.ext` 的 `scene`）或格式不对，返回 400 `VALIDATION_FAILED`（`fieldErrors` 指向该字段） |
| 清单 | 待处理表单的条目由页面经 a01 `admin.checklistTemplate.list?code=` 取当前启用版本；本文的详情只返回已给出的结论（`AdminChecklistItemView`，条目名与 `merchantVisible` 按记录上的编码与版本号取 `checklist_template.items`；商家端直接展示 `launch.verify`、`patrol.check` 里 `merchantVisible` 的条目与审批单的 `checklist_result`，后台写入的就是商家看到的）。提交用 `ChecklistResultInput`（a05 2.1）：带 `checklistVersionNo`，不是该编码当前启用版本返回 409 `CHECKLIST_VERSION_STALE`（a01 定义；14-config-data.md:664）。“全部通过”= 模板里每个必填条目都有结论且为 `pass`（标了 `allowNa` 的条目可为 `na`），没有 `fail`；不满足返回 400 `CHECKLIST_NOT_PASSED`（a01 定义，A77、C28）。`fail` 必带 `note`，`na` 只用于 `allowNa` 的条目（d3-flow.md:1499） |
| 截图与文件 | 请求里的截图只传 `fileId`：先经 a01 `admin.file.create`、`admin.file.complete` 上传，分类 `evidence`，归属任务所在门店；须已入库（`stored`）、分类与门店相符、同一请求内不重复，否则 400 `FILE_NOT_USABLE`（m03 定义）。登记与签发的授权按 a01 2.17 的文件分类矩阵：`evidence` 的后台登记要 `publish.takedown.check`、`publish.patrol.do` 或 `publish.link.verify`，签发要模块 `publish` ≥ v 且文件门店在数据范围内，每次签发写 `access` 审计。业务事务里经 `files.link()` 登记 `file_ref`（`ref_type` 与角色见 11-publish.md:750）。`evidence` 在 secure 桶，响应只给 `fileId`，查看经 `admin.file.downloadUrls` 签发并留痕；渠道账号主页截图（分类 `channel_screenshot`，asset 桶）随核验详情返回 30 分钟对齐窗口的签名地址（`ImageRef`，m08 2.1；A132、C60、C61、C87） |
| 日期 | “今天”“逾期天数”“距上线天数”按北京时间算（C35）；`…Date` 为 `YYYY-MM-DD` |
| 审批类 | 账号核验、链接核验的决定走本文的领域接口（A14、C67）：同一事务里迁移审批单（03-staff-authz-audit.md:805-806）并调该 `kind` 的处理器 `onApproved` / `onRejected`；锁序为审批单 → 领域行（审批单 `lock_rank = 30`，其后各行见下面“锁序”一行）。审批单已不是 `pending` 返回 409 `APPROVAL_NOT_PENDING`；审批人与发起人相同返回 403 `APPROVAL_SELF_FORBIDDEN`（只会出现在撤销核验后由撤销人送审的那一轮，03-staff-authz-audit.md:786）。通过与驳回都取消决定时限定时器 `sla.breach:approval_request:{id}:decision` |
| 审批决定的守卫顺序 | 与 a03 第 1.1 节相同（C7；d4-identity.md:1360-1364），用于账号核验、链接核验的通过与驳回（3.6、3.7、3.17、3.18）：路由级的模块等级、权限点 403 `PERMISSION_DENIED` → 再验证（`publish.account.verify`、`publish.link.verify` 在注册表里没有标再验证，不触发；驳回也不登记 C86 的 `x-step-up: skip`）→ 服务层取对象（范围外 404）→ 审批单不是 `pending` 409 `APPROVAL_NOT_PENDING` → 审批人是发起人 403 `APPROVAL_SELF_FORBIDDEN` → 处理器追加的权限判定（链接核验 `o` 级的任务归属；账号核验没有此项）403 `PERMISSION_DENIED` → `lockVersion`（只有通过带）409 `VERSION_CONFLICT` → `confirm`（只有通过带）409 `CONFIRM_MISMATCH` → 请求体校验与事务内重算业务前提，变了回滚并 409 `PRECONDITION_CHANGED`，审批单保持 `pending`（d4-identity.md:1398-1412；03-staff-authz-audit.md:805）。撤销核验通过（3.19）不是审批决定，按其接口里的守卫 |
| 状态历史与审计 | 每次状态迁移写 `status_transition`（machine 与 state_field 见 11-publish.md:58）并补一条活动流审计（M31）；不改状态的动作（再次提醒、升级、违约提醒）写 `from_state = to_state` 的一行；其余写操作写审计 |
| 锁序 | 按数据模型的 `lock_rank` 升序加锁，同一层多行按 id 升序：审批单 30 → 订购单 `drama_order` 160 → 订单项 `order_item` 170 → 交付工单 `delivery_ticket` 180 → 渠道账号 `channel_account` 190 → 成片包 `delivery_release` 210 → 上线任务 `launch_task` 230 → 巡检 `patrol_task` 250 → 下架任务 `takedown_task` 280（09-order-ad.md:109、247；10-delivery.md:75、817；11-publish.md:64、227、476、579）。只读的行先查出 id，再按上面的顺序锁；各写接口的“副作用”写明本接口锁哪几层 |
| 通知 | 本文接口不直接发通知，只写出站事件（事件名取 x01 事件目录，C84），由通知中心派发。人工催办先插 `manual_reminder_log`：同一对象同一场景每日一次，唯一冲突返回 409 `REMINDED_TODAY`（通用码 40920，C27、A76）、不发通知（13-notify-docs.md:614）；端上提示“今天已提醒过”，不自动重试 |
| 列表 | 页码分页（C43）：`page`（从 1 起）、`pageSize`（默认 20，上限 100），响应 `AdminPage<X>`（a01 2.1）；页签 `tab=`、关键词 `q=`（C45）；页签计数由同名 `summary` 给，查询参数与列表相同（除 `tab`、分页外，C83）。队列页每 30 秒静默刷新计数（d7-platform.md:1052） |
| 结果脱敏 | 响应带签名地址的 `required` 写接口按 C50“结果脱敏”（A80）：幂等记录只存脱敏后的结果，契约登记 `x-redact-on-replay`（A124）。本文适用 4 条：账号核验通过与驳回（`screenshots[].url`、`screenshots[].expiresAt`）、保存发布清单（`cover.url`、`cover.expiresAt`）、导入发布清单（`publishList.cover.url`、`publishList.cover.expiresAt`）。这些字段在写接口的响应里声明为可空：首次调用总有值，同键重放时为 `null`；响应另带 `replayed: boolean`（重放为 `true`）。端上需要图片时重新调对应的 GET |
| 工作台计数 | a02 工作台的待办与预警与本文队列同口径，计数函数只实现一处：⑧ `takedown_check` = 3.30 的 `pending`；⑫ `patrol_pending` = 3.21（`openOnly=true`）的 `pending`；预警 `launch_overdue` = 只读端口 `publish.listOverdueLaunchItems`（3.14 的 `overdue` 口径，3.15 的 `overdue` 计数同一函数）；⑥ `launch_verify`、⑪ `account_verify` 的队列计数由 a01 `admin.approval.summary`（固定 `kind`）给，本文不另设；⑤ `release_deliver`（工单步骤 `delivering`）属 a05 的工单列表与计数 |
| 并发 | 状态迁移不带 `lockVersion`，只有守卫列了锁版本的才带：账号核验、链接核验的“通过”带审批单的 `lockVersion`（03-staff-authz-audit.md:805；C53）。发布清单的保存与导入是内容编辑，带 `publish_list.lock_version`（A21）。不一致返回 409 `VERSION_CONFLICT` |
| 二次确认 | 审批类的“通过”与撤销核验通过带 `confirm` 回显（C54），字段逐接口列出；不一致返回 409 `CONFIRM_MISMATCH` |
| 限流 | 全部 `admin.global`（C68） |
| V1.1 | 数据录入的 6 条接口 V1.0 不挂载、不建表（01-architecture.md:206），菜单按设计规范第 14 节第 9 项隐藏 |

## 2. 公共结构

类型写法按写作规范：`string(uuid)`、`string(date-time)`、`string(date)`、`string(bigint)`、`integer`、`enum(…)`、`boolean`、`array<…>`、`object`，可空写 `| null`。“来源”写表列或计算规则。后台不按角色裁剪字段（C58）。

### 2.1 通用片段

引用其他文档已定义的公共片段，同名同构，本文不重新定义（C87 公共结构登记表；清单 `externalSchemas` 同步列出）：

| 结构 | 定义方 | 字段 | 本文用处 |
| --- | --- | --- | --- |
| `AdminPage<X>` | a01-system 2.1 | `{ items, page, pageSize, total }` | 全部列表（C43） |
| `ImageRef` | m08-support-misc 2.1 | `{ fileId, url, expiresAt }` | 主页截图、合集封面（C60、C61）；初稿的“`SignedUrl` & `{ fileId }`”按 A132、C87 改为引用它。结果脱敏的响应里 `url`、`expiresAt` 声明为可空（1.1） |
| `StaffBrief` | a01-system 2.2 | `{ staffId, staffNo, name, roleKey, isLead, status }` | 负责人、审批人、核查人、保存人、推送人 |
| `AdminStoreBrief` | a05-order-delivery 2.1 | `{ storeId, storeName, entityId, entityName, city, district, qualificationStatus }`（`city`、`district` 为 `DictRef` \| null，A151） | 各行的门店与主体（`entityName` 即营业执照主体，账号核验比对“认证主体”用它）。初稿的同名异构 `StoreBrief` 删除 |
| `AdminChecklistItemView` | a05-order-delivery 2.1 | `{ key, label, result, note, merchantVisible }` | 已给出的清单结论；`label`、`merchantVisible` 按记录上的编码与版本号取 `checklist_template.items`（商家端按 `merchantVisible` 展示，m05 的请求）。初稿的 `ChecklistItemView` 删除 |
| `ChecklistResultInput`（请求片段） | a05-order-delivery 2.1 | `{ checklistVersionNo, results: [{ key, result, note }] }` | 提交清单结论；本文另按 1.1“清单”校验全部通过，`key` 覆盖模板全部必填条目且不重复，`fail` 必带 `note`（≤ 200 字），结论落记录的 `ChecklistResults`（11-publish.md:760） |
| `ApprovalDecisionView` | a01-system 2.10 | 审批单决定信息 | 本文 `ApprovalView` 的基础 |
| `DictRef` | 约定 C85（通用结构，C87） | `{ code, name }` | 响应里的字典项（原因、异常类型、补发原因、门店市与区县；单值为 `DictRef` \| null，A151）；请求里收编码 |
| `FollowUpItem` | a03-merchant 2.10 | 跟进记录（`recorder`、`owner`、`isOpen`、`lockVersion`、`actions` 等） | 逾期未上线的跟进；与 a03 `admin.followUp.create` 的响应同构，新记录可直接插进卡片 |
| `ChannelAccountBrief` | m05-delivery-publish 2.1 | `{ channelAccountId, platform, accountName, accountUid, status }` | 发布账号（`accountName` 为当前值） |

#### `OrderItemBrief`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderItemId` | string(uuid) | 是 | 订单项 | `order_item.id` |
| `orderId` | string(uuid) | 是 | 订购单 | `order_item.drama_order_id` |
| `orderNo` | string | 是 | 订购单号 | `drama_order.order_no` |
| `orderedAt` | string(date-time) | 是 | 订购时间 | `drama_order.submitted_at` |
| `dramaTitle` | string | 是 | 剧名 | `order_item.drama_snapshot` 的 `title` |
| `episodeCount` | integer | 是 | 整部集数 | `order_item.episode_count` |
| `productionModel` | enum(`standard`,`advanced`,`top`) | 是 | 制作模型 | `order_item.production_model` |
| `phase` | enum(同 `order_item.phase`) | 是 | 订单项阶段 | `order_item.phase` |
| `agreedLaunchDate` | string(date) \| null | 是 | 约定上线日 | `order_item.agreed_launch_date` |
| `usageStartDate` | string(date) \| null | 是 | 使用期起点（上线首日）；未上线为空 | `order_item.usage_start_date` |
| `usageEndDate` | string(date) | 是 | 使用期止日 | `order_item.usage_end_date` |
| `usageEndSource` | enum(`license`,`early_end`,`expired`) | 是 | 止日来源（“不因延迟上线顺延”的依据） | `order_item.usage_end_source` |
| `liveEpisodeCount` | integer | 是 | 已核验上线集数 | `order_item.live_episode_count` |

#### `TicketBrief`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `deliveryTicketId` | string(uuid) | 是 | 交付工单 | `delivery_ticket.id` |
| `ticketNo` | string | 是 | 工单号 | `delivery_ticket.ticket_no` |
| `step` | enum(同 `delivery_ticket.step`) | 是 | 工单步骤 | `delivery_ticket.step` |
| `isPaused` | boolean | 是 | 暂停中 | `delivery_ticket.pause_count` > 0 |
| `pauseReasons` | array<enum(`cancel_review`,`plan_amendment`)> | 是 | 未解除的暂停原因 | `delivery_ticket_pause.reason`（`released_at` 为空） |
| `deliveryManager` | `StaffBrief` \| null | 是 | 交付经理 | `delivery_ticket.delivery_manager_id` |
| `publisher` | `StaffBrief` \| null | 是 | 发布专员（核验、巡检、下架核查的处理人） | `delivery_ticket.publisher_id` |
| `deliveryTargetAt` | string(date-time) | 是 | 成片交付目标时间 | `delivery_ticket.delivery_target_at` |
| `deliveredAt` | string(date-time) \| null | 是 | 成片包首次推送时间 | `delivery_ticket.delivered_at` |

#### `ApprovalView`

审批单（`approval_request`）的只读视图，供账号核验、链接核验的详情使用：a01 2.10 `ApprovalDecisionView` 的全部字段（`approvalId`、`kind`、`status`、`roundNo`、`submittedAt`、`dueAt`、`badges`、`requester`、`decidedBy`、`isDecidedBySystem`、`decidedAt`、`decisionNote`、`reasons`、`lockVersion`、`actions`，同名同类型，来源同 a01；“截止 今天 19:02”取 `dueAt`，超时看 `badges` 里的 `overdue`，驳回原因看 `reasons[{ code, name }]`，通过时回传 `lockVersion`），另加：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `submitter` | object | 是 | 同 a01 `ApprovalItem.submitter`：`{ actorType, actorId, label }`；撤销核验后重开的一轮为员工（撤销人） | `approval_request.submit_actor_type`、`submit_actor_id` |
| `submitClient` | enum(`weapp`,`portal`,`admin`) \| null | 是 | 送审客户端 | `approval_request.submit_client` |
| `checklist` | object \| null | 是 | 同 a01 `ApprovalDetail.checklist`：`{ code, versionNo, result }`（`code` 为 `launch.verify` 或 `account.verify`），`result` 的元素为 `AdminChecklistItemView`（在 `{ key, result, note }` 上带条目名与 `merchantVisible`）；未决定或决定时没带清单为 `null` | `approval_request.checklist_code`、`checklist_version_no`、`checklist_result` |
| `confirmChecks` | array<string> | 是 | 决定时勾选的核对项 | `approval_request.confirm_checks` |

### 2.2 渠道账号与账号核验

#### `ChannelAccountRow`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `channelAccountId` | string(uuid) | 是 | 账号 | `channel_account.id` |
| `store` | `AdminStoreBrief` | 是 | 所属门店与主体 | `channel_account.store_id` |
| `platform` | enum(见 4.1) | 是 | 平台 | `channel_account.platform` |
| `accountName` | string | 是 | 账号名称 | `channel_account.account_name` |
| `accountUid` | string | 是 | 账号 ID | `channel_account.account_uid` |
| `status` | enum(见 4.1) | 是 | 待核验、可用、异常、已解绑 | `channel_account.status` |
| `accountType` | enum(`enterprise`,`personal`,`none`) \| null | 是 | 发布专员核定的认证类型；核验通过前为空 | `channel_account.account_type` |
| `submittedAccountType` | enum(`enterprise`,`personal`,`none`) | 是 | 最近一轮商家选的类型 | 最大 `channel_account_submission.round_no` 那一行的 `channel_account_submission.filled_snapshot` 的 `accountType` |
| `certSubjectName` | string \| null | 是 | 认证主体名称 | `channel_account.cert_subject_name` |
| `isCertSubjectMatched` | boolean \| null | 是 | 认证主体与营业执照主体一致（“与营业执照一致”）；不是企业认证或未核定时为空 | `account_type = enterprise` 时比较 `channel_account.cert_subject_name` 与 `entity.name`（去空格） |
| `abnormalSource` | enum(`verify`,`manual`) \| null | 是 | 异常来源 | `channel_account.abnormal_source` |
| `abnormalReason` | `DictRef` \| null | 是 | 异常原因 `{ code, name }`（字典 `reject_reason`，场景 `account_verify`；C85，与 m05 `ChannelAccountCard.abnormalReason` 同名） | `channel_account.abnormal_reason_code`，名称取当前 `dict_item.name` |
| `abnormalNote` | string \| null | 是 | 异常说明 | `channel_account.abnormal_note` |
| `boundAt` | string(date-time) | 是 | 绑定时间 | `channel_account.created_at` |
| `submittedAt` | string(date-time) | 是 | 最近一轮提交核验时间 | `channel_account.submitted_at` |
| `verifiedAt` | string(date-time) \| null | 是 | 最近一次核验通过时间 | `channel_account.verified_at` |
| `verifiedBy` | `StaffBrief` \| null | 是 | 最近一次核验通过的发布专员 | `channel_account.verified_by_staff_id` |
| `unboundAt` | string(date-time) \| null | 是 | 解绑时间 | `channel_account.unbound_at` |
| `latestRound` | object | 是 | 最近一轮核验（“核验记录”列，“须于 10-08 10:12 前完成核验”）：`{ channelAccountSubmissionId, roundNo, kind, submittedAt, approvalId, approvalStatus, dueAt }` | 最大 `channel_account_submission.round_no` 的行，与其 `approval_request_id` 指向的 `approval_request.status`、`due_at` |
| `previousDecision` | object \| null | 是 | 上一轮的决定（“09-28 10:20 陈默核验未通过：主页截图不完整”）：`{ roundNo, decidedAt, decidedBy, result, reasons }`；`result` 取上一轮审批单的终态（`approved`、`rejected`、`withdrawn`），`decidedBy` 为 `StaffBrief` \| null，`reasons` 为 array<`DictRef`>（C85）；只有一轮或上一轮未决定时为空 | 轮次第二大的 `channel_account_submission` 所挂 `approval_request` 的 `round_no`、`decided_at`、`decided_by_staff_id`、`status`、`reason_codes`（名称取字典 `reject_reason`）。商家重新提交会清空账号上的异常三列（11-publish.md:132），所以取审批单 |
| `usage` | object | 是 | 使用情况 `{ pendingStartCount, producingCount, toLaunchCount, liveCount }` | `order_item_account.channel_account_id` 联 `order_item.phase` 计数 |
| `activeDramas` | array<object> | 是 | 使用中的剧目（至多 5 条，按约定上线日）：`[{ orderItemId, dramaTitle, phase, agreedLaunchDate }]`（“《二次开业》约定 10-12 上线”）；`agreedLaunchDate` 未确认时为空 | 同上，阶段为 `pending_start`、`producing`、`to_launch`、`live` 的订单项；剧名取 `order_item.drama_snapshot`，约定上线日取 `order_item.agreed_launch_date` |
| `openTakedownTaskCount` | integer | 是 | 本账号上未核查的下架任务数 | `takedown_task` 按 `channel_account_id`、`status` ∈ {`pending_merchant`,`merchant_confirmed`} 计数 |
| `actions` | array<string> | 是 | `mark-abnormal`（`status = available` 且持有 `publish.account.mark_abnormal`） | 计算（C16） |

#### `ChannelAccountRoundView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `channelAccountSubmissionId` | string(uuid) | 是 | 核验提交行 | `channel_account_submission.id` |
| `roundNo` | integer | 是 | 第几轮 | `channel_account_submission.round_no` |
| `kind` | enum(`new_binding`,`resubmit`) | 是 | 新绑定、重新提交 | `channel_account_submission.kind` |
| `submittedAt` | string(date-time) | 是 | 提交时间 | `channel_account_submission.submitted_at` |
| `filled` | object | 是 | 当轮填报 `{ platform, accountName, accountUid, accountType }` | `channel_account_submission.filled_snapshot` |
| `screenshotCount` | integer | 是 | 主页截图张数 | `channel_account_submission.screenshot_file_ids` 的元素数 |
| `compareRows` | array<`CompareRowView`> \| null | 是 | 比对结果；未决定为空 | `channel_account_submission.compare_result` |
| `approval` | `ApprovalView` | 是 | 该轮审批单 | `channel_account_submission.approval_request_id` |

#### `CompareRowView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `field` | enum(见 4.1 `CompareField`) | 是 | 核对项 | `compare_result[].field` |
| `filled` | string \| null | 是 | 商家填报值 | 已决定：`compare_result[].filled`；待审：账号名称、ID、类型取本轮 `filled_snapshot`，认证主体取当前 `entity.name`，账号状态为空（11-publish.md:202） |
| `recognized` | string \| null | 是 | 截图识别值（V1.0 由发布专员手填） | `compare_result[].recognized`；待审为空 |
| `match` | boolean \| null | 是 | 是否一致；待审为空 | `compare_result[].match` |

#### `ChannelAccountEventView`（核验记录时间线）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `at` | string(date-time) | 是 | 时间 | `status_transition.occurred_at` |
| `kind` | enum(见 4.1 `ChannelAccountEventKind`) | 是 | 事件 | `status_transition.event` 映射（`account.bind` → `bound` 等） |
| `actorType` | enum(`merchant`,`staff`,`system`) | 是 | 操作人类型 | `status_transition.actor_type` |
| `actorName` | string \| null | 是 | 操作人（员工姓名或商家称呼） | `status_transition.actor_id` → `staff.name` 或 `entity_member.display_name` |
| `reasons` | array<`DictRef`> | 是 | 原因 `{ code, name }`（C85）；没有为 `[]` | 核验驳回取该轮 `approval_request.reason_codes`；手动标记取 `status_transition.reason_code`；名称取当前 `dict_item.name` |
| `note` | string \| null | 是 | 说明 | `approval_request.decision_note` 或 `status_transition.note` |

#### `ChannelAccountDetail`

`ChannelAccountRow` 的全部字段，另加：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `rounds` | array<`ChannelAccountRoundView`> | 是 | 历次核验，按轮次倒序 | `channel_account_submission`（`channel_account_id` = 本账号） |
| `history` | array<`ChannelAccountEventView`> | 是 | 核验记录，按时间正序 | `status_transition`（`machine = channel_account`，`subject_id` = 本账号） |

#### `ChannelAccountSubmissionDetail`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `channelAccountSubmissionId` | string(uuid) | 是 | 核验提交行 | `channel_account_submission.id` |
| `roundNo` | integer | 是 | 第几轮 | `channel_account_submission.round_no` |
| `kind` | enum(`new_binding`,`resubmit`) | 是 | 队列卡片的“新绑定 / 重新提交” | `channel_account_submission.kind` |
| `isCurrentRound` | boolean | 是 | 是该账号的最新一轮 | `round_no` 等于该账号最大轮次 |
| `submittedAt` | string(date-time) | 是 | 提交时间 | `channel_account_submission.submitted_at` |
| `submittedByName` | string | 是 | 提交人（老板）称呼 | `channel_account_submission.submitted_by_user_id` → `entity_member.display_name` |
| `account` | `ChannelAccountRow` | 是 | 账号当前状态与使用情况（标题区的“商家主体 · 用途”） | `channel_account_submission.channel_account_id` |
| `filled` | object | 是 | 当轮填报 `{ platform, accountName, accountUid, accountType }` | `channel_account_submission.filled_snapshot` |
| `screenshots` | array<`ImageRef`> | 是 | 主页截图（30 分钟对齐窗口） | `channel_account_submission.screenshot_file_ids` 现签 |
| `compareRows` | array<`CompareRowView`> | 是 | 比对表，固定 5 行（账号名称、账号 ID、账号类型、认证主体、账号状态） | 见 `CompareRowView` |
| `approval` | `ApprovalView` | 是 | 本轮审批单 | `channel_account_submission.approval_request_id` |
| `otherRounds` | array<`ChannelAccountRoundView`> | 是 | 该账号的其他轮次，按轮次倒序 | `channel_account_submission` |
| `history` | array<`ChannelAccountEventView`> | 是 | 核验记录 | 同 `ChannelAccountDetail.history` |
| `actions` | array<string> | 是 | `approve`、`reject`：审批单 `pending` 且持有 `publish.account.verify` | 计算 |

#### `ChannelAccountDecisionResult`

账号核验通过与驳回（3.6、3.7）的响应：`ChannelAccountSubmissionDetail` 的全部字段，其中 `screenshots[].url`、`screenshots[].expiresAt` 声明为可空（首次调用有值，同键重放为 `null`，1.1“结果脱敏”），另加：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `replayed` | boolean | 是 | 本次是同键重放（与回包头 `Idempotent-Replayed` 同义，C50） | 幂等层 |

### 2.3 发布清单与成片包

#### `PublishListAdminView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `publishListId` | string(uuid) | 是 | 发布清单 | `publish_list.id` |
| `ticket` | `TicketBrief` | 是 | 所属工单 | `publish_list.delivery_ticket_id` |
| `orderItem` | `OrderItemBrief` | 是 | 订单项 | `delivery_ticket.order_item_id` |
| `collectionName` | string \| null | 是 | 合集名称（“夜巷疑云（全 45 集）”） | `publish_list.collection_name` |
| `cover` | `ImageRef` \| null | 是 | 合集封面（默认剧目竖版海报，30 分钟窗口）；保存与导入的响应里 `url`、`expiresAt` 可空（1.1“结果脱敏”） | `publish_list.cover_file_id` 现签 |
| `titleTemplate` | string \| null | 是 | 每集标题模板（占位符 `{剧名}`、`{集数}`、`{看点}`） | `publish_list.title_template` |
| `topics` | array<string> | 是 | 话题标签 | `publish_list.topics` |
| `intro` | string \| null | 是 | 简介 | `publish_list.intro` |
| `isAiDeclarationRequired` | boolean | 是 | 发布时需做 AI 内容声明（随剧与制作方式带出，不可编辑） | `publish_list.is_ai_declaration_required` |
| `episodes` | array<object> | 是 | 逐集 `[{ episodeNo, highlight, title, renderedTitle, topics, intro, changedInReleaseNo }]`，集号 1..N 全部给出；`renderedTitle` 为最终标题（`title` 为空时按模板渲染），模板与看点都缺时为空 | `publish_list_episode`（`highlight`、`title`、`topics`、`intro`、`changed_in_release_no`）；渲染用 `packages/shared` 的纯函数（d3-flow.md:1634） |
| `completeness` | object | 是 | 推送守卫的完整度：`{ isComplete, missing, untitledEpisodeNos }`；`missing` 取值见 4.3 `PublishListMissingItem` | 按 10-delivery.md:1157 的守卫计算；publish 模块只实现一个完整性判定函数，a05 推送守卫的 `publish_list_incomplete` 与 a05 `admin.deliveryTicket.get` 的 `publishList.isComplete`（a05-order-delivery.md:597）都调它 |
| `isEditable` | boolean | 是 | 现在能否保存或导入 | 见 3.9 的守卫 |
| `lockReason` | enum(见 4.3) \| null | 是 | 不可编辑的原因 | 计算 |
| `savedBy` | `StaffBrief` \| null | 是 | 最近一次保存人 | `publish_list.saved_by_staff_id` |
| `savedAt` | string(date-time) \| null | 是 | 最近一次保存时间 | `publish_list.saved_at` |
| `lockVersion` | integer | 是 | 乐观锁版本，保存与导入时回传 | `publish_list.lock_version` |
| `activeRelease` | object \| null | 是 | 生效中的成片包 `{ deliveryReleaseId, releaseNo, pushedAt }`；未推送为空 | `delivery_release`（`state = pushed`） |

#### `PublishListSaveResult`

保存发布清单（3.9）的响应：`PublishListAdminView` 的全部字段（`cover.url`、`cover.expiresAt` 可空，1.1“结果脱敏”），另加 `replayed`（boolean，同键重放为 `true`，C50）。

#### `ReleaseManifestItem`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `episodeNo` | integer | 是 | 集号 | `manifest_snapshot[].episodeNo` |
| `outputId` | string(uuid) | 是 | 成片剧集 | `manifest_snapshot[].outputId` |
| `fileId` | string(uuid) | 是 | 成片文件（员工下载经 `admin.file.downloadUrls`） | `manifest_snapshot[].fileId` |
| `fileName` | string | 是 | 推送时的文件名（`剧名_第NN集.mp4`） | `manifest_snapshot[].name` |
| `sizeBytes` | string(bigint) | 是 | 字节数 | `manifest_snapshot[].size` |
| `crc64` | string | 是 | 校验值 | `manifest_snapshot[].crc64` |
| `isChanged` | boolean | 是 | 相对上一包有变更 | 集号在 `delivery_release.changed_episode_nos` 内 |

#### `DeliveryReleaseDetail`

同一张成片包表在 a05 与本文用同一形状：a05 2.7 `ReleaseAdminView` 的全部字段（`deliveryReleaseId`、`releaseNo`、`kind`、`state`、`variant`、`episodeCount`、`totalBytes`、`changedEpisodeNos`、`precheck`、`reason`、`note`、`pushedBy`、`pushedAt`、`supersededAt`、`closedAt`、`closeReason`、`savedEpisodeCount`，同名同类型，来源同 a05；`precheck` 为 array<`AdminChecklistItemView`>，条目名按 `delivery_release.checklist_code`、`checklist_version_no` 取模板；`pushedBy` 为 `StaffBrief`；`reason` 为补发原因 `DictRef` \| null，C85、A151），另加：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `ticket` | `TicketBrief` | 是 | 所属工单 | `delivery_release.delivery_ticket_id` |
| `orderItem` | `OrderItemBrief` | 是 | 订单项 | `delivery_release.order_item_id` |
| `store` | `AdminStoreBrief` | 是 | 门店 | `delivery_release.store_id` |
| `manifest` | array<`ReleaseManifestItem`> | 是 | 文件清单（逐集格子），按集号 | `delivery_release.manifest_snapshot` |
| `publishListText` | string \| null | 是 | 渲染好的发布清单文本 | `delivery_release.publish_list_text` |
| `activeGrant` | object \| null | 是 | 对主体的有效下载授权 `{ downloadGrantId, expiresAt }`（“下载链接 7 天有效”）；没有为空 | `download_grant`（`delivery_release_id` = 本包，`grantee_type = entity`，`state = active` 且 `expires_at` 晚于现在） |
| `actions` | array<string> | 是 | `pack`：`state = pushed`、`activeGrant` 非空，且持有 `publish.package.push` | 计算 |

本结构不带 ZIP 缓存状态：`zip_bundle` 归 media，delivery 不读该表、也没有只读端口（06-media.md:983），唯一取得状态的 `media.ensureZip` 有副作用，GET 不能调（C60）。打包状态只在 3.12 的响应里给出；原型没有展示 ZIP 状态的位置。

#### `DeliveryReleasePackResult`

预打包（3.12）的响应，字段取 `media.ensureZip` 的返回值（06-media.md:983）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `deliveryReleaseId` | string(uuid) | 是 | 成片包 | 请求 |
| `zipBundleId` | string(uuid) | 是 | ZIP 缓存行 | `ensureZip` 返回的 `zipBundleId` |
| `zipState` | enum(见 4.3 `ZipState`) | 是 | 调用后的状态：一般为 `building`；已就绪为 `ready` | `ensureZip` 返回的 `zipState` |
| `zipGen` | integer | 是 | 打包代次 | `ensureZip` 返回的 `zipGen` |
| `zipFileId` | string(uuid) \| null | 是 | ZIP 文件（仅 `ready`；员工下载经 `admin.file.downloadUrls`） | `ensureZip` 返回的 `zipFileId` |
| `publishListFileId` | string(uuid) \| null | 是 | 同代次的发布清单文件（仅 `ready`，清单文本为空时为空） | `ensureZip` 返回的 `publishListFileId` |

### 2.4 上线日历与逾期跟踪

#### `LaunchTaskBrief`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `launchTaskId` | string(uuid) | 是 | 上线任务 | `launch_task.id` |
| `platform` | enum(`douyin`,`wechat_channels`) | 是 | 平台 | `launch_task.platform` |
| `account` | `ChannelAccountBrief` | 是 | 发布账号 | `launch_task.channel_account_id` |
| `reviewStatus` | enum(见 4.4) | 是 | 最近一轮回填的审核结果 | `launch_task.review_status` |
| `isLive` | boolean | 是 | 已上线 | `launch_task.is_live` |
| `currentRoundNo` | integer | 是 | 当前回填轮次；0 = 尚未回填 | `launch_task.current_round_no` |
| `verifiedEpisodeCount` | integer | 是 | 已核验集数 | `launch_task.verified_episode_count` |
| `firstLaunchDate` | string(date) \| null | 是 | 该账号上线首日 | `launch_task.first_launch_date` |
| `isOverdue` | boolean | 是 | 逾期未上线（判定见 3.14） | 计算 |
| `currentSubmissionId` | string(uuid) \| null | 是 | 当前一轮的回填行（`reviewStatus = verifying` 时即核验中的那一轮，“去核验”跳 3.16）；尚未回填为空 | `launch_submission`（`launch_task_id` = 本任务，`round_no` = `launch_task.current_round_no`） |
| `latestPassedSubmissionId` | string(uuid) \| null | 是 | 最近一条已通过的回填行（撤销核验通过的入口，3.19）；没有为空 | `launch_submission`（本任务，`result` ∈ {`passed`,`passed_partial`}，`round_no` 最大） |

#### `LaunchCalendarItem`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderItemId` | string(uuid) | 是 | 订单项 | `order_item.id` |
| `ticket` | `TicketBrief` | 是 | 交付工单 | `delivery_ticket`（`order_item_id` 一对一） |
| `store` | `AdminStoreBrief` | 是 | 门店（色块显示门店名） | `order_item.store_id` |
| `dramaTitle` | string | 是 | 剧名 | `order_item.drama_snapshot` |
| `episodeCount` | integer | 是 | 集数 | `order_item.episode_count` |
| `agreedLaunchDate` | string(date) | 是 | 约定上线日；方案未确认时取已推送方案当前版本里的日期 | `order_item.agreed_launch_date`；为空时取 `delivery_plan_version.content_snapshot` 的 `items[].agreedLaunchDate`（`delivery_plan.drama_order_id` = 本订购单，`version_no` = `delivery_plan.current_version_no`，10-delivery.md:1271） |
| `isDateTentative` | boolean | 是 | 日期未经方案确认（“方案确认”中，可能变） | `order_item.agreed_launch_date` 为空 |
| `calendarStatus` | enum(见 4.4 `CalendarStatus`) | 是 | 制作中、待上线、上线核验、已逾期 | 见 3.13 的归类规则 |
| `accounts` | array<`ChannelAccountBrief`> | 是 | 发布账号（渠道）；方案未确认时取方案版本里的账号 | `order_item_account` 联 `channel_account`；为空时取同一方案版本的 `items[].accounts` |
| `tasks` | array<`LaunchTaskBrief`> | 是 | 上线任务（含 `currentSubmissionId`，当日面板“去核验”用）；成片未推送时为空数组 | `launch_task`（`order_item_id`，`review_status` ≠ `void`） |
| `isDeliveryLate` | boolean | 是 | 成片未交付且已过交付目标（“成片应于 09-29 交付，已超时”） | `delivery_ticket.delivered_at` 为空且现在 > `delivery_ticket.delivery_target_at` |
| `overdueDays` | integer \| null | 是 | 已逾期天数；不逾期为空 | 见 3.14 |
| `latestFollowUp` | `FollowUpItem` \| null | 是 | 最近一条跟进（逾期项的“跟进情况”） | `follow_up`（`subject_type = order_item`，`subject_id` = 本订单项）最新一条 |
| `actions` | array<string> | 是 | `remind`：条件同 `LaunchTrackItem.actions` | 计算 |

#### `LaunchCalendar`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `from` | string(date) | 是 | 查询起始日 | 请求 |
| `to` | string(date) | 是 | 查询截止日（含） | 请求 |
| `today` | string(date) | 是 | 今天（“今天”标记） | 服务端 |
| `stats` | object | 是 | 统计行 `{ total, producing, toLaunch, verifying, overdue }`（“当前视图 N 项 · 待上线 N · 核验中 N · 逾期 N”） | 按 `calendarStatus` 计数（不受 `limit` 截断） |
| `days` | array<object> | 是 | `[{ date, items: LaunchCalendarItem[] }]`，只含有事项的日期，按日期升序；同日按门店名 | 计算 |
| `total` | integer | 是 | 事项总数 | 计数 |
| `isTruncated` | boolean | 是 | 被 `limit` 截断（工作台“另有 N 项，详见上线日历”） | `total` > 返回条数 |

#### `LaunchTrackItem`

逾期跟踪的一行，按订单项聚合，标出逾期的是哪个账号（d3-flow.md:1814）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderItem` | `OrderItemBrief` | 是 | 订单项（剧目、集数、订购日、约定上线日、使用期） | `order_item.id` |
| `ticket` | `TicketBrief` | 是 | 工单（工单号、步骤、交付经理、发布专员、成片交付时间） | `delivery_ticket` |
| `store` | `AdminStoreBrief` | 是 | 商家 | `order_item.store_id` |
| `isDelivered` | boolean | 是 | 成片已交付（“仅看成片已交付”） | `delivery_ticket.delivered_at` 非空 |
| `overdue` | object \| null | 是 | 逾期：`{ startDate, days, reason }`；`reason` 为 `merchant`（商家未按期上线）或 `late_delivery`（成片晚于约定日交付，单独标注）；不逾期为空 | 见 3.14 |
| `daysUntilLaunch` | integer \| null | 是 | 距约定上线日天数（“距上线 N 天”）；约定上线日不早于今天时有值 | `agreed_launch_date` − 今天 |
| `tasks` | array<`LaunchTaskBrief`> | 是 | 该订单项未作废的上线任务（含 `currentSubmissionId`、`latestPassedSubmissionId`，工单详情的“上线任务、上线核验”与撤销入口用）；成片未推送时为空数组 | `launch_task`（`order_item_id`，`review_status` ≠ `void`） |
| `followUpCount` | integer | 是 | 跟进记录条数 | `follow_up` 按对象计数 |
| `followUps` | array<`FollowUpItem`> | 是 | 最近 3 条跟进（完整时间线经 a03 `admin.followUp.list`；该接口与 `admin.followUp.summary` 为 `assert-in-handler`，`order_item`、`patrol_task`、`takedown_task` 对照发布管理模块，持 `publish` 查看且对象在数据范围内即可） | `follow_up`（`subject_type = order_item`） |
| `lastRemindedAt` | string(date-time) \| null | 是 | 最近一次人工提醒上线 | `manual_reminder_log`（`subject_type = order_item`、`scene = golive`）的 `created_at` 最大值 |
| `isRemindedToday` | boolean | 是 | 今天已提醒（按钮变“已提醒”） | 同上，`biz_date` = 今天 |
| `actions` | array<string> | 是 | `remind`：与 a05 `admin.deliveryTicket.remind`（`scene = golive`）的场景守卫逐条一致——工单在 `awaiting_launch` 或 `launch_verify`，有未作废、未上线、`review_status` ∈ {`pending`,`need_fix`} 的上线任务，今天未提醒，且持有调用 a05 接口的权限（a05 3.23 的鉴权）。双平台一个账号已上线、工单已在 `in_service` 的逾期项不给 `remind`，只能记录跟进（第 6 节第 10 项） | 计算 |

### 2.5 链接核验

#### `LaunchRoundView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `launchSubmissionId` | string(uuid) | 是 | 回填行 | `launch_submission.id` |
| `roundNo` | integer | 是 | 轮次 | `launch_submission.round_no` |
| `result` | enum(见 4.4) | 是 | 本轮结果 | `launch_submission.result` |
| `submittedAt` | string(date-time) | 是 | 回填时间 | `launch_submission.submitted_at` |
| `reportedEpisodeCount` | integer | 是 | 声明集数 | `launch_submission.reported_episode_count` |
| `verifiedEpisodeCount` | integer \| null | 是 | 核验集数 | `launch_submission.verified_episode_count` |
| `actualLaunchDate` | string(date) | 是 | 实际上线日期 | `launch_submission.actual_launch_date` |
| `reopenOfLaunchSubmissionId` | string(uuid) \| null | 是 | 撤销后重开时指向被撤销的行 | `launch_submission.reopen_of_launch_submission_id` |
| `decidedAt` | string(date-time) \| null | 是 | 决定时间 | `approval_request.decided_at` |
| `decidedBy` | `StaffBrief` \| null | 是 | 核验人 | `approval_request.decided_by_staff_id` |
| `reasons` | array<`DictRef`> | 是 | 退回原因（C85；与 a01 `ApprovalItem.reasons` 同构） | `approval_request.reason_codes`；名称取字典 `reject_reason` 的 `dict_item.name` |
| `decisionNote` | string \| null | 是 | 说明 | `approval_request.decision_note` |

#### `LaunchSubmissionDetail`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `launchSubmissionId` | string(uuid) | 是 | 回填行 | `launch_submission.id` |
| `launchTaskId` | string(uuid) | 是 | 上线任务 | `launch_submission.launch_task_id` |
| `roundNo` | integer | 是 | 第几轮 | `launch_submission.round_no` |
| `result` | enum(见 4.4) | 是 | 本轮结果 | `launch_submission.result` |
| `isCurrentRound` | boolean | 是 | 是任务的当前轮 | `round_no` = `launch_task.current_round_no` |
| `reopenOfLaunchSubmissionId` | string(uuid) \| null | 是 | 重开来源 | `launch_submission.reopen_of_launch_submission_id` |
| `link` | object | 是 | 回填内容 `{ linkKind, collectionUrl, episodeUrls, reportedEpisodeCount, actualLaunchDate, submittedAt, submitActorType, submitClient, submittedByName }`；`episodeUrls` 为 `[{ episodeNo, url }]` | `launch_submission` 的 `link_kind`、`collection_url`、`episode_urls`、`reported_episode_count`、`actual_launch_date`、`submitted_at`、`submit_actor_type`、`submit_client`；称呼取 `submit_actor_id` → `entity_member.display_name` |
| `verifiedEpisodeCount` | integer \| null | 是 | 本轮核验集数 | `launch_submission.verified_episode_count` |
| `evidenceFileIds` | array<string(uuid)> | 是 | 核验截图 | `launch_submission.evidence_file_ids` |
| `account` | `ChannelAccountBrief` & { `accountType` } | 是 | 发布账号（“抖音 · 账号名（抖音号）”） | `launch_task.channel_account_id` 联 `channel_account` |
| `task` | `LaunchTaskBrief` & { `wentLiveAt`, `completedAt` } | 是 | 上线任务当前状态 | `launch_task`（`went_live_at`、`completed_at`） |
| `orderItem` | `OrderItemBrief` | 是 | 订单项 | `launch_task.order_item_id` |
| `ticket` | `TicketBrief` | 是 | 工单 | `launch_task.delivery_ticket_id` |
| `store` | `AdminStoreBrief` | 是 | 商家 | `launch_submission.store_id` |
| `licenseLetter` | object \| null | 是 | 该账号的授权书（核对“账号与授权书一致”）`{ licenseLetterId, letterNo, status }` | `license_letter`（`order_item_id`、`channel_account_id` 相同，未作废的最新一份） |
| `approval` | `ApprovalView` | 是 | 本轮核验单 | `launch_submission.approval_request_id` |
| `projectedUsageStartDate` | string(date) \| null | 是 | 按本轮实际上线日期通过后的使用期起点（“使用期 2026-09-29 至 2027-12-31”）；已有更早起点时取更早者 | `min(order_item.usage_start_date, launch_submission.actual_launch_date)` |
| `isPartialGoesLive` | boolean | 是 | 部分集数通过是否即算上线 | 参数 `launch.partial_goes_live`（14-config-data.md:309） |
| `rounds` | array<`LaunchRoundView`> | 是 | 该任务的全部回填轮次，按轮次倒序 | `launch_submission`（`launch_task_id`） |
| `otherTasks` | array<`LaunchTaskBrief`> | 是 | 同一订单项的其他账号（双平台）；其核验中的回填行取 `reviewStatus = verifying` 时的 `currentSubmissionId` | `launch_task`（同 `order_item_id`，不含本任务，`review_status` ≠ `void`） |
| `revoke` | object \| null | 是 | 撤销核验通过的可行性 `{ canRevoke, deadlineAt, blockedReasons }`（`blockedReasons` 取 4.4 `RevokeBlockedReason`）；本轮不是 `passed`、`passed_partial` 时为空 | 见 3.19 的守卫；`deadlineAt` = 审批单 `decided_at` 加参数 `launch.verify_revoke_window`（工作日） |
| `actions` | array<string> | 是 | `approve`、`reject`（审批单 `pending`，持有 `publish.link.verify`）；`revoke`（`revoke.canRevoke` 且持有 `publish.link.verify_revoke`） | 计算 |

### 2.6 作品巡检

#### `PatrolTaskRow`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `patrolTaskId` | string(uuid) | 是 | 巡检任务 | `patrol_task.id` |
| `weekStartDate` | string(date) | 是 | 所属周（周一） | `patrol_task.patrol_batch_id` → `patrol_batch.week_start_date` |
| `source` | enum(见 4.5) | 是 | 每周抽样、手动发起、补发后优先 | `patrol_task.source` |
| `status` | enum(见 4.5) | 是 | 待巡检、正常、异常、已恢复、已作废 | `patrol_task.status` |
| `store` | `AdminStoreBrief` | 是 | 商家 | `patrol_task.store_id` |
| `orderItemId` | string(uuid) | 是 | 订单项 | `patrol_task.order_item_id` |
| `dramaTitle` | string | 是 | 剧名 | `order_item.drama_snapshot` |
| `episodeCount` | integer | 是 | 集数 | `order_item.episode_count` |
| `usageEndDate` | string(date) | 是 | 使用期至 | `order_item.usage_end_date` |
| `launchTaskId` | string(uuid) | 是 | 上线任务 | `patrol_task.launch_task_id` |
| `account` | `ChannelAccountBrief` | 是 | 账号（“抖音 @xx”） | `launch_task.channel_account_id` |
| `previousPatrol` | object \| null | 是 | 上次巡检 `{ patrolTaskId, status, checkedAt }`（“09-22 正常”）；为空即“首次巡检” | 同一上线任务、早于本行建立且已给出结论的最近一条 `patrol_task` |
| `abnormalKind` | `DictRef` \| null | 是 | 异常类型 `{ code, name }`（“审核异常”；字典 `patrol_issue`，C85，与 m05 同名） | `patrol_task.abnormal_kind_code`，名称取当前 `dict_item.name` |
| `checkedAt` | string(date-time) \| null | 是 | 最近一次给出结论的时间（“正常 · 09-29”） | `patrol_task.checked_at` |
| `foundAt` | string(date-time) \| null | 是 | 发现异常时间 | `patrol_task.found_at` |
| `recoveredAt` | string(date-time) \| null | 是 | 复查恢复时间 | `patrol_task.recovered_at` |
| `publisher` | `StaffBrief` \| null | 是 | 处理人（工单的发布专员） | `patrol_task.delivery_ticket_id` → `delivery_ticket.publisher_id` |

#### `PatrolTaskDetail`

`PatrolTaskRow` 的全部字段，另加：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderItem` | `OrderItemBrief` | 是 | 使用期起止等 | `patrol_task.order_item_id` |
| `ticket` | `TicketBrief` | 是 | 工单与负责人 | `patrol_task.delivery_ticket_id` |
| `liveLink` | object \| null | 是 | 作品链接（“外链打开作品”）`{ linkKind, collectionUrl, episodeUrls }` | 该上线任务轮次最大的 `result` ∈ {`passed`,`passed_partial`} 的 `launch_submission` |
| `checklistCode` | string \| null | 是 | 已给出的清单编码（`patrol.check`） | `patrol_task.checklist_code` |
| `checklistVersionNo` | integer \| null | 是 | 清单版本 | `patrol_task.checklist_version_no` |
| `results` | array<`AdminChecklistItemView`> | 是 | 巡检项结论（“5/5”）；未给出为空数组 | `patrol_task.results` |
| `note` | string \| null | 是 | 说明 | `patrol_task.note` |
| `evidenceFileIds` | array<string(uuid)> | 是 | 巡检截图 | `patrol_task.evidence_file_ids` |
| `checkedBy` | `StaffBrief` \| null | 是 | 最近一次结论人 | `patrol_task.checked_by_staff_id` |
| `notifiedAt` | string(date-time) \| null | 是 | 首次通知商家时间（“已于 … 通知商家，等待处理”） | `patrol_task.notified_at` |
| `remindCount` | integer | 是 | 再次提醒次数 | `patrol_task.remind_count` |
| `lastRemindedAt` | string(date-time) \| null | 是 | 最近一次再次提醒 | `manual_reminder_log`（`subject_type = patrol_task`、`scene = patrol_fix`）的 `created_at` 最大值 |
| `isRemindedToday` | boolean | 是 | 今天已提醒 | 同上，`biz_date` = 今天 |
| `followUpDueAt` | string(date-time) \| null | 是 | 仍异常转交付经理待办的时刻（发现后 3 个自然日） | `timer`（`kind = patrol.followup`，主体本行，`status = scheduled`）的 `fire_at` |
| `history` | array<object> | 是 | 同一上线任务的历次巡检（至多 10 条，倒序）`[{ patrolTaskId, weekStartDate, status, checkedAt, abnormalKind }]`（`abnormalKind` 为 `DictRef` \| null） | `patrol_task`（`launch_task_id` 相同，不含本行） |
| `actions` | array<string> | 是 | `mark-normal`、`mark-abnormal`（`pending`）；`recover`、`remind`（`abnormal`；`remind` 另要求今天未提醒） | 计算（持有 `publish.patrol.do`） |

### 2.7 下架核查

#### `TakedownTaskRow`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `takedownTaskId` | string(uuid) | 是 | 下架任务 | `takedown_task.id` |
| `status` | enum(见 4.6) | 是 | 待商家下架、商家已确认、已核查（作废的不返回） | `takedown_task.status` |
| `triggerKind` | enum(见 4.6) | 是 | 生成原因 | `takedown_task.trigger_kind` |
| `basis` | enum(`live`,`delivered_unverified`) | 是 | 核查依据 | `takedown_task.basis` |
| `store` | `AdminStoreBrief` | 是 | 商家 | `takedown_task.store_id` |
| `orderItemId` | string(uuid) | 是 | 订单项 | `takedown_task.order_item_id` |
| `orderNo` | string | 是 | 订购单号 | `drama_order.order_no` |
| `dramaTitle` | string | 是 | 剧名 | `order_item.drama_snapshot` |
| `episodeCount` | integer | 是 | 集数 | `order_item.episode_count` |
| `account` | `ChannelAccountBrief` | 是 | 发布账号 | `takedown_task.channel_account_id` |
| `usageEndDate` | string(date) | 是 | 使用期止日（“使用期 09-28 结束”） | `takedown_task.usage_end_date` |
| `dueDate` | string(date) | 是 | 商家应完成下架的日期 | `takedown_task.due_date` |
| `isOverdue` | boolean | 是 | 逾期未下架 | `status = pending_merchant` 且今天 > `due_date` |
| `overdueDays` | integer \| null | 是 | 逾期天数（“逾期 2 天”） | 今天 − `due_date` |
| `checkDueAt` | string(date-time) \| null | 是 | 核查时限（“今天 18:30 前核查”） | `takedown_task.check_due_at` |
| `isCheckOverdue` | boolean | 是 | 商家已确认且已过核查时限 | `status = merchant_confirmed` 且现在 > `check_due_at` |
| `merchantMethod` | enum(`delete`,`private`,`not_published`) \| null | 是 | 商家确认的下架方式 | `takedown_task.merchant_method` |
| `merchantConfirmedAt` | string(date-time) \| null | 是 | 商家确认时间 | `takedown_task.merchant_confirmed_at` |
| `stillOnlineCount` | integer | 是 | 抽查仍在线次数 | `takedown_task.still_online_count` |
| `escalatedAt` | string(date-time) \| null | 是 | 最近一次升级时间（“已升级至交付主管”） | `takedown_task.escalated_at` |
| `breachNoticeCount` | integer | 是 | 违约提醒次数 | `takedown_task.breach_notice_count` |
| `checkMethod` | enum(`evidence`,`sampled_out`) \| null | 是 | 核查方式 | `takedown_task.check_method` |
| `checkedAt` | string(date-time) \| null | 是 | 核查完成时间 | `takedown_task.checked_at` |
| `publisher` | `StaffBrief` \| null | 是 | 处理人（工单的发布专员） | `takedown_task.delivery_ticket_id` → `delivery_ticket.publisher_id` |
| `actions` | array<string> | 是 | `check`（`pending_merchant` 或 `merchant_confirmed`）；`mark-online`（`merchant_confirmed`）；`escalate`（`isOverdue`）；`send-breach-notice`（`isOverdue` 且今天未发） | 计算（按各自的权限点） |

#### `TakedownEventView`（处理记录）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `at` | string(date-time) | 是 | 时间 | 见下 |
| `kind` | enum(见 4.6 `TakedownEventKind`) | 是 | 事件 | 见下 |
| `actorType` | enum(`merchant`,`staff`,`system`) | 是 | 操作人类型 | 见下 |
| `actorName` | string \| null | 是 | 操作人 | 员工 `staff.name`；商家 `entity_member.display_name` |
| `node` | string \| null | 是 | 自动提醒的节点（`T-30`、`T-7`、`T-1`、`T-0`） | `notification.node` |
| `note` | string \| null | 是 | 说明 | 状态历史行取 `status_transition.note`；跟进行取 `follow_up.content` |

来源（按时间正序合并，四类互不重复）：
- 本任务的 `status_transition`（`machine = takedown_task`），含 `from_state = to_state` 的升级（`takedown.escalate`）、违约提醒（`takedown.breach_notice`）行；违约提醒只从这里取，不再取催办记录。工作日历修正时写的 `from_state = to_state` 行（事件由 `sla` 登记，载荷 `{ calendarVersion, dueAtBefore, dueAtAfter }`，11-publish.md:671）映射为 `check_due_recalculated`，`actorType = system`。
- 自动下架提醒取 `notification`（`notify_scene_key = m.offline_remind`、`biz_type = store`、`biz_id` = 门店，`dedupe_key` 前缀 `offline:{storeId}:{usageEndDate}:`，按节点去重，13-notify-docs.md:1222），映射为 `auto_reminded`。
- 人工催办下架只取 `manual_reminder_log`（`subject_type = takedown_task`、`scene = takedown`），映射为 `manual_reminded`；`scene = breach` 的行与状态历史的违约提醒是同一件事，不取（11-publish.md:749）。
- 逾期未下架的人工跟进取 `follow_up`（`subject_type = takedown_task`、`subject_id` = 本任务，11-publish.md:672；“已升级至交付主管，林晓电话跟进”），映射为 `follow_up`，`actorType` 取 `follow_up.actor_type`。

#### `TakedownTaskDetail`

`TakedownTaskRow` 的全部字段，另加：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderItem` | `OrderItemBrief` | 是 | 使用期起止与止日来源（“结束依据：剧目授权期 09-28 结束”由 `triggerKind` 与 `usageEndSource` 组合显示） | `takedown_task.order_item_id` |
| `ticket` | `TicketBrief` | 是 | 工单与负责人（“发布专员 · 交付经理”） | `takedown_task.delivery_ticket_id` |
| `launchTaskId` | string(uuid) | 是 | 对应上线任务 | `takedown_task.launch_task_id` |
| `merchantConfirmedByName` | string \| null | 是 | 确认下架的商家用户 | `takedown_task.merchant_confirmed_by_user_id` → `entity_member.display_name` |
| `expectedChecklistCode` | enum(`takedown.check`,`takedown.absence_check`) | 是 | 核查应使用的清单：`basis = live` 为 `takedown.check`，否则 `takedown.absence_check` | 按 `basis` 计算（11-publish.md:655） |
| `checklistCode` | string \| null | 是 | 已核查时的清单编码 | `takedown_task.checklist_code` |
| `checklistVersionNo` | integer \| null | 是 | 已核查时的清单版本 | `takedown_task.checklist_version_no` |
| `results` | array<`AdminChecklistItemView`> | 是 | 核查清单结论 | `takedown_task.results` |
| `evidenceFileIds` | array<string(uuid)> | 是 | 证据截图（主页、合集页） | `takedown_task.evidence_file_ids` |
| `checkedBy` | `StaffBrief` \| null | 是 | 核查人；按抽查放行为空 | `takedown_task.checked_by_staff_id` |
| `isBreachNoticedToday` | boolean | 是 | 今天已发违约提醒 | `manual_reminder_log`（`subject_type = takedown_task`、`scene = breach`、`biz_date` = 今天） |
| `timeline` | array<`TakedownEventView`> | 是 | 处理记录 | 见 `TakedownEventView` |

## 3. 接口

### 3.1 admin.channelAccount.list　渠道账号列表

`GET /admin/channel-accounts`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish` 或 `merchant`（`v`）；数据范围：门店 |
| 回显 | 无 |
| 幂等 | none（纯查询，A18） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:MerchantDetail（“渠道账号（2）”页签，proto-admin-b.md:76） |
| 出处 | 路线图 `a06.channel-accounts.list`；proto-admin-b.md:76、396 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `storeId` | string(uuid) | 否 | — | 商家详情页签传当前门店 |
| 查询 | `status` | enum，逗号分隔多值 | 否 | `pending_verify`、`available`、`abnormal`、`unbound` | 缺省返回未解绑的三种 |
| 查询 | `platform` | enum | 否 | `douyin`、`wechat_channels` | — |
| 查询 | `q` | string | 否 | 1–64 字符 | 账号名称包含，或账号 ID 前缀（按 `channel_account.account_uid_norm`） |
| 查询 | `page`、`pageSize` | integer | 否 | C43 | — |

请求体：无。

**响应**：`AdminPage<ChannelAccountRow>`。排序：异常、待核验、可用、已解绑；同状态按绑定时间升序。

**错误**：无（只有通用错误）。

**副作用**：无。

**说明**：页签角标由 `admin.channelAccount.summary` 给（A23）。

### 3.2 admin.channelAccount.summary　渠道账号计数

`GET /admin/channel-accounts/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish` 或 `merchant`；数据范围：门店 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:MerchantDetail（页签角标“渠道账号（2）”） |
| 出处 | 路线图 `a06.channel-accounts.summary`；A23；C83 |

**请求**：查询参数与 3.1 相同（除 `status`、分页外）：`storeId`、`platform`、`q`。

**响应**（`ChannelAccountSummary`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `total` | integer | 是 | 未解绑账号数（页签角标） | `channel_account.status` ≠ `unbound` 计数（`ix_channel_account_store_id_status`） |
| `pendingVerify` | integer | 是 | 待核验 | `status = pending_verify` |
| `available` | integer | 是 | 可用 | `status = available` |
| `abnormal` | integer | 是 | 异常 | `status = abnormal` |
| `unbound` | integer | 是 | 已解绑 | `status = unbound` |

**错误**：无。**副作用**：无。

### 3.3 admin.channelAccount.get　渠道账号详情

`GET /admin/channel-accounts/{channelAccountId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish` 或 `merchant`（`v`，与 3.1 一致，商家详情的服务经理、客服可展开账号行）；数据范围：门店（持有 `publish.account.verify` 的不受限，1.1） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Accounts（核验记录）；A:MerchantDetail（账号行展开） |
| 出处 | 路线图 `a06.channel-accounts.get`；proto-admin-a.md:388 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `channelAccountId` | string(uuid) | 是 | — | 渠道账号 |

**响应**：`ChannelAccountDetail`。

**错误**：无。**副作用**：无。

**说明**：截图只在核验详情（3.5）里签发；这里给各轮的截图张数。

### 3.4 admin.channelAccount.markAbnormal　把可用账号标记为异常

`POST /admin/channel-accounts/{channelAccountId}/mark-abnormal`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.account.mark_abnormal`（发布专员，d4-identity.md:1190）；数据范围：门店 |
| 回显 | 无 |
| 幂等 | required（状态迁移，A17） |
| 乐观锁 | 不带：迁移守卫没有列锁版本（11-publish.md:133；C53） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:MerchantDetail、A:Patrol（巡检发现确属账号问题时，d3-flow.md:1909）；原型未画入口 |
| 出处 | 路线图 `a06.channel-accounts.mark-abnormal`；11-publish.md:133；d3-flow.md:2041 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `channelAccountId` | string(uuid) | 是 | — | 渠道账号 |

请求体（`ChannelAccountMarkAbnormalBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `reasonCode` | string | 是 | 字典 `reject_reason` 场景 `account_verify` 的启用编码 | 落 `channel_account.abnormal_reason_code` |
| `note` | string | 是 | 1–200 字 | 说明与处理指引，落 `channel_account.abnormal_note` |

**响应**：`ChannelAccountDetail`（`status = abnormal`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 账号不是 `available` |
| `DICT_ITEM_DISABLED` | 409 | 原因编码不在字典里或已停用（m08 定义，`details = { dictTypeKey: 'reject_reason', code }`） |
| `VALIDATION_FAILED` | 400 | 原因编码不属 `account_verify` 场景；说明为空或超长 |

**副作用**（同一事务，锁渠道账号一行）：
- `channel_account.status`：`available` → `abnormal`（`account.mark_abnormal`，11-publish.md:133）；写 `abnormal_source = manual`、`abnormal_reason_code`、`abnormal_note`；`status_transition`（`reason_code`、`note` 同写）与活动流审计。
- 出站事件 `account.abnormal`（通知商家）。

**说明**：新订购与新方案不能再选该账号；在办订单不受影响，推送成片包时由 a05 要求发布专员确认知情（d3-flow.md:1642 第 4 项）。商家补正后经 m05 `m.channelAccount.submit` 重新提交核验。

### 3.5 admin.channelAccountSubmission.get　账号核验详情

`GET /admin/channel-account-submissions/{channelAccountSubmissionId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish`；持有 `publish.account.verify` 的不受数据范围限制（角色队列，口径同 a01 2.10，见 1.1），其余按门店 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Accounts（详情区：标题、主页截图、比对表、核验记录、规则提示） |
| 出处 | 路线图 `a06.channel-account-submissions.get`；11-publish.md:158-205；proto-admin-a.md:375-411；A14、A16 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `channelAccountSubmissionId` | string(uuid) | 是 | — | 核验提交行（队列项经 `admin.approval.list` 的 `domain.id` 得到） |

**响应**：`ChannelAccountSubmissionDetail`。

**错误**：无。**副作用**：无。

**说明**：
- 队列（“待核验 N / 今日已处理 N”）与卡片走 a01 `admin.approval.list?kind=channel_account&tab=`、`admin.approval.summary`；卡片上的“发布专员”在决定前不显示、决定后显示审批人，即取 `ApprovalItem.decidedBy`（a01 2.10；11-publish.md 第 6 节第 1 项的默认做法；本文第 6 节第 9 项）。链接核验的队列同走 `admin.approval.list?kind=launch_link`：处理人取 `ApprovalItem.handler`（所属工单当前的发布专员），工单 id 取 `deliveryTicketId`（a01-system.md:330、336、1817）。
- 比对表的“商家填报”在待审时实时取主体名称，决定时冻结进 `compare_result`（11-publish.md:202）。
- 标题区“用途说明”按 `account.usage` 与 `account.activeDramas` 显示（含约定上线日，“《二次开业》可按约定于 10-12 上线”）；原型示例里的“付款单 … 待确认收款”没有数据来源，见第 6 节第 3 项。

### 3.6 admin.channelAccountSubmission.approve　账号核验通过

`POST /admin/channel-account-submissions/{channelAccountSubmissionId}/approve`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.account.verify`；角色队列，不套数据范围、不校验任务归属（1.1）；守卫顺序见 1.1 |
| 回显 | 要求 `confirm`：`{ roundNo, accountUid }`（C54） |
| 幂等 | required（状态迁移，A17）；结果脱敏（C50、A80）：`x-redact-on-replay` = `screenshots[].url`、`screenshots[].expiresAt` |
| 乐观锁 | 带审批单的 `lockVersion`（03-staff-authz-audit.md:805 的守卫；C53） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Accounts（“核验通过”；存在不一致项时按钮禁用） |
| 出处 | 路线图 `a06.channel-account-submissions.approve`（原 `a01.approvals.approve` 的 `kind = channel_account`，A14）；11-publish.md:130；03-staff-authz-audit.md:805；proto-admin-a.md:397 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `channelAccountSubmissionId` | string(uuid) | 是 | — | 核验提交行 |

请求体（`ChannelAccountApproveBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `lockVersion` | integer | 是 | — | 审批单的锁版本（详情的 `approval.lockVersion`） |
| `confirm` | object | 是 | `{ roundNo, accountUid }` 与库中一致 | 二次确认回显 |
| `confirmChecks` | array<string> | 否 | ≤ 10 项 | 界面勾选的核对项，落 `approval_request.confirm_checks` |
| `accountType` | enum | 是 | `enterprise`、`personal`、`none` | 发布专员按截图核定的类型，落 `channel_account.account_type`（M72） |
| `certSubjectName` | string \| null | `accountType = enterprise` 时必填，否则须为空 | 1–100 字；企业认证时须与营业执照主体（`entity.name`）一致 | 落 `channel_account.cert_subject_name` |
| `compareRows` | array<object> | 是 | 恰好 5 项，`field` 各出现一次（见 4.1 `CompareField`）；每项 `{ field, recognized, match }`，`recognized` 为 string（≤ 100 字）或 null；全部 `match = true` | 截图识别值与比对结论（V1.0 由发布专员手填）；个人认证、未认证账号的“认证主体”一项 `recognized` 填空、`match` 填 `true`（不比对，11-publish.md:109） |
| `checklistVersionNo`、`results` | `ChecklistResultInput` | 否 | 清单 `account.verify` 有启用版本时必填，且全部通过 | 落 `approval_request.checklist_code`（`account.verify`）、`checklist_version_no`、`checklist_result` |

**响应**：`ChannelAccountDecisionResult`（`approval.status = approved`，账号 `status = available`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `APPROVAL_NOT_PENDING` | 409 | 审批单已决定或已撤回（如商家已解绑）（a03 定义） |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符 |
| `CONFIRM_MISMATCH` | 409 | 回显的轮次或账号 ID 与库中不一致 |
| `STATE_NOT_ALLOWED` | 409 | 账号不是 `pending_verify` |
| `ACCOUNT_COMPARE_MISMATCH` | 409 | 比对表有不一致项，或企业认证的认证主体与营业执照主体不一致（`details.fields`） |
| `CHECKLIST_NOT_PASSED` | 400 | 带了清单但未全部通过（a01 定义） |
| `CHECKLIST_VERSION_STALE` | 409 | 清单版本不是当前启用版本（a01 定义） |
| `VALIDATION_FAILED` | 400 | 比对项缺失或重复、认证主体与类型不配 |

**副作用**（同一事务，锁序：审批单 → 渠道账号）：
- `approval_request.status`：`pending` → `approved`（`approve`，03-staff-authz-audit.md:805）；写 `decided_by_staff_id`、`decided_at`、`confirm_checks`、清单三列，`lock_version + 1`；取消 `sla.breach:approval_request:{id}:decision`。
- `channel_account_submission.compare_result` 写入（`filled` 由服务端按 11-publish.md:202 取值并冻结）。
- 处理器 `onApproved`：`channel_account.status`：`pending_verify` → `available`（`account.verify_pass`，11-publish.md:130）；写 `account_type`、`cert_subject_name`、`verified_at`、`verified_by_staff_id`。
- 两条 `status_transition` 与审计；出站事件 `approval.approved`、`account.verified`（站内“渠道账号核验结果”）。

**说明**：发起人是商家，`ck_approval_request_decider_not_requester` 不会触发。路线图写的“清单结论”在原型里是比对表，本文以比对表为必填、清单为“有启用版本时必填”（第 6 节第 1 项）；请求体的 `accountType`、`certSubjectName`、`compareRows` 已同步进路线图。

### 3.7 admin.channelAccountSubmission.reject　账号核验驳回（标记异常）

`POST /admin/channel-account-submissions/{channelAccountSubmissionId}/reject`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.account.verify`；角色队列，不套数据范围（1.1）；守卫顺序见 1.1 |
| 回显 | 无（驳回不要求二次确认回显，03-staff-authz-audit.md:806） |
| 幂等 | required（状态迁移，A17）；结果脱敏（C50、A80）：`x-redact-on-replay` = `screenshots[].url`、`screenshots[].expiresAt` |
| 乐观锁 | 不带：驳回的守卫没有列锁版本（03-staff-authz-audit.md:806；A21） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Accounts（“标记异常”弹窗：异常原因单选、说明必填；系统按不一致项预填原因与说明） |
| 出处 | 路线图 `a06.channel-account-submissions.reject`（原 `a01.approvals.reject`，A14）；11-publish.md:131；03-staff-authz-audit.md:806；proto-admin-a.md:398 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `channelAccountSubmissionId` | string(uuid) | 是 | — | 核验提交行 |

请求体（`ChannelAccountRejectBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `reasonCode` | string | 是 | 字典 `reject_reason` 场景 `account_verify` 的启用编码 | 落 `approval_request.reason_codes`（单元素数组）与 `channel_account.abnormal_reason_code` |
| `note` | string | 是 | 1–200 字 | 落 `approval_request.decision_note` 与 `channel_account.abnormal_note` |
| `compareRows` | array<object> | 是 | 同 3.6，`match` 可为 `false` | 驳回同样冻结比对结果（`publish.I4`） |

**响应**：`ChannelAccountDecisionResult`（`approval.status = rejected`，账号 `status = abnormal`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `APPROVAL_NOT_PENDING` | 409 | 审批单已决定或已撤回 |
| `STATE_NOT_ALLOWED` | 409 | 账号不是 `pending_verify` |
| `DICT_ITEM_DISABLED` | 409 | 原因编码不在字典里或已停用（m08 定义） |
| `VALIDATION_FAILED` | 400 | 原因编码不属 `account_verify` 场景；比对项缺失或重复 |

**副作用**（同一事务，锁序：审批单 → 渠道账号）：
- `approval_request.status`：`pending` → `rejected`（`reject`，03-staff-authz-audit.md:806）；写原因、说明、审批人与时间；取消决定时限定时器。
- `channel_account_submission.compare_result` 写入。
- 处理器 `onRejected`：`channel_account.status`：`pending_verify` → `abnormal`（`account.verify_reject`，11-publish.md:131）；写 `abnormal_source = verify` 与异常三列。
- 状态历史与审计；出站事件 `approval.rejected`、`account.abnormal`（订阅消息通知商家）。

**说明**：原型是单选、`channel_account.abnormal_reason_code` 是单值，请求体用 `reasonCode` 单值，审批单上存一元素数组（`ck_approval_request_reject_reasons` 要求至少 1 项）；读接口按 a01 统一返回 `reasons[{ code, name }]`。路线图的请求体已同步为 `{ reasonCode, note, compareRows }`。商家补正后重新提交，生成新一轮与新审批单（m05）。

### 3.8 admin.deliveryTicket.publishList.get　发布清单

`GET /admin/delivery-tickets/{deliveryTicketId}/publish-list`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish`；数据范围：任务（工单） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无（返回 `lockVersion`） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Delivery（发布清单区：合集名称、封面、标题模板与预览、话题、简介）；A:TicketDetail（“成片与发布”） |
| 出处 | 路线图 `a06.publish-lists.get`；10-delivery.md:1121-1171；d3-flow.md:1631-1635；proto-admin-a.md:267 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | — | 交付工单（发布清单是工单下的单例子资源，A5 第三类） |

**响应**：`PublishListAdminView`。

**错误**：无（工单尚未进入成片交付、还没有发布清单时 404 `NOT_FOUND`）。

**副作用**：无。

**说明**：交付前检查的条目由页面经 a01 `admin.checklistTemplate.list?code=delivery.precheck` 取，勾选结果随 a05 `admin.deliveryTicket.pushPackage` 提交。成片包格子（推送前）由 a05 `admin.deliveryTicket.episodeOutput.list` 提供，推送后看 3.11。

### 3.9 admin.deliveryTicket.publishList.replace　保存发布清单

`PUT /admin/delivery-tickets/{deliveryTicketId}/publish-list`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.list.edit`（发布专员、交付经理）；数据范围：任务 |
| 回显 | 无 |
| 幂等 | required（带 `lockVersion` 的整体替换，A17）；结果脱敏（C50、A80）：`x-redact-on-replay` = `cover.url`、`cover.expiresAt` |
| 乐观锁 | 带 `lockVersion`（`publish_list.lock_version`，A21） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Delivery（“保存清单”，toast“发布清单已保存”） |
| 出处 | 路线图 `a06.publish-lists.replace`；d3-flow.md:1633-1635；10-delivery.md:1157-1159、886；proto-admin-a.md:276-277 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | — | 交付工单 |

请求体（`PublishListReplaceBody`）：清单在推送前允许不完整，各文本字段可为空。

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `lockVersion` | integer | 是 | — | 详情返回的 `lockVersion` |
| `collectionName` | string \| null | 是 | ≤ 60 字（本稿补充，契约层） | 落 `publish_list.collection_name` |
| `coverFileId` | string(uuid) \| null | 是 | 已入库、分类 `poster` 的图片 | 落 `publish_list.cover_file_id`；默认取剧目竖版海报 |
| `titleTemplate` | string \| null | 是 | ≤ 100 字；只允许占位符 `{剧名}`、`{集数}`、`{看点}` | 落 `publish_list.title_template` |
| `topics` | array<string> | 是 | 0–10 个，每个 1–20 字，去掉开头的“#”后不重复 | 落 `publish_list.topics` |
| `intro` | string \| null | 是 | ≤ 200 字 | 落 `publish_list.intro` |
| `episodes` | array<object> | 是 | `[{ episodeNo, highlight, title, topics, intro }]`；集号 1..整部集数、不重复；`highlight` ≤ 30 字、`title` ≤ 100 字、`topics` 同上、`intro` ≤ 200 字，各项可为空 | 逐集覆盖内容，落 `publish_list_episode` 的同名列；未列出的集号其覆盖内容清空（行保留） |

**响应**：`PublishListSaveResult`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符（`details.lockVersion` 为最新值） |
| `PUBLISH_LIST_LOCKED` | 409 | 已有上线任务提交过回填，清单已锁定 |
| `TICKET_ON_HOLD` | 409 | 工单暂停中（m05 定义） |
| `STATE_NOT_ALLOWED` | 409 | 工单不在成片交付或待上线 |
| `FILE_NOT_USABLE` | 400 | 封面文件未入库或分类不符（m03 定义） |
| `VALIDATION_FAILED` | 400 | 字数、话题数、占位符、集号越界或重复 |

**副作用**（同一事务；`publish_list` 不参与锁排序，靠 `lock_version` 乐观锁，10-delivery.md:1123）：
- 更新 `publish_list`：各内容列、`saved_by_staff_id`、`saved_at`，`lock_version + 1`；按集号写 `publish_list_episode`（没有的行插入，未列出的集号把四个覆盖列置空），`changed_in_release_no` 不动。
- 封面变了：新封面 `files.link()`（`publish_list` / `cover`），旧封面引用释放（保留 30 天，06-media.md 3.2）。
- 已推送过成片包（有 `state = pushed` 的 `delivery_release`）时：重新渲染清单文本写回该包的 `delivery_release.publish_list_text`，并调 media 作废其 ZIP 缓存（`zip_bundle`：任意状态 → `none`，`zip_gen + 1`，06-media.md:975；10-delivery.md:886）。
- 审计；出站事件 `publish_list.updated`（`isAfterPush` 为真时通知商家“发布清单已更新”）。

**说明**：
- 可编辑的条件（d3-flow.md:1635）：工单在 `delivering` 或 `awaiting_launch`、未暂停，且 `delivery_ticket.links_submitted_at` 为空（首个上线任务提交回填后锁定）。不满足时详情的 `isEditable = false` 并给出 `lockReason`。
- 推送守卫只看完整度，保存不要求完整；完整度在详情的 `completeness` 里实时给出。

### 3.10 admin.deliveryTicket.publishList.import　表格导入逐集内容

`POST /admin/delivery-tickets/{deliveryTicketId}/publish-list/import`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.list.edit`；数据范围：任务 |
| 回显 | 无 |
| 幂等 | required（A17）；结果脱敏（C50、A80）：`x-redact-on-replay` = `publishList.cover.url`、`publishList.cover.expiresAt` |
| 乐观锁 | 带 `lockVersion`（`publish_list.lock_version`） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Delivery（“共 N 集，可导入表格逐集编辑”） |
| 出处 | 路线图 `a06.publish-lists.import-episodes`（草案 `…/list/episodes:import`）；d3-flow.md:1633；proto-admin-a.md:278；d7-platform.md:1153 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryTicketId` | string(uuid) | 是 | — | 交付工单 |

请求体（`PublishListImportBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `lockVersion` | integer | 是 | — | 详情返回的 `lockVersion` |
| `format` | enum | 是 | `csv`、`tsv` | 端上读取 .csv 文件，或从表格软件复制粘贴（制表符分隔） |
| `content` | string | 是 | UTF-8，≤ 200 KB；首行为表头；数据行 1..整部集数 | 表头取“集号”（必有）与“看点”“标题”“话题”“简介”中的至少一列；话题用空格或“#”分隔 |

导入语义：只写表头里出现的列；单元格为空表示清空该集该项的覆盖内容（回落到清单头与模板）；表里没有的集号不动。**整批校验、全部通过才写入**（d3-flow.md:1633“先校验后提交，行级报错”）。

**响应**（`PublishListImportResult`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `publishList` | `PublishListAdminView` | 是 | 导入后的清单（`cover.url`、`cover.expiresAt` 可空，1.1“结果脱敏”） | 同 3.8 |
| `importedRowCount` | integer | 是 | 导入的数据行数 | 计算 |
| `updatedEpisodeNos` | array<integer> | 是 | 内容有变化的集号 | 计算 |
| `replayed` | boolean | 是 | 同键重放为 `true`（C50） | 幂等层 |

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `PUBLISH_LIST_IMPORT_INVALID` | 400 | 表头不认识、缺“集号”列，或有行级错误（集号越界或重复、超长）；`details.rows` 逐行列出，什么都不写 |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符 |
| `PUBLISH_LIST_LOCKED` | 409 | 清单已锁定 |
| `TICKET_ON_HOLD` | 409 | 工单暂停中 |
| `STATE_NOT_ALLOWED` | 409 | 工单不在成片交付或待上线 |

**副作用**：同 3.9（写 `publish_list_episode`、保存人与时间、`lock_version + 1`；推送后修订时回写成片包文本并作废 ZIP；出站事件 `publish_list.updated`）。

**说明**：d7-platform.md:1153 把 Excel 解析库的选型放到 V1.1，前端不引入 Excel 库；V1.0 只收 CSV / TSV 文本，.xlsx 上传见第 6 节第 2 项。

### 3.11 admin.deliveryRelease.get　成片包详情

`GET /admin/delivery-releases/{deliveryReleaseId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish`；数据范围：任务 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Delivery（推送后的成片包：集数、大小、文件命名、下载链接有效期）；A:TicketDetail（“成片包”） |
| 出处 | 路线图 `a06.delivery-releases.get`；10-delivery.md:815-918；06-media.md:922-983；d5-media.md:2115 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryReleaseId` | string(uuid) | 是 | — | 成片包（工单详情与 a05 `admin.orderItem.download.list` 给出 id） |

**响应**：`DeliveryReleaseDetail`。

**错误**：无。**副作用**：无（不签发地址，不写下载记录）。

**说明**：
- 员工下载单集经 a01 `admin.file.downloadUrls`（权限点 `delivery.download`，30 分钟，C61），按文件留痕；商家侧的下载记录看 a05 `admin.orderItem.download.list`。
- 不返回 ZIP 缓存状态（见 `DeliveryReleaseDetail` 末段）；要看或推进打包状态调 3.12。

### 3.12 admin.deliveryRelease.pack　预打包 ZIP

`POST /admin/delivery-releases/{deliveryReleaseId}/pack`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.package.push`（发布专员、交付经理）；数据范围：任务 |
| 回显 | 无 |
| 幂等 | required（A17）；同键重放返回当时的结果。要看最新打包状态，用新的幂等键再调一次：`building` 时不新建任务，`ready` 时只顺延保留期 |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Delivery（推送后“预打包”，供电脑端下载页整包下载） |
| 出处 | 路线图 `a06.delivery-releases.pack`（草案 `POST /admin/releases/{id}/zip`）；06-media.md:962-970；10-delivery.md:888；d5-media.md:1667-1683 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryReleaseId` | string(uuid) | 是 | — | 成片包 |

请求体：无（空对象）。

**响应**：`DeliveryReleasePackResult`（`zipState` 一般为 `building`；已就绪的为 `ready`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 成片包不是 `pushed`（已被取代或已关闭） |
| `DOWNLOAD_GRANT_INVALID` | 409 | 本包对主体没有有效的下载授权（`details.reason`；m05 定义），打包无意义 |

**副作用**（同一事务；`zip_bundle` 行由 media 在 `ensureZip` 内锁，`lock_rank = 390`）：
- delivery 调 `media.ensureZip`，**带重建选项 `retry: true`**（A99；与 p01 下载请求的 `retry` 同名同义）——后台“预打包”是明确的人工意图，失败的包总是重打。另传打包任务需要的全部字段（清单 `items`、归属、`ownerType = delivery_release`、`ownerId`、`publishListText`、`publishListKey`、`keepUntil` = 有效授权最晚的 `download_grant.expires_at` + 1 天、`zipFileName`，10-delivery.md:888）。
- `zip_bundle.zip_state`：无行 → `building`（`zip_gen = 1`）；`none` → `building`、`failed` → `building`（带重建选项，`zip_gen + 1`），建 `media_job`（`kind = zip_package`，`dedupe_key = zip:{zipBundleId}:{zipGen}`）；`building` 不变（返回“打包中”）；`ready` 且文件仍在 → 不变，顺延两条引用的 `keep_until`；`ready` 但文件已不在 → `building`（06-media.md:962-970）。
- 审计。打包成功后由 worker 发 `media.release.zip_ready`（不在本事务）。

**说明**：打包失败不阻塞交付，逐集下载始终可用（d5-media.md:1679）。a05 `admin.deliveryTicket.pushPackage` 推送时同事务预打包，调的也是同一个 `media.ensureZip`（不带 `retry`，a05-order-delivery.md:2319；06-media.md:962“或推送时预打包”），本接口是推送后的人工补打。下载页的“打包下载”调的是同一个 `ensureZip`，只有下载请求带 `retry: true` 时才重打失败的包（A99，p01）。`ensureZip` 的重建选项需由 06 分组回写数据模型（06-media.md:962 的 `failed` 行加“带重建选项”的守卫）。

### 3.13 admin.launchCalendar.get　上线日历

`GET /admin/launch-calendar`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish`；数据范围：任务（工单） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Calendar（月历、统计行、当日面板）；A:Main（“近 7 日上线安排”，`from`/`to` 取 7 天、`limit=5`） |
| 出处 | 路线图 `a06.launch-calendar.get`；proto-admin-a.md:295-333、76；d3-flow.md:3530 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `month` | string | 与 `from`/`to` 二选一 | `YYYY-MM` | 自然月 |
| 查询 | `from`、`to` | string(date) | 与 `month` 二选一 | `from` ≤ `to`，跨度 ≤ 42 天 | 月历 35 格含相邻月份日期时用它 |
| 查询 | `managerId` | string(uuid) | 否 | — | 按交付经理筛选（`delivery_ticket.delivery_manager_id`） |
| 查询 | `limit` | integer | 否 | 1–50 | 按日期截取前 N 项（工作台用） |

**响应**：`LaunchCalendar`。

归类规则（`calendarStatus`，按顺序取第一个命中的）：
1. `overdue`：订单项有逾期的上线任务（判定见 3.14）。
2. `verifying`：工单在 `launch_verify`。
3. `to_launch`：工单在 `awaiting_launch`。
4. `producing`：工单在 `assigning` 至 `delivering` 之间。

纳入范围：事项的日期（`LaunchCalendarItem.agreedLaunchDate`）落在查询区间内，且工单在步骤 1～9（`assigning` 至 `launch_verify`），或订单项有逾期的上线任务（如双平台一个已上线、另一个被退回仍逾期，d3-flow.md:1812）。事项的日期取 `order_item.agreed_launch_date`（方案确认时写入，09-order-ad.md:275）；还没确认的（工单在 `plan_confirm` 等步骤）取已推送方案当前版本里该订单项的 `agreedLaunchDate`，并标 `isDateTentative = true`（原型 10-14～10-16 的“方案确认”项）；方案还没推送（`delivery_plan.current_version_no = 0`，多为 `assigning`）的没有日期，不纳入。

**错误**：`VALIDATION_FAILED`（区间缺失、跨度超限）。**副作用**：无。

**说明**：
- 原型展示全部交付中的工单（四类），PRD 写“按日展示待上线订单”，本文按原型（proto-admin-a.md:327；第 6 节第 4 项）。
- 日历页的“逾期未上线”面板用 `admin.launchTask.list?tab=overdue`；“提醒商家（上线）”按 `items[].actions` 的 `remind` 显示，调 a05 `admin.deliveryTicket.remind`（`scene = golive`）；“去核验”取 `items[].tasks[]` 中 `reviewStatus = verifying` 的 `currentSubmissionId` 跳 3.16。
- a02 工作台“近 7 日上线安排”用 `from` = 今天、`to` = 今天 + 6、`limit = 5`，`isTruncated` 给“另有 N 项”。

### 3.14 admin.launchTask.list　上线任务查询（逾期跟踪）

`GET /admin/launch-tasks`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish`；数据范围：任务 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Overdue（逾期卡片、7 日内待上线表）；A:Calendar（逾期未上线面板）；A:TicketDetail（“上线任务、上线核验”区与撤销入口，`tab=all&deliveryTicketId=`） |
| 出处 | 路线图 `a06.launch-tasks.list`；11-publish.md:313；d3-flow.md:1812-1833、3530；proto-admin-a.md:415-450；A24 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum | 否 | `overdue`、`upcoming`、`all`；缺省 `overdue` | 页签（A24，原 `view=`）；`all` 供工单详情按工单查上线任务 |
| 查询 | `days` | integer | 否 | 1–30，默认 7 | `upcoming` 的窗口天数 |
| 查询 | `managerId` | string(uuid) | 否 | — | 按交付经理 |
| 查询 | `deliveryTicketId` | string(uuid) | 否 | — | 按交付工单（工单详情） |
| 查询 | `orderItemId` | string(uuid) | 否 | — | 按订单项 |
| 查询 | `readyOnly` | boolean | 否 | 默认 `false` | 仅看成片已交付（`upcoming` 用） |
| 查询 | `q` | string | 否 | 1–64 字符 | 门店名、剧名、订购单号、工单号 |
| 查询 | `page`、`pageSize` | integer | 否 | C43 | — |

页签口径：
- `overdue`（逾期未上线，判定在上线任务粒度，d3-flow.md:1814）：任务未作废、`is_live = false`、`review_status` ∈ {`pending`,`need_fix`}；订单项 `agreed_launch_date` < 今天、阶段为 `to_launch` 或 `live`、今天未过 `usage_end_date`；工单未暂停。有任一这样的任务的订单项进入列表，`tasks[].isOverdue` 标出是哪个账号。起算日 = `max(约定上线日次日, 成片交付次日)`，`overdue.days` = 今天 − 起算日 + 1；成片交付晚于约定上线日的 `overdue.reason = late_delivery`（不算商家逾期，单独标注），否则 `merchant`。
- `upcoming`（7 日内待上线）：`agreed_launch_date` 在今天至今天 + `days` − 1 之间；阶段为 `producing` 或 `to_launch`；没有已上线的任务。`readyOnly = true` 时只要成片已交付的。
- `all`：有未作废上线任务的订单项（即成片包已推送），不限日期与阶段，供工单详情列出上线任务与回填行 id（`tasks[].currentSubmissionId`、`latestPassedSubmissionId`）。

**逾期口径只实现一处**：`overdue` 的判定（含起算日、`late_delivery` 的区分）实现为发布模块的只读端口 `publish.listOverdueLaunchItems`（11-publish.md:673，返回 `{ orderItemId, agreedLaunchDate, overdueStartDate, overdueDays, reason }`）与同口径的计数函数；本接口 `tab=overdue`、3.15 的 `overdue`、a02 工作台预警 `launch_overdue`（a02 的 `overdueDays` 即本端口的 `overdueDays`）、上线日历的 `overdue` 归类四处共用。

**响应**：`AdminPage<LaunchTrackItem>`。排序：`overdue` 按逾期天数倒序；`upcoming` 按约定上线日升序；`all` 按约定上线日升序。

**错误**：无。**副作用**：无。

**说明**：
- “记录跟进”调 a03 `admin.followUp.create`（`subjectType = order_item`）；“提醒商家上线”按 `actions` 的 `remind` 显示，调 a05 `admin.deliveryTicket.remind`（`scene = golive`，当日限一次；条件与 a05 的场景守卫一致，见 `LaunchTrackItem.actions`）。
- 逾期是派生判定，不落库（11-publish.md:313）。

### 3.15 admin.launchTask.summary　逾期跟踪指标卡

`GET /admin/launch-tasks/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish`；数据范围：任务 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Overdue（4 张指标卡） |
| 出处 | 路线图 `a06.launch-tasks.summary`；11-publish.md:313；proto-admin-a.md:424 |

**请求**：查询参数与 3.14 相同（除 `tab`、分页外，C83）：`days`、`managerId`、`deliveryTicketId`、`orderItemId`、`readyOnly`、`q`；各计数都按这些筛选算。`readyOnly = true` 时 `deliveringSoon` 为 0（与列表口径一致）；`overdue` 的订单项必已推送成片包，不受 `readyOnly` 影响；`last30Days` 只按 `managerId`、`deliveryTicketId`、`orderItemId`、`q` 筛选。

**响应**（`LaunchTrackSummary`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `overdue` | integer | 是 | 逾期未上线（单 = 订单项） | `publish.listOverdueLaunchItems` 的计数函数（3.14） |
| `upcoming` | integer | 是 | 7 日内待上线：成片已交付、等待商家按约定日发布（原型“5 单”） | 3.14 `upcoming` 口径，且 `delivery_ticket.delivered_at` 非空（等同 `readyOnly = true`） |
| `deliveringSoon` | integer | 是 | 7 日内成片交付中：约定上线日在窗口内、成片尚未交付（原型“2 单”） | 3.14 `upcoming` 口径，且 `delivery_ticket.delivered_at` 为空；与 `upcoming` 不重叠，两者之和等于 `readyOnly = false` 时 `tab=upcoming` 的总数 |
| `all` | integer | 是 | 有未作废上线任务的订单项（`tab=all`） | 3.14 `all` 口径 |
| `last30Days` | object | 是 | 近 30 天逾期 `{ overdueItemCount, avgOverdueDays, liveItemCount }`；`avgOverdueDays` 保留 1 位小数 | 按 11-publish.md:313 的派生口径：各上线任务 `review_status` ∈ {`pending`,`need_fix`} 且未上线的区间取自 `status_transition`（`machine = launch_task`），与“起算日至今”求交；约定上线日按改期审计还原改期前的值：取 a05 `admin.orderItem.rescheduleLaunch` 写的审计行（`stream = activity`、`category = delivery`、`action = delivery.order_item.reschedule_launch`、`target_type = order_item`，`before` / `after` 记 `agreedLaunchDate`，`meta = { orderItemId, deliveryTicketId, prevDate, newDate }`；a05-order-delivery.md:2484），某一时刻的约定上线日 = 该时刻之后最早一条改期行的 `meta.prevDate`，没有改期行则取当前 `order_item.agreed_launch_date`；按订单项取各任务最大值求平均；“已上线”看当前是否有 `is_live` 的任务 |

**错误**：无。**副作用**：无。

### 3.16 admin.launchSubmission.get　链接核验详情

`GET /admin/launch-submissions/{launchSubmissionId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish`；数据范围：任务（审批单的 `delivery_ticket_id`） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无（返回审批单的 `lockVersion`） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Verify（标题、回填链接、核验清单、通过后影响、结果）；A:TicketDetail（“上线核验”） |
| 出处 | 路线图 `a06.launch-submissions.get`；11-publish.md:340-434；proto-admin-a.md:334-374；A14、A16 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `launchSubmissionId` | string(uuid) | 是 | — | 回填行（队列项经 `admin.approval.list?kind=launch_link` 的 `domain.id` 得到；工单详情与日历经 3.14、3.13 的 `tasks[].currentSubmissionId`、`latestPassedSubmissionId` 得到） |

**响应**：`LaunchSubmissionDetail`。

**错误**：无。**副作用**：无。

**说明**：
- 原型的一个核验任务覆盖两个账号；本设计一个账号一张核验单（11-publish.md:13），详情用 `otherTasks` 并排显示同剧的其他账号，各自核验。
- 核验清单条目经 a01 `admin.checklistTemplate.list?code=launch.verify` 取（d3-flow.md:1507 的 v1 为 5 项）。
- 链接在后台以新窗口打开（`rel="noopener noreferrer"`，d3-flow.md:1759），复制是端上动作。

### 3.17 admin.launchSubmission.approve　链接核验通过

`POST /admin/launch-submissions/{launchSubmissionId}/approve`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.link.verify`；数据范围：任务；模块等级 `o` 时须为本人任务；守卫顺序见 1.1 |
| 回显 | 要求 `confirm`：`{ roundNo, reportedEpisodeCount }`（C54） |
| 幂等 | required（状态迁移，A17） |
| 乐观锁 | 带审批单的 `lockVersion`（03-staff-authz-audit.md:805；C53） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Verify（5 项全勾才可“核验通过”） |
| 出处 | 路线图 `a06.launch-submissions.approve`（原 `a01.approvals.approve` 的 `kind = launch_link`，A14）；11-publish.md:301、399；03-staff-authz-audit.md:805；10-delivery.md:185；09-order-ad.md:356；d3-flow.md:1779-1792 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `launchSubmissionId` | string(uuid) | 是 | — | 回填行 |

请求体（`LaunchSubmissionApproveBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `lockVersion` | integer | 是 | — | 审批单锁版本 |
| `confirm` | object | 是 | `{ roundNo, reportedEpisodeCount }` 与库中一致 | 二次确认回显 |
| `confirmChecks` | array<string> | 否 | ≤ 10 项 | 落 `approval_request.confirm_checks` |
| `verifiedEpisodeCount` | integer | 是 | 不小于 `max(1, launch_task.verified_episode_count)`，不大于本轮声明集数（`ck_launch_submission_verified` 要求通过的行在 1 与声明集数之间，11-publish.md:389） | 本轮核验通过的集数（累计），落 `launch_submission.verified_episode_count` |
| `checklistVersionNo`、`results` | `ChecklistResultInput` | 是 | 清单 `launch.verify`，全部通过 | 落 `approval_request` 的清单三列 |
| `evidenceFileIds` | array<string(uuid)> | 否 | 0–9 张，分类 `evidence` | 链接核验截图（选填，11-publish.md:363），落 `launch_submission.evidence_file_ids` |

**响应**：`LaunchSubmissionDetail`（`result` 为 `passed` 或 `passed_partial`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `APPROVAL_NOT_PENDING` | 409 | 核验单已决定或已撤回（任务作废、收尾时系统撤回） |
| `APPROVAL_SELF_FORBIDDEN` | 403 | 本轮由本人撤销核验后送审 |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符 |
| `CONFIRM_MISMATCH` | 409 | 回显的轮次或声明集数不符 |
| `TICKET_ON_HOLD` | 409 | 工单暂停中（m05 定义） |
| `STATE_NOT_ALLOWED` | 409 | 工单不在待上线、上线核验或服务中（已进入到期下架或已终止） |
| `LAUNCH_VERIFY_COUNT_OUT_OF_RANGE` | 400 | 核验集数越界（`details.min` = `max(1, 任务已核验集数)`、`details.max` = 本轮声明集数） |
| `CHECKLIST_NOT_PASSED` | 400 | 清单未全部通过（应走退回）（a01 定义） |
| `CHECKLIST_VERSION_STALE` | 409 | 清单版本不是当前启用版本（a01 定义） |
| `FILE_NOT_USABLE` | 400 | 截图不可用 |

**副作用**（同一事务；锁序：审批单 → 订购单 → 订单项 → 工单 → 上线任务 → 下架任务，d3-flow.md:1781；1.1“锁序”）：
- `approval_request.status`：`pending` → `approved`（03-staff-authz-audit.md:805）；写决定人与时间、清单、核对项，`lock_version + 1`；取消决定时限定时器。
- `launch_submission.result`：`pending` → `passed`（核验集数 = 订购集数）或 `passed_partial`（11-publish.md:399）；写核验集数与截图（`files.link()`，`launch_submission` / `evidence`）。
- 处理器 `onApproved`：`launch_task.review_status`：`verifying` → `passed`（`launch.verify_pass`，11-publish.md:301）；写 `verified_episode_count`、`first_launch_date`（取最小值），满集写 `completed_at`；`is_live = is_live OR 满集 OR 参数 launch.partial_goes_live`，首次为真写 `went_live_at`。
- 订单项：`live_episode_count`、`usage_start_date` 按各已上线任务重算。
- 该账号未核查的下架任务按改写后的 `is_live` 重算 `basis`；商家已按“未发布”确认的退回：`takedown_task.status`：`merchant_confirmed` → `pending_merchant`（`takedown.basis_reopen`，11-publish.md:658），清空确认三列与核查时限，按应完成日重设 `takedown.overdue` 或已过期时写 `escalated_at`。
- `reevaluate(工单)`：首次有任务上线时 `delivery_ticket.step`：`awaiting_launch` / `launch_verify` → `in_service`（`launch.changed`，10-delivery.md:185 第 14 行），写 `live_at`；`order_item.phase`：`to_launch` → `live`（09-order-ad.md:356）；订购单状态重新推导。
- 状态历史与审计；出站事件 `approval.approved`、`launch.verified`，按条件 `ticket.step_changed`、`order.item.went_live`（授权书由 `docs.onLicenseFacts` 异步出 `go_live` 版次）、`order.status_changed`、`takedown.basis_reopened`。

**说明**：
- 双平台各账号独立核验；某账号上线后，工单留在服务中（d3-flow.md:1777）。
- 使用期止日不因延迟上线顺延（PRD 2.5），下架提醒由通知中心按止日派生，本接口不登记定时器（11-publish.md:673）。

### 3.18 admin.launchSubmission.reject　链接核验退回补充

`POST /admin/launch-submissions/{launchSubmissionId}/reject`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.link.verify`；数据范围：任务；模块等级 `o` 时须为本人任务；守卫顺序见 1.1 |
| 回显 | 无 |
| 幂等 | required（状态迁移，A17） |
| 乐观锁 | 不带：驳回的守卫没有列锁版本（03-staff-authz-audit.md:806；A21） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Verify（“需补充”弹窗：退回原因多选至少 1 项、补充说明） |
| 出处 | 路线图 `a06.launch-submissions.reject`（原 `a01.approvals.reject`，A14）；11-publish.md:302、400；03-staff-authz-audit.md:806；10-delivery.md:184；proto-admin-a.md:358 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `launchSubmissionId` | string(uuid) | 是 | — | 回填行 |

请求体（`LaunchSubmissionRejectBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `reasonCodes` | array<string> | 是 | 1–6 个，字典 `reject_reason` 场景 `link_verify` 的启用编码，不重复 | 落 `approval_request.reason_codes` |
| `note` | string | 是 | 1–200 字 | 落 `approval_request.decision_note`（驳回必填，`ck_approval_request_decision`） |
| `evidenceFileIds` | array<string(uuid)> | 否 | 0–9 张，分类 `evidence` | 落 `launch_submission.evidence_file_ids` |

**响应**：`LaunchSubmissionDetail`（`result = returned`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `APPROVAL_NOT_PENDING` | 409 | 核验单已决定或已撤回 |
| `APPROVAL_SELF_FORBIDDEN` | 403 | 本轮由本人撤销核验后送审 |
| `DICT_ITEM_DISABLED` | 409 | 原因编码不在字典里或已停用（m08 定义） |
| `VALIDATION_FAILED` | 400 | 原因编码不属 `link_verify` 场景或重复 |
| `FILE_NOT_USABLE` | 400 | 截图不可用 |

**副作用**（同一事务；锁序：审批单 → 工单 → 上线任务）：
- `approval_request.status`：`pending` → `rejected`（03-staff-authz-audit.md:806）；取消决定时限定时器。
- `launch_submission.result`：`pending` → `returned`（11-publish.md:400）。
- 处理器 `onRejected`：`launch_task.review_status`：`verifying` → `need_fix`（`launch.return`，11-publish.md:302）；`is_live` 不变。
- `reevaluate(工单)`：没有已上线、也没有核验中的任务时 `delivery_ticket.step`：`launch_verify` → `awaiting_launch`（`launch.changed`，10-delivery.md:184 第 13 行）。
- 状态历史与审计；出站事件 `approval.rejected`、`launch.returned`（订阅消息与短信通知商家），步骤变化时 `ticket.step_changed`。

**说明**：数据模型的退回守卫不检查工单暂停（11-publish.md:302），暂停中也可退回，所以本接口不返回 `TICKET_ON_HOLD`（对 m05 请求的回复：通过、撤销在暂停时返回它，退回按数据模型放行）。

### 3.19 admin.launchSubmission.revoke　撤销核验通过

`POST /admin/launch-submissions/{launchSubmissionId}/revoke`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.link.verify_revoke`（发布主管或交付主管；不在 d4 注册表，已进增补表，A129）；数据范围：任务 |
| 回显 | 要求 `confirm`：`{ roundNo, verifiedEpisodeCount }`（C54） |
| 幂等 | required（状态迁移，A17） |
| 乐观锁 | 不带：迁移守卫没有列锁版本（11-publish.md:303） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 原型无（A:Verify 已处理结果、A:TicketDetail 的“上线核验”加入口；05-risks-and-open-issues.md:228） |
| 出处 | 路线图 `a06.launch-submissions.revoke`（草案 `…/revoke-verification`）；11-publish.md:303、402-404、411；10-delivery.md:193；09-order-ad.md:357；d3-flow.md:1835-1857 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `launchSubmissionId` | string(uuid) | 是 | — | 要撤销的已通过回填行 |

请求体（`LaunchSubmissionRevokeBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `reason` | string | 是 | 1–200 字 | 撤销原因，写审计 `audit_log.reason_text` 与状态历史 `status_transition.note` |
| `confirm` | object | 是 | `{ roundNo, verifiedEpisodeCount }` 与库中一致 | 二次确认回显 |

**响应**：`LaunchSubmissionDetail`——重开的新一轮（`result = pending`，`reopenOfLaunchSubmissionId` 指向被撤销的行）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 本行不是该任务最近一条已通过的回填；任务不是 `passed`（补充回填核验中）；工单不在服务中 |
| `TICKET_ON_HOLD` | 409 | 工单暂停中（m05 定义，`details.reasons`；与通过一致） |
| `LAUNCH_REVOKE_WINDOW_CLOSED` | 409 | 距核验决定已超过参数 `launch.verify_revoke_window`（默认 1 个工作日），`details.deadlineAt`；更晚的更正走人工纠偏 |
| `LAUNCH_REVOKE_BLOCKED` | 409 | 该订单项已有商家确认或已核查的下架任务（`details.takedownTaskIds`） |
| `CONFIRM_MISMATCH` | 409 | 回显不符 |

**副作用**（同一事务；锁序：订购单 → 订单项 → 工单 → 上线任务 → 巡检 → 下架任务，每层按 id 升序；原审批单只读不改，新审批单与新回填行是插入，不取行锁；1.1“锁序”）：
- 被撤销的 `launch_submission.result`：`passed` / `passed_partial` → `revoked`（11-publish.md:402），原审批单保持 `approved`（03-staff-authz-audit.md:812）。
- 复制链接、声明集数、实际上线日期、提交人三列与 `submitted_at` 新建一行 `launch_submission`（`round_no + 1`、`result = pending`、`reopen_of_launch_submission_id` 指向原行）；为它建核验审批单 `approval_request`：（新建）→ `pending`，`kind = launch_link`、`submit_actor_type = staff`、`submit_client = admin`、`submit_actor_id` = `requester_staff_id` = 撤销人、`delivery_ticket_id` 取工单、`dedupe_key = launch_link:{上线任务 id}`，`due_at` 按 `sla.review.launch_link`，登记 `sla.breach:approval_request:{id}:decision`（11-publish.md:404、411）。
- `launch_task.review_status`：`passed` → `verifying`（`launch.verify_revoke`，11-publish.md:303）；`current_round_no + 1`；已核验集数、上线首日、完成时间按剩余已通过回填重算，没有剩余时 `is_live = false`、清空 `went_live_at`。
- 订单项的已上线集数与使用期起点重算；不再有已上线任务时 `delivery_ticket.step`：`in_service` → `launch_verify`（`launch.verify_revoked`，10-delivery.md:193 第 21 行），清空 `live_at`；`order_item.phase`：`live` → `to_launch`（09-order-ad.md:357）；订购单状态重新推导。
- 该任务名下 `pending`、`abnormal` 的巡检：`patrol_task.status` → `void`（`patrol.void`，11-publish.md:547），取消 `patrol.followup`，关闭系统跟进待办。
- 该账号未核查的下架任务按改写后的 `is_live` 重算 `basis`。
- 审计（带原因）；出站事件 `launch.verify_revoked`、`approval.submitted`，按条件 `ticket.step_changed`、`order.item.live_revoked`（授权书收敛回“待生效”）、`order.status_changed`、`patrol.voided`。

**说明**：重开的一轮以撤销人为发起人，撤销人不能再决定它（`APPROVAL_SELF_FORBIDDEN`），须由另一位发布专员核验。

### 3.20 admin.patrolTask.list　作品巡检列表

`GET /admin/patrol-tasks`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish`；数据范围：任务 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Patrol（列表：商家、剧目、账号、使用期至、上次巡检、本周结果） |
| 出处 | 路线图 `a06.patrol-tasks.list`；11-publish.md:474-575；proto-admin-a.md:451-490；d3-flow.md:3532；A24 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum | 否 | `all`、`pending`、`abnormal`、`normal`；缺省 `all` | 页签（A24，原 `result=`）：`pending` = 待巡检；`abnormal` = 异常（未恢复，`status = abnormal`）；`normal` = 正常与已恢复（`status` ∈ {`normal`,`recovered`}，原型“复查已恢复”后该行进入“正常”，Patrol.dc.html:245）；`all` = 不含已作废 |
| 查询 | `weekStartDate` | string(date) | 否 | 须是周一；缺省本周 | 周批次（原 `week=`，按字段名 `patrol_batch.week_start_date`） |
| 查询 | `openOnly` | boolean | 否 | 默认 `false` | 为真时忽略周，列出全部未结（`pending`、`abnormal`）的巡检 |
| 查询 | `source` | enum | 否 | `weekly_sample`、`manual`、`reissue` | — |
| 查询 | `storeId` | string(uuid) | 否 | — | — |
| 查询 | `q` | string | 否 | 1–64 字符 | 门店名、剧名、账号名 |
| 查询 | `page`、`pageSize` | integer | 否 | C43 | — |

**响应**：`AdminPage<PatrolTaskRow>`。排序：异常在前，其后待巡检、已恢复、正常；同组按建立时间。已恢复的行在 `normal` 页签里仍可凭 `status = recovered`、`recoveredAt` 标出“已恢复”。

**错误**：`VALIDATION_FAILED`（`weekStartDate` 不是周一）。**副作用**：无。

### 3.21 admin.patrolTask.summary　巡检页头与页签计数

`GET /admin/patrol-tasks/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish`；数据范围：任务（批次两项除外，见说明） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Patrol（“本周 09-28～10-04 · 上线中 1,392 部，抽查 10 部 · 已巡检 N · 异常 N”与页签计数） |
| 出处 | 路线图 `a06.patrol-tasks.summary`；11-publish.md:436-472；proto-admin-a.md:459 |

**请求**：查询参数与 3.20 相同（除 `tab`、分页外）。

**响应**（`PatrolSummary`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `weekStartDate` | string(date) | 是 | 周一 | 请求或本周 |
| `weekEndDate` | string(date) | 是 | 周日 | 计算 |
| `batch` | object \| null | 是 | 周批次 `{ patrolBatchId, liveTotal, sampledCount, generatedAt }`；当周还没有批次行为空 | `patrol_batch`（`week_start_date`）的 `live_total`、`sampled_count`、`generated_at` |
| `all` | integer | 是 | 全部（不含作废） | `patrol_task` 计数 |
| `pending` | integer | 是 | 待巡检 | `status = pending` |
| `abnormal` | integer | 是 | 异常（页签与页头“异常 N”，恢复后减少） | `status = abnormal` |
| `normal` | integer | 是 | 正常（含已恢复） | `status` ∈ {`normal`,`recovered`} |
| `checked` | integer | 是 | 已巡检（页头“已巡检 N”） | `status` ∈ {`normal`,`abnormal`,`recovered`} |

**错误**：`VALIDATION_FAILED`（`weekStartDate` 不是周一）。**副作用**：无。

**说明**：`batch.liveTotal`、`batch.sampledCount` 是全平台的周批次值，不按数据范围裁剪；其余计数按数据范围。`openOnly=true` 时计数跨周，其 `pending` 与 a02 工作台⑫“待巡检”同一计数函数（往周没做完的巡检仍是 `pending`，下周抽样会跳过它们，11-publish.md:463）。

### 3.22 admin.patrolTask.get　巡检任务详情

`GET /admin/patrol-tasks/{patrolTaskId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish`；数据范围：任务 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Patrol（侧边详情：账号、使用期、发布专员、异常信息、巡检项、操作提示） |
| 出处 | 路线图 `a06.patrol-tasks.get`；proto-admin-a.md:462 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `patrolTaskId` | string(uuid) | 是 | — | 巡检任务 |

**响应**：`PatrolTaskDetail`。

**错误**：无。**副作用**：无。

**说明**：巡检项条目经 a01 `admin.checklistTemplate.list?code=patrol.check` 取；截图查看经 `admin.file.downloadUrls`。

### 3.23 admin.patrolTask.create　手动发起巡检

`POST /admin/patrol-tasks`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.patrol.do`；数据范围：任务；模块等级 `o` 时须为本人任务 |
| 回显 | 无 |
| 幂等 | required（状态迁移 — → `pending`，A17、C47）：同键重放返回上次成功的结果。“同一上线任务已有在办巡检时返回那一条、不新建”（`uq_patrol_task_launch_task_id_open`）是业务语义，不是幂等方式：新键遇到在办巡检时返回它，`isNew = false` |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 原型无（数据异常等场景手动补建；V1.1 数据录入的降幅预警也会生成巡检） |
| 出处 | 路线图 `a06.patrol-tasks.create`；11-publish.md:542 |

**请求**

请求体（`PatrolTaskCreateBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `launchTaskId` | string(uuid) | 是 | 在数据范围内 | 要巡检的上线任务（订单项 × 账号） |
| `reason` | string | 否 | ≤ 200 字 | 发起原因，写审计 |

**响应**（`PatrolTaskCreateResult`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `isNew` | boolean | 是 | 本次新建；为假表示返回了已有的在办巡检（其 `source` 可能不是 `manual`） | 计算 |
| `patrolTask` | `PatrolTaskDetail` | 是 | 巡检任务 | — |

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `PATROL_NOT_ELIGIBLE` | 409 | 上线任务不在线、订单项不在上线中，或工单不在服务中（`details.reason`） |
| `NOT_FOUND` | 404 | 上线任务不存在或不在范围内 |

**副作用**（同一事务，仅新建时；先对上线任务行取 `FOR SHARE` 再插入，并发的两次发起由 `uq_patrol_task_launch_task_id_open` 兜底，冲突的一方改为返回已有那条）：
- 取得当周批次 `patrol_batch`（没有则新建，`generated_at` 为空，11-publish.md:446）。
- `patrol_task.status`：（新建）→ `pending`（`patrol.create`，11-publish.md:542）；`source = manual`，归属列、工单、订单项从上线任务复制；状态历史与审计。
- 出站事件 `patrol.created`。

### 3.24 admin.patrolTask.markNormal　巡检正常

`POST /admin/patrol-tasks/{patrolTaskId}/mark-normal`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.patrol.do`；数据范围：任务；模块等级 `o` 时须为本人任务 |
| 回显 | 无 |
| 幂等 | required（状态迁移，A17） |
| 乐观锁 | 不带（11-publish.md:543 的守卫没有列锁版本） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Patrol（5 项全勾才可“巡检正常”） |
| 出处 | 路线图 `a06.patrol-tasks.mark-normal`（草案 `/patrols/{id}/ok`）；11-publish.md:543；proto-admin-a.md:472 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `patrolTaskId` | string(uuid) | 是 | — | 巡检任务 |

请求体（`PatrolTaskMarkNormalBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `checklistVersionNo`、`results` | `ChecklistResultInput` | 是 | 清单 `patrol.check`，全部通过 | 落 `patrol_task.checklist_code`（`patrol.check`）、`checklist_version_no`、`results` |
| `evidenceFileIds` | array<string(uuid)> | 是 | 1–9 张，分类 `evidence` | 巡检截图（主文档优先于原型，11-publish.md:494），落 `patrol_task.evidence_file_ids` |

**响应**：`PatrolTaskDetail`（`status = normal`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 任务不是 `pending` |
| `CHECKLIST_NOT_PASSED` | 400 | 清单未全部通过（应走发现异常）（a01 定义） |
| `CHECKLIST_VERSION_STALE` | 409 | 清单版本不是当前启用版本（a01 定义） |
| `FILE_NOT_USABLE` | 400 | 截图不可用 |
| `VALIDATION_FAILED` | 400 | 截图为空 |

**副作用**（同一事务；锁序：上线任务 → 巡检，因要回写 `launch_task`，1.1“锁序”）：
- `patrol_task.status`：`pending` → `normal`（`patrol.ok`，11-publish.md:543）；写清单、截图（`files.link()`，`patrol_task` / `evidence`）、`checked_at`、`checked_by_staff_id`。
- 回写 `launch_task.last_patrolled_at`、`launch_task.last_patrol_result = normal`。
- 状态历史与审计；出站事件 `patrol.passed`。

### 3.25 admin.patrolTask.markAbnormal　发现异常

`POST /admin/patrol-tasks/{patrolTaskId}/mark-abnormal`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.patrol.do`；数据范围：任务；模块等级 `o` 时须为本人任务 |
| 回显 | 无 |
| 幂等 | required（状态迁移，A17） |
| 乐观锁 | 不带 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Patrol（内联表单：异常类型单选、说明必填、“记录并通知商家”） |
| 出处 | 路线图 `a06.patrol-tasks.mark-abnormal`（`report-abnormal` 并入，C12；草案 `/patrols/{id}/abnormal`）；11-publish.md:544；proto-admin-a.md:473 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `patrolTaskId` | string(uuid) | 是 | — | 巡检任务 |

请求体（`PatrolTaskMarkAbnormalBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `abnormalKindCode` | string | 是 | 字典 `patrol_issue` 的启用编码 | 被删除、仅自己可见、审核异常或限流、被搬运、集数缺失、标识被裁剪；落 `patrol_task.abnormal_kind_code` |
| `note` | string | 是 | 1–200 字 | 落 `patrol_task.note` |
| `evidenceFileIds` | array<string(uuid)> | 是 | 1–9 张，分类 `evidence` | 落 `patrol_task.evidence_file_ids` |
| `checklistVersionNo`、`results` | `ChecklistResultInput` | 否 | 清单 `patrol.check`，可含 `fail` | 带了就写清单三列 |

**响应**：`PatrolTaskDetail`（`status = abnormal`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 任务不是 `pending` |
| `CHECKLIST_VERSION_STALE` | 409 | 带了清单且版本不是当前启用版本（a01 定义） |
| `DICT_ITEM_DISABLED` | 409 | 异常类型编码不在字典 `patrol_issue` 里或已停用（m08 定义） |
| `FILE_NOT_USABLE` | 400 | 截图不可用 |
| `VALIDATION_FAILED` | 400 | 截图为空；说明为空或超长 |

**副作用**（同一事务；锁序：上线任务 → 巡检）：
- `patrol_task.status`：`pending` → `abnormal`（`patrol.abnormal`，11-publish.md:544）；写异常类型、说明、截图、`found_at`、`notified_at`（= 现在）、`checked_at`、`checked_by_staff_id`。
- 回写 `launch_task.last_patrolled_at`、`launch_task.last_patrol_result = abnormal`。
- 登记定时器 `patrol.followup`（主体 `patrol_task`，`fire_at` = 发现时刻 + 3 个自然日，键 `patrol.followup:patrol_task:{patrolTaskId}`，已登记于 01-kernel-flow.md:606（A144；x01 4.1），一个任务只进入一次 `abnormal`，不带轮次）：到点仍异常时由处理器给交付经理写系统跟进待办（11-publish.md:549）。
- 状态历史与审计；出站事件 `patrol.abnormal`（站内“巡检异常”通知商家）。

**说明**：巡检异常不自动改账号状态、不结束使用期（d3-flow.md:1909）；确属账号问题的另调 `admin.channelAccount.markAbnormal`。

### 3.26 admin.patrolTask.recover　复查已恢复

`POST /admin/patrol-tasks/{patrolTaskId}/recover`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.patrol.do`；数据范围：任务；模块等级 `o` 时须为本人任务 |
| 回显 | 无 |
| 幂等 | required（状态迁移，A17） |
| 乐观锁 | 不带 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Patrol（5 项全勾才可“复查已恢复”） |
| 出处 | 路线图 `a06.patrol-tasks.recover`；11-publish.md:546；proto-admin-a.md:475 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `patrolTaskId` | string(uuid) | 是 | — | 巡检任务 |

请求体（`PatrolTaskRecoverBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `checklistVersionNo`、`results` | `ChecklistResultInput` | 是 | 清单 `patrol.check`，全部通过 | 覆盖清单三列 |
| `evidenceFileIds` | array<string(uuid)> | 是 | 1–9 张新截图，分类 `evidence`，不与已有截图重复 | 追加到 `patrol_task.evidence_file_ids` |

**响应**：`PatrolTaskDetail`（`status = recovered`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 任务不是 `abnormal` |
| `CHECKLIST_NOT_PASSED` | 400 | 清单未全部通过（a01 定义） |
| `CHECKLIST_VERSION_STALE` | 409 | 清单版本不是当前启用版本（a01 定义） |
| `FILE_NOT_USABLE` | 400 | 截图不可用 |
| `VALIDATION_FAILED` | 400 | 截图为空或与已有重复 |

**副作用**（同一事务；锁序：上线任务 → 巡检）：
- `patrol_task.status`：`abnormal` → `recovered`（`patrol.recover`，11-publish.md:546）；写清单、追加截图、`recovered_at`、`checked_at`、`checked_by_staff_id`。
- 取消定时器 `patrol.followup`；关闭本任务在办的系统跟进待办（经 staff 的接口，如有）。
- 回写 `launch_task.last_patrolled_at`、`launch_task.last_patrol_result = recovered`。
- 状态历史与审计；出站事件 `patrol.recovered`（通知商家已恢复）。

### 3.27 admin.patrolTask.remind　再次提醒商家

`POST /admin/patrol-tasks/{patrolTaskId}/remind`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.patrol.do`；数据范围：任务；模块等级 `o` 时须为本人任务 |
| 回显 | 无 |
| 幂等 | required（对外发送，A17） |
| 乐观锁 | 不带 |
| 限流 | `admin.global`；业务限频：同一任务每日一次（`manual_reminder_log`） |
| 开关 | 无 |
| 对应画板 | A:Patrol（异常态“再次提醒”） |
| 出处 | 路线图 `a06.patrol-tasks.remind`；11-publish.md:545；13-notify-docs.md:612-646；proto-admin-a.md:474 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `patrolTaskId` | string(uuid) | 是 | — | 巡检任务 |

请求体：无（空对象）。

**响应**：`PatrolTaskDetail`（`remindCount` 加 1，`isRemindedToday = true`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 任务不是 `abnormal` |
| `REMINDED_TODAY` | 409 | 今天已提醒过（通用码 40920，C27、A76；`details = { scene, nextAvailableDate }`，A131 定型，`scene = patrol_fix`，与 a05 `RemindResult.nextAvailableDate` 同名） |

**副作用**（同一事务，锁巡检一行）：
- 先插 `manual_reminder_log`（`subject_type = patrol_task`、`scene = patrol_fix`、`biz_date` = 今天、`sent_by_staff_id`）；唯一冲突即返回 `REMINDED_TODAY`，后续都不做。
- `patrol_task.remind_count + 1`；状态历史 `abnormal` → `abnormal`（`patrol.remind`，11-publish.md:545）与审计。
- 出站事件 `patrol.reminded`、`manual_reminder.sent`（通知中心按场景派发给商家，节点 `M`）。

### 3.28 admin.takedownTask.list　下架核查队列

`GET /admin/takedown-tasks`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish`；数据范围：任务 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Offline（队列：商家、标签“逾期 2 天 / 今天 18:30 前核查 / 已核查”、剧目、副标题） |
| 出处 | 路线图 `a06.takedown-tasks.list`；11-publish.md:577-702；proto-admin-a.md:491-533；d3-flow.md:3533 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum | 否 | `pending`、`waiting`、`checked`；缺省 `pending` | `pending` = 待核查：商家已确认（`merchant_confirmed`），或已过应完成日仍未确认（`pending_merchant` 且今天 > `due_date`），与工作台“待核查下架”同口径（a02 ⑧）；`waiting` = 待商家下架、未逾期（原型没有这个页签，供筛选与排障）；`checked` = 已核查；作废的不返回 |
| 查询 | `status` | enum，逗号分隔 | 否 | `pending_merchant`、`merchant_confirmed`、`checked` | 页签内再筛 |
| 查询 | `isOverdue` | boolean | 否 | — | 只看逾期未下架 |
| 查询 | `basis` | enum | 否 | `live`、`delivered_unverified` | — |
| 查询 | `orderItemId`、`storeId` | string(uuid) | 否 | — | — |
| 查询 | `dueFrom`、`dueTo` | string(date) | 否 | — | 按应完成日（两端都含） |
| 查询 | `q` | string | 否 | 1–64 字符 | 门店名、剧名、订购单号 |
| 查询 | `page`、`pageSize` | integer | 否 | C43 | — |

**响应**：`AdminPage<TakedownTaskRow>`。排序：`pending` 先逾期未下架（应完成日升序），再商家已确认（核查时限升序）；`waiting` 按应完成日升序；`checked` 按核查时间倒序。

**错误**：无。**副作用**：无。

**说明**：同一部剧的全部成片常在同一天到期（proto-admin-a.md:527 第 6 条），用 `orderItemId` 或 `q` 筛出后批量核查（3.29）。

### 3.29 admin.takedownTask.batchCheck　批量核查

`POST /admin/takedown-tasks/check`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.takedown.check`；数据范围：任务；模块等级 `o` 时每个任务须为本人任务 |
| 回显 | 无 |
| 幂等 | required（集合动作，A10、A17） |
| 乐观锁 | 不带 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Offline（原型只有逐条处理，批量入口按 d3 补） |
| 出处 | 路线图 `a06.takedown-tasks.check-batch`（草案 `POST /takedown-tasks:check`）；d3-flow.md:1999；11-publish.md:655、667 |

**请求**

请求体（`TakedownBatchCheckBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `items` | array<object> | 是 | 1–50 项，`takedownTaskId` 不重复；每项 `{ takedownTaskId, checklistCode, checklistVersionNo, results, evidenceFileIds }`，各字段规则同 3.32 | 每个任务各带自己的清单与证据截图（d3-flow.md:1999） |

**响应**（`TakedownBatchCheckResult`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `items` | array<`TakedownTaskRow`> | 是 | 核查后的任务，按请求顺序 | — |
| `archivedTicketIds` | array<string(uuid)> | 是 | 因本次核查而归档的工单 | 计算 |

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `TAKEDOWN_BATCH_REJECTED` | 409 | 有任务不满足条件，整批未处理；`details.items` 逐项给出 `{ index, takedownTaskId, error, message }`（`error` 取 3.32 的错误码） |
| `VALIDATION_FAILED` | 400 | 条数越界、任务重复 |

**副作用**：全部通过才在一个事务里逐项执行 3.32 的副作用；锁序同 3.32 并按层批量：订购单 → 订单项 → 交付工单 → 成片包 → 下架任务（`lock_rank` 160 → 170 → 180 → 210 → 280），每层按 id 升序锁齐涉及的行后再进入下一层（归档要改 `order_item.phase`、重推订购单状态、关闭成片包，先锁工单再锁订单项会逆序）；每张工单在全部任务写完后 `reevaluate` 一次。出站事件同 3.32。

**说明**：整批原子：一条失败全部不写，端上去掉出错项后用新的幂等键重提（改了内容须换键，C48）。

### 3.30 admin.takedownTask.summary　下架核查计数

`GET /admin/takedown-tasks/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish`；数据范围：任务 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Offline（页签“待核查 N / 已核查 N”）；A:Main（“待核查下架 3（逾期未下架 1）”） |
| 出处 | 路线图 `a06.takedown-tasks.summary`；A23、A26；C83；proto-admin-a.md:697 |

**请求**：查询参数与 3.28 相同（除 `tab`、`status`、分页外）。

**响应**（`AdminTakedownSummary`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `pending` | integer | 是 | 待核查（与 a02 工作台⑧“待核查下架”同一计数函数） | `takedown_task.status = merchant_confirmed`，或 `pending_merchant` 且今天 > `due_date`（`ix_takedown_task_status_due_date`） |
| `waiting` | integer | 是 | 待商家下架、未逾期 | `pending_merchant` 且今天 ≤ `due_date` |
| `checked` | integer | 是 | 已核查 | `status = checked` |
| `overdue` | integer | 是 | 逾期未下架（副指标，“逾期未下架 1”） | `pending_merchant` 且今天 > `due_date` |
| `dueToday` | integer | 是 | 今日核查截止 | `merchant_confirmed` 且 `check_due_at` 在今天 |
| `checkOverdue` | integer | 是 | 已过核查时限 | `merchant_confirmed` 且现在 > `check_due_at` |

**错误**：无。**副作用**：无。

### 3.31 admin.takedownTask.get　下架任务详情

`GET /admin/takedown-tasks/{takedownTaskId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish`；数据范围：任务 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Offline（详情：使用期、结束依据、下架方式、负责人、处理记录、核查清单、证据） |
| 出处 | 路线图 `a06.takedown-tasks.get`；proto-admin-a.md:503-504 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `takedownTaskId` | string(uuid) | 是 | — | 下架任务 |

**响应**：`TakedownTaskDetail`。

**错误**：无。**副作用**：无。

**说明**：核查清单条目按 `expectedChecklistCode` 经 a01 `admin.checklistTemplate.list` 取；证据查看经 `admin.file.downloadUrls`。

### 3.32 admin.takedownTask.check　核查通过

`POST /admin/takedown-tasks/{takedownTaskId}/check`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.takedown.check`（发布专员）；数据范围：任务；模块等级 `o` 时须为本人任务 |
| 回显 | 无 |
| 幂等 | required（状态迁移，A17） |
| 乐观锁 | 不带（11-publish.md:655 的守卫没有列锁版本） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Offline（2 项全勾、上传主页与合集页截图后“核查通过”；“该剧成片服务结束，工单已归档”） |
| 出处 | 路线图 `a06.takedown-tasks.check`；11-publish.md:655；10-delivery.md:188；09-order-ad.md:358；proto-admin-a.md:514 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `takedownTaskId` | string(uuid) | 是 | — | 下架任务 |

请求体（`TakedownCheckBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `checklistCode` | enum | 是 | `takedown.check`、`takedown.absence_check`；须等于任务的 `expectedChecklistCode` | 落 `takedown_task.checklist_code` |
| `checklistVersionNo`、`results` | `ChecklistResultInput` | 是 | 全部通过 | 落 `takedown_task.checklist_version_no`、`results` |
| `evidenceFileIds` | array<string(uuid)> | 是 | 2–9 张不同文件（至少账号主页、合集页），分类 `evidence` | 落 `takedown_task.evidence_file_ids`，长期留存 |

**响应**：`TakedownTaskDetail`（`status = checked`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 任务已核查或已作废 |
| `PRECONDITION_CHANGED` | 409 | 提交的清单编码与当前依据不符（期间该账号核验上线、依据已重算），`details.expectedChecklistCode` |
| `CHECKLIST_NOT_PASSED` | 400 | 清单未全部通过（a01 定义） |
| `CHECKLIST_VERSION_STALE` | 409 | 清单版本不是当前启用版本（a01 定义） |
| `FILE_NOT_USABLE` | 400 | 截图不可用 |
| `VALIDATION_FAILED` | 400 | 截图少于 2 张或重复 |

**副作用**（同一事务；锁序：订购单 → 订单项 → 交付工单 → 成片包 → 下架任务，`lock_rank` 160 → 170 → 180 → 210 → 280，1.1“锁序”；归档会改订单项阶段、重推订购单状态并关闭成片包，所以先锁上层再锁任务）：
- `takedown_task.status`：`merchant_confirmed` / `pending_merchant` → `checked`（`takedown.check_pass`，11-publish.md:655）；写 `check_method = evidence`、清单、证据、`checked_by_staff_id`、`checked_at`；证据 `files.link()`（`takedown_task` / `evidence`，不释放）。
- 从 `pending_merchant` 来的取消 `takedown.overdue`（按前缀 `takedown.overdue:takedown_task:{id}:`）。
- `reevaluate(工单)`：工单在 `takedown` 且该订单项未作废的下架任务至少 1 条且全部已核查时 `delivery_ticket.step`：`takedown` → `archived`（`takedown.all_checked`，10-delivery.md:188 第 16 行），写 `archived_at`；`order_item.phase`：`to_launch` / `live` → `ended` 或 `refunded`（09-order-ad.md:358）；成片包随归档关闭（`delivery_release.state`：`pushed` → `closed`，`close_reason = usage_ended`，10-delivery.md:883）；订购单状态重新推导。已终止工单名下的核查不驱动工单迁移（11-publish.md:666）。
- 状态历史与审计；出站事件 `takedown.checked`，归档时另发 `ticket.archived`、`order.status_changed`。

**说明**：商家未确认、靠核查“无本剧作品”收口的任务一律逐条核查（11-publish.md:668）。按比例抽查放行（`takedown.sample_release`）发生在商家确认的事务里（m05），不经本接口。

### 3.33 admin.takedownTask.escalate　逾期未下架手动升级

`POST /admin/takedown-tasks/{takedownTaskId}/escalate`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.takedown.check`；数据范围：任务；模块等级 `o` 时须为本人任务 |
| 回显 | 无 |
| 幂等 | required（对外发送，A17） |
| 乐观锁 | 不带 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Offline（逾期任务；系统在应完成日次日 09:00 自动升级，本接口为手动触发） |
| 出处 | 路线图 `a06.takedown-tasks.escalate`；11-publish.md:659；d3-flow.md:1986 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `takedownTaskId` | string(uuid) | 是 | — | 下架任务 |

请求体（`TakedownNoteBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `note` | string | 否 | ≤ 200 字 | 落 `status_transition.note` |

**响应**：`TakedownTaskDetail`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 任务不是 `pending_merchant` |
| `TAKEDOWN_NOT_OVERDUE` | 409 | 今天未过应完成日（`details.dueDate`） |

**副作用**（同一事务，锁下架任务一行）：写 `takedown_task.escalated_at`；状态历史 `pending_merchant` → `pending_merchant`（`takedown.escalate`，11-publish.md:659）与审计；出站事件 `takedown.escalated`（通知交付主管与交付经理）。

**说明**：数据模型不限制升级次数；同一意图的重复点击由幂等键挡住。

### 3.34 admin.takedownTask.markOnline　抽查仍在线

`POST /admin/takedown-tasks/{takedownTaskId}/mark-online`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.takedown.check`；数据范围：任务；模块等级 `o` 时须为本人任务 |
| 回显 | 无 |
| 幂等 | required（状态迁移，A17） |
| 乐观锁 | 不带 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Offline（“仍在线，升级主管”，toast“已记录抽查结果并升级至交付主管”） |
| 出处 | 路线图 `a06.takedown-tasks.mark-online`（草案 `/still-online`）；11-publish.md:657；proto-admin-a.md:515 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `takedownTaskId` | string(uuid) | 是 | — | 下架任务 |

请求体（`TakedownNoteBody`）：`note`（选填，≤ 200 字，抽查结果说明，落 `status_transition.note`）。

**响应**：`TakedownTaskDetail`（`status = pending_merchant`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 任务不是 `merchant_confirmed` |

**副作用**（同一事务）：
- `takedown_task.status`：`merchant_confirmed` → `pending_merchant`（`takedown.still_online`，11-publish.md:657）；`still_online_count + 1`；清空确认三列、`check_due_at`、`sla_snapshot`；写 `escalated_at`。
- 应完成日次日 09:00 尚未到时重新登记 `takedown.overdue`（键 `takedown.overdue:takedown_task:{id}:{due_date}`）。
- 状态历史与审计；出站事件 `takedown.found_online`（通知商家重新下架；升级交付主管）。

**说明**：工单若已因“全部已由商家确认”进入到期下架（10-delivery.md:186），不回退。抽查截图没有落点，见第 6 节第 6 项。

### 3.35 admin.takedownTask.sendBreachNotice　发送违约提醒

`POST /admin/takedown-tasks/{takedownTaskId}/send-breach-notice`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.takedown.breach_notice`（发布专员、交付经理）；数据范围：任务 |
| 回显 | 无 |
| 幂等 | required（对外发送，A17） |
| 乐观锁 | 不带 |
| 限流 | `admin.global`；业务限频：同一任务每日一次（`manual_reminder_log`） |
| 开关 | 无 |
| 对应画板 | A:Offline（已逾期任务“发送违约提醒”：要求 24 小时内删除作品或设为仅自己可见） |
| 出处 | 路线图 `a06.takedown-tasks.send-breach-notice`；11-publish.md:660；13-notify-docs.md:614、640；proto-admin-a.md:516 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `takedownTaskId` | string(uuid) | 是 | — | 下架任务 |

请求体：无（空对象）。

**响应**：`TakedownTaskDetail`（`breachNoticeCount` 加 1）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 任务不是 `pending_merchant` |
| `TAKEDOWN_NOT_OVERDUE` | 409 | 今天未过应完成日 |
| `REMINDED_TODAY` | 409 | 今天已对该任务发过违约提醒（通用码 40920，C27、A76；`details = { scene, nextAvailableDate }`，A131，`scene = breach`） |

**副作用**（同一事务）：
- 先插 `manual_reminder_log`（`subject_type = takedown_task`、`scene = breach`、`biz_date` = 今天）；冲突即返回 `REMINDED_TODAY`。
- `takedown_task.breach_notice_count + 1`；状态历史 `pending_merchant` → `pending_merchant`（`takedown.breach_notice`，11-publish.md:660）与审计。
- 出站事件 `takedown.breach_notified`、`manual_reminder.sent`（按场景 `m.offline_remind` 派发给商家）。

### 3.36 admin.metricImport.create　上传 Excel 并逐行校验（V1.1）

`POST /admin/metric-imports`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.metrics.enter`（V1.1，增补表，A129） |
| 幂等 | required |
| 乐观锁 | 无 |
| 开关 | V1.1 功能开关，关闭时不挂载 |
| 对应画板 | A:DataEntry（Excel 导入两步：上传后逐行校验） |
| 出处 | 路线图 `a06.metric-imports.create`；proto-admin-a.md:559 |

V1.1，细节待设计：上传文件后逐行校验，返回逐行结果与导入批次；V1.0 不建表（01-architecture.md:206）。

### 3.37 admin.metricImport.template.get　下载数据录入模板（V1.1）

`GET /admin/metric-imports/template`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 开关 | V1.1 |
| 对应画板 | A:DataEntry（“数据录入模板.xlsx”） |
| 出处 | 路线图 `a06.metric-imports.template`；proto-admin-a.md:558 |

V1.1，细节待设计。字面段先于 `/{metricImportId}` 注册。

### 3.38 admin.metricImport.commit　提交导入（V1.1）

`POST /admin/metric-imports/{metricImportId}/commit`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.metrics.enter`（增补表，A129） |
| 幂等 | required（按导入批次防重复提交） |
| 乐观锁 | 无 |
| 开关 | V1.1 |
| 对应画板 | A:DataEntry（只导入校验通过的行） |
| 出处 | 路线图 `a06.metric-imports.commit`；proto-admin-a.md:559 |

V1.1，细节待设计。

### 3.39 admin.metricSubmission.list　作品数据提交队列（V1.1）

`GET /admin/metric-submissions`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块查看 `publish` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 开关 | V1.1 |
| 对应画板 | A:DataEntry（待录入、已录入、已驳回） |
| 出处 | 路线图 `a06.metric-submissions.list`；proto-admin-a.md:555 |

V1.1，细节待设计；页签计数届时补 `summary`（A23）。

### 3.40 admin.metricSubmission.approve　录入指标并通过（V1.1）

`POST /admin/metric-submissions/{metricSubmissionId}/approve`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.metrics.enter`（增补表，A129） |
| 幂等 | required |
| 乐观锁 | V1.1 定 |
| 开关 | V1.1 |
| 对应画板 | A:DataEntry（录入 7 项指标；播放量降幅超 30% 时生成巡检任务） |
| 出处 | 路线图 `a06.metric-submissions.approve`；proto-admin-a.md:556 |

V1.1，细节待设计。降幅预警生成的巡检 `source = data_anomaly`（届时加入 `ck_patrol_task_source`，11-publish.md:487）。

### 3.41 admin.metricSubmission.reject　驳回数据提交（V1.1）

`POST /admin/metric-submissions/{metricSubmissionId}/reject`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `publish.metrics.enter`（增补表，A129） |
| 幂等 | required |
| 乐观锁 | V1.1 定 |
| 开关 | V1.1 |
| 对应画板 | A:DataEntry（原因下拉、说明选填） |
| 出处 | 路线图 `a06.metric-submissions.reject`；proto-admin-a.md:557 |

V1.1，细节待设计。

## 4. 枚举

### 4.1 渠道账号

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `ChannelPlatform` | `douyin`、`wechat_channels` | 同数据模型 `channel_account.platform`、`launch_task.platform` |
| `ChannelAccountStatus` | `pending_verify`、`available`、`abnormal`、`unbound` | 同数据模型 `channel_account.status` |
| `ChannelAccountType` | `enterprise`、`personal`、`none` | 同数据模型 `channel_account.account_type` |
| `AbnormalSource` | `verify`、`manual` | 同数据模型 `channel_account.abnormal_source` |
| `ChannelAccountSubmissionKind` | `new_binding`、`resubmit` | 同数据模型 `channel_account_submission.kind` |
| `CompareField` | `account_name`、`account_uid`、`account_type`、`cert_subject_name`、`account_status` | 同数据模型 `ChannelAccountCompareResult.field`（11-publish.md:758） |
| `ChannelAccountEventKind` | `bound`、`resubmitted`、`verified`、`verify_rejected`、`marked_abnormal`、`unbound` | 接口枚举：核验记录，分别对应迁移码 `account.bind`、`account.resubmit`、`account.verify_pass`、`account.verify_reject`、`account.mark_abnormal`、`account.unbind` |

### 4.2 审批

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `ApprovalStatus` | `pending`、`approved`、`rejected`、`withdrawn` | 同数据模型 `approval_request.status` |
| `ApprovalKind`（本文用到的） | `channel_account`、`launch_link` | 同数据模型 `approval_request.kind` 的子集 |
| `ActorType` | `merchant`、`staff`、`system`、`partner` | 同数据模型 `approval_request.submit_actor_type` |
| `Client` | `weapp`、`portal`、`admin` | 同数据模型 `approval_request.submit_client` |

### 4.3 发布清单与成片包

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `PublishListMissingItem` | `collection_name`、`cover`、`intro`、`topics`、`episode_titles` | 接口枚举：推送守卫缺的项（10-delivery.md:1157） |
| `PublishListLockReason` | `links_submitted`、`ticket_paused`、`ticket_step` | 接口枚举：已有回填提交、工单暂停中、工单不在成片交付或待上线 |
| `ImportFormat` | `csv`、`tsv` | 接口枚举：导入文本格式 |
| `ReleaseKind` | `initial`、`reissue` | 同数据模型 `delivery_release.kind` |
| `ReleaseVariant` | `common`、`douyin`、`wechat_channels` | 同数据模型 `delivery_release.variant` |
| `ReleaseState` | `pushed`、`superseded`、`closed` | 同数据模型 `delivery_release.state` |
| `ReleaseCloseReason` | `cancelled`、`usage_ended` | 同数据模型 `delivery_release.close_reason` |
| `ZipState` | `none`、`building`、`ready`、`failed` | 同数据模型 `zip_bundle.zip_state` |

### 4.4 上线

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `LaunchReviewStatus` | `pending`、`verifying`、`need_fix`、`passed`、`void` | 同数据模型 `launch_task.review_status` |
| `LaunchSubmissionResult` | `pending`、`passed`、`passed_partial`、`returned`、`revoked`、`withdrawn` | 同数据模型 `launch_submission.result` |
| `LinkKind` | `collection`、`episodes` | 同数据模型 `launch_submission.link_kind` |
| `CalendarStatus` | `producing`、`to_launch`、`verifying`、`overdue` | 接口枚举：日历图例（制作中、待上线、上线核验、已逾期） |
| `LaunchTrackTab` | `overdue`、`upcoming`、`all` | 接口枚举：逾期跟踪页签；`all` 供工单详情按工单查上线任务 |
| `OverdueReason` | `merchant`、`late_delivery` | 接口枚举：商家逾期、成片晚交（d3-flow.md:1817 的 `reason`） |
| `RevokeBlockedReason` | `not_latest_passed`、`task_not_passed`、`window_closed`、`takedown_confirmed`、`ticket_not_in_service`、`ticket_on_hold` | 接口枚举：`LaunchSubmissionDetail.revoke.blockedReasons`（`ticket_on_hold` 对应 3.19 的 `TICKET_ON_HOLD`） |
| `DeliveryTicketStep` | 13 个取值 | 同数据模型 `delivery_ticket.step` |
| `OrderItemPhase` | 8 个取值 | 同数据模型 `order_item.phase` |
| `UsageEndSource` | `license`、`early_end`、`expired` | 同数据模型 `order_item.usage_end_source` |

### 4.5 巡检

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `PatrolSource` | `weekly_sample`、`manual`、`reissue` | 同数据模型 `patrol_task.source`（V1.1 加 `data_anomaly`，标 `x-open-enum`） |
| `PatrolStatus` | `pending`、`normal`、`abnormal`、`recovered`、`void` | 同数据模型 `patrol_task.status` |
| `PatrolTab` | `all`、`pending`、`abnormal`、`normal` | 接口枚举：巡检页签；`abnormal` 只含未恢复的异常，`normal` 含已恢复（与原型一致） |
| `ChecklistResult` | `pass`、`fail`、`na` | 同数据模型 `ChecklistResults.result` |

### 4.6 下架

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `TakedownStatus` | `pending_merchant`、`merchant_confirmed`、`checked`、`void` | 同数据模型 `takedown_task.status`；接口不返回 `void` 的任务 |
| `TakedownTriggerKind` | `expiry`、`early_end`、`platform_termination`、`terminated_after_delivery` | 同数据模型 `takedown_task.trigger_kind` |
| `TakedownBasis` | `live`、`delivered_unverified` | 同数据模型 `takedown_task.basis` |
| `TakedownMethod` | `delete`、`private`、`not_published` | 同数据模型 `takedown_task.merchant_method` |
| `TakedownCheckMethod` | `evidence`、`sampled_out` | 同数据模型 `takedown_task.check_method` |
| `TakedownChecklistCode` | `takedown.check`、`takedown.absence_check` | 同数据模型 `takedown_task.checklist_code` |
| `TakedownTab` | `pending`、`waiting`、`checked` | 接口枚举：下架核查页签（`waiting` 原型没有） |
| `TakedownEventKind` | `created`、`auto_reminded`、`manual_reminded`、`merchant_confirmed`、`sample_released`、`found_online`、`basis_reopened`、`escalated`、`breach_notified`、`checked`、`voided`、`check_due_recalculated`、`follow_up` | 接口枚举：处理记录；状态历史的迁移码映射（`takedown.create` → `created`、`takedown.still_online` → `found_online`、`takedown.breach_notice` → `breach_notified` 等，日历修正的 `from = to` 行 → `check_due_recalculated`），自动提醒取通知，人工催办只取场景 `takedown` 的催办记录，人工跟进取 `follow_up`（见 `TakedownEventView`） |

会增长的响应枚举（状态、类型、原因）在契约里标 `x-open-enum`，端上须有未知值兜底（C37）。

## 5. 错误码

本文新定义的领域错误码，数值取自 A70 分给本文的区间 46200–46299。`retryable` 全部为否（C26）。初稿的 `REMINDED_TODAY`（46201）按 A76 改为通用码，`CHECKLIST_NOT_PASSED`（46203）按 A77 归 a01，两个数值释放、不再复用。

| 符号 | 数值 | HTTP | 含义 | `details` |
| --- | --- | --- | --- | --- |
| `PATROL_NOT_ELIGIBLE` | 46202 | 409 | 不能发起巡检：上线任务不在线、订单项不在上线中或工单不在服务中（11-publish.md:542） | `{ reason: 'task_not_live'\|'item_not_live'\|'ticket_not_in_service' }` |
| `PUBLISH_LIST_LOCKED` | 46204 | 409 | 首个上线任务已提交回填，发布清单已锁定（d3-flow.md:1635） | `{ lockedAt }` |
| `PUBLISH_LIST_IMPORT_INVALID` | 46205 | 400 | 导入内容有错，整批未写入 | `{ rows: [{ rowNo, episodeNo, column, message }] }` |
| `ACCOUNT_COMPARE_MISMATCH` | 46206 | 409 | 比对表有不一致项，或企业认证的认证主体与营业执照主体不一致，不能通过，请标记异常（11-publish.md:109、130） | `{ fields: CompareField[] }` |
| `LAUNCH_VERIFY_COUNT_OUT_OF_RANGE` | 46207 | 400 | 核验集数不在“`max(1, 已核验集数)` 至本次声明集数”之间（d3-flow.md:1755；`ck_launch_submission_verified`） | `{ min, max }` |
| `LAUNCH_REVOKE_WINDOW_CLOSED` | 46208 | 409 | 已超过撤销核验通过的时限（参数 `launch.verify_revoke_window`） | `{ decidedAt, deadlineAt }` |
| `LAUNCH_REVOKE_BLOCKED` | 46209 | 409 | 该订单项已有商家确认或已核查的下架任务，不能撤销核验通过（11-publish.md:303） | `{ takedownTaskIds: string[] }` |
| `TAKEDOWN_NOT_OVERDUE` | 46210 | 409 | 今天未过应完成日，不能升级或发违约提醒（11-publish.md:659-660） | `{ dueDate }` |
| `TAKEDOWN_BATCH_REJECTED` | 46211 | 409 | 批量核查中有任务不满足条件，整批未处理 | `{ items: [{ index, takedownTaskId, error, message }] }` |

引用的其他文档的错误码：

| 符号 | 定义方 | 本文用处 |
| --- | --- | --- |
| `APPROVAL_NOT_PENDING`、`APPROVAL_SELF_FORBIDDEN` | a03-merchant（审批区间 48200–48299；d4-identity.md:2334-2335；03-staff-authz-audit.md:808） | 账号核验、链接核验的决定 |
| `CHECKLIST_VERSION_STALE`、`CHECKLIST_NOT_PASSED` | a01-system（清单类，A77、C28 归属表；`CHECKLIST_VERSION_STALE` 47306，`CHECKLIST_NOT_PASSED` 47307、`details = { missingKeys, failedKeys, invalidNaKeys }`） | 带清单结论的各接口 |
| `DICT_ITEM_DISABLED` | m08-support-misc（47001，409，`details = { dictTypeKey, code }`；A77） | 提交原因、异常类型编码的接口（3.4、3.7、3.18、3.25） |
| `TICKET_ON_HOLD` | m05-delivery-publish（45103，`details.reasons`） | 发布清单保存与导入、链接核验通过与撤销 |
| `DOWNLOAD_GRANT_INVALID` | m05-delivery-publish（45109） | 预打包 |
| `FILE_NOT_USABLE` | m03-profile-asset（46001） | 提交截图与封面 |

通用码（C27）：`VALIDATION_FAILED`、`NOT_FOUND`、`STATE_NOT_ALLOWED`、`VERSION_CONFLICT`、`CONFIRM_MISMATCH`、`PRECONDITION_CHANGED`、`PERMISSION_DENIED`、`REMINDED_TODAY`（409，40920，A76；人工催办每日一次，3.27、3.35 返回，`details = { scene, nextAvailableDate }`（A131））。

## 6. 待确认

只列需要产品、业务、法务决定的事项（A108）。初稿第 1 项（`REMINDED_TODAY` 的归属）已由 A76 定为通用码；第 2 项（`publish.link.verify_revoke`、`publish.metrics.enter` 进增补表）与第 3 项（`patrol.followup` 的定时器键回写 01 分组）是登记事项，已分别由 A129（进增补表）、A144（01-kernel-flow.md:606 已登记）落定，不再列在这里。第三轮核对 A127–A150，下表各项都没有被裁决覆盖，保留。

| # | 问题 | 默认做法 | 由谁定 |
| --- | --- | --- | --- |
| 1 | 清单 `account.verify` 没有播种条目（d3-flow.md:1507 只列了 `launch.verify`），原型账号核验只有比对表 | 比对表必填；`account.verify` 有启用版本时清单才必填 | 产品 |
| 2 | 发布清单的“导入表格”是否要支持 .xlsx 上传 | V1.0 只收 CSV / TSV 文本（端上读 .csv 或粘贴）；.xlsx 需要新增文件分类与服务端解析库（d7-platform.md:1153 定为 V1.1 选型） | 产品 + 研发 |
| 3 | 账号核验标题区的“用途说明”原型示例为“付款单 FK… 待确认收款”，与账号无关 | 按账号的使用情况（引用它的订单项及约定上线日）显示；无订购时显示“暂无订购使用；核验通过后可作为发布账号” | 产品 |
| 4 | 上线日历按 PRD 只展示待上线，还是按原型展示全部交付中的工单 | 按原型四类（制作中、待上线、上线核验、已逾期）；方案未确认的项按已推送方案里的日期显示并标“待确认”（`isDateTentative`），还没推送方案的（多为待分派）没有日期、不上日历 | 产品 |
| 5 | 逾期跟踪的“N 单”按订单项计（原型），商家端发布任务页按“订单项 × 账号”计（A54） | 后台按订单项，卡片内标出是哪个账号逾期 | 产品 |
| 6 | 抽查“仍在线”是否要留截图（数据模型没有落点列） | 只记说明（`status_transition.note`）；如要留证，需给 `takedown_task` 加列或复用 `evidence_file_ids`（会与核查证据混在一起） | 业务 + 数据模型 |
| 7 | 撤销核验通过的守卫要求“工单在服务中”，部分集数通过但未算上线（`launch.partial_goes_live = false`）的误核验不能撤销 | 按数据模型：超过条件的更正走人工纠偏（d3-flow.md:1857） | 业务 |
| 8 | 手动升级逾期未下架没有次数或频率限制 | 不限，详情显示最近一次升级时间；如需限频，复用 `manual_reminder_log` 需新增场景 | 业务 |
| 9 | 账号核验队列卡片上的“发布专员”（11-publish.md 第 6 节第 1 项） | 决定前不显示，决定后显示审批人 | 产品 |
| 10 | 双平台一个账号已上线（工单已在服务中）、另一个账号逾期未上线时，能否“提醒商家上线” | 不能：按 a05 `golive` 的场景守卫（工单在 `awaiting_launch` 或 `launch_verify`），这类逾期项只给“记录跟进”；如要支持，a05 放宽守卫（`manual_reminder_log` 仍按订单项每日一次），两边同改 | 产品 + 业务 |

## 7. 修订记录

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：路线图 `doc = a06-publish` 的 41 条接口（V1.0 35、V1.1 6）；新定义错误码 11 个（46201–46211） | 写作规范；A1–A75；C1–C84；数据模型 03、06、09、10、11、13、14 分组 |
| 2026-10-03 | 第二轮：① 错误码：`REMINDED_TODAY` 改为通用码 409 / 40920（A76），3.27、3.35 与 1.1 同步，`details` 建议 `{ scene, nextAvailableDate }`；`CHECKLIST_NOT_PASSED` 归 a01（A77），本文改为引用；46201、46203 释放；字典编码不在字典里或已停用改返回 `DICT_ITEM_DISABLED`（m08，3.4、3.7、3.18、3.25）；撤销核验在工单暂停时返回 `TICKET_ON_HOLD`（m05 的请求）。② 公共片段：`Page<X>`、`SignedUrl`、`StaffRef`、`StoreBrief`、`ChecklistItemView`、`ChecklistInput`、`FollowUpBrief`、`ChannelAccountBrief` 不再自定义，改引用 a01 的 `AdminPage`、`SignedUrl`、`StaffBrief`，a05 的 `AdminStoreBrief`、`AdminChecklistItemView`、`ChecklistResultInput`，a03 的 `FollowUpItem`，m05 的 `ChannelAccountBrief`；`ApprovalView` 改为 a01 `ApprovalDecisionView` 加 `submitter`、`submitClient`、`checklist`、`confirmChecks`（`reasons[{code,name}]` 取代 `reasonCodes`、`reasonLabels`）；`DeliveryReleaseDetail` 以 a05 `ReleaseAdminView` 为基础（`reasonCode`、`precheck` 数组、`savedEpisodeCount`）；`TakedownSummary` 改名 `AdminTakedownSummary`。③ 结果脱敏（A80、C50）：账号核验通过与驳回、保存与导入发布清单的签名地址登记 `x-redact-on-replay`，响应带 `replayed`（新结构 `ChannelAccountDecisionResult`、`PublishListSaveResult`）。④ 页面与数据：`LaunchTaskBrief` 加 `currentSubmissionId`、`latestPassedSubmissionId`；`admin.launchTask.list` 加 `tab=all` 与 `deliveryTicketId`、`orderItemId` 筛选（工单详情的上线任务与撤销入口）；`LaunchCalendarItem` 加 `tasks`、`isDateTentative`、`actions`，方案未确认的项取已推送方案的日期；指标卡 `upcoming` 只算成片已交付、与 `deliveringSoon` 不重叠，summary 参数与列表相同（C83）并加 `all`；提醒上线的 `actions.remind` 与 a05 `golive` 守卫对齐；`ChannelAccountRow.latestRound` 加 `dueAt`，新增 `previousDecision`，`activeDramas` 加 `agreedLaunchDate`；巡检页签 `normal` 含已恢复、`abnormal` 只含未恢复（与原型一致），summary 去掉 `openAbnormal`；下架处理记录只取场景 `takedown` 的催办、加 `check_due_recalculated`、`follow_up`；核验集数下限改为 `max(1, 已核验集数)`；`admin.channelAccount.get` 接受 `merchant` 模块查看。⑤ 流程：预打包调 `ensureZip` 带重建选项 `retry: true`（A99），成片包详情不再返回 ZIP 状态（media 无只读端口，GET 不能调 `ensureZip`），预打包改回 `DeliveryReleasePackResult`；`admin.patrolTask.create` 改为 `required`（A17）；1.1 新增“锁序”，3.17–3.19、3.24–3.26、3.29、3.32 按 `lock_rank` 写明；1.1 补“工作台计数”，逾期口径实现为 `publish.listOverdueLaunchItems` 并与 a02 共用；账号核验的数据范围按 a01 2.10 的角色队列口径；`evidence` 的登记与签发授权引用 a01 2.17。⑥ 路线图切片：`channelAccountSubmission.reject` 与 `approve` 的请求体注记、`deliveryRelease.pack` 与 `takedownTask.escalate` 去掉“（建议）”、各接口 `tables` 按作者建议补齐、`patrolTask.create` 改 `required`、`channelAccount.get` 的模块查看。⑦ 第 6 节只留产品、业务决定的 10 项 | A76–A126；复核意见（页面与数据模型、约定与跨文档）；`review/xdoc-a06-publish.md`；`review/api-check.md` |
| 2026-10-03 | 第三轮：① 公共结构（A132、C87）：主页截图、合集封面由“`SignedUrl` & `{ fileId }`”改为引用 m08 `ImageRef`，2.1 删去 `SignedUrl` 行、补 `DictRef`；清单补 `externalSchemas`（A140）。② 字典出接口（A133、C85）：`ChannelAccountRow.abnormalReasonCode` + `abnormalReasonLabel` → `abnormalReason`，`PatrolTaskRow.abnormalKindCode` + `abnormalKindLabel` → `abnormalKind`（与 m05 同名），`ChannelAccountEventView.reasonLabel` → `reasons`，`previousDecision.reasons`、`LaunchRoundView.reasons` 写作 `DictRef[]`；请求体的编码字段不变。③ 错误码：`REMINDED_TODAY` 的 `details` 按 A131 定为 `{ scene, nextAvailableDate }`（3.27、3.35、第 5 节）。④ 权限：`publish.link.verify_revoke`、`publish.metrics.enter` 按 A129 进增补表，清单 `permissionsSuggested` 改为 `permissionSupplements`（加 `pool`、`confirm` 列），V1.1 的 4 条写接口在切片与清单里填上权限点。⑤ 定时器键 `patrol.followup:patrol_task:{patrolTaskId}` 已登记（A144，01-kernel-flow.md:606），3.25 去掉“待回写”。⑥ 1.1 补“审批决定的守卫顺序”（同 a03 1.1；本文的驳回不登记 C86 的 `x-step-up: skip`），3.6、3.7、3.17、3.18 引用；3.5 写明队列卡片处理人取 a01 `ApprovalItem.handler`（`launch_link`）或 `decidedBy`、工单取 `deliveryTicketId`；`LaunchTrackItem.followUps` 注明 a03 跟进接口为 `assert-in-handler`。⑦ a05 的请求：`last30Days` 按 `delivery.order_item.reschedule_launch` 审计行的 `meta.prevDate` 还原改期前日期；`completeness` 与 a05 `publishList.isComplete`、推送守卫 `publish_list_incomplete` 共用一个判定函数；3.12 注明推送时的预打包调同一个 `media.ensureZip` | A127–A150；C85–C87；`review/r3-in-a06-publish.md` |
| 2026-10-03 | 第四轮：① 单值字典（A151、C85）：`DeliveryReleaseDetail` 随 a05 `ReleaseAdminView` 把 `reasonCode` 改为 `reason`（`DictRef` \| null），删去 `reasonLabel`；2.1 的 `AdminStoreBrief` 形状按 a05 改为 `city`、`district`（`DictRef` \| null）；本文其余字典字段第三轮已是 `DictRef`，请求体的编码字段不变。② 主页截图、合集封面引用 m08 `ImageRef`（m08 的请求）第三轮已改；2.1 表格合并错行拆开 | A151；C85、C87；`review/r4-in-a06-publish.md` |
