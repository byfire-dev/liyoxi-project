# 微信私有 HTTP 与令牌边界

本目录目前只交付 HTTP transport 和 stable token 缓存。六个业务方法、方法级字段校验/错误映射、共享 Provider 工厂、env/runtime 生命周期、回调路由均由后续装配实现；这两个模块不直接暴露为业务公口。

`createWechatClient()` 初始化零 I/O。生产 origin 固定为 `https://api.weixin.qq.com`，路径仅允许六个业务端点及 `stable_token`，禁止跟随重定向。测试仅通过 fetch wrapper 将固定官方 URL 映射到本轮自有 loopback。单请求默认 4 秒，JSON 请求 64 KiB、JSON 响应 256 KiB、二维码响应 2 MiB；这些是本项目工程预算，不是微信官方限制。真实 Content-Length 与累计读取字节均受约束，二维码按 PNG/JPEG magic 与 JSON 错误区分，完整图片校验属于后续消费者。

`WechatClient.request({ path, query?, body?, signal? })` 返回私有 JSON/bytes 或受控失败，失败只保留安全数字 `code`/HTTP `status` 和固定中文说明，不传出 `errmsg`、响应原文、异常原文、URL 或秘密。未知代码视为不可用；最终业务语义仍由方法映射层决定。外部取消、超时、`close()` 均终止自有请求与 reader，卸载定时器和监听器；不关闭全局 fetch pool。不会自动重放任何业务请求。

`createAccessTokenManager({ appid, secret }, { client, cache, now })` 只 POST `stable_token` 普通模式 `force_refresh: false`，初始化不取 token。仅本进程 singleflight；进程之间共享真实 Redis 缓存，不承诺跨进程冷启动只发一个请求。`expires_in` 按此次响应的真实剩余秒数建立保守到期事实，缓存 TTL 扣 60 秒；不足或等于 60 秒仅本次使用，不能延长缓存。缓存操作预算 200 ms；故障可使用真实仍有效本地 token，或通过真实普通模式 token 请求退化。token 配置拒绝对业务视为不可用，安全数码仅留私有结果。

`createRedisTokenCache(borrowedRedis, prefix)` 要求 ioredis 已带完全相同前缀，命令仅传一次未加前缀的 `wx:token:<appid>`；不创建/断开借用连接。失效使用 Lua 对旧 token 值 CAS 删除，不能删除另一次写入的新 token。manager 关闭只取消自身等待与 token 请求；完整驱动的拥有者还需关闭 client。方法级 8 秒总体预算与调用者独立取消由后续驱动负责，单个等待者取消不能中断其他请求共享的 token singleflight。

测试使用虚构 AppID/secret/token、自有 HTTP socket 及隔离 Redis 前缀，验证有界 body、真实重定向/超时/取消/断流、20 并发 singleflight、真实 TTL/CAS/共享缓存、同一自有连接 BRPOP 阻塞导致的缓存预算退化与精确清理。测试没有调用微信平台，不能据此声称平台通知到达或真实微信凭证验证通过。

官方依据（2026-10-08 阅读）：

- [稳定 access token](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-access-token/api_getstableaccesstoken.html)
- [登录凭证校验](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-login/api_code2session.html)
- [获取手机号](https://developers.weixin.qq.com/miniprogram/dev/server/API/user-info/phone-number/api_getphonenumber.html)
- [发送订阅消息](https://developers.weixin.qq.com/miniprogram/dev/server/API/mp-message-management/subscribe-message/api_sendmessage.html)
- [无限小程序码](https://developers.weixin.qq.com/miniprogram/dev/server/API/qrcode-link/qr-code/api_getunlimitedqrcode.html)
- [文本内容安全](https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_msgseccheck.html)
- [异步媒体内容安全](https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_mediacheckasync.html)
