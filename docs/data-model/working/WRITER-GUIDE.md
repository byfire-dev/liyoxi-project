# 字段级数据模型：写作规范（每个分组的作者必读）

你负责一个分组。产出三个文件，三者必须一致（同一张表、同一列在三处的名字、类型、可空性相同）：

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| 文档 | `<仓库>/docs/data-model/<分组>.md` | 给人读的字段级定义 |
| Prisma 片段 | `（片段，已合并进 ../schema.prisma）<分组>.prisma` | 只含本分组的 `model`，不写 `generator`、`datasource` |
| 手写约束 | `../constraints/<分组>.sql` | Prisma 表达不了的约束：CHECK、部分唯一索引、排他约束、触发器 |

写完必须运行校验并通过：`python3 check_fragment.py <分组>`。它会给片段里引用的其他分组的模型补桩，执行 `prisma format` 与 `validate`，生成建表语句并在本机临时 PostgreSQL 上真正建表，再执行你的手写 SQL。有错就改到通过为止，并把最后一次输出原样写进返回的 `check_output`。

## 1. 依据与优先级

1. `rulings.md`（主负责人裁决 M1–M32）
2. `catalogue.json`：`conventions`（建模约定，逐条遵守）、本分组的表清单（表名、归属、主键形态、tenant、append_only、state_machine、lock_rank、notes）
3. `decisions.md`（跨草案分歧的处理）
4. 主文档 `docs/01-architecture.md` 第 5–7 节、`docs/03-key-designs.md`（含第 9 节裁决）、`docs/04-adr.md`
5. 草案原文（catalogue 的 `sources` 给了行号）：字段的主要来源。草案与上面 1–4 冲突时按 1–4 改，并在文档的“相对草案的改动”里记一行
6. PRD（`PRD 原文`）、原型源码（`design/prototype/`）、调研记录（`docs/appendix/research/`）：核对字段有没有漏

不得自行增删表、改表名、改归属。确有必要时不要动手，写进返回的 `issues`。
不得编造字段：每个字段都要有出处（草案行号、PRD 行号、画板名，或 rulings / conventions 的编号）。草案只列了部分字段的表，按规则与画板补全，补的字段出处写“补：理由”。

## 2. 文档格式（`docs/data-model/<分组>.md`）

```
# <分组标题>

| 项 | 内容 |
| 模块 | … |
| 表 | N 张：…（表名列表） |
| 依据 | 草案与章节 |

## 1. 概览
（一段话说明这组表解决什么问题；一张 mermaid erDiagram，只画本分组的表与直接关联的外部表）

## 2. 表定义

### 2.x `表名` 中文名
用途一两句。归属：门店维度 / 主体维度 / 全局。主键形态。是否只增。锁顺序（lock_rank）。

| 列 | 类型 | 空 | 默认 | 说明 | 出处 |
| --- | --- | --- | --- | --- | --- |
（类型写 PostgreSQL 类型：uuid、text、integer、bigint、boolean、timestamptz、date、jsonb、uuid[]、smallint、numeric(p,s)、bytea。“空”列写“否”或“可”。枚举列在说明里列出全部取值及含义。）

**键与索引**：主键；外键（列 → 表.列，删除行为）；唯一约束；普通索引（给出用途：哪个查询用）。
**手写约束**：CHECK、部分唯一索引、排他约束、触发器，各一行，写约束名与规则；与 SQL 文件里的名字一致。
**状态机**（仅 state_machine = true 或有状态列的表）：一张表列出“当前状态 → 事件 → 新状态 | 守卫 | 触发者”，或 mermaid stateDiagram；注明是否写 status_transition。
**不变量**：这张表上需要每日校验的不变量（如有）。
**相对草案的改动**：逐条（改名、类型、补列、删列、拆并），带依据。

## 3. 枚举汇总
本分组全部枚举列：枚举名（表.列）、取值、含义。跨分组共用的枚举注明“见 catalogue enums_shared”。

## 4. jsonb 快照结构
每个 jsonb 列的结构（键、类型、含义），它对应契约里的一个 schema。

## 5. 与其他分组的关系
本分组引用了哪些外部表（建外键的、只存 id 的分别列出）；哪些外部表引用本分组。

## 6. 待确认
会影响表结构、需要业务或法务决定的问题，各带默认做法。
```

文风：中文，短句，不写空话；表格优先。不写实现代码。

## 3. Prisma 片段规则

- 模型名帕斯卡命名，`@@map("蛇形表名")`；字段小驼峰，`@map("蛇形列名")`。
- 类型映射：uuid → `String @db.Uuid`；text → `String`；integer → `Int`；smallint → `Int @db.SmallInt`；bigint → `BigInt`；boolean → `Boolean`；timestamptz → `DateTime @db.Timestamptz(3)`；date → `DateTime @db.Date`；jsonb → `Json`；uuid[] → `String[] @db.Uuid`；text[] → `String[]`；numeric(p,s) → `Decimal @db.Decimal(p, s)`；bytea → `Bytes`。
- 主键：`id String @id @db.Uuid`（不写 `@default`，由应用生成 UUID v7）。只增表另加 `seq BigInt @unique(map: "uq_<表>_seq") @default(autoincrement())`。复合主键用 `@@id([...], map: "pk_<表>")`。
- 默认值：`lock_version` 写 `@default(0)`；布尔列写默认值；业务时间不写 `@default(now())`（约定：业务时间由应用时钟写入）。`updated_at` 不用 `@updatedAt`。
- 关系：只在**持有外键的一方**写关系字段，如
  `store Store @relation(fields: [storeId], references: [id], onDelete: Restrict, map: "fk_<表>_store_id")`。
  对方的反向字段不要写，`prisma format` 会自动补（引用的是其他分组的模型时，校验脚本会补桩）。
  同一对模型之间有多个关系时必须写关系名：`@relation("OrderPlacedBy", fields: …)`。
  conventions 规定“只存 id、不建外键”的跨模块引用，只写标量列，不写关系字段，并加注释 `/// 不建外键：<原因>`。
  被引用的外部表若主键不是单列 uuid `id`（复合主键或自然键），不要写关系字段，只写标量列并注明。
