# W5-16：M6 工作包唯一映射

| 项 | 内容 |
| --- | --- |
| 改了什么 | 将08第7.5节G6-A七包、G6-B五包、合流与后继拆包各一包固定为W6-01–14；逐项分配55条冻结API资源、12新页、9项x01和8桩，新增实现数为0。 |
| 原因 | W5-15功能验收已actual main；后继分书须使用唯一owner、具体DAG和真实外验边界，并显式承接Q9两条电脑样片接口与现有冻结统计的差额。 |
| 影响的包 | W6-01–14任务书、未开工状态、共享面与08第1/7.5节的具体数量；不改变M6进入/退出、Q9决定、权限/路径/版本、E/V最晚点或已有W7-01–08。 |
| 类别 | 拆并（约14→14）；按实际并发/上传与平台风险校正规模：后端L6/M1、页面L3/M2、合流L/乙、后继M/丙，甲机制仍独立、乙≤20API、丙≤8新旧页。 |
| PR | #258 |

后续正式口径：[W6-06 Q9治理](W6-06-q9-route-governance.md)撤销两条未实现的电脑样片接口当前登记。下文55条为W5-16原分配历史集合；现行M6实施53条，W6-06实施10条加2项历史处置，其余包及12页/9项x01/8桩不变。撤销不算实现，不移至V1.1。

## 1. 基线、计数与进入边界

开工基线actual main `ce779f3985f36482e73676f46e5230a41e22e0ac`，功能#245/#246及固定main十轮、双demo验收见W5-15状态。按W5-15第3节与W5-16第3节的代码前置裁定，本包可先开展纯文档拆分；旧状态误以900秒效率门槛阻塞的解释由#254更正。开工时未合的#254/#255代码不作为依赖；合流前只同步已经实际合入的main。

本轮依据actual routes.json、pages.md、x01-map.md和stubs逐项分配，不手改冻结源、不提前闭桩。55是当前冻结归属资源数，不代表55条业务API都应实现：`portal.orderItem.sample.get`与`portal.sample.playbackUrls`按Q9第一期明确不实现，W6-06唯一负责先交独立plan-change/冻结治理前置；其actual后按正式集合验收。在差额未正式消解前，W6-13不得宣告零pending或M6退出，也不得新增恒拒绝handler充数。

W5-16完成仅代表任务书交付。2026-11-03业主随后明确要求开展M6，按[先行编码授权](../m6-start-authorization.md)与08第6.9节推进已有实际main依赖的代码包；M5演示尚未获确认，各书仍核具体代码依赖与外验条件。没有打m5-done或据此关闭真实云/提审/部署验收。

| 组 | 包数 | API资源 | 新页 | x01 | 桩唯一接收 |
| --- | ---: | ---: | ---: | ---: | ---: |
| G6-A / W6-01–07 | 7 | 55 | 0 | 9 | 4 |
| G6-B / W6-08–12 | 5 | 0 | 12 | 0 | 4 |
| 合流与后继 / W6-13–14 | 2 | 0 | 0 | 0 | 0 |
| 合计 | 14 | 55 | 12 | 9 | 8 |

## 2. 十四包、具体依赖与规模

