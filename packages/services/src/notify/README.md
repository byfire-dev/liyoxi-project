# notify 短信配置与保活（W2-22）

本包新增腾讯云驱动、严格模板初始化、两个既有日任务。W2-17 的商家派发、公共 sendDirect、员工激活消费者与短信到达回执仍由各原包接续；这里不登记它们，不把同步受理当作已送达。

## 1. 运行配置与初始化

`loadEnv()` 读取整组 `SMS_SECRET_ID_FILE`、`SMS_SECRET_KEY_FILE`、`SMS_SDK_APP_ID`、`SMS_REGION`；两份 FILE 文件存纯文本云 API 密钥，每个普通文件按实际字节至多4KiB读取并关闭句柄，任何环境不接受明文变量，部分配置启动失败。整组存在时两处真实组合根装配 `tencent`；未配时 local/test 保留原控制台三方法，stg/prod 为未配置。新控制台 sendTemplate 不造服务商编号、checkBalance 不造余量。

库先运行既有迁移与播种，准备九个未配置模板。初始化使用启用的超级管理员 staffId，通过镜像命令调用公开服务函数：

```sh
node apps/worker/dist/sms-init.js --config /run/config/sms-templates.json --staff-id <staffId> --apply
```

不新增 x01 CLI 名字。`--apply` 在 stg/prod 必须明确给出；配置文件是显式路径、大小至多64KiB，严格JSON。退出码0为完成，1为输入或服务守卫拒绝（包括显式配置文件IO、JSON或大小错误），2为环境或运行时存储失败；只输出变更数量，不打印配置、文件路径、号码、验证码或密钥。命令不申请/审批签名模板、不发送短信。

顶层只有 `{ "templates": [...] }`，必须恰好九个既有键且不重复。每项字段如下；下面仅说明形状，虚构平台编号和审批事实不能用于真实初始化：

```json
{
  "templateKey": "generic_todo",
  "kind": "notice",
  "providerTemplateId": "9999990000",
  "signName": "虚构测试平台",
  "params": [{ "name": "item", "maxLen": 6 }],
  "status": "active",
  "approval": {
    "templateApproved": true,
    "signApproved": true,
    "reference": "fictional-shape-example"
  }
}
```

真实 `approval` 表示业主已核对模板/签名获批事实与参数长度，不能用本文件的示例代替。签名按官方规则为2–12个中英文/数字；配置只接受 active 或 pending_carrier，pending_carrier 不发送。整批先严格校验，再同事务校验超级管理员、九个种子与 kind，原子写入。相同配置重跑不改时间、不重复审计。实际变化会清空旧 lastOkAt，重新开始闲置周期；ops/notify_config、notify.sms.init 对自然模板键写 target_key，留 cli.sms-init，审计只保存有限差分与数量，不保存正文或签名。

## 2. 固定变量与发送约束

变量顺序来自 D6 §2.10。英文变量名与下列业务上限是本实现的明确映射；真实可发长度取此上限和业主批准的 maxLen 两者较小值。通知变量并非默认可无限发送，也不能擅自都固定为6字。

| 模板键 | kind | 有序变量（业务上限，Unicode字符） |
| --- | --- | --- |
| verify_code | verify | code(6)，纯数字 |
| review_result | notice | result(12)、reason(64) |
| sample_pending | notice | item(12) |
| launch_remind | notice | date(10)、channel(20)、drama(40) |
| plan_expiring | notice | plan(40)、expiry_date(10)、points(12) |
| offline_remind | notice | drama(40)、offline_date(10) |
| generic_todo | notice | item(12)，固定枚举 |
| account_notice | notice | 无变量 |
| ops_alert | notice | rule_name(64) |

generic_todo 事项仅可选：样片确认、广告确认、成片交付、上线确认、资料审核、工单回复、积分变动、服务到期、下架确认、账号安全。未知/缺失/多余/继承字段、空值、控制字符、明确 URL 前缀或超长变量在外呼前拒绝，不截断变量。

真实 sendTemplate 每次一个中国大陆号码；旧 sendOncallAlert 的多个号码走一次腾讯批量请求，200上限、禁止重复号码，部分受理返回失败且受理不明，不假称全部成功。只把 title 作为固定规则名，不把详细告警 content 填成额外变量。旧三方法输入/void结果保持兼容。

原生 fetch/node:crypto，固定 sms.tencentcloudapi.com、SendSms、2021-01-11、TC3-HMAC-SHA256。外部每次10s×1，无内部重试（包括限流、5xx和读查询）。响应体256KiB上限；信号覆盖请求和流，取消会释放 reader 与 timer。Code=Ok、匹配号码、真实 RequestId/SerialNo 完整才认同步受理；超时/断连/内部异常或部分批量受理不能自动再发。服务商原 Message 与 PhoneNumber 不进入错误/日志；保留有限官方错误码与真实追踪号。

## 3. 两个日任务

