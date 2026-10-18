# 国内兼容 LLM 协议准备（W315b）

`createDomesticLlm(config, options?) -> { provider, close }` 只提供显式构造出口。
`createProviders` 仍使用原未配 LLM；没有环境启用、真实账号调用、HTTP、媒体策略、
回调、预算或任务框架改动。完整 W315 继续进行中，洞察 DTO 与四策略由后继拥有者接入。
装配处须沿原 `withBeforeCall` / kernel 外呼守卫并登记实例自己的 `close`。

text、vision 各自配置 primary/backup 的 vendor、model、apiKey；百炼还须 workspaceId。
模型名不写死，也不据模型名字推定视觉或 JSON 能力，实际账号和兼容模型由拥有者确认。
只发送非流式 chat、JSON Object 与两条固定角色消息，不请求工具、联网搜索或任意附加参数。

允许端点由 vendor 身份固定生成，不接任意 baseURL、地区、路径、端口或代理：

| vendor | 官方 chat 入口 |
| --- | --- |
| ark | `https://ark.cn-beijing.volces.com/api/v3/chat/completions` |
| bailian | `https://{workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions` |
| deepseek | `https://api.deepseek.com/chat/completions` |

依据为[方舟结构化输出](https://docs.volcengine.com/docs/ark/structured-output-beta?lang=zh)、
[百炼地域表](https://help.aliyun.com/en/model-studio/regions/)、
[百炼 JSON 输出](https://help.aliyun.com/en/model-studio/qwen-structured-output)与
[DeepSeek chat 协议](https://api-docs.deepseek.com/api/create-chat-completion/)，2026-10-10 核对。
URL 只证明官方协议入口，尤其 DeepSeek 域名不能独立证明数据处理地域；真实启用仍须
E22 境内处理、账号、隐私与费用确认。Q13 默认项、Q17 尚未确认事项不冒充业主已确认。
请求 `redirect:error`，输出仍按本地严格 DTO 校验，不依赖供应商 JSON 模式保证字段。

旧 `tagAsset` / `extractKeyPoints` 形状保留，只增加可选 AbortSignal；fake 默认样例及
未配“不打标”保持。image 只发送短期 HTTPS URL 和固定描述提示，不把可能含姓名的
input.text 与图片同送，不识别人。audio/document 及已有文本的视频走 text；只有视频 URL
受控 unsupported，后继须真正截帧后再使用视觉能力。协议层不自行下载来源 URL。

单请求默认及硬上限30秒，整次调用60秒；options 仅可缩短。响应严格 UTF-8 且累计
最多1MiB，输入 text 最多64KiB、URL8KiB。description 非空且最多2000字符；tags 最多20项、
每项非空且最多100字符；points 1..maxPoints 项、每项非空且最多500字符，maxPoints 缺省3、
整数1..20。业务 JSON 额外字段、工具调用、拒绝与截断结果不当作成功。

每次调用最多3个请求：主方失败只切备一次，全调用 schema 修复只一次。transport、
单请求超时、HTTP408/429/5xx、坏协议或修复后仍错 schema 才可切备；其他4xx、明确拒绝、
非法输入、caller abort、close 或总期限不切备。修复提示只附固定 schema 要求，不回送模型
原始响应。失败文本固定，不输出凭据、来源 URL、原文或供应商错误文案。

每调用独立取消域；总期限、caller abort 和 close 都取消当前读写，finally 回收 timer、
listener、reader。close 等待该实例自有调用结束，不关闭借来的 transport 或其他实例。
本片只验虚构凭据和本地可控 HTTP，不宣称真实模型质量、国内数据处理、账单、日200、
全局预算、洞察缓存或生产云能力已开通。

## 结构化摘要协议准备

新增 `summarizeAsset({ text, vocabulary, signal? }) -> ProviderResult<LlmDigest>`，旧两方法与
默认未配工厂保持。仅沿上述 text 主备、最多3请求、全调用修复1次及取消/close路径；
不接素材任务、不自动写标签、不让模型代替人工复核或认定肖像授权。

调用者从真实可选 `asset_tag` 按 content/usage/timeliness 传 `{code,label}` 快照，label投影
配置名称。编码沿 `DictCodeSchema` 的1–16位 ASCII字母/数字/下划线/连字符，名称沿既有
配置写侧1–20字符；每维最多256项，跨维编码不重复，空词表合法。文本非空，文本与
词表序列化合计最多64KiB；发送与过滤绑定调用前深拷贝，之后修改调用者数组不会生效。
没有第二份固定标签词表；Provider 不查字典，也不证明调用者已核可选性/来源归属。

`LlmDigestSchema` 严格包含 D5 §9.3 全字段：title≤20、keypoints≤6且每项≤60、
contentTags≤4、suggestedUsage≤3、可选suggestedTimeliness、必有faceHint三值、
qualityNotes≤3且每项≤40、可选structuredItems≤50（name≤30/可选price≤20）。
这些文本长度按Unicode码点；沿D5允许空字符串/空数组，但必填字段缺失、未知键、
坏类型不补默认。时效仅接受实际ISO日，完整起止不能倒置，不把price偷换为priceText。
原始标签数组仍各≤256、每串≤100码点，先严格验证再过滤词表外编码；已知项过滤后
仍须满足4/3上限，未知时效整项省略。公共schema只验DTO形状，真实词表由调用者负责。

fake新增独立digestReplies队列及深拷贝的明确虚构样例，未配实现返回原受控失败。
本片本地协议验证尚未执行；完整视觉输入、策略消费、真实模型质量/地域/费用、预算
与E22继续待办，不能据此宣称完整W3-15完成。

## 多图视觉协议准备

新增 `analyzeVision({ imageUrls, signal? }) -> ProviderResult<LlmVision>`，使用原 vision
主备与取消/close机制，三个旧方法及默认未配工厂保持。调用者按可信顺序提供1–14张
短期HTTPS图片URL；协议层不下载、缩放、截帧或证明URL来源归属。每URL按UTF8最多
8192字节，拒凭据、片段、原始ASCII空白/控制字符；固定提示及全部image_url节点的
实际user content JSON合计最多65536字节，超限拒绝，不静默删图或截断。

`LlmVisionSchema` 只含五个必填字段：description≤2000码点、quality≤500码点、
hasPeople与identifiableCustomerFace两个严格布尔、textInImage≤8000码点。文本按
Unicode码点界定，空字符串可表达明确事实；缺项、错误类型、额外字段不补默认。
quality是画质描述文本，没有虚构枚举。只描述可见事实，不推定人物身份、缺失内容或
肖像授权；协议本身不能代替人工复核、来源可用性和模型准确率验证。

fake增加独立visionReplies队列与明确虚构五字段样例，返回深拷贝；未配仍受控失败。
本片仅SOURCE与轻静态检查，重验证排队未执行；可信1280缩放/6–14视频帧来源、素材
vision策略、真实云/模型质量/地域/费用、原子预算与E22仍待办，整包保持进行中。
