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

2026-10-14 SOURCE：billing/order/delivery三个键接实际拥有者只读公口；套餐与积分
复用真实钱包，净实付/待审调整与未付关联单读持久记录，订购/上线/交付按本主体本店
及当前负责人分开统计。staff/support、筛选排序与summary仍未回补，整项保持留桩中。
本片等待唯一独审与ROOT串行定点验证，不代表外部支付或M5售后已完成。
