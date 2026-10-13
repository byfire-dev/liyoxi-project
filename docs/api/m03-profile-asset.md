# 商家端：门店档案、资质与素材

| 项 | 内容 |
| --- | --- |
| 范围 | 商家端建档首页与四步（M:Profile、M:ProfileBasic、M:ProfileStore、M:ProfileService、M:ProfileCert）、审核结果（M:ProfileReview）、店员视角档案（M:StaffProfile）、门店素材（M:AssetLib、M:AssetUpload、M:AssetDetail）、素材需求卡（M:StaffProfile、M:Profile、M:Main）；“我的”页（M:Mine）、首页（M:Main）、订购与广告需求的参考素材选择器（M:Checkout、M:Ads）只读引用本文接口 |
| 接口数 | 25（V1.0 25，V1.1 0）。其中 3.11 `m.storeProfile.contactSmsCode.create` 按裁决 A48 补，第二轮已登记进本文的路线图切片 |
| 依据 | 数据模型 04（`store_profile`、`store_profile_media`、`store_service_item`、`qualification_submission`、`qualification_doc`）、06（`store_asset` 等六张素材表、`file_object`、`file_ref`、`media_info`、`ocr_result`）、02（`store`、`entity`、`entity_member`、`store_member`、`invitation`、`merchant_user`、`sms_verification`）、03（`approval_request`、`audit_log`）、01（`status_transition`、`outbox_event`、`timer`）、14（`dict_item`、`analytics_event`）；草案 d9 第 4–8 节、d5 第 5、9、10、14 节、d4 第 5.2、5.3、9.3、9.4 节与附录 B、d6 第 2.2、3 节；裁决 A1–A150；约定 C1–C87；事件目录 x01-events-jobs |

## 1. 概览

本文是商家端门店档案、资质认证与门店素材的接口。档案按门店建立，一律取请求头 `X-Store-Id` 的门店上下文（C17），路径里没有门店段。档案前三步原地保存（`draft` 区分只做格式校验还是同时校验必填）；第 4 步的主体类型、信息确认与证照挂在未关闭的资质轮次草稿上，提交只有 3.17 一个入口（A32、A41）。已通过门店改门店名称、地址、行业与品类时，新值只写进 `change` 草稿，提交审核通过后才写回生效值。素材由老板与店员共同上传、共同查看（C56 `same`），理解与复核由媒体流水线与交付经理完成，商家端只读结果。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `m.storeProfile.get` | `GET /m/store-profile` | 建档首页聚合 | member；`store.profile.read`；店员 trimmed | none（查询） |
| `m.storeProfile.basic.get` | `GET /m/store-profile/basic` | 第 1 步基础信息 | member；`store.profile.read`；店员 trimmed | none（查询） |
| `m.storeProfile.basic.update` | `PATCH /m/store-profile/basic` | 保存第 1 步（只存草稿） | member；`store.profile.edit`；店员 403 | required |
| `m.storeProfile.media.get` | `GET /m/store-profile/media` | 第 2 步门店形象 | member；`store.profile.read`；店员 trimmed | none（查询） |
| `m.storeProfile.media.update` | `PATCH /m/store-profile/media` | 保存第 2 步 | member；`store.profile.edit`；店员 403 | required |
| `m.storeProfile.service.get` | `GET /m/store-profile/service` | 第 3 步服务与价格 | member；`store.profile.read`；店员 trimmed | none（查询） |
| `m.storeProfile.service.update` | `PATCH /m/store-profile/service` | 保存第 3 步 | member；`store.profile.edit`；店员 403 | required |
| `m.storeProfile.qualification.get` | `GET /m/store-profile/qualification` | 当前资质视图 | member；`store.profile.read`；店员 trimmed | none（查询） |
| `m.storeProfile.qualification.update` | `PATCH /m/store-profile/qualification` | 保存第 4 步草稿 | member；`store.qualification.edit`；店员 403 | required |
| `m.storeProfile.contact.update` | `PATCH /m/store-profile/contact` | 保存资质联系人 | member；`store.qualification.edit`；店员 403 | required |
| `m.storeProfile.contactSmsCode.create` | `POST /m/store-profile/contact/sms-codes` | 资质联系人手机号发码（A48） | member；`store.qualification.edit`；店员 403 | required（三段式） |
| `m.qualificationDoc.create` | `POST /m/qualification-docs` | 证照挂到草稿并识别回显 | member；`store.qualification.edit`；店员 403 | required（三段式） |
| `m.qualificationDoc.update` | `PATCH /m/qualification-docs/{qualificationDocId}` | 保存核对后的证照提交值 | member；`store.qualification.edit`；店员 403 | required |
| `m.qualificationDoc.remove` | `POST /m/qualification-docs/{qualificationDocId}/remove` | 从草稿移除证照 | member；`store.qualification.edit`；店员 403 | required |
| `m.qualificationDoc.downloadUrls` | `POST /m/qualification-docs/{qualificationDocId}/download-urls` | 签发证照图片读地址 | member；`store.qualification.edit`；店员 403 | none（签发） |
| `m.storeProfile.qualification.discard` | `POST /m/store-profile/qualification/discard` | 丢弃资质草稿 | member；`store.qualification.edit`；店员 403 | required |
| `m.storeProfile.qualification.submit` | `POST /m/store-profile/qualification/submit` | 提交资质审核（唯一入口） | member；`store.qualification.edit`；店员 403 | required |
| `m.qualificationSubmission.list` | `GET /m/qualification-submissions` | 历次审核记录 | member；`store.qualification.edit`；店员 403 | none（查询） |
| `m.storeAsset.list` | `GET /m/store-assets` | 门店素材列表 | member；`asset.read`；店员 same | none（查询） |
| `m.storeAsset.summary` | `GET /m/store-assets/summary` | 素材库计数与热门标签 | member；`asset.read`；店员 same | none（查询） |
| `m.storeAsset.get` | `GET /m/store-assets/{storeAssetId}` | 素材详情 | member；`asset.read`；店员 same | none（查询） |
| `m.storeAsset.create` | `POST /m/store-assets` | 上传素材（建素材行） | member；`asset.upload`；店员 same | required |
| `m.storeAsset.portraitAuth.create` | `POST /m/store-assets/{storeAssetId}/portrait-auth` | 补交肖像授权材料 | member；`asset.upload`；店员 same | required |
| `m.storeAsset.feedback.create` | `POST /m/store-assets/{storeAssetId}/feedback` | 素材标签有误等轻量反馈 | member；`asset.feedback`（A87 增补表）；店员 same | required |
| `m.assetDemand.list` | `GET /m/asset-demands` | 素材需求 | member；`asset.demand.read`；店员 same | none（查询） |

路由注册顺序（A8）：`/m/store-assets/summary` 先于 `/m/store-assets/{storeAssetId}`；`/m/store-profile/qualification/discard`、`…/submit`、`/m/store-profile/contact/sms-codes` 都是字面段。

### 1.1 本文通用规则

| 事项 | 规则 |
| --- | --- |
| 门店范围 | 按 id 取的资源（证照行、素材）必须属于 `X-Store-Id` 的门店，否则 404 `NOT_FOUND`（C29）。唯一例外：3.15 允许读本主体生效的主体营业执照行（新增门店的“沿用主体执照”参考） |
| 已停用门店 | 由中间件处理（C17）：读接口（`store.profile.read`、`asset.read`、`asset.demand.read`）照常；写接口与 `store.qualification.edit` 的读取返回 403 `STORE_ARCHIVED`（d4-identity.md:852-859 的“已停用门店”列）。各接口的错误表不再重复 |
| 店员 | 没有能力点的接口返回 403 `ROLE_FORBIDDEN`（C27）；有店员视图的接口按第 2 节的店员 schema 出站裁剪（C55），字段命名避开 C57 的禁用模式。主推服务的 `priceFen`、`originalPriceFen` 与素材菜单条目的 `priceText` 已由 A86 列入禁用键扫描的放行名单（C57；d9-profile.md:801 ⑦） |
| 文件引用 | 请求里的 `fileId` 必须是当前用户在当前门店上下文登记（`file_object.upload_actor_id` 为当前用户、`file_object.store_id` 为当前门店）、已入库（`file_object.status = 'stored'`）、未被拦截（`file_object.moderation_state <> 'block'`）、分类符合下表的文件，否则 400 `FILE_NOT_USABLE`（`details.reason` 见第 5 节）。只校验本次新引用的文件：本对象已引用、原样保留的文件（复制档案带入的媒体、员工代传的图片、组内仍在的旧图）不再校验登记人与门店。例外：营业执照是主体级文件（`file_object.scope_type = 'entity'`，没有门店），按 3.12 的范围规则校验。上传本身走 `m.file.*`（m08-support-misc）；超过小程序上传上限在上传登记就返回 `FILE_TOO_LARGE`（m08 定义，`details.canDelegate` 提示由服务经理代传，A35），不到本文接口 |
| 字典编码 | 请求里新选的字典编码（与库中现值不同的）：不存在 → 400 `VALIDATION_FAILED`；已停用（`dict_item.is_enabled = false`）→ 409 `DICT_ITEM_DISABLED`（m08 定义，`details` 带 `dictTypeKey`、`code`，端上刷新字典后重选）；行业未开放、区划未开通 → 409 `INDUSTRY_NOT_OPEN`。沿用的旧值不再校验（字典项只停用不删除）。端上回显已停用编码的名称时调 `m.dictItem.list` 带 `includeDisabled=true`（m08） |
| 完整度缓存 | 改变完整度输入的写事务（3.3、3.5、3.7、3.9、3.10、3.12、3.14、3.16）在末尾用 `profileCompleteness()` 重算并写回 `store_profile.completeness_pct`、`required_filled`、`required_total` 与 `updated_at`（d9-profile.md:376）；档案行还不存在时按 3.1 的规则补建。资质一侧（3.9、3.12、3.14、3.16）只是刷新缓存，不改 `store_profile.lock_version` 与最近修改四列，不让同时打开的前三步页面撞 `VERSION_CONFLICT` |
| 幂等重放 | 结果脱敏（C50、A80）：3.3、3.5、3.7、3.22、3.23 的响应带签名地址，3.12 的响应带证照明文。幂等记录只存脱敏后的结果：`MediaFileView` 的 `url`、`expiresAt`、`coverUrl`，`StoreAssetCard.thumbnail`，3.12 的 `recognized`、`submitted` 写入时置空；字段路径登记在路由元数据 `x-redact-on-replay`（C75、A124）。这几条接口的响应另带 `replayed: boolean`（契约里记作小结构 `ReplayFlag`，与响应 DTO 取交，如 `StoreProfileBasic & ReplayFlag`；3.12 的 `QualificationDocRecognized` 自带该字段）：首次成功为 `false`；同键重放为 `true`，上述字段为 `null`。端上见到 `replayed = true`：3.3、3.5、3.7、3.22、3.23 重拉对应的 GET 取地址（带锁的 PATCH 换新键重调会撞 `VERSION_CONFLICT`）；3.12 见该节说明 |
| 签名地址 | 不需留痕的图片与音视频随响应现签（C60）：档案图片、素材图片与文档 30 分钟对齐窗口，素材音视频 60 分钟（C61）。证照图片只经 3.15 签发（5 分钟，写访问审计）；肖像授权材料不向商家端签发 |
| 内容安全 | 档案的文本字段在保存时同步过文本内容安全检测，命中返回 400 `CONTENT_REJECTED`（d9-profile.md:359；符号由 m01-account 定义，`details = { fields: string[] }` 为命中的请求字段路径，A131）。检测服务不可用时一律拒收：503 `PROVIDER_UNAVAILABLE`（C27，可重试），不写库（A137；草案“先接受、排队补检”V1.0 不做）。素材的文字与转写走异步审核，结果在 `store_asset.moderation_state`，接口不同步拦截 |
| 留痕 | 档案保存写 `audit_log` 的 activity 流（记改了哪些字段，d9-profile.md:316）；证照明文回显与证照图片签发写 access 流（d9-profile.md:322）；每次状态迁移在 `audit_log` 恰好一行（03 分组 M31） |
| 加锁顺序 | 资质轮次（65）→ 主体（100）→ 门店（130）→ 档案行（135）→ 子表行（04-profile.md:666）；素材行（370）→ 文件行（410）（06-media.md:1105、85） |
| 三段式 | 3.11（先落库、提交后直发）与 3.12（先调外部、再开事务）是 C51 的三段式用例，路由标 `x-three-phase`（C75、A124）：先占用幂等记录（`in_progress`，30 秒），同键并发或超时重发在占用期内得到 409 `IDEMPOTENCY_IN_PROGRESS`（可重试）。3.11 已在 C51 登记（A84）；3.12 已按 A139 登记（C51“先外调”） |
| 开放枚举 | 响应里的状态、类型类枚举都标 `x-open-enum`（C37），端上对未知值兜底展示 |

文件分类与用途（d5-media.md:1559-1592 的分类码；06-media.md:1584-1615）：

| 用途 | `file_object.category` | 引用登记（`file_ref.ref_type` / `role`） |
| --- | --- | --- |
| 品牌 Logo、门头、店内环境、实拍图片、主推服务图片 | `profile_image` | `store_profile` / `logo`；`store_profile_media` / `main`；`store_service_item` / `image` |
| 实拍视频 | `profile_video` | `store_profile_media` / `main` |
| 已有宣传素材（图或视频） | `profile_promo` | `store_profile_media` / `main` |
| 营业执照、分支机构营业执照 | `kyc_license` | `qualification_doc` / `main` |
| 行业许可证 | `kyc_permit` | `qualification_doc` / `main` |
| 门店素材文件 | `store_asset` | `store_asset` / `main` |
| 肖像授权材料 | `portrait_auth` | `store_asset` / `portrait_auth` |

### 1.2 本模块给其他文档的进程内接口

不是 HTTP 路由，列在这里供引用方对号。

| 接口 | 谁调 | 规则 |
| --- | --- | --- |
| `profile.assertProfileComplete(storeId)` | m04 `m.order.create` 与报价的 `blockers`；m06 广告提交 | 前三步的 11 项必填齐全（d9-profile.md:378，第 4 步由门店闸门覆盖）；不齐抛 `STORE_PROFILE_INCOMPLETE`（本文定义，`details.missing` 与 3.17 同构，A123） |
| `profile.storeGate(storeId)` | m04、m05、m06 | 门店闸门（d3-flow.md:419）；不满足时由调用方返回 `STORE_NOT_QUALIFIED`（m04 定义，A77） |
| `StoreCloseGuard`（profile 登记两类） | m02 `m.store.archive`、`m.store.delete` | `qualification_in_review`：门店有在审的资质轮次；`unverified_primary_store`：主体未认证时的首家门店（d4-identity.md:790；d9-profile.md:736）。取值是 m02 的 `StoreBlockerKind` |
| 新增门店建档与复制 | m02 `m.store.create`（同一事务） | 建 `store_profile`；按 `copyOptions` 复制 `basic`、`service`（`store_profile` 字段与 `store_service_item`）、`media`（`store_profile_media`）；`brand_assets` 由 media 复制来源门店带“品牌故事”内容标签（字典 `asset_tag` 的播种编码 `brand_story`，A145；14-config-data.md:141）的素材（06-media.md:1195） |
| `profile.validateStoreBasics({ storeName, addressDetail, industryCode, categoryCode })` | m02 `m.store.create`（事务外先调） | 与 3.3 第 1 步同一个函数、同一组错误码，新增门店不能成为绕过档案校验的入口：长度与格式不符、编码不存在、品类不隶属行业 → 400 `VALIDATION_FAILED`；行业或品类已停用 → 409 `DICT_ITEM_DISABLED`（m08）；未开放 → 409 `INDUSTRY_NOT_OPEN`；文本内容安全检测（门店名称、详细地址）命中 → 400 `CONTENT_REJECTED`，服务不可用 → 503 `PROVIDER_UNAVAILABLE`（1.1“内容安全”，A137）。只读、不写库；新增门店的各值都是“新选”，全部校验 |
| 资质审批单摘要处理器 | 3.17 的 `approval.submit` | `summary_snapshot` 的取值见 3.17 副作用（a03 的审核队列读它） |
| 订阅者 | x01 | `profile.onTenantLifecycle`（订阅门店停用、删除草稿门店、恢复与主体放弃、关闭五个事件，m02 的请求）、`profile.onQualificationApproved`、`profile.onFileModerated`；事件名与处理规则登记在 x01 第 2.5 节 |

## 2. 公共结构

### 2.1 小结构

**引用的通用结构**（C87，本文不再定义）：`SignedUrl = { url, expiresAt }`（a01-system 归属；`url` 不可空，整个对象可空，C60）；`CursorPage<T> = { items, nextCursor, hasMore }`（约定 C42 的通用结构，A150）；`DictRef = { code, name }`（约定 C85 的通用结构）。

**MediaFileView**（档案媒体、素材文件）

| 字段 | 类型 | 必有 | 说明 | 来源（表.列 或计算规则） |
| --- | --- | --- | --- | --- |
| fileId | string(uuid) | 是 | 文件 | `file_object.id` |
| kind | enum(`image`、`video`、`audio`、`document`) | 是 | 由规范类型推出 | `file_object.mime` |
| url | string \| null | 是 | 读地址；GET 响应总有值，只在写接口的幂等重放里为空（1.1“幂等重放”） | 现签：图片、文档 30 分钟对齐窗口；音视频 60 分钟 |
| expiresAt | string(date-time) \| null | 是 | 地址到期时间；空的规则同 `url` | 同上 |
| coverUrl | string \| null | 是 | 视频封面；未抽帧或幂等重放时为空 | `media_info.cover_file_id` 现签 |
| durationMs | integer \| null | 是 | 音视频时长 | `media_info.duration_ms` |
| displayWidth | integer \| null | 是 | 显示宽度（门头照“宽度不低于 1080 像素”的提示用） | `media_info.display_width` |
| displayHeight | integer \| null | 是 | 显示高度 | `media_info.display_height` |
| moderationState | enum(同数据模型 `file_object.moderation_state`) | 是 | `block` 时端上提示替换 | `file_object.moderation_state` |

**AddressView**（地址，响应；四级区划按 C85、A151 给 `DictRef`，名称按当前字典取，已停用的项仍返回名称。请求体用 AddressInput）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| province | DictRef \| null | 是 | 省，字典 `region` | `store_profile.province_code` + `dict_item.name` |
| city | DictRef \| null | 是 | 市 | `store_profile.city_code` + `dict_item.name` |
| district | DictRef \| null | 是 | 区县（只存行政区划） | `store_profile.district_code` + `dict_item.name` |
| zone | DictRef \| null | 是 | 功能区（`F` 前缀），只作标注 | `store_profile.zone_code` + `dict_item.name` |
| detail | string \| null | 是 | 详细地址 | `store_profile.address_detail` |
| poiName | string \| null | 是 | 地图选点名称 | `store_profile.poi_name` |
| latitude | number \| null | 是 | 纬度，6 位小数，存端上选点原值 | `store_profile.latitude` |
| longitude | number \| null | 是 | 经度 | `store_profile.longitude` |

**AddressInput**（地址，请求；3.3 的 `address`，各键必填规则见 3.3）：`{ provinceCode, cityCode, districtCode, zoneCode, detail, poiName, latitude, longitude }`，四个区划键收字典 `region` 的编码（`string | null`，C85），其余键同 AddressView。

**BusinessHourSlot**：`{ start: string(HH:mm), end: string(HH:mm) }`，即 `store_profile.business_hours` 的元素（04-profile.md:541-550）。`end` 早于 `start` 表示跨零点（本稿补充）。

**Completeness**（完整度，d9-profile.md:363-376）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| pct | integer | 是 | 0–100 的整数百分数 | 纯函数 `profileCompleteness()` 现算（单店读取时现算，d9-profile.md:376）；写事务末尾同时写回 `store_profile.completeness_pct` |
| requiredFilled | integer | 是 | 已填必填项 | 同上；写回 `store_profile.required_filled` |
| requiredTotal | integer | 是 | 全部必填项（餐饮 16，不要求许可证的品类 15） | 同上；写回 `store_profile.required_total` |
| steps | array<StepProgress> | 是 | 四步各一项，按 1–4 排列 | 同上 |

