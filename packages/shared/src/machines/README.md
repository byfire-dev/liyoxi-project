# 状态迁移表

25 张业务状态机表的“状态 × 事件 → 新状态”，代码数据，子路径 `@liyoxi/shared/machines`。`flow.transition()` 查它；状态历史的 `machine`、`state_field`、`event` 三列的取值都以这里与契约的登记为准。

依据：`docs/03-key-designs.md` 第 3.1 节；`docs/06-data-model.md` 第 3.2、3.4 节；`docs/data-model/01-kernel-flow.md` 第 2.6、3.2 节；`docs/08-development-plan.md` 第 5.7 节“状态机”行；`docs/api/00-conventions.md` 的 C84。

## 1. 这里有什么

| 文件 | 内容 |
| --- | --- |
| `<模块>.ts` | 迁移表，一个模块一个文件，文件名是 services 的模块名。一张表的一个状态列是一条“链”（`entity`、`store` 各有两条） |
| `define.ts` | 声明形态：`chain()`、一行迁移的字段、`SAME`（不改状态）、`NO_GUARD`、`ADMIN_FORCE_EVENT` |
| `lookup.ts` | 查表的纯函数：`findTransitions`、`checkTransition`、`expandChain`、`eventsOf`、`terminalStates`、`initialStates`、`isForcedRow` |
| `index.ts` | 入口：自动收集各模块的链，给出 `CHAINS`、`chainOf(状态机, 状态列)`、`findChain` |

各处的名字从哪来：

| 什么 | 唯一来源 |
| --- | --- |
| 状态机（表名）与状态列 | 契约 `@liyoxi/contract/registry` 的 `STATE_MACHINES` |
| 状态取值 | 契约 `@liyoxi/contract/enums` 里绑定“表.列”的枚举。写错的取值过不了类型检查 |
| 迁移事件码（`status_transition.event`） | 这里的迁移表。它与出站事件名是两套名字（x01 第 2.1 节 N4），出站事件名不进表 |

表里没有的：守卫与副作用的实现、触发者、出站事件。它们由拥有状态机的模块按行登记。`guard` 只表示分组文档这一行写了守卫。

## 2. 一行怎么写

```ts
export const staff = chain("staff", "status", STAFF_STATUS, [
  ["03:218", null, "staff.create", ["active"]],
  ["03:221", ["active"], "staff.disable", ["disabled"]],
]);
```

| 位置 | 含义 |
| --- | --- |
| 第 1 项 | `ref`：分组文档状态机表的那一行，“分组:行号”。接口文档与 x01 的归属表用同一种写法引用它 |
| 第 2 项 | 当前状态，写几个就是其中任意一个；`null` 是对象新建（状态历史的 `from_state` 为空） |
| 第 3 项 | 迁移事件码 |
| 第 4 项 | 新状态的候选。多于一个时由调用方给出目标；`SAME` 是不改状态、照常写一行状态历史 |
| 第 5 项 | 分组文档这一行的“守卫”一栏是“—”时写 `NO_GUARD`，否则不写 |

- 文档一行写了几个事件码：拆成几行，`ref` 相同。
- 当前状态与新状态都写了几个：指任意组合。
- 人工纠偏（`admin.force`）：按更正白名单逐对写出，`ref` 都指向文档那一行。普通迁移放不放行它由 flow 定。
- 表外行：个别迁移写在表后的说明里（如工单新建的 `ticket.created`），`ref` 指向那一行说明。

## 3. 改迁移

同一个 PR 里改两边：这里的行，与分组文档状态机表的那一行（`CLAUDE.md` 第 10 节）。分组文档被别处按“文件:行号”引用，只在行内改，不增减行。

| 要做的事 | 怎么做 |
| --- | --- |
| 加、改一行迁移 | 改分组文档的那一行与这里的行，跑 `pnpm machines:check` |
| 新事件码 | 写在分组文档事件一格的反引号里，写法 `<对象>.<动作>`，小写蛇形。事件码一旦写进过状态历史就不再改名 |
| 新状态 | 先在契约的枚举里声明（库的 CHECK 走结构变更包），再用 |
| 新状态机或新状态列 | 契约的 `STATE_MACHINES`、这里、01 分组 第 3.2 节的表、`catalogue.json` 同改 |

## 4. 与分组文档对照

`pnpm machines:check`（脚本 `packages/shared/scripts/machines-check.ts`，CI 必过）。口径写在脚本开头的注释里，要点：

- 行由 `ref` 定位；`ref` 落在哪张表格里，那张表格的每一行都要被认领。
- 当前状态、新状态 = 那一格里反引号括起、且属于本状态列枚举的记号；“—”是新建；以“不变”开头是不改状态。所以状态集合要用反引号写出来，不能只写“步骤 1～9”“未结状态”。
- 事件码 = 事件格里反引号括起、形如小写点分名的记号；有带点的只取带点的。
- 事件格是“任何”的行是终态声明。没有事件码的行必须写着“不写状态历史”。
- 人工纠偏行的文档格里没有反引号状态时不比状态集合，白名单以这里为准。

## 5. 覆盖检查

`pnpm machines:coverage`（脚本 `packages/shared/scripts/machines-coverage.ts`）：每一行迁移有没有被接口或 x01 的归属表引用（约定 C84）。旧命令仍读取两个文档来源，旧 `--strict` 仍在有任意未引用行时失败。

W1-21 起 CI 以 `pnpm machines:coverage -- --strict --contract` 作为额外门禁。契约清单目前没有 transitions 字段，因此以真实契约 operationId 限定冻结文档中的 transitions 引用，x01 归属来源与逐行判据保持不变；未登记接口不能提供引用。相对任务书仅 `--strict` 的命令新增 `--contract` 是为保留旧模式的严格语义。

未引用存量逐行登记在 `infra/ci/machines-coverage-baseline.jsonl`（一行一份完整快照，含链列、ref、原因）。首份由实际契约模式覆盖结果生成；后续只能追加前一份的子集，不能增加未知行、重复行或改写原因。基线行始终报告为“未覆盖”，不会计入覆盖率。`--strict --contract` 对不在末份基线中的未引用行失败，仍校验基线历史只减不增；已有引用齐全后可追加去除相应行的快照。`--baseline <文件>` 只在契约模式替换只读基线输入，供仓库外反例用，没有跳过判据的开关。
