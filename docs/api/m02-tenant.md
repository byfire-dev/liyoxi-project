# 商家端：主体、门店与成员

| 项 | 内容 |
| --- | --- |
| 范围 | 经营主体的懒创建；门店列表、新增、停用、删除草稿门店、恢复、记住当前门店；成员列表、调整店员所属门店、移除店员、店员退出；邀请店员（创建、上报已分享、撤回、落地页、接受）；电脑端下载页的扫码授权确认与“已授权的电脑”。画板：M:StoreSwitch、M:Stores、M:StoreAdd、M:Mine、M:Members、M:Invite、M:Join、M:StaffProfile、M:Profile（成员摘要）、M:Main / M:Detail / M:Cart（懒创建入口）；原型无：设置页的“已授权的电脑”与“退出门店”、下载页扫码确认页 `sub/publish/portal-approve`、邀请的异常态 |
| 接口数 | 22（V1.0 21，V1.1 1） |
| 依据 | 数据模型 `02-identity-tenant.md`（`entity`、`store`、`entity_member`、`store_member`、`invitation`、`portal_ticket`、`portal_session`），另引 `04-profile.md`、`06-media.md`、`07-billing-ledger.md`、`09-order-ad.md`、`13-notify-docs.md`；草案 d4-identity 第 3.4、4、5 节与附录 A、B，d7-platform 第 4.5、4.6、6 节，d9-profile 第 4.4、7.2 节；接口裁决 A1–A150（`api-rulings.md`）；通用约定 C1–C87（`conventions.md`）；资源登记表 `resources.json`；事件目录 `x01-events-jobs.md` |

## 1. 概览

本文是租户（tenant）与下载页授权在商家端的接口。门店上下文用请求头 `X-Store-Id`，主体由门店推出（C17；d4:811-827）。门店本身是操作对象的三个动作（停用、删除草稿、恢复）在路径里带 `storeId`，服务端同时校验它与 `X-Store-Id` 所在门店属于同一主体，否则 404。门店数与成员名额不存计数列：改变用量的写接口在事务开头锁主体行，在锁内现数（d4:664）。店员能调的只有门店列表、成员列表（都按角色裁剪）、记住当前门店与退出门店；其余接口店员 403 `ROLE_FORBIDDEN`。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `m.entity.create` | `POST /m/entities` | 懒创建经营主体、首家门店、老板成员关系与计费账户 | `user` | required |
| `m.store.list` | `GET /m/stores` | 我可见的门店与主体额度 | `user`；店员 trimmed | none（查询） |
| `m.store.create` | `POST /m/stores` | 新增门店并按勾选复制档案 | `member`；`store.create` | required |
| `m.store.archive` | `POST /m/stores/{storeId}/archive` | 老板停用门店 | `member`；`store.archive` | required |
| `m.store.delete` | `POST /m/stores/{storeId}/delete` | 删除草稿门店（只做停用） | `member`；`store.archive` | required |
| `m.store.restore` | `POST /m/stores/{storeId}/restore` | 恢复老板停用的门店 | `member`；`store.restore` | required |
| `m.me.currentStore.replace` | `PUT /m/me/current-store` | 记住当前门店 | `member`；`me.*` | required |
| `m.member.list` | `GET /m/members` | 当前门店的成员、待接受邀请与名额 | `member`；`member.list`；店员 trimmed | none（查询） |
| `m.member.update` | `PATCH /m/members/{memberId}` | 调整店员所属门店 | `member`；`member.manage` | required |
| `m.member.remove` | `POST /m/members/{memberId}/remove` | 移除店员 | `member`；`member.manage` | required |
| `m.me.membership.leave` | `POST /m/me/membership/leave` | 店员退出主体 | `member`；`me.*` | required |
| `m.invitation.create` | `POST /m/invitations` | 预创建邀请卡片（未分享的复用） | `member`；`member.manage` | natural（`uq_invitation_inviter_member_id_client_request_id`） |
| `m.invitation.markShared` | `POST /m/invitations/{invitationId}/mark-shared` | 上报已分享 | `member`；`member.manage` | required |
| `m.invitation.revoke` | `POST /m/invitations/{invitationId}/revoke` | 撤回待接受的邀请 | `member`；`member.manage` | required |
| `m.invitation.lookup` | `GET /m/invitations/lookup?token=` | 邀请落地页信息 | `public` | none（查询） |
| `m.invitation.accept` | `POST /m/invitations/{invitationId}/accept` | 接受邀请 | `user` | required |
| `m.portalTicket.lookup` | `GET /m/portal-tickets/lookup?code=` | 扫码或手输代码后取票据摘要 | `member`；`portal.authorize` | none（查询） |
| `m.portalTicket.approve` | `POST /m/portal-tickets/{portalTicketId}/approve` | 允许这台电脑下载本店成片 | `member`；`portal.authorize` | required |
| `m.portalTicket.reject` | `POST /m/portal-tickets/{portalTicketId}/reject` | 拒绝 | `member`；`portal.authorize` | required |
| `m.portalSession.list` | `GET /m/portal-sessions` | 已授权的电脑 | `member`；`portal.authorize` | none（查询） |
| `m.portalSession.revoke` | `POST /m/portal-sessions/{portalSessionId}/revoke` | 撤销某台电脑的授权 | `member`；`portal.authorize` | required |
| `m.delegation.create` | `POST /m/delegations` | V1.1：授权管理员代为确认 | `member` | required |

路由注册顺序（A8、C12）：`GET /m/invitations/lookup` 先于 `/m/invitations/{invitationId}/…`，`GET /m/portal-tickets/lookup` 先于 `/m/portal-tickets/{portalTicketId}/…`。

本文用到的能力点（d4:852-871）：`store.create`、`store.archive`、`store.restore`、`member.list`、`member.manage`、`portal.authorize`、`me.*`。已停用门店（`store.lifecycle = archived`，原因 `by_owner`）的老板在该门店上下文里只有收尾能力点，本文里能用的是 `store.restore`、`portal.authorize`、`me.*`（含 `m.me.currentStore.replace`、`m.me.membership.leave`）；其余接口在中间件返回 403 `STORE_ARCHIVED`（C17；d4:825）。`archive_reason = draft_deleted` 的门店作为 `X-Store-Id` 一律 403 `NOT_A_MEMBER`，作为路径参数一律 404。门店列表 `m.store.list` 是 `user`，按成员关系现算，不设能力点（C56）。

**加锁次序**：本文的写事务按数据模型的全局次序从小到大取行锁：`merchant_user`（80）→ `entity`（100）→ `invitation`（110）→ `entity_member`（120）→ `store`（130）。同类多行按 id 升序。门店生命周期的守卫在持有主体锁时判断（门店的全部生命周期迁移都先锁主体行，`02-identity-tenant.md:603`），所以门店行可以最后锁。

**对其他模块提供的函数**（契约只登记名字与口径，签名由实现定）：

| 函数 | 用途 | 调用方 |
| --- | --- | --- |
| `tenant.getQuotaUsage(entityId)` | 按 2.1 现算 `storesUsed`、`storeLimit`、`seatsUsed`、`memberLimit`、`storesOver`、`seatsOver`、`limitReason`；额度与名额的唯一口径 | 本文 `m.store.list`、`m.member.list`；m07 `m.wallet.get` 的 `usage`；a03 主体详情的 `usage`；m08 `m.me.overview.get` |
| `tenant.assertWithinQuota(entityId)` | `storesOver > 0` 时抛 `QUOTA_EXCEEDED`（d4:673） | m04 `m.order.create`；m06 `m.ad.create`；两者的 `quote` 把它作为 `blockers` 的一项 |
| `tenant.previewQuota(entityId, { maxStores, maxMembers })` | 降级预演：按 2.1 现算当前 `storesUsed`、`seatsUsed`，返回 `{ storesToRemove, membersToRemove }` = `max(0, 用量 − 新上限)`；`maxMembers` 为空（不限）时 `membersToRemove = 0`；不写库（d4-identity.md:682） | m07 `m.plan.quote`（`downgradeImpact`）、`m.paymentOrder.create`（与 `acknowledgedDowngradeImpact` 比对） |
| 门店停用联动 | 撤回该门店待接受的邀请、删 `store_member`、移出只属于该门店的店员、清空 `last_store_id`（`02-identity-tenant.md:614`） | 本文 `m.store.archive`、`m.store.delete` |
| 主体关闭联动 | 撤回全部待接受邀请（`entity_closed`）、移除全部有效成员、停用全部门店（`entity_closed`）、吊销下载页会话（`membership_changed`）（`02-identity-tenant.md:531`） | m01 `m.me.deletion.create`（老板注销）、a03 `admin.entity.close`；两处调用同一函数，联动内容一致 |

名额超限的提醒（降级周期生效、套餐到期后）由订阅者 `tenant.onEntitlementChanged` 消费 `billing.subscription.rolled_over` / `.expired` 完成（x01 第 3 节），不经接口。

## 2. 公共结构

### 2.1 名额与额度的计算口径

所有名额字段都在读时现算，不落库（d4:644-663；`02-identity-tenant.md:552`）。本节是额度与名额的唯一口径，由 `tenant.getQuotaUsage` 实现（第 1 节）；其他文档展示同一组量时引用它，字段名用本节的 `storesUsed`、`storeLimit`、`seatsUsed`、`memberLimit`，`null` 只表示“不限”。

| 量 | 规则 | 来源 |
| --- | --- | --- |
| `storeLimit` | `entity.store_limit_override`；为空时，订阅生效取当前周期的 `subscription_term.max_stores`，否则取参数 `tenant.default_store_limit`（默认 1） | d4:648；权益经 `billing.getEntitlements` 取（`07-billing-ledger.md` 2.9） |
| `memberLimit` | `entity.member_limit_override`；为空时，订阅生效取 `subscription_term.max_members`（空 = 不限），否则取参数 `tenant.default_member_limit`（默认 3） | d4:649 |
| `limitReason` | 订阅生效为 `plan`，否则为 `inactive`；只用于文案（引导升级，或引导开通、续费） | d4:650、671 |
| `storesUsed` | 本主体 `store.lifecycle = active` 的门店数（草稿门店也算；已停用的不算） | d4:653、665、794 |
| `seatsUsed` | 本主体 `entity_member.status = active` 且 `entity_member.role = clerk` 的人数，加 `invitation.status = pending` 且 `invitation.expires_at > now` 的邀请数（老板不占名额） | d4:654-655；PRD 6.16.2 第 2 条 |
| `storesOver` / `seatsOver` | `max(0, 用量 − 上限)`；`memberLimit` 为空时 `seatsOver = 0` | d4:657-659 |

### 2.2 `EntityQuotaCard` 主体与额度（老板）

