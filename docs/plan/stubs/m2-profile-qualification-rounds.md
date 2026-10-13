# 新增门店与变更资质轮次及终局驳回

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | 多轮提交/决定、基础信息待审值、终局驳回、I7 与资质通过订阅者仍未完成；草稿生命周期窄片已通过本机定点验证 |
| 骨架里的做法 | profile/draft.ts 已补 new_store/change 草稿选择和带入、remove/discard 真实写侧；商家 discard 仅 change/new_store。verified 门店变更重审字段无确认回 REVIEW_REQUIRED，有确认仍回 STATE_NOT_ALLOWED；多轮提交/决定及 isFinal=true 仍拒绝。此桩不关闭 |
| 登记的工作包 | W1-08a |
| 回补里程碑 | M2，G2-B |
| 回补的工作包 | W2-11 |
| 依据 | W1-08 第 2、7、10 节；计划第7.3节既有留桩；04分组第5.5、5.6节 |
