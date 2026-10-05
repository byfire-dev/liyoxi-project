# 测试支架

并行的会话与并行的 Vitest worker 连同一份 PostgreSQL 与 Redis 而互不干扰；另带可拨时钟与四种故障注入工具。由 W0-05b 交付。依据：[开发计划](../../../../docs/08-development-plan.md) 第 5.4、5.6、9.3 节；[01](../../../../docs/01-architecture.md) 第 12 节；任务书 `docs/plan/tasks/W0-05b.md`。

全部从 `@liyoxi/services/testing` 引（`packages/db` 自己的用例从 `./testing` 引：db 不能依赖 services）。只给测试用，不进生产装配。十二个 Provider 替身也在这个出口，说明见 [../providers/README.md](../providers/README.md)。

## 1. 这里有什么

| 文件 | 内容 |
| --- | --- |
| `packages/db/src/testing/database.ts` | 测试库的名字与守卫；建库、删库、重置、连接四个入口；清理的挑选规则 |
| `packages/db/src/testing/global-setup.ts` | Vitest 的 globalSetup：每轮测试开始时建本会话的模板库并跑全部迁移，结束时删掉 |
| `packages/db/src/testing/worker.ts` | `useTestDatabase`：每个 worker 一个库 |
| `packages/db/src/testing/prune.mjs` | `pnpm test:db:prune` |
| `redis.ts` | `useTestRedis`：每个 worker 一个键前缀；“清空”只清自己的 |
| `clock.ts` | `createClock`：可拨时钟 |
| `fault/` | 四种故障注入：`deliverRepeatedly`、`runUntilCrash` 与 `crashPoint`、`createRedisOutage`、`createCallInterrupter` |
| `isolation.mjs` | `pnpm test:isolation` |
| `global-setup.ts` | 转导出上面那个 globalSetup，给本包与应用层挂 |

## 2. 测试库

隔离单位是“库”，不是 schema（开发计划 第 5.4 节）。原因三条：底稿里有写死 `search_path = public` 的函数（如 `lyx_03_purge_auth_event`），换 schema 隔不开；扩展是库级的；只增表有触发器拦 TRUNCATE、应用角色也没有删除权，清表这条路走不通。

```ts
import { useTestDatabase } from "@liyoxi/services/testing";

const db = useTestDatabase("services"); // 测试文件顶层；包名取 db、services、api、worker

it("……", async () => {
  const prisma = await db.prisma(); // 首次取连接时才建库
  // ……
  await db.reset(); // 要一个干净的库：删库重建。之后重新 await db.prisma()
});
```

- 名字：`lyx_test_<包>_<会话标识>_<worker 编号>`；同一个文件要第二个库时写 `useTestDatabase("services", { label: "b" })`，名字末尾多一段 `_b`。模板库是 `lyx_test_tpl_<会话标识>`。
- 会话标识：环境变量 `LYX_TEST_SESSION`（1–12 位小写字母与数字）；没设就取本检出根路径的短哈希，所以每个 worktree 天然各用各的。worker 编号取 Vitest 给的 `VITEST_POOL_ID`（1 到并行数）。
- 生命周期：每轮测试开始，globalSetup 重建模板库并 `prisma migrate deploy`，建完关掉它的连接入口；测试文件第一次取连接时从模板库拷一份（约 0.2 秒）；文件里的用例全过，收尾时删库；有用例失败，库改名为 `<库名>_k<时间戳>` 留下，名字打印在输出里，看完用 `pnpm test:db:prune` 清掉。
- 守卫：建库、删库、重置、连接四个入口都先过 `assertTestDatabaseName`，名字不是 `lyx_test_` 开头即抛错，一句 SQL 都不发。装配测试用的服务容器之前，用 `assertTestDatabaseUrl(连接串)` 给连接串把关。
- 重置 = 删库重建，不清表。重置之前取的 Prisma 客户端作废，要重新取。
- 角色：`useTestDatabase("services", { role: "某个角色" })` 让连接连上之后切到那个角色。缺省不切，用 `DATABASE_URL` 的账号。W0-06a 的授权迁移合并后，缺省值改为应用角色 `lyx_app`（两个包里后合并的一方改，任务书 第 11 节第 8 项）。
- 同一个会话标识同一时刻只许一轮测试：globalSetup 用一把咨询锁占着，第二轮会报“会话标识 … 已经有一轮测试在跑”。同一个检出里要同时跑两轮，各给一个 `LYX_TEST_SESSION`。
- 连库的时限：删库要等数据库做一次检查点，实例上别的会话正在大批建表时会慢到十几秒。收尾钩子的时限已放到 120 秒；自己的用例里连库的那几条也建议写明 `{ timeout: … }`，不要用缺省的 5 秒。

