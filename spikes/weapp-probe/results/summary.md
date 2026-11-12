# X-01 真机尝试汇总

生成于 2026-11-06T16:50:47.879Z；模式 real；541 条。

本表仅是观测数据，不自动宣告通过。fake 不是真机证据；调试模式 V3/V7 只算初测。成功率分母包含失败、取消和中断；恢复成功是另一次尝试。缺数据仍记“未实测”。

| 项 | 机型 | 系统 | 基础库 | 网络 | 场景 | 字节 | 落盘 | 尝试 | 成功 | 成功率 | 中位耗时 ms | 最大耗时 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V19 | CLS-AL00 | Android 12 | 3.17.6 | wifi | login | 0 | — | 20 | 19 | 95.0% | 1227 | 11193 |
| V19 | CLS-AL00 | Android 12 | 3.17.6 | wifi | quick_normal | 0 | — | 14 | 8 | 57.1% | 2643 | 8130 |
| V19 | CLS-AL00 | Android 12 | 3.17.6 | wifi | realtime_normal | 0 | — | 7 | 3 | 42.9% | 31595 | 198280 |
| V19 | CLS-AL00 | Android 12 | 3.17.6 | wifi | realtime_second_wechat_same_phone | 0 | — | 2 | 2 | 100.0% | 20241.5 | 25730 |
| V19 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | login | 0 | — | 29 | 29 | 100.0% | 1033 | 4310 |
| V19 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | quick_normal | 0 | — | 14 | 8 | 57.1% | 2705 | 10438 |
| V19 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | realtime_normal | 0 | — | 4 | 1 | 25.0% | 8315 | 248964 |
| V19 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | realtime_second_wechat_same_phone | 0 | — | 1 | 1 | 100.0% | 20495 | 20495 |
| V19 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.18.0 | wifi | login | 0 | — | 1 | 1 | 100.0% | 3995 | 3995 |
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
| V7 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 100000000 | user_dir | 1 | 1 | 100.0% | 11448 | 11448 |
| V7 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 150000000 | temp | 1 | 0 | 0.0% | 18136 | 18136 |
| V7 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 150000000 | user_dir | 1 | 1 | 100.0% | 342672 | 342672 |
| V7 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 200000000 | user_dir | 5 | 1 | 20.0% | 37676 | 271711 |
| V7 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 30000000 | temp | 15 | 0 | 0.0% | 2105 | 52658 |
| V7 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 30000000 | user_dir | 6 | 2 | 33.3% | 1275.5 | 15985 |
| V7 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 50000000 | temp | 1 | 0 | 0.0% | 6838 | 6838 |
| V7 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 50000000 | user_dir | 7 | 4 | 57.1% | 15412 | 35128 |
| V7 | CLS-AL00 | Android 12 | 3.17.6 | wifi | baseline | 60000000 | user_dir | 1 | 1 | 100.0% | 7474 | 7474 |
| V7 | CLS-AL00 | Android 12 | 3.17.6 | wifi | continuous_80 | 50000000 | user_dir | 80 | 4 | 5.0% | 7878.5 | 70414 |
| V7 | CLS-AL00 | Android 12 | 3.17.6 | wifi | diagnostic_8 | 50000000 | user_dir | 6 | 4 | 66.7% | 9450 | 22554 |
| V7 | CLS-AL00 | Android 12 | 3.17.6 | wifi | diagnostic_serial_8 | 50000000 | user_dir | 5 | 4 | 80.0% | 8041 | 74224 |
| V7 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 100000000 | temp | 2 | 0 | 0.0% | 11526.5 | 12069 |
| V7 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 100000000 | user_dir | 1 | 1 | 100.0% | 11598 | 11598 |
| V7 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 150000000 | temp | 2 | 0 | 0.0% | 17773 | 17778 |
| V7 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 150000000 | user_dir | 1 | 1 | 100.0% | 17106 | 17106 |
| V7 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 200000000 | temp | 2 | 0 | 0.0% | 30394.5 | 32276 |
| V7 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 200000000 | user_dir | 1 | 1 | 100.0% | 28273 | 28273 |
| V7 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 30000000 | temp | 13 | 0 | 0.0% | 5324 | 30240 |
| V7 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 30000000 | user_dir | 2 | 1 | 50.0% | 23806.5 | 30036 |
| V7 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 60000000 | temp | 3 | 0 | 0.0% | 7602 | 13852 |
| V7 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | baseline | 60000000 | user_dir | 1 | 1 | 100.0% | 6851 | 6851 |
| V7 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | continuous_80 | 50000000 | temp | 2 | 0 | 0.0% | 256710 | 398887 |
| V7 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.18.0 | wifi | baseline | 30000000 | temp | 4 | 0 | 0.0% | 70928 | 101427 |
| V7 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.18.0 | wifi | baseline | 30000000 | user_dir | 2 | 2 | 100.0% | 79635 | 109041 |
| V7 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.18.0 | wifi | continuous_80 | 50000000 | temp | 7 | 0 | 0.0% | 219507 | 3330676 |
| V8 | CLS-AL00 | Android 12 | 3.17.6 | wifi | manual_code | 0 | — | 10 | 6 | 60.0% | 1450.5 | 2144 |
| V8 | CLS-AL00 | Android 12 | 3.17.6 | wifi | scan_bright | 0 | — | 15 | 13 | 86.7% | 2702 | 4187 |
| V8 | CLS-AL00 | Android 12 | 3.17.6 | wifi | scan_dim | 0 | — | 28 | 24 | 85.7% | 2630.5 | 5668 |
| V8 | CLS-AL00 | Android 12 | 3.17.6 | wifi | scan_normal | 0 | — | 22 | 17 | 77.3% | 2478.5 | 5773 |
| V8 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | manual_code | 0 | — | 17 | 5 | 29.4% | 249 | 2023 |
| V8 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | scan_bright | 0 | — | 21 | 17 | 81.0% | 2252 | 4113 |
| V8 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | scan_dim | 0 | — | 21 | 18 | 85.7% | 2171 | 3802 |
| V8 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 | 3.17.6 | wifi | scan_normal | 0 | — | 36 | 32 | 88.9% | 2618 | 5163 |

## 尝试明细（已脱敏）

旧版 downloading 阶段同时包含下载和本地文件校验，不能追认为新版 file_check；缺少阶段的旧记录显示 unknown，不按结果推断。
本次总耗时来自原尝试记录，可能包含获取地址与清理等步骤，不等于纯下载耗时；收件时间也不是操作开始时间。

