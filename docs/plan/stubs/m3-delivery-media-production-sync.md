# 制作体检与样片水印同步桩

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | 样片与成片的制作体检、AI 标识流水线与真正水印播放版 |
| 骨架里的做法 | media/production-stub.ts 只对匹配上下文的人工上传、stored、AI 未使用记录同步 ready；已有 wrong/rejected/AI pending/真实派生不覆盖。样片 Playable 的档位指向原文件，不声称有明水印。时长与尺寸仅取既有真实 mediaInfo；没有时长可登记 uploaded，sample.inspect 以 PRODUCTION_NOT_READY 拒绝且 QC/历史/审计/事件零新增，不捏造 0。W1-19 的本域 testing 窄桥严格核本轮库/前缀、文件/制作/上传归属，对已上传文件的既有 job 调实际 promote；真实 MinIO copy/head/stored 后写固定 known MP4 的 1秒/160×90/17947B 事实，另保留未知 metadata 拒绝且零写负例。不改生产探测、流水线状态或 QC，不冒充生产自动探测。 |
| 登记的工作包 | W1-16a PR2 |
| 回补里程碑 | M3（G3-A） |
| 回补的工作包 | W3-07：真实体检事实、delivery.onProductionChecked、异步制作与实际样片水印访问 |
| 依据 | W1-16a 第 7 节及第 10 节第 5 项；06-media 第 2.9、2.11 节；10-delivery 的 ck_sample_duration_ms；a05 第 3.38、3.39 节 |

上表骨架行为仅作历史记录，W3-07 已删除业务同步 ready 与原片冒充水印档位。
QC/推送/商家签名重核真实输入摘要、上下文、体检、AI 和实际水印输出；只有当前
uploaded 版本接收 checked，重复、乱序与旧版本无回退。通过不代替人工 QC，拒收
沿原30天来源期释放引用；AI 派生按实际任务和下游体检替换，不伪造 ready。

本地公开任务/数据库/浏览器与原生视频叠加证据分别留存。M1 的 typed codec/cloud
替身只证明完整业务编排，原生视觉水印由固定镜像真实渲染验证。真实云和外部平台
读标仍未验，不清除 M5/M6 后续制作、ZIP 或使用期事项。