用于 `m.store.list` 的 `entity`（M:Stores 的主体卡、M:StoreSwitch 与 M:StoreAdd 的“专业版可管理 3 家门店，已有 2 家，还可新增 1 家”）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `entityId` | string(uuid) | 是 | 主体 | `entity.id` |
| `name` | string \| null | 是 | 营业执照主体名称；认证通过前为空，端上回落为“我的经营主体” | `entity.name` |
| `verificationStatus` | enum | 是 | 主体认证结论，取值同数据模型 `entity.verification_status` | `entity.verification_status` |
| `subscription` | object \| null | 是 | 当前套餐；从未开通为 null | 见下三行 |
| `subscription.planName` | string | 是 | 版本名称，如“专业版” | `plan.name`（经 `subscription_term.plan_id`） |
| `subscription.endDate` | string(date) | 是 | 有效期止日（含），“有效期至 10-12” | `subscription_term.end_date` |
| `subscription.isActive` | boolean | 是 | 当前是否生效；过期后仍返回最近一个周期 | 计算：权益查询 `billing.getEntitlements` 的 `subStatus = active` |
| `storesUsed` | integer | 是 | 见 2.1 | 计算 |
| `storeLimit` | integer | 是 | 见 2.1 | 计算 |
| `seatsUsed` | integer | 是 | 见 2.1；“成员名额 3 / 10 位” | 计算 |
| `memberLimit` | integer \| null | 是 | 见 2.1；null = 不限 | 计算 |
| `pendingInvitationCount` | integer | 是 | 本主体待接受且未过期的邀请数（含在 `seatsUsed` 里） | 计算：`invitation.status`、`invitation.expires_at` |
| `storesOver` | integer | 是 | 见 2.1；大于 0 时全部门店不能新订购（`QUOTA_EXCEEDED`） | 计算 |
| `seatsOver` | integer | 是 | 见 2.1；大于 0 时不能新增邀请 | 计算 |
| `limitReason` | enum(`plan` / `inactive`) | 是 | 见 2.1 | 计算 |
| `canAddStore` | boolean | 是 | `storesUsed < storeLimit`；为假时“新增门店”按 `limitReason` 引导升级或开通 | 计算 |

**`EntityBrief` 主体摘要**（店员视图的 `entity`，不含额度，C56）。本文是唯一定义（C87；A132、A150），m01 `GET /m/me` 的 `entity` 引用它；m03 档案页的 6 字段主体结构与它不同构，由 m03 改名。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `entityId` | string(uuid) | 是 | 主体 | `entity.id` |
| `name` | string \| null | 是 | 营业执照主体名称；认证通过前为空 | `entity.name` |
| `verificationStatus` | enum(`EntityVerificationStatus`) | 是 | 主体认证结论 | `entity.verification_status` |

### 2.3 `StoreCard` 门店卡（老板）

用于 `m.store.list` 的 `items`、`m.store.create` 与三个门店动作的响应。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `storeId` | string(uuid) | 是 | 门店 | `store.id` |
| `name` | string \| null | 是 | 门店名称；首家门店在建档第 1 步之前为空 | `store.name` |
| `isPrimary` | boolean | 是 | 首家门店 | `store.is_primary` |
| `lifecycle` | enum | 是 | `active` / `archived`，同数据模型 `store.lifecycle` | `store.lifecycle` |
| `archiveReason` | enum \| null | 是 | 停用原因；列表里只会出现 `by_owner`（`draft_deleted` 不展示；随主体停用的门店此时已无有效成员关系） | `store.archive_reason` |
| `archivedAt` | string(date-time) \| null | 是 | 停用时间 | `store.archived_at` |
| `isLastSelected` | boolean | 是 | 是否本人上次选择的门店（端上“当前门店”标记以本地选择为准） | 计算：`entity_member.last_store_id = store.id` |
| `city` | `DictRef` \| null | 是 | 城市，“成都 · 火锅”的前半（C85、A151） | `store_profile.city_code` + 字典 `region` 的 `dict_item.name` |
| `category` | `DictRef` \| null | 是 | 二级品类（C85、A151） | `store_profile.category_code` + 字典 `industry` 的 `dict_item.name` |
| `qualificationStatus` | enum | 是 | 门店资质结论，同数据模型 `store.qualification_status` | `store.qualification_status` |
| `verifiedAt` | string(date-time) \| null | 是 | 首次审核通过时间，“06-13 认证通过” | `store_profile.first_verified_at` |
| `submittedAt` | string(date-time) \| null | 是 | 在审轮次的提交时间，“09-29 18:20 提交审核”；没有在审轮次为空 | `qualification_submission.submitted_at`（`closed_at` 为空且 `submitted_at` 非空的那一轮） |
| `expectedDecisionAt` | string(date-time) \| null | 是 | 预计完成时间，“预计今天 18:20 前完成” | 该轮审批单的 `approval_request.due_at` |
| `completenessPct` | integer | 是 | 建档完整度 0–100（整数百分数，数据模型登记的约定例外） | `store_profile.completeness_pct`；档案行未建时为 0 |
| `liveCount` | integer | 是 | 上线中的剧数 | 计算：本门店 `order_item.phase = live` 的行数；取 m04 `order.countOrderItemsByPhase` 的 `live`（m04 2.9） |
| `deliveringCount` | integer | 是 | 交付中的剧数 | 计算：本门店 `order_item.phase` 为 `producing`、`to_launch` 的行数，不含 `pending_start`（待开工）；取 `order.countOrderItemsByPhase` 的 `delivering`（m04 2.9）。这是“交付中”，与 m04 `m.orderItem.summary` 的“待上线”页签（含 `pending_start`）是两个量，各用各的计数函数；m08 `m.me.overview.get` 的 `deliveringCount` 用本口径 |
| `assetCount` | integer | 是 | 门店素材数 | 计算：本门店 `store_asset.deleted_at` 为空的行数 |
| `clerkCount` | integer | 是 | 本门店店员数 | 计算：本门店 `store_member` 行数 |
| `pendingInvitationCount` | integer | 是 | 本门店待接受且未过期的邀请数，“1 个邀请待接受” | 计算：`invitation.store_id`、`invitation.status`、`invitation.expires_at` |
| `memberPreview` | array<`MemberPreview`> | 是 | 头像组，老板在前、店员按加入时间，至多 4 个 | 计算：见下 |
| `todoCount` | integer | 是 | 本门店待办数，“3 项待处理”；口径与 `m.todo.list`（m04-mall-order）一致 | 计算：m04 `order.countTodos(tx, storeId, viewerRole)`（m04 2.9） |
| `actions` | array<enum> | 是 | 当前可执行：`archive`（启用中、不是最后一家）、`delete`（草稿门店）、`restore`（`by_owner` 停用）；守卫的最终判断在服务端 | 计算（C16） |

`MemberPreview`：`displayName`（string \| null；`entity_member.display_name`，为空取 `merchant_user.display_name`）、`role`（enum，`entity_member.role`）。

店员视图 `StoreCardForClerk`（C56 留给本文定，按本文默认定稿）：只有 `storeId`、`name`、`isPrimary`、`lifecycle`、`isLastSelected`、`city`、`category`、`qualificationStatus`、`assetCount`、`clerkCount`、`todoCount`、`actions`（恒为 `[]`）。`todoCount` 按店员口径（`order.countTodos` 的店员口径：只含 `notify_scope = owner_and_clerks` 的 `asset_demand`，C56；m04 3.2）。不返回上线中与交付中计数、审核时间、完整度、待接受邀请数、头像组。

### 2.4 `MemberItem` 成员（老板视图）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `memberId` | string(uuid) | 是 | 成员关系 | `entity_member.id` |
| `role` | enum | 是 | `owner` / `clerk`，同数据模型 `entity_member.role` | `entity_member.role` |
| `displayName` | string \| null | 是 | 称呼；成员关系上的为空时取账号称呼 | `entity_member.display_name`，回落 `merchant_user.display_name` |
| `phoneMask` | string \| null | 是 | 脱敏手机号，前 3 后 4（C40）；店员视图不返回 | `merchant_user.phone_mask` |
| `joinedAt` | string(date-time) | 是 | 加入时间（老板为建主体时间，页面写“注册”） | `entity_member.created_at` |
| `isSelf` | boolean | 是 | 是否本人 | 计算：`entity_member.merchant_user_id` = 当前账号 |
| `storeScope` | enum(`all` / `listed`) | 是 | 老板隐含拥有全部门店为 `all`；店员为 `listed` | 计算：`entity_member.role` |
| `stores` | array<`MemberStoreRef`> | 是 | 店员所属门店（“同时在万达店、春熙店”、设置弹层的勾选）；老板为 `[]` | `store_member` 联 `store` |
| `uploadCount` | integer | 是 | 在本门店上传的素材数 | 计算：本门店 `store_asset` 中 `upload_actor_type = merchant`、`upload_actor_id` = 该成员的账号、`deleted_at` 为空的行数 |
| `adoptedCount` | integer | 是 | 其中被采用过的条数 | 计算：同上且 `store_asset.adopted_count > 0` |
| `actions` | array<enum> | 是 | 店员行 `update`、`remove`；老板行 `[]` | 计算（C16） |

`MemberStoreRef`：`storeId`（`store.id`）、`name`（`store.name`）、`lifecycle`（`store.lifecycle`）、`qualificationStatus`（`store.qualification_status`；设置弹层的“审核通过后可在本店上传”）。

店员视图 `MemberItemForClerk`：只有 `memberId`、`role`、`displayName`、`joinedAt`、`isSelf`（无手机号、无门店、无上传计数，d4:902；C56）。

### 2.5 `PendingInvitationItem` 待接受的邀请（老板视图）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `invitationId` | string(uuid) | 是 | 邀请 | `invitation.id` |
| `role` | enum | 是 | V1.0 固定 `clerk` | `invitation.role` |
| `remarkName` | string \| null | 是 | 老板填的备注名，“小何”；没填时端上显示“待接受的邀请” | `invitation.remark_name` |
| `isPhoneRestricted` | boolean | 是 | 是否定向手机号（不回显号码） | 计算：`invitation.target_phone_bidx` 非空 |
| `isShared` | boolean | 是 | 是否已上报分享 | 计算：`invitation.shared_at` 非空 |
| `createdAt` | string(date-time) | 是 | 创建时间 | `invitation.created_at` |
| `expiresAt` | string(date-time) | 是 | “10-01 09:40 前有效” | `invitation.expires_at` |
| `actions` | array<enum> | 是 | `revoke` | 计算 |

### 2.6 `SeatInfo` 成员名额

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `seatsUsed` | integer | 是 | 见 2.1 | 计算 |
| `memberLimit` | integer \| null | 是 | 见 2.1 | 计算 |
| `pendingInvitationCount` | integer | 是 | 主体内待接受且未过期的邀请数，“（含 1 个待接受的邀请）” | 计算 |
| `includesUnsharedDraft` | boolean | 是 | 当前观察者在当前门店有一张未分享的待接受卡片，且已计入 `seatsUsed`；端上据此写“发送后将占用 1 个名额”，避免数字无故加一 | 计算：`invitation.inviter_member_id`、`invitation.shared_at`（d4:714） |
| `seatsOver` | integer | 是 | 见 2.1 | 计算 |
| `limitReason` | enum(`plan` / `inactive`) | 是 | 见 2.1 | 计算 |
| `planName` | string \| null | 是 | 当前或最近一个周期的版本名，“专业版最多 10 位”；从未开通为 null | 同 `EntityQuotaCard.subscription.planName` |

### 2.7 `MembershipResult` 成员关系结果

用于 `m.entity.create`、`m.invitation.accept`。端上拿到后把 `storeId` 设为当前门店并重拉 `GET /m/me`。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `entityId` | string(uuid) | 是 | 主体 | `entity.id` |
| `memberId` | string(uuid) | 是 | 本人的成员关系 | `entity_member.id` |
| `role` | enum | 是 | `owner` / `clerk` | `entity_member.role` |
| `storeId` | string(uuid) | 是 | 建议进入的门店：新建主体为首家门店；已有主体取上次选择的门店，没有则取首家门店；接受邀请为邀请的门店 | `store.id`、`entity_member.last_store_id` |
| `isNew` | boolean | 是 | 本次是否新建了成员关系（已是老板时调用建主体为 false） | 计算 |
| `abandonedEntityId` | string(uuid) \| null | 是 | 接受邀请时让位的空草稿主体；没有为 null | `entity.id` |

### 2.8 `InvitationCard` 邀请卡片（老板）

