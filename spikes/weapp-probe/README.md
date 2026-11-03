# X-01 真机探针（第一段）

此独立工程交付 V19 手机号、V8 普通二维码、V3 分块上传、V7 下载存相册的执行工具。当前没有任何真机结论。工程测试只能验证替身协议与恢复逻辑；真实接口是否可用、三台机表现和体验判断由业主按 [CHECKLIST](CHECKLIST.md) 回传。V3/V7 调试模式只能记初测，登记合法域名后的复测仍未做。

依赖只在本目录的 pnpm workspace（app、server）内，不能由根应用引用；不用数据库、Redis 或 services/contract 包。服务只保存进程内账号/票据/上传登记，服务重启会清空它们，执行同一轮续传时不要重启服务。客户端杀进程后仍可根据原文件摘要重新登记到相同对象键。

## 1. 本地 fake 验证（会话可执行）

Node 24.20.0 / pnpm 10.34.5；工作目录为仓库根：

```sh
pnpm --dir spikes/weapp-probe install --frozen-lockfile
pnpm --dir spikes/weapp-probe typecheck
pnpm --dir spikes/weapp-probe test
pnpm --dir spikes/weapp-probe build
PROBE_MODE=fake pnpm --dir spikes/weapp-probe server
```

浏览器打开 `http://127.0.0.1:4310/desktop`。探针导入 `app/dist/`，默认测试 AppID `touristappid`；模拟器中 fake 页只演练端点，不上传 COS、不调手机号付费接口、不下载/存相册，不能记为真机成功。`PROBE_MODE=fake … fixtures` 只输出计划，不造媒体、不联网；fake report 写 `results/fake-summary.md`，不会覆盖真实 summary。fake 模式在读取凭据前立即返回，即使配置了 `*_FILE` 也不读文件。

构建器禁止 Taro/Vite 自动读取任何 `.env*` 文件。构建只取进程中的公开 `PROBE_BASE_URL` / `PROBE_APPID`，不把服务器凭据传到 app。不要在仓库内放凭据文件。构建产物不提交。

## 2. 业主实际执行顺序

1. 核对既有 AppID 的成员和隐私指引，不覆盖参考工程留下的配置。参与测试至少两个微信账号均有开发者权限；隐私指引含手机号、选中照片或视频、相册仅写入、聊天文件。基础库最低 2.32.3，在开发者工具手动选当前稳定基础库并记录实际版本。
2. 在仓库之外创建 `~/.lyx/x01-probe.env`，权限设为 `0600`，按 `.env.example` 的七个键填值（无 `export`，每行 `KEY=value`）。`COS_TEST_PREFIX` 必须为 `x01/<本轮标识>/`，例如 `x01/owner-run/`；AppID 使用既定的 `wx66a51228082e82d4`。不向会话粘贴文件内容。服务默认 real；读不到文件时仅打印 `PROBE_SECRETS_FILE`，缺项仅打印键名。单独文件挂载模式给每个键设置相应的 `<KEY>_FILE`（七项都要），不会回退读取整份文件或明文环境变量。
3. 子账号只授权测试桶：写 `incoming/*`（分块初始化/上传/完成/中止/列表/HEAD 校验）、写读上述 `x01/<本轮>/`（fixture 命令需上传、HEAD 与签读）以及获取 STS 凭据。子账号权限与 STS Policy 取交集；前端 STS 进一步固定到单个 `incoming/{fileId}/*`、30 分钟、无对象读取权限。ListMultipartUploads按桶授权但以cos:prefix严格限制到该文件键，不能列其他文件。确认它能在测试前缀上传 fixture，不能仅给测试前缀读权限。不要使用主账号密钥。
4. 电脑需有 `ffmpeg`（支持 libx264/AAC）和至少 2GB 可用磁盘。以下两条分别在业主终端执行，第二条会生成并上传共 1,390MB 的测试文件，有 COS 请求/存储费用：

```sh
PROBE_MODE=real PROBE_PORTAL_ORIGIN=https://portal.timavia.com pnpm --dir spikes/weapp-probe server
# 另开终端；服务保持运行
PROBE_MODE=real pnpm --dir spikes/weapp-probe fixtures
```

可用 `PROBE_SECRETS_FILE=/absolute/private/file` 改凭据位置；`PROBE_PORT` 默认 4310。服务监听 `0.0.0.0`，电脑防火墙允许手机局域网访问 4310，只在受信任测试网使用。启动只显示模式与各能力已配置/未配置，不输出值。

