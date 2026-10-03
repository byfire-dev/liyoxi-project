# 商家端：客服、消息与通用接口

| 项 | 内容 |
| --- | --- |
| 范围 | 启动引导、数据字典、“我的”页聚合、专属服务经理名片、客服工单（列表、提交、详情、补充说明、确认解决、重新打开、撤回）、站内消息（列表、页签计数、标记已读）、通知设置与订阅授权结果上报、文件上传（登记、查询、确认、续签凭证、取消）、埋点与前端错误上报；V1.1 占位：服务评价、常见问题、公告页签。画板：M:Service（M29/M30 客服中心与提交工单）、M:Ticket、M:TicketDone（M31 工单详情）、M:Messages（M36 消息中心）、M:Mine（M32 我的）、M:Main（M02，启动与未读角标）、M:Login（M01）；文件上传涉及 M:ProfileBasic、M:ProfileStore、M:ProfileService、M:ProfileCert、M:ProfileReview、M:AssetUpload、M:AdDetail、M:Accounts、M:Sample、M:PlanPick、M:TopUp；原型没画的“通知设置”（05 第 4 节）、全局错误上报与“上传中 / 上传失败”补充状态（设计规范第 12 节） |
| 接口数 | 27（V1.0 24，V1.1 3） |
| 依据 | 数据模型 12 分组（`service_ticket`、`service_ticket_entry`、`service_ticket_ref`）、13 分组（`merchant_message`、`wx_template_slot`、`wx_subscribe_quota`、`notify_scene`、`agreement*`）、14 分组（`dict_type`、`dict_item`、`param_value`、`feature_flag`、`site_config_revision`、`site_notice`、`analytics_event`、`analytics_event_dedup`、`analytics_identity`）、06 分组（`file_object`、`file_ref`）；另读 02（`store`、`entity_member`、`wecom_contact`、`user_session`）、03（`staff`、`assignment_pool_member`）、01（`status_transition`、`timer`、`outbox_event`）。草案 d3-flow 第 18 节与附录 B，d5-media 第 3.2、5 节与第 17 节接口表，d6-notify-docs-data 第 2.8、2.9、4.1.4、5.1 节与第 6 节接口表，d7-platform 第 3.2、4.12、4.13 节；PRD 6.12、6.13；设计规范第 11、12 节；接口裁决 A1–A156、约定 C1–C87（第四轮修订稿）；事件与定时器以 x01-events-jobs 为准 |

## 1. 概览

本文是商家端的“杂项与公共能力”：

- **启动与配置**：小程序冷启动与回到前台超过 5 分钟时调 `m.bootstrap.get`，拿服务器时间、最低版本、开关、配置版本号、上传上限、在线客服配置、停机维护说明、待同意协议与订阅授权清单；数据字典按版本号缓存，`m.dictItem.list` 按类型整份下发，行政区划可按上级懒加载。
- **“我的”页与客服中心**：`m.me.overview.get` 是“我的”页的聚合；`m.serviceManager.get` 给当前门店的专属服务经理名片（店员也能看）。客服工单只有老板能提交与查看（A33），会话式时间线只下发商家可见的条目；状态迁移逐条对上 12 分组的状态机表。
- **消息与订阅**：站内消息是账号级的（A52），派发时已按收件人角色出好文案；带门店上下文时按门店过滤。订阅消息的授权只能在点击回调里同步发起，端上把结果上报给 `m.subscribeResult.create`，服务端只维护“估计还能发几条”的额度行。
- **上传**：一律“登记 → 直传 → 确认 → 业务引用”（C59）。业务接口只接受已入库的 `fileId`，端上的上传工具把“等到入库”封装在内部。
- **埋点与错误上报**：端上只报 7 个纯行为事件与扩展事件，服务端按事件 schema 严格校验、按 `event_id` 去重；错误上报是 Sentry 信封的转发，立即 202。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `m.bootstrap.get` | `GET /m/bootstrap` | 启动引导 | optional | none（查询） |
| `m.dictItem.list` | `GET /m/dict-items` | 数据字典 | public | none（查询） |
| `m.me.overview.get` | `GET /m/me/overview` | “我的”页聚合 | member；`me.*`；店员 trimmed | none（查询） |
| `m.serviceManager.get` | `GET /m/service-manager` | 专属服务经理名片 | member；`support.manager.read`；店员 same | none（查询） |
| `m.serviceTicket.list` | `GET /m/service-tickets` | 我的工单 | member；`ticket.*`；店员 403 | none（查询） |
| `m.serviceTicket.create` | `POST /m/service-tickets` | 提交工单 | member；`ticket.*`；店员 403 | required |
| `m.serviceTicket.get` | `GET /m/service-tickets/{serviceTicketId}` | 工单详情与处理记录 | member；`ticket.*`；店员 403 | none（查询） |
| `m.serviceTicket.entry.create` | `POST /m/service-tickets/{serviceTicketId}/entries` | 补充说明 | member；`ticket.*`；店员 403 | required |
| `m.serviceTicket.confirm` | `POST /m/service-tickets/{serviceTicketId}/confirm` | 确认已解决 | member；`ticket.*`；店员 403 | required |
| `m.serviceTicket.reopen` | `POST /m/service-tickets/{serviceTicketId}/reopen` | 仍未解决，重新打开 | member；`ticket.*`；店员 403 | required |
| `m.serviceTicket.withdraw` | `POST /m/service-tickets/{serviceTicketId}/withdraw` | 撤回工单 | member；`ticket.*`；店员 403 | required |
| `m.serviceTicket.rate` | `POST /m/service-tickets/{serviceTicketId}/rate` | V1.1：评价服务 | member；`ticket.*` | required |
| `m.faq.list` | `GET /m/faqs` | V1.1：常见问题 | member | none（查询） |
| `m.message.list` | `GET /m/messages` | 站内消息 | user；`assert-in-handler`（带门店上下文时校验 `message.read`） | none（查询） |
| `m.message.summary` | `GET /m/messages/summary` | 未读计数（页签、合计、按门店） | user；`assert-in-handler`（同上） | none（查询） |
| `m.message.batchRead` | `POST /m/messages/read` | 全部已读 | user；`assert-in-handler`（同上） | required |
| `m.message.read` | `POST /m/messages/{messageId}/read` | 标记单条已读 | user；`assert-in-handler`（同上） | required |
| `m.siteNotice.list` | `GET /m/site-notices` | V1.1：公告页签 | member | none（查询） |
| `m.notifySetting.list` | `GET /m/notify-settings` | 通知设置 | user | none（查询） |
| `m.subscribeResult.create` | `POST /m/subscribe-results` | 订阅授权结果上报 | user | required |
| `m.file.create` | `POST /m/files` | 上传登记（一次至多 9 个文件） | member；`assert-in-handler`（按分类判权） | natural（`uq_file_object_client_token_store`、`uq_file_object_client_token_noscope`） |
| `m.file.get` | `GET /m/files/{fileId}` | 查询入库状态 | member（上传人本人） | none（查询） |
| `m.file.complete` | `POST /m/files/{fileId}/complete` | 上传确认 | member（上传人本人） | required |
| `m.file.refreshCredentials` | `POST /m/files/{fileId}/refresh-credentials` | 续签上传凭证 | member（上传人本人） | none（签发凭证） |
| `m.file.cancel` | `POST /m/files/{fileId}/cancel` | 取消上传 | member（上传人本人） | required |
| `m.analyticsEvent.batchCreate` | `POST /m/analytics-events` | 埋点批量上报 | optional | none（埋点） |
| `m.clientError.create` | `POST /m/client-errors` | 前端错误上报（202） | optional | none（错误上报） |

路由注册顺序（A8、C12）：`/m/messages/summary`、`/m/messages/read` 是字面段，先于 `/m/messages/{messageId}` 注册。`/m/me/overview` 属 `/m/me` 视图别名下的聚合（资源登记表 `me/overview`）。

### 1.1 本文通用规则

| 事项 | 规则 |
| --- | --- |
| 门店范围 | 按 id 取的资源必须属于 `X-Store-Id` 的门店（工单），或属于当前用户在当前门店上下文登记的文件，否则 404 `NOT_FOUND`（C29）。主体级文件（营业执照、转账回单）按“同主体、本人上传”判定 |
| 已停用门店 | 由门店上下文中间件处理（C17；`STORE_ARCHIVED` 由 m02-tenant 定义）。本文的读接口、客服工单（`ticket.*` 对已停用门店的老板开放，d4-identity.md:869）、消息照常；上传登记按分类判定（3.21） |
| 店员 | 没有能力点的接口返回 403 `ROLE_FORBIDDEN`。店员进入客服中心只看到服务经理名片与在线客服入口（A33），工单接口一律 403。店员可见的响应（`same`、`trimmed`）键名避开 C57 的禁用模式：服务经理的电话叫 `serviceTel`；以页签名、订阅点位名为键的结构一律做成数组（`MessageSummary.byTab`、`Bootstrap.subscribePlan`），让 `plan_points`、`invoice_apply` 这类名字只出现在值里；`flags`、`versions.dict`、`versions.site`、`copy` 的键是代码里登记的常量（开关键、字典类型键、站点配置键、文案键），登记新键时同样避开禁用模式 |
| 签名地址 | 工单图片、服务经理二维码随响应现签（C60），30 分钟对齐窗口（C61“素材与档案图片”同档）；统一表达为 `ImageRef`（2.1）。本文没有需要逐次留痕的读取 |
| 开放枚举 | 响应里的状态、类型、分类类枚举都标 `x-open-enum`（C37），端上对未知值兜底展示 |
| 版本门槛与协议同意 | `m.bootstrap.get`、`m.analyticsEvent.batchCreate`、`m.clientError.create` 不受最低版本门槛拦截（C71），也都在协议同意白名单内（C73、A85） |
| 限流 | 缺省 `m.global`；埋点 `m.analytics`、订阅授权上报 `m.subscribe`、错误上报 `telemetry`（C68，按 operationId 登记；专用档位与缺省档位同时生效） |
| 事件与定时器 | 出站事件名取 x01-events-jobs 的事件目录（A95、C84）；本文登记或取消的定时器，去重键以 x01-events-jobs 4.1 的键表为准，本文不另写键串 |
| 分页 | 游标分页，`limit` 默认 20、上限 50，不返回总数（C42）；页签计数走 `summary`（C83） |

## 2. 公共结构

### 2.1 小结构

**`ImageRef`**（图片的读地址）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `fileId` | string(uuid) | 是 | 文件 | `file_object.id` |
| `url` | string | 是 | 短时签名地址 | 现签（C60），30 分钟对齐窗口 |
| `expiresAt` | string(date-time) | 是 | 地址过期时刻；过期后重新请求所在接口 | 计算 |

本文是 `ImageRef` 的归属文档（A132、C87 登记表）：m06-ad（原 `SignedImage`）、a05-order-delivery、a08-support 引用本结构，a06-publish 的“`SignedUrl` & `{ fileId }`”按 A132 改为引用，各方不另定义。

**`DeepLink`**（深链，消息与订阅消息落地页共用一份路由表，d6-notify-docs-data.md:763-775）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `route` | string | 是 | 路由键，取值以 `packages/contract` 的 `DeepLink` 路由表为准（`order.detail`、`delivery.sample`、`publish.task`、`wallet.home`、`ticket.detail` 等约 20 个）；旧版本不认识的 `route` 一律落到消息中心 | `merchant_message.link` 的 `route`；`service_ticket_entry.link` 的 `route` |
| `params` | object | 是 | 路由参数（对象 id、`storeId` 等），结构随 `route` 而定；没有为 `{}` | 同上的 `params` |

路由表在 d6 场景注册表已用的键之外，补登 m04-mall-order 首页待办（`m.todo.list`，m04 3.2 派生表）用到的两个键：`account.detail`（`{ channelAccountId, storeId }`，渠道账号详情）、`asset.demand`（`{ storeAssetDemandId, storeId }`，素材需求）；并写明待办用到的已有键的对象 id 参数：`delivery.plan`（`{ deliveryPlanId, storeId }`）、`publish.task`（`{ launchTaskId, storeId }`）、`offline.task`（`{ takedownTaskId, storeId }`）、`ticket.detail`（`{ serviceTicketId, storeId }`）。参数名即对象表 id 的驼峰（C11），`packages/contract` 的路由表按此登记。另补登 `cart.list`（`{ storeId }`，选剧单）：a09 2.9 的场景 `m.cart_price_changed`（x01 `pricing.drama_price_changed` 的变价提示）跳转用。

**`EntryLink`**：`DeepLink` 加 `label`（string \| null，按钮文案，如“去确认新片尾”，取 `service_ticket_entry.link` 的 `label`）。

**`MerchantStaffBrief`**（对商家展示的员工；与 a01-system 的后台 `StaffBrief` 不是同一结构，不下发员工 id、工号与状态）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `name` | string | 是 | 对商家展示的称呼（“小林”“唐悦”） | `staff.display_name`，为空取 `staff.name` |
| `roleKind` | enum(`StaffRoleKind`) | 是 | 对商家展示的岗位：`service_manager` 服务经理（`staff.staff_role_key = delivery_manager`）、`customer_service` 客服（`cs`）、`platform` 平台（其余角色）；端上渲染为“小林 · 服务经理” | 计算：`staff.staff_role_key` |

### 2.2 `Bootstrap` 启动引导

`m.bootstrap.get` 的响应。结构以 d7-platform.md:474-489 为底，按 A39、C69、C72 加 `notice`，按 d6-notify-docs-data.md:878-883 加订阅冷却参数。契约声明的键总是出现（C38）：匿名请求时“登录后才有”的块为 `null`。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `serverTime` | string(date-time) | 是 | 服务器时刻；端上据此校正时钟（埋点时间、倒计时） | 应用时钟 |
| `minClientVersion` | string | 是 | 最低版本（semver）；低于它进入“请更新”页 | 开关 `client.min_version` 的求值结果（`feature_flag.key = client.min_version`，C71） |
| `flags` | object | 是 | 开关键 → 值（布尔、字符串或 JSON），只含 `feature_flag.exposed_to = client` 的键，按本次请求上下文求值 | `feature_flag.default_value`、`feature_flag.rules`（条件：平台、客户端版本、环境、主体白名单，14-config-data.md:1135-1145） |
| `versions` | object（`ConfigVersions`） | 是 | 配置版本号：没变就不重拉 | 见下 |
| `versions.dict` | object | 是 | 字典类型键 → 版本号，只含小程序可见的类型 | `dict_type.version_no`（`dict_type.is_merchant_visible = true`） |
| `versions.site` | object | 是 | 站点配置键（`mall`、`home_recommend`）→ 当前已发布修订号 | `site_config_revision.rev_no`（`site_config_revision.status = published`） |
| `versions.agreement` | string | 是 | 现行协议版本集合的指纹：任一协议（用户级与主体级都算）的当前版本变化即变化，端上据此刷新缓存的协议列表 | 计算：对全部 `agreement.key`，按 m01-account 3.12 的唯一“当前版本”解析口径（`pending`、`active` 中 `effective_at <= now` 的最新一条）取 `agreement_version.id`，排序后求摘要。与 `merchant_user.consent_stamp` 算法相同、输入集合不同：后者只取用户级协议（02-identity-tenant.md:96） |
| `uploadLimits` | object | 是 | 上传上限：`weappVideoMaxMb`（integer，小程序内视频上限，真机验证前 100）、`imageMaxMb`（integer，图片上限 5） | `weappVideoMaxMb`：参数 `upload.weapp_video_max_mb`（d5-media.md:1102；A107 补登）；`imageMaxMb`：上传分类登记表（`packages/shared`，d5-media.md:1116-1129） |
| `download` | object | 是 | `weappSaveMode`：enum `temp` / `user_dir`，逐集保存的落盘方式（d7-platform.md:480） | 参数 `download.weapp_save_mode`（A107 补登） |
| `copy` | object | 是 | 文案键 → 覆盖文案，只下发与代码内默认值不同的键；没有为 `{}` | V1.0 返回 `{}`；文案覆盖的存储位置以后再定 |
| `support` | object（`SupportConfig`） | 是 | 在线客服：`mode` enum `wecom_kf`（拉起微信客服会话）/ `contact`（小程序客服消息）；`corpId`（string \| null）、`kfUrl`（string \| null）：`wecom_kf` 时 `wx.openCustomerServiceChat` 的参数 | 部署配置（05 第 0 节“在线客服用微信客服”；设计规范第 11 节） |
| `notice` | object（`MaintenanceNotice`）\| null | 是 | 停机维护说明：`title`（string）、`body`（string）、`expectedEndAt`（string(date-time) \| null）；没有维护为 `null` | 开关 `ops.maintenance_notice`（json，`exposed_to = client`，默认 `null`；C72；A146 并入 07 主文档的待回写清单） |
| `degraded` | array<enum(`BootstrapBlock`)> | 是 | 哪几块取数失败、用了保守默认值；全部正常为 `[]` | 计算 |
| `pendingConsents` | array<`PendingConsent`> \| null | 是 | 待同意的用户级协议；匿名为 `null`。元素即 m01-account 2.5 的 `PendingConsent`（`agreementKey`、`agreementVersionId`、`name`、`versionLabel`、`effectiveAt`、`summary`），本文不另定义 | 计算规则见 m01-account 2.5 |
| `subscribePlan` | array<`SubscribePlanItem`> \| null | 是 | 各订阅点位此刻可请求的槽位，每个点位一项；只含已配置且启用的槽位；匿名为 `null` | 点位与槽位的对应见 d6-notify-docs-data.md:856-873；按购买入口模式裁剪（见 3.1 说明） |
| `subscribeCooldownDays` | integer | 是 | 用户对某槽位点了拒绝后，同一点位多少天内不再请求（端上本地记录） | 参数 `notify.wx.ask_cooldown_days`（默认 7，d6-notify-docs-data.md:854、1550） |
| `subscribeMaxPerAsk` | integer | 是 | 一次授权请求的模板数上限 | 参数 `notify.wx.max_per_ask`（默认 3） |
| `context` | object \| null | 是 | `storeId`（string(uuid) \| null）：服务端记住的当前门店，已不在成员关系里时为 `null`；匿名为 `null` | `entity_member.last_store_id` |

