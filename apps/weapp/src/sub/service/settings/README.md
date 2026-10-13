# 账号设置（W2-13）

## 交付范围

仅登记 `sub/service/settings/index` 一页。本人称呼、旧号短信与新号码授权换绑、微信身份分页及解绑、
服务器一次性提示关闭、退出、注销均消费已有本人接口。账号按钮取服务端 actions，注销阻断项
只展示服务器返回的六类及数量。隐私与用户服务协议使用当前版本；通知进入已有消息与订阅页。
已授权电脑显示未开放，不调用后续 portal 路由。

## 操作与失效

私有 model 同步持有写忙锁，失败同意图复用键、修改内容换键；确认成功立即结束该意图，
不因后续刷新失败让未来 A/B/A 复用第一次 A 的回执。token/contextRev、读代次及写后刷新
废弃旧响应，旧 finally 不解除新所有者的锁。卸载清理本页控制器。

换绑失败为实际可重试错误时，仅在私有内存保留未决 body 与原键，通过“重试上次换绑”重放；
编辑旧验证码、另取新授权、成功、非重试失败、关闭弹层或卸载时销毁。不日志或本地持久化
手机号、短信码、临时号码凭证。换绑保留当前令牌；服务端返回当前身份已吊销、注销成功或
当前请求最终 401 时沿公共 account.clear 清会话与门店上下文。

## 手机号与公共边界

PhoneForm 与换绑使用 Taro 原生 getPhoneNumber Button，先经现有 ensurePrivacyAuthorized。
拒绝授权、隐私未同意或额度不足均不伪造号码；H5 明示不支持号码验证。登录继续既有协议版本、
loginCode、首次归因与 returnUrl/query。公共 controller 仅修 phoneLogin 的 opaque code 参数
及 1–128 字符校验，其他公共 API/runtime/request/platform/bootstrap 没有改动。

## 验证入口

ROOT 独占重型验收；作者仅所属 prettier/eslint/diff 与正常提交。
新风险单测为 `model.test.ts` 6组、`runtime.test.ts` 2组，原 account-controller 仅更新受影响
opaque 边界组。模型覆盖 A/B/A、未决换绑原体重试、切店/换令牌/卸载、迟到 401、六类阻断
及按 id 关闭提示；传输断言直接对应实际 operations。

本域 H5 场景为 settings-owner/clerk/guest/name-saved/delete-blocked/notice-retry/
phone-unavailable/identities，脚本只追加本域登记，默认旧场景与外发/console/pageerror 守卫保留。
PNG 路径为 `apps/weapp/shots/dist/png/settings__<scene>.png`，源码记录不是已执行证据。

## 外部验证

真实 iOS/安卓手机号组件、添加其他号码、隐私申报、供应商短信投递和收费能力未验证。
H5 截图只证明页面与私有 typed 接线，不能代替 E2/E9/V19 及 W2-30 真机验收。
