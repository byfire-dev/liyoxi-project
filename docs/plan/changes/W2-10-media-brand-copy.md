# W2-10 品牌素材复制前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | media callerTx 品牌复制owner和profile四项组合；首INSERT固定metadata，真实link/SLA/完整度与最终授权同事务 |
| 原因 | 补m02新增门店四项复制的所属域能力，保留旧三项入口 |
| 影响的包 | services media/profile；ops新增两份真实DB组合测试 |
| 类别 | 顺序 |
| PR | codex/w2-10-media-brand-copy；本地SOURCE，待验证及独立审查合流 |

按原端口读取真实门店事实；无HTTP、DDL、Provider IO或默认预算启用。
复制时零任务不等于永久零任务：保留pending/processing，后续I11仍按原15分钟边界汇合。
