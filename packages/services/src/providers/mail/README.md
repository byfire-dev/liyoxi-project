# Tencent SES邮件

复用既有`MailProvider.send({to,subject,text,attachments?,signal?})`，单收件人，
固定`https://ses.tencentcloudapi.com/`、service=ses、SendEmail/2020-10-02。
依据[SendEmail](https://cloud.tencent.com/document/api/1288/51034)、
[Template/Attachment](https://cloud.tencent.com/document/api/1288/51053)、
[附件说明](https://cloud.tencent.com/document/product/1288/51951)。

`MAIL_TENCENT_FILE`为≤4KiB普通UTF8 JSON：
`{secretId,secretKey,region,fromAddress,templateId}`，任何环境拒明文配置；
region独立，仅ap-guangzhou/ap-hongkong，fromAddress为不含别名的完整邮箱，templateId正整数。
发信域名及模板须E20真实审核，模板使用纯文本`{{text}}`变量；不使用废弃Simple/HTML变量或附件URL。
附件数量≤10、总原始字节≤4MiB、完整UTF8请求≤8MiB，文件名禁止官方禁字符/空白/路径/控制字符。
Provider不转换格式或给OFD改名；附件HTTP封装已用受控收件端验证，PDF/OFD真实平台兼容仍未验，拒绝时保留failed。

runtime仅worker消费完整配置并登记close；API保持unconfigured，显式Providers替身仍优先。
check-env只读/校验配置，不构造外呼。compose挂载、manifest/角色精确门禁另片交，未完成前不称预发接通。
初始化/未配零HTTP；发送10s×1，取消与close中止本驱动在途请求，不内部重试。
只有合法MessageId认作服务商受理，`providerMsgId`同值；没有送达/打开/回执推断。
明确官方拒绝返回not_accepted；网络/超时/未知响应保unknown，禁止据unavailable自动重发。
错误仅固定分类，不回显正文、邮箱、附件、Authorization、密钥或服务商原message。

唯一新聚合`src/providers/mail/tencent.test.ts`：公开独立TC3向量、原生fetch本地实际HTTP，
FILE/未配/生命周期、模板与附件边界、错误去敏/超时/无重试；无真实云或密钥。
