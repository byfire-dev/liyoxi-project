# W2-27：b 先交两FILE可选节点配置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 原b告警/错误接通与源码映射先交b1两JSON可选节点配置；后继继续假收件/转发演练与真实map上传，整包退出判据不变。 |
| 原因 | 已合kernel实际为CLIENT_ERROR_PROJECTS_FILE及ALERTS_FILE，后者包含robotKey/oncallPhones/p2Immediate；旧任务三文件和可替换机器人URL表述已与实际驱动不符。 |
| 影响的包 | W2-27、W2-29；编号/包数/依赖/评审级别不变，b1不能冒称整包前置完成。 |
| 类别 | 顺序 |
| PR | 本地codex/w2-27-observability-config，协调统一独审与合流；作者不操作远端。 |

仅复用固定node_providers/provider_files、manifest、check-secrets和providers目录：client-errors只给api/check-env，alerts只给worker/check-env，默认关闭、选中缺文件拒绝、值只经只读FILE进入原解析器。不增加业务runtime、Provider参数、任意URL、DDL、权限或依赖。

新增三个聚合纯检查锁完整九组/十二optional及实际两JSON格式、默认/关闭/选择/角色/文件属性/失败不泄露；正式loadEnv通过静态测试助手显式自造source验证，无DB/容器/网络或真实凭据。任务允许目录窄补lib/provider README及该测试助手，已由调度批准。

原整包的假收件、错误转发演练、源码映射、E18、SaaS、云监控/外部拨测和真实预发验收继续待办。WeCom固定生产URL、客户端HTTPS DSN保持；后继假接收使用受控协议替身，不添加任意生产endpoint。admin当前生产构建无map，后继先交真实map产物，不以空目录上传当通过。