StepProgress：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| step | integer | 是 | 第几步，1–4 | — |
| state | enum `StepState` | 是 | 未开始、进行中、已完成 | `profileCompleteness()` |
| missing | array<MissingItem> | 是 | 本步缺项 | 同上 |

MissingItem（缺项；`STORE_PROFILE_INCOMPLETE.details.missing` 的元素另带 `step`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| item | enum `MissingItemKey` | 是 | 缺的是哪一项 | `profileCompleteness()`（d9-profile.md:367-372） |
| permitType | string \| null | 是 | `item = 'permit'` 时为缺的许可证类型（字典 `permit_type` 编码），其余为空。本结构同时是错误详情 `STORE_PROFILE_INCOMPLETE.details.missing` 的元素（m04 透传），按机读键保留编码，名称取 `requiredPermits` | 字典 `industry` 的 `ext.requiredCerts` |

**UploaderView**（素材上传人）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| actorType | enum(`merchant`、`staff`) | 是 | 商家上传或员工代传 | `store_asset.upload_actor_type` |
| role | enum(`owner`、`clerk`) \| null | 是 | 上传时的角色快照；代传为空 | `store_asset.upload_actor_role` |
| displayName | string \| null | 是 | 称呼：商家取该用户在本主体最近一条成员关系的称呼，员工取对商家展示的称呼 | `entity_member.display_name`；`staff.display_name`，空时 `staff.name` |
| isMe | boolean | 是 | 是否当前用户上传 | `store_asset.upload_actor_id` 等于当前用户且类型为 `merchant` |

**AssetTag**（素材标签）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| dimension | enum(同数据模型 `store_asset_tag.dimension`) | 是 | 内容、用途、时效 | `store_asset_tag.dimension` |
| tag | DictRef | 是 | 字典 `asset_tag` 的项（C85、A151；名称按当前字典取，已停用的项仍返回名称） | `store_asset_tag.tag_code` + `dict_item.name` |
| source | enum(同数据模型 `store_asset_tag.source`) | 是 | 机器、上传人、复核人 | `store_asset_tag.source` |
| isConfirmed | boolean | 是 | 经复核确认；展示时覆盖机器与上传人的同维度标签 | `store_asset_tag.is_confirmed` |
| validStartDate | string(date) \| null | 是 | 时效起始日 | `store_asset_tag.valid_start_date` |
| validEndDate | string(date) \| null | 是 | 时效结束日 | `store_asset_tag.valid_end_date` |

### 2.2 StoreProfileOverview（建档首页，老板视图）

| 字段 | 类型 | 必有 | 说明 | 来源（表.列 或计算规则） |
| --- | --- | --- | --- | --- |
| viewerRole | enum(`owner`) | 是 | 判别字段（C55） | 当前成员角色 |
| store | StoreBrief | 是 | 门店卡 | 见下 |
| entityName | string \| null | 是 | 营业执照主体名称（合同、授权书、发票抬头）；认证前为空 | `entity.name` |
| completeness | Completeness | 是 | 完整度 | 2.1 |
| steps | StepCards | 是 | 四步摘要卡 | 见下 |
| qualification | QualificationBrief | 是 | 资质状态 | 见下 |
| assets | AssetsBrief | 是 | 门店素材摘要 | 见下 |
| members | MembersBrief | 是 | 门店成员摘要 | 见下 |
| ads | AdsBrief | 是 | 我的广告按状态计数 | 见下 |

StoreBrief：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| storeId | string(uuid) | 是 | 门店 | `store.id` |
| name | string \| null | 是 | 门店名称（生效值）；首家门店未填时为空 | `store.name` |
| isPrimary | boolean | 是 | 是否首家门店 | `store.is_primary` |
| qualificationStatus | enum(同数据模型 `store.qualification_status`) | 是 | 门店资质结论 | `store.qualification_status` |
| isChangeInReview | boolean | 是 | 派生“变更审核中” | 有 `kind = 'change'` 且在审的 `qualification_submission` |
| isFinalRejected | boolean | 是 | 派生“终局驳回” | `store_profile.final_rejected_at` 非空 |
| industry | DictRef \| null | 是 | 一级行业（生效值；C85、A151） | `store_profile.industry_code` + `dict_item.name` |
| category | DictRef \| null | 是 | 二级品类（生效值） | `store_profile.category_code` + `dict_item.name` |

StepCards（`{ basic, media, service, qualification }`，每项都带 `state`，取值 `StepState`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| basic.state | enum `StepState` | 是 | 第 1 步状态 | `profileCompleteness()` |
| media.state | enum `StepState` | 是 | 第 2 步状态 | 同上 |
| media.doorCount、interiorCount、productCount、promoCount | integer | 是 | 四组在用媒体数（“门头照片 2 张、店内环境 6 张”） | `store_profile_media` 中 `removed_at` 为空的行按 `media_group` 计数 |
| service.state | enum `StepState` | 是 | 第 3 步状态 | `profileCompleteness()` |
| service.serviceItemCount | integer | 是 | 主推服务数 | `store_service_item` 中 `removed_at` 为空的行数 |
| service.sellingPointCount | integer | 是 | 卖点标签数 | `store_profile.selling_point_codes` 的元素数 |
| service.hasPromoText | boolean | 是 | 是否填了优惠活动 | `store_profile.promo_text` 非空 |
| qualification.state | enum `StepState` | 是 | 第 4 步状态（提交后端上改显 `qualification.status`） | `profileCompleteness()` |
| qualification.docTypes | array<{ docType, permitType: DictRef \| null }> | 是 | 当前资质视图里的证照种类（“营业执照、食品经营许可证”） | 当前资质视图（d9-profile.md:374）各轮次中未移除的 `qualification_doc.doc_type`、`qualification_doc.permit_type`；店员不返回 |

QualificationBrief：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| status | enum(同数据模型 `store.qualification_status`) | 是 | 门店资质结论 | `store.qualification_status` |
| submittedAt | string(date-time) \| null | 是 | 在审轮次的提交时间；店员不返回 | 未关闭轮次的 `qualification_submission.submitted_at` |
| dueAt | string(date-time) \| null | 是 | 预计完成时间（“预计今天 18:20 前完成”）；店员不返回 | 在审轮次审批单的 `approval_request.due_at` |
| lastDecidedAt | string(date-time) \| null | 是 | 最近一次审核决定时间（“06-13 通过”）；店员不返回 | `store_profile.last_decided_at` |

AssetsBrief（店员相同）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| total | integer | 是 | 本门店未删除素材数（“全部 128 条”） | `store_asset` 中 `deleted_at` 为空的行数 |
| recent7dCount | integer | 是 | 近 7 天新增 | `store_asset.created_at` 在 7×24 小时内 |
| recent | array<StoreAssetCard> | 是 | 最近上传，按上传时间倒序取 3 条 | `store_asset` |

MembersBrief：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| ownerDisplayName | string \| null | 是 | 老板称呼（店员视角“老板王先生”） | 本主体有效老板的 `entity_member.display_name` |
| clerkCount | integer | 是 | 本门店有效店员数 | `store_member` 中 `store_id` 为当前门店、且对应 `entity_member.status = 'active'` 的行数 |
| pendingInvitationCount | integer | 是 | 待接受邀请数；店员不返回（占名额） | `invitation` 中 `store_id` 为当前门店、`status = 'pending'` 且 `expires_at > now` 的行数 |
| preview | array<{ displayName, role }> | 是 | 头像预览，至多 3 人 | `entity_member.display_name`、`entity_member.role` |

AdsBrief（店员不返回；只计本门店；口径与 m06-ad 的列表页签 `AdListTab` 相同，从首页卡片点进“我的广告”时各页签数量对得上；商家端映射见 d3-flow.md:1257）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| confirmedCount | integer | 是 | 已确认 | `ad.status = 'confirmed'` 的条数 |
| pendingConfirmCount | integer | 是 | 待确认 | `ad.status = 'pending_confirm'` 的条数 |
| producingCount | integer | 是 | 制作中（m06 的 `producing` 页签） | `ad.status` 为 `pending_assign`、`producing`、`returned` 的条数 |
| revisingCount | integer | 是 | 修改中（m06 的 `revising` 页签）；原型卡片只写了三态，端上在大于 0 时补“修改中 N 条” | `ad.status = 'revising'` 的条数 |

**StoreProfileOverviewClerk**（店员视图）：`viewerRole = 'clerk'`；不含 `entityName`、`ads`、`steps.qualification.docTypes`、`qualification.submittedAt`、`qualification.dueAt`、`qualification.lastDecidedAt`、`members.pendingInvitationCount`；其余同老板视图（C56；d4-identity.md:887-902）。

### 2.3 StoreProfileBasic（第 1 步，老板视图）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| viewerRole | enum(`owner`) | 是 | 判别字段 | 当前成员角色 |
| brandName | string \| null | 是 | 品牌名称 | `store_profile.brand_name` |
| logo | MediaFileView \| null | 是 | 品牌 Logo | `store_profile.logo_file_id` |
| storeName | string \| null | 是 | 门店名称（生效值） | `store.name` |
| industry | DictRef \| null | 是 | 一级行业（生效值；C85、A151，请求收 `industryCode`） | `store_profile.industry_code` + `dict_item.name` |
| category | DictRef \| null | 是 | 二级品类（生效值；请求收 `categoryCode`） | `store_profile.category_code` + `dict_item.name` |
| address | AddressView | 是 | 地址（生效值） | 2.1 |
| businessHours | array<BusinessHourSlot> | 是 | 营业时间 | `store_profile.business_hours` |
| storeTel | string \| null | 是 | 联系电话（公开信息） | `store_profile.store_tel` |
| avgSpendFen | integer(分) \| null | 是 | 人均消费 | `store_profile.avg_spend_fen` |
| brandIntro | string \| null | 是 | 品牌简介 | `store_profile.brand_intro` |
| reviewFieldsLocked | boolean | 是 | 门店名称、地址、行业与品类当前不能改（审核期间锁定，d9-profile.md:360） | `store.qualification_status = 'pending'`，或有在审的 `change` 轮次 |
| reviewRequiredOnChange | boolean | 是 | 改这些字段须确认重审（页面“修改需重新审核”提示） | `store.qualification_status = 'verified'` |
| pendingChange | PendingChange \| null | 是 | 未关闭的 `change` 轮次里的待审值；店员不返回 | 见下 |
| lastEditedAt | string(date-time) \| null | 是 | 最近修改时间 | `store_profile.last_edited_at` |
| lockVersion | integer | 是 | 档案行乐观锁；店员不返回 | `store_profile.lock_version` |
| completeness | Completeness | 是 | 保存后的完整度 | 2.1 |

PendingChange（草稿里没有改的类别为空）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| qualificationSubmissionId | string(uuid) | 是 | `change` 轮次 | `qualification_submission.id` |
| phase | enum `RoundPhase` | 是 | 只取 `draft`、`in_review` | 派生 |
| storeName | string \| null | 是 | 待审门店名称 | `qualification_submission.proposed_store_name` |
| industry | DictRef \| null | 是 | 待审一级行业 | `qualification_submission.proposed_industry_code` + `dict_item.name` |
| category | DictRef \| null | 是 | 待审二级品类 | `qualification_submission.proposed_category_code` + `dict_item.name` |
| address | object \| null | 是 | 待审地址，键同 AddressView 去掉 `zone`（04-profile.md:552-564） | `qualification_submission.proposed_address_snapshot` |
| lockVersion | integer | 是 | 轮次乐观锁（3.3 写待审值时递增，供紧接着调 3.9、3.13 使用） | `qualification_submission.lock_version` |

**StoreProfileBasicClerk**：`viewerRole = 'clerk'`；不含 `pendingChange`、`lockVersion`；其余同老板视图（店员只读前三步全部字段，d9-profile.md:406）。

### 2.4 StoreProfileMedia（第 2 步，老板视图）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| viewerRole | enum(`owner`) | 是 | 判别字段（C55） | 当前成员角色 |
| groups | object `{ door, interior, product, promo }` | 是 | 四组媒体，各为 array<ProfileMediaItem>，按 `position` 排列 | `store_profile_media` 中 `removed_at` 为空的行，按 `media_group` 分组 |
| lockVersion | integer | 是 | 档案行乐观锁 | `store_profile.lock_version` |
| completeness | Completeness | 是 | 完整度 | 2.1 |

**StoreProfileMediaClerk**（店员视图）：`viewerRole = 'clerk'`、`groups`、`completeness`；不含 `lockVersion`。老板与店员两个 schema 以 `viewerRole` 组成 discriminatedUnion（C55），店员视图进 clerk-visible-keys 黄金文件（A12）。

ProfileMediaItem（图注 `caption` V1.0 不开放，不出接口，04-profile.md:174）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| mediaItemId | string(uuid) | 是 | 媒体行 | `store_profile_media.id` |
| position | integer | 是 | 组内顺序，从 1 起 | `store_profile_media.position` |
| mediaKind | enum(同数据模型 `store_profile_media.media_kind`) | 是 | 图片或视频 | `store_profile_media.media_kind` |
| file | MediaFileView | 是 | 文件与地址 | `store_profile_media.file_id` |
| isCopied | boolean | 是 | 由复制档案带入 | `store_profile_media.copied_from_store_id` 非空 |

### 2.5 StoreProfileService（第 3 步，老板视图）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| viewerRole | enum(`owner`) | 是 | 判别字段（C55） | 当前成员角色 |
| serviceItems | array<ServiceItem> | 是 | 主推服务，按 `position` 排列 | `store_service_item` 中 `removed_at` 为空的行 |
| promoText | string \| null | 是 | 优惠活动 | `store_profile.promo_text` |
| groupBuyText | string \| null | 是 | 团购信息 | `store_profile.group_buy_text` |
| sellingPoints | array<DictRef> | 是 | 核心卖点标签（字典 `store_selling_point`）；响应按 C85 给 `DictRef[]`，名称按当前字典取，已停用的项仍返回名称；请求仍收 `sellingPointCodes`（3.7） | `store_profile.selling_point_codes` + `dict_item.name` |
| sellingNote | string \| null | 是 | 卖点补充说明 | `store_profile.selling_note` |
| lockVersion | integer | 是 | 档案行乐观锁 | `store_profile.lock_version` |
| completeness | Completeness | 是 | 完整度 | 2.1 |

**StoreProfileServiceClerk**（店员视图）：`viewerRole = 'clerk'`；不含 `lockVersion`；其余同老板视图（含主推服务的现价与原价，A86 放行）。与老板视图组成 discriminatedUnion，进黄金文件。

ServiceItem（店员可见现价与原价，d9-profile.md:801 ⑦）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| serviceItemId | string(uuid) | 是 | 服务行 | `store_service_item.id` |
| position | integer | 是 | 排序，从 1 起 | `store_service_item.position` |
| name | string | 是 | 名称 | `store_service_item.name` |
| priceFen | integer(分) | 是 | 现价 | `store_service_item.price_fen` |
| originalPriceFen | integer(分) \| null | 是 | 原价 | `store_service_item.original_price_fen` |
| image | MediaFileView \| null | 是 | 图片 | `store_service_item.image_file_id` |
| intro | string \| null | 是 | 简介 | `store_service_item.intro` |

V1.1 的广告风格偏好、禁用内容不出接口（`store_profile.ad_style_code`、`store_profile.banned_terms` V1.0 不写入）。

### 2.6 资质：QualificationView、QualificationRound、QualificationDoc、ContactView

**QualificationView**（老板视图）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| viewerRole | enum(`owner`) | 是 | 判别字段 | 当前成员角色 |
| storeQualificationStatus | enum(同数据模型 `store.qualification_status`) | 是 | 门店资质结论 | `store.qualification_status` |
| isChangeInReview | boolean | 是 | 变更审核中 | 同 2.2 StoreBrief |
| isFinalRejected | boolean | 是 | 终局驳回（不再出现“重新提交”） | `store_profile.final_rejected_at` 非空 |
| entity | EntityQualificationBrief | 是 | 经营主体 | 见下 |
| openRound | QualificationRound \| null | 是 | 未关闭的轮次（草稿或在审），每店至多一轮（`uq_qualification_submission_open`） | `qualification_submission` 中 `closed_at` 为空的行 |
| lastClosedRound | QualificationRound \| null | 是 | 最近一轮已提交并关闭的轮次（审核结果页的驳回原因、被驳回的证照） | `qualification_submission` 中 `submitted_at`、`closed_at` 都非空的最近一行 |
| effectiveDocs | array<QualificationDoc> | 是 | 生效证照：本门店的门店级生效行与主体的生效营业执照 | `qualification_doc` 中 `effective_at` 非空、`superseded_at` 为空的行 |
| requiredPermits | array<{ permitType: DictRef, isProvided: boolean }> | 是 | 所选品类要求的行业许可证（“餐饮 / 火锅品类须上传”）及本轮是否已有 | 字典 `industry` 的 `dict_item.ext` 中 `requiredCerts`，品类取草稿的 `proposed_category_code`，否则 `store_profile.category_code`；`isProvided` 看未关闭轮次有无该 `permit_type` 的未移除行 |
| contact | ContactView | 是 | 资质联系人 | 见下 |
| declaration | `{ currentVersion: string }` | 是 | 现行“信息确认”文案版本号，提交时回传 | 配置（默认为契约登记的代码常量，见第 6 节第 1 项） |
| actions | array<string> | 是 | 当前可执行的动作，取 `submit`、`discard` | 当前 `initial` 草稿且门店非终局驳回 → `submit`；`change` / `new_store` 草稿 → `discard`；多轮提交随 W2-11 后续开放（C16） |

EntityQualificationBrief（认证前除结论外各值为空；不带 `entityId`，主体由门店上下文确定。与 m02 的 `EntityBrief` 不同构，按 C87、A132 改名，原名 `EntityBrief`）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| verificationStatus | enum(同数据模型 `entity.verification_status`) | 是 | 主体结论（`initial` 轮次的结论） | `entity.verification_status` |
| name | string \| null | 是 | 主体名称（抬头） | `entity.name` |
| entityType | enum(`enterprise`、`individual`) \| null | 是 | 主体类型 | `entity.entity_type` |
| usccMask | string \| null | 是 | 信用代码脱敏串 | `entity.uscc_mask` |
| legalRepNameMask | string \| null | 是 | 法定代表人或经营者姓名脱敏串 | `entity.legal_rep_name_mask` |
| verifiedAt | string(date-time) \| null | 是 | 首次认证通过时间 | `entity.verified_at` |

