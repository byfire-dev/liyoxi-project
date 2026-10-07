#!/usr/bin/env bash
# 私有消费者。SSH只传两个hex；桶、工具与密钥路径全由节点固定配置决定。
step_weapp_upload() (
  set -o pipefail
  local source="$1" manifest_hash="$2" tag="sha-${1:0:12}" cos_appid prefix image image_id stage key appid api
  cos_appid="$(setting STG_COS_APPID)"
  if [ "$(setting LYX_WEAPP_UPLOAD_ENABLED)" != true ] || [ -z "$cos_appid" ]; then
    printf 'LYX_WEAPP_UPLOAD={"status":"skipped","reason":"disabled_or_bucket_unconfigured"}\n'
    exit 0
  fi
  [ "$(setting STG_FREEZE)" != true ] || die 'LYX_WEAPP_UPLOAD={"status":"failed","reason":"frozen"}'
  [[ "$cos_appid" =~ ^[1-9][0-9]{4,19}$ ]] || usage_die '上传桶配置不合法'
  appid="$(setting WEAPP_APPID)"; api="$(setting WEAPP_API_BASE_URL)"
  [[ "$appid" =~ ^wx[a-f0-9]{16}$ ]] && [[ "$api" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]?#]*)?$ ]] || usage_die '上传公开配置不合法'
  [ "$(current_tag)" = "$tag" ] || die '当前部署源码不符，拒绝上传'
  local python="$LYX_NODE_HOME/tools/cos/bin/python"
  [ -x "$python" ] || die '缺少固定 COS 工具；不会自动安装'
  for key in cos-secret-id cos-secret-key weapp-upload-private-key; do
    [ -f "$LYX_SECRETS_DIR/$key" ] && [ ! -L "$LYX_SECRETS_DIR/$key" ] && [ -r "$LYX_SECRETS_DIR/$key" ] || die '上传凭据文件不可用'
  done
  prefix="$(setting LYX_IMAGE_PREFIX)"
  if [ -n "$prefix" ]; then
    [[ "$prefix" =~ ^[a-z0-9.-]+(:[0-9]+)?/([a-z0-9][a-z0-9_-]*/)*$ ]] || usage_die '镜像前缀不合法'
    image="$(image_name weapp-uploader "$tag")"
    docker pull "$image" >/dev/null 2>&1 || die '上传器拉取失败'
  else image="liyoxi/weapp-uploader:$tag"; fi
  image_id="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null)" || die '上传器镜像不可用'
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || die '上传器镜像事实不可用'
  stage="$(mktemp -d "$LYX_NODE_HOME/.weapp-upload.XXXXXX")" || die '上传临时目录不可用'
  trap 'rm -rf -- "$stage"' EXIT
  "$python" "$LYX_SRC/infra/bootstrap/cos-adapter/artifact_reader.py" "lyx-stg-secure-$cos_appid" "$source" "$manifest_hash" "$stage" >/dev/null || die '制品下载或摘要校验失败'
  # 节点root状态只复制这两份无密钥事实；不把整个节点home挂入SDK容器。
  cp "$RELEASE_ENV" "$stage/release.env" && cp "$LYX_NODE_HOME/releases.log" "$stage/releases.log" || die '部署成功记录不可用'
  chown -R 1000:1000 "$stage" || die '上传临时目录权限不可用'
  docker run --rm --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m \
    -v "$LYX_SRC/infra:/source/infra:ro" -v "$stage:/artifacts:ro" \
    -v "$stage/release.env:/node-release.env:ro" -v "$stage/releases.log:/node-releases.log:ro" \
    -v "$LYX_SECRETS_DIR/weapp-upload-private-key:/run/secrets/weapp-upload-private-key:ro" \
    -e "LYX_UPLOAD_SOURCE=$source" -e "LYX_UPLOAD_MANIFEST_SHA=$manifest_hash" \
    -e "WEAPP_APPID=$appid" -e "WEAPP_API_BASE_URL=$api" \
    -e "LYX_UPLOADER_IMAGE_ID=$image_id" -e HOME=/tmp --entrypoint node "$image_id" /source/infra/deploy/weapp-artifact.mjs \
    || die 'LYX_WEAPP_UPLOAD={"status":"failed"}'
)
