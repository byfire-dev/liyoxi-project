# W2-17 公告通知分页的独立结构能力

| 项 | 内容 |
| --- | --- |
| 改了什么 | 独立结构包增加 notify L1 的 notification_fanout（13 列）；W2-17 PR3 仍为原 5 x01、无嵌入 DDL，只有能力实际合入本地 main 后才消费。 |
| 原因 | D6 第 514 行要求超出 notify.fanout.batch（默认 1000）时仅持久化分页任务、由 notify 队列处理；当前只有 notification/delivery，订阅者不能在事务内写外部队列，也不能靠内存或一次全量 owner 查询兑现崩溃恢复。 |
| 前置 | 独立 db-post-init-gates 包先完成首版等价证明与当前快照/托管数量口径的衔接；不修改冻结底稿、原迁移、锁序常量、内核机制或 required 名单。 |
| 状态 | 进行中：模型与迁移首版已写，库→schema 草稿核对、约束/并发/权限测试、快照与原检查、独立审查及本地 main 合流待完成。 |

唯一键为 (notify_scene_key, site_notice_id)，同一次公告或撤回的重复 outbox 不新建分页任务。source_outbox_event_id 只存原事件 UUID，与现有 notification 同口径，不外键绑定保留期未定的 outbox。实际公告与场景各有向下/同域 FK；二元 (merchant_user_id, entity_id) 游标只记遍历进度，既不保存手机号、openid 或消息文案，也不外键绑定已退出的收件人。

技术状态复用 NOTIFICATION_DELIVERY_STATUS，认领次数上限 3；sending 必有租约，终态必有 finished_at。时刻由应用注入的时钟写入。应用权限仅 INSERT/SELECT/UPDATE，readonly 继承原属主的默认 SELECT；不增加删除权。处理端先短 TX CAS 认领，再在独立 TX 读取当前公告/合法 owner 与领域守卫、写通知及站内消息，最后用 attempt/status/lease 条件 CAS 推进二元游标；CAS 失败须抛错回滚整页，不能先锁任务再取得商家/主体等业务锁。租约回收与页内通知去重负责崩溃重入。

正式默认 1000 保持；本机边界验证只在隔离用例把原参数设为 2，证明跨页/重入/归属边界，不能作为 1000 收件人的性能证明。W2-17 整包、远端 CI、云到达和容量验收均保持未完成，独立能力通过也不放行原下游。
