# 微信服务端订阅回执（W2-21）

`createWechatReceiptHandler({ clock, logger })` 返回 `(tx, input, ctx) => Promise<'processed' | 'ignored'>`，由组合根注入 security 微信 source；notify 的结构类型不依赖上层回调实现。source 负责验签、去敏、NULL identity 的整条 ignored，以及从 webhook_event 读取持久 receivedAt。

sent 仅按 wx_subscribe、消息号、发送时模板快照、当前真实身份与通知收件人全部匹配追加两列；receiptStatus/receiptReportedAt 同时为空才写，时间取持久 receivedAt。缺消息号/结果码、超列限、未知或错归属项 ignored，不能伪造成功。发送状态、同步错误和重发流程保持原样。后台 test 发送的 HMAC 目标无法只凭 identityId 安全归属，暂 ignored；不按消息号越权匹配。

change 按正式关闭事件置既有额度 rejected/0，匹配所有同模板的真实槽位，按槽位键排序并在 UPDATE 内复验当前 identity/owner/template。仅实际变更时写注入 clock 的 updatedAt；不按 optional status 增加规则、不建额度、不改变历史授权/发送/错误列。删除身份后旧载荷不能转向同 openid 新身份。

重复零写返回 ignored；popup 只记录固定事件名、itemCount/matchedCount 整数，无表写入。日志不含身份、openid、模板/消息号、errorStatus 或原 payload。两张技术表 lock_rank=null，本叶不增加业务锁、状态迁移或外呼；SQL/guard错误原样交外层事务回滚。日志是本次事务中观察到的处理计数，不作为最终提交的独立证据。

真DB测试含两独立连接的同回执/矛盾回执及关闭重复竞争、冷收到时间、跨身份/通道/模板/用户、改绑旧id、HMAC目标、同模板多槽位和 popup 六表快照。原客户端 subscribe-results 独立保留，测试只用虚构数据与隔离库。本叶完成不代表整个 W2-21 HTTP/Provider/通知到达验收完成。