- 索引与唯一约束：`@@index([...], map: "ix_<表>_<列>")`、`@@unique([...], map: "uq_<表>_<列>")`、单列 `@unique(map: "uq_<表>_<列>")`。名字不超过 63 个字符。部分索引、表达式索引、降序以外的特殊索引放到 SQL 文件。
- 每个模型和每个字段上方用 `///` 写一行中文说明（会进生成的类型注释）。
- 片段里只写本分组的表。

## 4. 手写 SQL 规则

- 目标库是 PostgreSQL 17，但语句必须能在 PostgreSQL 14 上执行（本机校验环境是 14）。不要用 `NULLS NOT DISTINCT` 等 15 以后的语法；需要“可空列参与唯一”时用部分唯一索引或 `COALESCE` 表达式索引。
- 文件开头写注释说明分组；按表分段，每段前写 `-- 表名`。
- 每个枚举列一条 CHECK：`ALTER TABLE t ADD CONSTRAINT ck_t_<列> CHECK (<列> IN ('a','b'));`
- 数值范围、列间关系、按类型必填等也写成 CHECK。
- 部分唯一索引：`CREATE UNIQUE INDEX uq_t_<规则> ON t (...) WHERE ...;`
- 排他约束用 `EXCLUDE USING gist`（`btree_gist` 已在公共文件里启用）。
- 触发器函数用公共文件 `../constraints/00-common.sql` 里现成的三个，不要自己重复定义：
  - 只增表：`lyx_forbid_mutation()`（行级 BEFORE UPDATE OR DELETE，另加语句级 BEFORE TRUNCATE）
  - 只拦 UPDATE：`lyx_forbid_update()`
  - 只允许把指定列从 NULL 写一次、其余列不可改、不可删：`lyx_write_once('列1','列2')`
  需要别的触发器逻辑时，在本分组 SQL 里定义函数，函数名以 `lyx_<分组序号>_` 开头。
- 不写 `CREATE TABLE`、普通索引、外键（这些由 Prisma 片段生成）。不写角色与授权语句（在文档里说明即可）。
- 引用其他分组的表时只能引用它的 `id` 列（校验时其他分组的表是只有 `id` 的桩）。

## 5. 返回

返回结构化摘要：三个文件路径、表数、`check_output`（校验脚本最后一次的完整输出）、`issues`（需要主负责人处理的问题：清单要改的、跨分组要对方配合的、找不到依据的）。

## 6. 第二轮修订须知（2026-10-03）

初稿整体校验已通过（166 张表在同一个库里建成，手写约束全部执行成功）。第二轮按 `rulings.md` 第六、七节（M33–M92）修订，本规范与之冲突处以 rulings 为准，要点：

- **关系字段**（改写第 3 节）：校验工具现在会自动补反向字段。同一个模型有多个关系指向同一个模型时，每个关系都写关系名；指向其他分组模型的关系也可以写关系名。初稿里注释掉的关系字段、放进手写 SQL 的外键（含 `DO` 块）全部移回 Prisma 片段，并删掉 SQL 里的同名语句（M46）。
- **归属复合外键**（M47）：同时带 `entity_id`、`store_id` 且对 `store` 建外键的表，门店外键写成 `@relation(fields: [storeId, entityId], references: [id, entityId], onDelete: Restrict, map: "fk_<表>_store_entity")`，另保留主体的单列外键。被引用的外部表若需要非 `id` 的列，桩会自动补，照常写即可。
- **主键命名**（M48）：`@id(map: "pk_<表>")`。
- **公共触发器函数**（M50）：`00-common.sql` 现有五个——`lyx_forbid_mutation()`、`lyx_forbid_update()`、`lyx_forbid_delete()`、`lyx_write_once('列',…)`、`lyx_forbid_column_change('列',…)`；`btree_gist`、`pg_trgm` 两个扩展也在公共文件里。
- **手写 SQL 仍只能引用其他分组表的 `id` 列**（复合外键已改由 Prisma 表达）。
- 可以连接已合并的校验库查看其他分组表的实际结构（只读，不要改）：`pg.sh lyx_full -c "\d 表名"`。这个库是初稿的合并结果，其他分组正在同时修订，列名可能会按 rulings 变化，以 rulings 为准。
- 文档里每张表的“相对草案的改动”保留；另在文档末尾加一节“修订记录”，列出第二轮改了什么（依据哪条裁决、哪条请求或哪条复核意见）。
