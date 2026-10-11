# 客服所属公开口

`createAdCancelApprovalRefCompanion({ serviceTicketId, clock })` 只实现 a05 §3.62 广告取消提交的审批引用，应用把成对回调传给 `submitAdCancel` 或 facade。真实启用员工仍须通过原 `order.refund.request`、fresh step-up 与订单数据范围；工单须与实际广告同主体、同门店，缺失或越界统一404。

这是专用提交规则，不是 a08 普通 processing 工单的四类型补关联入口，不增加 `service.ticket.reply`、客服模块权限、taskScope 或待分配池限制。a05 未限制工单状态，五种正式状态均可关联；resolved/closed 只保留历史关联，本口不承诺它们接收 `onBizEvent`。

`beforeAccount` 在 order 已取全部目标170锁后、首次账本420锁前取得工单270锁；`afterCreated` 只重入同锁。实例的事务局部 witness 核对原 actor/target、实际新分配审批ID及真实审批所属，缺预锁、换对象或跨事务均拒绝。引用使用审批 `createdAt`，与本次提交事件时刻对齐；引用与真实员工审计、审批/header/line/自动执行同事务，失败全部回滚。相同原 witness 重入不重复引用或审计，后续业务收尾不删历史引用。

本片没有 HTTP、客服完整写侧、DDL、事件登记或其他取消 kind。
