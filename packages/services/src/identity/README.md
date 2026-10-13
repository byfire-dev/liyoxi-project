# identity：商家账号、微信身份、会话与登录

W1-04 的第一个 PR 交会话与鉴权链要的服务：令牌与会话、静默登录、手机号登录、退出、当前账号、协议同意的门、版本门槛的判断。依据：[m01](../../../../docs/api/m01-account.md) 第 2.1–2.8、3.1–3.4 节；[02 分组](../../../../docs/data-model/02-identity-tenant.md) 第 2.1–2.3、2.5、2.14、5 节；[约定](../../../../docs/api/00-conventions.md) C3、C71、C73；D4 第 3.2、3.3、3.6 节。改称呼、换绑手机号、已登录的微信、关闭一次性提示、注销随 M2；引导与“我的”聚合在本包的第二个 PR。

## 1. 这里有什么

| 文件 | 内容 |
| --- | --- |
| `service.ts` | `createIdentity(deps)`：装配入口，给出下面全部函数 |
| `token.ts` | 令牌 `lyxm_<sid>.<随机数>`：签发、解析、定长比较 |
| `sessions.ts` | 开会话与上限、每请求校验与续写、按微信身份吊销 |
| `login.ts` | 静默登录、手机号登录（含休眠检查、改绑、首触来源、同意与指纹） |
| `personal-account.ts` | 本人称呼、提示关闭、微信身份列表与移除；真实会话、required 重放与身份年龄守卫 |
| `phone.ts` | 换回来的手机号认不认：只认中国大陆的手机号，区号看原串 |
| `logout.ts` | 退出登录 |
| `portal-grants.ts` | 调用方同事务精准吊销下载页授权，tenant 的强制端口实现 |
| `me.ts` | `MeView`：账号、成员关系、待同意协议、一次性提示 |
| `consent-gate.ts` | 协议同意的门：比指纹、复核、回写 |
| `machines.ts`、`invariants.ts`、`register.ts` | `merchant_user.status` 的守卫；`identity.I8`、`I9`、`I22`、`I23`、`I25` |

## 2. 怎么用

```ts
const identity = createIdentity({
  tx, clock, flow, events, assembly, docs, tenant, config,
  keyring: () => keyring, // 用到时才取：只校验会话的路径用不到密钥
  wechat,                 // WechatProvider；没接上传 null，登录回 WECHAT_UNAVAILABLE
  appid,
});

await identity.silentLogin(meta, { loginCode });                 // needPhone 时不写库
await identity.phoneLogin(meta, input, { onOpenid });            // 外呼在前，再开一个事务
await identity.logout(principal, meta);
await identity.me(merchantUserId);

const check = await identity.authenticate(token, { ip });        // 鉴权中间件：每请求点查，不缓存
const pending = await identity.pendingConsents(check.principal); // 协议同意中间件：空数组即放行
await identity.isClientOutdated(clientVersion, flagContext);     // 版本门槛
```

