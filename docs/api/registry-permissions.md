# 权限点与能力点注册表

| 项 | 内容 |
| --- | --- |
| 状态 | 评审稿（2026-10-03）；接口契约的唯一来源 |
| 依据 | d4-identity.md 第 7.1 节（后台权限点）、第 5.2 节（商家能力点）；裁决 A13、A15、A36、A45、A46、A53、A60、A65、A87、A88、A92、A127、A128、A129、A136、A139、A140、A149；约定 C54、C56、C66、C67、C86；各文档第 1 节与清单 |
| 生成方式 | 脚本 `tools/api-check/gen_permissions.py` 读路线图（`routemap.json`）统计每个键被哪些接口引用，读各文档“回显”栏算二次确认回显；键的默认值由汇总人按上述依据统一 |
| 核对 | 路线图引用的后台权限点 92 个、能力点 38 个，全部在本表 |

说明：
- **本表是唯一来源**。代码落在 `packages/contract/src/permissions.ts`（后台）与 `packages/contract/src/authz/merchant-caps.ts`（商家端）。路由只能引用表里的键，写错编译不过（d4 7.1 第 3 条）。d4 附录的旧表不再回改（A129）；d4 里作废的旧名不列。
- **查看类不设权限点**，由模块等级表达（`need: view`）。例外只有 `flow.ops.view`（A129，见第 5 节）。
- **再验证**以本表为准，接口不另声明（A13）。窗口 10 分钟，超出 403 `STEP_UP_REQUIRED`。唯一例外是第 4 节登记的驳回接口（`x-step-up: skip`）。处理器内取到的键若标了再验证，处理器同样校验。商家端 V1.0 没有再验证。
- **默认授予**：`*` = 仅主管；超级管理员拥有全部，不逐行写。“仅超级管理员”表示其他角色默认都不开。
- **待分配池**：持有该键且是主管的员工，能看到负责人为空的对应资源（d4 7.3）。
- **二次确认回显**（C54）：按各文档接口的“回显”栏统计。“要”= 用到该键的接口都带 `confirm`；“部分”列出带的接口；“—”= 只在处理器内用到，回显随所在接口。
- **`assert-in-handler`**：权限取决于对象或请求体的接口，路由声明这个值，判定规则见第 3 节（A45、A87）。

## 1. 后台权限点（V1.0，111 个）

### 1.1 商家管理（17 个）

| 键 | 名称 | 默认授予 | 再验证 | 待分配池 | 二次确认回显 | 起始版本 | 用到的接口 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `merchant.profile.proxy_edit` | 代改门店档案 | 客服、交付经理 | 否 | — | 否 | V1.0 | `admin.store.profile.update`；处理器内另见 `admin.file.create` | d4（原型） |
| `merchant.manager.assign` | 首次分配交付经理 | 交付经理* | 否 | `store_manager` | 否 | V1.0 | `admin.store.assignDeliveryManager`、`admin.deliveryTicket.assignManager` | d4；A91；d3 `delivery.ticket.assign` 并入 |
| `merchant.manager.transfer` | 转移交付经理 | 交付经理* | 否 | `store_manager` | 要 | V1.0 | `admin.store.reassignDeliveryManager` | d4；A136 |
| `merchant.qualification.review` | 资质审核（通过、驳回、修正识别字段） | 客服（PRD 未指明岗位，待拍板） | 否 | — | 部分：`admin.qualificationSubmission.approve`、`admin.qualificationSubmission.reject` | V1.0 | `admin.qualificationDoc.update`、`admin.qualificationSubmission.approve`、`admin.qualificationSubmission.reject`、`admin.qualificationSubmission.rejectQuote`；处理器内另见 `admin.piiReveal.create` | d4 |
| `merchant.qualification.override` | 比对异常时放行（处理器追加判定） | 仅超级管理员 | 否 | — | — | V1.0 | 处理器内：`admin.qualificationSubmission.approve` | d4；a03 1.1 |
| `merchant.asset.review` | 素材复核（整理、确认肖像授权） | 交付经理 | 否 | — | 否 | V1.0 | `admin.storeAsset.confirmPortraitAuth`、`admin.storeAsset.delete`、`admin.storeAsset.reprocess`、`admin.storeAsset.review` | d4 |
| `merchant.asset.demand.create` | 发起与结束素材需求 | 交付经理 | 否 | — | 否 | V1.0 | `admin.assetDemand.create`、`admin.assetDemand.cancel`、`admin.assetDemand.complete` | d4 |
| `merchant.asset.upload_on_behalf` | 代商家上传素材与肖像授权材料 | 交付经理、客服 | 否 | — | 否 | V1.0 | `admin.storeAsset.create`、`admin.storeAsset.portraitAuth.create` | A35、A129；a03 |
| `merchant.user.disable` | 禁用、启用商家账号 | 客服* | 要 | — | 要 | V1.0 | `admin.merchantUser.disable`、`admin.merchantUser.enable` | d4 |
| `merchant.user.force_logout` | 强制商家账号下线 | 客服 | 否 | — | 要 | V1.0 | `admin.merchantUser.forceLogout` | d4 |
| `merchant.account_change.request` | 发起账号变更（换绑手机号、老板更换、老板复核） | 客服 | 否 | — | 要 | V1.0 | `admin.accountChangeRequest.create` | d4 |
| `merchant.account_change.approve` | 审批账号变更 | 客服* | 要（驳回豁免，C86） | — | 要 | V1.0 | `admin.accountChangeRequest.approve`、`admin.accountChangeRequest.reject`；处理器内另见 `admin.accountChangeRequest.withdraw` | d4；A127 |
| `merchant.quota.override` | 门店与成员上限覆盖 | 仅超级管理员 | 要 | — | 要 | V1.0 | `admin.entity.quota.update` | d4 |
| `merchant.entity.close` | 后台关闭经营主体 | 仅超级管理员 | 要 | — | 要 | V1.0 | `admin.entity.close` | C66、A129；a03 |
| `merchant.referral_code.manage` | 渠道码登记、停用、启用 | 客服* | 否 | — | 否 | V1.0 | `admin.referralCode.create`、`admin.referralCode.disable`、`admin.referralCode.enable` | C66、A129；a03 |
| `pii.phone.reveal` | 明文查看手机号 | 客服、交付经理、财务 | 否 | — | — | V1.0 | 处理器内：`admin.piiReveal.create` | d4 |
| `pii.license.view` | 明文查看证照号与证照原图 | 客服、交付经理、财务 | 否 | — | — | V1.0 | 处理器内：`admin.piiReveal.create` | d4 |

### 1.2 订单管理（8 个）

