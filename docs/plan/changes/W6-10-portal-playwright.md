# W6-10 portal 浏览器工具声明独立前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 独立补apps/portal开发依赖`@playwright/test: 1.63.0`，由官方pnpm生成portal importer锁记录并复用已有包/快照；任务第6节明确唯一允许项，新README说明工具与业务交付边界。 |
| 原因 | 原任务已要求portal自己的真实HTTPS Cookie浏览器验收，但本应用未声明Playwright；admin/weapp已有同版依赖不能跨应用借用。按原第6节的依赖缺口独立可审变更办理。 |
| 影响的包 | 仅W6-10工具声明；后续config/spec/CLI消费等本前置actual main。业务任务DAG、编号、规模/级别、API/页/x01/桩归属与计数均不变，不放行未满足前置的安全壳或真实扫码源码。 |
| 类别 | 拆并 |
| PR | #282 |

基线为actual main `72ffab266`。本PR仅将工具声明独立交付，不消费未合分支或在途拆分文档，不改变原任务第3节的业务前置；后续业务实施仍须核实际main上的任务与逐片条件。

manifest只新增上述精确devDependency，现有scripts、生产依赖及所有既有版本保持。锁文件由官方pnpm生成，实际只增`apps/portal` importer的三行；未手改锁，未增加包版本或改其他importer、packages、snapshots与安装策略。门禁分类以最终差异为准。

本工具前置不新增Playwright配置、runner、测试或生产入口，不启动/安装浏览器，不标页面或业务完成。工具可解析与原骨架检查通过不等于真实HTTPS链或V8通过；不改变X-01/V8、M6退出和原测试预算。

本地验收：首次离线生成缺少既有playwright元数据，沿原registry正常联网生成后成功；随后离线frozen安装通过。本应用CLI为1.63.0，portal类型、原App/pages四项测试、生产构建及既有产物检查、格式与台账单项检查全部通过。唯一独审无阻断，正常提交钩子通过，门禁分类为1项只增、0放松；当前提交required与实际合入仍按原流程办理。
