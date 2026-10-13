# W2-09 手机号换绑窄片

- 归属：m.smsCode.create（仅phone_change）、m.me.changePhone；整包保持进行中。
- 复用three-phase、现有phone/security与notify.sendDirect，不增依赖或公共框架。
- 必要前置：本域purge_empty真实守卫、空账号个人依附清理和account_change关闭回调；人工发起/通过不开放。
- 既有merchant_user.phone_changed/deleted补正式载荷schema；旧号仅提交后内存直发，不存明文/验证码。
- 风险定点：8DB组含双max1竞争3轮、6HTTP组；ROOT统一验收，不重跑旧全量，不扩DDL/锁序/白名单。
- 必要偏差：notify/direct.ts非验证码daily_cap预读移至claim事务外，修复全局池max1自等待，保留原预算与锁规则。
