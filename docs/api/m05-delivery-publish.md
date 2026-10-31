# 商家端：交付与发布

| 项 | 内容 |
| --- | --- |
| 文档 | `m05-delivery-publish` |
| 范围 | 商家端小程序的交付与发布：渠道账号（M:Accounts，含 M:Checkout 选账号、M:Mine 入口）、方案确认（M:Plan、M:OrderDetail 的“查看方案”）、样片确认（M:Sample）、发布任务（M:Publish：上线任务、成片包、逐集下载、发布清单、回填链接、下架确认）、上线记录（M:LaunchRecord）、定制内容授权书（M:Contracts 的授权书页签、M:OrderDetail 的授权书预览）；原型没画的逐集下载页（`sub/publish/downloads`，d7-platform.md:832）；V1.1 的投放数据占位 |
| 接口数 | 29（V1.0 27，V1.1 2） |
| 依据 | 数据模型 `10-delivery.md`（方案、样片、成片包、下载授权与记录、发布清单）、`11-publish.md`（渠道账号与核验提交、上线任务与回填、巡检、下架任务）、`13-notify-docs.md` 2.13–2.14 与第 4 节（授权书与版次）；`09-order-ad.md`（订单项、发布账号、广告位、广告）；草案 d3-flow.md 第 8、10–15 节与附录 B，d5-media.md 第 7.4–7.5、8 节与第 12 节接口清单，d6-notify-docs-data.md 第 3.6 节与接口清单，d7-platform.md 4.10–4.11；接口裁决 A1–A146（第二轮按第十节 A76–A120 修订，第三轮按第十二节 A127–A146 修订）；通用约定 C1–C87；事件目录 x01-events-jobs；设计规范第 11、12 节 |
| 状态 | 第三轮修订（2026-10-03） |

> Q9 当期覆盖（2026-10-29）：样片一期仅小程序内查看、确认必须勾选。四渠道 enum/历史字段/快照保留，旧修订记录不代表当前默认。见 [Q9 工作包](../plan/changes/plan-q9-sample-player.md)；不表示法务、提审或真机通过。

## 1. 概览

本文是老板在小程序里完成“交付与发布”的全部接口：绑定并维护发布用的渠道账号；确认服务经理推送的交付方案或提出修改；在小程序内查看水印样片并勾选确认（Q9 第一期仅 weapp）；查看成片包、重新生成下载授权、逐集签发下载地址并回报“已存相册”；复制发布清单；按订单查看上线任务、回填上线链接提交核验、查看上线记录；确认已下架；查看与下载《定制内容授权书》。店员没有这些能力点，全部接口对店员返回 403。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `m.channelAccount.list` | `GET /m/channel-accounts` | 当前门店的渠道账号列表 | member；`channel.manage` | none（查询） |
| `m.channelAccount.create` | `POST /m/channel-accounts` | 绑定渠道账号并提交核验 | member；`channel.manage` | required |
| `m.channelAccount.submit` | `POST /m/channel-accounts/{channelAccountId}/submit` | 核验未通过后重新提交 | member；`channel.manage` | required |
| `m.channelAccount.unbind` | `POST /m/channel-accounts/{channelAccountId}/unbind` | 解绑渠道账号 | member；`channel.manage` | required |
| `m.deliveryPlan.get` | `GET /m/delivery-plans/{deliveryPlanId}` | 方案确认页 | member；`order.read` | none（查询） |
| `m.deliveryPlan.confirm` | `POST /m/delivery-plans/{deliveryPlanId}/confirm` | 确认方案 | member；`delivery.confirm_plan` | required |
| `m.deliveryPlan.requestChange` | `POST /m/delivery-plans/{deliveryPlanId}/request-change` | 联系服务经理修改 / 补充修改意见 | member；`delivery.confirm_plan` | required |
| `m.orderItem.sample.get` | `GET /m/order-items/{orderItemId}/sample` | 样片确认页 | member；`delivery.confirm_sample` | none（查询） |
| `m.sample.confirm` | `POST /m/samples/{sampleId}/confirm` | 确认小程序样片 {versionNo, viewedVia: weapp, hasViewed: true}，推进到批量合成 | member；`delivery.confirm_sample` | required |
| `m.sample.requestChange` | `POST /m/samples/{sampleId}/request-change` | 对样片提出修改意见（合成问题） | member；`delivery.confirm_sample` | required |
| `m.sample.downloadUrls` | `POST /m/samples/{sampleId}/download-urls` | 历史样片相册接口：第一期仅小程序内查看，鉴权及版本校验后拒绝签发 | member；`delivery.confirm_sample` | none（签发短时地址） |
| `m.orderItem.release.get` | `GET /m/order-items/{orderItemId}/release` | 当前成片包与下载授权 | member；`delivery.download` | none（查询） |
| `m.orderItem.downloadGrant.create` | `POST /m/order-items/{orderItemId}/download-grants` | 重新生成下载授权 | member；`delivery.download` | required |
| `m.orderItem.downloadUrls` | `POST /m/order-items/{orderItemId}/download-urls` | 签发单集下载直链并留痕 | member；`delivery.download` | none（签发短时地址） |
| `m.download.report` | `POST /m/downloads/{downloadId}/report` | 回报保存相册的结果 | member；`delivery.download` | required |
| `m.orderItem.publishList.get` | `GET /m/order-items/{orderItemId}/publish-list` | 发布清单（供复制） | member；`publish.read` | none（查询） |
| `m.launchTask.list` | `GET /m/launch-tasks` | 上线任务（按订单聚合） | member；`publish.read` | none（查询） |
| `m.launchTask.summary` | `GET /m/launch-tasks/summary` | 发布任务页上线一侧的页签计数 | member；`publish.read` | none（查询） |
| `m.launchTask.get` | `GET /m/launch-tasks/{launchTaskId}` | 上线记录（一个账号） | member；`publish.read` | none（查询） |
| `m.launchTask.submit` | `POST /m/launch-tasks/{launchTaskId}/submit` | 回填上线链接并提交核验 | member；`publish.submit_link` | required |
| `m.takedownTask.list` | `GET /m/takedown-tasks` | 下架任务列表 | member；`publish.read` | none（查询） |
| `m.takedownTask.summary` | `GET /m/takedown-tasks/summary` | 发布任务页下架一侧的页签计数 | member；`publish.read` | none（查询） |
| `m.takedownTask.confirm` | `POST /m/takedown-tasks/{takedownTaskId}/confirm` | 确认已下架 | member；`publish.takedown_confirm` | required |
| `m.licenseLetter.list` | `GET /m/license-letters` | 授权书列表 | member；`contract.read` | none（查询） |
| `m.licenseLetter.summary` | `GET /m/license-letters/summary` | 合同页“定制内容授权书 · N” | member；`contract.read` | none（查询） |
| `m.licenseLetter.get` | `GET /m/license-letters/{licenseLetterId}` | 授权书详情（预览） | member；`contract.read` | none（查询） |
| `m.licenseLetter.downloadUrls` | `POST /m/license-letters/{licenseLetterId}/download-urls` | 签发授权书 PDF 的 5 分钟地址 | member；`contract.read` | none（签发短时地址） |
| `m.performanceReport.list` | `GET /m/performance-reports` | V1.1：投放数据 | member；V1.1 定 | none（查询） |
| `m.performanceUpload.create` | `POST /m/performance-uploads` | V1.1：上传作品数据截图 | member；V1.1 定 | required |

字面段先于参数段注册（A8、C12）：`/m/launch-tasks/summary` 先于 `/m/launch-tasks/{launchTaskId}`，`/m/takedown-tasks/summary` 先于 `/m/takedown-tasks/{takedownTaskId}`，`/m/license-letters/summary` 先于 `/m/license-letters/{licenseLetterId}`。

### 1.1 本文通用规则

| 事项 | 规则 |
| --- | --- |
| 鉴权与门店 | 全部 `x-auth: member`，必带 `X-Store-Id`（C17）。能力点取自 d4-identity.md:852-872 的能力表，全部是“老板 ✔、店员 ✘”，所以每条接口 `x-clerk-view: none`，店员调用返回 403 `ROLE_FORBIDDEN`（C55、C56） |
| 已停用门店 | 按能力表的“已停用门店（老板）”一列：`publish.read`、`publish.takedown_confirm`、`delivery.download`、`order.read`、`contract.read` 仍可用（收尾：看发布任务、确认下架、下载成片、看方案与授权书）；`channel.manage`、`publish.submit_link`、`delivery.confirm_plan`、`delivery.confirm_sample` 不可用，由成员关系中间件返回 403 `STORE_ARCHIVED`（C17；符号由 m02-tenant 登记） |
| 数据范围 | 渠道账号、方案、样片、成片包、下载记录、上线与下架任务按 `store_id` = 当前门店；授权书是主体级（`contract.read` 主体级），按 `license_letter.entity_id` = 当前门店所属主体。不在范围内一律 404 `NOT_FOUND`（C24、C29） |
| 对商家显示的员工称呼 | `COALESCE(staff.display_name, staff.name)`（03 分组 2.3：`display_name` 是对商家展示的称呼）。下文写作“员工称呼” |
| 字典项 | 响应里的字典项一律返回 `DictRef`（`{ code, name }`，C85、C87），字段名不带 `Code` / `Codes` 后缀（如题材 `genres`、异常原因 `abnormalReason`）；快照与业务行里存编码，名称按当前字典取 `dict_item.name`（按 `dict_item.dict_type_key` + `dict_item.code`），停用的字典项照常返回名称（读历史不看 `is_enabled`）。本文的请求不收字典编码 |
| 清单条目名称 | 质检、核验、巡检的逐项结论取对应记录的结论数组（`[{ key, result, note }]`），条目名称取 `checklist_template.items[].label`（按记录上的清单编码与版本号），只返回 `merchantVisible = true` 的条目（14 分组 `checklist_template.items`） |
| 签名地址 | 一律 `{ url, expiresAt }`（C60，类型写作 `SignedUrl`，a01 定义、本文引用，C87；带 `fileId` 的图片用 m08 的 `ImageRef`；可播放资产用 m06-ad 2.8 的 `Playable`；单独签发的下载地址用本文 2.1 的 `DownloadUrl`）。随数据返回、不留痕的：海报与封面、修改意见截图、发布清单封面（30 分钟对齐窗口，C61）、样片小程序内播放（60 分钟）。单独签发、逐次留痕的：单集下载（15 分钟）、授权书 PDF（5 分钟）（C61）；样片相册签发由 Q9 禁用，原记录只作历史事实 |
| 结果脱敏 | 幂等为 `required` 且响应带签名地址的 5 条路由（`m.deliveryPlan.confirm`、`m.deliveryPlan.requestChange`、`m.sample.confirm`、`m.sample.requestChange`、`m.takedownTask.confirm`）按 C50 的“结果脱敏”处理：幂等记录只存置空后的结果，置空的字段路径登记为 `x-redact-on-replay`（A80、A124），各接口的“幂等”栏逐条列出；这些字段在 schema 里可空；响应另带 `replayed: boolean`（首次执行为 `false`，同键重放为 `true`），端上见到 `true` 时重新调对应的 GET 取地址 |
| 访问留痕 | 本文签发接口写的访问审计一律 `audit_log.stream = access`、`category = file_access`，动作名见各接口（保存样片 `delivery.sample.album_download`、授权书 PDF `docs.license_letter.download`）；样片旧访问记录按原字段保留；Q9 确认只接受 weapp + 强制勾选，不再以相册/portal/企业微信证据放行，广告规则保持 |
| 日期与天数 | 日期 `YYYY-MM-DD`，“今天”“剩余天数”“距上线天数”按北京时间算（C35） |
| 待办深链 | 首页待办（m04 `m.todo.list` 3.2）的链接参数取本文资源的 id：`deliveryPlanId`（方案确认，3.5）、`orderItemId`（样片、成片包与发布清单、上线记录，3.8、3.12、3.16）、`launchTaskId`（回填链接，3.19、3.20）、`takedownTaskId`（确认下架，3.23）、`channelAccountId`（账号核验未通过，3.1、3.3）；路由键由 m04 定 |
| 订阅消息点位 | 端上在点击时请求订阅（d6-notify-docs-data.md:855-868）：确认方案 `plan_confirm`、确认样片 `sample_confirm`、下载成片 `package_download`、回填链接 `link_submit`、确认已下架 `offline_confirm`；订阅结果由端上报给 m08 的 `m.subscribeResult.create`，本文接口不处理 |
| 文件引用 | 请求里的 `fileId`（主页截图、修改意见截图）必须是当前用户在当前门店上下文登记、已入库（`file_object.status = stored`）、未被拦截（`file_object.moderation_state <> block`）、分类符合用途的文件，否则 400 `FILE_NOT_USABLE`（m03-profile-asset 定义，`files.link()` 的统一出口）；张数与重复只在契约层校验，返回 `VALIDATION_FAILED` |
| 受平台约束的改动 | Q9 样片仅小程序内查看且确认必须勾选；仍不做“按时间点提意见”（设计规范 11 节；A31）；小程序内没有整包下载，只有逐集存相册，整包引导到电脑端下载页（设计规范 11 节；05-risks-and-open-issues.md 1.5）；授权书不写“正式授权书以双方签章版本为准”（设计规范 11 节） |

### 1.2 本文登记给其他模块的守卫计数

不是 HTTP 接口，是 delivery、publish 两个模块注册给其他用例的计数端口（同事务调用），口径在这里定，调用方只引用类别名。

| 端口与类别 | 调用方 | 计数口径 |
| --- | --- | --- |
| `StoreCloseGuard` · `open_delivery_ticket` | m02-tenant 停用门店（`STORE_HAS_OPEN_WORK`） | 本门店 `delivery_ticket.step` 不是 `archived`、`terminated` 的工单数（未归档的交付工单，含到期下架中的） |
| `StoreCloseGuard` · `channel_account_in_review` | 同上 | 本门店 `channel_account.status = pending_verify` 的账号数（审核中的渠道账号） |
| 注销与关闭主体守卫 · `release_online` | m01-account 注销账号（`ACCOUNT_DELETION_BLOCKED`）、a03-merchant 关闭主体（`ENTITY_CLOSE_BLOCKED`） | 本主体名下成片已交付、尚未归档的工单数：`delivery_ticket.step` ∈ {`awaiting_launch`,`launch_verify`,`in_service`,`takedown`}（成片包已推送，上线或下架义务未了结） |

## 2. 公共结构

类型写法按写作规范：`string(uuid)`、`string(date-time)`、`string(date)`、`string(bigint)`、`integer`、`enum(…)`、`boolean`、`array<…>`、`object`，可空写 `| null`。“来源”一列写表列或计算规则。

### 2.1 通用片段

本节之外引用的公共结构（C87，本文不定义）：`SignedUrl`（a01，`{ url, expiresAt }`）、`ImageRef`（m08，`{ fileId, url, expiresAt }`）、`DictRef`（`{ code, name }`，C85；归属由 C87 登记表定）、`Playable`、`PlayableSource`（m06-ad 2.8）、`LicensePeriod`、`LicenseConsent`（p01-portal 2.5）。

**分页外壳**：商家端列表一律是 C42 的游标分页 `{ items, nextCursor, hasMore }`，本文不另定义结构。下文写 `CursorPage<X>` 只是记法（`items` 的元素是 `X`），契约里的名字按列表各起（`ChannelAccountPage`、`LaunchTaskOrderGroupPage`、`TakedownTaskPage`、`LicenseLetterPage`）。

#### `Playable`

不在本文定义：直接引用 m06-ad 2.8 的 `Playable`、`PlayableSource`（全仓唯一定义，C62、C87）。样片取 `playable_asset`（`kind = sample`、`owner_type = order_item`、`source_file_id = sample.file_id`）：`kind = sample`；`posterUrl` 按 m06 2.8 的取法（`playable_asset.cover_file_id`，为空时取源文件的 `media_info.cover_file_id`，30 分钟对齐窗口），不受开关影响；`sources` 一档指向水印版，60 分钟；`autoplay`、`muted` 恒为 `false`。三种情形按 C62（A135）：资产未就绪（`state` 不是 `ready`）时所在字段为 `null`；已就绪但此刻不能在小程序内播放时返回只带海报的对象，`sources = []`、`expiresAt = null`；已就绪且可播放时返回完整对象（规则见 `SampleView.playable`）。

#### `DownloadUrl`

单独签发的文件下载地址（C60）。本文定义，m06-ad 的广告保存相册（原 `AdDownloadUrl`）引用它（A132、C87）。用于 `m.sample.downloadUrls`。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `url` | string | 是 | 预签名下载地址 | 现签（C60） |
| `expiresAt` | string(date-time) | 是 | 到期时刻 | 按 C61 的有效期（保存样片、广告 15 分钟） |
| `fileName` | string | 是 | 建议的保存文件名 | 各接口写明 |
| `sizeBytes` | string(bigint) | 是 | 文件大小，端上据此设下载超时、显示进度 | `file_object.size_bytes`（只签发已入库的文件，`ck_file_object_stored_facts` 保证非空；C33） |

#### `ChecklistItemView`

商家端的清单条目（只含 `merchantVisible = true` 的条目，不带该标记）。商家端 OpenAPI 里只有本文定义这个名字；后台写入与展示用 a05 的 `AdminChecklistItemView`（多 `merchantVisible`），两者不同名（A132、C87）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `key` | string | 是 | 条目键 | 结论数组的 `key` |
| `label` | string | 是 | 条目名称 | `checklist_template.items[].label` |
| `result` | enum(`pass`,`fail`,`na`) | 是 | 结论 | 结论数组的 `result` |
| `note` | string \| null | 是 | 说明 | 结论数组的 `note` |

#### `ChannelAccountBrief`

渠道账号摘要。本文定义，a06-publish 引用（A132、C87）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `channelAccountId` | string(uuid) | 是 | 账号 id | `channel_account.id` |
| `platform` | enum(见 4.1) | 是 | 平台 | `channel_account.platform` |
| `accountName` | string | 是 | 账号名称（当前值） | `channel_account.account_name` |
| `accountUid` | string | 是 | 抖音号或视频号 ID（商家填写原样） | `channel_account.account_uid` |
| `status` | enum(见 4.1) | 是 | 账号状态 | `channel_account.status` |

### 2.2 渠道账号

