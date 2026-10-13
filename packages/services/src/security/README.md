# security：字段加密、盲索引、敏感字段三件套

W2-24 的 `recordOffnetDenied` 在后台来源检查拒绝时独立记录匿名 `offnet_denied`
安全事实，不修改账号、失败次数或会话；数据库失败只记固定诊断，HTTP 仍拒绝访问。
API 在可信 `clientIp` 解析后、后台认证前应用 `ADMIN_IP_ALLOWLIST`；空配置不限制。

由 W0-14 交付。依据：[06](../../../../docs/06-data-model.md) 第 3.2 节；[01](../../../../docs/01-architecture.md) 第 10.2 节；ADR-025；D4 第 9.2、9.3 节；D7 第 7.5 节。回调验签与收件箱也归本模块，随 G2-0。

## 1. 这里有什么

| 文件 | 内容 |
| --- | --- |
| `keyring.ts` | 密钥环：`createKeyring`、`keyringFromEnv`、盲索引用途 `BIDX_PURPOSES`、`SecurityError` |
| `crypto.ts` | `encryptField`、`decryptField`、`kidOf` |
| `bidx.ts` | `blindIndex` 与两个归一化函数 |
| `pii.ts` | 三件套：`sealPhone`、`sealUscc`、`sealBankAccount`、`phoneBidx`、`usccBidx`、`openField` |
| `selfcheck.ts` | 启动自检 `selfCheck`、`loadKeyring` |

## 2. 用法

```ts
const keyring = security.loadKeyring(env); // 进程启动时一次：造密钥环并自检，不过即抛错（W0-22、W0-23 接）

// 写：仓储层把三件套各写进各的列
const phone = security.sealPhone(keyring, "merchant_user.phone_enc", input.phone);
await tx.merchantUser.create({
  data: { phoneEnc: phone.enc, phoneBidx: phone.bidx, phoneMask: phone.mask, phoneLast4: phone.last4 /* … */ },
});

// 查：按盲索引等值查，+86 写法与纯数字写法查到同一行
await tx.merchantUser.findUnique({ where: { phoneBidx: security.phoneBidx(keyring, input.phone) } });

// 解：只有 security 与各模块的仓储层调
security.openField(keyring, "merchant_user.phone_enc", row.phoneEnc);
```

- 密文：`v1:<kid>:<base64url(iv ‖ 密文 ‖ tag)>`，AES-256-GCM，随机 12 字节 IV，存 `text`。
- AAD 是密文所在的列，写成 `表名.列名`（带 `_enc` 后缀，如 `merchant_user.phone_enc`）：密文挪到别的列解不开。加密与解密要给同一个写法。
- 盲索引：`HMAC-SHA256(K[用途], 归一化(值))`，32 字节，存 `bytea`。手机号只留数字并去掉 `+86`；信用代码去空白、转大写。只支持等值查询与唯一约束。
- 入库的明文是归一化之后的；脱敏串调 `@liyoxi/shared/mask`。密文与盲索引不出接口（约定 C15），接口只给脱敏串。
- 明文里有不成对的代理项时拒绝加密（它过不了 UTF-8）。

## 3. 密钥

- 只经 `loadEnv` 读：`DATA_KEYS_FILE`、`BIDX_KEYS_FILE` 两项成组，任何环境都只认文件路径，给明文变量 `DATA_KEYS`、`BIDX_KEYS` 即失败。文件格式与生成方法见仓库根 `.env.example` 的注释。
- 两项都不配时 `loadEnv` 照常通过（不用密钥的脚本不受影响），`loadKeyring` 报 `keyring_missing`：要用密钥的进程起不来。
- 数据密钥轮换：往 `keys` 里加新 `kid`，把 `current` 改成它。新密文用新密钥，旧密文照样能解；逐行重加密完成之后才能把旧 `kid` 拿掉（拿掉后解旧密文报 `unknown_kid`）。重加密任务不在本包，`kidOf` 可以用来挑出还在用旧密钥的行。
- 盲索引密钥轮换要重算整列（加新列、双写、回填、切换、删旧列），只进运维手册，不做自动化。
- 新的盲索引用途：往 `BIDX_PURPOSES` 末尾加一项、在 `bidx.ts` 的 `NORMALIZE` 里写它的归一化，密钥文件里加同名的一项。各把密钥要互不相同。
- 测试用固定字节现造的假密钥（`__fixtures__/keys.ts`），不读任何文件。

