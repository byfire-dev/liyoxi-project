# V12 授权书 PDF

| 项 | 内容 |
| --- | --- |
| 编号 | V12 |
| 来源 | [计划](../../08-development-plan.md) 第 8.6 节表一、第 7.4 节 X-03；[05](../../05-risks-and-open-issues.md) 第 5 节 V12；[D6](../../appendix/design/d6-notify-docs-data.md) 第 12 节 PoC 第 4 项 |
| 验证什么 | @react-pdf/renderer 用真实授权书长文本的中文换行与分页（用打进镜像的静态中文字体）；签名后的 PDF 在主流阅读器与小程序里的表现 |
| 通过标准 | 正常 |
| 依赖的业主事项 | 渲染部分无。签名后表现要 E11（机构数字证书） |
| 谁来做 | X-03（渲染，结论入 ADR）；G5-B（签名） |
| 最晚关闭点 | M5 授权书包合并前；签名后表现 M8 进入前。X-03 是 M5 授权书包的进入条件 |
| 不通过的退路 | 模板 PDF 贴字 |
| 状态 | 进行中 |
| 结论 | 渲染部分（X-03）：技术核对通过，不走贴字退路；待业主看样（任务书 第 8 节七条）后定稿。字体用随镜像分发的 Noto Serif SC、Noto Sans SC 静态 TTF（与思源同源，SIL OFL 1.1），放 `infra/docker/server/fonts/`；换行不用 D6 第 3.5.3 节写的逐字回调（行尾会多出连字符），改用并段回调；字体没收的字（扩展 B 区以后的生僻字、表情符号）渲染前换成“〓”并记录。对 G5-B 的影响：照 ADR 的“决定”第 3–6 节实现，条款定稿后用真文本复测。签名后表现（G5-B）：未开始 |
| 证据 | [ADR](../../adr/draft-X-03-授权书PDF用react-pdf渲染-Noto静态TTF-并段换行.md)；样张与报告：`spikes/license-pdf/out/`（`short.pdf`、`long.pdf`、`extreme.pdf`、`report.json`、`report.container.json`）；命令输出见 X-03 的 PR 评论；渲染、用例、容器复跑三条另由 CI 的 `spike-license-pdf` 工作流重跑（不是必过检查），产物 `license-pdf-out` |
| 关闭日期 |  |

业主事项的状态见 [业主清单](../owner-checklist.md)。填写规则见 [README](README.md)。
