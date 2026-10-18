# 代码仓迁回后的开发入口与待办

更新时间：2026-10-18。当前源码仓库为 [byfire-dev/liyoxi-project](https://github.com/byfire-dev/liyoxi-project)。本页记录本次代码迁回完成时点；工作包进度仍以各自台账为准，后续提交不能沿用本次 SHA 的验收结论。

## 已完成的代码迁回

[PR #138](https://github.com/byfire-dev/liyoxi-project/pull/138) 已普通合并，实际主干为 `9ffd93b3125c73e6743a5e33328909dcb690218e`。固定候选 `43866e2dc493002b35ff0f1a9974b0118660cc7f` 的本轮 32 个整合与修复分支均已进入该主干，包括首页 Banner、短剧封面及后续 CI 修复。

业主授权的一次性例外只用于该固定候选的历史门禁与业务混合差异，不修改分类器、不把分类失败记为通过。合并后原保护已恢复并读回一致：必过检查 `required`、严格同步 main、PR 与管理员同等约束、禁止强推和删除均继续生效。后续开发沿用 [CLAUDE.md](../../CLAUDE.md) 的普通提交、独立复审与合并规则。

[实际 main-push CI 39108004039](https://github.com/byfire-dev/liyoxi-project/actions/runs/39108004039) 的 11 项实质检查及 `required` 全部成功，实际检出提交为上述主干。迁回操作完成时，本地 main 与 `origin/main` 一致，默认设置已核对为：

| 设置 | 当前值 |
| --- | --- |
| `origin` | `https://github.com/byfire-dev/liyoxi-project.git` |
| main upstream | `origin/main` |
| 默认推送 remote | `origin` |
| gh 默认仓库 | `byfire-dev/liyoxi-project` |
| 历史 remote | `archive-sanqianyuejia`，保留指向原仓库 |

## 继续开发前

由 ROOT 按[请求节流规则](local-development-validation.md#github-请求与远端验证节流)统一核对并更新目标 main，作者再从已更新的本地 main 创建独立分支。作者不自行并行查询 GitHub、不推送、不开 PR、不合并；不要在原脏工作目录里强行同步或覆盖文件。

198 个历史分支原 upstream 随 remote 重命名保留，可能仍指向 `archive-sanqianyuejia`。恢复某分支开发前，先核对其 upstream 与独有增量，再由 ROOT 按实际需要安排目标分支；不要直接沿旧 upstream 拉取，也不要批量改写、推送或删除所有分支。56 个非正式版本历史标签保存在本地及离线备份，未批量推送到目标仓；不新造 `v*` 或 `weapp-v*` 标签来替代真实发布记录。

| 保留工作 | 当前处置 |
| --- | --- |
| `codex/w4-05-subscription-advance` | 未决计费规则及独有分支保留；待规则明确后同步 main 再收口，不整文件覆盖后继实现 |
| `codex/weapp-trial-login` | 21 文件的未提交体验版登录增量已备份并留在原工作目录，增量另行提取，尚未合流；不整目录覆盖当前手机号授权与账户页面 |
| `codex/w2-12-docs-versions` | 22 文件旧草稿保留，正式文书实现已有后继版本进入 main，不重复合并草稿 |
| 旧性能实验、旧进度文档、stash 与失效 worktree 记录 | 按原台账封存，本次没有清理；本地图片、业务文档及审计产物不随源码公开提交 |

byfire [#137](https://github.com/byfire-dev/liyoxi-project/pull/137) 已显示合并。旧仓 [#1](https://github.com/sanqianyuejia/liyoxi-project/pull/1)、[#2](https://github.com/sanqianyuejia/liyoxi-project/pull/2)、[#4](https://github.com/sanqianyuejia/liyoxi-project/pull/4) 保留历史证据，关闭留待具备相应权限后处理；不重写其 PR、run 或历史仓库链接。

## 发布与验收仍待完成

| 范围 | 本次结果与边界 |
| --- | --- |
| 同提交镜像与全栈检查 | 实际主干的 [images](https://github.com/byfire-dev/liyoxi-project/actions/runs/39108004052) 与 [stack-smoke](https://github.com/byfire-dev/liyoxi-project/actions/runs/39108004070) 成功；构建与冒烟成功不等于镜像已经发布或节点已经部署 |
| 两版混跑 | [mixed-smoke 39108004071](https://github.com/byfire-dev/liyoxi-project/actions/runs/39108004071) 报告 `driver-missing`，36ms，在版本预检阶段失败，尚未执行两版业务链；不是已证明的“缺标签”或业务不兼容。它不改变本次代码迁回退出条件，仍阻断同一主干提交的正常部署放行 |
| 容量与 Node26 | 固定候选的附加 [nightly 39105287282](https://github.com/byfire-dev/liyoxi-project/actions/runs/39105287282) 中 P95 失败且尚未进入正式 HTTP 采样，Node26 取消，均未通过验收；不调整正式规模、阈值或退出条件 |
| Packages 与节点 | 当前目标仓的镜像 namespace、Packages 关联/权限/可见性、公开 vars、节点镜像前缀及拉取配置仍须真实核对，未因源码迁回自动迁移；旧仓已设置的 vars 不能当作目标仓已配置的证据 |
| 真实交付 | 预发部署、真实云/微信/邮件联调、真机提审及其他外部验收继续按各自台账推进，本次不登记完成 |

现有公共 MinIO 继续使用[恢复记录](../../infra/docker/minio-recovery.md)中的 `ghcr.io/sanqianyuejia/liyoxi/minio` 固定版本与摘要，保留旧包及原证据。迁包需另行授权、核验新包及双架构摘要后再切消费者；当前不填写未经核实的目标 namespace，不开启镜像发布、制品上传、部署或微信上传。

发布前按[平台配置表](platform-config.md)、[业主清单](owner-checklist.md)及[节点手工核对表](../../infra/bootstrap/checklist.md)逐项核对。同仓、main push、同一完整 SHA 的 images 与 mixed-smoke 成功要求继续有效；本次代码迁回例外不适用于发布部署。
