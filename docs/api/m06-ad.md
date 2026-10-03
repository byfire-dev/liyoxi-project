# 商家端：广告

| 项 | 内容 |
| --- | --- |
| 范围 | 商家端“我的广告”`M:Ads`（含底部弹层“提交制作需求”M42）、广告视频详情 `M:AdDetail`；确认订购页 `M:Checkout` 选片头、片尾广告时复用广告列表；小程序内视频“换播放地址”（广告、样片、预告片共用，`M:AdDetail`、`M:Sample`，`M:Detail`、`M:Trailer` 仅在日后开关打开时用到）。档案页 `M:Profile` 的广告计数取 m03-profile-asset 的 `AdsBrief`，方案确认页 `M:Plan` 的广告卡取 m05-delivery-publish 的 `PlanPlacementView`，两处的显示映射按本文第 4 节 |
| 接口数 | 9（V1.0 9，V1.1 0） |
| 依据 | 数据模型 09 分组 `ad`、`ad_version`、`ad_revision`、`order_item_placement`（`09-order-ad.md:415-1091`）；06 分组 `playable_asset`、`media_info`、`file_ref`、`store_asset_usage`（`06-media.md:403`、`828-905`、`1330-1366`、`1732-1737`）；04 分组 `store_profile_media`（`04-profile.md:170`）；07 分组 `point_hold`、`billing_param`、计价快照（`07-billing-ledger.md:780-866`、`1439-1491`）；13 分组 `agreement`、`agreement_consent`（`13-notify-docs.md:690-697`、`760-822`）；10 分组 `delivery_ticket` 迁移表与 `sample` 状态机（`10-delivery.md:170-194`、`616-651`）；12 分组 `service_ticket_ref`（`12-support.md:329-370`）。草案 d3 §9（`d3-flow.md:1178-1409`）、§10.3（`d3-flow.md:1527-1546`）、附录 B（`d3-flow.md:3511`）；d5 §7（`d5-media.md:1417-1525`）；d1 §11（`d1-ledger.md:1649`、`1681`、`1724`）；d4 门店额度（`d4-identity.md:673`）；d6 交易协议（`d6-notify-docs-data.md:1172-1179`）与订阅点位（`d6-notify-docs-data.md:863`）；d7 §4.10（`d7-platform.md:790-810`）。裁决 A1–A156（第二轮按第十节 A77、A87、A95、A97、A107；第三轮按 A130–A137、A146、A147、A150；第四轮按 A151、A152），约定 C1–C87；事件名以 x01-events-jobs 为准 |
| 状态 | 第四轮修订（2026-10-03） |

路径省略 `/api/v1`。引用写法同约定：`文件:行号`；草案文件名省略目录；“本稿补充”= 依据没写、本文为闭合接口而定的做法。

## 1. 概览

一条广告 = 一次制作需求 + 它的全部版本 + 修改轮次，独立的 `GG` 编号，不是订购单（`09-order-ad.md:17`；`05-risks-and-open-issues.md:196`）。商家端只有老板能用（能力点 `ad.request`、`ad.confirm`，店员 403，`d4-identity.md:865`）：看列表与详情、提交需求（同一事务记协议同意并冻结积分）、补充素材后重新提交、确认某一版、提出修改意见（超出免费次数时同一事务扣积分）、保存某一版到相册。广告的指派、退回、上传与推送版本、取消都在后台（a05-order-delivery），商家端没有入口。小程序内的播放地址随详情返回，过期或播放报错时调 `m.playable.get` 换新；需要“已查看”证据的读走 `m.ad.downloadUrls`（相册）与下载页的 `portal.ad.playbackUrls`（电脑端，p01-portal）（A19、C60、C62）。版本的查看方式在推送时由系统按开关写定（A97），商家端的播放、出口与确认校验以该版本的 `preview_channels` 为准；开关在推送后被关闭时按样片的同一兜底处理（可保存到相册，确认须勾选并有访问记录），与 m05-delivery-publish 3.8、3.9 同一口径。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `m.ad.list` | `GET /m/ads` | 我的广告列表；确认订购页选广告 | member；`ad.request`；店员 none | none（查询） |
| `m.ad.quote` | `POST /m/ads/quote` | 提交需求前的计价与可提交性 | member；`ad.request`；店员 none | none（试算） |
| `m.ad.create` | `POST /m/ads` | 提交广告制作需求并冻结积分 | member；`ad.request`；店员 none | required |
| `m.ad.get` | `GET /m/ads/{adId}` | 广告详情（版本、分段、播放、修改轮次、制作记录、影响提示、相关工单） | member；`ad.request`；店员 none | none（查询） |
| `m.ad.confirm` | `POST /m/ads/{adId}/confirm` | 确认使用某一版 | member；`ad.confirm`；店员 none | required |
| `m.ad.requestChange` | `POST /m/ads/{adId}/request-change` | 提出修改意见（超次扣积分） | member；`ad.confirm`；店员 none | required |
| `m.ad.submit` | `POST /m/ads/{adId}/submit` | 被退回补充素材后重新提交 | member；`ad.request`；店员 none | required |
| `m.ad.downloadUrls` | `POST /m/ads/{adId}/download-urls` | 签发某一版的短时下载地址（保存到相册查看），写访问留痕 | member；`ad.request`；店员 none | none（签发短时地址） |
| `m.playable.get` | `GET /m/playables/{playableId}` | 换取播放地址（广告、样片、预告片） | optional；`assert-in-handler`（按资产种类判定，A87）；店员 same | none（查询） |

路由顺序：字面段 `/m/ads/quote` 先于 `/m/ads/{adId}` 注册（A8、C12）。限流：签发接口 `m.ad.downloadUrls` 用 `m.sign`（每用户每小时 600 次，A130），其余为 `m.global`（C68）。全部商家端写接口在中间件阶段照常经过版本门槛、协议同意（428 `CONSENT_REQUIRED`）、成员关系（403 `NOT_A_MEMBER`）、能力点（店员 403 `ROLE_FORBIDDEN`；已停用门店的老板 403 `STORE_ARCHIVED`，`ad.request`、`ad.confirm` 都不属于收尾能力，`d4-identity.md:865`），这些通用错误下文不再逐条列出（C7、C27）。响应里带签名地址的 `m.ad.list`、`m.ad.get`、`m.ad.downloadUrls`、`m.playable.get` 一律带 `Cache-Control: no-store`（C18）。

**本模块登记给其他模块的守卫与只读查询**（模块内调用，不是 HTTP 接口）

| 名称 | 调用方 | 口径 |
| --- | --- | --- |
| `StoreCloseGuard` 注册项 `ad_in_production` | m02-tenant 门店停用（`STORE_HAS_OPEN_WORK.details.blockers`，`d4-identity.md:790`） | `countBlocking(tx, storeId)` = 本门店 `ad.status` ∈ {`pending_assign`、`producing`、`returned`、`pending_confirm`、`revising`} 的条数（已确认、已取消不计）；`message` 如“有 2 条广告在制作或待确认，请办结后再停用” |
| `ads.getAdNos(adIds)` | m03-profile-asset 素材详情的使用记录（`store_asset_usage.used_by_type = ad`，`no` 取广告编号） | 按 `ad.id` 返回 `ad.ad_no`，只读、限调用方给定的门店；media 不读 L3，由路由层调用（`06-media.md:1800`） |
| `ads.isSelectable(ad)` | m04-mall-order `m.order.quote` 的 `ads[]` 与 `m.order.create` 的 `ORDER_AD_INVALID` | 与 2.1 `isSelectable` 同一口径：`confirmed_version_no` 非空、未取消、无在途取消；类型与广告位、剧目允许的植入形式由 m04 另判 |

## 2. 公共结构

### 2.1 `AdCard`（列表卡片）

| 字段 | 类型 | 必有 | 说明 | 来源（表.列 或计算规则） |
| --- | --- | --- | --- | --- |
| `adId` | string(uuid) | 是 | 广告 id | `ad.id` |
| `adNo` | string | 是 | 广告编号（GG…），即“需求编号” | `ad.ad_no` |
| `type` | enum(`AdType`) | 是 | 广告类型（植入形式） | `ad.type` |
| `durationSec` | integer | 是 | 时长（秒） | `ad.duration_sec` |
| `status` | enum(`AdStatus`) | 是 | 广告状态（数据模型的 7 个取值） | `ad.status` |
| `displayStatus` | enum(`AdDisplayStatus`) | 是 | 商家端显示的状态（第 4 节映射） | 由 `ad.status` 推出（`d3-flow.md:1257`） |
| `waitingReason` | enum(`AdWaitingReason`) \| null | 是 | 制作中的等待原因：`materials` 待补充素材；`qualification` 等待门店资质审核后开始制作 | `ad.status = returned` → `materials`；`ad.status = pending_assign` 且门店闸门不是 `full` → `qualification`（`profile.storeGate`，`d3-flow.md:1295`）；其余 null |
| `returnReason` | string \| null | 是 | 退回补充的原因；仅 `status = returned` 时有值 | `ad.return_reason` |
| `copy` | string \| null | 是 | 广告文案 | `ad.copy` |
| `promoPoints` | array<`DictRef`> | 是 | 宣传重点（C85：响应给 `DictRef[]`，见 2.3） | `ad.promo_point_codes`，名称取 `dict_item.name`（字典 `ad_promo_point`） |
| `coverUrl` | string \| null | 是 | 封面（当前版本视频的派生封面）；尚无已推送版本、或尚未抽帧时为 null | 当前版本可播放资产的 `playable_asset.cover_file_id` 非空时取它；否则取当前版本文件的体检抽帧 `media_info.cover_file_id`（`media_info.file_id` = 当前版本的 `ad_version.file_id`；广告不转码，体检通过即就绪，封面来自抽帧，`06-media.md:403`、`d5-media.md:742`）。30 分钟对齐窗口签名（C60、C61；`09-order-ad.md:683`） |
| `coverExpiresAt` | string(date-time) \| null | 是 | 封面地址到期时刻 | 签名结果 |
| `currentVersionNo` | integer \| null | 是 | 当前版本 = 已推送的最大版本号；尚无为 null。上传后未推送的版本商家看不到 | `ad_version.version_no` 中 `pushed_at` 非空的最大值 |
| `currentPreviewChannels` | array<enum(`PreviewChannel`)> | 是 | 当前版本推送时确定的查看方式；列表上“确认使用”只在含 `weapp` 且开关 `weapp.video.ad.enabled` 此刻为开（端上取引导接口的开关）时直接提交，否则进详情 | 当前版本的 `ad_version.preview_channels` |
| `confirmedVersionNo` | integer \| null | 是 | 最近一次确认的版本（“确认第 2 版”） | `ad.confirmed_version_no` |
| `confirmedAt` | string(date-time) \| null | 是 | 最近一次确认时间 | `ad.confirmed_at` |
| `isSelectable` | boolean | 是 | 可在订购中选用 | `ad.confirmed_version_no` 非空，且 `ad.status` 不是 `cancelled`，且 `ad.open_cancel_request_id` 为空（`09-order-ad.md:716`；`d3-flow.md:1356`） |
| `freeRevisionQuota` | integer | 是 | 免费修改次数（提交时快照） | `ad.free_revision_quota` |
| `revisionCount` | integer | 是 | 已提出修改的次数 | `ad.revision_count` |
| `freeRevisionsRemaining` | integer | 是 | 剩余免费修改次数 | max(`ad.free_revision_quota` − `ad.revision_count`, 0) |
| `chargePoints` | integer(积分) | 是 | 本条应扣积分（“已冻结 45 积分”） | `ad.charge_points` |
| `isCaptured` | boolean | 是 | 是否已由冻结转扣减（指派剪辑师即扣减） | `ad.captured_at` 非空 |
| `dueAt` | string(date-time) \| null | 是 | 当前应交付时间（“预计 09-30 18:00 前推送首版”）；待补充期间为 null。推送后保留最近一次的时限，端上只在 `displayStatus` 为 `producing`、`revising` 时显示 | `ad.due_at` |
| `dueKind` | enum(`AdDueKind`) \| null | 是 | `dueAt` 是首版还是修改版的时限 | `ad.sla_snapshot.policy`：`ad.first_version` → `first_version`，`ad.revision` → `revision`（`09-order-ad.md:1081`） |
| `usage` | `AdUsage` | 是 | 使用情况（“使用中：《家有萌娃》等 5 部”） | 见 2.4 |
| `hasOpenCancelRequest` | boolean | 是 | 有在途的取消申请（审批结束前广告的其他迁移一律拒绝） | `ad.open_cancel_request_id` 非空（`09-order-ad.md:718`、`811`） |
| `submittedAt` | string(date-time) | 是 | 提交时间（“09-28 提交”） | `ad.submitted_at` |
| `updatedAt` | string(date-time) | 是 | 更新时间（“更新于 09-30”） | `ad.updated_at` |
| `actions` | array<string> | 是 | 当前观察者此刻可执行的动作（C16）：`confirm`、`request-change`、`submit` | 见第 4 节“可执行动作” |

### 2.2 `AdDetail`（详情）

包含 `AdCard` 的全部字段，另加：