**QualificationRound**

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| qualificationSubmissionId | string(uuid) | 是 | 轮次 | `qualification_submission.id` |
| kind | enum(同数据模型 `qualification_submission.kind`) | 是 | 首次、新增门店、变更重审 | `qualification_submission.kind` |
| phase | enum `RoundPhase` | 是 | 草稿、在审、已关闭 | 派生：`submitted_at`、`closed_at`（04-profile.md:339-347） |
| roundNo | integer \| null | 是 | 门店内轮次号；草稿为空 | `qualification_submission.round_no` |
| isResubmit | boolean | 是 | 驳回后重新提交（队列显示“重新提交”） | `qualification_submission.resubmit_of_qualification_submission_id` 非空 |
| claimedEntityType | enum(同数据模型 `qualification_submission.claimed_entity_type`) \| null | 是 | 所选主体类型 | `qualification_submission.claimed_entity_type` |
| declarationConfirmedAt | string(date-time) \| null | 是 | 信息确认勾选时间 | `qualification_submission.declaration_confirmed_at` |
| declarationVersion | string \| null | 是 | 勾选时的文案版本 | `qualification_submission.declaration_version` |
| changedFields | array<enum> | 是 | `change` 轮次改了哪几类；其余为 `[]` | `qualification_submission.changed_fields` |
| proposed | PendingChange \| null | 是 | `change` 轮次的待审值；其余为空 | `qualification_submission.proposed_*` |
| contactSnapshot | `{ name, phoneMask, phoneVerifyState }` \| null | 是 | 提交时的联系人快照（不含明文）；`phoneVerifyState` 取值同 ContactView | `qualification_submission.contact_snapshot` 的 `name`、`phoneMask`、`phoneSource`（jsonb 键名不变，出接口改名，避免与请求里 A25 的 `phoneSource` 同名异义） |
| submittedAt | string(date-time) \| null | 是 | 提交时间 | `qualification_submission.submitted_at` |
| dueAt | string(date-time) \| null | 是 | 预计完成时间（在审时） | `approval_request.due_at`（经 `qualification_submission.approval_request_id`） |
| closedAt | string(date-time) \| null | 是 | 关闭时间 | `qualification_submission.closed_at` |
| outcome | enum(同数据模型 `qualification_submission.outcome`) \| null | 是 | 结论 | `qualification_submission.outcome` |
| decidedAt | string(date-time) \| null | 是 | 决定时间 | `approval_request.decided_at` |
| isDecidedBySystem | boolean | 是 | 系统驳回或撤回 | `approval_request.is_decided_by_system`；草稿为 false |
| rejectReasons | array<DictRef> | 是 | 驳回原因（“证照模糊”）；字典不下发商家端，服务端带出名称（C85、A151；原 `{ code, label }`） | `approval_request.reason_codes` + 字典 `reject_reason` 的 `dict_item.name`（14-config-data.md:103） |
| decisionNote | string \| null | 是 | 驳回说明 | `approval_request.decision_note` |
| systemRejectCode | enum(同数据模型 `qualification_submission.system_reject_code`) \| null | 是 | 系统驳回原因 | `qualification_submission.system_reject_code` |
| finalRejectedAt | string(date-time) \| null | 是 | 终局驳回时间 | `qualification_submission.final_rejected_at` |
| docs | array<QualificationDoc> | 是 | 本轮证照（只含未移除的行，04-profile.md:389） | `qualification_doc` 中本轮 `removed_at` 为空的行 |
| lockVersion | integer | 是 | 轮次乐观锁（草稿编辑用） | `qualification_submission.lock_version` |

**QualificationDoc**（脱敏视图；GET 一律脱敏，d9-profile.md:785 C14）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| qualificationDocId | string(uuid) | 是 | 证照行 | `qualification_doc.id` |
| docType | enum(同数据模型 `qualification_doc.doc_type`) | 是 | 证照类型 | `qualification_doc.doc_type` |
| permitType | DictRef \| null | 是 | 许可证类型（字典 `permit_type`；C85、A151，字段名本无 `Code` 后缀，保留） | `qualification_doc.permit_type` + `dict_item.name` |
| scope | enum(同数据模型 `qualification_doc.scope`) | 是 | 属主体或属门店 | `qualification_doc.scope` |
| origin | enum(同数据模型 `qualification_doc.origin`) | 是 | 本轮新上传或原样带入 | `qualification_doc.origin` |
| fileId | string(uuid) | 是 | 证照图片；看图走 3.15 | `qualification_doc.file_id` |
| ocrStatus | enum `OcrStatus` | 是 | 识别结果 | `ocr_result.status`（经 `qualification_doc.ocr_result_id`）；未关联识别结果为 `unavailable` |
| ocrWarnings | array<string> | 是 | 识别告警码（翻拍、复印件） | `ocr_result.warnings` 的 `code` |
| hasSubmittedFields | boolean | 是 | 是否已有提交值（提交校验第 4 项） | `qualification_doc.submitted_fields_enc` 非空 |
| holderName | string \| null | 是 | 证照上的主体或经营者名称 | `qualification_doc.holder_name` |
| certNoMask | string \| null | 是 | 证件号脱敏串 | `qualification_doc.cert_no_mask` |
| principalNameMask | string \| null | 是 | 负责人姓名脱敏串 | `qualification_doc.principal_name_mask` |
| principalRole | enum(同数据模型 `qualification_doc.principal_role`) \| null | 是 | 法定代表人、经营者、负责人 | `qualification_doc.principal_role` |
| subjectType | enum(同数据模型 `qualification_doc.subject_type`) \| null | 是 | 识别出的证照主体类型 | `qualification_doc.subject_type` |
| validStartDate | string(date) \| null | 是 | 有效期起 | `qualification_doc.valid_start_date` |
| validEndDate | string(date) \| null | 是 | 有效期止 | `qualification_doc.valid_end_date` |
| isLongTerm | boolean | 是 | 营业期限为长期 | `qualification_doc.is_long_term` |
| expiryState | enum `ExpiryState` | 是 | 到期提示（只提示，不改结论，d9-profile.md:581） | `valid_end_date` 与北京时间今天比较：已过 → `expired`；30 天内 → `expiring`（参数 `remind.cert_expiry.days`） |
| displayFields | array<{ key: string, label: string, value: string }> | 是 | 非敏感字段（经营范围、住所、许可证经营项目与经营场所） | 解密 `qualification_doc.reviewed_fields_enc`（否则 `submitted_fields_enc`）后只取非敏感键：营业执照与分支机构执照固定为 `address`、`businessScope`；许可证取 `PermitTypeExt.fields` 中 `sensitive = false`、且不是 `holderNameKey`、`validFromKey`、`validToKey` 的键（这几项已有专用字段），`label` 取字典配置（2.8）。信用代码、证件号、姓名不在其中 |
| verdict | enum(同数据模型 `qualification_doc.verdict`) \| null | 是 | 本轮结论（被点名驳回为 `rejected`） | `qualification_doc.verdict` |
| isEffective | boolean | 是 | 是否当前生效证照 | `qualification_doc.effective_at` 非空且 `superseded_at` 为空 |
| uploadedAt | string(date-time) | 是 | 上传时间 | `qualification_doc.created_at` |

**ContactView**（老板视图专有）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| name | string \| null | 是 | 联系人姓名 | `store_profile.contact_name` |
| phoneMask | string \| null | 是 | 手机号脱敏串 | `store_profile.contact_phone_mask` |
| phoneVerifyState | enum `PhoneVerifyState`（同数据模型 `store_profile.contact_phone_source`）\| null | 是 | 登录手机号、已短信验证、未验证。响应字段不叫 `phoneSource`：请求里的 `phoneSource` 是 A25 的来源（`login`、`input`），两者取值不同 | `store_profile.contact_phone_source` |
| phoneVerifiedAt | string(date-time) \| null | 是 | 短信验证通过时间 | `store_profile.contact_phone_verified_at` |
| loginPhoneMask | string \| null | 是 | 登录手机号脱敏串（“默认取登录手机号”的显示） | 当前用户的 `merchant_user.phone_mask` |
| isSmsVerifyAvailable | boolean | 是 | 短信验证是否可用；不可用时改号直接记为未验证 | 通知模块短信通道已配置且验证码模板启用（13 分组 `sms_template`） |
| lockVersion | integer | 是 | 档案行乐观锁 | `store_profile.lock_version` |

**QualificationViewClerk**（店员视图，只有状态，C56）：`viewerRole = 'clerk'`、`storeQualificationStatus`、`isChangeInReview`、`isFinalRejected`。

**QualificationDocRecognized**（3.12 的响应；上传后的那一次回显给老板明文，d9-profile.md:785 C14）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| qualificationSubmissionId | string(uuid) | 是 | 所属草稿轮次 | `qualification_doc.qualification_submission_id` |
| lockVersion | integer | 是 | 轮次的新锁版本 | `qualification_submission.lock_version` |
| doc | QualificationDoc | 是 | 新证照行（脱敏视图） | 同上 |
| recognized | object \| null | 是 | 识别值明文，只在首次成功的响应里出现。营业执照为 `{ name, uscc, principal, principalRole, subjectType, validFrom, validTo, address, businessScope }`（`validTo` 可为 `long_term`）；许可证为 `PermitTypeExt.fields` 配置的键（2.8）。识别不可用、或幂等重放时为空——识别是否可用看 `doc.ocrStatus`，不看本字段是否为空 | `ocr_result.fields_enc` 解密（06-media.md:1784） |
| submitted | object \| null | 是 | 已存的提交值明文（识别成功时与 `recognized` 相同，商家核对后可经 3.13 修改）；幂等重放时为空 | `qualification_doc.submitted_fields_enc` 解密 |
| entityTypeCheck | `{ recognizedSubjectType, claimedEntityType, isMismatch: boolean }` \| null | 是 | 营业执照识别类型与所选主体类型是否矛盾（页面“与所选主体类型不一致”提示）；非营业执照为空 | `qualification_doc.subject_type` 与 `qualification_submission.claimed_entity_type` 比较；`unknown` 或未选不算矛盾 |
| replayed | boolean | 是 | 是否幂等重放（C50、A80）；为 `true` 时 `recognized`、`submitted` 为空 | 幂等引擎 |

### 2.7 素材：StoreAssetCard、StoreAssetDetail、StoreAssetSummary、AssetDemandItem

**洞察的取法**（`store_asset_insight` 每个文件、每一步、每个 `prompt_version` 各一行，可重跑，06-media.md:1260、1292）：同一（文件，`kind`）只取 `status = 'ok'` 中 `prompt_version` 最大的一行；汇总 `digest` 是素材级（`file_id` 为空），同样取最新的 `ok` 行。下表“单值”字段取 `store_asset_file.position` 最小、且有这一步结果的文件；“合计”字段按文件累加；没有任何 `ok` 行时为空（数组为 `[]`）。

**StoreAssetCard**（列表卡片）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| storeAssetId | string(uuid) | 是 | 素材 | `store_asset.id` |
| type | enum(同数据模型 `store_asset.type`) | 是 | 素材类型 | `store_asset.type` |
| title | string \| null | 是 | 标题（系统生成，处理完成前可能为空，端上以“类型 + 数量或时长”兜底） | `store_asset.title` |
| displayStatus | enum `AssetDisplayStatus` | 是 | 列表上的单一状态 | 纯函数 `assetDisplayStatus()`（d5-media.md:1787）：未处理完或未复核 → `organizing`；`adopted_count > 0` → `adopted`；否则取可用性 |
| processingState | enum(同数据模型 `store_asset.processing_state`) | 是 | 处理进度 | `store_asset.processing_state` |
| reviewState | enum(同数据模型 `store_asset.review_state`) | 是 | 复核状态 | `store_asset.review_state` |
| usability | enum(同数据模型 `store_asset.usability`) \| null | 是 | 可用性（复核人写） | `store_asset.usability` |
| adoptedCount | integer | 是 | 被采用次数 | `store_asset.adopted_count` |
| moderationState | enum(同数据模型 `store_asset.moderation_state`) | 是 | 内容安全审核 | `store_asset.moderation_state` |
| fileCount | integer | 是 | 文件数（角标“4 张”“2 个文件”） | `store_asset_file` 行数 |
| durationMs | integer \| null | 是 | 单值：首个音视频文件的时长（角标“0:18”） | `media_info.duration_ms`（`position` 最小的音视频文件） |
| pageCount | integer \| null | 是 | 合计：文档页数（“文档 3 页”；多个文档文件时为各文件页数之和） | `kind = 'doc_text'` 洞察的 `content.pageCount`，按文件累加 |
| thumbnail | SignedUrl \| null | 是 | 缩略图：图片取首图，视频取封面；幂等重放时为空（1.1） | `store_asset_file`（`position` 最小）的文件或其 `media_info.cover_file_id` 现签，30 分钟对齐窗口 |
| quote | string \| null | 是 | 引文：文字类取正文；录音、音频取单值转写的摘句，至多 60 字 | `store_asset.text_body`；`kind = 'transcript'` 洞察的 `content.text`（单值） |
| tags | array<AssetTag> | 是 | 卡片标签，至多 4 个：复核确认的优先，其次上传人与机器的内容标签 | `store_asset_tag` |
| techSpecLabel | string \| null | 是 | 单值：技术规格（“竖屏 1080P”） | `kind = 'tech_spec'` 洞察的 `content.label` |
| structuredItemCount | integer \| null | 是 | 合计：提取到的菜品条数（“已提取 12 道菜”） | `kind = 'structured_items'` 洞察的 `content.items` 条数，按文件累加 |
| isSelectableAsReference | boolean | 是 | 能否被订购、广告需求选作参考素材 | 06-media.md:1191 的参考守卫：`deleted_at` 为空、`moderation_state <> 'block'`、`usability` 不是 `need_reshoot` |
| uploader | UploaderView | 是 | 上传人（“阿杰（店员）”） | 2.1 |
| createdAt | string(date-time) | 是 | 上传时间 | `store_asset.created_at` |

**StoreAssetDetail**（详情）= StoreAssetCard 的全部字段，另加：

商家老板与店员的 `same` 表示两者使用相同字段与数据。分析要点统一对外命名为 `highlights`，遵循 C57 的禁用字段规则；后台 a03 的 `keypoints` 与内部洞察的 `content.keypoints` 保持原名，三者承载同一字符串数组。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| textBody | string \| null | 是 | 文字类正文 | `store_asset.text_body` |
| note | string \| null | 是 | 补充说明 | `store_asset.note` |
| files | array<MediaFileView> | 是 | 全部文件，按顺序 | `store_asset_file` 按 `position` |
| transcript | `{ text: string, segments: array<{ fromMs, toMs, text }> }` \| null | 是 | 单值：语音转文字全文与分句（多个音频文件时取第一个，其余文件的转写在 `fileTranscripts`） | `kind = 'transcript'` 洞察的 `store_asset_insight.content`（取法见本节开头） |
| fileTranscripts | array<{ fileId: string(uuid), text: string, segments: array<{ fromMs, toMs, text }> }> | 是 | 按文件的转写，按 `position` 排列；单文件素材与 `transcript` 相同 | 同上，逐文件 |
| highlights | array<string> | 是 | 自动提炼的要点（C57 命名避开积分禁用模式，数组内容不变） | `kind = 'digest'` 洞察的 `content.keypoints` |
| structuredItems | array<{ name: string, priceText: string \| null }> | 是 | 菜单抽取的菜名与价格文字，按文件 `position` 依次拼接 | `kind = 'structured_items'` 洞察的 `content.items`（`price` 改名 `priceText`，A86 放行） |
| isInsightPartial | boolean | 是 | 有理解步骤失败或跳过（详情显示“暂未转写”等） | `store_asset.is_insight_partial` |
| tagsByDimension | `{ content, usage, timeliness }`，各为 array<AssetTag> | 是 | 分维度标签；有复核确认的标签时只给确认的 | `store_asset_tag` |
| reviewedBy | `{ displayName: string }` \| null | 是 | 复核人（“服务经理小林”） | `store_asset.reviewed_by_staff_id` → `staff.display_name`，空时 `staff.name` |
| reviewedAt | string(date-time) \| null | 是 | 复核时间 | `store_asset.reviewed_at` |
| portraitAuth | `{ fileCount: integer, authorizedAt: string(date-time) \| null }` | 是 | 已补交的肖像授权材料份数与确认时间（材料本身不签发） | `store_asset.portrait_auth_file_ids` 的元素数；`store_asset.portrait_authorized_at` |
| assetDemand | `{ assetDemandId, title }` \| null | 是 | 响应的素材需求 | `store_asset.store_asset_demand_id` → `store_asset_demand.title` |
| timeline | array<AssetTimelineEntry> | 是 | 使用记录时间线，按时间正序 | 见下 |
| actions | array<string> | 是 | 可执行动作，取 `portrait-auth`、`feedback`（C12 的单例子资源名） | `portrait-auth`：`usability = 'need_portrait_auth'` 且当前用户是老板或该素材上传人；`feedback`：未删除即有 |

AssetTimelineEntry（原型里“新片尾第 1 版已推送”属于广告自身的进度，不进素材时间线，见第 6 节第 5 项）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| kind | enum `AssetTimelineKind` | 是 | 节点类型 | — |
| at | string(date-time) | 是 | 发生时间 | `uploaded`：`store_asset.created_at`；`processed`：最新 `ok` 的 `digest` 洞察的 `store_asset_insight.created_at`；`reviewed`：`store_asset.reviewed_at`；`used_as_reference`、`adopted`：`store_asset_usage.created_at` |
| actorName | string \| null | 是 | 上传人或复核人称呼 | 同 UploaderView、`reviewedBy` |
| usedBy | `{ type: enum UsedByType, id: string(uuid), no: string }` \| null | 是 | 使用方，只在使用节点有；对外只给商家端可达的两类对象（“用于制作需求 GG…”“用于订购 DD…”） | 见下表 |

使用节点按 `store_asset_usage.role` 区分：`reference` → `used_as_reference`，`adopted` → `adopted`。`usedBy` 按 `store_asset_usage.used_by_type` 换算，单号由路由层经只读查询补齐（media 不读 L3，06-media.md:1800）：先把 `ad_version`、`order_item`、`episode_output` 换算成所属广告或订购单的 id（下表“`usedBy.id`”列），再批量调 `order.getOrderNos(tx, dramaOrderIds)`（m04-mall-order 2.9）与 `ads.getAdNos(adIds)`（m06-ad 第 1 节）取单号：

| `used_by_type` | `usedBy.type` | `usedBy.id` | `usedBy.no` |
| --- | --- | --- | --- |
| `ad` | `ad` | `used_by_id` | `ad.ad_no` |
| `ad_version` | `ad` | `ad_version.ad_id` | `ad.ad_no` |
| `drama_order` | `drama_order` | `used_by_id` | `drama_order.order_no` |
| `order_item` | `drama_order` | `order_item.drama_order_id` | `drama_order.order_no` |
| `episode_output` | `drama_order` | `episode_output.delivery_ticket_id` → `delivery_ticket.drama_order_id` | `drama_order.order_no` |

端上按 `type` 跳到“我的广告”详情或订购单详情；店员没有这两类页面的能力点，只显示文字、不给跳转。

**StoreAssetSummary**

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| tabs | `{ all, image, video, recording, audio, document, text }`，各为 integer | 是 | 类型页签计数（“全部 128、图片 64……”）；键与列表的 `tab` 取值一致（C83） | `store_asset`（`deleted_at` 为空）按 `type` 计数，套用与列表相同的筛选 |
| organizingCount | integer | 是 | 整理中条数（“1 条整理中”） | `displayStatus = 'organizing'` 的条数 |
| adoptedCount | integer | 是 | 被采用过的条数（“8 条被采用”） | `store_asset.adopted_count > 0` 的条数 |
| recent7dCount | integer | 是 | 近 7 天新增 | `store_asset.created_at` 在 7×24 小时内 |
| hotTags | array<{ dimension, tag: DictRef, assetCount }> | 是 | 热门标签，至多 5 个，快捷筛选用 | `store_asset_tag` 按 `(dimension, tag_code)` 统计未删除素材数 |

**AssetDemandItem**

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| assetDemandId | string(uuid) | 是 | 需求 | `store_asset_demand.id` |
| title | string | 是 | 名称（“国庆氛围布置”） | `store_asset_demand.title` |
| shootingNote | string \| null | 是 | 拍摄说明 | `store_asset_demand.shooting_note` |
| dueDate | string(date) | 是 | 完成日期（“10-01 前完成”） | `store_asset_demand.due_date` |
| status | enum(同数据模型 `store_asset_demand.status`) | 是 | 进行中、已完成、已撤销 | `store_asset_demand.status` |
| isOverdue | boolean | 是 | 已逾期（不落库） | `status = 'open'` 且 `due_date` 早于北京时间今天 |
| createdByName | string | 是 | 发起人称呼（“服务经理小林”） | `store_asset_demand.created_by_staff_id` → `staff.display_name`，空时 `staff.name` |
| receivedCount | integer | 是 | 已收到素材条数 | `store_asset` 中 `store_asset_demand_id` 为本需求、未删除的条数 |
| myUploadCount | integer | 是 | 当前用户为本需求上传的条数 | 同上，且上传人是当前用户 |
| createdAt | string(date-time) | 是 | 发起时间 | `store_asset_demand.created_at` |