`m.invitation.create` 的响应。含一次性令牌，响应头 `Cache-Control: no-store`（C18）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `invitationId` | string(uuid) | 是 | 邀请 | `invitation.id` |
| `token` | string | 是 | 32 字节随机数的 base64url；端上拼进分享路径 `/sub/member/join/index?t=<token>`（d7:683）。复用卡片时由 `invitation.token_enc` 解出同一个值 | 生成；库里只存 `invitation.token_hash` 与 `invitation.token_enc` |
| `isReused` | boolean | 是 | 是否复用了同一张未分享的卡片 | 计算 |
| `role` | enum | 是 | `clerk` | `invitation.role` |
| `storeId` | string(uuid) | 是 | 邀请加入的门店 | `invitation.store_id` |
| `storeName` | string \| null | 是 | 卡片上的门店名 | `store.name` |
| `inviterName` | string | 是 | “王先生邀请您加入门店”；不会为空 | 邀请人的 `entity_member.display_name`，为空取 `merchant_user.display_name`，仍为空时服务端给回落文案“门店老板”（老板由建主体得来，称呼可能从未填写，`02-identity-tenant.md:89`） |
| `remarkName` | string \| null | 是 | 备注名 | `invitation.remark_name` |
| `isPhoneRestricted` | boolean | 是 | 是否定向手机号 | 计算 |
| `expiresAt` | string(date-time) | 是 | 24 小时后（复用时已重置） | `invitation.expires_at` |
| `seats` | `SeatInfo` | 是 | 名额，已含本卡片 | 计算 |

### 2.9 `InvitationPreview` 邀请落地页

`m.invitation.lookup` 的响应。匿名可读，只给最小信息（d4:2269；proto-merchant-b.md:376）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `invitationId` | string(uuid) | 是 | 接受时放路径 | `invitation.id` |
| `status` | enum(`pending` / `accepted` / `revoked` / `expired`) | 是 | 取值同数据模型 `invitation.status`；`pending` 但已过 `expires_at` 的按 `expired` 返回 | `invitation.status`、`invitation.expires_at` |
| `storeName` | string \| null | 是 | 门店名 | `store.name` |
| `city` | `DictRef` \| null | 是 | “成都 · 火锅”的前半 | 同 `StoreCard.city` |
| `category` | `DictRef` \| null | 是 | 后半 | 同 `StoreCard.category` |
| `inviterName` | string | 是 | “王先生邀请您以‘店员’身份加入”“邀请由王先生发出”；不会为空 | 同 `InvitationCard.inviterName`（含回落文案） |
| `role` | enum | 是 | `clerk` | `invitation.role` |
| `isPhoneRestricted` | boolean | 是 | 是否只限指定手机号接受 | 计算 |
| `expiresAt` | string(date-time) | 是 | “10-01 09:40 前有效” | `invitation.expires_at` |

### 2.10 `PortalTicketPreview` 与 `PortalTicketDecision` 下载页票据

`PortalTicketPreview`（`m.portalTicket.lookup`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `portalTicketId` | string(uuid) | 是 | 票据，确认与拒绝时放路径（A3、A4） | `portal_ticket.id` |
| `browser` | string | 是 | 浏览器与系统，如“Chrome · Windows” | 计算：解析 `portal_ticket.user_agent`；解析不出为“未知浏览器” |
| `regionHint` | string \| null | 是 | 大致地区，如“四川 成都” | 计算：按 IP 库解析 `portal_ticket.ip`，不落库；不返回 IP 本身 |
| `createdAt` | string(date-time) | 是 | 发起时间 | `portal_ticket.created_at` |
| `expiresAt` | string(date-time) | 是 | 到期时间（默认创建后 120 秒） | `portal_ticket.expires_at` |
| `pairChoices` | array<string> | 是 | 三个两位数字，其中一个等于电脑屏幕上的数字；顺序打乱 | 计算：含 `portal_ticket.pair_digits`，另两个由票据 id 派生（同一票据每次相同，GET 不写库） |
| `storeId` | string(uuid) | 是 | 将被授权的门店（当前 `X-Store-Id`） | `store.id` |
| `storeName` | string \| null | 是 | “你正在允许一台电脑下载本店成片” | `store.name` |

`PortalTicketDecision`（`m.portalTicket.approve` 与 `m.portalTicket.reject`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `portalTicketId` | string(uuid) | 是 | 票据 | `portal_ticket.id` |
| `status` | enum(`approved` / `rejected`) | 是 | 处理后的状态，取值同数据模型 `portal_ticket.status` | `portal_ticket.status` |
| `rejectReason` | enum(`pair_mismatch` / `by_owner`) \| null | 是 | 作废原因：配对数字不一致、老板点了拒绝；通过时为 null | 计算（不落库，数据模型没有原因列） |
| `approvedAt` | string(date-time) \| null | 是 | 确认时间；电脑端须在其后 60 秒内换取会话 | `portal_ticket.approved_at` |
| `storeId` | string(uuid) \| null | 是 | 授权的门店；拒绝时为 null | `portal_ticket.store_id` |

### 2.11 `PortalSessionItem` 已授权的电脑

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `portalSessionId` | string(uuid) | 是 | 会话 | `portal_session.id` |
| `storeId` | string(uuid) | 是 | 授权的门店 | `portal_session.store_id` |
| `storeName` | string \| null | 是 | 门店名 | `store.name` |
| `grantScope` | enum(`store`) | 是 | 授权范围，V1.0 只有整店 | `portal_session.grant_scope` |
| `browser` | string | 是 | 同 `PortalTicketPreview.browser` | 计算：解析 `portal_session.user_agent` |
| `regionHint` | string \| null | 是 | 同上 | 计算：解析 `portal_session.ip` |
| `authorizedAt` | string(date-time) | 是 | 授权时间 | `portal_session.created_at` |
| `expiresAt` | string(date-time) | 是 | 到期时间（授权起 2 小时，不滑动） | `portal_session.expires_at` |
| `revokedAt` | string(date-time) \| null | 是 | 撤销时间；列表里恒为 null，撤销接口的响应里有值 | `portal_session.revoked_at` |

### 2.12 `StoreBlocker` 停用阻断项

`STORE_HAS_OPEN_WORK` 的 `details.blockers[]`。各项由登记 `StoreCloseGuard` 的模块给出（d4:790；d9:736），口径以登记方为准：

| `kind` | 登记方 | 口径（摘要） |
| --- | --- | --- |
| `open_order` | m04 2.9 | 本门店 `drama_order.status` 为 `pending_start`、`producing`、`to_launch`、`after_sale` 的订购，不含 `live`（d4:794，停用不要求先下架） |
| `open_delivery_ticket` | m05 1.2 | 本门店 `delivery_ticket.step` 不是 `archived`、`terminated` 的工单 |
| `channel_account_in_review` | m05 1.2 | 本门店 `channel_account.status = pending_verify` 的账号 |
| `ad_in_production` | m06 第 1 节 | 本门店 `ad.status` 为 `pending_assign`、`producing`、`returned`、`pending_confirm`、`revising` 的广告 |
| `qualification_in_review`、`unverified_primary_store` | m03 1.2 | 在审的资质轮次；主体未认证时的首家门店 |

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `kind` | enum(`StoreBlockerKind`，见第 4 节) | 是 | 阻断类别 | 各模块的 `StoreCloseGuard.countBlocking` |
| `count` | integer | 是 | 数量，大于 0 | 同上 |
| `message` | string | 是 | 给用户看的一句话，如“有 2 笔在办订购，请办结后再停用” | 服务端按类别生成 |

## 3. 接口

### 3.1 m.entity.create　懒创建经营主体
`POST /m/entities`

| 项 | 内容 |
| --- | --- |
| operationId | `m.entity.create`（路线图 `m02.entity.create`） |
| 鉴权 | `user`（尚无成员关系，A11）；无能力点；不带 `X-Store-Id` |
| 店员视图 | `same`（店员调用返回 409，见错误） |
| 幂等 | `required`（A17）。路线图原写的“natural（`uq_member_one_entity`）”不采用：该索引已改名 `uq_entity_member_one_entity` 且 V1.1 删除，只作并发兜底 |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Profile（“开始建档”）、M:Main、M:Detail、M:Cart（“加入选剧单”）；M:Trailer 为 V1.0 不做的页面 |

**请求**：路径参数无；查询参数无；请求体为空对象 `{}`。

**响应**：`MembershipResult`（2.7）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `ALREADY_IN_ENTITY` | 409 | 调用者是其他主体的有效店员；`details.storeName` 为其所在门店名（“您已是 XX 门店的店员，如需自己开店请先退出该门店”，d4:623） |

**副作用**（一个事务，d4:622；`02-identity-tenant.md:534`）：

- `entity.lifecycle`：— → `active`（`entity.create`，`02-identity-tenant.md:523`）。`entity.verification_status = unsubmitted`；来源四列（`source_type`、`source_channel_code`、`source_invite_code`、`source_referral_code_id`）从 `merchant_user` 同名列复制；`entity.created_by_user_id` = 当前账号。
- `store.lifecycle`：— → `active`（`store.create`，`02-identity-tenant.md:607`），首家门店：`store.is_primary = true`，`store.name` 为空，`store.qualification_status = unsubmitted`。档案行 `store_profile` 不在这里建，由 profile 在首次读写时补建（d9:107）。
- `entity_member.status`：— → `active`（`entity_member.create_owner`，`02-identity-tenant.md:690`），`entity_member.role = owner`，`entity_member.last_store_id` = 首家门店。
- 经 billing 的端口建 `billing_account` 行（`07-billing-ledger.md` 2.8）。
- 三条迁移各写 `status_transition` 与审计（`activity` 流）。出站事件（x01 3.2，目前没有订阅方）：`entity.created`（带 `firstStoreId`、`ownerUserId`）、`store.created`（`isFirstStore = true`）；老板成员关系的建立不另发事件。

**说明**：

- 调用者已是某主体的老板：不新建，返回 200 与已有主体（`isNew = false`）。同键重放返回上次结果。
- 并发：两个请求同时建主体时，后到者撞 `uq_entity_member_one_entity`，服务端回滚后按“已是老板”返回已有主体。
- 登录只建账号；第一次点“开始建档”或“加入选剧单”时调本接口（d4:622-624）。端上随后把 `storeId` 设为 `X-Store-Id`，再调原来的业务接口。

### 3.2 m.store.list　我可见的门店
`GET /m/stores`

| 项 | 内容 |
| --- | --- |
| operationId | `m.store.list`（路线图 `m02.store.list`） |
| 鉴权 | `user`；不带 `X-Store-Id`；无能力点（按账号的有效成员关系现算可见门店，C56 已按此登记） |
| 店员视图 | `trimmed`：`entity` 为 `EntityBrief`，`items` 为 `StoreCardForClerk`（2.2、2.3） |
| 幂等 | `none`（纯查询，GET 不写库） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:StoreSwitch（切换门店弹层）、M:Stores（我的门店）、M:Mine（门店卡）、M:StoreAdd（额度说明） |

**请求**：无。

**响应**：不分页，一次返回全部（A55、A78，C42 已登记；门店数受套餐上限约束）。

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `viewerRole` | enum(`owner` / `clerk` / `none`) | 是 | 判别字段；`none` = 账号没有有效成员关系 |
| `entity` | `EntityQuotaCard` \| `EntityBrief` \| null | 是 | 老板为额度卡，店员为简要；`none` 时为 null |
| `items` | array<`StoreCard` \| `StoreCardForClerk`> | 是 | 老板：本主体全部门店（含 `by_owner` 停用的，不含草稿删除的）；店员：本人 `store_member` 所列门店；`none` 时为 `[]` |

