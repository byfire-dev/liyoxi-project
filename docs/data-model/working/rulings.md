# 主负责人对表清单复核意见的裁决（2026-10-03）

本文件是对 `catalogue.json`、`decisions.md` 的修订指令。编号 M 开头。每条都要落到 catalogue（表、notes、conventions）与 decisions.md 里；与主文档（01、03、04）字面不一致的，另由主负责人回写主文档，修订员不改主文档。

## 一、表的增、删、改归属

| 编号 | 裁决 |
| --- | --- |
| M1 | `portal_session` 归回 `identity`（三类会话都在身份侧，吊销与状态变更同事务）。`portal` 只留 `portal_ticket`。 |
| M2 | `manual_reminder_log` 下沉到 `notify`（L1），它是发催办通知前的限频闸。 |
| M3 | `follow_up` 下沉到 `staff`（L1，分组 03），定位为“运营跟进记录”：`tenant = entity`，`store_id` 可空；主体多态、不建外键；续费跟进的行带续费意向（`intent`）。后台“套餐到期”页的续费意向由读侧（L4）取每个订阅周期最新一条跟进组装，billing 不引用这张表。 |
| M4 | 新增 `channel_account_submission`（publish，门店维度）：账号核验每轮提交一行，与 `approval_request` 一对一，存轮次类型（新绑定、重新提交）、当轮填报快照、截图文件、比对结果。`channel_account` 只存当前值。 |
| M5 | 新增 `sms_verification`（identity）：商家侧短信验证码（用途、目标手机号盲索引、`code_hash`、`expires_at`、`attempts`、`used_at`），结构参照 d4 的 `staff_activation`。用途枚举：换绑手机号、资质联系人手机号验证；另留 `login`（自建短信登录，默认不启用，见 05 第 0 节）。 |
| M6 | 新增 `referral_code`（tenant）：渠道码与邀请码登记（码、来源类型 `sales` / `campaign`，V1.1 加 `partner`；归属员工；状态）。`merchant_user`、`entity` 上的 `source_type` 与码值快照在注册时由服务端按这张表判定。 |
| M7 | 新增 `wecom_contact`（identity）：商家用户与员工的企业微信外部联系人关系（`merchant_user_id`、`staff_id`、外部联系人标识（加密）、`added_at`、`removed_at`），由企业微信回调写入；后台“企业微信已添加”读它。 |
| M8 | `delivery_release` 上的 ZIP 缓存三列（`zip_state`、`zip_gen`、`zip_file_id`）拆到 media 自己的表 `zip_bundle`（按 `owner_type` + `owner_id` 关联发布批次，多态无外键）。`delivery_release` 只留业务快照。media 不写 L3 的表。 |
| M9 | `render_job`、`render_item` 移出 tables，列入“不建的表”（V1.1）。`agreement` 在 V1.0 只播种 6 份，服务商合作协议留到 V1.1 的迁移。 |
| M10 | `billing_month_close` 上线时不建，列入“不建的表”，注明“首个月结前补，结构待月结制度确定”。 |
| M11 | profile 的五张表先保留表名，字段级定义等 `docs/appendix/design/d9-profile.md` 完成后以它为准（可能增减表）。 |

## 二、约束与列

