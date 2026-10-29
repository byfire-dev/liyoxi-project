# W228 私有 owner/API driver

这是对应源码的测试装配，尚不是双版本演练收据。固定入口为
apps/api/test/e2e/mixed-http-driver.ts owner|phase，用本版已安装的 tsx 启动。
owner 只接受 APP_ENV=test；phase 只接受 APP_ENV=local。
不读取真实环境文件、不连接云端、不执行任意命令。

controller 从精确 SHA 的上下文构建本版测试镜像，再用精确 image ID 做极薄派生层，
仅复制该完整40位 SHA 文本到 /repo/.mixed-source-sha。driver 读取此固定路径，
严格核请求 source；controller 仍须另核 OCI revision/image ID。
旧镜像必须自带本 driver/worker/OpenAPI，不能从 HEAD 挂入代码。
首次没有正式 release 时的第一父基线是 bootstrap 证据，不能冒称真实发布版本比较。

## 私有协议

请求为一行 JSON：
{protocol:"w228-rpc-v1",id:正递增整数,method,params}。
响应为同协议/id与 ok:true,result，或 ok:false,errorCode。
read_failed仅可额外携带已选旧spec的安全operationId；不带请求路径或猜测HTTP状态。
每条请求/响应最多1MiB；错误码固定，不输出 message、stack、URL或原始日志。
失败、截断或没有显式 close 的 EOF 均失败退出；SIGTERM/controller预算取消
仍等待自有子进程与资源关闭。controller总预算600秒，driver工作预算540秒，清理独立有界。

stdout只放私有RPC。attachment、admin口令/TOTP恢复材料、对象ID与观察路径只在
stdin/stdout管道及controller内存，不可合入公开JSON报告/artifact。
API日志进入可选诊断sink，仅累计固定级别错误/损坏记录，不保留原文；
错误计数非零仍失败。worker自有stdout/stderr不转发，正式错误计数由IPC核。

| method | 输入/输出 |
| --- | --- |
| owner.init | {source,runId,ownerNetwork}；返回protocol/source/pid/attachBase:{scope,storage} |
| owner.close | {}；成功返回closed:true、scopeAbsenceVerified:true、bucketsAbsent:true |
| phase.start | {source,attach,phase}，phase为head-write/old-read-write/head-read；返回source、apiPid、真实worker快照及apiDiagnosticErrors |
| phase.chain | {admin?}；head-write真实bootstrap，old-read-write必须传前轮admin并实际重登；返回report/initialization/observedReads/private access |
| phase.read | old阶段输入{previousAccess,observedReads}，返回operationId/status与详情、私有readSpec；head-read另必须传previousSource/readSpec，绝不回显令牌/查询路径 |
| phase.drain | {}；返回原只读drain结果、真实worker快照与API错误计数 |
| phase.close | {}；成功返回workerStopped:true、bridgeClosed:true，不伪称另读过租约释放 |

ownerNetwork只消费services的唯一schema；expected/receipt四项身份严格匹配，
仅固定本轮别名和端口，非attach原隔离工厂实际迁移/补种并持有owner能力。
四桶全部先HEAD不存在才创建；清理逐桶有界分页/删除/HEAD404，错误归集继续，
不接管已存在桶。ownerNetwork的support.close另实际核本轮DB消失与Redis完整前缀零键，
任何失败不返回成功收尾。

phase fork镜像自带worker，真实PID/PG租约版本/BullMQ/全库积压及错误零共同核。
准备原片后、下单前暂停真实timer_scan并等待屏障，原held断言后才恢复；七段、20集、单上传、
30秒观察与业务实钟不变。API桥只观察，不能用controller直接调用handler替代旧版。
文件与签读用本轮MinIO；codec、备份进程/备份对象、SMS是明确外部IO替身。
这不证明生产dist健康、真实云处理、备份恢复或短信送达。

W228三阶段分别声明固定代理客户端198.18.0.1/2/3，测试桥只信任回环一跳，
HTTP transport固定注入对应X-Forwarded-For；真实TCP及各版口令/MFA重登保持。
这避免HEAD激活与重登恰好用满匿名IP每分钟10次后，OLD首登录被429拒绝。
普通M1未显式选phase时不添加转发头；不改生产限流、不清计数、不等待窗口。
修正尚待同源两版正式四步验证，不把前一轮HEAD20集/123不变量绿色冒称完整混跑通过。

显式W228阶段在runChain开始时只重置本进程HTTP观测数组，清掉前一读取阶段的路径；
本条链重新成功读取的共同路径仍重新入列，普通M1不重置，已返回的旧read/spec不变。
否则OLD先读取HEAD主体再写新主体时，累计路径会被下一阶段误用新主体身份复读。
第7轮已完成两条20集链、各123不变量及OLD的95列表/52详情，最后HEAD复读订单失败；
上述scope混入由源码确认，未记录该次HTTP状态，完整四步仍未通过。

## 旧 OpenAPI reader

old阶段只读本版提交的merchant/admin/portal OpenAPI，枚举全部无路径参数GET（当前95），
六个必填query用正式字典、实际店、北京时间年份、搜索词和真实HTTP邀请令牌。
跟进列表另带实际entityId，素材列表另带实际storeId，制作记录列表带真实链orderItemId，满足字段各自可选但组合必需的正式约束；
原pure聚合逐项校验现有canonical query，并精确比较全部operationId集合，不用旧固定数量漏读。
邀请经正式创建，读取后正式撤回；不是SQL假行。未来新增未知必填输入直接失败，
不省略接口。真实跨版admin口令/MFA、商家phoneLogin重登；不复用上版headers。
HTTP重登仅在当前TOTP步已由正式认证消费时等待真实下一步；由受保护隔离支架只读
staff.totp_last_step，未消费则使用当前真实码。不试错登录、不改步号、不预用未来码。
30秒read RPC预算保持。
旧镜像仍运行自己的驱动；此修正与本机桥接回归不能代替双SHA四步验证。
本轮7个ID映射可用详情，并复读已成功observedReads对应的真实详情；
没有对应GET的merchantUserId/sampleId不捏造路径，样片沿orderItemId读取。
所有计划读均要求200；5xx、404、未知路径或未完成失败，不能把权限拒绝记授权成功。
old阶段同时通过私有RPC传回完整GET投影readSpec（含路径模板/必填query/source）；
Step4 HEAD严格绑定previousSource与该旧spec并重放，完全不以HEAD自己的OpenAPI覆盖。
旧版独有GET即使在HEAD清单中消失，也必须实际请求而不能漏验。spec不进公开报告。

3个纯聚合覆盖协议边界、实际OpenAPI/query/详情计划及诊断脱敏，首次3/3通过
（3.39秒/tests26ms）；EOF取消补点只重验协议1组通过，旧spec与安全失败上下文
补点只重验reader原1组通过（最终5.19秒/tests27ms），其他绿色组复用。
ROOT唯一83.260秒源码审查指出Step4清单遗漏，已按上述旧spec重放修正并定点关闭；
API首轮类型仅遗漏实际注册订阅者参数，同批改用本bridge真实注册名单，最终API类型通过。
普通同步实际main 3c4a0314的唯一ownerNetwork/schema/sink及c413c753纯门禁片，
所属格式/ESLint/diff与正常Node24 hooks通过；没有DB/构建/容器/GitHub操作。
独立进程镜像运输尚待双SHA四步一次验证，不重复完整20集单链，不宣称整包完成。
