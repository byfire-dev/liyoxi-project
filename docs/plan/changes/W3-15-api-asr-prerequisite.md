# W3-15 API ASR前置装配

| 项 | 内容 |
| --- | --- |
| 改了什么 | API经原工厂选择真实ASR，预持本实例关闭Promise，配对无transport预算准入。 |
| 原因 | worker已有模型装配，API仍未配置ASR；部分启动失败也须关闭已构造模型。 |
| 影响的包 | packages/services运行时、apps/api入口及测试、providers说明与W3-15状态。 |
| 类别 | 实现细化。 |
| PR | 本地开发分支，尚未建立PR。 |

仅消费已接受的严格ASR FILE配置，不接API的LLM、ASR回调或新生产配置。
原工厂/守卫/请求期限不变；自有驱动成对登记，借用整套providers不创建或关闭模型。
入口在runtime返回前持关闭列表，正常HTTP排空、装配/自检/监听失败共用缓存Promise；
runtime禁准入并drain媒体后关闭模型，独立cleanup失败仍继续资源收尾、保留首异常。
API无预算transport，完整准入口保守拒绝新提交，已有TaskId回查不重新扣提交槽；
不创建预算连接、不初始化、恢复、退款或绕过owner。构造零模型HTTP不代表基础设施零网络。
原44完整旧测试及原期限保持；新增两整叶使用实际工厂/受控HTTP和公开合法历史夹具。
当前仅SOURCE/轻静态，未执行types、收集、测试、DB/Redis或云平台；真实凭据、权限、
地域隐私/E22、收费、准确率、容量、回调与完整W3-15均未验。
