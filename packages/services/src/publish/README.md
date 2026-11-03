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

计划留桩分别见 `m1-publish-launch-reevaluate.md`、`m2-publish-notification-scenes.md`、`m7-publish-outbox-analytics.md`。上述接口与 DTO 以各自当前实现为准；W6-01 的使用期到期/顺延公开 writer 与 W6-03 巡检/账号健康见下文，下架确认/核查入口仍由 W6-04 交付，现有 M1 历史照常返回。

## 验证

`pnpm --filter @liyoxi/services exec vitest run src/publish/` 验真闸门、两连接绑定竞争、两人决定竞争、角色队列/本人工单/自审次序、任务粒度与重复调用、暂停/窗口/链接/集数、累计核验、历史/事件/引用、通知事实与九项真违规。

`pnpm exec vitest run --project api apps/api/test/publish.test.ts` 验 15 条真实 handler、店员七条拒绝、跨店隔离、决定版本/回显顺序、两种签名脱敏重放、只读 no-store、九种启用清单，以及 evidence 真实登记/确认/推广/签发的权限与范围。API 测试用 `APP_ENV=test`、公共本地连接和独立 `LYX_TEST_SESSION`；真实密钥由测试替身替代。

## M6 使用期公开writer（W6-01）

`ensureTakedownTasks(tx,deps,ctx,targets,{deliveryTicketId,now})` 与 `extendDeliveryPublishUsage(...)` 共用既有发布收尾内部writer。targets由 `readDeliveryPublishTargets` 读取，调用方先锁审批、订单/工单、账号、成片及发布/巡检/下架完整图，再在同一事务重读校验；不允许逆序补锁。首次创建须已交付且到T-30，依据取当前上线事实，同一账号仅一条未作废任务；它不结清上线任务或作废巡检。

顺延仅用于到期下架前，更新未核查日期、按原SLA快照重算已确认任务、作废尚未到新T-30的pending任务并取消旧overdue。原 `resyncDeliveryPublishExpiry` 保留人工版权纠偏用途（已回到in_service），不混为自动顺延入口。W6-04继续唯一拥有下架定时器、确认/核查接口及其真实触发归档验收。

## M6 巡检与账号健康（W6-03）

依据：`docs/plan/tasks/W6-03.md`、11 分组第 2.1、2.5、2.6 节、a06 第 3.1–3.4、3.20–3.27 节与 m05 第 3.4 节。本节记录实现边界和验收入口，测试结果以本包状态及实际运行证据为准。

### 资源与公开服务

本包拥有下列 12 条 API；HTTP 层沿既有认证、范围、幂等与响应契约调用服务，不另写业务状态。

| operationId | 用途 |
| --- | --- |
| `admin.patrolTask.create` | 手动创建，复用已存在的在办任务 |
| `admin.patrolTask.get` | 巡检详情、历史、证据和当前可操作性 |
| `admin.patrolTask.list` | 周期/跨周在办筛选与范围内分页 |
| `admin.patrolTask.summary` | 同筛选范围计数及周批次事实 |
| `admin.patrolTask.markNormal` | 按有效检查清单记录正常结论 |
| `admin.patrolTask.markAbnormal` | 记录异常类型、说明、截图与跟进定时器 |
| `admin.patrolTask.recover` | 复查恢复、追加新证据并关闭跟进 |
| `admin.patrolTask.remind` | 北京时间同日限频的异常催办 |
| `admin.channelAccount.list` | 账号健康列表；默认排除已解绑 |
| `admin.channelAccount.summary` | 账号状态计数；total 排除已解绑 |
| `admin.channelAccount.markAbnormal` | 可用账号人工标异常，保留原因 |
| `m.channelAccount.unbind` | 本店老板解绑，校验活跃引用并收尾在途核验 |

`createPublishPatrol(deps)` 从 publish 公口提供 `list/summary/get/create/decide/remind`；`decide` 的 normal、abnormal、recover 三种模式对应三条写 API。事务内 `followup/reconcile/reconcileTimers` 与周期任务 `weekly` 供正式运行时装配使用，不由应用直接查表替代。

账号列表与summary共用搜索条件：名称包含匹配，账号ID按原normalize后的accountUidNorm前缀匹配。巡检催办仅对abnormal状态开放；待检、正常或已恢复任务返回STATE_NOT_ALLOWED且不新增业务日志、事件或迁移。

`createChannelHealth(deps)` 提供 `list/summary/markAbnormal/unbind`。后台门店筛选与员工原 scope 取交集；指定 storeId 不覆盖原范围。解绑沿审批→账号锁序，经既有 approval 公开撤回入口关闭在途核验，活跃订单引用或未核查下架任务仍拒绝解绑。

W6-08 消费完整门店账号候选，W6-09 消费巡检、账号健康与商家解绑；页面与对应留桩仍由页面 owner 唯一交付。W6-04 消费巡检终态及现有发布收尾公口，本包不代做下架确认、核查或 R3。

### 异步、staff 与通知

本包的两项 x01 是 `patrol.weekly_generate` 与 `patrol.followup`，不增加新的任务种类。周任务沿登记的北京时间周一 09:00 执行，按真实已上线对象与原抽样优先级生成；同周重跑、手动/周生成竞争均复用批次与在办任务，批次总量和范围内任务计数分别读取。

异常登记三自然日后的跟进；恢复、作废取消原定时器。到点仍须锁内核对巡检状态、上线事实、使用期及当前门店交付经理，再经 staff 的 `createPatrolFollowUp` 写系统待办；重复执行不重复建待办，恢复/作废经 `closeSystemFollowUps` 同事务关闭。

