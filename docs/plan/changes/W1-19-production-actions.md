# W1-19 制作表单的服务端操作提示

| 项 | 内容 |
| --- | --- |
| 改了什么 | 独立修复交付详情与方案 GET 的既有 actions：新增 sample-create、episode-register、inspect-episodes、inspect-package、draft-replace 五个表单入口。 |
| 原因 | W1-19 PR2 实作发现已落地的五个写操作缺少 GET 操作提示；前端需按服务端事实显示入口，不能自己推断状态与权限。 |
| 影响的包 | packages/services 的 delivery 视图和新回归测试；W1-19 页面仅在本修复实际合并后消费。既有契约 actions 是字符串数组，不改契约、数据库、权限配置或写用例。 |
| 类别 | 甲类权限投影修复；仅新增入口提示。模块编辑等级、权限点、工单暂停、制作步骤、编辑归属与 deliveredAt 为入口事实；请求体、媒体探测、四眼质检、版本与锁内守卫仍由实际写用例最终检查。 |
| PR | 调度开 PR 后在描述和合并记录关联。 |

调度按 CLAUDE 第3节第6步与第7节批准独立服务修复，避免页面包夹带服务生产代码。原有 assign-manager、push、push-package 提示保持原行为；不扩大读取范围，不新增权限，不放松测试或门禁。整个 W1-19 仍待页面 PR2 收口。
