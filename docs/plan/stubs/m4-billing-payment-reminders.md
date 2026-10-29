# 付款提醒查询

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | 提醒查询 R1 |
| 骨架里的做法 | 原M1不登记billing提醒查询，走既有空端口，不增加提醒副作用 |
| 登记的工作包 | W1-11b，PR 待填写 |
| 回补里程碑 | M4 |
| 回补的工作包 | W4-05（PR #143） |
| 依据 | W1-11b 第 2、5、7、10 节；开发计划第 7.3 节留桩清单 |

2026-10-27从actual main `726ac1d0`核对：W4-05的PR #143合入提交`9fe07804`已在当前主干祖先链，本桩R1查询及实际消费代码已回补。

`packages/services/src/billing/subscription/reminders.ts`按真实止日节点查询，复核退款与后续周期；`billing/register.ts`正式登记R1的targets/revalidate。`notify/reminders.ts`在原扫描中读取并重核R1，再交原renewal通知规则；手动催办经实际`admin.subscriptionTerm.remind`写去重记录，原通知消费发送前再次核验，不在账户事务内外呼。

原真实DB/HTTP证据见[W4-05状态](../status/W4-05.md)：`subscription/lifecycle.test.ts`覆盖期限节点、只读零写及预约后失效，`apps/api/test/billing-subscriptions.test.ts`覆盖四个真实HTTP资源、同日去重、同键重放与持久GET。本次仅核实代码、入库证据及合流，不重跑历史目标；真实云、商户资金及消息送达仍未验，不将本地通知记录或假外呼当作真实送达。
