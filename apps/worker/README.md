# apps/worker：任务进程

邀请到期由本实例 createInvitationAssembly 绑定真实 tenant handler，两个 worker 不共享闭包。
invitation.expire 锁后读当前期限，早到走原 retry/backoff，无 maxLateMinutes 或 rearmAfterSkip。
关停先排空 timer 消费者，再 closeInvitations；启动自检失败及 --check 也关闭本实例绑定。
当前本片 SOURCE 尚待完整运行验证与合流，不代表邀请接受或完整 W2-10 完成。

出站事件的中继与派发、定时器扫描、周期任务补登记、两个队列的消费（W0-23）。依据：[x01](../../docs/api/x01-events-jobs.md) 第 4.3、4.4 节；[01](../../docs/01-architecture.md) 第 7.3、7.4 节；D7 第 7.6 节。

这里只有调度：循环、租约与看门狗、队列装配、信号处理。认领、执行、失败处理都在 `@liyoxi/services`（`events`、`timers`、`ops`、`kernel/queue`）。

## 1. 这里有什么

| 文件 | 内容 |
| --- | --- |
| `src/index.ts` | 入口：装配 → 自检 → 抢租约；`--check` 只做装配与自检 |
| `src/runtime.ts` | 四个循环、两个队列的消费者、成为主与降级、关停的顺序。节奏与并发是这里的常量 |
| `src/lease.ts` | 续约循环与看门狗 |
| `src/loop.ts` | 进程内循环：一轮一轮地跑，上一轮没完不起下一轮 |
| `src/recurring.ts` | 周期任务的汇总入口：把本环境生效的汇成一张表。任务登记在各模块的 `register.ts` |
| `src/log.ts` | 一行一条 JSON 的日志口 |
| `src/cli/redis-compat.ts` | 托管 Redis 与队列库的兼容脚本（验证项 V1） |
| `src/cli/seed.ts`、`seed-command.ts` | 播种的镜像内入口（W1-22）：与 `pnpm db:seed` 做同一件事、同一组退出码，只是不靠 `tsx`，server 镜像里跑得了 |
| `src/cli/alerts-ack.ts`、`alerts-ack-command.ts` | W2-23 受限人工运维：真实在职员工权限、单条告警认领/关闭或死回调复位、同事务原因审计 |
| `scripts/build.mjs` | 构建：esbuild 把工作区的包与第三方依赖打成 `dist/index.js`、`dist/redis-compat.js`、`dist/seed.js`，只留 `bullmq`、`ioredis` 在外 |
| `src/domain-loops.ts`、`src/loops/` | 各域的进程内循环（M1 起）：一个循环一个文件，清单里加一行；`runtime.ts` 把它们与 M0 的四个循环一起起停、一起交给看门狗（W1-10） |

## 2. 怎么跑

```sh
pnpm --filter @liyoxi/worker build
node apps/worker/dist/index.js --check   # 只做装配与自检，通过即 0 退出；缺必填变量非 0 退出
node apps/worker/dist/index.js           # 起任务进程
node apps/worker/dist/seed.js            # 播种：库要先跑完迁移；可反复跑。整套本地环境与预发的节点步骤用它
```

W2-23 人工入口构建为 `dist/alerts-ack.js`，三种形式如下（UUID 替换为实际员工和单条对象）：

```sh
node apps/worker/dist/alerts-ack.js ack --staff <员工UUID> --alert-id <告警UUID> --note <原因>
node apps/worker/dist/alerts-ack.js close --staff <员工UUID> --alert-id <告警UUID> --note <原因>
node apps/worker/dist/alerts-ack.js reset-webhook --staff <员工UUID> --webhook-event-id <死回调UUID> --note <原因>
```

原因必填 5–200 字。`ack`/`close` 查真实 `sys.health.manage`，`reset-webhook` 查真实 `flow.ops.manage`；员工必须 active，不造登录会话或二次验证时间。仅操作显式单条对象，状态不允许时拒绝，不重发回调事件。成功只输出命令、对象 ID、状态，退出 0；参数、取消或业务拒绝退出 1，环境或运行故障退出 2。等待已开始的原子事务结果并关闭连接，审计记录员工、CLI 来路和原因。

