# 选剧单与上线数量

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | m.home.get 的 cartCount、liveItemCount/liveEpisodeCount；m.drama.get 的 owner.cartItemId |
| 骨架里的做法 | W1-15b workbench/mall 查询当前门店实际 cart、live 项及集数，owner.cartItemId 归属门店/主体；失效剧不计徽标，店员/游客不返回老板字段；真实API验证非零与跨门店隔离 |
| 登记的工作包 | W1-13 |
| 回补里程碑 | M1 |
| 回补的工作包 | W1-15b 接订购与选剧单事实（PR由调度回填） |
| 依据 | 任务书 W1-13 第 7、10 节；05 分组第 2、5 节 |
