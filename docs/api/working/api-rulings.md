# 接口契约：主负责人裁决（2026-10-03，编号 A1–A156）

最初是针对约定稿（`conventions.md`，当时 C1–C82；现为 [00-conventions.md](../00-conventions.md)，C1–C87）与三份路线图（后合并为 `routemap.json`）的复核意见，之后各轮的裁决按节追加，共 138 条（A67–A69、A71–A75、A109–A118 未使用）。本文件优先级高于约定与路线图；两者按此统一。文中的 `conventions.md`、`rm/<文档>.json`（路线图切片）、`review/…`、`xdoc-…` 是写作过程中的工作文件名，切片已合并进 `routemap.json`，其余不在仓库里。

## 一、谁为准

| 编号 | 裁决 |
| --- | --- |
| A1 | **路径与资源名以路线图的写法为准**（它已按数据模型逐个对齐），约定稿里沿用草案路径的条文、示例、限流档位、版本门槛豁免清单全部按路线图改。限流档位与豁免清单按 operationId 登记，不按路径登记。 |
| A2 | 约定稿的**规则**（错误体、幂等、分页、并发、文件、长任务、再验证、版本兼容）为准，路线图按规则改。 |

## 二、路径与命名

| 编号 | 裁决 |
| --- | --- |
| A3 | 凭证（邀请令牌、下载页票据码、授权书验真码、回调里的签名与令牌）**一律不放路径**，放查询参数或请求体；访问日志对 `token`、`code`、`sig` 等参数脱敏。路径参数只有两类：uuid，以及以代码登记常量为主键的配置表的自然键（`staff_role`、`feature_flag`、`agreement`、`notify_scene`、`wx_template_slot`、`sms_template`、`site_config`、`dict_type`）。集号不放路径。 |
| A4 | 路径参数名 = 资源单数驼峰 + `Id`，全仓唯一含义：`orderId`（订购单）、`paymentOrderId`、`deliveryTicketId`、`serviceTicketId`、`portalTicketId`、`deliveryPlanId`、`licenseLetterId` 等；自然键用 `roleKey`、`flagKey` 这类。 |
| A5 | 一张表对应一个资源名。允许的“视图别名”只有三种：`/m/me`（当前账号）、当前门店的单例视图（`/m/store-profile`、`/m/current-store`）、父资源下的单例子资源（如成片包 `/order-items/{orderItemId}/release`）。资源登记表写进约定，契约自测按它检查。 |
| A6 | 后台路径**不加**菜单分组段。 |
| A7 | DELETE 只用于数据模型允许物理删除的行（06-data-model 第 3.4 节）与“退出当前会话”；其余移除、吊销、撤回、注销一律 `POST …/<动作>`（注销账号为 `POST /m/me/deletion`）。 |
| A8 | 所有字面路径段（GET 与 POST，如 `/summary`、`/quote`、`/lookup`）先于 `/{xxxId}` 注册，契约自测检查。 |
| A9 | 动作词表（同一语义只用一个词）：`submit`、`withdraw`、`approve`、`reject`、`confirm`、`request-change`、`cancel`、`void`、`retry`、`resend`、`read`（标记已读）、`acknowledge`、`assign`、`reassign`、`publish`、`unpublish`；上架用 `shelve`、下架用 `delist`（不用 `list`，避免与列表混淆）。约定稿列出完整词表，接口文档按词表命名。 |
| A10 | operationId = `<m|admin|portal|hooks>.<资源单数驼峰>[.<子资源单数驼峰>].<动作驼峰>`，全仓唯一；集合动作加 `batch` 前缀（`admin.takedownTask.batchCheck`）。它同时是幂等记录的作用域，发布后不改名。路线图每条补 `operationId` 字段。 |

## 三、鉴权、视图与权限

| 编号 | 裁决 |
| --- | --- |
| A11 | 路线图的鉴权拆成结构化字段：`xAuth`（取约定 C2 的枚举：public / user / member / staff / portal 等）、`capability`（商家端能力点）或 `permission`（后台权限点）、`clerkView`（`none` = 店员 403、`same` = 与老板相同、`trimmed` = 裁剪后的店员 schema）。新建档、接受邀请等尚无成员关系的接口用 `user`，不是 `member`。 |
| A12 | 店员视图清单按路线图实际开放给店员的接口扩充（门店列表、首页待办、服务经理名片、素材等），每个 `trimmed` 接口在文档里给出店员 schema，并进 clerk-visible-keys 黄金文件。 |
| A13 | **权限点注册表以一份为准**：接口文档引用的权限点必须在注册表里；路线图里标“建议”的新权限点汇总成增补表（键、模块、默认角色、是否再验证、是否附带待分配池），作为 07 主文档的附录，同时登记为 d4 第 7.1 节待回写。再验证（step-up）标记以注册表为准，接口不另行声明。 |
| A14 | **审批的决定走各自的领域资源**（R3“每类只有一个执行入口”）：`POST /admin/qualification-submissions/{id}/approve|reject`、`/admin/channel-account-submissions/{id}/…`、`/admin/launch-submissions/{id}/…`、`/admin/refund-requests/{id}/…`、`/admin/cancel-requests/{id}/…`、`/admin/point-adjustment-requests/{id}/…`、`/admin/term-extension-requests/{id}/…`、`/admin/account-change-requests/{id}/…`、`/admin/finance-config-revisions/{id}/…`、对公二人复核 `/admin/transfer-proofs/{id}/approve-review|reject-review`。每条有自己的权限点与请求体。撤回同样走领域资源（`…/withdraw`）。`/admin/approvals` 只保留跨类型的列表、汇总与详情（只读，聚合“我的待审批”）。 |
| A15 | 撤回与作废的权限严格按数据模型：撤回者是提交人本人；发起人已停用或对象已失效时，由该类型的决定权限点持有人代撤；取消申请的作废只限申请人（对象失效时由系统）。 |
| A16 | 补一个“我的待审批”页面（原型没有）：列出待本人决定的各类审批，详情与操作跳到对应领域资源的接口。补偿延长、账号变更两类的审批在这里处理。列入设计规范第 12 节与 05 第 4 节待补原型（由主负责人回写）。 |

