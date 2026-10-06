#!/usr/bin/env bash
# node-step.sh 的发布步骤扩展；只由经过参数校验的入口 source，不单独执行。

write_release() {
  mkdir -p "$LYX_NODE_HOME"
  printf '# 现在该跑的版本：由节点步骤写。不要手改。\nLYX_TAG=%s\n' "$1" >"$RELEASE_ENV.tmp" &&
    mv -f "$RELEASE_ENV.tmp" "$RELEASE_ENV" || die "写不了 release.env"
}

image_name() { printf '%sliyoxi/%s:%s' "$(setting LYX_IMAGE_PREFIX)" "$1" "$2"; }

step_image_facts() {
  local tag="$1" one digest
  for one in server gateway mediatool; do
    digest="$(docker image inspect -f '{{.Id}}' "$(image_name "$one" "$tag")")" || die "本地缺少目标镜像：$one:$tag，线上未动"
    [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || die "镜像摘要不合法：$one:$tag"
    printf 'LYX_IMAGE=%s|%s\n' "$one" "$digest"
  done
}

step_facts() (
  set -o pipefail
  local tag row
  tag="$(current_tag)"
  if [ -n "$tag" ]; then need_tag "$tag"; fi
  printf 'LYX_CURRENT=%s\n' "$tag"
  if [ -f "$LYX_NODE_HOME/releases.log" ]; then
    [ -r "$LYX_NODE_HOME/releases.log" ] || die "读不了 releases.log"
    if [ -s "$LYX_NODE_HOME/releases.log" ]; then
      local last
      last="$(tail -c 1 "$LYX_NODE_HOME/releases.log" | od -An -tu1 | tr -d '[:space:]')" || die "核对发布记录行尾失败"
      [ "$last" = 10 ] || die "发布历史缺少完整行尾，拒绝使用截断记录"
    fi
    while IFS= read -r row || [ -n "$row" ]; do
      [ -z "$row" ] || printf 'LYX_RECORD=%s\n' "$row"
    done <"$LYX_NODE_HOME/releases.log"
  fi
)

step_preflight() {
  local mode db exists ids
  mode="$(setting LYX_P1_CHECK)"
  case "$mode" in
    "" | unavailable)
      printf 'LYX_PREFLIGHT={"p1":"unavailable","ids":[]}\n'
      return ;;
    enabled) ;;
    *) die "LYX_P1_CHECK 只能是 unavailable 或 enabled" ;;
  esac
  db="$(setting LYX_DB_NAME)"
  [[ "$db" =~ ^[a-z_][a-z0-9_]*$ ]] || die "预检库名不合法"
  exists="$(docker exec "$(container postgres)" psql -X -At -v ON_ERROR_STOP=1 -U postgres -d "$db" -c "SELECT to_regclass('public.alert_event') IS NOT NULL")" || die "P1 预检查询失败：线上未动"
  case "$exists" in
    f) printf 'LYX_PREFLIGHT={"p1":"unavailable","ids":[]}\n'; return ;;
    t) ;;
    *) die "P1 表查询返回值不合法" ;;
  esac
  ids="$(docker exec "$(container postgres)" psql -X -At -v ON_ERROR_STOP=1 -U postgres -d "$db" -c "SELECT coalesce(json_agg(id ORDER BY id)::text,'[]') FROM public.alert_event WHERE severity='P1' AND status IN ('open','acked')")" || die "P1 预检查询失败：线上未动"
  # 查询结果只含 UUID；JSON 的严格校验在编排侧，不直接当成可执行参数。
  printf 'LYX_PREFLIGHT={"p1":"checked","ids":%s}\n' "$ids"
}

record_helper() {
  local runner="$1"
  shift
  docker run --rm --network none --read-only --user 0:0 --cap-drop ALL --security-opt no-new-privileges:true \
    --tmpfs /tmp:size=16m \
    --mount "type=bind,source=$LYX_NODE_HOME/releases.log,target=/records/releases.log" \
    --mount "type=bind,source=$LYX_SRC/infra/deploy/node-record.mjs,target=/helper/node-record.mjs,readonly" \
    --entrypoint node "$(image_name server "$runner")" /helper/node-record.mjs "$@"
}