| 字段 | 类型 | 必有 | 说明 | 来源（表.列 或计算规则） |
| --- | --- | --- | --- | --- |
| `remark` | string \| null | 是 | 备注 | `ad.remark` |
| `unitPricePoints` | integer(积分) | 是 | 提交时的每条积分（快照） | `ad.unit_price_points` |
| `discountBp` | integer | 是 | 提交时的套餐折扣（万分比，快照） | `ad.discount_bp` |
| `capturedAt` | string(date-time) \| null | 是 | 扣减时间 | `ad.captured_at` |
| `firstDueAt` | string(date-time) | 是 | 首版应交付时间 | `ad.first_due_at` |
| `editorName` | string \| null | 是 | 剪辑师对商家展示的称呼；未指派为 null | `ad.editor_id` → `staff.display_name`，为空取 `staff.name`（`03-staff-authz-audit.md:170`） |
| `revisionUnitChargePoints` | integer(积分) \| null | 是 | 超出免费次数后每次修改扣的积分（“超出后每次按 1 条扣 45 积分”），按此刻的单价与套餐折扣算；套餐未生效时为 null（此时超次修改不能提交） | `billing.quoteAdUnit({ entityId }).S`（`d1-ledger.md:1649`；`d3-flow.md:1310`、`1323`） |
| `revisionScreenshotMax` | integer | 是 | 修改意见可附的截图张数上限（弹层“添加截图（1 张）”） | 参数 `ad.revision_screenshot_max`（A107、A146：07 待回写清单，默认 1；`09-order-ad.md:947`） |
| `currentVersion` | `AdVersionView` \| null | 是 | 当前版本（含规格 1080×1920） | 同 `currentVersionNo` |
| `playable` | `Playable` \| null | 是 | 当前版本的播放数据。资产就绪时返回（海报 `posterUrl` 不受开关影响）；`sources` 只在当前版本的 `previewChannels` 含 `weapp` 且开关 `weapp.video.ad.enabled` 此刻为开时有值，否则 `sources = []`、`expiresAt = null`，页面不内嵌播放器，端上按 `alternatives` 显示出口（C62；与 m05 `SampleView.playable` 同口径）；尚无已推送版本或资产未就绪为 null | `playable_asset`：`kind = ad`、`owner_type = ad`、`owner_id = ad.id`、`source_file_id = 当前版本的 ad_version.file_id`、`state = ready`（`06-media.md:844`） |
| `alternatives` | `AdAlternatives` | 是 | 小程序内不能播放时的查看出口 | 见 2.9 |
| `viewEvidence` | object | 是 | 当前版本按途径分开的查看证据 `{ albumSavedAt, portalViewedAt }`（各为 string(date-time) \| null）：首次保存到相册、首次在电脑端预览的时间；尚无已推送版本时两项都为 null | `albumSavedAt` = 当前版本最早一条访问审计（`audit_log.stream = access`、`audit_log.action = ad.version.album_download`、`audit_log.target_type = ad_version`、`audit_log.target_id` = 版本 id）的 `audit_log.created_at`；`portalViewedAt` 同上，`audit_log.action = ad.version.portal_preview`（p01 写） |
| `confirmableVia` | array<enum(`PreviewChannel`)> | 是 | 此刻有证据、可以提交确认的查看方式，按 `weapp`、`album`、`portal`、`wecom` 的顺序；端上把第一个作为 `m.ad.confirm` 的 `viewedVia` 提交，页面不另设选择控件；为空时“确认使用”置灰，提示先保存到相册或在电脑上查看；广告不是 `pending_confirm` 时为 `[]` | 按 3.5 的证据规则计算（与 m05 `SampleView.confirmableVia` 同源）：`weapp` = 当前版本 `previewChannels` 含 `weapp`，且开关此刻为开、或已有 `albumSavedAt` / `portalViewedAt`（开关被关闭后的兜底，2.9）；`album` = 含 `album` 且 `albumSavedAt` 非空；`portal` = 含 `portal` 且 `portalViewedAt` 非空；`wecom` = 含 `wecom` 且 `offlineSentAt` 非空 |
| `versions` | array<`AdVersionView`> | 是 | 已推送的全部版本，按版本号倒序 | `ad_version`（`pushed_at` 非空） |
| `revisions` | array<`AdRevisionView`> | 是 | 全部修改轮次，按轮次倒序 | `ad_revision` |
| `references` | array<`AdReference`> | 是 | 参考素材（“档案中的店内环境 2 张、团购信息”） | 见 2.10 |
| `floatingPlacements` | array<`AdFloatingPlacement`> | 是 | 浮动绑定本广告、尚在制作的订单项（“关联订单的影响提示”） | 见 2.11 |
| `relatedServiceTickets` | array<`AdRelatedServiceTicket`> | 是 | 关联本广告的客服工单（“相关工单”，A34） | 见 2.12 |
| `timeline` | array<`AdTimelineEntry`> | 是 | 制作记录时间线 | 见 2.13 |

### 2.3 宣传重点：引用 `DictRef`

不在本文定义（初稿的同构结构 `PromoPoint` 删去）：`promoPoints` 的元素是约定的通用结构 `DictRef = { code, name }`（C85、C87；A133、A150）。

| 字段 | 取值 | 来源 |
| --- | --- | --- |
| `code` | 字典编码 | `ad.promo_point_codes` 的元素 |
| `name` | 名称（品牌露出、优惠活动、团购、主推服务、到店引导）；字典项停用后仍按编码取名称 | `dict_item.name`（`dict_item.dict_type_key = ad_promo_point`，`14-config-data.md:111`） |

### 2.4 `AdUsage`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `inUseCount` | integer | 是 | 使用中的剧数 | `order_item_placement.ad_id = ad.id` 的订单项去重计数，只计 `order_item.phase` ∈ {`pending_start`、`producing`、`to_launch`、`live`}（`09-order-ad.md:436`、`683`） |
| `firstDramaTitle` | string \| null | 是 | 首部剧名（最早绑定的那一部）；`inUseCount = 0` 时为 null | 上述订单项中 `order_item_placement.created_at` 最早一条的 `order_item.drama_snapshot.title` |

### 2.5 `AdVersionView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `versionNo` | integer | 是 | 版本号 | `ad_version.version_no` |
| `uploadedAt` | string(date-time) | 是 | 上传时间（“第 1 版 · 上传时间”） | `ad_version.uploaded_at` |
| `pushedAt` | string(date-time) | 是 | 推送给商家确认的时间 | `ad_version.pushed_at` |
| `durationMs` | integer | 是 | 时长（毫秒） | `ad_version.duration_ms` |
| `width` | integer | 是 | 宽（像素） | `ad_version.width` |
| `height` | integer | 是 | 高（像素） | `ad_version.height` |
| `segments` | array<`AdSegment`> | 是 | 预置分段（选时间段提修改意见用）；剪辑师未填为 `[]` | `ad_version.segments`（`09-order-ad.md:1089-1091`） |
| `previewChannels` | array<enum(`PreviewChannel`)> | 是 | 推送时确定的查看方式 | `ad_version.preview_channels` |
| `offlineSentAt` | string(date-time) \| null | 是 | 经企业微信发送后，交付经理在后台登记“已发送”的时间（`admin.adVersion.markSent`，a05-order-delivery；推送请求不带此项） | `ad_version.offline_sent_at` |
| `decision` | enum(`AdVersionDecision`) \| null | 是 | 商家决定；未决为 null | `ad_version.decision` |
| `decidedAt` | string(date-time) \| null | 是 | 决定时间 | `ad_version.decided_at` |
| `confirmViewedVia` | enum(`PreviewChannel`) \| null | 是 | 确认时声明的查看方式 | `ad_version.confirm_viewed_via` |
| `viewedAckAt` | string(date-time) \| null | 是 | 勾选“我已查看第 N 版”的时间 | `ad_version.viewed_ack_at` |

### 2.6 `AdSegment`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `index` | integer | 是 | 分段序号，从 0 起 | `ad_version.segments[].index` |
| `fromMs` | integer | 是 | 起点（毫秒） | `ad_version.segments[].fromMs` |
| `toMs` | integer | 是 | 终点（毫秒） | `ad_version.segments[].toMs` |
| `label` | string | 是 | 分段说明（如“标题与价格”） | `ad_version.segments[].label` |

### 2.7 `AdRevisionView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `revisionNo` | integer | 是 | 第几次修改 | `ad_revision.revision_no` |
| `onVersionNo` | integer | 是 | 针对的版本 | `ad_revision.on_version_no` |
| `source` | enum(`AdRevisionSource`) | 是 | 来源：广告页、样片反馈转入、服务经理代录 | `ad_revision.source` |
| `isChargeable` | boolean | 是 | 是否超次计费 | `ad_revision.is_chargeable` |
| `chargePoints` | integer(积分) | 是 | 超次扣减的积分；不计费为 0 | `ad_revision.charge_points` |
| `segmentIndex` | integer \| null | 是 | 选用的预置分段 | `ad_revision.segment_index` |
| `timeStartMs` | integer \| null | 是 | 时间段起点；整条广告为 null | `ad_revision.time_start_ms` |
| `timeEndMs` | integer \| null | 是 | 时间段终点 | `ad_revision.time_end_ms` |
| `note` | string | 是 | 修改意见 | `ad_revision.note` |
| `screenshots` | array<`ImageRef`> | 是 | 截图（张数上限按参数 `ad.revision_screenshot_max`） | `ad_revision.screenshot_file_ids`，30 分钟对齐窗口签名 |
| `actorType` | enum(`ActorType`) | 是 | 提出人类型（`staff` 即服务经理代录） | `ad_revision.actor_type` |
| `createdAt` | string(date-time) | 是 | 提出时间 | `ad_revision.created_at` |
| `dueAt` | string(date-time) | 是 | 本轮修改版应交付时间 | `ad_revision.due_at` |
| `fulfilledByVersionNo` | integer \| null | 是 | 由哪一版满足；在途为 null | `ad_revision.fulfilled_by_version_no` |

`ImageRef` = `{ fileId: string(uuid), url: string, expiresAt: string(date-time) }`，引用 m08-support-misc 2.1 的同名结构（C41、C60），不再自定义同构结构。

### 2.8 `Playable`、`PlayableSource`（全仓唯一定义）

小程序内播放与下载页播放共用这一份 schema：本文的广告详情与 `m.playable.get`、m05-delivery-publish 的样片页、p01-portal 的 `portal.sample.playbackUrls` 与 `portal.ad.playbackUrls`、m04-mall-order 的预告片都引用它，不另行定义（C62）。三种情形（A135、A147；C62）：资产未就绪（`playable_asset.state` 不是 `ready`）时所在字段返回 `null`；资产就绪而此刻不能在小程序内播放（开关关闭，或推送时的查看方式不含 `weapp`）时返回只带海报的对象，`sources = []`、`expiresAt = null`（键照常出现，C38）；就绪且可播放时返回完整对象。`m.playable.get` 与下载页的签发接口返回的对象 `sources` 恒非空。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `playableId` | string(uuid) | 是 | 可播放资产 id，换新地址时用 | `playable_asset.id` |
| `kind` | enum(`PlayableKind`) | 是 | 资产种类 | `playable_asset.kind` |
| `durationMs` | integer \| null | 是 | 时长 | `playable_asset.duration_ms` |
| `width` | integer \| null | 是 | 宽 | `playable_asset.width` |
| `height` | integer \| null | 是 | 高 | `playable_asset.height` |
| `posterUrl` | string \| null | 是 | 海报（封面帧） | `playable_asset.cover_file_id`；为空时取源文件的 `media_info.cover_file_id`（`media_info.file_id = playable_asset.source_file_id`，广告、样片的体检抽帧，`06-media.md:403`）；30 分钟对齐窗口签名，预告片走 CDN |
| `sources` | array<`PlayableSource`> | 是 | 播放地址；此刻不能在小程序内播放时为 `[]`（见上） | `playable_asset.renditions` 逐档现签 |
| `expiresAt` | string(date-time) \| null | 是 | 播放地址到期时刻；`sources` 为空时为 null | 签名结果（广告、样片 60 分钟，C61） |
| `autoplay` | boolean | 是 | 是否自动播放；V1.0 一律 false | 预告片取开关 `weapp.trailer.autoplay`（默认关）；广告、样片恒为 false（`design-spec.md:862`） |
| `muted` | boolean | 是 | 是否静音起播 | 预告片 true；广告、样片 false（本稿补充） |

`PlayableSource`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `quality` | enum(`PlayableQuality`) | 是 | 档位；广告只有 `source` 一档，样片一档（水印版），预告片 `sd`、`hd` | `playable_asset.renditions[].quality`（`06-media.md:1759`） |
| `url` | string | 是 | 预签名地址（不进任何可缓存的公共响应，`Cache-Control: no-store`，C18） | `playable_asset.renditions[].fileId` 现签 |
| `width` | integer | 是 | 宽 | `playable_asset.renditions[].width` |
| `height` | integer | 是 | 高 | `playable_asset.renditions[].height` |
| `bitrateKbps` | integer \| null | 是 | 码率；未探测为 null | `playable_asset.renditions[].bitrateKbps` |

### 2.9 `AdAlternatives`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `canSaveToAlbum` | boolean | 是 | 可“保存到相册查看”（调 `m.ad.downloadUrls`） | `ad.status` 不是 `cancelled`，且当前版本的 `ad_version.preview_channels` 含 `album`，或属于下面的兜底情形 |
| `canPreviewOnPortal` | boolean | 是 | 可“在电脑上预览”（引导到下载页，扫码走 `m.portalTicket.lookup`，m02-tenant） | 当前版本的 `ad_version.preview_channels` 含 `portal`，或属于下面的兜底情形（下载页按同一兜底放行，由 p01-portal 配合） |
| `isOfflineSent` | boolean | 是 | 已经企业微信发送（“已通过企业微信发送给您”；交付经理登记，a05） | 当前版本的 `ad_version.offline_sent_at` 非空 |

出口以推送时写定的查看方式为准（A97：开关开时写 `weapp`，关时写 `album`、`portal`，员工可加 `wecom`；已推送版本的 `preview_channels` 不回改）。**兜底情形**：当前版本的 `previewChannels` 不含 `album`、`portal`（只有 `weapp`，或 `weapp`、`wecom`），而开关 `weapp.video.ad.enabled` 此刻为关——推送后开关才被关闭，页面没有播放器。此时 `m.ad.downloadUrls` 照常签发（写同样的访问审计），端上显示“保存到相册查看”；确认时 `viewedVia` 仍提交推送时登记的 `weapp`，但须 `hasViewed = true` 且已有相册保存或电脑端预览的记录（3.5）。交付主流程不因开关停下（`d7-platform.md:810`），与样片的兜底同一口径（m05-delivery-publish 3.8、3.9）。反过来，推送时开关为关（查看方式为 `album`、`portal`）而之后打开，`playable.sources` 仍为空，商家按相册或电脑端查看并确认。

### 2.10 `AdReference`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `kind` | enum(`AdReferenceKind`) | 是 | `store_asset` 来自门店素材库；`profile_media` 来自档案媒体 | 素材库：`store_asset_usage`（`store_asset_usage.used_by_type = ad`、`store_asset_usage.role = reference`）；档案媒体：`file_ref`（`file_ref.ref_type = ad`、`file_ref.role = reference`，文件分类为 `profile_image`、`profile_video`、`profile_promo`）（`09-order-ad.md:68`；M20） |
| `storeAssetId` | string(uuid) \| null | 是 | 素材 id；档案媒体为 null | `store_asset_usage.store_asset_id` |
| `fileId` | string(uuid) \| null | 是 | 档案媒体文件 id；素材为 null | `file_ref.file_id` |
| `assetType` | enum(`StoreAssetType`) \| null | 是 | 素材类型 | `store_asset.type` |
| `title` | string \| null | 是 | 素材标题；档案媒体为 null | `store_asset.title` |
| `mediaGroup` | enum(`ProfileMediaGroup`) \| null | 是 | 档案媒体的分组（门头、店内环境、产品、宣传素材），端上据此显示“档案中的店内环境 2 张”；素材为 null；档案里已移除、或不在四组里（如 Logo、主推服务图）时为 null | 按 `file_ref.file_id` 关联本门店 `store_profile_media` 中 `store_profile_media.removed_at` 为空的行，取 `store_profile_media.media_group`（`04-profile.md:170`） |
| `category` | string \| null | 是 | 档案媒体的文件分类；`mediaGroup` 为 null 时端上用它兜底（“档案图片”“档案视频”“宣传素材”）；素材为 null | `file_object.category` |
| `thumbUrl` | string \| null | 是 | 缩略图；取法与 m03-profile-asset 的 `StoreAssetCard` 缩略图相同（图片取文件本身，视频取派生封面，文字与录音为 null）；档案媒体按同一规则取 | 30 分钟对齐窗口签名 |
| `thumbExpiresAt` | string(date-time) \| null | 是 | 缩略图到期时刻 | 签名结果 |

