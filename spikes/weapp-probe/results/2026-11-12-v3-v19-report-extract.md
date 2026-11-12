# V19 与 V3 真机汇总摘录

以下行按原始脱敏 real 导出保留。两次导出覆盖相互重叠的时间，不累加。

## V19（11 月 5 日补测后）

原件 `2026-11-05-summary-173119.md`，SHA-256 `864dac70f6bf68cdafeb2b01d7aafc5d58d55f2d3e07fb9fdcea1fc20cbe4718`。

| 项 | 机型 | 系统 | 基础库 | 网络 | 场景 | 字节 | 落盘 | 尝试 | 成功 | 成功率 | 中位耗时 ms | 最大耗时 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V19 | CLS-AL00 | Android 12 | 3.17.6 | wifi | login | 0 | — | 12 | 12 | 100.0% | 1093.5 | 1629 |
| V19 | CLS-AL00 | Android 12 | 3.17.6 | wifi | quick_normal | 0 | — | 14 | 8 | 57.1% | 2643 | 8130 |
| V19 | CLS-AL00 | Android 12 | 3.17.6 | wifi | realtime_normal | 0 | — | 6 | 2 | 33.3% | 33152.5 | 198280 |
| V19 | CLS-AL00 | Android 12 | 3.17.6 | wifi | realtime_second_wechat_same_phone | 0 | — | 2 | 2 | 100.0% | 20241.5 | 25730 |
| V19 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | login | 0 | — | 10 | 10 | 100.0% | 1111 | 4310 |
| V19 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | quick_normal | 0 | — | 14 | 8 | 57.1% | 2705 | 10438 |
| V19 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | realtime_normal | 0 | — | 4 | 1 | 25.0% | 8315 | 248964 |
| V19 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | realtime_second_wechat_same_phone | 0 | — | 1 | 1 | 100.0% | 20495 | 20495 |
| V19 | 有尝试，待业主判定 | 添加其他号码交互/数量、换微信同号、体验是否可接受 |

## V3（11 月 7 日存档）

原件 `2026-11-07-summary-005047.md`，SHA-256 `24c608b32a020a24ae2847439f38f2525c0ec8888c7e316dd8eafdfa2f5308e5`。

按实际文件字节和场景保留全部 V3 分组。原明细共有 107 次：48 成功、38 失败、15 取消、6 中断。

