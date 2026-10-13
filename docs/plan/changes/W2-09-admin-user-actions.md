# W2-09 后台账号三动作

- 落地disable/enable/forceLogout三条正式Route/DTO与薄路由，复用既有权限、stepUp、回显和required执行器。
- 缓存前核当前员工会话/角色/范围及目标可见性；锁后按20→80→90→100→120复核有效成员集合，漂移BUSY不补低序锁。
- 禁用/启用走02:126/127、私有sameTx守卫与两条已登记事件；强制下线不迁移，另关全部身份静默登录。
- user_session仅未吊销行置admin，本人授权portal置account_action；启用不恢复旧会话，不改成员或历史记录。
- 低量6DB+3HTTP；作者仅所属格式/lint和正常提交，ROOT串行类型/定点/独审/官方派生；无DDL、白名单或外部调用。
