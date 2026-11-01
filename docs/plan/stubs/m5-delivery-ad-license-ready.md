# 广告与授权书就绪条件

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | 交付求值的广告就绪、授权书齐全判定 |
| 骨架里的做法 | delivery/reevaluate.ts 的 adsReady、licenseReady 在 M1 恒真；M1 不生成广告，不写广告行，后继实际校验应替换本桩 |
| 登记的工作包 | W1-16a PR1 |
| 回补里程碑 | M5（G5-B） |
| 回补的工作包 | W5-08 |
| 依据 | W1-16a 第 5、7、10 节第 7 项；10 分组 第 2.1 节 |

## W5-08 回补

delivery/reevaluate-facts.ts 校验广告的实际当前确认版与样片使用版本；广告确认和重开通过完整影响图锁定后，在同事务推进浮动工单或取代旧样片。暂停中的工单在恢复时重算，已钉版不被修改。

授权就绪由 docs 的当前事实收敛和 readLicenseReadiness 提供：所有实际投放账号必须有匹配法律要素的最新 ready 版、当前指针与可用 PDF/哈希；新版本排队或文件不可用时不借用旧 PDF。API/worker 注入同一实例公口，缺少依赖明确拒绝。

facts.db.test.ts 验证确认同事务推进、浮动/钉版与暂停跨轮次；license-readiness.db.test.ts 经真实 reconcile/claim/system-file/complete 链验证全部账号、修订等待、归属与哈希；原 production-path 推包及 merchant compose 回归定点通过。Provider 传输替身不代表法务或真实签章验收，外部 E8/E11 按原台账保留。
