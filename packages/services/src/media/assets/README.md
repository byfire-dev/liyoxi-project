# 门店素材与需求（W3-14）

入口是实际 Runtime 的 `media.assets`。商家七接口与后台十三接口共用本域服务；
需求、素材、洞察、标签与使用记录沿现有六张表，文件引用沿 `file_ref`，理解步骤
沿现有 `media_job`。本目录没有新 HTTP 框架、状态机、任务预算或数据库结构。

创建先锁门店，再锁素材，随后按 UUID 排序锁所有文件。文件必须真实 stored、分类
正确、属于当前门店和本次上传人。员工代传还须权限、当前数据范围与 admin 来源。
素材创建、引用、SLA timer、审计和直记 `asset_upload` 共用事务；埋点自身的数据库
错误由既有保存点隔离，外层业务回滚仍同时撤销埋点与去重键。

理解按 D5 §9 的六类步骤图推进。每步有真实父素材、运行代次和固定去重键；旧代次、
已删除父对象、文件指纹变化及审核 block 都不能采纳晚结果。原文件 WX/CI 审核只作
观察，不重复提交，不改变原 35 分钟回执约束。所有步骤结束后才能 processed；失败
或跳过保留 partial，降级标题含类型、数量或时长及北京时间。人工复核沿 CAS，人工
确认标签优先于机器同维度标签；补交肖像材料不会自动确认授权。

`createMediaAssetsAssembly` 只绑定所属 Runtime 的日历订阅者和 store_asset SLA 分支。
API 与 worker 各自 attach/close，关闭不回退其他实例；原 SLA 兄弟分支保持原处理器。
日历重算保留 computedAt，取消旧 timer 并登记当前 dueAt；过期或已复核的 timer 不发
事件。I11 沿原恢复框架，I12/I16/I17 分别检查未授权采用、采用计数与标签维度。

所有视图先在事务内返回无 URL 的数据，再在事务外签名，最后复核素材版本、审核、
文件归属、etag 和封面。幂等重放保留 null，不重新签名。肖像材料在 secure 桶，
素材详情只给材料数量；后台文件下载仍走原分类授权和逐次 access 审计。

三个既有消费口使用公开出口：order 同事务验证并登记 reference usage，profile
读取实际总数、近七天数和近期三条，tenant 的 merchant-facts 注册实际素材计数。
L4 组合根从 tenant/staff/order/ad/delivery 的公开事实函数取得店名、上传人及使用
对象，media 不直接读取这些兄弟域的私有表。

## W3-15 ASR 异步策略

ASR 策略复用既有远程任务的 lease、attempt、externalJobId 与 30 分钟期限。
新任务只提交一次，受理成功只保存真实 TaskId；waiting/doing 与暂时查询故障沿原轮询
预算继续回查。受理未知或崩溃遗留无 TaskId 时终局失败，由人工重理解，不推定未受理
而重新提交。有 TaskId 的恢复只查询原号，不开启新 attempt。

每次 submit/query 均由短事务复核父素材、任务租约、运行代次、prompt 及文件归属与
指纹，并调用现有 allowModelCall 准入；签名和模型 IO 在事务外。录音、音频或视频
使用实际源文件的两小时签名。回查必须给真实全文、非空分句和有效时长，落库分句使用
fromMs/toMs；缺失事实、错误 TaskId 或过期租约不写成功洞察。
同主体、实际文件指纹及 prompt 相同的合法 transcript 可复用并保留来源；历史空分句
占位内容不能当成功缓存。人工标签与复核逻辑不变。本地新增完整35例与原五文件45例
均通过，services类型、依赖及本域必要门禁通过；模型IO使用受控替身，真实云未验。

## 外部未验与 W3-15 移交

- W3-14 不新增 ASR/vision/digest 驱动；W3-15 当前接 ASR 异步策略及文档隔离抽取。生产组合缺正式全局预算参数，模型调用
  fail closed 为 `budget_unconfigured`；每日每店 200 次理解和全局日成本的原子准入
  尚未实现，是真实驱动启用前的 W3-15 阻断，不能把文件创建日计数充当调用配额。
- promptVersion=1 是内部记录。ASR/LLM 协议构造不代表真实模型配置、区域与费用
  验收；完整 D5 富摘要、视频抽帧、自动闭集标签、回调及其余策略仍待 W3-15。
- 文档策略消费已合 mediatool 的 TXT UTF-8/GBK、DOCX、PDF 文本层抽取；宿主只下载
  有界字节到既有 workspace，隔离容器解析，未配置或不兼容/超界输入如实 skipped/partial。
  不做 OCR 或结构化菜单；DOCX 跳过表节点，PDF 不承诺识别任意表格结构，人工复核继续可用。
- 真实云、真实模型、顾客肖像材料及成本/隐私联调未验。测试里的受控外呼结果仅用于
  数据库、租约、取消与人工降级性质，不能代替这些外部验收。

