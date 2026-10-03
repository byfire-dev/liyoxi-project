# 商家端：账号与登录

| 项 | 内容 |
| --- | --- |
| 范围 | 商家端登录（静默登录、手机号快捷登录、退出）、当前账号（`/m/me`：称呼、换绑手机号、已登录的微信、一次性提示、注销）、短信验证码、协议（当前版本、版本正文、提交同意、已签署协议与计数）。画板：M:Login（M01）、M:Main（M02）、M:Join（M55）、M:Mine（M32）、M:StoreSwitch（M47）、M:Contracts（M34）的“协议”页签，以及 M:Checkout、M:PlanPick、M:TopUp、M:Ads、M:Invoices 上的协议链接与抬头；原型没画的“设置”“设置 › 账号与安全”“协议正文页”“重新同意弹层”（d7-platform.md:557 新增） |
| 接口数 | 16（V1.0 16，V1.1 0） |
| 依据 | 数据模型 02 分组（`merchant_user`、`wechat_identity`、`user_session`、`portal_session`、`merchant_user_notice`、`sms_verification`、`entity`、`store`、`entity_member`、`store_member`、`invitation`、`referral_code`）、13 分组（`agreement`、`agreement_version`、`agreement_consent`）、03 分组（`auth_event`、`audit_log`、`approval_request`）；草案 d4-identity 第 3.2–3.6 节与附录 A、B，d6-notify-docs-data 第 3.3、3.4、6 节，d7-platform 第 3.2、4.4、4.5 节；PRD 第 6.1、6.13、7.11 节；设计规范第 11、12 节；接口裁决 A1–A146、约定 C1–C87 |

## 1. 概览

商家端以手机号为账号，一个账号可挂多个微信身份。小程序冷启动先用 `wx.login` 静默登录；身份未绑定、退出过或被强制下线时回到登录页，用手机号组件登录（首次登录同时建账号、记协议同意与注册来源）。会话是不透明令牌，每请求查库，没有刷新接口，401 后由请求层单飞静默登录并重放一次（C3）。`/m/me` 返回账号、成员关系、待同意协议与一次性提示，是端上门店上下文的来源。用户级协议（《用户服务协议》《隐私政策》）有新版本时，除白名单外的请求返回 428，端上弹层同意后重放；主体级协议随交易接口提交版本 id。本文定义协议同意的提交结构 `ConsentInput`（只用于登录、重新同意两处用户级协议；交易接口只提交版本 id，见 2.7）、全仓唯一的“当前版本”解析口径（3.12），以及共用领域码 `CONTENT_REJECTED`、`SMS_UNAVAILABLE`、`SMS_CODE_INVALID`、`AGREEMENT_VERSION_STALE`（A77）。

本文的接口都不需要门店上下文，只有“已签署协议”的列表与计数是 `member`（需 `X-Store-Id`）。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `m.session.create` | `POST /m/sessions` | 静默登录 | public | none（登录） |
| `m.session.phoneLogin` | `POST /m/sessions/phone-login` | 手机号快捷登录 / 注册 | public | none（登录） |
| `m.session.current.delete` | `DELETE /m/sessions/current` | 退出登录 | user | none（A43） |
| `m.me.get` | `GET /m/me` | 当前账号 | user | none（查询） |
| `m.me.update` | `PATCH /m/me` | 修改称呼 | user；`me.*` | required |
| `m.smsCode.create` | `POST /m/sms-codes` | 发送换绑手机号的验证码 | user；`me.*` | required（三段式） |
| `m.me.changePhone` | `POST /m/me/change-phone` | 换绑手机号 | user；`me.*` | required（三段式） |
| `m.me.wechatIdentity.list` | `GET /m/me/wechat-identities` | 已登录的微信 | user；`me.*` | none（查询） |
| `m.me.wechatIdentity.delete` | `DELETE /m/me/wechat-identities/{wechatIdentityId}` | 移除某个已登录的微信 | user；`me.*` | required |
| `m.me.userNotice.acknowledge` | `POST /m/me/user-notices/{userNoticeId}/acknowledge` | 关闭一次性提示 | user；`me.*` | required |
| `m.me.deletion.create` | `POST /m/me/deletion` | 注销账号 | user；`me.*` | required |
| `m.agreement.list` | `GET /m/agreements` | 当前生效的协议版本 | public | none（查询） |
| `m.agreementVersion.get` | `GET /m/agreement-versions/{agreementVersionId}` | 协议版本正文与 PDF | public | none（查询） |
| `m.agreementConsent.create` | `POST /m/agreement-consents` | 提交协议同意（重新同意） | user | natural（`uq_agreement_consent_no_biz`） |
| `m.agreementConsent.list` | `GET /m/agreement-consents` | 已签署协议 | member（店员 trimmed） | none（查询） |
| `m.agreementConsent.summary` | `GET /m/agreement-consents/summary` | 合同页“协议 · N”计数 | member；`contract.read` | none（查询） |

路由注册顺序（A8）：`/m/sessions/phone-login`、`/m/sessions/current` 是字面段；`/m/agreement-consents/summary` 先于将来可能出现的 `/m/agreement-consents/{agreementConsentId}` 注册。

## 2. 公共结构

### 2.1 `MeView` 当前账号

`m.me.get` 的响应，也嵌在两个登录接口的响应里。老板与店员同一结构（`clerkView = same`）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `user` | object（`MeUser`） | 是 | 账号本身 | 2.2 |
| `memberships` | array<`MembershipBrief`> | 是 | 有效成员关系；V1.0 至多 1 条（`uq_entity_member_one_entity`），V1.1 多主体时为多条；没有为 `[]` | `entity_member`（`status = 'active'`） |
| `pendingConsents` | array<`PendingConsent`> | 是 | 待同意的用户级协议；没有为 `[]` | 计算，见 2.5 |
| `notices` | array<`UserNotice`> | 是 | 未关闭的一次性提示，按发生时间倒序；没有为 `[]` | `merchant_user_notice`（`acked_at` 为空） |

上次选择的门店在每条成员关系上各有一个（`MembershipBrief.lastStoreId`），不放在顶层：V1.1 多主体时顶层一个值说不清属于哪条成员关系。V1.0 冷启动恢复门店取 `memberships[0].lastStoreId`。

### 2.2 `MeUser` 账号

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `merchantUserId` | string(uuid) | 是 | 账号 id | `merchant_user.id` |
| `displayName` | string \| null | 是 | 称呼，不超过 20 字；登录后可填 | `merchant_user.display_name` |
| `phoneMask` | string | 是 | 登录手机号脱敏串（前 3 后 4，`138****6021`）；本人也只看脱敏值（C40） | `merchant_user.phone_mask` |
| `registeredAt` | string(date-time) | 是 | 注册时间 | `merchant_user.created_at` |
| `actions` | array<enum> | 是 | 当前可执行的账号动作（C16），取值见第 4 节 `MeUserAction`：`update` 总有；`change-phone` 仅在短信通道已配置时出现（d4-identity.md:407）；`deletion` 总有（阻断项在注销时判定） | 计算 |

### 2.3 `MembershipBrief` 成员关系概要

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `memberId` | string(uuid) | 是 | 成员关系 id | `entity_member.id` |
| `role` | enum（`owner` / `clerk`） | 是 | 角色；同一主体下各门店角色相同 | `entity_member.role` |
| `memberDisplayName` | string \| null | 是 | 成员称呼（加入时自填，老板可改为备注名） | `entity_member.display_name` |
| `joinedAt` | string(date-time) | 是 | 加入时间 | `entity_member.created_at` |
| `lastStoreId` | string(uuid) \| null | 是 | 本成员关系上次选择的门店，用于冷启动恢复；没有记录或该门店已不在本条 `stores` 里时为 `null` | `entity_member.last_store_id` |
| `entity` | object（`EntityBrief`，m02-tenant 2.2） | 是 | 所属主体 | 2.4 |
| `stores` | array<`MembershipStore`> | 是 | 能进的门店。老板：主体名下全部门店，含已停用的（收尾上下文），不含 `store.archive_reason = 'draft_deleted'` 的；店员：`store_member` 里的门店（都是启用中）。首店在前，其余按创建时间 | `store`、`store_member` |

### 2.4 `EntityBrief`（引用 m02）、`MembershipStore`

`EntityBrief` 由 m02-tenant 第 2.2 节定义（`{ entityId, name, verificationStatus }`，A132、C87），本文引用，不再重复定义。`name` 认证通过前为 `null`；合同、发票、确认订购页的抬头取它（取 `stores` 含当前 `X-Store-Id` 的那条成员关系，见 3.4）。

`MembershipStore`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `storeId` | string(uuid) | 是 | 门店 id，即请求头 `X-Store-Id` 的取值 | `store.id` |
| `name` | string \| null | 是 | 门店名称；首店起名前为 `null` | `store.name` |
| `isPrimary` | boolean | 是 | 是否首店 | `store.is_primary` |
| `lifecycle` | enum（`active` / `archived`） | 是 | 同数据模型 `store.lifecycle` | `store.lifecycle` |
| `qualificationStatus` | enum | 是 | 同数据模型 `store.qualification_status` | `store.qualification_status` |

门店卡上的城市、品类、待办数、额度（“专业版 · 门店 2 / 3 家”）不在这里，由 `m.store.list`（m02-tenant）返回。

### 2.5 `PendingConsent` 待同意的协议

也是 `m.bootstrap.get`（m08-support-misc）的 `pendingConsents` 元素与 428 `CONSENT_REQUIRED` 的 `details.pendingConsents` 元素。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `agreementKey` | string | 是 | 协议键（`user`、`privacy`） | `agreement.key` |
| `agreementVersionId` | string(uuid) | 是 | 需同意的当前版本 | `agreement_version.id` |
| `name` | string | 是 | 协议名称（带书名号） | `agreement.name` |
| `versionLabel` | string | 是 | 展示版本号，`v{major}.{minor}`（如 `v1.1`） | 由 `agreement_version.major`、`agreement_version.minor` 拼出 |
| `effectiveAt` | string(date-time) | 是 | 生效时间 | `agreement_version.effective_at` |
| `summary` | string | 是 | 变更摘要（1–60 字），弹层里展示 | `agreement_version.summary` |

计算规则（d6-notify-docs-data.md:1157-1169）：对 `agreement.subject_kind = 'user'` 的每份协议，取当前版本 v（`pending`、`active` 中 `effective_at <= now` 的最新一条，13 分组 2.11，不看簿记的 `status`）；本人有 v 的 `agreement_consent` 行即已同意；`v.is_reconsent_required = false` 且本人同意过该协议任一更早版本也算已同意（小修订不弹窗）；其余列入。

本规则只读：`m.me.get`、`m.bootstrap.get` 按它现算，不写库（A19）。指纹 `merchant_user.consent_stamp` 只由两处更新：协议同意中间件（非白名单请求、复核全部通过时，d6-notify-docs-data.md:1160-1171）与同意写入事务（3.2 第 5 步、3.14），常态下中间件只比一次字符串。

### 2.6 `UserNotice` 一次性提示

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `userNoticeId` | string(uuid) | 是 | 提示 id，关闭时用 | `merchant_user_notice.id` |
| `kind` | enum | 是 | 同数据模型 `merchant_user_notice.kind`（V1.0 只有 `new_wechat_bound`） | `merchant_user_notice.kind` |
| `occurredAt` | string(date-time) | 是 | 事件发生时间 | `merchant_user_notice.occurred_at` |
| `message` | string | 是 | 服务端按 `kind` 与发生时间（北京时间）拼出的文案，如“您的账号于 10-02 09:14 在一个新的微信上登录。如非本人操作，请到 我的 › 设置 › 账号与安全 移除该微信。”（d4-identity.md:388） | 计算；库里不存文案 |

### 2.7 请求结构：`ConsentInput`、`DeviceInfo`、`Attribution`

