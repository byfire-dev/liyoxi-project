# W2-10 建档首页真实成员摘要

| 项 | 内容 |
| --- | --- |
| 改了什么 | 建档首页四项 members 摘要接 Tenant 真实同事务只读公口。 |
| 原因 | 回补原 M2 成员摘要留桩，保持老板/店员既有响应裁剪。 |
| 影响的包 | W2-10；不改变整包依赖、里程碑、路由或其他留桩。 |
| 类别 | 顺序 |
| PR | 本地 codex/w2-10-profile-overview-members，正式审查后正常合本地 main。 |

从实际已接纳 main 8e7d679c 开工，未借用尚未接纳的门店创建候选。

## 范围

Tenant 读口只消费调用方 Tx、entityId/storeId 与业务 now，不自开事务或外呼。
单条 tagged SQL 使成员计数、邀请计数和预览共用语句快照。
老板称呼只来自有效 entity_member.display_name，不回落账号、手机号或默认文案。
本店有效 clerk 才计入；老板不依赖 store_member，不占店员数。
保留有效主体下老板读取 by_owner 归档门店的既有能力；其他终止范围安全拒绝。
预览老板优先，其余按成员 createdAt/id 稳定排序，至多三人。
pending 邀请只有 expiresAt>now 才占额；已分享和未分享相同，GET 不写过期状态。
Profile 在原 Tx 内将同一 now 传给既有事实读取与 Tenant 摘要。
店员仍仅三项摘要和两键预览，不泄露邀请、手机号、账号或成员内部标识。
不新增 HTTP/DTO/DDL/事件/端口登记/锁或写操作，其他首页字段原行为保持。

## 验收安排

SOURCE 阶段仅 AST、所属格式/lint 和正常 hooks；未执行类型、测试或正式生成。
原 API profile 整叶唯一 clerkCount 0→1 反映既有真实店员前提，提供完整反向证明。
其余三十原整叶、官方派生和 clerk 黄金严格保留；原期限与轮次不改。
非生成新增≤350、测试/support新增≤1300，唯一 ROOT 正式审查300秒。
完整新旧整叶、services/API/worker类型和必要官方尾链等独占授权后执行。
完整 W2-10 仍进行中；远端 CI、真实平台、云能力和生产容量未验。
