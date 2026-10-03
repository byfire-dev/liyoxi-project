# 商家端：商城、选剧单与订购

| 项 | 内容 |
| --- | --- |
| 范围 | 小程序首页聚合与待办（M:Main）、商城配置、短剧商城列表与搜索（M:Mall、M:Search）、短剧详情（M:Detail；M:Trailer 整页 V1.0 不做）、选剧单（M:Cart）、订购报价与确认订购（M:Checkout）、订购成功（M:PayResult）、我的订单与订单详情（M:Orders、M:OrderDetail）、我的短剧与上线记录页头（M:MyDramas、M:LaunchRecord）；“我的”（M:Mine）、客服中心（M:Service）、钱包过期页（M:WalletExpired）引用本文的列表接口 |
| 接口数 | 21（V1.0 17，V1.1 4） |
| 依据 | 接口裁决 `api-rulings.md` A1–A146；通用约定 `conventions.md` C1–C87；资源登记表 `resources.json`；数据模型 `docs/data-model/09-order-ad.md`（选剧单、订购单、订单项、取消申请）、`05-content.md`（剧目、许可、版权、统计）、`07-billing-ledger.md`（价目、订阅、冻结单、账本操作、计价快照），并引用 02、04、06、10、11、12、13、14 分组的列；草案 `d3-flow.md` 第 4、5、23 节与附录 B、`d1-ledger.md` 第 5 节与 11.2–11.4、`d8-content.md` 第 5、6 节、`d6-notify-docs-data.md` 4.3、`d4-identity.md` 5.2–5.3；原型梳理 `proto-merchant-a.md` 1.2–1.11、1.15、`proto-merchant-b.md` 1.24；设计规范第 11、12 节；风险文档第 0 节 |

路径省略前缀 `/api/v1`。引用写法同约定：`文件:行号`；`09:196` 指 `docs/data-model/09-order-ad.md` 第 196 行，`05:`、`07:` 等同理；草案写作 `d3:416`。

## 1. 概览

本文覆盖商家从逛商城到下单、再到查看订单与已订剧目的接口。首页、待办、商城配置、商城列表、搜索、详情对游客开放（`optional` / `public`），游客与店员只看标价积分；选剧单、报价、订购、订单与“我的短剧”只对老板开放。确认订购在一个事务里建订购单与订单项、逐部冻结积分、记协议同意；订购单状态不由接口直接改，由订单项阶段推导（09:183-201）。商家自助取消、收藏、选集试看是 V1.1。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `m.home.get` | `GET /m/home` | 首页聚合：城市、Banner、公告条、上线概览、为您推荐、推荐 / 新剧两栏、选剧单数 | `optional`；店员 `trimmed` | none（查询） |
| `m.todo.list` | `GET /m/todos` | 待办（首页至多 3 条、订单卡片置顶） | `member`；`todo.read`；店员 `trimmed` | none（查询） |
| `m.mallConfig.get` | `GET /m/mall-config` | 商城配置：分类、筛选项、排序项、热门搜索词 | `public` | none（查询） |
| `m.drama.list` | `GET /m/dramas` | 商城列表：关键词、分类、题材、行业、集数、积分价、排序、游标分页 | `optional`；`catalog.read`；店员 `trimmed` | none（查询） |
| `m.drama.search` | `GET /m/dramas/search` | 搜索：剧名、题材、主演；未命中时按行业兜底 | `optional`；`catalog.read`；店员 `trimmed` | none（查询） |
| `m.drama.get` | `GET /m/dramas/{dramaId}` | 短剧详情 | `optional`；`catalog.read`；店员 `trimmed` | none（查询） |
| `m.drama.trialEpisode.list` | `GET /m/dramas/{dramaId}/trial-episodes` | V1.1：选集试看 | `optional`；`catalog.read` | none（查询） |
| `m.favorite.create` | `POST /m/favorites` | V1.1：收藏 | `member` | required |
| `m.favorite.delete` | `DELETE /m/favorites/{favoriteId}` | V1.1：取消收藏 | `member` | required |
| `m.cartItem.list` | `GET /m/cart-items` | 选剧单（当前门店） | `member`；`cart.*`；店员 403 | none（查询） |
| `m.cartItem.create` | `POST /m/cart-items` | 加入选剧单 | `member`；`cart.*`；店员 403 | natural（`uq_cart_item_store_id_drama_id`） |
| `m.cartItem.delete` | `DELETE /m/cart-items/{cartItemId}` | 移出选剧单 | `member`；`cart.*`；店员 403 | required |
| `m.cartItem.acceptPrice` | `POST /m/cart-items/{cartItemId}/accept-price` | 确认新价格 | `member`；`cart.*`；店员 403 | required |
| `m.order.quote` | `POST /m/orders/quote` | 订购报价（纯计算） | `member`；`order.create`；店员 403 | none（试算） |
| `m.order.create` | `POST /m/orders` | 确认订购：冻结积分，建订购单与订单项，记协议同意 | `member`；`order.create`；店员 403 | required |
| `m.order.list` | `GET /m/orders` | 我的订单（按页签） | `member`；`order.read`；店员 403 | none（查询） |
| `m.order.get` | `GET /m/orders/{orderId}` | 订单详情 | `member`；`order.read`；店员 403 | none（查询） |
| `m.orderItem.list` | `GET /m/order-items` | 我的短剧（以订单项为行） | `member`；`order.read`；店员 403 | none（查询） |
| `m.orderItem.summary` | `GET /m/order-items/summary` | 我的短剧的页签计数 | `member`；`order.read`；店员 403 | none（查询） |
| `m.orderItem.get` | `GET /m/order-items/{orderItemId}` | 订单项详情（上线记录页头） | `member`；`order.read`；店员 403 | none（查询） |
| `m.cancelRequest.create` | `POST /m/cancel-requests` | V1.1：商家自助申请取消 | `member` | required |

路由注册顺序（A8、C12）：`/m/dramas/search` 先于 `/m/dramas/{dramaId}`；`/m/orders/quote` 先于 `/m/orders/{orderId}`；`/m/order-items/summary` 先于 `/m/order-items/{orderItemId}`。

全部接口的限流档位为 `m.global`（C68）；GET 不写库（A19）；`cursor` 分页的列表默认 `limit` 20、上限 50，不返回总数（C42），例外在各接口写明（`m.cartItem.list` 不分页，已登记在 C42；`m.drama.search` 带 `totalApprox`，A54）。

## 2. 公共结构

### 2.1 观察者与价格口径

- `viewerRole`（C55）：`owner` 老板、`clerk` 店员、`guest` 游客。`optional` 路由在没有凭据、或已登录但对 `X-Store-Id` 没有成员关系时按 `guest` 返回；`member` 路由只有 `owner`、`clerk`。
- 标价 `P`：剧目积分价 `P(drama, now)`，由 billing 的 `DramaPricePort` 按 `drama_price_revision`（未撤销、`effective_at ≤ now` 的最新一行；`custom` 取 `custom_points`）或该剧 `drama.heat_tier` 在 `price_tier_revision` 的模板价得出（07:293）。商家端列表与详情的标价都用它；价格筛选与价格排序也用标价（d8:405）。
- 折后实扣（只给老板，且有生效周期时）：`discountedPoints = round(P × R)`，`R` = 当前生效周期 `subscription_term.discount_bp`（d1:676 的 `quoteDramaItem`，不含顶级模型加扣；计价函数只有 `packages/shared/pricing` 一份）。没有生效周期时为 `null`。
- 可花积分（只给老板）：经 `billing.getWalletView`（m07 第 1 节）取 `Wallet.points.spendablePoints`，本文不另算：套餐生效且主体不在“退款处理中”时 = `billing_account.plan_available_qty + billing_account.addon_available_qty`，否则为 0。“退款处理中”按主体级口径：本主体任一 `status` 为 `scheduled` 或 `active` 的周期 `subscription_term.refund_request_id` 非空（m07 2.0；07:442）。
- “可使用至”：`drama_copyright.license_end_date`（05:295）。接口字段名用 `usableUntilDate`，不用 `license…`：店员视图的黄金文件禁用 `license` 模式（C57）。
- 字典项（题材、行业、定制重点、卖点等）按 C85 出入：响应给 `DictRef[]`（约定 C85 的通用结构 `{ code, name }`，C87），字段名不带 `Codes`；单值字典项给 `DictRef | null`，字段名不带 `Code`（A151，如 `city`、`abnormalReason`）；请求收编码数组，字段名带 `Codes`（`focusCodes`、查询参数 `genreCodes`、`industryCodes`）。
- 签名地址统一 `{ url, expiresAt }`（C60）；海报与图片按 30 分钟对齐窗口现签（C61）。下文类型写作 `SignedUrl`。

### 2.2 `DramaCard` 短剧卡片

商城列表、搜索结果、首页推荐与新剧栏、选剧单、报价共用。

| 字段 | 类型 | 必有 | 店员 / 游客 | 说明 | 来源 |
| --- | --- | --- | --- | --- | --- |
| `dramaId` | string(uuid) | 是 | 返回 | 剧目 | `drama.id` |
| `title` | string | 是 | 返回 | 剧名 | `drama.title` |
| `posterUrl` | SignedUrl \| null | 是 | 返回 | 竖版封面 | `drama.poster_file_id` 现签 |
| `genres` | DictRef[] | 是 | 返回 | 题材 | `drama.genre_codes` + 字典 `genre` 的 `dict_item.name` |
| `totalEpisodes` | integer | 是 | 返回 | 总集数（整部订购） | `drama.total_episodes` |
| `heatTier` | enum(`S`/`A`/`B`/`C`) \| null | 是 | 返回 | 等级；端上显示文案按设计规范第 11 节换成选剧说法 | `drama.heat_tier` |
| `badge` | enum(`new`/`hot`) \| null | 是 | 返回 | 角标：`new` = `drama.first_listed_at` 在首页推荐位配置的 `newDays` 天内；`hot` = 热度等级为 `S`（d8:390 的默认）。显示文案由端上按设计规范第 11 节定 | 计算 |
| `listPricePoints` | integer(积分) \| null | 是 | 返回（目录标价白名单，A86） | 标价 P。上架的剧恒有值（上架校验 L5 要求能解析出 P，d8:340）；只有选剧单里已下架的剧在价格解析不出时为空 | 计算（2.1） |
| `discountedPoints` | integer(积分) \| null | 是 | **不返回** | 老板的折后实扣 | 计算（2.1） |
| `usableUntilDate` | string(date) \| null | 是 | 返回 | 可使用至 | `drama_copyright.license_end_date` |

### 2.3 `Todo` 待办

`m.todo.list` 的元素；订单卡片的 `pinnedTodo`、订单详情的 `pendingTodo`、订单项行的 `pendingTodo` 用同一个派生函数（不建待办表，d3:3103）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `todoId` | string | 是 | `<kind>:<subjectId>`，端上去重与埋点用；不是表主键 | 计算 |
| `kind` | enum（第 4 节 `TodoKind`） | 是 | 待办类型 | 计算 |
| `tag` | enum（第 4 节 `TodoTag`：`to_confirm`/`to_handle`/`failed`） | 是 | 卡片标签“待确认 / 待处理 / 未通过”；`failed` 为红底“未通过”（设计规范第 13 节，design-spec.md:1015） | 按 `kind` 固定映射（3.2 派生表） |
| `title` | string | 是 | 服务端拼好的一句话，如“《巷口那家店》样片已送达，请确认” | 按 `kind` 的文案模板与对象数据 |
| `dueAt` | string(date-time) \| null | 是 | 商家应办结的时刻；没有时限为空 | 见 3.2 的派生表 |
| `urgency` | enum(`overdue`/`due_today`/`normal`) | 是 | 紧急度（排序依据） | 由 `dueAt` 按北京时间算 |
| `subjectType` | string | 是 | 对象表名：`delivery_plan`、`ad`、`sample`、`launch_task`、`takedown_task`、`channel_account`、`store`、`service_ticket`、`store_asset_demand` | 见派生表 |
| `subjectId` | string(uuid) | 是 | 对象 id | 见派生表 |
| `orderId` | string(uuid) \| null | 是 | 所属订购单（与订单有关时） | `delivery_plan.drama_order_id`、`delivery_ticket.drama_order_id` 等 |
| `orderItemId` | string(uuid) \| null | 是 | 所属订单项（按剧的待办） | `delivery_ticket.order_item_id`、`launch_task.order_item_id`、`takedown_task.order_item_id` |
| `link` | `DeepLink`（m08 公共结构 `{ route, params }`） | 是 | 端上深链，路由键与参数见 3.2 派生表；与站内消息、公告条共用一份路由表（13-notify-docs.md:1139） | 按 `kind` 固定 |

### 2.4 `CartItem` 选剧单项

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `cartItemId` | string(uuid) | 是 | 选剧单项 | `cart_item.id` |
| `drama` | DramaCard | 是 | 剧目卡片；已下架的剧同样返回（d8 6.1 的 `getDramaCards`） | 2.2 |
| `state` | enum(`valid`/`price_changed`/`invalid`) | 是 | 读取时计算，不落库（09:72）：剧目不可见（未上架或剩余授权期不足）为 `invalid`；`P ≠ cart_item.list_price_points` 为 `price_changed`；否则 `valid` | 计算 |
| `invalidReason` | enum(`not_listed`/`stopped`) \| null | 是 | `invalid` 时的原因：未上架或已下架；已上架但到了停止订购日（d8 6.1 `getOrderability`） | 计算 |
| `snapshotPricePoints` | integer(积分) | 是 | 加入（或最近一次确认新价格）时的标价 | `cart_item.list_price_points` |
| `currentPricePoints` | integer(积分) \| null | 是 | 当前标价，恒等于 `drama.listPricePoints`；剧目没有可用价格时为空（只可能是 `invalid` 项） | 计算（2.1） |
| `discountedPoints` | integer(积分) \| null | 是 | 按当前价与当前折扣算的实扣；`invalid` 或没有生效周期时为空 | 计算（2.1） |
| `addedAt` | string(date-time) | 是 | 加入时间 | `cart_item.created_at` |
| `priceAckedAt` | string(date-time) \| null | 是 | 最近一次确认新价格 | `cart_item.price_acked_at` |
| `actions` | array<string> | 是 | 可执行动作（C16，取 C12 词表原样）：`price_changed` 时含 `accept-price`；总含 `delete` | 计算 |