`ConsentInput`：提交同意的一份协议。本文用于手机号登录（3.2）与重新同意（3.14），两处只收用户级协议；主体级协议随交易接口只提交版本 id（见本节末段），不用本结构。`m.invitation.accept`（m02）不收同意（见 3.2 说明）。

| 字段 | 类型 | 必填 | 约束 | 说明（落到哪一列） |
| --- | --- | --- | --- | --- |
| `agreementKey` | string | 是 | ≤24 字符，小写蛇形 | `agreement_consent.agreement_key`；须与版本行的协议键一致，否则 400 `VALIDATION_FAILED` |
| `agreementVersionId` | string(uuid) | 是 | — | `agreement_consent.agreement_version_id`；须是该协议此刻的当前版本（3.12 的解析口径），否则 409 `AGREEMENT_VERSION_STALE`。端上取自 `m.agreement.list` |

交易接口都不用本结构：订购（m04 `m.order.create`，m04-mall-order.md:823）与广告需求（m06）只提交 `agreementVersionId`，付款单（m07）提交 `agreementVersionIds`；服务端按版本行补协议键，不是该协议的版本按过期处理。三者经同一个 `agreements.assertConsents` 校验与写入，过期同样返回 `AGREEMENT_VERSION_STALE`（`details.agreementKey` 由服务端从版本行取）。

`DeviceInfo`：设备快照，端上用 `wx.getDeviceInfo`、`wx.getAppBaseInfo` 取得；取不到的键省略。小程序版本号取请求头 `X-Client-Version`，不在请求体里。

| 字段 | 类型 | 必填 | 约束 | 说明（落到哪一列） |
| --- | --- | --- | --- | --- |
| `model` | string | 否 | ≤64 字符 | 机型 |
| `system` | string | 否 | ≤64 字符 | 系统及版本 |
| `wechatVersion` | string | 否 | ≤32 字符 | 微信版本 |
| `sdkVersion` | string | 否 | ≤32 字符 | 基础库版本 |

整体写入 `agreement_consent.device_snapshot`（契约 `ConsentDevice`，`appVersion` 由服务端从请求头补）；登录接口另把它拼成一行摘要（如“iPhone 15 · iOS 17.5 · 微信 8.0.50”，截断到 512 字符）写入 `user_session.device_info`。

**同意记录的写入口径**（3.2、3.14 共用；交易接口由各自文档按同一口径带入主体与单据）：每份协议写一行 `agreement_consent`，`INSERT … ON CONFLICT DO NOTHING`，命中唯一索引返回已有记录。

| 列 | 取值 |
| --- | --- |
| `agreement_key`、`agreement_version_id` | 取自 `ConsentInput` |
| `content_sha256` | 取版本行的 `agreement_version.content_sha256`（触发器核对一致） |
| `merchant_user_id`、`phone_enc`、`phone_mask` | 本账号 |
| `operator_name_mask` | 有效成员关系的 `entity_member.display_name`，没有则取 `merchant_user.display_name`，保留首字、其余换成 `*`；都没有为空（13-notify-docs.md:808） |
| `role` | 有效成员关系的角色；没有为空 |
| `appid`、`openid_hmac` | 本次请求所用的微信身份 |
| `entity_id`、`entity_name`、`uscc_enc`、`uscc_mask`、`store_id`、`biz_type`、`biz_id`、`biz_no` | 用户级协议一律为空 |
| `ip`、`request_id` | 请求来源 IP；请求号（≤40 字符） |
| `user_agent` | 请求头 `User-Agent`，服务端截断到 300 字符（`ck_agreement_consent_text_len`；安卓微信的 UA 常超过 300） |
| `device_snapshot` | `DeviceInfo` 加请求头的 `appVersion` |
| `consented_at` | 现在 |

`Attribution`：首触来源，端上从启动参数或小程序码 `scene` 读出、先到先得地存在本地，注册时提交；端上不自报来源类型（PRD 第 6.1 节第 4 条；d7-platform.md:678）。

| 字段 | 类型 | 必填 | 约束 | 说明（落到哪一列） |
| --- | --- | --- | --- | --- |
| `channelCode` | string | 否 | ≤32 字符 | 渠道码原值 → `merchant_user.source_channel_code` |
| `inviteCode` | string | 否 | ≤32 字符 | 邀请码原值 → `merchant_user.source_invite_code` |
| `scene` | integer | 否 | — | 小程序场景值 → `merchant_user.source_scene` |

服务端把两个码转大写后查 `referral_code`（邀请码优先，取第一个命中且 `status = 'active'` 的行），命中则 `merchant_user.source_type` 取该行的 `source_type`、`merchant_user.source_referral_code_id` 取该行 id，否则记 `organic`（02 分组 2.14）。只在新建账号时写入，之后不可改（`trg_merchant_user_immutable`）。

### 2.8 登录结果：`SilentLoginResult`、`PhoneLoginResult`

`SilentLoginResult`（`m.session.create`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `needPhone` | boolean | 是 | `true` = 不能静默登录，保持游客态；需要登录时走手机号登录 | 计算 |
| `token` | string \| null | 是 | 会话令牌 `lyxm_<sid>.<32 字节随机数 base64url>`，端上存 `lyx.accessToken`；`needPhone = true` 时为 `null` | 新建的 `user_session`（库里只存 `user_session.token_hash`） |
| `me` | object（`MeView`）\| null | 是 | 同 `m.me.get`；`needPhone = true` 时为 `null` | 2.1 |

`PhoneLoginResult`（`m.session.phoneLogin`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `token` | string | 是 | 会话令牌，同上 | 新建的 `user_session` |
| `me` | object（`MeView`） | 是 | 同 `m.me.get` | 2.1 |
| `isNewUser` | boolean | 是 | 本次是否新建了账号 | 计算 |
| `switchedFrom` | object \| null | 是 | 本微信此前登录的是另一个有成员关系的账号、这次被改绑过来时给出 `{ phoneMask }`（原账号手机号脱敏串），端上弹一次说明（d4-identity.md:308）；其余为 `null` | 原账号的 `merchant_user.phone_mask` |

### 2.9 协议：`AgreementVersionBrief`、`AgreementCurrent`、`AgreementVersionDetail`

`AgreementVersionBrief`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `agreementVersionId` | string(uuid) | 是 | 版本 id | `agreement_version.id` |
| `versionLabel` | string | 是 | `v{major}.{minor}` | `agreement_version.major`、`agreement_version.minor` |
| `effectiveAt` | string(date-time) | 是 | 生效时间 | `agreement_version.effective_at` |
| `summary` | string | 是 | 变更摘要 | `agreement_version.summary` |
| `isReconsentRequired` | boolean | 是 | 是否需要用户重新同意 | `agreement_version.is_reconsent_required` |

`AgreementCurrent`（`m.agreement.list` 的元素）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `agreementKey` | string | 是 | 协议键 | `agreement.key` |
| `name` | string | 是 | 协议名称（带书名号） | `agreement.name` |
| `subjectKind` | enum | 是 | 同意主体，同数据模型 `agreement.subject_kind` | `agreement.subject_kind` |
| `consentMode` | enum | 是 | 同意方式，同数据模型 `agreement.consent_mode`；端上据此决定显示勾选框还是“付款即同意”的明示文案 | `agreement.consent_mode` |
| `scenes` | array<enum> | 是 | 会落同意记录的场景，取值同 `agreement_consent.scene` | `agreement.scenes` |
| `currentVersion` | object（`AgreementVersionBrief`）\| null | 是 | 当前版本（`pending`、`active` 中 `effective_at <= now` 的最新一条）；尚无已生效版本时为 `null`，端上隐藏该协议 | `agreement_version` |
| `upcomingVersion` | object（`AgreementVersionBrief`）\| null | 是 | 已排期、尚未生效的版本（`status = 'pending'` 且 `effective_at > now`）；`member`、`points` 在公告期内可读到新版本；没有为 `null` | `agreement_version` |

`AgreementVersionDetail`（`m.agreementVersion.get`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `agreementVersionId` | string(uuid) | 是 | 版本 id | `agreement_version.id` |
| `agreementKey` | string | 是 | 协议键 | `agreement_version.agreement_key` |
| `name` | string | 是 | 协议名称 | `agreement.name` |
| `versionLabel` | string | 是 | `v{major}.{minor}` | `agreement_version.major`、`agreement_version.minor` |
| `major` / `minor` | integer | 是 | 主、次版本号 | `agreement_version.major`、`agreement_version.minor` |
| `phase` | enum（`upcoming` / `current` / `superseded`） | 是 | 按生效时间实时算出的阶段：未到生效时间为 `upcoming`；是该协议的当前版本为 `current`；其余为 `superseded`。不用簿记列 `agreement_version.status`（它由 `docs.sweep` 每 5 分钟翻转，会滞后） | 计算 |
| `effectiveAt` | string(date-time) | 是 | 生效时间 | `agreement_version.effective_at` |
| `summary` | string | 是 | 变更摘要 | `agreement_version.summary` |
| `isReconsentRequired` | boolean | 是 | 是否需要重新同意 | `agreement_version.is_reconsent_required` |
| `contentHtml` | string \| null | 是 | 展示版 HTML（已清洗）；只传了 PDF 的版本为 `null`，小程序改为打开 PDF（13 分组 2.11） | `agreement_version.content_html` |
| `contentSha256` | string | 是 | PDF 文件的 SHA-256，十六进制小写 64 位；同意记录引用它 | `agreement_version.content_sha256` |
| `pdf` | object `{ url, expiresAt }` | 是 | 下载版 PDF 的签名地址（C60“随数据返回”，不逐次留痕）；有效期 30 分钟（A125） | `agreement_version.pdf_file_id` 现签 |

### 2.10 已签署协议：`SignedAgreementItem`（老板视图）与 `SignedAgreementItemForClerk`（店员视图）

一行是一份协议（不是一条同意记录）。合同页的“协议”页签与设置页的“协议与隐私”都用它（M:Contracts，`Contracts.dc.html` 的 `agrs`）。结构名不用 `AgreementConsentItem`：a09-ops 的同意记录检索已用这个名字（一行一条同意记录），契约里同名会冲突（C74）。

`SignedAgreementItem`（`viewerRole = owner`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `agreementKey` | string | 是 | 协议键 | `agreement_consent.agreement_key` |
| `name` | string | 是 | 协议名称 | `agreement.name` |
| `subjectKind` | enum | 是 | `user` / `entity` | `agreement.subject_kind` |
| `consentedVersion` | object `{ agreementVersionId, versionLabel, effectiveAt }` | 是 | 最近一次同意的那个版本；合同页的“v1.1”“2026-08-01 起生效”与“下载 PDF”（经 `m.agreementVersion.get`）取它 | `latestConsent` 那一行的 `agreement_consent.agreement_version_id` 关联 `agreement_version` |
| `currentVersionId` | string(uuid) \| null | 是 | 该协议此刻的当前版本 id | `agreement_version`（实时解析） |
| `isCurrentVersionConsented` | boolean | 是 | `consentedVersion` 是否就是当前版本 | 计算 |
| `latestConsent` | object（`ConsentRecord`） | 是 | 最近一条同意记录（“最近确认”） | `agreement_consent`，按 `consented_at` 取最新 |
| `firstConsent` | object（`ConsentRecord`） | 是 | 最早一条同意记录（“首次签署”）；只有一条时与 `latestConsent` 相同 | `agreement_consent`，按 `consented_at` 取最早 |

