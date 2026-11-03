# 真机结果入口

目前没有真机结果；工程构建、fake 测试不构成 V19/V8/V3/V7 结论。

业主执行 `pnpm --dir spikes/weapp-probe report` 后，在本目录生成 `summary.md`。只回传过目的汇总、填写后的 CHECKLIST 记录栏与已经裁掉手机号/账号/票据/URL/凭据的截图。不要回传 `server/.logs/`、密钥文件、完整调试控制台、HAR 或带签名的地址。

fake 报告单独生成 `fake-summary.md`，不能混入真实数据。当前不提交空的 `summary.md` 或结论 ADR。
