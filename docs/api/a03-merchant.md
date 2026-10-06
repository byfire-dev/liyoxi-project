# 后台：商家、资质审核与素材复核

| 项 | 内容 |
| --- | --- |
| 范围 | 商家列表（A:Merchants；A:Service 的门店远程搜索下拉复用）；商家详情（A:MerchantDetail）的页头、档案、门店素材、资质、门店与成员、跟进记录（V1.1 页签）、操作日志七个页签，以及代改档案、整理素材、发起素材需求、转移交付经理四个弹层与首次指派交付经理（原型无入口，A91）；资质审核的详情与决定（A:Review，队列与计数归 a01 的 `admin.approval.*`）；账号变更申请（换绑手机号、老板更换、老板复核，原型无，在商家详情发起、在“我的待审批”处理，A16）；续费、逾期、上线日历页的跟进记录（A:Renewals、A:Overdue、A:Calendar 的时间线与记录弹层）；渠道码登记（原型无）；渠道管理（A:Partners、A:PartnerReview、A:PartnerBinding、A:PartnerLevels、A:PartnerSettle、A:FinSettle，V1.1，只列接口） |
| 接口数 | 72（V1.0 49，V1.1 23）。第二轮按 A91 补 `admin.store.assignDeliveryManager`（3.8a）；第三轮按 A136 把转移交付经理改名为 `admin.store.reassignDeliveryManager`（3.8） |
| 依据 | 数据模型 02（`merchant_user`、`wechat_identity`、`user_session`、`portal_session`、`wecom_contact`、`account_change_request`、`entity`、`store`、`entity_member`、`store_member`、`invitation`、`referral_code`）、03（`staff`、`assignment_history`、`follow_up`、`audit_log`、`approval_request`）、04（`store_profile`、`store_profile_media`、`store_service_item`、`qualification_submission`、`qualification_doc`）、06（`store_asset` 等六张素材表、`file_object`、`file_ref`、`media_info`、`media_job`、`ocr_result`）、01（`status_transition`、`outbox_event`、`timer`）；读侧另取 07（`billing_account`、`subscription_term`、`point_adjustment_request`）、08（`billing_order`）、09（`drama_order`、`order_item`、`ad`、`point_hold`）、10（`delivery_ticket`）、12（`service_ticket`）、14（`dict_item`）的列。草案 d4 第 3.5、3.6、4.6、4.7、7.1、7.5、7.6 节与附录 A、B；d9 第 5.4–5.7、6.4、7.2 节；d5 第 9.3、9.4 节；d3 第 17、24 节。原型调研 proto-admin-b 第 1–3、7 节，proto-admin-a 逾期跟踪一节。裁决 A1–A146（第二轮按第十节 A76–A120 修订，第三轮按第十二节 A127–A146 修订）；约定 C1–C87；事件名以 x01-events-jobs 的事件目录为准（A95）；员工摘要 `StaffBrief` 引用 a01-system 2.2 |

## 1. 概览

本文是运营管理后台“商家管理”菜单的接口：按门店检索商家、看商家详情、代改档案、首次指派与转移交付经理；主体与成员只读，另有禁用账号、强制下线、主体额度覆盖、后台关闭主体几个账号与租户动作；客服发起、主管审批的账号变更申请；资质审核的详情、修正字段、通过与驳回；门店素材的复核、代传、肖像授权确认、重新识别与软删除；素材需求；跟进记录；渠道码登记。资质审核与账号变更都走统一审批单 `approval_request`，按 A14 决定接口挂在各自的领域资源上；跨类型的审批队列、计数与“我的待审批”只读列表归 a01（`admin.approval.list`、`admin.approval.summary`、`admin.approval.get`），本文不重复。审批类的通用错误码（审批段 48200–48299）在本文定义，其他文档的审批决定接口直接引用。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `admin.store.list` | `GET /admin/stores` | 商家（门店）列表 | staff；商家管理查看 + 门店范围 | none（查询） |
| `admin.store.summary` | `GET /admin/stores/summary` | 列表页头统计 | staff；商家管理查看 + 门店范围 | none（查询） |
| `admin.store.get` | `GET /admin/stores/{storeId}` | 商家详情页头与 KPI | staff；商家管理查看 + 门店范围 | none（查询） |
| `admin.store.activity.list` | `GET /admin/stores/{storeId}/activities` | 操作日志页签（门店活动流） | staff；商家管理查看 + 门店范围 | none（查询） |
| `admin.store.profile.get` | `GET /admin/stores/{storeId}/profile` | 档案页签 | staff；商家管理查看 + 门店范围 | none（查询） |
| `admin.store.profile.update` | `PATCH /admin/stores/{storeId}/profile` | 代改档案（免审字段） | staff；`merchant.profile.proxy_edit` | required |
| `admin.store.qualification.get` | `GET /admin/stores/{storeId}/qualification` | 资质页签 | staff；商家管理查看 + 门店范围 | none（查询） |
| `admin.store.reassignDeliveryManager` | `POST /admin/stores/{storeId}/reassign-delivery-manager` | 转移交付经理（A136 改名） | staff；`merchant.manager.transfer`（仅主管） | required |
| `admin.store.assignDeliveryManager` | `POST /admin/stores/{storeId}/assign-delivery-manager` | 首次指派交付经理（门店还没有交付经理，A91） | staff；`merchant.manager.assign`（仅主管，含待分配池） | required |
| `admin.assignmentHistory.markContacted` | `POST /admin/assignment-histories/{assignmentHistoryId}/mark-contacted` | 新交付经理标记已联系商家 | staff；assert-in-handler（被分配人本人或其主管） | required |
| `admin.entity.get` | `GET /admin/entities/{entityId}` | 主体卡片与名下门店 | staff；商家管理查看 + 主体范围 | none（查询） |
| `admin.entity.member.list` | `GET /admin/entities/{entityId}/members` | 主体成员（只读；待接受邀请随 3.10 主体卡片返回） | staff；商家管理查看 + 主体范围 | none（查询） |
| `admin.entity.quota.update` | `PATCH /admin/entities/{entityId}/quota` | 门店数、成员数上限覆盖 | staff；`merchant.quota.override`（仅超级管理员） | required |
| `admin.entity.close` | `POST /admin/entities/{entityId}/close` | 后台关闭经营主体 | staff；`merchant.entity.close`（增补，仅超级管理员） | required |
| `admin.merchantUser.disable` | `POST /admin/merchant-users/{merchantUserId}/disable` | 禁用商家账号 | staff；`merchant.user.disable`（仅主管） | required |
| `admin.merchantUser.enable` | `POST /admin/merchant-users/{merchantUserId}/enable` | 启用商家账号 | staff；`merchant.user.disable`（仅主管） | required |
| `admin.merchantUser.forceLogout` | `POST /admin/merchant-users/{merchantUserId}/force-logout` | 强制下线 | staff；`merchant.user.force_logout` | required |
| `admin.accountChangeRequest.list` | `GET /admin/account-change-requests` | 账号变更申请列表 | staff；商家管理查看 + 主体范围 | none（查询） |
| `admin.accountChangeRequest.create` | `POST /admin/account-change-requests` | 发起换绑手机号、老板更换、老板复核 | staff；`merchant.account_change.request` | required |
| `admin.accountChangeRequest.get` | `GET /admin/account-change-requests/{accountChangeRequestId}` | 申请详情 | staff；商家管理查看 + 主体范围 | none（查询） |
| `admin.accountChangeRequest.approve` | `POST /admin/account-change-requests/{accountChangeRequestId}/approve` | 通过并同事务生效 | staff；`merchant.account_change.approve`（仅主管） | required |
| `admin.accountChangeRequest.reject` | `POST /admin/account-change-requests/{accountChangeRequestId}/reject` | 驳回 | staff；`merchant.account_change.approve`（仅主管） | required |
| `admin.accountChangeRequest.withdraw` | `POST /admin/account-change-requests/{accountChangeRequestId}/withdraw` | 撤回 | staff；assert-in-handler（提交人本人；发起人已停用时由审批权持有人代撤） | required |
| `admin.qualificationSubmission.get` | `GET /admin/qualification-submissions/{qualificationSubmissionId}` | 资质审核详情（审核页右栏） | staff；商家管理查看 + 门店范围 | none（查询） |
| `admin.qualificationDoc.update` | `PATCH /admin/qualification-docs/{qualificationDocId}` | 修正识别字段并重跑比对 | staff；`merchant.qualification.review` | required |
| `admin.qualificationSubmission.rejectQuote` | `POST /admin/qualification-submissions/{qualificationSubmissionId}/reject-quote` | 终局驳回的影响预览 | staff；`merchant.qualification.review` | none（试算） |
| `admin.qualificationSubmission.approve` | `POST /admin/qualification-submissions/{qualificationSubmissionId}/approve` | 资质审核通过 | staff；`merchant.qualification.review`（放行另需 `.override`） | required |
| `admin.qualificationSubmission.reject` | `POST /admin/qualification-submissions/{qualificationSubmissionId}/reject` | 驳回（可终局） | staff；`merchant.qualification.review` | required |
| `admin.storeAsset.list` | `GET /admin/store-assets` | 门店素材列表 | staff；商家管理查看 + 门店范围 | none（查询） |
| `admin.storeAsset.summary` | `GET /admin/store-assets/summary` | 素材计数 | staff；商家管理查看 + 门店范围 | none（查询） |
| `admin.storeAsset.get` | `GET /admin/store-assets/{storeAssetId}` | 素材详情 | staff；商家管理查看 + 门店范围 | none（查询） |
| `admin.storeAsset.create` | `POST /admin/store-assets` | 员工代商家上传素材 | staff；`merchant.asset.upload_on_behalf`（增补） | required |
| `admin.storeAsset.review` | `POST /admin/store-assets/{storeAssetId}/review` | 整理（复核）素材 | staff；`merchant.asset.review` | required |
| `admin.storeAsset.confirmPortraitAuth` | `POST /admin/store-assets/{storeAssetId}/confirm-portrait-auth` | 确认肖像授权齐全 | staff；`merchant.asset.review` | required |
| `admin.storeAsset.portraitAuth.create` | `POST /admin/store-assets/{storeAssetId}/portrait-auth` | 代商家补交肖像授权材料 | staff；`merchant.asset.upload_on_behalf`（增补） | required |
| `admin.storeAsset.reprocess` | `POST /admin/store-assets/{storeAssetId}/reprocess` | 重新识别 | staff；`merchant.asset.review` | required |
| `admin.storeAsset.delete` | `POST /admin/store-assets/{storeAssetId}/delete` | 软删除素材 | staff；`merchant.asset.review` | required |
| `admin.assetDemand.list` | `GET /admin/asset-demands` | 素材需求列表 | staff；商家管理查看 + 门店范围 | none（查询） |
| `admin.assetDemand.create` | `POST /admin/asset-demands` | 发起素材需求 | staff；`merchant.asset.demand.create` | required |
| `admin.assetDemand.complete` | `POST /admin/asset-demands/{assetDemandId}/complete` | 标记需求完成 | staff；`merchant.asset.demand.create` | required |
| `admin.assetDemand.cancel` | `POST /admin/asset-demands/{assetDemandId}/cancel` | 撤销需求 | staff；`merchant.asset.demand.create` | required |
| `admin.followUp.list` | `GET /admin/follow-ups` | 跟进记录时间线 | staff；assert-in-handler（对象所在模块查看 + 范围） | none（查询） |
| `admin.followUp.create` | `POST /admin/follow-ups` | 记录跟进 | staff；assert-in-handler（对象所在模块查看 + 范围） | required |
| `admin.followUp.summary` | `GET /admin/follow-ups/summary` | 跟进记录计数（V1.1，细节待设计） | staff；assert-in-handler（同 3.41） | none（查询） |
| `admin.followUp.update` | `PATCH /admin/follow-ups/{followUpId}` | 改下次跟进时间 | staff；assert-in-handler（负责人或其主管） | required |
| `admin.followUp.complete` | `POST /admin/follow-ups/{followUpId}/complete` | 标记跟进完成 | staff；assert-in-handler（负责人或其主管） | required |
| `admin.referralCode.list` | `GET /admin/referral-codes` | 渠道码与邀请码登记列表 | staff；商家管理查看 | none（查询） |
| `admin.referralCode.create` | `POST /admin/referral-codes` | 登记渠道码 | staff；`merchant.referral_code.manage`（增补） | required |
| `admin.referralCode.disable` | `POST /admin/referral-codes/{referralCodeId}/disable` | 停用 | staff；`merchant.referral_code.manage`（增补） | required |
| `admin.referralCode.enable` | `POST /admin/referral-codes/{referralCodeId}/enable` | 重新启用 | staff；`merchant.referral_code.manage`（增补） | required |
| `admin.partner.list` 等 22 条 | 见 3.50 | 渠道管理（V1.1，细节待设计） | staff；渠道管理查看 / `partner.*` | 查询 none，写 required |

### 1.1 本文通用规则

| 事项 | 规则 |
| --- | --- |
| 模块等级 | 查看类不设权限点（C66）：本文 GET 要求“商家管理”模块等级不为 `n`；跟进记录（3.41、3.45）的模块随对象类型变化，声明 `permission: assert-in-handler`，在处理器里按 3.41 的对照表判定。写接口另要求权限点，并要求该模块等级不为 `n`（d4-identity.md:1226 的 `need: 'view'`）。权限点不足 403 `PERMISSION_DENIED`（C27） |
| 处理器追加判定 | 路由声明一个固定权限点、处理器在取到对象或读到请求体后再追加一个权限点的写法（C66 允许）：3.26 路由键 `merchant.qualification.review`，`mode = override` 时处理器另要求 `merchant.qualification.override`，不满足 403 `PERMISSION_DENIED`。权限整体取决于对象的（撤回 3.22、标记已联系 3.9、跟进记录 3.41–3.45）声明 `assert-in-handler` 并写判定规则（A45）。处理器取到的权限点若在注册表里标了再验证，由处理器同样校验（C66） |
| 数据范围 | 门店、主体维度的资源按员工的数据范围过滤：`own` 只看 `store.delivery_manager_id` 为本人的门店，`group` 为本组成员负责的门店，`all` 不限；持 `merchant.manager.assign` 或 `merchant.manager.transfer` 的主管另能看到交付经理为空的门店（待分配池 `store_manager`，d4-identity.md:2373）。主体的范围 = 名下任一门店在范围内。范围外与不存在不作区分，一律 404 `NOT_FOUND`（C29、C58） |
| 脱敏 | GET 只返回脱敏值（A19、C40）：手机号、信用代码、证件号、姓名只给 `…Mask`。看明文走 `admin.piiReveal.create`（a01），证照原图、证明材料、肖像授权材料走 `admin.file.downloadUrls`（a01），每次写 access 审计。不需留痕的缩略图、档案图片、素材文件随列表与详情现签（C60、C61：图片与文档 30 分钟对齐窗口，音视频 60 分钟） |
| 回显 | 账号、租户、审批、转移类写请求带 `confirm`（C54），服务端在事务内与当前值比对，不一致 409 `CONFIRM_MISMATCH`。字段逐接口列出。内容编辑类（代改档案、修正识别字段、整理素材）以 `lockVersion` 防过期数据，不另带 `confirm`；素材需求、渠道码、素材删除与首次指派交付经理（状态守卫即可防重复）不带。哪些权限点要求回显，建议在权限点增补表加一列（主负责人统一） |
| 再验证 | 以权限点注册表为准（A13、C66），接口不另声明。注册表标了再验证的：`merchant.user.disable`、`merchant.quota.override`、`merchant.account_change.approve`；增补键 `merchant.entity.close` 建议标再验证。唯一例外是驳回（A127、C86）：账号变更的驳回（3.21）声明路由级元数据 `x-step-up: skip`，不检查再验证（03-staff-authz-audit.md:806“不要求 step-up”）；本文其他驳回接口（资质驳回 3.27）的权限点注册表没有标再验证，无需豁免。超出 10 分钟窗口 403 `STEP_UP_REQUIRED`，前端经 `admin.auth.stepUp` 后用同一幂等键重放 |
| 审批决定的守卫顺序 | 按中间件顺序（C7；d4-identity.md:1360-1364）：路由级的模块等级、权限点与“仅主管” 403 `PERMISSION_DENIED` → 再验证 403 `STEP_UP_REQUIRED`（声明 `x-step-up: skip` 的驳回跳过，C86） → 服务层取对象（范围外 404）→ 审批单不是 `pending` 409 `APPROVAL_NOT_PENDING` → 审批人是发起人 403 `APPROVAL_SELF_FORBIDDEN` → 处理器追加的权限判定（放行 `override`、代撤）403 → `lockVersion`（只在守卫列了锁版本的迁移）409 `VERSION_CONFLICT` → `confirm` 409 `CONFIRM_MISMATCH` → 事务内重算业务前提，变了回滚并 409 `PRECONDITION_CHANGED`，审批单保持 `pending`（d4-identity.md:1398-1412；03-staff-authz-audit.md:805）。a05、a06、a07 的决定与撤回接口沿用本顺序 |
| 留痕 | 每次状态迁移在 `audit_log` 恰好一行（M31）：审核类审批单（`category = 'review'`）的迁移写 `activity` 流，员工发起的审批（`category = 'approval'`）写 `ops` 流（03-staff-authz-audit.md:640）。账号安全（禁用、启用、强制下线、换绑、老板更换）写 `ops` 流、类别 `account_security`；代改档案写 `ops` 流、类别 `profile_edit`，带 `on_behalf_of_entity_id`；首次指派与转移交付经理写 `ops` 流、类别 `manager_assign`；主体额度覆盖、主体关闭、渠道码登记分别用类别 `merchant_quota`、`merchant_lifecycle`、`referral_code`（A107 登记）；素材、素材需求、跟进记录写 `activity` 流。原因写 `audit_log.reason_code`、`reason_text`，变更前后值写 `before`、`after`（敏感字段脱敏） |
| 分页 | 后台列表用页码：`page`（从 1）、`pageSize`（默认 20，上限 100），响应 `{ items, page, pageSize, total }`（C43），结构引用 a01 的 `AdminPage<T>`（C87，本文不再为每个列表另起 `…Page` 结构）。门店活动流读 `audit_log`（只增大表），用游标并返回 `totalApprox`（A22），结构引用 a01 的 `AdminCursorPage<T>`。主体成员列表 `admin.entity.member.list` 是登记过的有界小集合，不分页，响应 `{ items }`（A78、C43） |
| 文件引用 | 请求里的 `fileId` 由员工经 `admin.file.create`（a01）登记、已入库（`file_object.status = 'stored'`）、未被拦截、分类符合用途；代商家上传的文件带代传门店（`file_object.on_behalf_store_id` = 目标门店）。不满足 400 `FILE_NOT_USABLE`（m03 定义；`details.reason` 是 m03 第 5 节的开放枚举 `FileNotUsableReason`，前端按值对号、未知值兜底）。登记与签发的权限按 a01 2.17 的后台文件分类授权矩阵：`profile_image`、`profile_video`、`profile_promo` 登记要 `merchant.profile.proxy_edit`；`store_asset`、`portrait_auth` 登记要 `merchant.asset.upload_on_behalf`，`portrait_auth` 签发要 `merchant.asset.review` 或 `merchant.asset.upload_on_behalf`；`account_proof` 登记要 `merchant.account_change.request`，签发要 `merchant.account_change.request` 或 `merchant.account_change.approve`；证照原图（`kyc_license`、`kyc_permit`）签发要 `merchant.qualification.review` 或 `pii.license.view`。`secure` 桶的分类每次签发写 access 审计 |
| 加锁顺序 | 员工行 `FOR SHARE`（20）→ 审批单（30）→ 账号变更申请（40）/ 资质轮次（65）→ 商家账号（80）→ 主体（100）→ 邀请（110）→ 成员关系（120）→ 门店（130）→ 档案行（135）→ 素材行（370）（02-identity-tenant.md 各表；03-staff-authz-audit.md:143、724；04-profile.md:666；06-media.md:1105） |
| 已停用门店 | 读接口照常。给门店新增内容的写接口（代改档案、代传素材、发起素材需求）对 `store.lifecycle = 'archived'` 的门店返回 409 `STATE_NOT_ALLOWED`（`details.reason = 'store_archived'`）；处理存量的动作（整理、确认授权、删除素材，结束素材需求）、首次指派与转移交付经理、跟进记录照常（停用门店仍可能有服务中的工单） |
| 开放枚举 | 响应里的状态、类型类枚举标 `x-open-enum`（C37），前端对未知值兜底展示 |
| 可执行动作 | 列表与详情带 `actions: string[]`（C16），按当前员工的权限点、数据范围与对象状态算出；前端只据此显示按钮 |

### 1.2 路由注册顺序

字面段先于同层的参数段注册（A8）：`/admin/stores/summary` 先于 `/admin/stores/{storeId}`；`/admin/store-assets/summary` 先于 `/admin/store-assets/{storeAssetId}`；`/admin/follow-ups/summary` 先于 `/admin/follow-ups/{followUpId}`；V1.1 的 `/admin/commission-statements/summary` 先于 `/admin/commission-statements/{commissionStatementId}`。

## 2. 公共结构

类型写法按写作规范：`string(uuid)`、`integer(分)`、`integer(积分)`、`string(date-time)`、`string(date)`；可空写 `| null`。响应里契约声明的键总是出现（C38）。

### 2.1 小结构

**StaffBrief**（员工）：引用 a01-system 2.2 的 `StaffBrief`（`staffId`、`staffNo`、`name`、`roleKey`、`isLead`、`status`），契约里全仓只有这一份，本文不另定义（第二轮按 a01 的请求删去本文的同名结构）。“是否启用”看 `status = 'active'`；前端按 `roleKey` 显示“交付经理”等岗位名。

**MerchantUserBrief**（商家账号）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| merchantUserId | string(uuid) | 是 | 账号 | `merchant_user.id` |
| displayName | string \| null | 是 | 称呼；优先取在本主体的成员称呼 | `entity_member.display_name`，没有时 `merchant_user.display_name` |
| phoneMask | string \| null | 是 | 登录手机号脱敏串；已注销为空 | `merchant_user.phone_mask` |
| status | enum(同数据模型 `merchant_user.status`) | 是 | 正常、后台禁用、已注销 | `merchant_user.status` |

**DictRef**：`{ code: string, name: string }`，字典项的响应形态（C85、C87），本文引用不另定义（第三轮把本文的 `DictLabel { code, label }` 改为它）。`name` 取 `dict_item.name`（按 `dict_item.dict_type_key` 与 `dict_item.code` 查；停用项仍返回名称）。

**SignedUrl**：引用 a01 的 `SignedUrl { url, expiresAt }`（C87：`url` 不可空，整个对象可空），本文不另定义。

**ApprovalDecisionView**（审批单的决定信息；资质审核与账号变更共用）：引用 a01 2.10 的 `ApprovalDecisionView`（`approvalId`、`kind`、`status`、`roundNo`、`submittedAt`、`dueAt`、`badges`、`requester`、`decidedBy`、`isDecidedBySystem`、`decidedAt`、`decisionNote`、`reasons`（`[{ code, name }]`）、`lockVersion`、`actions`），第三轮按 a01 的请求删去本文的 `ApprovalBrief`。超时看 `badges` 里的 `overdue`（口径含“无时限按 `approval.escalate_workdays`”，A93），不另设 `isOverdue`。原 `ApprovalBrief` 里 `ApprovalDecisionView` 没有的两个字段移到领域结构上：单号 `requestNo`（AccountChangeRequestCard，账号变更 `ZH…`）与决定时勾选的核对项 `confirmChecks`（AccountChangeRequestDetail、QualificationSubmissionDetail）。`lockVersion` 是审批单的乐观锁（通过时回传）；资质轮次的锁版本另见 QualificationSubmissionDetail.lockVersion，两者不要混用。

**AddressView**、**BusinessHourSlot**、**Completeness**、**MediaFileView**、**ProfileMediaItem**、**ServiceItem**、**PendingChange**、**AssetTag**：结构同 m03-profile-asset 第 2.1–2.5 节（引用，本文不另定义），后台视图不裁剪；出现手机号的字段只给脱敏串。随 m03 第二轮的改动一并生效：`Completeness.steps[].missing` 为 `array<MissingItem{ item: MissingItemKey, permitType }>`（`MissingItemKey` 用值 `permit`，不再带模板值）；`PendingChange` 带 `lockVersion`。

### 2.2 商家列表：StoreRow、StoreListQuery、StoreListSummary

**StoreListQuery**（列表、页头统计与导出共用的筛选；导出键 `stores.list`（a02 导出登记表）的 `params` 与之同构，去掉 `page`、`pageSize`，C46）

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| q | string | 否 | 1–30 字 | 门店名称、主体名称模糊匹配（`store.name`、`entity.name`） |
| regionCode | string | 否 | 字典 `region` 的编码 | 选省、市、区县按 `store_profile.province_code`、`city_code`、`district_code` 匹配；选功能区（`F` 前缀）按 `store_profile.zone_code`（d9-profile.md:788） |
| industryCode | string | 否 | 字典 `industry` 一级 | `store_profile.industry_code` |
| categoryCode | string | 否 | 同一字典二级 | `store_profile.category_code` |
| qualificationStatus | string | 否 | 逗号分隔，取值同 `store.qualification_status` | 审核状态 |
| sourceType | string | 否 | 逗号分隔，取值同 `entity.source_type` | 来源（自然流量、销售、活动、服务商） |
| deliveryManagerId | string(uuid) | 否 | — | 交付经理 `store.delivery_manager_id` |
| isManagerUnassigned | boolean | 否 | 与 `deliveryManagerId` 互斥 | `true` 只看交付经理为空的门店（“未分配”） |
| subscriptionStatus | string | 否 | 逗号分隔，`none`、`active`、`expired` | 套餐状态（“未开通”“已过期”）；按主体现算 |
| planId | string(uuid) | 否 | — | 套餐版本：生效中周期的 `subscription_term.plan_id` |
| expiresWithinDays | integer | 否 | 7 或 30 | 生效中且 `subscription_term.end_date` 距今不超过 N 天 |
| entityId | string(uuid) | 否 | — | 只看某主体名下门店（“同主体 N 家门店”） |
| lifecycle | string | 否 | `active`、`archived`，默认 `active` | `store.lifecycle` |
| sort | enum `StoreListSort` | 否 | 默认 `-lastOrderAt` | 按最近订购、注册时间、累计实付倒序（C44；服务端追加 `id`） |
| page、pageSize | integer | 否 | 同 C43 | 页码分页 |

M1（W1-08b）：筛选仅开放 q、regionCode、industryCode、categoryCode、qualificationStatus、deliveryManagerId/isManagerUnassigned、entityId、lifecycle；排序只收 registeredAt 或 -registeredAt，缺省 -registeredAt，追加 id。来源、套餐与到期筛选及其他排序400 VALIDATION_FAILED；跨层字段经 profile.admin_facts 的拥有者键取数，未注册按字段 none/0/null。列表非首店 totalPaidFen 为空，详情 paid 仍为主体合计。完整模式的 -createdAt 与 registeredAt 的命名差异在回补时统一。

**StoreRow**