## 四、幂等、留痕与试算

| 编号 | 裁决 |
| --- | --- |
| A17 | 路线图的幂等字段改为三值 `xIdempotent`：`required`（缺省）、`natural`（必须同时给出 `idempotentBy` = 数据模型里承担去重的约束名）、`none`（必须写理由）。**状态迁移一律 `required`**（重放返回上次成功结果，不能依赖状态守卫报 409）；“覆盖写、天然幂等”这一类取消，带 `lockVersion` 的 PATCH/PUT 也是 `required`。一条路由只有一种幂等方式，不按请求体切换。 |
| A18 | `none` 只用于：登录与换会话；签发短时地址（`…/download-urls`、`…/playback-urls`，结果不进幂等记录，避免回放过期地址）；埋点与错误上报；匿名建下载页票据；纯查询与试算。 |
| A19 | **GET 不写库**。需要逐次留痕的读取一律 `POST …/download-urls`（下载）或 `POST …/playback-urls`（播放预览），请求体指明要哪份文件；明文查看用 `POST /admin/pii-reveals`；后台取原片（会写 `master_checkout`）用 `POST /admin/delivery-tickets/{id}/materials/download-urls`。样片、广告的“已查看”证据只在这些 POST 里写。不需要留痕的缩略图、海报地址随列表与详情返回。 |
| A20 | 试算与预览一律 `POST`，集合级叫 `…/quote`（如 `POST /m/orders/quote`），针对单个对象叫 `…/{id}/<动作>-quote`（如 `POST /admin/orders/{orderId}/cancel-quote`）；幂等 `none`；不缓存。 |
| A21 | 乐观锁：只有数据模型状态机表的守卫列出了 `lock_version`（或同一行的第二把锁）的迁移，请求体才带 `lockVersion`；内容编辑（PATCH）一律带。字段名统一 `lockVersion`；列名不是 `lock_version` 的（如 `rev`）在约定里列为例外。 |

## 五、列表、计数与格式

| 编号 | 裁决 |
| --- | --- |
| A22 | 分页：商家端与下载页用游标、不返回总数；后台用页码并返回总数；后台的只增大表（审计日志、安全事件、回调收件、埋点）用游标，另返回封顶的近似总数 `totalApprox`（上限 10,000），满足“共 N 条”的显示。 |
| A23 | 页签计数统一由 `GET /<资源>/summary` 返回（两端同名），列表接口不返回计数。凡页面页签或标题带数字的，都要有对应的 `summary`。 |
| A24 | 查询参数：页签统一 `tab=`，关键词统一 `q=`，其余筛选按字段名。导出任务的参数按导出键各自定义 schema（报表、对账类可与列表不同构）。 |
| A25 | 表单需要“沿用默认联系人或登录手机号”时，用 `phoneSource: 'login' | 'store_contact' | 'input'` 表达，选 `input` 时才传号码；服务端补值。约定 C40 写明这条。 |

## 六、页面与流程的具体缺口（路线图照补）

| 编号 | 裁决 |
| --- | --- |
| A26 | 补接口：定时器“标记为不再需要”`POST /admin/timers/{timerId}/cancel`；授权书更正并重出 `POST /admin/license-letters/{licenseLetterId}/correct`；后台软删除素材 `DELETE` 不适用（素材不物理删除）→ `POST /admin/store-assets/{storeAssetId}/delete`；员工代交肖像授权 `POST /admin/store-assets/{storeAssetId}/portrait-auth`；广告版本“已发送”`POST /admin/ad-versions/{adVersionId}/mark-sent`（版本的登记与推送拆成两步，与 09 分组一致）；退款与取消申请的列表、详情、汇总（`/admin/refund-requests`、`/admin/cancel-requests` 及 `/summary`）；同意记录检索 `GET /admin/agreement-consents`；广告、下架核查、对公凭证的 `summary`。 |
| A27 | 短剧编辑页：`update-basic` 补 `episodeDurationSec`、`isAiGenerated`、`dramaClass`；`update-commercial` 补 `manualBoost`。 |
| A28 | 积分价模板与计费参数用一个变更集接口原子保存（`POST /admin/pricing-changes`，同一事务写两类修订），变更记录接口合并返回两类历史。 |
| A29 | 商家详情的“订单”页签拆成“付款单”“订购单”两个子页签，各用各的列表接口，不做合并时间线。 |
| A30 | 消息模板的测试发送只写 `notification_delivery`（`purpose = test`），不建通知行。 |
| A31 | 样片修改意见：V1.0 不做“按时间点提意见”（设计规范第 11 节为准）；商家端请求的 `feedbackKind` 固定为 `compose`，广告内容的修改到“我的广告”提出（文案提示）。 |
| A32 | 资质的提交只有 `POST /m/qualification/submit` 一个入口（含 M108 的“同一主体至多一个更换营业执照的 change 轮次”守卫与错误码）；保存档案基础信息只存草稿。 |
| A33 | 商家素材标签有误的反馈：店员仍不能提工单；素材详情加轻量反馈 `POST /m/assets/{assetId}/feedback`（写审计并通知交付经理）。店员进入客服中心只看到服务经理名片与在线客服入口。 |
| A34 | 积分明细按月分段的响应带 `prevMonth`（更早的、有记录的最近月份，没有为空）与 `firstEntryAt`；广告详情带 `relatedServiceTickets`；商城列表支持 `q=`。 |
| A35 | V1.0 超过小程序上传上限的大文件：由服务经理在后台代传（已有接口），小程序的超限错误返回统一的引导信息；电脑端上传仍是 V1.1。 |
| A36 | 文件“彻底删除”（个人信息删除请求）V1.0 不走审批单：仅超级管理员、要求再验证、填写原因、写审计；列为待法务确认。 |
| A37 | 授权书验真：下载页前端路由 `/v?code=…`，数据接口 `GET /portal/license-verifications?code=`（public）；不做服务端直出 HTML。印在 PDF 上的地址随之改为查询参数形式。 |
| A38 | 健康检查：`/healthz`（存活）、`/readyz`（就绪）在根路径、不进 OpenAPI、只回聚合状态；计费与资金的明细指标走内网 `/internal/health/finance`，不对外。 |
| A39 | 停机维护：采纳 503 `MAINTENANCE` 加启动引导的 `notice` 字段；启动引导、埋点、协议正文读取不受最低版本门槛拦截。 |

