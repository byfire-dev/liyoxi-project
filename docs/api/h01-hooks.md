# 外部回调与探活

| 项 | 内容 |
| --- | --- |
| 范围 | 外部平台调用本系统的回调入口（`/api/v1/hooks/*`）：微信支付的支付结果与退款结果、小程序消息推送（内容安全异步结果、订阅消息事件）、企业微信客户联系事件、数据万象与语音识别的任务回调、短信状态回执、电子签（V1.1）；以及不在四组之内的探活端点 `/healthz`、`/readyz`、`/health` 与内网 `/internal/health/finance`、`/internal/health/flow`。没有画板：回调的结果体现在后台“流程运维 › 回调收件箱”（a01 `admin.webhookEvent.list`）、付款单与退款相关页面（m07、a07）、素材复核（a03）、消息发送日志（a09）等处 |
| 接口数 | 15（V1.0 14，V1.1 1）；其中 5 条探活只登记、不进 OpenAPI（`registryKeyOnly`，A83） |
| 依据 | 数据模型 15（`webhook_event`、`worker_lease`、`invariant_run`、`invariant_violation`）、08（`payment_txn`、`billing_order`、`refund_txn`、`refund_request`、`payment_exception`、`invoice_request`）、06（`media_job`）、13（`notification_delivery`、`wx_subscribe_quota`）、02（`wechat_identity`、`wecom_contact`）、07（`billing_account`、`subscription_term`、`grant_schedule`）、01（`timer`、`outbox_event`、`outbox_delivery`）分组；草案 d4 第 9.5–9.6 节、d2 第 4.4–4.5、7.3、16、18 节、d5 第 6.5、11 节与接口表、d6 第 2.9–2.10 节与接口表、d7 第 7.7、9.3–9.5 节、d3 第 25.4 节、d1 第 8.6 节；裁决 A3、A10、A17、A18、A38、A42、A44、A49、A65、A70、A83、A95、A102、A119、A120、A126；约定 C1、C2、C6、C7、C14、C24、C27、C47、C68、C72、C74、C75、C84 |

## 1. 概览

两类端点，都不在商家端、后台、下载页三组之内，不出 OpenAPI（C74；d7:236）。路径里的回调写法省略 `/api/v1`；探活挂在根路径，不在 `/api/v1` 下。

- **回调**（`/hooks/*`，域名 `api.<域名>`）：外部平台推送结果。验签即鉴权（`x-auth: signed`），不走 Cookie / Bearer，不套用户限流；应答体按各平台协议，不套本系统的信封；去重靠收件表 `webhook_event` 的唯一约束 `uq_webhook_event_provider_event_id`（`x-idempotent: natural`），不用 `Idempotency-Key`（C6、C47）。有主动查询兜底的来源走**内联模式**（收件行与处理结果同一事务）；没有查询接口的走**收件箱模式**（先落库，由任务进程处理，处理侧的迁移归 x01 的非 HTTP 迁移归属表，C84）。回调地址一经在外部平台配置即冻结，改路径按破坏性变更处理（C6）。
- **探活**（根路径）：负载均衡、外部拨测、内网监控用。公开端点只回聚合状态，不暴露细节；资金、计费的明细走内网 `/internal/health/finance`，流程的明细走内网 `/internal/health/flow`（A38、A42、A83）。探活**不分配 operationId**（A42、A83）：下表与第 3 节标“登记键”的，是路线图里 `registryKeyOnly: true` 的条目编号（C1、C75），只作清单对照，不进 OpenAPI、不作幂等作用域、不进限流与豁免清单。降级时 `/health` 与两条内网明细回 503（响应体不变）；停机维护开关不拦探活（A83；C72）。

| operationId / 登记键 | 方法 路径 | 用途 | 鉴权 | 幂等 |
| --- | --- | --- | --- | --- |
| `hooks.wechatpay.transaction.notify` | `POST /hooks/wechatpay/transactions` | 微信支付结果通知：落资金事实，提交后内联入账与履约 | signed（APIv3 验签 + 解密） | natural（`uq_webhook_event_provider_event_id`） |
| `hooks.wechatpay.refund.notify` | `POST /hooks/wechatpay/refunds` | 微信退款结果通知：落退款结果，驱动退款申请、付款单、开票申请、差异单 | signed（同上） | natural（同上） |
| `hooks.wechat.message.verify` | `GET /hooks/wechat/messages` | 小程序消息推送的服务器地址校验 | signed（`signature`） | none（地址校验，不写库） |
| `hooks.wechat.message.receive` | `POST /hooks/wechat/messages` | 小程序消息推送：内容安全异步结果、订阅消息三个事件，落收件箱 | signed（`msg_signature` + 解密） | natural（同上） |
| `hooks.wecom.event.verify` | `GET /hooks/wecom/events` | 企业微信回调地址校验 | signed（`msg_signature` + 解密） | none（地址校验，不写库） |
| `hooks.wecom.event.receive` | `POST /hooks/wecom/events` | 企业微信客户联系事件，落收件箱 | signed（同上） | natural（同上） |
| `hooks.ci.mediaJob.wake` | `POST /hooks/ci/media-jobs/{mediaJobId}?sig=` | 数据万象任务回调：只唤醒该媒体任务 | signed（查询参数 `sig`） | natural（同上） |
| `hooks.asr.mediaJob.wake` | `POST /hooks/asr/media-jobs/{mediaJobId}?sig=` | 语音识别任务回调：只唤醒该媒体任务 | signed（查询参数 `sig`） | natural（同上） |
| `hooks.sms.statusReport.receive` | `POST /hooks/sms/status-reports?token=` | 短信状态回执：只追加写投递行的回执列 | signed（查询参数 `token`） | natural（同上） |
| `hooks.esign.event.receive` | `POST /hooks/esign/events` | 电子签回调（V1.1，细节待设计） | signed | natural（同上） |
| `hooks.healthz.get`（登记键） | `GET /healthz` | 存活：进程活着即 200 | public | none（纯查询） |
| `hooks.readyz.get`（登记键） | `GET /readyz` | 就绪：启动完成且未在排空 | public | none（纯查询） |
| `hooks.health.get`（登记键） | `GET /health` | 公开聚合健康，外部拨测用 | public | none（纯查询） |
| `hooks.internalHealth.finance.get`（登记键） | `GET /internal/health/finance` | 资金与计费的存活指标，仅内网 | public（可达范围靠网络隔离） | none（纯查询） |
| `hooks.internalHealth.flow.get`（登记键） | `GET /internal/health/flow` | 流程（出站事件、投递、定时器、卡住工单）的明细指标，仅内网 | public（可达范围靠网络隔离） | none（纯查询） |

## 2. 公共结构

### 2.1 回调的公共处理

所有回调共用一个框架（d4:1791-1866；15-integration-ops.md:15、20），按下面的顺序执行。各接口只写与此不同或补充的部分。

| 步骤 | 做什么 | 依据 |
| --- | --- | --- |
| 1 网关 | `api.<域名>` 只放行 `/api/v1/hooks/`、`/api/v1/m/` 与探活；回调请求体上限 1 MB，超出由网关回 413（无包体）；`/api/v1/hooks/wechatpay/*` 不改写请求体、WAF 不拦截；**停机维护期间照常放行回调**，不返回 503 `MAINTENANCE` | C1；d7:1376、1377；d2:1678；A65 |
| 2 请求编号与访问日志 | 生成 `X-Request-Id`；访问日志对查询参数 `sig`、`token`、`signature`、`msg_signature`、`echostr` 脱敏；**请求体不进应用日志** | A3；C7；d4:1866 |
| 3 不挂的中间件 | 版本门槛、会话鉴权、成员关系、协议同意、再验证、幂等上下文（C7 的这几层对 `hooks` 不挂） | C6、C7 |
| 4 来源开关 | 来源未启用（企业微信未开客户联系、语音识别未配置）→ 404 `WEBHOOK_SOURCE_DISABLED`。电子签 V1.0 不挂载路由，访问得通用 404，不经本框架（3.10） | d4:1862；01-architecture.md:418 |
| 5 限流 | 不按用户限流；按来源 IP 设高上限保护，档位 `hooks.ip`（额度为部署配置） | C68；d4:1785 |
| 6 取原始字节 | 在任何 JSON、XML、表单解析之前取原始请求体字节；验签用原文；`webhook_event.payload_digest` = 原文 sha256 | d4:1808；15-integration-ops.md:63 |
| 7 验签 | 各来源实现（见各接口）；失败按该来源协议应答失败，绝不回成功；签名、令牌一律常量时间比较 | C6；d4:1809 |
| 8 时间戳 | 带时间戳的协议（微信支付、小程序消息推送、企业微信）与本机相差超过 5 分钟 → 401 `WEBHOOK_TIMESTAMP_SKEWED` | C6；d4:1810；d2:564 |
| 9 解密、取事件标识 | 微信支付 `AEAD_AES_256_GCM`；小程序、企业微信按各自的 AES 方案；按来源算 `event_id`（2.3）。事件类型分三种处理：① **登记清单外**的类型（如企业微信的编辑联系人、小程序的其他事件）验签通过后直接按协议应答成功，不落收件表，只记日志计数；② **登记清单内、但不属于本端点**的类型（如 `REFUND.*` 打到 `/transactions`、`TRANSACTION.SUCCESS` 打到 `/refunds`）照常解密、落收件行记 `ignored` 并告警；③ 小程序的客服消息按 3.4 被动回复转客服，不落库。登记清单见第 4 节枚举 | 15-integration-ops.md:58 |
| 10 落库与处理 | **内联**：一个事务里先插收件行（`ON CONFLICT (provider, event_id) DO NOTHING`），插入时即为 `process_state = processed`、`processed_at` = 当前时间、`mode = inline`（暂定值），处理函数返回 `ignored` 时在同一事务里改写；**不得先插 `received` 占位行**（`ck_webhook_event_inline_state`、`ck_webhook_event_processed_at`、`ck_webhook_event_next_attempt`）。已存在则 `SELECT … FOR UPDATE` 后按状态分支：`processed` / `ignored` 直接应答成功；`received` / `failed`（微信支付兜底写入的行）在本事务内执行处理函数，结果写回本行（`received` / `failed` → `processed` / `ignored`，`processed_at` = 当前时间）；`dead` 不处理，直接应答成功（事实已在收件箱，等后台 `admin.webhookEvent.retry` 或命令行重置）。**收件箱**：一个事务里插收件行（`received`，`next_attempt_at` = 现在）；新插入时同事务写出站事件 `webhook.received`（载荷 `{ v: 1, webhookEventId, provider }`，`dedupe_key = webhook.received:{webhookEventId}`，x01 第 3.15 节）；已存在不重复写 | d4:1813-1840；15-integration-ops.md:43、114-120；A95 |
| 10′ 兜底写入（只限微信支付） | 内联事务因程序错误或约束冲突失败、但数据库可用时，另开短事务只写收件行，然后应答成功：新行 `— → failed`（`mode = inbox`，`attempts = 1`，`payload` 照常为摘要 + `resourceCipher`，带 `key_version`、`error`、`next_attempt_at` = 现在 + 1 分钟）；已存在的 `received` / `failed` 行 `attempts + 1`，未满 8 次 → `failed`（按退避写 `next_attempt_at`、覆盖 `error`），满 8 次 → `dead` 并告警。之后由进程内循环 `webhook.reprocess` 用 `resourceCipher` 与 `key_version` 重新解密处理，连续失败 5 次升级告警（归 x01）。其他内联来源（`ci`、`asr`、`sms`）没有兜底写入：事务失败即回滚，按协议应答失败 | 15-integration-ops.md:116-119、124-126；d2:577、583 |
| 11 应答 | 事实已落库（或已进收件箱）即应答成功；落不了库才应答失败（500 `WEBHOOK_PERSIST_FAILED`），让平台重试 | d2:583；d4:1822-1823、1833 |

- **加锁**：收件行的行锁总在处理事务最前面取得；处理函数随后按全局锁序锁业务行，不回头锁或更新别的收件行（15-integration-ops.md:43）。
- **操作人**：处理函数写的状态历史（`status_transition`）、审计（`audit_log`）、出站事件（`outbox_event`），操作人记 `system`（`actor_type = system`，`client` 为空）；审计的 `job_name` 记本接口的 operationId（本稿补充），`request_id` 记本次请求编号。
- **告警**：验签失败（排除微信支付签名探测）、解密失败、落库失败计入 api 侧的告警指标（d2:1628）；收件积压由探针规则“回调积压”监控（15-integration-ops.md:270）。
- **去重键冲突不是错误**：同一事件重放时按协议应答成功（幂等）。

### 2.2 应答协议 `HookAck`

应答体按各平台协议，不套 `{ code, message, data }` 信封（C6）。本文第 5 节的错误符号只写访问日志与告警指标，不出现在应答体里。