`ConsentRecord`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `consentNo` | string(bigint) | 是 | 同意记录编号（授权书上印的也是它） | `agreement_consent.seq` 的十进制字符串（C33） |
| `consentedAt` | string(date-time) | 是 | 同意时间 | `agreement_consent.consented_at` |
| `scene` | enum | 是 | 签署场景，同数据模型 `agreement_consent.scene`；端上映射为“登录时”“续费 / 开通套餐时”“订购时”等（首条 `login` 显示为“注册时”） | `agreement_consent.scene` |
| `method` | enum | 是 | 同意方式，同数据模型 `agreement_consent.method` | `agreement_consent.method` |
| `versionLabel` | string | 是 | 这一条同意的版本 | 关联 `agreement_version` |
| `bizType` | enum \| null | 是 | 关联单据类型，同数据模型 `agreement_consent.biz_type`；无单据为 `null` | `agreement_consent.biz_type` |
| `bizNo` | string \| null | 是 | 关联单据号（付款单 `FK…`、订购单 `LYX…`、广告 `GG…`），合同页“关联单据”直接显示 | `agreement_consent.biz_no` |
| `bizTitle` | string \| null | 是 | 关联付款单的标题，合同页拼成“（续费专业版时）”“（开通专业版时）”；`bizType = billing_order` 时有值，其余为 `null` | 本页全部付款单号经 `billing.describePaymentOrders(entityId, orderNos)` 批量取 `title`（m07-billing.md:48） |

范围：老板看当前主体的主体级协议（`agreement.subject_kind = 'entity'` 且 `agreement_consent.entity_id` = 当前主体，含前任老板签的）与本人的用户级协议（`subject_kind = 'user'` 且 `agreement_consent.merchant_user_id` = 本人）。

`SignedAgreementItemForClerk`（`viewerRole = clerk`，`clerkView = trimmed`）：只含本人的用户级协议（d6-notify-docs-data.md:2244；C56）。字段同老板视图，但 `latestConsent`、`firstConsent` 用 `ConsentRecordForClerk`：

| 被剥离的字段 | 理由 |
| --- | --- |
| `bizType`、`bizNo`、`bizTitle` | 用户级协议没有单据；不给店员任何交易单号（C57） |

其余字段（`agreementKey`、`name`、`subjectKind`、`consentedVersion`、`currentVersionId`、`isCurrentVersionConsented`，以及 `ConsentRecordForClerk` 的 `consentNo`、`consentedAt`、`scene`、`method`、`versionLabel`）与老板视图相同。

### 2.11 其他响应结构

`AgreementConsentReceipt`（`m.agreementConsent.create`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `consents` | array<object> | 是 | 每份提交的协议一项：`{ agreementConsentId, consentNo, agreementKey, agreementVersionId, consentedAt }`；重复提交返回已有记录 | `agreement_consent.id`、`agreement_consent.seq`、`agreement_consent.agreement_key`、`agreement_consent.agreement_version_id`、`agreement_consent.consented_at` |
| `pendingConsents` | array<`PendingConsent`> | 是 | 提交后仍待同意的协议（正常为 `[]`；不为空时端上继续弹） | 2.5 |

`AgreementConsentSummary`（`m.agreementConsent.summary`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `all` | integer | 是 | 已签署的协议份数，与列表行数同口径 | 计算 |

`WechatIdentityItem`（`m.me.wechatIdentity.list` 的元素）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `wechatIdentityId` | string(uuid) | 是 | 身份 id，移除时用 | `wechat_identity.id` |
| `boundAt` | string(date-time) | 是 | 绑定到本账号的时间（首次绑定） | `wechat_identity.created_at` |
| `lastLoginAt` | string(date-time) | 是 | 最近一次登录 | `wechat_identity.last_login_at` |
| `deviceSummary` | string \| null | 是 | 该身份最近一次会话的设备摘要 | 该身份最新一行 `user_session.device_info` |
| `isCurrent` | boolean | 是 | 是否当前设备所用的微信 | 当前会话的 `user_session.wechat_identity_id` |
| `actions` | array<enum> | 是 | `delete`（可移除）或 `[]`。当前身份总可移除（等同退出）；其他身份仅在当前身份绑定满 `auth.identity_remove_min_age_days`（默认 7）天时可移除 | 计算 |

不返回 `openid`、`unionid`（d4-identity.md:396）。

`WechatIdentityRemoveResult`：`wechatIdentityId`（string(uuid)）、`revokedSessionCount`（integer，被吊销的会话数）、`isCurrentSessionRevoked`（boolean，移除的是当前身份时为 `true`，端上清令牌回登录页）。

`SmsCodeResult`（`m.smsCode.create`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `purpose` | enum | 是 | `phone_change` | `sms_verification.purpose` |
| `targetPhoneMask` | string | 是 | 验证码发往的号码（脱敏） | `merchant_user.phone_mask` |
| `expiresAt` | string(date-time) | 是 | 验证码过期时间（默认 5 分钟） | `sms_verification.expires_at` |
| `resendAfterSec` | integer | 是 | 多少秒后可再次发送（号码限频 60 秒 1 条） | 计算 |

`UserNoticeAckResult`：`userNoticeId`（string(uuid)）、`ackedAt`（string(date-time)，`merchant_user_notice.acked_at`）。

`DeletionResult`：`deletedAt`（string(date-time)，`merchant_user.deleted_at`）。

`DeletionBlocker`（`ACCOUNT_DELETION_BLOCKED` 的 `details.blockers` 元素）：`kind`（enum，见第 4 节 `DeletionBlockerKind`）、`count`（integer，该类未办结事项的数量）。a03-merchant 后台关闭主体的 `ENTITY_CLOSE_BLOCKED` 复用本结构与 `DeletionBlockerKind`，两处由同一组守卫给出。

---

## 3. 接口

### 3.1 m.session.create　静默登录

`POST /m/sessions`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `public`（不解析凭据）；无能力点 |
| 店员视图 | `same`（与角色无关） |
| 幂等 | `none`：登录与换会话（A18；C47） |
| 乐观锁 | 无 |
| 限流 | `m.login.silent`（C68，A130）：每 IP 30 次 / 分；3.2 用另一档 `m.login.phone`，两条登录不共用额度 |
| 开关 | 无 |
| 对应画板 | M:Login（M01）、M:Main（M02，冷启动）、M:Join（M55）；补充状态“登录失效”（设计规范第 12 节） |
| 出处 | 路线图 `m01.session.silent-login`；d4-identity.md:260-265、2251；d7-platform.md:657-665；C3 |

**请求**：路径参数、查询参数：无。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `loginCode` | string | 是 | 1–128 字符 | `wx.login` 取得，一次性 |
| `device` | `DeviceInfo` | 否 | 见 2.7 | 写 `user_session.device_info` |

**响应**：`data` 为 `SilentLoginResult`（2.8）。响应头 `Cache-Control: no-store`（含会话令牌，C18）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `WECHAT_UNAVAILABLE` | 503 | 微信 `code2Session` 失败或超时；端上保持游客态，或继续用本地现有令牌（d4-identity.md:262） |
| `WECHAT_CODE_INVALID` | 400 | `loginCode` 无效、过期或已用过；端上重新 `wx.login` 后重试一次 |

**副作用**：命中时（同一事务）：

- 插入 `user_session`：`idle_expires_at` = 现在 + 30 天，`absolute_expires_at` = 现在 + 90 天，`last_ip`、`device_info`；同一 `wechat_identity_id` 未吊销的会话超过 5 条时吊销最旧的一条（`revoke_reason = 'evicted'`，`identity.I25`）。
- 更新 `wechat_identity.last_login_at`、`wechat_identity.last_active_at`；`merchant_user.last_active_at` 同一天只写一次。
- `code2Session` 带回 `unionid` 而 `wechat_identity.unionid` 为空时补写，并按 02 分组 2.7 的回填 ① 把对得上号的 `wecom_contact.merchant_user_id` 补上。
- 写 `auth_event`（`space = merchant`，`event = login_success`，`method = silent`）。

未命中（`needPhone = true`）不写库。无状态迁移、无出站事件、无审计。

**说明**：

- 判定（d4-identity.md:263）：`(appid, openid)` 没有身份、`wechat_identity.silent_login_enabled = false`（退出登录或被强制下线后）、`merchant_user.status` 不是 `active`，一律返回 `needPhone = true`，不区分原因，不泄露账号是否存在或被禁用。
- 401 恢复（C3、C20）：请求层收到 `AUTH_REQUIRED` / `SESSION_INVALID` 后单飞执行一次 `wx.login` + 本接口；成功则带原 `X-Request-Id` 与幂等键重放原请求一次；`needPhone` 则回登录页，登录后回到原页面（设计规范第 12 节“登录失效”）。只有“本次确实带了令牌仍被拒”才清登录态。
- 待同意协议在 `me.pendingConsents` 里：非空时端上先弹重新同意（3.14），漏弹由 428 兜底（d7-platform.md:679）。
- 路径不带 `wechat`，为 V19 结论后的自建短信登录留位置（05-risks-and-open-issues.md 第 4 节 V19）。

### 3.2 m.session.phoneLogin　手机号快捷登录

`POST /m/sessions/phone-login`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `public`；无能力点 |
| 店员视图 | `same` |
| 幂等 | `none`：登录与换会话（A18）。重复提交不会建出两个账号：建号用 `INSERT … ON CONFLICT (phone_bidx) DO NOTHING`（`uq_merchant_user_phone_bidx`），身份行按 `uq_wechat_identity_appid_openid` 加行锁；同意记录 `ON CONFLICT DO NOTHING`（`uq_agreement_consent_no_biz`） |
| 乐观锁 | 无（事务内锁账号行与身份行） |
| 限流 | `m.login.phone`（C68，A130）：每 IP 10 次 / 小时 + 每 openid 5 次 / 小时（d4-identity.md:271）；与 3.1 的 `m.login.silent` 分档 |
| 开关 | 无 |
| 对应画板 | M:Login（M01）、M:Join（M55） |
| 出处 | 路线图 `m01.session.phone-login`；d4-identity.md:267-308、2252；d7-platform.md:667-673；02-identity-tenant.md:125 |

**请求**：路径参数、查询参数：无。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `loginCode` | string | 是 | 1–128 字符 | 手机号组件回调后再取一次的 `wx.login` code |
| `phoneCode` | string | 是 | 1–128 字符 | 手机号组件回调的 code；每次成功都计费，一次性 |
| `consents` | array<`ConsentInput`> | 是 | 1–2 项；只能是 `subject_kind = 'user'` 的协议；必须覆盖 `user`、`privacy` 的当前版本 | 写 `agreement_consent` |
| `consentScene` | enum | 否 | `login`（缺省）/ `member_join` | 落 `agreement_consent.scene`；M:Join 页传 `member_join`（d7-platform.md:685“`consents` 的场景为加入”）。加入场景的同意只由这里写，随后的 `m.invitation.accept` 不收同意，见说明 |
| `attribution` | `Attribution` | 否 | 见 2.7 | 只在新建账号时落库 |
| `device` | `DeviceInfo` | 否 | 见 2.7 | |

**响应**：`data` 为 `PhoneLoginResult`（2.8）。响应头 `Cache-Control: no-store`（含会话令牌，C18）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `WECHAT_UNAVAILABLE` | 503 | `code2Session` 或 `getPhoneNumber` 失败、超时 |
| `WECHAT_CODE_INVALID` | 400 | `loginCode` 或 `phoneCode` 无效、过期或已用过；端上请用户再点一次按钮 |
| `PHONE_REGION_UNSUPPORTED` | 400 | 手机号区号不是 86（V1.0 只支持中国大陆手机号，d4-identity.md:273） |
| `CONSENT_REQUIRED` | 428 | `consents` 没有覆盖 `user`、`privacy` 的当前版本；`details.pendingConsents` 给出缺的协议（d4-identity.md:274） |
| `AGREEMENT_VERSION_STALE` | 409 | 提交的版本不是该协议此刻的当前版本（页面停留期间新版本生效）；端上重拉 `m.agreement.list` 并要求重新勾选 |
| `VALIDATION_FAILED` | 400 | `consents` 里有主体级协议，或协议键与版本不一致 |
| `ACCOUNT_DISABLED` | 403 | 账号已被后台禁用（d4-identity.md:277） |
| `REVERIFY_REQUIRED` | 403 | 休眠保护：长期未登录的老板账号换了微信，需人工核实（d4-identity.md:283、465） |