| 键 | 名称 | 默认授予 | 再验证 | 待分配池 | 二次确认回显 | 起始版本 | 用到的接口 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `order.refund.request` | 发起套餐退款、订购取消、广告取消 | 客服 | 否 | — | 部分：`admin.paymentOrder.refundRequest.create` | V1.0 | `admin.ad.cancelQuote`、`admin.ad.cancelRequest.create`、`admin.cancelRequest.void`、`admin.order.cancelQuote` 等 7 条 | d4（D2 同名） |
| `order.payment.create_offline` | 线下开单 | 财务（D2 确认） | 要 | — | 要 | V1.0 | `admin.paymentOrder.create` | d4；A46 |
| `billing.extension.request` | 发起补偿延长有效期 | 交付经理 | 否 | — | 部分：`admin.termExtensionRequest.create` | V1.0 | `admin.subscriptionTerm.extensionQuote`、`admin.termExtensionRequest.create` | d4（D1 同名） |
| `billing.extension.approve` | 审批补偿延长 | 交付经理* | 否（驳回已登记 C86） | — | 部分：`admin.termExtensionRequest.approve` | V1.0 | `admin.termExtensionRequest.approve`、`admin.termExtensionRequest.reject`；处理器内另见 `admin.termExtensionRequest.withdraw` | d4；A127 |
| `billing.adjust.request` | 发起积分调整 | 客服、交付经理 | 否 | — | 部分：`admin.pointAdjustmentRequest.create` | V1.0 | `admin.pointAccount.adjustmentQuote`、`admin.pointAdjustmentRequest.create` | d4（D1 同名） |
| `order.license_letter.manage` | 授权书更正、作废并重出 | 客服* | 否 | — | 否 | V1.0 | `admin.licenseLetterRevision.rerender`、`admin.licenseLetter.correct`、`admin.licenseLetter.void` | C66；a05 |
| `order.renewal.remind` | 套餐到期人工提醒 | 交付经理、客服 | 否 | — | 否 | V1.0 | `admin.subscriptionTerm.remind` | a07（proto-admin-b.md:292） |
| `refund.override.request` | 规则外套餐退款（发起） | 仅超级管理员 | 要 | — | 要：随 `admin.paymentOrder.refundRequest.create` 的 `{ orderNo, amountFen }`（a07 3.55） | V1.0 | 处理器内：`admin.paymentOrder.refundQuote`、`admin.paymentOrder.refundRequest.create` | C66；a07（d2:1486） |

### 1.3 交付管理（20 个）

| 键 | 名称 | 默认授予 | 再验证 | 待分配池 | 二次确认回显 | 起始版本 | 用到的接口 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `delivery.ticket.assign_editor` | 指派剪辑师 | 交付经理 | 否 | `ticket_editor` | 否 | V1.0 | `admin.deliveryTicket.assignEditor` | d4（D3） |
| `delivery.ticket.assign_publisher` | 改派发布专员 | 交付经理、发布专员* | 否 | `ticket_publisher` | 否 | V1.0 | `admin.deliveryTicket.assignPublisher` | d4（D3 §28 第 8 项） |
| `delivery.ticket.rework` | 工单返工 | 交付经理* | 否 | — | 否 | V1.0 | `admin.deliveryTicket.rework` | d4 → D3 附录 A；默认取 a05 |
| `delivery.plan.edit` | 编辑方案 | 交付经理 | 否 | — | 否 | V1.0 | `admin.deliveryPlan.draft.replace` | d4 `delivery.plan.*`；a05 |
| `delivery.plan.push` | 推送方案 | 交付经理 | 否 | — | 否 | V1.0 | `admin.deliveryPlan.push` | d4 `delivery.plan.*`；a05 |
| `delivery.plan.reschedule` | 方案改期 | 交付经理 | 否 | — | 否 | V1.0 | `admin.orderItem.rescheduleLaunch` | d4 `delivery.plan.*`；a05 |
| `delivery.sample.upload` | 上传样片 | 剪辑师（本人任务） | 否 | — | 否 | V1.0 | `admin.deliveryTicket.sample.create` | d4 `delivery.sample.*`；a05 |
| `delivery.sample.qc` | 样片质检 | 交付经理 | 否 | — | 否 | V1.0 | `admin.sample.inspect` | d4 `delivery.sample.*`；a05 |
| `delivery.sample.push` | 推送样片；登记广告版本的企业微信发送 | 交付经理 | 否 | — | 否 | V1.0 | `admin.adVersion.markSent`、`admin.sample.markSent`、`admin.sample.push` | d4 `delivery.sample.*`；A129 |
| `delivery.sample.feedback_on_behalf` | 代录样片意见 | 交付经理 | 否 | — | 否 | V1.0 | `admin.ad.requestChange`、`admin.sample.requestChange` | d4 `delivery.sample.*`；a05 |
| `delivery.episode.register` | 成片登记与成片批次上传 | 剪辑师（本人任务） | 否 | — | 否 | V1.0 | `admin.deliveryTicket.episodeOutput.create`；处理器内另见 `admin.uploadBatchItem.update`、`admin.uploadBatchItem.complete` 等 7 条 | d4 `delivery.episode.*`；a05 |
| `delivery.episode.qc` | 成片质检 | 交付经理 | 否 | — | 否 | V1.0 | `admin.deliveryTicket.inspectEpisodes`、`admin.deliveryTicket.inspectPackage` | d4 `delivery.episode.*`；a05 |
| `delivery.ad.assign` | 指派广告剪辑师 | 交付经理 | 否 | `ad_editor` | 否 | V1.0 | `admin.ad.assign` | d4（D3） |
| `delivery.ad.upload` | 上传广告版本 | 剪辑师（本人任务） | 否 | — | 否 | V1.0 | `admin.adVersion.push`、`admin.ad.adVersion.create` | d4（D3） |
| `delivery.ad.return` | 退回补充素材 | 剪辑师、交付经理 | 否 | — | 否 | V1.0 | `admin.ad.return` | d4（D3）；a05 |
| `delivery.download` | 员工下载成片与原片 | 交付经理、剪辑师、发布专员 | 否 | — | 否 | V1.0 | `admin.deliveryTicket.material.downloadUrls` | d4（D5） |
| `delivery.package.reissue` | 发起、取消补发 | 交付经理 | 否 | — | 否 | V1.0 | `admin.deliveryTicket.reissue.create`、`admin.reissue.cancel` | d3 附录 A；a05 |
| `production.normalize` | 成片规范化重做 | 交付经理 | 否 | — | 否 | V1.0 | `admin.productionRecord.normalize` | C66；d5:2143；a05 |
| `production.restamp` | 成片重打水印 | 交付经理 | 否 | — | 否 | V1.0 | `admin.productionRecord.restamp` | C66；d5:2143；a05 |
| `production.recheck` | 成片重新检测 | 交付经理 | 否 | — | 否 | V1.0 | `admin.productionRecord.recheck` | C66；a05 |

### 1.4 发布管理（9 个）