## 七、交付形态

| 编号 | 裁决 |
| --- | --- |
| A40 | 新增一份 `x01-events-jobs`：事件目录（事件名、聚合、载荷 schema、订阅者）与“非 HTTP 迁移归属表”（数据模型里由定时器、订阅者、任务进程触发的每个迁移 → 由谁负责）。接口文档共 20 份。 |

## 八、路线图定稿后的补充裁决（A41–A75）

| 编号 | 裁决 |
| --- | --- |
| A41 | 路径以路线图与资源登记表为准，裁决原文的写法作废：资质提交 `POST /m/store-profile/qualification/submit`；素材反馈 `POST /m/store-assets/{storeAssetId}/feedback`；切换门店 `PUT /m/me/current-store`。“当前会话”也算视图别名（`/m/sessions/current`、`/admin/sessions/current`、`/portal/sessions/current`）。 |
| A42 | 探活：保留 `/health`（外部拨测，只回聚合状态）与 `/healthz`、`/readyz`；计费、资金、流程的明细指标都走内网 `/internal/health/*`。探活不进 OpenAPI，不分配 operationId。 |
| A43 | 退出登录三端统一为 `DELETE /<端>/sessions/current`，幂等 `none`，端上把 401 当作已退出。 |
| A44 | 动作词表补登：`exchange`、`receive`、`verify`、`wake`、`notify`、`force-transition`、`rerender`、`recover`、`schedule`、`force-logout`。 |
| A45 | 权限点：路线图里出现的新键全部进增补表（键、模块、默认角色、是否再验证、是否附带待分配池由各文档作者按草案与页面给出建议，最后由汇总人统一）。“流程运维”“系统健康”“文件清除放行”归“系统”模块。只限超级管理员的操作用新键 `sys.super_admin`。权限取决于对象或请求体的接口（撤回、通用文件签发、明文查看、导出等）声明 `permission: assert-in-handler`，并在文档里写清处理器里的判定规则；契约自测允许这一取值。 |
| A46 | 再验证标记的取值（写进增补表，并登记为 d4 待回写）：`sys.staff.manage` 本身不要求再验证，另设 `sys.staff.secure_ops`（禁用、重置密码、重置动态口令）要求再验证；`finance.recon.resolve`、`order.payment.create_offline` 要求再验证。数据模型 08 分组的 `reconcile.resolve` 改名 `finance.recon.resolve`（数据模型待回写）。 |
| A47 | `merchant_user`、`entity_member`、`store_member`、`wx_template_slot`、`sms_template` 没有 `lock_version` 列，它们的 PATCH/PUT 不带 `lockVersion`（约定 C52 列为例外，不改表）。 |
| A48 | 资质联系人手机号的验证码拆成单独路由 `POST /m/store-profile/contact/sms-codes`（member + `store.qualification.edit`）；`POST /m/sms-codes` 只管换绑手机号。 |
| A49 | `idempotentBy` 改为字符串数组（可写多个约束名）。 |
| A50 | `m.paymentOrder.sync`（主动查单）幂等 `none`，理由：只查询渠道状态，入账由账本操作键去重。它与 `admin.refundRequest.retry` 都标为三段式用例（先调外部、再开事务）。 |
| A51 | 明文查看 `POST /admin/pii-reveals` 幂等 `none`（结果含明文，不进幂等记录），补进 A18 的清单。签发类接口附带的技术状态变化（打包、续签）不改变其 `none`。 |
| A52 | 站内消息是账号级的（每个收件人一行，生成时已按收件人角色出文案）：`xAuth = user`，`clerkView = same`，带门店上下文时按门店过滤。 |
| A53 | 协议同意的计数补能力点 `contract.read`，店员 403。 |
| A54 | 搜索结果返回 `totalApprox`（封顶 999），用于“找到 N 部短剧”；这是 C42“商家端不返回总数”的唯一例外。发布任务页的计数按“订单项 × 账号”（上线任务行）计。 |
| A55 | 门店列表不分页（门店数受套餐上限约束），一次返回全部，列为 C42 的例外。 |
| A56 | 素材反馈不建表：写审计并经通知中心提醒交付经理。 |
| A57 | 保留 `m.qualificationDoc.downloadUrls`、`m.ad.downloadUrls`、后台通用签发 `POST /admin/files/{fileId}/download-urls`（权限在处理器里按文件归属判定）。后台补 `POST /admin/files/{fileId}/cancel`。 |
| A58 | 对公二人复核（`transfer_confirm`）V1.0 不提供撤回（默认不启用）。 |
| A59 | 后台代录样片修改意见时可以选“广告内容”（`feedbackKind = ad_content`），商家端固定 `compose`。 |
| A60 | 动态口令：首次登录绑定沿用 `public` + 票据；用户菜单里的“动态口令设置”另设凭会话、要求再验证的接口。 |
| A61 | 剧目的演员子资源改名 `/admin/dramas/{dramaId}/cast`；`basic`、`commercial`、`quota` 等登记为父资源下的单例子资源。 |
| A62 | 发送日志 `notification_delivery` 用页码分页。 |
| A63 | 取消申请归 a05，退款管理页跨文档引用其 operationId；成片下载签发归 m05 与 p01。 |
| A64 | V1.1 的不合规路由（`{levelKey}`、收藏与常见问题的 DELETE）V1.1 设计时按 A3、A7 修正，现在只列为 V1.1 待定。 |
| A65 | 下载页维护期间显示通用的维护页（静态，不调接口）；回调在维护期间照常放行。下载页会话时长按数据模型默认（确认起 2 小时）。能力点 `sample.view`、`ad.view` 进增补表。 |
| A66 | 需要回写数据模型的几处由主负责人统一处理（接口文档按接口裁决写，不用等）：02 分组 `portal_ticket.public_id` 不再出现在轮询地址；13 分组授权书验真地址改为 `/v?code=`；06 分组回调路径；04 分组“带 submitNow 即提交”作废；08 分组退款申请撤回的守卫按 A15；`reconcile.resolve` 改名。 |