**副作用**：外部调用（`code2Session`、`getPhoneNumber`）在事务之外先做完；然后一个事务：

1. 取号或建号：按手机号盲索引取账号；账号 `disabled` 时回滚并返回 `ACCOUNT_DISABLED`。没有则建 `merchant_user`，迁移 `merchant_user.status`: （新建）→ `active`（`merchant_user.register`，02-identity-tenant.md:125，守卫“协议已同意”，由第 5 步在同一事务内满足），写手机号四列（`phone_enc`、`phone_bidx`、`phone_mask`、`phone_last4`）与来源列（2.7 `Attribution`）；出站事件 `merchant_user.registered`（载荷 `merchantUserId`、`sourceType`、`sourceReferralCodeId`，x01 3.2）。
2. 新绑定（该 openid 没有身份，或绑定在别的账号上）先过休眠检查 `dormantGuard`（d4-identity.md:451-459），按下列顺序判定，命中即止：
   - 放行（不做任何处置）：① 账号是本次请求刚建的；② 账号没有有效成员关系；③ `merchant_user.dormant_bypass_until > now`（客服复核 `owner_reverify` 通过后的 72 小时窗口，02-identity-tenant.md:98）；④ `merchant_user.last_active_at ≥ now − auth.dormant_days`；⑤ 参数 `auth.dormant_days = 0`（检查关闭）。
   - 以下三支只在“已休眠”（①–⑤ 都不满足）时进入：
   - 店员：`entity_member.status`: `active` → `removed`（`entity_member.cascade_remove`，`remove_reason = 'dormant'`，`display_name` 置空；02-identity-tenant.md:692），删其 `store_member` 行；操作人 `system`（`remove_actor_type = 'system'`，`remove_actor_id`、`remove_client` 为空）；出站事件 `entity_member.removed`（`removeReason = dormant`，通知老板）。继续绑定，账号按没有主体的普通账号登录。
   - 老板且主体满足空草稿条件（02-identity-tenant.md:524 的四条）：`entity.lifecycle`: `active` → `abandoned`（`entity.abandon`），联动名下门店 `store.lifecycle`: `active` → `archived`（`store.archive_by_entity`，`archive_reason = 'entity_abandoned'`，02-identity-tenant.md:611）与老板成员关系 `entity_member.status`: `active` → `removed`（`entity_member.cascade_remove`，`remove_reason = 'draft_abandoned'`，02-identity-tenant.md:695），同事务吊销老板在该主体下授权出的、未吊销未过期的 `portal_session`（`revoke_reason = 'membership_changed'`，02-identity-tenant.md:697，`identity.I20`）；门店与成员关系的操作人都是 `system`（`archive_actor_type`、`remove_actor_type` 为 `system`，对应的 id 与客户端来源为空；02-identity-tenant.md:530）；出站事件 `entity.abandoned`、每家门店一条 `store.archived`（`archiveReason = entity_abandoned`）、`entity_member.removed`（`removeReason = draft_abandoned`）。继续绑定。
   - 老板其他情况：回滚事务，另起事务写 `auth_event`（`event = reverify_required`），返回 `REVERIFY_REQUIRED`。
3. 微信身份（以下各分支都把 `wechat_identity.last_login_at`、`wechat_identity.last_active_at` 写为现在）：没有 → 插入 `wechat_identity`，`unionid` 取 `code2Session` 带回的值；已绑定本账号 → `silent_login_enabled = true`，`unionid` 为空而本次带回时补写；绑定在账号 A → 吊销该身份在 A 下的会话（`identity_rebound`）、删除旧行（13 分组 `wx_subscribe_quota` 级联删除）、插入绑定本账号的新行（带 `unionid`）、写 `auth_event`（`identity_rebound`）；A 有有效成员关系时返回 `switchedFrom`（02 分组 2.2“改绑”）。身份的 `unionid` 有值时，按 02 分组 2.7 的回填 ① 把对得上号的 `wecom_contact.merchant_user_id` 补上（同 3.1）。
4. 新绑定、且本账号还有其他微信身份、且有有效成员关系：写审计（`stream = ops`，`category = account_security`，“新微信绑定”）与出站事件 `merchant_user.wechat_bound`（载荷 `merchantUserId`、`wechatIdentityId`，x01 3.2；订阅者 `identity.onWechatBound` 写 `merchant_user_notice`，`notify.onEvent` 通知其余微信并排除载荷里的这个身份）。
5. 同意：每份协议经 `agreements.assertConsents` 按 2.7 的写入口径写 `agreement_consent`（`scene = consentScene`，`method = checkbox`，无单据；`operator_name_mask` 按第 2 步之后的成员关系取，新账号为空）；全部用户级协议已齐时写 `merchant_user.consent_stamp`。
6. 插入 `user_session`（超过 5 条挤掉最旧，`evicted`）；更新 `merchant_user.last_active_at`；写 `auth_event`（`login_success`，`method = phone`）。

**说明**：

- 事务失败时 `phoneCode` 已经用掉，用户需要再点一次按钮（再计费一次），不缓存手机号（d4-identity.md:305）。
- 首次登录只建账号，不建主体与门店；主体由 `m.entity.create`（m02-tenant）懒创建（d4-identity.md:306）。原型的“首次登录将自动创建商家账号”保留。
- 登录页对任何未识别的微信都展示协议勾选；已同意当前版本的老用户走静默登录，看不到登录页（d4-identity.md:307）。
- 受平台约束（设计规范第 11 节）：按钮文案为“手机号快捷登录”“手机号快捷验证并加入”，不出现“微信”；接口名也不带 `wechat`。
- `switchedFrom` 的说明文案：“本设备此前登录的是尾号 6021 的账号。如需回到原账号，请退出后用原手机号登录。”（d4-identity.md:308 原文的“当前微信”按设计规范第 11 节改掉“微信”二字。）由此产生的空账号在换绑手机号时清理（3.7）。
- `REVERIFY_REQUIRED`：页面说明“该账号长期未登录，为保护账号安全需人工核实”并展示客服入口；客服在后台发起 `owner_reverify` 申请（a03-merchant），通过后写 `merchant_user.dormant_bypass_until = now + 72 小时`，用户在窗口内重新登录即按第 2 步的放行条件 ③ 绑定。
- M:Join 页：未登录时先调本接口（`consentScene = member_join`），再调 `m.invitation.accept`（m02-tenant）；已登录则直接接受。加入场景的同意只由本接口写一行 `member_join`；`m.invitation.accept` 不收、不写同意（m02-tenant.md:852）。已登录用户若缺现行版本的同意，`m.invitation.accept` 不在 C73 白名单内，先在中间件得到 428 `CONSENT_REQUIRED`，端上走 3.14（`reconsent`）后用同一幂等键重放；所以 `member_join` 记录只来自本接口在加入页的那次登录。

### 3.3 m.session.current.delete　退出登录

`DELETE /m/sessions/current`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`；无能力点 |
| 店员视图 | `same` |
| 幂等 | `none`（A43：端上把 401 当作已退出） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | 无画板：设置（退出登录，d7-platform.md:557、676 新增）；入口在 M:Mine（原型“设置”直接链到登录页，proto-merchant-b.md:235） |
| 出处 | 路线图 `m01.session.logout`；d4-identity.md:337、421、2253；A7、A43 |

**请求**：无。

**响应**：`data` 为 `null`。

**错误**：无业务错误。会话已失效时中间件返回 401，端上按已退出处理。

**副作用**（同一事务）：

- 吊销当前 `user_session`（`revoke_reason = 'logout'`）。
- 当前会话所用身份的 `wechat_identity.silent_login_enabled = false`：再次打开显示登录页，须重新验证手机号才恢复静默登录（d4-identity.md:337）。
- 吊销本人授权出的全部未吊销 `portal_session`（`revoke_reason = 'account_action'`；d4-identity.md:510“退出登录时同事务吊销其授权出的全部下载页会话”）。
- 写 `auth_event`（`space = merchant`，`event = logout`）。

无状态迁移、无出站事件。

**说明**：在协议同意白名单内（C73）。端上清本地令牌与上下文，回首页游客态（d7-platform.md:676）。DELETE 合规：“退出当前会话”是 A7 允许的两类之一。

### 3.4 m.me.get　当前账号

`GET /m/me`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`；无能力点；不需要 `X-Store-Id`（带了也不影响结果） |
| 店员视图 | `same` |
| 幂等 | `none`（查询；GET 不写库） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 在协议同意白名单内（C73，A85）：有待同意协议时照常返回，`pendingConsents` 非空 |
| 对应画板 | M:Mine（M32）、M:StoreSwitch（M47：主体名称与“已认证”）、M:Main（M02：一次性提示置顶）、M:Join、M:Checkout、M:Invoices、M:Contracts（抬头“合同、授权书与发票抬头：XX 餐饮管理有限公司”）；无画板：设置 › 账号与安全（脱敏手机号） |
| 出处 | 路线图 `m01.me.get`；d4-identity.md:265、2254；d7-platform.md:596、657、685；proto-merchant-b.md:604 |

**请求**：无。

**响应**：`data` 为 `MeView`（2.1）。响应头 `Cache-Control: no-store`（含个人数据，C18）。

**错误**：无业务错误。在协议同意白名单内（A85），有待同意协议时不返回 428：冷启动由本接口的 `pendingConsents` 驱动重新同意弹层。

**副作用**：无。

**说明**：

- 端上 `context` store 的来源（d7-platform.md:596）：收到 `NOT_A_MEMBER` 后、接受邀请后、退出门店或被移除后、建主体后重拉（d4-identity.md:826；d7-platform.md:685）；成员关系按库里现算，接受邀请、退出门店、移除成员（m02-tenant）之后立即反映。切换门店是纯客户端行为，记住选择用 `m.me.currentStore.replace`（m02-tenant），冷启动恢复取该成员关系的 `lastStoreId`。
- 合同页、发票页、确认订购页的主体名称取 `memberships` 中 `stores` 含当前 `X-Store-Id` 的那条成员关系的 `entity.name`（V1.0 只有一条；V1.1 多主体时不用改契约）。
- 一次性提示由 M:Main 首页置顶展示，点“知道了”调 3.10。

### 3.5 m.me.update　修改称呼

`PATCH /m/me`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`；能力点 `me.*` |
| 店员视图 | `same` |
| 幂等 | `required`（A17：内容编辑） |
| 乐观锁 | 不带 `lockVersion`：`merchant_user` 没有 `lock_version` 列（A47，C52 例外）；后写覆盖 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | 无画板：设置 › 账号与安全 |
| 出处 | 路线图 `m01.me.update`；d4-identity.md:2255、1883；A47 |

**请求**：路径参数、查询参数：无。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `displayName` | string | 是 | 去首尾空白后 1–20 字；过文本内容安全检测 | 写 `merchant_user.display_name`；不支持清空 |

**响应**：`data` 为 `MeUser`（2.2）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `CONTENT_REJECTED` | 400 | 称呼未通过内容安全检测（`details.fields = ["displayName"]`） |
| `PROVIDER_UNAVAILABLE` | 503 | 文本检测服务不可用（C27，可重试）；不写库（A137） |

**副作用**：更新 `merchant_user.display_name`。无状态迁移、无出站事件、无审计（称呼修改不在 d4-identity.md:1616-1628 的留痕清单里）。

**说明**：

- 文本检测（微信 `msgSecCheck`）用当前会话所用身份的 openid（d4-identity.md:1883），在事务前同步调用，不是三段式用例。
- 检测服务不可用时一律拒收（A137）：返回 503 `PROVIDER_UNAVAILABLE`、不写库，用户稍后重试。草案“先接受、排队补检”的做法（d4-identity.md:1883；d5-media.md 第 11 节）V1.0 不做。
- 只改账号称呼。成员称呼 `entity_member.display_name` 在加入时自填、老板可改为备注名（m02-tenant），不随本接口变。

### 3.6 m.smsCode.create　发送换绑验证码

`POST /m/sms-codes`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`；能力点 `me.*`（老板与店员都可） |
| 店员视图 | `same` |
| 幂等 | `required`（有发短信副作用，C47）；三段式“先落库”（C51，A84；契约标 `x-three-phase`） |
| 乐观锁 | 无 |
| 限流 | `m.sms`（C68：每 IP 20 次 / 小时、全站日上限熔断，同时受 `m.global` 约束）；号码级限频由 `notify.sendDirect` 按 `notification_delivery` 计数：每号码 60 秒 1 条、1 小时 5 条、1 天 10 条（13 分组 2.5“直发”） |
| 开关 | 短信通道未配置时自助换绑不可用：`MeUser.actions` 不含 `change-phone`，本接口返回 `SMS_UNAVAILABLE`（d4-identity.md:407） |
| 对应画板 | 无画板：设置 › 账号与安全 › 换绑手机号 |
| 出处 | 路线图 `m01.sms-code.send`；d4-identity.md:405、2260；02-identity-tenant.md:331-357；A48 |

