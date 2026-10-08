# 客户端埋点接收（W2-18 PR1）

W3-11 的 countBannerClicks(tx, ids) 只返回 banner_click 的真实 homeBannerId 聚合计数，供 runtime 向低层 config 注入。不返回 props，不让 config 查询本模块私表，也不新增点击计数列。聚合读取不写事件；展示端五分钟缓存归 config。

`createAnalyticsReceiver`只接契约定义的10个客户端事件。批头严格校验；单条按`ClientAnalyticsEventSchema`的strict属性白名单检查，坏事件计`rejected`，合法事件照常受理。OpenAPI使用strict事件与unknown的联合表达部分受理，不意味着unknown事件可以落库。19种服务端事件名、额外属性、任意文本及手机号/证照/凭证不进入props。

`eventId` UUID统一小写，在`analytics_event_dedup`全局认领；认领与事件新增同一个事务，跨月也不重复。发生时间按`serverNow-sentAt`校时，未来截到serverNow，超过7天拒收。归属用户只取会话；门店经真实成员关系解析，无权门店不落store/entity/role。`analytics_identity`首次绑定后不改绑。

匿名上限取正式`analytics.anon.daily_cap`（默认200000）。按服务器北京时间接收日统计，事务级日闸串行化匿名计数与写入，补报不能绕当日上限。超限丢新，不占去重键，已重复事件仍计duplicated。成功提交后通过既有Alerts发`analytics.anon_daily_cap/P3`、无dimension、detail仅`{dropped}`。不用额外60秒缓存放宽并发限额；这是一处实现偏差。

`analytics.dedup_purge`真实登记每日04:10、job模式、P3漏跑、补最近一期。租期60秒、最多1次、完成期限30分钟是本包运行参数；既有job执行器负责续租与中止。处理器固定注入clock的实际执行时刻，每5000条开短事务清理receivedAt严格早于8天的去重行，直到不足5000条；signal取消后不开始下一批。摘要为`deleted/batches`。原始事件不删除。API与worker两装配根绑定clock，关停只解除自身绑定。

运行定向用例：

```sh
pnpm exec vitest run --project services packages/services/src/analytics/ --maxWorkers=1
```

连接参数与会话隔离沿根CLAUDE的公开local/test支架；不读.env，不对共享业务库写fixture。

PR2仍待独立数据库能力actual main：`analytics.partitions`（每月20日）、`analytics_repartition` CLI及受限重分区完整验收。本PR无生产DDL、新函数调用或迁移账号口令；跨月接收用例只由隔离测试库管理角色准备既有分区，再由app角色DML验证。过期分区须真正归档成功后才能删除，当前未实现/未验。GitHub账号外部403，PR1本地通过不等于远程CI/main落地。