### 清理：`pnpm test:db:prune`

```sh
pnpm test:db:prune              # 删本会话留下的测试库
pnpm test:db:prune --dry-run    # 只列出要删的
pnpm test:db:prune --session <会话标识>
pnpm test:db:prune --all        # 实例上全部 lyx_test_ 开头的库
```

- 只删 `lyx_test_` 开头的库，每个名字再过一遍守卫；别的库一个不动。
- 所属的会话正有一轮测试在跑（会话锁被占着）的库不删，列在“没删”里。
- `--all` 连别的会话的 infra 用例自己建的 `lyx_test_infra_…` 也删（它们不按本支架命名，认不出属于哪个会话）：别人正在跑测试时不要用。

## 3. Redis

按键前缀隔离，不按库号（库号只有 16 个，会话数乘 worker 数不够分）。前缀是 `lyx:test:<会话标识>:<worker 编号>:`，落在 D7 第 2.5 节的 `lyx:{env}:` 之下。

```ts
import { useTestRedis } from "@liyoxi/services/testing";

const redis = useTestRedis(); // 测试文件顶层

it("……", async () => {
  const client = await redis.client(); // ioredis，键自动套上本 worker 的前缀
  await client.set("k", "v"); // 实际的键是 lyx:test:<会话>:<worker>:k
  await redis.flush(); // 清空自己前缀下的键
});
```

- “清空”只用 `SCAN` 加 `UNLINK`，不用 `FLUSHDB`、`FLUSHALL`：共享的那份 Redis 上还有别的会话、别的 worker 与本地开发的键。前缀同样有守卫（`assertTestRedisPrefix`）。
- 首次取连接时先清掉这个前缀下上一轮的残留；测试文件跑完，自动清空并断开。
- BullMQ 不认 ioredis 的 `keyPrefix`，要用它自己的 `prefix` 选项：写 `` `${redis.prefix}bull` ``，连接用 `await redis.raw()`（不带前缀的连接）。
- 连接串取环境变量 `REDIS_URL`。

## 4. 可拨时钟

```ts
import { createClock } from "@liyoxi/services/testing";

const clock = createClock(); // 缺省起点 2026-01-05 12:00（北京时间）；也可以传一个 Date
clock.advance(60_000); // 往前拨一分钟
clock.set(new Date("2026-03-01T00:00:00+08:00")); // 直接拨到某个时刻，可以往回拨
```

不拨就不走。形状是 `{ now(): Date }` 加 `advance`、`set`；kernel 的 `Clock` 接口由 W0-07 定义，与它同形。它可以直接传给十二个替身：`createFakeProviders({ clock })`。

## 5. 故障注入

四种工具，各有自测（`fault.test.ts`）。这里只交工具；拿它们去压内核是 W0-13、W0-20、W0-23、W0-30 的事。

