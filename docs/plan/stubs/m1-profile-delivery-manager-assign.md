# 首次指派经理后的工单分配

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | 首次指派交付经理后待分配工单的分配暂为空实现 |
| 骨架里的做法 | profile/ports.ts 的 deliveryManagerPort（profile.delivery_manager_assign）由同一事务调用，fallback 无写入 |
| 登记的工作包 | W1-08a |
| 回补里程碑 | M1 |
| 回补的工作包 | W1-16a 注册实现后改已回补 |
| 依据 | W1-08 第 2、7、10 节；a03 第 3.8a 节；任务移交第48行 |
