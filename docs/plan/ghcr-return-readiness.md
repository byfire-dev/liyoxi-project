# 迁回后的镜像与预发准备

2026-10-18，目标源码仓为 `byfire-dev/liyoxi-project`。本页接续[迁回台账](repository-return.md)，只登记实际核验结果，不替代同提交发布门禁或真实平台验收。

## 首次节点部署当前状态

2026-10-19，已留存首次节点部署核验：固定源码为`22e8a2d5b7c5ce8a1e9ac5ee739db6ce6c822f97`（`sha-22e8a2d5b7c5`），与后续开发中的main分开记录。

| 核验 | 已证实范围 |
| --- | --- |
| 四应用镜像 | 原生`ghcr.io/byfire-dev/liyoxi/{server,gateway,mediatool,weapp-uploader}:sha-22e8a2d5b7c5`已核摘要与源码revision一致，架构为`linux/amd64` |
| 节点运行 | postgres、redis、mediatool、worker、api、gateway六服务运行且版本匹配；API healthz/readyz为200、worker租约正常 |
| 配置与数据库 | 配置静态检查、迁移、种子配置核对以及数据库角色/授权/表/约束/分区检查通过；不作为真实业务数据或容量验收 |
| 公网与消息推送 | API/管理后台/下载页HTTPS探测为200；正确`https://api.stg.liyoxi.timavia.com/api/v1/hooks/wechat/messages`签名GET为200且echo一致。业主随后确认“微信小程序已完成配置”，按该上下文登记微信后台消息推送配置完成 |

E2仍整体进行中：这次确认不覆盖认证、类目、代码上传密钥、体验版上传、真机或真实COS上传/支付。weapp-uploader镜像已到节点，不表示执行过小程序上传。首次手动引导核验已单独留档，没有补造自动发布历史；后续源码须按自己的发布门禁交付，不能沿用固定22e8部署结果。

## 公开构建配置

目标仓 Actions variables 首次查询为空。以下四项按既有 AppID、预发域名与当前仓库身份补回；均为公开配置，不含凭据：

| 变量 | 值 |
| --- | --- |
| `STG_REGISTRY` | `ghcr.io` |
| `STG_REGISTRY_NAMESPACE` | `byfire-dev/liyoxi` |
| `STG_WEAPP_APPID` | `wx66a51228082e82d4` |
| `STG_WEAPP_API_BASE_URL` | `https://api.stg.liyoxi.timavia.com` |

2026-10-18 补录公开变量时，四次创建均返回201，随后独立GET读回确认四项值完全一致且无其他变量；当时镜像发布、COS制品上传、源码映射上传、部署及小程序上传开关均未开启。固定22e8的首次节点核验以后续当前状态为准，不据此推断其他开关现值。

## 镜像目标与待核项

| 内容 | 目标或处置 | 当前边界 |
| --- | --- | --- |
| API / worker 共用镜像 | `ghcr.io/byfire-dev/liyoxi/server:sha-<12位源码SHA>` | 固定`sha-22e8a2d5b7c5`已原生GHCR交付并完成节点摘要/revision/amd64核验 |
| 网关及网页 | `ghcr.io/byfire-dev/liyoxi/gateway:sha-<12位源码SHA>` | 固定`sha-22e8a2d5b7c5`已原生GHCR交付并完成节点摘要/revision/amd64核验 |
| 媒体工具 | `ghcr.io/byfire-dev/liyoxi/mediatool:sha-<12位源码SHA>` | 固定`sha-22e8a2d5b7c5`已原生GHCR交付并完成节点摘要/revision/amd64核验 |
| 小程序上传工具 | `ghcr.io/byfire-dev/liyoxi/weapp-uploader:sha-<12位源码SHA>` | 固定22e8镜像已到节点并核验；未执行小程序上传 |
| PostgreSQL / Redis | 同 namespace 的 `postgres:17`、`redis:7` | 首次节点两项依赖已运行；镜像转存按专用mirror记录，不用四应用核验替代 |
| MinIO | 继续使用[原公共包及固定摘要](../../infra/docker/minio-recovery.md) | 不随源码仓改名替换；未删除或重发原包 |
| 节点镜像前缀 | 预期`LYX_IMAGE_PREFIX=ghcr.io/byfire-dev/`，Compose 自行追加 `liyoxi/...` | 固定22e8四应用的原生GHCR来源已核，不在本文记录节点配置文件内容 |

2026-10-18 首次发布前核验时 CLI 缺少 `read:packages`，Packages 清单请求返回 403 后停止重试。业主完成授权后，已确认活跃账号为 byfire-dev 且包含该 scope；重新请求返回 200，完整清单中没有 `liyoxi/` 目标包，因此本轮不存在目标包名冲突。以上保留发布前时点；固定22e8四应用的实际交付以页首当前核验为准，后续版本及每包状态分别取对应发布证据。四应用构建已有 OCI source/revision 标签；公开源码仓不自动证明包公开。