5. 从电脑网络设置读出局域网 IP，用这个公开地址构建（不要用手机自己的 127.0.0.1）：

```sh
PROBE_APPID=wx66a51228082e82d4 PROBE_BASE_URL=http://192.168.1.20:4310 pnpm --dir spikes/weapp-probe build
```

把示例 IP 换成电脑实际 IP。开发者工具导入 `spikes/weapp-probe/app/dist/`，打开开发调试，手机与电脑同一 Wi-Fi，使用开发预览码；不上传体验版、不发布、不提审。真机网络连通性先验证 `/api/probe/health`。电脑二维码页是 `http://<电脑IP>:4310/desktop`，每轮点“新建票据”；其二维码内容是普通 HTTPS URL，扫描后探针只取票据 token，不打开网站、不调用小程序码接口。

6. 把 `dist/fixtures/{150,300,500}mb.mp4` 通过自己电脑传到三台手机可被“聊天文件/相册”选择的位置。测试片为 360×640、H.264+AAC、moov 前置的 6 秒测试图；用标准 MP4 `free` box 填足精确体积，验证的是字节/存储边界，不据此推断长视频播放/码率。这里 MB = 1,000,000 字节，避免 200MiB 超过 200MB 上限。压缩重选要记录压缩前后实际体积。
7. 按 [CHECKLIST](CHECKLIST.md) 三机逐项执行。V19 每次成功取手机号均计费（快速/实时各有 1,000 次体验额度；实际剩余额度由业主看平台）。V3 蜂窝仅 150MB 每机一次，V7 两台主力机各 80×50MB 会产生每机约 4GB 的下载与相册占用。请先确认流量和磁盘。不要为了低存储测试删除已有用户数据，使用可控测试存储环境。
8. 所有页面都会自动记录成功/失败/取消/中断；未送出的脱敏尝试保存在探针本地，恢复网络后使用“补传记录”。网络从 Wi-Fi 切换蜂窝时，手机不能再直连电脑局域网服务；需要业主自备可达测试服务地址（或手机保持可访问的热点/网络拓扑），没有可达服务就把蜂窝场景记未测，不以 Wi-Fi 假替。预发先到位时，由业主操作一次性服务与文件凭据，构建地址指预发；工程本身不部署。
9. 在业主终端执行 `pnpm --dir spikes/weapp-probe report`。它读取已经写前脱敏的日志并生成 `results/summary.md`；核对并补 CHECKLIST 人工记录（尤其 V19 体验判定、V8 电脑轮询结束、V7 相册与残留）。只回传过目的 `summary.md`、填写后的记录栏和裁剪脱敏截图；不要回传原始日志、HAR、二维码票据、签名 URL 或终端凭据。会话不读取 `server/.logs/`。
10. 工程先开草稿 PR，等实测后再写 ADR、四项台账与计划结论，不提前关闭 V。合并后的凭据作废、清理测试对象/文件由业主操作；登记合法域名后用同一清单复测 V3/V7。

## 3. 行为与 HTTP 边界

基址 `/api/probe`，JSON 直出，错误只返回 `{error: "符号名"}`，没有外部 errmsg/堆栈。`POST /login {code}` 换进程内 Bearer 会话；`POST /phone {code,kind}` 返回脱敏手机号、账号随机 ID 和已关联微信数量，快速组件跨微信关联已有账号/换号返回 `REALTIME_REQUIRED`，使用实时组件后可继续。openid 只取散列做内存键，session_key 不回传不入账。

`POST /scan/tickets`（电脑页特定头）创建 22 位公开 token、8 位 Crockford 短码、两位配对数、独立 pollSecret；二维码页以 2 秒周期带 `X-Poll-Secret` 轮询，120 秒失效。小程序 `/scan/lookup` 只拿三个候选数，不知正确答案；`/scan/confirm` 必须已绑定手机号，错配三次作废。电脑状态到 confirmed 才算全链走完。

`POST /uploads {clientToken,size}` 按身份+原文件摘要复用对象键；`/uploads/:fileId/credentials` 只能取自己文件的30分钟临时凭据；`/confirm {size}` 用服务端 HEAD 核实际大小。4MiB分块、单文件、分块并发2、putObject简单上传、单请求Timeout=120000。SDK列表到的已完成块与本次发送块做交集；无法观测时保持未知，不能宣称零重传。