### 2.8 字典扩展属性：PermitTypeExt、StoreSellingPointExt

这两个字典类型的 `dict_item.ext` 键由本文定，已按 A145 回写数据模型 14 分组（14-config-data.md:1071-1072；播种项 14-config-data.md:136-154），第三轮核对两边一致；m08-support-misc 3.2 引用。Zod schema 放 `packages/contract/config/dict-ext.ts`；下发小程序的白名单键见下表“下发”一栏（m08 的 `m.dictItem.list` 按此过滤）。

**PermitTypeExt**（字典 `permit_type`，每种许可证一项）

| 键 | 类型 | 下发 | 说明 |
| --- | --- | --- | --- |
| fields | array<PermitFieldDef> | 是 | 识别与提交的字段清单，按展示顺序；3.12 的 `recognized`、3.13 的 `fields` 只认这些键 |
| holderNameKey | string | 是 | 哪个键是经营者名称 → `qualification_doc.holder_name` |
| certNoKey | string | 是 | 哪个键是许可证编号 → `cert_no_enc`、`cert_no_bidx`、`cert_no_mask` |
| certNoPattern | string \| null | 是 | 编号格式正则（3.13 的格式校验；比对“许可证编号格式有效”） |
| principalNameKey | string \| null | 是 | 负责人姓名的键 → `principal_name_enc`、`principal_name_mask`；没有为空 |
| validFromKey | string \| null | 是 | 有效期起的键 → `valid_start_date` |
| validToKey | string \| null | 是 | 有效期止的键 → `valid_end_date`（到期提醒） |

PermitFieldDef：`{ key: string（小驼峰）, label: string, sensitive: boolean, format: enum('text','date','cert_no') }`。`sensitive = true` 的键只在 3.12 的首次响应里以明文出现，脱敏视图 `displayFields` 不给（2.6）。

播种值（已登记 14-config-data.md:140、144-154，A145）——食品经营许可证 `food_business`（d5-media.md:1866；04-profile.md:607）：

| key | label | sensitive | format |
| --- | --- | --- | --- |
| `operatorName` | 经营者名称 | false | text |
| `certNo` | 许可证编号 | true | cert_no |
| `premises` | 经营场所 | false | text |
| `businessItems` | 经营项目 | false | text |
| `validTo` | 有效期至 | false | date |

`holderNameKey = 'operatorName'`、`certNoKey = 'certNo'`、`certNoPattern = '^JY[0-9]{14}$'`（食品经营许可证编号“JY + 14 位数字”）、`principalNameKey = null`、`validFromKey = null`、`validToKey = 'validTo'`。

**StoreSellingPointExt**（字典 `store_selling_point`）：`{ categoryCodes: string[] }`，适用的二级品类编码（字典 `industry` 的二级），空数组 = 适用全部品类；下发。端上按门店品类过滤卖点候选（3.6）；3.7 保存时不按品类校验（品类改了，已选卖点不强制清除）。

## 3. 接口

### 3.1 m.storeProfile.get　建档首页
`GET /m/store-profile`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.profile.read`（d4-identity.md:855） |
| 店员视图 | `trimmed`：StoreProfileOverviewClerk（2.2） |
| 幂等 | none（纯查询，GET 不写库，A18、A19） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:Profile、M:StaffProfile、M:Mine（只读资质状态） |
| 出处 | 路线图 `m03.store-profile.get`；d9-profile.md:661；proto-merchant-b.md:22-39、382-395 |

**请求**：路径参数无；查询参数无；请求体无。

**响应**：`data` 为 StoreProfileOverview（老板）或 StoreProfileOverviewClerk（店员），以 `viewerRole` 判别。

**错误**：无（通用错误按约定）。

**副作用**：无（不写库；完整度现算但不在 GET 里写回，C60）。

**说明**：
- 档案行在首次读写时补建（`INSERT … ON CONFLICT DO NOTHING`，04-profile.md:55）属于写，GET 不做；首家门店还没有档案行时按空档案计算完整度并返回，第一次保存（3.3、3.5、3.7、3.10）时补建。
- 素材需求卡不在本接口，老板与店员都调 3.25（原型只在店员视角画了，proto-merchant-b.md:38，老板视角同样要有）；店员“我上传的 N 条 · M 条被采用”取 3.20 的 `uploader=me`。
- 页面提示“修改门店形象、服务与价格……无需重新审核；修改资质、门店名称、门店地址或行业与品类需重新审核”是静态文案。

### 3.2 m.storeProfile.basic.get　基础信息
`GET /m/store-profile/basic`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.profile.read` |
| 店员视图 | `trimmed`：StoreProfileBasicClerk（2.3） |
| 幂等 | none（纯查询） |
| 乐观锁 | 无（响应返回 `lockVersion` 供 3.3 使用） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileBasic、M:StaffProfile（“查看”） |
| 出处 | 路线图 `m03.store-profile-basic.get`；d9-profile.md:662；proto-merchant-b.md:41-56 |

**请求**：无。

**响应**：StoreProfileBasic 或 StoreProfileBasicClerk。

**错误**：无。

**副作用**：无。

**说明**：行业与品类、省市区的名称由服务端随 `DictRef` 带出（C85、A151），生效值或待审值引用了已停用、未开放的项也照常返回名称，端上回显不再另取字典。选择器的候选项由端上调 `m.dictItem.list`（`types=industry,region`，m08-support-misc），缺省只下发可选的项（启用、行业已开放、区划已开通）。

### 3.3 m.storeProfile.basic.update　保存基础信息
`PATCH /m/store-profile/basic`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.profile.edit` |
| 店员视图 | `none`（403 `ROLE_FORBIDDEN`） |
| 幂等 | required（三段式：先只读预检，事务外检测，事务内保存）（带锁的 PATCH，A17） |
| 乐观锁 | 带 `lockVersion`（`store_profile.lock_version`，A21） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileBasic |
| 出处 | 路线图 `m03.store-profile-basic.update`；d9-profile.md:351-361、595、599-600；04-profile.md:335、668；A32 |

**请求体**（`StoreProfileBasicPatch`；PATCH 语义：不传 = 不改，传 `null` = 清空，C38）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| draft | boolean | 是 | — | `true` 只做格式校验（长度、字典、文件归属）；`false` 另校验第 1 步必填（“保存并下一步”） |
| lockVersion | integer | 是 | 等于当前 `store_profile.lock_version` | 首家门店还没有档案行时传 `0` |
| confirmReview | boolean | 否 | 缺省 `false` | 已通过门店改重审字段时的二次确认 |
| brandName | string \| null | 否 | 2–30 字 | → `store_profile.brand_name` |
| logoFileId | string(uuid) \| null | 否 | 分类 `profile_image` | → `store_profile.logo_file_id` |
| storeName | string \| null | 否 | 2–30 字 | 未通过过的门店 → `store.name`（经 `tenant.renameStore`）；已通过门店 → `qualification_submission.proposed_store_name` |
| industryCode | string \| null | 否 | 字典 `industry` 一级、启用且开放（1.1“字典编码”）；与 `categoryCode` 同时传 | 未通过过的门店 → `store_profile.industry_code`；已通过 → `proposed_industry_code` |
| categoryCode | string \| null | 否 | 同一字典的二级，隶属 `industryCode` | → `store_profile.category_code` 或 `proposed_category_code` |
| address | AddressInput \| null | 否 | 键见 AddressInput（2.1）；`provinceCode`、`cityCode`、`districtCode` 须是字典 `region` 已开通的行政区划，三者与 `detail` 同时传；`zoneCode` 须是功能区编码；经纬度成对、在合法范围内 | 未通过过的门店 → `store_profile` 的地址各列；已通过 → 重审的四项写 `proposed_address_snapshot`，选点名称与坐标原地改（不算修改地址，d9-profile.md:595） |
| businessHours | array<BusinessHourSlot> | 否 | 至多 4 段（本稿补充）；每段 `start ≠ end` | → `store_profile.business_hours` |
| storeTel | string \| null | 否 | ≤20 字，手机或座机格式 | → `store_profile.store_tel` |
| avgSpendFen | integer(分) \| null | 否 | ≥0；端上把“元”按字符串换算成分（C31） | → `store_profile.avg_spend_fen` |
| brandIntro | string \| null | 否 | ≤300 字 | → `store_profile.brand_intro` |

**响应**：StoreProfileBasic（老板视图，含新的 `lockVersion`、`pendingChange`（带轮次的新 `lockVersion`）与 `completeness`），另带 `replayed: boolean`（1.1“幂等重放”：重放时 `logo` 的地址为空）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VERSION_CONFLICT` | 409 | `lockVersion` 与库中不一致；`details` 带最新值（C52） |
| `VALIDATION_FAILED` | 400 | `draft = false` 时第 1 步必填缺项（`fieldErrors` 逐项给出）；字典编码不存在；格式不符 |
| `DICT_ITEM_DISABLED` | 409 | 新选的行业、品类或区划已停用（m08 定义；`details.dictTypeKey`、`details.code`） |
| `INDUSTRY_NOT_OPEN` | 409 | 新选的行业或品类未开放、区划未开通（`details.field`、`details.code`） |
| `REVIEW_REQUIRED` | 409 | 已通过门店改了门店名称、地址（省市区或详细地址）、行业与品类，未带 `confirmReview = true`；`details.changedFields` 列出类别 |
| `QUALIFICATION_IN_REVIEW` | 409 | 改了上述重审字段，而门店结论为 `pending`，或有在审的 `change` 轮次（审核期间锁定，d9-profile.md:360） |
| `PROFILE_REQUIRED_MISSING` | 400 | 门店结论不是 `unsubmitted` 时，把已填的必填项改空（d9-profile.md:356） |
| `FILE_NOT_USABLE` | 400 | `logoFileId` 不可用 |
| `CONTENT_REJECTED` | 400 | 品牌名称、门店名称、简介、详细地址未通过文本内容安全检测；`details.fields` 列出命中的字段路径（如 `address.detail`） |
| `PROVIDER_UNAVAILABLE` | 503 | 文本内容安全检测服务不可用（C27，可重试）；不写库（A137） |

**副作用**：
- 三段式（C51）：先占用幂等记录并只读预检，事务外调文本内容检测，末个事务锁行重读全部守卫后保存；完成的同键重放不再检测，服务不可用时拒收且不写业务数据；失败与 BUSY 后续做沿统一 runner。
- 状态迁移：无（档案行与 `store` 的名称都不是状态列）。
- 写 `store_profile` 的上述列与 `last_edited_at`、`last_edit_actor_type = 'merchant'`、`last_edit_actor_id`、`last_edit_client = 'weapp'`，`lock_version + 1`，完整度三列重算写回。
- 未通过过的门店（`unsubmitted`、`rejected`）改名：同事务经 `tenant.setStoreName` 写 `store.name`；仅 `unsubmitted` 的草稿可在必填守卫后经 `tenant.clearDraftStoreName` 清为真实 `null`。先锁门店行再锁档案行（d9-profile.md:750）。
- 已通过门店带 `confirmReview = true` 且重审字段有变化：`ensureDraft`（规则见 3.9）取或建 `kind = 'change'` 的草稿轮次（新建时带入该门店全部生效的门店级证照为 `carried` 行，d9-profile.md:283），锁轮次行，只写本次有变化的 `proposed_*` 类别，`qualification_submission.lock_version + 1`（草稿编辑递增，04-profile.md:290）；生效值不动。锁顺序：轮次 → 档案行（补 04-profile.md:668 指出的这条路径）。草稿新建不是状态机迁移，不写 `status_transition`。
- `file_ref`：新 Logo `files.link(store_profile / logo)`；被替换的 Logo `files.release`，保留 30 天（04-profile.md:648）。
- `audit_log` activity 流一行，记改了哪些字段（前后值，敏感字段脱敏）。
- 出站事件 `store.profile.changed { storeId, entityId, fields, source: 'merchant' }`：只在生效值有变化时发（d9-profile.md:704）；只写进 `change` 草稿的待审值不发。
- 埋点 `profile_step_save` 由端上在成功后上报（`m.analyticsEvent.batchCreate`，d6-notify-docs-data.md:1835）。

**说明**：
- 只存草稿，不提交：草案的 `submitNow` 作废（A32；04-profile.md:335），提交一律走 3.17。
- 重审字段的判定：门店名称变化；省、市、区或详细地址任一变化；行业或品类变化。只改选点名称或坐标不算修改地址（d9-profile.md:595）。功能区 `zoneCode` 只是标注，不触发重审（04-profile.md:68）。
- 地图选点由端上 `wx.chooseLocation` 带回，服务端只按 `region` 字典校验，不做逆地理编码（d9-profile.md:788 C17）。
- 营业时间按时段数组存，原型的单个文本框需按时段升级（d9-profile.md:778 C7）；时段数上限、是否分星期见第 6 节第 2 项。

### 3.4 m.storeProfile.media.get　门店形象
`GET /m/store-profile/media`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.profile.read` |
| 店员视图 | `trimmed`：StoreProfileMediaClerk（2.4） |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileStore、M:StaffProfile（“查看”） |
| 出处 | 路线图 `m03.store-profile-media.get`；d9-profile.md:663；proto-merchant-b.md:58-70 |

**请求**：无。

**响应**：StoreProfileMedia（老板）或 StoreProfileMediaClerk（店员），以 `viewerRole` 判别（2.4）。图片与视频地址随响应现签（C60）。

**错误**：无。

**副作用**：无。

**说明**：被内容安全拦截的文件（`moderationState = 'block'`）仍在列表里，端上提示替换；它不计入完整度（档案媒体被拦截时 profile 订阅 `file.moderated` 重算完整度，04-profile.md:684）。

### 3.5 m.storeProfile.media.update　保存门店形象
`PATCH /m/store-profile/media`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.profile.edit` |
| 店员视图 | `none` |
| 幂等 | required（A17；路线图原标 false，复核意见 18） |
| 乐观锁 | 带 `lockVersion`（`store_profile.lock_version`） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileStore |
| 出处 | 路线图 `m03.store-profile-media.update`；d9-profile.md:663；04-profile.md:159-163；design-spec.md:856；A35 |

**请求体**（`StoreProfileMediaPatch`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| draft | boolean | 是 | — | `false` 时另校验门头 ≥1、店内环境 ≥3 |
| lockVersion | integer | 是 | 等于当前 `store_profile.lock_version` | — |
| groups | object | 是 | 至少含一组；键取 `door`、`interior`、`product`、`promo` | 传了的组整组覆盖，没传的组不改 |
| groups.\<组\> | array<{ fileId: string(uuid) }> | — | 数组顺序即组内顺序；同组文件不重复；上限：门头 3、店内环境 9、实拍图片 9 且视频 3、宣传素材 9（04-profile.md:163）；门头与店内环境只收图片 | 分类见 1.1 的表 |

**响应**：StoreProfileMedia（老板视图），另带 `replayed: boolean`（1.1“幂等重放”：重放时各文件的地址为空，端上重拉 3.4）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VERSION_CONFLICT` | 409 | 锁版本不符 |
| `VALIDATION_FAILED` | 400 | 数量超上限；`draft = false` 时门头或环境不足；门头、环境组里出现视频 |
| `PROFILE_REQUIRED_MISSING` | 400 | 门店结论不是 `unsubmitted` 时把门头或环境减到下限以下 |
| `FILE_NOT_USABLE` | 400 | 文件不可用或分类不符 |

**副作用**：
- 状态迁移：无。
- `store_profile_media`：组内仍在的文件只改 `position`；新文件插入新行（`create_actor_type = 'merchant'`、`create_actor_id`、`create_client = 'weapp'`，`media_kind` 按文件推出）；被去掉的行写 `removed_at`。替换文件 = 移除旧行、另起新行（`file_id` 不可改，04-profile.md:203）。
- `file_ref`：新行 `files.link(store_profile_media / main)`；移除的行 `files.release`，保留 30 天。
- `store_profile`：`lock_version + 1`、最近修改四列、完整度三列。
- `audit_log` activity 流；出站事件 `store.profile.changed { source: 'merchant' }`。

**说明**：
- 受平台约束（design-spec.md:856；A35）：小程序内视频上限真机验证前按 100MB 写且可配（参数 `upload.weapp_video_max_mb`，A107 补登），超限在上传登记 `m.file.create` 就返回 `FILE_TOO_LARGE`（m08 定义，`details.canDelegate = true` 时提示由服务经理在后台代传），本接口收到的都是已入库的文件；电脑端上传是 V1.1。原型“每条不超过 60 秒、200MB”中的时长由端上 `chooseMedia` 的 `maxDuration` 限制，服务端在 `media_info` 已探测时复核，未探测时不拦。
- 门头照“宽度不低于 1080 像素”只提示不拦截（端上 `wx.getImageInfo` 判断，响应的 `displayWidth` 供回看时提示）。

### 3.6 m.storeProfile.service.get　服务与价格
`GET /m/store-profile/service`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.profile.read` |
| 店员视图 | `trimmed`：StoreProfileServiceClerk（2.5）；现价、原价保留（A86 放行） |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileService、M:StaffProfile（“查看”） |
| 出处 | 路线图 `m03.store-profile-service.get`；d9-profile.md:664、801 ⑦；proto-merchant-b.md:72-85 |

**请求**：无。

**响应**：StoreProfileService（老板）或 StoreProfileServiceClerk（店员），以 `viewerRole` 判别（2.5）。

**错误**：无。

**副作用**：无。

**说明**：卖点候选取字典 `store_selling_point`，由端上调 `m.dictItem.list`，按 `ext.categoryCodes` 与门店品类过滤（2.8；14-config-data.md:113）。首页摘要的“主推菜品 5 项”是行业文案，端上按行业映射。

### 3.7 m.storeProfile.service.update　保存服务与价格
`PATCH /m/store-profile/service`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.profile.edit` |
| 店员视图 | `none` |
| 幂等 | required（三段式：先只读预检，事务外检测，事务内保存） |
| 乐观锁 | 带 `lockVersion`（`store_profile.lock_version`） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileService |
| 出处 | 路线图 `m03.store-profile-service.update`；d9-profile.md:664；04-profile.md:213-254、715；PRD.md:436-444 |

**请求体**（`StoreProfileServicePatch`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| draft | boolean | 是 | — | `false` 时另校验主推服务 ≥1 项、卖点 ≥1 个 |
| lockVersion | integer | 是 | — | 档案行锁版本 |
| serviceItems | array<ServiceItemInput> | 否 | 0–10 项；传了即整组覆盖 | 数组顺序即排列顺序 |
| serviceItems[].serviceItemId | string(uuid) | 否 | 本门店在用的行 | 带它即原地更新该行，不带即新增 |
| serviceItems[].name | string | 是 | 1–30 字（上限待确认，d9-profile.md:780 C9） | → `store_service_item.name` |
| serviceItems[].priceFen | integer(分) | 是 | >0 | → `store_service_item.price_fen` |
| serviceItems[].originalPriceFen | integer(分) \| null | 否 | ≥ `priceFen` | → `store_service_item.original_price_fen` |
| serviceItems[].imageFileId | string(uuid) \| null | 否 | 分类 `profile_image` | → `store_service_item.image_file_id` |
| serviceItems[].intro | string \| null | 否 | ≤20 字 | → `store_service_item.intro` |
| promoText | string \| null | 否 | ≤100 字（本稿补充） | → `store_profile.promo_text` |
| groupBuyText | string \| null | 否 | ≤100 字（本稿补充） | → `store_profile.group_buy_text` |
| sellingPointCodes | array<string> | 否 | 0–5 个、不重复，字典 `store_selling_point`；新选的须启用（1.1“字典编码”），不按品类校验（2.8） | → `store_profile.selling_point_codes` |
| sellingNote | string \| null | 否 | ≤100 字 | → `store_profile.selling_note` |

**响应**：StoreProfileService（老板视图），另带 `replayed: boolean`（1.1“幂等重放”：重放时服务图片的地址为空，端上重拉 3.6）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VERSION_CONFLICT` | 409 | 锁版本不符 |
| `VALIDATION_FAILED` | 400 | 超过 10 项或 5 个卖点；原价低于现价；`draft = false` 时缺服务或卖点；`serviceItemId` 不是本门店在用的行；卖点编码不存在 |
| `DICT_ITEM_DISABLED` | 409 | 新选的卖点已停用（m08 定义） |
| `PROFILE_REQUIRED_MISSING` | 400 | 门店结论不是 `unsubmitted` 时把主推服务或卖点清空 |
| `FILE_NOT_USABLE` | 400 | 服务图片不可用 |
| `CONTENT_REJECTED` | 400 | 服务名称、简介、优惠、团购、补充说明未通过文本内容安全检测；`details.fields` 列出命中的字段路径（如 `serviceItems.2.name`） |
| `PROVIDER_UNAVAILABLE` | 503 | 文本内容安全检测服务不可用（C27，可重试）；不写库（A137） |

