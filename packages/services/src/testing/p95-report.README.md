# P95 隔离前置与报告

`infra/ci/p95.mjs` 经 `apps/api/test/p95/run.ts` 调用本目录前置，使用真实 TCP HTTP、正式处理器、鉴权、限流与幂等。只接受 `APP_ENV=test`，自行创建测试库及 Redis 前缀，只回收本轮资源；不接受目标 URL、阈值或生产连接模式。造数先经真实服务建立原型，再按 UUID 映射分批复制完整关联图，不把复制过程称为逐笔业务重放。原片使用既有 codec 数据库夹具及正式提交入口，不证明媒体字节、转码或云端服务成功。

## 两种运行口径

```sh
# 本机功能与耗时观察：20 店、每路 20 样本、HTTP 准备顺序执行。
APP_ENV=test node infra/ci/p95.mjs --profile local --concurrency 1 --scale 0.04 --seed 42 --samples 20

# 原正式规模：安排在预发或专用环境，不在开发机后台反复运行。
APP_ENV=test node infra/ci/p95.mjs --profile formal --concurrency 20 --scale 10 --seed 42 --samples 100
```

两条命令均需已有本地测试 PostgreSQL/Redis 连接参数。`--out` 仅改变脱敏 JSON 报告位置；默认 `apps/api/dist/p95/report.json`。正式默认仍是 c20、scale10、seed42、100 样本、500ms，约 5000 基准店、2 万订单、98 万积分流水；独立付款样本另外创建真实新购主体门店。未配置 profile 时仍选正式档。

local 默认 c1/scale0.04/20 样本，上限 c2/scale0.4/100 样本，并校验基准门店数足够提供独立写样本。完整清单固定为 12 路，包含 `m.order.create` 与 `m.paymentOrder.create`；缺写样本、缺路由、重复或额外路由不能报告覆盖完整。采样前报价顺序执行，测量阶段按所选并发运行。

local 的 `mode=local_observation`、`scope=observation_only`、`passed=null`、`capacityVerdict=not_validated`。只有完整请求零错误且全阶段不变量通过时，`functionalPassed=true`、退出 0；`observedWithin500ms` 与各路 `passed` 只描述本轮观测是否在原 500ms 线内。它们不能转成正式容量通过。只有精确原正式参数得到 `scope=formal_capacity` 与容量 passed/failed；其他自定义规模为 smoke/observation_only，仍按原错误与 500ms 判据退出，但不取得正式容量结论。

## 阶段与不变量事实

报告分别保存 `seedDataset`、`measurementDataset`、`afterActualWrites`；尚未执行或没有取得结果的阶段为 null。旧 `dataset` 仅是 seed 的兼容别名。有限 `failureStage` 定位 setup、seed、测量准备、测量前验收、HTTP 采样、写后验收或报告评估；它不覆盖所有文件写入与 cleanup 异常。嵌套 finally 在报告写入失败时仍关闭 HTTP 服务与自有前置。

每阶段调用当前实际登记的全部可执行 full 检查，核对 `checksRun` 与该集合长度，不冻结旧 91 条或过滤后续检查。`invariants.runId` 是真实 `invariant_run` ID，`status=succeeded` 仅代表执行成功；违规非零仍失败。`modules`、`codes`、`reportOnlyCodes` 明确当时的实际检查集合。

仅本轮违规非零时，前置在 own 库只读聚合未解决记录。`persistedUnresolved.scope=owned_database_unresolved_records`、`perRun=false` 表示当前库的持久化未解决数量，不是本次完整分项：重复发现保留首次 run/first_seen，不能按本次 run ID 筛选冒称完整。只输出已登记 code/数量，未知 code 只合计；不输出 subject、detail、手机号或 token。查询失败记 query_failed，不给假零或遮盖原失败；未查询为 null，亦不代表历史记录为零。

## 当前证据边界

2026-10-15 恢复旧七个源码叶，并通过正式原片提交、版权 timer 重排与协议同意唯一入口补齐当前不变量需要的历史前置；管理员登录夹具明确主管事实。没有改生产状态机、不变量或门禁。

本机 c1/scale0.04/seed42/20 样本的完整一次修复后观察共 240 个实际请求，12 路零错误，三阶段各 123 条检查零违规，22.53 秒。基准 20 店/80 订单/3920 流水，另 20 新购门店；写后 100 订单/3940 流水。各路 P95 8.7–85.3ms，仅是该轮观察。首次 local 在测量前发现旧管理员夹具 `staff.I6`，12 路未采样，已保留失败报告；修正前置后才重跑。

历史 full2 四路超过 500ms 的 RED 保留。旧 full4 在采样前出站消费阶段失败；主线 `b9443875` 已修该消费前置，但本轮没有重跑正式规模，不能据本机观察改写其结论。nightly 已随独立分支 `8e6689e0` 恢复；W2-24 代码项完成，远端运行、D7-16 容量、真实云与预发条件仍未验。
