# W4-18 发票页面真实上传验收独立前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 新增精确绑定本轮scope的私有invoice上传验收适配，实际complete后只消费该文件已入队的promote任务 |
| 原因 | 原live运输未覆盖invoice，实际登记与complete成功后仍为promoting，不能用扩大等待或伪stored代替真实页面验收 |
| 影响的包 | W4-18；仅独立测试运输前置，旧上传边界、完整global前置及原等待预算保持 |
| 类别 | 调度批准的独立测试前置；不改生产上传、发票、账本或正式门禁 |
| PR | — |

## 依据与事实

W4-18任务书第4、6、7节要求消费现有上传公口，并通过真实生产页面验证发票开具和红票回填。原live服务器已分别支持协议、凭证、内容和商家素材的精确文件入库；这些边界均不包含invoice。首轮Chrome验收实际register/complete均200，但invoice一直promoting；不能扩大等待、直接写stored或绕过文件归属。

ROOT于2026-10-26授权此独立最小测试前置，同分支独立提交，由调度裁定任务目录伴随。只修改测试运输，不改生产上传、发票、账本、Provider、默认扫描、原等待预算或正式门禁。

## 精确范围

新增`packages/services/src/testing/admin-live/invoice-upload.ts`及三个轻反例，`testing/index.ts`仅导出本域入口。`w418-invoices.ts`只输出本轮已造三主体、原真实管理员及开始时间；`apps/admin/scripts/live-output-batch.mjs`把该scope传入私有manifest；`apps/api/test/upload-batch-live-server.ts`单独剥离可选`w418Invoice`并挂本域适配。旧manifest解析器仍严格，原receiptFiles、协议、内容、商家素材入口和完整global前置保持。

scope严格绑定本机`lyx_test_admin_live_<runId>`、应用角色与本轮Redis前缀、唯一实体名单及真实上传者。只观察该员工对本名单主体的invoice登记，支持原PDF/OFD/XML大小限制，六个文件有界；分类、实体或员工不符走原handler且零任务扫描。成功登记后回读持久file_object，核本人、主体、token、创建时间、secure桶及规范对象路径。

仅成功complete后、真实状态为promoting，查询本fileId的local/queued/到期、精确dedupeKey且无父任务的单条promote，调用原`runtime.media.promote`。没有全库scan或伪终态。beginStop同步拒新意图，原jobs.shutdown之后等本域在途工作结束；按原token找回应答丢失的已提交登记，只回收本轮固化的目标与incoming对象，最后再关闭原服务与runtime。

## 验证结果与口径

本域三个轻目标首次3/3通过，验证环境/名单/本人/六文件上限、成功登记与complete后才执行精确job、错归属零执行、停机排空和应答丢失的精确对象回收。services/API类型通过。调度指定m4_refund_ui在唯一增量审查发现可选scope会丢失原W318商家绑定；`26781624`修复并增加一个纯反例，首次1/1通过（原五目标未选），仅受影响API类型复验通过，审查确认无未处理阻断。旧manifest原解析器本已接受W318，本次实际修复是保留其pump绑定，未放宽原严格字段。

2026-10-26两个发票live业务目标分别通过，均用原harness、单worker及原auth前置，不减少媒体证明或改变预算；原失败可见选项定位窄修后只复验发票RED，已绿红票未重跑。三张PNG与geometry作者已实际看图，最新harness退出0并清理本轮隔离库。具体首次失败、命令入口和截图见[W4-18状态](../status/W4-18.md)。邮件真实发送、外部税务/红票、真实账号与资金均未验，W4-18整包仍进行中。
