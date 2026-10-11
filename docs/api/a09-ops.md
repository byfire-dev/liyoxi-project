# 后台：内容运营与通知配置

| 项 | 内容 |
| --- | --- |
| 范围 | 后台“运营”菜单：A:OpsHome（Banner、首页推荐位）、A:OpsMall（商城配置）、A:OpsAgreements（协议清单、版本、重新同意进度、同意记录检索）、A:OpsTemplates（订阅消息与短信两个页签：场景开关、补发短信、测试发送、近 7 天统计）、A:OpsNotice（公告与常见问题，V1.1）；A:Plans 的“调整与公告记录”（规则变更公告只读列表）；原型没画、按 05 第 4 节补的三个页面：发送日志与重发、通道配置（订阅消息模板槽位、短信模板）、场景总开关（“通知设置”） |
| 接口数 | 43（V1.0 34，V1.1 9） |
| 依据 | 数据模型 13 分组（`notify_scene`、`wx_template_slot`、`sms_template`、`notification`、`notification_delivery`、`agreement`、`agreement_version`、`agreement_consent`）、14 分组（`site_config_revision`、`home_banner`、`site_notice`、`param_value`），另读 03（`audit_log`、`staff`）、05（`drama`）、06（`file_object`、`file_ref`）、02（`entity`、`store`）分组；草案 d6 第 2.2、2.9、2.13、3.2–3.4、4.3、4.5、6、7.1 节；原型梳理 `proto-admin-e.md` 第 1.1–1.5 节；接口裁决 A1–A150（重点 A17、A18、A19、A21、A22、A23、A24、A30、A45、A47、A62、A70、A79、A84、A95、A105、A107、A125）；通用约定 C1–C87（重点 C10、C12、C16、C40、C43、C47、C51、C52、C53、C54、C60、C61、C66、C68、C83）；事件目录 x01-events-jobs |

本文路径一律省略 `/api/v1`。引用写法：`d6:963` 指 `docs/appendix/design/d6-notify-docs-data.md` 第 963 行；`13-notify-docs.md:764` 指 `docs/data-model/13-notify-docs.md` 第 728 行；`proto-admin-e.md:145` 指 `docs/appendix/research/proto-admin-e.md`；`design-spec.md:857` 指 `design/design-spec.md`。

## 1. 概览

本文是运营人员维护“商家看得到的内容”和“发给商家的通知”的接口。三类东西各有自己的生效方式：协议按版本到点生效（`docs.sweep` 只做簿记，读路径按 `effective_at` 实时解析）；首页推荐位与商城配置是整份 JSON 的“草稿 → 发布”；Banner 是带时间窗的行，保存即生效。通知配置只改开关与模板绑定，场景定义（触发、接收人、文案、深链）在代码注册表里，后台不能增删场景；注册表要满足的场景清单见 2.9。

全部接口 `x-auth = staff`。查看类不设权限点，用模块等级表达（C66）：本文的“模块 `ops` ≥ v / = e”指 `staff_role.module_levels` 里运营模块的等级（`ops` 只有 `n` / `v` / `e`）。只限超级管理员的操作用增补键 `sys.super_admin`（A45）。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `admin.agreement.list` | `GET /admin/agreements` | 协议清单（当前版本、待生效、草稿角标） | staff；`ops` ≥ v | none（查询） |
| `admin.agreement.get` | `GET /admin/agreements/{agreementKey}` | 协议详情：版本记录、当前正文、重新同意进度 | staff；`ops` ≥ v | none（查询） |
| `admin.agreement.agreementVersion.create` | `POST /admin/agreements/{agreementKey}/agreement-versions` | 新建版本草稿 | staff；`assert-in-handler`（`ops` = e；升主版本号另需 `sys.super_admin`） | required |
| `admin.agreementVersion.update` | `PATCH /admin/agreement-versions/{agreementVersionId}` | 编辑草稿 | staff；`ops` = e | required |
| `admin.agreementVersion.schedule` | `POST /admin/agreement-versions/{agreementVersionId}/schedule` | 保存为待生效 | staff；`assert-in-handler`（`ops` = e；公告期不足另需 `agreement.short_notice`） | required |
| `admin.agreementVersion.withdraw` | `POST /admin/agreement-versions/{agreementVersionId}/withdraw` | 撤回待生效版本 | staff；`ops` = e | required |
| `admin.agreementConsent.list` | `GET /admin/agreement-consents` | 同意记录检索 | staff；`ops` ≥ v | none（查询） |
| `admin.agreementConsent.get` | `GET /admin/agreement-consents/{agreementConsentId}` | 同意记录证据详情（只回脱敏值） | staff；`ops` ≥ v | none（查询） |
| `admin.siteNotice.list` | `GET /admin/site-notices` | 规则变更公告记录（只读） | staff；`assert-in-handler`（`ops` 或 `billing` ≥ v） | none（查询） |
| `admin.homeBanner.list` | `GET /admin/home-banners` | Banner 列表 | staff；`ops` ≥ v | none（查询） |
| `admin.homeBanner.summary` | `GET /admin/home-banners/summary` | Banner 计数与上限（页头“生效中 N 张 · 最多 5 张”） | staff；`ops` ≥ v | none（查询） |
| `admin.homeBanner.create` | `POST /admin/home-banners` | 新增 Banner | staff；`ops` = e | required |
| `admin.homeBanner.batchReorder` | `POST /admin/home-banners/reorder` | 调整轮播顺序 | staff；`ops` = e | required |
| `admin.homeBanner.update` | `PATCH /admin/home-banners/{homeBannerId}` | 编辑、启用、停用 Banner | staff；`ops` = e | required |
| `admin.siteConfig.get` | `GET /admin/site-configs/{configKey}` | 站点配置当前版与草稿 | staff；`ops` ≥ v | none（查询） |
| `admin.siteConfig.draft.replace` | `PUT /admin/site-configs/{configKey}/draft` | 保存草稿（整份覆盖） | staff；`ops` = e | required |
| `admin.siteConfig.publish` | `POST /admin/site-configs/{configKey}/publish` | 发布草稿 | staff；`ops` = e | required |
| `admin.siteConfig.revision.list` | `GET /admin/site-configs/{configKey}/revisions` | 版本记录 | staff；`ops` ≥ v | none（查询） |
| `admin.notifyScene.list` | `GET /admin/notify-scenes` | 消息模板页的订阅消息页签；通知设置页的其他场景 | staff；`ops` ≥ v | none（查询） |
| `admin.notifyScene.summary` | `GET /admin/notify-scenes/summary` | 场景页签计数 | staff；`ops` ≥ v | none（查询） |
| `admin.notifyScene.update` | `PATCH /admin/notify-scenes/{sceneKey}` | 外部通道开关、补发短信开关 | staff；`ops` = e | required |
| `admin.notifyScene.disable` | `POST /admin/notify-scenes/{sceneKey}/disable` | 关闭场景总开关 | staff；`sys.super_admin` | required |
| `admin.notifyScene.enable` | `POST /admin/notify-scenes/{sceneKey}/enable` | 打开场景总开关 | staff；`sys.super_admin` | required |
| `admin.notifyScene.testSend` | `POST /admin/notify-scenes/{sceneKey}/test-send` | 测试发送到本人登记的测试接收人 | staff；`ops` = e | required（三段式） |
| `admin.notificationDelivery.list` | `GET /admin/notification-deliveries` | 发送日志 | staff；`assert-in-handler`（`ops` 或 `service` ≥ v） | none（查询） |
| `admin.notificationDelivery.resend` | `POST /admin/notification-deliveries/{notificationDeliveryId}/resend` | 人工重发 | staff；`notify.resend`（增补） | required |
| `admin.wxTemplateSlot.list` | `GET /admin/wx-template-slots` | 订阅消息模板槽位 | staff；`sys.super_admin` | none（查询） |
| `admin.wxTemplateSlot.update` | `PATCH /admin/wx-template-slots/{slotKey}` | 绑定或更换模板 ID | staff；`sys.super_admin` | required |
| `admin.wxTemplateSlot.disable` | `POST /admin/wx-template-slots/{slotKey}/disable` | 人工停用槽位 | staff；`sys.super_admin` | required |
| `admin.wxTemplateSlot.enable` | `POST /admin/wx-template-slots/{slotKey}/enable` | 重新启用槽位 | staff；`sys.super_admin` | required |
| `admin.smsTemplate.list` | `GET /admin/sms-templates` | 短信模板：消息模板页的短信页签与通道配置页共用 | staff；`ops` ≥ v | none（查询） |
| `admin.smsTemplate.summary` | `GET /admin/sms-templates/summary` | 短信页签计数 | staff；`ops` ≥ v | none（查询） |
| `admin.smsTemplate.update` | `PATCH /admin/sms-templates/{templateKey}` | 绑定模板编号、签名，启停模板 | staff；`sys.super_admin` | required |
| `admin.smsTemplate.testSend` | `POST /admin/sms-templates/{templateKey}/test-send` | 按模板测试发送短信到本人登记的测试手机号 | staff；`ops` = e | required（三段式） |
| `admin.notice.list` | `GET /admin/notices` | V1.1：公告列表 | staff；`ops` ≥ v | none（查询） |
| `admin.notice.create` | `POST /admin/notices` | V1.1：新建公告草稿 | staff；`ops` = e | required |
| `admin.notice.update` | `PATCH /admin/notices/{noticeId}` | V1.1：编辑公告 | staff；`ops` = e | required |
| `admin.notice.publish` | `POST /admin/notices/{noticeId}/publish` | V1.1：立即或定时发布 | staff；`ops` = e | required |
| `admin.notice.unpublish` | `POST /admin/notices/{noticeId}/unpublish` | V1.1：下线公告 | staff；`ops` = e | required |
| `admin.faq.list` | `GET /admin/faqs` | V1.1：常见问题列表 | staff；`ops` ≥ v | none（查询） |
| `admin.faq.create` | `POST /admin/faqs` | V1.1：新增常见问题 | staff；`ops` = e | required |
| `admin.faq.update` | `PATCH /admin/faqs/{faqId}` | V1.1：编辑常见问题 | staff；`ops` = e | required |
| `admin.faq.delete` | `DELETE /admin/faqs/{faqId}` | V1.1：删除常见问题（待按 A7 核对） | staff；`ops` = e | required |

路由注册顺序（A8、C12）：`GET /admin/notify-scenes/summary` 先于 `/admin/notify-scenes/{sceneKey}`；`GET /admin/home-banners/summary`、`POST /admin/home-banners/reorder` 先于 `/admin/home-banners/{homeBannerId}`；`GET /admin/sms-templates/summary` 先于 `/admin/sms-templates/{templateKey}`；`/admin/site-configs/{configKey}/draft`、`/publish`、`/revisions` 是单例子资源与动作段，按字面段注册。

### 1.1 本文引用的权限点

接口文档引用的权限点必须在注册表里（A13）；注册表没有的列为“增补”，由汇总人并入 07 主文档附录与 d4 第 7.1 节待回写（A45）。“再验证”一栏是本文的建议，以注册表为准（A13）。

| 权限点 | 本文用在 | 默认角色（建议） | 再验证 | 待分配池 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `sys.super_admin` | 场景总开关（`admin.notifyScene.disable` / `enable`）；通道配置（`admin.wxTemplateSlot.*`、`admin.smsTemplate.update`）；新建协议版本时升主版本号 | 仅超级管理员 | 否（与 a01 第二轮的建议一致：键是共用的，不能只让某一类修改再验证；以注册表为准） | 否 | 增补（A45；a01 已登记同一键） |
| `agreement.short_notice` | 公告期不足 `agreement.announce_min_days` 时把《会员服务协议》《积分规则》的新版本保存为待生效 | 仅超级管理员 | 建议要求 | 否 | 增补（C66 已列；d6:1071） |
| `notify.resend` | 人工重发失败或跳过的外部通道投递 | 内容运营、客服 | 否 | 否 | 增补（C66 已列；d6:966） |
| `docs.consent.evidence` | 明文查看同意记录里的手机号与信用代码（经 a01 的 `admin.piiReveal.create`，`subjectType = agreement_consent`，`field` 为 `phone` / `uscc`，本文不定义接口）；a01 签发 `consent_digest` 分类的文件也用它 | 仅超级管理员（法务取证时临时授予） | 要求 | 否 | 增补（a01 提出，键名与默认值由本文确认；默认角色列第 6 节第 6 项） |

模块等级的默认值按 d7 第 5.2 节的菜单登记表与 PRD §3.3 矩阵：内容运营对 `ops` 为 `e`；超级管理员为 `e`；其他角色是否可看，由角色页配置。

## 2. 公共结构

### 2.1 本文通用口径

| 规则 | 内容 | 出处 |
| --- | --- | --- |
| 数据范围 | 本文的对象都是全局配置（`scope: global`），不按负责人过滤；同意记录与发送日志是排障与取证用的全局查询，同样不按数据范围过滤 | d4-identity.md:1306；14-config-data.md:16 |
| 分页 | 一律页码分页，响应为 a01 的 `AdminPage<T>`（`{ items, page, pageSize, total }`，C43、C87；发送日志按 A62）。本文的列表都不在 A78 的不分页清单里；协议、场景、槽位、模板的总数固定且很少，`pageSize` 上限按 C43 为 100，前端一次取完。Banner 会累积（不可删除），拖动排序只取未结束的（3.12） | C43；A62；A78 |
| 计数 | 页签与标题上的数字一律由 `summary` 给（A23、C83）：消息模板页“订阅消息 N”取 3.19、“短信 N”取 3.32（页签跨两个资源，各调各的）；OpsHome 页头“生效中 N 张 · 最多 5 张”取 3.34（上限作为页头上下文并列返回，A79） | A23；A79；C83 |
| “当前版本” | 协议的当前版本按时间实时解析：`agreement_version.status` ∈ (`pending`, `active`) 且 `effective_at <= now` 的最新一条；`status` 的翻转由 `docs.sweep` 每 5 分钟簿记，会滞后，接口不以它判断“是否已生效”，另给计算值 `displayStatus`。解析调 docs 模块的同一个函数（m01 3.12 说明里的全仓唯一口径），本文的 `currentVersion`、`pendingVersion`、`displayStatus`、重新同意进度都用它，不另写查询 | 13-notify-docs.md:703、766；m01 3.12 |
| 配置缓存 | 写接口在事务提交后把对应命名空间的缓存版本号加 1（`site`：Banner、站点配置；`agreement`：协议版本；`notify`：场景、槽位、短信模板）；失败不影响提交，各进程最迟 60 秒后自行重读。商家端的通知设置页 `m.notifySetting.list`（m08）读同一份 `notify_scene`、`wx_template_slot` 配置，本文的修改在缓存刷新后直接体现在那里 | d6:1776-1797；m08 的请求 |
| 审计 | 写接口同事务写一条 `ops` 流审计（`audit_log.stream = 'ops'`）。本文新登记三个类别：`ops_config`（Banner、站点配置）、`agreement`（协议版本）、`notify_config`（场景、槽位、短信模板、测试发送、人工重发），由汇总人列入 07 主文档的待回写清单（A107）。自然键对象写 `audit_log.target_key`（场景键、槽位键、模板键），uuid 对象写 `audit_log.target_id` | 03-staff-authz-audit.md:558-600；14-config-data.md:1056；A107 |
| 参数 | `home.banner.max_active`（默认 5）、`agreement.announce_min_days`（默认 30）、`notify.window.start` / `end`（默认 08:00、21:00）、`notify.test_recipients`（测试接收人，结构见 3.23；A107 列为补登的参数键）；读当前值，库里没有取代码默认值 | 14-config-data.md:297-302；d6:1550、1554；A107 |
| 时间 | 时刻输出 UTC `Z`；“近 7 天”“今日”按北京时间切分 | C34、C35 |
| 文件 | 请求与响应只出现 `fileId`；上传经 a01 的 `admin.file.create` → `admin.file.complete`，业务接口只接受 `file_object.status = 'stored'` 的文件；文件不可用一律返回 `FILE_NOT_USABLE`（m03 定义，46001），`details.reason` 按 m03 的开放枚举取值：本文只用 `not_stored`（不是 `stored`）、`category_mismatch`（分类不符）、`ext_mismatch`（扩展名不对，协议的 Word 与 PDF） | C41、C59；m03 第 5 节 |
| 结果脱敏 | 返回签名地址的 `required` 写接口（Banner 的新增、排序、编辑，3.11–3.13）按 C50 登记 `x-redact-on-replay`：幂等记录里的 `imageUrl` 置空，同键重放时为 `null`，`data` 带 `replayed: true`。本文其他写接口的响应没有签名地址、令牌或明文个人信息（测试发送只回脱敏目标），不需要脱敏 | A80；A124；C50 |

### 2.2 小结构

`StaffBrief`：引用 a01 第 2.2 节的后台全仓共用员工摘要（`staffId`、`staffNo`、`name`、`roleKey`、`isLead`、`status`，来自 `staff`），本文不另定结构（初稿的 `StaffRef` 按 a01 的请求并入）。本文各处的 `createdBy`、`updatedBy`、`publishedBy`、`withdrawnBy` 都是它，取各表的 `*_by_staff_id` 关联 `staff`。

`SignedUrl`：引用 a01 的公共结构 `{ url, expiresAt }`（`url` 不可空，整个对象可空，C60、C87），本文不另定义。

`AdminPage<T>`：引用 a01 的后台页码分页响应 `{ items: T[], page, pageSize, total }`（C43、C87，A132）。本文所有页码分页列表的 `data` 都是它，不另起 `XxxPage` 结构名。

`AgreementFileBrief`（协议版本的源文件与 PDF；初稿名 `FileBrief`，为避开 a04 的同名结构改名，字段名与 a01 `AdminFileView`、a04 `DramaFileBrief` 一致用 `originalName`；是否合并成全仓共用的文件摘要由主负责人定）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `fileId` | string(uuid) | 是 | 文件 id | `file_object.id` |
| `originalName` | string \| null | 是 | 原始文件名，版本记录与“当前版本正文”的文件名取它 | `file_object.original_name` |
| `sizeBytes` | string(bigint) \| null | 是 | 字节数 | `file_object.size_bytes` |
| `mime` | string \| null | 是 | 规范类型 | `file_object.mime` |

### 2.3 协议：`AgreementListItem`、`AgreementVersionItem`、`AgreementDetail`

`AdminAgreementVersionBrief`（列表角标用；初稿名 `AgreementVersionBrief`，与 m01 的同名结构字段不同，按 A132、A150 后台一侧加 `Admin` 前缀）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `agreementVersionId` | string(uuid) | 是 | 版本 id | `agreement_version.id` |
| `versionLabel` | string | 是 | `v{major}.{minor}`，如 `v1.1` | `agreement_version.major`、`agreement_version.minor` |
| `effectiveAt` | string(date-time) \| null | 是 | 生效时间；草稿可空 | `agreement_version.effective_at` |

`AgreementListItem`（`admin.agreement.list` 的元素）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `agreementKey` | string | 是 | 协议键 | `agreement.key` |
| `name` | string | 是 | 协议名称（带书名号） | `agreement.name` |
| `subjectKind` | enum(`AgreementSubjectKind`) | 是 | 同意主体 | `agreement.subject_kind` |
| `consentMode` | enum(`AgreementConsentMode`) | 是 | 同意方式 | `agreement.consent_mode` |
| `scenes` | array<enum(`AgreementScene`)> | 是 | 落同意记录的签署场景 | `agreement.scenes` |
| `signSceneLabel` | string | 是 | “签署场景”一栏，如“首次登录时勾选同意” | `agreement.sign_scene_label` |
| `audienceLabel` | string | 是 | “适用对象”一栏，如“全部用户” | `agreement.audience_label` |
| `sinceVersion` | enum(`ProductVersion`) | 是 | 起始产品版本；`V1.1` 时画板打“V1.1”标记 | `agreement.since_version` |
| `currentVersion` | `AdminAgreementVersionBrief` \| null | 是 | 当前版本（2.1“当前版本”）；没有已生效版本为 `null`（“尚未发布”） | `agreement_version` 实时解析 |
| `pendingVersion` | `AdminAgreementVersionBrief` \| null | 是 | `status = 'pending'` 且 `effective_at > now` 的版本（“v1.2 待生效”角标）；至多一个（`uq_agreement_version_one_pending`） | `agreement_version` |
| `draftVersion` | `AdminAgreementVersionBrief` \| null | 是 | 草稿（“v1.2 草稿”角标，“编辑草稿 v1.2”按钮）；至多一个（`uq_agreement_version_one_draft`） | `agreement_version` |

`AgreementVersionItem`（版本记录的一行；新建、编辑、保存为待生效、撤回的响应也用它）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `agreementVersionId` | string(uuid) | 是 | 版本 id | `agreement_version.id` |
| `agreementKey` | string | 是 | 所属协议 | `agreement_version.agreement_key` |
| `major` / `minor` | integer | 是 | 主、次版本号 | `agreement_version.major`、`agreement_version.minor` |
| `versionLabel` | string | 是 | `v{major}.{minor}` | 计算 |
| `status` | enum(`AgreementVersionStatus`) | 是 | 簿记状态 | `agreement_version.status` |
| `displayStatus` | enum(`AgreementVersionDisplayStatus`) | 是 | 页面显示的状态：草稿、待生效、生效中、已失效、已撤回。按时间实时算：`pending` 且已到 `effective_at` 显示为 `active`；被它取代、但簿记尚未翻转的 `active` 显示为 `superseded` | 计算（2.1） |
| `effectiveAt` | string(date-time) \| null | 是 | 生效时间；草稿可空（版本记录显示“—”） | `agreement_version.effective_at` |
| `summary` | string \| null | 是 | 变更摘要（≤60 字）；草稿可空 | `agreement_version.summary` |
| `isReconsentRequired` | boolean | 是 | 是否需要用户重新同意（“需要 / —”） | `agreement_version.is_reconsent_required` |
| `isLegalApproved` | boolean | 是 | 是否已勾选“正文已经法务审定” | `agreement_version.is_legal_approved` |
| `sourceFile` | `AgreementFileBrief` \| null | 是 | Word 源文件 | `agreement_version.source_file_id` → `file_object` |
| `pdfFile` | `AgreementFileBrief` \| null | 是 | PDF 下载版（证据基准）；“下载当前版本”用它的 `fileId` 调 a01 的 `admin.file.downloadUrls` | `agreement_version.pdf_file_id` → `file_object` |
| `hasContentHtml` | boolean | 是 | 是否有展示版（只传 PDF 时为假，小程序改为打开 PDF） | `agreement_version.content_html` 非空 |
| `contentSha256` | string \| null | 是 | PDF 的 SHA-256；草稿可空 | `agreement_version.content_sha256` |
| `siteNoticeId` | string(uuid) \| null | 是 | `member`、`points` 的规则变更公告 | `agreement_version.site_notice_id` |
| `shortNoticeReason` | string \| null | 是 | 公告期不足时填的原因 | `agreement_version.short_notice_reason` |
| `expectedConsents` | integer \| null | 是 | 生效时的应同意人数快照 | `agreement_version.expected_consents` |
| `activatedAt` | string(date-time) \| null | 是 | 簿记翻转为生效中的时间 | `agreement_version.activated_at` |
| `createdBy` | `StaffBrief` | 是 | 新建人 | `agreement_version.created_by_staff_id` |
| `publishedBy` | `StaffBrief` \| null | 是 | 保存为待生效的人，即版本记录里的“发布人”；草稿为空（页面对草稿显示 `createdBy`） | `agreement_version.published_by_staff_id` |
| `lockVersion` | integer | 是 | 乐观锁；草稿编辑（3.4）与保存为待生效（3.5，A105）时带回 | `agreement_version.lock_version` |
| `createdAt` / `updatedAt` | string(date-time) | 是 | | `agreement_version.created_at`、`agreement_version.updated_at` |
| `actions` | array<enum(`AgreementVersionAction`)> | 是 | 当前员工此刻可执行的动作（C16）：草稿 `edit`、`schedule`；待生效且距生效超过 10 分钟 `withdraw` | 计算 |