| 来源 | 成功 | 失败 | 依据 |
| --- | --- | --- | --- |
| 微信支付（支付、退款） | HTTP 200，无包体 | 4xx / 5xx，包体 `{ "code": "FAIL", "message": "<原因>" }`；验签失败（含签名探测）401；落不了库 500；5 秒内应答 | d2:564-583；d4:1860 |
| 小程序消息推送 | GET：原样返回查询参数 `echostr`（`text/plain`）；POST：HTTP 200，包体 `success`；客服消息（3.4）改为被动回复 `MsgType = transfer_customer_service`（安全模式下按平台要求加密，格式接入时核对）；5 秒内应答 | 401 / 500，空包体 | d6:2253；d4:1861 |
| 企业微信 | GET：解密后的 `echostr` 明文（`text/plain`）；POST：HTTP 200，空包体 | 401 / 404 / 500，空包体 | d4:1862 |
| 数据万象 | HTTP 200，空包体 | 401 / 400 / 500 | d5:1379 |
| 语音识别 | HTTP 200，包体 `{ "code": 0, "message": "成功" }` | 401 / 400 / 404 / 500 | 接入时按官方格式核对 |
| 短信（腾讯云） | HTTP 200，包体 `{ "result": 0, "errmsg": "OK" }` | 401 / 400 / 500 | 接入时按官方格式核对 |

应答格式以各平台现行文档为准，接入时核对。

### 2.3 收件行 `WebhookEventRow`

每条登记过的回调写一行 `webhook_event`（GET 地址校验、登记清单外的事件、小程序客服消息不写）。公共列：`received_at` = 到达时间；`payload_digest` = 原始请求体 sha256；内联行插入即 `processed`（`ignored` 由处理函数同事务改写），`processed_at` = 处理时间，`attempts = 0`，`next_attempt_at`、`error` 为空；收件箱新行 `attempts = 0`、`next_attempt_at` = 到达时间；微信支付兜底行见 2.1 第 10′ 步（15-integration-ops.md:54-73、93-95）。

| 来源 | `provider` | `event_id` | `event_type` | `mode` | `payload` | `payload_purge_at` | `key_version` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 微信支付 | `wechatpay` | 通知 id（报文 `id`） | 报文 `event_type`：`TRANSACTION.SUCCESS`、`REFUND.SUCCESS`、`REFUND.ABNORMAL`、`REFUND.CLOSED` | `inline`；兜底写入的行记 `inbox`（支付、退款两个端点都有，2.1 第 10′ 步） | `WechatpayPayload` | 到达 + 180 天（只清 `resourceCipher`，`summary` 保留） | APIv3 密钥版本（密钥环 `kid`） |
| 小程序消息推送 | `wechat` | 没有平台事件号：内容安全结果取 `sha256("wxa_media_check:" + trace_id)`；订阅消息事件取验签解密后明文的 sha256（十六进制） | 解密后的 `Event`：`wxa_media_check`、`subscribe_msg_sent_event`、`subscribe_msg_change_event`、`subscribe_msg_popup_event` | `inbox` | `WechatMessagePayload` | 到达 + 90 天 | 空 |
| 企业微信 | `wecom` | 没有平台事件号：取 `sha256(ChangeType + ":" + UserID + ":" + ExternalUserID + ":" + CreateTime)` | `change_external_contact` | `inbox` | `WecomEventPayload` | 到达 + 90 天 | 空 |
| 数据万象 | `ci` | `<mediaJobId>:<回调体里的 JobId>` | 回调体里的事件名，取不到写 `ci_callback` | `inline` | 空（不存） | 空 | 空 |
| 语音识别 | `asr` | `<mediaJobId>:<回调体里的任务号>` | 固定 `asr_callback` | `inline` | 空（不存） | 空 | 空 |
| 短信 | `sms` | 整个请求体的 sha256 | 固定 `sms_status_report` | `inline`（收件箱为备选，3.9） | `SmsStatusPayload` | 到达 + 90 天 | 空 |
| 电子签 | `esign` | V1.1 定 | V1.1 定 | V1.1 定 | V1.1 定 | — | — |

`event_id` 的取法遵守 15 分组“没有平台事件号的取验签后报文关键字段的 sha256；不得直接拼 openid、手机号”（15-integration-ops.md:58）；小程序与企业微信用哪些关键字段、`ci`、`asr`、`sms` 的 `event_type` 固定值、内联行的插入状态是本稿补充，已回写 15 分组（第二批回写）。

### 2.4 载荷结构

载荷按来源判别（15-integration-ops.md:530、535-544；契约 schema `WebhookPayload[provider]`）。`summary` 键放长期保留、不含个人信息的摘要，其余键到 `payload_purge_at` 清除。

**`WechatpayPayload`**（`provider = wechatpay`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `summary` | object | 是 | 长期保留（不少于 3 年）；任何层级都不得有含 `openid` 的键或 `payer` 键（`ck_webhook_event_wechatpay_payload`） | 15-integration-ops.md:98、539 |
| `summary.serial` | string | 是 | 验签身份序列号 | 请求头 `Wechatpay-Serial` |
| `summary.outTradeNo` | string | 否 | 商户单号（支付通知必有，退款通知也带） | 解密资源 `out_trade_no` |
| `summary.outRefundNo` | string | 否 | 商户退款单号（退款通知） | 解密资源 `out_refund_no` |
| `summary.transactionId` | string | 否 | 微信支付单号 | 解密资源 `transaction_id` |
| `summary.refundId` | string | 否 | 微信退款单号（退款通知） | 解密资源 `refund_id` |
| `summary.state` | string | 是 | 交易状态或退款状态，原样 | 解密资源 `trade_state` / `refund_status` |
| `summary.amountFen` | integer(分) | 是 | 支付：实付总额；退款：退款金额 | `amount.total` / `amount.refund` |
| `summary.successAt` | string(date-time) \| 缺省 | 否 | 成功时间，转 UTC | `success_time` |
| `resourceCipher` | object | 是（到期清除） | 报文 `resource` 原样（键名保持微信写法）：`algorithm`、`ciphertext`、`nonce`、`associated_data`、`original_type`；重处理时按 `key_version` 取密钥重新解密；不存解密后的明文 | 报文 `resource`；M23 |

**`WechatMessagePayload`**（`provider = wechat`，按 `event` 分两支）

| 分支 | 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- | --- |
| 内容安全结果 | `event` | string | 是 | 固定 `wxa_media_check` | 解密后 `Event` |
| | `traceId` | string | 是 | 任务号；处理时按 `media_job.external_job_id` 找任务 | `trace_id` |
| | `result` | object | 是 | 微信给的结论对象（`suggest`、`label`），原样 | `result` |
| 订阅消息事件 | `event` | string | 是 | `subscribe_msg_sent_event` / `subscribe_msg_change_event` / `subscribe_msg_popup_event` | 解密后 `Event` |
| | `wechatIdentityId` | string(uuid) \| null | 是 | 推送者 openid 落库前按 `(appid, openid)` 对到 `wechat_identity.id`（`uq_wechat_identity_appid_openid`）；对不上为 null，处理函数整条记 `ignored`。载荷不存 openid | `FromUserName`；15-integration-ops.md:540 |
| | `items` | array<object> | 是 | 微信一次推一个列表，逐项原样 | `List` |
| | `items[].templateId` | string | 是 | 模板 id | `TemplateId` |
| | `items[].msgId` | string | 否 | 消息 id（下发结果事件） | `MsgID` |
| | `items[].status` | string | 否 | 订阅状态（`accept` / `reject` 等） | `SubscribeStatusString` |
| | `items[].errorCode` | string | 否 | 下发结果码（`0` 为成功） | `ErrorCode` |
| | `items[].errorStatus` | string | 否 | 下发结果说明 | `ErrorStatus` |
| | `items[].popupScene` | string | 否 | 弹窗场景 | `PopupScene` |

**`WecomEventPayload`**（`provider = wecom`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `changeType` | enum | 是 | `add_external_contact` / `add_half_external_contact` / `del_external_contact` / `del_follow_user`（第 4 节） | `ChangeType` |
| `staffUserid` | string | 是 | 企业微信成员 `userid`；处理时对到 `staff.wecom_userid` | `UserID` |
| `externalUseridEnc` | string | 是 | 外部联系人标识的密文，与 `wecom_contact.external_userid_enc` 同一加密 | `ExternalUserID` 加密 |
| `state` | string \| 缺省 | 否 | “联系我”的 `state` | `State` |
| `createTime` | string(date-time) | 是 | 回调的 `CreateTime` 转 ISO；`wecom_contact.added_at`、`removed_at` 取它 | `CreateTime` |

`WelcomeCode` 等其他字段丢弃（15-integration-ops.md:541；02-identity-tenant.md:373-374）。

**`SmsStatusPayload`**（`provider = sms`）

| 字段 | 类型 | 必有 | 说明 | 来源（腾讯云字段，接入时核对） |
| --- | --- | --- | --- | --- |
| `reports` | array<object> | 是 | 一次回调可带多条 | 请求体数组 |
| `reports[].serialNo` | string | 是 | 服务商发送流水号；按它找 `notification_delivery.provider_msg_id` | `sid` |
| `reports[].reportStatus` | string | 是 | 回执状态（`SUCCESS` / `FAIL`） | `report_status` |
| `reports[].errCode` | string | 否 | 错误码 | `errmsg` |
| `reports[].reportedAt` | string(date-time) | 是 | 回执时间，北京时间转 UTC | `user_receive_time` |

手机号（`mobile`、`nationcode`）、`description`、`ext` 丢弃不存（15-integration-ops.md:543）。

### 2.5 探活响应

探活不套信封，响应头 `Cache-Control: no-store`。秒数一律整数（与 d7 已发布的 `probeAgeSec` 一致，用于和以秒计的告警阈值比较）。

**`LivenessStatus`**（`/healthz`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `status` | enum | 是 | 恒为 `ok` | 进程能应答即是 |

**`ReadinessStatus`**（`/readyz`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `status` | enum | 是 | `ready` 就绪（HTTP 200）；`starting` 启动未完成（503）；`draining` 排空中（503） | 进程内状态（d7:2045） |

**`HealthSummary`**（`/health`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `status` | enum | 是 | `ok` / `degraded`：`db`、`redis`、`worker` 任一为 `down`，`probeAgeSec` 为空或 ≥ 180，或 `flow = degraded` 时为 `degraded` | 计算 |
| `version` | string | 是 | api 镜像标签 | 部署元数据 |
| `time` | string(date-time) | 是 | 服务端当前时刻 | 时钟 |
| `db` | enum | 是 | `ok` / `down`：1.5 秒内能执行 `SELECT 1` | 现查 |
| `redis` | enum | 是 | `ok` / `down`：1.5 秒内 `PING` 成功 | 现查 |
| `worker` | enum | 是 | `ok` / `down`：`worker_lease.heartbeat_at` 在 60 秒内为 `ok`；超过 60 秒或没有行为 `down` | `worker_lease.heartbeat_at`（15-integration-ops.md:162、183；d7:1561） |
| `probeAgeSec` | integer \| null | 是 | 距探针最近一次跑完的秒数；从未跑过为 null | 现在 − `worker_lease.probe_at`（d7:1947） |
| `flow` | enum | 是 | `ok` / `degraded`：与 `FlowHealth` 的 P1 判定同一段代码（3.13 说明），任一项超过 P1 阈值或取数失败即 `degraded`；只回聚合值，明细走内网 `/internal/health/flow`（3.15） | `outbox_event`、`outbox_delivery`、`timer` 现查（d3:3223） |

**内网明细的取数失败**（`FinanceHealth`、`FlowHealth` 共用，写死如下）：每个指标单独查询，1.5 秒超时。由一条查询得出的对象型指标（`UnappliedReceiptStat`、`WebhookBacklogStat`）取数失败时整个对象为 `null`；标量指标取数失败时该项为 `null`；`certificates` 读密钥环失败时为 `null`。凡是值为 `null` 的顶层指标或 `billing.*` 子项，**一律计入 `breaches`**（取数失败、从未跑过、没有心跳同等对待）；“没有待处理项”一律用 `0` 表示，不用 `null`。

**`FinanceHealth`**（`/internal/health/finance`）

| 字段 | 类型 | 必有 | 说明 | 来源（表.列 或计算规则） |
| --- | --- | --- | --- | --- |
| `status` | enum | 是 | `ok` / `degraded`：`breaches` 非空即 `degraded` | 计算 |
| `time` | string(date-time) | 是 | 服务端当前时刻 | 时钟 |
| `breaches` | array<string> | 是 | 超过阈值或为 `null` 的指标键，如 `unappliedReceipt`、`workerHeartbeatAgeSec`、`billing.sweepLagSec`；全部正常为 `[]` | 计算；阈值为部署配置 |
| `unappliedReceipt` | `UnappliedReceiptStat` \| null | 是 | 成功未入账超过 10 分钟的收款；取数失败为 null | 见下 |
| `workerHeartbeatAgeSec` | integer \| null | 是 | 距 worker 最近一次续约的秒数；没有行或取数失败为 null。初始阈值 180 秒 | 现在 − `worker_lease.heartbeat_at`（d2:1631） |
| `timerLagSec` | integer \| null | 是 | 最老的到期未认领定时器的滞后秒数，没有为 0；取数失败为 null。初始阈值 300 秒 | 现在 − min(`COALESCE(timer.retry_at, timer.fire_at)`)，条件 `timer.status = 'scheduled'` 且已到期（`ix_timer_due`；d2:1632；15-integration-ops.md:267） |
| `webhookBacklog` | `WebhookBacklogStat` \| null | 是 | 微信支付收件积压；取数失败为 null | 见下 |
| `certificates` | array<`CertificateLife`> \| null | 是 | 微信支付证书剩余天数；读密钥环失败为 null。初始阈值 30 天 | 部署配置的密钥环，不读表（d2:1633） |
| `billing` | `BillingLiveness` | 是 | 计费存活指标（d1 第 8.6 节，按 A38 并入本端点）；对象恒在，五项各自可为 null | 见下 |

