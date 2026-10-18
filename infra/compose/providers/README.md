# 预发节点的可选 Provider 与观测配置

基础 `node.yml` 保持未配置降级。`node-step.sh` 只按 `LYX_NODE_PROVIDERS` 选中本目录的固定文件；不接受外部 Compose 路径，不把整个密钥目录挂进容器。此处只交付本地配置能力，未执行服务器部署或真实云请求。

## 启用与关闭

由业主在节点的 `/opt/liyoxi/node.env` 写非敏感设置，一行一个 `键=值`，不加引号。默认 `LYX_NODE_PROVIDERS=`。例如准备语音识别和证照识别时：

```dotenv
LYX_NODE_PROVIDERS=asr ocr
```

可选名字为 `cos ci asr asr-callback ocr mail llm media-production client-errors alerts server-errors wechat`，空格分隔；未知或重复名字会拒绝。`asr-callback` 必须同时选 `asr`。脚本不执行 `node.env` 的内容。

选择顺序是进程环境、节点 `node.env`、仓库 `stg.env`。进程环境显式为空会关闭本次调用的所有可选能力；永久启用必须写在节点 `node.env`，确保 systemd 重启时仍使用同一配置。删除某一名字后，后续重建容器不再挂载该组；修改配置本身不会重建已经运行的容器，需按现有发布步骤生效。

配置文件放在节点密钥目录，默认 `/opt/liyoxi/secrets/`；目录 `0700`、文件 `0400`、属主 UID `1000`，普通非空文件，不得为符号链接。`gen-secrets.sh` 只生成基础九项，不生成云平台凭据。选中的组缺少文件会阻止密钥检查；未选中且没有文件时保持原降级行为，已有文件仍接受权限检查。

## 文件与进程的对应关系

所有文件只读挂在 `/run/secrets/<文件名>`，通过表内的 `*_FILE` 变量交给既有配置解析器。`check-env` 是无网络的一次性容器，聚合读取所选文件做格式检查；下表的 API/worker 是实际常驻容器的隔离范围。

| 能力 | 文件 → 环境变量 | 常驻容器 |
| --- | --- | --- |
| `cos` | `cos-signer-keys.json` → `COS_SIGNER_KEYS_FILE`；`cos-sts-issuer-keys.json` → `COS_STS_ISSUER_KEYS_FILE` | API |
| `cos` | `cos-worker-keys.json` → `COS_WORKER_KEYS_FILE` | worker |
| `ci` | `ci-callback-key` → `CI_CALLBACK_KEY_FILE` | API、worker |
| `ci` | `ci-worker-keys.json` → `CI_WORKER_KEYS_FILE` | worker |
| `asr` | `asr-tencent.json` → `ASR_TENCENT_FILE` | API、worker |
| `asr-callback` | `asr-callback-key` → `ASR_CALLBACK_KEY_FILE` | API、worker |
| `ocr` | `ocr-tencent.json` → `OCR_TENCENT_FILE` | API、worker |
| `mail` | `mail-tencent.json` → `MAIL_TENCENT_FILE` | worker |
| `llm` | `llm-domestic.json` → `LLM_DOMESTIC_FILE` | API、worker |
| `media-production` | `media-production.json` → `MEDIA_PRODUCTION_FILE` | API、worker |
| `client-errors` | `client-error-projects.json` → `CLIENT_ERROR_PROJECTS_FILE` | API |
| `alerts` | `alerts.json` → `ALERTS_FILE` | worker |
| `server-errors` | `server-errors.json` → `SERVER_ERRORS_FILE` | API、worker |
| `wechat` | `wechat-secret` → `WECHAT_SECRET_FILE`；`wechat-message-token` → `WECHAT_MESSAGE_TOKEN_FILE`；`wechat-message-aes-key` → `WECHAT_MESSAGE_AES_KEY_FILE` | API、worker |

