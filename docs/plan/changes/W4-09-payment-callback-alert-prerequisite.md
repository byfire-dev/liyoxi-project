# W4-09 支付回调首错告警独立前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 在原HTTP最终响应事实与AlertFacts之间补独立首错P1观察，交易/退款回调最终非2xx且非SIGNTEST时告警 |
| 原因 | 既有收件重处理、验签和解密告警不能替代开发计划第6.7节退出⑧及D7第9.4节要求的最终响应首错事实 |
| 影响的包 | W4-09；其它资金告警保留W2-24/W4-11原归属，不改原预算或外部验收责任 |
| 类别 | 调度批准的独立告警窄前置；不改里程碑、退出条件或门禁 |
| PR | — |

## 依据与事实

调度批准本片仅补开发计划08第6.7节退出⑧、D7第9.4节规则1。规则要求交易/退款回调最终返回非2xx且非签名探测时，五分钟内至少一次即P1。03第1.4节、h01第2.1–2.2节要求事实或兜底收件已持久化就应答200，因此内部处理失败、收件积压与路由失败不能互代。

actual main的`webhook.failing`第5次、`webhook.dead`第8次针对收件重处理；来源验签失败的既有P2/解密P1也不能覆盖未启用404、限流429或最终持久化失败。保留这些原语义与全部退避/预算，只增独立HTTP响应事实。其他四类资金告警复用W2-24/W4-11归属证据，不重复验收。

## 范围与边界

从`0217ef20`新建`codex/m4-callback-alert`，实施前普通同步已包含CLI的main `8fccef1f`。不改里程碑、退出条件、契约/DDL、Provider、kernel、框架顺序、依赖或门禁。

允许叶文件为`apps/api/src/http/webhook.ts`、`packages/services/src/security/webhooks/types.ts`及`runtime.ts`、`packages/services/src/ops/alert-rules.ts`、`apps/api/test/payment-callback-alerts.test.ts`、security README、本变更记录、W4-09状态和runbook规则1；不外扩目录。

既有签名槽位在`await next()`之后且`c.finalized`为真才传最终状态；不用finally读取默认状态。Hono实际compose先在下游捕获错误、设置响应，再回到上层；原webhookRateLimit随后按渠道协议替换响应，外层观察才执行。服务只接受两个正式operationId，SIGNTEST按h01与现有密码学驱动同一前缀分类（包括验签前拒绝），其余非2xx立即交`billing.callback_failed:<operationId>` P1。

调用沿既有AlertFacts独立事务及在途关闭排空，不等待额外数据库写，不延长原ACK预算。同步抛错/异步拒绝均不覆盖原应答。持久详情只含provider、operationId、httpStatus、reqId；签名和正文只在原处理内存中，不进新详情。告警通知、静默恢复及生命周期仍归既有writer/dispatcher，本片不新增循环、计数表或发送器。

## 定点验证与结果

四个真实Hono路由目标在`apps/api/test/payment-callback-alerts.test.ts`，使用真实密码学与实际AlertFacts落库，只有渠道材料为公开假值：

1. 交易/退款坏签名与有效签名超期401：首次P1，保留原验签P2，无收件与资金写。
2. 两路SIGNTEST，包括未知serial、缺头及未启用404：照旧拒绝，全部告警零增量。
3. 两路未配置404与真实验签成功但GCM解密失败500：首错P1，零收件/资金事实，详情去敏。
4. 合法待付款单及可信替身通知，另一真实PG会话持付款单锁触发原2秒锁超时：T1失败、T1′成功持久化failed/attempts=1且返回200，释放锁后同通知走实际入账履约；两次均不触发新规则。

目标命令：`pnpm --filter @liyoxi/api exec vitest run test/payment-callback-alerts.test.ts --maxWorkers=1 --no-file-parallelism`。请求后用所属runtime.close排空既有writer，再从独立测试DB断言持久事实。

生产`98a6e510`与测试夹具`016dfc8a`已由ROOT唯一独审，无P1/P2阻断。Node24.20.0、session=`w409cb1`、单worker/不并行文件下，首个实际业务轮4/4绿（测试7.65秒、总13.48秒）；services/API类型各首次通过，正式depcheck一次4384模块/23521依赖零违规。未改业务、预算或原断言，不重复未受影响的已绿集。

准备错误如实保留：首个启动给出的session=`w409callback1`超过现有1–12位守卫，在0test退出，没有执行用例或创建该session测试库。随后改合法短名；复用工作树的忽略client存在但缺当前shipping字段，经官方`pnpm db:generate`恢复一次当前schema产物，不改tracked文件。唯一重槽已释放，成功目标由测试支架收自有库，没有失败库需清理。本片轻格式/lint/diff与正常中文hooks通过；不执行额外全包构建、契约或登记生成。

真实微信/账号/资金、服务器、密钥和E18接收群均未验，不据本片宣布W4-09或M4完成。