`BootstrapBlock` 取值：`flags`、`versions`、`consents`、`subscribe`、`copy`、`notice`、`context`（`x-open-enum`）。

`SubscribePlanItem`（点位名放在值里，不作键，C57）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `point` | enum(`SubscribePoint`) | 是 | 授权引导点位 | d6-notify-docs-data.md:856-873 |
| `slots` | array<object> | 是 | `{ slotKey: string, tmplId: string }`，顺序固定。端上点击时先滤掉冷却中的槽位（按 `slotKey` 本地记录），再取前 `subscribeMaxPerAsk` 个模板 id 发起授权 | `slotKey`：`wx_template_slot.slot_key`；`tmplId`：`wx_template_slot.provider_template_id`（`wx_template_slot.status = active`） |

点位 `ticket_submit` 列出 `ticket_reply` 与 `refund_result` 两个槽位：端上只在所选问题类型的字典扩展属性 `isAfterSales = true` 时才请求 `refund_result`（d6-notify-docs-data.md:868“售后类工单另加”；该键已登记，14-config-data.md:1069，种子里 K08“取消与退款”为 `true`，14-config-data.md:142；A145，3.2）。

### 2.3 `DictTypeItems` 字典类型与字典项

`m.dictItem.list` 的响应是 `{ items: DictTypeItems[] }`（有界小集合，C42、A78），每个元素是一个类型及其字典项，顺序同请求。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `typeKey` | string | 是 | 类型键 | `dict_type.type_key` |
| `name` | string | 是 | 类型名称 | `dict_type.name` |
| `structure` | enum | 是 | `flat` / `tree`，同数据模型 `dict_type.structure` | `dict_type.structure` |
| `versionNo` | integer | 是 | 该类型的数据版本号；与引导接口 `versions.dict` 比对决定是否重拉 | `dict_type.version_no` |
| `items` | array<`MerchantDictItemView`> | 是 | 字典项；树按“上级在前、同级按 `position`”排列 | `dict_item` |

`MerchantDictItemView`（小程序的字典项；与 a01-system 的后台 `DictItemView` 不是同一结构）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `code` | string | 是 | 编码，业务表引用的就是它 | `dict_item.code` |
| `parentCode` | string \| null | 是 | 上级编码；一级项为 `null` | `dict_item.parent_code` |
| `name` | string | 是 | 名称 | `dict_item.name` |
| `description` | string \| null | 是 | 说明 | `dict_item.description` |
| `tags` | array<string> | 是 | 标记，如“特殊行业”“功能区” | `dict_item.tags` |
| `ext` | object | 是 | 扩展属性中对小程序公开的键（白名单见 3.2 说明）；没有为 `{}` | `dict_item.ext` 的子集 |
| `position` | integer | 是 | 同级排列顺序 | `dict_item.position` |
| `isSelectable` | boolean | 是 | 新选择时是否可选：启用，且行业为开放、区划为已开通。只在 `includeDisabled = true` 时会出现 `false` | 计算：`dict_item.is_enabled`，`industry` 加 `ext.open`，`region` 加 `ext.opened` |

### 2.4 `MeOverview`（老板）与 `MeOverviewForClerk`（店员）

`m.me.overview.get` 的响应，`viewerRole` 判别（C55）。

`MeOverview`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `viewerRole` | enum | 是 | 恒为 `owner` | 观察者角色 |
| `currentStore` | `OverviewStore` | 是 | 当前门店卡 | 见下 |
| `subscription` | `OverviewPlanCard` | 是 | 套餐与积分卡（主体级） | 见下 |
| `stores` | `OverviewStoresCard` | 是 | “我的门店 · 2 家”“专业版可管理 3 家 · 春熙店审核中” | 见下 |
| `storeStats` | `OverviewStoreStats` | 是 | 当前门店概览：`liveCount`（上线中）、`deliveringCount`（交付中）、`cartCount`（选剧单，也是底部 Tab 角标），均为 integer | `liveCount`、`deliveringCount`：m04-mall-order 2.9 的计数函数 `order.countOrderItemsByPhase(tx, storeId)` 的 `live`、`delivering`（`delivering` = `order_item.phase` ∈ {`producing`、`to_launch`}，不含待开工；m02 `StoreCard` 取同一函数）。`cartCount`：m04 2.9 的 `order.countCartBadge(tx, storeId)`（本门店 `cart_item` 中 `state ≠ invalid` 的行数，与 `m.home.get` 的 `cartCount` 同一函数） |
| `entries` | `OverviewEntries` | 是 | 功能入口的副标题与角标 | 见下 |
| `unreadMessageCount` | integer | 是 | 消息中心角标 | 与 `m.message.summary` 的 `total` 同口径（3.15） |

`OverviewStore`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `storeId` | string(uuid) | 是 | 当前门店 | `store.id` |
| `name` | string \| null | 是 | 门店名称 | `store.name` |
| `isPrimary` | boolean | 是 | 首家门店 | `store.is_primary` |
| `lifecycle` | enum | 是 | `active` / `archived`，同数据模型 `store.lifecycle` | `store.lifecycle` |
| `qualificationStatus` | enum | 是 | “已认证”“审核中”，同数据模型 `store.qualification_status` | `store.qualification_status` |
| `city` | `DictRef` \| null | 是 | 城市 `{ code, name }`，“成都 · 火锅”的前半取 `name`；未填为 `null`（C85、A151） | 同 m02-tenant `StoreCard`（`store_profile.city_code`，名称取字典 `region` 的 `dict_item.name`） |
| `category` | `DictRef` \| null | 是 | 二级品类 `{ code, name }`，后半取 `name`；未填为 `null`（C85、A151） | 同 m02-tenant `StoreCard`（`store_profile.category_code`，名称取字典 `industry` 的 `dict_item.name`） |
| `role` | enum | 是 | 本人在该门店所属主体的角色 `owner` / `clerk` | `entity_member.role` |
| `assetCount` | integer | 是 | “门店素材 128 条” | 本门店 `store_asset.deleted_at` 为空的行数（同 `StoreCard.assetCount`） |
| `clerkCount` | integer | 是 | “店员 2 位” | 本门店 `store_member` 行数 |
| `completenessPct` | integer | 是 | 建档完整度 0–100 | `store_profile.completeness_pct`；档案行未建时为 0 |
| `review` | object \| null | 是 | 在审轮次：`submittedAt`、`expectedDecisionAt`（“预计今天 18:20 前完成”）；没有在审轮次为 `null` | 同 `StoreCard.submittedAt`、`StoreCard.expectedDecisionAt`（`qualification_submission.submitted_at`；该轮 `approval_request.due_at`） |

`OverviewPlanCard`（与 m07-billing 2.7 `Wallet` 同口径、同字段名，只取卡片要的字段；经 m07 的 `billing.getWalletView(entityId)` 取数，本文不另算）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `status` | enum(`SubscriptionStatus`) | 是 | `none` / `active` / `expired` | 同 `Wallet.subscription.status`（`getEntitlements` 按周期现算） |
| `isRefundPending` | boolean | 是 | 套餐退款处理中 | 同 `Wallet.subscription.isRefundPending` |
| `planName` | string \| null | 是 | “专业版” | 同 `Wallet.subscription.plan.name`（`plan.name`） |
| `endDate` | string(date) \| null | 是 | “有效期至 10-12” | 同 `Wallet.subscription.endDate`（`subscription_term.end_date`） |
| `remainingDays` | integer \| null | 是 | “剩 12 天”；非生效中为 `null` | 同 `Wallet.subscription.remainingDays` |
| `spendablePoints` | integer(积分) | 是 | 可用积分（名下门店共用） | 同 `Wallet.points.spendablePoints` |
| `planAvailablePoints` | integer(积分) | 是 | 套餐积分 | 同 `Wallet.points.planAvailablePoints`（`billing_account.plan_available_qty`） |
| `addonAvailablePoints` | integer(积分) | 是 | 加购积分 | 同 `Wallet.points.addonAvailablePoints`（`billing_account.addon_available_qty`） |
| `planPointsExpireAt` | string(date-time) \| null | 是 | 本期套餐积分清零时刻（“10-12 24:00 清零”）；非生效中为 `null` | 同 `Wallet.points.planPointsExpireAt`（当前周期 `subscription_term.ends_at`） |
| `isAddonSuspended` | boolean | 是 | 加购积分停用（套餐过期） | 同 `Wallet.points.isAddonSuspended` |

`OverviewStoresCard`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `visibleCount` | integer | 是 | “我的门店 · 2 家”，与 `m.store.list` 的条数一致（含老板停用的门店，不含草稿删除的） | `store`（`store.archive_reason` 不是 `draft_deleted`） |
| `storeLimit` | integer | 是 | “可管理 3 家” | m02-tenant 的 `tenant.getQuotaUsage(entityId)` 的 `storeLimit`（m02 2.1） |
| `reviewingStores` | array<object> | 是 | 资质审核中的门店 `{ storeId, name }`（“春熙店审核中”）；没有为 `[]` | `store.qualification_status = pending` |

`OverviewEntries`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `adPendingConfirmCount` | integer | 是 | 我的广告“1 条待确认” | m04-mall-order 2.9 的 `order.countTodos(tx, storeId, viewerRole)` 中 `ad_confirm` 一项（本门店 `ad.status = pending_confirm`） |
| `launchTaskTodoCount` | integer | 是 | 发布任务待上线数 | 与 `m.launchTask.summary` 的 `todo` 同口径（m05-delivery-publish） |
| `hasLaunchTasks` | boolean | 是 | 是否已有上线任务；为假时副标题“成片交付后生成” | 本门店存在 `launch_task` 行 |
| `channelAccountCount` | integer | 是 | 已绑定的渠道账号数；为 0 时副标题“待绑定” | 本门店 `channel_account.status` 不是 `unbound` 的行数 |
| `channelAccountAttention` | `ChannelAccountAttention` \| null | 是 | 需要处理的账号（“视频号需补充截图”）：取最早一条 `abnormal`，没有再取 `pending_verify`；都没有为 `null` | 见下 |
| `ticketAwaitingConfirmCount` | integer | 是 | 帮助与客服的角标：待您确认的工单数 | `order.countTodos` 中 `ticket_confirm` 一项（本门店 `service_ticket.status = awaiting_confirm`） |

`ChannelAccountAttention`（字段名与 m05-delivery-publish 的渠道账号结构一致）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `channelAccountId` | string(uuid) | 是 | 账号 | `channel_account.id` |
| `platform` | enum | 是 | `douyin` / `wechat_channels`，同数据模型 `channel_account.platform` | `channel_account.platform` |
| `status` | enum | 是 | `abnormal` / `pending_verify` | `channel_account.status` |
| `abnormalSource` | enum \| null | 是 | `verify` 核验未通过（端上拼“需补充截图”）/ `manual` 发布专员手动标记（端上拼“账号异常”）；`status = abnormal` 时有值，否则为 `null` | `channel_account.abnormal_source` |
| `abnormalReason` | `DictRef` \| null | 是 | 异常原因 `{ code, name }`（如“主页截图不完整”）；不是异常为 `null`（C85、A151；同 m05 `ChannelAccountCard.abnormalReason`） | `channel_account.abnormal_reason_code`，名称取 `dict_item.name`（字典 `reject_reason`，场景 `account_verify`） |

`MeOverviewForClerk`（店员视图，C56：只有门店、成员、消息、客服、设置）：`viewerRole`（恒为 `clerk`）、`currentStore`（`OverviewStore` 去掉 `completenessPct`、`review`）、`stores`（只有 `visibleCount`：本人 `store_member` 所列门店数）、`unreadMessageCount`。不返回套餐与积分、门店概览、订单与发布入口。

### 2.5 `ServiceManagerView` 专属服务经理

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `manager` | `ServiceManagerCard` \| null | 是 | 名片；门店尚未分配交付经理时为 `null`，端上显示“服务经理将在 1 个工作日内联系您”（m04-mall-order 第 6 节第 6 项） | `store.delivery_manager_id` → `staff` |
| `manager.name` | string | 是 | 称呼（“小林”） | `staff.display_name`，为空取 `staff.name` |
| `manager.roleKind` | enum(`StaffRoleKind`) | 是 | 恒为 `service_manager`（“专属服务经理”） | 计算 |
| `manager.wecomQr` | `ImageRef` \| null | 是 | 企业微信“联系我”二维码；未生成也未人工上传时为 `null`，端上隐藏“添加企业微信” | `staff.wecom_qr_file_id` |
| `manager.serviceTel` | string \| null | 是 | 服务电话（工作电话或座机，可带分机号）；为空时不显示“拨打电话”。不是员工的登录手机号 | `staff.service_phone` |
| `manager.isWecomAdded` | boolean | 是 | 本人是否已加该经理为企业微信好友（“已添加”） | `wecom_contact`（`merchant_user_id` = 本人、`staff_id` = 经理、`removed_at` 为空） |
| `workHours` | object | 是 | “工作时间 09:00～18:00”：`start`、`end`（`HH:mm`） | 参数 `work.start`、`work.end`（14-config-data.md:295） |
| `responsePromise` | object | 是 | “工作时间内 30 分钟响应，24 小时内给出处理方案”：`firstResponse`、`solution` 各为 `{ amount: integer, unit: enum }`，`unit` 取 `work_minutes` / `work_days` / `natural_hours` / `natural_days` | 参数 `sla.service.first_response`、`sla.service.solution` 的当前值（14-config-data.md:294） |

### 2.6 `ServiceTicketCard` 工单卡片

“我的工单”列表的一行（M:Service）。m06-ad 的 `AdRelatedServiceTicket` 是它的子集。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `serviceTicketId` | string(uuid) | 是 | 工单 id | `service_ticket.id` |
| `ticketNo` | string | 是 | 工单号（`KF20260929011`） | `service_ticket.ticket_no` |
| `status` | enum(`ServiceTicketStatus`) | 是 | 同数据模型 `service_ticket.status` | `service_ticket.status` |
| `type` | `DictRef` | 是 | 问题类型 `{ code, name }`（C85、A151；列非空，恒有值）；字典项停用后仍取其名称 | `service_ticket.type_code`，名称取 `dict_item.name`（字典 `ticket_type`） |
| `title` | string | 是 | 标题：问题描述第一行的前 30 字 | 计算：`service_ticket.description`（12-support.md:90，不单独存列） |
| `relatedOrder` | `RelatedOrderBrief` \| null | 是 | “关联订单 LYX…”；没有为 `null`（“未关联订单”） | 见 2.7 |
| `autoResolveAt` | string(date-time) \| null | 是 | 待您确认时的自动解决时刻 | `service_ticket.auto_resolve_at` |
| `createdAt` | string(date-time) | 是 | 提交时间（列表显示“09-29”） | `service_ticket.created_at` |

### 2.7 `ServiceTicketDetail` 工单详情

