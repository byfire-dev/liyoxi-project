# 电脑端下载页

| 项 | 内容 |
| --- | --- |
| 文档 | `p01-portal` |
| 范围 | 商家电脑端下载页（`portal.<域名>`，前缀 `/api/v1/portal`）的全部接口：扫码登录（建票据、轮询、换会话）、当前会话与退出、可下载清单、成片下载（逐集、打包、发布清单文件）、发布清单复制、样片与广告的只读预览（元数据与留痕签发分开）、授权书验真（`/v?code=` 页面的数据接口）、前端错误上报；V1.1 的电脑端上传占位。页面：原型无，按 d7-platform.md:1270 的 5 个页面加 `/a` 落地页、`/v` 验真页（05-risks-and-open-issues.md:271 列为待补原型；design-spec.md 第 12 节：按后台规格实现） |
| 接口数 | 17（V1.0 16，V1.1 1） |
| 依据 | 数据模型 `02-identity-tenant.md` 2.4 `portal_session`、2.15 `portal_ticket`；`10-delivery.md` 2.7 `sample`、2.10 `delivery_release`、2.12 `download_grant`、2.13 `delivery_download_log`、2.14–2.15 发布清单；`06-media.md` 2.1 `file_object`、2.4 `media_info`（封面帧兜底）、2.11 `playable_asset`、2.12 `zip_bundle`；`13-notify-docs.md` 2.13–2.14 授权书与版次、第 4 节 `letter_snapshot`；`09-order-ad.md` 2.3 `order_item`、2.8 `ad`、2.9 `ad_version`；`03-staff-authz-audit.md` 2.10 `audit_log`、2.11 `auth_event`；`14-config-data.md` 2.9 `analytics_event`。草案 d7-platform.md 第 6 节（下载页最小形态与票据），d5-media.md 第 7、8 节与第 12 节接口清单，d4-identity.md 第 3.7 节与附录 A、B，d6-notify-docs-data.md 3.5.4、3.6（验真页）。接口裁决 A1–A150（`api-rulings.md`）；通用约定 C1–C87（`conventions.md`）；资源登记表 `resources.json` |
| 状态 | 第二轮修订（2026-10-03） |

## 1. 概览

下载页让老板在电脑上拿到整部剧：电脑显示二维码与两位配对数字，老板在小程序里扫码并点选同一个数字（`m.portalTicket.lookup` / `m.portalTicket.approve`，归 m02-tenant），电脑凭只在本页内存里的 `pollSecret` 换出一个 2 小时的只读会话。会话期间可以看本门店名下可下载的订购项、逐集或打包下载、复制发布清单、预览待确认的样片与广告（只读，确认与修改意见回小程序提交）。授权书验真页不需要会话，任何人扫授权书 PDF 页脚的二维码即可核对。下载页不出现价格、套餐、积分、购买入口与任何付款引导（d7-platform.md:1275；d5-media.md:1647）。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `portal.portalTicket.create` | `POST /portal/portal-tickets` | 建扫码登录票据 | public | none（匿名建票据，A18） |
| `portal.portalTicket.get` | `GET /portal/portal-tickets/{portalTicketId}` | 轮询票据状态（`X-Poll-Secret`） | public | none（查询） |
| `portal.portalTicket.exchange` | `POST /portal/portal-tickets/{portalTicketId}/exchange` | 凭 `pollSecret` 换下载页会话；要作废票据时返回 200 与 `status = rejected` | public | none（换会话，A18） |
| `portal.session.current.get` | `GET /portal/sessions/current` | 当前会话（A41、A82） | portal | none（查询） |
| `portal.session.current.delete` | `DELETE /portal/sessions/current` | 电脑端退出，结束本会话（A43、A82） | portal | none（退出，A43） |
| `portal.orderItem.list` | `GET /portal/order-items` | 可下载清单（含待预览样片标记） | portal；`delivery.download` | none（查询） |
| `portal.orderItem.release.get` | `GET /portal/order-items/{orderItemId}/release` | 成片下载页数据 | portal；`delivery.download` | none（查询） |
| `portal.orderItem.downloadUrls` | `POST /portal/order-items/{orderItemId}/download-urls` | 签发单集、ZIP、发布清单文件的直链并留痕 | portal；`delivery.download` | none（签发短时地址） |
| `portal.orderItem.publishList.get` | `GET /portal/order-items/{orderItemId}/publish-list` | 发布清单（复制） | portal；`delivery.download` | none（查询） |
| `portal.orderItem.sample.get` | `GET /portal/order-items/{orderItemId}/sample` | 样片预览页元数据 | portal；`sample.view` | none（查询） |
| `portal.sample.playbackUrls` | `POST /portal/samples/{sampleId}/playback-urls` | 签发样片水印版播放地址并留痕 | portal；`sample.view` | none（签发短时地址） |
| `portal.ad.list` | `GET /portal/ads` | 本门店待确认的广告 | portal；`ad.view` | none（查询） |
| `portal.ad.get` | `GET /portal/ads/{adId}` | 广告预览页元数据 | portal；`ad.view` | none（查询） |
| `portal.ad.playbackUrls` | `POST /portal/ads/{adId}/playback-urls` | 签发广告播放地址（源文件，不加水印，A97）并留痕 | portal；`ad.view` | none（签发短时地址） |
| `portal.licenseVerification.get` | `GET /portal/license-verifications?code=&revNo=` | 授权书验真 | public | none（查询） |
| `portal.clientError.create` | `POST /portal/client-errors` | 前端错误上报（202） | optional | none（错误上报） |
| `portal.file.create` | `POST /portal/files` | V1.1：电脑端上传登记 | portal；V1.1 定 | natural（[`uq_file_object_client_token_store`]，A49） |

路由顺序（A8、C12）：`/portal/sessions/current` 是视图别名（A41 第四类），`portal-sessions` 在下载页一侧没有 `/{portalSessionId}` 路由，不冲突；其余没有与 `/{xxxId}` 同层的字面段，`/portal/portal-tickets/{portalTicketId}/exchange` 与 `/portal/order-items/{orderItemId}/…` 的子路径各自固定。

### 1.1 本文通用规则

| 事项 | 规则 |
| --- | --- |
| 会话（`x-auth: portal`） | 凭 Cookie `__Host-lyx_portal`（`HttpOnly; Secure; SameSite=Strict; Path=/`，C5）。中间件 `portalAuth` 每请求按 `sha256(Cookie 值)` 查 `uq_portal_session_token_hash`，并校验：未吊销（`portal_session.revoked_at` 为空）、未过期（`portal_session.expires_at` 晚于当前）、授权人账号 `merchant_user.status = active` 且仍是 `portal_session.entity_id` 的有效老板（`entity_member.role = owner`、`entity_member.status = active`）；门店属于该主体由复合外键保证（02-identity-tenant.md:285；d4-identity.md:501）。没带 Cookie 返回 401 `AUTH_REQUIRED`；带了但不通过返回 401 `PORTAL_SESSION_INVALID`（`details.reason` 说明原因，会话失效说明页据此出文案）。中间件只读不写：授权人失效但会话尚未被吊销时只拒绝，不在请求里补写 `revoked_at`（GET 不写库，A19；吊销由成员关系变化的事务与每日不变量 `identity.I20` 完成） |
| 能力白名单 | 下载页会话的能力点固定为 `delivery.download`、`sample.view`、`ad.view`（d5-media.md:1645、2141；V1.0 `portal_session.grant_scope` 只有 `store`，三项恒有）。`sample.view`、`ad.view` 不在 d4 能力表里，已按 A65、A87 进增补表（仅下载页会话可用，店员无，已停用门店的老板有）。店员不能扫码授权（m02 的能力点 `portal.authorize` 只给老板），所以下载页没有店员视图，`x-clerk-view` 不适用 |
| 数据范围 | 一律按 `store_id = portal_session.store_id`（且 `entity_id = portal_session.entity_id`）过滤；不在范围内的订购项、样片、广告返回 404 `NOT_FOUND`（C24、C29）。一次授权只覆盖确认时的门店，多门店老板按门店分别扫码（02-identity-tenant.md:873） |
| 已停用门店 | 会话照常可用，下载照常可用（d4-identity.md:501；02-identity-tenant.md:285）。`PortalSessionView.isStoreArchived` 供页面提示 |
| 操作人与留痕 | 下载页请求的操作人是授权的老板：`actor_type = merchant`、`actor_id = portal_session.approved_by_user_id`、`client = portal`，不设 portal 操作人类型（R15；02-identity-tenant.md:298）。访问留痕写 `audit_log`（`stream = access`、`category = file_access`、`session_id = portal_session.id`、`auth_method = portal`、`ip`、`user_agent`）；成片签发写 `delivery_download_log` |
| 防跨站 | 全部非 GET（含匿名的建票据、换会话、错误上报，以及 `DELETE` 退出）必须带 `X-LYX-Portal: 1` 且 `Origin` 等于下载页源，否则 403 `ORIGIN_REJECTED`（C17；d7-platform.md:1263）。下载页不开 CORS |
| 幂等 | 下载页没有 `required` 路由：建票据与换会话按 A18 为 `none`；退出按 A43 为 `none`；签发类为 `none`（结果不进幂等记录，避免回放过期地址）；其余是查询。因此下载页请求不带 `Idempotency-Key`，也不写 `idempotency_record` |
| 分页 | 游标分页：`cursor`（首页不传）、`limit`（默认 20，上限 50）；响应 `{ items, nextCursor, hasMore }`，不返回总数（A22、C42）。下载页无原型，页面描述里没有带数字的页签或标题，本文不设 `summary`（A23；补原型时若出现计数再补） |
| 签名地址 | 一律 `{ url, expiresAt }`（C60）。随数据返回、不留痕的：剧目封面、样片与广告的海报（30 分钟对齐窗口，C61）。单独签发、逐次留痕的：单集 15 分钟、ZIP 3 小时、发布清单文件 15 分钟（A125 补进 C61）、样片与广告播放 60 分钟（C61） |
| 缓存 | 下载页全部 `portal` 接口与验真接口带 `Cache-Control: no-store`（C18：含签名地址或个人数据） |
| 只读 | 下载页没有任何业务写动作（d7-platform.md:1275），列表与详情不带 `actions`（C16 的词表里没有可在下载页执行的动作），改用布尔字段表达“能否下载、能否预览” |
| 不出现的字段 | 价格、积分、套餐、付款相关的任何字段都不返回（d7-platform.md:1275；d5-media.md:1647）：广告不返回 `ad.charge_points` 等计价列，订购项不返回计价快照 |
| 维护 | 停机维护期间下载页显示静态维护页，不调接口（A65）；网关对 `/portal/*` 返回 503 `MAINTENANCE`（C72） |
| 限流 | `portal.ticket`（建票据每 IP 10 张 / 分；轮询每票据 60 次 / 分；换会话每票据 5 次）、`portal.global`（每会话 300 次 / 分）、`telemetry`（错误上报）、`portal.verify`（验真，按 IP）（C68） |
| 开关 | 本文接口不受 `weapp.video.*` 开关拦截（不返回 `FEATURE_DISABLED`），下载页的预览是小程序内不能播放时的替代出口（d5-media.md:1427）。但**能否在电脑上预览取决于该版本推送时写定的查看方式**（`sample.preview_channels`、`ad_version.preview_channels`，推送时按开关写入、之后不回改，10-delivery.md:562；A97）：含 `portal` 即可预览；推送时开关为开、只写了 `weapp`（或 `weapp`、`wecom`）的版本，若开关此刻已被关闭，按 m05-delivery-publish 3.8、m06-ad 2.9 的同一兜底放行（读 `weapp.video.sample.enabled` / `weapp.video.ad.enabled` 按会话门店求值的此刻值）；开关此刻仍为开的，只能在小程序内播放，下载页给出“请在小程序内观看”。下文称这一规则为“开关兜底” |
| 对应画板 | 下载页没有原型（05-risks-and-open-issues.md:271；design-spec.md 第 12 节“原型没有的页面”）。下文“对应画板”写 d7-platform.md:1270 的页面编号：① 扫码登录页 `/`、② 可下载清单 `/items`、③ 成片下载 `/items/:id`、④ 样片 / 广告只读预览 `/preview/:kind/:id`、⑤ 会话失效说明页；另有 `/a` 扫一扫落地页、`/v` 授权书验真页 |

## 2. 公共结构

类型写法按写作规范：`string(uuid)`、`string(date-time)`、`string(date)`、`string(bigint)`、`integer`、`enum(…)`、`boolean`、`array<…>`、`object`，可空写 `| null`。“来源”一列写表列或计算规则。

### 2.1 通用片段

#### 引用的通用结构（本文不再定义）

按 A132、A150 与公共结构登记表（C87），下面两个结构本文只引用，下载页 OpenAPI 文档里由契约包共享：

- `CursorPage<T>`：约定 C42 的通用游标分页 `{ items, nextCursor, hasMore }`；下文写 `CursorPage<X>` 表示 `items` 的元素是 `X`。
- `SignedUrl`：`{ url, expiresAt }`，归属 a01-system；`url` 不可空，整个对象可空（C60、C61）。本文出现在 `poster` 等字段。

#### `DownloadBlocker`

当前不能下载的原因，与 `portal.orderItem.downloadUrls` 此刻会返回的错误一致，页面据此出提示（如“下载授权已过期，请在小程序重新生成”“文件暂不可用”）。契约里是以 `kind` 为判别字段的联合（C37：取值小写蛇形，两个原因枚举都标 `x-open-enum`）：

```
DownloadBlocker =
  | { kind: 'grant_invalid', reason: DownloadGrantInvalidReason }
  | { kind: 'not_available', reason: DownloadUnavailableReason }
```

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `kind` | enum(`DownloadBlockerKind`) | 是 | `grant_invalid` 对应签发接口返回的 `DOWNLOAD_GRANT_INVALID`，`not_available` 对应 `DOWNLOAD_NOT_AVAILABLE`（两码由 m05-delivery-publish 定义），一一对应 | 计算 |
| `reason` | enum(`DownloadGrantInvalidReason`) 或 enum(`DownloadUnavailableReason`) | 是 | `kind = grant_invalid` 时取前者，`kind = not_available` 时取后者（第 4 节；与两码 `details.reason` 同一枚举） | 计算，规则见 3.8 的守卫 |

