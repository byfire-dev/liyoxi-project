# 参考工程 timavia-liyo-project：小程序工程、基础设施与平台配置经验梳理（ref-ops）

> 撰写日期：2026-10-02。只读调研，未修改参考工程与资料目录。
>
> **路径约定**：`ref/` = `timavia-liyo-project/`；`PRD.md:行号` = `scratchpad/src/PRD.md`；【原型 merchant/X】【原型 admin/X】= `scratchpad/slim/{merchant,admin}/X.txt`。
>
> **出处与可信度约定**
> - 未加标注的条目 = 参考工程的文档 / 代码**明确写了**，后面给文件与行号。
> - 【推断】= 资料没有明写，是本报告根据上下文作出的判断或建议，需架构师确认。
> - 【外部】= 来自网页（给 URL），不是参考工程的内容。
> - 「生产实况」一律引自参考工程文档里 **2026-09-16 在生产机只读核验**的记录（`ref/docs/07-platform-config.md:9`、`ref/docs/08-deployment.md:5`），本次调研**没有登录生产机**，也**没有读取任何 `.env`**（仓库根 `.env`、`apps/mobile/.env.development`、`.env.production`、`.env.production.bak-2026-09-08` 都没读，只读了 `.env.example`）。参考工程最后一次提交是 2026-09-26（`f1361e3`），09-16 之后生产有没有变，仓库里核不了。

---

## 0. 先看这几条

1. **参考工程自己也叫「狸有戏（Liyo）」**，定位是「AI IP 操盘手」（`ref/README.md:1-3`、`ref/apps/mobile/project.config.json:4`、`ref/apps/mobile/src/app.config.ts:88` 导航栏标题就是「狸有戏」）。它与新产品「狸有戏」（短剧营销工具）是同一团队、同一品牌名下的**两个产品**。这直接引出一个必须先拍板的问题：新产品是**新注册一个小程序**，还是**复用参考工程那个 AppID**（见 §5.4、开放问题 Q1）。包名 `@liyo/*`、存储键 `liyo.*`、PM2 进程 `liyo-api`、目录 `/opt/liyo`、库名 `liyo`、JWT `aud=liyo` 也都占着这个名字，照搬模板时要整体换名。
2. **参考工程是「单机、小流量、闭测期」的形态**：一台 2 vCPU / 1.8G 内存的阿里云 ECS，一切以 root 跑，没有预发环境、没有 Sentry、没有探活、备份只在本机保留 14 天（`ref/docs/08-deployment.md:16-18,340-342`）。它的工程规范和部署脚本很成熟，但**运行形态本身不满足新产品 PRD 的非功能要求**（99.9% 可用、每日备份保留 30 天、签名防盗链，`PRD.md:1029,1036,1039`）。
3. **可以整体搬的是「工程模板 + 部署脚本 + Provider 实现 + 小程序基础设施层」**；**必须新增的是「微信支付、PC 管理后台前端、点播/转码/CDN/签名分发、OCR、通知类短信、PDF 文书、大文件分片上传、预发环境」**。详见 §5。

---

## 1. 小程序工程做法与版本

### 1.1 版本矩阵

| 项 | 版本 / 取值 | 出处 |
| --- | --- | --- |
| Taro（全家桶 `@tarojs/*`、cli、vite-runner、babel-preset-taro） | **4.2.1**（全部钉死同一版本） | `ref/apps/mobile/package.json:31-40,50-51,55` |
| 编译器 | **Vite**（`compiler: { type: "vite" }`；vite `^4.5.0`，实装 4.5.14；`@vitejs/plugin-react` 4.7.0；terser `^5.30.0`） | `ref/apps/mobile/config/index.ts:40`、`babel.config.js:9`、`package.json:54,59,61` |
| React / React DOM | **18.3.1** | `package.json:41-42` |
| NutUI React Taro | **3.0.20**（稳定线，不用 4.0 beta）；图标包 `@nutui/icons-react-taro` 3.0.2 | `package.json:29-30`；决策 `ref/docs/00-project-plan.md:599`、ADR-004 `ref/docs/02-architecture.md:102` |
| Zustand | **5.0.15** | `package.json:43` |
| 样式 | Sass `^1.80.0` + CSS Modules（`namingPattern: "module"`） | `package.json:58`、`config/index.ts:65-71` |
| TypeScript | 5.9.3，`strict` + `noUncheckedIndexedAccess` 等 | `package.json:60`、`ref/apps/mobile/tsconfig.json:8-13` |
| 构建目标 | 只有 `weapp`（`h5` 仅本地调试，装了 `plugin-platform-h5`） | `package.json:13-17`、`ref/docs/00-project-plan.md:87` |
| 开发者工具基础库 | `libVersion: 3.8.0`；后台最低基础库 ≥ 2.32.3（隐私接口要求） | `project.config.json:31`、`ref/docs/07-platform-config.md:24` |
| Node / pnpm | Node 24 LTS（`engines >=24 <25`，`.nvmrc`=24）、pnpm 10.30.0，全仓 ESM | `ref/package.json:6-11`、`ref/.nvmrc` |
| 设计稿 | `designWidth: 375`，样式写 px、编译转 rpx（1px = 2rpx） | `config/index.ts:12-18`、`ref/docs/05-mobile-guide.md:252` |

服务端（供对照）：Hono 4.13.5 + `@hono/zod-openapi` 1.6.1、Zod 4.5.4、Prisma 7.10.0 + `@prisma/adapter-pg`、PostgreSQL 16、BullMQ 6.3.4 + ioredis 6.0.0 + Redis 7、jose 6.2.10、pino 10.3.1、`@sentry/node` 10.73.0、`@aws-sdk/client-s3` 3.1124.0、tsup 8.5.1、Vitest 4.1.11（`ref/apps/api/package.json:14-37`、`ref/package.json:35-52`）。注意规划文档写的是 BullMQ 5（`ref/docs/00-project-plan.md:103`），实际装的是 6——**文档与代码有漂移，以 package.json 为准**。

### 1.2 构建配置要点（`ref/apps/mobile/config/index.ts`）

- 插件只有 `@tarojs/plugin-html`（NutUI 渲染 HTML 标签要它）（L22）。
- `sass.resource` 全局注入三份：NutUI `variables.scss`、`src/styles/tokens.scss`、`src/styles/mixins.scss`——任何 `.scss` 直接用变量与 mixin，不用 import（L44-55）。
- `pxtransform.selectorBlackList: ["nut-"]`：NutUI 内部已按 375 处理，跳过其选择器（L58-64）。
- `copy.patterns` 把分享卡片图、邀请卡片字标**原样拷进 dist**（L26-38）：`onShareAppMessage` 的 `imageUrl` 与 Canvas 图片只吃路径、不吃 base64，而 `import` 进来的图会被打包器内联。
- 环境变量走 Taro 的 `.env.development` / `.env.production`，只注入 `TARO_APP_*`：`TARO_APP_ID`、`TARO_APP_API_BASE_URL`、可选 `TARO_APP_SERIF_FONT_URL`（`ref/apps/mobile/types/global.d.ts:15-29`、`src/utils/env.ts:2-6`）。密钥不进前端构建（`ref/AGENTS.md:40`）。
- 命令：`build:weapp`（读 `.env.production`）/ `build:weapp:dev`（`NODE_ENV=development`）/ `dev:weapp`（watch）/ `typecheck`；`test` 脚本只打印「真机联调，无自动化测试」（`package.json:13-19`）。**生产构建后要继续本地联调，必须重跑 `build:weapp:dev` 把 dist 指回本地 API**（`ref/docs/05-mobile-guide.md:321`）。

### 1.3 分包策略与主包体积

- **主包只留 tabBar 页 + 登录 + 个人资料类**：9 个页面（index / expression / archive / mine / profile / ai-settings / account-delete / login / sms-login）（`src/app.config.ts:2-12`）。
- **4 个分包**按业务域切：`subpackages/ip`（6 页）、`archive`（3 页）、`expression`（8 页，含录音、素材浏览器、拍摄）、`studio`（2 页）（`app.config.ts:13-56`）。
- **插件只在用到它的分包里声明**：微信同声传译 `WechatSI` 挂在 expression 分包的 `plugins`，体积不进主包（`app.config.ts:43-47`）。
- `lazyCodeLoading: "requiredComponents"`（L75）；**分包预下载**：首页预取 expression + studio，档案 tab 预取 archive（L77-83）。
- **主包红线 < 1.5MB**（自定的 NFR-04，比微信的 2MB 上限留了余量）。2026-09-16 实测：主包 980KB，分包 expression 236KB / ip 164KB / archive 72KB / studio 64KB；口径是 `du -sk dist` 减 `subpackages`（`ref/docs/05-mobile-guide.md:138`、`ref/docs/09-qa-checklist.md:332`）。本次现场 `du -sk` 复核：dist 1520KB、subpackages 536KB，即主包约 984KB，与文档一致。
- 【外部】微信的硬上限：单个分包 / 主包 ≤ 2M，全部分包合计 ≤ 30M（服务商代开发 20M）（<https://developers.weixin.qq.com/miniprogram/dev/framework/subpackages.html>）。
- **控制主包体积的具体手段**（都有出处）：
  - NutUI **只留 7 个**有平台能力或交互复杂度的组件（Button / Switch / Popup / ActionSheet / Dialog / TextArea / Loading），样式在唯一入口 `src/styles/nutui.ts` 逐个 `import ".../style/css"`；卡片、列表行、标签、空态、搜索框全部自写构件（`src/styles/nutui.ts:1-16`、`ref/AGENTS.md:52`）。
  - 图标不用图标字体：24 网格线性 SVG 用 CSS mask 取形、`currentColor` 取色（`ref/docs/05-mobile-guide.md:256`、`src/styles/mixins.scss:204-213`）。
  - 品牌衬线字体**不进包**：放对象存储，启动时 `loadFontFace` 异步加载，加载不上按字体栈回落（`src/utils/font.ts:6-12,18-39`）。
  - 被多个分包引用的工具会被抬进主包，所以这类文件「只放文案与推导、别往里塞逻辑」（`ref/docs/05-mobile-guide.md:142`）。
  - 邀请卡片字标拷到 `dist/subpackages/ip/assets/`，不放 `dist/assets`（`config/index.ts:30-35`）。
  - 小程序引 `@liyo/shared` 只能走子路径 `@liyo/shared/uploads`：根入口会带进 `node:crypto`，Taro 打不动（`ref/docs/05-mobile-guide.md:224`）。
- **缺口**：主包体积**没有进 CI**——CI 不构建小程序（见 §4），靠人在上传前用开发者工具「代码依赖分析」核（`ref/docs/05-mobile-guide.md:138`）。

### 1.4 请求封装与错误处理（`src/utils/request.ts`，155 行）

- 单一 `API_BASE_URL`（构建期注入）；路径不带前缀自动加 `/api/v1`，`/health` 例外（L55-61）。
- 自动带 `Authorization: Bearer <access>`，`auth: false` 可关（L96-100）。
- **错误双通道**：先读 body 的 `{code, message, data}`；`status===200 && code===0` 才返回 `data`；其他业务码抛 `ApiError(code, message, status, details)`；网络异常抛 `ApiError(-1, "网络异常…")`；非 JSON 响应（网关错误页）按 HTTP 状态兜底（L102-141）。服务端同一套约定：HTTP 状态按语义 + body `{code, message}`，错误码只从 `@liyo/contract` 的 `ErrorCode` 引用（`ref/AGENTS.md:36`）。
- **401 → 单飞 refresh → 重放一次**：并发 401 共用一个 `refreshing` Promise（L43,85-92）；重放仍失败才 `onUnauthorized()`（清 session，`reLaunch` 登录页）。**只有「带着凭证发出去仍被拒」才清登录态**——没带凭证的请求收到 401 不触发，避免「某个接口忘了带 auth」放大成永远登不进去的死循环（L119-130）。
- `http.get/post/put/patch/delete` 便捷方法（L144-155）；类型来自 `@liyo/contract/generated/types`（Zod → OpenAPI → `openapi-typescript`），页面内禁止手写接口类型（`ref/AGENTS.md:34,58`）。
- 统一提示：`showError(err, fallback)` 业务错误直接展示服务端 `message`（`src/utils/toast.ts:5-8`）——所以**服务端的 message 要写成能给用户看的人话**。
- ESLint 强制：全仓禁 `axios`；小程序内禁 `window` / `document` / `localStorage` / `fetch`（`ref/eslint.config.js:40-50,73-79`）。
- **没做的**：request 没有超时参数与重试；`app.config.ts` 没配 `networkTimeout`（`src/utils/album.ts:40` 的注释确认）；没有请求级 requestId 回显给用户（服务端有 `requestId` 中间件，`ref/apps/api/src/app.ts:49`）。

