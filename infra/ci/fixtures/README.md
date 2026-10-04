# 预设的最小工程

`packages/config/tsconfig/` 下五份预设各有一个最小工程，各自 `extends` 一份预设，由根脚本 `pnpm typecheck` 逐个跑 `tsc --noEmit`。
预设写坏了（选项拼错、互相冲突、要靠没装的包），在这里先红。

| 目录 | 预设 | 验什么 |
| --- | --- | --- |
| `base/` | `base.json` | 严格模式、下标访问带 `undefined`、Node 类型 |
| `node-lib/` | `node-lib.json` | NodeNext 解析（相对导入带 `.js` 后缀）、默认的 `include` |
| `node-app/` | `node-app.json` | 同上，外加进程入口常用的 Node 接口 |
| `web-react19/` | `web-react19.json` | Bundler 解析（相对导入不带后缀）、DOM 类型 |
| `taro-react18/` | `taro-react18.json` | Bundler 解析、允许 JS、DOM 类型之外不带任何全局类型 |

两个前端工程不含 JSX：JSX 的类型要靠 `@types/react`，由用预设的应用自己装（W0-27a、W0-28）。
