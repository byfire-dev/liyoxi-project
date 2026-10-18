#!/usr/bin/env bash
# 狸有戏 · 预发节点脚本共用的部分（W2-25）。由 check-secrets.sh、node-step.sh 与 infra/bootstrap/ 下的脚本 source，自己不是命令。
# 写法兼容 bash 3.2（本机的用例在 macOS 上跑）与节点上的 bash 4 以上；只用 POSIX 的 awk、sed、ls，不要 jq、python。
#
# 两个目录：
#   LYX_SRC        脚本所在的那棵树的根（仓库根；节点上是 /opt/liyoxi，里面照仓库的样子放着 infra/）。按本文件的位置算，不用设
#   LYX_NODE_HOME  节点上放状态的目录，缺省 /opt/liyoxi：secrets/（密钥文件）、static/、node.env（本机的非敏感设置）、
#                  release.env（现在该跑哪个版本，由节点步骤 up 写）。演练时指到临时目录
# 其余可调的变量（都可以不设）：
#   LYX_SECRETS_DIR      密钥目录，缺省 $LYX_NODE_HOME/secrets
#   LYX_NODE_PREFIX      容器、网络、卷的名字前缀，缺省 lyx（容器就是 lyx-api 等）。演练时换一个，不撞本机别的容器
#   LYX_NODE_PROJECT     Compose 项目名，缺省 liyoxi-node

LYX_SRC="${LYX_SRC:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
LYX_NODE_HOME="${LYX_NODE_HOME:-/opt/liyoxi}"
LYX_SECRETS_DIR="${LYX_SECRETS_DIR:-$LYX_NODE_HOME/secrets}"
LYX_NODE_PREFIX="${LYX_NODE_PREFIX:-lyx}"
LYX_NODE_PROJECT="${LYX_NODE_PROJECT:-liyoxi-node}"
LYX_MANIFEST="$LYX_SRC/infra/deploy/secrets.manifest.json"
export LYX_SRC LYX_NODE_HOME LYX_SECRETS_DIR LYX_NODE_PREFIX LYX_NODE_PROJECT

say() { printf '== %s\n' "$*"; }
# 某一步没成：退出码 1
die() {
  printf '%s\n' "$*" >&2
  exit 1
}
# 用法或环境不对：退出码 2
usage_die() {
  printf '%s\n' "$*" >&2
  exit 2
}

# 读密钥清单，一项一行，竖线分隔：文件名|属主 uid|现在就要(true/false)|挂给哪些服务（空格分隔，可空）|环境变量名（可空）。
# 读的一侧写 while IFS="|" read -r file uid required services env（竖线不是空白，空的字段不会被吞掉）。
# 清单是 JSON，这里按行读：每项的值只有字符串、数字、布尔，字符串里没有反斜杠与花括号（清单开头写了，用例核对）。
manifest_rows() {
  [ -r "$LYX_MANIFEST" ] || die "读不了密钥清单 infra/deploy/secrets.manifest.json"
  awk '
    function field(key,    re, s) {
      re = "\"" key "\"[ ]*:[ ]*(\"[^\"]*\"|[0-9]+|true|false)"
      if (!match($0, re)) return
      s = substr($0, RSTART, RLENGTH)
      sub(/^"[^"]*"[ ]*:[ ]*/, "", s)
      gsub(/^"|"$/, "", s)
      rec[key] = s
      seen[key] = 1
    }
    /"secrets"[ ]*:/ { on = 1; next }
    on {
      field("file"); field("uid"); field("required"); field("services"); field("env")
      if ($0 ~ /}/) {
        if (seen["file"]) printf "%s|%s|%s|%s|%s\n", rec["file"], rec["uid"], rec["required"], rec["services"], rec["env"]
        split("", rec); split("", seen)
      }
    }
  ' "$LYX_MANIFEST"
}

# 可选 Provider 的选择只接受仓内固定名字；与 Compose、systemd 的独立密钥检查共用。
# 不 source node.env：它只装非敏感的 键=值，不能执行其中的 shell 文本。
node_providers() {
  local value="" file count line one selected=""
  if [ "${LYX_NODE_PROVIDERS+x}" = x ]; then
    value="$LYX_NODE_PROVIDERS"
  else
    for file in "$LYX_NODE_HOME/node.env" "$LYX_SRC/infra/compose/env/stg.env"; do
      [ -f "$file" ] || continue
      count="$(awk '/^[[:space:]]*(export[[:space:]]+)?LYX_NODE_PROVIDERS[[:space:]]*=/ { n++ } END { print n+0 }' "$file")"
      [ "$count" -le 1 ] || usage_die "LYX_NODE_PROVIDERS 不可重复定义"
      if [ "$count" = 1 ]; then
        line="$(awk '/^[[:space:]]*(export[[:space:]]+)?LYX_NODE_PROVIDERS[[:space:]]*=/ { print; exit }' "$file")"
        case "$line" in
          LYX_NODE_PROVIDERS=*) value="${line#LYX_NODE_PROVIDERS=}" ;;
          *) usage_die "LYX_NODE_PROVIDERS 须按无引号的 键=值 单独写一行" ;;
        esac
        break
      fi
    done
  fi
  [ "${#value}" -le 256 ] || usage_die "LYX_NODE_PROVIDERS 过长"
  case "$value" in
    *[!a-z\ -]*) usage_die "LYX_NODE_PROVIDERS 只接受固定能力名，以空格分隔，不加引号" ;;
  esac
  for one in $value; do
    case "$one" in
      cos | ci | asr | asr-callback | ocr | mail | llm | media-production | client-errors | alerts | server-errors | wechat) ;;
      *) usage_die "LYX_NODE_PROVIDERS 含未知能力名" ;;
    esac
    case " $selected " in *" $one "*) usage_die "LYX_NODE_PROVIDERS 不可重复选择能力" ;; esac
    [ -f "$LYX_SRC/infra/compose/providers/$one.yml" ] || usage_die "缺少仓内 Provider 配置：${one}.yml"
    selected="${selected:+$selected }$one"
  done
  case " $selected " in
    *" asr-callback "*)
      case " $selected " in *" asr "*) ;; *) usage_die "asr-callback 必须同时启用 asr" ;; esac
      ;;
  esac
  printf '%s\n' "$selected"
}

# 每组启用后必须齐备的文件。角色去向仍由唯一的 secrets.manifest.json 记录。
provider_files() {
  case "$1" in
    cos) printf '%s\n' "cos-signer-keys.json cos-sts-issuer-keys.json cos-worker-keys.json" ;;
    ci) printf '%s\n' "ci-worker-keys.json ci-callback-key" ;;
    asr) printf '%s\n' "asr-tencent.json" ;;
    asr-callback) printf '%s\n' "asr-callback-key" ;;
    ocr) printf '%s\n' "ocr-tencent.json" ;;
    mail) printf '%s\n' "mail-tencent.json" ;;
    llm) printf '%s\n' "llm-domestic.json" ;;
    media-production) printf '%s\n' "media-production.json" ;;
    client-errors) printf '%s\n' "client-error-projects.json" ;;
    alerts) printf '%s\n' "alerts.json" ;;
    server-errors) printf '%s\n' "server-errors.json" ;;
    wechat) printf '%s\n' "wechat-secret wechat-message-token wechat-message-aes-key" ;;
    *) usage_die "未知 Provider 能力" ;;
  esac
}