### 1.5 登录、token 存储与静默续期

- **冷启动静默登录**：`app.ts` 的 `useLaunch` 调 `ensureLogin()`——本地有 access 或 refresh token 就直接拉用户资料；否则 `Taro.login()` → `POST /auth/login/wechat` → `setSession`。**后端没起来也不抛错、不阻塞首页**（`src/app.ts:9-14`、`src/utils/auth.ts:24-40`）。
- **token 存储**：access / refresh 都落 `Taro.setStorageSync`，键集中在 `StorageKey`（`liyo.accessToken` / `liyo.refreshToken` …），`user` 只放内存（`src/utils/storage.ts:4-22`、`src/stores/auth.ts:15-36`）。读写全部 try/catch，失败不崩。
- **服务端**：access 是 HS256 JWT、2h，claims `sub=uid`、`aud=liyo`、`iss=liyo-identity`、`client_id`；refresh 是 32 字节随机 base64url、sha256 入库、30 天、**每次刷新轮换**（旧的记 `revoked_at` + `replaced_by_id`）（`ref/docs/02-architecture.md` §1.3；`.env.example:13-17`）。密钥轮换有 `JWT_SECRET_PREVIOUS`（`ref/docs/08-deployment.md:168`）。
- **一键手机号**：`<Button openType="getPhoneNumber">` 拿 code → `POST /auth/phone/one-click`；已登录是绑定、未登录是登录/注册；返回的 token 对可能属于**合并后的账号**，要整体替换 session 并弹窗告知「已并入原有账号」（`src/api/auth.ts:8-11`、`src/utils/auth.ts:43-73`）。
- 另有短信登录 / 绑定 / 换绑、绑定微信、退出（`src/api/auth.ts:13-32`）。**生产短信仍是 console 驱动，验证码不真发**（`ref/docs/07-platform-config.md:113`）。
- 登录限流在服务端：`/auth/login/*` 20 次/分、`/auth/phone/*` 20 次/分、`/auth/sms/send` 10 次/分、`/auth/refresh` 60 次/分，全局 300 次/分/IP，Redis 固定窗口（`ref/apps/api/src/app.ts:58-86`、`middleware/rate-limit.ts:17-27`）。
- **与新产品的差异**：PRD 要求「微信手机号快捷登录、一个手机号一个账号、首次登录勾选协议」（`PRD.md:389-393`）。参考工程是「先静默拿 openid 建号、手机号后绑」，并且有并号逻辑；新产品是**手机号为主键、登录页显式点按**（【原型 merchant/Login】），流程更简单，但 `getPhoneNumber` 每次成功调用要收费（见 §3.1）。

### 1.6 文件直传（`src/utils/upload.ts` + 服务端 `media.service.ts` / `providers/storage/s3.ts`）

三步：`POST /uploads/presign` → `Taro.uploadFile` **直传对象存储** → `POST /uploads/confirm`（`src/utils/upload.ts:28-69`）。

| 环节 | 做法 | 出处 |
| --- | --- | --- |
| presign | 服务端校验 kind / mime / size → 生成不可猜的 objectKey → S3 **presigned POST**，policy 带 `content-length-range` 与 `eq $Content-Type`，默认 600 秒有效 | `ref/packages/services/src/providers/storage/s3.ts:33-45`、`ref/docs/02-architecture.md` §1.5 |
| 直传 | `Taro.uploadFile({ url, filePath, name: "file", formData: fields })`；`onProgressUpdate` 报进度（老基础库 / H5 没有就静默） | `src/utils/upload.ts:50-63` |
| confirm | 服务端 HEAD 校验后落 `media_assets.confirmed`；未确认对象由 maintenance 队列 24h 后清理 | `ref/docs/02-architecture.md` §1.5 |
| 类别登记表 | 类别 / 扩展名 / MIME / 大小上限**只有一份**在 `@liyo/shared/uploads`，服务端校验、契约 schema、端上选择器共用 | `ref/packages/shared/src/uploads.ts:1-9,38-78` |
| 上限 | image 5MB、video 50MB（仅 mp4）、audio 100MB（m4a/mp3/aac）、file 20MB（pdf/doc/docx/xls/xlsx/ppt/pptx/txt）；env `UPLOAD_MAX_*_MB` 可覆盖 | `uploads.ts:38-78`、`.env.example:52-55` |
| 存储抽象 | S3 兼容，一套代码跑 MinIO（本地）与腾讯云 COS（生产）；`presignUpload / head / get / put / putStream / publicUrl / delete` | `providers/types.ts:22-43`、`s3.ts:21-110` |
| 端上不经 api 传文件 | nginx `client_max_body_size 2m`，api 自身请求体 1MB | `ref/infra/nginx-api.conf:45-46`、`ref/apps/api/src/app.ts:56` |

端上交互模式（文档明确要求照做）：
- **「先入列表再上传」**：选完立刻出格子，逐项进度、失败点格重试、传完才能保存；**顺序传不并发**（一次九张并发会把弱网压垮）。禁止「全屏 loading + 整批 try/catch」——第三张失败会连前两张一起丢（`src/hooks/useImageUploads.ts:15-28,152-155`、`ref/docs/05-mobile-guide.md:288`）。
- 过不了体检的文件**不进列表**（列表里的失败行意味着「点一下能重试」），用一条弹窗汇总原因（`src/utils/attachments.ts:23-26,229-240`）。
- 超限图片 `compressImage` 逐级降质 80 → 60 → 40，压不动就拒（`attachments.ts:59-113`）。

**坑**
- `chooseMessageFile` 的 `extension` 过滤只在 `type: "file"` 时生效；`type: "all"` 下必须端上按扩展名自己判类型与限额，而且微信只给文件名不给 MIME（`src/utils/media.ts:81-87`、`attachments.ts:15-22`）。
- iOS 的 m4a 常报 `audio/x-m4a`，要有 MIME 别名（`uploads.ts:30-35,62`）。
- presign 只认声明的 MIME：相册原图里的 gif / heic 按 `image/jpeg` 报上去，服务端会把别的字节存成 `.jpg`——取原图时先过一次 `compressImage` 让微信重编码成 jpg（`useImageUploads.ts:25-27,89-103`）。
- `compressImage` 的产物是否保留 EXIF 方向**以真机为准**，安卓上可能丢（`ref/docs/05-mobile-guide.md:68-69`、`ref/docs/09-qa-checklist.md:276`）。
- 直传域名必须进小程序后台 **uploadFile 合法域名**，且 COS 桶要配允许 POST 的 CORS（旧版清单，`git show 1d46beb:docs/07-platform-config.md`）。
- 【推断】`upload.ts:50-55` 的 `Taro.uploadFile` **没传 `timeout`**，而下载那一侧专门为「默认 60 秒会断」加了按体积估的超时（`album.ts:40-52`）。50MB 视频在弱网下上传很可能同样撞 60 秒默认超时；新产品要传更大的文件，必须显式处理。
- **没有分片 / 断点续传**：presigned POST 是单请求整文件；`StorageProvider` 也没有签名读（`presignGet`）接口（`providers/types.ts:22-43`）。

### 1.7 录音（`src/utils/recorder.ts` + `subpackages/expression/record`）

- **两个引擎、同一套会话语义**：微信同声传译插件 `WechatSI`（边录边识别，出 mp3 + 文本）；取不到插件时退回原生 `RecorderManager`（aac / 16k / 单声道 / 48kbps，只出文件，文本留给服务端 ASR）（`recorder.ts:3-13,127-205`）。
- **按 60 秒分段自动续录**：插件与腾讯云「一句话识别」单次都只收 ≤60s（`recorder.ts:15-16`、ADR-020）。**「暂停」= 停掉当前段不起下一段**，不用 `pause/resume`，因为它们与 `duration` 自动停止的计时关系没有文档保证（L10-12）。短于 1 秒的分段丢弃（L18,246）。
- 每段录完**立刻上传并写进草稿**（= 自动保存）；结束时最多等 30 秒让分段传完（`record/index.tsx:18-19,50-56`）。一次录音的多段用同一个 `group` 归并，展示与播放时合成一行（`ref/docs/05-mobile-guide.md:287`）。
- **打断处理**：`onInterruptionBegin`（来电 / 微信通话）时系统只是挂起、不触发 `onStop`，要主动 `stop()` 让这一段的文件回来，会话转为暂停（`recorder.ts:272-283`）；页面 `useDidHide` 主动暂停；录音期间 `setKeepScreenOn(true)`（`record/index.tsx:118-134`）。
- 原生录音器是**全局单例**，监听只挂一次，会话回调放模块级整体替换（`recorder.ts:162-177`）；插件摘回调时给 no-op 而不是 null（L153-158）。
- 权限：`scope.record`，拒绝后 `showModal` → `openSetting`（L347-363）；隐私指引须勾「麦克风」（`ref/docs/07-platform-config.md:67`）。
- 插件版本 `0.3.10` 必须与公众平台「插件管理」显示的**一字不差**，对不上开发者工具直接编译失败（`app.config.ts:44-47`、`ref/docs/07-platform-config.md:98`）。
- 服务端转写两条路：一句话识别（≤60s，同步）与**录音文件识别**（≤5 小时，按 URL 建任务 + 轮询，只在 worker 里调）（`providers/types.ts:143-155`、ADR-043）。
- 播放：`InnerAudioContext` 顺序播多段，`token` 作废晚到回调；波形用 `decodeAudioData` 取 PCM 峰值（小程序没有 `AnalyserNode`），量不到就画等高柱子不造假（`src/utils/audio.ts:22-87,91-138`）。
- **对新产品**：PRD 要「录音单条最长 5 分钟、可试听、可重录，平台会转成文字」（`PRD.md:726`；【原型 merchant/AssetUpload】），没有「边录边出字」的要求。【推断】不需要同声传译插件，也就不需要 60 秒分段：原生 `RecorderManager` 单次 `duration` 最大 600000ms（【外部】<https://developers.weixin.qq.com/miniprogram/dev/api/media/recorder/RecorderManager.start.html>，搜索摘要：默认 60000、最大 600000），一段 300 秒录完整体直传，服务端走已有的 `transcribeFile`（录音文件识别）即可。打断 / 切后台 / 常亮这三条处理照搬。

### 1.8 视频：选择、播放、下载存相册

**选择**
- 速记附件：`chooseMedia({ mediaType:["video"], sourceType:["album","camera"], sizeType:["compressed"], maxDuration: 60 })`——相机拍摄最长 60 秒是 `chooseMedia` 的上限，相册视频不受此限（`src/utils/media.ts:20-21,35-51`）。
- 需要画质的场景取原片：`sizeType:["original"]`，超过 20MB 先压一次，**只降码率不降分辨率**（`src/utils/shot.ts:39-48,66-106`）。
- `chooseMedia` 给的视频缩略图 `thumbTempFilePath` 直接直传成封面；聊天记录导入的视频由 worker 用 ffmpeg 抽帧回填（ADR-034，`ref/docs/02-architecture.md:133`）。
- `chooseMedia` 给的宽高**可能是旋转前的**，端上不要据此判横竖（`shot.ts:113-121`、`ref/docs/05-mobile-guide.md:71`）。
- `chooseMedia` 抛错几乎都是用户取消，**唯独 errno 112** 是隐私指引没写该用途，要单独提示（`shot.ts:50-59`）。