**请求**：路径参数、查询参数：无。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `purpose` | enum | 是 | 只接受 `phone_change` | 写 `sms_verification.purpose`。资质联系人手机号的验证码按 A48 走单独路由 `m.storeProfile.contactSmsCode.create`（m03-profile-asset）；`login` 只声明、不启用 |

**响应**：`data` 为 `SmsCodeResult`（2.11）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `SMS_UNAVAILABLE` | 503 | 短信通道未配置或模板不可用；端上在换绑页另给“联系客服人工换绑”的引导（错误码的默认文案与场景无关） |
| `RATE_LIMITED` | 429 | 号码限频或 `m.sms` 档位已满；带 `Retry-After` |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | 同一个键的前一次请求还在发送中（可重试） |
| `VALIDATION_FAILED` | 400 | `purpose` 不是 `phone_change` |

**副作用**：

- 事务：插入 `sms_verification`（`purpose = phone_change`，`merchant_user_id` = 本人，`phone_bidx` = 本人 `merchant_user.phone_bidx`，`code_hash`，`expires_at` = 现在 + 5 分钟，`attempts = 0`）。
- 提交后：`notify.sendDirect`（`purpose = verify_code`，`direct_key = sms_verification:{id}`），写一行直发的 `notification_delivery`。验证码明文只在内存里，不进任何表与事件。

无状态迁移、无审计。

**说明**：

- 三段式“先落库”（C51 已登记，A84）：先占用幂等记录（`in_progress`，30 秒）→ 事务插入 `sms_verification` 并提交 → 事务外调 `sendDirect` → 成功才把幂等记录落为成功。`sendDirect` 抛错（限频、通道失败）时删除刚插入的那行（免得它成为“最新一条”挡住上一条仍有效的验证码，02 分组 2.6）并释放占用，同一个键可以直接重试。
- 发到账号当前手机号，端上只显示 `targetPhoneMask`。新一条发出后，旧的一条不再是“最新一条”，自动失效。

### 3.7 m.me.changePhone　换绑手机号

`POST /m/me/change-phone`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`；能力点 `me.*` |
| 店员视图 | `same` |
| 幂等 | `required`（改账号手机号是状态变化）；三段式（C51）：`getPhoneNumber` 在事务之前调用，`newPhoneCode` 一次性，同键并发得到 `IDEMPOTENCY_IN_PROGRESS` |
| 乐观锁 | 不带 `lockVersion`（`merchant_user` 无此列，A47）；事务内先锁本账号行，再按新号码盲索引锁占用方 |
| 限流 | `m.global` |
| 开关 | 同 3.6：短信通道未配置时返回 `SMS_UNAVAILABLE` |
| 对应画板 | 无画板：设置 › 账号与安全 › 换绑手机号 |
| 出处 | 路线图 `m01.me.change-phone`；d4-identity.md:403-419、2260；02-identity-tenant.md:129、439-451；PRD 第 6.1 节第 5 条 |

**请求**：路径参数、查询参数：无。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `oldSmsCode` | string | 是 | 4–8 位数字 | 3.6 发到原手机号的验证码；核销 `sms_verification` |
| `newPhoneCode` | string | 是 | 1–128 字符 | 手机号组件回调的 code，服务端换出新号码（微信已核验） |

**响应**：`data` 为 `MeUser`（2.2），`phoneMask` 已是新号码。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `SMS_UNAVAILABLE` | 503 | 短信通道未配置 |
| `SMS_CODE_INVALID` | 400 | 验证码错误、过期、已用或已作废；`details.attemptsLeft` 为剩余次数（错 5 次作废，须重新获取；过期、已用、已作废时为 `null`） |
| `WECHAT_UNAVAILABLE` | 503 | `getPhoneNumber` 失败或超时 |
| `WECHAT_CODE_INVALID` | 400 | `newPhoneCode` 无效、过期或已用 |
| `PHONE_REGION_UNSUPPORTED` | 400 | 新号码不是中国大陆手机号 |
| `PHONE_UNCHANGED` | 400 | 新号码与当前号码相同 |
| `PHONE_TAKEN` | 409 | 新号码已被另一个账号使用，且该账号有过成员关系或已被禁用；文案引导联系客服 |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | 同一个键的前一次请求还在处理中（可重试） |

**副作用**：

- 事务（d4-identity.md:412-418）：
  - 核销验证码：该账号、`phone_change`、原号码盲索引的最新一条，`used_at` 为空、未过期、`attempts < 5`，相符则写 `sms_verification.used_at`。
  - 占用方是 `status = 'active'` 且从未有过任何成员关系的空账号（多半是 3.2 的号码选择器误建的）：迁移 `merchant_user.status`: `active` → `deleted`（`merchant_user.purge_empty`，02-identity-tenant.md:129，操作人 `system`），同事务做完“置为 `deleted` 的事务”六步（02-identity-tenant.md:132-139）：① 吊销并删除其会话与下载页会话，删除其微信身份（`wx_subscribe_quota` 级联删除）；② 删除其短信验证码、一次性提示、企业微信关系行 `wecom_contact`（漏删会触发每日不变量 `identity.I24`）；③ 成员关系：空账号从未有过，无事可做；④ 以该账号为对象、仍在审的账号变更申请由系统代撤：`approval_request.status`: `pending` → `withdrawn`（`withdraw`，操作人 `system`，`is_decided_by_system = true`，03-staff-authz-audit.md:807、822），处理器同事务清空 `account_change_request.new_phone_enc`，每张发一条 `approval.withdrawn`；⑤ 清空手机号四列与称呼，写 `merchant_user.deleted_at`；⑥ 出站事件 `merchant_user.deleted`（`reason = purge_empty`；订阅者 `notify.onMerchantUserDeleted` 删其站内消息、清空投递目标）。
  - 更新本账号 `phone_enc`、`phone_bidx`、`phone_mask`、`phone_last4`；吊销本账号除当前会话外的全部 `user_session`（`revoke_reason = 'phone_change'`）。
  - 写审计（`stream = ops`，`category = account_security`，“换手机号”；前后值只存脱敏串）；出站事件 `merchant_user.phone_changed`（载荷 `merchantUserId`、`via = self_service`，不带手机号；通知模块据此生成站内消息）。
- 提交后：`notify.sendDirect`（`purpose = account_notice`）给原号码发账号安全短信；原号码只在内存里，发送失败不影响本接口结果（02 分组 2.8）。
- 验证码不符：`attempts + 1` 在独立短事务里提交后再返回 `SMS_CODE_INVALID`（主事务回滚不能带走计数）。

**说明**：

- 当前会话保留、令牌不变，只吊销其他会话（A81）；d4-identity.md:417 的“给当前设备签发新会话”不采用。
- 不吊销下载页会话（d4-identity.md:510 的清单不含换手机号）。
- 原号码不可用或短信未配置：由客服在后台发起 `account_change_request`（`kind = phone_rebind`，a03-merchant），审批通过后执行同一个换绑事务（02 分组 2.8）：上面“事务”里除核销验证码外的各步（清理空账号、改手机号、吊销其他会话、审计、事件）由一个函数实现，自助与审批共用；审批路径的 `merchant_user.phone_changed` 载荷为 `via = approval` 并带 `accountChangeRequestId`。a03 复用本文的 `PHONE_TAKEN`、`PHONE_UNCHANGED`。
- 路径动作名 `change-phone` 按 C12 账号类原名保留。

### 3.8 m.me.wechatIdentity.list　已登录的微信

`GET /m/me/wechat-identities`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`；能力点 `me.*` |
| 店员视图 | `same` |
| 幂等 | `none`（查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | 无画板：设置 › 账号与安全 › 已登录的微信 |
| 出处 | 路线图 `m01.wechat-identity.list`；d4-identity.md:392-399、2259 |

**请求**：查询参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `cursor` | string | 否 | 不透明 | 首页不传（C42） |
| `limit` | integer | 否 | 1–50，默认 20 | |

**响应**：`data = { items: WechatIdentityItem[], nextCursor, hasMore }`（C42 游标分页，不返回总数）；按 `wechat_identity.last_login_at` 倒序，当前身份总在第一页。

**错误**：无。

**副作用**：无。

**说明**：`/m/me/wechat-identities` 是 `wechat-identities` 资源在当前账号下的别名（A5 第一类）。页面上的“首次绑定时间、最近登录、设备、是否本机”全部在 `WechatIdentityItem` 里。

### 3.9 m.me.wechatIdentity.delete　移除已登录的微信

`DELETE /m/me/wechat-identities/{wechatIdentityId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`；能力点 `me.*` |
| 店员视图 | `same` |
| 幂等 | `required`（A17：重放返回上次成功结果，不回 404） |
| 乐观锁 | 无（事务内锁身份行） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | 无画板：设置 › 账号与安全 › 已登录的微信 |
| 出处 | 路线图 `m01.wechat-identity.delete`；d4-identity.md:397-399、2259；02-identity-tenant.md:67；A7 |

**请求**：路径参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `wechatIdentityId` | string(uuid) | 是 | 须是本人的身份 | `wechat_identity.id` |

查询参数、请求体：无。

**响应**：`data` 为 `WechatIdentityRemoveResult`（2.11）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 身份不存在或不是本人的 |
| `IDENTITY_TOO_NEW` | 403 | 要移除的是其他微信，而当前会话所用的微信绑定不足 `auth.identity_remove_min_age_days`（默认 7）天；`details.removableAt` 为可以移除的时刻 |

**副作用**（同一事务）：

- 吊销该身份的全部未吊销会话（`revoke_reason = 'identity_removed'`）。
- 物理删除该 `wechat_identity` 行（M63）；13 分组的 `wx_subscribe_quota` 随之级联删除，指向它的待发订阅投递按 `skipped`（`no_target`）处理。
- 写审计（`stream = ops`，`category = account_security`，“移除微信”）；写 `auth_event`（`identity_removed`，`detail.identityId`）。

无状态迁移、无出站事件。

**说明**：

- 规则（d4-identity.md:399）：刚混进来的微信不能反过来踢掉账号主人的微信。账号主人的微信都不在了（换了微信号）时，走后台强制下线后重新用手机号登录。
- 移除当前身份等同退出登录：当前会话一并吊销，`isCurrentSessionRevoked = true`，端上清令牌回登录页。同键重放时会话已失效，鉴权就返回 401，端上按已完成处理。
- 被移除的设备下一请求 401；静默登录找不到身份，得到 `needPhone`。

### 3.10 m.me.userNotice.acknowledge　关闭一次性提示