W2-18 单月修复入口构建为 `dist/analytics-repartition.js`：

```sh
node apps/worker/dist/analytics-repartition.js YYYY-MM --env test --staff <员工UUID> --note <原因>
```

月份只接受单个 `YYYY-MM`；显式环境须与 `APP_ENV` 相同，实际 active 员工须有 `sys.super_admin`，原因 5–200 字。只允许当前正式保留窗口及未来三个月，使用应用角色调用受限数据库函数，同事务记录月份自然键、员工和原因审计。成功输出月份与搬移行数、退出 0；输入/权限/取消拒绝退出 1，环境/执行/关闭故障退出 2。非法参数在装配前拒绝，进入的原子事务等待真实结果，最终关闭自身资源。

环境变量只经 `loadEnv` 读（`APP_ENV`、`DATABASE_URL`、`REDIS_URL`、`LOG_LEVEL`，取值见 `CLAUDE.md` 第 9 节）。自检要连一个跑过迁移的库：本地用 `lyx_migrate_check`（只读它的系统目录）。

| 循环 | 节奏 | 队列 | 并发 |
| --- | --- | --- | --- |
| 出站中继 `outbox_relay` | 每秒 | 出站投递 `outbox_delivery` | 4 |
| 出站派发 `outbox_dispatch` | 每秒 | 定时器执行 `timer_run` | 4 |
| 定时器扫描 `timer_scan` | 每 20 秒 | | |
| 周期补登记 `ensure_recurring` | 每 60 秒 | | |
| 账务推进 `billing_advance`（W1-10） | 每 60 秒 | | |
| 媒体事实 `media_job_run`（W3-03） | 每15秒/最多20行 | `media_job` | 10（实际local2/remote8） |
| 通知投递 `notify_scan`（W2-17） | 每 5 秒 | 通知 `notify` | 4 |

- 一主一热备：谁持有 `worker_lease` 那一行谁干活。每 10 秒续约（专用连接）；持有者 30 秒没续约可被接任。
- 看门狗每秒看一眼，只读本地变量：续约超过 20 秒没成功即降级（停循环、消费者不再领新任务）；自己晚到 10 秒以上、或某个循环连续两个周期没有进展（不少于 60 秒）即退出进程，由外面拉起。
- 收到 SIGTERM：停循环与新领取 → 媒体owned任务先等最多45秒后取消并等待清理，其它消费者沿原30秒预算 → 让出租约 → 关闭本次驱动；借用DB/队列由父装配关闭。
- Redis 不可用时循环照跑：关键类在进程内执行，非关键类放回去，连续不可用满 60 秒后也在进程内执行。

### 独立审批时限装配（W2-27 前置）

只调用 `buildWorkerServices` 即可处理真实 `calendar.imported`：审批与员工两个订阅者分别同事务写业务和 delivery.done，不需要先建 API runtime。ops 固定包装为审批注入本实例依赖和真实类型 map，保留唯一 `sla.breach` 的员工/交付委派。

正常 stop 等循环和队列消费者关闭后调用 `closeApproval()`；入口的自检失败及 `--check` 成功两条退出路径也释放。关闭一个实例不会切换到另一个实例的审批绑定。连库用例见 services 的 `ops/approval-sla-runtime.db.test.ts`，实际队列关闭顺序用例见 `test/approval-sla-close.test.ts`。这只完成环境演练前的 owner 代码前置，W2-27 日志与接线整包另行验收。
- 租约只是减少重复劳动：两个实例同时干活也不出错（认领用 `SKIP LOCKED`，消费按派发序号认）。

## 3. 跑用例

```sh
pnpm --filter @liyoxi/worker test                                             # 全部
pnpm --filter @liyoxi/worker exec vitest run test/fault/redis-flush.test.ts   # 单个
```

要本地的 PostgreSQL 与 Redis（`pnpm infra:up`）与连接参数。用例走测试支架：自己建 `lyx_test_worker_` 开头的库，Redis 只用自己的键前缀，“清空 Redis”只清这个前缀，“Redis 不可用”在客户端一侧造。

