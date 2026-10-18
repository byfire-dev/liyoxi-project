# 独立事件告警事实

`createAlertFacts({tx, clock, logger})` 只负责 `alerts.raise` 的持久化。
调用链通过已有 `detach` 脱离业务事务，再由所属 `TxRunner.run` 开独立短事务；
业务随后回滚不删除告警。写失败只记固定日志，不抛给业务或覆盖其原异常。

同一未结束指纹通过数据库部分唯一索引和原子 upsert 合并，次数递增、级别只升。
详情沿旧 writer 的有界标量白名单投影，未知规则转为 `ops.unknown_rule` P2，
非法规则或维度拒绝写入。规则集合保留旧 W2-24 清单，并补实际调用键和
`evidence.consent_digest_mismatch`、`evidence.consent_digest_unavailable`。

`createAlertFactsAssembly` 为每个 API/worker 实例创建独立 writer，仅替换告警端口
及其登记对象，其他数组和索引沿用原装配。静态登记不保存可变的全局 writer。
调用方显式注入的端口和省略实现时的 fallback 保持原样，不创建或关闭借用 writer。
`close()` 幂等，拒绝新写并等待已接受的写完成；组合根在断开数据库前等待它。
关闭一个实例不会关闭借用连接池或重定向另一个实例的事实。

本前置原本只交事件事实；后续证书任务及[运维探针](probe.README.md)沿本writer接入。
机器人/短信派发、备份及 P95 验收仍未完成。旧整包工作树保留；后继 `createAlerts`
必须委托此 writer。同目录 `writeAlertFact` 是唯一 SQL
实现，后继探针在所属独立事务内复用，不能复制第二份事件 upsert。