- **令牌**：库里只存随机部分的 sha256。只认规范写法，改任何一位都无效。
- **会话**：有效 = 摘要对得上、未吊销、未过空闲（30 天滑动）与绝对（90 天）过期、账号 `active`。`last_seen_at` 与空闲过期同一天（北京时间）只写一次，连带账号的 `last_active_at`；微信身份的 `last_active_at` 距上次写入超过 30 分钟才再写。无效的原因只进日志，端上一律 401。
- **同事务复核**：`assertCurrentSession(tx, principal, freshNow, expectedAppid)` 单条只读 JOIN 核当前归属、AppID、吊销、双期限与账号状态，返回当前四字段 principal（含当前 consentStamp）。调用方在最后业务锁等待后取 freshNow；不读令牌、不续期、不加锁、不补同意。只保证语句快照，不取消所有在途 logout/rebind 请求。
- **上限**：同一微信身份未吊销的会话至多 5 条，多了挤掉最旧的（`evicted`）。登录事务先锁账号行（80）再锁微信身份行（90），并发登录在这两把锁上排队。
- **静默登录**：没有身份、关了静默登录、账号不是 `active`，一律 `needPhone = true`，不区分原因、不写库。
- **手机号登录**：`code2Session`、`getPhoneNumber` 在事务之外先做完；`onOpenid` 在两者之间调一次（接口层在这里按 openid 限流），给的是 openid 的 HMAC。事务里：取号或建号（`ON CONFLICT (phone_bidx) DO NOTHING`）→ 休眠检查 → 微信身份（新建、恢复静默登录、改绑）→ 新绑定的审计与 `merchant_user.wechat_bound` → 同意记录与指纹 → 新账号的注册迁移与 `merchant_user.registered` → 会话与 `auth_event`。`consents` 没覆盖用户级协议的当前版本回 428，整个事务回滚（账号也不建）。
- **协议同意的门**：账号上的指纹等于当前指纹即放行，不查同意记录；不等时现算复核，没有待同意的才回写指纹。当前指纹在进程内至多缓存 60 秒，且不跨过下一个版本的生效时刻。
- **版本门槛**：没带或写法不对的 `X-Client-Version` 按 `0.0.0` 算；最低版本是 `0.0.0`（开关的默认值）时都放行。

微信手机号返回的 `countryCode` / `purePhoneNumber` 若存在，必须分别为 `86` / 归一化大陆号码；事实不一致在登录事务前拒绝，旧的只含 `phone` 替身仍可用。API 身份装配优先显式 AppID，其次运行时完整微信配置，未配本地沿用占位；`currentSessionOpenid(tx, principal, expectedAppid?)` 可校验当前会话身份的 AppID，内容检测不能跨小程序使用 openid。新增真实数据库区号与命名空间回归通过，外部真机登录仍待 E2 验收。

## 3. 跑用例

W2-09 四个人接口复用当前会话事实：称呼更新沿既有三段式执行器在事务外检测当前 openid，成功重放不再外检；提示关闭保留首次时间；身份列表只投影本人六字段并优先当前身份；移除当前/最后身份不受年龄限制，其他身份依当前身份绑定时间判定。移除只写审计/auth_event，不发新事件；待发订阅随后由原投递任务按 no_target 与原短信回退处理。该片仅所属静态准备，正式类型/数据库/API与官方派生由 ROOT 定点验证。

```sh
pnpm --filter @liyoxi/services exec vitest run src/identity/
LYX_FC_RUNS=5000 LYX_FC_SEED=42 pnpm --filter @liyoxi/services exec vitest run src/identity/token.property.test.ts
```

`token.property.test.ts` 不连库；另两份连真库，走带种子的测试库：要本地的 PostgreSQL 与 `DATABASE_URL`（`CLAUDE.md` 第 9 节）。

## 4. 已知的限度

- 休眠检查：五条放行条件保持；新绑定在主体锁后重读当前成员。已休眠店员经 Tenant callerTx 清理，空草稿老板经同事务让位后继续绑定；后续通知/同意角色使用处置后的关系。只有锁后四事实不满足的 `DraftNotEmptyError` 转独立人工重验，依赖/flow 失败原样回滚。此 W2-09 切片待 ROOT 定点验收；其余账号生命周期仍待交付。
- 新微信绑定只写审计、发事件；写一次性提示的订阅者 `identity.onWechatBound` 随 M2。企业微信联系人的回填随 M7。
- openid 的 HMAC 快照借 `uscc` 那把盲索引密钥、输入加 `OPENID:` 前缀分域：密钥环里没有 openid 专用的用途。它只是同意记录里的证据快照与限流键，不用于查找。
- `MeUser.actions` 里的“换绑手机号”要装配处给 `smsConfigured`，现在不给（短信驱动随 G2-D）。
- 会话的过期清理（吊销或过期满 30 天的行）没有登记，随清理框架（W0-24）合并后由 M2 的包接。
- `auth_event` 的写函数在 `audit/auth-event.ts`，是 W1-01a 交的那一份（本包开工时先建的最小实现签名相同，接到 main 时让位）。
- 区号只能从 `getPhoneNumber` 交回的原串里看（`phone.ts`）：Provider 的接口只交 `phone`，没有区号一项。带 `+区号`、`00区号` 而不是 86 的回 `PHONE_REGION_UNSUPPORTED`；真实驱动（G2-D）要把区号交出来，不能把区号不带加号地拼在号码前面（`+1` 的号码去掉符号与大陆号同形）。