## 4. 跑用例

```sh
pnpm --filter @liyoxi/services exec vitest run src/security/
LYX_FC_RUNS=5000 LYX_FC_SEED=42 pnpm --filter @liyoxi/services exec vitest run src/security/crypto.property.test.ts
```

`bidx.db.test.ts` 连真库（`merchant_user`），走测试支架：要本地的 PostgreSQL 与 `DATABASE_URL`（`CLAUDE.md` 第 9 节）。

## 5. 回调框架（W2-01）

公共入口是 `security.createWebhooks({ tx, clock, events, sources, alerts? })`。
两进程分别通过 `RuntimeOptions.webhookSources`、`WorkerServicesOptions.webhookSources` 注入同一来源契约。
`WebhookSource` 提供 `provider/mode/verify/payload/restore/handle/reply`；一个 provider 只登记一份，验签器用 `operationId` 区分其端点，未登记或未启用来源拒绝。
本包不挂真实业务 hook；后继包把 Provider 的公开验签结果映射进该接口，不能深引私有实现。

- `prepare(provider, request)` 在事务外消费复制的原始字节，框架拒绝超过1MiB与有时间戳时超过五分钟偏差。来源必须先验签再解析，不能改原文、把解密明文写进日志或把网络调用藏进 `restore/handle`。
- `verify` 的 `kind: reply` 只供 GET 地址校验；POST 产生 `event` 或 `error`。h01第2.1节允许的两类免收件成功须显式返回 `skip`，原因只能为 `unregistered_event/passive_reply`，且仍先验签/校验时间戳。不属于本端点的已登记事件走正常收件后返回 `ignored`。
- `accept(prepared, systemContext)` 只认本实例的私有验证快照。inline 插入即 `processed`，自然去重和领域处理同事务；处理返回 `ignored` 则同事务改为已忽略。失败整个事务回滚，不能用“查到行”代替重处理失败行。
- inbox 原子提交 `received` 与 `webhook.received { v:1, webhookEventId, provider }`，重复不再发出站事件。`security.onWebhookReceived` 在既有 subscriber Tx 中调用 `process(tx,id,ctx)`；域段保存点失败只回滚该段，外层提交受控 `WEBHOOK_HANDLER_FAILED`、次数和下次时间。外层最终失败则失败记录也回滚，不嵌套 `tx.run`。
- inbox 可选 `projectPayload(tx, verifiedEvent): Promise<WebhookPayload | null>`：在 `accept` 的同一事务内、收件插入与加锁之前作有界的本地只读投影，再原子写收件与出站。原必需的同步 `payload` 仍作事务前先验检查；先验非法不调用投影。没有新口的旧来源、inline 与支付兜底沿用原路径；inline 登记此口在构造时拒绝。
- 投影每次事务重试重新读取事实，接收独立复制的验签快照；返回值再复制并验证为非空的 JSON 对象，拒绝数组、循环、非有限数字与非 JSON 值。框架只验证形状，字段白名单、限量查询和去敏由来源负责；`null` 身份须放在对象字段内，不把原 openid 放进载荷。只读是来源契约，不是新的数据库权限代理；不得加业务行锁、写业务状态、另开事务或外呼，原事务/Provider guard 保持。
- 非法投影输出以固定 `WEBHOOK_PAYLOAD_INVALID` 应答，投影自身异常、SQL/提交失败或 guard 拒绝沿原 `WEBHOOK_PERSIST_FAILED`；不传出原错误或 cause。收件、出站任一失败整体回滚。重放可再次只读投影，但不得覆盖首次 payload、摘要/密文、digest、收件时间或重复出站；同事务不表示绑定一直到提交不变，后继业务处理仍须校验当前事实。
- `scan()` 由 `webhook_reprocess` 每分钟调用，按到期时间/id逐行独立事务、最多50条、`SKIP LOCKED`。缺来源或停用时保留可恢复行；1/5/15分钟、1/6小时退避，第8次 dead。支付第5次升级，其他来源可显式选 `escalateAfter:5`；告警只含 provider/attempts/id，当前端口为空实现，不声称真实通知。
- 只有 `wechatpay/inline` 可显式 `fallbackToInbox:true`。其 payload 必有完整 `resourceCipher` 和 `keyVersion` 才能在首事务失败后用新短事务落 `failed/inbox`；收件时间保留，下一次按实际失败时间加1分钟。其他来源无此成功兜底。CI/ASR 的 inline payload 必须为 null；其他 inbox 须有可恢复最小载荷。
- 微信支付保留 `summary` 与密文180天，其他有载荷来源90天。`security.webhook_payload` 经既有每日 `ops.retention` 做限量 UPDATE，仅留 summary或置空并写 purgedAt；不删行、不改摘要/digest/来源/原收件举证列。`restore` 在载荷过期后必须受控失败，不制造恢复数据。

