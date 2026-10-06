# 对公大额二人复核

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | admin.transferProof.approveReview/rejectReview 与 transfer_confirm |
| 骨架里的做法 | 生效阈值非空且金额达到则确认返回 409 STATE_NOT_ALLOWED，firstConfirm/review=null，不留下收款交易 |
| 登记的工作包 | W1-11b，PR 待填写 |
| 回补里程碑 | M4 |
| 回补的工作包 | G4-A |
| 依据 | W1-11b 第 2、5、7、10 节；开发计划第 7.3 节留桩清单 |
