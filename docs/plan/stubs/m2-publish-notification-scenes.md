# 账号与上线核验的通知场景派发

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | publish 出站事件的通知场景解析与派发 |
| 骨架里的做法 | publish/notify-facts.ts 与 register.ts 保留真实 channelAccountForNotify/launchTaskForNotify 和发布链接读口；notify/registry.ts 消费当前实际 account.verified/abnormal、launch.verified/returned，以当前核验结果/主体老板生成站内消息和外部 pending 投递。发送 T2/T3 重验当前对象/接收人，不在 publish 同步调用通知或补发事件；未知平台结果不重发、未配置受控跳过。后续下架/巡检 producer 仍归所属包，真实到达另验 |
| 登记的工作包 | W1-14，PR 待填写 |
| 回补里程碑 | M2 |
| 回补的工作包 | W2-17 PR3（源码与本地目标验收；调度完成独审和本地合流后填写提交，远端 PR/CI 仍暂停） |
| 依据 | W1-14 第 7 节；开发计划第 7.3 节留桩清单；a06 第 1.1 节通知；W0-17 第 2、7 节 |
