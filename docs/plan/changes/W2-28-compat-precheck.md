# W2-28：普通发布必须有明确混跑成功输入

| 项 | 内容 |
| --- | --- |
| 改了什么 | 普通发布编排只接受 compatibility=passed；缺省/unavailable/failed在节点读取与拉取前拒绝，仍追加原失败记录。rollback保留原规则。 |
| 原因 | 自动工作流同SHA检查之外，独立CLI也不能把未知混跑结果作为发布放行。参数是已验结论输入，不是验证本身。 |
| 影响的包 | W2-28、W2-26；仅orchestrate、rehearse、runbook、新风险聚合和本记录，不改既有门禁测试或工作流。 |
| 类别 | 范围 |
| PR | 本地codex/w2-28-compat-precheck；唯一ROOT审查后普通提交，最终等controller与独立gate实际合流再合入。 |

基于实际main fe89bbd8，消费已存在orchestrate公口，不依赖未合源码。rehearse显式passed仅表示本轮隔离fake预检，不证明真实混跑；运行手册要求手动发布先核同完整SHA的真实成功结论。原默认关闭、冻结、记录/失败停止、回滚与资源判据保持。

只核新增一个无IO聚合与轻格式/lint/台账；原正路径41目标不重跑。其成功夹具由独立gate先实际合入后普通同步；本片不跑类型/DB/build/Docker或GitHub，不声称真实演练或远端CI通过。

本地新增风险聚合1/1通过（129ms，断言4ms）；定向格式/ESLint与差异检查通过。正常发布的三类拒绝均只追加失败记录；passed和rollback/unavailable确实进入facts后由受控通道停止，rollback/failed仍前置拒绝。