| 项 | 机型 | 系统 | 基础库 | 网络 | 场景 | 字节 | 落盘 | 尝试 | 成功 | 成功率 | 中位耗时 ms | 最大耗时 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | background_resume | 38943475 | — | 1 | 1 | 100.0% | 8314 | 8314 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | background_resume | 81157543 | — | 1 | 1 | 100.0% | 16672 | 16672 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 0 | — | 1 | 0 | 0.0% | 4229 | 4229 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 139402394 | — | 1 | 0 | 0.0% | 2326 | 2326 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 1890456 | — | 1 | 1 | 100.0% | 1205 | 1205 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 24161795 | — | 1 | 0 | 0.0% | 476 | 476 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 24894058 | — | 1 | 1 | 100.0% | 6785 | 6785 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 278638740 | — | 1 | 1 | 100.0% | 54653 | 54653 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 38943475 | — | 1 | 1 | 100.0% | 10514 | 10514 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 4197440 | — | 1 | 1 | 100.0% | 2032 | 2032 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 47575856 | — | 1 | 1 | 100.0% | 12542 | 12542 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 73558178 | — | 1 | 1 | 100.0% | 17320 | 17320 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 8019759 | — | 1 | 1 | 100.0% | 3172 | 3172 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 81157543 | — | 1 | 1 | 100.0% | 17179 | 17179 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 8377398 | — | 1 | 1 | 100.0% | 4680 | 4680 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 89756135 | — | 1 | 1 | 100.0% | 17842 | 17842 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | process_reselect | 0 | — | 5 | 0 | 0.0% | 3748 | 5666 |
| V3 | CLS-AL00 | Android 12 | 3.17.6 | wifi | process_reselect | 66411586 | — | 2 | 1 | 50.0% | 13156 | 13591 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | background_resume | 0 | — | 2 | 0 | 0.0% | 19805.5 | 29648 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | background_resume | 145043948 | — | 1 | 1 | 100.0% | 55823 | 55823 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | background_resume | 246981295 | — | 2 | 2 | 100.0% | 74997.5 | 75737 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | background_resume | 404480 | — | 2 | 0 | 0.0% | 1192.5 | 1840 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | background_resume | 509154114 | — | 1 | 0 | 0.0% | 485 | 485 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | background_resume | 63150616 | — | 1 | 1 | 100.0% | 16131 | 16131 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | background_resume | 78719237 | — | 1 | 1 | 100.0% | 18743 | 18743 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | background_resume | 8175145 | — | 1 | 1 | 100.0% | 3951 | 3951 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | background_resume | 8612123 | — | 1 | 1 | 100.0% | 4910 | 4910 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 0 | — | 14 | 0 | 0.0% | 4809 | 20483 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 10429249 | — | 1 | 1 | 100.0% | 4352 | 4352 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 10510741 | — | 1 | 0 | 0.0% | 542 | 542 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 124272889 | — | 2 | 2 | 100.0% | 29350.5 | 30614 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 145043948 | — | 1 | 0 | 0.0% | 26083 | 26083 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 159231085 | — | 1 | 0 | 0.0% | 1606 | 1606 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 16310691 | — | 1 | 0 | 0.0% | 530 | 530 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 172731717 | — | 1 | 1 | 100.0% | 44709 | 44709 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 185382414 | — | 1 | 0 | 0.0% | 1619 | 1619 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 20430401 | — | 1 | 1 | 100.0% | 5840 | 5840 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 20444118 | — | 1 | 1 | 100.0% | 7674 | 7674 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 215921850 | — | 1 | 0 | 0.0% | 55333 | 55333 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 23006475 | — | 2 | 2 | 100.0% | 7326 | 8641 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 246981295 | — | 1 | 1 | 100.0% | 55420 | 55420 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 249452965 | — | 1 | 0 | 0.0% | 1948 | 1948 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 317799354 | — | 1 | 0 | 0.0% | 781 | 781 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 331982638 | — | 1 | 0 | 0.0% | 74303 | 74303 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 40348599 | — | 1 | 0 | 0.0% | 388 | 388 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 404480 | — | 11 | 3 | 27.3% | 1384 | 3720 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 436039300 | — | 1 | 1 | 100.0% | 127302 | 127302 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 44239455 | — | 1 | 1 | 100.0% | 11220 | 11220 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 509154114 | — | 1 | 0 | 0.0% | 420 | 420 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 63150616 | — | 2 | 2 | 100.0% | 17009 | 18622 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 6517328 | — | 1 | 0 | 0.0% | 309 | 309 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 8175145 | — | 5 | 3 | 60.0% | 6209 | 19107 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 83372718 | — | 1 | 1 | 100.0% | 22870 | 22870 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 8612123 | — | 1 | 1 | 100.0% | 3478 | 3478 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 876703119 | — | 3 | 0 | 0.0% | 590 | 839 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 92685972 | — | 2 | 2 | 100.0% | 21146 | 21438 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 93746455 | — | 1 | 1 | 100.0% | 22684 | 22684 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | process_reselect | 0 | — | 1 | 0 | 0.0% | 1700 | 1700 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | process_reselect | 246981295 | — | 3 | 1 | 33.3% | 22086 | 58339 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | process_reselect | 317799354 | — | 2 | 1 | 50.0% | 59322.5 | 75325 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | process_reselect | 63150616 | — | 1 | 0 | 0.0% | 12384 | 12384 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | process_reselect | 8612123 | — | 1 | 1 | 100.0% | 3959 | 3959 |
| V3 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | process_reselect | 93746455 | — | 1 | 0 | 0.0% | 12845 | 12845 |
| V3 | 有尝试，待业主判定 | 未压缩续传分块交集、压缩匹配、实际120秒超时 |

### 两次分块复用的成功回传

| 时间 UTC | 项 | 场景 | 结果 | 错误码 | 阶段（phase） | runId / 序号 | 已完成块 / 总块 | 本次发块 / 重传已完成块 | 机型 | 系统 / 基础库 / 网络 | 字节 / 落盘 | 本次总耗时 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-06T02:40:38.466Z | V3 | process_reselect | success |  | parts_observed | mw4da9zb-huc3q0hbsw / — | 4 / 16 | 12 / 0 | CLS-AL00 | Android 12 / 3.17.6 / wifi | 66411586 / — | 12721 |
| 2026-11-06T02:56:00.886Z | V3 | process_reselect | success |  | parts_observed | mw4dtfg7-5vhbp35k6p / — | 53 / 76 | 23 / 0 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 317799354 / — | 43320 |
