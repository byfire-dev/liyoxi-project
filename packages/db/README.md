# @liyoxi/db

唯一的数据访问层：Prisma schema、迁移、客户端工厂。依据：[06](../../docs/06-data-model.md) 第 8 节、[开发计划](../../docs/08-development-plan.md) 第 5.7 节、W0-05 任务书。表结构以这里的迁移为准；`docs/data-model/` 下的 `schema.prisma` 与 `constraints/` 是首版迁移的底稿，接管后冻结。

## 1. 这里有什么

| 路径 | 内容 |
| --- | --- |
| `prisma/schema.prisma` | 由底稿迁入，模型一字未改；只改了文件头注释与 `generator` 的输出目录 |
| `prisma/migrations/20261005000000_init/migration.sql` | 首版迁移：166 张表与 00–15 的手写约束。拼出来的，不手改（第 4 节） |
| `prisma.config.ts` | Prisma 的配置。连接串只取环境变量 `DATABASE_URL`，不读 `.env`，没有默认值 |
| `src/index.ts` | `createPrismaClient`：客户端的唯一构造入口（第 5 节） |
| `scripts/build-init-migration.mjs` | 拼首版迁移的脚本，可重跑核对 |
| `dist/generated/` | 生成的客户端。不入库（根 `.gitignore` 的 `dist/`），由 `pnpm db:generate` 生成 |

## 2. 命令

根脚本，在仓库根目录跑。连库的三个都要 `DATABASE_URL`（本地的取值见 `CLAUDE.md` 第 9 节）。

| 命令 | 做什么 | 连库 |
| --- | --- | --- |
| `pnpm db:generate` | 生成客户端到 `dist/generated/`。类型检查、测试之前要先有它：`pnpm install` 不会顺带生成 | 否 |
| `pnpm db:validate` | `prisma validate` | 否 |
| `pnpm db:deploy` | `prisma migrate deploy`：对 `DATABASE_URL` 指的库跑全部待执行的迁移。可重复跑，没有待执行的迁移时什么都不做 | 是 |
| `pnpm db:catalog-diff` | 系统目录比对（第 6 节） | 是 |
| `pnpm db:verify-managed` | 托管库验证（第 7 节） | 是 |

本包自己的脚本：`pnpm --filter @liyoxi/db migration:build`（重拼首版迁移；加 `--check` 只核对、不写文件）、`pnpm --filter @liyoxi/db test`。

不用 `prisma migrate dev`、`migrate reset`、`db push`（`CLAUDE.md` 第 6 节规则 21）。

## 3. 本地准备

装完依赖后做一次；迁移有新增时重做后两步。Docker 要在运行。

```sh
pnpm infra:up
export DATABASE_URL=postgresql://liyoxi:lyx-local-dev@localhost:5442/liyoxi   # 出处：infra/compose/local.yml
pnpm db:generate
# 建迁移库 lyx_migrate_check 并跑迁移（库已存在就不用建；要重来就先 DROP DATABASE）
PGPASSWORD=lyx-local-dev psql -X -h localhost -p 5442 -U liyoxi -d postgres -c "CREATE DATABASE lyx_migrate_check"
DATABASE_URL=postgresql://liyoxi:lyx-local-dev@localhost:5442/lyx_migrate_check pnpm db:deploy
```

- 那套 PostgreSQL 是几个 worktree 共用的：`lyx_migrate_check` 建一次，所有检出都能用。别的会话可能正连着它，没有必要就不要删。
- `pnpm typecheck` 报找不到 `../dist/generated/client.js`：还没跑 `pnpm db:generate`。
- `pnpm test` 会跑到本包的用例与 `infra/ci/test/db-*.test.ts`，它们要连库，连不上就失败，不跳过：
  - 报“DATABASE_URL 未设置”：照上面导出环境变量。
  - 报“迁移库 lyx_migrate_check 连不上，或还没跑过迁移”：`pnpm infra:up`，再做上面最后两步。
  - 本包的用例连的是迁移库：主机与账号取 `DATABASE_URL`，库名换成 `lyx_migrate_check`，只读不写。
  - `infra/ci` 的用例与 `gates:selftest` 的反例自己建库（`lyx_test_infra_*`、`lyx_selftest_*`），用完删掉，不碰迁移库。
- 每个会话、每个测试进程一个库的测试支架由 W0-05b 交付；在那之前不要往迁移库里写数据。

## 4. 首版迁移是怎么来的

迁移文件由脚本机械拼出：`prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script` 的输出，接上 `docs/data-model/constraints/` 下的 00–15（文件名顺序）。语义一字不改，只加了注释：文件头、每个来源前的分隔行、四类语句前各一行 `-- lyx:allow <理由>`（D7 第 8.3 节第 5 条：`DROP`、`RENAME`、`ALTER … TYPE`、不带默认值的 `SET NOT NULL`）。

```sh
pnpm --filter @liyoxi/db migration:build --check   # 重拼的结果应与入库的文件逐字节相同；并列出带 lyx:allow 的语句
```