| 字段 | 类型 | 必有 | 说明 | 来源（表.列 或计算规则） |
| --- | --- | --- | --- | --- |
| storeId | string(uuid) | 是 | 门店 | `store.id` |
| name | string \| null | 是 | 门店名称；首家门店未填时为空 | `store.name` |
| isPrimary | boolean | 是 | 首家门店 | `store.is_primary` |
| lifecycle | enum(同数据模型 `store.lifecycle`) | 是 | 启用、已停用 | `store.lifecycle` |
| entity | `{ entityId, name, activeStoreCount, primaryStoreName }` | 是 | 所属主体、名下启用门店数（“XX 餐饮管理有限公司 · 2 家店”）与首家门店名称（非首家门店的套餐副文案“与万达店共用”，Merchants.dc.html:173；`primaryStoreName` 为 string \| null，本行就是首家门店时前端不用它） | `entity.id`、`entity.name`；`store` 中 `entity_id` 相同、`lifecycle = 'active'` 计数；同主体 `store.is_primary = true` 那家的 `store.name` |
| region | `{ province, city, district, zone }`，各为 DictRef \| null | 是 | 区域（字典 `region`；C85、A151，第四轮由 `regionCodes { provinceCode, cityCode, districtCode, zoneCode }` 改名） | `store_profile` 的 `province_code`、`city_code`、`district_code`、`zone_code` + 字典名称 |
| industry | DictRef \| null | 是 | 一级行业（字典 `industry`；第四轮由 `industryCode` 改名） | `store_profile.industry_code` + 字典名称 |
| category | DictRef \| null | 是 | 二级品类（同一字典二级；第四轮由 `categoryCode` 改名） | `store_profile.category_code` + 字典名称 |
| qualificationStatus | enum(同数据模型 `store.qualification_status`) | 是 | 审核状态 | `store.qualification_status` |
| sourceType | enum(同数据模型 `entity.source_type`) | 是 | 来源 | `entity.source_type` |
| deliveryManager | StaffBrief \| null | 是 | 交付经理；为空即“未分配” | `store.delivery_manager_id` |
| subscription | SubscriptionBrief | 是 | 套餐（主体共用） | 见下 |
| points | `{ spendablePoints, planAvailablePoints, addonAvailablePoints, heldPoints, isAddonSuspended }`，前四项 integer(积分) | 是 | 可用积分与副文案（“含加购 N”“冻结 N”“加购 N 已冻结”）；字段名按 C32 带 `Points` 后缀（第三轮按 m07 的请求改名） | 同 m07-billing 2.7 `Wallet.points` 的同名字段，经 `billing.getWalletView` 取（m07 第 1 节）：`billing_account.plan_available_qty`、`addon_available_qty`、`held_total_qty`；`spendablePoints` 在非生效中或退款处理中（主体级口径，m07 2.0）为 0 |
| totalPaidFen | integer(分) \| null | 是 | 累计实付，按主体合计、只在首家门店给出，其余门店为空（显示“—”，proto-admin-b.md:31） | `billing_order` 中本主体 `status` 为 `paid`、`refunded` 的 `paid_amount_fen` 之和减 `refunded_amount_fen` 之和 |
| lastOrderAt | string(date-time) \| null | 是 | 最近订购 | 本门店 `drama_order.submitted_at` 的最大值 |
| registeredAt | string(date-time) | 是 | 注册（门店创建）时间 | `store.created_at` |
| actions | array<string> | 是 | 取 `reassign-delivery-manager`（持 `merchant.manager.transfer` 且门店有交付经理；A136 随路径改名）、`assign-delivery-manager`（持 `merchant.manager.assign` 且门店没有交付经理） | C16 |

SubscriptionBrief（主体维度，口径同 m07-billing 2.7，现算不读缓存）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| status | enum `SubscriptionStatus`（同 m07） | 是 | `none`、`active`、`expired` | 按周期起止现算，取值同 `billing_account.sub_status` |
| plan | `{ planId, code, name }` \| null | 是 | 生效中取当前周期版本，已过期取最近周期版本 | `subscription_term.plan_id` → `plan.code`、`plan.name` |
| months | integer \| null | 是 | 购买周期（月付、季付） | `subscription_term.months` |
| startDate | string(date) \| null | 是 | 本期起 | `subscription_term.start_date` |
| endDate | string(date) \| null | 是 | 本期止（“10-12 到期”“09-25 到期未续费”） | `subscription_term.end_date` |
| hasScheduledTerm | boolean | 是 | 已续费（有预约周期） | 本主体有 `subscription_term.status = 'scheduled'` 的行 |
| isRefundPending | boolean | 是 | 套餐退款处理中（主体级：预约周期被标记也算） | 同 m07-billing 2.0“退款处理中”：本主体任一 `status` 为 `scheduled` 或 `active` 的 `subscription_term.refund_request_id` 非空 |
| latestPaymentOrder | `{ paymentOrderId, orderNo, type, status, title, refundedAt }` \| null | 是 | 未开通时显示最近一张付款单的进度（“旗舰版 3 个月待确认收款”“09-13 已全额退款”）；`status = 'active'` 时为空 | 本主体最近创建的 `billing_order`：`id`、`order_no`、`type`、`status`、`refunded_at`；`title` 按 m07-billing 2.5 `PaymentOrderCard.title` 的规则渲染 |

**StoreListSummary**（页头“共 486 家 · 付费 213 家（套餐生效 186 家）· 审核中 4 家 · 本月新增 97 家”）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| total | integer | 是 | 门店数 | 套用同一筛选的 `store` 计数 |
| paidCount | integer | 是 | 付费门店数：所属主体有过已支付的付款单 | 主体存在 `billing_order.status = 'paid'` 的门店计数（口径见第 6 节第 1 项） |
| activePlanCount | integer | 是 | 套餐生效的门店数 | 所属主体订阅现算为 `active` |
| pendingReviewCount | integer | 是 | 审核中 | `store.qualification_status = 'pending'` |
| newThisMonthCount | integer | 是 | 本月新增（北京时间自然月） | `store.created_at` 落在本月 |

### 2.3 StoreHeader（商家详情页头）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| storeId | string(uuid) | 是 | 门店 | `store.id` |
| name | string \| null | 是 | 门店名称 | `store.name` |
| isPrimary | boolean | 是 | 首家门店 | `store.is_primary` |
| lifecycle | enum(同数据模型 `store.lifecycle`) | 是 | 启用、已停用 | `store.lifecycle` |
| archiveReason | enum(同数据模型 `store.archive_reason`) \| null | 是 | 停用原因 | `store.archive_reason` |
| archivedAt | string(date-time) \| null | 是 | 停用时间 | `store.archived_at` |
| qualificationStatus | enum(同数据模型 `store.qualification_status`) | 是 | 标签“资质已通过” | `store.qualification_status` |
| isChangeInReview | boolean | 是 | 变更审核中 | 有 `kind = 'change'`、已提交未关闭的 `qualification_submission` |
| isFinalRejected | boolean | 是 | 终局驳回 | `store_profile.final_rejected_at` 非空 |
| industry、category | DictRef \| null | 是 | 行业与品类（A151） | `store_profile.industry_code`、`category_code` + 字典名称 |
| region | 同 StoreRow | 是 | 城市与区（“成都市锦江区”） | `store_profile` 的区域四列 + 字典名称 |
| sourceType | enum(同数据模型 `entity.source_type`) | 是 | 来源标签 | `entity.source_type` |
| registeredAt | string(date-time) | 是 | 注册时间 | `store.created_at` |
| entity | `{ entityId, name, verificationStatus, activeStoreCount }` | 是 | 主体（“同主体 2 家门店”） | `entity.id`、`entity.name`、`entity.verification_status`；启用门店计数 |
| contact | `{ name, phoneMask }`，各为 string \| null | 是 | 资质联系人（“王先生 138****5678”） | `store_profile.contact_name`、`store_profile.contact_phone_mask` |
| owner | MerchantUserBrief \| null | 是 | 主体的有效老板 | `entity_member`（`role = 'owner'`、`status = 'active'`）→ `merchant_user` |
| isWecomAdded | boolean | 是 | “企业微信已添加”：老板已加交付经理的企业微信 | `wecom_contact` 中 `merchant_user_id` = 老板、`staff_id` = `store.delivery_manager_id`、`removed_at` 为空的行存在 |
| deliveryManager | StaffBrief \| null | 是 | 交付经理 | `store.delivery_manager_id` |
| managerContact | `{ assignmentHistoryId, contactDueAt, isOverdue }` \| null | 是 | 新交付经理尚未联系商家的提醒 | 本门店 `assignment_history`（`source = 'store_manager'`、`subject_type = 'store'`）中 `contact_due_at` 非空、`contacted_at` 与 `contact_voided_at` 为空的行 |
| managerOpenWork | `{ dramaOrderCount, deliveryTicketProducingCount, deliveryTicketInServiceCount, serviceTicketCount }` | 是 | 转移弹层“5 个在办工单（交付中 2 个、服务中 3 个）将一并移交”；门店没有交付经理时四项都为 0 | 本门店、负责人（`drama_order.delivery_manager_id`、`delivery_ticket.delivery_manager_id`、`service_ticket.owner_staff_id`）等于当前 `store.delivery_manager_id` 的在办事项：`drama_order.status` 不在 `ended`、`cancelled`、`refunded`；`delivery_ticket.step` 不在 `in_service`、`takedown`、`archived`、`terminated`（交付中）与 `step` 为 `in_service`、`takedown`（服务中）；`service_ticket.status` 不在 `resolved`、`closed`。与 3.8 的移交范围、响应 `moved` 同一口径 |
| subscription | SubscriptionBrief | 是 | 当前套餐卡 | 2.2 |
| points | 同 StoreRow.points | 是 | 可用积分卡 | 2.2 |
| pendingPointAdjustment | `{ pointAdjustmentRequestId, requestNo, direction, lotKind, adjustPoints }` \| null | 是 | “调整审批中：＋270 套餐积分” | 本主体审批单 `pending` 的 `point_adjustment_request`：`id`、`direction`、`lot_kind`、`adjust_points`；单号 `approval_request.request_no` |
| paid | `{ totalPaidFen, paidOrderCount, planOrderCount, topupOrderCount }` | 是 | 累计实付卡（“¥13,000.00 · 付款单 3 笔 · 套餐 2 笔、加购 1 笔”） | 本主体 `billing_order`：金额口径同 StoreRow；笔数为 `status = 'paid'` 的单数，按 `type` 是否 `topup` 分 |
| liveDramaCount | integer | 是 | 上线中剧目 | 本门店 `order_item.phase = 'live'` 计数 |
| liveSummary | `{ firstLiveDate: string(date) \| null, latestUsageEndDate: string(date) \| null, usageEndSource: enum(同数据模型 order_item.usage_end_source) \| null }` | 是 | “上线中剧目”卡的副文案（“08-22 上线 · 使用期至授权期结束”，MerchantDetail.dc.html:73）：最早上线日、最晚的使用期止日及其来源（`license` 时前端显示“至授权期结束”）；没有上线中剧目时三项都为空 | 本门店 `order_item.phase = 'live'` 的行：`usage_start_date` 最小值；`usage_end_date` 最大值及该行的 `usage_end_source` |
| deliveringTicketCount | integer | 是 | 交付中工单 | 本门店 `delivery_ticket.step` 不在 `in_service`、`takedown`、`archived`、`terminated` 的计数 |
| nearestAgreedLaunchDate | string(date) \| null | 是 | 最近的约定上线日（“两部剧约定 10-12 上线”） | 本门店 `order_item.phase` 为 `producing`、`to_launch` 的 `agreed_launch_date` 最小值 |
| actions | array<string> | 是 | 取 `reassign-delivery-manager`（门店有交付经理）、`assign-delivery-manager`（门店没有交付经理）、`update-profile`（门店启用中）；动作名按 C12 的 `<动词>-<对象>` 写法 | 按权限点、范围与 `store.lifecycle`（C16） |

页签计数不在本结构（A23）：门店素材 `admin.storeAsset.summary`、渠道账号 `admin.channelAccount.summary`（a06）、订单 `admin.order.summary`（a05）与 `admin.paymentOrder.summary`（a07）、交付工单 `admin.deliveryTicket.summary`（a05）、客服工单 `admin.serviceTicket.summary?storeId=` 的 `counts.all`（a08；页签列表为 `admin.serviceTicket.list?storeId=&tab=all`）、跟进记录 `admin.followUp.summary`（V1.1），都按 `storeId` 筛选。

### 2.4 主体与成员：EntityCard、EntityStoreRow、MemberRow、PendingInvitationRow、MerchantUserStatusView

**EntityCard**（门店与成员页签上方的主体卡片）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| entityId | string(uuid) | 是 | 主体 | `entity.id` |
| name | string \| null | 是 | 营业执照主体名称；认证前为空 | `entity.name` |
| entityType | enum(同数据模型 `entity.entity_type`) \| null | 是 | 企业、个体工商户 | `entity.entity_type` |
| lifecycle | enum(同数据模型 `entity.lifecycle`) | 是 | 正常、已放弃、已关闭 | `entity.lifecycle` |
| closedAt | string(date-time) \| null | 是 | 放弃或关闭时间 | `entity.closed_at` |
| verificationStatus | enum(同数据模型 `entity.verification_status`) | 是 | 认证结论（“已认证”） | `entity.verification_status` |
| usccMask | string \| null | 是 | 信用代码脱敏串 | `entity.uscc_mask` |
| legalRepNameMask | string \| null | 是 | 法定代表人或经营者姓名脱敏串 | `entity.legal_rep_name_mask` |
| verifiedAt | string(date-time) \| null | 是 | 首次认证通过（“06-13 认证通过”） | `entity.verified_at` |
| sourceType | enum(同数据模型 `entity.source_type`) | 是 | 来源 | `entity.source_type` |
| referralCode | `{ referralCodeId, code, label }` \| null | 是 | 归因命中的登记码 | `entity.source_referral_code_id` → `referral_code.code`、`referral_code.label` |
| createdAt | string(date-time) | 是 | 主体创建时间 | `entity.created_at` |
| owner | MerchantUserBrief \| null | 是 | 老板（“王先生 138****5678”）；主体关闭后为空 | 有效老板的成员关系 → `merchant_user` |
| subscription | SubscriptionBrief | 是 | 套餐 | 2.2 |
| usage | 见下 | 是 | 门店与名额 | 见下 |
| spendablePoints | integer(积分) | 是 | 可用积分（名下门店共用） | 同 StoreRow.points.spendablePoints |
| stores | array<EntityStoreRow> | 是 | 名下门店（含已停用），首家门店在前，其余按创建时间 | `store` 中 `entity_id` 为本主体 |
| pendingInvitations | array<PendingInvitationRow> | 是 | 待接受的邀请（成员表下方“待接受 1 个”的行）；从 3.11 移到这里，使成员列表保持 `{ items }`（A78、C43）；前端按 `storeId` 过滤出某一门店的邀请 | `invitation` 中本主体 `status = 'pending'` 且 `expires_at` 晚于现在的行，按创建时间倒序 |
| lockVersion | integer | 是 | 主体乐观锁（额度覆盖用） | `entity.lock_version` |
| actions | array<string> | 是 | 取 `update-quota`、`close`（C12 的 `<动词>-<对象>` 写法） | 按权限点与 `entity.lifecycle = 'active'`（C16） |

usage（名额与额度按 m02-tenant 2.1 的唯一口径，调 `tenant.getQuotaUsage(entityId)` 现算，与新增门店、邀请时的实际拦截同一函数；字段名用 m02 2.1 的，第三轮按 m02、m07 的请求把 `storesMax`、`membersUsed`、`membersMax` 改为 `storeLimit`、`seatsUsed`、`memberLimit`）：
- `storesUsed`（integer）：m02 2.1，启用门店数（草稿门店也算）。
- `storeLimit`（integer）：m02 2.1；有覆盖值取覆盖值，否则订阅生效取当前周期上限，否则取参数 `tenant.default_store_limit`（默认 1）。总有值。
- `seatsUsed`（integer）：m02 2.1，有效店员数 + 待接受且未过期的邀请数，老板不占名额。
- `memberLimit`（integer \| null）：m02 2.1；未生效时取参数 `tenant.default_member_limit`（默认 3）；`null` 只表示不限（旗舰版）。
- `storesOver`、`seatsOver`（integer）：m02 2.1，`max(0, 用量 − 上限)`；`memberLimit` 为空时 `seatsOver = 0`。
- `limitReason`（enum `LimitReason`）：m02 2.1，`plan` 订阅生效、`inactive` 未生效（页面文案“开通或续费后可继续新增”）；有覆盖值时仍按订阅状态给出。
- `storeLimitOverride`、`memberLimitOverride`（integer \| null）：后台额外字段，`entity.store_limit_override`、`member_limit_override`（3.12 覆盖弹层回显用）。
- `pendingInvitationCount`（integer）：`invitation.status = 'pending'` 且 `expires_at` 晚于现在（已含在 `seatsUsed` 里）。
- `activeMemberCount`（integer）：有效成员数（含老板）＝ `entity_member.status = 'active'` 的行数；3.13 关闭主体的回显 `confirm.activeMemberCount` 取它，不要用 `seatsUsed`（口径不同）。
- `isOverLimit`（boolean）：`storesOver > 0` 或 `seatsOver > 0`；额度调低或套餐过期后的允许状态（02-identity-tenant.md:552）。

**EntityStoreRow**（名下门店表）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| storeId | string(uuid) | 是 | 门店 | `store.id` |
| name | string \| null | 是 | 门店名称 | `store.name` |
| isPrimary | boolean | 是 | 首家门店 | `store.is_primary` |
| lifecycle | enum(同数据模型 `store.lifecycle`) | 是 | 启用、已停用 | `store.lifecycle` |
| qualificationStatus | enum(同数据模型 `store.qualification_status`) | 是 | 资质（“资质已通过 06-13 通过”“资质审核中 今天 18:20 截止”） | `store.qualification_status` |
| lastDecidedAt | string(date-time) \| null | 是 | 最近一次审核决定 | `store_profile.last_decided_at` |
| reviewDueAt | string(date-time) \| null | 是 | 在审轮次的决定时限 | 未关闭且已提交的轮次 → `approval_request.due_at` |
| openQualificationSubmissionId | string(uuid) \| null | 是 | 在审轮次（“去审核”跳转） | 同上 `qualification_submission.id` |
| address | `{ city: DictRef \| null, district: DictRef \| null, detail }` | 是 | 地址（A151，第四轮由 `cityCode`、`districtCode` 改名） | `store_profile.city_code`、`district_code`（字典 `region` 取名称）、`address_detail` |
| deliveryManager | StaffBrief \| null | 是 | 交付经理 | `store.delivery_manager_id` |
| liveDramaCount | integer | 是 | 上线中 | `order_item.phase = 'live'` 计数 |
| producingDramaCount | integer | 是 | 交付中（“交付中 2 部”） | `order_item.phase` 为 `pending_start`、`producing`、`to_launch` 的计数 |
| assetCount | integer | 是 | 门店素材（“128 条”） | `store_asset` 中 `deleted_at` 为空的计数 |
| reviewedAssetCount | integer | 是 | 已整理（“已整理 127 条”） | 同上且 `review_state = 'reviewed'` |
| copiedAssetCount | integer | 是 | 由其他门店复制的素材（“12 条 由万达店复制”） | 同上且 `source_store_asset_id` 非空 |
| copiedFromStoreId | string(uuid) \| null | 是 | 复制档案的来源门店（“复制万达店档案”） | `store_profile.copied_from_store_id` |
| clerkCount | integer | 是 | 店员数 | `store_member` 中本门店、对应 `entity_member.status = 'active'` 的计数 |
| createdAt | string(date-time) | 是 | 新增时间（“09-29 新增”） | `store.created_at` |

**MemberRow**（成员表）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| memberId | string(uuid) | 是 | 成员关系 | `entity_member.id` |
| user | MerchantUserBrief | 是 | 账号（称呼、手机号脱敏、账号状态） | `entity_member.merchant_user_id` → `merchant_user` |
| role | enum(同数据模型 `entity_member.role`) | 是 | 老板、店员 | `entity_member.role` |
| status | enum(同数据模型 `entity_member.status`) | 是 | 有效、已移除 | `entity_member.status` |
| storeIds | array<string(uuid)> | 是 | 所属门店；老板为 `[]`，表示全部门店 | `store_member.store_id` |
| joinedAt | string(date-time) | 是 | 加入时间（“09-12 加入”） | `entity_member.created_at` |
| registeredAt | string(date-time) | 是 | 账号注册时间（老板显示“06-12 注册”） | `merchant_user.created_at` |
| removedAt | string(date-time) \| null | 是 | 移除时间 | `entity_member.removed_at` |
| removeReason | enum(同数据模型 `entity_member.remove_reason`) \| null | 是 | 移除原因 | `entity_member.remove_reason` |
| uploadedAssetCount | integer | 是 | 上传素材（“56 条”） | 本主体 `store_asset` 中 `upload_actor_type = 'merchant'`、`upload_actor_id` = 该账号、未删除的计数 |
| adoptedAssetCount | integer | 是 | 其中被采用（“8 条被采用”） | 同上且 `adopted_count > 0` |
| actions | array<string> | 是 | 取 `disable`、`enable`、`force-logout`（作用于账号） | 按权限点与 `merchant_user.status` |

**PendingInvitationRow**（EntityCard.pendingInvitations 的元素）：`invitationId`（`invitation.id`）、`storeId`（`invitation.store_id`）、`remarkName`（`invitation.remark_name`）、`inviterName`（`invitation.inviter_member_id` → `entity_member.display_name`）、`createdAt`（`invitation.created_at`，“09-30 09:40 邀请”）、`expiresAt`（`invitation.expires_at`，“10-01 09:40 前有效”）。只列 `status = 'pending'` 且未过期的。

**MerchantUserStatusView**（账号动作的响应）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| merchantUserId | string(uuid) | 是 | 账号 | `merchant_user.id` |
| status | enum(同数据模型 `merchant_user.status`) | 是 | 动作后的状态 | `merchant_user.status` |
| phoneMask | string \| null | 是 | 手机号脱敏串 | `merchant_user.phone_mask` |
| revokedSessionCount | integer | 是 | 本次吊销的小程序会话数 | 本次带条件 UPDATE 影响的 `user_session` 行数 |
| revokedPortalSessionCount | integer | 是 | 本次吊销的下载页会话数 | 本次影响的 `portal_session` 行数 |
| activeOwnerEntityIds | array<string(uuid)> | 是 | 该账号是有效老板的主体；禁用老板时前端据此提示“该主体将无人可操作”（d4-identity.md:438） | `entity_member`（`role = 'owner'`、`status = 'active'`）的 `entity_id` |

### 2.5 StoreActivityItem（操作日志）

= a01-system 2.11 的 `AuditLogItem` 全部字段（`auditLogId`、`logNo`、`createdAt`、`stream`、`category`、`action`、`summary`、`actor { actorType, actorId, name, role, client }`、`target`、`entityId`、`storeId`），字段名与结构不另起（同一行审计在系统操作日志与门店活动流里同构）；`stream` 在本接口只会是 `ops`、`activity`。a04 请本文改用 a05 的 `ActivityItem`，第三轮未改：门店活动流与 a01 系统操作日志、a02 工作台动态读的是同一类跨对象审计行（含主体级行、`stream`、`category`），a01 `AuditLogItem` 已是三处共用；全仓操作日志行收成一种还是两种并存，由主负责人在公共结构登记表（C87）里定。另加：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| reason | `{ code: string \| null, text: string \| null }` \| null | 是 | 原因（同 a01 `AuditLogDetail.reason`）；两列都空时为 `null` | `audit_log.reason_code`、`reason_text` |
| changedKeys | array<string> | 是 | 变更了哪些字段（值不出列表） | `audit_log.after` 的键 |
| isEntityLevel | boolean | 是 | 主体级事件（在该主体每家门店的活动流里都出现） | `audit_log.store_id` 为空 |

页面显示的“商家”“店员”“系统”“林晓”取 `actor.name` 与 `actor.role`（`audit_log.actor_name`、`actor_role`）。

### 2.6 档案：AdminStoreProfile、ProxyEditBody

**AdminStoreProfile**（档案页签）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| storeId | string(uuid) | 是 | 门店 | `store_profile.store_id` |
| brandName | string \| null | 是 | 品牌名称 | `store_profile.brand_name` |
| logo | MediaFileView \| null | 是 | 品牌 Logo | `store_profile.logo_file_id` |
| storeName | string \| null | 是 | 门店名称（生效值） | `store.name` |
| industry、category | DictRef \| null | 是 | 行业与品类（生效值；A151，第四轮由 `industryCode`、`categoryCode` 改名；代改请求仍禁止 `industryCode`、`categoryCode`） | `store_profile.industry_code`、`category_code` + 字典名称 |
| address | AddressView | 是 | 地址（生效值） | `store_profile` 的地址各列 |
| businessHours | array<BusinessHourSlot> | 是 | 营业时间 | `store_profile.business_hours` |
| storeTel | string \| null | 是 | 联系电话（公开信息） | `store_profile.store_tel` |
| avgSpendFen | integer(分) \| null | 是 | 人均消费 | `store_profile.avg_spend_fen` |
| brandIntro | string \| null | 是 | 品牌简介 | `store_profile.brand_intro` |
| serviceItems | array<ServiceItem> | 是 | 主推服务 | `store_service_item` 中 `removed_at` 为空的行，按 `position` |
| promoText、groupBuyText | string \| null | 是 | 优惠活动、团购信息 | `store_profile.promo_text`、`group_buy_text` |
| sellingPoints | array<DictRef> | 是 | 核心卖点（字典 `store_selling_point`）；响应按 C85 给 `DictRef[]`、字段名不带 `Codes`（第三轮由 `sellingPointCodes` 改名；请求仍收 `sellingPointCodes`） | `store_profile.selling_point_codes` + 字典名称 |
| sellingNote | string \| null | 是 | 卖点补充说明 | `store_profile.selling_note` |
| media | `{ door, interior, product, promo }`，各为 array<ProfileMediaItem> | 是 | 门店图片（“共 13 张 · 门头 2 张”） | `store_profile_media` 中 `removed_at` 为空的行，按 `media_group` 分组、`position` 排序 |
| completeness | Completeness | 是 | 档案完整度 | 单店读取时现算（m03 2.1） |
| pendingChange | PendingChange \| null | 是 | 在审或草稿中的 `change` 轮次待审值（“变更审核中”） | `qualification_submission.proposed_*` |
| copiedFromStoreId | string(uuid) \| null | 是 | 复制来源门店 | `store_profile.copied_from_store_id` |
| lastEditedAt | string(date-time) \| null | 是 | 最近修改（“09-28 14:52 · 商家”） | `store_profile.last_edited_at` |
| lastEditor | `{ actorType, name }` \| null | 是 | 最近修改人；员工代改时 `name` 为员工姓名 | `store_profile.last_edit_actor_type`、`last_edit_actor_id`（员工 → `staff.name`；商家 → 本主体成员称呼） |
| proxyEditableFields | array<string> | 是 | 可代改的字段键（与 ProxyEditBody 的可写键一致，契约常量） | 契约常量 |
| lockVersion | integer | 是 | 档案行乐观锁 | `store_profile.lock_version` |
| actions | array<string> | 是 | 取 `update` | 持 `merchant.profile.proxy_edit`、门店启用中 |

首家门店还没有档案行时按空档案返回（`lockVersion = 0`），与 m03 3.1 一致；GET 不补建行。

**ProxyEditBody**（3.6 的请求体；PATCH 语义：不传 = 不改，传 `null` = 清空，C38）

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| lockVersion | integer | 是 | 等于当前 `store_profile.lock_version` | — |
| reasonCode | enum `ProxyEditReason` | 是 | — | 修改原因 → `audit_log.reason_code` |
| note | string | 否 | ≤60 字 | 备注（“王先生 09-30 通过企业微信委托修改”）→ `audit_log.reason_text` |
| brandName | string \| null | 否 | 2–30 字 | → `store_profile.brand_name` |
| logoFileId | string(uuid) \| null | 否 | 分类 `profile_image`，代传门店为本店 | → `store_profile.logo_file_id` |
| businessHours | array<BusinessHourSlot> | 否 | 至多 4 段，同 m03 3.3 | → `store_profile.business_hours` |
| storeTel | string \| null | 否 | ≤20 字 | → `store_profile.store_tel` |
| avgSpendFen | integer(分) \| null | 否 | ≥0 | → `store_profile.avg_spend_fen` |
| brandIntro | string \| null | 否 | ≤300 字 | → `store_profile.brand_intro` |
| serviceItems | array<ServiceItemInput> | 否 | 0–10 项，规则同 m03 3.7 | → `store_service_item` |
| promoText、groupBuyText | string \| null | 否 | ≤100 字 | → `store_profile.promo_text`、`group_buy_text` |
| sellingPointCodes | array<string> | 否 | 0–5 个，字典 `store_selling_point` | → `store_profile.selling_point_codes` |
| sellingNote | string \| null | 否 | ≤100 字 | → `store_profile.selling_note` |
| mediaGroups | object | 否 | 规则同 m03 3.5 的 `groups`；文件分类 `profile_image`、`profile_video`、`profile_promo`，代传门店为本店 | → `store_profile_media` |
| storeName、industryCode、categoryCode、address、contactName、contactPhone、qualification | — | 禁止 | 契约里声明为禁止键，出现即 400 `FIELD_NOT_PROXY_EDITABLE`，不走 C38 的剥离 | 重审字段、联系人与资质只能由商家提交（d9-profile.md:622） |

### 2.7 资质：AdminQualificationDoc、QualificationRoundRecord、AdminStoreQualificationView、QualificationSubmissionDetail、FinalRejectImpact

