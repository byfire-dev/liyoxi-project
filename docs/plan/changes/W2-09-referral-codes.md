# W2-09 渠道码管理与整包收口

| 项 | 内容 |
| --- | --- |
| 改了什么 | 四条既有Meta转真实Route/DTO与薄路由，identity按当前员工会话及实时权限接入渠道码管理并收口W2-09 |
| 原因 | 由tenant公开同Tx登记与状态公口，统一码命名空间并以真实登录验证归因，不回溯改写旧来源或快照 |
| 影响的包 | W2-09渠道码分片及tenant必要公开函数；W3-06甲类互斥机制另片 |
| 类别 | 拆并（同包分片） |
| PR | — |

- 四条既有Meta转真实Route/DTO/薄路由，identity复用当前员工会话与实时权限，幂等缓存前仍鉴权，global资源不按门店scope过滤。
- 表归tenant（02§2.14/M6），最小新增list/create/setStatus同Tx公开函数与index导出，staff20升序共享锁后核sales有效归属；无新port/DDL/白名单。
- 大写4–16码共用唯一命名空间，V1.0只创建sales/campaign；状态CAS、disabledAt与内部版本、ops审计同Tx，不造状态迁移或事件。
- 统计现算；新增真实登录用例消费正式登记码，保留邀请码优先、停用fallback与enable不回溯归因，旧来源/快照不改。
- 6DB+4HTTP小量风险组，作者轻格式/lint正常hooks；ROOT单lane验收、独审及官方派生。20接口/1订阅/2休眠分支/retention/不变量事实收口写当前状态，外部未验独立列明，W306甲机制另片。
