# 微信付款渠道

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | m.paymentOrder.wechatPrepay/sync/cancel 与微信 Provider |
| 当前做法 | W4-01已实现真实Provider选择、typed预下单与必需可信成功入账；sync/cancel与回调兜底仍未实现。未配置保持对公退路 |
| 登记的工作包 | W1-11b，PR 待填写 |
| 回补里程碑 | M4 |
| 回补的工作包 | W4-01（Provider/预下单子项）、W4-02（剩余） |
| 依据 | W1-11b 第 2、5、7、10 节；开发计划第 7.3 节留桩清单 |

W4-01本地6DB+2HTTP聚合8/8通过，Provider精确24项及services/API类型通过；仅关闭对应代码子项，整桩继续留桩。E2真实商户/资金未验。