### 2.5 `OrderQuote` 订购报价

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `quotedAt` | string(date-time) | 是 | 计价时刻 | 账本时钟 |
| `store` | object | 是 | 订购主体区 | 见下 |
| `store.storeId` | string(uuid) | 是 | 下单门店（= `X-Store-Id`） | `store.id` |
| `store.storeName` | string \| null | 是 | 门店名称 | `store.name` |
| `store.entityName` | string \| null | 是 | 主体名称 | `entity.name` |
| `store.isEntityVerified` | boolean | 是 | 主体“已认证” | `entity.verification_status = verified` |
| `store.contactName` | string \| null | 是 | 门店联系人 | `store_profile.contact_name` |
| `store.contactPhoneMask` | string \| null | 是 | 联系人手机号（脱敏，C40） | `store_profile.contact_phone_mask` |
| `plan` | object | 是 | 当前生效周期的权益 | 见下 |
| `plan.planCode` / `plan.planName` | string | 是 | 套餐版本 | `plan.code`、`plan.name`（经 `subscription_term.plan_id`） |
| `plan.productionModel` | enum（同 `subscription_term.production_model`） | 是 | 默认制作模型 | `subscription_term.production_model` |
| `plan.discountBp` | integer(万分比) | 是 | 订剧折扣 R | `subscription_term.discount_bp` |
| `plan.topModelSurchargeBp` | integer(万分比) | 是 | 顶级模型加扣比例 | `billing_param` 键 `topModelSurchargeBp` 的当前值 |
| `plan.isTopModelIncluded` | boolean | 是 | 套餐已含顶级模型（加扣为 0，d1:676） | `subscription_term.production_model = top` |
| `items` | array<OrderQuoteItem> | 是 | 逐部报价，顺序同请求 | 见下 |
| `items[].drama` | DramaCard | 是 | 剧目卡片 | 2.2 |
| `items[].listPricePoints` | integer(积分) | 是 | P | 计算 |
| `items[].discountBp` | integer(万分比) | 是 | R | `subscription_term.discount_bp` |
| `items[].surchargeBp` | integer(万分比) | 是 | 实际适用的 T（未勾选或旗舰版为 0） | 计算 |
| `items[].chargePoints` | integer(积分) | 是 | 应扣 S = round(P × R × (1 + T)) | `quoteDramaItem`（d1:676） |
| `items[].discountDeltaPoints` | integer(积分) | 是 | 折扣行：round(P × R) − P（负数），展示用 | d1 5.1 规则 2 |
| `items[].surchargeDeltaPoints` | integer(积分) | 是 | 加扣行：S − round(P × R) | d1 5.1 规则 2 |
| `items[].allowedPlacements` | array<enum(`opening`/`ending`)> | 是 | 本剧允许的植入形式（与开放的广告位求交） | `drama.allowed_placements` ∩ 参数 `content.placement.open_slots` |
| `items[].platforms` | array<enum(`douyin`/`wechat_channels`)> | 是 | 授权平台（可选账号的平台上限） | `drama_copyright.platforms` |
| `items[].orderable` | boolean | 是 | 是否可订 | `content.getOrderability`；选了账号时另按 `assertOrderable` 的平台与许可判定 |
| `items[].unorderableReason` | enum（`DRAMA_NOT_ORDERABLE` 的 `reason`）\| null | 是 | 不可订原因 | 同上 |
| `totalChargePoints` | integer(积分) | 是 | ΣS（逐部取整后求和，d1 5.1 规则 1） | 计算 |
| `spendablePoints` | integer(积分) | 是 | 当前可花积分 | 2.1 |
| `pointsShortfall` | integer(积分) | 是 | `max(0, totalChargePoints − spendablePoints)`；> 0 时端上引导加购或升级（是否出现购买入口取 `m.purchasePolicy.get`） | 计算 |
| `allocation` | object | 是 | 扣减来源预览，与真正冻结用同一个 `shared/alloc.allocate()`（d1 5.2） | 见下 |
| `allocation.planLots` | array<{ expiresAt: string(date-time), points: integer }> | 是 | 各套餐批次扣多少、何时清零（快到期优先） | `point_lot.expires_at`、`point_lot.available_qty`（`kind = plan`） |
| `allocation.addonPoints` | integer(积分) | 是 | 加购积分扣多少 | `point_lot.available_qty`（`kind = addon`） |
| `balanceAfter` | object `{ planPoints, addonPoints }` | 是 | 订购后剩余 | `billing_account.plan_available_qty`、`addon_available_qty` 减去上一项 |
| `channelAccounts` | array<QuoteAccount> | 是 | 本门店的渠道账号（不含已解绑） | 见下 |
| `channelAccounts[].channelAccountId` | string(uuid) | 是 | 账号 | `channel_account.id` |
| `channelAccounts[].platform` | enum | 是 | 平台 | `channel_account.platform` |
| `channelAccounts[].accountName` | string | 是 | 账号名称 | `channel_account.account_name` |
| `channelAccounts[].accountUid` | string | 是 | 抖音号 / 视频号 ID | `channel_account.account_uid` |
| `channelAccounts[].accountType` | enum(`enterprise`/`personal`/`none`) \| null | 是 | 认证类型 | `channel_account.account_type` |
| `channelAccounts[].status` | enum（同 `channel_account.status`） | 是 | 账号状态 | `channel_account.status` |
| `channelAccounts[].abnormalReason` | `DictRef` \| null | 是 | 异常原因（字典 `reject_reason`，场景 `account_verify`；`name` 即“主页截图不完整，补充后可选”的前半句；C85、A151，与 m05 `ChannelAccountCard.abnormalReason` 同名同义） | `channel_account.abnormal_reason_code` + `dict_item.name`（`dict_type_key = reject_reason`） |
| `channelAccounts[].isSelectable` | boolean | 是 | `status = available` 且平台在全部所选剧的授权平台内 | 计算 |
| `ads` | array<QuoteAd> | 是 | 本门店可用的广告：`ad.confirmed_version_no` 非空、`ad.status ≠ cancelled`、`ad.open_cancel_request_id` 为空、类型为 `opening` / `ending`；与 `m.ad.list?isSelectable=true`（m06）、提交时 `adIds` 的校验同一口径 | 见下 |
| `ads[].adId` / `ads[].adNo` | string(uuid) / string | 是 | 广告 | `ad.id`、`ad.ad_no` |
| `ads[].type` | enum(`opening`/`ending`) | 是 | 广告位 | `ad.type` |
| `ads[].durationSec` | integer | 是 | 时长（秒） | `ad.duration_sec` |
| `ads[].copy` | string \| null | 是 | 文案 | `ad.copy` |
| `ads[].confirmedVersionNo` | integer | 是 | 已确认版本 | `ad.confirmed_version_no` |
| `ads[].confirmedAt` | string(date-time) | 是 | 确认时间 | `ad.confirmed_at` |
| `earliestLaunchDate` | string(date) | 是 | 可指定的最早上线日：订购日后第 7 个工作日 | `work_calendar_day.is_workday` 逐日累计 |
| `agreement` | object | 是 | 须勾选的《定制内容授权使用协议》现行版本 | 见下 |
| `agreement.agreementKey` | string | 是 | 恒为 `custom_license` | `agreement.key` |
| `agreement.name` | string | 是 | 协议名称（与 m01、m06 的协议结构同名） | `agreement.name` |
| `agreement.agreementVersionId` | string(uuid) | 是 | 当前版本；提交时作为请求体 `agreementVersionId` 带回 | `agreement_version.id`，按 m01 3.12 的唯一解析口径（`pending`、`active` 中 `effective_at <= now` 的最新一条），不按 `status = active` 取 |
| `agreement.versionLabel` | string | 是 | 如 `v1.2` | `agreement_version.major`、`minor` |
| `blockers` | array<`QuoteBlocker`> | 是 | 提交前已知会被拒的原因（结构见下），`code` 取第 5 节或其他文档的错误符号（`STORE_PROFILE_INCOMPLETE`、`STORE_NOT_QUALIFIED`、`INDUSTRY_NOT_OPEN`、`QUOTA_EXCEEDED`、`DRAMA_NOT_ORDERABLE`、`POINTS_INSUFFICIENT`、`PLAN_REFUND_IN_PROGRESS`、`ORDER_ACCOUNT_INVALID`），判定函数与 `m.order.create` 相同；为空才可提交 | 计算 |
| `expect` | object `{ totalChargePoints, items: [{ dramaId, chargePoints }] }` | 是 | 提交时原样带回，供账本在锁内比对（d3:274） | 计算 |

`QuoteBlocker`（公共结构，本文定义，m06 `m.ad.quote` 的 `blockers` 引用；A132、C87）：

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `code` | string | 是 | 错误符号（C27 或各文档第 5 节定义的），端上按符号走与提交被拒时同一套引导 |
| `message` | string | 是 | 默认文案，同该错误码的默认提示 |
| `dramaId` | string(uuid) \| null | 否 | 只在订购报价里出现：针对某部剧的阻断项（`DRAMA_NOT_ORDERABLE`）给剧目 id，整单级的给 `null`；广告报价（m06）不带此键 |

