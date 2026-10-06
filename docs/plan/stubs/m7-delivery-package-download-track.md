# 成片逐集签发直记埋点

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | package_download 调用点保留，M1 track 端口空实现 |
| 骨架里的做法 | delivery/download/episode-url.ts 在下载记录同事务内经 trackOf.record 调用，eventId 为 srv-pkgdl-{deliveryReleaseId}-{userId}-episode-{北京时间业务日}。签发日志每次独立写入；M1 不宣称分析记录已落库 |
| 登记的工作包 | W1-16b，本 PR |
| 回补里程碑 | M7 |
| 回补的工作包 | M7 analytics 实现直记埋点端口 |
| 依据 | W1-16b 任务书 第 2、7 节；14 分组 第 2.9、2.10 节；开发计划 第 7.3 节 |
