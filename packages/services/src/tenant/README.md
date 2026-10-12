# tenant：主体、门店与成员关系

## 老板停用门店源码阶段

`archiveStore(ctx, { storeId }, { idem })` 使用原事务幂等，完整预锁账号、主体、邀请、成员与门店，
锁后重读候选全集、权限及六类真实阻断。私有同 Tx/ctx/目标见证只放行本次系统邀请撤回与店员级联；
全部 pending 邀请（含已过期未迁移）撤回并取消原 timer，清目标范围与最后选择，老板授权保留。
通知只对真实 store_archived 级联本人投影账号级安全告知；老板进入仍有效店，经理读真实归档事实。
I5 只查真实有效店员的启用门店，不自动修复。当前仅 SOURCE/轻静态，完整验证与正式审查未运行。
恢复、删除、新建、I30、其他移除原因通知及整包下游继续待交。

## 邀请卡片与到期源码阶段

四个正式入口 createInvitation、markInvitationShared、revokeInvitation、lookupInvitation 消费已合 invitation_request。
创建沿自然三段式：只读 claim、事务外备注检测、settle 完整预锁后重读；API 用真实当前会话 openid。
merchant_user80→entity100→排序 invitation110→排序 entity_member120→store130，不在高锁后补低锁。
A 创建、B 复用均永久绑定原卡；同键库 pending 回原 token/期限且零写，时间过期只由 lookup 派生；库终态拒绝。
新请求复用只延长未过期/未分享卡，保缺省与 null 区别；名额、上海日界与参数按真实事实现算。
分享/撤回沿原 required 幂等；撤回同 Tx 迁移/审计/事件、清令牌密文及取消 timer，映射保留。
invitation.expire 锁后 fresh clock 早到抛错走原重试；终态/不存在才 skipped，不增加 rearmAfterSkip。
复用遇 dispatched 先取消再 arm 同键，原任务 finish/fail 不影响新 scheduled；异常 fired/skipped 不假成功。
两个运行时各自 attach/close；当前仅 SOURCE，运行验证、官方生成、唯一300秒审查及合流待执行。
接受邀请、空草稿让位、joined 通知、I30 自愈与完整 W2-10 仍待后续；无 DDL/框架/门禁改动。

## 计费历史事实窄前置

`billingHistoryPort` 无 fallback，由 billing 登记 `readBillingHistoryFacts(tx, entityId)`。
调用方事务内的一条 SELECT 同时读取 subscription_term、billing_order 的两个 EXISTS；
全部历史状态、时间及金额均计入，不读取账户余额缓存、不取行锁、不写库、不依赖 Clock。
缺实现装配失败，读取异常不退为无历史。

两个 false 只说明该快照没有匹配历史，不证明主体存在、调用者有权限或可以放弃草稿。
完整 emptyDraft/abandon 仍须业务拥有者同事务复核主体、认证、成员、邀请及全部写侧并发保护；
本片不接放弃/邀请接受入口。当前仅 SOURCE 与轻检查，真实新旧目标、三消费者类型及唯一独审待授权。

## 成员列表与范围调整源码阶段

`listMembers(ctx)` 读取当前有效门店的成员；老板共用完整 MemberItem 映射，店员只返回五字段且不读计数、邀请与名额。`updateMember(ctx, { memberId, storeIds }, { idem })` 只允许老板调整本主体 active clerk，主体100→排序成员120→新旧范围及上下文店130，锁后完整复核再差集写关联；交集元数据保留，失去范围的 lastStoreId 清空。只写活动审计和 strict `entity_member.stores_changed`，无状态历史。

实际 API 组合根注入可选的 `readMemberAssetCounts` 与原 events；新老板用例缺装配明确 INTERNAL，旧用例和店员列表不受影响。计数批量复用同 Tx 的 media 公口，tenant 不导入 media、不查素材表或补无来源零值。范围无变化不新增审计/通知；只清理失去范围的旧选择。UUID 沿原小写 v7 校验，不扩大大小写规则。

本片新增两条既有 HTTP 和范围调整单事件通知，当前仅源码与轻静态准备；类型、真实 DB/API、官方生成及完整尾链待独占验证。其他成员事件、邀请、门店和后台入口及整包仍待交付。

