# 后台商家跨层聚合

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | M2 后台商家聚合四个事实键及完整列表筛选、排序与 summary 已真实回补；support 保留 M7 后继 |
| 骨架里的做法 | profile.admin_facts 的 billing/order/delivery/staff 已有真实只读实现；列表与 summary 共用 readAdminStoreSelection，billing/order 按候选 ID 批量提供当前订阅、净实付与最近订购，scope/筛选口径同源。support 未注册，保持明确 fallback，不宣称五键均完成 |
| 登记的工作包 | W1-08b |
| 回补里程碑 | M2，G2-B |
| 回补的工作包 | W2-11；各拥有者注册 implementAdminProfileFacts |
| 依据 | W1-08 第2、10.1节；a03第2.2、2.3、2.7节；计划第7.3节既有后台聚合留桩 |

2026-10-14 当前事实：billing/order/delivery三个键接实际拥有者只读公口；套餐与积分
复用真实钱包，净实付/待审调整与未付关联单读持久记录，订购/上线/交付按本主体本店
及当前负责人分开统计。staff键经ops组合拥有者公开读取，返回实际老板/当前经理有效企微关系及未结联系义务；
billing/order/delivery/staff四键均已完成唯一独审与ROOT小量真实数据库验收，
具体证据见W2-11状态台账；真实企微回调与外部支付未因此完成。

完整来源/套餐/订阅状态/北京日到期筛选、稳定排序与同范围summary已完成本地验收，
唯一生产独审无P1/P2，新增3组DB与1组HTTP全部通过；前两组仅修正夹具约束后定点重验。
services/API类型、官方契约/docs/x01、依赖边界、summary一行权限矩阵与实际挂载均通过。

support事实归M7 G7-A，由W2-31拆包明确接收方；OCR归W3-16及其外部验收，
终局驳回后的整店取消执行归M5。stores.list导出producer/队列归M7 G7-B，
后继复用同scope查询并自行复核导出权限，W2-15在实际接入前隐藏入口。
这些后继能力与真实平台/远端CI均不纳入本桩M2已完成事实。

2026-10-14：本轮summary验收完成，关闭W2-11所属M2聚合桩；后继能力保留上述归属。