**AdminQualificationDoc**（证照行，脱敏视图）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| qualificationDocId | string(uuid) | 是 | 证照行 | `qualification_doc.id` |
| docType | enum(同数据模型 `qualification_doc.doc_type`) | 是 | 营业执照、分支机构营业执照、行业许可证 | `qualification_doc.doc_type` |
| permitType | DictRef \| null | 是 | 许可证类型（字典 `permit_type`；A151，字段名本无 `Code` 后缀，不改名） | `qualification_doc.permit_type` + 字典名称 |
| scope | enum(同数据模型 `qualification_doc.scope`) | 是 | 属主体、属门店 | `qualification_doc.scope` |
| origin | enum(同数据模型 `qualification_doc.origin`) | 是 | 本轮新上传、原样带入 | `qualification_doc.origin` |
| fileId | string(uuid) | 是 | 证照原图；看图走 `admin.file.downloadUrls`（5 分钟，写 access 审计） | `qualification_doc.file_id` |
| ocrStatus | enum `OcrStatus`（同 m03） | 是 | 识别结果 | `ocr_result.status`（经 `qualification_doc.ocr_result_id`）；没有识别结果为 `unavailable` |
| ocrWarnings | array<string> | 是 | 识别告警（翻拍、复印件） | `ocr_result.warnings` 的 `code` |
| holderName | string \| null | 是 | 证照上的主体或经营者名称（明文，非敏感） | `qualification_doc.holder_name` |
| certNoMask | string \| null | 是 | 信用代码或许可证编号脱敏串 | `qualification_doc.cert_no_mask` |
| principalNameMask | string \| null | 是 | 负责人姓名脱敏串（“王**”） | `qualification_doc.principal_name_mask` |
| principalRole | enum(同数据模型 `qualification_doc.principal_role`) \| null | 是 | 法定代表人、经营者、负责人 | `qualification_doc.principal_role` |
| subjectType | enum(同数据模型 `qualification_doc.subject_type`) \| null | 是 | 识别出的主体类型（含分支机构） | `qualification_doc.subject_type` |
| validStartDate、validEndDate | string(date) \| null | 是 | 有效期 | `qualification_doc.valid_start_date`、`valid_end_date` |
| isLongTerm | boolean | 是 | 营业期限长期 | `qualification_doc.is_long_term` |
| expiryState | enum `ExpiryState`（同 m03） | 是 | 已过期、30 天内到期（“到期前 30 天提醒商家更新”） | `valid_end_date` 与北京时间今天比较，节点取参数 `remind.cert_expiry.days` |
| displayFields | array<{ key, label, value }> | 是 | 非敏感字段（住所或经营场所、经营范围、经营项目） | 解密“修正值，否则提交值”后只取非敏感键（04-profile.md:598-607） |
| fieldChecks | array<{ code, field, result }> | 是 | 逐项系统比对（“与档案一致”“格式有效”“已过期”）；`result` 取 `FieldCheckResult` | `qualification_doc.field_checks` |
| isCorrected | boolean | 是 | 审核员修正过字段 | `qualification_doc.reviewed_fields_enc` 非空 |
| verdict | enum(同数据模型 `qualification_doc.verdict`) \| null | 是 | 本轮结论 | `qualification_doc.verdict` |
| isEffective | boolean | 是 | 当前生效证照 | `effective_at` 非空且 `superseded_at` 为空 |
| uploadedAt | string(date-time) | 是 | 上传时间 | `qualification_doc.created_at` |

**QualificationRoundRecord**（审核记录时间线的一轮）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| qualificationSubmissionId | string(uuid) | 是 | 轮次 | `qualification_submission.id` |
| kind | enum(同数据模型 `qualification_submission.kind`) | 是 | 首次、新增门店、变更重审 | `qualification_submission.kind` |
| roundNo | integer | 是 | 轮次号 | `qualification_submission.round_no` |
| isResubmit | boolean | 是 | 重新提交 | `resubmit_of_qualification_submission_id` 非空 |
| submittedAt | string(date-time) | 是 | 提交时间 | `qualification_submission.submitted_at` |
| submittedBy | MerchantUserBrief | 是 | 提交人（老板） | `qualification_submission.submitted_by_user_id` |
| uploadedDocs | array<{ docType, permitType: DictRef \| null }> | 是 | 本轮新上传的证照（“重新上传食品经营许可证”） | 本轮 `origin = 'uploaded'`、未移除的 `qualification_doc` |
| changedFields | array<enum> | 是 | 变更类别 | `qualification_submission.changed_fields` |
| approval | ApprovalDecisionView | 是 | 决定、原因、说明、审批人（“唐悦 驳回（证照模糊）”） | `qualification_submission.approval_request_id` → `approval_request` |
| outcome | enum(同数据模型 `qualification_submission.outcome`) \| null | 是 | 结论；在审为空 | `qualification_submission.outcome` |
| approveMode | enum(同数据模型 `qualification_submission.approve_mode`) \| null | 是 | 直接通过、修正后通过、持权限放行 | `qualification_submission.approve_mode` |
| rejectedDocs | array<{ qualificationDocId, docType, permitType: DictRef \| null }> | 是 | 被点名驳回的证照 | 本轮 `verdict = 'rejected'` 的行 |
| systemRejectCode | enum(同数据模型 `qualification_submission.system_reject_code`) \| null | 是 | 系统驳回原因 | `qualification_submission.system_reject_code` |
| finalRejectedAt | string(date-time) \| null | 是 | 终局驳回时间 | `qualification_submission.final_rejected_at` |

**AdminStoreQualificationView**（资质页签）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| storeId | string(uuid) | 是 | 门店 | `store.id` |
| qualificationStatus | enum(同数据模型 `store.qualification_status`) | 是 | 门店资质结论 | `store.qualification_status` |
| isChangeInReview | boolean | 是 | 变更审核中 | 同 StoreHeader |
| isFinalRejected | boolean | 是 | 终局驳回 | `store_profile.final_rejected_at` 非空 |
| firstSubmittedAt、firstVerifiedAt、lastDecidedAt | string(date-time) \| null | 是 | 首次提交、首次通过、最近决定（结论摘要“商家于 06-12 19:22 首次提交……10:40 审核通过”由前端按轮次记录拼出） | `store_profile.first_submitted_at`、`first_verified_at`、`last_decided_at` |
| entity | `{ entityId, name, entityType, verificationStatus, usccMask, legalRepNameMask, verifiedAt }` | 是 | 经营主体 | `entity` 同名列 |
| effectiveDocs | array<AdminQualificationDoc> | 是 | 生效证照：本店门店级生效行与主体生效营业执照 | `qualification_doc` 中 `effective_at` 非空、`superseded_at` 为空 |
| openRound | `{ qualificationSubmissionId, kind, roundNo, submittedAt, dueAt }` \| null | 是 | 在审轮次（“去审核”） | 已提交、未关闭的轮次；`dueAt` 取 `approval_request.due_at` |
| rounds | array<QualificationRoundRecord> | 是 | 历次审核记录，按提交时间倒序；草稿与丢弃的不出现 | `qualification_submission` 中 `submitted_at` 非空的行 |

**QualificationSubmissionDetail**（审核页右栏；3.23 的响应，3.24、3.26、3.27 也返回它）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| qualificationSubmissionId | string(uuid) | 是 | 轮次 | `qualification_submission.id` |
| kind | enum(同数据模型 `qualification_submission.kind`) | 是 | 首次提交、新增门店、变更重审 | `qualification_submission.kind` |
| roundNo | integer \| null | 是 | 轮次号 | `qualification_submission.round_no` |
| isResubmit | boolean | 是 | 重新提交 | `resubmit_of_qualification_submission_id` 非空 |
| claimedEntityType | enum(同数据模型 `qualification_submission.claimed_entity_type`) \| null | 是 | 所选主体类型（“企业”“个体工商户”） | `qualification_submission.claimed_entity_type` |
| approval | ApprovalDecisionView | 是 | 审批单（“待审核 · 今天 11:40 截止”，超时看 `badges` 含 `overdue`）；`approval.lockVersion` 是审批单的锁版本，3.26 通过时回传 | `qualification_submission.approval_request_id` |
| confirmChecks | array<string> | 是 | 决定时勾选的核对项（原 `ApprovalBrief.confirmChecks`） | `approval_request.confirm_checks` |
| lockVersion | integer | 是 | 轮次的锁版本，3.24 修正识别字段时回传；与 `approval.lockVersion` 是两把锁，不要混用 | `qualification_submission.lock_version`（草稿编辑、审核员修正字段、证照行改动都递增，04-profile.md:290） |
| closedAt | string(date-time) \| null | 是 | 关闭时间 | `qualification_submission.closed_at` |
| outcome、approveMode、systemRejectCode、finalRejectedAt | 同 QualificationRoundRecord | 是 | 结论 | 同名列 |
| store | `{ storeId, name, isPrimary, qualificationStatus, industry, category, region }` | 是 | 商家名、品类与区域；`industry`、`category`、`region` 同 StoreRow（A151） | `store` 与 `store_profile` 同名列 + 字典名称 |
| entity | `{ entityId, name, verificationStatus, usccMask, verifiedAt, verifiedStores }` | 是 | 主体；新增门店轮次的说明“同主体已认证门店：XX 火锅（万达店），主体营业执照已于 06-13 审核通过”（Review.dc.html:193）：`verifiedAt` 为 string(date-time) \| null，`verifiedStores` 为 array<{ storeId, name }>（不含本门店） | `entity` 同名列、`entity.verified_at`；同主体 `store.qualification_status = 'verified'` 且不是本门店的 `store.id`、`store.name`，首家门店在前 |
| proposed | PendingChange \| null | 是 | `change` 轮次的待审值 | `qualification_submission.proposed_*` |
| changedFields | array<enum> | 是 | 变更类别 | `qualification_submission.changed_fields` |
| contact | `{ name, phoneMask, phoneVerifyState }` \| null | 是 | 提交时的联系人快照（“联系人 陈女士 139****2046”）；`phoneVerifyState` 取 m03 的 `PhoneVerifyState`（`login`、`sms_verified`、`unverified`），第三轮按 m03 由 `phoneSource` 改名，避免与请求里 A25 的 `phoneSource` 同名异义 | `qualification_submission.contact_snapshot` 的 `name`、`phoneMask`、`phoneSource`（jsonb 键名不变，出接口改名，同 m03 `contactSnapshot`） |
| profileDigest | `{ completenessPct, doorCount, interiorCount, serviceItemCount }` | 是 | 档案摘要（“档案完整度 100% · 门头照片 2 张……”） | `store_profile.completeness_pct`；`store_profile_media` 按组计数；`store_service_item` 计数（都只计未移除的行） |
| checkSummary | `{ fail, warn, manual, suggestedReason, suggestedNote }` \| null | 是 | 系统比对结论（“发现 1 项异常”）与预填的驳回原因、说明；`suggestedReason` 为 DictRef \| null | `qualification_submission.check_summary`（`suggestedReasonCode` 经字典 `reject_reason` 取名称） |
| checksRanAt | string(date-time) \| null | 是 | 最近比对时间 | `qualification_submission.checks_ran_at` |
| docs | array<AdminQualificationDoc> | 是 | 本轮证照（只含未移除的行） | `qualification_doc` 中本轮 `removed_at` 为空 |
| referenceDocs | array<AdminQualificationDoc> | 是 | 只读参考：新增门店与变更轮次时主体的生效营业执照（PRD 7.4-3“主体营业执照已通过的不再重复审核”） | 本主体 `scope = 'entity'` 的生效行；`initial` 轮次为 `[]` |
| duplicateUscc | `{ inReviewElsewhereCount, isVerifiedElsewhere }` | 是 | 重复标记：本轮营业执照的信用代码在其他主体的在审轮次中出现几次；是否已被其他主体认证（通过会被 409 `USCC_TAKEN` 拒绝） | 读时派生，按本轮未移除营业执照行的 `qualification_doc.cert_no_bidx` 查 `ix_qualification_doc_license_bidx` 与 `entity.uscc_bidx`（04-profile.md:383） |
| relatedOrders | array<{ kind, id, no, title, statusText, amountFen, heldPoints }> | 是 | 关联单据说明（“关联付款单 FK…（开通基础版 3 个月，待确认收款）”“关联订购单 LYX…（《家有萌娃》，已冻结 1,200 积分）”，Review.dc.html:163、181）；`kind` 取 `payment_order`、`drama_order` | 后台路由层拼装（d9-profile.md:693）：本主体 `status` 为 `pending_payment`、`pending_confirmation` 的 `billing_order`（`id`、`order_no`、`amount_fen`；`title` 按 m07-billing 2.5 `PaymentOrderCard.title` 的规则，经 `billing.describePaymentOrders`）；本门店 `status = 'pending_start'` 的 `drama_order`（`id`、`order_no`、`total_charge_points`；`title` 为 `item_no = 1` 的 `order_item.drama_snapshot.title` 加书名号，`item_count > 1` 时加“等 N 部”，同 a05 `firstDramaTitle`） |
| canOverride | boolean | 是 | 是否显示“放行”：当前员工持 `merchant.qualification.override`，且 `checkSummary.fail > 0`；放行走 3.26 的 `mode = override`，不另起动作名 | 计算 |
| actions | array<string> | 是 | 取 `approve`、`reject`、`reject-quote`（`kind` 不是 `change` 时） | 审批单 `pending` 且有审核权限（C16） |

**FinalRejectImpact**（终局驳回影响预览，3.25 的响应）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| pendingStartOrderCount | integer | 是 | 待开工订购单数（将整店取消） | `QualificationImpactPort.previewFinalReject`（order 实现，d9-profile.md:735）：本门店 `drama_order.status = 'pending_start'` |
| pendingAssignAdCount | integer | 是 | 待指派广告数（含退回补充中、退回前是待指派的） | 同上，口径见 a05 1.3 的 `order.previewFinalReject`（与系统生成整店取消同一口径）：本门店无在途取消的广告中，`ad.status = 'pending_assign'`，或 `ad.status = 'returned'` 且 `ad.returned_from = 'pending_assign'`（09-order-ad.md:808）；订购单同样只计无在途取消的 |
| heldPoints | integer(积分) | 是 | 将退回的冻结积分 | 同上：这些对象未结冻结单的 `point_hold.qty` 之和 |
| orders | array<{ orderId, orderNo, heldPoints }> | 是 | 订购单明细 | `drama_order.id`、`order_no`；冻结量同上 |
| ads | array<{ adId, adNo, heldPoints }> | 是 | 广告明细 | `ad.id`、`ad.ad_no` |
| computedAt | string(date-time) | 是 | 试算时刻 | 服务端时钟 |

### 2.8 账号变更：AccountChangeRequestCard、AccountChangeRequestDetail

**AccountChangeRequestCard**

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| accountChangeRequestId | string(uuid) | 是 | 申请 | `account_change_request.id` |
| kind | enum(同数据模型 `account_change_request.kind`) | 是 | 换绑手机号、老板更换、老板复核 | `account_change_request.kind` |
| requestNo | string | 是 | 单号 `ZH…`（原 `ApprovalBrief.requestNo`；3.20–3.22 的回显 `confirm.requestNo` 取它） | `approval_request.request_no` |
| approval | ApprovalDecisionView | 是 | 状态、发起人、审批人与说明；超时看 `badges` 含 `overdue` | `account_change_request.approval_request_id` → `approval_request` |
| target | MerchantUserBrief \| null | 是 | 目标账号（换绑、复核）；老板更换为空 | `account_change_request.merchant_user_id` |
| entity | `{ entityId, name }` \| null | 是 | 目标主体 | `account_change_request.entity_id` → `entity.name` |
| newPhoneMask | string \| null | 是 | 新手机号脱敏串（换绑、老板更换） | `account_change_request.new_phone_mask` |
| reason | DictRef | 是 | 发起原因（字典 `account_change_reason`） | `account_change_request.reason_code` |
| reasonText | string | 是 | 发起说明 | `account_change_request.reason_text` |
| appliedAt | string(date-time) \| null | 是 | 生效时间 | `account_change_request.applied_at` |
| actions | array<string> | 是 | 取 `approve`、`reject`、`withdraw` | 审批单 `pending`；`approve`、`reject` 要求当前员工有决定权且不是发起人；`withdraw` 见 3.22 |

**AccountChangeRequestDetail** = 卡片全部字段，另加：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| proofFileIds | array<string(uuid)> | 是 | 证明材料；看图走 `admin.file.downloadUrls`（`account_proof`：需 `merchant.account_change.request` 或 `.approve`，写 access 审计，a01 2.17） | `account_change_request.proof_file_ids` |
| confirmChecks | array<string> | 是 | 通过时勾选的核对项（原 `ApprovalBrief.confirmChecks`） | `approval_request.confirm_checks` |
| verifyMethod | string \| null | 是 | 核实方式（复核） | `account_change_request.verify_method` |
| verifyRecord | string \| null | 是 | 核实记录（复核） | `account_change_request.verify_record` |
| currentOwner | MerchantUserBrief \| null | 是 | 老板更换时的现任老板 | 目标主体的有效老板 |
| precheck | `{ ok: boolean, issues: array<string> }` \| null | 是 | 待审时现算的前置条件（`phone_taken`、`phone_occupied_by_empty_account`、`new_owner_in_other_entity`、`target_not_active`、`entity_not_active`）。新号码的占用方在 `entity_member` 里有任何一行（不论有效还是已移除），或占用方不是 `active`，记 `phone_taken`；占用方是 `active` 且在 `entity_member` 里没有任何行，才记 `phone_occupied_by_empty_account`——它只是提示：通过时清理该空账号（d4-identity.md:412-416；02-identity-tenant.md:129 的 `purge_empty` 守卫“从未有过成员关系”）。已决为空 | 解密 `new_phone_enc` 后现算盲索引，查 `merchant_user.phone_bidx`、`merchant_user.status` 与 `entity_member`（按 `merchant_user_id`，不限状态） |
| result | object \| null | 是 | 执行结果快照，按 `kind`：`{ purgedUserId, prevPhoneMask }`、`{ newOwnerUserId, newOwnerAccountCreated, newOwnerMemberId, prevOwnerMemberId }`、`{ bypassUntil }` | `account_change_request.result_snapshot`（02-identity-tenant.md:961-973） |
| createdAt | string(date-time) | 是 | 创建时间 | `account_change_request.created_at` |

### 2.9 素材：AdminStoreAssetRow、AdminStoreAssetDetail、AdminStoreAssetSummary、AssetDemandRow

**AdminStoreAssetRow**（门店素材表的一行）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| storeAssetId | string(uuid) | 是 | 素材 | `store_asset.id` |
| storeId | string(uuid) | 是 | 门店 | `store_asset.store_id` |
| storeName | string \| null | 是 | 门店名称（跨门店的待整理队列不传 `storeId` 时用于区分门店，3.28） | `store.name` |
| type | enum(同数据模型 `store_asset.type`) | 是 | 图片、视频、录音、音频、文档、文字 | `store_asset.type` |
| title | string \| null | 是 | 标题（系统生成，复核人可改） | `store_asset.title` |
| fileCount | integer | 是 | 文件数（“图片 4 张”） | `store_asset_file` 行数 |
| durationMs | integer \| null | 是 | 首个音视频文件时长（“录音 0:42”） | `media_info.duration_ms` |
| pageCount | integer \| null | 是 | 文档页数（“文档 3 页”） | `kind = 'doc_text'` 洞察的 `store_asset_insight.content` 的 `pageCount` |
| charCount | integer \| null | 是 | 文字字数（“文字 14 字”） | `store_asset.text_body` 的字数 |
| thumbnail | SignedUrl \| null | 是 | 缩略图 | 首图或 `media_info.cover_file_id` 现签，30 分钟对齐窗口 |
| uploader | `{ actorType, role, displayName, merchantUserId, staffId }` | 是 | 上传人（“阿杰 店员”；员工代传显示员工姓名） | `store_asset.upload_actor_type`、`upload_actor_role`、`upload_actor_id`（商家 → 本主体成员称呼；员工 → `staff.name`） |
| contentTags | array<AssetTag> | 是 | 内容标签；有复核确认的只给确认的 | `store_asset_tag`（`dimension = 'content'`） |
| hasUnconfirmedAutoTags | boolean | 是 | “系统识别，待复核” | 有 `source = 'auto'`、`is_confirmed = false` 的内容标签且 `review_state = 'unreviewed'` |
| usageTags | array<AssetTag> | 是 | 用途 | `store_asset_tag`（`dimension = 'usage'`） |
| timelinessTag | AssetTag \| null | 是 | 时效（“国庆 10-01～10-07”带日期区间） | `store_asset_tag`（`dimension = 'timeliness'`） |
| usability | enum(同数据模型 `store_asset.usability`) \| null | 是 | 可用性；未复核为空 | `store_asset.usability` |
| adminStatus | enum `AdminAssetStatus` | 是 | 待整理、已整理、已采用 | `review_state = 'unreviewed'` → `organizing`；`adopted_count > 0` → `adopted`；否则 `organized` |
| processingState | enum(同数据模型 `store_asset.processing_state`) | 是 | 处理进度 | `store_asset.processing_state` |
| isInsightPartial | boolean | 是 | 有识别步骤失败或跳过 | `store_asset.is_insight_partial` |
| moderationState | enum(同数据模型 `store_asset.moderation_state`) | 是 | 内容安全 | `store_asset.moderation_state` |
| adoptedCount | integer | 是 | 被采用次数 | `store_asset.adopted_count` |
| portraitAuth | `{ fileCount, authorizedAt }` | 是 | 肖像授权材料份数与确认时间；“待确认授权”= 需肖像授权且份数 > 0 | `store_asset.portrait_auth_file_ids` 元素数；`store_asset.portrait_authorized_at` |
| reviewDueAt | string(date-time) \| null | 是 | 复核截止 | `store_asset.due_at` |
| isReviewOverdue | boolean | 是 | 复核超时 | 未复核且 `due_at` 早于现在 |
| assetDemandId | string(uuid) \| null | 是 | 响应的素材需求 | `store_asset.store_asset_demand_id` |
| sourceStoreAssetId | string(uuid) \| null | 是 | 复制来源 | `store_asset.source_store_asset_id` |
| createdAt | string(date-time) | 是 | 上传时间 | `store_asset.created_at` |
| actions | array<string> | 是 | 取 `review`（未复核时前端显示“整理”，已复核显示“改标签”）、`confirm-portrait-auth`、`portrait-auth`、`reprocess`、`delete` | 按权限点与素材状态（C16） |

**AdminStoreAssetDetail** = AdminStoreAssetRow 的全部字段，另加：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| textBody | string \| null | 是 | 文字类正文 | `store_asset.text_body` |
| note | string \| null | 是 | 补充说明 | `store_asset.note` |
| files | array<MediaFileView> | 是 | 全部文件（预览或播放） | `store_asset_file` 按 `position` 现签 |
| transcript | `{ text, segments }` \| null | 是 | 转写 | `kind = 'transcript'`、`status = 'ok'` 洞察的 `content` |
| keypoints | array<string> | 是 | 要点 | `kind = 'digest'` 洞察 `content.keypoints` |
| structuredItems | array<{ name, priceText }> | 是 | 菜品与价格（“已提取 12 道菜”） | `kind = 'structured_items'` 洞察 `content.items` |
| techSpecLabel | string \| null | 是 | 技术规格（“竖屏 1080P”） | `kind = 'tech_spec'` 洞察 `content.label` |
| suggestion | `{ contentTags, usageTags, timeliness, faceHint, qualityNotes, description }` \| null（`contentTags`、`usageTags` 为 array<DictRef>，C85；第三轮由 `contentTagCodes`、`usageTagCodes` 改名） | 是 | 系统识别说明与建议（整理弹层顶部“系统识别：4 张菜品特写……”；`faceHint = 'identifiable_customer'` 时弹层预选“需肖像授权”，d5-media.md:1770） | `kind = 'digest'` 洞察的 `content.contentTags`、`suggestedUsage`、`suggestedTimeliness`、`faceHint`、`qualityNotes`；`kind = 'vision'` 的 `content.description` |
| insightSteps | array<{ kind, status }> | 是 | 各识别步骤结果（重新识别前查看） | `store_asset_insight.kind`、`status` |
| portraitAuthFileIds | array<string(uuid)> | 是 | 肖像授权材料；看图走 `admin.file.downloadUrls`（secure 桶，写 access 审计） | `store_asset.portrait_auth_file_ids` |
| reviewedBy | StaffBrief \| null | 是 | 复核人（“林晓于 09-28 10:12 复核”） | `store_asset.reviewed_by_staff_id` |
| reviewedAt | string(date-time) \| null | 是 | 复核时间 | `store_asset.reviewed_at` |
| usages | array<{ usedByType, usedById, usedByNo, role, at }> | 是 | 使用记录（“已用于国庆双人套餐片尾”） | `store_asset_usage` 的 `used_by_type`、`used_by_id`、`role`、`created_at`；单号由路由层经 order、ad 的只读查询补齐 |
| lockVersion | integer | 是 | 素材乐观锁（整理、确认授权用） | `store_asset.lock_version` |

**AdminStoreAssetSummary**（门店素材页签计数：“共 128 条 · 已整理 127 条 · 待整理 1 条 · 已采用 11 条”与类型下拉的计数）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| tabs | `{ all, organizing, adopted }`，各为 integer | 是 | 页签计数，键与列表 `tab` 取值一致（C83） | 未删除素材，按 `AdminAssetStatus` 计数，套用除 `tab` 外的同一筛选 |
| organizedCount | integer | 是 | 已整理（含已采用） | `review_state = 'reviewed'` |
| types | `{ image, video, recording, audio, document, text }`，各为 integer | 是 | 类型计数 | 按 `store_asset.type` |
| awaitingPortraitConfirmCount | integer | 是 | 待确认肖像授权 | `usability = 'need_portrait_auth'` 且有授权材料 |
| reviewOverdueCount | integer | 是 | 复核超时 | 未复核且 `due_at` 早于现在 |

**AssetDemandRow**

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| assetDemandId | string(uuid) | 是 | 需求 | `store_asset_demand.id` |
| storeId | string(uuid) | 是 | 门店 | `store_asset_demand.store_id` |
| title | string | 是 | 名称 | `store_asset_demand.title` |
| shootingNote | string \| null | 是 | 拍摄说明 | `store_asset_demand.shooting_note` |
| dueDate | string(date) | 是 | 完成日期（“10-01 前”） | `store_asset_demand.due_date` |
| notifyScope | enum(同数据模型 `store_asset_demand.notify_scope`) | 是 | 通知对象 | `store_asset_demand.notify_scope` |
| status | enum(同数据模型 `store_asset_demand.status`) | 是 | 进行中、已完成、已撤销 | `store_asset_demand.status` |
| isOverdue | boolean | 是 | 已逾期（不落库） | `status = 'open'` 且 `due_date` 早于北京时间今天 |
| createdBy | StaffBrief | 是 | 发起人（“林晓 · 09-29 发起”） | `store_asset_demand.created_by_staff_id` |
| createdAt | string(date-time) | 是 | 发起时间 | `store_asset_demand.created_at` |
| closedAt | string(date-time) \| null | 是 | 结束时间 | `store_asset_demand.closed_at` |
| receivedCount | integer | 是 | 已收到（“已收到 0 条”） | `store_asset` 中 `store_asset_demand_id` 为本需求、未删除的计数 |
| actions | array<string> | 是 | 取 `complete`、`cancel` | `status = 'open'` 且持 `merchant.asset.demand.create` |

### 2.10 FollowUpItem（跟进记录）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| followUpId | string(uuid) | 是 | 跟进 | `follow_up.id` |
| subjectType | enum(同数据模型 `follow_up.subject_type`) | 是 | 跟进对象类型 | `follow_up.subject_type` |
| subjectId | string(uuid) | 是 | 跟进对象 | `follow_up.subject_id` |
| entityId | string(uuid) | 是 | 主体 | `follow_up.entity_id` |
| storeId | string(uuid) \| null | 是 | 门店；续费跟进为空 | `follow_up.store_id` |
| channel | enum(同数据模型 `follow_up.channel`) \| null | 是 | 方式：企业微信、电话、上门拜访、系统生成；空 = 未注明 | `follow_up.channel` |
| content | string | 是 | 沟通内容 | `follow_up.content` |
| intent | enum(同数据模型 `follow_up.intent`) \| null | 是 | 续费意向（只有续费跟进） | `follow_up.intent` |
| nextFollowAt | string(date-time) \| null | 是 | 下次跟进（到期当日 09:00 提醒负责人） | `follow_up.next_follow_at` |
| isOpen | boolean | 是 | 在办（待办） | `next_follow_at` 非空且 `done_at` 为空（03-staff-authz-audit.md:494） |
| owner | StaffBrief \| null | 是 | 负责人（提醒对象）；人工记录时等于记录人，只在员工禁用移交或自动改派时变化（03-staff-authz-audit.md:509） | `follow_up.owner_staff_id` |
| doneAt | string(date-time) \| null | 是 | 完成时间（“已完成：09-28 确认续费意向”） | `follow_up.done_at` |
| doneNote | string \| null | 是 | 完成说明 | `follow_up.done_note` |
| recorder | `{ actorType, staff: StaffBrief \| null }` | 是 | 记录人（“林晓（交付经理）”）；系统生成为 `system` | `follow_up.actor_type`、`actor_id` |
| createdAt | string(date-time) | 是 | 记录时间 | `follow_up.created_at` |
| lockVersion | integer | 是 | 乐观锁（改期、完成用） | `follow_up.lock_version` |
| actions | array<string> | 是 | 取 `update`、`complete` | 在办，且当前员工是负责人或其主管（C16） |

