#!/usr/bin/env bash
# 狸有戏 · 预发节点步骤（ADR-041“决定”第 4.7 节；D7 第 8.2 节）。W2-25 交基础的几步，发布编排用的由 W2-26 接着补。
# 每一步都可以重跑。节点上以 root 执行；发布用户经受限 SSH 进来时只能执行本脚本（见文末“经 SSH”）。
#
# 用法：node-step.sh <步骤> [参数]
#   deps               起库与 Redis 两个容器，等到健康（首次起环境时排在 db-init.sh 之前；已经起着就什么都不做）
#   pull <标签>        拉这个版本的镜像。没配镜像仓库前缀（LYX_IMAGE_PREFIX 为空）时是本地镜像：只核对镜像在，不拉
#   check-env <标签>   密钥文件齐备检查 → 用这个版本的镜像跑环境变量自检（不连库）
#   migrate <标签>     一次性容器跑 prisma migrate deploy（迁移账号）
#   seed <标签>        一次性容器播种（应用登录账号）：没有才插；播完跑六条配置类断言，有违规即以 1 退出
#   up <标签>          记下“现在跑这个版本”，起（换）六个容器，等到都在跑且健康
#   status             六个容器的状态与版本、经 gateway 的探活、worker 是否持有租约；有一项不对即非 0
#   verify-db <标签>   库的核对：库名、两个扩展、应用连库用的是登录账号而不是属主、角色与授权、约束清单和分区
#   stage-assets <标签> 不覆盖地预置两个前端的资源；worker-swap <标签> 停旧再换 worker 与 mediatool
#   api-stop / api-start <标签> 停 api/gateway，再换新并等 readyz 连续三次 200
#   verify-assets <标签> 完整镜像资源与共享目录核对；verify-assets-live <标签> [旧标签] 实际网关全资源核对
#   smoke <标签>      API 探活、两个前端入口、实际版本与 worker；完整资源由 verify-assets-live 核对
#   prune             只清本项目记录过的旧版本，留当前与最近三版；资源至少保留 60 天
#   logs <六服务> <UUID> 只读最近60分钟的匹配日志（最多200行）；log-stats <1–1440分钟> 统计gateway
#   facts / preflight 只读版本、发布历史与 P1（告警包未接时明确 unavailable）
#   image-facts <标签> 只核目标三类本地镜像；record <标签> <base64url JSON> 严格校验后追加记录
#   weapp-upload <40hex源码> <64hex摘要> 只读同源制品、复核成功部署，再用机器人1上传；未启用或未配桶时跳过
#   weapp-review-upload <40hex源码> <64hex摘要> <weapp-vX.Y.Z> 冻结后仅用机器人2上传同源提审包
#   redis-flush <项目>  显式演练开关开启且未冻结时，只清本 node.yml 项目 Redis 的 DB 0
#  下面三个给 systemd 单元用（infra/deploy/systemd/），不经 SSH：
#   run <服务>         前台起一个服务（docker compose up --no-deps），容器退出即返回
#   stop <服务>        停一个服务（按 Compose 里的 stop_grace_period 等它收尾）
#   wait <服务>...     等这些服务的容器在跑且健康，最多 90 秒
# 发布的顺序：pull → check-env → migrate → seed → up → status（→ verify-db）。前一步非 0 就不要往下跑。
# 标签是镜像标签（sha-<12 位提交号>）。up 之前的几步用参数给的标签起一次性容器，不动正在跑的；
# 只有 up 把它写进 $LYX_NODE_HOME/release.env，systemd 重启容器时读的就是这个文件。
#
# 环境变量（都可以不设，见 lib.sh）：LYX_NODE_HOME、LYX_SECRETS_DIR、LYX_NODE_PREFIX、LYX_NODE_PROJECT；另有
#   LYX_NODE_SUPERVISOR  谁管容器的生命周期：systemd（缺省，节点上）或 compose（本机演练：直接 docker compose up -d）
#   LYX_IMAGE_PREFIX     镜像仓库前缀（以 / 结尾），缺省取 $LYX_NODE_HOME/node.env 里的；空 = 本地镜像
# 非敏感配置读 infra/compose/env/stg.env；同名的环境变量优先（演练用它换端口、网段、域名）。
# 经 SSH：发布用户的 authorized_keys 里写 command="<本脚本>"，步骤与参数取自 SSH_ORIGINAL_COMMAND，按空白切开、
#   逐个核对（步骤在上面第一组之内，标签只许字母、数字、点、下划线、连字符），不经 shell 解释；
#   然后经 sudo 以 root 重新执行本脚本（sudoers 只放行这一个脚本，节点初始化时写好）。
# 退出码：0 成功；1 这一步没成（seed 是它自己的退出码：1 有违规，2 环境不对或连不上库）；2 用法或环境不对。
set -u
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/lib.sh"