- 这条核对在 `pnpm test` 里（`src/migration.test.ts`）。迁移一旦在任何库上跑过就不能再改：Prisma 按文件的校验值认迁移。
- 拼接时出现四类语句而脚本里没有登记理由，脚本报错，不让它漏标。
- 迁移执行时按当天的日期建埋点事件表的分区（兜底、当月、未来 3 个月），分区子表的名字随月份变。
- 迁移不建角色、不写授权（W0-06a）。之后的结构变更走新的迁移文件，一个结构变更包一个 PR。

## 5. 客户端工厂

```ts
import { createPrismaClient } from "@liyoxi/db";

const prisma = createPrismaClient({
  connectionString, // 由装配方从 loadEnv 的 DATABASE_URL 取
  max: 10,
  statementTimeoutMs: 8_000,
  lockTimeoutMs: 3_000,
  idleInTransactionSessionTimeoutMs: 15_000,
});
```

- 五个参数：连接串、连接数上限、三个会话超时（毫秒）。取值照 D7 第 8.3 节“应用侧的数据库会话设置与连接池”那张表，由 W0-22、W0-23 装配时传；本包不读环境变量、不写默认值。超时不给即沿用服务器的设置。
- 一个连接池一个实例。隔离单位是库：连接串不带 `?schema=`，工厂不设 `search_path`。
- 应用层（api、worker、前端）不直接引本包，只在进程装配时由 services 引工厂（`CLAUDE.md` 第 6 节规则 5）。

## 6. 系统目录比对

证明“首版迁移建出来的库”与“由底稿建的参照库”结构相同（任务书 第 7 节第 2、4、5 条）。CI 的 `verify` 里每次都跑，报告是产物 `db-catalog-diff`。

```sh
# 参照库 lyx_schema_check：由底稿建。校验工具有自己的锁文件，先按它装一次
(cd tools/schema-check && npm ci --ignore-scripts)
PGHOST=localhost PGPORT=5442 PGUSER=liyoxi PGPASSWORD=lyx-local-dev python3 tools/schema-check/check.py --keep
# 迁移库 lyx_migrate_check：见第 3 节
pnpm db:catalog-diff
```

- 四段，任何一段不过即退出码 1：两个库都在 PostgreSQL 17 上；两份 `schema.prisma` 去掉文件头注释与 `generator` 块后逐字节相同；系统目录逐项相同；数量等于 06 第 1 节的两组口径。
- 逐项比的是表、列、约束定义、索引定义、触发器、函数体六类，另加序列（连当前值）、扩展、视图、自定义类型、模式、策略、规则、统计对象、事件触发器、注释。`_prisma_migrations` 不计。不比属主与授权（W0-06a）、列的存储方式与统计目标。口径与查询在 [db-lib.mjs](../../infra/ci/db-lib.mjs)。
- 参数：`--ref <库>`、`--target <库>`、`--report <文件>`（默认 `packages/db/dist/catalog-diff/report.md`）。两个库只读不写，库名只认 `lyx_` 开头。
- 两个库要在同一个月里建：分区子表的名字随月份变，跨月建的两个库会差在分区名上。
- 首版之后结构一变，这项比对就不再成立；去留见 W0-06b 任务书 第 11 节。

## 7. 托管库验证

业主在托管 PostgreSQL 到位的当天跑（计划 第 8.6 节 V5“扩展”一项）：在自己的终端里把 `DATABASE_URL` 指到托管实例上一个 `lyx_` 开头的空库，运行 `pnpm db:verify-managed`，把输出回传。

- 报告：两个扩展（`btree_gist`、`pg_trgm`）在实例上可装、迁移跑通后已建出；迁移全部完成；数量两组口径。
- 不打印连接串：输出里只有库名与服务器版本。迁移工具的输出只在失败时给出，并先抹掉主机、账号、口令。
- 只动 `DATABASE_URL` 指的那一个库：库名不是 `lyx_` 开头、或库里已经有表，一律拒绝。
- 本地演练：

```sh
PGPASSWORD=lyx-local-dev psql -X -h localhost -p 5442 -U liyoxi -d postgres -c "CREATE DATABASE lyx_verify_managed"
DATABASE_URL=postgresql://liyoxi:lyx-local-dev@localhost:5442/lyx_verify_managed pnpm db:verify-managed
PGPASSWORD=lyx-local-dev psql -X -h localhost -p 5442 -U liyoxi -d postgres -c "DROP DATABASE lyx_verify_managed"
```

## 8. 生成的客户端为什么放在 `dist/generated/`

任务书的默认是 `src/generated/`。实测 Prisma 生成的客户端自身有循环引用，放在 `src/` 下 `pnpm depcheck` 的“无循环依赖”一条会报 168 处；依赖方向检查只把 `dist/`、`coverage/` 当构建产物排除。放进 `dist/generated/` 后，lint、格式、依赖方向、git 的已有忽略范围都盖得住，不用新增任何忽略项（`docs/plan/status/W0-05.md` 偏差）。
