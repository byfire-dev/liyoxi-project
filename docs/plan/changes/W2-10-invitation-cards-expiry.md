# W2-10 邀请卡片与到期实施边界

| 项 | 内容 |
| --- | --- |
| 改了什么 | 同片交 create、markShared、revoke、lookup 四个正式 HTTP 与 invitation.expire。 |
| 原因 | 已合请求映射可保证 A/B 强网络重试，卡片与真实到期任务需要共同证明事务和竞争。 |
| 影响的包 | W2-10 原主包，编号、接口归属、里程碑与整包下游等待不变。 |
| 类别 | 顺序 |
| PR | codex/w2-10-invitation-cards-expiry；完整验收后正常合入本地 main。 |

从实际 main `1e76839c` 开工，无新 DDL、依赖、通用机制、锁表、门禁或中央鉴权变化。

## 完整边界

- 自然三段式：只读 claim、事务外真实会话内容检测、settle 完整低序预锁与重读；无响应缓存。
- 请求 A 创建、B 复用各写永久映射，原创建键保留；share 后 B 同键仍回原卡且零写。
- 同键库 pending 回原 token/期限，即使业务时间已过；lookup 只派生 expired。库终态拒绝，不续期或新建。
- 新意图只复用同店/同邀请人有效未分享卡；缺省不改、null 清空。客户端键为独立小写通用 UUID。
- 原成员权限、名额、上海日界与活动参数；required 分享/撤回，撤回同 Tx 清密文、历史/审计/事件及取消任务。
- expiry 在主体100→邀请110锁后 fresh clock，早到抛错沿原失败短 Tx/backoff；终态或不存在才 skipped。
- dispatched 复用取消后重新 arm；真实两连接证明旧 finish/fail 不改新 scheduled、回滚不丢旧任务。
- API/worker 各自 attach/close，真实消费者 drain 后解绑。四响应严格裁剪、匿名 lookup 九字段且零写。

接受邀请、空草稿让位、joined 通知、非空 invitationId 通知、I30 自愈、其他 W2-10 入口不在本片。

## 验证与合流

手写 nonTest 新增≤1450、全部新测试/fixture/clerk 样例新增≤2500，官方生成另列。
SOURCE 只运行 owned AST/格式/lint 与正常提交；当前不宣称类型、测试、数据库或官方生成通过。
实际主干普通同步后，独占官方 contract:generate 与整叶 clerk:snapshot，核旧黄金不变并正常提交。
再冻结完整源码/runtime，单 worker、无文件并行/缓存、原期限执行 fresh 必要类型、新旧 wholefiles 与完整尾链。
54 个旧 whole 目标正文/断言保持，独占自有资源精确归零后，ROOT 唯一300秒正式审查并即时合本地 main。
真实云、远端 CI、微信实际发送及生产容量不计入验收，完整 W2-10 仍进行中。
