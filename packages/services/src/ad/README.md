# 广告拥有者公口

W5-08 以 `createAdService` 提供商户报价、创建、列表、详情、重提和相册下载；创建和重提复用内核三段执行器，内容检测在事务外执行，done 重放直接返回无签名的状态摘要。确认和修改只暴露 tx-first 核心，由 ops 的 `createAdRuntime` 预锁成员、主体、门店、广告、浮动订单/工单、样片与文件的完整图，在同一事务调用 delivery 影响核。ad 不查询 order/delivery 私表。

`assignAdTx` 真实 capture 后随状态写 `editor_id/captured_at`；`registerAdVersionTx` 和 `pushAdVersionTx` 消费媒体 owner 的真实广告生产事实，不写生产成功状态。`prepareAdProduction` 仅声明手工产物并排真实 probe。W5-09 在通用上传口接入实例级广告 guard：当前本人任务、门店、在途取消、AI声明先核实，登记后沿 complete/promote/probe 形成真实 ready 事实；原日历 owner 重算继续复用其既有时限快照。returned 陈旧提醒只发既有事件，不自动退款。

`claimAdCancelRequest` 在调用方稳定锁图内占用本广告指针；`cancelAd` 实现正式 ad.cancel 的09:808/809两行，returned 按真实 returnedFrom 选择。取消状态、时间、原因及指针同一 UPDATE，真实账本回调随后在同 Tx 返回实际数量，四个累计列一起写，最后发送严格 ad.cancelled（returnedPoints 表示原路＋转加购，三值分别存行）。

调用方须先按全局顺序锁全申请/明细/主体/门店/广告/活跃绑定订单及项，并在唯一账户420前预锁本广告相关 timer；本入口只重入已持广告锁。取消精确匹配本广告首版/修改版 SLA 及待补充陈旧 timer，保留其他用途、其他广告、历史版本和超次修改扣减。关闭未执行申请仍复用 clearAdCancelRequestPointers，仅清本申请，历史客服引用不删除。

执行回调、实际数量、事件、历史全属同事务；调用方失败全部回滚。

## 商家生命周期与跨域装配

W5-08 的提交、重提、修改通过既有三阶段事务执行：先核当前门店与输入，再在事务外做微信文本检测，最后锁内复核并写状态、版本、同意和积分。报价与详情不制造查看证据。免费次数来自创建快照，超次修改沿 billing 原账本；提交取消后，新写由锁内指针守卫拒绝。

`ops/createAdRuntime` 在确认或重开前读取完整浮动工单影响图，按原全局锁序取得广告 UPDATE 及下游锁并复核目标；广告与工单变化同一事务提交。重开使尚未钉版的活动样片失效，暂停工单待恢复时重算，已钉定版本不被替换。后台样片代录由 delivery 公口调用免费重开核心，不能代商家接受额外收费。

媒体 ready、微信播放开关和推送时的渠道快照分别核验。`m.playable.get` 按 trailer、ad、sample 分别校验业务归属、文件引用及制作事实，签名在事务外完成，返回前再核事实；GET 不增加已查看记录。相册与其他关闭播放时的确认渠道仍须对应广告版本的实际证据。

共享 producer 核心供商家生命周期与 W5-09 后台用例复用；后台十接口由 `ops/createAdminAdRuntime` 组合，各域私有表只由所属 reader 投影。`ad.returned_stale` 只发待补充提醒，不自动取消或退款。测试里的历史上传输入、Provider 传输替身与真实商业素材、平台审核验收分开记录。


## 后台任务、员工移交与时限（W5-09）

十条后台接口共用真实范围筛选，列表、计数与详情按当前门店/负责人/员工集合；写在员工共享锁后重读当前角色、组与授权。首次指派仅执行原广告 capture，不凭空记改派历史。版本消费当前剪辑师上传且真实 stored/probe-ready 的制作事实，物理尺寸来自媒体 owner；未推送版本不对商家可见，后续未推新版覆盖前版的未决资格。推送按本轮快照记录可看渠道，线下发送登记只是员工证据，不替代商家确认或查看自声明。

后台代录沿原免费重开核心，同事务应用浮动订单/工单/样片影响；超次拒绝，不代商家接受收费。签名在事务提交后生成，幂等持久回执不含私签地址，重放不再签发，前端重新 GET 取当前地址。跨域详情只用 profile/docs/order/delivery/billing/support 的窄事实读口，历史冻结时间、计价套餐、同意、所有绑定与实际取消结果不以当前订阅或默认空数组替代。

`adStaffWork` 按 producing/revising/pending_confirm/returned 的当前 editor 列出真实在办，登记 owner=ad、source=ad_editor；正式 staff 管理组合声明该 owner 必需。移交按原员工/业务锁顺序，在 ad owner 重核原归属与启用剪辑师目标，再由原 staff 事务写 assignment_history/outbox。移交不重置 first/due 时间、SLA快照或已扣积分。

`handleAdSlaBreach` 只消费唯一 `sla.breach` 中的 ad 主体，核持久 dispatched timer、当前 key/purpose/轮次/deadline/快照以及未满足事实；日历重臂与初始快照载荷均严格对照。旧轮次、退回、已推送、取消中或迟到载荷跳过。资质在审待指派只提醒，不写 first_breached_at。实例关闭后旧回调拒绝，工单环节等其他主体沿原处理器。手工催办与两自然日提醒沿通知框架，实际投递成功、真实小程序播放与法务验收单列，不由队列入列推断已送达。
