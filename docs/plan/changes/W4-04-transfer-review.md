# W4-04 线下收款与复核接线

| 项 | 内容 |
| --- | --- |
| 改了什么 | 四个 typed 后台写接口；复用唯一 applyPayment 的两人复核、凭证 SLA/日历与真实详情；既有 s.finance_overdue 只接 transfer 单事件及 finance 受众/当前到期复核。 |
| 原因 | W3-16 实际仅交资质 OCR；本包另需回单能力；原入账没有正式 approve_review 迁移，重放也须复核对象范围。 |
| 影响的包 | W4-04；新增 payment/transfer-admin.ts 与 transfer-review.schemas.ts，必要 apply.ts/machines.ts/purchase-read 与 notify 三叶伴随；media/Provider 独立前置。无 DDL/kernel/锁序/旧测试/新依赖修改。 |
| 类别 | 范围、顺序 |
| PR | 本地 codex/w4-04-transfer-review；ROOT 唯一审查/串行重验与远端操作。 |
| 验证 | 新6DB+2HTTP分轮全部通过，services/API类型明确exit0、官方生成/对账与权限矩阵/挂载、depcheck通过；唯一审查及定点闭环已完成。新四口是只读预检加唯一幂等业务 TX，没有外呼，不标 C51 三段式。 |

2026-10-16：actual 基线 `09894fd3`，共享开单部分已普通同步已合 W4-06 的 `97dce83b`，保留其加购分支；W4-05 后续沿同一个报价器扩展。当前实现仍在途，未完成独立审查或业务验收。默认复核阈值为 null、未配置 OCR 保持 unavailable，真实资金/云识别/业主配置不在本机证据内。

调度批准 a07 正式轮次勘误：两复核动作均携 `approvalId`，锁内绑定凭证当前指针与审批 kind/subject/round，approve 保审批 lockVersion。退回重提后新审批版本同为 0，原只传凭证 ID/版本无法识别旧面板；不改变审批框架或 DDL。

已同步回单OCR actual `ec16f048`：只从media正式公口消费enqueue/脱敏read及严格完成载荷，job归属检查留所属media，billing不私查media_job/OCR原值；当前pending指针与file/entity再核，缓存ok立即重算，新/重复事件相同结论零更新。此前c658阶段未接OCR事实保留，当前源码待独审与小量验收，仍不宣称完成。

小量验收现已5DB+2HTTP聚合通过；唯一源码审查发现的WebP兼容P2已窄修并有配置/未配实测。第6DB保留真实approval.I1历史轮反指RED，待独立前置，不通过改产品重提流程或删除不变量换绿。类型/夹具首R与后续定点复验分别见本包状态；未提前回补两桩或标整包完成。

最终同步actual `d1a281fc` 后，仅重验历史轮原红组G，累计6DB+2HTTP及必要门禁通过，所属两桩回补。调度批准两项查实伴随：官方权限矩阵14行纯新增（本包4、主干旧漏10，旧行不变）；已合测试夹具wechatOrderAttach私引改走billing纯公口。前者按真实gate-touch分类登记，不冒称0门禁；后者不改算法/层级规则。首R历史保留，exact自有失败库/Redis已清零；真实云与资金未验。
