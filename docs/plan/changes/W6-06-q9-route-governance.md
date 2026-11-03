# W6-06：Q9 电脑样片历史接口登记治理

| 项 | 内容 |
| --- | --- |
| 改了什么 | 撤销两条从未实现的电脑样片资源当前登记：portal.orderItem.sample.get、portal.sample.playbackUrls。总资源669→667，V1.0 613→611，M6 55→53；W6-06实施接口12→10，另保留2项历史处置责任。 |
| 原因 | Q9已明确第一期样片仅在小程序查看，不能用恒拒绝处理器或手改计数把不实现资源报为落地。按W6-06任务书先交独立治理前置。 |
| 影响的包 | W6-06、W6-12、W6-13按53条正式M6集合核对；14包、12新页、9项x01、8桩和依赖/级别/规模均保持。主包代码仍等02/07实际合并。 |
| 类别 | 归属 |
| PR | — |

## 1. 精确处置

| 历史operationId | 方法/路径 | 原归属 | 处置 |
| --- | --- | --- | --- |
| `portal.orderItem.sample.get` | GET /portal/order-items/{orderItemId}/sample | V1.0 / M6 / W6-06，portal鉴权、sample.view、GET零写 | 撤销当前登记；p01第3.10节保留历史设计 |
| `portal.sample.playbackUrls` | POST /portal/samples/{sampleId}/playback-urls | V1.0 / M6 / W6-06，portal鉴权、sample.view、none签发、m.sign | 撤销当前登记及失效限流成员；p01第3.11节保留历史设计 |

两项从未有typed结构或真实handler，未进入OpenAPI，也未进入public/optional/signed黄金；不会撤下已有可用接口。保留sample.view能力、历史preview_channels、访问审计和确认记录，不迁移数据，不改DDL。两项不移入V1.1，不为以后实现作承诺。

Q9既有业务守卫保持：电脑端不签发样片、不制造观看证据；广告只读、成片下载与票据会话继续按原包实施。既有portal操作白名单拒绝样片的回归不删改。

## 2. 统计与验证

- 当前集合只移出上述两个ID；其余667条元数据逐字段保留，typed 495条、V1.1 56条、探活5条、natural 15条不变。
- M6正式资源53条，已落地仍10条，待落地45→43；这2条差额是已授权范围治理，业务实现新增数为0。
- contract、API索引/权限引用及计划8.2由官方生成器重写；不改landed/four-counts算法、基线、required列表、超时或并发。
- 验收：contract路由/声明测试、contract:docs-check、API文档核对、plan-routes --check、status/plan单项检查；契约生成复验须零差异。远端required及唯一独立复审通过后由调度合并，CI链接放PR。

## 3. 开工与外验边界

本PR仅兑现已有Q9决定和W6-06明确要求的独立治理，不消费未合02/07代码，不把W6-06主包标完成，不关闭任何桩。W6-06仍为进行中，主包后续按10接口验收。

V7/V8真实形态开工点、V10/V11、E8/E11、签后V12及M6演示/预发/真机退出保持；本地代码与本治理均不等于外部通过。
