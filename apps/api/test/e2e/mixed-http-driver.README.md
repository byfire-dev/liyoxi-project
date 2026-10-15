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
| phase.read | {previousAccess,observedReads}；返回operationId/status列表与详情列表，绝不回显令牌/路径 |
| phase.drain | {}；返回原只读drain结果、真实worker快照与API错误计数 |
| phase.close | {}；成功返回workerStopped:true、bridgeClosed:true，不伪称另读过租约释放 |

ownerNetwork只消费services的唯一schema；expected/receipt四项身份严格匹配，
仅固定本轮别名和端口，非attach原隔离工厂实际迁移/补种并持有owner能力。
四桶全部先HEAD不存在才创建；清理逐桶有界分页/删除/HEAD404，错误归集继续，
不接管已存在桶。ownerNetwork的support.close另实际核本轮DB消失与Redis完整前缀零键，
任何失败不返回成功收尾。

phase fork镜像自带worker，真实PID/PG租约版本/BullMQ/全库积压及错误零共同核。
整链前暂停真实timer_scan并等待屏障，原held断言后才恢复；七段、20集、单上传、
30秒观察与业务实钟不变。API桥只观察，不能用controller直接调用handler替代旧版。
文件与签读用本轮MinIO；codec、备份进程/备份对象、SMS是明确外部IO替身。
这不证明生产dist健康、真实云处理、备份恢复或短信送达。

## 旧 OpenAPI reader

只读本版提交的merchant/admin/portal OpenAPI，枚举全部无路径参数GET（当前89），
六个必填query用正式字典、实际店、北京时间年份、搜索词和真实HTTP邀请令牌。
邀请经正式创建，读取后正式撤回；不是SQL假行。未来新增未知必填输入直接失败，
不省略接口。真实跨版admin口令/MFA、商家phoneLogin重登；不复用上版headers。
本轮7个ID映射可用详情，并复读已成功observedReads对应的真实详情；
没有对应GET的merchantUserId/sampleId不捏造路径，样片沿orderItemId读取。
所有计划读均要求200；5xx、404、未知路径或未完成失败，不能把权限拒绝记授权成功。

3个纯聚合覆盖协议边界、实际OpenAPI/query/详情计划及诊断脱敏，首次3/3通过
（3.39秒/tests26ms）；随后补EOF取消断言，只复验受影响纯组。
类型与独立进程实际运输尚待调度；不重复完整20集单链，留给后继双SHA四步一次验证。