#### `ChannelAccountCard`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `channelAccountId` | string(uuid) | 是 | 账号 id | `channel_account.id` |
| `platform` | enum(`douyin`,`wechat_channels`) | 是 | 平台 | `channel_account.platform` |
| `accountName` | string | 是 | 账号名称 | `channel_account.account_name` |
| `accountUid` | string | 是 | 抖音号或视频号 ID | `channel_account.account_uid` |
| `status` | enum(`pending_verify`,`available`,`abnormal`,`unbound`) | 是 | 待核验、可用、异常、已解绑 | `channel_account.status` |
| `accountType` | enum(`enterprise`,`personal`,`none`) \| null | 是 | 发布专员核定的认证类型；核验通过前为空 | `channel_account.account_type` |
| `submittedAccountType` | enum(`enterprise`,`personal`,`none`) | 是 | 最近一轮提交时商家选的类型（核定前用于显示） | 最大 `channel_account_submission.round_no` 那一行的 `channel_account_submission.filled_snapshot.accountType` |
| `certSubjectName` | string \| null | 是 | 认证主体名称（企业认证） | `channel_account.cert_subject_name` |
| `abnormalSource` | enum(`verify`,`manual`) \| null | 是 | 异常来源：核验未通过 / 发布专员手动标记 | `channel_account.abnormal_source` |
| `abnormalReason` | `DictRef` \| null | 是 | 异常原因 `{ code, name }`（字典 `reject_reason`，场景 `account_verify`；如“主页截图不完整”；C85） | `channel_account.abnormal_reason_code`，名称取当前 `dict_item.name`（`dict_type_key = reject_reason`） |
| `abnormalNote` | string \| null | 是 | 异常说明与处理指引 | `channel_account.abnormal_note` |
| `roundNo` | integer | 是 | 最近一轮核验的轮次 | 最大 `channel_account_submission.round_no` |
| `submittedAt` | string(date-time) | 是 | 最近一轮提交时间 | `channel_account.submitted_at` |
| `reviewDueAt` | string(date-time) \| null | 是 | 在途核验单的决定时限（“1 个工作日内完成核验”）；没有在途核验单为空 | 在途 `approval_request.due_at`（`kind = channel_account`、`subject_id` = 本账号、`status = pending`） |
| `verifiedAt` | string(date-time) \| null | 是 | 最近一次核验通过时间 | `channel_account.verified_at` |
| `usage` | object | 是 | 使用情况：`{ inProgressCount, toLaunchCount, liveCount }`，分别是引用本账号、阶段为待开工或制作中、待上线、上线中的订单项数（“上线中 3 部 · 待上线 2 部”） | `order_item_account.channel_account_id` 联 `order_item.phase` 计数 |
| `openTakedownTaskCount` | integer | 是 | 本账号上未核查的下架任务数 | `takedown_task` 按 `channel_account_id`、`status` ∈ {`pending_merchant`,`merchant_confirmed`} 计数 |
| `actions` | array<string> | 是 | 可执行动作（C16）：`submit`（`status = abnormal`）；`unbind`（未解绑，且 `usage` 三项与 `openTakedownTaskCount` 都为 0） | 计算 |

### 2.3 方案

#### `DeliveryPlanDetail`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `deliveryPlanId` | string(uuid) | 是 | 方案 id | `delivery_plan.id` |
| `orderId` | string(uuid) | 是 | 订购单 id | `delivery_plan.drama_order_id` |
| `orderNo` | string | 是 | 订单号（“订单 LYX…”） | `drama_order.order_no` |
| `planCode` | string | 是 | 下单时的套餐版本编码，与 `items[].productionModel` 一起显示“高级模型（专业版）” | `drama_order.plan_code` |
| `status` | enum(`drafting`,`pending_confirm`,`revising`,`confirmed`) | 是 | 起草中、待确认、修改中、已确认 | `delivery_plan.status` |
| `currentVersionNo` | integer | 是 | 最近一次推送的版本号；0 = 尚未推送 | `delivery_plan.current_version_no` |
| `confirmedVersionNo` | integer \| null | 是 | 已确认的最新版本号 | `delivery_plan.confirmed_version_no` |
| `confirmedAt` | string(date-time) \| null | 是 | 最近一次确认时间（“您已于 09-28 15:20 确认方案”） | `delivery_plan.confirmed_at` |
| `staffDueAt` | string(date-time) \| null | 是 | 服务经理应推送或答复修改的时间（“1 个工作日内与您确认”） | `delivery_plan.staff_due_at` |
| `isOrderInAfterSale` | boolean | 是 | 订购单有在途取消申请；为真时确认与修改都不可用 | `drama_order.open_cancel_request_id` 非空 |
| `deliveryManagerName` | string \| null | 是 | 服务经理称呼（“服务经理小林”） | `drama_order.delivery_manager_id` → 员工称呼 |
| `version` | `PlanVersionView` \| null | 是 | 当前版本；`drafting` 时为空 | `delivery_plan_version`（`version_no = current_version_no`） |
| `content` | `PlanContentView` \| null | 是 | 当前版本的方案内容；`drafting` 时为空 | `delivery_plan_version.content_snapshot`（`PlanContent`，10 分组第 4 节） |
| `itemCount` | integer | 是 | 剧目数（“2 部”） | `content.items` 的条数 |
| `totalEpisodes` | integer | 是 | 合计集数（“共 140 集”） | 各项 `order_item.episode_count` 之和 |
| `openChange` | object \| null | 是 | 修改中时的汇总：`{ kinds, notes }`，`kinds` 为未解决修改请求的修改项并集（按枚举顺序），`notes` 为未解决修改请求的说明（按提出时间） | `delivery_plan_change_request` 中 `resolved_by_version_no` 为空的行 |
| `changeRequests` | array<`PlanChangeRequestView`> | 是 | 全部修改请求，按提出时间倒序 | `delivery_plan_change_request` |
| `actions` | array<string> | 是 | `confirm`（`status = pending_confirm` 且不在售后中）；`request-change`（`status` ∈ {`pending_confirm`,`revising`} 且不在售后中） | 计算 |

#### `PlanVersionView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `versionNo` | integer | 是 | 版本号 | `delivery_plan_version.version_no` |
| `pushedAt` | string(date-time) | 是 | 推送时间 | `delivery_plan_version.pushed_at` |
| `pushedByName` | string | 是 | 推送人称呼（“服务经理小林于 09-28 11:02 推送”） | `delivery_plan_version.pushed_by_staff_id` → 员工称呼 |
| `changeSummary` | string \| null | 是 | 相对上一版的变更摘要 | `delivery_plan_version.change_summary` |
| `decision` | enum(`confirmed`,`change_requested`,`superseded`) \| null | 是 | 对该版本的决定；未决为空 | `delivery_plan_version.decision` |
| `decidedAt` | string(date-time) \| null | 是 | 决定时间 | `delivery_plan_version.decided_at` |

#### `PlanContentView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `focusTags` | array<string> | 是 | 定制重点 | `content_snapshot.focusTags` |
| `referenceAssets` | array<object> | 是 | 素材库来源的参考素材 `[{ storeAssetId, type, title, contentTags }]`（按快照顺序）；`type` 是媒体类型（图片、视频等）；`contentTags` 为内容标签 `DictRef[]`（字典 `asset_tag`，C85），端上按内容标签汇总，没有内容标签的按 `type` 归入“其他图片 / 视频”；缩略图由端上调 m03 的 `m.storeAsset.list?ids=…`（`storeAssetId` 逗号分隔，至多 20 个，按给定顺序返回；已删除的素材不返回，端上用这里的 `title` 兜底显示“素材已删除”） | `content_snapshot.referenceAssetIds`（只含素材库素材，A142、10-delivery.md:423）联 `store_asset.id`、`store_asset.type`、`store_asset.title`；`contentTags` = `store_asset_tag`（`dimension = content`）的 `tag_code`：有已确认（`is_confirmed`）的只取已确认的，否则取各来源去重（06 分组 2.18“复核后的标签覆盖机器与上传人的”），名称取当前字典 |
| `profileMedia` | array<object> | 是 | 订购时登记的门店档案媒体参考 `[{ fileId, mediaGroup, type }]`：`mediaGroup` ∈ {`door`,`interior`,`product`,`promo`}（门头、店内环境、产品、宣传），`type` ∈ {`image`,`video`}；端上与 `referenceAssets` 合并汇总为“门头与店内环境 8 张、菜品实拍 5 张”（原型标“商家档案”）。不在方案版本快照里，取订购单上的现行登记，各版本相同；不带地址 | `file_ref`（`ref_type = drama_order`、`ref_id` = 方案的订购单、`role = reference`、`state = live`，且没有同文件的 `store_asset_usage`）联同门店 `store_profile_media`（按 `store_id` + `file_id`，含已移除的行）的 `media_group`、`media_kind`；与 a05 `ReferenceFileView` 的 `profile_media` 来源同口径（A142、10-delivery.md:423） |
| `note` | string \| null | 是 | 补充说明 | `content_snapshot.note` |
| `launchMode` | enum(`merchant_self`) | 是 | 发布方式：自助发布（V1.1 增加 `platform`、`partner`） | `content_snapshot.launchMode` |
| `items` | array<`PlanItemView`> | 是 | 逐剧的行 | `content_snapshot.items` |

#### `PlanItemView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderItemId` | string(uuid) | 是 | 订单项 id | `content_snapshot.items[].orderItemId` |
| `dramaTitle` | string | 是 | 剧名 | `order_item.drama_snapshot.title` |
| `genres` | array<`DictRef`> | 是 | 题材 `{ code, name }`（C85、A133；与 m04、a05 一致） | `order_item.drama_snapshot.genreCodes`，名称取当前字典 `genre` |
| `posterUrl` | `SignedUrl` \| null | 是 | 封面（30 分钟对齐窗口）；与 m04 `OrderItemDetail.posterUrl` 同构；结果脱敏时置空 | `order_item.drama_snapshot.posterFileId` 现签 |
| `episodeCount` | integer | 是 | 整部集数 | `order_item.episode_count` |
| `usageEndDate` | string(date) | 是 | 可使用至 | `order_item.usage_end_date` |
| `productionModel` | enum(`standard`,`advanced`,`top`) | 是 | 制作模型 | `order_item.production_model` |
| `accounts` | array<`ChannelAccountBrief`> | 是 | 上线账号（每平台至多 1 个）；`status` 为账号当前状态（“已核验”即 `available`） | `content_snapshot.items[].accounts[].channelAccountId` 联 `channel_account` |
| `placements` | array<`PlanPlacementView`> | 是 | 植入形式与广告 | `content_snapshot.items[].placements` |
| `agreedLaunchDate` | string(date) | 是 | 约定上线日 | `content_snapshot.items[].agreedLaunchDate` |
| `expectedDeliveryDate` | string(date) \| null | 是 | 成片交付预计日 | `content_snapshot.items[].expectedDeliveryDate` |

#### `PlanPlacementView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `slot` | enum(`PlacementSlot`，m06-ad 第 4 节，`x-open-enum`) | 是 | 广告位；V1.0 方案里只出现片头贴片 `opening`、片尾贴片 `ending` | `content_snapshot.items[].placements[].slot` |
| `durationSec` | integer | 是 | 时长（秒） | `content_snapshot.items[].placements[].durationSec` |
| `adId` | string(uuid) | 是 | 广告 id（跳“我的广告”） | `content_snapshot.items[].placements[].adId` |
| `adNo` | string | 是 | 广告编号 | `ad.ad_no` |
| `adDisplayStatus` | enum(`AdDisplayStatus`，m06-ad 第 4 节) | 是 | 商家端显示状态（制作中、待确认、修改中、已确认、已取消），映射由 m06 定义，端上不自行推导（C16）；不返回原始 `ad.status` | `ad.status` 按 m06 的映射 |
| `adCopy` | string \| null | 是 | 广告文案 | `ad.copy` |
| `latestVersionNo` | integer | 是 | 已登记的最新版本号（含已上传未推送的版本；0 = 尚无版本）；不用于“第 N 版预计推送”的文案 | `ad.latest_version_no`（= `ad_version` 的最大 `version_no`） |
| `nextVersionNo` | integer \| null | 是 | 下一次推送的版本号（“第 2 版预计今天推送”）；`adDisplayStatus` 为制作中或修改中时 = 已推送的最大版本号 + 1，其余为 null | `ad_version`（`pushed_at` 非空）的最大 `version_no` + 1 |
| `openRevisionRequestedAt` | string(date-time) \| null | 是 | 在途修改的提出时间（“您于 11:05 提出修改”）；没有在途修改为 null | 本广告在途的 `ad_revision`（`fulfilled_by_version_no` 为空，至多一行，`uq_ad_revision_ad_id_unfulfilled`）的 `created_at` |
| `confirmedVersionNo` | integer \| null | 是 | 已确认版本号 | `ad.confirmed_version_no` |
| `confirmedAt` | string(date-time) \| null | 是 | 最近一次确认时间（“08-16 已确认 · 可直接复用”） | `ad.confirmed_at` |
| `dueAt` | string(date-time) \| null | 是 | 下一版应交付时间（“预计今天推送”） | `ad.due_at` |

#### `PlanChangeRequestView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `changeRequestId` | string(uuid) | 是 | 修改请求 id | `delivery_plan_change_request.id` |
| `onVersionNo` | integer | 是 | 针对的版本 | `delivery_plan_change_request.on_version_no` |
| `kinds` | array<enum(见 4.2)> | 是 | 修改项 | `delivery_plan_change_request.kinds` |
| `note` | string | 是 | 修改说明 | `delivery_plan_change_request.note` |
| `createdAt` | string(date-time) | 是 | 提出时间 | `delivery_plan_change_request.created_at` |
| `resolvedByVersionNo` | integer \| null | 是 | 解决它的版本号；未解决为空 | `delivery_plan_change_request.resolved_by_version_no` |

### 2.4 样片

#### `SampleView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `sampleId` | string(uuid) | 是 | 样片版本 id（确认、提意见、保存都按它） | `sample.id` |
| `orderItemId` | string(uuid) | 是 | 订单项 | 路径参数 |
| `dramaTitle` | string | 是 | 剧名 | `order_item.drama_snapshot.title` |
| `versionNo` | integer | 是 | 版本号（“第 N 版”） | `sample.version_no` |
| `status` | enum(见 4.3) | 是 | `pushed` 待确认、`confirmed` 已确认、`change_requested` 已提出修改、`superseded` 已被取代（重新制作中） | `sample.status` |
| `durationMs` | integer | 是 | 时长 | `sample.duration_ms`（推送过的版本必有） |
| `pushedAt` | string(date-time) | 是 | 推送时间 | `sample.pushed_at` |
| `previewChannels` | array<enum(`weapp`,`album`,`portal`,`wecom`)> | 是 | 历史快照原样返回；Q9 新推送只写 weapp，开关关闭拒绝推送；推送后不回改 | `sample.preview_channels` |
| `adSlots` | array<object> | 是 | 广告位标记 `[{ slot, startMs, endMs, label }]`（“片头贴片 00:00～00:05 · 品牌露出”） | `sample.ad_slots`（`SampleAdSlots`） |
| `adsUsed` | array<object> | 是 | 本版所用广告 `[{ slot, adId, versionNo }]`，供“广告内容的修改到‘我的广告’提出”跳转（A31） | `sample.ad_versions_used` |
| `qcSummary` | array<`ChecklistItemView`> | 是 | 面向商家的质检结果（“画面与音画 已质检”） | `sample.qc_record_id` → `qc_record.results`，条目名取 `qc_record.checklist_code`、`qc_record.checklist_version_no` 对应的模板 |
| `firstViewedAt` | string(date-time) \| null | 是 | 历史相册保存或下载页预览访问时间，只作展示；Q9 GET 不新增访问记录 | `sample.first_viewed_at` |
| `viewEvidence` | object | 是 | 按途径分开的查看证据 `{ albumSavedAt, portalViewedAt }`（各为 string(date-time) \| null）：本版首次保存到相册、首次在电脑端预览的时间 | `albumSavedAt` = 本版最早一条访问审计（`audit_log.stream = access`、`action = delivery.sample.album_download`、`target_type = sample`、`target_id` = 本版）的 `created_at`；`portalViewedAt` 同上，`action = delivery.sample.portal_preview`（p01 写） |
| `offlineSentAt` | string(date-time) \| null | 是 | 交付经理已经企业微信发送水印版的时间（`wecom` 的证据） | `sample.offline_sent_at` |
| `confirmableVia` | array<enum(`PreviewChannel`)> | 是 | 当期只有 weapp 或空数组；确认时提交 weapp，必须另行勾选 | 开关开启、原快照含 weapp、真正水印版 ready，且该样片 pushed/工单 sample_confirm/未暂停时给 weapp；否则为空。确认仍须重验当前版本、广告等守卫，历史查看证据不再提供其他渠道 |
| `viewedAckAt` | string(date-time) \| null | 是 | 商家勾选“我已查看”的时间 | `sample.viewed_ack_at` |
| `decision` | object \| null | 是 | 决定：`{ decidedAt, viewedVia, feedbackKind, feedbackNote, feedbackImages, isOnBehalf }`；`feedbackImages` 为 `array<{ fileId, url, expiresAt }>`，`url`、`expiresAt` 只在结果脱敏的重放里为 null；`isOnBehalf` 为真表示交付经理代录 | `sample.decided_at`、`sample.confirm_viewed_via`、`sample.feedback_kind`、`sample.feedback_note`、`sample.feedback_file_ids`（现签 30 分钟）、`sample.on_behalf_staff_id` 非空 |
| `playable` | `Playable`（m06-ad 2.8）\| null | 是 | 真正水印版 ready 才返回；播放源只在开关开启、原快照含 weapp 且当前版本/门店/订单等播放守卫满足时现签。关闭时 sources=[]、expiresAt=null；不显示替代查看出口。结果脱敏时整体置空 | `playable_asset` 的真实水印派生文件 ready/stored；不接受指向原文件的同步桩 |
| `ticketStep` | enum(同 `delivery_ticket.step`) | 是 | 所属工单当前步骤 | `delivery_ticket.step` |
| `isPaused` | boolean | 是 | 工单暂停中（取消审批中、方案修订待确认），为真时确认与提意见不可用 | `delivery_ticket.pause_count` > 0 |
| `sampleRoundNo` | integer | 是 | 返修轮次 | `delivery_ticket.sample_round_no` |
| `agreedLaunchDate` | string(date) \| null | 是 | 约定上线日（“于 10 月 12 日一次性上线”） | `order_item.agreed_launch_date` |
| `actions` | array<string> | 是 | confirm 还须满足 Q9 可确认守卫；request-change 按原所属后继能力，不因 Q9 新增 | 计算 |

### 2.5 成片包与下载

#### `DownloadGrantView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `downloadGrantId` | string(uuid) | 是 | 授权 id | `download_grant.id` |
| `state` | enum(`active`,`superseded`,`revoked`) | 是 | 技术状态 | `download_grant.state` |
| `expiresAt` | string(date-time) | 是 | 到期时间（“7 天内有效”） | `download_grant.expires_at` |
| `validDays` | integer | 是 | 有效天数快照 | `download_grant.valid_days` |
| `isExpired` | boolean | 是 | 已过期（不设状态，按时间判定） | `now ≥ download_grant.expires_at` |
| `createdAt` | string(date-time) | 是 | 生成时间 | `download_grant.created_at` |