| 编号 | 组 | 标题 | 级别/规模 | 具体代码依赖（actual main） | API/新页/x01/桩 | 验收概要 |
| --- | --- | --- | --- | --- | --- | --- |
| W6-01 | G6-A | 使用期重算、顺延与到期一致性 | 甲/L | W1-16a、W1-17、W2-17、W5-03、W5-06、W5-07 | 0/0/3/0 | 唯一使用期事实与到期联动；时钟性质、并发重放、止日不缩短、定时器前缀取消重登；先交publish.ensureTakedownTasks等到期公口供04消费，不重复writer。 |
| W6-02 | G6-A | 发布清单与上线工作台 | 乙/L | W6-01、W6-05、W1-16a、W1-16b、W5-04 | 9/0/0/2 | 9 API；逐集清单版本/替换原子性、发布文本同步、分批回填/部分上线、撤销核验清理；portal处理器消费05实际鉴权。 |
| W6-03 | G6-A | 巡检与账号健康 | 乙/L | W6-01、W1-15、W2-03、W2-10、W2-17 | 12/0/2/0 | 12 API；周批次幂等、异常跟进取消/重放、账号解绑审批收尾、真实提醒/告警。 |
| W6-04 | G6-A | 下架确认、核查与归档闭环 | 乙/L | W6-01、W6-02、W6-03、W2-17、W5-03 | 11/0/3/0 | 11 API；T-30唯一任务、逾期取消与升级、日历重算check_due_at、全部确认后归档；消费01唯一ensureTakedownTasks。 |
| W6-05 | G6-A | 一次性 portal 票据与只读会话 | 甲/L | W1-01a、W1-04、W2-10、W1-16b | 10/0/0/0 | 10 API；票据并发确认只成功一次、重放无第二会话、只读白名单、老板/门店scope、吊销与Cookie/CSRF；真实扫码形态按V8原开工点。 |
| W6-06 | G6-A | 门户只读投影、逐集下载与访问证据 | 乙/L | W6-01、W6-02、W6-05、W6-07、W1-16b、W3-01、W5-07、W5-08 | 12/0/0/1 | 12冻结资源唯一接收，其中2条portal样片接口按Q9当前不实现。先交独立plan-change/冻结治理前置，actual后按正式集合验收；不以恒拒绝handler充落地。其余逐次签发access、saved幂等、GET零写、广告只读与验真；未消解2项差额时13不得宣告零pending。 |
| W6-07 | G6-A | 成片 ZIP 制作与缓存生命周期 | 乙/M | W6-01、W6-02、W6-04、W3-01、W3-03、W1-16a | 1/0/1/1 | 1 API/1 queue；复用现有队列和存储，完整manifest、代次fencing、可恢复重试及无效缓存拒签；V10原M6退出点。复合桩由本包在01/04/07全部actual验收后唯一关闭。 |
| W6-08 | G6-B | 后台上线日历、逾期与发布清单工作台 | 丙/M | W5-16、W6-02、W6-03、W6-07、W5-13、W2-02 | 0/2/0/1 | 2新页+2旧页；发布清单编辑/全账号改选/pack与撤销核验真实写读，4页唯一owner。 |
| W6-09 | G6-B | 后台巡检、下架与两端发布生命周期页面 | 丙/L | W5-16、W6-02、W6-03、W6-04、W1-20、W1-18、W2-02 | 0/2/0/1 | 2新页+4旧页；巡检、账号异常/解绑、下架确认核查及发布清单/巡检记录真实衔接。 |
| W6-10 | G6-B | 电脑扫码登录、会话边界与小程序授权 | 丙/L | W5-16、W6-05、W2-13、W0-28、X-01；PR1仅核前四包actual及安全壳拆分文档实合；PR2另等X-01 actual、V8与原E条件 | 0/4/0/0 | 4新页+1旧页；PR1只读安全壳及真实HTTPS Cookie隔离验收；PR2真实票据授权/换会话/吊销页面，V8真实形态开工门槛不变。 |
| W6-11 | G6-B | 电脑成片下载与小程序逐集保存完整版 | 丙/L | W5-16、W6-02、W6-06、W6-07、W6-10、W6-12、W1-20、X-01；电脑PR1仅等10.PR1安全壳完整验收实合及其余非X-01代码前置；小程序PR2仍等原全部前置与V7/E条件 | 0/2/0/1 | 2新页+1旧页；订购/待确认广告分区与预览跳转、真实ZIP/逐集签发及访问记录、小程序队列/回报/恢复，V7先行。 |
| W6-12 | G6-B | 电脑广告只读预览、授权验真与Q9边界 | 丙/M | W5-16、W6-06、W6-10、W5-07、W5-09；W6-10仅等PR1安全壳完整验收实合，其余依赖仍全部actual | 0/2/0/1 | 2新页；广告只读真实签发留痕、公开脱敏验真；Q9两sample不实现，先正式冻结治理，差额未消解不清零。 |
| W6-13 | M6合流 | M6合流、预发真机闭环与退出核对 | 乙/L | W5-15、W6-01、W6-02、W6-03、W6-04、W6-05、W6-06、W6-07、W6-08、W6-09、W6-10、W6-11、W6-12 | 0/0/0/0 | 只交集成脚本/证据，55当前API资源按53普通实现+2Q9冲突正式处置对账；外验/真机与原时限不放宽。 |
| W6-14 | M7拆包 | 拆分G7-B、M7合流与交M8任务书 | 丙/M | W6-13、W2-31 | 0/0/0/0 | 只交后继文书；保留W7-01–08，拆G7-B八包与M7合流/交M8，原M8/G2-E与月结时点不改。 |

