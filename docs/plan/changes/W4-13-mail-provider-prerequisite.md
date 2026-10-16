# W4-13 邮件推送驱动前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 在既有MailProvider.send内交独立Tencent SES HTTP驱动、FILE配置与worker窄装配 |
| 原因 | 发票邮件后继缺真实发送适配，不能把fake/unconfigured或排队状态冒充服务商受理 |
| 影响的包 | W4-13通知/发票消费；E20真实账号、域名/模板与送达仍外验 |
| 类别 | 顺序、范围 |
| PR | — |

允许providers/mail新叶、providers/index、kernel/env、runtime邮件worker装配、README/.env.example与最小新聚合。
不改MailProvider业务接口、Provider白名单、旧门禁/角色矩阵、DDL/kernel机制、依赖或通知重试规则。
worker只消费完整MAIL_TENCENT_FILE；API不装邮件driver，check-env只解析，不实例化外呼。
manifest/compose挂载与精确旧门禁由独立伴随后继接入，不在本片放宽。

官方SendEmail固定ses.tencentcloudapi.com/2020-10-02，独立region仅ap-guangzhou/ap-hongkong；
用已审核Template而非废弃Simple，固定text变量，附件只发送实际字节的base64，不取URL。
配置{secretId,secretKey,region,fromAddress,templateId}只从独立FILE读取；模板/域名/真实密钥本片不创建。
单次有界HTTP与取消/close，无内部重试；只有合法MessageId认作受理，不能宣称终端送达。
真实fetch在本地受控收件替身验证协议；无真实云、账号、资金或部署动作。

唯一ROOT独审94.242秒，原10叶首尾核对、P1/P2/D=0；两明确类型点修定向闭合。
Node24 services首R22.678秒（新logger缺error、Zod闭包未保持收窄）→仅局部已验配置常量/夹具方法点修后G19.791秒。
唯一聚合首R2.133秒：原生fetch转loopback URL后实际Host随URL改变，新夹具原断言假设不实；
仅转发边界严格核SES URL/Host、收件端核自有loopback Host，复验1/1G（Vitest1.62秒/tests166ms，外层单调2.164秒）。
原固定TC3独立向量/模板正文/附件/边界/取消/close/无重试断言保持，未改生产运输以迎合夹具。
单worker/session=w413mail，正式standalone核无在途/剩余库0；本轮HTTP和假FILE已finally关闭清理，未用Redis。
日志`/tmp/lyx-w413-mail-services-type{1,2}.log`、`/tmp/lyx-w413-mail-target{1,2}.log`、`/tmp/lyx-w413-mail-cleanup.log`。
部署角色/manifest与旧精确门禁尚待独立接线；E20域名/模板/真实发送与PDF/OFD平台兼容均未验。
