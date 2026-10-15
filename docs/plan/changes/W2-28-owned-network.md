# W2-28：HEAD 镜像 owner 的显式本轮私网

| 项 | 内容 |
| --- | --- |
| 改了什么 | 新增可选 ownerNetwork 收据/固定连接纯守卫及唯一strict Zod parser/testing窄出口，接入 M1 owner 的正式随机库迁移补种；强制实钟；一个无 IO 聚合和同域说明。 |
| 原因 | Docker 容器 localhost 不指向宿主共享依赖；既有非 attach loopback 守卫正确拒绝动态 alias，不能拿 host owner 代替 HEAD 镜像实际迁移。 |
| 影响的包 | W2-28；调度批准仅 testing 类型/support/index窄出口/新 helper/同域纯目标及说明。公共任务/状态由 ROOT 统一。 |
| 类别 | 范围 |
| PR | 本地 codex/w2-28-owned-network；作者冻结后交 ROOT 唯一审查，普通提交，不自行推送或合并。 |

基于实际 main d22c5b2a 的 worker 前置。默认 M1、attach、DB 全局、业务语义、原七段/20集/30秒观察/10分钟混跑判据均不变；只在 APP_ENV=test、非 attach、显式 runId 精确同轮且未传 clock 时接受固定 PG/Redis alias/端口/公开开发凭据/DB0，无任意远端入口。receipt 与 expected 精确一致只是私有输入一致性检查；实际 Docker inspect/网络归属与有限 JSONL RPC、对应 SHA 容器执行及精确 membership 清理由后继 controller 交付。

显式网络owner关闭时，只有已取得本轮库/Redis scope才在原清理后只读确认库不存在及前缀完整SCAN为零；失败仍经原AggregateError拒绝，不新增虚构返回计数。默认/attach关闭不变。实际清零由后继容器一次验收，本片不加DB目标。

调度另准可选diagnosticWrite仅转接support两logger与既有fullInvariants失败摘要，供私有JSONL driver计数而不转印原文；默认stdout/脱敏/失败判据不变。唯一Zod schema保留精确自有键、无额外symbol、同轮identity和三完整ID不同语义，不借parser扩大输入。

本片只核一个纯守卫聚合与必要类型，不连接 DB/Redis/MinIO、不构建或运行容器、不访问 GitHub，不宣称四步真实混跑、发布门禁或外部环境验收通过。

本地最终同一纯聚合1/1通过（127ms，断言4ms）、services与infra类型/定向格式和lint通过，分类touch0/loosen0。初次infra类型因纯测试静态跨目录导入services触发rootDir错误；仅将该测试移回testing同域、临时纯配置圈定无IO目标后复验通过，仓库globalSetup/门禁配置未改。
