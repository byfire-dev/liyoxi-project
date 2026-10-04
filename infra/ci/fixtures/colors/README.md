# “页面不写色值”检查的夹具

给 `infra/ci/check-colors.mjs`（`pnpm lint:colors`）用，由 `infra/ci/test/colors.test.ts` 用 `--root` 指进来跑。两棵树各自带一份 `apps/`：

| 目录 | 内容 | 期望 |
| --- | --- | --- |
| `bad/` | 四个页面文件各写一处色值：`.scss` 写十六进制、`.tsx` 写 `rgb()`、`.css` 写 `rgba()`、`.ts` 写 `hsl()` | 检查失败，逐个指出文件与行 |
| `allowed/` | 生成物（在 `generated/` 目录下、第一行带“生成物，勿手改”文件头）里的色值；白名单（`allowed/colors-allowlist.txt`）列出的组件文件里的色值；只在注释里出现的色值；用样式变量的页面 | 检查通过 |

`bad/` 同时是门禁自测的反例：“页面夹具写色值”这一条。门禁自测的框架（`pnpm gates:selftest`）由 W0-03 提供，它合并后把这个反例登记进去；在那之前由上面的用例在 `pnpm test` 里断言。

这里的文件只给检查脚本读，不参与构建、不被页面引用。
