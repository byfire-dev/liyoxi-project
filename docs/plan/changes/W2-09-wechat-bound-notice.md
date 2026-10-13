# W2-09 新微信绑定提示订阅

- 实装既有 `identity.onWechatBound`，消费真实持久事件并写 `new_wechat_bound` 提示，与投递 done 同事务。
- 原事件 ID 作为提示主键，原 occurredAt 作为发生时间；重复及关闭后重投不新增、不覆盖首次关闭时间。
- 账号80锁后核当前状态：disabled保留安全提醒，missing/deleted跳过；注销并发不复活已清个人行。
- 通知排除新微信仍由notify所有；无新HTTP、DDL、公共依赖或生成物手改，retention留后片。
- 低量定点6DB+1API，作者仅所属格式/lint与正常提交；ROOT统一重型验收与唯一独审，整包仍进行中。