**播放**
- 用原生 `<Video>`（poster、controls、`object-fit: contain`、不自动播）；9:16 容器的宽高用**设备 px 行内算**，不用 `aspect-ratio`（渲染层支持不可靠）（`ref/docs/05-mobile-guide.md:174,90-91`）。
- `Taro.createVideoContext(id).seek()` 做「点缩略图跳到对应镜头」（`subpackages/studio/film/index.tsx:179`）。
- **原生组件层级最高，会盖住弹层**：Sheet 打开时把 `<Video>` 换成封面图并先 `pause()`，代价是关掉弹层后从头播；不用 cover-view 重画（`ref/docs/05-mobile-guide.md:188`）。
- 视频源是 COS 公有读桶的直链，**没有 CDN、没有多码率、没有签名**（`ref/docs/07-platform-config.md:31`）。

**下载存相册**（`src/utils/album.ts`，178 行，成片页与同行参考页共用）
- 顺序定死：隐私授权 + `scope.writePhotosAlbum` → `downloadFile` 到 `USER_DATA_PATH/<name>.mp4` → `saveVideoToPhotosAlbum` → 删掉用户目录那份（L8-11,110-134）。`saveVideoToPhotosAlbum` 只收本地路径；文件名必须带 `.mp4`（L108）。
- **下载超时按体积估**：`downloadFile` 不传 `timeout` 走默认 60 秒，十几 MB 的成片在门店 4G 下走到 70% 就断、再点还是断；按 50KB/s 兜底估，夹在 2–10 分钟（L39-52）。
- 失败分 7 类各给一句话与出口：权限（弹窗 → `openSetting`）/ 隐私指引点了不同意 / 隐私指引没写（errno 112）/ 空间 / 网络 / 超时 / 取消（L17-28,149-177）。
- 蜂窝网络下提示「建议连 Wi-Fi」（L136-146）；按钮上显示「下载中 N%」（`ref/docs/05-mobile-guide.md:187`）。
- **桶域名必须在 downloadFile 合法域名里，没登记真机上静默失败**（L10-11、`ref/docs/07-platform-config.md:37,41`）。
- **`wx.downloadFile` 单次最多 200MB**，超过的只能在页面里看、存不了相册（`subpackages/expression/link-detail/index.tsx:32-33`、`.env.example:75-77`；【外部】微信开放社区对官方文档原文的引用：<https://developers.weixin.qq.com/community/develop/doc/00026a2b114dc02fbc33877b266400>）。

### 1.9 订阅消息（`src/utils/subscribe.ts` + 服务端 `push.service.ts`）

- **`requestSubscribeMessage` 只能在点按的同步调用链里发起**，中间隔一个 await 就弹不出来。所以页面 didShow 时预取模板 id 与 `getSetting({ withSubscriptions: true })`，点按里**第一件事**同步调、只读缓存（`subscribe.ts:8-15,45-57,74-106`）。
- **模板是非阻塞的**：服务端没配模板（`GET /push/templates` 回 null）就整个跳过，端上不展示入口、服务端 no-op，不因为模板没过审压着不上线（`subscribe.ts:9`、`ref/docs/08-deployment.md:102`、`.env.example:22-27`）。
- 用户勾了「总是保持以上选择」并拒绝的，本地记一份不再问（`subscribe.ts:17-43`）。
- **订阅是一次一条**：允许一次只保证一条通知，所以不落存储、不跨业务对象记（`subscribe.ts:62-67`）。
- 服务端：模板字段名必须与账号里那个模板**逐字一致**，多一个少一个微信都回 47003；换模板先用 `gettemplate` 查真实字段（`ref/docs/07-platform-config.md:80`）。`WECHAT_MINIPROGRAM_STATE=developer|trial|formal` 决定点开消息进哪个版本，闭测期填 `trial`（`.env.example:28-30`）。落地页路径**写死在服务端推送里**，改页面路径要连推送一起改（`app.config.ts:50-53`）。
- 推送走独立 `push` 队列（并发 4），请求路径内不同步调微信（`ref/AGENTS.md:38`）。

### 1.10 隐私协议、授权与提审相关配置

| 项 | 做法 | 出处 |
| --- | --- | --- |
| 隐私总开关 | `app.config.ts` 开 `__usePrivacyCheck__: true` | `app.config.ts:126-127` |
| 调隐私接口前 | 统一 `ensurePrivacyAuthorized()`：`getPrivacySetting` → `requirePrivacyAuthorize`；老基础库没有这两个接口就放行 | `src/utils/privacy.ts:7-26` |
| scope 授权 | `ensureScope(scope)` 一次走完两道（隐私指引 + `getSetting`/`authorize`），回四种结果：`granted` / `denied`（只能引导去设置）/ `privacy_declined`（**别引导去设置**，设置页里没开关）/ `privacy`（errno 112，指引里没写这个用途，是我方的问题） | `src/utils/authorize.ts:14-37` |
| `openSetting` | 必须由用户点击直接触发，`showModal` 的「确定」算 | `authorize.ts:39-50` |
| 隐私协议页 | 「我的 → 隐私协议」调 `openPrivacyContract`（微信托管页，内容就是后台填的指引） | `src/pages/mine/index.tsx:28-34`、`ref/docs/10-privacy-policy.md:89` |
| `permission` 声明 | `scope.userLocation` / `scope.userFuzzyLocation` / `scope.record` / `scope.camera` 各带 `desc` | `app.config.ts:65-74` |
| `requiredPrivateInfos` | `["chooseLocation","getFuzzyLocation"]`。**顺序不能反**：先在后台「接口设置」申请通过，再写进数组；数组里出现未开通的接口，编译与上传**整包**报错（踩过一次，被迫撤回） | `app.config.ts:57-64`、`ref/docs/07-platform-config.md:52-53` |
| 后台隐私指引 | 按代码里**实际调用**的隐私接口逐项勾；没勾的调用回 errno 112，`<camera>` 更是不报错只给黑屏。**开发版、体验版与正式版一样受约束**（基础库 2.33.0 起） | `ref/docs/07-platform-config.md:56-76`、`ref/docs/10-privacy-policy.md:31-38` |
| 指引正文 | 逐条写明收集什么、发给谁、第三方处理方清单（含所在地）、保留与删除；带【待确认】清单交法务 | `ref/docs/10-privacy-policy.md:42-107` |
| 账号注销 | 自助注销入口 + 注销前体检 + 后果逐条列出（提审要求） | `ref/docs/05-mobile-guide.md:108-109`、`ref/docs/09-qa-checklist.md:190` |
| 客服入口 | `<Button openType="contact">`（小程序客服消息） | `src/pages/mine/index.tsx:223`、`pages/profile/index.tsx:187` |
| 分享 | 用 `useShareAppMessage` 的页面 `index.config.ts` 必须写 `enableShareAppMessage: true`，否则**不报错**地退回默认卡片；必须给 `imageUrl`（路径，不是 base64） | `ref/docs/05-mobile-guide.md:291-293` |
| 提审核对 | 类目与功能一致、测试账号与说明、隐私指引已声明各项、首次用 AI 前可见第三方处理说明 | `ref/docs/09-qa-checklist.md:186-191` |
| 发布步骤 | `.env.production` 指向生产 API → 后台配三类合法域名 → `build:weapp` → 开发者工具上传 → 体验版真机回归 → 提审 | `ref/docs/08-deployment.md:349-354` |

**现状提醒**：参考工程的小程序**还没发过正式版**，一直在体验版闭测（`ref/README.md:5`、`ref/docs/08-deployment.md:60`）；隐私指引正文仍是待律师审定的草稿（`ref/docs/10-privacy-policy.md:3-5`）。也就是说，**「提审通过」这一步参考工程自己还没走完**，没有可借鉴的审核往返记录。

### 1.11 样式 Token 与界面语言

三层，自上而下取用（`ref/docs/05-mobile-guide.md:242-250`）：

| 层 | 位置 | 内容 |
| --- | --- | --- |
| Token | `src/styles/tokens.scss`（113 行） | 色彩 / 字阶 / 间距 / 圆角 / 尺寸 / 边线阴影 / 动效 / 字体，只声明变量不产出 CSS；页面禁止硬编码色值与字号 |
| Mixin | `src/styles/mixins.scss`（213 行） | `liyo-page` / `liyo-card` / `liyo-section-title` / `liyo-list-row` / `liyo-badge` / `liyo-dock`（吸底条，带 `env(safe-area-inset-bottom)`）/ `liyo-tap` / `liyo-clamp` / `liyo-mask` 等 |
| 构件 | `src/components/index.ts` | Card / Section / List / Tile / Field / Chip / Checkbox / Avatar / Sheet / Stats / Note / PageHeader / Icon / Empty / Loading / Segment / Search 等 |

- **Token 命名与取值**：`$liyo-brand #d75011`、`$liyo-ink`、`$liyo-paper`、`$liyo-mist`、状态色 success / warning / error / info，字阶 28/24/20/17/15/14/13/12，间距 4/8/12/16/24/32，圆角 14（按钮）/16（卡片）/24（弹层）（`tokens.scss:7-18,54-80`）。
- **对比度是算过的**：品牌橙做字在暖白上只有 3.79:1，所以橙色文字与橙底白字用深一档的 `$liyo-brand-pressed`；次级文字最浅到 `$liyo-ink-soft`（`tokens.scss:41-46`、`ref/docs/05-mobile-guide.md:264,271`）。
- **NutUI 主题只能用 CSS 变量覆盖**（组件样式是预编译 CSS）：`app.scss` 的 `page { --nutui-color-primary: … }`（`src/app.scss:9-42`）。**别用 Sass 的 `darken()`**：会算出 `rgb(60.89%, …)` 百分比写法，小程序渲染层不保证认得（`app.scss:15-16`）。
- 行内 style **不过 pxtransform**，尺寸一律写样式文件；例外是胶囊对齐、吸顶偏移这些必须用设备 px 的地方（`ref/docs/05-mobile-guide.md:252,40`）。
- 自绘导航栏用 `getMenuButtonBoundingClientRect()` 对齐胶囊，取不到按状态栏兜底（`src/utils/nav.ts:20-42`）。
- 【原型对照】新产品商家端原型的主色是 `#C4501B` / `#A63F12`、暖白底、状态色 `#256A42` / `#2E5AAC`（【原型 merchant/AssetUpload】脚本里的色值），与参考工程的 `#d75011` / `#b8420c` / 暖白 / `#2f7d5b` / `#315c8c` **是同一套品牌色系的近似值**。【推断】`tokens.scss` + `mixins.scss` + 构件库可以整体搬，只改变量取值与前缀。

### 1.12 状态、刷新、轮询的固定写法

- Zustand：一个 store 一个文件；持久化只在 `auth` / `ip` 两个 store；组件只订阅所需字段（`ref/AGENTS.md:59`、`ref/docs/05-mobile-guide.md:213-218`）。
- **列表刷新靠计数不靠标记**：改了数据的页面 `markStale(key)`，列表页 `useDidShow` 时比 `revisionOf(key)`，变了才重拉；禁止 `useDidShow(() => load(1,false))`（会把翻了几页的列表整个换掉并弹回顶部）（`src/utils/refresh.ts:1-43`、`ref/docs/05-mobile-guide.md:289`）。
- **轮询 hook `usePolling`**（200 行）：节奏由数据定（`delayOf` 回 null 就停）、reqId 作废旧请求、didHide / unload 停、网络错误指数退避（4s 起、30s 封顶）、连续 5 次失败或在前台轮满 8 分钟停下给「刷新」、回到前台重开窗口（`src/hooks/usePolling.ts:49-53,100-183`）。
- 列表必须分三态：有内容 / 确实为空（`Empty`）/ 还没拉到（`Loading`），不能拿 `list.length === 0` 反推（`ref/docs/05-mobile-guide.md:274-275`）。
- **「能不能做、处在哪种状态」全由服务端在 DTO 里判好**（`stage` / `actions`），端上只翻成人话（`ref/docs/05-mobile-guide.md:142`）——对新产品的订单 / 工单多状态机同样适用【推断】。

