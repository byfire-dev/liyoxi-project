# 狸有戏 · mediatool 隔离容器的镜像（D5 第 6.6 节；04 ADR-030；X-02 任务书）。镜像名 liyoxi/mediatool（D7 第 7.4 节）。
#
# 里面只有两样：钉死版本的 ffmpeg / ffprobe，与 service/ 下的 Node 服务（只用 Node 内置模块，不装任何 npm 包）。
# 运行时的约束（无网络、根只读、非 root、去掉全部能力、进程数与内存上限）不写在镜像里，由 Compose 套上：
# 写法见 compose.verify.yml，W1-22 怎么复用见 README.md。
# 升级基础镜像或 ffmpeg：改下面的摘要与版本号，重跑 pnpm mediatool:verify 与 pnpm mediatool:bench，结论补进 ADR；单独成 PR。

# 基础镜像固定到摘要。这是多架构清单的摘要，amd64 与 arm64 共用；取自 Docker Hub 官方库（2026-10-05）：
#   docker buildx imagetools inspect node:24-slim
# 内容：Node 24.21.0，Debian 12（bookworm）。
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# ffmpeg 用 Debian 12 官方仓库里的包，版本号写死（任务书 第 11 节第 2 项）。
# Debian 给这个包出安全更新后，旧版本会从仓库撤掉，构建就在这一步失败：那时改版本号并重跑验证，不改成“装最新的”。
ARG FFMPEG_DEB_VERSION=7:5.1.9-0+deb12u1

# 软件源走 HTTPS。有的网络会把明文 HTTP 交给透明代理，整个文件收完才往下传，apt 等不到数据就超时
# （X-02 在开发机上遇到的就是这种）。基础镜像没带系统根证书：把 Node 自带的那一份导出来给 apt 用，装完即删；
# 软件源文件装完改回原样，不给后面的层留下改动。最后核对装上的 ffmpeg / ffprobe 就是写死的那个版本。
RUN set -eux; \
    node -e 'require("node:fs").writeFileSync("/tmp/node-ca.pem", require("node:tls").rootCertificates.join("\n"))'; \
    cp /etc/apt/sources.list.d/debian.sources /tmp/debian.sources.orig; \
    sed -i 's|http://deb.debian.org|https://deb.debian.org|' /etc/apt/sources.list.d/debian.sources; \
    apt-get -o Acquire::https::CAInfo=/tmp/node-ca.pem -o Acquire::Retries=3 update; \
    apt-get -o Acquire::https::CAInfo=/tmp/node-ca.pem -o Acquire::Retries=3 install -y --no-install-recommends "ffmpeg=${FFMPEG_DEB_VERSION}"; \
    cp /tmp/debian.sources.orig /etc/apt/sources.list.d/debian.sources; \
    rm -rf /var/lib/apt/lists/* /tmp/node-ca.pem /tmp/debian.sources.orig; \
    ffmpeg -hide_banner -version | head -n 1 | grep -F "ffmpeg version ${FFMPEG_DEB_VERSION#*:} "; \
    ffprobe -hide_banner -version | head -n 1 | grep -F "ffprobe version ${FFMPEG_DEB_VERSION#*:} "

# 用不到的包管理器拿掉：服务不装任何 npm 包，容器里也没有网络。
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# 共享目录的挂载点。命名卷第一次挂到这里时会沿用这个目录的属主与权限，所以让 mediatool 先于调用端启动。
# 用户是基础镜像自带的 node（1000:1000）；调用端要用同一个用户（或同组）才读写得了共享目录。
RUN mkdir -p /work && chown 1000:1000 /work && chmod 0770 /work

COPY service/ /app/
COPY fonts/ /app/fonts/
RUN echo '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b  /app/fonts/NotoSansCJKsc-Regular.otf' | sha256sum -c -

USER 1000:1000
WORKDIR /app
ENV NODE_ENV=production

HEALTHCHECK --interval=5s --timeout=3s --start-period=2s --retries=6 CMD ["node", "/app/healthcheck.mjs"]
CMD ["node", "/app/server.mjs"]
