# W2-28 私有 owner/API driver 前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 新增对应源码私有JSONL owner/phase driver与旧OpenAPI reader；桥只透传可选诊断sink，默认七段/20集不变。 |
| 原因 | 双版本必须各自实际提供HTTP/API与独立worker，不能把HEAD业务或内存对象当成旧版执行。 |
| 影响的包 | W2-28继续进行中；controller/工作流/两SHA同库四步与发布阻断后继。ownerNetwork/schema/sink由独立前置提供。 |
| 类别 | 小改 |
| PR | — |

ROOT批准此同一机制范围与917行支持规模偏差：固定pipe/字节上限/取消与真实child退出、
owner精确四桶归集清理、跨版重登与全部旧OpenAPI查询/真实详情。无新依赖/生产业务、
DDL/租约/队列抽象。source只读固定构建元数据文本，并与controller的精确镜像身份共同核；
不允许把HEAD源码挂到旧镜像。私有能力不进公开报告。

本地只运行3个纯聚合与所属格式/ESLint；首次3/3通过，补EOF取消后定点复验。
API类型及源码独审待调度，未跑DB/构建/容器/完整HTTP链或GitHub。
owner/phase关闭仅报告实际完成事实，未另读租约不得报告leaseReleased。
外部IO替身与bootstrap基线语义见同目录driver README，不提前宣称混跑完成。
