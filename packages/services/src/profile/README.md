# 商家档案与首店资质（W1-08a）

本段交付商家十三条 API 与进程内核心，后台六条仍由 W1-08b 在 a 合并后交。依据任务书第 2、9、10 节，M1 只做首店 `initial`，含非终局驳回后的补传、重新送审。

qualification 审批类型在 a 登记既定权限与决定 operationId；六条后台处理器在 b 才挂载，当前仍按未落地接口计。类型没有专用 `handlerOf`，审批队列沿既有门店数据范围回退规则。W1-09 此时只能交小程序六页，后台页面必须等 b 合入 main；审批队列的动作登记不代表决定路由已经可调用。

`createProfile` 从事务入口、时钟、tenant、approval、media、事件、密钥环与微信能力装配。API 在 `apps/api/src/merchant/services.ts` 最小接线；模块登记由组合根加载，API 和 worker 都能看到 qualification 审批类型、四种文件引用与九项不变量。没有改兄弟 factory 或 runtime 的既有行为。

- 阅读顺序：共享 `profileCompleteness` 与契约 → `repo.ts` / `views.ts` → `service.ts` / `write.ts` → `draft.ts` / `documents.ts` → `submit.ts` / `qualification-kind.ts` → `gate.ts` / `assign-manager.ts` → `register.ts` / `invariants.ts`。
- 基础、服务、联系人保存复用 ThreePhaseRunner：只读 claim、事务外 `wechat.checkText`、settle 锁行重读版本与守卫。done 重放不检测；不可用拒收，业务表不变。当前会话 raw openid 只在该外呼使用，不进响应、审计或日志。
- GET 现算完整度、不写缓存。写事务末尾同步缓存三列。`assertProfileComplete` 只查前三步，资质提交查四步；`storeGate` 为 full / parallel / blocked；`industryOpen` 按当前行业、品类和区域开放值读取，历史停用字典仍能显示名称和保留。
- 明文解密集中在仓储；联系人登录号按源列 AAD 解开后按目标列重新加密。DTO 只回 mask。审计公开门店电话以 `publicContactNumber` 记，避免被手机号键词误遮；敏感键规则没改。
- 文件经真实 media.link/release。先锁完整文件集合再逐项重入；资格草稿替换保留7天，档案引用替换保留30天。DTO 入幂等记录时 URL 均空，首响应与 GET 在事务后签发（含视频封面），done 重放不重新签。
- 提交锁轮次65→主体100→门店130→档案135；决定由 approval 先锁员工20、审批30，再进入领域回调。tenant 写门店/主体状态与认证字段；审批、资格、租户三条链与事件同事务。认证唯一冲突只在保存点认 `uq_entity_uscc_bidx_verified`，并发失败方保持在审。
- 首次指派经理核心收 Tx：员工共享锁20→门店130；员工停用、角色与接收范围有独立错误原因；两个下游端口和门店更新同事务。W1-15 回补 `orderManagerPort`，W1-16a 回补 `deliveryManagerPort`。

M2/M3 规定留桩、首页三个聚合与两项 M1 写端口均在 `docs/plan/stubs/`。`profile.I7` 的检查、自愈与资质通过订阅者在 M2；已登记 I1–I6、I8–I10，其中 I6 同事务修正三列并返回 healed。I1 真库反例夹具只在测试会话独立库内暂时移除两索引、强制事务回滚，随后核对索引恢复及正常唯一约束；迁移与共享库不变。

API 的响应沿既有 `respondByRole` 以本请求会员角色裁剪，写路由的店员能力统一拒绝。clerk 样例追加全部十三条，旧黄金不改；A86 的服务现价与原价按现有完整路径登记例外。卖点 `sellingPoints` 与 C57 键扫描词冲突由调度单独 gate-change 收口，本业务包不放松扫描逻辑。
