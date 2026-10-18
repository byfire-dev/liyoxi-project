# W3-15 ASR 回调严格 FILE 配置

| 项 | 内容 |
| --- | --- |
| 改了什么 | 独立解析成对 ASR_CALLBACK_ORIGIN 与 ASR_CALLBACK_KEY_FILE，并保留原始 UTF8 密钥字节。 |
| 原因 | sender 与 receiver 必须消费同一密钥，不能沿用会 trim 的其它 FILE reader。 |
| 影响的包 | services kernel 环境配置、独立配置测试及公共环境变量样例。 |
| 类别 | 实现细化。 |
| PR | codex/w3-15-asr-callback-env，本地分支待验收合流。 |

基于 accepted main `3f24d5857d2dcbc69fd48d44e2ff53a955b6f2f7`，限定六个路径。
回调须同时具备合法腾讯 ASR FILE；明文密钥、半配、非法 origin 或文件均启动拒绝。
独立普通文件读取最多257字节，实际 UTF8 长度32至256；fatal解码保留BOM，
不trim、normalize、限制ASCII、解释hex/base64或回显路径与密钥。
origin 与已接受 sender 等价；仅公开factory对照，不导私有validator。
默认全无仍关闭；本片不装配API/worker、不启用callback、预算或真实云调用。

当前仅SOURCE、轻量AST及owned格式/lint。旧七整叶240静态候选和新增整叶、
三消费者类型、完整尾门禁与唯一独立审查尚未执行。