`m.serviceTicket.get` 的响应，也是提交与各动作的响应。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `serviceTicketId` | string(uuid) | 是 | 工单 id | `service_ticket.id` |
| `ticketNo` | string | 是 | 工单号 | `service_ticket.ticket_no` |
| `status` | enum(`ServiceTicketStatus`) | 是 | 当前状态 | `service_ticket.status` |
| `source` | enum | 是 | `weapp` 小程序提交 / `online_chat` 客服按在线客服会话登记 / `phone` 客服按来电登记，同数据模型 `service_ticket.source` | `service_ticket.source` |
| `type` | `DictRef` | 是 | 问题类型 `{ code, name }`（C85、A151） | 同 `ServiceTicketCard.type` |
| `title` | string | 是 | 同 `ServiceTicketCard.title` | 计算 |
| `description` | string | 是 | 问题描述 | `service_ticket.description` |
| `images` | array<`ImageRef`> | 是 | 问题图片；没有为 `[]` | `service_ticket.image_file_ids` |
| `contactPhoneMask` | string \| null | 是 | 联系电话脱敏串（本人也只看脱敏值，C40） | `service_ticket.contact_phone_mask` |
| `relatedOrder` | `RelatedOrderBrief` \| null | 是 | 关联订单（可跳转） | 见下 |
| `owner` | `MerchantStaffBrief` \| null | 是 | 处理人（“服务经理 小林”）；没有负责人时为 `null`（端上显示“待分配”） | `service_ticket.owner_staff_id` → `staff` |
| `progress` | array<`TicketProgressStep`> | 是 | 四步进度条 | 见下 |
| `firstResponseAt` | string(date-time) \| null | 是 | 首次回复时间 | `service_ticket.first_response_at` |
| `awaitingConfirmAt` | string(date-time) \| null | 是 | 最近一次进入待您确认的时间 | `service_ticket.awaiting_confirm_at` |
| `autoResolveAt` | string(date-time) \| null | 是 | “10-01 11:45 前未确认的，将自动变为已解决” | `service_ticket.auto_resolve_at` |
| `resolvedAt` | string(date-time) \| null | 是 | 解决时间 | `service_ticket.resolved_at` |
| `resolvedVia` | enum \| null | 是 | `merchant` 商家确认 / `auto` 到期自动解决，同数据模型 `service_ticket.resolved_via` | `service_ticket.resolved_via` |
| `reopenDeadlineAt` | string(date-time) \| null | 是 | 已解决的工单还能重新打开到何时；不在已解决状态、或参数为 0 时为 `null` | 计算：`service_ticket.resolved_at` + 参数 `service.reopen_window_days` 天 |
| `closedAt` | string(date-time) \| null | 是 | 关闭时间 | `service_ticket.closed_at` |
| `closeReason` | enum \| null | 是 | `duplicate` / `invalid` / `withdrawn`，同数据模型 `service_ticket.close_reason` | `service_ticket.close_reason` |
| `withdrawReason` | `DictRef` \| null | 是 | 商家撤回时选的原因 `{ code, name }`（“您已撤回工单（问题已解决）”取 `name`）；不是商家撤回为 `null`（C85、A151） | `service_ticket.withdraw_reason_code`，名称取 `dict_item.name`（字典 `ticket_withdraw_reason`） |
| `closeNote` | string \| null | 是 | 员工关闭时填的说明 | `service_ticket.close_note` |
| `reopenedCount` | integer | 是 | 重新打开次数 | `service_ticket.reopened_count` |
| `entries` | array<`ServiceTicketEntryView`> | 是 | 处理记录（“共 N 条”），只含商家可见的条目，按 `created_at`、`id` 升序 | `service_ticket_entry`（`service_ticket_entry.is_visible_to_merchant = true`，12-support.md:236） |
| `actions` | array<enum(`ServiceTicketAction`)> | 是 | 当前可执行：`withdraw`（`pending`、`processing`）、`confirm`（`awaiting_confirm`）、`reopen`（`awaiting_confirm`，或 `resolved` 且未过 `reopenDeadlineAt`） | 计算（C16） |
| `canAddEntry` | boolean | 是 | 是否显示补充说明输入区：仅 `processing` | 计算（12-support.md:152） |
| `createdAt` | string(date-time) | 是 | 信息区“提交时间 2026-09-29 15:20”（Ticket.dc.html、TicketDone.dc.html 的信息区） | `service_ticket.created_at` |

`RelatedOrderBrief`：`orderId`（string(uuid)，`drama_order.id`）、`orderNo`（string，`drama_order.order_no`）。商家端只取订购单：`service_ticket_ref` 中 `ref_type = drama_order` 且 `created_at` 最早的一行；没有为 `null`（“未关联订单”）。这与后台工单池“商家与单号”一栏的取法不同（12-support.md:370 与 a08 的 `primaryRef` 在 `drama_order`、`billing_order` 两类里取最早一条），实现时单独写这个查询，不复用 a08 的 `primaryRef`，以免把付款单 id 填进 `orderId`。付款单、交付工单、广告、审批单的关联只在后台展示。

`TicketProgressStep`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `step` | enum | 是 | `submitted` 已提交 / `processing` 处理中 / `awaiting_confirm` 待您确认 / `resolved` 已解决，四步固定顺序 | 固定 |
| `at` | string(date-time) \| null | 是 | 本轮到达该步的时刻；未到为 `null` | 计算：`submitted` 取 `service_ticket.created_at`；其余取本轮（最近一次 `submit`、`register` 或 `reopen` 之后）`status_transition` 中 `to_state` 为该状态的最早一行的 `occurred_at`；重新打开的工单 `processing` 即重开时刻（原型 TicketDone 的“已重新打开”态） |
| `state` | enum | 是 | `done` / `current` / `todo` | 计算：按当前状态；已关闭的工单停在关闭前的那一步，另由 `closedAt` 表达 |

进度条读 `status_transition` 是数据模型允许的用途（M31：“只供指标与进度时间轴”）。

`ServiceTicketEntryView`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `entryId` | string(uuid) | 是 | 条目 id | `service_ticket_entry.id` |
| `kind` | enum | 是 | `merchant_message` / `staff_reply` / `system_event`（内部备注从不下发） | `service_ticket_entry.kind` |
| `tag` | enum \| null | 是 | `submit` 提交工单 / `supplement` 补充说明 / `reopen` 重新打开 / `reply` / `solution` / `result` 处理结果 / `transfer` / `status` / `biz_event`，同数据模型 `service_ticket_entry.tag` | `service_ticket_entry.tag` |
| `senderKind` | enum(`EntrySenderKind`) | 是 | `me` 本人 / `merchant` 本主体的其他商家用户 / `staff` 平台员工 / `system` 系统 | 计算：`kind = system_event` 时恒为 `system`（转派、状态变更、业务事件的操作人是员工或商家，但对商家一律按系统行展示，不带发送人）；`merchant_message`、`staff_reply` 按 `service_ticket_entry.actor_type`、`service_ticket_entry.actor_id` 与当前用户比对（员工代录的提交条目为 `staff`） |
| `sender` | `MerchantStaffBrief` \| null | 是 | `senderKind = staff` 时的发送人与岗位（“唐悦 · 客服”）；其余（含全部系统事件）为 `null` | `service_ticket_entry.actor_id` → `staff`（读取时取当前值，不快照，12-support.md:279） |
| `body` | string \| null | 是 | 正文。系统事件取面向商家的文案 | `merchant_message`、`staff_reply`：`service_ticket_entry.body`；`system_event`：`service_ticket_entry.merchant_body`，为空才取 `body`（数据模型的回落规则，12-support.md:254；凡商家可见的系统事件，写入方都填 `merchant_body`，见 3.7 说明） |
| `images` | array<`ImageRef`> | 是 | 图片；没有为 `[]` | `service_ticket_entry.image_file_ids` |
| `link` | `EntryLink` \| null | 是 | 深链按钮（“去确认新片尾”） | `service_ticket_entry.link` |
| `createdAt` | string(date-time) | 是 | 条目时间；业务事件条目为源事件发生时刻 | `service_ticket_entry.created_at` |

### 2.8 `MessageItem` 站内消息与 `MessageSummary` 未读计数

`MessageItem`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `messageId` | string(uuid) | 是 | 消息 id（UUID v7，按时间有序） | `merchant_message.id` |
| `category` | enum(`MessageCategory`) | 是 | 分类，同数据模型 `merchant_message.category` | `merchant_message.category` |
| `title` | string | 是 | 标题（派发时已按接收人角色与购买入口模式渲染） | `merchant_message.title` |
| `body` | string | 是 | 正文 | `merchant_message.body` |
| `ctaText` | string \| null | 是 | 按钮文案 | `merchant_message.cta_text` |
| `link` | `DeepLink` | 是 | 点击跳转的目标 | `merchant_message.link` |
| `storeId` | string(uuid) \| null | 是 | 所属门店；主体级与账号级消息为 `null` | `merchant_message.store_id` |
| `isRead` | boolean | 是 | 是否已读 | 计算：`merchant_message.read_at` 非空 |
| `readAt` | string(date-time) \| null | 是 | 已读时间 | `merchant_message.read_at` |
| `createdAt` | string(date-time) | 是 | 时间 | `merchant_message.created_at` |
| `createdDate` | string(date) | 是 | 北京时间的日期，端上据此分“今天 / 昨天 / 日期”组（C35） | 计算：`merchant_message.created_at` |

`MessageSummary`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `total` | integer | 是 | 当前上下文下的未读总数（“我的”与首页的角标） | `merchant_message`（`read_at` 为空，可见范围同 3.14） |
| `byTab` | array<object> | 是 | `{ tab: enum(MessageTab), unreadCount: integer }`，每个页签一项（`all`、`order`、`delivery`、`launch`、`plan_points`、`review`、`store`、`service`，顺序同页签；`all` 等于 `total`）。页签名放在值里、不作键，避开 C57 的禁用模式（`plan_points`） | 同上，按 `merchant_message.category` 分组；走部分索引 `ix_merchant_message_unread` |
| `byStore` | array<object> | 是 | `{ storeId, unreadCount }`：切换门店弹层上各店的角标，`unreadCount` 是切到该店时看到的未读数（含主体级与账号级消息）；只列本人在当前主体能进的门店；无门店上下文时为 `[]` | 同上，按 `merchant_message.store_id` 分组再加上 `store_id` 为空的部分 |

### 2.9 `NotifySettings` 通知设置

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `items` | array<`NotifySettingItem`> | 是 | 每个订阅消息槽位一行，按槽位登记顺序 | `wx_template_slot` |
| `cooldownDays` | integer | 是 | 同引导接口 `subscribeCooldownDays` | 参数 `notify.wx.ask_cooldown_days` |
| `maxPerAsk` | integer | 是 | 同引导接口 `subscribeMaxPerAsk` | 参数 `notify.wx.max_per_ask` |

`NotifySettingItem`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `slotKey` | string | 是 | 槽位键（`pay_result`、`service_progress` 等） | `wx_template_slot.slot_key` |
| `title` | string | 是 | 模板标题 | `wx_template_slot.title` |
| `sceneNames` | array<string> | 是 | 这个槽位覆盖的通知（“样片待确认”“成片已交付”…） | `notify_scene.name`（`notify_scene.wx_template_slot_key` = 本槽位、`notify_scene.audience = merchant`、`notify_scene.scene_enabled`、`notify_scene.ext_enabled`） |
| `tmplId` | string \| null | 是 | 点“开启”时传给 `wx.requestSubscribeMessage` 的模板 id；槽位不可用时为 `null` | `wx_template_slot.provider_template_id`（仅 `wx_template_slot.status = active`） |
| `state` | enum(`NotifySlotState`) | 是 | `on` 已开启（估计还有额度）/ `off` 未开启或已用完 / `rejected` 已在微信“服务通知”里关闭 / `banned` 模板被封 / `unavailable` 槽位未配置或已停用 | 计算：`wx_template_slot.status`；本会话微信身份（`user_session.wechat_identity_id`）在该槽位的 `wx_subscribe_quota.state`、`wx_subscribe_quota.est_remaining` |
| `estRemaining` | integer | 是 | 估计剩余可发条数（只是估计，以微信返回码为准，13-notify-docs.md:573） | `wx_subscribe_quota.est_remaining`；没有行为 0 |
| `lastAcceptAt` | string(date-time) \| null | 是 | 最近一次授权时间 | `wx_subscribe_quota.last_accept_at` |

### 2.10 上传：`FileRegistration`、`FileStatusView`

`FileRegistration`（登记与续签的响应，C59；d5-media.md:1026）：本文是归属文档（A150、C87 登记表），只在这里定义一次；a01-system 2.17 的后台登记与续签引用本结构（a01 的表格只作速查），两端上传工具共用。子结构 `PostPolicy`、`StsCredential` 同样由本文定义、a01 引用。初稿名 `FileUploadTicket` 不再使用。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `fileId` | string(uuid) | 是 | 文件 id；业务提交时引用它 | `file_object.id` |
| `clientToken` | string | 是 | 回显请求里的续传标识，端上据此对应本地文件 | `file_object.client_token` |
| `status` | enum(`FileStatus`) | 是 | 登记与续签时恒为 `pending` | `file_object.status` |
| `mode` | enum | 是 | `post` 表单直传（≤20MB）/ `multipart` 分块（STS 临时密钥），由服务端定 | `file_object.upload_mode` |
| `bucket` | string | 是 | 写入区所在桶（直传需要，C59 的例外） | `file_object.incoming_bucket` |
| `region` | string | 是 | 存储地域 | 部署配置 |
| `key` | string | 是 | 写入区对象键 `incoming/{fileId}/…` | `file_object.incoming_key` |
| `post` | `PostPolicy` \| null | 是 | `mode = post` 时的表单：`url`（string）、`fields`（object，string → string，含 key、policy 与签名字段）；否则为 `null` | 服务端本地签名，10 分钟（d5-media.md:966） |
| `sts` | `StsCredential` \| null | 是 | `mode = multipart` 时的临时密钥：`tmpSecretId`、`tmpSecretKey`、`sessionToken`（string）、`startTime`、`expiredTime`（string(date-time)）；权限只到 `incoming/{fileId}/*`；否则为 `null` | 腾讯云 STS，30 分钟（d5-media.md:967、1076-1095） |
| `chunkSize` | integer \| null | 是 | 分块字节数（4MB）；`post` 为 `null` | 上传配置（d5-media.md:1133） |
| `chunkParallel` | integer \| null | 是 | 分块并发数（2）；`post` 为 `null` | 同上 |
| `expiresAt` | string(date-time) | 是 | 本次凭证的过期时刻 | 计算 |
| `uploadExpiresAt` | string(date-time) | 是 | 登记的过期时刻（登记后 24 小时）；过期后由清扫置为 `expired` | `file_object.upload_expires_at` |
| `credentialsLeft` | integer | 是 | 还能续签临时密钥的次数（上限 30）；`post` 通道重签表单不计次，值不变 | 计算：30 − `file_object.sts_issued` |

`FileStatusView`（查询、确认、取消的响应）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `fileId` | string(uuid) | 是 | 文件 id | `file_object.id` |
| `category` | enum(`MerchantUploadCategory`) | 是 | 文件分类 | `file_object.category` |
| `status` | enum(`FileStatus`) | 是 | `pending` / `promoting` / `stored` / `rejected` / `expired` / `deleting` / `deleted`，同数据模型 `file_object.status` | `file_object.status` |
| `rejectReason` | enum \| null | 是 | 拒收原因，同数据模型 `file_object.reject_reason` | `file_object.reject_reason` |
| `declaredSizeBytes` | string(bigint) | 是 | 登记时声明的字节数 | `file_object.declared_size` |
| `sizeBytes` | string(bigint) \| null | 是 | 入库后的实际字节数 | `file_object.size_bytes` |
| `mime` | string \| null | 是 | 入库时写入的规范类型 | `file_object.mime` |
| `moderationState` | enum | 是 | 内容安全审核状态，同数据模型 `file_object.moderation_state`；`block` 的文件业务接口不接受（`FILE_NOT_USABLE`） | `file_object.moderation_state` |
| `storedAt` | string(date-time) \| null | 是 | 入库时间 | `file_object.stored_at` |
| `uploadExpiresAt` | string(date-time) \| null | 是 | 登记过期时刻 | `file_object.upload_expires_at` |
| `createdAt` | string(date-time) | 是 | 登记时间 | `file_object.created_at` |

### 2.11 埋点：`AnalyticsEventBatch`、`AnalyticsIngestResult`

`AnalyticsEventBatch`（请求体，≤64KB；d6-notify-docs-data.md:1904-1911，时刻按 C34 改为 ISO 字符串）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `sentAt` | string(date-time) | 是 | 带偏移 | 端上发送时刻，用来算时钟偏差 |
| `anonymousId` | string(uuid) | 是 | — | 本机首次启动生成并持久化（`lyx.anonymousId`）→ `analytics_event.anonymous_id` |
| `sessionId` | string(uuid) | 是 | — | 每次冷启动一个 → `analytics_event.session_id` |
| `clientVersion` | string | 是 | ≤16 字符 | → `analytics_event.client_version` |
| `platform` | enum | 是 | `ios` / `android` / `harmony` / `windows` / `mac` / `devtools` | → `analytics_event.client_platform` |
| `scene` | integer | 否 | — | 微信场景值 → `analytics_event.scene` |
| `events` | array<`ClientAnalyticsEvent`> | 是 | 1–50 条 | 见下 |

`ClientAnalyticsEvent`：`eventId`（string(uuid)，必填，→ `analytics_event.event_id`）、`name`（enum(`ClientEventName`)，必填）、`occurredAt`（string(date-time)，必填，端上时刻）、`storeId`（string(uuid)，可选，发生时的门店上下文）、`props`（object，必填，按下表该事件的 schema `.strict()` 校验，不允许自由字符串，14-config-data.md:1151-1161 → `analytics_event.props`）。

