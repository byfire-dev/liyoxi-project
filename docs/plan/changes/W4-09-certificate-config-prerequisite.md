# W4-09 商户API证书期限事实前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 既有WECHAT_PAY_FILE严格JSON可选接收merchantCertificatePem，经X509身份核验派生merchantCertificateExpiresAt |
| 原因 | 公钥模式现有merchantSerialNo与商户私钥不能推出证书到期日，健康不能用假日期或0替代未知 |
| 影响的包 | W4-09；独立配置前置提供证书期限事实，健康实现与后续验收仍归原包，不改里程碑或退出条件 |
| 基线 | actual main `a18f5978d03cfa9fac711690ed67efce0753a9f3`；W4-09健康源码仍保留独立未完成分支 |
| 范围 | kernel/env.ts的可选FILE解析、新3目标、既有假证书生成器的公开testing桥、providers README与本说明 |
| 类别 | 调度批准的独立配置窄前置；不改DDL、Provider协议、通用内核机制、依赖或门禁 |
| PR | — |

证书序列号按hex同值比较，证书公钥必须对应现配置商户私钥；微信支付平台公钥不是商户API证书公钥。只保留证书自身validTo事实，不把证书PEM传给健康，不从序列号、签发时长或当前时间猜测到期。派生字段不是可接受的JSON输入。旧配置无该可选PEM仍可启动且输出不变；事实缺失继续由W4-09降级，本片不回补未合入的健康实现。

测试只用既有运行时自签假X509生成器，经testing公开出口复用；自有临时文件测试FILE边界、旧输出兼容、真实serial/私钥匹配与validTo、错误输入和派生字段伪填的拒绝及脱敏。没有读取真实环境/证书/密钥，没有外呼、资金或服务器操作。

本机singleworker/session=w409cert1，新增3目标一次全部通过（5.30秒），一次services类型检查通过；ESLint/Prettier、diffcheck与正常hooks通过。执行前静态纠正公开测试publicKeyId后缀的下划线，不改原校验。自有临时目录由afterAll清理，无失败遗留库，重进程退出。无业务/旧全量重跑；健康HTTP200和发货/自动退款验收仍由W4-09主包承担。