| 键 | 名称 | 默认授予 | 再验证 | 待分配池 | 二次确认回显 | 起始版本 | 用到的接口 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `publish.link.verify` | 链接核验（通过、驳回） | 发布专员 | 否 | — | 部分：`admin.launchSubmission.approve` | V1.0 | `admin.launchSubmission.approve`、`admin.launchSubmission.reject`；处理器内另见 `admin.file.create` | d4 |
| `publish.link.verify_revoke` | 撤销链接核验通过 | 发布专员*、交付经理* | 否 | — | 要 | V1.0 | `admin.launchSubmission.revoke` | C66、A129；a06 |
| `publish.account.verify` | 渠道账号核验（角色队列） | 发布专员 | 否 | — | 部分：`admin.channelAccountSubmission.approve` | V1.0 | `admin.channelAccountSubmission.approve`、`admin.channelAccountSubmission.reject`；处理器内另见 `admin.approval.list`、`admin.approval.summary` 等 3 条 | d4 |
| `publish.account.mark_abnormal` | 标记渠道账号异常 | 发布专员 | 否 | — | 否 | V1.0 | `admin.channelAccount.markAbnormal` | d4 |
| `publish.package.push` | 推送成片包、发布补发 | 发布专员、交付经理 | 否 | — | 否 | V1.0 | `admin.deliveryTicket.pushPackage`、`admin.reissue.publish`、`admin.deliveryRelease.pack` | d4 |
| `publish.list.edit` | 编辑、导入发布清单 | 发布专员、交付经理 | 否 | — | 否 | V1.0 | `admin.deliveryTicket.publishList.replace`、`admin.deliveryTicket.publishList.import` | d4 |
| `publish.patrol.do` | 巡检 | 发布专员 | 否 | — | 否 | V1.0 | `admin.patrolTask.create`、`admin.patrolTask.markAbnormal`、`admin.patrolTask.markNormal`、`admin.patrolTask.recover` 等 5 条；处理器内另见 `admin.file.create` | d4 |
| `publish.takedown.check` | 下架核查 | 发布专员 | 否 | — | 否 | V1.0 | `admin.takedownTask.batchCheck`、`admin.takedownTask.check`、`admin.takedownTask.escalate`、`admin.takedownTask.markOnline`；处理器内另见 `admin.file.create` | d4 |
| `publish.takedown.breach_notice` | 违约提醒 | 发布专员 | 否 | — | 否 | V1.0 | `admin.takedownTask.sendBreachNotice` | d4 |

### 1.5 客服工单（5 个）

| 键 | 名称 | 默认授予 | 再验证 | 待分配池 | 二次确认回显 | 起始版本 | 用到的接口 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `service.ticket.register` | 登记工单 | 客服、交付经理 | 否 | — | 否 | V1.0 | `admin.serviceTicket.create` | d4（D3） |
| `service.ticket.reply` | 提交处理结果；改类型与优先级、增删关联；工单附件上传 | 客服、交付经理 | 否 | — | 否 | V1.0 | `admin.serviceTicket.update`、`admin.serviceTicket.entry.create`、`admin.serviceTicket.ref.create`、`admin.serviceTicket.ref.batchRemove` 等 5 条；处理器内另见 `admin.file.create` | d4；A92 |
| `service.ticket.close` | 关闭工单 | 客服、交付经理 | 否 | — | 否 | V1.0 | `admin.serviceTicket.close` | d4 |
| `service.ticket.transfer` | 负责人转出；主管可改派任意工单 | 客服、交付经理 | 否 | — | 否 | V1.0 | `admin.serviceTicket.reassign` | d4；A129 改含义 |
| `service.ticket.assign` | 分配无负责人的工单 | 客服* | 否 | `service_ticket` | 否 | V1.0 | `admin.serviceTicket.assign`；处理器内另见 `admin.staff.list`、`admin.staff.duty.update` | d4；A129 改含义 |

### 1.6 短剧库管理（3 个）

| 键 | 名称 | 默认授予 | 再验证 | 待分配池 | 二次确认回显 | 起始版本 | 用到的接口 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `drama.shelf` | 上架与下架 | 内容运营 | 否 | — | 否 | V1.0 | `admin.drama.delist`、`admin.drama.shelve` | d4（原型） |
| `drama.copyright.revise` | 修订版权期限 | 内容运营 | 否 | — | 要 | V1.0 | `admin.drama.dramaCopyrightRevision.create`；处理器内另见 `admin.file.create` | A129；a04（d8:531） |
| `drama.media.manage` | 原片与预告片管理 | 内容运营 | 否 | — | 否 | V1.0 | `admin.drama.trailer.replace`、`admin.uploadBatch.commit`；处理器内另见 `admin.file.create`、`admin.uploadBatchItem.update` 等 8 条 | A129；a04（d5:2143） |

### 1.7 套餐与积分（4 个）

| 键 | 名称 | 默认授予 | 再验证 | 待分配池 | 二次确认回显 | 起始版本 | 用到的接口 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `billing.plan.edit` | 套餐与价目修订 | 内容运营 | 否 | — | 部分：`admin.planRevision.withdraw` | V1.0 | `admin.planRevision.withdraw`、`admin.plan.create`、`admin.plan.update`、`admin.plan.delist` 等 6 条 | d4（D1） |
| `billing.pack.edit` | 积分包维护 | 内容运营 | 否 | — | 否 | V1.0 | `admin.pointPack.create`、`admin.pointPack.update`、`admin.pointPack.delist`、`admin.pointPack.shelve` | d4（D1） |
| `billing.param.edit` | 计费参数变更 | 内容运营 | 否 | — | 要 | V1.0 | `admin.billingParam.withdraw`；处理器内另见 `admin.pricingChange.create` | d4（D1） |
| `billing.price.edit` | 等级模板价与单剧调价 | 内容运营 | 否 | — | 部分：`admin.drama.dramaPriceRevision.create` | V1.0 | `admin.dramaPriceRevision.withdraw`、`admin.drama.dramaPriceRevision.create`；处理器内另见 `admin.pricingChange.create` | d4（D1） |

### 1.8 财务管理（13 个）

| 键 | 名称 | 默认授予 | 再验证 | 待分配池 | 二次确认回显 | 起始版本 | 用到的接口 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `finance.refund.approve` | 审批取消与退款 | 财务 | 要（驳回豁免，C86） | — | 部分：`admin.cancelRequest.approve`、`admin.refundRequest.approve`、`admin.refundRequest.void` | V1.0 | `admin.cancelRequest.approve`、`admin.cancelRequest.reject`、`admin.refundRequest.approve`、`admin.refundRequest.reject` 等 5 条；处理器内另见 `admin.cancelRequest.withdraw`、`admin.refundRequest.withdraw` | d4；A127 |
| `finance.refund.execute` | 执行退款与退回 | 财务 | 要 | — | 要 | V1.0 | `admin.cancelRequest.execute`、`admin.refundRequest.confirmNotAccepted`、`admin.refundRequest.execute`、`admin.refundRequest.recordOffline` 等 5 条 | d4 |
| `billing.adjust.approve` | 审批积分调整 | 财务 | 要（驳回豁免，C86） | — | 部分：`admin.pointAdjustmentRequest.approve` | V1.0 | `admin.pointAdjustmentRequest.approve`、`admin.pointAdjustmentRequest.reject`；处理器内另见 `admin.pointAdjustmentRequest.withdraw` | d4；A127 |
| `finance.receipt.confirm` | 对公收款确认、二人复核 | 财务 | 要（复核退回豁免，C86） | — | 部分：`admin.transferProof.approveReview`、`admin.transferProof.confirm` | V1.0 | `admin.paymentOrder.transferProof.create`、`admin.transferProof.approveReview`、`admin.transferProof.confirm`、`admin.transferProof.rejectReview` | d4；A127 |
| `finance.receipt.reject` | 驳回对公凭证 | 财务 | 否 | — | 否 | V1.0 | `admin.transferProof.reject` | d4 |
| `finance.invoice.issue` | 开票 | 财务 | 否 | — | 部分：`admin.invoiceRequest.issue` | V1.0 | `admin.invoiceRequest.issue`、`admin.invoiceRequest.reject`、`admin.invoiceRequest.resend`；处理器内另见 `admin.file.create` | d4 |
| `finance.invoice.red` | 红冲 | 财务 | 否 | — | 要 | V1.0 | `admin.invoiceRequest.issueRed`；处理器内另见 `admin.file.create` | d4 |
| `finance.recon.resolve` | 对账差异处理 | 财务 | 要 | — | 要 | V1.0 | `admin.paymentException.create`、`admin.paymentException.resolve`、`admin.reconciliation.rerun` | d4；A46（数据模型 `reconcile.resolve` 改名） |
| `finance.config.propose` | 提议受控财务配置 | 财务 | 要 | — | 要 | V1.0 | `admin.financeConfigRevision.create` | C66；a07（d2:1446） |
| `finance.config.approve` | 审批受控财务配置 | 财务 | 要（驳回豁免，C86） | — | 部分：`admin.financeConfigRevision.approve` | V1.0 | `admin.financeConfigRevision.approve`、`admin.financeConfigRevision.reject`；处理器内另见 `admin.financeConfigRevision.withdraw` | C66；a07 |
| `billing.month.close` | 月结 | 财务 | 否 | — | — | V1.0 | — | d4（D1） |
| `billing.invariant.resolve` | 处理资金类不变量违规 | 财务 | 否 | — | — | V1.0 | 处理器内：`admin.invariantRun.create`、`admin.invariantViolation.resolve` | d4（D1）；a01 |
| `pii.bank.reveal` | 明文查看银行账号 | 财务 | 否 | — | — | V1.0 | 处理器内：`admin.piiReveal.create` | d4 |

