# 后台：短剧库与积分价

| 项 | 内容 |
| --- | --- |
| 范围 | 短剧列表（A:Dramas）、编辑短剧的 5 个页签与右栏（A:DramaEdit）、单剧积分价（A:Pricing）、积分价模板与参数页的“等级模板”一栏的只读部分（A:Params）；交付工单详情（A:TicketDetail）的成片批量上传共用本文的批次接口；首页置顶与商城配置（A:OpsHome、A:OpsMall）的选剧下拉引用本文的短剧列表 |
| 接口数 | 36（全部 V1.0）：路线图（`working/routemap.json`）里本文的 36 条（第二轮按 A61 把角色接口改为 `admin.drama.cast.replace`，并补登 `admin.uploadBatch.refreshCredentials`、`admin.dramaPrice.summary`） |
| 依据 | 接口裁决 `api-rulings.md` A1–A150（第二轮按第十节 A76–A120、第三轮按第十二、十三节 A127–A150 修订）；通用约定 `conventions.md` C1–C87；资源登记表 `resources.json`；数据模型 `docs/data-model/05-content.md`（剧目、剧集、许可、版权、修订、统计）、`06-media.md`（文件、批次与条目、原片版本、预告片指针、可播放资产、媒体任务）、`07-billing-ledger.md`（等级模板价、单剧定价修订、积分规则参数、套餐价目），并引用 01、03、14 分组的列；草案 `d8-content.md` 第 3–7、9 节、`d5-media.md` 5.2–5.7 与第 14 节、`d1-ledger.md` 4.1、5.5 与 11.2–11.4、`d4-identity.md` 7.1–7.2；原型梳理 `proto-admin-c.md` 第 1、2、5、6 节；原型 `admin/Dramas`、`admin/DramaEdit`、`admin/Pricing`、`admin/Params`；设计规范第 11、12、14 节；风险文档第 0 节 |

路径省略前缀 `/api/v1`。引用写法同约定：`文件:行号`；`05:143` 指 `docs/data-model/05-content.md` 第 143 行，`06:`、`07:`、`03:`、`14:` 同理；草案写作 `d8:330`、`d5:1174`、`d1:1708`、`d4:1220`。

## 1. 概览

本文是内容运营的工作面：维护平台自有版权短剧的全部资料并完成上下架，管理原片与预告片，给每部剧定积分价。短剧库与积分价都是全局资源（没有主体、门店），后台数据范围一律 `global`（d4:1220）。上下架、版权变更、积分价调整三类动作带独立的权限点；其余编辑走“短剧库”模块的编辑等级。积分价的“按模板”部分由等级模板价决定，模板价的保存与变更记录归 a07 的 `admin.pricingChange.*`（A28），本文只读模板的当前值（A93：V1.0 模板价保存即生效，没有待生效的值）。

| operationId | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `admin.drama.list` | `GET /admin/dramas` | 短剧列表（筛选、页码分页） | `staff`；模块 drama 查看 | none（查询） |
| `admin.drama.summary` | `GET /admin/dramas/summary` | 页首计数 | `staff`；模块 drama 查看 | none（查询） |
| `admin.drama.create` | `POST /admin/dramas` | 新建短剧草稿 | `staff`；模块 drama 编辑 | required |
| `admin.drama.get` | `GET /admin/dramas/{dramaId}` | 短剧详情（各页签、右栏） | `staff`；模块 drama 查看 | none（查询） |
| `admin.drama.activity.list` | `GET /admin/dramas/{dramaId}/activities` | 剧目操作日志 | `staff`；模块 drama 查看 | none（查询） |
| `admin.drama.listingChecks.get` | `GET /admin/dramas/{dramaId}/listing-checks` | 上架校验结果 | `staff`；模块 drama 查看 | none（查询） |
| `admin.drama.basic.update` | `PATCH /admin/dramas/{dramaId}/basic` | 保存“基础信息”页签（含微短剧类别、是否 AI 制作） | `staff`；模块 drama 编辑 | required |
| `admin.drama.commercial.update` | `PATCH /admin/dramas/{dramaId}/commercial` | 保存“商业信息”页签 | `staff`；模块 drama 编辑 | required |
| `admin.drama.cast.replace` | `PUT /admin/dramas/{dramaId}/cast` | 整表替换角色介绍（A61） | `staff`；模块 drama 编辑 | required |
| `admin.drama.copyright.replace` | `PUT /admin/dramas/{dramaId}/copyright` | 草稿期保存版权信息 | `staff`；模块 drama 编辑 | required |
| `admin.drama.dramaCopyrightRevision.create` | `POST /admin/dramas/{dramaId}/drama-copyright-revisions` | 上架后的版权变更 | `staff`；`drama.copyright.revise` | required |
| `admin.drama.dramaPermit.list` | `GET /admin/dramas/{dramaId}/drama-permits` | 许可行列表 | `staff`；模块 drama 查看 | none（查询） |
| `admin.drama.dramaPermit.create` | `POST /admin/dramas/{dramaId}/drama-permits` | 新增许可行（可同时换号） | `staff`；模块 drama 编辑 | required |
| `admin.dramaPermit.update` | `PATCH /admin/drama-permits/{dramaPermitId}` | 修改许可行 | `staff`；模块 drama 编辑 | required |
| `admin.dramaPermit.retire` | `POST /admin/drama-permits/{dramaPermitId}/retire` | 停用许可行 | `staff`；模块 drama 编辑 | required |
| `admin.drama.dramaEpisode.list` | `GET /admin/dramas/{dramaId}/drama-episodes` | 剧集与原片列表 | `staff`；模块 drama 查看 | none（查询） |
| `admin.dramaEpisode.update` | `PATCH /admin/drama-episodes/{dramaEpisodeId}` | 修改剧集标题 | `staff`；模块 drama 编辑 | required |
| `admin.drama.shelve` | `POST /admin/dramas/{dramaId}/shelve` | 上架或重新上架 | `staff`；`drama.shelf` | required |
| `admin.drama.delist` | `POST /admin/dramas/{dramaId}/delist` | 下架 | `staff`；`drama.shelf` | required |
| `admin.drama.confirmPermitRecheck` | `POST /admin/dramas/{dramaId}/confirm-permit-recheck` | 替换原片后确认许可信息仍适用 | `staff`；模块 drama 编辑 | required |
| `admin.drama.mediaReadiness.get` | `GET /admin/dramas/{dramaId}/media-readiness` | 预告片、海报、原片就绪情况与在途批次 | `staff`；模块 drama 查看 | none（查询） |
| `admin.drama.trailer.replace` | `PUT /admin/dramas/{dramaId}/trailer` | 设置预告片（触发两档转码） | `staff`；`drama.media.manage` | required |
| `admin.uploadBatch.create` | `POST /admin/upload-batches` | 建批量上传批次并逐集匹配 | `staff`；处理器内判权 | required |
| `admin.uploadBatch.get` | `GET /admin/upload-batches/{uploadBatchId}` | 批次详情与逐条进度 | `staff`；处理器内判权 | none（查询） |
| `admin.uploadBatch.start` | `POST /admin/upload-batches/{uploadBatchId}/start` | 确认匹配结果，开始上传 | `staff`；处理器内判权 | required |
| `admin.uploadBatch.refreshCredentials` | `POST /admin/upload-batches/{uploadBatchId}/refresh-credentials` | 签发或续签整批的直传临时密钥 | `staff`；处理器内判权 | none（签发短时凭证） |
| `admin.uploadBatchItem.update` | `PATCH /admin/upload-batch-items/{uploadBatchItemId}` | 改集号、跳过、同一集换新文件 | `staff`；处理器内判权 | required |
| `admin.uploadBatchItem.complete` | `POST /admin/upload-batch-items/{uploadBatchItemId}/complete` | 单个文件上传完成确认 | `staff`；处理器内判权 | required |
| `admin.uploadBatch.commit` | `POST /admin/upload-batches/{uploadBatchId}/commit` | 提交原片批次，生成新原片版本 | `staff`；`drama.media.manage` | required |
| `admin.uploadBatch.cancel` | `POST /admin/upload-batches/{uploadBatchId}/cancel` | 取消批次 | `staff`；处理器内判权 | required |
| `admin.dramaPrice.list` | `GET /admin/drama-prices` | 单剧积分价列表 | `staff`；模块 billing 查看 | none（查询） |
| `admin.dramaPrice.summary` | `GET /admin/drama-prices/summary` | 单剧积分价页首计数（A23） | `staff`；模块 billing 查看 | none（查询） |
| `admin.drama.dramaPriceRevision.create` | `POST /admin/dramas/{dramaId}/drama-price-revisions` | 单剧调价 | `staff`；`billing.price.edit` | required |
| `admin.dramaPriceRevision.list` | `GET /admin/drama-price-revisions` | 调价记录（含待生效、已撤销） | `staff`；模块 billing 查看 | none（查询） |
| `admin.dramaPriceRevision.withdraw` | `POST /admin/drama-price-revisions/{dramaPriceRevisionId}/withdraw` | 撤销尚未生效的调价 | `staff`；`billing.price.edit` | required |
| `admin.priceTierRevision.list` | `GET /admin/price-tier-revisions` | 等级模板价的当前值、适用剧目数 | `staff`；模块 billing 查看 | none（查询） |

路由注册顺序（A8、C12）：`/admin/dramas/summary` 先于 `/admin/dramas/{dramaId}`；`/admin/drama-prices/summary` 与 `/admin/drama-prices` 同层，无参数段冲突。

全部接口的限流档位为 `admin.global`（C68）；GET 不写库（A19）；页码分页的列表 `page` 从 1 起、`pageSize` 默认 20、上限 100，返回 `{ items, page, pageSize, total }`（C43），例外在各接口写明。不经本文的相关接口：文件登记与直传 `admin.file.create` / `complete` / `get` / `refreshCredentials`、文件签发 `admin.file.downloadUrls`、媒体任务重试 `admin.mediaJob.retry`（a01）；导出 `admin.exportJob.*`（a02）；订购积分试算 `admin.order.quote`（a05）；成片批次的提交 `admin.deliveryTicket.episodeOutput.create`（a05）；等级模板价与计费参数的保存与变更记录 `admin.pricingChange.create` / `list`（a07）。

## 2. 公共结构

### 2.1 本文通用口径

**权限的写法。** 按 d4 7.2 的 `adminRoute({ permission: { module, need, action?, scope } })`：
- “模块 drama 查看 / 编辑”= `{ module: 'drama', need: 'view' | 'edit', scope: 'global' }`；“模块 billing 查看”= `{ module: 'billing', need: 'view', scope: 'global' }`。模块键沿用路线图备注（短剧库管理 `drama`、套餐与积分 `billing`），以权限注册表为准（03:944）。
- 带权限点的写：`{ module, need: 'view', action: <权限点>, scope: 'global' }`。权限点独立于模块编辑等级授予（d4 7.2 第 3 条）。
- 处理器内判权（A45 的 `permission: assert-in-handler`）：批量上传按批次用途判定，规则写在 3.23、3.24。只限批次持有人的接口（3.25–3.28、3.30）对非持有人返回 404 `NOT_FOUND`（C24：不在本人范围内与不存在不区分，与 a01 `admin.file.*` 一致）；持有人此刻已不再持有该用途的权限时返回 403 `PERMISSION_DENIED`（执行时按此刻的权限重查）。
- 查看类不设权限点（C66）；再验证由注册表决定，本文的权限点在注册表或增补表里都不要求再验证，也都不要求二次确认回显（C54）。本文新增的 `drama.copyright.revise`、`drama.media.manage` 已按 A129 进增补表（默认授予内容运营；清单键 `permissionSupplements`，A140），以 07 主文档的注册表为准。

**价格口径。**
- 标价 `P(drama, t)`（接口字段名 `listPricePoints`，与 m04 `DramaCard`、a05 `OrderQuoteResult` 同名）：取该剧 `effective_at ≤ t` 且未撤销的最新一条 `drama_price_revision`；`mode = custom` 取 `custom_points`，`mode = template` 或没有任何修订时取该剧 `drama.heat_tier` 在 `t` 的模板价（07:293）。剧目没有热度等级、也没有生效的单剧调整时，`P` 为空。由 billing 实现的 `DramaPricePort.priceAt` 批量给出 `P`、定价方式与模板价（d8:579）。
- 模板价 `T(tier, t)`：`price_tier_revision` 里该等级 `effective_at ≤ t` 的最新一行的 `points`（07:254）。
- 定价方式 `priceMode`：当前生效修订的 `mode`；没有修订时为 `template`；`P` 为空时为空。
- 各版本实扣 `discountedPoints = round(P × discount_bp ÷ 10000)`：`discount_bp` 取上架中的套餐（`plan.is_listed`，按 `plan.rank` 升序）当前生效的价目修订（`plan_revision`，`effective_at ≤ now` 且未撤销）。计算用 `packages/shared/pricing` 的同一个函数，不含顶级模型加扣（d1:631 `quoteDramaItem`；原型 DramaEdit“专业版实扣、旗舰版实扣”、Pricing“基础版 / 专业版 / 旗舰版实扣”）。下文类型写作 `PlanPrice`（2.2）。

**授权期派生。**
- 今天 = Asia/Shanghai 的日期（d8:367）。
- 停止订购日 `stopOrderDate` = `drama_copyright.license_end_date` 往前数 `minLicenseMonths` 个自然月，当月无此日取月末（d8:358；参数取 `billing_param` 键 `minLicenseMonths`，经 `DramaPricePort.minLicenseMonths`）。止日为空时为空。
- `licenseFlag`（枚举 `LicenseFlag`，第 4 节）：`license_ended` = 止日非空且今天 > 止日；否则 `stopped` = 已上架且今天 ≥ 停止订购日；否则 `not_listed` = 草稿或已下架；否则 `orderable`。这与 `content.getOrderability` 的 `visible` 同口径（d8:359、473）。
- `isExpiringSoon` = 止日在今天起 N 天内（含今天），N = 参数 `remind.copyright.days`（14:296；默认 90，d8:305）。
- 以上派生由 content 的同一个函数给出（与 `content.getOrderability` 同源）；a02 工作台的 `copyright_expiring` 预警、本文 `admin.drama.summary` 的“已停止订购”与 `admin.drama.list` 的筛选共用它，字段名统一为 `stopOrderDate`、`liveItems`，窗口天数取 `remind.copyright.days`（a02 的请求；a02 侧的字段名与窗口天数已请 a02 对齐）。

**剧目聚合的并发。** 剧目行带 `drama.lock_version`，版权当前值另带 `drama_copyright.lock_version`。许可行 `drama_permit`、剧集 `drama_episode` 没有自己的锁列，按 d8 7.1“后台写操作锁剧目行并比对 `lock_version`”：
- 改剧目行列的 `PATCH` / `PUT` 带 `lockVersion`（剧目的）；改许可行、剧集的 `PATCH` 带 `dramaLockVersion`（取剧目的 `lock_version`；A104，C52 已登记为例外）；版权的 `PUT` 与版权变更带 `lockVersion`（版权当前值的）。不一致返回 409 `VERSION_CONFLICT`，`details` 带最新值（C52）。
- 凡在剧目行锁内改动剧目聚合（剧目行、许可行、剧集行、角色，以及上下架、置或清“待重新核验”标记）的写，都把 `drama.lock_version` 加 1，响应里带新值（`AdminDramaDetail.lockVersion` 或 `dramaLockVersion`），同一页面据此继续保存。版权当前值的写只加 `drama_copyright.lock_version`。
- 状态迁移（上架、下架）的守卫没有列 `lock_version`（05:143-147），请求体不带（A21、C53）。

**已上架剧目的保存校验。** 剧目 `status = listed` 时，下列写在同一事务里按写入后的数据重跑 `listingChecks`（不含 L12）：`admin.drama.basic.update`、`admin.drama.commercial.update`、`admin.drama.dramaPermit.create`、`admin.dramaPermit.update`、`admin.dramaPermit.retire`、`admin.drama.dramaCopyrightRevision.create`。有阻断项不过则整笔回滚，返回 409 `LISTING_CHECK_FAILED` 并指出未过的项，不自动下架（d8:328）。L12 不参与：它由原片变更置位，只能经“确认重新核验”清除（d8:328）。保存成功后刷新目录缓存版本号（d8 5.2 实现 1，不写表），商城展示同步更新（原型 DramaEdit“修改已保存，商城展示同步更新”）。

**归档的剧。** `drama.archived_at` 非空的剧只读：除 GET 外，本文的剧目写接口（含设置预告片、建原片批次与提交）一律返回 409 `DRAMA_ARCHIVED`；调价返回 `DRAMA_PRICE_LOCKED`（`reason = archived`，3.33）。数据模型只明写了“归档后不能重新上架、不再受理版权变更”（05:117、374），其余写的只读是本文的默认（第 6 节第 1 项）。

**文件引用。** 封面、许可扫描件、权属证明、预告片源文件先经 `admin.file.create` → 直传 → `admin.file.complete`（a01）拿到已入库（`stored`）的 `fileId`，再在本文接口里引用；本文接口在业务事务里调 `files.link()` 登记引用、调 `files.release()` 释放被移出的文件（06 3.2；05:451-458）。文件分类要求：封面 `poster`，许可扫描件与权属证明、版权变更依据 `drama_license_doc`，预告片源 `trailer_src`；不满足（未入库、分类不符、被内容安全拦截）返回 400 `FILE_NOT_USABLE`（m03 定义）。原片 `drama_master` 只经批次上传（3.23）。封面图随数据返回 30 分钟对齐窗口的签名地址（C60、C61）。

这三类文件在 a01 的上传鉴权（`admin.file.create` 按分类调用的 `authorizeUpload`）与读权限（`admin.file.downloadUrls` 的 `canReadFile`）按下表，由 a01 登记：

| 分类 | 上传 | 读（`admin.file.downloadUrls`） |
| --- | --- | --- |
| `poster` 封面 | 模块 drama 编辑等级 | 全员，不留痕（同 a01 的“海报、封面”） |
| `drama_license_doc` 许可扫描件、权属证明、版权变更依据 | 模块 drama 编辑等级，或持 `drama.copyright.revise`（版权变更的依据文件） | 模块 drama 查看等级；每次签发写 `access` 审计（类别 `file_access`） |
| `trailer_src` 预告片源文件 | 权限点 `drama.media.manage` | 同预告片：全员，不留痕 |

**审计。** 剧目、许可、版权、剧集、角色、原片、预告片的保存都记在剧目上：`audit_log.target_type = 'drama'`、`target_id` 为剧目 id，记前后值（05:446；d8:270）；每次状态迁移恰好一条审计行（03:639）。改了热度等级的保存，审计 `action` 记 `drama.heat_tier.change`（3.8），单剧积分价页的“生效时间”据此取改等级的时刻（2.11）。单剧调价与撤销记 `target_type = 'drama_price_revision'`、`category = 'price_adjust'`（03:931）。

**结果脱敏（A80、C50）。** 返回 `AdminDramaDetail` 的写接口（3.3、3.7–3.11、3.18–3.20）与设置预告片（3.22）的响应带签名地址。幂等记录只存脱敏后的结果，要置空的字段路径登记在路由元数据 `x-redact-on-replay`（A124）：返回 `AdminDramaDetail` 的为 `posterUrl`、`trailer.coverUrl`；3.11 为 `drama.posterUrl`、`drama.trailer.coverUrl`；3.22 为 `coverUrl`。这些字段本来就可空。这几条接口的响应另带 `replayed: boolean`（m03 定义的小结构 `ReplayFlag`，与响应 DTO 取交）：首次成功为 `false`；同键重放为 `true`，上述字段为 `null`，端上重拉 3.4（预告片为 3.21）取地址。

**副作用落到哪张表。** 下文“副作用”一栏的写入都与业务写在同一事务：“发 `<事件>`”= 插入 `outbox_event`（`aggregate_type` 取最终表名：剧目类事件为 `drama`，调价为 `drama_price_revision`，05:447；07:1600），事件名与载荷以 x01 的事件目录为准（C84）；“登记 / 改期 / 取消定时器”= 写 `timer`（`content.license_end` 的 `subject_type = drama`，`pricing.drama_price_effective` 的 `subject_type = drama_price_revision`，05:445；07:1586）；“登记 / 释放引用”= 写 `file_ref`（`files.link()` / `files.release()`）；状态迁移写 `status_transition`（`machine = drama`、`state_field = status`，`entity_id`、`store_id` 为空，05:130）；批次、条目、文件、原片版本、可播放资产的技术状态不写 `status_transition`（06 各表状态机）。