## 九、接口文档的错误码编号区间（A70）

各文档在下列区间内取号，避免撞号。引用其他文档已定义的错误码时直接用符号名，不要重新定义。

| 文档 | 区间 |
| --- | --- |
| m01-account | 41000–41099；协议同意 47400–47499 |
| m02-tenant | 41100–41199 |
| m03-profile-asset | 档案 49000–49099；素材与上传 46000–46099 |
| m04-mall-order | 订购 45000–45099；商城 49300–49399 |
| m05-delivery-publish | 交付 45100–45199；发布 46100–46199 |
| m06-ad | 45200–45299 |
| m07-billing | 账本 43000–43099；付款 44000–44099 |
| m08-support-misc | 客服 45500–45599；消息与其他 47000–47099 |
| a01-system | 员工与权限 48000–48199；文件与媒体任务 46400–46499；配置 47300–47399 |
| a02-workbench-report | 47200–47299 |
| a03-merchant | 租户 41300–41399；审批 48200–48299；资质审核 49100–49199；素材复核 46300–46399 |
| a04-content | 短剧库 49200–49299；积分价 43200–43299 |
| a05-order-delivery | 45300–45499 |
| a06-publish | 46200–46299 |
| a07-billing-finance | 账本 43100–43199；付款与财务 44100–44299 |
| a08-support | 45600–45699 |
| a09-ops | 47100–47199 |
| p01-portal | 41200–41299；下载 46500–46599；验真 47500–47599 |
| h01-hooks | 46600–46699 |

## 十、接口文档初稿之后的裁决（A76–A120）

凡作者写“已按默认处理、请确认”而本节没有提到的，一律接受作者的默认处理。

### 错误码

| 编号 | 裁决 |
| --- | --- |
| A76 | `REMINDED_TODAY`（同对象同场景每日只能人工催办一次）改为**通用码**，HTTP 409，编号 40920，写进约定 C27；a05、a06、a07 只引用。429 只留给限流。 |
| A77 | 跨文档共用的领域码归属（约定里加一张“共用领域码归属表”，其他文档只引用符号）：`CONTENT_REJECTED`、`SMS_UNAVAILABLE`、`SMS_CODE_INVALID`、`AGREEMENT_VERSION_STALE` 归 m01；`QUOTA_EXCEEDED`、`STORE_ARCHIVED`、`PORTAL_SESSION_INVALID` 分别归 m02、m02、p01；`STORE_NOT_QUALIFIED` 归 m04（HTTP 409）；`POINTS_INSUFFICIENT`、`SUBSCRIPTION_INACTIVE`、`QUOTE_CHANGED`、`ACCOUNT_BUSY` 归 m07（m07 补定义）；上传类 7 个码归 m08（47051–47057，m03 预留的 46050–46069 释放）；`DICT_ITEM_DISABLED` 归 m08；审批类 `APPROVAL_*` 归 a03；清单类 `CHECKLIST_*` 归 a01；“接收人无效”统一为 `ASSIGNEE_INVALID`（a05），a01、a03 的同义码删除改引用（`POOL_ROLE_MISMATCH` 语义不同，保留）。 |

### 列表、计数、幂等与安全

| 编号 | 裁决 |
| --- | --- |
| A78 | “有界小集合”可以不分页，响应 `{ items }`：门店列表、成员、下载页会话、选剧单（≤50）、套餐与积分包、角色、字典、开关、员工分组、分配池成员、清单模板、参数、一年的日历、剧目许可行、等级模板价、主体成员、对账的日行、受控财务配置的当前值。约定 C42、C43 列出这些 operationId。 |
| A79 | `summary` 可以同时带页头上下文（如开票页的抬头卡），不另开接口。 |
| A80 | 约定 C50 增加“结果脱敏”：响应含激活码、令牌、签名地址、支付调起参数、明文个人信息的，幂等记录只存脱敏后的结果，回放时这些字段为空并带 `replayed: true`，端上需要时换新键重调。`m.paymentOrder.wechatPrepay` 保持 `required` 并适用此规则。 |
| A81 | 换绑手机号保留当前会话、吊销其他会话（不换发令牌）。 |
| A82 | 会话路径按 A41、A43：`GET/DELETE /portal/sessions/current`、`/admin/sessions/current`、`/m/sessions/current`；路线图与资源登记表跟着改。 |
| A83 | 探活不分配 operationId，路线图里保留为“只登记、不进 OpenAPI”（`registryKeyOnly`）；补 `/internal/health/flow`；降级时 `/health` 与内网明细返回 503；维护开关不拦探活。 |
| A84 | 约定 C51 的三段式用例补：`m.me.changePhone`、`m.smsCode.create`（先落验证码行、提交后直发、失败删行）、`m.storeProfile.contactSmsCode.create`、`m.file.complete`（多事务）、`admin.notifyScene.testSend`、`admin.paymentException.resolve`、`admin.refundRequest.confirmNotAccepted`。 |
| A85 | 协议同意白名单 C73 补 `m.me.get`、`m.me.deletion.create`、`m.analyticsEvent.batchCreate`、`m.clientError.create`。 |
| A86 | 店员视图的禁用键扫描放行 `*Mask` 结尾的脱敏字段与目录标价类字段（`listPricePoints`、`adUnitPoints`、主推服务的 `priceFen`、`originalPriceFen`、`priceText`）。 |
| A87 | 商家端也允许 `capability: assert-in-handler`（如 `m.playable.get` 按资产类型判定）。新能力点 `asset.feedback`、`todo.read`、`support.manager.read`、`contract.read`、`sample.view`、`ad.view` 进增补表。 |
| A88 | 导出权限点 `<模块>.export` 补 `delivery.export`、`service.export`、`drama.export`、`billing.export`（默认授予有该模块查看权的角色，不要求再验证）。`sys.staff.mfa_reset` 并入 `sys.staff.secure_ops`；自助类再验证用标记 `self.mfa.reset`。 |
| A89 | 平台对公收款账号对商家返回明文（商家要复制去转账），是 C40 的例外，响应带 `no-store`。对公凭证的识别结果（付款户名、金额、附言、时间）按交易事实返回，不走明文查看。两项都列待法务、财务确认。 |
| A90 | 跨主体的汇总金额（报表、对账）以 `string(bigint)` 出接口，是 C31 的例外；单据与单主体金额仍是整数。 |

