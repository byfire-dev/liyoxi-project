# W2-28 私有 owner/API driver 前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 新增对应源码私有JSONL owner/phase driver与旧OpenAPI reader；桥只透传可选诊断sink，默认七段/20集不变。 |
| 原因 | 双版本必须各自实际提供HTTP/API与独立worker，不能把HEAD业务或内存对象当成旧版执行。 |
| 影响的包 | W2-28继续进行中；controller/工作流/两SHA同库四步与发布阻断后继。已接实际合入的ownerNetwork/schema/sink独立前置。 |
| 类别 | 小改 |
| PR | — |

ROOT批准初版此同一机制917行支持规模偏差：固定pipe/字节上限/取消与真实child退出、
owner精确四桶归集清理、跨版重登与全部旧OpenAPI查询/真实详情。无新依赖/生产业务、
DDL/租约/队列抽象。source只读固定构建元数据文本，并与controller的精确镜像身份共同核；
不允许把HEAD源码挂到旧镜像。私有能力不进公开报告。

本地只运行3个纯聚合与所属格式/ESLint；首次3/3通过，补EOF取消后定点复验。
唯一源码审查指出Step4必须回放旧版清单，已补source绑定的私有旧GET投影与原组反例，
不让HEAD清单掩盖旧GET，P2已定点关闭；API首轮缺实际订阅者参数已同批窄修，最终API类型通过。
同批批准失败仅带已选旧spec的安全operationId，不输出URL/query/rawerror或猜HTTP状态。
3纯组分批全部通过，源码所属格式/ESLint/diff及正常Node24 hooks通过；
未跑DB/构建/容器/完整HTTP链或GitHub，独立镜像实际运输留双SHA四步验。
owner/phase关闭仅报告实际完成事实，未另读租约不得报告leaseReleased。
外部IO替身与bootstrap基线语义见同目录driver README，不提前宣称混跑完成。