| 编号 | 裁决 |
| --- | --- |
| M12 | “同一对象只允许一张在途申请”由**领域表**表达：有执行步的审批类型（套餐退款、订购取消、广告取消、资质相关取消等）在提交时即建领域行，领域行带 `closed_at`（审批被驳回或撤回、或执行完成时写入），部分唯一索引建在领域表上（`WHERE closed_at IS NULL`）。`approval_request` 的去重索引只覆盖 `status = 'pending'`，只供没有执行步的类型使用。 |
| M13 | `approval_request.entity_id`、`store_id` 都可空（平台级与账号类类型没有主体），按 `kind` 写 CHECK（哪些类型必填 `entity_id`）。`refund_request`、`refund_txn` 的 `entity_id` 在孤儿收款退款时可空。归属列约定补一句：“平台级或主体未知的行，归属列为空”。 |
| M14 | 只增标记更正：`param_value` 改为 `append_only = false`，与 `billing_param` 同类（触发器只放行生效前写一次 `cancelled_at`）；`assignment_history` 改为 `append_only = false`（要补“已联系”标记与截止时间）；`auth_event` 保持只增但注明“触发器只拦 UPDATE；DELETE 只经清理函数（保留 12 个月）”。 |
| M15 | 金额与大整数：单据金额一律 `integer`（分）；`recon_day` 的全部 7 个 `*_fen` 汇总列用 `bigint`；`media_job.est_cost_micro` 用 `bigint`；字节数（`size_bytes`、`total_bytes` 等）用 `bigint`。凡 `bigint` 列出接口时转字符串。 |
| M16 | `seq` 只指 `pk = uuid+seq` 的只增表上的 `bigint identity` 列。子表里的顺序号改名：`store_asset_file.seq` → `position`，`point_hold_alloc.seq` → `alloc_no`。 |
| M17 | 外键列名用“被引用表全名 + `_id`”：`delivery_ticket_id`、`service_ticket_id`、`portal_ticket_id`、`drama_order_id`、`billing_order_id`。不再出现含义不明的 `ticket_id`、`order_id`。`publish_list`、`publish_list_episode` 保留表名，notes 注明归 delivery。 |
| M18 | `playable_asset` 补 `entity_id`、`store_id`（预告片等平台级资产为空），创建时从来源复制。 |
| M19 | 多态引用的 `*_type` 取值与 `status_transition.machine` 的取值一律用**最终表名**（如 `order_item`、`ad`、`subscription_term`、`delivery_reissue`、`delivery_plan`）。账本幂等键里的类型段同样用最终表名（尚无存量数据，不保留旧值）。在命名规则里加这一条，并列出相对草案改掉的取值。 |
| M20 | 参考素材：订购单与广告需求的参考素材不存数组列，统一经 `file_ref` 登记（`owner` 为订购单或广告，角色为 `reference`）；其中来自素材库的另写一行 `store_asset_usage`。来自档案媒体的只走 `file_ref`。 |
| M21 | `audit_log.job_run_id` 改为 `timer_id`（周期任务的定时器行），保留 `job_name`。 |
| M22 | 素材复核、对公收款确认、开票申请不进 `approval_request`（它们是处理队列）。三张领域表各补 `due_at` 与时限参数快照列；`sla.breach` 定时器的主体类型改为这三张表；“审核时效”指标从领域表取。工作台待办对它们走派生查询。 |
| M23 | `webhook_event`：表结构骨架取 d4；微信支付这一 Provider 的载荷按 03 第 1.4 节与 d2 执行——只存 APIv3 密文三元组、`key_version` 与不含 openid 的摘要，密文 180 天后清空；d4 里“微信支付 payload = full”的写法作废。列出两稿各自保留的列。 |
| M24 | 参数键归属（逐键列表写进 decisions）：会进入单据快照、影响计价与账务的键留在 `billing_param`（d1 的 13 个）；付款单超时、对公转账有效期、升级报价有效期三个时限键放 `param_value`（config 的参数服务），键名 `billing.payment.order_timeout_minutes`、`billing.payment.transfer_valid_days`、`billing.upgrade_quote_valid_hours`（只留小时这一个，默认 48）；购买入口策略与支付限额等受控配置只在 `finance_config_revision`（需审批），不映射到 `param_value`。 |
| M25 | 对公大额二人复核若启用，登记为一个审批类型 `transfer_confirm`，`transfer_proof` 上留可空的 `review_approval_request_id`；不另设绕开统一审批单的复核通道。默认不启用（由受控配置开关）。 |
| M26 | 授权书签署：`license_letter_revision` 同时支持图片章与电子签两种方式（`sign_method`），平台签署时间必有、商家签署时间可空；是否强制双方电子签待法务，不影响表结构。 |
| M27 | 样片的“已查看”证据：下载页或相册保存对样片文件的访问写 `audit_log` 的访问流；`sample` 行上留 `first_viewed_at`（由访问回写）与商家在小程序勾选确认的 `viewed_ack_at`、`viewed_ack_by`。不另建表。 |
| M28 | 三类剧双平台是否出两套成片未定：V1.0 每集成片只有一个版本，`episode_output` 保留可空的 `variant` 列（默认空），不为它建额外的表。 |

## 三、调用方向与锁顺序

