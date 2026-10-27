# W4-09 预发小额主体名单配置前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 新增非敏感STAGING_PAY_ENTITY_IDS标量，仅stg解析为冻结的可选Env.STAGING_PAY.entityIds |
| 原因 | 自动退款必须使用明确预发主体名单，purchasePolicy中的entityIds只表达购买策略，不能冒充资金自动化授权 |
| 影响的包 | W4-09；仅补预发名单配置，stg-only注册、系统退款writer/job及三保护仍由主包负责 |
| 基线 | actual main `b04a5f8b6484fa060ed111ff42d42f5ed3eebe36`；健康与发货Provider组件已合，W4-09整包仍进行中 |
| 范围 | kernel/env.ts、.env.example、node.yml的worker/check-env映射、新增3配置目标及1静态目标、原ENV_KEYS精确清单追加1项、本说明与bootstrap README，共8叶 |
| 类别 | 调度批准的独立配置前置；不改DDL、通用机制、依赖、审批或资金入口；正式分类只增1项、放松0项 |
| PR | — |

缺省、空串或空白均不投影新字段，保持原配置输出。非空名单仅允许stg；local、test、prod均启动校验失败。输入以逗号分隔，逐项去首尾空白，必须与现有IdSchema一致为小写UUIDv7；拒绝重复、空项、非法版本/变体、超过100项或非空输入总长超过4096字符。错误仅键与固定原因，不回显主体、原值或文件路径。主体ID不是secret，不读取实际配置、不索取真实密钥。

预发Compose只将公开标量传给worker和check-env，默认空；API、其他工具和本地Compose不消费。node.env仍由原Compose --env-file仅做变量替换，不执行其中内容，不新增秘密文件、部署参数解析器或远端动作。

解析名单不代表开启自动退款。本片没有enable标志、任务/handler/kind登记、Provider调用或退款writer；后继W4-09仍须逐层实现stg-only注册与生产双排除、1..100分/T前缀/该显式名单三保护、真实system发起审批执行留痕及原Saga权益/发票守卫。其他环境拒绝非空配置是独立防线，不能替代后继runtime防线。

本机singleworker/session=w409cfg1，新增3配置目标及原ENV_KEYS精确清单1目标首次4绿（104未选，4.23秒）；infra仅新增静态隔离1目标首次绿（72未选），check-env-example核对50键及占位通过，services类型一次通过。配置目标覆盖空配置兼容与非预发拒绝、100主体/4096字符恰好边界与冻结输出、非法/大写/重复/空项/超量/4097字符及错误脱敏。环境用例只解析公开临时连接串文件，无真实渠道外呼；临时资源经原清理流程移除，无失败留存。

相对原7叶估算，源码核对发现原kernel/env.test.ts以精确数组锁定全部ENV_KEYS，必须追加本次新键1行，已向调度报告该最小测试伴随；不删原键、不削弱旧断言，不以避跑原守卫掩盖遗漏。

源码checkpoint `f060e803` 的8叶已经ROOT唯一独审，无P1/P2/D；验证未修改生产源码。收口普通同步稳定main `55ce3df4`，相对开工base仅带入W4-08状态两行，不重复已绿验证。ESLint/Prettier、diffcheck、正常hooks通过；正式分类为8文件、只增1项、放松0项，门禁规则不改。未运行业务旧全量、构建、生成、安装、云平台或服务器操作；重验证槽已明确释放，W4-09主包仍进行中。
