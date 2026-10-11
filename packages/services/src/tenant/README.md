# tenant：主体、门店与成员关系

W1-03 交最小集：懒创建主体、成员关系解析、门店列表与额度、记住当前门店、给 profile 的三个写函数、计费账户端口。依据：[m02](../../../../docs/api/m02-tenant.md) 第 1、2.1–2.3、2.7、3.1、3.2、3.7 节；[02 分组](../../../../docs/data-model/02-identity-tenant.md) 第 2.9–2.12、5 节；D4 第 5.1 节。新增门店、停用与恢复、成员、邀请、空草稿让位、主体关闭、资质的 `change` 轮次随 M2。

## 1. 这里有什么

| 文件 | 内容 |
| --- | --- |
| `service.ts` | `createTenant({ tx, clock, flow, assembly })`：装配入口，给出下面全部函数 |
| `create-entity.ts` | 建主体的事务 |
| `membership.ts` | 成员关系解析 |
| `quota.ts` | 额度与名额的唯一口径 |
| `stores.ts` | 门店列表、记住当前门店 |
| `qualification.ts` | 给 profile 的三个写函数 |
| `machines.ts` | 五条状态链的登记：随迁列、活动流默认描述、本包十行迁移的守卫 |
| `ports.ts` | 计费账户端口（billing）与精准下载页授权吊销端口（identity） |
| `invariants.ts`、`register.ts` | `tenant.I1`、`I7`、`I27`、`I29` 与本模块的登记 |
| `repo.ts` | 本模块的查询 |

## 2. 怎么用

```ts
const tenant = createTenant({ tx, clock, flow, assembly }); // api、worker 启动时各建一次，createFlow 之后

// 用例函数：自己开事务
const result = await tenant.createEntity(ctx, { idem }); // 操作人须是商家用户
const list = await tenant.listStores({ merchantUserId }); // viewerRole：owner、clerk、none
await tenant.rememberCurrentStore({ merchantUserId, storeId }, { idem });

// 在调用方的事务里
const membership = await tenant.resolveMembership(tx, { merchantUserId, storeId }); // 进不去即 null
const usage = await tenant.getQuotaUsage(tx, entityId);
await tenant.setStoreName(tx, ctx, { storeId, name });
await tenant.setStoreQualification(tx, ctx, { storeId, round: "initial", action: "submit" });
await tenant.setDeliveryManager(tx, ctx, { storeId, staffId });
```

- **建主体**：一个事务里建主体、首店、老板成员关系各一行，三条迁移经 `flow.transition()`，发 `entity.created`、`store.created`，经端口建计费账户。已是老板返回已有主体（`isNew = false`）；别家的有效店员抛 `ALREADY_IN_ENTITY`，`details.storeName` 是他所在的门店。先锁账号行（80），同一账号的并发请求在这里排队；撞 `uq_entity_member_one_entity` 只作兜底。
- **成员关系解析**：老板能进本主体启用中的门店；自己停用的（`by_owner`）给收尾上下文（`storeMode = "archived"`）；草稿删除的、随主体停用的进不去。店员只能进 `store_member` 里的门店。主体不是 `active`、门店不存在都按进不去。403 的两个码由门店上下文中间件回（W1-04）。
- **额度**读时现算、不落库：主体上的覆盖值优先；否则订阅生效取套餐的上限，未开通或已过期取参数 `tenant.default_store_limit`、`tenant.default_member_limit`。订阅的事实经事实端口的 `billing` 键取，没人注册即“未开通”。
- **门店列表**：tenant 自己的字段做全；城市、品类、审核时间、完整度、上线中与交付中、待办数、素材数、当前套餐经事实端口取（[kernel/ports](../kernel/ports/README.md)），对应的模块没注册时是 0 或 `null`。按观察者角色返回两种形状，接口层最后一道裁剪在 W1-04。
- **三个写函数**（profile 调）：`setStoreQualification` 只做 `initial` 轮次的提交、通过、驳回、撤回，门店与主体两条链同事务各写一行状态历史；通过时主体的认证字段（名称、类型、信用代码三件套、法定代表人）由调用方做好传入；出站事件由 profile 发。`setStoreName` 只在资质未提交或被驳回时可改。`setDeliveryManager` 写一条 `ops` 审计。加锁：主体（100）→ 门店（130）。
- 通过时两个主体的信用代码撞了唯一索引 `uq_entity_uscc_bidx_verified`：数据库报唯一冲突，事务中止。调用方要接它就把这一步包在 `savepoint` 里，用 `isUniqueViolation` 认。

## 3. 计费账户端口

`billingAccountPort`（`ports.ts`）由 tenant 定义、billing 实现，建主体的事务里调一次。没有默认实现：没人实现就装配失败。实现在 `billing/ports.ts`（W1-11a 起）：建 `billing_account` 行并锁住它，时间取主体行的 `created_at`。测试里换实现：`assembleForTest({ withoutRealPorts: [billingAccountPort], extra: [样例登记] })`。