| 编号 | 裁决 |
| --- | --- |
| M29 | 同层调用白名单增补：`content → media`、`identity → approval`、`identity → docs`、`tenant → docs`、`profile → approval`、`profile → tenant`、`profile → media`。`merchant_user.consent_stamp` 由 identity 自己写（docs 的 `assertConsents` 只返回是否已齐与指纹），避免 docs 写 identity 的表。 |
| M30 | 告警：kernel 定义告警端口，ops 注册实现；下层不直接写 `alert_event`。与 `analytics_event`、`invariant_violation` 同一做法。 |
| M31 | 活动流（商家详情的操作日志、工作台实时动态、各单据详情的日志）统一读 `audit_log`；`status_transition` 只供指标与进度时间轴。`flow.transition()` 在同一事务里补写一条活动流的审计行。 |
| M32 | 合并出一份**全局加锁顺序表**写进 decisions：以 01 第 7.1 节的九类为主干（审批单 → 门店 → 广告 → 订购单 → 订单项 → 工单 → 付款单 → 收款交易 → 计费账户），把 d2、d3、d4 各自的顺序并进去，给 `state_machine = true` 的每张表以及 `assignment_cursor`、`staff`、`merchant_user`、`entity`、`entity_member`、`invitation`、`refund_request`、`cancel_request`、`account_change_request`、`channel_account`、`launch_task`、`takedown_task`、`service_ticket` 定次序。catalogue 每张表加 `lock_rank`（整数，或 null 表示不参与排序）。有矛盾处（如 `cancel_request` 在 d2 与 d3 里位置不同）给出取舍与理由：领域申请单紧跟审批单之后。 |

## 四、对主文档的四处偏离（已获主负责人确认，decisions 里改记为“已确认，主文档待回写”）

1. 01 第 6.3 节“状态迁移只经 `flow.transition()`”收窄为业务状态机（约 25 张表）；账本内部状态由计费函数维护并记入订阅事件与流水；任务、投递、文件处理这类技术状态不写状态历史。
2. `drama_episode_master`、`drama_trailer` 归 media（文件与体检在 media；content 经端口取剧目事实，持有引用）。
3. 金额一律 `integer` 的例外：见 M15。
4. 银行流水号与付款行放在 `payment_txn`（实际到账的那笔交易），不放 `transfer_proof`（商家上传的凭证）。

## 五、其他已确认的处理

- 取消退回积分的领域头表 `cancel_request` 归 order，`refund_request` 只管现金退款；后台“退款管理”页按审批类型聚合两类单据。确认。
- 开票申请、对公收款确认、素材复核不进审批单。确认（见 M22）。
- 服务商合作协议不在 V1.0 播种。确认（见 M9）。

## 六、补充裁决（2026-10-03，表清单修订与核对之后）

这些裁决针对修订员与核对员提出的遗留问题，优先级与前面相同。字段级建模时直接按此执行，不必回头改 catalogue。