SELF="$LYX_SRC/infra/deploy/node-step.sh"
STG_ENV="$LYX_SRC/infra/compose/env/stg.env"
NODE_ENV="$LYX_NODE_HOME/node.env"
RELEASE_ENV="$LYX_NODE_HOME/release.env"
DB_RELEASE_ENV="$LYX_NODE_HOME/db-release.env"
COMPOSE_FILE="$LYX_SRC/infra/compose/node.yml"
SUPERVISOR="${LYX_NODE_SUPERVISOR:-systemd}"
SERVICES="postgres redis mediatool api worker gateway"
PUBLIC_STEPS="deps pull check-env migrate seed up status verify-db stage-assets worker-swap api-stop api-start smoke prune preflight facts image-facts record verify-assets verify-assets-live weapp-upload logs log-stats redis-flush"
PUBLIC_STEPS="$PUBLIC_STEPS weapp-review-upload"
USAGE="用法：node-step.sh deps | pull <标签> | check-env <标签> | migrate <标签> | seed <标签> | up <标签> | status | verify-db <标签> | stage-assets <标签> | worker-swap <标签> | api-stop | api-start <标签> | smoke <标签> | prune | facts | preflight | image-facts <标签> | record <标签> <base64url JSON> | verify-assets <标签> | verify-assets-live <标签> [旧标签] | logs <六服务> <UUID> | log-stats <1–1440分钟>"