#### `ReleaseView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `deliveryReleaseId` | string(uuid) | 是 | 成片包 id；端上本地进度的键含它 | `delivery_release.id` |
| `orderItemId` | string(uuid) | 是 | 订单项 | `delivery_release.order_item_id` |
| `releaseNo` | integer | 是 | 推送序号 | `delivery_release.release_no` |
| `kind` | enum(`initial`,`reissue`) | 是 | 首次推送、补发 | `delivery_release.kind` |
| `state` | enum(`pushed`,`superseded`,`closed`) | 是 | 生效中、已被取代、已关闭 | `delivery_release.state` |
| `closeReason` | enum(`cancelled`,`usage_ended`) \| null | 是 | 关闭原因 | `delivery_release.close_reason` |
| `pushedAt` | string(date-time) | 是 | 推送时间 | `delivery_release.pushed_at` |
| `episodeCount` | integer | 是 | 视频数（“80 个视频”） | `delivery_release.episode_count` |
| `totalBytes` | string(bigint) | 是 | 总大小（“约 2.6 GB”） | `delivery_release.total_bytes` |
| `changedEpisodeNos` | array<integer> | 是 | 相对上一包变更的集号；补发后端上默认只勾选这些集 | `delivery_release.changed_episode_nos` |
| `episodes` | array<object> | 是 | 逐集 `[{ episodeNo, fileName, sizeBytes, isChanged, lastSavedAt }]`；`sizeBytes` 为 string(bigint)；`lastSavedAt` 为本成片包该集最近一次回报“已存相册”的时间 | `delivery_release.manifest_snapshot`（`episodeNo`、`name`、`size`）；`isChanged` = 集号在 `changed_episode_nos` 内；`lastSavedAt` = `delivery_download_log.client_ack_at` 的最大值（`client_ack = saved`，同一成片包同一集） |
| `savedEpisodeCount` | integer | 是 | 已存相册的集数（发布任务页“下载成片 ✓”据此判断） | `delivery_download_log` 按 `delivery_release_id` 取 `client_ack = saved` 的不同 `episode_no` 计数 |
| `grant` | `DownloadGrantView` \| null | 是 | 本成片包对当前主体的授权：有 `active` 的取它，否则取最近一条；没有为空 | `download_grant`（`delivery_release_id`、`grantee_type = entity`、`grantee_id` = 当前主体） |
| `regrantRemainingToday` | integer | 是 | 今天还能重新生成的次数（每日至多 5 次） | 5 − 今天（北京时间）该订单项 `download_grant.actor_type = merchant` 的行数 |
| `isDownloadable` | boolean | 是 | 现在能否签发单集地址：成片包生效中、授权有效未过期、订单项未关闭且未过使用期 | 按 3.14 的守卫计算 |
| `canRegenerate` | boolean | 是 | 能否重新生成授权 | 按 3.13 的守卫计算 |

#### `PublishListView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderItemId` | string(uuid) | 是 | 订单项 | 路径参数 |
| `releaseNo` | integer | 是 | 生效成片包的推送序号 | `delivery_release.release_no`（`state = pushed`） |
| `collectionName` | string | 是 | 合集名称 | `publish_list.collection_name` |
| `cover` | `ImageRef` \| null | 是 | 合集封面（m08 的 `ImageRef`，A132） | `publish_list.cover_file_id` 现签 30 分钟 |
| `topics` | array<string> | 是 | 话题 | `publish_list.topics` |
| `intro` | string | 是 | 简介 | `publish_list.intro` |
| `isAiDeclarationRequired` | boolean | 是 | 发布时是否需要做 AI 内容声明 | `publish_list.is_ai_declaration_required` |
| `episodes` | array<object> | 是 | 逐集 `[{ episodeNo, title, topics, intro, isUpdated }]`，集号 1..N 全部给出；`isUpdated` 为真表示最近一次补发改了这一集（“已更新”） | `title` = `publish_list_episode.title`，为空时按 `publish_list.title_template` 与 `publish_list_episode.highlight` 渲染；`topics` = `publish_list_episode.topics`，为空时取 `publish_list.topics`；`intro` = `publish_list_episode.intro`，为空时取 `publish_list.intro`；`isUpdated` = `publish_list_episode.changed_in_release_no` 等于 `releaseNo` |
| `text` | string \| null | 是 | 渲染好的整份清单文本（一键复制） | `delivery_release.publish_list_text` |

### 2.6 上线与下架

#### `LaunchSubmissionView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `roundNo` | integer | 是 | 第几轮回填 | `launch_submission.round_no` |
| `linkKind` | enum(`collection`,`episodes`) | 是 | 合集链接、逐集链接 | `launch_submission.link_kind` |
| `collectionUrl` | string \| null | 是 | 合集链接 | `launch_submission.collection_url` |
| `episodeUrlCount` | integer | 是 | 逐集链接条数 | `launch_submission.episode_urls` 的元素数 |
| `reportedEpisodeCount` | integer | 是 | 声明已发布的集数 | `launch_submission.reported_episode_count` |
| `actualLaunchDate` | string(date) | 是 | 实际上线日期 | `launch_submission.actual_launch_date` |
| `submittedAt` | string(date-time) | 是 | 回填时间 | `launch_submission.submitted_at` |
| `result` | enum(见 4.5) | 是 | 本轮结果 | `launch_submission.result` |

#### `LaunchTaskCard`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `launchTaskId` | string(uuid) | 是 | 上线任务 id | `launch_task.id` |
| `orderItemId` | string(uuid) | 是 | 订单项 | `launch_task.order_item_id` |
| `platform` | enum(`douyin`,`wechat_channels`) | 是 | 平台 | `launch_task.platform` |
| `channelAccount` | `ChannelAccountBrief` | 是 | 发布账号（“抖音 @XX火锅”） | `launch_task.channel_account_id` 联 `channel_account` |
| `reviewStatus` | enum(见 4.5) | 是 | `pending` 待发布、`verifying` 核验中、`need_fix` 需补充、`passed` 已通过、`void` 已作废 | `launch_task.review_status` |
| `isLive` | boolean | 是 | 是否已上线 | `launch_task.is_live` |
| `wentLiveAt` | string(date-time) \| null | 是 | 首次上线时间 | `launch_task.went_live_at` |
| `verifiedEpisodeCount` | integer | 是 | 已核验集数（“30/80 集”） | `launch_task.verified_episode_count` |
| `firstLaunchDate` | string(date) \| null | 是 | 实际上线首日（“08-22 上线”） | `launch_task.first_launch_date` |
| `completedAt` | string(date-time) \| null | 是 | 全部集数核验通过的时间 | `launch_task.completed_at` |
| `voidReason` | enum(`terminated`,`usage_expired`,`account_changed`) \| null | 是 | 作废原因 | `launch_task.void_reason` |
| `latestSubmission` | `LaunchSubmissionView` \| null | 是 | 最近一轮回填（“已回填：…”）；没有为空 | 最大 `launch_submission.round_no` |
| `reviewDueAt` | string(date-time) \| null | 是 | 核验中时的决定时限（“1 个工作日内核验”） | 最近一轮的 `approval_request.due_at`（`launch_submission.approval_request_id`） |
| `returnInfo` | object \| null | 是 | 需补充时的退回原因：`{ reasons, note, decidedAt }`，`reasons` 为 `DictRef[]`（字典 `reject_reason`，C85） | 最近一轮 `result = returned` 的 `approval_request.reason_codes`（名称取当前字典 `reject_reason`）、`approval_request.decision_note`、`approval_request.decided_at` |
| `actions` | array<string> | 是 | `submit`：`reviewStatus` ∈ {`pending`,`need_fix`}，或 `passed` 且未满集；工单在待上线、上线核验或服务中且未暂停；今天未过使用期止日 | 计算（守卫见 3.20） |

#### `LaunchTaskOrderGroup`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderId` | string(uuid) | 是 | 订购单 | `order_item.drama_order_id` |
| `orderNo` | string | 是 | 订单号 | `drama_order.order_no` |
| `agreedLaunchDate` | string(date) \| null | 是 | 本组最早的约定上线日（上线日卡“10 月 12 日 · 周一”） | 组内 `order_item.agreed_launch_date` 的最小值 |
| `daysUntilLaunch` | integer \| null | 是 | 距约定上线日的天数（“还有 3 天”）；负数为已逾期天数 | `agreedLaunchDate` − 今天 |
| `items` | array<`LaunchTaskItem`> | 是 | 组内各剧 | — |

#### `LaunchTaskItem`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderItemId` | string(uuid) | 是 | 订单项 | `order_item.id` |
| `dramaTitle` | string | 是 | 剧名 | `order_item.drama_snapshot.title` |
| `posterUrl` | `SignedUrl` \| null | 是 | 封面（42 × 56 缩略图，30 分钟对齐窗口）；与 m04 同构 | `order_item.drama_snapshot.posterFileId` 现签 |
| `episodeCount` | integer | 是 | 整部集数 | `order_item.episode_count` |
| `phase` | enum(同 `order_item.phase`) | 是 | 订单项阶段 | `order_item.phase` |
| `liveEpisodeCount` | integer | 是 | 已核验上线集数 | `order_item.live_episode_count` |
| `agreedLaunchDate` | string(date) \| null | 是 | 约定上线日 | `order_item.agreed_launch_date` |
| `usageEndDate` | string(date) | 是 | 使用期止日 | `order_item.usage_end_date` |
| `ticketStep` | enum(同 `delivery_ticket.step`) | 是 | 工单步骤 | `delivery_ticket.step` |
| `isPaused` | boolean | 是 | 工单暂停中 | `delivery_ticket.pause_count` > 0 |
| `release` | object \| null | 是 | 成片包摘要 `{ deliveryReleaseId, releaseNo, episodeCount, totalBytes, grantExpiresAt, isGrantValid, savedEpisodeCount, hasChangedEpisodes }`（“80 个视频 · 约 2.6 GB · 7 天内有效”）；未推送为空 | `ReleaseView` 的同名字段；`grantExpiresAt` = 有效授权的 `download_grant.expires_at`；`hasChangedEpisodes` = `delivery_release.changed_episode_nos` 非空 |
| `tasks` | array<`LaunchTaskCard`> | 是 | 该剧在各账号上的上线任务：`tab` 为 `todo`、`done` 时按页签过滤，`tab = all` 时不过滤（含已作废） | `launch_task` |

#### `PatrolRecordView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `patrolTaskId` | string(uuid) | 是 | 巡检任务 id | `patrol_task.id` |
| `status` | enum(`normal`,`abnormal`,`recovered`) | 是 | 结论 | `patrol_task.status` |
| `checkedAt` | string(date-time) | 是 | 巡检日期（“09-29 巡检”） | `patrol_task.checked_at` |
| `checkedByName` | string \| null | 是 | 巡检人称呼（“发布专员陈默”）；是否展示见第 6 节第 3 项 | `patrol_task.checked_by_staff_id` → 员工称呼 |
| `results` | array<`ChecklistItemView`> | 是 | 检查项（“5 项检查全部通过”） | `patrol_task.results`，模板 `patrol_task.checklist_code`、`patrol_task.checklist_version_no` |
| `abnormalKind` | `DictRef` \| null | 是 | 异常类型 `{ code, name }`（字典 `patrol_issue`，C85） | `patrol_task.abnormal_kind_code`，名称取当前 `dict_item.name`（`dict_type_key = patrol_issue`） |
| `note` | string \| null | 是 | 说明 | `patrol_task.note` |
| `foundAt` | string(date-time) \| null | 是 | 发现异常时间 | `patrol_task.found_at` |
| `recoveredAt` | string(date-time) \| null | 是 | 复查已恢复时间 | `patrol_task.recovered_at` |

#### `LaunchTaskDetail`

上线记录页（M:LaunchRecord）一个账号的区块。画板按“剧 × 账号”分区块：端上先用 `m.launchTask.list?orderItemId=…&tab=all` 取该剧在各账号上的全部任务（不按页签过滤，已全部核验通过的、已作废的都在内），再对每个任务调 `m.launchTask.get` 取核验项、时间线与巡检记录（这些只在本结构里，列表不带）。页头（剧名、题材、整部集数、阶段、订单号、使用期、剩余天数）只以 m04 的 `m.orderItem.get` 为准，本结构不带订单项头部（第三轮按 m04 的请求删去 `orderItem`）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `task` | `LaunchTaskCard` | 是 | 任务本身 | 见 `LaunchTaskCard` |
| `accountType` | enum(`enterprise`,`personal`,`none`) \| null | 是 | 账号认证类型（“企业认证”） | `channel_account.account_type` |
| `launch` | object \| null | 是 | 最近一条已通过回填：`{ linkKind, collectionUrl, episodeUrls, reportedEpisodeCount, verifiedEpisodeCount, actualLaunchDate, verifiedAt, verifiedByName }`；`episodeUrls` 为 `[{ episodeNo, url }]`；没有已通过的回填为空 | `result` ∈ {`passed`,`passed_partial`} 且轮次最大的 `launch_submission`（`link_kind`、`collection_url`、`episode_urls`、`reported_episode_count`、`verified_episode_count`、`actual_launch_date`）；`verifiedAt` = `approval_request.decided_at`；`verifiedByName` = `approval_request.decided_by_staff_id` → 员工称呼 |
| `verifyChecks` | array<`ChecklistItemView`> | 是 | 核验项（“集数完整、发布账号与授权书一致、‘广告’标识清晰可见、未声明原创”） | 上述回填对应的 `approval_request.checklist_result`，模板 `approval_request.checklist_code`、`approval_request.checklist_version_no` |
| `timeline` | array<object> | 是 | 回填与核验时间线，按时间正序：`[{ kind, at, roundNo, linkKind, reportedEpisodeCount, verifiedEpisodeCount, reasons, note }]`（`reasons` 为 `DictRef[]`，字典 `reject_reason`，C85；没有原因为 `[]`）；`kind` 取 `created`（任务生成：成片包与发布清单已交付）、`submitted`（回填）、`passed`、`passed_partial`、`returned`、`revoked`、`withdrawn`、`voided`；`linkKind`（`collection` / `episodes` / null）供“回填合集链接”“回填逐集链接”的文案，`created`、`voided` 为 null | `created` = `launch_task.created_at`；`submitted` = 商家回填的各轮 `launch_submission.submitted_at` 与 `link_kind`，撤销后重开的行（`reopen_of_launch_submission_id` 非空，照抄了原行的 `submitted_at`）不生成 `submitted` 条目；`passed`、`passed_partial`、`returned`、`withdrawn` = 各轮 `launch_submission.result` 与对应 `approval_request.decided_at`、`approval_request.reason_codes`（名称取字典 `reject_reason`）、`approval_request.decision_note`；`revoked` 的时间取本任务 `status_transition`（`machine = launch_task`、`event = launch.verify_revoke`）的 `occurred_at`，不取原审批单的 `decided_at`（撤销时原审批单保持 `approved` 不动，11-publish.md:402）；`voided` = 本任务 `status_transition`（`machine = launch_task`、`to_state = void`）的 `occurred_at` |
| `patrols` | array<`PatrolRecordView`> | 是 | 作品巡检记录（只含已给出结论的），按巡检时间倒序 | `patrol_task`（`launch_task_id` = 本任务，`status` ∈ {`normal`,`abnormal`,`recovered`}） |

#### `TakedownTaskCard`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `takedownTaskId` | string(uuid) | 是 | 下架任务 id | `takedown_task.id` |
| `orderId` | string(uuid) | 是 | 订购单 | `order_item.drama_order_id` |
| `orderNo` | string | 是 | 订单号 | `drama_order.order_no` |
| `orderItemId` | string(uuid) | 是 | 订单项 | `takedown_task.order_item_id` |
| `dramaTitle` | string | 是 | 剧名 | `order_item.drama_snapshot.title` |
| `posterUrl` | `SignedUrl` \| null | 是 | 封面（30 分钟对齐窗口）；与 m04 同构；结果脱敏时置空 | `order_item.drama_snapshot.posterFileId` 现签 |
| `episodeCount` | integer | 是 | 整部集数 | `order_item.episode_count` |
| `channelAccount` | `ChannelAccountBrief` | 是 | 发布账号 | `takedown_task.channel_account_id` 联 `channel_account` |
| `triggerKind` | enum(见 4.6) | 是 | 生成原因：到期、提前结束、平台原因终止、交付后未上线即终止 | `takedown_task.trigger_kind` |
| `basis` | enum(`live`,`delivered_unverified`) | 是 | 已核验上线 / 已交付未核验 | `takedown_task.basis` |
| `usageEndDate` | string(date) | 是 | 使用期止日 | `takedown_task.usage_end_date` |
| `dueDate` | string(date) | 是 | 应完成下架的日期 | `takedown_task.due_date` |
| `isOverdue` | boolean | 是 | 已过应完成日仍未确认 | `status = pending_merchant` 且今天 > `takedown_task.due_date` |
| `status` | enum(见 4.6) | 是 | 待商家下架、商家已确认、已核查（作废的不返回） | `takedown_task.status` |
| `allowedMethods` | array<enum(`delete`,`private`,`not_published`)> | 是 | 可选下架方式；`not_published` 仅 `basis = delivered_unverified` | 计算 |
| `merchantMethod` | enum(`delete`,`private`,`not_published`) \| null | 是 | 已确认的方式；商家未确认、由发布专员核查确认“该账号下无本剧作品”直接核查通过的任务（`pending_merchant → checked`，11-publish.md:655）为 null | `takedown_task.merchant_method` |
| `merchantConfirmedAt` | string(date-time) \| null | 是 | 确认时间；同上，商家未确认的为 null | `takedown_task.merchant_confirmed_at` |
| `checkedAt` | string(date-time) \| null | 是 | 平台核查完成时间 | `takedown_task.checked_at` |
| `stillOnlineCount` | integer | 是 | 被抽查仍在线的次数（大于 0 时提示“平台核查发现仍在线，请重新下架”） | `takedown_task.still_online_count` |
| `escalatedAt` | string(date-time) \| null | 是 | 最近一次升级时间 | `takedown_task.escalated_at` |
| `actions` | array<string> | 是 | `confirm`：`status = pending_merchant` | 计算 |

### 2.7 授权书

#### `LicenseLetterCard`

授权书的展示要素优先取当前版次的快照（`license_letter_revision.letter_snapshot`，13 分组第 4 节）；首版尚未出件（`current_revision_id` 为空）时，剧名、集数、账号名回落到订单项与账号的当前值，并以 `isRendering` 提示“授权书生成中”。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `licenseLetterId` | string(uuid) | 是 | 授权书 id | `license_letter.id` |
| `letterNo` | string | 是 | 授权书编号 | `license_letter.letter_no` |
| `orderId` | string(uuid) | 是 | 订购单 | `license_letter.drama_order_id` |
| `orderNo` | string | 是 | 订单号（“订单 LYX…”） | `letter_snapshot.orderNo`；未出件时 `drama_order.order_no` |
| `orderItemId` | string(uuid) | 是 | 订单项 | `license_letter.order_item_id` |
| `storeId` | string(uuid) | 是 | 下单门店 | `license_letter.store_id` |
| `dramaTitle` | string | 是 | 剧名 | `letter_snapshot.drama.name`；未出件时 `order_item.drama_snapshot.title` |
| `episodeCount` | integer | 是 | 整部集数 | `letter_snapshot.drama.episodes`；未出件时 `order_item.episode_count` |
| `platform` | enum(`douyin`,`wechat_channels`) | 是 | 授权平台 | `license_letter.platform` |
| `accountName` | string | 是 | 授权账号名称（“抖音 @XX火锅”） | `letter_snapshot.account.name`；未出件时 `channel_account.account_name` |
| `status` | enum(`pending_effective`,`effective`,`voided`) | 是 | 落库状态 | `license_letter.status` |
| `displayStatus` | enum(`pending_effective`,`effective`,`expired`,`voided`) | 是 | 显示状态：`effective` 且止日早于今天为 `expired`（“已失效”，派生，不落库） | `license_letter.status`、`license_letter.period_end` |
| `periodStartDate` | string(date) \| null | 是 | 使用期起始日；未上线为空（“自上线首日起”）。第三轮按 C15 的 `…Date` 后缀由 `periodStart` 改名 | `license_letter.period_start` |
| `periodEndDate` | string(date) | 是 | 使用期止日（同上，原 `periodEnd`） | `license_letter.period_end` |
| `createdAt` | string(date-time) | 是 | 生成时间 | `license_letter.created_at` |
| `currentRevNo` | integer \| null | 是 | 当前版次（“第 N 版”） | `license_letter.current_revision_id` → `license_letter_revision.rev_no` |
| `issuedAt` | string(date-time) \| null | 是 | 当前版次出件时间 | `license_letter_revision.ready_at` |
| `isRendering` | boolean | 是 | 有排队或渲染中的新版次，或首版未出件（“授权书生成中”） | 本信件存在 `render_status` ∈ {`queued`,`rendering`,`failed`} 且版次号大于当前版次的 `license_letter_revision` |
| `voidReason` | enum(见 4.7) \| null | 是 | 作废原因 | `license_letter.void_reason` |
| `voidedAt` | string(date-time) \| null | 是 | 作废时间 | `license_letter.voided_at` |
| `canDownload` | boolean | 是 | 有可下载的已出件版次 | `license_letter.current_revision_id` 非空 |
| `renderIssue` | `LicenseRenderIssue` \| null | 是 | 最新版次的缺字诊断，结构见下文 | 判权后按有效认领读取审计投影 |

