# 迁回后的镜像与预发准备

2026-10-18，目标源码仓为 `byfire-dev/liyoxi-project`。本页接续[迁回台账](repository-return.md)，只登记实际核验结果，不替代同提交发布门禁或真实平台验收。

## 公开构建配置

目标仓 Actions variables 首次查询为空。以下四项按既有 AppID、预发域名与当前仓库身份补回；均为公开配置，不含凭据：

| 变量 | 值 |
| --- | --- |
| `STG_REGISTRY` | `ghcr.io` |
| `STG_REGISTRY_NAMESPACE` | `byfire-dev/liyoxi` |
| `STG_WEAPP_APPID` | `wx66a51228082e82d4` |
| `STG_WEAPP_API_BASE_URL` | `https://api.stg.liyoxi.timavia.com` |

四次创建均返回 201，随后独立 GET 读回确认四项值完全一致且无其他变量。镜像发布、COS 制品上传、源码映射上传、部署及小程序上传开关均未开启。

## 镜像目标与待核项

| 内容 | 目标或处置 | 当前边界 |
| --- | --- | --- |
| API / worker 共用镜像 | `ghcr.io/byfire-dev/liyoxi/server:sha-<12位源码SHA>` | 待首次发布与匿名拉取核验 |
| 网关及网页 | `ghcr.io/byfire-dev/liyoxi/gateway:sha-<12位源码SHA>` | 待首次发布与匿名拉取核验 |
| 媒体工具 | `ghcr.io/byfire-dev/liyoxi/mediatool:sha-<12位源码SHA>` | 待首次发布与匿名拉取核验 |
| 小程序上传工具 | `ghcr.io/byfire-dev/liyoxi/weapp-uploader:sha-<12位源码SHA>` | 发布镜像不代表已向微信上传体验版 |
| PostgreSQL / Redis | 同 namespace 的 `postgres:17`、`redis:7` | 仅手动 `mirror_base` 转存既有固定多架构摘要；待执行 |
| MinIO | 继续使用[原公共包及固定摘要](../../infra/docker/minio-recovery.md) | 不随源码仓改名替换；未删除或重发原包 |
| 节点镜像前缀 | 预期 `LYX_IMAGE_PREFIX=ghcr.io/byfire-dev/`，Compose 自行追加 `liyoxi/...` | 尚未读取或更改节点配置 |

CLI 当前登录 byfire-dev，已有仓库权限，但缺少 `read:packages`；Packages 清单请求返回 403 后停止重试，等待只读权限授权。因此包是否存在、关联仓库、Actions 写入权限、每包公开状态仍待真实核验，不能把清单不可读写成“没有包”。四应用构建已有 OCI source/revision 标签；公开源码仓不自动证明包公开。

Actions 的 GHCR 推送使用本仓 `GITHUB_TOKEN` 和 job 的 `packages: write`，不需要向聊天提供个人令牌。只有确定包可写、公开配置读回正确、版本来源明确后再执行一次发布；发布后逐包核公开访问、摘要和来源。

## 当前检查与预发条件

`745a6bd52f96111851374e4d71d0e73985ce1b4b` 的 [images](https://github.com/byfire-dev/liyoxi-project/actions/runs/39115755984) 与 [stack-smoke](https://github.com/byfire-dev/liyoxi-project/actions/runs/39115755976) 成功，尚不是镜像发布或节点部署证据。

该提交的 [main-push CI](https://github.com/byfire-dev/liyoxi-project/actions/runs/39115756008) 在后台真实登录验收失败：恢复码已出现后，测试未找到“已保存，关闭”按钮；55 项 live 用例中 54 项通过。其他实质检查通过，required 失败；原 PR 绿色不能替代该结果，原因仍在定位。

该提交的 [mixed-smoke](https://github.com/byfire-dev/liyoxi-project/actions/runs/39115755947) 已成功构建两版镜像，以 `d5384a867c2f8abae3fb23adbac8f7e8957c1392` 为 first-parent-bootstrap。head-write、old-read-write 均完成 20 集业务链，各 123 项不变量零违规；随后在 head-read 阶段报 `rpc-timeout`。报告未细分该阶段的 start/read/drain/close，尚不能断言超时的具体 RPC。此次失败不是早先迁回提交的 `driver-missing`，必须按当前日志修复。发布仍要求同仓、main-push、同完整 SHA 的 images 与 mixed-smoke 成功。

公网 Google DNS-over-HTTPS 查询以下三域均返回 `Status=0`、无 A 答案：

- `api.stg.liyoxi.timavia.com`
- `admin.stg.liyoxi.timavia.com`
- `portal.stg.liyoxi.timavia.com`

本机解析器返回的 `198.18.x.x` 不作为公网配置完成证据。三个应用域的 A 记录需指向既定预发服务器；DNS 生效后再核 HTTP ACME 入口、签发证书并验 HTTPS。本轮未 SSH、签证书、启动应用、部署或使用真实云凭据。

真实 COS、微信、邮件与真机体验继续按[平台配置](platform-config.md)、[业主清单](owner-checklist.md)和[体验版清单](weapp-trial.md)核验。先从一位商家、一家门店验证最小真实交付链；正式容量验收另在合适环境执行，不用本机降量结果替代。
