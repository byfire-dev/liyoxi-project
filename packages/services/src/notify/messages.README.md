# W2-17 PR1：消息读取与通知设置

`createNotifyMessages({ tx, clock, config, purchaseMode })` 提供列表、摘要、单读、批读与通知设置。API 五条薄壳调用 `runtime.notifyMessages`；两条写接口传入原 `idem`，同事务保存首次响应。工厂不创建通知，不派发任何外部通道。本 PR 不回补五项通知留桩，W2-17 整包继续进行中。

`MessageActor` 是账号与可空当前门店；`NotifySettingActor` 另带真实会话 ID 与微信身份 ID。列表、摘要、已读更新共用固定 SQL 谓词：接收人本人、账号正常、主体与成员当前有效，门店当前可进入，`is_owner_only` 对消息所属主体的当前老板现查。账号级消息没有门店头也可读；门店头不存在或无权进入为 `NOT_A_MEMBER`。老板自己停用的门店允许收尾读取；草稿删除与随主体关闭的门店不放行。解析上下文后，每条 SELECT/UPDATE 的当前 EXISTS 仍再次检查，不依赖旧角色数组。

`inbox.scope=current_store` 仅当前门店与主体/账号消息；`all_stores` 是当前可进入门店的并集，不能打开店员未加入的门店。`countUnread(tx,{merchantUserId,entityId,storeIds,now})` 是公开只读事实实现，使用同一条件与当前配置。多门店按消息 ID 去重，没有 `viewerRole` 信任或“首家门店”替代。摘要固定 `all` 加七类页签；`system` 消息计入 all，但不新增独立页签。每个 byStore 计数表示切到该店后看到的未读，所以账号/主体消息可以分别计入多家门店。

列表按 UUID ID 降序，私有 v1 base64url 游标限长并验证 UUID v7；没有总数。批读只更新当前可见、尚未读、ID 不超过上界、符合页签的行；新 ID 留作未读。单读用条件 UPDATE，竞争者返回已存在的原始 `readAt`。读写只改 `read_at/updated_at`，不建通知、审计、状态历史或出站事件，业务时刻来自注入时钟。

`required` 同键重放会跳过 `tx.run` 的业务回调，因此单读在独立只读事务中先检查当前门店与消息可见性，返回前再检查；批读也先检查当前门店。原标读 DML 与首次 `readAt/markedCount` 不重复执行。单读失去消息权限为 `NOT_FOUND`，退出当前成员或门店不可进入为 `NOT_A_MEMBER`。

按 C50，权限未变时批读重放仍返回首次 DTO，新到消息不会改变旧摘要或被旧请求标读。该尚未上线接口的私有幂等结果保存 `visibility/payload` 包装；指纹只含解析范围、当前账号正常/老板资格与排序后的全部可进门店，不进入公开 DTO 或日志。重放权限变化但当前门店仍可进入时，仅摘要按当前权限重裁，`markedCount` 保留首次操作结果。原摘要的分类计数与门店计数由两条 SELECT 合并为同一 READ COMMITTED statement，计数和权限指纹来自同一快照；GET 也复用它。固定八个页签与原可见谓词保持，门店 JSON 聚合明确按门店 ID 排序。

DTO 的 DeepLink 严格复用原 Banner 13 项，增加 a09 §2.9 的 `payment.result/payment.detail {paymentOrderId}`、`points.ledger {}` 与账号安全消息的固定安全消息中心 `messages.list {}`。参数名沿用实际 m07 付款单路由，禁止裸 URL、任意路由与多余字段。原 Banner helper 的类型参数伴随只恢复精确参数推导，运行时严格结构与原键保持。尚未实现的发票等未来场景不在本 PR 猜测。

设置以 12 个正式槽位顺序读取真实配置；仅当前会话微信身份的额度，最终查询再次验证会话、账号与身份关系。总开关关闭/槽位不可用优先 `unavailable`，否则 banned/rejected/on/off；不可用模板 ID 为 null，保留真实剩余额度与授权时间。有效启用场景名称来自库。无效门店头按账号设置降级；有效主体调用组合根的真实 `purchaseMode`，hidden 仅移除到期与积分两槽位。冷却与每次请求数读取正式参数，不硬编码。

本目录 tests 用真 PostgreSQL、注入时钟、虚构通知与真实角色/会话/额度。应用与店员黄金回放通过测试入口的 `createNotify*Fixture` 准备非空样例；夹具不进入生产入口，不替代处理器响应，不产生真实消息送达。生产发布、远端 CI 与整包派发验收另由调度会话完成。
