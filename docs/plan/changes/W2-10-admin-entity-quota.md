# W2-10 后台主体额度调整

| 项 | 内容 |
| --- | --- |
| 改了什么 | 接线既有 admin.entity.quota.update，严格覆盖请求与完整 EntityCard。 |
| 原因 | 大客户额度需真实授权、版本、双回显及可追踪审计，不能绕过 required 缓存入口。 |
| 影响的包 | contract、services、api；无 DDL、框架、HTTP 名称或事件新增。 |
| 类别 | 顺序 |
| PR | 本地 codex/w2-10-admin-entity-quota，待验收后正常合本地 main。 |

基于已接受 main35d0；入口真实 staff 预检与原授权在 required claim 前，首次写入完整 staff20→entity100 锁后重新读当前事实和时钟。
复用原幂等与同事务 adminEntityGetIn/唯一额度公式；明确只读预检不承诺整个 claim 等待期间会话撤销或角色变化全局线性化。
至少一项覆盖，省略保持/null清除、双 confirm、原 lockVersion；允许低于已用量，一行 ops/merchant_quota 审计且零事件/状态迁移。
原48完整回归的47叶字节保护，contract43仅官方生成后必要 literal 另申请完整逆证明；四个新整叶验证真实 HTTP、事务/重放、锁等待与严格契约。
当前只执行所属格式/lint、纯 AST 和正常 hooks；生成、类型、业务、并发及唯一 ROOT300 秒正式审查均待独占授权。
