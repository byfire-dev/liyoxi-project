# W3-15 模型预算账本只读诊断

| 项 | 内容 |
| --- | --- |
| 改了什么 | 新增正式固定key的只读inspector、独立CLI及受控采样摘要。 |
| 原因 | 冷HASH/损坏/期限水位需诊断，不能自动创建或把token当当前业务许可。 |
| 影响的包 | packages/services 的ops、scripts和media文档；运维手册。 |
| 类别 | 实现细化。 |
| PR | 本地开发分支，尚未建立PR。 |

基于已接受本地main `dd86516cab9bd0c73b110142e74424e0b3916723`。
正式AppEnv逐字绑定 `lyx:${appEnv}:model_budget:v1`，没有URL/key/prefix/day覆盖或写模式。
导入/check不读环境或连接；inspect沿现有loadEnv规则，PG外只读有限Lua并关闭自有连接。
输出分离元字段/采样/时钟/closedBefore与期限扣留历史，不包含正文、标识符或凭据。

当前SOURCE只做轻AST/格式/lint，两个新整叶和八个旧整叶258静态候选尚未执行。
不改原ledger/owners/runtime/Env规则/DDL，默认关闭与全部旧断言/期限保持。
初始化、丢状态恢复、退款、任意清除、自动开通、真实环境诊断/容量/E22均未交付。