`closeEntityIn(tx, deps, actor, input)` 是 W2-10 内部员工关闭入口；调用方拥有事务与幂等边界。必须从尚未取得业务锁的事务进入，真实 order prepare 先锁低序并完整锁住 tenant 图，六个所属计数、权限及回显复核后才关闭。邀请、有效成员（含老板）、启用门店通过 flow 写历史/审计/事件，再精准吊销 portal 授权及系统撤回 pending ad_cancel。任何失败整体回滚，其他取消 kind 异常拒绝。直接 flow 参数不能伪造级联 witness；profile 已接五事件异步消费者。

后台 `closeEntity(ctx, staff, input, { idem })` 在 required 缓存前读取真实启用超管与当前主体范围，复查原权限及 StepUp；写闭包直接复用 `closeEntityIn`，不提前拿业务锁，关闭后沿原四事实读取真实 `EntityCard`，任何摘要失败同事务回滚。只该命令要求 `entityClose: { assembly, timers }` 的完整真实装配，其他既有命令不受影响。严格请求原因去两端空白后按 Unicode 码点10–200字，双回显包含老板，不引入乐观锁。HTTP 接线当前仅 SOURCE，完整验证及唯一独审待 ROOT 安排；W2-10 整包与 `tenant.onEntitlementChanged` 仍进行中。

W1-03 交最小集：懒创建主体、成员关系解析、门店列表与额度、记住当前门店、给 profile 的三个写函数、计费账户端口。依据：[m02](../../../../docs/api/m02-tenant.md) 第 1、2.1–2.3、2.7、3.1、3.2、3.7 节；[02 分组](../../../../docs/data-model/02-identity-tenant.md) 第 2.9–2.12、5 节；D4 第 5.1 节。新增门店、停用与恢复、成员、邀请、空草稿让位、主体关闭、资质的 `change` 轮次随 M2。

## 1. 这里有什么

| 文件 | 内容 |
| --- | --- |
| `service.ts` | `createTenant({ tx, clock, flow, assembly })`：装配入口，给出下面全部函数 |
| `create-entity.ts` | 建主体的事务 |
| `membership.ts` | 成员关系解析 |
| `member-removal.ts` | 老板移除店员与店员本人退出：主体、成员锁后复核，原状态机及同事务关系清理 |
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
await tenant.removeMember(ctx, { memberId }, { idem }); // 老板移除本主体有效店员
await tenant.leaveMembership(ctx, { idem }); // 店员本人退出；老板拒绝

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

- 未交付的普通门店停用、恢复、主体放弃、成员加入及 `change` 轮次迁移继续拒绝；主体关闭沿既有关闭用例，普通成员移除与退出沿上述两个用例。`store.create` 的守卫仍只认建主体时的首家门店。
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

## 普通店员移除与退出（W2-10 独立切片）

`removeMember(ctx, { memberId }, { idem })` 与 `leaveMembership(ctx, { idem })` 共用原事务幂等。先持主体100，再按 id 排序持操作人与目标成员120；锁后重新确认主体存续、真实门店成员上下文、操作人权限及目标归属。只有有效 clerk 可以离开，owner 不走此入口。直接调用原 flow 的 remove/leave 行不能绕过用例守卫。

同事务写原成员迁移历史、活动审计和 `entity_member.removed`，清空目标 `entity_member.lastStoreId` 并删除全部 `store_member`。保留上传素材、协议同意、账号登录会话和老板下载页授权；成员权限由既有每请求查询立即失效。HTTP 主动退出成功后，即使原幂等键重放也先受原成员中间件约束。邀请接受和范围更新仍未交付，测试中的加入关系只是合法历史前提。本切片源码准备中，运行验证、唯一正式审查与本地合流尚待完成。

## 接受邀请与空草稿让位（SOURCE）

`acceptInvitation(ctx, input, { idem, principal })` 是唯一非事务 owner 入口：真实会话只读验证、事务外称呼检测、merchant80→完整排序主体100→邀请110→成员120→门店130，等待后重新读取时间和事实。私有 exact-Tx/context/phase 凭据只由该 settle 签发，不提供公共 abandon/prepare 或 caller 布尔权限。

空草稿只按未提交审核、无任何历史计费项、无其他有效成员、无任何 DB pending 邀请四事实判定；满足时同事务放弃主体、级联成员/门店、吊销原老板下载授权，再接受。required 幂等只存私有收据，每次返回当前有效成员；已移除不复活，合法当前 owner 角色可投影。真实邀请通知只发当前老板，持久化 `bizType=invitation` 决定后续读取分支；旧店员范围通知保持原语义。运行验证与独立审查尚未进行，真实送达未验。