**`UnappliedReceiptStat`**

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `count` | integer | 是 | 条数；初始阈值 > 0 | `payment_txn` 中 `status = 'succeeded'`、`applied_at` 为空、`refunded_fen < channel_amount_fen`、`channel_success_at` 早于 10 分钟前，且没有 `open` / `resolving` 的 `payment_exception` 指向它（走 `ix_payment_txn_unapplied`、`ix_payment_exception_payment_txn_id`）。排除已开未决差异单的收款：`payment.I2` 要求这类收款都有未决差异单、已由财务跟进，不排除会让金额或付款人不符的收款使指标永久越限（初稿的作者默认，按裁决第十节导语接受） |
| `oldestAgeSec` | integer \| null | 是 | 其中最早一条距成功的秒数；没有为 null | 现在 − min(`payment_txn.channel_success_at`) |

**`WebhookBacklogStat`**（只算 `provider = 'wechatpay'`）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `pendingCount` | integer | 是 | `received` / `failed` 且到达超过 5 分钟的行数；初始阈值 > 0 | `webhook_event.process_state`、`received_at`（`ix_webhook_event_due`；d2:1632） |
| `deadCount` | integer | 是 | `dead` 的行数；初始阈值 > 0 | `webhook_event.process_state`（`ix_webhook_event_dead`） |
| `oldestPendingAgeSec` | integer \| null | 是 | 最早一条待处理行的到达秒数；没有为 null | 现在 − min(`webhook_event.received_at`) |

**`CertificateLife`**

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `kind` | enum | 是 | `merchant_api_cert` 商户 API 证书；`platform_cert` 微信支付平台证书（只在配置了平台证书模式时出现） | 密钥环 |
| `expiresAt` | string(date-time) | 是 | 到期时刻 | 证书 |
| `daysLeft` | integer | 是 | 剩余整天数 | 计算 |

**`BillingLiveness`**（d1:1525-1533 的五个指标，名字按 `…Sec` 统一）

| 字段 | 类型 | 必有 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `sweepLagSec` | integer \| null | 是 | 已到期未推进的最老主体的滞后；没有为 0；取数失败为 null。初始阈值 600 秒 | 现在 − min(`billing_account.next_due_at`)，只取 ≤ 现在的 |
| `invariantRunAgeSec` | integer \| null | 是 | 距上次每日全量校验跑完的秒数；从未跑过或取数失败为 null。初始阈值 26 小时 | 现在 − max(`invariant_run.finished_at`)，条件 `mode = 'full'`、`trigger = 'schedule'`、`status = 'succeeded'` |
| `openViolationCount` | integer \| null | 是 | 计费模块未解决的不变量违规数；取数失败为 null。初始阈值 > 0 | `invariant_violation` 中 `module = 'billing'`、`resolved_at` 为空（`ix_invariant_violation_module_unresolved`；`payment.*` 检查项也登记在 `billing` 模块） |
| `valuationAgeSec` | integer \| null | 是 | 距估值最近一次跑完的秒数（估值在周期任务 `billing.sweep.daily` 里跑）；从未跑过或取数失败为 null。初始阈值 26 小时 | 现在 − max(`timer.fired_at`)，条件 `kind = 'billing.sweep.daily'`、`status = 'fired'`（01-kernel-flow.md:623） |
| `oldestBlockedFulfillmentSec` | integer \| null | 是 | 最早一张仍为已支付、履约受阻的付款单的受阻时长；没有为 0；取数失败为 null。初始阈值 24 小时提醒、72 小时升级 | 现在 − min(`billing_order.paid_at`)，条件 `fulfillment_status = 'blocked'`、`status = 'paid'`（已退款的保留 `blocked` 作痕迹，排除；`ix_billing_order_blocked`） |

**`FlowHealth`**（`/internal/health/flow`；d3:3223-3232 的度量，名字按 `…Sec` / `…Count` 统一）

| 字段 | 类型 | 必有 | 说明 | 来源（表.列 或计算规则） |
| --- | --- | --- | --- | --- |
| `status` | enum | 是 | `ok` / `degraded`：`breaches` 非空即 `degraded` | 计算 |
| `time` | string(date-time) | 是 | 服务端当前时刻 | 时钟 |
| `breaches` | array<string> | 是 | 超过 P1 阈值或为 `null` 的指标键；全部正常为 `[]` | 计算；阈值为部署配置 |
| `warnings` | array<string> | 是 | 只超过 P2 阈值（未到 P1）的指标键；不影响 `status` | 计算 |
| `oldestUnpublishedEventAgeSec` | integer \| null | 是 | 最老未展开出站事件的年龄；没有为 0。初始阈值 P2 > 60 秒、P1 > 300 秒 | 现在 − min(`outbox_event.occurred_at`)，条件 `published_at IS NULL`（`ix_outbox_event_unpublished`） |
| `oldestDueDeliveryAgeSec` | integer \| null | 是 | 最老待处理投递已到期的时长；没有为 0。初始阈值 P2 > 300 秒、P1 > 900 秒 | 现在 − min(`outbox_delivery.next_attempt_at`)，条件 `status IN ('pending','retry','leased')` 且 `next_attempt_at ≤ 现在`（`ix_outbox_delivery_due`、`ix_outbox_delivery_lease`） |
| `deadDeliveryCount` | integer \| null | 是 | 投递死信数。初始阈值 P2 ≥ 1 | `outbox_delivery.status = 'dead'` 的行数（`ix_outbox_delivery_dead`） |
| `timerLagSec` | integer \| null | 是 | 最老的到期未认领定时器的滞后；没有为 0。初始阈值 P2 > 120 秒、P1 > 600 秒 | 现在 − min(`COALESCE(timer.retry_at, timer.fire_at)`)，条件 `timer.status = 'scheduled'` 且已到期（`ix_timer_due`） |
| `failedTimerCount` | integer \| null | 是 | 失败的定时器数。初始阈值 P2 ≥ 1 | `timer.status = 'failed'` 的行数（`ix_timer_failed`） |
| `criticalTimerFailingCount` | integer \| null | 是 | 关键类定时器连续失败数。初始阈值 P1 ≥ 1 | `timer.kind` 属于代码登记的关键类（01-kernel-flow.md 第 3.3 节标“关键类”的 kind）、`status IN ('scheduled','dispatched')` 且 `attempts ≥ 6` 的行数 |
| `stuckTicketCount` | integer \| null | 是 | 卡住的交付工单数。初始阈值 P2 ≥ 1 | `invariant_violation` 中 `code = 'flow.STUCK_TICKET'`、`resolved_at` 为空的行数（`uq_invariant_violation_open` 的前导列）；由 `flow.reevaluate_sweep` 经 `invariants.report` 写入（10-delivery.md:210；15-integration-ops.md:340） |

d3:3232 的“暂停过久的工单数”是 P3 每日汇总，不进本端点，由工作台与日报承担。

### 2.6 回调与入账函数开的差异单 `PaymentExceptionOpen`

回调（`detected_by = callback`）与入账函数（`detected_by = apply`，与 m07 `m.paymentOrder.sync` 共用）实时开的差异单，列的取法写死如下；查单（`m.paymentOrder.sync`、定时器 `po.expire`、`rf.poll`）发现同类事实时用同一套键（x01、m07 配合），对账（`bill.download`，`detected_by = reconciliation`）的键按 a07 与 x01 的写法（如 `bill_only:{账单日}:{微信单号}`）。

开单步骤：先按 `dedupe_key` 查，已存在则跳过（不发事件、不改旧单）；不存在才由 `biz_sequence`（前缀 `CY`）取 `exception_no` 并插入，`ON CONFLICT (dedupe_key) DO NOTHING` 防并发；确实插入时发出站事件 `payment_exception.opened`，并在同一事务刷新所指付款单的 `billing_order.has_open_exception`（付款单须已按全局锁序锁住：`billing_order` 290 先于 `payment_exception` 340；08-billing-payment.md:211、760）。

公共列：`status = open`、`resolution = none`；`bill_date` = 发现时刻的 Asia/Shanghai 日期（08-billing-payment.md:704）；`entity_id`、`billing_order_id`、`payment_txn_id` 从所涉交易行复制（孤儿交易为空）；`bill_fact` 存渠道侧事实（微信单号或退款单号、金额、状态、成功时间；不含 openid 与付款人）；`platform_fact` 存本库当时的状态与金额；`cause_text` 为下表的固定文案。

| 种类 `kind` | 何时开 | 发现方 | `amount_fen` | `refund_txn_id` | `dedupe_key` | `cause_text` |
| --- | --- | --- | --- | --- | --- | --- |
| `status_mismatch`（收款） | 支付回调到达时交易已是 `succeeded`，而微信单号或实收与本库不同（3.1 T1） | `callback` | 实收不同取两者之差的绝对值；只有微信单号不同取本次实收 | 空 | `status_mismatch:{out_trade_no}` | 支付回调与已记成功的交易不符 |
| `refund_over` | 本次成功使 `payment_txn.refunded_fen > channel_amount_fen`（3.2） | `callback` | min(本笔退款金额, `refunded_fen − channel_amount_fen`) | 本笔退款交易 | `refund_over:{out_refund_no}` | 累计成功退款超过实收 |
| `status_mismatch`（迟到成功） | 本笔此前是失败终态（`is_late_success = true`），且没有触发 `refund_over`（3.2；第 6 节第 2 项） | `callback` | 本笔退款金额 | 本笔退款交易 | `status_mismatch:refund:{out_refund_no}` | 退款在失败终态之后收到成功 |
| `refund_amount_mismatch` | 回调的 `amount.refund` 与 `refund_txn.amount_fen` 不同（3.2） | `callback` | 两者之差的绝对值 | 本笔退款交易 | `refund_amount_mismatch:{out_refund_no}` | 渠道退款金额与申请执行金额不符 |
| `amount_mismatch`、`payer_mismatch` | 入账函数判定实收或付款人、回传数据不符（3.1 提交后） | `apply` | `amount_mismatch` 取实收与应付之差的绝对值；`payer_mismatch` 取实收 | 空 | `{kind}:{out_trade_no}` | 实收与应付不符 / 付款人或回传数据不符 |
| `paid_after_cancel`、`duplicate_receipt` | 付款单已取消后到账 / 已支付的付款单又到一笔 | `apply` | 该笔实收 | 空 | `{kind}:{out_trade_no}`（取到账那笔的商户单号，与 08 分组示例 `paid_after_cancel:FK…-01-7QK2M9` 一致） | 取消后收到款 / 重复收款 |
| `fulfillment_blocked` | `fulfill()` 返回 `blocked` | `apply` | 付款单实付 | 空 | `fulfillment_blocked:{out_trade_no}` | 已支付但履约受阻 |

说明：一笔迟到成功若同时超额，只开 `refund_over`（它的 `refund_txn_id` 指向本笔，满足 08 分组“`is_late_success` 的行有对应差异单”，08-billing-payment.md:605、676）；`refund_amount_mismatch` 与前两者可以并存（键不同）。退款侧的 `status_mismatch` 键带 `refund:` 段，避免与收款侧同名键相撞。

## 3. 接口

### 3.1 hooks.wechatpay.transaction.notify　微信支付结果通知
`POST /hooks/wechatpay/transactions`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `signed`：按 `Wechatpay-Serial` 选微信支付公钥（`PUB_KEY_ID_` 开头）或平台证书（仅配置了平台证书模式时，切换期两者并存），对 `时间戳\n随机串\n请求体\n` 做 RSA-SHA256 验签；无能力点、权限点（d2:562-569） |
| 幂等 | natural：`uq_webhook_event_provider_event_id`（`provider = wechatpay`，`event_id` = 通知 id）；不用 `Idempotency-Key`（C6；15-integration-ops.md:58、79） |
| 乐观锁 | 否：资金事实用带原状态条件的 UPDATE（`recordChannelSuccess`）；入账在锁内按状态守卫 |
| 限流 / 开关 | `hooks.ip`（C68）；无开关（商户号已开通，05 第 0 节） |
| 对应画板 | 原型无（回调）。结果见付款结果页与付款单详情（m07 `m.paymentOrder.get`）、后台收款流水与差异处理（a07） |
| 出处 | 路线图 `h01.wechatpay-transactions.notify`；d2:542、558-583、586-640、1479、1628、1678；d4:1813-1826、1860；15-integration-ops.md:43、57-58、114-120、539；08-billing-payment.md:164-165、199、211、317、702、760、767；07-billing-ledger.md:436、539-540；01-kernel-flow.md:382、611；A95 |