| 编号 | 裁决 |
| --- | --- |
| M33 | M17 是通则：凡外键列（含复合主键里的外键列）一律用“被引用表全名 + `_id`”，如 `point_hold_id`、`store_asset_id`、`outbox_event_id`、`point_ledger_entry_id`、`subscription_term_id`、`site_notice_id`、`delivery_release_id`、`license_letter_id`。按角色命名的外键列不受此限（`delivery_manager_id`、`created_by_staff_id`、`placed_by_user_id` 这类）。catalogue 里还写着缩写的地方，以本条为准。 |
| M34 | M16 是通则：`seq` 只用于 `pk = uuid+seq` 的表上的 `bigint identity` 列（不论该表是否仍标只增，`param_value`、`assignment_history` 保留 `seq`）。其余表示“第几个”的列一律改名：同一父行下的排列顺序叫 `position`；轮次、版本、序号叫 `<含义>_no`（如 `round_no`、`version_no`、`item_no`、`attempt_no`）。草案里的 `order_item.seq`、`ad_revision.seq`、`transfer_proof.seq`、`notification_delivery.seq`、`subscription_term.seq` 等由各分组作者按含义改名，并记入“相对草案的改动”。 |
| M35 | M24 更正：留在 `billing_param` 的是 12 个键（d1 的 13 个里去掉升级报价有效期，它移到 `param_value`）。 |
| M36 | 同层白名单再增补 `profile → identity`（资质联系人手机号验证、读取登录手机号）。不成环。 |
| M37 | `portal_session.portal_ticket_id` 只存 id、不建外键，保留唯一约束，避免 identity 与 portal 之间出现双向外键。 |
| M38 | M28 改为：`variant` 列在 `episode_output`、`delivery_release`、`upload_batch` 上都是 `text NOT NULL DEFAULT 'common'`（沿用 d5 的写法），V1.0 只写 `common`；是否出平台专用版本未定，不为它建额外的表。 |
| M39 | `approval_request` 上“哪些审批类型必填 `entity_id`、`store_id`”的逐类型清单由 03 分组的作者给出并写成 CHECK。 |
| M40 | 来源类型 `source_type` 取 `organic`、`sales`、`campaign`、`partner`（`partner` 在 V1.0 只声明）。 |
| M41 | M26 的列名与取值沿用 d6：`sign_mode`（`platform_cert`、`esign_seal`、`stamp`）；签署时间拆成 `platform_signed_at`（必有）与 `merchant_signed_at`（可空）。 |
| M42 | M23 的排布由 15 分组的作者定，原则：各 Provider 通用的列做成独立列（含 `key_version`、载荷清除时间）；Provider 专有的内容放一个 jsonb 载荷列；微信支付只存密文与不含 openid 的摘要。 |
| M43 | 加锁顺序里修订员补的三处予以确认：账号与租户链整段排在审批单与领域申请单之后；`drama` 排在门店之后、广告之前；d5 的媒体段并入。 |
| M44 | 操作人可能是多种类型的表一律三列齐全（`actor_type`、`actor_id`、`client`），`store_profile` 的最近编辑人同样补 `client`。 |
| M45 | 周期任务的定时器行没有主体：`timer.subject_type`、`subject_id` 为空。文件派生物等不是表名的多态取值，由所在分组的作者登记为例外并在文档里列出。 |

## 七、字段级初稿之后的裁决（2026-10-03，M46–M92）

依据：15 个分组的作者在初稿里提出的问题与跨分组请求。凡作者写“已按默认处理、请知悉或请确认”而本节没有提到的，一律视为**接受作者的默认处理**。

### 工具与写法

| 编号 | 裁决 |
| --- | --- |
| M46 | 校验工具已升级：`check_fragment.py` 与 `integrate.py` 会为“带外键的关系”自动补反向字段（含带关系名的），桩也会按关系的 `references` 补出外部表的非 `id` 列。因此：① 同一个模型有多个关系指向同一个模型时，每个关系都写关系名（`@relation("本模型名+角色", fields: …)`），不必再写反向字段；② 初稿里因为工具限制而注释掉的关系字段、放进手写 SQL 的外键（含 `DO` 块），全部移回 Prisma 片段，SQL 里的同名语句删除；③ 分组内已经手写的反向字段可以保留。 |
| M47 | 归属一致性全仓统一：凡同时带 `entity_id` 与 `store_id`、且 `store_id` 对 `store` 建外键的表（L1 及以上），把指向门店的外键写成复合外键 `(store_id, entity_id) → store(id, entity_id)`（Prisma：`@relation(fields: [storeId, entityId], references: [id, entityId], …, map: "fk_<表>_store_entity")`），另保留 `entity_id → entity(id)` 的单列外键。`store_id` 可空的表同样这样写（为空时不校验）。`store` 上已有 `uq_store_id_entity_id`。初稿里用 `DO` 块建的复合外键改回 Prisma。L0 的表不建外键，不受此条影响。 |
| M48 | 主键约束统一命名：单列主键写 `@id(map: "pk_<表>")`，复合主键写 `@@id([...], map: "pk_<表>")`。 |
| M49 | `seq` 用 Prisma 的 `@default(autoincrement())`（库里是 `bigserial`），不再要求 `GENERATED ALWAYS AS IDENTITY`。标量数组列的 `NOT NULL` 在手写 SQL 里用 `ALTER COLUMN … SET NOT NULL` 补。Prisma 能表达的索引类型（含 GIN）写在片段里；部分索引、表达式索引写在 SQL 里。`pg_trgm` 已移到公共文件，各分组 SQL 里的同名语句删除。 |
| M50 | 公共文件新增两个触发器函数，各分组改用它们并删除自己重复定义的同类函数：`lyx_forbid_delete()`（只拦 DELETE 与 TRUNCATE）、`lyx_forbid_column_change('列1','列2')`（指定列创建后不可改）。 |
| M51 | IP 地址列一律 `text`。 |
| M52 | 多态类型列的校验方式统一：跨模块的多态类型列（`outbox_event.aggregate_type`、`timer.subject_type`、`status_transition.machine`、`notification.biz_type`、`audit_log.target_type`、`file_ref.ref_type`、`invariant_violation.subject_type` 等）只写格式 CHECK（小写蛇形），取值清单放在 `packages/contract` 的登记表，启动时对照表名单校验；文档里列出已知取值。只有取值少、由本模块自己写入的多态列（如 `point_hold.ref_type`、`cancel_request_line.target_type`）才逐值 CHECK。 |