USAGE="$USAGE | redis-flush <本节点项目>"
USAGE="$USAGE | weapp-review-upload <源码SHA> <摘要SHA256> <weapp-vX.Y.Z>"
via_ssh=0
if [ $# -eq 0 ] && [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  via_ssh=1
  read -r -a argv <<<"$SSH_ORIGINAL_COMMAND"
  set -- ${argv[@]+"${argv[@]}"}
fi
[ $# -ge 1 ] || usage_die "$USAGE"
step="$1"
shift

in_list() { case " $2 " in *" $1 "*) return 0 ;; esac; return 1; }
need_tag() {
  [ $# -eq 1 ] || usage_die "$step 后面要跟一个镜像标签。$USAGE"
  [[ "$1" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || usage_die "镜像标签只许字母、数字、点、下划线、连字符"
}
need_services() {
  [ $# -ge 1 ] || usage_die "$step 后面要跟服务名：$SERVICES"
  for one in "$@"; do in_list "$one" "$SERVICES" || usage_die "不认识的服务 ${one}。服务有：$SERVICES"; done
}
case "$step" in
  redis-flush)
    [ $# -eq 1 ] && [[ "$1" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || usage_die "redis-flush 必须明确给出本节点 Compose 项目名"
    ;;
  logs)
    [ $# -eq 2 ] || usage_die "logs 只接受服务名与 UUID 请求编号"
    need_services "$1"
    [[ "$2" =~ ^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$ ]] || usage_die "请求编号必须是 UUID"
    ;;
  log-stats)
    { [ $# -eq 1 ] || { [ $# -eq 3 ] && [ "$2" = --by-env-version ] && [[ "$3" =~ ^sha-[a-f0-9]{12}$ ]]; }; } &&
      [[ "$1" =~ ^[1-9][0-9]{0,3}$ ]] && [ "$1" -le 1440 ] || usage_die "log-stats 只接受1–1440分钟及可选 --by-env-version <sha-12>"
    ;;
  weapp-upload)
    [ $# -eq 2 ] && [[ "$1" =~ ^[a-f0-9]{40}$ ]] && [[ "$2" =~ ^[a-f0-9]{64}$ ]] || usage_die "weapp-upload 只接受源码 SHA 与摘要 SHA256"
    ;;
  weapp-review-upload)
    [ $# -eq 3 ] && [[ "$1" =~ ^[a-f0-9]{40}$ ]] && [[ "$2" =~ ^[a-f0-9]{64}$ ]] &&
      [[ "$3" =~ ^weapp-v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$ ]] || usage_die "提审上传只接受源码、摘要与合法版本标签"
    ;;
  deps | status | api-stop | prune | preflight | facts) [ $# -eq 0 ] || usage_die "$step 不带参数。$USAGE" ;;
  pull | check-env | migrate | seed | up | verify-db | stage-assets | worker-swap | api-start | smoke | image-facts | verify-assets) need_tag "$@" ;;
  verify-assets-live)
    [ $# -ge 1 ] && [ $# -le 2 ] || usage_die "verify-assets-live 需要目标与可选旧标签"
    for tag in "$@"; do need_tag "$tag"; done
    ;;
  record)
    [ $# -eq 2 ] || usage_die "record 后面是标签与 base64url JSON"
    need_tag "$1"
    [[ "$2" =~ ^[A-Za-z0-9_-]+$ ]] && [ "${#2}" -le 21846 ] || usage_die "record 编码或长度不合法"
    ;;
  run | stop)
    need_services "$@"
    [ $# -eq 1 ] || usage_die "$step 只跟一个服务名"
    ;;
  wait) need_services "$@" ;;
  *) usage_die "不认识的步骤 ${step}。$USAGE" ;;
esac
if [ "$via_ssh" = 1 ]; then
  in_list "$step" "$PUBLIC_STEPS" || usage_die "经 SSH 只能跑：$PUBLIC_STEPS"
  if [ "$(id -u)" != 0 ]; then exec sudo -n -- "$SELF" "$step" "$@"; fi
fi
case "$SUPERVISOR" in systemd | compose) ;; *) usage_die "LYX_NODE_SUPERVISOR 只能是 systemd 或 compose" ;; esac
[ -r "$STG_ENV" ] || usage_die "读不了 infra/compose/env/stg.env"
NODE_PROVIDERS="$(node_providers)" || exit $?

# 取一项非敏感配置：环境变量优先，其次节点上的 node.env，再次 stg.env
setting() {
  local key="$1" file
  if [ -n "${!key+x}" ]; then
    printf '%s' "${!key}"
    return
  fi
  for file in "$NODE_ENV" "$STG_ENV"; do
    if [ -r "$file" ] && grep -q "^$key=" "$file"; then
      sed -n "s/^$key=//p" "$file" | head -n 1 | tr -d '\n'
      return
    fi
  done
}
current_tag() { if [ -r "$RELEASE_ENV" ]; then sed -n 's/^LYX_TAG=//p' "$RELEASE_ENV" | head -n 1; fi; }
db_tag() {
  local line
  if [ -e "$DB_RELEASE_ENV" ] || [ -L "$DB_RELEASE_ENV" ]; then
    [ -f "$DB_RELEASE_ENV" ] && [ ! -L "$DB_RELEASE_ENV" ] && [ -r "$DB_RELEASE_ENV" ] || die "读不了库迁移版本"
    [ "$(wc -c <"$DB_RELEASE_ENV")" -le 141 ] || die "库迁移版本记录过长"
    line="$(cat "$DB_RELEASE_ENV")" || die "读不了库迁移版本"
    [[ "$line" =~ ^LYX_DB_TAG=([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$ ]] || die "库迁移版本记录不合法"
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}
container() { printf '%s-%s' "$LYX_NODE_PREFIX" "$1"; }

# docker compose 的公共参数，放进 COMPOSE_ARGS：变量替换的来源是 stg.env、节点上的 node.env（有才带）与当前环境
COMPOSE_ARGS=()
compose_args() {
  local provider
  COMPOSE_ARGS=(compose -p "$LYX_NODE_PROJECT" --env-file "$STG_ENV")
  if [ -f "$NODE_ENV" ]; then COMPOSE_ARGS+=(--env-file "$NODE_ENV"); fi
  COMPOSE_ARGS+=(-f "$COMPOSE_FILE")
  for provider in $NODE_PROVIDERS; do
    COMPOSE_ARGS+=(-f "$LYX_SRC/infra/compose/providers/$provider.yml")
  done
}
# compose <标签> <参数…>
compose() {
  local tag="$1"
  shift
  compose_args
  LYX_TAG="$tag" docker "${COMPOSE_ARGS[@]}" "$@"
}
# 一次性容器：不带依赖、不要终端，跑完即删
one_off() {
  local tag="$1" service="$2"
  compose "$tag" run --rm --no-deps -T "$service"
}

# 等容器在跑且健康（没有健康检查的只看在跑）：wait_healthy <秒数> <服务…>
wait_healthy() {
  local limit="$1" waited=0 one state pending
  shift
  while :; do
    pending=""
    for one in "$@"; do
      state="$(docker inspect --type container -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$(container "$one")" 2>/dev/null)"
      case "$state" in "running healthy" | "running none") ;; *) pending="$pending ${one}（${state:-没有这个容器}）" ;; esac
    done
    [ -z "$pending" ] && return 0
    if [ "$waited" -ge "$limit" ]; then
      printf '等了 %s 秒还没好：%s\n' "$limit" "$pending" >&2
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
}

