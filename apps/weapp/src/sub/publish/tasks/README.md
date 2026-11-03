# 发布生命周期页面

W6-09 在原发布任务页接入下架待办和发布清单复制；账号页接服务端允许的解绑，上线记录页展示实际巡检历史。所有写入仍经原请求层，页面切换门店、身份或筛选时废弃旧响应。

- 发布任务继续使用订单聚合分页；下架任务按 `pending`、`done` 各自保存游标、错误与分页结果。一个列表失败不会抹除另一个列表。已完成数取同一 `orderId` 筛选的两份服务端 summary。
- 下架只提交 `method`。按钮和方式来自 `actions` / `allowedMethods`；商家确认与后台核查分开显示，响应回放后重新读公开列表。
- 发布清单只复制正式 GET 返回的 `text`，无文本或剪贴板失败时提示失败，无确认接收接口。
- 解绑使用空请求体和原意图键；关联仍在使用时保留卡片和服务端原因。拒绝后撤销勾选，读回期间或当前账号不再允许解绑时禁用确认，不继续使用打开 Sheet 时的旧 actions。巡检空、失败与已恢复分别显示，不把缺失记录当作正常。

定点检查（单 worker，原时间预算）：

```sh
pnpm --filter @liyoxi/weapp exec vitest run src/sub/publish/tasks src/sub/publish/accounts src/sub/order/launch-record --maxWorkers=1 --no-file-parallelism
pnpm --filter @liyoxi/weapp typecheck
```

离线截图沿 `pnpm weapp:shots -- --scene <name>`：`tasks-takedown`、`tasks-takedown-confirm`、`tasks-takedown-empty`、`tasks-copy`、`tasks-copy-unavailable`、`record-default`、`record-patrol-recovered`、`record-patrol-error`、`accounts-unbind-rejected`。确认和拒绝场景另存 Sheet 截图。截图仅验证页面与请求，不代替微信真机剪贴板、订阅和平台实际下架验收。