本地验证按实际源分阶段记录：素材真库完整 13 例、API 完整 7 例及三端口、
服务纯测试 9 例（含性质 100 轮）、analytics 真库 3 例与原采用 3 例已通过。
官方店员与后台矩阵 UPDATE/check 保留旧黄金字节和顺序，只追加本包七与十三条。
外部字段 `highlights` 遵循 C57；内部和后台的 `keypoints` 及其数组信息保持。
接受内容页 main 后，全工程串行类型、合并装配 API7、原 probes6/mounted272、
原完整不变量 13（unfiltered full 的 errors0/violations0 断言）、strict dep、
API/worker 构建、完整 enum394 列及官方契约/文档对账已实际通过。
四种官方生成器各两次稳定；每项结果绑定真实执行源，纯上游坐标 metadata 的后续
修复不冒充业务或类型重跑。接受独立坐标前置 main `31aff2b` 后，strict coverage、
当前官方差异检查与剩余原门禁已实际通过（7.034 秒）；最终文书和唯一独立审查
记录以作者冻结清单及调度合流结果为准。
这些结果不代表真实模型或真实云验收；所有早期失败与精确资源清理原件保留。

## W3-15 文档素材策略

文档 IO 前后由短事务按父素材、任务、文件原顺序复核新鲜 lease/attempt/deadline、
run/prompt 与主体门店/文件指纹。仅 stored/non-block 的 TXT/DOCX/PDF、20MiB 内实际
字节可下载；workspace 的 source.mp4 只是固定传输名，解析格式来自可信文件记录。
下载大小及 SHA 与源事实核对，解析最多10000码点、10秒且不越任务期限；取消和清理沿
原 caller signal/workspace，不在事务内解析或外呼，不新增模型准入或开启付费默认。

doc_text 严格保存实际正文、完整码点数及截断事实，只有 PDF 给实际页数，TXT/DOCX
不猜页数。缓存仍限定同主体、实际 CRC64/大小、prompt，并核格式和已知 SHA；旧固定
页数或缺少字符数/截断事实的内容不复用。提取或审核聚合正文不完整时，前缀 pass
降为 pending/partial；已观察到的 block/review 保留，不能据此前缀批准整份文档。
本片业务 DB/受控 Unix 协议 peer 与真实 Linux 容器组合测试分列，不把替身当真实解析。
真实文档准确率、云与 E22 仍未验，整个 W3-15 继续进行中。

### 独立真实容器验收

`packages/services/test/doc-container.db.test.ts` 的三格式验收需本机 PostgreSQL/Redis、
Docker 与已接纳的 Linux arm64 mediatool 镜像。普通 services/CI 的 `src/**/*.test.ts`
不收集本组；从仓库根显式执行，不跳过其中任何一例：

```sh
LYX_TEST_SESSION=w315edoc pnpm exec vitest run --config packages/services/doc-container.vitest.config.ts
```

运行前须按测试支架配置 `DATABASE_URL`、`REDIS_URL` 和 `APP_ENV=test`，并确保该独占
session 未被其他轮使用。入口严格核既有镜像的 arm64 manifest 与实际容器 descriptor、
原无网/只读/nonroot/单CPU单GiB沙箱；缺环境或镜像前提明确失败，不自动拉取、构建或替换。
这是本地已接纳镜像的真实 DB/workspace/socket 组合证明，不代替跨平台或远端 CI 镜像交付。

## ASR 可信回调准备

可注入 ASR source 仅接官方录音 form `requestId`（TaskId），独立 HMAC 校验本地任务UUID；
payload 恒 null，仅留原文摘要。真实 owner 锁内复核当前代次、provider、文件指纹与期限，
只改唤醒时间；回调正文不作洞察，仍由原 query 落结果。默认无来源/CallbackUrl/预算启用。
API 组合验收用同库两个真实 runtime：既有 test-only 模型准入和 fake ASR 受理、真实 HTTP
验签收件与 Redis 唤醒，再由原任务回查不同文本；不代表默认生产装配或真实云验收。
国内官方协议2026-10-11核对，最多2次总尝试；query保留、重试触发/间隔和E22仍待实证。

## Digest 要点策略准备

digest 独立短事务复核当前素材/run/prompt、任务 lease/attempt/deadline 与实际来源。
仅消费真实归属文件的当前成功 transcript/vision/doc_text，核对来源任务输出、文件指纹
与洞察内容；上传人正文、说明和内容标签一并投影。转写总计6000、文档总计8000码点，
总输入16000码点以保证最坏 UTF-8 不越旧 LLM 64KiB 上界；截断或缺少步骤保持
partial/manual，不写假标题、标签或完整摘要。
模型 IO 前后及落库前复核完整来源摘要，调用在事务外且传原 signal；准入异常受控降级，
不落通用自动重试。要点严格为1–6条、每条最多60码点，无聚合跨素材缓存。
默认模型/预算仍关闭。当前仅 SOURCE，测试尚未执行；完整 D5 富摘要、视频可信截帧、
真实云、地域和费用仍为后继事项。
