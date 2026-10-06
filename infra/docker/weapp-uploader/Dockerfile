# 独立依赖上下文，不带根依赖、业务源码、制品与密钥。Node 摘要同三个既有镜像。
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund && npm cache clean --force
COPY upload.mjs ./
USER 1000:1000
ENV NODE_ENV=production
ENTRYPOINT ["node", "/app/upload.mjs"]
CMD ["--check"]