**副作用**：
- 三段式（C51）：先占用幂等记录并只读预检，事务外调文本内容检测，末个事务锁行重读全部守卫后保存；完成的同键重放不再检测，服务不可用时拒收且不写业务数据；失败与 BUSY 后续做沿统一 runner。
- 状态迁移：无。
- `store_service_item`：带 `serviceItemId` 的行原地更新名称、价格、图片、简介、`position`；新项插入；未出现在数组里的在用行写 `removed_at`。
- `file_ref`：新图片 `files.link(store_service_item / image)`；被替换或随行移除的图片 `files.release`，保留 30 天。
- `store_profile`：上述列、`lock_version + 1`、最近修改四列、完整度三列。
- `audit_log` activity 流；出站事件 `store.profile.changed { source: 'merchant' }`。

**说明**：
- 主推服务的名称与现价在库里是必填列，没填齐的服务项不落库，由端上保留（04-profile.md:715 第 3 项默认做法）；`draft = true` 时也要求每项有名称与现价。
- “广告风格偏好”“禁用内容”是 V1.1 字段（PRD.md:443-444，原型置灰），V1.0 不收，请求里出现即被剥离（C38）。
- 页面提示“价格变动不会自动更新已确认的广告”与 PRD.md:464 一致，接口不联动广告。

### 3.8 m.storeProfile.qualification.get　当前资质视图
`GET /m/store-profile/qualification`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.profile.read` |
| 店员视图 | `trimmed`：QualificationViewClerk（只有状态） |
| 幂等 | none（纯查询） |
| 乐观锁 | 无（响应带轮次与档案行的 `lockVersion`） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileCert、M:ProfileReview（含“刷新审核状态”）、M:StaffProfile（“查看”）、M:Mine |
| 出处 | 路线图 `m03.qualification.get`；d9-profile.md:665、374、409-413；复核意见 7；d4-identity.md:1735 |

**请求**：无。

**响应**：QualificationView（老板）或 QualificationViewClerk（店员）。

**错误**：无。

**副作用**：无。不签发证照图片地址（证照图片须逐次留痕，走 3.15）。

**说明**：
- 联系人随本接口返回（`contact`），不另开读取接口（复核意见 7）。
- 审核结果页（M:ProfileReview）的数据：门店结论与 `openRound`（审核中，带 `submittedAt`、`dueAt`）、`lastClosedRound`（未通过：`rejectReasons`、`decisionNote`、`docs` 里 `verdict = 'rejected'` 的证照）。“刷新审核状态”即重拉本接口；时间线走 3.18。
- 新增门店（主体已认证）第 4 步的“营业执照”项沿用主体执照：`effectiveDocs` 里给出主体生效的营业执照行（只读参考），完整度把主体类型与营业执照两项视为已填（d9-profile.md:374）。
- 店员视角第 4 步的“查看”只显示状态（d9-profile.md:783 C12）。

### 3.9 m.storeProfile.qualification.update　保存资质草稿
`PATCH /m/store-profile/qualification`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.qualification.edit` |
| 店员视图 | `none` |
| 幂等 | required（A17） |
| 乐观锁 | 带 `lockVersion`（草稿的 `qualification_submission.lock_version`）；当前没有草稿时传 `null` |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileCert |
| 出处 | 路线图 `m03.qualification.update`；d9-profile.md:357、666；04-profile.md:290、343 |

**请求体**（`QualificationDraftPatch`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| lockVersion | integer \| null | 是 | 有草稿时等于其 `lock_version`；无草稿时为 `null` | 端上看到“无草稿”而服务端已有草稿 → `VERSION_CONFLICT` |
| claimedEntityType | enum(`enterprise`、`individual`) \| null | 否 | — | → `qualification_submission.claimed_entity_type`；含营业执照的轮次要填：`initial`，以及更换主体营业执照的 `change`（本轮有未移除的 `business_license` 行，04-profile.md:333）；`new_store` 与不换执照的 `change` 忽略 |
| declarationConfirmed | boolean | 否 | — | `true` → 写 `declaration_confirmed_at`（当前时刻）与 `declaration_version`；`false` → 两列清空 |
| declarationVersion | string | 条件必填 | `declarationConfirmed = true` 时必填，须等于现行版本 | → `qualification_submission.declaration_version` |

**响应**：QualificationView（老板视图）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VERSION_CONFLICT` | 409 | 锁版本不符 |
| `QUALIFICATION_IN_REVIEW` | 409 | 有在审轮次（`ensureDraft` 规则） |
| `QUALIFICATION_CLOSED` | 409 | 门店已被终局驳回，不能再建草稿 |
| `ENTITY_NOT_VERIFIED` | 409 | 主体未认证且本店不是首家门店（d9-profile.md:357、781 C10） |
| `DECLARATION_REQUIRED` | 400 | `declarationVersion` 缺失或不是现行版本；`details.currentVersion` 给出现行版本 |

**副作用**：
- 状态迁移：无。没有草稿时按下面的 `ensureDraft` 规则新建草稿轮次；草稿新建与字段保存都不写 `status_transition`。
- `qualification_submission.lock_version + 1`；`audit_log` activity 流。
- 完整度：同一事务按锁顺序（轮次 → 档案行）锁 `store_profile`，重算并写回完整度三列（1.1“完整度缓存”；主体类型、信息确认都是第 4 步的必填项）。

**`ensureDraft(tx, storeId)` 规则**（3.3 的 `change` 草稿、本接口、3.12 共用；d9-profile.md:357、283）：

1. 该门店有未关闭、未提交的轮次 → 用它（锁轮次行）。
2. 有在审轮次 → `QUALIFICATION_IN_REVIEW`。
3. 门店已被终局驳回（`store_profile.final_rejected_at` 非空）→ `QUALIFICATION_CLOSED`。
4. 否则新建一行 `qualification_submission`（`created_by_user_id` 为当前用户），类型与带入按门店结论：

| 门店结论 | `kind` | 带入的证照（`carried` 行） | `resubmit_of_qualification_submission_id` | `claimed_entity_type` |
| --- | --- | --- | --- | --- |
| `verified` | `change` | 该门店全部生效的门店级证照（`scope = 'store'`、`effective_at` 非空、`superseded_at` 为空；d9-profile.md:283） | 空 | 空（更换主体营业执照时由本接口填） |
| `rejected`（非终局） | 主体已认证 → `new_store`；主体未认证且本店是首家门店 → `initial`；否则 `ENTITY_NOT_VERIFIED` | 来源轮次里未移除、`verdict` 不是 `rejected` 的行；新轮次类型不许有的证照（`new_store` 的营业执照）不带入 | 来源轮次的 id | 取来源轮次的值 |
| `unsubmitted` | 同上一行 | 不带入 | 空 | 空 |

- **来源轮次**：该门店最近一轮 `outcome = 'rejected'` 的轮次（按 `submitted_at` 倒序取第一条）。`discarded`、`withdrawn` 的轮次跳过——草稿被丢弃、或在审被系统撤回（门店结论退回 `rejected`）之后再建草稿，仍从最近一次被驳回的那一轮带入。
- `resubmit_of_qualification_submission_id` 在防改触发器 `trg_qualification_submission_immutable` 里（04-profile.md:329），只能在这条 `INSERT` 里写；3.17 的提交 `UPDATE` 不再碰它。审核队列的“重新提交”与审核记录的“重新提交审核”（`QualificationRound.isResubmit`、`QualificationRecord.isResubmit`）都取这一列。
- `carried` 行：`carried_from_qualification_doc_id` 指向来源行，同一文件、同一 `ocr_result_id`，提交值、修正值与派生列照抄，`verdict` 为空；每张带入的文件 `files.link(qualification_doc / main)`。
- 信息确认不带入，每轮重新勾选（04-profile.md:277）。

**说明**：信息确认每轮重新勾选；提交时 3.17 的请求体必须再带一次（04-profile.md:335），本接口保存的勾选只用于草稿回显。

### 3.10 m.storeProfile.contact.update　保存资质联系人
`PATCH /m/store-profile/contact`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.qualification.edit` |
| 店员视图 | `none` |
| 幂等 | required（三段式：先只读预检，事务外检测，事务内保存）（A17；原路线图“覆盖写”取消） |
| 乐观锁 | 带 `lockVersion`（`store_profile.lock_version`） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileCert |
| 出处 | 路线图 `m03.store-profile-contact.update`；d9-profile.md:131-133、357、667、777 C6；04-profile.md:83-87；A25、A48；C40 |

**请求体**（`ContactPatch`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| lockVersion | integer | 是 | — | 档案行锁版本 |
| name | string | 是 | 1–20 字（本稿补充） | → `store_profile.contact_name` |
| phoneSource | enum(`login`、`input`) | 是 | 本接口不收 `store_contact`（A25） | `login` 取登录手机号；`input` 另传号码 |
| phone | string | 条件必填 | `input` 时必填，11 位手机号 `^1\d{10}$` | 明文只在本次请求里出现 |
| smsCode | string | 条件必填 | `input`、号码不是登录手机号、且短信验证可用时必填；6 位数字 | 由 3.11 发到该号码 |

**响应**：ContactView。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VERSION_CONFLICT` | 409 | 锁版本不符 |
| `VALIDATION_FAILED` | 400 | 手机号格式不对；短信验证可用时缺 `smsCode` |
| `SMS_CODE_INVALID` | 400 | 验证码错误、已过期、已用过或已作废（m01 定义）；`details.attemptsLeft` 为剩余次数，没有可用的验证码时为 0 |
| `CONTENT_REJECTED` | 400 | 联系人姓名未通过文本内容安全检测（`details.fields = ["name"]`） |
| `PROVIDER_UNAVAILABLE` | 503 | 文本内容安全检测服务不可用（C27，可重试）；不写库、不核销验证码（A137） |

**副作用**：
- 三段式（C51）：先占用幂等记录并只读预检，事务外调文本内容检测，末个事务锁行重读全部守卫后保存；完成的同键重放不再检测，服务不可用时拒收且不写业务数据；失败与 BUSY 后续做沿统一 runner。
- 状态迁移：无。
- 写 `store_profile.contact_name`，以及手机号三件套与来源：`login`（或 `input` 的号码就是登录手机号）→ 按 `merchant_user.phone_enc` 的列 AAD 解密当前用户手机号，再按 `store_profile.contact_phone_enc` 的列 AAD 重新加密写入 `contact_phone_enc`，脱敏串写 `contact_phone_mask`（密文不能跨列 AAD 复用），`contact_phone_source = 'login'`，`contact_phone_verified_at` 为空；`input` 且验证码通过 → `sms_verified`，写 `contact_phone_verified_at`；`input` 且短信验证不可用 → `unverified`。
- 核销验证码（同 m01 3.7 的写法）：取当前用户、`purpose = 'contact_phone'`、`phone_bidx` 为新号码盲索引的最新一条 `sms_verification`，要求 `used_at` 为空、未过期、`attempts < 5`；相符则在主事务里写 `used_at`。不符时 `attempts + 1` 在**独立短事务**里提交后再返回 `SMS_CODE_INVALID`（主事务回滚不能带走计数）；累计 5 次该行作废，须重新获取（02-identity-tenant.md:355）。
- `store_profile.lock_version + 1`、最近修改四列、完整度三列；`audit_log` activity 流（手机号只记脱敏串）。

**说明**：
- 联系人存 `store_profile`、不进审核，不调用 `ensureDraft`：审核期间与终局驳回之后都能改，不会被 `QUALIFICATION_IN_REVIEW` 挡住（d9-profile.md:357）；在审轮次的 `contact_snapshot` 不随之改变。
- 联系人手机号 V1.0 不作为审核结果与交付通知的接收号码（d9-profile.md:777 C6）；原型“用于接收审核结果与交付通知”的文案待改。
- 端上只有脱敏串，不能把默认号码回填后提交，所以用 `phoneSource` 表达（C40）。

### 3.11 m.storeProfile.contactSmsCode.create　资质联系人手机号发码
`POST /m/store-profile/contact/sms-codes`

> 按裁决 A48 补的路由，第二轮已登记进路线图切片；资源登记表 `sms_verification` 一项已有别名 `/m/store-profile/contact/sms-codes`。`m.smsCode.create` 只管换绑手机号。

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.qualification.edit`（A48） |
| 店员视图 | `none` |
| 幂等 | required（有发短信副作用，C47）；三段式“先落库、提交后直发”（C51、A84），步骤见副作用；成功后重放返回上次结果，不重发 |
| 乐观锁 | 无 |
| 限流 | `m.sms`（C68：每号码 60 秒 1 次、每小时 5 次、每天 10 次，号码维度由 `notify.sendDirect` 按投递表计数；每 IP 20 次 / 小时）＋ `m.global`（02-identity-tenant.md:357） |
| 开关 | 短信通道未配置或验证码模板停用时返回 `SMS_UNAVAILABLE`，端上改按“未验证”保存（3.10；`ContactView.isSmsVerifyAvailable` 预先给出） |
| 对应画板 | M:ProfileCert（手机号“更换”） |
| 出处 | A48；d9-profile.md:667；02-identity-tenant.md:324-359；d4-identity.md:2094 |

**请求体**（`ContactSmsCodeBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| phone | string | 是 | 11 位手机号 | 目标号码 |

**响应**（`ContactSmsCodeResult`）：

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| isLoginPhone | boolean | 否 | 号码就是登录手机号：不发码，3.10 直接按 `login` 保存 |
| expiresAt | string(date-time) | 是 | 验证码过期时间（`sms_verification.expires_at`，默认 5 分钟）；不发码时为空 |
| resendAfterSec | integer | 是 | 多少秒后可重发（60）；不发码时为空 |

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 号码格式不对 |
| `SMS_UNAVAILABLE` | 503 | 短信通道未配置、验证码模板停用，或发送时通道故障（m01 定义，与 m01 3.6 同一出口，不再用 `PROVIDER_UNAVAILABLE`）。发送失败时本行已删、占用已释放，用户稍后可用同一个键重试；端上也可改按“未验证”保存 |
| `RATE_LIMITED` | 429 | 号码维度或 IP 维度限频（带 `Retry-After`） |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | 同一个键的前一次请求还在发送中（可重试，C27） |

**副作用**（三段式，同 m01 的 `m.smsCode.create`）：
- 状态迁移：无。
- ① 占用幂等记录（`in_progress`，30 秒）；号码是登录手机号时不发码，直接落幂等记录并返回 `isLoginPhone = true`。
- ② 事务：插入 `sms_verification`（`purpose = 'contact_phone'`、`merchant_user_id`、`phone_bidx`、`code_hash`、`expires_at` = 现在 + 5 分钟、`attempts = 0`），只存哈希，提交。
- ③ 事务外调 `notify.sendDirect`（`purpose = verify_code`、`direct_key = sms_verification:{id}`），写 13 分组的 `notification_delivery`；成功才把幂等记录落为成功。发送抛错（限频返回 `RATE_LIMITED`，通道故障返回 `SMS_UNAVAILABLE`）时删除②插入的那行（免得它成为“最新一条”挡住上一条仍有效的验证码，02-identity-tenant.md:357）并释放占用。
- 不写出站事件，明文不落任何表。

**说明**：只有老板能改联系人，所以发码也只对老板开放；路由带门店上下文与能力点，不再由服务层另断言（`m.smsCode.create` 只接受 `purpose = phone_change`，A48）。

### 3.12 m.qualificationDoc.create　证照挂到草稿并识别回显
`POST /m/qualification-docs`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.qualification.edit`（证照仅老板，d5-media.md:1017） |
| 店员视图 | `none` |
| 幂等 | required（避免重复识别与重复证照行）；三段式“先调外部、再开事务”（C51，A139 已登记），步骤见副作用；结果脱敏（C50、A80）：重放时 `recognized`、`submitted` 为空、`replayed = true`，不再识别 |
| 乐观锁 | 不带（该迁移的守卫没有列锁版本，A21）；成功后轮次 `lock_version + 1`，响应返回新值 |
| 限流 | `m.global`；识别另有每门店每日 20 次上限（d5-media.md:1871），到上限不报错，按识别不可用处理 |
| 开关 | 证照识别按证照类型开关（d5-media.md:1869），关闭时 `ocrStatus = 'unavailable'`，商家手填 |
| 对应画板 | M:ProfileCert（上传、重新上传）、M:ProfileReview（就地补传被驳回的证照） |
| 出处 | 路线图 `m03.qualification-doc.create`；d9-profile.md:358、668；d5-media.md:1815-1871；04-profile.md:385-485、628-629 |