端上事件的属性 schema（14 分组 4.8 把“其余事件的属性”留到契约阶段定，本文给出；登记在 `packages/contract/src/analytics/events.ts`）。`Code` 指 `^[A-Za-z0-9_-]{1,16}$`（字典编码、枚举值、页面键）；手机号、证照号、邀请令牌一律不进属性：

| 事件（`name`） | `props` | 说明 |
| --- | --- | --- |
| `app_launch` | `{ channelCode?: Code, hasInvitation: boolean }` | 渠道码取启动参数；由邀请链接进入时 `hasInvitation = true`，邀请令牌本身不上报（A3）；场景值在批次头 `scene` |
| `profile_step_save` | `{ step: integer(1–4), durationMs: integer(≥0) }` | 建档第几步（与 m03-profile-asset 的步骤编号一致）、本步从进入到保存成功的耗时 |
| `store_switch` | `{ fromPage: Code }` | 发起切换的页面键 |
| `mall_view` | `{ category?: Code, filters?: { genre?: Code, industry?: Code, episodes?: Code, price?: Code }, sort?: enum(composite / heat / price_asc / price_desc / newest), mode: enum(list / trailer) }` | 同 14 分组 4.8 与 d6-notify-docs-data.md:1895 |
| `trailer_play` | `{ dramaId: string(uuid), playMs: integer(0–3,600,000), finished: boolean }` | 同 14 分组 4.8（d6 写的数字 id 按 C29 改为 uuid） |
| `drama_detail_view` | `{ dramaId: string(uuid), fromPage: Code }` | 来源页面 |
| `share_click` | `{ page: Code, dramaId?: string(uuid) }` | 分享按钮所在页面；在短剧页时带剧目 |
| `banner_click` | `{ homeBannerId: string(uuid) }` | a09-ops 的 Banner 点击数按 `props.homeBannerId` 聚合 |
| `playback_fallback` | `{ playableId: string(uuid), network: enum(NetworkType), fromQuality: enum(hd / sd), toQuality: enum(hd / sd), sdkVersion?: string(^\d+(\.\d+){0,3}$) }` | d7-platform.md:795；机型、系统是自由字符串，不进属性（平台、版本取批次头） |
| `trailer_first_frame` | `{ playableId: string(uuid), firstFrameMs: integer(≥0), network: enum(NetworkType), quality: enum(hd / sd) }` | d7-platform.md:802 |

`AnalyticsIngestResult`：`accepted`（新落库的条数）、`duplicated`（`event_id` 已见过的条数）、`rejected`（不合 schema、不在端上事件清单、早于 7 天的条数）、`dropped`（匿名事件全站日总量超限而丢弃的条数），均为 integer。

## 3. 接口

### 3.1 m.bootstrap.get　启动引导

`GET /m/bootstrap`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `optional`（有令牌则解析，登录后多返回个性化块）；无能力点 |
| 店员视图 | `same` |
| 幂等 | none（纯查询，GET 不写库，A18、A19） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无（本接口下发开关本身） |
| 版本门槛与协议同意 | 不受最低版本门槛拦截（A39、C71）；在协议同意白名单内（C73） |
| 对应画板 | M:Main、M:Login；无画板：全局（冷启动、回到前台超过 5 分钟） |
| 出处 | 路线图 `m08.bootstrap.get`；d7-platform.md:470-504；d6-notify-docs-data.md:875-885、2238；d4-identity.md:372（合并其 `GET /m/config/public`）；A39；C69、C72 |

**请求**：路径参数、查询参数、请求体：无。请求头 `X-Store-Id` 可选：带且本人对该门店有成员关系时，按该门店所属主体求值（开关的主体白名单、订阅清单的购买入口模式）；带了但没有成员关系时按“无门店上下文”求值，不返回 403（引导接口不能因门店失效而失败，端上随后调 `m.me.get` 纠正上下文）。

**响应**：`data` 为 `Bootstrap`（2.2）。

**错误**：无业务错误。各块取数失败只写进 `degraded`；全部块都失败时返回 500 `INTERNAL`（d7-platform.md:500）。

**副作用**：无。

**说明**：
- 拼装（d7-platform.md:491-500）：各块独立取数、互不拖累；某块抛错时取保守默认值并把块名写进 `degraded`：开关取登记表里的默认值、`subscribePlan` 取 `[]`、`pendingConsents` 取 `[]`（由 428 `CONSENT_REQUIRED` 兜底）、`copy` 取 `{}`、`notice` 取 `null`、`context` 取 `null`。
- 订阅清单按购买入口模式裁剪（d6-notify-docs-data.md:885）：模式不是 `in_app` 时去掉 `pay_success`、`renew_enter` 两个点位；`hidden` 时再从各点位去掉 `svc_expiry`、`quota_change` 两个槽位。模式按当前门店所属主体求值，经 m07-billing 的 `billing.getPurchasePolicy(ctx)`（与 `m.purchasePolicy.get` 同一函数）；无门店上下文时按请求平台的缺省模式。店员看到的清单与老板相同（端上只在本角色能点的按钮上用到对应点位）。
- 三个 `weapp.video.*` 开关决定预告片、样片、广告能否在小程序内播放（d7-platform.md:510-516；V1.0 默认：预告片关、样片关、广告开，14-config-data.md:594-596）。`support.mode = wecom_kf` 时“在线客服”直接拉起微信客服会话（设计规范第 11 节），不调本系统接口。
- 响应含个人数据（待同意协议、当前门店），带 `Cache-Control: no-store`（C18）；端上存 `lyx.bootstrap`，接口失败用缓存，再没有用代码内保守默认值（d7-platform.md:502-504）。
- 停机维护期间（C72）：网关对本接口放行，由应用返回带 `notice` 的引导；应用不可用时网关返回静态的维护引导。购买策略不在这里，由 `m.purchasePolicy.get` 与报价接口返回（C69）。

### 3.2 m.dictItem.list　数据字典

`GET /m/dict-items`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `public`；无能力点 |
| 店员视图 | `same` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileBasic、M:ProfileService、M:StoreAdd（行业、区划、卖点）、M:Mall（题材、卖点标签）、M:AssetUpload（素材标签）、M:Service（工单类型）、M:Ticket（撤回原因） |
| 出处 | 路线图 `m08.dict.list`；d6-notify-docs-data.md:1512-1515、2246；d9-profile.md:674；14-config-data.md:55-240；C10（`/m/dicts` 改 `/m/dict-items`） |

**请求**（查询参数 `DictItemListQuery`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `typeKey` | string | 是 | 可多值（逗号分隔，C45），1–10 个类型键；每个都必须是小程序可见的类型（`dict_type.is_merchant_visible = true`） | 如 `typeKey=industry,region`（初稿名 `types`；按 C45 用 DTO 字段名，与 a01 `admin.dictItem.list` 统一） |
| 查询 | `parentCode` | string | 否 | 只在 `typeKey` 恰为一个树形类型时可用 | 只返回该编码的直接下级（`dict_item.parent_code = parentCode`），用于行政区划懒加载（`?parentCode=510100`；初稿名 `parent`） |
| 查询 | `includeDisabled` | boolean | 否 | 默认 `false` | 为 `true` 时同时返回已停用、未开放、未开通的项（`isSelectable = false`），供端上把历史数据里的编码映射成名称 |

**响应**：`data` 为 `DictItemListResult`，即 `{ items: DictTypeItems[] }`（2.3；有界小集合不分页，C42、A78）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 类型键不存在或小程序不可见；`parentCode` 与多个类型或平铺类型同用 |

**副作用**：无。

**说明**：
- 过滤（d6-notify-docs-data.md:1512）：缺省只下发可选的项：`dict_item.is_enabled = true`；`industry` 另要求 `ext.open = true`；`region` 另要求 `ext.opened = true`。
- `ext` 只下发白名单里的键（其余是后台内部用的）：`industry` → `special`、`requiredCerts`；`region` → `level`、`functionalZone`；`asset_tag` → `dimension`；`store_selling_point` → `categoryCodes`；`permit_type` → m03-profile-asset 2.8 `PermitTypeExt` 中“下发”为“是”的键（`fields`、`holderNameKey`、`certNoKey`、`certNoPattern`、`principalNameKey`、`validFromKey`、`validToKey`）；`ticket_type` → 只下发 `isAfterSales`（boolean，售后类问题类型，端上据此决定提交工单时是否另请求 `refund_result` 槽位，2.2；14 分组已登记，四键必填，14-config-data.md:104、1069；A145），`defaultPriority`、`transferable`、`notifyLead` 不下发；其余类型为 `{}`。
- V1.0 小程序会用到的类型：`industry`、`region`、`genre`、`selling_tag`、`store_selling_point`、`permit_type`、`custom_focus`、`asset_tag`、`ad_promo_point`、`ticket_type`、`ticket_withdraw_reason`、`plan_tier`、`point_type`（14-config-data.md:97-120 的“小程序可见”一栏）。路线图摘要里的 `selling_point`、`asset_topic` 不是登记的类型键，按 14 分组改为 `selling_tag` / `store_selling_point`、`asset_tag`。
- 缓存：端上按类型整份缓存，`versionNo` 与引导接口的 `versions.dict` 一致就不重拉（d6-notify-docs-data.md:1513）。
- 写接口对新选择调 `dicts.assertEnabled`，选到已停用的项返回 `DICT_ITEM_DISABLED`（本文定义，第 5 节；共用领域码，A77）。

### 3.3 m.me.overview.get　“我的”页聚合

`GET /m/me/overview`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `me.*`（老板、店员、已停用门店老板都有，d4-identity.md:871） |
| 店员视图 | `trimmed`：`MeOverviewForClerk`（2.4） |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Mine（M32） |
| 出处 | 路线图 `m08.me-summary.get`；proto-merchant-b.md:225-240；d4-identity.md:902；d7-platform.md:692-693；C56；C83（`/m/me/summary` 改 `/m/me/overview`） |

**请求**：路径参数、查询参数、请求体：无。

**响应**：老板 `MeOverview`，店员 `MeOverviewForClerk`（2.4），按 `viewerRole` 判别。

**错误**：无业务错误（`NOT_A_MEMBER` 等按约定）。

**副作用**：无。

**说明**：
- 口径一律调用拥有方的计算函数，不另起口径：门店卡与门店数同 m02-tenant（`StoreCard`；`storeLimit` 取 `tenant.getQuotaUsage`）；套餐与积分卡取 m07-billing `billing.getWalletView`；上线中、交付中、选剧单取 m04-mall-order 2.9 的 `order.countOrderItemsByPhase` 的 `live`、`delivering` 与 `order.countCartBadge`（m02 门店卡用同一函数；“交付中”不含待开工，与 m04“待上线”页签的 `to_launch` 是两个量）；广告待确认、工单待确认取 m04 的 `order.countTodos`；发布任务同 m05-delivery-publish `m.launchTask.summary`；未读数同 3.15。
- 账号抬头（称呼、手机号脱敏串、成员关系、待同意协议）取 m01-account 的 `m.me.get`，本接口不重复返回 `MeView` 的字段。
- 专属服务经理卡不在本接口，取 `m.serviceManager.get`（3.4）。“我的订单”的状态角标由 m04 的订单计数给，原型“我的”页未画数字。
- 店员视图不含任何积分、金额、订单、发布字段，键名避开 C57 的禁用模式。

### 3.4 m.serviceManager.get　专属服务经理名片

`GET /m/service-manager`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `support.manager.read`（老板、店员、已停用门店老板都有；新键，进增补表，A87、C56、C66） |
| 店员视图 | `same`（A33：店员进入客服中心只看到服务经理名片与在线客服入口） |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Service、M:Mine、M:PayResult、M:OrderDetail、M:LaunchRecord |
| 出处 | 路线图 `m08.service-manager.get`；proto-merchant-b.md:186-192；proto-merchant-a.md:390、398；PRD 6.12-2；01-architecture.md:420；05-risks-and-open-issues.md:296；A12、A33；C56、C57 |

**请求**：路径参数、查询参数、请求体：无。

**响应**：`data` 为 `ServiceManagerView`（2.5）。

**错误**：无业务错误。

**副作用**：无。

**说明**：
- 服务经理即门店的交付经理（`store.delivery_manager_id`）。本接口每次现读、不缓存：a03-merchant 转移交付经理（发 `assignment.transferred`）、首次指派（A91）与 staff 模块的禁用移交（`staff.I1`）都在各自事务里改 `store.delivery_manager_id`，下一次请求即返回新经理；换人后 `isWecomAdded` 按新经理重算。尚未分配时 `manager = null`。
- 名片字段 `staff.display_name`、`staff.service_phone`、`staff.wecom_qr_file_id` 由后台 a01-system 的 `admin.staff.create`、`admin.staff.update` 维护。
- 企业微信“联系我”二维码由接口生成后落库，企业微信不可用时人工上传（01-architecture.md:420；05 第 5 节 V15）；长按识别是否可用待真机验证，端上同时提供“添加企业微信”组件。
- “添加企业微信”不受去“微信”字样的约束（设计规范第 11 节）。电话字段叫 `serviceTel`，避开店员禁用模式里的 `phone`（C57）。

### 3.5 m.serviceTicket.list　我的工单

`GET /m/service-tickets`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ticket.*`（老板 ✔，店员 ✘，已停用门店老板 ✔，d4-identity.md:869） |
| 店员视图 | `none`（403 `ROLE_FORBIDDEN`，A33） |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Service“我的工单” |
| 出处 | 路线图 `m08.service-ticket.list`；proto-merchant-b.md:187-192；12-support.md:98 |

**请求**（查询参数 `ServiceTicketListQuery`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `status` | string | 否 | `ServiceTicketStatus` 的取值，逗号分隔多值 | 按状态筛选；不传为全部 |
| 查询 | `cursor` | string | 否 | 不透明游标 | 首页不传 |
| 查询 | `limit` | integer | 否 | 1–50，默认 20 | — |

**响应**：`data` 为 `ServiceTicketPage`，即 `CursorPage<ServiceTicketCard>` = `{ items: ServiceTicketCard[], nextCursor, hasMore }`（2.6；通用结构，C42、C87），按 `service_ticket.created_at` 倒序、`id` 倒序；走 `ix_service_ticket_store_id_created_at`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `ROLE_FORBIDDEN` | 403 | 店员 |

**副作用**：无。

**说明**：列出当前门店的全部工单，含客服按在线客服、来电登记的（`service_ticket.source` 为 `online_chat`、`phone`；这类工单的回复同样通知该门店老板，13-notify-docs.md:147）。d3 附录 B 没有列商家端工单列表，按原型补。

### 3.6 m.serviceTicket.create　提交工单

`POST /m/service-tickets`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ticket.*` |
| 店员视图 | `none`（A33；12-support.md:515 第 6 节第 1 项：仅老板可提交） |
| 幂等 | `required`（创建并进入状态机，A17） |
| 乐观锁 | 无（新建） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Service（M30 提交工单弹层） |
| 出处 | 路线图 `m08.service-ticket.create`；d3-flow.md:2507、2534-2538、3515；12-support.md:149、185-187；PRD 6.12-4；05-risks-and-open-issues.md:190、193；A25；C40 |

**请求**：路径参数、查询参数：无。请求体 `ServiceTicketCreateBody`：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `typeCode` | string | 是 | 字典 `ticket_type` 内且启用 | 问题类型 → `service_ticket.type_code` |
| `orderId` | string(uuid) | 否 | 当前门店的订购单 | 关联订单（原型默认带出最近一单；候选列表取 m04-mall-order 的 `m.order.list`）→ `service_ticket_ref`（`ref_type = drama_order`） |
| `description` | string | 是 | 去掉首尾空白后 1–500 字 | 问题描述 → `service_ticket.description`，同时作为提交条目的正文 |
| `imageFileIds` | array<string(uuid)> | 否 | 0–9 个，不重复；分类 `ticket_attachment`、已入库、本人在当前门店上传 | 问题图片 → `service_ticket.image_file_ids` |
| `phoneSource` | enum | 是 | `login` 登录手机号 / `store_contact` 门店联系人电话 / `input` 手填 | 联系电话的来源（A25、C40） |
| `contactPhone` | string | 条件 | `phoneSource = input` 时必填，中国大陆 11 位手机号；其余来源不得传 | 手填的号码 |

联系电话由服务端按来源补值：`login` 取 `merchant_user.phone_enc` 解密；`store_contact` 取 `store_profile.contact_phone_enc` 解密（门店未设联系人电话时 400 `VALIDATION_FAILED`，`fieldErrors.path = phoneSource`）；`input` 取请求值。加密后写 `service_ticket.contact_phone_enc`，脱敏串写 `service_ticket.contact_phone_mask`。

