# 腾讯录音文件识别

W3-15 本地代码已完成并合入 main，当前验收以 [W3-15 状态](../../../../../docs/plan/status/W3-15.md)
首节为准。`createTencentAsr(config, { now }) -> { provider, close }` 已接入 `createProviders`，
`ASR_TENCENT_FILE` 经唯一 `loadEnv` 注入 API/worker，并登记各实例的关闭生命周期。
四种素材理解策略、人工降级、原子预算及可信 wake 已接通；回调只唤醒原 TaskId 回查。
默认未配仍不转写，全局模型预算默认关闭；FILE 存在不代表付费调用已获授权。

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
协议测试采用公开虚构凭据与真实 loopback HTTP，任务与原子预算已有本地验收，
不访问真实云。E22 开通、真实准确率与账单、公网回调到达、日200文件及全局预算的
生产容量仍未验证；这些外部边界不因本地代码完成而关闭。

## 可选 CallbackUrl 发送协议

显式构造 `TencentAsrOptions.callback={origin,key}` 与每次 `submit.callback={mediaJobId}`
必须配齐；全省略保持原五字段 JSON/TC3 字节，半配返回 invalid_input/not_accepted 且零传输。
配置构造时严格校验并复制：固定 HTTPS DNS origin，无路径/query/userinfo，key 沿接收端
UTF8 字节32–256；UUID 保留接收端小写任意版本语义，不改码、不 trim 或 normalize。
固定路径 `/api/v1/hooks/asr/media-jobs/{mediaJobId}?sig={HMAC}`，只签 UUID 原文。
query 不附回调。完整 `ASR_CALLBACK_ORIGIN`/`ASR_CALLBACK_KEY_FILE` 已由 API/worker
装配到发送端与收件端，缺省不附 CallbackUrl；单次提交、原期限及默认关闭的预算保持。

官方 [CreateRecTask](https://cloud.tencent.com/document/product/1093/37823) 的 CallbackUrl 可选；
[回调说明](https://cloud.tencent.com/document/product/1093/52632) 规定 POST form-urlencoded、
requestId=TaskId、JSON code=0 ACK 与最多两次总尝试（2026-10-12 核对）。重试间隔、超时、
query 逐字保留及供应商签名头未明确。本项目 sig 是自有 bearer-token，不是腾讯签名。
发送协议前置的受控 HTTP/verify 用例不调用 wake；后续业务 wake、原 TaskId 回查与
两端装配已有本地验收。不证明实际 callback 到达、DNS/证书、公网权限、隐私/费用、
真实云准确率或 E22 完成，真实联调继续按外部台账执行。
