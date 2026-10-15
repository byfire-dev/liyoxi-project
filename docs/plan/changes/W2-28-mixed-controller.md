# W2-28：四步混跑controller独立接线

| 项 | 内容 |
| --- | --- |
| 改了什么 | 在worker前置d22c5b2a后实现独立controller：两SHA自身归档/build target与精确image ID创建/commit薄层、私有JSONL、HEAD owner资源、三phase两20集链/旧spec读及600秒含清理。 |
| 原因 | 旧M1支架直驱不能证明对应版独立worker调度；需要真实隔离进程/队列/租约，并避免把HEAD driver挂给旧代码或清共享依赖。 |
| 影响的包 | W2-28、W2-26；infra/ci两mjs、新五纯聚合、本域README及标准记录。独立owner/API driver与最小owned-network先合入；本地通过后按调度授权同步W2-28与D7-19台账，workflow/发布gate另交。 |
| 类别 | 顺序 |
| PR | 本地codex/w2-28-mixed-controller，ROOT唯一正式审查与远端操作；没有自行GitHub/工作流/部署操作。 |

两mjs正常格式展开超过原550–700行估算（初稿1006行），ROOT确认同一完整机制的RPC/进程关闭、镜像身份、私网/共享ID核对、白名单报告及失败清理均必要，批准体量偏差；不压成难读长行或新增框架。默认M1、生产周期/租约/并发、业务算法/状态均不改，观察沿原30秒，两个真实主链保持20集。

只在旧版没有server Dockerfile或确实无祖先时允许no-comparable；HEAD缺定义、旧版有定义却缺driver、其他错误都失败。唯一审查发现无可比版本提前返回的P2，已改为仍完成HEAD构建、迁移播种、主链、排空及清理，任一步失败保持RED；原版本聚合纳入对应成功与失败判据。完整旧GET spec只走私有通道，第四步绑定旧source，不能用HEAD清单覆盖；实际owner清零与phase进程关闭分别证明，不虚构清理数量或lease查询。

五纯聚合和infra单项类型已有绿色记录，轻lint prefer-const及报告路径误拒macOS系统别名的失败保留；后继精确版本/RPC字段补充纳入原聚合。ROOT唯一正式审查54.173秒，提前no-comparable的P2与后续窄差分已定点核闭；工作流/发布门禁另交，不将纯适配器结果写成真实云验收完成。

首轮真实演练68.516秒在身份薄层失败：Dockerfile FROM不接受config image ID为本地来源，误作仓库解析；实际HEAD build target已完成。最窄改为同image ID创建未启动的无网络容器，仅复制SHA文本并commit，核Parent后精确删除容器。原报告cleanup通过、owner未创建，不将分段构建成功写成完整混跑通过。

2026-10-16第8轮首次正式全绿226.757秒：HEAD `ddf558d264390faa45406c3e54708a6f93f888a9` / prev `a914c90a95a0d9a60ebd9d464ae2ca0c8ec8f5ab`，20集×2、各123不变量，OLD95列表/52详情及HEAD95列表/47详情均200；真实租约/排空/childclose0与总体精确清理全绿。[报告](../../../outputs/m2/w228-mixed-20261016-8.json)保留前七轮RED，不覆盖第6轮空query与第7轮跨主体观测失败；仅必要测试组合scope/观测起点修复，普通M1与生产判据不变。

本轮两SHA生产文件变化计数0，仅本地bootstrap与独立进程运输验证，不是在役tag或远端工作流兼容证明。D7-19迁移半项未验，整包状态仍进行中，后继gate与同SHA发布阻断由调度按序落地。
