# W2-29：独立提审工作流凭据登记

| 项 | 内容 |
| --- | --- |
| 改了什么 | 只在工作流凭据守卫增加weapp-review-upload.yml的同名任务，允许两个既有预发SSH凭据键。 |
| 原因 | W2-29机器人2上传需经既有受限SSH协议；原守卫禁止新消费者，按独立gate-change办理，不在业务包放松。 |
| 影响的包 | W2-29；本片不增加工作流、不启用开关、不接触凭据，也不上传或发布。 |
| 类别 | gate-change |
| PR | 本地codex/w2-29-review-credential-gate；远端由ROOT串行处理。 |

唯一新增例外要求完整精确条件：手动workflow_dispatch、refs/heads/main、STG_WEAPP_REVIEW_UPLOAD_ENABLED=true、STG_FREEZE=true、execute=true，五项缺一不可。只允许STG_SSH_PRIVATE_KEY与STG_SSH_KNOWN_HOSTS；其他文件、任务、凭据、条件和跨任务泄露仍拒绝。原受信消费者不改。

沿用同一现有反例测试生成器，对新增例外核准完整条件，并拒绝额外密钥、宽松条件、错误任务/工作流与越界引用。独立审查和定点验证通过后才本地合流；实际工作流及上传结果未知时保留在役标签由后继业务包交付。本片不代表真实平台配置或提审就绪。
