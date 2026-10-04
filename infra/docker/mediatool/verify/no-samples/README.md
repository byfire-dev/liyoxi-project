# 空目录占位

没有业主给的样片时，`compose.verify.yml` 把这个目录挂到造片容器的 `/samples`。里面不放任何片子。

样片放在仓库之外的 `~/.lyx/samples/x02/`（X-02 任务书 第 8 节），`verify/run.mjs` 看到那个目录就改挂它。