### 2.11 ReferralCodeRow（渠道码登记）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| referralCodeId | string(uuid) | 是 | 登记行 | `referral_code.id` |
| code | string | 是 | 码值（大写） | `referral_code.code` |
| sourceType | enum(同数据模型 `referral_code.source_type`) | 是 | 销售、活动、服务商（V1.1） | `referral_code.source_type` |
| owner | StaffBrief \| null | 是 | 归属员工（销售必有） | `referral_code.owner_staff_id` |
| label | string \| null | 是 | 渠道或活动名称 | `referral_code.label` |
| status | enum(同数据模型 `referral_code.status`) | 是 | 启用、停用 | `referral_code.status` |
| disabledAt | string(date-time) \| null | 是 | 停用时间 | `referral_code.disabled_at` |
| registeredUserCount | integer | 是 | 归因到本码的注册账号数 | `merchant_user.source_referral_code_id` 计数（`ix_merchant_user_source_referral_code_id`） |
| entityCount | integer | 是 | 归因到本码的主体数 | `entity.source_referral_code_id` 计数 |
| createdAt | string(date-time) | 是 | 登记时间 | `referral_code.created_at` |
| actions | array<string> | 是 | 取 `disable`、`enable` | 按状态与权限点 |

### 2.12 指派、转移与联系：ManagerTransferResult、ManagerAssignResult、AssignmentContactView

**ManagerTransferResult**（3.8 的响应）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| storeId | string(uuid) | 是 | 门店 | `store.id` |
| deliveryManager | StaffBrief | 是 | 新交付经理 | `store.delivery_manager_id` |
| batchId | string(uuid) | 是 | 本次改派批次 | `assignment_history.batch_id` |
| moved | `{ dramaOrderCount, deliveryTicketCount, serviceTicketCount }` | 是 | 一并移交的在办事项数（toast“5 个在办工单已一并移交”）；与弹层上 StoreHeader.managerOpenWork 同一口径（负责人为原交付经理的在办事项） | 本批 `assignment_history` 中 `subject_type` 为 `drama_order`、`delivery_ticket`、`service_ticket` 的行数 |
| contact | AssignmentContactView | 是 | 新交付经理联系商家的时限 | 本批门店那一行 |

**ManagerAssignResult**（3.8a 的响应）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| storeId | string(uuid) | 是 | 门店 | `store.id` |
| deliveryManager | StaffBrief | 是 | 指派的交付经理 | `store.delivery_manager_id` |
| synced | `{ dramaOrderCount, deliveryTicketCount }` | 是 | 同事务一并写入交付经理的未结订购单数、一并分配的待分配工单数 | 本次事务改写的行数 |

**AssignmentContactView**

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| assignmentHistoryId | string(uuid) | 是 | 改派记录 | `assignment_history.id` |
| storeId | string(uuid) | 是 | 门店 | `assignment_history.subject_id`（`subject_type = 'store'`） |
| toStaff | StaffBrief | 是 | 新交付经理 | `assignment_history.to_staff_id` |
| contactDueAt | string(date-time) | 是 | 联系截止（1 个工作日） | `assignment_history.contact_due_at` |
| contactedAt | string(date-time) \| null | 是 | 已联系时间 | `assignment_history.contacted_at` |
| contactedBy | StaffBrief \| null | 是 | 标记人 | `assignment_history.contacted_by_staff_id` |

## 3. 接口

除另行说明，限流档位都是 `admin.global`（C68），都不受功能开关控制。

### 3.1 admin.store.list　商家列表
`GET /admin/stores`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看；门店范围（交付经理只看本人负责的，主管另含待分配池） |
| 回显 | 无 |
| 幂等 | none（纯查询，GET 不写库，A19） |
| 乐观锁 | 无 |
| 对应画板 | A:Merchants（列表、8 个筛选、3 种排序、分页、导出）；A:Service（门店远程搜索下拉，带 `q` 与小 `pageSize`） |
| 出处 | 路线图 `a03.stores.list`；proto-admin-b.md:24-56；d9-profile.md:682、788；PRD 7.4-1 |

**请求**：查询参数为 StoreListQuery（2.2）。

**响应**：`{ items: array<StoreRow>, page, pageSize, total }`（C43）。

**错误**：无（通用错误按约定）。

**副作用**：无。

**说明**：
- 关键字用 `q=`，其余筛选按字段名（A24）。“套餐版本”筛选里的“未开通”“已过期”是订阅状态，拆到 `subscriptionStatus`（proto-admin-b.md:51），版本本身用 `planId`；“套餐到期 7 天内 / 30 天内”用 `expiresWithinDays`。
- “累计实付”“最近订购”是跨表聚合列（proto-admin-b.md:40），排序与筛选都要用到；V1.0 按查询时现算，门店过千后改为读侧物化（按主体与门店的汇总表，由订购与付款事件维护），属实现层的取舍，不影响接口。
- 导出不另开路由（C64）：前端调 `admin.exportJob.create`（a02），`exportKey = stores.list`（以 a02 导出登记表为准，C46、C64）、`params` 与本接口的查询参数同构（去掉 `page`、`pageSize`），需 `merchant.export`；导出与列表共用同一个带范围的查询构造函数。导出含联系电话时默认脱敏。
- 页头统计（3.2）与本列表套用同一个查询构造函数，计数与列表一致。

