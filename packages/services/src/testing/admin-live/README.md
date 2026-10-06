# 后台真实接口验收造数登记口

前端起栈脚本通过 `pnpm --filter @liyoxi/services admin:live:data --name lyx_test_admin_live_<随机标识> --test-redis-prefix lyx:test:admin_live_<随机标识>:` 启动服务端工具。真实接口造数只在此目录新增 `<工作包短名>.fixture.ts`，导出 default 异步函数，参数类型从 `./context.js` 引 `AdminLiveFixtureContext`。可用 `make` 工厂与 `runtime` 的服务端端口；返回值放入标准输出的 JSON `fixtures[文件短名]`，供浏览器用例读取。所有文件按名称排序并在同一进程依次执行，工厂序号不会重置；不修改前端起栈脚本或 Playwright 配置。

M1 登录链路用既有 seeded-db 与 staff:bootstrap 命令，目前不需要登记文件。工具不自动建库，不读 .env；环境及临时假密钥由前端起栈脚本提供。造数连接必须指向 --name 的测试库；库名与 Redis 前缀必须带同一本轮随机标识（1–32 位小写字母数字）。运行在 test 环境、假 Provider 上；不加载 Vitest。

清理用相同命令加 `--cleanup`，连接参数给本轮原管理连接；只删显式给出的 lyx_test_ 库和精确 admin_live 前缀，不删模板库、其他会话数据库或 Redis 键，不执行 FLUSHDB。先停止 API/预览进程再清理。测试密钥与激活码文件均由起栈脚本在临时目录管理，禁止提交。
