# kernel/ports：五个端口

kernel 定义接口与空实现，上层在自己的 `register.ts` 里登记实现（W0-17）。一端口一文件；声明在 `../register.ts`。机制见 [../assembly/README.md](../assembly/README.md) 第 3 节。依据：[06](../../../../../docs/06-data-model.md) 第 3.6 节；01 分组 第 5.2 节；13 分组 第 5.1、5.3 节；14 分组 第 2.9、5.3 节；15 分组 第 5.2 节。

| 端口 | 取用 | 谁实现 | 没人实现时 |
| --- | --- | --- | --- |
| `alerts.raise({ rule, dimension?, severity, detail })` | `alertsOf(assembly)` | ops（G2-D） | 只记调试日志 |
| `invariants.report({ code, module, severity, subject?, entityId?, detail, healed? })` | `invariantsOf(assembly)` | ops（W0-24，已实现，见 [../../ops/invariants/README.md](../../ops/invariants/README.md) 第 5 节） | 只记调试日志 |
| `track.record(tx \| null, { name, props, eventId?, subject? })` | `trackOf(assembly)` | analytics（M7） | 只记调试日志 |
| 通知场景解析 `ctx.read.*`，按函数名登记 | `notifyReadOf(assembly).read(tx, 名字, …参数)` | 拥有数据的各域 | 返回 `null` |
| 提醒查询，按规则键 `R1`–`R7` 登记 `{ targets, revalidate? }` | `remindersOf(assembly)` | 各域 | `targets` 返回空列表 |
| 商家读侧的事实，按来源模块登记（`profile`、`billing`、`order`、`publish`、`ad`、`support`、`notify`、`asset`；W1-03） | `merchantFactsOf(assembly).read(tx, 查询)` | 拥有数据的各域，用 `implementMerchantFacts(键, 实现)` | 那个键取默认值：计数 0，其余 `null` |

```ts
// 实现方（上层模块的 register.ts）
export const registration = defineRegistration("delivery", {
  portImplementations: [
    implementKeyed(notifyReadPort, "sampleForNotify", sampleForNotify),
    implementKeyed(remindersPort, "R4", { targets: listSamplesAwaitingMerchant, revalidate }),
  ],
});

// 用的地方
await alertsOf(assembly).raise({ rule: "outbox.exhausted", dimension, severity: "P1", detail });
await trackOf(assembly).record(tx, { name: "store_add_submit", props });
```

- 前三个“失败不抛”：实现抛错只记一条错误日志，不抛给调用方。告警与不变量上报由实现方用自己的连接、在独立的短事务里写，不加入调用方的事务。
- 埋点在 `tx` 非空时另用保存点包住实现：实现失败（含数据库错误）只回滚它自己的写入，业务事务照常提交。用例里直记埋点只经 `trackOf` 给的外壳调。
- 后两个是只读查询，实现抛的错照抛。提醒规则没登记时 `revalidate` 给 `{ valid: false }`；登记了、没给守卫的给 `{ valid: true }`。
- 日志口缺省丢弃调试日志、错误走 `console.error`；进程装配时用 `setPortLogger(logger)` 接上（pino 的 logger 可以直接传）。
- 用例里要“记下收到的调用”的样例实现：`@liyoxi/services/testing` 的 `createRecordingPorts()`。

```sh
pnpm --filter @liyoxi/services exec vitest run src/kernel/ports/
```
# W3-11 CatalogRefPort

catalog.refs 由 config 调用、content 注册真实实现。read(tx,at,ids?) 提供 id/title/genreCodes/isListed/isOrderable；areListed(tx,ids,at) 对不存在的 ID 给 false，对存在的 ID 以当前 shared/catalog 可见/可订条件判定。无 noop fallback，正式 runtime 缺实现不能假成功。

## 员工在办来源

`staffWorkSourcesOf(assembly, { requiredOwners?: [...] })` 通过 `staff.work_sources` 读取拥有者真实来源，并按 `StaffWorkItem.reassignOwner` 分派改派。默认五个必需来源始终为 `profile`、`order`、`delivery`、`publish`、`staff`；可选声明只增加要求，传空数组也不能关闭既有守卫。读取与改派检查缺项并返回 `INTERNAL`，`details.missingSources` 列出缺失来源。

W5-09 PR1允许类型表达 `ad`，已登记时会读入并分派；组合根在真实广告来源落地后可传 `{ requiredOwners: ["ad"] }`，声明后缺广告来源即失败。未声明且未登记广告的既有装配保持兼容；若改派输入实际包含广告对象，缺广告来源同样失败。PR1未给生产装配登记广告占位来源，也未在实际runtime提前声明广告必需。锁由既有调用者持有，原五来源的分派顺序、拥有者重核和结果去重规则保持不变。
