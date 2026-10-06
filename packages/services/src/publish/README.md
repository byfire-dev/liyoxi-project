# publish 最小集（W1-14）

依据：`docs/plan/tasks/W1-14.md` 第 2、7、10 节，`docs/data-model/11-publish.md` 第 2.1–2.4、3–5 节，m05 第 3.1–3.3、3.17–3.20 节与 a06 第 1.1、3.3、3.5–3.7、3.16–3.18 节。

本包实现 15 条 API、两台状态机的 8 行迁移和 7 种出站事件。账号与提交轮次、审批单、状态历史、审计和文件引用在同一事务内写入。GET 只读；主页截图在提交事务结束后现签，账号核验决定的幂等持久结果与重放结果移除签名地址。evidence 只返回 fileId，经原媒体后台接口按权限、门店范围签发，每次写 access 审计。

## 服务与下游移交

`createPublish(deps)` 返回账号、回填、核验与清单列表用例。依赖为事务运行器、注入时钟、装配、approval、flow 与 media 的 link/signRead；HTTP 处理器只负责解析契约并调用用例。根导出与模块 `index.ts` 保留同一公开入口。

| 公开项 | 用途与边界 |
| --- | --- |
| `createPublish(deps).createLaunchTasks(tx, ctx, input)` | W1-16a 在成片包推送事务内调用，input = `{ orderItemId, deliveryTicketId, channelAccountIds }`，返回每个去重账号的任务 id；同订单项 × 账号重调返回原 id，不新增轮次、历史或事件 |
| `createLaunchTasks(tx, deps, ctx, input)` | 同一功能的事务内函数，供已持有本域依赖的装配调用；不自行开事务 |
| `getLaunchFacts(tx, orderItemId)` | 当前非 void 任务的 `hasLive`、`hasVerifying`、已上线账号的最大核验集数 `liveEpisodeCount`、已上线账号的最早 `firstLaunchDate`，以及逐账号的核验事实 |
| `countPendingChannelAccountsByStore(tx, storeId)` | 本门店 `pending_verify` 账号数；M2 定义方接端口 |
| `launchChangedPort` | 回填、通过、退回后同一事务各调用一次，input = `{ orderItemId, deliveryTicketId }`；W1-16a 注册工单第 12–14 行求值，再经 delivery 自己的端口转交 W1-17 写订单项 |
| `launchHandlerPort` | 由 delivery 注册 `(tx, deliveryTicketId) => publisherId | null`，给 `launch_link.handlerOf` 读当前工单处理人；实现未到返回 null |
| `bindPublish(assembly)` | API/真实 worker 装配后绑定静态审批处理人读取；返回幂等解绑函数，多个作用域可乱序清理，未绑定调用报错 |

成片包推送的四项业务守卫属于 delivery。调用方须按 **订购单 160 → 订单项 170 → 工单 180 → 所选账号 190 → 成片包 210 → 上线任务 230** 加锁；在锁 210 之前先锁全部所选账号 190。本函数会重取这些已锁行，并校验订单项、工单、账号的归属与账号尚未解绑；已锁行重复请求不会重新取得较低层锁。推送后把 `deliveredAt` 和允许建任务的步骤写好，再调用本函数。账号已经被订单选用后发生人工异常不等于解绑，是否允许推送由 delivery 的守卫决定。

订购只选择 `available` 账号，每平台至多一个的约束归 W1-15。publish 在仓储只读 order/delivery 的必要列，不 import 它们，也不回写工单步骤、订单项阶段、usageStartDate 或 liveEpisodeCount。

绑定与重新提交调用实际主干 `profile.storeGate`：blocked 拒绝，parallel/full 放行。merchantFacts 的 publish 键提供账号数、需处理账号与任务待办数。账号核验为角色队列；上线核验按实际工单/门店范围读取，o 级写入再校验当前 publisherId。决定依次检查待审、自审、本人工单、版本、回显，再重算业务前提；失败整笔回滚。

## 读取与归档

链接支持合集和逐集同时填写，所选 linkKind 对应的主要链接必填，另一类若提供也完整校验和保存。回填集数、日期与 HTTPS 链接按当前锁内事实校验。部分上线取决定时的 `launch.partial_goes_live`，各轮核验累计保持最早上线日、首次 wentLiveAt 与满集 completedAt；退回保留此前上线事实。

账号与回填历史引用当时的字典编码和清单版本，停用字典不擦除历史名称。两类文件引用分别登记为 `channel_account_submission/screenshot`（365 天，解绑后可释放）与 `launch_submission/evidence`（1095 天，不释放），旧提交引用不因重新提交而释放。

清单读取只给 config 增加 `listChecklistTemplates`，原 active/version 缓存接口保持原语义。列表默认当前 active，allVersions 或非 active 筛选另验 `flow.checklist.manage`。merchant 的列表游标含排序键与筛选指纹，换门店或筛选拒绝复用。

## 登记与留桩

`register.ts` 登记两种审批 kind、两台状态机、两类文件引用、evidence 最小上传权限、merchantFacts、`channelAccountForNotify`/`launchTaskForNotify` 只读事实与 `publish.I1`–`I9`（full/P2/heal:none）。不变量从真实表检测；测试逐项制造可持久化违规，事务回滚后恢复零违规。

W0-17 实际通知契约是通知框架调用各域的只读事实端口；本域只登记真实读取，不同步发送通知。原 7 种领域事件及审批事件照常写 outbox。m05/x01 的 `publish_link_submit` 来源为 `launch.submitted` 的出站派生，M7 接统一消费者，不另直记一次。

计划留桩分别见 `m1-publish-launch-reevaluate.md`、`m2-publish-notification-scenes.md`、`m7-publish-outbox-analytics.md`。M5 的解绑、人工异常、撤销核验、巡检、任务作废/收尾和 M6 到期处理未开放；对应 DTO 的未来事实暂为 null/空数组，现有 M1 历史照常返回。

## 验证

`pnpm --filter @liyoxi/services exec vitest run src/publish/` 验真闸门、两连接绑定竞争、两人决定竞争、角色队列/本人工单/自审次序、任务粒度与重复调用、暂停/窗口/链接/集数、累计核验、历史/事件/引用、通知事实与九项真违规。

`pnpm exec vitest run --project api apps/api/test/publish.test.ts` 验 15 条真实 handler、店员七条拒绝、跨店隔离、决定版本/回显顺序、两种签名脱敏重放、只读 no-store、九种启用清单，以及 evidence 真实登记/确认/推广/签发的权限与范围。API 测试用 `APP_ENV=test`、公共本地连接和独立 `LYX_TEST_SESSION`；真实密钥由测试替身替代。