**响应**：`data` 为 `ServiceTicketDetail`（2.7），即新工单。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `ROLE_FORBIDDEN` | 403 | 店员 |
| `DICT_ITEM_DISABLED` | 409 | `typeCode` 不在字典里或已停用；`details = { dictTypeKey: 'ticket_type', code }` |
| `NOT_FOUND` | 404 | `orderId` 不存在或不属于当前门店 |
| `FILE_NOT_USABLE` | 400 | 图片未入库、分类不是 `ticket_attachment`、不是本人在当前门店上传、或已被拦截（m03-profile-asset 定义） |
| `VALIDATION_FAILED` | 400 | 描述为空或超长；图片超过 9 张；`contactPhone` 格式不对或与来源不符；门店没有联系人电话却选了 `store_contact` |

**副作用**（同一事务）：
- 状态迁移 `service_ticket.status: （新建）→ pending`（`submit`，12-support.md:149）：工单号 `KF` + 8 位日期 + 3 位日流水（`biz_sequence`）；`source = weapp`、`submitter_user_id` = 本人；`priority` 取字典项 `ext.defaultPriority`；负责人在分配池 `cs` 的当班客服间轮流分配（`assignment_pool_member.on_duty`，d3-flow.md:2536），没有人当班时 `owner_staff_id` 为空（进入客服主管待办）；`response_due_at` = 创建时刻 + 30 工作分钟（参数 `sla.service.first_response`，按工作日历）、`solution_due_at` = 创建时刻 + 24 自然小时（`sla.service.solution`），两段写进 `sla_snapshot`。
- 写一条提交条目（`service_ticket_entry.kind = merchant_message`、`tag = submit`、`actor_type = merchant`、`client = weapp`、`is_visible_to_merchant = true`，正文与图片同工单）；有 `orderId` 时写 `service_ticket_ref`（`ref_type = drama_order`）。
- 图片引用：工单与提交条目的图片各调一次 `files.link()`（`ref_type` 分别为 `service_ticket`、`service_ticket_entry`，角色 `image`，12-support.md:177）。
- 定时器：登记 `service.first_response_due`（第 0 轮）与 `service.solution_due`（12-support.md:185-186；去重键见 x01-events-jobs 4.1）。
- `status_transition` 一行（`event = submit`，`payload` 带 `ownerStaffId`、`responseDueAt`、`responseSla`、`solutionDueAt`，12-support.md:459-461）与同事务的活动流审计（M31）。
- 出站事件 `service_ticket.created`：通知订阅者给负责人发 `s.kf_assigned`（字典项 `ext.notifyLead` 为真时另给客服主管发 `s.complaint_created`）；埋点 `ticket_submit` 由它派生（d6-notify-docs-data.md:1857）。

**说明**：
- 端上在点击“提交”的同步调用链里请求订阅点位 `ticket_submit`：槽位 `ticket_reply`；所选问题类型的 `ext.isAfterSales = true` 时另加 `refund_result`（d6-notify-docs-data.md:868；槽位与模板 id 取引导接口 `subscribePlan` 中该点位的 `slots`，2.2）。结果经 `m.subscribeResult.create` 上报，不在本接口里。
- 原型缺“联系电话”、允许空描述，按 PRD 6.12-4 补字段与必填（05-risks-and-open-issues.md:193）。工单类型以字典为准（原型小程序 9 项、后台 10 项，05 第 2 节）。
- 受平台约束：“在线客服”直接拉起微信客服会话，不调本系统接口，也不做“正在接入在线客服……”（设计规范第 11 节）；需要跟进的在线会话由客服在后台登记成工单（`source = online_chat`，a08-support）。

### 3.7 m.serviceTicket.get　工单详情

`GET /m/service-tickets/{serviceTicketId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ticket.*` |
| 店员视图 | `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Ticket（处理中、已关闭）、M:TicketDone（待您确认、已解决、重新打开后） |
| 出处 | 路线图 `m08.service-ticket.get`；d3-flow.md:2487、3515；12-support.md:234-279；proto-merchant-b.md:194-221；A4（`{ticketId}` 改 `{serviceTicketId}`） |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `serviceTicketId` | string(uuid) | 是 | 当前门店的工单 | — |

**响应**：`data` 为 `ServiceTicketDetail`（2.7）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 工单不存在或不属于当前门店 |
| `ROLE_FORBIDDEN` | 403 | 店员 |

**副作用**：无。

**说明**：
- 内部备注（`internal_note`）与只给后台看的系统事件从不下发，过滤写在查询层，响应 schema 也没有对应字段（d3-flow.md:2487）。系统事件的商家文案取 `merchant_body`，不暴露后台文案里的内部人名与原因；系统事件一律 `senderKind = system`、`sender = null`，端上画成居中的系统行（Ticket.dc.html 的系统行没有发送人）。商家可见的系统事件由写入方填 `merchant_body`：本文的确认、重新打开、撤回见 3.9–3.11；后台动作由 a08-support 写入，商家看到的是“处理结果已提交，请确认问题是否已解决”（提交处理结果）、“工单已关闭：{说明}”（关闭）、“工单已重新打开，客服将继续处理”（人工纠偏重开）、“工单已转给您的服务经理{称呼}跟进”（转给门店交付经理时才对商家可见）。
- 非实时 IM：进入页面与下拉刷新时拉取（proto-merchant-b.md:209）。条目数没有分页，单张工单的条目量有限。
- 状态说明的文案由端上按字段拼：处理中“服务经理小林正在跟进”（`owner`）；待您确认“{autoResolveAt} 前未确认的，将自动变为已解决”；已关闭“您已撤回工单（{withdrawReason.name}）”；重新打开后“客服将在工作时间 30 分钟内响应”（`m.serviceManager.get` 的 `responsePromise`）。

### 3.8 m.serviceTicket.entry.create　补充说明

`POST /m/service-tickets/{serviceTicketId}/entries`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ticket.*` |
| 店员视图 | `none` |
| 幂等 | `required` |
| 乐观锁 | 无（状态守卫） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Ticket、M:TicketDone（重新打开后）底部输入区 |
| 出处 | 路线图 `m08.service-ticket-entry.create`；d3-flow.md:2510、3515（草案 `POST …/messages`）；12-support.md:152、267；proto-merchant-b.md:204-206 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `serviceTicketId` | string(uuid) | 是 | 当前门店的工单 | — |
| 请求体（`ServiceTicketEntryCreateBody`） | `body` | string | 是 | 去掉首尾空白后 1–500 字 | 补充说明 → `service_ticket_entry.body` |
| 请求体 | `imageFileIds` | array<string(uuid)> | 否 | 0–1 个（原型一次 1 张）；分类 `ticket_attachment`、已入库、本人在当前门店上传 | → `service_ticket_entry.image_file_ids` |

**响应**：`data` 为新条目 `ServiceTicketEntryView`（2.7）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 工单不在 `processing`（12-support.md:152 只允许处理中补充说明） |
| `FILE_NOT_USABLE` | 400 | 图片不可用 |
| `NOT_FOUND` | 404 | 工单不存在或不属于当前门店 |
| `ROLE_FORBIDDEN` | 403 | 店员 |
| `VALIDATION_FAILED` | 400 | 正文为空或超长；图片超过 1 张 |

**副作用**：
- 状态不变（`service_ticket.status: processing → processing`，商家补充说明只写条目，不写状态历史，12-support.md:152）。
- 写条目：`kind = merchant_message`、`tag = supplement`、`actor_type = merchant`、`actor_id` = 本人、`client = weapp`、`is_visible_to_merchant = true`；带图时 `files.link()`（`ref_type = service_ticket_entry`，角色 `image`）。
- 出站事件 `service_ticket.supplemented`（载荷 `{ serviceTicketId, entryId, storeId, ownerStaffId? }`）：订阅者 `notify.onEvent` 按 a09-ops 2.9 的场景 `s.kf_supplemented` 提醒工单负责人（接收人 `service_ticket.owner_staff_id`，即载荷的 `ownerStaffId`；原型“已发送，服务经理小林将收到提醒”）。12 分组的事件清单已登记该事件（12-support.md:191，A144）；x01 第 3.12 节已登记，订阅者 `notify.onEvent` 发场景 `s.kf_supplemented`。

**说明**：
- 端上可在点击“发送”的同步调用链里请求订阅点位 `ticket_reply`（d6-notify-docs-data.md:868）。
- 待受理（`pending`）时是否也允许补充说明，数据模型没有这一行，按数据模型拒绝（第 6 节第 1 项）。

### 3.9 m.serviceTicket.confirm　确认已解决

`POST /m/service-tickets/{serviceTicketId}/confirm`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ticket.*` |
| 店员视图 | `none` |
| 幂等 | `required`（状态迁移，A17；路线图原 `natural` 不采用） |
| 乐观锁 | 不带 `lockVersion`（12-support.md:154 的守卫没有列锁版本，C53）；行锁 + 状态守卫 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:TicketDone“确认已解决” |
| 出处 | 路线图 `m08.service-ticket.confirm`；d3-flow.md:2512、3515；12-support.md:154、187；PRD 6.12-5 |

**请求**：路径参数 `serviceTicketId`（string(uuid)，当前门店的工单）。查询参数：无。请求体：无（`{}`）。

**响应**：`data` 为 `ServiceTicketDetail`（2.7）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 工单不是 `awaiting_confirm`（已自动解决、已被重新打开或员工已关闭）；端上刷新详情 |
| `NOT_FOUND` | 404 | 工单不存在或不属于当前门店 |
| `ROLE_FORBIDDEN` | 403 | 店员 |

**副作用**（同一事务）：
- 状态迁移 `service_ticket.status: awaiting_confirm → resolved`（`confirm`，12-support.md:154）：`resolved_at` = 现在、`resolved_via = merchant`、清空 `auto_resolve_at`。
- 写系统事件条目（`kind = system_event`、`tag = status`、`actor_type = merchant`、商家可见；`body` 为后台文案“商家确认问题已解决”，`merchant_body`“您已确认问题已解决，工单已完成”）。
- 图片引用：本工单及其全部条目的图片 `files.release()`，`keep_until` = 迁移时刻 + 3 年（12-support.md:178）。
- 定时器：取消 `service.auto_resolve`（12-support.md:187）。
- `status_transition` 一行（`event = confirm`）与活动流审计（M31）；出站事件 `service_ticket.resolved`。

**说明**：待您确认满 3 个自然日由定时器 `service.auto_resolve` 自动解决（`resolved_via = auto`，12-support.md:155），是非 HTTP 迁移，归 x01-events-jobs 的归属表。原型解决后的“评价服务”是 V1.1（3.12）。

### 3.10 m.serviceTicket.reopen　仍未解决，重新打开

`POST /m/service-tickets/{serviceTicketId}/reopen`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ticket.*` |
| 店员视图 | `none` |
| 幂等 | `required`（状态迁移，A17） |
| 乐观锁 | 不带 `lockVersion`（12-support.md:156 的守卫没有列锁版本）；行锁 + 状态守卫 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:TicketDone“仍未解决”弹层 |
| 出处 | 路线图 `m08.service-ticket.reopen`；d3-flow.md:2514、3515；12-support.md:156、185、187、462；proto-merchant-b.md:218-221；PRD 6.12-5 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `serviceTicketId` | string(uuid) | 是 | 当前门店的工单 | — |
| 请求体（`ServiceTicketReopenBody`） | `note` | string | 是 | 去掉首尾空白后 1–500 字 | 仍未解决的问题 → 重新打开条目的正文 |

**响应**：`data` 为 `ServiceTicketDetail`（2.7）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `TICKET_REOPEN_WINDOW_CLOSED` | 409 | 已解决的工单超过可重新打开的天数，或参数为 0（入口已关闭）；`details = { resolvedAt, windowDays }` |
| `STATE_NOT_ALLOWED` | 409 | 工单不是 `awaiting_confirm` 或 `resolved` |
| `NOT_FOUND` | 404 | 工单不存在或不属于当前门店 |
| `ROLE_FORBIDDEN` | 403 | 店员 |
| `VALIDATION_FAILED` | 400 | 说明为空或超长 |

**副作用**（同一事务）：
- 状态迁移 `service_ticket.status: awaiting_confirm → processing`、`service_ticket.status: resolved → processing`（`reopen`，12-support.md:156）：`reopened_count + 1`；新一轮 `response_due_at` = 现在 + 30 工作分钟与 `sla_snapshot.response`；清空 `auto_resolve_at`、`resolved_at`、`resolved_via`。方案时限不重计（12-support.md:521）。
- 写两条条目：商家消息（`tag = reopen`，正文为 `note`）与系统事件（`tag = status`、商家可见；`body` 为后台文案“商家重新打开工单（第 N 次）”，`merchant_body`“工单已重新打开，客服将尽快处理”）。
- 从已解决重开时，对本工单及其条目的图片再次 `files.link()`（回到 `live`，12-support.md:179）。
- 定时器：从待您确认重开时取消 `service.auto_resolve`；登记新一轮 `service.first_response_due`（轮次取重开后的 `reopened_count`，12-support.md:185；去重键见 x01-events-jobs 4.1）。
- `status_transition` 一行（`event = reopen`，`payload` 带 `round`、`responseDueAt`、`responseSla`，12-support.md:462）与活动流审计；出站事件 `service_ticket.reopened`（提醒负责人）。

**说明**：原型只有“待您确认”能重新打开；数据模型允许已解决后 `service.reopen_window_days` 天内重开（默认 7，0 即关闭此入口，14-config-data.md:310），端上按 `actions` 与 `reopenDeadlineAt` 决定是否显示入口。

### 3.11 m.serviceTicket.withdraw　撤回工单

`POST /m/service-tickets/{serviceTicketId}/withdraw`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `ticket.*` |
| 店员视图 | `none` |
| 幂等 | `required`（状态迁移，A17；路线图原“natural（状态守卫）”不采用） |
| 乐观锁 | 不带 `lockVersion`；行锁 + 状态守卫 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Ticket“撤回工单”弹层 |
| 出处 | 路线图 `m08.service-ticket.withdraw`；d3-flow.md:2515、3515；12-support.md:157、72、185-186；proto-merchant-b.md:207；PRD 6.12-5 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `serviceTicketId` | string(uuid) | 是 | 当前门店的工单 | — |
| 请求体（`ServiceTicketWithdrawBody`） | `reasonCode` | string | 是 | 字典 `ticket_withdraw_reason` 内且启用 | 撤回原因（问题已解决、不再需要、重复提交、其他）→ `service_ticket.withdraw_reason_code` |

**响应**：`data` 为 `ServiceTicketDetail`（2.7）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 工单不是 `pending` 或 `processing`（待您确认时不能撤回，原型同） |
| `DICT_ITEM_DISABLED` | 409 | 原因编码不在字典里或已停用；`details = { dictTypeKey: 'ticket_withdraw_reason', code }` |
| `NOT_FOUND` | 404 | 工单不存在或不属于当前门店 |
| `ROLE_FORBIDDEN` | 403 | 店员 |

**副作用**（同一事务）：
- 状态迁移 `service_ticket.status: pending → closed`、`service_ticket.status: processing → closed`（`withdraw`，12-support.md:157）：`closed_at` = 现在、`close_reason = withdrawn`、`withdraw_reason_code`；清空 `response_due_at`。
- 写系统事件条目（`tag = status`、商家可见；`body` 为后台文案“商家撤回工单，原因：{撤回原因}”，`merchant_body`“您已撤回工单（{撤回原因}），工单已关闭”）。
- 图片引用：本工单及其条目的图片 `files.release()`，`keep_until` = 迁移时刻 + 3 年。
- 定时器：取消本轮 `service.first_response_due` 与 `service.solution_due`（12-support.md:185-186）。
- `status_transition` 一行（`event = withdraw`，`reason_code` = 撤回原因编码）与活动流审计；出站事件 `service_ticket.closed`。

**说明**：撤回后处理记录仍可查看，输入区禁用，端上引导“提交新工单”（原型 Ticket）。

### 3.12 m.serviceTicket.rate　评价服务（V1.1）

`POST /m/service-tickets/{serviceTicketId}/rate`

V1.1，细节待设计。工单解决后评价 1～5 星（PRD 6.12-6；d3-flow.md:3364）；届时 `service_ticket` 加评分列（12-support.md:522），动作词 `rate` 已在 C12 的 V1.1 词表里。原型“评价服务 V1.1”置灰。鉴权暂按 `member` + `ticket.*`、店员 `none`，幂等 `required`。

### 3.13 m.faq.list　常见问题（V1.1）

`GET /m/faqs`

V1.1，细节待设计。按分类展示常见问题（PRD 6.12-6），表结构待定（资源登记表 `faqs`，`table: null`）；V1.0 客服中心显示“常见问题即将开放”。分类可放 `site_config_revision` 的 `faq_categories`（14-config-data.md:344）。鉴权暂按 `member`、店员 `same`。

### 3.14 m.message.list　站内消息