排序：启用中的在前（首家门店最前，其余按 `store.created_at` 升序），已停用的在后（按 `store.archived_at` 倒序）。

**错误**：无（只有通用错误）。

**副作用**：无。

**说明**：

- “我的门店 · N”“还可新增 N 家”取本接口；M:Mine 的门店数由 `m.me.overview.get`（m08）给，口径相同。
- 门店卡由读侧组装：审核状态、完整度、提交与预计完成时间来自档案模块（d9:676），上线中与交付中来自订单项，待办数与 `m.todo.list` 共用同一个计数函数（m04）。
- V1.1 的“全部门店汇总”用 `X-Store-Id: all`（d4:846、2153），不新增路径。

### 3.3 m.store.create　新增门店
`POST /m/stores`

| 项 | 内容 |
| --- | --- |
| operationId | `m.store.create`（路线图 `m02.store.create`） |
| 鉴权 | `member`；能力点 `store.create`（仅老板；已停用门店上下文里没有） |
| 店员视图 | `none` |
| 幂等 | `required` |
| 乐观锁 | 无（新建） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:StoreAdd |

**请求体**：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `name` | string | 是 | 2–30 字；过文本内容安全检测 | 门店名称 → `store.name` |
| `addressDetail` | string | 是 | 非空；长度按档案第 1 步的同一校验（m03）；过文本内容安全检测 | 门店地址（本页只有文本框，没有选点；省市区留到第 1 步补全，d9:385） → `store_profile.address_detail` |
| `industryCode` | string | 是 | 字典 `industry` 的一级编码，启用（否则 409 `DICT_ITEM_DISABLED`）且开放（否则 409 `INDUSTRY_NOT_OPEN`），同 m03 第 1 步 | → `store_profile.industry_code` |
| `categoryCode` | string | 是 | 同一字典里 `industryCode` 下的二级编码 | → `store_profile.category_code` |
| `copyFromStoreId` | string(uuid) \| null | 否 | 本主体的门店，不能是草稿删除的门店 | 复制来源 → `store_profile.copied_from_store_id` |
| `copyOptions` | array<enum> | 否 | 元素取 `basic` / `service` / `media` / `brand_assets`，不重复；非空时 `copyFromStoreId` 必填 | 复制项 → `store_profile.copy_options`；端上默认勾选 `basic`、`service`、`brand_assets` |

