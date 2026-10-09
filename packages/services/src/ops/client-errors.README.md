# W2-18 客户端错误信封转发

`createClientErrorForwarder` 由进程组合根装配，商家与后台接口共用。接口传入原始
`Uint8Array` 或字符串，调用同步的 `accept` 后即可返回 202；本模块不写业务表、不做
鉴权或限流。真实 middleware、FILE 读取、公开出口和 runtime 关停由 W2-18 主包装配。

配置只接收 `loadEnv` 读取的 `CLIENT_ERROR_PROJECTS_FILE` 内容：
`{projects:[{dsn,upstreamDsn?}]}`，最多三个项目。公开 DSN 精确匹配白名单；HTTPS DSN
不得带 password、query、fragment，末段是数字项目号。上游从配置的 `upstreamDsn`
推导固定 envelope 端点，支持固定自托管路径前缀；请求中的 DSN、头或 item 不控制上游
URL。HTTP 禁止重定向，身份只用该固定上游的 public key。配置原文、DSN 与鉴权头
均不进入日志。整个 FILE 未配置或某项目没配上游时，合法信封只产生无正文的
`telemetry.forward/unconfigured` 结构化日志。

原始信封按 UTF-8 **字节**限制为 200 KiB，逐项按 `length` 或换行解析，支持没有末尾
换行的现有小程序格式和 JSON 内换行的 length 格式。每封最多一个 JSON error event；
二进制附件、transaction 和其它 item 只在总字节预算内消费后丢弃，不能绕过去敏。
非法 JSON、UTF-8、length、DSN 和超深 JSON 返回已有 `VALIDATION_FAILED`，不保留解析
原因中的原文。服务端清洗保留诊断字段，去掉 request、body/data、headers、凭据键、
局部变量和用户的非 id 字段；文本复用端上手机号、USCC、lyxm/Bearer 规则，并清掉
URL 凭据/query/fragment、其它会话 token 和 JWT。文本至多 2,000 字符，嵌套深度至多
32，输出不超过同一字节预算。上游只收到重新序列化的清洗 event，其 length 重新按
真实字节计算；header 仅保留合法 event_id、服务端 sent_at 和固定上游 DSN。

后台每进程并发 2，待发队列 200，满时丢最新并计数；没有重试。每次外呼包括响应流
取消受 2 秒预算，失败即丢弃，不读取上游响应正文。10 秒内（包含相等边界）5 次失败
熔断 60 秒，清掉待发项，熔断期间新受理项直接丢弃。每分钟写一条仅含计数与状态的
`telemetry.forward` 日志。`drain` 等当前队列与在途处理，`close` 幂等地清队列、取消
在途 AbortController、清周期 timer 并等收尾。待发项只存清洗正文，处理后释放引用。
入口与外呼使用实际 kernel 的事务守卫；沿用 kernel 在 local/test 拒绝、stg/prod
报告违规的既有策略，接口应始终在事务外调用。

测试使用可拨时钟、fake timers/fetch 和虚构 DSN；另有自有 loopback HTTP 服务验证
真实 Node fetch POST、取消和 socket 清理，不连接错误平台。真实平台收件、DSN 和
生产去敏法务判断仍是 W2-27 外部配置验收，本叶不称已完成这些事项。

依据：m08 §3.27、a01 §3.84、D7 §4.13/9.2；length 与尾换行兼容规则核对
[Sentry 官方 envelope 数据模型](https://develop.sentry.dev/sdk/data-model/envelopes/)
及 [Sentry 官方 Python envelope 实现](https://github.com/getsentry/sentry-python/blob/master/sentry_sdk/envelope.py)。