`mediatool`、gateway、数据库、Redis、迁移与播种容器均不增加这些文件。API 和 worker 的媒体工具配置使用同一 `work:/work` 卷与 `mediatool` 健康依赖，`check-env` 不需要工作卷。

### 微信小程序与唯一消息接收地址

仅在明确启用微信时，在节点 `node.env` 的原有选择列表加入 `wechat`，并单独填写非敏感的 `WECHAT_APPID`。例如以下仅展示占位结构，不可用作真实验收：

```dotenv
LYX_NODE_PROVIDERS=wechat
WECHAT_APPID=replace-with-authorized-appid
```

业主另将三份原始 UTF8 文件写入密钥目录：`wechat-secret` 为 AppSecret（1–256 个可见 ASCII 字符），`wechat-message-token` 为唯一消息接收地址的 Token（1–128 个可见 ASCII 字符），`wechat-message-aes-key` 为 EncodingAESKey（规范的 43 字符 base64，解码后 32 字节）。文件权限与属主遵循上文，不将内容写入 `node.env`、argv 或日志；末尾换行由现有解析器处理。

选中后 Compose 要求非空 `WECHAT_APPID`，密钥检查要求三个文件齐备；发布的 `check-env` 再用既有 `loadEnv` 离线验证完整四项与格式。API 用于登录换取和唯一消息回调，worker 用于微信令牌及异步能力；两者共用同一个完整成组解析，因此三份文件均交给这两个进程和 `check-env`，不交给其他容器。基础配置不透传这些键；未选择 `wechat` 时，即使节点已有文件或 APPID 也不挂载、不自动启用。

本接线不含微信支付配置，不更改登录、隐私、回调验签或消息路由规则。配置齐备与离线检查通过不代表已验证真实微信请求、平台唯一回调配置、体验成员、隐私声明或真机登录；这些仍按 V19/V03 和预发台账单独验收。

OCR 的 API 角色用于同步证照识别，worker 角色用于 W4-04 的异步银行回单识别；只有明确选中 `ocr` 才挂载同一份可选配置。该接线依赖回单 OCR 运行时前置，不代表云端权限、识别准确率或预发部署已经验证。

邮件只有显式选择 `mail` 才给 worker 与 check-env 挂载独立 `mail-tencent.json`，API 无发信密钥。
文件严格包含 `secretId`、`secretKey`、`region`、`fromAddress`、`templateId`；region 为 `ap-guangzhou` 或 `ap-hongkong`，独立于 COS 地域。
发信地址和 `{{text}}` 模板须通过真实平台审核，格式及限制见[邮件驱动](../../../packages/services/src/providers/mail/README.md)。
文件校验通过不代表域名/模板审核、邮件受理或邮箱送达，未执行真实节点部署或发信。

非敏感标量也在节点 `node.env` 配置；选中对应组后缺少任何必填项会由 Compose 拒绝：

| 能力 | 必填标量 |
| --- | --- |
| `cos` | `COS_REGION`、`COS_BUCKET_SECURE`、`COS_BUCKET_ASSET`、`COS_BUCKET_MEDIA`、`COS_BUCKET_PUB` |
| `ci` | `CI_REGION`、`CI_BUCKET_SECURE`、`CI_BUCKET_ASSET`、`CI_BUCKET_MEDIA`、`CI_BUCKET_PUB`、`CI_CALLBACK_ORIGIN` |
| `asr-callback` | `ASR_CALLBACK_ORIGIN` |

COS 的地域和四桶挂给 API/worker；CI 的地域和四桶只挂给 worker，API 仅接回调 origin 与回调密钥。四桶必须使用实际同一账号的物理桶名，回调 origin 必须为固定 HTTPS 根地址。开启 COS 后，前端的 `LYX_MEDIA_ORIGINS`、桶 CORS、下载白名单及小程序合法域名还需按实际域名配置。

