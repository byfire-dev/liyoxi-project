# docs：协议与同意

协议的“当前版本”、协议清单与版本正文的读、同意记录的写入、待同意与指纹、已签署协议（W1-03）。依据：[m01](../../../../docs/api/m01-account.md) 第 2.5、2.7、2.9–2.11、3.12–3.16 节；[13 分组](../../../../docs/data-model/13-notify-docs.md) 第 2.10–2.12、5.2、5.4 节。W2-12 PR2 增加八条后台接口及本域两项任务，当前源码仍在开发验收；授权书的渲染与保留分支随 M5。

## 1. 这里有什么

| 文件 | 内容 |
| --- | --- |
| `service.ts` | `createDocs({ tx, clock, signPdf })`：装配入口；读取PDF需真实签名端口 |
| `versions.ts` | 当前版本的唯一解析口径 |
| `read.ts` | 协议清单、版本正文（两条公开接口的取数） |
| `consents.ts` | `assertConsents`：同意记录的唯一写入口 |
| `pending.ts` | 待同意的计算、两个指纹 |
| `signed.ts` | 已签署协议：老板、店员两种形状，计数 |
| `invariants.ts`、`transaction-invariant.ts`、`register.ts` | `docs.N4`、`docs.N13` 与 `docs.N5` 的查询及登记 |
| `seed.ts` | 六份协议的清单（W0-21，`pnpm db:seed`） |
| `demo-seed.ts` | 六份占位版本（演示种子；只进本地与预发） |
| `admin-context.ts`、`admin-read.ts`、`admin-write.ts` | 后台八接口：模块权限、脱敏查询、草稿与安排/撤回生命周期 |
| `ports.ts` | 本域文件权限、引用、正文准备和私有现签的纯依赖类型 |
| `jobs.ts`、`consent-digest.ts` | 到点簿记与前一北京时间自然日的只增证据摘要 |

## 2. 怎么用

```ts
const docs = runtime.docs; // api、worker 各自组合根已注入真实文件签名端口

await docs.listAgreements({ scene: "plan_purchase", limit: 20 }); // 用例函数：自己开事务
await docs.getAgreementVersion(agreementVersionId); // 草稿、已撤回、不存在都是 NOT_FOUND

// 别的域在自己的事务里
const current = await docs.currentVersions(tx); // 协议键 → 当前版本；报价、付款单要给端上版本 id 就取它
const result = await docs.assertConsents(tx, ctx, {
  scene: "order_submit",
  consents: [{ agreementVersionId }], // 交易接口只有版本 id，协议键由版本行补
  signer, // 手机号密文与脱敏串、称呼脱敏串、角色、appid 与 openid 的 HMAC：调用方带入
  entity: { entityId, entityName, usccEnc, usccMask, storeId },
  biz: { type: "drama_order", id: dramaOrderId, no: orderNo },
});
// result.consents[n].agreementConsentId 写进单据；result.complete、result.stamp 给 identity 写 consent_stamp
```

- **当前版本** = 同一协议在 `pending`、`active` 中 `effective_at <= now` 的最新一条，不看簿记列 `status`。全仓只有 `versions.ts` 这一处，别处一律调 `docs.currentVersions`，不要自己按 `status = 'active'` 取。
- **`assertConsents`**：每份协议一行，命中唯一索引返回已有记录（同一账号同一版本、同一单据只一条）。协议键与版本不一致、用户级场景里混进别的协议回 `VALIDATION_FAILED`；不是此刻的当前版本回 `AGREEMENT_VERSION_STALE`，`details` 带当前版本 id（交易接口只交版本 id，交成别的协议的版本也按过期处理）。`login`、`reconsent`、`member_join` 只收用户级协议、不带主体与单据；四个交易场景必带主体快照与单据（组合不对抛 `TypeError`，是调用方的代码缺陷）。同意方式不给即取协议清单上的（勾选或付款即同意）；`prior_consent` 由广告需求显式给。
- docs 不读身份表与主体表，也不写 `merchant_user.consent_stamp`：快照由调用方带入，指纹由 identity 写。
- **待同意**现算、只读：对每份用户级协议，本人有当前版本的同意记录即已同意；当前版本关了“需重新同意”且本人同意过更早的版本也算。
- **指纹**两个：`consentStamps(db).user`（用户级协议当前版本集合，协议同意中间件用）、`.all`（全部协议，引导数据用）。
- **已签署协议**一行一份协议。函数按观察者角色返回两种形状（店员的记录里没有 `bizType`、`bizNo`、`bizTitle`）；接口层最后一道裁剪在 W1-04。

