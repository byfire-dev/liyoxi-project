# 员工激活码短信

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | admin.staff.create 的激活码短信下发 |
| 骨架里的做法 | 无论 `activationDelivery` 请求值都按 `manual` 生成，首次响应返回 8 位明文，幂等记录保存前置空，重放返回 `null` 与 `replayed=true`；不调用短信通道 |
| 登记的工作包 | W1-01b |
| 回补里程碑 | M2（G2-A；真实短信驱动随 G2-D） |
| 回补的工作包 | W2-03；实际 W2-17/W2-22 已合主线后由 L4 实例注入通知端口 |
| 依据 | 开发计划 第 7.3 节“微信登录、手机号组件、短信”；W1-01b 任务书 第 2、7、9 节；a01 第 3.14 节 |

W2-03 在业务提交后通过真实实例通知端口下发，staff 不同层导入 notify。新增、补发与安全重置沿原 8 位字母数字、24 小时协议，幂等持久化与重放明文仍为 null。腾讯官方验证码模板只接受至多 6 位数字时，驱动在外呼前受控拒绝，员工用例明确手动回退，不改激活码协议、不宣称短信到达。

代码与真实本地证据：[管理服务](../../../packages/services/src/staff/manage-full.ts)、[管理用例](../../../packages/services/src/staff/management-full.db.test.ts)、[HTTP 用例](../../../apps/api/test/staff-full.test.ts)；通知借用者在 runtime 与 ops/worker 的本 scope 装配。功能回补已真实验证，最终构建、门禁及独立审查仍见 [W2-03 状态](../status/W2-03.md)，真实签名/模板报备和发送到达未验。