## 邀请 I30 自愈（SOURCE）

I30 仅 full、P2、heal_and_alert，无周期限制；复用实例内 expiry 核心，不伪造 FiredTimer。原框架 now 固定严格一小时阈值，每批最多200；先完整排序主体100与邀请110，再核当前行与新鲜时钟。同事务迁移、清 token、审计、事件、取消 timer 和违规落库；自愈警报仍未解决。空主体范围不扩库，未绑定/关闭明确失败。当前仅源码准备，真实新旧整叶及独审待执行。

## 恢复老板停用门店（SOURCE）

`restoreStore(ctx, { storeId }, { idem })` 复用原事务幂等；账号80、主体100、当前成员120、排序上下文与目标门店130锁后，重新核有效老板、主体、门店及当前额度。只恢复 by_owner，清空五个归档随迁列，经原 flow 同事务写历史、活动审计与 store.restored，再取真实 StoreCard。

恢复不重建旧成员、范围、邀请、token、最后门店选择或下载授权；档案引用由原生命周期消费者后续处理。通知只认当前最后 lifecycle 历史与最新真实归档源，用同表 seq 与源 id 区分重复请求和固定时钟；同发生次时钟回拨保守不发。现有账号级安全投影和外发前重验保持，运行验证与唯一正式审查待执行。

### 草稿门店删除（SOURCE）

`deleteStore` 沿原幂等事务、完整归档锁图和六类在办阻断，再读取六项真实历史公口。
已提交资质及任一业务历史拒绝；原创素材仅计未删除且非复制，失败不写收据或级联。
私有 operation 见证联动原邀请/member/timer，另发 strict store.draft_deleted；档案仍由原订阅消费。
draft_deleted 归档/恢复均隐藏404；成员安全告知保留，经理仍仅 by_owner。完整验证待独占窗口。

## 建档首页成员摘要（SOURCE）

`readStoreMembersBrief(tx, { entityId, storeId, now })` 单 SQL 读取 scoped 成员、邀请与稳定三人预览。
称呼只取成员列；pending 只有 expiresAt>now 占额，不隐式修复、外呼或开启第二事务。
Profile 消费公开 Tenant 方法；无新 kernel 端口，原权限与成员写锁图保持。完整验证待授权。
## 分店创建（W2-10）

`Tenant.createStore` 使用 required 三段式幂等：外部阶段仅调用正式档案基础校验，写事务锁完整账号、主体、成员和来源/目标门店图后重读额度与真实会话。新店首次写入 active/non-primary/unsubmitted，复制来源与四项选择在档案首次 INSERT 固定；四项复制通过 API 固定绑定的真实 profile/media 拥有者完成。

同键成功重放返回原 StoreCard，进入缓存前仍重新核当前拥有者与会话。未装配 `storeCreation` 的旧构造入口只在调用此新方法时明确失败，不提供空档案或授权默认值。本片不提交资质、不实现门店删除，也不启用模型预算。SOURCE 与官方派生、业务及并发验收分阶段记录。

## 后台主体详情与成员列表（SOURCE）

`adminEntityGet`、`adminEntityMemberList` 先按真实员工范围读取主体，再用调用方事务组合事实。
API 固定绑定 billing/profile/media/order 公口；缺装配、缺账户或缺统计映射明确失败。
额度复用原唯一公式，邀请只取同一次 now 前尚未到期的 pending；GET 不推进或修复状态。
主体含正式兄弟门店概要；成员范围按真实关系，历史素材不因移除而丢失，账号仅投影脱敏字段。
订单仍逐店调用原计数公口；不宣称批量性能、全库单快照或后台写入口已实现。
当前仅 SOURCE，官方派生、类型、完整整叶及独立审查待独占窗口。

## 后台主体额度调整（SOURCE）

`updateEntityQuota` 在 required claim 前核真实当前员工及原授权/StepUp；首次写入按 staff20 共享锁、entity100 排他锁后重读版本、双回显及权限，并用新时钟授权。
省略覆盖保持原值，null 清除，成员0合法；允许低于已用量，不删除门店、成员或邀请。更新与版本递增、原同事务 Card 读取及一行额度审计一起提交，零出站事件。
同键返回原成功快照。入口只读预检不承诺原 claim 等待期间所有退出/角色变化全局线性化；不改会话或幂等框架。当前仅 SOURCE，官方派生、类型、完整整叶和唯一独审待授权。
