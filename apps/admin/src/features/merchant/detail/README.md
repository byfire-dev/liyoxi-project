# 商家三页（W2-15）

`/merchants` 按正式 URL filters/sorts 分页，summary 使用同一过滤条件。`/merchants/referral-codes` 静态路由先于 `/merchants/$storeId`，沿已有商家模块守卫；管理码另要求正式权限。详情页签为 profile、qualification、entity、follow、accounts、activity，切店/换员工或范围时卸载旧表单和查询，错误态不保留旧写入口。

所有写操作消费真实权限和响应 actions，经中央 required 幂等键、再验证、正式 schema 与 snapshot confirm/lockVersion。409 刷新事实并重新核对；普通失败在同次确认中重用意图键。额度 null 表示跟随套餐；关闭六类阻断由服务端判定。账号申请/决定分权，证据只能经真实 account_proof 上传，读取每次现签；离页、换店、换人和后继签读会 abort 并忽略迟到结果。

门店联系走正式已联系入口；通用跟进只继续已有可写非 store 业务对象，时间控件按北京时间转正式 ISO。档案代改只录当前允许的免审字段，原资质审核仍按准确 submissionId 跳转，不复制审批。金额/时间复用 shared 格式，敏感字段默认掩码；未接能力和空值按真实响应显示。M7 导出尚无生产者，保持无入口。

风险定点由 ROOT 执行：三个 model.test.ts 共八个聚合、live-merchant-m2.spec.ts 两个真实 API 浏览器聚合与旧资质页定点。fixture 只在隔离测试库准备合法多店/跨主体/clerk 和一位虚构经理，初始指派经正式公口；不操作真实账号、发真消息或云对象。最终通过情况以 W2-15 状态为准，不将本地 live 当作预发验收。