### 1.13 Taro / 小程序坑清单（文档与代码里明确记录的）

| # | 坑 | 结论 | 出处 |
| --- | --- | --- | --- |
| 1 | Taro 4.2 Vite 编译器**不产出 `custom-tab-bar` 目录** | 只能用微信原生 tabBar；图标用脚本生成 PNG | `ref/docs/05-mobile-guide.md:295` |
| 2 | Vite 编译器的 `copy.patterns` 对**目录形式不产出任何东西** | 必须逐个文件写 | `ref/docs/05-mobile-guide.md:292` |
| 3 | `babel-plugin-import` 在 Taro Vite 下样式注入不可靠 | 组件 JS 直接 import，样式在唯一入口显式引入 | `ref/docs/05-mobile-guide.md:298-308` |
| 4 | 工作区包根入口带进 Node 内置模块 | 给小程序单开子路径导出 | `ref/docs/05-mobile-guide.md:224` |
| 5 | `loading` 与 `toast` 是同一个原生浮层 | `hideLoading` 要在报错之前 | `ref/docs/05-mobile-guide.md:181` |
| 6 | 原生 `<Video>` / `<camera>` 层级最高盖住弹层 | 弹层开着时换成封面图 | `ref/docs/05-mobile-guide.md:188` |
| 7 | `aspect-ratio` 在渲染层不可靠 | 宽高用设备 px 行内算 | `ref/docs/05-mobile-guide.md:90-91` |
| 8 | `backdrop-filter` 在安卓 XWeb 上分裂、Skyline 不支持 | 吸顶条用不透明底色 | `ref/docs/05-mobile-guide.md:42` |
| 9 | 浮层拦不住系统返回手势 / 实体返回键 | 全屏浏览器做成页面不做浮层 | `ref/docs/05-mobile-guide.md:101` |
| 10 | `<camera>` 缺任一道授权**不报错只给黑屏**；开发者工具「真机调试」里预览常黑 | 两道授权都自己走；用「预览」扫码验证 | `ref/docs/05-mobile-guide.md:86-95` |
| 11 | Taro 4.2 类型缺失：`showModal` 的 `editable`、`loadFontFace` 的 `scopes`、`requestSubscribeMessage`（把支付宝字段标成必填）、隐私接口 | 各自补一层带类型的封装 | `src/utils/prompt.ts:3`、`font.ts:25`、`subscribe.ts:84`、`privacy.ts:8-15` |
| 12 | 小程序没有 `AnalyserNode` | 波形用 `decodeAudioData` 离线算 | `src/utils/audio.ts:94-96` |
| 13 | 开发者工具「不校验合法域名」只管本机 | 体验版 / 正式版以后台配置为准 | `ref/docs/07-platform-config.md:43` |
| 14 | 体验版只有「体验成员」打得开 | 入组时要把人加进名单 | `ref/docs/07-platform-config.md:26` |

### 1.14 小程序侧的缺口（参考工程没做、新产品要自己补）

- **没有自动化测试**（`package.json:19`），靠 330 多行的真机回归用例清单（`ref/docs/09-qa-checklist.md`）。
- **没有错误上报**：规划里评估 `sentry-miniapp` 或自建 `POST /client-logs`（D10 / ADR-016，`ref/docs/00-project-plan.md:607`），仓库里两者都搜不到实现。
- **没有 `miniprogram-ci`**：上传靠人在开发者工具里点（`ref/docs/08-deployment.md:353`）。
- **没有支付**（全仓搜不到 `requestPayment`）、没有 web-view、没有 socket（`ref/docs/07-platform-config.md:39`）。
- 没有埋点 SDK（新产品 PRD 第 9 章有 30 来个埋点事件，`PRD.md:985-1016`）。

---

## 2. 生产部署形态

### 2.1 全貌

| 维度 | 现状（文档记录，09-16 核） | 出处 |
| --- | --- | --- |
| 云厂商 | 主机在**阿里云 ECS**，对象存储在**腾讯云 COS（ap-shanghai）**——**跨云，api / worker 读写 COS 都走公网** | `ref/docs/08-deployment.md:8,16` |
| 机器 | 1 台 `ecs.e-c1m1.large`（经济型，2 vCPU），内存 **1.8G** + 2G swap，系统盘 40G；Alibaba Cloud Linux 3（el8 系，内核 5.10，cgroup v1） | `ref/docs/08-deployment.md:16,70` |
| 运行用户 | **一切以 root 跑**（PM2 在 `/root/.pm2`，`pm2-root` systemd 单元）；文档自己写明「不是推荐做法，只是现状」 | `ref/docs/08-deployment.md:18` |
| 安全组 | 入站 22 / 80 / 443；5432 / 6379 不对外 | `ref/docs/08-deployment.md:17` |
| 入口 | **宿主机 nginx**（systemd），与同机的「时间航线」静态站共存；Caddy 只是备选（compose 的 `caddy` profile，默认不起） | `ref/docs/08-deployment.md:7,182`、`ref/infra/compose.prod.yml:54-63` |
| nginx 配置 | 80 → 308 跳 HTTPS + ACME webroot；443 `http2`、TLS1.2/1.3、`client_max_body_size 2m`、反代 `127.0.0.1:3000`、`proxy_read_timeout 60s`、透传 `X-Forwarded-For`；HSTS 由 api 的 `secureHeaders` 下发，nginx 不重复加 | `ref/infra/nginx-api.conf:6-58` |
| 应用进程 | **PM2** 两个 fork 单实例：`liyo-api`（`dist/server.js`）、`liyo-worker`（`dist/index.js`）；各 `max_memory_restart 512M`、`kill_timeout 15000`；`node_args: --env-file=../../.env` | `ref/infra/ecosystem.config.cjs:6-43` |
| worker | 一个进程挂 **5 条 BullMQ 队列**：ai-tasks（并发 2）、push（4）、maintenance（1）、downloads（3 + 每分钟 20 限速）、render（1）；**必须单实例** | `ref/docs/08-deployment.md:338,343`、`ref/apps/worker/src/index.ts:43-81` |
| 中间件 | **Docker Compose** 只跑 `postgres:16-alpine` 与 `redis:7-alpine`（AOF + requirepass），端口只绑 `127.0.0.1`，数据卷 `/opt/liyo/data/{postgres,redis}`，json-file 日志 20m × 5 | `ref/infra/compose.prod.yml:8-52` |
| 对象存储 | COS 桶 `liyo-prod-<appid>`，**公有读 + 私有写 + 随机 key**（决策 D6）；对外基址是**桶默认域名，没有 CDN 自定义域名** | `ref/docs/07-platform-config.md:31,111` |
| 域名 | `api.timavia.com`；`timavia.com` **ICP 备案 2026-09-08 通过** | `ref/docs/08-deployment.md:9`、`ref/docs/07-platform-config.md:122` |
| 证书 | Let's Encrypt，`acme.sh` webroot 自动续期（root crontab 每天 05:05，`--reloadcmd "systemctl reload nginx"`）；静态站证书另归 `certbot-renew.timer` | `ref/docs/08-deployment.md:213-226` |
| 目录 | `/opt/liyo/app`（代码，git clone）、`/opt/liyo/.env`（600）、`/opt/liyo/data`、`/opt/liyo/backup`、`/opt/liyo/fonts`、`/var/log/liyo` | `ref/docs/08-deployment.md:21` |
| 备份 | `/usr/local/bin/liyo-backup.sh`：`pg_dump + gzip` 到 `/opt/liyo/backup`，**保留 14 天**，root crontab 每日 04:00；部署前另备 `liyo-predeploy-<时间戳>.sql.gz`。**异地副本没做**；**备份脚本本身不在仓库里**（全仓只有文档提到它） | `ref/docs/08-deployment.md:252,340` |
| 日志 | Pino JSON → stdout → PM2 落 `/var/log/liyo/{api,worker}.{out,err}.log`（`merge_logs`、`time`）；nginx access/error 各一份；**没有日志轮转配置的记录、没有集中日志** | `ref/infra/ecosystem.config.cjs:18-21,38-41`、`ref/infra/nginx-api.conf:42-43` |
| 监控告警 | 代码支持 Sentry（api 500 与 worker 任务失败上报），**生产 `SENTRY_DSN` 为空**；`/health` 回 `status / db / redis / worker`，**生产 crontab 里没有探活任务** | `ref/docs/07-platform-config.md:138-143`、`ref/docs/08-deployment.md:341-342` |
| worker 心跳 | worker 每 30 秒写 Redis 心跳（TTL 90 秒），api 的 `/health` 读它回 `worker: ok|down`；worker 挂了 `status` 仍是 ok，要单独盯这个字段 | `ref/docs/08-deployment.md:341`、`ref/apps/api/src/routes/health.ts:13-18` |
| 管理后台 | 挂在 api 同进程：`https://api.timavia.com/admin`，一个**没有构建步骤的纯字符串静态页** + `/api/v1/admin/*`；邮箱 + 密码（scrypt）+ TOTP，会话放 Redis，写操作留痕 `admin_audit_logs`；没配 `ADMIN_SECRET_KEY` 整组 404 | `ref/docs/08-deployment.md:121-140`、ADR-063 `ref/docs/02-architecture.md:161` |
| 接口文档 | Swagger UI `/docs` 与 `/api/v1/openapi.json` **现在公网可访问**，待决定是否关闭 | `ref/docs/08-deployment.md:347` |
| 环境 | **只有本地 + 生产**；体验版小程序直连生产 API | `ref/docs/09-qa-checklist.md:7` |
| 代码托管 | GitHub `byfire-dev/timavia-liyo-project`，生产机走 SSH（`git@github.com:…`）拉代码 | `ref/docs/08-deployment.md:38`、`git remote -v` |

```
微信小程序 ──HTTPS──▶ api.timavia.com（阿里云 ECS · 宿主机 nginx :443）
      │                         │ proxy_pass 127.0.0.1:3000
      │                         ▼
      │                 PM2: liyo-api（Hono）──┐
      │                 PM2: liyo-worker（5 队列）─┤──▶ Docker: postgres:16 · redis:7（仅 127.0.0.1）
      │                         │                └──▶ 本机 ffmpeg / ffprobe 子进程
      │                         │ 公网（跨云）
      └──presigned POST / GET──▶ 腾讯云 COS（上海，公有读桶，默认域名）
```

### 2.2 发布脚本 `infra/deploy.sh`（336 行，7 步）

在生产机上**拉代码、现场构建**，不是 CI 出制品。步骤与失败时的线上状态（`ref/docs/08-deployment.md:272-285`、`ref/infra/deploy.sh:289-333`）：

| 步 | 做什么 | 失败时线上 |
| --- | --- | --- |
| 1 拉取代码 | `git fetch`；默认 `reset --hard origin/<BRANCH>`，给了 `DEPLOY_REF` 就 `checkout --detach`。**脚本自己有更新就 `exec` 新版本从第 2 步接着跑** | 旧进程没动 |
| 2 安装依赖 | 先**暂停 render 队列**；`pnpm install --frozen-lockfile --filter @liyo/api... --filter @liyo/worker... --filter @liyo/db...`（不装小程序工具链） | 旧进程没动，`node_modules` 可能半成品 |
| 3 构建 | `pnpm --filter @liyo/api --filter @liyo/worker build`（tsup，`@liyo/*` 内联） | 旧进程没动，`dist` 可能半成品 |
| 4 核对 .env | 子 shell 静默读一遍（读不进只报行号与键名）；查部署 shell 里的**残留键**；用**这一版构建出的** `check-env.js` 跑一遍启动时的 Zod 校验 | 旧进程没动、迁移没跑 |
| 5 数据库迁移 | `prisma migrate deploy` | 旧进程没动，迁移可能执行了一部分 |
| 6 重建进程 | 先查构建产物 / pm2 / ecosystem 可解析；再 `pm2 delete worker` → `delete api` → `pm2 start` → `pm2 save`，这段是**不可打断的临界区**（独立会话跑，不理 Ctrl+C 与断线） | 删了没起来 = 中断 |
| 7 健康检查与环境核对 | 探 `/health` 30 秒；`pm2 jlist` 确认 online、重启次数 0；按 pid 读 `/proc/<pid>/environ` 与 `.env` 逐键核对（**只打印键名**）；5 秒后再看 pid 与重启次数没变 | 新进程已在跑 |
| 收尾 | 恢复 render 队列（成败都恢复；恢复不了非零退出并提示） | — |