`AgreementDetail`（`admin.agreement.get`）：`AgreementListItem` 的全部字段，另加：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `versions` | array<`AgreementVersionItem`> | 是 | 全部版本，按 `major`、`minor` 倒序；已撤回的排在同版本号的新草稿之后 | `agreement_version` |
| `currentContentHtml` | string \| null | 是 | 当前版本的展示版 HTML（“当前版本正文”）；没有当前版本或只传了 PDF 时为 `null` | 当前版本的 `agreement_version.content_html` |
| `draftContentHtml` | string \| null | 是 | 草稿的展示版 HTML，弹层里“小程序展示效果”预览用 | 草稿的 `agreement_version.content_html` |
| `reconsentProgress` | `ReconsentProgress` \| null | 是 | 重新同意进度；只对用户级协议（`agreement.subject_kind = 'user'`）、当前版本 `is_reconsent_required` 为真、簿记已翻转为 `active`（有 `expected_consents`）且不是该协议第一版时给出，其余为 `null` | 见下 |

`ReconsentProgress`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `agreementVersionId` | string(uuid) | 是 | 统计的版本（即当前版本） | `agreement_version.id` |
| `versionLabel` | string | 是 | 标题“v1.1 重新同意进度” | 计算 |
| `consentedCount` | integer | 是 | 已同意人数：该版本同意记录的不同 `merchant_user_id` 数 | `agreement_consent`（走 `ix_agreement_consent_agreement_version_id`） |
| `expectedCount` | integer | 是 | 应同意人数（进度条分母） | `agreement_version.expected_consents` |
| `ratioBp` | integer(万分比) | 是 | `consentedCount ÷ expectedCount`，封顶 10000；分母为 0 时为 10000 | 计算 |

“与《隐私政策》v1.1 合并弹窗；未同意的用户下次登录时须先同意”这句说明由前端按 `subjectKind = user` 固定文案拼出，不进接口。

### 2.4 同意记录：`AgreementConsentItem`、`AgreementConsentDetail`

`AgreementConsentItem`（`admin.agreementConsent.list` 的元素）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `agreementConsentId` | string(uuid) | 是 | 同意记录 id | `agreement_consent.id` |
| `consentNo` | string(bigint) | 是 | 同意记录编号（授权书上印的也是它） | `agreement_consent.seq` 的十进制字符串（C33） |
| `agreementKey` | string | 是 | 协议键 | `agreement_consent.agreement_key` |
| `agreementName` | string | 是 | 协议名称 | `agreement.name` |
| `agreementVersionId` | string(uuid) | 是 | 同意的版本 | `agreement_consent.agreement_version_id` |
| `versionLabel` | string | 是 | `v{major}.{minor}` | 关联 `agreement_version` |
| `scene` | enum(`AgreementScene`) | 是 | 签署场景 | `agreement_consent.scene` |
| `method` | enum(`AgreementConsentMethod`) | 是 | 同意方式 | `agreement_consent.method` |
| `merchantUserId` | string(uuid) | 是 | 操作人 | `agreement_consent.merchant_user_id` |
| `phoneMask` | string | 是 | 当时的登录手机号脱敏串；明文经 `admin.piiReveal.create`（`subjectType = agreement_consent`，`field = phone`，权限点 `docs.consent.evidence`） | `agreement_consent.phone_mask` |
| `operatorNameMask` | string \| null | 是 | 经办人称呼脱敏串 | `agreement_consent.operator_name_mask` |
| `role` | enum(`MerchantRole`) \| null | 是 | 当时的商家角色；首次登录为空 | `agreement_consent.role` |
| `entityId` | string(uuid) \| null | 是 | 主体；用户级协议为空 | `agreement_consent.entity_id` |
| `entityName` | string \| null | 是 | 当时的主体名称快照 | `agreement_consent.entity_name` |
| `usccMask` | string \| null | 是 | 当时的信用代码脱敏串；明文经 `admin.piiReveal.create`（`field = uscc`） | `agreement_consent.uscc_mask` |
| `storeId` | string(uuid) \| null | 是 | 下单门店 | `agreement_consent.store_id` |
| `storeName` | string \| null | 是 | 门店当前名称（不是快照） | `store.name` |
| `bizType` | enum(`AgreementConsentBizType`) \| null | 是 | 关联单据类型 | `agreement_consent.biz_type` |
| `bizId` | string(uuid) \| null | 是 | 关联单据 id，前端据此跳付款单、订购单、广告详情 | `agreement_consent.biz_id` |
| `bizNo` | string \| null | 是 | 关联单据号快照 | `agreement_consent.biz_no` |
| `consentedAt` | string(date-time) | 是 | 同意时间 | `agreement_consent.consented_at` |

一行是一条同意记录（m01 的 `SignedAgreementItem` 是一行一份协议，已改名避开本结构，C74）。协议信息保留平铺的 `agreementKey` + `agreementName`，不改为嵌套的 `agreement { agreementKey, name }`：后台表格按列显示与筛选，平铺即可；`agreementName` 取 `agreement.name`，与 m01 的 `name` 同源（m01 的请求）。`consentNo`、`versionLabel` 的写法与 m01 的 `ConsentRecord` 一致。

`AgreementConsentDetail`（`admin.agreementConsent.get`）：`AgreementConsentItem` 的全部字段，另加：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `contentSha256` | string | 是 | 同意时该版本 PDF 的 SHA-256 | `agreement_consent.content_sha256` |
| `isContentHashConsistent` | boolean | 是 | 与版本行的 `content_sha256` 是否一致（写入时触发器已核对，这里是展示用的复核） | 比对 `agreement_version.content_sha256` |
| `appid` | string \| null | 是 | 当时登录的小程序 appid | `agreement_consent.appid` |
| `hasOpenidSnapshot` | boolean | 是 | 是否留有 openid 的 HMAC 快照（HMAC 本身不出接口） | `agreement_consent.openid_hmac` 非空 |
| `ipMask` | string | 是 | 来源 IP 脱敏（IPv4 保留前两段，IPv6 保留前 4 组）；原值只在审计取证时由数据库直接导出 | `agreement_consent.ip` 脱敏 |
| `userAgent` | string \| null | 是 | User-Agent | `agreement_consent.user_agent` |
| `device` | object（`ConsentDevice`） | 是 | 设备快照：`{ model?, system?, wechatVersion?, sdkVersion?, appVersion? }`，取不到的键省略 | `agreement_consent.device_snapshot`（13-notify-docs.md:1141） |
| `requestId` | string | 是 | 请求号，与访问日志关联 | `agreement_consent.request_id` |
| `revealableFields` | array<enum(`ConsentRevealField`)> | 是 | 可经 `admin.piiReveal.create` 查看明文的字段：`phone` 总有；`uscc` 在有信用代码快照时有。当前员工没有 `docs.consent.evidence` 时为 `[]` | 计算 |
| `createdAt` | string(date-time) | 是 | 落库时间 | `agreement_consent.created_at` |

### 2.5 规则变更公告：`SiteNoticeItem`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `siteNoticeId` | string(uuid) | 是 | 公告 id | `site_notice.id` |
| `kind` | enum(`SiteNoticeKind`) | 是 | 公告类型（被公告的变更表名） | `site_notice.kind` |
| `refId` | string(uuid) | 是 | 被公告的变更：`plan_revision.id`、`billing_param.change_id` 或 `agreement_version.id` | `site_notice.ref_id` |
| `title` | string | 是 | 标题（“专业版套餐调整公告”） | `site_notice.title` |
| `summary` | string | 是 | 摘要 | `site_notice.summary` |
| `summaryNoPrice` | string \| null | 是 | 不含价格数字的摘要；协议版本的公告为空（没有价格），消费方取 `summary`（13-notify-docs.md:150；m04 公告条同此回落） | `site_notice.summary_no_price` |
| `effectiveAt` | string(date-time) | 是 | 规则生效时刻 | `site_notice.effective_at` |
| `announcedAt` | string(date-time) | 是 | 公告时刻 | `site_notice.announced_at` |
| `leadDays` | integer | 是 | 公告期天数 | `site_notice.lead_days` |
| `shortNoticeReason` | string \| null | 是 | 公告期不足的原因（只来自协议版本） | `site_notice.short_notice_reason` |
| `link` | object `{ route: string, params?: object }` | 是 | 商家端深链 | `site_notice.link` |
| `isBarEnabled` | boolean | 是 | 是否进首页公告条。全仓布尔字段对 `*_enabled` 列统一加 `is` 前缀（C39；本文的 `isEnabled`、`isExtEnabled` 同此），a07 公告请求体里的 `barEnabled` 请同名改为 `isBarEnabled`（见 `cross_doc`） | `site_notice.bar_enabled` |
| `status` | enum(`SiteNoticeStatus`) | 是 | 已公告 / 已撤回 | `site_notice.status` |
| `displayState` | enum(`SiteNoticeDisplayState`) | 是 | 套餐页“调整与公告记录”的状态：`withdrawn` 已撤销；`announced` 且 `effective_at > now` 为 `scheduled` 待生效；其余 `effective` 已生效 | 计算 |
| `createdBy` | `StaffBrief` | 是 | 保存变更的员工 | `site_notice.created_by_staff_id` |
| `withdrawnBy` | `StaffBrief` \| null | 是 | 撤回人 | `site_notice.withdrawn_by_staff_id` |
| `withdrawnAt` | string(date-time) \| null | 是 | 撤回时间 | `site_notice.withdrawn_at` |
| `createdAt` | string(date-time) | 是 | | `site_notice.created_at` |

### 2.6 Banner：`HomeBannerItem`、`BannerJumpTarget`

`BannerJumpTarget`（按 `jumpKind`，14-config-data.md:1117-1126）：

| `jumpKind` | 结构 | 校验（新增、编辑时） |
| --- | --- | --- |
| `drama` | `{ dramaId: string(uuid) }` | 短剧存在、在架且可订：`content.getOrderability` 的 `visible` 为真，与 a04 `licenseFlag = orderable` 同口径（未上架、已停止订购、授权已到期都不行）。选剧下拉用 a04 的 `admin.drama.list?isOrderable=true&q=`（a04 的请求）。数据模型 14 分组写的是 `CatalogRefPort.areListed`（只看在架），端口需补可订判定（见 `cross_doc`） |
| `mall` | `{ categoryKey: string }` | 当前已发布的商城配置（`site_config_revision`，`config_key = 'mall'`）里有这个分类 `key`（分类 key 发布后不变，2.7） |
| `page` | `{ route: string, params?: object }` | `route` 是商家端深链路由表（`DeepLink`，13-notify-docs.md:1139）里允许作为 Banner 落地页的键，`params` 按该路由的 schema |
| `none` | `null` | — |

`HomeBannerItem`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `homeBannerId` | string(uuid) | 是 | Banner id | `home_banner.id` |
| `title` | string | 是 | 标题，1–30 字，后台识别用 | `home_banner.title` |
| `imageFileId` | string(uuid) | 是 | 图片文件 | `home_banner.image_file_id` |
| `imageUrl` | `SignedUrl` \| null | 是 | 缩略图地址（随数据返回，30 分钟对齐窗口，C60、C61）；写接口（3.11–3.13）同键重放时为 `null`（结果脱敏，A80、C50） | 按 `image_file_id` 现签 |
| `jumpKind` | enum(`BannerJumpKind`) | 是 | 跳转类型 | `home_banner.jump_kind` |
| `jumpTarget` | `BannerJumpTarget` | 是 | 跳转目标 | `home_banner.jump_target` |
| `jumpTargetLabel` | string \| null | 是 | 列表“标题与跳转”一栏的目标说明，如“商城分类 · 都市”“短剧详情 · 《巷口那家店》”“小程序页面 · 选择套餐”；`none` 为 `null`。引用已失效时带“（已失效）” | 计算：短剧取 `drama.title`；分类取已发布商城配置里分类的 `name`；页面取深链路由表的中文名 |
| `startAt` | string(date-time) | 是 | 开始时间 | `home_banner.start_at` |
| `endAt` | string(date-time) \| null | 是 | 结束时间；空为“长期有效” | `home_banner.end_at` |
| `isEnabled` | boolean | 是 | 是否启用 | `home_banner.is_enabled` |
| `position` | integer | 是 | 轮播顺序，从 0 起 | `home_banner.position` |
| `displayState` | enum(`BannerDisplayState`) | 是 | 派生状态：`disabled` 已停用；启用且 `now < start_at` 为 `scheduled` 已排期；启用且 `start_at ≤ now < coalesce(end_at, ∞)` 为 `live` 生效中；其余 `ended` 已结束 | 计算（14-config-data.md:446-453） |
| `clickCount` | integer \| null | 是 | 点击数：埋点事件 `banner_click` 中 `props.homeBannerId` 等于本行的条数（全部时间）；`scheduled` 为 `null`（页面显示“—”）。缓存 5 分钟。依赖：m08 已登记 `banner_click` 的属性 `{ homeBannerId: uuid }`（m08 2.11），m04 `m.home.get` 的 Banner 元素同名返回 `homeBannerId`，端上按它上报 | 聚合 `analytics_event`（`analytics_event.name = 'banner_click'`） |
| `lockVersion` | integer | 是 | 乐观锁 | `home_banner.lock_version` |
| `createdBy` | `StaffBrief` | 是 | 创建人 | `home_banner.created_by_staff_id` |
| `updatedBy` | `StaffBrief` \| null | 是 | 最近修改人 | `home_banner.updated_by_staff_id` |
| `createdAt` / `updatedAt` | string(date-time) | 是 | | `home_banner.created_at`、`home_banner.updated_at` |
| `actions` | array<enum(`BannerAction`)> | 是 | `edit`；未结束时 `enable` 或 `disable`（“已结束的不可切换”，proto-admin-e.md:62） | 计算 |

“未结束”按时间窗判断，与启用状态无关：`end_at` 为空或 `end_at > now`。拖动排序的集合就是全部未结束的 Banner（含已停用的，3.12）。

`HomeBannerSummary`（`admin.homeBanner.summary`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `live` | integer | 是 | 生效中张数（页头“生效中 N 张”） | `home_banner` 按 `displayState` 计数 |
| `scheduled` | integer | 是 | 已排期张数 | 同上 |
| `ended` | integer | 是 | 已结束张数 | 同上 |
| `disabled` | integer | 是 | 已停用张数 | 同上 |
| `maxActive` | integer | 是 | 同时生效上限（页头“最多 5 张”；页头上下文，A79） | 参数 `home.banner.max_active` |

### 2.7 站点配置：`SiteConfigView`

内容的 schema 按 `configKey` 二选一，键与上限见 14-config-data.md:1095-1115（`MallConfig`、`HomeRecommendConfig`，`packages/contract` 的 Zod schema）：

| `configKey` | 内容 schema | 要点 |
| --- | --- | --- |
| `mall` | `MallConfig`：`categories[]`（≤10 个，元素 `MallCategory` 见下）、`hotWords[]`（≤8 个，每个 ≤8 字，不重复）、`filters`（`genre`、`industry`、`episodes`、`price` 四个开关与 `episodeBands`、`priceBands`，分档元素 `MallBand` 见下）、`sorts[]`（`MallSortKey`，至少 1 个）、`defaultSort`（须在 `sorts` 里）、`weights`（`heat`、`sales30d`、`freshness`、`manual`，整数，合计 100） | `manual` 权重对应 `drama.manual_boost`；排序项“热度优先”的显示文案按 design-spec.md:854 改，不改取值 |
| `home_recommend` | `HomeRecommendConfig`：`recommendCount`（3–12）、`pins[]`（`industryCode`、`dramaId`，每个行业至多 1 部）、`defaultTab`（`hot` / `new`）、`newDays`（7–90） | `industryCode` 是字典 `industry` 的一级编码；`dramaId` 发布时校验在架且可订（与 Banner 同口径，2.6） |

`MallCategory`（`MallConfig.categories[]` 的元素）：

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `key` | string | `^[a-z][a-z0-9_]{0,23}$`（小写蛇形，≤24 字符）；同一份配置内唯一；`all` 只给固定分类用 | 分类标识。Banner 的商城分类跳转（2.6）与 m04 的商城筛选按它引用，**改名不换 key**；新分类的 key 由前端生成（如 `c_` 加 6 位随机串），服务端只校验格式与唯一，保存时不改写 |
| `name` | string | 1–4 字；同一份配置内不重名 | 分类名 |
| `genreCodes` | array<string> | `fixed = true` 时必须为 `[]`；其余至少 1 个、不重复 | 字典 `genre` 的编码；“全部”分类不对应具体题材，表示全部在架短剧（原型 OpsMall“全部已上架短剧”），以后新增的题材自动计入 |
| `visible` | boolean | `fixed = true` 时必须为 `true` | 是否在商城展示 |
| `fixed` | boolean | 恰好一个分类为 `true`，且它的 `key = all`、排第一 | 固定分类“全部”：不可隐藏、不可删除 |

`MallBand`（`filters.episodeBands[]`、`filters.priceBands[]` 的元素；与 m04 `m.mallConfig.get` 读取的结构一致，共用 `packages/contract` 的同一个 Zod schema）：

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `key` | string | 同 `MallCategory.key` 的格式；同一个分档数组内唯一 | 分档标识，m04 的查询参数 `episodeBand` / `priceBand` 取它 |
| `label` | string | 1–10 字；同一个分档数组内不重名 | 显示文案，如“30 集以内”“100 积分以下” |
| `min` | integer \| null | ≥0；为空表示不设下界 | 闭区间下界：集数档按 `drama.total_episodes`，积分价档按标价 P |
| `max` | integer \| null | ≥0；为空表示不设上界；`min`、`max` 不能都为空；都有时 `min ≤ max` | 闭区间上界 |

每个分档数组至多 6 档；对应开关（`filters.episodes`、`filters.price`）为 `true` 时至少 1 档。不校验分档之间是否重叠。

商城搜索未命中时的“按行业兜底推荐”不在 `MallConfig` 里：它是参数键 `catalog.search.industry_fallback`（`param_value`，布尔，默认开，A107 补登，A146 并入待回写清单；m04 `m.drama.search` 读取），在 a01 的参数页维护，不是 `flags.ts` 开关；原型 OpsMall 没有这个开关，商城配置页不提供（m04 的请求）。

`SiteConfigView`（`admin.siteConfig.get`；草稿保存与发布的响应也用它）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `configKey` | enum(`SiteConfigKey`) | 是 | 配置键 | `site_config_revision.config_key` |
| `published` | `SiteConfigRevisionView` | 是 | 当前已发布版（每个键恰有一个，迁移播种初始版，`config.N9`） | `status = 'published'` 的行 |
| `draft` | `SiteConfigDraftView` \| null | 是 | 草稿；没有为 `null` | `status = 'draft'` 的行 |
| `refs` | `SiteConfigRefs` | 是 | 页面要显示的引用信息与失效提示，按草稿（没有草稿则按已发布版）的内容现算 | 见下 |

`SiteConfigRevisionView`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `siteConfigRevisionId` | string(uuid) | 是 | 修订行 id | `site_config_revision.id` |
| `revNo` | integer | 是 | 修订号 | `site_config_revision.rev_no` |
| `status` | enum(`SiteConfigRevisionStatus`) | 是 | `published` / `archived` | `site_config_revision.status` |
| `content` | `MallConfig` \| `HomeRecommendConfig` | 是 | 整份内容 | `site_config_revision.content` |
| `note` | string \| null | 是 | 备注 | `site_config_revision.note` |
| `publishedAt` | string(date-time) | 是 | 发布时间（“最近发布：09-26 17:20”） | `site_config_revision.published_at` |
| `publishedBy` | `StaffBrief` \| null | 是 | 发布人；迁移播种的初始版为空 | `site_config_revision.published_by_staff_id` |

`SiteConfigDraftView`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `siteConfigRevisionId` | string(uuid) | 是 | 草稿行 id | `site_config_revision.id` |
| `baseRevNo` | integer \| null | 是 | 草稿基于的已发布修订号；与 `published.revNo` 不等时，前端提示“已有人发布过新版本” | `site_config_revision.base_rev_no` |
| `content` | 同上 | 是 | 草稿内容 | `site_config_revision.content` |
| `note` | string \| null | 是 | 备注 | `site_config_revision.note` |
| `lockVersion` | integer | 是 | 乐观锁 | `site_config_revision.lock_version` |
| `createdBy` | `StaffBrief` \| null | 是 | 草稿创建人 | `site_config_revision.created_by_staff_id` |
| `updatedAt` | string(date-time) | 是 | 最近保存时间 | `site_config_revision.updated_at` |

`SiteConfigRefs`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `categoryStats` | array<{ `key`, `dramaCount`: integer, `genreNames`: string[] }> | 是 | 只对 `mall`：每个分类的“短剧数”（在架且 `drama.genre_codes` 与分类 `genreCodes` 有交集的部数；“全部”为在架总数、`genreNames` 为 `[]`，页面显示“全部已上架短剧”）与“包含题材”的中文名；`home_recommend` 为 `[]` | `drama.status`、`drama.genre_codes`；`dict_item.name`（`dict_item.dict_type_key = 'genre'`） |
| `pins` | array<{ `industryCode`, `industryName`, `dramaId`, `dramaTitle`, `isOrderable`: boolean }> | 是 | 只对 `home_recommend`：置顶项的行业名与剧名（“餐饮 · 《面馆少东家》”），`isOrderable` 为在架且可订（2.6）；`mall` 为 `[]` | `dict_item.name`（`industry`）、`drama.title`；`content.getOrderability` |
| `invalidRefs` | array<`ConfigRefIssue`> | 是 | 引用已失效的项（题材编码不存在或已停用、置顶短剧不存在或不在架或不可订、行业编码不存在），后台标红提示；发布时同一套校验不通过即拒绝（3.16） | 计算 |
| `affectedBanners` | array<{ `homeBannerId`, `title`, `categoryKey` }> | 是 | 只对 `mall`：启用中且未结束、跳转到商城分类的 Banner 里，`categoryKey` 不在本内容里的（分类被删除）。不阻断发布，前端在发布前提示“发布后这 N 张 Banner 的跳转将失效”；`home_recommend` 为 `[]` | `home_banner`（`jump_kind = 'mall'`、`is_enabled`、未结束） |

`ConfigRefIssue`：`{ path: string（点分路径，如 "categories.2.genreCodes.0"）, code: string（失效的编码或短剧 id）, reason: enum(ConfigRefIssueReason) }`。

### 2.8 通知：场景、模板、投递

