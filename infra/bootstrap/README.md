# 预发节点：首次起环境

2026-10-18 当前源码仓库已迁回 [byfire-dev/liyoxi-project](https://github.com/byfire-dev/liyoxi-project)，实际主干 `9ffd93b3125c73e6743a5e33328909dcb690218e` 的 required 已通过，原主干保护已恢复。当前开发入口及保留事项见[迁回状态页](../../docs/plan/repository-return.md)。本次只完成代码迁回，目标仓的 Packages、vars、节点前缀及发布权限尚待核对；mixed-smoke 版本预检失败仍阻断同提交部署。本手册中的旧仓 PR/run、候选 namespace 与配置回执按原日期留档，不代表当前目标仓已配，不因此开始服务器操作。

把业主那台阿里云服务器变成预发的步骤。形态依据 [ADR-041](../../docs/adr/0041-预发先行-单机预发-共用AppID.md)“决定”第 4 节；任务书 `docs/plan/tasks/W2-25.md`。W2-25 已交付脚本、Compose、本机演练、桶核对工具、四镜像与默认关闭的构建发布流程；真实节点配置和外部发布另按下文逐步验收。

## 0. 先看这几句

- **谁来做**：下面每一步都是业主执行，或业主在场逐步确认后由调度会话执行（ADR-041 第 4.10 节）。写密钥文件、给发布公钥只有业主做。会话不读密钥目录，不把服务器上的任何值带回对话。
- **应用部署步骤仍未在服务器上验收**。历史本机演练见第 9 节。2026-10-14 已在用户本轮授权下核验 root SSH 和节点元信息，并新增三个独立 HTTP 站点作为 ACME 验证入口：`nginx -t`、reload 及稳定后的本机 Host 路径响应均通过。首次 reload 后立即请求曾为 404，稳定后复核全部 200，测试文件已清理。应用、systemd 发布链与 TLS 证书尚未启用；本机演练不能替代这些真实验收。
- **不动的东西**：宿主机 nginx 上已有的站点（公司官网、`api.timavia.com`）；参考工程留下的容器、卷与导出文件。脚本遇到它们只报告，不处置。
- 脚本都可以重复执行。每一步后面写了预期输出与回退办法；预期对不上就停，不要往下走。
- 镜像怎么到节点：CI 推到镜像仓库、节点只拉。2026-10-14 已定 GHCR，发布流程适配已独审、定点验证并合本地 main，远端 PR #1 的四镜像构建通过，required 尚被旧 MinIO 拉取权限及旧基线检查失败阻塞；**第 3 步起仍要等镜像首次发布及节点拉取验证**。第 1、2 步（初始化、密钥）可分别准备，不能因资源已提供跳过逐步验收。

| 路径（节点上） | 是什么 |
| --- | --- |
| `/opt/liyoxi/infra/` | 从仓库拷来的 `infra/compose`、`infra/deploy`、`infra/bootstrap`，布局与仓库相同 |
| `/opt/liyoxi/secrets/` | 密钥文件，目录 0700 只有 root 能进，文件 0400。清单在 [secrets.manifest.json](../deploy/secrets.manifest.json) |
| `/opt/liyoxi/node.env` | 这台节点自己的非敏感设置：镜像仓库前缀与可选 Provider 选择/公开标量 |
| `/opt/liyoxi/release.env` | 现在该跑哪个版本。由节点步骤 `up` 写，systemd 重启容器时读 |
| `/opt/liyoxi/static/` | 静态资源的宿主机目录，留给发布编排的预置一步（W2-26），现在是空的 |

## 1. 上服务器之前

照 [checklist.md](checklist.md) 逐项勾完。要点：镜像已发布且节点可拉；补 3、补 4 有结论；三条预发域名的 DNS 已加；发布用的密钥对已生成并正确录入。2026-10-14 三个应用预发域名 A 均无记录，DNS 仍待用户配置。资源、方案与核验依据见 [platform-config.md](../../docs/plan/platform-config.md) 第 2.3、2.5 节；不在文档记录私钥及本地路径。

## 2. 第 1 步：传脚本，节点初始化

```sh
# 本机，在仓库的检出里（main 的最新提交）
git archive --format=tar HEAD infra/compose infra/deploy infra/bootstrap | ssh <登录用户>@<节点> 'mkdir -p ~/lyx-src && tar -x -C ~/lyx-src'
# 节点上：先只看不做
cd ~/lyx-src && sudo bash infra/bootstrap/node-init.sh --dry-run --deploy-key ~/lyx-deploy.pub --registry <镜像仓库前缀，以 / 结尾>
# 看过没问题，去掉 --dry-run 再跑一遍
```

| 看什么 | 预期 |
| --- | --- |
| “核对（只读）”一段 | Docker 与 Compose 的版本；“参考工程没有在跑的容器与进程”；“端口 8080 空闲”；“网段 172.30.41.0/24 不与已有的 Docker 网络、本机网卡相撞” |
| `--dry-run` 的末行 | `--dry-run：核对通过；上面的都没有执行`，上面是一串“会做：…” |
| 正式执行的末行 | `节点初始化完成。…` |
| 输出里“停下：…什么都没有改” | 核对没过，按它说的原因处理后重跑。参考工程在跑、8080 被占：先弄清是谁，不要绕过。网段相撞：改 `infra/compose/env/stg.env` 的 `LYX_NODE_SUBNET` 与 `LYX_TRUSTED_PROXY_CIDRS`（走 PR） |

它做的事：建目录；拷脚本；写 `node.env`；建发布用户 `lyx-deploy`（不设口令）并写它的 `authorized_keys`（一行：只能执行 `node-step.sh`，不给终端，不许转发）与 sudoers（只放行以 root 执行这一个脚本）；装六个 systemd 单元（不启用、不启动）。不拉镜像、不起容器、不写密钥、不碰 nginx。

- `--nginx-oom` 单列：另装一份 systemd 覆盖文件，让内存见底时别先杀宿主机 nginx。这是动别人的服务，业主同意才带；nginx 下次重启后生效，脚本不重启它。撤掉：`sudo rm /etc/systemd/system/nginx.service.d/lyx-oom.conf && sudo systemctl daemon-reload`。
- 误报参考工程的进程（命令行里恰好带参考工程名、又与它无关）：确认之后设 `LYX_REF_NAME=<不会命中的名字>` 重跑，并把这件事记下来。
- 以后脚本有更新：重新传一遍、重跑 `node-init.sh`（不带 `--registry` 时 `node.env` 不动）。
- **回退**（这一步之后还没有密钥与数据）：`sudo userdel -r lyx-deploy; sudo rm -f /etc/sudoers.d/lyx-deploy /etc/systemd/system/lyx-*.service; sudo systemctl daemon-reload; sudo rm -rf /opt/liyoxi`。

## 3. 第 2 步：密钥文件（只有业主做）

```sh
sudo bash /opt/liyoxi/infra/bootstrap/gen-secrets.sh --dry-run   # 说出会生成哪些文件
sudo bash /opt/liyoxi/infra/bootstrap/gen-secrets.sh             # 生成；只打印文件名
sudo /opt/liyoxi/infra/deploy/check-secrets.sh                   # 齐备检查
```

| 看什么 | 预期 |
| --- | --- |
| `gen-secrets.sh` | 九行 `已生成  <文件名>`；重跑时是 `已有，不动  <文件名>` |
| `check-secrets.sh` | `密钥文件齐备：查了 9 个文件`，退出码 0。不合格时逐条 `不合格  <文件名>：<原因>`，不会打印内容 |

`gen-secrets.sh` 生成的是只在这台节点上用、随机就行的九项：库的四个（超级用户口令、迁移账号、应用登录账号、备份登录账号的连接串）、Redis 的两个、三份密钥文件。值取自 `/dev/urandom`，不经任何人的手，也不打印。M3 的 COS、CI、模型与媒体工具配置已提供[可选挂载](../compose/providers/README.md)，默认关闭；选中能力后的额外文件由业主按清单写入，不由生成脚本伪造。

三份密钥文件要是想自己写而不用脚本生成，内容如下（每把密钥是 base64 写的 32 字节：`openssl rand -base64 32`，各把互不相同）：

| 文件 | 对应的变量 | 内容 |
| --- | --- | --- |
| `data-keys.json` | `DATA_KEYS_FILE` | `{"current":"k1","keys":{"k1":"<密钥>"}}`。轮换时加新 kid 并改 `current`，旧的留着 |
| `bidx-keys.json` | `BIDX_KEYS_FILE` | `{"phone":"<密钥>","uscc":"<密钥>"}`。每个用途一把 |
| `auth-keys.json` | `AUTH_KEYS_FILE` | `{"ticket":"<密钥>","device":"<密钥>","mfa":{"current":"k1","keys":{"k1":"<密钥>"}}}` |

自己写入的办法（内容从标准输入给，不进命令行）：`sudo install -m 0400 -o 1000 -g 1000 /dev/stdin /opt/liyoxi/secrets/data-keys.json`，粘贴内容后按 Ctrl-D。属主照清单的 `uid`。

- **这三份离线另存一份**（密码库）：`data-keys.json` 丢了已加密的数据解不开，`bidx-keys.json` 换了旧数据查不到。
- 待核（checklist 第 9 项）：这台服务器的系统盘有没有加密。没加密的话，快照与镜像里带着明文密钥。
- **回退**：库还没起（第 3 步之前）时，删掉重来：`sudo rm -f /opt/liyoxi/secrets/<文件名>` 后重跑生成。库起来之后不要删：换口令照 [运行手册](../../docs/plan/runbook.md) 第 4 节。

## 4. 第 3 步：库与 Redis

```sh
sudo /opt/liyoxi/infra/deploy/node-step.sh deps            # 起库与 Redis 两个容器，等到健康
sudo bash /opt/liyoxi/infra/bootstrap/db-init.sh --dry-run
sudo bash /opt/liyoxi/infra/bootstrap/db-init.sh
```

| 看什么 | 预期 |
| --- | --- |
| `deps` 的末行 | `== 库与 Redis 在跑且健康`。`docker ps` 里多了 `lyx-postgres`、`lyx-redis`，都不发布端口 |
| `db-init.sh` | 第一行说出库名 `liyoxi` 与三个账号；末行 `== 库已初始化：liyoxi（属主 lyx_migrator），扩展 btree_gist、pg_trgm 已装，…` |

- 库与 Redis 的镜像（`infra/compose/env/stg.env` 的 `LYX_PG_IMAGE`、`LYX_REDIS_IMAGE`）现在写的是与本地相同版本、按摘要固定的官方镜像名。境内节点能不能直接拉，没有核实；第二步把它们按摘要转存到镜像仓库后改这两行。
- `db-init.sh` 做什么见它开头的注释：两个不可登录的角色、三个只能登录的账号（口令取自连接串文件）、成员关系、库、两个扩展。口令不进命令行、不打印。
- 同机留着参考工程已停的库与 Redis 容器：认准容器名 `lyx-postgres`、`lyx-redis`，别的不要碰。
- **回退**（只在库里还没有东西时）：`sudo systemctl disable --now lyx-postgres lyx-redis; sudo docker rm -f lyx-postgres lyx-redis; sudo docker volume rm lyx-node-pgdata lyx-node-redisdata`。数据卷删了库就没了。

## 5. 第 4 步：逐步发布

```sh
TAG=sha-<12 位提交号>          # images.yml 推上去的那个标签
S=/opt/liyoxi/infra/deploy/node-step.sh
sudo $S pull $TAG && sudo $S check-env $TAG && sudo $S stage-assets $TAG && sudo $S migrate $TAG && sudo $S seed $TAG && sudo $S up $TAG && sudo $S status
sudo $S verify-db $TAG
```

首次建议一步一步跑，看过预期再跑下一步：

| 步骤 | 预期的末行 | 没过怎么办 |
| --- | --- | --- |
| `pull` | `== 镜像已拉取：标签 …` | 线上没有动。查镜像仓库的登录（`docker login` 由业主在节点上做一次）与 `node.env` 的前缀 |
| `check-env` | `== 环境变量自检通过` | 线上没有动。上面逐条是“键名: 原因”，不带值：照它补密钥文件 |
| `stage-assets` | `== 静态资源已预置且没有覆盖：…` | 线上进程没换。gateway 的 assets 是宿主机只读挂载，首次 up 前也须预置；提取、同名内容冲突或清场失败时不要迁移 |
| `migrate` | `== 迁移完成` | 正在跑的容器没有动。首次失败（库是空的）可以照第 3 步的回退删卷重来 |
| `seed` | `播种完成：新增 N 行`、`断言：0 条违规`、`== 播种完成，断言 0 违规`；再跑一遍 N 是 0 | 退出码 1 = 配置类断言有违规（上面逐条 `违规 <编号> …`），**不要往下起容器**，把那几行回传；2 = 环境不对或连不上库 |
| `up` | `== 六个容器都在跑且健康：标签 …` | `sudo $S status` 看是哪个，`sudo docker logs --tail 50 lyx-<名字>` 看原因 |
| `status` | 六行容器都是 `running`，后面三行探活与 `worker 持有租约`，末行 `== status：…探活通过` | 同上 |
| `verify-db` | `结论：通过。…` 与 `库的核对：通过` | 把整段输出回传 |

- `up` 把标签写进 `release.env`，并启用六个 systemd 单元：此后开机自启、进程退出自动拉起。
- `/health` 在探针循环落地（M2）之前回 503，`status` 不看它的状态码，只看里面 worker 一项。
- **回退**：停掉应用容器 `sudo systemctl stop lyx-gateway lyx-api lyx-worker lyx-mediatool`（库与 Redis 留着）。退回上一个版本：`sudo $S up <上一个标签>`（迁移只做扩展，旧代码照常跑）。完整的发布与回滚编排在 W2-26。

## 6. 第 5 步：证书与宿主机 nginx 的三个站点

**重载 nginx 会波及公司官网与 `api.timavia.com`：每次重载前先 `nginx -t`，并先经业主确认。** 脚本只把站点文件渲染到你指定的目录，不碰 `/etc/nginx`。

```sh
R=/opt/liyoxi/infra/deploy/nginx/render.sh
# ① 证书还没有：先只装 80 端口的那一段（证书验证目录加跳转）
bash $R --out ~/lyx-sites --http-only
sudo cp ~/lyx-sites/lyx-stg-*.conf /etc/nginx/conf.d/ && sudo nginx -t      # 通过后，经确认再 sudo systemctl reload nginx
# ② 签三张证书（办法见 checklist 第 6 项），放到 /etc/nginx/lyx-tls/<域名>/fullchain.pem 与 privkey.pem
# ③ 渲染完整的站点，换上
bash $R --out ~/lyx-sites
sudo cp ~/lyx-sites/lyx-stg-*.conf /etc/nginx/conf.d/ && sudo nginx -t      # 通过后，经确认再 sudo systemctl reload nginx
```

| 看什么 | 预期 |
| --- | --- |
| `render.sh` | 三行 `已渲染  lyx-stg-{api,admin,portal}.conf（<域名> → 127.0.0.1:8080）` |
| `nginx -t` | `syntax is ok`、`test is successful`。不通过就把刚拷进去的三个文件删掉，不要重载 |
| 重载之后 | 公司官网与 `api.timavia.com` 照常；`curl -sS -o /dev/null -w '%{http_code}\n' https://api.stg.liyoxi.timavia.com/healthz` 回 200 |

- 站点文件放哪个目录以宿主机 nginx 实际 `include` 的为准（`sudo nginx -T | grep include`），上面写的 `/etc/nginx/conf.d/` 是常见的位置。只新增这三个文件，不改已有的。
- 用 DNS 验证签证书的话不需要 ①，直接从 ② 开始。证书目录与验证目录可以换：`--tls-dir`、`--acme-root`。
- 这一层只终止 TLS、原样透传 `Host`、覆盖写 `X-Forwarded-For`；不加任何响应头。没有开 HTTP/2、没有发 HSTS：宿主机 nginx 的版本没有核对，HSTS 发错了难撤，等预发稳定后再定。
- **回退**：`sudo rm /etc/nginx/conf.d/lyx-stg-*.conf && sudo nginx -t`，通过后经确认重载。

## 7. 第 6 步：验收

| # | 做什么 | 判据 | 记到哪 |
| --- | --- | --- | --- |
| 1 | 从公网：`curl -sS -o /dev/null -w '%{http_code}\n' https://<三个域名>/healthz`（后台、下载页看 `/`） | 都是 200 | — |
| 2 | 密钥不出现在容器信息里：`sudo sh -c 'docker inspect lyx-postgres lyx-redis lyx-mediatool lyx-api lyx-worker lyx-gateway >/tmp/lyx-inspect.json; grep -ohE "[A-Za-z0-9+/=_-]{24,}" /opt/liyoxi/secrets/* \| grep -cFf - /tmp/lyx-inspect.json; rm -f /tmp/lyx-inspect.json'` | 打印 `0` | 外部验证 `d7-17-node-process-secrets.md` |
| 3 | 进程自退与被杀：`sudo docker kill lyx-api`，等十秒，`sudo $S status` | 自己起来了，status 通过 | 同上 |
| 4 | 整机重启（会波及公司官网，时间由业主定）：重启后 `sudo $S status` | 六个容器按顺序自己起来，status 通过 | 同上 |
| 5 | 真实客户端 IP：从公网带一个随机请求编号请求一次，`curl -H 'X-Request-Id: <现造的 UUID>' https://api.stg.liyoxi.timavia.com/healthz`；节点上 `sudo docker logs --since 5m lyx-gateway \| grep <那个 UUID>` | 那一行的 `remote_addr` 是请求方的公网 IP，不是 `172.30.41.x` | 外部验证 `v06-lb-source-address.md`；平台配置核对表 第 2.5 节实测值第 4 项 |

第 5 项对不上（记下的是网桥地址）说明宿主机 nginx 进容器的来源地址不在 `LYX_TRUSTED_PROXY_CIDRS` 里：把记下的那个地址写进 `infra/compose/env/stg.env`（走 PR），重新发布 gateway 后再验。限流、白名单、审计里的 IP 都靠它。

## 8. 整个撤掉

```sh
sudo systemctl disable --now lyx-gateway lyx-api lyx-worker lyx-mediatool lyx-redis lyx-postgres
sudo docker rm -f lyx-gateway lyx-api lyx-worker lyx-mediatool lyx-redis lyx-postgres; sudo docker network rm lyx-node
sudo rm /etc/nginx/conf.d/lyx-stg-*.conf && sudo nginx -t      # 通过后经确认重载
# 到这里数据还在（三个卷 lyx-node-pgdata、lyx-node-redisdata、lyx-node-work 与 /opt/liyoxi）。下面两行删数据，不可逆，先问业主：
# sudo docker volume rm lyx-node-pgdata lyx-node-redisdata lyx-node-work
# 再照第 2 节的回退删用户、单元与 /opt/liyoxi
```

## 9. 本机演练

```sh
pnpm stack:build     # 出三个本地镜像；库与 Redis 的固定摘要镜像本机也要备好（见 stg.env，两项分别 docker pull）
pnpm stg:rehearse    # 约两三分钟；pnpm stg:rehearse --keep 演练完不清场
```

照节点上的原样走一遍：用 `gen-secrets.sh` 现造假密钥（在系统临时目录里）→ `check-secrets.sh` → `deps` → `db-init.sh` → `pull`（本地镜像，跳过）→ `check-env` → `migrate` → `seed` 两遍（第二遍新增 0 行）→ 造一条配置类违规再 `seed`（要以 1 退出）→ `up` → `status` → `verify-db`；再读 `docker inspect` 核对六个容器的形态（内存上限对着 ADR-041 第 4.2 节的表、只有 gateway 发布端口且只绑回环、固定网段、重启策略、日志轮转、密钥按清单分挂、搜不到任何密钥的值）、Redis 的三项设置、经 gateway 的冒烟、真实客户端地址、宿主机 nginx 的三个站点渲染后 `nginx -t`。跑完删掉自己的容器、网络、卷与临时目录。

与节点上不同的只有：项目名与容器名前缀每次随机（`lyxrh-<6 位>`），网段从 `172.30.42.0/24` 起找一段不相撞的，gateway 的端口现找；容器由 Compose 直接管（节点上是 systemd）；不与共享的本地依赖、`pnpm stack:up` 的那一套相撞，也不停它们。CI 在 `stack-smoke` 工作流里跑它（不是必过检查）；Linux 上密钥文件的属主照清单改，本机的 macOS 上改不了也不看。

## 10. 已知的限度

- `/work` 共享目录的 8GB 上限（ADR-041 第 4.2 节）没有做：本地卷不支持按卷限额，要文件系统配额或单独的分区。mediatool 的调用端接上之前（G3-A）它是空的。
- 节点上只保留最近 3 个版本的镜像、静态资源预置到 `static/`、worker 与 api 分开换、回滚：发布编排（W2-26）。现在的 `up` 是把四个应用容器依次重启，有短暂中断。
- 备份登录账号建好了，连接串文件还没有挂给任何容器：等每日备份的包接进 `loadEnv`。
- 内存上限是 ADR-041 的起始值，没有在这台机器上实测；调的时候改 `infra/compose/node.yml`，并同步 ADR 那张表（演练拿两边比）。
- systemd 单元在真机上的三种情形（开机、自退、被杀）要到第 7 节第 3、4 项才算验过。


## 11. 恢复来源与借用清单

本轮从实际 main `1009540ef9bc51fd0e8dd686048256044730b576` 开工，依赖 W1-22、W0-06a、W0-21 均已完成。恢复来源是原 Claude 只读工作树的正常提交 `f395e130336b96c178e31a6eab5c29e1a7ecd483`（五次 a 提交最终头）；原树保持原样，没有直接 cherry-pick，也没有恢复原状态文件里误称“已合并”或旧 Linux 演练的结论。

下列文件逐项借用原 a 的节点代码或最小追加；已有文件保留实际 main 的其他内容。恢复后补了 bash 中文标点旁变量花括号、PG/Redis 同版本摘要固定、清场失败非 0、未知服务名拒绝和 seed 失败阻断串行后续的回归。这些都在本轮独立本机验收；没有借用 b 或未合业务实现。

- `infra/bootstrap/README.md`
- `infra/bootstrap/checklist.md`
- `infra/bootstrap/db-init.sh`
- `infra/bootstrap/gen-secrets.sh`
- `infra/bootstrap/node-init.sh`
- `infra/ci/test/stg-node.test.ts`
- `infra/compose/env/stg.env`
- `infra/compose/node.yml`
- `infra/deploy/check-secrets.sh`
- `infra/deploy/lib.sh`
- `infra/deploy/nginx/render.sh`
- `infra/deploy/nginx/site.conf.template`
- `infra/deploy/node-step.sh`
- `infra/deploy/rehearse.mjs`
- `infra/deploy/secrets.manifest.json`
- `infra/deploy/systemd/lyx-api.service`
- `infra/deploy/systemd/lyx-gateway.service`
- `infra/deploy/systemd/lyx-mediatool.service`
- `infra/deploy/systemd/lyx-postgres.service`
- `infra/deploy/systemd/lyx-redis.service`
- `infra/deploy/systemd/lyx-worker.service`
- `infra/deploy/systemd/nginx-oom.conf`
- `infra/deploy/verify-db.mjs`
- `.github/workflows/stack-smoke.yml`
- `infra/ci/README.md`
- `infra/ci/test/workflows.test.ts`
- `infra/docker/server/Dockerfile`
- `infra/docker/server/Dockerfile.dockerignore`
- `docs/plan/runbook.md`
- `docs/plan/platform-config.md`
- `docs/plan/external-verification/d7-17-node-process-secrets.md`
- `docs/plan/external-verification/d7-18-node-bucket-rebuild.md`
- `docs/plan/external-verification/v06-lb-source-address.md`
- `CLAUDE.md`
- `package.json`


另新增本包允许的 `docs/plan/external-verification/d7-14-stg-appid-domain-privacy.md` 说明行；本包状态按当前实际进度重写。两个固定摘要取自 Docker 官方同版本的多架构 OCI index（同时含 Linux amd64 与 arm64），由只读 registry manifest 核对；本机 RepoDigest 曾指向 arm64 单平台，已按 Linux CI 实证修正；不改变共享 `infra/compose/local.yml`。nginx 配置检查复用仓内 gateway 的固定摘要 nginx:stable-alpine，没有声称在服务器上重载。

## 12. b：四桶核对与构建发布流水线

a 已经 PR #94 实际合入；b 已交桶声明/比较工具、独立上传器、四镜像与默认关闭的流水线。2026-10-14 用户截图确认 `lyx-{dev,stg}-{asset,media,pub,secure}-1257198915` 八桶存在，同日业主确认预发 `asset/media/pub` 三桶在上海（`ap-shanghai`），数据万象服务开通、三桶绑定及预发 `media` 媒体处理开启。依据为业主回传，会话未做云端复验；开发四桶及预发 `secure` 的地域、开发桶开通、策略、CAM、CORS、运行凭据与真实接口仍待核；节点 SSH 与 HTTP 签发验证入口的核验范围见第 0 节。以下云配置、镜像发布与应用部署仍待逐步验收。

`pnpm stg:buckets -- --check --offline` 只读内置空配置夹具，列四桶差异并退出 1；`--fixture <公开JSON文件>` 可替换完整四桶现状，**offline 不读凭据、不执行 adapter**。退出 0 表示与声明一致，1 表示差异/人工阻断，2 表示参数/响应/Provider 错误；`--offline --apply` 拒绝。生命周期只管 D5 的纯时间规则，不能替代业务引用清理。secure `ci/` 为七天，pub 没有写入区。

线上核对先按 [cos-adapter/README.md](cos-adapter/README.md) 建独立固定 Python/SDK 环境，再由业主显式设置 `LYX_COS_ADAPTER=<本仓cos-adapter/run.sh绝对路径>`、`LYX_COS_PYTHON=<独立venv/bin/python绝对路径>`、`LYX_COS_CREDENTIAL_FILE=<业主0600 JSON文件>`。该文件只含 `secretId`、`secretKey` 与可选 `sessionToken`，不入库，不在命令行放密钥值。然后用 `--check --appid <腾讯COS数字APPID>`；此 APPID 是桶账号后缀，与 wx 开头的小程序 AppID 不同。线上地域和 HTTPS 默认域名固定上海。

只有业主明确设置 `LYX_COS_APPLY_ENABLED=true` 并给 `--apply` 才允许窄 PUT；写前完整读四桶，未知策略/ACL/生命周期/加密、缺桶或不认识的输出均停止，不能删除外部规则。pub 的 Enabled/Suspended 不能被改成“从未开启”。可管理差异依次写私有 ACL、版本/SSE 与完整生命周期，再逐项 GET 读回；失败不报告成功，不删除对象或桶。COSCLI 未证实生命周期命令，AWS 逐操作兼容也无腾讯保证，因此使用官方 SDK 的原生方法，未编造 CLI。

2026-10-14 业主定用本项目 GHCR，取代此前阿里云镜像仓库建议。当时源码仓库为 `https://github.com/sanqianyuejia/liyoxi-project`；当时候选四镜像为 `ghcr.io/sanqianyuejia/liyoxi/{server,gateway,mediatool,weapp-uploader}`，节点前缀候选 `ghcr.io/sanqianyuejia/`。尚未首次发布，公开源码仓库不代表 GHCR 包公开，CI 推送/节点拉取权限与连通性另验。

2026-10-14 旧仓执行记录（留档）：GHCR 三叶已完成唯一独审修正，镜像/摘要定点 24 项与工作流检查 82 项通过，本地 main 已合 `af73fdc2`、`091da64d`。远端仅移植这三叶到旧 main 并开 [PR #1](https://github.com/sanqianyuejia/liyoxi-project/pull/1)（head `a5dc447d`），Actions 已实际运行；四镜像构建已通过；原 CI 拉取 `ghcr.io/byfire-dev/minio:latest` 被 denied，另有旧 infra 三项断言失败及历史密钥扫描 23 项测试夹具误报（已只读核对，规则未修），`required` 未通过。新仓库缺少的 `gate-touch` 标签已补，单 job 重跑已通过；旧 MinIO 公开恢复或迁移本机镜像的处理待用户答复。该 PR 不是本地完整 main 的远端同步；首次四镜像发布未发生，不能以本地检查通过代替远端 required 或实际发布。 [四镜像构建运行](https://github.com/sanqianyuejia/liyoxi-project/actions/runs/38571462602)成功；[CI 运行](https://github.com/sanqianyuejia/liyoxi-project/actions/runs/38571463088)的 verify、web、gate-classify 通过，旧基线失败仍保留。infra 三项分别为留桩状态、CHECK 约束计数和分区快照断言，均不在本 PR 三文件中；不跳过这些检查合并发布。 历史扫描 23 项均属 `generic-api-key`，只读核对为 ASR 配置/回调/发送测试和 W216 临时员工登录夹具四组，未发现真实云或生产凭据迹象；修正须精确限定夹具，不能豁免整个历史提交或关闭扫描。

2026-10-14 旧仓公开 vars 历史登记：`STG_REGISTRY=ghcr.io`、`STG_REGISTRY_NAMESPACE=sanqianyuejia/liyoxi`、`STG_WEAPP_APPID=wx66a51228082e82d4`、`STG_WEAPP_API_BASE_URL=https://api.stg.liyoxi.timavia.com`；`STG_IMAGES_PUBLISH_ENABLED` 尚未开启。这些旧仓登记不证明当前目标仓或节点已配；目标仓公开 vars 与 encrypted secrets 仍按下表逐项核对，不填入未经确认的新 namespace。缺省镜像发布、制品写入、部署与体验版上传四个外部开关都关闭，未配置而开启则失败，不以跳过步骤冒充发布成功：

| 类别 | 配置 |
| --- | --- |
| 开关 | `STG_IMAGES_PUBLISH_ENABLED`、`STG_ARTIFACT_UPLOAD_ENABLED`、`STG_DEPLOY_ENABLED`、`STG_WEAPP_UPLOAD_ENABLED`；冻结仍为 `STG_FREEZE` |
| 镜像仓库 | vars `STG_REGISTRY`（域名/可选端口）、`STG_REGISTRY_NAMESPACE`（不带末尾 /）；secrets `STG_REGISTRY_USERNAME`、`STG_REGISTRY_PASSWORD` |
| 小程序构建 | vars `STG_WEAPP_APPID`、`STG_WEAPP_API_BASE_URL`，开启推送前必须配置真实公开值；PR 缺省只编译占位，不上传 |
| secure 制品 | vars `STG_COS_APPID`；secrets `STG_COS_SECRET_ID`、`STG_COS_SECRET_KEY`，仅显式 `ci/sha-<12HEAD>/{weapp.tar.gz,images.json}`，上传另加 SSE-COS |
| 受限 SSH | vars `STG_SSH_USER`、`STG_SSH_HOST`；secrets `STG_SSH_PRIVATE_KEY`、`STG_SSH_KNOWN_HOSTS`。known_hosts 由业主核主机指纹后录入，不现场 ssh-keyscan；临时文件0600、always清理 |

PR 四镜像只 build，以 `sha-<12HEAD>` 绑定同一源码，小程序原 1500/800KB 预算不变。成功构建产物在 GitHub 保留七天；发布 job 从自己的 run 取产物，校验源码/公开构建配置/制品哈希后推四镜像，并记录远端摘要。`mirror_base` 只手动、main 且推送开关已启用才转存 PG17/Redis7 的固定多架构清单，不用单平台 pull/tag/push。部署只消费同仓 main 成功 push 的同 run 摘要，受限节点预拉后比对三个常驻应用镜像摘要，再调用 actual W2-26a 编排；W2-26b2a 已交私有同源制品消费者，b2b 独立 gate-change 已接工作流代码（开关仍关闭）：成功部署（含 verify-db）后串行消费，部署/探测/上传摘要统一保留。上传还有节点 LYX_WEAPP_UPLOAD_ENABLED 独立默认关闭；固定 reader venv、两份 COS 凭据文件及唯一微信密钥只读挂载见 cos-adapter/README.md。节点当前成功部署必须匹配本次 source，不能复用另一版。手动 rollback-stg 与发布同 concurrency，只在 main、STG_DEPLOY_ENABLED=true、execute=true 时执行，冻结与原安全拒绝保持。STG_PROBE_CONFIG 为公开的探测目标 JSON。

`images.json` 四个镜像各记录 `registryDigest`、`amd64ManifestDigest`、`amd64ConfigDigest`。发布工具按摘要固定查询原始 index/manifest、校验字节 SHA256，且只接受唯一 linux/amd64 平台与其 config；节点实际 a 的 `.Id` 必须匹配同一镜像这三个明确事实之一，兼容 classic 的 config ID 与 containerd 的 index ID。缺字段、坏摘要、未知镜像或重复节点行均在编排前停止，不能只按 tag 放行。输出形状与原字节依据 [Docker Buildx 文档](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/)及[官方 raw 输出实现](https://github.com/docker/buildx/blob/master/util/imagetools/printers.go)，本机仅用真实 Node 与 fake Docker/SSH 核验，无 registry 推送或节点部署。

本机证据仅证明脚本/真实 SDK 请求格式与四镜像能构建。2026-10-14 已有八桶存在截图、真实节点 SSH 及 HTTP ACME 入口核验；真实 registry/CAM 权限、桶地域与配置、CDN 授权、证书签发、节点应用发布及微信上传仍未验。发布开关尚未开启，没有服务器应用交付成功结论。
