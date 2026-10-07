# 预发小程序一次性上传器

只在独立 Docker 上下文安装 `miniprogram-ci` **2.1.31**，不进入工作区或根锁。Node 基础摘要与既有 server/mediatool 相同，运行用户 1000:1000；SDK 完整闭包冻结在 `package-lock.json`，安装不运行包脚本。

本机/PR 验证不需要账号或网络上传：

```sh
node infra/docker/weapp-uploader/check-lock.mjs
docker build -t liyoxi/weapp-uploader:verify infra/docker/weapp-uploader
docker run --rm --network none --read-only --tmpfs /tmp --cap-drop ALL liyoxi/weapp-uploader:verify --check
docker run --rm --network none --read-only --tmpfs /tmp --cap-drop ALL liyoxi/weapp-uploader:verify --unknown # 应退出 2
```

年龄检查逐个查询官方 npm registry，版本不足七天、哈希/来源缺失、网络失败均停止。首次图的十个近期范围依赖以兼容 major 的精确 overrides 固定为满七天版本；旧 acorn 6 等仍保留。本体 2.1.31 没有升级。SDK 版本和 `Project`/`upload` 能力由 `--check` 真正加载核对。

W2-26b2 的私有节点消费者已接取制品与 SHA256 校验，再复核当前成功部署、公开 AppID/API 及上传器的真实镜像摘要；入口仍是本上传器原 `upload.mjs`，不改它的参数形状。业主配置预发 AppID 和只读上传密钥挂载后，实际上传还要求显式 `LYX_WEAPP_UPLOAD_ENABLED=true` 与全部参数：`--upload --project <产物目录> --appid <wxAppID> --private-key <只读文件> --version sha-<12位提交号> --robot 1`。缺省不上传；只支持预发机器人 1，不提供生产提交路径。日志不透传 SDK 上传进度/异常，不输出密钥内容。消费者本机验证用桩 SDK，没有真实上传；预发仍待外部手验。
