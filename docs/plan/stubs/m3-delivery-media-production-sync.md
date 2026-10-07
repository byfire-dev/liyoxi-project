# 制作体检与样片水印同步桩

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | 样片与成片的制作体检、AI 标识流水线与真正水印播放版 |
| 骨架里的做法 | media/production-stub.ts 只对匹配上下文的人工上传、stored、AI 未使用记录同步 ready；已有 wrong/rejected/AI pending/真实派生不覆盖。样片 Playable 的档位指向原文件，不声称有明水印。时长与尺寸仅取既有真实 mediaInfo；没有时长可登记 uploaded，sample.inspect 以 PRODUCTION_NOT_READY 拒绝且 QC/历史/审计/事件零新增，不捏造 0。W1-19 的本域 testing 窄桥严格核本轮库/前缀、文件/制作/上传归属，对已上传文件的既有 job 调实际 promote；真实 MinIO copy/head/stored 后写固定 known MP4 的 1秒/160×90/17947B 事实，另保留未知 metadata 拒绝且零写负例。不改生产探测、流水线状态或 QC，不冒充生产自动探测。 |
| 登记的工作包 | W1-16a PR2 |
| 回补里程碑 | M3（G3-A） |
| 回补的工作包 | G3-A 体检接入包；W1-19 live 造数提供明确标注的已知媒体事实 |
| 依据 | W1-16a 第 7 节及第 10 节第 5 项；06-media 第 2.9、2.11 节；10-delivery 的 ck_sample_duration_ms；a05 第 3.38、3.39 节 |