`renderIssue` 为必有的 `LicenseRenderIssue | null`：最新有效失败认领的缺字诊断；
成功、再次认领、作废后为空。缺字项包含具体字符 `character`、`U+` 码点 `codePoint`、
固定字段路径 `fields`（最多4项）；`missing` 最多32个不同码点，
`totalMissingCodePoints` 是总数，`truncated` 标识超出部分。诊断不含整段主体资料，
服务重启后仍按同版次持久结果读取。类型结构以实际契约为准。

#### `LicenseLetterDetail`

`LicenseLetterCard` 的全部字段，另加：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `preview` | `LicenseLetterPreview` \| null | 是 | 当前版次的预览内容；首版未出件为空 | `license_letter_revision.letter_snapshot`（当前版次） |
| `revisions` | array<object> | 是 | 已出件的各版 `[{ revNo, reason, issuedAt }]`，按版次倒序（“平台续得版权的，授权期限同步顺延，可重新下载”） | `license_letter_revision.rev_no`、`license_letter_revision.reason`、`license_letter_revision.ready_at`（`render_status = ready`） |

#### `LicenseLetterPreview`

对应 PRD 10.5 的 7 项要素（13 分组第 4 节 `letter_snapshot`）。统一社会信用代码在快照里是明文（印在 PDF 上），接口只返回脱敏串（C40）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `licensorName` | string | 是 | 授权方 | `letter_snapshot.licensor.name` |
| `licensorCreditCodeMask` | string | 是 | 授权方信用代码（脱敏） | `letter_snapshot.licensor.creditCode` 脱敏 |
| `licenseeName` | string | 是 | 被授权方（营业执照主体） | `letter_snapshot.licensee.name` |
| `licenseeCreditCodeMask` | string | 是 | 被授权方信用代码（脱敏） | `letter_snapshot.licensee.creditCode` 脱敏 |
| `storeName` | string | 是 | 下单门店 | `letter_snapshot.licensee.store` |
| `dramaName` | string | 是 | 剧名（“《巷口那家店》第 1～80 集”） | `letter_snapshot.drama.name` |
| `episodes` | integer | 是 | 集数 | `letter_snapshot.drama.episodes` |
| `permits` | array<object> | 是 | 许可信息 `[{ kind, number, platform }]`（`kind` 为许可种类编码） | `letter_snapshot.drama.permits` |
| `account` | object | 是 | 授权平台与账号 `{ platform, name, accountId }` | `letter_snapshot.account` |
| `period` | `LicensePeriod`（p01-portal 2.5） | 是 | 授权期限与地域 `{ startDate, startText, endDate, territory }`；未上线时 `startDate` 为空、`startText` 为“自上线首日起”（与下载页验真共用一份结构，C87） | `letter_snapshot.period`（`start` → `startDate`、`end` → `endDate`） |
| `clauses` | array<object> | 是 | 权利范围、专属声明、到期下架义务 `[{ key, title, text }]` | `letter_snapshot.rightsClauseKey`、`exclusiveClauseKey`、`obligationClauseKey`，文本取 `license_letter_revision.template_version` 对应的模板（代码仓库内版本化） |
| `consent` | `LicenseConsent`（p01-portal 2.5） | 是 | 订购时的同意记录 `{ consentNo, agreementName, consentedAt, operatorMask }`（`operatorMask` 为“王*（138****5678）”形式，快照里已脱敏） | `letter_snapshot.consent`（`agreement` → `agreementName`、`at` → `consentedAt`、`by` → `operatorMask`） |
| `revNo` | integer | 是 | 版次 | `letter_snapshot.revNo` |
| `issuedAt` | string(date-time) | 是 | 出具时间 | `letter_snapshot.issuedAt` |
| `verifyUrl` | string | 是 | 验真页地址，带版次：`https://portal.<域名>/v?code=<验真码>&rev=<版次>`（A37、A100、C1）；与 PDF 上二维码的地址相同；对齐函数插入版次（`queued`）时随快照写入，之后不可改（13-notify-docs.md:1156，A145） | `letter_snapshot.verifyUrl` |
| `contentFp` | string | 是 | 内容指纹（印在 PDF 页脚） | `license_letter_revision.content_fp` |
| `signMode` | enum(`platform_cert`,`esign_seal`,`stamp`) | 是 | 签署方式 | `license_letter_revision.sign_mode` |

## 3. 接口

### 3.1 m.channelAccount.list　渠道账号列表

`GET /m/channel-accounts`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `channel.manage`；已停用门店 403 `STORE_ARCHIVED` |
| 店员视图 | `none`（店员 403 `ROLE_FORBIDDEN`） |
| 幂等 | none（纯查询，A18） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Accounts（M26）；M:Checkout（确认订购页选发布账号）；M:Mine（“渠道账号”入口） |
| 出处 | 路线图 `m05.channel-account.list`；d3-flow.md:3514；proto-merchant-b.md:176；proto-merchant-a.md:350 |

**请求**

路径参数：无。

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `status` | enum，逗号分隔多值 | 否 | `pending_verify`、`available`、`abnormal` | 缺省返回三种未解绑状态；已解绑的账号不返回。确认订购页不传（要列出异常、待核验的账号与“补充后可选 ›”入口），由端上只让 `available` 的账号可选 |
| 查询 | `platform` | enum | 否 | `douyin`、`wechat_channels` | 按平台筛 |
| 查询 | `cursor` | string | 否 | — | C42 |
| 查询 | `limit` | integer | 否 | 1–50，默认 20 | C42 |

请求体：无。

**响应**：`CursorPage<ChannelAccountCard>`。排序固定：异常在前，其后待核验、可用；同状态按绑定时间（`channel_account.created_at`）升序。

**错误**：无（只有通用错误）。

**副作用**：无。

**说明**：
- 确认订购页“每个平台最多 1 个、只可选可用账号”由订购接口校验（m04）；本接口只提供数据。确认订购页的异常账号显示“核验未通过 · 主页截图不完整，补充后可选 ›”（原因取 `abnormalReason.name`），点击进入 M:Accounts 走 `m.channelAccount.submit`；待核验的显示“核验中”，均不可选（Checkout.dc.html:43）。
- 原型的视频号“已认证”与 PRD 的三种认证类型不一致（proto-merchant-b.md:183）：未核定时显示 `submittedAccountType`，核定后显示 `accountType`。

### 3.2 m.channelAccount.create　绑定渠道账号

`POST /m/channel-accounts`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `channel.manage`；已停用门店 403 `STORE_ARCHIVED` |
| 店员视图 | `none` |
| 幂等 | required |
| 乐观锁 | 无（新建） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Accounts（“绑定新账号”表单，M27） |
| 出处 | 路线图 `m05.channel-account.create`；d3-flow.md:2037；11-publish.md:129；proto-merchant-b.md:176；05-risks-and-open-issues.md:193 |

**请求**

请求体（`ChannelAccountCreateBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `platform` | enum | 是 | `douyin`、`wechat_channels` | 平台；创建后不可改。落 `channel_account.platform` |
| `accountName` | string | 是 | 1–30 字（本稿补充，契约层） | 账号名称，与平台主页一致。落 `channel_account.account_name` |
| `accountUid` | string | 是 | 1–64 字符 | 抖音号或视频号 ID，原样落 `channel_account.account_uid`；去空格、转小写后落 `channel_account.account_uid_norm` 并判唯一 |
| `accountType` | enum | 是 | `enterprise`、`personal`、`none` | 商家选的认证类型（PRD 必填，原型缺，按 PRD 补）；只进本轮提交快照 `channel_account_submission.filled_snapshot.accountType`，核定值由发布专员核验时写（M72） |
| `screenshotFileIds` | array<string(uuid)> | 是 | 1–3 个，不重复；文件须已入库（`stored`）、未被拦截、分类 `channel_screenshot`、属本门店（见 1.1“文件引用”） | 主页截图（含账号名称、ID 与认证信息）。落 `channel_account_submission.screenshot_file_ids`，经 `file_ref` 登记 |

**响应**：`ChannelAccountCard`（`status = pending_verify`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STORE_NOT_QUALIFIED` | 409 | 门店闸门不满足（`profile.storeGate` 为 `blocked`，不是 `full` / `parallel`）：首店资质未提交、已驳回待补正或终局驳回，或新增门店资质未通过（d3-flow.md:2037、431）；共用领域码，m04-mall-order 定义（45008，A77、C28），`details = { storeId, reason }`，判定函数与订购同源 |
| `CHANNEL_ACCOUNT_TAKEN` | 409 | 同一平台同一账号 ID 已被未解绑的账号占用（`uq_channel_account_platform_uid_active`；不透露是哪家门店） |
| `FILE_NOT_USABLE` | 400 | 截图未入库、已被内容安全拦截、分类不是 `channel_screenshot`，或不是当前用户在本门店登记的（m03-profile-asset 定义，`details.fileIds`、`details.reason`） |
| `VALIDATION_FAILED` | 400 | 截图张数不在 1–3、有重复（`fieldErrors` 指向 `screenshotFileIds`） |

**副作用**（同一事务）：
- `channel_account.status`：（新建）→ `pending_verify`（`account.bind`，11-publish.md:129）；写 `submitted_at`；`status_transition`（`machine = channel_account`，`state_field = status`）与一行活动流审计（M31）。
- 建第 1 轮 `channel_account_submission`：`kind = new_binding`、`round_no = 1`、`filled_snapshot = { platform, accountName, accountUid, accountType }`、`screenshot_file_ids`、`submitted_by_user_id`、`submitted_at`；截图经 `files.link()` 登记（`ref_type = channel_account_submission`，角色 `screenshot`）。
- 建核验审批单 `approval_request`：`kind = channel_account`、`category = review`、`subject_type = channel_account`、`round_no = 1`、`status = pending`（`submit`，03-staff-authz-audit.md:804）、`dedupe_key = channel_account:{账号 id}`、`submit_actor_type = merchant`、`submit_client = weapp`，`due_at` 按时限策略 `sla.review.channel_account`（默认 1 个工作日）算出并存 `sla_snapshot`；登记定时器 `sla.breach`（键 `sla.breach:approval_request:{id}:decision`）。
- 出站事件（x01 E2：审批单与领域行各发各的）：`approval.submitted`（审批单；`notify.onEvent` 按 `s.approval_pending` 通知发布专员有待核验的账号，`support.onBizEvent` 记客服时间线）；`account.submitted`（渠道账号；x01 登记为无订阅者，只留事实）。

**说明**：
- 门店闸门与订购、广告指派共用同一个判定函数（d3-flow.md:431）：首店资质审核中即可绑定，新增门店须已通过。
- 同一账号解绑后可以重新绑定（新建一行）；同一门店再次绑定同一个仍未解绑的账号同样返回 `CHANNEL_ACCOUNT_TAKEN`。
- 成功后端上提示“发布专员将在 1 个工作日内完成核验”，时限取响应的 `reviewDueAt`。

### 3.3 m.channelAccount.submit　重新提交核验

`POST /m/channel-accounts/{channelAccountId}/submit`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `channel.manage`；已停用门店 403 `STORE_ARCHIVED` |
| 店员视图 | `none` |
| 幂等 | required（状态迁移，A17） |
| 乐观锁 | 不带 `lockVersion`：迁移守卫没有列锁版本（11-publish.md:132；C53） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Accounts（异常账号“重新上传主页截图”）；M:Checkout（“补充后可选 ›”入口） |
| 出处 | 路线图 `m05.channel-account.resubmit`（动作名并入 `submit`，A9、C12）；d3-flow.md:2040；11-publish.md:132；proto-merchant-b.md:174 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `channelAccountId` | string(uuid) | 是 | 属当前门店 | 渠道账号 |

