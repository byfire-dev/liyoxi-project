# W2-27：独立本地观测协议演练

| 项 | 内容 |
| --- | --- |
| 改了什么 | b的假收件/错误转发演练独立交付；同轮默认未配→两FILE→原生HTTPS协议收件、生产租约/probe writer/dispatcher与超管铃铛闭环。 |
| 原因 | a、b1及告警/错误代码已实际合流；真实平台账号与映射上传不应阻挡本机受控协议证明。 |
| 影响的包 | W2-27、W2-29；编号/依赖/评审级别和完整退出判据不变。 |
| 类别 | 顺序 |
| PR | 本地codex/w2-27-observability-rehearsal，ROOT唯一独审后统一提交与合流；作者不操作远端。 |

仅新增演练helper、短命夹具、公开假TLS材料与一个infra聚合纯测；不修改apps/packages、生产Provider白名单/endpoint、TLS守卫、门禁或依赖。两个演练助手合计821行（不含证书/声明/测试及既有入口窄改），较约600行预算增加的部分用于固定协议收据、所有权/租约及失败恢复，调度已接受；没有新通用框架。收件容器不发布端口，qyapi.weixin.qq.com只在本轮私网取别名；仅本轮API/worker信任假CA，CA私钥未保留。受控采样不冒充真实环境探针或容量验收。

本机旧server:local与gateway:local均为2026-10-05产物、无revision/LYX_BUILD，早于必要公口，不能用来声称当前实现已验。实演须在唯一重槽按冻结源码构建自有同tag server/gateway，写精确源码SHA/OCI revision；mediatool只给既有固定镜像追加本轮tag引用，不重建、不pull/prune或改local。

一个聚合纯测初次G（1/1，测试体9ms/总141ms），覆盖隔离身份、公开证书链/主机、只读信任范围、固定协议收据拒绝以及停worker后失败恢复；无DB/网络/容器。后续真实演练的失败与修复记录见下文，不据纯测宣称告警/信封已实际转发。真实E18/短信/SaaS、预发演练、映射上传、端上结构/debug ID对齐及符号化继续未验，W2-27保持进行中。

静态边界另有两份窄.d.mts（62+3行），供infra测试静态引用MJS而非动态导入规避依赖；infra类型首轮仅聚合数组索引RED，类型点修后G。保留首轮失败日志，不重复原绿用例。

唯一审查发现两P2已修：bootstrap显式携本轮LYX_TAG；清理按容器ID及project/service/本轮label核所有权，缺失幂等，失败仍恢复默认并清另一项后拒绝通过。夹具逐阶段allSettled保证release/数据库关闭不被前项失败跳过。仅重受影响聚合1/1G（12ms/总149ms），infra类型G；未重复其它绿目标。

真实执行保留三次RED：初轮11.108秒在check-env因发布JS为0600/root:root而失败，尚未进入观测段。上游权限窄修ffdba1b3实际合流后，普通merge源码16617fe5重新构建自有server/gateway；network-none/read-only下server生产UID1000真实打开全部API6/worker9第一方JS，gateway实际nginx UID101读取admin1/portal1 JS，均G。server此次构建存在host单调92.253秒与Docker导出阶段1618.0秒的时钟差异，不推定唯一原因；暂停后获准单次cached gateway构建9.001秒完成，不连续重试或prune。

第二次完整rehearse于13:15:23–13:16:14 UTC运行51.532秒RED：默认六容器与未配202/日志已过，选配阶段的Compose create不支持--no-deps。仅改create为--no-build --pull never，纯聚合1/1G（12ms/113ms），不重建应用镜像。随后经严格核对保留项目/home/镜像与正式CLI已建唯一超管，用临时诊断driver续跑整个观测段；18.624秒RED在open阶段。实际生产dispatcher同时受理目标及合法背景告警，旧断言全库accepted===1不成立；收件容器已随finally清理，不能据数据库accepted推称收件成功。

最新窄修9f2c66f5为本轮目标新增随机子维度，保留旧告警与全部Provider真实发送；全库计数仅要求目标阶段存在受理，目标仍严格核notifyCount0→1→2、两条超管铃铛及两条目标机器人收件。收件上限仍8，精确区分2信封、2目标机器人与合法背景数量，并拒绝错nonce、重复目标及前缀碰撞。唯一审查点核无未解决P1/P2；仅重同一纯聚合1/1G（12ms/117ms），Node24正常hooks通过。最新完整观测段仍待重槽续验，不写全新完整rehearse已G。

9f2c66f5的infra类型单次G后，续段13:50:42–13:50:59 UTC运行16.428秒RED：选配后的第一POST经gateway返回502，固定日志为连接上游失败，尚未进入告警夹具。API重建的容器内就绪不能代替gateway已解析新地址；模板现有DNS缓存10秒。finally实际核六个自有容器运行，API/worker选配FILE/CA环境均恢复为空。获准仅在两段首次POST前，经原gateway与api Host等待真实上游/readyz返回200；最长15秒：选配段先在该预算内等10.001秒使各nginx worker的旧缓存过期，默认段无固定等待；其后间隔≤500毫秒、每GET原生取消≤1秒，POST不重试，原POST20秒不变。未就绪→就绪/超时及选配段时钟反例仍在原聚合，最后1/1G（17ms/112ms）；最新实演待点核与重槽，不能由纯测推定收件成功。
