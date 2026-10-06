# 后台商家跨层聚合

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | admin.store.list/get 和 admin.qualificationSubmission.get/approve/reject 的套餐、积分、实付、关联单据、交付/上线、企业微信与联系时限字段 |
| 骨架里的做法 | profile/admin-ports.ts 定义 profile.admin_facts keyed 端口，billing/order/delivery/support/staff 各自严格结构：order 提供 order_item 的上线/使用期/约定上线日，delivery 提供工单数与工作量；未注册来源默认 none/0/null/空数组；门店、主体、档案、资质与员工摘要已有真实读侧。未开放筛选排序400 |
| 登记的工作包 | W1-08b |
| 回补里程碑 | M2，G2-B |
| 回补的工作包 | W1-23 拆包后填写；各拥有者注册 implementAdminProfileFacts |
| 依据 | W1-08 第2、10.1节；a03第2.2、2.3、2.7节；计划第7.3节既有后台聚合留桩 |