请求体（`ChannelAccountSubmitBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `accountType` | enum | 是 | `enterprise`、`personal`、`none` | 可重选（画板 admin/Accounts 的退回说明“请修改账号类型”）；进本轮快照 |
| `screenshotFileIds` | array<string(uuid)> | 是 | 同 3.2 | 新的主页截图 |

账号名称与账号 ID 不可改：改账号 ID 等于换账号，走解绑后重新绑定（d3-flow.md:2040）。本轮快照里的平台、名称、ID 取账号当前值。

**响应**：`ChannelAccountCard`（`status = pending_verify`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 账号不是 `abnormal`（待核验、可用、已解绑都不能重新提交） |
| `FILE_NOT_USABLE` | 400 | 截图不可用（同 3.2；m03-profile-asset 定义） |
| `VALIDATION_FAILED` | 400 | 截图张数不在 1–3、有重复 |

**副作用**（同一事务）：
- `channel_account.status`：`abnormal` → `pending_verify`（`account.resubmit`，11-publish.md:132）；清空 `abnormal_source`、`abnormal_reason_code`、`abnormal_note`；写 `submitted_at`；状态历史与活动流审计。
- 新一轮 `channel_account_submission`：`round_no` = 上一轮 + 1、`kind = resubmit`，快照记当轮值；截图登记引用。
- 新核验审批单（`round_no` 相同，`approval_request.status`：（新建）→ `pending`），时限与定时器同 3.2。
- 出站事件：`approval.submitted`（通知发布专员，同 3.2）、`account.submitted`（无订阅者）。

**说明**：手动标记的异常（`abnormal_source = manual`）同样走本接口重新提交。

### 3.4 m.channelAccount.unbind　解绑渠道账号

`POST /m/channel-accounts/{channelAccountId}/unbind`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `channel.manage`；已停用门店 403 `STORE_ARCHIVED` |
| 店员视图 | `none` |
| 幂等 | required（状态迁移，A17；原路线图 natural 取消） |
| 乐观锁 | 不带 `lockVersion`（11-publish.md:134 的守卫没有列锁版本） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Accounts（原型未画解绑按钮，只有规则说明，proto-merchant-b.md:180；按设计规范 8 节用底部弹层确认） |
| 出处 | 路线图 `m05.channel-account.unbind`；d3-flow.md:2042；11-publish.md:134 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `channelAccountId` | string(uuid) | 是 | 属当前门店 | 渠道账号 |

请求体：无（空对象）。

**响应**：`ChannelAccountCard`（`status = unbound`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `CHANNEL_ACCOUNT_IN_USE` | 409 | 有引用该账号、阶段为待开工、制作中、待上线或上线中的订单项，或该账号上有未核查的下架任务（`details` 给出两项计数） |
| `STATE_NOT_ALLOWED` | 409 | 账号已解绑 |

**副作用**（同一事务）：
- `channel_account.status`：`pending_verify` / `available` / `abnormal` → `unbound`（`account.unbind`，11-publish.md:134）；写 `unbound_at`；状态历史与活动流审计。
- 在途核验审批单（账号待核验时才有）`approval_request.status`：`pending` → `withdrawn`（`withdraw`，系统代撤：对象失效，03-staff-authz-audit.md:807），写 `decided_at`，取消其 `sla.breach` 定时器；提交行保留。
- 出站事件：`account.unbound`；撤回了在途核验单时另发 `approval.withdrawn`（审批单，x01 第 3 节已登记本接口为触发方）。

**说明**：守卫查 `order_item_account` 联 `order_item.phase` 与 `ix_takedown_task_channel_account_id_status`。解绑后该账号不再占用唯一键，可在任一门店重新绑定。

### 3.5 m.deliveryPlan.get　方案确认页

`GET /m/delivery-plans/{deliveryPlanId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `order.read`（已停用门店的老板可看） |
| 店员视图 | `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Plan（M22）；M:OrderDetail（“查看方案”） |
| 出处 | 路线图 `m05.delivery-plan.get`；d3-flow.md:3509；10-delivery.md:360；proto-merchant-a.md:491 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryPlanId` | string(uuid) | 是 | 属当前门店 | 方案 id，由订单详情 `m.order.get` 返回（方案与订购单一对一），深链也带它 |

请求体：无。

**响应**：`DeliveryPlanDetail`。

**错误**：无（不在门店范围内 404 `NOT_FOUND`）。

**副作用**：无。

**说明**：
- 内容一律取当前版本的不可变快照，不读交付经理正在编辑的草稿（`delivery_plan.draft` 不出商家端）。`drafting`（尚未推送）时 `version`、`content` 为空、`actions` 为空。
- 原型“定制方式 按门店重新制作画面、场景与植入”一行在数据模型里没有来源（定制方式的定义是待拍板事项 B1），本接口不返回，见第 6 节第 2 项。
- 片尾广告“修改中”时方案仍可确认（proto-merchant-a.md:503），确认不以广告全部确认为前提。

### 3.6 m.deliveryPlan.confirm　确认方案

`POST /m/delivery-plans/{deliveryPlanId}/confirm`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `delivery.confirm_plan`；已停用门店 403 `STORE_ARCHIVED` |
| 店员视图 | `none` |
| 幂等 | required（状态迁移，A17；原路线图“natural（版本号守卫）”取消）；结果脱敏（C50、A80）：`x-redact-on-replay` = [`content.items[].posterUrl`] |
| 乐观锁 | 不带 `lockVersion`：守卫是“请求的版本号等于 `current_version_no`”（10-delivery.md:418），没有列锁版本（C53）；请求带业务版本号 `versionNo` |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Plan（“确认方案”） |
| 出处 | 路线图 `m05.delivery-plan.confirm`；d3-flow.md:1124-1146、3509；10-delivery.md:413-421；d6-notify-docs-data.md:862 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryPlanId` | string(uuid) | 是 | 属当前门店 | 方案 id |

请求体（`PlanConfirmBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `versionNo` | integer | 是 | ≥ 1 | 商家看到并确认的版本号（“确认的就是他看到的那一版”，d3-flow.md:1161） |

**响应**（`DeliveryPlanWriteResult`）：`DeliveryPlanDetail` 的全部字段（`status = confirmed`），另加 `replayed: boolean`（见 1.1“结果脱敏”）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `ORDER_IN_AFTER_SALE` | 409 | 订购单有在途取消申请（`drama_order.open_cancel_request_id` 非空，10-delivery.md:413） |
| `PLAN_VERSION_STALE` | 409 | `versionNo` 不等于当前版本（交付经理在商家打开页面后又推送了新版本），`details.currentVersionNo` 给出新版本号，端上刷新 |
| `STATE_NOT_ALLOWED` | 409 | 方案不是 `pending_confirm`（修改中请等待重新推送；已确认的不能再确认） |

**副作用**（同一事务，加锁顺序按 d3-flow.md:1133-1144）：
- `delivery_plan.status`：`pending_confirm` → `confirmed`（`plan.confirm`）；写 `confirmed_version_no`、`confirmed_at`；状态历史（`machine = delivery_plan`）。
- `delivery_plan_version.decision`：空 → `confirmed`；写 `decided_at`、`decide_actor_type = merchant`、`decide_actor_id`、`decide_client = weapp`。
- 方案内容落到订单项：`order_item.agreed_launch_date`；按 `items[].accounts` 比对 `order_item_account`（行只增删：移出的删、新增的插，不变的保留，09-order-ad.md:409）；按 `items[].placements` 以（`slot`, `adId`）比对 `order_item_placement`：未变的行原样保留（含已钉住的 `bound_version_no`、`pinned_at`），新增或换了广告的行写为浮动（`bound_version_no`、`pinned_at` 为空），方案里已去掉的位删除——不整表重写，因为样片确认后（广告位已钉住）仍可能因修订发布账号而重新确认方案（d3-flow.md:1170），整表重写会清掉钉住、违反 09 分组的 I5；参考素材的引用同步到订购单（10-delivery.md:423，A142）：按 `content.referenceAssetIds` 只增删素材库来源的登记（`store_asset_usage` 与对应的 `file_ref`，`ref_type = drama_order`、`role = reference`），订购时登记的门店档案媒体行（只有 `file_ref`、没有 `store_asset_usage`）不动。
- 解除该方案全部未解除的 `plan_amendment` 暂停原因（`delivery_ticket_pause.release_event = plan_confirmed`），工单 `ticket.resume`（工单迁移表第 18 行，步骤不变，写 `from = to` 的状态历史）。
- 对每张工单求值：`delivery_ticket.step`：`plan_confirm` → `ad_prep`（`plan.confirmed`，第 2 行，系统求值），写 `plan_confirmed_at`；广告已全部就绪的继续 `ad_prep` → `sample_making`（`ads.ready`，第 3 行）。每次步骤变化关旧开新环节记录（`delivery_ticket_stage`），按新环节时限登记或取消 `sla.breach` 定时器。
- 出站事件：`plan.confirmed`（载荷按 x01：`deliveryPlanId`、`dramaOrderId`、`versionNo` 与迁移键；不带“账号集合是否变化”，docs 的订阅者调收敛函数自行比对）；每张解除了暂停的工单发 `ticket.resumed`（`deliveryTicketId`、`orderItemId`、`reason = plan_amendment`、`refId` = 暂停原因引用的方案版本行，x01 已登记本接口为触发方；关键订阅者 `docs.onLicenseFacts` 据此对齐授权书）；步骤有变化的工单发 `ticket.step_changed`。授权书由 docs 的事件订阅者对齐（`docs.onLicenseFacts` → `reconcileLetters`）：新选定账号建 `pending_effective` 的授权书，被移出的账号的授权书作废（`void_reason = account_removed`），不在本事务里。

**说明**：
- 守卫只看版本号与在途取消；方案推送时已校验账号可用、广告属本门店（d3-flow.md:1150-1156），确认时不再复核账号状态（见第 6 节第 6 项）。
- 点击确认时端上请求订阅点位 `plan_confirm`。

### 3.7 m.deliveryPlan.requestChange　联系服务经理修改

`POST /m/delivery-plans/{deliveryPlanId}/request-change`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `delivery.confirm_plan`；已停用门店 403 `STORE_ARCHIVED` |
| 店员视图 | `none` |
| 幂等 | required（状态迁移）；结果脱敏：`x-redact-on-replay` = [`content.items[].posterUrl`] |
| 乐观锁 | 不带 `lockVersion`（10-delivery.md:419 的守卫没有列锁版本） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Plan（“联系服务经理修改”弹层与“补充修改意见”） |
| 出处 | 路线图 `m05.delivery-plan.request-change`；d3-flow.md:1130；10-delivery.md:419、421；proto-merchant-a.md:493-494 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `deliveryPlanId` | string(uuid) | 是 | 属当前门店 | 方案 id |

请求体（`PlanChangeRequestBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `kinds` | array<enum> | 是 | 1–6 个，不重复；取值见 4.2 | 需要修改的内容。落 `delivery_plan_change_request.kinds` |
| `note` | string | 是 | 去首尾空白后 1–200 字 | 修改说明。落 `delivery_plan_change_request.note` |

**响应**（`DeliveryPlanWriteResult`）：`DeliveryPlanDetail` 的全部字段（`status = revising`），另加 `replayed: boolean`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `ORDER_IN_AFTER_SALE` | 409 | 订购单有在途取消申请 |
| `STATE_NOT_ALLOWED` | 409 | 方案不是 `pending_confirm` 或 `revising`（起草中没有可提意见的版本；已确认后的调整请联系服务经理，由交付经理修订后重新推送） |

**副作用**（同一事务）：
- 插入 `delivery_plan_change_request`：`on_version_no = current_version_no`、`created_by_user_id`。
- `delivery_plan.status`：`pending_confirm` → `revising`，或 `revising` → `revising`（`plan.request_change`）；写 `staff_due_at`（交付经理 1 个工作日内答复）；状态历史。
- 仅从 `pending_confirm` 来时：`delivery_plan_version.decision`：空 → `change_requested`（决定只写一次；`revising → revising` 不改版本行）。
- 出站事件 `plan.change_requested`（x01 事件目录；载荷 `deliveryPlanId`、`dramaOrderId`、`versionNo` 与迁移键）：`notify.onEvent` 通知交付经理（企业微信与后台待办）。

**说明**：修改中可多次补充，页面上的“修改项”取未解决请求的并集、说明按时间拼接（`openChange`，proto-merchant-a.md:494）。不需要审批。

### 3.8 m.orderItem.sample.get　样片确认页

`GET /m/order-items/{orderItemId}/sample`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `delivery.confirm_sample`；已停用门店 403 `STORE_ARCHIVED` |
| 店员视图 | `none` |
| 幂等 | none（纯查询；不写访问记录，A19） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | `weapp.video.sample.enabled`（缺省/新 seed 开，不覆盖库中显式 false）：关时仍返回历史事实，但 playable.sources=[]、expiresAt=null、confirmableVia=[]；不出替代查看出口 |
| 对应画板 | M:Sample（M23）；M:OrderDetail（“去确认样片”） |
| 出处 | 路线图 `m05.sample.get`；d3-flow.md:3510；d5-media.md:1502；d7-platform.md:805-810；design-spec.md:853 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderItemId` | string(uuid) | 是 | 属当前门店 | 订单项（`samples` 在订单项下的单例别名，A5 第三类） |

请求体：无。

**响应**：`SampleView`。返回最近一次推送给商家的版本（`version_no = delivery_ticket.current_sample_version_no`），不论它此刻是否已被确认、提意见或取代。

**错误**：无（订单项没有工单或从未推送过样片时 404 `NOT_FOUND`）。

**副作用**：无。

**说明**：
- Q9 第一期仅在小程序内查看，确认必须勾选“我已查看第 N 版样片”。GET 只读、不写观看记录；勾选是自声明，不要求播放完毕。
- 播放地址到期或播放错误后，重新调用本 GET 取得现签；不调用当前未落地的 `m.playable.get`。本页私有 Taro Video 实现 9:16、点击播放、移动网络流量 Sheet、广告位定位、离开暂停与版本/门店切换废弃。
- 历史四渠道字段与已确认记录保留；旧版 previewChannels 不含 weapp 的待确认样片无可确认渠道，页面提示联系服务经理。经理可经 a05 §3.41 的显式 legacyRecovery 重新质检并推送新版本，旧版失效但快照不改；商家重新读取当前新版本、查看并勾选后确认，不自动迁移或继承旧查看证据。通用返工/修改意见仍待 W5 后继。
- 关停不转相册、portal 或企业微信；所有样片相册下载签发服务端禁用，portal 样片接口当前未落地且本次不实现。
- A31 原修改意见/广告跳转规则留在原所属包，不由 Q9 扩展。

### 3.9 m.sample.confirm　确认样片

`POST /m/samples/{sampleId}/confirm`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `delivery.confirm_sample`；已停用门店 403 `STORE_ARCHIVED` |
| 店员视图 | `none` |
| 幂等 | required（状态迁移，A17；与 C82 示例一致）；结果脱敏：`x-redact-on-replay` = [`playable`, `decision.feedbackImages[].url`, `decision.feedbackImages[].expiresAt`] |
| 乐观锁 | 不带 `lockVersion`（10-delivery.md:645 的守卫没有列锁版本，C53）；请求带业务版本号 `versionNo` |
| 限流 | `m.global` |
| 开关 | `weapp.video.sample.enabled` 此刻必须开启；关闭返回 FEATURE_DISABLED，不使用其他渠道兜底 |
| 对应画板 | M:Sample（“确认通过”） |
| 出处 | 路线图 `m05.sample.confirm`；d3-flow.md:838、1538-1541、3510；10-delivery.md:176、645；d6-notify-docs-data.md:864；C82 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `sampleId` | string(uuid) | 是 | 属当前门店 | 样片版本 |

请求体（`SampleConfirmBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `versionNo` | integer | 是 | ≥ 1 | 确认的版本号 |
| `viewedVia` | enum | 是 | 历史 enum 保留四值；Q9 新确认只接受 weapp，且原 preview_channels 必须含 weapp | 页面提交 weapp，落 `sample.confirm_viewed_via` |
| `hasViewed` | boolean | 是 | 必须为 true，包括 weapp | 勾选“我已查看第 N 版样片”；写 viewed_ack_at、viewed_ack_by_user_id。不要求看完或上传播放进度 |

**响应**（`SampleWriteResult`）：`SampleView` 的全部字段（`status = confirmed`），另加 `replayed: boolean`（见 1.1“结果脱敏”）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `TICKET_ON_HOLD` | 409 | 工单暂停中（取消审批中或方案修订待确认，`delivery_ticket.pause_count` > 0），`details.reasons` 给出原因 |
| `SAMPLE_VERSION_STALE` | 409 | `versionNo` 不等于本行版本号，或本行已被更新的推送版本取代；`details` 给出当前版本的 `sampleId` 与版本号 |
| `AD_CHANGED` | 409 | 本版所用的广告版本已不是各广告当前的确认版本（广告被重新打开或换了确认版本，d3-flow.md:838）；工单随后由系统求值回到广告准备 |
| `FEATURE_DISABLED` | 403 | 样片播放开关关闭 |
| `SAMPLE_VIEW_CHANNEL_NOT_OFFERED` | 409 | 非 weapp，或原推送快照不含 weapp；历史相册/portal/企业微信记录不放行 |
| `SAMPLE_PREVIEW_NOT_READY` | 409 | 真正水印版未 ready，或派生文件尚未 stored；原文件播放桩不算就绪 |
| `STATE_NOT_ALLOWED` | 409 | 本行不是 `pushed`（已确认、已提意见） |
| `VALIDATION_FAILED` | 400 | 需要勾选而 `hasViewed` 为假（`fieldErrors` 指向 `hasViewed`，文案“请先勾选‘我已查看’”） |

**副作用**（同一事务）：
- `sample.status`：`pushed` → `confirmed`（`sample.confirmed`，10-delivery.md:645）；同一条 UPDATE 写 `decided_at`、`decided_by_user_id`、`decide_client = weapp`、`confirm_viewed_via`（与 `viewed_ack_at`、`viewed_ack_by_user_id`）；状态历史（`machine = sample`）。
- `delivery_ticket.step`：`sample_confirm` → `batch_compose`（`sample.confirmed`，工单迁移表第 5 行）；写 `sample_confirmed_at`；关旧开新环节记录与 `sla.breach` 定时器。
- 钉住广告位：该订单项的 `order_item_placement.bound_version_no` 写为本版所用的版本号、写 `pinned_at`（09 分组 2.5）。
- 出站事件 `sample.confirmed`（载荷按 x01：`sampleId`、`deliveryTicketId`、`dramaOrderId`、`versionNo`、`viewedVia` 与迁移键）、`ticket.step_changed`。

**说明**：
- 服务端重验老板身份、当前门店、当前推送版本、广告当前确认版本、工单步骤与暂停、开关和真实水印 ready，不仅依赖页面按钮。失败不得写决定、状态、历史或事件。
- hasViewed=true 为对当前版本的自声明，写 viewedAckAt；不伪造播放完成或首次播放证据。firstViewedAt 仅为历史访问时间。旧历史确认保持原样，不重新判无效。
- 确认证据效力、真实类目、提审与真机仍未验，见第 6 节第 1 项及 Q9 工作包。
- 点击时端上请求订阅点位 sample_confirm。

### 3.10 m.sample.requestChange　对样片提出修改意见

`POST /m/samples/{sampleId}/request-change`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `delivery.confirm_sample`；已停用门店 403 `STORE_ARCHIVED` |
| 店员视图 | `none` |
| 幂等 | required（状态迁移）；结果脱敏：`x-redact-on-replay` = [`playable`, `decision.feedbackImages[].url`, `decision.feedbackImages[].expiresAt`] |
| 乐观锁 | 不带 `lockVersion`（10-delivery.md:646 的守卫没有列锁版本） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Sample（“提出修改意见”） |
| 出处 | 路线图 `m05.sample.request-change`；d3-flow.md:1523；10-delivery.md:177、646-647；proto-merchant-a.md:531、538-539；A31 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `sampleId` | string(uuid) | 是 | 属当前门店 | 样片版本 |

请求体（`SampleRequestChangeBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `feedbackKind` | enum | 是 | 只接受 `compose` | 合成问题（A31：商家端固定 `compose`；广告内容的修改到“我的广告”提出，只能由交付经理代录 `ad_content`）。落 `sample.feedback_kind` |
| `note` | string | 是 | 去首尾空白后 1–200 字 | 修改意见。落 `sample.feedback_note` |
| `imageFileIds` | array<string(uuid)> | 否 | 0–3 个，不重复；已入库、未被拦截、分类 `ticket_attachment`、属本门店（见 1.1“文件引用”） | 截图（原型缺，按 PRD 补）。落 `sample.feedback_file_ids`，经 `file_ref` 登记（`sample` / `feedback`） |

不接受时间点：V1.0 不做“按时间点提意见”（A31；设计规范 11 节），`sample.feedback_time_ms` 不写。

**响应**（`SampleWriteResult`）：`SampleView` 的全部字段（`status = change_requested`），另加 `replayed: boolean`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `TICKET_ON_HOLD` | 409 | 工单暂停中 |
| `SAMPLE_VERSION_STALE` | 409 | 本行已被更新的推送版本取代 |
| `STATE_NOT_ALLOWED` | 409 | 本行不是 `pushed` |
| `FILE_NOT_USABLE` | 400 | 截图未入库、已被拦截、分类不是 `ticket_attachment` 或不是当前用户在本门店登记的（m03-profile-asset 定义） |
| `VALIDATION_FAILED` | 400 | `feedbackKind` 不是 `compose`；截图超过 3 张或重复 |

**副作用**（同一事务）：
- `sample.status`：`pushed` → `change_requested`（`sample.change_requested`，合成问题，10-delivery.md:646）；同一条 UPDATE 写 `decided_at`、`decided_by_user_id`、`decide_client = weapp`、`feedback_kind`、`feedback_note`、`feedback_file_ids`；状态历史。
- `delivery_ticket.step`：`sample_confirm` → `sample_making`（工单迁移表第 6 行）；`delivery_ticket.sample_round_no` 加 1；关旧开新环节记录与 `sla.breach` 定时器。
- 出站事件 `sample.change_requested`（载荷按 x01：`sampleId`、`deliveryTicketId`、`dramaOrderId`、`versionNo`、`feedbackKind` 与迁移键）、`ticket.step_changed`：通知剪辑师与交付经理。

**说明**：提交后端上提示“剪辑师将在 1 个工作日内调整，并重新发送样片给您确认”。

### 3.11 m.sample.downloadUrls　历史样片相册签发入口（Q9 禁用）

`POST /m/samples/{sampleId}/download-urls`

保留既有 operationId、路径与历史 DownloadUrl 类型，Q9 第一期完成原鉴权及版本校验后，服务端统一返回 403 FEATURE_DISABLED，不签发样片水印版地址、不写相册访问审计或 first_viewed_at。关闭播放开关也不恢复本入口。页面不显示保存样片按钮；该规则不影响成片逐集下载或广告下载。

### 3.12 m.orderItem.release.get　当前成片包

`GET /m/order-items/{orderItemId}/release`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `delivery.download`（已停用门店的老板可用） |
| 店员视图 | `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Publish（成片包卡片）；原型无：逐集下载页 `sub/publish/downloads`（d7-platform.md:832） |
| 出处 | 路线图 `m05.release.get`；d5-media.md:1584、2095；d7-platform.md:816、845；design-spec.md:855 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderItemId` | string(uuid) | 是 | 属当前门店 | 订单项（`delivery-releases` 的单例别名，A5 第三类） |

请求体：无。

**响应**：`ReleaseView`。取该订单项生效中的成片包；没有生效中的取推送序号最大的一行（可能已关闭，`isDownloadable` 为假）。

**错误**：无（从未推送过成片包时 404 `NOT_FOUND`）。

**副作用**：无。

**说明**：
- 受平台约束：小程序单次下载上限 200MB，原型的整包“下载”做不到（design-spec.md:855）。小程序内只有逐集存相册；页面顶部并列“扫码在电脑上下载（推荐）”与“存到手机相册”两个入口，前者走电脑端下载页：扫描下载页上的码后调 m02 的 `m.portalTicket.lookup`，再由老板允许（`m.portalTicket.approve`）。
- 补发后（新成片包）端上默认只勾选 `changedEpisodeNos`，旧包的本地进度作废（d7-platform.md:845）。

### 3.13 m.orderItem.downloadGrant.create　重新生成下载授权

`POST /m/order-items/{orderItemId}/download-grants`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `delivery.download`（已停用门店的老板可用） |
| 店员视图 | `none` |
| 幂等 | required（防一次点击耗掉两次每日额度） |
| 乐观锁 | 无（在成片包行锁内生成） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Publish（“7 天内有效”过期后）；原型无：逐集下载页的“下载授权已过期 · 重新生成” |
| 出处 | 路线图 `m05.download-grant.create`；d5-media.md:1560、2099；d3-flow.md:1663；10-delivery.md:1034 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderItemId` | string(uuid) | 是 | 属当前门店 | 订单项 |

请求体：无（空对象）。

**响应**（`DownloadGrantResult`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `grant` | `DownloadGrantView` | 是 | 新生成的授权 | `download_grant` |
| `regrantRemainingToday` | integer | 是 | 今天还能重新生成的次数 | 同 `ReleaseView` |

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `DOWNLOAD_NOT_AVAILABLE` | 409 | 没有生效中的成片包；订单项不在待上线、上线核验或上线中；今天已过使用期止日 |
| `DOWNLOAD_REGRANT_LIMIT` | 409 | 今天已重新生成 5 次（北京时间按天计），`details.nextAvailableAt` 为次日 00:00 |

**副作用**（同一事务，持有成片包行锁）：
- 旧授权 `download_grant.state`：`active` → `superseded`，写 `ended_at`。
- 新授权 `download_grant.state`：（新建）→ `active`：`grantee_type = entity`、`grantee_id` = 主体、`valid_days` 取参数 `package.link_ttl_days`（1–30，默认 7）的快照、`expires_at = now + valid_days` 天、`actor_type = merchant`、`actor_id`、`client = weapp`。
- `download_grant` 是技术状态，不写状态历史，不发出站事件。

**说明**：守卫取自 10-delivery.md:1034：订单项处于待上线、上线核验或上线中（`order_item.phase` ∈ {`to_launch`,`live`}，工单 `step` ∈ {`awaiting_launch`,`launch_verify`,`in_service`}），未过使用期，每日至多 5 次。版权续期重开的成片包不自动建授权，商家点“重新生成”即可（10-delivery.md:884）。

### 3.14 m.orderItem.downloadUrls　逐集下载（签发直链）

`POST /m/order-items/{orderItemId}/download-urls`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `delivery.download`（已停用门店的老板可用） |
| 店员视图 | `none` |
| 幂等 | none（签发短时地址，A18、A19；每次调用都留一行下载记录） |
| 乐观锁 | 无 |
| 限流 | `m.sign`（签发类，每用户每小时 600 次；A130、C68） |
| 开关 | 无 |
| 对应画板 | M:Publish（“下载”）；原型无：逐集下载页 |
| 出处 | 路线图 `m05.download.create`（改写为 `download-urls`，集号放请求体，A3、C11、C60）；d5-media.md:1549、1587、2096；d7-platform.md:832、846；10-delivery.md:1056 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderItemId` | string(uuid) | 是 | 属当前门店 | 订单项 |

请求体（`EpisodeDownloadBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `kind` | enum | 是 | 商家端只接受 `episode` | 下载内容；整包与发布清单文件只在电脑端下载页提供（`portal.orderItem.downloadUrls`） |
| `episodeNo` | integer | 是 | 1 ≤ 集号 ≤ 成片包集数 | 集号 |

**响应**（`EpisodeDownloadUrl`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `downloadId` | string(uuid) | 是 | 下载记录 id，回报保存结果时带回 | `delivery_download_log.id` |
| `url` | string | 是 | 单集直链，15 分钟（C61） | 清单内该集文件现签，`response-content-disposition` 指定文件名 |
| `expiresAt` | string(date-time) | 是 | 到期时刻 | C61 |
| `fileName` | string | 是 | “剧名_第NN集.mp4” | `delivery_release.manifest_snapshot[].name` |
| `sizeBytes` | string(bigint) | 是 | 文件大小，端上据此设下载超时 | `delivery_release.manifest_snapshot[].size` |

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `DOWNLOAD_GRANT_INVALID` | 409 | 下载授权已过期、已被重新生成或已撤销（`details.reason`）；端上进入“已阻塞”，给“重新生成”按钮（d7-platform.md:832） |
| `DOWNLOAD_NOT_AVAILABLE` | 409 | 没有生效中的成片包；订单项已取消、退回或终止；已过使用期止日次日 00:00；清单内该集文件不可用 |
| `VALIDATION_FAILED` | 400 | `kind` 不是 `episode`；集号超出范围 |

**副作用**（同一事务）：
- 插入 `delivery_download_log`：`delivery_release_id`、`download_grant_id`、`order_item_id`、`kind = episode`、`episode_no`、`file_id`（清单里该集的文件）、`actor_type = merchant`、`actor_id`、`client = weapp`、`url_ttl_sec = 900`、`ip`、`user_agent`。
- 服务端直记埋点 `package_download`（端上不报；与 p01 的下载页签发同一规则，d6-notify-docs-data.md:1854、d7-platform.md:846）：`analytics_event.source = direct`、`client = weapp`、`actor_type = merchant`、`actor_id` = `merchant_user_id` = 本人（服务端直记没有 `anonymous_id`，`ck_analytics_event_actor` 要求 merchant 行有 `actor_id`）、`role = owner`、`entity_id` 与 `store_id` 取自成片包（`ck_analytics_event_scope`），`props` 带订购单 id、下载方式 `episode`、渠道 `weapp`；`event_id = srv-pkgdl-{deliveryReleaseId}-{userId}-episode-{业务日}`（按 `analytics_event_dedup` 去重），同一人同一成片包每天只记一条——按集下载一部 80 集的剧是 80 次签发、1 个埋点。
- 不改状态，不发出站事件。

**说明**：签发条件即 d5-media.md:1549 的 `canDownload`：授权有效且未过期、授权指向生效中的成片包、订单项未取消未退回且未过使用期、调用者是该主体的老板、文件在清单内且已入库。端上每集“取地址 → 下载 → 存相册 → 删临时文件 → 回报”，失败换新地址重试至多 3 次（d7-platform.md:4.11）。

### 3.15 m.download.report　回报保存相册的结果

`POST /m/downloads/{downloadId}/report`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `delivery.download`；只能回报本人签发的记录 |
| 店员视图 | `none` |
| 幂等 | required（原路线图“天然幂等”按 A17 取消） |
| 乐观锁 | 无（两列只可从空写一次，由触发器保证） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Publish；原型无：逐集下载页 |
| 出处 | 路线图 `m05.download.report`；d5-media.md:1593、2098；d7-platform.md:836；10-delivery.md:1058 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `downloadId` | string(uuid) | 是 | 属当前门店，且 `actor_id` 为本人、`client = weapp` | 下载记录 id（来自 `m.orderItem.downloadUrls`） |

请求体（`DownloadReportBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `result` | enum | 是 | `saved`、`failed` | 落 `delivery_download_log.client_ack`，同时写 `client_ack_at` |

**响应**（`DownloadReportResult`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `downloadId` | string(uuid) | 是 | 下载记录 id | `delivery_download_log.id` |
| `episodeNo` | integer | 是 | 集号 | `delivery_download_log.episode_no` |
| `clientAck` | enum(`saved`,`failed`) | 是 | 回报结果 | `delivery_download_log.client_ack` |
| `clientAckAt` | string(date-time) | 是 | 回报时间 | `delivery_download_log.client_ack_at` |

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 该记录已回报过不同的结果（只可写一次）；回报相同结果直接返回当前值 |

**副作用**：只写 `delivery_download_log.client_ack`、`client_ack_at` 两列（只增表，触发器放行这两列从空写一次，10-delivery.md:1102）。后台“商家已保存 45 / 80”按它统计。

**说明**：不是本人签发的记录按 404 处理（不区分不存在与无权）。

### 3.16 m.orderItem.publishList.get　发布清单

`GET /m/order-items/{orderItemId}/publish-list`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `publish.read`（已停用门店的老板可用） |
| 店员视图 | `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Publish（“发布清单 · 合集名称、每集标题与话题 · 复制”） |
| 出处 | 路线图 `m05.publish-list.get`；proto-merchant-a.md:571；d5-media.md:2119；10-delivery.md:1121 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderItemId` | string(uuid) | 是 | 属当前门店 | 订单项（`publish-lists` 的单例别名，A5 第三类） |

请求体：无。

**响应**：`PublishListView`。

**错误**：无（订单项没有生效中的成片包时 404 `NOT_FOUND`：发布清单随成片包交付，推送前不对商家展示）。

**副作用**：无。

**说明**：复制是端上剪贴板动作，不调接口；“按清单发布 ✓”的进度由端上本地记录。下载页有同构的 `portal.orderItem.publishList.get`。

### 3.17 m.launchTask.list　上线任务

`GET /m/launch-tasks`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `publish.read`（已停用门店的老板可用） |
| 店员视图 | `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Publish（M28，“待上线”“已完成”页签）；M:LaunchRecord（`orderItemId` + `tab=all` 取各账号任务）；M:Mine（“发布任务”入口）；补充状态：下拉刷新 |
| 出处 | 路线图 `m05.launch-task.list`；d3-flow.md:3512；11-publish.md:225；proto-merchant-a.md:569、584；A24、A54 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum | 否 | `todo`、`done`、`all`；缺省 `todo` | 页签（A24，原 `view=` 改）；`all` 不是页面页签，不按页签过滤，供上线记录页与 `orderItemId` 一起用 |
| 查询 | `orderId` | string(uuid) | 否 | — | 只看某张订购单（订单卡片的“上线记录”入口） |
| 查询 | `orderItemId` | string(uuid) | 否 | — | 只看某部剧（上线记录页） |
| 查询 | `cursor` | string | 否 | — | C42，游标按订单分组 |
| 查询 | `limit` | integer | 否 | 1–50，默认 20 | 每页订单数 |

页签口径（任务粒度为“订单项 × 账号”，按订单聚合展示，proto-merchant-a.md:584）：
- `todo`：任务未作废、`completed_at` 为空，且工单在待上线、上线核验或服务中（`delivery_ticket.step` ∈ {`awaiting_launch`,`launch_verify`,`in_service`}）。含待发布、核验中、需补充，以及已部分通过待补充的任务。
- `done`：其余任务（全部集数已核验通过、已作废，或工单已进入到期下架、归档、终止）。
- `all`：不过滤，含已作废的任务。上线记录页（M:LaunchRecord）用 `?orderItemId=…&tab=all` 取一部剧在各账号上的全部任务：已满集核验通过的任务只在 `done` 里，两个账号一个已完成、一个待补充时会被拆进两个页签，所以上线记录页不能用缺省页签。

一个订购单在 `todo`、`done` 两个页签里都可能出现，各自只带符合页签的任务。

**响应**：`CursorPage<LaunchTaskOrderGroup>`。排序：`todo` 按组内最早的约定上线日升序；`done`、`all` 按组内任务最近更新时间（`launch_task.updated_at`）倒序；都以订购单 id 兜底。

**错误**：无。

**副作用**：无。

**说明**：页签计数见 `m.launchTask.summary`（A23）；“已完成”页签同时含下架任务，端上把两个 summary 相加。草案把上线与下架合在一个 `GET /m/launch-tasks?tab=` 里，按资源拆为本接口与 `m.takedownTask.list`。

### 3.18 m.launchTask.summary　上线任务计数

`GET /m/launch-tasks/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `publish.read` |
| 店员视图 | `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Publish（页签“待上线 1”“已完成 3”中上线一侧，Publish.dc.html:180） |
| 出处 | 路线图 `m05.launch-task.summary`；A23、A54；C83 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `orderId` | string(uuid) | 否 | — | 同列表 |
| 查询 | `orderItemId` | string(uuid) | 否 | — | 同列表 |

**响应**（`LaunchTaskSummary`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `todo` | integer | 是 | 待上线页签的任务数 | `launch_task` 按 3.17 口径计数 |
| `done` | integer | 是 | 已完成页签中上线任务数 | 同上 |
| `needFix` | integer | 是 | 其中需补充的任务数（副指标，供角标） | `launch_task.review_status = need_fix` |

计数粒度按“订单项 × 账号”（上线任务行）计（A54）。`tab = all` 不是页面页签，不给计数（C83）。

**错误**：无。**副作用**：无。

### 3.19 m.launchTask.get　上线记录

`GET /m/launch-tasks/{launchTaskId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `publish.read` |
| 店员视图 | `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:LaunchRecord（M24） |
| 出处 | 路线图 `m05.launch-task.get`；proto-merchant-a.md:610、616；11-publish.md:225、474 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `launchTaskId` | string(uuid) | 是 | 属当前门店 | 上线任务 |

**响应**：`LaunchTaskDetail`。

**错误**：无。**副作用**：无。

**说明**：
- 页面上该剧有几个账号就有几个区块：任务清单取 `m.launchTask.list?orderItemId=…&tab=all`（3.17），每个区块的核验项、回填与核验时间线、巡检记录取本接口；页头（剧名、题材、集数、阶段、订单号、使用期、剩余天数）只取 m04 的 `m.orderItem.get`，本接口不带。
- 复制链接是端上剪贴板动作；“联系服务经理”“查看订单”跳 m08、m04。
- 核验人、巡检人姓名是否向商家展示待确认（proto-merchant-a.md:616），默认展示员工称呼（`display_name`），见第 6 节第 3 项。
- 说明区“结束前 30 天生成下架任务”是文案，日期用 m04 `m.orderItem.get` 返回的 `usageEndDate` 推算。

### 3.20 m.launchTask.submit　回填上线链接并提交核验

`POST /m/launch-tasks/{launchTaskId}/submit`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `publish.submit_link`；已停用门店 403 `STORE_ARCHIVED` |
| 店员视图 | `none` |
| 幂等 | required（状态迁移；11-publish.md:300 的守卫第一项即“带幂等键”） |
| 乐观锁 | 不带 `lockVersion`（守卫没有列锁版本） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Publish（“回填合集链接 · 粘贴 · 提交核验”） |
| 出处 | 路线图 `m05.launch-task.submit`；d3-flow.md:1754-1760、3512；11-publish.md:300；10-delivery.md:183；05-risks-and-open-issues.md:192；d6-notify-docs-data.md:866 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `launchTaskId` | string(uuid) | 是 | 属当前门店 | 上线任务（某部剧在某个账号上） |

请求体（`LaunchSubmitBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `linkKind` | enum | 是 | `collection`、`episodes` | 主链接形态。落 `launch_submission.link_kind` |
| `collectionUrl` | string | `linkKind = collection` 时必填 | `https://`、主机名非空、不含用户名与口令、≤ 2000 字符 | 合集链接。落 `launch_submission.collection_url` |
| `episodeUrls` | array<object> | `linkKind = episodes` 时必填 | `[{ episodeNo, url }]`，至少 1 条；集号 1..订购集数、不重复；每条链接规则同上 | 逐集作品链接（PRD 要求、原型缺，按 PRD 补）。落 `launch_submission.episode_urls`；另一种链接可同时提供 |
| `reportedEpisodeCount` | integer | 是 | `max(1, 已核验集数)` ≤ 值 ≤ 订购集数（首次回填时已核验集数为 0，下限仍是 1，对齐 `ck_launch_submission_reported_episode_count`，11-publish.md:381） | 本次声明已发布的集数（累计）。落 `launch_submission.reported_episode_count` |
| `actualLaunchDate` | string(date) | 是 | 不晚于今天、不早于成片交付日、不晚于使用期止日 | 实际上线日期（首批发布日期）。落 `launch_submission.actual_launch_date` |

**响应**：`LaunchTaskCard`（`reviewStatus = verifying`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `TICKET_ON_HOLD` | 409 | 工单暂停中 |
| `STATE_NOT_ALLOWED` | 409 | 任务在核验中、已作废，或已全部集数通过；工单不在待上线、上线核验或服务中 |
| `LAUNCH_WINDOW_CLOSED` | 409 | 今天已过使用期止日，不能再回填（`details.usageEndDate`） |
| `LINK_INVALID` | 400 | 链接不合规（不是 `https`、无法解析、过长、带用户名口令、逐集集号重复或越界），`details` 指出字段与原因（d3-flow.md:1759 的 `422 LINK_INVALID` 按 C24 改为 400） |
| `LAUNCH_SUBMISSION_OUT_OF_RANGE` | 400 | 实际上线日期或声明集数超出允许范围（声明集数小于 `max(1, 已核验集数)` 或大于订购集数），`details` 给出字段与上下限 |

**副作用**（同一事务）：
- 插入 `launch_submission`：`round_no = current_round_no + 1`、`result = pending`、`submit_actor_type = merchant`、`submit_actor_id`、`submit_client = weapp`、`submitted_at`。
- `launch_task.review_status`：`pending` / `need_fix` / `passed`（未满集）→ `verifying`（`launch.submit`，11-publish.md:300）；`current_round_no` 加 1；状态历史（`state_field = review_status`）。
- 建核验审批单 `approval_request`（（新建）→ `pending`，`submit`）：`kind = launch_link`、`category = review`、`subject_type = launch_submission`、`delivery_ticket_id` 取任务的工单、`round_no` 同回填行、`dedupe_key = launch_link:{上线任务 id}`、提交人商家（`submit_client = weapp`），`due_at` 按 `sla.review.launch_link`（默认 1 个工作日），登记 `sla.breach` 定时器（`…:decision`）。
- `reevaluate(工单)`：`delivery_ticket.step`：`awaiting_launch` → `launch_verify`（`launch.changed`，工单迁移表第 12 行，系统求值）；首次回填写 `delivery_ticket.links_submitted_at`；步骤变化时关旧开新环节记录（`delivery_ticket_stage`）与 `sla.breach` 定时器。
- 出站事件（x01 E2：审批单与领域行各发各的）：`approval.submitted`（审批单；`notify.onEvent` 按 `s.approval_pending` 通知发布专员有待核验的链接，`support.onBizEvent` 记客服时间线）；`launch.submitted`（上线任务；x01 登记的订阅者只有埋点派生 `publish_link_submit`）；步骤变化时另发 `ticket.step_changed`。

**说明**：
- 回填粒度按 PRD 支持合集链接与逐集链接并填实际上线日期（原型只有合集链接，05-risks-and-open-issues.md:192）；支持分批、跨日上线：部分集数通过后再回填剩余集数（d3-flow.md:1760）。
- 域名只做软校验，不在抖音、视频号常见域名内时由发布专员留意，不拒绝（d3-flow.md:1759）。
- 提交后端上提示“发布专员将在 1 个工作日内核验集数、账号与‘广告’标识”；点击时请求订阅点位 `link_submit`。

### 3.21 m.takedownTask.list　下架任务

`GET /m/takedown-tasks`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `publish.read`（已停用门店的老板可用） |
| 店员视图 | `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Publish（“待下架”页签、“已完成”页签的下架一侧） |
| 出处 | 路线图 `m05.takedown-task.list`；d3-flow.md:3512；11-publish.md:577；proto-merchant-a.md:562；A24 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum | 否 | `pending`、`done`；缺省 `pending` | `pending` = `pending_merchant`；`done` = `merchant_confirmed`、`checked`；作废的任务不返回 |
| 查询 | `orderId` | string(uuid) | 否 | — | 只看某张订购单 |
| 查询 | `cursor` | string | 否 | — | C42 |
| 查询 | `limit` | integer | 否 | 1–50，默认 20 | — |

**响应**：`CursorPage<TakedownTaskCard>`。排序：`pending` 按 `due_date` 升序；`done` 按 `COALESCE(merchant_confirmed_at, checked_at)` 倒序（商家未确认、由发布专员直接核查通过的任务 `merchant_confirmed_at` 为空，取核查时间）；都以 `takedown_task.id` 兜底，游标按这组键编码。

**错误**：无。**副作用**：无。

**说明**：“暂无待下架任务；最早结束的《家有萌娃》可使用至 2027-06-30，下架任务将于 2027-05-31 生成”由 `m.takedownTask.summary` 的 `nextTakedown` 提供（不放在列表的分页外壳里，C42）。

### 3.22 m.takedownTask.summary　下架任务计数

`GET /m/takedown-tasks/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `publish.read` |
| 店员视图 | `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Publish（页签“待下架 0”与“已完成”下架一侧；空状态提示） |
| 出处 | 路线图 `m05.takedown-task.summary`；A23；C83；proto-merchant-a.md:562 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `orderId` | string(uuid) | 否 | — | 同列表 |

**响应**（`TakedownSummary`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `pending` | integer | 是 | 待下架任务数 | `takedown_task.status = pending_merchant`（`ix_takedown_task_store_id_status`） |
| `done` | integer | 是 | 已完成的下架任务数 | `takedown_task.status` ∈ {`merchant_confirmed`,`checked`} |
| `overdue` | integer | 是 | 其中已过应完成日的待下架数（副指标） | `pending_merchant` 且今天 > `takedown_task.due_date` |
| `nextTakedown` | object \| null | 是 | 没有待下架任务时的提示：最早结束、尚未生成下架任务的剧 `{ orderItemId, dramaTitle, usageEndDate, createDate }`；没有为空 | 本门店成片包已推送、阶段为待上线或上线中且没有未作废下架任务的订单项中 `order_item.usage_end_date` 最早的一个；`createDate` = 其 `takedown.create` 定时器的 `timer.fire_at` 日期（止日前 30 天） |

**错误**：无。**副作用**：无。

### 3.23 m.takedownTask.confirm　确认已下架

`POST /m/takedown-tasks/{takedownTaskId}/confirm`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `publish.takedown_confirm`（已停用门店的老板可用） |
| 店员视图 | `none` |
| 幂等 | required（状态迁移；原路线图“natural（状态守卫）”取消）；结果脱敏：`x-redact-on-replay` = [`posterUrl`] |
| 乐观锁 | 不带 `lockVersion`（11-publish.md:654 的守卫没有列锁版本） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Publish（待下架任务的“确认已下架”；原型未演示该操作） |
| 出处 | 路线图 `m05.takedown-task.confirm`；d3-flow.md:1983、3513；11-publish.md:654；proto-merchant-a.md:575；d6-notify-docs-data.md:867 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `takedownTaskId` | string(uuid) | 是 | 属当前门店 | 下架任务 |

请求体（`TakedownConfirmBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `method` | enum | 是 | `delete`、`private`、`not_published`；`not_published` 仅 `basis = delivered_unverified` | 已删除、已设为仅自己可见、未发布。落 `takedown_task.merchant_method` |

**响应**（`TakedownTaskWriteResult`）：`TakedownTaskCard` 的全部字段（`status = merchant_confirmed`，按抽查放行的为 `checked`），另加 `replayed: boolean`（见 1.1“结果脱敏”）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 任务不是 `pending_merchant`（已确认、已核查、已作废） |
| `TAKEDOWN_METHOD_NOT_ALLOWED` | 409 | 选了 `not_published`，但该账号已核验上线（`basis = live`），`details.allowedMethods` 给出可选方式 |

**副作用**（同一事务）：
- `takedown_task.status`：`pending_merchant` → `merchant_confirmed`（`takedown.merchant_confirm`，11-publish.md:654）；写 `merchant_method`、`merchant_confirmed_at`、`merchant_confirmed_by_user_id`；按策略 `takedown.check` 算 `check_due_at` 并存 `sla_snapshot`（从 `max(确认时刻, 应完成日当日结束)` 起 1 个工作日）；状态历史。
- 取消定时器 `takedown.overdue`（键前缀 `takedown.overdue:takedown_task:{id}:`）。
- 参数 `takedown.check_mode` 为按比例抽查时在本事务抽签，结果记在迁移行的载荷里；未抽中的紧接着 `takedown_task.status`：`merchant_confirmed` → `checked`（`takedown.sample_release`，系统），写 `check_method = sampled_out`、`checked_at`，发 `takedown.checked`。默认逐条核查时不抽签，进入发布专员的待核查队列。
- `reevaluate(工单)`，可能连着走两步（x01 第 5.11 节已把这两行归到本接口）：
  - 全部下架任务都已由商家确认且工单在服务中时，`delivery_ticket.step`：`in_service` → `takedown`（`usage.ended`，工单迁移表第 15 行，10-delivery.md:186），写 `usage_ended_at`；关旧开新环节记录（`delivery_ticket_stage`）与 `sla.breach` 定时器。第 15 行的处理器在同一事务里按顺序调 publish 的收尾端口（10-delivery.md:198-202）：该订单项未上线（`is_live` 为假）的上线任务 `launch.void`（`void_reason = usage_expired`，`launch_task.review_status` → `void`）；已上线但停在 `verifying`、`need_fix` 的 `launch.settle`（→ `passed`）；两者在途的核验审批单撤回（`approval_request.status`：`pending` → `withdrawn`，对应回填行 `result = withdrawn`）；最后调 `ensureTakedownTasks`（此时每个账号都已有任务，通常不新建；若新建则发 `takedown.created`）；该工单仍在办的补发跟进调 staff 的接口关闭（10-delivery.md:204）。
  - 按抽查放行后该订单项未作废的下架任务全部已核查时，接着 `takedown` → `archived`（`takedown.all_checked`，第 16 行），写 `archived_at`；成片包随归档关闭（`delivery_release.state`：`pushed` → `closed`，`close_reason = usage_ended`，下载授权置 `revoked`，10-delivery.md:883）；订单项阶段随之由 09 分组重算为已结束或已退回积分（x01 E2：由 `ticket.archived` 表达，不另发订单项事件）。
- 出站事件：`takedown.merchant_confirmed`；按抽查放行时 `takedown.checked`（载荷 `checkMethod = sampled_out`）；进入到期下架时 `ticket.step_changed` 以及收尾产生的 `launch.voided`、`launch.settled`、`approval.withdrawn`（逐条）与可能的 `takedown.created`；归档时 `ticket.archived`（载荷 `deliveryTicketId`、`orderItemId`、`itemPhase`；关键订阅者 `docs.onLicenseFacts` 据此对齐授权书）。

**说明**：点击时请求订阅点位 `offline_confirm`。商家确认后发布专员核查；抽查发现仍在线会退回“待商家下架”并升级交付主管（`admin.takedownTask.markOnline`，a06）。

### 3.24 m.licenseLetter.list　授权书列表

`GET /m/license-letters`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `contract.read`（主体级；已停用门店的老板可用）；仅该主体当前的老板 |
| 店员视图 | `none`（店员看不到合同，PRD 3.1） |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Contracts（M34，“定制内容授权书”页签）；M:OrderDetail（“《定制内容授权书》· 2 份”） |
| 出处 | 路线图 `m05.license-letter.list`；d6-notify-docs-data.md:2245；13-notify-docs.md:887、940；proto-merchant-b.md:418 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `orderId` | string(uuid) | 否 | 属本主体 | 只看某张订购单的授权书（订单详情） |
| 查询 | `storeId` | string(uuid) | 否 | 属本主体 | 按下单门店筛；缺省为主体名下全部门店 |
| 查询 | `includeVoided` | boolean | 否 | 缺省 `false` | 是否包含已作废的授权书（见第 6 节第 4 项） |
| 查询 | `cursor` | string | 否 | — | C42 |
| 查询 | `limit` | integer | 否 | 1–50，默认 20 | — |

**响应**：`CursorPage<LicenseLetterCard>`，按 `license_letter.created_at` 倒序（`ix_license_letter_entity_id_created_at`）。

**错误**：无。**副作用**：无。

**说明**：授权书按“订单项 × 发布账号”各 1 份（原型“按剧目与发布账号各 1 份”）；方案确认后由 docs 的对齐函数生成，渲染完成前显示“授权书生成中”（`isRendering`，13-notify-docs.md:1040）。页签计数见 `m.licenseLetter.summary`。

### 3.25 m.licenseLetter.summary　授权书计数

`GET /m/license-letters/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `contract.read` |
| 店员视图 | `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Contracts（页签“定制内容授权书 · 5”，Contracts.dc.html:121） |
| 出处 | 路线图 `m05.license-letter.summary`；A23；C83 |

**请求**：查询参数同列表（`orderId`、`storeId`、`includeVoided`），无分页参数。

**响应**（`LicenseLetterSummary`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `all` | integer | 是 | 授权书份数（按筛选条件） | `license_letter` 计数 |
| `effective` | integer | 是 | 其中生效中（未到期）的份数（副指标） | `status = effective` 且 `period_end` ≥ 今天 |

**错误**：无。**副作用**：无。

### 3.26 m.licenseLetter.get　授权书详情（预览）

`GET /m/license-letters/{licenseLetterId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `contract.read`；仅该主体当前的老板 |
| 店员视图 | `none` |
| 幂等 | none（纯查询；预览不写留痕，PDF 才逐次留痕） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Contracts（“预览”弹层）；M:OrderDetail（授权书预览展开） |
| 出处 | 路线图 `m05.license-letter.get`；d6-notify-docs-data.md:2245；proto-merchant-a.md:455；proto-merchant-b.md:414；13-notify-docs.md 第 4 节 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `licenseLetterId` | string(uuid) | 是 | 属本主体 | 授权书 |

**响应**：`LicenseLetterDetail`。

**错误**：无。**副作用**：无。

**说明**：
- 只回预览内容与元数据，PDF 地址经 `m.licenseLetter.downloadUrls` 签发（A19）。
- 原型的“正式授权书以双方签章版本为准”先不写（签署方式待法务，B3；设计规范 11 节）；页面写“使用期结束当日须下架全部剧集”。

### 3.27 m.licenseLetter.downloadUrls　下载授权书 PDF

`POST /m/license-letters/{licenseLetterId}/download-urls`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `contract.read`；仅该主体当前的老板 |
| 店员视图 | `none` |
| 幂等 | none（签发短时地址，A18、A19） |
| 乐观锁 | 无 |
| 限流 | `m.sign`（签发类，每用户每小时 600 次；A130、C68） |
| 开关 | 无 |
| 对应画板 | M:Contracts（“下载”→“已下载，可再次下载”） |
| 出处 | 路线图 `m05.license-letter.download`（改写为 `download-urls`，A4、A19、C60）；d6-notify-docs-data.md:1411、2245 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `licenseLetterId` | string(uuid) | 是 | 属本主体 | 授权书 |

请求体（`LicenseLetterDownloadBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `revNo` | integer | 否 | 本信件 `render_status = ready` 的版次 | 要下载的版次；缺省为当前版次 |

**响应**（`LicenseLetterDownloadUrl`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `url` | string | 是 | PDF 读地址，5 分钟（C61），带 `response-content-disposition` 指定中文文件名 | `license_letter_revision.file_id` 现签 |
| `expiresAt` | string(date-time) | 是 | 到期时刻 | C61 |
| `fileName` | string | 是 | “定制内容授权书_剧名_编号_第N版.pdf” | `license_letter.letter_no`、`license_letter_revision.rev_no`、快照剧名 |
| `revNo` | integer | 是 | 实际签发的版次 | `license_letter_revision.rev_no` |

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `LICENSE_LETTER_NOT_READY` | 409 | 首版尚未出件（`current_revision_id` 为空），或指定的版次未出件，`details.renderStatus` 给出渲染状态 |

**副作用**：写一行访问审计（`audit_log.stream = access`、`category = file_access`、`action = docs.license_letter.download`、`actor_type = merchant`、`actor_id` = 本人、`client = weapp`、`target_type = license_letter_revision`、`target_id` = 版次 id、`entity_id`、`store_id` = 授权书的下单门店、`ip`、`user_agent`、`meta = { fileCategory: legal_doc, urlTtlSec: 300 }`）；“签发即留痕”（d6-notify-docs-data.md:1415）。不改状态，不发出站事件。

**说明**：端上 `wx.downloadFile` + `wx.openDocument`（可转发、保存）；文件不足 1MB，直连对象存储签名地址，不走 CDN（d6-notify-docs-data.md:1414）。已作废的授权书仍可下载历史版次（证据留存），文件上的状态以验真页为准。

### 3.28 m.performanceReport.list　投放数据（V1.1）

`GET /m/performance-reports`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 V1.1 定 |
| 店员视图 | `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 对应画板 | 原型无：M37 投放数据（V1.1） |
| 出处 | 路线图 `m05.performance-report.list`；PRD.md:626-628、910；d3-flow.md:3361 |

V1.1，细节待设计：概览、按周趋势、单集数据、月度效果报告；周指标表届时另建（d3-flow.md:3361）。路径为建议。

### 3.29 m.performanceUpload.create　上传作品数据截图（V1.1）

`POST /m/performance-uploads`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 V1.1 定 |
| 店员视图 | `none` |
| 幂等 | required |
| 乐观锁 | 无 |
| 对应画板 | 原型无：M37 投放数据（V1.1） |
| 出处 | 路线图 `m05.performance-upload.create`；PRD.md:628 |

V1.1，细节待设计：商家每周上传作品数据截图，发布专员审核后录入。路径为建议。

## 4. 枚举

### 4.1 渠道账号

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `ChannelPlatform` | `douyin`、`wechat_channels` | 抖音、视频号；同数据模型 `channel_account.platform`、`launch_task.platform`、`license_letter.platform` |
| `ChannelAccountStatus` | `pending_verify`、`available`、`abnormal`、`unbound` | 同数据模型 `channel_account.status` |
| `ChannelAccountType` | `enterprise`、`personal`、`none` | 同数据模型 `channel_account.account_type`、`channel_account_submission.filled_snapshot.accountType` |
| `AbnormalSource` | `verify`、`manual` | 同数据模型 `channel_account.abnormal_source` |

### 4.2 方案

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `DeliveryPlanStatus` | `drafting`、`pending_confirm`、`revising`、`confirmed` | 同数据模型 `delivery_plan.status` |
| `PlanVersionDecision` | `confirmed`、`change_requested`、`superseded` | 同数据模型 `delivery_plan_version.decision` |
| `PlanChangeKind` | `launch_date`、`account`、`customization`、`placement`、`ad`、`other` | 上线日期、上线账号、定制内容、植入形式、广告视频、其他；同数据模型 `delivery_plan_change_request.kinds[]` |
| `LaunchMode` | `merchant_self` | 同数据模型 `PlanContent.launchMode`（V1.1 增加 `platform`、`partner`，标 `x-open-enum`） |
| `PlacementSlot` | 引用 m06-ad 第 4 节 | `opening`、`ending`、`corner`、`mid_roll`（同数据模型 `order_item_placement.slot`），标 `x-open-enum`；V1.0 方案里只出现 `opening`、`ending`。本文没有收它的请求。第三轮删去本文只有两个取值的同名枚举（与 m06 冲突） |
| `ProductionModel` | `standard`、`advanced`、`top` | 同数据模型 `order_item.production_model` |
| `AdDisplayStatus` | 引用 m06-ad 第 4 节 | 商家端广告显示状态（`producing`、`pending_confirm`、`revising`、`confirmed`、`cancelled`），由 `ad.status` 按 m06 的映射得出；本文不再返回原始 `ad.status` |

### 4.3 样片

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `SampleStatus` | `uploaded`、`check_rejected`、`qc_rejected`、`qc_passed`、`pushed`、`confirmed`、`change_requested`、`superseded` | 同数据模型 `sample.status`；商家端只会看到后四个 |
| `PreviewChannel` | 引用 m06-ad 第 4 节 | `weapp`、`album`、`portal`、`wecom`（小程序内播放、保存到相册、电脑端、企业微信）；本文用于 `sample.preview_channels[]`、`sample.confirm_viewed_via`。m06 是唯一定义，本文不再定义（A152、C87） |
| `SampleFeedbackKind` | `compose`、`ad_content` | 同数据模型 `sample.feedback_kind`；商家端请求只接受 `compose`（A31），响应可能出现交付经理代录的 `ad_content` |
| `DeliveryTicketStep` | 13 个取值 | 同数据模型 `delivery_ticket.step` |
| `ChecklistResult` | `pass`、`fail`、`na` | 同数据模型 `ChecklistResults.result` |

### 4.4 成片包与下载

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `ReleaseKind` | `initial`、`reissue` | 同数据模型 `delivery_release.kind` |
| `ReleaseState` | `pushed`、`superseded`、`closed` | 同数据模型 `delivery_release.state` |
| `ReleaseCloseReason` | `cancelled`、`usage_ended` | 同数据模型 `delivery_release.close_reason` |
| `DownloadGrantState` | `active`、`superseded`、`revoked` | 同数据模型 `download_grant.state` |
| `DownloadKind` | `episode` | 商家端只接受单集；数据模型 `delivery_download_log.kind` 另有 `zip`、`publish_list`（下载页用） |
| `DownloadClientAck` | `saved`、`failed` | 同数据模型 `delivery_download_log.client_ack` |
| `DownloadGrantInvalidReason` | `expired`、`superseded`、`revoked`、`missing` | 接口枚举：`DOWNLOAD_GRANT_INVALID` 的 `details.reason`（`missing` = 没有任何授权） |
| `DownloadUnavailableReason` | `not_delivered`、`release_closed`、`order_item_closed`、`usage_ended`、`file_unavailable` | 接口枚举：`DOWNLOAD_NOT_AVAILABLE` 的 `details.reason` |

### 4.5 上线

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `LaunchReviewStatus` | `pending`、`verifying`、`need_fix`、`passed`、`void` | 同数据模型 `launch_task.review_status`；商家端显示待发布、核验中、需补充、已通过、已作废 |
| `LaunchVoidReason` | `terminated`、`usage_expired`、`account_changed` | 同数据模型 `launch_task.void_reason` |
| `LinkKind` | `collection`、`episodes` | 同数据模型 `launch_submission.link_kind` |
| `LaunchSubmissionResult` | `pending`、`passed`、`passed_partial`、`returned`、`revoked`、`withdrawn` | 同数据模型 `launch_submission.result` |
| `LaunchTimelineKind` | `created`、`submitted`、`passed`、`passed_partial`、`returned`、`revoked`、`withdrawn`、`voided` | 接口枚举：上线记录时间线条目 |
| `PatrolStatus` | `normal`、`abnormal`、`recovered` | 数据模型 `patrol_task.status` 中已给出结论的三个取值 |
| `LaunchTaskTab` | `todo`、`done`、`all` | 接口枚举：上线任务页签；`all` 不过滤（上线记录页用，不是页面页签，`summary` 不给计数） |
| `OrderItemPhase` | 8 个取值 | 同数据模型 `order_item.phase` |

### 4.6 下架

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `TakedownStatus` | `pending_merchant`、`merchant_confirmed`、`checked`、`void` | 同数据模型 `takedown_task.status`；接口不返回 `void` 的任务 |
| `TakedownTriggerKind` | `expiry`、`early_end`、`platform_termination`、`terminated_after_delivery` | 同数据模型 `takedown_task.trigger_kind` |
| `TakedownBasis` | `live`、`delivered_unverified` | 同数据模型 `takedown_task.basis` |
| `TakedownMethod` | `delete`、`private`、`not_published` | 同数据模型 `takedown_task.merchant_method` |
| `TakedownTab` | `pending`、`done` | 接口枚举：下架任务页签 |

### 4.7 授权书

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `LicenseLetterStatus` | `pending_effective`、`effective`、`voided` | 同数据模型 `license_letter.status` |
| `LicenseLetterDisplayStatus` | `pending_effective`、`effective`、`expired`、`voided` | 接口枚举：`expired`（已失效）由 `effective` 且止日早于今天派生（13-notify-docs.md:902） |
| `LicenseLetterVoidReason` | `cancelled`、`terminated`、`account_removed`、`manual` | 同数据模型 `license_letter.void_reason` |
| `LicenseRevisionReason` | `initial`、`go_live`、`period_changed`、`correction`、`resign` | 同数据模型 `license_letter_revision.reason` |
| `SignMode` | `platform_cert`、`esign_seal`、`stamp` | 同数据模型 `license_letter_revision.sign_mode` |

会增长的响应枚举（状态、类型、原因）在契约里标 `x-open-enum`，端上必须有未知值兜底（C37）。

## 5. 错误码

本文新定义的领域错误码。数值取自 A70 分给本文的区间：交付 45100–45199，发布 46100–46199。`retryable` 全部为否（C26）。

| 符号 | 数值 | HTTP | 含义 | `details` |
| --- | --- | --- | --- | --- |
| `ORDER_IN_AFTER_SALE` | 45101 | 409 | 订购单有在途取消申请，方案的推送、确认、提出修改都暂停（10-delivery.md:413；d3-flow.md:880）。后台 `admin.deliveryPlan.push` 同样返回它 | `{ orderId }` |
| `PLAN_VERSION_STALE` | 45102 | 409 | 确认的方案版本不是当前版本（d3-flow.md:1139、1161） | `{ currentVersionNo }` |
| `TICKET_ON_HOLD` | 45103 | 409 | 交付工单暂停中（取消审批中、方案修订待确认），属于这张工单的对象一律拒绝操作（d3-flow.md:879）。后台的样片、成片接口同样返回它；a06 的链接核验只有通过与撤销返回它，退回按数据模型不检查暂停（11-publish.md:302），不返回 | `{ reasons: ('cancel_review'\|'plan_amendment')[] }` |
| `SAMPLE_VERSION_STALE` | 45104 | 409 | 操作的样片不是当前已推送的版本 | `{ currentSampleId: string \| null, currentVersionNo: integer \| null }` |
| `AD_CHANGED` | 45105 | 409 | 样片所用的广告版本已不是当前确认版本，不能确认（d3-flow.md:838，沿用草案名） | `{ adIds: string[] }` |
| `SAMPLE_NOT_VIEWABLE` | 45106 | 409 | 历史查看证据错误定义保留；Q9 新样片确认不再以相册/portal/企业微信记录放行 | 原 requiredEvidence 等细节仅历史兼容，不表示关停兜底仍可用 |
| `SAMPLE_VIEW_CHANNEL_NOT_OFFERED` | 45107 | 409 | 该样片版本推送时没有提供这种查看方式 | `{ previewChannels: PreviewChannel[] }`（该版本提供的查看方式；与 m06 `AD_PREVIEW_CHANNEL_UNAVAILABLE` 同一枚举） |
| `SAMPLE_PREVIEW_NOT_READY` | 45108 | 409 | 样片水印版尚未生成，请稍后再试 | 无 |
| `DOWNLOAD_GRANT_INVALID` | 45109 | 409 | 下载授权已过期、已被重新生成或已撤销（d7-platform.md:832）。下载页的 `portal.orderItem.downloadUrls` 同样返回它 | `{ reason: DownloadGrantInvalidReason, expiresAt: string \| null, canRegenerate: boolean }` |
| `DOWNLOAD_NOT_AVAILABLE` | 45110 | 409 | 成片当前不可下载或不可重新生成授权（未交付、成片包已关闭、订单项已关闭、已过使用期、文件不可用）。下载页同样返回它 | `{ reason: DownloadUnavailableReason }` |
| `DOWNLOAD_REGRANT_LIMIT` | 45111 | 409 | 今天重新生成下载授权已达 5 次 | `{ limit: 5, nextAvailableAt: string }` |
| `LICENSE_LETTER_NOT_READY` | 45112 | 409 | 授权书（或指定版次）尚未出件 | `{ renderStatus: 'queued'\|'rendering'\|'failed'\|null }` |
| `CHANNEL_ACCOUNT_TAKEN` | 46101 | 409 | 同一平台同一账号 ID 已被绑定（PRD 6.10.2-1；`uq_channel_account_platform_uid_active`） | 无（不透露占用方） |
| `CHANNEL_ACCOUNT_IN_USE` | 46102 | 409 | 账号仍被在办订单项引用或有未核查的下架任务，不能解绑（d3-flow.md:2042） | `{ activeOrderItemCount, openTakedownTaskCount }` |
| `LINK_INVALID` | 46103 | 400 | 上线链接不合规（d3-flow.md:1759，沿用草案名；422 按 C24 改为 400） | `{ field: string, reason: 'unparsable'\|'not_https'\|'too_long'\|'has_credentials'\|'duplicate_episode'\|'episode_out_of_range' }` |
| `LAUNCH_SUBMISSION_OUT_OF_RANGE` | 46104 | 400 | 回填的实际上线日期或声明集数超出允许范围（d3-flow.md:1754） | `{ field: 'actualLaunchDate'\|'reportedEpisodeCount', min: string\|integer, max: string\|integer }` |
| `LAUNCH_WINDOW_CLOSED` | 46105 | 409 | 已过使用期止日，不能再回填（d3-flow.md:1754） | `{ usageEndDate }` |
| `TAKEDOWN_METHOD_NOT_ALLOWED` | 46106 | 409 | 该账号已核验上线，不能选“未发布”（11-publish.md:654） | `{ basis, allowedMethods: string[] }` |

引用的其他文档的错误码：`STORE_NOT_QUALIFIED`（门店闸门，共用领域码，m04-mall-order 定义为 45008、HTTP 409，A77、C28；与确认订购同源，d3-flow.md:419）；`STORE_ARCHIVED`（成员关系中间件，C17，m02-tenant 定义）；`FILE_NOT_USABLE`（46001，m03-profile-asset 定义，`files.link()` 的统一出口）。通用码（C27）：`VALIDATION_FAILED`、`STATE_NOT_ALLOWED`、`NOT_FOUND`、`ROLE_FORBIDDEN`。

被其他文档复用的本文错误码（只引用、不重新定义）：`TICKET_ON_HOLD`、`DOWNLOAD_GRANT_INVALID`（a06）；`ORDER_IN_AFTER_SALE`、`TICKET_ON_HOLD`、`SAMPLE_VERSION_STALE`、`AD_CHANGED`（a05）；`DOWNLOAD_GRANT_INVALID`、`DOWNLOAD_NOT_AVAILABLE`、`SAMPLE_VIEW_CHANNEL_NOT_OFFERED`、`SAMPLE_PREVIEW_NOT_READY`（p01）。

## 6. 待确认

| # | 问题 | 默认做法 | 由谁定 |
| --- | --- | --- | --- |
| 1 | Q9 已明确样片仅小程序内查看且确认必须勾选；自声明的证据效力及类目、提审、真机仍未验（B4） | 当期仅 weapp + hasViewed=true，关停拒绝确认；历史 enum、字段与记录保留，不使用其他渠道兜底 | 产品 + 法务 |
| 2 | 方案页“定制方式 按门店重新制作画面、场景与植入”在数据模型里没有来源（定制方式的定义是 B1） | 本文不返回；页面去掉这一行或写成与实际能力一致的静态说明（设计规范 11 节“写进剧情”一类文案要收敛） | 产品 + 法务 |
| 3 | 上线记录是否向商家展示核验人、巡检人姓名（proto-merchant-a.md:616） | 展示对商家的称呼（`staff.display_name`，空时 `name`），与服务经理名片一致 | 产品 |
| 4 | 已作废的授权书（人工作废并重出、订单项取消）是否在商家端列出 | 缺省隐藏，`includeVoided=true` 可看；作废后重出的新信照常列出 | 产品 + 法务 |
| 5 | 个人认证、未认证账号能否作为被授权账号（11-publish.md:111） | 三种类型都可核验通过、都可绑定 | 法务 |
| 6 | 方案推送后、商家确认前，方案里的账号被标记异常或解绑时，确认是否应拦下 | 按数据模型守卫不拦（推送时已校验可用）；解绑本身已被在办订单项挡住，标记异常“不影响在办订单”（d3-flow.md:2041） | 产品 |

第一轮的“主页截图张数上限（1–3 张）”“每日重新生成授权 5 次是否做成参数”两项按接口裁决第十节开头的规则接受默认处理（截图 1–3 张为契约层约束；5 次按数据模型写死，10-delivery.md:1034），不再列为待确认。

## 7. 修订记录

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：路线图 `doc = m05-delivery-publish` 的 29 条接口（V1.0 27、V1.1 2）；新定义错误码 18 个（45101–45112、46101–46106） | 写作规范；A1–A75；C1–C84；数据模型 10、11、13 分组 |
| 2026-10-03 | 下架任务页“最早结束剧目与下架任务生成日”放到 `m.takedownTask.summary` 的 `nextTakedown`，不放在列表外壳里 | C42、C83 |

### 第二轮（2026-10-03）

依据：接口裁决第十节（A76–A120）与 A121–A126；`review/xdoc-m05-delivery-publish.md`；两位复核员的意见（页面与数据模型、约定与跨文档）；`review/api-check.md`。接口数不变（29），错误码不增不减。

| 改动 | 依据 |
| --- | --- |
| 出站事件按 x01 目录补齐：3.2、3.3、3.20 补 `approval.submitted`（通知发布专员的是审批单事件，`account.submitted`、`launch.submitted` 的说明改为与 x01 的订阅者一致）；3.4 撤回在途核验单时补 `approval.withdrawn`；3.6 每张解除暂停的工单补 `ticket.resumed`；3.23 补进入到期下架的 `ticket.step_changed`、收尾产生的 `launch.voided` / `launch.settled` / `approval.withdrawn` / 可能的 `takedown.created`、归档的 `ticket.archived`，并写出第 15 行处理器的同事务收尾与归档时成片包关闭；3.7 的 `plan.change_requested` 去掉“建议名” | A95；x01 E2；10-delivery.md:186-204；复核 B |
| `plan.confirmed` 的载荷按 x01，不再写“含账号集合是否变化”，授权书由 docs 订阅者的收敛函数自行比对 | x01 第 3 节；复核 B |
| 3.6 方案确认对 `order_item_placement` 改为按（`slot`, `adId`）比对：未变的行保留钉住的版本与 `pinned_at`，新增或更换的写为浮动；`order_item_account` 只增删 | 09-order-ad.md:417-449（I5）；d3-flow.md:1170；复核 A |
| 结果脱敏：3.6、3.7、3.9、3.10、3.23 登记 `x-redact-on-replay` 字段，响应改为 `DeliveryPlanWriteResult`、`SampleWriteResult`、`TakedownTaskWriteResult`（详情 + `replayed`）；1.1 补规则 | A80、A124；C50、C75；复核 B |
| 订单项封面 `posterUrl`（`PlanItemView`、`LaunchTaskItem`、`TakedownTaskCard`）改为 `SignedUrl \| null`；`LaunchTaskDetail.orderItem.remainingDays` 与 m04 同口径（可空、不小于 0、只在上线中给值） | C60；m04-mall-order 2.8；复核 B |
| 样片：删掉本文自定义的 `Playable`，引用 m06-ad 2.8；开关关闭时返回对象（带封面）、`sources = []`、`expiresAt = null`；`SampleView` 加 `viewEvidence`（按途径分开的证据时间）与 `confirmableVia`（可提交的查看方式，端上取第一个作 `viewedVia`）；补“开关推送后被关闭、版本只提供 `weapp`”的兜底（可保存到相册，确认须勾选并有访问记录）；`SAMPLE_NOT_VIEWABLE.details.requiredEvidence` 加 `album_or_portal` | C62；xdoc（m06、p01）；d7-platform.md:805-810；10-delivery.md:562；复核 A、B |
| 访问留痕补 `category = file_access` 与动作名：保存样片 `delivery.sample.album_download`（meta 带 `fileCategory`、`urlTtlSec`）、授权书 PDF `docs.license_letter.download`；`m.sample.confirm` 按 `action` + `target_id` 核对证据，与 m06、p01 一致 | `audit_log.category`、`action` NOT NULL；xdoc（p01）；复核 B |
| 截图类文件不可用改为 `FILE_NOT_USABLE`（m03 定义），补“未被内容安全拦截”；`VALIDATION_FAILED` 只留张数与重复；1.1 补“文件引用”规则 | m03-profile-asset 1.1、第 5 节；复核 B |
| 上线记录页取任务改为 `m.launchTask.list?orderItemId=…&tab=all`：`LaunchTaskTab` 加 `all`（不过滤、含已作废，不给计数）；详情只在 `m.launchTask.get` | proto LaunchRecord；xdoc（m04）；复核 A、B |
| 上线记录时间线：条目加 `linkKind`；撤销重开的行不生成 `submitted`；`revoked` 的时间取 `status_transition`（`event = launch.verify_revoke`） | 11-publish.md:402-404；复核 A |
| `m.launchTask.submit` 的声明集数下限改为 `max(1, 已核验集数)` | `ck_launch_submission_reported_episode_count`；复核 A |
| `m.channelAccount.list`：确认订购页不再传 `status=available`，由端上只让可用账号可选、异常账号给“补充后可选 ›” | Checkout.dc.html:43；复核 A |
| 方案页：`referenceAssets` 加 `contentTagCodes`（按内容标签汇总）；`PlanPlacementView` 的 `adStatus` 改为 m06 的 `adDisplayStatus`，加 `nextVersionNo`、`openRevisionRequestedAt`，`latestVersionNo` 说明改为“已登记的最新版本” | 06-media.md 2.18；m06-ad 第 4 节；Plan.dc.html:64；复核 A、B |
| 下架任务 `done` 页签按 `COALESCE(merchant_confirmed_at, checked_at)` 倒序加 id 兜底；`TakedownTaskCard` 写明商家未确认直接核查通过的任务确认字段为空 | 11-publish.md:631、655；复核 A |
| 逐集下载的 `package_download` 埋点写明直记规则与去重键 `srv-pkgdl-{releaseId}-{userId}-episode-{业务日}` | d6-notify-docs-data.md:1854；p01；复核 B |
| 授权书 `verifyUrl` 改为带版次的 `/v?code=…&rev=…` | A100；C1；复核 B |
| 新增 1.2：登记给其他模块的守卫计数 `StoreCloseGuard` 的 `open_delivery_ticket`、`channel_account_in_review`，注销与关闭主体的 `release_online` | xdoc（m01、m02） |
| 订阅结果上报写明 m08 的 `m.subscribeResult.create`；电脑端下载与预览入口写明 m02 的 `m.portalTicket.lookup` | xdoc（m08、m02） |
| `STORE_NOT_QUALIFIED` 保留引用（A77 归 m04；m04 第二轮已定义为 45008、HTTP 409，api-check 第 2 节的“未定义”随之消除），3.2 的“何时”与 m04 的闸门口径对齐 | A77；api-check 第 2 节 |
| 第 6 节删去两项已按默认处理的事项（截图张数、重新生成次数是否做成参数），余下 6 项都需产品或法务决定 | 裁决第十节开头、A108 |
| 路线图切片：按本文作者的建议与本轮改动更新各条的 `tables` 与 `notes`（详见切片） | xdoc（本文作者）；A119 |

### 第三轮（2026-10-03）

依据：接口裁决第十二节（A127–A146）；约定 C85–C87；`review/r3-in-m05-delivery-publish.md`（第二轮各修订员的请求与公共结构核对）。接口数不变（29），错误码不增不减。本文没有后台驳回接口，不涉及 C86 的 `x-step-up: skip`。

| 改动 | 依据 |
| --- | --- |
| 字典项出接口改为 `DictRef`：`PlanItemView.genreCodes` → `genres`；`ChannelAccountCard.abnormalReasonCode` + `abnormalReasonLabel` → `abnormalReason`；`PatrolRecordView.abnormalKindCode` + `abnormalKindLabel` → `abnormalKind`；`LaunchTaskCard.returnInfo` 与时间线的 `reasonCodes` / `reasonLabels` → `reasons`；`referenceAssets[].contentTagCodes` → `contentTags`；1.1 “字典项”规则改写 | A133；C85 |
| 公共结构按登记表：删去本文的 `CursorPage`（C42 的分页外壳，只作记法）与 `SignedUrl`（引用 a01）；`SampleDownloadUrl` 改为本文定义的 `DownloadUrl`（与 m06 `AdDownloadUrl` 同构合并，`sizeBytes` 不可空），m06 引用；`ChannelAccountBrief` 注明本文定义、a06 引用；`ChecklistItemView` 注明与 a05 `AdminChecklistItemView` 区分（商家端 OpenAPI 无同名结构，不改名）；`PublishListView.cover` 改为 m08 的 `ImageRef`；2.1 列出引用的外部结构 | A132；C87 |
| `Playable` 按 C62 三种情形写明（未就绪 `null`、不能播放只带海报 `sources = []`）；`posterUrl` 按 m06 2.8 取 `cover_file_id`，为空取 `media_info.cover_file_id` | A135；C62；m06-ad 2.8 |
| 三条签发接口（3.11、3.14、3.27）的限流改为 `m.sign` | A130；C68 |
| `LicenseLetterCard.periodStart` / `periodEnd` 改名 `periodStartDate` / `periodEndDate`；`LicenseLetterPreview.period`、`consent` 改为引用 p01 的 `LicensePeriod`、`LicenseConsent`；`verifyUrl` 写明“对齐函数插入版次（`queued`）时随快照写入，之后不可改” | C15；p01-portal 2.5；A145；13-notify-docs.md:1156 |
| `LaunchTaskDetail` 删去 `orderItem`，M:LaunchRecord 页头只以 m04 `m.orderItem.get` 为准；1.1 补“待办深链”参数 | m04 的请求；m04-mall-order 3.2 |
| `PlacementSlot` 改为引用 m06 第 4 节（4 个取值，`x-open-enum`），删去本文的两值同名枚举 | m06 的请求；`ck_order_item_placement_slot` |
| 方案页：参考素材缩略图写明调 m03 `m.storeAsset.list?ids=…`；新增 `PlanContentView.profileMedia`（订购单登记的门店档案媒体，按 `file_ref` 列出，与 a05 `ReferenceFileView` 同口径）；3.6 同步参考素材只增删素材库来源的登记，档案媒体行不动 | m03、a05 的请求；A142；10-delivery.md:423 |
| `SAMPLE_VIEW_CHANNEL_NOT_OFFERED.details.previewChannels` 改为 `PreviewChannel[]`；`TICKET_ON_HOLD` 写明 a06 链接核验只在通过与撤销时返回 | p01、a06 的请求；11-publish.md:302 |
| 3.14 `package_download` 直记埋点补 `actor_id`、`role = owner`、`entity_id`、`store_id` | p01 的请求；`ck_analytics_event_actor`、`ck_analytics_event_scope` |
| 第 6 节 6 项均未被 A127–A146 裁决，保留 | A127–A146 |
| 清单与路线图切片同步：结构字段改名、`externalSchemas`、各条 `notes` | A140 |

### 第四轮（2026-10-03）

第 4 节 `PreviewChannel` 改为引用 m06-ad 第 4 节，本文不再定义，清单 `externalSchemas` 补登（A152、C87）；3.8 响应已是 2.1 的 `DownloadUrl`（`sizeBytes` 非空），m06 的请求在第三轮已落实（A150）。接口数、错误码不变。
