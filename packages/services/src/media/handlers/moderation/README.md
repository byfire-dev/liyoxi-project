# 内容审核（W3-05）

四 kind 沿现有 media_job 的 claim、父锁→job400→file410、attempt/lease、事务外调用及条件收尾执行。文件状态仍是 stored；只有 moderation 从 none→pending→pass/review/block。结果与唯一 `file.moderated` 出站事件在同一事务提交，未配置、processed:false、超时或损坏应答保持 pending。重复/乱序结果不重发事件、不覆盖既有结论，也不在文件删除或对象代次变更后恢复可用。

通道依据 D5 §11：商家 weapp 的档案/素材/渠道/意见图片在 0<size≤5MiB 时优先微信；员工代传、较大图片、海报/Banner 用 CI 图片审核。视频用 CI 异步画面与音轨审核。录音与文档只审真实转写/抽取文本；资质证照、支付凭证、母片/最终集等不凭本包增加虚构审核。CI 机器结论不代替广告标识、广告法或双人 QC。

微信复用 W2-21 的活跃 openid 端口和安全回调。35 分钟未回、未配置/失败只创建一次 CI fallback；原 trace 迟到不覆盖 fallback 已选结论。原始 openid、全文、签名 URL、供应商 UserInfo/音频片段/OCR 不进入任务输出或事件。

CI `auditVideo` 仅接受固定桶内 Object 与 `jobId:attemptNo` DataId，明确 DetectContent=1 同时审画面和音轨，Interval 每5秒、Count10000为截帧上限，审核策略沿云端默认策略。先持久化实际外部号，再 exact job/DataId/Object 查询；unknown submit 无完整不存在证据，不自动重发、不能用普通手动 retry 绕过。未知/失败不假 Success。没有新增 CI 回调；原执行器轮询与 deadline/取消预算保持。

`enqueueExtractedTextAudit(tx,{fileId,textFileId})` 是后续 ASR/文档抽取的明确入口。调用方先把实际 UTF-8 产物存成同主体/门店/范围的 stored txt 文件；本包排序锁两文件、核当前 etag/size、事务外 IfMatch 有界读。最多40000字节/10000码点，不截断成 pass；原始内容不存 job/event。缺产物标记 TEXT_NOT_EXTRACTED，原文件仍 pending。此入口不实现 ASR/OCR/LLM，也不证明后续理解处理器已接入。

`assertUsableForModel(tx,fileId)` 复用 stored/block 守卫，只回有限对象事实；未来模型调用方必须调用该公开口。本包没有尚未存在的模型调用链验收。私有本店元数据可按原权限查看，block 禁签、禁新 link；签名 IO 返回前再读当前状态。profile 订阅者只按当前文件/真实引用重算现有三列缓存，不信旧事件状态，不写审批结果。Banner 在当前图片被 block 时不能重新启用；缓存读取须通过实际公开签读守卫。

协议来源（2026-10-09 核）：[视频提交](https://cloud.tencent.cn/document/api/1535/108728)、[视频查询](https://cloud.tencent.com/document/product/460/46926)、[文本审核](https://intl.cloud.tencent.com/zh/document/product/1045/58201)、[同步图片审核](https://cloud.tencent.com/document/product/436/119478)。视频默认 DetectContent=0 只审画面，因此显式1；Conf 含官方必需 Snapshot。无真实云调用或权限/额度开通证据。

本目录测试的 stored/file/media_job 输入为隔离库单元事实，不是实际 codec、制作体检或真实供应商结论。当前纯测试 209 项通过，含图片原生 Label 两反例先失败再修复；只保留有限已知标签，不透传 OCR/二级标签/原文，缺标签时保持旧 Provider 返回形状。最新增量格式、lint 与 services 类型通过。首轮真实数据库 15 项中 13 项通过，另两项停在 BigInt 断言序列化与跨门店夹具违反不可修改范围约束；修正夹具后完整结果文件 12 项通过，先前微信35分钟兜底、迟回和 etag 文件 3 项通过；另一次公开使用守卫 6 项通过。三个分段合计 21 个不同用例通过，未冒充同轮全量。原失败日志保留、失败单库已精确清理。原微信和文件安全 pipeline 与其余正式门禁尚待执行，最终交接记录实际命令与结果，不用预期代替证据。