**响应**：`StoreCard`（2.3），即新门店。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STORE_LIMIT_REACHED` | 409 | 锁主体后 `storesUsed + 1 > storeLimit`；`details = { storesUsed, storeLimit, limitReason }`，端上按 `limitReason` 引导升级或开通（d4:671；PRD 6.16.1） |
| `VALIDATION_FAILED` | 400 | 字段不合规；复制来源不属于本主体或已删除；`copyOptions` 非空而没有来源；行业品类编码不存在、品类不隶属行业（m03 1.2 `profile.validateStoreBasics`） |
| `DICT_ITEM_DISABLED` | 409 | 所选行业或品类已停用（m08 定义；`details = { dictTypeKey, code }`，端上刷新字典后重选；m03 1.2） |
| `INDUSTRY_NOT_OPEN` | 409 | 所选行业或品类未开放（m03 定义；`details = { field: 'industry', code }`；m03 1.2） |
| `CONTENT_REJECTED` | 400 | 门店名称或详细地址未通过文本内容安全检测（定义见 m01-account）；`details = { fields: string[] }`，取 `name`、`addressDetail` |
| `PROVIDER_UNAVAILABLE` | 503 | 文本内容安全检测服务不可用，一律拒收、不写库（可重试，A137；C27；m03 1.2） |

**副作用**（一个事务，d9:382-397）：

- 名称、地址、行业品类的校验与内容安全检测调 m03 的 `profile.validateStoreBasics`（m03 1.2，与档案第 1 步同一个函数、同一组错误码），在事务之外先做（新增门店不能成为绕过档案校验的入口）。
- 锁主体行，校验老板与门店额度后建门店：`store.lifecycle`：— → `active`（`store.create`，`02-identity-tenant.md:607`），`store.is_primary = false`，`store.qualification_status = unsubmitted`。写 `status_transition` 与审计（`activity` 流）；出站事件 `store.created`（`isFirstStore = false`，x01 3.2）。
- 建档案行 `store_profile`：`address_detail`、`industry_code`、`category_code`、`copied_from_store_id`、`copy_options`。
- 按复制项从来源门店复制（来源与新门店同一主体，复合外键保证）：
  - `basic`：`store_profile.brand_name`、`brand_intro`、`business_hours`、`logo_file_id`；联系电话 `store_tel`、人均 `avg_spend_fen` 不复制（d9:390）。
  - `service`：未移除的 `store_service_item` 行（含图片引用），以及 `store_profile.promo_text`、`group_buy_text`、`selling_point_codes`、`selling_note`。
  - `media`：未移除的 `store_profile_media` 行，新行写 `store_profile_media.copied_from_store_id`。门头与店内环境须本店实拍，端上默认不勾选。
  - `brand_assets`：来源门店带“品牌故事”内容标签（`store_asset_tag.dimension = content`）的未删除素材，按 `06-media.md:1195` 的取法复制到本店素材库（`store_asset.source_store_asset_id` 指向来源，`idempotency_key = copy:{来源 id}`，文件只加引用不复制）。
  - 被复制行引用的文件经 `files.link()` 对新门店登记引用（同一主体内允许跨门店引用，`06-media.md:279`）。
- 资质不复制，新门店 `store.qualification_status = unsubmitted`，须在建档第 4 步单独提交（PRD 6.16.1；d9:395）。

**说明**：

- 主体未认证时也可以新增门店并建档，提交资质要等主体认证通过（d9:398）。
- 门店创建即占额度（d4:665）。埋点 `store_add_submit` 不在这里记，在该门店第一次提交资质时直记（d9:396）。
- 页面上“主推菜品 5 项”“品牌故事素材 12 条”是来源门店的计数：端上以来源门店为 `X-Store-Id` 调 m03 的 `m.storeProfile.service.get` 与 `m.storeAsset.summary?tag=brand_story`（“品牌故事”内容标签，编码按 A145 播种；取响应的 `tabs.all`，m03 3.20），本接口不另给。
- 复制来的品牌故事素材（`source_store_asset_id` 非空）不算新门店的业务数据，不妨碍删除草稿门店（3.5）。

### 3.4 m.store.archive　停用门店
`POST /m/stores/{storeId}/archive`

| 项 | 内容 |
| --- | --- |
| operationId | `m.store.archive`（路线图 `m02.store.archive`） |
| 鉴权 | `member`；能力点 `store.archive`（仅老板）；路径门店须与 `X-Store-Id` 同属一个主体 |
| 店员视图 | `none` |
| 幂等 | `required`（路线图原写的“natural（状态守卫）”按 A17 不采用） |
| 乐观锁 | 不带（`02-identity-tenant.md:608` 的守卫没有列锁版本，C53）。加锁按第 1 节的次序：主体行 → 该门店 `pending` 的邀请（按 id 升序）→ 受影响的成员关系（只属于该门店的店员、`last_store_id` 指向该门店的成员）→ 门店行 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Stores（原型没有停用入口，挂在门店卡上；二次确认由端上弹层完成） |

**请求**：路径参数 `storeId`（uuid）；请求体无。

**响应**：

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `store` | `StoreCard` | 是 | 停用后的门店 |
| `revokedInvitationCount` | integer | 是 | 随之撤回的待接受邀请数 |
| `removedMemberCount` | integer | 是 | 随之移出主体的店员数（只属于该门店的） |

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 门店不是 `active` |
| `LAST_ACTIVE_STORE` | 409 | 停用后主体没有启用中的门店 |
| `STORE_HAS_OPEN_WORK` | 409 | 各模块 `StoreCloseGuard` 计数之和大于 0；`details.blockers` 为 `StoreBlocker[]`（各类别的登记方与口径见 2.12：在办订购、未归档工单、制作中广告、审核中的资质与渠道账号、主体未认证时的首家门店） |

**副作用**（同一事务，`02-identity-tenant.md:614`；d4:790）：

- `store.lifecycle`：`active` → `archived`（`store.archive`，原因 `by_owner`，`02-identity-tenant.md:608`）；写 `store.archived_at`、`archive_actor_type = merchant`、`archive_actor_id`、`archive_client = weapp`、`archive_reason = by_owner`。
- 该门店待接受的邀请：`invitation.status`：`pending` → `revoked`（`invitation.revoke`，原因 `store_archived`，操作人 `system`，`02-identity-tenant.md:788`），清空 `invitation.token_enc`，取消各自的 `invitation.expire` 定时器；每张发 `invitation.revoked`。
- 删除该门店的全部 `store_member` 行；只属于该门店的店员：`entity_member.status`：`active` → `removed`（`entity_member.cascade_remove`，原因 `store_archived`，`02-identity-tenant.md:692`），每人发 `entity_member.removed`（通知被移出的店员）。
- 清空其他成员指向该门店的 `entity_member.last_store_id`。
- 出站事件 `store.archived`（载荷带 `archiveReason = by_owner`）：profile 经订阅者 `profile.onTenantLifecycle`（x01 第 3 节）丢弃草稿轮次、释放档案引用（`04-profile.md:678`）；notify 通知交付经理（d4:790 ⑤）。各迁移写 `status_transition` 与审计。
- 以上联动由第 1 节的“门店停用联动”函数完成，3.5 与主体关闭共用。

**说明**：停用不要求先下架上线中的成片（d4:794）。停用后老板仍可在该门店上下文里看订单与交付记录、下载授权期内的成片、确认到期下架、授权电脑；不能新订购、提交广告需求、绑定渠道账号、上传素材、邀请店员、修改档案。停用的门店不计入门店额度。

### 3.5 m.store.delete　删除草稿门店
`POST /m/stores/{storeId}/delete`

| 项 | 内容 |
| --- | --- |
| operationId | `m.store.delete`（路线图 `m02.store.delete-draft`；动作名按词表改为 `delete`，C12） |
| 鉴权 | `member`；能力点 `store.archive`（d4 未单列，沿用）；路径门店须与 `X-Store-Id` 同属一个主体 |
| 店员视图 | `none` |
| 幂等 | `required` |
| 乐观锁 | 不带（C53）；加锁次序同 3.4 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Stores（原型无入口） |

**请求**：路径参数 `storeId`（uuid）；请求体无。

**响应**：`{ storeId: string(uuid), deletedAt: string(date-time) }`（`store.id`、`store.archived_at`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 门店不是 `active` |
| `STORE_NOT_DRAFT` | 409 | 提交过资质，或有业务数据；`details.reasons` 为 `qualification_submitted` / `has_business_data` 的数组 |
| `LAST_ACTIVE_STORE` | 409 | 是主体最后一家启用中的门店 |
| `STORE_HAS_OPEN_WORK` | 409 | 同 3.4（草稿门店删除也过同一守卫，d9:736；如主体未认证时的首家门店） |

**副作用**：

- `store.lifecycle`：`active` → `archived`（`store.draft_delete`，原因 `draft_deleted`，`02-identity-tenant.md:609`），不物理删除（M93）。停用联动同 3.4（同一函数）：邀请撤回（`invitation.revoke`，原因 `store_archived`，每张发 `invitation.revoked`）、`store_member` 删除、只属于该门店的店员移出（`entity_member.cascade_remove`，原因 `store_archived`，每人发 `entity_member.removed`）、清空 `last_store_id`。
- 出站事件 `store.archived`（`archiveReason = draft_deleted`）与 `store.draft_deleted`。
- 本接口的事务不碰资质轮次。profile 订阅上述事件后在自己的事务里把未提交的资质草稿轮次置为已关闭（`discarded`，`04-profile.md:344`、681），并释放档案与草稿证照引用——这是订阅者 `profile.onTenantLifecycle` 的迁移，归 x01 的非 HTTP 迁移归属表，不算本接口同事务的迁移。

**说明**：

- 草稿门店 = 从未提交资质（没有 `qualification_submission.submitted_at` 非空的轮次）且没有业务数据。“没有业务数据”的判定（d4:791 只写了原则，按本文默认定稿）：该门店没有订购单（`drama_order`）、广告（`ad`）、渠道账号（`channel_account`）、客服工单（`service_ticket`），也没有本店上传且未删除的素材（`store_asset.deleted_at` 为空且 `source_store_asset_id` 为空）。新增门店时复制来的品牌故事素材（`source_store_asset_id` 非空）不算，删除时不动它们（门店停用后一律 403，留着无害，M93）。
- 删除后门店从列表消失，作为 `X-Store-Id` 一律 403（d4:825）。

### 3.6 m.store.restore　恢复门店
`POST /m/stores/{storeId}/restore`

| 项 | 内容 |
| --- | --- |
| operationId | `m.store.restore`（路线图 `m02.store.restore`） |
| 鉴权 | `member`；能力点 `store.restore`（老板；已停用门店的收尾上下文里也有，d4:857） |
| 店员视图 | `none` |
| 幂等 | `required` |
| 乐观锁 | 不带（C53）；事务先锁主体行 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Stores（原型无入口） |

**请求**：路径参数 `storeId`（uuid）；请求体无。

**响应**：`StoreCard`（2.3）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 门店不是 `archived`，或 `store.archive_reason` 不是 `by_owner` |
| `STORE_LIMIT_REACHED` | 409 | 锁主体后 `storesUsed + 1 > storeLimit`；`details` 同 3.3 |

**副作用**：`store.lifecycle`：`archived` → `active`（`store.restore`，`02-identity-tenant.md:612`），清空停用五列；写 `status_transition` 与审计；出站事件 `store.restored`（profile 重新登记档案引用，`04-profile.md:680`）。停用时撤回的邀请与移出的店员不恢复。

**说明**：恢复后门店重新占额度。

### 3.7 m.me.currentStore.replace　记住当前门店
`PUT /m/me/current-store`

| 项 | 内容 |
| --- | --- |
| operationId | `m.me.currentStore.replace`（路线图 `m01.me.current-store`，按资源归属移入本文） |
| 鉴权 | `member`；能力点 `me.*`（d4 附录 A 原写无能力点，d4:2257；按本文第 1 节的规则，已停用门店上下文只放行收尾能力点，老板切到 `by_owner` 停用的门店时本接口须可用，所以归入 `me.*`，与 `m.me.membership.leave` 同组） |
| 店员视图 | `same` |
| 幂等 | `required`（A17；路线图原写的“整体替换单例值，天然幂等”取消） |
| 乐观锁 | 不带：`entity_member` 没有 `lock_version` 列，A47 定为例外 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:StoreSwitch、M:Stores（“切换到本店”）、M:Mine |

**请求体**：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `storeId` | string(uuid) | 是 | 本人能进的门店：老板为本主体除草稿删除外的门店，店员为本人 `store_member` 所列门店；通常等于切换后的 `X-Store-Id` | → `entity_member.last_store_id` |

**响应**：`{ storeId: string(uuid) }`。

**错误**：`NOT_FOUND`（404）：门店不存在、不属于本主体或本人进不去。

**副作用**：写 `entity_member.last_store_id`；不写审计；无状态迁移。

**说明**：切换门店本身是端上行为：换 `X-Store-Id`、清空带门店维度的缓存、重拉首页（d4:827；d7:605）。本接口只记住选择，供下次启动恢复，不参与授权。A5 原文写的 `/m/current-store` 不使用，按路线图与资源登记表（约定第 15 节第 5 项）。

### 3.8 m.member.list　门店成员
`GET /m/members`

| 项 | 内容 |
| --- | --- |
| operationId | `m.member.list`（路线图 `m02.member.list`） |
| 鉴权 | `member`；能力点 `member.list`（老板、店员；已停用门店上下文里没有） |
| 店员视图 | `trimmed`：`items` 为 `MemberItemForClerk`；不返回 `pendingInvitations` 与 `seats` |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Members、M:StaffProfile（门店成员）、M:Profile（成员摘要）、M:Invite（名额） |

**请求**：无（门店取 `X-Store-Id`）。

**响应**：不分页，一次返回全部（有界小集合，A78；C42 已登记：成员受名额约束）。

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `viewerRole` | enum(`owner` / `clerk`) | 是 | 判别字段 |
| `items` | array<`MemberItem` \| `MemberItemForClerk`> | 是 | 当前门店的成员：老板一行在前，店员按加入时间升序 |
| `pendingInvitations` | array<`PendingInvitationItem`> | 老板 | 当前门店待接受且未过期的邀请，按创建时间倒序；店员视图不返回此键 |
| `seats` | `SeatInfo` | 老板 | 主体的成员名额；店员视图不返回此键 |

**错误**：无（只有通用错误）。

**副作用**：无。

**说明**：

- 页头“店员 2 位 · 1 个邀请待接受”由 `items` 与 `pendingInvitations` 的条目数得出，不另设 `summary`。成员设置弹层的标题“成员设置 · 阿杰”取所点成员的 `MemberItem.displayName`（原型 Members.dc.html:99），不是条目数。
- 名额说明“待接受的邀请也占名额，专业版最多 10 位”取 `seats.planName` 与 `seats.memberLimit`；`limitReason = inactive` 时端上改写为引导开通或续费的文案。
- 原型待接受行显示的“小何”取 `invitation.remark_name`（d4:608）；没填备注名时显示“待接受的邀请”。

### 3.9 m.member.update　调整店员所属门店
`PATCH /m/members/{memberId}`

| 项 | 内容 |
| --- | --- |
| operationId | `m.member.update`（路线图 `m02.member.update`） |
| 鉴权 | `member`；能力点 `member.manage`（仅老板） |
| 店员视图 | `none` |
| 幂等 | `required`（有“通知该成员”的副作用，A17、C47） |
| 乐观锁 | 不带：`entity_member`、`store_member` 没有 `lock_version` 列，A47 定为例外；事务先锁主体行 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Members（成员设置弹层） |

**请求**：路径参数 `memberId`（uuid，`entity_member.id`）。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `storeIds` | array<string(uuid)> | 是 | 至少 1 个、不重复；都是本主体 `active` 的门店（审核中的门店可以） | 所属门店的全量替换 → `store_member` |

**响应**：`MemberItem`（2.4），`stores` 为保存后的门店。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | `storeIds` 为空（`fieldErrors` 文案“请至少保留一家门店；如不再合作，请移除成员”）；含不属于本主体或已停用的门店 |
| `STATE_NOT_ALLOWED` | 409 | 目标是老板，或成员关系不是 `active` |

**副作用**：按差集删、插 `store_member` 行（新行 `added_by_member_id` = 老板的成员关系）；新集合不含 `entity_member.last_store_id` 时把它清空；写审计（`activity` 流，前后门店集合）；出站事件 `entity_member.stores_changed`（x01 3.2，载荷带 `addedStoreIds`、`removedStoreIds`；notify 场景 `m.member_changed` 通知该成员，d6:247）。无状态迁移。

**说明**：把已有店员加入更多门店不占名额（d4:672）。调整后立即生效：被移出某门店的店员下一次带该门店的请求得到 403 `NOT_A_MEMBER`。老板“改备注名”（d4:577）没有画板，V1.0 不提供。草案写作 `PUT /m/members/{id}/stores`。

### 3.10 m.member.remove　移除店员
`POST /m/members/{memberId}/remove`

| 项 | 内容 |
| --- | --- |
| operationId | `m.member.remove`（路线图 `m02.member.remove`） |
| 鉴权 | `member`；能力点 `member.manage` |
| 店员视图 | `none` |
| 幂等 | `required` |
| 乐观锁 | 不带（C53）；事务先锁主体行 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Members（“移除成员”；原型无二次确认，端上补） |

**请求**：路径参数 `memberId`（uuid）；请求体无。

**响应**：`{ memberId: string(uuid), status: 'removed', removedAt: string(date-time) }`（`entity_member.id`、`entity_member.status`、`entity_member.removed_at`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 目标是老板（老板更换只走后台审批），或成员关系已不是 `active` |

**副作用**：`entity_member.status`：`active` → `removed`（`entity_member.remove`，原因 `by_owner`，`02-identity-tenant.md:692`）；写 `removed_at`、`remove_actor_type = merchant`、`remove_actor_id`、`remove_client = weapp`；删除其全部 `store_member` 行；写 `status_transition` 与审计；出站事件 `entity_member.removed`（通知被移出的店员，d4:749）。名额随之释放。

**说明**：其上传的素材保留在门店素材库（PRD 6.16.2 第 3 条）。被移除者下一次请求得到 403 `NOT_A_MEMBER`。路线图原写 `DELETE /m/members/{id}`，按 A7 改为动作。

### 3.11 m.me.membership.leave　店员退出
`POST /m/me/membership/leave`

| 项 | 内容 |
| --- | --- |
| operationId | `m.me.membership.leave`（路线图 `m02.me-membership.leave`） |
| 鉴权 | `member`；能力点 `me.*` |
| 店员视图 | `same` |
| 幂等 | `required` |
| 乐观锁 | 不带（C53）；事务先锁主体行 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | 原型无：设置页（账号与安全）的“退出门店” |

**请求**：无。

**响应**：`{ memberId: string(uuid), status: 'removed', removedAt: string(date-time) }`。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `OWNER_CANNOT_LEAVE` | 409 | 调用者是老板（老板更换只走后台审批，`05-risks-and-open-issues.md:222`；老板注销走 `m.me.deletion.create`） |

**副作用**：`entity_member.status`：`active` → `removed`（`entity_member.leave`，原因 `self`，`02-identity-tenant.md:692`），操作人为本人；删除其 `store_member` 行；写 `status_transition` 与审计；出站事件 `entity_member.removed`（通知老板，d4:750）。

**说明**：成功后端上重拉 `GET /m/me`，回到“未加入门店”状态；之后可以自己建主体或接受别家的邀请。

### 3.12 m.invitation.create　预创建邀请
`POST /m/invitations`

| 项 | 内容 |
| --- | --- |
| operationId | `m.invitation.create`（路线图 `m02.invitation.create`） |
| 鉴权 | `member`；能力点 `member.manage`（仅老板；已停用门店上下文里没有） |
| 店员视图 | `none` |
| 幂等 | `natural`，`idempotentBy = [uq_invitation_inviter_member_id_client_request_id]`：请求体带 `clientRequestId`，不要 `Idempotency-Key`（C47） |
| 乐观锁 | 无；事务先锁主体行，复用时再锁那张邀请行（第 1 节的次序） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Invite（进入邀请页即调用，令牌须在分享前就绪，d7:683；填写或修改备注名、对方手机号后再调用一次，见下“复用”）。原型 M:Invite 没有“备注名”“对方手机号（可选）”两个输入框，须补（第 6 节第 1 项） |

**请求体**：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `clientRequestId` | string(uuid) | 是 | 端上每次调用新生成（进入邀请页一次，之后每次改备注名或手机号各一次）；网络重试沿用同一个 | → `invitation.client_request_id`（新建时） |
| `remarkName` | string \| null | 否 | ≤10 字；过文本内容安全检测 | 老板填的备注名 → `invitation.remark_name`。键缺省 = 不改（复用时保持原值）；显式 `null` = 清空 |
| `targetPhone` | string \| null | 否 | 11 位手机号；参数 `invitation.require_phone` 为真时必填 | 定向手机号；只存盲索引 → `invitation.target_phone_bidx`，不回显。键缺省 = 不改；显式 `null` = 取消定向 |

门店取 `X-Store-Id`，角色固定 `clerk`。参数 `invitation.require_phone` 为真时，端上先让老板填手机号再调用（令牌就绪前“发送给微信好友”不可点）。

**响应**：`InvitationCard`（2.8）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `SEAT_LIMIT_REACHED` | 409 | 锁主体后 `seatsUsed + 1 > memberLimit`（复用卡片不再占位，不触发）；`details = { seatsUsed, memberLimit, limitReason }` |
| `INVITATION_DAILY_LIMIT` | 409 | 本主体当天未撤回的创建数已达参数 `invitation.daily_cap`（默认 20）；`details.dailyCap` |
| `CONTENT_REJECTED` | 400 | 备注名未通过内容安全检测（定义见 m01-account）；`details = { fields: ["remarkName"] }` |
| `PROVIDER_UNAVAILABLE` | 503 | 带了非空 `remarkName` 而文本内容安全检测服务不可用：一律拒收、不写库（可重试，A137；C27） |
| `STATE_NOT_ALLOWED` | 409 | 同一 `clientRequestId` 已建的邀请不再是 `pending`；端上换新的 `clientRequestId` |
| `VALIDATION_FAILED` | 400 | 手机号格式不对；要求定向时，新建没填或复用时显式清空 |

**副作用**：

- 新建：`invitation.status`：— → `pending`（`invitation.create`，`02-identity-tenant.md:786`）；`expires_at` = 创建 + 参数 `invitation.ttl_hours`（默认 24 小时）；登记定时器 `timer.kind = invitation.expire`，`dedupe_key = invitation.expire:invitation:{invitationId}`，`fire_at = expires_at`（`02-identity-tenant.md:794`）；写 `status_transition` 与审计（`activity` 流）；出站事件 `invitation.created`（x01 3.2）。
- 复用：同一邀请人、同一门店已有 `pending`、未过期、`shared_at` 为空的邀请时不新建，返回同一行（`isReused = true`），把 `invitation.expires_at` 重置为 now + 24 小时，并按同一 `dedupe_key` 把定时器 `fire_at` 改到新时刻；不计入每日上限、不再占名额（d4:711）。请求体带了 `remarkName` / `targetPhone` 键的，原地改写 `invitation.remark_name` / `invitation.target_phone_bidx`（两列都允许修改，`trg_invitation_immutable` 不含它们），改写时写审计；令牌不变。这样“先预创建、后填备注名与手机号”只有一张卡片。本稿相对 d4:711 的改动：复用条件去掉“定向手机号相同”，否则改手机号会新建第二张卡、多占名额与每日上限。
- 同一 `clientRequestId` 重放：返回已建的那一行（仍是 `pending` 时带同一令牌），不改写字段。
- 未分享的卡片若其实已发出（`mark-shared` 上报丢失），改写定向手机号会让先收到卡片的人接受时得到 `INVITATION_NOT_FOR_YOU`；这与 d4:712 已接受的“上报丢失”后果同类，老板再生成一张即可。

**说明**：

- 审核中的门店也可以预先邀请（原型 merchant/Members）；门店数超限（`storesOver > 0`）不影响邀请，成员超限才禁止（d4:672、680）。
- 名额显示用响应里的 `seats`（`includesUnsharedDraft` 为真时写“发送后将占用 1 个名额”）。
- 卡片标题“王先生邀请您加入门店”取 `inviterName`；老板没填过称呼时服务端回落为“门店老板”，不拦截创建（2.8）。
- 内容安全检测服务不可用时返回 503 `PROVIDER_UNAVAILABLE`，不写库（A137）；草案“先接受、排队复检”（d4:1883）V1.0 不做。
- “发送给微信好友”不受登录文案去“微信”的约束；页面里关于加入方式的提示去掉“微信”（design-spec.md:849、860）。

### 3.13 m.invitation.markShared　上报已分享
`POST /m/invitations/{invitationId}/mark-shared`

| 项 | 内容 |
| --- | --- |
| operationId | `m.invitation.markShared`（路线图 `m02.invitation.mark-shared`） |
| 鉴权 | `member`；能力点 `member.manage`；邀请须属于 `X-Store-Id` 的门店 |
| 店员视图 | `none` |
| 幂等 | `required`（路线图原写“天然幂等”，按 A17 取消） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Invite（点“发送给微信好友”时端上尽力调用，不等结果） |

**请求**：路径参数 `invitationId`（uuid）；请求体无。

**响应**：`{ invitationId: string(uuid), sharedAt: string(date-time) | null }`（`invitation.id`、`invitation.shared_at`）。

**错误**：`NOT_FOUND`（404）：邀请不存在或不属于当前门店。

**副作用**：邀请是 `pending` 且 `shared_at` 为空时写 `invitation.shared_at = now`；否则不写，照常返回 200 与当前值（尽力上报，不让端上处理失败）。无状态迁移，不写审计。

**说明**：上报之后再进邀请页会新建卡片（老板可能连续邀请两人）；上报丢失的后果是下次拿到同一张卡片，其中一人会看到“邀请已被使用”（d4:712）。

### 3.14 m.invitation.revoke　撤回邀请
`POST /m/invitations/{invitationId}/revoke`

| 项 | 内容 |
| --- | --- |
| operationId | `m.invitation.revoke`（路线图 `m02.invitation.revoke`） |
| 鉴权 | `member`；能力点 `member.manage`；邀请须属于 `X-Store-Id` 的门店 |
| 店员视图 | `none` |
| 幂等 | `required` |
| 乐观锁 | 不带（C53）；事务先锁主体行，再锁邀请行 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Members（“撤回”）、M:Invite（没分享就离开页面时端上尽力撤回） |

**请求**：路径参数 `invitationId`（uuid）。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `reason` | enum(`by_owner` / `unshared_leave`) | 是 | `unshared_leave` 只在 `invitation.shared_at` 为空时允许 | → `invitation.revoke_reason`（数据模型另两个取值只由系统写） |

**响应**：`{ invitationId: string(uuid), status: 'revoked', revokedAt: string(date-time) }`。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 邀请不是 `pending`（已接受、已撤回或定时器已翻为过期）；或以 `unshared_leave` 撤回已分享的卡片 |

**副作用**：`invitation.status`：`pending` → `revoked`（`invitation.revoke`，`02-identity-tenant.md:788`）；写 `revoked_at`、`revoke_actor_type = merchant`、`revoke_actor_id`、`revoke_client = weapp`、`revoke_reason`；清空 `invitation.token_enc`；取消 `invitation.expire` 定时器；写 `status_transition` 与审计（PRD 6.16.2 第 3 条）；出站事件 `invitation.revoked`（x01 3.2）。名额立即释放；撤回的不计入每日上限。

**说明**：邀请是状态迁移，不用 `DELETE`（A7）。已过期但定时器尚未翻状态的 `pending` 邀请也可撤回。

### 3.15 m.invitation.lookup　邀请落地页
`GET /m/invitations/lookup?token=`

| 项 | 内容 |
| --- | --- |
| operationId | `m.invitation.lookup`（路线图 `m02.invitation.preview`；按 C12 并入 `lookup`） |
| 鉴权 | `public`（不解析凭据） |
| 店员视图 | `same` |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.invitation` |
| 开关 | 无 |
| 对应画板 | M:Join；原型无：已使用、已撤回、已过期的说明页（`05-risks-and-open-issues.md:272`） |

