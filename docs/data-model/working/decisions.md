# 统一表清单：裁决记录

日期 2026-10-03。配套文件 `catalogue.json`（166 张表，全部在 V1.0 建）。本稿已按主负责人裁决 `rulings.md`（M1–M32 与第四、五节）修订，逐条落点见第 5 节。profile 的五张表已按 `d9-profile.md` 并入（M11），改动见第 12 节。

- 引用写“文件名:行号”：`d1`…`d8` 指 `docs/appendix/design/` 下的八份草案，`d9` 指同目录后补的 `d9-profile.md`，`01`、`03`、`04`、`05` 指 `docs/` 主文档，`prd-tech`、`proto-*` 指 `docs/appendix/research/`。
- 优先级：主负责人裁决 M1–M32（`rulings.md`）> 03 第 9 节的裁决 R1–R15 > 01 第 5、6 节 > 草案。草案之间不一致、主文档又没有裁决的，由本文定，并写明理由。
- 本文只定到表：表名、归属模块、分组、主键形态、归属列、是否只增、是否走状态历史、跨模块外键方向、加锁次序。列的增删只在影响这些结论时提到，其余留给字段级建模。

## 1. 跨草案分歧与处理

| # | 分歧 | 涉及草案与行号 | 处理 | 理由 |
| --- | --- | --- | --- | --- |
| 1 | 主键类型：`bigint` 自增还是 UUID v7 | d3:235；d5:8、457；d6:81；d7:253；d2:187（随全仓约定）；d1:183（记作 uuid，未定）；d4:156（UUID v7） | 全部改 UUID v7，应用生成。三类例外保留自然键或复合主键：键是代码登记常量的配置表、与父表一对一的扩展表、纯关联表与基础设施表（清单见 `catalogue.json` 的“主键”约定与各表 `pk`） | R1（03:601）。例外表的主键不出现在接口路径里，也不存在跨环境合并冲突，换成代理键只多一列和一个唯一约束 |
| 2 | 流水与日志表的主键与序号 | d1:470（`point_ledger_entry` 以自增 seq 为主键）；d4:156、1521（`audit_log`、`auth_event`、`webhook_event` 用 bigint identity）；d3:2554、2609、2648-2649（状态历史、出站事件按 id 排序扫描） | 13 张表用 uuid 主键 + `seq bigint` 自增列；外键指向 uuid 主键（`point_lot.origin_entry_seq` 改 `origin_entry_id`，`point_entry_valuation` 主键改 `(entry_id, policy_version)`）；出站事件的中继按 seq 扫描。`webhook_event` 只用 uuid。13 张里 `outbox_event`、`param_value`、`assignment_history` 允许受限更新，`append_only = false`（M14）；全清单 `append_only = true` 的共 11 张（这 13 张里的 10 张，加上按月分区的 `analytics_event`）。`seq` 这个列名只留给这 13 张表上的 identity 列，子表顺序号改名（M16） | R1：“只增流水另带自增序号”。seq 是 bigint，只用于排序与回放，不进接口 |
| 3 | 金额列类型 | d1:164（integer，分）；d2:188（int）；d7:255（单行 int、聚合 bigint）；d3:240（bigint，分） | 单据金额一律 `integer`、以 `_fen` 结尾。`bigint` 的例外按 M15：`recon_day` 的全部 7 个 `*_fen` 汇总列、`media_job.est_cost_micro`、字节数列（`size_bytes`、`total_bytes` 等）；凡 `bigint` 列出接口时转字符串。已确认，主文档待回写（rulings 第四节第 3 项；01:256） | ADR-007（04:61）；单行上限约 2,147 万元，单张付款单最大 14.4 万元（d2:188；03:65）。Prisma 把 bigint 映射成 BigInt，不能直接进 JSON，这是 R1 放弃 bigint 主键的理由之一（03:601），金额列同理。`recon_day` 是跨主体合计，溢出会让对账任务整体失败 |
| 4 | 表名单复数、同一张表多个名字 | d1:568、d2:174（`approval_requests`）；d2:177、d5:95（`audit_logs`）；d5:449、94（`users`、`user_sessions`）；d7:508、1127（`feature_flags`、`export_jobs`）；d6:87（`state_transition`）；d1:352（`payment_order`）；d2:170（`billing_param_revision`）；d5:449（`ad_video_version`） | 统一为单数蛇形，名字以定义方草案与主文档为准，对照见第 2 节 | R2 |
| 5 | 审批模型 | d3:2247-2292、2296-2318（一张表、六个状态、含执行列与内容）；d4:1379-1390、1458-1475（不设通用表，每类一张申请表）；d2:174、304-311、394-397（领域表里再存一份审批状态）；d1:568-575（删掉领域表，内容放审批单 payload） | 一张 `approval_request`，状态只有待审、通过、驳回、撤回；保留通用的决定留痕（原因、清单结论、核对项、时限、轮次、去重键、发起人 ≠ 审批人的 CHECK）。执行状态与内容放一对一的领域表：`refund_request`、`cancel_request`、`point_adjustment_request`、`term_extension_request`、`finance_config_revision`、`account_change_request`、`qualification_submission`、`launch_submission`、`channel_account_submission`（M4：账号核验每轮一行，`channel_account` 只存当前值）。“同一对象只允许一张在途申请”按 M12：有执行步的类型（套餐退款、订购取消、广告取消、资质相关取消，d3:2357-2360）在提交时即建领域行，领域行带 `closed_at`，部分唯一索引建在领域表上（`WHERE closed_at IS NULL`）；审批单的去重索引只覆盖 `status = 'pending'`（d3:2287 原含 approved、executing），只供没有执行步的类型使用。审批单的 `entity_id`、`store_id` 都可空，按 `kind` 写 CHECK（M13） | R3、ADR-019（04:134-137）。d3 的六态把执行塞进审批单，d2、d4 把审批塞进领域表，都是“两处真相”；按 R3 的分工各删一半 |
| 6 | 订购与广告取消退回积分的领域单据放哪 | d2:290-298、173（`refund_request` 的 `kind = points`，与现金退款共用）；d3:2198、2221（明细 `cancel_request_line` 直接挂在审批单下，没有头表）；d3:2416、2425（留了“改指 `refund_request`”的口子） | 新增 `cancel_request`（order 模块）作头表，与审批单一对一，`cancel_request_line` 挂在它下面；`refund_request` 只留现金退款。两类单据共用 TK 单号，后台“退款管理”按审批类型聚合。已确认（rulings 第五节） | billing 在 L2，不能引用 `drama_order`、`ad`（01:180）；核算与执行本来就归订购模块（03:103；d2:173）；R3 要求领域表与审批单一对一，d3 现在是一对多 |
| 7 | 积分调整单、补偿延长单要不要建表 | d1:568（修订稿删除，内容放 payload）；d3:2361-2362、2420（仍当领域单据）；d4:1435-1436（按申请表引用） | 恢复 `point_adjustment_request`、`term_extension_request` 两张表，与审批单一对一。两类都没有执行步（通过即入账，d3:2361-2362），在途去重走审批单的去重索引（M12） | R3：领域表保存内容与执行状态。审批单收窄后不再承载 payload 内容 |
| 8 | 开票申请、对公收款确认、素材复核是否进审批单 | d3:2354-2356（注册为 `store_asset`、`invoice`、`bank_receipt` 三个 kind）；d2:174（立场：不镜像）；d5:864-869（`store_asset.review_state`，没有审批） | 不进，它们是处理队列。状态机留在 `invoice_request`、`billing_order.transfer_state` + `transfer_proof`、`store_asset`；三张领域表 `store_asset`、`transfer_proof`、`invoice_request` 各补 `due_at` 与时限参数快照列，`sla.breach` 定时器的主体类型改为这三张表，“审核时效”指标从领域表取，工作台待办走派生查询（M22）。对公大额二人复核若启用，登记为审批类型 `transfer_confirm`，`transfer_proof` 上留可空的 `review_approval_request_id`，不另设绕开统一审批单的复核通道；默认不启用（M25）。已确认（rulings 第五节、M22）；主文档没有把这三类列入审批单（01:440；03:238），需回写的是 d3 的 kind 清单（d3:2354-2356）与 T32、T33 的定时器主体（d3:2962-2963）、指标口径（d3:2596） | 这三类是处理队列，不是“一个人发起、另一个人批”；状态已经在领域表，再镜像一份就是两处真相。R3 的理由是“待审批一处聚合”，对象是审批 |
| 9 | 同意记录 | d4:219-228（`user_consent`，identity 写入）；d6:1098-1120（`agreement_consent`）；d2:221（付款单上的 `agreement_versions` jsonb）；d3:306（`agreement_consent_id`） | 只留 `agreement_consent`（docs），`user_consent` 并入；付款单的 jsonb 列删除；`merchant_user` 增加 `consent_stamp`（d6:1131）。M29：`consent_stamp` 由 identity 自己写，docs 的 `assertConsents` 只返回是否已齐与指纹（d6:1131、1167 由 docs 更新用户行的写法需改）；`identity → docs`、`tenant → docs` 进同层白名单 | R13；避免 docs 写 identity 的表 |
| 10 | 会话与下载页身份 | d4:487-499（`portal_session`，含提取码来源）；d4:478-485（两种入口）；d5:94、110（`user_sessions.client = 'portal'`）；d7:2347 | 三张会话表：`user_session`、`staff_session`、`portal_session`，都在 PostgreSQL。M1：`portal_session` 归回 identity（与 d4:140、d7:195 一致），`portal` 只留 `portal_ticket`；只认扫码票据，去掉提取码来源，`source` / `source_ref` 收敛为 `portal_ticket_id`（UNIQUE；M17 的列名） | R4、R5。三类会话都在身份侧，吊销与状态变更同事务（d4:510） |
| 11 | 操作人类型 | d1:368（merchant_user / staff / system）；d3:2563（merchant / staff / system / partner，jsonb）；d4:158、1528（含 portal）；d5:466、815、832、858（user / staff / system / partner，各列不一）；d6:1935；d7:259、419 | 四类：`merchant`、`staff`、`system`、`partner`（V1.0 只声明）。下载页请求记商家用户，另用 `client` 列记来源（weapp / portal / admin，取自 d5:834）。操作人不再用 jsonb 存 | R15 |
| 12 | 回调收件箱 | d2:402-407；d4:1844-1856 | 一张 `webhook_event`，归 security。M23：表结构骨架取 d4；微信支付这一 Provider 的载荷按 03:59 与 d2 执行——只存 APIv3 密文三元组、`key_version` 与不含 openid 的摘要，密文 180 天后清空；d4:1860“微信支付 payload = full”的写法作废。两稿各自保留的列见第 9 节 | d4:161 已声明并入；01:167 把回调验签归 security |
| 13 | 幂等表 | d3:3192-3197；d7:414-425；d2:413 | 一张 `idempotency_record`，归 kernel，定义以 d7 为准 | 01:165；d7:2353 |
| 14 | 不变量校验的落表 | d1:605（`billing_invariant_run / violation`）；d3:3237-3241（`invariant_violation`）；d7:2071-2085（`ops_invariant_run / violation`）；03:240 | 一套：`invariant_run`、`invariant_violation`，归 ops，字段以 d7 为准，表名用主文档的 | d7:2349 的合并建议。各模块只登记检查项，由 ops 调度并落库，下层不直接写 L4 的表 |
| 15 | 出站事件的重投记录 | d3:2622-2639（`outbox_delivery`）；d7:1431-1440（`event_redelivery`）；d6:85（`event_consumption`） | 只留 `outbox_delivery` | 01:305、03:235 的口径。`event_redelivery` 是针对 d3 第一稿提的增量，d3 修订稿的投递表已覆盖（d3:176、2639） |
| 16 | 成片包、下载授权、下载记录 | d3:1565-1592（`delivery_package`、`delivery_package_release`）；d5:104-105、780-821（`delivery_release`、`download_grant`，要求 d3 删表，归 media）；d5:2308（待裁定） | 只留一套：`delivery_release`（d5 的定义并入 d3 的推送原因与检查模板版本）、`download_grant`、`delivery_download_log`；`delivery_package` 不建。三张表归 delivery（L3）。M8：`delivery_release` 上的 ZIP 缓存三列（d5:794-796）拆到 media 自己的表 `zip_bundle`（按 `owner_type` + `owner_id` 关联发布批次，多态无外键），`delivery_release` 只留业务快照；media 不写 L3 的表 | 同一对象两套表。归 delivery 是因为它们都引用 `order_item`、`delivery_ticket`，放在 media（L1）会让下层引用上层；ZIP 的打包、收尾、清除都是 media 的事务（d5:1667-1683），留在 L3 的表上就得由 media 写上层 |
| 17 | 样片与成片对 `deliverable_version` 的引用 | d3:1416、1423（引用）；d5:103（修订稿已删除该表） | `sample`、`episode_output` 去掉 `deliverable_version_id`，按 `file_id` 读 `media_check`、`production_record`。M28：V1.0 每集成片只有一个版本，`episode_output.variant` 保留为可空列（默认空），不为它建额外的表 | 两稿互指，被引用的表已不存在 |
| 18 | 敏感文件读取留痕写哪 | d4:162、1588（写 D5 的 `file_access_log`）；d5:112（已删除，改写审计的访问流）；d7:2366 | 写 `audit_log` 的 access 流；`file_access_log` 不建；成片下载另有 `delivery_download_log` | 两稿互指。审计表本来就有 access 流（d4:1516-1567） |
| 19 | 原片版本、预告片指针归属 | 01:170（原片版本列在 content）；d5:179、735-770（在 media 建表并写入）；d8:162、623 | `drama_episode_master`、`drama_trailer` 归 media（文件与体检在 media；content 经端口取剧目事实，持有引用）。已确认，主文档待回写（rulings 第四节第 2 项；01:170） | 写入事务在 media 的批次提交里；同层同步调用只允许 content → media（d8:589-590），放 content 会成环 |
| 20 | 清单模板归属 | d3:1467-1477（列在“交付”）；d3:2263（审批单引用）；d3:1917-1945（下架核查引用） | `checklist_template` 归 config（L0） | 质检、链接核验、账号核验、巡检、下架核查共用；其中两类经 approval（L1）引用，留在 delivery（L3）是下层引用上层 |
| 21 | 分配池、游标、改派记录归属 | d3:634-643、3142-3147（列在“流程基础”）；d3:90（移交放 workbench）；d4:168（“归 D3”） | 三张 `assignment_*` 表归 staff（L1）。`assignment_history` 改为 `append_only = false`，要补“已联系”标记与截止时间（M14；d3:2974） | 四个池分属四个 L3 模块，放哪个都会同层互调；禁用员工事务在 staff 里要写改派记录。01:174 的 workbench 是读侧，不持有表 |
| 22 | 纯提醒由谁触发 | d3:2756、2915-2925（登记定时器）；d1:1137-1149（每日任务 + 日志表）；d4:1402（审批提醒定时器）；d6:681-685（规则派生） | `timer` 不存纯提醒；`renewal_reminder_log` 不建；d3 的 `reminder_log` 只管人工催办限频，改名 `manual_reminder_log`，并按 M2 下沉到 notify（L1）：它是发催办通知前的限频闸 | R6 |
| 23 | 周期任务的运行记录 | d7:1619、2352（删除 `job_run`，摘要写 `timer.result`）；d6:96（仍引用 `job_run`） | `timer` 增加 `result` 列，`job_run` 不建。`audit_log.job_run_id`（d4:1549）改为 `timer_id`（周期任务的定时器行），保留 `job_name`（M21） | R7；d7 是定义方 |
| 24 | 哪些状态要走 `flow.transition()` | 01:260（全部）；d3:2581（D1、D2 的状态机不并入）；d2:190、1150；d4:433-442 等；d5:1209-1223；d6:2030；d1:764-810 | 业务状态机走状态历史（`catalogue.json` 里 `state_machine = true` 的 25 张表，含 d2 的付款单、退款申请、开票申请、差异单与 d4 的账号、主体、门店、成员、邀请、员工）。两类例外：账本内部状态由计费函数维护并记入订阅事件与流水；任务、投递、文件处理这类技术状态不写状态历史。已确认，主文档待回写（rulings 第四节第 1 项；01:260）。M31：`status_transition` 只供指标与进度时间轴；活动流（商家详情的操作日志、工作台实时动态、各单据详情的日志）统一读 `audit_log`，`flow.transition()` 在同一事务里补写一条活动流的审计行（d3:914 现为有条件写入，需改） | 01:260 的目的是时效与漏斗指标。账本状态在账户锁内推进并已有专用事实表；任务、投递、文件这类状态没有指标含义 |
| 25 | 归属列不齐 | 01:255；d3:46（自称都带，实际 24 张子表不带）；d2:238（收款交易等没有 `entity_id`）；d5:570-588 等 | 接口会按 id 直接读写的子表带归属列（创建时从父行或来源复制，不可变）；只经父表访问的关联表与明细表不带；L0 的表可空、不建外键。平台级或主体未知的行，归属列为空（M13）：`approval_request` 两列都可空，`refund_request`、`refund_txn` 的 `entity_id` 在孤儿收款退款时可空。`playable_asset` 补 `entity_id`、`store_id`，预告片等平台级资产为空（M18） | 按 id 取资源要带范围校验（d3:235），每次都连父表容易漏 |
| 26 | 敏感字段 | 01:261；d4:182-184、547（三件套）；d2:191；d3:2445；d6:1107、1110（只有密文列） | 统一为 `_enc`（text）、`_bidx`、`_mask` 三列，盲索引只在需要等值查找时建 | ADR-025（04:171-174）；d4 是方案的定义方 |
| 27 | 乐观锁列名 | d3:239、d8:128（`lock_version`）；d2:190、d4:552（`version`） | `lock_version` | `version` 在别处另有含义（协议版本、估值口径版本、清单模板版本） |
| 28 | 下层的表引用上层的表 | d3:2257、2282（审批单 → 交付工单、客服工单）；d2:303（退款申请 → 客服工单）；d6:1197-1214（授权书 → 订购单、订单项、渠道账号）；d5:670-695、697-705（制作留痕、取料记录 → 订单项、广告）；d6:1660（Banner → 文件）；d1:426（冻结单 → 订单项、广告） | 审批单与退款申请上的客服工单列删除，关联只存在 `service_ticket_ref`；其余改为只存 id、不建外键（逐列见 `cross_module_fks`）；反过来由上层表持有外键的照建。审批单上保留的数据范围列按 M17 叫 `delivery_ticket_id`。follow_up（M3）、manual_reminder_log（M2）、zip_bundle（M8）下沉后，它们对上层对象的多态引用同样只存 id | 01:161、180 |
| 29 | 订购侧对账本对象的引用 | d3:184、332、1203、1242、2201（`hold_ref` 用 text 存） | 改为 uuid 外键：`order_item.hold_id`、`ad.hold_id`、`ad_revision.charge_hold_id`、`cancel_request_line.hold_id` → `point_hold` | 用 text 是因为两稿主键类型不同；统一 UUID 后是正常的 L3 → L2 外键 |
| 30 | 参数存放 | d1:270-309（`billing_param`）；d2:170、1411-1418（称 `billing_param_revision`，并把三个时限键算在它名下）；d1:309、516（把同样三个键算在 d2 的 `sys_config.billing.payment.*` 名下）；d6:1552（`sys_config.*`）；d6:1560-1570（`param_value`）；d2:386-400（`finance_config_revision`） | 三处并存、各管一类（M24）：会进入单据快照、影响计价与账务的键在 `billing_param`；付款单超时、对公转账有效期、升级报价有效期三个时限键在 `param_value`；购买入口策略与支付限额等受控配置只在 `finance_config_revision`（需审批），不映射到 `param_value`。`sys_config` 不是表。逐键归属见第 7 节。`param_value` 改为 `append_only = false`，与 `billing_param` 同类（M14） | 03:585；三类的生效与审批规则不同（公告期、即时生效、双人批准）。三个时限键在 d1、d2 里互相指给对方，由 M24 定在参数服务 |
| 31 | 月结表 | d1:1634、1636（`billing_month_close`，上线时不建）；d6:2086-2100（`report_month_closing`，依赖前者） | M10：`billing_month_close` 上线时不建，列入“不建的表”，首个月结前补，结构待月结制度确定。`report_month_closing` 改名 `report_month_close` 照建，`billing_close_ref`（d6:2099）可空，首个月结前无数据 | d1:1634 的原意；结构取决于月结制度（d1:1900） |
| 32 | 履约受阻的取值名 | d1:510（`blocked`）；d2:216、342（`exception`、`fulfillment_exception`） | 统一为 `blocked` | 03:52、R11 用“履约受阻” |
| 33 | V1.1 服务商预留列 | 01:176；d3:291、1701-1702；d1:435、463；d2:60 | 只在 `billing_order` 留“代操作人”留痕列，其余预留列不建 | 01:176 的原文 |
| 34 | 下层写上层的表（埋点、告警） | d6:126、138（埋点写入函数放 kernel）；d6:827-828、d7:1422（各模块直接调 `ops.alerts.raise()`） | 表归 analytics、ops（L4）；kernel 定义端口，上层注册实现，下层不直接写。`analytics_event`、`invariant_violation`、`alert_event` 三张表同一做法（M30） | 01:184：下层需要上层逻辑且必须同事务时用端口 |
| 35 | 主体创建时建计费账户 | d4:555；d1:317 | 同上：tenant 不直接调用 billing，由 billing 注册端口 | tenant 在 L1，billing 在 L2 |
| 36 | 发票邮件状态 | d2:384、1399（支付模块直接发）；d6:950-953 | `invoice_doc.email_state` 保留，由通知结果事件回写 | R14 |
| 37 | 样片的电脑端查看与“已查看”证据 | d3:1434-1436、1535-1536（生成链接与提取码）；d3:1540（要求有“电脑端查看记录”） | `preview_channels` 的 portal 改指下载页扫码后的预览。M27：下载页或相册保存对样片文件的访问写 `audit_log` 的访问流；`sample` 行上留 `first_viewed_at`（由访问回写）与商家在小程序勾选确认的 `viewed_ack_at`、`viewed_ack_by`。不另建表 | R5 |
| 38 | 模块清单 | d7:192（L1 没有 profile）；01:169 | 以 01 为准，profile 是独立模块。M11：profile 的五张表先保留表名，字段级定义等 `docs/appendix/design/d9-profile.md` 完成后以它为准（可能增减表）。d9-profile 已完成并并入：仍是五张表、表名不变（d9:11），见第 12 节 | 主文档优先 |
| 39 | 同层调用白名单 | d7:204（L1 只有 identity → tenant、staff → approval、portal → identity） | M29 增补七条：content → media、identity → approval、identity → docs、tenant → docs、profile → approval、profile → tenant、profile → media。完整名单见第 10 节 | 一对一领域表要建审批单；登录、加入要调同意校验；profile 写门店资质结论并引用文件 |