### 2.11 `AdFloatingPlacement`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderItemId` | string(uuid) | 是 | 订单项 | `order_item_placement.order_item_id` |
| `orderId` | string(uuid) | 是 | 订购单 | `order_item.drama_order_id` |
| `orderNo` | string | 是 | 订购单号 | `drama_order.order_no` |
| `dramaTitle` | string | 是 | 剧名 | `order_item.drama_snapshot.title` |
| `slot` | enum(`PlacementSlot`) | 是 | 广告位 | `order_item_placement.slot` |
| `ticketStep` | enum(`DeliveryTicketStep`) \| null | 是 | 交付工单当前步骤；未开工为 null | `delivery_ticket.step` |
| `isTicketPaused` | boolean | 是 | 工单暂停中（暂停时不求值） | `delivery_ticket.pause_count > 0` |
| `agreedLaunchDate` | string(date) \| null | 是 | 约定上线日（“10 月 12 日上线时间不变”） | `order_item.agreed_launch_date` |
| `serviceManagerName` | string \| null | 是 | 服务经理称呼（“小林将为……替换片尾”） | `delivery_ticket.delivery_manager_id` → `staff.display_name`，为空取 `staff.name` |

范围：`order_item_placement.ad_id = ad.id` 且 `order_item_placement.bound_version_no` 为空（浮动绑定），且 `order_item.phase` ∈ {`pending_start`、`producing`}。端上按动作与 `ticketStep` 组织提示文案：确认时，`ad_prep` 的工单会进入样片制作；提出修改时，`sample_making`、`sample_confirm` 的工单会回到广告准备并重做样片（`d3-flow.md:1349-1356`）。上线日不自动顺延（`d3-flow.md:1354`）。

### 2.12 `AdRelatedServiceTicket`

m08-support-misc `ServiceTicketCard` 的子集，枚举共用 `ServiceTicketStatus`。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `serviceTicketId` | string(uuid) | 是 | 工单 id，详情走 `m.serviceTicket.get`（m08-support-misc） | `service_ticket.id` |
| `ticketNo` | string | 是 | 工单号（KF…） | `service_ticket.ticket_no` |
| `status` | enum(`ServiceTicketStatus`) | 是 | 工单状态 | `service_ticket.status` |
| `type` | `DictRef` | 是 | 问题类型 `{ code, name }`（字典 `ticket_type`；C85、A151；`type_code` 非空，恒有值；原 `typeCode` + `typeName` 合并） | `service_ticket.type_code`，名称取当前 `dict_item.name`（`dict_type_key = ticket_type`，停用后仍返回；`12-support.md:63`） |
| `createdAt` | string(date-time) | 是 | 提交时间 | `service_ticket.created_at` |

范围：`service_ticket_ref.ref_type = ad` 且 `service_ticket_ref.ref_id = ad.id`，并且 `service_ticket.store_id` 等于当前门店；按 `service_ticket.created_at` 倒序（`12-support.md:331`；A34）。

### 2.13 `AdTimelineEntry`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `at` | string(date-time) | 是 | 发生时间 | `audit_log.created_at` |
| `action` | string | 是 | 机器可读的动作，取值为下表白名单中的一个（会增长，端上未知值按通用节点展示） | `audit_log.action` |
| `title` | string | 是 | 商家端标题，读取时按 `action` 渲染（见下表）；不回传写入时按员工视角渲染的 `audit_log.summary` | 计算 |
| `detail` | string \| null | 是 | 第二行说明，读取时渲染（见下表）；没有为 null | 计算 |
| `versionNo` | integer \| null | 是 | 涉及的版本号（推送、确认、提出修改）；其余为 null | `audit_log.meta.versionNo` |
| `actorType` | enum(`ActorType`) | 是 | 操作人类型；不返回员工姓名快照 | `audit_log.actor_type` |

范围：`audit_log.target_type = ad`、`audit_log.target_id = ad.id`、`audit_log.stream` ∈ {`ops`、`activity`}，且 `audit_log.action` 在下表白名单内，按 `audit_log.seq` 正序。白名单就是广告状态机的 8 个迁移：每次迁移在审计里恰好一行（M31；`03-staff-authz-audit.md:639`），动作名取迁移事件名，推送虽经 `/admin/ad-versions/{adVersionId}/push` 发起，迁移行的对象仍是广告。后台在广告或版本上的其他活动（登记版本、标记已发送、催办、改派等，a05-order-delivery）与访问流（`access`）都不进商家端时间线：登记版本发生在推送之前，列出来会提前暴露商家看不到的版本。

| `action` | `title` | `detail` |
| --- | --- | --- |
| `ad.submit` | 提交制作需求 | `{类型名} {ad.duration_sec} 秒，冻结 {ad.charge_points} 积分`（如“片尾贴片 10 秒，冻结 45 积分”） |
| `ad.assign` | 剪辑师开始制作 | `剪辑师{editorName}，扣减 {ad.charge_points} 积分` |
| `ad.return` | 需要补充素材 | 退回原因：`audit_log.reason_text`，为空时取 `ad.return_reason` |
| `ad.resubmit` | 已补充素材，重新提交 | null |
| `ad.push_version` | 第 {versionNo} 版已上传 | 该版本仍待确认时为“待您确认”，否则 null |
| `ad.request_revision` | 提出修改意见 | `{分段说明或“整条广告”}：{ad_revision.note}`，计费时追加“，扣减 {ad_revision.charge_points} 积分”（轮次按 `audit_log.meta.revisionNo` 找 `ad_revision.revision_no`） |
| `ad.confirm` | 已确认使用 | `第 {versionNo} 版` |
| `ad.cancel` | 已取消 | null |

`versionNo` 与 `revisionNo` 由迁移的写入方放进审计行的 `meta`：本文的 `m.ad.confirm`、`m.ad.requestChange` 见 3.5、3.6；推送、代录修改的迁移审计行由 a05-order-delivery 写，同样带 `meta.versionNo`（代录另带 `meta.revisionNo`），由 a05 配合。

### 2.14 `AdState`（写接口的结果）

写接口只回状态摘要，不带任何签名地址：幂等重放会原样返回 24 小时内存下的结果，带地址会回放过期地址（C50、A18 的同一理由）。端上写成功后按需重拉列表或详情。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `adId` | string(uuid) | 是 | 广告 id | `ad.id` |
| `adNo` | string | 是 | 广告编号 | `ad.ad_no` |
| `status` | enum(`AdStatus`) | 是 | 迁移后的状态 | `ad.status` |
| `displayStatus` | enum(`AdDisplayStatus`) | 是 | 同 `AdCard` | 推出 |
| `waitingReason` | enum(`AdWaitingReason`) \| null | 是 | 同 `AdCard` | 推出 |
| `currentVersionNo` | integer \| null | 是 | 同 `AdCard` | `ad_version.version_no` |
| `confirmedVersionNo` | integer \| null | 是 | 同 `AdCard` | `ad.confirmed_version_no` |
| `confirmedAt` | string(date-time) \| null | 是 | 同 `AdCard` | `ad.confirmed_at` |
| `revisionCount` | integer | 是 | 同 `AdCard` | `ad.revision_count` |
| `freeRevisionsRemaining` | integer | 是 | 同 `AdCard` | 计算 |
| `chargePoints` | integer(积分) | 是 | 同 `AdCard` | `ad.charge_points` |
| `isCaptured` | boolean | 是 | 同 `AdCard` | `ad.captured_at` |
| `dueAt` | string(date-time) \| null | 是 | 同 `AdCard` | `ad.due_at` |
| `dueKind` | enum(`AdDueKind`) \| null | 是 | 同 `AdCard` | `ad.sla_snapshot` |
| `hasOpenCancelRequest` | boolean | 是 | 同 `AdCard` | `ad.open_cancel_request_id` |
| `actions` | array<string> | 是 | 同 `AdCard` | 计算 |

`AdRevisionResult` = `{ ad: AdState, revision: AdRevisionWritten }`，用于 3.6。`AdRevisionWritten` 的字段与 `AdRevisionView`（2.7）相同，只是把 `screenshots` 换成 `screenshotFileIds: string(uuid)[]`（来源 `ad_revision.screenshot_file_ids`），不带签名地址，理由同上。

### 2.15 `AdQuote`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `unitPoints` | integer(积分) | 是 | 每条积分（“每条 50 积分”） | `billing.quoteAdUnit().unitPoints`，即当前生效的 `billing_param` 键 `adUnitPoints`（`07-billing-ledger.md:1443`） |
| `discountBp` | integer \| null | 是 | 当前套餐折扣（万分比）；套餐未生效为 null | `billing.quoteAdUnit().discountBp`，即 `subscription_term.discount_bp` |
| `chargePoints` | integer(积分) \| null | 是 | 应冻结积分 S（“专业版 45 积分”“冻结 45 积分”）；套餐未生效为 null。提交时作为 `expectChargePoints` 回传 | `billing.quoteAdUnit().S` |
| `freeRevisions` | integer | 是 | 每条免费修改次数 | 当前生效的 `billing_param` 键 `adFreeRevisions`（`07-billing-ledger.md:1444`） |
| `planName` | string \| null | 是 | 当前套餐版本名（“专业版”）；无生效周期为 null | `billing_account.current_subscription_term_id` → `subscription_term.plan_id` → `plan.name` |
| `availablePoints` | integer(积分) | 是 | 当前可用积分（主体级） | 账本 `getWallet` 的可用合计：`billing_account.plan_available_qty` + 可用的 `billing_account.addon_available_qty`（套餐过期时加购积分停用，不计）（`d1-ledger.md` 11.1） |
| `availableAfterPoints` | integer(积分) \| null | 是 | 提交后可用积分；可为负数（表示不足）；`chargePoints` 为 null 时为 null | `availablePoints − chargePoints` |
| `typeOptions` | array<`AdTypeOption`> | 是 | 此刻开放的类型与各自的可选时长 | 参数 `content.placement.open_slots`（`05-content.md:78`）中、且在参数 `ad.duration_options`（A107、A146：07 待回写清单，默认 `opening` → `[3, 5]`、`ending` → `[5, 10]`；`09-order-ad.md:693`）里配置了时长的类型；V1.0 即片头、片尾 |
| `storeGate` | enum(`StoreGate`) | 是 | 当前门店闸门 | `profile.storeGate`（`d9-profile.md:631`） |
| `blockers` | array<`QuoteBlocker`> | 是 | 现在提交会被拒的原因，供底部按钮置灰与引导（“套餐过期/积分不足时的禁用态原型未画”，`proto-merchant-b.md:144`）；为空即可提交 | 见下表 |
| `agreement` | `AdAgreementInfo` | 是 | 《广告制作与交付服务协议》的现行版本与是否需要勾选 | 见下表 |
| `quotedAt` | string(date-time) | 是 | 计价时刻 | 账本时钟 |

`AdTypeOption`：`type`（enum(`AdType`)）、`durationOptions`（array<integer>，该类型可选的时长秒数，取自参数 `ad.duration_options`）。

`QuoteBlocker`：不在本文定义，引用 m04-mall-order 2.5 的公共结构 `{ code, message, dramaId? }`（A132、C87；初稿名 `AdQuoteBlocker` 删去）。广告报价不带 `dramaId` 键；`code` 取错误符号，端上按符号走与提交被拒时同一套引导。本文的取值：

| 字段 | 取值 | 来源 |
| --- | --- | --- |
| `code` | 提交时会返回的错误符号：`QUOTA_EXCEEDED`（门店数超上限）、`STORE_NOT_QUALIFIED`（门店闸门为 `blocked`）、`SUBSCRIPTION_INACTIVE`（套餐未生效）、`PLAN_REFUND_IN_PROGRESS`（套餐退款处理中）、`POINTS_INSUFFICIENT`（可用积分不足；套餐未生效时不再判断） | `tenant.assertWithinQuota`（m02-tenant）；`profile.storeGate`；`billing.quoteAdUnit()` 与 `getWallet` |
| `message` | 给用户看的一句话，与该错误码的默认文案一致 | 服务端生成 |

`AdAgreementInfo`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `agreementKey` | string | 是 | 恒为 `ad_service` | `agreement.key` |
| `name` | string | 是 | 协议名（与 m01-account 的协议结构同名） | `agreement.name` |
| `agreementVersionId` | string(uuid) | 是 | 现行版本 id；提交时回传 | `agreement_version.id`（按 m01-account 3.12 的当前版本口径解析） |
| `versionLabel` | string | 是 | 展示版本号，如 `v1.1` | `agreement_version.major`、`agreement_version.minor` |
| `needsCheck` | boolean | 是 | 是否显示勾选框：当前操作人（老板）在本主体下没有同意过该版本时为 true；为 false 时提交记 `prior_consent`（`m.agreement.list` 是公共接口、不分人，是否已同意只能在这里给出） | 不存在 `agreement_consent` 行满足 `agreement_consent.merchant_user_id = 当前用户`、`agreement_consent.entity_id = 当前主体`、`agreement_consent.agreement_version_id = 现行版本`（`d6-notify-docs-data.md:1179`；`13-notify-docs.md:819`） |

### 2.16 下载地址：引用 `DownloadUrl`

不在本文定义：`m.ad.downloadUrls` 返回 m05-delivery-publish 2.1 的公共结构 `DownloadUrl = { url, expiresAt, fileName, sizeBytes }`（A150、C87；本文原 `AdDownloadUrl` 删去，初稿名 `SignedFileUrl`）。广告的取值：

| 字段 | 取值 | 来源 |
| --- | --- | --- |
| `url` | 预签名下载地址（C60） | `ad_version.file_id` 现签 |
| `expiresAt` | 到期时刻（15 分钟，同“保存样片”，C61） | 签名结果 |
| `fileName` | 建议的保存文件名，如 `GG20260928004-v2.mp4` | `ad.ad_no` + 版本号 + `file_object.ext` |
| `sizeBytes` | 文件大小，端上显示下载进度 | `file_object.size_bytes`（C33） |

## 3. 接口

