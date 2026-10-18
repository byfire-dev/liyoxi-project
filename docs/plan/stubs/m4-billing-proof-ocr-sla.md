# 付款凭证识别与超时任务

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | transfer_proof 的 OCR、check_result、sla.breach |
| 骨架里的做法 | due_at/sla_snapshot 真实计算并存；不登记超时、不发起识别，ocr.status=unavailable、checks=[]，hints 仅上传时间 |
| 登记的工作包 | W1-11b，PR 待填写 |
| 回补里程碑 | M4 |
| 回补的工作包 | W4-04（G4-A），回单媒体/Provider独立前置 |
| 依据 | W1-11b 第 2、5、7、10 节；开发计划第 7.3 节留桩清单 |

2026-10-16：所属代码侧回补完成。凭证上传消费实际media回单OCR，缓存ok立即读、pending等真实完成事件；job/file/entity及当前凭证指针重核，替代/已处理/错误job迟到零写。六字段查询脱敏，四项check_result只存结论，未配/失败/WebP保持unknown，不自动到账。

唯一sla.breach按transfer_proof分流，上传/替代/处理取消重设，真实calendar.imported重算原上传时限；当前到期才发既有finance受众场景。对应服务OCR/SLA聚合、两真实HTTP聚合与类型/官方登记/权限/挂载/依赖检查通过，夹具首R与定点复验见W4-04状态。真实云OCR/真实回单、银行资金和业主配置不在本地完成证明内。
