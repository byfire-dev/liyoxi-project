# 客户端埋点与受限分区维护（W2-18）

W3-11 的 countBannerClicks(tx, ids) 只返回 banner_click 的真实 homeBannerId 聚合计数，供 runtime 向低层 config 注入。不返回 props，不让 config 查询本模块私表，也不新增点击计数列。聚合读取不写事件；展示端五分钟缓存归 config。

`createAnalyticsReceiver`只接契约定义的10个客户端事件。批头严格校验；单条按`ClientAnalyticsEventSchema`的strict属性白名单检查，坏事件计`rejected`，合法事件照常受理。OpenAPI使用strict事件与unknown的联合表达部分受理，不意味着unknown事件可以落库。19种服务端事件名、额外属性、任意文本及手机号/证照/凭证不进入props。

`eventId` UUID统一小写，在`analytics_event_dedup`全局认领；认领与事件新增同一个事务，跨月也不重复。发生时间按`serverNow-sentAt`校时，未来截到serverNow，超过7天拒收。归属用户只取会话；门店经真实成员关系解析，无权门店不落store/entity/role。`analytics_identity`首次绑定后不改绑。

匿名上限取正式`analytics.anon.daily_cap`（默认200000）。按服务器北京时间接收日统计，事务级日闸串行化匿名计数与写入，补报不能绕当日上限。超限丢新，不占去重键，已重复事件仍计duplicated。成功提交后通过既有Alerts发`analytics.anon_daily_cap/P3`、无dimension、detail仅`{dropped}`。不用额外60秒缓存放宽并发限额；这是一处实现偏差。

`analytics.dedup_purge`真实登记每日04:10、job模式、P3漏跑、补最近一期。租期60秒、最多1次、完成期限30分钟是本包运行参数；既有job执行器负责续租与中止。处理器固定注入clock的实际执行时刻，每5000条开短事务清理receivedAt严格早于8天的去重行，直到不足5000条；signal取消后不开始下一批。摘要为`deleted/batches`。原始事件不删除。

两个任务由`createAnalyticsJobs`为本runtime复制既有Assembly闭包，保持其他登记、端口及查找对象。没有全局clock绑定。raw登记未装配时受控失败，关闭本scope中止下一步并等待自身在途事务/外呼；另一scope仍可使用。API并行等待analytics与通知各自任务，再关Provider/库；worker同样等待自己的scope。

## 月维护与真实归档

`analytics.partitions`按北京时间每月20日00:00、job/P2运行，补最近一期，租期60秒、一次、完成期限1440分钟。00:00是原任务未指定时分时的实现选择。当前月与未来3个月按注入clock调用已合入的受限ensure函数，不向worker提供迁移身份或DDL授权。

旧月按实际`analytics.retention_months`（默认25、13–60）选择完整到期月，先转北京时间月历再减自然月；先验证固定子分区结构，再用父表原有SELECT权限、真实子表OID及月份范围读取完整21列，不直接查无SELECT授权的新子表，也不读DEFAULT。每页128行，用`(occurred_at,id)`游标且时间保留微秒；每页短TX后外呼。单行SQL JSON超过64KiB时只返回长度并拒绝归档，保留原分区，不截断内容。

NDJSON按1MiB分块；内容SHA-256决定secure桶键`analytics/archive/YYYY-MM/<sha>.*`。每块有真实不可覆盖PUT、精确size/非空etag回执，再HEAD确认exists/size/同etag。每块索引包含前块索引的完整哈希与键；最后manifest保存总行数、块数和末索引。这条链可还原全月数据，元数据不随全月大小常驻内存。这里验证可信Provider的写入回执与HEAD一致性，不把etag当SHA、不声称完整远端重读或真实COS已验。

最后短TX重新读取clock与正式保留期，调用已合入的受限退役函数；它在父表锁内核完整行数、结构和最短年龄界后原子DETACH/DROP，并同TX写月键审计。晚插入即使在导出游标之前，也会让完整行数不符而拒绝退役。并发归档者使用内容身份与不可覆盖键，短验证/退役事务使用同月事务锁，已退役候选不重建，只有一次退役/审计；失败、取消、配置不可用或行超限都保留数据库原文。失败留下的内容对象暂保留供调查，不自动扫桶删除。

## 单月修复CLI

镜像内入口：

```sh
node apps/worker/dist/analytics-repartition.js YYYY-MM --env test --staff STAFF_UUID --note '核实后修复该月埋点分区'
```

只接一个公历月份；所有选项须唯一，环境须与`loadEnv`的APP_ENV一致，原因5–200字。非法输入和预取消在装配/IO前拒绝。服务在同TX锁定实际active员工与角色，要求现有`sys.super_admin`，按fresh保留期拒绝已到期月或超过当前+3月，然后调用受限单月repartition并写`analytics_event`月份键CLI审计。退出0为真实结果（`month/moved`），1为输入/权限拒绝或预取消，2为环境/执行/关闭失败；不回显连接串、原因正文或错误载荷。已进入的原子事务等待真实结果，不将已提交修复伪称取消。

此CLI不授任意DDL，不处理归档历史恢复、不改变dedup/identity或旁侧月份。真实服务器执行仍须按环境包运维授权。

运行定向用例：

```sh
pnpm exec vitest run --project services packages/services/src/analytics/ --maxWorkers=1
```

连接参数与会话隔离沿根CLAUDE的公开local/test支架；不读.env，不对共享业务库写fixture。

PR1与三项独立受限数据库能力已实际进入本地main。PR2业务代码在独立分支验收与审查中；未使用真实云/密钥、未运行远端CI，未对生产容量或P95作结论。Air本地验证串行单worker，不降低正式保留期、生产批阈值或原并发断言。