`NotifyStats7d`（近 7 天统计，按北京时间的“今天往前 7 个自然日”，结果缓存 5 分钟，d6:979）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `planned` | integer | 是 | 应发送：该通道的投递数，不含 `cancelled`、不含测试发送（`purpose = 'test'`） | `notification_delivery`（按 `ix_notification_delivery_channel_created_at`） |
| `sent` | integer | 是 | `notification_delivery.status = 'sent'` | 同上 |
| `noQuota` | integer \| null | 是 | 只对订阅消息：`skipped` 且 `notification_delivery.reason` ∈ (`no_quota`, `no_target`)；短信为 `null` | 同上 |
| `skipped` | integer | 是 | 其余 `skipped` | 同上 |
| `failed` | integer | 是 | `status = 'failed'` | 同上 |
| `successRateBp` | integer(万分比) \| null | 是 | 原型口径的成功率 = `sent ÷ planned`；`planned = 0` 为 `null` | 计算 |
| `reachRateBp` | integer(万分比) \| null | 是 | 只对订阅消息场景：订阅或短信任一 `sent` 的通知数 ÷ 通知数（d6:976 建议运营看它）；其余为 `null` | 计算（`notification` 按 `ix_notification_notify_scene_key_created_at`） |
| `computedAt` | string(date-time) | 是 | 统计时刻 | 计算 |

`NotifyPreview`（示例预览，用注册表里该场景的示例变量渲染，不读业务数据）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `channel` | enum(`NotifyChannel`) | 是 | 预览的通道：订阅消息页签为 `wx_subscribe`，短信页签为 `sms`，其他场景为 `inbox` | 计算 |
| `title` | string | 是 | 消息标题（订阅消息为模板标题，短信为场景名） | 注册表；订阅消息取 `wx_template_slot.title` |
| `fields` | array<{ `label`, `value` }> | 是 | 预览卡片的字段与示例值；短信为一项“短信内容” | 注册表的示例变量经 `wx()` / `sms()` 渲染 |
| `fieldMappings` | array<{ `label`, `expression` }> | 是 | “字段取值”：每个字段取什么（如“付款单号 → {付款单号}”） | 注册表 |
| `landingPage` | string \| null | 是 | 落地页中文名（“进入小程序查看（付款结果页）”）；短信为 `null` | 注册表的深链路由 |

`NotifySceneRow`（订阅消息页签与其他场景页签的一行）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `sceneKey` | string | 是 | 场景键 | `notify_scene.scene_key` |
| `name` | string | 是 | 场景名 | `notify_scene.name` |
| `audience` | enum(`NotifyAudience`) | 是 | 受众 | `notify_scene.audience` |
| `isSceneEnabled` | boolean | 是 | 场景总开关（关闭后站内也不发；只有超级管理员能改） | `notify_scene.scene_enabled` |
| `isExtEnabled` | boolean | 是 | 外部通道开关，即画板上的“启用”开关 | `notify_scene.ext_enabled` |
| `smsPolicy` | enum(`SmsPolicy`) | 是 | 短信策略 | `notify_scene.sms_policy` |
| `isSmsFallbackEnabled` | boolean | 是 | “补发短信”开关 = `sms_policy = 'fallback'` | 计算 |
| `canToggleSmsFallback` | boolean | 是 | “补发短信”开关可不可点：当前员工 `ops` = e，场景有订阅槽位与短信模板，且策略不是 `always` | 计算 |
| `smsNodes` | array<string> \| null | 是 | 允许短信的节点；`null` 为全部节点。画板“仅到期前 1 天”这类说明由它拼出 | `notify_scene.sms_nodes` |
| `sendWindow` | enum(`SendWindow`) | 是 | 发送时段 | `notify_scene.send_window` |
| `sendWindowText` | string | 是 | “08:00～21:00，超出时段顺延至次日 08:00”“立即发送”“定时发送”；时段取参数 `notify.window.start` / `end` | 计算 |
| `collapseWindowSec` | integer | 是 | 合并窗口（秒） | `notify_scene.collapse_window_sec` |
| `isManagerEscalationEnabled` | boolean | 是 | 未送达时是否转交付经理 | `notify_scene.manager_escalation_enabled` |
| `wxTemplateSlot` | object \| null | 是 | `{ slotKey, title, status, providerTemplateIdMask }`；没有订阅槽位为 `null`。`providerTemplateIdMask` 取前 8 位 + “…” + 后 4 位（画板“模板 ID kF3mS7wQ…xVbN”），未配置为 `null` | `notify_scene.wx_template_slot_key` → `wx_template_slot.slot_key`、`wx_template_slot.title`、`wx_template_slot.status`、`wx_template_slot.provider_template_id` |
| `smsTemplate` | object \| null | 是 | `{ templateKey, status, providerTemplateId }`；短信模板编号不脱敏（画板直接显示“SMS_20260402”） | `notify_scene.sms_template_key` → `sms_template.template_key`、`sms_template.status`、`sms_template.provider_template_id` |
| `triggerText` | string | 是 | 触发时机文案，按当前参数实时拼出（如“套餐到期前 7 天、3 天、1 天及到期当天 10:00”） | 注册表的后台元数据 + 参数 |
| `recipientText` | string | 是 | 接收人文案（“商家主账号”“老板及相关店员”“提交工单的用户”） | 注册表 |
| `preview` | `NotifyPreview` | 是 | 示例预览 | 见上 |
| `stats7d` | `NotifyStats7d` \| null | 是 | 订阅消息页签取 `wx_subscribe` 通道（经 `notification.notify_scene_key` 关联）；其他场景页签为 `null` | 见上 |
| `lockVersion` | integer | 是 | 乐观锁 | `notify_scene.lock_version` |
| `updatedBy` | `StaffBrief` \| null | 是 | 最近修改人；播种后没改过为空 | `notify_scene.updated_by_staff_id` |
| `updatedAt` | string(date-time) | 是 | | `notify_scene.updated_at` |
| `actions` | array<enum(`NotifySceneAction`)> | 是 | 取 C12 的词，与接口一一对应（C16）：`update`（`ops` = e，经 3.20）、`test_send`（`ops` = e，且场景有订阅槽位或短信模板，经 3.23）、`disable` / `enable`（`sys.super_admin`，按 `isSceneEnabled` 给其一，经 3.21 / 3.22；必达场景不给 `disable`）。“补发短信”开关可不可点另看 `canToggleSmsFallback` | 计算 |

`WxTemplateSlotItem`（通道配置页）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `slotKey` | string | 是 | 槽位键 | `wx_template_slot.slot_key` |
| `title` | string | 是 | 模板标题 | `wx_template_slot.title` |
| `providerTemplateId` | string \| null | 是 | 微信模板 ID（超级管理员看完整值） | `wx_template_slot.provider_template_id` |
| `fields` | array<{ `name`, `type`, `label` }> | 是 | 模板字段定义，与微信后台逐字一致 | `wx_template_slot.fields` |
| `expectedFields` | array<{ `sceneKey`, `sceneName`, `fieldNames`: string[] }> | 是 | 绑定在本槽位上的每个场景的 `wx()` 返回的字段名（绑定模板时据此核对） | 注册表；`notify_scene.wx_template_slot_key` |
| `status` | enum(`WxTemplateSlotStatus`) | 是 | 槽位状态 | `wx_template_slot.status` |
| `disabledReason` | enum(`WxSlotDisabledReason`) \| null | 是 | 停用原因 | `wx_template_slot.disabled_reason` |
| `failStreak` | integer | 是 | 字段类错误连续失败数（“连续失败数”） | `wx_template_slot.fail_streak` |
| `usedByScenes` | array<{ `sceneKey`, `name` }> | 是 | 用本槽位的场景 | `notify_scene` |
| `createdAt` / `updatedAt` | string(date-time) | 是 | | `wx_template_slot.created_at`、`wx_template_slot.updated_at` |
| `actions` | array<enum(`WxSlotAction`)> | 是 | `update`；`active` 时 `disable`；`disabled` 时 `enable` | 计算 |

`SmsTemplateItem`（一个短信模板及其用途；消息模板页的短信页签与通道配置页共用，3.30）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `templateKey` | string | 是 | 模板键 | `sms_template.template_key` |
| `label` | string | 是 | 显示名（“身份验证码”“资质审核结果”）；表里没有名称列，取代码登记表 | 契约登记表 `SMS_TEMPLATE_LABELS` |
| `kind` | enum(`SmsTemplateKind`) | 是 | 验证码类 / 通知类 | `sms_template.kind` |
| `status` | enum(`SmsTemplateStatus`) | 是 | 模板状态；短信页签的“启用”开关 = 是否 `disabled` | `sms_template.status` |
| `signName` | string \| null | 是 | 短信签名（“狸有戏”） | `sms_template.sign_name` |
| `providerTemplateId` | string \| null | 是 | 服务商模板编号，不脱敏（画板直接显示“SMS_20260402”） | `sms_template.provider_template_id` |
| `params` | array<{ `name`, `maxLen` }> | 是 | 有序变量定义（迁移播种，后台不改） | `sms_template.params` |
| `usedByScenes` | array<{ `sceneKey`, `name`, `smsPolicy`, `smsNodes` }> | 是 | 用这个模板的场景 | `notify_scene` 中 `sms_template_key` = 本模板的行 |
| `directPurposes` | array<enum(`DeliveryPurpose`)> | 是 | 用这个模板的直发用途：`verify_code` → `[verify_code, staff_activation]`（换绑手机号验证码；员工账号激活、重置的一次性激活码，d6:891；13-notify-docs.md:456-458）；`account_notice` → `[account_notice]`；`ops_alert` → `[ops_alert]`；其余为 `[]`。不含 `keepalive`、`test` | 注册表 |
| `triggerText` | string | 是 | 触发时机文案，如“更换手机号时；员工账号激活或重置时”（design-spec.md:857：不写“后台登录二次验证”）、“订阅消息未送达时补发（仅到期前 1 天）” | 注册表 + `usedByScenes` 的 `smsNodes` |
| `recipientText` | string | 是 | 如“操作人手机号”“商家主账号” | 注册表 |
| `sendWindowText` | string | 是 | 验证码类“不受发送时段限制”；通知类一律过时段（d6:663） | 计算 |
| `preview` | `NotifyPreview` | 是 | 短信内容示例与变量（`fields` 为一项“短信内容”，`fieldMappings` 为 `sms_template.params` 的变量） | 注册表的模板示例参数；`sms_template.params` |
| `stats7d` | `NotifyStats7d` | 是 | `channel = 'sms'` 且 `sms_template_key` = 本模板（含直发，不含测试发送） | `notification_delivery`（按 `ix_notification_delivery_sms_template_key_created_at`） |
| `lastOkAt` | string(date-time) \| null | 是 | 最近一次发送成功 | `sms_template.last_ok_at` |
| `createdAt` / `updatedAt` | string(date-time) | 是 | | `sms_template.created_at`、`sms_template.updated_at` |
| `actions` | array<enum(`SmsTemplateAction`)> | 是 | `update`、`enable` / `disable`：只对 `sys.super_admin` 给出（经 3.31），验证码类不给 `disable`；`test_send`：`ops` = e 且模板为 `active` / `suspect`（经 3.33） | 计算 |

`NotificationDeliveryItem`（发送日志的一行；人工重发的响应也用它）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `notificationDeliveryId` | string(uuid) | 是 | 投递 id | `notification_delivery.id` |
| `channel` | enum(`NotifyChannel`) | 是 | 通道 | `notification_delivery.channel` |
| `origin` | enum(`DeliveryOrigin`) | 是 | 来源 | `notification_delivery.origin` |
| `status` | enum(`DeliveryStatus`) | 是 | 投递状态 | `notification_delivery.status` |
| `reason` | enum(`DeliveryReason`) \| null | 是 | 终态非成功的原因 | `notification_delivery.reason` |
| `isDirect` | boolean | 是 | 是否直发 | `notification_delivery.is_direct` |
| `purpose` | enum(`DeliveryPurpose`) \| null | 是 | 直发用途 | `notification_delivery.purpose` |
| `resendNo` | integer | 是 | 重发序号 | `notification_delivery.resend_no` |
| `attemptNo` / `maxAttempts` | integer | 是 | 认领序号与上限 | `notification_delivery.attempt_no`、`notification_delivery.max_attempts` |
| `dueAt` | string(date-time) | 是 | 到期时间（已按时段顺延） | `notification_delivery.due_at` |
| `targetMasked` | string \| null | 是 | 脱敏后的目标（`138****5678`）；注销用户的行已清空 | `notification_delivery.target_masked` |
| `smsTemplateKey` | string \| null | 是 | 所用短信模板 | `notification_delivery.sms_template_key` |
| `providerMsgId` | string \| null | 是 | 服务商消息 id | `notification_delivery.provider_msg_id` |
| `errorCode` / `errorMsg` | string \| null | 是 | 发送调用的同步错误 | `notification_delivery.error_code`、`notification_delivery.error_msg` |
| `receiptStatus` | string \| null | 是 | 异步回执结果码 | `notification_delivery.receipt_status` |
| `receiptReportedAt` | string(date-time) \| null | 是 | 回执上报时间 | `notification_delivery.receipt_reported_at` |
| `sentAt` / `finishedAt` | string(date-time) \| null | 是 | 成功时间、进入终态时间 | `notification_delivery.sent_at`、`notification_delivery.finished_at` |
| `createdAt` | string(date-time) | 是 | 建行时间 | `notification_delivery.created_at` |
| `notification` | object \| null | 是 | 所属通知；直发为 `null`。`{ notificationId, sceneKey, sceneName, node, bizType, bizId, merchantUserId, staffId, entityId, storeId, createdAt }` | `notification.id`、`notification.notify_scene_key`（→ `notify_scene.name`）、`notification.node`、`notification.biz_type`、`notification.biz_id`、`notification.merchant_user_id`、`notification.staff_id`、`notification.entity_id`、`notification.store_id`、`notification.created_at` |
| `actions` | array<enum(`DeliveryAction`)> | 是 | `resend`：持 `notify.resend`，且本行满足重发条件（3.25） | 计算 |

### 2.9 通知场景清单（注册表契约）

场景的触发、接收人、文案、深链与补发策略在代码注册表（`packages/services/src/notify/registry.ts`），`notify_scene` 只存开关与通道绑定（13-notify-docs.md:90）。本节是注册表必须满足的契约，也是 x01 第 8 节待确认第 4 项（超时与客服待办类事件没有场景）的落点。规则：

- 触发一栏的事件名取 x01 事件目录（A95）；x01 里订阅者为 `notify.onEvent` 的事件都在下面两张表里有去处。“规则 Rn”是 d6 第 2.7 节的提醒规则（`source_rule` 派生，不经出站事件）；括号里是节点（`N0` 首发、`R1` 自动催办、`M` 人工催办、`T-1` 等）。
- 一个事件可以派发到多个场景（接收人不同，如 `service_ticket.created` 同时发 `s.kf_assigned` 与 `s.complaint_created`）；同一接收人对同一事件只收一条（E2）。
- 接收人由注册表的 `recipients()` 在派发时现算；“老板”= 主体当前的老板账号；店员只会收到门店、客服两类（d6:755）。
- 商家场景的“通道”写“订阅槽位 / 短信模板（默认策略，节点）”，`—` 为只发站内；带订阅槽位的才进消息模板页的订阅消息页签（3.18）。员工场景没有订阅与短信（`ck_notify_scene_staff_channels`），外部通道是企业微信应用消息，“铃铛”是后台站内消息 `staff_message`。
- 深链：商家写 `DeepLink` 的路由键（m08 2.1；参数按 m04 3.2 派生表的写法带对象 id 与 `storeId`）；员工写 `AdminLink` 的路由键（a02 的 `AdminRouteKey`）。
- “播种”是 13 分组已列的 32 行；“补登”是本文按其他文档的请求与 x01 订阅栏新登记的键，由 13 分组随注册表同批播种（只加行，不改表结构，13-notify-docs.md:152），默认 `ext_enabled = true`、`sms_policy = never`、`send_window = immediate`。播种前派发函数找不到场景行时只记日志、不建通知。新增、改名场景都按本节改契约并记入修订记录。
- 人工催办 `manual_reminder.sent` 按载荷 `scene` 映射到下表的场景派发，节点记 `M`（13-notify-docs.md:139）：`confirm_plan` → `m.plan_pending`，`confirm_sample` → `m.sample_pending`，`confirm_ad` → `m.ad_pending`，`golive` → `m.launch_remind`，`takedown`、`breach` → `m.offline_remind`，`patrol_fix` → `m.patrol_abnormal`，`renewal` → `m.plan_expiring`（x01 的请求）。

**商家场景**

| `sceneKey` | 名称 | 触发 | 接收人 | 站内分类 | 通道 | 深链 `route` | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `m.pay_success` | 付款成功 | `billing_order.paid` | 老板 | 套餐与积分 | `pay_result` / `generic_todo`（不发） | `payment.result` | 播种 |
| `m.order_submitted` | 订购成功 | `order.submitted` | 老板 | 订单 | `order_result` / `generic_todo`（不发） | `order.detail` | 播种 |
| `m.plan_pending` | 方案待确认 | `plan.pushed`；人工催办（M） | 老板 | 交付 | `service_progress` / `generic_todo`（不发） | `delivery.plan` | 播种 |
| `m.ad_pending` | 广告待确认 | `ad.version_pushed`（N0）；规则 R5（R1）；人工催办（M） | 老板 | 交付 | `service_progress` / `sample_pending`（补发，`R1`、`M`） | `ad.detail` | 播种 |
| `m.sample_pending` | 样片待确认 | `sample.pushed`（N0）；规则 R4（R1）；人工催办（M） | 老板 | 交付 | `service_progress` / `sample_pending`（补发，`R1`、`M`） | `delivery.sample` | 播种 |
| `m.delivered` | 成片已交付 | `package.delivered` | 老板 | 交付 | `service_progress` / `generic_todo`（补发） | `publish.task` | 播种 |
| `m.launch_remind` | 上线提醒 | 规则 R2；人工催办（M） | 老板 | 上线 | `todo_remind` / `launch_remind`（补发） | `publish.task` | 播种 |
| `m.verify_result` | 核验结果 | `launch.verified`、`launch.returned` | 老板 | 上线 | `review_result` / `generic_todo`（补发，策略函数只在“需补充”时补） | `publish.task` | 播种 |
| `m.plan_expiring` | 套餐到期提醒 | 规则 R1；人工催办（M） | 老板 | 套餐与积分 | `svc_expiry` / `plan_expiring`（补发，`T-1`） | `wallet.home` | 播种 |
| `m.offline_remind` | 下架提醒 | `takedown.created`；规则 R3；人工催办（M） | 老板 | 上线 | `todo_remind` / `offline_remind`（补发，`T-1`） | `offline.task` | 播种 |
| `m.ticket_reply` | 工单回复 | `service_ticket.replied`、`service_ticket.result_submitted`；`service_ticket.closed`（员工关闭，`closeReason` ≠ `withdrawn`；a08 的请求） | 提交人（`service_ticket.submitter_user_id`）；后台登记、没有提交人的发给门店老板 | 客服 | `ticket_reply` / `generic_todo`（不发） | `ticket.detail` | 播种 |
| `m.invoice_issued` | 发票已开具 | `invoice.issued` | 老板 | 订单 | `invoice_result` / `generic_todo`（不发；另发邮件） | `invoice.detail` | 播种 |
| `m.points_changed` | 积分变动 | `billing.points.granted`（月度发放）、`billing.points.purchased`、`billing.points.returned`、`billing.points.adjusted` | 老板 | 套餐与积分 | `quota_change` / `generic_todo`（不发） | `points.ledger` | 播种 |
| `m.review_result` | 资质审核结果 | `store.qualification.approved`、`store.qualification.rejected`；`store.qualification_change.submitted`、`approved`、`rejected`（13-notify-docs.md:154 列为待接，本文接上） | 老板 | 审核 | `review_result` / `review_result`（补发） | `profile.review` | 播种 |
| `m.member_changed` | 成员变动 | `entity_member.joined`、`entity_member.removed`、`entity_member.stores_changed`、`entity_member.promoted`（老板更换，通知新旧老板） | 老板及相关店员（按事件） | 门店 | `member_change` / `generic_todo`（不发） | `store.members` | 播种 |
| `m.asset_feedback` | 素材反馈 | `asset.adopted`、`asset.reviewed`（只 `need_reshoot`、`need_portrait_auth`）、`asset.demand_created` | 上传人（只商家上传的）；素材需求按 `notify_scope` | 门店 | `asset_feedback` / `generic_todo`（不发） | `asset.detail`；需求为 `asset.demand` | 播种 |
| `m.refund_result` | 退款结果 | `refund.completed`、`refund.rejected` | 老板 | 套餐与积分 | `refund_result` / `generic_todo`（不发） | `payment.detail` | 播种 |
| `m.rule_change_notice` | 规则变更公告 | `site_notice.announced` | 全部正常主体的老板 | 套餐与积分 | —（站内必达，不可关闭，第 6 节第 2 项） | 取 `site_notice.link` | 播种 |
| `m.rule_change_withdrawn` | 调整已取消 | `site_notice.withdrawn` | 同上 | 套餐与积分 | — | 取 `site_notice.link` | 补登 |
| `m.plan_activated` | 套餐已开通 | `billing.subscription.activated` | 老板 | 套餐与积分 | — | `wallet.home` | 补登（x01 3.7） |
| `m.plan_renewed` | 续费成功 | `billing.subscription.renewal_scheduled` | 老板 | 套餐与积分 | — | `wallet.home` | 补登（x01 3.7） |
| `m.plan_upgraded` | 套餐已升级 | `billing.subscription.upgraded` | 老板 | 套餐与积分 | — | `wallet.home` | 补登（x01 3.7） |
| `m.plan_extended` | 有效期延长 | `billing.subscription.resumed`、`billing.subscription.extended` | 老板 | 套餐与积分 | — | `wallet.home` | 补登（x01 3.7） |
| `m.points_captured` | 积分已扣减 | `billing.points.captured` | 老板 | 套餐与积分 | — | `points.ledger` | 补登（x01 3.7） |
| `m.points_expired` | 上期积分已清零 | `billing.points.expired` | 老板 | 套餐与积分 | — | `points.ledger` | 补登（x01 3.7） |
| `m.transfer_rejected` | 对公收款驳回 | `transfer.rejected` | 老板 | 套餐与积分 | — | `payment.detail` | 补登（d6:253） |
| `m.invoice_rejected` | 发票驳回 | `invoice.rejected` | 老板 | 订单 | — | `invoice.detail` | 补登（d6:253） |
| `m.store_review_submitted` | 新增门店已提交审核 | `store.qualification.submitted` | 老板 | 审核 | — | `profile.review` | 补登（d6:253） |
| `m.profile_proxy_edited` | 档案已代改 | `store.profile.changed`（只 `source = staff_proxy`） | 老板 | 门店 | — | `profile.review` | 补登（d6:253） |
| `m.channel_account_result` | 渠道账号核验结果 | `account.verified`、`account.abnormal` | 老板 | 上线 | — | `account.detail` | 补登（d6:253） |
| `m.patrol_abnormal` | 巡检异常 | `patrol.abnormal`、`patrol.recovered`；人工催办（M） | 老板 | 上线 | — | `publish.task` | 补登（d6:253） |
| `m.license_letter_updated` | 授权书已更新 | `license_letter.issued` | 老板 | 订单 | — | `order.detail`（授权书在订购单详情里） | 补登（d6:253） |
| `m.account_security` | 账号安全通知 | `merchant_user.wechat_bound`（新微信登录）、`merchant_user.phone_changed`（只站内） | 账号本人（账号级消息，不归属主体，13-notify-docs.md:156） | 门店 | 订阅槽位由 13 分组定（排除刚绑定的微信身份）/ `account_notice`（总是发，只对新微信登录） | 不带深链（落到消息中心） | 补登（13-notify-docs.md:156-158） |
| `m.order_progress` | 订单与交付进度 | `order.started`、`order.item.cancelled`、`order.item.refunded`、`order.item.terminated`、`order.item.went_live`、`order.item.live_revoked`、`order.item.usage_end_changed`、`order.item.launch_rescheduled`（新的约定上线日，a05 3.37）、`ad.returned`、`ad.cancelled`、`package.reissued`、`publish_list.updated`（只 `isAfterPush`）、`ticket.archived`、`launch.verify_revoked`、`takedown.checked`、`takedown.found_online`、`takedown.basis_reopened` | 老板 | 按事件：订单 / 交付 / 上线 | — | 按事件：`order.detail` / `ad.detail` / `publish.task` / `offline.task` | 补登（x01 订阅栏“通知商家”的其余事件） |
| `m.cart_price_changed` | 选剧单变价提示 | `pricing.drama_price_changed`（三种 `cause` 都发） | 选剧单（`cart_item`，`state ≠ invalid`）里有该剧的门店所属主体的老板；同一老板只收一条（E2） | 订单 | — | `cart.list`，`params = { storeId }`（取其中一个含该剧的门店；路由键待 m08 登记） | 补登（x01 的请求；原型调价 toast“选剧单中的商家将收到变价提示”，d1:717） |
| `m.refund_initiated` | 已发起原路退款 | `payment_exception.refund_requested` | 差异单所属主体的老板；孤儿收款（没有主体）不发 | 套餐与积分 | — | `payment.detail` | 补登（x01 的请求；原型对账页“已发起原路退款……已通知商家”） |

