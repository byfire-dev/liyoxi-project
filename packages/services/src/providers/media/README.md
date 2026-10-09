# 腾讯数据万象 CI（W3-03）

`createCiMedia` 使用原生 fetch、Node crypto 和既有 COSv5 签名，不引 SDK/依赖、不读取云账号或凭据发现链。只接受显式 worker 角色、四个同账号桶、region 与 callback 根地址/密钥；真实入口从 `loadEnv().CI` 注入，API只配 callback，worker须配独立worker FILE。构造零HTTP，完整配置选择status=ci，未配沿原local processed:false或生产unconfigured降级。签名、短URL和原始识别正文不入Provider状态日志。

固定HTTPS origin是四桶的`<bucket>.ci.<region>.myqcloud.com`及同步图片审核的COS origin。禁止重定向、每次外呼10秒且不自动重试；实际逐chunk应答最多2MiB，Content-Length虚报也不能绕过，UTF8严格解码。XML拒DOCTYPE/外部实体/属性、深度32、节点10000和重复标量。这些是本项目防御界限，不冒称腾讯所有服务最大值。caller signal与close只取消并等待自己的fetch/body/计时器回收，不关闭兄弟Storage或借用DB/Redis；原事务外呼guard仍由中央工厂最外层绑定。

原生提交POST `/jobs`：Transcode用正式TemplateId与预定输出；FileCompress用REST `KeyConfig.Key/Rename`、Flatten=0、zip、IgnoreError=false，最多1000个独立名称，仅供后续ZIP业务handler调用，不在本包创建ZIP聚合。查询媒体GET `/jobs/{id}`，文件处理GET `/file_jobs/{id}`。媒体取消PUT `/jobs/{id}?cancel`；文件处理取消路线未获官方确认，明确unsupported。真实角色权限/CI激活、cam:PassRole、模板ID以及回调公网配置尚未验，不自动写桶/权限。

UserData严格`小写UUIDv7 jobId:attemptNo`。按UserData查找没有虚构平台过滤字段：GET `/jobs`使用官方tag、queueType=Transcoding/FileProcess、states=All、每页100，固定创建窗口≤2小时，在本地筛选最多4页；截断/重复token/多个外部号不能形成完整none证据，调用方不得据此盲目重发。Native Success也先保存submitted，业务仍需真实describe、匹配UserData及strict输出；解析只返回技术宽高/毫秒时长/字节大小，不透OCR或UserInfo。提交HTTP200坏XML/缺号属于受理未知，返回unavailable，不能当作确定拒绝。

同步图片审核只接既有profile场景：COS GET object的`ci-process=sensitive-content-recognition&async=0`，RecognitionResult.Result 0/1/2映射pass/block/review。probe和未接视频等业务明确unsupported，不能把local/fake processed:false写成审核或体检完成。

2026-10-08 已查阅的腾讯primary来源：[COSv5请求签名](https://cloud.tencent.com/document/product/436/7778)、[转码提交](https://cloud.tencent.com/document/product/460/84790)、[媒体查询](https://cloud.tencent.com/document/product/460/84765)、[任务列表](https://cloud.tencent.com/document/product/460/84766)、[媒体取消](https://cloud.tencent.com/document/product/460/84803)、[FileCompress提交](https://cloud.tencent.com/document/product/436/121031)、[文件任务查询](https://cloud.tencent.com/document/product/436/121032)、[FileCompress列表](https://cloud.tencent.com/document/product/436/120622)、[同步图片审核](https://cloud.tencent.com/document/product/436/119478)、[回调XML与JSON JobsDetail数组](https://cloud.tencent.com/document/product/436/119472)。没有借第三方博客推断接口。

本地HTTP签名回归使用公开假key与独立Python标准库计算的固定COSv5预期值；不是复用生产签名器自算，也不伪称官方提供了该假key向量。有限fake/native本机HTTP验证固定origin/字段/一次请求/超限/取消，不证明真实云已开通、外部任务执行或公网回调到达。
