# W4-04 异步银行回单识别前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | W4-04先消费独立回单技术前置，再实现账务比对与复核；不改变4 API/3 x01归属或里程碑退出条件 |
| 原因 | W3-16实际只交同步营业执照OCR，银行回单Provider、异步ocr job及完成事件载荷尚缺，不能冒用证照结果 |
| 影响的包 | W4-04；本前置独立审查合入actual main后才由billing消费 |
| 类别 | 顺序 |
| PR | — |

允许叶：Provider types/unconfigured/fake、既有腾讯SDK驱动及私有回单解析器；
media/ocr回单策略、公口及runtime窄装配；既有media.ocr.completed typed载荷、同域README和最小测试。
不改依赖、DDL、kernel、任务框架、账务表、确认收款或原营业执照语义。

官方[BankSlipOCR](https://cloud.tencent.com/document/api/866/57674)及
[BankSlipInfo](https://cloud.tencent.cn/document/api/866/33527)按Name/Value返回；
只消费已明确的付款账号、交易金额、币种、日期。未明确的户名/备注保持null和missing告警，
重复冲突、币种不明、金额或完整时刻/时区不能可靠解析时留null，不从raw或手填值猜测。
图片/PDF只第一页、六秒有界取消；内部原值仅加密，读口仅返回payerAccountMask。
完成事件与OCR结果同TX，任务输出/事件不含明文识别值或签名URL；media不写billing表。
未配返回unavailable，不造成功；原保留期、任务槽、失败与关闭机制保持。

预发OCR FILE目前只挂api/check-env，worker配置接线与精确门禁须独立伴随后继；
本片不混门禁、不宣称真实云、密钥、准确率或预发worker已联调。


调度接受约519行新增/净451行非测试机制范围：包含既有SDK取消运输的必要复用搬动，
以及文件/任务/版本绑定、缓存ok分支、终态密文移交与任务输出清理、六秒取消和角色关闭装配；
不为压行牺牲守卫，不新增通用框架。后续同读口增加可选mediaJobId真实性检查，
核job全部输入绑定/终态安全输出/当前文件版本；事件消费不跨域查表，缓存ok由调用方即时读取。

实际验证：唯一正式审查56.879秒，原15叶首尾hash一致、P1/P2/D=0；
消费方job绑定、正式错误符号与typed Provider样例三点定向核对0阻断，无重复整审。
Node24 services首类型RED22.489秒（错误符号不在枚举、样例表漏新方法），窄修后G21.120秒；
API首类型G16.749秒。新SDK/解析1+新DB1+旧执照最小协议1合并3/3G（另1旧例未选），
Vitest总6.77秒/测试1.97秒，外层同进程单调7.380秒，无测试RED或failed库。
日志`/tmp/lyx-w404-services-types{,2}.log`、`/tmp/lyx-w404-api-types.log`、`/tmp/lyx-w404-targets.log`；
正式公口核会话w404ocr剩余库0/无在途，`/tmp/lyx-w404-cleanup.log`。
原W3-16历史矩阵未重跑，原断言/时限保持；普通同步actual main97dce83b无源码冲突。
