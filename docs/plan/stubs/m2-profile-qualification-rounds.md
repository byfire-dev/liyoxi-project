# 新增门店与变更资质轮次及终局驳回

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | 资质暂只做首店 initial 与非终局驳回后重新提交 |
| 骨架里的做法 | profile/draft.ts 拒绝 new_store/change；verified 门店变更重审字段无确认回 REVIEW_REQUIRED，有确认回 STATE_NOT_ALLOWED；isFinal=true 回 final_reject_not_open。I7 与资质通过订阅者随同阶段交付 |
| 登记的工作包 | W1-08a |
| 回补里程碑 | M2，G2-B |
| 回补的工作包 | W1-23 拆包后填写 |
| 依据 | W1-08 第 2、7、10 节；计划第7.3节既有留桩；04分组第5.5、5.6节 |
