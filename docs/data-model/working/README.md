# 建模工作底稿

字段级数据模型是分三轮做出来的，这里保留过程中的四份底稿，供追溯“为什么这样定”。各分组文档里写的“catalogue”“decisions #n”“rulings Mn”“WRITER-GUIDE”指的就是这几份文件。

| 文件 | 内容 | 时点 |
| --- | --- | --- |
| [rulings.md](rulings.md) | 主负责人的裁决 M1–M112，按时间分九节 | 贯穿全程，最后一节最新 |
| [catalogue.json](catalogue.json) | 统一表清单与建模约定（166 张表的归属、主键形态、锁顺序等） | 表清单定稿时（字段级之前） |
| [decisions.md](decisions.md) | 七份设计草案之间分歧的处理、改名与合并清单、加锁顺序、参数键归属 | 表清单定稿时 |
| [WRITER-GUIDE.md](WRITER-GUIDE.md) | 给各分组作者的写作规范 | 字段级第一、二轮 |

**以哪份为准**：表结构以 [../schema.prisma](../schema.prisma)、[../constraints/](../constraints/) 与各分组文档为准。`catalogue.json` 与 `decisions.md` 记录的是表清单定稿时的状态，之后的裁决（rulings 第六节起）改动过其中一些列名与口径，两者不一致时以分组文档为准。

没有保留的：每轮复核员的意见原文与跨分组请求清单（处理结果已写进各分组文档末尾的“修订记录”）。