step_record() {
  local target="$1" encoded="$2" runner
  runner="$(current_tag)"
  if [ -n "$runner" ]; then
    need_tag "$runner"
    if ! docker image inspect "$(image_name server "$runner")" >/dev/null 2>&1; then runner=""; fi
  fi
  if [ -z "$runner" ]; then
    docker image inspect "$(image_name server "$target")" >/dev/null 2>&1 || die "没有可用的记录 runner 镜像；CI 摘要仍保留原始失败"
    runner="$target"
  fi
  mkdir -p "$LYX_NODE_HOME"
  (umask 077; : >>"$LYX_NODE_HOME/releases.log") || die "创建不了发布记录文件"
  record_helper "$runner" append "$target" "$encoded" || die "节点发布记录没写成；不覆盖原始发布结果"
}

step_stage_assets() (
  set -o pipefail
  local tag="$1" name stage one source destination list rel file links
  name="${LYX_NODE_PREFIX}-assets-${tag}-$$"
  mkdir -p "$LYX_NODE_HOME"
  stage="$(mktemp -d "$LYX_NODE_HOME/.stage-assets.XXXXXX")" || die "建不了预置临时目录"
  cleanup_assets() {
    local code=$?
    trap - EXIT
    if [ -n "$name" ]; then docker rm "$name" >/dev/null || code=1; fi
    rm -rf -- "$stage"
    exit "$code"
  }
  trap cleanup_assets EXIT
  docker create --name "$name" --network none --read-only --entrypoint /bin/true \
    "$(image_name gateway "$tag")" >/dev/null || { name=""; die "创建静态资源提取容器失败：线上未动"; }
  mkdir -p "$LYX_NODE_HOME/static/.releases/$tag"
  for one in admin portal; do
    source="$stage/$one"
    destination="$LYX_NODE_HOME/static/$one/assets"
    mkdir -p "$source" "$destination"
    docker cp "$name:/usr/share/nginx/$one/assets/." "$source" || die "提取 $one 静态资源失败：线上未动"
    links="$(find "$source" -type l -print)" || die "枚举静态资源失败"
    [ -z "$links" ] || die "静态资源不接受符号链接"
    list="$stage/$one.list"
    (cd "$source" && find . -type f -print | LC_ALL=C sort) >"$list" || die "枚举静态资源失败"
    [ -s "$list" ] || die "$one 的静态资源为空"
    while IFS= read -r rel; do
      case "$rel" in ./assets/* | *..* | *'|'*) die "静态资源路径不合法" ;; esac
      file="$destination/${rel#./}"
      mkdir -p "$(dirname "$file")"
      if [ -e "$file" ]; then
        [ -f "$file" ] && [ ! -L "$file" ] && cmp -s "$source/$rel" "$file" || die "同名静态资源内容不同，拒绝覆盖：$one/$rel"
      else
        ln "$source/$rel" "$file" || die "预置静态资源失败：$one/$rel"
      fi
      touch "$file" || die "静态资源保留时间更新失败"
    done <"$list"
    cp "$list" "$LYX_NODE_HOME/static/.releases/$tag/$one.list" || die "静态资源清单写入失败"
  done
  say "静态资源已预置且没有覆盖：$tag"
)

stop_release_services() {
  local one tag timeout state
  tag="$(current_tag)"
  for one in "$@"; do
    case "$one" in api | gateway) timeout=30 ;; *) timeout=60 ;; esac
    if [ "$SUPERVISOR" = systemd ]; then
      systemctl stop "lyx-$one.service" || die "停旧服务失败：$one"
    else
      compose "${tag:-none}" stop --timeout "$timeout" "$one" || die "停旧服务失败：$one"
    fi
    state="$(docker ps -a --filter "name=^/$(container "$one")$" --format '{{.State}}')" || die "确认旧服务退出失败：$one"
    case "$state" in "" | exited | dead | created) ;; *) die "旧服务尚未退出：$one（$state）" ;; esac
  done
}

start_release_services() {
  local tag="$1" one
  shift
  write_release "$tag"
  if [ "$SUPERVISOR" = systemd ]; then
    for one in "$@"; do
      systemctl enable "lyx-$one.service" || die "启用服务失败：$one"
      systemctl start "lyx-$one.service" || die "起新服务失败：$one"
    done
  else
    compose "$tag" up -d --no-deps "$@" || die "起新服务失败"
  fi
  wait_healthy 90 "$@" || die "新服务没有健康"
}

step_worker_swap() {
  # worker 先收到 SIGTERM 并让出租约；它退出以后才停 mediatool。
  stop_release_services worker mediatool
  start_release_services "$1" mediatool
  start_release_services "$1" worker
  say "worker 与 mediatool 已换：$1"
}

step_api_stop() { stop_release_services api gateway; }

step_api_start() {
  local tag="$1" host consecutive=0 started now code
  start_release_services "$tag" api gateway
  host="$(setting LYX_API_HOST)"
  started="$(date +%s)" || die "读取探活起始时间失败"
  while :; do
    now="$(date +%s)" || die "读取探活时间失败"
    [[ "$started" =~ ^[0-9]+$ && "$now" =~ ^[0-9]+$ ]] || die "探活时间不合法"
    [ "$((now - started))" -le 90 ] || break
    code="$(docker exec "$(container gateway)" curl -sS -o /dev/null -w '%{http_code}' -m 3 -H "Host: $host" http://127.0.0.1:8080/readyz)" || code="000"
    if [ "$code" = 200 ]; then consecutive=$((consecutive + 1)); else consecutive=0; fi
    [ "$consecutive" -lt 3 ] || { say "api 与 gateway 已换，readyz 连续三次 200：$tag"; return; }
    sleep 1
  done
  die "api readyz 未连续三次 200"
}

step_smoke() {
  local tag="$1" host key path body version
  host="$(setting LYX_API_HOST)"
  [ -n "$host" ] || die "冒烟缺少域名：LYX_API_HOST"
  for path in /healthz /readyz; do
    docker exec "$(container gateway)" curl -fsS -o /dev/null -m 5 -H "Host: $host" "http://127.0.0.1:8080$path" || die "冒烟失败：LYX_API_HOST$path"
  done
  body="$(docker exec "$(container gateway)" curl -sS -m 5 -H "Host: $host" http://127.0.0.1:8080/health)" || die "版本冒烟请求失败"
  version="$(printf '%s' "$body" | sed -n 's/.*"version"[ ]*:[ ]*"\([A-Za-z0-9_.-]*\)".*/\1/p')"
  [ "$version" = "$tag" ] || die "版本冒烟不符：应该是 $tag"
  printf '%s' "$body" | grep -Eq '"worker" *: *"ok"' || die "冒烟：worker 没有持有租约"
  # 实际网关仅 API 暴露探活；前端同名路径会 SPA 回落，故核入口与真实构建号。
  for key in LYX_ADMIN_HOST LYX_PORTAL_HOST; do
    host="$(setting "$key")"
    [ -n "$host" ] || die "冒烟缺少域名：$key"
    body="$(docker exec "$(container gateway)" curl -fsS -m 5 -H "Host: $host" http://127.0.0.1:8080/)" || die "前端入口冒烟请求失败：$key"
    printf '%s' "$body" | grep -Fq "<meta name=\"lyx-build\" content=\"$tag\"" || die "前端入口构建号不符：$key"
  done
  # 随后的 verify-assets-live 核当前入口和新旧全部资源；此步只做轻量健康/版本冒烟。
  say "API 探活、两个前端入口、构建版本与 worker 冒烟通过：$tag"
}

