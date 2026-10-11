# W2-10 当前会话只读复核前置

| 项 | 内容 |
| --- | --- |
| 改了什么 | identity 公开 assertCurrentSession，调用方 Tx 内单条参数化 JOIN；共用原有效期规则。 |
| 原因 | 后续业务最终等待后需要新时钟下的真实会话事实，不能把 principal 构造当授权。 |
| 影响的包 | W2-10；accept/emptyDraft 与整包其余行为仍待交付。 |
| 类别 | 顺序 |
| PR | 本地 codex/w2-10-current-session-assert；唯一非作者审查后正常合流。 |

基线 `6a87b8a1`；nonTest含支持文档≤120，新增测试≤350。无 HTTP/DDL/依赖/框架改动。
仅 statement 快照：提交前的 logout 可仍读旧事实，已提交吊销下一语句拒绝；不增加 SHARE/rank95 或改登录/退出。
返回当前 consentStamp，不证明当前协议已同意；无效 Date 是编程错误，其余失效沿 SESSION_INVALID。
当前 SOURCE，真实新旧整文件、三类型、尾门禁与唯一 ROOT180 秒审查尚未执行，失败原件按实际保留。
