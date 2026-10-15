# W2-27：私有映射上传助手先于工作流密文接线

2026-10-15，调度按原W2-27上传验收拆本片：在actual main 9396a045的五组件私有产物和客户端frame口径上，实现独立、默认未配置即跳过的上传助手。允许新增`infra/deploy/source-map-upload.mjs`及声明、固定CLI锁、一个纯测试文件、对应README和任务/状态记录；不在本片修改工作流、门禁或公开artifact。

CLI固定3.8.0（官方2026-09-16发布），Linux x64二进制按官方SHA256验后执行，CI外不安装。ROOT已从官方CDN一次性下载并验Mac arm64版本，真实`--version`/`sourcemaps upload --help`通过；旧`releases files`子命令实际不可用，不能照旧示例实现。已清本轮二进制。上传采用现命令的release/dist/url-prefix、`--no-rewrite`及自动Sourcemap引用；不注入debug ID，不改发布字节。官方依据：[CLI release说明](https://docs.sentry.io/cli/releases/)、[CLI配置](https://docs.sentry.io/cli/configuration/)、[固定版本元数据](https://release-registry.services.sentry.io/apps/sentry-cli/3.8.0)。

助手只消费已verify的同次manifest、镜像身份及每对JS/map；逐项复制到自有0700临时目录，未登记文件不进入CLI扫描。五组件顺序上传，各自dist与`app:///组件/完整pair.path`口径一致。令牌仅子进程环境传递，不放argv/日志；不继承用户登录态、代理、禁用TLS、允许失败或.env设置。网络不自动重试，子进程和总时限有界，失败不输出上游正文且清本轮副本/CLI；原私有产物仍由外层既有finally清理。

本片测试只用自有微型map、伪下载和命令适配器，不使用真实令牌或请求SaaS。后继独立gate片才在可信main且显式开启的上下文接入密文，PR构建仍无密文，不把map上传公开GitHub artifact。不代表真实SaaS收件或符号化完成；W2-27保持进行中。

后继gate范围由调度批准：仅`.github/workflows/images.yml`、原`stg-images`/`source-maps-wiring`断言精确适配与一新纯接线聚合。只有可信main的push/手动事件且`STG_SOURCE_MAP_UPLOAD_ENABLED=true`才运行上传step；令牌`SENTRY_AUTH_TOKEN`仅该step环境，项目映射为非敏感`vars.LYX_SENTRY_UPLOAD_CONFIG`。缺令牌由助手零IO跳过；PR可执行构建步骤仍无密文，不放松同源、公开artifact隔离与always精确清理。旧整job无secret字面检查改为该唯一严格guard的step级检查，作为独立gate-change处理，不混助手代码。
