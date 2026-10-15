# W2-27：独立本地观测协议演练

| 项 | 内容 |
| --- | --- |
| 改了什么 | b的假收件/错误转发演练独立交付；同轮默认未配→两FILE→原生HTTPS协议收件、生产租约/probe writer/dispatcher与超管铃铛闭环。 |
| 原因 | a、b1及告警/错误代码已实际合流；真实平台账号与映射上传不应阻挡本机受控协议证明。 |
| 影响的包 | W2-27、W2-29；编号/依赖/评审级别和完整退出判据不变。 |
| 类别 | 顺序 |
| PR | 本地codex/w2-27-observability-rehearsal，ROOT唯一独审后统一提交与合流；作者不操作远端。 |

仅新增演练helper、短命夹具、公开假TLS材料与一个infra聚合纯测；不修改apps/packages、生产Provider白名单/endpoint、TLS守卫、门禁或依赖。脚本约770行（不含证书/声明/测试），较约600行预算增加的部分用于固定协议收据、所有权/租约及失败恢复，调度已接受；没有新通用框架。收件容器不发布端口，qyapi.weixin.qq.com只在本轮私网取别名；仅本轮API/worker信任假CA，CA私钥未保留。受控采样不冒充真实环境探针或容量验收。

本机旧server:local与gateway:local均为2026-10-05产物、无revision/LYX_BUILD，早于必要公口，不能用来声称当前实现已验。实演须在唯一重槽按冻结源码构建自有同tag server/gateway，写精确源码SHA/OCI revision；mediatool只给既有固定镜像追加本轮tag引用，不重建、不pull/prune或改local。

一个聚合纯测已G（1/1，测试体9ms/总141ms），覆盖隔离身份、公开证书链/主机、只读信任范围、固定协议收据拒绝以及停worker后失败恢复；无DB/网络/容器。当前真实演练尚待重槽和源码审查，不据纯测宣称告警/信封已实际转发。真实E18/短信/SaaS、预发演练、映射上传、端上结构/debug ID对齐及符号化继续未验，W2-27保持进行中。

静态边界另有两份窄.d.mts（47+3行），供infra测试静态引用MJS而非动态导入规避依赖；infra类型首轮仅聚合数组索引RED，类型点修后G。保留首轮失败日志，不重复原绿用例。

唯一审查发现两P2已修：bootstrap显式携本轮LYX_TAG；清理按容器ID及project/service/本轮label核所有权，缺失幂等，失败仍恢复默认并清另一项后拒绝通过。夹具逐阶段allSettled保证release/数据库关闭不被前项失败跳过。仅重受影响聚合1/1G（12ms/总149ms），infra类型最终G；未重复其它绿目标，实演仍待执行。
