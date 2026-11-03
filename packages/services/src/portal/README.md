# 一次性电脑授权（W6-05）

`createPortalTickets({ tx, clock, appid, origin, ticketTtlSeconds })` 提供 create、poll、lookup、decide 和 exchange；会话由 identity 公口创建，禁止 portal 反向装配或直接绕过会话鉴权。API 在既有 merchantServicesOf 中按 Runtime 装配，复用事务与时钟，无新增连接或关闭资源。

票据使用随机 publicId、8 位短码、两位配对数和一次性返回的 pollSecret。只存 SHA256，短码/publicId 唯一冲突在保存点内重生。部署键 PORTAL_TICKET_TTL 默认 120 秒，PORTAL_PUBLIC_ORIGIN 缺配时创建受控失败；二维码是普通链接，不调用真实微信。

商家写动作依原锁序校验真实账号、主体、老板和门店；等到票据行锁后再次核商家会话，重新取时钟。pending 确认/拒绝与 approved 消耗均使用原状态条件更新。错误配对数返回持久化 rejected；exchange 严格按原状态、secret、尝试次数、确认后 60 秒窗口处理。恰好 60 秒有效。成功同事务消费票据、创建唯一会话、记 login_success；已批准票据的失败提交 rejected 后另开短事务记 login_fail。exchange 按原契约不重验老板资格，后续每次会话请求重新检查。

poll 和 lookup 全部只读。pending 到期、approved 窗口过去均只投影 expired，不更新票据。候选数字由票据 id 派生，始终包含正确数字且不重复。浏览器摘要在服务内解析；当前未接 IP 定位数据源，regionHint 按可空契约返回 null，不返回原始 IP。

portalAuth、portalCsrf 与 portalCapability 沿现有槽位登记，不改 PIPELINE_ORDER。每次按 Cookie 摘要查真实会话及老板资格，注入 merchant/portal 身份和固定 entity/store scope；GET 不续期、不补写撤销。撤销与退出在技术会话行锁后取新时钟，等待期间已到期时不补写撤销。全部已挂 portal 响应 no-store；非 GET 同时校验精确 Origin 与 X-LYX-Portal。optional 原语仅将无/失效 Cookie 当匿名，内部错误继续失败。

只读能力为 delivery.download、sample.view、ad.view，额外操作白名单仅允许原有查询/下载签发。历史 sample.view 不开放 Q9 的两条样片接口；上传、确认、下单等业务写入均不获准。本包没有实现这些下载业务或 clientError 处理器。

现有 ops.retention 收集 portal.portal_ticket 的 7 天有界清理，保留已有 identity.portal_session 清理；不增加 x01 周期任务。portal.I31 检查 consumed 票据恰一条会话，identity.I20 检查仍有效的会话授权人，均真实查库且不自愈。

下游 W6-02/06/10 只消费 actual main 的 PortalPrincipal/当前会话、统一中间件和 identity 精准撤销公口。V8 的真实扫码、AppID/合法域名与真机验收未由本地测试替代。