### 2.2 小结构

员工引用一律用 a01 定义的全仓共用结构 `StaffBrief`（a01 2.2：`{ staffId, staffNo, name, roleKey, isLead, status }`），本文不另定 `StaffRef`；页头“内容运营 沈蔓”的岗位名由前端按 `roleKey` 取角色名。签名地址用 a01 2.17 的 `SignedUrl`（`{ url, expiresAt }`，C60）。

| 结构 | 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- | --- |
| `DramaFileBrief` | `fileId` | string(uuid) | 是 | 文件 | `file_object.id` |
| | `originalName` | string \| null | 是 | 原始文件名（“许可文件.pdf”） | `file_object.original_name` |
| | `sizeBytes` | string(bigint) \| null | 是 | 大小（C33） | `file_object.size_bytes` |
| | `mime` | string \| null | 是 | 规范类型 | `file_object.mime` |
| | `status` | enum（同数据模型 `file_object.status`） | 是 | 文件状态 | `file_object.status` |
| | `moderationState` | enum（同数据模型 `file_object.moderation_state`） | 是 | 内容安全状态；`block` 时页面标红 | `file_object.moderation_state` |
| `PlanPrice` | `planId` | string(uuid) | 是 | 套餐版本 | `plan.id` |
| | `planCode`、`planName` | string | 是 | 版本码与名称 | `plan.code`、`plan.name` |
| | `discountBp` | integer(万分比) | 是 | 当前折扣 | `plan_revision.discount_bp`（当前生效修订） |
| | `discountedPoints` | integer(积分) \| null | 是 | 实扣；`P` 为空时为空 | 计算（2.1） |

`DramaFileBrief` 是本文的文件摘要（许可扫描件、权属证明、原片、预告片源文件）。它与 a09 的 `FileBrief`（`{ fileId, fileName, sizeBytes, mime }`）字段不同，所以改名，避免契约包里同名冲突；原始文件名的字段名 `originalName` 与 a01 `AdminFileView` 一致。全仓是否合成一个文件摘要由主负责人定。

字典项按 C85 出入：响应返回约定的通用结构 `DictRef = { code, name }`（C87，本文不再定义；第二轮带的 `isEnabled` 去掉），名称按当前字典取，停用的项照常返回名称；请求收编码数组（`genreCodes`、`sellingTagCodes`、`industryCodes`）。本文用到的字典类型：题材 `genre`、卖点标签 `selling_tag`、适配行业 `industry`（一级）（05:438）。编辑页的下拉选项取字典接口（只列启用项），已选而停用的项由页面按“不在选项里”置灰显示。

### 2.3 `DramaRow` 短剧列表行

`admin.drama.list` 的元素。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `dramaId` | string(uuid) | 是 | 剧目 | `drama.id` |
| `title` | string | 是 | 剧名 | `drama.title` |
| `posterUrl` | SignedUrl \| null | 是 | 竖版封面 | `drama.poster_file_id` 现签 |
| `genres` | array<DictRef> | 是 | 题材 | `drama.genre_codes` + 字典 `genre` |
| `industries` | array<DictRef> | 是 | 适配行业（一级）；首页“按行业置顶”的选剧下拉据此显示与核对 | `drama.industry_codes` + 字典 `industry` |
| `dramaClass` | enum(`class_1`/`class_2`/`class_3`) \| null | 是 | 微短剧类别 | `drama.drama_class` |
| `totalEpisodes` | integer \| null | 是 | 集数 | `drama.total_episodes` |
| `heatTier` | enum(`S`/`A`/`B`/`C`) \| null | 是 | 热度等级 | `drama.heat_tier` |
| `listPricePoints` | integer(积分) \| null | 是 | 积分价 P | 计算（2.1） |
| `templatePoints` | integer(积分) \| null | 是 | 模板价（“模板 2,000 · 已调整”） | `T(heat_tier, now)` |
| `priceMode` | enum(`template`/`custom`) \| null | 是 | 定价方式（“按 B 级模板”或“已调整”） | 计算（2.1） |
| `status` | enum（同数据模型 `drama.status`） | 是 | 状态 | `drama.status` |
| `archivedAt` | string(date-time) \| null | 是 | 归档时间 | `drama.archived_at` |
| `liveItems` | integer \| null | 是 | 上线中成片（部）；没有统计行为空 | `drama_stat.live_items` |
| `ordersMtd` | integer \| null | 是 | 当月订购（部），列名按当月显示 | `drama_stat.orders_mtd` |
| `statRefreshedAt` | string(date-time) \| null | 是 | 统计取数时刻（每小时刷新） | `drama_stat.refreshed_at` |
| `licenseEndDate` | string(date) \| null | 是 | 授权期至 | `drama_copyright.license_end_date` |
| `stopOrderDate` | string(date) \| null | 是 | 停止订购日（“09-25 起停止订购”） | 计算（2.1） |
| `licenseFlag` | enum `LicenseFlag` | 是 | 授权期派生标记 | 计算（2.1） |
| `isExpiringSoon` | boolean | 是 | N 天内到期 | 计算（2.1） |
| `shelveBlockedReason` | enum(`license_ended`/`archived`) \| null | 是 | 重新上架按钮置灰的原因（“授权已结束，不能上架”） | 计算 |
| `actions` | array<enum> | 是 | 当前员工此刻可执行的动作：`shelve`、`delist`（C16） | 计算：状态 + 权限点 `drama.shelf` |
| `updatedAt` | string(date-time) | 是 | 最近更新 | `drama.updated_at` |

### 2.4 `AdminDramaDetail` 短剧详情

`admin.drama.get` 的响应；新建、各页签保存、上下架、确认重新核验也返回它（写接口的响应另带 `replayed`，按 2.1 的结果脱敏）。名字带 `Admin` 前缀，与 m04 商家端的 `DramaDetail` 区分（契约包只有一个命名空间，同 a05 的 `AdminOrderDetail`）。

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `dramaId`、`title`、`status`、`archivedAt` | 同 `DramaRow` | 是 | — | `drama` |
| `statusChangedAt` | string(date-time) | 是 | 最近一次状态迁移 | `drama.status_changed_at` |
| `firstListedAt`、`listedAt` | string(date-time) \| null | 是 | 首次上架、最近上架 | `drama.first_listed_at`、`listed_at` |
| `delistedAt`、`delistReasonCode`、`delistNote` | string(date-time) / enum / string，均可空 | 是 | 最近一次下架；只在 `status = delisted` 时有业务含义 | `drama.delisted_at`、`delist_reason_code`、`delist_note` |
| `createdAt`、`createdBy` | string(date-time)、StaffBrief | 是 | 页头“创建于 … · 内容运营 沈蔓” | `drama.created_at`、`created_by_staff_id` |
| `updatedAt`、`updatedBy` | string(date-time)、StaffBrief | 是 | 页头“最近保存”；系统动作不改写操作人 | `drama.updated_at`、`updated_by_staff_id` |
| `lockVersion` | integer | 是 | 剧目行的锁版本（2.1） | `drama.lock_version` |
| **基础信息** | | | | |
| `posterFileId`、`posterUrl` | string(uuid) \| null、SignedUrl \| null | 是 | 竖版封面 | `drama.poster_file_id` |
| `totalEpisodes` | integer \| null | 是 | 总集数 | `drama.total_episodes` |
| `episodeDurationSec` | integer \| null | 是 | 单集时长（秒），页面格式化显示（d8 C14） | `drama.episode_duration_sec` |
| `genres` | array<DictRef> | 是 | 题材 | `drama.genre_codes` |
| `sellingTags` | array<DictRef> | 是 | 标签（卖点标签，至多 3 个，d8 C8） | `drama.selling_tag_codes` + 字典 `selling_tag` |
| `producerName`、`castNames`、`synopsis` | string \| null | 是 | 出品方、主演、剧情简介 | `drama.producer_name`、`cast_names`、`synopsis` |
| `roles` | array<DramaRole> | 是 | 角色介绍，顺序即商家端展示顺序（字段名与 m04 `DramaDetail.roles`、列名 `drama.roles` 一致）；`DramaRole = { name, actor, desc }`，`actor` 可空 | `drama.roles`（05:466） |
| `dramaClass` | enum \| null | 是 | 微短剧类别（页面放在许可信息页签，由 3.7 保存，A27） | `drama.drama_class` |
| `isAiGenerated` | boolean | 是 | 原片本身是否 AI 制作（A27） | `drama.is_ai_generated` |
| **商业信息** | | | | |
| `heatTier` | enum \| null | 是 | 热度等级 | `drama.heat_tier` |
| `manualBoost` | integer | 是 | 人工加权 0–100（A27） | `drama.manual_boost` |
| `industries` | array<DictRef> | 是 | 适配行业（一级） | `drama.industry_codes` + 字典 `industry` |
| `targetAudience` | string \| null | 是 | 目标观众 | `drama.target_audience` |
| `allowedPlacements` | array<enum `PlacementSlot`> | 是 | 允许的植入形式 | `drama.allowed_placements` |
| `openPlacementSlots` | array<enum `PlacementSlot`> | 是 | 当前开放可选的取值；不在内的选项页面置灰并标“V1.1” | 参数 `content.placement.open_slots`（14:305） |
| `trialEpisodeCount` | integer \| null | 是 | 试看集数；V1.1 才可编辑，V1.0 只读 | `drama.trial_episode_count` |
| **许可与合规** | | | | |
| `isPermitRecheckRequired` | boolean | 是 | 原片内容有实质变更，许可信息待重新核验（页面显示提示与“确认仍适用”） | `drama.is_permit_recheck_required` |
| `bodyEditPolicy` | enum（同数据模型 `drama.body_edit_policy`） | 是 | 是否允许改动正片；V1.0 只读、不参与校验（05:82） | `drama.body_edit_policy` |
| **版权** | | | | |
| `copyright` | DramaCopyright | 是 | 见下表 | `drama_copyright` |
| **媒体** | | | | |
| `trailer` | TrailerBrief \| null | 是 | 预告片（2.9）；没设置过为空 | `drama_trailer` |
| `episodeSummary` | object `{ total, withCurrentMaster, processing }` | 是 | 剧集页签标题“剧集管理 60”与“已上传 60 集”；`processing` 为在途批次覆盖的集数 | `drama_episode` 计数；`media.dramaMediaReadiness`（2.9） |
| **积分价（右栏）** | | | | |
| `pricing` | DramaPricing | 是 | 见下表 | 计算（2.1） |
| **上架校验（右栏）** | | | | |
| `listingChecks` | ListingCheckResult | 是 | 与 `admin.drama.listingChecks.get` 同一份结果（2.8） | `listingChecks(dramaId)` |
| **可执行** | | | | |
| `actions` | array<enum> | 是 | `shelve`、`delist`、`confirm-permit-recheck`（C16） | 计算 |
| `editability` | object | 是 | `canEditContent`（模块 drama 编辑且未归档）、`copyrightEditMode`（enum `CopyrightEditMode`）、`canManageMedia`（持 `drama.media.manage` 且未归档）、`canReprice`（持 `billing.price.edit` 且 `DRAMA_PRICE_LOCKED` 的条件不成立） | 计算 |

`DramaCopyright`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `source` | enum(`own`/`licensed`) \| null | 是 | 版权来源 | `drama_copyright.source` |
| `platforms` | array<enum(`douyin`/`wechat_channels`)> | 是 | 授权平台，即可发布平台的上限 | `drama_copyright.platforms` |
| `territory` | string \| null | 是 | 授权地域 | `drama_copyright.territory` |
| `hasNetworkRight`、`canSublicense`、`canEditEmbed`、`canAdapt` | boolean | 是 | 信息网络传播权、转授权、剪辑植入、改编（原型缺改编权，按 PRD 补，proto-admin-c.md:115） | `drama_copyright.has_network_right`、`can_sublicense`、`can_edit_embed`、`can_adapt` |
| `licenseStartDate`、`licenseEndDate` | string(date) \| null | 是 | 版权有效期起止 | `drama_copyright.license_start_date`、`license_end_date` |
| `proofFiles` | array<DramaFileBrief> | 是 | 权属证明 | `drama_copyright.proof_file_ids` |
| `currentRevisionId` | string(uuid) \| null | 是 | 最近一条修订；首次上架前为空 | `drama_copyright.current_drama_copyright_revision_id` |
| `stopOrderDate`、`licenseFlag`、`isExpiringSoon` | 同 `DramaRow` | 是 | — | 计算（2.1） |
| `editMode` | enum `CopyrightEditMode` | 是 | `direct` = 从未上架，用 3.10 直接保存；`revision` = 上架过，只能经 3.11；`locked` = 已归档 | `drama.first_listed_at`、`archived_at` |
| `lockVersion` | integer | 是 | 版权当前值的锁版本 | `drama_copyright.lock_version` |

`DramaPricing`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `listPricePoints` | integer(积分) \| null | 是 | 剧目积分价（积分 / 部） | `P(drama, now)` |
| `priceMode` | enum \| null | 是 | 定价方式 | 2.1 |
| `templatePoints` | integer(积分) \| null | 是 | 当前等级的模板价 | `T(heat_tier, now)` |
| `currentRevision` | object `{ dramaPriceRevisionId, mode, effectiveAt, reasonCode }` \| null | 是 | 当前生效的单剧修订 | `drama_price_revision` |
| `pendingRevisions` | array<{ dramaPriceRevisionId, newPoints, effectiveAt }> | 是 | 待生效的调价，按生效时间升序 | `drama_price_revision`（`effective_at > now` 且未撤销） |
| `tierTemplates` | array<{ tier, points }> | 是 | 四档当前模板价；商业信息页签的等级卡片显示“模板积分价 3,000” | `price_tier_revision` |
| `planPrices` | array<PlanPrice> | 是 | 各版本实扣（“专业版实扣 1,440，旗舰版实扣 1,280”） | 2.1 |

### 2.5 `DramaPermit` 许可行

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `dramaPermitId` | string(uuid) | 是 | 许可行 | `drama_permit.id` |
| `platform` | enum(`all`/`douyin`/`wechat_channels`) | 是 | 播出平台；`all` = 不区分平台 | `drama_permit.platform` |
| `permitKind` | enum(`license_no`/`approval_no`/`program_no`) | 是 | 编号种类 | `drama_permit.permit_kind` |
| `permitNo` | string | 是 | 编号 | `drama_permit.permit_no` |
| `scanFiles` | array<DramaFileBrief> | 是 | 许可文件扫描件（PDF 或图片） | `drama_permit.scan_file_ids` |
| `status` | enum(`active`/`retired`) | 是 | 行状态 | `drama_permit.status` |
| `retiredAt`、`retireReason` | string(date-time) \| null、string \| null | 是 | 停用时间与原因 | `drama_permit.retired_at`、`retire_reason` |
| `note` | string \| null | 是 | 备注 | `drama_permit.note` |
| `isFrozen` | boolean | 是 | 剧目上架过：平台、种类、编号不能原地改，只能换号（d8:185） | `drama.first_listed_at` 非空 |
| `createdBy`、`createdAt`、`updatedAt` | StaffBrief、string(date-time) | 是 | — | `drama_permit.created_by_staff_id`、`created_at`、`updated_at` |
| `actions` | array<enum> | 是 | `retire`（活动行、模块编辑、未归档） | 计算 |

### 2.6 `DramaEpisodeRow` 剧集行

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `dramaEpisodeId` | string(uuid) | 是 | 剧集 | `drama_episode.id` |
| `episodeNo` | integer | 是 | 集号 | `drama_episode.episode_no` |
| `title` | string \| null | 是 | 单集标题 | `drama_episode.title` |
| `durationMs` | integer \| null | 是 | 时长（当前原片的，content 收 `drama.masters_changed` 后回填） | `drama_episode.duration_ms` |
| `masterState` | enum `EpisodeMasterState` | 是 | `missing` 没有当前原片；`processing` 有在途批次的有效条目覆盖该集（上传或体检中，提交后才生效）；`ready` 有当前原片且没有在途条目 | 计算：`drama_episode_master.is_current` 与在途批次的 `upload_batch_item` |
| `currentMaster` | object \| null | 是 | `{ dramaEpisodeMasterId, revNo, file: DramaFileBrief, durationMs, activatedAt, replaceReason, isContentChanged }`；原片文件名与大小（“E01.mp4 · 86 MB”） | `drama_episode_master`（`is_current`）的 `id`、`rev_no`、`file_id`、`duration_ms`、`activated_at`、`replace_reason`、`is_content_changed` |
| `openUploadBatchId` | string(uuid) \| null | 是 | 覆盖该集的在途批次 | `upload_batch_item.upload_batch_id` |
| `updatedAt` | string(date-time) | 是 | — | `drama_episode.updated_at` |

中插点位（`drama_episode.insert_points`，V1.1）不出接口，页面列显示“未开放”。

### 2.7 操作日志行：引用 a05 的 `ActivityItem`

操作日志的行结构用 a05 2.1 定义的 `ActivityItem`（`activityId`、`occurredAt`、`actorType`、`actorName`、`actorRole`、`client`、`action`、`summary`、`targetType`、`targetId`、`targetLabel`、`reasonText`、`transition`），本文不再另定结构，后台的时间线组件按一种行结构实现。列表不返回前后值（`audit_log.before`、`after` 单行可达十几 KB）：一次保存改了什么以 `summary` 为准（“更新角色介绍（5 个角色）”“批量替换第 3、7、12 集原片（画质修复）”）；下架原因写在 `summary` 与 `reasonText` 里；状态迁移的行另带 `transition`（`machine = drama`）。全仓共用的操作日志结构由主负责人定（a03 的 `StoreActivityItem` 待对齐）。

### 2.8 `ListingCheckResult` 上架校验结果

服务端纯函数 `listingChecks(dramaId)` 的返回，不落库（05:151）。

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `isShelvable` | boolean | 是 | 阻断项是否全过（含 L12） |
| `passedCount`、`total` | integer | 是 | 右栏“N / M 项通过” |
| `items` | array<ListingCheckItem> | 是 | 逐项结果，按编号排序 |
| `evaluatedAt` | string(date-time) | 是 | 求值时刻 |

`ListingCheckItem = { code, label, severity, isOk, note, fixTab }`：`code` 为 `L1`–`L14`；`severity` 为 `block` / `hint`（当次求值的严重度）；`note` 是一句说明（通过时如“二类微短剧 · 许可文件已上传”，未过时如“缺少许可文件扫描件”）；`fixTab` 为“去补充”定位的页签（enum `DramaEditTab`）或空。

| 编号 | 校验项（`label`） | 严重度 | `fixTab` | 判定（d8:336-349） |
| --- | --- | --- | --- | --- |
| L1 | 许可信息齐全（含许可文件） | block | `license` | 已选类别；有按类别必备的活动许可行（一类、二类 `license_no` 或 `approval_no`，三类 `program_no`），且必备行里至少一行带扫描件 |
| L2 | 版权信息齐全（含权属证明） | block | `copyright` | 来源、授权平台（至少 1 个）、地域、起止日、权属证明都有值 |
| L3 | 版权允许转授权、剪辑植入与改编 | block | `copyright` | 三项均为真 |
| L4 | 具备信息网络传播权 | block | `copyright` | 为真 |
| L5 | 已设置积分价 | block | `commercial` | 有热度等级且 `P` 可解析 |
| L6 | 预告片已上传（不超过 3 分钟） | hint 或 block | `basic` | 预告片就绪；严重度按开关 `weapp.video.trailer.enabled` 的 `default_value`：关为 hint，开为 block。V1.0 该开关为关（风险文档第 0 节；设计规范第 14 节第 11 项） |
| L7 | 授权未结束 | block | `copyright` | 今天 ≤ 止日 |
| L8 | 剩余授权期达到最短可订期 | hint | `copyright` | 今天 < 停止订购日 |
| L9 | 基础信息齐全 | block | `basic` | 剧名、封面、总集数、题材（至少 1 个）、简介有值；封面未被内容安全拦截 |
| L10 | 剧集与原片齐全 | block | `episodes` | 剧集行数 = 总集数，每集有当前原片 |
| L11 | 植入形式合规 | block | `commercial` | 非空；都在 `content.placement.open_slots` 内；一类、二类另须只含 `opening`、`ending` |
| L12 | 许可信息无待重新核验 | block | `license` | `is_permit_recheck_required = false` |
| L13 | 适配行业已选 | hint | `commercial` | 至少 1 个 |
| L14 | 每个授权平台都有许可覆盖 | hint | `license` | `permitCovers(d, platforms)` 为真 |

