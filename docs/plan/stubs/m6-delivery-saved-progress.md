# 成片保存回报与重授权字段

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | 保存进度字段与整包操作待 M6 回补 |
| 骨架里的做法 | ReleaseView 按真实 delivery_download_log 的 saved/clientAckAt 查询各集 lastSavedAt 与去重 savedEpisodeCount；M1 尚无保存回报写口，因此正常为空和0。canRegenerate 仅回显重授权资格，当前不建授权；后台 actions 为空，不给 pack |
| 登记的工作包 | W1-16b，本 PR |
| 回补里程碑 | M6 |
| 回补的工作包 | M6 G6-A |
| 依据 | W1-16b 任务书 第 5、7 节；m05 第 3.12、3.13、3.15 节；a06 第 3.11 节 |
