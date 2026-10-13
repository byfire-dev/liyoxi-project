# W2-09 休眠登录同事务处置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 新绑定的休眠店员移除与空草稿老板让位接已合 Tenant callerTx；锁后及处置后重读成员，原五放行/身份改绑/令牌保持。 |
| 原因 | 回补 `m2-identity-dormant-branches`，非空老板仍回滚后独立记录人工重验。 |
| 影响的包 | identity 登录/本域测试与说明；必要偏差仅 tenant/empty-draft.ts、index.ts 公开专属草稿拒绝类型，原业务符号不变。 |
| 类别 | 原计划最小切片；不交20HTTP、账号注销审批、订阅或清理，不改契约/DDL/kernel/门禁。 |
| PR | 本地 `codex/w2-09-dormant-login`，基于 main `42171c0a`；由 ROOT 验收、独审与合流。 |
| 验证 | 新12 DB +3双max1竞争（各3轮），旧综合休眠定点回归；作者轻格式/ESLint，ROOT 独占类型与数据库，失败事实保留，不重复旧全量。 |