### 接口与流程

| 编号 | 裁决 |
| --- | --- |
| A91 | 补 `POST /admin/stores/{storeId}/assign-delivery-manager`（门店还没有交付经理时的首次指派，a03）。 |
| A92 | 客服工单：数据范围 = 本人负责的门店，或工单负责人在本人或本组；提交结果、关闭、改派须是当前负责人、主管或超级管理员（采纳 a08 的默认）；补 `PATCH /admin/service-tickets/{serviceTicketId}`（类型、优先级，带 `lockVersion`）与关联业务的增删（`POST …/refs`、`POST …/refs/remove`）。人工分配与改派不写 `assignment_history`。 |
| A93 | 等级模板价 V1.0 保存即生效（与原型一致）；定时生效以后再做。补偿延长、积分调整、受控财务配置、对公二人复核 V1.0 不设决定时限，只靠 `approval.escalate_workdays` 标记逾期。 |
| A94 | 积分价与计费参数的变更集共用一个应用生成的 uuid（写入两类修订的批次列），变更记录按它分组。 |
| A95 | 事件名以 x01 事件目录为准（采纳 x01 的命名规则 N1–N3 与改名）；各文档里不在目录里的事件名按目录改，确实缺的由 x01 补登。一个用例对同一事实只发一个事件（E2）。员工激活码短信改为提交后直发，不经出站事件。 |
| A96 | 剧目到期下架的定时器键带止日：`content.license_end:drama:{dramaId}:{licenseEndDate}`，止日变更按前缀取消后重新登记；定时器键的类型段一律用最终表名（`order_item` 等）。 |
| A97 | 广告版本的“查看方式”与样片同一口径：系统按开关写入 `weapp`、`album`、`portal`，员工只能补 `wecom`。广告视频不加水印（数据模型如此），接口文档里“带水印”的说法删掉。 |
| A98 | 制作档位的取值全仓统一为 `standard`、`advanced`、`top`（`production_record.production_tier` 的 `premium` 改为 `top`，主负责人回写数据模型）。 |
| A99 | 下载页成片包 ZIP 打包失败后，下载请求带 `retry: true` 才重新打包（`media.ensureZip` 增加重建选项），否则返回失败状态。 |
| A100 | 授权书验真二维码带版次：`/v?code=…&rev=…`；验真页的主体名称脱敏为保留前 2 后 4 个字（不足 7 个字只留首字），待法务确认。 |
| A101 | 下载页配对数字不一致时，确认接口返回 200 且 `status = rejected`（这样票据能被作废），不返回错误码。 |
| A102 | 退款回调晚到（申请已回到待执行）时照样记成功：数据模型 08 分组补一行 `pending_execution → done`（由回调触发），主负责人回写。 |
| A103 | 后台企业微信网页登录默认关闭（开关 `admin.wecom_web_login.enabled`），V1.0 由员工手填企业微信账号绑定。 |
| A104 | 剧目许可行、剧集的修改带父剧目的 `dramaLockVersion`；预告片与批量上传明细不带锁版本（约定 C52 例外）。 |
| A105 | 协议草稿发布与站点配置发布的守卫补“锁版本相符”，接口带 `lockVersion`（主负责人回写数据模型 13、14 分组）。 |
| A106 | 报表的历史月份在计费月结表建立之前由账本与每日快照现算。 |
| A107 | 需要补登的参数键与审计类别（不改表，契约登记）汇总进 07 主文档的“待回写清单”：`ocr.daily_limit_per_store`、`upload.weapp_video_max_mb`、`download.weapp_save_mode`、广告时长选项、修改轮截图上限、`notify.test_recipients`、`catalog.search.industry_fallback` 等；审计类别 `system_ops`、`report`、`merchant_quota`、`merchant_lifecycle`、`referral_code`、`ops_config`、`agreement`、`notify_config`。 |
| A108 | 其余作者提出、需要产品、业务、法务决定的事项，留在各文档第 6 节“待确认”，并汇总到 07 主文档。 |

### 第二轮的做法

| 编号 | 裁决 |
| --- | --- |
| A119 | 每份文档先由两位复核员挑错（与页面和数据模型是否相符；与约定和其他文档是否一致），再由修订员统一处理：本节裁决、其他文档发来的请求（`review/xdoc-<文档>.md`）、作者自己提的路线图修改、复核意见。路线图按文档拆成切片 `rm/<文档>.json`，修订员只改自己的切片，主负责人最后合并。 |
| A120 | 修订后自查：本文切片里的每条接口都在文档与清单里；清单的错误码、事件名都有定义来源；文档“修订记录”追加一段。 |

