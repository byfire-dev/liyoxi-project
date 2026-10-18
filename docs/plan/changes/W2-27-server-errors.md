# W2-27：服务端自身错误出口

| 项 | 内容 |
| --- | --- |
| 改了什么 | 独立SERVER_ERRORS_FILE；API/worker自身安全错误信封复用原有界transport，接入5xx、任务异常及fatal关闭。 |
| 原因 | D7§9.2要求服务端直连上游，当前两进程只有日志；客户端map匹配完成后仍缺这一真实消费。 |
| 影响的包 | W2-27、W2-29；调度批准ops内部提取/工厂、环境解析/角色overlay及API/worker最小入口伴随，约700行非测试预算（原transport移动单列），最多五新聚合。 |
| 类别 | 范围、顺序 |
| PR | 本地codex/w2-27-server-errors，ROOT唯一独审/调度验证及远端操作。 |

保原200队列/并发2/2秒/5次10秒熔断60秒、无重试/close，客户端不能提交服务端帧。只固定组件自有dist文件、安全摘要与标签；不传原始stack/cause/details/请求或SQL。已持久化retry/dead/failed只报固定摘要，不更改事务/状态结果；fatal最多2秒后仍exit1，不恢复继续运行。

必要旁路只改events/dispatch与timers/scan、run三叶：Redis降级inline会绕过ops外层consume/runTimer包装，因此在原失败短事务提交后回调固定结果；同步抛错和异步拒绝均隔离。runTimer统一观察长任务返回，未修改job-mode租约机制；无外层重复上报。

API/worker只从services正式总出口消费：必要总index追加三函数及对应类型，不绕过ops公口。唯一源码独审无未解决P1/P2/D，同进程计时63.029秒；三包类型与五新聚合的最小验证已通过，API首轮遗漏总出口及运行命令缺APP_ENV的失败事实见状态，未重复绿色旧矩阵。

日志仍为底座，默认未配无请求，不安装SDK/CLI或接触真实凭据。角色overlay的既有门禁若判放松独立后继，不改规则混入。上传、真实SaaS收件/符号化、E18及预发外部验收未完成，portal仍M6。