## 3. 当前55条API资源唯一归属

下表方法、路径和来源直接核对actual登记；消费者只引用，不重复拥有。Q9两项仅分配正式处置责任，不在本纯文档包修改归属或声明落地。

| operationId | 方法 | 路径 | 原文档 | 唯一owner |
| --- | --- | --- | --- | --- |
| `admin.deliveryTicket.publishList.get` | GET | `/admin/delivery-tickets/{deliveryTicketId}/publish-list` | a06-publish | W6-02 |
| `admin.deliveryTicket.publishList.import` | POST | `/admin/delivery-tickets/{deliveryTicketId}/publish-list/import` | a06-publish | W6-02 |
| `admin.deliveryTicket.publishList.replace` | PUT | `/admin/delivery-tickets/{deliveryTicketId}/publish-list` | a06-publish | W6-02 |
| `m.orderItem.publishList.get` | GET | `/m/order-items/{orderItemId}/publish-list` | m05-delivery-publish | W6-02 |
| `portal.orderItem.publishList.get` | GET | `/portal/order-items/{orderItemId}/publish-list` | p01-portal | W6-02 |
| `admin.launchCalendar.get` | GET | `/admin/launch-calendar` | a06-publish | W6-02 |
| `admin.launchSubmission.revoke` | POST | `/admin/launch-submissions/{launchSubmissionId}/revoke` | a06-publish | W6-02 |
| `admin.launchTask.list` | GET | `/admin/launch-tasks` | a06-publish | W6-02 |
| `admin.launchTask.summary` | GET | `/admin/launch-tasks/summary` | a06-publish | W6-02 |
| `admin.patrolTask.create` | POST | `/admin/patrol-tasks` | a06-publish | W6-03 |
| `admin.patrolTask.get` | GET | `/admin/patrol-tasks/{patrolTaskId}` | a06-publish | W6-03 |
| `admin.patrolTask.list` | GET | `/admin/patrol-tasks` | a06-publish | W6-03 |
| `admin.patrolTask.markAbnormal` | POST | `/admin/patrol-tasks/{patrolTaskId}/mark-abnormal` | a06-publish | W6-03 |
| `admin.patrolTask.markNormal` | POST | `/admin/patrol-tasks/{patrolTaskId}/mark-normal` | a06-publish | W6-03 |
| `admin.patrolTask.recover` | POST | `/admin/patrol-tasks/{patrolTaskId}/recover` | a06-publish | W6-03 |
| `admin.patrolTask.remind` | POST | `/admin/patrol-tasks/{patrolTaskId}/remind` | a06-publish | W6-03 |
| `admin.patrolTask.summary` | GET | `/admin/patrol-tasks/summary` | a06-publish | W6-03 |
| `admin.channelAccount.list` | GET | `/admin/channel-accounts` | a06-publish | W6-03 |
| `admin.channelAccount.markAbnormal` | POST | `/admin/channel-accounts/{channelAccountId}/mark-abnormal` | a06-publish | W6-03 |
| `admin.channelAccount.summary` | GET | `/admin/channel-accounts/summary` | a06-publish | W6-03 |
| `m.channelAccount.unbind` | POST | `/m/channel-accounts/{channelAccountId}/unbind` | m05-delivery-publish | W6-03 |
| `m.takedownTask.list` | GET | `/m/takedown-tasks` | m05-delivery-publish | W6-04 |
| `m.takedownTask.summary` | GET | `/m/takedown-tasks/summary` | m05-delivery-publish | W6-04 |
| `m.takedownTask.confirm` | POST | `/m/takedown-tasks/{takedownTaskId}/confirm` | m05-delivery-publish | W6-04 |
| `admin.takedownTask.list` | GET | `/admin/takedown-tasks` | a06-publish | W6-04 |
| `admin.takedownTask.summary` | GET | `/admin/takedown-tasks/summary` | a06-publish | W6-04 |
| `admin.takedownTask.get` | GET | `/admin/takedown-tasks/{takedownTaskId}` | a06-publish | W6-04 |
| `admin.takedownTask.check` | POST | `/admin/takedown-tasks/{takedownTaskId}/check` | a06-publish | W6-04 |
| `admin.takedownTask.batchCheck` | POST | `/admin/takedown-tasks/check` | a06-publish | W6-04 |
| `admin.takedownTask.markOnline` | POST | `/admin/takedown-tasks/{takedownTaskId}/mark-online` | a06-publish | W6-04 |
| `admin.takedownTask.sendBreachNotice` | POST | `/admin/takedown-tasks/{takedownTaskId}/send-breach-notice` | a06-publish | W6-04 |
| `admin.takedownTask.escalate` | POST | `/admin/takedown-tasks/{takedownTaskId}/escalate` | a06-publish | W6-04 |
| `m.portalTicket.lookup` | GET | `/m/portal-tickets/lookup` | m02-tenant | W6-05 |
| `m.portalTicket.approve` | POST | `/m/portal-tickets/{portalTicketId}/approve` | m02-tenant | W6-05 |
| `m.portalTicket.reject` | POST | `/m/portal-tickets/{portalTicketId}/reject` | m02-tenant | W6-05 |
| `m.portalSession.list` | GET | `/m/portal-sessions` | m02-tenant | W6-05 |
| `m.portalSession.revoke` | POST | `/m/portal-sessions/{portalSessionId}/revoke` | m02-tenant | W6-05 |
| `portal.portalTicket.create` | POST | `/portal/portal-tickets` | p01-portal | W6-05 |
| `portal.portalTicket.get` | GET | `/portal/portal-tickets/{portalTicketId}` | p01-portal | W6-05 |
| `portal.portalTicket.exchange` | POST | `/portal/portal-tickets/{portalTicketId}/exchange` | p01-portal | W6-05 |
| `portal.session.current.get` | GET | `/portal/sessions/current` | p01-portal | W6-05 |
| `portal.session.current.delete` | DELETE | `/portal/sessions/current` | p01-portal | W6-05 |
| `portal.ad.list` | GET | `/portal/ads` | p01-portal | W6-06 |
| `portal.ad.get` | GET | `/portal/ads/{adId}` | p01-portal | W6-06 |
| `portal.ad.playbackUrls` | POST | `/portal/ads/{adId}/playback-urls` | p01-portal | W6-06 |
| `portal.clientError.create` | POST | `/portal/client-errors` | p01-portal | W6-06 |
| `portal.licenseVerification.get` | GET | `/portal/license-verifications` | p01-portal | W6-06 |
| `portal.orderItem.list` | GET | `/portal/order-items` | p01-portal | W6-06 |
| `portal.orderItem.release.get` | GET | `/portal/order-items/{orderItemId}/release` | p01-portal | W6-06 |
| `portal.orderItem.downloadUrls` | POST | `/portal/order-items/{orderItemId}/download-urls` | p01-portal | W6-06 |
| `portal.orderItem.sample.get` | GET | `/portal/order-items/{orderItemId}/sample` | p01-portal | W6-06（Q9当前不实现；先正式治理） |
| `portal.sample.playbackUrls` | POST | `/portal/samples/{sampleId}/playback-urls` | p01-portal | W6-06（Q9当前不实现；先正式治理） |
| `m.orderItem.downloadGrant.create` | POST | `/m/order-items/{orderItemId}/download-grants` | m05-delivery-publish | W6-06 |
| `m.download.report` | POST | `/m/downloads/{downloadId}/report` | m05-delivery-publish | W6-06 |
| `admin.deliveryRelease.pack` | POST | `/admin/delivery-releases/{deliveryReleaseId}/pack` | a06-publish | W6-07 |