`GET /m/messages`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`（A52：站内消息是账号级的）；`x-capability: assert-in-handler`（C66、A87）：不带 `X-Store-Id` 时只要求登录，只看账号级消息；带 `X-Store-Id` 时处理器校验成员关系（否则 403 `NOT_A_MEMBER`）与能力点 `message.read`（老板、店员、已停用门店老板都有，d4-identity.md:870）。路由不挂能力点中间件，因为没有门店上下文的请求取不到角色 |
| 店员视图 | `same`（A52；收件范围在派发时已按接收人角色决定，见说明） |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Messages（M36）；补充状态“触底加载”“下拉刷新” |
| 出处 | 路线图 `m08.message.list`；d6-notify-docs-data.md:742-762、2239；13-notify-docs.md:484-533；proto-merchant-b.md:451-466；A24、A52 |

**请求**（查询参数 `MessageListQuery`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `tab` | enum(`MessageTab`) | 否 | `all`（默认）/ `order` / `delivery` / `launch` / `plan_points` / `review` / `store` / `service` | 分类页签（路线图 `category=` 改 `tab=`，A24）；“公告”页签 V1.1（3.18） |
| 查询 | `cursor` | string | 否 | 不透明游标 | 按 `merchant_message.id` 倒序 |
| 查询 | `limit` | integer | 否 | 1–50，默认 20 | — |
| 请求头 | `X-Store-Id` | string(uuid) | 否 | 带了就必须有成员关系 | 门店上下文；不带时只看账号级消息 |

**响应**：`data` 为 `MessagePage`，即 `CursorPage<MessageItem>` = `{ items: MessageItem[], nextCursor, hasMore }`（2.8；通用结构，C42、C87）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_A_MEMBER` | 403 | 带了 `X-Store-Id` 但没有成员关系（按 C17 的同一判定） |

**副作用**：无。

**说明**：
- 可见范围（d6-notify-docs-data.md:745-754）：`merchant_message.merchant_user_id` = 本人；且 `entity_id` 等于当前门店所属主体或为空（账号级消息在任何主体下都可见）；且 `store_id` 为空或等于当前门店（参数 `inbox.scope = current_store`，默认；为 `all_stores` 时不按当前门店过滤）；且 `store_id` 为空或在本人仍能进的门店里（老板：主体下全部门店；店员：仍是成员的门店）；且 `is_owner_only = false` 或本人此刻仍是该主体的老板（老板更换后，原老板即使仍是店员也读不到）。没有门店上下文时只看 `entity_id` 为空的账号级消息。走索引 `ix_merchant_message_merchant_user_id_entity_id_id`。
- 店员收到的只有门店（成员变动、素材反馈）与客服两类，这是派发时由场景的 `recipients()` 决定的，金额、积分类消息从未写进店员的收件箱，文案也按角色渲染（d6-notify-docs-data.md:756）；因此读取不裁剪、不另设店员 schema（A52、C56）。
- 消息是否随门店切换过滤（原型切换门店后角标变化）默认按 `inbox.scope = current_store` 实现，PRD 未定义，列为待确认（第 6 节第 2 项）。

### 3.15 m.message.summary　未读计数

`GET /m/messages/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`；`assert-in-handler`（判定同 3.14） |
| 店员视图 | `same`（A52） |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Messages（页签未读数）、M:Mine（消息中心角标）、M:Main（未读角标）、M:StoreSwitch（各店角标） |
| 出处 | 路线图 `m08.message.unread-counts`；d6-notify-docs-data.md:760、2239；13-notify-docs.md:520；A23；C83（`/m/messages/unread-counts` 改 `/m/messages/summary`） |

**请求**：查询参数无（页签计数接口不接受 `tab` 与分页参数，C83）。请求头 `X-Store-Id` 同 3.14。

**响应**：`data` 为 `MessageSummary`（2.8）。

**错误**：`NOT_A_MEMBER`（同 3.14）。

**副作用**：无。

**说明**：计数走部分索引 `ix_merchant_message_unread`（13-notify-docs.md:520）。

### 3.16 m.message.batchRead　全部已读

`POST /m/messages/read`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`；`assert-in-handler`（判定同 3.14） |
| 店员视图 | `same` |
| 幂等 | `required`（路线图原“天然幂等”按 A17 取消） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Messages“全部已读” |
| 出处 | 路线图 `m08.message.read-all`；d6-notify-docs-data.md:761、2240；13-notify-docs.md:486；A9（词表 `read`）；C12、C14（集合动作加 `batch` 前缀） |

**请求**：请求体 `MessageBatchReadBody`：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `upToMessageId` | string(uuid) | 是 | — | 只标记 `id <= upToMessageId` 的消息（取当前列表最上面一条的 id），避免把用户还没看到的新消息一并标已读 |
| `tab` | enum(`MessageTab`) | 否 | 同 3.14，默认 `all` | 只标记该页签的消息 |

请求头 `X-Store-Id` 同 3.14。

**响应**：`data` 为 `MessageBatchReadResult`，即 `{ markedCount: integer, summary: MessageSummary }`：本次标记的条数与标记后的计数（端上直接刷新角标）。

**错误**：`NOT_A_MEMBER`（同 3.14）；`VALIDATION_FAILED`。

**副作用**：对 3.14 可见范围内、`read_at` 为空、`id <= upToMessageId`（且分类符合）的 `merchant_message` 写 `read_at` = 现在、`updated_at` = 现在。没有状态迁移、出站事件与审计。

**说明**：字面段 `/m/messages/read` 先于 `/m/messages/{messageId}` 注册（A8）。

### 3.17 m.message.read　标记单条已读

`POST /m/messages/{messageId}/read`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`；`assert-in-handler`（判定同 3.14） |
| 店员视图 | `same` |
| 幂等 | `required` |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Messages（点击消息跳转时） |
| 出处 | 路线图 `m08.message.read`；d6-notify-docs-data.md:761、2240 |

**请求**：路径参数 `messageId`（string(uuid)）；请求体无。请求头 `X-Store-Id` 同 3.14。

**响应**：`data` 为 `MessageReadResult`，即 `{ messageId, readAt }`（`readAt` 为 string(date-time)）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 消息不存在或不在 3.14 的可见范围内 |

**副作用**：`read_at` 为空时写 `read_at`、`updated_at`（`WHERE read_at IS NULL`）；已读的不改，返回原值。

**说明**：端上点击消息先按 `link` 跳转、同时调本接口，不等返回。

### 3.18 m.siteNotice.list　公告页签（V1.1）

`GET /m/site-notices`

V1.1，细节待设计。消息中心“公告”页签（系统通知、活动、规则变更，PRD 6.13；13-notify-docs.md:496）。V1.0 的规则变更公告只以首页公告条随 `m.home.get`（m04-mall-order）返回，并以站内消息 `m.rule_change_notice` 送达老板（14-config-data.md:472、537）；人工公告（`site_notice.kind = ops`）V1.1 启用（14-config-data.md:1260）。鉴权暂按 `member`、店员 `same`。

### 3.19 m.notifySetting.list　通知设置