## 5. 引导与我的聚合（W1-04②）

`identity.bootstrap({ merchantUserId, storeId, platform, clientVersion, envVersion })` 对七块独立取数；单块失败用 m08 第 3.1 节默认并记录 `degraded`，全块失败才 `INTERNAL`。匿名个人块为 `null`；只用解析成功的成员关系给开关主体白名单上下文。待同意协议直接读 docs，不走会回写指纹的鉴权门；最后门店来自 tenant 的可访问概要，不因传入的门店头改写。

`identity.overview({ merchantUserId, membership })` 取 tenant 的门店卡、条数和额度；套餐积分、概览、发布广告客服入口、未读数经事实端口，未登记即默认。店员只询问未读消息事实，返回门店、可见数与未读数；接口回包还会用观察者角色结构 parse 一次。

图片上限按任务书暂为 5 MB；引导订阅登录后为 `[]`，客服为 contact。未登记的订阅参数暂为 7 天、每次 3 个，随 G2-C 接共享参数。事实端口已有实现会自动生效，不把整个聚合等到其余包到齐才交。

## 6. 成员授权吊销前置（W2-10 PR1）

`revokePortalGrants(tx, input): Promise<number>` 是 [02 分组第 5 节](../../../../docs/data-model/02-identity-tenant.md) 要求的公开函数；同一实现经 identity 的 registration 注册到 tenant 定义的 `membershipAuthorizationsPort`。不需要运行时另绑端口，api 与 worker 都自动装配；没有实现必须拒绝启动。

调用方在原事务持有主体与相关成员锁。主体范围仅匹配 `entityId`；owner 范围还匹配 `approvedByUserId = merchantUserId`，二者都限定 `revokedAt = null`。一次 UPDATE 写 `membership_changed` 与相同的注入 `now` 到 revokedAt/updatedAt，返回实际 count；不按 expiresAt 排除已过期行。重复不改旧原因、时间、令牌摘要及归属列，外层回滚会一并回滚。

此口不注销商家账号或改 user_session/portal_ticket，也没有成员生命周期调用方和 M6 登录、票据、下载入口。新真库测试直接准备授权表 fixture，只证明吊销能力；旧 sessions/logout 与 tenant 成员范围用例继续保留。

定点命令见 [tenant 第 6 节](../tenant/README.md)，其中两条独立连接重复 12 轮，覆盖主体和 owner 两种范围，计数总和与真实撤销行数一致。

## 7. 微信身份只读事实（W2-21）

`findWechatIdentityId(tx, { appid, openid })` 只按唯一自然键返回身份 id，不叠加账号状态或静默登录开关。`recentWechatOpenid(tx, { merchantUserId, appid, now })` 在同一参数化 SELECT 中确认账号当前 active、AppID 一致、lastActiveAt 不早于注入 now 的两小时前；等号有效，按 lastActiveAt 降序、id 升序取一行。不按 lastLoginAt、silentLoginEnabled 或额外未来上界筛选。

两个函数只使用调用方的真实事务，不加锁、不写表、不缓存、不外呼。返回的 openid 仅供内部 Provider 装配，禁止进入 HTTP DTO、日志或审计。本叶没有装配 WechatOpenIdPort、通知派发或微信 HTTP 接口；测试只使用虚构身份和真实隔离数据库。