## 4. 十二新页与既有页面增量

页面key为端加登记路径；无独立地址的会话失效页使用页面名。原登记组、路径及样片/广告预览共用路径不改；该预览页实际只开放Q9允许的广告。

| 登记页key | 唯一owner | 类别 |
| --- | --- | --- |
| `admin:/publish/calendar` | W6-08 | 新登记页 |
| `admin:/publish/overdue` | W6-08 | 新登记页 |
| `admin:/delivery/tickets/$ticketNo` | W6-08 | 既有页面增量，不重复计12新页 |
| `admin:/publish/verify` | W6-08 | 既有页面增量，不重复计12新页 |
| `admin:/publish/patrol` | W6-09 | 新登记页 |
| `admin:/publish/offline` | W6-09 | 新登记页 |
| `admin:/publish/accounts` | W6-09 | 既有页面增量，不重复计12新页 |
| `weapp:sub/publish/accounts/index` | W6-09 | 既有页面增量，不重复计12新页 |
| `weapp:sub/publish/tasks/index` | W6-09 | 既有页面增量，不重复计12新页 |
| `weapp:sub/order/launch-record/index` | W6-09 | 既有页面增量，不重复计12新页 |
| `portal:/` | W6-10 | 新登记页 |
| `portal:会话失效说明页` | W6-10 | 新登记页 |
| `portal:/a` | W6-10 | 新登记页 |
| `weapp:sub/publish/portal-approve/index` | W6-10 | 新登记页 |
| `weapp:sub/service/settings/index` | W6-10 | 既有页面增量，不重复计12新页 |
| `portal:/items` | W6-11 | 新登记页 |
| `portal:/items/$id` | W6-11 | 新登记页 |
| `weapp:sub/publish/downloads/index` | W6-11 | 既有页面增量，不重复计12新页 |
| `portal:/preview/$kind/$id` | W6-12 | 新登记页 |
| `portal:/v` | W6-12 | 新登记页 |

