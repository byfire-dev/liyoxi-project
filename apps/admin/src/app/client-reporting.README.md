# W2-18 后台错误信封

`createAdminClientReporting({dsn,build,sender,now?,uuid?,getUserId?})` 提供 `capture(error,kind?)`
与 `install(window)`；后者监听 error/unhandledrejection，返回幂等解绑。重复安装同一 window
复用一组监听，最后一次解绑才移除。没有 SDK、性能追踪、客户端持久化或后台定时器。

空或非法公开 DSN 不采集/发请求，也不安装监听。事件只构造安全 exception 字段、stack、
构建号、kind 和内部 UUID 用户 id，不序列化错误的 cause、请求体/头或未知 rejection 对象。
文本沿用已有小程序的手机号/USCC/会话token/Bearer匹配规则，并处理管理员会话、JWT、
显式凭据文本与 URL 凭据/query/fragment，每段至多 2,000 字符。shared/mask 属展示掩码，
会保留手机号和证照的头尾，因此错误信封使用完全去掉的匹配替换，不跨应用导入。

每分钟最多 10 次发送，同会话按清洗后的有限 fingerprint 去重；会话集合最多 1,000 项，
达到上限后丢弃新的错误，页面重新加载开始新会话。最多 2 个在途 sender，不建立待发队列。
同步 sender 重入、同步异常和异步拒绝均不递归报告、不抛出；发送失败不重试、不写正文日志。

`createAdminClientErrorSender(api.client)` 复用真实中央客户端与 generated AdminPaths，typed
POST `/api/v1/admin/client-errors` 使用 `application/x-sentry-envelope` 和原文 bodySerializer，
保留同源 cookie、防跨站头、构建号和请求编号。主负责人在 services/App 装配公开 DSN、
sender、用户读取与 React effect 生命周期；本叶不改 Vite/env、中央 api 或原业务页面。

单测包含真实 createAdminApi 的假 fetch/raw/header/202、网络失败不产生 unhandled rejection、
去敏/文本/分钟/会话/在途上限，以及 EventTarget 的实际监听与解绑。真实浏览器端收件与上游
平台配置仍待 W2-27；这份叶说明不声明整包或外部验收完成。
