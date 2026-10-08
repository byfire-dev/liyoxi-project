# 微信六方法驱动（W2-21 内部作者叶）

`createWechatDriver({appid, secret, releaseChannel}, {cache, now, fetchImpl?})` 返回
`{provider, close}`。它只组合此目录的 HTTP/token 私口，构建时不取 token，
不读取环境、创建 Redis 连接或关闭父 Redis。root 负责 FILE 配置、未配降级、
统一外层 `withBeforeCall` 与进程关停；驱动不重复调用外呼 guard。

固定 `https://api.weixin.qq.com` 六业务路径；稳定 token 普通模式，不强刷。
单 HTTP 4 秒、方法含缓存和 token 的整个 wall budget 8 秒；方法 signal
传至目标 HTTP。取消等待共享 token 只脱离自己的 waiter，不能终止其他
caller。关闭先阻止新调用并取消 method，再关闭自有 token/client 并等待收尾。
不关全局 fetch dispatcher。JSON 请求 64KiB、响应 256KiB、小程序码 2MiB
是工程资源预算，与微信平台可用性或最大输出承诺无关。

token 获取的配置/IP/冻结/网络等任何失败均 `unavailable`，不能让身份层误报
`WECHAT_CODE_INVALID`。明确拒绝按各端点固定码映射；未知、繁忙、5xx、畸形
响应均不可假成功。目标 token 失效仅 CAS 清理旧值；当前业务请求不重发，
下一独立调用可再取。所有六方法均无未知结果自动重试。

登录只返回 openid/可选 unionid，丢弃 session_key。手机号实际验证 watermark
AppID 与配置相同，保留 countryCode/purePhoneNumber；非86 phone带 `+区号`。
身份层负责正式区号拒绝/盲索引，驱动成功不是大陆身份验证已完成。
文本 v2 从 result.suggest 映射 pass/review/risky→pass/review/block；2500字按
Unicode code point 计算。图片 v2提交只返回 pending+真实 traceId，异步回调
另归安全/媒体模块；驱动不下载 mediaUrl、核文件大小或伪造最终审核结果。
订阅 errcode=0仅 API 接受，不代表实际到达；模板值不静默截短。
小程序码直接返回实际 PNG/JPEG bytes，不返回假URL；JSON错误不能当图。

官方主源使用已保存八份摘录与 inventory：
`/tmp/lyx-w221-current-official-docs.json`。对应方法为 code2Session、
getPhoneNumber、sendMessage、getUnlimitedQRCode、msgSecCheck、mediaCheckAsync，
token 为 getStableAccessToken 普通模式；旧 getAccessToken 不作失败降级。
公开文档链接见本包最终PR描述及 HTTP/token README，原 errmsg/detail/关键字/
会话密钥/token/手机号/请求原文均不进入驱动失败 message 或日志。

本叶用虚构响应与 owned 本地 HTTP 验证协议和取消。真实 ALS guard、FILE
半配/未配、生产选择与 runtime close 属 root 装配验收；本叶绿不能代替。
E2真实配置、平台接收地址、真机手机号组件、真实消息/图片回调均仍外部未验。
W221 两 HTTP/回调/三个桩仍需各叶整合，一包一PR；本文不宣称全包完成。

订阅发送复用 actual main 的 `NotificationProviderResult`：调用方 `signal` 只
取消本方法的等待/目标 HTTP，不取消其他 caller 共用的取 token；外层 guard
仍先执行。目标尚未发出的失败为 `not_accepted`，发出后网络/取消/畸形或
未知回应为 `unknown`；完整 2xx 的有限官方拒绝码才证明未受理。已解码结果
不被随后取消或 CAS token 清理覆盖；既不补发当前请求，也不把 `unavailable`
当重发授权。原通用 mapping 及其他五方法不新增通知 metadata。

官方 sendMessage 响应只列 errcode/errmsg，本驱动不给订阅成功生成 msgId。
43101 仅能确定未订阅或次数已用完，映射 no_quota；43108 映射 rate_limited；
42001 沿已有通用 tokenInvalid 的完整 2xx 拒绝证据，返回 provider_rejected，
不称该码是发送页面新列码。所有失败字段有限，不输出原 errmsg/abort.reason。
新 notification.test.ts 使用虚构响应和本机 owned socket 证明取消及结果边界；
服务端订阅回执/quota 与真实消息到达仍属后续集成，不由本叶伪造。