step_prune() {
  local tag current keep known rows one repository candidate digest prefix files file rel protected
  current="$(current_tag)"
  [ -n "$current" ] || die "没有当前版本，拒绝清理"
  if [ ! -f "$LYX_NODE_HOME/releases.log" ]; then
    say "尚无成功发布记录，跳过清理，不猜测已有镜像归属"
    return
  fi
  keep="$(record_helper "$current" keep "$current")" || die "解析保留版本失败，什么都不清理"
  [ -n "$keep" ] || die "保留版本为空，拒绝清理"
  known="$(record_helper "$current" known "$current")" || die "解析成功版本失败，什么都不清理"
  prefix="$(setting LYX_IMAGE_PREFIX)"
  for one in server gateway mediatool; do
    rows="$(docker image ls --filter "reference=${prefix}liyoxi/$one:*" --format '{{.Repository}}|{{.Tag}}|{{.ID}}')" || die "枚举项目镜像失败"
    while IFS='|' read -r repository candidate digest; do
      [ -n "$repository" ] || continue
      [ "$repository" = "${prefix}liyoxi/$one" ] || die "镜像清理列表出现其他项目"
      [[ "$candidate" =~ ^sha-[a-f0-9]{12}$ ]] || continue
      if printf '%s\n' "$known" | grep -Fxq "$candidate" && ! printf '%s\n' "$keep" | grep -Fxq "$candidate"; then
        # 按本项目的 tag 删除，不按共享镜像 ID、不强制，不做全局 prune。
        docker image rm "$repository:$candidate" || die "旧项目镜像清理失败：$candidate"
      fi
    done <<<"$rows"
  done
  for one in admin portal; do
    [ -d "$LYX_NODE_HOME/static/$one/assets" ] || continue
    protected="$(mktemp "$LYX_NODE_HOME/.protected-assets.XXXXXX")" || die "创建资源清理清单失败"
    while IFS= read -r tag; do
      file="$LYX_NODE_HOME/static/.releases/$tag/$one.list"
      if [ ! -r "$file" ]; then rm -f -- "$protected"; die "缺少可回滚版本的资源清单，拒绝资源清理：$tag/$one"; fi
      cat "$file" >>"$protected" || die "读取保留资源清单失败"
    done <<<"$keep"
    files="$(find "$LYX_NODE_HOME/static/$one/assets" -type f -mtime +59 -print)" || die "枚举旧资源失败"
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      rel="./${file#"$LYX_NODE_HOME/static/$one/assets/"}"
      if ! grep -Fxq "$rel" "$protected"; then rm -- "$file" || die "旧资源清理失败"; fi
    done <<<"$files"
    rm -- "$protected" || die "清理临时清单失败"
  done
  say "仅清理本项目旧版本；最近三个成功版本及当前版本受保护，资源至少保留 60 天"
}