页面实际工作量W6-08为4页、09为6页、10为5页、11为3页、12为2页，均不超过丙包8页上限。

## 5. 九项异步登记唯一归属

| 登记名 | 唯一owner | 处理边界 |
| --- | --- | --- |
| `usage.end` | W6-01 | 沿原主体、事件/定时器/周期/队列登记；既有已实现事实先复用，未完成部分真实回补，不改名或降断言 |
| `usage.resync` | W6-01 | 沿原主体、事件/定时器/周期/队列登记；既有已实现事实先复用，未完成部分真实回补，不改名或降断言 |
| `publish.onLicenseExtended` | W6-01 | 沿原主体、事件/定时器/周期/队列登记；既有已实现事实先复用，未完成部分真实回补，不改名或降断言 |
| `patrol.followup` | W6-03 | 沿原主体、事件/定时器/周期/队列登记；既有已实现事实先复用，未完成部分真实回补，不改名或降断言 |
| `patrol.weekly_generate` | W6-03 | 沿原主体、事件/定时器/周期/队列登记；既有已实现事实先复用，未完成部分真实回补，不改名或降断言 |
| `takedown.create` | W6-04 | 沿原主体、事件/定时器/周期/队列登记；既有已实现事实先复用，未完成部分真实回补，不改名或降断言 |
| `takedown.overdue` | W6-04 | 沿原主体、事件/定时器/周期/队列登记；既有已实现事实先复用，未完成部分真实回补，不改名或降断言 |
| `publish.onCalendarImported` | W6-04 | 沿原主体、事件/定时器/周期/队列登记；既有已实现事实先复用，未完成部分真实回补，不改名或降断言 |
| `zip_package` | W6-07 | 沿原主体、事件/定时器/周期/队列登记；既有已实现事实先复用，未完成部分真实回补，不改名或降断言 |

`publish.onCalendarImported`归W6-04重算下架核查期限；使用期重算主体由W6-01唯一写入。两者不得因都消费日历而复制writer或形成反向依赖。

## 6. 八个留桩唯一接收方

