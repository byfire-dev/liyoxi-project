# W4-16 先交已签协议付款单标题读口

| 项 | 内容 |
| --- | --- |
| 改了什么 | W4-16 按任务书§1/4先交独立标题前置：billing.describePaymentOrders 批量取数，经 docs 注入端口与 ops 装配补齐已签记录；两页后继实现。 |
| 原因 | docs 在 L1 不能读取 L2 付款单；原 bizTitle 恒为 null，须复用 m07§1.2/2.5 的真实付款单卡片标题。 |
| 影响的包 | W4-16；七个 services 源叶、一个 ops 集成测试及本包台账。0新HTTP、页面、x01、DDL、依赖；channel-read 仅抽取并复用原格式规则。 |
| 类别 | 顺序 |
| PR | 本地 codex/w4-16-contract-order-titles；未创建远端PR。 |
| 验证 | Node24 格式/ESLint/diff-check、ROOT唯一七源独审0P1/P2/D、services type2、dep2均通过；DB3新增ops1+原docs6共7/7G，8.86秒。生产冻结哈希未变，无远端CI。 |

老板仅对本页 first/latest 中的 billing_order 单号去重取数，主体范围含前任老板同意；跨主体与缺失单号保留 null。订单一次 findMany，旧快照名称与升级目标分别有界批量回查，不逐单查询；店员与汇总不调用标题口，店员三项交易字段继续缺省。

保留首轮类型非公开导入、DB1/2夹具待付唯一与快照准备、dep1测试跨层失败；测试改走正式取消首单、完整typed快照，并移至上层 `ops/docs-billing-titles.db.test.ts`。旧已签目标依赖同文件前序版本，必要复验原docs全6，原断言未改。失败库已精确清理，三轮Redis与成功轮DB均清零。标题桩已回补，本片准备本地main合流，尚无合流SHA。

本片只交只读标题前置；发票/合同两页、实际版本PDF交互和页面截图尚未交付，W4-16保持进行中。真实开票、邮件到达、法律正文及真机PDF边界仍按E8/E20单列。