`POST /m/me/user-notices/{userNoticeId}/acknowledge`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`；能力点 `me.*` |
| 店员视图 | `same` |
| 幂等 | `required`（A17） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Main（M02，首页置顶的账号安全提示） |
| 出处 | 路线图 `m01.me-notice.acknowledge`；d4-identity.md:386-389、2256；02-identity-tenant.md:300-322 |

**请求**：路径参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `userNoticeId` | string(uuid) | 是 | 须是本人的提示 | `merchant_user_notice.id` |

查询参数、请求体：无。

**响应**：`data` 为 `UserNoticeAckResult`（2.11）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 提示不存在或不是本人的 |

**副作用**：`merchant_user_notice.acked_at` 为空时写为现在；已关闭的直接返回原值。无状态迁移、无出站事件、无审计。

**说明**：V1.0 只有 `new_wechat_bound` 一种，行由出站事件 `merchant_user.wechat_bound` 的订阅者 `identity.onWechatBound` 写入（x01-events-jobs 3.2；A95）。路径按资源登记表用 `user-notices` / `{userNoticeId}`，避开 V1.1 后台公告的 `{noticeId}`（A4）。

### 3.11 m.me.deletion.create　注销账号

`POST /m/me/deletion`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`；能力点 `me.*` |
| 店员视图 | `same` |
| 幂等 | `required`（A17） |
| 乐观锁 | 无（事务先锁账号行；老板再锁主体行，按 lock_rank） |
| 限流 | `m.global` |
| 开关 | 在协议同意白名单内（C73，A85）：注销个人信息不以同意新版隐私政策为前提 |
| 对应画板 | 无画板：设置 › 注销账号（二次确认在端上） |
| 出处 | 路线图 `m01.me.delete`；d4-identity.md:423-431、2261；02-identity-tenant.md:128、132-141；A7 |

**请求**：路径参数、查询参数：无。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `hasConfirmed` | boolean | 是 | 必须为 `true` | 端上二次确认后才发；不落库，防误调用 |

**响应**：`data` 为 `DeletionResult`（2.11）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `ACCOUNT_DELETION_BLOCKED` | 409 | 本人是老板，且主体有生效套餐、在办订购、上线中的成片、未完结的付款 / 退款 / 开票任一项；`details.blockers` 列出各类与数量，文案引导联系客服办理老板更换或主体关闭（d4-identity.md:429） |
| `VALIDATION_FAILED` | 400 | `hasConfirmed` 不是 `true` |

**副作用**：守卫（02-identity-tenant.md:128）：没有成员关系或是店员，直接执行；老板须通过阻断项检查。同一事务：

- `merchant_user.status`: `active` → `deleted`（`merchant_user.delete`，02-identity-tenant.md:128）。清空手机号四列与称呼，写 `merchant_user.deleted_at`。
- 吊销并删除本人全部 `user_session`（`account_deleted`）与 `portal_session`；删除全部 `wechat_identity`（`wx_subscribe_quota` 级联删除）、`sms_verification`、`merchant_user_notice`、`wecom_contact`。
- 本人的成员关系：店员 `entity_member.status`: `active` → `removed`（`entity_member.cascade_remove`，`remove_reason = 'account_deleted'`，02-identity-tenant.md:692），删其 `store_member` 行；本人全部成员关系行的 `display_name` 置空；出站事件 `entity_member.removed`（`removeReason = account_deleted`）。
- 老板：`entity.lifecycle`: `active` → `closed`（`entity.close`，02-identity-tenant.md:525），联动调用 m02 登记的“主体关闭联动”函数（m02-tenant.md:51；与 a03 `admin.entity.close` 是同一函数，02-identity-tenant.md:531），逐行迁移、逐行发事件：
  - 每张待接受邀请 `invitation.status`: `pending` → `revoked`（`invitation.revoke`，`revoke_reason = 'entity_closed'`，02-identity-tenant.md:788），取消其 `invitation.expire` 定时器，各发一条 `invitation.revoked`。
  - 其他每个有效成员 `entity_member.status`: `active` → `removed`（`entity_member.cascade_remove`，`remove_reason = 'entity_closed'`），删其 `store_member` 行；老板本人 `active` → `removed`（`cascade_remove`，`account_deleted`，02-identity-tenant.md:695）。每个被移除的成员（含老板本人）各发一条 `entity_member.removed`（`removeReason` 分别为 `entity_closed`、`account_deleted`），被移出的店员靠它收到通知（x01 3.2）。
  - 名下每家门店 `store.lifecycle`: `active` → `archived`（`store.archive_by_entity`，`archive_reason = 'entity_closed'`，02-identity-tenant.md:610），各发一条 `store.archived`（`archiveReason = entity_closed`）。
  - 吊销该主体下的全部下载页会话（`membership_changed`）。
  - 出站事件 `entity.closed`（`closedBy = owner_deletion`）。
- 以本账号为对象、仍在审的账号变更申请由系统代为撤回：`approval_request.status`: `pending` → `withdrawn`（`withdraw`，操作人 `system`，`is_decided_by_system = true`，03-staff-authz-audit.md:807、822），处理器同事务清空 `account_change_request.new_phone_enc`；每张发一条 `approval.withdrawn`。
- 写审计（`stream = ops`，`category = account_security`，“注销”）；出站事件 `merchant_user.deleted`（`reason = self_deleted`；订阅者 `notify.onMerchantUserDeleted` 删本人站内消息、清空投递目标）。

操作人列（各表的 CHECK 约束要求 `system` 当且仅当操作人 id 为空，`system` 时客户端来源为空）：本人发起的联动——店员本人的成员关系移除，老板注销连带的主体关闭、门店停用、成员移除、邀请撤回——操作人类型都记 `merchant`，操作人 id 为本人 `merchant_user.id`，客户端来源 `weapp`（`remove_actor_*`、`archive_actor_*`、`revoke_actor_*` 三组列同此）；账号变更申请的代撤记 `system`。

**说明**：

- 交易、合同、发票、审计记录按法定义务保留，其中的操作人只剩内部 id 与“已注销用户”；同意记录里的手机号密文按合同证据留存（13 分组第 6 节第 1 项，待法务）。店员上传的素材留在门店，上传人显示“已注销成员”（d4-identity.md:428）。
- 阻断项由各模块提供的计数给出（类似门店停用的 `StoreCloseGuard`），口径以提供方为准：`subscription_active`、`payment_open`、`refund_open`、`invoice_open` 取 `billing.deletionGuard(entityId)`（m07-billing.md:47）；`open_order` 取 `order.countOpenOrdersByEntity`（`drama_order.status` ∉ {`ended`, `cancelled`, `refunded`}，m04-mall-order.md:297）；`release_online` 取 m05 第 1.2 节的计数（`delivery_ticket.step` ∈ {`awaiting_launch`, `launch_verify`, `in_service`, `takedown`}，m05-delivery-publish.md:75）。计数为 0 的类不列入 `blockers`。后台关闭主体（a03-merchant `ENTITY_CLOSE_BLOCKED`）用同一组计数。
- 同一手机号再次登录会新建账号（02 分组 2.1）。
- 成功后本人会话已删除：同键重放在鉴权就得到 401，端上在注销流程里把 401 当作已完成，清本地数据回首页游客态。
- 主体关闭后，在审的资质轮次由 profile 订阅 `entity.closed` 撤回（x01-events-jobs）。

### 3.12 m.agreement.list　当前生效的协议

`GET /m/agreements`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `public`；无能力点 |
| 店员视图 | `same` |
| 幂等 | `none`（查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 不受最低版本门槛拦截（C71）；在协议同意白名单内（C73） |
| 对应画板 | M:Login、M:Join（`user`、`privacy`）、M:Checkout（`custom_license`）、M:PlanPick（`member`、`points`）、M:TopUp（`points`）、M:Ads（`ad_service`）；无画板：协议正文页、设置 › 协议与隐私 |
| 出处 | 路线图 `m01.agreement.list`；d6-notify-docs-data.md:1768、2242；d4-identity.md:377；d7-platform.md:548；proto-merchant-a.md:84 |

**请求**：查询参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `agreementKey` | string | 否 | 协议键；多值逗号分隔，至多 7 个（C45） | 按协议键筛 |
| `scene` | enum | 否 | 取值同 `agreement_consent.scene` | 按签署场景筛（`agreement.scenes` 含它） |
| `cursor` | string | 否 | 不透明 | C42 |
| `limit` | integer | 否 | 1–50，默认 20 | |

两个筛选都不传时返回全部协议。

**响应**：`data = { items: AgreementCurrent[], nextCursor, hasMore }`，按 `agreement.sort_no` 排序。协议清单由迁移播种（V1.0 6 份），实际总是一页。

**错误**：`VALIDATION_FAILED`（`scene` 不是合法取值）。

**副作用**：无。

**说明**：

- 当前版本按 `effective_at` 实时解析，不看簿记的 `status`（13 分组 2.11）：同一协议在 `pending`、`active` 中取 `effective_at <= now` 的最新一条。这是全仓唯一的“当前版本”解析口径，由 docs 的一个函数实现：本接口、`PendingConsent`、`AgreementVersionDetail.phase`、`AGREEMENT_VERSION_STALE` 的判定，以及其他文档返回协议版本的地方（订购报价、广告需求、付款单、后台同意记录）都调它，不得按 `status = 'active'` 取（`status` 由 `docs.sweep` 每 5 分钟翻转，会滞后，到点后的几分钟内会出现“报价给旧版、提交判过期”的循环）。
- 交易页用它取当前版本 id，随交易接口提交版本 id（不用 `ConsentInput`，见 2.7）：订购带 `custom_license`（m04），付款单带 `member`、`points`（m07，按 `scene=plan_purchase` 或 `topup` 取），广告需求带 `ad_service`（m06）（d6-notify-docs-data.md:1173-1181）。
- 登录前可读（游客可点协议名看全文）。

### 3.13 m.agreementVersion.get　协议版本正文

`GET /m/agreement-versions/{agreementVersionId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `public`；无能力点 |
| 店员视图 | `same` |
| 幂等 | `none`（查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 不受最低版本门槛拦截（C71）；在协议同意白名单内（C73） |
| 对应画板 | 无画板：协议正文页（M:Login、M:Join 点协议名进入）；M:Contracts 的协议详情弹层（条款节选、“下载 PDF”） |
| 出处 | 路线图 `m01.agreement-version.get`；d6-notify-docs-data.md:2242；d7-platform.md:548；13-notify-docs.md:701-729 |

**请求**：路径参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `agreementVersionId` | string(uuid) | 是 | — | `agreement_version.id` |

查询参数、请求体：无。

**响应**：`data` 为 `AgreementVersionDetail`（2.9）。响应头 `Cache-Control: no-store`（含签名地址，C18）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 版本不存在，或是草稿、已撤回的版本 |

**副作用**：无（协议正文不需要逐次留痕，PDF 地址随数据返回，C60）。

**说明**：

- 可读的版本：`pending`（含已排期未生效的，`member`、`points` 在公告期内要能读到新版本）、`active`、`superseded`。
- 合同页详情弹层的“条款节选”由端上截取 `contentHtml` 的前几条，弹层注明“以上为节选，完整条款请下载查看”；`contentHtml` 为空时只给“下载 PDF”。
- 草案路径 `/m/agreements/{key}/versions/{ver}` 改为按版本行 id 取（A4）。

### 3.14 m.agreementConsent.create　提交协议同意

`POST /m/agreement-consents`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`；无能力点（d4 附录 A） |
| 店员视图 | `same` |
| 幂等 | `natural`：`uq_agreement_consent_no_biz`（同一账号同一版本、无单据只一条，重复提交返回已有记录；C47） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 在协议同意白名单内（C73） |
| 对应画板 | 无画板：重新同意弹层（冷启动或 428 时弹出）；M:Main |
| 出处 | 路线图 `m01.agreement-consent.create`；d4-identity.md:2258；d6-notify-docs-data.md:1124-1131、1144-1169、2243；d7-platform.md:626、679；13-notify-docs.md:790-858 |

