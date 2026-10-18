# 付款开票空形态

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | PaymentOrderDetail 开票字段与后台 invoice/refundRequests |
| 骨架里的做法 | 原骨架为商家字段null/not_eligible/null、后台invoice空形态与refundRequests=[]；W4-13已实现真实发票投影、已通过本地业务、类型和门禁验收，refundRequests仍为空待W4-10。 |
| 登记的工作包 | W1-11b，PR 待填写 |
| 回补里程碑 | M4 |
| 回补的工作包 | W4-13负责发票子项；W4-10负责refundRequests。 |
| 依据 | W1-11b 第 2、5、7、10 节；开发计划第 7.3 节留桩清单 |

2026-10-17：W4-13已落商家PaymentOrderDetail开票字段、后台invoice真实投影及发票服务；上传前置e9cfbb78已实际合入，三发票DB第3轮3/3G39.43秒；连同配置DB/两HTTP，发票子项已通过本地业务、类型和门禁验收。此处只登记分项实现，不提前记已回补。

退款列表/后台refundRequests属于W4-10；红冲守卫公口存在不等于退款查询/执行已交。两个子项均实际验收后，才能关闭整桩；真实外部邮件验收另保留。
