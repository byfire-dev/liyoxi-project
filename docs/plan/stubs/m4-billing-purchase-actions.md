# 续费升级降级与加购

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | m.plan.quote、m.paymentOrder.create 的续费/升级/降级分支；pointPackId子项W4-06已完成 |
| 骨架里的做法 | catalog.quotePlan 与 purchase-write.createOrder 的续费/升级/降级仍返回409 STATE_NOT_ALLOWED；pointPackId已接真实加购 |
| 登记的工作包 | W1-11b，PR 待填写 |
| 回补里程碑 | M4 |
| 回补的工作包 | G4-A |
| 依据 | W1-11b 第 2、5、7、10 节；开发计划第 7.3 节留桩清单 |

W4-06已接pointPackId子项：老板能力、现价/上架、有效套餐、退款与购买策略在服务端复核，冻结积分/价格并同事务写topup积分规则同意；本地真实DB/HTTP定点验证通过，见W4-06状态。续费/升级/降级仍属W4-05，主责任及“留桩中”保持；真实支付仍未验。