### 2.2 票据与会话

#### `PortalTicketCreated`（`portal.portalTicket.create`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `portalTicketId` | string(uuid) | 是 | 票据 id；轮询与换会话放路径（A3、A4） | `portal_ticket.id` |
| `qrUrl` | string | 是 | 二维码内容：`https://portal.<域名>/a?t=<publicId>`（d7-platform.md:1203）；小程序 `wx.scanCode` 读出后取 `t` 调 `m.portalTicket.lookup` | 由 `portal_ticket.public_id` 拼成；`public_id` 只出现在这里与 lookup 的查询参数里 |
| `shortCode` | string | 是 | 8 位 Crockford Base32 短码，页面显示为 `XXXX-XXXX`，供“扫不出来？在小程序里输入代码” | `portal_ticket.short_code` |
| `pairDigits` | string | 是 | 两位配对数字（如 `"07"`），显示在二维码旁 | `portal_ticket.pair_digits` |
| `pollSecret` | string | 是 | 32 字节随机数的 base64url（43 个字符）。只在本响应出现一次，页面只存在内存里，轮询放请求头、换会话放请求体 | 生成；库里只存 `sha256` 到 `portal_ticket.poll_secret_hash` |
| `expiresAt` | string(date-time) | 是 | 票据到期时刻（默认创建后 120 秒），页面倒计时 | `portal_ticket.expires_at` |
| `pollIntervalMs` | integer | 是 | 建议轮询间隔，恒为 2000 | 常量（d7-platform.md:1204） |

#### `PortalTicketStatusView`（`portal.portalTicket.get`）

只返回状态，不返回任何身份信息（d7-platform.md:1254）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `portalTicketId` | string(uuid) | 是 | 票据 id | `portal_ticket.id` |
| `status` | enum(`PortalTicketPollStatus`) | 是 | `pending` 待确认、`approved` 已确认（立即换会话）、`rejected` 已作废、`expired` 已过期、`consumed` 已换取会话 | `portal_ticket.status`；`pending` 且当前不早于 `portal_ticket.expires_at` 记为 `expired`；`approved` 且当前晚于 `portal_ticket.approved_at` + 60 秒也记为 `expired`（换会话窗口已过，02-identity-tenant.md:906） |
| `expiresAt` | string(date-time) | 是 | 票据到期时刻 | `portal_ticket.expires_at` |

#### `PortalTicketExchangeResult`（`portal.portalTicket.exchange`）

换会话的结果。票据被本次请求作废（密钥不符、超过 60 秒等）也要提交落库，所以按 C24、C50 与 A101 的同一做法返回 200、在 `status` 里表达，不用错误码（错误会让事务回滚，票据就作废不了）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `status` | enum(`PortalTicketExchangeStatus`) | 是 | `consumed` 已换出会话（同时下发 Cookie）；`rejected` 本次请求使票据作废（不下发 Cookie），页面提示“请刷新二维码后重新扫码” | 迁移后的 `portal_ticket.status` |
| `session` | `PortalSessionView` \| null | 是 | `consumed` 时为新建的会话；`rejected` 为空 | 新建的 `portal_session` |
| `rejectReason` | enum(`PortalTicketExchangeRejectReason`) \| null | 是 | `rejected` 时：`secret_mismatch` 密钥不符、`attempts_exceeded` 尝试次数已达上限、`window_passed` 确认后已超过 60 秒；`consumed` 为空 | 计算（不落库，数据模型没有原因列） |

#### `PortalSessionView`（`portal.session.current.get`；`PortalTicketExchangeResult.session`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `portalSessionId` | string(uuid) | 是 | 会话 id（老板在小程序“已授权的电脑”里撤销用同一个 id） | `portal_session.id` |
| `storeId` | string(uuid) | 是 | 授权的门店 | `portal_session.store_id` |
| `storeName` | string \| null | 是 | 门店名称（页头“XX 火锅（万达店）”） | `store.name` |
| `isStoreArchived` | boolean | 是 | 门店已停用（仍可下载） | `store.lifecycle = archived` |
| `entityId` | string(uuid) | 是 | 授权的主体 | `portal_session.entity_id` |
| `entityName` | string \| null | 是 | 主体名称；未认证的主体可能为空 | `entity.name` |
| `authorizerPhoneMask` | string \| null | 是 | 授权老板的手机号脱敏串（“由 138****5678 授权”） | `portal_session.approved_by_user_id` → `merchant_user.phone_mask` |
| `grantScope` | enum(`store`) | 是 | 授权范围，V1.0 只有整店 | `portal_session.grant_scope` |
| `capabilities` | array<string> | 是 | 本会话可用的能力点：`delivery.download`、`sample.view`、`ad.view` | 常量（按 `grant_scope`） |
| `authorizedAt` | string(date-time) | 是 | 授权（换会话）时间 | `portal_session.created_at` |
| `expiresAt` | string(date-time) | 是 | 到期时刻（授权起 2 小时，不滑动） | `portal_session.expires_at` |
| `serverTime` | string(date-time) | 是 | 服务端当前时刻，页面据此校正倒计时 | 服务端时钟 |

### 2.3 成片与下载

#### `PortalOrderItemCard`（`portal.orderItem.list` 的元素）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderItemId` | string(uuid) | 是 | 订购项 id | `order_item.id` |
| `orderId` | string(uuid) | 是 | 订购单 id | `order_item.drama_order_id` |
| `orderNo` | string | 是 | 订单号（“订单 LYX…”） | `drama_order.order_no` |
| `dramaTitle` | string | 是 | 剧名 | `order_item.drama_snapshot.title` |
| `poster` | `SignedUrl` \| null | 是 | 剧目封面（30 分钟对齐窗口，不留痕） | `order_item.drama_snapshot.posterFileId` 现签 |
| `episodeCount` | integer | 是 | 集数 | `order_item.episode_count` |
| `phase` | enum(`OrderItemPhase`) | 是 | 订购项阶段 | `order_item.phase` |
| `usageEndDate` | string(date) | 是 | 可使用至 | `order_item.usage_end_date` |
| `release` | `PortalReleaseBrief` \| null | 是 | 生效中的成片包；只有待预览样片、尚未交付的为空 | `delivery_release`（`order_item_id` = 本项、`state = pushed`、`variant = common`） |
| `grant` | `PortalGrantView` \| null | 是 | 该成片包对本主体的下载授权；没有为空 | 见 `PortalGrantView` |
| `isDownloadable` | boolean | 是 | 此刻能否签发下载地址（3.8 的守卫 1–4） | 计算 |
| `downloadBlocker` | `DownloadBlocker` \| null | 是 | 不能下载的原因；能下载时为空 | 计算 |
| `pendingSample` | `PendingSampleBrief` \| null | 是 | 有待确认、可在电脑上预览的样片时给出（条件见下）；工单已终止的不给 | 见 `PendingSampleBrief` |
| `activityAt` | string(date-time) | 是 | 排序键：成片包推送时间与待确认样片推送时间的较晚者 | `delivery_release.pushed_at`、`sample.pushed_at` 取大 |

#### `PortalReleaseBrief`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `deliveryReleaseId` | string(uuid) | 是 | 成片包 id | `delivery_release.id` |
| `releaseNo` | integer | 是 | 推送序号（“第 2 次推送”） | `delivery_release.release_no` |
| `kind` | enum(`initial`,`reissue`) | 是 | 首次推送、补发 | `delivery_release.kind` |
| `pushedAt` | string(date-time) | 是 | 推送时间 | `delivery_release.pushed_at` |
| `episodeCount` | integer | 是 | 文件数（等于集数） | `delivery_release.episode_count` |
| `totalBytes` | string(bigint) | 是 | 总大小（“约 2.6 GB”） | `delivery_release.total_bytes`（C33） |
| `changedEpisodeNos` | array<integer> | 是 | 相对上一包变更的集号（“有变更的集”）；首次推送为 `[]` | `delivery_release.changed_episode_nos` |

#### `PortalGrantView`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `state` | enum(`active`,`superseded`,`revoked`) | 是 | 技术状态 | `download_grant.state` |
| `expiresAt` | string(date-time) | 是 | 授权到期时刻（“授权到期 10-09 15:20”） | `download_grant.expires_at` |
| `isExpired` | boolean | 是 | 已过期（不设状态，按时间判定） | 当前不早于 `download_grant.expires_at` |

取法：`download_grant` 中 `delivery_release_id` = 该成片包、`grantee_type = entity`、`grantee_id = portal_session.entity_id`；有 `active` 的取它，否则取 `created_at` 最大的一行（同 m05 的 `ReleaseView.grant`）。

#### `PendingSampleBrief`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `sampleId` | string(uuid) | 是 | 样片版本 id（预览签发用） | `sample.id` |
| `versionNo` | integer | 是 | 版本号（“第 2 版样片待确认”） | `sample.version_no` |
| `pushedAt` | string(date-time) | 是 | 推送时间 | `sample.pushed_at` |
| `isPreviewReady` | boolean | 是 | 水印版已就绪，可以播放 | `playable_asset`（`kind = sample`、`source_file_id = sample.file_id`）的 `state = ready` |

条件（同时满足）：

1. 订购项的交付工单在样片确认步：`delivery_ticket.step = sample_confirm`。已终止的工单（`step = terminated`）不算：取消执行把工单置 `terminated` 时不动样片行（10-delivery.md:191 第 19 行；样片状态机没有随工单终止的迁移，10-delivery.md:638-649），样片会一直停在 `pushed`，不排除就会把已取消订单的样片列成“待确认”，而小程序确认必然失败。
2. 当前推送版本（`delivery_ticket.current_sample_version_no`）对应的 `sample` 行 `status = pushed`（`delivery.I7`）。
3. 该版本可在电脑上预览：`preview_channels` 含 `portal`（10-delivery.md:562），或属于开关兜底（1.1；只有 `weapp` 或 `weapp`、`wecom`，而 `weapp.video.sample.enabled` 此刻为关，m05-delivery-publish 3.8）。

#### `PortalReleaseView`（`portal.orderItem.release.get`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderItemId` | string(uuid) | 是 | 订购项 | `delivery_release.order_item_id` |
| `orderNo` | string | 是 | 订单号 | `drama_order.order_no` |
| `dramaTitle` | string | 是 | 剧名 | `order_item.drama_snapshot.title` |
| `usageEndDate` | string(date) | 是 | 可使用至 | `order_item.usage_end_date` |
| `deliveryReleaseId` | string(uuid) | 是 | 成片包 id；页面本地记录“已下载的集”时以它为键 | `delivery_release.id` |
| `releaseNo` | integer | 是 | 推送序号 | `delivery_release.release_no` |
| `kind` | enum(`initial`,`reissue`) | 是 | 首次推送、补发 | `delivery_release.kind` |
| `state` | enum(`pushed`,`superseded`,`closed`) | 是 | 生效中、已被取代、已关闭 | `delivery_release.state` |
| `closeReason` | enum(`cancelled`,`usage_ended`) \| null | 是 | 关闭原因 | `delivery_release.close_reason` |
| `reissueReason` | object \| null | 是 | 补发原因 `{ code, name }`（“本次补发：错别字”）；首次推送为空 | `delivery_release.reason_code`；名称取 `dict_item.name`（`dict_item.dict_type_key = reissue_reason`，停用项照常显示） |
| `pushedAt` | string(date-time) | 是 | 推送时间 | `delivery_release.pushed_at` |
| `episodeCount` | integer | 是 | 文件数 | `delivery_release.episode_count` |
| `totalBytes` | string(bigint) | 是 | 总大小 | `delivery_release.total_bytes` |
| `changedEpisodeNos` | array<integer> | 是 | 相对上一包变更的集号 | `delivery_release.changed_episode_nos` |
| `episodes` | array<`PortalReleaseEpisode`> | 是 | 逐集清单，集号 1..N | `delivery_release.manifest_snapshot`（不可变快照） |
| `grant` | `PortalGrantView` \| null | 是 | 下载授权 | 同 2.3 |
| `isDownloadable` | boolean | 是 | 此刻能否签发（3.8 的守卫 1–4） | 计算 |
| `downloadBlocker` | `DownloadBlocker` \| null | 是 | 不能下载的原因 | 计算 |
| `zipFileName` | string | 是 | 打包下载的文件名（`{安全剧名}_全{N}集.zip`），页面在按钮上显示 | 计算（规则同 10-delivery.md:888 传给打包任务的 `zipFileName`） |
| `hasPublishList` | boolean | 是 | 有发布清单（复制入口与“下载清单文件”按钮据此显示；按钮的取法见 3.9） | `delivery_release.publish_list_text` 非空 |

#### `PortalReleaseEpisode`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `episodeNo` | integer | 是 | 集号 | `manifest_snapshot[].episodeNo` |
| `fileName` | string | 是 | 文件名（`剧名_第NN集.mp4`） | `manifest_snapshot[].name` |
| `sizeBytes` | string(bigint) | 是 | 文件大小 | `manifest_snapshot[].size` |
| `isChanged` | boolean | 是 | 本包相对上一包变更了这一集 | 集号在 `delivery_release.changed_episode_nos` 内 |
| `lastPortalDownloadAt` | string(date-time) \| null | 是 | 本成片包这一集最近一次在下载页签发地址的时间（“已下载”提示；签发不等于下载完成） | `delivery_download_log.created_at` 的最大值（同一 `delivery_release_id`、`episode_no`，`kind = episode`、`client = portal`） |