**请求**

路径参数：无。查询参数：无。

请求头：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `Wechatpay-Timestamp` | string | 是 | 秒级时间戳，与本机相差 ≤ 5 分钟 | 验签串的一部分 |
| `Wechatpay-Nonce` | string | 是 | — | 验签串的一部分 |
| `Wechatpay-Signature` | string | 是 | base64 | 签名；以 `WECHATPAY/SIGNTEST/` 开头的是平台探测，必须验签失败 |
| `Wechatpay-Serial` | string | 是 | 在密钥表里 | 选验签公钥；写进 `summary.serial` |

请求体（微信支付通知，JSON）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | string | 是 | — | 通知 id → `webhook_event.event_id` |
| `create_time` | string | 是 | — | 只记日志 |
| `event_type` | string | 是 | 期望 `TRANSACTION.SUCCESS` | → `webhook_event.event_type`；登记清单内的其他类型（`REFUND.*`）照常落行记 `ignored` 并告警；登记清单外的类型不落行、只计数（2.1 第 9 步） |
| `resource_type` | string | 是 | `encrypt-resource` | — |
| `resource` | object | 是 | `algorithm = AEAD_AES_256_GCM` | 原样存 `payload.resourceCipher`；用 APIv3 密钥按 `associated_data`、`nonce` 解密 |
| `summary` | string | 否 | — | 不用 |

解密后的交易（只读下列字段）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `mchid`、`appid` | string | 是 | 属于本系统 | 不属于 → 收件行记 `ignored` 并告警 |
| `out_trade_no` | string | 是 | — | 按 `uq_payment_txn_out_trade_no` 找 `payment_txn` |
| `transaction_id` | string | 是 | — | → `payment_txn.channel_txn_no` |
| `trade_state` | string | 是 | `SUCCESS` | → `payment_txn.trade_state_raw` |
| `success_time` | string(date-time) | 是 | — | → `payment_txn.channel_success_at` |
| `amount.total` | integer(分) | 是 | > 0 | → `payment_txn.channel_amount_fen` |
| `payer.openid` | string | 是 | — | → `payment_txn.channel_payer_ref`；只进业务列，不进收件载荷 |
| `attach` | string | 否 | ≤ 128 字节 | → `payment_txn.channel_attach`；入账时与 `payment_txn.attach` 比对 |
| `bank_type` | string | 否 | — | → `payment_txn.bank_type` |

**响应**：`HookAck`（2.2 微信支付一行）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | 验签失败，含 `WECHATPAY/SIGNTEST/` 探测签名（探测不计入验签失败告警） |
| `WEBHOOK_TIMESTAMP_SKEWED` | 401 | 时间戳与本机相差超过 5 分钟（本机时钟偏移另有告警，d2:1629） |
| `WEBHOOK_KEY_NOT_FOUND` | 401 | `Wechatpay-Serial` 在密钥表里查不到；告警 |
| `WEBHOOK_DECRYPT_FAILED` | 500 | 验签通过但解密失败（APIv3 密钥或版本不对）；P1 告警，让微信重试 |
| `WEBHOOK_PAYLOAD_INVALID` | 400 | 报文缺 `id`，或解密后缺必需字段 |
| `WEBHOOK_PERSIST_FAILED` | 500 | T1 与兜底写入 T1′ 都失败（数据库不可用），让微信重试 |

**副作用**

事务 T1（资金事实；`SET LOCAL lock_timeout = '2s'`；d2:573-577）：
- `webhook_event.process_state`：— → `processed`（记下成功）或 `ignored`（找不到 `out_trade_no`、商户号或 appid 不属于本系统、`event_type` 是登记清单内的退款类型；均告警，仍回 200）（15-integration-ops.md:114；d2:572）。插入即 `processed`，判为 `ignored` 时同事务改写（2.1 第 10 步）。
- 同一事件再次到达：行是 `processed` / `ignored` 直接回 200；行是 `received` / `failed`（兜底写入的行）时在本事务内重处理，`received` / `failed` → `processed` / `ignored`（15-integration-ops.md:117）；行是 `dead` 不处理、直接回 200（2.1 第 10 步）。
- `payment_txn.status`：`created` / `prepaid` / `closed` → `succeeded`（`recordChannelSuccess`，08-billing-payment.md:317）：写 `channel_txn_no`、`channel_success_at`、`channel_amount_fen`、`channel_payer_ref`、`channel_attach`、`trade_state_raw`、`bank_type`。不做业务判断；`closed` 也允许（迟到的成功）。本次确有迁移时写出站事件 `payment_txn.succeeded`（`dedupe_key = payment_txn.succeeded:{paymentTxnId}`，x01 第 2.3 节；订阅者 `billing.applyPaymentFallback` 兜底入账）。
- 交易已是 `succeeded` 而微信单号或实收与本次不同：`payment_exception.status`：— → `open`（`kind = status_mismatch`，`detected_by = callback`，各列与键见 2.6；08-billing-payment.md:760；d2:595），同事务刷新 `billing_order.has_open_exception`；出站事件 `payment_exception.opened`。加锁：这条分支里 `recordChannelSuccess` 的条件 UPDATE 未命中、不持有 `payment_txn` 行锁，比对用普通读；开单前先锁 `billing_order`（290）再插 `payment_exception`（340），符合全局锁序（08-billing-payment.md:68、695）。孤儿交易（没有付款单）不刷新标记。
- T1 因程序错误或约束冲突失败 → 兜底事务 T1′ 只写收件行（2.1 第 10′ 步）：新行 `webhook_event.process_state`：— → `failed`（`mode = inbox`）；已存在的 `received` / `failed` 行 → `failed`（`attempts + 1`）或满 8 次 → `dead`；告警（15-integration-ops.md:116-119）。之后由进程内循环 `webhook.reprocess` 用 `resourceCipher` 与 `key_version` 重新解密处理，连续失败 5 次升级告警、8 次进死信（15-integration-ops.md:124-126；归 x01）。

提交后内联入账（另一个事务；`lock_timeout = 1500ms`、`statement_timeout = 3s`；拿不到锁或抛错即放弃，不影响应答；未成的由订阅者 `billing.applyPaymentFallback` 与周期任务 `tx.unapplied_scan` 兜底，归 x01）：调 `applyPayment(paymentTxnId)`，与 `m.paymentOrder.sync` 是同一段代码（入账口径见 m07 第 3.10 节；d2:600-638）；**事件名与触发以 x01 事件目录为准**（A95）：
- `billing_order.status`：`pending_payment` → `paid`（08-billing-payment.md:164）；`billing_order.fulfillment_status`：`none` → `done` / `blocked`（08-billing-payment.md:199）；取消 `po.expire` 定时器（`po.expire:billing_order:{billingOrderId}`）；状态历史与审计；出站事件 `billing_order.paid`，以及 `billing.order_fulfilled` 或 `billing_order.fulfillment_blocked`。
- 履约（07 分组）：`billing_account.sub_status`：`none` / `expired` → `active`（07-billing-ledger.md:436）；`subscription_term.status`：（新建）→ `active` / `scheduled`（07-billing-ledger.md:539-540）；第 0 个月 `grant_schedule.status`：`pending` → `granted`；出站事件 `billing.subscription.activated` / `billing.subscription.renewal_scheduled` / `billing.subscription.upgraded`、`billing.points.granted` / `billing.points.purchased`。付款入账不发 `billing.subscription.resumed`（只由补偿延长发出，x01 第 3.7 节）。
- 实收或付款人不符：`billing_order.status`：`pending_payment` → `cancelled`（`cancel_reason = amount_mismatch` / `payer_mismatch`；08-billing-payment.md:165；微信付款单不会处于 `pending_confirmation`），该笔保留为未入账收款；同事务用 `timers.cancel` 取消该单的 `po.expire` 定时器（`timers.I7`，01-kernel-flow.md:382、611）；出站事件 `billing_order.cancelled`。
- 差异单：`payment_exception.status`：— → `open`（`amount_mismatch`、`payer_mismatch`、`duplicate_receipt`、`paid_after_cancel`、`fulfillment_blocked`，`detected_by = apply`，各列与键见 2.6），刷新 `billing_order.has_open_exception`；对账先建了交易的 `bill_only` 差异单由入账函数重新归类：`open` → `auto_healed`（08-billing-payment.md:767）。出站事件 `payment_exception.opened` / `payment_exception.auto_healed`。

**说明**
- 应答规则：T1 或 T1′ 提交即回 200；入账与履约失败不让微信重试，那由出站事件与扫描兜底（d2:583）。5 秒内应答（d4:1860）。
- 金额、付款人对不对不在 T1 判断，在入账函数里判断（d2:598）；所以正常路径的 T1 只锁 `payment_txn` 一行，最快落定资金事实。只有“已成功却又收到不符的通知”这一分支会按锁序锁付款单开差异单（见上）。
- 载荷只存 `summary`（不含 openid）与 `resourceCipher`，不存解密后的明文；`resourceCipher` 180 天后清除，`summary` 保留（15-integration-ops.md:539；M23）。付款人 openid 只进 `payment_txn.channel_payer_ref`。
- 回调地址写在 JSAPI 下单的 `notify_url`（d2:542），配置后冻结（C6）。
- 收件行可在后台“回调收件箱”查看与重置死信（a01 `admin.webhookEvent.list`、`admin.webhookEvent.retry`）。
- d2 写的差异类型 `fulfillment_exception` 在数据模型里是 `fulfillment_blocked`（08-billing-payment.md:702）。

### 3.2 hooks.wechatpay.refund.notify　微信退款结果通知
`POST /hooks/wechatpay/refunds`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `signed`：验签与解密同 3.1（d2:906） |
| 幂等 | natural：`uq_webhook_event_provider_event_id`（`event_id` = 通知 id） |
| 乐观锁 | 否：渠道事实用带原状态条件的 UPDATE；退款申请、付款单、开票申请、差异单按状态机守卫 |
| 限流 / 开关 | `hooks.ip`（C68）；无开关 |
| 对应画板 | 原型无（回调）。结果见后台退款管理（a07 退款申请列表与详情的“执行中 / 已退款”）、付款单详情的退款记录、商家端站内“退款结果”消息 |
| 出处 | 路线图 `h01.wechatpay-refunds.notify`；d2:886-912、939、1168、1479；d4:1860；08-billing-payment.md:177、211、326、529、531-532、557、605、663-669、676、702、760、763、1114、1131、1140；15-integration-ops.md:114-120、539；01-kernel-flow.md:382、603、608、612；A102 |

**请求**

路径参数：无。查询参数：无。请求头：同 3.1。

请求体：同 3.1 的通知外层，`event_type` 为 `REFUND.SUCCESS` / `REFUND.ABNORMAL` / `REFUND.CLOSED`；登记清单内的 `TRANSACTION.SUCCESS` 打到本端点时落行记 `ignored` 并告警，登记清单外的类型不落行、只计数（2.1 第 9 步）。

解密后的退款（只读下列字段）：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `mchid` | string | 是 | 属于本系统 | 不属于 → `ignored` 并告警 |
| `out_trade_no`、`transaction_id` | string | 是 | — | 写摘要；核对与 `refund_txn` 所指收款一致 |
| `out_refund_no` | string | 是 | — | 按 `uq_refund_txn_out_refund_no` 找 `refund_txn` |
| `refund_id` | string | 是 | — | → `refund_txn.channel_refund_no` |
| `refund_status` | string | 是 | `SUCCESS` / `CLOSED` / `ABNORMAL` | 决定迁移 |
| `success_time` | string(date-time) | 否 | 成功时必有 | → `refund_txn.success_at` |
| `user_received_account` | string | 否 | — | → `refund_txn.user_received_account` |
| `amount.refund` | integer(分) | 是 | > 0 | 与 `refund_txn.amount_fen` 比对；不同则开 `refund_amount_mismatch`（2.6），累加仍按 `refund_txn.amount_fen` |
| `amount.total` | integer(分) | 是 | — | 只写摘要 |

**响应**：`HookAck`（2.2 微信支付一行）。

**错误**：同 3.1（`WEBHOOK_SIGNATURE_INVALID`、`WEBHOOK_TIMESTAMP_SKEWED`、`WEBHOOK_KEY_NOT_FOUND`、`WEBHOOK_DECRYPT_FAILED`、`WEBHOOK_PAYLOAD_INVALID`、`WEBHOOK_PERSIST_FAILED`）。处理事务失败时与 3.1 一样走兜底写入 T1′（2.1 第 10′ 步），收件行进收件箱、回 200，由 `webhook.reprocess` 重新解密处理；`rf.poll` 另行查询兜底（d4:1826）。数据库不可用、T1′ 也失败才回 500。

