# W2-10 门店档案初始化前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | profile 显式 callerTx 初始化能力，精确复制 basic/service/media 并首次写不可变来源元数据。 |
| 原因 | ensureProfile 的默认懒建不能补写创建后不可变的 copiedFrom/options。 |
| 影响的包 | services/profile；无 HTTP、brand_assets、默认 runtime、DDL、契约、依赖或通用锁机制改动。 |
| 类别 | 顺序 |
| PR | codex/w2-10-profile-store-copy；本地待验合流。 |

prepare 完整80→100→120→130→135锁图后零写规划，opaque plan绑定实例/同Tx/一次消费；未来素材370与完整文件410共同协调。
apply最后等待后fresh真实会话/owner检查、首次INSERT三选项元数据、真实Media.link和实际完整度重算。by_owner来源允许，draft_deleted与不可用文件整笔拒绝。
SOURCE阶段：两新整叶、旧整叶、类型、正常尾门禁及唯一独审未运行；不把本前置记为完整门店创建、真实云或生产容量完成。
