# 狸有戏（liyoxi）

面向本地生活商家的短剧营销工具：平台把自有版权短剧按门店定制成片并植入商家广告，商家在自己的抖音号、视频号上线，为门店引流。

V1.0 交付商家端微信小程序、运营管理后台与商家电脑端下载页。

## 当前状态

技术架构、设计规范、数据模型与接口契约已完成，开发计划已确认并执行。2026-10-07 的合流基线 main `6866bb3d` 已包含 M0“最小地基”的 37 包及 W0-30a，以及 M1 的商家/后台鉴权、建档审核、对公开通、账本履约、订剧开工、制作交付、逐集下载和上线核验接口与页面。W1-21 汇总真实 20 集替身接口链、演示命令和严格门禁；M2/M3/M4 的拆包与任务书由 W1-23 接续。分段交付和最终合并状态仍以单包状态为准。M0 的业主看样、真机和演示反馈尚未闭环，M1 的开发者工具与真机演示点 A、B 也须实际手验；自动化结果不代替整体退出确认。见 [M0 退出](docs/plan/m0-exit.md)、[M1 演示手册](docs/plan/demo/m1.md)和[合流回顾](docs/plan/retro/m1.md)。

环境先只建一套预发，生产在预发初步稳定后再建（[ADR-041](docs/adr/0041-预发先行-单机预发-共用AppID.md)）。main 已提供 W1-22 本地全栈演练、W2-25 节点初始化与四镜像/四桶校验，以及 W2-26 的持续探测、发布回滚与私有上传消费者；工作流接线按独立门禁 PR 收口，外部开关默认关闭。服务器实际部署、真实 SSH/云账号与微信上传仍未有完成记录。实际合并进度以 [docs/plan/status/](docs/plan/status/README.md) 和合并记录为准，可用 `pnpm status:summary` 现生成汇总；近期业主待办见 [业主清单](docs/plan/owner-checklist.md)第 4.3 节。

业主已将仓库设为 public，GitHub Actions 已恢复实际运行，原先 #63 的账单/额度阻断已解除。开发继续执行独立复审、完整 CI 和同步 main 后合并的既有规约；部署、服务器操作与真实平台联调仍按业主授权另行推进。

## 设计

界面依据都在仓库里，开发不依赖 Figma。

| 内容 | 说明 |
| --- | --- |
| [design/design-spec.md](design/design-spec.md) | 设计规范：颜色、字号、组件规格、状态取色、文案规则 |
| [design/tokens.json](design/tokens.json) | 样式变量 |
| [design/prototype/](design/prototype/README.md) | 原型快照：商家端 47 个画板、后台 56 个画板的源码与截图 |

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/README.md](docs/README.md) | 文档索引与阅读顺序 |
| [docs/01-architecture.md](docs/01-architecture.md) | 技术架构 |
| [docs/02-tech-selection.md](docs/02-tech-selection.md) | 技术选型 |
| [docs/03-key-designs.md](docs/03-key-designs.md) | 关键技术方案 |
| [docs/04-adr.md](docs/04-adr.md) | 架构决策记录 |
| [docs/05-risks-and-open-issues.md](docs/05-risks-and-open-issues.md) | 风险、待确认事项与上线前验证清单 |
| [docs/06-data-model.md](docs/06-data-model.md) | 数据模型（字段级定义在 docs/data-model/） |
| [docs/07-api-contract.md](docs/07-api-contract.md) | 接口契约（字段级定义在 docs/api/） |
| [docs/08-development-plan.md](docs/08-development-plan.md) | 开发计划（已确认，执行中；进度见 docs/plan/） |
| [docs/plan/](docs/plan/README.md) | 开发计划的执行台账：任务书、工作包状态、留桩、计划变更、外部验证、业主清单、三份运维文档 |
| [CLAUDE.md](CLAUDE.md) | 会话开工须知：每个开发会话开工前必读的总纲与出处 |
| [docs/appendix/](docs/appendix/README.md) | 子系统设计草案、外部事实核实记录、调研记录 |

建议先读 [docs/05-risks-and-open-issues.md](docs/05-risks-and-open-issues.md) 的第 0、1 节。

## 校验工具

| 工具 | 说明 |
| --- | --- |
| [tools/schema-check](tools/schema-check/README.md) | 在临时 PostgreSQL 库里建表、执行手写约束，并逐列比对数据模型文档与库结构 |
| [tools/api-check](tools/api-check/README.md) | 核对接口文档、路线图与结构化清单是否一致，生成接口索引、错误码与权限点登记表 |