文件内容沿用 [环境变量示例](../../../.env.example) 和 [配置解析器](../../../packages/services/src/kernel/env.ts) 的严格格式：角色密钥是独立 `secretId/secretKey` JSON；ASR 与 OCR 使用各自 JSON（OCR 另有 `region`）；国内模型提供 `text`、`vision` 两路的 `primary/backup`，不填写任意上游 URL。两种回调密钥应使用各自独立文件和密钥。

`media-production.json` 的 `workDir` 必须对应挂载目录 `/work`，`socketPath` 为 `/work/.sock/mediatool.sock`，并包含完整 `aigc` 主体字段及六个 `templates` ID。主体信息与模板 ID 必须由实际平台和业务配置确认，不能把示例 ID 当作真实可用模板。媒体生产的云存储和云处理还需要分别准备 `cos`、`ci`。

## 两组观测 FILE（W2-27b1）

由获准运维在节点 `node.env` 选择 `LYX_NODE_PROVIDERS=client-errors alerts`，两个名字可分别启用，也可与原七组组合。默认空不挂这两份文件，不启动新的外呼能力；选中后文件必须存在并通过原 `check-secrets` 属性检查与 `check-env` 格式检查。文件内容只在既有进程里读取，不写进 Compose environment、命令参数或日志；API 不挂 alerts，worker 不挂 client-errors。

`client-error-projects.json` 严格为 `projects` 数组，1–3项；每项只允许必填 `dsn` 与可选 `upstreamDsn`，均须合法 HTTPS DSN（公钥用户名、数字项目号，无密码/查询/片段），项目白名单不能重复。上游未填不代表已接通 SaaS；生产解析器不接受本机 HTTP 假地址。

`alerts.json` 为不超过4KiB的严格JSON，只允许可选 `robotKey`、`oncallPhones`、`p2Immediate`。robotKey只能是既有格式的原始token，不是URL；值班号码至多16个且不重复，规则名字至多64个且不重复。省略p2Immediate沿现有首月默认白名单，显式空数组表示P2均非即时；规则是否已登记仍由既有worker装配核对。未给机器人key/值班人时相应通道仍未配置，不能把文件存在或格式通过当成接受/送达。

本片只让已实现配置公口从节点文件抵达正确角色。假收件演练、源码映射上传、真实群/短信/SaaS接通与费用授权均未在本片执行；没有添加可改写生产机器人URL或放宽客户端DSN的配置。

## 启动前检查与真实验收边界

服务端自身错误出口单独选择`server-errors`，不复用客户端项目文件。server-errors.json为≤4KiB普通UTF8严格JSON，形如`{ "api": { "dsn": "https://public@errors.example.invalid/1" }, "worker": { "dsn": "https://public@errors.example.invalid/2" } }`，至少配置一个组件；只允许api/worker及各自dsn，无任意endpoint或额外字段。DSN须HTTPS、公钥用户名/数字项目，无密码/查询/片段；两个常驻进程仅消费本组件，check-env离线聚合校验。默认空选择不挂文件，未配组件不外呼，文件内容不进入argv/environment/log。

此配置不增加SDK、性能追踪或源码映射上传；服务端只报固定摘要/安全标签和自有dist第一方坐标，不传原始stack、SQL、请求、cause或details。真实SaaS收件和源码还原仍另行验收，不能以配置存在或本地替身通过冒称接通。

先按已有发布流程运行 `check-secrets.sh`，再运行 `node-step.sh check-env <镜像标签>`。独立的 `check-secrets.sh --service api` / `--service worker` 会读取同一选择器，只要求本服务所需文件；因此 systemd 启动前也会检查。输出只报文件名、键名和原因，不打印文件内容。

这两项检查不验证 CAM 权限、桶状态、云模板存在、真实回调到达、OCR 准确率或费用。模型 FILE 通过解析也不会自动提高调用预算；仍沿用现有模型预算检查和管理入口，不自动修复损坏账本。真实平台步骤须由业主提供资源并逐步授权，结果记录在 [M3 回顾](../../../docs/plan/retro/m3.md) 的外部验收表。