巡检归属通过 `staffFollowUpPort` 的 `patrol_task` 事实供给，发布专员在办工作继续使用既有真实工单来源，不复制一套人员待办统计。

`patrolNoticeFact` 只读当前巡检、上线任务、订单项和工单事实。`patrol.abnormal` 与 `patrol.recovered` 使用已登记的 `m.patrol_abnormal` 场景，链接取实际 launchTaskId 的 `publish.task`；手动 `patrol_fix` 从真实 `manual_reminder.sent` 日志进入 M 节点。消费及外发前重验状态/版本，恢复、作废或使用期结束后旧异常催办失效。

运行时通过 `createPatrolAssembly` 为各实例绑定周任务、跟进和自愈调用；不使用全局可变业务实例。作用域 close 先拒绝新调用，再 drain 已接纳的 Promise；未绑定或已关闭的调用显式失败，两个实例互不接管对方处理器。

### 不变量、证据与配置

`publish.I14` 检查巡检归属及订单项/工单与上线任务一致，告警不修；`publish.I15` 检查已失效业务仍有在办巡检，经同一公开机制作废、撤 timer 和关闭系统跟进，保留自愈及告警证据。

`timers.I7` 在 timers 模块唯一登记为 P2/full/heal_only，由本运行时接入巡检贡献：补登记未到期异常任务缺失的 `patrol.followup`，取消其他状态的孤儿 timer。补登记使用原键与截止，不清除无关失败退避；本包只覆盖巡检贡献，不据此宣称其他业务主体的 I7 已完整实现。

`patrol_task/evidence` 登记保留 1095 天，`canRelease` 拒绝释放；该期限不是解除活跃引用或自动可删的许可。每次结论提交 1–9 张新截图，复查追加而不覆盖旧截图；恢复、作废和使用期结束保留原证据引用。详情只返回 fileId，签发沿既有媒体权限与审计入口。

`patrol_issue` 只播种字典类型，没有生产默认异常项。管理员通过 config 公开管理入口配置启用项；测试通过 `configAdmin.createDictItem` 建立唯一测试项并使用返回的 code，不把测试值写成生产缺省。

### 验收入口与证据边界

以下均是待按实际日志判定的命令与通过条件；在仓库根目录、Node 24、本地隔离测试连接和独立测试会话下串行执行，不扩大原时限或并发。

| 命令 | 判据 |
| --- | --- |
| `pnpm exec vitest run --project services packages/services/src/publish/patrol-m6.db.test.ts --maxWorkers=1 --no-file-parallelism` | 周生成/手动竞争、正常/异常/恢复、原证据、通知晚到、I7 修复与退避不变 |
| `pnpm exec vitest run --project services packages/services/src/publish/channel-health-m6.db.test.ts --maxWorkers=1 --no-file-parallelism` | 范围隔离、活跃引用、审批撤回/核验竞争及三日跟进真实写入和关闭 |
| `pnpm exec vitest run --project services packages/services/src/ops/patrol-runtime.db.test.ts --maxWorkers=1 --no-file-parallelism` | 真实认领/执行、实例隔离、关闭拒绝新调用、违规检出与自愈落库 |
| `pnpm exec vitest run --project api apps/api/test/patrol-accounts-m6.test.ts --maxWorkers=1 --no-file-parallelism` | 12 条实际挂载、scope/角色拒绝、GET 零写与幂等重放零重复 |
| `pnpm exec vitest run --project api apps/api/test/patrol-full-m6.test.ts --maxWorkers=1 --no-file-parallelism` | 沿实际主干 M1 二十集真实制作、QC、授权、推包、上线，追加真实 HTTP 巡检和证据提升，再执行全仓 full 零违规；原上传并发 4、含清理总时限 90 秒 |
| `pnpm exec vitest run --project services packages/services/src/notify/patrol-renewal.db.test.ts --maxWorkers=1 --no-file-parallelism` | 既有 R1 真实 producer→manual_reminder.sent→M 消息，重放/不合法日志/过期守卫 |
| `pnpm --filter @liyoxi/services typecheck`；`pnpm --filter @liyoxi/api typecheck`；`pnpm depcheck` | 类型与依赖层次无旁路 |
| `pnpm contract:check`；`pnpm registry:check`；`pnpm enums:check` | 本包契约与两项 x01 接线吻合，旧集合与冻结元数据保持 |

巡检测试从明确标注的历史待上线输入（pending_launch 边界，实际字段为订单/订单项 to_launch、工单 awaiting_launch）开始，再走真实账号/上线提交、核验与订单/工单推导。该夹具不能证明支付、生产、交付推包或全链已经通过，也不把人工测试 URL 当真实平台核验。

`patrol-full-m6.test.ts` 另从已合主干的 `createM1Support` / `runM1Chain` 完整链起步，在原 `afterChain` 入口通过真实 HTTP 创建巡检、登记并上传提升截图、提交正常结论；随后执行 runner 原有的不筛域 full 检查。它不使用上述历史待上线输入，不等待或消费未合并的 W6-02 代码；通过与否以实际运行日志为准。对象存储、媒体探测等外部供应商仍沿 M1 既有替身，截图与平台 URL 是虚构测试输入，不能计作真实云或人工平台外验。定点验收不替代 required 全量 CI、M6 合流或原真实外部验收。

本次本地首轮完整链1/1通过：二十集制作上线、巡检正常、全仓full143项零违规；含初始化和清理23.752秒（Vitest命令31.80秒）。日志与精确代码基线见[W6-03状态](../../../../docs/plan/status/W6-03.md)，该结果不替代未运行的远端CI或外部验收。