### 跨分组统一

| 编号 | 裁决 |
| --- | --- |
| M53 | `status_transition` 增加 `state_field text NOT NULL`（被迁移的状态列名，如 `status`、`lifecycle`、`qualification_status`、`verification_status`），主索引改为 `(machine, subject_id, state_field, seq)`。同一张表有两个状态列时靠它区分，不再依赖事件名前缀。 |
| M54 | 领域申请单的执行状态统一（`refund_request`、`cancel_request`）：`status` 取 `pending_approval`（已提交、待审批）、`pending_execution`（已批准、待执行）、`executing`（执行中，只有现金退款用）、`done`（已执行）、`not_executed`（未执行即关闭）；另有 `closed_at` 与 `close_reason`（`rejected`、`withdrawn`、`voided`，仅 `not_executed` 时非空）、`close_note`。`done` 与 `not_executed` 时 `closed_at` 非空。“审批通过后、执行前作废”记为领域行 `not_executed` + `voided`，审批单保持 `approved`。 |
| M55 | 状态机或账本逻辑依赖其取值的原因码用枚举加 CHECK，不做成可维护字典：积分调整原因（`point_adjustment_request.reason_code`）、取消原因（`cancel_request` 等的 `reason_code`）、客服工单关闭原因。14 分组把 `adjust_reason`、`cancel_reason`、`close_reason` 从可维护字典里去掉（或标为系统枚举、只可改显示名）。`extend_reason` 等不参与逻辑的保持为字典。 |
| M56 | 清单模板的引用列统一叫 `checklist_code`、`checklist_version_no`，按值引用 `checklist_template (code, version_no)`，不建外键；`approval_request`、`qc_record`、`patrol_task`、`takedown_task` 等都改成这两个名字。 |
| M57 | 指向自然键表的外键列用“被引用表全名 + `_` + 主键列名”：`staff_role_key`、`notify_scene_key`、`wx_template_slot_key`、`sms_template_key`、`agreement_key`、`dict_type_key`。 |
| M58 | 指向 `file_object` 的外键列统一叫 `file_id` 或 `<角色>_file_id`（M33 的既定例外）。 |
| M59 | 集数与集序号一律 `integer`（`episode_no`、`episode_count`、`*_episode_nos`）。 |
| M60 | `SlaSnapshot.calendarVersion` 是整数（与 `work_calendar_day.calendar_version` 同型）。时限快照列统一叫 `sla_snapshot`（一行有多个时限时用带前缀的名字或三段结构）。 |
| M61 | 交付经理列统一叫 `delivery_manager_id`（`store`、`drama_order`、`delivery_ticket`）。`delivery_ticket.editor_id`、`publisher_id` 保留。 |
| M62 | “确认前在哪看过”的取值统一：`weapp`、`album`、`portal`、`wecom`，`sample` 与 `ad_version` 两处相同（`wecom` 是否足以作为确认证据待法务，先保留取值）。 |
| M63 | 允许物理删除的对象补充：`wechat_identity`、`user_session`、`portal_session`、`staff_session`、`staff_activation`、`sms_verification`、`merchant_user_notice`、`wecom_contact`、`store_member`、`portal_ticket`、草稿门店、`cart_item`、`order_item_account`、`order_item_placement`、已恢复超过 180 天的 `alert_event`。引用这些行的外键要么不建，要么写明删除行为。 |
| M64 | 同层白名单再增补 `staff → media`（服务经理二维码文件）。 |

