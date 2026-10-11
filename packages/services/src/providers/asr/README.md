# 腾讯录音文件识别协议准备（W315a）

本块只提供 `createTencentAsr(config, { now }) -> { provider, close }` 构造出口。
`createProviders` 仍选择原未配 ASR；没有新环境变量、真实账号、回调、预算或任务策略。
完整 W3-15 继续进行中，四策略、人工降级接线、原子预算与可信 wake 待后继实现。

依据为腾讯云国内 [CreateRecTask](https://cloud.tencent.com/document/api/1093/37823)、
[DescribeTaskStatus](https://cloud.tencent.com/document/api/1093/37822) 与
[数据结构](https://cloud.tencent.com/document/api/1093/37824)，2026-10-10 核对。
仅发送固定 `16k_zh`、单声道、`ResTextFormat=3`、URL 来源，不开启额外收费分析。
端点固定 `asr.tencentcloudapi.com`、版本 `2019-06-14`，不跟随重定向。
TC3 实现参考仓库既有短信签名结构，独立保留 ASR 服务名，不跨域抽取框架。

`submit` 每次只请求一次。`acceptance=not_accepted` 仅表示输入/开始前取消/明确官方拒绝；
传输失败、超时、在途取消、坏响应和不确定官方错误返回 `unknown`，禁止据通用
`unavailable` 自动重新提交。即使调用者再次提交相同 URL，本驱动也不以 URL/任务号去重。
官方 TaskId 是 uint64、24小时有效且跨日可重复；本地业务必须保留自己的 UUID 与代次。
Node24 JSON reviver 从原始数字 token 无损读取任务号，查询发送严格校验的十进制数字。

`query` 区分 waiting/doing/succeeded/failed。成功必须有真实文本、非空分句与时长；
`AudioDuration` 是秒，分句 StartMs/EndMs 是毫秒，null/越界/错单位受控拒绝，不补零。
供应商 Message、ErrorMsg、文件 URL、原始正文和凭据不出现在失败结果或日志。
每请求最多10秒、响应最多4MiB，取消/关闭等待自有请求读流 finally 回收。
装配处仍须沿原 `withBeforeCall`/kernel 外呼守卫并登记自有 close；本块不替代该守卫。

旧 `transcribe` 接口、fake 默认30秒和未配“不转写”事实保留。此异步真实驱动的旧同步
方法明确 unsupported；fake 新任务默认 waiting，完成事实由用例显式给出。
协议测试采用公开虚构凭据与真实 loopback HTTP，不访问真实云；真实准确率、账单、
E22开通、回调联调、日200与全局模型预算均未验证，也未宣称完成。

## 可选 CallbackUrl 发送协议（SOURCE）

显式构造 `TencentAsrOptions.callback={origin,key}` 与每次 `submit.callback={mediaJobId}`
必须配齐；全省略保持原五字段 JSON/TC3 字节，半配返回 invalid_input/not_accepted 且零传输。
配置构造时严格校验并复制：固定 HTTPS DNS origin，无路径/query/userinfo，key 沿接收端
UTF8 字节32–256；UUID 保留接收端小写任意版本语义，不改码、不 trim 或 normalize。
固定路径 `/api/v1/hooks/asr/media-jobs/{mediaJobId}?sig={HMAC}`，只签 UUID 原文。
query 不附回调，默认配置/预算、API/worker 装配、单次提交与原期限不变。

官方 [CreateRecTask](https://cloud.tencent.com/document/product/1093/37823) 的 CallbackUrl 可选；
[回调说明](https://cloud.tencent.com/document/product/1093/52632) 规定 POST form-urlencoded、
requestId=TaskId、JSON code=0 ACK 与最多两次总尝试（2026-10-12 核对）。重试间隔、超时、
query 逐字保留及供应商签名头未明确。本项目 sig 是自有 bearer-token，不是腾讯签名。
本地受控 HTTP/真实 verify 组合不调用 wake，不证明实际 callback 到达、DNS/证书、公网权限、
隐私/费用/真实云准确率或 E22；本片源码尚待独占完整验证与正式审查。
