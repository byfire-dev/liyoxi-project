# W3-15 ASR 可选回调发送协议

| 项 | 内容 |
| --- | --- |
| 改了什么 | 为既有 ASR submit 增加可选本地任务上下文与构造时固定回调配置；仅配齐时在 CreateRecTask 追加 CallbackUrl。 |
| 原因 | 已有可信收件协议需要成对发送入口，省略时必须保持原轮询请求字节与默认关闭。 |
| 影响的包 | packages/services providers、两份新协议测试与 W3-15 状态。 |
| 类别 | 实现细化。 |
| PR | codex/w3-15-asr-callback-send，本地分支待验收合流。 |

基于实际 main `0ce2cc4f30ed76dc6e60dc50d42032dc1a6ebf3a`，限定九个路径。
配置只复制固定 HTTPS DNS origin 与 UTF8 32–256 字节 key；任务仅提供小写 UUID。
HMAC 只签本地 UUID，固定 h01 路径与唯一 sig；半配受控拒绝，默认五字段 JSON 与 TC3 不变。
query、旧同步接口、单次提交、受理归类、10秒/4MiB、取消和 close 沿原驱动。
不增加环境变量、Provider 方法、API/worker 装配、预算或生产回调启用。

腾讯官方可选 CallbackUrl 与 form requestId/ACK 协议见 providers/asr/README.md。
项目 HMAC 是自有 bearer-token 鉴权，不能称腾讯签名或真实云来源证明；查询参数真实投递
保留、DNS/证书/可达性、费用、隐私和 E22 仍待真实授权联调。

当前仅 SOURCE 和轻量 AST/定向格式 lint。新两整叶的实际测试、旧二十整叶 1202 静态候选、
三消费者类型、完整门禁及独立审查均尚未运行；不将设计向量或旧证据写成本轮通过。