| 工具 | 造什么 | 要点 |
| --- | --- | --- |
| `deliverRepeatedly(handler, message, { times, mode })` | 重复投递：同一条消息投 N 次，`serial` 一次处理完再投下一次，`concurrent` N 次同时投出去 | 每次给处理函数的是消息的一份深拷贝；处理函数抛错不打断后面的投递，结果里分 `fulfilled`、`rejected` |
| `runUntilCrash({ module, crashAt, payload })` 与 `crashPoint(name)` | 进程中断：起子进程跑一段场景，到指定断点由父进程发 SIGKILL | 场景是一个模块导出的函数（TypeScript 也行），在想断的位置写 `await crashPoint("名字")`。子进程拿不到父进程里的对象，连接串之类经 `payload` 传。`onReach` 在子进程停在断点上、被杀之前执行，可以查一眼未提交的状态。场景模块不要引 Vitest 的钩子 |
| `createRedisOutage()` | Redis 不可用：在客户端一侧造，不停共享的那份 Redis | 返回的 `url` 是本机的一个转发口，客户端连它；`await outage.down()` 之后连接被拒，`await outage.up()` 之后恢复。别的会话连的是真的 Redis，不受影响 |
| `createCallInterrupter()` | 外部调用前、中、后中断 | `arm("before" \| "during" \| "after")` 布置，`call(fn)` 或 `wrap(fn)` 包住外部调用。`before`：没发出去；`during`：发出去了，调用方立刻拿到错，外部一侧照常处理完（`await inFlight()` 等它）；`after`：应答回来了，挂在错误的 `result` 上 |

## 6. 命令

| 命令 | 做什么 |
| --- | --- |
| `pnpm test` | 全量测试。`packages/db`、`packages/services` 两个项目挂了 globalSetup，要本地的 PostgreSQL 在运行并给出 `DATABASE_URL`；连 Redis 的用例另要 `REDIS_URL`（取值见 `CLAUDE.md` 第 9 节） |
| `pnpm test --maxWorkers=4` | 指定并行数。参数直接跟在后面，**不要写 `--`**：`pnpm test -- --maxWorkers=4` 里 `--` 之后的参数会被 Vitest 忽略（2026-10-05 实测，pnpm 10.34.5、Vitest 4.1.11） |
| `pnpm test:isolation` | 两个会话同时跑全量测试（各 4 个 worker），都要绿，且两边用的库名与 Redis 前缀没有交集。CI 的 `verify` 里有这一步。日志与用量记录放在系统临时目录，位置打印在输出里 |
| `pnpm test:db:prune` | 清理测试库，见第 2 节 |

`pnpm test:isolation` 怎么知道两边用了什么：环境变量 `LYX_TEST_USAGE_FILE` 给了文件路径时，支架每建一个库、每发一个 Redis 前缀往里追加一行 JSON。平时不设这个变量，什么都不记。

## 7. 给一个新的包挂上

1. 包的 `vitest.config.ts` 里加 `globalSetup: ["@liyoxi/services/testing/global-setup"]`（`packages/db`、`packages/services` 写的是相对路径）。几个项目都挂了它时，同一轮里模板库只建一次。
2. 测试文件里 `useTestDatabase("<包>")`。包名只能取 `db`、`services`、`api`、`worker`：要加新的，改 `packages/db/src/testing/database.ts` 的 `TEST_PACKAGES`。
3. 没挂 globalSetup 就用 `useTestDatabase`，建库时会报“模板库 … 不存在”。

## 8. 共享实例上的规矩

本地的 PostgreSQL、Redis、MinIO 只有一份，所有 worktree 共用（`pnpm infra:up`，见 `CLAUDE.md` 第 8、9 节）。

- 不另起一套 Compose（会抢端口）；别的会话在跑测试时不要 `pnpm infra:down`。
- 不直接删别人的库、清别人的键：清理只用 `pnpm test:db:prune`；Redis 不用 `FLUSHDB`、`FLUSHALL`。
- 不往 `liyoxi`、`lyx_schema_check`、`lyx_migrate_check` 这些库里写测试数据：连库的用例一律用 `useTestDatabase`。

## 9. 已知的限度

- 嵌套跑的一轮（`packages/db/src/testing/__fixtures__/`）不挂 globalSetup，用外层那一轮的模板库；不要单独拿它当入口跑。
- “4 个 worker 同时在场”是在嵌套的一轮里验证的（确定的 4 个 worker、4 个文件），不随外层的并行数变；外层那一轮用了哪些库记在用量记录里。
- 每个连库的测试文件多付一次建库与删库。实例忙的时候删库可以慢到十几秒（等检查点）；连库的文件多了之后要不要改成“worker 的库留着、用前重置”，到时候再看。
- 进程中断工具的子进程用 Vitest 带的 Vite 加载场景模块，起一个要零点几秒。
- Redis 故障注入只转发不加密的 `redis://` 连接。
