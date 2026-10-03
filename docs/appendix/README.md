# 附录：设计草案、核实记录与调研记录

本目录是形成主文档（[01](../01-architecture.md)–[05](../05-risks-and-open-issues.md)）过程中的工作稿，保留下来供数据模型与接口设计阶段查阅字段级细节。

**使用前请注意**

- 这些是草案，不是定稿。七份设计由不同作者并行完成，彼此在主键类型、表名、审批表形态、提醒机制等 15 处有分歧，主文档 [03 第 9 节](../03-key-designs.md) 给出了裁决。草案不回改；**表结构以 [06 数据模型](../06-data-model.md) 为准**，与主文档不一致时以主文档为准。
- 全部方案未经实现与测试，并发结论靠推演。
- 草案里的路径（`src/PRD.md`、`slim/merchant/*.txt`、`slim/admin/*.txt`）指调研时的 PRD 与原型工作副本，未收入本仓库；`research/*.md` 即本目录的调研记录；`timavia-liyo-project` 指参考工程。
- 接口路径与英文字段名多为作者的建议命名，不是 PRD 原文。

## design/ 子系统设计草案（修订稿）

每份都经过一轮对抗式评审并修订，文末附评审意见处理表。

| 文件 | 范围 | 评审发现（阻塞 / 重要 / 一般） |
| --- | --- | --- |
| [d1-ledger.md](design/d1-ledger.md) | 套餐订阅、积分账本与计价 | 1 / 9 / 9 |
| [d2-payment.md](design/d2-payment.md) | 支付、对公转账、退款、对账与发票 | 2 / 12 / 16 |
| [d3-flow.md](design/d3-flow.md) | 订购、广告、交付与发布的状态机，事件、定时与审批 | 3 / 13 / 8 |
| [d4-identity.md](design/d4-identity.md) | 身份、租户、权限、审计与数据安全 | 1 / 8 / 10 |
| [d5-media.md](design/d5-media.md) | 存储、上传、转码、播放、下载、素材理解与制作边界 | 1 / 10 / 11 |
| [d6-notify-docs-data.md](design/d6-notify-docs-data.md) | 通知、文书、配置字典参数、报表与埋点 | 1 / 7 / 12 |
| [d7-platform.md](design/d7-platform.md) | 工程结构、两端前端架构、部署运维、可观测与质量保障 | 0 / 9 / 13 |
| [d8-content.md](design/d8-content.md) | 短剧库：剧目、剧集、许可与版权、上架校验、与积分价和订购的关系（数据模型阶段补写） | 两位复核员共 24 条，均已处理 |
| [d9-profile.md](design/d9-profile.md) | 门店档案与资质审核：建档四步、证照、审核轮次、变更重审（数据模型阶段补写） | 两位复核员共 24 条，均已处理 |

评审发现的阻塞与重要问题均已在修订稿中处理或写明不采纳的理由。

d8、d9 是数据模型阶段补写的，格式与前七份相同。

## fact-check.md 外部事实核实记录

[fact-check.md](fact-check.md)：91 条外部结论的逐条核实，含依据原文与来源链接。60 条成立，31 条部分成立（已按更正后的说法采用）。文末另有 2026-10-02 针对业务答复追加的 11 条补充核实（短信验证码登录的平台规则、已开通的商户号与支付定性）。分 12 组：虚拟支付与类目、订阅消息与审核规范、文件上传下载、微信支付、微短剧类目与资质、抖音与视频号发布规则、企业微信、对象存储与媒体、数据库与周边服务、后端版本、前端版本、电子签与发票及监控。

## research/ 调研记录

| 文件 | 内容 |
| --- | --- |
| [prd-tech.md](research/prd-tech.md) | PRD 的技术要求抽取：实体、状态机、计算规则、约 38 条时间规则、通知、参数、外部能力、权限、矛盾与空白 |
| [proto-merchant-a.md](research/proto-merchant-a.md)、[proto-merchant-b.md](research/proto-merchant-b.md) | 商家端 47 个画板逐个梳理：字段、交互、推断接口、端侧能力、与 PRD 的差异 |
| [proto-admin-a.md](research/proto-admin-a.md) 至 [proto-admin-e.md](research/proto-admin-e.md) | 运营后台 56 个画板逐个梳理（工作台与交付发布；商家与订单；短剧库、套餐积分与客服；财务与报表；运营、系统与渠道） |
| [ref-arch.md](research/ref-arch.md)、[ref-ops.md](research/ref-ops.md) | 参考工程的架构、66 条决策的借鉴表、踩坑教训、小程序工程与部署经验 |
| [ext-wechat.md](research/ext-wechat.md) | 微信支付、虚拟支付、类目与资质、订阅消息、客服与企业微信、文件能力、短信 |
| [ext-media.md](research/ext-media.md) | 对象存储与点播方案对比、签名与分发、打包、证照识别、转写、模型、托管数据库 |
| [ext-stack.md](research/ext-stack.md) | 各依赖的版本现状、后台前端栈对比、周边库、电子签、电子发票、埋点、可观测 |
| [ext-aigc.md](research/ext-aigc.md) | 定制成片的实现路径：贴片合成、视频模型能力与成本、AI 标识义务、差异度度量 |

调研记录是核实之前的初稿，其中的外部结论以 [fact-check.md](fact-check.md) 的核实结果为准。
