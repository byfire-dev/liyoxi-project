# 五组件私有源码映射（W2-27b2a）

本片仅交付api、worker、admin、portal、weapp真实构建map的私有产物机制。上传未配置且未实现；没有上传CLI、令牌、debug ID注入或SDK修改，不代表错误堆栈已能还原。images工作流接线与既有门禁适配另交独立gate-change；本片落地不自动改变远端发布流程。

API/worker用external map，admin/portal生产用hidden map，小程序正式构建开启map。分离助手在Docker编译层完成后、最终runtime COPY之前执行；小程序在Taro编译后、原体积检查之前执行。私有副本保留实际发布JS与对应map，发布目录不保留map与终端sourceMappingURL；移除引用时保留行列位置。不会从已发布镜像中临时删除文件，也不上传空目录冒充完成。

## 同一次构建与私有目录

在仓库根目录执行，源码须已冻结；仅使用本轮自有tag与目录，按server、gateway、小程序顺序，不重建mediatool/uploader。示例不触发发布、拉取或外部请求：

```sh
SOURCE="$(git rev-parse HEAD)"
TAG="sha-$(git rev-parse --short=12 HEAD)"
REPOSITORY_URL="$(git config --get remote.origin.url)"
LYX_SOURCE_MAPS_DIR="$(node infra/deploy/source-maps.mjs init "${TMPDIR:-/tmp}")"
MAPS_DIR="$LYX_SOURCE_MAPS_DIR"
export SOURCE TAG REPOSITORY_URL LYX_SOURCE_MAPS_DIR MAPS_DIR
trap 'node infra/deploy/source-maps.mjs cleanup "$LYX_SOURCE_MAPS_DIR"' EXIT
docker buildx bake -f infra/docker/source-maps.hcl --progress plain server-bundle
docker buildx bake -f infra/docker/source-maps.hcl --progress plain gateway-bundle
WEAPP_VERSION="$TAG" pnpm weapp:build
docker image inspect "liyoxi/server:$TAG" "liyoxi/gateway:$TAG" > "$LYX_SOURCE_MAPS_DIR/images.json"
node infra/deploy/source-maps.mjs finalize "$LYX_SOURCE_MAPS_DIR" "$SOURCE" "$TAG"
node infra/deploy/source-maps.mjs verify "$LYX_SOURCE_MAPS_DIR" "$SOURCE" "$TAG"
```

小程序仍需既有正式构建的非敏感AppID/API配置；不要从秘密文件读取凭据。本机执行前先核构建工具、空间和本地固定基础镜像，不自动拉取或清理共享缓存。上例只清本轮带所有权收据的临时目录，不删除镜像或其他目录。私有map在该目录删除后不留副本；后继真正上传步骤必须在最终清理之前消费同份产物，不能重构建后冒充同源。

每个bake组同时请求runtime与source-maps两个target，两者继承相同Dockerfile/context/build参数，BuildKit共享编译DAG。`--print`只证明配置可解析；实际验收必须核plain日志中该Dockerfile的共同编译RUN只执行一次，不能把分开构建两个target当作证据。runtime镜像tag不包含私有target，后者只导出到本轮目录。

## 校验与失败边界

固定组件、入口与路径由助手限定，不接受任意源目录或component。拒绝符号链接、路径穿越、缺map、非v3 map、非配对/内联引用、空文件及超限；单文件64MiB、每组件512MiB、最多4096文件。编译产物需位于私有输出目录之外；公开目录只在全部配对通过后开始替换/去除map，分离失败则构建失败，不继续发布。

manifest绑定完整40位source、`sha-`加前12位tag、实际server/gateway本地image ID及OCI revision，记录五组件每对JS/map的大小与SHA256。`verify`重新读取镜像事实和全部文件，不只相信manifest；目录0700、私有文件0600，输出仅固定摘要，失败仅固定错误。备份/上传归档不进入原公开images-out artifact。

本片不解决错误协议中的frame/debug_meta、上游release/dist与SDK一致性、SaaS可达或真实符号化。上述能力与CLI官方锁版、inject/上传另行实现并验证，默认没有令牌时不能声称上传成功。第三方依赖包自带map不纳入本片五组件第一方发布目录的清理承诺。