`apps/api/src/http/webhook.ts` 的 `receiveWebhook` 是后继 hooks handler 薄口：一次既有IP限流后有界读原文/验签，再进入 OpenAPI解析；协议回包不带公共JSON信封，强制 no-store，429保留 RATE_LIMITED/retryAfterSec 与 Retry-After。自然幂等不落客户端 idem 行。维护拦截仍只归网关三组，不给 hooks 增加维护门禁；本包 API 用三组维护替身核此隔离，真实维护配置由后继环境/运维能力验证。

## 6. 回调目标验证

`pnpm exec vitest run --project services packages/services/src/security/webhooks/` 跑真实DB、100轮固定种子20261007模型、53条双扫描并发、实际提交时延迟约束/23505保存点/40001重试、8次死信及180/90天清理。
`pnpm exec vitest run --project api apps/api/test/webhook-framework.test.ts` 跑完整接收链；`pnpm exec vitest run --project worker apps/worker/test/webhook-reprocess.test.ts` 跑真实worker装配/消费/循环和等待在途后解绑。
所有来源/媒体/支付事实都是显式本地替身；真平台地址、密钥、解密适配与业务处理由接收方另验。

`pnpm --filter @liyoxi/services exec vitest run src/security/webhooks/projection.db.test.ts` 验证新口：真实 `txid_current()`、prepare 后事实变化、零 DML 拒绝、40001 前后两种故障、真实 COMMIT 回滚、双连接20次去重和事务外呼 guard。合成身份使用测试事实，不能代替 W2-21 的真实身份投影或微信回调验收；W2-21 须在本修复实际合入本地 main 后才消费此公口。

## 7. 专用明文查看（W2-04）

`createPiiReveal({ db, tx, clock, keyring, facts, alerts })` 提供 `reveal(ctx, actor, meta, body)`，只接受契约登记的11类 subjectType / 20种字段组合。权限、员工电话的 system 查看权、再验证和真实范围事实均先在事务外校验；范围外和缺失统一404。随后独立 `tx.run(audit.record)` 提交 access，再在事务外解密指定字段。审计失败即不解密，解密失败仍保留已提交审计；在已有 TX 里调用直接拒绝。响应只有 value/field/auditLogId，API no-store，既无幂等结果也不把 value 写进日志、指标或告警。

定位由 kernel 的 `security.pii_fields` 只读端口分派到 identity/profile/staff/docs/billing/support 自有事实提供者。端口 scope 为 opaque unknown，来源模块经既有 WeakSet 品牌 `assertIssuedScope` 恢复，伪造对象不能调用范围谓词。资格材料依据真实 scope 列：主体共享营业执照走 entityScope，门店许可证走 storeScope。财务/客服等未来业务没有合法记录或范围事实时404，未提供假业务完成事实。

审计 action 按实际密文列去掉 `_enc`，例如 `pii.contact_phone.reveal`，保持既有 snake_case 校验。agreement_consent 的生产 `docs.assertConsents` 原样复制账号 phoneEnc、主体 usccEnc；此只读用例分别按原始 merchant_user.phone_enc / entity.uscc_enc AAD 解密，授权仍使用同意记录所属主体范围。这是现有生产快照的兼容读，不改变加密或同意写侧。`docs/pii-fields.db.test.ts` 经过真实写入口验证两种来源密文，启动审计目标自检包含 agreement_consent。

超额接口保留既有小时/日及全局限额：只有 PII 专用档位触发才带 `{ window, limit }`，Redis 降级返回实际减半额度。`raiseLimit(staffId, window, limit)` 尝试通过 alerts 端口上报 `pii.reveal_limit`，维度仅员工 id，告警失败不能替换429或丢失 Retry-After。当前 alertsOf 未配置持久实现，因此此包不声称告警已持久送达；后续由 W2-24 接入。