**员工场景**

| `sceneKey` | 名称 | 触发 | 接收人 | 企业微信 / 铃铛 | 深链 `route` | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| `s.work_ticket_assigned` | 交付工单分配 | `ticket.assigned`、`assignment.transferred`；`ticket.created`（待分配时） | 接收的交付经理；待分配时交付主管 | ✔ / ✔ | `delivery.ticket_detail`；改派为 `merchant.detail` | 播种 |
| `s.step_overdue` | 步骤超时 | `ticket.sla_breached`；`ad.sla_breached` | 当前负责人与主管；广告为剪辑师、交付经理与主管 | ✔ / ✔ | `delivery.ticket_detail`；广告为 `delivery.ad_tasks` | 播种 |
| `s.kf_assigned` | 客服工单待处理 | `service_ticket.created`、`service_ticket.transferred`（发给新负责人，a08 的请求）、`service_ticket.reopened` | 工单负责人 | ✔ / ✔ | `service.ticket_detail` | 播种 |
| `s.kf_response_overdue` | 首次响应超时 | `service_ticket.escalated` | 负责人与客服主管 | ✔ / ✔ | `service.ticket_detail` | 播种 |
| `s.complaint_created` | 投诉建议 | `service_ticket.created`（问题类型 `ext.notifyLead` 为真） | 客服主管 | ✔ / ✔ | `service.ticket_detail` | 播种 |
| `s.launch_overdue` | 上线逾期 | 规则 R6 | 交付经理 | ✔（按人按日一条）/ ✔ | `publish.overdue` | 播种 |
| `s.offline_overdue` | 下架逾期 | `takedown.escalated` | 交付主管与交付经理 | ✔ / ✔ | `publish.offline` | 播种 |
| `s.copyright_expiring` | 版权即将到期 | 规则 R7 | 内容运营 | ✔（按人按日一条）/ ✔ | `drama.edit` | 播种 |
| `s.approval_pending` | 待审批 | `approval.submitted` | 有决定权的员工 | ✔ / ✔ | `approval.mine` | 播种 |
| `s.wecom_invite` | 企业微信绑定邀请 | 员工新增邀请/显式邀请及既有扫描恢复，无出站事件 | 仍启用且 invited 的本人 | — / ✔ | `auth.bindWecom`（无 params；当前绑定 API 已有，个人设置页待 W2-06） | W2-03 必要补登；a01 第3.24节 |
| `s.followup_due` | 跟进到期提醒 | 纯提醒 `followup_due`，到期日 09:00 起 | 当前 `follow_up.owner_staff_id`，仍待跟进 | ✔ / ✔ | `merchant.detail`（`entityId`） | W2-17 必要补登；03 分组 2.9、13 分组 2.1 |
| `s.approval_decided` | 审批结果 | `approval.approved`、`approval.rejected` | 申请人 | ✔ / ✔ | `approval.mine` | 播种 |
| `s.receipt_pending` | 对公凭证待确认 | `transfer.proof_submitted` | 财务 | ✔ / ✔ | `order.receipts` | 播种 |
| `s.merchant_unreached` | 商家未触达 | 补发判定：订阅与短信都未送达（不经出站事件，13-notify-docs.md:439） | 该商家的交付经理 | ✔ / ✔ | `merchant.detail` | 播种 |
| `s.export_ready` | 导出完成 | `export.succeeded`；`export.failed`（失败文案） | 申请人 | — / ✔ | `export.records`，`params = { exportJobId }`（a02 的请求） | 播种 |
| `s.system_alert` | 系统告警 | 告警的铃铛副本（d7 §9.3，不经出站事件） | 超级管理员 | — / ✔ | `system.health` | 播种 |
| `s.approval_overdue` | 审批超时 | `approval.sla_breached` | 处理人与主管（d3 T11、T32） | ✔ / ✔ | `approval.mine` | 补登（x01 待确认 4） |
| `s.handover_overdue` | 转移后未联系商家 | `assignment.sla_breached` | 新交付经理与主管（d3 N6） | ✔ / ✔ | `merchant.detail` | 补登（x01 待确认 4） |
| `s.asset_feedback` | 商家素材反馈 | `asset.feedback_submitted` | 门店交付经理（`store.delivery_manager_id`），为空时交付主管 | ✔ / ✔ | `merchant.asset_review` | 补登（m03、x01 的请求） |
| `s.asset_review_overdue` | 素材整理超时 | `asset.sla_breached` | 交付经理（d3 T33） | ✔ / ✔ | `merchant.asset_review` | 补登（x01 待确认 4） |
| `s.finance_overdue` | 财务待办超时 | `transfer.sla_breached`、`invoice.sla_breached` | 财务 | ✔ / ✔ | `order.receipts`；发票为 `finance.invoices` | 补登（x01 待确认 4） |
| `s.payment_exception` | 支付差异单 | `payment_exception.opened` | 财务 | ✔ / ✔ | `finance.reconcile` | 补登（x01 待确认 4） |
| `s.kf_solution_overdue` | 处理方案超时 | `service_ticket.solution_overdue` | 工单负责人（d3 T9） | ✔ / ✔ | `service.ticket_detail` | 补登（x01 待确认 4） |
| `s.kf_supplemented` | 商家补充了说明 | `service_ticket.supplemented`（m08 3.8 `m.serviceTicket.entry.create`；`ownerStaffId` 为空时不提醒） | 工单负责人（`service_ticket.owner_staff_id`，即载荷的 `ownerStaffId`） | ✔ / ✔ | `service.ticket_detail` | 补登（m08、a08 第二轮的请求） |
| `s.kf_todo` | 客服待办 | `order.rejected_stale`（待开工订购超期未补正，d3 N4）、`ad.returned_stale`（广告待补充素材超期，d3 N12） | 客服主管 | ✔ / ✔ | `order.detail`；广告为 `delivery.ad_tasks` | 补登（x01 待确认 4） |
| `s.finance_config` | 受控财务配置变更 | `finance_config.proposed`、`finance_config.approved` | 全体财务与超级管理员 | ✔ / ✔ | `finance.reconcile`（受控财务配置页的路由键由 a02 路由表补登后改用它） | 补登（x01 订阅栏） |
| `s.delivery_progress` | 交付进度 | `ticket.step_changed`、`ticket.held`、`ticket.resumed`、`ticket.terminated`、`ticket.archived`、`plan.change_requested`、`plan.confirmed`、`sample.check_rejected`、`sample.qc_failed`、`ticket.episode_qc_failed`（成片逐集质检不通过，发剪辑师）、`package.reissue_opened`（发起补发，发剪辑师）、`sample.confirmed`、`sample.change_requested`、`ad.requested`、`ad.assigned`、`ad.resubmitted`、`ad.confirmed`、`ad.revision_requested` | 按事件取 x01 订阅栏的接收人：工单负责人、交付经理、剪辑师 | ✔ / ✔ | `delivery.ticket_detail`；广告为 `delivery.ad_tasks` | 补登（x01 订阅栏） |
| `s.publish_progress` | 发布待办 | `takedown.merchant_confirmed`、`launch.verify_revoked` | 发布专员 | ✔ / ✔ | `publish.offline`；核验为 `publish.verify` | 补登（x01 订阅栏） |
| `s.merchant_changed` | 商家变动 | `store.archived`（只 `archiveReason = by_owner`）、`entity_member.promoted`（老板更换） | 交付经理；老板更换另发服务经理 | ✔ / ✔ | `merchant.detail` | 补登（x01 订阅栏） |

W2-10 停用只对持久化 `store.archived/by_owner` 及其真实迁移历史通知当前 active 交付经理。
`m.member_changed` 的 `store_archived` 级联本人为账号级安全告知（NULL entity/store/copyMode、非 ownerOnly、
`messages.list`、无旧业务/个人隐私）；当前有效老板另收仍可进入门店的 `store.members`。
两端派发/外发都重验源 outbox 类型、业务 id 与当前事实，outbox.id 区分发生次数且重投去重。
`by_owner/self/entity_closed/entity_abandoned` 等其他移除通知未在此范围开放；原 stores_changed 分支保持。

## 3. 接口

### 3.1 admin.agreement.list　协议清单
`GET /admin/agreements`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.agreement.list`（路线图 `a09.agreements.list`） |
| 鉴权 | `staff`；模块 `ops` ≥ v；数据范围 `global` |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsAgreements 左栏协议卡片（“当前 v1.1 · 2026-08-01 生效”“v1.2 草稿”“V1.1”标记） |
| 出处 | proto-admin-e.md:143；d6:1012-1024；13-notify-docs.md:657-699 |

**请求**：查询参数 `page`、`pageSize`（C43；结构名 `AdminAgreementListQuery`，初稿名 `AgreementListQuery` 与 m01 同名不同构，按 A132 改名）。排序固定为 `agreement.sort_no`。

**响应**：`data` 为 `AdminPage<AgreementListItem>`（`{ items, page, pageSize, total }`，a01，C87）（2.3）。

**错误**：无（只有通用错误）。

**副作用**：无。

**说明**：

- V1.0 迁移只播种 6 份（`user`、`privacy`、`member`、`points`、`custom_license`、`ad_service`）；原型与路线图的第 7 份《服务商合作协议》（`partner`）留到 V1.1 的迁移（M9；13-notify-docs.md:659、699），V1.0 不返回。
- `currentVersion`、`pendingVersion` 按时间实时解析（2.1），不看簿记状态。

### 3.2 admin.agreement.get　协议详情
`GET /admin/agreements/{agreementKey}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.agreement.get`（路线图 `a09.agreements.get`） |
| 鉴权 | `staff`；模块 `ops` ≥ v |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsAgreements 右侧详情：协议名、签署场景、适用对象、重新同意进度条、当前版本正文、版本记录表；“新建版本 / 编辑草稿 v1.2”按钮 |
| 出处 | proto-admin-e.md:143、147；d6:1772、1187；13-notify-docs.md:701-769 |

**请求**：路径参数 `agreementKey`（string，协议自然键，A3）。

**响应**：`data` 为 `AgreementDetail`（2.3）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 协议键不存在（含 V1.0 未播种的 `partner`） |

**副作用**：无（GET 不写库，A19）。

**说明**：

- “下载当前版本”：前端取 `versions` 里 `displayStatus = active` 那一行的 `pdfFile.fileId`，调 a01 的 `admin.file.downloadUrls`（`disposition = attachment`）；没有当前版本时按钮置灰并提示“该协议尚无生效版本”。协议 PDF 的分类是 `legal_doc`：a01 第二轮的授权矩阵已放行“模块 `ops` ≥ v，且该文件被协议版本引用（`file_ref.ref_type = agreement_version`）”，每次签发写 `access` 审计；地址有效期 30 分钟（A125，C61 已补；a01 3.61 的有效期清单还没有这一类，请补上，见 `cross_doc`）。
- 重新同意进度只算用户级协议：主体级协议在交易时校验版本，没有“存量用户重新同意”的进度（d6:1184-1187）。

### 3.3 admin.agreement.agreementVersion.create　新建版本草稿
`POST /admin/agreements/{agreementKey}/agreement-versions`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.agreement.agreementVersion.create`（路线图 `a09.agreement-versions.create`；A5：嵌套集合沿用资源名 `agreement-versions`） |
| 鉴权 | `staff`；`permission: assert-in-handler`（A45）：模块 `ops` = e；`bumpMajor = true`（升主版本号）另需 `sys.super_admin`（13-notify-docs.md:709“由超级管理员手动升”） |
| 回显 | 无 |
| 幂等 | `required` |
| 乐观锁 | 无（新建） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsAgreements“新建版本”弹层（版本号只读自动、生效时间、变更摘要、上传正文、需要用户重新同意、正文已经法务审定） |
| 出处 | proto-admin-e.md:145；d6:1065-1082；13-notify-docs.md:762 |

**请求**：路径参数 `agreementKey`。请求体 `AgreementVersionCreateBody`（全部可选，弹层可以先建草稿再逐项填）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `bumpMajor` | boolean | 否 | 默认 `false` | 为真时主版本号加 1、次版本号归 0（`v1.3` → `v2.0`） |
| `effectiveAt` | string(date-time) | 否 | 草稿阶段只校验格式 | → `agreement_version.effective_at`；“不早于当前时间”与“晚于 10 分钟后”在保存为待生效时校验 |
| `summary` | string | 否 | 1–60 字 | → `agreement_version.summary` |
| `sourceFileId` | string(uuid) | 否 | `stored`、分类 `legal_doc`、扩展名 `docx` | Word 源文件 → `agreement_version.source_file_id`；服务端转出展示版 |
| `pdfFileId` | string(uuid) | 否 | `stored`、分类 `legal_doc`、扩展名 `pdf` | PDF 下载版 → `agreement_version.pdf_file_id`；服务端算 SHA-256 |
| `isReconsentRequired` | boolean | 否 | 默认 `true` | → `agreement_version.is_reconsent_required` |
| `isLegalApproved` | boolean | 否 | 默认 `false` | → `agreement_version.is_legal_approved` |

**响应**：`AgreementVersionMutationResult`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `version` | `AgreementVersionItem` | 是 | 新草稿 | `agreement_version` |
| `contentHtml` | string \| null | 是 | 展示版 HTML，弹层里并排预览“小程序展示效果”与 PDF 用 | `agreement_version.content_html` |
| `conversion` | `ContentConversion` | 是 | 本次正文处理的结果，只在本响应里给出、不落库 | 计算 |

`ContentConversion`：`{ state: enum(ContentConversionState), warnings: array<{ code: 'text_mismatch', similarityBp: integer(万分比) }> }`。`state`：`converted` 本次由 Word 转出了展示版；`pdf_only` 只有 PDF、没有展示版；`unchanged` 本次没有改文件。`text_mismatch`：Word 与 PDF 各抽纯文本、去空白后比较，相似度低于 98% 时给出（只警告、不阻断，防止传错文件，d6:1058-1060）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 协议键不存在 |
| `AGREEMENT_DRAFT_EXISTS` | 409 | 该协议已有草稿（`uq_agreement_version_one_draft`）；`details` 带草稿 id 与版本号，前端改为“编辑草稿” |
| `FILE_NOT_USABLE` | 400 | 文件不可用（m03 定义）：`details.reason` 为 `not_stored`（不是 `stored`）、`category_mismatch`（分类不是 `legal_doc`）或 `ext_mismatch`（Word 不是 `docx`、PDF 不是 `pdf`） |
| `AGREEMENT_CONTENT_CONVERT_FAILED` | 400 | Word 转展示版失败（文件损坏、加密、含不支持的内容） |
| `PERMISSION_DENIED` | 403 | `bumpMajor = true` 但不是超级管理员 |

**副作用**（同一事务）：

- 状态：`agreement_version: (新建) → draft`（13-notify-docs.md:762）。版本号：`bumpMajor = false` 时 `major` 取该协议未撤回版本的最大主版本号（没有任何版本时为 1），`minor` 取该主版本下未撤回版本的最大次版本号加 1（没有为 0）；`bumpMajor = true` 时 `major` 加 1、`minor = 0`。
- 写入：`created_by_staff_id` = 本人，`lock_version = 0`；有 Word 时写 `content_html`（白名单清洗后）与 `html_sha256`；有 PDF 时写 `content_sha256`（优先取 `file_object.sha256`，没有则服务端完整读一遍文件计算）。
- 文件引用：经 `files.link()` 登记 `file_ref`（`ref_type = agreement_version`，`role` 为 `source` / `pdf`，06-media.md:1662）。
- 审计：`ops` 流，类别 `agreement`，动作 `docs.agreement_version.create`，对象 `agreement_version`，`after` 记版本号与开关。
- 不发出站事件；草稿不进商家端读取，不改配置缓存。

**说明**：原型的弹层只有一个“保存为待生效版本”按钮：前端先调本接口（或已有草稿时调 3.4），再调 3.5，并带上前一步响应里的 `version.lockVersion`（A105）。

### 3.4 admin.agreementVersion.update　编辑草稿
`PATCH /admin/agreement-versions/{agreementVersionId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.agreementVersion.update`（路线图 `a09.agreement-versions.update`） |
| 鉴权 | `staff`；模块 `ops` = e |
| 回显 | 无 |
| 幂等 | `required`（带 `lockVersion` 的 PATCH，A17） |
| 乐观锁 | 带 `lockVersion`（守卫“`lock_version` 相符”，13-notify-docs.md:763；A21） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsAgreements“编辑草稿 · 《用户服务协议》”弹层 |
| 出处 | proto-admin-e.md:145、156；13-notify-docs.md:763 |

**请求**：路径参数 `agreementVersionId`。请求体 `AgreementVersionUpdateBody`：字段同 3.3（不含 `bumpMajor`），不传 = 不改；`effectiveAt`、`summary`、`sourceFileId`、`pdfFileId` 传 `null` = 清空（C38）；另有：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `lockVersion` | integer | 是 | — | 页面加载时的 `lockVersion` |

**响应**：`AgreementVersionMutationResult`（3.3）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 版本不存在 |
| `STATE_NOT_ALLOWED` | 409 | 版本不是草稿（离开草稿后内容冻结，`trg_agreement_version_guard`） |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符；`details` 带最新 `lockVersion` |
| `FILE_NOT_USABLE` | 400 | 同 3.3 |
| `AGREEMENT_CONTENT_CONVERT_FAILED` | 400 | 同 3.3 |

**副作用**（同一事务）：

- 状态：`agreement_version: draft → draft`（编辑，13-notify-docs.md:763）。`lock_version` 加 1，写 `updated_at`。
- 换 Word：重新转展示版，写 `content_html`、`html_sha256`；清空 Word 时两列一起清空（`ck_agreement_version_html`）。换 PDF：重算 `content_sha256`；清空时一起清空。
- 文件引用：新文件 `files.link()`；被替换或清空的旧文件对本行的引用解除（`files.unlink()`），按 06 分组的回收规则处理（13 分组写“不释放”指离开草稿后的版本；请 13、06 分组确认，见 `cross_doc`）。
- 审计：`ops` 流，类别 `agreement`，动作 `docs.agreement_version.update`，`before` / `after` 只记变更字段（文件记 id 与文件名）。
- 不发出站事件，不改配置缓存。

### 3.5 admin.agreementVersion.schedule　保存为待生效
`POST /admin/agreement-versions/{agreementVersionId}/schedule`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.agreementVersion.schedule`（路线图 `a09.agreement-versions.schedule`） |
| 鉴权 | `staff`；`permission: assert-in-handler`（A45）：模块 `ops` = e；《会员服务协议》《积分规则》距生效不足参数 `agreement.announce_min_days`（默认 30 天）时，另需 `agreement.short_notice` 并填原因（13-notify-docs.md:764） |
| 回显 | 无 |
| 幂等 | `required`（状态迁移，A17） |
| 乐观锁 | 带 `lockVersion`（守卫“锁版本相符”，A105；13-notify-docs.md:764；C53 已核对清单） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsAgreements 弹层“保存为待生效版本”；toast“已保存为待生效版本，<时间> 自动生效” |
| 出处 | proto-admin-e.md:146；d6:1080、1719；13-notify-docs.md:764；14-config-data.md:528 |

**请求**：路径参数 `agreementVersionId`。请求体 `AgreementVersionScheduleBody`：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `lockVersion` | integer | 是 | — | 草稿的 `lockVersion`：弹层里先调了 3.3 或 3.4 的，取那次响应里 `version.lockVersion`；否则取页面加载时的值 |
| `shortNoticeReason` | string | 条件 | 1–100 字，非空白 | 公告期不足时必填 → `agreement_version.short_notice_reason`，同一事务原样写进 `site_notice.short_notice_reason`；公告期充足或不是 `member`、`points` 时传了忽略 |

**响应**：`{ version: AgreementVersionItem, siteNotice: SiteNoticeItem | null }`；`siteNotice` 只对 `member`、`points` 有值。

**错误**（按判定顺序）：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 版本不存在 |
| `STATE_NOT_ALLOWED` | 409 | 版本不是草稿 |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符（期间有人改过草稿）；`details` 带最新 `lockVersion`，前端刷新草稿内容后重新确认 |
| `AGREEMENT_DRAFT_INCOMPLETE` | 409 | 缺 PDF、缺 Word（服务层默认要求双文件，13 分组待确认第 3 项）、缺摘要、缺生效时间、未勾选法务审定；`details.missing` 列出缺的项 |
| `AGREEMENT_EFFECTIVE_TOO_SOON` | 409 | `effective_at ≤ now + 10 分钟`；`details` 带最早可选时间 |
| `AGREEMENT_PENDING_EXISTS` | 409 | 该协议已有待生效版本（`uq_agreement_version_one_pending`）；`details` 带它的 id、版本号与生效时间 |
| `AGREEMENT_SHORT_NOTICE` | 409 | `member`、`points` 公告期不足：没有 `agreement.short_notice`（`details.canOverride = false`），或有权限但没填原因（`canOverride = true`）；`details` 带最少天数、实际天数与最早满足公告期的时间 |
| `STEP_UP_REQUIRED` | 403 | 公告期不足走 `agreement.short_notice`，注册表对它标了再验证且超出 10 分钟窗口；再验证后同一请求重放 |

**副作用**（同一事务）：

- 状态：`agreement_version: draft → pending`（13-notify-docs.md:764）：`FOR UPDATE` 锁版本行后比对 `lock_version`，再查其余守卫。写 `published_by_staff_id` = 本人，`lock_version` 加 1；公告期不足时写 `short_notice_reason`。
- 公告（只对 `member`、`points`）：调 `notices.announce`，`site_notice: (新建) → announced`（14-config-data.md:528）：`kind = agreement_version`，`ref_id` = 本版本 id，`title` = “{`agreement.name`}更新公告”，`summary` = 版本摘要，`summary_no_price` 为空（消费方回落 `summary`：m04 公告条与 `m.rule_change_notice` 的正文都按此，13-notify-docs.md:150），`effective_at` = 版本生效时间，`announced_at` = 当前时刻，`lead_days` 按 14-config-data.md:486 计算，`link` = `{ route: 'agreement.view', params: { key } }`，`bar_enabled = true`，`short_notice_reason` 同上，`created_by_staff_id` = 本人；返回的公告 id 写入 `agreement_version.site_notice_id`。`notices.announce` 同事务写出站事件 `site_notice.announced`（订阅者 `notify.onEvent` 给全部正常主体的老板发 `m.rule_change_notice`）。
- 审计：`ops` 流，类别 `agreement`，动作 `docs.agreement_version.schedule`，`meta` 带生效时间、公告期天数、是否走了公告期不足（及原因）。
- 不登记定时器：到点生效由周期任务 `docs.sweep` 簿记（`pending → active`、旧 `active → superseded`，13-notify-docs.md:766-767；x01 的非 HTTP 迁移归属表），读路径到点即切换。
- 事务提交后：`agreement`、`site` 两个配置缓存命名空间的版本号加 1（缓存硬过期不晚于最近的生效时刻，d6:1789）。

**说明**：

- 公告期按“生效时间 − 当前时刻”向下取整到天，与 `site_notice.lead_days` 同口径。
- 用户级协议（`user`、`privacy`）生效后由登录中间件按 `consent_stamp` 拦截重新同意（d6:1143-1170）；主体级协议在交易时校验版本（`AGREEMENT_VERSION_STALE`，m01 定义），本接口不做任何推送。

### 3.6 admin.agreementVersion.withdraw　撤回待生效版本
`POST /admin/agreement-versions/{agreementVersionId}/withdraw`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.agreementVersion.withdraw`（路线图 `a09.agreement-versions.withdraw`） |
| 鉴权 | `staff`；模块 `ops` = e |
| 回显 | 无 |
| 幂等 | `required`（状态迁移，A17） |
| 乐观锁 | 不带（守卫是单条条件更新，13-notify-docs.md:765） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 原型无（版本记录里待生效行的“撤回”操作，按设计规范第 12 节补） |
| 出处 | d6:1081；13-notify-docs.md:765、769；14-config-data.md:529-531 |

