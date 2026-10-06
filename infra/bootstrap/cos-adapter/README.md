# 上海测试桶 COS adapter

独立工具使用 **CPython 3.11.14**（执行时校验精确版本，最低支持 3.11）与腾讯官方 `cos-python-sdk-v5==1.9.44` 的 Python3 wheel。它不属于 pnpm 工作区，不改根依赖或工作区锁。标准 pip/venv 和构建 `crcmod` 所需的 C 编译器由运行环境提供；SDK 及全部运行、构建依赖分别冻结在两份带 SHA256 的锁中。`setuptools==84.0.0` 自带 wheel 构建能力，不另装 `wheel`。

在此目录执行，`python3.11` 必须指向 3.11.14；安装不接触云账号：

```sh
python3.11 -m venv .venv
.venv/bin/python verify_lock.py
.venv/bin/python -m pip install --require-hashes --no-build-isolation -r build-requirements.lock
.venv/bin/python -m pip install --require-hashes --no-build-isolation -r requirements.lock
.venv/bin/python -m pip check
.venv/bin/python adapter.py --check
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest -v test_adapter.py
```

`verify_lock.py` 仅请求公开 PyPI 元数据，逐个核对锁定 artifact 的 SHA256、未撤回和满七天发布时间；网络失败、未知哈希或未满七天的锁内 artifact 都非零退出。最终十一包最晚 artifact 发布时间均满七天；pycryptodome 3.24.0、charset-normalizer 3.5.2 当时未满七天，分别固定为 3.23.0、3.5.1。Python3 SDK wheel 的实际 METADATA 是 `requests>=2.8`；PyPI 项目页聚合的 Python2 旧上限不能用于解析 Python3 依赖。公开 OSV 查询最终十一包未返回已知公告；这不证明软件不存在未公开问题。

公共入口只接受无参数 stdin 的单个 JSON 对象：

```json
{"operation":"lifecycle.get","bucket":"lyx-stg-secure-1250000000"}
```

只允许 `head`、lifecycle/versioning/encryption/acl/policy 的 `.get`、`.put` 和窄 `artifact.put`。只接受四类 `lyx-stg-{secure,asset,media,pub}-<数字COSappid>` 桶；地域固定 `ap-shanghai`，正式地址固定 `https://<bucket>.cos.ap-shanghai.myqcloud.com/`，没有 endpoint 参数。SDK session 忽略环境代理和 netrc，关闭重定向及自动域名切换。PUT 的 `configuration` 是配置对象：lifecycle `{Rule:[...]}`、versioning `{Status:"Enabled"}`、encryption `{Rule:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:"AES256"}}]}`、ACL `{ACL:"private"}`，policy 为策略对象。pub 的版本 PUT 一律拒绝；没有关版本、删桶、删对象接口。声明外 policy/生命周期、授权、加密配置由上层完整检查后决定是否允许写，不能把这个 SDK 封装当作声明比较器。

owner 未来显式配置凭据文件后，由调用者读取并只给此子进程注入 `LYX_COS_SECRET_ID`、`LYX_COS_SECRET_KEY` 和可选 `LYX_COS_SESSION_TOKEN`。adapter 不读凭据文件、不搜索默认 SDK 配置。`--check` 和非法输入不取凭据。缺省只读；PUT 额外要求 `LYX_COS_APPLY_ENABLED=true`，本次没有启用或使用真实配置。

`artifact.put` 还必须有独立 `LYX_COS_ARTIFACT_UPLOAD_ENABLED=true`，仅 secure 桶；`configuration` 严格为 `{file:<绝对路径>,key:"ci/sha-<12hex>/(weapp.tar.gz|images.json)"}`，文件 basename 必须与 key 一致。它只上传调用者明确给出的制品文件，添加 SSE-COS 头；不下载、不读取密钥、不调用微信 uploader。真实云写与 CI flag 仍默认关闭。

成功 stdout 只有 `{value:...}`；head/PUT 返回 `{}`，policy 被解包为 JSON 对象，其他 GET 保留 SDK 配置 body。空 versioning 的精确 `{VersioningConfiguration:null}` 归一为 `{}`。三类 404 配置缺失只按已知服务错误码归空；NoSuchBucket 非零，不能当缺配置。ACL 返回 `Owner.ID`、`AccessControlList.Grant[]` 的 `Grantee.Type/ID/URI`、`Permission` 和 `CannedACL`；数字 XML GET 值为字符串，生命周期 Transition 与 Rule 为数组。错误只有固定 `COS_*` 代码和非零状态，不输出 SDK 消息、响应头或凭据。

验证加载真实锁定 SDK，使用假凭据连接本机 loopback HTTP，捕获五类 GET/PUT 的 XML/JSON、私有 ACL 头、正确 SSE XML、只读零 PUT、缺桶拒绝和制品字节/key；生产 CLI 不暴露这个 import-only 测试 seam。腾讯默认加密 Python 示例字段与原生 API 有出入，本工具捕获并验证了实际 `Rule/ApplyServerSideEncryptionByDefault/SSEAlgorithm=AES256`。本机通过不代表四桶已经配置或腾讯线上成功；真实 CAM 权限、owner 凭据、桶状态和显式 apply 后读回仍待外部手验。
