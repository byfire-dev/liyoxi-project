# 选剧单与上线数量

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | m.home.get 的 cartCount、liveItemCount/liveEpisodeCount；m.drama.get 的 owner.cartItemId |
| 骨架里的做法 | workbench/mall 对数量返回 0、cartItemId 返回 null；积分、权益与套餐均接真实 billing 读侧 |
| 登记的工作包 | W1-13 |
| 回补里程碑 | M1 |
| 回补的工作包 | W1-15 接订购与选剧单事实 |
| 依据 | 任务书 W1-13 第 7、10 节；05 分组第 2、5 节 |