原型右栏只有 5 项（对应 L1、L2、L3、L5、L6，proto-admin-c.md:90）；其余各项的增补与阻断是 d8 的默认，待产品与法务确认（d8 Q6，第 6 节第 3 项）。

### 2.9 `TrailerBrief` 与 `MediaReadiness`

`TrailerBrief`（预告片指针与目标资产）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `targetPlayableId` | string(uuid) | 是 | 最近一次设置的资产（可能仍在转码） | `drama_trailer.target_playable_asset_id` |
| `currentPlayableId` | string(uuid) \| null | 是 | 当前对外播放的资产 | `drama_trailer.current_playable_asset_id` |
| `state` | enum（同数据模型 `playable_asset.state`） | 是 | 目标资产状态：处理中、可播放、失败 | `playable_asset.state` |
| `sourceFile` | DramaFileBrief | 是 | 源文件（“预告片.mp4”） | `playable_asset.source_file_id` |
| `durationMs`、`width`、`height` | integer \| null | 是 | 时长与画幅（“2 分 40 秒 · 竖屏 9:16”）；处理中时取源文件的探测值 | `playable_asset.duration_ms`、`width`、`height`；`media_info.duration_ms`、`display_width`、`display_height` |
| `coverUrl` | SignedUrl \| null | 是 | 封面 | `playable_asset.cover_file_id` 现签 |
| `error` | string \| null | 是 | 失败原因；失败时可经 `admin.mediaJob.retry`（a01）重试 | `playable_asset.error` |
| `setBy`、`setAt`、`readyAt` | StaffBrief、string(date-time)、string(date-time) \| null | 是 | 设置人、设置时间、就绪时间 | `drama_trailer.set_by_staff_id`、`set_at`；`playable_asset.ready_at` |

`MediaReadiness`（`admin.drama.mediaReadiness.get` 的响应，取自 `media.dramaMediaReadiness()`，d8:644 第 ② 项）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `trailer` | TrailerBrief \| null | 是 | 预告片 | 同上 |
| `isTrailerReady` | boolean | 是 | 有当前对外播放的资产（L6） | `drama_trailer.current_playable_asset_id` 非空且资产 `ready` |
| `poster` | object `{ fileId, moderationState, isBlocked }` \| null | 是 | 封面是否被内容安全拦截（L9） | `drama.poster_file_id` → `file_object.moderation_state` |
| `masters` | object `{ totalEpisodes, withCurrentMaster, missingEpisodeNos }` | 是 | 每集是否有当前原片（L10）；`missingEpisodeNos` 至多 100 个 | `drama_episode`、`drama_episode_master`（`is_current`） |
| `openUploadBatches` | array<{ uploadBatchId, state, scope, createdBy, expiresAt }> | 是 | 本剧在途的原片批次（刷新页面后找回批次续传，d5:1192） | `upload_batch`（`purpose = drama_master`、`target_id` = 剧目 id、`state` 未结束） |

### 2.10 `CopyrightRevision` 版权修订

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `dramaCopyrightRevisionId` | string(uuid) | 是 | 修订 | `drama_copyright_revision.id` |
| `changeKind` | enum（同数据模型 `drama_copyright_revision.change_kind`） | 是 | 修订类型 | `drama_copyright_revision.change_kind` |
| `snapshot` | object `DramaCopyrightSnapshot` | 是 | 变更后的完整版权值（05:467） | `drama_copyright_revision.copyright_snapshot` |
| `prevEndDate`、`newEndDate` | string(date) \| null、string(date) | 是 | 止日前后值 | `drama_copyright_revision.prev_end_date`、`new_end_date` |
| `reason` | string | 是 | 变更原因 | `drama_copyright_revision.reason` |
| `proofFiles` | array<DramaFileBrief> | 是 | 本次变更的依据文件 | `drama_copyright_revision.proof_file_ids` |
| `createdBy`、`createdAt` | StaffBrief、string(date-time) | 是 | — | `drama_copyright_revision.created_by_staff_id`、`created_at` |

### 2.11 积分价的结构

`DramaPriceRow`（`admin.dramaPrice.list` 的元素）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `dramaId`、`title`、`status`、`archivedAt` | 同 `DramaRow` | 是 | — | `drama` |
| `heatTier` | enum \| null | 是 | 等级 | `drama.heat_tier` |
| `templatePoints` | integer(积分) \| null | 是 | 模板积分价 | `T(heat_tier, now)` |
| `listPricePoints` | integer(积分) \| null | 是 | 积分价 | `P(drama, now)` |
| `priceMode` | enum \| null | 是 | 按模板定价 / 单剧调整 | 2.1 |
| `currentRevision` | object `{ dramaPriceRevisionId, mode, reasonCode, note, effectiveAt }` \| null | 是 | 剧名下的说明“单剧调整：模板 2,000 → 2,400，新剧热度高” | `drama_price_revision` 当前生效行的 `id`、`mode`、`reason_code`、`note`、`effective_at` |
| `pricedSince` | string(date-time) \| null | 是 | “生效时间”列：当前价开始生效的时刻，取下列时刻的较晚者：当前生效单剧修订的生效时间；按模板定价时，另取该剧当前等级模板价的生效时间与该剧最近一次改热度等级的时刻（改等级即时变价、不产生修订行，`drama.heat_tier` 没有历史列，07:337） | `drama_price_revision.effective_at`；`price_tier_revision.effective_at`；`audit_log.created_at`（`target_type = 'drama'`、`target_id` = 剧目、`action = 'drama.heat_tier.change'` 的最新一行，经 `ix_audit_log_target`，3.8） |
| `pendingRevision` | object `{ dramaPriceRevisionId, newPoints, effectiveAt }` \| null | 是 | 最早一条待生效的调价 | `drama_price_revision` |
| `planPrices` | array<PlanPrice> | 是 | 基础版、专业版、旗舰版实扣 | 2.1 |
| `licenseEndDate`、`stopOrderDate`、`licenseFlag`、`isExpiringSoon` | 同 `DramaRow` | 是 | “授权期至”与“可订购 / 90 天内到期 / 未上架” | 2.1 |
| `canCreatePriceRevision` | boolean | 是 | “调价”按钮是否可点 | 权限点 `billing.price.edit` 且 `priceLockReason` 为空 |
| `priceLockReason` | enum(`stopped`/`license_ended`/`archived`) \| null | 是 | 不能调价的原因（3.33） | 计算 |

`DramaPriceRevision`（调价记录行）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `dramaPriceRevisionId` | string(uuid) | 是 | 修订 | `drama_price_revision.id` |
| `dramaId`、`dramaTitle` | string(uuid)、string | 是 | 剧目 | `drama_price_revision.drama_id`；`drama.title` |
| `mode` | enum(`template`/`custom`) | 是 | 定价方式 | `drama_price_revision.mode` |
| `customPoints` | integer(积分) \| null | 是 | 单剧积分价 | `drama_price_revision.custom_points` |
| `prevPoints` | integer(积分) \| null | 是 | 旧价（“《老街烟火》2,000 → 2,200”） | `drama_price_revision.prev_points` |
| `newPoints` | integer(积分) | 是 | 新价 | `drama_price_revision.new_points` |
| `effectiveAt` | string(date-time) | 是 | 生效时间 | `drama_price_revision.effective_at` |
| `reasonCode`、`note` | enum、string \| null | 是 | 调整原因与备注 | `drama_price_revision.reason_code`、`note` |
| `state` | enum `PriceRevisionState` | 是 | `pending` 待生效、`effective` 已生效、`withdrawn` 已撤销 | `cancelled_at` 非空 → `withdrawn`；`effective_at > now` → `pending`；否则 `effective` |
| `cancelledAt` | string(date-time) \| null | 是 | 撤销时间（撤销人看审计，07:31） | `drama_price_revision.cancelled_at` |
| `createdBy`、`createdAt` | StaffBrief、string(date-time) | 是 | 操作人与提交时间（“09-26 提交”） | `drama_price_revision.created_by_staff_id`、`created_at` |
| `actions` | array<enum> | 是 | `withdraw`（待生效且持 `billing.price.edit`） | 计算 |

`PriceTierRow`（等级模板价行）：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `priceTierRevisionId` | string(uuid) | 是 | 修订行 | `price_tier_revision.id` |
| `tier` | enum(`S`/`A`/`B`/`C`) | 是 | 等级 | `price_tier_revision.tier` |
| `points` | integer(积分) | 是 | 模板积分价 | `price_tier_revision.points` |
| `effectiveAt` | string(date-time) | 是 | 生效时间 | `price_tier_revision.effective_at` |
| `batchId` | string(uuid) | 是 | 同一次保存的变更集标识，等于同次保存写入 `billing_param.change_id` 的值（A94；a07 的变更记录按它聚合） | `price_tier_revision.batch_id` |
| `createdBy` | StaffBrief \| null | 是 | 播种行为空 | `price_tier_revision.created_by_staff_id` |
| `createdAt` | string(date-time) | 是 | — | `price_tier_revision.created_at` |
| `dramaCount` | integer | 是 | 适用剧目：未归档、`heat_tier` 等于该等级的剧数 | `drama.heat_tier`、`archived_at` |
| `templateDramaCount` | integer | 是 | 其中按模板定价的剧数 | 2.1 的定价方式 |

`PriceTierRow` 只有当前生效的 4 行（A93：V1.0 保存即生效）。“评定依据”一列（“全网爆款，话题度高”等）是不随数据变化的说明文案，由后台前端维护，不建字段；数据模型没有这一列（a07 3.18 写“由本接口提供”，已请 a07 改）。

### 2.12 批量上传的结构

`UploadBatchDetail`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `uploadBatchId` | string(uuid) | 是 | 批次 | `upload_batch.id` |
| `purpose` | enum(`drama_master`/`final_release`) | 是 | 用途 | `upload_batch.purpose` |
| `targetId` | string(uuid) | 是 | 原片批次为剧目 id，成片批次为订单项 id | `upload_batch.target_id` |
| `targetLabel` | string | 是 | 原片批次为剧名；成片批次由交付模块的 `delivery.authorizeUpload` 给出，格式“《剧名》· 工单号”（工单号含订单号，a05 1.3 `delivery.authorizeUpload`） | `drama.title`；`order_item.drama_snapshot.title` + `delivery_ticket.ticket_no`（a05） |
| `variant` | enum（同数据模型 `upload_batch.variant`） | 是 | V1.0 恒为 `common` | `upload_batch.variant` |
| `scope` | enum(`full`/`partial`) | 是 | 整部 / 部分集 | `upload_batch.scope` |
| `state` | enum（同数据模型 `upload_batch.state`） | 是 | 批次状态 | `upload_batch.state` |
| `expectedCount` | integer | 是 | 登记时的总集数快照 | `upload_batch.expected_count` |
| `replaceReason` | enum \| null | 是 | 替换原因（原片替换必填） | `upload_batch.replace_reason` |
| `isContentChanged` | boolean | 是 | 内容有实质变更，提交后须重新核验许可信息 | `upload_batch.is_content_changed` |
| `aiUsage` | object `AiUsage` \| null | 是 | 整批的 AI 使用声明（成片批次必有） | `upload_batch.ai_usage`（06 4.6） |
| `note` | string \| null | 是 | 备注 | `upload_batch.note` |
| `bucket`、`region`、`prefix` | string | 是 | 直传落点：写入区桶、地域、批次前缀 `incoming/b{uploadBatchId}/`（d5:300、1091；上传接口按 C59 返回桶与键） | 配置；`file_object.incoming_bucket` |
| `expiresAt` | string(date-time) | 是 | 有效期：最近一次活动后 72 小时，且不超过创建后 7 天 | `upload_batch.expires_at` |
| `committedAt` | string(date-time) \| null | 是 | 提交时间 | `upload_batch.committed_at` |
| `createdBy`、`createdAt`、`updatedAt` | StaffBrief、string(date-time) | 是 | 持有人（续签、续传只认本人） | `upload_batch.created_by_staff_id`、`created_at`、`updated_at` |
| `counts` | object `{ total, pending, uploaded, checked, rejected, skipped, replaced }` | 是 | 各状态条目数 | `upload_batch_item.state` 计数 |
| `coverage` | object `{ missingEpisodeNos, duplicateEpisodeNos, unmatchedItemIds, needsSequenceConfirm }` | 是 | 匹配与覆盖情况：`full` 未覆盖的集号、被多条有效条目占用的集号、未匹配的条目、是否有待人工确认的顺序建议；开始上传（3.25）与提交（3.29）按它判定 | 计算 |
| `items` | array<UploadBatchItem> | 是 | 全部条目（含已跳过、被取代），按集号、再按创建时间排序 | `upload_batch_item` |
| `actions` | array<enum> | 是 | `start`、`refresh-credentials`、`commit`（仅原片批次）、`cancel` | 计算：状态 + 持有人 + 权限 |

`UploadBatchItem`：

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `uploadBatchItemId` | string(uuid) | 是 | 条目 | `upload_batch_item.id` |
| `fileId` | string(uuid) | 是 | 条目对应的文件 | `upload_batch_item.file_id` |
| `originalName` | string | 是 | 原始文件名（匹配集号的依据） | `upload_batch_item.original_name` |
| `sizeBytes` | string(bigint) | 是 | 登记大小 | `file_object.declared_size` |
| `uploadKey` | string \| null | 是 | 写入区对象键，供 SDK 直传与续传；入库后为空 | `file_object.incoming_key` |
| `fileStatus` | enum（同数据模型 `file_object.status`） | 是 | 文件状态 | `file_object.status` |
| `rejectReason` | enum \| null | 是 | 拒收原因 | `file_object.reject_reason` |
| `episodeNo` | integer \| null | 是 | 匹配到的集号；空 = 未匹配 | `upload_batch_item.episode_no` |
| `episodeTitle` | string \| null | 是 | 原片批次：该集的单集标题（对照表“第 3 集 · 老主顾”）；成片批次、未匹配的条目为空 | `drama_episode.title`（按 `upload_batch.target_id`、`episode_no` 关联） |
| `matchMethod` | enum（同数据模型 `upload_batch_item.match_method`） \| null | 是 | 文件名模板 / 顺序建议 / 人工指定 | `upload_batch_item.match_method` |
| `state` | enum（同数据模型 `upload_batch_item.state`） | 是 | 条目状态 | `upload_batch_item.state` |
| `durationMs` | integer \| null | 是 | 入库探测的时长 | `media_info.duration_ms` |
| `previousDurationMs` | integer \| null | 是 | 原片批次：该集当前原片的时长（对照表“时长（原 → 新）”） | `drama_episode_master.duration_ms`（`is_current`） |
| `isDurationDiffWarn` | boolean | 是 | 新旧时长相差超过 2 秒，页面标黄（d5:1188） | 计算 |
| `check` | object \| null | 是 | 体检结论 `{ gate, failedHard: [{ code, actual, expected }], warnings: [{ code, note }] }`；未体检为空 | `media_check.gate`、`hard`、`soft` |
| `aiUsage` | object `AiUsage` \| null | 是 | 条目级声明；空表示用批次的 | `upload_batch_item.ai_usage` |
| `updatedAt` | string(date-time) | 是 | — | `upload_batch_item.updated_at` |

`AiUsage = { used, tools: [{ name, version, usedFor }], declaredBy, declaredAt, forcedByDrama }`，同数据模型 06 4.6；请求里只提交 `used`、`tools`，其余由服务端补（`forcedByDrama` 在剧目 `is_ai_generated` 为真时置真并强制 `used = true`，d5:1022）。

`BatchUploadCredentials`（3.26 的响应）：

云存储沿用整批 STS 分片凭据；local/test 的 MinIO 不支持 STS，返回 `mode = post` 的逐文件表单。客户端按 `mode` 分支，省略 `mode` 的旧响应仍按 `multipart` 处理。

| 字段 | 类型 | 必有 | 说明 |
| --- | --- | --- | --- |
| `mode` | `multipart` | 否 | 云存储分片模式；兼容未带此字段的旧响应 |
| `bucket`、`region`、`prefix` | string | 是 | 同 `UploadBatchDetail` |
| `sts` | object `{ tmpSecretId, tmpSecretKey, sessionToken, startTime, expiredTime }` | 是 | 临时密钥，只能写 `prefix` 下的对象（d5:1091），30 分钟；`startTime`、`expiredTime` 为 string(date-time)，与 a01 `FileRegistration.sts` 一致 |
| `chunkSize` | integer | 是 | 分块字节数（8MB，d5:1187） |
| `fileParallel`、`chunkParallel` | integer | 是 | 文件并发 3、分块并发 4 |
| `expiresAt` | string(date-time) | 是 | 密钥到期时刻（C34 格式） |

`sts` 与 a01 `FileRegistration.sts` 同构，契约里共用一个 schema。

本地 POST 分支保留 `bucket`、`region`、`prefix`、`fileParallel`、`expiresAt`，不包含 `sts`、`chunkSize`、`chunkParallel`；增加必填 `mode = post` 及 `posts` 数组。每项为 `{ fileId, key, post: { url, fields }, expiresAt }`，只为当前仍待上传的文件签发，策略绑定真实对象键、MIME 和登记大小，有效期 600 秒。签发前后重新核验权限、批次状态和条目绑定，文件被替换、确认或目标被归档后不返回旧策略。POST 不支持分块续传；跨刷新先调用完成确认核查已上传对象，缺失时由用户替换或重试，不将本地文件选择当作服务端已有字节。

## 3. 接口

### 3.1 admin.drama.list　短剧列表

`GET /admin/dramas`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 查看；数据范围 `global` |
| 回显 | 无 |
| 幂等 | none（纯查询，A18） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:Dramas；A:OpsHome、A:OpsMall 的选剧下拉 |
| 出处 | 路线图 `a04.dramas.list`；d8:525；proto-admin-c.md:44-52 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `page`、`pageSize` | integer | 否 | C43 | 页面传 `pageSize=12`（原型“每页 12 部”） |
| 查询 | `q` | string | 否 | ≤20 字 | 剧名包含（去掉空格后匹配） |
| 查询 | `status` | enum（多值） | 否 | `draft`、`listed`、`delisted` | 状态 |
| 查询 | `genreCode` | string | 否 | 字典 `genre` 的编码 | 题材 |
| 查询 | `industryCode` | string | 否 | 字典 `industry` 的一级编码 | 适配行业包含该编码（`drama.industry_codes`）；首页“按行业置顶”的选剧下拉用 |
| 查询 | `heatTier` | enum（多值） | 否 | `S`/`A`/`B`/`C` | 热度 |
| 查询 | `dramaClass` | enum（多值） | 否 | `class_1`/`class_2`/`class_3` | 微短剧类别 |
| 查询 | `isExpiringSoon` | boolean | 否 | — | `true` 只看已上架且 N 天内授权到期的（原型“仅看 90 天内授权到期”，N 见 2.1） |
| 查询 | `isOrderable` | boolean | 否 | — | `true` 只看 `licenseFlag = orderable` 的（选剧下拉用：置顶与 Banner 只能引用在架可订的剧） |
| 查询 | `isArchived` | boolean | 否 | — | 不传不过滤 |
| 查询 | `sort` | enum `DramaSort` | 否 | 默认 `-updatedAt` | `-updatedAt`、`-createdAt`、`-firstListedAt`、`licenseEndDate`、`-ordersMtd`、`title`；服务端追加 `id`（C44） |

**响应 `data`**：页码分页 `{ items: DramaRow[], page, pageSize, total }`（2.3）。

**错误**：`VALIDATION_FAILED`（参数不合法）。

**副作用**：无。

**说明**：
- 积分价列经 `DramaPricePort.priceAt` 批量取，已调整时同时给模板价（d8:525、579）。“上线中成片”“9 月订购”取 `drama_stat`（每小时由周期任务刷新，05:390），草稿行页面显示“—”。
- “MM-DD 起停止订购”“授权已结束”按 2.1 现算，不落库（05:15）。
- 首页置顶每个行业至多 1 部（原型 OpsHome“每个行业最多置顶 1 部短剧”）：选剧下拉带 `industryCode` 与 `isOrderable=true`，并显示行的 `industries` 供运营核对。
- 导出（PRD 7 “所有列表支持导出”，proto-admin-c.md:63）走 `admin.exportJob.create`（a02），`exportKey = dramas.list`；`params` 与本接口的查询参数同构（去掉 `page`、`pageSize`），列与 `DramaRow` 一致（不含签名地址与 `actions`）；导出权限点 `drama.export`（A88 已补登：默认授予有短剧库查看权的角色，不要求再验证）；`exportKey` 由 a02 登记。

### 3.2 admin.drama.summary　短剧库页首计数

