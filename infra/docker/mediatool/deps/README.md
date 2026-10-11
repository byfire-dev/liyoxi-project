# 固定文档解析依赖

`package.json` 的三项版本沿用实际 main8fe4eb2d 的 services/API/worker：
Mammoth 1.13.0、PDF.js 6.3.289、canvas 1.0.9，不新增根依赖或升级。
此处 lockfileVersion 9.0 沿根 `pnpm-lock.yaml` 的37包传递闭包：packages与snapshots
逐块原样复制，仅独立根importer列三项直接依赖；pnpm仍10.34.5。

canvas的11个optional native分支保留原integrity、cpu/os/libc条件。Debian镜像
按实际平台仅选择linux-arm64-gnu或linux-x64-gnu，其余仍在锁中，不强装Darwin
或musl产物。安装禁scripts、固定release-age10080与trustPolicy，不加豁免。
版本出处为既有W2-12转换器；独立锁新增311行，根锁和依赖声明均未修改。

首次构建前核可用缓存；缺缓存须先记录并由调度明确依赖准备方案，不自动联网取包。
容器运行时始终无网络、无密钥，只解析调用端已下载的相对任务文件。

2026-10-11实际核对37个冻结包及pnpm10.34.5的npm官方元数据、SRI与发布时间，
最短发布年龄14.223天，全部满足10080分钟（7天）。host平台选择实际缓存28包，
包含闭包内额外musl分支；Linux arm64镜像安装27包，全部reused、downloaded0。
portable缓存仅归档files/index，1492个内容文件逐SHA512/尺寸验证，不带projects符号链接，
不删除旧缓存。Corepack签名校验、release-age、trustPolicy和ignore-scripts原值保留。
固定依赖阶段已通过无网安装，实际canvas为Linux arm64 GNU分支；x64未实测。
原APT完整镜像默认构建通过；全镜像无网重建失败及调度裁定单独保留，未改旧APT指令。