发现但不在表级处理的分歧（留给接口契约与字段级阶段，结论不影响表清单）：对公凭证被驳回后的付款单状态（d2:455-456 与 03:41）；7 天退款窗口的起点（d2:168 与 03:212）；升级过的周期能否退款（d1:1067 与 03:98）；履约失败是回滚整个事务还是只回滚保存点（d2:637、776-782 与 03:52）；导出文件保留期（d6:2158 与 03:591）；预告片开关的默认值（d5:1489、d7:512 写“开”，04:195 为“关”）。

## 2. 相对草案的改名与合并清单

### 2.1 改名

| 草案里的名字 | 出处 | 最终表名 | 理由 |
| --- | --- | --- | --- |
| `ticket_stage` | d3:762-774 | `delivery_ticket_stage` | 带父表前缀，避免与 `service_ticket` 混淆 |
| `ticket_hold` | d3:776-787 | `delivery_ticket_pause` | hold 在账本里指积分冻结；这里是暂停原因 |
| `plan_change_request` | d3:1081-1089 | `delivery_plan_change_request` | `plan_` 前缀在 billing 里指套餐 |
| `package_reissue` | d3:1594-1605 | `delivery_reissue` | `delivery_package` 不建 |
| `reminder_log` | d3:1827-1833 | `manual_reminder_log` | 只管人工催办；自动提醒归 notify |
| `purge_run` | d5:524-536 | `file_purge_run` | 与 `invariant_run` 区分 |
| `material_issue` | d5:697-705 | `master_checkout` | 原名容易读成“素材问题” |
| `asset_insight` | d5:887-900 | `store_asset_insight` | 素材域统一前缀 |
| `asset_usage` | d5:913-920 | `store_asset_usage` | 同上 |
| `config_revision` | d6:1611-1622 | `site_config_revision` | 与 `finance_config_revision` 区分 |
| `report_month_closing` | d6:2086-2100 | `report_month_close` | 与 `billing_month_close` 用词一致 |
| `ops_invariant_run` | d7:2071 | `invariant_run` | 与主文档的 `invariant_violation` 成对 |
| `ops_invariant_violation` | d7:2073-2085 | `invariant_violation` | 03:240 的名字 |