### 3.1 m.ad.list　我的广告列表
`GET /m/ads`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ad.request`；店员视图 `none`（店员 403 `ROLE_FORBIDDEN`） |
| 幂等 | none（纯查询，GET 不写库，A18、A19） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | `M:Ads`（M18）；`M:Checkout`（选片头、片尾广告） |

**请求**（查询参数的 schema：`AdListQuery`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum(`AdListTab`) | 否 | 缺省 `all` | 页签：`all` 全部、`producing` 制作中（含待指派、待补充）、`pending_confirm` 待确认、`revising` 修改中、`confirmed` 已确认（A24；路线图的 `status=` 改 `tab=`） |
| 查询 | `type` | enum(`AdType`) | 否 | — | 按类型筛选；确认订购页分别取片头与片尾 |
| 查询 | `isSelectable` | boolean | 否 | — | `true` 时只返回可在订购中选用的广告（`isSelectable` 的口径，见 2.1）；确认订购页用它，不用 `tab=confirmed` |
| 查询 | `sort` | enum | 否 | `-updatedAt`（缺省）、`-submittedAt` | 排序；服务端追加 `id` 保证翻页稳定（C44） |
| 查询 | `cursor` | string | 否 | 不透明 | 游标，首页不传（C42） |
| 查询 | `limit` | integer | 否 | 1–50，缺省 20 | 每页条数 |

**响应**：`data = AdCardPage`：`items`（array<`AdCard`>）、`nextCursor`（string | null）、`hasMore`（boolean）；游标分页、不返回总数（C42）。页签不带数字，不设 `summary`（A23）。响应头 `Cache-Control: no-store`（卡片带封面签名地址，C18）。

**错误**：无（通用错误按约定）。

**副作用**：无。

**说明**

- 门店取 `X-Store-Id`，只返回 `ad.store_id` 等于当前门店的广告；数据走 `ix_ad_store_id_status`（`09-order-ad.md:736`）。页签与状态的映射见第 4 节；`all` 含已取消的广告（显示“已取消”，见第 6 节第 6 项）。
- `isSelectable=true` 的口径按数据模型：`confirmed_version_no` 非空即可选用，修改中的已确认广告同样可选，绑定为浮动、在广告准备环节等它的修改完成（`d3-flow.md:1356`）；有在途取消或已取消的除外。它与 m04-mall-order 报价里的可用广告 `ads[]` 是同一判定（`ads.isSelectable`，第 1 节）。订购时的最终校验（属于本门店、已有确认版本、类型与广告位一致、广告位在剧目允许的植入形式内）在 `m.order.create`（`ORDER_AD_INVALID`，m04-mall-order）。
- 列表卡片上的“确认使用”只在 `currentPreviewChannels` 含 `weapp` 且开关此刻为开时直接以 `viewedVia = weapp` 提交 `m.ad.confirm`（原型无二次确认，`proto-merchant-b.md:131`）；其余情形进详情，按 `confirmableVia` 走“已查看”勾选。
- 卡片封面随列表返回签名地址（不需留痕，C60）。“角标字幕条 · 即将开放”占位卡：类型不在 `m.ad.quote` 的 `typeOptions` 里时端上显示占位，参数 `content.placement.open_slots` 放开后自动变为可选（V1.1，PRD:490）。
- 档案页 `M:Profile` 的“已确认 2 条、待确认 1 条、制作中 3 条”取 m03-profile-asset 的 `AdsBrief`，方案确认页 `M:Plan` 的“您于 11:05 提出修改，第 2 版预计今天推送”取 m05-delivery-publish 的 `PlanPlacementView`；两处按第 4 节的 `AdDisplayStatus` 映射显示，“修改中”单列（m03 的 `AdsBrief` 已补 `revisingCount`，m05 的 `PlanPlacementView` 已改返回 `adDisplayStatus` 并带 `openRevisionRequestedAt`）。

出处：路线图 `m06.ad.list`；`d3-flow.md:3511`、`1257`；`proto-merchant-b.md:127-145`；`proto-merchant-a.md:352`。

### 3.2 m.ad.quote　广告计价
`POST /m/ads/quote`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ad.request`；店员视图 `none` |
| 幂等 | none（试算，不写库、不缓存，A18、A20、C13） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | `M:Ads`（页头“可用积分 · 每条 50 积分 · 专业版 45 积分 · 每条免费修改 2 次”；提交需求弹层的积分试算“50 积分 × 9 折 冻结 45 积分”“提交后可用积分”） |

**请求**（请求体的 schema：`AdQuoteBody`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 请求体 | `type` | enum(`AdType`) | 否 | 须在 `typeOptions` 内 | 弹层里已选的类型；只用于校验，计价与类型无关 |
| 请求体 | `durationSec` | integer | 否 | 须在该类型的 `durationOptions` 内（同时传 `type` 时校验） | 已选的时长 |

请求体可以为空对象：进入“我的广告”页时调一次取页头数据，打开弹层时再调一次刷新。

**响应**：`data = AdQuote`（2.15）。

**错误**：门店数超限、门店闸门不通过、套餐未生效、退款处理中、积分不足都不报错，写进 `blockers`，由端上置灰按钮并引导（续费或加购走 m07-billing，`m.purchasePolicy.get` 决定是否出现购买入口；超限引导去停用门店）。`type` 不在 `typeOptions` 内、或与 `durationSec` 不匹配返回 400 `VALIDATION_FAILED`（`fieldErrors.path = type` 或 `durationSec`）。

**副作用**：无。

**说明**

- 计价只在服务端算（`proto-merchant-b.md:133`）：`billing.quoteAdUnit({ entityId })` 返回 `{ unitPoints, discountBp, S }`，`S = quoteAd(unitPoints, R)`（`d1-ledger.md:1649`；`09-order-ad.md:705`）。试算不锁账户，提交时由账本在账户锁内重算并与 `expectChargePoints` 比对（3.3）。
- `typeOptions` 按参数求交（A107）：V1.0 `content.placement.open_slots` 只有片头、片尾，角标字幕条、片中插播为 V1.1（PRD:490-494；`09-order-ad.md:692`）。与剧目、订购接口用同一个参数，参数放开后两边同时生效（m04-mall-order `items[].allowedPlacements`）。
- 宣传重点的选项由 `m.dictItem.list?types=ad_promo_point` 下发（m08-support-misc），本接口不重复下发。
- 《广告制作与交付服务协议》：`needsCheck = true` 时弹层显示勾选框，提交必须勾选；为 false 时不显示勾选框，提交时接口自动引用当前版本并仍落一条同意记录（`method = prior_consent`，`13-notify-docs.md:819`）。原型弹层没有勾选框，是否每次都要显式勾选待法务（第 6 节第 1 项）。

出处：路线图 `m06.ad.quote`；`d1-ledger.md:1649`；`d3-flow.md:120`；`d4-identity.md:673`；`proto-merchant-b.md:128-134`；A20、A107、C13。