step_deps() {
  local tag
  tag="$(current_tag)"
  if [ "$SUPERVISOR" = systemd ]; then
    systemctl enable --now lyx-postgres.service lyx-redis.service || die "库与 Redis 的单元没起成：systemctl status lyx-postgres lyx-redis"
  else
    compose "${tag:-none}" up -d --no-deps postgres redis || die "库与 Redis 没起成"
  fi
  wait_healthy 90 postgres redis || die "库或 Redis 没有健康"
  say "库与 Redis 在跑且健康"
}

step_pull() {
  local tag="$1" prefix image
  prefix="$(setting LYX_IMAGE_PREFIX)"
  if [ -z "$prefix" ]; then
    for image in liyoxi/server liyoxi/gateway liyoxi/mediatool; do
      docker image inspect "$image:$tag" >/dev/null 2>&1 || die "没配镜像仓库前缀，本地又没有镜像 $image:$tag"
    done
    say "没配镜像仓库前缀：用本地镜像（标签 ${tag}），跳过拉取"
    return
  fi
  compose "$tag" pull || die "镜像没拉成（标签 ${tag}）：线上没有动"
  say "镜像已拉取：标签 $tag"
}

step_check_env() {
  "$LYX_SRC/infra/deploy/check-secrets.sh" || die "密钥文件不齐备：线上没有动"
  one_off "$1" check-env || die "环境变量自检没过（上面逐条是“键名: 原因”，不带值）：线上没有动"
  say "环境变量自检通过"
}

