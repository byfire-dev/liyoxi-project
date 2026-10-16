# W4-13 发票与受控财务配置实现边界

| 项 | 内容 |
| --- | --- |
| 改了什么 | W4-13的16 API/0页面/2 x01复用原审批factory，补发票域、原通知mail消费及所属事实读口；邮件驱动/角色配置和staff上传策略由独立前置交付。 |
| 原因 | 既有通知尚无mail消费；实际worker缺部分W4-04接线，staff回单/发票上传分类策略缺失；旧SMTP/10MB说明与Tencent SES事实不符。 |
| 影响的包 | W4-13；W4-04 worker接线及contract/notify/shared必要伴随；仅补齐W4-01/W4-02/W4-06原漏店员样例。无DDL、锁序、通用事务或新依赖修改。 |
| 类别 | 范围、顺序 |
| PR | 本地codex/w4-13-invoices-finance-config；远端PR未创建。 |
| 验证 | 唯一源码审查及定点修复闭合；原4DB+2HTTP累计G，最终services7/API3、depcheck2（4095模块零违规）、矩阵/mount/clerk及所属登记G；真实云边界保留。 |

## 实现与必要伴随

申请保存已认证主体与全额付款快照；蓝/红票、纸质快递、私有下载、SLA/日历按现有状态与flow处理。财务配置仅bank_account/purchase_policy/controls，复用异人审批与银行批准后24h生效；审批幂等键由原INSERT记录，不能UPDATE不可变列。

四个明确item_name键补canonical text定义，默认null、申请时快照，未配拒绝而不猜税务名称；共享invoice链只追加08:1133日历同状态事件。同一固定候选批次预锁订单，再处理transfer与invoice，既有独立调用默认不变。

notify保原claim/T2/Provider/T3、受限重发与未知结果边界；mail附件事务外读取真实文件，目标HMAC使用明确域分离，不新增密钥目的。真实buildWorkerServices补MAIL与已有W4-04 transfer/OCR scope及生命周期；API先queued，实际worker未配后skipped，不把API无密钥误作全局能力判断。仅本域16薄路由设置no-store。

## 审查与定点结果

唯一独立审查452.290秒、59叶首尾哈希一致，0P1/5P2/0D；票号冲突、本人撤回、北京月界、退款红冲及审批归属五项已修并定点核闭。finance DB第3轮G8.39秒，2HTTP/后台生产矩阵/mount G，clerk第2轮G17.47秒；官方矩阵12行纯新增，店员四新口及六既有billing漏口均canonical none，旧样例/字段golden不变。

保留首次类型/SLA夹具、4DB和HTTP缓存头/店员覆盖/台账表键失败：财务不可变键改原INSERT；测试bigint序列化按真实类型修；staff上传交独立媒体前置。depcheck首5R中类型定义移到context消除环，其余测试改正式公口；depcheck第2轮已通过，不改门禁。上传前置e9cfbb78已合并消费，三发票聚合第3轮3/3G39.43秒，原4DB+2HTTP业务累计G，不重跑已绿大矩阵。

## 外部与后继

Tencent SES固定模板变量text，附件总原始≤4MiB/请求≤8MiB；MessageId、sent和兼容notify.mail_delivered只代表受理，非邮箱送达。D6旧SMTP说明按此事实勘误。真实模板/密钥、SPF/DKIM、邮箱到达、OFD兼容与E20未验。

W4-10退款API与refundRequests仍未交；本包仅交严格owned红票/退款守卫，跨包桩保持留桩中。发票子项已通过本地业务、类型和门禁验收，不提前关闭整桩。

上传前置合入后，第2轮通知超时查实为订阅事务中冷参数缓存经全局池取数，非financeConfigAt未传TX。仅dispatch同叶窗口/fanout.batch改已有paramsAt读取callerTx；原单池与10秒守卫保持。另退款守卫测试投影保持真实tx.run句柄身份，业务断言不变；ROOT仅复验原3失败组后第3轮全部G；最终types/depcheck在途。
