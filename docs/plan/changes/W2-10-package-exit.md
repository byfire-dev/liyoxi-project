# W2-10 整包退出核对

| 项 | 内容 |
| --- | --- |
| 改了什么 | 五个既有操作的真实 HTTP 测试分组名改为精确 operationId；成员 list/update 分为两组，原用例、断言与期限保持。回写 17 HTTP、2 项 x01、2 个已回补留桩的实际落点。 |
| 原因 | `infra/ci/landed.mjs` 只认 `*.test.ts` 中的 operationId 字面量；此前五项只有长标题或非测试样例中的名字，真实 HTTP 验收未被退出门禁识别。 |
| 影响的包 | 仅 API 四个既有测试文件及 W2-10 说明/状态；无生产逻辑、契约或门禁规则修改。 |
| 类别 | 原计划整包收口；任务书的单一 `tenant-m2.test.ts` 实际拆为各资源测试，沿用已接纳切片。 |
| PR | 本地 `codex/w2-10-package-exit`，基于已接纳 main `37f40575`；由 ROOT 独审与合流。 |
| 验证 | 作者仅做所属格式/ESLint；ROOT 执行 landed 与真正相关 HTTP 定点回归，再裁定整包退出。此前已接纳切片不重复全量；本记录不宣称远端 CI、真实云、生产容量或 W2-09 消费者完成。 |

## HTTP 交付落点

全部处理器已在 `apps/api/src/routes/index.ts` 的 `HANDLERS` 实际装配。
下表路由相对 `apps/api/src/routes/`，服务相对 `packages/services/src/tenant/`，HTTP 测试相对 `apps/api/test/`。

| operationId | 路由 → 服务 | 真实 HTTP 测试 |
| --- | --- | --- |
| `m.invitation.accept` | `invitations.ts` → `invitation-accept.ts` | `tenant-invitation-accept.test.ts` |
| `m.invitation.create`、`m.invitation.lookup`、`m.invitation.markShared`、`m.invitation.revoke` | `invitations.ts` → `invitations.ts` | `tenant-invitations.test.ts` |
| `m.me.membership.leave` | `me.ts` → `member-removal.ts` | `tenant-member-removal.test.ts` |
| `m.member.remove` | `members.ts` → `member-removal.ts` | `tenant-member-removal.test.ts` |
| `m.member.list`、`m.member.update` | `members.ts` → `member-management.ts` | `tenant-member-management.test.ts` |
| `m.store.archive` | `stores.ts` → `store-archive.ts` | `tenant-store-archive.test.ts` |
| `m.store.delete` | `stores.ts` → `store-archive.ts` | `tenant-store-delete.test.ts` |
| `m.store.create` | `stores.ts` → `store-create.ts` | `tenant-store-create.test.ts` |
| `m.store.restore` | `stores.ts` → `store-restore.ts` | `tenant-store-restore.test.ts` |
| `admin.entity.get`、`admin.entity.member.list` | `admin/entities.ts` → `admin-read.ts` | `admin-entities.test.ts` |
| `admin.entity.quota.update` | `admin/entity-quota.ts` → `admin-quota.ts` | `admin-entity-quota.test.ts` |
| `admin.entity.close` | `admin/entity-close.ts` → `admin-close.ts`、`entity-close.ts` | `admin-entity-close.test.ts` |

## 事件任务、留桩与同事务移交

以下路径相对 `packages/services/src/`。

| 项 | 实际实现与消费者 | 现有验证落点 |
| --- | --- | --- |
| `tenant.onEntitlementChanged` | `tenant/entitlement.ts`、`ops/tenant-entitlement-runtime.ts`；API `runtime.ts` 与 `ops/worker.ts` 各自 scoped attach/close | `ops/tenant-entitlement.db.test.ts`、`ops/tenant-entitlement.concurrency.test.ts` |
| `invitation.expire` | `tenant/invitation-expiry.ts`、`ops/invitation-runtime.ts`；两个运行时均绑定真实 handler | `ops/invitation-runtime.db.test.ts`、`tenant/invitation-i30.db.test.ts`、`ops/invitation-i30-runtime.db.test.ts` |
| `m2-order-store-quota`，已回补 | `tenant/quota.ts` 唯一公式，`order/checks.ts` 与 `order/quote.ts` 消费 | `order/quota.db.test.ts` |
| `m2-profile-overview-members`，已回补 | `tenant/profile-members.ts` 单 SQL；`profile/read.ts` 同 Tx、同 now 消费 | `ops/profile-members-overview.db.test.ts`、`apps/api/test/profile-members-overview.test.ts` |
| W2-09 callerTx 移交 | `Tenant.abandonDraftIn/removeMemberIn/revokeInvitationIn/closeEntityForOwnerDeletionIn` 已随 main `37f40575` 接纳；身份认证、五项休眠条件与账号清理归 W2-09 | `ops/tenant-account-lifecycle.db.test.ts`、`ops/tenant-account-lifecycle.concurrency.test.ts`；ROOT 已接受 59 项定点回归 |

本次只读核对未发现上述交付范围的其他生产核心缺口。整包状态暂保持进行中，待 ROOT 对本收口分支的门禁、定点验证和独审结果裁定；真实短信/多账号真机仍按原任务归 W2-22/W2-30 与业主清单。