#### `PortalDownloadResult`（`portal.orderItem.downloadUrls`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `kind` | enum(`episode`,`zip`,`publish_list`) | 是 | 请求的内容 | 请求体 |
| `state` | enum(`ZipBuildState`) | 是 | `ready` 已签发；`building` 打包中（`kind = zip` 时按 `pollAfterSec` 用同一请求再取）；`failed` 打包失败（页面显示“重试”，带 `retry: true` 再调；逐集下载照常可用）；`none` 尚未打包（只在 `kind = publish_list` 出现：只查不建，本次不触发打包）。`kind = episode` 恒为 `ready`；`kind = publish_list` 不是 `ready` 时页面改用 3.9 的 `text` 在浏览器里生成文件 | `kind` 为 `zip`、`publish_list` 时取 `media.ensureZip` 返回的 `zipState`（`publish_list` 用只查不建选项，没有 `zip_bundle` 行时记 `none`） |
| `downloadId` | string(uuid) \| null | 是 | 下载记录 id；`ready` 时有 | `delivery_download_log.id` |
| `episodeNo` | integer \| null | 是 | 集号；`kind = episode` 时有 | 请求体 |
| `url` | string \| null | 是 | 直链：单集 15 分钟、ZIP 3 小时、发布清单文件 15 分钟；`response-content-disposition` 指定中文文件名 | 现签：单集取清单里该集的 `fileId`；ZIP、发布清单取 `ensureZip` 返回的 `zipFileId`、`publishListFileId` |
| `expiresAt` | string(date-time) \| null | 是 | 直链到期时刻 | C61 |
| `fileName` | string \| null | 是 | 下载文件名 | 单集 `manifest_snapshot[].name`；ZIP `{安全剧名}_全{N}集.zip`；发布清单 `{安全剧名}_发布清单.txt`（本稿补充） |
| `sizeBytes` | string(bigint) \| null | 是 | 文件大小 | 单集 `manifest_snapshot[].size`；ZIP 与发布清单取 `file_object.size_bytes` |
| `pollAfterSec` | integer \| null | 是 | `kind = zip` 且 `building` 时的建议轮询间隔，恒为 5；其余为空 | 常量（本稿补充） |

`PublishListView`（`portal.orderItem.publishList.get`）：与小程序 `m.orderItem.publishList.get` 同一个契约 schema，字段与来源见 m05-delivery-publish 2.5，不复述（合集名称、封面、话题、简介、AI 声明、逐集 `{ episodeNo, title, topics, intro, isUpdated }` 与整份文本 `text`）。

### 2.4 样片与广告预览

#### `PortalSampleView`（`portal.orderItem.sample.get`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `sampleId` | string(uuid) | 是 | 样片版本 id（签发播放地址按它） | `sample.id` |
| `orderItemId` | string(uuid) | 是 | 订购项 | 路径参数 |
| `orderNo` | string | 是 | 订单号 | `drama_order.order_no` |
| `dramaTitle` | string | 是 | 剧名 | `order_item.drama_snapshot.title` |
| `versionNo` | integer | 是 | 版本号（“第 N 版样片”） | `sample.version_no` |
| `status` | enum(`SampleStatus`) | 是 | 商家能看到的是 `pushed` 待确认、`confirmed`、`change_requested`、`superseded` | `sample.status` |
| `pushedAt` | string(date-time) | 是 | 推送时间 | `sample.pushed_at` |
| `durationMs` | integer | 是 | 时长（推送过的版本必有） | `sample.duration_ms` |
| `previewChannels` | array<enum(`PreviewChannel`)> | 是 | 推送时确定的查看方式 | `sample.preview_channels` |
| `adSlots` | array<`SampleAdSlot`> | 是 | 广告位标记，播放器进度条上画区间 | `sample.ad_slots`（`SampleAdSlots`，10-delivery.md 第 4 节） |
| `poster` | `SignedUrl` \| null | 是 | 海报（封面帧，30 分钟对齐窗口，不留痕）；水印版与体检抽帧都还没有时为空 | 取法同 m06-ad 2.8 `Playable.posterUrl`：样片可播放资产的 `playable_asset.cover_file_id` 非空时取它，否则取样片文件的体检抽帧 `media_info.cover_file_id`（`media_info.file_id = sample.file_id`），现签 |
| `isPortalPreviewable` | boolean | 是 | 现在能在电脑上播放：订购项未关闭（工单不是 `terminated`，`order_item.phase` 不在 `cancelled`、`refunded`、`terminated`）、状态在 `pushed` / `confirmed` / `change_requested` 内、`previewChannels` 含 `portal` 或属于开关兜底（1.1）、水印版就绪 | 计算（与 3.11 的守卫一致） |
| `previewBlocker` | enum(`SamplePreviewBlocker`) \| null | 是 | 不能播放的原因，按此顺序取第一个：`order_closed` 订购项已取消、退回或终止；`superseded` 已被取代；`channel_not_offered` 只能在小程序内播放；`not_ready` 水印版未就绪。能播放时为空 | 计算 |
| `firstViewedAt` | string(date-time) \| null | 是 | 首次经相册保存或下载页预览访问的时间 | `sample.first_viewed_at` |
| `lastPortalViewAt` | string(date-time) \| null | 是 | 最近一次在下载页签发播放地址的时间（“您已在电脑上看过这一版”） | `audit_log.created_at` 的最大值（`stream = access`、`action = delivery.sample.portal_preview`、`target_type = sample`、`target_id` = 本版；与 m05 3.9 核对证据的条件相同） |
| `decidedAt` | string(date-time) \| null | 是 | 商家已确认或提出修改的时间；为空即“请回到小程序确认或提出修改意见” | `sample.decided_at` |

#### `SampleAdSlot`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `slot` | enum(`opening`,`ending`) | 是 | 片头贴片、片尾贴片 | `sample.ad_slots[].slot` |
| `startMs` | integer | 是 | 起点（毫秒） | `sample.ad_slots[].startMs` |
| `endMs` | integer | 是 | 终点（毫秒） | `sample.ad_slots[].endMs` |
| `label` | string | 是 | 说明（如“品牌露出”） | `sample.ad_slots[].label` |

#### `PortalAdCard`（`portal.ad.list` 的元素）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `adId` | string(uuid) | 是 | 广告 id | `ad.id` |
| `adNo` | string | 是 | 广告编号（GG…） | `ad.ad_no` |
| `type` | enum(`AdType`) | 是 | 植入形式 | `ad.type` |
| `durationSec` | integer | 是 | 时长（秒） | `ad.duration_sec` |
| `status` | enum(`AdStatus`) | 是 | 广告状态 | `ad.status` |
| `displayStatus` | enum(`AdDisplayStatus`) | 是 | 商家端显示状态（映射同 m06-ad 第 4 节） | 由 `ad.status` 推出 |
| `copy` | string \| null | 是 | 广告文案 | `ad.copy` |
| `currentVersionNo` | integer | 是 | 当前版本 = 已推送的最大版本号 | `ad_version.version_no`（`pushed_at` 非空的最大值） |
| `currentVersionPushedAt` | string(date-time) | 是 | 当前版本推送时间 | 当前版本的 `ad_version.pushed_at` |
| `currentPreviewChannels` | array<enum(`PreviewChannel`)> | 是 | 当前版本的查看方式 | 当前版本的 `ad_version.preview_channels` |
| `confirmedVersionNo` | integer \| null | 是 | 已确认的版本号 | `ad.confirmed_version_no` |
| `poster` | `SignedUrl` \| null | 是 | 当前版本的封面帧（30 分钟对齐窗口，不留痕）；尚未抽帧时为空 | 同 m06-ad 2.1 `coverUrl`：广告可播放资产（`kind = ad`、`source_file_id` = 当前版本的 `ad_version.file_id`）的 `playable_asset.cover_file_id` 非空时取它，否则取当前版本文件的体检抽帧 `media_info.cover_file_id`（`media_info.file_id = ad_version.file_id`；广告不转码，封面来自体检抽帧），现签 |
| `isPortalPreviewable` | boolean | 是 | 现在能在电脑上播放：广告未取消、当前版本含 `portal` 或属于开关兜底（1.1；m06-ad 2.9）、资产就绪 | 计算（与 3.14 的守卫一致） |

#### `PortalAdDetail`（`portal.ad.get`）

包含 `PortalAdCard` 的全部字段，另加：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `currentVersion` | `PortalAdVersionView` | 是 | 当前版本的元数据（播放地址另行签发） | 当前版本的 `ad_version` 行 |

`PortalAdVersionView`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `versionNo` | integer | 是 | 版本号 | `ad_version.version_no` |
| `pushedAt` | string(date-time) | 是 | 推送时间 | `ad_version.pushed_at` |
| `durationMs` | integer | 是 | 时长 | `ad_version.duration_ms` |
| `width` | integer | 是 | 宽（像素） | `ad_version.width` |
| `height` | integer | 是 | 高（像素） | `ad_version.height` |
| `segments` | array<`AdSegment`> | 是 | 预置分段 `[{ index, fromMs, toMs, label }]`（结构同 m06-ad 2.6）；未填为 `[]` | `ad_version.segments` |
| `previewChannels` | array<enum(`PreviewChannel`)> | 是 | 查看方式 | `ad_version.preview_channels` |
| `decision` | enum(`confirmed`,`revision_requested`,`superseded`) \| null | 是 | 商家对这一版的决定；为空即“请回到小程序确认或提出修改意见” | `ad_version.decision` |
| `decidedAt` | string(date-time) \| null | 是 | 决定时间 | `ad_version.decided_at` |

`Playable`（`portal.sample.playbackUrls`、`portal.ad.playbackUrls` 的响应）：引用 m06-ad 2.8 的 `Playable` / `PlayableSource`（全仓唯一定义，m05-delivery-publish 的样片页也引用它，`{ playableId, kind, durationMs, width, height, posterUrl, sources: [{ quality, url, width, height, bitrateKbps }], expiresAt, autoplay, muted }`，来源 `playable_asset`），不复述。下载页上 `sources` 恒非空、`autoplay` 与 `muted` 恒为 `false`（design-spec.md:862：点击后才播放）。

### 2.5 授权书验真

#### `LicenseVerificationView`（`portal.licenseVerification.get`）

内容字段都取**当前已出件版次**的 `letter_snapshot`（与对方手里最新一版 PDF 一致）；状态取信件行的现状。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `letterNo` | string | 是 | 授权书编号（`SQ…-1-DY`） | `license_letter.letter_no` |
| `displayStatus` | enum(`LicenseLetterDisplayStatus`) | 是 | 显示状态：待生效、生效中、已失效、已作废。与 m05-delivery-publish `LicenseLetterCard.displayStatus` 同名同义；本接口不返回落库状态 | `license_letter.status`；`effective` 且 `license_letter.period_end` 早于今天（北京时间）记为 `expired`（13-notify-docs.md:902） |
| `voidedAt` | string(date-time) \| null | 是 | 作废时间（作废原因不对外显示） | `license_letter.voided_at` |
| `platform` | enum(`douyin`,`wechat_channels`) | 是 | 授权平台 | `license_letter.platform` |
| `licensorName` | string | 是 | 授权方（平台运营主体） | `letter_snapshot.licensor.name` |
| `licenseeNameMask` | string | 是 | 被授权方名称（脱敏：保留前 2 个字与后 4 个字，中间每个字替换为 `*`，不足 7 个字只留首字；A100，待法务确认，第 6 节第 2 项） | `letter_snapshot.licensee.name` 脱敏 |
| `licenseeCreditCodeMask` | string | 是 | 被授权方统一社会信用代码（留前 12 位与末 2 位，design-spec.md 脱敏表） | `letter_snapshot.licensee.creditCode` 脱敏 |
| `dramaName` | string | 是 | 剧名 | `letter_snapshot.drama.name` |
| `episodes` | integer | 是 | 集数 | `letter_snapshot.drama.episodes` |
| `account` | object | 是 | 授权账号 `{ platform, name, accountId }`（抖音号或视频号 ID，商家公开信息） | `letter_snapshot.account` |
| `period` | `LicensePeriod` | 是 | 授权期限与地域 | `letter_snapshot.period` |
| `consent` | `LicenseConsent` | 是 | 订购时的协议同意记录（快照里必有，13-notify-docs.md 第 4 节） | `letter_snapshot.consent` |
| `currentRevision` | `LicenseRevisionProof` | 是 | 当前已出件版次的核对要素 | `license_letter.current_revision_id` → `license_letter_revision` |
| `hasPendingRevision` | boolean | 是 | 有更新的版次正在生成（“新版本生成中”） | 存在 `rev_no` 大于当前版次、`render_status` ∈ {`queued`,`rendering`} 的版次 |
| `revisions` | array<`LicenseRevisionBrief`> | 是 | 全部已出件版次，按版次号倒序；核对人用 PDF 页脚印的内容指纹在这里找到对应版次，不是当前版次即提示“已有更新版本”（d6-notify-docs-data.md:1386） | `license_letter_revision`（`render_status = ready`） |
| `requestedRevNo` | integer \| null | 是 | 请求带了 `revNo` 时原样返回；没带为空 | 查询参数 |
| `requestedRevisionState` | enum(`RequestedRevisionState`) | 是 | 扫的那一版与当前版次的关系：`not_requested` 没带 `revNo`；`current` 就是当前版次；`outdated` 是已出件的旧版次（页面提示“已有更新版本”）；`not_found` 带了但不是任何已出件的版次。用枚举而不用可空布尔（C39） | 计算：`requestedRevNo` 与 `currentRevision.revNo`、`revisions[].revNo` 比较 |
| `checkedAt` | string(date-time) | 是 | 核对时刻 | 服务端时钟 |

#### `LicensePeriod`

授权期限与地域。与 m05-delivery-publish `LicenseLetterPreview.period` 共用这一份结构（字段名按 C15 的 `…Date` 后缀）。按 A150、C87 归属本文，m05 已改为引用。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `startDate` | string(date) \| null | 是 | 起始日；未上线为空 | `letter_snapshot.period.start` |
| `startText` | string | 是 | 起始日的文字（未上线为“自上线首日起”） | `letter_snapshot.period.startText` |
| `endDate` | string(date) | 是 | 止日 | `letter_snapshot.period.end` |
| `territory` | string | 是 | 授权地域 | `letter_snapshot.period.territory` |

#### `LicenseConsent`

订购时《定制内容授权使用协议》的同意记录。与 m05-delivery-publish `LicenseLetterPreview.consent` 共用，归属本文（同上，A150、C87）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `consentNo` | string | 是 | 同意记录编号 | `letter_snapshot.consent.consentNo` |
| `agreementName` | string | 是 | 协议名与版本 | `letter_snapshot.consent.agreement` |
| `consentedAt` | string(date-time) | 是 | 同意时间 | `letter_snapshot.consent.at` |
| `operatorMask` | string | 是 | 经办人，快照里已脱敏（如“王*（138****5678）”） | `letter_snapshot.consent.by` |

