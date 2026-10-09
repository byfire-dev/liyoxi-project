# 订剧门店数额度

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | tenant.assertWithinQuota 调用点 |
| 骨架里的做法 | 实际 main 未导出该函数，M1 一个主体仅一家门店；order 不另造额度判定 |
| 登记的工作包 | W1-15a |
| 回补里程碑 | M2，G2-B |
| 回补的工作包 | W2-10（G2-B） |
| 依据 | W1-15 第 7、10 节；计划 第 7.3 节留桩清单；m04 第 2.4–2.9、3.15 节；x01 第 3.10、4.1 节 |

2026-10-10：公开 `tenant.assertWithinQuota(tx, entityId)` 及Tx-first纯导出，复用现有getQuotaUsage，不另算额度。order报价与submitChecks（提交前/hold后Tf）调用同一判定，仅门店超额返回真实storesUsed/storeLimit/storesOver；成员超额不阻断订剧。新增6+原20真实DB同轮26G，覆盖实际套餐与override回退、草稿/归档/跨主体、同Tx可见/回滚、报价零写及两阶段提交原子拒绝。后续广告提交、完整生命周期、远端CI及容量未验证；唯一独审/本地合流待执行。