配套做法：
- **停机只有新 api 起来那几秒**（先删 worker、再删 api、两个一起起）（`ref/docs/08-deployment.md:287`）。没有零停机 / 蓝绿。
- 用 `setsid nohup ./infra/deploy.sh > /var/log/liyo/deploy-$TS.log 2>&1 &` 或 tmux 跑，别直接挂 ssh（`ref/docs/08-deployment.md:248-261`）。
- 部署前先备份库，日志与备份用同一个时间戳；挑低峰（`ref/docs/08-deployment.md:250-254`）。
- **只改了 `.env`**：`DEPLOY_REF=$(git rev-parse HEAD) ./infra/deploy.sh`，钉住线上版本（`ref/docs/08-deployment.md:267`）。
- `infra/check-proc-env.sh`（193 行）可单独跑，核对线上进程环境（`ref/docs/08-deployment.md:291-297`）。
- **部署脚本自己有测试**：`infra/test/deploy.test.ts`（真 git、真 bash，pm2 / pnpm / curl 换成桩），覆盖正常流程、env 校验不过、残留键、`DEPLOY_REF`、render 队列暂停恢复、临界区挨信号、worker 反复重启（`ref/infra/vitest.config.ts:3`、`deploy.test.ts:319-534`）。

### 2.3 回滚（`ref/docs/08-deployment.md:322-329`）

- **首选**：在 main 上 `git revert` 并推送，再正常跑 `deploy.sh`。
- **应急**：`DEPLOY_REF=<好的 sha 或 tag> ./infra/deploy.sh`（只能退到 2026-09-14 之后带 `DEPLOY_REF` 的脚本版本）。
- 手动 `git checkout <sha>` 再跑脚本**会被第 1 步冲掉**、照样打印 `deploy ok`——这是文档专门警告的陷阱。
- **两种都不回滚数据库迁移**；跨了迁移的回滚要先评估旧代码能不能跑在新表结构上。
- 进程层应急：`pm2 resurrect` 捞回上次 save 的进程（env 可能是旧快照）（`deploy.sh:67-68`）。

### 2.4 资源与容量实测（ADR-061、M0，`ref/docs/08-deployment.md:77-90`）

- 1.8G 的机器 `pnpm build` 可能被 OOM killer 打断，必须挂 2G swap（L33-35）；构建与渲染同跑内存会见底，所以部署时暂停 render 队列（L299）。
- api / worker 各约 265MB 常驻（L20）。
- 一条 ffmpeg 分段渲染：720p 单段峰值 RSS 178–278MB、墙钟 28–36 秒；渲染期间 api `/health` p95 从 3.2ms 涨到 6.3–10.3ms，真实照片那轮 p95 到 123ms、swap in/out 峰值 14–17MB/s（L79-90）。
- 迁移阈值（任一触发就动）：渲染 p95 > 2 分钟、持续 swap-in、PG p99 增量 > 50ms、每天渲染 > 50 条；升级路径：先升 2 核 4G → 函数计算 FC → 最后才是 IMS 云剪辑（ADR-061，`ref/docs/02-architecture.md:159`）。

### 2.5 文档里记录的事故与教训

| # | 事故 / 教训 | 根因与对策 | 出处 |
| --- | --- | --- | --- |
| 1 | **2026-09-08：「换模型上线」静默失效一整天** | `node --env-file` 不覆盖进程里已有的同名变量，而 PM2 把 `dump.pm2` 里的**旧 env 快照**注进进程；`pm2 reload --update-env` 刷不掉。`.env`、文档、代码三处都显示已切，线上跑的还是旧模型。对策：部署改成 `delete + start + save`，并**只信 `/proc/<pid>/environ`，不信 `.env` 文件** | `ref/docs/08-deployment.md:307-320` |
| 2 | `dump.pm2` 里**明文存着 API key** | 备份或传阅这个文件等于泄露密钥 | `ref/docs/08-deployment.md:320` |
| 3 | 2026-09-08：一批「AI 输出无法解析」 | 推理模型的思考 token 与正文共用 `max_tokens`，1000 的预算把 JSON 截成半截。对策：关思考 + 预算调到 4000 | `.env.example:116-119`、`ref/packages/services/src/providers/index.ts:44-49` |
| 4 | 远程执行脚本被静默截断（踩过三次） | 用 heredoc 往 `ssh … 'bash -s'` / `docker exec -i` 里喂脚本时，里面任何读 stdin 的命令会把后面整段吞掉。对策：交互 shell 里敲，或命令尾加 `</dev/null` | `ref/docs/06-dev-guide.md:120` |
| 5 | 小程序整包编译 / 上传失败 | `requiredPrivateInfos` 里写了后台尚未开通的接口；被迫撤回一次提交 | `ref/apps/mobile/src/app.config.ts:60-63` |
| 6 | 订阅消息推送发不出去 | `.env` 里的模板 ID 指向已从账号删掉的旧模板；字段名与模板不逐字一致会回 47003 | `ref/docs/07-platform-config.md:80,88` |
| 7 | 证书签不下来 | 域名未备案时阿里云拦 80 端口回 403，Let's Encrypt HTTP-01 失败；ZeroSSL / Buypass 的 API 境内不可达；只能 acme.sh 手动 DNS-01（不能自动续期），备案通过后才切回 webroot | `ref/docs/08-deployment.md:193-226` |
| 8 | 生产机走 HTTPS 连不上 github | 字体从阿里云自家 dnf 源取；acme.sh 用 Gitee 镜像装 | `ref/docs/08-deployment.md:69,198` |
| 9 | el8 的 base 与 EPEL 都不带 ffmpeg | 从 RPM Fusion 装（境内走中科大镜像） | `ref/docs/08-deployment.md:25-32` |
| 10 | 字幕缺字但 ffmpeg 退出 0 | libass 字体族名对不上不报错、回落系统字体；生产机没有中文字体。对策：能力探测真渲一帧核对；CI 里把系统中文字体删干净再跑 golden | `ref/docs/08-deployment.md:69`、`ref/.github/workflows/ci.yml:64-70,93-101` |
| 11 | 部署时正在抽帧的任务当场失败 | PM2 默认 `treekill`，SIGINT 同时打到 ffmpeg 子进程；只有纯 IO 任务等得到收尾 | `ref/infra/ecosystem.config.cjs:32-35` |
| 12 | `pm2 pid` / `pm2 jlist` 的 stdout 被污染 | 内存里的 PM2 与 CLI 版本不一致时会先打一段升级提示；解析时只认纯数字行 / 以 `[` 开头的行 | `ref/infra/deploy.sh:236-244`、`ref/docs/08-deployment.md:291` |
| 13 | `.env` 里带空格的值没加引号 | `deploy.sh` 用 bash 读 `.env`，那一行会被当成命令执行；报错还会带出半截密钥值，所以脚本只报行号与键名 | `.env.example:185`、`ref/infra/deploy.sh:126-146` |
| 14 | `pnpm install` 没装 devDependencies | `.env` 里的 `NODE_ENV=production` 被提前读进 shell；所以 `.env` 要到第 4 步才读 | `ref/infra/deploy.sh:311-312` |
| 15 | 进程里有 `.env` 已删掉的键 | `pm2 start` 把整个部署 shell 的环境带进进程；之前手动 `set -a; . .env` 过的残留键 | `ref/docs/08-deployment.md:290` |
| 16 | 重复响应头 | nginx `add_header` 是追加不是替换，HSTS 在 api 与 nginx 两边都发会出现两个 | `ref/infra/nginx-api.conf:38-40` |
| 17 | BullMQ 静默丢任务 | 自定义 jobId 相同会被去重吞掉（重跑必须换 dedupeKey）；jobId 不许含冒号 | `ref/docs/06-dev-guide.md:86,139`、`ref/docs/02-architecture.md` §1.4 |
| 18 | 暂停着的队列不报错 | BullMQ 队列级暂停写在 Redis 里，worker 重启不解除，忘了恢复就是静默停摆 | `ref/docs/08-deployment.md:94-96` |
| 19 | 生产短信驱动是 console | 验证码不发出，**手机号与验证码明文写进 api 日志**，入口却仍可点到 | `ref/docs/07-platform-config.md:177` |
| 20 | downloadFile 域名没登记 | 存相册在真机上**静默失败**；换 CDN 域名要两边一起改 | `ref/docs/07-platform-config.md:41` |
| 21 | 微信内容安全送检 | 未发布的小程序每天只有 100 次额度；送检要带 openid 且该用户**近 2 小时内打开过小程序**；87014 是结论不是故障，当故障重试会白吃额度 | `ref/docs/08-deployment.md:113-119`、`ref/packages/services/src/providers/wechat/wechat.ts:30-47` |
| 22 | LLM 网关 200 空回包 | OpenRouter 上游坏掉时回 200 + 空内容；同一请求重发一次再判失败 | ADR-044 `ref/docs/02-architecture.md:143` |
| 23 | 规划与现实漂移 | 规划写「腾讯云 CVM + Caddy」（D8），实际是「阿里云 ECS + 宿主机 nginx」；v2.0 的核对表是按生产只读核验重写的，并且**所有「已配」后面都跟依据** | `ref/docs/00-project-plan.md:130,605`、`ref/docs/07-platform-config.md:11` |
| 24 | 位置服务一律 503 | 腾讯位置服务 key 要勾 **WebServiceAPI**（不是「微信小程序」）；SK 签名在控制台与 `.env` 两边要一致 | `ref/docs/07-platform-config.md:114` |

---

## 3. 外部平台与服务核对表

「周期」一列：参考工程文档只在三处给了具体数字（位置接口 3 天、订阅模板 1–3 天、「审核周期以周计」的总括），其余没写；没写的标「文档未记」，另给【外部】参考值。

### 3.1 微信侧