#### `LicenseRevisionProof`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `revNo` | integer | 是 | 版次（“第 N 版”） | `license_letter_revision.rev_no` |
| `reason` | enum(`LicenseRevisionReason`) | 是 | 出版原因 | `license_letter_revision.reason` |
| `contentFp` | string | 是 | 内容指纹（印在 PDF 页脚，64 位十六进制） | `license_letter_revision.content_fp` |
| `pdfSha256` | string | 是 | 当前版文件的 SHA-256（只在验真页展示） | `license_letter_revision.pdf_sha256` |
| `signMode` | enum(`SignMode`) | 是 | 签署方式；`stamp` 时页面如实标注“印章图样（无数字签名）”（d6-notify-docs-data.md:1381） | `license_letter_revision.sign_mode` |
| `certSerial` | string \| null | 是 | 数字证书序列号；`stamp` 为空 | `license_letter_revision.cert_serial` |
| `certIssuer` | string \| null | 是 | 证书颁发机构 | `license_letter_revision.cert_issuer` |
| `platformSignedAt` | string(date-time) | 是 | 平台签署时间 | `license_letter_revision.platform_signed_at` |
| `issuedAt` | string(date-time) | 是 | 出件时间 | `license_letter_revision.ready_at` |

#### `LicenseRevisionBrief`

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `revNo` | integer | 是 | 版次 | `license_letter_revision.rev_no` |
| `reason` | enum(`LicenseRevisionReason`) | 是 | 出版原因 | `license_letter_revision.reason` |
| `contentFp` | string | 是 | 内容指纹 | `license_letter_revision.content_fp` |
| `pdfSha256` | string | 是 | 文件 SHA-256 | `license_letter_revision.pdf_sha256` |
| `issuedAt` | string(date-time) | 是 | 出件时间 | `license_letter_revision.ready_at` |
| `isCurrent` | boolean | 是 | 是当前版次 | `license_letter_revision.id = license_letter.current_revision_id` |

## 3. 接口

### 3.1 portal.portalTicket.create　建扫码登录票据

`POST /portal/portal-tickets`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `public`；必须带 `X-LYX-Portal: 1` 且 `Origin` 等于下载页源（C17） |
| 幂等 | none（匿名建下载页票据，A18、C47 点名）：没有会话、幂等记录没有 `actor_key`；重复创建只多一张 120 秒的短时票据 |
| 乐观锁 | 无 |
| 限流 | `portal.ticket`：每 IP 每分钟 10 张（C68；d4-identity.md:1780） |
| 开关 | 无 |
| 对应画板 | 原型无：① 扫码登录页 |
| 出处 | 路线图 `p01.tickets.create`；d7-platform.md:1201-1203、1241、1253、1270；d4-identity.md:2278；02-identity-tenant.md:868、902、919；C5 |

**请求**：路径参数无；查询参数无；请求体无（空对象）。服务端从请求取 IP（按可信代理跳数，C68）与 `User-Agent`。

**响应**：`PortalTicketCreated`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `RATE_LIMITED` | 429 | 同一 IP 每分钟超过 10 张；页面按 `Retry-After` 退避后再申请 |
| `ORIGIN_REJECTED` | 403 | 缺 `X-LYX-Portal` 或 `Origin` 不符 |

**副作用**：插入 `portal_ticket`：`portal_ticket.status`：— → `pending`（02-identity-tenant.md:902）；写 `public_id`（16 字节随机数的 base64url）、`short_code`（8 位 Crockford Base32，在 `pending` 的票据里唯一，冲突时重新生成）、`poll_secret_hash` = `sha256(pollSecret)`、`pair_digits`（00–99 随机）、`expires_at` = 当前 + `PORTAL_TICKET_TTL`（部署配置，默认 120 秒）、`ip`、`user_agent`（截到 512 字符，缺失写空串）、`exchange_attempts = 0`。技术状态，不写 `status_transition`、不写审计、不发出站事件。

**说明**：
- 二维码是普通二维码，内容为 `qrUrl`，由小程序 `wx.scanCode` 读取，不调微信小程序码接口（d7-platform.md:1193；R5）；d4-identity.md:482、521 的“小程序码、5 分钟过期”不采用。有人用微信“扫一扫”扫到时打开 `/a` 落地页，提示“请打开狸有戏小程序 › 发布任务 › 下载 › 扫码在电脑上下载”，该页只调错误上报。
- 页面倒计时到 `expiresAt` 后自动申请新票据；连续 10 次后改为“点击刷新”（d7-platform.md:1245）。
- `pollSecret` 不进本地存储、不进地址栏；刷新页面即作废，重新申请票据。
- 只做扫码，不做提取码入口（R5；d4-identity.md:2279 的 `POST /portal/links/{token}/verify` 删除）。d5-media.md:2119 的 `POST /portal/login-tickets` 合并为本接口。

### 3.2 portal.portalTicket.get　轮询票据状态

`GET /portal/portal-tickets/{portalTicketId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `public`；请求头 `X-Poll-Secret` 必带 |
| 幂等 | none（纯查询，A18） |
| 乐观锁 | 无 |
| 限流 | `portal.ticket`：每票据每分钟 60 次（C68；d4-identity.md:1781） |
| 开关 | 无 |
| 对应画板 | 原型无：① 扫码登录页 |
| 出处 | 路线图 `p01.tickets.get`；d7-platform.md:1204-1206、1254；02-identity-tenant.md:861、865；C5、C17 |

**请求**（请求头的 schema：`PortalTicketPollHeader`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `portalTicketId` | string(uuid) | 是 | — | 票据 id（`portal_ticket.id`；A3、A4：不用 `public_id`） |
| 请求头 | `X-Poll-Secret` | string | 是 | 43 个 base64url 字符 | 建票据时拿到的 `pollSecret`；常量时间比较 `sha256(值)` 与 `portal_ticket.poll_secret_hash` |

**响应**：`PortalTicketStatusView`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 票据不存在（含 7 天后已清理），或 `X-Poll-Secret` 与票据不符（两者不区分，不透露票据是否存在） |
| `VALIDATION_FAILED` | 400 | 缺 `X-Poll-Secret` 或格式不对 |

**副作用**：无（GET 不写库：“已过期”按 `expires_at` 判定后返回，不落状态，02-identity-tenant.md:865）。

**说明**：页面每 2 秒轮询一次（d7-platform.md:1204）。`approved` 后立即调 3.3 换会话；`rejected`（配对数字不一致、老板点了拒绝、换会话失败）提示“请在电脑上刷新二维码后重试”（d7-platform.md:1243）；`expired` 自动申请新票据。

### 3.3 portal.portalTicket.exchange　换取下载页会话

`POST /portal/portal-tickets/{portalTicketId}/exchange`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `public`；必须带 `X-LYX-Portal: 1` 且 `Origin` 等于下载页源 |
| 幂等 | none（登录与换会话，A18、C47 点名）：匿名请求没有 `actor_key`；票据状态守卫与 `uq_portal_session_portal_ticket_id` 保证一张票据只换出一个会话。原路线图写的 natural（状态守卫）按 A18 不采用 |
| 乐观锁 | 无（带原状态条件的单行 UPDATE） |
| 限流 | `portal.ticket`：每票据至多 5 次（C68；d4-identity.md:1782） |
| 开关 | 无 |
| 对应画板 | 原型无：① 扫码登录页（换会话成功后进入 ② 可下载清单） |
| 出处 | 路线图 `p01.tickets.exchange`；d7-platform.md:1213-1215、1246-1247、1255、1263；d4-identity.md:507、526-528、2278、2329；02-identity-tenant.md:248、261、287、906-909；rulings.md:135（M78）；A101；C24、C50；x01-events-jobs.md:684 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `portalTicketId` | string(uuid) | 是 | — | 票据 id |

请求体（`PortalTicketExchangeBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `pollSecret` | string | 是 | 43 个 base64url 字符 | 建票据时拿到的密钥；常量时间比较 |

**响应**：`PortalTicketExchangeResult`（HTTP 200）。
- `status = consumed`：`session` 为新会话；响应头 `Set-Cookie: __Host-lyx_portal=<32 字节随机数 base64url>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=7200`。页面进入 ② 可下载清单。
- `status = rejected`：本次请求使票据作废（`rejectReason`），不下发 Cookie。页面提示“请刷新二维码后重新扫码”。作废要落库，所以按 C24、C50 与 A101 的同一做法返回 200（返回错误码会让事务回滚，作废就不生效，密钥不符后还能继续试）；与 x01-events-jobs 非 HTTP 迁移归属表里这条迁移“随调用方事务”一致。

**错误**（只用于不写库的情形）

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `PORTAL_TICKET_INVALID` | 410 | 票据不存在（`details.reason = not_found`）；票据已是 `rejected`（`rejected`：老板拒绝、配对不一致，或此前已因换会话失败作废）或 `consumed`（`consumed`）；`pending` 已过 `expires_at`（`expired`）；`pending` 而密钥不符（`secret_mismatch`）。页面一律提示“请刷新二维码后重新扫码” |
| `STATE_NOT_ALLOWED` | 409 | 密钥相符但票据仍是 `pending`、未过期（老板尚未确认；页面应只在轮询到 `approved` 后调用） |
| `VALIDATION_FAILED` | 400 | `pollSecret` 缺失或格式不对 |

**副作用**：
- 换出会话（`status = consumed`，同一事务）：`portal_ticket.status`：`approved` → `consumed`（02-identity-tenant.md:906），同一条 UPDATE 写 `consumed_at`、`exchange_attempts + 1`；调 `identity.createPortalSession(tx, …)` 插入 `portal_session`：`token_hash` = `sha256(Cookie 随机数)`、`portal_ticket_id`、`approved_by_user_id`、`entity_id`、`store_id`（都取自票据）、`grant_scope = store`、`expires_at` = 当前 + 2 小时（不滑动，02-identity-tenant.md:261）、`ip`、`user_agent`（02-identity-tenant.md:909）。写 `auth_event`：`space = portal`、`method = ticket`、`event = login_success`、`subject_id` = 授权老板、`detail.sessionId`（02-identity-tenant.md:287）。`portal_session` 没有状态机，不写 `status_transition`；不发出站事件。
- 作废（`status = rejected`，同一事务，随 200 一起提交）：票据为 `approved`，但密钥不符、`exchange_attempts` 已达 5 或 `approved_at` 已超过 60 秒：`portal_ticket.status`：`approved` → `rejected`（02-identity-tenant.md:907），同一条 UPDATE 写 `exchange_attempts + 1`。另在独立事务写 `auth_event`（`event = login_fail`、`subject_id` = 授权老板、`detail.reason` = `rejectReason`；本稿补充，03 分组允许该取值，失败登录按 03-staff-authz-audit.md:672 不进业务事务）。
- 返回 410、409、400 时不写库（`pending` 而密钥不符也不改票据：数据模型只定义了从 `approved` 作废）。

**说明**：
- 守卫（02-identity-tenant.md:906-907）：`approved_at` 距今 ≤ 60 秒；`sha256(pollSecret)` 相符（常量时间比较）。核对顺序：① 票据存在，否则 410 `not_found`；② 已是 `rejected` / `consumed` → 410 对应原因（不核对密钥）；③ `pending`：密钥不符 → 410 `secret_mismatch`，已过期 → 410 `expired`，否则 409；④ `approved`：密钥不符 → 作废（`secret_mismatch`），`exchange_attempts` 已达 5 → 作废（`attempts_exceeded`），超过 60 秒 → 作废（`window_passed`），否则换出会话。
- 尝试次数：`approved` 票据第一次密钥不符即作废，所以 `attempts_exceeded` 只是数据模型“尝试超过 5 次”的兜底守卫；同一票据的重复尝试先由限流 `portal.ticket`（每票据 5 次）挡住。
- 会话范围是确认时的门店（`grant_scope = store`）。时长按数据模型“确认起 2 小时、不滑动”（A65）；d5-media.md:1644、d7-platform.md:1263 的“闲置 2 小时或确认起 12 小时”不采用（C5）。
- 授权人此刻是否仍是有效老板不在这里核对：之后每个请求由 `portalAuth` 校验（1.1）。
- d5-media.md:2119 的 `POST /portal/login-tickets/{id}/poll` 合并为本接口。

### 3.4 portal.session.current.get　当前会话

`GET /portal/sessions/current`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `portal`（会话本身，不另要能力点） |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `portal.global` |
| 开关 | 无 |
| 对应画板 | 原型无：②③④ 的页头（门店名、授权人、剩余时间）；⑤ 会话失效说明页（本接口 401 时进入） |
| 出处 | 路线图 `p01.session.get`（路径与 operationId 按 A41、A82 改写，C5、C14）；d4-identity.md:501、1784、2280；d5-media.md:2119；d7-platform.md:1270；02-identity-tenant.md:285、298、873；`resources.json`：`portal_session` 别名 `/portal/sessions/current` |

**请求**：无。

**响应**：`PortalSessionView`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `AUTH_REQUIRED` | 401 | 没有 Cookie |
| `PORTAL_SESSION_INVALID` | 401 | 会话不存在、已过期、已吊销，或授权人已不是该主体的有效老板（`details.reason`、`details.revokeReason`）；页面进入 ⑤ 会话失效说明页，再回扫码页 |

**副作用**：无。

**说明**：需要会话的页面加载时先调本接口；扫码登录页、`/a` 落地页、`/v` 验真页不调。“当前会话”是视图别名（A41 第四类，C10），operationId 按 C14 取 `portal.session.current.get`（它也是限流登记的键，发布后不改名）；原路线图的 `GET /portal/session`（旧名 portal.session.get）作废（A82）。

### 3.5 portal.session.current.delete　电脑端退出

`DELETE /portal/sessions/current`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `portal`；必须带 `X-LYX-Portal: 1` 且 `Origin` 等于下载页源（`DELETE` 也是非 GET，C17） |
| 幂等 | none（A43；C47 的 none 白名单登记了 `portal.session.current.delete`）：重复退出无副作用，端上把 401 当作已退出 |
| 乐观锁 | 无 |
| 限流 | `portal.global` |
| 开关 | 无 |
| 对应画板 | 原型无：②③④ 页头的“退出”（入口位置随下载页补稿定，05-risks-and-open-issues.md:271） |
| 出处 | 路线图 `p01.session.logout`（`POST /portal/session/logout` 按 A7、A43、A82 改为 `DELETE` 当前会话，C5、C12、C14）；d4-identity.md:507、510、2280；02-identity-tenant.md:265、287、293 |

