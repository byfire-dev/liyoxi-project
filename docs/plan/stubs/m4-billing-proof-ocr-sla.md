# 付款凭证识别与超时任务

| 项 | 内容 |
| --- | --- |
| 状态 | 留桩中 |
| 留桩内容 | transfer_proof 的 OCR、check_result、sla.breach |
| 骨架里的做法 | due_at/sla_snapshot 真实计算并存；不登记超时、不发起识别，ocr.status=unavailable、checks=[]，hints 仅上传时间 |
| 登记的工作包 | W1-11b，PR 待填写 |
| 回补里程碑 | M4 |
| 回补的工作包 | G4-A |
| 依据 | W1-11b 第 2、5、7、10 节；开发计划第 7.3 节留桩清单 |
