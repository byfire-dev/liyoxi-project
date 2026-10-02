# 「狸有戏」外部能力调研：云媒体、AI 基础能力与托管数据服务

- 查证日期：2026-10-02（所有价格均为该日查到的官网刊例价，未含折扣、资源包与新客优惠）
- 用途：供技术架构与选型文档直接引用
- 范围：对象存储与点播、预签名与 CDN 鉴权、打包下载、证照 OCR、语音转写、多模态理解、内容安全、托管数据库与缓存、PG/Redis 版本

## 0. 证据标注与口径

| 标注 | 含义 |
| --- | --- |
| 【官】 | 本次直接打开了厂商官方文档页并从中提取（提取由摘要模型完成，数字建议落合同前再人工复核一次） |
| 【摘】 | 来自搜索引擎对官方文档的摘要，未能直接打开原页（火山引擎、智谱、阿里云百炼价格页多为前端渲染，抓取为空） |
| 【三方】 | 第三方站点（endoflife.date、开发者社区文章等），仅作旁证 |
| 【资料】 | PRD、原型、参考工程里明确写了的 |
| 【推断】 | 我根据上述事实做的推断或设计建议，不是资料或官方文档原话 |

未能核实、需要 PoC 的地方在正文里单独写明“不确定”。

---

## 1. 结论速览

| 主题 | 结论 |
| --- | --- |
| 存储底座 | **腾讯云 COS 私有读桶**作为全部文件的唯一底座，沿用参考工程的 S3 兼容 `StorageProvider`；敏感证照单独桶或单独前缀 + 服务端加密 + 分钟级预签名 |
| 媒体处理 | **数据万象 CI**（转码、HLS 自适应、明水印、多文件打包、内容审核都挂在 COS 桶上，按量计费，无最低消费） |
| 预告片播放 | 首选 **COS + CI 转 HLS 自适应 + 腾讯云 CDN（备案自有域名）+ 回源鉴权 + CDN 鉴权只签 m3u8**；若 PoC 不过，退到**腾讯云点播 VOD 子应用只承载预告片与样片**（Key 防盗链原生支持 M3U8）。两条路成本都在每月百元以内 |
| 样片 | 单集 MP4（剪辑师导出或 worker 用 ffmpeg 压明水印）+ 分钟级预签名 URL，不需要 HLS |
| 成片下载 | **按集直链为主**：业务侧发“下载授权”（7 天，后台可配 1–30 天，可重新生成），每次点下载时再换**分钟级预签名 URL**；不把 7 天写进 URL 签名 |
| 打包下载 | **CI 多文件打包压缩异步预打包**（≤1000 个文件、≤50GB、0.05 元/GB），只给电脑端用；小程序内只做按集下载（`wx.downloadFile` 单文件 200MB 上限） |
| 小程序上传 | 小文件沿用参考工程的预签名 POST；视频（≤200/500MB）改用 **cos-wx-sdk-v5 分块上传 + STS 临时密钥**（自带断点续传） |
| 后台上传 | **cos-js-sdk-v5** `uploadFile`/`uploadFiles` 分块并发 + 断点续传 + STS；原片批量入库可用 COSBrowser/COSCLI 加“登记清单” |
| 证照 OCR | 营业执照：**腾讯云 BizLicenseOCR**（0.15 元/次，每月 1000 次免费）；食品经营许可证等行业许可证：**文档抽取（多模态版）**或多模态大模型抽字段，人工复核兜底 |
| 语音转写 | **腾讯云录音文件识别**（参考工程已接；1.75 元/小时，每月 10 小时免费；大模型引擎覆盖 31 种方言）；备选火山豆包录音文件识别 0.8 元/小时 |
| 素材理解 | OpenAI 兼容的 `LlmProvider`，按角色（text / vision / audio）配置；视觉主选**豆包 Seed 2.0 lite/mini 或千问 VL**，备 DeepSeek-flash（支持图片）、混元、GLM；**不建议沿用参考工程生产上的 OpenRouter（境外）** |
| 内容安全 | 法规没有逐条要求机审，但广告成片有《广告法》的人工核对义务；建议商家素材与广告成片过一遍 **CI 内容审核**（图片 1.5 元/千次）做辅助，人工终审 |
| 数据库 | **托管 PostgreSQL 双节点高可用**从第一天就上（支付与积分账本）；备份保留调到 30 天并开 PITR；Redis 可托管 1GB 主从或自建，但账本状态不能只放 Redis |
| 部署云 | 应用服务器与 COS **同云同地域**（建议腾讯云），V2.0 自动合成后 worker 与存储之间的流量会很大，跨云公网 0.5 元/GB 不可持续 |
| 版本 | PostgreSQL 取 **17**（稳妥）或 18（当前最新稳定 18.6）；19 仍在 Beta 4，不用。Redis 托管选“兼容 Redis 7.0”或 Valkey 8；自建选 Valkey 8/9 或 Redis 7.x |

---

## 2. 场景与量级假设（粗算用）

资料里给出的硬约束：

| 项 | 约束 | 出处 |
| --- | --- | --- |
| 预告片 | ≤3 分钟；首帧 ≤1.5 秒；多码率自适应；CDN 加速 | PRD 7.2 短剧库管理（PRD.md:751）、10.1（PRD.md:1027） |
| 视频防护 | 预告片与样片加水印；播放地址签名并设有效期；防盗链；成片包下载链接签名、7 天有效，仅订单商家及其授权的服务商可下载 | PRD 10.2-2（PRD.md:1036） |
| 成片包 | 按集下载或打包下载；链接 7 天有效，过期可重新生成 | PRD 6.10.1 发布任务（PRD.md:597） |
| 链接有效期可配 | “成片包下载链接有效期”1–30 天 | 后台原型 SysParams 画板（slim/admin/SysParams.txt，`R('pkg', …, '天', 1, 30)`） |
| 成片包大小 | 示例：80 集约 2.6GB、60 集约 1.9GB；45 集 3.1GB、80 集 5.4GB、36 集 2.2GB | 商家端 Publish 画板、后台 Delivery 画板 |
| 上传 | 图片 ≤5MB（超出先压缩）；视频 ≤200MB、支持断点续传 | PRD 10.1（PRD.md:1030） |
| 门店素材 | 图片每次 ≤9 张；拍摄视频 ≤60 秒；相册视频 ≤5 分钟、500MB；录音 ≤5 分钟；文字 ≤500 字 | PRD 6.16.3 门店素材（PRD.md:726） |
| 证照 | 营业执照 OCR 识别主体名称、统一社会信用代码、经营者、有效期；行业许可证按品类配置 | PRD 6.3.4 资质认证（PRD.md:451–452）、7.4 商家管理第 3 条（PRD.md:775） |
| 素材自动处理 | 上传后自动转写、识别内容并打内容标签，交付经理复核 | PRD 6.16.3 第 1 条（PRD.md:729） |
| 备份 | 每日备份，保留 30 天 | PRD 10.2-5（PRD.md:1039） |
| 可用性 | 不低于 99.9% | PRD 10.1（PRD.md:1029） |

粗算假设【推断】：

| 量 | 早期（数百商家） | 增长期（约 10 倍） |
| --- | --- | --- |
| 订购单 | 100 单/月 | 1000 单/月 |
| 每单成片 | 60 集 × 约 50MB ≈ 3GB（按原型示例 32–69MB/集折中） | 同左 |
| 每月新增成片 | 300GB | 3TB |
| 原片库（一次性） | 200 部 × 60 集 × 60MB ≈ 720GB | 1000 部 ≈ 3.6TB |
| 商家素材 | 约 300GB 累计 | 约 3TB 累计 |
| 成片下载流量 | 每单下 1.5 遍 ≈ 450GB/月 | 4.5TB/月 |
| 预告片播放流量 | 约 135GB/月（300 商家 × 30 次 × 15MB） | 约 1.4TB/月 |
| 预告片转码（一次性） | 200 条 × 2.5 分钟 × 3 档 | 1000 条 |

---

## 3. 对象存储 + 点播方案对比

### 3.1 能力矩阵