`publish_list`、`publish_list_episode` 保留表名，归 delivery（M17）。

### 2.2 同一张表在别的草案里的叫法

| 别的草案里的叫法 | 出处 | 指的是 |
| --- | --- | --- |
| `payment_order` | d1:229、352、365 | `billing_order` |
| `approval_requests` | d1:568；d2:174 | `approval_request` |
| `audit_logs` | d2:177；d5:95 | `audit_log` |
| `users` | d5:449 | `merchant_user` |
| `user_sessions` | d5:94 | `user_session`（下载页是 `portal_session`） |
| `billing_param_revision` | d2:170 | `billing_param` |
| `ad_video_version` | d5:449、683-684 | `ad_version` |
| 广告任务 `ad_task`、广告需求 `ad_request` | d2:295；d5:916 | `ad` |
| `state_transition`、`state_transitions` | d6:87 | `status_transition` |
| `event_consumption` | d6:85；d7:1412 | `outbox_delivery` |
| `feature_flags`、`export_jobs` | d7:508、1127 | `feature_flag`、`export_job` |
| `files` | d5:108 | `file_object` |
| `sys_config.*` | d1:309；d6:1552 | `param_value` 里的键，不是表 |
| `inbound_events` | d4:161 | `webhook_event` |
| `idempotency_key` | d7:412 | `idempotency_record` |
| worker 心跳表 | d2:1631 | `worker_lease` |
| 公告记录 | d1:216、280 | `site_notice` |
| 协议签署记录 | d3:151、406 | `agreement_consent` |

### 2.3 合并

| 被并入的表 | 出处 | 并入 | 定义来源 |
| --- | --- | --- | --- |
| `idempotency_record`（d3 的同名表） | d3:3192-3197 | `idempotency_record` | d7:414-425 |
| `webhook_event`（d2 的同名表） | d2:402-407 | `webhook_event` | 骨架 d4:1844-1856；微信支付的载荷列 d2:404-407（M23，第 9 节） |
| `event_redelivery` | d7:1431-1440 | `outbox_delivery` | d3:2622-2639 |
| `user_consent` | d4:219-228 | `agreement_consent` | d6:1098-1120 |
| `delivery_package_release` | d3:1579-1592 | `delivery_release` | d5:780-804，并入 d3 的 `kind`、`reason_code`、`note`、`precheck_version` |
| `delivery_package` | d3:1565-1577 | `delivery_release` + `download_grant` | d5:780-821 |
| `billing_invariant_run` | d1:605 | `invariant_run` | d7:2071 |
| `billing_invariant_violation`、`invariant_violation`（d3） | d1:605；d3:3237-3241 | `invariant_violation` | d7:2073-2085 |
| `file_access_log` | d4:162、1588（引用）；d5:112（已删除） | `audit_log` 的 access 流 | d4:1516-1567 |

### 2.4 归属模块相对草案的调整

| 表 | 草案的归属 | 本清单 | 见 |
| --- | --- | --- | --- |
| `account_change_request` | staff（d4:142） | identity | 第 1 节 #5 |
| `audit_log` | kernel（d4:144） | audit | 01:167 |
| `webhook_event` | billing（d2:402） | security | #12 |
| `assignment_pool_member`、`assignment_cursor`、`assignment_history` | 流程基础（d3:229） | staff | #21 |
| `checklist_template` | 交付（d3:225） | config | #20 |
| `delivery_release`、`download_grant`、`delivery_download_log` | media（d5:104-105） | delivery | #16 |
| ZIP 缓存三列 | `delivery_release` 上的列（d5:794-796） | media 的 `zip_bundle` | #16；M8 |
| `invariant_violation` | 流程基础（d3:229） | ops | #14 |
| `idempotency_record`、`biz_sequence` | 流程基础（d3:229） | kernel | #13；01:165 |
| `follow_up` | 发布（d3:1820-1825，在第 12.6 节“逾期未上线”里） | staff（L1），`tenant = entity` | M3 |
| `manual_reminder_log` | 发布（d3:1827-1833，同一节） | notify（L1） | #22；M2 |

`portal_session` 在修订前的清单里曾改归 portal；M1 归回 identity，与 d4:140 一致，不再算调整。

## 3. 新增的表（草案都没有）

| 表 | 模块 | 分组 | 为什么需要 | 依据 |
| --- | --- | --- | --- | --- |
| `store_profile` | profile | 04 | 门店档案。d4 只建了租户骨架列，把其余列交给“建档设计”，七份草案里没有这份设计；现由 d9 定义 | d4:538、557；prd-tech:37-38；proto-merchant-b:494；d9:105-146 |
| `store_profile_media` | profile | 04 | 档案媒体行（门头、环境、实拍、宣传素材）。d5 提到它有槽位与数量约束，但没有给表；现由 d9 定义 | d5:295、366；proto-merchant-b:61；d9:148-174 |
| `store_service_item` | profile | 04 | 主推服务 1–10 项；现由 d9 定义 | prd-tech:37；proto-merchant-b:495；d9:176-190 |
| `qualification_submission` | profile | 04 | 资质审核的领域表（资质轮次）。d3 的审批单只以“资质记录 ID”引用它，七份草案没有建表；现由 d9 定义 | d3:2292、2351；prd-tech:39；proto-admin-b:331；d9:192-233 |
| `qualification_doc` | profile | 04 | 证照与识别结果引用。d5 规定了它应存的列，并说它属于 d3，d3 没有建；现由 d9 定义 | d5:943；prd-tech:40；proto-admin-b:332；d9:235-283 |
| `store_asset_demand` | media | 06 | 素材需求。`store_asset.demand_id` 指向它，没有草案建表 | d5:91、860；d3:2963；prd-tech:45；proto-merchant-b:507 |
| `merchant_user_notice` | identity | 02 | 账号上的一次性提示。d4 有关闭接口，没有存放处 | d4:265、389、2256 |
| `cancel_request` | order | 09 | 取消申请的头表，与审批单一对一 | 第 1 节 #6 |
| `point_adjustment_request` | billing | 07 | 积分调整单（d1 原稿有、修订稿删除，按 R3 恢复） | 第 1 节 #7 |
| `term_extension_request` | billing | 07 | 补偿延长单（同上） | 第 1 节 #7 |
| `channel_account_submission` | publish | 11 | M4：账号核验每轮提交一行，与审批单一对一，存轮次类型（新绑定、重新提交）、当轮填报快照、截图文件、比对结果；`channel_account` 只存当前值 | rulings M4；d3:2037、2040、2046 |
| `sms_verification` | identity | 02 | M5：商家侧短信验证码（用途、目标手机号盲索引、`code_hash`、`expires_at`、`attempts`、`used_at`），结构参照 d4 的 `staff_activation`。用途：换绑手机号、资质联系人手机号验证，另留 `login` | rulings M5；d4:945-955、405、2094；proto-merchant-b:107；05:19 |
| `referral_code` | tenant | 02 | M6：渠道码与邀请码登记（码、来源类型、归属员工、状态）；注册归因由服务端按它判定 | rulings M6；d4:187-188、550；d7:678 |
| `wecom_contact` | identity | 02 | M7：商家用户与员工的企业微信外部联系人关系，由企业微信回调写入；后台“企业微信已添加”读它 | rulings M7；d4:1862；proto-admin-a:162；proto-admin-b:67 |
| `zip_bundle` | media | 06 | M8：ZIP 缓存（`zip_state`、`zip_gen`、`zip_file_id`），按 `owner_type` + `owner_id` 关联发布批次 | rulings M8；d5:794-796、1664-1685 |

profile 的五张表在七份草案里都没有，按 M11 先保留表名；`docs/appendix/design/d9-profile.md` 现已完成，五张表的字段级定义、主键、约束与加锁次序以它为准，表名与数量不变（d9:11、94-98）。并入时改了什么、它要求其他模块配合什么，见第 12 节。

## 4. 不建的表

| 表 | 出处 | 原因 |
| --- | --- | --- |
| `payment_allocation` | d1:387；d2:169、388 | d2 原稿的付款分摊表，两稿都已同意删除；分摊台账只留 `grant_schedule` 与 `point_lot` |
| `renewal_reminder_log` | d1:607、1137；d6:166、737 | 续费提醒由通知模块派生并去重（R6） |
| `approval_step` | d3:231、2243 | 审批单级，不需要步骤表（R3） |
| `work_item` | d3:3103 | 待办是派生查询，不物化 |
| `deliverable_version` | d5:103、451；d3:181 | d5 修订稿已删除；版本行归 `sample`、`episode_output` |
| `download_portal_link` | d5:110、451；d4:483、493 | 不做“链接 + 提取码”（R5） |
| `job_run` | d7:1619；d6:96 | 由 `timer` 行与 `timer.result` 取代 |
| `client_flag` | d6:170；d7:2369 | 现行文本里不存在；开关表是 `feature_flag` |
| `wx_subscribe_events` | d6:2589、2616 | d6 修订稿已删除 |
| `notify_reconcile_miss` | d6:2589、2616 | 同上 |
| `model_invocation` | d5:953、2014 | V2.0 的生成类模型调用记录；V1.0 的调用留痕在 `media_job` |
| `audit_digest` | d4:1640、2134 | 审计摘要链延后，是否需要取决于等保定级（04:169） |
| `render_job` | d5:2003（另见 952、2286） | M9：V1.1 批量贴片合成的渲染任务，V1.0 不建（03:524），移出表清单 |
| `render_item` | d5:2003（另见 679、952、2005、2286） | M9：V1.1 渲染任务的逐集条目，V1.0 不建。`production_record.render_item_id` 在 V1.0 只是不带外键的空列（d5:679） |
| `billing_month_close` | d1:607、1632-1638 | M10：上线时不建（d1:1634）。首个月结前补，结构待月结制度确定（d1:1900）。`report_month_close.billing_close_ref` 在此之前为空 |
| `sys_config` | d1:309；d6:1552 | 不是表，是 `param_value` 里的键 |
| `cycle_prices` | d2:1659 | 草案没有说明是表还是列；各周期总价是 `plan_revision` 上的内容（d1:198-227） |
| 微信支付密钥表 | d2:565-568 | 从受控配置读取，不落库 |
| `FILE_REF_TYPES` | d5:354、513 | 代码登记表，不是数据库表 |
| 服务商模块的表（服务商、归属、返佣、结算） | 01:176 | V1.1；V1.0 不建表 |
| 委托表、员工—角色关联表、服务商归属与授权记录、改价审批与归属变更审核的申请表 | d4:2145-2150 | V1.1 |
| 品牌层（加盟总部） | d4:2159 | V2.0 |
| 周指标表、客服评价等小表 | d3:3361、3364 | V1.1 |
| 专属套餐的可见主体表、计费主体映射 | d1:1854-1855 | 待定或 V2.0 |