**副作用**（处理事务 T1；收件行之后按全局锁序加锁：`refund_request` 70 → `billing_order` 290（退款交易有付款单时）→ `payment_txn` 300 → `refund_txn` 320 → `invoice_request` 330 → `payment_exception` 340）

- `webhook_event.process_state`：— → `processed`；找不到 `out_refund_no`（如在商户平台直接发起的退款）→ `ignored` 并告警，由对账的 `refund_bill_only` 差异单兜底（15-integration-ops.md:114；比照 d2:572）。同一事件再次到达、T1 失败后的 T1′ 同 3.1。
- `REFUND.SUCCESS`：
  - `refund_txn.status`：任意 → `succeeded`（08-billing-payment.md:669）；写 `channel_refund_no`、`success_at`、`user_received_account`；此前为 `closed` / `not_accepted` / `abandoned` 的记 `is_late_success = true`；用 `timers.cancel` 取消该交易未触发的 `rf.poll` 定时器（主体 `refund_txn`，kind `rf.poll`）。此前已是 `succeeded` 的不再做下面任何一步（幂等）。
  - 首次成功：`payment_txn.refunded_fen` 累加 `refund_txn.amount_fen`。退的是入账收款（`refund_txn.payment_txn_id` = `billing_order.paid_payment_txn_id`）：`billing_order.refunded_amount_fen` 同额累加；累计 ≥ `paid_amount_fen` 时 `billing_order.status`：`paid` → `refunded`（写 `refunded_at`；08-billing-payment.md:177；出站事件 `billing_order.refunded`），该付款单 `pending` 的开票申请 `invoice_request.status`：`pending` → `rejected`（写 `rejected_at`、`reject_kind = order_refunded`，不填字典原因与驳回人；08-billing-payment.md:1114），同事务用 `timers.cancel` 取消该开票申请的 `sla.breach` 定时器（`sla.breach:invoice_request:{invoiceRequestId}`，`timers.I7`）；出站事件 `invoice.rejected`。未入账收款的退回（规则 `unapplied_receipt`）不动付款单与发票。
  - 退款申请（`refund_txn.refund_request_id` 非空，且该申请名下没有别的未到终态的退款交易，`payment.I5`）：
    - `refund_request.status`：`executing` → `done`（08-billing-payment.md:531）；
    - `refund_request.status`：`pending_execution` → `done`（退款回调晚到：关闭后尚未重新执行，08-billing-payment.md:529，A102；守卫：回调验签通过、对应退款交易存在）；另用 `timers.cancel` 取消执行时限定时器 `sla.breach:approval_request:{approvalRequestId}:execution`（若仍在，01-kernel-flow.md:603）。
    - 两条迁移都写 `done_at`、`closed_at`；状态历史；出站事件 `refund.completed`、`approval.executed`。同事务：申请由差异单转入的，`payment_exception.status`：`resolving` → `resolved`（写 `resolved_at`，处理人与说明沿用；08-billing-payment.md:763；出站事件 `payment_exception.resolved`），刷新 `billing_order.has_open_exception`；清除被本申请暂停的开票申请标记：`held_by_refund_request_id` = 本申请的 `invoice_request` 行一律置空（含上一步刚被驳回的；08-billing-payment.md:1131、1140）。
    - 申请已是 `done` 或 `not_executed`（作废后才收到迟到成功），或名下另有未到终态的退款交易：申请不迁移，只按下一条开差异单，由财务跟进。
  - 差异单（各列与键见 2.6；开单时同事务刷新所指付款单的 `has_open_exception`；出站事件 `payment_exception.opened`）：累计成功退款超过实收（`payment_txn.refunded_fen` > `channel_amount_fen`）→ `payment_exception.status`：— → `open`（`kind = refund_over`，`detected_by = callback`；08-billing-payment.md:760），最高优先级告警（d2:939）；否则 `is_late_success = true` 的 → — → `open`（`kind = status_mismatch`，键 `status_mismatch:refund:{out_refund_no}`；种类见第 6 节第 2 项）；回调金额与 `refund_txn.amount_fen` 不同 → — → `open`（`kind = refund_amount_mismatch`）。
- `REFUND.CLOSED`：`refund_txn.status`：`processing` → `closed`（08-billing-payment.md:666）；若仍是 `created`（提交结果尚未落库的竞态），先按“微信受理”置 `processing`（08-billing-payment.md:663）再置 `closed`；取消 `rf.poll`。本交易是申请当前的退款交易时，`refund_request.status`：`executing` → `pending_execution`（08-billing-payment.md:532），写 `exec_error`；状态历史；出站事件 `refund.execution_failed`。权益已回收，申请不可作废；执行时限不重新计时。
- `REFUND.ABNORMAL`：`refund_txn.status`：`processing` → `abnormal`（08-billing-payment.md:667；`created` 同上先置 `processing`）；申请保持 `executing`；`rf.poll` 保留（每日一次，不设截止，d2:909）；退款告警。`abnormal` 不允许改走线下。
- 交易已在终态且与通知矛盾（如已 `succeeded` 又收到 `CLOSED`）：不改状态，收件行记 `processed`，告警（本稿补充）。

**说明**
- “成功的退款永远落库”：无论 `refund_txn` 当前是什么状态，成功都置 `succeeded` 并累加；`refunded_fen`、`refunded_amount_fen` 不设上限 CHECK，就是为了让超额事实写得进去，而不是被约束弹回、让微信重试后丢失（d2:939）。处理函数自身出错时由 T1′ 把报文收进收件箱，不靠微信重试保住事实。
- 完成动作（累加已退、付款单 → 已退款、开票申请自动驳回、差异单 → 已处理、`refund.completed`）与 a07 `admin.refundRequest.recordOffline`（第 3.63 节）一致（a07 请求）；本节另补的“清除开票暂停标记、取消开票申请的 `sla.breach`”已请 a07 同步。
- 退款结果处理与定时器 `rf.poll`、周期任务 `bill.download`（账单得到成功）是同一段代码，迁移、事件与差异单的键相同（归 x01）。
- 摘要 `summary` 带 `outRefundNo`、`refundId`、`state`、`amountFen`（15-integration-ops.md:539）。
- 兜底：定时器 `rf.poll`（5 分钟起退避至 1 小时；`abnormal` 每日一次）、周期任务 `bill.download`（对账）、进程内循环 `webhook.reprocess`（T1′ 的行），归 x01（d2:909）。

### 3.3 hooks.wechat.message.verify　小程序消息推送地址校验
`GET /hooks/wechat/messages`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `signed`：`signature` = `sha1(字典序拼接(token, timestamp, nonce))`，`token` 是公众平台里配置的消息推送令牌（部署配置） |
| 幂等 | none：GET 地址校验，不写收件表（C6；A18 纯查询） |
| 乐观锁 | 否 |
| 限流 / 开关 | `hooks.ip`（C68）；无开关 |
| 对应画板 | 原型无（公众平台配置消息推送地址时调用） |
| 出处 | 路线图 `h01.wechat-messages.verify`；d6:135、2253；d4:1861；C6 |

**请求**

查询参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `signature` | string | 是 | 40 位十六进制 | 签名 |
| `timestamp` | string | 是 | 与本机相差 ≤ 5 分钟 | — |
| `nonce` | string | 是 | — | — |
| `echostr` | string | 是 | — | 校验通过后原样返回 |

请求体：无。

**响应**：`text/plain`，内容为 `echostr` 原文。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | 签名不符 |
| `WEBHOOK_TIMESTAMP_SKEWED` | 401 | 时间戳偏差超过 5 分钟 |

**副作用**：无（不写 `webhook_event`）。

**说明**：路径由草案的 `/hooks/wechat/message` 改为 `/hooks/wechat/messages`（`resources.json`），公众平台里配置的推送地址同改，配置后冻结（C6）。数据格式在公众平台选 JSON（XML 同样支持，按配置解析）；GET 的参数按微信消息推送规范，接入时核对。

### 3.4 hooks.wechat.message.receive　小程序消息推送
`POST /hooks/wechat/messages`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `signed`（安全模式）：`msg_signature` = `sha1(字典序拼接(token, timestamp, nonce, Encrypt))`；用 EncodingAESKey 解密 `Encrypt`，核对明文尾部的 appid 为本小程序 |
| 幂等 | natural：`uq_webhook_event_provider_event_id`（`provider = wechat`，`event_id` 见 2.3） |
| 乐观锁 | 否 |
| 限流 / 开关 | `hooks.ip`（C68）；无开关 |
| 对应画板 | 原型无（回调）。结果见素材复核的机审结论（a03）、消息发送日志的回执（a09） |
| 出处 | 路线图 `h01.wechat-messages.receive`；d6:848、2253；d4:1861；d5:1927、1929；15-integration-ops.md:57-58、115、540；13-notify-docs.md:441-450；06-media.md:697；01-architecture.md:420；x01 第 2.3、3.15 节；A95 |

**请求**

查询参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `signature` | string | 是 | — | 明文模式签名；安全模式下不作判据 |
| `timestamp` | string | 是 | 与本机相差 ≤ 5 分钟 | — |
| `nonce` | string | 是 | — | — |
| `encrypt_type` | string | 是 | `aes` | 只接受安全模式 |
| `msg_signature` | string | 是 | — | 判据 |

请求体（JSON）：`ToUserName`（string，小程序原始 id）、`Encrypt`（string，密文）。

解密后的事件（只读下列字段）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `MsgType` | string | 是 | `event` 时按 `Event` 分支；`text`、`image`、`miniprogrampage` 是用户发来的客服消息（见下） |
| `Event` | string | `MsgType = event` 时必有 | 登记清单：`wxa_media_check`、`subscribe_msg_sent_event`、`subscribe_msg_change_event`、`subscribe_msg_popup_event`；`user_enter_tempsession`（进入客服会话）按客服消息处理；其他事件不落库，直接应答 `success` |
| `FromUserName` | string | 订阅消息事件必有 | 推送者 openid；落库前换成 `wechat_identity.id`，不进载荷 |
| `trace_id`、`result` | string、object | 内容安全结果必有 | 进载荷 `traceId`、`result` |
| `List` | array | 订阅消息事件必有 | 进载荷 `items`（字段映射见 2.4） |

**响应**：`HookAck`（2.2 小程序一行），5 秒内回 `success`。客服消息（`MsgType` 为 `text`、`image`、`miniprogrampage`，或 `Event = user_enter_tempsession`）不落库，被动回复 `MsgType = transfer_customer_service`，把消息转给小程序的网页版客服工具（第 6 节第 3 项）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | `msg_signature` 不符，或解密后 appid 不是本小程序 |
| `WEBHOOK_TIMESTAMP_SKEWED` | 401 | 时间戳偏差超过 5 分钟 |
| `WEBHOOK_DECRYPT_FAILED` | 500 | 签名通过但解密失败（EncodingAESKey 不对）；告警 |
| `WEBHOOK_PAYLOAD_INVALID` | 400 | 登记清单里的事件缺必需字段（如内容安全结果缺 `trace_id`） |
| `WEBHOOK_PERSIST_FAILED` | 500 | 收件行落不了库，让微信重试 |

**副作用**（一个事务）
- 订阅消息事件：按 `(appid, openid)` 读 `wechat_identity`（`uq_wechat_identity_appid_openid`），得到 `wechatIdentityId`；对不上为 null。
- `webhook_event.process_state`：— → `received`（`mode = inbox`，`next_attempt_at` = 现在，`payload` 为 `WechatMessagePayload`，`payload_purge_at` = 到达 + 90 天；15-integration-ops.md:115）。新插入时同事务写出站事件 `webhook.received`（`aggregate_type = webhook_event`、`aggregate_id` = 本行 id，载荷 `{ v: 1, webhookEventId, provider }`，`dedupe_key = webhook.received:{webhookEventId}`；事件以 x01 第 3.15 节为准，A95；15-integration-ops.md:115 的载荷写法已按此回写）；已存在（重放）不写。
- 客服消息：不写 `webhook_event`，只被动回复转客服（见“响应”）。

**说明**
- 收件箱模式：这类推送没有查询接口，丢了就没了（d4:1861）；落库成功即应答成功。
- 下列处理在任务进程里做（订阅者 `security.onWebhookReceived` 与进程内循环 `webhook.reprocess`），迁移归 x01 的非 HTTP 迁移归属表，不记在本接口（A40；C84）：
  - 内容安全结果：按 `media_job.external_job_id`（即 `trace_id`，`ix_media_job_external_job_id`）找 `audit_image_wx` 任务收尾，`file_object.moderation_state` 落 `pass` / `review` / `block`（06-media.md:197、697；d5:1927）。结果可直接采信，因为本入口已验签解密（d5:1379）。
  - `subscribe_msg_sent_event`：按 `(channel = 'wx_subscribe', provider_msg_id = msgId)` 回写 `notification_delivery.receipt_status`（`errorCode` 的文本）、`receipt_reported_at`（取 `webhook_event.received_at`）；只追加，不改投递状态、不触发补发（13-notify-docs.md:381-382、446）。
  - `subscribe_msg_change_event`：按 `templateId` 找槽位（`wx_template_slot.provider_template_id`），把该身份与槽位的额度行置 `wx_subscribe_quota.state = 'rejected'`、`est_remaining = 0`（13-notify-docs.md:447）。
  - `subscribe_msg_popup_event`：只记日志（13-notify-docs.md:448）。
  - `wechatIdentityId` 为 null 的订阅消息事件整条记 `ignored`（15-integration-ops.md:540）。