| 留桩文件 | 唯一接收包 | 当前状态与关闭条件 |
| --- | --- | --- |
| [m6-delivery-publish-list-invariants.md](../stubs/m6-delivery-publish-list-invariants.md) | W6-02 | 留桩中；仅该接收包在实际实现/验收后回写，不由本任务书包提前关闭 |
| [m6-delivery-publish-list-prefill.md](../stubs/m6-delivery-publish-list-prefill.md) | W6-02 | 留桩中；仅该接收包在实际实现/验收后回写，不由本任务书包提前关闭 |
| [m6-delivery-saved-progress.md](../stubs/m6-delivery-saved-progress.md) | W6-06 | 留桩中；仅该接收包在实际实现/验收后回写，不由本任务书包提前关闭 |
| [m6-delivery-package-zip-usage.md](../stubs/m6-delivery-package-zip-usage.md) | W6-07 | 留桩中；仅该接收包在实际实现/验收后回写，不由本任务书包提前关闭 |
| [m6-admin-plan-channel-selection.md](../stubs/m6-admin-plan-channel-selection.md) | W6-08 | 留桩中；仅该接收包在实际实现/验收后回写，不由本任务书包提前关闭 |
| [W1-20-m6-publish-future.md](../stubs/W1-20-m6-publish-future.md) | W6-09 | 留桩中；仅该接收包在实际实现/验收后回写，不由本任务书包提前关闭 |
| [W1-20-m6-episode-save.md](../stubs/W1-20-m6-episode-save.md) | W6-11 | 留桩中；仅该接收包在实际实现/验收后回写，不由本任务书包提前关闭 |
| [W1-20-m6-sample-computer.md](../stubs/W1-20-m6-sample-computer.md) | W6-12 | 留桩中；仅该接收包在实际实现/验收后回写，不由本任务书包提前关闭 |

ZIP/使用期复合桩由W6-07在01/04/07均actual并验收后唯一关闭；06消费同一ZIP公口，不双认。电脑样片旧桩由W6-12按Q9与06正式治理结果收口，关闭条件不等于恢复被排除的电脑功能。

## 7. 共享面、DAG与外部事项

- W6-01先交唯一使用期/到期公口（含ensureTakedownTasks），W6-04消费writer并挂自己的API/定时器；禁止01依赖04、重复算法或新增非法跨层/同层调用。
- W6-05先交票据/会话安全机制，02的portal清单和06/10消费它；06不把新授权算法藏入乙包，需要时先另拆甲类机制。
- W6-10按[安全壳分片记录](W6-10-shell-first.md)先交PR1供12及11电脑片消费，只有完整验收并actual main才放行；11电脑片仍等12/06/07等实际公口。10.PR2的X-01/V8、11.PR2的原全部前置/X-01/V7及各自E条件不变，13仍等10/11整包；本次独立文档PR先actual，不消费在途代码。
- 后端主序为01/05→02，01→03，01/02/03→04，01/02/04→07，01/02/05/07→06；页面只在实际公口合入后消费，12预览路由先于11清单入口跳转验收，13等01–12，14等13及W2-31。
- 领域模块各自只挂自己拥有的API/登记；共享runtime、路由入口、菜单/构件由ROOT按已合公口串行整合，不借未合分支。正式工作流/门禁如需调整，先独立gate-change actual，不在业务PR放松。
- V8在扫码真实形态开工前、V7在小程序逐集下载真实形态开工前关闭；其余可用本地替身验证的代码不冒称真实形态已验。
- V10数据万象打包、V11预发mediatool与预发闭环按原M6退出点；仅逐集下载等既定退路必须有真实结论，不静默改变判据。
- E8/E11和签后V12保持原台账时点；真实机构签名、真机、云资源和部署/送审均不能由任务书完成状态替代。
- W6-14只拆G7-B八包、M7合流和交M8；W7-01–08已有编号原样保留，G2-E及月结结构/任务补建仍按原后续时点。

## 8. 本轮只读核对

交付前以临时脚本核对55API/12页/9x01/8桩逐项集合相等与owner唯一、九节/90–170行、状态全未开工、级别规模依赖与本表一致、DAG无环。状态/计划单项检查走原脚本；冻结业务/契约/登记/桩源相对已同步actual main无差异，复用同字节contract/registry/pages证据，不重跑业务矩阵。结果回写W5-16状态，PR/CI实际回执后补。