仅落地既有 `notify.sms_keepalive`、`notify.sms_balance`，每日10:20，job 模式，P3，单次，原 timer.result 保存受控摘要；不建 job_run。Worker真正 buildWorkerServices 与 services/runtime 两处接配置；关停只解绑本包挂点，原 siblings、循环和租约保留。

保活遵守全局 notify.sms.enabled、原 notify.window.start/end、notify.sms.keepalive_days、notify.sms.daily_cap 和 notify.test_recipients。只接受配置中启用员工的合法内部测试号；缺号、密钥、驱动、关闭开关或不在窗口均受控跳过。active notice 模板距上次同步成功（没有则距配置更新时间）达到间隔才候选，verify/disabled/pending_carrier/suspect 不发。测试值均固定；批准长度装不下测试值时跳过，不缩短。

唯一键为 `sms_keepalive:<执行日Asia/Shanghai>:<template_key>`。每次认领在咨询锁内以即时执行日和 paramsAt 核对当时窗口、日cap、内部号、员工状态、模板和间隔。短事务认领 attempt1、30s lease、call_started_at=NULL、HMAC目标与 mask；发前守卫通过后，再按真实 id/attempt/status/有效 lease/未开始条件用短事务写即时 call_started_at，成功后立即事务外发一次。标记失败不调用；发前守卫失效取消。成功才更新对应未变的模板 lastOkAt；迟到结果不覆盖。自己至多100条/轮的过期sending区分未开始的 claim_exhausted 与已开始的 unknown_outcome，两种均不自动重发，同日唯一键保留。正文、验证码、手机号明文不入投递表。

失效判断：30天内最近至多10个 call_started_at 非空的真实发送终态（成功、provider_rejected 或 unknown_outcome；不含发前守卫拒绝/claim_exhausted），非空即计算失败率，严格 >50% 或最新连续5失败触发 suspect/alerts.raise；0样本无比率，正好50%不触发比率，连续5仍可单独触发。窗口是实现选择，没有额外最低样本门槛。固定告警键 `notify.sms_suspect`，P3，dimension=templateKey，detail={templateKey,criterion:"5_consecutive_or_recent_gt_half"}。告警口使用既有端口；W2-24真实外部告警尚未合流时不声称外部告警完成。

余额任务诚实返回 unsupported（或缺驱动/关闭/取消摘要）、queried=false；不发查询、不返回假0或无限、未登记余额阈值。配置驱动且开启时，通过既有 Alerts 一次报告固定规则 `notify.sms_balance_unconfigured`，P3，无dimension，detail={outcome:"unsupported",reason:"complete_package_scope_and_threshold_unconfigured",queried:false}。两规则的键、严重度和有限事实已移交W2-24；告警端口调用不代表外部到达。本轮不会新增 notify.sms.balance_threshold。

## 4. 官方事实与外部未验

获取日期 **2026-10-08**，官方primary：[SendSms](https://cloud.tencent.cn/document/api/382/55981)、[官方TC3 SMS Node demo](https://github.com/TencentCloud/signature-process-demo/blob/main/services/sms/signature-v3/nodejs/demo.js)、[错误码](https://cloud.tencent.com/document/api/382/52075)、[SmsPackagesStatistics](https://cloud.tencent.cn/document/api/382/55964)、[数据结构](https://cloud.tencent.com/document/api/382/52068)。固定签名期望来自独立 Python hashlib/hmac 对官方算法/公开虚构凭据/固定时间与官方同序 payload 的计算，非被测函数自产。

SmsPackagesStatistics 确实存在，但 BeginTime/EndTime 是套餐**创建**窗口，yyyymmddhh、小时精度，EndTime>BeginTime且早于当前时间。官方页未声明最大跨度；不能由此推定任意历史都保留或完整。Limit≤500、Offset分页，查询必须覆盖业主已确认的完整历史并拉完全部页，校验 PackageEffectiveTime/PackageExpiredTime/PackageType；CurrentUsage 是查询时观察值，页面没有事务快照或强一致/延迟保证。创建窗漏掉的、未生效或过期的包不能冒充当前可用量，使用量与时间点也不能省略；它不是人民币账号余额。当前没有账号全量范围、权限与正式阈值证据，故不实现虚假的总余量阈值告警；本地统计 wire 测试仅证明真实 Action/字段格式，不证明账号余量。

官方验证码模板变量至多6位纯数字；实际 staff 激活码仍为8位字母数字，真实驱动在外呼前 rejected，console local/test 原样。本包不改码、不截断、不改冻结模板种子或verify枚举、不转通知模板绕限制。需 W2-03/W2-17/业主继续解决外部选型与审批偏差，真实员工激活短信未闭环。

官方通知变量新/长期闲置账号默认至多6字符，具体账号以控制台为准，官方另列通知/营销模板不支持变量的错误。九个业务模板及参数配置不能据本地fake测试推定获批。真实签名/模板/内部号/密钥、一次授权发送、同步受理与到达/失败回执、套餐全量与阈值监测均保持外部未验，由业主提供脱敏事实后继续，不在本开发会话发真实短信。
