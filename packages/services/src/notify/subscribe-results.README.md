# 订阅槽位与端上授权结果（W2-18 PR1）

readSubscribePlan只返回服务端已配置providerTemplateId且active的槽位，点位顺序取正式D6；空点位省略，匿名bootstrap不调用。购买模式取已批准finance配置的真实首匹配规则，hidden/offline_contract屏蔽对应点位，hidden同时隐藏积分变化；可信entity来自当前成员关系。notify.wx.ask_cooldown_days/max_per_ask默认7天/3个，走正式config参数。

createSubscribeResults.apply用当前会话user/微信身份，客户端不能指定身份；required键必须等于subscribeReport:{reportId}。TX幂等认领后，accept按实际quota_cap加一、ban清零并标banned、reject/filter不改额度；未知模板忽略，开关关闭仍受理真实结果。额度为估计值，不能代表微信真实授权次数。并发/重放不重复增加额度。

成功提交且非幂等重放后，经既有Alerts发P3事实：notify.wx_banned或notify.wx_filtered，dimension是服务端已配置slotKey（现有12种种子，DB仅限制格式/长度），detail只含{point,slotKey,result:'ban'|'filter'}。不接客户端任意dimension，不含用户或模板编号；未知模板不告警。W2-24消费规则的独立移交不代表本包或外部平台完成。

运行pnpm exec vitest run --project services packages/services/src/notify/subscribe-results.db.test.ts packages/services/src/identity/bootstrap.reporting.db.test.ts packages/services/src/billing/subscribe-plan.db.test.ts，使用根CLAUDE公开local/test连接与独立session。测试槽位是明确fake fixture，不把批准模板/真机授权当作已完成；真实模板配置与端上授权由W2-27验证。本包不改W2-17派发或W2-22短信。
