# W2-10 分店创建

| 项 | 内容 |
| --- | --- |
| 改了什么 | 接通 m.store.create 正式 JSON、required 三段式和真实四项复制装配，返回完整 StoreCard。 |
| 原因 | 新增分店需要真实额度、当前拥有者/会话以及初次不可变复制元数据共同保护。 |
| 影响的包 | services tenant、API 商家装配、contract 与本片测试。 |
| 类别 | 顺序 |
| PR | 本地 codex/w2-10-store-create，待独占验证与 ROOT 审查合流。 |

SOURCE 阶段不宣称生成、类型、数据库、Redis 或云端验收完成；既有首店路径、原测试正文及默认模型预算保持原事实。复制文件不可用沿 FILE_NOT_USABLE 整笔回滚，I11 仍通过既有时限汇合处理。
