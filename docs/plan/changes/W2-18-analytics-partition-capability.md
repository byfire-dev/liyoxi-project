# W2-18 的分区结构能力独立交付

| 项 | 内容 |
| --- | --- |
| 改了什么 | 按 W2-18 任务书第 7 节“分区结构问题另独立迁移包”，先交受限月分区/单月重分区数据库能力；W2-18 服务只在能力实际合入 main 后消费。既有接口、页面、x01 归属与 M2/M3/M4 的 25/19/20 包数、退出条件均不改 |
| 原因 | actual main 的 ensure 是 invoker，真实 lyx_app 缺 CREATE/父表 owner，重分区也没有受限执行口；worker 不应持有迁移口令。落实 ADR-045 已批准的 SECURITY DEFINER 方向 |
| 影响的包 | W2-18；结构包独立迁移、测试和审查，主包仍进行中，HTTP/cron/CLI/外部配置不在此结构包中完成 |
| 类别 | 顺序 |
| PR | 待调度会话填写；本地实现与验证不代表远端 CI 或 actual main 已合入 |

新增迁移 `20261007230600_analytics_partition_capability` 保留原两份迁移与 Prisma schema。将 `public.lyx_14_analytics_event_ensure_partition(date) → text` 改为受限 SECURITY DEFINER，新增 `public.lyx_14_analytics_event_repartition_month(date) → bigint`，PUBLIC 无执行权，仅 lyx_app 可调用；`grants.expected.json` 仅新增这两个 definer 项。表/列权限、角色属性、readonly 缺省授权、门禁与下限清单不改。

两入口只接 0001–9999 年有限公历月首，Shanghai 月界、固定 derived 子表名，固定 `public` 对象与 `pg_catalog` 内置函数，安全 search_path 和 UTC/ISO 表达；9999-12 的内部上界允许 timestamp 年 10000。父表 ACCESS EXCLUSIVE 锁串行建分区。已有同名对象须符合真实 parent/owner/bound、行级 clone 与 statement 防改 trigger 的 OID/类型/启停/参数元数据；错误对象不静默跳过，default 的目标月数据挡建时原样失败。

单月重分区锁 parent/default，拒绝 caller 已有同名 temp，用本次自建且限定 pg_temp 的 LIKE 暂存表保存完整 21 列，临时停用 default 的行级防改 trigger，DELETE RETURNING 后严格 ensure，INSERT 父表按条数及完整行 EXCEPT ALL 检验，恢复 trigger 并仅删除自建 temp。任何异常、恢复不一致或外层回滚都恢复 DDL/数据/trigger；dedup、identity、其他月不改，不吞错误。该自建 temp DROP 的 lyx:allow 理由紧贴语句，动态 DDL 不接受任意对象参数。

数据库只校验结构日期；业务允许月、retention/current+3、CLI 环境授权仍由 W2-18 服务按注入 clock 和原参数执行，不加入数据库 now 业务规则。归档导出、DETACH/DROP、角色和生产环境授权不在此能力范围。ADR-045、正式 14 §2.9 与 DB README 同步此事实；不回改数据库草稿或既有迁移，不新建 worker 迁移凭据桥接。

独立真实隔离库回归覆盖非超级用户 lyx_app、readonly/PUBLIC 拒绝、直接 DDL/改删/清空拒绝、并发重复 ensure、当前/0001/1900/9999 的精确 bound、Shanghai 两端月界及全列/PK/receipt/source 保留、重复重分区 0、错误同名对象/owner/guard、caller temp/public/search_path 影子、恢复异常及行篡改的整体回滚、外层事务回滚。所有数据均为虚构，失败日志保留，生成结构快照使用原脚本；最终命令/退出码由交接记录，远端 CI 与一次独立审查由调度会话后续完成。

2026-10-08 本地收口：结构提交 `46760cf6` 的唯一独立审查已完成，无 P1/P2/D。正常同步本地 main `ffc83f71` 后，八个源码/生成物与原冻结字节一致；正式 14 分组同时保留 main 的通知参数增量及本包分区说明。以单 worker、串行文件运行专项与授权两文件，70/70 项通过（12.56 秒）；原组合 67/69 的失败记录保留。迁移规范与门禁分类通过，仅原工具生成快照一项只增，零放松。该独立结构分支完成后立即合本地 main；业务 job/CLI、归档导出及 DETACH/DROP 仍由后续准确闭环，未据此完成 W2-18 整包或远端 CI。
