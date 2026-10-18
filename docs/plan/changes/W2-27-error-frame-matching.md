# W2-27：事件帧与私有源码映射匹配

| 项 | 内容 |
| --- | --- |
| 改了什么 | shared纯函数统一安全frame路径/坐标；既有后台和小程序信封消费，ops转发严格清洗。release沿真实build，dist固定组件，abs_path与后继上传name使用app:///组件/完整pair.path。 |
| 原因 | 五组件已有真实私有map，但原轻量信封只有stack字符串，尚不能据其匹配上游源码；先闭合事件与实际bundle路径，不引入SDK或debug ID协议。 |
| 影响的包 | W2-27、W2-29；调度批准shared子路径与既有两客户端/ops的最小消费伴随。不改默认开关、速率/去重、隐私规则、权限、DDL、依赖或Provider。 |
| 类别 | 范围、顺序 |
| PR | 本地codex/w2-27-error-frame-matching；ROOT唯一审查与重型验收，作者不操作远端。 |

最多四新纯聚合，微型Node SourceMap只验证本地生成位置口径。旧无dist安全文件名仅诊断，不补坐标/in_app。上传/CLI/真实SaaS符号化、API/worker自身直报出口与真实E18仍未完，portal按M6后继；W2-27保持进行中。

协议依据：[Sentry官方release/dist传统上传方式](https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/legacy-uploading-methods/)、[CLI上传说明](https://docs.sentry.io/platforms/javascript/sourcemaps/uploading/cli/)。本片不下载安装CLI，不将SDK版本当CLI版本。