**请求**：路径参数 `agreementVersionId`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `reason` | string | 否 | ≤100 字 | 撤回原因，写进审计 |

**响应**：`{ withdrawn: AgreementVersionItem, newDraft: AgreementVersionItem | null, siteNotice: SiteNoticeItem | null }`：被撤回的版本；复制出的新草稿（该协议已有草稿时不复制，为 `null`）；被撤回的公告（只对 `member`、`points`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 版本不存在 |
| `STATE_NOT_ALLOWED` | 409 | 版本不是 `pending` |
| `AGREEMENT_WITHDRAW_TOO_LATE` | 409 | 距生效不足 10 分钟或已到生效时间（`details.reason = 'effective_soon'`），或该版本已有同意记录（`'has_consents'`） |

**副作用**（同一事务）：

- 状态：`agreement_version: pending → withdrawn`（13-notify-docs.md:765）：单条条件更新 `WHERE id = ? AND status = 'pending' AND effective_at > now + 10 分钟 AND NOT EXISTS (该版本的同意记录)`，影响 0 行时再读一次区分原因。`site_notice_id` 保留原值。
- 公告：有公告的调 `notices.withdraw`，`site_notice: announced → withdrawn`（14-config-data.md:529），写 `withdrawn_by_staff_id` = 本人、`withdrawn_at`；同事务写出站事件 `site_notice.withdrawn`（站内发“调整已取消”，公告条随即消失）。
- 复制草稿：该协议当前没有草稿时，插入一行新草稿 `agreement_version: (新建) → draft`：复制文件、展示版、两个哈希、摘要、两个开关、版本号与 `effective_at`；`site_notice_id`、`short_notice_reason`、`published_by_staff_id` 为空；`created_by_staff_id` = 本人；两个文件经 `files.link()` 登记到新行。已有草稿时不复制，员工在已有草稿上继续。
- 审计：`ops` 流，类别 `agreement`，动作 `docs.agreement_version.withdraw`，`reason_text` = 原因，`meta` 带新草稿 id。
- 事务提交后：`agreement`、`site` 配置缓存版本号加 1。

**说明**：撤回不回退到草稿（数据模型改为新终态 `withdrawn` + 复制新草稿），理由见 13-notify-docs.md:769。已撤回的行不占版本号（`uq_agreement_version_agreement_key_major_minor` 不含已撤回的行），新草稿沿用原版本号。