## 十一、约定第二轮修订后的补充（A121–A126）

| 编号 | 裁决 |
| --- | --- |
| A121 | 商家端幂等的请求哈希计入 `X-Store-Id`（同一个键在不同门店上下文下视为不同请求）。 |
| A122 | 游客视图 `viewerRole = guest` 采纳，列为 d4 `respondByRole` 待回写。 |
| A123 | `STORE_PROFILE_INCOMPLETE` 归 m03（49xxx 区间），m04 只引用。 |
| A124 | 约定稿新起的元数据名 `x-three-phase`、`x-redact-on-replay` 认可。 |
| A125 | 约定 C61 的地址有效期补：协议 PDF 30 分钟、发布清单文件 15 分钟。 |
| A126 | 第三方回调平台若不支持在回调地址里带查询参数，接入时按平台能力改为“路径里带不可枚举的随机段 + 服务端比对”，作为 A3 的例外由接入时登记，不影响现有接口文档。 |

## 十二、第二轮修订后的裁决（A127–A146）

第二轮修订员交给主负责人的事项在此一并裁决。没有提到的作者默认做法一律接受。

### 鉴权、再验证与登记

| 编号 | 裁决 |
| --- | --- |
| A127 | **驳回不要求再验证**（维持数据模型 `03-staff-authz-audit.md:806`）。约定增加路由级元数据 `x-step-up: skip`，只允许用在“决定类权限点”的驳回接口上，并在约定里按 operationId 逐条登记；登记了的路由即使权限点在注册表里标了再验证也不检查。a03（账号变更驳回）、a05（取消与退款驳回）、a07（各审批的驳回、对公凭证驳回）按此改，错误表删去 `STEP_UP_REQUIRED`。 |
| A128 | 能力点 `<组>.*`（`me.*`、`cart.*`、`invoice.*`、`ticket.*`）是 d4 能力点表里登记的**单个组键**，不是通配符；处理器按这个键判权。新能力点 `support.manager.read`（老板 ✔、店员 ✔、已停用门店的老板 ✔）用于 `m.serviceManager.get`，进增补表。 |
| A129 | 权限点增补表采纳各文档作者提出的默认授予（a01 `self.mfa.reset`、`flow.ops.view`；a02 `report.month_close.reissue`；a03 `merchant.entity.close`、`merchant.referral_code.manage`、`merchant.asset.upload_on_behalf`；a04 `drama.copyright.revise`、`drama.media.manage`；a06 `publish.link.verify_revoke`、`publish.metrics.enter`（V1.1））；从注册表删除 `sys.staff.mfa_reset`（A88 已并入 `sys.staff.secure_ops`）；`flow.admin.transition` 要求再验证，`sys.super_admin` 不另设再验证标记；`service.ticket.assign` 的含义改为“分配无负责人的工单（仅主管）”，待分配池为 `service_ticket`，`service.ticket.transfer` 含义为“负责人转出；主管可改派任意工单”；`delivery.sample.push` 注明同时用于登记广告版本的企业微信发送（`admin.adVersion.markSent`）。增补表加一列“要求二次确认回显”（C54 的适用范围）。客服工单的数据范围按 A92 记为任务范围（门店 = 本人负责的门店；负责人 = `service_ticket.owner_staff_id`；无待分配池）。权限点与能力点以 07 主文档的注册表为准，d4 附录的旧表不再回改。 |
| A130 | 限流档位（C68）：`m.login` 拆为 `m.login.silent`（每 IP 每分钟 30 次）与 `m.login.phone`（每 IP 每小时 10 次 + 每 openid 每小时 5 次）；签发类接口（`…/download-urls`、`…/playback-urls`）用 `m.sign` 档：每用户每小时 600 次（`d5-media.md:2036`）。 |

### 错误码与公共结构

| 编号 | 裁决 |
| --- | --- |
| A131 | 共用领域码归属表（C28）改为**由清单自动生成**：归属 = 定义它的清单，引用方 = 在 `errors` 里用到它的其他清单，数值、HTTP 取自定义方。另补登 `PLAN_REFUND_IN_PROGRESS`（m07，43006）。`details` 定型：`CONSENT_REQUIRED` = `{ pendingConsents: PendingConsent[] }`（结构归 m01）；`CONTENT_REJECTED` = `{ fields: string[] }`，默认文案用通用说法；`REMINDED_TODAY` = `{ scene, nextAvailableDate }`；`POINTS_INSUFFICIENT` = `{ requiredPoints, spendablePoints, shortfallPoints }`；`QUOTE_CHANGED` = m07 的 `QuoteChangedDetails`（按 `kind` 判别：`plan`、`topup`、`points`），m04 订购时用 `points` 分支，不另起 `drama_order`。a05 的 `CANCEL_QUOTE_CHANGED` 语义不同（退回试算），保留。 |
| A132 | **公共结构登记**：约定新增一节“公共结构登记表”。同一个 OpenAPI 文档（商家端、后台、下载页与回调）里，结构名唯一、只由归属文档定义一次，其他文档引用；跨文档同名不同构的，后登记的改名。已定的：`ImageRef = { fileId, url, expiresAt }`（m08；m06 的 `SignedImage`、a06 的“SignedUrl & { fileId }”改为引用它）；`SignedUrl = { url, expiresAt }`（a01，`url` 不可空，整个对象可空）；`AdminPage<T>`（a01；a05 的 `PageResult` 改用它）；`StaffBrief`（a01）；`AdminStoreBrief`、`AdminChecklistItemView`、`ChecklistResultInput`（a05）；`FollowUpItem`（a03）；`ChannelAccountBrief`（m05，a06 引用）；`Playable`（m06 2.8 为唯一定义）；`QuoteBlocker = { code, message, dramaId? }`（m04 定义，`dramaId` 只在订购报价里出现，m06 引用）；`DictRef = { code, name }`。完整登记表由主负责人按清单生成，同名不同构的由第三轮修订员改名。 |
| A133 | **字典编码的出入形态**：响应里一律返回 `DictRef[]`（字段名不带 `Codes` 后缀，如 `genres`），请求里一律收编码数组（字段名带 `Codes` 后缀，如 `genreCodes`）。快照里存的是编码，名称按当前字典取（字典项停用后仍返回名称）。m05 的 `genreCodes` 响应字段改为 `genres`。 |
| A134 | 同义的枚举取值全仓统一：未完成订单的阻断项统一为 `open_order`（m01 的 `order_open` 改名）。约定 C12 的动作词表补 `download`（导出任务 `actions` 里的“下载”）。 |
| A135 | 资产可播放结构（C62）：资产未就绪时所在字段返回 `null`；已就绪但不能在小程序内播放时返回只带海报的对象，`sources = []`。 |