- 客服消息的处理：正常情况下在线客服用微信客服（企业微信接待），用户不会发小程序原生客服消息；企业微信降级时在线客服退回小程序原生客服消息（01-architecture.md:420）。小程序开了消息推送后，这类消息先推到本入口，不回 `transfer_customer_service` 就到不了网页版客服工具，所以一律被动回复转客服、不落库（第 6 节第 3 项）。回复的加密与字段按平台规范，接入时核对。
- 路径由草案的 `/hooks/wechat/message` 改为 `messages`。小程序“发货信息管理”相关推送是否也经此入口，草案未写（第 6 节第 1 项）。

### 3.5 hooks.wecom.event.verify　企业微信回调地址校验
`GET /hooks/wecom/events`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `signed`：`msg_signature` = `sha1(字典序拼接(token, timestamp, nonce, echostr))`；用 EncodingAESKey 解密 `echostr`，核对明文尾部的 ReceiveId 为本企业 corpid |
| 幂等 | none：GET 地址校验，不写收件表（C6；A18 纯查询） |
| 乐观锁 | 否 |
| 限流 / 开关 | `hooks.ip`（C68）；只在启用客户联系时开放，未启用 → 404 `WEBHOOK_SOURCE_DISABLED`（d4:1862） |
| 对应画板 | 原型无（企业微信管理后台配置回调地址时调用） |
| 出处 | 路线图 `h01.wecom-events.verify`；d4:1862；d7:1632、1634；01-architecture.md:420；C6 |

**请求**

查询参数：

| 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `msg_signature` | string | 是 | — | 签名 |
| `timestamp` | string | 是 | 与本机相差 ≤ 5 分钟 | — |
| `nonce` | string | 是 | — | — |
| `echostr` | string | 是 | URL 解码后为密文 | 解密后返回明文 |

请求体：无。

**响应**：`text/plain`，内容为解密后的 `echostr` 明文（不带引号、换行）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | 签名不符，或 ReceiveId 不是本企业 |
| `WEBHOOK_TIMESTAMP_SKEWED` | 401 | 时间戳偏差超过 5 分钟 |
| `WEBHOOK_DECRYPT_FAILED` | 500 | 签名通过但解密失败 |
| `WEBHOOK_SOURCE_DISABLED` | 404 | 未启用客户联系 |

**副作用**：无（不写 `webhook_event`）。

**说明**：草案没有写企业微信回调的路径与地址校验（d4:1862 只给了验签方式与收件箱模式；d7:1634 只写落在 `/api/v1/hooks/*`），路径沿用路线图建议值，配置后冻结（C6）。回调域名须与企业微信认证主体相同或有关联（d7:1632）；GET 校验按企业微信回调协议，接入时核对。

### 3.6 hooks.wecom.event.receive　企业微信客户联系事件
`POST /hooks/wecom/events`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `signed`：`msg_signature` = `sha1(字典序拼接(token, timestamp, nonce, Encrypt))`；解密 `Encrypt`，核对 ReceiveId 为本企业 corpid |
| 幂等 | natural：`uq_webhook_event_provider_event_id`（`provider = wecom`，`event_id` 见 2.3） |
| 乐观锁 | 否 |
| 限流 / 开关 | `hooks.ip`（C68）；只在启用客户联系时开放，未启用 → 404 `WEBHOOK_SOURCE_DISABLED` |
| 对应画板 | 原型无（回调）。结果见后台商家详情页头与工单侧栏的“企业微信已添加”（读 `wecom_contact`，a03、a08） |
| 出处 | 路线图 `h01.wecom-events.receive`；d4:1862；15-integration-ops.md:57-59、115、541；02-identity-tenant.md:361-393；12-support.md:18 |

**请求**

查询参数：`msg_signature`、`timestamp`（与本机相差 ≤ 5 分钟）、`nonce`，同 3.5（没有 `echostr`）。

请求体（XML）：`ToUserName`（corpid）、`AgentID`、`Encrypt`（密文）。

解密后的事件（只读下列字段）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `Event` | string | 是 | 只登记 `change_external_contact`；其他事件不落库，直接应答成功 |
| `ChangeType` | string | 是 | 登记清单：`add_external_contact`、`add_half_external_contact`、`del_external_contact`、`del_follow_user`；其他（如编辑联系人）不落库 |
| `UserID` | string | 是 | 员工的企业微信 `userid` → 载荷 `staffUserid` |
| `ExternalUserID` | string | 是 | 外部联系人标识 → 加密后进载荷 `externalUseridEnc` |
| `State` | string | 否 | → 载荷 `state` |
| `CreateTime` | integer | 是 | 秒级时间戳 → 载荷 `createTime`（ISO） |

**响应**：`HookAck`（2.2 企业微信一行）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | 签名不符，或 ReceiveId 不是本企业 |
| `WEBHOOK_TIMESTAMP_SKEWED` | 401 | 时间戳偏差超过 5 分钟 |
| `WEBHOOK_DECRYPT_FAILED` | 500 | 签名通过但解密失败 |
| `WEBHOOK_PAYLOAD_INVALID` | 400 | 登记清单里的事件缺 `UserID`、`ExternalUserID` 或 `CreateTime` |
| `WEBHOOK_SOURCE_DISABLED` | 404 | 未启用客户联系 |
| `WEBHOOK_PERSIST_FAILED` | 500 | 收件行落不了库，让企业微信重试 |

**副作用**（一个事务）
- `webhook_event.process_state`：— → `received`（`mode = inbox`，`next_attempt_at` = 现在，`payload` 为 `WecomEventPayload`，`payload_purge_at` = 到达 + 90 天；15-integration-ops.md:115）。新插入时同事务写出站事件 `webhook.received`（载荷 `{ v: 1, webhookEventId, provider }`，`dedupe_key = webhook.received:{webhookEventId}`，同 3.4）；已存在不写。

**说明**
- 收件箱模式：加好友事件只有推送、没有查询接口（02-identity-tenant.md:391）。
- 任务进程里的处理归 x01，不记在本接口：`add_external_contact`、`add_half_external_contact` 插 `wecom_contact` 行（`added_at` 取 `createTime`；同一员工与同一外部联系人的有效关系由 `uq_wecom_contact_staff_external_active` 保证只有一条）；`del_external_contact`、`del_follow_user` 写 `wecom_contact.removed_at`（取 `createTime`；早于有效行 `added_at` 的删除事件不处理）。按回调里的 `userid` 对到 `staff.wecom_userid`，对不上员工的整条记 `ignored`；按外部联系人详情接口取 unionid、对 `wechat_identity.unionid`，对不上商家用户也落行，之后回填（02-identity-tenant.md:363-391）。`wecom_contact` 没有状态机。
- 在线客服用微信客服，会话内容不落库（12-support.md:18），V1.0 不接微信客服的消息回调。

### 3.7 hooks.ci.mediaJob.wake　数据万象任务回调
`POST /hooks/ci/media-jobs/{mediaJobId}?sig=`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `signed`：数据万象回调没有验签机制，只验查询参数 `sig` = `HMAC-SHA256(回调密钥, mediaJobId)` 的 base64url（06-media.md:697；具体算法与编码为本稿补充）；`ci`、`asr` 各用一把密钥 |
| 幂等 | natural：`uq_webhook_event_provider_event_id`（`provider = ci`，`event_id` = `<mediaJobId>:<JobId>`） |
| 乐观锁 | 否：带原状态条件的单行 UPDATE |
| 限流 / 开关 | `hooks.ip`（C68）；无开关 |
| 对应画板 | 原型无（回调）。结果见后台媒体任务列表（a01） |
| 出处 | 路线图 `h01.ci-media-jobs.wake`；d5:1379、2121；d4:1863；06-media.md:643、697；15-integration-ops.md:58、542；01-architecture.md:425；A3、A126；C6 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `mediaJobId` | string(uuid) | 是 | — | `media_job.id`；提交云端任务时写进回调地址 |
| 查询 | `sig` | string | 是 | base64url | 每任务签名；访问日志脱敏 |
| 请求体 | — | JSON 或 XML | 是 | 按提交时的 `CallBackFormat` | 只读云端任务号 `JobId` 与事件名；其余（含任务状态）不读、不存 |

**响应**：`HookAck`（2.2 数据万象一行）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | `sig` 不符；`mediaJobId` 不是 uuid 也按此回（不区分，避免被探测） |
| `WEBHOOK_PAYLOAD_INVALID` | 400 | 回调体取不到 `JobId`（无法去重；任务由 15 秒一次的回查兜底） |
| `WEBHOOK_PERSIST_FAILED` | 500 | 落不了库 |

**副作用**（一个内联事务）
- `webhook_event.process_state`：— → `processed` 或 `ignored`（15-integration-ops.md:114）。
- 任务存在且 `media_job.state = 'submitted'`：把 `media_job.next_run_at` 置为当前时间（条件 UPDATE `WHERE state = 'submitted'`），收件行记 `processed`；不改 `media_job.state`，不读回调体里的状态。
- 任务不存在，或不是 `submitted`（`queued` 的 `next_run_at` 是执行时间、`running` / `submitting` 的是租约到期时间，不能改；已结束的不需要唤醒）：不改任务行，收件行记 `ignored`（本稿补充的守卫：06-media.md:643 定 `running` / `submitting` 的 `next_run_at` 是租约到期时间，684 只写“置为当前”；06 分组已按此补上守卫）。
- 提交后向执行循环发一个进程内唤醒信号；丢了也会被 15 秒一次的扫描领走（x01 第 4.3 节）。

**说明**
- 回调只当提醒，任务结果一律以 `describeJob` 回查为准并整份落 `media_job.output`（d5:1379；01-architecture.md:425）。
- 草案路径 `/hooks/ci/{jobId}/{sig}`（d5:1379、2121）按资源名补 `media-jobs`，`sig` 按 A3 移到查询参数；06-media.md:697 已是新写法。数据万象的回调地址能否带查询参数，接入时核对；不支持时按 A126 改为“路径里带不可枚举的随机段 + 服务端比对”，作为 A3 的例外在接入时登记，本文接口形态不变。

### 3.8 hooks.asr.mediaJob.wake　语音识别任务回调
`POST /hooks/asr/media-jobs/{mediaJobId}?sig=`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `signed`：同 3.7，`sig` = `HMAC-SHA256(asr 回调密钥, mediaJobId)` 的 base64url |
| 幂等 | natural：`uq_webhook_event_provider_event_id`（`provider = asr`，`event_id` = `<mediaJobId>:<任务号>`） |
| 乐观锁 | 否 |
| 限流 / 开关 | `hooks.ip`（C68）；语音识别未配置时不转写（01-architecture.md:418），本入口回 404 `WEBHOOK_SOURCE_DISABLED` |
| 对应画板 | 原型无（回调）。结果见素材理解与转写（a03 素材复核）、后台媒体任务列表（a01） |
| 出处 | 路线图 `h01.asr-media-jobs.wake`；d5:2121；d4:1826、1864；06-media.md:643、697；15-integration-ops.md:58、542；01-architecture.md:418；A3、A126；C6 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 路径 | `mediaJobId` | string(uuid) | 是 | — | `media_job.id`（`kind = asr`） |
| 查询 | `sig` | string | 是 | base64url | 每任务签名；访问日志脱敏 |
| 请求体 | — | 表单或 JSON（按官方格式） | 是 | — | 只读云端任务号（官方字段名接入时核对）；转写文本等其余字段不读、不存、不进日志 |

**响应**：`HookAck`（2.2 语音识别一行）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | `sig` 不符或 `mediaJobId` 不是 uuid |
| `WEBHOOK_PAYLOAD_INVALID` | 400 | 回调体取不到任务号 |
| `WEBHOOK_SOURCE_DISABLED` | 404 | 语音识别未配置 |
| `WEBHOOK_PERSIST_FAILED` | 500 | 落不了库 |

**副作用**：同 3.7（`webhook_event.process_state`：— → `processed` / `ignored`；只有 `submitted` 的任务把 `media_job.next_run_at` 置为当前时间，其余记 `ignored`）。

**说明**
- d4:1858-1864 的来源表没有单列语音识别；它有查询接口，按 d4:1826“内联只用于有主动查询兜底的来源”定为内联，结果以回查为准（06-media.md:697）。
- 草案路径 `/hooks/asr/{jobId}/{sig}`（d5:2121）按资源名补 `media-jobs`，`sig` 移到查询参数。语音识别的回调地址能否带查询参数，接入时核对；不支持时同 3.7 按 A126 处理。