`agreement` 在 V1.0 只播种 6 份，服务商合作协议留到 V1.1 的迁移（M9；03:570；rulings 第五节）。

已并入其他表、不再单独存在的表见 2.3 节：`event_redelivery`、`user_consent`、`delivery_package`、`delivery_package_release`、`billing_invariant_run`、`billing_invariant_violation`、`file_access_log`。

## 5. 主负责人裁决（M1–M32）落实表

“catalogue 落点”写的是 `catalogue.json` 里改动的表或约定条目；“本文落点”指本文件的节与条目。最后一列记下裁决没有覆盖、需要后续步骤或主负责人再看的地方。

| 编号 | 裁决要点 | catalogue 落点 | 本文落点 | 未尽事项 |
| --- | --- | --- | --- | --- |
| M1 | `portal_session` 归回 identity，portal 只留 `portal_ticket` | `portal_session`（module、外键、notes）；`portal_ticket`、`user_session` 的 notes；分组 02 标题 | 第 1 节 #10；2.4 | — |
| M2 | `manual_reminder_log` 下沉到 notify（L1） | `manual_reminder_log`（module、group、layer、purpose、外键、notes）；分组 13 标题 | #22；2.4 | — |
| M3 | `follow_up` 下沉到 staff（L1），`tenant = entity`，多态无外键，续费行带 `intent` | `follow_up`（module、group、layer、tenant、purpose、外键、notes）；分组 03 标题；约定“归属列” | #28；2.4 | — |
| M4 | 新增 `channel_account_submission` | 新表；`channel_account` 的 notes；分组 11 标题 | #5；第 3 节 | 截图文件列从 `channel_account` 移到新表，是按 M4 “截图文件存在提交行”的列举做的处理，字段级阶段确认 |
| M5 | 新增 `sms_verification` | 新表 | 第 3 节 | 资质联系人手机号验证的调用方是 profile，而 `profile → identity` 不在 M29 的白名单里；调用路径（由接口层先调 identity，或增补白名单）待 d9-profile 定。d9 的答复：要求增补 `profile → identity`，不增补则改为 profile 定义端口、identity 注册（d9:743）；白名单未增补，待主负责人裁决，见第 12.5 节 |
| M6 | 新增 `referral_code` | 新表；`merchant_user`、`entity` 的 notes；`enums_shared` 新增 `source_type` | 第 3 节 | `source_type` 的合并取值（organic / sales / campaign / partner）是 d4:187 与 M6 相加的结果，待确认 |
| M7 | 新增 `wecom_contact` | 新表 | 第 3 节 | — |
| M8 | ZIP 缓存三列拆到 media 的 `zip_bundle` | 新表；`delivery_release`（purpose、外键、notes）；`media_job`（外键、notes）；`file_ref` 的 notes；分组 06 标题 | #16；2.4；第 3 节 | 打包任务的主体与父对象、ZIP 的 `file_ref` 引用方随之改指 `zip_bundle`，是 M8“media 不写 L3 的表”的推论，d5:623、625、362 需回写 |
| M9 | `render_job`、`render_item` 移出；`agreement` 只播种 6 份 | 两张表移出 tables；`agreement`（purpose、notes） | 第 4 节 | — |
| M10 | `billing_month_close` 上线时不建 | 移出 tables；`report_month_close`（外键、notes）；约定“主键”的自然键清单 | #31；第 4 节 | `report_month_close` 仍建，`billing_close_ref` 在月结表补建前为空 |
| M11 | profile 的五张表先保留表名 | 按裁决修订时五张表的内容未改（只随全表加了值为 null 的 `lock_rank`）；d9-profile 完成后五张表整条按它重写，`qualification_submission`、`store_profile` 有了 `lock_rank` | #38；第 3 节；第 12 节 | d9 要求其他模块配合的改动待各草案回写，见第 12.2 节 |
| M12 | 在途申请的唯一性由领域表表达，领域行带 `closed_at` | `approval_request`、`refund_request`、`cancel_request`、`point_adjustment_request`、`term_extension_request`、`account_change_request` 的 notes；约定“状态” | #5、#7 | — |
| M13 | `approval_request` 的归属列可空并按 `kind` 写 CHECK；孤儿收款退款时 `entity_id` 可空 | `approval_request`、`refund_request`、`refund_txn`、`account_change_request` 的 notes；约定“归属列” | #5、#25 | — |
| M14 | `param_value`、`assignment_history` 改 `append_only = false`；`auth_event` 的删除口径 | 三张表的 `append_only` 与 notes；约定“只增表”“主键” | #2、#21、#30 | 两张表仍是 `pk = uuid+seq`；M16 把 seq 表述为“只增表上的列”，这里按“pk = uuid+seq 的表”理解 |
| M15 | 金额 integer；三类 bigint 例外 | `recon_day`、`media_job`、`file_object`、`episode_output`、`delivery_release` 的 notes；约定“金额与积分”“Prisma 映射规则” | #3 | — |
| M16 | `seq` 只指 identity 列；两处子表顺序号改名 | `store_asset_file`、`point_hold_alloc`（pk、notes）；约定“主键” | #2 | 草案里另有四处子表顺序号也叫 seq：`order_item`（d3:321）、`ad_revision`（d3:1237）、`transfer_proof`（d2:273）、`notification_delivery`（d6:421）。M16 没有点名，已在各表 notes 标出，新列名留字段级阶段 |
| M17 | 外键列名用被引用表全名 + `_id` | `publish_list_episode`、`service_ticket_ref`（pk）；`approval_request`、`launch_task`、`delivery_plan`、`license_letter`、`portal_session`（外键列名）；十余张表的 notes；约定“命名规则” | #10、#28；2.1 | `hold_id`、`term_id`、`release_id`、`asset_id`、`letter_id` 这类缩写是否一并展开，M17 没有点名，未改 |
| M18 | `playable_asset` 补归属列 | `playable_asset`（tenant、notes）；约定“归属列” | #25 | — |
| M19 | 多态取值与 machine 取值用最终表名 | `enums_shared` 的 `point_hold_purpose`；`status_transition`、`timer`、`follow_up`、`point_hold`、`ledger_operation`、`service_ticket_ref`、`delivery_ticket_pause`、`qc_record`、`media_job`、`file_ref`、`store_asset_usage`、`agreement_consent` 等的 notes；约定“命名规则”“状态” | 第 8 节 | 账本幂等键里 `schedule`、`term`、`hold` 三个类型段按同一规则展开为表名，M19 没有逐个点名，见第 8 节 |
| M20 | 参考素材不存数组列，统一经 `file_ref` | `drama_order`、`ad`、`file_ref`、`store_asset_usage` 的 notes 与外键；约定“命名规则” | — | `store_asset_usage` 的引用方取值加了 `drama_order` |
| M21 | `audit_log.job_run_id` 改 `timer_id` | `audit_log`、`timer` 的 notes | #23 | — |
| M22 | 三类处理队列不进审批单；领域表补 `due_at` 与时限快照 | `store_asset`、`transfer_proof`、`invoice_request`、`timer`、`approval_request` 的 notes；约定“状态” | #8 | “对公收款确认”的领域表取 `transfer_proof`（待处理对象是待审的凭证行），`billing_order.transfer_state` 不变 |
| M23 | `webhook_event` 骨架取 d4，微信支付载荷按 03 与 d2 | `webhook_event` 的 notes | #12；2.3；第 9 节 | d2 的四列是独立列还是并进 `payload`，字段级阶段定 |
| M24 | 参数键归属 | `billing_param`（purpose、notes）、`param_value`、`finance_config_revision`、`billing_order` 的 notes | #30；第 7 节 | M24 写“d1 的 13 个”留在 `billing_param`，而 d1 的 13 个键里含 `upgradeQuoteValidHours`（d1:306），它正是被移到 `param_value` 的升级报价有效期。本稿按“移走后留 12 个”处理，待主负责人确认 |
| M25 | 对公大额二人复核登记为 `transfer_confirm` | `enums_shared` 的 `approval_kind`；`transfer_proof`（外键、notes）；`approval_request`、`finance_config_revision` 的 notes | #8 | — |
| M26 | 授权书签署支持图片章与电子签 | `license_letter_revision` 的 notes | — | d6:1232 的列名是 `sign_mode`、取值三种；按 M26 写作 `sign_method`，取值在字段级阶段定 |
| M27 | 样片“已查看”证据 | `sample`、`audit_log` 的 notes | #37 | — |
| M28 | `episode_output.variant` 可空，不另建表 | `episode_output` 的 notes；`enums_shared` 的 `channel_platform` 备注 | #17 | `delivery_release.variant`、`upload_batch.variant`（d5:785、574）仍是 NOT NULL DEFAULT common，M28 没有提，未改 |
| M29 | 同层白名单增补；`consent_stamp` 由 identity 自己写 | 约定“跨模块外键”；`merchant_user`、`agreement_consent` 的 notes | #9、#39；第 10 节 | — |
| M30 | 告警走 kernel 端口 | `alert_event`、`analytics_event` 的 notes；约定“跨模块外键” | #34 | — |
| M31 | 活动流统一读 `audit_log` | `audit_log`、`status_transition`、`approval_request` 的 notes；约定“状态” | #24 | — |
| M32 | 全局加锁顺序表与 `lock_rank` | 每张表加 `lock_rank`（按裁决修订时 42 张有次序，并入 d9 后 44 张，其余为 null）；新约定“加锁顺序” | 第 6 节 | d5 的媒体段与 `drama` 的位置是本稿所加，见第 6 节的取舍 |
| 第四节 | 四处偏离改记“已确认，主文档待回写” | `status_transition`、`drama_episode_master`、`drama_trailer`、`recon_day`、`payment_txn` 的 notes；约定“状态”“金额与积分” | #3、#19、#24；第 11 节 | 主文档由主负责人回写 |
| 第五节 | 三项已确认的处理 | `cancel_request`、`refund_request`、`store_asset`、`transfer_proof`、`invoice_request`、`agreement` 的 notes | #6、#8；第 4 节 | — |

## 6. 全局加锁顺序（M32）

全系统只有一份加锁顺序表（01:304）。下表合并 01 第 7.1 节、d2（d2:1135-1153）、d3（d3:925-944）、d4（d4:165）的顺序，并入 d9（d9:749）的两张表，与 `catalogue.json` 各表的 `lock_rank` 一一对应：数值小的先锁。`lock_rank` 以 10 为步长，留出插入空位。

### 6.1 顺序表

