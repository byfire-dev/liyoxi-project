# W2-10 计费历史事实窄前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | tenant 必需历史端口，billing 调用方事务内双 EXISTS 真实实现及公开登记。 |
| 原因 | 空草稿要求从未有订阅/付款单；既有 deletionGuard 只统计未结事项，不能替代历史事实。 |
| 影响的包 | W2-10；整包继续进行中，不提前放行下游。 |
| 类别 | 顺序 |
| PR | 本地 codex/w2-10-billing-history-facts；唯一独审后正常合流。 |

基线 `9320cc5d8476e514906e5d3dc4c6c1d8340c3082`。非测试含文档/支持新增≤250，新增测试≤750。
0 HTTP/契约/事件/DDL/依赖/框架改造；旧 deletionGuard、merchant facts 及原测试正文保持。

`billingHistoryPort` 没有 fallback，返回 `hasSubscriptionTerm` 与 `hasBillingOrder`；
固定参数化 SQL 在同一语句快照按精确 entity_id 判断，不按状态、时间、金额、付款/履约结果筛选。
不存在历史不是主体存在性或放弃权限证明；未来 owner 仍须完整同事务状态及写侧保护。

新两整叶覆盖合法五种订阅期与五种付款单状态、真实来源订单 FK、范围、未提交可见/回滚、
重复读取零写、账户缓存独立、持账户锁期间可读，以及 api/worker 真实绑定和缺实现失败。
原六整叶35静态展开保留，实际收集以官方 JSON 为准；当前未运行重验证。

待唯一 GLOBAL 后串行新旧完整目标、services/API/worker 类型与必要尾链，单 worker/no-cache，
保原期限，失败原件及未执行边界保留；自有资源全0后冻结并交 ROOT 唯一180秒正式审查。
