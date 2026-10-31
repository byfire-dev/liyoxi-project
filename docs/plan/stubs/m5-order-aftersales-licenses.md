# 订单售后与授权书

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | OrderDetail.afterSales / licenseLetters；AdminOrderDetail.cancelRequests / licenseLetters / licenseLetterCount |
| 骨架里的做法 | read.ts/admin-read.ts 售后与授权书恒空数组、授权书数0；openCancelRequest 仅显示现有行，不生成申请、授权书或虚构售后记录 |
| 登记的工作包 | W1-15a；b 扩展后台详情字段 |
| 回补里程碑 | M5 |
| 回补的工作包 | G5-B、G5-C |
| 依据 | W1-15 第 7、10 节；计划 第 7.3 节留桩清单；m04 第 2.4–2.9、3.15 节；x01 第 3.10、4.1 节 |


W5-07消费 W5-02取消拥有者公口和 docs 授权书公口补齐上述真实读投影；商家
售后按本订单目标行计入，资质取消的总申请即使无订单头也只取本订单行；后台
cancelRequests 仍按契约的订单头归属。授权书取真实当前 ready 版，生成中和历史
状态如实返回。角色、主体和后台范围仍由原读用例与拥有者重复核验。
定向真库验收包含实际PDF渲染/入库/当前版，以及执行取消、资质取消跨订单范围；
验证记录随 W5-07，远端发布以该包实际合并为准。