| 次序 | 表 | 段 | 加锁方式与说明 | 出处 |
| --- | --- | --- | --- | --- |
| 10 | `assignment_cursor` | 人员 | `FOR UPDATE`，只在 `pickNext` 里 | d3:929 |
| 20 | `staff` | 人员 | 分配类 `FOR SHARE`，禁用 `FOR UPDATE`；多行按 id 升序；在事务开头锁 | d3:930；d4:165 |
| 30 | `approval_request` | 审批单 | `FOR UPDATE`；审批、执行、撤回的入口 | 01:304；d3:931；d2:1138 |
| 40 | `account_change_request` | 领域申请单 | 紧跟审批单之后；同段内按表名 | M32；d4:1458-1475 |
| 50 | `cancel_request` | 领域申请单 | 同上 | M32；d2:1139-1140；d3:2160-2163 |
| 60 | `cancel_request_line` | 领域申请单 | 与头表一起锁 | d3:2163 |
| 65 | `qualification_submission` | 领域申请单 | 资质轮次。审批处理器里紧跟审批单之后；草稿编辑与提交不经审批单，直接从轮次行进入，再锁主体（仅 `initial`）、门店 | M32；d9:466、540、749 |
| 70 | `refund_request` | 领域申请单 | 紧跟审批单之后 | M32；d2:1139 |
| 80 | `merchant_user` | 账号与租户 | 多行按 id 升序；需要账号行与主体行的事务先取账号行 | d4:165 |
| 90 | `wechat_identity` | 账号与租户 | | d4:165 |
| 100 | `entity` | 账号与租户 | 改变用量的操作开头先锁主体（d4:664） | d4:165 |
| 110 | `invitation` | 账号与租户 | | d4:165 |
| 120 | `entity_member` | 账号与租户 | | d4:165 |
| 130 | `store` | 门店 | 改交付经理、改资质结论 `FOR UPDATE`；开工读取交付经理与资质 `FOR SHARE` | 01:304；d3:932；d4:165 |
| 135 | `store_profile` | 门店 | 档案行，在门店行之后；商家保存前三步只锁这一行；它的子表行（档案媒体、主推服务）只在持有它的行锁时修改 | d9:165、749-750 |
| 140 | `drama` | 剧目 | content 的后台写操作锁剧目行 | d8:595；位置为本稿所定 |
| 150 | `ad` | 履约主干 | 多行按 id 升序；广告自身迁移 `FOR UPDATE`，别人读它的状态做求值 `FOR SHARE` | 01:304；d3:933 |
| 160 | `drama_order` | 履约主干 | 多行按 id 升序 | 01:304；d3:934 |
| 170 | `order_item` | 履约主干 | 按 id 升序 | 01:304；d3:935 |
| 180 | `delivery_ticket` | 履约主干 | 按 id 升序 | 01:304；d3:936 |
| 190 | `channel_account` | 履约子表 | 同段内按表名、再按 id | d3:937 |
| 200 | `delivery_plan` | 履约子表 | | d3:937 |
| 210 | `delivery_release` | 履约子表 | | d3:937 |
| 220 | `episode_output` | 履约子表 | | d3:937 |
| 230 | `launch_task` | 履约子表 | | d3:937 |
| 240 | `license_letter` | 履约子表 | 授权书对齐先锁订单项、再锁授权书 | d6:1260、1275-1276 |
| 250 | `patrol_task` | 履约子表 | | d3:937 |
| 260 | `sample` | 履约子表 | | d3:937 |
| 270 | `service_ticket` | 履约子表 | | d3:937 |
| 280 | `takedown_task` | 履约子表 | | d3:937 |
| 290 | `billing_order` | 资金单据 | | 01:304；d2:1141 |
| 300 | `payment_txn` | 资金单据 | | 01:304；d2:1141 |
| 310 | `transfer_proof` | 资金单据 | | d2:1141 |
| 320 | `refund_txn` | 资金单据 | | d2:1142 |
| 330 | `invoice_request` | 资金单据 | | d2:1142 |
| 340 | `payment_exception` | 资金单据 | | d2:1142 |
| 350 | `playable_asset` | 媒体聚合行 | 媒体任务收尾时先锁父对象；同段内按表名 | d5:1368、2043 |
| 360 | `production_record` | 媒体聚合行 | | d5:1368 |
| 370 | `store_asset` | 媒体聚合行 | | d5:1368、2043 |
| 380 | `upload_batch` | 媒体聚合行 | | d5:1368、2043 |
| 390 | `zip_bundle` | 媒体聚合行 | 取代 d5 里“成片包”作为打包任务的父对象（M8） | d5:1368、1668 |
| 400 | `media_job` | 媒体任务 | 父对象 → 任务行 | d5:1375、2043 |
| 410 | `file_object` | 文件 | 多行按 id 升序 | d5:340、1375、2043 |
| 420 | `billing_account` | 计费账户 | 只在账本函数内部加锁，永远最后；一个事务只锁一个主体的账户；取得之后不再去锁新的已有业务行 | 01:304；d1:1189；d2:1143；d3:938 |

不参与排序（`lock_rank = null`）的表分三种情况：

1. 被别的行锁支配。`timer` 只由已持有其主体业务行锁的事务修改（d3:939）；计费内部行（`subscription_term`、`grant_schedule`、`point_lot`、`point_hold` 等）只在持有 `billing_account` 行锁时修改（d1:1189）；没有执行步的一对一领域表（`point_adjustment_request`、`term_extension_request`、`finance_config_revision`、`launch_submission`、`channel_account_submission`）只在持有其审批单行锁的事务里修改：积分调整与补偿延长的执行器、链接核验的通过处理器都与审批单状态在同一事务（d1:568；d3:1781）。profile 的 `qualification_submission` 在按裁决修订时暂按同一用法记为 null；d9 的草稿编辑与提交不持有审批单行锁（d9:466），并入时改为有次序（65，见 6.2 第 14 项）。`qualification_doc` 以轮次为聚合根（d9:222），`store_profile_media`、`store_service_item` 只在持有 `store_profile` 行锁时修改（d9:165、749），三张仍为 null。这些表将来若要单独加锁，排进“领域申请单”段。
2. 业务事务从不锁它。`outbox_delivery` 只在消费事务开头加锁（d3:940）；扫描类的认领用 `FOR UPDATE SKIP LOCKED`（d3:3176）。
3. 只增表、配置表、派生表与单行事务的技术表（会话、票据、验证码等），不与其他已有业务行同时加锁。

通用规则，各稿一致、原样保留：同一张表的多行按 id 升序（d3:933-936；d4:165）；`FOR SHARE` 与 `FOR UPDATE` 遵守同一次序（d3:930-933）；从子行进入的入口先无锁读出祖先 id，再按次序加锁，加锁后重读并复核（d2:1149；d1:1189），加锁集合有变则抛 `LockSetChanged` 由事务封装重试（d3:944）；新插入的行不受次序限制（d1:515）；死锁与锁超时由事务包装统一有限次重试（01:304；d3:946-966）；常量放 `packages/shared/lock-order.ts`（d3:925）。

### 6.2 合并时的取舍

| # | 来源里的说法 | 处理 | 理由 |
| --- | --- | --- | --- |
| 1 | 01:304 的九类：审批单 → 门店 → 广告 → 订购单 → 订单项 → 工单 → 付款单 → 收款交易 → 计费账户 | 全部保留，相对次序不变（30 → 130 → 150 → 160 → 170 → 180 → 290 → 300 → 420），其余各稿的行插在它们之间 | M32 指定以它为主干 |
| 2 | d3:929-930 把分配游标、员工排在审批单之前 | 采用 | 01 没有提这两类；d4:165 的顺序同样以 `staff` 开头；分配、指派、转派与禁用都在事务开头锁员工行（d3:930、3131；d4:1099） |
| 3 | d4:165 的链：`staff` → `merchant_user` → `wechat_identity` → `entity` → `invitation` → `entity_member` → `store` | 内部次序原样采用；整段放在审批单与领域申请单之后、以 `store` 与 01 的“门店”重合 | d4 的链没有提审批单，01 与 d3 只规定审批单在门店之前。审批单是审批、执行、撤回事务的入口（d3:931；d2:1138），账号类变更通过即同事务生效（d4:1480）要先锁审批单再锁账号与主体；放在审批单之前，执行器就得先预读再回头锁，和其余审批类型方向相反。“需要账号行与主体行的事务先取账号行”保留 |
| 4 | d4:165：持有 `entity` 行锁的事务不再取 `billing_account` 行锁；将来若确需同时持有，顺序为 `entity` → 资金单据 → `billing_account` | 顺序按 d4 给的“将来顺序”排；“现在不同时持有”作为 identity、tenant 的现状说明保留，不再是防死锁所必需 | 两句话不矛盾，全局表只需要一个确定的次序 |
| 5 | d2:1139 把退款申请紧放在审批单之后；d1:515 写的是“付款单 → 收款交易 → 退款申请 → 退款交易 → 开票申请” | 取 d2 | M32：领域申请单紧跟审批单之后；d2 是付款与退款的定义方，退款执行的路径是“申请单 → 付款单 → 计费账户”（d2:1160） |
| 6 | `cancel_request` 的位置：d2:1139-1140 把积分类申请（当时是 `refund_request` 的 `kind = points`）放在审批单之后、D3 的领域行之前；d3:2161-2163 在锁完广告、订购单、订单项、工单、子表之后才锁 `cancel_request_line`，相当于把它当子表 | 取 d2 的位置：`cancel_request` 与明细行紧跟审批单 | M32 的明文取舍。头表按 R3 与审批单一对一，执行事务本来就从审批单进入（d3:2160），紧接着锁申请单不需要预读；d3:2161-2163 的步骤相应改为“审批单 → 申请单与明细 → 广告 → 订购单 → 订单项 → 工单 → 子表”，需回写 d3 |
| 7 | d1:515、1189 的写法里订购单、订购明细排在广告任务之前，审批单列在业务单据的末尾 | 不采用，取 01:304 与 d3:933 的“审批单最先、广告在订购单之前” | 广告是跨订单共享的行，读广告状态决定工单去向的命令都先锁广告（d3:942）；d1 这一句只是为了说明“业务单据在前、账户在后”，这一点保留 |
| 8 | d3:937 的子表一级：方案、样片、剧集、成片包、上线任务、下架任务、巡检任务、渠道账号、客服工单，“同级内按表名、再按 id” | 采用，按最终表名排（190–280）；另把 `license_letter` 放进这一级 | 草案里的“成片包”“剧集”“方案”对应 `delivery_release`、`episode_output`、`delivery_plan`。授权书的对齐函数先锁订单项、再锁授权书（d6:1260、1275-1276），与“订单项 → 子表”一致 |
| 9 | d2:1140-1142：D3 的领域行 → 付款单 → 收款交易 / 凭证 → 退款交易 → 开票申请 → 差异单 | 采用；履约子表整段排在付款单之前；`payment_txn` 与 `transfer_proof` 在 d2 里同级，这里按表名分先后 | 01 只写“工单 → 付款单”，d3 把子表紧接在工单之后，两者之间没有冲突的事务 |
| 10 | d2:1143、d3:938、d1:1189：计费账户最后，一个事务只锁一个主体，取得之后不再锁新的业务行 | 采用 | 四份来源一致 |
| 11 | d3:939-940：`timer`、`outbox_delivery` 不参与排序 | 采用，`lock_rank = null` | 见 6.1 之后的说明 |
| 12 | d8:595：剧目行不在 01:304 的顺序表里，content 的写事务不再锁其他业务行 | M32 要求 `state_machine = true` 的每张表都有次序，`drama` 定在门店之后、广告之前（140） | 剧目是跨订单共享的行，按 d3:942 给广告定位的同一个理由排在订购单之前；按 M29 的 content → media，剧目行之后只会再锁媒体段的行，方向一致。目前没有事务同时锁剧目与履约行，这个位置是本稿所定，待主负责人确认 |
| 13 | d5:1375、2043：业务单据 → 聚合行（批次、素材、可播放资产、成片包）→ `media_job` → `file_object` → 积分账户 | M32 没有点名 d5，本稿作为附加段并入（350–410），排在资金单据之后、计费账户之前 | 登记文件引用时要锁文件行（d5:340），发生在已持有业务单据行锁的事务里，文件行必须有次序；d5 自己把它排在积分账户之前。“成片包”在 d5 里是聚合行，按 M8 改由 `zip_bundle` 承担；`delivery_release` 留在履约子表一级。主负责人不需要这一段时，把这七张表的 `lock_rank` 置空即可 |
| 14 | d9:749：审批单 → 资质轮次 → 主体 → 门店 → 档案行 → 子表行；提交事务是轮次行 → 主体行（仅 `initial`）→ 门店行（d9:466） | 采用。`qualification_submission` 排进“领域申请单”段，按段内表名次序落在 `cancel_request_line` 与 `refund_request` 之间（65）；`store_profile` 紧跟 `store`（135）；子表行不排序 | M32：领域申请单紧跟审批单之后。d9 只给了相对次序，65、135 两个数值是并入时所定：轮次在主体（100）、门店（130）之前，档案行在门店之后、文件行（410，登记文件引用时加锁）之前，都与 d9 的次序一致。没有事务同时锁资质轮次与取消、退款申请，段内位置只是沿用“按表名”的规则 |