`GET /admin/dramas/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 查看；`global` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:Dramas（页首“已上架 22 部 · 草稿 3 部 · 已下架 3 部 · 授权期 90 天内结束 1 部，已停止订购”） |
| 出处 | 路线图 `a04.dramas.summary`；d8:525；proto-admin-c.md:44、53；A23、C83 |

**请求**：查询参数与 3.1 相同（去掉 `page`、`pageSize`、`sort`）；页首计数不带筛选。

**响应 `data`**

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `counts` | object `{ draft, listed, delisted }` | 是 | 按状态计数，键与 `status` 取值一致（含已归档的已下架剧） | `drama.status` |
| `archived` | integer | 是 | 已归档部数 | `drama.archived_at` |
| `stopped` | integer | 是 | 已上架且已停止订购的部数 | 2.1 |
| `expiringSoon` | integer | 是 | 已上架且 N 天内授权到期的部数 | 2.1 |
| `expiringSoonStopped` | integer | 是 | 其中已停止订购的部数（“…结束 1 部，已停止订购”） | 2.1 |
| `expiringWindowDays` | integer | 是 | N，页面据此显示“90 天内” | 参数 `remind.copyright.days` |
| `minLicenseMonths` | integer | 是 | 最短可订月数，页面据此显示“剩余授权期不足 3 个月” | `billing_param` 键 `minLicenseMonths`，经 `DramaPricePort.minLicenseMonths`（A79：`summary` 可带页头上下文） |

**错误**：`VALIDATION_FAILED`。

**副作用**：无。

### 3.3 admin.drama.create　新建短剧草稿

`POST /admin/dramas`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 编辑；`global` |
| 回显 | 无 |
| 幂等 | required（新建即状态迁移 `— → draft`，A17）；结果脱敏（2.1） |
| 乐观锁 | 不适用（新建） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:Dramas“新建短剧”→ A:DramaEdit |
| 出处 | 路线图 `a04.dramas.create`；05:143；d8:526；proto-admin-c.md:54 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 请求体 | `title` | string | 是 | 1–20 字（05:56） | 剧名；其余资料进入编辑页后按页签保存 |

**响应 `data`**：`AdminDramaDetail`（2.4）＋ `replayed`。

**错误**：`VALIDATION_FAILED`（剧名为空或超长）。

**副作用**：
- 迁移 `drama.status: — → draft`（事件 `drama.create`，05:143）：插入 `drama`（`status_changed_at` = 当前时刻，`created_by_staff_id` = `updated_by_staff_id` = 当前员工，`lock_version = 0`，数组列为空）；同事务建 `drama_copyright` 空行（`lock_version = 0`）；写 `status_transition`（`machine = drama`、`from_state` 为空、`entity_id`、`store_id` 为空，01:430）与一条审计（“创建草稿”）。
- 发 `drama.created { dramaId }`（x01 事件目录；V1.0 无订阅者）；不登记定时器。

**说明**：剧名不要求唯一（数据模型没有唯一约束）。新建的剧没有剧集行，填写总集数时由 3.7 补齐。

### 3.4 admin.drama.get　短剧详情

`GET /admin/dramas/{dramaId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 查看；`global` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 返回 `lockVersion`、`copyright.lockVersion` 供后续保存 |
| 限流 / 开关 | `admin.global` / `weapp.video.trailer.enabled` 决定 L6 的严重度（2.8） |
| 对应画板 | A:DramaEdit（页头、5 个页签、右栏积分价与上架校验） |
| 出处 | 路线图 `a04.dramas.get`；d8:527；proto-admin-c.md:81-92 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaId` | string(uuid) | 是 | — | 剧目 |

**响应 `data`**：`AdminDramaDetail`（2.4）。许可行、剧集行、操作日志各有列表接口（3.12、3.16、3.5），不在详情里重复。

**错误**：`NOT_FOUND`。

**副作用**：无。

**说明**：页签“有待补充项”的红点按 `listingChecks.items` 中未过项的 `fixTab` 显示（proto-admin-c.md:107）。草稿与已上架的按钮文案（“保存草稿 / 保存修改”“上架 / 已上架”）按 `status` 显示。

### 3.5 admin.drama.activity.list　剧目操作日志

`GET /admin/dramas/{dramaId}/activities`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 查看；`global` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit 右栏“操作日志” |
| 出处 | 路线图 `a04.dramas.list-activities`（d8 写作 `GET /dramas/{id}/logs`）；d8:270、536；03:560、639 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaId` | string(uuid) | 是 | — | 剧目 |
| 查询 | `cursor` | string | 否 | 不透明 | 首页不传 |
| 查询 | `limit` | integer | 否 | 默认 20，上限 50 | — |

**响应 `data`**：`{ items: ActivityItem[], nextCursor, hasMore, totalApprox }`（行结构为 a05 的 `ActivityItem`，2.7）。`audit_log` 是只增大表，按 A22 用游标并返回封顶的近似总数（上限 10,000）。

**错误**：`NOT_FOUND`。

**副作用**：无。

**说明**：读 `audit_log` 中 `target_type = 'drama'`、`target_id = dramaId`、`stream IN ('ops','activity')` 的行，按 `(created_at, seq)` 倒序（索引 `ix_audit_log_target`）。每次状态迁移在审计里恰好一行（03:639），迁移原因、说明在审计行的 `reason_text` 里；状态迁移的行按同一 `request_id`、同一对象补 `transition`（`status_transition`，与 a05 相同）。`access` 流（证照文件签发留痕）不在这里展示。操作日志保留不少于 3 年（d8:278）。

### 3.6 admin.drama.listingChecks.get　上架校验结果

`GET /admin/dramas/{dramaId}/listing-checks`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 查看；`global` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `admin.global` / `weapp.video.trailer.enabled`（L6 严重度） |
| 对应画板 | A:DramaEdit 右栏“上架校验” |
| 出处 | 路线图 `a04.dramas.listing-checks`；d8:330-351、533；05:151；proto-admin-c.md:90、98 |

**请求**：路径 `dramaId`。

**响应 `data`**：`ListingCheckResult`（2.8）。

**错误**：`NOT_FOUND`。

**副作用**：无。按需计算，不落库；“刷新上架校验结果”只让目录缓存版本号加 1（05:151）。

**说明**：各页签保存后页面重新调用本接口刷新右栏。L6 在 V1.0 为提示项：设计规范第 14 节第 11 项“上架是否仍要求必须上传预告片”改为选填（d8:341；风险文档第 0 节）。

### 3.7 admin.drama.basic.update　保存基础信息

`PATCH /admin/dramas/{dramaId}/basic`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 编辑；`global` |
| 回显 | 无 |
| 幂等 | required（内容编辑，A17）；结果脱敏（2.1） |
| 乐观锁 | 请求体带 `lockVersion`（剧目的，A21） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit“基础信息”页签；“许可信息”页签的“微短剧类别” |
| 出处 | 路线图 `a04.dramas.update-basic`；A27；d8:328、528；05:56-81；proto-admin-c.md:85、97 |

**请求**（`PATCH`：不传 = 不改；可空字段传 `null` = 清空，C38）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaId` | string(uuid) | 是 | — | 剧目 |
| 请求体 | `lockVersion` | integer | 是 | — | 剧目的锁版本 |
| 请求体 | `title` | string | 否 | 1–20 字 | → `drama.title` |
| 请求体 | `posterFileId` | string(uuid) \| null | 否 | 已入库、分类 `poster` | → `drama.poster_file_id` |
| 请求体 | `totalEpisodes` | integer \| null | 否 | 1–999 | → `drama.total_episodes`；已上架的剧不可改 |
| 请求体 | `episodeDurationSec` | integer \| null | 否 | > 0 | → `drama.episode_duration_sec`（原型自由文本“约 1 分 30 秒”改为秒，d8 C14） |
| 请求体 | `genreCodes` | array<string> | 否 | 字典 `genre` 中启用的编码，不重复 | → `drama.genre_codes` |
| 请求体 | `sellingTagCodes` | array<string> | 否 | 字典 `selling_tag` 中启用的编码，至多 3 个 | → `drama.selling_tag_codes`（页面“标签”） |
| 请求体 | `producerName` | string \| null | 否 | ≤50 字（本稿补充） | → `drama.producer_name` |
| 请求体 | `castNames` | string \| null | 否 | ≤100 字（本稿补充） | → `drama.cast_names`（主演，参与搜索） |
| 请求体 | `synopsis` | string \| null | 否 | ≤300 字 | → `drama.synopsis` |
| 请求体 | `dramaClass` | enum \| null | 否 | `class_1`/`class_2`/`class_3` | → `drama.drama_class`（A27） |
| 请求体 | `isAiGenerated` | boolean | 否 | — | → `drama.is_ai_generated`（A27） |

已停用的字典编码：原来就有的可以保留，新加入的必须是启用的（字典停用不影响已标注的剧，d8:258）。新加入的编码按 C85 调 `dicts.assertEnabled` 校验。

**响应 `data`**：`AdminDramaDetail`（2.4）＋ `replayed`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 字段不合约束（`fieldErrors` 定位到字段） |
| `DICT_ITEM_DISABLED` | 409 | 新加入的字典编码不在字典里或已停用（m08 定义，C85）；`details = { dictTypeKey, code }`（`genre` 或 `selling_tag`） |
| `FILE_NOT_USABLE` | 400 | 封面文件未入库、分类不是 `poster` 或被内容安全拦截 |
| `PLACEMENT_NOT_OPEN` | 400 | 改为一类、二类后，已选的植入形式超出片头、片尾贴片 |
| `TOTAL_EPISODES_LOCKED` | 409 | 已上架的剧修改总集数（d8:151） |
| `EPISODE_HAS_MASTER` | 409 | 改小总集数时，要删去的集已有当前原片 |
| `LISTING_CHECK_FAILED` | 409 | 已上架的剧保存后出现阻断项（2.1） |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符 |
| `DRAMA_ARCHIVED` | 409 | 剧目已归档 |
| `NOT_FOUND` | 404 | 剧目不存在 |

**副作用**：
- 锁剧目行，更新所传列、`updated_by_staff_id`、`updated_at`，`lock_version + 1`。
- 改总集数（草稿或已下架）：同事务把 `drama_episode` 补齐或删到集号恰为 `1..N`（05:66、211）；删除前经 `media.dramaMediaReadiness` 确认这些集没有当前原片（05:213，M95）。
- 封面：新封面以 `drama` / `poster` 登记引用；被替换的封面不释放（订单项快照仍指向旧封面，05:455）。
- 审计：前后值。已上架的剧刷新目录缓存版本号。不发出站事件。

**说明**：
- “微短剧类别”在页面上属于许可信息页签，按 A27 由本接口保存。它决定 L1 的必备编号种类与 L11 的植入范围（d8:336、346）。
- `isAiGenerated` 只影响之后登记的成片、样片（AI 声明被强制为已使用，d5:1022）与之后设置的预告片（追加“AI 生成”水印，d8:463），已有文件不变。
- 有在途的原片批次时改总集数，该批次提交时会因总集数与登记快照不一致而失败（3.29）。

### 3.8 admin.drama.commercial.update　保存商业信息

`PATCH /admin/dramas/{dramaId}/commercial`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 编辑；`global` |
| 回显 | 无 |
| 幂等 | required；结果脱敏（2.1） |
| 乐观锁 | 请求体带 `lockVersion`（剧目的） |
| 限流 / 开关 | `admin.global` / 参数 `content.placement.open_slots` 决定可选的植入形式 |
| 对应画板 | A:DramaEdit“商业信息”页签 |
| 出处 | 路线图 `a04.dramas.update-commercial`；A27；d8:447、455、528；05:75-80；proto-admin-c.md:88 |

**请求**（`PATCH`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaId` | string(uuid) | 是 | — | 剧目 |
| 请求体 | `lockVersion` | integer | 是 | — | 剧目的锁版本 |
| 请求体 | `heatTier` | enum \| null | 否 | `S`/`A`/`B`/`C` | → `drama.heat_tier` |
| 请求体 | `manualBoost` | integer | 否 | 0–100 | → `drama.manual_boost`（A27；综合排序的人工加权） |
| 请求体 | `industryCodes` | array<string> | 否 | 字典 `industry` 一级、启用的编码，不重复 | → `drama.industry_codes` |
| 请求体 | `targetAudience` | string \| null | 否 | ≤100 字（本稿补充） | → `drama.target_audience` |
| 请求体 | `allowedPlacements` | array<enum `PlacementSlot`> | 否 | 不重复；都在 `content.placement.open_slots` 内；一类、二类只能是 `opening`、`ending` | → `drama.allowed_placements` |

试看集数（`drama.trial_episode_count`）是 V1.1，V1.0 的契约不声明该请求字段（原型输入框标“V1.1”）。

**响应 `data`**：`AdminDramaDetail` ＋ `replayed`。

**错误**：`VALIDATION_FAILED`；`DICT_ITEM_DISABLED`（409，新加入的行业编码不在字典 `industry` 里或已停用，m08 定义，C85；已有的停用编码可保留）；`PLACEMENT_NOT_OPEN`（400，含未开放的 `corner`、`mid_roll`，d8:455）；`LISTING_CHECK_FAILED`（已上架的剧清空等级或植入形式等）；`VERSION_CONFLICT`；`DRAMA_ARCHIVED`；`NOT_FOUND`。

**副作用**：
- 锁剧目行，更新所传列，`lock_version + 1`；审计前后值。热度等级有变化时审计 `action` 记 `drama.heat_tier.change`（其余为普通的商业信息保存），单剧积分价页的“生效时间”据此取改等级的时刻（2.11）。
- 热度等级有变化时同事务发 `drama.tier_changed { dramaId, fromTier, toTier }`（05:447；d8:447；载荷按 x01）。按模板定价的剧积分价立即变；billing 订阅它，在 `P` 实际变化时发 `pricing.drama_price_changed`（07:1600；d8:641 第 ② 项），选剧单读取时显示“积分价已变动”（d1:715）。
- 已上架的剧刷新目录缓存版本号。

**说明**：改热度等级即时生效，不产生调价记录（05 第 6 节第 5 项、d8 C7，仍待业务确认，第 6 节第 4 项）。等级卡片上的“模板积分价”取 `AdminDramaDetail.pricing.tierTemplates`。

### 3.9 admin.drama.cast.replace　保存角色介绍

`PUT /admin/dramas/{dramaId}/cast`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 编辑；`global` |
| 回显 | 无 |
| 幂等 | required（整体替换带锁版本，A17）；结果脱敏（2.1） |
| 乐观锁 | 请求体带 `lockVersion`（剧目的） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit“角色介绍”弹窗 |
| 出处 | 路线图 `a04.dramas.replace-roles`（第二轮按 A61 改为本条的 operationId 与路径）；d8:528；05:73、466；proto-admin-c.md:85、101 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaId` | string(uuid) | 是 | — | 剧目 |
| 请求体 | `lockVersion` | integer | 是 | — | 剧目的锁版本 |
| 请求体 | `roles` | array<DramaRole> | 是 | 0–8 个，顺序即商家端展示顺序 | → `drama.roles` 整表替换 |
| 请求体 | `roles[].name` | string | 是 | 1–20 字（本稿补充） | 角色名 |
| 请求体 | `roles[].actor` | string \| null | 否 | ≤20 字 | 饰演者 |
| 请求体 | `roles[].desc` | string | 是 | 1–100 字（本稿补充） | 角色简介（展示在短剧详情） |

**响应 `data`**：`AdminDramaDetail` ＋ `replayed`。

**错误**：`VALIDATION_FAILED`（超过 8 个；角色名或简介为空，`fieldErrors.path` 如 `roles.1.desc`，页面提示“第 2 个角色的角色名和简介不能为空”）；`VERSION_CONFLICT`；`DRAMA_ARCHIVED`；`NOT_FOUND`。

**副作用**：锁剧目行，替换 `drama.roles`，`lock_version + 1`；审计（“更新角色介绍（5 个角色）”，前后值）。已上架的剧刷新目录缓存版本号。

**说明**：A61 把剧目的演员子资源命名为 `cast`：路线图的 `roles` 与员工角色 `staff_role` 的资源名 `roles`（`/admin/roles/{roleKey}`）重名，违反“一张表一个资源名、名字不得重复”（C10）。`cast` 按 A61 登记为父资源下的单例子资源（`resources.json` 的 `drama` 一项已登记）。资源名只管路径；请求体与 `AdminDramaDetail` 里的字段名第三轮改为 `roles`（与 m04 `DramaDetail.roles`、列 `drama.roles` 一致；叫 `cast` 会与相邻的 `castNames` 主演混淆，m04 的请求）。

### 3.10 admin.drama.copyright.replace　草稿期保存版权信息

`PUT /admin/dramas/{dramaId}/copyright`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 编辑；`global` |
| 回显 | 无 |
| 幂等 | required；结果脱敏（2.1） |
| 乐观锁 | 请求体带 `lockVersion`（版权当前值的 `drama_copyright.lock_version`） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit“版权信息”页签（原型是只读展示且缺“改编权”，按 PRD 改为可编辑并补齐，proto-admin-c.md:87、115） |
| 出处 | 路线图 `a04.dramas.replace-copyright`；d8:530；05:280-300、374 |

**请求**（`PUT` 整体替换：下列字段都要传，可空的传 `null`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaId` | string(uuid) | 是 | — | 剧目 |
| 请求体 | `lockVersion` | integer | 是 | — | 版权当前值的锁版本 |
| 请求体 | `source` | enum \| null | 是 | `own`/`licensed` | → `drama_copyright.source` |
| 请求体 | `platforms` | array<enum> | 是 | `douyin`、`wechat_channels`，不重复 | → `drama_copyright.platforms` |
| 请求体 | `territory` | string \| null | 是 | ≤50 字（本稿补充） | → `drama_copyright.territory` |
| 请求体 | `hasNetworkRight`、`canSublicense`、`canEditEmbed`、`canAdapt` | boolean | 是 | — | → 同名四列 |
| 请求体 | `licenseStartDate`、`licenseEndDate` | string(date) \| null | 是 | 两者都有值时止日不早于起日 | → `license_start_date`、`license_end_date` |
| 请求体 | `proofFileIds` | array<string(uuid)> | 是 | 0–10 个；已入库、分类 `drama_license_doc` | → `drama_copyright.proof_file_ids` |

**响应 `data`**：`AdminDramaDetail` ＋ `replayed`。

**错误**：`VALIDATION_FAILED`（止日早于起日等）；`FILE_NOT_USABLE`；`COPYRIGHT_REVISION_REQUIRED`（409，剧目上架过）；`VERSION_CONFLICT`；`NOT_FOUND`。

**副作用**：锁剧目行与版权行，更新 `drama_copyright` 各列，`drama_copyright.lock_version + 1`；新的权属证明以 `drama_copyright` / `proof` 登记引用，被移出的释放并保留 30 天（剧目从未上架，05:456）；审计（“填写版权信息并上传授权合同”，前后值）。不写修订行（05:374），不发事件。

**说明**：只用于从未上架的剧（`drama.first_listed_at` 为空）；上架过的剧（含已下架的）版权的任何变更都走 3.11。自有版权也必须填止日，否则过不了 L2（d8 C13，05 第 6 节第 3 项）。

### 3.11 admin.drama.dramaCopyrightRevision.create　版权变更

`POST /admin/dramas/{dramaId}/drama-copyright-revisions`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `drama.copyright.revise`（d8 新增，A129 增补表）+ 模块 drama 查看；`global` |
| 回显 | 要求 `confirm.prevEndDate`：回显变更前的止日，服务端与当前值比对（C54；d8:531“须二次确认”） |
| 幂等 | required；结果脱敏（2.1，路径 `drama.posterUrl`、`drama.trailer.coverUrl`） |
| 乐观锁 | 请求体带 `lockVersion`（版权当前值的） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit“版权信息”页签（原型未画入口，按 d8 补“版权变更”弹窗） |
| 出处 | 路线图 `a04.drama-copyright-revisions.create`；d8:228-240、409-414、531；05:336-374 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaId` | string(uuid) | 是 | — | 剧目 |
| 请求体 | `lockVersion` | integer | 是 | — | 版权当前值的锁版本 |
| 请求体 | `changeKind` | enum | 是 | `extend`、`shorten`、`scope_change`、`correction`（`initial` 只由上架写） | → `drama_copyright_revision.change_kind` |
| 请求体 | `copyright` | object | 是 | 字段同 3.10 请求体（不含 `lockVersion`），表示变更后的完整值；`licenseEndDate` 不可为空 | → `drama_copyright` 当前值与修订的 `copyright_snapshot` |
| 请求体 | `reason` | string | 是 | 1–200 字（本稿补充） | → `drama_copyright_revision.reason` |
| 请求体 | `revisionProofFileIds` | array<string(uuid)> | 是 | 1–10 个；已入库、分类 `drama_license_doc` | 本次变更的依据文件（续期合同等）→ `drama_copyright_revision.proof_file_ids` |
| 请求体 | `confirm.prevEndDate` | string(date) | 是 | — | 回显当前止日 |

**响应 `data`**：`{ revision: CopyrightRevision, drama: AdminDramaDetail, replayed }`（2.10、2.4）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 字段不合约束 |
| `FILE_NOT_USABLE` | 400 | 依据文件或权属证明不可用 |
| `COPYRIGHT_NO_CHANGE` | 400 | 变更后的值与当前值完全相同 |
| `COPYRIGHT_CHANGE_KIND_MISMATCH` | 400 | 修订类型与前后值的差异不符：`extend` 新止日不晚于旧止日、`shorten` 新止日不早于旧止日、`scope_change` 改了止日或什么都没改（05:366） |
| `LICENSE_SHORTEN_NOT_OPEN` | 409 | `shorten`，或使止日变早的 `correction`：在交付侧改为单向顺延前不开放（d8:413） |
| `LISTING_CHECK_FAILED` | 409 | 已上架的剧变更后出现阻断项（如权利项由真改假使 L3、L4 不过，须先下架，d8:236） |
| `CONFIRM_MISMATCH` | 409 | `confirm.prevEndDate` 与当前止日不一致 |
| `VERSION_CONFLICT` | 409 | `lockVersion` 不符 |
| `STATE_NOT_ALLOWED` | 409 | 剧目从未上架（直接用 3.10 保存） |
| `DRAMA_ARCHIVED` | 409 | 剧目已归档（05:374） |
| `NOT_FOUND` | 404 | 剧目不存在 |

**副作用**（同一事务，05:374）：
- 插入 `drama_copyright_revision`（只增）：`copyright_snapshot` 为变更后的完整值（`DramaCopyrightSnapshot`，05:467），`prev_end_date` = 变更前止日，`new_end_date` = 变更后止日。
- 更新 `drama_copyright` 当前值与 `current_drama_copyright_revision_id`，`lock_version + 1`。
- 文件引用：依据文件以 `drama_copyright_revision` / `proof` 登记，不随当前值替换而释放；当前值新增的权属证明以 `drama_copyright` / `proof` 登记，被移出的不释放（剧目上架过，05:456-458）。
- 审计（前后值、原因）。
- 出站事件由前后值的差异决定，不由 `changeKind` 决定（d8:239）：止日变晚发 `drama.license_extended { dramaId, dramaCopyrightRevisionId, prevEndDate, newEndDate }`；止日变早发 `drama.license_shortened`（载荷同上；V1.0 不会出现，见上）；授权平台或地域变化发 `drama.license_scope_changed { dramaId, dramaCopyrightRevisionId, platformsRemoved, platformsAdded, isTerritoryChanged }`（载荷按 x01）；只改来源、起日、权属证明、权利项的不发事件。一次变更同时改了止日与范围的，写一条修订行、事件各发一条。
- 定时器：剧目已上架且止日变了，`content.license_end` 改期到新止日次日 00:00（Asia/Shanghai，d8:567）：去重键含止日（`content.license_end:drama:{dramaId}:{licenseEndDate}`，x01），所以是取消旧行、登记新行。已下架的剧不登记，重新上架时登记。

**说明**：
- 续期后停止订购日随之后移；已因到期被系统下架的剧不自动恢复上架，须人工重新上架并重跑校验（d8:409）。
- 交付侧订阅 `drama.license_extended` 为受影响的订单项顺延使用期与下架任务，授权书随之换版（d8:409；交付与授权书归 a05 与 x01）。
- 原型没有修订历史的列表；历次变更在操作日志（3.5）里可见。需要单独的修订列表时再补 `GET …/drama-copyright-revisions`（第 6 节第 5 项）。

### 3.12 admin.drama.dramaPermit.list　许可行列表

`GET /admin/dramas/{dramaId}/drama-permits`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 查看；`global` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 返回 `dramaLockVersion` 供改许可行时使用 |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit“许可信息”页签 |
| 出处 | 路线图 `a04.drama-permits.list`；d8:183-188、529；05:229-269；proto-admin-c.md:86 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaId` | string(uuid) | 是 | — | 剧目 |
| 查询 | `status` | enum（多值） | 否 | `active`、`retired` | 不传返回全部 |

**响应 `data`**：`{ items: DramaPermit[], dramaClass, requiredKinds, dramaLockVersion }`。`items` 先活动行、后停用行，各按平台、种类排序；`requiredKinds` 为按类别必备的编号种类（一类、二类 `[license_no, approval_no]` 任一，三类 `[program_no]`；类别为空时为空数组，d8:336）。不分页：每部剧的活动行至多 9 条（3 个平台 × 3 种），停用行是换号留痕、数量很少（有界小集合，A78、C43 已登记；`dramaLockVersion` 按 A104 并列返回）。

**错误**：`NOT_FOUND`。

**副作用**：无。

**说明**：原型的两个输入框（许可证号、“批准文件编号或节目编号”）与一个剧目级扫描件上传项，按 d8:183、187 落成 `platform = all` 的行：第一个输入框记 `license_no`；第二个按类别判定种类（一类、二类 `approval_no`，三类 `program_no`），扫描件挂到按类别必备的那一行上。页面改为按行编辑（每行选平台、种类、编号并各自上传扫描件）后由操作人显式选择（d8 第 9 节 D7 第 ② 项）。“扫描件 · 2 页”的页数没有来源（第 6 节第 6 项）。

### 3.13 admin.drama.dramaPermit.create　新增许可行（含换号）

`POST /admin/dramas/{dramaId}/drama-permits`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 编辑；`global` |
| 回显 | 无 |
| 幂等 | required（新建行，A17） |
| 乐观锁 | 不带（新建）；在剧目行锁内执行，`drama.lock_version + 1` |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit“许可信息”页签（“上传文件”按钮：先 `admin.file.create`，再在这里登记） |
| 出处 | 路线图 `a04.drama-permits.create`；d8:183-188、529；05:264-269；proto-admin-c.md:100 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaId` | string(uuid) | 是 | — | 剧目 |
| 请求体 | `platform` | enum | 是 | `all`/`douyin`/`wechat_channels` | → `drama_permit.platform` |
| 请求体 | `permitKind` | enum | 是 | `license_no`/`approval_no`/`program_no` | → `drama_permit.permit_kind` |
| 请求体 | `permitNo` | string | 是 | 1–50 字（本稿补充） | → `drama_permit.permit_no` |
| 请求体 | `scanFileIds` | array<string(uuid)> | 否 | 0–10 个；已入库、分类 `drama_license_doc` | → `drama_permit.scan_file_ids` |
| 请求体 | `note` | string \| null | 否 | ≤200 字 | → `drama_permit.note` |
| 请求体 | `replacesDramaPermitId` | string(uuid) \| null | 否 | 本剧的活动行 | 换号：同一事务把该行置为停用（上架过的剧不原地改号，d8:185） |
| 请求体 | `retireReason` | string | 带 `replacesDramaPermitId` 时必填 | 1–200 字 | → 被换下行的 `drama_permit.retire_reason` |

**响应 `data`**：`{ permit: DramaPermit, retiredPermit: DramaPermit | null, dramaLockVersion }`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 字段不合约束；换号缺停用原因 |
| `FILE_NOT_USABLE` | 400 | 扫描件不可用 |
| `PERMIT_ACTIVE_EXISTS` | 409 | 同一平台、同一种类已有活动行，且没有在本次换下它（`uq_drama_permit_active`） |
| `STATE_NOT_ALLOWED` | 409 | `replacesDramaPermitId` 指向的行已停用 |
| `LISTING_CHECK_FAILED` | 409 | 已上架的剧保存后出现阻断项 |
| `DRAMA_ARCHIVED` | 409 | 剧目已归档 |
| `NOT_FOUND` | 404 | 剧目或被换下的行不存在 |

**副作用**：锁剧目行。换号时**先**把旧行置 `drama_permit.status: active → retired`（写 `retired_at`、`retire_reason`，05:269），**再**插入新行（`status = active`、`created_by_staff_id` = 当前员工）：`uq_drama_permit_active` 是部分唯一索引、不能延迟检查，换号的新行通常与旧行平台、种类相同，顺序反过来会撞约束。扫描件以 `drama_permit` / `scan` 登记引用；`drama.lock_version + 1`；审计（记在剧目上）；新增的行与换下的行各发一条 `drama.permit_changed { dramaId, dramaPermitId, platform }`（05:269、447；d8:552；载荷按 x01）。

**说明**：订单项与授权书里的许可号是下单时的快照，换号不影响已下的单（d8:185）；已生成的授权书是否换版待法务（d8 Q5）。

### 3.14 admin.dramaPermit.update　修改许可行

`PATCH /admin/drama-permits/{dramaPermitId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 编辑；`global` |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 请求体带 `dramaLockVersion`（剧目的 `lock_version`；`drama_permit` 没有锁列，2.1） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit“许可信息”页签 |
| 出处 | 路线图 `a04.drama-permits.update`；d8:185-186、529；05:265、269 |

**请求**（`PATCH`）

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaPermitId` | string(uuid) | 是 | — | 许可行 |
| 请求体 | `dramaLockVersion` | integer | 是 | — | 剧目的锁版本 |
| 请求体 | `platform`、`permitKind`、`permitNo` | 同 3.13 | 否 | 剧目上架过时不可改 | 草稿期可原地改号（d8:186） |
| 请求体 | `scanFileIds` | array<string(uuid)> | 否 | 同 3.13 | 整体替换该行的扫描件 |
| 请求体 | `note` | string \| null | 否 | ≤200 字 | — |

**响应 `data`**：`{ permit: DramaPermit, dramaLockVersion }`。

**错误**：`VALIDATION_FAILED`；`FILE_NOT_USABLE`；`PERMIT_FROZEN`（409，剧目上架过却改平台、种类或编号，`trg_drama_permit_guard`）；`PERMIT_ACTIVE_EXISTS`（改平台或种类后与另一活动行冲突）；`STATE_NOT_ALLOWED`（停用行不可改）；`LISTING_CHECK_FAILED`；`VERSION_CONFLICT`；`DRAMA_ARCHIVED`；`NOT_FOUND`。

**副作用**：锁剧目行与许可行，更新所传列，`drama.lock_version + 1`；扫描件引用：新加入的登记，被移出的在剧目从未上架时释放并保留 30 天，上架过则不释放（05:456）；审计（前后值，记在剧目上）。不发事件（`drama.permit_changed` 只在新增与停用时发，d8:552）。

### 3.15 admin.dramaPermit.retire　停用许可行

`POST /admin/drama-permits/{dramaPermitId}/retire`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 编辑；`global` |
| 回显 | 无 |
| 幂等 | required（行状态变更，A17） |
| 乐观锁 | 不带（行状态的单向变更，守卫是当前状态） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit“许可信息”页签 |
| 出处 | 路线图 `a04.drama-permits.retire`；d8:185、529；05:241-243、269 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaPermitId` | string(uuid) | 是 | — | 许可行 |
| 请求体 | `retireReason` | string | 是 | 1–200 字 | → `drama_permit.retire_reason` |

**响应 `data`**：`{ permit: DramaPermit, dramaLockVersion }`。

**错误**：`STATE_NOT_ALLOWED`（已停用）；`LISTING_CHECK_FAILED`（已上架的剧停用必备行使 L1 不过：应改用 3.13 的换号）；`DRAMA_ARCHIVED`；`NOT_FOUND`；`VALIDATION_FAILED`。

**副作用**：`drama_permit.status: active → retired`（写 `retired_at`、`retire_reason`；行状态，不写 `status_transition`，05:269）；扫描件引用在剧目从未上架时释放并保留 30 天，上架过则不释放；`drama.lock_version + 1`；审计；发 `drama.permit_changed { dramaId, dramaPermitId, platform }`。

### 3.16 admin.drama.dramaEpisode.list　剧集与原片列表

`GET /admin/dramas/{dramaId}/drama-episodes`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 查看；`global` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit“剧集管理”页签 |
| 出处 | 路线图 `a04.drama-episodes.list`；d8:532；05:182-213；06:1033-1082；proto-admin-c.md:89、110 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaId` | string(uuid) | 是 | — | 剧目 |
| 查询 | `page`、`pageSize` | integer | 否 | C43 | 原型“显示第 1～6 集，共 60 集” |
| 查询 | `masterState` | enum（多值） | 否 | `missing`、`processing`、`ready` | 原片状态筛选 |

**响应 `data`**：页码分页 `{ items: DramaEpisodeRow[], page, pageSize, total }`（2.6），按集号升序。

**错误**：`VALIDATION_FAILED`；`NOT_FOUND`。

**副作用**：无。

**说明**：原型的状态“转码中 / 已就绪”与“替换后重新转码，转码完成后自动生效”与 D5 不一致：原片不转码，新版本只在批次提交（3.29）时生效（d5:1190）。本接口用 `processing` 表示“在途批次覆盖该集、上传或体检中”，页面文案改为“处理中”（第 6 节第 7 项）。在途期间页面轮询 `admin.uploadBatch.get`，批次提交后再刷新本列表。

### 3.17 admin.dramaEpisode.update　修改剧集标题

`PATCH /admin/drama-episodes/{dramaEpisodeId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 编辑；`global` |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 请求体带 `dramaLockVersion`（`drama_episode` 没有锁列，2.1） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit“剧集管理”页签的标题列 |
| 出处 | 路线图 `a04.drama-episodes.update`；d8:143、532 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaEpisodeId` | string(uuid) | 是 | — | 剧集 |
| 请求体 | `dramaLockVersion` | integer | 是 | — | 剧目的锁版本 |
| 请求体 | `title` | string \| null | 是 | ≤30 字（本稿补充） | → `drama_episode.title` |

**响应 `data`**：`{ episode: DramaEpisodeRow, dramaLockVersion }`。

**错误**：`VALIDATION_FAILED`；`VERSION_CONFLICT`；`DRAMA_ARCHIVED`；`NOT_FOUND`。

**副作用**：锁剧目行，更新 `drama_episode.title`，`drama.lock_version + 1`；审计（记在剧目上）。时长不可手改，由原片回填（05:192）。

### 3.18 admin.drama.shelve　上架或重新上架

`POST /admin/dramas/{dramaId}/shelve`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `drama.shelf`（d4:1193）+ 模块 drama 查看；`global` |
| 回显 | 无 |
| 幂等 | required（状态迁移；同键重放返回上次结果，A17）；结果脱敏（2.1） |
| 乐观锁 | 不带：`drama.list`、`drama.relist` 的守卫没有列 `lock_version`（05:144、147；A21） |
| 限流 / 开关 | `admin.global` / `weapp.video.trailer.enabled`（L6 严重度） |
| 对应画板 | A:DramaEdit“上架”；A:Dramas“重新上架” |
| 出处 | 路线图 `a04.dramas.shelve`（原 `list-on-shelf` 与 `relist` 并入，A9）；05:144、147；d8:323-326、534；proto-admin-c.md:57、98 |

**请求**：路径 `dramaId`；请求体为空对象 `{}`。

**响应 `data`**：`AdminDramaDetail` ＋ `replayed`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `LISTING_CHECK_FAILED` | 409 | 服务端重跑校验有阻断项未过（含 L7“授权已结束”、L12“许可信息待重新核验”）；`details.failed` 列出未过的项 |
| `DRAMA_ARCHIVED` | 409 | 剧目已归档，不能重新上架（05:117、147） |
| `STATE_NOT_ALLOWED` | 409 | 剧目已是已上架 |
| `NOT_FOUND` | 404 | 剧目不存在 |

**副作用**：服务端按当前状态选迁移，锁剧目行后重读校验：
- 草稿：`drama.status: draft → listed`（`drama.list`，05:144）。写 `first_listed_at`、`listed_at`、`status_changed_at`；插入一条 `initial` 版权修订（`copyright_snapshot` = 当前值，`prev_end_date` 为空，`new_end_date` = 当前止日，`reason` = “首次上架”，`proof_file_ids` = 当前权属证明），回填 `drama_copyright.current_drama_copyright_revision_id`（`drama_copyright.lock_version + 1`），修订的依据文件以 `drama_copyright_revision` / `proof` 登记；登记定时器 `content.license_end`（`subject_type = drama`，去重键 `content.license_end:drama:{dramaId}:{licenseEndDate}`，到期时间为止日次日 00:00 Asia/Shanghai，05:445；d8:567；x01）；写 `status_transition`（`payload` 为当次校验摘要 `DramaListingCheckSummary`，05:468）；发 `drama.listed { dramaId, isRelist: false }`。
- 已下架：`drama.status: delisted → listed`（`drama.relist`，05:147）。守卫：未归档、授权未结束、阻断项全过。写 `listed_at`、`status_changed_at`，不动 `first_listed_at`，下架三列保留；不再写修订行（05:374）；登记定时器 `content.license_end`；写 `status_transition`（含校验摘要）；发 `drama.listed { dramaId, isRelist: true }`。
- 两者都：`drama.lock_version + 1`；一条审计（“通过上架校验，上架至短剧商城”）；刷新目录缓存版本号。

**说明**：上架后商城展示该剧，商家即可加入选剧单（原型 toast）；停止订购日已到的剧上架后也不可见（L8 为提示，d8:343）。

### 3.19 admin.drama.delist　下架

`POST /admin/dramas/{dramaId}/delist`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `drama.shelf` + 模块 drama 查看；`global` |
| 回显 | 无 |
| 幂等 | required；结果脱敏（2.1） |
| 乐观锁 | 不带（`drama.delist` 的守卫没有列 `lock_version`，05:145） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:Dramas“下架”弹窗 |
| 出处 | 路线图 `a04.dramas.delist`；05:145；d8:324、427、534；proto-admin-c.md:56 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaId` | string(uuid) | 是 | — | 剧目 |
| 请求体 | `reasonCode` | enum | 是 | `ops_strategy`、`rights_issue`、`content_revision`、`other`（`license_expired` 只由系统写） | → `drama.delist_reason_code` |
| 请求体 | `note` | string \| null | 否 | ≤200 字 | → `drama.delist_note`（未填置空；“记入操作日志”） |

**响应 `data`**：`AdminDramaDetail` ＋ `replayed`。

**错误**：`VALIDATION_FAILED`（原因缺失或为 `license_expired`、说明超长）；`STATE_NOT_ALLOWED`（不是已上架）；`NOT_FOUND`。

**副作用**（05:145）：
- `drama.status: listed → delisted`（`drama.delist`）：同一条 UPDATE 写 `delisted_at` = 当前时刻、`delist_reason_code`、`delist_note`、`status_changed_at`；`drama.lock_version + 1`。
- 取消该剧未触发的 `content.license_end` 定时器。
- 原因为 `rights_issue` 时调用 `media.retireDramaMedia(tx, dramaId, { scope: 'trailer', immediate: true })`，把预告片的当前资产与目标资产一并停用：`ready` 的 `playable_asset.state: ready → retired`（06:900）；仍在转码的 `processing → retired`、转码失败的 `failed → retired`（06:901，A141），同事务把其名下未结束的媒体任务置 `canceled`，否则转码完成后它按 06:897 的守卫（只看是否为目标）成为当前资产，下架后又在公开桶上分发。引用立即释放并刷新 CDN（06:1641）；原片不动（d8:427）。
- 写 `status_transition`（`reason_code`、`note`）与一条审计；发 `drama.delisted { dramaId, reasonCode }`；刷新目录缓存版本号。

**说明**：下架只影响之后的订购，已订购的订单继续履约，上线中成片使用期不受影响（d8:417-428）；弹窗提示的“当前上线中成片 N 部”取 `DramaRow.liveItems`。“版权或许可问题”下架时在途订单是否仍一律继续履约待业务与法务（d8 Q4）。

### 3.20 admin.drama.confirmPermitRecheck　确认许可信息仍适用

`POST /admin/dramas/{dramaId}/confirm-permit-recheck`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 编辑；`global` |
| 回显 | 无 |
| 幂等 | required；结果脱敏（2.1） |
| 乐观锁 | 不带（清除标记的单向动作，守卫是标记为真） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit“许可信息”页签（原型只有提示文案“内容有实质变更的，须重新核验许可信息”，proto-admin-c.md:118；按 d8 补按钮） |
| 出处 | 路线图 `a04.dramas.confirm-permit-recheck`；d8:347、535、560；05:83 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaId` | string(uuid) | 是 | — | 剧目 |
| 请求体 | `note` | string \| null | 否 | ≤200 字 | 核验说明，写进审计 |

**响应 `data`**：`AdminDramaDetail` ＋ `replayed`。

**错误**：`STATE_NOT_ALLOWED`（标记本来就为假）；`DRAMA_ARCHIVED`；`NOT_FOUND`。

**副作用**：锁剧目行，`drama.is_permit_recheck_required` 置 `false`，`drama.lock_version + 1`；审计（“确认许可信息仍适用于新原片”）。内容运营的“待重新核验”待办随之消失（读取时派生）。L12 由此恢复通过。

**说明**：标记由原片批次提交后的 `drama.masters_changed`（批次带 `is_content_changed`）在 content 的订阅处理里置位（05:83；d8:560），只能经本接口清除。批次的 `is_content_changed` 来自“批量替换原片”弹窗的勾选项，原型没有这一项，已列入设计规范第 12 节待补原型（A146）。待重新核验期间已上架的剧仍可见、可订，只拦截上架与重新上架（d8 C23，待法务确认）。若许可号确需更换，先在许可页签换号（3.13）再确认。

### 3.21 admin.drama.mediaReadiness.get　媒体就绪情况

`GET /admin/dramas/{dramaId}/media-readiness`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 drama 查看；`global` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit“基础信息”的预告片区、“剧集管理”页签头“共 60 集 · 已上传 60 集 · 均已转码完成”、找回在途批次 |
| 出处 | 路线图 `a04.dramas.media-readiness`；d5:2109；d8:644 第 ② 项；05:509 |

**请求**：路径 `dramaId`。

**响应 `data`**：`MediaReadiness`（2.9）。

**错误**：`NOT_FOUND`。

**副作用**：无。

**说明**：content 经同步调用 `media.dramaMediaReadiness()` 取数（白名单 `content → media`，05:509）。上架校验的 L6、L9（封面拦截）、L10 用同一份结果。页面在有在途批次时以 `openUploadBatches` 找回批次继续上传（重新选择同一批文件即可续传，d5:1192）。

### 3.22 admin.drama.trailer.replace　设置预告片

`PUT /admin/dramas/{dramaId}/trailer`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `drama.media.manage`（d5:2143，A129 增补表）+ 模块 drama 查看；`global` |
| 回显 | 无 |
| 幂等 | required（覆盖写也按 required，A17）；结果脱敏（2.1，路径 `coverUrl`） |
| 乐观锁 | 不带：`drama_trailer` 没有锁列，并发设置以最后一次为目标（`target_playable_asset_id`），迟到的转码结果不会覆盖较新的设置（06:1005）；C52 已登记为例外（A104） |
| 限流 / 开关 | `admin.global` / V1.0 小程序不播放预告片（风险文档第 0 节），后台仍可上传，转码不在关键路径上（d8:461） |
| 对应画板 | A:DramaEdit“基础信息”的“上传预告片（不超过 3 分钟）” |
| 出处 | 路线图 `a04.dramas.replace-trailer`；d5:1293-1306、2108；06:896-902、1003-1031；proto-admin-c.md:99 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaId` | string(uuid) | 是 | — | 剧目 |
| 请求体 | `sourceFileId` | string(uuid) | 是 | 已入库、分类 `trailer_src`、体检（`media_check.profile = trailer_src`）通过 | 预告片源文件；先经 `admin.file.create` 上传 |

**响应 `data`**：`TrailerBrief`（2.9）＋ `replayed`。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `FILE_NOT_USABLE` | 400 | 文件未入库、分类不是 `trailer_src` 或被拦截 |
| `TRAILER_SOURCE_CHECKING` | 409 | 源文件还在体检，稍后再试（可重试，端上用同一个幂等键自动重试） |
| `TRAILER_SOURCE_REJECTED` | 409 | 源文件体检不过（`details.reason = rejected`，如超过 180 秒，`details.failed` 列出硬性项）；或该源文件的预告片资产已停用（`reason = retired`），须重新上传源文件 |
| `DRAMA_ARCHIVED` | 409 | 剧目已归档 |
| `NOT_FOUND` | 404 | 剧目不存在 |

**副作用**（同一事务）：
- 新建 `playable_asset`（`kind = trailer`、`owner_type = drama`、`owner_id` = 剧目 id、`entity_id` 与 `store_id` 为空、`source_file_id`、当前 `spec_version`）：`playable_asset.state: — → processing`（06:896）。同一源文件、同一规格版本已有资产时（`uq_playable_asset_kind_source_file_id_spec_version` 不带条件）按资产状态处理（复用时不新建资产、不建媒体任务）：`processing`、`ready` 复用（`ready` 的就是当前资产，重复设置同一文件只刷新设置人与时间），不重复转码；`failed` 也复用并设为目标，页面显示失败原因，经 `admin.mediaJob.retry`（a01）重试（06:902 的就绪守卫要求它是目标资产，所以先设为目标再重试）；`retired` 是终态（06:900），拒绝并返回 `TRAILER_SOURCE_REJECTED`（`reason = retired`），否则目标会指向一个永不就绪的资产。典型场景：先设 A、再设 B（A 被停用）、回头又设 A，或版权问题下架停用后拿同一文件重设；页面提示重新上传源文件（新的 `fileId` 生成新资产）。
- 写入或更新 `drama_trailer`：`target_playable_asset_id` 指向新资产、`set_by_staff_id`、`set_at`；`current_playable_asset_id` 不变，旧资产照常播放到新资产就绪。
- 新建资产时建 `media_job`（`kind = transcode_mp4`，两档 480P、720P，`parent_type = playable_asset`；剧目 `is_ai_generated` 为真时追加“AI 生成”水印，d5:1301）。
- 新建资产时同事务登记源文件引用（`playable_asset` / `source`，06:896、1641；A141），转码超过 24 小时也不会被当作“从未被引用”清扫；档位文件、封面的引用（`rendition`、`cover`）在资产就绪时登记（06:1641）。复用已有资产时不重复登记。
- 审计（“上传预告片（2 分 40 秒）”，记在剧目上）。不在本事务发事件。

**说明**：之后由 worker 推进：全部任务成功且仍是目标资产时 `processing → ready`，`drama_trailer.current_playable_asset_id` 指向它、上一个资产 `ready → retired`，发 `drama.trailer_ready`（06:897、900；d8:561）；不是目标时直接 `retired`（06:899）；重试耗尽 `failed`，可经 `admin.mediaJob.retry`（a01）重试。这些迁移归 x01 的非 HTTP 归属表。员工预览预告片源文件走 `admin.file.downloadUrls`（a01）。

### 3.23 admin.uploadBatch.create　创建批量上传批次

`POST /admin/upload-batches`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`permission: assert-in-handler`（A45）：原片批次（`purpose = drama_master`）要求权限点 `drama.media.manage` + 模块 drama 查看；成片批次（`final_release`）要求 `delivery.episode.register`，且订单项的交付工单在本人的数据范围与任务归属内（剪辑师只能给分派给自己的任务上传），由交付模块注册的 `authorizeUpload` 判定（d5:1017；a05） |
| 回显 | 无 |
| 幂等 | required。键的值同时写入 `upload_batch.idempotency_key`（唯一约束 `uq_upload_batch_created_by_staff_id_idempotency_key`）：幂等记录 24 小时过期后，同一员工用同一个键再建，返回已有批次（用途与目标相同）或 409 `IDEMPOTENCY_KEY_REUSED` |
| 乐观锁 | 不适用（新建） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit“批量替换原片”弹窗与首次上传整部原片；A:TicketDetail 的成片批量上传 |
| 出处 | 路线图 `a04.upload-batches.create`；d5:1149-1192、2107；06:471-616；proto-admin-c.md:102-103、119 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 请求体 | `purpose` | enum | 是 | `drama_master`、`final_release` | → `upload_batch.purpose` |
| 请求体 | `targetId` | string(uuid) | 是 | 原片为剧目 id，成片为订单项 id | → `upload_batch.target_id` |
| 请求体 | `scope` | enum | 是 | `full`、`partial` | → `upload_batch.scope` |
| 请求体 | `replaceReason` | enum \| null | 原片替换时必填 | `quality_fix`、`license_info_fix`、`other`；成片批次必须为空 | → `upload_batch.replace_reason`（“其他”的说明写 `note`） |
| 请求体 | `isContentChanged` | boolean | 否 | 默认 `false`；只用于原片 | → `upload_batch.is_content_changed`；页面的“内容有实质变更（须重新核验许可信息）”勾选项；替换原因选“片头许可信息更正”（`license_info_fix`）时默认勾选，可取消。原型缺，已列入设计规范第 12 节待补原型（A146） |
| 请求体 | `note` | string \| null | 否 | ≤200 字 | → `upload_batch.note` |
| 请求体 | `aiUsage` | object `{ used, tools }` \| null | 成片必填，原片为空 | `tools[]` 元素 `{ name, version, usedFor }` | → `upload_batch.ai_usage`（服务端补 `declaredBy`、`declaredAt`、`forcedByDrama`，06 4.6） |
| 请求体 | `files` | array | 是 | 1 至 `expectedCount` 个；文件名不重复 | 浏览器选中的文件清单（只读文件名与大小，d5:1174） |
| 请求体 | `files[].clientToken` | string | 是 | ≤64，`[A-Za-z0-9_-]` | → `file_object.client_token`（续传标识） |
| 请求体 | `files[].originalName` | string | 是 | 1–255 字 | → `upload_batch_item.original_name`、`file_object.original_name`；匹配集号的依据 |
| 请求体 | `files[].sizeBytes` | string(bigint) | 是 | > 0，不超过该分类的单文件上限 | → `file_object.declared_size` |

**响应 `data`**：`UploadBatchDetail`（2.12）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 字段不合约束；原片替换缺替换原因；成片缺 AI 使用声明 |
| `BATCH_FILE_INVALID` | 400 | 清单里有扩展名不在分类登记表内、ZIP、超过单文件上限、空文件、重名或超过集数的文件；`details.files` 逐个给出 `{ index, reason }` |
| `TOTAL_EPISODES_MISSING` | 409 | 剧目还没有填写总集数 |
| `DRAMA_ARCHIVED` | 409 | 原片批次的剧目已归档 |
| `PERMISSION_DENIED` | 403 | 不满足该用途的权限 |
| `NOT_FOUND` | 404 | 目标不存在或不在数据范围内 |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 同一个键对应的是另一个批次的内容 |

**副作用**（同一事务，d5:1174-1185）：
- 取总集数快照：原片经 `DramaFactsPort` 取 `drama.total_episodes`；成片由交付侧的 `delivery.authorizeUpload` 返回 `expectedCount`（订购集数；补发时为补发单的集数），并一并给出制作上下文写入 `upload_batch.production_ctx`（06 4.7）与 `targetLabel`（a05 `delivery.authorizeUpload`）。成片批次在交付工单详情的找回入口是 a05 `DeliveryTicketDetail.openUploadBatches`。
- 逐集匹配：纯函数 `matchEpisodes(names, expectedCount)` 按 P1–P4 的模板取集号；冲突的全部置为未匹配；全部未命中且文件数等于待传集数时给顺序建议（`match_method = sequence`，须人工确认）；只有一个文件时 P3、P4 的结果同样记为 `sequence`，须人工确认（d5:1176-1184）。
- 插入 `upload_batch`：`upload_batch: — → matching`（06:523），`variant = common`、`expires_at` = 当前 + 72 小时。
- 每个文件插入 `file_object`（不发 `file.uploaded`：本文按确认时发，3.28）：`file_object: — → pending`（06:188），分类原片 `drama_master`（范围 `platform`）、成片 `final_episode`（范围 `store`）；上传人员工、客户端 `admin`、`upload_batch_id`、写入区键 `incoming/b{uploadBatchId}/{fileId}.{ext}`（d5:300）、通道 `multipart`、`upload_expires_at` 随批次。成片文件同事务插入 `production_record`（入库流水线 `uploading`，d5 5.3 第 5 步）。
- 每个文件插入 `upload_batch_item`：`upload_batch_item: — → pending`（06:601）。

**说明**：
- V1.0 不支持上传 ZIP（d5 5.7：以集为单位续传与重试、上传前就能逐集核对）；片方只给 ZIP 的，由内容运营本地解压后上传。原型“支持多选视频文件或上传 ZIP 压缩包”与路线图备注“ZIP 由服务端解包”按此改（第 6 节第 7 项；路线图备注第二轮已删）。单文件上限按“分类 × 端”的参数（d5 5.5），原型写 200MB。
- 原片替换：剧目已有任一集当前原片即视为替换，必须选替换原因；`scope = partial` 只替换所选的集。首次上传整部原片用 `scope = full`，必须恰好覆盖 `1..expectedCount`。
- 建批次不签发直传凭证：确认匹配（3.25）后调 3.26 取整批的临时密钥（凭证不进幂等记录，A18）。

### 3.24 admin.uploadBatch.get　批次详情与进度

`GET /admin/upload-batches/{uploadBatchId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`assert-in-handler`：批次持有人，或持有该用途权限的员工（原片 `drama.media.manage`；成片 `delivery.episode.register` 且工单在数据范围内）；都不满足返回 404（C24，同 a01 `admin.file.get`） |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit、A:TicketDetail 的批量上传进度 |
| 出处 | 路线图 `a04.upload-batches.get`；d5:2107；d7:1068 |

**请求**：路径 `uploadBatchId`。

**响应 `data`**：`UploadBatchDetail`（2.12）。

**错误**：`NOT_FOUND`（批次不存在，或调用者既不是持有人也没有该用途的权限）。

**副作用**：无。

**说明**：上传与体检期间前端每 2 秒轮询一次，批次进入 `ready`、`committed`、`canceled`、`expired` 后停止。条目由 worker 推进（`pending → uploaded → checked / rejected`，批次 `uploading → verifying → ready`，06:526-527、602-605），这些迁移归 x01。替换原片时对照表“文件 → 第 N 集 · 标题 · 时长（原 → 新）”取 `episodeNo`、`episodeTitle`、`previousDurationMs` 与 `durationMs`。

### 3.25 admin.uploadBatch.start　确认匹配并开始上传

`POST /admin/upload-batches/{uploadBatchId}/start`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`assert-in-handler`：只限批次持有人（`upload_batch.created_by_staff_id`）；非持有人 404（C24，与 a01 `admin.file.*` 一致）；持有人此刻已不再持有该用途的权限时 403 |
| 回显 | 无 |
| 幂等 | required（状态迁移） |
| 乐观锁 | 不带（守卫是批次状态与覆盖情况，06:524） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit“批量替换原片”弹窗的“确认替换”；首次上传的“开始上传” |
| 出处 | 路线图 `a04.upload-batches.start`；06:524；d5:1185-1187 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `uploadBatchId` | string(uuid) | 是 | — | 批次 |
| 请求体 | `acceptSequenceSuggestion` | boolean | 否 | 默认 `false` | 有顺序建议（`match_method = sequence`）的条目时必须为 `true`，表示人工确认采用 |

**响应 `data`**：`UploadBatchDetail`。

**错误**：`BATCH_MATCH_INCOMPLETE`（409：有未匹配又未跳过的条目、`full` 未恰好覆盖全部集号、同一集有多个有效条目、顺序建议未确认；`details` 同 `coverage`）；`STATE_NOT_ALLOWED`（不是 `matching`）；`PERMISSION_DENIED`（持有人已无该用途的权限）；`NOT_FOUND`（批次不存在或不是本人的）。

**副作用**：`upload_batch: matching → uploading`（06:524）；`expires_at` 顺延为当前 + 72 小时（不超过创建后 7 天）。

**说明**：开始后调 3.26 取直传凭据。云存储 SDK 按每个条目的 `uploadKey` 直传（分块 8MB、文件并发 3、分块并发 4）；本地 MinIO 按逐文件 POST 表单上传。两种模式均逐文件完成后调 3.28，继续执行真实对象确认、入库和媒体体检（d5:1187）。

### 3.26 admin.uploadBatch.refreshCredentials　签发整批直传凭证

`POST /admin/upload-batches/{uploadBatchId}/refresh-credentials`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`assert-in-handler`：只限批次持有人（`upload_batch.created_by_staff_id`）；非持有人 404（C24，与 a01 `admin.file.*` 一致）；持有人此刻已不再持有该用途的权限时 403（续签只认本人，06:481） |
| 回显 | 无 |
| 幂等 | none（签发短时凭证，结果不进幂等记录，A18、C47） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit、A:TicketDetail 的批量上传（页面无显式按钮，SDK 在凭证到期前自动调用） |
| 出处 | 路线图 `a04.upload-batches.refresh-credentials`（第二轮补登）；d5:1091“一份凭证覆盖整批”、d5:1187“批次未结束期间可经批次接口续签”；C59 的 `refresh-credentials` 命名 |

**请求**：路径 `uploadBatchId`；请求体为空对象。

**响应 `data`**：`BatchUploadCredentials`（2.12）。

**错误**：`STATE_NOT_ALLOWED`（批次不是 `uploading`）；`PERMISSION_DENIED`（持有人已无该用途的权限）；`PROVIDER_UNAVAILABLE`（503，临时密钥服务不可用，可重试，d5:1095）；`NOT_FOUND`（批次不存在或不是本人的）。

**副作用**：无业务写入。云存储临时密钥的策略只允许写 `incoming/b{uploadBatchId}/*`（d5:1091），30 分钟。本地 MinIO 按上述 POST 分支签发，不伪造 STS。

**说明**：
- 设这条路由的理由：路线图只有按文件续签的 `admin.file.refreshCredentials`（a01），它的策略是 `incoming/{fileId}/*`，覆盖不了批次前缀；按文件签发要为一部 60–80 集的剧逐个调用，与 d5“一份凭证覆盖整批”的设计相反。也不能在 3.25 的响应里带凭证：状态迁移是 `required`，重放会返回已过期的凭证（A18）。
- 批次级签发没有像 `file_object.sts_issued` 那样的次数列，也不再补列（A141）；次数以批次有效期（≤7 天）与限流（C68）约束（06:536）。

### 3.27 admin.uploadBatchItem.update　修改批次条目

`PATCH /admin/upload-batch-items/{uploadBatchItemId}`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`assert-in-handler`：只限批次持有人（`upload_batch.created_by_staff_id`）；非持有人 404（C24，与 a01 `admin.file.*` 一致）；持有人此刻已不再持有该用途的权限时 403 |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 不带：`upload_batch_item` 没有锁列，修改在批次行锁内进行且只限持有人；C52 已登记为例外（A104） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit 批量替换对照表（手工指定集号、跳过、换文件）；A:TicketDetail 成片批次 |
| 出处 | 路线图 `a04.upload-batch-items.update`（草案 `PATCH /upload-batches/{id}/items`）；06:528-540、606-607；d5:1186 |

**请求**：三种修改每次只能传一种。

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `uploadBatchItemId` | string(uuid) | 是 | — | 条目 |
| 请求体 | `episodeNo` | integer \| null | 三选一 | 1 至 `expectedCount`；`null` 清除映射 | 改集号：→ `upload_batch_item.episode_no`，`match_method = manual`；提交前随时可改 |
| 请求体 | `skip` | boolean（只能为 `true`） | 三选一 | 仅 `scope = partial` 的批次；条目为 `pending` 或 `rejected`；不能是批次里最后一个有效条目 | 跳过该集 |
| 请求体 | `replacementFile` | object `{ clientToken, originalName, sizeBytes }` | 三选一 | 同 3.23 的 `files[]` | 同一集换新文件 |

**响应 `data`**：`UploadBatchDetail`（换文件会新建条目，返回整批）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 没传或同时传了多种修改；集号越界 |
| `BATCH_FILE_INVALID` | 400 | 换上的文件不合规 |
| `BATCH_EPISODE_TAKEN` | 409 | 该集已被本批次另一个有效条目占用（`uq_upload_batch_item_episode`）；`details.uploadBatchItemId` 为占用者 |
| `STATE_NOT_ALLOWED` | 409 | 批次已结束（`committed`、`canceled`、`expired`）；条目已跳过或被取代；整部批次跳过集；跳过批次里最后一个有效条目（要放弃整批，`matching`、`ready` 时用 3.30） |
| `PERMISSION_DENIED` | 403 | 持有人已无该用途的权限 |
| `NOT_FOUND` | 404 | 条目不存在，或批次不是本人的 |

**副作用**（加锁顺序按 06:540：成片批次改集号时先锁该文件的 `production_record`（lock_rank 360），再锁批次行（380）；其余修改只锁批次行。条目都在批次行锁内修改）：
- 改集号：成片批次的条目若已体检（`checked`、`rejected`），同事务改 `production_record.episode_no` 并重新认定原片版本，条目回到 `uploaded` 重新体检，批次回到 `verifying`（06:540）。原片批次只改条目，批次状态不变（`ready` 也不退回）；提交时按 3.25 的覆盖规则重算（3.29），所以 `ready` 之后改坏了映射会在提交时被拦下。
- 跳过：`upload_batch_item: pending / rejected → skipped`（06:606）。
- 换文件，按下列顺序写，避免撞部分唯一索引：① 原文件若仍是 `pending`，先置 `expired`（`uq_file_object_client_token_batch` 只约束 `pending` 的行，客户端沿用同一个 `clientToken` 也不冲突）；② 原条目 `upload_batch_item: 未提交 → replaced`（06:607，让出 `uq_upload_batch_item_episode`）；③ 再新建 `file_object`（`pending`，写入区键同 3.23）与同一集的新条目（`pending`）。新文件需要继续直传时调 3.26 取凭证。
- 跳过或换文件之后，批次在 `uploading`、`verifying`、`ready` 时，同一事务按 06:534 的复判规则重判批次状态（与 worker 收尾事务调用同一个判定；06:526-528 的触发者已含员工，A141）：未跳过、未被取代的条目里仍有 `pending` 的 → `uploading`（06:528、530）；没有 `pending`、也没有 `rejected`，且仍有体检中的（`uploaded`）→ `verifying`；全部 `checked` 且覆盖范围满足 → `ready`（必要时在本事务里依次推进 `uploading → verifying → ready`）；仍有 `rejected` 的条目时不前进，等换文件或跳过。不在这里重判的话，部分集批次里其余条目往往都已 `checked`、名下没有在途任务，worker 不会再收尾，批次会停在 `uploading` 直到过期。

### 3.28 admin.uploadBatchItem.complete　单个文件上传完成确认

`POST /admin/upload-batch-items/{uploadBatchItemId}/complete`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`assert-in-handler`：只限批次持有人（`upload_batch.created_by_staff_id`）；非持有人 404（C24，与 a01 `admin.file.*` 一致）；持有人此刻已不再持有该用途的权限时 403 |
| 回显 | 无 |
| 幂等 | required（状态迁移，C59）。多事务的三段式用例（C51，`x-three-phase`；与 `admin.file.complete`、A84 的 `m.file.complete` 同一实现）：事务一用 `file_object.confirming_until`（30 秒）占位；事务外 `HEAD` 写入区对象并读文件头；事务二写结果与幂等记录。拒收时已提交的技术状态不随错误回滚（d5 5.3“确认”） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | 无（SDK 逐文件完成后自动调用） |
| 出处 | 路线图 `a04.upload-batch-items.complete`；d5:1187、1213；06:191-193 |

**请求**：路径 `uploadBatchItemId`；请求体为空对象。

**响应 `data`**：`UploadBatchItem`（2.12）。

**错误**（上传类码由 m08 定义，与 a01 3.59 一致）

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `CONFIRM_IN_PROGRESS` | 409 | 同一文件另一个确认正在进行（`confirming_until` 未过期）；可重试，1 秒后用同一幂等键重试 |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | 三段式用例处理中（可重试） |
| `UPLOAD_NOT_FOUND` | 409 | 写入区里找不到对象（直传尚未完成） |
| `UPLOAD_REJECTED` | 400 | 大小与登记值不符或文件头与扩展名不符：文件与条目已置 `rejected`，不随错误回滚；`details.rejectReason` |
| `UPLOAD_EXPIRED` | 409 | 文件登记已过期或已作废（`expired`，如批次过期、被换下） |
| `STATE_NOT_ALLOWED` | 409 | 条目不是 `pending`，或批次已结束 |
| `PERMISSION_DENIED` | 403 | 持有人已无该用途的权限 |
| `NOT_FOUND` | 404 | 条目不存在，或批次不是本人的 |

**副作用**：
- 对象相符：`file_object: pending → promoting`（06:191），记写入区 ETag 与 CRC64，建 `promote` 任务，发 `file.uploaded`（d5 5.8）。之后由 worker 入库、体检，并把条目推进到 `uploaded`、`checked` 或 `rejected`。
- 对象不符（大小不等、文件头不符）：`file_object: pending → rejected`（06:192），记 `reject_reason`；条目同事务置 `rejected`（与 06:603 同一结果，由确认请求触发）；发 `file.rejected`。事务提交后返回 400 `UPLOAD_REJECTED`（同 a01 3.59）。
- 批次 `expires_at` 顺延为当前 + 72 小时，不超过创建后 7 天（06:491）。

**说明**：
- 原片单集约 80–93MB，超过“确认时最多等 3 秒入库”的 32MB 门槛（d5:1010），响应里的文件状态通常是 `promoting`，进度靠 3.24 轮询。
- `file.uploaded` 在确认时发（与 a01 3.59、m08、d5:1215 一致）；x01 事件目录与 06 第 5.3 节写的是登记时发（含批次条目登记），口径已报主负责人统一，定下前按本节。

### 3.29 admin.uploadBatch.commit　提交原片批次

`POST /admin/upload-batches/{uploadBatchId}/commit`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `drama.media.manage` + 模块 drama 查看；`global` |
| 回显 | 无 |
| 幂等 | required（状态迁移） |
| 乐观锁 | 不带（守卫是批次 `ready`、总集数未变、覆盖范围仍满足） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit 批量上传完成后的“提交”（原型的“确认替换”合并了开始与提交两步，页面在批次 `ready` 后提示提交） |
| 出处 | 路线图 `a04.upload-batches.commit`；06:529、1075-1080；d5:1190；d8:560 |

**请求**：路径 `uploadBatchId`；请求体为空对象。

**响应 `data`**：`{ batch: UploadBatchDetail, masters: array<{ episodeNo, dramaEpisodeMasterId, revNo }> }`。

**错误**：`BATCH_PURPOSE_MISMATCH`（409，成片批次：由交付的 `admin.deliveryTicket.episodeOutput.create` 提交，a05）；`STATE_NOT_ALLOWED`（不是 `ready`）；`BATCH_MATCH_INCOMPLETE`（409，`ready` 之后改了集号使覆盖不满足：有集号为空的有效条目、`full` 未恰好覆盖 `1..expectedCount`；`details` 同 `coverage`）；`PRECONDITION_CHANGED`（409，剧目总集数已与登记快照不一致）；`DRAMA_ARCHIVED`；`NOT_FOUND`。

**副作用**（media 的一个事务，锁批次行）：
- 锁批次行后先按 3.25 的规则重算覆盖（3.27 允许 `ready` 之后改集号，原片批次改集号不退回状态）：有效条目都有集号、集号不重复且在 `1..expectedCount` 内，`full` 恰好覆盖全部集号；不满足返回 `BATCH_MATCH_INCOMPLETE`，什么都不写。
- 逐个有效条目（`checked`）写原片版本，先停旧、再插新（`uq_drama_episode_master_current` 是部分唯一索引，不能延迟检查，顺序反过来每次替换都会撞约束）：① 该集原当前版本 `drama_episode_master.state: ready → superseded`、`is_current = false`（06:1080）；② 插入新版本，`rev_no` = 该集当前最大 + 1、`state = ready`、`is_current = true`、`duration_ms` 取探测值、`upload_batch_id`、`replace_reason` 与 `is_content_changed` 从批次复制、`created_by_staff_id` = 提交人、`activated_at` = 当前（`drama_episode_master: — → ready`，06:1079）。
- 文件引用：新版本以 `drama_episode_master` / `main` 登记；被取代版本的引用释放并保留 180 天；批次引用立即释放（06:1642、1645）。
- `upload_batch: ready → committed`，写 `committed_at`（06:529）。
- 发 `drama.masters_changed { dramaId, uploadBatchId, episodeNos, isContentChanged }`（06:1847；d8 第 9 节 D5 第 ⑤ 项；载荷按 x01）。
- 审计（记在剧目上，如“上传 60 集原片”“批量替换第 3、7、12 集原片（画质修复）”）。

**说明**：content 订阅 `drama.masters_changed`（不在本事务）：回填受影响剧集的 `drama_episode.duration_ms`；批次带 `isContentChanged` 时置 `drama.is_permit_recheck_required = true`（`drama.lock_version + 1`），给内容运营生成待办；已上架的剧不自动下架（d8:560）。已交付的成片不受影响，之后的样片与成片制作使用新原片（d5:1190；原型批量替换弹窗）。

### 3.30 admin.uploadBatch.cancel　取消批次

`POST /admin/upload-batches/{uploadBatchId}/cancel`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；`assert-in-handler`：只限批次持有人（`upload_batch.created_by_staff_id`）；非持有人 404（C24，与 a01 `admin.file.*` 一致）；持有人此刻已不再持有该用途的权限时 403 |
| 回显 | 无 |
| 幂等 | required（状态迁移；草案的 `DELETE /upload-batches/{id}` 按 A7 改为 POST） |
| 乐观锁 | 不带 |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:DramaEdit 批量替换弹窗“取消”；A:TicketDetail |
| 出处 | 路线图 `a04.upload-batches.cancel`；06:525、531、538 |

**请求**：路径 `uploadBatchId`；请求体为空对象。

**响应 `data`**：`UploadBatchDetail`。

**错误**：`STATE_NOT_ALLOWED`（批次不是 `matching` 或 `ready`）；`PERMISSION_DENIED`（持有人已无该用途的权限）；`NOT_FOUND`（批次不存在或不是本人的）。

**副作用**：`upload_batch: matching / ready → canceled`（06:525、531）；名下仍为 `pending` 的文件置 `expired`（06:193）；批次引用释放并保留 3 天（06:538、1645）。

**说明**：数据模型不允许在 `uploading`、`verifying` 时取消，上传中放弃的批次在有效期满后由 worker 置 `expired`（06:532）。页面要“上传中取消”时须先改 06 的状态机（第 6 节第 8 项）。

### 3.31 admin.dramaPrice.list　单剧积分价列表

`GET /admin/drama-prices`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 billing 查看；`global` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:Pricing 表格 |
| 出处 | 路线图 `a04.drama-prices.list`；d1:1708；d8:303、641；07:291-332；proto-admin-c.md:262-271 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `page`、`pageSize` | integer | 否 | C43 | 页面传 `pageSize=10` |
| 查询 | `q` | string | 否 | ≤20 字 | 剧名包含 |
| 查询 | `dramaId` | string(uuid)（多值） | 否 | 至多 50 个 | 只看这些剧：短剧库行内“积分价”与编辑页“去单剧积分价 ›”跳转时带上（剧名不唯一，3.3） |
| 查询 | `heatTier` | enum（多值） | 否 | `S`/`A`/`B`/`C` | 等级 |
| 查询 | `priceMode` | enum | 否 | `template`、`custom` | 定价方式 |
| 查询 | `status` | enum（多值） | 否 | `draft`、`listed`、`delisted` | 状态 |
| 查询 | `isArchived` | boolean | 否 | 默认 `false` | 已归档的剧不能调价，默认不列 |
| 查询 | `sort` | enum `DramaPriceSort` | 否 | 默认 `heatTier,title` | `heatTier`（S 在前）、`title`、`-listPricePoints`、`-pricedSince` |

**响应 `data`**：页码分页 `{ items: DramaPriceRow[], page, pageSize, total }`（2.11）。

**错误**：`VALIDATION_FAILED`。

**副作用**：无。

**说明**：
- 剧名、状态与授权期派生由 content 的 `getDramaCards`、`getOrderability` 给出，价格由 billing 的价格函数给出（d8:497、641 第 ④ 项）；按定价方式筛选与排序在内存里做（剧目是全局小表）。
- 页首“已上架 22 部 · 单剧调整 5 部 · 本月订购 398 部”由 3.32 给（A23）。
- 右侧“积分试算”用 `admin.order.quote`（a05，与商家端确认订购同一实现）；“调价记录”用 3.34 与 a07 的 `admin.pricingChange.list`（等级模板价的调整，如“调整 S、A、B、C 等级模板积分价”）。

### 3.32 admin.dramaPrice.summary　单剧积分价页首计数

`GET /admin/drama-prices/summary`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 billing 查看；`global` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:Pricing 页首 |
| 出处 | 路线图 `a04.drama-prices.summary`（第二轮补登；原先计数写在 `a04.drama-prices.list` 的“KPI”里）；A23“凡页面标题带数字的都要有对应的 summary，列表不返回计数”；C83；proto-admin-c.md:262 |

**请求**：查询参数与 3.31 相同（去掉 `page`、`pageSize`、`sort`）；页首计数不带筛选。

**响应 `data`**

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `listed` | integer | 是 | 已上架部数 | `drama.status` |
| `customPriced` | integer | 是 | 当前按单剧调整定价的部数（未归档） | 2.1 的定价方式 |
| `ordersMonth` | integer | 是 | 本月订购部数合计 | `drama_stat.orders_mtd` 求和 |
| `statRefreshedAt` | string(date-time) \| null | 是 | 统计取数时刻（取各行最早的） | `drama_stat.refreshed_at` |
| `minLicenseMonths` | integer | 是 | 最短可订月数，行注“剩余授权期不足 3 个月，09-25 起停止订购”的 3 | `billing_param` 键 `minLicenseMonths`，经 `DramaPricePort.minLicenseMonths`（A79） |

**错误**：`VALIDATION_FAILED`。

**副作用**：无。

### 3.33 admin.drama.dramaPriceRevision.create　单剧调价

`POST /admin/dramas/{dramaId}/drama-price-revisions`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `billing.price.edit`（d4:1194）+ 模块 billing 查看；`global` |
| 回显 | 要求 `confirm.currentPoints`：回显弹窗里的“当前积分价”，服务端与 `P(drama, now)` 比对（C54 的写法；本稿补充） |
| 幂等 | required（新建修订行） |
| 乐观锁 | 不带；同一部剧的调价在事务内按剧目 id 取事务级咨询锁串行化（本稿补充，仿 `billing_param` 的做法，07:345） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:Pricing“调价”弹窗 |
| 出处 | 路线图 `a04.drama-price-revisions.create`（d1 写作 `POST /billing/drama-prices`）；07:291-332、1586、1600；d8:303、641 第 ③ 项；proto-admin-c.md:272-274、284-287 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaId` | string(uuid) | 是 | — | 剧目 |
| 请求体 | `mode` | enum | 是 | `template`、`custom` | → `drama_price_revision.mode`；“恢复模板价”即 `template` |
| 请求体 | `customPoints` | integer(积分) \| null | `custom` 时必填 | ≥100 的整数；`template` 时为空 | → `drama_price_revision.custom_points` |
| 请求体 | `effectiveDate` | string(date) \| null | 是 | 为空 = 保存后立即生效；否则不早于明天 | → `drama_price_revision.effective_at`（该日 00:00 Asia/Shanghai，C35） |
| 请求体 | `reasonCode` | enum | 是 | `quality`、`genre_fit`、`release_timing`、`license_remaining`、`restore_template`；`restore_template` 与 `mode = template` 成对 | → `drama_price_revision.reason_code` |
| 请求体 | `note` | string \| null | 否 | ≤200 字 | → `drama_price_revision.note`（示例里的“新剧热度高”这类自由描述，proto-admin-c.md:284） |
| 请求体 | `confirm.currentPoints` | integer(积分) \| null | 是 | — | 回显当前积分价；当前没有价格时为空 |

**响应 `data`**：`{ revision: DramaPriceRevision, price: DramaPriceRow }`（2.11）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | 新积分价不是不少于 100 的整数；生效日期早于明天；`restore_template` 与定价方式不成对 |
| `DRAMA_PRICE_LOCKED` | 409 | 剧目已停止订购、授权已结束或已归档，不能调价（d8:303） |
| `HEAT_TIER_MISSING` | 409 | 剧目没有热度等级，不能按模板定价（07:302） |
| `DRAMA_PRICE_UNCHANGED` | 400 | 新积分价与当前积分价相同（`ck_drama_price_revision_points_changed`；原型“新积分价与当前相同”） |
| `DRAMA_PRICE_EFFECTIVE_AT_TAKEN` | 409 | 该剧同一生效时间已有一条未撤销的调价（`uq_drama_price_revision_drama_effective`） |
| `CONFIRM_MISMATCH` | 409 | `confirm.currentPoints` 与当前积分价不一致（有人刚调过价或改过等级） |
| `NOT_FOUND` | 404 | 剧目不存在 |

**副作用**（同一事务）：
- 插入 `drama_price_revision`：`prev_points` = `P(drama, 保存时刻)`（当时没有价格为空）；`new_points` = `custom` 取 `customPoints`，`template` 取该剧当前热度等级在 `effective_at` 的模板价（07:301-302）；`created_by_staff_id` = 当前员工。
- 生效时间晚于保存时刻：登记定时器 `pricing.drama_price_effective`（`subject_type = drama_price_revision`、`fire_at = effective_at`、`dedupe_key = pricing.drama_price_effective:drama_price_revision:{id}`，07:332、1586），到点只发 `pricing.drama_price_changed`。
- 立即生效：同事务发 `pricing.drama_price_changed { dramaId, dramaPriceRevisionId, cause: 'revision', effectiveAt }`（`aggregate_type = drama_price_revision`，07:1600；载荷按 x01）；刷新目录缓存版本号。V1.0 这个事件没有订阅者（x01），不主动推送变价提示：选剧单读取时比对 `cart_item.price_acked_at`，显示“积分价已变动”（d1:715）。是否另发站内消息或订阅消息待产品定（第 6 节第 10 项）。
- 审计（`category = price_adjust`，“《老街烟火》2,000 → 2,200”，原因与备注）。

**说明**：
- 调价只影响之后提交的订购；已冻结或已扣减的订购按原积分价履约；选剧单里的该剧读取时显示“积分价已变动”，商家确认后才能订购（d8:445-446；d1:715）。价格按时间取值，定时器没跑也不会错价，只是通知晚到（07:332）。
- 草稿与已下架（未归档、授权未结束）的剧可以先定价，“上架后生效”（d8:297；proto-admin-c.md:286）。不能调价的判定：已上架且已到停止订购日、授权已结束、或已归档（第 6 节第 2 项）。
- 单剧价没有上限，也不受等级模板约束（proto-admin-c.md:285）。调价不走审批（proto-admin-c.md:289）。

### 3.34 admin.dramaPriceRevision.list　调价记录

`GET /admin/drama-price-revisions`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 billing 查看；`global` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用 |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:Pricing“调价记录”；A:DramaEdit 右栏积分价（按剧筛选） |
| 出处 | 路线图 `a04.drama-price-revisions.list`；d1:1708；07:315；proto-admin-c.md:266、276 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `page`、`pageSize` | integer | 否 | C43 | — |
| 查询 | `dramaId` | string(uuid) | 否 | — | 只看某部剧 |
| 查询 | `state` | enum（多值） | 否 | `pending`、`effective`、`withdrawn` | 不传返回全部（含已撤销） |
| 查询 | `sort` | enum | 否 | 默认 `-effectiveAt` | `-effectiveAt`、`-createdAt` |

**响应 `data`**：页码分页 `{ items: DramaPriceRevision[], page, pageSize, total }`（2.11）。

**错误**：`VALIDATION_FAILED`。

**副作用**：无。

**说明**：按 `ix_drama_price_revision_drama_id_effective_at` 读取，含已撤销的行（07:315）。记录的说明行（“沈蔓 · 制作质量较高；09-26 提交”）由 `createdBy`、`reasonCode`、`note`、`createdAt` 拼出；原型的固定文案“选剧单中的商家已收到变价提示”与 V1.0 不推送不符，改为“选剧单中的该剧会提示积分价已变动”（第 6 节第 10 项），不建字段。

### 3.35 admin.dramaPriceRevision.withdraw　撤销尚未生效的调价

`POST /admin/drama-price-revisions/{dramaPriceRevisionId}/withdraw`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；权限点 `billing.price.edit` + 模块 billing 查看；`global` |
| 回显 | 无 |
| 幂等 | required |
| 乐观锁 | 不带：修订行只允许在生效前写一次 `cancelled_at`，守卫是“未撤销且未生效”（07:31、306） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:Pricing“调价记录”中待生效的一条（原型没有撤销入口，按 proto-admin-c.md:287 补） |
| 出处 | 路线图 `a04.drama-price-revisions.withdraw`；07:306、324、332、1586 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `dramaPriceRevisionId` | string(uuid) | 是 | — | 修订 |
| 请求体 | `note` | string \| null | 否 | ≤200 字 | 撤销说明，写进审计（修订行不设撤销人与原因列，07:31） |

**响应 `data`**：`DramaPriceRevision`。

**错误**：`REVISION_ALREADY_EFFECTIVE`（409，a07 定义；已生效或已撤销，锁行后按当前时刻判定，`ck_drama_price_revision_cancel_before_effective`；`details` 为 `{ effectiveAt, cancelledAt }`，与 a07 套餐价目、参数的撤销同一个码）；`NOT_FOUND`。

**副作用**：`drama_price_revision.cancelled_at` = 当前时刻（修订行由“待生效”变为“已撤销”，不是状态机，07:31；`trg_drama_price_revision_write_once` 只放行这一次写）；同事务取消定时器 `pricing.drama_price_effective`（`status = cancelled`，07:1586）；审计（`category = price_adjust`）。价格从未变过，不发事件。

### 3.36 admin.priceTierRevision.list　等级模板价

`GET /admin/price-tier-revisions`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `staff`；模块 billing 查看；`global` |
| 回显 | 无 |
| 幂等 | none（纯查询） |
| 乐观锁 | 不适用（模板价只增，没有锁列；保存走 a07 的变更集） |
| 限流 / 开关 | `admin.global` / 无 |
| 对应画板 | A:Params“积分价等级模板”一栏（等级、模板积分价、适用剧目、按模板定价）；A:Pricing 表格的“模板积分价”列（3.31 已带） |
| 出处 | 路线图 `a04.price-tier-revisions.list`（原 `GET /admin/price-tiers`，A5 改名）；A28、A93、A94；07:252-289；d1:243-251；proto-admin-c.md:218-219 |

**请求**：无。V1.0 模板价保存即生效（A93），没有待生效的值，所以不设 `tab`；以后做定时生效时再加 `tab = current | pending`（新增可选参数，向后兼容）。

**响应 `data`**：`{ items: PriceTierRow[] }`（2.11），恰好 4 行（S、A、B、C 的当前值）。有界小集合，不分页（A78、C43 已登记）。

**错误**：无业务错误。

**副作用**：无。

**说明**：模板价的保存（4 档，100–20,000 的整数，S ≥ A ≥ B ≥ C）与“变更记录”合并在 a07 的 `admin.pricingChange.create` / `admin.pricingChange.list`（A28，与计费参数同一事务）。模板调整后按模板定价的剧同步生效，已单剧调整的剧不受影响（原型 Params 说明）。“评定依据”是前端文案（2.11）。

## 4. 枚举

| 名称 | 取值 | 含义 / 说明 |
| --- | --- | --- |
| `drama.status` | 同数据模型 `drama.status` | `status`；`x-open-enum` |
| `drama.delist_reason_code` | 同数据模型 `drama.delist_reason_code` | `delistReasonCode`；请求（3.19）只接受前四个，`license_expired` 只由系统写 |
| `drama.drama_class` | 同数据模型 `drama.drama_class` | `dramaClass` |
| `drama.heat_tier`、`price_tier_revision.tier` | 同数据模型 | `heatTier`、`tier` |
| `PlacementSlot` | 同数据模型 `drama.allowed_placements[]` | `allowedPlacements`、`openPlacementSlots`；V1.0 只开放 `opening`、`ending` |
| `drama.body_edit_policy` | 同数据模型 | `bodyEditPolicy`（只读） |
| `drama_permit.platform`、`drama_permit.permit_kind`、`drama_permit.status` | 同数据模型 | `DramaPermit` 各字段 |
| `drama_copyright.source`、`drama_copyright.platforms[]` | 同数据模型 | `DramaCopyright` |
| `drama_copyright_revision.change_kind` | 同数据模型 | `changeKind`；请求（3.11）不接受 `initial` |
| `file_object.status`、`file_object.moderation_state`、`file_object.reject_reason` | 同数据模型 | `DramaFileBrief`、`UploadBatchItem` |
| `playable_asset.state` | 同数据模型 | `TrailerBrief.state`；`x-open-enum` |
| `upload_batch.purpose`、`upload_batch.variant`、`upload_batch.state`、`upload_batch.scope`、`upload_batch.replace_reason` | 同数据模型 | `UploadBatchDetail`；`state` 标 `x-open-enum` |
| `upload_batch_item.match_method`、`upload_batch_item.state` | 同数据模型 | `UploadBatchItem`；`state` 标 `x-open-enum` |
| `media_check.gate` | 同数据模型 | `UploadBatchItem.check.gate` |
| `drama_price_revision.mode`、`drama_price_revision.reason_code` | 同数据模型 | `mode`、`priceMode`、`reasonCode` |
| `LicenseFlag` | `orderable`、`stopped`、`license_ended`、`not_listed` | 授权期派生标记（2.1） |
| `CopyrightEditMode` | `direct`、`revision`、`locked` | 版权的编辑方式（2.4） |
| `DramaEditTab` | `basic`、`license`、`copyright`、`commercial`、`episodes` | 上架校验“去补充”定位的页签 |
| `ListingCheckCode` | `L1` … `L14` | 上架校验项（2.8；与 `status_transition.payload` 的 `DramaListingCheckSummary` 同一组编号，05:468） |
| `ListingCheckSeverity` | `block`、`hint` | 阻断 / 提示 |
| `EpisodeMasterState` | `missing`、`processing`、`ready` | 剧集的原片状态（2.6） |
| `ShelveBlockedReason` | `license_ended`、`archived` | 列表“重新上架”置灰的原因 |
| `PriceLockReason` | `stopped`、`license_ended`、`archived` | 不能调价的原因（3.33） |
| `PriceRevisionState` | `pending`、`effective`、`withdrawn` | 调价记录的状态（由 `effective_at` 与 `cancelled_at` 推出） |
| `DramaSort` | `-updatedAt`、`-createdAt`、`-firstListedAt`、`licenseEndDate`、`-ordersMtd`、`title` | 3.1 |
| `DramaPriceSort` | `heatTier`、`title`、`-listPricePoints`、`-pricedSince` | 3.31 |
| `DramaAction` | `shelve`、`delist`、`confirm-permit-recheck` | `DramaRow.actions`、`AdminDramaDetail.actions`（C16） |
| `DramaPermitAction` | `retire` | `DramaPermit.actions` |
| `UploadBatchAction` | `start`、`refresh-credentials`、`commit`、`cancel` | `UploadBatchDetail.actions` |
| `PriceRevisionAction` | `withdraw` | `DramaPriceRevision.actions` |
| `BatchFileInvalidReason` | `ext_not_allowed`、`zip_not_supported`、`too_large`、`empty`、`duplicate_name`、`too_many` | `BATCH_FILE_INVALID` 的 `details.files[].reason` |
| `TrailerSourceRejectReason` | `rejected`、`retired` | `TRAILER_SOURCE_REJECTED` 的 `details.reason`：源文件体检不过 / 该源文件的预告片资产已停用（须重新上传）。体检未完成改用 `TRAILER_SOURCE_CHECKING` |

## 5. 错误码

本文新定义的领域错误码（短剧库 49200–49299，积分价 43200–43299，A70）：

| 符号 | 数值 | HTTP | 可重试 | 含义 | `details` |
| --- | --- | --- | --- | --- | --- |
| `DRAMA_ARCHIVED` | 49201 | 409 | 否 | 剧目已归档，资料只读，不能上架或变更版权 | `{ archivedAt: string }` |
| `LISTING_CHECK_FAILED` | 49202 | 409 | 否 | 上架校验有阻断项未通过（上架、重新上架；已上架剧目的保存） | `{ failed: [{ code: ListingCheckCode, note: string }] }` |
| `TOTAL_EPISODES_LOCKED` | 49203 | 409 | 否 | 已上架的剧不能修改总集数，请先下架 | `{ totalEpisodes: integer }` |
| `EPISODE_HAS_MASTER` | 49204 | 409 | 否 | 要删去的剧集已有原片 | `{ episodeNos: integer[] }` |
| `PLACEMENT_NOT_OPEN` | 49205 | 400 | 否 | 所选植入形式未开放或不适用于该类别 | `{ slots: PlacementSlot[], openSlots: PlacementSlot[] }` |
| `COPYRIGHT_REVISION_REQUIRED` | 49206 | 409 | 否 | 剧目上架过，版权信息只能经“版权变更”修改 | — |
| `COPYRIGHT_CHANGE_KIND_MISMATCH` | 49207 | 400 | 否 | 修订类型与前后值的差异不符 | `{ allowedKinds: string[] }` |
| `LICENSE_SHORTEN_NOT_OPEN` | 49208 | 409 | 否 | 缩短授权期或把止日改早暂不开放 | `{ currentEndDate: string(date) }` |
| `COPYRIGHT_NO_CHANGE` | 49209 | 400 | 否 | 版权信息没有变化 | — |
| `PERMIT_ACTIVE_EXISTS` | 49210 | 409 | 否 | 同一平台、同一编号种类已有活动的许可行 | `{ dramaPermitId: string }` |
| `PERMIT_FROZEN` | 49211 | 409 | 否 | 剧目上架过，许可行的平台、种类、编号不能原地修改，请换号 | — |
| `TRAILER_SOURCE_REJECTED` | 49212 | 409 | 否 | 预告片源文件未通过体检，或该源文件的预告片资产已停用 | `{ reason: TrailerSourceRejectReason, failed: [{ code, actual, expected }] }`（`failed` 只在 `reason = rejected` 时有元素） |
| `BATCH_FILE_INVALID` | 49213 | 400 | 否 | 上传清单里有不合规的文件 | `{ files: [{ index: integer, reason: BatchFileInvalidReason }] }` |
| `BATCH_MATCH_INCOMPLETE` | 49214 | 409 | 否 | 集号匹配或覆盖不完整，不能开始上传或提交 | `{ missingEpisodeNos, duplicateEpisodeNos, unmatchedItemIds, needsSequenceConfirm }` |
| `BATCH_PURPOSE_MISMATCH` | 49215 | 409 | 否 | 批次用途不符（成片批次由交付登记提交） | `{ purpose: string }` |
| `TOTAL_EPISODES_MISSING` | 49216 | 409 | 否 | 剧目还没有填写总集数，不能上传原片 | — |
| `BATCH_EPISODE_TAKEN` | 49217 | 409 | 否 | 该集已被本批次的另一个条目占用 | `{ uploadBatchItemId: string }` |
| `TRAILER_SOURCE_CHECKING` | 49218 | 409 | 是 | 预告片源文件还在体检，请稍后再试 | `{ fileId: string }` |
| `DRAMA_PRICE_LOCKED` | 43201 | 409 | 否 | 剧目已停止订购、授权已结束或已归档，不能调价 | `{ reason: PriceLockReason, stopOrderDate: string(date) \| null }` |
| `DRAMA_PRICE_UNCHANGED` | 43202 | 400 | 否 | 新积分价与当前积分价相同 | `{ currentPoints: integer }` |
| `HEAT_TIER_MISSING` | 43203 | 409 | 否 | 剧目没有热度等级，不能按模板定价 | — |
| `DRAMA_PRICE_EFFECTIVE_AT_TAKEN` | 43204 | 409 | 否 | 该剧同一生效时间已有一条调价 | `{ dramaPriceRevisionId: string }` |

本文引用、由其他文档或约定定义的错误码：

| 符号 | 定义方 | 本文用在 |
| --- | --- | --- |
| `FILE_NOT_USABLE` | m03-profile-asset（46001） | 3.7、3.10、3.11、3.13、3.14、3.22 |
| `CONFIRM_IN_PROGRESS`、`UPLOAD_NOT_FOUND`、`UPLOAD_REJECTED`、`UPLOAD_EXPIRED` | m08-support-misc（47055、47056、47057、47053；上传类码归 m08，A77、C28） | 3.28 |
| `REVISION_ALREADY_EFFECTIVE` | a07-billing-finance（43104） | 3.35 |
| `DICT_ITEM_DISABLED` | m08-support-misc（409；字典编码的出入形态，C85） | 3.7、3.8 |
| `VALIDATION_FAILED`、`PERMISSION_DENIED`、`NOT_FOUND`、`VERSION_CONFLICT`、`STATE_NOT_ALLOWED`、`IDEMPOTENCY_KEY_REUSED`、`IDEMPOTENCY_IN_PROGRESS`、`CONFIRM_MISMATCH`、`PRECONDITION_CHANGED`、`PROVIDER_UNAVAILABLE` | 约定 C27 | 各接口 |

## 6. 待确认

只列需要产品、业务、法务决定的问题（A108）。第一轮的技术待定项已由第十节裁决定下（A78、A88、A104），或按第十节的总则接受作者的默认做法，不再列；需要其他文档配合的另行发出。

| # | 问题 | 默认做法 | 由谁定 |
| --- | --- | --- | --- |
| 1 | 归档的剧是否全部只读（数据模型只写了不能重新上架、不再受理版权变更） | 本文的剧目写接口一律 `DRAMA_ARCHIVED`，调价返回 `DRAMA_PRICE_LOCKED` | 业务 |
| 2 | 哪些剧不能调价：原型只写“停止订购的剧不能调价、草稿可先定价” | 已上架且已到停止订购日、授权已结束、已归档的不能调；草稿、已下架（未归档、授权未结束）的可以 | 业务 |
| 3 | 上架校验比原型多出的阻断项（L1 的类别与编号种类对应、L3 的改编权、L4、L7、L9、L10、L11、L12）与 L6 降为提示（d8 Q6、Q13） | 按 d8 4.3 实现；对应关系确认前按此拦截 | 产品、法务 |
| 4 | 改热度等级即时生效、不产生调价记录（05 第 6 节第 5 项、d8 Q11） | 即时生效，只写审计（`action = drama.heat_tier.change`）并发 `drama.tier_changed`；单剧积分价页的“生效时间”取改等级的时刻 | 业务 |
| 5 | 版权修订历史是否要单独的列表（原型没画） | 不提供；历次变更在操作日志里可见 | 产品 |
| 6 | 许可扫描件“· 2 页”的页数没有数据来源（`media_info` 只覆盖图片、音视频） | 页面只显示文件名与大小 | 产品 |
| 7 | 原型与 D5 不一致：原型可上传 ZIP、原片“转码中 → 转码完成后自动生效” | V1.0 不支持 ZIP（d5 5.7）；原片不转码，剧集状态显示“处理中”，批次提交后生效 | 产品 |
| 8 | 上传中（`uploading`、`verifying`）能否取消批次：06 的状态机不允许 | 不允许，放弃的批次过期后由 worker 置 `expired`；页面在上传中不显示“取消” | 产品（媒体分组配合） |
| 9 | 缩短授权期、改早止日的 `correction` 何时开放（d8:413、Q3） | 交付侧改为单向顺延前一律 `LICENSE_SHORTEN_NOT_OPEN` | 业务、法务 |
| 10 | 调价后是否主动通知选剧单里有这部剧的商家（原型调价记录写“选剧单中的商家已收到变价提示”，d1:717；x01 的 `pricing.drama_price_changed` V1.0 没有订阅者） | V1.0 不推送：选剧单读取时比对 `cart_item.price_acked_at` 显示“积分价已变动”；调价记录的固定文案改为“选剧单中的该剧会提示积分价已变动”。要推送时由 x01 补订阅者、m08 或 a09 登记通知场景 | 产品 |

## 7. 修订记录

| 日期 | 内容 |
| --- | --- |
| 2026-10-03 | 初稿：按路线图 `doc = a04-content` 的 34 条接口写全；按 A61 把角色接口改为 `PUT /admin/dramas/{dramaId}/cast`（`admin.drama.cast.replace`）；建议补登 `admin.uploadBatch.refreshCredentials`、`admin.dramaPrice.summary`；新定义错误码 21 个（49201–49217、43201–43204）；剧目聚合的锁版本口径、已上架剧目的保存校验、授权期派生、价格口径按 05、06、07 分组与 d8、d5、d1 落到列；事件名与载荷、定时器去重键按 x01 事件目录对齐 |
| 2026-10-03 | 第二轮：① 路线图切片同步——角色接口按 A61 改为 `admin.drama.cast.replace`（`PUT …/cast`），补登 `admin.uploadBatch.refreshCredentials`、`admin.dramaPrice.summary`（36 条），7 条批次接口的权限改为 `assert-in-handler`，`transitions`、`tables`、备注与清单对齐。② 裁决：按 A80 给返回 `AdminDramaDetail` 的 9 条写接口与 3.22 登记 `x-redact-on-replay` 并带 `replayed`；按 A84 把 3.28 标为多事务的三段式用例，错误码、事件与 a01 3.59 对齐（补 `UPLOAD_REJECTED`、`UPLOAD_EXPIRED`、`IDEMPOTENCY_IN_PROGRESS`、`file.rejected`）；按 A93 去掉等级模板价的“待生效”页签与行状态；按 A94 写明 `batchId` 即变更集 id；A78、A88、A104 已定的技术项移出第 6 节。③ 数据模型对齐：3.27 换文件、3.29 提交、3.13 换号写明“先停旧、再插新”的顺序（部分唯一索引不能延迟检查）；3.27 加锁顺序按 06:540，跳过与换文件后同事务重判批次状态（不再卡在 `uploading`）；3.29 提交前重算覆盖（`BATCH_MATCH_INCOMPLETE`）；3.22 同一源文件的资产按状态复用，`retired` 拒绝；3.19 版权问题下架一并停用转码中与失败的预告片资产。④ 页面缺口：`DramaRow.industries` 与 3.1 `industryCode`（按行业置顶）；3.31 `dramaId` 筛选（跳转定位）；`UploadBatchItem.episodeTitle`；3.2、3.32 带 `minLicenseMonths`；`pricedSince` 计入改热度等级的时刻；第 6 节补“内容有实质变更”勾选项与“调价是否推送”两项。⑤ 跨文档一致：员工引用改用 a01 `StaffBrief`；文件摘要改名 `DramaFileBrief`、剧目详情改名 `AdminDramaDetail`（与 a09 `FileBrief`、m04 `DramaDetail` 同名不同构）；操作日志行改用 a05 `ActivityItem`（不再返回前后值）；积分价字段改名 `listPricePoints`；3.35 改用 a07 的 `REVISION_ALREADY_EFFECTIVE`；`DRAMA_PRICE_UNCHANGED` 改为 400；体检未完成拆出可重试的 `TRAILER_SOURCE_CHECKING`（49218）；调价不再写“推送变价提示”（x01 无订阅者）；写明 `poster`、`drama_license_doc`、`trailer_src` 的上传与读权限规则，请 a01 登记。新定义错误码共 22 个 |
| 2026-10-03 | 第三轮：① 裁决回写——A141：3.19 版权问题下架停用转码中与失败的预告片资产直接引用 06:901（并取消名下媒体任务），3.22 源文件引用改为新建资产时登记（06:896、1641），3.27 复判引用 06:534，3.26 不设签发计数列（06:536），删去相应的“请媒体分组补登”；A129：`drama.copyright.revise`、`drama.media.manage` 已进增补表，清单键 `permissionsProposed` 改为 `permissionSupplements`（A140）并补“二次确认回显”列；A146：替换母带的“内容有实质变更”勾选已列入设计规范第 12 节待补原型，移出第 6 节（原第 11 项改为第 10 项）；A139：3.28 的三段式已登记进 C51。② C85、C87：去掉本文自定义的 `DictRef`（带 `isEnabled`），改用约定的通用结构 `{ code, name }`；3.7、3.8 新加入的停用字典编码返回 409 `DICT_ITEM_DISABLED`（m08 定义）。③ 跨文档：角色介绍的请求与响应字段名由 `cast` 改为 `roles`（与 m04 `DramaDetail.roles` 一致，路径仍为 `…/cast`，A61）；成片批次的 `targetLabel` 按 a05 `delivery.authorizeUpload` 写为“《剧名》· 工单号”，3.23 写明 `expectedCount` 与找回入口 `DeliveryTicketDetail.openUploadBatches`。`CursorQuery` 与 m01 一致，不改 |
| 2026-10-03 | 第四轮：A151 核对——`delistReasonCode`（05:62、101 的 CHECK 枚举）与 `reasonCode`（07:323 的 CHECK 枚举）都不是字典编码，保持不变；本文其余字典字段已按 C85 写为 `DictRef`，请求里的 `genreCode`、`industryCode` 仍收编码。无其他改动 |