### 3.9 hooks.sms.statusReport.receive　短信状态回执
`POST /hooks/sms/status-reports?token=`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `signed`：查询参数 `token` 与部署配置里的不可猜令牌（不少于 32 字节随机数）常量时间比较；轮换期可同时配置新旧两个（本稿补充）。官方验签方式接入时核对，确认前本接口只追加写回执列（d6:938） |
| 幂等 | natural：`uq_webhook_event_provider_event_id`（`provider = sms`，`event_id` = 整个请求体的 sha256） |
| 乐观锁 | 否 |
| 限流 / 开关 | `hooks.ip`（C68）；无开关 |
| 对应画板 | 原型无（回调）。结果见后台消息发送日志的“回执”列（a09，读 `notification_delivery.receipt_status`） |
| 出处 | 路线图 `h01.sms-status-reports.receive`；d6:938、2254；d4:1864；15-integration-ops.md:58、114-115、543；13-notify-docs.md:378-382、441-450；A3、A126；C6 |

**请求**

| 位置 | 字段 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 查询 | `token` | string | 是 | — | 访问日志脱敏 |
| 请求体 | （数组） | array<object> | 是 | 至少 1 项 | 腾讯云短信状态回调，每项读 `sid`、`report_status`、`errmsg`、`user_receive_time`，映射见 2.4 `SmsStatusPayload`；手机号丢弃 |

**响应**：`HookAck`（2.2 短信一行）。

**错误**

| 错误码 | HTTP | 何时 |
| --- | --- | --- |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | `token` 不符 |
| `WEBHOOK_PAYLOAD_INVALID` | 400 | 请求体不是数组，或某项缺 `sid` / `report_status` |
| `WEBHOOK_PERSIST_FAILED` | 500 | 落不了库，让短信平台重推 |

**副作用**（内联，一个事务）
- `webhook_event.process_state`：— → `processed`（至少一项对上投递行）或 `ignored`（全部对不上）（15-integration-ops.md:114）；`payload` 为 `SmsStatusPayload`，`payload_purge_at` = 到达 + 90 天。
- 逐项：按 `(channel = 'sms', provider_msg_id = serialNo)` 找投递行（`ix_notification_delivery_provider_msg_id`），写 `notification_delivery.receipt_status`（成功写 `SUCCESS`；失败写 `errCode`，缺失时写 `reportStatus`；不超过 16 字符）、`notification_delivery.receipt_reported_at`（取 `reportedAt`）。找不到的项跳过并记日志，不让整条失败；重放写入相同的值，天然幂等（13-notify-docs.md:381-382、445、450）。
- **不改** `notification_delivery.status`，不触发补发（13-notify-docs.md:381；d6:938）。
- 失败时整体回滚、回 500 让短信平台重推（内联来源没有兜底写入，2.1 第 10′ 步）。

**说明**
- 模式定为内联（初稿的作者默认，按裁决第十节导语接受；与 x01 第 8 节第 13 项的默认一致，x01 第 4.5 节的“待确认”已请 x01 改为内联）：回执写入天然幂等，失败由平台重推即可，不需要任务进程。d4:1864 写“按是否有查询接口选择”；若接入时发现短信平台不重推，改为收件箱备选：本接口改为 `webhook_event.process_state`：— → `received`，同事务写出站事件 `webhook.received`（载荷同 3.4），逐项回写由任务进程做（归 x01）。
- 草案写作 `/hooks/sms/status/{token}`（d6:2254），按 A3 把令牌移到查询参数、按资源名改为 `status-reports`。短信平台能否在回调地址的查询参数里带令牌，接入时核对；不支持时按 A126 改为路径里带不可枚举的随机段。未配置回调时 `sent` 只表示服务商已受理（d6:938）。
- 回执只追加写两列、不改投递状态，与数据模型 13 分组一致（13-notify-docs.md:381、441）；x01 第 5.14 节对 13:437 的括注（“回执回写时同样适用”）与此矛盾，已请 x01 删除。

### 3.10 hooks.esign.event.receive　电子签回调（V1.1）
`POST /hooks/esign/events`

V1.1，细节待设计。用途：接收电子签平台的签署结果。V1.0 不挂载此路由，访问得通用 404，不经回调框架、不返回 `WEBHOOK_SOURCE_DISABLED`；`webhook_event.provider` 的 `esign` 只在 CHECK 里声明、不写入；接入时在 15 分组第 4 节补载荷结构，表结构不变，验签方式届时定（15-integration-ops.md:544；d4:1864）。鉴权 `signed`，幂等 natural（`uq_webhook_event_provider_event_id`）。路径为路线图建议值。出处：路线图 `h01.esign-events.receive`。

### 3.11 hooks.healthz.get（登记键）　存活检查
`GET /healthz`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `public`：不解析凭据 |
| 幂等 | none：GET，纯查询（A18） |
| 乐观锁 | 否 |
| 限流 / 开关 | 不设应用层限流（不在四组之内）；不受停机维护拦截（A83；C72） |
| 对应画板 | 无（探活，人工排障用） |
| 出处 | 路线图 `h01.health.live`（`registryKeyOnly`）；d7:99、2044；A38、A42、A83；C1、C74、C75 |

**请求**：无。

**响应**：`LivenessStatus`（2.5），HTTP 200。

**错误**：无（进程不在即无应答）。

**副作用**：无。

**说明**：按 A38 由 `/livez` 改为 `/healthz`。只说明进程活着，不查数据库与 Redis。根路径，不在 `/api/v1` 下、不进 OpenAPI。

### 3.12 hooks.readyz.get（登记键）　就绪检查
`GET /readyz`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `public` |
| 幂等 | none：GET，纯查询（A18） |
| 乐观锁 | 否 |
| 限流 / 开关 | 不设应用层限流；不受停机维护拦截（A83：负载均衡靠它判断节点，维护期间也不能被摘空） |
| 对应画板 | 无（负载均衡健康检查） |
| 出处 | 路线图 `h01.health.ready`（`registryKeyOnly`）；d7:1345、1778-1781、2045、2050；A38、A42、A83；C1 |

**请求**：无。

**响应**：`ReadinessStatus`（2.5）：`ready` → 200；`starting`、`draining` → 503。

**错误**：无（503 是语义应答，不是错误码）。

**副作用**：无。

**说明**
- 只反映“进程已完成启动且未在排空”：启动阶段要求配置校验通过、成功连上一次数据库；之后不再查库。进入排空（发布步骤 `api-drain`，或收到 SIGTERM）立即 503，但继续正常处理请求（d7:1778、2045）。
- **不把数据库可达作为就绪条件**：两台节点共用一个库，库慢时摘节点没有收益，只会交替抖动；数据库状态由 `/health` 与告警反映。Redis 同理（d7:2050）。
- 负载均衡每 5 秒探一次，连续 2 次失败摘除、2 次成功恢复（d7:1345）。

### 3.13 hooks.health.get（登记键）　公开聚合健康
`GET /health`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `public` |
| 幂等 | none：GET，纯查询（A18） |
| 乐观锁 | 否 |
| 限流 / 开关 | 不设应用层限流；结果在进程内缓存 5 秒，避免被频繁调用放大数据库负载（本稿补充）；不受停机维护拦截（A83） |
| 对应画板 | 无（外部拨测、人工排障） |
| 出处 | 路线图 `h01.health.get`（`registryKeyOnly`）；d7:1561、1947、1958、2046；d3:3223-3232；15-integration-ops.md:16、152、162-163、183；A38、A42、A83；C1、C74 |

**请求**：无。

**响应**：`HealthSummary`（2.5）。`status = ok` → 200；`degraded` → 503，响应体不变（A83：只看状态码的拨测也能报警）。

**错误**：无。

**副作用**：无（只读 `worker_lease`、`outbox_event`、`outbox_delivery`、`timer`）。

**说明**
- A42 定为保留（外部拨测用），只回聚合状态，不暴露细节（d7:2046）。外部拨测每分钟请求一次，断言 `worker = ok` 且 `probeAgeSec < 180`；探针自己挂了也能被发现（d7:1958）。
- 各项探测 1.5 秒超时，超时按 `down` 计（d7:2046）。
- `flow` 的判定（d3:3223-3232，阈值为部署配置，初值取 P1）：最老未展开事件（`outbox_event.published_at` 为空的最早 `occurred_at`）超过 5 分钟；最老待处理投递（`outbox_delivery.status` 为 `pending` / `retry` / `leased` 且 `next_attempt_at` ≤ 现在的最早一行）超过 15 分钟；最老到期未认领定时器（`timer.status = 'scheduled'`）滞后超过 10 分钟；关键类定时器连续失败（`timer.attempts` ≥ 6）。任一成立或取数失败即 `degraded`。这几项由 api 进程自己执行（走部分索引），不依赖 Redis，也不依赖 worker 存活；与 3.15 的 P1 判定是同一段代码。明细数值走内网 `/internal/health/flow`（3.15，A83）。
- d1:1525-1533 原要求在 `/health` 里带“计费分节”，按 A38 并入 `/internal/health/finance`（3.14）。

### 3.14 hooks.internalHealth.finance.get（登记键）　资金与计费存活指标（内网）
`GET /internal/health/finance`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `public`：不解析凭据；可达范围靠网络隔离——网关对所有公网域名的 `/internal/*` 回 404，只在 VPC 内经节点内网地址访问（d2:1643）。`public` 清单里登记为“仅内网” |
| 幂等 | none：GET，纯查询（A18） |
| 乐观锁 | 否 |
| 限流 / 开关 | 不设应用层限流；不受停机维护拦截（A83） |
| 对应画板 | 无（云监控或独立探针每分钟拉取） |
| 出处 | 路线图 `h01.health.finance`（`registryKeyOnly`）；d2:1626-1643；d1:1520-1533；01-kernel-flow.md:623；08-billing-payment.md:154、307；15-integration-ops.md:103-104、267；A38、A42、A83；C1 |

**请求**：无。

**响应**：`FinanceHealth`（2.5）。`status = ok` → 200；`degraded` → 503，响应体不变（A83）。

**错误**：无。单项查询超时（1.5 秒）或出错时按 2.5“内网明细的取数失败”置 `null`（各字段的可空性已在 2.5 写明），指标键计入 `breaches`。

**副作用**：无（只读 `payment_txn`、`payment_exception`、`worker_lease`、`timer`、`webhook_event`、`billing_account`、`invariant_run`、`invariant_violation`、`billing_order`）。

**说明**
- 由 api 进程现算，worker 不在时照样能报警（d2:1643；d1 第 8.6 节“存活监控不依赖 worker”）。各查询走部分索引：`ix_payment_txn_unapplied`、`ix_webhook_event_due`、`ix_webhook_event_dead`、`ix_billing_order_blocked`。
- 指标与初始阈值（部署配置）：成功未入账超过 10 分钟 > 0（财务 + 研发）；worker 心跳超过 3 分钟；最早未处理定时器延迟超过 5 分钟；微信支付收件积压 > 0 且超过 5 分钟；证书剩余不足 30 天（d2:1628-1633）；计费推进滞后超过 600 秒、每日校验超过 26 小时未跑完、计费违规 > 0、估值超过 26 小时未跑、履约受阻超过 24 小时提醒与 72 小时升级（d1:1528-1533）。
- 证书剩余天数不读库，读部署配置的密钥环；微信支付公钥模式下只有商户 API 证书一项（d2:1676-1677 第 2 项）。
- 只回指标值，不回付款单号、主体等明细；明细在后台系统健康与差异处理页查。
- 可达范围只靠网络隔离，不另加内部令牌（d2:1643；初稿的作者默认，按裁决第十节导语接受）：只回指标值、不回明细，内网横向访问的暴露面可接受。

### 3.15 hooks.internalHealth.flow.get（登记键）　流程明细指标（内网）
`GET /internal/health/flow`

| 项 | 内容 |
| --- | --- |
| 鉴权 | `public`：不解析凭据；可达范围同 3.14（网关对公网域名的 `/internal/*` 回 404，只在 VPC 内访问）。`public` 清单里登记为“仅内网”（C1） |
| 幂等 | none：GET，纯查询（A18） |
| 乐观锁 | 否 |
| 限流 / 开关 | 不设应用层限流；不受停机维护拦截（A83） |
| 对应画板 | 无（云监控或独立探针每分钟拉取；后台“系统健康”另有页面） |
| 出处 | 路线图 `h01.health.flow`（`registryKeyOnly`，A83 补）；d3:3223-3232；01-kernel-flow.md:382、593-618；10-delivery.md:210；15-integration-ops.md:340、380；A42、A83；C1、C74、C75 |

**请求**：无。

**响应**：`FlowHealth`（2.5）。`status = ok` → 200；`degraded` → 503，响应体不变（A83）。

**错误**：无。单项查询超时（1.5 秒）或出错时该项为 `null`，指标键计入 `breaches`（2.5“内网明细的取数失败”）。

**副作用**：无（只读 `outbox_event`、`outbox_delivery`、`timer`、`invariant_violation`）。

