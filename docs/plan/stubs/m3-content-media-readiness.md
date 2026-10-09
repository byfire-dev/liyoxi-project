# 原片与预告片就绪

| 项 | 内容 |
| --- | --- |
| 状态 | 已回补 |
| 留桩内容 | L10 原片检查与 L6 预告片检查 |
| 骨架里的做法 | content/checks.ts 的 mediaReadiness：原片按已就绪；预告片按未就绪，开关关闭为提示、打开为阻断；剧集行数仍真实检查 |
| 登记的工作包 | W1-13 |
| 回补里程碑 | M3，G3-A / G3-B |
| 回补的工作包 | W3-09；换用 media.dramaMediaReadiness |
| 依据 | 任务书 W1-13 第 7、10 节；05 分组第 2、5 节 |

W3-09 改用真实当前母版、检查 gate、封面/预告片与在途批次事实。
`content/readiness.db.test.ts`、`lifecycle.db.test.ts` 和 `subscribers.db.test.ts` 覆盖缺集、blocked、失败/迟到 target 与锁内上架复核；完整 content 目录 41 项本地通过。
该回补不代表真实云、法务权利核验或 120 次实际媒体探针通过；本包最终门禁和独立审查仍进行中。
