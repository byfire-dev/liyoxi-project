# 账单下载与对账（W4-12）

正式边界是a07第3.74–3.75节、08第2.7–2.9节和D2第8节；2个API、2个周期任务、无页面，复用已合收款/退款机制。当前源码已接严格原件、逐主体匹配、两API/任务及独立不变量，仍在实际验收中，不表示资金对平。

旧`fetchTradeBill`展示口保持行为。资金路径只调用`fetchVerifiedTradeBill`：驱动验签申请应答和明确缺账错误，限定下载来源并校验SHA1，绑定请求日和驱动身份；原字节以私有字段保存，每次只交副本。构造工厂只从Provider装配入口给驱动和替身使用，领域沿D8只能消费types端口，不接收HTTP传入的“verified”或原文。missing是等待证据，不能制造空ok日、清platform_only或静默确认无交易。

严格解析只支持官方当前ALL格式；少量旧商户的历史表头以受控header错误拒绝，不宣称全历史格式兼容。行金额符合数据库int32，跨主体汇总全程bigint并存十进制字符串；验证七列汇总、笔数、交易日/状态/币种/手续费符号及正反数值，缺汇总/非法UTF8/错误日期/溢出均不进入资金流程。原件经现有media.putSystemFile的pay_bill平台级永久归档；仅增加system权限，不开放商家/员工手传。事件与普通日志不带URL、正文、openid或银行账号。

官方“退款金额”是结算金额，“申请退款金额”才是queryRefund及refund_txn.amountFen的全额。wx_bill_line.refund_amount_fen保留原结算字段；wx_bill_file.summary原尾汇总保持不变，另有refundApplications（v=1、同文件sha1、按lineNo的申请额整数分），只由本次可信原件严格解析产生。匹配与日行退款展示累计申请额；缺失/不匹配的派生证据受控失败，不能回退为结算额。原件结算汇总与申请额不冒用同一名称。

协议依据：[官方交易账单说明](https://pay.wechatpay.cn/doc/v3/merchant/4013071246)、[申请交易账单](https://pay.wechatpay.cn/doc/v3/merchant/4012791907)、[下载账单](https://pay.wechatpay.cn/doc/v3/merchant/4013071238)。退款行按发起退款成功时间出账，出账后状态不更新，不能把PROCESSING当成功；汇总笔数是全部明细，汇总金额是对应列之和。真实退款账单日期/状态回放与E5/E13/V13仍待授权真实样本，本机公开样本不是真实对平证明。

运行与故障处置见[运行手册第3.3节](../../../../../docs/plan/runbook.md#33-账单下载原件和重跑w4-12)。中断匹配以同parsed原件的matching_failed及实际失败时间持久恢复，至少30分钟重试；成功job与人工重跑末TX清标记，正常已完成diff不自动重复。NO_STATEMENT_EXIST保持pending/wait，正式08的历史empty只兼容读进度，不由本包新写或用于清绿。