**说明**
- 由 api 进程现算，不依赖 Redis 与 worker 存活（d3:3223）。各查询走部分索引：`ix_outbox_event_unpublished`、`ix_outbox_delivery_due`、`ix_outbox_delivery_lease`、`ix_outbox_delivery_dead`、`ix_timer_due`、`ix_timer_failed`、`uq_invariant_violation_open`。
- 阈值为部署配置，初值取 d3:3223-3232 的 P2 / P1；超过 P1 的进 `breaches`（决定 `status` 与 HTTP 状态），只超过 P2 的进 `warnings`。`/health` 的 `flow` 与这里的 P1 判定同一段代码。
- 关键类定时器的 kind 清单由代码登记（01-kernel-flow.md 第 3.3 节标“关键类”的，如 `po.expire`、`usage.end`、`usage.resync`、`takedown.create`、`service.auto_resolve`），不读表。
- 只回指标值，不回事件、定时器或工单的明细；明细在后台“流程运维”页查（a01）。

## 4. 枚举

| 名称 | 取值 | 含义 |
| --- | --- | --- |
| `webhook_event.provider` | `wechatpay`、`wechat`、`wecom`、`ci`、`asr`、`sms`、`esign` | 同数据模型 `webhook_event.provider`（15-integration-ops.md:462） |
| `webhook_event.mode` | `inline`、`inbox` | 同数据模型 `webhook_event.mode` |
| `webhook_event.process_state` | `received`、`processed`、`ignored`、`failed`、`dead` | 同数据模型 `webhook_event.process_state` |
| `WechatpayEventType`（`webhook_event.event_type` 的登记值） | `TRANSACTION.SUCCESS`、`REFUND.SUCCESS`、`REFUND.ABNORMAL`、`REFUND.CLOSED` | 微信支付通知类型，原样保存（数据库不逐值校验） |
| `WechatMessageEvent` | `wxa_media_check`、`subscribe_msg_sent_event`、`subscribe_msg_change_event`、`subscribe_msg_popup_event` | 小程序消息推送的登记事件；其他事件不落库 |
| `WechatKfMessage` | `text`、`image`、`miniprogrampage`（`MsgType`）；`user_enter_tempsession`（`MsgType = event` 的 `Event`） | 小程序原生客服消息：不落库，被动回复 `transfer_customer_service`（3.4） |
| `WecomChangeType` | `add_external_contact`、`add_half_external_contact`、`del_external_contact`、`del_follow_user` | 企业微信客户联系事件的登记子类型；前两者按“已添加”，后两者按“关系解除”（02-identity-tenant.md:393） |
| `HookFixedEventType` | `ci_callback`、`asr_callback`、`sms_status_report` | 本稿补充的 `event_type` 固定值（取不到平台事件名时） |
| `HealthStatus` | `ok`、`degraded` | `/health`、`/internal/health/finance`、`/internal/health/flow` 的总状态；`HealthSummary.flow` 同此；`degraded` 时 HTTP 503（A83） |
| `ComponentStatus` | `ok`、`down` | `/health` 的 `db`、`redis`、`worker` |
| `ReadinessState` | `ready`、`starting`、`draining` | `/readyz` |
| `LivenessState` | `ok` | `/healthz` |
| `CertificateKind` | `merchant_api_cert`、`platform_cert` | 商户 API 证书；微信支付平台证书 |
| `payment_txn.status` | `created`、`prepaid`、`succeeded`、`closed` | 同数据模型 `payment_txn.status` |
| `refund_txn.status` | `created`、`processing`、`succeeded`、`closed`、`abnormal`、`not_accepted`、`abandoned` | 同数据模型 `refund_txn.status` |
| `payment_exception.detected_by` | `callback`、`query`、`apply`、`reconciliation`、`manual` | 同数据模型；本文写 `callback`（回调发现）与 `apply`（入账函数发现） |
| `payment_exception.kind`（本文开单用到的） | `status_mismatch`、`refund_over`、`refund_amount_mismatch`、`amount_mismatch`、`payer_mismatch`、`duplicate_receipt`、`paid_after_cancel`、`fulfillment_blocked` | 同数据模型 `payment_exception.kind`（14 种中的 8 种）；开单写法见 2.6 |
| `refund_request.status` | `pending_approval`、`pending_execution`、`executing`、`done`、`not_executed` | 同数据模型；本文驱动 `executing` / `pending_execution` → `done` 与 `executing` → `pending_execution` |

## 5. 错误码

本文新定义的领域错误码（A70 区间 46600–46699）。回调的应答体按各平台协议（2.2），这些符号**不出现在应答体里**：写访问日志的 `error` 字段、计入 api 侧告警指标，契约 `errors.ts` 照常登记（C25）。探活不用错误码。

| 符号 | 数值 | HTTP | 可重试 | 含义 |
| --- | --- | --- | --- | --- |
| `WEBHOOK_SIGNATURE_INVALID` | 46601 | 401 | 否 | 验签失败：平台签名、每任务 `sig` 或回调令牌不符（含微信支付签名探测；探测不计入告警） |
| `WEBHOOK_TIMESTAMP_SKEWED` | 46602 | 401 | 否 | 带时间戳的协议与本机相差超过 5 分钟 |
| `WEBHOOK_KEY_NOT_FOUND` | 46603 | 401 | 否 | 微信支付 `Wechatpay-Serial` 在密钥表里查不到；告警 |
| `WEBHOOK_DECRYPT_FAILED` | 46604 | 500 | 是 | 验签通过但解密失败（密钥或版本配置错误）；P1 告警，由平台重试 |
| `WEBHOOK_PAYLOAD_INVALID` | 46605 | 400 | 否 | 验签通过但报文无法解析，或缺事件标识等必需字段 |
| `WEBHOOK_SOURCE_DISABLED` | 46606 | 404 | 否 | 该来源未启用（企业微信未开客户联系、语音识别未配置）；电子签 V1.0 不挂载路由，得通用 404，不用本码 |
| `WEBHOOK_PERSIST_FAILED` | 46607 | 500 | 是 | 收件行或资金事实落不了库（数据库不可用，兜底写入也失败）；由平台重试 |

“可重试”指平台按其协议重推后可能成功；这些码不经端上，不涉及 C26 的同键重试。

## 6. 待确认

只留需要产品、业务、法务（含财务）决定的问题。初稿的第 1、2、3、10 项已由 A83 裁决，第 5 项由 A126 裁决，第 6 项由 C68（`hooks.ip` 已登记）关闭，第 8 项①由 A102 裁决；第 4、7、8②、12 项的作者默认按裁决第十节导语接受，已写进 3.9、2.5、3.2、3.14；第 11 项是数据模型回写，转主负责人。

| # | 问题 | 影响 | 默认做法 | 谁定 |
| --- | --- | --- | --- | --- |
| 1 | 小程序“发货信息管理”相关推送是否经本入口（d2 第 10.4 节只写了上报） | 命中 K8 时是否要收事件 | 不在登记清单，验签后应答成功、不落库；命中 K8 再登记事件与处理 | 产品、研发 |
| 2 | 迟到成功（失败终态之后收到退款成功、且没有超额）开哪种差异单：08 分组要求 `is_late_success` 的行必有差异单（08-billing-payment.md:605、676），14 种 `kind` 里没有专门的“迟到成功” | 财务待办的分类与可选处理（`status_mismatch` 只允许 `corrected`） | 开 `status_mismatch`（`detected_by = callback`，键 `status_mismatch:refund:{out_refund_no}`，2.6）；同时超额的只开 `refund_over`。若财务要单列，由 08 分组加 `kind = refund_late_success`（可选处理 `corrected` / `written_off`），本文只改 2.6 一行 | 财务、主负责人（回写 08） |
| 3 | 企业微信降级时在线客服退回小程序原生客服消息（01-architecture.md:420），V1.0 是否支持这条降级路径 | 不支持时本入口对客服消息回 `success` 会把消息吞掉；支持则需在小程序后台开网页版客服工具并绑定客服人员 | 支持：客服消息一律被动回复 `transfer_customer_service`、不落库（3.4）；客服人员绑定由运营在小程序后台配置 | 产品、运营 |

## 7. 修订记录

| 日期 | 改了什么 | 依据 |
| --- | --- | --- |
| 2026-10-03 | 初稿：路线图 `doc = h01-hooks` 的 14 条（V1.0 13、V1.1 1）；公共处理流程、应答协议、收件行写法、四种载荷与七个探活结构；错误码 7 个（46601–46607）。相对路线图的取舍：`/health` 按 A42 保留，原“待确认”关闭；探活按 A42 不分配 operationId，路线图的键作登记键；`flow` 只回聚合值，明细端点建议补 `/internal/health/flow`；短信回执默认内联；微信支付回调补“同一事件再次到达时的内联重处理”（15:117）与 `bill_only` 重新归类（08:767）；退款回调补 `created` 竞态时先置 `processing`（08:662）与 `rf.poll` 的取消；`ci` / `asr` 唤醒加“只对 `submitted` 生效”的守卫 | A3、A38、A42、A49、A65、A70；C6、C47、C84；数据模型 15、08、06、13、02 |
| 2026-10-03 | 第二轮：① 新增 3.15 `hooks.internalHealth.flow.get`（`GET /internal/health/flow`，登记键）与结构 `FlowHealth`，接口数改为 15（V1.0 14）；五条探活在路线图标 `registryKeyOnly: true`，降级回 503、维护开关不拦探活。② 退款回调补 `refund_request`：`pending_execution` → `done`（08:529，A102），迁移加“本交易是申请当前的退款交易”守卫；申请结束时清除开票申请的 `held_by_refund_request_id`，开票申请自动驳回时写 `rejected_at`、`reject_kind` 并取消其 `sla.breach`；迟到成功一律开差异单（超额开 `refund_over`，否则 `status_mismatch`），回调金额不符开 `refund_amount_mismatch`；退款回调也有兜底写入 T1′。③ 新增 2.6：回调与入账函数实时开差异单的列取法与 `dedupe_key`（`{kind}:{out_trade_no}` / `{kind}:{out_refund_no}`），开单同事务刷新 `has_open_exception`；支付回调的 `status_mismatch` 分支不持 `payment_txn` 锁、先锁付款单再开单，符合锁序。④ 2.1 公共处理：内联行插入即 `processed`（不插 `received` 占位）；`dead` 行再次到达不处理；兜底写入写明 `attempts`、`dead` 推进；事件类型分“清单外不落行 / 清单内但非本端点记 `ignored`”两种。⑤ 金额不符或付款人不符取消付款单时同事务取消 `po.expire`。⑥ `webhook.received` 载荷改为 `{ v: 1, webhookEventId, provider }` 并带 `dedupe_key`（以 x01 为准）。⑦ 小程序原生客服消息被动回复 `transfer_customer_service`、不落库（新待确认第 3 项）。⑧ 电子签 V1.0 不挂载路由，删去“电子签 → `WEBHOOK_SOURCE_DISABLED`”。⑨ `FinanceHealth` 各指标显式可空，`null` 一律计入 `breaches`，“没有”用 0（`oldestBlockedFulfillmentSec` 由 null 改为 0）。⑩ 3.1 的事件以 x01 事件目录为准（不再以 m07 为准）；08 分组行号按插入 A102 行后的现行版本更新（530→531、531→532、662→663、665→666、666→667、668→669、701→702、759→760、762→763、766→767、1113→1114）。⑪ 第 6 节由 12 项收为 3 项：已裁决的关闭，作者默认转入正文；`hooks.ip` 引用 C68，清单删去 `proposedRateLimitTiers`、`proposedRoutes`。⑫ 路线图切片：`idempotentBy` 改为数组，探活补 `registryKeyOnly`，`transitions`、`tables`、`notes` 与清单对齐，新增 `h01.health.flow`。⑬（续，上一段修订中断后补完）⑫ 的切片改动此前没有落盘，本次按 ⑫ 改完：8 条回调的 `idempotentBy` 改为 `["uq_webhook_event_provider_event_id"]`；五条探活带 `registryKeyOnly: true`，删去“A38 未列，是否保留待确认”“operationId 暂挂（待确认）”等过时说法；新增 `h01.health.flow`（插在 `h01.health.finance` 之后）；各条 `transitions` 与清单逐条一致；`tables` 补齐（支付回调补 `grant_schedule`、`point_lot`、`biz_sequence`，退款回调补 `timer`、`biz_sequence`，资金探活补 `payment_exception`、`billing_account`、`invariant_run`、`invariant_violation`）；`sources` 的 08 行号按现行版本，补 A42、A83、A95、A102、A126；`notes` 去掉已裁决的“待确认”（短信默认内联、收件箱为备选；`ci` / `asr` 唤醒守卫；回调地址不支持查询参数时按 A126）。⑭ 清单与切片里退款回调的 `invoice_request.held_by_refund_request_id` 清除不是状态迁移，从 `transitions` 移入说明（正文 3.2 不变）。⑮ 3.9 引用的 x01 位置改为“第 8 节第 13 项的默认”（x01 第 4.5 节仍写待确认，已请 x01 改） | A49、A83、A95、A102、A119、A120、A126；C1、C27、C68、C72、C75、C84；两位复核员意见；xdoc-h01-hooks（a07、m07、x01 的请求与本文作者的路线图建议）；api-check 第 1 节；数据模型 08、15、01、13、06 |