### 3.3 m.ad.create　提交广告制作需求
`POST /m/ads`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ad.request`；店员视图 `none` |
| 幂等 | required（状态迁移并冻结积分，A17；`d3-flow.md:3184`） |
| 乐观锁 | 不带 `lockVersion`（新建）；账本在账户锁内重算应扣积分并与请求的 `expectChargePoints` 比对 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | `M:Ads` 的“提交制作需求”底部弹层（M42） |

**请求**（请求体的 schema：`AdCreateBody`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 请求体 | `type` | enum(`AdType`) | 是 | 须在 `AdQuote.typeOptions` 内（参数 `content.placement.open_slots`，V1.0 即 `opening`、`ending`） | 广告类型，落 `ad.type` |
| 请求体 | `durationSec` | integer | 是 | 须在该类型的 `durationOptions` 内（参数 `ad.duration_options`，默认片头 3 或 5、片尾 5 或 10） | 时长，落 `ad.duration_sec` |
| 请求体 | `promoPointCodes` | array<string> | 是 | 1–5 项，不重复；字典 `ad_promo_point` 中启用的编码（`m.dictItem.list?types=ad_promo_point`） | 宣传重点，落 `ad.promo_point_codes` |
| 请求体 | `copy` | string \| null | 否 | ≤50 字（契约层校验，`09-order-ad.md:67`） | 广告文案；不填由剪辑师依据档案撰写，落 `ad.copy` |
| 请求体 | `remark` | string \| null | 否 | ≤200 字 | 备注（原型缺，按 PRD 补，`proto-merchant-b.md:140`），落 `ad.remark` |
| 请求体 | `referenceStoreAssetIds` | array<string(uuid)> | 否 | ≤9 项（第 6 节第 7 项），不重复；本门店的素材，未删除、内容安全不是 `block`、可用性不是 `need_reshoot`（选择器取 `m.storeAsset.list?isSelectableAsReference=true`，与 m03-profile-asset 用同一个守卫函数） | 来自素材库的参考素材；写 `store_asset_usage` 与各文件的 `file_ref` |
| 请求体 | `referenceFileIds` | array<string(uuid)> | 否 | ≤9 项（同上），不重复；本门店的档案媒体文件（分类 `profile_image`、`profile_video`、`profile_promo`），已入库，内容安全不是 `block` | 来自档案媒体的参考素材；只写 `file_ref` |
| 请求体 | `expectChargePoints` | integer(积分) | 是 | > 0 | 弹层展示的应冻结积分（`AdQuote.chargePoints`），账本据此比对（`expectS`，`d1-ledger.md:1678`） |
| 请求体 | `agreementVersionId` | string(uuid) | 是 | 须等于《广告制作与交付服务协议》的现行版本 | `AdQuote.agreement.agreementVersionId`。交易接口只提交版本 id，服务端按版本行补协议键（m01-account 2.7 末段） |
| 请求体 | `isAgreementChecked` | boolean | 是 | `AdQuote.agreement.needsCheck = true` 时必须为 true | 用户是否勾选了协议；决定同意记录的 `method` 是 `checkbox` 还是 `prior_consent` |

**响应**：`data = AdState`（2.14）。新建广告 `status = pending_assign`，`chargePoints` 即已冻结的积分。

**错误**

| 错误码 | HTTP | 何时 | `details` |
| --- | --- | --- | --- |
| `QUOTA_EXCEEDED` | 409 | 主体启用的门店数超过当前套餐上限，须先停用门店（`tenant.assertWithinQuota`，`d4-identity.md:673`；m02-tenant 定义） | `{ storesUsed, storeLimit, storesOver }` |
| `STORE_NOT_QUALIFIED` | 409 | 门店闸门为 `blocked`（新增门店未通过；首店未提交、待补正或终局驳回）（`d3-flow.md:419`、`431-437`；m04-mall-order 45008，三处判定同源） | `{ storeId, reason: StoreNotQualifiedReason }`（m04） |
| `SUBSCRIPTION_INACTIVE` | 409 | 套餐未生效（账本在账户锁内判定，`07-billing-ledger.md:843`；m07-billing 43010） | — |
| `PLAN_REFUND_IN_PROGRESS` | 409 | 主体的套餐退款处理中（`subscription_term.refund_request_id` 非空，冻结被拒；m07-billing 43006） | — |
| `POINTS_INSUFFICIENT` | 409 | 可用积分不足（m07-billing 43009） | `{ requiredPoints, spendablePoints, shortfallPoints }` |
| `QUOTE_CHANGED` | 409 | 账本重算的应扣积分与 `expectChargePoints` 不一致（单价、折扣或套餐版本已变）（m07-billing 43007） | `{ kind: 'points', totalChargePoints, items: [{ dramaId: null, chargePoints }] }`（m07 的判别联合）；端上重调 `m.ad.quote` 刷新弹层，让用户重新确认后换新幂等键提交（内容变了，C48） |
| `ACCOUNT_BUSY` | 503 | 账户锁等待超时（可重试，同一幂等键；m07-billing 43008） | — |
| `AGREEMENT_VERSION_STALE` | 409 | `agreementVersionId` 不是现行版本（m01-account 47401） | `{ agreementKey, currentAgreementVersionId }`；端上重拉 `m.ad.quote` 并要求重新勾选 |
| `DICT_ITEM_DISABLED` | 409 | 宣传重点的编码不在字典里或已停用（`dicts.assertEnabled`；m08-support-misc 47001） | `{ dictTypeKey: 'ad_promo_point', code }` |
| `FILE_NOT_USABLE` | 400 | 档案媒体文件不属于本门店、未入库、分类不对或被拦截；素材库参考素材通过了素材守卫，但登记 `file_ref` 时 `files.link()` 断言底层文件不可用（`files.link()` 断言失败的统一出口，m03-profile-asset 46001） | `{ fileIds, reason }`（`reason` 取 m03 的开放枚举） |
| `CONTENT_REJECTED` | 400 | 文案或备注未通过内容安全检测（m01-account 41006） | `{ fields }`，如 `["copy"]`、`["copy", "remark"]` |
| `PROVIDER_UNAVAILABLE` | 503 | 文本内容安全检测服务不可用（可重试，同一幂等键；见说明） | — |
| `VALIDATION_FAILED` | 400 | 输入校验：类型不在开放范围、时长不在可选值内；数量超限或重复；素材库参考素材不在本门店、已删除、被拦截或需补拍（与 m04 订购的参考素材同一写法）；需要勾选协议而 `isAgreementChecked = false`。`fieldErrors.path` 指到具体字段或数组下标（如 `referenceStoreAssetIds.2`） | — |

**副作用**（同一事务，写入顺序按 `09-order-ad.md:64`、`681`）

1. 预生成广告 id，经 `biz_sequence` 取广告编号 `GG…`。
2. 记协议同意：插入 `agreement_consent`（`agreement_consent.scene = ad_request`、`agreement_consent.biz_type = ad`、`agreement_consent.biz_id = 广告 id`、`agreement_consent.biz_no = 广告编号`、`agreement_consent.method` = 本次勾选为 `checkbox`，否则 `prior_consent`）。
3. 冻结积分：`billing.hold({ purpose: ad, refType: ad, refId: 广告 id, groupRef: 广告编号, pricing: { kind: 'ad' }, expectS: expectChargePoints, titleCode: 'ad_hold', titleArgs: { adNo, unitPoints, discountBp } })`（标题码按 m07-billing 4.5，落 `ledger_operation.title_code`、`ledger_operation.title_args`）。`point_hold: （新建）→ held`（`07-billing-ledger.md:843`），同事务写 `point_hold_alloc`、`ledger_operation`、`point_ledger_entry`，账本发出 `billing.points.held`（聚合 `billing_account`，x01-events-jobs）。
4. 插入广告行：`ad.status: — → pending_assign`（`ad.submit`，`09-order-ad.md:801`）。`ad.unit_price_points`、`ad.discount_bp`、`ad.charge_points`、`ad.free_revision_quota`、`ad.pricing_snapshot` 取账本返回的快照（`09-order-ad.md:1071`）；`ad.point_hold_id`、`ad.agreement_consent_id`、`ad.requested_by_user_id`、`ad.submitted_at`；`ad.first_due_at` = `ad.due_at` = 提交时刻加 2 个工作日（时限键 `sla.ad.first_version`，`14-config-data.md:294`），`ad.sla_snapshot` 同时写入。写 `status_transition`（machine = `ad`）与一行 `audit_log`（`action = ad.submit`，M31）。
5. 参考素材：每个文件 `files.link()` 登记 `file_ref`（`file_ref.ref_type = ad`、`file_ref.role = reference`）；素材库的另写 `store_asset_usage`（`store_asset_usage.used_by_type = ad`、`store_asset_usage.role = reference`）（`09-order-ad.md:68`、`1163`）。
6. 登记定时器 `sla.breach`（主体 `ad`，键 `sla.breach:ad:{adId}:first:0`，到期时刻 = `ad.due_at`）（`09-order-ad.md:813`）。
7. 出站事件 `ad.requested`（x01-events-jobs；`d3-flow.md:2721`）。

**说明**

- 守卫逐条对上 `ad.submit`（`09-order-ad.md:801`），并加门店额度：主体门店数未超上限（`tenant.assertWithinQuota`，`d4-identity.md:673`）；套餐生效（账本判定）；门店闸门 `full` 或 `parallel`；类型在开放范围；时长在该类型可选值内；宣传重点至少 1 项且都已启用（原型允许不选、兜底“由剪辑师根据档案确定”，按 PRD 必填，`proto-merchant-b.md:141`）；协议版本为现行版本；带幂等键；账本冻结成功。门店闸门为 `parallel`（首店资质审核中）时只冻结，广告在“待指派”等待资质通过，卡片显示 `waitingReason = qualification`（`d3-flow.md:1295`、`1392`）。
- 文案、备注在事务外先做文本内容安全检测（微信 `msgSecCheck`）：命中返回 `CONTENT_REJECTED`。检测服务不可用时 V1.0 一律拒收（A137，约定 C27 末段，与 m01-account 同一口径）：返回 503 `PROVIDER_UNAVAILABLE`、不写库，用户稍后重试；草案“先接受、排队补检”（`d5-media.md:1914`）不做。这是事务前的同步检查，不是三段式用例（C51）。
- 积分不足时弹窗引导加购或升级（PRD:481；入口由 `m.purchasePolicy.get` 决定）。冻结只发生一次：被退回补充后重新提交不再冻结（3.7）。
- 端上在点击“提交需求”的同一手势里先请求订阅消息点位 `ad_submit`（`d6-notify-docs-data.md:863`），再调本接口。
- 业务确认（`05-risks-and-open-issues.md:187`）：指派剪辑师即扣减，商家端文案“剪辑师开始制作时扣减”与此一致，不另设“开始制作”动作。

出处：路线图 `m06.ad.create`；`d3-flow.md:1283`、`3511`；`09-order-ad.md:681`、`801`；`07-billing-ledger.md:843`；`d4-identity.md:673`；`d6-notify-docs-data.md:1179`；`proto-merchant-b.md:134-144`；PRD:485-498。

### 3.4 m.ad.get　广告详情
`GET /m/ads/{adId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ad.request`；店员视图 `none` |
| 幂等 | none（纯查询，GET 不写库） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | `weapp.video.ad.enabled`（默认开，`14-config-data.md:596`）：关闭时 `playable.sources = []`、`playable.expiresAt = null`，页面不内嵌播放器，改用 `alternatives` 的出口（`d7-platform.md:514`；C62）。查看方式按推送时写定的 `preview_channels`（A97）；开关此刻的值只决定能否在小程序内播放，以及 2.9 的兜底 |
| 对应画板 | `M:AdDetail`（M19） |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `adId` | string(uuid) | 是 | — | 广告 id（`resources.json`：`ads` / `adId`） |

**响应**：`data = AdDetail`（2.2）。响应头 `Cache-Control: no-store`（含封面、播放、截图与缩略图的签名地址，C18）。

**错误**：无（广告不存在或不属于当前门店返回 404 `NOT_FOUND`，按约定）。

**副作用**：无。在小程序内播放（`viewedVia = weapp`）不需要留痕，播放数据随详情返回，地址过期或播放报错时调 `m.playable.get`（A19、C62）。

**说明**

- 状态卡：`displayStatus` + 说明两行由端上按状态组织（待确认：“确认后可在后续订购中选用，不再扣积分”；修改中：“剪辑师将在 1 个工作日内上传第 N 版”，取 `dueAt`）；“剩余免费修改 N 次”取 `freeRevisionsRemaining`；“超出后每次按 1 条扣 45 积分”取 `revisionUnitChargePoints`，它按此刻的单价与折扣算，可能与提交时的 `unitPricePoints × discountBp` 不同（`d3-flow.md:1323`）。
- 制作信息：当前版本（`currentVersion.versionNo`、`uploadedAt`）、宣传重点、文案、参考素材（按 `references[].mediaGroup` 分组显示）、规格（`currentVersion.width × height`，竖屏 9:16 · 1080×1920）、剪辑师（`editorName`）、需求编号（`adNo`）。
- 播放器：只在 `playable.sources` 非空时显示（否则只显示海报与 `alternatives` 的出口）；“确认使用”按 `confirmableVia` 决定是否可点；竖屏 9:16，点击后才播放，不自动播放；移动网络下首次点击播放前用底部弹层提示流量（`design-spec.md:862`）。进度条上叠加 `currentVersion.segments` 的分段标注（`d7-platform.md:801`）。
- 关联订单的影响提示由 `floatingPlacements` 组织（2.11）；原型写的“确认后联动替换片尾、重新合成样片”由确认与提出修改的事务内求值完成（3.5、3.6），不另建待办。
- 修改中、待补充时没有可播放的新版本，仍展示上一已推送版本（如有）。已取消的广告照常可看，`actions` 为空。
- 时间线只列商家可见的 8 类迁移，标题在读取时按商家口径渲染（2.13）；剪辑师称呼由 `editorName` 给出，不返回员工姓名快照。
- 提出修改弹层的截图张数上限取 `revisionScreenshotMax`。

出处：路线图 `m06.ad.get`；`d5-media.md:1524`；`09-order-ad.md:683`、`843-910`；`12-support.md:331`；A34、A97；`proto-merchant-b.md:149-167`；`d7-platform.md:514`、`790-801`。

### 3.5 m.ad.confirm　确认使用广告版本
`POST /m/ads/{adId}/confirm`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ad.confirm`；店员视图 `none` |
| 幂等 | required（状态迁移，A17；路线图原写“natural（版本号守卫）”不采用） |
| 乐观锁 | 不带 `lockVersion`：`ad.confirm` 的守卫没有列 `lock_version`（C53）。请求体带业务版本号 `versionNo`，服务端与当前版本比对 |
| 限流 | `m.global` |
| 开关 | `weapp.video.ad.enabled` 决定推送时写入的 `preview_channels`；本接口按该版本的 `preview_channels` 校验，开关此刻的值只用于 `viewedVia = weapp` 的兜底（见说明；A97，同 m05 `m.sample.confirm`） |
| 对应画板 | `M:Ads`（卡片“确认使用”）、`M:AdDetail`（详情与全屏内“确认使用”，无二次确认） |

**请求**（请求体的 schema：`AdConfirmBody`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `adId` | string(uuid) | 是 | — | 广告 id |
| 请求体 | `versionNo` | integer | 是 | ≥1 | 确认的版本号，须等于当前待确认版本（`ad.latest_version_no`） |
| 请求体 | `viewedVia` | enum(`PreviewChannel`) | 是 | 须在该版本的 `previewChannels` 内 | 查看方式，落 `ad_version.confirm_viewed_via` |
| 请求体 | `hasViewed` | boolean | 否 | 缺省 false；`viewedVia` 不是 `weapp` 时必须为 true；兜底情形（2.9）的 `weapp` 同样必须为 true | 勾选“我已查看第 N 版”（C39、C82；旧写法 `ackViewed` 改名），为 true 时写 `ad_version.viewed_ack_at` |

**响应**：`data = AdState`（2.14）。

**错误**

| 错误码 | HTTP | 何时 | `details` |
| --- | --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 广告不是 `pending_confirm`（新请求；同键重放返回上次成功结果，C47） | — |
| `AD_CANCEL_IN_PROGRESS` | 409 | 有在途的取消申请（`ad.open_cancel_request_id` 非空） | — |
| `AD_VERSION_STALE` | 409 | `versionNo` 不是当前待确认版本 | `{ currentVersionNo }` |
| `AD_PREVIEW_CHANNEL_UNAVAILABLE` | 409 | `viewedVia` 不在该版本推送时写定的 `previewChannels` 内 | `{ previewChannels }` |
| `AD_NOT_VIEWED` | 409 | 声明的查看方式没有对应的访问记录：`album` 要求该版本有相册保存记录，`portal` 要求有电脑端预览记录；`weapp` 在开关此刻为关时（兜底）要求两种记录至少有一条（见说明） | `{ viewedVia, requiredEvidence }` |
| `VALIDATION_FAILED` | 400 | `viewedVia` 不是 `weapp`、或属于兜底情形，而 `hasViewed` 不为 true（`fieldErrors.path = hasViewed`） | — |

**副作用**（同一事务；加锁步骤按 `d3-flow.md:1360-1366`，广告行多行按 id 升序，`09-order-ad.md:679`）

0. 事务前不加锁预读：浮动绑定本广告、工单在 `ad_prep` 的订单项，以及这些订单项全部广告位涉及的其他广告 id。
1. 本广告与预读到的其他广告合在一起按 id 升序加锁：本广告 `FOR UPDATE`，其余 `FOR SHARE`。守卫通过后 `ad.status: pending_confirm → confirmed`（`ad.confirm`，`09-order-ad.md:806`）；同一条 UPDATE 写 `ad.confirmed_version_no = versionNo`、`ad.confirmed_at`（`09-order-ad.md:773`）。
2. 版本行：`ad_version.decision: 空 → confirmed`，同一条 UPDATE 写 `ad_version.decided_at`、`ad_version.confirm_viewed_via`、`ad_version.viewed_ack_at`（`hasViewed` 为 true 时）（`09-order-ad.md:905`）。
3. 按订购单 → 订单项 → 工单的 id 升序 `FOR UPDATE`，复核广告位集合；集合变了抛 `LockSetChanged`，整体回滚重试（重试仍失败返回 503 `BUSY`，C27）。
4. 对浮动绑定本广告、工单在 `ad_prep` 且未暂停的订单项逐张经 `flow.reevaluate()` 求值：广告位全部就绪时 `delivery_ticket.step: ad_prep → sample_making`（`ads.ready`，`10-delivery.md:174`），工单迁移的副作用按 10 分组：写 `status_transition`（machine = `delivery_ticket`）、关旧环节开新环节（`delivery_ticket_stage`），随环节切换取消、登记环节时限定时器（`sla.breach`，主体 `delivery_ticket_stage`，x01-events-jobs 4.1），出站事件 `ticket.step_changed`（通知负责人）。暂停中的工单跳过，恢复时补求值（`10-delivery.md:168`）。
5. 写 `status_transition`（machine = `ad`）与一行 `audit_log`（`action = ad.confirm`，`meta.versionNo = versionNo`，供 2.13 时间线）；出站事件 `ad.confirmed`（`d3-flow.md:2721`）。
6. 不登记广告确认提醒：确认提醒是纯提醒，不建定时器行（R6；`09-order-ad.md:819`）。

**说明**

- 守卫（`09-order-ad.md:806`）：版本号 = `ad.latest_version_no`（待确认时最新版本必已推送且未决，`09-order-ad.md:910`）；`viewedVia` ∈ 该版本 `preview_channels`；不是小程序内播放的须勾选已查看并有对应证据；无在途取消。查看方式在推送时已按开关写定（A97），确认按版本校验；开关事后被关闭不会卡住确认，走下面的兜底（`d7-platform.md:810`）。
- 查看证据（`d3-flow.md:1532-1543`；`09-order-ad.md:910`），与 `AdDetail.viewEvidence`、`confirmableVia` 的计算同源，端上按后者提交不会撞上 `AD_NOT_VIEWED`：`wecom` 以 `ad_version.offline_sent_at` 非空为证（推送时已由 CHECK 保证）；`portal` 要求该版本在 `audit_log` 访问流里有电脑端预览记录（`audit_log.stream = access`、`audit_log.target_type = ad_version`、`audit_log.target_id = 该版本 id`、`audit_log.action = ad.version.portal_preview`，由 `portal.ad.playbackUrls` 写，p01-portal）；`album` 要求有保存到相册的记录（同上，`audit_log.action = ad.version.album_download`，由 3.8 写；本稿补充，与样片同理，见第 6 节第 2 项）。
- `viewedVia = weapp`：开关此刻为开时不要求证据（小程序内播放不留痕，与数据模型一致）；开关在推送后被关闭时（2.9 的兜底），要求 `hasViewed = true` 且有相册保存或电脑端预览的访问记录，否则 `AD_NOT_VIEWED`（`requiredEvidence = album_or_portal`）。与 m05 `m.sample.confirm` 的兜底同一口径。
- 端上在点击“确认使用”的同一手势里先请求订阅点位 `ad_confirm`（`d6-notify-docs-data.md:863`）。
- 已确认的广告不可取消（已交付，可复用，`09-order-ad.md:811`）。

出处：路线图 `m06.ad.confirm`；`d3-flow.md:1288`、`1360-1366`、`3511`；`09-order-ad.md:679`、`806`、`905`；`10-delivery.md:174`；A97；C53、C82；复核意见 43、46。

### 3.6 m.ad.requestChange　提出修改意见
`POST /m/ads/{adId}/request-change`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ad.confirm`；店员视图 `none` |
| 幂等 | required（状态迁移，超次时扣积分，A17） |
| 乐观锁 | 不带 `lockVersion`（`ad.request_revision` 的守卫没有列 `lock_version`，C53）；请求体带 `versionNo` 表明针对哪一版；超次时带 `acceptChargePoints` 与服务端此刻的金额比对 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | `M:AdDetail` 的“提出修改意见”弹层；`M:Ads` 卡片“提修改意见”进详情；样片页的“广告内容”修改也引到这里（A31，m05 的 `adsUsed`） |

**请求**（请求体的 schema：`AdRequestChangeBody`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `adId` | string(uuid) | 是 | — | 广告 id |
| 请求体 | `versionNo` | integer | 是 | 待确认时 = 当前待确认版本；已确认时 = `confirmedVersionNo` | 针对的版本，落 `ad_revision.on_version_no` |
| 请求体 | `segmentIndex` | integer \| null | 否 | 须是该版本 `segments` 里的 `index`；与 `timeStartMs`/`timeEndMs` 互斥 | 选用的预置分段；起止从该分段复制到 `ad_revision.time_start_ms`、`ad_revision.time_end_ms`，落 `ad_revision.segment_index` |
| 请求体 | `timeStartMs` | integer \| null | 否 | 与 `timeEndMs` 同有同无；0 ≤ 起点 < 终点 ≤ 该版本时长 | 自由时间段（V1.0 页面只用预置分段，接口按数据模型保留，`d5-media.md:1524`） |
| 请求体 | `timeEndMs` | integer \| null | 否 | 同上 | 同上 |
| 请求体 | `note` | string | 是 | 1–200 字 | 修改意见，落 `ad_revision.note` |
| 请求体 | `screenshotFileIds` | array<string(uuid)> | 否 | 张数 ≤ 参数 `ad.revision_screenshot_max`（A107、A146：07 待回写清单，默认 1；`09-order-ad.md:947`）；本人在本门店上传、分类 `ticket_attachment`、已入库 | 截图，落 `ad_revision.screenshot_file_ids` |
| 请求体 | `acceptChargePoints` | integer(积分) \| null | 否 | 本次修改超出免费次数时必填，且须等于服务端此刻算出的金额 | 弹窗提示后用户接受的扣减积分（“本次修改将按 1 条扣 45 积分”）；不计费时忽略 |

三者都不传（`segmentIndex`、`timeStartMs`、`timeEndMs`）即“整条广告”。

**响应**：`data = AdRevisionResult`（2.14）= `{ ad: AdState, revision: AdRevisionWritten }`。

**错误**

| 错误码 | HTTP | 何时 | `details` |
| --- | --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 广告不是 `pending_confirm` 或 `confirmed`（修改中不能再提修改：同一广告至多一个未满足的轮次，`uq_ad_revision_ad_id_unfulfilled`） | — |
| `AD_CANCEL_IN_PROGRESS` | 409 | 有在途的取消申请 | — |
| `AD_VERSION_STALE` | 409 | `versionNo` 不是当前可提意见的版本 | `{ currentVersionNo }` |
| `CHARGE_CHANGED` | 409 | 本次修改要扣积分，但请求没带 `acceptChargePoints`，或与服务端此刻的金额不一致（如服务经理刚代录了一次免费修改、参数或套餐折扣已变）（`d3-flow.md:1312`）；账本在锁内重算不一致抛出的 `QUOTE_CHANGED` 也由处理器映射为本码 | `{ isChargeable, chargePoints, freeRevisionsRemaining }`，取锁内重算的值 |
| `SUBSCRIPTION_INACTIVE` | 409 | 超次修改而套餐未生效（免费修改不受影响，`d3-flow.md:1324`；m07-billing 43010） | — |
| `PLAN_REFUND_IN_PROGRESS` | 409 | 超次修改而套餐退款处理中（m07-billing 43006） | — |
| `POINTS_INSUFFICIENT` | 409 | 超次修改而可用积分不足（m07-billing 43009） | `{ requiredPoints, spendablePoints, shortfallPoints }` |
| `ACCOUNT_BUSY` | 503 | 超次修改时账户锁等待超时（可重试；m07-billing 43008） | — |
| `FILE_NOT_USABLE` | 400 | 截图不是本人在本门店上传、分类不是 `ticket_attachment`、未入库或被拦截（m03-profile-asset 46001） | `{ fileIds, reason }` |
| `CONTENT_REJECTED` | 400 | 修改意见未通过内容安全检测（m01-account 41006） | `{ fields: ["note"] }` |
| `PROVIDER_UNAVAILABLE` | 503 | 文本内容安全检测服务不可用（可重试，同 3.3 说明） | — |
| `VALIDATION_FAILED` | 400 | `segmentIndex` 不在该版本的分段里；时间段越界；与分段同时给出；截图张数超过参数上限 | — |

**副作用**（同一事务；步骤按 `d3-flow.md:1300-1316`）

1. 先不加锁预读浮动绑定本广告的订单项与工单；事务内锁广告 `FOR UPDATE`，再按订购单 → 订单项 → 工单 id 升序加锁，重读后只保留“仍浮动绑定本广告、工单在 `sample_making` 或 `sample_confirm`、未暂停”的工单。
2. `revision_no = ad.revision_count + 1`；`is_chargeable = revision_no > ad.free_revision_quota`（`09-order-ad.md:937`）。
3. 超次时：比对 `acceptChargePoints` 与 `billing.quoteAdUnit().S`，以预生成的轮次 id 调 `billing.charge({ purpose: ad_revision, refType: ad_revision, refId: 轮次 id, groupRef: 广告编号, pricing: { kind: 'ad_revision' }, expectS, titleCode: 'ad_revision_charge', titleArgs: { adNo, unitPoints, discountBp } })`（标题码按 m07-billing 4.5）：`point_hold: （新建）→ held → captured`（同一事务 hold + capture，`07-billing-ledger.md:843-849`），账本写流水并发出 `billing.points.held`、`billing.points.captured`（聚合 `billing_account`）。账本抛 `QUOTE_CHANGED` 时映射为 `CHARGE_CHANGED`。
4. 插入 `ad_revision`：`ad_revision.source = ad_page`、`ad_revision.actor_type = merchant`、`ad_revision.actor_id` = 当前用户、`ad_revision.client = weapp`、`ad_revision.charge_points`、`ad_revision.charge_point_hold_id`、`ad_revision.due_at` = 此刻加 1 个工作日（时限键 `sla.ad.revision`）。截图 `files.link()` 登记 `file_ref`（`file_ref.ref_type = ad_revision`、`file_ref.role = screenshot`）。
5. `ad.status: pending_confirm / confirmed → revising`（`ad.request_revision`，`09-order-ad.md:807`）；同时写 `ad.revision_count`、`ad.due_at`、`ad.sla_snapshot`（policy `ad.revision`）。
6. 版本行：广告原为 `pending_confirm` 时，`ad_version.decision: 空 → revision_requested`，写 `ad_version.decided_at`（`09-order-ad.md:906`）；原为 `confirmed` 时不改任何版本行，`ad.confirmed_version_no` 不变，新订购照常选用（`09-order-ad.md:907`）。
7. 第 1 步留下的工单经 `flow.reevaluate()`：`delivery_ticket.step: sample_making / sample_confirm → ad_prep`（`ad.reopened`，`10-delivery.md:179`）。副作用按 10 分组与 `d3-flow.md:841`：该工单未决的样片（`sample.status` ∈ {`uploaded`、`qc_passed`、`pushed`}）先置 `superseded`（`sample.superseded`，`10-delivery.md:648`，满足 `uq_sample_live`），各写 `status_transition`（machine = `delivery_ticket`、`sample`）；关旧环节开新环节（`delivery_ticket_stage`），随环节切换取消、登记环节时限定时器（`sla.breach`，主体 `delivery_ticket_stage`）；出站事件 `ticket.step_changed`（通知交付经理）、`sample.superseded`（x01-events-jobs）。已钉住的订单项不受影响（`d3-flow.md:1353`）。
8. 登记定时器 `sla.breach`（主体 `ad`，键 `sla.breach:ad:{adId}:rev:{revisionNo}`，`09-order-ad.md:813`）。
9. 写 `status_transition`（machine = `ad`）与一行 `audit_log`（`action = ad.request_revision`，`meta = { versionNo: on_version_no, revisionNo }`，供 2.13 时间线）；出站事件 `ad.revision_requested`（`d3-flow.md:1315`、`2721`）。

**说明**

- 守卫（`09-order-ad.md:807`）：意见非空；超出免费次数时须商家本人提交并回传接受的金额、套餐须生效；无在途取消。商家端恒为老板本人提交；服务经理代录走后台 `admin.ad.requestChange`，只允许在免费次数内（a05-order-delivery）。
- 超次扣减按修改当时的单价与折扣算，不退回（`d3-flow.md:1323`；`09-order-ad.md:1075`、`1199`）。
- 已确认广告“再次提出修改”：接口支持（`09-order-ad.md:907`），原型未画入口，由产品在详情页补（第 6 节第 4 项）。
- 样片修改意见的“广告内容”不在样片接口里提交（A31：商家端样片接口的 `feedbackKind` 固定 `compose`），页面文案引导到这里。

出处：路线图 `m06.ad.request-revision`（动作名按词表改 `request-change`，A9、C12）；`d3-flow.md:841`、`1289`、`1297-1326`；`09-order-ad.md:807`、`906-907`、`925-983`；`10-delivery.md:179`、`648`；`07-billing-ledger.md:849`；`proto-merchant-b.md:159-163`。

### 3.7 m.ad.submit　补充素材后重新提交
`POST /m/ads/{adId}/submit`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ad.request`；店员视图 `none` |
| 幂等 | required（状态迁移，A17） |
| 乐观锁 | 不带 `lockVersion`（`ad.resubmit` 的守卫没有列 `lock_version`，C53） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | 原型没有“待补充”态与重新提交表单：商家端显示为“制作中（待补充素材）”（`d3-flow.md:1257`），卡片与详情给出退回原因与“补充后重新提交”入口；页面待补，列为设计缺口（第 6 节第 5 项） |

**请求**（请求体的 schema：`AdSubmitBody`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `adId` | string(uuid) | 是 | — | 广告 id |
| 请求体 | `copy` | string \| null | 否 | ≤50 字；不传 = 不改，传 null = 清空（C38） | 改写文案，落 `ad.copy` |
| 请求体 | `remark` | string \| null | 否 | ≤200 字；不传 = 不改，传 null = 清空 | 改写备注，落 `ad.remark` |
| 请求体 | `addReferenceStoreAssetIds` | array<string(uuid)> | 否 | 同 3.3 的素材守卫；与已有的素材库参考素材合计 ≤9 | 追加的素材库参考素材 |
| 请求体 | `addReferenceFileIds` | array<string(uuid)> | 否 | 同 3.3 的档案媒体守卫；与已有的档案媒体参考素材合计 ≤9 | 追加的档案媒体 |

请求体可以为空对象：商家可能已把素材传进素材库，剪辑师在后台能看到，只需重新提交。可改的范围见第 6 节第 5 项；数量上限按来源各计（第 6 节第 7 项）。

**响应**：`data = AdState`（2.14）。

**错误**

| 错误码 | HTTP | 何时 | `details` |
| --- | --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 广告不是 `returned` | — |
| `AD_CANCEL_IN_PROGRESS` | 409 | 有在途的取消申请 | — |
| `FILE_NOT_USABLE` | 400 | 追加的档案媒体文件不可用，或素材的底层文件 `files.link()` 断言失败（m03-profile-asset 46001） | `{ fileIds, reason }` |
| `CONTENT_REJECTED` | 400 | 文案或备注未通过内容安全检测（m01-account 41006） | `{ fields }` |
| `PROVIDER_UNAVAILABLE` | 503 | 文本内容安全检测服务不可用（可重试，同 3.3 说明） | — |
| `VALIDATION_FAILED` | 400 | 追加的素材不在本门店、已删除、被拦截或需补拍（同 3.3）；某一来源合计超过 9 项；与已有的重复 | — |

**副作用**（同一事务）

1. `ad.status: returned → ad.returned_from 的值`（`pending_assign` 或 `producing`）（`ad.resubmit`，`09-order-ad.md:804`）；同一条 UPDATE 写 `ad.resubmit_count + 1`、`ad.due_at`、`ad.sla_snapshot`、`ad.first_due_at`（此刻加 2 个工作日，`09-order-ad.md:772`），并写请求里改的 `ad.copy`、`ad.remark`。不重复冻结、不动账本（PRD 6.4.2-1）。
2. 追加的参考素材：同 3.3 第 5 步（`09-order-ad.md:1163`“提交广告需求或补充素材时”建立引用）。
3. 定时器：登记 `sla.breach`（键 `sla.breach:ad:{adId}:first:{新的 resubmit_count}`；已触发的旧行不清理，换键登记，`09-order-ad.md:701`）；取消本广告的 `ad.returned_stale`（键 `ad.returned_stale:ad:{adId}:{原 resubmit_count}`，`d3-flow.md:1286`、`1390`；x01-events-jobs 4.1）。
4. 写 `status_transition` 与一行 `audit_log`（`action = ad.resubmit`，`before`/`after` 记文案、备注的变化）；出站事件 `ad.resubmitted`（x01-events-jobs 已登记；通知剪辑师或交付经理“已补充素材”）。

**说明**

- 守卫（`09-order-ad.md:804`）：不重复冻结；时限从补充时刻重计，首版定时器用新序号登记；无在途取消。原为“待指派”且门店资质仍在审时，回到待指派继续等待（`waitingReason = qualification`）。重新提交不是“新广告需求”，不再查门店额度。
- 退回满 7 个自然日仍未补充的，由定时器 `ad.returned_stale` 生成客服待办，客服联系商家后决定继续或取消（`d3-flow.md:1390`；`14-config-data.md:307`）；取消走后台取消申请，商家端没有取消入口。

出处：路线图 `m06.ad.resubmit`（动作名按词表并入 `submit`，A9、C12）；`d3-flow.md:1286`、`3511`；`09-order-ad.md:701`、`772`、`804`；PRD 6.4.2。

### 3.8 m.ad.downloadUrls　保存广告到相册（签发下载地址）
`POST /m/ads/{adId}/download-urls`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ad.request`；店员视图 `none` |
| 幂等 | none（签发短时地址，结果不进幂等记录，避免回放过期地址，A18、A19；C47） |
| 乐观锁 | 无 |
| 限流 | `m.sign`（签发类，每用户每小时 600 次；A130、C68） |
| 开关 | 无（这是 `weapp.video.ad.enabled` 关闭时的替代出口，不受它控制；是否可用由该版本的 `preview_channels` 决定，开关此刻的值只用于 2.9 的兜底） |
| 对应画板 | `M:AdDetail`（“保存到相册查看”；原型未画，按 `d7-platform.md:514`“出口同样片”补） |

**请求**（请求体的 schema：`AdDownloadUrlsBody`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `adId` | string(uuid) | 是 | — | 广告 id |
| 请求体 | `versionNo` | integer | 是 | 须等于当前版本（已推送的最大版本号） | 要保存的版本 |

**响应**：`data = DownloadUrl`（m05-delivery-publish 定义，本文 2.16 写取值）。响应头 `Cache-Control: no-store`（C18）。端上用 `wx.downloadFile` 下载后 `saveVideoToPhotosAlbum`，与成片逐集保存走同一套代码（`d7-platform.md:805-810`）。

**错误**

| 错误码 | HTTP | 何时 | `details` |
| --- | --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 广告已取消，或尚无已推送版本 | — |
| `AD_VERSION_STALE` | 409 | `versionNo` 不是当前版本 | `{ currentVersionNo }` |
| `AD_PREVIEW_CHANNEL_UNAVAILABLE` | 409 | 该版本推送时的查看方式不含 `album`，且不属于 2.9 的兜底（开关此刻仍为开，或查看方式含 `portal`） | `{ previewChannels }` |

**副作用**：每次签发写一行访问审计，与下载页的 `portal.ad.playbackUrls` 同构（p01-portal 3.14）：`audit_log.stream = access`、`audit_log.category = file_access`、`audit_log.action = ad.version.album_download`、`audit_log.actor_type = merchant`、`audit_log.actor_id` = 当前用户、`audit_log.client = weapp`、`audit_log.target_type = ad_version`、`audit_log.target_id` = 版本 id、`audit_log.entity_id`、`audit_log.store_id`、`audit_log.meta = { fileCategory: ad_video, urlTtlSec: 900 }`（C60；`03-staff-authz-audit.md:560`、`931`、`951`）。它是 `viewedVia = album`（及兜底的 `weapp`）确认时的查看证据（3.5）。不写 `ad_version` 的任何列：`ad_version` 不加 `first_viewed_at`，访问只记审计流（`09-order-ad.md:1198`）。

**说明**

- 签发的是该版本的文件 `ad_version.file_id`（分类 `ad_video`）。广告视频不加水印（A97；数据模型的广告可播放资产不转码，档位直接指向源文件，`06-media.md:1759`；`d5-media.md:746`），相册保存、下载页预览与企业微信发送用的都是这一份文件。
- 可签发的条件：广告未取消、`versionNo` 是当前版本，且该版本 `preview_channels` 含 `album`，或属于 2.9 的兜底（只有 `weapp`、`wecom` 而开关此刻为关）。兜底与样片的 `m.sample.downloadUrls` 同一口径（m05-delivery-publish 3.8）。
- 地址有效期 15 分钟，同“商家保存样片”（C61 未单列广告保存，按同类取）。
- 这条是路线图定稿时按 `d7-platform.md:514`（开关关闭时出口同样片）与 `09-order-ad.md:862`（`preview_channels` 可含 `album`）补的，A57 已确认保留。

出处：路线图 `m06.ad.download-urls`；A19、A57、A97、C60、C61；`d7-platform.md:514`；`09-order-ad.md:862`、`1198`。

### 3.9 m.playable.get　换取播放地址
`GET /m/playables/{playableId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `optional`；能力点 `assert-in-handler`（A87）：处理器按资产种类判定（见说明）；店员视图 `same`（店员只能播预告片，广告与样片对店员 403 `ROLE_FORBIDDEN`） |
| 幂等 | none（纯查询，GET 不写库） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 按种类：`weapp.video.trailer.enabled`（V1.0 默认关）、`weapp.video.sample.enabled`（默认关）、`weapp.video.ad.enabled`（默认开）；关闭时 403 `FEATURE_DISABLED`（C70；`d7-platform.md:505`） |
| 对应画板 | `M:AdDetail`、`M:Sample`；`M:Detail`、`M:Trailer` 只在日后预告片开关打开时用到（`design-spec.md` 第 11 节：V1.0 不播放预告片） |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `playableId` | string(uuid) | 是 | — | 可播放资产 id（`resources.json`：`playables` / `playableId`），取自所在资源返回的 `playable.playableId` |

**响应**：`data = Playable`（2.8），`sources` 恒非空、`expiresAt` 恒有值。响应头 `Cache-Control: no-store`（C18）。

**错误**

| 错误码 | HTTP | 何时 | `details` |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | 资产是广告或样片，而请求没带凭据（预告片允许匿名）；端上按 C3 静默登录后重放 | — |
| `NOT_A_MEMBER` | 403 | 广告或样片：缺 `X-Store-Id` 或对该门店无成员关系（与中间件同义，C17） | — |
| `ROLE_FORBIDDEN` | 403 | 广告或样片：当前角色是店员 | — |
| `STORE_ARCHIVED` | 403 | 广告或样片：门店已停用（`ad.request`、`delivery.confirm_sample` 都不是收尾能力；m02-tenant 定义） | — |
| `FEATURE_DISABLED` | 403 | 该种类的 `weapp.video.*` 开关已关闭；端上重拉引导并改用替代出口（C70） | — |
| `PLAYABLE_UNAVAILABLE` | 409 | 资产不是 `ready`（处理中、失败或已停用） | `{ state }` |
| `NOT_FOUND` | 404 | 资产不存在、不属于当前门店；对应的广告版本或样片尚未推送，或推送时的查看方式不含 `weapp` | — |

**副作用**：无。

**说明**

- 先按 id 取资产，再按 `playable_asset.kind` 判定（`d5-media.md:1424-1429`）；资产不存在时一律 404，不区分种类：
  - `trailer`：任何人（含游客）；剧目已上架（`drama.status = listed`），且资产是 `drama_trailer.current_playable_asset_id`。
  - `ad`：已登录、`X-Store-Id` 的成员关系为老板（能力点 `ad.request`）、`playable_asset.store_id` 等于当前门店；对应版本（`ad_version.ad_id = playable_asset.owner_id`、`ad_version.file_id = playable_asset.source_file_id`）已推送（`ad_version.pushed_at` 非空）且 `ad_version.preview_channels` 含 `weapp`。
  - `sample`：已登录、老板（能力点 `delivery.confirm_sample`）、`playable_asset.store_id` 等于当前门店；对应样片（`sample.file_id = playable_asset.source_file_id`）已推送（`sample.pushed_at` 非空）且 `sample.preview_channels` 含 `weapp`（m05-delivery-publish 的样片口径）。
- 判定口径与所在资源返回非空 `playable.sources` 的条件一致（2.2；m05 `SampleView.playable`）：端上只在 `sources` 非空、地址过期或播放报错时调本接口。`sources` 为空的对象（只带海报）不用换新。
- 只用于不需留痕的播放（小程序内播放，`viewedVia = weapp`）；需要“已查看”证据的读走所属资源的 `POST …/download-urls`、`POST …/playback-urls`（A19、C62）。
- 门店素材不是可播放资产（`playable_asset.kind` 只有 `trailer`、`sample`、`ad`，`06-media.md:851`），素材视频的地址随 `m.storeAsset.get` 返回，过期时重取素材详情；本接口的画板不含 `M:AssetDetail`。
- 地址有效期：广告、样片 60 分钟；预告片走 CDN 鉴权地址（`d5-media.md:1424-1429`；C61）。

出处：路线图 `m06.playable.get`；`d5-media.md:1419-1446`、`1480-1495`、`2092`；`d7-platform.md:790-797`；`06-media.md:842-921`；A19、A87、A97、C62。

## 4. 枚举

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `AdType` | `opening`、`ending`、`corner`、`mid_roll` | 同数据模型 `ad.type`（片头贴片、片尾贴片、角标字幕条、片中插播）。请求只接受参数 `content.placement.open_slots` 内的取值（V1.0 为 `opening`、`ending`）；响应标 `x-open-enum` |
| `AdStatus` | `pending_assign`、`producing`、`returned`、`pending_confirm`、`revising`、`confirmed`、`cancelled` | 同数据模型 `ad.status`；`x-open-enum` |
| `AdDisplayStatus` | `producing`、`pending_confirm`、`revising`、`confirmed`、`cancelled` | 本文定义的商家端显示状态，全仓商家端（含 m03 档案页计数、m05 方案页广告卡、p01 下载页）都按此映射：`pending_assign`、`producing`、`returned` → `producing`（制作中）；`pending_confirm` → 待确认；`revising` → 修改中（单列，不并入制作中）；`confirmed` → 已确认；`cancelled` → 已取消（`d3-flow.md:1257`；PRD 6.4.3-1）；`x-open-enum` |
| `AdWaitingReason` | `materials`、`qualification` | 本文定义：待补充素材；等待门店资质审核后开始制作 |
| `AdListTab` | `all`、`producing`、`pending_confirm`、`revising`、`confirmed` | 列表页签：`producing` = `ad.status` ∈ {`pending_assign`、`producing`、`returned`}；其余与同名状态一一对应；`all` 含已取消 |
| `AdDueKind` | `first_version`、`revision` | 由 `ad.sla_snapshot.policy`（`ad.first_version`、`ad.revision`）推出 |
| `PreviewChannel` | `weapp`、`album`、`portal`、`wecom` | 同数据模型 `ad_version.preview_channels` 的元素与 `ad_version.confirm_viewed_via`（小程序内播放、保存到相册、电脑端、企业微信）；本文是唯一定义（A152、C87），m05、a05、p01 引用，不另定义（初稿名 `ViewChannel` 改） |
| `AdVersionDecision` | `confirmed`、`revision_requested`、`superseded` | 同数据模型 `ad_version.decision`；商家只看到已推送版本，`superseded` 只出现在“上传后未推送即被取代”的版本上，因此商家端实际不会出现 |
| `AdRevisionSource` | `ad_page`、`sample_feedback`、`staff_on_behalf` | 同数据模型 `ad_revision.source` |
| `ActorType` | `merchant`、`staff`、`system`、`partner` | 同数据模型 `ad_revision.actor_type`、`audit_log.actor_type` |
| `AdReferenceKind` | `store_asset`、`profile_media` | 本文定义：参考素材来自素材库或档案媒体（M20） |
| `ProfileMediaGroup` | `door`、`interior`、`product`、`promo` | 同数据模型 `store_profile_media.media_group`（门头、店内环境、产品、宣传素材） |
| `StoreAssetType` | `image`、`video`、`recording`、`audio`、`document`、`text` | 同数据模型 `store_asset.type` |
| `PlacementSlot` | `opening`、`ending`、`corner`、`mid_roll` | 同数据模型 `order_item_placement.slot`（与 `ad.type` 同一组取值）；响应标 `x-open-enum`，V1.0 实际只出现 `opening`、`ending` |
| `DeliveryTicketStep` | 13 个取值 | 同数据模型 `delivery_ticket.step` |
| `ServiceTicketStatus` | `pending`、`processing`、`awaiting_confirm`、`resolved`、`closed` | 同数据模型 `service_ticket.status`（与 m08-support-misc 共用） |
| `StoreGate` | `full`、`parallel`、`blocked` | 门店闸门（`profile.storeGate`，`d9-profile.md:631`、`649`） |
| `PlayableKind` | `trailer`、`sample`、`ad` | 同数据模型 `playable_asset.kind` |
| `PlayableQuality` | `sd`、`hd`、`source` | 同数据模型 `playable_asset.renditions[].quality` |
| `PlayableState` | `processing`、`ready`、`failed`、`retired` | 同数据模型 `playable_asset.state`（只出现在 `PLAYABLE_UNAVAILABLE` 的 `details`） |
| `AdRequiredEvidence` | `album_saved`、`portal_viewed`、`album_or_portal` | 本文定义：`AD_NOT_VIEWED.details.requiredEvidence`；`album_or_portal` 用于开关被关闭后的 `weapp` 兜底（与 m05 `SAMPLE_NOT_VIEWABLE` 同口径） |
| `StoreNotQualifiedReason` | 见 m04-mall-order | `STORE_NOT_QUALIFIED.details.reason`，引用 m04 的定义 |

**可执行动作**（`actions`，取 C12 词表；只对老板计算，广告有在途取消时一律为空）

| 动作 | 条件 | 对应接口 |
| --- | --- | --- |
| `confirm` | `ad.status = pending_confirm` | `m.ad.confirm` |
| `request-change` | `ad.status` ∈ {`pending_confirm`、`confirmed`} | `m.ad.requestChange` |
| `submit` | `ad.status = returned` | `m.ad.submit` |

## 5. 错误码

本文新定义（模块段 45200–45299，A70）：

| 符号 | 数值 | HTTP | 可重试 | 含义 | `details` |
| --- | --- | --- | --- | --- | --- |
| `AD_CANCEL_IN_PROGRESS` | 45201 | 409 | 否 | 广告有在途的取消申请，审批结束前不能确认、提出修改或重新提交（`ad.open_cancel_request_id` 非空，`09-order-ad.md:718`、`811`）。后台的广告迁移（指派、退回、推送）可以沿用 | — |
| `AD_VERSION_STALE` | 45202 | 409 | 否 | 请求里的版本号不是当前版本（已推送新版本或页面过期），请刷新后再操作 | `{ currentVersionNo: integer \| null }` |
| `AD_PREVIEW_CHANNEL_UNAVAILABLE` | 45203 | 409 | 否 | 这一版推送时没有提供这种查看方式，请用页面上给出的方式查看 | `{ previewChannels: PreviewChannel[] }` |
| `AD_NOT_VIEWED` | 45204 | 409 | 否 | 还没有通过所选方式查看过这一版（电脑端未预览、未保存到相册），请先查看再确认 | `{ viewedVia: PreviewChannel, requiredEvidence: AdRequiredEvidence }` |
| `CHARGE_CHANGED` | 45205 | 409 | 否 | 本次修改的扣减积分与页面提示不一致，或本次修改需要扣积分但尚未确认，请按最新提示重新确认（沿用 `d3-flow.md:1312` 的符号名） | `{ isChargeable: boolean, chargePoints: integer, freeRevisionsRemaining: integer }` |
| `PLAYABLE_UNAVAILABLE` | 45206 | 409 | 否 | 视频还在处理中或已停用，暂时不能播放 | `{ state: PlayableState }` |

本文引用、由其他文档定义的领域码（不重新定义；归属按 A77 与约定 C28 的共用领域码归属表）：

| 符号 | 定义方 | 数值 | HTTP | 本文用在 | `details` |
| --- | --- | --- | --- | --- | --- |
| `QUOTA_EXCEEDED` | m02-tenant | 41106 | 409 | `m.ad.create`；`m.ad.quote` 的 `blockers` | `{ storesUsed, storeLimit, storesOver }` |
| `STORE_ARCHIVED` | m02-tenant | 41107 | 403 | `m.playable.get`（广告、样片）；其余接口经中间件 | — |
| `STORE_NOT_QUALIFIED` | m04-mall-order | 45008 | 409 | `m.ad.create`；`blockers` | `{ storeId, reason: StoreNotQualifiedReason }` |
| `SUBSCRIPTION_INACTIVE` | m07-billing | 43010 | 409 | `m.ad.create`、`m.ad.requestChange`；`blockers` | — |
| `POINTS_INSUFFICIENT` | m07-billing | 43009 | 409 | 同上 | `{ requiredPoints, spendablePoints, shortfallPoints }` |
| `PLAN_REFUND_IN_PROGRESS` | m07-billing | 43006 | 409 | 同上 | — |
| `QUOTE_CHANGED` | m07-billing | 43007 | 409 | `m.ad.create`（`m.ad.requestChange` 映射为 `CHARGE_CHANGED`） | `QuoteChangedDetails` 的 `points` 分支：`{ kind: 'points', totalChargePoints, items: [{ dramaId: null, chargePoints }] }` |
| `ACCOUNT_BUSY` | m07-billing | 43008 | 503（可重试） | `m.ad.create`、`m.ad.requestChange` | — |
| `AGREEMENT_VERSION_STALE` | m01-account | 47401 | 409 | `m.ad.create` | `{ agreementKey, currentAgreementVersionId }` |
| `CONTENT_REJECTED` | m01-account | 41006 | 400 | `m.ad.create`、`m.ad.submit`、`m.ad.requestChange` | `{ fields }`：`copy`、`remark`、`note` 中命中的字段路径 |
| `DICT_ITEM_DISABLED` | m08-support-misc | 47001 | 409 | `m.ad.create` | `{ dictTypeKey, code }` |
| `FILE_NOT_USABLE` | m03-profile-asset | 46001 | 400 | `m.ad.create`、`m.ad.submit`、`m.ad.requestChange` | `{ fileIds, reason }` |

素材库参考素材的业务守卫（不在本门店、已删除、被拦截、需补拍）与 m04 订购一样返回 `VALIDATION_FAILED`（`fieldErrors.path` 指到数组下标）；m04 已删除 `ORDER_REFERENCE_ASSET_INVALID`，两边不再另设领域码。

通用码中本文有特殊含义的：`STATE_NOT_ALLOWED`（各迁移的状态守卫）、`FEATURE_DISABLED`（`m.playable.get` 的视频开关）、`VALIDATION_FAILED`（schema、数量上限、素材守卫、时间段与分段、协议勾选，带 `fieldErrors`）、`NOT_FOUND`（不在当前门店、版本未推送或不含小程序内播放）、`AUTH_REQUIRED`、`NOT_A_MEMBER`、`ROLE_FORBIDDEN`（`m.playable.get` 在处理器里按种类判定时返回，语义同中间件）、`PROVIDER_UNAVAILABLE`（文本内容安全检测不可用）、`BUSY`（确认时锁集合变化重试仍失败）。

## 6. 待确认

| # | 问题 | 默认做法 | 拍板 |
| --- | --- | --- | --- |
| 1 | 提交广告需求要不要每次显式勾选协议。原型弹层没有勾选框（`proto-merchant-b.md:142`） | 老板未同意过现行版本时显示勾选框并必须勾选；已同意过则不显示，接口记 `prior_consent`（`d6-notify-docs-data.md:1179`）。法务要求每次勾选时只改前端与播种，接口不变 | 法务 |
| 2 | 广告确认的查看证据。数据模型不给 `ad_version` 加 `first_viewed_at`（`09-order-ad.md:1198`） | `portal` 以下载页预览的访问记录为证（数据模型不变量），`album` 以保存到相册的访问记录为证（本稿补充），`wecom` 以“已发送”为证；证据都在 `audit_log` 访问流 | 产品、法务 |
| 3 | 已停用门店的老板能否查看广告（`ad.request` 对已停用门店为 ✘，`d4-identity.md:865`） | 不能，返回 `STORE_ARCHIVED`；门店停用前广告须已办结（`StoreCloseGuard` 的 `ad_in_production`，第 1 节） | 产品 |
| 4 | 已确认广告的“再次提出修改”入口原型未画（`proto-merchant-b.md:167`） | 接口支持；详情页对已确认广告也显示“提出修改意见”，弹层照常提示免费次数与扣减 | 产品 |
| 5 | 被退回补充后：页面怎么呈现、重新提交能改什么。原型与设计规范第 12 节都没有“制作中（待补充素材）”卡片、退回原因与“补充后重新提交”表单；PRD 只写“补充后重新提交” | 卡片与详情显示退回原因和“补充后重新提交”按钮，表单可改文案、备注，可追加参考素材；类型、时长、宣传重点不改。页面已列入设计规范第 12 节的待补原型（A146），接口按本默认做法不变 | 产品、设计 |
| 6 | 列表“全部”是否显示已取消的广告 | 显示，标“已取消”；其他页签不含 | 产品 |
| 7 | 参考素材数量上限 | 素材库与档案媒体按来源各至多 9 项，补充时与已有的合计（本稿补充，契约层校验） | 产品 |

## 7. 修订记录

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：路线图 `doc = m06-ad` 的 9 条接口全部写到字段级；新定义错误码 45201–45206；列表补 `type`、`isSelectable` 筛选与 `all` 页签；写接口统一返回不含签名地址的 `AdState` | 写作规范；A1–A75；C1–C84；数据模型 06、07、09、10、12、13 分组 |

**第二轮（2026-10-03）**

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 查看方式与开关：确认按版本的 `preview_channels` 校验，删去“`viewedVia = weapp` 而开关已关即拒绝”的补充守卫，改为与 m05 样片同一兜底——开关在推送后被关闭、版本只有 `weapp` 时可保存到相册（下载页按同一兜底放行），以 `weapp` 确认须勾选且有相册或电脑端访问记录（`AD_NOT_VIEWED.details.requiredEvidence`）；`playable.sources` 只在版本含 `weapp` 且开关为开时有值，推送时开关关、之后打开的版本不出播放器；`m.playable.get` 对广告、样片要求对应版本含 `weapp`；详情补 `viewEvidence`、`confirmableVia`；`AD_PREVIEW_CHANNEL_UNAVAILABLE` 的含义收窄 | A97；复核 A（查看方式三条路都断，采纳其第二种改法）、B（与 m05 不一致）；a05 请求；m05 第二轮 3.8、3.9 |
| 2026-10-03 | `Playable` 定为全仓唯一定义（m05 已删去自定义结构改为引用）：资产未就绪为 null；就绪而不能在小程序内播放时返回只带海报的对象，`sources = []`、`expiresAt = null`（C62，与 m05 一致）；`m.playable.get` 的结果 `sources` 恒非空；`posterUrl` 与卡片 `coverUrl` 改为 `playable_asset.cover_file_id` 优先、否则取体检抽帧 `media_info.cover_file_id` | 复核 B（Playable 两份定义）、A（封面来源）；C62 |
| 2026-10-03 | `m.ad.requestChange`：工单回到广告准备时同事务把未决样片置 `superseded`；两个写接口补 `ticket.step_changed`、`sample.superseded` 事件与环节时限定时器；3.5 第 5 步与第 3 步的矛盾改正；账本事件聚合按 x01 改为 `billing_account`；处理器把账本的 `QUOTE_CHANGED` 映射为 `CHARGE_CHANGED` | 复核 A、B；`10-delivery.md:648`；`d3-flow.md:841`；x01-events-jobs |
| 2026-10-03 | `m.ad.confirm` 加锁顺序按 `d3-flow.md:1360-1366`：广告行合并按 id 升序（本广告排他、其余共享），复核广告位集合，变了整体重试 | 复核 A；`09-order-ad.md:679` |
| 2026-10-03 | `m.ad.create` 加门店额度守卫 `QUOTA_EXCEEDED`（m02），`m.ad.quote` 的 `blockers` 同步；`blockers` 改为与 m04 同形的 `{ code, message }`，`code` 取错误符号 | 复核 B；m02 请求；`d4-identity.md:673` |
| 2026-10-03 | 错误码：档案文件、截图与素材底层文件不可用改用 `FILE_NOT_USABLE`（m03）；素材库参考素材的业务守卫与 m04 第二轮一致仍返回 `VALIDATION_FAILED`（m04 已删 `ORDER_REFERENCE_ASSET_INVALID`，复核 B 建议的“按 m04 的做法”即此）；宣传重点停用用 `DICT_ITEM_DISABLED`（m08）；`AD_INVALID` 改为 `ORDER_AD_INVALID`；按定义方的现行清单写明 `STORE_NOT_QUALIFIED`（m04 45008）、`POINTS_INSUFFICIENT`（m07 43009）、`SUBSCRIPTION_INACTIVE`（m07 43010）、`QUOTE_CHANGED` 的 `points` 分支、`AGREEMENT_VERSION_STALE`、`CONTENT_REJECTED`（`{ fields }`）的 `details`；`QUOTE_CHANGED` 端上重调报价并换新键；文本检测服务不可用改为 503 `PROVIDER_UNAVAILABLE`（m01 口径，原“放行并标记待补检”在数据模型里没有落点） | A77、A120；复核 B；m03 请求；api-check；m01、m04、m07 第二轮 |
| 2026-10-03 | `m.playable.get` 能力点声明为 `assert-in-handler`；错误表补 `AUTH_REQUIRED`、`NOT_A_MEMBER`、`ROLE_FORBIDDEN`、`STORE_ARCHIVED` | A87；复核 B |
| 2026-10-03 | 广告时长选项与修改截图上限改由参数给出（`ad.duration_options`、`ad.revision_screenshot_max`，按 A107 补登）；开放类型按 `content.placement.open_slots`；详情补 `revisionScreenshotMax`；宣传重点选项注明来自 `m.dictItem.list?types=ad_promo_point`；第 6 节原第 2 项关闭 | A107；复核 A、B |
| 2026-10-03 | 时间线：只取广告状态机 8 个迁移的审计行，标题与说明读取时按商家口径渲染（`title`、`detail`、`versionNo`），不再回传员工视角的 `summary`；后台登记版本、已发送、催办等不进时间线 | 复核 A；`03-staff-authz-audit.md:570` |
| 2026-10-03 | 参考素材补 `mediaGroup`（取 `store_profile_media.media_group`），`category` 只作兜底 | 复核 A；`04-profile.md:170` |
| 2026-10-03 | 账本调用补 `titleCode`、`titleArgs`（`ad_hold`、`ad_revision_charge`，参数按 m07 4.5 现行表：`adNo`、`unitPoints`、`discountBp`）；`m.ad.downloadUrls` 的访问审计补 `category = file_access`、`client = weapp`、`actor_type = merchant`，与 p01 同构；列表、详情、签发响应补 `Cache-Control: no-store` | 复核 B；m07 请求；C18 |
| 2026-10-03 | 枚举 `ViewChannel` 改名 `PreviewChannel`；`PlacementSlot` 标 `x-open-enum`；`AdDisplayStatus` 写明全仓商家端共用、“修改中”单列；新增 `AdRequiredEvidence`；`SignedFileUrl` 改名 `AdDownloadUrl`（与 m07 同名不同构）；`SignedImage` 删去，改引用 m08 的同构结构 `ImageRef` | 复核 B；契约 schema 名唯一；m08 2.1 |
| 2026-10-03 | 列表的画板改为 `M:Ads`、`M:Checkout`，注明 `M:Profile`、`M:Plan` 分别取 m03 `AdsBrief`、m05 `PlanPlacementView`；`M:AssetDetail` 从 `m.playable.get` 的画板删去 | 复核 A；作者的路线图修改建议 |
| 2026-10-03 | 第 1 节补“登记给其他模块的守卫与只读查询”：`StoreCloseGuard` 的 `ad_in_production`、按广告 id 取编号、`isSelectable` 判定 | m02、m03、m04 请求 |
| 2026-10-03 | 广告不加水印：删去“带水印”的说法，原第 6 节第 1 项关闭；`ad.resubmitted` 已由 x01 登记，删去“请 x01 登记” | A95、A97 |
| 2026-10-03 | 第 6 节：关闭原第 1、2 项；“待补充”态与重新提交表单列为设计缺口（新第 5 项）；参考素材上限统一为按来源各 ≤9（含已有）；其余重新编号，正文引用同步 | A97、A107、A108；复核 A |
| 2026-10-03 | 路线图切片 `rm/m06-ad.json` 同步：作者提出的 8 项修改全部写入（页签与筛选、请求体字段、`viewedVia` 必填、`download-urls` 去水印说法、`M:AssetDetail` 删除、表清单）；`m.playable.get` 能力点 `assert-in-handler`；各条 `tables`、`notes` 按本轮改动更新 | A119、A120 |
| 2026-10-03 | 未采纳：广告需求的协议改用 `ConsentInput`（`m01-account.md:124`：广告需求（m06）只提交 `agreementVersionId`、付款单（m07）提交 `agreementVersionIds`，服务端按版本行补协议键；`ConsentInput` 用于用户级协议与 m04 订购）；时间线范围扩到 `ad_version`、`ad_revision`（会把未推送版本的登记暴露给商家，推送迁移的审计对象本就是广告）；协议卡字段改名 `title`（m01 的协议结构都叫 `name`，改请 m04 对齐） | 复核 B；m01 请求 |

**第三轮（2026-10-03）**

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 公共结构按登记表改引用：宣传重点的 `PromoPoint` 删去，`promoPoints` 改为 `DictRef[]`；报价阻断项 `AdQuoteBlocker` 删去，引用 m04 的 `QuoteBlocker`（广告报价不带 `dramaId`）；下载地址 `AdDownloadUrl` 删去，`m.ad.downloadUrls` 返回 m05 的 `DownloadUrl`（2.16 只写广告的取值）；`Playable` 仍以 2.8 为唯一定义，补写三种情形（A135、A147）；清单加 `externalSchemas` | A132、A133、A135、A147、A150；C85、C87 |
| 2026-10-03 | 文本检测服务不可用：删去“x01 登记补检事件之后改为先接受”的过渡说法，V1.0 一律拒收 | A137 |
| 2026-10-03 | `m.ad.downloadUrls` 限流改为签发档 `m.sign` | A130；C68 |
| 2026-10-03 | 参数 `ad.duration_options`、`ad.revision_screenshot_max` 注明已列入 07 待回写清单；第 6 节第 5 项注明页面已列入设计规范第 12 节待补原型 | A146 |
| 2026-10-03 | “已发送”改为交付经理在后台登记（`admin.adVersion.markSent`），推送请求不带；参考素材缩略图注明与 m03 `StoreAssetCard` 同一规则 | a05、m03 第二轮请求；A129 |
| 2026-10-03 | 已核对、无需改动：`QUOTA_EXCEEDED` 守卫与 `blockers`（m02）；`CONTENT_REJECTED.details = { fields }`（m01、A131）；`ORDER_AD_INVALID`、`STORE_NOT_QUALIFIED`（45008，`details.reason`）、`FILE_NOT_USABLE`、参考素材 `VALIDATION_FAILED`（m04）；`m.playable.get` 样片须 `sample.preview_channels` 含 `weapp`，`Playable`、`PlayableSource`、`AdDisplayStatus` 不改名（m05）；`isSelectableAsReference`、`AdsBrief` 的 `revisingCount`、使用记录按广告编号（m03）；`ad_hold` 的 `titleArgs`（m07）；`ImageRef`、`AdRelatedServiceTicket`（m08）；迁移审计行的 `meta.versionNo`、`meta.revisionNo` 与退回原因（a05） | 第三轮输入第二部分 |
| 2026-10-03 | 未采纳：广告提交的 `QUOTE_CHANGED` 另起 `kind = ad` 分支（A131 已定 `kind` 只有 `plan`、`topup`、`points`，广告用 `points` 分支）；协议改用 `ConsentInput`（m04 现行写法同样只交 `agreementVersionId`，`m04-mall-order.md:823`；`ConsentInput` 只用于用户级协议）；检测不可用时“放行并标记待补检”（A137） | A131、A137；m01、m04 请求 |

**第四轮（2026-10-03）**

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | `AdRelatedServiceTicket` 的 `typeCode` + `typeName` 合并为 `type: DictRef`（单值字典字段，清单同步）；第二轮未采纳 `ConsentInput` 的理由改引 `m01-account.md:124`（行为不变）。已核对无需改动：`PreviewChannel` 由本文第 4 节定义（补注归属）、`ImageRef` 只记 `externalSchemas`（A152）；`QuoteBlocker` 引用 m04（m04 请求）；`m.ad.downloadUrls` 返回 m05 `DownloadUrl`（m05 请求） | A151、A152；C85、C87；m01、m04、m05 请求 |