| 平台 / 能力 | 在参考工程里的用途 | 开通与审核周期 | 踩坑 / 要点 | 出处 |
| --- | --- | --- | --- | --- |
| 小程序帐号（mp.weixin.qq.com） | AppID / AppSecret：登录（code2session）、手机号、订阅消息、内容安全共用，access_token 缓存在 Redis（键 `wechat:access_token:<appId>`） | 文档未记。总括：「全部为控制台操作；审核周期以周计」，M0 第一天并行启动 | **主体须为企业 / 组织**，一键手机号不对个人主体开放 | `ref/docs/07-platform-config.md:8,19-22`、`ref/docs/00-project-plan.md:410`、`wechat.ts:24,82-103` |
| 小程序备案 | 参考工程文档**没提**（它还没发正式版） | 【外部】新小程序上线前须完成备案，整体 1–22 个工作日（平台初审 1–2 日 + 管局 1–20 日），备案前要先完成微信认证（300 元）：<https://developers.weixin.qq.com/community/develop/article/doc/00060696d3c0a851fc30af38761013> | 新产品必须把它排进 M0 | — |
| 服务类目 | 待核；「提审时类目要与功能一致」 | 文档未记 | 见 §5.5 风险：播放短剧内容可能触发【文娱-微短剧】类目 | `ref/docs/07-platform-config.md:23` |
| 服务器域名 | request：`api.timavia.com`；uploadFile / downloadFile：COS 桶默认域名 | 即时生效，但**只接受已备案域名** | 换 CDN 域名或换桶要同步改；每月修改次数有限（文档未记，【外部常识】） | `ref/docs/07-platform-config.md:28-43` |
| 接口权限（位置类） | `chooseLocation`、`getFuzzyLocation` | **2026-09-04 提交、09-07 通过（约 3 天）** | 2022-07-14 后注册的帐号要逐个申请；先通过再写进 `requiredPrivateInfos`；通过后还要在隐私指引里勾 | `ref/docs/07-platform-config.md:45-54`、`app.config.ts:62` |
| 用户隐私保护指引 | 11 类信息逐项勾 + 指引正文 | 文档未记（正文还在等律师） | errno 112；开发 / 体验版同样受约束；「摄像头」与「选中的照片或视频」是两项 | `ref/docs/07-platform-config.md:56-76` |
| 订阅消息模板 | 片子好了 / 每日梳理 / 待复核提醒（公共模板库选用） | **「模板审核 1–3 天」** | 字段逐字一致（47003）；模板被删后 env 没换；`miniprogram_state`；一次订阅一条 | `.env.example:25`、`ref/docs/07-platform-config.md:78-90` |
| 插件：微信同声传译 | 录音边录边识别 | 文档未记（旧版清单把「同声传译插件」列为有审核周期的事项） | 版本号必须与后台一字不差；≤60s | `ref/docs/07-platform-config.md:92-98`、`ref/docs/00-project-plan.md:579` |
| 内容安全 2.0（`msg_sec_check`） | 成片标题 / 字幕 / 发布文案送检 | 无需单独开通 | 未发布小程序 100 次/天；openid 2 小时窗口；错误码要分「结论」与「故障」 | `ref/docs/08-deployment.md:107-119` |
| 手机号快速验证（`getPhoneNumber`） | 一键绑定 / 登录 | 无需单独开通 | 【外部】**每次成功调用 0.03 元**，每个小程序 1000 次体验额度（正式 / 体验 / 开发版共用）：<https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html>（收费说明见社区置顶 <https://developers.weixin.qq.com/community/develop/doc/0000c8b37b80b0e314ff9cb2e51800>）。参考工程文档没提费用 | `src/pages/profile/index.tsx:168` |
| 体验版 / 体验成员 | 闭测全靠体验版 | 即时 | 只有体验成员打得开；订阅消息要 `trial` | `ref/docs/07-platform-config.md:25-26` |
| 微信开放平台 | 企业主体注册、绑定小程序 → unionid | 旧版清单：「约 300 元认证费」；周期未记 | 多端同账号预留 | `ref/docs/07-platform-config.md:100-105`、`git show 1d46beb:docs/07-platform-config.md` |
| 微信支付 | **未使用** | — | 新产品必须新增，见 §5.2 | 全仓无 `requestPayment` |

### 3.2 腾讯云

| 服务 | 用途 | 生产状态 | 踩坑 / 要点 | 出处 |
| --- | --- | --- | --- | --- |
| COS | 全部上传文件、成片与封面、抓来的视频 | 已配（上海，公有读 + 私有写 + 随机 key，默认域名无 CDN） | S3 兼容接口，`STORAGE_FORCE_PATH_STYLE=false` 时 presigned POST 地址是虚拟主机式桶域名；桶要配 POST 的 CORS；公有读是否合规列入律师清单 | `ref/docs/07-platform-config.md:31,111`、`ref/docs/10-privacy-policy.md:103` |
| ASR | 一句话识别（≤60s）+ 录音文件识别（≤5h，按 URL 拉文件） | 已配 | 不依赖 SDK，自写 TC3 签名；文件识别是异步轮询，只在 worker 调 | `ref/docs/07-platform-config.md:112`、`ref/packages/services/src/providers/tencent/sign.ts:10` |
| SMS | 验证码（登录 / 绑定 / 换绑），签名 + 3 个模板 | **未启用**（密钥已配但 `SMS_DRIVER=console`）；签名与模板「旧版记为已完成，待核」 | 旧版清单：约 0.045 元/条；模板是单参数验证码模板 | `ref/docs/07-platform-config.md:113`、`ref/packages/services/src/providers/sms/tencent.ts:12` |
| 位置服务 LBS | 模糊位置 → 城市 | 已配（key + SK 签名） | 勾 WebServiceAPI；不用 IP 白名单（换 IP 不用改控制台）；key 只放服务端 | `ref/docs/07-platform-config.md:114` |
| CVM | 规划里的主机 | **实际没用**（主机在阿里云） | — | `ref/docs/08-deployment.md:8` |

### 3.3 阿里云

| 项 | 现状 | 出处 |
| --- | --- | --- |
| ECS | 1 台 2 vCPU / 1.8G，跑 nginx + PM2 + Docker(pg / redis) | `ref/docs/07-platform-config.md:116-124` |
| 域名 / 备案 | `timavia.com` ICP 备案 2026-09-08 通过（申请日期文档未记）；备案前 80 端口被拦 | `ref/docs/08-deployment.md:9,195` |
| dnf 源 | 中文字体包从阿里云自家源取 | `ref/docs/08-deployment.md:69` |
| OSS / RDS / 云监控 | **都没用** | — |

### 3.4 大模型与其他

| 线路 | 生产取值 | 境内 / 境外 | 要点 | 出处 |
| --- | --- | --- | --- | --- |
| 主链路 + 视觉 | OpenRouter · `minimax/minimax-m3` | **境外** | 2026-09-08 从 DeepSeek 直连改过来；`OPENROUTER_PROVIDER_ORDER=StreamLake`；关思考 | `ref/docs/07-platform-config.md:126-136`、`ref/docs/08-deployment.md:156-159` |
| 音频 | OpenRouter · `xiaomi/mimo-v2.5`（后备，优先走腾讯云 ASR） | 境外 | 音频只能 base64 发送 | `.env.example:142-153` |
| 备用 | 火山方舟 · 豆包（只接文本） | 境内 | key 是否已配：待核 | `ref/docs/07-platform-config.md:133` |
| 境内切换（P02） | **未做**，用户决定暂缓 | — | 隐私政策必须如实写出境外处理方；合法性待律师结论；与原则「国内可达、不以海外 SaaS 作主路径」不符 | `ref/docs/07-platform-config.md:134`、`ref/docs/00-project-plan.md:518,588` |
| Sentry | 代码已接，生产未配 | — | — | `ref/docs/07-platform-config.md:142` |
| GitHub | 代码托管 + Actions CI | — | 生产机 HTTPS 连不上 github（SSH 拉代码可用） | `ref/docs/08-deployment.md:38,69` |
| 抖音 / 视频号 | 仅「同行参考」抓公开作品（非官方接口，有封号 / 签名淘汰风险） | — | 与新产品无关；新产品 V1.0 不对接抖音 / 视频号任何接口（`PRD.md:1058-1059`） | `ref/docs/06-dev-guide.md:80-86` |

**法务在途事项**（参考工程自己还没解决，新产品会遇到同类问题）：个人信息出境、算法备案、AI 显式 / 隐式标识取值、公有读对象存储是否合规、短信验证码进日志、人工抽检告知（`ref/docs/10-privacy-policy.md:93-107`）。

---

## 4. CI / 质量门禁

### 4.1 GitHub Actions（`ref/.github/workflows/ci.yml`，唯一的工作流）

触发：push 到 main、所有 PR；`concurrency` 同 ref 取消在途（L3-10）。

**Job 1 `verify`**（ubuntu-latest，20 分钟上限；services 起 `postgres:16-alpine` 与 `redis:7-alpine`，L13-43）：
1. `pnpm install --frozen-lockfile`
2. `prisma validate`
3. `prisma migrate deploy`（对 CI 库把全部迁移真跑一遍）
4. `pnpm lint`（ESLint 9 flat，全仓）
5. `pnpm format:check`（Prettier）
6. `pnpm typecheck`（`pnpm -r typecheck` + `tsc -p infra`；**含小程序的 tsc**）
7. `pnpm test`（Vitest projects：`packages/*`、`apps/api`、`apps/worker`、`infra`；服务层与 api 的集成测试连真实 PG，各用独立 `test_*` schema）
8. **契约漂移检查**：`pnpm contract:check` = 重新生成 OpenAPI 与类型后 `git diff --exit-code -- generated`
9. `pnpm --filter @liyo/api --filter @liyo/worker build`

**Job 2 `render`**（ubuntu-22.04 + 系统 ffmpeg 4.4.2，L71-120）：成片渲染 golden 测试；Noto CJK 只解包到隔离目录、删掉系统里所有能画汉字的字体（与生产一致）；`RENDER_GOLDEN_REQUIRED=1` 让能力探测不过时直接失败而不是全 skip 显示绿；角标 on / off 各跑一遍。

### 4.2 本地门禁

- husky `pre-commit` → `lint-staged`（ts/js：`eslint --fix` + `prettier --write`；json/md/yml/scss：`prettier --write`）；`commit-msg` → commitlint（conventional）（`ref/.husky/*`、`ref/.lintstagedrc.json`）。**pre-commit 不含 typecheck**，要求提交前手跑 `pnpm typecheck && pnpm test`（`ref/AGENTS.md:45`）。
- 不直接推 main：`feat/*` / `fix/*` 分支 + PR + CI 通过后合并（`ref/AGENTS.md:45`）。
- ESLint 关键规则：禁 `any`、强制 `import type`、禁 `console.log`、禁 `axios`、小程序禁浏览器全局（`ref/eslint.config.js:32-51,73-79`）。
- 测试库隔离：`resetDatabase()` 在非 `test_*` schema 上直接拒绝执行（`ref/docs/06-dev-guide.md:91`、`ref/AGENTS.md:47`）。
- 环境变量：全部经 `loadEnv()` Zod 校验，缺必填项启动即失败；部署时用新构建的 `check-env.js` 预检（`ref/docs/06-dev-guide.md:48`、`deploy.sh:155-162`）。
- 文档同步规则：改契约 / 改表 / 架构决策 / 新增 env 各对应一份文档，ADR 只增不改（`ref/AGENTS.md:89-91`）。

### 4.3 门禁之外（没有的）

| 缺口 | 说明 |
| --- | --- |
| 小程序构建不在 CI | CI 只 build api / worker，不跑 `taro build`，主包体积、构建能否通过都不拦 |
| 小程序无自动化测试 | 靠 `docs/09` 真机用例清单；清单里大量 P0 仍是未测状态 |
| 无自动部署（CD） | 人登录生产机跑脚本；无制品、无预发环境 |
| 无依赖 / 密钥扫描 | 工作流里没有 audit、secret scan |
| 规划里写的「依赖方向校验」「破坏性变更需显式标记」 | CI 里没有对应步骤（`ref/docs/00-project-plan.md:533` vs `ci.yml`） |

---

## 5. 对新产品的建议

### 5.1 可以直接复用（改名即可）

