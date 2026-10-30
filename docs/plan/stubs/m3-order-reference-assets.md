# 订剧参考素材

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | m.order.create 的 referenceStoreAssetIds 与 OrderDetail |
| 骨架里的做法 | checks.ts 带参考素材一律 VALIDATION_FAILED；read.ts 恒空数组 |
| 登记的工作包 | W1-15a |
| 回补里程碑 | M3，G3-C |
| 回补的工作包 | W3-14，PR由调度填写 |
| 依据 | W1-15 第 7、10 节；计划 第 7.3 节留桩清单；m04 第 2.4–2.9、3.15 节；x01 第 3.10、4.1 节 |

W3-14：order 通过 media 公开函数在同一事务验证范围、当前可参考状态并登记 reference usage；详情返回真实素材ID。实际 API 用例验证合法引用、缺失及跨店拒绝、hold 后失败时引用与财务同时回滚。

2026-10-30查实：上述已交付范围漏掉主文要求的订单file_ref双关联及后台referenceFiles投影。独立fix补齐所选素材的全部实际文件引用、账本前整体410排他预锁，并新增1项M3关键订阅者order.onReferencesClosed落实终态90天释放；附加登记见[变更记录](../changes/plan-order-reference-files.md)。源码与定向验证状态以该fix的实际PR/CI为准，不以本文旧“已回补”替代新增验收。历史usage缺file_ref回填与订单档案媒体producer缺输入约定未实施；GET不补写、不自动复制当前档案。
