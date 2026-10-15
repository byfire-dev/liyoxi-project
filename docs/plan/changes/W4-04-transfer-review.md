# W4-04 线下收款与复核接线

| 项 | 内容 |
| --- | --- |
| 改了什么 | 四个 typed 后台写接口；复用唯一 applyPayment 的两人复核、凭证 SLA/日历与真实详情；既有 s.finance_overdue 只接 transfer 单事件及 finance 受众/当前到期复核。 |
| 原因 | W3-16 实际仅交资质 OCR；本包另需回单能力；原入账没有正式 approve_review 迁移，重放也须复核对象范围。 |
| 影响的包 | W4-04；新增 payment/transfer-admin.ts 与 transfer-review.schemas.ts，必要 apply.ts/machines.ts/purchase-read 与 notify 三叶伴随；media/Provider 独立前置。无 DDL/kernel/锁序/旧测试/新依赖修改。 |
| 类别 | 范围、顺序 |
| PR | 本地 codex/w4-04-transfer-review；ROOT 唯一审查/串行重验与远端操作。 |
| 验证 | 当前仅轻格式/lint/diff；类型、DB/HTTP与官方生成待 ROOT。新四口是只读预检加唯一幂等业务 TX，没有外呼，不标 C51 三段式。 |

2026-10-16：actual 基线 `09894fd3`，共享开单部分已普通同步已合 W4-06 的 `97dce83b`，保留其加购分支；W4-05 后续沿同一个报价器扩展。当前实现仍在途，未完成独立审查或业务验收。默认复核阈值为 null、未配置 OCR 保持 unavailable，真实资金/云识别/业主配置不在本机证据内。

调度批准 a07 正式轮次勘误：两复核动作均携 `approvalId`，锁内绑定凭证当前指针与审批 kind/subject/round，approve 保审批 lockVersion。退回重提后新审批版本同为 0，原只传凭证 ID/版本无法识别旧面板；不改变审批框架或 DDL。

已同步回单OCR actual `ec16f048`：只从media正式公口消费enqueue/脱敏read及严格完成载荷，job归属检查留所属media，billing不私查media_job/OCR原值；当前pending指针与file/entity再核，缓存ok立即重算，新/重复事件相同结论零更新。此前c658阶段未接OCR事实保留，当前源码待独审与小量验收，仍不宣称完成。
