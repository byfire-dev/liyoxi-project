# W2-10 成员素材条数窄前置实施边界

| 项 | 内容 |
| --- | --- |
| 改了什么 | 在 media 所属域补同事务批量成员素材条数读口，供后续成员列表使用。 |
| 原因 | 上传和采用条数来源由 media 拥有，tenant 与 media 同属 L1，不得直接互引。 |
| 影响的包 | W2-10；包数、里程碑、接口归属和完整主包边界不变。 |
| 类别 | 顺序 |
| PR | 本地分支 `codex/w2-10-member-asset-counts`；验证及唯一审查后正常合入本地 main。 |

从实际本地 main `238ca303d777d9150ae6e93fcac6cc835e76c31e` 开始；该基线已交付成员移除与主动退出。此片只改 media 新读口、公开出口、新测试及三份所属说明，不接 tenant/API/worker，不交成员列表或范围更新 HTTP。

## 计数边界

`readMemberAssetCounts(tx, { entityId, storeId, merchantUserIds })` 对去重账号返回 `ReadonlyMap`，每项含 `uploadCount`、`adoptedCount`。空集合返回空 Map；其他请求只执行一条绑定参数 SQL，在同一快照按指定主体、门店、商家上传账号及 `deletedAt=null` 聚合，保留无匹配账号的真实零值。采用次数大于零每条只计一次，不累加次数，不因未复核、block、不可用或上传人已退出而遗漏历史上传。

原 CHECK 只允许 merchant/staff 上传来源：测试实际排除合法 staff，不构造非法 system 素材，不改 DDL。测试局部 helper 建合法历史素材事实，复用原公共 seeded、TxRunner 与账号/主体/门店工厂，不扩大共享工厂或冒称执行上传、采用或云端 producer。

## 验证与合流

nonTest 新增≤200、新测试≤450。源码阶段仅所属轻格式、lint、语法与正常提交；真实类型、DB 和门禁尚未运行。新目标覆盖批量、真实零值、去重、范围隔离、删除/上传身份、历史状态、同事务可见和回滚；保留原服务素材、采用写侧及 API 素材事实三个完整测试叶。

待并行媒体切片实际合入 main 后普通同步并重新冻结，使用独立 session、单 worker、无文件并行和无缓存执行新旧完整目标与必要类型、依赖、官方契约及尾检查，精确收尾自有 DB/Redis/PID/PGID/TMP。唯一非作者 ROOT180秒正式审查通过后正常合入本地 main；本片不启云、预算或远端推送，不代表完整 W2-10 或成员管理 HTTP 完成。