`GET /downloads/:sizeMb?mode=temp|user_dir` 只支持 30/50/60/100/150/200MB，服务端HEAD确认实际体积，现签15分钟读URL，超时 clamp(大小/100KB每秒,120秒,900秒)。压力探针按X-01任务书两种模式都测并发2及完整体积档；D7生产降级user_dir应并发1、上限150MB，这里的压力观察不能直接替代生产参数。temp不传filePath，存相册后finally清理；user_dir也清理；失败与中断不自动当成功，保存阶段进程中断需要人工核对相册再恢复，防重复保存。

`POST /attempts` 只接受固定字段；不接收自由备注/异常原文、凭据或完整URL；已知敏感值、手机号和URL在写入前再次脱敏。attemptId按身份去重。report按设备/系统/基础库/网络/场景/体积/落盘分组算成功率、中位耗时、最大耗时，同时列明细；失败/取消/中断留在分母，不用fake补真机缺口。服务端内存表只供这次受控验证，不是生产鉴权/持久化服务。

## 4. 常见错误

| 提示 | 处理 |
| --- | --- |
| `PROBE_SECRETS_FILE` 或大写配置键 | 仅业主核对仓库外绝对路径、0600和对应键值；不要把文件发给会话 |
| `AUTH_REQUIRED` | 服务可能重启/会话过期，重新登录；同轮续传请保持服务运行 |
| `REALTIME_REQUIRED` | 用实时手机号按钮完成跨微信关联或换号 |
| `WX_112` | 查当前AppID隐私保护指引和授权；开发版也受约束 |
| `WECHAT_1400001` | 平台体验额度不足，由业主处理；不要自动重试付费组件 |
| `PHONE_REQUIRED` | 先在V19页完成手机号绑定，再测V8 |
| `TICKET_EXPIRED`/`PAIR_MISMATCH` | 新建二维码票据；记录失败后再重做 |
| `STS_FAILED`/`OBJECT_UNAVAILABLE` | 核受限账号和桶前缀权限、COS区域/后台IP白名单；不输出底层凭据异常 |
| `TIMEOUT`/`INTERRUPTED` | 保留失败记录，再按原文件续传或恢复下载队列 |
| `PERMISSION_DENIED`/`STORAGE_LIMIT` | 在页面去设置授予相册写入；低存储场景记录实际现象 |
| `FFMPEG_REQUIRED` | 业主安装带libx264/AAC的ffmpeg后重跑fixtures；不会上传半成品 |
| `FIXTURE_SIZE_MISMATCH` | fixtures没有全部上传，或传输工具改变了文件大小；服务只认精确测试档 |

## 5. 依赖与一手资料

2026-11-03查询官方npm registry：`cos-nodejs-sdk-v5@3.0.0` 2026-07-10T08:25:33.358Z；`qrcode@1.5.4` 2024-08-05T21:52:58.518Z；`cos-wx-sdk-v5@1.8.0` 2025-05-19T08:08:27.019Z。前两项采用当时已满7天的最新稳定版本，其余沿本仓库精确版；lock由独立安装生成。安装脚本仅白名单，minimumReleaseAge=10080，trustPolicy沿根；Taro链三个可信级别例外沿W0-27a。测试根明确用已在仓库使用的Vite8.3.1，否则Vitest4会被app Vite4的提升解析破坏；app仍固定Vite4.5.14。另把Taro插件在app工作目录按名称解析的两个Babel插件（decorators/class-properties 7.29.7，根锁已有）显式列为app构建依赖，避免依赖根提升。

协议依据：[稳定版凭据](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/mp-access-token/getStableAccessToken.html)、[code2Session](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html)、[手机号换取](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-info/phone-number/getPhoneNumber.html)、[COS小程序SDK](https://cloud.tencent.com/document/product/436/31953)、[COS Node SDK](https://cloud.tencent.com/document/product/436/8629)、[STS GetFederationToken](https://cloud.tencent.com/document/api/1312/48195)、[TC3签名](https://cloud.tencent.com/document/api/213/30654)、[COS授权策略](https://cloud.tencent.com/document/product/436/31923)、[COS条件键](https://cloud.tencent.com/document/product/436/71306)。本轮微信开发文档站点抓取受限，接口形状同时对照任务书和已有仓库驱动；真实HTTP未调用，不据假请求测试宣称微信联调通过。

没有从固定参考库借文件；构建布局沿当前仓库 apps/weapp，源码在本独立目录内重新实现。
