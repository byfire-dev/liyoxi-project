# W5-13 工单动作验收 scope 独立门禁前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 受保护 live runner 只把已存在的 W513 fixture.flow.scope 以固定 w513 字段传入原私有运输信封；默认缺 fixture 或 scope 时不新增字段，显式请求本目标却缺 scope 明确失败。 |
| 原因 | W5-13 工单页实际上传/制作验收需要所属本轮 flow scope；runner 已受保护，须在独立 gate-change 实际合入后由业务 PR 同步，不能给业务 PR 加标签掩盖混包。 |
| 影响的包 | W5-13；本前置基于 W5-14 gate #232 actual main，保留其实际 helper 与 W514 运输。原 legacy 媒体/schema、CPU1、并发、single-flight、认证/启动/业务时限与断言不变。 |
| 类别 | 调度批准的独立 gate-change；仅 runner 与本五行说明，不修改业务 fixture、parser、口令、分类器或权限。说明沿已有 infra/ci Markdown 例外登记。 |
| PR | — |

W5-13 页面与 fixture 尚未实际合入时，默认完整链保持原 manifest，不加载任何未合 helper 或 parser。显式目标仅为 `test/e2e/live-m5-ticket-actions.spec.ts`；scope 存在时只按固定字段传递原值，不猜造上下文、不回退到其他工单或广告 scope。严格字段、测试库/Redis/工单归属与任务消费仍由 W5-13 所属 fixture 和私有服务器验收。

格式、runner lint 与语法检查通过。临时验证器执行实际 runner 片段的八个运输分支：缺 scope 默认旧 manifest 不变；显式缺 fixture、flow 或 scope 均拒绝且零调用/零写；scope 存在时默认、选中或其他目标均只传固定 w513 原值；W513/W514 同时存在仍保原 W514 一次调用与运输。原 W514 代码块逐字节保持。验证器仅在临时目录，不发布额外测试机制；未跑媒体 live，不以本前置声称页面、实际制作或外部渠道已验。
