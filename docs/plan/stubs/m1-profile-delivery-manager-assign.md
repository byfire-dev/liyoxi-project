# 首次指派经理后的工单分配

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | 首次指派交付经理后待分配工单的分配暂为空实现 |
| 骨架里的做法 | profile/ports.ts 的 deliveryManagerPort（profile.delivery_manager_assign）由同一事务调用，fallback 无写入且 void→0；实际实现返回本次改写数量 number，响应/审计使用同值；调用时 store130已锁、经理列尚未更新，按明确 input.staffId 写入，新增锁保持160/180之后 |
| 登记的工作包 | W1-08a、b |
| 回补里程碑 | M1 |
| 回补的工作包 | W1-16a PR1 注册真实 assignStoreTickets，同事务父锁、flow、事件与实际数量返回；PR 号由发布会话填写 |
| 依据 | W1-08 第 2、7、10 节；a03 第 3.8a 节；任务移交第48行 |