**请求**：查询参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `token` | string | 是 | 43 个 base64url 字符 | 卡片路径里的令牌；按 `sha256(token)` 查 `invitation.token_hash`。访问日志脱敏（A3） |

**响应**：`InvitationPreview`（2.9）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `INVITATION_INVALID` | 404 | 令牌不存在 |

**副作用**：无。

**说明**：已使用、已撤回、已过期都返回 200 与对应 `status`，加入页按状态显示四种说明（d4:740）。“手机号已属其他主体”要在接受时才能判断（返回 `PHONE_IN_OTHER_ENTITY`）。草案写作 `GET /m/invitations/{token}`。

### 3.16 m.invitation.accept　接受邀请
`POST /m/invitations/{invitationId}/accept`

| 项 | 内容 |
| --- | --- |
| operationId | `m.invitation.accept`（路线图 `m02.invitation.accept`） |
| 鉴权 | `user`（尚无成员关系，A11）；不带 `X-Store-Id` |
| 店员视图 | `same` |
| 幂等 | `required`（d7:685） |
| 乐观锁 | 不带。加锁按第 1 节的次序：先锁本人的 `merchant_user` 行（80；可能要写账号称呼，统一都锁）→ 按 id 升序一次锁齐邀请所属主体与本人名下可能让位的主体（100，d4:723-726）→ 邀请行（110）→ 涉及的成员关系（120）→ 让位主体名下的门店（130） |
| 限流 | `m.invitation` |
| 开关 | 无 |
| 对应画板 | M:Join（“手机号快捷验证并加入”，按钮文案不带“微信”，design-spec.md:849）；原型无：异常态 |

**请求**：路径参数 `invitationId`（uuid，取自 `m.invitation.lookup`）。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `token` | string | 是 | 同 3.15 | 令牌放请求体，不进路径（A3）；`sha256(token)` 须等于该邀请的 `invitation.token_hash` |
| `displayName` | string \| null | 账号没有称呼时必填 | ≤20 字；过文本内容安全检测 | 成员称呼 → `entity_member.display_name`；`merchant_user.display_name` 为空时同时写入（账号称呼“加入门店时必填”，`02-identity-tenant.md:89`） |

请求体不带协议同意。加入场景的同意只由 `m.session.phoneLogin(consentScene = member_join)` 写（m01）；理由见说明。

**响应**：`MembershipResult`（2.7），`role = clerk`。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `INVITATION_INVALID` | 404 | 邀请不存在，或令牌与该邀请不符 |
| `INVITATION_USED` | 410 | 邀请已被别人接受 |
| `INVITATION_REVOKED` | 410 | 已撤回；或主体不是 `active`、门店已停用 |
| `INVITATION_EXPIRED` | 410 | 已过期（含 `pending` 但已过 `expires_at`） |
| `INVITATION_NOT_FOR_YOU` | 403 | 定向手机号与当前账号不符 |
| `ALREADY_OWNER` | 409 | 本人是该主体的老板；邀请保持 `pending` |
| `PHONE_IN_OTHER_ENTITY` | 409 | 本人在其他主体有有效成员关系且不满足空草稿让位；`details.currentRole` 为 `owner` / `clerk`；邀请保持 `pending` |
| `CONTENT_REJECTED` | 400 | 称呼未通过内容安全检测（定义见 m01-account）；`details = { fields: ["displayName"] }` |
| `PROVIDER_UNAVAILABLE` | 503 | 带了 `displayName` 而文本内容安全检测服务不可用：一律拒收、不写库，邀请保持 `pending`（可重试，A137；C27） |

**副作用**（一个事务，d4:716-742）：

