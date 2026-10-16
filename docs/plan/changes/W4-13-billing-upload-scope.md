# 财务回单与发票的真实上传范围前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | W4-04/W4-13 的真实文件前置独立交付：`pay_receipt`、`invoice` 开放后台登记，并在媒体入口分别核 `finance.receipt.confirm`（保留再验证）、`finance.invoice.issue`或`finance.invoice.red`、员工身份与真实主体/门店数据范围。 |
| 原因 | W4-13 新DB聚合首次暴露 `FILE_CATEGORY_NOT_ALLOWED`：分类表未开放后台，但正式回单提交与开票均要求财务本人上传的文件。依据D5第3.2节与a07第3.44/3.70节，不能以伪造stored文件代替能力。 |
| 影响的包 | W4-04、W4-13消费本前置；仅shared分类、media范围校验与一个DB聚合，无新依赖、DDL、业务状态或接口。 |
| 类别 | 顺序 |
| PR | 本地分支 `codex/billing-upload-scope`；普通推送并合入本地main后供W4-13复验。 |
| 验证 | Node24格式/lint、services类型与新增单DB聚合通过（1/1，8.87秒）；唯一独审1个P2已定点关闭，真实云未验。 |

两类保持secure桶/entity归属；可只选主体，带门店时核实际归属和范围；拒绝onBehalfStore伪造，其他分类与原商家回单入口保持。

唯一独审指出发票后台签名遗漏分类分支，定点补为finance或service模块≥view，仍走原inStaffScope；原聚合补实际下载/留痕与无权、范围外零写拒绝。依据a01第2.17节与D4第9.4节。
回单上传依当前a07第3.44节及实际createAdminTransferProof的finance.receipt.confirm，保留再验证；a01旧上传矩阵仍列create_offline/refund.execute，本片不实现或扩展后继线下退款上传能力。