`pii-reveal.db.test.ts` 覆盖真实 own/group/all、独立提交顺序、审计/解密故障、可空/JSON字段、嵌套拒绝；`apps/api/test/system-security.test.ts` 验证真实 HTTP 权限、再验证、限流与审计失败500零泄露。

## 8. 小程序安全消息来源（W2-21）

`createWechatMessageSource({cryptoConfig,findWechatIdentityId,handleImage?,handleSubscription?,logger?})` 固定为 `wechat/inbox`，由组合根登记。配置和加密只使用 security 同模块 crypto；身份与领域处理通过传入 Tx 的函数注入，不向上 import identity/media/notify。

- `verify` 使用 `decryptPostDetailed` 的原始明文 SHA256，图片事件另取 `sha256("wxa_media_check:"+traceId)`。GET 原文 echo、四种客服固定加密转接及未知消息均不入箱；签名/时间/AppID 错误401，登记事件必需字段坏400，解密与持久化错误500，错误包体为空。
- 同步 `payload` 提供合法去敏模板，`projectPayload` 在 accept 同一真实 Tx 按 appid/openid 读取身份，只保存 UUID 或 null；不保存原 openid、明文全文或任意扩展。查无身份的订阅事件整体 ignored；领域 handler 未装配时保留 failed/retry。
- 项目防御界限：List 最多100项，标识256 UTF8字节，状态/码64字节、ErrorStatus256字节；这些不是平台最大值或 HTTP 流入口限量。官方 singleton List 仅在 wire 转成单项数组，restore 仍要求严格数组。正式 optional 字符串可缺省或为空，不造默认成功；有限 safe integer 转十进制，64位 MsgID 字符串原样保存，不安全数字拒绝。
- 官方 errcode 仅数字0时 result有效；wire若提供非0/非数字码，回400且零入箱，缺省仍沿h01不抬必需。payload不保存errcode。
- 审核 suggest 保存微信原生 `pass/review/risky`，媒体领域负责 risky→block；恢复只接受正式白名单字段。handler 收到的 receivedAt 来自已锁收件行的一次自身 select，处理重试不会改为当前时间。sent 回执、quota、图片任务/文件上下文由领域用例负责，来源不写跨域状态或补发。
- 未登记消息只通过 optional logger 记录固定 kind/count；不记录客户端事件名、用户/正文。

[官方安全模式与回复封装](https://developers.weixin.qq.com/miniprogram/dev/framework/server-ability/message-push.html)、[客服四类请求](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/customer-message/receive.html)、[订阅事件与单项 List](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message.html) 与[官方图片回调结果有效性](https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_mediacheckasync.html) 于2026-10-08取得公开 HTTP200正文。客服转接行为遵循正式 h01 §3.4；实际平台接收与运营客服配置继续未验，不以本地加密回复等同真实平台闭环。

`wechat-message.test.ts` 使用独立 node:crypto 打包的假安全请求及隔离真库，验证同 Tx 投影/emit、零敏感载荷、20次去重、40001新事务重查、解绑重绑重放保真、持久接收时间、保存点回滚、未配处理器与正式 Provider TX guard。测试注入真实自然键读取，完整组合根另用 identity 公开函数验接线。此叶不标两 HTTP、一回调 x01、三桩或整包完成。

## 9. CI 媒体只唤醒来源（W3-03）

`createCiWebhookSource({key,wake})` 经既有 W2-01 inline 模式：query.sig 只验 HMAC-SHA256(path.mediaJobId) 的规范 base64url，实际公共 adapter 传可选 path params，其余框架不变。JSON 只抽一个 JobsDetail 中的安全 JobId（官方数组最多 1，也接受单对象）；XML 只抽 Response/JobsDetail/JobId，拒 DTD/实体扩展/属性/重复标量。raw 体最多 64KiB、深度 32 为来源防御界限，入口仍原 1MiB 逐 chunk 限制，不宣传 64KiB 流入口机制。eventId=mediaJobId:JobId，payload=null，不入库任意云状态或原正文。

处理函数在原收件事务内调用注入 media.wakeCiJob：仅 submitted 且外部号相符提前 nextRunAt，其余 ignored；ACK 之后队列只加速，查询结果仍是真实事实。签错 401、坏 JobId 400、未配或持久失败 500 均空正文；DB 故障与收件整体回滚，不能重放伪 success。本包没有真实云收到回调的结论。