### 2.6 `OrderCard` 订单卡片

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderId` | string(uuid) | 是 | 订购单 | `drama_order.id` |
| `orderNo` | string | 是 | 订购单号 `LYX…` | `drama_order.order_no` |
| `submittedAt` | string(date-time) | 是 | 订购时间 | `drama_order.submitted_at` |
| `status` | enum（同 `drama_order.status`） | 是 | 订购单状态 | `drama_order.status` |
| `subStatus` | enum（同 `drama_order.sub_status`）\| null | 是 | 子状态（“待开工（资质审核中）”等） | `drama_order.sub_status` |
| `tab` | enum（第 4 节 `OrderTab`，不含 `all`） | 是 | 该单归入的商家端页签 | 按 3.16 的映射 |
| `itemCount` | integer | 是 | 部数 | `drama_order.item_count` |
| `firstDramaTitle` | string | 是 | “巷口那家店 等 2 部”的首部剧名 | `item_no = 1` 的 `order_item.drama_snapshot.title` |
| `platforms` | array<enum> | 是 | “整部定制 · 抖音”的平台（去重） | `order_item_account.platform` |
| `totalChargePoints` | integer(积分) | 是 | 应扣合计 | `drama_order.total_charge_points` |
| `pinnedTodo` | Todo \| null | 是 | 该单最紧急的一条待办 | 2.3 |
| `liveSummary` | object \| null | 是 | 有上线中的订单项时：`{ liveItemCount, liveEpisodeCount, earliestUsageEndDate, firstLiveOrderItemId }`（“3 部已上线，共 161 集，最早 2027-06-30 到期”）；`firstLiveOrderItemId`（string(uuid)）是卡片“上线记录”按钮的落点 | `order_item.phase = live` 的行数、`live_episode_count` 之和、`usage_end_date` 最小值；`item_no` 最小的上线中订单项的 `order_item.id` |
| `returnedPoints` | integer(积分) | 是 | 实际退回合计（售后页签展示），= Σ（`returned_points` + `converted_points`） | `order_item.returned_points`、`order_item.converted_points` |
| `actions` | array<string> | 是 | V1.0 恒为空（商家端没有订单级写动作） | — |

### 2.7 `OrderDetail` 订单详情

`m.order.get` 的响应；`m.order.create` 的响应是它再加 `replayed`（3.15，A80）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `orderId`、`orderNo`、`submittedAt`、`status`、`subStatus`、`tab`、`itemCount`、`totalChargePoints` | — | 是 | 同 OrderCard | 同 OrderCard |
| `statusChangedAt` | string(date-time) | 是 | 最近一次状态变化 | `drama_order.status_changed_at` |
| `startedAt` | string(date-time) \| null | 是 | 开始制作（积分扣减） | `drama_order.started_at` |
| `closedAt` | string(date-time) \| null | 是 | 进入已结束、已取消、已退回积分的时间 | `drama_order.closed_at` |
| `entityName` | string \| null | 是 | 订购主体 | `entity.name` |
| `storeId` / `storeName` | string(uuid) / string \| null | 是 | 下单门店 | `drama_order.store_id`、`store.name` |
| `planCode` / `planName` | string | 是 | 下单时的套餐版本 | `drama_order.plan_code`；`plan.name`（按 `plan.code`） |
| `discountBp` | integer(万分比) | 是 | 下单时的折扣 | `drama_order.discount_bp` |
| `isTopModel` | boolean | 是 | 是否勾选顶级模型 | `drama_order.is_top_model` |
| `surchargeBp` | integer(万分比) | 是 | 加扣比例快照 | `drama_order.surcharge_bp` |
| `focus` | DictRef[] | 是 | 定制重点 | `drama_order.focus_codes` + 字典 `custom_focus` |
| `note` | string \| null | 是 | 补充说明 | `drama_order.note` |
| `expectedLaunchDate` | string(date) \| null | 是 | 期望上线日；空 = 成片交付后尽快上线 | `drama_order.expected_launch_date` |
| `referenceStoreAssetIds` | array<string(uuid)> | 是 | 参考素材（素材库） | `store_asset_usage.store_asset_id`（`used_by_type = drama_order`、`used_by_id` = 本单、`role = reference`） |
| `pendingTodo` | Todo \| null | 是 | 状态卡上的待办 | 2.3 |
| `items` | array<OrderItemInOrder> | 是 | 剧目明细，按 `item_no` | 见 2.8 |
| `deliveryPlan` | object \| null | 是 | 交付方案摘要；开工前为空。摘要取“摘要版本”：有已确认版本时取 `version_no = delivery_plan.confirmed_version_no` 的那一版（修订周期内也不取未确认的新推送版本，10-delivery.md:338）；从未确认时取最近推送的版本；尚未推送过时摘要字段为空 | 见下 |
| `deliveryPlan.deliveryPlanId` | string(uuid) | 是 | 方案（详情走 `m.deliveryPlan.get`，m05） | `delivery_plan.id` |
| `deliveryPlan.status` | enum（同 `delivery_plan.status`） | 是 | 方案状态 | `delivery_plan.status` |
| `deliveryPlan.confirmedVersionNo` | integer \| null | 是 | 已确认版本 | `delivery_plan.confirmed_version_no` |
| `deliveryPlan.confirmedAt` | string(date-time) \| null | 是 | 确认时间（“已确认 09-28 15:20”） | `delivery_plan.confirmed_at` |
| `deliveryPlan.summaryVersionNo` | integer \| null | 是 | 下面几项取自哪一版；尚未推送为空 | `delivery_plan_version.version_no`（按上面的规则选） |
| `deliveryPlan.focus` | DictRef[] | 是 | 方案里的定制重点（方案修订可改，与下单时的顶层 `focus` 可能不同）；没有摘要版本为 `[]` | 摘要版本 `content_snapshot.focusTags` + 字典 `custom_focus` |
| `deliveryPlan.launchMode` | enum(`merchant_self`) \| null | 是 | 上线方式 | 摘要版本 `content_snapshot.launchMode` |
| `deliveryPlan.placements` | array<{ slot, durationSec }> | 是 | 植入形式（去重） | 摘要版本 `content_snapshot.items[].placements` |
| `deliveryPlan.agreedLaunchDate` | string(date) \| null | 是 | 约定上线日（各剧相同时给值，不同时为空，看各订单项） | 未取消订单项的 `order_item.agreed_launch_date`（改期写在订单项上，09:275，不取快照） |
| `pointsEvents` | array<PointsEvent> | 是 | 积分明细时间线：冻结、扣减、释放、退回 | 见下 |
| `pointsEvents[].opType` | enum(`hold`/`capture`/`release`/`refund`) | 是 | 账本操作类型 | `ledger_operation.op_type` |
| `pointsEvents[].occurredAt` | string(date-time) | 是 | 发生时刻；同一事务的多部剧合为一行 | `ledger_operation.occurred_at` |
| `pointsEvents[].points` | integer(积分) | 是 | 本行数量：冻结、释放、退回取可用净变动的绝对值；扣减取所涉冻结单的 `qty` 之和 | `ledger_operation.plan_delta_qty`、`addon_delta_qty`；`point_hold.qty` |
| `pointsEvents[].planPoints` / `addonPoints` | integer(积分) | 是 | 其中套餐积分、加购积分（“来自套餐积分”） | `ledger_operation.plan_delta_qty`、`addon_delta_qty` 的绝对值 |
| `afterSales` | array<CancelRecord> | 是 | 取消与退回记录（含已关闭的），按提交时间倒序。**选取规则**：凡有明细行 `cancel_request_line.target_type = order_item` 且 `target_id` ∈ 本单订单项的取消申请都算（经 `ix_cancel_request_line_target_type_target_id` 取，再联回 `cancel_request`）；不按 `cancel_request.drama_order_id` 取——整店取消（`qualification_cancel`）的该列为空（09:474、514）。整店取消同时覆盖别的订购单与广告，所以 `lines` 只给本单订单项的明细行，`totalRefundPoints` 只合计这些行 | 见下 |
| `afterSales[].cancelRequestId` | string(uuid) | 是 | 取消申请 | `cancel_request.id` |
| `afterSales[].requestNo` | string | 是 | 单号 `TK…` | `approval_request.request_no` |
| `afterSales[].status` | enum（同 `cancel_request.status`） | 是 | 执行状态 | `cancel_request.status` |
| `afterSales[].closeReason` | enum（同 `cancel_request.close_reason`）\| null | 是 | 未执行即关闭的原因 | `cancel_request.close_reason` |
| `afterSales[].reasonCode` | enum（同 `cancel_request.reason_code`） | 是 | 取消原因 | `cancel_request.reason_code` |
| `afterSales[].submittedAt` | string(date-time) | 是 | 提交时间 | `cancel_request.created_at` |
| `afterSales[].executedAt` | string(date-time) \| null | 是 | 执行时间 | `cancel_request.executed_at` |
| `afterSales[].kind` | enum（同 `cancel_request.kind`） | 是 | 取消类型：单笔订购取消，或资质终局驳回引起的整店取消 | `cancel_request.kind` |
| `afterSales[].totalRefundPoints` | integer(积分) | 是 | 本单部分的申请退回或释放合计 | Σ 本单明细行的 `cancel_request_line.refund_points`（整店取消时不用 `cancel_request.total_refund_points`） |
| `afterSales[].lines` | array<{ orderItemId, mode, refundPoints, returnedPoints, convertedPoints, forfeitedPoints }> | 是 | 逐剧（只含本单订单项）：账本动作与实际去向（未执行时实际去向为空） | `cancel_request_line.target_id`（`target_type = order_item`）、`mode`、`refund_points`、`returned_points`、`converted_points`、`forfeited_points` |
| `agreements` | array<{ agreementKey, name, agreementVersionId, versionLabel, consentedAt }> | 是 | 协议：《定制内容授权使用协议》取本单的同意记录；本单绑定的广告各自的《广告制作与交付服务协议》同意记录（按版本去重） | `drama_order.agreement_consent_id`、`ad.agreement_consent_id`（经 `order_item_placement.ad_id`）→ `agreement_consent.agreement_key`、`agreement_version_id`、`consented_at`；`agreement.name` |
| `licenseLetters` | array<LicenseLetterBrief> | 是 | 授权书清单（“《定制内容授权书》· 2 份”的份数即本数组长度）；**不含已作废的**（`status <> voided`，与 m05 `m.licenseLetter.list` 缺省 `includeVoided = false`、a05 的计数同口径）。元素是 m05 `LicenseLetterCard` 的子集，字段名、类型、取值与它一致：`licenseLetterId` string(uuid)、`letterNo` string、`orderItemId` string(uuid)、`platform` enum、`accountName` string、`status` enum(`pending_effective`/`effective`)、`displayStatus` enum(`pending_effective`/`effective`/`expired`)、`periodStartDate` string(date) \| null（待生效时为空）、`periodEndDate` string(date)（C15，与 m05 第三轮改名一致）。完整列表走 `m.licenseLetter.list?orderId=`，预览与下载走 `m.licenseLetter.get`、`m.licenseLetter.downloadUrls`（m05） | `license_letter`（`drama_order_id` = 本单、`status <> voided`）的 `id`、`letter_no`、`order_item_id`、`platform`、`status`、`period_start`、`period_end`；`accountName`、`displayStatus` 按 m05 `LicenseLetterCard` 的规则 |
| `actions` | array<string> | 是 | V1.0 恒为空 | — |

### 2.8 `OrderItemInOrder`、`OrderItemRow`、`OrderItemDetail` 订单项

三处共用下表；“范围”一列写该字段出现在哪个结构（D = 订单详情里的剧目明细，R = 我的短剧列表行，G = 订单项详情）。

| 字段 | 类型 | 必有 | 范围 | 说明 | 来源 |
| --- | --- | --- | --- | --- | --- |
| `orderItemId` | string(uuid) | 是 | D R G | 订单项 | `order_item.id` |
| `itemNo` | integer | 是 | D | 订购单内序号 | `order_item.item_no` |
| `orderId` / `orderNo` | string(uuid) / string | 是 | R G | 所属订购单 | `order_item.drama_order_id`；`drama_order.order_no` |
| `dramaId` | string(uuid) | 是 | D R G | 剧目 | `order_item.drama_id` |
| `dramaTitle` | string | 是 | D R G | 下单时剧名（字段名与 m05、a05 的订单项结构一致） | `order_item.drama_snapshot.title` |
| `posterUrl` | SignedUrl \| null | 是 | D R G | 下单时封面 | `order_item.drama_snapshot.posterFileId` 现签 |
| `genres` | DictRef[] | 是 | D R G | 题材 | `order_item.drama_snapshot.genreCodes` + 字典 `genre` |
| `episodeCount` | integer | 是 | D R G | 整部集数 | `order_item.episode_count` |
| `phase` | enum（同 `order_item.phase`） | 是 | D R G | 阶段 | `order_item.phase` |
| `phaseChangedAt` | string(date-time) | 是 | D G | 阶段变化时间 | `order_item.phase_changed_at` |
| `ticketStep` | enum（同 `delivery_ticket.step`）\| null | 是 | D R G | 交付步骤（“样片待确认”“样片制作中”）；待开工、开工前取消没有工单 | `delivery_ticket.step`（`order_item_id` = 本项） |
| `listPricePoints` / `discountBp` / `surchargeBp` / `chargePoints` | integer | 是 | D | 计价快照：“3,000 × 9 折 = 2,700” | `order_item.list_price_points`、`discount_bp`、`surcharge_bp`、`charge_points` |
| `productionModel` | enum（同 `order_item.production_model`） | 是 | D | 制作模型 | `order_item.production_model` |
| `accounts` | array<{ channelAccountId, platform, accountName }> | 是 | D R G | 发布账号（“抖音 @XX火锅”） | `order_item_account.channel_account_id`、`platform`；`channel_account.account_name` |
| `accounts[].accountUid` / `accountType` | string / enum \| null | 是 | G | 账号 ID 与认证类型 | `channel_account.account_uid`、`account_type` |
| `placements` | array<{ slot, adId, adNo, durationSec, boundVersionNo }> | 是 | D | 广告位绑定；`boundVersionNo` 为空表示浮动 | `order_item_placement.slot`、`ad_id`、`duration_sec`、`bound_version_no`；`ad.ad_no` |
| `agreedLaunchDate` | string(date) \| null | 是 | D R G | 约定上线日 | `order_item.agreed_launch_date` |
| `usageStartDate` | string(date) \| null | 是 | D R G | 上线首日；空 = 从未上线（页面写“上线首日至 …”） | `order_item.usage_start_date` |
| `usageEndDate` | string(date) | 是 | D R G | 使用期止日 | `order_item.usage_end_date` |
| `usageEndSource` | enum（同 `order_item.usage_end_source`） | 是 | D G | 止日来源 | `order_item.usage_end_source` |
| `remainingDays` | integer \| null | 是 | R G | “剩 273 天” = `usage_end_date` − 今天（北京时间），不小于 0；只在 `phase = live` 时给值 | 计算 |
| `liveEpisodeCount` | integer | 是 | D R G | 已核验上线集数（“待上线 · 0/80 集”） | `order_item.live_episode_count` |
| `returnPoints` | object `{ refundRequestedPoints, returnedPoints, convertedPoints, forfeitedPoints }` | 是 | D | 四个退回数量；商家实际拿回的积分 = `returnedPoints + convertedPoints`，`forfeitedPoints` 是原周期已结束、不予退回的部分（09:269-272） | `order_item.refund_requested_points`、`returned_points`、`converted_points`、`forfeited_points` |
| `cancelReasonCode` / `cancelledAt` | enum \| null / string(date-time) \| null | 是 | D | 取消或终止原因与时间 | `order_item.cancel_reason_code`、`cancelled_at` |
| `timeline` | array<TimelineNode> | 是 | D | 按剧的交付时间轴（d3:561-573：多部剧时按剧切换） | 见下 |
| `timeline[].key` | enum（第 4 节 `TimelineNodeKey`） | 是 | D | 节点 | — |
| `timeline[].state` | enum(`done`/`current`/`todo`) | 是 | D | 第一个未完成的节点为 `current` | 计算 |
| `timeline[].at` | string(date-time) \| string(date) \| null | 是 | D | 完成时刻；`usage_ended` 尚未发生（`usage_ended_at` 为空）时给 `usage_end_date`（日期） | 下表 |
| `pendingTodo` | Todo \| null | 是 | R | 该剧的待办（“去确认样片”） | 2.3 |

时间轴节点的取值（d3:561-573）：

| `key` | 完成时刻 |
| --- | --- |
| `submitted` | `drama_order.submitted_at` |
| `started` | `drama_order.started_at` |
| `manager_assigned` | `delivery_ticket.assigned_at` |
| `plan_confirmed` | `delivery_ticket.plan_confirmed_at` |
| `ads_confirmed` | `delivery_ticket.ads_ready_at` |
| `sample_confirmed` | `delivery_ticket.sample_confirmed_at` |
| `delivered` | `delivery_ticket.delivered_at` |
| `live` | `delivery_ticket.live_at` |
| `usage_ended` | `delivery_ticket.usage_ended_at`（里程碑：使用期结束、进入到期下架，10-delivery.md:109）；为空时给 `order_item.usage_end_date`（日期） |

节点说明文案（如“片头 5 秒、片尾 10 秒（第 2 版）”）由端上按方案与广告的当前数据拼（d3:573），不随本接口返回。订单项被取消或终止时，时间轴停在最后一个完成的节点，其后节点为 `todo`，端上按 `phase` 显示“已取消 / 已终止”。

M:LaunchRecord 页头（剧名、题材、整部集数、阶段、订单号、使用期、剩余天数）只以 `m.orderItem.get`（G 列）为准；m05 的 `LaunchTaskDetail` 不再另带订单项头部（见修订记录与 `cross_doc`）。

### 2.9 供其他模块调用的计数与只读端口

不是 HTTP 接口，是 order 模块对外注册的服务层函数（与 3.2 的待办派生同属本文），其他文档的接口按此取数，不另起口径。

| 端口 | 调用方 | 口径 |
| --- | --- | --- |
| `order.countOpenOrdersByEntity(tx, entityId)` | m01 注销守卫（`DeletionBlockerKind = open_order`，A134） | 主体名下“未结订购单”数：`drama_order.status` ∉ {`ended`,`cancelled`,`refunded`}（与 09:219 的“未结订购单”同一定义，含 `live` 与 `after_sale`）。上线中的成片另由 `release_online` 一项计（不在本端口） |
| `StoreCloseGuard.countBlocking(tx, storeId)`（order 模块注册的一项） | m02 门店停用守卫（`StoreBlockerKind = open_order`，`STORE_HAS_OPEN_WORK.details.blockers`） | 该门店“在办订购”数：`drama_order.status` ∈ {`pending_start`,`producing`,`to_launch`,`after_sale`}。不含 `live`：停用不要求门店没有上线中的成片（d4:794），上线中的单子停用后仍可查看、下载、确认下架 |
| `order.countOrderItemsByPhase(tx, storeId)` | 本文 `m.orderItem.summary`；m02 `StoreCard.liveCount` / `deliveringCount`；m08 `m.me.overview.get` 的 `storeStats` | 一次返回 `{ all, live, to_launch, ended, delivering }`：前四个同 3.18 的页签映射；`delivering` = `order_item.phase` ∈ {`producing`,`to_launch`}（“交付中”，不含待开工）。各页面按需取其中的键 |
| `order.countTodos(tx, storeId, viewerRole)` | m02 `StoreCard.todoCount`（老板口径与店员口径）；m08 概览的 `adPendingConfirmCount`、`ticketAwaitingConfirmCount` | 与 3.2 的派生函数同源，返回总数与按 `kind` 的分项 |
| `order.getOrderNos(tx, dramaOrderIds)` | m03 素材详情时间线（“用于订单 LYX…”） | `Map<drama_order.id, drama_order.order_no>`，只读；不校验门店归属（调用方已按素材归属过滤） |
| `order.countCartBadge(tx, storeId)` | 本文 `m.home.get` 的 `cartCount` 字段；m08 概览的 `cartCount` | 选剧单角标：当前门店 `cart_item` 中 `state ≠ invalid` 的行数（2.4 的计算；口径见第 6 节第 3 项） |

## 3. 接口

### 3.1 m.home.get　首页聚合

`GET /m/home`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `optional`；无能力点；店员视图 `trimmed`，游客视图 `guest` |
| 幂等 | none（纯查询，GET 不写库，A18、A19） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Main；补充状态：下拉刷新（设计规范第 12 节） |
| 出处 | 路线图 `m04.home.get`；d6:1681-1686、2246；d4:373；d8:395；proto-merchant-a.md:119 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `cityCode` | string | 否 | 字典 `region` 的编码 | 游客或门店未建档时由端上定位逆解析后传入；已建档门店以档案为准，忽略此参数 |

**响应 `data`**

| 字段 | 类型 | 必有 | 老板 | 店员 | 游客 | 说明 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `viewerRole` | enum | 是 | ✔ | ✔ | ✔ | 观察者角色 | C55 |
| `city` | `DictRef` \| null | 是 | ✔ | ✔ | ✔ | 顶部城市（市级行政区划字典项；C85、A151） | `store_profile.city_code` + 字典 `region`；游客取查询参数 |
| `banners` | array<{ homeBannerId, title, imageUrl: SignedUrl, jumpKind, jumpTarget }> | 是 | ✔ | ✔ | ✔ | 当前生效的 Banner，至多 5 张，按 `position`。`jumpKind` 取 `drama` / `mall` / `page` / `none`，`jumpTarget` 的结构按 a09 的 `BannerJumpTarget`（`{ dramaId }` / `{ categoryKey }` / `DeepLink` 形态的 `{ route, params }` / `null`）。发布后引用失效的（剧目已不在架、分类已不在已发布的商城配置里、路由键不在深链路由表里）在组装时跳过，不报错 | `home_banner.id`、`title`、`image_file_id`、`jump_kind`、`jump_target`；条件 `is_enabled` 且 `start_at ≤ now < coalesce(end_at, ∞)` |
| `noticeBar` | object \| null | 是 | ✔ | ✘ | ✘ | 规则变更公告条，至多 1 条：`{ siteNoticeId, title, summary, effectiveAt, link: DeepLink }`。正文按读取时的购买入口模式（m07 购买策略的 `mode`）取：`offline_contract` 用 `summary_no_price`，它为空（协议版本类公告）时用 `summary`；其余模式用 `summary`；`hidden` 模式不返回公告条（`null`） | `site_notice.id`、`title`、`summary` / `summary_no_price`、`effective_at`、`link`；条件 `status = announced AND bar_enabled AND announced_at ≤ now < effective_at + 7 天`，取 `announced_at` 最新的一条（`ix_site_notice_bar`；14-config-data.md:535-537） |
| `launchOverview` | object \| null | 是 | ✔ | ✘ | ✘ | 上线概览：`{ liveItemCount, liveEpisodeCount, spendablePoints, planName, termEndDate, expiringPlanPoints, planPointsExpireAt }`；从未开通套餐时套餐三项为空。积分三项经 `billing.getWalletView`（m07 第 1 节）取：`spendablePoints` = `Wallet.points.spendablePoints`（主体级退款口径，2.1），`expiringPlanPoints` 即 `Wallet.points.planAvailablePoints`（首页文案“到期清零”，字段名保留），`planPointsExpireAt` = `Wallet.points.planPointsExpireAt` | 当前门店 `order_item.phase = live` 的行数与 `live_episode_count` 之和；`plan.name`、`subscription_term.end_date`；积分三项见左 |
| `recommend` | object \| null | 是 | ✔ | ✘ | ✘ | 为您推荐：`{ matchBy: { industry: DictRef, category: DictRef \| null } \| null, items: DramaCard[] }`（字典 `industry` 的一级、二级项；C85、A151）；门店未建档时 `matchBy` 为空，给推荐栏同口径的列表（d8:395） | `store_profile.industry_code`、`category_code`；`drama.industry_codes` 含该行业；首页推荐位配置 `home_recommend` 的 `pins`、`recommendCount` |
| `hot` | array<DramaCard> | 是 | ✔ | ✘ | ✔ | “推荐”栏 4 部（原型“热门短剧”，文案按设计规范第 11 节改） | d8:395 的热门口径（等级与 `drama_stat.orders_30d`） |
| `new` | array<DramaCard> | 是 | ✔ | ✘ | ✔ | 新剧 4 部 | `drama.first_listed_at` 在 `home_recommend.newDays` 天内，倒序 |
| `defaultTab` | enum(`hot`/`new`) | 是 | ✔ | ✘ | ✔ | 两栏的默认页签 | `site_config_revision.content.defaultTab`（`config_key = home_recommend`，已发布版） |
| `cartCount` | integer | 是 | ✔ | ✘ | ✘ | 底部导航选剧单角标：不含失效项（`state = invalid`），含变价项（与原型一致：3 行里 1 行失效，角标为 2，Cart.dc.html:33-35、47；Main.dc.html:123） | `order.countCartBadge`（2.9；口径见第 6 节第 3 项） |

店员视图只有 `viewerRole`、`city`、`banners`；店员首页的“素材需求”“我上传的 N 条 · M 条被采用”分别取 `m.assetDemand.list` 与 `m.storeAsset.summary?uploader=me`（m03，C56）。游客视图没有 `noticeBar`、`launchOverview`、`recommend`、`cartCount`。DramaCard 在店员与游客视图里不带 `discountedPoints`。

**错误**：无（通用错误按约定不重复）。

**副作用**：无。

**说明**

- 公共部分（Banner、两栏列表、配置版本）进配置缓存，有效期 = min(60 秒, 下一个 Banner 或公告起止时刻 − now)；个性部分（上线概览、为您推荐、公告条按购买入口模式选正文）现算或 30 秒短缓存（d6 4.3.3）。
- 待办不在本接口，首页调 `m.todo.list?limit=3`（路线图备注）。
- V1.0 的公告只以首页公告条出现；公告列表页（`m.siteNotice.list`，m08）是 V1.1。
- 受平台约束：“热播”“热度”等字样换成选剧说法，“为你推荐”改为“为您推荐”（设计规范第 11 节）；接口只给枚举，文案在端上。

### 3.2 m.todo.list　待办

`GET /m/todos`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `todo.read`（A87，增补表：老板、店员都有，已停用门店的老板也有）；店员视图 `trimmed` |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Main（待办提醒）、M:Orders（卡片置顶待办）、M:OrderDetail（状态卡）、M:Mine |
| 出处 | 路线图 `m04.todo.list`；d3:3099-3101；proto-merchant-a.md:119、128；design-spec.md:1015；A87 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `limit` | integer | 否 | 1–50，默认 20 | 首页传 3 |
| 查询 | `cursor` | string | 否 | 不透明 | C42；首页只取第一页 |
| 查询 | `orderId` | string(uuid) | 否 | 本门店的订购单 | 只看该单的待办 |
| 查询 | `orderItemId` | string(uuid) | 否 | 本门店的订单项 | 只看该剧的待办 |

**响应 `data`**（`TodoPage` = `CursorPage<Todo>`（约定 C42 的通用结构，C87）加判别字段 `viewerRole`）：`{ viewerRole, items: Todo[], nextCursor, hasMore }`（2.3；游标分页，不返回总数，C42）。`viewerRole` 是老板与店员两个 schema 的判别字段（C55）；店员 schema 的 `items` 只含 `kind = asset_demand`，`Todo` 的字段相同。排序按紧急度：已过期 → 今日到期 → 其余按 `dueAt` 升序，没有时限的排最后，同级按 `todoId`（d3:3101）；游标编码（紧急度、`dueAt`、`todoId`）。

派生来源（老板；店员只有最后一行）：

| `kind` | 条件 | `tag` | `subjectType` | `dueAt` | `link`（`route` / `params`） |
| --- | --- | --- | --- | --- | --- |
| `plan_confirm` | `delivery_plan.status = pending_confirm` | `to_confirm` | `delivery_plan` | 空 | `delivery.plan` / `{ deliveryPlanId, storeId }` |
| `ad_confirm` | `ad.status = pending_confirm` | `to_confirm` | `ad` | 空 | `ad.detail` / `{ adId, storeId }` |
| `sample_confirm` | 当前版本 `sample.status = pushed` | `to_confirm` | `sample` | 所属工单 `delivery_ticket.step_due_at`（`step = sample_confirm` 时） | `delivery.sample` / `{ orderItemId, storeId }` |
| `launch_submit` | `launch_task.review_status` ∈ {`pending`,`need_fix`} 且 `launch_task.completed_at` 为空 | `to_handle` | `launch_task` | 订单项 `order_item.agreed_launch_date` 当日 24:00 | `publish.task` / `{ storeId, launchTaskId }` |
| `takedown_confirm` | `takedown_task.status = pending_merchant` | `to_handle` | `takedown_task` | `takedown_task.due_date` 当日 24:00 | `offline.task` / `{ storeId, takedownTaskId }` |
| `channel_account_fix` | `channel_account.status = abnormal` | `failed`（“未通过”，design-spec.md:1015） | `channel_account` | 空 | `account.detail` / `{ channelAccountId, storeId }` |
| `qualification_fix` | `store.qualification_status = rejected` 且最近一轮 `qualification_submission.final_rejected_at` 为空 | `failed`（“未通过”） | `store` | 空 | `profile.review` / `{ storeId }` |
| `ticket_confirm` | `service_ticket.status = awaiting_confirm` | `to_confirm` | `service_ticket` | `service_ticket.auto_resolve_at` | `ticket.detail` / `{ serviceTicketId, storeId }` |
| `asset_demand` | `store_asset_demand.status = open`；店员口径另加 `store_asset_demand.notify_scope = owner_and_clerks`（与 `m.assetDemand.list` 对店员的行过滤一致，m03） | `to_handle` | `store_asset_demand` | `store_asset_demand.due_date` 当日 24:00 | `asset.demand` / `{ storeAssetDemandId, storeId }` |

深链的路由键取 d6 场景注册表已用的键（`delivery.plan`、`ad.detail`、`delivery.sample`、`publish.task`、`offline.task`、`profile.review`、`ticket.detail`，d6-notify-docs-data.md:233-249）；`account.detail`、`asset.demand` 两个键与各路由补的对象 id 参数由 m08 在 `DeepLink` 路由表登记（见 `cross_doc`）。

**错误**：`NOT_FOUND`（`orderId`、`orderItemId` 不在当前门店）。

**副作用**：无。

**说明**：店员视图只含 `notify_scope = owner_and_clerks` 的 `asset_demand`（C56）。只有老板能看到需要确认的待办（d3:3101）。派生查询，不建待办表；与 `m.order.list`、`m.order.get`、`m.orderItem.list` 的置顶待办共用同一个派生函数，计数经 `order.countTodos`（2.9）供 m02 门店卡的 `todoCount`（老板口径与店员口径）与 m08 概览的“广告待确认”“工单待确认”使用。

### 3.3 m.mallConfig.get　商城配置

`GET /m/mall-config`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `public`；店员视图 `same` |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Mall、M:Search |
| 出处 | 路线图 `m04.mall-config.get`；d6:1627-1636、1768、2246；d8:378；14-config-data.md:1097-1106 |

**请求**：无。

**响应 `data`**（`MallConfigView`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `revNo` | integer | 是 | 已发布修订号；端上按引导接口的 `versions.site` 缓存（d7:506） | `site_config_revision.rev_no`（`config_key = mall`、`status = published`） |
| `categories` | array<{ key, name, genres: DictRef[] }> | 是 | 分类标签，只含 `visible` 的项；“全部”固定在首位。`genres` 是该分类展开的题材（C85：响应给 `DictRef[]`，不带 `Codes` 后缀） | `site_config_revision.content.categories`（存 `genreCodes`）+ 字典 `genre` 的 `dict_item.name` |
| `hotWords` | array<string> | 是 | 热门搜索词，至多 8 个，名次按数组顺序；V1.0 不展示“热 / 新”标记（d8:378） | `content.hotWords` |
| `filters` | object `{ genre, industry, episodes, price: boolean, episodeBands, priceBands }` | 是 | 筛选项开关与分档；分档元素 `{ key, label, min: integer \| null, max: integer \| null }`，`min` / `max` 为空表示不设界，集数按 `drama.total_episodes`、积分价按标价 P（14 分组 4.3 只给了两个键名；后台商城配置页按此结构对齐，a09） | `content.filters` |
| `sorts` | array<enum(`composite`/`heat`/`price_asc`/`price_desc`/`newest`)> | 是 | 可用排序项 | `content.sorts` |
| `defaultSort` | enum（同上） | 是 | 默认排序 | `content.defaultSort` |
| `genres` | DictRef[] | 是 | 题材字典（启用项） | `dict_item.code`、`name`（`dict_type_key = genre`、`is_enabled`） |
| `industries` | DictRef[] | 是 | 适配行业（一级、开放且启用） | `dict_item`（`dict_type_key = industry`、`parent_code` 为空、`is_enabled`、`ext.open`） |

**错误**：无。

**副作用**：无。

**说明**：只读聚合视图（资源登记表 `mall-config`）。发布后引用失效（题材被停用）的项在组装时跳过（d6 4.3.1）。

### 3.4 m.drama.list　商城列表

`GET /m/dramas`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `optional`；能力点 `catalog.read`；店员视图 `trimmed`（与游客一致：有标价，无折后实扣，C56） |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `m.global`；开关 `weapp.trailer.feed`（默认关）关闭时端上不提供预告片模式，本接口不受影响 |
| 对应画板 | M:Mall、M:Main（“更多”）、M:Trailer（V1.0 不做）；补充状态：触底加载、下拉刷新 |
| 出处 | 路线图 `m04.drama.list`；d8:511；d8 5.2；d4:374；A34；proto-merchant-a.md:194 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `q` | string | 否 | 1–20 字 | 关键词（A34）；匹配规则同 3.5，不做行业兜底 |
| 查询 | `category` | string | 否 | `MallConfigView.categories[].key` | 分类标签，展开为题材集合求交 |
| 查询 | `genreCodes` | string | 否 | 逗号分隔的题材编码（C45、C85） | 题材 |
| 查询 | `industryCodes` | string | 否 | 逗号分隔的一级行业编码（C45、C85） | 适配行业；原型“仅看适配餐饮”由端上传门店行业 |
| 查询 | `episodeBand` | string | 否 | `filters.episodeBands[].key` | 集数档 |
| 查询 | `priceBand` | string | 否 | `filters.priceBands[].key` | 积分价档（按标价 P） |
| 查询 | `sort` | enum | 否 | `composite`/`heat`/`price_asc`/`price_desc`/`newest`，须在配置的 `sorts` 内 | 缺省取 `defaultSort` |
| 查询 | `cursor` | string | 否 | 不透明 | 首页不传 |
| 查询 | `limit` | integer | 否 | 1–50，默认 20 | 每页 20 条（PRD.md:526） |

**响应 `data`**

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `viewerRole` | enum | 是 | C55 |
| `viewerPlan` | object `{ planName, discountBp }` \| null | 是 | 只给有生效周期的老板（“专业版实扣”的版本名）；店员、游客为空 |
| `items` | array<DramaCard> | 是 | 2.2 |
| `nextCursor` | string \| null | 是 | C42 |
| `hasMore` | boolean | 是 | C42 |

**错误**：`VALIDATION_FAILED`（`sort` 不在配置的排序项内、分档键不存在）。

**副作用**：无。

**说明**

- 只返回可见的剧：`drama.status = listed`，且剩余授权期不少于 `billing_param` 键 `minLicenseMonths`（按自然月回推，d8 5.1 的 `visible`）。
- 综合排序四项加权（热度等级、`drama_stat.orders_30d`、`drama.first_listed_at`、`drama.manual_boost`），权重取 `content.weights`；归一化与同分规则按 d8 5.2 实现第 2 条。`heat` 排序按等级，同级按近 30 天订购倒序。
- 实现为“取全部可见的剧 → 内存筛选与打分 → 分页”，结果按“商城配置版本 + 剧目价格版本 + 筛选条件”缓存 60 秒（d8 5.2 实现第 1 条）；游标编码排序快照与偏移，快照失效时返回第一页并重置。
- 不返回播放量、更新进度一类字段（05-risks-and-open-issues.md:84）。受平台约束：V1.0 去掉“列表 / 预告片”切换，预告片整页不做（设计规范第 11 节）；日后开放时复用本接口。

### 3.5 m.drama.search　搜索

`GET /m/dramas/search`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `optional`；能力点 `catalog.read`；店员视图 `trimmed` |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `m.global`；行业兜底受参数键 `catalog.search.industry_fallback`（`param_value`，布尔，默认开）控制：d8 5.2 要求可关，A107 把它列为补登的参数键（不是 `flags.ts` 开关）。关闭时未命中直接返回空结果 |
| 对应画板 | M:Search |
| 出处 | 路线图 `m04.drama.search`；d8:512、5.2；A24、A54；proto-merchant-a.md:155-158 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `q` | string | 是 | 1–20 字 | 关键词；先去掉空格与“·” |
| 查询 | `cursor` | string | 否 | 不透明 | — |
| 查询 | `limit` | integer | 否 | 1–50，默认 20 | — |

**响应 `data`**

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `viewerRole` | enum | 是 | C55 | — |
| `viewerPlan` | object \| null | 是 | 同 3.4 | — |
| `mode` | enum(`match`/`industry_fallback`) | 是 | 命中；或未命中、关键词属于某品类时按行业兜底 | 计算 |
| `fallbackIndustry` | object `{ code, name, keywordCategoryName }` \| null | 是 | 兜底时的一级行业与关键词对应的品类（“已为您推荐适配餐饮行业的短剧”） | 字典 `industry`（关键词等于二级品类名，取其 `parent_code`） |
| `items` | array<DramaSearchItem> | 是 | DramaCard 加 `matchedFields: array<enum(title/genre/cast)>`；剧名命中排在题材、主演命中之前 | `drama.title`、`drama.genre_codes`（题材名双向包含，d8 5.2）、`drama.cast_names` |
| `nextCursor` / `hasMore` | — | 是 | C42 | — |
| `totalApprox` | integer | 是 | “找到 N 部短剧”，封顶 999（A54，C42 的唯一例外） | 计算 |

**错误**：`VALIDATION_FAILED`（`q` 为空或超长）。

**副作用**：无。

**说明**：只在可见的剧里搜。搜索历史存端上本地，不建表（d8:635）；热门搜索词取 `m.mallConfig.get`。端上防抖、边输边搜。兜底推荐规则仍待产品确认（PRD 12.3 第 9 项，第 6 节），故做成可关的参数。命中高亮由端上按 `matchedFields` 自行切分。

### 3.6 m.drama.get　短剧详情

`GET /m/dramas/{dramaId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `optional`；能力点 `catalog.read`；店员视图 `trimmed`（无折后实扣、可用积分与即将清零，C56） |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `m.global`；`weapp.video.trailer.enabled` 打开时才返回预告片 `trailer`（d7:512），V1.0 业务决定不播放（风险文档第 0 节），恒为空 |
| 对应画板 | M:Detail、M:Trailer（V1.0 不做） |
| 出处 | 路线图 `m04.drama.get`；d8:513、6.2；proto-merchant-a.md:270；设计规范第 11 节 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaId` | string(uuid) | 是 | — | 剧目 |

**响应 `data`**（`DramaDetail`：DramaCard 的全部字段，另加下表）

| 字段 | 类型 | 必有 | 店员 / 游客 | 说明 | 来源 |
| --- | --- | --- | --- | --- | --- |
| `viewerRole` | enum | 是 | 返回 | C55 | — |
| `orderability` | object `{ orderable: boolean, reason: enum(not_listed/stopped) \| null }` | 是 | 返回 | 已下架或到了停止订购日仍返回详情，按钮置灰（选剧单“查看详情”可达） | `content.getOrderability` |
| `episodeDurationSec` | integer \| null | 是 | 返回 | 单集时长 | `drama.episode_duration_sec` |
| `producerName` | string \| null | 是 | 返回 | 出品方 | `drama.producer_name` |
| `castNames` | string \| null | 是 | 返回 | 主演 | `drama.cast_names` |
| `synopsis` | string \| null | 是 | 返回 | 剧情简介 | `drama.synopsis` |
| `roles` | array<{ name, actor, desc }> | 是 | 返回 | 主要角色，顺序即展示顺序 | `drama.roles` |
| `industries` | DictRef[] | 是 | 返回 | 适配行业 | `drama.industry_codes` + 字典 `industry` |
| `targetAudience` | string \| null | 是 | 返回 | 目标观众 | `drama.target_audience` |
| `sellingTags` | array<{ code, name, description }> | 是 | 返回 | 卖点标签；推荐理由取其说明（d8 6.2） | `drama.selling_tag_codes` + 字典 `selling_tag` 的 `name`、`description` |
| `dramaClass` | enum(`class_1`/`class_2`/`class_3`) \| null | 是 | 返回 | 微短剧类别 | `drama.drama_class` |
| `allowedPlacements` | array<enum> | 是 | 返回 | 本剧开放的植入形式 | `drama.allowed_placements` ∩ `content.placement.open_slots` |
| `placementDurations` | array<{ slot: enum(`opening`/`ending`), durationSecOptions: integer[] }> | 是 | 返回 | 植入说明里各植入形式的可选时长（“片头贴片 3–5 秒、片尾贴片 5–10 秒”），只列 `allowedPlacements` 里的形式 | 参数键 ad.duration_options（A146 登记，默认 `{ opening: [3, 5], ending: [5, 10] }`，与 m06 `AdQuote.typeOptions` 同源，09-order-ad.md:693） |
| `platforms` | array<enum> | 是 | 返回 | 授权平台 | `drama_copyright.platforms` |
| `permits` | array<{ platform, kind, number }> | 是 | 返回 | 许可信息（活动行） | `drama_permit.platform`、`permit_kind`、`permit_no`（`status = active`） |
| `adUnitPoints` | integer(积分) | 是 | 返回（目录标价白名单） | 广告每条积分（植入说明） | `billing_param` 键 `adUnitPoints` |
| `topModelSurchargeBp` | integer(万分比) | 是 | 返回 | 顶级模型加扣比例 | `billing_param` 键 `topModelSurchargeBp` |
| `trailer` | object `{ playableId, posterUrl, durationMs }` \| null | 是 | 返回 | 开关关闭时为空；播放地址走 `m.playable.get`（m06） | `drama_trailer.current_playable_asset_id` → `playable_asset.id`、`cover_file_id`、`duration_ms` |
| `owner` | object \| null | 是 | **不返回** | 老板专有：见下 | — |
| `owner.planName` / `owner.productionModel` | string / enum | 是 | — | 当前版本与默认制作模型（“高级模型（专业版）”） | `plan.name`；`subscription_term.production_model` |
| `owner.discountBp` | integer(万分比) | 是 | — | 订剧与广告折扣 | `subscription_term.discount_bp` |
| `owner.adDiscountedPoints` | integer(积分) | 是 | — | 广告折后每条（“专业版 45 积分”）= round(`adUnitPoints` × R) | d1 5.1 `quoteAd` |
| `owner.spendablePoints` | integer(积分) | 是 | — | 当前可用 | 2.1 |
| `owner.expiringPlanPoints` | integer(积分) | 是 | — | 本期套餐积分，到期清零；即 m07 `Wallet.points.planAvailablePoints`（经 `billing.getWalletView`） | `billing_account.plan_available_qty` |
| `owner.planPointsExpireAt` | string(date-time) \| null | 是 | — | 清零时刻（不含的终点，= 止日次日 00:00 北京时间，07-billing-ledger.md:484）；不要直接格式化成日期显示 | `subscription_term.ends_at` |
| `owner.termEndDate` | string(date) \| null | 是 | — | 本期止日，“其中 1,920 将于 10-12 清零”显示它（与首页 `launchOverview.termEndDate` 同源） | `subscription_term.end_date` |
| `owner.cartItemId` | string(uuid) \| null | 是 | — | 已在当前门店选剧单里时给值（按钮显示“已加入”） | `cart_item.id`（`store_id`、`drama_id`） |

没有生效周期的老板：`owner` 仍返回，`discountBp`、`adDiscountedPoints`、`planName`、`productionModel`、`planPointsExpireAt`、`termEndDate` 为空（类型相应可空），`discountedPoints` 为空。

`roles`（角色介绍）沿用数据模型列名 `drama.roles`：本结构里另有 `castNames`（主演），改叫 `cast` 会与它混淆；a04 后台编辑接口的字段名见 `cross_doc`。

**错误**：`NOT_FOUND`（剧目不存在、草稿或已归档）。

**副作用**：无。端上埋点 `drama_detail_view`。

**说明**：受平台约束：顶部预告片播放区改为封面大图加文字，去掉“选集试看”（设计规范第 11 节）；“写进剧情”一类定制说明文案收敛（设计规范第 11 节）。定制说明、授权范围、订购须知是不随剧变化的文案，不建字段（d8 6.2）。

### 3.7 m.drama.trialEpisode.list　选集试看（V1.1）

`GET /m/dramas/{dramaId}/trial-episodes`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `optional`；`catalog.read`；店员视图暂记 `same`，届时定 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 对应画板 | M:Detail（V1.0 去掉该区块） |

V1.1，细节待设计。路径为建议，届时按 A5 改用 `drama-episodes` 的视图（资源登记表 `trial-episodes`）。试看集数取 `drama.trial_episode_count`（空取参数 `trial.episodes`）。开放前须重新评估小程序内播放剧集被认定为微短剧小程序的风险（风险文档 1.2）。开关 `release.trial_episodes` 默认关。

### 3.8 m.favorite.create　收藏（V1.1）

`POST /m/favorites`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点届时定；店员视图暂记 `same` |
| 幂等 | required |
| 乐观锁 | 不适用 |
| 对应画板 | M:Detail、M:Trailer |

V1.1，细节待设计。请求体 `{ dramaId }`。V1.0 不建表（PRD.md:545）；原型详情页的收藏可点，按 PRD 不做。

### 3.9 m.favorite.delete　取消收藏（V1.1）

`DELETE /m/favorites/{favoriteId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点届时定 |
| 幂等 | required |
| 乐观锁 | 不适用 |
| 对应画板 | M:Detail |

V1.1，细节待设计。届时按 A7 核对收藏行是否允许物理删除，不允许则改为 `POST …/{favoriteId}/<动作>`（A64）。

### 3.10 m.cartItem.list　选剧单

`GET /m/cart-items`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `cart.*`；店员 403 `ROLE_FORBIDDEN`（端上显示“仅老板可订购”空态，不调本接口，d7:545） |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Cart；补充状态：下拉刷新 |
| 出处 | 路线图 `m04.cart-item.list`；d3:3506、4.1；d1 5.5；09:70；proto-merchant-a.md:307 |

**请求**：无（门店取 `X-Store-Id`）。

**响应 `data`**

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `items` | array<CartItem> | 是 | 当前门店的选剧单，按加入时间倒序 | `cart_item`（`ix_cart_item_store_id_created_at`） |
| `limit` | integer | 是 | 上限 50 部（d3:268） | 常量 |
| `plan` | object `{ planName, discountBp }` \| null | 是 | 顶部说明“实扣积分按当前套餐（专业版 9 折）计算”；没有生效周期为空 | `plan.name`、`subscription_term.discount_bp` |
| `spendablePoints` | integer(积分) | 是 | 底部栏“可用 2,920，还差 X” | 2.1 |

**错误**：无（通用错误）。

**副作用**：无。

**说明**

- 不分页：一次返回全部（不超过 50 部），已登记为 C42 的有界小集合例外（A78）。
- 合计与“还差 X”由端上按所选项的 `discountedPoints` 求和展示，以 `m.order.quote` 为准。变价未确认的项不可勾选（proto-merchant-a.md:309）。
- 折扣变化（升级套餐）不算变价：R 不是 P 的一部分，列表按当前 R 现算（d1 5.5）。

### 3.11 m.cartItem.create　加入选剧单

`POST /m/cart-items`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `cart.*`；店员 403；已停用门店 403 `STORE_ARCHIVED`（C17，m02 定义） |
| 幂等 | natural：`uq_cart_item_store_id_drama_id`（09:90）。同店同剧已存在时返回已有项（200，不改快照价），不要求 `Idempotency-Key` |
| 乐观锁 | 不带；上限由事务级咨询锁 `cart:{store_id}` 加计数保证（09:72） |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Detail（加入选剧单）、M:Trailer（V1.0 不做） |
| 出处 | 路线图 `m04.cart-item.create`；d3:268、3506；proto-merchant-a.md:231、273 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 请求体 | `dramaId` | string(uuid) | 是 | 可见的剧 | 落 `cart_item.drama_id` |

**响应 `data`**：CartItem（2.4）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 剧目不存在、是草稿或已归档（与 `m.drama.get` 一致，C24） |
| `DRAMA_NOT_ORDERABLE` | 409 | 剧目已下架（`reason = not_listed`），或在架但到了停止订购日，即剩余授权期不足（`reason = stopped`） |
| `CART_LIMIT_REACHED` | 409 | 本门店选剧单已有 50 部（`details.limit`） |

**副作用**：插入 `cart_item`：`entity_id` 取自门店、`store_id` = `X-Store-Id`、`added_by_user_id` = 当前用户、`list_price_points` = 当前标价 P、`price_acked_at` 为空、`created_at` / `updated_at` = 当前时钟。不写状态历史、不发事件。

**说明**：按门店保存，不按用户（09:72；待确认见 09 第 6 节第 1 项）。加入不冻结积分。尚未建主体的用户没有成员关系，端上先走建档 `m.entity.create`（m02，d4:622）。

### 3.12 m.cartItem.delete　移出选剧单

`DELETE /m/cart-items/{cartItemId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `cart.*`；店员 403 |
| 幂等 | required（A17；重放返回上次成功结果，不回 404） |
| 乐观锁 | 不带 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Cart |
| 出处 | 路线图 `m04.cart-item.delete`；09:62；A7；C12 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `cartItemId` | string(uuid) | 是 | 本门店的选剧单项 | — |

**响应 `data`**：`null`。

**错误**：`NOT_FOUND`（不存在或不在当前门店；同键重放不会走到这里）。

**副作用**：物理删除该 `cart_item` 行（09:62 允许物理删除）。

**说明**：原型有效项没有删除按钮，实现时用左滑或编辑态（proto-merchant-a.md:320）。

### 3.13 m.cartItem.acceptPrice　确认新价格

`POST /m/cart-items/{cartItemId}/accept-price`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `cart.*`；店员 403 |
| 幂等 | required（A17；路线图原写“天然幂等”取消） |
| 乐观锁 | 不带 `lockVersion`（`cart_item` 没有 `lock_version`）；请求体带页面上看到的新价，与当前价比对 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Cart（“确认新价格”） |
| 出处 | 路线图 `m04.cart-item.accept-price`；d3:267、3506；09:81-82；proto-merchant-a.md:309 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `cartItemId` | string(uuid) | 是 | 本门店的选剧单项 | — |
| 请求体 | `acceptedPricePoints` | integer(积分) | 是 | > 0 | 页面显示的新价（“调整为 2,200”），须等于当前标价 |

**响应 `data`**（`CartItemAcceptResult`）：CartItem（确认后 `state = valid`）加 `replayed: boolean`。按 C50“结果脱敏”（A80）：响应含签名地址 `drama.posterUrl`，幂等记录只存置空后的结果；同键重放时 `drama.posterUrl` 为 `null`、`replayed = true`，端上需要封面时重拉 `m.cartItem.list`。置空路径登记在路由元数据 `x-redact-on-replay`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `CART_PRICE_CHANGED` | 409 | 当前标价与 `acceptedPricePoints` 不等（又调价了），`details.currentPricePoints` 带最新价 |
| `DRAMA_NOT_ORDERABLE` | 409 | 剧目已不可见（该项已失效，只能删除） |
| `NOT_FOUND` | 404 | 不存在或不在当前门店 |

**副作用**：同一条 UPDATE 写 `cart_item.list_price_points` = 当前标价、`price_acked_at` = 当前时钟、`updated_at`。快照价已等于当前价时不写库，直接返回成功。

**说明**：动作名 `accept-price` 按 C12 保留（草案写作 `…/ack-price`）。

### 3.14 m.order.quote　订购报价

`POST /m/orders/quote`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `order.create`；店员 403 |
| 幂等 | none（试算，不写库、不缓存，A18、A20） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Checkout（进入页面与改动勾选项时）、M:Cart（去订购）、M:Detail（立即订购） |
| 出处 | 路线图 `m04.order.quote`；d1:676-698（5.2）；d3:274、3507；proto-merchant-a.md:349、311 |

**请求体**（`OrderQuoteBody`）

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `dramaIds` | array<string(uuid)> | 是 | 1–50 个，不重复 | 本次订购的剧（从详情页单剧直达或从选剧单多选） |
| `isTopModel` | boolean | 否 | 默认 false | 是否按次选用顶级模型（整单一份） |
| `channelAccountIds` | array<string(uuid)> | 否 | 每平台至多 1 个 | 已勾选的发布账号；给了则按所选平台判定可订与许可覆盖 |

**响应 `data`**：OrderQuote（2.5）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `SUBSCRIPTION_INACTIVE` | 409 | 没有生效周期，算不出折扣 R（端上引导开通或续费） |
| `VALIDATION_FAILED` | 400 | 剧目数超限、重复、同平台多选账号 |

**副作用**：无。

**说明**

- 报价不锁价：提交时账本在账户锁内按当时的 `now` 重算并与 `expect` 比对（d1 5.2；d3:274），所以报价不进幂等记录、也没有有效期。
- 积分不足、门店闸门不过、门店超限、剧目不可订、账号不可选都不报错，写进 `blockers` 由页面展示；端上积分不足时引导加购或升级，弹窗里“去加购 / 去升级”是否出现取 `m.purchasePolicy.get` 的 `allowPurchasePrompt`（m07）。
- 下单门店取 `X-Store-Id`；原型不可改选，PRD 6.8 允许改选同主体已认证门店（第 6 节待确认）。
- 发布账号、参考素材、广告的完整列表与选择器分别是 `m.channelAccount.list`（m05）、`m.storeAsset.list?usableAsReference=true`（m03）、`m.ad.list?isSelectable=true&type=opening|ending`（m06）；本接口只带确认订购页直接要用的那部分，判定口径与提交时一致。
- 协议的当前版本也可从 `m.agreement.list?scene=order_submit`（m01）取；本接口的 `agreement` 与它调同一个解析函数（m01 3.12：按 `effective_at` 实时解析，不看 `status`），所以新版本到点后报价给的就是提交时会校验的那一版，不会出现“报价给旧版、提交判过期”的循环。

### 3.15 m.order.create　确认订购

`POST /m/orders`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `order.create`；店员 403；已停用门店 403 `STORE_ARCHIVED`（m02） |
| 幂等 | required（防重复冻结，A17；`Idempotency-Key` 在进入确认订购页时生成，改了表单内容换键，C48）；结果脱敏（A80，见“响应”） |
| 乐观锁 | 不带 `lockVersion`（新建）；价格与折扣的一致性由 `expect` 在账本锁内比对 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Checkout；成功后进 M:PayResult（`sub/order/result?type=order`，d7:560） |
| 出处 | 路线图 `m04.order.create`；d3:390-444、3507；d1:1439-1450；09:196、249、351；07:843；13-notify-docs.md:815、845；d6:861；proto-merchant-a.md:353 |

**请求体**（`OrderCreateBody`）

| 字段 | 类型 | 必填 | 约束 | 说明 | 落到 |
| --- | --- | --- | --- | --- | --- |
| `dramaIds` | array<string(uuid)> | 是 | 1–50 个，不重复 | 订购的剧 | 每部一行 `order_item.drama_id`；`drama_order.item_count` |
| `channelAccountIds` | array<string(uuid)> | 是 | 至少 1 个；每平台至多 1 个；本门店、`status = available` | 发布账号（整单一份，逐项落库，d3 4.3） | 每个订单项各一组 `order_item_account` |
| `focusCodes` | array<string> | 是 | 至少 1 个；字典 `custom_focus` 的启用编码 | 定制重点 | `drama_order.focus_codes` |
| `referenceStoreAssetIds` | array<string(uuid)> | 否 | ≤9 项，不重复；本门店素材；`store_asset.deleted_at` 为空、`moderation_state` 不是 `block`、`usability` 不是 `need_reshoot`（09:68）。与 m06 广告提交的参考素材同一守卫、同一上限、同一错误（`VALIDATION_FAILED`，`fieldErrors.path` 指到数组下标） | 参考素材（选择器 `m.storeAsset.list?usableAsReference=true`，m03） | `file_ref`（`ref_type = drama_order`、`role = reference`）与 `store_asset_usage`（`used_by_type = drama_order`、`role = reference`） |
| `note` | string | 否 | ≤ 200 字（契约层校验，09:67） | 补充说明 | `drama_order.note` |
| `isTopModel` | boolean | 否 | 默认 false | 顶级模型（整单一份） | `drama_order.is_top_model`；`surcharge_bp` |
| `adIds` | array<string(uuid)> | 否 | 至多 2 个，类型不重复；本门店、`ad.confirmed_version_no` 非空、`ad.status ≠ cancelled`、`ad.open_cancel_request_id` 为空；类型在每部剧允许的植入形式内（与报价的 `ads[]`、m06 `isSelectable` 同一口径） | 本单使用的已确认广告（片头、片尾各至多 1 条）；可空，方案确认时再选 | 每个订单项各一组 `order_item_placement`：`order_item_placement.slot` 取 `ad.type`；`order_item_placement.bound_version_no` 为空，即浮动；`order_item_placement.duration_sec` 取 `ad.duration_sec` |
| `expectedLaunchDate` | string(date) \| null | 否 | 不早于报价的 `earliestLaunchDate` | 期望上线日；空 = 成片交付后尽快上线 | `drama_order.expected_launch_date` |
| `agreementVersionId` | string(uuid) | 是 | 须是《定制内容授权使用协议》（`custom_license`）此刻的当前版本（m01 3.12 的解析口径），否则 `AGREEMENT_VERSION_STALE`（不是该协议的版本也按此返回） | 勾选的协议版本，取自报价的 `agreement.agreementVersionId`。交易接口只提交版本 id，服务端按版本行补协议键（m01 2.7 末段；不用 `ConsentInput`，它只用于用户级协议） | `agreement_consent.agreement_version_id`；`agreement_key` 由服务端从版本行取 |
| `expect` | object `{ totalChargePoints, items: [{ dramaId, chargePoints }] }` | 是 | 来自报价 | 账本逐部比对 S | 不落库 |

**响应 `data`**（`OrderCreateResult`）：OrderDetail（2.7）加 `replayed: boolean`。PayResult 页直接用它渲染（冻结积分 = `totalChargePoints`、订单号、首部剧名、可使用至），刷新时调 `m.order.get`；专属服务经理名片取 `m.serviceManager.get`（m08）。

按 C50“结果脱敏”（A80）：响应含签名地址 `items[].posterUrl`，幂等记录只存置空后的结果；同键重放（弱网重发、401 后重放）时 `items[].posterUrl` 为 `null`、`replayed = true`，端上据此改调 `m.order.get` 取封面。置空路径登记在路由元数据 `x-redact-on-replay`。

**错误**（单事务内 12 项校验，任何一项不过整体回滚，d3:416-429）

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STORE_PROFILE_INCOMPLETE` | 409 | 门店建档必填项不齐（`profile.assertProfileComplete`，前三步必填，d9:632）；符号归 m03（A123） |
| `STORE_NOT_QUALIFIED` | 409 | 门店闸门 `profile.storeGate` 为 `blocked`（不是 `full` / `parallel`）：新增门店未通过；首店未提交、已驳回待补正、终局驳回（d3:419、431-437）；本文定义（第 5 节，A77） |
| `INDUSTRY_NOT_OPEN` | 409 | 门店行业不在开放名单（m03） |
| `QUOTA_EXCEEDED` | 409 | 主体名下启用的门店数超过当前套餐上限（降级后超限，全部门店不能新订购，风险文档 2.3；`tenant.assertWithinQuota`）；m02 定义，`details` 为 `{ storesUsed, storeLimit, storesOver }` |
| `SUBSCRIPTION_INACTIVE` | 409 | 套餐不在生效中（`billing.hold` 在账户锁内判定） |
| `PLAN_REFUND_IN_PROGRESS` | 409 | 主体处于套餐退款处理中，可花积分为 0（07:442） |
| `DRAMA_NOT_ORDERABLE` | 409 | 某部剧不可订：未上架、到了停止订购日、所选平台不在授权平台内、许可不覆盖所选平台（`content.assertOrderable`，`details` 带 `dramaId` 与 `reason`） |
| `ORDER_ACCOUNT_INVALID` | 409 | 发布账号不在本门店或不是可用状态（`details` 带 `channelAccountId` 与 `reason`） |
| `ORDER_AD_INVALID` | 409 | 广告不在本门店、没有确认版本、已取消、有在途取消、类型不在某部剧允许的植入形式内（`details.reason`） |
| `FILE_NOT_USABLE` | 400 | 参考素材通过了上面的素材守卫，但登记 `file_ref` 时 `files.link()` 断言底层文件不可用（未入库或已被拦截；m03 定义，46001） |
| `LAUNCH_DATE_TOO_EARLY` | 400 | 期望上线日早于订购日后第 7 个工作日（`details.earliestLaunchDate`） |
| `AGREEMENT_VERSION_STALE` | 409 | `agreementVersionId` 不是 `custom_license` 的当前版本（事务内按 m01 3.12 解析，d6 3.4）；`details` 按 m01（`{ agreementKey, currentAgreementVersionId }`）；端上重调报价并要求重新勾选 |
| `QUOTE_CHANGED` | 409 | 账本在锁内重算的逐部 S 与 `expect` 不一致。符号与 `details` 归 m07（43007，`QuoteChangedDetails`，A131）；订购时取 `points` 分支：`{ kind: 'points', totalChargePoints, items: [{ dramaId, chargePoints }] }`，即重算后的合计与逐部应冻结积分。端上重调 `m.order.quote` 展示新价、让用户重新确认，提交时换新键（内容变了，C48） |
| `POINTS_INSUFFICIENT` | 409 | 可用积分不足 ΣS（m07 43009，`details` 为 `{ requiredPoints, spendablePoints, shortfallPoints }`，A131） |
| `ACCOUNT_BUSY` | 503 | 等积分账户锁超过 3 秒（m07 定义，43008，可重试）；端上用同一幂等键自动重试 |
| `VALIDATION_FAILED` | 400 | 定制重点为空或编码无效、说明超长、同平台多选账号、广告类型重复；参考素材超过 9 项、重复，或不在本门店、已删除、被拦截、需重拍（`fieldErrors.path` 如 `referenceStoreAssetIds.2`，与 m06 广告提交一致） |

**副作用**（一个事务；写入顺序按 09:64、249）

1. 预生成订购单与各订单项的 id；`order_no` 经 `biz_sequence` 取 `LYX` 号。
2. `agreements.assertConsents`（传版本 id，服务端从版本行补协议键并按 m01 3.12 判当前版本）：插入一行 `agreement_consent`（`agreement_key = custom_license`、`scene = order_submit`、`biz_type = drama_order`、`biz_id` = 订购单 id、`biz_no` = 订购单号、`method = checkbox`）。
3. 逐部 `billing.hold(ref_type = order_item, ref_id = 订单项 id, group_ref = 订购单号, pricing = { kind: drama, dramaId, topModel }, expectS, titleCode = order_hold, titleArgs)`：`point_hold: (新建) → held`（07:843）；同事务写 `point_hold_alloc`、`ledger_operation`（`op_type = hold`，`op_key = hold:order_item:{id}`，`title_code = order_hold`、`title_args`）、`point_ledger_entry`（`available → held`）、`billing_account` 缓存列（07 第 2.15 节写入顺序）。账户行锁由第一次 `hold` 取得并持有到提交。`titleArgs` 按 m07 第 4.5 节 `order_hold` 取**整单**的值：`dramaTitles`（全部剧名，按 `item_no`）、`count`（部数）、`pricePoints`（各部标价 P，与 `dramaTitles` 同序）、`discountBp`、`surchargeBp`；同一订购单的每次 `hold` 传相同的 `titleArgs`，积分明细按 `group_ref` 合并为一行时无论取哪一条操作，标题都一样（“订购《巷口那家店》《二次开业》”）。
4. 插入 `drama_order`：`drama_order.status: — → pending_start`（`order.submit`，09:196）；`sub_status` 为 `qualification_reviewing`（闸门 `parallel`）或 `starting`（闸门 `full`）；写 `subscription_term_id`、`plan_code`、`discount_bp`、`is_top_model`、`surcharge_bp`、`total_charge_points`、`agreement_consent_id`、`delivery_manager_id`（取 `store.delivery_manager_id`，可空）、`submitted_at`、`status_changed_at`。
5. 插入 `order_item`：`order_item.phase: — → pending_start`（`order.submit`，09:351）；`drama_snapshot` = `content.assertOrderable` 返回的 `DramaSnapshot`（09 第 4.1 节），`pricing_snapshot` = `hold` 返回的快照，`usage_end_date` = 快照的 `licenseEndDate`，`point_hold_id` = 冻结单。插入 `order_item_account`、`order_item_placement`。
6. 参考素材：`file_ref`、`store_asset_usage` 各一行（09:68、1158-1165）。
7. 写 `status_transition`（machine `drama_order` 一行、`order_item` 每部一行）与审计。
8. 删除本门店选剧单里本次订购的剧（`cart_item`，d3 4.1 第 5 条）。
9. 门店闸门为 `full`（资质已通过）时登记定时器 `order.start`（键 `order.start:drama_order:{id}`，`fire_at = now + order.start_delay_minutes`，09:205-212）；`parallel` 时不登记，由 `store.qualification.approved` 的订阅者登记。
10. 出站事件 `order.submitted`（聚合 `drama_order`，d3:2712；订阅者：订购成功通知 `m.order_submitted`、埋点 `order_submit`）；账本每张冻结单另发一条 `billing.points.held`（聚合 `billing_account`，07 第 5.5 节）。两个事件都在 x01 事件目录里。

**说明**

- 不在此事务里开工：开工（冻结转扣减、建交付工单）由定时器 `order.start` 完成（d3 4.4 要点 4；归属表见 `x01-events-jobs`）。
- 多部剧时整单一份配置（账号、定制重点、顶级模型、广告、期望上线日），逐部计价、逐部落库（d3 4.3）。
- 点“确认订购”时端上先同步请求订阅点位 `order_submit` 的授权，用户拒绝不影响下单（d6:861；d3 4.4 要点 6）。
- 加锁顺序：本事务不预先锁账户；账户行锁在第一次 `hold` 时取得，之后只做插入与删除选剧单行（d3 4.4 要点 3）。
- 门店闸门、建档齐全、门店额度的判定与报价 `blockers` 用同一组函数（`profile.storeGate`、`profile.assertProfileComplete`、`tenant.assertWithinQuota`）；`STORE_NOT_QUALIFIED` 同时被 m05 的渠道账号绑定、m06 的广告提交引用，三处判定同源。

### 3.16 m.order.list　我的订单

`GET /m/orders`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `order.read`（已停用门店的老板可用）；店员 403 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:Orders、M:Service（提交工单时选“关联订单”）、M:Mine（入口）；补充状态：触底加载、下拉刷新 |
| 出处 | 路线图 `m04.order.list`；d3:3508、5.4；09:185-190；A24；proto-merchant-a.md:420、426 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum | 否 | `all`/`producing`/`to_launch`/`live`/`ended`/`after_sale`，默认 `all` | 页签（路线图 `group=` 改，A24） |
| 查询 | `no` | string | 否 | 完整订购单号 | 按单号查找（C11） |
| 查询 | `cursor` / `limit` | — | 否 | C42 | — |

页签与状态的映射（d3:548-555，待产品确认，见第 6 节）：

| `tab` | `drama_order.status` |
| --- | --- |
| `producing` | `pending_start`、`producing` |
| `to_launch` | `to_launch` |
| `live` | `live` |
| `ended` | `ended` |
| `after_sale` | `after_sale`、`cancelled`、`refunded` |

**响应 `data`**：`{ items: OrderCard[], nextCursor, hasMore }`，按 `submitted_at` 倒序（`ix_drama_order_store_id_submitted_at`）。

**错误**：无（通用错误）。

**副作用**：无。

**说明**：订单页页签不带数字，不需要 `summary`（A23）。卡片的“查看进度 / 上线记录 / 联系客服”是端上路由，按 `status` 显示，不进 `actions`。“上线记录”入口在订单级，跳 `liveSummary.firstLiveOrderItemId` 的上线记录页（页头 `m.orderItem.get`；任务清单 `m.launchTask.list?orderItemId=…&tab=all`，缺省的 `tab=todo` 会漏掉已全部核验通过与已作废的任务；核验项、时间线、巡检记录逐个取 `m.launchTask.get`，m05），不需要再逐卡查订单项。客服中心提交工单时的“关联订单”选择器用本接口（可带 `no=` 精确查找，m08）。

### 3.17 m.order.get　订单详情

`GET /m/orders/{orderId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `order.read`；店员 403 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:OrderDetail、M:PayResult（刷新时） |
| 出处 | 路线图 `m04.order.get`；d3:3508、5.4；A4；proto-merchant-a.md:454、389；d7:560 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderId` | string(uuid) | 是 | 本门店的订购单 | — |

**响应 `data`**：OrderDetail（2.7）。

**错误**：`NOT_FOUND`（不存在或不在当前门店）。

**副作用**：无。

**说明**

- 方案 id 字段写作 `deliveryPlanId`（A4，原 `planId`）；方案全文与确认在 m05（`m.deliveryPlan.get`）。方案摘要按已确认版本给（2.7），修订周期内页面的“已确认 09-28 15:20”与摘要内容对应同一版。
- “《定制内容授权书》· N 份”只计未作废的授权书，点进去走 `m.licenseLetter.list?orderId=`（m05）。
- 积分明细逐剧一行取 `items[]` 的计价快照（“3,000 × 9 折 = 2,700”）；冻结、扣减、释放、退回的时间线取 `pointsEvents`；取消与退回取 `afterSales`，实际退回以账本返回的数量为准（09:19）。
- 授权书预览（授权方、被授权方、剧名与集数、许可信息、授权平台与账号、期限、权利范围、专属声明）取 m05 的 `m.licenseLetter.get`。“正式授权书以双方签章版本为准”先不写死（设计规范第 11 节）。
- 订购单状态是推导结果，商家端只读（09:183）。

### 3.18 m.orderItem.list　我的短剧

`GET /m/order-items`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `order.read`；店员 403 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:MyDramas、M:Mine（入口）、M:WalletExpired（列出仍在交付的剧名） |
| 出处 | 路线图 `m04.order-item.list`；proto-merchant-b.md:401-406；09:245、291；A24 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum | 否 | `all`/`live`/`to_launch`/`ended`，默认 `all` | 页签（路线图 `phase=` 改，A24） |
| 查询 | `orderId` | string(uuid) | 否 | 本门店的订购单 | 只看该单的剧 |
| 查询 | `cursor` / `limit` | — | 否 | C42 | — |

页签与阶段的映射（原型“待上线”含制作中的剧，MyDramas:17-33；待产品确认，见第 6 节）：

| `tab` | `order_item.phase` |
| --- | --- |
| `all` | 除 `cancelled` 外的全部 |
| `live` | `live` |
| `to_launch` | `pending_start`、`producing`、`to_launch` |
| `ended` | `ended`、`refunded`、`terminated` |

**响应 `data`**：`{ items: OrderItemRow[], nextCursor, hasMore }`（2.8 的 R 列）。排序：`live` 按 `usage_end_date` 升序；`to_launch` 按 `agreed_launch_date` 升序（空的在后）；`ended` 按订购时间倒序；`all` 先按阶段分组（上线中 → 待开工、制作中、待上线 → 已结束、已退回、已终止），组内沿用该组页签的排序。这样游标翻页时行按组连续返回，端上按行的 `phase` 插“上线中 · N 部”“待上线 · N 部”的分组标题（原型“全部”页签是分组展示，MyDramas.dc.html:36-51；数字取 `m.orderItem.summary`）。所有排序最后追加 `order_item.id`（C44）。“全部”是否列出已结束的剧待产品确认（第 6 节第 2 项），缺省列在最后一组。

**错误**：`NOT_FOUND`（`orderId` 不在当前门店）。

**副作用**：无。

**说明**：页签计数取 `m.orderItem.summary`（A23）。“上线记录”跳 M:LaunchRecord（页头 `m.orderItem.get`；任务清单 `m.launchTask.list?orderItemId=…&tab=all`；核验项、时间线、巡检记录取 `m.launchTask.get`，m05）；“去确认样片”取行上的 `pendingTodo`。页底提示“结束前 30 天、7 天、1 天提醒您下架”是静态文案。钱包过期页的“已订购的短剧继续交付”列表用 `tab=to_launch`（m07）。

### 3.19 m.orderItem.summary　我的短剧页签计数

`GET /m/order-items/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `order.read`；店员 403 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:MyDramas（“上线中 · 3 部”“待上线 · 2 部”） |
| 出处 | 路线图 `m04.order-item.summary`；A23；C83；MyDramas.dc.html:36 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `orderId` | string(uuid) | 否 | 同列表 | 查询参数同列表（除 `tab` 与分页，C83） |

**响应 `data`**：`{ all: integer, live: integer, to_launch: integer, ended: integer, delivering: integer }`。前四个键与列表的 `tab` 取值一致，口径同 3.18 的映射；`delivering` 是同口径的副指标（C83）：`order_item.phase` ∈ {`producing`,`to_launch`}，即“交付中”，不含待开工。计数走 `ix_order_item_store_id_phase`，由 `order.countOrderItemsByPhase`（2.9）算出。

**错误**：`NOT_FOUND`（`orderId` 不在当前门店）。

**副作用**：无。

**说明**：“我的”页的“上线中 / 交付中”（`m.me.overview.get`，m08）与门店卡的 `liveCount` / `deliveringCount`（`m.store.list`，m02）取同一个计数函数的 `live`、`delivering`；本页“待上线”页签的 `to_launch` 含待开工，与“交付中”是两个口径，各取各的键。

### 3.20 m.orderItem.get　订单项详情

`GET /m/order-items/{orderItemId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `order.read`；店员 403 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `m.global`；无开关 |
| 对应画板 | M:LaunchRecord（页头）、M:MyDramas |
| 出处 | 路线图 `m04.order-item.get`；proto-merchant-a.md:599、610；09:245 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `orderItemId` | string(uuid) | 是 | 本门店的订单项 | — |

**响应 `data`**：OrderItemDetail（2.8 的 G 列）。

**错误**：`NOT_FOUND`。

**副作用**：无。

**说明**：草案没有该接口。它是 M:LaunchRecord 页头的唯一来源（剧名 `dramaTitle`、题材、整部集数、阶段、订单号、使用期、`remainingDays` 只在上线中给值且不小于 0）；各账号的任务清单取 `m.launchTask.list?orderItemId=…&tab=all`（缺省 `tab=todo` 不含已全部核验通过与已作废的任务），核验项、回填与核验时间线、巡检记录取 `m.launchTask.get`（列表不带，m05）；是否向商家展示核验人与巡检人姓名由 m05 定（proto-merchant-a.md 1.15 补充规则 1）。

### 3.21 m.cancelRequest.create　商家自助申请取消（V1.1）

`POST /m/cancel-requests`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点届时定；店员 403 |
| 幂等 | required |
| 乐观锁 | 不适用 |
| 对应画板 | 原型无（商家自助取消与退款申请，V1.1） |

V1.1，细节待设计。路径为建议。V1.0 不做商家自助取消，由客服在后台发起（`admin.order.cancelRequest.create`，a05；d3:60）；届时把 `order_cancel` 的提交权限放开给商家，核算函数不变（d3:3363），迁移为 `cancel_request.status: — → pending_approval`（`cancel.submit`，09:547）。V1.0 商家端只读取消结果：订单详情的 `afterSales` 与订单列表的“售后”页签。

## 4. 枚举

| 名称 | 取值 | 含义 / 说明 |
| --- | --- | --- |
| `drama_order.status` | 同数据模型 `drama_order.status` | 订单 `status` |
| `drama_order.sub_status` | 同数据模型 `drama_order.sub_status`（09:141-151） | 订单 `subStatus` |
| `order_item.phase` | 同数据模型 `order_item.phase` | 订单项 `phase` |
| `order_item.production_model` | 同数据模型 | `productionModel`；`plan.productionModel` 取同一组（`subscription_term.production_model`） |
| `order_item.usage_end_source` | 同数据模型 | `usageEndSource` |
| `cancel_request.kind`、`cancel_request.status`、`cancel_request.close_reason`、`cancel_request.reason_code`、`cancel_request_line.mode` | 同数据模型 | `afterSales[]` 各字段；`order_item.cancel_reason_code` 同 `reason_code` |
| `license_letter.status` 与 m05 `displayStatus` | 同数据模型与 m05 第 4 节；本文只出现未作废的取值 | `licenseLetters[].status`、`displayStatus` |
| `order_item_placement.slot` / `ad.type` | 同数据模型；V1.0 只出现 `opening`、`ending` | `slot`、`type`、`allowedPlacements[]` |
| `order_item_account.platform` | 同数据模型 | `platform`、`platforms[]` |
| `channel_account.status`、`channel_account.account_type` | 同数据模型 | 报价的 `channelAccounts[]` |
| `delivery_ticket.step` | 同数据模型 | `ticketStep` |
| `delivery_plan.status` | 同数据模型 | `deliveryPlan.status` |
| `ledger_operation.op_type` | 本文只出现 `hold`、`capture`、`release`、`refund` | `pointsEvents[].opType` |
| `drama.heat_tier`、`drama.drama_class` | 同数据模型 | `heatTier`、`dramaClass` |
| `drama_permit.platform`、`drama_permit.permit_kind` | 同数据模型 | `permits[].platform`、`permits[].kind` |
| `ViewerRole` | `owner`、`clerk`、`guest` | 观察者角色（C55） |
| `DramaBadge` | `new`、`hot` | 卡片角标；显示文案由端上按设计规范第 11 节定 |
| `MallSort` | `composite`、`heat`、`price_asc`、`price_desc`、`newest` | 同 14 分组 `MallConfig.sorts` |
| `SearchMode` | `match`、`industry_fallback` | 搜索结果来源 |
| `MatchedField` | `title`、`genre`、`cast` | 搜索命中的字段 |
| `UnorderableReason` | `not_listed`、`stopped`、`platform_not_licensed`、`permit_missing` | 不可订原因；前两个来自 `getOrderability`，后两个只在选了平台时由 `assertOrderable` 给出 |
| `CartItemState` | `valid`、`price_changed`、`invalid` | 选剧单项状态（读取时计算，09:72） |
| `OrderTab` | `all`、`producing`、`to_launch`、`live`、`ended`、`after_sale` | 我的订单页签（3.16） |
| `OrderItemTab` | `all`、`live`、`to_launch`、`ended` | 我的短剧页签（3.18） |
| `TodoKind` | `plan_confirm`、`ad_confirm`、`sample_confirm`、`launch_submit`、`takedown_confirm`、`channel_account_fix`、`qualification_fix`、`ticket_confirm`、`asset_demand` | 待办类型（3.2）；`x-open-enum`，端上对未知值兜底显示 `title` |
| `TodoTag` | `to_confirm`、`to_handle`、`failed` | 待确认、待处理、未通过（红底，design-spec.md:1015）；`x-open-enum` |
| `StoreNotQualifiedReason` | `not_submitted`、`pending_review`、`rejected`、`final_rejected` | `STORE_NOT_QUALIFIED.details.reason`：资质未提交；新增门店审核中（首店审核中是 `parallel`，不报错）；已驳回待补正；终局驳回 |
| `AdInvalidReason` | `not_in_store`、`not_confirmed`、`cancelled`、`cancel_pending`、`slot_not_allowed` | `ORDER_AD_INVALID.details.reason` |
| `TodoUrgency` | `overdue`、`due_today`、`normal` | 紧急度 |
| `TimelineNodeKey` | `submitted`、`started`、`manager_assigned`、`plan_confirmed`、`ads_confirmed`、`sample_confirmed`、`delivered`、`live`、`usage_ended` | 交付时间轴节点（d3:561-573） |
| `TimelineNodeState` | `done`、`current`、`todo` | 节点状态 |

会增长的响应枚举（状态、子状态、步骤、待办类型）标 `x-open-enum`（C37）。

## 5. 错误码

本文新定义的领域错误码（订购 45000–45099，商城 49300–49399，A70）：

| 符号 | 数值 | HTTP | 可重试 | 含义 | `details` |
| --- | --- | --- | --- | --- | --- |
| `CART_LIMIT_REACHED` | 45001 | 409 | 否 | 选剧单已达上限（50 部） | `{ limit: integer }` |
| `CART_PRICE_CHANGED` | 45002 | 409 | 否 | 确认新价格时标价又变了 | `{ currentPricePoints: integer }` |
| `ORDER_ACCOUNT_INVALID` | 45003 | 409 | 否 | 所选发布账号不可用于本次订购 | `{ channelAccountId: string, reason: 'not_in_store' \| 'not_available' }` |
| `ORDER_AD_INVALID` | 45004 | 409 | 否 | 所选广告不可用于本次订购 | `{ adId: string, reason: AdInvalidReason, dramaId?: string }`（`reason`：`not_in_store` \| `not_confirmed` \| `cancelled` \| `cancel_pending` \| `slot_not_allowed`） |
| `LAUNCH_DATE_TOO_EARLY` | 45005 | 400 | 否 | 期望上线日早于订购日后第 7 个工作日 | `{ earliestLaunchDate: string(date) }` |
| `STORE_NOT_QUALIFIED` | 45008 | 409 | 否 | 门店资质尚未通过，暂不能订购、绑定发布账号或提交广告需求（门店闸门 `blocked`，d3:419、431-437）。共用领域码（A77，C28 归属表）：m05 的渠道账号绑定、m06 的广告提交引用本符号 | `{ storeId: string(uuid), reason: StoreNotQualifiedReason }` |
| `DRAMA_NOT_ORDERABLE` | 49301 | 409 | 否 | 剧目当前不可订购 | `{ dramaId: string, reason: UnorderableReason }` |

45006（原 `ORDER_BLOCKED_OVER_STORE_LIMIT`，与 m02 的 `QUOTA_EXCEEDED` 同义）、45007（原 `ORDER_REFERENCE_ASSET_INVALID`，改为与 m06 一致的 `VALIDATION_FAILED`）本轮删除，数值释放、不再复用。

本文引用、由其他文档定义的错误码：

| 符号 | 定义方 | 本文用在 |
| --- | --- | --- |
| `SUBSCRIPTION_INACTIVE`（43010）、`POINTS_INSUFFICIENT`（43009，`details` `{ requiredPoints, spendablePoints, shortfallPoints }`） | m07-billing（A77、A131；d1:1724） | `SUBSCRIPTION_INACTIVE`：`m.order.quote`、`m.order.create`；`POINTS_INSUFFICIENT`：`m.order.create`，另见报价 `blockers` |
| `QUOTE_CHANGED`（43007，`details` 为 m07 `QuoteChangedDetails` 的 `points` 分支）、`ACCOUNT_BUSY`（43008，503 可重试）、`PLAN_REFUND_IN_PROGRESS`（43006） | m07-billing（A131） | `m.order.create`（`PLAN_REFUND_IN_PROGRESS` 另见报价 `blockers`）；`QUOTE_CHANGED.details` 的形态见 3.15 |
| `AGREEMENT_VERSION_STALE`（47401） | m01-account（协议同意段；C73、d6 3.4） | `m.order.create` |
| `QUOTA_EXCEEDED`（41106）、`STORE_ARCHIVED`（41107，403） | m02-tenant（A77） | `m.order.create`（`QUOTA_EXCEEDED` 另见报价 `blockers`）；`STORE_ARCHIVED` 另用于 `m.cartItem.create` |
| `STORE_PROFILE_INCOMPLETE`（49006，`details.missing` 为 `array<{ step, item: MissingItemKey, permitType: string \| null }>`） | m03-profile-asset（A123；出口 `profile.assertProfileComplete`，只查前三步，m03 1.2） | `m.order.create`；报价的 `blockers` |
| `INDUSTRY_NOT_OPEN`（49007）、`FILE_NOT_USABLE`（46001） | m03-profile-asset | `m.order.create`（`INDUSTRY_NOT_OPEN` 另见报价 `blockers`） |
| `VALIDATION_FAILED`、`NOT_FOUND`、`ROLE_FORBIDDEN` | 约定 C27 | 各接口 |

## 6. 待确认

| # | 问题 | 默认做法 | 由谁定 |
| --- | --- | --- | --- |
| 1 | 我的订单页签映射：待开工并入“制作中”，已取消、已退回积分并入“售后”（proto-merchant-a.md:426） | 按 3.16 的映射（d3:548-555） | 产品 |
| 2 | 我的短剧页签：原型“待上线”含制作中的剧；开工前取消的剧是否出现在“全部”；已退回、已终止归“已结束”；“全部”是否列出已结束的剧（原型“全部”只画了上线中、待上线两组，MyDramas.dc.html:36-51、67-69） | 按 3.18 的映射：`to_launch` = 待开工、制作中、待上线；`cancelled` 不列出；`refunded`、`terminated` 归 `ended`；“全部”按组排序，已结束的列在最后一组 | 产品 |
| 3 | 选剧单角标的口径（是否含失效项、变价项，proto-merchant-a.md:321） | 不含失效项、含变价项（与原型角标一致，Cart.dc.html:33-35、47；Main.dc.html:123）；m08 概览的选剧单数同口径 | 产品 |
| 4 | 下单门店能否改选：原型不可改，PRD 6.8 允许改选同主体已认证门店 | 取 `X-Store-Id`，不提供改选 | 产品 |
| 5 | 搜索未命中时是否按行业兜底推荐（PRD 12.3 第 9 项） | 做，受参数 `catalog.search.industry_fallback` 控制（默认开，A107 补登）；关闭时未命中返回空结果 | 产品 |
| 6 | 订购成功页的专属服务经理：未分配交付经理时的展示 | 走 `m.serviceManager.get`，为空时显示“服务经理将在 1 个工作日内联系您”（d3 4.4 要点 5） | 产品 |
| 7 | 停止订购的剧在详情页是否可达（PRD 写商城不展示） | 商城、搜索不展示；详情仍可打开，返回 `orderability.orderable = false` | 产品 |

## 7. 修订记录

| 日期 | 内容 |
| --- | --- |
| 2026-10-03 | 初稿：按路线图 `doc = m04-mall-order` 的 21 条接口写全；新定义错误码 8 个（45001–45007、49301）；店员与游客视图按 C55、C56 定 schema；时间轴、页签映射、待办派生按 d3 第 5.4、23.3 节落到数据模型的列 |

**第二轮（按 A76–A126、其他文档的请求、两位复核员的意见与整体核对修订，2026-10-03）**

| 日期 | 内容 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 错误码：新定义 `STORE_NOT_QUALIFIED`（45008，409，`details { storeId, reason }`），m05、m06 引用；删除 `ORDER_BLOCKED_OVER_STORE_LIMIT`（45006）改引用 m02 `QUOTA_EXCEEDED`；删除 `ORDER_REFERENCE_ASSET_INVALID`（45007），参考素材守卫改为与 m06 一致的 `VALIDATION_FAILED` 并加 ≤9 项上限，另列 m03 的 `FILE_NOT_USABLE`；`STORE_PROFILE_INCOMPLETE` 归 m03、`STORE_ARCHIVED` 归 m02；确认订购补 `ACCOUNT_BUSY`；`QUOTE_CHANGED` 订购时的 `details` 写成 `{ kind: 'drama_order', expect }`，请 m07 定义判别联合；`ORDER_AD_INVALID.reason` 加 `cancelled` | A77、A123；api-check 第 2 节；复核 B 1、3、4、14、15、16；复核 A 1；m02、m03、m05、m06、m07 的请求 |
| 2026-10-03 | `m.order.create`：协议改用 m01 的 `consent: ConsentInput`（`agreementKey = custom_license`）；`adIds` 排除已取消的广告；冻结时传 `titleCode = order_hold` 与整单的 `titleArgs`；响应加 `replayed`，重放时 `items[].posterUrl` 置空（结果脱敏）；`billing.points.held` 写明每张冻结单一条 | A80；复核 A 1；复核 B 6、12、13；m01、m07 的请求 |
| 2026-10-03 | `m.cartItem.acceptPrice` 响应加 `replayed`，重放时 `drama.posterUrl` 置空；`m.cartItem.create` 对不存在、草稿、已归档的剧返回 `NOT_FOUND`，`DRAMA_NOT_ORDERABLE` 只用于已下架与停止订购；`DramaCard.listPricePoints` 改为可空（只在选剧单失效项里为空） | A80；C24；复核 A 13；复核 B 13、20 |
| 2026-10-03 | `m.todo.list`：能力点 `todo.read`；改为游标分页并带 `viewerRole`；店员口径的素材需求按 `notify_scope = owner_and_clerks` 过滤；`TodoTag` 加 `failed`（“未通过”），账号核验未通过与资质被驳回用它；`route` 改为 m08 公共结构 `link: DeepLink`，派生表逐类写出路由键与参数 | A87；C42、C55；复核 A 10、11；复核 B 5、8、17、19；m05、m08 的请求 |
| 2026-10-03 | `m.home.get`：公告条条件改为 `announced_at ≤ now < effective_at + 7 天` 取最新，`hidden` 模式不返回，`offline_contract` 用 `summary_no_price`、为空回落 `summary`；Banner 字段 `homeBannerId`，跳转目标按 a09 `BannerJumpTarget`，失效引用跳过；`cartCount` 不含失效项 | 复核 A 3、9；a09、m08 的请求 |
| 2026-10-03 | `m.order.get`：`afterSales` 按 `cancel_request_line` 选取（含整店取消），明细与合计只取本单部分，补 `kind`；时间轴 `usage_ended` 取 `delivery_ticket.usage_ended_at`；方案摘要取已确认版本、补 `focus` 与 `summaryVersionNo`，约定上线日取订单项；授权书清单排除已作废，元素改为 m05 `LicenseLetterCard` 的子集（`displayStatus`、`periodStart` 可空）；订单卡片 `liveSummary` 补 `firstLiveOrderItemId` | 复核 A 2、4、6、7、8；复核 B 10；m05 的请求 |
| 2026-10-03 | 订单项结构：`title` 改名 `dramaTitle`（与 m05、a05 一致）；M:LaunchRecord 页头以 `m.orderItem.get` 为唯一来源；`m.orderItem.list` 的 `tab = all` 按阶段分组排序；`m.orderItem.summary` 加副指标 `delivering`（制作中 + 待上线） | 复核 A 5；复核 B 7、9、21；m02、m08 的请求 |
| 2026-10-03 | `m.drama.get`：`owner` 加 `termEndDate`（`planPointsExpireAt` 是不含的终点）；加 `placementDurations`（广告时长选项）；`roles` 保留原名并说明理由。`m.drama.search` 的行业兜底改为参数键（A107），不是开关 | A107；复核 A 12、14；复核 B 18、21 |
| 2026-10-03 | 新增 2.9“供其他模块调用的计数与只读端口”：未结订购单计数（m01 注销守卫）、在办订购计数（m02 门店停用守卫，不含上线中）、订单项阶段计数、待办计数、订购单号查询（m03）、选剧单角标 | 复核 B 11；m01、m02、m03、m08 的请求 |
| 2026-10-03 | 第 6 节：关闭原第 5、6、7、8、9、12 项（C42 已登记选剧单不分页；A87 能力点；A86 目录标价放行；A107 参数键；分档结构转 a09 对齐；A77 `STORE_ARCHIVED`），新增“全部是否含已结束”并入第 2 项；第 3 项默认改为不含失效项；行业兜底只留产品规则一问。路线图切片同步：`m.todo.list` 的能力点与查询参数、`m.order.create` 的请求字段名、`m.cartItem.acceptPrice` 的请求体、`m.drama.search` 与 `m.order.list` 的备注、`m.cartItem.create` 的 `idempotentBy` 改为数组 | A49、A78、A86、A87、A107、A108；复核 B 22；作者的路线图修改建议 |

**第三轮（按 A127–A146、C85–C87、其他文档第二轮的请求与整体核对修订，2026-10-03）**

| 日期 | 内容 | 依据 |
| --- | --- | --- |
| 2026-10-03 | `m.order.create`：请求体 `consent: ConsentInput` 改为平铺的 `agreementVersionId`（交易接口只提交版本 id，服务端从版本行补协议键），删去“`agreementKey` 不是 `custom_license`”的校验；报价与提交的“当前版本”都按 m01 3.12 的唯一解析口径（`effective_at` 实时解析，不按 `status = active`）；`AGREEMENT_VERSION_STALE` 的 `details` 按 m01 | m01-account.md:130、825；m01、m06、m07 的请求 |
| 2026-10-03 | 协议名称字段改名：`OrderQuote` 的 `agreement` 与 `OrderDetail` 的 `agreements[]` 里，协议名称由 title 改为 `name`（与 m01、m06 一致） | m01、m06 的请求；整体核对 |
| 2026-10-03 | 错误码：`QUOTE_CHANGED.details` 改用 m07 `QuoteChangedDetails` 的 `points` 分支 `{ kind: 'points', totalChargePoints, items }`，删去 `drama_order` 与 `expect` 包装；`POINTS_INSUFFICIENT`（43009）、`SUBSCRIPTION_INACTIVE`（43010）写明数值与 `details`，去掉“待 m07 补定义”；`STORE_PROFILE_INCOMPLETE` 写明 m03 的 49006 与 `details.missing` | A131；m03、m07 的请求 |
| 2026-10-03 | 公共结构：第 2.5 节定义 `QuoteBlocker = { code, message, dramaId? }`（m06 引用）；`TodoPage` 注明是 `CursorPage<Todo>` 加 `viewerRole`；字典项按 C85：`MallConfigView.categories[].genreCodes` 改为 `genres: DictRef[]`，`m.drama.list` 查询参数 `genre`、`industry` 改为 `genreCodes`、`industryCodes`；报价的账号补 `abnormalReasonLabel`（与 m05 同名） | A132、A133；C85、C87 |
| 2026-10-03 | 可花积分与首页积分三项经 `billing.getWalletView` 取，“退款处理中”按主体级口径；`expiringPlanPoints` 注明即 m07 `Wallet.points.planAvailablePoints`（字段名保留） | m07 的请求 |
| 2026-10-03 | 上线记录页的取数写明：任务清单 `m.launchTask.list?orderItemId=…&tab=all`，核验项、时间线、巡检记录取 `m.launchTask.get`（3.16、3.18、3.20 的说明）；2.9 选剧单角标端口的调用方改写为“`m.home.get` 的 `cartCount` 字段”（原写法被当作 operationId）；`DeletionBlockerKind` 取值改为 `open_order`；`placementDurations` 的来源改为 A146 登记的参数键 ad.duration_options | m05 的请求；A134、A146；整体核对第 6 节 |
| 2026-10-03 | 未采纳：深链路由键 ad.detail 被报为“找不到的列引用”——它是 d6 场景注册表的深链路由键（d6-notify-docs-data.md:233-249），不是 `ad` 表的列，保留原写法，请核对脚本排除深链路由键；`TodoPage` 与 m01 `AgreementConsentPage` 字段集相同但 `items` 元素类型不同，不是同构结构，不改名。第 6 节无已裁决项需删除（第二轮已清理，现余 7 项均待产品） | 整体核对第 5 节；公共结构核对 |

**第四轮（收尾，按 A151 与其他文档第三轮的请求修订，2026-10-03）**

| 日期 | 内容 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 单值字典项改 `DictRef`：报价 `channelAccounts[].abnormalReasonCode` + `abnormalReasonLabel` → `abnormalReason`（与 m05 同名），首页 `city` `{ cityCode, cityName }` → `DictRef \| null`，`recommend.matchBy` `{ industryCode, categoryCode, categoryName }` → `{ industry, category }`；内联 `array<{ code, name }>` 改写为 `DictRef[]`；授权书清单 `periodStart` / `periodEnd` → `periodStartDate` / `periodEndDate`。取消原因 `reasonCode`、`cancelReasonCode` 是数据库枚举（09-order-ad.md:306、511），不改 | A151；C15、C85；m05 的请求 |
