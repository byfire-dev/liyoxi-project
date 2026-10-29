# Q9 第一期样片播放器变更工作包

| 项 | 内容 |
| --- | --- |
| 改了什么 | 08 §7.3 样片留桩及 §7.5 W5-10 条款收窄：Q9 先交原样片页私有播放器/强制勾选与渠道收敛；原电脑样片预览不再作为一期/M6 回补承诺。W5 整包不提前完成，API/页面/x01 原归属和计数不变 |
| 原因 | 业主明确一期样片仅小程序内查看并必须勾选，且 2026-10-29 要求实施；本条记录受影响的留桩调整，业务决定本身仍按 08 §4.3 同 PR 同步文档与代码 |
| 影响的包 | W1-20 样片历史留桩、W5-05/10/15 与原 G6-B 样片预览边界；安全恢复链仍待 W5-03/05/08 后继，不改变其余依赖、里程碑退出或外部验证 |
| 类别 | 留桩 |
| PR | [#203](https://github.com/byfire-dev/liyoxi-project/pull/203) |
| 来源 | 业主 2026-10-27：第一期小程序内查看、须勾选“我已查看”；2026-10-29：“阈值设置为50%。然后，实施Q9播放器开发” |
| 依据 | [业主清单 §3.1](../owner-checklist.md)、[08 §4.3](../../08-development-plan.md)、03 §3.8/5.4、m05 §2.4/3.8/3.9/3.11、a05 §3.41 |
| 形态 | 调度授权的业务决定变更包，同 PR 同步代码与文档；使用 changes 路径记录，不新增 W 编号、任务/状态文件或修改台账门禁 |
| 当前状态 | 实现及本地定点验证完成，一轮独立复审无阻断；远端 CI 与合并以本 PR 记录为准；不表示真实平台验收通过或 W5-05/10/15 完成 |

## 1. 交付范围

- 样片页本页私有 Taro `Video`，9:16、点击播放；移动网络首次播放前显示流量 Sheet；广告位列表可定位播放。到期或播放错误后重新 GET `m.orderItem.sample.get` 取得现签重试，不调用未落地的 `m.playable.get`。页面离开即暂停，版本/门店切换与迟到响应废弃旧播放和勾选。
- 新推送只写 `previewChannels = [weapp]`，`includeWecom = true` 或 `markWecomSent = true` 拒绝；真正水印版 ready 后才允许推送/播放/确认。样片开关缺省与新 seed 为 true，保留数据库已有显式 false 和规则，部署不自动开已有开关。
- 关闭开关时，服务端拒绝新推送、播放签发与确认；GET 仍读历史事实但 `sources = []`、`confirmableVia = []`。确认只接受原推送快照含 weapp、`viewedVia = weapp`、`hasViewed = true`，并核老板、当前版本、广告、暂停等原守卫。GET 零写，firstViewedAt 仅历史访问记录；新确认写 viewedAckAt，不伪造首次播放或完成证据。
- 勾选是商家对所见版本的自声明，不加必须看完或播放进度证据。所有样片相册下载签发服务端返回 `FEATURE_DISABLED`，页面不出相册、电脑端、企业微信查看确认入口。portal 样片接口当前未落地，本次不实现。

## 2. 历史兼容与后继

四种历史 enum、字段、推送快照、访问审计与已确认记录均保留；不改 DDL，不自动数据迁移，不把历史确认重新判无效。旧 album-only 等不含 weapp 的待确认样片不能确认，页面提示联系服务经理；目前没有安全重推/回退链，不承诺能立即重推。恢复链留给 W5-03/05/08 后继，在正式状态迁移、幂等与版本守卫下另行实现。

Q9 不扩展修改意见、按时间点反馈、M5 其他接口/页面、portal、广告查看规则或授权书签名。W5-05 仍做商家 compose/沟通记录和订单事实；W5-10 仍做既有页的修改/失效、广告选择、我的短剧等；W5-15 负责后续合流验收。原 M5 62 API/4 新页/11 x01/11 桩归属与退出条件不重计。

新版服务不能保证仅有相册入口的旧小程序样片页可用。上线须协调新版小程序与现有 `client.min_version` 控制，并按 W2-28 验真实混跑。本次不改真实最低版本、不部署；保留 schema 枚举不表示旧客户端业务兼容已验。

## 3. 修改与验证边界

代码允许范围为现有样片页面与其私有 model/style/test、样片 delivery/playback 服务及必要契约默认/校验、对应窄 HTTP/服务测试；不改公共播放器构件、权限/锁序、数据库结构、CI 门禁或新增依赖。docs/design 同步直接受影响的当前条文；生成物仅由调度以官方命令更新。

| 验证 | 判据与归属 |
| --- | --- |
| 本次受影响的 sample/playback 服务及 HTTP 定点测试 | 新推送仅 weapp；includeWecom/关停/旧渠道/假水印/未勾选/旧版/广告变化/暂停/越权拒绝；失败零业务副作用。由调度按代码实际测试名记录命令 |
| 样片页定点测试、类型检查、构建与截图 | 点击播放、移动网络确认、广告位定位、过期/错误重新 GET、离开暂停、切店/版本废弃及强制勾选；不调用未实现接口。由调度串行执行必要集合并记录 |
| `git diff --check`；受影响文档对照 | 现行规则一致、历史保留、无手改生成物/门禁；文档作者只做轻量核对，不重复重测试 |
| 外部验证 | 真实类目、提审、iOS/安卓真机、法务证据仍未验；测试替身与截图不替代外部验收。E8/E11、签后 V12、预告片不播放的原边界保持 |

2026-10-29 本地验证（Node 24.20.0；连库目标均 APP_ENV=test、独立会话、单 worker、文件不并行；本机小量验证不替代完整 CI）：

- `pnpm --filter @liyoxi/services exec vitest run src/delivery/production-path.test.ts src/delivery/download/sample-url.test.ts src/delivery/download/sample-version.test.ts --maxWorkers=1 --no-file-parallelism`：14 项通过。随后新增后台开关动作投影断言，以同文件 `-t 'Q9关闭或缺失开关依赖拒绝新推送'` 单独复验通过。
- `pnpm exec vitest run --project api apps/api/test/delivery-production.test.ts apps/api/test/delivery-download.test.ts --maxWorkers=1 --no-file-parallelism`：5 项通过。
- `pnpm --filter @liyoxi/weapp exec vitest run src/sub/order/sample/player-model.test.ts src/sub/order/components/model.test.ts --maxWorkers=1 --no-file-parallelism`：25 项通过；services/api/contract/weapp 类型检查、变更源码 ESLint、`pnpm weapp:build` 与原体积门禁通过。
- `pnpm weapp:shots -- --scene sample-unsaved --no-build`、`sample-viewed`、`sample-disabled`、`sample-legacy` 四个定点场景通过（先 `pnpm --filter @liyoxi/weapp build:h5`）。真实 H5 合成视频验证播放、暂停、续播、定位、一次自动重签与手动重试；确认失败重用幂等键，换版清勾选，切店员丢弃迟到 GET。截图随 CI 的 `weapp-shots` artifact 提供；不代替微信真机验证。
- `pnpm contract:generate` 官方生成；`pnpm contract:docs-check` 0 差异；`pnpm contract:compat` 0 失败但无本地在役标签可比，不能据此声称旧客户端兼容；`pnpm depcheck` 0 违规。
- `pnpm lint:colors`、`pnpm lint:copy`、状态/台账单项核对、`git diff --check` 通过；`python3 tools/schema-check/check.py --db lyx_test_q9_schema_20261029_1910` 独立临时库验证 15 份分组文档、168 张表，字段差异 0，已自动清理。
- 一轮独立只读复审无阻断项；范围覆盖服务守卫、历史渠道封闭、真实水印证据、GET 零写、版本勾选失效、迟到换签与 Taro 生命周期。复审全文及实际远端 CI 运行链接由调度发布到本 PR；不追加第二轮复审。

首次 PR CI 发现两处文档对账偏差：样片说明新增两行导致状态机引用行号偏移，§7.3 历史留桩行改名导致登记键不匹配。已将说明并入原段落、保留历史索引行并紧邻注明 Q9 当前范围覆盖，不改检查规则或恢复电脑预览承诺。`pnpm machines:check`、`node infra/ci/check-stubs.mjs`、`check-stubs.test.ts` 8 项和两项 check-stubs 门禁反例通过。machines 缺行反例在本机临时副本因 pnpm 依赖链接未找到 tsx 而未跑成，不记为通过；最终以当前 head 的完整 CI 为准。

补齐 API 索引官方生成（`python3 tools/api-check/gen_registries.py`、`gen_permissions.py`），并将后台真实交付验收从旧相册签发改为小程序水印地址及勾选确认。复用本轮合法媒体，单 worker 执行 `pnpm admin:e2e:live --test-file test/e2e/live-delivery-flow.spec.ts`（附复用媒体参数）：登录准备及交付主路径 2 项通过，45.5 秒；覆盖真实水印字节、旧相册拒绝、未勾选拒绝且零写、勾选确认及两集成片/包质检，独立测试库已清理。远端隔离分片曾出现未修改的 ASR 回调用例任务取消，本地仅该组合定点 2 项通过，尚不能确认 CI 取消原因，未修改 250ms 守卫或降低验收规则；以修正提交的完整 CI 为准。

CI 另暴露原 ASR HTTP 超时测试的建连竞态：20ms 期限先启动，服务端收齐请求才计数，慢调度可正确超时但尚未收包。仅修该测试的计时夹具：保留真实 loopback，收到请求后推进受控计时器，19ms 未结束、20ms 返回原完整超时结果，客户端调用及服务端收包均恰好一次；finally 关闭自有请求并恢复计时器。`pnpm --filter @liyoxi/services exec vitest run src/providers/asr/tencent.test.ts --maxWorkers=1 --no-file-parallelism` 51 项通过。该窄修正由调度纳入 CI 收尾偏差，不改 ASR 生产代码、250ms admission 守卫、CI 并发或验收阈值。

后台完整验收的 60 秒启动期限还覆盖真实母版与两条 W120 制作链预热；一次定点重跑仍在该期限处失败，未连续重试。私有测试入口增加固定阶段及单调时钟耗时诊断，仅向既有测试产物目录写入固定字段 JSONL，由原 CI 上传。原父启动脚本已完全恢复，原启动超时/提前退出检查与错误保持不变，最后一条阶段记录用于定位；不输出原始日志、请求或凭据，不调整 60 秒、业务数据量或 CI 配置。诊断投影 7 项小验证、私有入口 ESLint 与 API 类型检查通过，实际启动阶段与完整验收结果以 CI 运行记录为准。

部署、真实类目/提审、iOS/安卓真机、法务以及最低版本控制与真实混跑均未执行，仍按第 2 节及原外部台账后续处理。