| 类别 | 可复用内容 | 说明 |
| --- | --- | --- |
| **Monorepo 模板** | pnpm workspace（`apps/{mobile,api,worker}` + `packages/{contract,db,services,shared,config}`）、Node 24 / TS strict / 全 ESM、ESLint flat + Prettier + commitlint + husky、Vitest projects、tsup 打包内联工作区包（ADR-017） | 依赖方向单向：`shared ← contract ← services ← api/worker`（`ref/AGENTS.md:30`）。新产品多一个 `apps/admin`（PC 后台前端） |
| **契约链** | Zod schema → OpenAPI 3.1 → `openapi-typescript` 生成类型，CI 漂移检查；「接口三步走」 | 新产品接口数量会是参考工程的数倍（47 + 56 个画板），这条纪律更值钱；PC 后台前端同样吃生成类型 |
| **服务端骨架** | Hono app 的中间件栈（requestId → secureHeaders → logger → bodyLimit 1MB → timeout 30s → 限流）、错误双通道、`ServiceContext` 装配、Provider「未配置不崩溃」（50001）、Redis 固定窗口限流、`/health` + worker 心跳 | `ref/apps/api/src/app.ts:49-86` |
| **认证** | JWT 双 token + refresh 轮换 + 密钥轮换（小程序端）；管理后台的邮箱 + 密码（scrypt）+ **TOTP** + Redis 会话 + 5 次锁 15 分钟 + 写操作留痕 + `__Host-` cookie + 自定义头防 CSRF（ADR-063） | PRD 要求后台「登录须二次验证；关键操作二次确认并记录日志」（`PRD.md:1038`），ADR-063 的身份与留痕部分正好对上；但它**只有账号、没有角色权限**，RBAC（8 个角色 × 模块矩阵，`PRD.md:266-287`）要新做 |
| **异步任务** | BullMQ 队列 + `ai_jobs` 产品可见状态 + 幂等 jobId + 指数退避 + Job Scheduler 定时 + 补偿扫描（`studio_compensate` 的「各线各判失联」思路）+ 队列暂停 / 恢复 CLI | 新产品约 35 条时间驱动规则（sibling 报告 `prd-tech.md` §0-5）可以直接套 Job Scheduler + 扫描幂等的写法 |
| **Provider 实现** | `storage/s3.ts`（COS / MinIO）、`wechat/wechat.ts`（code2session / 手机号 / 订阅消息 / 内容安全 + access_token Redis 缓存与失效重取）、`sms/tencent.ts` + `sms/console.ts`、`asr/tencent.ts`（一句话 + 录音文件识别）、`tencent/sign.ts`（TC3 签名，不依赖 SDK）、`llm/openai-compatible.ts`（主备切换、空回包重发、思考预算）、`geo/tencent.ts` | 都带单测；`@liyo/services/testing` 有假 Provider 与可拨时钟 |
| **部署脚本** | `infra/deploy.sh` + `check-proc-env.sh` + `ecosystem.config.cjs` + `compose.yml` / `compose.prod.yml` + `nginx-api.conf` + `deploy.test.ts` | 改掉硬编码的 `liyo-*` / `/opt/liyo` / `api.timavia.com` 即可；render 队列暂停那段按需保留 |
| **小程序基础设施层** | `config/index.ts`、`request.ts`、`auth.ts`、`storage.ts`、`privacy.ts`、`authorize.ts`、`upload.ts`、`attachments.ts`、`media.ts`、`album.ts`、`subscribe.ts`、`refresh.ts`、`nav.ts`、`toast.ts`、`prompt.ts`、`audio.ts`、`recorder.ts`（去掉插件分支）、`usePolling`、`useImageUploads`、`tokens.scss` / `mixins.scss`、构件库、tabBar 图标生成脚本 | 新产品「上传素材」6 类（图片 / 视频 / 录音 / 聊天音频 / 聊天文档 / 文字，【原型 merchant/AssetUpload】）与参考工程「速记附件」**几乎同构**：`chooseMedia` + `chooseMessageFile` + 录音 + 直传 + 体检，可整段搬 |
| **CI 工作流** | `ci.yml` 的 verify job | 加一步小程序与后台前端的 build |
| **文档体例** | 00 规划 / 01 SRS / 02 架构 + ADR / 03 数据模型 / 04 契约 / 05 小程序指南 / 06 开发指南 / 07 平台核对表 / 08 部署 / 09 回归用例 / 10 隐私指引 + `AGENTS.md` | 特别是 07 的写法：**每个「已配」后面都跟依据**，没截图核对的写「待核」 |
| **平台账号与资源** | 已认证的企业主体（小程序、开放平台）、已备案的 `timavia.com`、腾讯云账号（COS / ASR / SMS 签名 / LBS）、阿里云账号、火山方舟账号、GitHub 组织 | 【推断】同主体下新开资源比从零注册快；但**每一项是否复用要逐个拍板**，见 §5.4 |

### 5.2 需要新增（参考工程里没有）

| # | 新增项 | PRD / 原型依据 | 参考工程的差距与提示 |
| --- | --- | --- | --- |
| 1 | **微信支付（JSAPI / 小程序支付）+ 退款 + 账单下载对账** | 默认微信支付；原路退回；每日自动下载前一日账单逐笔核对（`PRD.md:684,823,826`） | 全仓没有支付。要申请**商户号**并与小程序 AppID 关联（【外部】资料审核约 1–5 个工作日：<https://developers.weixin.qq.com/community/pay/doc/000a6a96b50fa0a233a1c7a686b800>）；需要 API v3 密钥、商户证书、回调域名（已备案 HTTPS）。**AGENTS 规则 5「请求路径内禁止同步调外部服务」要为下单开例外**；支付回调要幂等、验签、可重放 |
| 2 | **对公转账凭证 + 财务确认流** | `PRD.md:684,787` | 纯业务流，无外部依赖；凭证图走现有直传 |
| 3 | **PC 运营后台前端（SPA）** | 56 个画板，Chrome / Edge，≥1366×768（`PRD.md:1031`） | 参考工程的后台是一段**没有构建步骤的字符串页面**（ADR-063），不能当模板。需新选前端栈、新增 `apps/admin`、静态托管与新域名（或子路径）、CORS / cookie 策略 |
| 4 | **RBAC** | 8 个内部角色 × 模块权限矩阵 + 数据范围（`PRD.md:253-287`） | 参考工程后台无角色；小程序侧只有 IP 维度的 owner / admin / editor / viewer |
| 5 | **视频点播 / 转码 / 多码率 / 水印 / CDN / 签名防盗链** | 预告片首帧 ≤1.5 秒、多码率自适应、CDN；预告片与样片加水印、播放地址签名带有效期、防盗链；成片包下载链接签名 7 天有效（`PRD.md:1027,1036`） | 参考工程是公有读桶 + 默认域名 + mp4 直链，**一样都没有**；`StorageProvider` 没有签名读接口。需要点播（VOD）或「COS + 数据万象 / 媒体处理 + CDN 鉴权」；CDN 自定义域名要备案并加进 downloadFile 合法域名 |
| 6 | **大文件分片 / 断点续传上传** | 视频单个 ≤200MB、断点续传（`PRD.md:1030`）；素材相册视频 ≤500MB（`PRD.md:726`）；后台批量上传原片 / ZIP，单文件 ≤200MB、单集 80–90MB（【原型 admin/DramaEdit】） | 现有 presigned POST 是单请求、上限 50MB、无续传。小程序端要用分块上传（按片读文件 + 逐片签名上传）；PC 后台走浏览器分块直传（桶 CORS） |
| 7 | **成片包分发** | 按集下载或打包下载；一部剧 60–80 个视频、1.9–5.4GB（`PRD.md:597`；【原型 merchant/Publish】【原型 admin/Delivery】） | `album.ts` 的单文件存相册可复用（单集几十 MB，低于 200MB 上限）；**「打包下载」在小程序里做不了**（见 §5.5 冲突 C5） |
| 8 | **OCR（营业执照 / 许可证）** | OCR 识别主体名称、统一社会信用代码、经营者、有效期；审核页并排展示证照原图与 OCR 结果（`PRD.md:451,775`） | 参考工程没有 OCR Provider；只有「LLM 视觉识图起草档案」（`ref/docs/10-privacy-policy.md:52`）。【推断】证照识别应走云厂商的专用 OCR 接口（结构化、境内、可审计），按 Provider 模式新增 `OcrProvider`，TC3 签名可复用 |
| 9 | **通知类短信** | 成片交付、上线日前 1 天与当天「通过订阅消息和短信提醒」；消息模板管理含短信模板（`PRD.md:603,846`） | 现有 `SmsProvider.send` 只有验证码三个场景（`providers/types.ts:9-12`），且生产从未真发过。要新申请**通知类模板**（与验证码模板分开审核），接口要扩成「模板 + 多参数」 |
| 10 | **站内消息中心 + 多模板订阅消息** | 订单、交付、上线、套餐与积分、审核、门店、客服 7 类消息（`PRD.md:657`） | 一次订阅只保证一条；多节点提醒要在多个点按处分别征求订阅，或以站内消息 + 短信兜底 |
| 11 | **PDF 文书**（授权书、协议）与**电子发票文件** | 《定制内容授权书》PDF 预览与下载、发票下载（`PRD.md:655-656,1063-1071`） | 参考工程不生成 PDF；小程序端 `openRemoteDocument`（下载 + `openDocument`）可复用（`src/utils/media.ts:142-159`） |
| 12 | **小程序客服消息 / 企业微信** | 在线客服接入小程序客服消息；服务经理企业微信二维码；员工账号绑定企业微信（`PRD.md:636-637,851`） | 参考工程只有 `openType="contact"` 按钮，没有服务端消息接入 |
| 13 | **敏感字段加密存储与脱敏** | 手机号、证照等加密存储、脱敏展示（`PRD.md:1035`） | 参考工程 `users.phone` 是明文 `VarChar(20)` 唯一索引（`ref/packages/db/prisma/schema.prisma:20`） |
| 14 | **导出与报表** | 所有列表支持导出；对账按日 / 月导出（`PRD.md:737,826`） | api 有 30 秒超时与 1MB 请求体上限；大导出要走异步任务 + 签名下载 |
| 15 | **预发 / 测试环境** | 支付、退款、积分账务无法在生产上试 | 参考工程只有本地 + 生产 |
| 16 | **监控告警、异地备份、日志轮转** | 可用性 ≥99.9%；每日备份保留 30 天（`PRD.md:1029,1039`） | 参考工程 Sentry 未配、无探活、备份 14 天且只在本机 |
| 17 | **小程序错误上报、埋点、`miniprogram-ci`** | PRD 第 9 章埋点（`PRD.md:985-1016`） | 参考工程都没有 |
| 18 | **工作日历**（工作日 / 节假日调休） | 大量「N 个工作日内」时限 | 参考工程只有自然日定时 |

### 5.3 复用时要改的地方（不是原样可用）

| 项 | 参考工程做法 | 新产品要怎么改 |
| --- | --- | --- |
| 对象存储读权限 | 公有读 + 随机 key（D6；私有桶 + 签名 URL 原本就列为 V1.1） | **从第一天就用私有桶 + 签名读**：证照、合同、成片、原片都不能公有读；`StorageProvider` 增加 `presignGet` |
| 上传上限与方式 | 5 / 50 / 100 / 20 MB，presigned POST | 登记表保留，视频另走分块上传通道；`uploadFile` 补 `timeout` |
| 录音 | 插件 + 60 秒分段 | 原生录音器单段 ≤5 分钟 + 服务端录音文件识别 |
| 登录 | 静默 openid 建号 + 手机号后绑 + 并号 | 手机号为主体；【推断】仍建议冷启动先静默拿 openid 做「游客态」（原型有「先逛逛，看看有哪些短剧」入口，【原型 merchant/Login】），点「手机号快捷登录」时再升级为正式账号 |
| 大模型线路 | 境外 OpenRouter 为主 | **境内线路为主**（参考工程自己的风险 R10 与律师清单第 1 条）；Provider 是 OpenAI 兼容协议，换 base URL 即可 |
| 短信 | console 驱动把手机号与验证码写日志 | 生产禁用 console 驱动或不记明文 |
| Swagger | 公网可访问 | 生产关闭或加鉴权 |
| 运行用户 | root | 专用非 root 用户（参考工程文档自己承认这是欠账） |
| 管理后台入口 | 与 api 同域 `/admin` | 【推断】独立子域 + 可选 IP 白名单 / 内网入口 |
| JWT `aud` / `iss`、存储键、Redis 键、队列名 | `liyo` / `liyo-identity` / `liyo.*` / 无前缀 | 全部换成新产品自己的命名空间（见 §5.4 的 Redis 一栏） |

### 5.4 与参考工程共用 机器 / 数据库 / Redis / 域名 / 小程序 的利弊

