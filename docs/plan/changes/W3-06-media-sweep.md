# W3-06 分步清扫续片

| 项 | 内容 |
| --- | --- |
| 改了什么 | 既定media.sweep接独立阶段、signal/runTx与专用互斥，补每日清单、熔断、有界三段式续作及aborted已证明意图的恢复补偿 |
| 原因 | 以实际拥有者精确inUse查询保护当前引用，保留法定期限与归档缓冲，复用原任务、提醒和不变量机制 |
| 影响的包 | W3-06清扫续片及25个实际FileRefType拥有者必要只读伴随；无新HTTP/DDL或调度机制 |
| 类别 | 拆并（同包分片） |
| PR | — |

- 既定media.sweep真实job接线：独立阶段、signal/runTx/专用互斥，持久每日清单、参数熔断和有界逐文件三段式续作及aborted已证明意图的只恢复补偿；不增DDL或调度机制。
- 必要现FileRefType可选inUse由25个实际拥有者精确查询当前fileId并返回真实引用；readColumns继续历史核对，不再逐文件全表扫描。
- 账号证明沿真实注销/主体关闭满3年canRelease与原release；OCR属media自有表按到期清raw，法定证据与归档缓冲不缩短。
- 素材需求复用真实asset.demand_created/asset_feedback及notify公开日期派生，当前notifyScope/成员复核和持久T-0去重，无新scene/事件/HTTP。
- I8按原锁序重试ZIP/cover清除后钩子，I13由真实引用检查并补偿；只新风险小样本交ROOT单lane，真桶清扫/恢复/彻删仍未验。