### 3.2 admin.store.summary　商家列表页头统计
`GET /admin/stores/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看；门店范围 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Merchants（页头“共 486 家 · 付费 213 家（套餐生效 186 家）· 审核中 4 家 · 本月新增 97 家”） |
| 出处 | 路线图 `a03.stores.summary`；proto-admin-b.md:27、53；A23、C83 |

**请求**：查询参数同 StoreListQuery，去掉 `sort`、`page`、`pageSize`。

**响应**：StoreListSummary（2.2）。

**错误**：无。

**副作用**：无。

**说明**：页头的数字随筛选变化，与列表同口径。“付费”与 PRD 9.1“付费主体数”的口径差异见第 6 节第 1 项。字面段先于 `/{storeId}` 注册（A8）。

### 3.3 admin.store.get　商家详情页头
`GET /admin/stores/{storeId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看；门店范围 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:MerchantDetail（页头：门店名、标签、同主体门店数、主体与联系人、企业微信、交付经理与“转移”、“代改档案”、5 张 KPI 卡） |
| 出处 | 路线图 `a03.stores.get`；proto-admin-b.md:67；A23 |

**请求**：路径参数 `storeId`（uuid）。

**响应**：StoreHeader（2.3）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 门店不存在或不在数据范围内 |

**副作用**：无。

**说明**：
- 11 个页签的计数不由本接口返回，由各资源的 `summary` 按 `storeId` 给出（A23；2.3 末尾的清单）。
- “在积分账户中查看”“手动调整积分”跳到 a07（`admin.pointAccount.get`、`admin.pointAdjustmentRequest.create`）；本接口只给“调整审批中”的标记。
- 联系人手机号、老板手机号只给脱敏串，看明文走 `admin.piiReveal.create`（`pii.phone.reveal`）。

### 3.4 admin.store.activity.list　门店活动流
`GET /admin/stores/{storeId}/activities`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看；门店范围 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:MerchantDetail（操作日志页签） |
| 出处 | 路线图 `a03.stores.list-activities`；d4-identity.md:2294；03-staff-authz-audit.md:635；proto-admin-b.md:83、122 |

**请求**：路径参数 `storeId`。查询参数：

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| actorType | string | 否 | 逗号分隔，`merchant`、`staff`、`system` | 按操作人类型筛选 |
| cursor | string | 否 | 不透明 | 首页不传 |
| limit | integer | 否 | 1–100，默认 20 | — |

**响应**：`{ items: array<StoreActivityItem>, nextCursor, hasMore, totalApprox }`，按时间倒序（A22；`totalApprox` 封顶 10,000）。

**错误**：`NOT_FOUND`（404，门店不存在或不在范围内）。

**副作用**：无。

**说明**：
- 取数按 03-staff-authz-audit.md:635：门店级行 `audit_log.store_id = :storeId`、主体级行 `audit_log.entity_id = :entityId 且 store_id 为空`，`stream` 只取 `ops`、`activity`（`access` 流不进活动流），两条查询各取一页后按 `(created_at, seq)` 归并；游标编码 `(created_at, seq)`。
- 状态迁移在审计里恰好一行（M31），所以每次迁移在日志里只出现一次。
- 系统 › 操作日志页（`admin.auditLog.list`，a01）是全平台视图，本接口只是门店视角。

### 3.5 admin.store.profile.get　档案页签
`GET /admin/stores/{storeId}/profile`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看；门店范围 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无（响应返回 `lockVersion` 供 3.6 使用） |
| 对应画板 | A:MerchantDetail（档案页签：基础信息、主推服务、门店图片、档案完整度） |
| 出处 | 路线图 `a03.stores.get-profile`；d9-profile.md:683；proto-admin-b.md:73 |

**请求**：路径参数 `storeId`。

**响应**：AdminStoreProfile（2.6）。

**错误**：`NOT_FOUND`（404）。

**副作用**：无。

**说明**：
- 页签下方“套餐与积分”小卡复用 3.3 的 `subscription`、`points` 与 3.10 的 `usage`，本接口不重复返回。
- “所属服务商”是 V1.1（PRD 7.4-9），V1.0 不返回。
- 原型“行业与品类 · 变更须由商家提交并重新审核”等提示是静态文案。

### 3.6 admin.store.profile.update　代改档案
`PATCH /admin/stores/{storeId}/profile`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.profile.proxy_edit`（客服、交付经理，d4-identity.md:1171）；门店范围 |
| 回显 | 不另带 `confirm`：以 `lockVersion` 防过期数据，修改原因与备注随请求写审计 |
| 幂等 | required（带锁的 PATCH，A17） |
| 乐观锁 | 带 `lockVersion`（`store_profile.lock_version`，A21） |
| 对应画板 | A:MerchantDetail（“代改档案”内联编辑态与“保存并通知商家”） |
| 出处 | 路线图 `a03.stores.update-profile`；d9-profile.md:616-623、684；proto-admin-b.md:90、109-110；PRD 7.4-2 |

**请求**：路径参数 `storeId`；请求体 ProxyEditBody（2.6）。

**响应**：AdminStoreProfile（新的 `lockVersion` 与完整度）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 门店不存在或不在范围内 |
| `STATE_NOT_ALLOWED` | 409 | 门店已停用（`details.reason = 'store_archived'`） |
| `VERSION_CONFLICT` | 409 | `lockVersion` 与库中不一致（商家可能同时在改，C52） |
| `FIELD_NOT_PROXY_EDITABLE` | 400 | 请求带了重审字段、联系人或资质；`details.fields` 列出 |
| `PROXY_EDIT_NO_CHANGE` | 400 | 提交的值与当前值完全相同（“未检测到修改内容”） |
| `PROFILE_REQUIRED_MISSING` | 400 | 门店已提交过资质，却把必填项改空（m03 定义） |
| `VALIDATION_FAILED` | 400 | 长度、字典、数量上限等格式不符 |
| `FILE_NOT_USABLE` | 400 | Logo、门店图片、服务图片不可用（m03 定义） |
| `CONTENT_REJECTED` | 400 | 文本未通过内容安全检测（m01 定义）；`details = { fields: string[] }`，列出未通过的字段键（A131）；检测服务不可用时 503 `PROVIDER_UNAVAILABLE`、不写库（A137） |

**副作用**：
- 状态迁移：无。
- 写 `store_profile` 的上述列，`last_edited_at`、`last_edit_actor_type = 'staff'`、`last_edit_actor_id` = 当前员工、`last_edit_client = 'admin'`，`lock_version + 1`，完整度三列重算写回；`store_service_item`、`store_profile_media` 的写法同 m03 3.5、3.7（行插入的 `create_actor_type = 'staff'`、`create_client = 'admin'`）。
- `file_ref`：新文件 `files.link`，被替换或移除的 `files.release`，保留 30 天（04-profile.md:648）。
- `audit_log`：`ops` 流一行，类别 `profile_edit`，`on_behalf_of_entity_id` = 门店所属主体，`reason_code` 为修改原因、`reason_text` 为备注，`before`、`after` 记变更字段。
- 出站事件 `store.profile.changed { storeId, entityId, fields, source: 'staff_proxy' }`（d9-profile.md:623），通知模块据此给老板发“代改档案通知”（13-notify-docs.md:1114）。

**说明**：
- 可改范围按 PRD：全部免审字段（d9-profile.md:621）。原型只开放 6 个文本字段、营业时间与核心卖点还是单行文本（proto-admin-b.md:109-110），后台表单按结构化字段升级，开放哪些由前端定（9-C15），接口不限。
- 原型要求“各项内容均不能为空”（proto-admin-b.md:109）；接口按 PRD 的必填规则：优惠活动、团购信息选填，已提交资质的门店不能清空必填项。
- 地址整体不可代改：省市区与详细地址是重审字段，选点名称与坐标随地址由商家维护。
- 加锁顺序：档案行（135）。不涉及 `change` 轮次。

### 3.7 admin.store.qualification.get　资质页签
`GET /admin/stores/{storeId}/qualification`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看；门店范围（原 `merchant.qualification.view` 按 C66 改为模块查看） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:MerchantDetail（资质页签：结论摘要、营业执照与许可证的原图与字段、审核记录） |
| 出处 | 路线图 `a03.stores.get-qualification`；d9-profile.md:685；proto-admin-b.md:75、116 |

**请求**：路径参数 `storeId`。

**响应**：AdminStoreQualificationView（2.7）。

**错误**：`NOT_FOUND`（404）。

**副作用**：无。

**说明**：
- 证照字段只给脱敏值（A19；原 `a01.approvals.get` 在 GET 里回明文并记审计的写法取消），原图经 `admin.file.downloadUrls`（需 `merchant.qualification.review` 或 `pii.license.view`，d4-identity.md:1723），明文经 `admin.piiReveal.create`（`pii.license.view`）。
- 证照到期只提示、不改结论（d9-profile.md:581），`expiryState` 供页签与工作台标记。

### 3.8 admin.store.reassignDeliveryManager　转移交付经理
`POST /admin/stores/{storeId}/reassign-delivery-manager`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.manager.transfer`（仅主管，d4-identity.md:1173）；门店范围（含待分配池） |
| 回显 | `confirm: { fromStaffId }`：弹层打开时的现任交付经理，与 `store.delivery_manager_id` 比对 |
| 幂等 | required |
| 乐观锁 | 无（不是状态机迁移；以 `confirm` 防过期） |
| 对应画板 | A:MerchantDetail（转移交付经理弹层：候选人单选带负载、转移原因、交接说明） |
| 出处 | 路线图 `a03.stores.reassign-delivery-manager`（A136 由 `…/reassign-manager` 改名，与 3.8a 对称）；d3-flow.md:3537；03-staff-authz-audit.md:418-477；09-order-ad.md:219；12-support.md:168、505；proto-admin-b.md:94；PRD 7.4-4 |

**请求**：路径参数 `storeId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| toStaffId | string(uuid) | 是 | 启用中、角色为交付经理（`staff.staff_role_key = 'delivery_manager'`）、不是现任、在操作人的员工集合内（`authz.scopeOf().staffIds`：主管只能指派给本组的人，范围为“全部”的不受限，d4-identity.md:1324 第 4 条） | 新交付经理；候选人由 `admin.staff.list`（`pool=delivery_manager`、`withLoad=true`，a01）给出 |
| reasonCode | enum `ManagerTransferReason` | 是 | — | → `assignment_history.reason_code` |
| note | string | 否 | ≤200 字 | 交接说明 → `assignment_history.note` |
| confirm | `{ fromStaffId: string(uuid) }` | 是 | 等于当前交付经理 | 回显（C54） |

**响应**：ManagerTransferResult（2.12）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 门店不存在或不在范围内 |
| `STORE_MANAGER_UNASSIGNED` | 409 | 门店还没有交付经理，不能转移；改用首次指派 3.8a |
| `ASSIGNEE_INVALID` | 409 | 接收人无效（a05 定义，A77、C28）；`details = { staffId, reason }`，`reason` 取 `not_active`（未启用）、`role_mismatch`（不是交付经理）、`same_as_current`（与现任相同）、`out_of_scope`（不在操作人的员工集合内） |
| `CONFIRM_MISMATCH` | 409 | `confirm.fromStaffId` 与现任交付经理不一致（已被他人转移） |

**副作用**（一个事务；先 `FOR SHARE` 锁接收员工行并校验启用，再锁门店行，d4-identity.md:1135）：
- 状态迁移：无业务状态机迁移。客服工单负责人的改派由 12 分组注册的改派实现完成：每张写一行 `transfer`（from = to）状态历史与一条 `system_event` / `transfer` 时间线条目（`reason_code` 取本批 `assignment_history.reason_code`，`payload.assignmentBatchId`，12-support.md:159-160、168）。
- `store.delivery_manager_id` = 接收人。
- 同事务移交在办事项（已归档的不动，PRD 7.4-4），范围与弹层的 `managerOpenWork` 同一口径——负责人等于原交付经理（`confirm.fromStaffId`）的在办事项：本门店未结订购单（`drama_order.status` 不在 `ended`、`cancelled`、`refunded`）的 `drama_order.delivery_manager_id`（09-order-ad.md:219）；未归档、未终止工单的 `delivery_ticket.delivery_manager_id`（10-delivery.md:1261）；未解决、未关闭客服工单的 `service_ticket.owner_staff_id`。改写经各模块向 staff 注册的改派实现完成。逐对象规则：
  - 负责人等于原交付经理：改为接收人，并写一行改派记录（见下）。
  - 负责人已是接收人：跳过，不写记录（`ck_assignment_history_from_to` 不允许 from = to）。
  - 负责人为空：`delivery_ticket` 在 `assigning` 步骤时可以为空（`ck_delivery_ticket_delivery_manager_required`），这类工单不在本接口范围，仍由 a05 `admin.deliveryTicket.assignManager` 分配；未结订购单的负责人按 09-order-ad.md:225 的不变量应与门店一致，若为空则同步改为接收人、不写记录（`assignment_history.from_staff_id` 非空），也不计入 `moved`。
  - 负责人是其他员工的客服工单（由客服负责的）不动。
- `assignment_history`：同一 `batch_id` 逐对象一行（`source = 'store_manager'`；`subject_type` 为 `store`、`drama_order`、`delivery_ticket`、`service_ticket`；`from_staff_id` = 原交付经理；`actor_type = 'staff'`、`client = 'admin'`）。门店那一行带 `contact_due_at` 与 `sla_snapshot`（参数 `sla.manager.first_contact`，默认 1 个工作日，M107）；本门店此前未联系、未作废的那一行写 `contact_voided_at` 并取消其定时器（先作废、再写新行，03-staff-authz-audit.md:471）。
- 定时器：登记 `sla.breach`（`subject_type = 'assignment_history'`，主体为门店那一行，01-kernel-flow.md:607）。
- 出站事件：本批一条 `assignment.transferred { batchId, countsBySource, toStaffId, reasonCode }`（03-staff-authz-audit.md:475）；通知模块据此通知新交付经理与商家，商家端服务经理名片随之更新（`m.serviceManager.get`，m08）。每张改派的客服工单另发一条 `service_ticket.transferred { serviceTicketId, fromStaffId, toStaffId, reasonCode }`（客服工单的 `transfer` 是 12 分组状态机的迁移，按 x01 第 2.4 节 E1 每次迁移都发，与员工禁用移交的写法一致；12-support.md:191）。
- `audit_log`：`ops` 流一行，类别 `manager_assign`，`meta.batchId`、`meta.impact` 记移交数量。

**说明**：
- “仅主管”由注册表的 `leadOnly` 判断（d4-identity.md:1173）。原因与 `assignment_history.reason_code` 的转移类取值一一对应（`workload`、`merchant_request`、`staff_change`、`other`）。
- 原型的“进行中 N 单”负载由 `admin.staff.list` 返回，本接口不重复。
- 接收人无效的错误码按 A77 统一为 a05 的 `ASSIGNEE_INVALID`，本文原来的 `TRANSFER_TARGET_INVALID`（41304）删除。

### 3.8a admin.store.assignDeliveryManager　首次指派交付经理
`POST /admin/stores/{storeId}/assign-delivery-manager`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.manager.assign`（仅主管，注册表附带待分配池 `store_manager`，d4-identity.md:1172）；门店范围（含待分配池：交付经理为空的门店对持该键的主管可见） |
| 回显 | 不带 `confirm`：守卫“门店当前没有交付经理”本身防重复指派（已有则 409），与 a05 3.20 的工单分配一致 |
| 幂等 | required |
| 乐观锁 | 无（门店的交付经理不是状态机列；以状态守卫防并发，锁门店行） |
| 对应画板 | A:Merchants、A:MerchantDetail（“交付经理：未分配”的门店；原型没有手动分配入口，proto-admin-b.md:117，建议在页头交付经理处显示“分配”） |
| 出处 | A91；d4-identity.md:1172（`merchant.manager.assign`“首次分配交付经理”）；d3-flow.md:599、626-632；09-order-ad.md:214-219；10-delivery.md:172；03-staff-authz-audit.md:420、436 |

**请求**：路径参数 `storeId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| toStaffId | string(uuid) | 是 | 启用中、角色为交付经理、在操作人的员工集合内（同 3.8，d4-identity.md:1324 第 4 条） | 指派的交付经理；候选人由 `admin.staff.list`（`pool=delivery_manager`、`withLoad=true`，a01）给出 |
| note | string | 否 | ≤200 字 | 指派说明 → `audit_log.reason_text` |

**响应**：ManagerAssignResult（2.12）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 门店不存在或不在范围内 |
| `STORE_MANAGER_ASSIGNED` | 409 | 门店已有交付经理（可能刚被轮询分配或他人指派）；改用转移 3.8；`details.deliveryManagerId` |
| `ASSIGNEE_INVALID` | 409 | 接收人无效（a05 定义）；`details = { staffId, reason }`，`reason` 取 `not_active`、`role_mismatch`、`out_of_scope` |
| `VALIDATION_FAILED` | 400 | 说明超长 |

**副作用**（一个事务；先 `FOR SHARE` 锁接收员工行并校验启用，再 `FOR UPDATE` 锁门店行，d3-flow.md:599）：
- 状态迁移：门店本身无（`store.delivery_manager_id` 不是状态机列）。随门店写入、同事务分配的待分配工单见下。
- `store.delivery_manager_id` = 接收人（守卫：原值为空）。
- 本门店未结订购单（`drama_order.status` 不在 `ended`、`cancelled`、`refunded`）的 `drama_order.delivery_manager_id` 同步为接收人（09-order-ad.md:219“门店的交付经理被写入或更换”）。
- 本门店处于 `assigning` 步骤、未暂停的交付工单，经 delivery 注册的分配实现同事务分配给接收人：`delivery_ticket.step`：`assigning` → `plan_confirm`（`ticket.assign`，10-delivery.md:172），写 `delivery_manager_id`、`assigned_at`，环节时限与定时器的写法同 a05 3.20；每张发 `ticket.assigned`（x01 事件目录）。暂停中的待分配工单不动，恢复后由 a05 3.20 分配。与 a05 3.20“门店还没有交付经理时一并写门店、分配同门店其他待分配工单、同步未结订购单”是同一条规则的两个入口。
- `assignment_history`：不写。改派记录只记“从谁改到谁”（`from_staff_id` 非空），首次指派没有原负责人；“1 个工作日内联系商家”的时限只挂在改派记录上（03-staff-authz-audit.md:420、439），首次指派因此不登记联系时限（是否也要求联系时限见第 6 节第 8 项）。
- `audit_log`：`ops` 流一行，类别 `manager_assign`，`target_type = 'store'`，`after` 记交付经理，`meta.synced` 记同步数量。
- 出站事件：门店一级不发（x01 没有“门店交付经理首次写入”的事件，系统按城市轮询分配的 `order.onSubscriptionActivated` 同样不发）；随同分配的工单发 `ticket.assigned`（通知交付经理）。商家端服务经理名片读时现取（`m.serviceManager.get`，m08）。

**说明**：
- 正常路径是开通套餐后系统按城市轮询分配（订阅者 `order.onSubscriptionActivated`，d3-flow.md:626-630）与开工时兜底轮询；本接口用于轮询池为空或需人工指定的门店（A:Merchants“交付经理：未分配”筛选，`isManagerUnassigned=true`）。
- 已停用的门店也可以指派（处理存量的客服与售后），见 1.1。

### 3.9 admin.assignmentHistory.markContacted　标记已联系商家
`POST /admin/assignment-histories/{assignmentHistoryId}/mark-contacted`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`permission: assert-in-handler`（A45）：当前员工是该行的接收人（`to_staff_id`），或是接收人的主管（同组 `is_lead`）；否则 403 `PERMISSION_DENIED` |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 无（受限更新，由触发器冻结） |
| 对应画板 | 原型无入口；A:Main 工作台“待联系商家”待办（a02）与 A:MerchantDetail 页头的提醒（StoreHeader.managerContact）调用 |
| 出处 | 路线图 `a03.assignment-histories.mark-contacted`；03-staff-authz-audit.md:420、439-443、467-471；PRD 7.4-4 |

**请求**：路径参数 `assignmentHistoryId`。请求体：`{ note?: string（≤200 字，写进审计） }`。

**响应**：AssignmentContactView（2.12）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 记录不存在或门店不在范围内 |
| `STATE_NOT_ALLOWED` | 409 | 该行没有联系时限（不是门店交付经理变更的行），或已联系、已作废 |

**副作用**：
- 写 `assignment_history.contacted_at`、`contacted_by_staff_id`（触发器只允许改联系相关列，写入后冻结）。
- 定时器：同事务取消该行的 `sla.breach`（03-staff-authz-audit.md:471）。
- `audit_log`：`activity` 流一行（`target_type = 'assignment_history'`）。不发出站事件。

**说明**：
- “1 个工作日内通过企业微信联系商家”的事实系统无法检测，由人工标记（`mark-<状态>` 词，C12）。
- 工作台待办 `manager_first_contact`（a02）按 `ix_assignment_history_contact_pending` 现算，标记后该行不再满足条件，待办随之消失，不另调接口关闭。

### 3.10 admin.entity.get　主体卡片与名下门店
`GET /admin/entities/{entityId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看；主体范围（名下任一门店在范围内） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无（响应返回 `lockVersion` 供 3.12 使用） |
| 对应画板 | A:MerchantDetail（门店与成员页签：主体卡片、名下门店表） |
| 出处 | 路线图 `a03.entities.get`；proto-admin-b.md:78、111-112；PRD 7.4-6 |

**请求**：路径参数 `entityId`。

**响应**：EntityCard（2.4）。

**错误**：`NOT_FOUND`（404）。

**副作用**：无。

**说明**：
- 名下门店里不在当前员工数据范围的门店仍列出（只到行级摘要），点击进入详情时由 3.3 判断范围（404）。“去审核”按 `openQualificationSubmissionId` 跳到资质审核页。
- 待接受的邀请随本接口的 `pendingInvitations` 返回（成员表下方的邀请行与“待接受 N 个”），3.11 只返回成员。
- `usage` 经 m02 的 `tenant.getQuotaUsage` 现算：套餐未开通或已过期时取默认参数（1 家门店、3 位成员，05-risks-and-open-issues.md:219），与新增门店、邀请的实际拦截一致。

### 3.11 admin.entity.member.list　主体成员
`GET /admin/entities/{entityId}/members`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看；主体范围 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:MerchantDetail（门店与成员页签：成员表“老板 1 位 · 店员 2 位”；“待接受 1 个”取 3.10 的 `pendingInvitations`）；A:Service（新建客服工单的“提出人”下拉，a08 只取老板） |
| 出处 | 路线图 `a03.entities.list-members`；proto-admin-b.md:78、113；PRD 7.4-6；A78、C43 |

**请求**：路径参数 `entityId`。查询参数：`storeId`（uuid，只看该门店的店员；老板总在内）、`role`（enum(同数据模型 `entity_member.role`)，只看老板或店员）、`includeRemoved`（boolean，默认 `false`；`true` 时含已移除成员）。

**响应**：`{ items: array<MemberRow> }`；老板在前，店员按加入时间。有界小集合，不分页（A78；C43 登记了本 operationId）。

**错误**：`NOT_FOUND`（404）。

**副作用**：无。

**说明**：成员由老板在小程序邀请和管理，后台只读（proto-admin-b.md:105）；账号动作（禁用、启用、强制下线）作用在账号上，见 3.14–3.16。手机号只给脱敏串。第二轮按 C43 把响应从 `{ members, pendingInvitations }` 改为 `{ items }`，待接受的邀请移到主体卡片（3.10）。

### 3.12 admin.entity.quota.update　门店数与成员数上限覆盖
`PATCH /admin/entities/{entityId}/quota`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.quota.override`（仅超级管理员；注册表要求再验证，d4-identity.md:1180）；主体范围 |
| 回显 | `confirm: { storeLimitOverride, memberLimitOverride }`：弹层打开时的两个覆盖值（可为 `null`），与库中比对 |
| 幂等 | required（带锁的 PATCH，A17） |
| 乐观锁 | 带 `lockVersion`（`entity.lock_version`） |
| 对应画板 | 原型未画（建议放在门店与成员页签的主体卡片） |
| 出处 | 路线图 `a03.entities.update-quota`；d4-identity.md:549、2296；02-identity-tenant.md:485-486、552；PRD 12.3 第 14 项 |

**请求**：路径参数 `entityId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| lockVersion | integer | 是 | 等于 `entity.lock_version` | — |
| storeLimitOverride | integer \| null | 否 | ≥1；`null` 清除覆盖、回到按套餐 | → `entity.store_limit_override` |
| memberLimitOverride | integer \| null | 否 | ≥0；`null` 清除覆盖 | → `entity.member_limit_override` |
| reasonText | string | 是 | 1–200 字 | → `audit_log.reason_text` |
| confirm | `{ storeLimitOverride: integer \| null, memberLimitOverride: integer \| null }` | 是 | 等于当前覆盖值 | 回显（C54） |

两个覆盖值至少传一个。

**响应**：EntityCard（新的 `usage` 与 `lockVersion`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 主体不存在或不在范围内 |
| `STATE_NOT_ALLOWED` | 409 | 主体不是 `active` |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符 |
| `CONFIRM_MISMATCH` | 409 | 回显与当前覆盖值不一致 |
| `VALIDATION_FAILED` | 400 | 两个值都没传；取值越界 |
| `STEP_UP_REQUIRED` | 403 | 再验证超出 10 分钟窗口（注册表） |

**副作用**：
- 状态迁移：无。写 `entity.store_limit_override`、`member_limit_override`，`lock_version + 1`。
- `audit_log`：`ops` 流一行，类别 `merchant_quota`（A107），`before`、`after` 记两个覆盖值。
- 不发出站事件；新上限在下一次占用名额的事务里生效（锁主体后现数，d4-identity.md:673）。

**说明**：调低到已用量以下是允许的（02-identity-tenant.md:552）：不停用门店、不移除成员，`usage.isOverLimit` 为真，此后该主体新订购与新广告由订购、广告模块拦截（`QUOTA_EXCEEDED`，m02 定义）。

### 3.13 admin.entity.close　后台关闭经营主体
`POST /admin/entities/{entityId}/close`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.entity.close`（增补键，建议仅超级管理员、要求再验证）；主体范围 |
| 回显 | `confirm: { activeStoreCount, activeMemberCount }`：弹层上展示的启用门店数（EntityCard.usage.storesUsed）与有效成员数（含老板，EntityCard.usage.activeMemberCount；不是 `seatsUsed`），与当前值比对 |
| 幂等 | required（状态迁移） |
| 乐观锁 | 无（`entity.close` 的守卫没有列锁版本，02-identity-tenant.md:525） |
| 对应画板 | 原型无（数据模型状态机有“后台关闭”，原型与草案都没有入口；建议放在主体卡片的更多操作） |
| 出处 | 路线图 `a03.entities.close`；02-identity-tenant.md:525、531-532、610；d4-identity.md:429、796-801 |

**请求**：路径参数 `entityId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| reasonText | string | 是 | 10–200 字 | 关闭原因 → `audit_log.reason_text`、`status_transition.note` |
| confirm | `{ activeStoreCount: integer, activeMemberCount: integer }` | 是 | 等于当前值 | 回显（C54） |

**响应**：EntityCard（`lifecycle = 'closed'`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 主体不存在或不在范围内 |
| `STATE_NOT_ALLOWED` | 409 | 主体已是 `abandoned` 或 `closed` |
| `ENTITY_CLOSE_BLOCKED` | 409 | 主体有生效套餐、在办订购、上线中成片、未完结的付款 / 退款 / 开票任一项（同老板注销的前置条件，d4-identity.md:429）；`details.blockers` 为 `DeletionBlocker[]`（结构与 `DeletionBlockerKind` 归 m01-account 2.11，本文复用；与 m01 注销是同一组阻断检查端口，其中计费四项 `subscription_active`、`payment_open`、`refund_open`、`invoice_open` 调 m07 第 1 节的 `billing.deletionGuard(entityId)`） |
| `CONFIRM_MISMATCH` | 409 | 回显与当前门店数、成员数不一致 |
| `STEP_UP_REQUIRED` | 403 | 注册表为该键标了再验证且超出窗口 |

**副作用**（一个事务，先锁主体行，d4-identity.md:796-801；下列成员、邀请、门店与下载页会话的联动调 m02 第 1 节登记的“主体关闭联动”函数，与 m01 老板注销是同一函数，02-identity-tenant.md:531）：
- 状态迁移：
  - `entity.lifecycle`：`active` → `closed`（`entity.close`，02-identity-tenant.md:525），写 `closed_at`。
  - `invitation.status`：`pending` → `revoked`（`invitation.revoke`，`revoke_reason = 'entity_closed'`，操作人为当前员工），并取消各自的 `invitation.expire` 定时器（02-identity-tenant.md:788、794）。
  - `entity_member.status`：`active` → `removed`（`entity_member.cascade_remove`，`remove_reason = 'entity_closed'`；含老板），同事务删除其 `store_member` 行（02-identity-tenant.md:692-697）。
  - `store.lifecycle`：`active` → `archived`（`store.archive_by_entity`，`archive_reason = 'entity_closed'`，02-identity-tenant.md:610），逐家写状态历史。
  - 取消申请（x01 第 5 节把 09-order-ad.md:550 归到本事务）：该主体下仍待审批的 `cancel_request`，经 order 注册的端口同事务由系统撤回：`cancel_request.status`：`pending_approval` → `not_executed`（`close_reason = 'withdrawn'`，“对象失效时系统”，09-order-ad.md:550），其审批单 `approval_request.status`：`pending` → `withdrawn`（`withdraw`，操作人 `system`，`is_decided_by_system = true`，03-staff-authz-audit.md:807、822）。订购取消与整店取消的对象是在办订购，已被 `open_order` 阻断（A134 统一的取值名），实际走到这一步的多为广告取消。
  - 以上各写一行 `status_transition` 与对应的审计行（M31）。
- 下载页会话：该主体未吊销的 `portal_session` 置 `revoke_reason = 'membership_changed'`（02-identity-tenant.md:265）。
- 出站事件（事件名与载荷按 x01 事件目录）：`entity.closed { entityId, closedBy: 'staff_close' }`（与老板注销的 `owner_deletion` 区分）；每家门店一条 `store.archived { archiveReason: 'entity_closed' }`；每个被撤回的邀请一条 `invitation.revoked`；每个被移除的成员一条 `entity_member.removed`；每张被系统撤回的取消申请一条 `cancel.withdrawn`，其审批单一条 `approval.withdrawn`。订阅方：profile 撤回在审轮次、丢弃草稿、释放证照与档案引用（04-profile.md:678-682）；通知模块通知被移除的成员（02-identity-tenant.md:1022-1027）。
- `audit_log`：主体迁移那一行用 `ops` 流（原因与回显），类别 `merchant_lifecycle`（A107）。

**说明**：
- 关闭不可逆（`closed` 是终态）。草案没有后台关闭的接口，本接口按数据模型状态机补出；前置条件与老板注销一致，`blockers` 由 m01 注销所用的同一组检查端口给出（各模块注册；计费四项为 m07 `billing.deletionGuard`）；成员、邀请、门店的联动调 m02 的主体关闭联动函数，本接口只补后台特有的部分（回显、`closedBy = staff_close`、待审批取消申请的系统撤回）。
- 在审的资质轮次不阻断关闭，由 profile 订阅 `entity.closed` 后系统撤回（`qualification.withdraw`，见 x01）。

### 3.14 admin.merchantUser.disable　禁用商家账号
`POST /admin/merchant-users/{merchantUserId}/disable`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.user.disable`（仅主管，要求再验证，d4-identity.md:1177）；账号所在主体在范围内（没有成员关系的账号只有数据范围 `all` 的员工能操作） |
| 回显 | `confirm: { phoneMask }`：与 `merchant_user.phone_mask` 比对 |
| 幂等 | required（状态迁移） |
| 乐观锁 | 无（`merchant_user.disable` 的守卫没有列锁版本，02-identity-tenant.md:126） |
| 对应画板 | 原型未画；建议放在门店与成员页签的成员行（MemberRow.actions） |
| 出处 | 路线图 `a03.merchant-users.disable`；02-identity-tenant.md:121-130、146；d4-identity.md:438、2295 |

**请求**：路径参数 `merchantUserId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| reasonText | string | 是 | 1–200 字 | 禁用原因 → `audit_log.reason_text`、`status_transition.note` |
| confirm | `{ phoneMask: string }` | 是 | 等于当前脱敏串 | 回显（C54） |

**响应**：MerchantUserStatusView（2.4）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 账号不存在或不在范围内 |
| `STATE_NOT_ALLOWED` | 409 | 账号不是 `active`（已禁用或已注销） |
| `CONFIRM_MISMATCH` | 409 | 回显与当前手机号脱敏串不一致 |
| `STEP_UP_REQUIRED` | 403 | 再验证超出窗口 |

**副作用**：
- 状态迁移：`merchant_user.status`：`active` → `disabled`（`merchant_user.disable`，02-identity-tenant.md:126），写 `status_transition`。
- 吊销该账号全部未吊销的 `user_session`（`revoke_reason = 'admin'`）与其授权的 `portal_session`（`revoke_reason = 'account_action'`），下一请求 401（d4-identity.md:438；`identity.I22`）。
- `audit_log`：`ops` 流一行，类别 `account_security`。
- 出站事件：迁移事件 `merchant_user.disabled`（x01 事件目录）。

**说明**：禁用老板时主体将无人可操作，前端在确认弹层上用 MemberRow 的角色提示（d4-identity.md:438），响应的 `activeOwnerEntityIds` 供页面刷新。禁用不改成员关系。

### 3.15 admin.merchantUser.enable　启用商家账号
`POST /admin/merchant-users/{merchantUserId}/enable`

| 项 | 内容 |
| --- | --- |
| 鉴权 | 同 3.14（权限点 `merchant.user.disable`，同一键管禁用与启用） |
| 回显 | `confirm: { phoneMask }` |
| 幂等 | required（状态迁移） |
| 乐观锁 | 无 |
| 对应画板 | 同 3.14 |
| 出处 | 路线图 `a03.merchant-users.enable`；02-identity-tenant.md:127；d4-identity.md:2295 |

**请求**：路径参数 `merchantUserId`。请求体同 3.14（`reasonText` 必填，02-identity-tenant.md:127 的守卫“同上”）。

**响应**：MerchantUserStatusView。

**错误**：`NOT_FOUND`（404）；`STATE_NOT_ALLOWED`（409，账号不是 `disabled`）；`CONFIRM_MISMATCH`（409）；`STEP_UP_REQUIRED`（403）。

**副作用**：
- 状态迁移：`merchant_user.status`：`disabled` → `active`（`merchant_user.enable`，02-identity-tenant.md:127），写 `status_transition`。
- 不恢复已吊销的会话，商家重新登录。
- `audit_log`：`ops` 流一行，类别 `account_security`。出站事件 `merchant_user.enabled`（x01 事件目录）。

**说明**：无。

### 3.16 admin.merchantUser.forceLogout　强制下线
`POST /admin/merchant-users/{merchantUserId}/force-logout`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.user.force_logout`（客服，d4-identity.md:1178）；账号所在主体在范围内 |
| 回显 | `confirm: { phoneMask }` |
| 幂等 | required（吊销会话并写审计，A17） |
| 乐观锁 | 无 |
| 对应画板 | 原型未画；成员行操作 |
| 出处 | 路线图 `a03.merchant-users.force-logout`；d4-identity.md:401、2295；02-identity-tenant.md:170 |

**请求**：路径参数 `merchantUserId`。请求体：`{ reasonText?: string（≤200 字）, confirm: { phoneMask } }`。

**响应**：MerchantUserStatusView。

**错误**：`NOT_FOUND`（404）；`STATE_NOT_ALLOWED`（409，账号已注销）；`CONFIRM_MISMATCH`（409）。

**副作用**：
- 状态迁移：无（会话吊销是技术状态）。
- 吊销全部 `user_session`（`revoke_reason = 'admin'`）与其授权的 `portal_session`（`revoke_reason = 'account_action'`）；该账号全部 `wechat_identity.silent_login_enabled` 置 `false`，重新用手机号登录后恢复（d4-identity.md:401）。
- `audit_log`：`ops` 流一行，类别 `account_security`。

**说明**：用于“账号主人的微信都不在了”与疑似被他人登录的处置（d4-identity.md:399）。重复调用无害（同键重放返回上次结果；换键再调时吊销数为 0）。

### 3.17 admin.accountChangeRequest.list　账号变更申请列表
`GET /admin/account-change-requests`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看；主体范围（没有主体的换绑、复核申请只对数据范围 `all` 的员工与发起人可见） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | 原型无；放在商家详情门店与成员页签（申请记录），“我的待审批”列表用 `admin.approval.list`（a01） |
| 出处 | 路线图 `a03.account-change-requests.list`；d4-identity.md:2297；02-identity-tenant.md:423；A14、A16 |

**请求**：查询参数：

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| entityId | string(uuid) | 否 | — | `account_change_request.entity_id` |
| merchantUserId | string(uuid) | 否 | — | `account_change_request.merchant_user_id` |
| kind | string | 否 | 逗号分隔，取值同 `account_change_request.kind` | 类型 |
| status | string | 否 | 逗号分隔，取值同 `approval_request.status` | 审批状态 |
| page、pageSize | integer | 否 | C43 | — |

**响应**：`{ items: array<AccountChangeRequestCard>, page, pageSize, total }`，按提交时间倒序。

**错误**：无。

**副作用**：无。

**说明**：
- 资源名按 A14 改为 `account-change-requests`（原 `a03.account-changes.list`）。
- 工作台待办 `account_change_approval`（a02）与本接口 `status=pending` 同口径：审批单 `kind = 'account_change'`、`status = 'pending'`，套同一数据范围，共用同一个带范围的查询构造函数；“我的待审批”列表与计数走 a01 `admin.approval.list` / `summary`（`kind = account_change`）。资质审核的队列与计数同样在 a01（`kind = qualification`）。

### 3.18 admin.accountChangeRequest.create　发起账号变更
`POST /admin/account-change-requests`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.account_change.request`（客服，d4-identity.md:1179）；目标在发起人数据范围内 |
| 回显 | `confirm: { targetPhoneMask }`：换绑、复核时为目标账号的手机号脱敏串，老板更换时为现任老板的手机号脱敏串 |
| 幂等 | required |
| 乐观锁 | 无 |
| 对应画板 | 原型无（商家详情门店与成员页签发起） |
| 出处 | 路线图 `a03.account-change-requests.create`；02-identity-tenant.md:395-466、993；03-staff-authz-audit.md:804、901、919；d4-identity.md:404-418、465、766-777、1490 |

**请求**：请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| kind | enum(同数据模型 `account_change_request.kind`) | 是 | — | 换绑手机号、老板更换、老板复核 |
| merchantUserId | string(uuid) | 条件 | 换绑、复核必填；老板更换不传 | → `account_change_request.merchant_user_id` |
| entityId | string(uuid) | 条件 | 老板更换必填；换绑、复核由服务端取账号的有效成员关系所属主体，没有则空 | → `account_change_request.entity_id` |
| newPhone | string | 条件 | 换绑、老板更换必填；11 位中国大陆手机号 | 加密 → `new_phone_enc`，脱敏 → `new_phone_mask`；明文不进日志与审计 |
| proofFileIds | array<string(uuid)> | 条件 | 换绑、老板更换 1–9 个；复核可空；分类 `account_proof` | → `account_change_request.proof_file_ids`，逐个 `files.link(account_change_request / proof)` |
| verifyMethod | string | 条件 | 复核必填，≤50 字 | → `account_change_request.verify_method` |
| verifyRecord | string | 条件 | 复核必填，≤500 字 | → `account_change_request.verify_record` |
| reasonCode | string | 是 | 字典 `account_change_reason` 启用项 | → `account_change_request.reason_code` |
| reasonText | string | 是 | 1–500 字 | → `account_change_request.reason_text` |
| confirm | `{ targetPhoneMask: string }` | 是 | 见“回显” | 回显（C54） |

**响应**：AccountChangeRequestDetail（审批单 `pending`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 目标账号或主体不存在、不在范围内 |
| `STATE_NOT_ALLOWED` | 409 | 目标账号已注销；老板更换的主体不是 `active`；复核的目标不是有效老板 |
| `APPROVAL_ALREADY_PENDING` | 409 | 同一对象已有一张在审的同类申请（`uq_approval_request_dedupe_key_pending`）；`details` 带在审单号 |
| `PHONE_UNCHANGED` | 400 | 换绑的新号码与当前号码相同（m01 定义） |
| `PHONE_TAKEN` | 409 | 换绑的新号码已被另一个账号使用，且该账号在 `entity_member` 里有过任何一行（含已移除）或不是 `active`（m01 定义）；占用方是从未有过成员关系的 `active` 空账号时不拦，通过时清理 |
| `PHONE_IN_OTHER_ENTITY` | 409 | 老板更换的新老板在其他主体有有效成员关系（m02 定义） |
| `CONFIRM_MISMATCH` | 409 | 回显与当前手机号脱敏串不一致 |
| `FILE_NOT_USABLE` | 400 | 证明材料不可用或分类不是 `account_proof`（m03 定义） |
| `VALIDATION_FAILED` | 400 | 条件必填缺项；手机号格式不对；原因编码不存在 |

**副作用**（一个事务）：
- 状态迁移：`approval_request.status`：（新建）→ `pending`（`submit`，03-staff-authz-audit.md:804）：`kind = 'account_change'`、`category = 'approval'`、`subject_type` 为 `merchant_user`（换绑、复核）或 `entity`（老板更换）、`request_no = ZH…`、`dedupe_key`（`account_change:phone_rebind:{merchantUserId}`、`account_change:owner_reverify:{merchantUserId}`、`account_change:owner_transfer:{entityId}`）、`submit_actor_type = 'staff'`、`submit_client = 'admin'`、`requester_staff_id`、`requester_staff_group_id`（发起时快照）、`idempotency_key`；`summary_snapshot` 由 identity 注册的处理器生成（只放脱敏值，02-identity-tenant.md:993）。
- 插入 `account_change_request`（与审批单一对一）；`file_ref` 登记证明材料。
- 决定时限：参数表没有账号变更的时限策略，`due_at`、`sla_snapshot` 为空，不登记定时器；超期由 `approval.I5`（`approval.escalate_workdays`）列入“待审批超期”清单（03-staff-authz-audit.md:832）。
- 出站事件：`approval.submitted`（聚合 `approval_request`），通知模块按 `s.approval_pending` 通知有审批权的人。
- `audit_log`：`ops` 流一行（审批单迁移），类别 `account_security`。

**说明**：
- 三类都只能由客服在后台发起（d4-identity.md:1479）；商家自助换绑走 m01。
- 发起时的前置校验与通过时的重算是同一组规则（d4-identity.md:1490）：通过时若已变化返回 `PRECONDITION_CHANGED`，不在这里锁定号码。
- 老板复核只用于休眠保护拦下的老板（`REVERIFY_REQUIRED`，d4-identity.md:465）。

### 3.19 admin.accountChangeRequest.get　账号变更申请详情
`GET /admin/account-change-requests/{accountChangeRequestId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看；主体范围（同 3.17） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无（响应的 `approval.lockVersion` 供 3.20 使用） |
| 对应画板 | 原型无；商家详情的申请记录与“我的待审批”详情（A16） |
| 出处 | 路线图 `a03.account-change-requests.get`；d4-identity.md:2297；A14、A16、A19 |

**请求**：路径参数 `accountChangeRequestId`。

**响应**：AccountChangeRequestDetail（2.8）。

**错误**：`NOT_FOUND`（404）。

**副作用**：无。

**说明**：新手机号只回脱敏值（A19）；审批人核对完整号码走 `admin.piiReveal.create`（对象 `account_change_request`、字段 `newPhone`，只在待审时可看，需 `pii.phone.reveal`）。证明材料经 `admin.file.downloadUrls` 签发。`precheck` 是读时现算的提示，不写库。

### 3.20 admin.accountChangeRequest.approve　通过账号变更
`POST /admin/account-change-requests/{accountChangeRequestId}/approve`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.account_change.approve`（仅主管；审批要再验证，d4-identity.md:1179、1437）；主体范围；审批人 ≠ 发起人 |
| 回显 | `confirm: { requestNo, newPhoneMask }`（复核时 `newPhoneMask` 传 `null`） |
| 幂等 | required（状态迁移） |
| 乐观锁 | 带 `lockVersion`（审批单 `approval_request.lock_version`，`approve` 的守卫列了锁版本，03-staff-authz-audit.md:805；C53） |
| 对应画板 | 原型无（“我的待审批”页，A16；设计规范第 12 节） |
| 出处 | 路线图 `a03.account-change-requests.approve`；02-identity-tenant.md:439-451、693-697；03-staff-authz-audit.md:805、810；d4-identity.md:412-418、766-777、1398-1412 |

**请求**：路径参数 `accountChangeRequestId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| lockVersion | integer | 是 | 等于审批单当前锁版本 | — |
| confirm | `{ requestNo: string, newPhoneMask: string \| null }` | 是 | 等于单号与新号码脱敏串 | 回显（C54） |
| confirmChecks | array<string> | 否 | 0–10 项，界面核对项编码（如 `proof_checked`、`callback_done`）；缺省为空数组 | → `approval_request.confirm_checks` |

**响应**：AccountChangeRequestDetail（审批单 `approved`，带 `appliedAt` 与 `result`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 申请不存在或不在范围内 |
| `APPROVAL_NOT_PENDING` | 409 | 审批单已决或已撤回 |
| `APPROVAL_SELF_FORBIDDEN` | 403 | 审批人就是发起人（超级管理员也不例外） |
| `STEP_UP_REQUIRED` | 403 | 再验证超出窗口 |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符（两名审批人同时处理） |
| `CONFIRM_MISMATCH` | 409 | 单号或新号码脱敏串不一致 |
| `PRECONDITION_CHANGED` | 409 | 事务内重算前置条件已变：新号码的占用方在 `entity_member` 里有过任何一行（含已移除）或不是 `active`、新老板已在其他主体、目标账号已注销、主体已不是 `active`；`details.reason` 取 2.8 `precheck` 的编码；申请保持 `pending` |

**副作用**（一个事务；加锁：审批单 → 本申请 → 账号 → 主体，02-identity-tenant.md:449）：
- 状态迁移：`approval_request.status`：`pending` → `approved`（`approve`），写 `decided_by_staff_id`、`decided_at`、`confirm_checks`，`lock_version + 1`。
- 按 `kind` 同事务执行（处理器 `onApproved`，02-identity-tenant.md:441-445）：
  - `phone_rebind`：与 m01 `m.me.changePhone` 共用同一个换绑函数（除核销验证码外的各步，m01-account 3.7 说明）：
    - 占用新号码的是 `active` 且在 `entity_member` 里没有任何行的空账号时，清理它：`merchant_user.status`：`active` → `deleted`（`merchant_user.purge_empty`，操作人 `system`，02-identity-tenant.md:129），并按 02 第 2.1 节“置为 `deleted` 的事务”做完六步（02-identity-tenant.md:132-139）：① 吊销并删除其会话与下载页会话，删除其微信身份；② 删除其短信验证码、一次性提示、企业微信关系行；③ 成员关系：空账号从未有过，无事可做；④ 以该账号为对象、仍在审的账号变更申请由系统代撤（`approval_request`：`pending` → `withdrawn`，`is_decided_by_system = true`，处理器清空 `new_phone_enc`，每张发 `approval.withdrawn`）；⑤ 清空手机号四列与称呼，写 `merchant_user.deleted_at`（`ck_merchant_user_pii_by_status`）；⑥ 出站事件 `merchant_user.deleted { reason: 'purge_empty' }`。
    - 目标账号的 `phone_enc`、`phone_bidx`、`phone_mask`、`phone_last4` 改为新号码；吊销目标账号全部 `user_session`（`revoke_reason = 'phone_change'`；后台代办没有“当前会话”可保留）；出站事件 `merchant_user.phone_changed { via: 'approval', accountChangeRequestId }`；提交后调 `notify.sendDirect`（`purpose = account_notice`）给原号码发安全短信，原号码明文只在内存（02-identity-tenant.md:451）。
  - `owner_transfer`（d4-identity.md:771-776；02-identity-tenant.md:444、690-697；A143），同一事务按下列次序：
    1. 取号或建号并锁账号行：新号码已有账号的取用；没有账号的按号码建号，迁移沿用 `merchant_user.register`（— → `active`，02-identity-tenant.md:125）：不检查协议同意（`consent_stamp` 为空）、`source_type = 'organic'`、`last_active_at` 取建号时刻（免得首次登录被判为休眠），写 `status_transition`，同事务发 `merchant_user.registered`（载荷带 `via: 'owner_transfer'`）。再锁主体行。
    2. 先移除原老板：`entity_member.status`：`active`（owner）→ `removed`（`entity_member.cascade_remove`，`remove_reason = 'owner_transfer'`，02-identity-tenant.md:694），删其 `store_member`（老板本无），吊销其授权的 `portal_session`（`membership_changed`），发 `entity_member.removed`。
    3. 再立新老板：新老板是本主体店员的，`entity_member`：`active`（clerk）→ `active`（owner）（`entity_member.promote_owner`，from = to，删其 `store_member`，02-identity-tenant.md:693），发 `entity_member.promoted`（通知模块据此通知双方与服务经理，d4-identity.md:775）；不是本主体店员的，新建老板成员行：`entity_member`：— → `active`（owner）（`entity_member.create_owner`，`invitation_id`、`invited_by_member_id` 为空，02-identity-tenant.md:690），同样发 `entity_member.promoted { entityMemberId, entityId, merchantUserId }`（`fromState` 为空，迁移码 `entity_member.create_owner`；x01 3.2，A143）。两支都是一张申请发一条。次序不能反：`uq_entity_member_one_owner` 是部分唯一索引，不能延迟检查（02-identity-tenant.md:697）。
    4. 新老板已在其他主体有有效成员关系的，在第 1 步之前的前置条件重算里返回 `PRECONDITION_CHANGED`（`new_owner_in_other_entity`），不会撞 `uq_entity_member_one_entity`（02-identity-tenant.md:697）。
  - `owner_reverify`：`merchant_user.dormant_bypass_until = now + 72 小时`。
- `account_change_request`：写 `applied_at`、`result_snapshot`（按 `kind`，02-identity-tenant.md:965-973），`new_phone_enc` 置空。
- 出站事件：`approval.approved`；通知模块按 `s.approval_decided` 通知发起人。
- `audit_log`：审批单迁移一行（`ops` 流，类别 `account_security`），随审批单联动的领域迁移并入这一行（03-staff-authz-audit.md:641）。

**说明**：
- 决定接口挂在领域资源上（A14），原 `a01.approvals.approve` 的 `kind = account_change` 由本接口承担。
- 新老板账号若为本次新建：迁移码仍是 `merchant_user.register`，但不检查协议同意（`consent_stamp` 为空），首次登录时由协议同意中间件补同意（C73；02-identity-tenant.md:125，A143）；`merchant_user.registered` 的 `via = 'owner_transfer'` 让订阅方区分它与首次手机号登录。
- 账号变更没有清单模板，`confirmChecks` 可选，缺省为空数组。

### 3.21 admin.accountChangeRequest.reject　驳回账号变更
`POST /admin/account-change-requests/{accountChangeRequestId}/reject`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.account_change.approve`（仅主管）；主体范围；审批人 ≠ 发起人 |
| 回显 | `confirm: { requestNo }`；`x-step-up: skip`（A127、C86 登记表第一行）：该键在注册表里标了再验证，驳回不检查（03-staff-authz-audit.md:806“不要求 step-up”）；权限点、仅主管、审批人 ≠ 发起人、`confirm` 照常检查 |
| 幂等 | required（状态迁移） |
| 乐观锁 | 无（`reject` 的守卫没有列锁版本，03-staff-authz-audit.md:806；A21） |
| 对应画板 | 原型无（“我的待审批”页） |
| 出处 | 路线图 `a03.account-change-requests.reject`；03-staff-authz-audit.md:806、814；02-identity-tenant.md:447 |

**请求**：路径参数 `accountChangeRequestId`。请求体：`{ note: string（必填，1–200 字，→ approval_request.decision_note）, confirm: { requestNo } }`。账号变更没有驳回原因字典场景，不收原因编码（03-staff-authz-audit.md:806）。

**响应**：AccountChangeRequestDetail（审批单 `rejected`）。

**错误**：`NOT_FOUND`（404）；`APPROVAL_NOT_PENDING`（409）；`APPROVAL_SELF_FORBIDDEN`（403）；`CONFIRM_MISMATCH`（409）；`VALIDATION_FAILED`（400，说明为空）。

**副作用**：
- 状态迁移：`approval_request.status`：`pending` → `rejected`（`reject`），写 `decided_by_staff_id`、`decided_at`、`decision_note`。
- 处理器 `onRejected`：`account_change_request.new_phone_enc` 置空（03-staff-authz-audit.md:814）。
- 出站事件 `approval.rejected`；`audit_log` `ops` 流一行。

**说明**：无。

### 3.22 admin.accountChangeRequest.withdraw　撤回账号变更
`POST /admin/account-change-requests/{accountChangeRequestId}/withdraw`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`permission: assert-in-handler`（A15、A45）：当前员工是发起人（`approval_request.requester_staff_id`）；或发起人已不是启用状态，且当前员工持 `merchant.account_change.approve`（含仅主管判断）并在范围内（代撤）。其余 403 `APPROVAL_WITHDRAW_FORBIDDEN` |
| 回显 | `confirm: { requestNo }` |
| 幂等 | required（状态迁移） |
| 乐观锁 | 无 |
| 对应画板 | 原型无（申请记录的“撤回”） |
| 出处 | 路线图 `a03.account-change-requests.withdraw`；03-staff-authz-audit.md:807、816-822；A15 |

**请求**：路径参数 `accountChangeRequestId`。请求体：`{ note?: string（≤200 字，→ approval_request.decision_note）, confirm: { requestNo } }`。

**响应**：AccountChangeRequestDetail（审批单 `withdrawn`）。

**错误**：`NOT_FOUND`（404）；`APPROVAL_NOT_PENDING`（409）；`APPROVAL_WITHDRAW_FORBIDDEN`（403）；`CONFIRM_MISMATCH`（409）。

**副作用**：
- 状态迁移：`approval_request.status`：`pending` → `withdrawn`（`withdraw`），写 `decided_at`（`decided_by_staff_id` 为空）。
- 处理器 `onWithdrawn`：`new_phone_enc` 置空。
- 代撤时审计写明代撤人与原发起人；出站事件 `approval.withdrawn`（x01 事件目录）；`audit_log` `ops` 流一行。

**说明**：商家用户注销时以该账号为对象的在审申请由系统代撤（`is_decided_by_system = true`，03-staff-authz-audit.md:822），归 x01 的非 HTTP 迁移，不经本接口。

### 3.23 admin.qualificationSubmission.get　资质审核详情
`GET /admin/qualification-submissions/{qualificationSubmissionId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看；门店范围 |
| 回显 | 无 |
| 幂等 | none（纯查询，A19） |
| 乐观锁 | 无（响应的 `approval.lockVersion`（审批单）供 3.26 使用，顶层 `lockVersion`（轮次）供 3.24 使用） |
| 对应画板 | A:Review（右栏：商家与主体、档案摘要、状态与截止、系统比对结论、证照页签、原图、识别结果表、关联单据说明） |
| 出处 | 路线图 `a03.qualification-submissions.get`；d9-profile.md:501-520、686；proto-admin-b.md:133-137；03-staff-authz-audit.md:891；A14、A16、A19 |

**请求**：路径参数 `qualificationSubmissionId`。

**响应**：QualificationSubmissionDetail（2.7）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 轮次不存在、是草稿（未提交），或门店不在范围内 |

**副作用**：无（GET 不写库：原“每张审批单每人每次打开记一条 access 审计”的写法取消，A19）。

**说明**：
- 左栏队列、页签计数（待审核 / 今日已审核）与“我的待审批”由 a01 的 `admin.approval.list`、`admin.approval.summary` 给出（`kind = qualification`），列表项的 `domain` 指向本资源；队列行取审批单的 `summary_snapshot`（由 profile 的处理器在提交时生成，取值见 m03 3.17）：`title` 为送审门店名称，`lines` 依次为“门店”“主体”“品类”“区域”“提交类型”，`domain = { type: 'qualification_submission', id }`（审核队列据此跳到本接口）。
- 识别结果表只给脱敏值；审核员要逐字核对时：原图走 `admin.file.downloadUrls`（5 分钟，写 access 审计），字段明文走 `admin.piiReveal.create`（对象 `qualification_doc`，需 `merchant.qualification.review` 或 `pii.license.view`）。这改变了 d9-profile.md:517 的默认做法（GET 回明文），见第 6 节第 3 项。
- `checkSummary.fail > 0` 时前端禁用“审核通过”、提示“存在异常项，请驳回并告知商家补正”（proto-admin-b.md:144），另给“修正字段”（3.24）与持权限“放行”两个出口（d9-profile.md:514）；“放行”按钮按 `canOverride` 显示。
- 关联单据说明与新增门店说明的文字由前端按 `relatedOrders`（含 `title`）与 `entity.verifiedAt`、`entity.verifiedStores` 拼出。

### 3.24 admin.qualificationDoc.update　修正识别字段
`PATCH /admin/qualification-docs/{qualificationDocId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.qualification.review`（d4-identity.md:1174）；门店范围 |
| 回显 | 不另带 `confirm`：以轮次的 `lockVersion` 防过期 |
| 幂等 | required（带锁的 PATCH，A17） |
| 乐观锁 | 带 `lockVersion`（所属轮次 `qualification_submission.lock_version`，取 3.23 响应顶层的 `lockVersion`，不是 `approval.lockVersion`；证照行以轮次为聚合根，04-profile.md:258、387） |
| 对应画板 | A:Review（原型没有修正入口；在识别结果表旁补“修正字段”） |
| 出处 | 路线图 `a03.qualification-docs.update-reviewed-fields`；d9-profile.md:508、514、646、687；d5-media.md:1896；04-profile.md:405、598-607；05-risks-and-open-issues.md:272 |

**请求**：路径参数 `qualificationDocId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| lockVersion | integer | 是 | 等于轮次当前锁版本（QualificationSubmissionDetail.lockVersion） | — |
| fields | object | 是 | 键按证照类型：营业执照与分支机构执照为 `name`、`uscc`、`principal`、`principalRole`、`subjectType`、`validFrom`、`validTo`（可为 `long_term`）、`address`、`businessScope`（同 d5 `BusinessLicenseFields`）；许可证为字典 `permit_type` 配置的字段键 | 只传要修正的键；与提交值合并后整体加密 → `qualification_doc.reviewed_fields_enc` |
| note | string | 否 | ≤200 字 | 修正理由 → `audit_log.reason_text` |

**响应**：QualificationSubmissionDetail（新的比对结论与 `checkSummary`；顶层 `lockVersion`（轮次）与 `approval.lockVersion`（审批单）都已加 1）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 证照行不存在、已移除，或门店不在范围内 |
| `APPROVAL_NOT_PENDING` | 409 | 所属轮次不在审（草稿、已关闭） |
| `VERSION_CONFLICT` | 409 | 轮次锁版本不符（另一位审核员刚修正过） |
| `VALIDATION_FAILED` | 400 | 键不属于该证照类型；信用代码格式不符；日期格式不符 |

**副作用**（一个事务；加锁：审批单（30）→ 轮次（65）→ 证照行）：
- 状态迁移：无（轮次与证照行都没有状态列；审批单只升锁版本，不迁移）。
- 审批单 `approval_request.lock_version + 1`：通过（3.26）的守卫是“审批单 `lock_version` 一致”（03-staff-authz-audit.md:805），修正后升审批单的锁版本，使其他审核员基于修正前比对结果的“通过”返回 `VERSION_CONFLICT`，不会在没看过修正值的情况下被记为 `approve_mode = 'corrected'`（A143，已回写 03-staff-authz-audit.md:759 的“只升锁版本”与 04-profile.md:333；不迁移、不写状态历史；驳回不带锁版本，不受影响）。`approval_request` 的不可改列不含 `lock_version`（`trg_approval_request_immutable`）。
- 写 `qualification_doc.reviewed_fields_enc`，并按“修正值，否则提交值”重写派生列：`holder_name`、`cert_no_enc`、`cert_no_bidx`、`cert_no_mask`、`principal_name_enc`、`principal_name_mask`、`principal_role`、`subject_type`、`valid_start_date`、`valid_end_date`、`is_long_term`（04-profile.md:607）。
- 调 `ocr.runFieldChecks` 在本轮全部未移除的证照上重跑比对，写各行 `qualification_doc.field_checks`、轮次的 `check_summary`、`checks_ran_at`；`qualification_submission.lock_version + 1`。
- `audit_log`：`activity` 流一行（`target_type = 'qualification_doc'`），`before`、`after` 记修正的键（值脱敏，d9-profile.md:508“修正前后值记审计”）。

**说明**：
- 修正后若比对不再有“不通过”项，通过时 `approve_mode = 'corrected'`（3.26）。
- 草案写作 `PUT /approvals/{id}/qualification/docs/{docId}/reviewed-fields`（三层嵌套），按嵌套规则改到证照行资源（C9）。
- 请求体含证照明文（审核员按原图录入），按 C40 不进访问日志与审计原文。

### 3.25 admin.qualificationSubmission.rejectQuote　终局驳回影响预览
`POST /admin/qualification-submissions/{qualificationSubmissionId}/reject-quote`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.qualification.review`；门店范围 |
| 回显 | 无 |
| 幂等 | none（试算，A20） |
| 乐观锁 | 无 |
| 对应画板 | A:Review（驳回弹层勾选“无法补正”时展示的影响） |
| 出处 | 路线图 `a03.qualification-submissions.reject-quote`；d3-flow.md:2376、3534；d9-profile.md:527、689、736 |

**请求**：路径参数 `qualificationSubmissionId`；请求体无（`{}`）。

**响应**：FinalRejectImpact（2.7）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 轮次不存在或不在范围内 |
| `APPROVAL_NOT_PENDING` | 409 | 轮次不在审 |
| `QUALIFICATION_FINAL_NOT_ALLOWED` | 409 | `change` 轮次不能终局驳回（04-profile.md:346） |

**副作用**：无（不写库、不缓存，A20）。

**说明**：数据在 L3，经 `QualificationImpactPort.previewFinalReject` 由 order 实现（d9-profile.md:735）。驳回时把三个数作为回显带回（3.27）。原 `GET …/rejection-impact`、草案 `GET /approvals/{id}/final-reject-preview` 按 A20 改为本接口。

### 3.26 admin.qualificationSubmission.approve　资质审核通过
`POST /admin/qualification-submissions/{qualificationSubmissionId}/approve`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；路由权限点 `merchant.qualification.review`；`mode = override` 时处理器在取到对象后追加判定 `merchant.qualification.override`（仅超级管理员，d4-identity.md:1175），不满足 403 `PERMISSION_DENIED`（1.1“处理器追加判定”）；门店范围 |
| 回显 | `confirm: { roundNo }`：与审批单与轮次的 `round_no` 比对 |
| 幂等 | required（状态迁移） |
| 乐观锁 | 带 `lockVersion`（审批单 `approval_request.lock_version`，03-staff-authz-audit.md:805） |
| 对应画板 | A:Review（“审核通过”） |
| 出处 | 路线图 `a03.qualification-submissions.approve`；d9-profile.md:503-520、532-563；04-profile.md:339-362、464；02-identity-tenant.md:541、623、627；03-staff-authz-audit.md:805；A14 |

**请求**：路径参数 `qualificationSubmissionId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| lockVersion | integer | 是 | 等于审批单当前锁版本 | — |
| mode | enum `ApproveModeInput` | 否 | 默认 `normal` | `normal`：比对无“不通过”项（含修正后）；`override`：仍有“不通过”项时持权限放行 |
| overrideReason | string | 条件 | `mode = override` 时必填，10–200 字 | → `approval_request.decision_note`（d9-profile.md:509） |
| confirm | `{ roundNo: integer }` | 是 | 等于当前轮次号 | 回显（C54） |
| confirmChecks | array<string> | 否 | 0–10 项 | 核对项 → `approval_request.confirm_checks` |

M1 的 confirm/roundNo 缺失由领域返回 CONFIRM_MISMATCH（409），在范围、待审、追加权限和版本守卫之后检查；DTO 仅回证照fileId，不预签原图。mode=override 在追加权限、版本、回显守卫通过后仍回 STATE_NOT_ALLOWED（recognition_override_not_open）。

**响应**：QualificationSubmissionDetail（审批单 `approved`、轮次已关闭）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 轮次不存在或不在范围内 |
| `APPROVAL_NOT_PENDING` | 409 | 审批单已决或已被系统撤回 |
| `PERMISSION_DENIED` | 403 | `mode = override` 而没有 `merchant.qualification.override` |
| `VERSION_CONFLICT` | 409 | 审批单 `lockVersion` 不符：另一位审核员刚修正过识别字段（3.24 同事务升审批单锁版本），请刷新后按新的比对结果再决定 |
| `CONFIRM_MISMATCH` | 409 | 轮次号不一致 |
| `QUALIFICATION_CHECK_FAILED` | 409 | `mode = normal` 而比对仍有“不通过”项；`details.items` 列出证照与比对项 |
| `USCC_TAKEN` | 409 | 本轮营业执照的信用代码已被其他主体认证（唯一索引冲突，整个事务回滚，轮次仍在审；m03 定义） |
| `PRECONDITION_CHANGED` | 409 | 事务内重算前提已变（门店或主体已停用、关闭） |

**副作用**（一个事务；加锁：审批单 → 轮次 → 主体 → 门店 → 档案行，04-profile.md:666；d9-profile.md 5.6 的九步）：
- 状态迁移：
  - `approval_request.status`：`pending` → `approved`（`approve`，03-staff-authz-audit.md:805），写 `decided_by_staff_id`、`decided_at`、`confirm_checks`，`lock_version + 1`。
  - `qualification_submission`：在审 → 已关闭（通过，04-profile.md:345）：`closed_at`、`outcome = 'approved'`、`approve_mode`（有修正值为 `corrected`，放行为 `override`，否则 `normal`）。
  - `qualification_doc`：先把被取代的原生效行置 `superseded_at`，再把本轮未移除的行置 `verdict = 'accepted'`、`effective_at`（两句顺序不能反，04-profile.md:464）。
  - `store.qualification_status`：`initial`、`new_store` 轮次 `pending` → `verified`（`qualification.approve`，02-identity-tenant.md:623）；`change` 轮次 `verified` → `verified`（`qualification.change_approve`，02-identity-tenant.md:627，照常写状态历史）。
  - `entity.verification_status`：`initial` 轮次 `pending` → `verified`（`qualification.approve`，02-identity-tenant.md:541），同一条 UPDATE 写 `entity.name`、`entity_type`、`uscc_enc`、`uscc_bidx`、`uscc_mask`、`legal_rep_name_enc`、`legal_rep_name_mask`、首次的 `verified_at`；`change` 轮次更换营业执照只改字段、不改结论（02-identity-tenant.md:545）。
- `change` 轮次写回 `changed_fields` 列出的类别：`store.name`（经 `tenant.renameStore`）、`store_profile` 的行业与品类、省市区与详细地址（d9-profile.md:550）。
- `store_profile`：`effective_qualification_submission_id`、首次的 `first_verified_at`、`last_decided_at`，完整度重算。
- 定时器：取消 `sla.breach:approval_request:{id}:decision`（01-kernel-flow.md:603）。
- 出站事件：`store.qualification.approved { storeId, entityId, submissionId, kind }` 或 `store.qualification_change.approved`；写回有实际变化时 `store.profile.changed { source: 'review_writeback' }`；`approval.approved`。订阅方：order 为待开工订购单登记开工（d9-profile.md:700）；通知 `m.review_result`；profile 驳回信用代码相同的其他在审轮次（系统驳回，归 x01）。
- `audit_log`：审批单迁移一行（`category = 'review'` → `activity` 流），门店、主体的联动迁移并入这一行（03-staff-authz-audit.md:640-641）；放行时 `meta.rule = 'override'`。

**说明**：
- 审核员可以是客服（默认，d4-identity.md:2083）；商家提交的审核没有发起员工，`APPROVAL_SELF_FORBIDDEN` 不适用。
- 审核类不带清单模板（`checklist_*` 为空），不收清单结论，因此不涉及 `CHECKLIST_VERSION_STALE`（a01）；核对项只是界面勾选，写进 `confirm_checks`。
- 守卫顺序按 1.1：取对象 → `APPROVAL_NOT_PENDING` → 放行的追加权限 → 审批单 `lockVersion` → `confirm` → 比对结论与信用代码唯一性。
- 新增门店的轮次只审本店证照，主体营业执照作为 `referenceDocs` 只读参考（PRD 7.4-3）。

### 3.27 admin.qualificationSubmission.reject　资质驳回
`POST /admin/qualification-submissions/{qualificationSubmissionId}/reject`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.qualification.review`；门店范围 |
| 回显 | 终局驳回时 `confirm: { pendingStartOrderCount, pendingAssignAdCount, heldPoints }`（取自 3.25，d3-flow.md:2376）；非终局时 `confirm: { roundNo }` |
| 幂等 | required（状态迁移） |
| 乐观锁 | 无（`reject` 的守卫没有列锁版本，03-staff-authz-audit.md:806；A21） |
| 对应画板 | A:Review（驳回弹层：原因单选、说明、系统预填；勾选“无法补正”） |
| 出处 | 路线图 `a03.qualification-submissions.reject`；d9-profile.md:510、519、521-530；04-profile.md:346、349、466；02-identity-tenant.md:542、624；14-config-data.md:126 |

**请求**：路径参数 `qualificationSubmissionId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| reasonCodes | array<string> | 是 | 1–3 个，字典 `reject_reason` 场景 `store_review` 的启用项 | → `approval_request.reason_codes` |
| note | string | 是 | 1–200 字 | 驳回说明 → `approval_request.decision_note` |
| rejectedDocIds | array<string(uuid)> | 否 | 本轮未移除的证照行 | 被点名驳回的证照；与证照无关的原因（如主体与档案不一致）不传 |
| isFinal | boolean | 否 | 默认 `false`；`change` 轮次不能为真 | 终局驳回（“无法补正”） |
| confirm | object | 是 | 见“回显” | 回显（C54） |

**响应**：QualificationSubmissionDetail（审批单 `rejected`、轮次已关闭）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 轮次不存在或不在范围内 |
| `APPROVAL_NOT_PENDING` | 409 | 审批单已决或已撤回 |
| `QUALIFICATION_FINAL_NOT_ALLOWED` | 409 | `change` 轮次勾选了终局驳回 |
| `CONFIRM_MISMATCH` | 409 | 终局驳回的三个数与当前影响不一致（期间有新订购或广告指派），或轮次号不一致 |
| `VALIDATION_FAILED` | 400 | 没有原因或说明；原因编码不属于 `store_review` 场景；`rejectedDocIds` 不在本轮 |

**副作用**（一个事务；加锁同 3.26）：
- 状态迁移：
  - `approval_request.status`：`pending` → `rejected`（`reject`，03-staff-authz-audit.md:806），写 `decided_by_staff_id`、`decided_at`、`reason_codes`、`decision_note`。
  - `qualification_submission`：在审 → 已关闭（驳回，04-profile.md:346）：`closed_at`、`outcome = 'rejected'`；终局时写 `final_rejected_at`。
  - `qualification_doc`：被点名的行 `verdict = 'rejected'`，本轮其余未移除的行 `accepted`（04-profile.md:466）。
  - `store.qualification_status`：`initial`、`new_store` 轮次 `pending` → `rejected`（`qualification.reject`，02-identity-tenant.md:624）；`change` 轮次 `verified` → `verified`（`qualification.change_reject`）。
  - `entity.verification_status`：`initial` 轮次 `pending` → `rejected`（`qualification.reject`，02-identity-tenant.md:542）。
- `store_profile`：`last_decided_at`；终局时 `final_rejected_at`（d9-profile.md:527）。
- 定时器：取消审批单的决定时限定时器。
- 出站事件：`store.qualification.rejected { storeId, entityId, submissionId, isFinal, reasonCodes }` 或 `store.qualification_change.rejected`；`approval.rejected`。订阅方：通知 `m.review_result`；终局时 order 生成整店取消申请（`kind = qualification_cancel`，系统生成，归 x01；09-order-ad.md:547、572）；非终局时 D3 的 `order.rejected_stale` 定时器负责满 7 天未补正的待办（d9-profile.md:526）。
- `audit_log`：`activity` 流一行（审核类）。

**说明**：
- 驳回原因字典 `store_review` 场景：证照模糊、主体与档案不一致、证照过期、缺少行业许可证、其他（14-config-data.md:126）。前端用 3.23 的 `checkSummary.suggestedReason`、`suggestedNote` 预填（proto-admin-b.md:145）。
- 原型是原因单选；接口收数组（字典与审批单列都是多值），前端可只给一项。
- 终局驳回后商家端不能再提交（d9-profile.md:528）。

### 3.28 admin.storeAsset.list　门店素材列表
`GET /admin/store-assets`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看；门店范围 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:MerchantDetail（门店素材页签：状态分段、类型下拉、素材表，每页 10 条，按上传时间倒序） |
| 出处 | 路线图 `a03.store-assets.list`；proto-admin-b.md:74、92、105-107、113；06-media.md:1147-1152；d5-media.md:2113 |

**请求**：查询参数：

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| storeId | string(uuid) | 条件 | 范围内的门店；只有 `tab = organizing` 时可以不传 | 只看一家门店（商家详情）；不传 = 跨门店的待整理队列（a02 工作台 ㉑“待整理素材”的跳转），按当前员工的门店数据范围过滤，默认 `sort = reviewDueAt`；不传时带 `assetDemandId` 或 `tab` 不是 `organizing` 返回 400 `VALIDATION_FAILED` |
| tab | enum `AdminAssetTab` | 否 | 默认 `all` | 全部、待整理、已采用（A24） |
| type | string | 否 | 逗号分隔，取值同 `store_asset.type` | 类型筛选 |
| usability | string | 否 | 逗号分隔，取值同 `store_asset.usability` | 可用性筛选（“待确认授权”= `need_portrait_auth` 加 `hasPortraitAuthFiles=true`） |
| hasPortraitAuthFiles | boolean | 否 | — | 有无肖像授权材料 |
| assetDemandId | string(uuid) | 否 | 本门店的需求 | 只看响应某条需求的素材 |
| q | string | 否 | 1–30 字 | 标题、标签、转写摘录、上传人（`store_asset.search_text` 三元组检索） |
| sort | enum(`-createdAt`、`reviewDueAt`) | 否 | 默认 `-createdAt` | 上传时间倒序；按复核截止升序（整理队列） |
| page、pageSize | integer | 否 | C43 | 页码分页 |

**响应**：`{ items: array<AdminStoreAssetRow>, page, pageSize, total }`。只含 `store_asset.deleted_at` 为空的素材。页签与类型计数走 3.29（A23）。

**错误**：`NOT_FOUND`（404，门店不在范围内）。

**副作用**：无。缩略图随列表现签（C60）。

**说明**：后台“待整理 / 已整理 / 已采用”与商家端“整理中 / 可用性”是同一组列的两套展示（proto-admin-b.md:113）。跨门店的待整理队列（第三轮按 a02 的请求放开）：`tab = organizing` 且不传 `storeId` 时按 `ix_store_asset_review_due` 取数、按复核截止升序，与 a02 工作台 ㉑ 的计数函数共用同一个带范围的查询构造函数；行里带 `storeName`。是否做这一页由产品定（a02 第 6 节第 5 项），接口先支持。

### 3.29 admin.storeAsset.summary　素材计数
`GET /admin/store-assets/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看；门店范围 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:MerchantDetail（页签角标“门店素材 128”、状态分段“待整理 N”、类型下拉的计数、“共 128 条 · 已整理 127 条”） |
| 出处 | 路线图 `a03.store-assets.summary`；proto-admin-b.md:74、92；A23、C83 |

**请求**：查询参数同 3.28，去掉 `tab`、`sort`、`page`、`pageSize`。`storeId` 可以不传（跨门店的待整理队列页头），此时按当前员工的门店数据范围计数，不能带 `assetDemandId`。

**响应**：AdminStoreAssetSummary（2.9）。

**错误**：`NOT_FOUND`（404）。

**副作用**：无。

**说明**：字面段先于 `/{storeAssetId}` 注册（A8）。

### 3.30 admin.storeAsset.get　素材详情
`GET /admin/store-assets/{storeAssetId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看；门店范围 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无（响应的 `lockVersion` 供整理、确认授权使用） |
| 对应画板 | A:MerchantDetail（整理素材弹层：系统识别说明；素材预览或播放，PRD 6.16.3） |
| 出处 | 路线图 `a03.store-assets.get`；proto-admin-b.md:93、103、114；d5-media.md:1770-1787；06-media.md:1766-1775 |

**请求**：路径参数 `storeAssetId`。

**响应**：AdminStoreAssetDetail（2.9）。文件地址随详情现签：图片与文档 30 分钟，音视频 60 分钟（C61）。

**错误**：`NOT_FOUND`（404，素材不存在、已删除或不在范围内）。

**副作用**：无。

**说明**：肖像授权材料（`portrait_auth`，secure 桶）不随详情签发，只给 `portraitAuthFileIds`，查看走 `admin.file.downloadUrls`（写 access 审计）。

### 3.31 admin.storeAsset.create　员工代传素材
`POST /admin/store-assets`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.asset.upload_on_behalf`（增补键，建议默认交付经理、客服）；门店范围 |
| 回显 | 无 |
| 幂等 | required；`Idempotency-Key` 同时写入 `store_asset.idempotency_key`，由 `uq_store_asset_store_id_idempotency_key` 兜底（06-media.md:1136、1145、1182） |
| 乐观锁 | 无 |
| 对应画板 | 原型未画入口（建议在门店素材页签加“代商家上传”） |
| 出处 | 路线图 `a03.store-assets.create`；06-media.md:1116-1118、1182；d5-media.md:2106；design-spec.md:856；A35 |

**请求**：请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| storeId | string(uuid) | 是 | 范围内、启用中的门店 | → `store_asset.store_id`，`entity_id` 取门店所属主体 |
| type | enum(同数据模型 `store_asset.type`) | 是 | — | → `store_asset.type` |
| fileIds | array<string(uuid)> | 条件 | 数量规则同 m03 3.22；分类 `store_asset`，由员工经 `admin.file.create` 登记、代传门店为本店 | → `store_asset_file` |
| textBody | string | 条件 | `text` 时必填，1–500 字 | → `store_asset.text_body` |
| contentTagCodes | array<string> | 否 | 0–8 个，字典 `asset_tag` 内容维度 | → `store_asset_tag`（`source = 'uploader'`） |
| note | string | 否 | ≤200 字 | → `store_asset.note` |
| assetDemandId | string(uuid) | 否 | 本门店的需求 | → `store_asset.store_asset_demand_id` |

**响应**：AdminStoreAssetRow（`processingState` 为 `pending` 或 `processing`，`adminStatus = 'organizing'`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 门店不在范围内 |
| `STATE_NOT_ALLOWED` | 409 | 门店已停用 |
| `FILE_NOT_USABLE` | 400 | 文件不可用、分类不符或不是为本店代传（m03 定义） |
| `VALIDATION_FAILED` | 400 | 文件数与类型不符；正文或说明超长；标签不在内容维度；需求不属于本门店 |

**副作用**：
- 状态迁移（处理进度，不写 `status_transition`，06-media.md:1178）：`store_asset.processing_state`：— → `pending`（创建素材，代传员工）；同事务建了第一个理解任务时 `pending` → `processing`。
- 插入 `store_asset`：`upload_actor_type = 'staff'`、`upload_actor_id` = 当前员工、`upload_client = 'admin'`、`upload_actor_role` 为空、`review_state = 'unreviewed'`、`due_at` 与 `sla_snapshot`（`sla.review.store_asset`）；`store_asset_file`、上传人标签；`files.link(store_asset / main)`。
- 按 `nextAssetSteps()` 插入 `media_job`（`parent_type = 'store_asset'`）。
- 定时器：`sla.breach`（主体 `store_asset`，复核时限，01-kernel-flow.md:608）。
- `audit_log`：`activity` 流一行。处理完成后由 worker 发 `asset.processed`、`asset.review_needed`；员工代传的素材在 `asset.reviewed`、`asset.adopted` 时没有商家接收人（13-notify-docs.md:148）。

**说明**：
- 超过小程序上传上限的大文件由服务经理在后台代传（A35；design-spec.md:856）：大文件经 `admin.file.create` 走分片上传，再调本接口建素材。
- 店员上传闸门（`ASSET_UPLOAD_GATED`）只约束商家端，员工代传不受限。

### 3.32 admin.storeAsset.review　整理素材
`POST /admin/store-assets/{storeAssetId}/review`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.asset.review`（交付经理，d4-identity.md:1176）；门店范围 |
| 回显 | 不另带 `confirm`：以 `lockVersion` 防两名复核人同时编辑 |
| 幂等 | required（状态迁移） |
| 乐观锁 | 带 `lockVersion`（`store_asset.lock_version`；复核迁移的守卫列了锁版本，06-media.md:1186-1187） |
| 对应画板 | A:MerchantDetail（整理素材 / 修改素材标签弹层：内容标签多选、用途多选、时效单选、可用性单选） |
| 出处 | 路线图 `a03.store-assets.review`；06-media.md:1186-1187、1190；d5-media.md:1772-1787；proto-admin-b.md:93、112；13-notify-docs.md:148 |

**请求**：路径参数 `storeAssetId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| lockVersion | integer | 是 | 等于 `store_asset.lock_version` | — |
| title | string \| null | 否 | ≤60 字 | 改标题 → `store_asset.title` |
| contentTagCodes | array<string> | 是 | 1–8 个，字典 `asset_tag` 内容维度 | 复核确认的内容标签 |
| usageTagCodes | array<string> | 是 | 1–5 个，用途维度 | 用途 |
| timeliness | `{ tagCode: string, validStartDate?: string(date), validEndDate?: string(date) }` | 是 | 时效维度一项；日期区间只用于区间型时效，起 ≤ 止 | 时效（“国庆 10-01～10-07”） |
| usability | enum(同数据模型 `store_asset.usability`) | 是 | — | 可用性，只有复核人能写 |

**响应**：AdminStoreAssetDetail（`adminStatus` 为 `organized` 或 `adopted`（已复核；`store_asset.review_state = 'reviewed'`）、新的 `lockVersion`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 素材不存在、已删除或不在范围内 |
| `ASSET_NOT_PROCESSED` | 409 | 素材还在识别中（`processing_state` 不是 `processed`） |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符（另一复核人刚保存；留审计） |
| `ASSET_ALREADY_ADOPTED` | 409 | 素材已被采用（`adopted_count > 0`），不能改为需补拍或需肖像授权（`media.I12`） |
| `VALIDATION_FAILED` | 400 | 少于 1 个内容标签或 1 个用途（“请至少选择 1 个内容标签和 1 个用途”）；编码不在对应维度 |

**副作用**（锁素材行）：
- 状态迁移（复核维度，不写 `status_transition`）：`store_asset.review_state`：`unreviewed` → `reviewed`（复核保存，06-media.md:1186）或 `reviewed` → `reviewed`（再次复核，06-media.md:1187）。
- 写 `usability`、`reviewed_by_staff_id`、`reviewed_at`、`lock_version + 1`；改为 `need_portrait_auth` 时清空 `portrait_authorized_at`（`ck_store_asset_portrait_auth`）；重建 `search_text`。
- `store_asset_tag`：删除本素材 `source = 'reviewer'` 的旧行，插入本次三组标签（`source = 'reviewer'`、`is_confirmed = true`）；机器与上传人的标签保留，展示时被覆盖。
- 首次复核取消复核时限的 `sla.breach` 定时器。
- 出站事件：`asset.reviewed { storeAssetId, usability }`；可用性为 `need_reshoot`、`need_portrait_auth` 且上传人是商家时，通知上传人（`m.asset_feedback`，13-notify-docs.md:148）。
- `audit_log`：`activity` 流一行（“整理门店素材‘国庆双人套餐想法’：活动优惠、菜品与产品 · 仅供参考”）。

**说明**：
- 素材复核是处理队列，不进审批单（M22）。
- 原型选“需补拍”时提示“补拍前该素材不会出现在可选素材中”，选“需肖像授权”时提示“授权前仅供方案参考，不用于成片”（A:MerchantDetail 整理弹层），是参考守卫（06-media.md:1191）的文案。
- 再次复核可以把“需肖像授权”直接改为其他可用性（复核人判断无须授权），按审计追溯；正常路径是商家补交材料后用 3.33 确认。

### 3.33 admin.storeAsset.confirmPortraitAuth　确认肖像授权
`POST /admin/store-assets/{storeAssetId}/confirm-portrait-auth`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.asset.review`；门店范围 |
| 回显 | 不另带 `confirm`：以 `lockVersion` 防过期 |
| 幂等 | required（状态迁移） |
| 乐观锁 | 带 `lockVersion`（守卫同“再次复核”，06-media.md:1189） |
| 对应画板 | 原型未画（在素材行“待确认授权”时显示“确认授权”） |
| 出处 | 路线图 `a03.store-assets.confirm-portrait-auth`；06-media.md:1127、1172、1188-1189、1878 |

**请求**：路径参数 `storeAssetId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| lockVersion | integer | 是 | 等于 `store_asset.lock_version` | — |
| usability | enum(`ready`、`reference_only`) | 是 | — | 确认后的可用性（可直接使用、仅供参考） |
| note | string | 否 | ≤200 字 | 核对说明 → `audit_log.reason_text` |

**响应**：AdminStoreAssetDetail。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 素材不存在、已删除或不在范围内 |
| `STATE_NOT_ALLOWED` | 409 | 可用性不是“需肖像授权” |
| `ASSET_PORTRAIT_AUTH_MISSING` | 409 | 还没有肖像授权材料（`portrait_auth_file_ids` 为空） |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符 |

**副作用**：
- 状态迁移（可用性维度，不写 `status_transition`）：`store_asset.usability`：`need_portrait_auth` → `ready` 或 `reference_only`（复核人确认授权齐全，06-media.md:1189）。
- 写 `portrait_authorized_at`、`reviewed_by_staff_id`、`reviewed_at`，`lock_version + 1`。
- 出站事件 `asset.reviewed { usability }`（结论不是需补拍、需肖像授权，通知模块不发商家提醒）。
- `audit_log`：`activity` 流一行。

**说明**：材料的收取方式与保留期待法务（06-media.md:1878 第 5 项）。

### 3.34 admin.storeAsset.portraitAuth.create　代交肖像授权材料
`POST /admin/store-assets/{storeAssetId}/portrait-auth`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.asset.upload_on_behalf`（增补键）；门店范围 |
| 回显 | 无 |
| 幂等 | required（往数组追加文件，重试会重复追加，复核意见 47） |
| 乐观锁 | 无（“补交授权材料”的守卫没有列锁版本，06-media.md:1188） |
| 对应画板 | 原型未画（线下收到授权书后由员工代交） |
| 出处 | 路线图 `a03.store-assets.portrait-auth`；06-media.md:1126、1188、1878；A26、A33 |

**请求**：路径参数 `storeAssetId`。请求体 `PortraitAuthBody`：引用 m03 3.23 的定义（A132、C87，本文不另定义）：`{ fileIds: array<string(uuid)> }`，1–9 个，分类 `portrait_auth`，追加后总数不超过 20；后台一侧的文件由员工经 `admin.file.create` 代本店上传。

**响应**：AdminStoreAssetDetail。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 素材不存在、已删除或不在范围内 |
| `STATE_NOT_ALLOWED` | 409 | 可用性不是“需肖像授权” |
| `FILE_NOT_USABLE` | 400 | 文件不可用或分类不是 `portrait_auth`（m03 定义） |
| `VALIDATION_FAILED` | 400 | 文件数超限 |

**副作用**：
- 状态迁移：`store_asset.usability`：`need_portrait_auth` 不变（补交授权材料，06-media.md:1188）；素材进入“待确认授权”的派生队列。
- 锁素材行后去重追加 `store_asset.portrait_auth_file_ids`；`files.link(store_asset / portrait_auth)`。
- `audit_log`：`activity` 流一行。

**说明**：与商家端 `m.storeAsset.portraitAuth.create`（m03 3.23）同名同形（A26、A33）。确认是另一步（3.33），代交的员工也可以在复核权限下自己确认。

### 3.35 admin.storeAsset.reprocess　重新识别
`POST /admin/store-assets/{storeAssetId}/reprocess`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.asset.review`；门店范围 |
| 回显 | 无 |
| 幂等 | required（状态迁移，复核意见 47） |
| 乐观锁 | 无 |
| 对应画板 | 原型未画（素材详情“重新识别”） |
| 出处 | 路线图 `a03.store-assets.reprocess`；06-media.md:1185、1260-1268；d5-media.md:1805、2113 |

**请求**：路径参数 `storeAssetId`。请求体：`{ kinds?: array<enum(同数据模型 store_asset_insight.kind)> }`：只重跑这些步骤；不传则重跑全部步骤。

**响应**：AdminStoreAssetRow（`processingState = 'processing'`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 素材不存在、已删除或不在范围内 |
| `ASSET_NOT_PROCESSED` | 409 | 素材正在识别中（`processing_state` 不是 `processed`） |
| `STATE_NOT_ALLOWED` | 409 | 素材被内容安全拦截（`moderation_state = 'block'`） |

**副作用**：
- 状态迁移（处理进度）：`store_asset.processing_state`：`processed` → `processing`（重新识别，06-media.md:1185）。
- 同事务插入 `media_job`（`parent_type = 'store_asset'`）；步骤产出按 `(store_asset_id, file_id, kind, prompt_version)` 覆盖同一提示词版本的旧结果（06-media.md:1260、1292-1293）。收尾时重算 `is_insight_partial`、`search_text`。
- 不改复核结论与标签（复核人的标签不被机器结果覆盖）。
- `audit_log`：`activity` 流一行。完成后 worker 发 `asset.processed`。

**说明**：模型调用受媒体模块的预算护栏约束（每门店每日文件数、全局预算，d5-media.md 第 9.5 节），超出时步骤记 `skipped`，本接口不报错。

### 3.36 admin.storeAsset.delete　软删除素材
`POST /admin/store-assets/{storeAssetId}/delete`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.asset.review`（是否另设删除权限点见第 6 节第 4 项）；门店范围 |
| 回显 | 无（请求体带删除原因；界面确认弹层即可，见 1.1“回显”） |
| 幂等 | required |
| 乐观锁 | 无 |
| 对应画板 | 原型未画（素材行操作“删除”） |
| 出处 | 路线图 `a03.store-assets.delete`；06-media.md:1135、1876、1878；A26；复核意见 51 |

**请求**：路径参数 `storeAssetId`。请求体：`{ reasonText: string（1–200 字，→ audit_log.reason_text） }`。

**响应**：`data = null`（C21）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 素材不存在、已删除或不在范围内 |
| `VALIDATION_FAILED` | 400 | 原因为空 |

**副作用**：
- 状态迁移：无（软删除写时间戳）。写 `store_asset.deleted_at`。
- `file_ref`：`store_asset / main` 的引用释放，保留 7 天后清除文件（06-media.md:1135）；`store_asset / portrait_auth` 的引用：从未被采用的 7 天后释放，被采用过的保留 3 年（06-media.md:1878）。
- 未复核的素材同事务取消复核时限的 `sla.breach` 定时器。
- `audit_log`：`ops` 流一行（删除人只记审计，不加列，06-media.md:1876）。

**说明**：
- 素材不物理删除，`DELETE` 不适用（A7、A26）。商家不能自助删除（06-media.md:1876）。
- 已作为参考或被采用的素材删除后，订购单、广告上的引用与使用记录保留（使用方另有 `file_ref`），只是不再出现在素材库与选择器里。
- 重复删除（换了幂等键）返回 404。

### 3.37 admin.assetDemand.list　素材需求列表
`GET /admin/asset-demands`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看；门店范围 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:MerchantDetail（门店素材页签上方的素材需求列表） |
| 出处 | 路线图 `a03.asset-demands.list`；proto-admin-b.md:74；06-media.md:1391-1417 |

**请求**：查询参数：`storeId`（uuid，必填）；`status`（逗号分隔的 `open`、`done`、`canceled`，缺省全部）；`page`、`pageSize`（C43）。

**响应**：`{ items: array<AssetDemandRow>, page, pageSize, total }`；进行中的在前（按 `due_date` 升序），其余按发起时间倒序。

**错误**：`NOT_FOUND`（404，门店不在范围内）。

**副作用**：无。

**说明**：“已收到 N 条”由素材行计数（`ix_store_asset_store_asset_demand_id`），不存列。

### 3.38 admin.assetDemand.create　发起素材需求
`POST /admin/asset-demands`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.asset.demand.create`（交付经理，d4-identity.md:1176）；门店范围 |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 无 |
| 对应画板 | A:MerchantDetail（发起素材需求弹层：需求名称、拍摄说明、完成时间、通知对象） |
| 出处 | 路线图 `a03.asset-demands.create`；06-media.md:1391-1436；proto-admin-b.md:91；PRD 7.4-7 |

**请求**：请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| storeId | string(uuid) | 是 | 范围内、启用中的门店 | → `store_asset_demand.store_id`，`entity_id` 取门店所属主体 |
| title | string | 是 | 1–20 字 | → `store_asset_demand.title` |
| shootingNote | string | 否 | ≤200 字 | → `store_asset_demand.shooting_note` |
| dueDate | string(date) | 是 | 不早于北京时间今天 | → `store_asset_demand.due_date`（当日结束前都算按时） |
| notifyScope | enum(同数据模型 `store_asset_demand.notify_scope`) | 是 | — | 老板和店员、仅老板 |

**响应**：AssetDemandRow。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 门店不在范围内 |
| `STATE_NOT_ALLOWED` | 409 | 门店已停用 |
| `VALIDATION_FAILED` | 400 | 名称为空或超长（“请填写需求名称”）；完成日期早于今天 |
| `CONTENT_REJECTED` | 400 | 名称或拍摄说明未通过文本内容安全检测（m01 定义；需求会展示给商家）；`details = { fields: string[] }`（`title`、`shootingNote`，A131）；检测服务不可用时 503 `PROVIDER_UNAVAILABLE`、不写库（A137） |

**副作用**：
- 状态迁移（处理进度，不写 `status_transition`）：`store_asset_demand.status`：— → `open`（发起，06-media.md:1434），`created_by_staff_id` = 当前员工。
- 出站事件 `asset.demand_created`：通知模块按 `notify_scope` 给老板与店员发订阅消息（`m.asset_feedback`，13-notify-docs.md:148）。
- `audit_log`：`activity` 流一行（“发起素材需求‘国庆氛围布置’（10-01 前），通知老板和 2 位店员”）。
- 不登记定时器：到期提醒由周期任务 `media.sweep` 按 `due_date` 扫描（06-media.md:1874）。

**说明**：原型的完成时间是三个预设日期的下拉，接口收任意不早于今天的日期。

### 3.39 admin.assetDemand.complete　标记素材需求完成
`POST /admin/asset-demands/{assetDemandId}/complete`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.asset.demand.create`；门店范围 |
| 回显 | 无 |
| 幂等 | required（状态迁移） |
| 乐观锁 | 无 |
| 对应画板 | 原型未画按钮（需求行操作） |
| 出处 | 路线图 `a03.asset-demands.complete`；06-media.md:1435 |

**请求**：路径参数 `assetDemandId`；请求体无（`{}`）。

**响应**：AssetDemandRow（`status = 'done'`）。

**错误**：`NOT_FOUND`（404）；`STATE_NOT_ALLOWED`（409，需求不是 `open`）。

**副作用**：状态迁移 `store_asset_demand.status`：`open` → `done`（标记完成，06-media.md:1435），写 `closed_at`；`audit_log` `activity` 流一行。不通知商家。

**说明**：完成或撤销后，商家仍可在上传时关联这条需求（m03 3.22 说明），只记录响应关系。

### 3.40 admin.assetDemand.cancel　撤销素材需求
`POST /admin/asset-demands/{assetDemandId}/cancel`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.asset.demand.create`；门店范围 |
| 回显 | 无 |
| 幂等 | required（状态迁移） |
| 乐观锁 | 无 |
| 对应画板 | 原型未画按钮（需求行操作） |
| 出处 | 路线图 `a03.asset-demands.cancel`；06-media.md:1436 |

**请求**：路径参数 `assetDemandId`；请求体：`{ reasonText?: string（≤200 字，写审计） }`。

**响应**：AssetDemandRow（`status = 'canceled'`）。

**错误**：`NOT_FOUND`（404）；`STATE_NOT_ALLOWED`（409，需求不是 `open`）。

**副作用**：状态迁移 `store_asset_demand.status`：`open` → `canceled`（撤销，06-media.md:1436），写 `closed_at`；`audit_log` `activity` 流一行。不通知商家（商家端列表默认只显示进行中的需求，m03 3.25）。

**说明**：无。

### 3.41 admin.followUp.list　跟进记录时间线
`GET /admin/follow-ups`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`permission: assert-in-handler`（A45、C66）：按对象所在模块查看，模块对照表（3.42–3.45 共用）：`subscription_term` → 订单管理；`order_item`、`patrol_task`、`takedown_task` → 发布管理；`delivery_reissue` → 交付管理；`store` 与按主体、门店查、`mine` → 商家管理。该模块等级为 `n` 时 403 `PERMISSION_DENIED`；对象或门店在数据范围外 404 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | A:Renewals（右侧详情的跟进记录）、A:Overdue（逾期卡片的跟进时间线）、A:Calendar（逾期提醒）、A:MerchantDetail（跟进记录页签，V1.1 入口） |
| 出处 | 路线图 `a03.follow-ups.list`；03-staff-authz-audit.md:490-543；proto-admin-b.md:96、290；proto-admin-a.md:425、433 |

**请求**：查询参数（`subjectType` + `subjectId`、`entityId`、`storeId`、`mine` 至少给一组）：

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| subjectType | enum(同数据模型 `follow_up.subject_type`) | 否 | 与 `subjectId` 同时给 | 对象的时间线 |
| subjectId | string(uuid) | 否 | — | 同上 |
| entityId | string(uuid) | 否 | — | 主体下的全部跟进 |
| storeId | string(uuid) | 否 | — | 门店下的全部跟进 |
| mine | boolean | 否 | — | 只看负责人是本人的 |
| isOpen | boolean | 否 | — | 只看在办（或只看已结束） |
| page、pageSize | integer | 否 | C43 | — |

**响应**：`{ items: array<FollowUpItem>, page, pageSize, total }`，按记录时间倒序。

**错误**：`NOT_FOUND`（404，对象或门店不在范围内）；`PERMISSION_DENIED`（403，对对象所在模块没有查看权）。

**副作用**：无。

**说明**：
- “套餐到期”页的续费意向列是读侧取每个订阅周期最新一条跟进（03-staff-authz-audit.md:492），由 a07 的续费列表组装，不调本接口。
- 跟进记录仅内部可见（A:MerchantDetail 跟进表单的说明），不进商家端。

### 3.42 admin.followUp.create　记录跟进
`POST /admin/follow-ups`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`permission: assert-in-handler`（A45）：对对象所在模块有查看权、对象在数据范围内（3.41 的模块对照） |
| 回显 | 无 |
| 幂等 | required（新建记录，复核意见 38） |
| 乐观锁 | 无（同对象此前在办的行由服务层在同一事务里关闭，不带锁） |
| 对应画板 | A:Renewals（记录跟进弹层：方式、续费意向、说明）、A:Overdue（沟通内容与下次跟进时间）、A:MerchantDetail（内联表单：方式、内容、下次跟进日期，V1.1） |
| 出处 | 路线图 `a03.follow-ups.create`；03-staff-authz-audit.md:494-541；d3-flow.md:1821、3530；proto-admin-b.md:96、121、290；proto-admin-a.md:433 |

**请求**：请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| subjectType | enum `FollowUpSubjectInput` | 是 | V1.0 取 `order_item`、`subscription_term`、`patrol_task`、`takedown_task`、`delivery_reissue`；`store` 留到 V1.1 | → `follow_up.subject_type` |
| subjectId | string(uuid) | 是 | 对象存在且在范围内 | → `follow_up.subject_id`；`entity_id`、`store_id` 由服务端按对象取（续费跟进 `store_id` 为空） |
| channel | enum(`wecom`、`phone`、`visit`) | 否 | 不能是 `system` | → `follow_up.channel`；逾期跟踪的弹层没有方式，可不传 |
| content | string | 是 | 1–200 字 | → `follow_up.content` |
| intent | enum(同数据模型 `follow_up.intent`) | 否 | 只有 `subscription_term` 可填 | 续费意向 → `follow_up.intent` |
| nextFollowAt | string(date-time) | 否 | 晚于现在 | 下次跟进；前端选日期时传当日 09:00（+08:00）→ `follow_up.next_follow_at` |

负责人不由请求指定：人工记录的负责人等于记录人（03-staff-authz-audit.md:509），服务端写 `owner_staff_id` = 当前员工；三个画板的表单都没有选负责人（Renewals.dc.html:153-161、Overdue.dc.html:95-96）。

**响应**：FollowUpItem。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 对象不存在或不在范围内 |
| `PERMISSION_DENIED` | 403 | 对对象所在模块没有查看权 |
| `VALIDATION_FAILED` | 400 | 内容为空或超长；非续费对象带了意向；`subjectType = store`（V1.1） |

**副作用**：
- 状态迁移：无（`follow_up` 没有状态机）。
- 插入 `follow_up`：`actor_type = 'staff'`、`actor_id` = 当前员工、`owner_staff_id` = 当前员工、`client = 'admin'`。同一对象此前在办的行在同一事务里关闭（`done_at` = 新行的记录时间，03-staff-authz-audit.md:494）。
- 不登记定时器：到期提醒由通知中心每日按 `ix_follow_up_next_follow_at` 取数（03-staff-authz-audit.md:541）。
- `audit_log`：`activity` 流一行（“记录跟进（企业微信）”）。不发出站事件。

**说明**：
- 三个画板的表单不同，合为一个资源（proto-admin-b.md:121）；方式统一为 `wecom`、`phone`、`visit`（“到店拜访”“上门拜访”都是 `visit`）。
- 调用方：续费跟进（a07，`subjectType = subscription_term`，可带 `intent`；a07 的续费列表读每个周期最新一条的 `intent`）、逾期未上线与巡检、下架核查（a06，`order_item`、`patrol_task`、`takedown_task`）、补发后确认（`delivery_reissue`）。
- 门店维度的跟进（商家详情页签）是 V1.1 入口（PRD 7.4-8；03-staff-authz-audit.md:501），契约在 V1.1 给请求枚举加 `store`，属于非破坏变更（C79）。

### 3.43 admin.followUp.update　改下次跟进时间
`PATCH /admin/follow-ups/{followUpId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`permission: assert-in-handler`（A45）：当前员工是负责人，或负责人所在组的主管（`is_lead`），或数据范围为 `all`；否则 403 `PERMISSION_DENIED` |
| 回显 | 无 |
| 幂等 | required（带锁的 PATCH，A17） |
| 乐观锁 | 带 `lockVersion`（`follow_up.lock_version`，03-staff-authz-audit.md:515） |
| 对应画板 | A:Overdue（改下次跟进时间）、A:MerchantDetail（V1.1） |
| 出处 | 路线图 `a03.follow-ups.update`；03-staff-authz-audit.md:496、509、515 |

**请求**：路径参数 `followUpId`。请求体：`lockVersion`（integer，必填）；`nextFollowAt`（string(date-time) \| null，必填；`null` 表示不再需要跟进，行随之不在办）。

**响应**：FollowUpItem。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 记录不存在或不在范围内 |
| `PERMISSION_DENIED` | 403 | 不是负责人或其主管 |
| `STATE_NOT_ALLOWED` | 409 | 已完成（`done_at` 非空） |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符 |
| `VALIDATION_FAILED` | 400 | 时间早于现在；系统生成的行改为 `null` |

**副作用**：写 `follow_up.next_follow_at`，`lock_version + 1`；`audit_log` `activity` 流一行（前后值）。

**说明**：
- 系统生成的行（`channel = 'system'`）的下次跟进时间必填（`ck_follow_up_system_todo`），不能改为 `null`，返回 `VALIDATION_FAILED`。
- 负责人不能人工改：数据模型规定人工记录的负责人等于记录人，只在员工禁用移交或自动改派时变化并写 `assignment_history`（`source = 'follow_up_owner'`，03-staff-authz-audit.md:509）。第二轮删去请求体的 `ownerStaffId`。

### 3.44 admin.followUp.complete　标记跟进完成
`POST /admin/follow-ups/{followUpId}/complete`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`permission: assert-in-handler`（同 3.43） |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 带 `lockVersion`（`follow_up.lock_version`：标记完成时校验，03-staff-authz-audit.md:515） |
| 对应画板 | A:MerchantDetail（“已完成：09-28 确认续费意向”）、A:Main（工作台跟进待办） |
| 出处 | 路线图 `a03.follow-ups.complete`；03-staff-authz-audit.md:494、510-511 |

**请求**：路径参数 `followUpId`。请求体：`lockVersion`（integer，必填）；`doneNote`（string，可选，≤200 字 → `follow_up.done_note`）。

**响应**：FollowUpItem（`isOpen = false`）。

**错误**：`NOT_FOUND`（404）；`PERMISSION_DENIED`（403）；`STATE_NOT_ALLOWED`（409，已完成）；`VERSION_CONFLICT`（409）。

**副作用**：写 `follow_up.done_at`、`done_note`，`lock_version + 1`；`audit_log` `activity` 流一行。

**说明**：
- 没有下次跟进时间的纯记录写入即不在办，不需要标记完成；系统生成的待办来源事项消失时由来源模块调 staff 的接口关闭（03-staff-authz-audit.md:494），不经本接口——例如巡检复查恢复或作废时，a06 经 staff 端口关闭定时器 `patrol.followup` 生成的系统跟进待办。
- 工作台待办 `follow_up_due`（a02）按 `follow_up` 现算（负责人本人、`next_follow_at` 已到、`done_at` 为空），标记完成或改期后自然消失。

### 3.45 admin.followUp.summary　跟进记录计数（V1.1）
`GET /admin/follow-ups/summary`

V1.1，细节待设计。用途：商家详情“跟进记录”页签角标（proto-admin-b.md:82）。查询参数与 3.41 相同（去掉分页），返回 `{ total, openCount }`。门店维度的跟进页签是 V1.1 入口（03-staff-authz-audit.md:501）。鉴权：`permission: assert-in-handler`，与 3.41 用同一张模块对照表（按 `storeId` 查时为商家管理）。幂等 none。字面段先于 `/{followUpId}` 注册。

### 3.46 admin.referralCode.list　渠道码登记列表
`GET /admin/referral-codes`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；商家管理模块查看 |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | 原型无（数据模型有表无页面；建议放在商家管理菜单下“渠道码”） |
| 出处 | 路线图 `a03.referral-codes.list`；02-identity-tenant.md:808-852；PRD 6.1-4 |

**请求**：查询参数：`q`（码值或名称，1–30 字）；`sourceType`（逗号分隔）；`status`（逗号分隔）；`ownerStaffId`（uuid）；`page`、`pageSize`。

**响应**：`{ items: array<ReferralCodeRow>, page, pageSize, total }`，按登记时间倒序。

**错误**：无。

**副作用**：无。

**说明**：渠道码是全局资源，不按门店数据范围过滤。注册数与主体数是现算的归因统计，业绩报表口径以 a02 为准。

### 3.47 admin.referralCode.create　登记渠道码
`POST /admin/referral-codes`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.referral_code.manage`（增补键，建议默认超级管理员与客服主管） |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 无 |
| 对应画板 | 原型无 |
| 出处 | 路线图 `a03.referral-codes.create`；02-identity-tenant.md:815-850 |

**请求**：请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| code | string | 是 | 4–16 位数字与字母，服务端转大写后匹配 `^[0-9A-Z]{4,16}$` | → `referral_code.code`（渠道码与邀请码共用一个命名空间） |
| sourceType | enum(`sales`、`campaign`) | 是 | `partner` 是 V1.1，V1.0 不收 | → `referral_code.source_type` |
| ownerStaffId | string(uuid) | 条件 | `sales` 必填，启用中的员工 | → `referral_code.owner_staff_id`（创建后不可改） |
| label | string | 否 | ≤30 字 | 渠道或活动名称 → `referral_code.label` |

**响应**：ReferralCodeRow（`status = 'active'`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `REFERRAL_CODE_TAKEN` | 409 | 码值已被占用（`uq_referral_code_code`） |
| `VALIDATION_FAILED` | 400 | 码值格式不符；销售码没有归属员工；`sourceType = partner` |

**副作用**：状态 `referral_code.status`：— → `active`（登记，不写 `status_transition`，02-identity-tenant.md:846）；`audit_log` `ops` 流一行。

**说明**：归属员工离职时停用旧码、另发新码，历史注册的业绩归属不变（02-identity-tenant.md:852）。

### 3.48 admin.referralCode.disable　停用渠道码
`POST /admin/referral-codes/{referralCodeId}/disable`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.referral_code.manage` |
| 回显 | 无 |
| 幂等 | required（状态迁移） |
| 乐观锁 | 无（状态表的守卫没有列锁版本，02-identity-tenant.md:847） |
| 对应画板 | 原型无 |
| 出处 | 路线图 `a03.referral-codes.disable`；02-identity-tenant.md:819-820、847 |

**请求**：路径参数 `referralCodeId`；请求体：`{ reasonText?: string（≤200 字） }`。

**响应**：ReferralCodeRow（`status = 'disabled'`）。

**错误**：`NOT_FOUND`（404）；`STATE_NOT_ALLOWED`（409，已停用）。

**副作用**：`referral_code.status`：`active` → `disabled`，写 `disabled_at`；`audit_log` `ops` 流一行。停用后不再用于归因（02-identity-tenant.md:819）。

**说明**：无。

### 3.49 admin.referralCode.enable　重新启用渠道码
`POST /admin/referral-codes/{referralCodeId}/enable`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `merchant.referral_code.manage` |
| 回显 | 无 |
| 幂等 | required（状态迁移） |
| 乐观锁 | 无 |
| 对应画板 | 原型无 |
| 出处 | 路线图 `a03.referral-codes.enable`；02-identity-tenant.md:848 |

**请求**：路径参数 `referralCodeId`；请求体：`{}`。

**响应**：ReferralCodeRow（`status = 'active'`）。

**错误**：`NOT_FOUND`（404）；`STATE_NOT_ALLOWED`（409，已启用）。

**副作用**：`referral_code.status`：`disabled` → `active`，`disabled_at` 清空；`audit_log` `ops` 流一行。

**说明**：停用期间注册的账号不回溯归因。

### 3.50 渠道管理（V1.1）

渠道管理 V1.0 不建表、不写代码（01-architecture.md:176），以下 22 条只列接口，细节待设计。按 A138 暂归本文；V1.1 设计时另起一份渠道管理接口文档，届时本节移出。V1.1 设计时按 A3（`{levelKey}` 是否进自然键清单）、A4、A14（入驻与归属变更是否注册为审批类型）修正。查询类幂等 none，写类 required；查询权限为渠道管理（或财务）模块查看，写类权限点 `partner.*` 届时进注册表。

| operationId | 方法 路径 | 用途 | 对应画板 |
| --- | --- | --- | --- |
| `admin.partner.list` | `GET /admin/partners` | 服务商列表（区域、等级、状态；名下商家、本月名下实付、返佣）。V1.1，细节待设计 | A:Partners |
| `admin.partner.get` | `GET /admin/partners/{partnerId}` | 服务商详情与本月成交前三的商家。V1.1，细节待设计 | A:Partners |
| `admin.partner.adjustLevel` | `POST /admin/partners/{partnerId}/adjust-level` | 手动调整服务商等级（须填原因）。V1.1，细节待设计 | A:Partners |
| `admin.partner.pause` | `POST /admin/partners/{partnerId}/pause` | 暂停合作（须填原因，通知服务商）。V1.1，细节待设计 | A:Partners |
| `admin.partner.resume` | `POST /admin/partners/{partnerId}/resume` | 恢复合作。V1.1，细节待设计 | A:Partners |
| `admin.partnerApplication.list` | `GET /admin/partner-applications` | 服务商入驻申请队列。V1.1，细节待设计 | A:PartnerReview |
| `admin.partnerApplication.get` | `GET /admin/partner-applications/{partnerApplicationId}` | 入驻申请详情（证照比对、申请信息）。V1.1，细节待设计 | A:PartnerReview |
| `admin.partnerApplication.approve` | `POST /admin/partner-applications/{partnerApplicationId}/approve` | 入驻审核通过（指派渠道运营，推送合作协议在线签署）。V1.1，细节待设计 | A:PartnerReview |
| `admin.partnerApplication.reject` | `POST /admin/partner-applications/{partnerApplicationId}/reject` | 驳回入驻申请（原因 + 说明）。V1.1，细节待设计 | A:PartnerReview |
| `admin.partnerBinding.list` | `GET /admin/partner-bindings` | 商家归属记录。V1.1，细节待设计 | A:PartnerBinding |
| `admin.partnerBindingChange.list` | `GET /admin/partner-binding-changes` | 归属变更申请列表。V1.1，细节待设计 | A:PartnerBinding |
| `admin.partnerBindingChange.approve` | `POST /admin/partner-binding-changes/{partnerBindingChangeId}/approve` | 通过归属变更（次日 00:00 生效，通知三方）。V1.1，细节待设计 | A:PartnerBinding |
| `admin.partnerBindingChange.reject` | `POST /admin/partner-binding-changes/{partnerBindingChangeId}/reject` | 驳回归属变更（须填原因）。V1.1，细节待设计 | A:PartnerBinding |
| `admin.partnerLevel.list` | `GET /admin/partner-levels` | 服务商等级、返佣比例与评定标准。V1.1，细节待设计 | A:PartnerLevels |
| `admin.partnerLevel.replace` | `PUT /admin/partner-levels/{levelKey}` | 编辑等级比例、门槛与生效时间。V1.1，细节待设计（`{levelKey}` 按 A64 届时修正） | A:PartnerLevels |
| `admin.partnerLevelChange.list` | `GET /admin/partner-level-changes` | 等级评定、手动调整、比例配置的变更记录。V1.1，细节待设计 | A:PartnerLevels |
| `admin.commissionStatement.list` | `GET /admin/commission-statements` | 返佣结算单列表（当月为预估）；财务服务商结算页复用。V1.1，细节待设计 | A:PartnerSettle、A:FinSettle |
| `admin.commissionStatement.summary` | `GET /admin/commission-statements/summary` | 结算单月度汇总卡（应付、已打款、待打款、异议）。V1.1，细节待设计 | A:PartnerSettle、A:FinSettle |
| `admin.commissionStatement.get` | `GET /admin/commission-statements/{commissionStatementId}` | 结算单详情与处理记录。V1.1，细节待设计 | A:PartnerSettle |
| `admin.commissionStatement.line.list` | `GET /admin/commission-statements/{commissionStatementId}/lines` | 结算明细（付款单逐笔）；“下载明细”走导出任务。V1.1，细节待设计 | A:PartnerSettle |
| `admin.commissionStatement.recordPayout` | `POST /admin/commission-statements/{commissionStatementId}/record-payout` | 登记返佣打款（转账日期、流水号、回单）。V1.1，细节待设计 | A:FinSettle |
| `admin.commissionStatement.replyDispute` | `POST /admin/commission-statements/{commissionStatementId}/reply-dispute` | 回复服务商异议并重新推送确认。V1.1，细节待设计 | A:PartnerSettle |

## 4. 枚举

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `store.qualification_status`、`entity.verification_status` | 同数据模型 | `unsubmitted`、`pending`、`verified`、`rejected` |
| `store.lifecycle`、`store.archive_reason` | 同数据模型 | `active`、`archived`；`by_owner`、`draft_deleted`、`entity_closed`、`entity_abandoned` |
| `entity.lifecycle`、`entity.entity_type`、`entity.source_type` | 同数据模型 | `active`、`abandoned`、`closed`；`enterprise`、`individual`；`organic`、`sales`、`campaign`、`partner` |
| `merchant_user.status` | 同数据模型 | `active`、`disabled`、`deleted` |
| `entity_member.role`、`status`、`remove_reason` | 同数据模型同名列 | 见 02-identity-tenant.md:940-942 |
| `account_change_request.kind` | 同数据模型 | `phone_rebind`、`owner_transfer`、`owner_reverify` |
| `approval_request.status` | 同数据模型 | `pending`、`approved`、`rejected`、`withdrawn` |
| `qualification_submission.kind`、`outcome`、`approve_mode`、`system_reject_code`、`changed_fields`、`claimed_entity_type` | 同数据模型同名列 | 见 04-profile.md:518-523 |
| `qualification_doc.doc_type`、`scope`、`origin`、`principal_role`、`subject_type`、`verdict` | 同数据模型同名列 | 见 04-profile.md:524-529 |
| `store_asset.type`、`processing_state`、`review_state`、`usability`、`moderation_state` | 同数据模型同名列 | 见 06-media.md 第 3.1 节 |
| `store_asset_tag.dimension`、`source` | 同数据模型 | `content`、`usage`、`timeliness`；`auto`、`uploader`、`reviewer` |
| `store_asset_insight.kind` | 同数据模型 | `transcript`、`vision`、`doc_text`、`structured_items`、`digest`、`tech_spec` |
| `store_asset_demand.status`、`notify_scope` | 同数据模型 | `open`、`done`、`canceled`；`owner_and_clerks`、`owner_only` |
| `follow_up.subject_type`、`channel`、`intent` | 同数据模型 | 见 03-staff-authz-audit.md:877-879 |
| `referral_code.source_type`、`status` | 同数据模型 | `sales`、`campaign`、`partner`；`active`、`disabled` |
| `billing_order.type`、`status` | 同数据模型 | 见 08-billing-payment.md 2.1 |
| `SubscriptionStatus` | 同 m07-billing | `none`、`active`、`expired`（现算） |
| `OcrStatus`、`ExpiryState`、`RoundPhase`、`PhoneVerifyState`、`MissingItemKey` | 同 m03-profile-asset | 识别结果、证照到期提示、轮次阶段、联系人手机号验证状态（`login`、`sms_verified`、`unverified`）、完整度缺项键 |
| `DeletionBlockerKind` | 同 m01-account | `ENTITY_CLOSE_BLOCKED` 的阻断项类型；未完成订购一项按 A134 统一为 `open_order` |
| `AssigneeInvalidReason` | 同 a05-order-delivery | `ASSIGNEE_INVALID.details.reason`：`not_active`、`role_mismatch`、`same_as_current`、`out_of_scope` |
| `StoreListSort`（接口枚举） | `-lastOrderAt`、`-createdAt`、`-totalPaidFen` | 按最近订购、注册时间、累计实付倒序（proto-admin-b.md:40） |
| `AdminAssetTab`（接口枚举） | `all`、`organizing`、`adopted` | 门店素材状态分段：全部、待整理、已采用 |
| `AdminAssetStatus`（接口枚举） | `organizing`、`organized`、`adopted` | 待整理、已整理、已采用（后台的展示状态，商家端另用 m03 的 `AssetDisplayStatus`） |
| `ProxyEditReason`（接口枚举） | `merchant_phone_request`、`merchant_wecom_request`、`data_correction`、`other` | 商家电话委托、商家企业微信委托、资料有误经商家确认后更正、其他（d9-profile.md:619；契约枚举，不建字典） |
| `ManagerTransferReason`（接口枚举） | `workload`、`merchant_request`、`staff_change`、`other` | 工作量调整、商家要求更换、人员调岗或离职、其他；取值是 `assignment_history.reason_code` 的子集 |
| `ApproveModeInput`（接口枚举） | `normal`、`override` | 资质通过方式；`corrected` 由服务端按有无修正值判定 |
| `FieldCheckResult`（接口枚举） | `pass`、`fail`、`warn`、`manual`、`info` | 证照比对结论：通过、不通过、提醒、需人工、提示（04-profile.md:596 写“取值编码待契约定稿”，本文定） |
| `FollowUpSubjectInput`（接口枚举） | `order_item`、`subscription_term`、`patrol_task`、`takedown_task`、`delivery_reissue` | V1.0 可人工记录跟进的对象；V1.1 加 `store` |
| `AccountChangePrecheckIssue`（接口枚举） | `phone_taken`、`phone_occupied_by_empty_account`、`new_owner_in_other_entity`、`target_not_active`、`entity_not_active` | 账号变更的前置条件提示，也是 `PRECONDITION_CHANGED` 的 `details.reason` 取值；`phone_taken` = 占用方在 `entity_member` 里有过任何一行或不是 `active`，`phone_occupied_by_empty_account` = 占用方 `active` 且从未有过成员关系 |
| `LimitReason`（接口枚举） | `plan`、`inactive` | 名额上限的来源：按套餐（或覆盖值）、未开通或已过期按默认参数（d4-identity.md:650 的 `reason`） |
| `order_item.usage_end_source` | 同数据模型 | StoreHeader.liveSummary 的使用期止日来源 |

接口枚举与响应里的数据模型枚举都标 `x-open-enum`（C37）。

## 5. 错误码

本文新定义的领域错误码。租户段 41300–41399，审批段 48200–48299，资质审核段 49100–49199，素材复核段 46300–46399（A70）。`retryable` 都为否。

| 符号名 | 数值 | HTTP | 含义 | `details` |
| --- | --- | --- | --- | --- |
| `ENTITY_CLOSE_BLOCKED` | 41301 | 409 | 主体还有未办结的事项，暂不能关闭 | `{ blockers: DeletionBlocker[] }`（结构同 m01-account） |
| `REFERRAL_CODE_TAKEN` | 41302 | 409 | 该码值已被登记 | `{ code: string }` |
| `STORE_MANAGER_UNASSIGNED` | 41303 | 409 | 门店还没有交付经理，不能转移，请先指派 | — |
| `STORE_MANAGER_ASSIGNED` | 41305 | 409 | 门店已有交付经理，请用“转移交付经理” | `{ deliveryManagerId: string }` |
| `APPROVAL_NOT_PENDING` | 48201 | 409 | 该申请已处理或已撤回 | `{ status: string, decidedAt: string \| null }` |
| `APPROVAL_SELF_FORBIDDEN` | 48202 | 403 | 不能审批自己发起的申请 | — |
| `APPROVAL_ALREADY_PENDING` | 48203 | 409 | 该对象已有一张待审批的同类申请 | `{ approvalId: string, requestNo: string \| null }` |
| `APPROVAL_WITHDRAW_FORBIDDEN` | 48204 | 403 | 只有发起人可以撤回（发起人已停用时由有审批权的人代撤） | — |
| `QUALIFICATION_CHECK_FAILED` | 49101 | 409 | 系统比对有不通过的项，请修正字段或驳回 | `{ items: array<{ qualificationDocId, code, field }> }` |
| `QUALIFICATION_FINAL_NOT_ALLOWED` | 49102 | 409 | 变更重审不能终局驳回 | — |
| `FIELD_NOT_PROXY_EDITABLE` | 49103 | 400 | 门店名称、地址、行业与品类、联系人及资质须由商家提交修改 | `{ fields: string[] }` |
| `PROXY_EDIT_NO_CHANGE` | 49104 | 400 | 没有检测到修改内容 | — |
| `ASSET_ALREADY_ADOPTED` | 46301 | 409 | 素材已被采用，不能改为需补拍或需肖像授权 | `{ adoptedCount: integer }` |
| `ASSET_PORTRAIT_AUTH_MISSING` | 46302 | 409 | 还没有肖像授权材料，不能确认授权 | — |
| `ASSET_NOT_PROCESSED` | 46303 | 409 | 素材还在识别中，请稍后再整理 | `{ processingState: string }` |

引用其他来源的错误码：通用码 `VALIDATION_FAILED`、`PERMISSION_DENIED`、`STEP_UP_REQUIRED`、`NOT_FOUND`、`VERSION_CONFLICT`、`STATE_NOT_ALLOWED`、`CONFIRM_MISMATCH`、`PRECONDITION_CHANGED`（C27）；`PHONE_TAKEN`、`PHONE_UNCHANGED`、`CONTENT_REJECTED`（m01-account）；`PHONE_IN_OTHER_ENTITY`（m02-tenant）；`USCC_TAKEN`、`FILE_NOT_USABLE`、`PROFILE_REQUIRED_MISSING`（m03-profile-asset）；`ASSIGNEE_INVALID`（a05-order-delivery，45308，`details = { staffId, reason }`，`reason` 取 a05 的 `AssigneeInvalidReason`：`not_active`、`role_mismatch`、`same_as_current`、`out_of_scope`；A77 的共用码归属）。

说明：
- 41304（原 `TRANSFER_TARGET_INVALID`）按 A77、C28 删除，改引 `ASSIGNEE_INVALID`；该数值不再复用。`STORE_MANAGER_ASSIGNED`（41305）是第二轮为 3.8a 新增。
- 审批段的四个码是统一审批单的通用码（d4-identity.md:1398、1412、2335-2336；03-staff-authz-audit.md:808），资质、账号核验、链接核验、退款、取消、积分调整、补偿延长、受控财务配置、对公复核的决定与撤回接口（a05、a06、a07 等）直接引用本文的符号，不另定义。
- `FIELD_NOT_PROXY_EDITABLE`、`PROXY_EDIT_NO_CHANGE` 属档案（profile）领域，A70 没有给本文档案段，暂放资质审核段 49103、49104；主负责人若要求放进 m03 的档案段，只改数值。

## 6. 待确认

只留需要产品、业务、法务决定的问题（A108）；第一轮其余各项已由第十节裁决关闭或转给主负责人，见第 7 节第二轮。

| # | 问题 | 默认做法 | 谁定 |
| --- | --- | --- | --- |
| 1 | 页头“付费 N 家”的口径：原型区分“付费”与“套餐生效”，PRD 9.1 只定义了“付费主体数 = 当月套餐生效的经营主体数” | “付费”= 所属主体有过已支付的付款单；“套餐生效”= 订阅现算为生效 | 产品 |
| 2 | 代改档案的范围与形态：PRD 是全部免审字段，原型只开放 6 个文本字段、营业时间与卖点是单行文本 | 接口按 PRD 的全部免审字段与结构化形态；表单开放哪些由前端定（9-C15）；地址整体不可代改 | 产品 |
| 3 | 资质审核详情不再在 GET 里给证照明文（A19），审核员逐字核对要点“查看明文”（每次写 access 审计、受每人每小时 60 次限频） | 按 A19；若审核效率受影响，可给 `merchant.qualification.review` 持有人在待审轮次上单独放宽 pii-reveals 的限频 | 产品、法务 |
| 4 | 素材软删除用 `merchant.asset.review` 还是另设权限点；删除是否通知商家 | 沿用 `merchant.asset.review`；不通知商家（只写审计） | 产品、法务 |
| 5 | 账号变更没有决定时限参数（14 分组的 `sla.review.*` 里没有），审批单 `due_at` 为空 | 不计时；靠 `approval.I5` 的超期清单与工作台“我的待审批”提醒 | 产品 |
| 6 | 资质驳回原因：原型单选，字典与审批单列是多值 | 接口收 1–3 个，前端单选时只传一个 | 产品 |
| 7 | 跟进记录的下次跟进：商家详情原型填日期，逾期跟踪原型选三个时点，库里是时刻 | 接口收时刻；只选日期时前端传当日 09:00（+08:00），与“到期当日 09:00 提醒”一致 | 产品 |
| 8 | 首次指派交付经理（3.8a，以及系统轮询分配）后，是否也要求新交付经理 1 个工作日内联系商家：PRD 7.4-4 与数据模型只对“交付经理变更”记联系时限（`assignment_history.contact_due_at`），首次指派没有原负责人、不写改派记录 | 不要求；商家在订购成功页与“服务经理”名片上能看到企业微信。若要求，需数据模型给首次指派另找落点（如门店行加联系截止列），属数据模型改动 | 产品、业务 |

## 7. 修订记录

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：路线图 `doc = a03-merchant` 的 71 条接口（V1.0 48 条写到字段级，V1.1 23 条列用途）；定义错误码 41301–41304、48201–48204、49101–49104、46301–46303；建议补首次指派交付经理的接口（第二轮定名 `admin.store.assignDeliveryManager`） | 写作规范；A1–A75；C1–C84；数据模型 01、02、03、04、06 及 07–10、12、14 的读侧列 |
| 2026-10-03 | 第二轮：① 按 A91 补 `admin.store.assignDeliveryManager`（3.8a，`merchant.manager.assign`，不写改派记录、同步未结订购单并分配待分配工单），新增 `STORE_MANAGER_ASSIGNED`（41305），删去初稿“补首次指派接口”的建议；② 按 A77 删除 `TRANSFER_TARGET_INVALID`（41304），3.8 改引 a05 `ASSIGNEE_INVALID`；3.8 的移交范围与弹层计数统一为“负责人为原交付经理”，写明负责人为空或已是接收人时的处理，补每张客服工单的 `service_ticket.transferred`；③ 审批决定的守卫顺序按 C7 与 d4 中间件改为“权限 → 再验证 → 取对象 → 审批守卫”，明确“路由键 + 处理器追加判定”（3.26 放行）；账号变更驳回随注册表要求再验证（3.21 补 `STEP_UP_REQUIRED`）；④ 资质审核：`QualificationSubmissionDetail` 补轮次 `lockVersion`、`canOverride`、`entity.verifiedAt`、`entity.verifiedStores`、`relatedOrders[].title`；修正识别字段同事务升审批单锁版本，使并发修正后的通过返回 `VERSION_CONFLICT`；动作去掉 `override`；⑤ 账号变更：换绑清理空账号按 02 第 2.1 节六步并发 `merchant_user.deleted`，老板更换补 `entity_member.promoted`，`PHONE_TAKEN` 与 `precheck` 的空账号口径改为“`entity_member` 里没有任何行”；⑥ 关闭主体补 `invitation.revoked`、`entity.closed.closedBy = staff_close`、待审批取消申请的系统撤回（09-order-ad.md:550，x01 归属）及 `cancel.withdrawn`、`approval.withdrawn`，回显改取 `usage.activeMemberCount`，阻断检查复用 m01 端口；⑦ `EntityCard.usage` 按 d4 `limits()` 取上限并加 `limitReason`、`activeMemberCount`，`pendingInvitations` 移入主体卡片，`admin.entity.member.list` 改为 `{ items }` 并加 `role` 筛选（A78、C43）；⑧ `StaffBrief` 改引 a01 2.2，`StoreActivityItem` 复用 a01 `AuditLogItem`；导出键改为 `stores.list`；`actions` 动作名按 C12 改为 `update-profile`、`update-quota`；⑨ 页面字段：`StoreRow.entity.primaryStoreName`、`StoreHeader.liveSummary`；3.32 响应改用 `adminStatus`；⑩ 跟进记录：3.41、3.45 声明 `assert-in-handler`，3.42 负责人固定为记录人、3.43 只改下次跟进时间（删去 `ownerStaffId`）；⑪ 第 6 节只留产品、业务、法务问题（8 项），其余已由裁决关闭（成员列表不分页 A78、审计类别 A107、事件名 A95）或转主负责人（回显范围、增补权限点、数据模型回写、渠道管理另起文档）；⑫ 路线图切片同步：`permission` 改 `assert-in-handler` 的 7 条（作者提的 5 条加 3.41、3.45），`admin.entity.close` 的 `transitions` 改正为 `store.lifecycle` 并补邀请与取消申请，`admin.accountChangeRequest.approve` 补 `purge_empty` 与新建老板行，资质驳回的 `isFinal`、通过的请求体说明（去掉“可带清单结论”）、商家列表的查询参数与导出键 | A76–A120（A77、A78、A91、A95、A107、A108、A119、A120）；C7、C12、C16、C28、C43、C46、C53、C54、C66；两位复核员意见；xdoc 请求（a01、a02、a05、a06、a07、a08、m01、m03） |
| 2026-10-03 | 第三轮：① A127、C86：账号变更驳回（3.21）声明 `x-step-up: skip`，错误表删去 `STEP_UP_REQUIRED`，1.1“再验证”“守卫顺序”同步；资质驳回的权限点未标再验证，不登记。② A136：转移交付经理改名 `admin.store.reassignDeliveryManager`（`POST …/reassign-delivery-manager`），动作名改 `reassign-delivery-manager`；修订记录里的旧建议名去掉反引号。③ A143：3.20 老板更换写全“建号（`merchant_user.register`，不检查协议同意，发 `merchant_user.registered`，`via = owner_transfer`）→ 先移除原老板 → 升店员或新建 owner 行（`entity_member.create_owner`）”的次序与依据（02-identity-tenant.md:125、690、694、697），删去“待数据模型回写”；3.24 补 03-staff-authz-audit.md:759、04-profile.md:333 的“只升锁版本”。④ A132、C87：`ApprovalBrief` 改引 a01 `ApprovalDecisionView`（超时看 `badges`，`requestNo`、`confirmChecks` 移到领域结构），`DictLabel` 改为 `DictRef`，`SignedUrl` 改引 a01，`PortraitAuthBody` 改引 m03，各列表响应改用 a01 `AdminPage<T>` / `AdminCursorPage<T>`；`FollowUpItem` 仍由本文定义。⑤ A133、C85：`AdminStoreProfile.sellingPointCodes` → `sellingPoints: DictRef[]`，素材识别建议的 `contentTagCodes`、`usageTagCodes` → `contentTags`、`usageTags`。⑥ 跨文档请求：`EntityCard.usage` 按 m02 2.1（`tenant.getQuotaUsage`；`storeLimit`、`seatsUsed`、`memberLimit`、`storesOver`、`seatsOver`）；关闭主体调 m02 主体关闭联动与 m07 `billing.deletionGuard`，阻断项名 `open_order`（A134）；`StoreRow.points` 字段带 `Points` 后缀，`isRefundPending` 改主体级口径（m07）；联系人快照 `phoneSource` → `phoneVerifyState`，3.23 写明审批单摘要的取值（m03）；`CONTENT_REJECTED.details.fields`、检测不可用 503 `PROVIDER_UNAVAILABLE`（m01、A131、A137）；`ASSIGNEE_INVALID` 改 `{ staffId, reason }` 并补 `out_of_scope` 守卫，终局驳回试算的广告口径含 `returned_from = pending_assign`（a05）；1.1 写明 a01 2.17 的文件授权矩阵；`admin.storeAsset.list`、`summary` 在待整理页签允许不传 `storeId`（跨门店整理队列，a02），行加 `storeName`。`StoreActivityItem` 维持 a01 `AuditLogItem`（a04 的请求转主负责人）。⑦ 3.50 按 A138 写明暂归本文；第 6 节 8 项均未被 A127–A146 裁决，保留。⑧ 清单：删去被引用替代的 11 个结构，补 `externalSchemas`，`proposedPermissions` 按 A140 改为 `permissionSupplements`（加 `confirmEcho`）；路线图切片同步改名、`xStepUp: skip` 与备注 | A127、A131–A138、A140、A143；C85–C87；`review/r3-in-a03-merchant.md`（m01、m02、m03、m07、a01、a02、a04、a05 的请求） |
| 2026-10-03 | 第四轮：① A151、C85：响应里的单值字典字段改为 DictRef \| null——`StoreRow`、`StoreHeader`、`AdminStoreProfile`、资质审核详情 `store` 的 `industryCode`、`categoryCode` → `industry`、`category`，`regionCodes { provinceCode, cityCode, districtCode, zoneCode }` → `region { province, city, district, zone }`，商家详情 `address` 的 `cityCode`、`districtCode` → `city`、`district`，证照与轮次里的 `permitType` 改为 DictRef；请求（列表筛选、代改禁止键）仍收编码。② x01 3.2、A143：老板更换新建 owner 行一支也发 `entity_member.promoted`，删去“待 x01 决定”的说明。m01（`open_order`）与 a01（`DictRef`）的请求第三轮已做到 | A151；x01 3.2；`review/r4-in-a03-merchant.md` |