## 3. 跑用例

```sh
pnpm --filter @liyoxi/services exec vitest run src/docs/
```

连真库，走带种子的测试库：要本地的 PostgreSQL 与 `DATABASE_URL`（`CLAUDE.md` 第 9 节）。

## 4. 已知的限度

- 版本正文通过注入的纯文件端口在事务外现签，并在签名前后读取真实可见性；未配置签名能力或文件不可用时受控失败，不返回空地址。新服务/API核心验收与原文书、种子、PII、不变量、公开API、权限矩阵和worker目标回归已通过，最终类型/门禁仍待收口；不把代码验收当作真实法律正文已交。
- 已签署协议里的 `bizTitle` 恒为 `null`：付款单的标题要经 billing 取，随 G4-C（留桩）。
- `docs.N5` 已随 W2-17 PR3 接入：`billingConsentFacts`、`orderConsentFacts`、`adConsentFacts` 经既有 keyed 通知事实端口返回单据/签署人/时刻/协议键。docs 仅读自身版本与只增同意表；缺登记报受控检查错误，不能反向查询三张上层表。默认 API/worker 用本运行时 Assembly 的 full 不变量闭包，污染可以真实报告，其他未配置发送通道不令 N5 恒真。
- `docs.N4` 的哈希一项只比“版本行的内容哈希”与“文件登记行上的哈希”，文件行没有哈希的不比；不读对象存储里的文件本身。
- API/worker 的 scoped 组合保留原 N5 闭包；N4/N13 应使用本次不变量运行的业务时刻，静态登记仅作为未装配时的原查询入口。
- 取不到来源 IP、请求号的同意记录写 `unknown`，不拦业务。

## 5. W2-12 PR2 的实现边界

后台四项写操作保留 required 幂等与原权限元数据。事务外prepare的失败只交给新执行的keyed回调，成功同键返回原DTO；update的当前状态/lockVersion守卫仍在原锁内执行，同键异载荷沿内核冲突规则。八条后台响应统一no-store。草稿以协议自然键串行，再锁版本与已排序文件行；正文 prepare 先取得真实 converter 容量才有界读 source/PDF，写事务重新验证当前归属、分类、状态、ETag、大小、哈希。转换成功不替代这次授权。`agreement_version` 是技术簿记，不新增 flow 或状态历史；安排与撤回通过现有 notices 公口在同一事务记录公告及原出站事件，提交后发出 agreement/site 缓存失效信号。法律可见性仍每次实时查库。

`ops/docs-files.ts` 是 L4 文件桥，只消费 media 的公开口；不增加 docs→media 白名单。私有签名不落幂等结果或数据库，商家正文响应为 no-store。默认双文件用于安排生效；PDF-only 可保存草稿并对有界完整字节求真实 SHA，Word/PDF 文本不一致只返回真实警告。正式法务文本和审批不会由转换自动补齐。

`docs.sweep` 每五分钟仅补 pending→active 与原 active→superseded、人数快照及审计；读路径到点即按唯一 currentVersions 解析。M5 授权书 queued 重投/渲染租约分支不在本包实现。摘要按前一北京时间自然日、seq 顺序、所有列求 SHA-256，secure 桶仅保存固定元数据且用 ifAbsent/内容身份防覆盖；次日重算。摘要不一致调用 evidence.consent_digest_mismatch（P1），对象不可读/写等能力故障调用 evidence.consent_digest_unavailable（P2），并使本次任务真实失败。告警事实落库沿已actual main的独立W224前置；实际API默认Assembly任务已验证P1-only摘要不一致与P2不可读取的真实alert_event行。调用替身仍只证明端口调用，不替代该组合根证据。

两项 job 与不变量索引使用当前 API/worker Assembly 副本，关闭只取消和等待本实例已接受的任务；不设置全局最后绑定。测试支撑 docs-admin.ts 只布置虚构员工/合法 stored 输入/草稿事实。正文验收实际构建并启动 PR1 converter 产物；已有转换字段的 lifecycle fixture 只证明业务状态与引用，不冒充真实处理、云对象存储或法务验收。
