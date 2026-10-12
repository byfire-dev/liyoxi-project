# W3-15 ASR默认回调装配

| 项 | 内容 |
| --- | --- |
| 改了什么 | API/worker自有腾讯工厂消费正式回调配置，默认来源与owner真实jobId成对接线。 |
| 原因 | 已有发送协议、严格FILE和API模型装配，实际提交与默认收件仍未连通。 |
| 影响的包 | services运行时、worker组合根、素材ASR内部依赖及API测试和接口文档。 |
| 类别 | 实现细化。 |
| PR | 本地开发分支，尚未建立PR。 |

仅自有完整冻结ASR_TENCENT/ASR_CALLBACK配置启用；借用整套providers自动来源与
提交context保守关闭，原显式sources整表override和生命周期所有权保持。
sender/receiver使用同份原UTF8 key；owner只传实际job.id，缺省输入不增CallbackUrl。
receipt提交后才提醒原submitted任务回查原TaskId；不接收文本作为识别结果，
不新reserve/重提交，不改变原预算P1/R/P2、来源图、时钟/租约/期限或轮询。
API无transport继续拒绝新付费提交，历史query不要求新额度或账本初始化。
模型构造零HTTP与本地基础设施连接分别陈述；关闭沿原缓存Promise和drain顺序。

当前仅SOURCE/轻AST/owned格式lint；两新整叶与受保护旧整叶尚未执行。
本地测试计划使用真实组合根、真实自有小DB/Redis与受控HTTP，原内部期限不变。
不新增env、预算初始化/恢复/退款、epoch、ZIP或模型默认启用。
真实腾讯投递、DNS/证书、凭据/地域隐私/E22、收费、准确率与容量仍外部未验。