## 7. 参数键归属（M24）

三处存放各管一类：`billing_param`（逐键生效、须公告的强制提前公告）、`param_value`（config 的参数服务）、`finance_config_revision`（受控配置，需审批）。同一个键只在一处。

### 7.1 `billing_param`

d1:295-307 的键清单。M24：会进入单据快照、影响计价与账务的键留在这里。

| 键 | 默认值（d1） | 归属 | 出处 |
| --- | --- | --- | --- |
| `adUnitPoints` | 50 | `billing_param` | d1:295 |
| `adFreeRevisions` | 2 | `billing_param` | d1:296 |
| `topModelSurchargeBp` | 2000 | `billing_param` | d1:297 |
| `cancelDeductionBp` | 分阶段比例 | `billing_param` | d1:298 |
| `expiredTermRefund` | 按退回原因的去向 | `billing_param` | d1:299 |
| `minLicenseMonths` | 3 | `billing_param` | d1:300 |
| `renewalReminderDays` | [7,3,1] | `billing_param` | d1:301 |
| `prorationBaseDays` | 30 | `billing_param` | d1:302 |
| `planRefundWindowHours` | 168 | `billing_param`（d2:1418 只读它） | d1:303 |
| `enabledCycles` | [1,3,12] | `billing_param` | d1:304 |
| `maxScheduledTerms` | 1 | `billing_param` | d1:305 |
| `upgradeQuoteValidHours` | 48 | 移到 `param_value`，键名 `billing.upgrade_quote_valid_hours` | d1:306 |
| `noticeDays` | 30 | `billing_param` | d1:307 |

M24 的原文是“d1 的 13 个”留在 `billing_param`，同时把升级报价有效期放到 `param_value`。d1 的 13 个键里包含 `upgradeQuoteValidHours`，两句话字面上有一个键的出入。本稿按“同一个键只在一处”处理：它移走，`billing_param` 留 12 个键。待主负责人确认。

### 7.2 `param_value` 里的三个时限键

| 键（M24 定的名字） | 含义 | 默认值 | 草案里的写法 |
| --- | --- | --- | --- |
| `billing.payment.order_timeout_minutes` | 付款单超时 | 草案为 30 分钟（d2:1415） | `paymentTimeoutMinutes`（d2:170、1415；d1:516 称已从 d1 删除）；d6:1552 例举的 `payment.wechat.expire_minutes` |
| `billing.payment.transfer_valid_days` | 对公转账有效期 | 草案为 7 天（d2:1416） | `bankTransferValidDays`（d2:170、1416；d1:516） |
| `billing.upgrade_quote_valid_hours` | 升级报价有效期 | 48（M24） | `upgradeQuoteValidHours`（d1:306，48 小时）与 `upgradeQuoteValidDays`（d2:1417，3 天）；只留小时这一个，后者删除 |

这三个键在两份草案里互相指给对方：d2:170、1411-1418 说它们在 D1 的计费参数里，d1:309、516 说它们属于 d2 的 `sys_config.billing.payment.*`。M24 定在参数服务。

### 7.3 `param_value` 里的其他键

| 键或分组 | 归属 | 出处 |
| --- | --- | --- |
| `payment.bank_transfer.min_fen`、`payment.wechat.advise_transfer_above_fen`、`payment.description_template.{type}` | `param_value` | d2:1424-1426 |
| `refund.original_route_safety_hours`、`refund.bill_wait_days` | `param_value` | d2:1427-1428 |
| `invoice.item_name.{…}`、`invoice.express_companies`、`invoice.apply_within_days`、`invoice.no_rules` | `param_value` | d2:1429-1432 |
| `recon.first_run_time`、`recon.alarm_time` | `param_value` | d2:1433 |
| `sla.*`、`work.*`（calendar）、`remind.*`、`notify.*`、general、`export.*`、`analytics.*`、`platform.*` 各分组 | `param_value` | d6:1547-1554 |
| `refund.plan_window_hours` | 不存在于 `param_value`：退款窗口是 `billing_param` 的 `planRefundWindowHours` | d6:1552 例举；d1:516 称 d2 已删除 |

### 7.4 `finance_config_revision`

M24：购买入口策略与支付限额等受控配置只在这里（需审批），不映射到 `param_value`。d6:170、1552 把 `billing.purchase_policy` 的存储落点写成参数服务，这一写法作废。

| 键 | 内容 | 出处 |
| --- | --- | --- |
| `bank_account` | 对公收款户名、开户行、账号 | d2:1439 |
| `purchase_policy` | 购买入口策略规则表 | d2:1440 |
| `controls.admin_create_order` | 后台代建付款单的开关 | d2:1441 |
| `controls.wechat_single_limit_fen`、`controls.wechat_daily_limit_fen` | 微信渠道单笔与当日限额 | d2:1442 |
| `controls.receipt_second_review_fen` | 对公确认二人复核阈值；默认不开启，启用后走审批类型 `transfer_confirm`（M25） | d2:1443 |
| `controls.shipping_report` | 订单发货信息上报 | d2:1444 |

## 8. 多态取值与状态机取值改名清单（M19）

规则：多态引用的 `*_type` 取值与 `status_transition.machine` 的取值一律用最终表名；账本幂等键里的类型段同样用最终表名。尚无存量数据，不保留旧值。下表只列相对草案改掉的取值，草案里已经是最终表名的不列。

### 8.1 `*_type` 列与 `machine`

| 列 | 草案里的取值 | 改为 | 出处 |
| --- | --- | --- | --- |
| `status_transition.machine` | `order` | `drama_order` | d3:2555 |
| | `ticket` | `delivery_ticket` | d3:2555 |
| | `plan` | `delivery_plan` | d3:2555 |
| | `approval` | `approval_request` | d3:2556 |
| `timer.subject_type` | `order` | `drama_order` | d3:2764 |
| | `ticket_stage` | `delivery_ticket_stage` | d3:2764 |
| | `approval` | `approval_request` | d3:2764 |
| `follow_up.subject_type` | `subscription` | `subscription_term` | d3:1822 |
| | `package_reissue` | `delivery_reissue` | d3:1822 |
| `delivery_ticket_pause.ref_type` | `approval` | `approval_request` | d3:780 |
| | `plan_version` | `delivery_plan_version` | d3:780 |
| `qc_record.target_type` | `episode` | `episode_output` | d3:1482 |
| | `package` | `delivery_release` | d3:1482 |
| `service_ticket_ref.ref_type` | `order` | `drama_order` | d3:2481 |
| | `payment_order` | `billing_order` | d3:2481 |
| | `approval` | `approval_request` | d3:2481 |
| `point_hold.purpose`、`point_hold.ref_type` | `drama_order_item` | `order_item` | d1:425-426 |
| | `ad_task` | `ad` | d1:425-426 |
| `ledger_operation.ref_type` | `approval` | `approval_request` | d1:575 |
| `store_asset_usage.used_by_type` | `ad_request` | `ad` | d5:916 |
| `media_job.subject_type` | `file` | `file_object` | d5:623 |
| | `release` | `zip_bundle`（M8 之后打包任务的主体） | d5:623 |
| | `ocr` | `ocr_result` | d5:623 |
| `media_job.parent_type` | `playable` | `playable_asset` | d5:625 |
| | `production` | `production_record` | d5:625 |
| | `release` | `zip_bundle` | d5:625 |
| `file_ref.ref_type` | `release`（清单角色） | `delivery_release` | d5:361 |
| | `release`（角色 `zip`） | `zip_bundle` | d5:362 |
| | `playable` | `playable_asset` | d5:364 |
| | `drama_master` | `drama_episode_master` | d5:365 |

`status_transition.machine` 的完整取值是 `catalogue.json` 里 `state_machine = true` 的 25 张表的表名。`agreement_consent.biz_type`（d6:1113 只写了“付款单号、订购单号、广告需求号”）定为 `billing_order`、`drama_order`、`ad`。草案里没有列出取值的多态列（`audit_log.target_type`、`outbox_event.aggregate_type`、`assignment_history.subject_type`、`invariant_violation.subject_type`、`notification.biz_type`、`manual_reminder_log.subject_type`、`zip_bundle.owner_type`）在字段级阶段按同一规则定。

### 8.2 账本幂等键（`ledger_operation.op_key`）

| 操作 | 草案里的写法 | 改为 | 出处 |
| --- | --- | --- | --- |
| 履约 | `fulfill:payment_order:{id}` | `fulfill:billing_order:{id}` | d1:1489 |
| 月度发放 | `grant:schedule:{id}` | `grant:grant_schedule:{id}` | d1:1490 |
| 加购入账 | `purchase:payment_order:{id}` | `purchase:billing_order:{id}` | d1:1492 |
| 期末清零 | `expire:term:{id}:{end_date}` | `expire:subscription_term:{id}:{end_date}` | d1:1493 |
| 加购停用 / 恢复 | `suspend:term:{…}` / `resume:term:{…}` | `suspend:subscription_term:{…}` / `resume:subscription_term:{…}` | d1:1495 |
| 冻结 | `hold:{ref_type}:{ref_id}`，`ref_type` 为 `drama_order_item` / `ad_task` / `ad_revision` | `hold:order_item:{id}` / `hold:ad:{id}` / `hold:ad_revision:{id}` | d1:1496 |
| 扣减 | `capture:hold:{hold_id}` | `capture:point_hold:{id}` | d1:1497 |
| 释放 | `release:hold:{hold_id}` | `release:point_hold:{id}` | d1:1498 |
| 套餐退款作废 | `revoke:term:{id}` | `revoke:subscription_term:{id}` | d1:1503 |

不改的键：`grant:upgrade:{付款单 id}:{月序}`（d1:1491，`upgrade` 不是表名）、`unexpire:{审批单号}`、`refund:{退回申请明细 id}`、`adjust:{审批单号}`、`extend:{审批单号}`、`refund_suspend` / `refund_resume:{退款申请号}`、`fix:{工单号}:{序号}`（d1:1494、1499-1502、1504），它们没有类型段。`payment_order`、`drama_order_item`、`ad_task` 的改名与 M19 举的例子同类；`schedule`、`term`、`hold` 展开为 `grant_schedule`、`subscription_term`、`point_hold` 是按同一规则推出的，M19 没有逐个点名。

## 9. `webhook_event` 两稿列的取舍（M23）

表结构骨架取 d4（d4:1848-1856）；微信支付这一 Provider 的载荷按 03:59 与 d2（d2:404-407）执行。

| 列 | 取自 | 处理 |
| --- | --- | --- |
| `id` | d4:1848（bigint identity） | 保留，按 R1 改 uuid |
| `provider`、`event_id`，`UNIQUE (provider, event_id)` | d4:1849；d2:404 | 保留，两稿相同 |
| `event_type` | d4:1850；d2:404 | 保留 |
| `mode`（inline / inbox） | d4:1850 | 保留；d2 没有 |
| `received_at` | d4:1851；d2:404 | 保留 |
| `payload` | d4:1852 | 保留，按 Provider 的策略存。微信支付不往这一列存解密后的资源：d4:1860 的 `full` 作废 |
| `payload_digest` | d4:1853 | 保留；d2 没有 |
| `process_state` | d4:1854（含 `dead`）；d2:404（没有 `dead`） | 取 d4 的五个取值 |
| `attempts`、`processed_at`、`error` | d4:1855；d2:404 | 保留，两稿相同 |
| `next_attempt_at` | d4:1855 | 保留；d2 没有 |
| `payload_purge_at` | d4:1856 | 保留；微信支付的密文按它在 180 天后清空 |
| `serial` | d2:404 | 保留，只有微信支付填 |
| `summary`（不含 openid 的摘要） | d2:404 | 保留，只有微信支付填；保留不少于 3 年（d2:407） |
| `resource_cipher`（APIv3 密文三元组） | d2:404 | 保留，只有微信支付填；180 天后清空（d2:407）。不保存解密后的明文（d2:406） |
| `key_version` | d2:404 | 保留，只有微信支付填 |