- 归属判定（本人当前的有效成员关系）：
  - 没有：新建 `entity_member`，`entity_member.status`：— → `active`（`entity_member.join`，`role = clerk`，`02-identity-tenant.md:691`），写 `invitation_id`、`invited_by_member_id`、`display_name`、`last_store_id` = 邀请的门店；插入 `store_member`（`added_by_member_id` = 邀请人）；出站事件 `entity_member.joined`（x01 3.2；notify 场景 `m.member_changed` 通知老板，带称呼与脱敏手机号，d4:741；d6:247）。
  - 同主体的店员：`store_member` 追加该门店（已在则不动），不新增名额；没有状态迁移，所以不发 `entity_member.joined`，改发 `entity_member.stores_changed`（`addedStoreIds` = [邀请的门店]，`removedStoreIds` = []；已在该门店时不发）。载荷另带 `invitationId`，notify 据此通知老板“某某已加入本店”，而不是像 `m.member.update` 那样通知店员本人（x01 待补登本接口为发出方与这条订阅规则）。
  - 名下是空草稿主体（`02-identity-tenant.md:524` 的四个条件）：先让位——`entity.lifecycle`：`active` → `abandoned`（`entity.abandon`），老板成员关系 `active` → `removed`（`entity_member.cascade_remove`，原因 `draft_abandoned`），名下门店 `active` → `archived`（`store.archive_by_entity`，原因 `entity_abandoned`，`02-identity-tenant.md:611`）；同事务吊销该老板在被放弃主体下未吊销的下载页会话（`portal_session.revoked_at = now`，`revoke_reason = membership_changed`；`02-identity-tenant.md:697`，保证 `identity.I20`）；发 `entity.abandoned`、`entity_member.removed`（`removeReason = draft_abandoned`）与各门店的 `store.archived`；再按“没有”处理。空草稿的定义已排除待接受的邀请，没有邀请要撤回。
- `invitation.status`：`pending` → `accepted`（`invitation.accept`，`02-identity-tenant.md:787`），写 `accepted_at`、`accepted_by_user_id`、`accepted_member_id`，清空 `token_enc`；取消 `invitation.expire` 定时器；出站事件 `invitation.accepted`（三个分支都发）。
- 账号没有称呼时写 `merchant_user.display_name`；各迁移写 `status_transition` 与审计（PRD 6.16.2 第 3 条）。不写 `agreement_consent`。

**说明**：

- 同一令牌已由本人接受：返回 200 与当前成员关系（不论幂等键是否相同，d4:742）。卡片被转发、多人并发点击时，行锁保证只有第一个成功，其余得到 `INVITATION_USED`。
- 同一用户并发接受两个主体的邀请，撞 `uq_entity_member_one_entity` 时映射为 `PHONE_IN_OTHER_ENTITY`（d4:737）。
- 协议同意：未登录的受邀人在加入页勾选协议后走 `m.session.phoneLogin(consentScene = member_join)`，同意在登录时以 `member_join` 记一次（m01 3.2；d7:685）；已登录的不再弹手机号组件，也不再勾选协议。本接口不在 C73 白名单内：已登录者若缺现行版本的同意，会先在中间件得到 428 `CONSENT_REQUIRED`，端上走 `m.agreementConsent.create`（`reconsent`）后用同一幂等键重放。这样能走到处理器的账号一定已有同版本的同意行，本接口再写会撞 `uq_agreement_consent_no_biz`（同一账号同一版本、无单据只有一行，与 `scene` 无关，`13-notify-docs.md:853`），所以不写、也不收 `consents`。
- 成功后端上重拉 `GET /m/me`，进入店员首页。

### 3.17 m.portalTicket.lookup　扫码取票据摘要
`GET /m/portal-tickets/lookup?code=`

| 项 | 内容 |
| --- | --- |
| operationId | `m.portalTicket.lookup`（路线图 `m02.portal-ticket.lookup`） |
| 鉴权 | `member`；能力点 `portal.authorize`（仅老板；已停用门店上下文里也有）。店员扫码得到 `ROLE_FORBIDDEN`，端上提示“仅老板可授权”（d7:1279） |
| 店员视图 | `none` |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | 原型无：确认页 `sub/publish/portal-approve`；入口在 M:Publish（“扫码在电脑上下载”）与 M:Sample（“在电脑上预览”） |

**请求**：查询参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `code` | string | 是 | 22 个 base64url 字符（`portal_ticket.public_id`：二维码内容是 `https://portal.<域名>/a?t=<publicId>`，端上 `wx.scanCode` 读出后取 `t`，p01 `qrUrl`），或 8 位 Crockford Base32 短码（手输，服务端去掉空格与连字符、转大写后按 `portal_ticket.short_code` 查 `pending` 的那一张） | 访问日志脱敏（A3、C5） |

**响应**：`PortalTicketPreview`（2.10）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `PORTAL_TICKET_INVALID` | 410 | 票据不存在（`details.reason = not_found`）、已过期（`expired`；`approved` 超过 60 秒未换会话也算）、已作废（`rejected`）、已换过会话（`consumed`），或已被确认、正等电脑换会话（`approved`：用 `public_id` 扫到已确认的票据，如重复扫码、另一位老板已确认）（定义见 p01-portal，取值表见 p01 第 5 节；本接口用这五个原因，不用 `secret_mismatch`）；端上提示“请在电脑上刷新二维码后重试”，`approved` 提示“已确认，请在电脑上继续” |

**副作用**：无。

**说明**：草案写作 `GET /m/portal-tickets/{code}`（d5 写作 `/m/portal-logins/{ticket}`）。

### 3.18 m.portalTicket.approve　允许这台电脑下载
`POST /m/portal-tickets/{portalTicketId}/approve`

| 项 | 内容 |
| --- | --- |
| operationId | `m.portalTicket.approve`（路线图 `m02.portal-ticket.approve`） |
| 鉴权 | `member`；能力点 `portal.authorize`；操作人须是 `X-Store-Id` 所属主体的老板 |
| 店员视图 | `none` |
| 幂等 | `required`（路线图原写的“natural（状态守卫）”按 A17 不采用） |
| 乐观锁 | 无（技术状态，带原状态条件的更新，`02-identity-tenant.md:898`） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | 原型无：确认页 `sub/publish/portal-approve` |

**请求**：路径参数 `portalTicketId`（uuid，`portal_ticket.id`）。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `pairDigits` | string | 是 | 两位数字 | 老板在三个候选里点选的数字，与 `portal_ticket.pair_digits` 比对 |

**响应**：`PortalTicketDecision`（2.10）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `PORTAL_TICKET_INVALID` | 410 | 票据不是 `pending`（`details.reason` 为 `rejected` / `consumed` / `approved`；`approved` = 已被确认、正等电脑换会话，如另一位老板已确认、换新幂等键再点确认；同键重放按 C50 返回上次结果，不走到这里）或已过期（`expired`）；id 不存在为 `not_found`（定义见 p01-portal，取值表见 p01 第 5 节；不用 `secret_mismatch`） |

**副作用**：

- 数字一致：`portal_ticket.status`：`pending` → `approved`（`02-identity-tenant.md:903`），写 `approved_by_user_id`、`entity_id`、`store_id`（= `X-Store-Id`）、`approved_at`；写审计（`activity` 流，操作人为老板，`meta` 带电脑的 IP 与浏览器，d4:512）。
- 数字不一致：`pending` → `rejected`（`02-identity-tenant.md:904`），一次即作废；同样写一条审计（本稿补充，便于排查被诱导扫码）。
- 技术状态，不写 `status_transition`、不发出站事件。

**说明**：

- 数字不一致不返回错误码，而是 200 与 `status = rejected`、`rejectReason = pair_mismatch`（A101）：错误会让事务回滚（C50 只持久化成功），票据就作废不了。端上提示“数字不一致，请在电脑上刷新二维码后重试”（d7:1243）。
- 授权范围是确认时的 `X-Store-Id` 门店；电脑端随后凭 `pollSecret` 换取会话（`portal.portalTicket.exchange`，p01），须在 `approved_at` 后 60 秒内。

### 3.19 m.portalTicket.reject　拒绝
`POST /m/portal-tickets/{portalTicketId}/reject`

| 项 | 内容 |
| --- | --- |
| operationId | `m.portalTicket.reject`（路线图 `m02.portal-ticket.reject`） |
| 鉴权 | `member`；能力点 `portal.authorize` |
| 店员视图 | `none` |
| 幂等 | `required` |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | 原型无：确认页的“拒绝” |

**请求**：路径参数 `portalTicketId`（uuid）；请求体无。

**响应**：`PortalTicketDecision`（`status = rejected`，`rejectReason = by_owner`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `PORTAL_TICKET_INVALID` | 410 | 同 3.18：`details.reason` 取 `not_found` / `expired` / `rejected` / `consumed` / `approved`（已被确认的票据不能再拒绝） |

**副作用**：`portal_ticket.status`：`pending` → `rejected`（`02-identity-tenant.md:904`）；确认人四列保持为空；不写审计（数据模型只要求确认时写）。

**说明**：电脑端轮询到 `rejected` 后显示“已拒绝”，可重新申请票据。

### 3.20 m.portalSession.list　已授权的电脑
`GET /m/portal-sessions`

| 项 | 内容 |
| --- | --- |
| operationId | `m.portalSession.list`（路线图 `m02.portal-session.list`） |
| 鉴权 | `member`；能力点 `portal.authorize`（d4 附录 A 写 `user` + `me.*`，按路线图取老板专属：店员没有可授权的电脑） |
| 店员视图 | `none` |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | 原型无：设置页的“已授权的电脑” |

**请求**：无。

**响应**：`{ items: PortalSessionItem[] }`，不分页，一次返回全部（有界小集合，A78；C42 已登记：会话 2 小时过期）。范围：`portal_session.approved_by_user_id` = 本人、`entity_id` = 当前主体、未吊销、未过期；按授权时间倒序。

**错误**：无（只有通用错误）。

**副作用**：无。

### 3.21 m.portalSession.revoke　撤销电脑授权
`POST /m/portal-sessions/{portalSessionId}/revoke`

| 项 | 内容 |
| --- | --- |
| operationId | `m.portalSession.revoke`（路线图 `m02.portal-session.revoke`） |
| 鉴权 | `member`；能力点 `portal.authorize`；会话须是本人在当前主体授权的 |
| 店员视图 | `none` |
| 幂等 | `required` |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | 原型无：设置页的“已授权的电脑 › 撤销” |

**请求**：路径参数 `portalSessionId`（uuid）；请求体无。

**响应**：`PortalSessionItem`（`revokedAt` 有值）。

**错误**：`NOT_FOUND`（404）：会话不存在，或不是本人在当前主体授权的。

**副作用**：未吊销时写 `portal_session.revoked_at = now`、`revoke_reason = owner_revoked`（`02-identity-tenant.md:265`）；写审计（`activity` 流，本稿补充）。已吊销或已过期的不再写，返回 200 与当前值。电脑端下一次请求得到 401 `PORTAL_SESSION_INVALID`（`details.reason = revoked`、`revokeReason = owner_revoked`，p01）。无状态机。

**说明**：会话不物理删除，过期满 30 天由维护任务清理（`02-identity-tenant.md:68`），所以按动作接口写（A7）。草案写作 `DELETE /m/portal-sessions/{id}`。

### 3.22 m.delegation.create　授权管理员代为确认（V1.1）
`POST /m/delegations`

V1.1，细节待设计。用途：老板授权管理员代为确认方案、样片、广告（委托人、受托成员、能力点、门店范围、有效期；d4:2144-2145；PRD.md:250）。V1.0 不建表、不挂路由；资源登记表 `delegations` 为占位，能力点届时定。

