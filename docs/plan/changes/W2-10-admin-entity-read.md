# W2-10 后台主体详情与成员列表

| 项 | 内容 |
| --- | --- |
| 改了什么 | 接线 admin.entity.get、admin.entity.member.list 两个既有正式 GET。 |
| 原因 | 后台需要完整主体、门店概要与成员历史，不能用留桩或缺失事实零默认。 |
| 影响的包 | services、contract、api；无 DDL、kernel 端口或后台写入口。 |
| 类别 | 顺序 |
| PR | 本地 codex/w2-10-admin-entity-read，正式审查后正常合本地 main。 |

以实际 main40ae328a 为基线，不消费在途候选能力。
范围来自真实员工上下文与原 entityScope；可见主体返回正式兄弟门店概要，原门店详情权限不变。
API 固定绑定三个已接纳批量事实和原单店订单计数，同 callerTx 读取，不截断数组或新增分页。
额度只调用原 quotaWithSubscription；缺 billing 注册、账户或 Map 覆盖明确 INTERNAL。
pending 只认 expiresAt>now；老板按当前有效成员、历史成员按真实剩余门店关系映射。
素材覆盖主体所有门店，移除不抹历史、采用次数不膨胀条数，软删除排除。
完整 nullable DTO、脱敏字段与真实权限 actions；GET 不作 step-up 或任何业务写入。
READ COMMITTED 多查询不冒称全库单快照，订单按真实单店公口顺序调用。

## 验收安排

四新整叶涵盖本域范围/缺装配、真实拥有者同事务可见及回滚、真实 HTTP、闭集与 PII 负例。
原24整叶/340静态用例及期限保持；旧 contract 仅实际官方生成后申请必要 literal 完整逆变换。
官方生成与后台权限黄金另用独占准备窗口；店员黄金及扫描器不变。
当前只执行所属格式/lint、AST 与正常 hooks；类型、业务、派生和唯一独审尚未执行。
非生成新增≤850、测试/support新增≤2200，唯一 ROOT 正式审查300秒。
完整 W2-10 继续推进，远端 CI、真实云及容量未验。