d2 的四列是独立列还是并进 `payload`，在字段级阶段定；保留的信息项以上表为准。

## 10. 同层调用白名单（M29）

同层之间的外键允许；同层的同步调用只能走白名单，白名单写在 `infra/ci/layers.json`（d7:204）。

| 层 | 调用方向 | 来源 |
| --- | --- | --- |
| L3 | order → ad、order → delivery、delivery → ad、delivery → publish | d7:204 |
| L1 | identity → tenant、staff → approval、portal → identity | d7:204 |
| L1 | content → media | M29；d8:589 |
| L1 | identity → approval | M29；账号类变更的领域表要建审批单 |
| L1 | identity → docs、tenant → docs | M29；登录与加入调用同意校验 |
| L1 | profile → approval、profile → tenant、profile → media | M29；资质审核建审批单、写门店资质结论、引用文件 |

配套约束（M29、M30、M8）：

- `merchant_user.consent_stamp` 由 identity 自己写，docs 的 `assertConsents` 只返回是否已齐与指纹，避免 docs 写 identity 的表。
- media → content 不做同步调用，剧目事实经端口取（d8:590）。
- 下层要写上层的表时用端口：kernel 定义端口、上层注册实现。`analytics_event`、`invariant_violation`、`alert_event` 都是这种做法。
- media 不写 L3 的表：ZIP 缓存拆到 `zip_bundle`。

d9 要求增补 `profile → identity`（读登录手机号的三列、核销短信验证码；d9:743、806、807），并给了不增补时的做法（profile 定义端口、identity 注册）。M29 的名单里没有这一条，上表未加，待主负责人裁决（第 12.5 节）。

本稿里只是外键、不产生同步调用的同层引用不进白名单，例如 `wecom_contact.staff_id`、`referral_code.owner_staff_id`、`store.delivery_manager_id` 指向 `staff`，`portal_session.portal_ticket_id` 指向 `portal_ticket`。

## 11. 对主文档的偏离（已确认，主文档待回写）

下面四处与主文档字面不一致，已获主负责人确认（rulings 第四节）。主文档由主负责人回写，本稿与 `catalogue.json` 按确认后的结论执行。

| # | 主文档的写法 | 确认后的结论 | 待回写位置 | 本稿落点 |
| --- | --- | --- | --- | --- |
| 1 | “状态迁移只经 `flow.transition()`，每次迁移写状态历史” | 收窄为业务状态机（25 张表）；账本内部状态由计费函数维护并记入订阅事件与流水；任务、投递、文件处理这类技术状态不写状态历史 | 01:260 | 第 1 节 #24；约定“状态” |
| 2 | 原片版本列在 content | `drama_episode_master`、`drama_trailer` 归 media（文件与体检在 media；content 经端口取剧目事实，持有引用） | 01:170 | #19 |
| 3 | “金额存整数分” | 单据金额一律 `integer`；`bigint` 的例外见 M15（`recon_day` 的 7 个汇总列、`est_cost_micro`、字节数） | 01:256 | #3；约定“金额与积分” |
| 4 | 银行流水号、付款行写在 `transfer_proof` 上 | 放在 `payment_txn`（实际到账的那笔交易），不放 `transfer_proof`（商家上传的凭证） | 03:26 | `payment_txn`、`transfer_proof` 的 notes |

另有三项处理在 rulings 第五节确认，不涉及主文档的字面：取消退回积分的头表 `cancel_request` 归 order、`refund_request` 只管现金退款（#6）；开票申请、对公收款确认、素材复核不进审批单（#8）；服务商合作协议不在 V1.0 播种（第 4 节）。

## 12. d9-profile 带来的改动

`docs/appendix/design/d9-profile.md`（草案 v1，2026-10-03）补了 01:169、192 列出的 `profile` 模块（d9:3）。按 M11，04-profile 分组以它为准。本节的引用写“d9:行号”。catalogue 的改动由 `apply_d9.py` 在 `apply_rulings.py` 的结果之上施加：五张 profile 表整条重写，其他表只在 notes 末尾追加以“d9：”开头的一段，不改它们已有的内容。

### 12.1 04-profile 的五张表

d9 仍是五张表，表名与此前暂定的一致，不增不减（d9:11、94-98）。都是门店维度（带 `entity_id`、`store_id`，复合外键 → `store(id, entity_id)`），都不是只增表，都不走状态历史。

| 表 | 主键 | `lock_rank` | 相对暂定条目的改动 | 出处 |
| --- | --- | --- | --- | --- |
| `store_profile` | `composite(store_id)`，主键即外键 | 135 | 职责由“前三步”改为“前三步与联系人”：联系人姓名与手机号存本表、不进审核。去掉“各步草稿与完成状态”：前三步原地保存、没有另一份草稿副本，每步状态与完整度现算，库里只放完整度缓存。门店名称与资质结论不在本表（在 `store` 上）。外键补 `logo_file_id`、`copied_from_store_id`。参与加锁排序 | d9:13、84、86、105-146、355、807 ① |
| `store_profile_media` | `uuid` | null | 分组定为 `media_group` 四个取值，组内顺序列 `position`，图注 `caption`，另有 `media_kind`；移除只写 `removed_at`；部分唯一索引 `(store_id, media_group, file_id) WHERE removed_at IS NULL`。外键补 `created_by_user_id` | d9:148-174 |
| `store_service_item` | `uuid` | null | 排序列 `position`；移除只写 `removed_at`；`price_fen > 0`、原价不低于现价两条 CHECK | d9:176-190、330 |
| `qualification_submission` | `uuid` | 65 | 由“每次提交一行”改为“一轮一行、含草稿态”：`approval_request_id` 可空，提交时才建审批单。表上没有状态列，用 `submitted_at`、`closed_at`、`outcome` 表达。在途唯一用 `WHERE closed_at IS NULL` 的部分唯一索引（M12）。承载重审字段的待审值 `proposed_*`。驳回项不记在本表，记在证照行的 `verdict`。参与加锁排序 | d9:14、80-81、192-233、523、807 ③ |
| `qualification_doc` | `uuid` | null | `store_id` 由可空改为不可空，新增 `scope`（`entity` / `store`）区分属主体还是属门店。挂在轮次下（N:1），每轮全量：新上传的记 `uploaded`，带入的记 `carried` 并另起一行。生效与被取代用 `effective_from`、`superseded_at` 与两个部分唯一索引表达 | d9:15、83、235-283、807 ② |

同模块内的外键（不列入 `cross_module_fks`）：`store_profile.effective_qualification_submission_id`、`qualification_submission.resubmit_of_qualification_submission_id`（自引用）、`qualification_doc.qualification_submission_id`、`qualification_doc.carried_from_qualification_doc_id`（自引用）（d9:138、201、241、248）。

共享枚举：`qualification_status` 的备注补了 d9 的出处；新增 `entity_type`（`enterprise` / `individual`），因为 `qualification_submission.claimed_entity_type` 的取值同 `entity.entity_type`（d9:203；d4:546）。

### 12.2 d9 要求其他模块配合的改动

“落点”一列里的表名指 `catalogue.json` 里已追加说明的表。表的归属不变，列由各自的定义方草案回写；本清单只登记，不代改草案。

| 对方的表（模块） | d9 的要求 | 出处 | 落点与状态 |
| --- | --- | --- | --- |
| `store`（tenant） | 增加 `qualification_status text NOT NULL DEFAULT 'unsubmitted'`，四值 CHECK；`name` 允许为空。提供 `createStore`、`renameStore`、`setStoreQualification`、`getStoreGateFacts`。`StoreCloseGuard` 的“审核中的资质”由 profile 注册，另加“主体未认证时的首家门店”一项，删除草稿门店也经同一守卫。门店停用、恢复、草稿门店删除的出站事件名定稿 | d9:289-290、736、745、801 | `store` 的 notes；待 D4 回写 |
| `entity`（tenant） | 增加 `legal_rep_name_mask`、`verified_at`。`verification_status` 的列说明由“主体营业执照的审核结论”改为“含主体营业执照的那一轮（`initial`）的结论”。提供 `applyEntityVerification`、`findVerifiedEntityByUsccBidx`。主体关闭或放弃的出站事件名定稿 | d9:291-295、436、745、801 | `entity` 的 notes；语义调整待 D4、D2 确认（d9:793） |
| `approval_request`（approval） | 不新增审批类型：三种轮次共用 `kind = qualification`，轮次类型在 `qualification_submission.kind`。`kind = qualification` 时 `entity_id`、`store_id` 必填。`approval.reject` 的请求体增加 `rejectedDocIds`、透传给处理器，本表不加列。`dedupe_key` 照填，作在途唯一的第二道 | d9:18、200、226、333、488、523、803 ② | `approval_request` 的 notes；请求体待 D3 回写 |
| `file_ref`（media） | `FILE_REF_TYPES` 登记四个引用类型与角色，见 12.4。证照的引用在挂到草稿行时建立，不等提交。复制档案时归属断言用同一主体 | d9:299-310、804 ② | `file_ref` 的 notes；待 D5 回写 |
| `file_object`（media） | `profile_*` 分类允许同主体跨门店引用（复制档案） | d9:309、804 ③ | `file_object` 的 notes；待 D5 确认 |
| `ocr_result`（media） | 表的列不变。`ocr.runFieldChecks` 的输入结构确认；比对规则三处改动：C1 的基准可以不传、C8 的基准由调用方指定、新增许可证编号格式与许可证经营场所两项 | d9:490-497、804 ④ | `ocr_result` 的 notes；待 D5 确认（d9:795） |
| `store_asset`（media） | 提供把品牌故事素材复制到新门店的函数；素材上传鉴权经 `StoreGatePort` 取闸门 | d9:393、738、804 ⑦⑧ | `store_asset` 的 notes；待 D5 回写 |
| `sms_verification`、`merchant_user`（identity） | 提供登录手机号的三列读取与短信验证码核销（用途“资质联系人手机号验证”）。调用路径见 12.5 第 1 项 | d9:132、743、801 ⑥ | 两张表的 notes；白名单待裁决 |
| `status_transition`（flow） | `machine` 取 `store`、`entity` 时，同一张表有两个状态字段，确认是否加一列区分 | d9:462、803 ① | `status_transition` 的 notes；待 D3 确认 |
| `outbox_event`（events） | 新增八个事件类型，见 12.3 | d9:697-704 | `outbox_event` 的 notes |
| `audit_log`（audit） | 表的列不变。activity、ops、access 三条流各记什么 | d9:316-322 | `audit_log` 的 notes |
| `timer`（timers） | 表的列不变。profile 不登记会改状态的定时器；`profile.invariants` 是周期任务行 | d9:721-728 | `timer` 的 notes |
| `dict_type`（config） | 增加两个字典类型：门店核心卖点标签（暂名 `store_selling_point`）、行业许可证类型（暂名 `permit_type`，带识别字段清单与编号格式规则）；`reject_reason` 的 `store_review` 场景播种“其他” | d9:805 ①⑥⑦ | `dict_type` 的 notes；待 D6 回写 |
| `param_value`（config） | 增加证照到期提醒的参数（暂名 `remind.cert_expiry.days`，默认 30） | d9:805 ② | `param_value` 的 notes；待 D6 回写 |
| `notify_scene`（notify） | `m.review_result` 接上 `store.qualification_change.*`；代改通知接 `store.profile.changed`；增加证照到期提醒的规则与场景；文案变量经 profile 注册的只读解析函数取 | d9:703-706、725、737、805 ②③ | `notify_scene` 的 notes；待 D6 回写 |
| `analytics_event`（analytics） | 埋点 `profile_submit` 改由 `store.qualification.submitted` 派生、只计 `kind = initial`；`store_add_submit` 只在 `kind = new_store` 且 `round_no = 1` 时直记 | d9:488、805 ⑤ | `analytics_event` 的 notes；待 D6 回写 |
| `agreement_consent`（docs） | 现不改。信息确认是否算同意记录待法务；若算，`qualification_submission` 的两列改成同意记录的 id | d9:794、821 | `agreement_consent` 的 notes；待法务 |
| `license_letter`（docs） | 主体名称或门店名称变更后授权书是否换版 | d9:612、805 ④ | `license_letter` 的 notes；待 D6、法务 |
| `drama_order`（order） | 闸门与建档齐全改调 `profile.storeGate`、`profile.assertProfileComplete`；实现 `QualificationImpactPort`；确认变更重审的事件不触发待开工超期待办与整店取消；两条补偿扫描改从 `profile.getStoreFacts` 取数 | d9:604、735、803 ③④⑤⑧ | `drama_order` 的 notes；待 D3 回写 |
| `refund_request`（billing） | `merchant.isQualificationDead` 改名 `profile.isQualificationDead`，确认判定口径 | d9:651、802 | `refund_request` 的 notes；待 D2 确认 |
| `invariant_violation`（ops） | 表的列不变。profile 登记 I1–I10 十条每日不变量 | d9:755-766 | `invariant_violation` 的 notes |
| `staff_role`（staff；权限点在代码注册表） | 登记权限点 `merchant.qualification.view`；放行用 `merchant.qualification.override` | d9:801 ⑤ | `staff_role` 的 notes；待 D4 回写 |
| `channel_account`（publish） | 现不改。主体名称变更后已核验账号是否重新核验，待定 | d9:613、819 | `channel_account` 的 notes；待业务、法务 |