**请求**：路径参数、查询参数：无。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `consents` | array<`ConsentInput`> | 是 | 1–2 项；只能是 `subject_kind = 'user'` 的协议 | 一份一行 `agreement_consent` |
| `device` | `DeviceInfo` | 否 | 见 2.7 | 写 `agreement_consent.device_snapshot` |

**响应**：`data` 为 `AgreementConsentReceipt`（2.11）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `AGREEMENT_VERSION_STALE` | 409 | 提交的版本不是该协议此刻的当前版本（含尚未生效的版本）；`details` 带当前版本 id，端上刷新弹层后重新同意 |
| `VALIDATION_FAILED` | 400 | 含主体级协议，或协议键与版本不一致 |

**副作用**：同一事务，每份协议经 `agreements.assertConsents` 按 2.7 的写入口径写一行 `agreement_consent`：`scene = reconsent`，`method = checkbox`，无单据、不带主体；`content_sha256` 取版本行；`operator_name_mask` 取有效成员关系的称呼、没有则取账号称呼（脱敏）；`appid`、`openid_hmac` 取当前会话所用身份；`user_agent` 截断到 300 字符。命中 `uq_agreement_consent_no_biz` 时 `ON CONFLICT DO NOTHING` 并返回已有记录。全部用户级协议已齐时更新 `merchant_user.consent_stamp`。无状态迁移、无出站事件、无审计（同意记录本身就是证据，另有每日摘要加固）。

**说明**：

- 只用于“已登录用户的重新同意”：登录时的同意随 3.2 提交（`login` 或 `member_join`）；`m.invitation.accept`（m02-tenant）不收同意，已登录受邀人缺同意时先被 428 拦下、经本接口补同意后重放（见 3.2 说明）；交易类同意随交易接口提交（d6-notify-docs-data.md:2243）。
- `me.pendingConsents`（或 `m.bootstrap.get` 的 `pendingConsents`）非空时端上弹阻断式弹窗，合并展示协议与变更摘要；同意 → 本接口 → 重放被 428 拦下的请求（同一幂等键，C7）；不同意只能退出登录（d6-notify-docs-data.md:1144-1155）。
- 草案的 `POST /m/me/consents`（d4）与 `POST /m/agreements/consents`（d6）合并为本条。

### 3.15 m.agreementConsent.list　已签署协议

`GET /m/agreement-consents`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`（需 `X-Store-Id`）；能力点：无（老板与店员都可调，按 `viewerRole` 裁剪；老板视图里的主体级协议即 `contract.read` 的范围） |
| 店员视图 | `trimmed`：只含本人的用户级协议，`ConsentRecord` 去掉 `bizType`、`bizNo`（2.10） |
| 幂等 | `none`（查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Contracts（M34）“协议”页签；无画板：设置 › 协议与隐私 |
| 出处 | 路线图 `m05.agreement-consent.list`（按资源归属移入本文）；d6-notify-docs-data.md:1141、2244；proto-merchant-b.md:415-418；C56 |

**请求**：查询参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `subjectKind` | enum | 否 | `user` / `entity` | 设置页只看用户级时传 `user` |
| `agreementKey` | string | 否 | 协议键 | |
| `cursor` | string | 否 | 不透明 | C42 |
| `limit` | integer | 否 | 1–50，默认 20 | |

**响应**：`data = { viewerRole, items, nextCursor, hasMore }`。`viewerRole` 为 `owner` 时 `items` 是 `SignedAgreementItem[]`，为 `clerk` 时是 `SignedAgreementItemForClerk[]`（C55 判别联合）。排序：先按 `subjectKind`（`entity` 在前、`user` 在后，与 M:Contracts 画板一致，`Contracts.dc.html:89-114`），同类内按 `agreement.sort_no`；协议至多 7 份，实际总是一页。

**错误**：无业务错误（缺门店上下文或无成员关系为 403 `NOT_A_MEMBER`，C27）。

**副作用**：无。

**说明**：

- 页面对应：每份协议显示名称、版本（`consentedVersion.versionLabel`）、生效日期（`consentedVersion.effectiveAt`）、最近确认的时间与场景（`latestConsent`）、首次签署的时间与场景（`firstConsent`）、关联单据（`latestConsent.bizNo`）；“预览”与“下载 PDF”用 `consentedVersion.agreementVersionId` 调 3.13。页面底部的“协议更新需要重新同意时，将在下次登录或订购时提示您”是静态文案。
- 只列有同意记录的协议（待确认 3）。
- 原型的“续费专业版时”“开通专业版时”比 `scene = plan_purchase` 更细：付款单关联的同意由 `ConsentRecord.bizTitle`（m07 `billing.describePaymentOrders` 按单号批量取标题）给出。“需求 GG20260928001～004”是多条单号；V1.0 显示场景名与最近一条的单号（待确认 2）。
- 已停用门店的老板（收尾上下文）照常可查：主体级协议不随门店变。
- 没有任何成员关系的账号调不了本接口（`member`）；这类账号在设置 › 协议与隐私只看 3.12 的当前协议与正文，不显示签署记录（待确认 4）。
- 草案写作 `GET /m/agreements/signed`。

### 3.16 m.agreementConsent.summary　协议计数

`GET /m/agreement-consents/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `contract.read`（A53） |
| 店员视图 | `none`（店员 403 `ROLE_FORBIDDEN`；合同页只给老板） |
| 幂等 | `none`（查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Contracts（M34）页签“协议 · 6”（`Contracts.dc.html:121`） |
| 出处 | 路线图 `m01.agreement-consent.summary`；A23、A53；C83 |

**请求**：查询参数同 3.15，去掉 `cursor`、`limit`：`subjectKind`、`agreementKey`。

**响应**：`data` 为 `AgreementConsentSummary`（2.11）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `ROLE_FORBIDDEN` | 403 | 店员调用 |

**副作用**：无。

**说明**：计数口径按协议计（一份协议一行），与 3.15 老板视图的行数一致。合同页另一个页签“定制内容授权书 · N”由 `m.licenseLetter.summary`（m05-delivery-publish）给，两个页签各调各的 `summary`（C83）。

---

## 4. 枚举

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `role`（`MembershipBrief.role`） | `owner` / `clerk` | 同数据模型 `entity_member.role` |
| `verificationStatus` | `unsubmitted` / `pending` / `verified` / `rejected` | 同数据模型 `entity.verification_status` |
| `lifecycle`（`MembershipStore.lifecycle`） | `active` / `archived` | 同数据模型 `store.lifecycle` |
| `qualificationStatus` | `unsubmitted` / `pending` / `verified` / `rejected` | 同数据模型 `store.qualification_status` |
| `UserNotice.kind` | `new_wechat_bound` | 同数据模型 `merchant_user_notice.kind`（`x-open-enum`） |
| `MeUserAction` | `update` / `change-phone` / `deletion` | 本文定义：改称呼、换绑手机号、注销（C16；动作名取 C12 的账号类原名与单例名词） |
| `WechatIdentityAction` | `delete` | 本文定义：可移除 |
| `subjectKind` | `user` / `entity` / `partner` | 同数据模型 `agreement.subject_kind`（`partner` V1.0 只声明，不会出现） |
| `consentMode` | `checkbox` / `by_action` / `esign` | 同数据模型 `agreement.consent_mode`（`esign` V1.0 只声明） |
| `scene`（`agreement.scenes[]`、`ConsentRecord.scene`、`m.agreement.list` 的 `scene=`） | `login` / `reconsent` / `member_join` / `plan_purchase` / `topup` / `order_submit` / `ad_request` | 同数据模型 `agreement_consent.scene` |
| `consentScene`（`m.session.phoneLogin` 请求） | `login` / `member_join` | 本文定义，是 `agreement_consent.scene` 的子集 |
| `method`（`ConsentRecord.method`） | `checkbox` / `by_action` / `prior_consent` | 同数据模型 `agreement_consent.method` |
| `bizType`（`ConsentRecord.bizType`） | `billing_order` / `drama_order` / `ad` | 同数据模型 `agreement_consent.biz_type` |
| `phase`（`AgreementVersionDetail.phase`） | `upcoming` / `current` / `superseded` | 本文定义的计算值：未到生效时间 / 当前版本 / 已被取代；不是 `agreement_version.status` |
| `purpose`（`m.smsCode.create` 请求） | `phone_change` | `sms_verification.purpose` 的子集；`contact_phone` 走单独路由（A48），`login` 只声明 |
| `DeletionBlockerKind` | `subscription_active` / `open_order` / `release_online` / `payment_open` / `refund_open` / `invoice_open` | 本文定义（`x-open-enum`）：生效套餐、在办订购、上线中成片、未完结付款单、未完结退款、未完结开票申请（d4-identity.md:429）；`open_order` 与 m02 `StoreBlockerKind` 同名（A134）；各项计数口径见 3.11 说明 |
| `viewerRole` | `owner` / `clerk` | C55 判别字段 |

内部取值（不出接口，写库时用）：`user_session.revoke_reason` 本文写 `logout`、`identity_rebound`、`identity_removed`、`phone_change`、`evicted`、`account_deleted`；`portal_session.revoke_reason` 写 `account_action`、`membership_changed`；`auth_event.event` 写 `login_success`、`identity_rebound`、`identity_removed`、`reverify_required`、`logout`，`method` 写 `silent`、`phone`。

## 5. 错误码

本文新定义的领域错误码。身份段取 41000–41099，协议同意段取 47400–47499（A70）。`CONTENT_REJECTED`、`SMS_UNAVAILABLE`、`SMS_CODE_INVALID`、`AGREEMENT_VERSION_STALE` 是共用领域码，归本文（A77；约定 C28 的归属表），其他文档只引用符号，按本表的 `details` 返回；默认文案因此写成与场景无关的说法，场景化的引导由端上补。

| 符号 | 数值 | HTTP | 可重试 | `details` | 含义（默认文案的意思） |
| --- | --- | --- | --- | --- | --- |
| `WECHAT_UNAVAILABLE` | 41001 | 503 | 是 | 无 | 手机号验证服务暂不可用，请稍后重试（`code2Session` 或 `getPhoneNumber` 失败、超时；d4-identity.md:2315）。文案会显示在 M:Login、M:Join，按设计规范第 11 节不出现“微信”；符号名不展示，保留 |
| `WECHAT_CODE_INVALID` | 41002 | 400 | 否 | 无 | 登录凭证已失效，请重新点击登录（`loginCode`、`phoneCode` 无效、过期或已用）（本文补） |
| `PHONE_REGION_UNSUPPORTED` | 41003 | 400 | 否 | 无 | 暂只支持中国大陆手机号（d4-identity.md:2316） |
| `ACCOUNT_DISABLED` | 41004 | 403 | 否 | 无 | 账号已被停用，请联系客服（d4-identity.md:2312） |
| `REVERIFY_REQUIRED` | 41005 | 403 | 否 | 无 | 该账号长期未登录，为保护账号安全需人工核实，请联系客服（d4-identity.md:2313） |
| `CONTENT_REJECTED` | 41006 | 400 | 否 | `{ fields: string[] }`（命中检测的请求字段路径，点分写法同 `fieldErrors.path`，至少 1 项） | 提交的文字包含不适宜的内容，请修改（d4-identity.md:2317；共用：m02 的称呼与备注名、m03 的档案文本、m06 的文案与修改意见、a03 的素材需求名称与拍摄说明） |
| `SMS_UNAVAILABLE` | 41007 | 503 | 否 | 无 | 短信验证暂不可用，请稍后再试或联系客服（短信通道未配置、模板不可用或发送失败；本文补。共用：m03 的资质联系人验证码。换绑页的“联系客服人工换绑”引导由端上补） |
| `SMS_CODE_INVALID` | 41008 | 400 | 否 | `{ attemptsLeft: integer \| null }`（剩余可试次数；验证码已过期、已用、已作废或不存在时为 `null`） | 验证码错误或已过期，请重新输入或重新获取（本文补。共用：m03 的资质联系人验证码） |
| `PHONE_UNCHANGED` | 41009 | 400 | 否 | 无 | 新手机号与当前手机号相同（本文补） |
| `PHONE_TAKEN` | 41010 | 409 | 否 | 无 | 该手机号已被其他账号使用，请联系客服（d4-identity.md:2316） |
| `IDENTITY_TOO_NEW` | 41011 | 403 | 否 | `{ removableAt: string(date-time) }` | 新绑定的微信 7 天内不能移除其他微信（d4-identity.md:2318） |
| `ACCOUNT_DELETION_BLOCKED` | 41012 | 409 | 否 | `{ blockers: DeletionBlocker[] }` | 主体还有未办结的事项，暂不能注销，请联系客服（本文补） |
| `AGREEMENT_VERSION_STALE` | 47401 | 409 | 否 | `{ agreementKey: string, currentAgreementVersionId: string(uuid) \| null }` | 协议已更新，请阅读新版本后重新同意（d6-notify-docs-data.md:1129、2259；登录、重新同意与全部交易接口共用）。“当前版本”按 3.12 的唯一口径判定；交易接口只提交版本 id 时，`agreementKey` 由服务端从版本行取 |