**请求**：无（没有请求体）。

**响应**：`data = null`；响应头 `Set-Cookie: __Host-lyx_portal=; Max-Age=0; HttpOnly; Secure; SameSite=Strict; Path=/`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `AUTH_REQUIRED` / `PORTAL_SESSION_INVALID` | 401 | 没有 Cookie 或会话已失效；页面视同已退出，回扫码页（A43） |
| `ORIGIN_REJECTED` | 403 | 缺 `X-LYX-Portal` 或 `Origin` 不符 |

**副作用**（同一事务）：写 `portal_session.revoked_at` = 当前、`portal_session.revoke_reason = portal_logout`（02-identity-tenant.md:265、293；该列说明里的路径 `POST /portal/session/logout` 待数据模型回写为本接口），`updated_at`；写 `auth_event`（`space = portal`、`method = ticket`、`event = logout`、`subject_id` = 授权老板、`detail.sessionId`，02-identity-tenant.md:287）。`portal_session` 没有状态机，不写 `status_transition`，不发出站事件。

**说明**：老板在小程序“已授权的电脑”里撤销走 `m.portalSession.revoke`（m02-tenant，`revoke_reason = owner_revoked`）；电脑端下一次请求得到 401 `PORTAL_SESSION_INVALID`（`reason = revoked`、`revokeReason = owner_revoked`）。

### 3.6 portal.orderItem.list　可下载清单

`GET /portal/order-items`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `portal`；能力点 `delivery.download` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `portal.global` |
| 开关 | 无 |
| 对应画板 | 原型无：② 可下载清单 |
| 出处 | 路线图 `p01.order-items.list`；d7-platform.md:1270；d5-media.md:1549-1552、1645、1655、2119；10-delivery.md:562、854、1033-1038；PRD.md:597；A22、A23、A24；C42 |

**请求**（查询参数的 schema：`PortalOrderItemListQuery`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum(`PortalOrderItemTab`) | 否 | 缺省 `all` | `all`：有生效中成片包或有待预览样片的订购项；`downloadable`：有生效中成片包的；`sample_pending`：有待预览样片的 |
| 查询 | `cursor` | string | 否 | — | 游标 |
| 查询 | `limit` | integer | 否 | 1–50，缺省 20 | 每页条数 |

**响应**：`CursorPage<PortalOrderItemCard>`（契约名 `PortalOrderItemPage`）。范围：`order_item.store_id = portal_session.store_id`，且满足所选 `tab` 的条件（生效中成片包：`delivery_release.state = pushed`，走 `ix_delivery_release_store_id`；待预览样片：见 `PendingSampleBrief`）。排序 `activityAt` 倒序，`orderItemId` 兜底（C44）。不返回总数（C42）。

**错误**：无（`tab`、`limit` 取值非法时 400 `VALIDATION_FAILED`）。

**副作用**：无。

**说明**：
- 授权已过期的订购项照常列出，`downloadBlocker = { kind: grant_invalid, reason: expired }`，页面提示“下载授权已过期，请在小程序重新生成”：重新生成只在小程序 `m.orderItem.downloadGrant.create`（m05），下载页只读（d5-media.md:1645）。
- 成片包已关闭（订购项取消、退回或使用期结束归档）的订购项不在 `downloadable` 范围里；工单已终止的订购项也不会因残留的 `pushed` 样片进入 `sample_pending`（`PendingSampleBrief` 条件 1）。所以已取消、退回、终止的订购项不出现在清单里。套餐过期不影响下载（d5-media.md:1552）。
- 待确认的广告不挂在订购项上，由 `portal.ad.list` 单独列出；页面 ② 把两者分区展示（d7-platform.md:1270）。
- 尚未交付成片、只有样片待确认的订购项（工单在样片确认步）没有成片包，按 `tab = all` 一并列出（`release = null`），否则页面 ② 看不到它们；路线图切片已按此补 `tab` 与范围（第二轮）。

### 3.7 portal.orderItem.release.get　成片下载页数据

`GET /portal/order-items/{orderItemId}/release`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `portal`；能力点 `delivery.download` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `portal.global` |
| 开关 | 无 |
| 对应画板 | 原型无：③ 成片下载 |
| 出处 | 路线图 `p01.delivery.get`；d5-media.md:1584-1585、1605、2119；d7-platform.md:1270-1274；10-delivery.md:832-833、872；06-media.md:983；d4-identity.md:2281；A5、C10 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderItemId` | string(uuid) | 是 | 属会话门店 | 订购项（`delivery-releases` 在订购项下的单例别名，A5 第三类） |

**响应**：`PortalReleaseView`。取该订购项生效中的成片包（每个订购项每个变体至多一个，`uq_delivery_release_live`）；没有生效中的取推送序号最大的一行（可能已关闭，`isDownloadable` 为假）。

**错误**：无（从未推送过成片包、或订购项不属会话门店时 404 `NOT_FOUND`）。

**副作用**：无。

**说明**：
- 清单取不可变的 `manifest_snapshot`；补发后页面按 `changedEpisodeNos` 提示“有变更的集”（10-delivery.md:833；d5-media.md:1605），并建议只重下这些集。
- 本接口不读 `zip_bundle`（06-media.md:983）：打包状态只由 3.8 返回。页面不需要事先知道 ZIP 是否就绪：“打包下载”直接调 3.8 的 `kind = zip`；“下载清单文件”调 3.8 的 `kind = publish_list`（只查不建，不触发打包），不是 `ready` 时用 3.9 的 `text` 在浏览器里生成（见 3.9）。
- 页面上的逐集下载点击即调 3.8 取 15 分钟直链，浏览器直接下载（d7-platform.md:1271）；不做“全部下载到文件夹”（d7-platform.md:1273）。
- 路径按 A5 由 `…/delivery` 改为 `…/release`，与小程序 `m.orderItem.release.get` 同名；d4-identity.md:2281 的 `GET /portal/deliverables` 合并为本接口。

### 3.8 portal.orderItem.downloadUrls　签发下载直链

`POST /portal/order-items/{orderItemId}/download-urls`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `portal`；能力点 `delivery.download`；必须带 `X-LYX-Portal: 1` 且 `Origin` 等于下载页源 |
| 幂等 | none（签发短时地址，A18、C47、C60；附带的打包等技术状态变化不改变其 none，A51）：每次签发都是一次真实访问、都要留痕，结果不进幂等记录。ZIP 打包本身由 `zip_bundle.zip_gen` 与打包任务的 `dedupe_key` 去重（06-media.md:962-964） |
| 乐观锁 | 无 |
| 限流 | `portal.global` |
| 开关 | 无 |
| 对应画板 | 原型无：③ 成片下载（逐集“下载”、打包下载、发布清单“下载文件”） |
| 出处 | 路线图 `p01.downloads.create`（按 A19、C60 改为 `download-urls`）；d5-media.md:1542-1551、1574、1667-1684、1690、2119；d7-platform.md:1271-1274；10-delivery.md:888、1062-1075；06-media.md:958-983；design-spec.md:855；PRD.md:597、1012；A99、A125；C65 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderItemId` | string(uuid) | 是 | 属会话门店 | 订购项 |

请求体（`PortalDownloadBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `kind` | enum(`episode`,`zip`,`publish_list`) | 是 | 取值同数据模型 `delivery_download_log.kind` | 下载内容 |
| `episodeNo` | integer | `kind = episode` 时必填 | 1 ≤ 集号 ≤ 成片包集数；其余 `kind` 不得出现 | 集号（放请求体，不放路径，A3、C11） |
| `retry` | boolean | 否 | 缺省 `false`；只对 `kind = zip` 有意义，其余 `kind` 忽略 | A99：上次打包失败后由用户点“重试”时为 `true`，`failed` 才重新打包；为 `false` 时打包失败只返回 `state = failed`，不自动重打（页面轮询不会在失败后悄悄重打）。传给 `media.ensureZip` 的重建选项 `retry`（与 a06 `admin.deliveryRelease.pack` 同名同义） |

**响应**：`PortalDownloadResult`。
- `kind = episode`：`state = ready`，签 15 分钟直链。
- `kind = zip`：调 `media.ensureZip`（`retry` 原样传入）；`ready` 签 3 小时直链；`building` 返回打包中与 `pollAfterSec = 5`，页面以同一请求（`retry = false`）轮询（C65；d7-platform.md:1272），10 分钟仍未就绪时停止轮询并提示“打包耗时较长，可先逐集下载”（本稿补充）；`failed` 页面显示“打包失败 · 重试”，点重试带 `retry: true`。
- `kind = publish_list`：调 `media.ensureZip` 的只查不建选项 `peek: true`（发布清单文件随 ZIP 同代次生成，10-delivery.md:1071）：不建 `zip_bundle` 行、不升代次、不建打包任务，只返回当前状态。ZIP 就绪且有清单文件时签 15 分钟直链（A125）；否则返回 ZIP 的当前状态 `building` / `failed` / `none`（没有行记 `none`），不签发、不触发打包——为取一个文本文件去打数 GB 的整包没有意义（10-delivery.md:1071：“没有打包好时不签发文件，下载页直接展示 `publish_list_text`”）。页面拿到非 `ready` 时改用 3.9 的 `text` 在浏览器里生成文本文件（d7-platform.md:1274）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `DOWNLOAD_GRANT_INVALID` | 409 | 下载授权已过期、已被重新生成、已撤销或没有授权（`details.reason`、`details.expiresAt`、`details.canRegenerate`；m05 定义）。页面提示“请在小程序重新生成下载授权” |
| `DOWNLOAD_NOT_AVAILABLE` | 409 | 没有生效中的成片包（`not_delivered`）；成片包已关闭（`release_closed`）；订购项已取消、退回或终止（`order_item_closed`）；已过使用期止日次日 00:00（`usage_ended`）；清单内该集文件不是 `stored`，或 ZIP 已就绪但没有发布清单文件（`file_unavailable`）（m05 定义） |
| `VALIDATION_FAILED` | 400 | `kind = episode` 缺集号或集号越界；其余 `kind` 带了集号 |
| `NOT_FOUND` | 404 | 订购项不存在或不属会话门店 |

**副作用**（同一事务）：
- 签发时（`state = ready`）插入一行 `delivery_download_log`：`entity_id`、`store_id`（取自成片包 `delivery_release.entity_id`、`delivery_release.store_id`，两列必填）、`delivery_release_id`、`download_grant_id`（当前有效授权）、`order_item_id`、`kind`、`episode_no`（仅单集）、`file_id`（单集取清单里该集的 `fileId`；ZIP、发布清单取本次 `ensureZip` 返回的 `zipFileId`、`publishListFileId`）、`actor_type = merchant`、`actor_id = portal_session.approved_by_user_id`、`client = portal`、`url_ttl_sec`（单集 900、ZIP 10800、发布清单 900）、`ip`、`user_agent`（10-delivery.md:1062-1075）。`building` / `failed` / `none` 没有文件可签，不写下载记录（`delivery_download_log.file_id` 必填）。
- `kind` 为 `zip`、`publish_list` 时调 `media.ensureZip`，传入 10-delivery.md:888 列的全部字段（`items` 取自 `manifest_snapshot`，`publishListText` 取 `delivery_release.publish_list_text`，`keepUntil` = 该成片包有效授权最晚的 `expires_at` + 1 天，`zipFileName` = `{安全剧名}_全{N}集.zip`）与选项（`zip`：`retry` = 请求体的值；`publish_list`：`peek = true`）。由它触发的技术状态迁移（06-media.md 2.12，随本事务）：
  - `kind = zip`：`zip_bundle.zip_state`：— → `building`（首次，06-media.md:962）；`none` → `building`（06-media.md:964）；`failed` → `building`（`retry = true`，`zip_gen + 1`、建新任务，06-media.md:964）；`failed` → `failed`（`retry = false`：不建任务、不升代次，返回失败状态，A99）；`building` → `building`（返回打包中，06-media.md:968）；`ready` → `ready`（ZIP 仍 `stored`，顺延两个文件引用的保留期，06-media.md:969）；`ready` → `building`（ZIP 文件已不在，06-media.md:970）。新建打包任务时写 `media_job`（`kind = zip_package`，`dedupe_key = zip:{zipBundleId}:{zipGen}`）。
  - `kind = publish_list`（`peek`）：只有 `ready` → `ready`（ZIP 仍 `stored`，顺延保留期）；其余状态原样返回，不建行、不升代次、不建任务；`ready` 但 ZIP 文件已不在时也不重打，返回 `none`。
  - 不写 `status_transition`。`retry`、`peek` 两个选项需由数据模型 06 分组回写 `ensureZip` 的签名与 `zip_bundle` 状态表（见修订记录的回写清单）。
- 服务端直记埋点 `package_download`（`analytics_event.source = direct`、`client = portal`、`actor_type = merchant`、`actor_id` = `merchant_user_id` = `portal_session.approved_by_user_id`（`ck_analytics_event_actor` 要求 merchant 有 `actor_id`，下载页没有 `anonymous_id`）、`role = owner`、`entity_id`、`store_id` 取自成片包，`occurred_at` 取事务时间；`props` 带订购单 id、下载方式 `episode` / `zip`、渠道 `portal`；`event_id = srv-pkgdl-{releaseId}-{userId}-{方式}-{业务日}`，同一天同一方式只记一次；d5-media.md:1690；PRD.md:1012；14-config-data.md:694、698）。只在签发成功（`ready`）时记；`publish_list` 不记埋点。
- 不改业务状态，不发出站事件。响应带 `Cache-Control: no-store`（C18）。

**说明**：
- 守卫即 d5-media.md:1542-1551 的 `canDownload`，每次签发都过：① 授权 `download_grant.state = active` 且未过期；② 授权指向生效中的成片包（`delivery_release.state = pushed`）；③ 订购项未取消、未退回（`order_item.phase` 不在 `cancelled`、`refunded`、`terminated`、`ended`），且当前早于 `order_item.usage_end_date` 次日 00:00（北京时间）；④ 授权人是该主体的老板（`portalAuth` 已校验）；⑤ 文件在清单内且 `file_object.status = stored`（单集逐个核对；ZIP 由 `ensureZip` 保证）。①–④ 不满足时 `PortalOrderItemCard`、`PortalReleaseView` 的 `downloadBlocker` 给出同样的结论。
- 直链签出后无法撤回，所以单集 15 分钟、ZIP 3 小时（d5-media.md:1574；C61）；ZIP 用浏览器原生断点续下（d7-platform.md:1272）。
- 打包失败不阻塞交付：逐集下载始终可用（d5-media.md:1682）。
- 受平台约束：小程序单次下载上限 200MB，整包下载只在下载页提供（design-spec.md:855）。本接口代替 d5-media.md:2119 的 `…/downloads/episodes/{no}` 与 `…/downloads/zip`、d4-identity.md:2281 的 `POST /portal/deliverables/{fileId}/download-url`。

### 3.9 portal.orderItem.publishList.get　发布清单

`GET /portal/order-items/{orderItemId}/publish-list`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `portal`；能力点 `delivery.download` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `portal.global` |
| 开关 | 无 |
| 对应画板 | 原型无：③ 成片下载的“发布清单”（复制 / 下载文本文件） |
| 出处 | 路线图 `p01.publish-list.get`；d5-media.md:2119；d7-platform.md:1274；06-media.md:979；10-delivery.md:834、1071、1159；proto-merchant-a.md:571 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderItemId` | string(uuid) | 是 | 属会话门店 | 订购项（`publish-lists` 在订购项下的单例别名，A5 第三类） |