### 1.9 数据报表（1 个）

| 键 | 名称 | 默认授予 | 再验证 | 待分配池 | 二次确认回显 | 起始版本 | 用到的接口 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `report.month_close.reissue` | 月结报表重出 | 财务 | 要 | — | 要 | V1.0 | `admin.reportMonthClose.reissue` | A129；a02 |

### 1.10 运营管理（3 个）

| 键 | 名称 | 默认授予 | 再验证 | 待分配池 | 二次确认回显 | 起始版本 | 用到的接口 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `notify.resend` | 人工重发外部通道投递 | 内容运营、客服 | 否 | — | 否 | V1.0 | `admin.notificationDelivery.resend` | C66；a09（d6:966） |
| `agreement.short_notice` | 协议公告期不足时保存待生效 | 仅超级管理员 | 要 | — | — | V1.0 | 处理器内：`admin.agreementVersion.schedule` | C66；a09（d6:1071） |
| `docs.consent.evidence` | 明文查看同意记录的手机号与信用代码 | 仅超级管理员（法务取证时临时授予） | 要 | — | — | V1.0 | 处理器内：`admin.piiReveal.create` | C66；a09 |

### 1.11 系统设置（19 个）

| 键 | 名称 | 默认授予 | 再验证 | 待分配池 | 二次确认回显 | 起始版本 | 用到的接口 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sys.staff.manage` | 员工新增、编辑、启用、移交、重新生成激活码、解除锁定、设置分配池 | 仅超级管理员 | 否 | — | 否 | V1.0 | `admin.staff.create`、`admin.staff.update`、`admin.staff.enable`、`admin.staff.handover` 等 8 条 | d4；A46 改为不要求再验证 |
| `sys.staff.secure_ops` | 员工禁用、重置密码、重置第二因子 | 仅超级管理员 | 要 | — | 要 | V1.0 | `admin.staff.disable`、`admin.staff.resetMfa`、`admin.staff.resetPassword` | A46、A88（并入原 `sys.staff.mfa_reset`） |
| `sys.staff.wecom_bind` | 员工企业微信绑定 | 仅超级管理员 | 否 | — | 否 | V1.0 | `admin.staff.bindWecom`、`admin.staff.inviteWecom` | d4 |
| `sys.session.revoke` | 在线会话、强制下线 | 仅超级管理员 | 否 | — | 否 | V1.0 | `admin.staffSession.list`、`admin.staffSession.revoke` | d4 |
| `sys.role.edit` | 保存角色权限 | 仅超级管理员 | 要 | — | 否 | V1.0 | `admin.role.replace` | d4 |
| `sys.param.edit` | 系统参数 | 仅超级管理员 | 否 | — | 否 | V1.0 | `admin.calendarDay.batchImport`、`admin.paramValue.replace`、`admin.paramValue.withdraw` | d4 |
| `sys.dict.edit` | 字典 | 仅超级管理员 | 否 | — | 否 | V1.0 | `admin.dictItem.create`、`admin.dictItem.update` | d4 |
| `flow.checklist.manage` | 核对清单模板 | 仅超级管理员 | 否 | — | 否 | V1.0 | `admin.checklistTemplate.create`、`admin.checklistTemplate.activate`、`admin.checklistTemplate.discard`；处理器内另见 `admin.checklistTemplate.list` | d4（a01 写含内容运营，见第 5 节） |
| `audit.export` | 操作日志导出 | 仅超级管理员 | 要 | — | 否 | V1.0 | 处理器内：`admin.exportJob.create`、`admin.exportJob.downloadUrls`（导出键 audit_logs.list） | d4（原型） |
| `sys.super_admin` | 只限超级管理员的操作（开关、部署核对、差异核销、场景总开关、协议升主版本、工作台视角） | 仅超级管理员 | 否 | — | 部分：差异核销 `written_off` 随 `admin.paymentException.resolve` 的回显（a07 3.79） | V1.0 | `admin.debug.clientIp.get`、`admin.featureFlag.list`、`admin.featureFlag.update`、`admin.notifyScene.disable` 等 10 条；处理器内另见 `admin.paymentException.resolve`、`admin.agreement.agreementVersion.create` | A45、A129（不设再验证） |
| `self.mfa.reset` | 本人重新绑定动态口令（自助标记） | 全体员工（标记，不进角色配置） | 要 | — | 否 | V1.0 | `admin.auth.me.enrollTotp`、`admin.auth.me.confirmTotp` | A60、A88、A129 |
| `flow.ops.view` | 流程运维只读列表 | 仅超级管理员 | 否 | — | — | V1.0 | 处理器内：`admin.invariantViolation.list`、`admin.outboxDelivery.list`、`admin.timer.list` 等 4 条 | A129（a01、a02 共用） |
| `flow.ops.manage` | 定时器重排与取消、死信重投、回调重置、手动校验 | 仅超级管理员 | 否 | — | 否 | V1.0 | `admin.invariantRun.create`、`admin.outboxEvent.retry`、`admin.timer.cancel`、`admin.timer.reschedule` 等 6 条；处理器内另见 `admin.invariantViolation.resolve` | C66；a01、a05 |
| `flow.admin.transition` | 人工纠偏（强制迁移） | 仅超级管理员 | 要 | — | 要 | V1.0 | `admin.deliveryTicket.forceTransition`、`admin.serviceTicket.forceTransition` | C66、A129；d3:3498 |
| `sys.health.manage` | 认领、关闭告警；处理非资金类违规 | 财务* | 否 | — | 否 | V1.0 | `admin.alert.acknowledge`、`admin.alert.resolve`；处理器内另见 `admin.invariantViolation.resolve` | A45；a01 |
| `media.job.retry` | 媒体任务人工重试 | 内容运营 | 否 | — | 否 | V1.0 | `admin.mediaJob.retry` | C66；a01 |
| `files.purge.approve` | 放行、驳回文件清除运行 | 仅超级管理员 | 要（驳回豁免，C86） | — | 部分：`admin.purgeRun.approve` | V1.0 | `admin.purgeRun.approve`、`admin.purgeRun.reject` | A45、A149；a01 |
| `files.restore` | 恢复已清除文件 | 仅超级管理员 | 否 | — | 否 | V1.0 | `admin.file.restore` | C66；a01 |
| `files.erase` | 彻底删除文件（个人信息删除请求） | 仅超级管理员 | 要 | — | 要 | V1.0 | `admin.file.erase` | A36；a01 |

### 1.12 各模块导出（9 个）

| 键 | 名称 | 默认授予 | 再验证 | 待分配池 | 二次确认回显 | 起始版本 | 用到的接口 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `order.export` | 订单管理导出 | 有该模块查看权的角色（默认开） | 否 | — | 否 | V1.0 | 处理器内：`admin.exportJob.create`、`admin.exportJob.downloadUrls`（导出键 orders.list、payment_orders.list、subscription_terms.list） | d4（D7 §5.6） |
| `finance.export` | 财务管理导出 | 有该模块查看权的角色（默认开） | 否 | — | 否 | V1.0 | 处理器内：`admin.exportJob.create`、`admin.exportJob.downloadUrls`（导出键 payment_transactions.list、reconciliations.detail） | d4 |
| `merchant.export` | 商家管理导出 | 有该模块查看权的角色（默认开） | 否 | — | 否 | V1.0 | 处理器内：`admin.exportJob.create`、`admin.exportJob.downloadUrls`（导出键 stores.list） | d4 |
| `report.export` | 数据报表导出（D1 `billing.report.export` 并入） | 有该模块查看权的角色（默认开） | 否 | — | 否 | V1.0 | 处理器内：`admin.exportJob.create`、`admin.exportJob.downloadUrls`（导出键 report.overview、report.points（V1.1 另 5 个报表）） | d4 |
| `delivery.export` | 交付管理导出 | 有该模块查看权的角色（默认开） | 否 | — | 否 | V1.0 | 处理器内：`admin.exportJob.create`、`admin.exportJob.downloadUrls`（导出键 delivery_tickets.list） | A88；a02 |
| `service.export` | 客服工单导出 | 有该模块查看权的角色（默认开） | 否 | — | 否 | V1.0 | 处理器内：`admin.exportJob.create`、`admin.exportJob.downloadUrls`（导出键 service_tickets.list） | A88；a02 |
| `drama.export` | 短剧库导出 | 有该模块查看权的角色（默认开） | 否 | — | 否 | V1.0 | 处理器内：`admin.exportJob.create`、`admin.exportJob.downloadUrls`（导出键 dramas.list） | A88；a02、a04 |
| `billing.export` | 套餐与积分导出 | 有该模块查看权的角色（默认开） | 否 | — | 否 | V1.0 | 处理器内：`admin.exportJob.create`、`admin.exportJob.downloadUrls`（导出键 point_accounts.list） | A88；a02 |
| `export.unmasked` | 明文导出（另需原因） | 财务 | 要 | — | 否 | V1.0 | 处理器内：`admin.exportJob.create`、`admin.exportJob.downloadUrls`（任一导出键的 isMasked = false） | d4（D6 §5.4） |

### 1.13 V1.1 的键（7 个，V1.0 不挂载）

| 键 | 名称 | 默认授予 | 再验证 | 待分配池 | 二次确认回显 | 起始版本 | 用到的接口 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `order.price_override.request` | 改价发起 | 见原型 | 待定 | — | — | V1.1 | — | d4 |
| `order.price_override.approve` | 改价审批 | 见原型 | 待定 | — | — | V1.1 | — | d4 |
| `publish.proxy` | 代发布 | 见原型 | 待定 | — | — | V1.1 | — | d4 |
| `partner.*` | 渠道管理（服务商、结算、等级）；届时拆成具体键 | 见原型 | 待定 | — | — | V1.1 | — | d4；a03、a07 路线图 |
| `publish.metrics.enter` | 投放数据录入与审核 | 发布专员 | 待定 | — | — | V1.1 | `admin.metricImport.create`、`admin.metricImport.commit`、`admin.metricSubmission.approve`、`admin.metricSubmission.reject` | A129；a06 |
| `service.quick_reply.manage` | 快捷回复维护 | 客服* | 待定 | — | — | V1.1 | — | a08 |
| `channel.export` | 渠道管理导出 | 有该模块查看权的角色（默认开） | 待定 | — | — | V1.1 | 处理器内：`admin.exportJob.create`、`admin.exportJob.downloadUrls`（导出键 partners.list、commission_statements.list（V1.1）） | a02 |

d4 已作废、本表不列的：`sys.staff.mfa_reset`（并入 `sys.staff.secure_ops`，A88、A129），以及 d4 7.1 “来源与作废的旧名”一列里的全部旧名。

## 2. 商家端能力点（39 个）

能力点只回答“这个角色在这种门店状态下能不能做这类事”；门店是否认证、套餐是否生效等业务状态由各业务服务判断（d4 5.2）。`me.*`、`cart.*`、`invoice.*`、`ticket.*` 是**单个组键**，不是通配符（A128）。店员列为“✘”的路由 `clerkView = none`，直接 403 `ROLE_FORBIDDEN`。

| 键 | 含义 | 老板 | 店员 | 已停用门店的老板 | 用到的接口 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| `catalog.read` | 浏览短剧商城 | ✔ | ✔（游客视图） | ✔ | `m.drama.list`、`m.drama.search`、`m.drama.get`、`m.drama.trialEpisode.list` | d4 |
| `store.profile.read` | 看门店档案 | ✔ | ✔（裁剪） | ✔ | `m.storeProfile.get`、`m.storeProfile.basic.get`、`m.storeProfile.media.get`、`m.storeProfile.qualification.get` 等 5 条 | d4 |
| `store.profile.edit` | 改门店档案 | ✔ | ✘ | ✘ | `m.storeProfile.basic.update`、`m.storeProfile.media.update`、`m.storeProfile.service.update` | d4 |
| `store.qualification.edit` | 提交、修改资质 | ✔ | ✘ | ✘ | `m.qualificationDoc.create`、`m.qualificationDoc.update`、`m.qualificationDoc.downloadUrls`、`m.qualificationDoc.remove` 等 10 条 | d4 |
| `store.create` | 新建门店 | ✔ | ✘ | ✘ | `m.store.create` | d4 |
| `store.archive` | 停用门店 | ✔ | ✘ | ✘ | `m.store.archive`、`m.store.delete` | d4 |
| `store.restore` | 恢复门店 | ✔ | ✘ | ✔ | `m.store.restore` | d4 |
| `asset.read` | 看本店素材 | ✔ | ✔ | ✔ | `m.storeAsset.list`、`m.storeAsset.summary`、`m.storeAsset.get` | d4 |
| `asset.demand.read` | 看素材需求 | ✔ | ✔ | ✔ | `m.assetDemand.list` | d4 |
| `asset.upload` | 上传素材 | ✔ | ✔ | ✘ | `m.storeAsset.create`、`m.storeAsset.portraitAuth.create` | d4（另受门店审核状态门控） |
| `asset.feedback` | 素材反馈 | ✔ | ✔ | ✘ | `m.storeAsset.feedback.create` | A87；m03 |
| `member.list` | 看成员列表 | ✔ | ✔（裁剪） | ✘ | `m.member.list` | d4 |
| `member.manage` | 邀请、调整、移除、撤回成员 | ✔ | ✘ | ✘ | `m.invitation.create`、`m.invitation.markShared`、`m.invitation.revoke`、`m.member.update` 等 5 条 | d4 |
| `cart.*` | 购物车（组键） | ✔ | ✘ | ✘ | `m.cartItem.list`、`m.cartItem.create`、`m.cartItem.delete`、`m.cartItem.acceptPrice` | d4；A128 |
| `order.create` | 下订购单 | ✔ | ✘ | ✘ | `m.order.create`、`m.order.quote` | d4 |
| `order.read` | 看订购单 | ✔ | ✘ | ✔ | `m.orderItem.list`、`m.orderItem.summary`、`m.orderItem.get`、`m.order.list` 等 6 条 | d4 |
| `plan.purchase` | 购买与续费套餐 | ✔ | ✘ | ✔（主体级） | `m.paymentOrder.create`、`m.paymentOrder.get`、`m.paymentOrder.cancel`、`m.paymentOrder.sync` 等 9 条 | d4 |
| `points.topup` | 加购积分 | ✔ | ✘ | ✔（主体级） | `m.pointPack.list` | d4 |
| `wallet.read` | 看积分账户 | ✔ | ✘ | ✔（主体级） | `m.wallet.get` | d4 |
| `ledger.read` | 看积分明细 | ✔ | ✘ | ✔（主体级） | `m.pointLedgerEntry.list` | d4 |
| `delivery.confirm_plan` | 确认方案 | ✔ | ✘ | ✘ | `m.deliveryPlan.confirm`、`m.deliveryPlan.requestChange` | d4（V1.1 可委托） |
| `delivery.confirm_sample` | 确认样片 | ✔ | ✘ | ✘ | `m.orderItem.sample.get`、`m.sample.confirm`、`m.sample.downloadUrls`、`m.sample.requestChange`；处理器内另见 `m.playable.get` | d4（V1.1 可委托） |
| `ad.request` | 申请广告、提修改 | ✔ | ✘ | ✘ | `m.ad.list`、`m.ad.create`、`m.ad.quote`、`m.ad.get` 等 6 条；处理器内另见 `m.playable.get` | d4（V1.1 可委托） |
| `ad.confirm` | 确认广告版本 | ✔ | ✘ | ✘ | `m.ad.confirm`、`m.ad.requestChange` | d4（V1.1 可委托） |
| `channel.manage` | 管理渠道账号 | ✔ | ✘ | ✘ | `m.channelAccount.list`、`m.channelAccount.create`、`m.channelAccount.submit`、`m.channelAccount.unbind` | d4 |
| `publish.submit_link` | 提交上线链接 | ✔ | ✘ | ✘ | `m.launchTask.submit` | d4 |
| `publish.read` | 看发布任务 | ✔ | ✘ | ✔ | `m.launchTask.list`、`m.launchTask.summary`、`m.launchTask.get`、`m.orderItem.publishList.get` 等 6 条 | d4 |
| `publish.takedown_confirm` | 确认到期下架 | ✔ | ✘ | ✔ | `m.takedownTask.confirm` | d4 |
| `delivery.download` | 下载成片（小程序与下载页） | ✔ | ✘ | ✔ | `m.download.report`、`m.orderItem.downloadGrant.create`、`m.orderItem.downloadUrls`、`m.orderItem.release.get` 等 8 条 | d4 |
| `portal.authorize` | 授权电脑下载页 | ✔ | ✘ | ✔ | `m.portalSession.list`、`m.portalSession.revoke`、`m.portalTicket.lookup`、`m.portalTicket.approve` 等 5 条 | d4 |
| `contract.read` | 合同页数据、协议同意计数 | ✔ | ✘ | ✔（主体级） | `m.agreementConsent.summary`、`m.licenseLetter.list`、`m.licenseLetter.summary`、`m.licenseLetter.get` 等 5 条 | d4；A53 |
| `invoice.*` | 开票申请（组键） | ✔ | ✘ | ✔（主体级） | `m.invoiceRequest.list`、`m.invoiceRequest.create`、`m.invoiceRequest.summary`、`m.invoiceRequest.downloadUrls` 等 6 条 | d4；A128 |
| `ticket.*` | 客服工单（组键） | ✔ | ✘ | ✔ | `m.serviceTicket.list`、`m.serviceTicket.create`、`m.serviceTicket.get`、`m.serviceTicket.confirm` 等 8 条 | d4（店员默认不能，d4 §12）；A128 |
| `message.read` | 站内消息（门店上下文） | ✔ | ✔（仅“门店”类） | ✔ | 处理器内：`m.message.list` | d4；A139（处理器内判定） |
| `me.*` | 本人资料、账号与安全、退出、注销、退出门店（组键） | ✔ | ✔ | ✔ | `m.me.update`、`m.me.changePhone`、`m.me.deletion.create`、`m.me.userNotice.acknowledge` 等 10 条 | d4；A128 |
| `todo.read` | 首页待办 | ✔ | ✔（仅素材相关） | ✔ | `m.todo.list` | A87；m04 |
| `support.manager.read` | 服务经理名片 | ✔ | ✔ | ✔ | `m.serviceManager.get` | A87、A128；m08 |
| `sample.view` | 下载页预览样片 | ✔ | ✘ | ✔ | `portal.orderItem.sample.get`、`portal.sample.playbackUrls` | A65、A87；p01（仅下载页会话） |
| `ad.view` | 下载页预览广告 | ✔ | ✘ | ✔ | `portal.ad.list`、`portal.ad.get`、`portal.ad.playbackUrls` | A65、A87；p01（仅下载页会话） |

下载页（`portal`）会话代表授权它的老板：`delivery.download`、`sample.view`、`ad.view` 在下载页按老板判定（C5）。

## 3. 处理器内判定（`assert-in-handler`）

路由声明 `assert-in-handler`，处理器取到对象或读到请求体后再判。契约自测允许这个值，但要求接口文档写出判定规则（C66）。另有“路由声明固定键、处理器再追加键”的写法（如资质审核 `mode = override` 另要 `merchant.qualification.override`，退款申请 `ruleCode = override` 另要 `refund.override.request`），不在下表。

### 3.1 后台（56 条）

| operationId | 文档 | 判定 |
| --- | --- | --- |
| `admin.alert.list` | a01-system | system ≥ v，或财务模块 ≥ v 且是主管（只读） |
| `admin.approval.list` | a01-system | 按审批类型的查看等级 + 数据范围过滤；`channel_account` 持 `publish.account.verify` 看全部 |
| `admin.approval.summary` | a01-system | 同 `admin.approval.list` |
| `admin.approval.get` | a01-system | 同 `admin.approval.list`；无权 404 |
| `admin.assignmentPoolMember.list` | a01-system | system ≥ v 看全部池；否则只看有读权的池（客服主管看客服池） |
| `admin.auditLog.list` | a01-system | `stream = ops` 要 system ≥ v；`stream = access` 只给超级管理员 |
| `admin.auditLog.get` | a01-system | 按该行 `stream`，同上；无权 404 |
| `admin.checklistTemplate.list` | a01-system | 已登录读启用版本；草稿与历史版本要 `flow.checklist.manage` |
| `admin.dictItem.list` | a01-system | 已登录读启用项；引用计数与停用项要 system ≥ v |
| `admin.file.create` | a01-system | 按文件分类（a01 2.17 矩阵）：如证照代传 `merchant.profile.proxy_edit`，发票 `finance.invoice.issue` / `.red`，发布截图 `publish.takedown.check` / `publish.patrol.do` / `publish.link.verify`，工单附件 `service.ticket.reply`，预告片源 `drama.media.manage` |
| `admin.file.get` | a01-system | 上传人本人，或对该分类有签发读权 |
| `admin.file.complete` | a01-system | 上传人本人 |
| `admin.file.downloadUrls` | a01-system | 按文件分类（a01 2.17“后台签发”栏）+ 数据范围；成片对 `delivery.download`；`consent_digest` 对 `docs.consent.evidence` |
| `admin.file.refreshCredentials` | a01-system | 上传人本人 |
| `admin.invariantViolation.list` | a01-system | system ≥ v，或 `flow.ops.view`，或财务主管只读 |
| `admin.invariantViolation.resolve` | a01-system | 资金类要 `billing.invariant.resolve`；其余要 `flow.ops.manage` 或 `sys.health.manage` |
| `admin.outboxDelivery.list` | a01-system | system ≥ v 或 `flow.ops.view` |
| `admin.piiReveal.create` | a01-system | 按字段：`pii.phone.reveal`、`pii.license.view`（或 `merchant.qualification.review`）、`pii.bank.reveal`、`docs.consent.evidence`（要再验证）；限流 `admin.pii_reveal` |
| `admin.staff.list` | a01-system | system ≥ v 看完整列表；选人模式按池的读权（交付经理池对 `service.ticket.assign` / `.transfer` 只读开放） |
| `admin.staff.duty.update` | a01-system | 客服本人，或持 `service.ticket.assign` 的主管 |
| `admin.timer.list` | a01-system | system ≥ v 或 `flow.ops.view` |
| `admin.webhookEvent.list` | a01-system | system ≥ v 或 `flow.ops.view` |
| `admin.file.cancel` | a01-system | 上传人本人，否则 404 |
| `admin.exportJob.create` | a02-workbench-report | 按 `exportKey` 登记表：该模块 ≥ v 且持 `<模块>.export`；明文另要 `export.unmasked`（要再验证）；`audit_logs.list` 要 `audit.export`（要再验证） |
| `admin.exportJob.downloadUrls` | a02-workbench-report | 申请人本人，且仍持对应导出权限点（明文另要 `export.unmasked`） |
| `admin.accountChangeRequest.withdraw` | a03-merchant | 提交人本人；发起人已停用时由 `merchant.account_change.approve` 持有人代撤（要再验证） |
| `admin.assignmentHistory.markContacted` | a03-merchant | 该行接收人本人或其主管 |
| `admin.followUp.list` | a03-merchant | 按对象所在模块查看（a03 3.41 对照表） |
| `admin.followUp.create` | a03-merchant | 对象所在模块 ≥ v 且对象在数据范围内 |
| `admin.followUp.summary` | a03-merchant | 同 `admin.followUp.list`（V1.1） |
| `admin.followUp.update` | a03-merchant | 负责人本人、其主管或数据范围为全部 |
| `admin.followUp.complete` | a03-merchant | 负责人本人、其主管或数据范围为全部 |
| `admin.uploadBatchItem.update` | a04-content | 同上 |
| `admin.uploadBatchItem.complete` | a04-content | 同上 |
| `admin.uploadBatch.create` | a04-content | 按用途：原片 `drama.media.manage`；成片 `delivery.episode.register` + 任务归属 |
| `admin.uploadBatch.get` | a04-content | 批次持有人，或持该用途权限点的员工；否则 404 |
| `admin.uploadBatch.cancel` | a04-content | 只限批次持有人（否则 404）；持有人已无该用途权限 403 |
| `admin.uploadBatch.start` | a04-content | 同上 |
| `admin.uploadBatch.refreshCredentials` | a04-content | 同上 |
| `admin.ad.remind` | a05-order-delivery | 广告在数据范围内，且是该广告剪辑师、门店交付经理或交付模块主管 |
| `admin.cancelRequest.withdraw` | a05-order-delivery | 提交人本人；发起人已停用或对象失效时由 `finance.refund.approve` 持有人代撤（要再验证） |
| `admin.deliveryTicket.remind` | a05-order-delivery | 工单在数据范围内，且是本单交付经理、发布专员（`golive`）或交付模块主管 |
| `admin.financeConfigRevision.withdraw` | a07-billing-finance | 提议人本人；代撤要 `finance.config.approve`（要再验证） |
| `admin.plan.quote` | a07-billing-finance | billing 或 order 任一 ≥ v；带 `pointAccountId` 时套数据范围 |
| `admin.pointAdjustmentRequest.get` | a07-billing-finance | billing 或 finance 任一 ≥ v + 数据范围（发起人总能看） |
| `admin.pointAdjustmentRequest.withdraw` | a07-billing-finance | 提交人本人；代撤要 `billing.adjust.approve`（要再验证） |
| `admin.pricingChange.create` | a07-billing-finance | 按变更内容：模板价要 `billing.price.edit`，计费参数要 `billing.param.edit` |
| `admin.refundRequest.get` | a07-billing-finance | finance 或 order 任一 ≥ v + 数据范围（发起人总能看） |
| `admin.refundRequest.withdraw` | a07-billing-finance | 申请人本人；代撤要 `finance.refund.approve`（要再验证） |
| `admin.termExtensionRequest.get` | a07-billing-finance | order 或 billing 任一 ≥ v + 数据范围（发起人总能看） |
| `admin.termExtensionRequest.withdraw` | a07-billing-finance | 提交人本人；代撤要 `billing.extension.approve` |
| `admin.transferProof.get` | a07-billing-finance | order 或 finance 任一 ≥ v |
| `admin.agreementVersion.schedule` | a09-ops | ops = e；会员协议、积分规则公告期不足另要 `agreement.short_notice` |
| `admin.agreement.agreementVersion.create` | a09-ops | ops = e；`bumpMajor = true` 另要 `sys.super_admin` |
| `admin.notificationDelivery.list` | a09-ops | ops 或 service 任一 ≥ v |
| `admin.siteNotice.list` | a09-ops | ops 或 billing 任一 ≥ v |

### 3.2 商家端（6 条）

| operationId | 文档 | 判定 |
| --- | --- | --- |
| `m.playable.get` | m06-ad | 按资产种类：预告片匿名可看；广告要 `ad.request`、样片要 `delivery.confirm_sample`（仅老板，版本已推送且查看方式含 weapp）；匿名 401、非成员 403 `NOT_A_MEMBER`、店员 403 `ROLE_FORBIDDEN`（A87） |
| `m.file.create` | m08-support-misc | 按上传分类判权（A139；m08 3.21 分类表）：档案图片与视频 `store.profile.edit`；证照 `store.qualification.edit`；素材与肖像授权 `asset.upload`（店员可）；渠道截图 `channel.manage`；工单附件 `ticket.*`、`delivery.confirm_sample`、`ad.confirm` 任一；对公回单 `plan.purchase` 或 `points.topup` |
| `m.message.list` | m08-support-misc | 带 `X-Store-Id` 时校验成员关系与 `message.read`；不带只看账号级消息（A139） |
| `m.message.batchRead` | m08-support-misc | 同 `m.message.list` |
| `m.message.summary` | m08-support-misc | 同 `m.message.list` |
| `m.message.read` | m08-support-misc | 同 `m.message.list` |

## 4. 驳回豁免再验证的接口（约定 C86 登记表，原样引用）

| operationId | 路径 | 决定权限点 | 注册表标了再验证 | 文档 |
| --- | --- | --- | --- | --- |
| `admin.accountChangeRequest.reject` | `POST /admin/account-change-requests/{accountChangeRequestId}/reject` | `merchant.account_change.approve` | 是 | a03 3.21 |
| `admin.cancelRequest.reject` | `POST /admin/cancel-requests/{cancelRequestId}/reject` | `finance.refund.approve` | 是 | a05 3.12 |
| `admin.refundRequest.reject` | `POST /admin/refund-requests/{refundRequestId}/reject` | `finance.refund.approve` | 是 | a07 3.60（A127 列在 a05 名下，路线图与接口文档都在 a07） |
| `admin.pointAdjustmentRequest.reject` | `POST /admin/point-adjustment-requests/{pointAdjustmentRequestId}/reject` | `billing.adjust.approve` | 是 | a07 3.28 |
| `admin.termExtensionRequest.reject` | `POST /admin/term-extension-requests/{termExtensionRequestId}/reject` | `billing.extension.approve` | 否（登记后行为不变，防日后改标） | a07 3.38 |
| `admin.financeConfigRevision.reject` | `POST /admin/finance-config-revisions/{financeConfigRevisionId}/reject` | `finance.config.approve`（增补） | 是（增补表建议） | a07 3.83 |
| `admin.transferProof.rejectReview` | `POST /admin/transfer-proofs/{transferProofId}/reject-review` | `finance.receipt.confirm` | 是 | a07 3.51 |
| `admin.purgeRun.reject` | `POST /admin/purge-runs/{purgeRunId}/reject` | `files.purge.approve` | 是（增补表建议） | a01（清除运行的驳回，A149） |

不登记的：`admin.transferProof.reject`（`finance.receipt.reject` 本身不要求再验证，也不是审批决定）；`admin.qualificationSubmission.reject`、`admin.channelAccountSubmission.reject`、`admin.launchSubmission.reject`（权限点在注册表里没有标再验证，无需豁免）；`admin.purgeRun.reject` 已按 A149 登记（不是审批单，但同属“决定类权限点”的驳回）。

## 5. 不一致与待定（12 条）

- 路线图引用了、本表没有的键：0 个。

| # | 类别 | 键 | 情况 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | 注册表有、没有接口用 | `billing.month.close` | d4 财务行登记了“月结”，路线图没有接口用它；月结由定时任务做，重出用 `report.month_close.reissue`（a02） | 从注册表删去，或并入 `report.month_close.reissue`；d4 不回改（A129），在本表标“作废”即可 |
| 2 | 默认授予不一 | `flow.checklist.manage` | d4：仅超级管理员；a01 1.1：超级管理员、内容运营 | 取 d4（仅超级管理员）；若要内容运营维护清单，由业务拍板后改本表 |
| 3 | 默认授予不一 | `order.refund.request` | d4：客服；D3 草案允许交付经理发起广告取消（a05 第 6 节第 9 项） | 维持客服；交付经理要发起广告取消时由业务拍板，再给交付经理默认开 |
| 4 | 默认授予不一 | `delivery.ticket.rework` | d4 只写“见 D3 附录 A”，D3 附录 A 没有默认值；a05 写交付经理（仅主管） | 取 a05：交付经理* |
| 5 | 默认授予不一 | `delivery.ticket.assign_publisher` | d4 写“交付经理、发布专员*”；a05 写“交付经理、发布专员（仅主管）”，“仅主管”是否也限交付经理有歧义 | 定为：交付经理不限主管，发布专员仅主管（同 d4 写法）；a05 1.2 措辞按此改 |
| 6 | 待拍板 | `merchant.qualification.review` | d4 默认客服，注明“PRD 未指明岗位，待拍板” | 先按客服落库，业务拍板后只改本表默认值 |
| 7 | 待拍板 | `order.payment.create_offline` | d4 默认财务，注明“默认值由 D2 确认”；D2 未见明确结论 | 先按财务落库，待财务确认 |
| 8 | 回显说法不一 | `drama.copyright.revise` | a04 2.1 写本文权限点（含 `billing.price.edit`）“都不要求二次确认回显”；但 a04 的版权期限修订（`confirm.prevEndDate`）与单剧调价（`confirm.currentPoints`）都要求 `confirm` | 以接口为准（要回显）；改 a04 2.1 的说法 |
| 9 | 规则例外 | `flow.ops.view` | 查看类键，与“查看类不设权限点”（d4 7.1 第 2 条）相抵；A129 已采纳 | 保留为登记的例外：只在处理器内与模块等级“或”判定；不再新增同类键 |
| 10 | 命名 | `refund.override.request` | 领域段 `refund` 不是服务模块名（d4 7.1 第 1 条要求取拥有该动作的服务模块） | 建议改名 `order.refund.override_request`（与 `order.refund.request` 同组）；改名前不阻塞 |
| 11 | d3 旧键未登记 | `delivery.sample.download_watermarked` | d3 附录 A 列了“下载水印版（用于企业微信发送）”，d4 与路线图都没有；水印版签发现走样片推送与 `admin.file.downloadUrls` | 不登记；在 d3 待回写清单里注明由 `delivery.sample.push` / `delivery.download` 覆盖 |
| 12 | 能力点待定 | （V1.1 占位） | 商家端 V1.1 占位接口没有能力点：`m.delegation.create`、`m.cancelRequest.create`、`m.favorite.create`、`m.favorite.delete`、`m.performanceReport.list`、`m.performanceUpload.create`、`m.faq.list`、`m.siteNotice.list` | V1.1 设计时补键；V1.0 不挂载，不阻塞 |

只在处理器内用到、路由字段不直接引用的键（20 个，属正常，不计入上表）：`merchant.qualification.override`、`pii.phone.reveal`、`pii.license.view`、`refund.override.request`、`billing.invariant.resolve`、`pii.bank.reveal`、`agreement.short_notice`、`docs.consent.evidence`、`audit.export`、`flow.ops.view`、`order.export`、`finance.export`、`merchant.export`、`report.export`、`delivery.export`、`service.export`、`drama.export`、`billing.export`、`export.unmasked`、`message.read`。契约测试按 C66 核对它们出现在处理器判定规则里。

## 6. 修订记录

| 日期 | 内容 |
| --- | --- |
| 2026-10-03 | 初稿：后台权限点 118 个（V1.0 111、V1.1 7），能力点 39 个；由 d4 7.1、5.2 与各文档增补汇总 |
