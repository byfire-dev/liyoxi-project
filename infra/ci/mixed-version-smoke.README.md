# W2-28 四步真实HTTP/worker混跑

这是测试执行器，不是部署入口。每个SHA都从自己的git archive构建server的build target，保对应版API、服务、契约与worker源码；再仅从实际image ID创建不启动、无网络的自有临时容器，复制唯一40位SHA文本到`/repo/.mixed-source-sha`后commit薄层，并核实际Parent等于原image ID。driver读取固定文件核身份，不能仅反射请求version；不挂HEAD源码到旧版。测试层不进入正式server镜像。

```sh
node infra/ci/mixed-version-smoke.mjs --report /tmp/mixed-smoke-本轮.json
node infra/ci/mixed-version-smoke.mjs --prev <40位祖先提交SHA> --report /tmp/mixed-smoke-另一轮.json
```

HEAD固定为脚本所在检出的当前提交。默认prev取第一父所能到达的最近`v[0-9]*`标签；没有标签时取第一父，仅报告bootstrap，源变化计数不能当已发布版本兼容。显式prev只收完整祖先SHA。HEAD缺构建定义或两版缺driver均失败；仅无祖先或旧版缺server Dockerfile可记no-comparable，不把缺测试能力/构建失败写成跳过。无可比版本仍实际执行HEAD构建、迁移播种、完整主链、排空和关闭清理，全部成功才记no-comparable。源/driver能力在创建资源前核对。

`--report`须为新JSON文件，拒绝覆盖已有文件及用户符号链接目录；macOS固定`/tmp→/private/tmp`、`/var→/private/var`系统别名可用。报告0600、原子更新，只含来源、镜像ID/driver hash、阶段/PID、真实worker租约及排空事实、operationId/status和清理布尔。失败只固定阶段/错误码；read_failed仅可附已选旧spec的安全operationId，无URL/query、原始错误、猜测HTTP状态。私有RPC、密码/MFA、scope ownerToken、headers/access和readSpec不进报告或日志。

## 本地前置与所有权

只接受本机Unix Docker context，以及既有local.yml的`liyoxi`项目、固定`lyx-postgres/lyx-redis/lyx-minio`三healthy服务。执行器不启动、停止、删除这些共享服务/卷，不运行compose up/down、pull或prune。独占重资源位后才运行真实构建；冷依赖或构建耗时不能通过延长预算解决。CI可由独立工作流先启动自己独占的同名依赖，本机不能照抄CI的down清理。

执行器创建随机internal私网，只把已核ID的三依赖连接为本轮固定alias；ownerNetwork严格收据绑定runId/source/nonce/networkId及三个ID，地址/端口从runId派生。HEAD owner实际迁移/播种自己的随机库、Redis前缀和四桶，持续持有资源；各phase只attach。默认M1及数据库全局localhost规则不变。

## 四步

1. HEAD owner创建并持有本轮资源，返回私有attach能力。
2. HEAD API主进程fork自身源码worker为独立Node进程；完整20集/并发1真实HTTP主链A，正式队列/租约处理并排空后关闭。
3. 旧版API/自身workerattach同资源，真实重新登录并读取HEAD结果，再用独立身份/业务对象跑完整20集主链B；排空并关闭旧进程。
4. 新HEAD API/自身worker读取旧版结果，再排空关闭；HEAD owner清库/前缀/四桶，最后撤本轮网络membership和自有镜像tag/归档目录。

每次必须实际API/worker PID不同、worker持有同版租约、错误为0；排空同时核数据库pending/dead/media submitted等事实与真实队列等待/active/failed，不直接tick/consume/jobs.run。旧不认识的类型由对应版driver按自身登记拒绝，未来合法timer不冒认积压。phase.close只证明真实worker childclose0和bridge关闭；owner.close成功后才记数据库不存在/全前缀SCAN0及四桶HEAD404，不虚构leaseReleased或清理计数。

旧读清单来自旧SHA自身三份OpenAPI。返回的私有完整GET readSpec带旧source，第四步绑定previousSource重放同清单；无path参数集合逐项成功与清单精确对照，详情属于完整旧清单并用真实对象ID。必填及组合约束query、邀请token均由本轮合法数据/正式HTTP前置提供，不硬编码当前95条、不随机UUID探路或泛放404。读响应公开只留operationId/200。三phase各声明固定测试代理客户端，原限流不改；显式W228新链起点重置内存观测，保本条链全部成功GET且不混入上一主体的读记录。

## 私有RPC与期限

固定`w228-rpc-v1` JSONL，每条≤1MiB、单请求在途、正整数id一致；stdout噪声/乱序/额外字段失败。方法只owner.init/close和phase.start/chain/read/drain/close，CLI模式只owner/phase，固定Node/既有tsx/本版driver路径，不收任意命令或端点。worker内部沿原IPC，无第二套调度机制。协议字段双方核对稿由调度保留，不在公开artifact保存私有消息。

本地总上限600秒包含两次顺序构建和全部清理；工作到540秒即停止，预留60秒清理。driver每次观察原30秒上限保持，两个完整链不缩集数。SIGTERM/SIGINT先保存失败白名单报告、取消在途RPC/命令，再尽力精确收尾；外层CI可施加更紧的8分钟TERM/30秒KILL，不能把被强杀前尚未证实的清理写成通过。任何阶段或清理失败均非零，没有自动重试。

## 当前验证边界

新增五纯聚合和infra类型已有绿色记录；版本定义例外、私有协议/安全read_failed、旧spec传递和报告路径点修只重跑受影响聚合。ROOT唯一源码审查54.173秒，no-comparable提前跳过HEAD的P2已定点关闭；后续窄差分逐点核对。最初lint prefer-const与macOS系统临时目录别名误拒保留。工作流/同SHA发布gate由独立分支交付，未访问GitHub或部署。

首次真实演练在68.516秒于薄层构建失败：Dockerfile将`FROM sha256:<config image ID>`解析为仓库名；HEAD build target本身完成。改为精确ID的create/cp/commit，保唯一身份文本和父镜像核验；原失败报告与共享依赖保全、未创建owner的清理事实保留，尚不算整轮通过。

2026-10-16，[第8轮正式报告](../../outputs/m2/w228-mixed-20261016-8.json)首次完整通过，用时226.757秒（含构建与清理）。HEAD `ddf558d264390faa45406c3e54708a6f93f888a9`、显式prev `a914c90a95a0d9a60ebd9d464ae2ca0c8ec8f5ab`各由自身归档构建；两条20集链最终live/live/in_service/isLive，各123项不变量零错误/违规。OLD读95列表/52详情，最后HEAD严格旧spec读95列表/47详情，全部200；三phase真实worker租约、全库积压/错误与五队列零、childclose0和bridge关闭均通过。owner实际DB不存在/前缀SCAN0/四桶HEAD404、共享依赖保全与总体cleanup均true，无自有容器残留。

前七轮RED不覆盖：第5轮OLD首后台登录429，HEAD激活/重登已用满同IP档位；第6轮163.912秒止于跟进列表空query，纯canonical检查同时发现素材列表组合scope；第7轮226.072秒两条业务链均绿，最后复读混入前一主体观测路径而失败，未采该次HTTP状态。分别仅修固定测试客户端、真实scope参数和chain内存观测起点，原全集合/200/20集/123/30秒/600秒判据均保持。

本次`productionChangedFiles=0`，是本地同生产源码的bootstrap装配与运输证据，未证明在役`v*`标签兼容、远端main工作流或真实云IO。D7-19仅混跑本地半项到位，删列三步/CHECK替换迁移演练未验，整项不关闭。