### 3.7 admin.agreementConsent.list　同意记录检索
`GET /admin/agreement-consents`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.agreementConsent.list`（路线图 `a09.agreement-consents.list`；A26） |
| 鉴权 | `staff`；模块 `ops` ≥ v；数据范围 `global` |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsAgreements（同意记录检索，原型无该页签，按 A26 补）；商家详情跳转过来时带 `entityId`；付款单、订购单、广告详情跳转过来时带 `bizType` + `bizId` |
| 出处 | 13-notify-docs.md:790-885；proto-admin-e.md:662；A26 |

**请求**：查询参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `agreementKey` | string | 否 | 可多值 | 协议 |
| `agreementVersionId` | string(uuid) | 否 | — | 版本 |
| `merchantUserId` | string(uuid) | 否 | — | 操作人（走 `ix_agreement_consent_merchant_user_id_agreement_key`） |
| `entityId` | string(uuid) | 否 | — | 主体（走 `ix_agreement_consent_entity_id_agreement_key`） |
| `storeId` | string(uuid) | 否 | — | 门店 |
| `scene` | enum(`AgreementScene`) | 否 | 可多值 | 签署场景 |
| `method` | enum(`AgreementConsentMethod`) | 否 | — | 同意方式 |
| `bizType` | enum(`AgreementConsentBizType`) | 否 | — | 关联单据类型 |
| `bizId` | string(uuid) | 否 | 须同时给 `bizType` | 关联单据 id（走 `ix_agreement_consent_biz_type_biz_id`）；单据详情页跳转用它 |
| `no` | string | 否 | ≤40 字符，精确匹配 | 关联单据号（`FK…`、`LYX…`、`GG…`，C11），人工输入的辅助条件。`biz_no` 没有索引，只在日期范围内过滤，不解除默认的近 30 天 |
| `consentNo` | string | 否 | 十进制数字 | 同意记录编号（授权书上印的编号，走 `uq_agreement_consent_seq`） |
| `consentedFrom` / `consentedTo` | string(date) | 否 | 两端都含；跨度不超过 366 天 | 同意日期（北京时间）。没有给出 `merchantUserId`、`entityId`、`storeId`、`bizId`、`consentNo`、`agreementVersionId` 任何一个（都有索引）时，默认近 30 天 |
| `page` / `pageSize` | integer | 否 | C43 | 页码分页 |
| `sort` | enum | 否 | `-consentedAt`（默认）/ `consentedAt` | 服务端追加 `seq` 保证稳定 |

**响应**：`data` 为 `AdminPage<AgreementConsentItem>`（`{ items, page, pageSize, total }`，a01，C87）（2.4）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 日期跨度超过 366 天；`consentNo` 不是数字；`bizId` 没有 `bizType` |

**副作用**：无。

**说明**：数据模型对手机号、信用代码不建盲索引（13-notify-docs.md:875），不提供按手机号检索；要按人查，先在商家详情拿到 `merchantUserId`。列表只回脱敏值，明文走 `admin.piiReveal.create`（C40）。

### 3.8 admin.agreementConsent.get　同意记录证据详情
`GET /admin/agreement-consents/{agreementConsentId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.agreementConsent.get`（路线图 `a09.agreement-consents.get`） |
| 鉴权 | `staff`；模块 `ops` ≥ v（路线图原建议的 `docs.consent.evidence` 只用于明文查看，见说明） |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 原型无（同意记录检索的右侧详情，按 A26 补） |
| 出处 | d6:1096-1137；13-notify-docs.md:790-858；C40；A19 |

**请求**：路径参数 `agreementConsentId`。

**响应**：`data` 为 `AgreementConsentDetail`（2.4）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 记录不存在 |

**副作用**：无。草案“解密手机号并写审计”的写法取消（A19：GET 不写库、只回脱敏值）。

**说明**：查看明文时前端调 a01 的 `admin.piiReveal.create`：`{ subjectType: 'agreement_consent', subjectId, field: 'phone' | 'uscc', purpose }`，权限点 `docs.consent.evidence`，先写 `access` 审计再返回（a01 第 3.41 节）。

### 3.9 admin.siteNotice.list　规则变更公告记录
`GET /admin/site-notices`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.siteNotice.list`（路线图 `a09.site-notices.list`） |
| 鉴权 | `staff`；`permission: assert-in-handler`（A45）：模块 `ops` ≥ v 或 `billing` ≥ v（单一模块等级表达不了“或”） |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:Plans“调整与公告记录”（时间、标题、说明、状态：待生效 / 已生效 / 已撤销）；A:OpsAgreements 版本记录里会员与积分协议的公告 |
| 出处 | d6:1688-1723、1771；14-config-data.md:470-556；05-risks-and-open-issues.md:195 |

**请求**：查询参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `kind` | enum(`SiteNoticeKind`) | 否 | 可多值 | 公告类型；套餐页传 `plan_revision,billing_param` |
| `refId` | string(uuid) | 否 | — | 被公告的变更（协议版本记录取某一版本的公告） |
| `status` | enum(`SiteNoticeStatus`) | 否 | — | 已公告 / 已撤回 |
| `displayState` | enum(`SiteNoticeDisplayState`) | 否 | 可多值 | 待生效 / 已生效 / 已撤销 |
| `effectiveFrom` / `effectiveTo` | string(date) | 否 | 两端都含 | 规则生效日期 |
| `page` / `pageSize` | integer | 否 | C43 | 页码分页 |
| `sort` | enum | 否 | `-announcedAt`（默认）/ `-effectiveAt` | |

**响应**：`data` 为 `AdminPage<SiteNoticeItem>`（`{ items, page, pageSize, total }`，a01，C87）（2.5）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `PERMISSION_DENIED` | 403 | `ops`、`billing` 两个模块都是 `n` |

**副作用**：无。

**说明**：

- 只读：本表不可编辑，改公告内容只能撤销变更后重新保存（14-config-data.md:472）。公告由 a07 的价目修订、计费参数变更与本文 3.5 在各自事务里经 `notices.announce` 建立。
- 原型套餐页的记录里还有“套餐上线”“可选周期增加 12 个月”这类不需要公告的变更，它们不在本表；套餐页要合并显示时另调 a07 的 `admin.planRevision.list`（见 `cross_doc`）。
- V1.1 的公告管理（A:OpsNotice）是另一组接口（3.35–3.39），与本表不是同一资源。

### 3.10 admin.homeBanner.list　Banner 列表
`GET /admin/home-banners`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.homeBanner.list`（路线图 `a09.home-banners.list`） |
| 鉴权 | `staff`；模块 `ops` ≥ v |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsHome“Banner”卡片：图片、标题与跳转、生效时间、状态、点击、操作（编辑、启用 / 停用、拖动把手） |
| 出处 | proto-admin-e.md:59；d6:1658-1677；14-config-data.md:407-468 |

**请求**：查询参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `displayState` | enum(`BannerDisplayState`) | 否 | 可多值 | 派生状态筛选；不传为全部（原型列表含已结束、已停用的） |
| `isEnded` | boolean | 否 | — | `false` 只看未结束的（`end_at` 为空或晚于当前时刻，含已停用的），即拖动排序的集合（3.12）；`true` 只看已结束的；不传为全部 |
| `page` / `pageSize` | integer | 否 | `pageSize` 默认 100，上限 100（C43） | 已结束的 Banner 会一直累积，按页翻看；拖动排序用 `isEnded=false`，`total` 超过 100 时前端翻页取全 |
| `sort` | enum | 否 | `position`（默认）/ `-startAt` / `-createdAt` | |

**响应**：`data` 为 `AdminPage<HomeBannerItem>`（`{ items, page, pageSize, total }`，a01，C87）（2.6）。响应头 `Cache-Control: no-store`（含签名地址）。

**错误**：无（只有通用错误）。

**副作用**：无。

**说明**：页头“生效中 N 张 · 最多 5 张”是标题上的数字，取 3.34 的 `admin.homeBanner.summary`（A23；上限作为页头上下文并列返回，A79），前端不自己计数，也不读参数接口（内容运营一般没有系统模块的查看权）。

### 3.11 admin.homeBanner.create　新增 Banner
`POST /admin/home-banners`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.homeBanner.create`（路线图 `a09.home-banners.create`） |
| 鉴权 | `staff`；模块 `ops` = e |
| 回显 | 无 |
| 幂等 | `required`（新建行，A17；复核意见 69）。结果脱敏（A80、C50）：`x-redact-on-replay` = `imageUrl`，同键重放时为 `null`，`data` 带 `replayed: true` |
| 乐观锁 | 无（新建）；并发由事务级咨询锁 `pg_advisory_xact_lock(hashtext('home_banner'))` 串行化 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsHome“新增 Banner”弹层：标题、图片（690×280、JPG 或 PNG、≤1MB）、跳转类型、跳转目标、开始时间、结束时间（留空为长期有效） |
| 出处 | proto-admin-e.md:60、64；d6:1660-1677；14-config-data.md:407-457 |

**请求**：请求体 `HomeBannerCreateBody`：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `title` | string | 是 | 1–30 字 | → `home_banner.title` |
| `imageFileId` | string(uuid) | 是 | `stored`、分类 `banner`（规格在上传登记时按分类校验） | 先经 a01 的 `admin.file.create`（`category = banner`）上传 → `home_banner.image_file_id` |
| `jumpKind` | enum(`BannerJumpKind`) | 是 | — | → `home_banner.jump_kind` |
| `jumpTarget` | `BannerJumpTarget` | 条件 | `jumpKind = none` 时不传或传 `null`；其余必填，结构与校验见 2.6 | → `home_banner.jump_target`；跳转目标的短剧下拉用 a04 的 `admin.drama.list?isOrderable=true&q=`，商城分类取 3.14 的已发布配置 |
| `startAt` | string(date-time) | 是 | — | → `home_banner.start_at`；可以早于当前时刻（立即上线） |
| `endAt` | string(date-time) \| null | 否 | 晚于 `startAt` 且晚于当前时刻；不传或 `null` 为长期有效 | → `home_banner.end_at` |
| `isEnabled` | boolean | 否 | 默认 `true` | → `home_banner.is_enabled` |

**响应**：`data` 为 `HomeBannerItem`（2.6），另带 `replayed: boolean`（同键重放为 `true`，此时 `imageUrl` 为 `null`，C50）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 标题为空或超长；结束时间不晚于开始时间或当前时刻；`jumpKind` 与 `jumpTarget` 的结构不配 |
| `FILE_NOT_USABLE` | 400 | 图片不可用（m03 定义）：`details.reason` 为 `not_stored` 或 `category_mismatch`（分类不是 `banner`） |
| `BANNER_TARGET_INVALID` | 400 | 短剧不存在、不在架或不可订（已停止订购、授权已到期）；商城分类在已发布的商城配置里没有；页面路由不在允许清单；`details` 带 `jumpKind` 与原因 |
| `BANNER_LIMIT_EXCEEDED` | 409 | 启用后在某一时刻同时生效的 Banner 会超过参数 `home.banner.max_active`（默认 5）；`details` 带超限的起始时刻，前端提示“2026-10-15 00:00 起将有 6 张同时生效” |

**副作用**（同一事务）：

- 写入：`home_banner` 新行；`position` = 当前最大值加 1（排在最后）；`lock_version = 0`；`created_by_staff_id` = 本人。没有状态机。
- 上限校验（只在 `isEnabled = true` 时）：先取咨询锁，再取全部启用中的 Banner（含本行），只看与 `[max(now, start_at), end_at)` 相交的，按区间端点扫一遍（同一时刻先减后加，首尾相接不算重叠），任一时刻超过上限即拒绝（d6:1667-1675；14-config-data.md:457 的 `config.N9`）。
- 文件引用：`files.link()` 登记 `file_ref`（`ref_type = home_banner`，`role = image`，06-media.md:1664）。
- 审计：`ops` 流，类别 `ops_config`，动作 `ops.home_banner.create`，对象 `home_banner`，`after` 记标题、跳转、时间窗与启用。
- 事务提交后：`site` 配置缓存版本号加 1。不发出站事件；到结束时间自动下线不需要任务。

### 3.12 admin.homeBanner.batchReorder　调整轮播顺序
`POST /admin/home-banners/reorder`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.homeBanner.batchReorder`（路线图 `a09.home-banners.reorder`；集合动作加 `batch` 前缀，A10） |
| 鉴权 | `staff`；模块 `ops` = e |
| 回显 | 无 |
| 幂等 | `required`。结果脱敏（A80、C50）：`x-redact-on-replay` = `items[].imageUrl`，同键重放时为 `null`，`data` 带 `replayed: true` |
| 乐观锁 | 不带逐行 `lockVersion`：请求体必须恰好是当前未结束的 Banner 的 id 集合，集合不符即视为过期；与 3.11、3.13 共用咨询锁 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsHome Banner 行首的拖动把手（“拖动调整轮播顺序”） |
| 出处 | proto-admin-e.md:63；d6:1771（草案 `PUT /banners/order`）；14-config-data.md:423 |

**请求**：请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `homeBannerIds` | array<string(uuid)> | 是 | 1–200 个、不重复；必须恰好是当前全部未结束的 Banner（2.6：`end_at` 为空或晚于当前时刻，含已停用的）的 id | 新的轮播顺序，第 0 个排最前；前端取 3.10 的 `isEnded=false` |

**响应**：`{ items: HomeBannerItem[], replayed: boolean }`，本次排序的这些 Banner，按新顺序；同键重放时 `replayed = true`、各行 `imageUrl` 为 `null`（C50）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 数组为空、超过 200 个或有重复 |
| `BANNER_ORDER_STALE` | 409 | 提交的集合与当前未结束的集合不一致（期间有人新增了 Banner，或有 Banner 刚好到了结束时间）；`details` 带缺少的与多出的 id，前端刷新后重排 |

**副作用**（同一事务）：取咨询锁；取这组 Banner 原有的 `position` 值从小到大排好，按数组顺序依次分给它们（只改有变化的行），写 `updated_at`、`updated_by_staff_id`；已结束的 Banner 不参与比对，`position` 不变（它们不再轮播，`position` 只影响后台列表的显示顺序）。不加 `lock_version`（顺序不在编辑表单里，避免排序让别人的编辑弹层白白冲突）。审计：`ops` 流，类别 `ops_config`，动作 `ops.home_banner.reorder`，不指定单个对象，`before` / `after` 记两份 id 顺序。提交后 `site` 配置缓存版本号加 1。

**说明**：Banner 不可删除（14-config-data.md:1256），已结束的会一直累积；排序集合只取未结束的，所以表里总行数再多也不影响排序。未结束的（含已排期、已停用）超过 200 张时无法一次提交，需先把不用的改为已结束；同时生效的上限只有 5 张，实际到不了。

### 3.13 admin.homeBanner.update　编辑、启用、停用 Banner
`PATCH /admin/home-banners/{homeBannerId}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.homeBanner.update`（路线图 `a09.home-banners.update`） |
| 鉴权 | `staff`；模块 `ops` = e |
| 回显 | 无 |
| 幂等 | `required`（带 `lockVersion` 的 PATCH，A17）。结果脱敏同 3.11（`x-redact-on-replay` = `imageUrl`） |
| 乐观锁 | 带 `lockVersion`（A21）；上限校验与 3.11 共用咨询锁 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsHome“编辑 Banner”弹层（“已上传图片，点击替换”）；行内“启用 / 停用”（无二次确认） |
| 出处 | proto-admin-e.md:61、62；14-config-data.md:407-457 |

**请求**：路径参数 `homeBannerId`。请求体 `HomeBannerUpdateBody`：3.11 的字段全部可选（不传 = 不改；`endAt` 传 `null` = 改为长期有效；改 `jumpKind` 时必须同时给 `jumpTarget`），另有：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `lockVersion` | integer | 是 | — | 页面加载时的 `lockVersion` |

**响应**：`data` 为 `HomeBannerItem`，另带 `replayed: boolean`（同 3.11）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | Banner 不存在 |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符 |
| `STATE_NOT_ALLOWED` | 409 | 本次改了 `isEnabled`，而按改后的时间窗这张 Banner 已结束（“已结束的不可切换”；先改结束时间再启用） |
| `VALIDATION_FAILED` | 400 | 同 3.11 |
| `FILE_NOT_USABLE` | 400 | 同 3.11 |
| `BANNER_TARGET_INVALID` | 400 | 同 3.11（只校验本次改了的跳转目标；改为启用时连同未改的目标一并校验） |
| `BANNER_LIMIT_EXCEEDED` | 409 | 改后启用、且改了时间窗或启用状态，会超过同时生效上限 |

**副作用**（同一事务）：改列、`lock_version` 加 1、写 `updated_by_staff_id` = 本人与 `updated_at`；改后启用且时间窗或启用状态有变时做 3.11 的上限校验。换图：新图 `files.link()`，旧图对本行的引用解除（`files.unlink()`，`home_banner` 图片下线后保留 180 天，06-media.md:1664）。审计：`ops` 流，类别 `ops_config`，动作 `ops.home_banner.update`（只切换启用时为 `ops.home_banner.enable` / `ops.home_banner.disable`），`before` / `after` 记变更字段。提交后 `site` 配置缓存版本号加 1。没有状态机，不发出站事件。

**说明**：Banner 不提供删除（14-config-data.md:1256）；不用的停用即可。

### 3.14 admin.siteConfig.get　站点配置
`GET /admin/site-configs/{configKey}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.siteConfig.get`（路线图 `a09.site-configs.get`） |
| 鉴权 | `staff`；模块 `ops` ≥ v |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsMall 整页（分类标签与短剧数、热门搜索词、筛选项、排序方式与综合排序权重、“最近发布：09-26 17:20 · 沈蔓”）；A:OpsHome“推荐位”卡片（展示数量、按行业置顶、默认页签、新剧范围、“最近保存：09-26 17:20 · 沈蔓”） |
| 出处 | proto-admin-e.md:65、103；d6:1609-1656；14-config-data.md:335-405、1095-1115 |

**请求**：路径参数 `configKey`（enum(`SiteConfigKey`)，配置自然键，A3）。

**响应**：`data` 为 `SiteConfigView`（2.7）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 配置键不存在 |

**副作用**：无。

**说明**：页面以草稿为准显示（有草稿时显示草稿内容并提示“有未发布的修改”），没有草稿时显示已发布版。`refs` 里的短剧数、题材名、置顶剧名、受影响的 Banner 每次现算；原型的首页预览（“餐饮商家视角”的手机外框）由前端用本接口的推荐位配置加 a04 的 `admin.drama.list` 自行拼出，接口不提供预览试算。

### 3.15 admin.siteConfig.draft.replace　保存草稿
`PUT /admin/site-configs/{configKey}/draft`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.siteConfig.draft.replace`（路线图 `a09.site-configs.save-draft`；`/draft` 是该配置键的草稿单例子资源，A5） |
| 鉴权 | `staff`；模块 `ops` = e |
| 回显 | 无 |
| 幂等 | `required`（带 `lockVersion` 的 PUT，A17） |
| 乐观锁 | 带 `lockVersion`（再次保存草稿的守卫“`lock_version` 相符”，14-config-data.md:386；A21） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsMall“保存并发布”、A:OpsHome“保存推荐位”的第一步（前端一次点击连调本接口与 3.16） |
| 出处 | d6:1638-1654；14-config-data.md:385-386 |

**请求**：路径参数 `configKey`。请求体 `SiteConfigDraftBody`：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `content` | `MallConfig` \| `HomeRecommendConfig` | 是 | 按 `configKey` 的 schema 整份校验（2.7） | 整份覆盖 → `site_config_revision.content` |
| `baseRevNo` | integer | 是 | ≥1 | 页面加载时已发布版的 `revNo` → `site_config_revision.base_rev_no` |
| `note` | string | 否 | ≤100 字 | → `site_config_revision.note` |
| `lockVersion` | integer \| null | 是 | — | 页面加载时草稿的 `lockVersion`；页面加载时没有草稿传 `null` |

**响应**：`data` 为 `SiteConfigView`。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 配置键不存在 |
| `VALIDATION_FAILED` | 400 | 内容不合 schema（2.7）：分类超过 10 个、名称超过 4 字、同名分类、分类 key 格式不对或重复、“全部”被隐藏或删除（`fixed` 分类不是恰好一个、key 不是 `all` 或带了题材）、其余分类没有题材、热门词超过 8 个或重复、分档超过 6 档或 key 重复、分档上下界都为空或下界大于上界、开了集数或积分价筛选却没有分档、默认排序不在排序项里、权重不是整数或合计不等于 100、展示数量不在 3–12、新剧范围不在 7–90、同一行业置顶两部；`fieldErrors.path` 形如 `content.categories.3.key`、`content.filters.priceBands.1.max` |
| `VERSION_CONFLICT` | 409 | 已有草稿而传了 `null`、草稿的 `lockVersion` 不符、或传了 `lockVersion` 但草稿已被发布；`details` 带当前草稿的 `lockVersion`、保存人与时间（没有草稿为 `null`） |

**副作用**（同一事务）：

- 状态：没有草稿时 `site_config_revision: (新建) → draft`（14-config-data.md:385），`created_by_staff_id` = 本人、`lock_version = 0`；已有草稿时 `draft → draft`（整份覆盖，14-config-data.md:386），`lock_version` 加 1、写 `updated_at`。
- 只做 schema 校验；题材、置顶短剧这类引用在发布时校验（3.16），保存草稿不拦。
- 审计：`ops` 流，类别 `ops_config`，动作 `ops.site_config.save_draft`，对象 `site_config_revision`（草稿行）。
- 草稿不进商家端读取，不改配置缓存；不发出站事件。

### 3.16 admin.siteConfig.publish　发布站点配置
`POST /admin/site-configs/{configKey}/publish`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.siteConfig.publish`（路线图 `a09.site-configs.publish`） |
| 鉴权 | `staff`；模块 `ops` = e |
| 回显 | 无 |
| 幂等 | `required`（状态迁移，A17） |
| 乐观锁 | 两把：草稿行的 `lockVersion`（守卫“锁版本相符”，A105；14-config-data.md:387）与 `baseRevNo`（A21 例外，C52：与已发布版的 `rev_no` 比对） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsMall“保存并发布”（toast“已发布商城配置，小程序商城已更新”）；A:OpsHome“保存推荐位”（toast“小程序首页已更新”） |
| 出处 | proto-admin-e.md:109；d6:1638-1656；14-config-data.md:387-388 |

**请求**：路径参数 `configKey`。请求体 `SiteConfigPublishBody`：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `lockVersion` | integer | 是 | — | 草稿行的 `lockVersion`：取刚调用的 3.15 响应里 `draft.lockVersion`（单独重试发布时取 3.14 的 `draft.lockVersion`） |
| `baseRevNo` | integer | 是 | ≥1 | 页面加载时已发布版的 `revNo` |

**响应**：`data` 为 `SiteConfigView`（`draft` 为 `null`，`published` 为新发布的版本）。

**错误**（按判定顺序）：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 配置键不存在 |
| `STATE_NOT_ALLOWED` | 409 | 没有草稿可发布 |
| `VERSION_CONFLICT` | 409 | 草稿行的 `lock_version` 与请求的 `lockVersion` 不等（期间有人整份覆盖过草稿）；`details` 带当前草稿的 `lockVersion`、保存人与时间，前端提示“草稿已被他人修改，请刷新后再发布” |
| `CONFIG_REV_CONFLICT` | 409 | 已发布版的 `rev_no` 与请求的 `baseRevNo` 或草稿的 `base_rev_no` 不等（期间有人发布过）；`details` 带当前已发布版的修订号、发布人与时间，前端提示“已有人发布过新版本，请刷新合并” |
| `VALIDATION_FAILED` | 400 | 草稿内容不合当前 schema（契约升级后的旧草稿） |
| `CONFIG_REF_INVALID` | 409 | 引用校验不通过：题材编码不存在或已停用、置顶短剧不存在或不在架或不可订、行业编码不存在；`details.items` 为 `ConfigRefIssue[]`（2.7） |

两把锁的分工：`lockVersion` 防“发布了别人刚整份覆盖的草稿”，`baseRevNo` 防“覆盖了别人刚发布的版本”；先比草稿锁，再比已发布修订号。

**副作用**（同一事务）：

- 先 `FOR UPDATE` 锁草稿行并比对 `lock_version`，再 `FOR UPDATE` 锁当前已发布行并比对 `base_rev_no`（14-config-data.md:387，A105）。
- 状态：旧版 `site_config_revision: published → archived`（14-config-data.md:388），草稿 `draft → published`（14-config-data.md:387），写 `rev_no` = 旧版加 1、`published_at`、`published_by_staff_id` = 本人。先归档旧版再发布新版（两个部分唯一索引都是立即检查的）。
- 审计：`ops` 流，类别 `ops_config`，动作 `ops.site_config.publish`，对象为新发布的行，`before` / `after` 记两个修订号。
- 事务提交后：`site` 配置缓存版本号加 1（商家端首页、商城 5 秒内生效，d6:1795）。不发出站事件。

**说明**：

- 原型的两个页面都是“一步保存即生效”：前端连调 3.15 与本接口，把 3.15 响应里的 `draft.lockVersion` 带上，两次请求各用各的幂等键；第二步失败时草稿已保存，页面提示后可单独重试发布。
- 商城配置删除了某个分类、而启用中的 Banner 还跳到它时，不阻断发布：3.15 的响应 `refs.affectedBanners` 已列出这些 Banner，前端发布前提示；发布后商家端组装首页时跳过这些失效跳转（m04）。
- 回滚：在版本记录里选历史版，以其 `content` 调 3.15 新建草稿再发布，产生新修订号，不改历史（14-config-data.md:337）。
- 发布后引用失效（题材停用、置顶短剧下架）时，商家端组装响应跳过无效项、不报错（d6:1656，m04 实现）；后台在 3.14 的 `refs.invalidRefs` 里标红（置顶短剧发布后停止订购的同样标红，提醒运营替换）。

### 3.17 admin.siteConfig.revision.list　版本记录
`GET /admin/site-configs/{configKey}/revisions`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.siteConfig.revision.list`（路线图 `a09.site-configs.list-revisions`；`/revisions` 是同表的修订历史，`resources.json` 的别名） |
| 鉴权 | `staff`；模块 `ops` ≥ v |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsMall、A:OpsHome 的“最近发布”信息与版本记录（原型只有一行文字，版本列表与回滚按设计规范第 12 节补） |
| 出处 | d6:1655、1771；proto-admin-e.md:97；14-config-data.md:361 |

**请求**：路径参数 `configKey`。查询参数 `status`（enum，`published` / `archived`，可多值；不传为两者）、`page`、`pageSize`；排序固定 `-revNo`（走 `uq_site_config_revision_config_key_rev_no`）。

**响应**：`data` 为 `AdminPage<SiteConfigRevisionView>`（`{ items, page, pageSize, total }`，a01，C87）（2.7），每项带完整 `content`，供回滚时新建草稿。草稿不在这里，见 3.14。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 配置键不存在 |

**副作用**：无。

### 3.18 admin.notifyScene.list　消息模板（场景列表）
`GET /admin/notify-scenes`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.notifyScene.list`（路线图 `a09.notify-scenes.list`；A24：原 `channel=` 改 `tab=`） |
| 鉴权 | `staff`；模块 `ops` ≥ v |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsTemplates 的“订阅消息”页签：表格（场景、触发时机、近 7 天发送、补发短信、启用）；右侧详情（模板 ID、消息预览、字段取值、触发时机、接收人、发送时段、补发短信开关、测试发送）；页脚“成功率 ＝ 发送成功 ÷ 应发送”。“短信”页签走 3.30（短信模板资源）。“通知设置”页（原型无）用 `tab = other` |
| 出处 | proto-admin-e.md:162-200；d6:956-978、227-277；13-notify-docs.md:88-291 |

**请求**：查询参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `tab` | enum(`NotifySceneTab`) | 否 | 默认 `wx` | `wx` 订阅消息：`notify_scene.audience = 'merchant'` 且有订阅槽位的场景（播种 17 个）；`other` 其他场景：没有订阅槽位的商家场景与全部员工场景（原型无，供“通知设置”页管理场景总开关，清单见 2.9） |
| `q` | string | 否 | ≤20 字 | 场景名或场景键包含 |
| `page` / `pageSize` | integer | 否 | `pageSize` 默认 100 | 场景由迁移播种，总数固定，前端一次取完 |

排序固定为代码注册表的顺序（订阅消息页签与 d6:231-249 的表格顺序一致）。

**响应**：`data = { tab, items: NotifySceneRow[], page, pageSize, total }`（2.8）。

**错误**：无（只有通用错误）。

**副作用**：无。近 7 天统计每行缓存 5 分钟。

**说明**：

- 订阅消息页签的“启用”开关是 `notify_scene.ext_enabled`（关闭后不再发订阅消息、短信，站内照发，13-notify-docs.md:97）；“补发短信”是 `sms_policy` 的 `fallback` ⇄ `never`（13-notify-docs.md:100），可不可点看 `canToggleSmsFallback`。两者经 3.20 修改。
- 短信页签的行是短信模板，不是场景（原型 6 行各带一个“模板编号”，其中“身份验证码”不属于任何场景），所以短信页签走短信模板资源 `admin.smsTemplate.list`（3.30），页签计数取 `admin.smsTemplate.summary`（3.32）：一张表只对应一个资源名（C10），页签跨两个资源时各调各的 `summary`（C83）。
- 触发时机、接收人、示例预览、字段取值来自代码注册表的后台元数据（数据模型不存这些，13-notify-docs.md:90），触发时机里的天数与时刻按当前参数实时拼出（d6:960）。

### 3.19 admin.notifyScene.summary　页签计数
`GET /admin/notify-scenes/summary`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.notifyScene.summary`（路线图 `a09.notify-scenes.summary`；A23） |
| 鉴权 | `staff`；模块 `ops` ≥ v |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsTemplates“订阅消息 N”页签上的数字（“短信 N”取 3.32）；通知设置页的页签 |
| 出处 | proto-admin-e.md:174-175；C83 |

**请求**：查询参数 `q`（同 3.18，可选）。字面段 `summary` 先于 `/{sceneKey}` 注册（A8）。

**响应**：`NotifySceneSummary = { wx: integer, other: integer }`，键与 3.18 的 `tab` 取值一致，口径与各页签的 `total` 相同。

**错误**：无。

**副作用**：无。

### 3.20 admin.notifyScene.update　外部通道与补发短信开关
`PATCH /admin/notify-scenes/{sceneKey}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.notifyScene.update`（路线图 `a09.notify-scenes.update`） |
| 鉴权 | `staff`；模块 `ops` = e |
| 回显 | 无 |
| 幂等 | `required`（带 `lockVersion` 的 PATCH，A17） |
| 乐观锁 | 带 `lockVersion`（列 `notify_scene.lock_version`；草案的 `rev` 改名，C52） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsTemplates 行内“启用”开关（toast“已停用…，该场景不再发送订阅消息”，无二次确认）；详情里“未授权或发送失败时补发短信”开关 |
| 出处 | proto-admin-e.md:185-186；d6:961；13-notify-docs.md:97、100、137 |

**请求**：路径参数 `sceneKey`（场景自然键，A3）。请求体（至少给一个开关）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `isExtEnabled` | boolean | 否 | — | → `notify_scene.ext_enabled` |
| `isSmsFallbackEnabled` | boolean | 否 | 只对 `canToggleSmsFallback` 为真的场景：有订阅槽位与短信模板、且 `sms_policy` 不是 `always` | 真 → `notify_scene.sms_policy = 'fallback'`；假 → `'never'` |
| `lockVersion` | integer | 是 | — | |

**响应**：`data` 为 `NotifySceneRow`（2.8）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 场景键不存在 |
| `VALIDATION_FAILED` | 400 | 两个开关都没给 |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符 |
| `NOTIFY_SCENE_NOT_CONFIGURABLE` | 409 | 改补发短信但场景没有订阅槽位或短信模板（`details.reason = 'no_sms_channel'`），或策略是“总是发”（`'sms_policy_always'`，如新微信登录的账号安全通知）；改外部通道开关但场景没有外部通道（只发站内的商家场景，`'no_external_channel'`） |

**副作用**（同一事务）：改列、`lock_version` 加 1、写 `updated_by_staff_id` = 本人与 `updated_at`。审计：`ops` 流，类别 `notify_config`，动作 `notify.scene.update`，`target_type = notify_scene`，`target_key` = 场景键，`before` / `after` 记两个开关。提交后 `notify` 配置缓存版本号加 1。没有状态机，不发出站事件。

**说明**：开关只影响之后的发送：已建未发的外部通道投递在认领时按当前开关判定（关闭的记 `cancelled`，原因 `scene_disabled`，13-notify-docs.md:427），由投递任务处理，本接口不批量改投递行。

### 3.21 admin.notifyScene.disable　关闭场景总开关
`POST /admin/notify-scenes/{sceneKey}/disable`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.notifyScene.disable`（路线图 `a09.notify-scenes.disable`；草案 `PATCH …/scenes/{key}/master`） |
| 鉴权 | `staff`；`sys.super_admin`（A45；13-notify-docs.md:98“仅超级管理员可改”） |
| 回显 | 无 |
| 幂等 | `required`（A17；复核意见 47） |
| 乐观锁 | 带 `lockVersion`（13-notify-docs.md:106） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 原型无（“通知设置”，05-risks-and-open-issues.md:271；入口在 3.18 的 `other` 页签与场景详情） |
| 出处 | d6:962；13-notify-docs.md:98 |

**请求**：路径参数 `sceneKey`。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `reason` | string | 是 | 1–100 字，非空白 | 关闭原因，写进审计 |
| `lockVersion` | integer | 是 | — | |

**响应**：`data` 为 `NotifySceneRow`。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 场景键不存在 |
| `STATE_NOT_ALLOWED` | 409 | 场景总开关已是关闭 |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符 |
| `NOTIFY_SCENE_NOT_CONFIGURABLE` | 409 | 注册表把该场景标为必达、不可关闭（`details.reason = 'mandatory_scene'`），默认是规则变更公告 `m.rule_change_notice`（PRD 的提前公告义务）；清单见第 6 节第 2 项 |

**副作用**（同一事务）：`notify_scene.scene_enabled = false`、`lock_version` 加 1、写 `updated_by_staff_id`、`updated_at`。审计：`ops` 流，类别 `notify_config`，动作 `notify.scene.disable`，`target_key` = 场景键，`reason_text` = 原因。提交后 `notify` 配置缓存版本号加 1。关闭后派发函数不再为该场景建通知（站内也不发）；已建未发的投递在认领时记 `cancelled`（`scene_disabled`）。

### 3.22 admin.notifyScene.enable　打开场景总开关
`POST /admin/notify-scenes/{sceneKey}/enable`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.notifyScene.enable`（路线图 `a09.notify-scenes.enable`） |
| 鉴权 | `staff`；`sys.super_admin`（A45） |
| 回显 | 无 |
| 幂等 | `required` |
| 乐观锁 | 带 `lockVersion` |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 原型无（同 3.21） |
| 出处 | d6:962；13-notify-docs.md:98 |

**请求**：路径参数 `sceneKey`。请求体（同 3.21）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `reason` | string | 是 | 1–100 字，非空白 | 打开原因，写进审计（13-notify-docs.md:98：场景总开关“须填原因并写审计”，开和关一样） |
| `lockVersion` | integer | 是 | — | |

**响应**：`data` 为 `NotifySceneRow`。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 场景键不存在 |
| `VALIDATION_FAILED` | 400 | 没填原因或全是空白 |
| `STATE_NOT_ALLOWED` | 409 | 场景总开关已是打开 |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符 |

**副作用**（同一事务）：`notify_scene.scene_enabled = true`、`lock_version` 加 1、写 `updated_by_staff_id`、`updated_at`；审计动作 `notify.scene.enable`，`reason_text` = 原因；提交后 `notify` 配置缓存版本号加 1。关闭期间没有派发的通知不补发（事件已消费；按规则派生的提醒在下一轮扫描时按当时的真相重新判断，13-notify-docs.md:1212）。

### 3.23 admin.notifyScene.testSend　测试发送
`POST /admin/notify-scenes/{sceneKey}/test-send`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.notifyScene.testSend`（路线图 `a09.notify-scenes.test-send`） |
| 鉴权 | `staff`；模块 `ops` = e |
| 回显 | 无 |
| 幂等 | `required`（对外发送，A17）。**三段式用例**（C51 已登记，A84；路由标注 `x-three-phase`，A124）：先在事务里建投递行并占用 `in_progress`，事务外调用通道，再开事务写结果；占用期内的重复请求得到 409 `IDEMPOTENCY_IN_PROGRESS` |
| 乐观锁 | 无 |
| 限流 | `admin.global`；另挂档位 `admin.notify_test`（C68 已登记：每名员工 5 次 / 分，d6:676，与 3.33 合并计数），超限 429 `RATE_LIMITED` |
| 开关 | 无 |
| 对应画板 | A:OpsTemplates 订阅消息页签详情的“测试发送”（toast“已向测试账号发送…订阅消息，请在手机上查看”）；短信页签的“测试发送”按模板发，走 3.33 |
| 出处 | proto-admin-e.md:187；d6:963；13-notify-docs.md:351、425、463；A30 |

**请求**：路径参数 `sceneKey`。请求体 `NotifyTestSendBody`：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `channel` | enum(`TestSendChannel`) | 是 | `wx_subscribe` / `sms` | 测哪个通道：订阅消息页签传 `wx_subscribe`；`sms` 用场景自己的短信渲染（`sms()`）与场景绑定的模板，供核对某个场景的补发文案 |

测试接收人取参数 `notify.test_recipients`（`json` 类型，A107 补登；`phone`、`wxOpenid` 为敏感路径，A146）：`[{ staffId: uuid, phone?: string（11 位手机号）, wxOpenid?: string }]`，按当前员工的 `staffId` 取一项；订阅消息用 `wxOpenid`，短信用 `phone`。参数由 a01 的参数页维护：a01 把 `phone`、`wxOpenid` 登记为敏感值路径，`admin.paramValue.list` 只回脱敏串，保存时原样回传脱敏串表示沿用原值（a01 2.13）；保存要 `sys.param.edit`（仅超级管理员），员工的测试号由超级管理员登记。

**响应**：`NotifyTestSendResult`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `notificationDeliveryId` | string(uuid) | 是 | 测试投递行 | `notification_delivery.id` |
| `channel` | enum(`TestSendChannel`) | 是 | 通道 | `notification_delivery.channel` |
| `status` | enum(`DeliveryStatus`) | 是 | `sent` 或 `failed`（通道拒绝、结果未知都算失败，HTTP 仍为 200） | `notification_delivery.status` |
| `reason` | enum(`DeliveryReason`) \| null | 是 | 失败原因（`provider_rejected`、`user_refused`、`unknown_outcome`） | `notification_delivery.reason` |
| `targetMasked` | string | 是 | 脱敏后的测试接收人 | `notification_delivery.target_masked` |
| `errorCode` / `errorMsg` | string \| null | 是 | 通道错误（如订阅消息 43101 用户拒收、47003 字段不符） | `notification_delivery.error_code`、`notification_delivery.error_msg` |
| `sentAt` | string(date-time) \| null | 是 | 成功时间 | `notification_delivery.sent_at` |

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 场景键不存在 |
| `NOTIFY_SCENE_NOT_CONFIGURABLE` | 409 | 员工场景、只发站内的场景，或该场景没有所选通道（`details.reason = 'no_external_channel'` / `'no_sms_channel'`） |
| `NOTIFY_CHANNEL_NOT_READY` | 409 | 订阅槽位不是 `active`，或短信模板不是 `active` / `suspect`（未配置、报备中、已停用）；`details` 带槽位或模板键与状态 |
| `NOTIFY_TEST_RECIPIENT_MISSING` | 409 | 参数里没有当前员工的测试接收人，或没有所选通道需要的那一项；`details.channel`。提示联系超级管理员在参数配置里登记 |
| `RATE_LIMITED` | 429 | 当前员工一分钟内超过 5 次（与 3.33 合并计数） |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | 同一键的上一次调用仍在进行（可重试） |

**副作用**：

- 第一段（事务）：插入一行直发投递 `notification_delivery: (新建) → sending`（13-notify-docs.md:425）：`notification_id` 为空、`is_direct = true`、`origin = 'direct'`、`purpose = 'test'`、`channel` 取请求、`attempt_no = 1`、`call_started_at` = 当前时刻、`lease_until` = 当前时刻 + 30 秒、`due_at` = 当前时刻、`target_ref` = 手机号或 openid 的 HMAC、`target_masked`、`direct_key` = `test:{sceneKey}:{X-Request-Id}`、短信时 `sms_template_key` 取场景的模板、`provider_template_id` 取槽位或模板的当前值；同事务写审计：`ops` 流，类别 `notify_config`，动作 `notify.scene.test_send`，`target_key` = 场景键，`meta` 带通道、投递 id 与脱敏目标。
- 第二段（事务外）：用注册表里该场景的示例变量渲染（与 3.18 的预览同一份），调用订阅消息或短信通道。不经 `wx_subscribe_quota` 预留额度（有没有额度以微信返回码为准）。
- 第三段（事务）：按结果 `sending → sent`（写 `sent_at`、`finished_at`、`provider_msg_id`，13-notify-docs.md:431）或 `sending → failed`（`provider_rejected` / `user_refused`，请求已发出但结果未知为 `unknown_outcome`，写 `error_code`、`error_msg`、`finished_at`，13-notify-docs.md:433-434）；直发不重试、不补发。
- 可续做：第二段中途进程退出、占用过期后重放时，读到这一行仍是 `sending` 且已写 `call_started_at`，不再调用，直接按 `failed`（`unknown_outcome`）收尾并返回（与租约回收同一规则，13-notify-docs.md:436）。
- 不建通知、不写站内消息、不进场景的近 7 天统计（A30；13-notify-docs.md:351）。不发出站事件。
- 迁移归属：直发建行 `(新建) → sending` 在 x01 的非 HTTP 迁移归属表里已归本接口（13:425）；本接口第三段写的 `sending → sent / failed` 也由本接口承担，租约过期后的 `failed`（`unknown_outcome`）仍归 `notify.scan`（x01 的归属表待补这一行，见 `cross_doc`）。

### 3.24 admin.notificationDelivery.list　发送日志
`GET /admin/notification-deliveries`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.notificationDelivery.list`（路线图 `a09.notification-deliveries.list`） |
| 鉴权 | `staff`；`permission: assert-in-handler`（A45）：模块 `ops` ≥ v 或 `service` ≥ v；数据范围 `global`（排障用） |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 原型无（“发送日志与重发”，05-risks-and-open-issues.md:271；按设计规范第 12 节用筛选表格页） |
| 出处 | d6:965；13-notify-docs.md:353-482；A62 |

**请求**：查询参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `sceneKey` | string | 否 | 可多值 | 场景（经 `notification.notify_scene_key`；直发行没有场景） |
| `channel` | enum(`NotifyChannel`) | 否 | 可多值 | 通道 |
| `status` | enum(`DeliveryStatus`) | 否 | 可多值 | 投递状态 |
| `reason` | enum(`DeliveryReason`) | 否 | 可多值 | 终态原因 |
| `origin` | enum(`DeliveryOrigin`) | 否 | 可多值 | 来源 |
| `purpose` | enum(`DeliveryPurpose`) | 否 | 可多值 | 直发用途（含 `test`） |
| `isDirect` | boolean | 否 | — | 只看直发 / 只看通知投递 |
| `notificationId` | string(uuid) | 否 | — | 某一条通知的全部通道投递 |
| `bizType` / `bizId` | string / string(uuid) | 否 | `bizId` 须同时给 `bizType` | 业务对象（经 `notification.biz_type`、`notification.biz_id`，走 `ix_notification_biz_type_biz_id`） |
| `merchantUserId` / `staffId` | string(uuid) | 否 | — | 接收人 |
| `entityId` / `storeId` | string(uuid) | 否 | — | 通知的归属 |
| `createdFrom` / `createdTo` | string(date) | 否 | 两端都含；默认近 7 天；跨度不超过 92 天 | 建行日期（北京时间） |
| `page` / `pageSize` | integer | 否 | C43 | 页码分页（A62） |
| `sort` | enum | 否 | `-createdAt`（默认）/ `-dueAt` | |

**响应**：`data` 为 `AdminPage<NotificationDeliveryItem>`（`{ items, page, pageSize, total }`，a01，C87）（2.8）。手机号、邮箱只回脱敏串（`target_masked`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 日期跨度超过 92 天；`bizId` 没有 `bizType` |
| `PERMISSION_DENIED` | 403 | `ops`、`service` 两个模块都是 `n` |

**副作用**：无。

**说明**：不支持按手机号查（投递表只存手机号的 HMAC；把手机号放进查询参数会进访问日志），要查某个商家的发送情况按 `merchantUserId` 或业务对象筛选。

### 3.25 admin.notificationDelivery.resend　人工重发
`POST /admin/notification-deliveries/{notificationDeliveryId}/resend`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.notificationDelivery.resend`（路线图 `a09.notification-deliveries.resend`） |
| 鉴权 | `staff`；`notify.resend`（增补，1.1） |
| 回显 | 无 |
| 幂等 | `required`（新建投递行，A17） |
| 乐观锁 | 无；同一通知同一通道的重发序号由唯一约束 `uq_notification_delivery_notification_channel_resend` 兜底 |
| 限流 | `admin.global`（发给商家的频控在投递任务里照常判定） |
| 开关 | 无 |
| 对应画板 | 原型无（发送日志行上的“重发”，填原因） |
| 出处 | d6:966（评审 m12）；13-notify-docs.md:363-364、424 |

**请求**：路径参数 `notificationDeliveryId`（要重发的那一行）。请求体：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `reason` | string | 是 | 1–100 字，非空白 | 重发原因，写进审计 |

**响应**：`data` 为新建的 `NotificationDeliveryItem`（`origin = manual`、`status = pending`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 投递不存在 |
| `NOTIFY_RESEND_NOT_ALLOWED` | 409 | 不满足重发条件，`details.reason`：`status`（不是 `failed` / `skipped`）、`channel`（站内投递）、`direct`（直发，含验证码与测试发送）、`superseded`（该通知在该通道上已有更新的投递，或已有成功的投递）、`scene_disabled`（场景总开关或外部通道开关已关） |

**副作用**（同一事务）：

- 状态：`notification_delivery: (新建) → pending`（`origin = 'manual'`，13-notify-docs.md:424）：同一 `notification_id`、同一 `channel`，`resend_no` = 该通知该通道已有的最大值加 1；`attempt_no = 0`；`due_at` 按场景的发送时段与通道规则重新计算（短信除验证码外过 08:00–21:00 时段）；短信时 `sms_template_key` 取场景当前的模板。
- 发送时照常过守卫（`revalidate()` 为假即 `cancelled`）、额度与频控，由投递任务执行。重发的订阅消息再次失败时补发判定照常进行（13-notify-docs.md:439），但自动补发的短信每个通知至多一条（`resend_no = 0`，`uq_notification_delivery_notification_channel_resend`），已补发过的不再补。
- 审计：`ops` 流，类别 `notify_config`，动作 `notify.delivery.resend`，对象为新行，`reason_text` = 原因，`meta.sourceNotificationDeliveryId` = 原行。
- 不发出站事件。

**说明**：通知中心的服务函数 `notify.resend`（与权限点同名，是两回事）由本接口与 a07 的 `admin.invoiceRequest.resend` 共用：a07 对发票邮件（`notification.biz_type = invoice_doc`、`channel = mail`）调同一个函数，同样新建 `resend_no` 加 1 的投递行、重发条件同本接口；权限点（`finance.invoice.issue`）与审计（类别 `invoice`）由 a07 定，结果经 `notify.mail_delivered` / `notify.mail_failed` 回写（a07 的请求）。

### 3.26 admin.wxTemplateSlot.list　订阅消息模板槽位
`GET /admin/wx-template-slots`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.wxTemplateSlot.list`（路线图 `a09.wx-template-slots.list`） |
| 鉴权 | `staff`；`sys.super_admin`（A45：通道配置仅超级管理员） |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 原型无（“通道配置”，05-risks-and-open-issues.md:271） |
| 出处 | d6:964、786-810；13-notify-docs.md:210-255 |

**请求**：查询参数 `status`（enum(`WxTemplateSlotStatus`)，可多值）、`page`、`pageSize`（默认 100）；按 `slot_key` 排序。

**响应**：`data` 为 `AdminPage<WxTemplateSlotItem>`（`{ items, page, pageSize, total }`，a01，C87）（2.8）。

**错误**：无。

**副作用**：无。

### 3.27 admin.wxTemplateSlot.update　绑定或更换模板 ID
`PATCH /admin/wx-template-slots/{slotKey}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.wxTemplateSlot.update`（路线图 `a09.wx-template-slots.update`） |
| 鉴权 | `staff`；`sys.super_admin` |
| 回显 | 无 |
| 幂等 | `required`（A17） |
| 乐观锁 | 不带：`wx_template_slot` 没有 `lock_version` 列（A47，约定 C52 列为例外）；状态迁移用带原状态条件的单行 UPDATE |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 原型无（通道配置） |
| 出处 | d6:964；13-notify-docs.md:216-249 |

**请求**：路径参数 `slotKey`。请求体（至少一项）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `providerTemplateId` | string | 否 | 1–64 字符；不能清空 | 微信模板 ID → `wx_template_slot.provider_template_id` |
| `title` | string | 否 | 1–32 字 | 模板标题 → `wx_template_slot.title` |
| `fields` | array<{ `name`, `type`, `label` }> | 否 | 1–20 项；`name` 形如 `thing1`；与微信后台逐字一致 | → `wx_template_slot.fields` |

**响应**：`data` 为 `WxTemplateSlotItem`。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 槽位不存在 |
| `VALIDATION_FAILED` | 400 | 一项都没给；`providerTemplateId` 传了空串或 `null` |
| `WX_SLOT_FIELDS_MISMATCH` | 400 | 改后的字段名集合与绑定在本槽位上的某个场景的 `wx()` 返回不一致（13-notify-docs.md:245 的守卫）；`details` 带每个场景期望的字段名与提交的字段名 |

**副作用**（同一事务）：

- 状态：槽位是 `unconfigured` 且本次给了模板 ID 时 `wx_template_slot: unconfigured → active`（13-notify-docs.md:245）；`active` 与 `disabled` 的槽位改模板 ID 不改状态（停用的要另调 3.29 启用）。
- 模板 ID 有变化时 `fail_streak` 清零（新模板重新累计）。写 `updated_at`。
- 审计：`ops` 流，类别 `notify_config`，动作 `notify.wx_slot.update`，`target_type = wx_template_slot`，`target_key` = 槽位键，`before` / `after` 记模板 ID、标题与字段名。
- 提交后 `notify` 配置缓存版本号加 1。不发出站事件。

**说明**：每个环境各自配置模板 ID（13-notify-docs.md:212）；模板只能从类目的公共模板库选，绑定前在微信后台确认关键词与 `expectedFields` 一致。

### 3.28 admin.wxTemplateSlot.disable　人工停用槽位
`POST /admin/wx-template-slots/{slotKey}/disable`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.wxTemplateSlot.disable`（路线图 `a09.wx-template-slots.disable`） |
| 鉴权 | `staff`；`sys.super_admin` |
| 回显 | 无 |
| 幂等 | `required`（状态迁移，A17） |
| 乐观锁 | 不带（A47）；带原状态条件的单行 UPDATE |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 原型无（通道配置） |
| 出处 | 13-notify-docs.md:248 |

**请求**：路径参数 `slotKey`。请求体：`reason`（string，必填，1–100 字），写进审计。

**响应**：`data` 为 `WxTemplateSlotItem`。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 槽位不存在 |
| `STATE_NOT_ALLOWED` | 409 | 槽位不是 `active` |

**副作用**（同一事务）：`wx_template_slot: active → disabled`（`disabled_reason = 'manual'`，13-notify-docs.md:248）；审计动作 `notify.wx_slot.disable`，`reason_text` = 原因；提交后 `notify` 配置缓存版本号加 1。停用期间用到本槽位的订阅投递记 `skipped`（`slot_disabled`），按场景策略补发短信。

### 3.29 admin.wxTemplateSlot.enable　重新启用槽位
`POST /admin/wx-template-slots/{slotKey}/enable`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.wxTemplateSlot.enable`（路线图 `a09.wx-template-slots.enable`） |
| 鉴权 | `staff`；`sys.super_admin` |
| 回显 | 无 |
| 幂等 | `required`（状态迁移，A17） |
| 乐观锁 | 不带（A47） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 原型无（通道配置） |
| 出处 | d6:964；13-notify-docs.md:249 |

**请求**：路径参数 `slotKey`。请求体：`reason`（string，可选，≤100 字）。

**响应**：`data` 为 `WxTemplateSlotItem`。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 槽位不存在 |
| `STATE_NOT_ALLOWED` | 409 | 槽位不是 `disabled`（未配置的槽位用 3.27 绑定模板 ID） |

**副作用**（同一事务）：`wx_template_slot: disabled → active`（13-notify-docs.md:249）：守卫模板 ID 非空；`fail_streak = 0`、`disabled_reason` 置空；审计动作 `notify.wx_slot.enable`；提交后 `notify` 配置缓存版本号加 1。

**说明**：因“模板不存在或已删除”被系统停用的槽位，应先用 3.27 换成有效的模板 ID 再启用，否则下一次发送会再次被停用并告警。

### 3.30 admin.smsTemplate.list　短信模板
`GET /admin/sms-templates`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.smsTemplate.list`（路线图 `a09.sms-templates.list`） |
| 鉴权 | `staff`；模块 `ops` ≥ v（只读；写入 3.31 仍限 `sys.super_admin`） |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsTemplates 的“短信”页签：表格（短信用途、触发时机、近 7 天发送、启用）；右侧详情（模板编号、短信内容、变量、触发时机、接收人、发送时段、测试发送）。通道配置页（原型无）同用本接口 |
| 出处 | proto-admin-e.md:162-200；d6:964、887-938；13-notify-docs.md:257-290 |

**请求**：查询参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `q` | string | 否 | ≤20 字 | 模板显示名或模板键包含（与 3.18 的搜索框同一个输入） |
| `status` | enum(`SmsTemplateStatus`) | 否 | 可多值 | 模板状态 |
| `kind` | enum(`SmsTemplateKind`) | 否 | — | 验证码类 / 通知类 |
| `page` / `pageSize` | integer | 否 | `pageSize` 默认 100 | 模板由迁移播种，总数固定（播种 9 个），前端一次取完 |

排序固定：验证码类在前，其余按代码登记表的顺序（与原型短信页签一致）。

**响应**：`data` 为 `AdminPage<SmsTemplateItem>`（`{ items, page, pageSize, total }`，a01，C87）（2.8）。

**错误**：无。

**副作用**：无。近 7 天统计每行缓存 5 分钟。

**说明**：

- 短信页签列出全部 9 个模板：原型的 6 行（身份验证码 + 5 个补发模板）之外，数据模型另有 `generic_todo`、`account_notice`、`ops_alert`（见第 6 节第 1 项）。行上的“启用”开关 = 模板是否停用，经 3.31 修改，只对超级管理员可点（看 `actions`）；验证码类不可停用。
- 原先放在 `GET /admin/notify-scenes?tab=sms` 的短信页签改到本接口：行是 `sms_template`，按 C10 只能用该表的资源名；读权限随之放宽为 `ops` ≥ v（内容运营要看短信页签），模板编号与签名不是敏感值。
- “身份验证码”的触发时机按 design-spec.md:857 只写“更换手机号时；员工账号激活或重置时”，去掉“后台登录二次验证”（后台第二步用动态口令）。

### 3.31 admin.smsTemplate.update　绑定模板编号与签名、启停模板
`PATCH /admin/sms-templates/{templateKey}`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.smsTemplate.update`（路线图 `a09.sms-templates.update`） |
| 鉴权 | `staff`；`sys.super_admin` |
| 回显 | 无 |
| 幂等 | `required`（A17） |
| 乐观锁 | 不带：`sms_template` 没有 `lock_version` 列（A47） |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | 原型无（通道配置）；A:OpsTemplates 短信页签行上的“启用”开关（超级管理员可点，3.30） |
| 出处 | d6:964、907-909；13-notify-docs.md:257-290 |

**请求**：路径参数 `templateKey`。请求体（至少一项）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `providerTemplateId` | string \| null | 否 | 1–32 字符；`null` 为清空 | → `sms_template.provider_template_id` |
| `signName` | string \| null | 否 | 1–16 字；`null` 为清空 | 短信签名（按环境配置）→ `sms_template.sign_name` |
| `status` | enum | 否 | `active` / `pending_carrier` / `disabled` | 人工设定的状态 → `sms_template.status`；`suspect` 只由系统的失效探测写入，`unconfigured` 由清空推出 |

**响应**：`data` 为 `SmsTemplateItem`。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 模板不存在 |
| `VALIDATION_FAILED` | 400 | 一项都没给 |
| `SMS_TEMPLATE_CONFIG_INVALID` | 400 | `details.reason`：`id_and_sign_required`（要设为 `active` / `pending_carrier`，但改后模板编号或签名为空，`ck_sms_template_configured`）；`verify_not_disablable`（验证码类模板不能停用：更换手机号的验证码与员工账号激活、重置的一次性激活码都依赖它） |

**副作用**（同一事务）：

- 改后状态：请求给了 `status` 就用它；没给时，原状态是 `unconfigured` 且改后编号与签名都有 → `active`；改后编号或签名为空 → `unconfigured`；其余保持原状态（含系统写的 `suspect`）。本表没有状态机（技术状态），不写状态历史。
- 写 `updated_at`。审计：`ops` 流，类别 `notify_config`，动作 `notify.sms_template.update`，`target_type = sms_template`，`target_key` = 模板键，`before` / `after` 记编号、签名与状态。
- 提交后 `notify` 配置缓存版本号加 1。停用的模板不再发送，相关投递记 `skipped`（`unconfigured`）。不发出站事件。

### 3.32 admin.smsTemplate.summary　短信页签计数
`GET /admin/sms-templates/summary`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.smsTemplate.summary`（路线图 `a09.sms-templates.summary`，第二轮新增；A23、C83） |
| 鉴权 | `staff`；模块 `ops` ≥ v |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsTemplates“短信 N”页签上的数字（“订阅消息 N”取 3.19） |
| 出处 | proto-admin-e.md:174-175；C83 |

**请求**：查询参数 `q`（同 3.30，可选）。字面段 `summary` 先于 `/{templateKey}` 注册（A8）。

**响应**：`SmsTemplateSummary`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `total` | integer | 是 | 页签数字，口径与 3.30 不带 `status`、`kind` 时的 `total` 相同 | `sms_template` 计数 |
| `byStatus` | object | 是 | 按状态的计数 `{ active, pending_carrier, unconfigured, suspect, disabled }`（各为 integer），通道配置页提示“尚有 N 个模板未配置”用 | `sms_template.status` |

**错误**：无。

**副作用**：无。

### 3.33 admin.smsTemplate.testSend　按模板测试发送短信
`POST /admin/sms-templates/{templateKey}/test-send`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.smsTemplate.testSend`（路线图 `a09.sms-templates.test-send`，第二轮新增） |
| 鉴权 | `staff`；模块 `ops` = e |
| 回显 | 无 |
| 幂等 | `required`（对外发送，A17）。**三段式用例**，形态同 3.23（先落库：建直发投递行并占用 `in_progress`，事务外调短信通道，再开事务写结果；路由标注 `x-three-phase`）；已登记进 C51（A148） |
| 乐观锁 | 无 |
| 限流 | `admin.global`；档位 `admin.notify_test`（与 3.23 合并计数，每名员工 5 次 / 分；C68 已登记，A148），超限 429 `RATE_LIMITED` |
| 开关 | 无 |
| 对应画板 | A:OpsTemplates 短信页签详情的“测试发送”（toast“已向测试账号发送“身份验证码”短信，请在手机上查看”）：每一行都有，含“身份验证码”这类只用于直发、没有场景的模板 |
| 出处 | proto-admin-e.md:187；OpsTemplates.dc.html 的 `testSend`；d6:963；13-notify-docs.md:425、463 |

**请求**：路径参数 `templateKey`（模板自然键，A3）。请求体：无（传 `{}`）。

测试接收人同 3.23：参数 `notify.test_recipients` 里当前员工那一项的 `phone`。

**响应**：`NotifyTestSendResult`（3.23），`channel = sms`。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 模板键不存在 |
| `NOTIFY_CHANNEL_NOT_READY` | 409 | 模板不是 `active` / `suspect`（未配置、报备中、已停用）；`details` 带模板键与状态 |
| `NOTIFY_TEST_RECIPIENT_MISSING` | 409 | 参数里没有当前员工的测试手机号；`details.channel = sms` |
| `RATE_LIMITED` | 429 | 当前员工一分钟内超过 5 次（与 3.23 合并计数） |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | 同一键的上一次调用仍在进行（可重试） |

**副作用**：同 3.23，差别只在：

- 第一段建行 `notification_delivery: (新建) → sending`（13-notify-docs.md:425）：`purpose = 'test'`、`channel = 'sms'`、`sms_template_key` = 本模板、`provider_template_id` 取模板的当前编号、`direct_key` = `test:sms:{templateKey}:{X-Request-Id}`；审计动作 `notify.sms_template.test_send`，`target_type = sms_template`，`target_key` = 模板键。
- 第二段用注册表里该模板的示例参数渲染（与 3.30 的 `preview` 同一份；验证码类用固定的示例数字，不生成、不落库真实验证码），调短信通道。
- 第三段 `sending → sent / failed`，与 3.23 相同；可续做规则相同。不建通知，不进近 7 天统计，不发出站事件。
- 迁移归属同 3.23：建行与第三段都由本接口承担；x01 归属表 13:425 一行目前只写了 `admin.notifyScene.testSend`，待补本接口（见 `cross_doc`）。

**说明**：按模板测试，是为了让只用于直发的模板（`verify_code`、`account_notice`、`ops_alert`，没有场景用它们）也能测；场景自己的补发文案仍可经 3.23 传 `channel = sms` 测。

### 3.34 admin.homeBanner.summary　Banner 计数与上限
`GET /admin/home-banners/summary`

| 项 | 内容 |
| --- | --- |
| operationId | `admin.homeBanner.summary`（路线图 `a09.home-banners.summary`，第二轮新增；A23、A79、C83） |
| 鉴权 | `staff`；模块 `ops` ≥ v |
| 回显 | 无 |
| 幂等 | `none`（纯查询） |
| 乐观锁 | 无 |
| 限流 | `admin.global` |
| 开关 | 无 |
| 对应画板 | A:OpsHome“Banner”卡片的页头“生效中 N 张 · 最多 5 张” |
| 出处 | proto-admin-e.md:57；OpsHome.dc.html 的 `bannerSub`；14-config-data.md:446-457 |

**请求**：无查询参数（列表 3.10 的筛选只有 `displayState`、`isEnded`，计数按全部 Banner 给，不随筛选变）。字面段 `summary` 先于 `/{homeBannerId}` 注册（A8）。

**响应**：`HomeBannerSummary`（2.6）。

**错误**：无。

**副作用**：无。

**说明**：`maxActive` 是页头上下文（A79），前端不另读参数接口；`live` 按当前时刻现算，与列表行的 `displayState` 同口径。

### 3.35 admin.notice.list　公告列表（V1.1）
`GET /admin/notices`

V1.1，细节待设计。用途：A:OpsNotice“公告”页签列表（标题、类型、展示位置、发布时间、阅读数、状态）；页签“公告 N / 常见问题 N”的计数届时补 `summary`（A23）。与 V1.0 的规则变更公告记录（`site_notice`，3.9）不是同一资源，表结构届时设计（`resources.json` 的 `notices`）。鉴权 `ops` ≥ v；幂等 `none`。出处：proto-admin-e.md:220；路线图 `a09.notices.list`。

### 3.36 admin.notice.create　新建公告（V1.1）
`POST /admin/notices`

V1.1，细节待设计。用途：保存公告草稿（只校验标题；标题 ≤30 字、类型、展示位置至少一个、正文 ≤500 字纯文本）。鉴权 `ops` = e；幂等 `required`。出处：proto-admin-e.md:221。

### 3.37 admin.notice.update　编辑公告（V1.1）
`PATCH /admin/notices/{noticeId}`

V1.1，细节待设计。用途：编辑草稿或定时发布中的公告；带 `lockVersion`。鉴权 `ops` = e；幂等 `required`。出处：proto-admin-e.md:221。

### 3.38 admin.notice.publish　发布公告（V1.1）
`POST /admin/notices/{noticeId}/publish`

V1.1，细节待设计。用途：立即发布，或带发布时间定时发布（须晚于当前时刻，全量校验）；首页公告栏同一时间只显示最新 1 条。鉴权 `ops` = e；幂等 `required`。出处：proto-admin-e.md:221、232。

### 3.39 admin.notice.unpublish　下线公告（V1.1）
`POST /admin/notices/{noticeId}/unpublish`

V1.1，细节待设计。用途：下线已发布或定时发布的公告（A9：草案 `take-offline` 改 `unpublish`）。鉴权 `ops` = e；幂等 `required`。出处：proto-admin-e.md:222。

### 3.40 admin.faq.list　常见问题列表（V1.1）
`GET /admin/faqs`

V1.1，细节待设计。用途：按分类列出常见问题（问题、答案、近 30 天浏览、“有帮助”占比）；分类届时进数据字典（原型写死 6 类，proto-admin-e.md:234）。鉴权 `ops` ≥ v；幂等 `none`。出处：proto-admin-e.md:223。

### 3.41 admin.faq.create　新增常见问题（V1.1）
`POST /admin/faqs`

V1.1，细节待设计。用途：新增问答（问题 ≤40 字、答案 ≤300 字），保存后立即在小程序“帮助中心”更新。鉴权 `ops` = e；幂等 `required`。出处：proto-admin-e.md:224。

### 3.42 admin.faq.update　编辑常见问题（V1.1）
`PATCH /admin/faqs/{faqId}`

V1.1，细节待设计。用途：编辑问答；带 `lockVersion`。鉴权 `ops` = e；幂等 `required`。出处：proto-admin-e.md:224。

### 3.43 admin.faq.delete　删除常见问题（V1.1）
`DELETE /admin/faqs/{faqId}`

V1.1，细节待设计。用途：删除问答（原型无二次确认）。届时按 A7 核对：表结构若不允许物理删除，改为 `POST /admin/faqs/{faqId}/delete`（软删除，C12；A64）。鉴权 `ops` = e；幂等 `required`。出处：proto-admin-e.md:225。

## 4. 枚举

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `AgreementSubjectKind` | `user` / `entity` / `partner` | 同数据模型 `agreement.subject_kind` |
| `AgreementConsentMode` | `checkbox` / `by_action` / `esign` | 同数据模型 `agreement.consent_mode` |
| `AgreementScene` | `login` / `reconsent` / `member_join` / `plan_purchase` / `topup` / `order_submit` / `ad_request` | 同数据模型 `agreement_consent.scene`（`agreement.scenes` 的元素同此） |
| `ProductVersion` | `V1.0` / `V1.1` | 同数据模型 `agreement.since_version`（数据模型的取值带大写 V，按原样出接口） |
| `AgreementVersionStatus` | `draft` / `pending` / `active` / `superseded` / `withdrawn` | 同数据模型 `agreement_version.status` |
| `AgreementVersionDisplayStatus` | 同 `AgreementVersionStatus` 的五个取值 | 本文新增：按 `effective_at` 实时算出的显示状态（2.3），不是簿记列 |
| `AgreementVersionAction` | `edit` / `schedule` / `withdraw` | 本文新增：版本行的 `actions`（C16） |
| `AgreementConsentMethod` | `checkbox` / `by_action` / `prior_consent` | 同数据模型 `agreement_consent.method` |
| `MerchantRole` | `owner` / `clerk` | 同数据模型 `agreement_consent.role` |
| `AgreementConsentBizType` | `billing_order` / `drama_order` / `ad` | 同数据模型 `agreement_consent.biz_type` |
| `ConsentRevealField` | `phone` / `uscc` | 本文新增：同意记录可查看明文的字段（与 a01 `admin.piiReveal.create` 的 `field` 取值一致） |
| `ContentConversionState` | `converted` / `pdf_only` / `unchanged` | 本文新增：协议正文本次处理结果（3.3） |
| `SiteNoticeKind` | `plan_revision` / `billing_param` / `agreement_version` | 同数据模型 `site_notice.kind`（V1.1 加 `ops`），`x-open-enum` |
| `SiteNoticeStatus` | `announced` / `withdrawn` | 同数据模型 `site_notice.status` |
| `SiteNoticeDisplayState` | `scheduled` / `effective` / `withdrawn` | 本文新增：待生效 / 已生效 / 已撤销（2.5） |
| `BannerJumpKind` | `drama` / `mall` / `page` / `none` | 同数据模型 `home_banner.jump_kind` |
| `BannerDisplayState` | `live` / `scheduled` / `ended` / `disabled` | 本文新增：生效中 / 已排期 / 已结束 / 已停用（14-config-data.md:446-453 的派生状态） |
| `BannerAction` | `edit` / `enable` / `disable` | 本文新增：Banner 行的 `actions` |
| `SiteConfigKey` | `mall` / `home_recommend` | 同数据模型 `site_config_revision.config_key`，`x-open-enum`（V1.1 可加） |
| `SiteConfigRevisionStatus` | `draft` / `published` / `archived` | 同数据模型 `site_config_revision.status` |
| `MallSortKey` | `composite` / `heat` / `price_asc` / `price_desc` / `newest` | 同数据模型 `site_config_revision.content` 里 `MallConfig.sorts` 的取值（14-config-data.md:1104）；`heat` 的显示文案按 design-spec.md:854 改 |
| `HomeRecommendTab` | `hot` / `new` | 同数据模型 `HomeRecommendConfig.defaultTab`（14-config-data.md:1114） |
| `ConfigRefIssueReason` | `genre_unknown` / `genre_disabled` / `industry_unknown` / `drama_not_found` / `drama_not_listed` / `drama_not_orderable` | 本文新增：站点配置引用失效的原因（2.7、3.16）；`drama_not_orderable` 为在架但已停止订购或授权已到期（第二轮补） |
| `NotifySceneTab` | `wx` / `other` | 本文新增：场景列表的页签（3.18）；短信页签走短信模板资源（3.30），不在这里 |
| `NotifyAudience` | `merchant` / `staff` | 同数据模型 `notify_scene.audience` |
| `SmsPolicy` | `never` / `fallback` / `always` | 同数据模型 `notify_scene.sms_policy` |
| `SendWindow` | `immediate` / `window` / `scheduled` | 同数据模型 `notify_scene.send_window` |
| `NotifySceneAction` | `update` / `test_send` / `disable` / `enable` | 本文新增：场景行的 `actions`，取 C12 的词（C16）；“补发短信”开关的可用性另用 `canToggleSmsFallback` |
| `WxTemplateSlotStatus` | `active` / `unconfigured` / `disabled` | 同数据模型 `wx_template_slot.status` |
| `WxSlotDisabledReason` | `template_invalid` / `field_mismatch_streak` / `manual` | 同数据模型 `wx_template_slot.disabled_reason` |
| `WxSlotAction` | `update` / `enable` / `disable` | 本文新增：槽位行的 `actions` |
| `SmsTemplateKind` | `verify` / `notice` | 同数据模型 `sms_template.kind` |
| `SmsTemplateStatus` | `active` / `pending_carrier` / `unconfigured` / `suspect` / `disabled` | 同数据模型 `sms_template.status` |
| `SmsTemplateAction` | `update` / `enable` / `disable` / `test_send` | 本文新增：短信模板行的 `actions` |
| `NotifyChannel` | `inbox` / `wx_subscribe` / `sms` / `wecom` / `mail` | 同数据模型 `notification_delivery.channel` |
| `TestSendChannel` | `wx_subscribe` / `sms` | 本文新增：测试发送可选的通道（`NotifyChannel` 的子集，13-notify-docs.md:406） |
| `DeliveryOrigin` | `primary` / `fallback` / `manual` / `direct` | 同数据模型 `notification_delivery.origin` |
| `DeliveryStatus` | `pending` / `sending` / `sent` / `failed` / `skipped` / `cancelled` | 同数据模型 `notification_delivery.status` |
| `DeliveryReason` | `guard_invalid` / `scene_disabled` / `primary_late_success` / `no_target` / `no_quota` / `unconfigured` / `slot_disabled` / `policy_suppressed` / `rate_limited` / `collapsed` / `user_refused` / `provider_rejected` / `retry_exhausted` / `unknown_outcome` / `claim_exhausted` | 同数据模型 `notification_delivery.reason`（按状态配对，13-notify-docs.md:1078-1080） |
| `DeliveryPurpose` | `verify_code` / `staff_activation` / `account_notice` / `ops_alert` / `keepalive` / `test` | 同数据模型 `notification_delivery.purpose` |
| `DeliveryAction` | `resend` | 本文新增：发送日志行的 `actions` |

## 5. 错误码

区间 47100–47199（A70），本文取 47101–47118。全部 `retryable = false`。

| 符号 | 数值 | HTTP | 含义 | `details` |
| --- | --- | --- | --- | --- |
| `BANNER_LIMIT_EXCEEDED` | 47101 | 409 | 同一时间生效的 Banner 将超过上限，请调整生效时间或先停用其他 Banner（d6:1677） | `{ at: string(date-time), activeCount: integer, maxActive: integer }` |
| `BANNER_ORDER_STALE` | 47102 | 409 | Banner 列表已变化，请刷新后重新排序 | `{ missingHomeBannerIds: string[], unknownHomeBannerIds: string[] }` |
| `BANNER_TARGET_INVALID` | 47103 | 400 | 跳转目标无效：短剧不存在、未上架或不可订购，商城分类不存在，页面不可选 | `{ jumpKind: BannerJumpKind, reason: 'drama_not_found' \| 'drama_not_listed' \| 'drama_not_orderable' \| 'category_not_found' \| 'route_not_allowed' \| 'params_invalid' }` |
| `CONFIG_REV_CONFLICT` | 47104 | 409 | 已有人发布过新版本，请刷新后合并再发布（d6:2259） | `{ publishedRevNo: integer, publishedAt: string(date-time), publishedByName: string \| null }` |
| `CONFIG_REF_INVALID` | 47105 | 409 | 配置里引用的题材、行业或短剧已失效，请修改后再发布 | `{ items: ConfigRefIssue[] }` |
| `AGREEMENT_DRAFT_EXISTS` | 47106 | 409 | 该协议已有草稿，请在草稿上继续编辑 | `{ draftAgreementVersionId: string(uuid), versionLabel: string }` |
| `AGREEMENT_DRAFT_INCOMPLETE` | 47107 | 409 | 草稿还不能保存为待生效：请补齐正文文件、变更摘要、生效时间并确认法务审定 | `{ missing: ('pdf' \| 'source' \| 'summary' \| 'effective_at' \| 'legal_approved')[] }` |
| `AGREEMENT_EFFECTIVE_TOO_SOON` | 47108 | 409 | 生效时间须晚于当前时间 10 分钟以上 | `{ earliestEffectiveAt: string(date-time) }` |
| `AGREEMENT_SHORT_NOTICE` | 47109 | 409 | 距生效不足公告期，请推迟生效时间，或由有权限的人员填写原因后保存（d6:2259） | `{ minDays: integer, leadDays: integer, earliestEffectiveAt: string(date-time), canOverride: boolean }` |
| `AGREEMENT_PENDING_EXISTS` | 47110 | 409 | 该协议已有待生效版本，请先撤回或等它生效 | `{ pendingAgreementVersionId: string(uuid), versionLabel: string, effectiveAt: string(date-time) }` |
| `AGREEMENT_WITHDRAW_TOO_LATE` | 47111 | 409 | 版本即将或已经生效，或已有用户同意，不能撤回（d6:2259） | `{ reason: 'effective_soon' \| 'has_consents', effectiveAt: string(date-time) }` |
| `AGREEMENT_CONTENT_CONVERT_FAILED` | 47112 | 400 | Word 正文无法转换为小程序展示格式，请检查文件后重新上传，或只上传 PDF | `{ fileId: string(uuid) }` |
| `NOTIFY_SCENE_NOT_CONFIGURABLE` | 47113 | 409 | 该场景不支持这项设置 | `{ sceneKey: string, reason: 'no_sms_channel' \| 'sms_policy_always' \| 'no_external_channel' \| 'mandatory_scene' }` |
| `NOTIFY_CHANNEL_NOT_READY` | 47114 | 409 | 订阅消息模板或短信模板尚未配置或已停用，暂不能发送 | `{ channel: TestSendChannel, slotKey: string \| null, templateKey: string \| null, status: string }` |
| `NOTIFY_TEST_RECIPIENT_MISSING` | 47115 | 409 | 还没有登记你的测试接收人，请联系超级管理员在参数配置的“测试接收人”里登记 | `{ channel: TestSendChannel }` |
| `NOTIFY_RESEND_NOT_ALLOWED` | 47116 | 409 | 这条投递不能重发（d6:2259） | `{ reason: 'status' \| 'channel' \| 'direct' \| 'superseded' \| 'scene_disabled', status: DeliveryStatus }` |
| `WX_SLOT_FIELDS_MISMATCH` | 47117 | 400 | 模板字段与使用该槽位的场景不一致，请对照微信后台的关键词修改 | `{ expected: { sceneKey: string, fieldNames: string[] }[], actualFieldNames: string[] }` |
| `SMS_TEMPLATE_CONFIG_INVALID` | 47118 | 400 | 短信模板配置不完整或不允许这样修改 | `{ reason: 'id_and_sign_required' \| 'verify_not_disablable' }` |

本文引用的通用码见约定 C27：`VALIDATION_FAILED`、`PERMISSION_DENIED`、`STEP_UP_REQUIRED`、`NOT_FOUND`、`VERSION_CONFLICT`、`STATE_NOT_ALLOWED`、`IDEMPOTENCY_IN_PROGRESS`、`RATE_LIMITED`。引用其他文档定义的领域码：`FILE_NOT_USABLE`（m03-profile-asset，46001）。d6 列的 `AGREEMENT_VERSION_STALE` 已由 m01 定义（47401），本文的接口不返回它。

## 6. 待确认

只留需要产品、业务、法务决定的问题（A108）。初稿的第 3、4、6、7 项已按裁决与其他文档的修订关闭，第 13 项属于数据模型，改为 `cross_doc`（见修订记录第二轮）。第三轮按 A127–A150 核对，下列 9 项都没有被裁决，保留。

| # | 问题 | 默认做法 | 由谁定 |
| --- | --- | --- | --- |
| 1 | 消息模板页“短信”页签列哪些行：原型 6 行（身份验证码 + 5 个补发模板）各带模板编号，对应的是短信模板而不是场景；数据模型播种 9 个模板（另有 `generic_todo`、`account_notice`、`ops_alert`）。行上的“启用”开关在数据模型里没有场景级的列 | 短信页签按 `sms_template` 列出全部 9 个（3.30）；“启用” = 模板是否停用，经 `admin.smsTemplate.update`，只对超级管理员可点，验证码类不可停用；某个场景不想补短信，用订阅消息页签的“补发短信”开关 | 产品 |
| 2 | 场景总开关能否关闭合规类场景 | 注册表把 `m.rule_change_notice`（提前 30 天公告的站内必达，PRD §2.2-8）标为必达，不可关闭（`NOTIFY_SCENE_NOT_CONFIGURABLE`）；退款结果、资质审核结果等是否也标必达，由产品与法务列清单 | 产品、法务 |
| 3 | 协议草稿不能放弃：数据模型允许删除草稿（`trg_agreement_version_guard`），原型与路线图都没有入口 | V1.0 不提供，草稿只能继续编辑；若要，补 `POST /admin/agreement-versions/{agreementVersionId}/discard`（草稿可物理删除，A7 允许） | 产品 |
| 4 | 只传 PDF、没有 Word 的协议版本能否保存为待生效（13 分组待确认第 3 项） | 服务层要求双文件（`AGREEMENT_DRAFT_INCOMPLETE` 的 `source`）；结论相反时去掉这一项校验即可，接口不变 | 产品、法务 |
| 5 | 重新同意进度的口径：已同意人数含该版本生效后新注册用户的首次同意，分母是生效时的快照 | 按此口径，比例封顶 100% | 产品 |
| 6 | `docs.consent.evidence` 的默认角色（a01 的明文查看与 `consent_digest` 签发引用它） | 仅超级管理员，要求再验证；法务取证时临时授予 | 法务 |
| 7 | 协议版本公告的标题：数据模型只要求 `site_notice.title` 1–40 字 | 由服务端生成“{协议名}更新公告”，摘要取版本的变更摘要；不在弹层里另填 | 产品 |
| 8 | 草案的“预览无误”勾选（d6:1059）与 Word / PDF 相似度警告的落点 | 不建勾选；相似度只在新建与编辑的响应里给警告（`conversion.warnings`），不落库 | 产品 |
| 9 | 本文补登的通知场景（2.9 标“补登”的 31 个）的颗粒度与通道：x01 订阅栏里只写“通知商家 / 负责人”的事件，本文按站内分类归并为 `m.order_progress`、`s.delivery_progress` 等少数几个场景 | 按 2.9 归并；补登的商家场景除 `m.account_security`（13 分组已定新微信登录总是发短信）外只发站内（不占订阅槽位、不发短信），员工场景发企业微信与铃铛；要拆细或加外部通道时只改注册表与播种，接口不变 | 产品 |

## 7. 修订记录

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：路线图 `doc = a09-ops` 的 40 条接口（V1.0 31，V1.1 9）；公共结构 8 节；错误码 47101–47118。相对路线图的取舍：场景总开关与通道配置的权限点填 `sys.super_admin`（A45）；新建版本、保存为待生效、发送日志、公告记录声明 `assert-in-handler`；槽位与短信模板的 PATCH 不带 `lockVersion`（A47）；测试发送的投递迁移改为直发的 `(新建) → sending → sent / failed` 并标三段式；短信页签按短信模板列出；协议 V1.0 为 6 份（M9） | A1–A75；C1–C84；13、14 分组；d6 第 2.13、3.2–3.4、4.3、4.5、6 节；proto-admin-e.md 第 1.1–1.5 节 |
| 2026-10-03 | 第二轮。① 裁决：保存为待生效（3.5）与发布站点配置（3.16）按 A105 带 `lockVersion`，写明判定顺序与 `VERSION_CONFLICT`，删去待确认初稿第 6、7 项；Banner 的新增、排序、编辑按 A80、C50 做结果脱敏（`x-redact-on-replay` = `imageUrl`，重放带 `replayed: true`）；测试发送为 C51 已登记的三段式（A84，`x-three-phase`，A124）；协议 PDF 地址 30 分钟（A125）；参数键与审计类别按 A107；场景清单的事件名取 x01 目录（A95）。② 接口：新增 3 条，共 43 条（V1.0 34，V1.1 9）——`admin.homeBanner.summary`（页头“生效中 N 张 · 最多 5 张”，`maxActive` 作页头上下文，A23、A79）、`admin.smsTemplate.summary`、`admin.smsTemplate.testSend`（按模板测试，覆盖没有场景使用的验证码类等模板）；短信页签按 C10 从 `notify-scenes?tab=sms` 移到 `admin.smsTemplate.list`，读权限放宽为 `ops` ≥ v，`NotifySceneTab` 只剩 `wx` / `other`，删 `SmsUsageRow`，用途字段并入 `SmsTemplateItem`（`verify_code` 的直发用途补 `staff_activation`）；场景总开关打开也必填原因。③ 结构：新增 2.9 通知场景清单（播种 32 个 + 补登 29 个：x01 待确认 4 的超时与客服待办、x01 3.7 订阅栏的商家站内场景、m03 的素材反馈、a08 的员工关单通知、m08 与 a08 的“商家补充了说明” `s.kf_supplemented`、人工催办按 `scene` 的映射、`s.export_ready` 的深链）；`MallCategory`（key 格式、唯一、改名不变，“全部”为 `all` 且 `genreCodes = []`）与 `MallBand`（与 m04 同构）；`SiteConfigRefs` 加 `affectedBanners`；Banner 跳转短剧与首页置顶的校验改为在架且可订（`drama_not_orderable`）；Banner 排序集合改为“未结束的”，列表加 `isEnded`，新增 `HomeBannerSummary`；同意记录检索加 `bizId`（走 `ix_agreement_consent_biz_type_biz_id`），`no` 不再解除默认 30 天；`NotifySceneAction` 改用 C12 的词并加 `canToggleSmsFallback`；`StaffRef` 并入 a01 的 `StaffBrief`；`FileBrief` 改名 `AgreementFileBrief`、字段改 `originalName`；同意记录的协议信息保留平铺的 `agreementName`（答复 m01）；“当前版本”调 m01 3.12 的同一个解析函数；`FILE_NOT_USABLE` 写明 `details.reason`；商城搜索的行业兜底写明是参数键、不在商城配置里。④ 其他：测试接收人按 a01 2.13 脱敏回显，`NOTIFY_TEST_RECIPIENT_MISSING` 文案改为联系超级管理员；限流 `admin.notify_test` 已在 C68 登记（按模板测试与之合并计数，待补登）；`sys.super_admin` 的再验证建议与 a01 一致；`homeBannerId`、`banner_click` 属性与 m04、m08 对齐；协议公告 `summary_no_price` 为空时消费方回落 `summary`；`isBarEnabled` 请 a07 跟改；数据模型 14 分组的行号随本轮回写整体后移 21 行，06 分组后移 14 行，13 分组 2.1 节末尾几处重新对齐。⑤ 待确认：初稿第 3、4、6、7 项关闭，第 13 项（草稿替换的文件是否释放）转给数据模型，新增第 9 项（补登场景的颗粒度与通道）。⑥ 清单与路线图切片同步到 43 条：权限点按文档回填（`sys.super_admin` 7 条、`assert-in-handler` 4 条，`admin.smsTemplate.list` 改为模块等级），测试发送的迁移改为直发 `(新建) → sending → sent / failed`，撤回补“复制新草稿”，保存草稿补 `draft → draft`，`tables`、`notes`、`summary` 与文档对齐 | A23、A79、A80、A84、A95、A105、A107、A119、A120、A124、A125；C10、C12、C16、C50、C51、C61、C68、C83；review/xdoc-a09-ops.md、review/r2-xd-a09-ops.md；复核 A 第 0–10 条、B 第 0–16 条 |
| 2026-10-03 | 第三轮。① 公共结构（A132、A150、C87）：与 m01 同名不同构的 `AgreementVersionBrief` 改名 `AdminAgreementVersionBrief`，协议列表查询结构名改为 `AdminAgreementListQuery`；页码分页列表的响应一律写为 a01 的 `AdminPage<T>`，清单删去 8 个 `XxxPage` 结构（含与 m01 同名的 `AgreementConsentPage`）；`SignedUrl` 改为引用 a01，不另定义；清单 `externalSchemas` 补 `AdminPage`、`SignedUrl`。② 登记：`admin.smsTemplate.testSend` 已进 C51（先落库）与 C68 档位 `admin.notify_test`（A148），删去“待补”字样（3.33、清单、切片同步）；`notify.test_recipients` 的 `phone`、`wxOpenid` 为敏感路径，`catalog.search.industry_fallback` 并入待回写清单（A146）。③ 未改：`admin.homeBanner.summary`、`admin.smsTemplate.summary`、`admin.smsTemplate.testSend` 第二轮已在切片与合并路线图里；2.9 深链列的 `ad.detail`、`store.members`（商家端 `DeepLink` 路由键，d6:236、247）与 `drama.edit`（a02 `AdminRouteKey`）是路由键，不是 operationId；本文没有 C86 登记的驳回接口。④ 待确认 9 项都不在 A127–A150 的裁决范围内，保留。接口数不变（43 条） | A132、A146、A148、A150；C51、C68、C86、C87；review/r3-in-a09-ops.md |
| 2026-10-03 | 第四轮。2.9 按 x01 的请求：`m.order_progress` 加 `order.item.launch_rescheduled`，`s.delivery_progress` 加 `ticket.episode_qc_failed`、`package.reissue_opened`；补登商家站内场景 `m.cart_price_changed`（`pricing.drama_price_changed`，选剧单里有该剧的老板）与 `m.refund_initiated`（`payment_exception.refund_requested`），补登场景 29 → 31 个；x01 已登记 `service_ticket.supplemented` 与 `service_ticket.closed` 的订阅者，删去两处“待补”说明（清单删 `eventsPendingX01`）。A147–A156 不涉及本文，接口数不变（43 条） | review/r4-in-a09-ops.md；x01-events-jobs 第 3 节 |