`GET /m/notify-settings`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`；无能力点 |
| 店员视图 | `same` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | `notify.wx.enabled` 关闭时全部槽位返回 `unavailable`（不报错） |
| 对应画板 | 原型无（05-risks-and-open-issues.md:271 列为待补原型；d6-notify-docs-data.md:2458 第 32 项建议放在“我的 › 设置”） |
| 出处 | 路线图 `m08.notify-setting.list`；d6-notify-docs-data.md:813-848、873、2458；13-notify-docs.md:88-256、571-611 |

**请求**：路径参数、查询参数、请求体：无。请求头 `X-Store-Id` 可选：带且有成员关系时按该主体的购买入口模式裁剪槽位（同 3.1 的规则：`hidden` 模式不列 `svc_expiry`、`quota_change` 两个槽位）。

**响应**：`data` 为 `NotifySettings`（2.9）。

**错误**：无业务错误。

**副作用**：无。

**说明**：
- 额度属于点了“允许”的那个微信身份（13-notify-docs.md:577），本接口按本次会话的 `user_session.wechat_identity_id` 取行；同一账号在别的微信上的授权不在这里显示。
- 页面每一行的“开启”按钮在点击回调里同步调 `wx.requestSubscribeMessage`（只请求这一个模板），结果经 `m.subscribeResult.create` 上报（点位 `notify_settings`）；`rejected` 状态端上引导用户到微信“设置 › 通知”里重新打开，小程序内无法代开。
- 估计值只用来避免“明显没额度还去调一次接口”，上线默认上限为 1（参数 `notify.wx.quota_cap`，d6-notify-docs-data.md:812-818）。

### 3.20 m.subscribeResult.create　订阅授权结果上报

`POST /m/subscribe-results`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `user`；无能力点 |
| 店员视图 | `same` |
| 幂等 | `required`：`Idempotency-Key` 取 `subscribeReport:<reportId>`，重复上报由通用幂等记录挡住（d6-notify-docs-data.md:822） |
| 乐观锁 | 无 |
| 限流 | `m.subscribe`（每用户 30 次 / 日，C68；同时受 `m.global` 约束） |
| 开关 | `notify.wx.enabled` 关闭时照常受理、只记日志（端上此时本就不会请求授权） |
| 对应画板 | M:ProfileCert、M:Checkout、M:Plan、M:Sample、M:Ads、M:AdDetail、M:Publish、M:PlanPick、M:TopUp、M:Service、M:Ticket、M:Invoices、M:Invite、M:Join、M:AssetUpload、M:StoreAdd、M:Wallet；原型无的“通知设置” |
| 出处 | 路线图 `m08.subscribe-result.create`；d6-notify-docs-data.md:808-829、852-885、2241；d7-platform.md:747-749；13-notify-docs.md:571-611 |

**请求**：请求体 `SubscribeResultBody`：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `reportId` | string(uuid) | 是 | 端上每次授权调用生成一个 | 与幂等键对应 |
| `point` | enum(`SubscribePoint`) | 是 | 第 4 节取值 | 授权引导点位（d6-notify-docs-data.md:856-873） |
| `results` | array<object> | 是 | 1–5 项 | 每项 `{ tmplId: string（1–64 字符）, result: enum(accept / reject / ban / filter) }`，即 `wx.requestSubscribeMessage` 回调里的逐模板结果 |

**响应**：`data` 为 `SubscribeResultOutcome`，即 `{ appliedCount: integer, ignoredCount: integer }`：改动了额度行的项数与被忽略的项数（模板 id 对不上任何槽位、或 `reject`）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 点位不认识、结果项数不对 |
| `RATE_LIMITED` | 429 | 超过 `m.subscribe` 档位（同一用户当日超过 30 次）；端上丢弃本次上报 |

**副作用**（逐项，d6-notify-docs-data.md:821-829；额度行的主键是本次会话的 `user_session.wechat_identity_id` 与模板 id 对应的 `wx_template_slot.slot_key`）：
- `accept`：插入或更新 `wx_subscribe_quota`：`est_remaining = LEAST(est_remaining + 1, notify.wx.quota_cap)`、`state = ok`、`last_accept_at` = 现在；新行的 `merchant_user_id` 取本人。
- `ban`：`state = banned`、`est_remaining = 0`，并经 `alerts.raise` 告警（模板被封）。
- `filter`：不改表，经 `alerts.raise` 告警（多为标题重复或模板已删除）。
- `reject`：不改表（冷却在端上）。
- 每项写一行结构化日志（`evt = subscribe_report`），不落表；没有出站事件与审计。

**说明**：
- 授权只能在点击回调里同步发起（d7-platform.md:747），点位与槽位取引导接口的 `subscribePlan`（2.2）。客户端伪造 `accept` 没有收益：下一次发送拿到“无额度”即清零（d6-notify-docs-data.md:848）。
- `wx_subscribe_quota` 不单列资源（资源登记表 `subscribe-results`）。

### 3.21 m.file.create　上传登记

`POST /m/files`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；`x-capability: assert-in-handler`（C66、A87）：处理器按请求体的 `category` 调 `authorizeUpload`（d5-media.md:1017），判定规则见说明的分类表，不满足时 403 `ROLE_FORBIDDEN`（店员素材闸门为 409 `ASSET_UPLOAD_GATED`）；与后台 `admin.file.create` 的 `permission: assert-in-handler` 对应 |
| 店员视图 | `same`（店员可上传门店素材与肖像授权材料，C56） |
| 幂等 | `natural`：按 `clientToken` 复用未完成的登记以便续传，`x-idempotent-by` = `uq_file_object_client_token_store`（门店级分类）、`uq_file_object_client_token_noscope`（主体级分类，`store_id` 为空）（06-media.md:173-175；C47、A49） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileBasic、M:ProfileStore、M:ProfileService、M:ProfileCert、M:ProfileReview、M:AssetUpload、M:AdDetail、M:Accounts、M:Service、M:Ticket、M:TicketDone、M:PlanPick、M:TopUp、M:Sample；补充状态“上传中”“上传失败” |
| 出处 | 路线图 `m08.upload.create`；d5-media.md:961-1026、1102-1137、2087；06-media.md:83-202、1580-1615；d7-platform.md:758-765；A5、A35；C59 |

**请求**：请求体 `MerchantFileCreateBody`（一次多个文件；与 a01-system 的后台单文件 `FileCreateBody` 不是同一结构）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `category` | enum(`MerchantUploadCategory`) | 是 | 第 4 节取值 | 文件分类 → `file_object.category`；一次登记的文件同一分类 |
| `licenseKind` | enum | 条件 | `category = kyc_license` 时必填：`business_license` 营业执照 / `branch_license` 分支机构执照；其余分类不得传 | 决定归属范围：营业执照属主体，分支机构执照属门店（06-media.md:1584；04 分组 `qualification_doc.scope`）；与 m03-profile-asset 的证照类型一致 |
| `files` | array<`FileCreateItem`> | 是 | 1–9 个 | 本次登记的文件 |

`FileCreateItem`：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `fileName` | string | 是 | 1–200 字符，必须带扩展名 | 原始文件名 → `file_object.original_name`；扩展名（小写）→ `file_object.ext`，规范 MIME 由扩展名推出 → `file_object.declared_mime`（客户端声明的 MIME 不被信任，d5-media.md:969） |
| `sizeBytes` | string(bigint) | 是 | ≥1，不超过“分类 × 端”的上限 | 声明的字节数 → `file_object.declared_size` |
| `clientToken` | string | 是 | 1–64 字符，`[A-Za-z0-9_-]` | 续传标识（端上按 d5-media.md:1137 的算法生成）→ `file_object.client_token` |

**响应**：`data` 为 `FileRegistrationList`，即 `{ items: FileRegistration[] }`（2.10），顺序同请求。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `ROLE_FORBIDDEN` | 403 | 本角色不能上传该分类（如店员上传证照、回单、工单图片） |
| `ASSET_UPLOAD_GATED` | 409 | 店员在门店资质审核通过前上传门店素材（46002，m03-profile-asset 定义；与 m03 3.22 素材建档同一道闸门，判定经 `StoreGatePort`） |
| `STORE_ARCHIVED` | 403 | 已停用门店上传收尾范围以外的分类（m02-tenant 定义） |
| `FILE_TYPE_NOT_ALLOWED` | 400 | 扩展名不在该分类的白名单内；`details = { allowedExts: string[] }` |
| `FILE_TOO_LARGE` | 400 | 声明大小超过上限；`details = { maxBytes: string, canDelegate: boolean }`。小程序内视频超限时 `canDelegate = true`，`message` 为统一的引导：“视频较大，请发给服务经理代传”（A35） |
| `UPLOAD_CREDENTIAL_LIMIT` | 409 | 复用已有登记时，该文件的临时密钥已签发 30 次 |
| `PROVIDER_UNAVAILABLE` | 503 | `multipart` 通道签发临时密钥失败（STS 不可用；`post` 通道不受影响，d5-media.md:1095） |
| `VALIDATION_FAILED` | 400 | 文件数不对；缺扩展名；`licenseKind` 缺失或多传；同一 `clientToken` 已被一个声明大小不同的未完成登记占用（`fieldErrors.path = files.N.clientToken`） |

**副作用**：
- 每个文件插入一行 `file_object`：`file_object.status: （新建）→ pending`（登记，06-media.md:188）。写 `bucket`、`object_key`（正式区，登记时即确定）、`incoming_bucket`、`incoming_key`、`category`、`scope_type`、`entity_id`、`store_id`（门店级分类取 `X-Store-Id`，主体级分类只写主体）、`upload_actor_type = merchant`、`upload_actor_id` = 本人、`upload_client = weapp`、`upload_mode`、`client_token`、`declared_size`、`declared_mime`、`ext`、`original_name`、`upload_expires_at` = 现在 + 24 小时；`multipart` 时 `sts_issued = 1`。
- 复用：同一上传人、分类、归属门店（主体级为空）下 `status = pending` 且 `clientToken` 相同、声明大小相同的行直接复用（同一个写入区 key，分块续传才成立，d5-media.md:1019），重新签发凭证（`multipart` 时 `sts_issued + 1`）。分类或归属不同就是另一次上传。
- 没有出站事件与审计。`file.uploaded` 在确认且对象相符（`pending → promoting`）时发出（3.23，依据 d5-media.md:1038）。x01 事件目录已按确认时发登记（A141）。

**说明**：
- 商家端可登记的分类与判权（d5-media.md:263-290 的“上传方”一栏；d4-identity.md:855-871 的能力点）：

| 分类 | 用途 | 老板 | 店员 | 已停用门店老板 | 归属范围 |
| --- | --- | --- | --- | --- | --- |
| `profile_image`、`profile_video`、`profile_promo` | 档案图片、实拍视频、已有宣传素材 | ✔（`store.profile.edit`） | ✘ | ✘ | 门店 |
| `kyc_license` | 营业执照、分支机构执照 | ✔（`store.qualification.edit`） | ✘ | ✘ | 营业执照为主体，分支机构执照为门店 |
| `kyc_permit` | 行业许可证 | ✔（`store.qualification.edit`） | ✘ | ✘ | 门店 |
| `store_asset` | 门店素材 | ✔（`asset.upload`） | ✔（`asset.upload`；资质通过前的新门店受闸门限制，返回 `ASSET_UPLOAD_GATED`） | ✘ | 门店 |
| `portrait_auth` | 素材出镜人的肖像授权材料 | ✔（`asset.upload`） | ✔（`asset.upload`；登记时不知道是哪条素材，“只许老板或该素材的上传人”由 m03 的肖像授权补交接口判定） | ✘ | 门店 |
| `channel_screenshot` | 渠道账号主页截图 | ✔（`channel.manage`） | ✘ | ✘ | 门店 |
| `ticket_attachment` | 工单图片、样片与广告的修改意见截图 | ✔（`ticket.*`、`delivery.confirm_sample`、`ad.confirm` 任一） | ✘ | ✔（工单） | 门店 |
| `pay_receipt` | 对公转账回单 | ✔（`plan.purchase` 或 `points.topup`） | ✘ | ✔ | 主体 |

- 上限与通道（d5-media.md:961-967、1116-1129）：图片 5MB；PDF 回单 10MB；文档 20MB；音频 50MB；视频取参数 `upload.weapp_video_max_mb`（真机验证前 100，设计规范第 11 节）；建档视频取 min(200MB, 视频上限)。≤20MB 走 `post`，其余走 `multipart`；存储驱动不支持 STS 时一律 `post`。
- 受平台约束（A35；设计规范第 11 节）：小程序内超限时端上依次尝试压缩，仍超限时本接口返回 `FILE_TOO_LARGE`（`canDelegate = true`），端上提示由服务经理在后台代传，并提供“添加服务经理企业微信”入口：数据取 `m.serviceManager.get` 的 `wecomQr`（或企业微信“添加联系人”组件），名片为空时显示在线客服入口。d5-media.md:1114 写的“复制服务经理企业微信”没有数据来源（`staff.wecom_userid` 是企业内部 id，商家拿它加不了好友），不采用；电脑端上传是 V1.1。
- 一次登记多个文件时逐个判定，任一文件不合格整批失败（不部分成功），`fieldErrors` 或 `details` 指明是哪一个。
- 证照的登记范围与 m03-profile-asset 3.12 的校验一致：`licenseKind = business_license` 登记为主体级（`store_id` 为空），`branch_license` 与 `kyc_permit` 登记为本门店级。登记时选错范围本接口不拦（登记时不知道将用于哪张证照），提交证照时范围不符由 m03 返回 `FILE_NOT_USABLE`（`details.reason = scope_mismatch`），端上按新范围重新登记。

### 3.22 m.file.get　查询入库状态

`GET /m/files/{fileId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；上传人本人（门店级文件还须属于当前门店，主体级文件须属于当前门店所属主体） |
| 店员视图 | `same` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | 补充状态“上传中”；无画板：上传工具 |
| 出处 | 路线图 `m08.upload.get`；d5-media.md:1003、2090；C59 |

**请求**：路径参数 `fileId`（string(uuid)）。

**响应**：`data` 为 `FileStatusView`（2.10）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 文件不存在、不是本人上传、或不在当前门店（主体）范围 |

**副作用**：无。

**说明**：确认返回 `promoting` 后，端上 1 秒一次轮询，直到 `stored` 或 `rejected`（C59）。入库后的内容安全审核是异步的，`moderationState = block` 的文件被业务接口拒收（`FILE_NOT_USABLE`）。

### 3.23 m.file.complete　上传确认

`POST /m/files/{fileId}/complete`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；上传人本人 |
| 店员视图 | `same` |
| 幂等 | `required`（状态迁移，A17；路线图原“natural（条件更新）”不采用）；C51 登记的多事务三段式用例（A84，`x-three-phase`），见说明 |
| 乐观锁 | 不带 `lockVersion`；条件更新（`confirming_until` 标记） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:AssetUpload、M:ProfileStore、M:ProfileCert；补充状态“上传中”“上传失败” |
| 出处 | 路线图 `m08.upload.complete`；d5-media.md:995-1011、1030-1040、2089；06-media.md:191-192；C24、C59 |

**请求**：路径参数 `fileId`（string(uuid)）；请求体无。

**响应**：`data` 为 `FileStatusView`（2.10），`status` 为 `promoting` 或 `stored`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `CONFIRM_IN_PROGRESS` | 409 | 另一个确认请求正在处理（标记未过期）；可重试，端上 1 秒后用同一幂等键重试 |
| `UPLOAD_NOT_FOUND` | 409 | 写入区没有对象（还没传完或传失败）；端上补传后用同一幂等键再确认 |
| `UPLOAD_REJECTED` | 400 | 大小与登记值不符、超过上限或文件头与扩展名不符，文件已被拒收；`details = { rejectReason }`。端上提示“上传失败”，需重新登记 |
| `UPLOAD_EXPIRED` | 409 | 登记已过期或已取消（`expired`）；需重新登记 |
| `NOT_FOUND` | 404 | 文件不存在或不是本人上传 |

**副作用**（三段执行，任何一段都不持数据库锁调用对象存储，d5-media.md:1030-1040）：
- 事务一：打“确认中”标记（`confirming_until` = 现在 + 30 秒），命中 0 行时读当前行：已是 `promoting` / `stored` 直接返回当前状态；`pending` 且标记未过期返回 `CONFIRM_IN_PROGRESS`。
- 事务外：`HEAD` 写入区对象并读前 4KB 核对文件头。
- 事务二（条件 `confirming_until` 与事务一写入的值相符）：对象不存在 → 清空标记，返回 `UPLOAD_NOT_FOUND`。不符 → `file_object.status: pending → rejected`（确认但不符，06-media.md:192），写 `reject_reason`，出站事件 `file.rejected`，返回 `UPLOAD_REJECTED`。相符 → `file_object.status: pending → promoting`（确认且对象相符，06-media.md:191），记 `incoming_etag`、`incoming_crc64`，同事务插入 `media_job`（`kind = promote`，去重键 `promote:{fileId}`）与出站事件 `file.uploaded`（在这里发而不是登记时发，d5-media.md:1038），并写幂等记录。
- 提交后尽力唤醒队列；声明大小 ≤32MB 时每 200 毫秒查一次本行，最多 3 秒，返回当前状态。入库（`promoting → stored`）由 worker 的 `promote` 任务完成，是非 HTTP 迁移（x01-events-jobs）。

**说明**：
- 幂等记录随事务二写入，记的是 `promoting` 时的结果；本次请求在等待后可能返回较新的 `stored`，同键重放返回记录里的结果，端上照常按 `status` 轮询 3.22。拒收虽返回 400，但 `rejected` 状态已随事务二提交（这是技术状态，不随业务失败回滚），同键重放读到当前行仍返回 `UPLOAD_REJECTED`。本接口与后台 `admin.file.complete` 都是 C51 登记的“多事务”形态（A84）。
- 被移出门店的店员即使还持有临时密钥，确认也会因成员关系失效被拒（403 `NOT_A_MEMBER`，d5-media.md:1096）。

### 3.24 m.file.refreshCredentials　续签上传凭证

`POST /m/files/{fileId}/refresh-credentials`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；上传人本人 |
| 店员视图 | `same` |
| 幂等 | none：签发上传凭证，结果不进幂等记录，避免回放已过期的凭证（C47、C59） |
| 乐观锁 | 无（条件更新 `sts_issued < 30`） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:AssetUpload、M:ProfileStore；补充状态“上传中” |
| 出处 | 路线图 `m08.upload.refresh-credentials`；d5-media.md:1028、1135、2088；06-media.md:190；C59（草案 `…/sts` 并入） |

**请求**：路径参数 `fileId`（string(uuid)）；请求体无。

**响应**：`data` 为 `FileRegistration`（2.10，与登记的响应、与后台 `admin.file.refreshCredentials` 的响应同一个 schema，C59）：按登记时的通道重新签发（`post` 重签表单，`multipart` 签发新的临时密钥），`expiresAt` 为新凭证的过期时刻，`credentialsLeft` 为签发后还能续签的次数。初稿的 `FileCredentialRenewal`（字段 `renewalsLeft`）不再使用。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `UPLOAD_EXPIRED` | 409 | 登记已过期（`upload_expires_at` 已过）或已取消 |
| `UPLOAD_CREDENTIAL_LIMIT` | 409 | 临时密钥已签发 30 次 |
| `STATE_NOT_ALLOWED` | 409 | 文件已确认（`promoting` 及之后） |
| `PROVIDER_UNAVAILABLE` | 503 | STS 不可用 |
| `NOT_FOUND` | 404 | 文件不存在或不是本人上传 |

**副作用**：`multipart`：`file_object.status: pending → pending`（续签临时密钥，06-media.md:190），`sts_issued + 1`。`post`：不写库。

**说明**：SDK 的 `getAuthorization` 回调调本接口（d5-media.md:1135）。“pending → pending”是数据模型状态机的一行，但按 C47 归入签发凭证一类，幂等 `none`。

### 3.25 m.file.cancel　取消上传

`POST /m/files/{fileId}/cancel`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；上传人本人 |
| 店员视图 | `same` |
| 幂等 | `required`（状态迁移，A17；路线图原“天然幂等”取消） |
| 乐观锁 | 无（条件更新 `status = pending`） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | 补充状态“上传失败”；M:ProfileStore、M:AssetUpload（移除未传完的格子） |
| 出处 | 路线图 `m08.upload.cancel`；d5-media.md:2091；06-media.md:193；A7（`DELETE /m/uploads/{fileId}` 改 `POST …/cancel`） |

**请求**：路径参数 `fileId`（string(uuid)）；请求体无。

**响应**：`data` 为 `FileStatusView`（2.10），`status = expired`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 文件已确认（`promoting`、`stored` 或 `rejected`）；已入库但未被引用的文件由清扫处理，不需要取消 |
| `NOT_FOUND` | 404 | 文件不存在或不是本人上传 |

**副作用**：`file_object.status: pending → expired`（客户端取消，06-media.md:193），清空 `incoming_key`；提交后尽力中止该写入区前缀下的分块上传并删除对象（失败由每 10 分钟的清扫与桶生命周期兜底，d5-media.md:1067）。已是 `expired` 时不改库，直接返回当前状态。没有出站事件与审计。

### 3.26 m.analyticsEvent.batchCreate　埋点批量上报

`POST /m/analytics-events`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `optional`（游客也报）；无能力点 |
| 店员视图 | `same` |
| 幂等 | none：埋点，事件按 `event_id` 在 `analytics_event_dedup` 去重，不经幂等记录（A18、C47） |
| 乐观锁 | 无 |
| 限流 | `m.analytics`（匿名每 IP 60 次 / 分且 300 次 / 日；登录用户每用户 120 次 / 分，C68；同时受 `m.global` 约束） |
| 开关 | `analytics.ingest.enabled` 关闭时返回 403 `FEATURE_DISABLED`（C70），端上丢弃该批并停止上报 |
| 版本门槛与协议同意 | 不受最低版本门槛拦截（A39、C71）；在协议同意白名单内（A85、C73），有待同意协议的登录用户照常上报 |
| 对应画板 | M:Main、M:Mall、M:Detail、M:StoreSwitch、M:ProfileBasic、M:Search（M:Trailer V1.0 不做） |
| 出处 | 路线图 `m08.analytics-event.batch`；d6-notify-docs-data.md:1971-2000、2247；d7-platform.md:853-868；14-config-data.md:682-834；C14（集合写动作 `batch` 前缀） |

**请求**：请求体 `AnalyticsEventBatch`（2.11），≤64KB，按事件 schema 严格校验（C38 的例外：多带字段即拒）。

**响应**：`data` 为 `AnalyticsIngestResult`（2.11）。端上收到 200 后把这批事件全部移出本地队列（被拒绝的也移出），只有网络失败或 5xx 才重试（d7-platform.md:863-867）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 批次头不合 schema、事件数不在 1–50；单条事件不合格不报错，计入 `rejected` |
| `FEATURE_DISABLED` | 403 | 开关 `analytics.ingest.enabled` 关闭 |
| `RATE_LIMITED` | 429 | 超过 `m.analytics` 档位；端上丢弃该批 |

请求体超过 64KB 由网关直接返回 413（C23）。

**副作用**（d6-notify-docs-data.md:1982-1998）：
- 逐条校验：不合 `ClientEventName` 与该事件的 props schema、不在端上事件清单（防冒充 `plan_purchase` 等服务端事件，d7-platform.md:853）、校正后早于 7 天的，计入 `rejected`。发生时刻 = `occurredAt` + （服务器时刻 − `sentAt`），晚于当前时刻的截到当前。
- 可信字段由服务端填：会话的商家用户与角色、事件 `storeId`（或请求头 `X-Store-Id`）经成员关系校验后的门店与主体（不合法则置空）、按门店档案填城市与品类编码（`analytics_event.city_code`、`analytics_event.category_code`）；`source = client`、`actor_type = merchant`、`client = weapp`。
- 同一事务：`INSERT INTO analytics_event_dedup … ON CONFLICT DO NOTHING RETURNING event_id`，只把新出现的事件插进 `analytics_event`（按 `occurred_at` 分区）。
- 已登录时把本机 `anonymousId` 关联到本人：`INSERT INTO analytics_identity … ON CONFLICT DO NOTHING`（一个匿名标识只关联一次，14-config-data.md:808）。
- 匿名事件当日全站总数超过参数 `analytics.anon.daily_cap`（默认 200,000）时匿名事件直接丢弃，计入 `dropped` 并告警（d6 写的 204 按 C24 改为 200）。
- 没有出站事件与审计。

**说明**：端上只报 `app_launch`、`profile_step_save`、`store_switch`、`mall_view`、`trailer_play`、`drama_detail_view`、`share_click` 与扩展事件 `banner_click`、`playback_fallback`、`trailer_first_frame`（d7-platform.md:855），各自的属性 schema 见 2.11；其余 19 个由服务端从出站事件派生或用例直记。属性里不放手机号、证照号，字符串属性只能是枚举、uuid 或字典编码格式。草案写作 `POST /m/events/batch`；草案的整数毫秒时刻按 C34 改为 ISO 字符串。

### 3.27 m.clientError.create　前端错误上报

`POST /m/client-errors`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `optional`（C2；路线图原 `public` 改，登录用户按用户限流）；无能力点 |
| 店员视图 | `same` |
| 幂等 | none：错误上报（A18、C47） |
| 乐观锁 | 无 |
| 限流 | `telemetry`（登录用户 30 条 / 分；匿名每 IP 10 条 / 分，C68） |
| 开关 | 无 |
| 版本门槛与协议同意 | 不受最低版本门槛拦截（C71）；在协议同意白名单内（A85、C73） |
| 对应画板 | 无画板：全局错误上报 |
| 出处 | 路线图 `m08.client-error.create`；d7-platform.md:869-893、1914；d4-identity.md:379；C10、C24、C68 |

**请求**：请求体 `SentryEnvelope` 是 Sentry 信封原文（`Content-Type: application/x-sentry-envelope`），≤200KB；信封头里的 DSN 必须属于登记的项目白名单。端上 `beforeSend` 已去掉请求体、令牌与形如手机号、统一社会信用代码的字符串（d7-platform.md:895）。

**响应**：HTTP 202，`data = null`（C24：只表示已收下，不等上游）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 不是合法的信封，或项目不在白名单 |
| `RATE_LIMITED` | 429 | 超过 `telemetry` 档位 |

超过 200KB 由网关返回 413。

**副作用**：不落业务表。信封进进程内有界队列（200 条，满了丢最新的并计数），后台循环转发到上游（超时 2 秒、失败即丢、10 秒内失败 ≥5 次熔断 60 秒）；上游未配置时只写一条结构化日志（d7-platform.md:883-893）。

**说明**：资源名 `client-errors` 三端统一（C10）：后台 `admin.clientError.create`、下载页 `portal.clientError.create` 与本接口同形态（Sentry 信封、202、≤200KB、`telemetry` 档位，p01-portal 的确认）；草案 d7 写作 `POST /m/telemetry/envelope`，d4 另列 `POST /m/client-logs`，合并为一条。

## 4. 枚举

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `ServiceTicketStatus` | `pending` / `processing` / `awaiting_confirm` / `resolved` / `closed` | 同数据模型 `service_ticket.status`（商家端称“待受理 / 处理中 / 待您确认 / 已解决 / 已关闭”）；与 m06-ad 同名枚举一致 |
| `ServiceTicketSource`（`ServiceTicketDetail.source`） | `weapp` / `online_chat` / `phone` | 同数据模型 `service_ticket.source` |
| `closeReason` | `duplicate` / `invalid` / `withdrawn` | 同数据模型 `service_ticket.close_reason` |
| `resolvedVia` | `merchant` / `auto` | 同数据模型 `service_ticket.resolved_via` |
| `ServiceTicketEntryView.kind` | `merchant_message` / `staff_reply` / `system_event` | 同数据模型 `service_ticket_entry.kind` 去掉 `internal_note`（从不下发） |
| `ServiceTicketEntryView.tag` | `submit` / `supplement` / `reopen` / `reply` / `solution` / `result` / `transfer` / `status` / `biz_event` | 同数据模型 `service_ticket_entry.tag` |
| `EntrySenderKind` | `me` / `merchant` / `staff` / `system` | 本文定义：本人、本主体其他商家用户、平台员工、系统；系统事件条目恒为 `system`（2.7） |
| `StaffRoleKind` | `service_manager` / `customer_service` / `platform` | 本文定义：由 `staff.staff_role_key` 映射的对商家称呼（`delivery_manager` → 服务经理、`cs` → 客服、其余 → 平台） |
| `ServiceTicketAction` | `withdraw` / `confirm` / `reopen` | 本文定义（C16；词取 C12）；V1.1 加 `rate` |
| `TicketProgressStep.step` | `submitted` / `processing` / `awaiting_confirm` / `resolved` | 本文定义：四步进度条 |
| `TicketProgressStep.state` | `done` / `current` / `todo` | 本文定义 |
| `PhoneSource` | `login` / `store_contact` / `input` | A25、C40 |
| `MessageCategory` | `order` / `delivery` / `launch` / `plan_points` / `review` / `store` / `service` / `system` | 同数据模型 `merchant_message.category`（`system` V1.0 只声明，不会出现） |
| `MessageTab` | `all` / `order` / `delivery` / `launch` / `plan_points` / `review` / `store` / `service` | 本文定义：`all` 加 `MessageCategory` 中 V1.0 有页签的取值 |
| `NotifySlotState` | `on` / `off` / `rejected` / `banned` / `unavailable` | 本文定义（由 `wx_template_slot.status` 与 `wx_subscribe_quota.state`、`est_remaining` 派生） |
| `SubscribePoint` | `profile_submit` / `pay_success` / `transfer_submit` / `order_submit` / `plan_confirm` / `ad_submit` / `ad_confirm` / `sample_confirm` / `package_download` / `link_submit` / `offline_confirm` / `ticket_submit` / `ticket_reply` / `invoice_apply` / `renew_enter` / `member_invite` / `member_join` / `asset_upload` / `notify_settings` | d6-notify-docs-data.md:856-873 的授权引导点位（请求枚举；新增取值不算破坏） |
| `SubscribeResultKind` | `accept` / `reject` / `ban` / `filter` | `wx.requestSubscribeMessage` 回调的逐模板结果 |
| `BootstrapBlock` | `flags` / `versions` / `consents` / `subscribe` / `copy` / `notice` / `context` | 本文定义（d7-platform.md:486 的 `degraded` 扩充） |
| `SupportMode` | `wecom_kf` / `contact` | d7-platform.md:483 |
| `WeappSaveMode` | `temp` / `user_dir` | d7-platform.md:480 |
| `MerchantUploadCategory` | `profile_image` / `profile_video` / `profile_promo` / `kyc_license` / `kyc_permit` / `store_asset` / `portrait_auth` / `channel_screenshot` / `ticket_attachment` / `pay_receipt` | 数据模型 `file_object.category` 的子集（商家端可上传的分类，3.21） |
| `LicenseKind` | `business_license` / `branch_license` | 同数据模型 `qualification_doc.doc_type` 的子集 |
| `FileStatus` | `pending` / `promoting` / `stored` / `rejected` / `expired` / `deleting` / `deleted` | 同数据模型 `file_object.status` |
| `FileRejectReason` | `size_mismatch` / `bad_magic` / `changed_after_confirm` / `copy_verify_failed` / `stamp_failed` | 同数据模型 `file_object.reject_reason` |
| `UploadMode` | `post` / `multipart` | 同数据模型 `file_object.upload_mode` 去掉 `server`（系统写入） |
| `ModerationState` | `none` / `pending` / `pass` / `review` / `block` | 同数据模型 `file_object.moderation_state` |
| `ClientEventName` | `app_launch` / `profile_step_save` / `store_switch` / `mall_view` / `trailer_play` / `drama_detail_view` / `share_click` / `banner_click` / `playback_fallback` / `trailer_first_frame` | 端上事件清单（d6-notify-docs-data.md:1831-1860；d7-platform.md:855），取值是 `analytics_event.name` 的子集 |
| `ClientPlatform` | `ios` / `android` / `harmony` / `windows` / `mac` / `devtools` | 同请求头 `X-Client-Platform`（C17） |
| `NetworkType` | `wifi` / `5g` / `4g` / `3g` / `2g` / `none` / `unknown` | 本文定义：`wx.getNetworkType` 的取值，用于埋点属性（2.11） |
| `ChannelAccountAttention.abnormalSource` | `verify` / `manual` | 同数据模型 `channel_account.abnormal_source` |
| `SubscriptionStatus` | `none` / `active` / `expired` | 同数据模型 `billing_account.sub_status`（与 m07-billing 同名枚举一致） |
| `viewerRole` | `owner` / `clerk` | C55 判别字段 |

响应里的状态、分类、类型类枚举都标 `x-open-enum`（C37）。

## 5. 错误码

本文新定义的领域错误码。客服段取 45500–45599，消息与其他段取 47000–47099（A70）。上传类 7 个码（47051–47057）与 `DICT_ITEM_DISABLED` 是共用领域码，归属本文（A77、C28 的归属表）：m03-profile-asset、a01-system、a04-content（`admin.uploadBatchItem.complete` 引用 `CONFIRM_IN_PROGRESS`、`UPLOAD_NOT_FOUND`）及其他写字典项的接口只引用符号，不另定义；m03 预留的 46050–46069 已释放。

| 符号 | 数值 | HTTP | 可重试 | `details` | 含义（默认文案的意思） |
| --- | --- | --- | --- | --- | --- |
| `TICKET_REOPEN_WINDOW_CLOSED` | 45501 | 409 | 否 | `{ resolvedAt: string(date-time), windowDays: integer }` | 工单已解决超过 N 天，不能重新打开，请提交新工单（12-support.md:156；本文补） |
| `DICT_ITEM_DISABLED` | 47001 | 409 | 否 | `{ dictTypeKey: string, code: string }` | 所选选项已停用或不存在，请刷新后重新选择（d6-notify-docs-data.md:1505、2252；本文在小程序侧定号，后台复用） |
| `FILE_TYPE_NOT_ALLOWED` | 47051 | 400 | 否 | `{ allowedExts: string[] }` | 不支持该文件类型（d5-media.md:1018；本文补） |
| `FILE_TOO_LARGE` | 47052 | 400 | 否 | `{ maxBytes: string, canDelegate: boolean }` | 文件超过大小上限；小程序内视频超限时提示“视频较大，请发给服务经理代传”（A35；d5-media.md:1110-1114） |
| `UPLOAD_EXPIRED` | 47053 | 409 | 否 | 无 | 上传已过期或已取消，请重新上传（d5-media.md:1020、1028；本文补） |
| `UPLOAD_CREDENTIAL_LIMIT` | 47054 | 409 | 否 | 无 | 上传凭证续签次数已达上限，请重新上传（d5-media.md:1028；06-media.md:190） |
| `CONFIRM_IN_PROGRESS` | 47055 | 409 | 是 | 无 | 正在确认上传结果，请稍候（d5-media.md:1033；C25 的例子） |
| `UPLOAD_NOT_FOUND` | 47056 | 409 | 否 | 无 | 没有收到文件，请重新上传（d5-media.md:1036；C59） |
| `UPLOAD_REJECTED` | 47057 | 400 | 否 | `{ rejectReason: FileRejectReason }` | 文件与登记信息不符，已拒收（d5-media.md:1037 的 422 按 C24 改 400） |

引用其他来源的错误码：通用码 `VALIDATION_FAILED`、`ROLE_FORBIDDEN`、`NOT_A_MEMBER`、`NOT_FOUND`、`STATE_NOT_ALLOWED`、`FEATURE_DISABLED`、`RATE_LIMITED`、`PROVIDER_UNAVAILABLE`、`INTERNAL`（C27）；`FILE_NOT_USABLE`（46001）、`ASSET_UPLOAD_GATED`（46002）（m03-profile-asset）；`STORE_ARCHIVED`（41107，m02-tenant，C17 中间件，各接口不逐条列）。

## 6. 待确认

只留需要产品决定的问题；初稿的其余各项已由裁决关闭或按默认接受，结论见第 7 节第二轮。

| # | 问题 | 默认做法 | 谁定 |
| --- | --- | --- | --- |
| 1 | 待受理（`pending`）的工单能否补充说明：数据模型只允许处理中（12-support.md:152），刚提交的商家常想补一张图 | 按数据模型只允许 `processing`；若放开，状态机表加一行“`pending` 商家补充说明，不变” | 产品 |
| 2 | 站内消息是否随门店切换过滤（proto-merchant-b.md:460；PRD 6.16.1 的“随门店切换”清单里没有消息中心） | 按参数 `inbox.scope = current_store` 过滤（原型切换后角标变化）；改为全部门店只改参数 | 产品 |

## 7. 修订记录

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：27 条接口（V1.0 24，V1.1 3）；公共结构 `Bootstrap`、`MeOverview`、`ServiceTicketDetail`、`MessageSummary`、`FileUploadTicket` 等；新错误码 45501、47001、47051–47057 | 路线图 `doc = m08-support-misc`；A1–A75；C1–C84 |
| 2026-10-03 | 相对路线图的取舍：消息列表与计数的店员视图改 `same`（A52）；上传登记的 `idempotentBy` 补 `uq_file_object_client_token_noscope`（主体级分类，A49）；字典类型键按 14 分组更正；工单确认、重开、撤回与消息已读、上传确认、取消一律 `required`（A17）；埋点时刻改 ISO 字符串（C34）、关闭开关时回 403（C70） | A17、A49、A52；C34、C70 |
| 2026-10-03 | 第二轮。① 裁决落地：`m.serviceManager.get` 能力点 `support.manager.read`（A87），`m.me.overview.get` 能力点 `me.*`（作者默认，按第十节导语接受）；`m.file.create` 与 `m.message.*` 改为 `assert-in-handler` 并写出判定规则（A87、C66、C75）；`m.dictItem.list` 响应改为 `{ items }`（A78、C42）；限流档位 `m.analytics`、`m.subscribe` 已在 C68 登记，只写档位名；埋点与错误上报进协议同意白名单（A85）；`m.file.complete` 为 C51 登记的多事务用例（A84）；上传类码与 `DICT_ITEM_DISABLED` 归本文（A77）。初稿第 6 节第 1–7、9、11–13 项据此关闭或按默认接受，第 8、10 项改为第 1、2 项。② 店员可见响应避开 C57 禁用键：`MessageSummary.byTab` 改为 `[{ tab, unreadCount }]`，`Bootstrap.subscribePlan` 改为 `[{ point, slots: [{ slotKey, tmplId }] }]`；`ticket_submit` 的 `refund_result` 只在问题类型 `ext.isAfterSales = true` 时请求（`ticket_type` 的 ext 白名单加该键，待 14 分组登记）。③ 结构改名，避免与 a01 同名不同构：`StaffBrief` → `MerchantStaffBrief`、`DictItemView` → `MerchantDictItemView`、`FileCreateBody` → `MerchantFileCreateBody`；登记与续签统一返回与 a01 同一个 `FileRegistration`（加 `credentialsLeft`），删去 `FileUploadTicket`、`FileCredentialRenewal`（`renewalsLeft`）。④ 页面与数据模型：`ServiceTicketDetail` 补 `createdAt`；系统事件条目 `senderKind = system`、`sender = null`，本文写的系统事件同时填 `body` 与 `merchant_body`；`relatedOrder` 只取订购单、不复用 a08 的 `primaryRef`；`channelAccountAttention` 补 `abnormalSource`、`abnormalReasonLabel`；`versions.agreement` 覆盖全部协议、按 m01 的当前版本口径；超限引导改为“添加服务经理企业微信”（取 `wecomQr`）；“我的”页计数改为调用 m04 的 `order.countOrderItemsByPhase`（`delivering` 不含待开工）、`order.countCartBadge`、`order.countTodos`，套餐卡经 m07 `billing.getWalletView`，`planExpiresAt` 改名 `planPointsExpireAt`（同 `Wallet`）。⑤ 其他文档的请求：10 个端上埋点事件的 `props` schema（含 a09 的 `banner_click = { homeBannerId }`）；`DeepLink` 补 `account.detail`、`asset.demand`（m04）；`pendingConsents` 元素即 m01 的 `PendingConsent`；字典 ext 白名单按 m03 2.8；服务经理名片随交付经理转移即时更新（a03）；错误上报三端同形态（p01）。⑥ 事件与定时器：`file.uploaded` 保持在确认相符时发出（d5-media.md:1038，与 a01、a04 一致），已请 x01 与 06 分组改；`service_ticket.supplemented` 补载荷，待 x01 补登（A95）；定时器去重键改为引用 x01 4.1，不再自写键串（`st` 与 A96 的冲突由 x01 统一）。⑦ 路线图切片：消息两条 `clerkView` 改 `same`；上传登记 `idempotentBy` 改为数组、能力点 `assert-in-handler`；工单重开、撤回的迁移按源状态拆行并带行号；摘要、能力点与限流按文档回写 | A77、A78、A84、A85、A87、A95、A96、A107、A119、A120；C28、C42、C51、C57、C66、C68、C73、C75；复核意见 A、B；`review/xdoc-m08-support-misc.md`；`review/api-check.md` |
| 2026-10-03 | 第三轮。① 公共结构（A132、A150、C87）：写明本文是 `ImageRef`、`FileRegistration`（含 `PostPolicy`、`StsCredential`）的归属文档，m06、a05、a08、a06 与 a01 引用；`ServiceTicketPage`、`MessagePage` 注明即通用结构 `CursorPage<T>`；清单补 `externalSchemas`（`PendingConsent`、`CursorPage`），`SentryEnvelope` 的清单写法与 a01、p01 对齐。② 字典：`isAfterSales` 已由 14 分组登记（14-config-data.md:104、142、1069；A145），删去“待登记、登记前视为 `false`”；`m.dictItem.list` 查询参数 `types`、`parent` 改为 `typeKey`、`parentCode`（C45，与 a01 统一）。③ 事件：`service_ticket.supplemented` 已进 12 分组事件清单（A144），提醒走 a09 2.9 的场景 `s.kf_supplemented`（接收人为工单负责人），x01 目录仍待补登。④ 其他文档的请求：`DeepLink` 写明待办用到的 `delivery.plan`、`publish.task`、`offline.task`、`ticket.detail` 的对象 id 参数（m04）；证照登记范围与 m03 3.12 一致、范围不符由 m03 返回 `FILE_NOT_USABLE`（`scope_mismatch`）；`ops.maintenance_notice` 已并入待回写清单（A146）。m01、m02、m07、a01 的其余请求（`pendingConsents` 只读、“交付中”口径、`storeLimit`、套餐卡、`MerchantStaffBrief`、`clientToken` 1–64）第二轮已落实，未改 | A132、A133、A140、A144、A145、A146、A150；C42、C45、C85、C87；`review/r3-in-m08-support-misc.md` |
| 2026-10-03 | 第四轮（收尾）。① 单值字典字段改为 `DictRef`（A151、C85）：`OverviewStore.cityName`、`categoryName` → `city`、`category`；`ChannelAccountAttention.abnormalReasonLabel` → `abnormalReason`（同 m05）；`ServiceTicketCard` / `ServiceTicketDetail` 的 `typeCode` + `typeName` → `type`；`withdrawReasonCode` + `withdrawReasonName` → `withdrawReason`；请求仍收 `typeCode`、`reasonCode`；清单补 `externalSchemas` 的 `DictRef`。② `service_ticket.supplemented` 已由 x01 3.12 登记（notify 发 `s.kf_supplemented`），`file.uploaded` 已按确认时登记，删去两处“待 x01 补登 / 改”；`SentryEnvelope` 清单写法第三轮已对齐 | A141、A151；C85、C87；`review/r4-in-m08-support-misc.md` |
| 2026-10-03 | 第四轮补：`DeepLink` 路由表补登 `cart.list`（`{ storeId }`，选剧单；a09 2.9 场景 `m.cart_price_changed` 用） | a09 的请求 |