**请求体**（`QualificationDocCreateBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| fileId | string(uuid) | 是 | 当前用户上传、已入库、未被拦截；分类与登记范围按 `docType`（与 m08 上传登记的 `licenseKind` 一致，04-profile.md:628）：`business_license` 为 `kyc_license`，`file_object.scope_type = 'entity'` 且 `entity_id` 为当前主体；`branch_license` 为 `kyc_license`、`industry_permit` 为 `kyc_permit`，两者 `scope_type = 'store'` 且 `store_id` 为当前门店 | → `qualification_doc.file_id` |
| docType | enum(同数据模型 `qualification_doc.doc_type`) | 是 | — | → `qualification_doc.doc_type`；`scope` 由它推出（营业执照属主体，其余属门店） |
| permitType | string | 条件必填 | `industry_permit` 时必填，字典 `permit_type` 的编码，新选的须启用（1.1“字典编码”）；其余类型不传 | → `qualification_doc.permit_type` |

**响应**：QualificationDocRecognized（2.6，含 `replayed`）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `FILE_NOT_USABLE` | 400 | 文件不可用（`reason = not_stored`、`blocked`）；分类与证照类型不符（`category_mismatch`）；登记范围不符，如营业执照文件不是主体级、分支机构执照或许可证不是本门店登记的（`scope_mismatch`） |
| `VALIDATION_FAILED` | 400 | `permitType` 缺失、多余或不在字典里 |
| `DICT_ITEM_DISABLED` | 409 | `permitType` 已停用（m08 定义） |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | 同一个键的前一次请求还在识别中（可重试，C27） |
| `QUALIFICATION_IN_REVIEW` | 409 | 有在审轮次 |
| `QUALIFICATION_CLOSED` | 409 | 门店已被终局驳回 |
| `ENTITY_NOT_VERIFIED` | 409 | 主体未认证且本店不是首家门店 |
| `QUALIFICATION_DOC_NOT_ALLOWED` | 409 | 轮次类型不允许这种证照：`new_store` 轮次不能有营业执照（沿用主体执照，d9-profile.md:276） |
| `ENTITY_LICENSE_CHANGE_PENDING` | 409 | `change` 草稿里挂营业执照，而同一主体另一家门店已有更换主体营业执照的 `change` 轮次在审（M108，04-profile.md:333） |

**副作用**（三段式，C51“先调外部、再开事务”）：
- ① 占用幂等记录（`in_progress`，30 秒），同键并发得到 `IDEMPOTENCY_IN_PROGRESS`。随后做只读预检：`ensureDraft` 的前置条件（在审、终局驳回、主体未认证）、`docType` 与轮次类型、`permitType`、文件可用性与登记范围；不通过直接返回错误、释放占用，不去识别（不浪费识别次数）。
- ② 事务外识别：复用键为（`ocr_result.file_id`，映射后的 `doc_type`，`permit_type`）——分支机构执照映射为 `business_license`（用营业执照的识别驱动）；许可证还要 `permit_type` 相同（04-profile.md:401）。已有 `status = 'ok'` 的结果取最新一行直接复用；否则在开关打开、未到每门店每日上限（参数 `ocr.daily_limit_per_store`，A107）、Provider 已配置时同步识别（超时 6 秒），在独立短事务里写一行 `ocr_result`（`entity_id`、`store_id` = 当前门店、`file_id`、`doc_type`、`permit_type`、`status`、`fields_enc`、`warnings`、`request_actor_type = 'merchant'`、`request_actor_id`、`request_client = 'weapp'`）。识别不可用不写行。
- ③ 事务（先锁轮次行）：`ensureDraft`（规则见 3.9，事务内再判一次）；本轮同类（`doc_type` 与 `permit_type` 相同）未移除的行写 `removed_at`，其文件引用 `files.release`，保留 7 天；插入新行（`origin = 'uploaded'`、`ocr_result_id`、`uploaded_by_user_id`；识别成功时把归一化后的识别值作为初始提交值写 `submitted_fields_enc`，并重写派生列 `holder_name`、`cert_no_enc`、`cert_no_bidx`、`cert_no_mask`、`principal_name_enc`、`principal_name_mask`、`principal_role`、`subject_type`、`valid_start_date`、`valid_end_date`、`is_long_term`，许可证按 `PermitTypeExt` 的键映射，2.8）；`files.link(qualification_doc / main)`（挂到草稿行时就登记，04-profile.md:651）；轮次 `lock_version + 1`；锁 `store_profile` 重算完整度三列（1.1“完整度缓存”）；幂等记录随本事务落为成功，只存去掉 `recognized`、`submitted` 的结果。
- 可续做：③失败时释放占用；②已写的 `ocr_result` 是技术结果、不回滚，同键重试或换键重传同一文件都复用它，不重复识别、不重复计入每日上限。
- 状态迁移（证照行没有状态列，按 04-profile.md:474-483 的阶段表）：`qualification_doc`（同类旧行）：草稿中 → 已移除（重新上传同类证照，04-profile.md:478）。
- `audit_log` access 流一行（回显了证照明文，d9-profile.md:322）。

**说明**：
- 识别值、提交值、审核员修正值分三处存（d5-media.md:1843）。识别成功后商家只需核对，有误时调 3.13 修改，或重新上传；识别不可用时 `submitted` 为空，商家须经 3.13 手填，否则提交校验第 4 项不通过。
- 重放：`replayed = true` 时 `doc`、`lockVersion`、`entityTypeCheck` 照常可用，识别是否可用看 `doc.ocrStatus`，不得因 `recognized` 为空按“识别不可用”转手填。需要明文核对时，端上换新键重调本接口（复用已有识别结果，同类旧行按“重新上传”移除）。
- 主体类型与识别类型矛盾时提交被阻断（3.17 第 5 项），本接口只在 `entityTypeCheck` 里提示，不拦。
- 草案写作 `POST /m/stores/{id}/qualification/docs`（d5-media.md:2094），门店改取请求头。

### 3.13 m.qualificationDoc.update　保存核对后的证照提交值
`PATCH /m/qualification-docs/{qualificationDocId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.qualification.edit` |
| 店员视图 | `none` |
| 幂等 | required |
| 乐观锁 | 带所属轮次的 `lockVersion`（`qualification_submission.lock_version`；证照行没有锁列，轮次是证照行的聚合根，04-profile.md:258、290） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileCert；识别有误的人工修正出口原型没有（05-risks-and-open-issues.md:272 列为原型遗漏） |
| 出处 | 路线图 `m03.qualification-doc.update`；d9-profile.md:669、785 C14；d5-media.md:1836 |

**请求**：路径参数 `qualificationDocId`（uuid）。请求体（`QualificationDocPatch`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| lockVersion | integer | 是 | 等于所属轮次的锁版本 | — |
| fields | object | 是 | 键按证照类型：营业执照与分支机构执照为 `name`、`uscc`、`principal`、`principalRole`、`subjectType`、`validFrom`、`validTo`（日期或 `long_term`）、`address`、`businessScope`；许可证为该许可证类型 `PermitTypeExt.fields` 的键（2.8）。只传要改的键，不传 = 不改 | 合并进 `qualification_doc.submitted_fields_enc`（明文结构见 04-profile.md:598-607）；`uscc` 校验 18 位与校验位；许可证编号按 `certNoPattern`、日期类键按 `format = 'date'` 校验 |

**响应**（`QualificationDocUpdateResult`）：`{ qualificationSubmissionId, lockVersion, doc: QualificationDoc }`（脱敏视图）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VERSION_CONFLICT` | 409 | 轮次锁版本不符 |
| `VALIDATION_FAILED` | 400 | 字段键不属于该证照类型；格式不符（信用代码、日期） |
| `QUALIFICATION_IN_REVIEW` | 409 | 所属轮次已提交、在审 |
| `STATE_NOT_ALLOWED` | 409 | 行已移除、所属轮次已关闭，或是 `carried` 行（带入的证照不能改值，要改须重新上传） |
| `NOT_FOUND` | 404 | 行不存在或不属于当前门店 |

**副作用**：
- 状态迁移：无。
- 重写 `qualification_doc.submitted_fields_enc` 与全部派生列（同 3.12）；轮次 `lock_version + 1`。
- `audit_log` activity 流（前后值脱敏）。

**说明**：只有本轮草稿里 `origin = 'uploaded'` 的行能改。提交后比对项 C6“商家修改过识别值”会把改过的字段名提示给审核员（d5-media.md:1882）。

### 3.14 m.qualificationDoc.remove　从草稿移除证照
`POST /m/qualification-docs/{qualificationDocId}/remove`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.qualification.edit` |
| 店员视图 | `none` |
| 幂等 | required（A17；原路线图“天然幂等”取消） |
| 乐观锁 | 不带（迁移守卫没有列锁版本） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileCert |
| 出处 | 路线图 `m03.qualification-doc.delete`；d9-profile.md:669；04-profile.md:478；A7 |

**请求**：路径参数 `qualificationDocId`；请求体无。

**响应**（`QualificationDocRemoveResult`）：`{ qualificationDocId, removedAt: string(date-time), qualificationSubmissionId, lockVersion }`（`qualification_doc.removed_at`、轮次新锁版本）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `QUALIFICATION_IN_REVIEW` | 409 | 所属轮次在审 |
| `STATE_NOT_ALLOWED` | 409 | 行已移除，或所属轮次已关闭 |
| `NOT_FOUND` | 404 | 行不存在或不属于当前门店 |

**副作用**：
- 状态迁移：`qualification_doc`：草稿中 → 已移除（从草稿移除，04-profile.md:478）。
- 写 `qualification_doc.removed_at`；`files.release(qualification_doc / main)`，保留 7 天（04-profile.md:651）；轮次 `lock_version + 1`；`audit_log` activity 流。
- 完整度：锁 `store_profile`（轮次 → 档案行）重算并写回完整度三列（1.1“完整度缓存”）。

**说明**：证照行不物理删除（A7）。`carried` 行也能移除（如品类变了、不再要求的许可证）；移除的是本轮的带入行，来源行与其文件引用不受影响。

### 3.15 m.qualificationDoc.downloadUrls　签发证照图片读地址
`POST /m/qualification-docs/{qualificationDocId}/download-urls`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.qualification.edit`（证照图片仅老板可取，d4-identity.md:1735） |
| 店员视图 | `none` |
| 幂等 | none（签发短时地址，结果不进幂等记录，A18、A19） |
| 乐观锁 | 无 |
| 限流 | `m.sign`（签发类档位，每用户每小时 600 次，d5-media.md:2036；A130，已按 operationId 登记在 C68）＋ `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileCert、M:ProfileReview（查看证照图片） |
| 出处 | 路线图 `m03.qualification-doc.download-urls`（本轮补）；A19；C60、C61；d4-identity.md:1735 |

**请求**：路径参数 `qualificationDocId`；请求体 `{}`（每张证照只有一张图）。

**响应**：SignedUrl（有效期 5 分钟，C61）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 行不存在、已移除，或不属于当前门店（本主体生效的营业执照行除外） |

**副作用**：`audit_log` access 流一行（`target_type = 'qualification_doc'`）。不改业务数据，不是状态迁移。

**说明**：可取的行：当前门店的草稿、在审与生效证照；本主体生效的营业执照（`scope = 'entity'`，新增门店“沿用主体执照”时查看）。

### 3.16 m.storeProfile.qualification.discard　丢弃资质草稿
`POST /m/store-profile/qualification/discard`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.qualification.edit` |
| 店员视图 | `none` |
| 幂等 | required（A17） |
| 乐观锁 | 不带（丢弃的守卫为“无”，04-profile.md:344）；请求体带草稿 id 防止误丢 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileCert（原型没有画“放弃变更”入口） |
| 出处 | 路线图 `m03.qualification.discard`；d9-profile.md:603、671；04-profile.md:344、479 |

**请求体**（`QualificationDiscardBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| qualificationSubmissionId | string(uuid) | 是 | 等于当前草稿的 id | — |

**响应**：QualificationView（老板视图）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `QUALIFICATION_IN_REVIEW` | 409 | 该轮已提交、在审 |
| `STATE_NOT_ALLOWED` | 409 | 当前没有草稿，或 id 不是当前草稿，或是 `initial` 草稿（商家只能丢弃 `change` / `new_store` 草稿） |

**副作用**：
- 状态迁移：`qualification_submission`：草稿 → 已关闭（`discarded`，04-profile.md:344）；`qualification_doc`：草稿中 → 已移除（所属草稿被丢弃，04-profile.md:479）。
- 写 `qualification_submission.closed_at`、`outcome = 'discarded'`；本轮未移除的证照行写 `removed_at`，文件引用 `files.release`，保留 7 天。
- 不写 `status_transition`（轮次表没有状态列）；`audit_log` activity 流一行。
- 完整度：第 4 步的“当前资质视图”回到生效轮次或最近一轮，锁 `store_profile`（轮次 → 档案行）重算并写回完整度三列（1.1“完整度缓存”）。

**说明**：草案写作 `DELETE /profile/qualification/draft`；丢弃是轮次的阶段变化、不删行，按动作接口写（A7）。商家入口仅接受 `change` / `new_store` 的未提交草稿，初次草稿由原建档链继续处理；系统生命周期订阅的初次草稿丢弃不受此入口限制。丢弃 `change` 草稿后，基础信息的待审值随之作废，生效值不变。

### 3.17 m.storeProfile.qualification.submit　提交资质审核
`POST /m/store-profile/qualification/submit`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.qualification.edit`（只有老板能提交，d9-profile.md:470） |
| 店员视图 | `none` |
| 幂等 | required |
| 乐观锁 | 不带（提交的守卫是十项提交校验，没有列锁版本，04-profile.md:343）；请求体带草稿 id |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileCert（“提交审核”）、M:ProfileReview（“重新提交审核”） |
| 出处 | 路线图 `m03.qualification.submit`；A32、A41；d9-profile.md:464-499、5.2；04-profile.md:333-362；02-identity-tenant.md:540、622-627；03-staff-authz-audit.md:804；d6-notify-docs-data.md:858 |

**请求体**（`QualificationSubmitBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| qualificationSubmissionId | string(uuid) | 是 | 等于当前草稿的 id | 首次、驳回后重新提交、已通过后的变更都走这里 |
| declarationConfirmed | boolean | 是 | 必须为 `true` | → `qualification_submission.declaration_confirmed_at`（04-profile.md:335） |
| declarationVersion | string | 是 | 等于现行版本 | → `qualification_submission.declaration_version` |

**响应**：QualificationView（老板视图；`openRound.phase = 'in_review'`，带 `submittedAt`、`dueAt`）。

**错误**（按 d9-profile.md:468-479 的十项校验顺序，另加 M108 与变更无内容两项）：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `STATE_NOT_ALLOWED` | 409 | 当前没有草稿，或 id 不是当前草稿 |
| `STORE_PROFILE_INCOMPLETE` | 409 | 第 2 项：四步必填未齐（`change` 轮次只查前三步与变更后的证照）；`change` 轮次有未移除的 `business_license` 行（更换主体营业执照）而 `claimed_entity_type` 为空，缺项记 `{ step: 4, item: 'entity_type' }`（04-profile.md:333）；`details.missing` 列出缺项 |
| `INDUSTRY_NOT_OPEN` | 409 | 第 3 项：行业或品类未开放、区划未开通 |
| `QUALIFICATION_DOCS_INCOMPLETE` | 409 | 第 4 项：本轮证照不符清单（d9-profile.md:271-281），或有证照没有提交值；或被驳回的证照没补齐——`resubmit_of` 指向的来源轮次里每个 `verdict = 'rejected'` 的（`doc_type`，`permit_type`），本轮都要有 `origin = 'uploaded'`、未移除的同类行（状态机 `rejected → pending` 的守卫“被驳回的证照已补齐”，02-identity-tenant.md:625；分支机构执照、品类未要求的许可证被点名驳回时靠这一条拦住），缺的列在 `details.rejectedNotReplaced` |
| `ENTITY_TYPE_MISMATCH` | 409 | 第 5 项：所选主体类型与营业执照识别出的类型矛盾（识别不可用或 `unknown` 不拦）；`initial` 与更换主体营业执照的 `change` 轮次都比 |
| `DECLARATION_REQUIRED` | 400 | 第 6 项：未勾选信息确认，或版本不是现行版本 |
| `CONTACT_PHONE_UNVERIFIED` | 409 | 第 7 项：联系人手机号不是登录手机号也未通过短信验证（短信未配置时放行并记 `unverified`） |
| `USCC_TAKEN` | 409 | 第 8 项：本轮营业执照的信用代码已属其他已认证主体（`tenant.findVerifiedEntityByUsccBidx`） |
| `ENTITY_NOT_VERIFIED` | 409 | 第 9 项：主体未认证且本店不是首家门店 |
| `QUALIFICATION_IN_REVIEW` | 409 | 第 10 项：门店已有在审轮次 |
| `QUALIFICATION_CLOSED` | 409 | 门店已被终局驳回（d9-profile.md:528） |
| `ENTITY_LICENSE_CHANGE_PENDING` | 409 | M108：本轮是更换主体营业执照的 `change` 轮次，而同一主体已有另一轮这样的 `change` 在审 |
| `QUALIFICATION_NO_CHANGE` | 409 | `change` 轮次相对生效值没有任何变化（`changed_fields` 为空） |

**副作用**（一个事务；锁顺序：轮次 → 主体（仅 `initial`）→ 门店，d9-profile.md:466）：
- 状态迁移：
  - `qualification_submission`：草稿 → 在审（提交，04-profile.md:343）。用一条 `UPDATE` 同时写 `round_no`、`submitted_at`、`submitted_by_user_id`、填全的 `proposed_*`、`changed_fields`（`change` 轮次）、`contact_snapshot`、`declaration_confirmed_at`、`declaration_version`、`approval_request_id`（04-profile.md:335；d9-profile.md:486）。`resubmit_of_qualification_submission_id` 已在建草稿时写好（3.9），这里不写。
  - `approval_request.status`：（新建）→ `pending`（`submit`，03-staff-authz-audit.md:804）：`kind = 'qualification'`、`category = 'review'`、`subject_type = 'store'`、`subject_id` = 门店、`entity_id`、`store_id`、`round_no`、`dedupe_key = 'qualification:{storeId}'`、`submit_actor_type = 'merchant'`、`submit_actor_id`、`submit_client = 'weapp'`、`submitted_at`；`due_at` 与 `sla_snapshot` 按参数 `sla.review.qualification`（默认 1 个工作日）算；`summary_snapshot` 由 profile 注册的处理器生成（04-profile.md:637），取值：`title` = 送审门店名称（`proposed_store_name`）；`lines`（已脱敏的展示键值，供 a03 审核队列）依次为“门店”（`proposed_store_name`）、“主体”（`initial` 取本轮营业执照的 `holder_name`，其余取 `entity.name`）、“品类”（`proposed_industry_code`、`proposed_category_code` 的字典名称，如“餐饮 / 火锅”）、“区域”（`proposed_address_snapshot` 的省市区名称）、“提交类型”（首次认证、新增门店或变更重审，`change` 轮次附 `changed_fields` 的中文名，重新提交时附“重新提交”）；`domain = { type: 'qualification_submission', id }`。不放证照号、手机号等明文（03-staff-authz-audit.md:948）。
  - `store.qualification_status`：`unsubmitted` → `pending`、`rejected` → `pending`（`qualification.submit`，02-identity-tenant.md:622、625）；`change` 轮次 `verified` → `verified`（`qualification.change_submit`，02-identity-tenant.md:627）。
  - `entity.verification_status`：`unsubmitted` 或 `rejected` → `pending`（`qualification.submit`，仅 `initial` 轮次，02-identity-tenant.md:540）。
  - 以上经 `flow.transition()` 各写一行 `status_transition`（门店 `machine = 'store'`、`state_field = 'qualification_status'`；主体 `machine = 'entity'`、`state_field = 'verification_status'`；审批单 `machine = 'approval_request'`），并各补一行 `audit_log`。
- 比对：调 `ocr.runFieldChecks` 在“修正值，否则提交值”上逐张比对，写各证照行的 `qualification_doc.field_checks` 与轮次的 `check_summary`、`checks_ran_at`（d9-profile.md:484）。
- `store_profile.first_submitted_at`（首次提交时）。
- 定时器：审批单的决定时限 `sla.breach:approval_request:{approvalRequestId}:decision`（由 approval 在提交时登记，01-kernel-flow.md:603；x01 4.1）。
- 出站事件（载荷以 x01 第 3 节为准）：
  - 门店一侧：`initial`、`new_store` 轮次发 `store.qualification.submitted { storeId, entityId, submissionId, kind, roundNo }`；`change` 轮次发 `store.qualification_change.submitted { storeId, entityId, submissionId, changedFields }`（04-profile.md:640；d9-profile.md:699、703）。
  - 审批单一侧：`approval.submitted { approvalRequestId, kind: 'qualification', category: 'review', subjectType: 'store', subjectId, entityId, storeId, roundNo, ＋迁移键 }`（x01 3.3，03-staff-authz-audit.md:804）；`notify.onEvent` 据此给有决定权的审核员发 `s.approval_pending`。审批单与领域行是不同的事实，各发各的（x01 第 2.4 节 E2）。
- 埋点：`kind = 'new_store'` 且 `round_no = 1` 时同事务直记 `store_add_submit`（`analytics_event`，`source = 'direct'`，属性取 `store_profile.copied_from_store_id`、`copy_options`，14-config-data.md:771）。`profile_submit` 由 `store.qualification.submitted` 派生，只计 `initial`（d9-profile.md:488）。

**说明**：
- 提交是资质审核的唯一入口（A32、A41）；保存基础信息只存 `change` 草稿。路径保留 `/m/store-profile/qualification/submit`（A41；A32 原文写 `/m/qualification/submit`，约定第 15 节第 14 项）。
- 订阅消息：端上在点击“提交审核”的同步调用链里请求点位 `profile_submit`（槽位 `review_result`，d6-notify-docs-data.md:858），结果经 `m.subscribeResult.create` 上报，不在本接口里。
- 审核结果页（M:ProfileReview）的“重新提交审核”：原型只看补传是否完成，页面上没有信息确认勾选（ProfileReview.dc.html:50、110-111）。按 d9-profile.md:792 C21，这一页须补“信息确认”勾选，版本号取 3.8 的 `declaration.currentVersion`，点击时带 `declarationConfirmed = true` 与 `declarationVersion`；原型按此修改，否则会被 `DECLARATION_REQUIRED` 拦住。“重新提交审核”按钮在被驳回的证照都补传之后才可点（与 `details.rejectedNotReplaced` 同口径）。
- 信用代码命中其他**在审**主体时允许提交，不改对方的行，重复标记读时派生（d9-profile.md:477）。
- V1.0 不提供商家撤回在审轮次（d9-profile.md:360、817 Q5）。

### 3.18 m.qualificationSubmission.list　历次审核记录
`GET /m/qualification-submissions`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `store.qualification.edit`（仅老板；d4 没有单列“资质记录查看”的能力点，沿用它） |
| 店员视图 | `none` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:ProfileReview（审核记录时间线） |
| 出处 | 路线图 `m03.qualification-submission.list`；d9-profile.md:530、672；proto-merchant-b.md:113、118 |

**请求**：查询参数：

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| cursor | string | 否 | 不透明 | 首页不传（C42） |
| limit | integer | 否 | 1–50，默认 20 | — |

**响应**：`CursorPage<QualificationRecord>`（C42 的通用结构，C87），即 `{ items: array<QualificationRecord>, nextCursor: string | null, hasMore: boolean }`，按提交时间倒序，只含已提交的轮次（草稿与 `discarded` 不出现）。游标分页、不返回总数（C42）。

QualificationRecord：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| qualificationSubmissionId | string(uuid) | 是 | 轮次 | `qualification_submission.id` |
| kind | enum(同数据模型 `qualification_submission.kind`) | 是 | 轮次类型 | `qualification_submission.kind` |
| roundNo | integer | 是 | 轮次号 | `qualification_submission.round_no` |
| isResubmit | boolean | 是 | “重新提交审核” | `resubmit_of_qualification_submission_id` 非空 |
| submittedAt | string(date-time) | 是 | 提交时间 | `qualification_submission.submitted_at` |
| uploadedDocs | array<{ docType, permitType: DictRef \| null }> | 是 | 本轮新上传的证照（“重新上传食品经营许可证”） | 本轮 `origin = 'uploaded'`、未移除的 `qualification_doc` |
| changedFields | array<enum> | 是 | `change` 轮次改了哪几类 | `qualification_submission.changed_fields` |
| outcome | enum(同数据模型 `qualification_submission.outcome`) \| null | 是 | 结论；在审为空 | `qualification_submission.outcome` |
| decidedAt | string(date-time) \| null | 是 | 决定时间 | `approval_request.decided_at` |
| isDecidedBySystem | boolean | 是 | 系统驳回或撤回 | `approval_request.is_decided_by_system` |
| rejectReasons | array<DictRef> | 是 | 驳回原因 | 同 2.6 |
| decisionNote | string \| null | 是 | 驳回说明 | `approval_request.decision_note` |
| rejectedDocs | array<{ qualificationDocId, docType, permitType: DictRef \| null }> | 是 | 被点名驳回的证照 | 本轮 `verdict = 'rejected'` 的行 |
| systemRejectCode | enum \| null | 是 | 系统驳回原因 | `qualification_submission.system_reject_code` |
| finalRejectedAt | string(date-time) \| null | 是 | 终局驳回时间 | `qualification_submission.final_rejected_at` |

**错误**：无。

**副作用**：无。

**说明**：时间线“提交 → 未通过 → 重新提交 → 通过”由端上把每条记录拆成提交与决定两个节点。草案写作 `GET /profile/qualification/rounds`。

### 3.19 m.storeAsset.list　门店素材列表
`GET /m/store-assets`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `asset.read` |
| 店员视图 | `same`（老板与店员都能看本店全部素材，d4-identity.md:858） |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:AssetLib（含触底加载、下拉刷新）、M:Profile、M:StaffProfile（“我上传的”）、M:Checkout 与 M:Ads（参考素材选择器） |
| 出处 | 路线图 `m03.asset.list`；d5-media.md:2093；06-media.md:1147、1152、1191；proto-merchant-b.md:275-293；A5、A24 |

**请求**：查询参数：

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| tab | enum(`all`、`image`、`video`、`recording`、`audio`、`document`、`text`) | 否 | 默认 `all` | 类型页签（A24） |
| status | string | 否 | 逗号分隔的 `AssetDisplayStatus` | 快捷筛选“可直接使用、已采用、整理中” |
| tag | string | 否 | 逗号分隔的 `asset_tag` 编码 | 标签筛选（“国庆”“菜品与产品”）；多值取并集 |
| q | string | 否 | 1–30 字 | 关键词：标题、标签、转写摘录、上传人（`store_asset.search_text` 三元组检索，06-media.md:1152） |
| uploader | enum(`me`) | 否 | — | 只看当前用户上传的 |
| isSelectableAsReference | boolean | 否 | — | `true` 时只返回卡片字段 `isSelectableAsReference` 为真的素材（选择器用；参数名与 DTO 字段同名，C45） |
| assetDemandId | string(uuid) | 否 | 本门店的需求 | 只看响应某条需求的素材 |
| ids | string | 否 | 逗号分隔的 uuid，1–20 个；不能与其他筛选、`sort`、`cursor` 同用 | 按 id 回显（已选参考素材、m05 方案里参考素材的缩略图）：按 `ids` 的顺序返回，`hasMore = false`；已删除或不属于本门店的 id 静默略过，端上以调用方给的标题兜底显示“素材已删除” |
| sort | enum(`-createdAt`) | 否 | 默认 `-createdAt` | 按上传时间倒序（C44） |
| cursor、limit | — | 否 | 同 3.18 | 游标分页 |

**响应**：`CursorPage<StoreAssetCard>`（`{ items, nextCursor, hasMore }`）。只含 `store_asset.deleted_at` 为空的素材。不返回总数，页签计数与“共 N 条 · 平台已整理 M 条”走 3.20（A23）。

**错误**：无。

**副作用**：无。缩略图随列表现签（C60）。

**说明**：
- 作为订购与广告需求的参考素材选择器时带 `isSelectableAsReference=true`：排除需补拍、被拦截与已删除的（06-media.md:1191）；“需肖像授权”的可作参考（授权前仅供方案参考，不用于成片）。筛选与卡片字段用 media 的同一个守卫函数，m04、m06 写入参考素材时也调它（素材未删除、`moderation_state <> 'block'`、`usability` 不是 `need_reshoot`），缩略图规则同 StoreAssetCard（图片取首图、视频取封面，30 分钟对齐窗口）。广告还可以选档案媒体（`profile_image`、`profile_video`、`profile_promo`，m06 的 `AdReferenceKind = profile_media`），它们取自 3.4，不在本列表。参考素材写入订购单、广告的 `store_asset_usage` 与 `file_ref`，在 m04、m06 的接口里做。
- “用于新的制作需求”只在端上跨页携带已选素材，不调接口（proto-merchant-b.md:335）。

### 3.20 m.storeAsset.summary　素材库计数
`GET /m/store-assets/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `asset.read` |
| 店员视图 | `same` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:AssetLib（页签计数、“共 128 条 · 平台已整理 127 条，1 条整理中”、快捷筛选）、M:StaffProfile 与 M:Main（“我上传的 56 条 · 8 条被采用”） |
| 出处 | 路线图 `m03.asset.facets`；A23、C83；复核意见 10 |

**请求**：查询参数与 3.19 相同（含 `isSelectableAsReference`），去掉 `tab`、`ids`、`sort`、`cursor`、`limit`。

**响应**：StoreAssetSummary（2.7）。带 `uploader=me` 时各计数只算当前用户上传的。

**错误**：无。

**副作用**：无。

**说明**：
- 热门标签不是页签计数，但同为按筛选条件的聚合，随本接口一起返回，省一次请求（路线图备注允许另取，本文取合并）。字面段先于 `/{storeAssetId}` 注册（A8）。
- 按标签计数：带 `tag=<编码>` 时 `tabs.all` 即该标签的素材数。M:StoreAdd 的“品牌故事素材 N 条”由端上以来源门店为 `X-Store-Id`、带 `tag=brand_story` 调本接口（m02-tenant 3.3 的请求；“品牌故事”是字典 `asset_tag` 的固定播种编码，`ext.dimension = 'content'`，A145；14-config-data.md:141）。

### 3.21 m.storeAsset.get　素材详情
`GET /m/store-assets/{storeAssetId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `asset.read` |
| 店员视图 | `same` |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:AssetDetail |
| 出处 | 路线图 `m03.asset.get`；d5-media.md:1772-1787、2093；proto-merchant-b.md:324-340；A4、A33 |

**请求**：路径参数 `storeAssetId`（uuid）。

**响应**：StoreAssetDetail（2.7）。文件地址随详情现签（素材不需逐次留痕，C60）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 素材不存在、已删除或不属于当前门店 |

**副作用**：无。

**说明**：
- 转写、要点是机器生成的文字，端上在旁边标注“系统自动整理，仅供参考”，措辞由法务定、放配置（d5-media.md:1809）。
- “标签有误？去反馈”改调 3.24，不再跳客服中心提工单（A33）。
- 肖像授权材料（`portrait_auth` 分类，secure 桶，读取须留痕）不在详情里签发，只返回份数与确认时间。

### 3.22 m.storeAsset.create　上传素材
`POST /m/store-assets`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `asset.upload`（老板、店员都有；已停用门店没有） |
| 店员视图 | `same` |
| 幂等 | required；`Idempotency-Key` 同时写入 `store_asset.idempotency_key`，由 `uq_store_asset_store_id_idempotency_key` 兜底（06-media.md:1136、1145） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:AssetUpload、M:StaffProfile（上传入口与“去拍摄”）、M:Profile（6 类快捷入口） |
| 出处 | 路线图 `m03.asset.create`；d5-media.md:1017、1705-1750、2093；06-media.md:1178-1184；PRD.md:724-735；d6-notify-docs-data.md:872、1841；A35 |

**请求体**（`StoreAssetCreateBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| type | enum(同数据模型 `store_asset.type`) | 是 | — | → `store_asset.type` |
| fileIds | array<string(uuid)> | 条件必填 | `image`、`video`、`audio`、`document` 1–9 个；`recording` 恰 1 个（一次录音一段，≤5 分钟）；`text` 不传；同一请求内不重复；分类 `store_asset`、当前用户在本门店上传 | → `store_asset_file`（数组顺序即 `position`） |
| textBody | string | 条件必填 | `text` 时必填，1–500 字；其余不传 | → `store_asset.text_body` |
| contentTagCodes | array<string> | 否 | 0–8 个、不重复；字典 `asset_tag` 且 `ext.dimension = 'content'`；须启用（1.1“字典编码”） | → `store_asset_tag`（`source = 'uploader'`） |
| note | string | 否 | ≤200 字；`text` 类型不收 | → `store_asset.note` |
| assetDemandId | string(uuid) | 否 | 本门店的素材需求 | → `store_asset.store_asset_demand_id` |

**响应**：StoreAssetCard（`processingState` 为 `pending` 或 `processing`，`displayStatus = 'organizing'`），另带 `replayed: boolean`（1.1“幂等重放”：重放时 `thumbnail` 为空）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `ASSET_UPLOAD_GATED` | 409 | 店员在资质审核通过前的新增门店上传（d5-media.md:1017；PRD 第 6.16.1 节第 3 条） |
| `FILE_NOT_USABLE` | 400 | 文件不可用、分类不是 `store_asset`、不是当前用户在本门店上传的（`scope_mismatch`）、同一请求内重复（`duplicate`）、扩展名与类型不符（`ext_mismatch`） |
| `VALIDATION_FAILED` | 400 | 文件数与类型不符；正文或说明超长；标签编码不存在或不在内容维度；`assetDemandId` 不是本门店的需求 |
| `DICT_ITEM_DISABLED` | 409 | 选的内容标签已停用（m08 定义） |

**副作用**：
- 状态迁移（`store_asset` 的处理进度是技术状态，不写 `status_transition`，06-media.md:73）：`store_asset.processing_state`：— → `pending`（创建素材，06-media.md:1182）；同事务创建了第一个理解任务时 `pending` → `processing`（06-media.md:1183）。
- 插入 `store_asset`：`review_state = 'unreviewed'`、`upload_actor_type = 'merchant'`、`upload_actor_id`、`upload_client = 'weapp'`、`upload_actor_role`（当前角色快照）、`moderation_state = 'none'`、`due_at` 与 `sla_snapshot`（参数 `sla.review.store_asset`，默认 1 个工作日）、`search_text`（上传人与标签，处理完成后重建）。
- 插入 `store_asset_file`、上传人标签 `store_asset_tag`；`files.link(store_asset / main)`。
- 按 `nextAssetSteps()` 同事务插入 `media_job`（`parent_type = 'store_asset'`；图片审核与识图、视频体检与转写、录音转写、文档抽文本、文字审核，最后汇总打标，d5-media.md:1711-1745）。
- 定时器：登记 `sla.breach`，键 `sla.breach:store_asset:{storeAssetId}`，`fire_at = store_asset.due_at`（复核时限，M22；01-kernel-flow.md:608；x01 4.1）。`admin.storeAsset.review` 与素材删除按同一个键取消。
- 埋点 `asset_upload` 同事务直记（`analytics_event`，`source = 'direct'`，一次提交一条，带类型、数量、上传人角色、是否响应需求，d6-notify-docs-data.md:1841）。
- `audit_log` activity 流一行。不发出站事件（处理完成后由 worker 发 `asset.processed`、`asset.review_needed`）。

**说明**：
- 店员上传的闸门：门店是首家门店或资质已通过（`store.is_primary`，或 `store.qualification_status = 'verified'`）才放行；判定经 `StoreGatePort`（06-media.md:1814）。老板不受此限。上传登记 `m.file.create` 对 `store_asset` 分类做同样的判定。
- 超过小程序上传上限的视频由服务经理在后台代传（A35），在上传登记就返回统一引导，不到本接口；电脑端上传是 V1.1。
- 店员提交时端上请求订阅点位 `asset_upload`（d6-notify-docs-data.md:872）。
- 标题由系统生成，上传表单没有标题字段（proto-merchant-b.md:291）。
- 素材需求已完成或已撤销时仍可关联（记录响应了哪条需求），不报错。
- 音频、文档按原型是可追加的文件列表（“从微信聊天中选择音频 / 文件”可多次添加，AssetUpload.dc.html:42-43、114-116），一条素材可含 1–9 个文件；理解任务逐文件建，卡片与详情的单值字段（时长、引文、技术规格、`transcript`）取第一个文件，页数与菜品条数按文件累加，详情另给逐文件转写 `fileTranscripts`（2.7）。录音一次只录一段。

### 3.23 m.storeAsset.portraitAuth.create　补交肖像授权材料
`POST /m/store-assets/{storeAssetId}/portrait-auth`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `asset.upload`；处理器另判定：老板，或该素材的上传人（06-media.md:1188） |
| 店员视图 | `same` |
| 幂等 | required（往数组追加文件，重试会重复追加，复核意见 47） |
| 乐观锁 | 不带（“补交授权材料”的守卫没有列锁版本，06-media.md:1188） |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:AssetDetail（原型没有入口，按本接口补“补交授权材料”按钮） |
| 出处 | 路线图 `m03.asset.submit-portrait-auth`；06-media.md:1126-1127、1188、1615；PRD.md:732；A26 |

**请求**：路径参数 `storeAssetId`。请求体（`PortraitAuthBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| fileIds | array<string(uuid)> | 是 | 1–9 个，分类 `portrait_auth`，当前用户在本门店上传；追加后总数不超过 20（本稿补充） | 追加到 `store_asset.portrait_auth_file_ids` |

**响应**：StoreAssetDetail，另带 `replayed: boolean`（1.1“幂等重放”：重放时文件地址与缩略图为空，端上重拉 3.21）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 素材不存在、已删除或不属于当前门店 |
| `ASSET_PORTRAIT_AUTH_FORBIDDEN` | 403 | 当前用户不是老板，也不是该素材的上传人 |
| `STATE_NOT_ALLOWED` | 409 | 素材的可用性不是“需肖像授权”（未复核、已确认授权或其他结论） |
| `FILE_NOT_USABLE` | 400 | 文件不可用或分类不是 `portrait_auth` |
| `VALIDATION_FAILED` | 400 | 文件数超限 |

**副作用**：
- 状态迁移：`store_asset.usability`：`need_portrait_auth` 不变（补交授权材料，06-media.md:1188）；素材进入“待确认授权”的派生队列（`usability = 'need_portrait_auth'` 且有材料），由交付经理在后台确认（`admin.storeAsset.confirmPortraitAuth`，a03-merchant）。
- 锁素材行后追加 `store_asset.portrait_auth_file_ids`（去重）；`files.link(store_asset / portrait_auth)`；`audit_log` activity 流。

**说明**：路径由 `…/submit-portrait-auth` 改为单例名词子资源 `…/portrait-auth`，与后台员工代交同名（C12、A26）。肖像授权材料怎么收、留多久待法务（06-media.md:1878 第 5 项；第 6 节第 7 项）。

### 3.24 m.storeAsset.feedback.create　素材反馈
`POST /m/store-assets/{storeAssetId}/feedback`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `asset.feedback`（A87 增补表：老板 ✔、店员 ✔、已停用门店 ✘；登记为 d4 能力点表待回写） |
| 店员视图 | `same`（A33） |
| 幂等 | required（写审计并发通知） |
| 乐观锁 | 无 |
| 限流 | `m.global`。另有业务上限：同一用户对同一素材每天（北京时间）至多 5 次（本稿补充），超出返回 409 `ASSET_FEEDBACK_DAILY_LIMIT`，不用 429（429 只给限流，A76） |
| 开关 | 无 |
| 对应画板 | M:AssetDetail（“标签有误？去反馈”） |
| 出处 | 路线图 `m03.asset.feedback`；A33、A56；复核意见 11 |

**请求**：路径参数 `storeAssetId`。请求体（`AssetFeedbackBody`）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| content | string | 是 | 1–200 字 | 反馈内容 → `audit_log.reason_text` |
| dimension | enum(`content`、`usage`、`timeliness`、`usability`) | 否 | — | 认为哪一维标签有误 → `audit_log.meta` |

**响应**：`data = null`（C21）。

**错误**：

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 素材不存在、已删除或不属于当前门店 |
| `ASSET_FEEDBACK_DAILY_LIMIT` | 409 | 当前用户今天对这条素材的反馈已满 5 次（按 `audit_log` 计：同一操作人、同一素材、北京时间当天的反馈行） |

**副作用**：
- 状态迁移：无。不建表（A56）。
- `audit_log` activity 流一行（`target_type = 'store_asset'`，`reason_text` 为反馈内容）。
- 出站事件 `asset.feedback_submitted { storeAssetId, storeId, entityId, actorRole }`（x01 3.6，聚合 `store_asset`；载荷不带反馈正文，正文只进审计），通知模块据此提醒门店的交付经理（`store.delivery_manager_id`；为空时按待分配规则发给交付主管）。

**说明**：店员仍不能提客服工单（d4-identity.md:869）；店员进入客服中心只看到服务经理名片与在线客服入口（A33）。

### 3.25 m.assetDemand.list　素材需求
`GET /m/asset-demands`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `member`；能力点 `asset.demand.read` |
| 店员视图 | `same`（字段相同；行按 `notify_scope` 过滤，见说明） |
| 幂等 | none（纯查询） |
| 乐观锁 | 无 |
| 限流 | `m.global` |
| 开关 | 无 |
| 对应画板 | M:StaffProfile（素材需求卡）、M:Profile（老板视角同样要有，原型遗漏）、M:Main（店员首页） |
| 出处 | 路线图 `m03.asset-demand.list`；06-media.md:1391-1445；PRD.md:731；d7-platform.md:693 |

**请求**：查询参数：

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| status | string | 否 | 逗号分隔的 `open`、`done`、`canceled`；默认 `open` | 字段筛选，不是页签 |
| cursor、limit | — | 否 | 同 3.18 | 游标分页 |

**响应**：`CursorPage<AssetDemandItem>`（`{ items, nextCursor, hasMore }`），`status = open` 时按 `due_date` 升序，其余按发起时间倒序。

**错误**：无。

**副作用**：无。

**说明**：
- 上传时带 `assetDemandId` 即响应需求（3.22）。“已收到 N 条”由素材行计数，不存列（06-media.md:1410）。
- `notify_scope = 'owner_only'` 的需求不出现在店员的列表里（本稿补充，见第 6 节第 4 项）。
- 商家端接口表草案未列，本行按路线图补。

## 4. 枚举

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `store.qualification_status` | 同数据模型 `store.qualification_status` | `unsubmitted`、`pending`、`verified`、`rejected` |
| `entity.verification_status` | 同数据模型 `entity.verification_status` | 同上四值 |
| `qualification_submission.kind` | 同数据模型 | `initial`、`new_store`、`change` |
| `qualification_submission.claimed_entity_type` | 同数据模型 | `enterprise`、`individual` |
| `qualification_submission.changed_fields`（元素） | 同数据模型 | `store_name`、`address`、`industry`、`docs`、`entity_license`；`REVIEW_REQUIRED` 的 `details.changedFields` 只取前三个 |
| `qualification_submission.outcome` | 同数据模型 | `approved`、`rejected`、`withdrawn`、`discarded` |
| `qualification_submission.system_reject_code` | 同数据模型 | `duplicate_entity` |
| `qualification_doc.doc_type` | 同数据模型 | `business_license`、`branch_license`、`industry_permit` |
| `qualification_doc.scope`、`origin`、`principal_role`、`subject_type`、`verdict` | 同数据模型同名列 | 见 04-profile.md:524-529 |
| `PhoneVerifyState`（`ContactView.phoneVerifyState`、`contactSnapshot.phoneVerifyState`） | 同数据模型 `store_profile.contact_phone_source` | `login`、`sms_verified`、`unverified`。与请求里的 `phoneSource`（A25：`login`、`input`）不是一个枚举 |
| `store_profile_media.media_group` | 同数据模型 | `door`、`interior`、`product`、`promo`；请求体 `groups` 的键与之相同 |
| `store_profile_media.media_kind` | 同数据模型 | `image`、`video` |
| `store_asset.type` | 同数据模型 | `image`、`video`、`recording`、`audio`、`document`、`text`；列表 `tab` 另加 `all` |
| `store_asset.processing_state`、`review_state`、`usability`、`moderation_state` | 同数据模型同名列 | 见 06-media.md:1561-1566、1533 |
| `store_asset_tag.dimension`、`source` | 同数据模型同名列 | `content`、`usage`、`timeliness`；`auto`、`uploader`、`reviewer` |
| `store_asset_usage.used_by_type` | 同数据模型 | `ad`、`drama_order`、`order_item`、`ad_version`、`episode_output`；不直接出接口，换算成 `UsedByType`（2.7） |
| `UsedByType`（接口枚举） | `ad`、`drama_order` | 素材使用方，只取商家端可达的两类对象 |
| `store_asset_demand.status` | 同数据模型 | `open`、`done`、`canceled` |
| `file_object.moderation_state` | 同数据模型 | `none`、`pending`、`pass`、`review`、`block` |
| `StepState`（接口枚举） | `not_started`、`in_progress`、`completed` | 建档每步状态（d9-profile.md:376） |
| `RoundPhase`（接口枚举） | `draft`、`in_review`、`closed` | 轮次阶段，由 `submitted_at`、`closed_at` 派生 |
| `OcrStatus`（接口枚举） | `ok`、`unavailable`、`unreadable` | 取 `ocr_result.status`（证照同步识别不会是 `pending`）；未关联识别结果为 `unavailable` |
| `ExpiryState`（接口枚举） | `none`、`expiring`、`expired` | 证照到期提示 |
| `AssetDisplayStatus`（接口枚举） | `organizing`、`ready`、`reference_only`、`need_reshoot`、`need_portrait_auth`、`adopted` | 整理中、可直接使用、仅供参考、需补拍、需肖像授权、已采用（PRD.md:724） |
| `AssetTimelineKind`（接口枚举） | `uploaded`、`processed`、`reviewed`、`used_as_reference`、`adopted` | 素材使用记录的节点 |
| `MissingItemKey`（接口枚举，完整度缺项键） | `brand_name`、`store_name`、`industry`、`address`、`business_hours`、`store_tel`、`avg_spend`、`door_photos`、`interior_photos`、`service_items`、`selling_points`、`entity_type`、`business_license`、`contact`、`declaration`、`permit` | 对应 d9-profile.md:367-372 的必填项；`permit` 的具体类型放在 `MissingItem.permitType`（2.1），枚举里不带模板值 |
| `PermitFieldFormat`（字典扩展属性） | `text`、`date`、`cert_no` | `PermitFieldDef.format`（2.8） |
| `FileNotUsableReason`（`FILE_NOT_USABLE.details.reason`，`x-open-enum`） | `not_stored`、`category_mismatch`、`scope_mismatch`、`blocked`、`duplicate`、`ext_mismatch`、`context_mismatch` | 含义见第 5 节；全仓引用方对号取值 |

接口枚举都标 `x-open-enum`（C37）。

## 5. 错误码

本文新定义的领域错误码。档案段 49000–49099，素材与上传段 46000–46099（A70）。`retryable` 都为否。

| 符号名 | 数值 | HTTP | 含义 | `details` |
| --- | --- | --- | --- | --- |
| `REVIEW_REQUIRED` | 49001 | 409 | 修改门店名称、地址或行业与品类须重新审核，请确认后再保存 | `{ changedFields: string[] }` |
| `PROFILE_REQUIRED_MISSING` | 49002 | 400 | 已提交过资质的门店不能把必填项改空 | `{ fields: string[] }` |
| `QUALIFICATION_IN_REVIEW` | 49003 | 409 | 资质正在审核中，暂不能修改 | `{ qualificationSubmissionId: string, kind: string }` |
| `QUALIFICATION_CLOSED` | 49004 | 409 | 资质审核已终局驳回，不能再提交 | — |
| `ENTITY_NOT_VERIFIED` | 49005 | 409 | 经营主体尚未认证，请先完成首家门店的资质审核 | — |
| `STORE_PROFILE_INCOMPLETE` | 49006 | 409 | 门店建档必填项未填齐 | `{ missing: array<{ step: integer, item: MissingItemKey, permitType: string \| null }> }` |
| `INDUSTRY_NOT_OPEN` | 49007 | 409 | 所选行业品类或地区暂未开放 | `{ field: 'industry' \| 'region', code: string }` |
| `QUALIFICATION_DOCS_INCOMPLETE` | 49008 | 409 | 证照不齐、未核对或被驳回的证照未补传 | `{ missing: array<{ docType, permitType: string \| null }>, withoutSubmittedFields: string[], rejectedNotReplaced: array<{ docType, permitType: string \| null }> }` |
| `ENTITY_TYPE_MISMATCH` | 49009 | 409 | 所选主体类型与营业执照不一致 | `{ claimedEntityType: string, recognizedSubjectType: string }` |
| `DECLARATION_REQUIRED` | 49010 | 400 | 请阅读并勾选信息确认 | `{ currentVersion: string }` |
| `CONTACT_PHONE_UNVERIFIED` | 49011 | 409 | 联系人手机号未验证 | — |
| `USCC_TAKEN` | 49012 | 409 | 该统一社会信用代码已被其他主体认证 | — |
| `ENTITY_LICENSE_CHANGE_PENDING` | 49013 | 409 | 本主体已有一轮更换营业执照的审核在进行（M108） | `{ storeId: string }` |
| `QUALIFICATION_DOC_NOT_ALLOWED` | 49014 | 409 | 本轮不需要上传这种证照 | `{ docType: string, roundKind: string }` |
| `QUALIFICATION_NO_CHANGE` | 49015 | 409 | 没有需要提交审核的修改 | — |
| `FILE_NOT_USABLE` | 46001 | 400 | 文件不可用（未上传完成、类型不符、归属不符或已被拦截） | `{ fileIds: string[], reason: FileNotUsableReason }`（`x-open-enum`，取值见下） |
| `ASSET_UPLOAD_GATED` | 46002 | 409 | 门店资质审核通过前，店员暂不能上传素材 | — |
| `ASSET_PORTRAIT_AUTH_FORBIDDEN` | 46003 | 403 | 只有老板或素材上传人可以补交肖像授权 | — |
| `ASSET_FEEDBACK_DAILY_LIMIT` | 46004 | 409 | 今天对这条素材的反馈次数已达上限，请明天再试 | `{ limit: integer }` |

`FILE_NOT_USABLE.details.reason` 的取值（全仓共用，引用方对号取值；新增取值先在本表登记）：

| 取值 | 含义 | 典型引用方 |
| --- | --- | --- |
| `not_stored` | 文件不是 `stored`（未确认、已拒收、已删除） | 全部 |
| `category_mismatch` | 分类与用途不符 | 全部 |
| `scope_mismatch` | 登记范围不符：不是当前用户、当前门店或本主体登记的；代传门店不符；证照的主体级、门店级不符 | 本文、a03、a08、m08 |
| `blocked` | 被内容安全拦截（`moderation_state = 'block'`） | 全部 |
| `duplicate` | 同一请求内重复引用同一文件 | 本文 3.22、a06 |
| `ext_mismatch` | 扩展名或规范类型与用途不符 | 本文 3.22、a09 |
| `context_mismatch` | 文件不属于该业务对象（如制作留痕不属本订单项、本广告） | a05 |

引用其他来源的错误码：通用码 `VALIDATION_FAILED`、`ROLE_FORBIDDEN`、`NOT_FOUND`、`VERSION_CONFLICT`、`STATE_NOT_ALLOWED`、`RATE_LIMITED`、`PROVIDER_UNAVAILABLE`、`IDEMPOTENCY_IN_PROGRESS`（C27）；`CONTENT_REJECTED`（41006，400，`details = { fields: string[] }`，A131）、`SMS_UNAVAILABLE`（41007，503，含发送失败）、`SMS_CODE_INVALID`（41008，400，`details.attemptsLeft`）由 m01-account 定义（A77）；`DICT_ITEM_DISABLED`（47001，409）与上传类的 `FILE_TOO_LARGE` 等 7 个码（47051–47057）由 m08-support-misc 定义（A77）；`STORE_ARCHIVED`（403，C17 中间件）由 m02-tenant 定义。另：`STORE_NOT_QUALIFIED`（门店闸门）归 m04-mall-order（A77），本文不定义。

说明：
- `USCC_TAKEN` 的判定发生在资质提交（本文 3.17）与资质通过（a03-merchant），两处都属 profile 模块，在档案段取号 49012，a03 引用本符号（按第十节导语接受这一默认）。
- `STORE_PROFILE_INCOMPLETE` 归本文（A123），由 3.17 与 `profile.assertProfileComplete`（1.2）共用：提交资质查四步，订购与广告只查前三步，`details.missing` 同构。初稿的 `PROFILE_INCOMPLETE` 改名为它，数值不变。
- `FILE_NOT_USABLE` 是 `files.link()` 断言失败的统一出口，订购与广告挂文件引用、后台代传等引用文件的接口直接引用。素材库素材的参考守卫（`isSelectableAsReference` 为假）不走它：m04 按 `VALIDATION_FAILED` 返回（m04 第二轮的做法）。
- 49016 释放：初稿的 `CONTACT_SMS_CODE_INVALID` 删除，改引用 m01 的 `SMS_CODE_INVALID`（A77）。46000–46099 不再给上传类码预留（A77，上传类码在 m08 的 47051–47057）。

## 6. 待确认

只列需要产品、业务、法务决定的问题。初稿第 6 节的第 1、2、3、9、10、11、12 项已由第十节裁决结案（A48、A87、A86、A77、A107，`USCC_TAKEN` 的号段按第十节导语接受默认），不再列出。第三轮核对：字典扩展属性与播种项已由 A145 回写 14 分组，文本检测不可用的做法已由 A137 定，均不在此列；下列 8 项 A127–A150 没有涉及，保留。

| # | 问题 | 默认做法 | 谁定 |
| --- | --- | --- | --- |
| 1 | 信息确认：文案的现行版本号存在哪里（数据模型只有轮次上的 `declaration_version`）；信息确认是否算协议同意（04-profile.md:713 第 1 项） | 版本号作为代码常量登记在契约里，文案变更随发版；若要后台可改，登记为站点配置的一项。暂不算协议同意，不写 `agreement_consent` | 产品、法务 |
| 2 | 营业时间的时段数上限、是否按星期区分（04-profile.md:716 第 4 项） | 时段数组、不分星期、至多 4 段 | 产品 |
| 3 | 文本长度：主推服务名称、优惠活动、团购信息、联系人姓名没有上限（d9-profile.md:780 C9） | 服务名称 ≤30、优惠与团购 ≤100、联系人姓名 ≤20 | 产品 |
| 4 | `notify_scope = 'owner_only'` 的素材需求是否对店员隐藏 | 隐藏（店员只看到“老板和店员”的需求） | 产品 |
| 5 | 素材使用记录里“新片尾第 1 版已推送”这类广告进度节点 | 不进素材时间线，只到“用于制作需求 GG…”；广告进度在广告详情看 | 产品 |
| 6 | 联系人取登录手机号时是否记验证时间（04-profile.md:714 第 2 项） | 不记 | 产品 |
| 7 | 肖像授权材料的收取方式与保留期（06-media.md:1878 第 5 项） | 老板、上传人在素材上补交（3.23，分类 `portrait_auth`，secure 桶，不向商家端签发），复核人确认；素材删除时，从未被采用的 7 天后释放，被采用过的保留 3 年 | 法务 |
| 8 | 分支机构执照是否必须（d9-profile.md:279、815 Q3；PRD.md:1168） | 不必须：各轮次“可以有”，有则比对“隶属本主体”；被点名驳回后须补传才能重新提交（3.17） | 法务、业务 |

## 7. 修订记录

| 日期 | 改动 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：路线图 `doc = m03-profile-asset` 的 24 条接口全部写到字段级；按 A48 补 3.11；定义错误码 49001–49016、46001–46003 | 写作规范；A1–A75；C1–C84；数据模型 02、03、04、06、14 |
| 2026-10-03 | 第二轮。**资质轮次**：3.9 写全 `ensureDraft` 规则——驳回后新建的草稿在 `INSERT` 时写 `resubmit_of_qualification_submission_id`（来源 = 最近一轮被驳回的轮次，跳过 `discarded`、`withdrawn`），带入证照与主体类型都取自来源轮次，`change` 轮次带入生效的门店级证照；3.17 补“被驳回的证照已补齐”（`QUALIFICATION_DOCS_INCOMPLETE.details.rejectedNotReplaced`）与“更换主体营业执照的 `change` 轮次须填主体类型”两项校验，补发 `approval.submitted`，写明审批单 `summary_snapshot` 的取值，并写明审核结果页须补信息确认勾选；3.3 写待审值时递增轮次锁版本，`PendingChange` 带 `lockVersion`；3.9、3.12、3.14、3.16 补完整度缓存写回（1.1）。**短信**：删除 `CONTACT_SMS_CODE_INVALID`（49016 释放），3.10 改引用 m01 的 `SMS_CODE_INVALID`，错误计数在独立短事务提交；3.11 改为三段式、短信未配置改引用 `SMS_UNAVAILABLE`。**识别**：3.12 改为三段式，响应结果脱敏并加 `replayed`，复用键加 `permit_type`，补证照文件的主体级 / 门店级范围校验。**约定对齐**：写接口响应的签名地址按 A80 重放置空并带 `replayed`（1.1）；字典项停用改返回 m08 的 `DICT_ITEM_DISABLED`；`PROFILE_INCOMPLETE` 改名 `STORE_PROFILE_INCOMPLETE`（A123）；`MissingItem` 改为 `{ item, permitType }`；`FILE_NOT_USABLE.details.reason` 改为开放枚举并补 `duplicate`、`ext_mismatch`、`context_mismatch`；素材反馈的每日上限改为 409 `ASSET_FEEDBACK_DAILY_LIMIT`（46004）；3.15 的签发限额作为档位 `m.sign` 待登记 C68；补店员 schema `StoreProfileMediaClerk`、`StoreProfileServiceClerk`；联系人响应字段 `phoneSource` 改名 `phoneVerifyState`；列表筛选 `usableAsReference` 改名 `isSelectableAsReference`，补 `ids` 回显参数；素材复核定时器写明键 `sla.breach:store_asset:{storeAssetId}`。**页面与数据**：音频、文档素材允许 1–9 个文件，补洞察的取法与逐文件转写 `fileTranscripts`；`usedBy` 只给 `ad`、`drama_order` 两类并写明换算；首页广告计数与 m06 页签同口径并补 `revisingCount`；补字典扩展属性 `PermitTypeExt`、`StoreSellingPointExt` 与食品经营许可证的播种值（2.8）；补 1.2 给其他文档的进程内接口。第 6 节删去已裁决的七项，补肖像授权材料、分支机构执照两项。路线图切片：补 `m.storeProfile.contactSmsCode.create`，改素材反馈的能力点、提交的迁移与各条的表 | A76–A126；`review/xdoc-m03-profile-asset.md`；两位复核员意见；`review/api-check.md` |
| 2026-10-03 | 第三轮。**公共结构**（C87）：2.6 的 6 字段主体结构改名 `EntityQualificationBrief`（与 m02 的 `EntityBrief` 不同构）；删去本文的 `SignedUrl`、`CursorPage` 定义，改引 a01 的 `SignedUrl` 与约定 C42 的 `CursorPage<T>`（清单记入 `externalSchemas`）；`StoreBrief` 在商家端没有同名结构，保留。**字典出入形态**（C85）：2.5 响应的 `sellingPointCodes` 改为 `sellingPoints: DictRef[]`，请求仍收 `sellingPointCodes`。**内容安全**：检测不可用一律 503 `PROVIDER_UNAVAILABLE`、不写库，3.3、3.7、3.10 补该行；`CONTENT_REJECTED` 写明 `details.fields`。**短信**：3.11 发送失败改返回 `SMS_UNAVAILABLE`，删去 `PROVIDER_UNAVAILABLE`。**登记**：3.15 限流档位 `m.sign` 已登记 C68，3.12 三段式已登记 C51，清单的两项“建议登记”清空。**进程内接口**：1.2 补 `profile.validateStoreBasics` 供 m02 新增门店复用；“品牌故事”编码定为 `brand_story`（3.20、1.2）；2.8 与 14 分组核对一致；素材时间线单号改经 `order.getOrderNos`、`ads.getAdNos` 补齐 | A130、A131、A132、A133、A137、A139、A145、A150；C42、C68、C85、C87；m01、m02、m04 的请求 |
| 2026-10-03 | 第四轮（收尾）。**单值字典字段**（C85、A151）：响应里 `StoreBrief`、`StoreProfileBasic`、`PendingChange` 的 `industryCode`、`categoryCode` → `industry`、`category: DictRef \| null`；`AddressView` 的四级区划 → `province`、`city`、`district`、`zone: DictRef \| null`，请求另立 `AddressInput`（仍收编码）；`AssetTag.tagCode` 与 `hotTags[].tagCode` → `tag: DictRef`；`rejectReasons` 由 `{ code, label }` 改为 `DictRef[]`；视图里的 `permitType` 改为 `DictRef`（错误详情与 `MissingItem` 仍为编码）；3.3 说明改为名称由服务端带出。`EntityQualificationBrief` 改名、`sellingPoints` 第三轮已做 | A151、A152；C85、C87；m01、m02、a01、a03 的请求 |
