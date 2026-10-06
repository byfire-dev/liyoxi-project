# 续费升级降级与加购

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | m.plan.quote、m.paymentOrder.create 的续费/升级/降级/pointPackId 分支 |
| 骨架里的做法 | catalog.quotePlan 与 purchase-write.createOrder 对非 subscribe 返回 409 STATE_NOT_ALLOWED |
| 登记的工作包 | W1-11b，PR 待填写 |
| 回补里程碑 | M4 |
| 回补的工作包 | G4-A |
| 依据 | W1-11b 第 2、5、7、10 节；开发计划第 7.3 节留桩清单 |