| 能力 | 腾讯云 COS + 数据万象 CI（或 MPS） | 腾讯云点播 VOD | 阿里云 OSS + 视频点播 / IMM | 火山引擎 veVOD |
| --- | --- | --- | --- | --- |
| 转码、HLS 自适应 | CI 支持“自适应码流”，一次生成多码率 HLS/DASH；模板 + 工作流（单桶最多 10 条工作流）【摘 [CI 功能概览](https://cloud.tencent.com/document/product/460/53155)、[数据工作流](https://cloud.tencent.com/document/product/460/46488)】 | 转自适应码流模板 + 任务流【摘 [转自适应码流](https://cloud.tencent.com/document/product/266/34071)】 | VOD 转码模板组、HLS 打包；IMM 做文件处理【官 [VOD 计费](https://help.aliyun.com/zh/vod/product-overview/billing-of-basic-services)】 | 转码模板、自适应码流 + VePlayer【摘】 |
| 明水印 | CI 视频明水印任务与模板【摘】 | 转码模板带水印 | 支持 | 水印贴片模板【摘】 |
| 数字 / 溯源水印 | CI 数字水印 0.38–0.5 元/分钟【官 [CI 媒体处理费用](https://cloud.tencent.cn/document/product/460/58120)】 | 版权水印、溯源水印、幽灵水印【摘 [版权保护综述](https://cloud.tencent.com/document/product/266/45552)】；**溯源水印仅支持 HLS、仅支持 7 分钟及以上视频做溯源检测，且与版权水印不能同时加**【官 [溯源水印](https://cloud.tencent.com/document/product/266/75789)】 | 有（未逐项核实） | 有私有加密（未逐项核实） |
| URL 鉴权 / 防盗链 | COS 预签名 URL；CDN TypeA–D 时间戳鉴权 + Referer；私有桶回源鉴权【官 [域名管理概述](https://cloud.tencent.com/document/product/436/18424)、[TypeA](https://cloud.tencent.com/document/product/228/41623)】 | Key 防盗链：过期时间 `t`、试看 `exper`、IP 数 `rlimit`（最大 9），**文件类型含 M3U8**【官 [Key 防盗链](https://cloud.tencent.com/document/product/266/14047)】；Referer 防盗链 | OSS 签名 URL + CDN URL 鉴权 | Referer / IP 黑白名单 + 时间戳防盗链【摘】 |
| 私有 HLS | CI “获取私有 m3u8”（`ci-process=pm3u8`，`expires` 3600–43200 秒，请求走 COS 源站域名，收费）【官 [获取私有 m3u8](https://cloud.tencent.com/document/product/460/63738)】 | Key 防盗链覆盖 | CDN 鉴权 + M3U8 改写（未核实） | 未核实 |
| 小程序播放 | 原生 `<video>` 播 HLS/MP4 | 原生 `<video>` 播 URL；另有“小程序播放器插件 License”刊例 30,000 元/年，**非必需**【官 [VOD 按量计费（新）](https://cloud.tencent.com/document/product/266/95125)】 | 原生 `<video>` | 微信 / 抖音小程序播放器 SDK【摘】 |
| 小程序上传 SDK | **cos-wx-sdk-v5**：`uploadFile` 高级上传，`SliceSize` 默认 1MB，超过即分块，分块默认断点续传（同一文件同一路径自动校验续传）【官 [小程序 SDK 上传对象](https://cloud.tencent.com/document/product/436/64991)】 | **vod-wx-sdk-v2**：“默认支持断点续传和分片上传”；合法域名只需加 `vod2.qcloud.com`；任务流写在上传签名里（文档 2026-01-14 更新）【官 [小程序端上传 SDK](https://cloud.tencent.com/document/product/266/18177)】 | VOD 微信小程序上传 SDK 1.0.3（2024-07-15），支持分片与断点续传【摘 [上传 SDK](https://www.alibabacloud.com/help/zh/vod/developer-reference/upload-sdk-for-wechat-mini-programs)】 | `tt-uploader-miniprogram` 2.3.3，支持微信、抖音小程序【摘 [集成小程序上传 SDK](https://docs.volcengine.com/docs/4/1125374?lang=zh)】 |
| Web 大文件上传 | **cos-js-sdk-v5** `uploadFile`：小文件简单上传、大文件分块，默认断点续传，`ChunkParallelLimit` 控并发【摘 [JS SDK 上传对象](https://cloud.tencent.com/document/product/436/64960)】 | vod-js-sdk-v6【摘 [Web 端上传 SDK](https://cloud.tencent.com/document/product/266/9239)】 | aliyun-upload-sdk / ali-oss | Web 上传 SDK |
| 事件回调 | CI 任务回调 URL 或队列回调；COS 事件可接云函数 / 事件总线 | 任务流完成回调（HTTP 或可靠回调拉取） | VOD 事件通知（HTTP / MNS） | 回调 |
| 文件型资产（成片包、文档、证照） | 原生适合 | 不适合（媒资模型，下载授权与打包都要绕） | OSS 适合 | 不适合 |
| 多文件打包 | CI 多文件打包压缩（见第 5 节） | 无 | IMM `CreateFileCompressionTask`：最多 8 万个文件、打包前总量 ≤200GB，目前“只打包不压缩”【摘 [IMM 文档](https://help.aliyun.com/zh/imm/developer-reference/api-imm-2020-09-30-createfilecompressiontask)】 | 无 |
| 与参考工程衔接 | **直接复用**：S3 兼容 `StorageProvider`、预签名 POST、`presign → 直传 → confirm(HEAD)`、MinIO 本地开发 | 需新增一套媒资 ID / 上传签名 / 回调模型 | 需换云、换 SDK、重配小程序合法域名 | 同左 |

微信小程序侧的硬限制：

- `<video>` 组件官方格式表里 m3u8 在 iOS、Android 均标为支持；社区有个别安卓机型播 HLS 失败的反馈，上线前要做真机矩阵【摘 [微信开放社区](https://developers.weixin.qq.com/community/develop/doc/000462caeece88686e9959dd55b800)、【三方】[DTeam 兼容性测试](https://blog.dteam.top/posts/2020-07/wechat-mini-program-supported-videos.html)】。
- `wx.downloadFile` 单次下载最大 200MB，默认超时 60 秒可调【摘 [微信开放社区多帖引用官方文档](https://developers.weixin.qq.com/community/develop/doc/00026a2b114dc02fbc33877b266400)】；参考工程 ADR 也记了同一限制（docs/02-architecture.md:175）。
- 上传、下载域名必须是已备案域名并登记到小程序后台；参考工程生产用的是 COS 桶默认域名（docs/07-platform-config.md:31–41）。

### 3.2 价格对照（中国大陆，按量刊例价）

| 计费项 | 腾讯云 COS / CI / CDN | 腾讯云 VOD | 阿里云 VOD（OSS 另列） | 火山 veVOD |
| --- | --- | --- | --- | --- |
| 标准存储 | 0.118 元/GB/月【官 [COS 计费示例](https://cloud.tencent.com/document/product/436/6241)】；归档 0.03 元/GB/月【官 同上】 | 0.0048 元/GB/日（≈0.144 元/GB/月）；低频 0.0038、归档 0.0012 元/GB/日【官 [VOD 按量计费（新）](https://cloud.tencent.com/document/product/266/95125)，文档 2026-09-21 更新】 | 0.12 元/GB/月【官 [VOD 基础服务计费](https://help.aliyun.com/zh/vod/product-overview/billing-of-basic-services)】；OSS 标准型 0.09–0.12 元/GB/月【三方，未核实】 | 0.099 元/GiB/月【摘】 |
| 下行流量 | CDN 0–2TB 0.21、2–10TB 0.20、10–50TB 0.18 元/GB【官 [CDN 基础服务计费](https://cloud.tencent.com/document/product/228/75562)】+ COS 的 CDN 回源流量 0.15 元/GB【官 COS 计费示例】；不走 CDN 时 COS 外网下行约 0.5 元/GB【三方，官网定价页未抓到】 | 0.24 元/GB（<500GB），500GB–2TB 0.23，2–50TB 0.22【官】 | 0.24 元/GB（0–10TB）【官】；OSS 外网流出忙时 0.5、闲时 0.25 元/GB【三方】 | 0.22 元/GB（0–10TB）【摘】 |
| H.264 普通转码 | CI：480p 0.016、720p 0.0325、1080p 0.063 元/分钟，按输出时长【官 [CI 媒体处理费用](https://cloud.tencent.cn/document/product/460/58120)，2026-06-05 更新】；MPS 同价【官 [MPS 按量计费](https://cloud.tencent.com/document/product/862/36180)】 | 480p 0.016、720p 0.032、1080p 0.061 元/分钟；自适应码流按各子流分别计【官】 | 480p 0.0217、720p 0.0326、1080p 0.0651 元/分钟；转封装 0.007【官】 | 1080p 及以下 0.0651 元/分钟【摘】 |
| 数字水印 | CI 0.38–0.5 元/分钟【官】；MPS 0.4–1.73 元/分钟，提取 15–60 元/次【官】 | 1080p 添加约 0.416 元/分钟、提取约 0.848 元/分钟【官】 | 未核实 | 未核实 |
| 多文件打包 | 0.05 元/GB，按打包前大小【摘 [CI 文件处理费用](https://cloud.tencent.com/document/product/460/82333)】 | — | IMM 另计（未核实） | — |
| 请求 | 读写 0.01 元/万次【官】 | — | — | — |

### 3.3 月成本粗算（刊例价、不含资源包）【推断】

早期（第 12 个月，累计约 4.6TB）：

| 项 | COS + CI + CDN | 全放腾讯云 VOD | 阿里云 VOD | 火山 veVOD |
| --- | --- | --- | --- | --- |
| 存储 4.6TB | 4,600 × 0.118 ≈ 543 元 | 4,600 × 0.144 ≈ 662 元 | ≈ 552 元 | ≈ 455 元 |
| 成片下载 450GB | COS 直出 0.5 → 225 元；或 CDN 0.21 + 回源 0.15 → 162 元 | 108 元 | 108 元 | 99 元 |
| 预告片播放 135GB | CDN + 回源 ≈ 49 元 | 32 元 | 32 元 | 30 元 |
| 预告片转码（一次性） | 200 × 2.5 × (0.063 + 0.0325 + 0.016) ≈ 56 元 | ≈ 55 元 | ≈ 60 元 | ≈ 60 元 |
| 月合计 | **约 750–820 元** | 约 800 元 | 约 690 元 | 约 590 元 |

增长期（约 10 倍、不做生命周期）：存储 40TB 级 ≈ 4,700–5,800 元/月，下载 4.5TB ≈ 1,000–2,250 元/月。

读法：

1. 各家差距只有每月一两百元，**价格不是决定因素**，接入成本和运维复杂度才是。
2. 存储是最大头且只增不减。成片在使用期结束后应转归档或删除（COS 归档 0.03 元/GB/月，约为标准的四分之一）；原片库保持标准存储。这需要业务定“成片保留多久”。
3. 成片若改由云端转码或加数字水印，会多出每月 12,000 分钟 × 0.063 ≈ 756 元（转码）或 × 0.4 ≈ 4,800 元（数字水印）。V1.0 成片由剪辑师线下合成后上传，不需要这笔钱。

### 3.4 推荐与理由

**推荐：腾讯云 COS（私有读）+ 数据万象 CI + 腾讯云 CDN（备案自有域名）；点播 VOD 只作为预告片播放的备选。**

理由：

1. 本产品 90% 以上的字节是“文件”而不是“流”：原片、成片包、素材、证照、合同、发票。它们要的是私有读、预签名、生命周期、打包，这是对象存储的本职；点播产品的媒资模型在这些场景反而碍事。
2. 真正需要“点播体验”的只有预告片（每部剧 1 条、≤3 分钟）和样片（每单 1 集左右），量很小。
3. 参考工程已经有一套跑在生产上的 COS 接法：S3 兼容驱动（`packages/services/src/providers/storage/s3.ts:21–44`，`createPresignedPost`）、`POST /uploads/presign → Taro.uploadFile 直传 → POST /uploads/confirm HEAD 校验 → 24 小时清理未确认对象`（docs/02-architecture.md:89）、本地 MinIO（infra/compose.yml:37）。直接复用，新增的只是“大文件分块”和“私有读”两件事。
4. CI 与 COS 同桶，转码、打包、审核都是对桶内对象提任务，不需要搬数据。
5. ASR、OCR、短信参考工程都已在腾讯云（docs/02-architecture.md:52），账号、密钥、签名工具（`providers/tencent/sign.ts`）可复用。

与参考工程不同、必须改的三点：

| 参考工程现状 | 本产品要求 | 改法 |
| --- | --- | --- |
| 公有读桶 + 随机不可猜 key（ADR-008，docs/02-architecture.md:106；docs/07-platform-config.md:111） | 证照敏感、成片仅订单商家可下、播放地址要签名 | 桶改**私有读**，读一律走预签名或 CDN 鉴权 |
| 单次预签名 POST 直传（无分块、无续传） | 视频 ≤200/500MB、要断点续传 | 视频走 cos-wx-sdk-v5 / cos-js-sdk-v5 分块 + STS |
| 对外基址是桶默认域名、未接 CDN（docs/07-platform-config.md:31） | 预告片要 CDN 加速 | 新增备案的媒体域名并接 CDN；小程序 downloadFile / request 合法域名同步登记 |

桶与域名规划建议【推断】：

| 桶 / 前缀 | 内容 | 读权限 | 备注 |
| --- | --- | --- | --- |
| `lyx-private`：`license/` | 证照、合同、发票、转账凭证 | 私有；预签名 GET 5–10 分钟；访问记审计日志 | 开服务端加密；也可单独一个桶，方便单独授权与审计 |
| `lyx-private`：`asset/` | 商家素材（图、视频、录音、文档） | 私有；预签名 GET | ASR、审核、视觉模型都用预签名 URL 拉取 |
| `lyx-media`：`master/` | 短剧原片 | 私有；仅内部 | 不对外，不接 CDN |
| `lyx-media`：`trailer/`、`poster/` | 预告片 HLS、海报、缩略图 | 私有 + CDN 回源鉴权；m3u8 走 CDN 鉴权 | 海报可以只做 Referer 防盗链 |
| `lyx-media`：`sample/` | 样片、广告视频 | 私有；预签名 GET 1–2 小时 | 带明水印 |
| `lyx-media`：`final/{orderId}/` | 成片、成片包 zip | 私有；按次预签名 | zip 设生命周期自动删除 |

注意：2024 年 1 月后创建的桶“不支持使用默认域名在浏览器预览文件”【官 [生成预签名 URL](https://cloud.tencent.com/document/product/436/35153)】。后台要在浏览器里直接打开 PDF、图片时需要自定义域名。

### 3.5 预告片：HLS 自适应 + 签名 + CDN 的三种做法

预告片同时要“多码率自适应、CDN、签名有效期、水印”，这是全方案里唯一有技术不确定性的地方。

| 方案 | 做法 | 优点 | 问题 |
| --- | --- | --- | --- |
| A. COS + CI + CDN，只签 m3u8 | CI 转 HLS 自适应（1080/720/480）并压明水印；CDN 开回源鉴权；CDN 鉴权配置的“鉴权对象”选“指定文件后缀”只对 `.m3u8` 鉴权【官 [CDN URL 鉴权](https://cloud.tencent.com.cn/document/product/228/76110)：鉴权对象支持全部文件 / 指定后缀 / 指定后缀不鉴权】；ts 分片靠不可猜路径 + Referer 白名单（`servicewechat.com`） | 只用一套存储；成本最低 | ts 本身没有签名；多级 m3u8（主清单 → 子清单）里子清单的签名要自己处理（把子清单也当成需签名对象并由后端改写主清单，或子清单不鉴权）。**需要 PoC** |
| B. COS + CI 私有 m3u8 | 请求 `?ci-process=pm3u8&expires=3600`，返回的 m3u8 里 ts 自带签名【官 [获取私有 m3u8](https://cloud.tencent.com/document/product/460/63738)】 | ts 也有签名 | 文档里的请求域名是 COS 源站域名，**是否能走 CDN、是否支持自适应主清单，文档没写**；接口收费；有效期只能 1–12 小时 |
| C. 腾讯云 VOD 子应用只放预告片（和样片） | 运营在后台用 VOD Web 上传 SDK 或服务端拉取上传；任务流 = 自适应码流模板 + 水印模板；播放用 Key 防盗链 URL，小程序原生 `<video>` 直接播 | Key 防盗链文档明确支持 M3U8；首帧、秒开、防盗链都是产品化能力 | 多一套媒资 ID 与回调；商家端完全不碰 VOD 上传，所以复杂度只在后台与服务端 |

建议【推断】：架构文档里把预告片播放抽象成 `MediaPlaybackProvider`（输入：资产 ID；输出：带有效期的播放地址与封面），V1.0 先做方案 A 的 PoC（半天到一天），不过就落到方案 C。无论哪种，播放地址都由接口现签、有效期 1–2 小时，不落库、不进缓存页。

首帧 ≤1.5 秒的做法【推断】：HLS 切片 2–4 秒、关键帧间隔对齐切片、最低档 480p 起播、`<video>` 给 `poster`、列表页不预加载；MP4 兜底时要 `faststart`（moov 前置）。

### 3.6 水印

- 预告片、样片的“加水印”用**明水印**即可：CI 转码时关联水印模板，或由 worker 的 ffmpeg 压制（参考工程已有 ffmpeg 渲染与抽帧能力，ADR-034、ADR-061）。
- **溯源 / 数字水印不建议放进 V1.0**：腾讯云 VOD 溯源水印只支持 HLS 且只支持 7 分钟及以上的视频做溯源检测【官】，短剧单集 1–3 分钟不满足；CI / MPS 的数字水印 0.4 元/分钟起【官】，对每月上万分钟的成片是一笔明显的钱。
- 成片是商家要公开发布的内容，不能加可见平台水印；“被搬运到其他账号”的溯源（PRD 7.7 发布管理第 6 条“作品巡检”，PRD.md:807）更适合靠定制成片本身带的门店广告与片头信息来识别【推断】。

### 3.7 上传

小程序（商家端）：

| 文件 | 上限 | 建议 |
| --- | --- | --- |
| 图片 | 5MB，超出先 `compressImage` | 预签名 POST 直传（沿用参考工程）；参考工程 ADR-032 已有“超 5MB 逐级降质”的做法 |
| 录音、文档 | 录音 ≤5 分钟（m4a/mp3 约 1–5MB） | 预签名 POST 直传 |
| 视频 | 建档 ≤200MB；相册视频 ≤500MB / 5 分钟 | cos-wx-sdk-v5 `uploadFile`，`SliceSize` 设 5–10MB；STS 临时密钥由后端按“主体 / 门店 / 本次上传 key”收窄权限下发；失败与切后台后重进可续传 |

- STS 临时密钥有效期：默认 1800 秒，主账号最长 7200 秒，子账号最长 129600 秒（36 小时）【摘 [STS GetFederationToken](https://cloud.tencent.com/document/product/1312/48195)】。上传用 30 分钟足够。
- cos-wx-sdk-v5 的分块请求走 `wx.request`，所以桶域名除了登记到 uploadFile 合法域名，还要登记到 **request 合法域名**【推断，SDK 工作方式】。
- 用了 cos-wx-sdk-v5 以后，本地 MinIO 不能模拟分块上传，开发联调需要一个开发用 COS 桶【推断】。如果想保持云中立，替代做法是后端用 S3 API 逐块预签名 `UploadPart`，小程序自己切块上传，工作量更大。
- 同一功能点 PRD 有两个数字：10.1 写“视频单个不超过 200MB”，6.16.3 写“相册视频单条不超过 5 分钟、500MB”。技术上分块上传两者都能支持，需要业务确认按 500MB 做。
- 完成后仍走参考工程的 `confirm`（服务端 HEAD 校验大小与类型）再入库，不依赖 COS 事件通知。

后台 Web（运营、剪辑师）：

- cos-js-sdk-v5 `uploadFile` / `uploadFiles`：分块并发、断点续传、进度回调；凭证用 STS，权限收窄到工单目录。
- 一单 30–100 个文件、2–5GB，需要“批量选择、队列并发 3–5、失败单文件重试、按集文件名自动匹配集数、完成后服务端按清单核对集数与大小”。
- 原片入库（每部 30–100 集）可以直接用 COSBrowser / COSCLI 传到 `master/{dramaId}/`，后台提供“按目录登记”的动作【推断】。

### 3.8 事件回调

| 事件 | 建议 |
| --- | --- |
| 客户端上传完成 | 客户端调 `confirm`，服务端 HEAD 校验（参考工程做法）；不引入云函数 |
| CI 转码、打包、审核任务完成 | 任务带回调 URL 打到 API；同时 worker 定时轮询未终结任务做兜底（回调可能丢） |
| ASR 完成 | `CallbackUrl` 或轮询；参考工程是建任务 + 轮询（ADR-043） |
| 回调安全 | 回调地址带不可猜 token，回调体只当“提醒”，状态以回查云端任务为准【推断】 |

---

## 4. 预签名 URL、CDN 鉴权与成片下载

### 4.1 有效期上限

| 方式 | 上限 | 出处 |
| --- | --- | --- |
| COS 原生签名 + 永久密钥 | 文档未规定上限：“永久密钥不会过期，预签名 URL 的有效期取决于您设置的签名有效期”；请求签名文档对 `q-sign-time` 也没有写最大值 | 【官】[使用预签名 URL 访问 COS](https://cloud.tencent.com/document/product/436/68284)（2024-06-21 更新）、[请求签名](https://cloud.tencent.com/document/product/436/7778) |
| COS + STS 临时密钥 | URL 有效期 = min（签名有效期，临时密钥剩余有效期）；临时密钥最长 36 小时（子账号），主账号 2 小时 | 【官】同上；【摘】STS 文档 |
| S3 兼容接口 + SigV4（**参考工程现在用的 AWS SDK**） | `X-Amz-Expires` 最大 604800 秒（7 天），SDK 在客户端就会拒绝更大的值 | AWS S3 SigV4 规范（[官方文档](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html)，本次页面抓取为空，属通识，未现场核对） |
| 阿里云 OSS V4 签名 | 长期 AccessKey 最大 7 天；STS 凭证最大 12 小时 | 【摘】[OSS 预签名文档](https://help.aliyun.com/zh/oss/user-guide/upload-files-using-presigned-urls) |
| 腾讯云 CDN 时间戳鉴权 TypeA–D | 有效时长是**域名级配置**，最大 630720000 秒；URL 里带的是起始时间戳，过期 = 时间戳 + 配置时长；支持主备密钥 | 【官】[TypeA](https://cloud.tencent.com/document/product/228/41623) |
| 腾讯云 VOD Key 防盗链 | `t` 为十六进制过期时间戳，逐 URL 指定；文档未写上限；实际过期比指定晚约 5 分钟 | 【官】[Key 防盗链](https://cloud.tencent.com/document/product/266/14047) |

要点：

- 后台原型把“成片包下载链接有效期”做成 1–30 天可配。如果把业务有效期直接写进 URL 签名，S3 SigV4 的 7 天上限、STS 的 36 小时上限都会撞墙。
- 用永久密钥签长期 URL 等于发出一张撤不回的通行证（要撤只能轮换密钥或改对象 key），腾讯云文档也建议永久密钥签名“设置为完成本次上传或下载操作所需的最短期限”【官】。

### 4.2 私有桶 + CDN 回源鉴权

腾讯云文档给出的四种组合【官 [域名管理概述](https://cloud.tencent.com/document/product/436/18424)】：

| 回源鉴权 | CDN 鉴权配置 | CDN 域名访问 | COS 源站域名访问 | 定位 |
| --- | --- | --- | --- | --- |
| 开 | 开 | 需 URL 鉴权 | 需 COS 签名 | 全链路保护（推荐） |
| 开 | 关 | 可直接访问 | 需 COS 签名 | 只保护源站 |
| 关 | 开 | 需 URL 鉴权 | 需 COS 签名 | 不推荐 |
| 关 | 关 | 不可访问 | 需 COS 签名 | 不推荐 |

回源鉴权的前提是添加 CDN 服务授权。CDN 鉴权的有效时长是域名级的，如果要“每条 URL 不同有效期”，做法是把 URL 里的时间戳写成“期望过期时间 − 配置时长”【推断】。

### 4.3 “7 天有效、可重新生成、仅订单商家可下”的做法【推断】

把“链接有效期”做成**业务对象**，而不是签名参数：

1. 交付推送时生成一条 `download_grant`：订购单、成片版本、`expires_at = 推送时间 + N 天`（N 取系统参数，1–30）、状态、生成人。“重新生成”就是新建一条并作废旧的。
2. 商家在小程序点“下载第 n 集”时调接口；服务端校验三件事：登录身份属于该订单的经营主体且角色是老板（V1.1 加“被授权的服务商”）、授权未过期未作废、订单状态允许。
3. 通过后现签一条**短时效预签名 GET**（建议 10–30 分钟，足够下完一集），带 `response-content-disposition` 指定文件名；同时记一条下载日志（PRD 埋点 `package_download` 也在这里产生）。
4. 这样“7 天 / 30 天”由业务表控制，签名永远是短的；授权可随时撤销；每次下载都重新鉴权，“仅订单商家可下”是真约束而不是靠链接不外传。
5. 成片下载走 COS 源站域名即可：早期每月几百 GB，走 CDN 只省几十元，却要多处理一层 CDN 鉴权。量上来后再把 `final/` 接到 CDN 域名（TypeA 鉴权 + 回源鉴权）。

电脑端下载【推断】：抖音、视频号批量发布几十集，多数商家会在电脑上操作，而小程序里拿到的文件在手机相册。建议提供一个极简的电脑下载页：页面显示二维码 → 商家用小程序扫码确认 → 该浏览器会话获得这张订单的下载权（同样受 `download_grant` 约束）→ 页面列出按集直链与“打包下载”。这样不需要把长期有效的链接复制到电脑上。是否做这个页面需要业务确认（原型里只有小程序内的“下载”按钮）。

小程序内按集下载的限制：

- 单文件 ≤200MB（原型示例单集 32–69MB，满足）。
- 流程是 `wx.downloadFile` → `wx.saveVideoToPhotosAlbum` → 删除临时文件，逐集串行；80 集约 2.6–5.4GB，要有进度、断点（记住已保存的集）、失败重试，并提示连 Wi-Fi【推断】。
- 下载域名要登记到 downloadFile 合法域名（参考工程 docs/07-platform-config.md:37、41 记过“换域名不同步登记会在真机上静默失败”）。

---

## 5. 多文件打包下载

### 5.1 COS / CI 的“多文件打包压缩”

| 项 | 内容 | 出处 |
| --- | --- | --- |
| 接口 | `CreateFileProcessJobs`，`Tag=FileCompress`；异步任务，结果写回指定桶与对象 | 【官】[提交多文件打包压缩任务](https://cloud.tencent.com/document/api/436/83112) |
| 输入方式 | `UrlList`、`Prefix`、`KeyConfig` 三选一，优先级 UrlList > Prefix > KeyConfig | 【官】同上 |
| 文件数 | KeyConfig 方式“个数不能超过 1000” | 【官】同上 |
| 总大小 | “总大小不超过 50G” | 【官】[CI 文件压缩](https://cloud.tencent.cn/document/product/460/108574) |
| 格式 | zip、tar、tar.gz；`Flatten` 可去掉目录结构；`IgnoreError` 可选 | 【官】 |
| 限制 | 不支持归档、深度归档存储类型；低频存储会产生取回费 | 【官】 |
| 计费 | 0.05 元/GB，按打包前大小；另有 COS 读请求费 | 【摘】[文件处理费用](https://cloud.tencent.com/document/product/460/82333) |
| 回调 | 回调 URL 或消息队列 | 【官】 |

按原型示例，一单 2–5.4GB、36–80 个文件，远在 1000 个 / 50GB 之内；一单打包费 0.1–0.27 元。zip 落桶后会让该订单的存储在保留期内翻倍，给 zip 前缀设生命周期（比如到期后 1 天删除）。

### 5.2 服务端流式 zip 的可行性与成本【推断】

- 技术上可行：视频已压缩，用“只存储不压缩”的 zip，服务端边从 COS 读边向客户端写，内存占用很小。
- 不建议的原因：
  1. 流量走两遍：COS → 应用服务器（跨云时按 0.5 元/GB 计 COS 外网下行）→ 用户（应用服务器出网带宽）。
  2. 单机 ECS 的带宽通常只有几 Mbps，5GB 要下几个小时，期间占住连接，也挤占接口带宽。
  3. 流式 zip 很难支持断点续传，几 GB 的下载中途断了只能重来。
  4. 参考工程生产机只有 1.8GB 内存、2 vCPU（docs/08-deployment.md:16），再加长连接下载不现实。

### 5.3 现实做法

| 场景 | 做法 |
| --- | --- |
| 小程序内 | 只做**按集下载并存相册**；“全部下载”是客户端逐集串行，不是 zip（zip 超过 200MB 下不了，下了也进不了相册） |
| 电脑端 | **按集直链 + 清单**为默认（浏览器可并发、可单集重试）；“打包下载”= CI 异步预打包的 zip 直链 |
| 何时打包 | 交付推送时预打包（推送动作本身就是异步的），或首次点“打包下载”时触发并提示“约需几分钟”；zip 的有效期与 `download_grant` 一致，过期删除，“重新生成”时重打 |
| 超限兜底 | 文件数 >1000 或总量 >50GB 时自动分卷（短剧场景基本不会触发） |
| 发布清单 | 标题、话题、简介随成片一起给：小程序里“复制”，电脑端附一份 xlsx 或 txt 进 zip |

---

## 6. 证照识别（OCR）

### 6.1 接口与价格

| 厂商 | 营业执照 | 食品经营许可证等 | 价格（后付费最低阶梯） | 免费额度 | 出处 |
| --- | --- | --- | --- | --- | --- |
| 腾讯云 OCR | `BizLicenseOCR`：统一社会信用代码、名称、主体类型、法定代表人、注册资本、组成形式、成立日期、营业期限、经营范围、地址、登记机关；`EnableCopyWarn` 返回黑白复印件（-9102）、翻拍（-9104）告警；`EnablePeriodComplete` 自动补全营业期限；`EnableBusinessCertificate` 支持“非营业执照的营业类证件”；图片 ≤7MB；默认 10 次/秒 | 官方实践文档推荐用 **文档抽取（多模态版）`SmartStructuralOCR`**，通过 `ItemNames` 指定要抽的字段 | 营业执照 0.15 元/次（0–1 万次），0.10（1–10 万）；资源包 1 千次 120 元。文档抽取（多模态版）短文本 0.48 元/次，资源包 1 千次 360 元起 | 多数接口 1,000 次/月 | 【官】[营业执照识别](https://cloud.tencent.com/document/product/866/36215)、[计费概述](https://cloud.tencent.com/document/product/866/17619)（2026-09-30 更新）、[企业资质证书识别实践](https://cloud.tencent.com/document/product/866/77836) |
| 阿里云 OCR | `RecognizeBusinessLicense` | 有专用接口 `RecognizeFoodManageLicense`（食品经营许可证）、`RecognizeFoodProduceLicense`、医疗器械类许可证等 | 两者均为 0.0825 元/次（≤1 万次），0.0495（1–10 万） | 营业执照 200 次/月【摘】 | 【官】[按量付费](https://help.aliyun.com/zh/ocr/product-overview/pay-as-you-go)、【摘】[免费额度](https://help.aliyun.com/zh/ocr/product-overview/free-quota) |
| 百度智能云 | 营业执照识别 | 价格页未列出食品经营许可证（不确定是否有专用接口） | 营业执照按量约 0.02 元/次起（页面阶梯单位未能确认），次数包 1 万次 200 元 | 页面未写明 | 【官】[OCR 价格](https://cloud.baidu.com/product-price/ocr.html)（数字单位需复核） |
| 微信开放接口 | `POST /cv/ocr/bizlicense`，只能服务端调用 | 无 | 超额需在服务平台购买 | 已认证小程序 100 次/天 | 【摘】[微信官方文档](https://developers.weixin.qq.com/miniprogram/dev/server/API/img-ocr/ocr/api_bizlicenseocr.html) |

### 6.2 准确率口碑

- 没有查到可信的第三方横评。各家自称 98%–99% 以上（如百度“准确率 ≥98%”【摘】），属厂商口径。
- 营业执照是版式固定的高频证照，三家头部厂商在清晰正拍条件下差异不大；差异主要出在翻拍反光、竖版 / 旧版、个体工商户执照、经营者与法定代表人字段映射上【推断】。
- 建议用 30–50 张真实样本（含个体户、分支机构、竖版、手机翻拍）做一次验收，再定主备。

### 6.3 建议【推断】

1. 营业执照：腾讯云 `BizLicenseOCR` 为主（与现有腾讯云账号、签名代码一致；每月 1000 次免费足够早期用量）。PRD 要的四个字段中，“经营者”在公司执照上对应“法定代表人”、在个体户执照上对应“经营者”，要做字段归一。
2. 行业许可证：PRD 写的是“按品类由后台配置”，不只有食品经营许可证（还会有卫生许可证、公共场所卫生许可证等）。专用接口覆盖不全，建议统一走“**通用结构化抽取**”：腾讯云文档抽取（多模态版）或多模态大模型按后台配置的字段清单抽取，输出 JSON。PRD 对行业许可证只要求上传图片、人工审核，OCR 是提效项，可以后置。
3. OCR 结果只是预填：PRD 已规定“商家核对后提交”和后台“证照原图与 OCR 结果并排展示”，人工是终审。把 OCR 原始返回、商家修改后的值分开存，便于审核时看差异。
4. 抽象：`OcrProvider.recognizeBusinessLicense(imageUrl)`、`OcrProvider.extractFields(imageUrl, fieldNames)`；驱动 `tencent`（主）、`aliyun`（备）、`llm`（兜底）。
5. 证照图片是敏感个人信息与经营信息：私有桶、分钟级预签名、访问留痕；OCR 走国内云接口，不发往境外模型。

---

## 7. 语音转写（录音文件，≤5 分钟，中文与方言）

| 服务 | 价格 | 免费额度 | 方言 | 时延与限制 | 出处 |
| --- | --- | --- | --- | --- | --- |
| 腾讯云 录音文件识别 `CreateRecTask` | 1.75 元/小时（月 0–12 万小时）；资源包 1000 小时 1200 元 | 每月 10 小时 | 大模型 2.0 引擎 `16k_zh_en_2.0`：“支持中文、英语、粤语、四川、陕西、河南、上海、湖南、湖北、安徽、闽南、潮汕等 31 种方言” | 异步；“大多数情况下，1 小时的音频 1–3 分钟即可完成识别”，最长 3 小时；URL 方式 ≤5 小时、≤1GB；格式含 mp3、m4a、aac、mp4、wav 等；回调或轮询；默认 20 次/秒 | 【官】[计费概述](https://cloud.tencent.com/document/product/1093/35686)（2026-09-08 更新）、[录音文件识别请求](https://cloud.tencent.com/document/product/1093/37823) |
| 腾讯云 录音文件识别极速版 | 3.10 元/小时（日 0–299 小时） | 每月 5 小时 | — | 同步返回，秒级（通识，未现场核对） | 【官】同上 |
| 腾讯云 一句话识别 | 3.20 元/千次 | 每月 5000 次 | — | ≤60 秒短音频，同步 | 【官】同上 |
| 阿里云百炼 | paraformer-v2 0.00008 元/秒（≈0.29 元/小时）；fun-asr 0.00022 元/秒（≈0.79 元/小时）；qwen3-asr 0.00026 元/秒（≈0.94 元/小时） | 36,000 秒（10 小时），开通后 90 天内 | Qwen3-ASR 称支持 22 种中文方言；Fun-ASR-Nano 7 种方言 + 26 种口音 | 录音文件识别为异步任务 | 【摘】[百炼模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)、[语音识别](https://help.aliyun.com/zh/model-studio/asr-model) |
| 火山引擎 豆包语音 | 录音文件识别（Seed-ASR 2.0）0.8 元/小时；极速版 4.5 元/小时（0–300 小时）；闲时版资源包折合 0.5–1.17 元/小时 | 未核实 | 大模型识别，方言能力未逐项核实 | 标准版异步、极速版同步 | 【摘】[豆包语音计费说明](https://www.volcengine.com/docs/6561/1359370?lang=zh) |
| 大模型语音理解 | 豆包 Seed 2.0 lite（“音视图文统一理解”）0.6–1.8 / 3.6–10.8 元/百万 tokens；千问 Omni 系列 | — | 取决于模型 | 能“边听边总结”，但逐字稿的稳定性、时间戳不如专用 ASR | 【摘】[豆包模型列表](https://www.volcengine.com/docs/82379/1593703) |

用量粗算【推断】：300 家门店 × 每月 10 条录音 × 2 分钟 = 100 小时/月。腾讯云约（100 − 10）× 1.75 ≈ 158 元/月；火山约 80 元/月；阿里云 paraformer 约 29 元/月。绝对值都很小，不构成选型依据。

建议【推断】：

1. 沿用参考工程的 `AsrProvider`（`providers/asr/tencent.ts`，`transcribeFile` = 建任务 + 轮询，ADR-043），引擎用大模型 2.0（`16k_zh_en_2.0`），方言不用单独切引擎。
2. 素材里的**视频口播**也走同一条路：`CreateRecTask` 的格式表里有 mp4，参考工程 ADR-050 已经这么做。
3. “语音转文字 + 自动提炼要点”拆成两步：ASR 出逐字稿 → 文本模型提炼要点与标签。不要用音频大模型一步到位，逐字稿是要展示给商家看的（PRD 6.16.3 素材详情，PRD.md:727）。
4. 时延：≤5 分钟的录音，异步任务通常在十几秒到一两分钟内返回。PRD 6.16.3 对素材处理的时限是“交付经理……原则上 1 个工作日内完成”，异步足够；素材状态“整理中”正好对应。
5. 备选驱动留火山（最便宜的大模型 ASR），接口形态相同（提交任务、查询结果）。

---

## 8. 素材内容识别、自动打标签与要点提炼

### 8.1 多模态模型现状（国内直连）

| 模型 | 图片 | 视频 | 价格（元/百万 tokens，输入 / 输出） | 出处 |
| --- | --- | --- | --- | --- |
| DeepSeek `deepseek-flash` | 支持 | 不支持 | 未命中缓存 1 / 4（低谷）或 2 / 8（高峰：工作日 9–12、14–18 点）；缓存命中 0.02 / 0.04；上下文 1M | 【官】[DeepSeek 模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) |
| DeepSeek `deepseek-v4-pro` | **不支持** | 不支持 | 4.5 / 13.5（低谷）或 9 / 27（高峰） | 【官】同上 |
| 豆包 Seed 2.0 pro | 支持 | 支持 | 3.2 / 16 | 【摘】[火山方舟模型价格](https://www.volcengine.com/docs/82379/1099320)（官方页抓取为空） |
| 豆包 Seed 2.0 lite | 支持（音视图文统一理解） | 支持 | 0.6–1.8 / 3.6–10.8（按输入长度阶梯） | 【摘】同上 |
| 豆包 Seed 2.0 mini | 支持 | 支持 | 0.2–0.8 / 2–8 | 【摘】同上 |
| 千问 `qwen3-vl-plus` | 支持 | 支持（视频文件 URL、本地文件、帧序列；`fps` 抽帧 0.1–10，默认 2.0） | 0–32K：1 / 10；32–128K：1.5 / 15 | 【摘】[qwen3-vl-plus](https://help.aliyun.com/zh/model-studio/qwen3-vl-plus)；视频输入方式【官】[视觉理解](https://help.aliyun.com/zh/model-studio/vision) |
| 千问 `qwen3-vl-flash` | 支持 | 支持 | 0–32K：0.15 / 1.5 | 【摘】同上 |
| 千问通用模型 | 官方视觉文档的示例已换成 qwen3.8-max、qwen3.7-plus | 支持 | 未取到价格 | 【官】[视觉理解](https://help.aliyun.com/zh/model-studio/vision) |
| 腾讯混元视觉 / 视频理解 | 支持 | 支持（视频生文模型） | 3 / 9；新用户 100 万 tokens 免费；服务在向 TokenHub 迁移 | 【官】[混元生文计费](https://cloud.tencent.com/document/product/1729/97731)、[TokenHub 模型价格](https://cloud.tencent.com/document/product/1823/130055)（2026-09-24 更新） |
| 智谱 GLM-4.6V | 支持 | 支持（128K 上下文） | 0–32K：1 / 3；32–128K：2 / 6；GLM-4.6V-Flash 免费 | 【三方】[IT 之家](https://www.ithome.com/0/903/390.htm)等；智谱价格页为前端渲染，未能核对，是否已有更新的视觉型号不确定 |

国内可达性：以上均为国内厂商、国内端点、OpenAI 兼容协议，服务器直连即可。参考工程生产上 LLM 主链路、视觉、音频都走 OpenRouter（境外），火山方舟只作备用（docs/02-architecture.md:51、60），而 ADR-006 的原决定是“国内 OpenAI 兼容端点直连：DeepSeek 主 / 火山方舟豆包备”（docs/02-architecture.md:104）。**本产品处理的是商家门店照片、顾客可能入镜的视频、录音，建议不沿用境外网关**：一是数据出境的合规面，二是网络稳定性（参考工程 ADR-044 专门处理过网关 200 空回包）【推断】。

### 8.2 成本粗算【推断】

- 图片：一张图约 1,000–1,500 输入 tokens。每月 1 万张 × 1,500 = 1,500 万 tokens：豆包 mini 约 3–12 元，qwen3-vl-flash 约 2 元，DeepSeek-flash 约 15–30 元。
- 视频：≤5 分钟，按参考工程 ADR-049 的抽帧曲线（1 分钟 6 帧、每多 1 分钟加 2 帧）约 6–14 帧，成本相当于十来张图；或直接把视频 URL 交给支持视频输入的模型。
- 要点提炼：文本模型，几百到几千 tokens 一条。
- 结论：素材理解每月是**几十元量级**，选模型看效果与稳定性，不看价格。

### 8.3 建议的 Provider 抽象【推断】

沿用参考工程的结构（`providers：sms · storage · wechat · llm（primary / fallback / vision / audio）· asr · geo · render`，docs/02-architecture.md:33；未配置的 Provider 由“未配置实现”顶上，docs/02-architecture.md:50），补三类：

| Provider | 职责 | 驱动 |
| --- | --- | --- |
| `storage` | 预签名上传 / 下载、STS 下发、HEAD、生命周期标记 | `s3`（COS / MinIO） |
| `media` | 转码、HLS、水印、打包、播放地址签发 | `ci`（腾讯数据万象）、`ffmpeg`（本机）、`vod`（备选） |
| `ocr` | 营业执照识别、通用字段抽取 | `tencent`、`aliyun`、`llm` |
| `asr` | 录音文件识别（提交 / 查询） | `tencent`、`volc` |
| `llm` | OpenAI 兼容；按角色 `text` / `vision` / `audio` 各配 base URL、key、model，带 primary / fallback | `ark`（豆包）、`dashscope`（千问）、`deepseek`、`hunyuan`、`zhipu` |
| `moderation` | 图片 / 视频 / 音频 / 文本审核（提交 / 查询） | `ci`、`wechat`（msgSecCheck / mediaCheckAsync） |

素材处理管线（每条素材一个 BullMQ 任务链，状态落 PostgreSQL，可重跑）：

1. `confirm` 入库 → 状态“整理中”
2. 内容安全审核（图、视频抽帧、音频）
3. 类型分流：录音与视频音轨 → ASR；图片与视频帧 → 视觉模型；文档 → 文本抽取
4. 文本模型汇总：内容标签（受后台“数据字典 · 标签”约束的封闭集合 + 少量自由标签）、要点、是否出现可识别人脸（提示“需肖像授权”）
5. 结果落 `asset_insights`，标注模型与版本；交付经理复核后才变为“可直接使用 / 仅供参考 / 需补拍 / 需肖像授权”

要点：标签用**封闭词表 + JSON Schema** 约束输出，避免每次生成不同的近义标签；模型输出只是“建议”，可用性由交付经理定（PRD 6.16.3 第 1 条）。参考工程 ADR-038 的“先逐个理解附件、结果按对象 key 缓存复用”可直接借鉴。

---

## 9. 内容安全审核

### 9.1 是否需要机审

- 商家上传的素材不对其他用户公开展示，只有本店成员与平台人员可见，不属于典型的 UGC 公开传播场景；法规没有要求这类内部素材必须机审【推断】。
- 广告成片是要公开发布的广告。《广告法》《互联网广告管理办法》对广告经营者有核对广告内容、查验证明文件的义务（PRD 10.3 已引用两部法规）；这是**人工责任**，机审不能替代，但能帮质检员先筛出明显问题（涉黄、涉政、违禁、极限词、二维码与联系方式）【推断】。
- 微信小程序平台对“可发布内容的小程序”要求接入内容安全检测；微信提供 `msgSecCheck`（文本）与 `mediaCheckAsync`（图片、音频，异步；单文件 ≤10MB；2000 次/分钟、20 万次/天）【摘 [微信内容安全](https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_msgseccheck.html)】。本产品商家可上传图文音视频，过审时可能被问到，接上成本很低。
- 结论【推断】：**建议做，定位为辅助**。商家素材入库前过一遍机审（拦明显违规、给交付经理提示）；广告成片在质检环节过一遍机审，结果作为质检清单的一项参考；最终以人工为准。

### 9.2 云厂商接口与价格

| 服务 | 图片 | 视频 | 音频 | 文本 | 说明 | 出处 |
| --- | --- | --- | --- | --- | --- | --- |
| 腾讯云 数据万象 内容审核 | 1.50 元/千次 | 截帧 1.50 元/千张 + 音频 0.9 元/小时 | 0.9 元/小时 | 2.2 元/千条 | **按场景叠加计费**（一张图同时审涉黄与广告算两次）；直接对 COS 对象提任务，可设自动审核与回调 | 【官】[CI 内容审核费用](https://cloud.tencent.com/document/product/460/58119)（2025-11-11 更新，均为最低阶梯前的首档价） |
| 阿里云 内容安全增强版 | 15 元/万张起 | 截帧 15 元/万次起 + 音频 202.5 元/万分钟 | 未取到 | 7.5 元/万次起 | 费用 = 数量 × 业务场景数 × 单价 | 【摘】[增强版与 1.0 对比](https://help.aliyun.com/zh/document_detail/2539430.html) |
| 微信内容安全 | 支持（异步） | 不支持视频 | 支持（异步） | 支持 | 免费，有频率上限 | 【摘】微信官方文档 |

粗算【推断】：每月 1 万张图 × 3 个场景 = 45 元；广告成片每月 200 条 × 1 分钟、每秒 1 帧 = 1.2 万帧 × 3 场景 ≈ 54 元，加音频不到 5 元。整部成片（每单 120 分钟）若全量审，按每 5 秒 1 帧约 1,440 帧 × 3 场景 ≈ 6.5 元/单；短剧原片本身已有许可或节目编号，只需审广告段，不必全片过审。

---

## 10. 托管数据库与缓存

### 10.1 参考工程现状【资料】

- 一台阿里云 ECS（`ecs.e-c1m1.large`，2 vCPU、1.8GB 内存 + 2GB swap、40GB 系统盘），Docker Compose 跑 PostgreSQL 16 与 Redis 7，PM2 跑 api 与 worker；对象存储在腾讯云 COS，跨云走公网（docs/08-deployment.md:7–8、16；infra/compose.prod.yml:10、31）。
- 备份：`pg_dump + gzip`，每天 04:00，本机保留 14 天；“异地副本（COS 私有桶）还没做”（docs/08-deployment.md:340）。
- 内存紧张：构建前要挂 swap，否则可能被 OOM（docs/08-deployment.md:33）；渲染与构建抢内存（docs/08-deployment.md:299）。

### 10.2 对本产品为什么不够【推断】

| 维度 | 单机自建现状 | 本产品要求 |
| --- | --- | --- |
| 数据丢失窗口（RPO） | 最多丢 24 小时（上次 pg_dump 之后的全部写入） | 含微信支付、对公转账确认、积分冻结 / 扣减 / 退回账本；丢一天的账要靠微信账单与人工逐笔补，不可接受 |
| 恢复时间（RTO） | 主机或磁盘故障 = 新开机器 + 装环境 + 恢复，按小时计 | PRD 要求可用性 ≥99.9%（全年停机 ≤8.8 小时） |
| 备份保留 | 14 天、同机 | PRD 要求每日备份保留 30 天；同机备份在磁盘损坏时一起丢 |
| 时间点恢复 | 无 | 误操作（错误的批量调账、错误迁移）需要恢复到指定时刻 |

### 10.3 托管选项

PostgreSQL：

| 项 | 腾讯云 云数据库 PostgreSQL | 阿里云 RDS PostgreSQL |
| --- | --- | --- |
| 架构 | 默认双机高可用（一主一从）【摘】 | 基础系列（单节点）、高可用系列（主备）【摘】 |
| 版本 | 11–18【摘 [全面支持 PG 18 公告](https://cloud.tencent.cn/announce/detail/2140)】 | 支持 18（2025-12-11 发布）【摘 [大版本生命周期](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/lifecycles-of-major-engine-versions)】 |
| 备份与 PITR | 自动全量 + WAL 增量（默认开启、不可关闭）；保留默认 7 天，可设 7–1830 天；克隆实例做时间点恢复【摘 [备份原理和方案](https://cloud.tencent.com/document/product/409/94889)】 | 日志备份保留 7–730 天，可恢复到保留期内任意时间点；**基础系列不支持日志备份与时间点恢复**【摘 [备份文档](https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/back-up-an-apsaradb-rds-for-postgresql-instance)】 |
| 赠送备份空间 | 本地盘 100%、云盘 200% 实例存储【官 [计费概述](https://cloud.tencent.com/document/product/409/49577)】 | 云盘实例 200% 存储容量【摘】 |
| 价格（非官方口径） | 2 核 4GB、100GB、双节点约 5,040 元/年（≈420 元/月）【三方，需用官方价格计算器复核】 | 高可用 2 核 4GB 约 380 元/月（年付折后约 201 元/月）；基础系列远低于此【三方，需复核】 |

Redis：

| 项 | 腾讯云分布式缓存数据库（兼容 Redis） | 阿里云 Tair（兼容 Redis） |
| --- | --- | --- |
| 版本 | Redis 4.0、5.0、6.2、7.0；Valkey 8.0、9.0【官 [产品概述](https://cloud.tencent.com/document/product/239/3205)】 | Redis 开源版 7.0、6.0、5.0、4.0；是否提供 Valkey 未查到【摘】 |
| 架构 | 标准架构：主从双机，1–5 副本，0.25–64GB，**内置 Proxy**；集群架构 1–128 分片；故障秒级切换【官】 | 标准版双副本、集群版【摘】 |
| 价格（非官方口径） | 标准架构 1GB 约 76 元/月【摘，需复核】 | 1GB 标准版按量 0.21 元/小时 ≈ 151 元/月【摘，需复核】 |

### 10.4 规格与成本建议【推断】

| 阶段 | PostgreSQL | Redis | 应用 | 月成本量级 |
| --- | --- | --- | --- | --- |
| 早期（数百商家） | 托管高可用 2 核 4GB、100GB SSD；备份保留 30 天、开 PITR | 托管 1GB 主从；或与应用同机自建（AOF everysec） | 2 台 2 核 4GB（api 与 worker 分开，或一台起步） | 数据库 400–500 元 + Redis 80–150 元 + 主机 200–500 元 |
| 增长期（数千商家） | 4 核 8–16GB，加只读实例跑报表；跨可用区 | 2–4GB 主从 | api 多实例 + 负载均衡；worker 独立机器（视频处理另开） | 2,000–4,000 元 |
| 对比：单机自建 | Compose 里的 PG | Compose 里的 Redis | 同一台 | 100–300 元，但 RPO 24 小时、无高可用 |

结论：

1. **PostgreSQL 从第一天就用托管高可用版**。每月多花约 400 元，换来主备自动切换、WAL 级时间点恢复、30 天备份。对一个收钱并记积分账的系统，这是最划算的一笔钱。不要选单节点的“基础系列”（阿里云基础系列不支持时间点恢复）。
2. Redis 承担 BullMQ 队列、限流、后台会话。**前提是账本状态永远不只存在 Redis**：任务先写 PostgreSQL 再入队（参考工程已是“事务内写 `ai_jobs(pending)` → 提交后入队”，docs/02-architecture.md:82），Redis 丢了可从 PG 重建。满足这个前提时，Redis 早期自建也可接受；想省事就托管 1GB。
3. BullMQ 要求 Redis ≥6.2【摘 [BullMQ 文档](https://docs.bullmq.io/guide/connections)】，并要求 `maxmemory-policy=noeviction`（BullMQ 通识，未现场核对）。腾讯云标准架构带 Proxy，BullMQ 的 Lua 脚本与阻塞命令在 Proxy 后的兼容性**需要 PoC**；集群架构下还要处理 hash tag，早期不要用集群。
4. 数据库必须与应用服务器同云、同地域、同 VPC 内网访问。参考工程的“阿里云 ECS + 腾讯云 COS”跨云只发生在对象存储上；数据库不能跨云。
5. 如果因为预算或进度一定要先自建：至少做到 WAL 连续归档到对象存储（pgBackRest 或 WAL-G）实现时间点恢复、每日基础备份保留 30 天、备份放异地桶、每季度做一次恢复演练；并把“迁到托管”列为上线后的固定事项。这套东西的搭建与值守成本，通常已经超过托管的差价。

### 10.5 选哪朵云【推断】

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| 全部放腾讯云（CVM + 云数据库 PG + Redis + COS + CI + CDN + OCR + ASR + 短信） | 应用与 COS 同地域内网互通（内网流量免费）；V2.0 自动合成时 worker 要反复读写原片与成片，这一点决定性；微信支付、小程序生态同厂 | 团队现有主机与备案经验在阿里云；需要新开腾讯云主机与网络 |
| 沿用阿里云 ECS + 阿里云 RDS，COS 留在腾讯云 | 运维习惯不变 | 服务端每读一次 COS 文件按外网下行计费（约 0.5 元/GB）且走公网；V2.0 一单成片 3GB、读写各一遍就是几元钱和几分钟的传输；数据库与 AI 能力分属两家 |
| 全部放阿里云（OSS + VOD / IMM + RDS） | 一家云 | 抛弃参考工程已有的 COS、ASR、短信接入；小程序合法域名全部重配 |

建议第一种。V1.0 服务端基本不搬运大文件（都是客户端直传、直下），跨云还能凑合；但 V2.0 一旦上自动合成就必须同云，早定比晚迁便宜。

---

## 11. PostgreSQL 与 Redis / Valkey 版本

### 11.1 PostgreSQL

| 版本 | 当前小版本 | 首发 | 社区支持截止 |
| --- | --- | --- | --- |
| 18 | 18.6（2026-08-13） | 2025-09-25 | 2030-11-14 |
| 17 | 17.11 | 2024-09-26 | 2029-11-08 |
| 16 | 16.15 | 2023-09-14 | 2028-11-09 |
| 15 | 15.19 | 2022-10-13 | 2027-11-11 |
| 14 | 14.24 | 2021-09-30 | 2026-11-12 |

出处：【官】[PostgreSQL Versioning Policy](https://www.postgresql.org/support/versioning/)。

- **PostgreSQL 19 尚未正式发布**：2026-09-24 发布的是 19 Beta 4【官 [postgresql.org](https://www.postgresql.org/)】。往年大版本多在 9 月下旬发布，今年延后，具体发布日期未知。
- 云厂商：腾讯云 11–18、阿里云 RDS 支持 18（均见 10.3）。
- 参考工程用的是 `postgres:16-alpine` + Prisma 7.10 + `pg` 8.23（infra/compose.prod.yml:10；apps/api/package.json）。
- 建议【推断】：新项目取 **PostgreSQL 17**（已发布两年、还有三年支持期、两家云都支持、与参考工程的 16 差异小）；团队愿意跟新也可直接上 18（已有 6 个小版本）。本地 Compose、CI、生产三处版本保持一致。

### 11.2 Redis 与 Valkey

| 项 | 现状 | 出处 |
| --- | --- | --- |
| Redis 开源版最新 | 8.10（2026-07-29 发布，最新补丁 8.10.2，2026-09-17）；8.8、8.6、8.4 仍有安全更新；7.4、7.2 安全更新到 2029-12 | 【三方】[endoflife.date/redis](https://endoflife.date/redis) |
| Redis 许可 | 7.2 及以前 BSD；7.4–7.8 为 RSALv2 / SSPLv1；8.0 起为 RSALv2 / SSPLv1 / AGPLv3 三选一 | 【三方】同上 |
| Valkey 最新 | 9.1.2（2026-09-01）；9.1 于 2026-05-19 发布；BSD 许可 | 【摘】[valkey.io](https://valkey.io/download/releases/)（页面抓取失败） |
| 腾讯云托管 | Redis 4.0 / 5.0 / 6.2 / 7.0，Valkey 8.0 / 9.0 | 【官】见 10.3 |
| 阿里云托管 | Redis 开源版最高 7.0；Valkey 未查到 | 【摘】见 10.3 |
| BullMQ | Redis ≥6.2；另有 Valkey Glide 适配器 | 【摘】[BullMQ 文档](https://docs.bullmq.io/guide/connections) |

建议【推断】：

- 托管：选“兼容 Redis 7.0”的标准架构（主从），这是两家云的共同上限，也是 BullMQ + ioredis 验证最充分的组合；腾讯云上选 Valkey 8.0 亦可。
- 自建或本地开发：`valkey/valkey:8` 或沿用参考工程的 `redis:7-alpine`。内部自用不涉及许可问题；如果未来要把系统私有化交付给客户，Valkey 的 BSD 许可更省事。
- 不必追 Redis 8.x：云上没有对应托管版本，用不上其新特性。

---

## 12. 风险、与 PRD 的冲突、待拍板事项

### 12.1 技术风险与冲突

| # | 事项 | 说明 |
| --- | --- | --- |
| R1 | 打包下载在小程序内做不到 | `wx.downloadFile` 单文件 200MB，成片包 2–5GB；PRD 6.10.1 的“打包下载”只能在电脑端实现，小程序内只能逐集保存 |
| R2 | 链接有效期与签名上限 | 后台可配 1–30 天；S3 SigV4 上限 7 天、STS 上限 36 小时。必须用“业务授权 + 按次短签名”，不能把有效期写进 URL |
| R3 | HLS + 签名 + CDN 的组合 | CDN 时间戳鉴权对 ts 分片不自动生效；CI 私有 m3u8 是否能走 CDN、是否支持自适应主清单文档没写。需 PoC，备选是 VOD |
| R4 | 小程序 `<video>` 播 HLS 的安卓兼容性 | 官方表标支持，社区有失败个案；需真机矩阵，并准备 MP4 兜底 |
| R5 | 溯源水印不适用 | 腾讯云 VOD 溯源水印要求 HLS 且 ≥7 分钟；短剧单集 1–3 分钟 |
| R6 | 视频上限口径不一 | PRD 10.1 写 200MB，6.16.3 写相册视频 500MB；6.3.2 建档视频为每条 ≤60 秒、200MB |
| R7 | 参考工程是公有读桶 | 本产品证照、成片必须私有读；所有读路径要改成签名，图片列表页的签名与缓存要设计（批量签名、有效期对齐到整点以利用缓存） |
| R8 | 参考工程生产 LLM 走境外网关 | 商家素材含门店与人像，建议只用国内端点 |
| R9 | 单机 + pg_dump 不满足 99.9% 与 30 天备份 | 见第 10 节 |
| R10 | 跨云流量 | 应用在阿里云、文件在腾讯云时，服务端每读 1GB 约 0.5 元且慢；V2.0 自动合成会放大 |
| R11 | 存储只增不减 | 每单 3GB，一年几 TB 到几十 TB；没有“成片保留期”规则就无法做生命周期 |
| R12 | Redis Proxy 兼容性 | 腾讯云标准架构带 Proxy，BullMQ 需实测 |
| R13 | 行业许可证种类多 | 专用 OCR 接口只覆盖食品经营许可证等少数；要用通用抽取或先不做 OCR |
| R14 | 价格数字来源 | 火山引擎、智谱、部分阿里云与腾讯云数据库价格来自搜索摘要或第三方，签约前需在官网价格计算器复核 |

### 12.2 需要业务或架构师拍板

1. 是否提供电脑端下载页（扫码授权）？“打包下载”是否只在电脑端提供？
2. 成片在使用期结束后保留多久？原片、样片、被替换的旧版本成片呢？（决定生命周期与存储成本）
3. 商家素材视频上限按 200MB 还是 500MB？
4. 预告片的“播放地址签名”是否可以接受“只签 m3u8、ts 靠不可猜路径 + Referer”，还是必须每个分片都有签名（那就上 VOD）？
5. 样片是否也要多码率 HLS，还是单档 MP4 + 明水印即可？
6. 部署云：全部迁到腾讯云，还是沿用阿里云主机？
7. 数据库是否从 V1.0 起就用托管高可用版（每月约多 400–600 元）？
8. LLM 是否限定只用国内端点？主备各选哪家（豆包 / 千问 / DeepSeek）？
9. 内容安全机审做到哪一步：只接微信免费接口，还是加 CI 审核？广告成片机审结果是否进质检清单？
10. 行业许可证 V1.0 是否需要 OCR 预填，还是只上传图片由人工审核？
11. 是否需要“被搬运”溯源能力（数字水印）？如果需要，接受每分钟约 0.4 元的成本并放到哪一期？

---

## 13. 主要来源清单

腾讯云：

- COS 预签名：https://cloud.tencent.com/document/product/436/68284 、https://cloud.tencent.com/document/product/436/35153 、https://cloud.tencent.com/document/product/436/7778
- COS 域名与回源鉴权：https://cloud.tencent.com/document/product/436/18424
- COS 计费示例：https://cloud.tencent.com/document/product/436/6241
- COS 小程序 SDK 上传：https://cloud.tencent.com/document/product/436/64991 ；JS SDK：https://cloud.tencent.com/document/product/436/64960
- 多文件打包压缩：https://cloud.tencent.com/document/api/436/83112 、https://cloud.tencent.cn/document/product/460/108574 、https://cloud.tencent.com/document/product/460/82333
- CI 媒体处理费用：https://cloud.tencent.cn/document/product/460/58120 ；内容审核费用：https://cloud.tencent.com/document/product/460/58119 ；私有 m3u8：https://cloud.tencent.com/document/product/460/63738
- MPS 计费：https://cloud.tencent.com/document/product/862/36180
- CDN 计费：https://cloud.tencent.com/document/product/228/75562 ；TypeA：https://cloud.tencent.com/document/product/228/41623 ；URL 鉴权：https://cloud.tencent.com.cn/document/product/228/76110
- VOD 计费：https://cloud.tencent.com/document/product/266/95125 ；Key 防盗链：https://cloud.tencent.com/document/product/266/14047 ；溯源水印：https://cloud.tencent.com/document/product/266/75789 ；小程序上传 SDK：https://cloud.tencent.com/document/product/266/18177 ；播放器 License：https://cloud.tencent.com/document/product/881/74588
- STS：https://cloud.tencent.com/document/product/1312/48195
- OCR：https://cloud.tencent.com/document/product/866/36215 、https://cloud.tencent.com/document/product/866/17619 、https://cloud.tencent.com/document/product/866/77836
- ASR：https://cloud.tencent.com/document/product/1093/35686 、https://cloud.tencent.com/document/product/1093/37823
- 混元 / TokenHub：https://cloud.tencent.com/document/product/1729/97731 、https://cloud.tencent.com/document/product/1823/130055
- 云数据库 PostgreSQL：https://cloud.tencent.com/document/product/409/49577 、https://cloud.tencent.com/document/product/409/94889 、https://cloud.tencent.cn/announce/detail/2140
- Redis：https://cloud.tencent.com/document/product/239/3205

阿里云：

- VOD 计费：https://help.aliyun.com/zh/vod/product-overview/billing-of-basic-services
- IMM 打包：https://help.aliyun.com/zh/imm/developer-reference/api-imm-2020-09-30-createfilecompressiontask
- OCR 计费：https://help.aliyun.com/zh/ocr/product-overview/pay-as-you-go
- 百炼价格与视觉理解：https://help.aliyun.com/zh/model-studio/model-pricing 、https://help.aliyun.com/zh/model-studio/vision
- RDS PostgreSQL：https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/lifecycles-of-major-engine-versions

火山引擎：

- veVOD 小程序上传 SDK：https://docs.volcengine.com/docs/4/1125374?lang=zh
- 方舟模型价格：https://www.volcengine.com/docs/82379/1099320 ；模型列表：https://www.volcengine.com/docs/82379/1593703
- 豆包语音计费：https://www.volcengine.com/docs/6561/1359370?lang=zh

其他：

- DeepSeek 价格：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
- 百度 OCR 价格：https://cloud.baidu.com/product-price/ocr.html
- 微信：营业执照 OCR https://developers.weixin.qq.com/miniprogram/dev/server/API/img-ocr/ocr/api_bizlicenseocr.html ；内容安全 https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_msgseccheck.html
- PostgreSQL：https://www.postgresql.org/support/versioning/ 、https://www.postgresql.org/
- Redis：https://endoflife.date/redis ；Valkey：https://valkey.io/download/releases/ ；BullMQ：https://docs.bullmq.io/guide/connections

参考工程（只读）：

- `timavia-liyo-project/docs/02-architecture.md`（:19、:33、:51–52、:60、:82、:89、:104–108、:175）
- `timavia-liyo-project/docs/07-platform-config.md`（:31–41、:111）
- `timavia-liyo-project/docs/08-deployment.md`（:7–8、:16、:33、:299、:340）
- `timavia-liyo-project/packages/services/src/providers/storage/s3.ts`（:21–44）
- `timavia-liyo-project/infra/compose.prod.yml`（:10、:31）、`infra/compose.yml`（:37）
