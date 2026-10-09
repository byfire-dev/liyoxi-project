# content 最小集（W1-13）

所有写函数第一参数是内核 `Tx`，由调用方在 `tx.run` 内使用；时钟、flow、media 与装配显式注入 `createContent`。M1 写侧只处理从未上架的草稿：`createDraft`、`saveBasic`、`saveCommercial`、`saveRoles`、`createPermit`、`saveCopyrightDraft`、首次 `list`。签名取 a04 的对应请求体；总集数保存同步集号，版权用自己的 `lockVersion`，其余聚合修改推进剧目版本。

`list` 在剧目行锁内执行 L1–L14，再由 flow 在同一事务写状态与随迁列、活动审计、首次版权修订与指针、证明引用和 `drama.listed`。创建同样经 flow 发主干已有的 `drama.created`。M1 不含下架、重上架、版权变更、归档或定价写侧。

`DramaPricePort` 由 billing 的真实 `priceAt` / `paramsAt` 实现。`getDramaCards`、`visibleCatalog`、`getOrderability`、`assertOrderable` 使用该端口与 shared/catalog 自然月谓词；后者返回供 W1-15 保存的 `DramaSnapshot`（公开字段及所选平台的有效许可）。折扣与广告计价归 workbench/mall，用 shared/pricing 的同一 HALF_UP 函数。

静态 `content.I1` 需要进程装配 `bindContent(assembly)`：API runtime 和独立 worker 均已连接；未绑定明确报错。绑定返回退出作用域的恢复函数，测试须调用；业务工厂不取全局状态。M1 登记 I1、I2、I4–I7，I2 仅检测并告警（`heal=none`），I3/授权到期定时器与迁移随 M3。

四种文件引用经 kernel 的 fileRefTypePort 登记，content 不引 media 私有文件。海报被替换后保留旧引用；从未上架草稿的移除证明可释放；上架后的许可与版权证明保留，归档释放及按授权止日计算保留期随 M3 写侧补齐。

`seedDemoContent` 拒绝 prod，以服务函数造 S/A/B、一/二/三类三部双平台/单平台剧；自带纯色 PNG 经 media 入库，按固定剧名跳过已上架行。字典补项只新增缺失编码，保留运营已修改或停用的项。集数、授权平台、两年止日在 `demo-seed.ts` 可核对。

验收：`vitest run src/content/ src/config/insert-dict-items.db.test.ts src/ops/content-worker.db.test.ts`；接口层 `apps/api/test/mall.test.ts` 与全已挂载店员回放。M1 留桩见 docs/plan/status/W1-13.md；四条 route 与输出契约在 m04。Banner 只使用本域契约里已明确的 DeepLink 键和参数，未知规则拒绝下发，后续由 notify/m08 公共 DeepLink 契约包统一并覆盖其余正式合法键，本包 13 键只是 M1 参数已明确的子集。
# W3-11 目录引用与搜索

content 自己实现 kernel CatalogRefPort。read/areListed 在调用者同一事务按当前状态、版权止日和正式最短授权月份复用 shared/catalog.visible；config 不跨层查询 drama/copyright。areListed 沿名但表示当前可见且可订，不能把仅 status=listed 当成有效引用。

matchedFields 与 normalizeSearch 是列表 q 和搜索共用的纯函数：去空白与间隔点，剧名和主演包含、启用题材显示名双向包含。workbench/mall 在真实可见目录中应用它，title 命中优先并以首次上架时间/id稳定裁决；getDramaCards 提供真实价目修订 source 给内部60秒快照键，不改变商家卡片 DTO。独立搜索不建表，不上传搜索词。

# W3-10 版权修订、到期与 R7

copyright 的草稿整份替换使用版权自己的 lockVersion；ever-listed 只能只增修订。
修订先锁剧目，再复核版权版本/确认止日、真实差异和全部证明文件；listed 的阻断校验失败整笔回滚。
旧 current proof 不释放；新 revision proof 永久引用。缩短及任何把止日改早的更正均拒绝。
许可复核只清除真实待核标记并增加剧目版本，保留 initial 上架修订路径。

content.license_end 在授权止日次日北京时间 00:00 到期；改期取消旧活动行再登记。
处理器重读当前版权/状态，旧或重复回调不迁移；到期经 flow 系统下架，不重新上架续期剧。
API/worker 的 ContentPricingAssembly 分别绑定两 timer、等级订阅及 I2/I3；关闭后不回退其他运行时。
I3 修复缺失/错误时间/多余旧活动 timer，I2 用同一真实到期迁移自愈。
同键已 skipped/fired 的正式终态不能复活；I3 保留未愈违规并告警，不虚报重排成功。
R7 查询当前未归档版权止日，每日 09:05 按当前具有 drama edit 的员工聚合，按员工/日去重。
站内写入与企业微信送达分开；未配置、无接收地址和发送失败都保留正式受控结果。

九接口的版权响应在幂等事务内始终保持 posterUrl/trailer.coverUrl 为 null，
首次成功提交后才经 media.signRead 装饰；重放保持 null，不持久化临时 URL。
W3-12 应使用正式 DTO、版权自身版本和 confirm.prevEndDate，不能把剧目版本当版权版本。
真实法务依据、真实外部通知发送及送达需要另行授权联调，本地验收使用虚构资料与替身。
