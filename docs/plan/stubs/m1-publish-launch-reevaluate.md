# 上线事实变更后的工单求值与当前处理人

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | `publish.launch_changed` 的工单求值实现与 `publish.launch_handler` 的当前处理人读取 |
| 骨架里的做法 | publish/ports.ts 定义端口：回填、通过、退回同事务调用 launchChangedPort，默认无写入；launch_link.handlerOf 经绑定装配调用 launchHandlerPort，默认 null。本域 getLaunchFacts 已读取真实上线事实；API 与真实 worker 均绑定，不伪写工单/订单项 |
| 登记的工作包 | W1-14，PR 待填写 |
| 回补里程碑 | M1 |
| 回补的工作包 | W1-16a PR1 注册 launchChangedPort、launchHandlerPort，真实集合求值与当前处理人读取；PR 号由发布会话填写 |
| 依据 | W1-14 第 5、7、10 节及附；开发计划第 7.3 节留桩清单；任务移交第 46 行 |