| 时间 UTC | 项 | 场景 | 结果 | 错误码 | 阶段（phase） | runId / 序号 | 已完成块 / 总块 | 本次发块 / 重传已完成块 | 机型 | 系统 / 基础库 / 网络 | 字节 / 落盘 | 本次总耗时 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-11-05T07:01:13.697Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 4310 |
| 2026-11-05T07:01:43.730Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 742 |
| 2026-11-05T07:01:50.508Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 4881 |
| 2026-11-05T07:02:46.946Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2934 |
| 2026-11-05T07:05:25.891Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1127 |
| 2026-11-05T07:05:30.117Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2719 |
| 2026-11-05T07:06:20.796Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 5163 |
| 2026-11-05T07:07:40.358Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2882 |
| 2026-11-05T07:07:49.065Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2598 |
| 2026-11-05T07:08:08.397Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2933 |
| 2026-11-05T07:08:24.287Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2356 |
| 2026-11-05T07:08:30.806Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 3059 |
| 2026-11-05T07:08:38.429Z | V8 | scan_normal | failure | PAIR_MISMATCH | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2762 |
| 2026-11-05T07:08:44.466Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2074 |
| 2026-11-05T07:08:53.700Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 3098 |
| 2026-11-05T07:08:59.935Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2900 |
| 2026-11-05T07:09:04.756Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2155 |
| 2026-11-05T07:09:06.513Z | V8 | scan_normal | failure | TICKET_CLOSED | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 817 |
| 2026-11-05T07:09:11.998Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1968 |
| 2026-11-05T07:09:16.703Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2603 |
| 2026-11-05T07:09:29.220Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2278 |
| 2026-11-05T07:09:45.348Z | V8 | scan_dim | failure | TICKET_CLOSED | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 999 |
| 2026-11-05T07:09:51.181Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1985 |
| 2026-11-05T07:09:58.028Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 3167 |
| 2026-11-05T07:10:02.203Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1900 |
| 2026-11-05T07:10:06.301Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1741 |
| 2026-11-05T07:10:10.659Z | V8 | scan_dim | failure | PAIR_MISMATCH | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2171 |
| 2026-11-05T07:10:14.289Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2453 |
| 2026-11-05T07:10:18.665Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1894 |
| 2026-11-05T07:10:24.888Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2375 |
| 2026-11-05T07:10:30.154Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2215 |
| 2026-11-05T07:10:33.721Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1582 |
| 2026-11-05T07:10:36.833Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1513 |
| 2026-11-05T07:10:39.847Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1653 |
| 2026-11-05T07:11:03.605Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2672 |
| 2026-11-05T07:11:08.206Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2284 |
| 2026-11-05T07:11:11.216Z | V8 | scan_normal | failure | TICKET_CLOSED | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 812 |
| 2026-11-05T07:11:15.408Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1689 |
| 2026-11-05T07:11:19.564Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2633 |
| 2026-11-05T07:11:23.883Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2867 |
| 2026-11-05T07:11:26.876Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1661 |
| 2026-11-05T07:11:30.582Z | V8 | scan_normal | failure | PAIR_MISMATCH | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2001 |
| 2026-11-05T07:11:33.130Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1521 |
| 2026-11-05T07:11:36.787Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1671 |
| 2026-11-05T07:11:49.965Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2252 |
| 2026-11-05T07:11:53.199Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1571 |
| 2026-11-05T07:11:56.493Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1689 |
| 2026-11-05T07:12:02.025Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2889 |
| 2026-11-05T07:12:10.008Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1671 |
| 2026-11-05T07:12:14.004Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1639 |
| 2026-11-05T07:12:16.733Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1584 |
| 2026-11-05T07:12:21.169Z | V8 | scan_bright | failure | PAIR_MISMATCH | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2908 |
| 2026-11-05T07:12:25.379Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1480 |
| 2026-11-05T07:12:29.655Z | V8 | scan_bright | failure | TICKET_CLOSED | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 790 |
| 2026-11-05T07:12:35.510Z | V8 | scan_bright | failure | PAIR_MISMATCH | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 4113 |
| 2026-11-05T07:12:36.250Z | V8 | manual_code | failure | SHORT_CODE_INVALID | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 33 |
| 2026-11-05T07:12:38.956Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1827 |
| 2026-11-05T07:12:50.623Z | V8 | manual_code | failure | SHORT_CODE_INVALID | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 179 |
| 2026-11-05T07:13:15.235Z | V8 | manual_code | failure | SHORT_CODE_INVALID | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 48 |
| 2026-11-05T07:13:36.687Z | V8 | manual_code | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2023 |
| 2026-11-05T07:14:05.372Z | V8 | manual_code | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1301 |
| 2026-11-05T07:14:26.064Z | V8 | manual_code | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1772 |
| 2026-11-05T07:14:41.247Z | V8 | manual_code | failure | TICKET_CLOSED | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 359 |
| 2026-11-05T07:14:46.580Z | V8 | manual_code | failure | TICKET_CLOSED | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 210 |
| 2026-11-05T07:15:04.953Z | V8 | manual_code | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1098 |
| 2026-11-05T07:15:32.538Z | V8 | manual_code | failure | PAIR_MISMATCH | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1630 |
| 2026-11-05T07:15:35.336Z | V8 | manual_code | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1206 |
| 2026-11-05T07:18:04.020Z | V8 | manual_code | failure | SHORT_CODE_INVALID | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 100 |
| 2026-11-05T07:18:05.491Z | V8 | manual_code | failure | SHORT_CODE_INVALID | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 18 |
| 2026-11-05T07:18:20.143Z | V8 | manual_code | failure | TICKET_EXPIRED | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 89 |
| 2026-11-05T07:18:23.907Z | V8 | manual_code | failure | TICKET_EXPIRED | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 249 |
| 2026-11-05T07:20:33.967Z | V8 | manual_code | failure | TICKET_EXPIRED | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1080 |
| 2026-11-05T07:20:41.286Z | V8 | scan_bright | failure | TICKET_EXPIRED | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 864 |
| 2026-11-05T07:20:46.811Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2458 |
| 2026-11-05T07:24:58.416Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1336 |
| 2026-11-05T07:25:04.816Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2843 |
| 2026-11-05T07:26:25.880Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 5773 |
| 2026-11-05T07:26:33.647Z | V8 | scan_bright | failure | TICKET_CLOSED | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1178 |
| 2026-11-05T07:26:41.336Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 3393 |
| 2026-11-05T07:26:49.068Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 3113 |
| 2026-11-05T07:26:56.506Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2745 |
| 2026-11-05T07:27:01.473Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2657 |
| 2026-11-05T07:27:07.528Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2161 |
| 2026-11-05T07:27:12.696Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2702 |
| 2026-11-05T07:27:17.015Z | V8 | scan_bright | failure | PAIR_MISMATCH | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1885 |
| 2026-11-05T07:27:20.777Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2672 |
| 2026-11-05T07:27:34.019Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2949 |
| 2026-11-05T07:27:38.548Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2376 |
| 2026-11-05T07:27:43.327Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2180 |
| 2026-11-05T07:27:50.134Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2637 |
| 2026-11-05T07:27:55.684Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2319 |
| 2026-11-05T07:28:00.747Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2585 |
| 2026-11-05T07:28:05.026Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1764 |
| 2026-11-05T07:28:09.420Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2276 |
| 2026-11-05T07:28:13.751Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2090 |
| 2026-11-05T07:28:20.187Z | V8 | scan_dim | failure | PAIR_MISMATCH | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2624 |
| 2026-11-05T07:28:25.327Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2736 |
| 2026-11-05T07:28:30.049Z | V8 | scan_dim | failure | PAIR_MISMATCH | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2063 |
| 2026-11-05T07:28:33.366Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2652 |
| 2026-11-05T07:28:44.239Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2510 |
| 2026-11-05T07:28:49.984Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2084 |
| 2026-11-05T07:28:53.812Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2113 |
| 2026-11-05T07:28:58.695Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2484 |
| 2026-11-05T07:29:04.654Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2448 |
| 2026-11-05T07:29:10.426Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 3054 |
| 2026-11-05T07:29:16.841Z | V8 | scan_normal | failure | PAIR_MISMATCH | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2927 |
| 2026-11-05T07:29:20.128Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2052 |
| 2026-11-05T07:29:24.630Z | V8 | manual_code | failure | SHORT_CODE_INVALID | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 23 |
| 2026-11-05T07:29:43.457Z | V8 | manual_code | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1876 |
| 2026-11-05T07:30:05.461Z | V8 | manual_code | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1338 |
| 2026-11-05T07:30:21.792Z | V8 | manual_code | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1107 |
| 2026-11-05T07:30:40.034Z | V8 | manual_code | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1035 |
| 2026-11-05T07:30:58.078Z | V8 | manual_code | failure | PAIR_MISMATCH | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1611 |
| 2026-11-05T07:31:00.544Z | V8 | manual_code | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1335 |
| 2026-11-05T07:33:49.746Z | V8 | manual_code | failure | TICKET_EXPIRED | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1563 |
| 2026-11-05T07:33:56.306Z | V8 | manual_code | failure | TICKET_EXPIRED | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1732 |
| 2026-11-05T07:34:04.260Z | V8 | manual_code | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2144 |
| 2026-11-05T07:40:29.311Z | V3 | baseline | failure | PLATFORM_ERROR | parts_unobserved | mw38k9bi-pjl44jdfbe / — | — / 34 | 0 / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 139402394 / — | 2326 |
| 2026-11-05T07:42:12.794Z | V3 | baseline | cancelled | CANCELLED | choose_file | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 4229 |
| 2026-11-05T07:43:06.073Z | V3 | baseline | failure | PLATFORM_ERROR | parts_unobserved | mw38no9k-g8yvelrwn9 / — | — / 6 | 0 / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 24161795 / — | 476 |
| 2026-11-05T07:57:13.792Z | V8 | scan_normal | failure | TICKET_EXPIRED | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1474 |
| 2026-11-05T07:57:17.137Z | V8 | scan_normal | failure | TICKET_EXPIRED | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1404 |
| 2026-11-05T07:57:24.275Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 991 |
| 2026-11-05T07:57:29.960Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2978 |
| 2026-11-05T07:57:35.056Z | V8 | scan_normal | failure | TICKET_EXPIRED | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1040 |
| 2026-11-05T07:57:43.000Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 3253 |
| 2026-11-05T07:57:47.787Z | V8 | scan_normal | failure | TICKET_CLOSED | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 937 |
| 2026-11-05T07:57:53.400Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2473 |
| 2026-11-05T08:03:25.551Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1211 |
| 2026-11-05T08:03:29.977Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 3183 |
| 2026-11-05T08:03:39.465Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2286 |
| 2026-11-05T08:28:59.041Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1092 |
| 2026-11-05T08:29:02.929Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2674 |
| 2026-11-05T08:29:28.887Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 4187 |
| 2026-11-05T08:29:55.114Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2773 |
| 2026-11-05T08:30:05.287Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 3775 |
| 2026-11-05T08:31:00.352Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2475 |
| 2026-11-05T08:31:07.429Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 3393 |
| 2026-11-05T08:31:13.594Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2396 |
| 2026-11-05T08:32:19.714Z | V8 | scan_dim | failure | TICKET_CLOSED | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1341 |
| 2026-11-05T08:32:30.951Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2359 |
| 2026-11-05T08:32:39.514Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 3064 |
| 2026-11-05T08:32:45.599Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2852 |
| 2026-11-05T08:32:52.947Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2898 |
| 2026-11-05T08:32:59.937Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2516 |
| 2026-11-05T08:33:06.532Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 3153 |
| 2026-11-05T08:33:36.225Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2948 |
| 2026-11-05T08:33:41.340Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2291 |
| 2026-11-05T08:34:05.875Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 4627 |
| 2026-11-05T08:34:14.001Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 3392 |
| 2026-11-05T08:34:20.529Z | V8 | scan_dim | failure | PAIR_MISMATCH | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2855 |
| 2026-11-05T08:34:23.719Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1952 |
| 2026-11-05T08:34:30.476Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 3166 |
| 2026-11-05T08:34:55.368Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 5668 |
| 2026-11-05T08:35:02.518Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2499 |
| 2026-11-05T08:35:10.289Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 4618 |
| 2026-11-05T08:35:17.122Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2753 |
| 2026-11-05T08:35:39.693Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2622 |
| 2026-11-05T08:35:45.288Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2373 |
| 2026-11-05T08:35:50.628Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2853 |
| 2026-11-05T08:36:40.717Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1593 |
| 2026-11-05T08:36:44.250Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2601 |
| 2026-11-05T08:37:01.467Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2587 |
| 2026-11-05T08:37:04.580Z | V8 | manual_code | failure | SHORT_CODE_INVALID | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 39 |
| 2026-11-05T08:37:09.019Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 3739 |
| 2026-11-05T08:37:15.028Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2719 |
| 2026-11-05T08:37:21.708Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 4810 |
| 2026-11-05T08:37:29.002Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 3290 |
| 2026-11-05T08:37:54.491Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 3055 |
| 2026-11-05T08:38:00.890Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2641 |
| 2026-11-05T08:38:06.454Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2483 |
| 2026-11-05T08:38:11.533Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2228 |
| 2026-11-05T08:38:17.505Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2854 |
| 2026-11-05T08:39:12.454Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1095 |
| 2026-11-05T08:39:15.416Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2046 |
| 2026-11-05T08:39:24.475Z | V8 | scan_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 3841 |
| 2026-11-05T08:39:27.438Z | V8 | scan_dim | failure | TICKET_CLOSED | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 860 |
| 2026-11-05T08:39:32.571Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 3209 |
| 2026-11-05T08:39:37.344Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2381 |
| 2026-11-05T08:39:41.644Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2037 |
| 2026-11-05T08:39:48.195Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 3419 |
| 2026-11-05T08:39:55.118Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2419 |
| 2026-11-05T08:40:05.344Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 3802 |
| 2026-11-05T08:40:34.506Z | V8 | scan_dim | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2632 |
| 2026-11-05T08:40:55.873Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 3501 |
| 2026-11-05T08:41:02.937Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2412 |
| 2026-11-05T08:41:07.974Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2482 |
| 2026-11-05T08:41:12.724Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2078 |
| 2026-11-05T08:41:18.431Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2761 |
| 2026-11-05T08:41:23.875Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2864 |
| 2026-11-05T08:41:29.139Z | V8 | scan_bright | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2497 |
| 2026-11-05T08:50:23.611Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 912 |
| 2026-11-05T08:50:37.519Z | V19 | quick_normal | failure | WX_103 | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 10438 |
| 2026-11-05T08:51:13.272Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2636 |
| 2026-11-05T08:51:19.156Z | V19 | quick_normal | failure | WX_103 | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1817 |
| 2026-11-05T08:51:25.976Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2327 |
| 2026-11-05T08:51:31.102Z | V19 | quick_normal | failure | WX_103 | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2617 |
| 2026-11-05T08:52:07.028Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2691 |
| 2026-11-05T08:52:28.103Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1629 |
| 2026-11-05T08:52:31.740Z | V19 | quick_normal | failure | WX_103 | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2379 |
| 2026-11-05T08:52:47.013Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2424 |
| 2026-11-05T08:52:59.204Z | V19 | quick_normal | failure | WX_103 | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1836 |
| 2026-11-05T08:53:04.890Z | V19 | quick_normal | failure | WX_103 | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 5062 |
| 2026-11-05T08:53:18.236Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1243 |
| 2026-11-05T08:53:21.184Z | V19 | quick_normal | failure | WX_103 | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2207 |
| 2026-11-05T08:53:30.506Z | V19 | quick_normal | failure | WX_103 | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 8130 |
| 2026-11-05T08:53:34.960Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2612 |
| 2026-11-05T08:53:41.748Z | V19 | quick_normal | failure | WX_103 | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2034 |
| 2026-11-05T08:53:44.609Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2254 |
| 2026-11-05T08:54:33.141Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 922 |
| 2026-11-05T08:54:43.420Z | V19 | realtime_normal | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 5532 |
| 2026-11-05T08:55:57.030Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2700 |
| 2026-11-05T08:56:25.145Z | V19 | realtime_normal | failure | WX_103 | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 11098 |
| 2026-11-05T08:56:46.104Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 641 |
| 2026-11-05T08:57:21.588Z | V19 | realtime_second_wechat_same_phone | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 20495 |
| 2026-11-05T09:01:00.252Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 842 |
| 2026-11-05T09:04:25.148Z | V19 | realtime_normal | failure | WX_103 | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 198280 |
| 2026-11-05T09:04:43.619Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 964 |
| 2026-11-05T09:05:34.625Z | V19 | realtime_normal | failure | WX_103 | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 37999 |
| 2026-11-05T09:07:32.651Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1176 |
| 2026-11-05T09:07:37.928Z | V19 | quick_normal | failure | WX_103 | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 3398 |
| 2026-11-05T09:07:42.259Z | V19 | realtime_normal | failure | WX_103 | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 3853 |
| 2026-11-05T09:07:47.233Z | V19 | quick_normal | failure | WX_103 | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 4418 |
| 2026-11-05T09:07:52.903Z | V19 | quick_normal | failure | WX_103 | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 3456 |
| 2026-11-05T09:12:02.276Z | V19 | realtime_normal | failure | WX_103 | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 248964 |
| 2026-11-05T09:25:10.258Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1079 |
| 2026-11-05T09:25:15.197Z | V19 | quick_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 3306 |
| 2026-11-05T09:25:18.398Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 585 |
| 2026-11-05T09:25:54.035Z | V19 | realtime_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 34710 |
| 2026-11-05T09:26:39.958Z | V19 | realtime_normal | failure | WX_103 | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2381 |
| 2026-11-05T09:27:12.506Z | V19 | realtime_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 31595 |
| 2026-11-05T09:28:05.636Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1189 |
| 2026-11-05T09:28:21.410Z | V19 | realtime_normal | failure | WX_103 | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 13775 |
| 2026-11-05T09:30:08.119Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1095 |
| 2026-11-05T09:30:35.950Z | V19 | realtime_second_wechat_same_phone | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 25730 |
| 2026-11-05T09:30:52.911Z | V19 | realtime_second_wechat_same_phone | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 14753 |
| 2026-11-05T11:36:54.715Z | V3 | baseline | failure | PLATFORM_ERROR | parts_unobserved | mw3h0azs-y51kpna0o3 / — | — / 1 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 404480 / — | 3720 |
| 2026-11-05T11:37:26.852Z | V3 | baseline | failure | PLATFORM_ERROR | parts_unobserved | mw3h123l-ofh0r5tgp5 / — | — / 1 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 404480 / — | 710 |
| 2026-11-05T11:39:42.771Z | V7 | baseline | interrupted | WX_5 | signing | mw3h3c9q-ml2ht5gzsh / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 30000000 / temp | 30148 |
| 2026-11-05T11:40:30.097Z | V7 | baseline | interrupted | WX_5 | signing | mw3h3c9q-ml2ht5gzsh / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 30000000 / temp | 30240 |
| 2026-11-05T11:40:33.525Z | V7 | baseline | cancelled | QUEUE_ABANDONED | queue | mw3h3c9q-ml2ht5gzsh / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 30000000 / temp | 0 |
| 2026-11-05T11:41:11.938Z | V7 | baseline | failure | WX_5 | signing | mw3h590s-zvraovx0v6 / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 30000000 / temp | 30176 |
| 2026-11-05T11:42:41.673Z | V7 | baseline | failure | WX_5 | signing | mw3h76b6-wuc3dlgaur / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 30000000 / temp | 30043 |
| 2026-11-05T11:50:53.027Z | V3 | baseline | cancelled | CANCELLED | choose_file | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 19880 |
| 2026-11-05T11:51:00.655Z | V3 | baseline | failure | COS/ListMultipartUploads/HTTP403/AccessDenied | parts_unobserved | mw3hihuq-8bkabn1hua / — | — / 1 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 404480 / — | 896 |
| 2026-11-05T11:54:07.962Z | V3 | baseline | failure | COS/ListMultipartUploads/HTTP403/AccessDenied | parts_unobserved | mw3hmhtr-0lwq9q6bjv / — | — / 1 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 404480 / — | 1604 |
| 2026-11-05T11:55:07.277Z | V3 | baseline | cancelled | CANCELLED | choose_file | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 4842 |
| 2026-11-05T11:55:20.176Z | V3 | baseline | cancelled | CANCELLED | choose_file | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1046 |
| 2026-11-05T11:55:29.082Z | V3 | baseline | cancelled | CANCELLED | choose_file | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 7741 |
| 2026-11-05T11:55:55.482Z | V3 | baseline | cancelled | CANCELLED | choose_file | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 12375 |
| 2026-11-05T11:56:11.518Z | V3 | baseline | failure | COS/ListMultipartUploads/HTTP403/AccessDenied | parts_unobserved | mw3hp5sy-rxb2mn9zey / — | — / 76 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 317799354 / — | 781 |
| 2026-11-05T12:09:28.912Z | V3 | baseline | failure | COS/ListMultipartUploads/HTTP403/AccessDenied | parts_unobserved | mw3i68za-mdarsr8sag / — | — / 1 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 404480 / — | 879 |
| 2026-11-05T12:10:40.151Z | V3 | baseline | failure | COS/ListMultipartUploads/HTTP403/AccessDenied | parts_unobserved | mw3i7qqz-7x2mwb4128 / — | — / 1 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 404480 / — | 2141 |
| 2026-11-05T12:12:42.051Z | V3 | baseline | failure | STS_FAILED | parts_unobserved | mw3iaee2-k9e2l8wn9h / — | — / 1 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 404480 / — | 449 |
| 2026-11-05T12:23:10.989Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1162 |
| 2026-11-05T12:23:33.113Z | V3 | baseline | failure | COS/ListMultipartUploads/HTTP403/AccessDenied | parts_unobserved | mw3ioce4-0wic44v8vi / — | — / 1 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 404480 / — | 955 |
| 2026-11-05T12:39:03.756Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1064 |
| 2026-11-05T12:39:14.949Z | V3 | baseline | success |  | parts_unobserved | mw3j8hvf-2p0mjjt0vs / — | — / 1 | 1 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 404480 / — | 2616 |
| 2026-11-05T12:40:50.576Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw3jahvk-b78vovs09b / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 30000000 / temp | 4903 |
| 2026-11-05T12:43:14.862Z | V3 | baseline | success |  | parts_unobserved | mw3jdn4z-uvruaa1b2o / — | — / 1 | 1 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 404480 / — | 2127 |
| 2026-11-05T12:43:24.412Z | V3 | baseline | success |  | parts_unobserved | mw3jdvbh-ybk633fev3 / — | — / 1 | 1 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 404480 / — | 1384 |
| 2026-11-05T12:44:38.009Z | V3 | background_resume | failure | CREDENTIALS_UNAVAILABLE | parts_unobserved | mw3jffqx-aq123pp2mq / — | — / 1 | 1 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 404480 / — | 1840 |
| 2026-11-05T12:44:51.972Z | V3 | background_resume | failure | CREDENTIALS_UNAVAILABLE | parts_unobserved | mw3jfriv-mr860fixto / — | — / 1 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 404480 / — | 545 |
| 2026-11-05T12:48:45.649Z | V3 | background_resume | success |  | parts_unobserved | mw3jkp7b-eqyxxpj1qg / — | — / 2 | 2 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 8175145 / — | 3951 |
| 2026-11-05T13:21:33.182Z | V3 | background_resume | failure | INVALID_REQUEST | parts_unobserved | mw3jljdc-mv3by44pe0 / — | — / 122 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 509154114 / — | 485 |
| 2026-11-05T13:21:33.388Z | V3 | baseline | failure | INVALID_REQUEST | parts_unobserved | mw3jnydb-8eqnv31zeb / — | — / 122 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 509154114 / — | 420 |
| 2026-11-05T13:21:33.422Z | V3 | baseline | success |  | parts_unobserved | mw3joifm-gfca9o7wl3 / — | — / 20 | 20 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 83372718 / — | 22870 |
| 2026-11-05T13:21:33.459Z | V3 | baseline | failure | CREDENTIALS_UNAVAILABLE | parts_unobserved | mw3jp9fr-ecr4z20kys / — | — / 38 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 159231085 / — | 1606 |
| 2026-11-05T13:21:33.512Z | V3 | baseline | failure | CREDENTIALS_UNAVAILABLE | parts_unobserved | mw3jr57c-q0r0n5i9r1 / — | — / 45 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 185382414 / — | 1619 |
| 2026-11-05T13:21:33.559Z | V3 | baseline | success |  | parts_unobserved | mw3jud3u-a0cojtjkd2 / — | — / 5 | 5 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 20444118 / — | 7674 |
| 2026-11-05T13:21:33.633Z | V3 | baseline | success |  | parts_unobserved | mw3jv3r6-krzaa52nnx / — | — / 23 | 23 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 93746455 / — | 22684 |
| 2026-11-05T13:21:33.663Z | V3 | baseline | success |  | parts_unobserved | mw3jxk1j-bn1jjzajuu / — | — / 42 | 42 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 172731717 / — | 44709 |
| 2026-11-05T13:21:33.692Z | V3 | baseline | success |  | parts_unobserved | mw3jzynk-bn8e7ojq8p / — | — / 104 | 104 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 436039300 / — | 127302 |
| 2026-11-05T13:21:33.950Z | V3 | baseline | failure | INVALID_REQUEST | parts_unobserved | mw3k4q13-3t88rwdt7e / — | — / 210 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 876703119 / — | 839 |
| 2026-11-05T13:21:34.135Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1122 |
| 2026-11-05T13:21:34.164Z | V3 | baseline | cancelled | CANCELLED | choose_file | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1050 |
| 2026-11-05T13:21:34.190Z | V3 | baseline | failure | INVALID_REQUEST | parts_unobserved | mw3k6mp0-pryicbea7j / — | — / 210 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 876703119 / — | 590 |
| 2026-11-05T13:21:34.275Z | V3 | baseline | failure | PLATFORM_ERROR | choose_file | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 14496 |
| 2026-11-05T13:21:34.310Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 617 |
| 2026-11-05T13:21:34.368Z | V3 | baseline | failure | PLATFORM_ERROR | choose_file | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 10832 |
| 2026-11-05T13:21:34.456Z | V3 | baseline | failure | PLATFORM_ERROR | choose_file | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 3238 |
| 2026-11-05T13:21:34.486Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 930 |
| 2026-11-05T13:21:34.516Z | V3 | baseline | failure | PLATFORM_ERROR | choose_file | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2614 |
| 2026-11-05T13:21:34.547Z | V3 | baseline | failure | PLATFORM_ERROR | choose_file | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 4776 |
| 2026-11-05T13:21:34.578Z | V3 | background_resume | failure | PLATFORM_ERROR | choose_file | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 29648 |
| 2026-11-05T13:21:34.607Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1003 |
| 2026-11-05T13:21:49.277Z | V3 | baseline | failure | PROBE_SIZE_LIMIT | parts_unobserved | mw3krarn-g6bemmrr0m / — | — / 210 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 876703119 / — | 98 |
| 2026-11-05T13:22:22.648Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1014 |
| 2026-11-05T13:22:58.767Z | V3 | baseline | failure | PLATFORM_ERROR | choose_file | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 20483 |
| 2026-11-05T13:23:12.260Z | V3 | baseline | failure | PLATFORM_ERROR | choose_file | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2478 |
| 2026-11-05T13:23:25.008Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1018 |
| 2026-11-05T13:23:30.513Z | V3 | baseline | failure | PLATFORM_ERROR | choose_file | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2163 |
| 2026-11-05T13:24:13.692Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 891 |
| 2026-11-05T13:24:33.524Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 767 |
| 2026-11-05T13:59:11.286Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1209 |
| 2026-11-05T13:59:26.791Z | V3 | baseline | success |  | parts_unobserved | mw3m3jwj-fniva9tqqb / — | — / 2 | 2 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 8175145 / — | 6306 |
| 2026-11-05T13:59:46.153Z | V3 | baseline | failure | CREDENTIALS_UNAVAILABLE | parts_unobserved | mw3m4273-ex95j2x858 / — | — / 60 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 249452965 / — | 1948 |
| 2026-11-05T14:00:06.977Z | V3 | baseline | failure | CREDENTIALS_UNAVAILABLE | parts_unobserved | mw3m4jbz-dfueq3acx1 / — | — / 3 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 10510741 / — | 542 |
| 2026-11-05T14:00:19.829Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1012 |
| 2026-11-05T14:00:28.929Z | V3 | baseline | failure | STS_FAILED | parts_unobserved | mw3m50f3-o8hju4cj8x / — | — / 10 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 40348599 / — | 388 |
| 2026-11-05T14:02:23.047Z | V3 | baseline | failure | CREDENTIALS_UNAVAILABLE | parts_unobserved | mw3m6a18-pkzijkks30 / — | — / 52 | 52 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 215921850 / — | 55333 |
| 2026-11-05T14:02:42.091Z | V3 | baseline | success |  | parts_unobserved | mw3m7s42-z7a7ntqm6a / — | — / 3 | 3 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 10429249 / — | 4352 |
| 2026-11-05T14:03:09.440Z | V3 | baseline | success |  | parts_unobserved | mw3m8001-xp254tzzcq / — | — / 23 | 23 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 92685972 / — | 21438 |
| 2026-11-05T14:04:37.041Z | V3 | baseline | failure | CREDENTIALS_UNAVAILABLE | parts_unobserved | mw3m8qot-skwhrpotjm / — | — / 80 | 80 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 331982638 / — | 74303 |
| 2026-11-05T14:04:58.114Z | V3 | baseline | failure | CREDENTIALS_UNAVAILABLE | parts_unobserved | mw3marfz-fiyanz5l0p / — | — / 2 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 8175145 / — | 1283 |
| 2026-11-05T14:05:07.953Z | V3 | baseline | failure | STS_FAILED | parts_unobserved | mw3mazp3-zdktniuvqf / — | — / 2 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 6517328 / — | 309 |
| 2026-11-05T14:05:13.924Z | V3 | baseline | failure | CREDENTIALS_UNAVAILABLE | parts_unobserved | mw3mb47m-gsqkz451ey / — | — / 4 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 16310691 / — | 530 |
| 2026-11-06T01:56:54.615Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1032 |
| 2026-11-06T01:57:28.573Z | V3 | baseline | success |  | parts_unobserved | mw4bqvxe-aj361n5gh6 / — | — / 6 | 6 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 23006475 / — | 8641 |
| 2026-11-06T01:58:16.046Z | V3 | baseline | success |  | parts_unobserved | mw4brn95-a8jvy4j9a5 / — | — / 23 | 23 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 92685972 / — | 20854 |
| 2026-11-06T01:58:44.916Z | V3 | baseline | success |  | parts_unobserved | mw4bsl1l-a2jdfo3isz / — | — / 5 | 5 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 20430401 / — | 5840 |
| 2026-11-06T01:59:23.759Z | V3 | baseline | success |  | parts_unobserved | mw4bsxyj-8ipdyygfkd / — | — / 30 | 30 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 124272889 / — | 28087 |
| 2026-11-06T01:59:44.735Z | V3 | baseline | success |  | parts_unobserved | mw4btv6i-h0epc9f3t5 / — | — / 6 | 6 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 23006475 / — | 6011 |
| 2026-11-06T02:00:23.732Z | V3 | baseline | success |  | parts_unobserved | mw4bu6a4-kd79xrlv1j / — | — / 30 | 30 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 124272889 / — | 30614 |
| 2026-11-06T02:00:46.763Z | V3 | baseline | success |  | parts_unobserved | mw4bv30r-9rxly64xjx / — | — / 11 | 11 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 44239455 / — | 11220 |
| 2026-11-06T02:15:01.040Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2847 |
| 2026-11-06T02:15:35.730Z | V3 | baseline | success |  | parts_unobserved | mw4ceao6-5kig7vc48a / — | — / 2 | 2 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 8175145 / — | 3803 |
| 2026-11-06T02:16:23.001Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1260 |
| 2026-11-06T02:16:23.952Z | V3 | baseline | interrupted | PROCESS_INTERRUPTED | unknown | mw4cezzd-qrzzd9u9ua / — | — / 2 | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 8175145 / — | 19107 |
| 2026-11-06T02:16:33.832Z | V3 | baseline | success |  | parts_unobserved | mw4cfhm2-wrput2qj6k / — | — / 2 | 2 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 8175145 / — | 6209 |
| 2026-11-06T02:16:44.790Z | V3 | baseline | success |  | parts_unobserved | mw4cfs1l-nqaqv5rp33 / — | — / 3 | 3 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 8612123 / — | 3478 |
| 2026-11-06T02:17:10.431Z | V3 | baseline | success |  | parts_unobserved | mw4cg09p-mxzfgypkix / — | — / 16 | 16 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 63150616 / — | 18622 |
| 2026-11-06T02:17:58.643Z | V3 | background_resume | success |  | parts_unobserved | mw4chc2o-1z2s9pwdlm / — | — / 3 | 3 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 8612123 / — | 4910 |
| 2026-11-06T02:18:26.028Z | V3 | background_resume | success |  | parts_unobserved | mw4chojh-ewjzd8nc6f / — | — / 16 | 16 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 63150616 / — | 16131 |
| 2026-11-06T02:19:09.644Z | V3 | background_resume | success |  | parts_unobserved | mw4cik7d-szs90ettw2 / — | — / 19 | 19 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 78719237 / — | 18743 |
| 2026-11-06T02:20:19.949Z | V3 | background_resume | success |  | parts_unobserved | mw4cj9ta-95iv0ca9xs / — | — / 35 | 35 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 145043948 / — | 55823 |
| 2026-11-06T02:20:58.039Z | V3 | baseline | cancelled | CANCELLED | parts_unobserved | mw4ckq3i-ivn8711xnw / — | — / 35 | 24 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 145043948 / — | 26083 |
| 2026-11-06T02:22:22.832Z | V3 | background_resume | success |  | parts_unobserved | mw4clifi-xb2iiy7hkj / — | — / 59 | 59 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 246981295 / — | 74258 |
| 2026-11-06T02:23:06.972Z | V3 | background_resume | cancelled | CANCELLED | choose_album_original | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 9963 |
| 2026-11-06T02:24:34.638Z | V3 | baseline | success |  | parts_unobserved | mw4coqo2-mc3h7iui88 / — | — / 59 | 59 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 246981295 / — | 55420 |
| 2026-11-06T02:26:34.434Z | V3 | background_resume | success |  | parts_unobserved | mw4cqv8h-guyjl69027 / — | — / 59 | 59 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 246981295 / — | 75737 |
| 2026-11-06T02:27:07.085Z | V3 | process_reselect | failure | STS_FAILED | parts_unobserved | mw4ct6ii-r084vdmpvf / — | — / 59 | 0 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 246981295 / — | 708 |
| 2026-11-06T02:27:18.154Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1033 |
| 2026-11-06T02:27:48.205Z | V3 | process_reselect | interrupted | PROCESS_INTERRUPTED | unknown | mw4ctlbu-m32krw091 / — | — / 59 | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 246981295 / — | 22086 |
| 2026-11-06T02:27:51.236Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 874 |
| 2026-11-06T02:29:09.868Z | V3 | process_reselect | success |  | parts_unobserved | mw4cukq2-bycyj2q5z6 / — | — / 59 | 59 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 246981295 / — | 58339 |
| 2026-11-06T02:31:20.595Z | V19 | login | failure | PROVIDER_UNAVAILABLE | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 11193 |
| 2026-11-06T02:31:24.358Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 911 |
| 2026-11-06T02:31:57.812Z | V3 | baseline | success |  | parts_unobserved | mw4cz4gq-y3p0x4e0sr / — | — / 12 | 12 / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 47575856 / — | 12542 |
| 2026-11-06T02:32:23.899Z | V3 | baseline | success |  | parts_unobserved | mw4czl0s-1matotujt7 / — | — / 20 | 20 / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 81157543 / — | 17179 |
| 2026-11-06T02:33:26.530Z | V3 | baseline | success |  | parts_unobserved | mw4d16wh-xhy9in25tk / — | — / 2 | 2 / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 8377398 / — | 4680 |
| 2026-11-06T02:33:58.186Z | V3 | baseline | success |  | parts_unobserved | mw4d1l96-edowz3on7m / — | — / 22 | 22 / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 89756135 / — | 17842 |
| 2026-11-06T02:34:09.235Z | V3 | baseline | success |  | parts_unobserved | mw4d251m-tjtc6u8rkp / — | — / 2 | 2 / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 8019759 / — | 3172 |
| 2026-11-06T02:35:14.872Z | V3 | baseline | success |  | parts_unobserved | mw4d2fzv-o4o5zi7q3h / — | — / 67 | 67 / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 278638740 / — | 54653 |
| 2026-11-06T02:35:33.208Z | V3 | baseline | success |  | parts_unobserved | mw4d3s58-x5juow4yeq / — | — / 10 | 10 / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 38943475 / — | 10514 |
| 2026-11-06T02:35:40.631Z | V3 | baseline | success |  | parts_unobserved | mw4d44hz-7pfpd245rk / — | — / 2 | 2 / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 4197440 / — | 2032 |
| 2026-11-06T02:35:47.450Z | V3 | baseline | success |  | parts_unobserved | mw4d4aeg-7svbpt2m6p / — | — / 1 | 1 / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 1890456 / — | 1205 |
| 2026-11-06T02:36:16.568Z | V3 | baseline | success |  | parts_unobserved | mw4d4ke0-u9t4aoig1n / — | — / 18 | 18 / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 73558178 / — | 17320 |
| 2026-11-06T02:36:34.006Z | V3 | baseline | success |  | parts_unobserved | mw4d55zf-7b3cdd5qcs / — | — / 6 | 6 / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 24894058 / — | 6785 |
| 2026-11-06T02:36:54.368Z | V3 | background_resume | success |  | parts_unobserved | mw4d5kjg-2m7dr6pemh / — | — / 10 | 10 / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 38943475 / — | 8314 |
| 2026-11-06T02:37:30.825Z | V3 | background_resume | success |  | parts_unobserved | mw4d666w-7yay8oatzz / — | — / 20 | 20 / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 81157543 / — | 16672 |
| 2026-11-06T02:39:28.503Z | V3 | process_reselect | cancelled | CANCELLED | choose_chat_file | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1346 |
| 2026-11-06T02:39:30.665Z | V3 | process_reselect | cancelled | CANCELLED | choose_album_original | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1358 |
| 2026-11-06T02:39:58.809Z | V3 | process_reselect | interrupted | PROCESS_INTERRUPTED | unknown | mw4d9e4q-xmw3te664c / — | — / 16 | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 66411586 / — | 13591 |
| 2026-11-06T02:40:38.466Z | V3 | process_reselect | success |  | parts_observed | mw4da9zb-huc3q0hbsw / — | 4 / 16 | 12 / 0 | CLS-AL00 | Android 12 / 3.17.6 / wifi | 66411586 / — | 12721 |
| 2026-11-06T02:42:15.692Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4dcje0-qmgh5vajd / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / temp | 4427 |
| 2026-11-06T02:42:47.734Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4dd69l-q124sg0jgn / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / temp | 6838 |
| 2026-11-06T02:43:23.805Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4ddpcj-n1g3gqi753 / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 150000000 / temp | 18136 |
| 2026-11-06T02:43:55.302Z | V7 | baseline | success |  | saved | mw4delwz-ifyub29257 / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 60000000 / user_dir | 7474 |
| 2026-11-06T02:44:14.700Z | V7 | baseline | success |  | saved | mw4dexth-xpl4z85eu5 / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 100000000 / user_dir | 11448 |
| 2026-11-06T02:45:54.412Z | V7 | baseline | failure | WX_1 | downloading | mw4dgv9g-pv06r7x9qx / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 200000000 / user_dir | 21118 |
| 2026-11-06T02:47:27.205Z | V3 | process_reselect | success |  | parts_unobserved | mw4dj9g9-u4ir3lhecl / — | — / 3 | 3 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 8612123 / — | 3959 |
| 2026-11-06T02:48:05.695Z | V3 | process_reselect | interrupted | PROCESS_INTERRUPTED | unknown | mw4djvsb-uhtm9nr8ec / — | — / 23 | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 93746455 / — | 12845 |
| 2026-11-06T02:48:56.795Z | V3 | process_reselect | interrupted | PROCESS_INTERRUPTED | unknown | mw4dkzmz-r41rwok94q / — | — / 16 | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 63150616 / — | 12384 |
| 2026-11-06T02:49:19.621Z | V3 | baseline | success |  | parts_unobserved | mw4dlfdd-g5m2qj2vg3 / — | — / 16 | 16 / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 63150616 / — | 15396 |
| 2026-11-06T02:50:00.866Z | V7 | baseline | failure | WX_1 | downloading | mw4dm571-q8cjnt2wj0 / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 200000000 / user_dir | 21076 |
| 2026-11-06T02:55:04.929Z | V3 | process_reselect | interrupted | PROCESS_INTERRUPTED | unknown | mw4drj39-yo7d8bj3hg / — | — / 76 | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 317799354 / — | 75325 |
| 2026-11-06T02:55:12.758Z | V3 | process_reselect | cancelled | CANCELLED | choose_album_original | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 1700 |
| 2026-11-06T02:56:00.886Z | V3 | process_reselect | success |  | parts_observed | mw4dtfg7-5vhbp35k6p / — | 53 / 76 | 23 / 0 | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 317799354 / — | 43320 |
| 2026-11-06T02:57:03.960Z | V3 | process_reselect | cancelled | CANCELLED | choose_chat_file | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 4213 |
| 2026-11-06T02:58:57.790Z | V3 | process_reselect | cancelled | CANCELLED | choose_chat_file | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 5666 |
| 2026-11-06T02:59:13.048Z | V3 | process_reselect | cancelled | CANCELLED | choose_chat_file | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 3748 |
| 2026-11-06T09:06:16.064Z | V7 | baseline | success |  | saved | mw4r24ld-2u77kd3gfd / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 30000000 / user_dir | 17577 |
| 2026-11-06T09:32:38.809Z | V7 | baseline | failure | WX_5 | signing | mw4rzrb8-wk3cjwgn5h / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / temp | 31421 |
| 2026-11-06T09:33:10.955Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 3277 |
| 2026-11-06T09:33:55.540Z | V7 | baseline | failure | WX_5 | signing | mw4s1fjf-o2q54c3nqs / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / temp | 30063 |
| 2026-11-06T09:47:32.334Z | V7 | baseline | failure | WX_5 | signing | mw4sixkq-jou0hm7m3s / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 30000000 / temp | 30048 |
| 2026-11-06T09:47:57.408Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2839 |
| 2026-11-06T09:48:39.771Z | V7 | baseline | failure | WX_5 | signing | mw4skdry-mlyyeico8h / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 30000000 / temp | 30047 |
| 2026-11-06T09:49:24.176Z | V7 | baseline | failure | WX_5 | signing | mw4slc18-ofmmzy8v0r / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 30000000 / user_dir | 30036 |
| 2026-11-06T09:49:53.795Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4smis4-zc17ov9vu7 / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 30000000 / temp | 4284 |
| 2026-11-06T09:50:38.489Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4snge2-goiy1quf8t / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 30000000 / temp | 5324 |
| 2026-11-06T09:51:24.578Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4sogrm-rdy2messds / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 30000000 / temp | 4317 |
| 2026-11-06T09:51:45.388Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 0 / — | 2456 |
| 2026-11-06T09:51:55.437Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4sp4nb-zpkm8ub77s / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 30000000 / temp | 4312 |
| 2026-11-06T09:53:42.129Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4sr7lx-jf7wp9dfjb / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 60000000 / temp | 13852 |
| 2026-11-06T09:54:36.829Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4sslez-9gavio6iyi / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 30000000 / temp | 3989 |
| 2026-11-06T09:55:25.437Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4stjzf-1l5i671xcf / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 60000000 / temp | 7602 |
| 2026-11-06T09:56:08.807Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4suhuw-i0ctbp67tj / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 60000000 / temp | 7147 |
| 2026-11-06T09:56:52.148Z | V7 | baseline | success |  | saved | mw4svfm3-gm0tcp79jr / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 60000000 / user_dir | 6851 |
| 2026-11-06T09:58:57.827Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4sy0ld-3f21kjqsk5 / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 100000000 / temp | 12069 |
| 2026-11-06T09:59:36.415Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4syuzs-oo3m1wkq0y / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 100000000 / temp | 10984 |
| 2026-11-06T10:00:17.362Z | V7 | baseline | success |  | saved | mw4szqbl-anbc6tu202 / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 100000000 / user_dir | 11598 |
| 2026-11-06T10:01:29.285Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4t150l-rjtmolkikn / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 150000000 / temp | 17768 |
| 2026-11-06T10:02:11.154Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4t219q-ru6y1yuvcp / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 150000000 / temp | 17778 |
| 2026-11-06T10:02:39.117Z | V7 | baseline | success |  | saved | mw4t2nc5-5z0z4nfsgo / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 150000000 / user_dir | 17106 |
| 2026-11-06T10:03:52.087Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4t3ytw-e8n162oex7 / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 200000000 / temp | 28513 |
| 2026-11-06T10:04:41.844Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4t4yd2-8kpmmde5oz / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 200000000 / temp | 32276 |
| 2026-11-06T10:06:24.395Z | V7 | baseline | success |  | saved | mw4t78i1-s8mu3n3uy6 / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 200000000 / user_dir | 28273 |
| 2026-11-06T10:06:53.376Z | V7 | baseline | failure | WX_600002 | downloading | mw4t8got-xpd1euea20 / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / temp | 296 |
| 2026-11-06T10:13:11.306Z | V7 | baseline | failure | WX_600002 | downloading | mw4tghuo-xnq6oop7cw / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / temp | 3088 |
| 2026-11-06T10:13:23.341Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 4078 |
| 2026-11-06T10:13:33.861Z | V7 | baseline | failure | WX_600002 | downloading | mw4tgzwf-z5mmm3exrv / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / temp | 2105 |
| 2026-11-06T10:13:51.402Z | V7 | baseline | failure | WX_600002 | downloading | mw4thecw-8sxyamra5a / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / temp | 1161 |
| 2026-11-06T10:13:58.545Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 1348 |
| 2026-11-06T10:14:30.499Z | V19 | realtime_normal | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 27633 |
| 2026-11-06T10:14:39.501Z | V7 | baseline | failure | WX_600002 | downloading | mw4tif0w-9eclrm6h4b / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / temp | 434 |
| 2026-11-06T10:15:55.212Z | V7 | baseline | failure | WX_600002 | downloading | mw4tk2fh-m952ghikv6 / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / temp | 604 |
| 2026-11-06T10:17:02.900Z | V7 | baseline | failure | WX_600002 | downloading | mw4tliky-j6f0piwfoy / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / user_dir | 712 |
| 2026-11-06T10:17:22.462Z | V7 | baseline | failure | WX_600002 | downloading | mw4tlxnq-17ooptb81x / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / user_dir | 668 |
| 2026-11-06T10:18:28.104Z | V7 | baseline | failure | WX_600002 | downloading | mw4tnbpq-j15ijek83n / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / user_dir | 911 |
| 2026-11-06T10:21:39.115Z | V7 | continuous_80 | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4tozpn-u39awrww5f / 2 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 50000000 / temp | 114533 |
| 2026-11-06T10:26:24.270Z | V7 | continuous_80 | interrupted | WX_600003 | downloading | mw4tozpn-u39awrww5f / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.17.6 / wifi | 50000000 / temp | 398887 |
| 2026-11-06T10:40:55.895Z | V7 | continuous_80 | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4tozpn-u39awrww5f / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.18.0 / wifi | 50000000 / temp | 219507 |
| 2026-11-06T10:41:09.192Z | V7 | continuous_80 | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4tozpn-u39awrww5f / 3 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.18.0 / wifi | 50000000 / temp | 231485 |
| 2026-11-06T10:43:17.259Z | V7 | continuous_80 | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4tozpn-u39awrww5f / 4 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.18.0 / wifi | 50000000 / temp | 140656 |
| 2026-11-06T10:44:36.566Z | V7 | continuous_80 | failure | WX_600001 | downloading | mw4tozpn-u39awrww5f / 5 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.18.0 / wifi | 50000000 / temp | 207196 |
| 2026-11-06T10:45:09.577Z | V7 | continuous_80 | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4tozpn-u39awrww5f / 7 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.18.0 / wifi | 50000000 / temp | 32296 |
| 2026-11-06T11:18:50.663Z | V7 | baseline | failure | WX_600002 | downloading | mw4vswob-86dqf9jz5b / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / temp | 4053 |
| 2026-11-06T11:19:02.651Z | V7 | baseline | failure | WX_600002 | downloading | mw4vt8ek-1kutdr91cb / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / temp | 552 |
| 2026-11-06T11:20:05.139Z | V7 | baseline | failure | WX_600002 | downloading | mw4vujdq-1byy7dr6zf / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / temp | 1993 |
| 2026-11-06T11:20:16.359Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2693 |
| 2026-11-06T11:20:23.189Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 2427 |
| 2026-11-06T11:20:31.584Z | V7 | baseline | failure | WX_600002 | downloading | mw4vv4lk-8le8xhbi9p / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / temp | 945 |
| 2026-11-06T11:23:24.670Z | V7 | baseline | failure | WX_600002 | downloading | mw4vyrnm-kob2szatiy / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / temp | 4848 |
| 2026-11-06T11:25:03.944Z | V7 | baseline | failure | WX_600002 | downloading | mw4w0xtm-xut4wm4epr / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / user_dir | 1640 |
| 2026-11-06T11:36:38.782Z | V7 | baseline | success |  | saved | mw4wfjok-udboi85glc / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / user_dir | 15985 |
| 2026-11-06T11:38:49.826Z | V7 | continuous_80 | interrupted | PROCESS_INTERRUPTED | downloading | mw4tozpn-u39awrww5f / 6 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.18.0 / wifi | 50000000 / temp | 3330676 |
| 2026-11-06T11:38:50.228Z | V7 | continuous_80 | interrupted | PROCESS_INTERRUPTED | downloading | mw4tozpn-u39awrww5f / 8 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.18.0 / wifi | 50000000 / temp | 3220274 |
| 2026-11-06T11:38:57.484Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4whqfs-1z4atthsbd / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / temp | 52658 |
| 2026-11-06T11:40:58.624Z | V7 | baseline | success |  | saved | mw4wl8wk-agy8dq4us2 / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 30000000 / user_dir | 9342 |
| 2026-11-06T11:41:36.469Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4wkm1a-cfitub11lj / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.18.0 / wifi | 30000000 / temp | 76179 |
| 2026-11-06T11:45:26.057Z | V19 | login | success |  | unknown | — / — | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 0 / — | 5038 |
| 2026-11-06T11:49:09.397Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4wujwl-rd0fx9lu16 / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.18.0 / wifi | 30000000 / temp | 65677 |
| 2026-11-06T11:54:00.953Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4x01a6-w85d5i004d / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.18.0 / wifi | 30000000 / temp | 101427 |
| 2026-11-06T12:07:24.412Z | V19 | login | success |  | unknown | — / — | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.18.0 / wifi | 0 / — | 3995 |
| 2026-11-06T12:09:21.419Z | V7 | baseline | failure | TEMP_CLEANUP_FAILED | saved_cleanup_failed | mw4xlc56-up94pz2bvk / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.18.0 / wifi | 30000000 / temp | 27896 |
| 2026-11-06T12:13:10.617Z | V7 | baseline | success |  | saved | mw4xps4l-ze58afcrv / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.18.0 / wifi | 30000000 / user_dir | 50229 |
| 2026-11-06T12:21:49.979Z | V7 | baseline | success |  | saved | mw4xunrt-mj8pcq2am7 / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 150000000 / user_dir | 342672 |
| 2026-11-06T12:31:55.093Z | V7 | baseline | success |  | saved | mw4ycmk3-djiqly4xtv / 1 | — / — | — / — | iPhone 17 Pro Max iPhone18,2  | iOS 27.0 / 3.18.0 / wifi | 30000000 / user_dir | 109041 |
| 2026-11-06T12:35:19.650Z | V7 | baseline | failure | WX_1 | downloading | mw4ydi8f-zufefsy08w / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 200000000 / user_dir | 271711 |
| 2026-11-06T12:43:18.831Z | V7 | baseline | failure | WX_1 | downloading | mw4ysfda-nv4a6tsfjf / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 200000000 / user_dir | 55564 |
| 2026-11-06T13:13:21.822Z | V7 | baseline | success |  | saved | mw4zvh6z-xm0btqs94x / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 200000000 / user_dir | 37676 |
| 2026-11-06T13:28:00.750Z | V7 | baseline | failure | WX_1 | downloading | mw50eih9-wusp84trw3 / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 27486 |
| 2026-11-06T13:28:08.316Z | V7 | baseline | failure | WX_1 | downloading | mw50eih9-wusp84trw3 / 2 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 35128 |
| 2026-11-06T13:28:13.237Z | V7 | baseline | failure | WX_1 | downloading | mw50eih9-wusp84trw3 / 3 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 12366 |
| 2026-11-06T13:46:38.708Z | V7 | baseline | success |  | saved | mw512wg4-0xw3xl78m9 / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 8022 |
| 2026-11-06T13:55:59.470Z | V7 | baseline | success |  | saved | mw51ermj-3adnf51gmd / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 15412 |
| 2026-11-06T13:56:08.657Z | V7 | baseline | success |  | saved | mw51ermj-3adnf51gmd / 3 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 9093 |
| 2026-11-06T13:56:09.311Z | V7 | baseline | success |  | saved | mw51ermj-3adnf51gmd / 2 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 25346 |
| 2026-11-06T14:13:17.587Z | V7 | continuous_80 | success |  | saved | mw52107o-kz4fssx3zh / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 15630 |
| 2026-11-06T14:13:26.650Z | V7 | continuous_80 | success |  | saved | mw52107o-kz4fssx3zh / 3 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 9000 |
| 2026-11-06T14:13:29.239Z | V7 | continuous_80 | success |  | saved | mw52107o-kz4fssx3zh / 2 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 27251 |
| 2026-11-06T14:13:34.518Z | V7 | continuous_80 | success |  | saved | mw52107o-kz4fssx3zh / 4 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 7811 |
| 2026-11-06T14:13:47.032Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 6 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 12411 |
| 2026-11-06T14:13:50.853Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 5 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 21427 |
| 2026-11-06T14:14:00.990Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 8 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 10007 |
| 2026-11-06T14:14:02.409Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 7 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 14964 |
| 2026-11-06T14:14:07.214Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 9 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6155 |
| 2026-11-06T14:14:13.654Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 11 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6328 |
| 2026-11-06T14:14:19.941Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 12 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6136 |
| 2026-11-06T14:14:29.521Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 13 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 9415 |
| 2026-11-06T14:14:32.646Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 10 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 29971 |
| 2026-11-06T14:14:40.005Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 14 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 10332 |
| 2026-11-06T14:14:44.767Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 15 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 11974 |
| 2026-11-06T14:14:55.207Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 16 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 15053 |
| 2026-11-06T14:14:56.041Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 17 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 10887 |
| 2026-11-06T14:15:02.460Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 18 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 7158 |
| 2026-11-06T14:15:10.954Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 20 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 8343 |
| 2026-11-06T14:15:14.663Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 19 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 18392 |
| 2026-11-06T14:15:20.467Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 21 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 9431 |
| 2026-11-06T14:15:28.058Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 22 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 13218 |
| 2026-11-06T14:15:36.956Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 23 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 16248 |
| 2026-11-06T14:15:39.862Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 24 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 11656 |
| 2026-11-06T14:15:46.399Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 25 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 9193 |
| 2026-11-06T14:15:54.142Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 27 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 7506 |
| 2026-11-06T14:15:59.569Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 26 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 19451 |
| 2026-11-06T14:16:08.137Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 28 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 13903 |
| 2026-11-06T14:16:11.618Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 29 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 11740 |
| 2026-11-06T14:16:26.400Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 31 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 14610 |
| 2026-11-06T14:16:37.851Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 32 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 11370 |
| 2026-11-06T14:16:47.364Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 33 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 9217 |
| 2026-11-06T14:16:53.726Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 30 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 45410 |
| 2026-11-06T14:16:59.016Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 34 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 11403 |
| 2026-11-06T14:17:01.939Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 35 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 8022 |
| 2026-11-06T14:17:08.739Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 37 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6659 |
| 2026-11-06T14:17:15.091Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 38 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6247 |
| 2026-11-06T14:17:21.308Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 39 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6122 |
| 2026-11-06T14:17:27.771Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 40 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6394 |
| 2026-11-06T14:17:34.757Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 41 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6870 |
| 2026-11-06T14:17:41.576Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 42 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6691 |
| 2026-11-06T14:17:48.180Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 43 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6510 |
| 2026-11-06T14:17:54.705Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 44 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6413 |
| 2026-11-06T14:17:55.984Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 36 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 56741 |
| 2026-11-06T14:18:01.314Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 45 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6543 |
| 2026-11-06T14:18:07.662Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 47 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6262 |
| 2026-11-06T14:18:13.718Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 48 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 5954 |
| 2026-11-06T14:18:19.871Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 49 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6080 |
| 2026-11-06T14:18:26.346Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 50 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6405 |
| 2026-11-06T14:18:32.525Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 51 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6085 |
| 2026-11-06T14:18:39.444Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 52 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6751 |
| 2026-11-06T14:18:46.731Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 53 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 7038 |
| 2026-11-06T14:18:53.481Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 54 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6667 |
| 2026-11-06T14:18:59.719Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 55 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6151 |
| 2026-11-06T14:19:06.180Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 56 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6350 |
| 2026-11-06T14:19:07.122Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 46 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 70414 |
| 2026-11-06T14:19:12.574Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 57 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6286 |
| 2026-11-06T14:19:19.381Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 59 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6712 |
| 2026-11-06T14:19:26.371Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 60 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6856 |
| 2026-11-06T14:19:34.579Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 61 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 8076 |
| 2026-11-06T14:19:41.630Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 62 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6786 |
| 2026-11-06T14:19:49.146Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 63 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 7390 |
| 2026-11-06T14:19:50.401Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 58 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 42944 |
| 2026-11-06T14:19:55.947Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 64 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6707 |
| 2026-11-06T14:20:02.918Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 66 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6794 |
| 2026-11-06T14:20:10.980Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 67 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 7946 |
| 2026-11-06T14:20:19.647Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 68 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 8466 |
| 2026-11-06T14:20:21.536Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 65 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 30807 |
| 2026-11-06T14:20:27.469Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 69 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 7709 |
| 2026-11-06T14:20:34.130Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 71 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6605 |
| 2026-11-06T14:20:41.184Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 72 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6774 |
| 2026-11-06T14:20:49.633Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 73 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 8302 |
| 2026-11-06T14:20:54.470Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 70 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 32336 |
| 2026-11-06T14:20:57.434Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 74 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 7672 |
| 2026-11-06T14:21:04.179Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 76 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6658 |
| 2026-11-06T14:21:11.250Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 77 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6993 |
| 2026-11-06T14:21:18.149Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 78 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6670 |
| 2026-11-06T14:21:24.866Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 79 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6620 |
| 2026-11-06T14:21:33.245Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 80 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 8204 |
| 2026-11-06T14:21:36.635Z | V7 | continuous_80 | failure | WX_1 | downloading | mw52107o-kz4fssx3zh / 75 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 42009 |
| 2026-11-06T16:02:10.784Z | V7 | diagnostic_8 | success |  | saved | mw55x4cs-tx3l2a3201 / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 11766 |
| 2026-11-06T16:02:17.998Z | V7 | diagnostic_8 | success |  | saved | mw55x4cs-tx3l2a3201 / 3 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 7134 |
| 2026-11-06T16:02:21.852Z | V7 | diagnostic_8 | success |  | saved | mw55x4cs-tx3l2a3201 / 2 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 22554 |
| 2026-11-06T16:02:24.565Z | V7 | diagnostic_8 | success |  | saved | mw55x4cs-tx3l2a3201 / 4 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6518 |
| 2026-11-06T16:02:30.613Z | V7 | diagnostic_8 | failure | WX_1 | downloading | mw55x4cs-tx3l2a3201 / 6 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6003 |
| 2026-11-06T16:02:35.610Z | V7 | diagnostic_8 | failure | WX_1 | downloading | mw55x4cs-tx3l2a3201 / 5 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 13642 |
| 2026-11-06T16:49:01.100Z | V7 | diagnostic_serial_8 | success |  | saved | mw57k0ig-6ojoxit43l / 1 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 74224 |
| 2026-11-06T16:49:09.419Z | V7 | diagnostic_serial_8 | success |  | saved | mw57k0ig-6ojoxit43l / 2 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 8193 |
| 2026-11-06T16:49:16.435Z | V7 | diagnostic_serial_8 | success |  | saved | mw57k0ig-6ojoxit43l / 3 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 6967 |
| 2026-11-06T16:49:22.107Z | V7 | diagnostic_serial_8 | success |  | saved | mw57k0ig-6ojoxit43l / 4 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 5617 |
| 2026-11-06T16:49:30.188Z | V7 | diagnostic_serial_8 | failure | WX_1 | downloading | mw57k0ig-6ojoxit43l / 5 | — / — | — / — | CLS-AL00 | Android 12 / 3.17.6 / wifi | 50000000 / user_dir | 8041 |

## 业主观察（另填 CHECKLIST 记录栏后一起回传）

| 项 | 当前数据 | 仍须人工记录 |
| --- | --- | --- |
| V19 | 有尝试，待业主判定 | 添加其他号码交互/数量、换微信同号、体验是否可接受 |
| V8 | 有尝试，待业主判定 | 亮度分组、电脑轮询终点耗时、识别失败次数 |
| V3 | 有尝试，待业主判定 | 未压缩续传分块交集、压缩匹配、实际120秒超时 |
| V7 | 有尝试，待业主判定 | 两台主力机各80集、相册数量、低存储、清理后残留、目标体积/模式 |