## 4. 跑用例

```sh
pnpm --filter @liyoxi/services exec vitest run src/tenant/
```

连真库，走带种子的测试库：要本地的 PostgreSQL 与 `DATABASE_URL`（`CLAUDE.md` 第 9 节）。

## 5. 已知的限度

- 没登记守卫的迁移行（门店停用与恢复、主体放弃与关闭、成员加入与移除、`change` 轮次）迁移即抛 `FlowError`，随 M2 补。`store.create` 的守卫现在只认建主体时的首家门店。
- 门店卡的 `actions` 只按“是不是最后一家启用中的门店、有没有提交过资质”给；有没有业务数据、在办事项的判断在停用与删除的接口里（M2）。
- 撤回回到“提交前的值”取自本链的状态历史（最近一次进入 `pending` 的那一行）。
- 资质撤回的守卫只认“操作人是系统”；主体关闭或放弃的联动随 M2 接上时再核对触发条件。

## 6. 精准下载页授权吊销前置（W2-10 PR1）

`membershipAuthorizationsPort` 的名字是 `tenant.membership_authorizations`，无默认实现；identity 登记 `MembershipAuthorizations`，api/worker 的既有组合根自动收集。缺实现即装配失败，不能当作零授权。依据 [02 分组第 5 节](../../../../docs/data-model/02-identity-tenant.md)；不新增 tenant→identity 同步调用。

调用方先用公开 `lockRows` 按顺序持主体及相关成员锁，再在同一事务调用 `assembly.port(membershipAuthorizationsPort).revokePortalGrants(tx, input)`。`input` 为 `{ scope: "entity", entityId, now }` 或 `{ scope: "owner", entityId, merchantUserId, now }`；`now` 来自调用方业务时钟，返回本次实际撤销数。

只改该主体中尚未撤销的 portal_session；owner 范围再限定原授权人。已过期但未撤销的行仍计入，旧撤销证据不覆盖。不动商家登录会话、票据或授权归属。by_owner 门店归档仍允许老板下载，不由此触发全老板授权吊销。PR1 没接成员移除/主体关闭入口；17 接口主包和 M6 票据 producer 后续交付。

`pnpm exec vitest run --project services packages/services/src/identity/portal-grants.db.test.ts packages/services/src/tenant/portal-grants.test.ts` 验证真实隔离、回滚、两连接重复计数、伴随表零变化和 api/worker 强制装配。

## W2-10 关闭事实必需端口窄前置

`CLOSE_FACTS_PORTS` 声明 billing/order/delivery/publish/profile/ad 六个固定无fallback单实现端口，各所属域注册已验证的公开只读计数函数。缺少任一实现时 API 与 worker 均拒绝装配，不能按无业务返回零。复用既有 definePort/implement，不增加内核机制或跨层反调。

调用方在持主体、门店锁的同一事务使用 `readStoreCloseCounts(tx, assembly, storeId)` 取 m02 六类停用计数，或 `readEntityDeletionCounts(tx, assembly, entityId)` 取 m01/a03 共用六类注销/关闭计数。来源失败原样传播；不另开事务、不写库、不读上层内部表，不提前声称生命周期写侧/取消审批已交付。

W2-10 的 `assertWithinQuota` 复用现有额度口径与调用方事务，只在门店超额时返回 `QUOTA_EXCEEDED` 及真实三个数字；成员超额不拦已有订剧。order 报价与提交（含 hold 后复核）消费同一公开判定。新增真实DB6项与原submit/quote/tenant20项同轮26G，services类型和依赖检查通过；唯一独审和合流待执行，完整生命周期仍开发中。

## 主体关闭的广告取消伴随

`entityAdCancelClosePort` 由 order 唯一实现，无默认实现。调用方在任何 tenant 锁或高序锁之前，以真实同一 Tx 调 `prepare(tx, entityId, actorStaffIds)`；它整体预锁员工20、审批30、取消50/明细60，再锁主体100、所有邀请110、成员120、门店130。调用方员工须并入低序 union，每个事务只准备一个主体。

在同一事务履行 tenant 自身关闭联动后，调用 `withdraw(tx, ctx, plan)`。只有真实 entity.closed/closedAt、同 Tx 原计划和完整候选/归属/广告指针/绑定图一致才整体锁广告150、订单160、订单项170及精确 timer，随后走真实广告取消系统撤回与原审批/业务回调。候选或图改变整笔拒绝重试，不补低序锁；缺写侧运行时依赖明确 INTERNAL。

仅收尾 pending_approval 的 ad_cancel，保留 approved 待执行及历史；积分和广告生产 timer 不动。该口不是 tenant 关闭入口，open_order 和其他取消 kind、完整主体/邀请/成员/门店关闭及 HTTP 仍未交付。