step_migrate() {
  wait_healthy 30 postgres || die "库没在运行：先 node-step.sh deps"
  # 库结构不随代码回滚；迁移失败也可能已应用一部分，先持久化该版本的工具/期望结构来源。
  mkdir -p "$LYX_NODE_HOME" || die "创建不了节点记录目录：迁移未执行"
  (umask 077; printf 'LYX_DB_TAG=%s\n' "$1" >"$DB_RELEASE_ENV.tmp") &&
    mv -f "$DB_RELEASE_ENV.tmp" "$DB_RELEASE_ENV" || die "写不了库迁移版本：迁移未执行"
  one_off "$1" migrate || die "迁移没成：正在跑的容器没有动"
  say "迁移完成"
}

step_seed() {
  local code=0
  wait_healthy 30 postgres redis || die "库或 Redis 没在运行：先 node-step.sh deps"
  one_off "$1" seed || code=$?
  if [ "$code" != 0 ]; then
    printf '播种没过（退出码 %s：1 是配置类断言有违规，2 是环境不对或连不上库）：不要往下起容器\n' "$code" >&2
    exit "$code"
  fi
  say "播种完成，断言 0 违规"
}

step_up() {
  local tag="$1" one
  mkdir -p "$LYX_NODE_HOME"
  printf '# 现在该跑的版本：由 node-step.sh up 写，systemd 重启容器时读。不要手改。\nLYX_TAG=%s\n' "$tag" >"$RELEASE_ENV.tmp" &&
    mv -f "$RELEASE_ENV.tmp" "$RELEASE_ENV" || die "写不了 $RELEASE_ENV"
  if [ "$SUPERVISOR" = systemd ]; then
    systemctl enable --now lyx-postgres.service lyx-redis.service || die "库与 Redis 的单元没起成"
    wait_healthy 90 postgres redis || die "库或 Redis 没有健康"
    # 先 mediatool 与 worker，再 api 与 gateway（D7 第 8.2 节的先后）；重启即按 release.env 换成新版本
    for one in mediatool worker api gateway; do
      systemctl enable "lyx-$one.service" >/dev/null 2>&1
      systemctl restart "lyx-$one.service" || die "lyx-$one 的单元没起成：systemctl status lyx-$one"
    done
  else
    compose "$tag" up -d --remove-orphans || die "容器没起成"
  fi
  # shellcheck disable=SC2086
  wait_healthy 240 $SERVICES || die "六个容器没有都健康：node-step.sh status 看是哪个，docker logs 看原因"
  say "六个容器都在跑且健康：标签 $tag"
}

step_status() {
  local tag host bad=0 one row state health image path body tries=0
  tag="$(current_tag)"
  host="$(setting LYX_API_HOST)"
  printf '应该在跑的版本（release.env）：%s\n' "${tag:-还没有，up 过才有}"
  for one in $SERVICES; do
    row="$(docker inspect --type container -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}|{{.Config.Image}}' "$(container "$one")" 2>/dev/null)" || row="没有这个容器|-|-"
    IFS='|' read -r state health image <<<"$row"
    printf '  %-22s %-10s %-10s %s\n' "$(container "$one")" "$state" "$health" "$image"
    [ "$state" = running ] || bad=1
    case "$health" in healthy | -) ;; *) bad=1 ;; esac
    case "$one" in
      postgres | redis) ;;
      *) case "$image" in *":$tag") ;; *) bad=1 ;; esac ;;
    esac
  done
  [ "$bad" = 0 ] || die "status：有容器没在跑、不健康或版本不对（见上）"
  # 探活在 gateway 容器里发：带上接口域名的 Host，走的就是外面进来的那条路
  for path in /healthz /readyz; do
    if docker exec "$(container gateway)" curl -fsS -o /dev/null -m 5 -H "Host: $host" "http://127.0.0.1:8080$path" 2>/dev/null; then
      printf '  经 gateway %s%s：200\n' "$host" "$path"
    else
      printf '  经 gateway %s%s：不通\n' "$host" "$path"
      bad=1
    fi
  done
  # /health 的整体状态码不看（探针循环 M2 才有，在那之前是 503）；只看 worker 一项：ok 即 worker 持有租约
  while :; do
    body="$(docker exec "$(container gateway)" curl -sS -m 5 -H "Host: $host" "http://127.0.0.1:8080/health" 2>/dev/null)"
    if printf '%s' "$body" | grep -Eq '"worker" *: *"ok"'; then
      printf '  worker 持有租约（/health 里 worker 是 ok）\n'
      break
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 20 ]; then
      printf '  worker 没有持有租约（/health 里 worker 不是 ok）\n'
      bad=1
      break
    fi
    sleep 2
  done
  [ "$bad" = 0 ] || die "status：探活没过（见上）"
  say "status：六个容器在跑，版本一致，探活通过"
}