### 逐项

| 编号 | 裁决 |
| --- | --- |
| M65 | `outbox_event`：V1.0 不清理事件行；`aggregate_type`、`aggregate_id` 可空（两列同有同无）；作者补的操作人与客户端四列保留。`events.redeliver` 周期任务不保留。 |
| M66 | 履约受阻的付款单允许“重试履约”（采纳 d1）：`payment_exception.resolution` 增加 `retried`。套餐退款处理期间有主体级闸门（采纳 d1 与 03 第 2.7 节）：`subscription_term.refund_request_id` 非空即闸门关闭。 |
| M67 | 退款规则取值统一用 d1 的：`window`、`qualification_failed`、`override`（`subscription_term.refund_rule` 与 `refund_request.rule_code` 相同）。 |
| M68 | 对公凭证被驳回后付款单回到 `pending_payment`，`transfer_state = proof_rejected`（采纳主文档 03）。 |
| M69 | `ad` 增加 `open_cancel_request_id`（与 `drama_order` 相同的做法），库级保证一条广告同一时间只在一张在途取消申请里。 |
| M70 | `qc_record` 的成片包级质检：`target_type = delivery_ticket`、`target_id` 为工单 id（推送前还没有发布批次行）；`qc_record` 加 `lyx_forbid_update()` 触发器（质检记录是证据）。 |
| M71 | `takedown.overdue` 定时器的主体是 `takedown_task`；取消申请执行时限的 `sla.breach` 主体是 `approval_request`。 |
| M72 | 账号类型由发布专员在核验时填写（采纳 d3）；商家在绑定表单里填的值进当轮提交快照。 |
| M73 | 撤销核验通过时新建一行回填（`round_no + 1`）并建新审批单，原行停在 `revoked`（采纳 11 分组作者的做法，保持与审批单一对一）。 |
| M74 | `drama.is_body_modifiable` 改为枚举列 `body_edit_policy text NOT NULL DEFAULT 'undecided'`（`undecided`、`allowed`、`forbidden`）。 |
| M75 | `price_tier_revision` 按只增处理（触发器拦 UPDATE、DELETE）；三张带生效时间的修订表不加撤销人列（撤销人看审计日志）。 |
| M76 | `webhook_event`：采纳 15 分组作者的排布与口径（`payload` jsonb + 独立的 `key_version`、`payload_purge_at`、`payload_purged_at`；`mode` 表示这一行实际走的方式；来源取值含 `wecom`）。 |
| M77 | `analytics_event` 按月分区由手写 SQL 重建，是“SQL 不写 CREATE TABLE”的既定例外。 |
| M78 | 店员不能提交客服工单（采纳 d3 的默认），列为待确认。下载页会话按 d4（确认起 2 小时绝对过期），是否改为闲置过期列为待确认，不加列。 |
| M79 | `approval_request`：`payload` 与 `precheck` 合并为 `summary_snapshot`；`plan_refund` 的对象允许 `payment_txn`（孤儿收款退款）。 |
| M80 | `agreement.scenes` 等标量数组列凡文档写“否”的，SQL 里都要有 `SET NOT NULL`（整体校验发现 `agreement.scenes` 漏了）。 |

### 第二轮的做法

| 编号 | 裁决 |
| --- | --- |
| M90 | 每个分组先由两位复核员挑错，再由修订员统一处理：本节裁决、其他分组发给本分组的配合请求、复核意见。修订后三处文件仍须一致并通过 `check_fragment.py`。 |
| M91 | 修订员不改其他分组的文件。需要对方改而对方的请求清单里没有的，写进返回的 `cross_group_requests`，由主负责人在整体校验后处理。 |
| M92 | 各分组文档第 6 节“待确认”只保留真正需要业务、法务或主负责人决定且会影响表结构的问题；已由本文件裁决的删除或改写为结论。 |

## 八、第二轮之后的收尾裁决（2026-10-03，M93–M110）