Actions 的 GHCR 推送使用本仓 `GITHUB_TOKEN` 和 job 的 `packages: write`，不需要向聊天提供个人令牌。后续每次发布仍须确定包可写、公开配置读回正确、版本来源明确；发布后逐包核公开访问、摘要和来源。

## 2026-10-18 发布前检查记录

本节保留当时的失败、DNS与证书准备记录；当前固定22e8已部署，不再以本节当时的“未部署”描述现况。

`745a6bd52f96111851374e4d71d0e73985ce1b4b` 的 [images](https://github.com/byfire-dev/liyoxi-project/actions/runs/39115755984) 与 [stack-smoke](https://github.com/byfire-dev/liyoxi-project/actions/runs/39115755976) 成功，尚不是镜像发布或节点部署证据。

该提交的 [main-push CI](https://github.com/byfire-dev/liyoxi-project/actions/runs/39115756008) 在后台真实登录验收失败：恢复码已出现后，测试未找到精确名称为“已保存，关闭”的按钮；55 项 live 用例中 54 项通过。失败 DOM 和截图确认按钮实际存在且禁用，但提交按钮遗留的 loading 图标把可访问名称变成了“loading 已保存，关闭”。修复为两个阶段的按钮分配独立 React key，保留原精确定位、保存前禁用和关闭限制；专项用例已完成旧实现失败、新实现通过。其他实质检查通过，required 失败；仍待修复提交的 CI，原 PR 绿色不能替代该结果。

该提交的 [mixed-smoke](https://github.com/byfire-dev/liyoxi-project/actions/runs/39115755947) 已成功构建两版镜像，以 `d5384a867c2f8abae3fb23adbac8f7e8957c1392` 为 first-parent-bootstrap。head-write、old-read-write 均完成 20 集业务链，各 123 项不变量零违规；随后在 head-read 阶段报 `rpc-timeout`。报告未细分该阶段的 start/read/drain/close，尚不能断言超时的具体 RPC。此次失败不是早先迁回提交的 `driver-missing`，必须按当前日志修复。发布仍要求同仓、main-push、同完整 SHA 的 images 与 mixed-smoke 成功。

首次公网查询以下三域没有 A 答案。业主补齐后，2026-10-18 19:15（北京时间）再次通过 Google DNS-over-HTTPS 独立核验：三域均返回 `Status=0`，A 记录全部为 `101.133.161.191`，DNS 已备齐：

- `api.stg.liyoxi.timavia.com`
- `admin.stg.liyoxi.timavia.com`
- `portal.stg.liyoxi.timavia.com`

本机解析器返回的 `198.18.x.x` 不作为公网配置完成证据。2026-10-18 本轮已通过既有 SSH 入口核验节点，三个 ACME 站点的公网随机内容校验全部通过且临时文件已清理；复用既有 ACME 账号签得覆盖三域的一张 Let’s Encrypt SAN 证书，2027-01-16 到期。仅把三个预发站点切换为仓内模板的 HTTPS 配置，原文件已独立备份，`nginx -t` 与 reload 均成功；既有公司站点配置哈希未变。续签 timer 已运行，既有 service 包含成功续签后的 nginx reload，不另增重复定时任务。证书私钥未读回、未入库。

安装后已从公网对三个域名分别完成可信 TLS 连接，信任链、SAN 与有效期校验通过，HTTP 均为 502：节点尚无应用容器，故 DNS 与 HTTPS 已备齐，应用仍未部署。公司原入口前后响应一致（主域 308、www 200、既有 api 502），未将既有 api 的 502 归因于本次变更。应用发布仍等待同 SHA 门禁与镜像交付。

首次真实登录的微信节点接线见[可选 Provider 配置](../../infra/compose/providers/README.md)：显式选择 `wechat` 后才挂载 AppID 与三份完整成组文件；本地接线验证不代表真实凭据已录入或微信后台能力已开通。先从一位商家、一家门店的登录和普通上传开始，须核账号初始化、生效登录协议、微信合法域名/隐私声明/体验成员及 COS 分权/CORS；扩展至成片流程时再核 CI 模板、队列、回调与制作配置。

真实平台与真机体验继续按[平台配置](platform-config.md)、[业主清单](owner-checklist.md)和[体验版清单](weapp-trial.md)核验。短信、OCR、模型、邮件、支付等按实际启用功能分别准备；正式容量验收另在合适环境执行，不用本机降量结果替代。