asset_helper() {
  local runner="$1" mode="$2" stage="$3" network=none access=""
  shift 3
  if [ "$mode" = live ]; then network="container:$(container gateway)"; access=,readonly; fi
  docker run --rm --network "$network" --read-only --user 0:0 --cap-drop ALL --security-opt no-new-privileges:true \
    --tmpfs /tmp:size=16m \
    --mount "type=bind,source=$stage,target=/facts/image,readonly" \
    --mount "type=bind,source=$LYX_NODE_HOME/static,target=/facts/static,readonly" \
    --mount "type=bind,source=$LYX_NODE_HOME/static/.releases,target=/facts/records$access" \
    --mount "type=bind,source=$LYX_SRC/infra/deploy/asset-inventory.mjs,target=/helper/deploy/asset-inventory.mjs,readonly" \
    --mount "type=bind,source=$LYX_SRC/infra/ci/probe-during-deploy.mjs,target=/helper/ci/probe-during-deploy.mjs,readonly" \
    -e "LYX_ADMIN_HOST=$(setting LYX_ADMIN_HOST)" -e "LYX_PORTAL_HOST=$(setting LYX_PORTAL_HOST)" \
    --entrypoint node "$(image_name server "$runner")" /helper/deploy/asset-inventory.mjs "$mode" "$@"
}

capture_assets() (
  local tag="$1" runner="$2" stage name one
  stage="$(mktemp -d "$LYX_NODE_HOME/.verify-assets.XXXXXX")" || die "建不了资源核对临时目录"
  name="${LYX_NODE_PREFIX}-verify-assets-${tag}-$$"
  cleanup_inventory() {
    local code=$?
    trap - EXIT
    if [ -n "$name" ]; then docker rm "$name" >/dev/null || code=1; fi
    rm -rf -- "$stage"
    exit "$code"
  }
  trap cleanup_inventory EXIT
  docker create --name "$name" --network none --read-only --entrypoint /bin/true \
    "$(image_name gateway "$tag")" >/dev/null || { name=""; die "创建完整资源提取容器失败"; }
  for one in admin portal; do
    mkdir -p "$stage/$one"
    docker cp "$name:/usr/share/nginx/$one/." "$stage/$one" || die "提取完整资源失败：$one"
  done
  asset_helper "$runner" capture "$stage" "$tag" || die "完整资源不符：线上未动"
)

step_verify_assets() {
  local tag="$1" previous
  mkdir -p "$LYX_NODE_HOME/static/.releases"
  capture_assets "$tag" "$tag" || return 1
  previous="$(current_tag)"
  if [ -n "$previous" ] && [ "$previous" != "$tag" ]; then
    need_tag "$previous"
    capture_assets "$previous" "$tag" || return 1
  fi
}
step_verify_assets_live() {
  asset_helper "$1" live "$LYX_NODE_HOME/static/.releases" "$@" || die "当前入口或新旧资源不完整"
}
