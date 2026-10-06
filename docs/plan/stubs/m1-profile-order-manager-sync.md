# 首次指派经理后的订购单同步

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | 首次指派交付经理后未结订购单的同步；W1-15a 已替换空实现 |
| 骨架里的做法 | profile/ports.ts 的 orderManagerPort（profile.order_manager_sync）由同一事务调用，fallback 无写入且 void→0；实际实现返回本次改写数量 number，响应/审计使用同值；调用时 store130已锁、经理列尚未更新，按明确 input.staffId 写入，新增锁保持160/180之后 |
| 登记的工作包 | W1-08a、b |
| 回补里程碑 | M1 |
| 回补的工作包 | W1-15a：order/register.ts 已登记真实显式 staffId 同步，实际 orders160 锁与 count 回归通过；PR 由调度填 |
| 依据 | W1-08 第 2、7、10 节；a03 第 3.8a 节；任务移交第47行 |
