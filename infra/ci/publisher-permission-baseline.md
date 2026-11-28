# 发布专员成片推送权限基线前置

本 PR 独立审阅 `fixtures/admin-permission-matrix-publisher.txt`。完整矩阵由 #313 的候选源码通过 `LYX_UPDATE_GOLDEN=1 pnpm exec vitest run --project api apps/api/test/admin-matrix.test.ts --maxWorkers=1 --no-file-parallelism` 生成，未手改。

与当前 `apps/api/golden/admin-permission-matrix.txt` 仅一行不同：`admin.deliveryTicket.pushPackage` 的模块要求由 `delivery:edit` 改为 `publish:edit`，发布专员普通/主管两格由拒绝改为允许。动作仍要求 `publish.package.push`，其余角色、接口与权限格逐字不变。依据是发布专员已有 `publish:o` 与该动作权限，但此前错误的前置模块使本人任务不能推送；#313 同时传递本人任务范围，并验证他人任务 404、剪辑师 403、缺授权书 409 与幂等重放。

这是独立 `gate-change` 前置，尚不改变运行代码或当前回放。业务 #313 同步本 PR 后，将回放唯一黄金路径切到本文件；不接受新旧二选一，不跳过目标路由，不修改角色配置。旧矩阵保持原字节，作为切换前的历史基线，业务合流后不再参与比较或重生成；后续矩阵统一由原命令更新本文件。

独立前置阶段当前黄金与当前代码一致；业务合流后，新黄金与新代码逐字比较，并对所有后台路由逐角色实际回放。该顺序让每次主干合流均可完整验证。
