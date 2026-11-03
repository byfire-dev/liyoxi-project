# 电脑端下载页

当前仍是既有骨架，页面实现状态保持原登记。`test`、`typecheck`、`build`沿现有脚本。

开发工具`@playwright/test`固定为`1.63.0`，由本应用声明并经自己的pnpm入口使用，不借用admin/weapp的依赖或配置。此工具前置仅补声明；Playwright配置、`e2e:live`及真实HTTPS Cookie验收入口由W6-10后续按实际main任务与依赖交付，当前尚不存在。

工具声明不表示安全壳、扫码登录或浏览器链已实现/验收，不改变X-01/V8及M6退出条件。