### 接口与流程

| 编号 | 裁决 |
| --- | --- |
| A136 | 发布前改名：`admin.store.reassignManager`（`POST /admin/stores/{storeId}/reassign-manager`）改为 `admin.store.reassignDeliveryManager`（`…/reassign-delivery-manager`），与 A91 的 `assign-delivery-manager` 对称；a03 改切片，a08、x01 改引用。 |
| A137 | **文本内容安全检测服务不可用时 V1.0 一律拒收**：返回 503 `PROVIDER_UNAVAILABLE`（可重试）、不写库。草案“先接受、排队补检”的做法（`d4-identity.md:1883`、d5 第 11 节）数据模型没有落点，V1.0 不做；m01、m02、m03、m06 的写法统一为此，x01 不登记补检事件。图片与视频的检测仍按 d5（异步）。 |
| A138 | 渠道管理（V1.1）的 22 条接口暂归 a03；设计 V1.1 时另起一份接口文档。 |
| A139 | 约定各登记清单按第二轮请求补齐：C4 登录示例的 `mfaTicket` 改为 `ticket`；C43 有界小集合补 `admin.orderItem.licenseLetter.list`；C47 的 `none` 清单补 `admin.auth.me.enrollTotp`（结果只有一次性密钥）；C50 结果脱敏补 `m.order.create`（`items[].posterUrl`）、`m.cartItem.acceptPrice`（`drama.posterUrl`）、`m.paymentOrder.create`（`bankAccount.accountNo`）、`admin.auth.me.confirmTotp`（`recoveryCodes`）以及 a04 列出的剧目写接口（签名地址）；C51 三段式补 `m.qualificationDoc.create`（先调外部）、`admin.uploadBatchItem.complete`（多事务）、`admin.auth.bindWecom`（先调外部，仅扫码分支）、`admin.file.complete`（多事务）、`admin.file.restore`（先调外部）、`admin.file.erase`（多事务），`m.paymentOrder.wechatPrepay` 改为“多事务”；C52 无锁表补 `assignment_pool_member`；C56 补 `m.serviceManager.get` 的能力点；C61 补协议 PDF 30 分钟、发布清单文件 15 分钟（A125）；C66 商家端 `assert-in-handler` 补 `m.file.create`（按分类判权）、`m.message.list`、`summary`、`batchRead`、`read`（带 `X-Store-Id` 时校验 `message.read`）。 |
| A140 | 清单（`frag/*.json`）允许可选键 `externalSchemas`（引用的其他文档结构名）与 `permissionSupplements`（本文新增的权限点及默认授予），核对脚本读取它们。 |

### 回写数据模型（主负责人本轮执行）

| 编号 | 裁决 |
| --- | --- |
| A141 | 媒体（06）：`file_object` 补列 `erased_at`（彻底删除标记），状态机补“员工彻底删除”（`stored → deleting → deleted`；已是 `deleted` 的只写标记），恢复的守卫按该标记判断；`media_job` 的“人工重试”写明重设 `deadline_at`、`next_run_at`，清空 `error_code`、`error_message`，`is_retryable` 置假；`file.uploaded` 的时机改为确认（`pending → promoting`）；`upload_batch` 的收尾迁移补“员工跳过或替换后同事务复判”的触发方；`playable_asset` 补 `processing → retired`、`failed → retired`（剧目因版权或许可下架，`media.retireDramaMedia`），并取消该资产未完成的媒体任务；预告片源文件在资产创建时登记引用。批量上传的凭证签发不加计数列，靠 C68 限流。 |
| A142 | 交付（10）：`episode_output.source` 补取值 `normalized`（规格化产物），不再借用 `manual_upload`；`PlanContent.referenceAssetIds` 只含素材库素材，档案媒体的引用留在订购单上。订单与广告（09）：`09-order-ad.md:862` 按 A97 改为“系统按开关写入，员工只能补 `wecom`”。 |
| A143 | 身份与租户（02）：老板更换时新老板不是本主体成员的，新建 owner 成员行（迁移 `entity_member.create_owner`，`invitation_id` 为空），新账号首次登录按 C73 补同意。审批（03、04）：修正识别字段（a03 3.24）同事务给 `approval_request.lock_version` 加 1，让基于旧比对结果的决定返回 `VERSION_CONFLICT`。 |
| A144 | 公共（01）：`status_transition.elapsed_work_min` 是与同一链上一行之间的工作分钟数（中间夹着 `from = to` 的行也照常切段）；按状态统计停留时长时，把 `from_state` 为该状态的各行相加。定时器键补 `patrol.followup:patrol_task:{patrolTaskId}`（`admin.patrolTask.markAbnormal` 登记，恢复时取消）。客服（12）：定时器键的类型段用 `service_ticket`（A96），事件清单补 `service_ticket.supplemented`。 |
| A145 | 配置（14）：`dict_item.ext` 的 `permit_type`、`store_selling_point` 按 m03 2.8 定稿，播种食品经营许可证（`food_business`）与素材标签“品牌故事”（`brand_story`）；`ticket_type` 的 `ext` 加 `isAfterSales: boolean`（只这一个键对小程序下发），种子里“退款”为真；报表现金口径的截止条件改为 `payment_txn.applied_at <= cutoff_at`。文书（13）：授权书快照的 `verifyUrl` 格式为 `https://portal.<域名>/v?code=<验真码>&rev=<版次>`（A100）。 |
| A146 | 不改表、只登记的参数键、开关与审计类别并入 07 主文档的“待回写清单”（A107）：参数 `ad.duration_options`（默认 `{ opening: [3, 5], ending: [5, 10] }`）、`ad.revision_screenshot_max`（默认 1）、`catalog.search.industry_fallback`；开关 `ops.maintenance_notice`（json，`exposed_to = client`，默认 null）、`admin.wecom_web_login.enabled`（bool，默认关，`exposed_to = client`）；`notify.test_recipients` 的 `phone`、`wxOpenid` 标为敏感路径；审计类别 `service_ticket`、`docs` 以及各文档实际用到的类别（由主负责人按文档汇总）。登记新审计类别时同时在 a02 第 2.7 节“类别 → 菜单模块”对照表补一行。待补原型（设计规范第 12 节）：m06“制作中（待补充素材）”卡片与重新提交表单；a04 替换母带对话框的“内容实质变更”勾选；a08 工单详情改类型、优先级与增删关联的入口。草案 d1–d7 不回改，草案与契约不一致处以契约为准（如 d1 第 7.9 节的广告聚合）。 |

