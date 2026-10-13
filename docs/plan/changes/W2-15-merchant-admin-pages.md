# 商家列表、详情与渠道码三页按真实主干落地

| 项 | 内容 |
| --- | --- |
| 改了什么 | 将 merchant.list、merchant.detail、merchant.referral_codes 三项 G2-B 占位登记归属明确为 W2-15，保持 M2；消费已合 W2-09/10/11，0 新 HTTP、0 x01、0 DDL/权限/状态机。 |
| 原因 | actual M1 仅有资质审核页；三页需真实 storeId、scope、server actions、掩码、版本和确认，而非把登记当实现。 |
| 影响的包 | W2-15；既有 M1 merchant.review 审批字节不变，后续 M7 商家导出仍等待实际 producer。 |
| 类别 | 归属 |
| PR | —（本地分支由 ROOT 验收并合并） |

必要窄伴随：StoreHeader 的已分配经理动作按同域 StoreRow 已有 permission 条件补齐 reassign-delivery-manager，继续原 core scope 和写口锁后复核；未分配仍原 assign 条件。类型检查发现的 stores.ts 未使用 adminMeta import 单行删除，无契约元数据变化。

详情只代改当前公开允许的免审字段；账号申请证明复用 account_proof 正式上传，批准/驳回/撤回分别消费真实 actions 与权限。FollowUpCreate 正式排除 store，门店联系走 markContacted，继续跟进只针对列表中真实可写业务对象。渠道销售码归属接受当前可见在职员工，不假定只能 sales 角色，也不为 manage 权限扩员工池。

验收按用户低量要求：ROOT 串行八个模型/运输聚合、两个真实浏览器聚合与旧资质页定点，不跑历史全套或制造大矩阵。外部真实账号、消息、云对象与预发演示不在本片冒充通过。
