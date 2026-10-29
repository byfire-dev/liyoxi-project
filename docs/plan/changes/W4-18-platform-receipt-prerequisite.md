# W4-18 无主体资金退回的回单上传前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 沿原admin.file.create与schema为无entity/store的pay_receipt派生platform，并补本人、权限、再次验证及all范围守卫 |
| 原因 | 线下退款和对账错款退回已支持本人platform回单，原后台登记仍要求entity，页面无法取得合法凭证 |
| 影响的包 | W4-18；只补回单登记与读取支撑，原退款/对账业务消费权限、归属和状态守卫保持 |
| 类别 | 调度批准的独立上传窄前置；不新增API、DTO、依赖或DDL |
| PR | — |

实际退款线下消费和对账错款退回已支持本人持有的platform/pay_receipt，但原后台登记一律要求entity，页面无法通过正式上传得到合法凭证。调度批准独立补此缺口，沿原admin.file.create与原可省略entity/store的schema，不新增API、DTO、依赖或DDL。

仅pay_receipt在没有entity/store时派生platform：原当前员工身份匹配、finance.receipt.confirm及再次验证仍必需；另外须all数据范围及finance.refund.execute或finance.recon.resolve有效权限。拒绝onBehalfStore，不接客户端任意scope。invoice继续要求真实主体，原有主体/门店路径保持。该能力只登记本人secure回单，不授予任何退款、差异处理或资金状态修改权；消费时继续真实业务状态、归属及本人文件守卫。null主体的bank_transfer退款仍受原户名规则限制，本前置不放宽。

允许叶：media/access.ts、本域platform-receipt.db.test.ts、本说明与media README。新增两目标准备验证真实身份/两权限/再次验证/own/group反例零写及原公开register→complete→promote平台归属；另复用既有billing-upload相邻目标验证entity和invoice原路径。类型与检查在唯一重槽顺序执行，实际验证已完成，见下。

唯一独审由 m4_callback_alert 完成，P2 读取范围已在 b0297800 闭环：shared inStaffScope 对 platform/pay_receipt 要求 all，同时覆盖 getAdmin 的 owned 优先路径及 downloadUrls；上传人随后降为 own/group 也不可读或签名。其它 platform 类别不变。

Node24 单 worker、无文件并行：新增 2 个 DB 目标与相邻 billing-upload 原 1 目标共 3/3 通过（8.10 秒，/tmp/lyx-w418-platform-receipt-targets-deps.log）。首次在 import 因旧 worktree 未安装已锁定的 OCR 依赖而零目标启动，正式 offline frozen install 恢复；不改依赖或锁文件。services 类型首次失败为旧 ignored Prisma client 未含 main 已合字段，官方 db:generate 后复验通过（/tmp/lyx-w418-platform-receipt-types-generated.log）。未重复已绿目标，不改变超时、断言或业务保护；真实 COS/资金未验。