## 十三、第三轮期间的补充裁决（A147–A150）

| 编号 | 裁决 |
| --- | --- |
| A147 | 约定 C62 的可播放结构以 m06 2.8 的 `Playable` 为准（含 `kind`、`width`、`height`）；只带海报的对象 `sources = []`、`expiresAt = null`。 |
| A148 | 下载页签发发布清单文件（`kind = publish_list`）只查不建（`media.ensureZip` 的 `peek` 选项），ZIP 未就绪时不触发打包，页面改用发布清单文本在浏览器里生成文件；`admin.smsTemplate.testSend` 按“先落库”的三段式登记，与 `admin.notifyScene.testSend` 合用限流档位 `admin.notify_test`；`admin.homeBanner.create`、`update`、`batchReorder` 做结果脱敏（`imageUrl`）。 |
| A149 | 后台签发接口不另设限流档位（用 `admin.global`，逐次审计）；`admin.purgeRun.reject` 登记进 C86（驳回豁免再验证）。 |
| A150 | 公共结构登记补充：`DictRef`、`CursorPage<T>` 是约定里的通用结构；`AdminCursorPage<T>`（a01）、`DownloadUrl`（m05）、`EntityBrief`（m02）、`FileRegistration`（m08）、`PortraitAuthBody`（m03）、`LicensePeriod` 与 `LicenseConsent`（p01）各由归属文档定义一次，其他文档引用；后台与商家端同名不同构的结构，后台一侧加 `Admin` 前缀。 |

## 十四、第三轮修订后的裁决（A151–A156）

| 编号 | 裁决 |
| --- | --- |
| A151 | **单值字典字段**也按 C85：响应里给 `xxx: DictRef \| null`（字段名去掉 `Code` 后缀，如 `industry`、`category`、`province`、`city`、`district`、`type`、`withdrawReason`、`rejectReason`），请求里收编码（`xxxCode`）。只适用于字典项（`dict_item`）编码；数据库枚举（CHECK 取值）与业务编号（`planCode`、`checklistCode`、激活码、发票代码等）不变。成对出现的 `xxxCode` + `xxxName` / `xxxLabel` 合并为一个 `DictRef`。 |
| A152 | 公共结构归属补充：枚举 `PreviewChannel` 归 m06（与 `PlacementSlot` 同），m05 引用；`ImageRef` 只由 m08 定义，其他清单不再定义；操作记录行 `ActivityItem`（a05，对象详情页的操作记录）与审计日志行 `AuditLogItem`（a01，审计日志页）用途不同，两者都保留；`EntityQualificationBrief`（m03，原 m03 的 `EntityBrief`）登记；`SentryEnvelope` 在 a01、m08、p01 同形，按同一结构登记。 |
| A153 | 结果脱敏（C50）列出的字段在重放时可以为 `null`，数组字段也一样（C38“数组不写 null”的例外），字段类型写成 `… \| null` 并注明“仅重放时为 null”。 |
| A154 | 约定 C51：`admin.refundRequest.execute` 改为“多事务”（事务一记执行意图并提交，事务外调微信退款，事务二写结果与幂等记录）。约定 C12 的动作词表补 a07 用到的 `update`、`create-plan-revision`、`create-point-adjustment-request`、`create-term-extension-request`、`create-refund-request`。 |
| A155 | 审计类别（`audit_log.category`）补登：`payment`、`invoice`、`recon`、`finance_config`、`docs`、`delivery`、`service_ticket`、`approval`、`review`、`flow`，连同 A107 列出的类别回写数据模型 03 分组的类别清单；a01 审计日志的类别筛选与 a02 第 2.7 节对照表与之一致。 |
| A156 | 补记渠道退款时周期正挂在退款申请闸门上：按 08 分组（退款申请的归属分组）处理——**不回收**，另开 `entitlement_unrecovered`，那张在途申请之后由可退余额守卫拦下；07 分组 `revokeTermForExternalRefund` 的“一并收口并返回申请 id”改为“遇闸门不回收，返回 `heldByRefundRequestId` 供 08 开差异单”。数据模型 14 分组补 `reject_reason` 场景“取消与退款驳回”（4 个种子项）与参数 `refund.require_distinct_executor`（默认 false）。 |