d9 第 10 节里不涉及表的配合项没有逐条搬进清单：店员视图的黄金文件与禁用键白名单（d9:801 ⑦，只在 `store_service_item` 的 notes 提到）、接口路径的归属（d9:804 ⑤⑥）、后台与商家端页面要补的控件（d9:806 ②–⑤）。

### 12.3 事件：发出与订阅

profile 发出的事件（d9:697-704）。负载只带 id 与字段名，订阅者回库读取（d9:706）。

| 事件 | 时机 | 已知订阅者 |
| --- | --- | --- |
| `store.qualification.submitted` | `initial`、`new_store` 轮次提交 | notify：站内“新增门店已提交审核”；analytics：`profile_submit`（待 D6 改） |
| `store.qualification.approved` | 首次审核或补正审核通过 | order：为待开工订购单登记 `order.start`；notify：`m.review_result`；profile 自己：驳回信用代码相同的其他在审轮次 |
| `store.qualification.rejected` | 驳回，带 `final` | order：`final = true` 时生成 `qualification_cancel`；notify |
| `store.qualification.withdrawn` | 主体关闭或放弃时系统撤回 | — |
| `store.qualification_change.submitted` / `.approved` / `.rejected` | 已通过门店的变更重审 | notify（待 D6 接到 `m.review_result`） |
| `store.profile.changed` | 档案生效值变化；`source` 为 `merchant`、`staff_proxy`、`review_writeback` | notify（代改通知）；首页与推荐缓存；D3、D6 是否处理待定 |

变更重审用独立的事件名，是因为 order 订阅 `store.qualification.rejected` 后会做待开工超期待办与整店取消，这些只应针对从未通过的门店（d9:604）。

profile 订阅的事件（d9:710-717）：

| 事件 | 来源 | 处理 |
| --- | --- | --- |
| `store.qualification.approved`（`kind = initial`，或本轮含营业执照） | profile | 把信用代码相同、属于其他主体的在审轮次逐个由系统驳回 |
| 门店停用 | tenant（事件名待 D4 定） | 丢弃未提交的草稿轮次；释放该门店三类档案引用，保留 180 天 |
| 门店恢复 | tenant | 对未移除的档案行重新登记文件引用 |
| 草稿门店删除 | tenant | 丢弃草稿轮次；释放档案文件引用与草稿证照行的引用 |
| 主体关闭或放弃 | tenant | 撤回在审轮次、丢弃草稿；主体关闭时释放该主体全部证照引用，保留 3 年 |
| `file.moderated` | media | 档案媒体被拦截时重算完整度 |

端口（不是事件，d9:732-741）：profile 实现 approval 的 kind 处理器、tenant 的 `StoreCloseGuard`、notify 的只读解析函数与 `listDocsExpiringOn`、media 的 `StoreGatePort` 与 `authorizeUpload`、config 的字典引用计数；profile 定义、order 实现 `QualificationImpactPort`。

### 12.4 `file_ref` 的引用类型与角色

`ref_type` 用最终表名（M19）。四处都须登记到 `FILE_REF_TYPES`（d9:299-306）。

| `ref_type` | 角色 | 建立 | 释放 → 保留 |
| --- | --- | --- | --- |
| `store_profile` | `logo` | 保存基础信息 | Logo 被替换 → 30 天；门店注销 → 180 天 |
| `store_profile_media` | `main` | 保存门店形象 | 行被移除 → 30 天；门店注销 → 180 天 |
| `store_service_item` | `image` | 保存服务与价格 | 同上 |
| `qualification_doc` | `main` | 证照挂到草稿行时 | 草稿行被替换、草稿被丢弃 → 7 天；已提交过的行不释放，直到主体终止合作后 3 年 |

M20 的“参考素材来自档案媒体的只走 `file_ref`”d9 照用：档案媒体行被移除后，只要订购单或广告的引用还在，文件不会被清除（d9:310）。

### 12.5 与 rulings、约定的关系

| # | 事项 | d9 的写法 | 处理 |
| --- | --- | --- | --- |
| 1 | 同层调用 `profile → identity` | 读登录手机号的三列、核销短信验证码要这一条；要求白名单增补；若不增补，改为 profile 定义端口、identity 注册（d9:743、806 ①、807 ④） | **与 M29 不一致，按 rulings 处理**：M29 的名单只有 `profile → approval`、`profile → tenant`、`profile → media`（rulings.md:47），第 10 节的白名单与 catalogue 的“跨模块外键”约定都没有加这一条。d9 自己给了端口这条退路，表结构不受影响。待主负责人裁决：增补白名单，或确认走端口 |
| 2 | M12 在途唯一 | 资质审核没有执行步，d9 仍把在途唯一建在领域表上（`closed_at`），并照填审批单的 `dedupe_key` 作第二道（d9:226） | 采用。M12 把审批单的去重索引留给没有执行步的类型；资质轮次在提交前就以草稿行存在，唯一性只能在领域表上表达，两道并存不冲突 |
| 3 | M13 审批单归属列 | `kind = qualification` 时 `entity_id`、`store_id` 必填（d9:333） | 一致，写进 `approval_request` 的 notes |
| 4 | M16、M17、M19 命名 | 顺序号叫 `position`；外键列用被引用表全名（`qualification_submission_id`、`carried_from_qualification_doc_id` 等）；文件列沿用 `file_id`、`<角色>_file_id`；`file_ref.ref_type` 与 `machine` 用最终表名（d9:7、155、299、462） | 一致 |
| 5 | M32 加锁顺序 | 审批单 → 资质轮次 → 主体 → 门店 → 档案行 → 子表行（d9:749） | 写进第 6 节：`qualification_submission` = 65，`store_profile` = 135；数值是并入时所定 |
| 6 | 约定“操作人列”的三列（R15） | `store_profile` 只有 `last_edit_actor_type`、`last_edit_actor_id` 两列，没有 `client`（d9:141） | 不影响表级结论；字段级阶段对齐，已写进 `store_profile` 的 notes |
| 7 | d9 对清单提的五项（d9:807） | ① `store_profile` 的职责；② `qualification_doc.store_id` 不可空、新增 `scope`；③ `qualification_submission` 的在途部分唯一索引；④ 同层白名单补 `profile → identity`；⑤ `entity` 条目补 `verified_at` | ①②③⑤ 已落；④ 未落，见本表第 1 项 |
| 8 | d9 要求 D5 把 `ocr_result`、`file_object`、`file_ref` 的主键改 `uuid`（d9:804 ①） | — | 清单按 R1 已是 `uuid`，不需要再改 |

并入时另发现一处 d9 没有写的加锁路径：已通过门店保存基础信息并确认重审时，同一请求既写 `store_profile` 又写 `change` 草稿轮次（d9:599），而 d9 第 8 节只写了“商家保存前三步只锁 `store_profile` 行”（d9:750）。按第 6 节的次序应先锁轮次行、再锁档案行。这是本清单的提示，不是 d9 的原文，已写进 `store_profile` 的 notes，留给 d9 的作者或接口契约阶段补。

### 12.6 d9 留下的、会影响表结构的未决事项

| 事项 | 现在的默认 | 若结论相反，哪张表要改 | 出处 |
| --- | --- | --- | --- |
| 主体结论列的语义（按 `initial` 轮次的结论维护） | 采用 d9 的写法 | `entity.verification_status` 的维护规则；billing 的套餐退款口径 | d9:295、793 |
| 信息确认是否算同意记录 | 记在轮次行上 | `qualification_submission` 删 `declaration_confirmed_at`、`declaration_version`，改存同意记录的 id | d9:794、821 |
| 变更重审期间门店结论是否回到“审核中” | 不变 | `store.qualification_status` 的迁移表；闸门会挡住在途订单 | d9:772、813 |
| 功能区由谁、按什么规则归入 | 另存 `zone_code`，规则待定 | `store_profile.zone_code` 的写入方 | d9:118、788 |
| 主体未认证时首家门店不能停用或删除 | 由 profile 在停用守卫里计 1 | `store` 的生命周期守卫 | d9:781 |
| 状态历史是否加一列区分同表的两个状态字段 | 用事件名前缀区分 | `status_transition` | d9:462 |
| 卖点标签、许可证类型两个字典 | 暂名 `store_selling_point`、`permit_type` | `store_profile.selling_point_codes`、`qualification_doc.permit_type` 引用的字典类型 | d9:805 ① |
| 图注是否开放填写 | 留列不开放 | `store_profile_media.caption` | d9:158、779 |

d9 文末注明：它的修订没有运行任何程序验证，依据全部来自文件比对（d9:865）。本次并入同样只依据文件；跑过的只有 `selfcheck.py`。

### 12.7 并入时改动的文件

- `catalogue.json`：经 `apply_d9.py` 修改——04-profile 的五张表整条重写；24 张其他模块的表在 notes 末尾追加一段（`store`、`entity` 另加一条 d9 的出处）；约定“加锁顺序”“跨模块外键”各在一条已有条目末尾补一句；`enums_shared` 补 `qualification_status` 的备注、新增 `entity_type`。表数仍是 166，`state_machine = true` 仍是 25 张，有加锁次序的表由 42 张变为 44 张。重跑 `apply_rulings.py` 会从修订前的快照重算，之后要再跑一次 `apply_d9.py`（已按“快照 → `apply_rulings.py` → `apply_d9.py`”回放过一次，结果与现文件逐字节相同）。
- 本文件：头部说明、第 1 节 #38、第 3 节的五行与段末说明、第 5 节的 M5、M11、M32 三行、第 6 节（顺序表两行、不参与排序的说明、6.2 第 14 项）、第 10 节末尾的一段、本节。
- `selfcheck.py`：把 d9 第 3.1 节里归属为 profile 的表名纳入覆盖检查（做法同 d8）。