## 4. 枚举

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `EntityVerificationStatus` | `unsubmitted` / `pending` / `verified` / `rejected` | 同数据模型 `entity.verification_status` |
| `StoreLifecycle` | `active` / `archived` | 同数据模型 `store.lifecycle` |
| `StoreArchiveReason` | `by_owner` / `draft_deleted` / `entity_closed` / `entity_abandoned` | 同数据模型 `store.archive_reason`；商家端列表只会出现 `by_owner` |
| `QualificationStatus` | `unsubmitted` / `pending` / `verified` / `rejected` | 同数据模型 `store.qualification_status` |
| `MerchantRole` | `owner` / `clerk` | 同数据模型 `entity_member.role` |
| `MemberStatus` | `active` / `removed` | 同数据模型 `entity_member.status`（响应里只出现 `removed`） |
| `InvitationStatus` | `pending` / `accepted` / `revoked` / `expired` | 同数据模型 `invitation.status`；落地页把已过期未翻状态的 `pending` 按 `expired` 返回 |
| `InvitationRevokeReasonInput` | `by_owner` / `unshared_leave` | 数据模型 `invitation.revoke_reason` 中商家可提交的两个；`store_archived`、`entity_closed` 只由系统写 |
| `PortalTicketStatus` | `pending` / `approved` / `rejected` / `consumed` | 同数据模型 `portal_ticket.status`；本文响应只出现 `approved`、`rejected` |
| `PortalTicketRejectReason` | `pair_mismatch` / `by_owner` | 本文新增，只出现在响应里，不落库 |
| `PortalGrantScope` | `store` | 同数据模型 `portal_session.grant_scope` |
| `StoreCopyOption` | `basic` / `service` / `media` / `brand_assets` | 同数据模型 `store_profile.copy_options` 的元素 |
| `QuotaLimitReason` | `plan` / `inactive` | 本文新增：套餐生效 / 未开通或已过期（d4:650） |
| `StoreViewerRole` | `owner` / `clerk` / `none` | 本文新增：门店列表的判别字段，`none` = 没有有效成员关系 |
| `MemberStoreScope` | `all` / `listed` | 本文新增：老板隐含全部门店 / 店员按所属门店 |
| `StoreAction` | `archive` / `delete` / `restore` | 门店卡的 `actions`（C16） |
| `MemberAction` | `update` / `remove` / `revoke` | 成员行与待接受邀请行的 `actions` |
| `StoreBlockerKind` | `open_order` / `open_delivery_ticket` / `ad_in_production` / `qualification_in_review` / `channel_account_in_review` / `unverified_primary_store` | 本文新增：`StoreCloseGuard` 的类别（d4:790；d9:736），`x-open-enum` |
| `StoreNotDraftReason` | `qualification_submitted` / `has_business_data` | 本文新增：`STORE_NOT_DRAFT` 的 `details.reasons` |

## 5. 错误码

区间 41100–41199（A70）。全部 `retryable = false`。

| 符号 | 数值 | HTTP | 含义 | `details` |
| --- | --- | --- | --- | --- |
| `ALREADY_IN_ENTITY` | 41101 | 409 | 已是其他主体的店员，不能再建主体 | `{ storeName: string \| null }` |
| `ALREADY_OWNER` | 41102 | 409 | 已是该主体的老板，不能接受店员邀请 | 无 |
| `PHONE_IN_OTHER_ENTITY` | 41103 | 409 | 手机号已属其他主体（V1.0 一个账号只属于一个主体） | `{ currentRole: 'owner' \| 'clerk' }` |
| `SEAT_LIMIT_REACHED` | 41104 | 409 | 成员名额已满（含待接受的邀请） | `{ seatsUsed, memberLimit, limitReason }` |
| `STORE_LIMIT_REACHED` | 41105 | 409 | 门店额度已满 | `{ storesUsed, storeLimit, limitReason }` |
| `QUOTA_EXCEEDED` | 41106 | 409 | 门店数超过上限，须先停用门店才能新订购、提交广告需求（`tenant.assertWithinQuota`，d4:673；共用领域码，A77 归本文）。返回它的接口：m04 `m.order.create`、m06 `m.ad.create`；m04 `m.order.quote`、m06 `m.ad.quote` 把它作为 `blockers` 的一项。门店超限不另设同义码 | `{ storesUsed, storeLimit, storesOver }` |
| `STORE_ARCHIVED` | 41107 | 403 | 门店已停用，只能做收尾操作（门店上下文中间件返回，C17；全部 `/m` 的 `member` 路由都可能返回） | 无 |
| `STORE_HAS_OPEN_WORK` | 41108 | 409 | 门店有在办事项，不能停用或删除 | `{ blockers: StoreBlocker[] }` |
| `LAST_ACTIVE_STORE` | 41109 | 409 | 是主体最后一家启用中的门店 | 无 |
| `STORE_NOT_DRAFT` | 41110 | 409 | 不是草稿门店（提交过资质或有业务数据），只能停用 | `{ reasons: StoreNotDraftReason[] }` |
| `INVITATION_INVALID` | 41111 | 404 | 邀请令牌不存在或与邀请不符 | 无 |
| `INVITATION_USED` | 41112 | 410 | 邀请已被使用 | 无 |
| `INVITATION_REVOKED` | 41113 | 410 | 邀请已撤回（含门店停用、主体关闭） | 无 |
| `INVITATION_EXPIRED` | 41114 | 410 | 邀请已过期 | 无 |
| `INVITATION_NOT_FOR_YOU` | 41115 | 403 | 邀请限定了手机号，与当前账号不符 | 无 |
| `INVITATION_DAILY_LIMIT` | 41116 | 409 | 当天发出的邀请已达上限 | `{ dailyCap: integer }` |
| `OWNER_CANNOT_LEAVE` | 41117 | 409 | 老板不能退出门店；更换老板请联系客服 | 无 |

本文引用、由其他文档定义的：`CONTENT_REJECTED`（m01-account，`details = { fields: string[] }`，A131）；`PORTAL_TICKET_INVALID`、`PORTAL_SESSION_INVALID`（p01-portal）；`DICT_ITEM_DISABLED`（m08-support-misc，47001，409）；`INDUSTRY_NOT_OPEN`（m03-profile-asset，49007，409）。通用码见约定 C27；文本内容安全检测不可用时返回通用码 503 `PROVIDER_UNAVAILABLE`（A137）。第二轮起 `m.invitation.accept` 不收协议版本，本文不再返回 `AGREEMENT_VERSION_STALE`。

## 6. 待确认

| # | 问题 | 默认做法 |
| --- | --- | --- |
| 1 | 原型要补的输入与文案（产品、设计）：① M:Invite 没有“备注名”“对方手机号（可选）”两个输入框，而待接受行的“小何”与定向邀请都靠它们（d4:741；Members.dc.html）；② M:Join 没有称呼输入框，而账号称呼“加入门店时必填”（`02-identity-tenant.md:89`；d4:2087）；③ 老板从未填称呼时，邀请卡片与加入页的“王先生”用什么回落文案 | ① 邀请页补两个可选输入框，填写后再调一次 `m.invitation.create` 原地改写同一张卡（3.12）；② 账号已有称呼时不显示，没有时显示并必填；已登录的受邀人在加入页不再显示协议勾选（3.16）；③ 服务端回落为“门店老板”（2.8） |

## 7. 修订记录

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：路线图 `doc = m02-tenant` 的 22 条接口（V1.0 21，V1.1 1）；公共结构 12 个；错误码 41101–41117 | A1–A75；C1–C84；`02-identity-tenant.md`；d4 第 4、5 节与附录 A、B；d7 第 4.5、6 节；d9 第 4.4 节 |
| 2026-10-03 | 第二轮。① `m.invitation.accept` 去掉请求体 `consents` 与错误 `AGREEMENT_VERSION_STALE`，不再写 `agreement_consent`：加入场景的同意只由 `m.session.phoneLogin(member_join)` 写，已登录缺同意者先被 C73 中间件 428 拦下走 `m.agreementConsent.create`（否则撞 `uq_agreement_consent_no_biz`）。② 加锁次序按数据模型全局次序重写：accept 先锁本人 `merchant_user`；`m.store.archive` / `m.store.delete` 为主体 → 邀请 → 成员关系 → 门店；第 1 节写明次序。③ accept 空草稿让位补吊销老板的下载页会话（`membership_changed`）与 `entity_member.removed`；同主体店员分支改发 `entity_member.stores_changed`，不发 `entity_member.joined`；三个分支都发 `invitation.accepted`。④ 按 x01 补齐出站事件：`entity.created`、`store.created`、`invitation.created`、`invitation.revoked`、`invitation.accepted`，删去“事件名待登记”。⑤ `m.invitation.create` 复用条件去掉“定向手机号相同”，复用时按请求体原地改写备注名与定向手机号；`InvitationCard` / `InvitationPreview` 的 `inviterName` 改为非空并回落“门店老板”。⑥ `m.me.currentStore.replace` 能力点改为 `me.*`（已停用门店上下文可用）。⑦ `m.store.create` 复用 m03 第 1 步校验：名称与地址过内容安全（`CONTENT_REJECTED`），行业须启用且开放。⑧ 草稿门店判定不计复制来的素材；定稿写入 3.5。⑨ `SeatInfo` 补 `planName`；成员设置弹层标题改取成员称呼。⑩ 第 1 节登记对外函数 `tenant.getQuotaUsage`、`tenant.assertWithinQuota` 与门店停用联动；`QUOTA_EXCEEDED` 写明返回它的接口。⑪ 与 p01 对齐 `PORTAL_TICKET_INVALID` 的原因与二维码地址。⑫ 第 6 节已裁决或已按默认接受的 9 项移除（分页 A78、配对数字 A101、交付中口径、店员门店卡、草稿判定、同意场景、来源门店计数、能力点两项），只留原型缺口一项 | A76–A126（A77、A78、A85、A95、A101、A119、A120）；复核意见 A、B；`review/xdoc-m02-tenant.md`；`13-notify-docs.md:853`；`02-identity-tenant.md:80`、`603`、`697`；x01 3.2 |
| 2026-10-03 | 第三轮。① `EntityBrief` 在 2.2 补成字段表，写明本文为唯一定义（m01 引用，m03 同名结构改名）。② 文本内容安全检测不可用一律 503 `PROVIDER_UNAVAILABLE`、不写库：`m.store.create`、`m.invitation.create`、`m.invitation.accept` 补错误行，删去邀请备注名“先接受、排队复检”；`CONTENT_REJECTED` 写明 `details.fields`。③ `PORTAL_TICKET_INVALID` 三条接口补 `details.reason = approved`，与 p01 第 5 节取值表一致。④ 第 1 节补对外函数 `tenant.previewQuota`。⑤ 2.12 列出 `StoreCloseGuard` 各类别的登记方与口径（m03 1.2、m04 2.9、m05 1.2、m06 第 1 节）；`liveCount`、`deliveringCount`、`todoCount` 写明取 m04 的计数函数。⑥ M:StoreAdd 品牌故事计数改为 `m.storeAsset.summary?tag=brand_story` 取 `tabs.all`。⑦ 依据更新到 A150、C87。第 6 节无可删项 | A131、A132、A137、A145、A150；C27、C87；m01、m03、m04、m05、m07、p01 的第二轮请求；`d4-identity.md:682`、`794`；p01-portal.md 第 5 节 |
| 2026-10-03 | 第四轮（收尾）。3.3 `m.store.create` 改引 m03 1.2 `profile.validateStoreBasics`：行业品类已停用改返回 409 `DICT_ITEM_DISABLED`、未开放改返回 409 `INDUSTRY_NOT_OPEN`（第 5 节补引用来源），503 `PROVIDER_UNAVAILABLE` 注明同出 1.2；清单与路线图切片同步 | A137；m03-profile-asset 1.2、3.3；m03 第三轮请求 |
| 2026-10-03 | 第四轮补：`StoreCard`、`StoreCardForClerk` 与当前门店卡的 `cityName`、`categoryName` 改为 `city`、`category`（`DictRef` \| null，A151、C85；m08 `OverviewStore` 同形） | m08 的请求 |