| 资源 | 共用的好处 | 共用的问题 | 建议【推断】 |
| --- | --- | --- | --- |
| **机器**（现有阿里云 ECS） | 零新增成本；nginx / 证书 / 部署套路现成 | 2 vCPU / 1.8G 已经吃紧：部署要 2G swap、要暂停渲染队列，渲染时 api 延迟翻倍、swap 活跃（`ref/docs/08-deployment.md:33-35,79-90,299`）；两个 api + 两个 worker 常驻约 1GB 以上放不下；一切 root 跑、无隔离；故障域合一；新产品带**支付与账务**，不该与一个跑非官方抓取、ffmpeg 渲染的闭测产品同机 | **不共用**。新开机器，≥2 核 4G 起步（参考工程文档自己的建议值，`ref/docs/08-deployment.md:16`），媒体处理重的话另行评估 |
| **云厂商** | 沿用阿里云 ECS：账号、备案接入商现成 | 参考工程是「阿里云主机 + 腾讯云 COS」跨云，读写对象存储走公网；新产品是**重媒体**（单部剧 2–5GB、原片每集 80–90MB），跨云流量与延迟都会放大 | **计算与存储放同一朵云同一地域**。两种走法各有代价：全放腾讯云（COS / 点播 / ASR / SMS / 微信生态账号现成，但域名备案要在腾讯云做接入备案）；或全放阿里云（主机与备案现成，但 OSS / 点播 / OCR / 短信要新开，Storage Provider 是 S3 兼容可以接 OSS）。需架构师拍板（Q3） |
| **PostgreSQL 实例** | 少一个实例；备份脚本现成 | 现有实例是 1.8G 机器上的 Docker 单容器、本机 14 天备份、无异地副本、无 PITR；新产品有付款单、积分账本、发票，**RPO 要求远高于参考工程**；共用实例时一方的慢查询 / 迁移 / 误操作影响另一方；PRD 要备份保留 30 天 | **不共用实例**。【推断】账务类数据建议用云托管 PostgreSQL（自动备份 + 时间点恢复 + 高可用），或至少独立实例 + 异地备份。**绝不共用 database / schema** |
| **Redis** | 少一个实例 | 参考工程的 BullMQ 队列名是**无前缀的通用名**（`ai-tasks` / `push` / `maintenance` / `downloads` / `render`，`ref/packages/services/src/queue/names.ts:2-22`，`new Queue(name, { connection })` 未设 prefix，`queues.ts:117-121`）；限流键 `rl:*`（`rate-limit.ts:20`）；access_token 键 `wechat:access_token:<appId>`。**从模板复制的新工程若连同一个 Redis 且不改名，两边 worker 会互相消费对方的任务**。另外 Redis 里放着后台会话与限流计数，共用即共享爆炸半径 | **不共用**。就算独立实例，也给 BullMQ 配 `prefix`、给所有键加产品前缀，防止将来误连 |
| **域名** | `timavia.com` 已备案，子域名（如 `api-xxx.timavia.com` / `admin-xxx.timavia.com` / `cdn-xxx.timavia.com`）不用等新备案；小程序服务器域名只接受已备案域名 | 品牌上对外露出 timavia；若换到另一朵云，要在那朵云做**接入备案**；cookie 作用域要注意（参考工程后台用 `__Host-` 前缀 cookie，天然不跨子域） | **共用主域、分子域**是最快路径；若要独立品牌域名，把新域名备案排进 M0（参考工程的经验：未备案期间 80 端口被拦、证书只能手动 DNS-01） |
| **api 域名 / nginx server** | — | 同一个 `server_name` 下挂两个产品要靠路径分流，日志、限流、证书、回滚都缠在一起 | 各用各的子域与 server 块 |
| **COS 桶** | — | 参考工程的桶是公有读；新产品要私有读 + 生命周期（成片包 7 天链接、素材保留策略） | **新桶**（可同账号）；按用途分桶或分前缀：原片 / 成片 / 素材 / 证照合同 |
| **小程序 AppID** | 复用已认证帐号：省认证与备案时间；名称「狸有戏」已占 | 两个产品挤一个小程序：类目、隐私指引、服务器域名、订阅模板、体验成员、提审节奏全部耦合；**两个后端各自缓存 access_token 会互相顶掉**（参考工程用 `cgi-bin/token` 取 token 并按 AppID 存进自己的 Redis，`wechat.ts:82-103`；【外部常识，需核实】该接口重新获取后旧 token 很快失效，两套后端不共享缓存就会来回失效，要么共用一个取 token 的服务，要么改用稳定版 token 接口）；微信支付商户号绑定、微短剧类目都压在同一个号上 | 需业务先定（Q1）：若参考工程的小程序将来就是被新产品**替换**，复用 AppID 并停掉旧后端的微信调用；若两个产品并存，新注册小程序（名称不能与已有小程序重名，需另取名或做名称迁移），并在开放平台绑到同一主体下以共享 unionid |
| **腾讯云 / 阿里云 / 火山账号** | 实名与企业认证现成；SMS 签名若是「狸有戏」可直接复用（旧版清单写的签名就是「狸有戏」） | 账单混在一起；密钥权限面过大 | 同账号、**分子账号 / 分密钥 / 分资源标签**；新产品用独立的访问密钥，最小权限 |
| **GitHub 仓库** | — | 参考工程 AGENTS.md 明确「不引用、不复制外部旧仓库代码」是对它自己说的；新产品目录 `liyoxi-project` 目前不是 git 仓库 | 新仓库，从模板**拷贝并改名**（不做 git 依赖 / 子模块），避免两个产品的发布节奏互相牵制 |

### 5.5 PRD 与参考工程做法 / 平台能力的冲突点（技术风险）

| # | 冲突 | 说明 |
| --- | --- | --- |
| C1 | **可用性 99.9%**（`PRD.md:1029`）vs 单机形态 | 参考形态每次部署都有几秒中断、无冗余、无探活告警、worker 单实例。99.9% ≈ 每月约 43 分钟停机预算，单机 + 人工部署可以碰运气达到，但没有任何保障手段 |
| C2 | **签名、防盗链、水印**（`PRD.md:1036`）vs 公有读桶直链 | 必须换分发方式，见 §5.2 #5 |
| C3 | **上传上限互相矛盾**：10.1 写「视频单个不超过 200MB，支持断点续传」（`PRD.md:1030`），6.16 写「相册视频单条不超过 5 分钟、500MB」（`PRD.md:726`）；参考工程实际上限 50MB 且无续传 | 需业务统一口径（Q5） |
| C4 | **备份保留 30 天**（`PRD.md:1039`）vs 14 天本机备份 | 需异地 + 30 天 |
| C5 | **成片包「打包下载」**（`PRD.md:597`；原型显示 80 个视频约 2.6GB）vs 小程序能力 | `wx.downloadFile` 单次 ≤200MB（见 §1.8），且小程序只能把 mp4 逐个存相册、不能把 zip 存到手机可用位置；参考工程存相册后立刻删本地副本以免占配额（`album.ts:98-105`）。80 集逐个存相册在门店 4G 下耗时很长（参考工程一条十几 MB 的片子都要专门调超时）。【推断】小程序里只做「逐集 / 批量排队存相册 + 进度 + 断点重试」，「打包下载」改为「复制链接到电脑浏览器下载」 |
| C6 | **多节点提醒靠订阅消息**（`PRD.md:603,1104`：T-30 / T-7 / T-1 天等）vs 一次订阅一条 | 一次性订阅消息每次授权只能发一条；跨几十天的多次提醒必须靠多次征订、长期订阅模板（类目受限）、短信或站内消息兜底 |
| C7 | **小程序内播放短剧内容**（预告片 V1.0；前几集试看 V1.1，`PRD.md:311,538`）vs 微信【文娱-微短剧】类目 | 【外部】微信规定符合微短剧判定的小程序须申请该类目（需《广播电视节目制作经营许可证》等）、剧目须提审、统一用官方短剧播放器播放，同一主体仅支持一个帐号做广电备案登记（<https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/industry/videoplayer.html>；类目资质问答 <https://developers.weixin.qq.com/community/develop/doc/000a8456ccc1d025cc3f4a8b451000>）。【推断】本产品是 B 端选剧工具、播的是预告片与样片，是否落入「微短剧判定」不确定，但 V1.1 的「选集试看」风险明显更高；这会影响类目、提审周期和播放器选型，**上线前必须与微信侧 / 法务核实** |
| C8 | **手机号加密存储**（`PRD.md:1035`）vs 明文唯一索引 | 需要加密列 + 可检索的确定性摘要列 |
| C9 | 「请求路径内禁止同步调外部服务」（`ref/AGENTS.md:38`）vs 支付下单、OCR 即时回显 | 规则要重写成「除支付下单 / 查询等必须同步的调用外」并给这些调用设短超时与降级 |
| C10 | api 30 秒超时 + 1MB 请求体（`ref/apps/api/src/app.ts:56-57`）vs 后台导出、批量操作 | 导出走异步任务 |
| C11 | 在生产机上现场构建 vs 新产品多一个前端构建 | 后台 SPA 的构建更吃内存；【推断】新产品应改为 CI 出制品（或至少在构建机上构建），生产机只拉制品 |
| C12 | `getPhoneNumber` 计费 | 登录、店员受邀加入都要「微信手机号验证」（`PRD.md:389,714`），每次 0.03 元；量小但要进成本与防刷考虑（登录态有效期内不要重复调用） |

### 5.6 M0 平台事项清单（建议第一天并行启动）【推断，周期为参考工程记录 + 外部参考值】

| 事项 | 参考周期 | 依赖 |
| --- | --- | --- |
| 决定小程序 AppID（复用 / 新注册）；新注册则微信认证 | 认证数个工作日 | Q1 |
| 小程序备案 | 1–22 个工作日（【外部】） | 认证完成 |
| 服务类目（含是否涉及微短剧类目） | 微短剧类目资质备案登记约 7 个工作日（【外部】） | Q2、法务 |
| 域名：子域解析 + 证书；若新域名或换云则备案 / 接入备案 | 子域即时；备案以周计 | Q3 |
| 微信支付商户号申请 + 关联 AppID + API v3 密钥与证书 | 1–5 个工作日（【外部】） | AppID、对公账户 |
| 订阅消息模板（审核结果、交付、上线提醒、套餐到期、积分清零…） | 1–3 天（参考工程记录） | 类目确定后才能选模板 |
| 隐私保护指引：手机号、照片或视频、文件、麦克风、相册（仅写入）、剪切板 | 随版本审核 | 功能清单冻结；法务审正文 |
| 短信：签名复用 / 新申请 + **通知类模板** | 以天计（文档未记） | 文案定稿 |
| 对象存储新桶（私有）+ CORS + 点播 / 媒体处理 + CDN 域名与鉴权 | 即开；CDN 域名需备案 | Q3 |
| OCR 开通（营业执照、食品经营许可证） | 即开 | Q3 |
| ASR 录音文件识别（已有账号可复用） | 即开 | — |
| 境内大模型接入点与密钥 | 即开 | 模型选型 |
| Sentry（或同类）+ 探活 + 备份桶 | 即开 | — |
| 企业微信（服务经理二维码、员工绑定） | 以天计 | 业务 |

---

## 6. 需要拍板的问题

- **Q1 小程序帐号**：新产品是复用参考工程那个已叫「狸有戏」的小程序 AppID，还是新注册？两个产品是并存还是替代关系？
- **Q2 类目与播放**：商家端在小程序里播预告片 / 样片（V1.1 还有整集试看），是否会被认定为微短剧小程序？是否具备《广播电视节目制作经营许可证》？这决定类目、播放器组件与提审周期。
- **Q3 云与地域**：新产品的计算、数据库、对象存储 / 点播放哪朵云？是否接受与参考工程一样的跨云形态？
- **Q4 可用性目标的含义**：99.9% 是对外承诺还是内部目标？是否接受 V1.0 单应用节点 + 托管数据库，V1.1 再做多节点？
- **Q5 上传上限**：视频到底是 200MB 还是 500MB？是否必须断点续传（实现成本差一个量级）？
- **Q6 成片包交付方式**：小程序内逐集存相册 vs 给一个电脑端下载链接 vs 两者都要？
- **Q7 数据库**：是否采用云托管 PostgreSQL（含 PITR）来承载付款与积分账务？
- **Q8 管理后台入口**：独立子域 + 公网 TOTP，还是加 IP 白名单 / VPN？
- **Q9 境内大模型**：素材识别 / 转写 / 打标用哪家境内模型？是否完全禁止境外线路？
- **Q10 预发环境**：是否单独备一个预发小程序（或用体验版指向预发 API）来测支付与账务？
- **Q11 定制成片的制作在不在系统内**：V1.0 是剪辑师线下制作后上传成片，还是系统内要有渲染 / 合成管线（决定是否需要复用参考工程的 ffmpeg 渲染经验与算力规划）？
- **Q12 短信通道**：通知类短信的发送量级与预算；是否复用现有腾讯云短信签名？