| 文件 | 验什么 |
| --- | --- |
| `test/fault/redelivery.test.ts` | 重复投递：租约过期重派、队列重复送达，副作用 1 次 |
| `test/fault/crash.test.ts` | 进程中断：认领并入队后被 SIGKILL，租约到期后由另一个实例完成 |
| `test/fault/redis-flush.test.ts` | 清空 Redis：worker 不重启，在途任务在租约到期后继续，下一格周期任务照常 |
| `test/fault/dual-worker.test.ts` | 两个实例绕过租约同时跑：不重不漏 |
| `test/fault/redis-down.test.ts` | Redis 不可用时的三条出路 |
| `test/lease.test.ts` | 抢租约、接任、自行降级、让出；看门狗的三条规则 |
| `test/recurring.test.ts` | 补登记循环；只在预发登记的任务在生产配置下不存在 |
| `test/seed-cli.test.ts` | 播种命令：退出码、可重复跑、不打印连接串 |
| `test/alerts-ack-cli.test.ts` | 严格参数早拒绝、真实权限/原子审计、构建入口真实执行与关停、安全输出 |
| `test/analytics-repartition-cli.test.ts` | 单月/显式环境早拒绝、实际超级管理员、DEFAULT完整搬移及重复、构建入口和资源关闭 |
| `test/billing-advance.test.ts` | 账务推进循环：到点的主体逐个推进，被占着的跳过，一个主体出错不影响别的 |

## 4. 兼容脚本

`REDIS_COMPAT_URL=<连接串> pnpm redis:compat`。参数与七项内容见 [src/cli/redis-compat.ts](src/cli/redis-compat.ts) 开头的注释；业主怎么跑、结果记到哪见 [v01-managed-redis.md](../../docs/plan/external-verification/v01-managed-redis.md)。

## 5. 已知的限度

- 日志口是最小实现（不带采样、不带脱敏规则），日志库随 api 骨架定了再换。
- 降级时消费者只是不再领新任务：已经在等任务的那一下可能还会领到一条，照常处理，不影响正确性。
- 进程内执行的长任务（`mode: "job"`）不占着扫描循环，关停时也不等它：没跑完的由租约到期后重新认领。
- 启动自检与 api 是同一份清单（`packages/services/src/ops/startup.ts`）：连库、字段加密的密钥环、审计 `target_type`、聚合类型、状态机的表与列，问题一次列全。密钥没配时预发、生产起不来，`local`、`test` 放行并记一条告警。

## 6. W3-03 媒体执行接手

实际worker从`buildWorkerServices`装配CI worker角色与时钟，缺worker角色拒绝，未配保留原降级，不借API角色或凭据发现链。原promote的执行与30秒补偿扫描已迁到登记media_job_run/media_job；升级兼容消费者仍接受严格的历史{jobId}，仅转发到同一个media_job通道，转发失败沿原队列重试。生产只发布media_job，历史消费者不另行认领、执行或扫描，仍由唯一执行器共享local2/remote8预算与租约。五个当前消费者统一关闭后才让出租约。领域scan只等短事务认领，长IO持有于本机执行器，因而不占用扫描轮次或绕过原watchdog。降级pause取消自己的IO且可恢复，SIGTERM永久shutdown收尾；同任务双入口不覆盖owned持有。实际close取消CI自有请求并等待资源回收，原COS/Wechat及DB/Redis生命周期保持。

## 7. M2 通知调度

`notify_scan` 只调公开 worker 服务的 `scanNotify`，入既有 `notify` 队列，消费者调三事务的 `notifyDeliver`。每个 API/worker 有自己的通知 Assembly 闭包及 Provider/clock，静态通知订阅者、remind_scan、N15/N5 指向该 scope。关停先通知 close 取消在途外呼，同时停止循环，随后收消费者再让出租约；单个失败不提前解绑其他根。默认未配置通道仍写真实站内事实，不能把假 Provider 或未配置受控降级写成真实平台到达。未来提醒与通道归属见 [通知域](../../packages/services/src/notify/README.md)。

媒体I10/I11通过本worker的assembly闭包绑定自有MediaJobs；API与worker共存不读取模块global latest。closeMediaJobs仅关闭自己的绑定；完整shutdown仍先等待自有IO，借用连接与兄弟runtime不受影响。