**响应**：`PublishListView`（同 m05-delivery-publish 2.5）。逐集字段与整份文本都返回，页面可整份复制，也可逐集复制。

**错误**：无（订购项没有生效中的成片包时 404 `NOT_FOUND`：发布清单随成片包交付，推送前不对商家展示，与小程序一致）。

**副作用**：无（只读，不写 `delivery_download_log`，10-delivery.md:1071）。

**说明**：复制读生效成片包的 `delivery_release.publish_list_text`，不读打包时生成的清单文件（06-media.md:979）；推送后修订清单会同步更新这段文本（10-delivery.md:1159）。“下载清单文件”按钮（`hasPublishList` 为真时显示）点击后先调 3.8 的 `kind = publish_list`（只查不建，不触发打包）：`ready` 用返回的 15 分钟直链下载服务端文件（写下载记录）；其余状态由浏览器用本接口的 `text` 生成文本文件（不留痕，10-delivery.md:1071）。页面因此不需要事先知道 ZIP 是否就绪。

### 3.10 portal.orderItem.sample.get　样片预览页

`GET /portal/order-items/{orderItemId}/sample`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `portal`；能力点 `sample.view` |
| 幂等 | none（纯查询；不写访问记录、不回写首次查看时间，A19） |
| 乐观锁 | 无 |
| 限流 | `portal.global` |
| 开关 | 不受开关拦截；能否在电脑上播放看推送时写定的 `previewChannels`，`weapp.video.sample.enabled` 此刻的值只用于开关兜底（1.1；m05-delivery-publish 3.8） |
| 对应画板 | 原型无：④ 样片只读预览；② 可下载清单的“待确认样片” |
| 出处 | 路线图 `p01.sample.get`；d5-media.md:1427、1490、1521、1645、2119；d7-platform.md:1270、1275、810；d3-flow.md:1536、1540；10-delivery.md:191、562、565、645；06-media.md:403；design-spec.md:853；04-adr.md:190（ADR-027）；A19、C60；m06-ad 2.8 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderItemId` | string(uuid) | 是 | 属会话门店 | 订购项（`samples` 在订购项下的单例别名，A5 第三类） |

**响应**：`PortalSampleView`。返回最近一次推送给商家的版本（`version_no = delivery_ticket.current_sample_version_no`），不论它此刻是否已被确认、提意见或取代；不含播放地址。

**错误**：无（订购项没有交付工单、或从未推送过样片时 404 `NOT_FOUND`）。

**副作用**：无。

**说明**：
- 只读：不能确认、不能提修改意见（d5-media.md:1645；d7-platform.md:1275）。页面写明“请回到小程序确认或提出修改意见”，确认走小程序 `m.sample.confirm`（`viewedVia = portal`，m05）。
- 受平台约束（design-spec.md:853）：样片默认不在小程序内播放，替代出口之一就是在下载页观看；回小程序勾选“我已查看”后确认或提意见。能否在电脑上播放取决于推送时写定的查看方式，而不是开关此刻的值：推送时开关为关的版本含 `portal`，可以播放；推送时开关为开（只有 `weapp`）而之后因平台整改被关闭的版本，按开关兜底放行（1.1），在这里看过后回小程序以 `viewedVia = weapp` 确认，m05 3.9 以 3.11 签发时写的电脑端预览记录为证（本接口只读、不写记录）；开关此刻仍为开的，`previewBlocker = channel_not_offered`，页面提示“请在小程序内观看”。
- 订购项已取消、退回或终止（工单 `terminated`）时 `previewBlocker = order_closed`，页面提示“该订单已关闭，无需再确认样片”；取消执行不动样片行，所以要单独判断（10-delivery.md:191）。
- d4-identity.md:509、2152 写“下载页只有下载类接口、预览为扩展点”，与 ADR-027（04-adr.md:190）、d5、d7 不一致，以 ADR-027 为准。

### 3.11 portal.sample.playbackUrls　签发样片播放地址

`POST /portal/samples/{sampleId}/playback-urls`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `portal`；能力点 `sample.view`；必须带 `X-LYX-Portal: 1` 且 `Origin` 等于下载页源 |
| 幂等 | none（签发短时地址，A18、A19；每次签发都留痕，结果不进幂等记录） |
| 乐观锁 | 无（`sample.first_viewed_at` 只在为空时写，带条件的 UPDATE） |
| 限流 | `portal.global` |
| 开关 | 不受开关拦截；`weapp.video.sample.enabled` 此刻的值只用于开关兜底（1.1；m05-delivery-publish 3.8） |
| 对应画板 | 原型无：④ 样片只读预览（点击播放、地址过期后续播） |
| 出处 | 路线图 `p01.samples.playback-urls`；d5-media.md:1427、1490；d3-flow.md:1536、1540；d7-platform.md:810；10-delivery.md:191、562、565、645、1254；rulings.md:40（M27）；05-risks-and-open-issues.md:253（B4）；A18、A19；C60–C62；m05-delivery-publish 3.8、3.9、3.11 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `sampleId` | string(uuid) | 是 | 属会话门店 | 样片版本 id（取自 `PortalSampleView.sampleId`；一个版本只有一份水印版，路径即指明文件） |

请求体：无（空对象）。

**响应**：`Playable`（m06-ad 2.8）：`kind = sample`，`sources` 一档指向水印版（`playable_asset.renditions`），地址 60 分钟（C61）；过期后再调本接口换新（每次都留痕）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 订购项已关闭：工单 `delivery_ticket.step = terminated`，或 `order_item.phase` 在 `cancelled`、`refunded`、`terminated`（`previewBlocker = order_closed`）；本版不是 `pushed`、`confirmed`、`change_requested`（已被取代的旧版本不再提供，`superseded`） |
| `SAMPLE_VIEW_CHANNEL_NOT_OFFERED` | 409 | 该版本的 `preview_channels` 不含 `portal`，且不属于开关兜底（推送时开关为开、此刻仍为开，只能在小程序内播放）（m05 定义，`details.previewChannels`） |
| `SAMPLE_PREVIEW_NOT_READY` | 409 | 水印版尚未生成（`playable_asset.state` 不是 `ready`）（m05 定义） |
| `NOT_FOUND` | 404 | 样片不存在、不属会话门店，或尚未推送 |

守卫按上表顺序核对，与 `PortalSampleView.previewBlocker` 的取值顺序一致。

**副作用**（同一事务）：
- 写一行访问审计：`audit_log.stream = access`、`category = file_access`、`action = delivery.sample.portal_preview`、`actor_type = merchant`、`actor_id` = 授权老板、`client = portal`、`target_type = sample`、`target_id` = 本版、`entity_id`、`store_id`、`session_id = portal_session.id`、`auth_method = portal`、`ip`、`user_agent`、`meta = { fileCategory: sample_wm, urlTtlSec: 3600 }`（10-delivery.md:1254；03-staff-authz-audit.md:560、951）；必填的 `summary`（如“在电脑上预览第 N 版样片”）、`actor_name`（“商家”）、`actor_role`（“老板”）由 `audit.record` 按操作人补全（03-staff-authz-audit.md 2.10）。
- `sample.first_viewed_at` 为空时回写为当前时间（M27；10-delivery.md:565）。它不是状态列，不触发状态迁移，不写 `status_transition`，不发出站事件。

**说明**：
- 这次访问是 `sample.status`：`pushed` → `confirmed` 守卫里“查看方式为 `portal` 时有对应的访问记录”的证据（10-delivery.md:645；d3-flow.md:1540）；A19 规定样片的“已查看”证据只在这类 POST 里写。`m.sample.confirm` 按 `audit_log.action = delivery.sample.portal_preview`、`target_id` = 本版核对（m05 3.9）；开关兜底下以 `viewedVia = weapp` 确认时，同一条记录也是证据。
- 开关兜底（1.1）：版本只有 `weapp`（或 `weapp`、`wecom`）而 `weapp.video.sample.enabled` 此刻为关时照常签发，写同样的访问审计（与 m05 3.11 `m.sample.downloadUrls` 的兜底同一口径）。
- 允许的状态取 `pushed`、`confirmed`、`change_requested`，与小程序 `m.sample.downloadUrls` 一致（决定之后仍可回看）；路线图切片已按此改（第二轮）。
- 这种确认方式的证据效力待法务（05-risks-and-open-issues.md:253 B4；第 6 节第 1 项）。

### 3.12 portal.ad.list　待确认的广告

`GET /portal/ads`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `portal`；能力点 `ad.view` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `portal.global` |
| 开关 | 不受开关拦截；`weapp.video.ad.enabled` 此刻的值只用于开关兜底（1.1；m06-ad 2.9） |
| 对应画板 | 原型无：② 可下载清单的“待确认的广告” |
| 出处 | 路线图 `p01.ads.list`；d7-platform.md:1270；d5-media.md:1491、1612、1645、1655、2141；09-order-ad.md:862；06-media.md:403；design-spec.md:862；A22、A24、A97；C42、C45；m06-ad 2.1、2.9 |

**请求**（查询参数的 schema：`PortalAdListQuery`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `status` | array<enum(`AdStatus`)> | 否 | 逗号分隔；缺省 `pending_confirm` | 按 `ad.status` 筛选（不是页签，A24） |
| 查询 | `cursor` | string | 否 | — | 游标 |
| 查询 | `limit` | integer | 否 | 1–50，缺省 20 | 每页条数 |

**响应**：`CursorPage<PortalAdCard>`（契约名 `PortalAdPage`）。范围：`ad.store_id = portal_session.store_id`、`ad.status` 在筛选内，且当前版本（已推送的最大版本）可在电脑上预览：`ad_version.preview_channels` 含 `portal`（09-order-ad.md:862），或属于开关兜底（只有 `weapp` 或 `weapp`、`wecom`，而 `weapp.video.ad.enabled` 此刻为关，m06-ad 2.9）。排序按当前版本推送时间倒序，`adId` 兜底。

**错误**：无（`status`、`limit` 取值非法时 400 `VALIDATION_FAILED`）。

**副作用**：无。

**说明**：
- 当前版本不能在电脑上预览的广告不列出：电脑上放不了，列出来只会多一个不能点的条目；页面 ② 的广告分区写“其余广告请在小程序查看”（作者默认，按第十节导语接受）。
- 不返回任何计价字段（冻结积分、单价、折扣），见 1.1。
- 商家自己的广告在小程序内可以预览（design-spec.md:862）；下载页预览是 `weapp.video.ad.enabled` 关闭时的替代途径（d5-media.md:1491）。查看方式在推送时按开关写定（A97），推送后开关才被关闭的版本按开关兜底列出并放行（与 m06-ad 2.9 的 `canPreviewOnPortal` 同一口径）。

### 3.13 portal.ad.get　广告预览页

`GET /portal/ads/{adId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `portal`；能力点 `ad.view` |
| 幂等 | none（纯查询，不写库） |
| 乐观锁 | 无 |
| 限流 | `portal.global` |
| 开关 | 不受开关拦截；`isPortalPreviewable` 按开关兜底计算（1.1） |
| 对应画板 | 原型无：④ 广告只读预览 |
| 出处 | 路线图 `p01.ads.get`；d5-media.md:1429、1491、1524、2119；d7-platform.md:1270；d3-flow.md:1540、1543；09-order-ad.md:862、867、910；A19、C60；m06-ad 2.9 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `adId` | string(uuid) | 是 | 属会话门店 | 广告 id |

**响应**：`PortalAdDetail`；不含播放地址。

**错误**：无（广告不存在、不属会话门店或尚无已推送版本时 404 `NOT_FOUND`）。

**副作用**：无。

**说明**：只读。确认与修改意见回小程序 `m.ad.confirm`、`m.ad.requestChange`（m06-ad）；页面写明“请回到小程序确认或提出修改意见”。`segments` 供页面在进度条上标出分段（d5-media.md:1524）。

### 3.14 portal.ad.playbackUrls　签发广告播放地址

`POST /portal/ads/{adId}/playback-urls`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `portal`；能力点 `ad.view`；必须带 `X-LYX-Portal: 1` 且 `Origin` 等于下载页源 |
| 幂等 | none（签发短时地址，A18、A19） |
| 乐观锁 | 无；请求体带业务版本号 `versionNo` 指明要哪一版（C60） |
| 限流 | `portal.global` |
| 开关 | 不受开关拦截；`weapp.video.ad.enabled` 此刻的值只用于开关兜底（1.1；m06-ad 2.9） |
| 对应画板 | 原型无：④ 广告只读预览（点击播放） |
| 出处 | 路线图 `p01.ads.playback-urls`；d5-media.md:1429、1491；d7-platform.md:810、1270、1275；d3-flow.md:1540、1543；09-order-ad.md:862、867、910；m06-ad 2.9、3.5、3.8；A18、A19、A97；C60–C62 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `adId` | string(uuid) | 是 | 属会话门店 | 广告 id |

请求体（`PortalAdPlaybackBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `versionNo` | integer | 是 | ≥ 1；须等于当前版本（已推送的最大版本号） | 要播放的版本 |

**响应**：`Playable`（m06-ad 2.8）：`kind = ad`，`sources` 一档 `source` 指向该版本的源文件（06-media.md:1759），地址 60 分钟（C61）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 广告已取消，或尚无已推送版本 |
| `AD_VERSION_STALE` | 409 | `versionNo` 不是当前版本（`details.currentVersionNo`；m06 定义） |
| `AD_PREVIEW_CHANNEL_UNAVAILABLE` | 409 | 该版本的 `preview_channels` 不含 `portal`，且不属于开关兜底（推送时开关为开、此刻仍为开）（`details.previewChannels` 为 `PreviewChannel[]`；m06 定义） |
| `PLAYABLE_UNAVAILABLE` | 409 | 可播放资产不是 `ready`（`details.state`；m06 定义） |
| `NOT_FOUND` | 404 | 广告不存在或不属会话门店 |

**副作用**（同一事务）：写一行访问审计：`audit_log.stream = access`、`category = file_access`、`action = ad.version.portal_preview`（m06-ad 已按此名核对证据）、`actor_type = merchant`、`actor_id` = 授权老板、`client = portal`、`target_type = ad_version`、`target_id` = 版本 id、`entity_id`、`store_id`、`session_id = portal_session.id`、`auth_method = portal`、`ip`、`user_agent`、`meta = { fileCategory: ad_video, urlTtlSec: 3600 }`；必填的 `summary`、`actor_name`（“商家”）、`actor_role`（“老板”）由 `audit.record` 按操作人补全（同 3.11）。不写 `ad_version` 的任何列（数据模型不给它加 `first_viewed_at`，09-order-ad.md:1198）；不触发状态迁移，不发出站事件。

**说明**：
- 这次访问是广告确认 `viewedVia = portal` 时“该版本有电脑端查看记录”的证据（09-order-ad.md:910；d3-flow.md:1540、1543），`m.ad.confirm` 按 `audit_log.action = ad.version.portal_preview`、`target_id` = 版本 id 核对（m06-ad 3.5）；开关兜底下以 `viewedVia = weapp` 确认时，同一条记录也是证据（m06-ad 3.5 `requiredEvidence = album_or_portal`）。
- 开关兜底（1.1）：版本只有 `weapp`（或 `weapp`、`wecom`）而 `weapp.video.ad.enabled` 此刻为关时照常签发，写同样的访问审计（与 m06-ad 3.8 `m.ad.downloadUrls` 的兜底同一口径）。
- 签发源文件：广告视频不加水印（A97；数据模型的广告可播放资产不转码，06-media.md:1759），路线图切片摘要里的“水印”已删（第二轮）。

### 3.15 portal.licenseVerification.get　授权书验真

`GET /portal/license-verifications?code=&revNo=`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `public`（不需要下载页会话；进 C2 的公开接口黄金清单） |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `portal.verify`：按 IP，每 IP 每分钟 30 次、每小时 300 次（p01 的建议值，已写进 C68；额度由主负责人与运维确认，约定第 15 节第 17 项） |
| 开关 | 无 |
| 对应画板 | 原型无：`/v?code=…&rev=…` 授权书验真页 |
| 出处 | 路线图 `p01.license-verifications.get`；d6-notify-docs-data.md:1250、1317、1381、1386、1418；13-notify-docs.md:902、906、917、1144-1158；d7-platform.md:1376；A3、A37、A100；C1、C7、C11、C68 |

**请求**（查询参数的 schema：`LicenseVerificationQuery`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `code` | string | 是 | 1–64 个字符；不是 16 位字母数字的一律按“查不到”处理 | 验真码（`license_letter.verify_code`，按 `uq_license_letter_verify_code` 查）。凭证放查询参数，访问日志脱敏（A3、C7） |
| 查询 | `revNo` | integer | 否 | ≥ 1；不是正整数时按没带处理（不报 400，避免改坏的二维码查不出结果） | 扫的是哪一版：页面把前端路由的 `rev` 原样作为 `revNo` 传入（A100、C1），用于“已有更新版本”的提示 |

**响应**：`LicenseVerificationView`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `LICENSE_VERIFICATION_NOT_FOUND` | 404 | 验真码不存在、格式不对，或该授权书还没有出件的版次（没有 PDF 就不会被扫到）；页面显示“未查到这份授权书，请核对二维码或验真码” |
| `RATE_LIMITED` | 429 | 超过 `portal.verify` 额度 |

**副作用**：无（不写访问记录）。

**说明**：
- 按 A37、A100 定稿：下载页前端路由 `/v?code=<验真码>&rev=<版次>`，页面把 `code` 原样传给本接口的 `code`、`rev` 原样传给 `revNo`；不做服务端直出 HTML，草案的 `GET /v/{verifyCode}`（d6-notify-docs-data.md:1386、2255）与原路线图的 `/portal/license-verifications/{verifyCode}` 都不再使用。印在授权书 PDF 页脚二维码上的地址为 `https://portal.<域名>/v?code=<验真码>&rev=<版次>`（C1；即 `letter_snapshot.verifyUrl`，m05 `LicenseLetterPreview.verifyUrl` 同此，数据模型 13 分组按 A100 回写）。手输验真码或旧二维码不带 `rev` 时 `requestedRevisionState = not_requested`，页面按内容指纹对照版次。
- 显示内容按 d6-notify-docs-data.md:1386：编号、版次、状态、授权方、被授权方（脱敏）、剧名、平台与账号、期限、内容指纹、当前版文件的 SHA-256、签署方式与证书序列号。不返回 PDF 本体、不返回任何文件地址；信用代码与经办人脱敏（d6-notify-docs-data.md:1418）。
- “已失效”是派生状态（13-notify-docs.md:902）；作废显示“已作废”与作废时间，不说明原因（d6-notify-docs-data.md:1317）。
- 旧版提示：验真码在信件上、各版次共用（13-notify-docs.md:906），单凭 `code` 不知道扫的是哪一版。本接口返回全部已出件版次的内容指纹与文件哈希，核对人用 PDF 页脚的内容指纹对照，不是当前版次即提示“已有更新版本”；带 `revNo` 时直接给出 `requestedRevisionState`（`outdated` 即提示“已有更新版本”）。
- 被授权方名称按 A100 脱敏（保留前 2 个字与后 4 个字，不足 7 个字的只留首字），待法务确认（第 6 节第 2 项）。
- 图片章降级时如实标注签署方式（`signMode = stamp`，d6-notify-docs-data.md:1381）。

### 3.16 portal.clientError.create　前端错误上报

`POST /portal/client-errors`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `optional`：有有效会话则记操作人，没有或已失效按匿名处理（不返回 401）；必须带 `X-LYX-Portal: 1` 且 `Origin` 等于下载页源 |
| 幂等 | none（错误上报，A18、C47）：转发后即丢，不落库 |
| 乐观锁 | 无 |
| 限流 | `telemetry`：有会话时每分钟 30 条，匿名每 IP 每分钟 10 条（C68；d7-platform.md:884） |
| 开关 | 无 |
| 对应画板 | 原型无：下载页全部页面（①–⑤、`/a`、`/v`）共用 |
| 出处 | 路线图 `p01.telemetry-envelopes.create`；d7-platform.md:879-893、1277、1914、2385；A5、A18；C10、C24、C68；`resources.json`：`client-errors` |

**请求**：请求体（`SentryEnvelope`）：Sentry envelope 原文（`Content-Type: application/x-sentry-envelope`），≤ 200KB；信封头里的 DSN 必须属于登记的项目白名单（与 m08-support-misc 3.27、a01-system 3.84 同一规则：匿名可调的同源接口不能替任意 Sentry 项目转发）。服务端只校验信封格式与 DSN，不解析业务内容。前端 `beforeSend` 已去掉请求体、令牌与形如手机号、统一社会信用代码的字符串（d7-platform.md:895）。

**响应**：HTTP 202，`data = null`（C24：202 只用于这类转发）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 不是合法的信封，或 DSN 的项目不在白名单 |
| `RATE_LIMITED` | 429 | 超过 `telemetry` 额度；页面直接丢弃，不重试 |

超过 200KB 由网关直接返回 413（C23，没有响应体），与 m08、a01 一致。

**副作用**：无（进程内有界队列 + 熔断，同源转发到错误收集服务；上游未配置时只写日志，d7-platform.md:880-893）。

**说明**：资源名按 C10 与 `resources.json` 三端统一为 `client-errors`（d7-platform.md:879 写作 `/portal/telemetry/envelope`），与 `m.clientError.create`、`admin.clientError.create` 同名同形，三端共用一个转发实现（DSN 白名单、200KB、413 一致）。`/a` 落地页只提示“请打开狸有戏小程序 › 发布任务 › 下载 › 扫码在电脑上下载”，本接口是它唯一调用的接口（d7-platform.md:1270）。

### 3.17 portal.file.create　电脑端上传登记（V1.1）

`POST /portal/files`

V1.1，细节待设计。用途：电脑端上传大文件的登记，流程与小程序、后台相同（登记 → 直传 → `POST /portal/files/{fileId}/complete` → 业务引用；续签 `refresh-credentials`、取消 `cancel` 届时一并补，C59）。幂等 `natural`（`idempotentBy` = [`uq_file_object_client_token_store`]，A49 的数组写法；按 `clientToken` 复用未完成的登记，06-media.md:174）；能力点由 d4-identity.md:2152 的 `PortalActor.grant` 增加能力项，V1.1 定。V1.0 的超限出口按 A35：小程序超过上传上限时返回统一的引导信息，由服务经理在后台代传（design-spec.md:856 已按此写明“电脑端上传是 V1.1”）。对应画板：原型无（下载页·电脑端上传，V1.1）。出处：路线图 `p01.uploads.create`；d7-platform.md:1275；05-risks-and-open-issues.md:145；A5、A35；C59。

## 4. 枚举

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `PortalTicketPollStatus` | `pending`、`approved`、`rejected`、`expired`、`consumed` | 接口枚举：`pending`、`approved`、`rejected`、`consumed` 同数据模型 `portal_ticket.status`；`expired` 是派生值（`pending` 过了 `expires_at`，或确认后超过 60 秒未换会话），不落库 |
| `PortalTicketInvalidReason` | `not_found`、`expired`、`rejected`、`consumed`、`approved`、`secret_mismatch` | 接口枚举：`PORTAL_TICKET_INVALID` 的 `details.reason`；各接口用哪几个见第 5 节。`approved` = 票据已被确认、正等电脑换会话（重复扫码、另一位老板已确认、换新幂等键再点确认），只出现在 m02 的 lookup、approve、reject；`secret_mismatch` 只出现在 `portal.portalTicket.exchange`；`x-open-enum` |
| `PortalTicketExchangeStatus` | `consumed`、`rejected` | 接口枚举：`PortalTicketExchangeResult.status`，取值同数据模型 `portal_ticket.status` 的这两个 |
| `PortalTicketExchangeRejectReason` | `secret_mismatch`、`attempts_exceeded`、`window_passed` | 接口枚举（不落库）：换会话使票据作废的原因，对应数据模型 02-identity-tenant.md:907 的“密钥不符、尝试超过 5 次、超过 60 秒” |
| `PortalSessionInvalidReason` | `not_found`、`expired`、`revoked`、`authorizer_invalid` | 接口枚举：`PORTAL_SESSION_INVALID` 的 `details.reason`。`authorizer_invalid` = 授权人账号不是 `active` 或已不是该主体的有效老板（会话尚未被吊销） |
| `PortalSessionRevokeReason` | `owner_revoked`、`membership_changed`、`account_action`、`portal_logout`、`expired` | 同数据模型 `portal_session.revoke_reason`；`PORTAL_SESSION_INVALID` 的 `details.revokeReason` |
| `PortalGrantScope` | `store` | 同数据模型 `portal_session.grant_scope` |
| `PortalOrderItemTab` | `all`、`downloadable`、`sample_pending` | 接口枚举：可下载清单的分区（3.6） |
| `OrderItemPhase` | `pending_start`、`producing`、`to_launch`、`live`、`ended`、`cancelled`、`refunded`、`terminated` | 同数据模型 `order_item.phase` |
| `ReleaseKind` | `initial`、`reissue` | 同数据模型 `delivery_release.kind` |
| `ReleaseState` | `pushed`、`superseded`、`closed` | 同数据模型 `delivery_release.state` |
| `ReleaseCloseReason` | `cancelled`、`usage_ended` | 同数据模型 `delivery_release.close_reason` |
| `DownloadGrantState` | `active`、`superseded`、`revoked` | 同数据模型 `download_grant.state` |
| `DownloadKind` | `episode`、`zip`、`publish_list` | 同数据模型 `delivery_download_log.kind`（下载页三种都接受） |
| `ZipBuildState` | `ready`、`building`、`failed`、`none` | 接口枚举：`PortalDownloadResult.state`，取值同数据模型 `zip_bundle.zip_state`。`kind = zip` 只会出现前三个（`ensureZip` 遇到 `none` 即开始打包）；`none` 只在 `kind = publish_list`（只查不建）出现 |
| `DownloadBlockerKind` | `grant_invalid`、`not_available` | 接口枚举：`DownloadBlocker.kind`，分别对应 `DOWNLOAD_GRANT_INVALID`、`DOWNLOAD_NOT_AVAILABLE` |
| `DownloadGrantInvalidReason` | `expired`、`superseded`、`revoked`、`missing` | 同 m05-delivery-publish 4.4（`DOWNLOAD_GRANT_INVALID` 的 `details.reason`）；`x-open-enum` |
| `DownloadUnavailableReason` | `not_delivered`、`release_closed`、`order_item_closed`、`usage_ended`、`file_unavailable` | 同 m05-delivery-publish 4.4（`DOWNLOAD_NOT_AVAILABLE` 的 `details.reason`）；`x-open-enum` |
| `SampleStatus` | `uploaded`、`check_rejected`、`qc_rejected`、`qc_passed`、`pushed`、`confirmed`、`change_requested`、`superseded` | 同数据模型 `sample.status`；下载页只会看到后四个 |
| `PreviewChannel` | `weapp`、`album`、`portal`、`wecom` | 同数据模型 `sample.preview_channels[]`、`ad_version.preview_channels[]`；全仓同一个枚举（m05、m06、a05 同名；m06 定义的 `AD_PREVIEW_CHANNEL_UNAVAILABLE.details.previewChannels` 也用它；m05 的 `SAMPLE_VIEW_CHANNEL_NOT_OFFERED.details.previewChannels` 现写 `string[]`，已请 m05 改为本枚举） |
| `SamplePreviewBlocker` | `order_closed`、`superseded`、`channel_not_offered`、`not_ready` | 接口枚举：`PortalSampleView.previewBlocker`，按此顺序取第一个；`order_closed`、`superseded` 对应 3.11 的 `STATE_NOT_ALLOWED`，`channel_not_offered` 对应 `SAMPLE_VIEW_CHANNEL_NOT_OFFERED`，`not_ready` 对应 `SAMPLE_PREVIEW_NOT_READY`；`x-open-enum` |
| `AdType` | `opening`、`ending`、`corner`、`mid_roll` | 同数据模型 `ad.type` |
| `AdStatus` | `pending_assign`、`producing`、`returned`、`pending_confirm`、`revising`、`confirmed`、`cancelled` | 同数据模型 `ad.status` |
| `AdDisplayStatus` | `producing`、`pending_confirm`、`revising`、`confirmed`、`cancelled` | 同 m06-ad 第 4 节的商家端显示映射 |
| `AdVersionDecision` | `confirmed`、`revision_requested`、`superseded` | 同数据模型 `ad_version.decision` |
| `LicenseLetterDisplayStatus` | `pending_effective`、`effective`、`expired`、`voided` | 同 m05-delivery-publish 4.7：`expired` 由 `effective` 且止日早于今天派生；`LicenseVerificationView.displayStatus` |
| `RequestedRevisionState` | `not_requested`、`current`、`outdated`、`not_found` | 接口枚举：`LicenseVerificationView.requestedRevisionState`（没带 `revNo`、是当前版次、是已出件的旧版次、不是任何已出件的版次） |
| `LicenseRevisionReason` | `initial`、`go_live`、`period_changed`、`correction`、`resign` | 同数据模型 `license_letter_revision.reason` |
| `SignMode` | `platform_cert`、`esign_seal`、`stamp` | 同数据模型 `license_letter_revision.sign_mode` |
| `ChannelPlatform` | `douyin`、`wechat_channels` | 同数据模型 `license_letter.platform` |

会增长的响应枚举（状态、类型、原因）在契约里标 `x-open-enum`，页面必须有未知值兜底（C37）。

## 5. 错误码

本文新定义的领域错误码。数值取自 A70 分给本文的区间：下载页身份 41200–41299、验真 47500–47599（下载 46500–46599 本稿未用：下载类错误沿用 m05、m06 已定义的符号）。`retryable` 全部为否（C26）。

| 符号 | 数值 | HTTP | 含义 | `details` |
| --- | --- | --- | --- | --- |
| `PORTAL_TICKET_INVALID` | 41201 | 410 | 扫码登录票据不能用于本次操作：不存在、已过期、已作废、已换过会话、已被确认（对 m02 的三条接口而言），或待确认时密钥不符（d4-identity.md:2329）。只用于不写库的情形；要作废票据的拒绝返回 200 与 `status = rejected`（A101，3.3）。m02-tenant 的 `m.portalTicket.lookup`、`approve`、`reject` 同样返回它 | `{ reason: PortalTicketInvalidReason }` |
| `PORTAL_SESSION_INVALID` | 41202 | 401 | 下载页会话失效：不存在、已过期、已吊销，或授权人已不是该主体的有效老板（d4-identity.md:2329）。带了 Cookie 而 `portalAuth` 不通过时返回；没带 Cookie 返回通用码 `AUTH_REQUIRED`。归属本文（A77，C28 共用领域码归属表），m02 引用 | `{ reason: PortalSessionInvalidReason, revokeReason: PortalSessionRevokeReason \| null }` |
| `LICENSE_VERIFICATION_NOT_FOUND` | 47501 | 404 | 未查到这份授权书：验真码不存在、格式不对，或尚无已出件的版次 | 无 |

`PORTAL_TICKET_INVALID` 的 `details.reason` 在各接口的取值（票据状态按 3.2 的派生口径：`pending` 过了 `expires_at`、`approved` 超过 60 秒未换会话都算过期）：

| `reason` | 含义 | `m.portalTicket.lookup`（m02） | `m.portalTicket.approve` / `reject`（m02） | `portal.portalTicket.exchange` |
| --- | --- | --- | --- | --- |
| `not_found` | 票据不存在（含 7 天后已清理）；lookup 按 `public_id` 或 `pending` 的短码查不到 | 是 | 是 | 是 |
| `expired` | 已过期 | 是 | 是 | 是（只有 `pending` 过期；`approved` 超时走 200 `rejected` / `window_passed`） |
| `rejected` | 已作废 | 是 | 是 | 是 |
| `consumed` | 已换过会话 | 是 | 是 | 是 |
| `approved` | 已被确认、正等电脑换会话（重复扫码、另一位老板已确认、换新幂等键再点确认；同键重放按 C50 返回上次结果，不走到这里） | 是 | 是 | 否 |
| `secret_mismatch` | 票据待确认，而 `pollSecret` 不符 | 否 | 否 | 是 |

本文引用、由其他文档定义的领域码（不重新定义）：

| 符号 | 定义方 | HTTP | 本文用在 |
| --- | --- | --- | --- |
| `DOWNLOAD_GRANT_INVALID` | m05-delivery-publish（45109） | 409 | 3.8；列表与详情的 `downloadBlocker`（`kind = grant_invalid`） |
| `DOWNLOAD_NOT_AVAILABLE` | m05-delivery-publish（45110） | 409 | 3.8；`downloadBlocker`（`kind = not_available`） |
| `SAMPLE_VIEW_CHANNEL_NOT_OFFERED` | m05-delivery-publish（45107） | 409 | 3.11 |
| `SAMPLE_PREVIEW_NOT_READY` | m05-delivery-publish（45108） | 409 | 3.11 |
| `AD_VERSION_STALE` | m06-ad（45202） | 409 | 3.14 |
| `AD_PREVIEW_CHANNEL_UNAVAILABLE` | m06-ad（45203） | 409 | 3.14 |
| `PLAYABLE_UNAVAILABLE` | m06-ad（45206） | 409 | 3.14 |

通用码（C27）中本文有特殊含义的：`AUTH_REQUIRED`（没有下载页 Cookie）、`ORIGIN_REJECTED`（非 GET 缺 `X-LYX-Portal` 或 `Origin` 不符，含匿名的建票据、换会话与 `DELETE` 退出）、`NOT_FOUND`（不在会话门店范围内；轮询时票据不存在或密钥不符）、`STATE_NOT_ALLOWED`（换会话时票据仍待确认；样片所属订购项已关闭或样片已被取代；广告已取消）、`VALIDATION_FAILED`、`RATE_LIMITED`、`MAINTENANCE`。

## 6. 待确认

只留需要产品、业务、法务决定的问题。初稿的其余各项已由裁决关闭（会话时长 A65、ZIP 重试 A99、二维码带版次 A100、能力点 A65 与 A87、会话失效错误码 A77、发布清单文件有效期 A125），或按第十节导语接受作者默认（广告清单只列可在电脑上预览的、下载授权只在小程序重新生成）；`portal.verify` 的额度由约定第 15 节第 17 项跟踪。

| # | 问题 | 默认做法 | 由谁定 |
| --- | --- | --- | --- |
| 1 | 样片、广告经下载页预览后回小程序勾选确认，证据效力是否足够（05-risks-and-open-issues.md:253 B4）；开关在推送后被关闭时，以 `weapp` 登记、凭电脑端预览记录确认的兜底是否可接受 | 按数据模型：每次签发写访问审计（样片另回写首次查看时间），确认时由 m05、m06 核对（3.11、3.14）；兜底与 m05-delivery-publish 3.8、m06-ad 2.9 同一口径（m05 第 6 节第 1 项同题） | 产品 + 法务 |
| 2 | 验真页被授权方名称的脱敏规则：design-spec.md 的脱敏表没有企业名称 | 按 A100：保留前 2 个字与后 4 个字，中间每个字替换为 `*`；不足 7 个字时只留首字。信用代码按设计规范“留前 12 位与末 2 位”（约定第 15 节同题） | 法务 |

## 7. 修订记录

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：路线图 `doc = p01-portal` 的 17 条接口（V1.0 16、V1.1 1）写到字段级；新定义错误码 3 个（41201、41202、47501），下载与预览类错误沿用 m05、m06 的定义；退出登录幂等按 A43 改 `none`，会话路径按 A41、A43 提出改名；可下载清单补 `tab` 并纳入只有待预览样片的订购项；下载签发补 `retry`；验真补 `revNo` 与版次列表 | 写作规范；A1–A75；C1–C84；数据模型 02、06、09、10、13 分组 |
| 2026-10-03 | 第二轮。① 会话两条按 A82 定稿：`GET /portal/sessions/current`（`portal.session.current.get`）、`DELETE /portal/sessions/current`（`portal.session.current.delete`，幂等 none），删去“改名前按本节实现”与“resources.json 仍是旧路径”的说法。② 换会话要作废票据（`approved` 而密钥不符、尝试达上限、超过 60 秒）时改为 200 + `PortalTicketExchangeResult.status = rejected`（与 A101、C24、C50 一致，作废随事务提交），410 只留给不写库的情形；`PortalTicketInvalidReason` 补 `approved`，第 5 节列出各接口的取值。③ 待预览样片与样片播放守卫排除已关闭的订购项（工单 `terminated` 或 `order_item.phase` 为取消、退回、终止），`SamplePreviewBlocker` 补 `order_closed`，3.11 返回 `STATE_NOT_ALLOWED`。④ 开关兜底：推送后开关才被关闭、版本只有 `weapp` 的样片与广告，下载页按 m05 3.8、m06 2.9 同一口径列出并放行（列表、详情、签发三处），改写 1.1 与 3.10 的“不受开关约束”。⑤ `kind = publish_list` 改用 `ensureZip` 的只查不建选项 `peek`，不触发打包；`ZipBuildState` 补 `none`；页面“下载清单文件”先调签发、不是 `ready` 即用 3.9 的文本在浏览器生成。⑥ ZIP 重试按 A99 定稿，迁移补 `failed → failed`（`retry = false`）。⑦ 下载记录补必填列 `entity_id`、`store_id`；埋点补 `actor_id`、`role`、`entity_id`、`store_id`（`ck_analytics_event_actor`）。⑧ `DownloadBlocker` 改为按 `kind`（`grant_invalid` / `not_available`）判别的联合，取值小写（C37）；验真的 `isRequestedRevisionCurrent`（可空布尔）改为枚举 `requestedRevisionState`（C39），`status` 改名 `displayStatus`（与 m05 同义），`period`、`consent` 抽成共用结构 `LicensePeriod`、`LicenseConsent`。⑨ 验真二维码按 A100 带 `&rev=`，页面把 `rev` 传为 `revNo`。⑩ 错误上报对齐 m08、a01：DSN 项目白名单，超过 200KB 由网关返回 413。⑪ 广告签发去掉“水印”（A97）；`PreviewChannel` 注明全仓同一枚举；`Playable` 注明 m06 2.8 为唯一定义。⑫ 第 6 节由 11 项减为 2 项。⑬ 路线图切片同步：会话两条、清单 `tab` 与范围、签发 `retry` / `peek`、样片允许状态与兜底、广告摘要去“水印”、验真 `revNo`、`idempotentBy` 改数组、表清单补齐、旧“待确认”说法按定稿改写。⑭ 广告海报 `PortalAdCard.poster` 按 m06 2.1 改为 `playable_asset.cover_file_id` 优先、为空取体检抽帧 `media_info.cover_file_id`（广告不转码），样片海报同 m06 2.8 `Playable.posterUrl` 的取法（`review/r2-xd-p01-portal.md` m06 第 1 项）。⑮ `lastPortalViewAt` 改按 `audit_log.action = delivery.sample.portal_preview` + `target_id` 取，与 m05 3.9 核对证据的条件一致；3.10 写明证据由 3.11 写入、本接口不写（同上 m05 第 1 项）。⑯ 两条访问审计写明必填列 `summary`、`actor_name`、`actor_role` 由 `audit.record` 补全。⑰ 切片：建票据与轮询的摘要按文档字段改写（`qrUrl`；轮询状态含 `consumed`），样片、广告的读接口与签发补表 `media_info`，签发的 `ready → ready` 注明 `publish_list` 同样顺延。数据模型待回写（交主负责人）：02-identity-tenant.md:265 `revoke_reason` 说明里的路径改为 `DELETE /portal/sessions/current`；06-media.md 2.12 `ensureZip` 签名补选项 `retry`（A99：`failed` 行加守卫，不带时 `failed → failed`、不建任务、不升代次）与 `peek`（只查不建：不建行、不升代次、不建任务，只在 `ready` 且文件在时顺延保留期） | A41、A43、A49、A77、A82、A87、A97、A99、A100、A101、A119、A120、A125；复核意见 A、B；`review/xdoc-p01-portal.md`；`review/r2-xd-p01-portal.md`；`review/api-check.md`；m05 3.8、3.9、3.11；m06 2.1、2.8、2.9；`06-media.md:403`；`03-staff-authz-audit.md` 2.10；m08 3.27；`10-delivery.md:191`、`1070`；`06-media.md:962-970`；校验库 `delivery_download_log`、`analytics_event` |
| 2026-10-03 | 第三轮。① 2.1 删去 `CursorPage`、`SignedUrl` 的本地定义，改为引用约定 C42 的通用结构 `CursorPage<T>` 与 a01 的 `SignedUrl`（下载页 OpenAPI 文档由契约包共享）；清单删去两条 `schemas`，新增 `externalSchemas` 登记两者。② 3.4 说明里旧名 portal.session.get 不再以 operationId 形式书写（api-check 第 6 节）。③ `LicensePeriod`、`LicenseConsent` 注明按 A150 归属本文，m05 已引用。④ 清单 `SentryEnvelope` 的说明补 Content-Type，与 a01、m08 一致。⑤ 依据范围更新为 A1–A150、C1–C87；第 6 节两项仍需产品、法务决定，未被 A127–A150 关闭，保留。路线图切片无须改动（本文没有驳回接口，不涉及 C86） | A132、A150；C42、C87；`review/r3-in-p01-portal.md` |