step_verify_db() {
  local application="$1" runner
  runner="$(db_tag)" || die "库迁移版本不可用"
  runner="${runner:-$application}"
  # 参数仍是待核对的应用版本；核库 runner/快照来自持久化迁移目标，旧节点无记录时才使用该参数。
  printf 'LYX_DB_VERIFY_APPLICATION=%s\nLYX_DB_VERIFY_RUNNER=%s\n' "$application" "$runner"
  wait_healthy 30 postgres || die "库没在运行：先 node-step.sh deps"
  one_off "$runner" verify-db || die "库的核对没过（见上）"
}

step_run() {
  local tag
  tag="$(current_tag)"
  case "$1" in
    postgres | redis) tag="${tag:-none}" ;;
    *) [ -n "$tag" ] || die "还没有 release.env：先 node-step.sh up <标签>" ;;
  esac
  compose_args
  LYX_TAG="$tag" exec docker "${COMPOSE_ARGS[@]}" up --no-deps "$1"
}

# 无宿主 Node 假设：当前 server 镜像只读执行本节点 helper，不挂环境文件或密钥。
step_log_read() (
  set -o pipefail
  local mode="$1" service="$2" value="$3" minutes="$4" tail="$5" tag image output
  shift 5
  tag="$(current_tag)"
  [ -n "$tag" ] || die "还没有当前版本：日志 runner 不可用"
  need_tag "$tag"
  image="$(docker image inspect -f '{{.Id}}' "$(image_name server "$tag")")" || die "当前 server 镜像不可用"
  [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || die "日志 runner 镜像摘要不合法"
  [ -f "$LYX_SRC/infra/deploy/log-stats.mjs" ] && [ ! -L "$LYX_SRC/infra/deploy/log-stats.mjs" ] || die "日志 helper 不可用"
  # 多取一行用来检测超限；pipefail 同时保留 docker logs 和 helper 的失败。
  output="$(docker logs --since "${minutes}m" --tail "$tail" "$(container "$service")" 2>&1 |
    docker run --rm -i --pull never --network none --read-only --user 65534:65534 \
      --cap-drop ALL --security-opt no-new-privileges:true --memory 128m --cpus 0.5 --pids-limit 32 --log-driver none \
      --mount "type=bind,source=$LYX_SRC/infra/deploy/log-stats.mjs,target=/helper/log-stats.mjs,readonly" \
      --entrypoint node "$image" /helper/log-stats.mjs "$mode" "$value" "$@")" || die "日志读取失败或超过上限，未输出不完整结果"
  [ -z "$output" ] || printf '%s\n' "$output"
)