| 编号 | 裁决 |
| --- | --- |
| M93 | 草稿门店**不**物理删除：删除草稿门店只做停用（`archive_reason = draft_deleted`），之后一律拒绝访问。M63 清单里去掉“草稿门店”。所有引用 `store` 的外键统一 `ON DELETE RESTRICT`（`billing_order.store_id` 改回 RESTRICT）。04 分组设想的 `StorePurgeHook` 端口不需要。 |
| M94 | 同层白名单再增补 `identity → notify`（只用于 `notify.sendDirect`：验证码与换绑通知）与 `identity → media`（账号变更证明材料的 `files.link()`）。 |
| M95 | 允许物理删除的对象再补充：`drama_episode`（剧目不在已上架状态、且该集没有当前原片时；改总集数的同一事务）、`service_ticket_ref`（客服移除关联错的行，写审计）。 |
| M96 | `outbox_delivery` 在 V1.0 同样不清理。`webhook_event`、`invariant_run` V1.0 不删行。 |
| M97 | 采纳 01 分组对定时器的两处改动：`rearmAfterSkip`（V1.0 只有 `order.start`）与 `work_calendar_day.calendar_version` 只在日历类型实际变化时升批次。`order.pending_start_sweep` 作为周期任务登记定时器行。 |
| M98 | 升级过的套餐周期不能按套餐规则退款（采纳 d2）：`refund_request` 保持一张申请对一笔收款；07 分组在 `suspendTermForRefund` 加守卫“周期没有 upgraded 事件”，并把默认写法从 d1 改为 d2。需要退的走人工规则外退款（`override`）。 |
| M99 | 套餐 7 天窗口按申请创建时刻判断（采纳 08 分组的处理，删除 `window_ref_at`）。 |
| M100 | 07 分组提供不经闸门的回收入口 `revokeTermForExternalRefund(tx, { termId, paymentExceptionId })`，供差异单“补记渠道退款”使用（不改表）。 |
| M101 | `SlaSnapshot` 是全仓共用结构：`{ policy, amount, unit, calendarVersion }`，`calendarVersion` 为整数；`unit = same_day_cutoff` 时 `amount` 是截止时刻距当日零点的分钟数（18:00 = 1080）。09、12 分组文档里写成字符串的地方改为整数。 |
| M102 | `audit_log.client` 增加取值 `cli`（运维命令行以员工身份执行的操作）；只在审计日志上允许，其他表的 `client` 仍是 `weapp`、`portal`、`admin`。 |
| M103 | 出站投递死信的探针级别取 P1（采纳 15 分组）。这是部署配置，01 分组文档里写 P2 的地方改为 P1。 |
| M104 | `cancel_request` 保留 `executed_by_staff_id` + `is_executed_by_system` 的写法（与审批单一致），不改三列。 |
| M105 | 授权书编号 `SQ` 与工单号 `JF` 一样由订购单号派生，不经 `biz_sequence` 取号。 |
| M106 | 账号核验不加指定处理人列（采纳 d3：按权限点进入角色队列）。画板 admin/Accounts 队列卡上的“发布专员”显示列为产品待确认项。 |
| M107 | 交付经理变更（含禁用移交、自动改派）都带“新交付经理 1 个工作日内联系商家”的时限（采纳 03 分组默认）。 |
| M108 | 04 分组提出的“同一主体同时有两个更换营业执照的 change 轮次”不加库约束，在接口层校验。 |
| M109 | 第三轮（收尾）的范围：每个分组只处理第二轮其他分组发给自己的请求（`review/xreq3-<分组>.md`）与本节裁决；不再做全面复核。改完必须通过 `check_fragment.py`，并在文档“修订记录”里追加一段。 |
| M110 | 各分组文档里提到其他分组的表与列时，以对方第二轮之后的列名为准（对方的改名清单在 `review/wf2c-fix.json` 的 `renamed_columns`）。 |

## 九、整合时的最后几处（2026-10-03，M111–M112）

| 编号 | 裁决 |
| --- | --- |
| M111 | `SlaSnapshot` 是五个键：`{ policy, amount, unit, calendarVersion, computedAt }`，`computedAt` 是时限的起算时刻，日历修正重算时不改它（只改 `calendarVersion` 与截止时间）。已升级周期的规则外退款：来源付款单的 `override` 申请执行时作废整个周期；之后各笔升级补差款的 `override` 申请不再调用闸门函数，只退现金。 |
| M112 | `store_asset_tag.valid_from`、`valid_to` 按日期列命名约定改为 `valid_start_date`、`valid_end_date`。 |
