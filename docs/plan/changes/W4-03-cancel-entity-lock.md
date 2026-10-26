# W4-03 取消付款单的主体读锁修复

| 项 | 内容 |
| --- | --- |
| 改了什么 | 将 W4-03 取消与入账的锁竞争修复独立前置到 M4 财务页面收尾之前；只将取消路径主体预条件排他锁改为既有共享读锁，不改变接口、页面、包数或里程碑退出条件。 |
| 原因 | 原三入口竞争目标出现 cancel BUSY；实际源存在主体排他锁与入账子表外键检查的反向等待，须消除机制而非放宽原成功判据。 |
| 影响的包 | W4-03：1处生产改动、原真实HTTP目标安全诊断；后继 M4 财务验收继续复用原契约，依赖与级别不变。 |
| 类别 | 顺序 |
| PR | — |
| 依据 | 06 第5节锁序、07 商家计费接口取消/同步契约、`docs/plan/local-development-validation.md`；ROOT 明确授权的独立窄修，基线 `361e9471`。 |

ROOT 授权本片从 `361e9471` 独立交付。生产只改 `wechat-channel.ts` 的 `visible(locked)`：主体预条件使用现有 `share` 模式，付款单仍用排他锁，claim/settle 的身份、成员关系与当前状态重查、三阶段及公共锁序/超时/重试常量不变，不修改 prepay 相似路径。

已确认的机制是：取消事务先持有主体 `FOR UPDATE` 再等待付款单；入账持有付款单后插入订阅或差异行，主体外键检查可能反向等待主体。此处只读取主体生命周期与归属，没有主体写入或锁升级；`FOR SHARE` 继续阻止主体改删，同时允许外键检查的 `KEY SHARE`，消除该反向等待。

PR150 `db00d3c5` 的 `test-isolation-2` 在原竞争目标第352行失败，实际为 cancel 的503 BUSY；此前回调空200 ACK和 sync 的 paid/done 已通过。所给日志在失败请求 UUIDv7 对应时刻之后记录了同PID的两次相关死锁，与内核重试一次后耗尽相符；但没有 requestId 与数据库PID映射，不能将该次CI失败的唯一因果写为已证实，也不能称三轮全部验收已通过。

原真实HTTP竞争目标保留三轮、三入口屏障、全部200/资金/履约/事件唯一性及全表重放断言。仅在非200时补入口状态、请求ID及现有错误日志的固定错误码/类别诊断，不输出正文、原错误消息、栈、签名或个人资料；Pino折叠原cause，诊断不承诺总能还原SQLSTATE。

源码 `59d921ff` 已由 ROOT 完成唯一独审，无未处理阻断。旧工作树仍指向 Zod4.6.5，先按当前锁执行离线 frozen 安装，2秒恢复至4.6.6，6包复用、0下载，manifest/lock均未改。

首次命令的 `LYX_TEST_SESSION=m4cancelentitylock` 超过1–12字符限制，被全局前置拒绝，业务目标0执行；保留该 RED，未修改会话守卫。仅将实参改为合法 `m4cnlk1` 后，原 `billing-channel-concurrency.test.ts` 的唯一真实HTTP目标首次业务验证1/1 G，耗时17.39秒（业务11.99秒），原三轮、全部断言与超时不变。使用Node24、原本地5442/6389/0和单worker，未重跑其他资金集。真实渠道/服务器不在本片验收范围。

| 命令 | 本机结果 |
| --- | --- |
| `pnpm exec vitest run --project api apps/api/test/billing-channel-concurrency.test.ts --maxWorkers=1 --no-file-parallelism`（合法独立session `m4cnlk1`） | 1/1 G；三轮真实屏障、各入口200及唯一事实/重放断言全部通过。 |
| `pnpm --filter @liyoxi/services typecheck` | 首次 G，无类型诊断。 |
| `pnpm --filter @liyoxi/api typecheck` | 首次 G，无类型诊断。 |

生产与测试固定后仅补本说明的模板表及实际验证结果，未再修改已审源码。独立前置可交 ROOT 本地合流，CI及最终发布状态仍由调度按实际结果记录。