# 这是显式破坏性演练入口，不属于发布流程。先核 Compose 身份，再按不可复用的容器 ID 执行。
step_redis_flush() {
  local project="$1" tag id identity files provider output
  [ "$(setting LYX_REDIS_FLUSH_ENABLED)" = true ] || die "Redis 清空演练未显式开启"
  [ "$(setting STG_FREEZE)" = false ] || die "节点冻结或冻结配置未知，拒绝 Redis 清空"
  [ "$project" = "$LYX_NODE_PROJECT" ] || die "Compose 项目确认不匹配"
  tag="$(current_tag)"
  [ -n "$tag" ] || die "没有本节点当前版本，拒绝 Redis 清空"
  need_tag "$tag"
  id="$(compose "$tag" ps -a -q redis)" || die "读不到本项目 Redis"
  [[ "$id" =~ ^[a-f0-9]{64}$ ]] || die "本项目必须恰有一个 Redis 容器"
  files="$COMPOSE_FILE"
  for provider in $NODE_PROVIDERS; do files="$files,$LYX_SRC/infra/compose/providers/$provider.yml"; done
  identity="$(docker inspect -f '{{.Id}}|{{.Name}}|{{.State.Running}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{len .HostConfig.PortBindings}}' "$id")" || die "核对 Redis 身份失败"
  [ "$identity" = "$id|/$(container redis)|true|$project|redis|$files|False|0" ] || die "Redis 容器不属于本 node.yml 项目，拒绝清空"
  [ "$(setting STG_FREEZE)" = false ] || die "节点已冻结，拒绝 Redis 清空"
  # 口令只在目标容器中从既有只读 secret 读入环境，既不进宿主 argv，也不输出。
  output="$(docker exec "$id" timeout 10 sh -c 'REDISCLI_AUTH="$(sed -n "s/^requirepass //p" /run/secrets/redis-auth.conf)"; [ -n "$REDISCLI_AUTH" ] || exit 1; export REDISCLI_AUTH; exec redis-cli --no-auth-warning -n 0 FLUSHDB SYNC')" || die "Redis 清空执行失败"
  [ "$output" = OK ] || die "Redis 未明确确认清空，演练失败"
  say "本项目 Redis DB 0 已清空；未重启任何容器"
}

# 发布步骤没有独立的命令入口；上面的窄协议校验同时覆盖本地调用与强制 SSH。
. "$LYX_SRC/infra/deploy/node-release.sh"
. "$LYX_SRC/infra/deploy/node-weapp.sh"
. "$LYX_SRC/infra/deploy/node-weapp-review.sh"

case "$step" in
  redis-flush) step_redis_flush "$1" ;;
  logs) step_log_read logs "$1" "$2" 60 5001 ;;
  log-stats)
    if [ $# -eq 3 ]; then step_log_read stats gateway "$1" "$1" 100001 --by-env-version --client-version "$3"
    else step_log_read stats gateway "$1" "$1" 100001; fi
    ;;
  weapp-upload) step_weapp_upload "$1" "$2" ;;
  weapp-review-upload) step_weapp_review_upload "$1" "$2" "$3" ;;
  deps) step_deps ;;
  pull) step_pull "$1" ;;
  check-env) step_check_env "$1" ;;
  migrate) step_migrate "$1" ;;
  seed) step_seed "$1" ;;
  up) step_up "$1" ;;
  status) step_status ;;
  verify-db) step_verify_db "$1" ;;
  stage-assets) step_stage_assets "$1" ;;
  worker-swap) step_worker_swap "$1" ;;
  api-stop) step_api_stop ;;
  api-start) step_api_start "$1" ;;
  smoke) step_smoke "$1" ;;
  prune) step_prune ;;
  preflight) step_preflight ;;
  facts) step_facts ;;
  image-facts) step_image_facts "$1" ;;
  verify-assets) step_verify_assets "$1" ;;
  verify-assets-live) step_verify_assets_live "$@" ;;
  record) step_record "$1" "$2" ;;
  run) step_run "$1" ;;
  stop)
    tag="$(current_tag)"
    case "$1" in api | gateway) timeout=30 ;; *) timeout=60 ;; esac
    compose "${tag:-none}" stop --timeout "$timeout" "$1" || die "没停成：$1"
    ;;
  wait) wait_healthy 90 "$@" || exit 1 ;;
esac