本文用到的通用码（C27）中有特殊含义的：`CONSENT_REQUIRED`（428）在 3.2 由处理器直接返回，`details = { pendingConsents: PendingConsent[] }`；C22 要求一个码的 `details` 类型唯一，中间件返回 428 时也带同样的 `details`（约定 C27 已登记，`PendingConsent` 归本文，A131、C87）；`RATE_LIMITED`（429）在 3.6 表示号码限频或 `m.sms` 档位已满；`PROVIDER_UNAVAILABLE`（503）在 3.5 表示文本检测服务不可用；`IDEMPOTENCY_IN_PROGRESS`（409）在 3.6、3.7 表示三段式用例处理中；`ROLE_FORBIDDEN`（403）在 3.16 表示店员没有合同页。

## 6. 待确认

只留需要产品、业务、法务决定的问题。初稿的第 1 条（换绑后会话）、第 3 条（协议 PDF 地址有效期）、第 6 条（协议同意白名单）已由 A81、A125、A85 裁决，移出本节；第二轮“需主负责人定”的限流拆档与文本补检已由 A130、A137 裁决，不再列出。

| # | 问题 | 默认做法 | 谁定 |
| --- | --- | --- | --- |
| 1 | 注销前要不要给阻断项预检（如 `POST /m/me/deletion-quote`），让设置页在确认前就显示“还有 2 笔在办订购” | 不单独提供；点“注销”后由 409 `ACCOUNT_DELETION_BLOCKED` 返回阻断项，端上展示并引导联系客服 | 产品 |
| 2 | 一次提交多条广告需求时，合同页“关联单据”要不要显示单号区间（原型“需求 GG20260928001～004”） | V1.0 显示场景名与最近一条的单号；付款单的“续费 / 开通专业版”已由 `bizTitle` 给出 | 产品 |
| 3 | 合同页“协议”页签是否列出尚未签署的协议（如从未提交广告需求的商家没有《广告制作与交付服务协议》） | 只列有同意记录的协议，计数同口径 | 产品 |
| 4 | 没有成员关系的账号要不要在设置页看到自己的签署记录 | 不看（`m.agreementConsent.list` 是 `member`）；若需要，改为 `user` 并在带门店上下文时追加主体级协议（与 A52 站内消息同一做法） | 产品 |

## 7. 修订记录

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：16 条接口（V1.0），公共结构 `MeView`、`ConsentInput`、`PendingConsent` 等，新错误码 41001–41012、47401 | 路线图 `doc = m01-account`；A1–A75；C1–C84 |
| 2026-10-03 | 相对路线图的取舍：退出登录幂等改 `none`（A43）；协议计数加能力点 `contract.read`（A53）；发码只留 `phone_change`（A48）；换绑后保留当前会话（待确认 1）；`PATCH /m/me` 不带锁版本（A47） | A43、A47、A48、A53 |

**第二轮**（2026-10-03；处理第十节裁决 A76–A126、`review/xdoc-m01-account.md`、两位复核员意见与整体核对）：

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 事件名按 x01 目录：`account.new_wechat_bound` 改为 `merchant_user.wechat_bound`（3.2、3.10、清单）；补发漏掉的事件：3.2 建号 `merchant_user.registered`、空草稿让位时老板的 `entity_member.removed`（`draft_abandoned`）；3.7 清理空账号的 `merchant_user.deleted`（`purge_empty`）与代撤的 `approval.withdrawn`；3.11 每张邀请一条 `invitation.revoked`、代撤的 `approval.withdrawn`，主体关闭时每个被移除的成员各一条 `entity_member.removed` | A95；x01 3.2、3.3（E1）；复核 A、B |
| 2026-10-03 | 3.7 清理空账号改为引用 02 分组“置为 `deleted` 的事务”六步，补删 `wecom_contact`、补系统代撤账号变更申请；写明自助换绑与审批换绑共用一个函数 | 02-identity-tenant.md:132-139；复核 A；xdoc（a03） |
| 2026-10-03 | 3.2 休眠检查先列五个放行条件，三条处置分支只在已休眠时进入；身份各分支写 `last_login_at`、`last_active_at`，新行写 `unionid` 并按回填 ① 补 `wecom_contact`；`switchedFrom` 文案去掉“微信” | d4-identity.md:451-459；02 分组 2.7；设计规范第 11 节；复核 A |
| 2026-10-03 | 2.7 补“同意记录的写入口径”：`content_sha256`、`operator_name_mask` 的取法，`user_agent` 截断到 300 字符；3.2、3.14 引用它 | 13-notify-docs.md:808、851；复核 A |
| 2026-10-03 | 加入页的协议同意只记一行 `member_join`（由 3.2 写入，`m.invitation.accept` 命中唯一索引不新增）；不采纳 m02“登录记 `login`、加入再记 `member_join`”的默认，请 m02 改待确认 7 | d7-platform.md:685；`uq_agreement_consent_no_biz`；复核 A、B；xdoc（m02） |
| 2026-10-03 | `ConsentInput` 收窄为用户级协议（登录、重新同意、接受邀请）；交易接口只提交版本 id，服务端补协议键；3.12 写明全仓唯一的“当前版本”解析口径 | 复核 B；xdoc（m04、a09） |
| 2026-10-03 | `m.me.get`、`m.me.deletion.create` 在协议同意白名单内，删去 428 的说法；2.5 改为只读，`consent_stamp` 只由中间件与同意写入事务更新 | A85；A19；复核 A、B |
| 2026-10-03 | 3.11 写明联动迁移的操作人列：本人发起的记 `merchant` + 本人 id + `weapp`，代撤记 `system`；3.2 的休眠移除与空草稿让位记 `system` | 02 分组 `ck_store_archived`、`ck_entity_member_removed`、`ck_invitation_revoked`；复核 A |
| 2026-10-03 | `MeView.currentStoreId` 下放为 `MembershipBrief.lastStoreId`；抬头取 `stores` 含当前 `X-Store-Id` 的那条成员关系 | 复核 A（V1.1 多主体） |
| 2026-10-03 | 已签署协议按 `subjectKind`（`entity` 在前）再按 `sort_no` 排序；结构改名 `SignedAgreementItem`、`SignedAgreementItemForClerk`（避开 a09 的 `AgreementConsentItem`） | `Contracts.dc.html:89-114`；C74；复核 A、B |
| 2026-10-03 | 共用领域码（A77）：`CONTENT_REJECTED` 默认文案改为通用说法，`details` 改为 `{ fields: string[] }`；`SMS_UNAVAILABLE` 文案与场景无关；`SMS_CODE_INVALID.details.attemptsLeft` 可空；`WECHAT_UNAVAILABLE` 文案不出现“微信”；`IDENTITY_TOO_NEW.details.removableFrom` 改名 `removableAt` | A77；C15、C22；设计规范第 11 节；复核 A、B |
| 2026-10-03 | 3.5 文本检测不可用：补检事件 x01 尚未登记，登记前返回 503 `PROVIDER_UNAVAILABLE` | 复核 B；d4-identity.md:1883 |
| 2026-10-03 | 限流：3.6 改挂 `m.sms`；3.1、3.2 写明两条登录分开计数；3.12 筛选参数 `keys` 改名 `agreementKey`；3.1、3.2、3.4 响应头 `Cache-Control: no-store` | C68；C45、A24；C18；复核 B |
| 2026-10-03 | 三段式按 A84 登记（3.6 先落库、3.7 先外调）；换绑保留当前会话（A81）；协议 PDF 地址 30 分钟（A125）；待确认删去已裁决的三条（原 1、3、6），其余重新编号 | A81、A84、A85、A125 |
| 2026-10-03 | 路线图切片：退出登录 `none` 并补 `portal_session`；协议计数 `contract.read`；发码去掉 `contact_phone` 与 M:ProfileCert；换绑摘要改为保留当前会话；`idempotentBy` 改数组；补 3.2、3.7、3.11 的迁移与涉及的表；清掉已裁决的“待主负责人定” | A43、A48、A49、A53、A81；xdoc（本文作者） |

**第三轮**（2026-10-03；处理第十二节裁决 A127–A146、`review/r3-in-m01-account.md` 与公共结构核对）：

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 限流：3.1 改挂 `m.login.silent`，3.2 改挂 `m.login.phone`（清单 `rateLimit`、切片备注同步）；本文无签发类接口，不涉及 `m.sign` | A130；C68 |
| 2026-10-03 | 3.5 文本检测不可用一律拒收（503 `PROVIDER_UNAVAILABLE`，不写库），删去“补检登记前的过渡做法”；`CONSENT_REQUIRED` 的 `details` 写明已在 C27 登记 | A137；A131；C27、C87 |
| 2026-10-03 | `EntityBrief` 改为引用 m02-tenant 2.2，不再重复定义（清单移出 `schemas`，记入 `externalSchemas`） | A132；C87 |
| 2026-10-03 | `DeletionBlockerKind` 的 `order_open` 改名 `open_order`；3.11 写明六项计数的提供方：`billing.deletionGuard`（m07）、`order.countOpenOrdersByEntity`（m04）、m05 第 1.2 节的 `release_online` | A134；m04、m05、m07 的请求 |
| 2026-10-03 | 加入场景的同意只由 3.2（`member_join`）写，`m.invitation.accept` 不收同意，已登录缺同意者经 428 → 3.14 → 重放；`ConsentInput` 的用途改为登录、重新同意与 m04 订购（`consent`，`custom_license`）；`AGREEMENT_VERSION_STALE` 的共用范围去掉“加入” | m02、m04 的请求；m02-tenant.md:852；m04-mall-order.md:813 |
| 2026-10-03 | 3.2 空草稿让位：写明吊销老板在该主体下未吊销未过期的 `portal_session`（`membership_changed`）；3.11 主体关闭调用 m02 登记的“主体关闭联动”函数（与 a03 `admin.entity.close` 同一个） | m02 的请求；02-identity-tenant.md:531、697；`identity.I20` |
| 2026-10-03 | `ConsentRecord` 加 `bizTitle`（付款单标题，经 m07 `billing.describePaymentOrders` 批量取；店员视图剥离）；待确认 2 收窄为广告单号区间 | m07 的请求；m07-billing.md:48 |

**第四轮**（2026-10-03；处理 `review/r4-in-m01-account.md`）：

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 第 1 节与 2.7：`ConsentInput` 只用于登录、重新同意；订购（m04）与 m06 一样只提交 `agreementVersionId`，删去“m04 以 `consent: ConsentInput` 提交”的说法。`open_order` 改名、`EntityBrief` 记入 `externalSchemas` 上一轮已完成 | m06 的请求；m04-mall-order.md:823；A134 |
