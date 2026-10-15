# W2-28：四步混跑controller独立接线

| 项 | 内容 |
| --- | --- |
| 改了什么 | 在worker前置d22c5b2a后实现独立controller：两SHA自身归档/build target与精确image ID薄层、私有JSONL、HEAD owner资源、三phase两20集链/旧spec读及600秒含清理。 |
| 原因 | 旧M1支架直驱不能证明对应版独立worker调度；需要真实隔离进程/队列/租约，并避免把HEAD driver挂给旧代码或清共享依赖。 |
| 影响的包 | W2-28、W2-26；仅infra/ci两mjs、新五纯聚合、本域README及此标准记录。caller独立owner/API driver、m2最小owned-network伴随先实际合入，最后普通同步；公共task/status由ROOT收口。 |
| 类别 | 顺序 |
| PR | 本地codex/w2-28-mixed-controller，ROOT唯一正式审查与远端操作；没有自行GitHub/工作流/部署操作。 |

两mjs正常格式展开超过原550–700行估算（初稿1006行），ROOT确认同一完整机制的RPC/进程关闭、镜像身份、私网/共享ID核对、白名单报告及失败清理均必要，批准体量偏差；不压成难读长行或新增框架。默认M1、生产周期/租约/并发、业务算法/状态均不改，观察沿原30秒，两个真实主链保持20集。

只在旧版没有server Dockerfile或确实无祖先时允许no-comparable；HEAD缺定义、旧版有定义却缺driver、其他错误都失败。唯一审查发现无可比版本提前返回的P2，已改为仍完成HEAD构建、迁移播种、主链、排空及清理，任一步失败保持RED；原版本聚合纳入对应成功与失败判据。完整旧GET spec只走私有通道，第四步绑定旧source，不能用HEAD清单覆盖；实际owner清零与phase进程关闭分别证明，不虚构清理数量或lease查询。

五纯聚合和infra单项类型已有绿色记录，轻lint prefer-const及报告路径误拒macOS系统别名的失败保留；后继精确版本/RPC字段补充纳入原聚合。真实构建/双版本HTTP及清理尚待一次ROOT审查与唯一重资源位执行；工作流/发布门禁另交，不将本地纯适配器结果写成混跑或真实云验收完成。
