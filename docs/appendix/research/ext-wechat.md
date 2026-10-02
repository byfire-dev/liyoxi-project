# 「狸有戏」商家端小程序 · 微信生态能力与规则核实报告（ext-wechat）

- 查证日期：**2026-10-02**（下文所有 URL 均在此日抓取核对；未另注日期者同此）
- 查证方式：直接抓取官方文档正文（developers.weixin.qq.com、pay.weixin.qq.com、developer.work.weixin.qq.com、cloud.tencent.com、developer.open-douyin.com），辅以 WebSearch；npm registry 元数据查询
- 标注约定：
  - 【已核实】＝官方文档原文可对上；
  - 【非官方】＝只在第三方文章/社区用户帖里看到，官方页未查到；
  - 【推断】＝我基于已核实事实做的工程判断；
  - 【不确定】＝查不到权威来源，需真机/提审/问平台确认。
- 资料侧出处写法：`PRD §x.y`（/…/scratchpad/src/PRD.md）、`原型 <画板>.txt:行号`（/…/scratchpad/slim/merchant/）、参考工程 `路径:行号`（timavia-liyo-project）。

---

## 0. 结论速览（对架构/选型影响最大的 12 条）

| # | 结论 | 性质 | 影响 |
|---|---|---|---|
| 1 | 2026-04-01 起，小程序内**虚拟商品在全终端（iOS/安卓/鸿蒙/Windows）必须走「小程序虚拟支付」**，不得引导到 App/公众号/H5/个人号/网站支付（运营规范 5.13）。iOS 走 Apple 支付，费率 12%（2026 年）；安卓「工具/深度合成等类目」主动支付当前 1%、标准 10% | 已核实 | 本产品“会员套餐 + 积分充值”的**形态**与官方虚拟商品举例（VIP 会员、充值代币）高度同形，是 V1.0 最大的平台风险 |
| 2 | 官方「虚拟支付管控类目」含 文娱（微短剧/其他视频/视频广场…）、工具（办公/企业管理/图片处理/效率…）、深度合成（AI 创作…）等；**只有这些类目的小程序，普通微信支付会被关闭**；有实物/线下等非虚拟业务的，按实际业务申请其他类目后限制自动解除 | 已核实 | 类目必须选**「商业服务 > 广告/设计」**（无资质要求、不在管控类目表内），不要以「工具-企业管理/办公」或「文娱」为主类目 |
| 3 | 「文娱-微短剧」类目一旦通过：只能播放平台过审链接、必须用虚拟支付，且需广电备案材料。**绝对不要申请** | 已核实 | 预告片/样片必须以“服务案例/商品介绍视频”的补充形态出现，不能做成“短剧播放器” |
| 4 | 订阅消息：一次授权只能发一条；长期订阅**不对「商业服务」类目开放**（官方 2026-02 明确答复）；新版一次性订阅（服务卡片）也无本类目模板 | 已核实 | “到期前 7/3/1 天 + 当天”4 次提醒不能靠订阅消息保证，必须做「站内信 → 订阅消息（有额度才发）→ 短信 → 企业微信服务经理」的多通道降级 |
| 5 | wx.downloadFile 单次最大 200MB、并发上限 10、**小程序切后台 5 秒未完成即中断**；临时文件运行时上限 4GB；saveVideoToPhotosAlbum 仅支持 mp4 | 已核实 | 原型的“成片包一键下载（80 个视频 · 约 2.6GB）”在小程序里不可能以 zip 形式实现；必须改成“逐集队列存相册 + 电脑端提取页”双路径 |
| 6 | 微信支付 APIv3：**新商户号默认「微信支付公钥」模式**；回调按 `Wechatpay-Serial` 区分公钥（`PUB_KEY_ID_` 前缀）/平台证书 | 已核实 | 支付模块验签要按 Serial 选密钥；社区 SDK `wechatpay-node-v3`（最后发版 2024-08）README 未见公钥模式，不宜直接选 |
| 7 | 微信支付**无官方 Node.js SDK**（官方只有 Java/PHP/Go） | 已核实 | 建议按参考工程风格自研薄封装（node:crypto + fetch），或用 `wechatpay-axios-plugin@0.9.6`（2026-02 发版，支持公钥模式） |
| 8 | 大额：官方 B2b 门店助手文档写明“银行转账：适用单笔金额大于 5 万元的支付场景”；银行快捷支付单笔限额多为 5 万（部分行 20 万） | 前半已核实，后半非官方 | 专业版年付 7.2 万、旗舰版年付 14.4 万不能假设微信支付可付成；**对公转账必须是一等公民**（PRD 已有 M10），≥5 万默认引导对公 |
| 9 | 手机号快速验证组件 0.03 元/次（成功回调即扣费）、每账号 1000 次体验额度；code 5 分钟有效、一次性 | 已核实 | 只在“首次登录/换绑/受邀加入”调用，老用户用 wx.login 静默登录（openid→账号） |
| 10 | image 组件 `show-menu-by-longpress` 官方支持长按识别**企业微信个人码**（基础库 ≥2.18.0）；企业微信另有「联系我」小程序插件（`wx104a1a20c3f81ec2`） | 已核实 | “添加服务经理企业微信”可落地：用 `add_contact_way` 生成带 `state` 的专属码，加好友回调里自动把商家与 external_userid 绑定 |
| 11 | 审核规范 3.5.2“禁止视频、音乐、语音等多媒体的自动播放”；运营规范 5.14.2 登录页/手机号组件前置页不得使用“微信”字样致误认 | 已核实 | 与 PRD §6.5“预告片默认静音自动播放”、原型按钮文案“微信手机号快捷登录”冲突，需改 |
| 12 | 抖音“代替用户发布内容到抖音”仍限党政机关/事业单位、仅网站应用 PC 端、不可面向 C 端；视频号“每个视频号可设 20 个运营者” | 已核实（视频号数字来自视频号助手界面文案的社区转述） | PRD §10.4 的判断仍成立；V1.0 只能商家自助发布 |

---

## 1. 微信支付（小程序 JSAPI · APIv3）

### 1.1 接口与规则（均【已核实】）

| 项 | 规则 | 出处 |
|---|---|---|
| 下单 | `POST https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi`；`amount.total` 整数、单位分、必须 >0；`description` ≤127 字符；`out_trade_no` 6–32 位（数字、大小写字母 `_-|*`），商户号下唯一；`attach` ≤128；`notify_url` ≤255 | https://pay.weixin.qq.com/doc/v3/merchant/4012791897 |
| 支付时限 | `time_expire`（RFC3339）不能早于下单后 1 分钟，须在下单后 15 天内；**不传则默认 7 天有效**；超时后用户看到“订单已超过商户设置的最晚支付成功时间”，商户需关单 | 同上；开发指引 https://pay.weixin.qq.com/doc/v3/merchant/4012791911 |
| prepay_id | 有效期 2 小时，过期须用**原下单参数**重新下单取新 prepay_id | 同上 |
| 调起支付 | 小程序端 `wx.requestPayment`，`paySign` 用商户 API 私钥 RSA 签名（由服务端生成） | https://pay.weixin.qq.com/doc/v3/merchant/4012791898 |
| 支付回调 | POST 到 `notify_url`；报文 `resource` 用 **AEAD_AES_256_GCM + APIv3 密钥**解密；须在 **5 秒内**验签并应答 200/204；未应答按 `15s/15s/30s/3m/10m/20m/30m/30m/30m/60m/3h/3h/3h/6h/6h` 重试，最多 15 次；不能只依赖回调，须配合查单 | https://pay.weixin.qq.com/doc/v3/merchant/4012791902 ；https://pay.weixin.qq.com/doc/v3/merchant/4012791906 |
| 查单 | 未收到回调时主动调查询订单 API | https://pay.weixin.qq.com/doc/v3/merchant/4012791900 |
| 关单 | `POST /v3/pay/transactions/out-trade-no/{out_trade_no}/close`，成功返回 204；官方建议“先查单，仍未支付再关单，关单后可视为失败终态” | https://pay.weixin.qq.com/doc/v3/merchant/4012791901 ；开发指引同上 |
| 退款 | `POST /v3/refund/domestic/refunds`；支付成功后 **1 年内**可退；单笔订单最多 **50 次**部分退款（间隔 ≥1 分钟、每次新 `out_refund_no`）；失败重试必须用**原 `out_refund_no`**；返回成功只代表受理，结果以回调/查询为准；`funds_account` 可指定资金来源；成功调用 150 QPS、失败 6 QPS | https://pay.weixin.qq.com/doc/v3/merchant/4012791903 |
| 退款回调 | 状态变更（成功/关闭/异常）时推送；同样 AES-GCM 加密、5 秒应答、15 次重试 | https://pay.weixin.qq.com/doc/v3/merchant/4012791906 |
| 账单 | 交易账单 `GET /v3/bill/tradebill`、资金账单；按日（00:00–23:59:59）生成，**次日 10 点后**可下载；**API 仅支持 3 个月内**、每次单日；商户平台可下 5 年内；账单金额单位“元”；`bill_type`=ALL/SUCCESS/REFUND；`tar_type` 可选 GZIP；返回的 `download_url` 短时有效（搜索摘要称 5 分钟）并带 hash 校验 | https://pay.weixin.qq.com/doc/v3/merchant/4013071215 ；https://pay.weixin.qq.com/doc/v3/merchant/4013071227 |
| 账单口径 | 交易账单按“支付成功时间/退款受理成功时间”归日；资金账单按“余额变化时间”归日；账单是日切快照 | https://pay.weixin.qq.com/doc/v3/merchant/4013071215 |

对 PRD 的对应：
- PRD §7.9-5“每日自动下载前一日微信支付账单逐笔核对”可行，定时任务应排在 **10:30 之后并带重试**；历史补拉最多 3 个月，**所以账单原文件要自己落对象存储归档**【推断】。
- PRD §7.9-5 提到“支付回调晚于订单超时取消”的差异：应把本地超时与 `time_expire` 对齐，取消前执行“查单 → 未支付则关单 → 已支付则按支付成功入账”，从根上减少这类差异【推断，依据开发指引的关单建议】。
- PRD §2.8/§7.9-2“原路退回通过微信支付发起”：受 1 年期限约束；年付套餐在第 12 个月后发生的退款需走线下退款登记（PRD 已有“线下退款须登记转账信息”）【推断】。

### 1.2 验签：平台证书 vs 微信支付公钥（【已核实】）

- “微信支付 APIv3 支持平台证书和微信支付公钥两种模式构造签名验签，**新申请的商户号默认为微信支付公钥模式**”。来源：https://pay.weixin.qq.com/doc/v3/partner/4015419376 （搜索结果标题原文）；https://pay.weixin.qq.com/doc/v3/merchant/4012154180 （“新申请的商户号、全新开发的系统无需切换，按微信支付公钥使用说明”）。
- 平台证书 5 年有效需主动更换；公钥模式为规避更换风险而推出。每个商户号只有一个微信支付公钥；公钥 ID 形如 `PUB_KEY_ID_0000…`；请求头需带 `Wechatpay-Serial: PUB_KEY_ID_…`；回调用哪种验签可由回调头 `Wechatpay-Serial` 判断；从证书切公钥的灰度期内回调会随机用两种方式签名，需同时兼容。来源：https://pay.weixin.qq.com/doc/v3/merchant/4013038816 ；https://pay.weixin.qq.com/doc/v3/merchant/4015164042
- 架构要求【推断】：验签器实现为“按 Serial 查密钥表”（公钥 + 可选平台证书），不要写死一种；公钥文件、公钥 ID、商户 API 私钥、证书序列号、APIv3 密钥都进密钥管理，不进仓库。

### 1.3 Node.js 侧 SDK

| 选项 | 现状（npm registry，2026-10-02 查） | 评价 |
|---|---|---|
| 官方 SDK | 官方只有 Java（wechatpay-java）、PHP（wechatpay-php）、Go（wechatpay-go），**没有 Node** | https://pay.weixin.qq.com/docs/partner/sdk-tools/sdk-tool.html ；https://github.com/wechatpay-apiv3 |
| `wechatpay-axios-plugin` | 0.9.6，2026-02-10 发布，MIT，月下载约 6.6k；README 明确有「微信支付公钥」接入模式（`PUB_KEY_ID_…`）；依赖 axios、fast-xml-parser | 维护活跃、支持公钥；链式 API 风格较特殊 |
| `wechatpay-node-v3` | 2.2.1，**2024-08-19 最后发布**，月下载约 30.7k；README 的 `publicKey` 指商户证书，未见“微信支付公钥”模式；依赖 superagent 8.0.6 | 下载量大但停更，新商户号（默认公钥模式）下验签/证书下载有踩坑风险【推断】 |
| 自研薄封装 | 签名 `RSA-SHA256`、验签、`AES-256-GCM` 解密用 `node:crypto` 即可，约 200–300 行 | 与参考工程一致：其微信能力就是自写 provider + fetch + Redis 缓存 token（`packages/services/src/providers/wechat/wechat.ts:1-80`），依赖全部锁版本（`apps/api/package.json`） |

**推荐【推断】**：自研 `WechatPayProvider`（下单、调起签名、查单、关单、退款、查退款、账单申请与下载、回调验签解密 7–8 个方法），以官方 Java SDK 的行为为对照写单测；若想省事则选 `wechatpay-axios-plugin` 并锁版本。两种做法都要：金额一律用“分”的整数；所有写操作带幂等键（`out_trade_no` / `out_refund_no` 由我方生成并唯一）；回调处理“验签 → 解密 → 幂等落库 → 立即 200”，业务后处理丢队列（参考工程已用 BullMQ）。

### 1.4 单笔限额与 7.2 万年付

- 资料事实：PRD §2.2 示例月费 3,000 / 6,000 / 12,000，周期 1/3/12 个月，应付＝月费×月数 → 年付分别为 **3.6 万 / 7.2 万 / 14.4 万**；PRD §6.15-1“默认微信支付；大额可选对公转账”；原型 `PlanPick.txt:26-39` 已有“支付方式”单选与对公转账弹层（户名/开户行/账号/上传回单）。
- 接口侧：下单接口对 `amount.total` **没有写上限**（只要求 >0）【已核实，同 1.1】。限制来自付款人侧。
- 付款人侧【非官方，需以银行与商户平台实际为准】：
  - 银行卡快捷支付限额由发卡行定；2024-10 起多家银行把第三方快捷支付限额提到单笔/单日 20 万，但工/中/建等仍报道为单笔 5 万、日累计 10 万（https://finance.sina.com.cn/tech/digi/2024-11-11/doc-incvsuth0573958.shtml ）。
  - 零钱支付有年累计限额（常见说法 20 万/年，随实名等级不同）（https://help.lingxi360.com/content/355 ，该页自述“以各渠道最新为准”）。
  - 社区流传“信用卡：实物行业单笔/单日 8 万，虚拟行业单笔 6000/单日 9000”（搜索摘要，未在官方页核到）。
- 官方侧佐证【已核实】：小程序 B2b 门店助手文档把支付方式分为“微信支付”和“**银行转账：适用单笔金额大于 5 万元的支付场景**，到账自动认款对账”（https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/industry/B2b_store_assistant.html ）。该能力要求类目为「商家自营-B2b（商品批发/门店管理）」，本产品不适用，但说明官方自己也把 5 万作为微信支付与转账的分界。
- **结论【推断】**：
  1. 3.6 万（基础年付）、月付/季付、积分包：微信支付为主。
  2. 7.2 万、14.4 万：不能依赖微信支付一次付成（老板个人卡多数卡在 5 万），**默认推荐对公转账**，微信支付作为“可尝试”。不建议拆单规避（拆单会破坏付款单—发票—合同一一对应）。
  3. 对公转账在 V1.0 是人工确认（PRD §7.5-3）；数据模型上给每张付款单生成**唯一转账附言码**，为后续银企直连/自动认款留口。
  4. 手续费：普通商户费率常见 0.6%（未在官方页逐条核对，【非官方】），7.2 万一笔约 432 元，财务对账需按净额/手续费分列。

---

## 2. 虚拟支付与 iOS 限制（V1.0 头号风险）

### 2.1 规则现状（【已核实】）

1. **运营规范 5.13 虚拟支付行为**：“开发者在小程序内提供的虚拟商品（包括虚拟代币、解锁功能、订阅内容、付费功能、打赏、购买虚拟礼物等），购买和支付均需接入小程序虚拟支付；不得引导至 app、公众号、h5、个人号、网站完成支付。”违规处理：风险提醒、限制功能直至暂停或终止服务。来源：https://developers.weixin.qq.com/miniprogram/product/ （#5.13）
2. **iOS 已放开**：虚拟支付“适用于 Android、iOS、鸿蒙、Windows 等所有终端，iOS 端需使用微信客户端 8.0.68 及以上版本”；调用 `wx.requestVirtualPayment` 后平台按设备路由——安卓/鸿蒙/Windows → 微信支付，iOS → Apple 支付；iOS 订单由 Apple 结算，“通常在自然月结束后 45～60 天内结算”。来源：https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html
3. 时间线：2025-11-14 微信官宣小程序将支持 iOS 虚拟支付（媒体报道 https://m.21jingji.com/article/20251114/herald/e7a9317efd72df99d27a5ead2c65713b_zaker.html ）；2026-02-11 官方《能力指引：小程序 iOS 虚拟支付现已支持》（https://developers.weixin.qq.com/community/minihome/doc/0004a2d3214e90c38ea4e0fa661401 ）；2026-02-27 更新虚拟支付业务管理规范，要求 **2026-04-01 前全终端接入**（https://www.mpaypass.com.cn/news/202603/02164733.html ，【非官方转述】，与官方运营指南“须全终端接入”的表述一致）；2026-03-13 官方《iOS 渠道费率调整通知》：2026 年实际费率由 15% 降到 **12%**（全部为 Apple 佣金，腾讯 5% 技术服务费 2026 年暂不收）（https://developers.weixin.qq.com/community/minihome/doc/000a04a261c0f0d5edc4972a96f401 ）。
4. 费率表（https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/devplan.html ）：
   - 工具、社交、深度合成、文娱（非微短剧）及其他类目：安卓/鸿蒙/Windows 主动支付标准 10%、**当前生效 1%**；iOS 标准 17%、当前 12%。
   - 文娱（微短剧/互动微短剧/网络小说）：安卓主动支付 5%–10%；iOS 12%。
5. **判定口径**（《虚拟支付业务运营指南》，官方置顶，最后编辑 09-17；https://developers.weixin.qq.com/community/minihome/doc/00002cf077cd4810fee42f4b865c01 ）：
   - 判定表（原文为图片，我已下载核读）：商品形态＝“非实物商品，以数字内容、虚拟权益、线上服务等形式存在”；交付方式＝“线上交付，如解锁内容、开通权限、发放虚拟道具等形式存在”。
   - 典型形态 7 类：音频；电影/剧集/短视频/**短剧**；小说漫画；在线教育；游戏工具/陪玩；陌生人交友；**摄影修图、文档编辑等“以内容生产与处理为目标的效率工具场景，帮助用户完成图片美化、AI 生成与文档编辑排版等创作工作”**。
   - 管控类目表（图片核读）：文娱（微短剧、互动微短剧、网络小说、视频广场、其他视频、音乐…）、工具（视频客服、办公、图片处理、信息查询、效率、**企业管理**、预约/报名…）、社交、资讯、深度合成（AI 问答/换脸/绘画/创作）、教育服务（在线教育、在线视频课程）、体育（在线健身）。
   - “若小程序**仅包含以上虚拟类目**，平台将关闭该小程序在安卓及其余非 iOS 系统的普通微信支付能力，需调用小程序虚拟支付能力进行交易；如小程序实际提供非虚拟业务，如实物或线下交易等，可按实际经营业务申请其他类目，相关能力限制会自动解除。”
   - 混合型：虚拟 + 实物捆绑“将被认定为虚拟支付，建议拆分为两笔交易”。豁免只点名了线上问诊、法律咨询两类实时专业服务。
6. 旧口径（2018/2019 官方帖，仍在线）：虚拟支付“是指购买非实物商品。比如：VIP 会员、充值、课程、音视频等虚拟产品”；关闭支付后仍展示货架价格、引导客服/个人微信号/H5/公众号完成购买，都会被拒（https://developers.weixin.qq.com/community/minihome/doc/000464b5b3cb382b9d372b98f5ac08 ；https://developers.weixin.qq.com/community/minihome/doc/000cc6c0b383a047c7798e0045b409 ）。

### 2.2 本产品如何定性

资料事实：
- PRD §2.1：收费项＝套餐费（月费×月数，含每月套餐积分、折扣、权益）+ 加购积分（1 积分＝1 元示例）；订购短剧、广告制作都用积分支付。
- 原型用词：`PlanPick.txt:27`“付款即表示同意《会员服务协议》《积分规则》”；`Invoices.txt:59-60`开票项目“积分充值”“会员服务费”；PRD §12.3（PRD.md:1163）“原型暂按付款单开具‘会员服务费’‘积分充值’”。
- 实质：付费方是持营业执照的经营主体（PRD §2.2-1），平台交付的是**按门店人工 + AI 定制的广告/短剧成片**及交付经理、发布核验等人工服务，签合同、开增值税发票（PRD §6.13、§7.9）。

我的判断【推断】：
- **实质上**这是 B2B 广告/营销制作服务的预付款，不是面向消费者的数字内容消费；但**形态上**“会员套餐 + 充值积分 + 用积分兑换线上交付的视频”恰好踩中官方举例（VIP 会员、充值代币、线上交付、开通权限），而且官方 7 类典型形态里有“AI 生成等内容生产工具”。审核员按形态判的概率不低。
- 官方没有任何一条写明“面向企业的服务不算虚拟支付”。**这一点查不到权威依据，属于【不确定】**，只能通过提审/向平台咨询确认。
- 一旦被认定为虚拟支付，后果是：iOS 走 Apple 支付抽 12%，回款 45–60 天；安卓走虚拟支付（1%～10%）；且**小程序内的“对公转账”入口本身会被视为“引导至其他渠道支付”**；3.6–14.4 万的客单价在 Apple 支付下基本不可行。

### 2.3 建议（降低审核风险的具体做法）

1. **类目**：主类目选「商业服务 > 广告/设计」（“适用于提供商业广告、产品设计等相关服务”，无资质要求），可加「商业服务 > 公关/推广/市场调查」。不选「工具-企业管理/办公/图片处理」「文娱-*」「深度合成-*」作为唯一或主要类目（它们都在虚拟支付管控类目表里）。来源：https://developers.weixin.qq.com/miniprogram/product/material/ （商业服务章节）。
2. **商户号经营类目**同步按“广告/商务服务”申请，订单 `description` 写“XX 门店短剧广告定制服务费（合同号…）”这类服务表述【推断】。
3. **去虚拟化表达**（产品文案，需业务确认）：
   - “会员套餐/会员服务协议”→“营销服务套餐/《短剧营销服务合同》”；“积分充值/加购积分”→“服务额度/制作额度（预付服务款）”；发票项目“会员服务费/积分充值”→“广告制作服务费/营销服务费”；避免“VIP、充值、解锁、代币”等词。
   - 付款前置条件设为**经营主体认证通过**（营业执照），并在付款页展示合同、发票信息，突出 B2B 服务属性。
4. **工程上为最坏情况留开关**【推断】：
   - 支付渠道做成策略接口：`wechat_jsapi` / `bank_transfer` /（预留）`wechat_virtual`；
   - “是否展示购买入口、展示哪种支付方式、文案”由服务端按 **平台（iOS/安卓）× 版本号 × 审核态** 下发，能不发版就关掉某端入口；
   - 备选方案 B：若提审被判虚拟支付，小程序退化为“展示 + 建档 + 订购 + 交付”，开通/续费改为线下签约（销售/服务经理跟进、对公收款，后台“对公收款确认”直接开通），小程序内不出现价格货架与支付引导；PC 商家端网页（Native 扫码/对公）作为远期补充。
5. **提审策略**：首版提审说明里写清“面向企业商户的广告制作服务，线下签约、人工交付、开具发票”，并附合同模板与营业执照认证流程截图；上线前先用体验版向微信平台/服务商渠道咨询定性。
6. iOS 现状不再是“一律不能卖”，而是“虚拟商品必须走 Apple 支付”；所以**不要沿用“iOS 端隐藏支付、引导加客服付款”的老套路**，那恰恰是 5.13 禁止的做法。

---

## 3. 服务类目、资质与备案

### 3.1 类目建议

| 类目 | 资质 | 适用范围原文 | 对本产品 |
|---|---|---|---|
| 商业服务 > 广告/设计 | 无 | “适用于提供商业广告、产品设计等相关等服务” | **主类目** |
| 商业服务 > 公关/推广/市场调查 | 无 | “适用于提供商业性质市场调研、推广、公关等服务” | 可选补充 |
| 商业服务 > 企业管理 | 无 | “适用于提供企业办公工具/办公管理、门店信息管理、展示等服务” | 谨慎：在虚拟支付管控表中“企业管理”被列在工具项下 |
| 文娱 > 其他视频 | 6 选 1：《信息网络传播视听节目许可证》/《广播电视节目制作经营许可证》等 | “适用于提供视频播放、观看等服务…”；首次提审需当地互联网主管机关确认，约 7 天 | 仅当审核要求时再补；注意它在虚拟支付管控类目表里 |
| 文娱 > 微短剧 | 《视听许可证》或备案，或一整套登记表 + 《广播电视节目制作经营许可证》等 | “适用于提供网络微短剧视频播放、观看等服务” | **不要申请** |
| 深度合成 > AI 创作等 | 算法备案（自研）或技术方备案 + 合作协议 | AI 生成内容须显著标注 | 见 3.3 |

来源：https://developers.weixin.qq.com/miniprogram/product/material/

### 3.2 “微短剧”类目是否会被触发

- 【已核实】微短剧类目备注：①需在广电系统完成信息备案批复；②通过后“如需实现安卓等非 iOS 端的小程序内购买交易，开发者需配置接入小程序虚拟支付”；③“类目申请通过后，播放管控能力将同步生效，账号内**仅支持播放官方过审链接**，未经平台审核的内容将无法正常播放”；④“如误申请通过导致相关能力被封禁，可自行删除类目解除封禁”。运营规范 5.33 还专门禁止微短剧/小说类小程序绕开虚拟支付。来源同 3.1；https://developers.weixin.qq.com/miniprogram/product/ （#5.33）
- 《微信公众平台微短剧小程序运营指引》现行版在 docs.qq.com（https://docs.qq.com/doc/DTXFMZmp1ZE9UVnpM ），**未能抓取**；2023 年版转载（https://www.sohu.com/a/680777982_121711176 ）的定义是“单集几十秒到 15 分钟左右、真人出演、主题明确、情节较连续完整的网络剧”，适用对象是“提供微短剧播出服务的小程序”，未提预告片。
- 判断【推断 + 不确定】：本小程序不向消费者提供剧集播放，只放**预告片**（原型 `Detail.txt:15`“预告片 01:12”）和**商家自己订单的样片**（确认用）。按字面不属于“提供微短剧播放、观看服务”。但审核是人判的：商城页如果做成“全屏竖滑的短剧流”，被要求补「文娱-微短剧/其他视频」的风险明显上升。剧目备案号、《网络剧片发行许可证》属于内容合规（PRD §10.3），是**后台短剧库**的上架必填项，不是小程序类目资质。

### 3.3 视频播放、上传与 AI

- 【已核实】官方《关于小程序使用“视频类插件”的规范》（2022-03-29）：自身有合规主营业务、视频只是**补充服务**的小程序（举例：电商、餐饮、房地产、教育）可以播视频而无需视频类目；“将视频播放、观看服务作为主要服务内容”的要补「文娱-其他视频」；“将视频内容作为全部服务内容/视频集合”的要补「文娱-视频广场」；简单加内容规避、隐藏路径对抗会被处罚。来源：https://developers.weixin.qq.com/community/minihome/doc/000e465b3fc3b0765cbd57e8f57809
- 设计约束【推断】：
  1. 商城/详情以**图文卡片为主、预告片为辅**；预告片时长短、每部 1 条，不做连续剧集播放；样片仅订单归属商家可见。
  2. 审核规范 3.5.2“**禁止视频、音乐、语音等多媒体的自动播放**”（https://developers.weixin.qq.com/miniprogram/product/reject.html ）。PRD §6.5-3“预告片模式：默认静音自动播放”与之冲突，建议改为点击播放，或至少首屏不自动播、把自动播放做成服务端开关。
  3. 平台若持有《广播电视节目制作经营许可证》，把它备好：万一被要求补「文娱-其他视频」可以较快补上（但要同时保留「商业服务-广告/设计」，避免落入“仅含虚拟类目”）。
- 上传素材（图片/视频/录音/文档/文字，PRD §6.16.3）是**不公开**的商家私有内容，类目上不触发“社交-笔记”等 UGC 类目（「图片处理」类目注释也区分了“不适用于传播分享、公开访问”）【推断】。运营规范 5.18 要求有内容安全过滤机制，参考工程已接 `msg_sec_check`（`docs/07-platform-config.md` 第 168 行附近），本项目沿用即可。
- AI【不确定】：原型在订购页出现“制作模型：标准/高级/顶级模型”（`Checkout.txt:37-40`），素材详情有“语音转文字与自动提炼的要点”（PRD §6.16.3）。「深度合成」类目要求算法备案材料，且 AI 生成内容须显著标注。若审核员认定小程序“向用户提供 AI 生成服务”，会要求补该类目。建议：小程序端把“模型”表述为“制作档位”，AI 生成的要点文本加“AI 生成”标识；同时让法务确认平台/技术方的《互联网信息服务算法备案》情况备用。

### 3.4 备案与认证（【已核实】）

- 小程序须完成 ICP 备案：新增（未上架）小程序自 2023-09-04 开放备案入口，未备案不能上架；从事“广播电影电视节目/网络视听节目”等需前置审批的服务，备案时要交《信息网络传播视听节目许可证》等前置审批文件。来源：https://developers.weixin.qq.com/miniprogram/product/record/record_guidelines.html
- 服务器域名必须 HTTPS、**经过 ICP 备案**、不能用 IP；`api.weixin.qq.com` 不能配为服务器域名（AppSecret 只能放后端）。来源：https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html
- 手机号组件、微信支付、web-view 都要求**非个人主体且已认证**的小程序（见第 4 节来源、web-view 文档 https://developers.weixin.qq.com/miniprogram/dev/component/web-view.html ）。
- 隐私：必须在后台配置《小程序用户隐私保护指引》，只有声明过的信息类型对应的接口/组件才可调用，未声明直接禁用；需同步用户同意状态（`wx.getPrivacySetting` / `agreePrivacyAuthorization`）。本项目至少涉及：手机号、相册（选择/写入）、摄像头、麦克风、剪贴板、选择聊天文件。来源：https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html
- 待确认：参考工程的小程序包描述就是“狸有戏微信小程序（Taro 4 · React 18 · NutUI）”（`apps/mobile/package.json`），其后台“服务类目：待核”（`docs/07-platform-config.md:23`）。新产品是**复用该 AppID 还是新开**，决定类目、备案、支付商户号、订阅模板是否要重做（见开放问题）。

---

## 4. 登录与手机号

### 4.1 规则（【已核实】）

- `wx.login()` 取临时 code（只能用一次）→ 服务端 `auth.code2Session` 换 `openid`、`session_key`、`unionid`（**小程序已绑定微信开放平台账号时才有**）。`session_key` 不得下发到小程序。来源：https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html
- UnionID：同一开放平台账号下的小程序/公众号/服务号/App/网站应用，用户 UnionID 唯一；绑定入口在“微信开发者平台 → 我的业务 → 开放平台 → 绑定关系 → 小程序”；`wx.login + code2Session` 无需用户授权即可拿到。来源：https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/union-id.html
- 手机号快速验证组件：`<button open-type="getPhoneNumber">` → 回调里的 `code`（**5 分钟有效、只能消费一次**，与 wx.login 的 code 不能混用）→ 服务端 `phonenumber.getPhoneNumber` 换手机号；新方式不需要先 wx.login。仅对**非个人主体且已认证**的小程序开放。平台“会对号码进行验证，但不保证是实时验证”；用户可选微信绑定号码，也可**自主添加其他号码**。来源：https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html
- 收费：自 2023-08-28 起**每次调用成功 0.03 元**（实时验证组件 0.04 元）；每个小程序账号 **1000 次体验额度**（正式/体验/开发版共用）；扣费节点是拿到 `bindgetphonenumber` 成功回调时；额度不足时错误码 `1400001`，可用 `phone-number-no-quota-toast=false` 自行兜底提示。来源同上；https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getRealtimePhoneNumber.html
- 运营规范 5.12.3：除非法律要求或用户同意，不得要求用户输入手机号才可使用功能；另有《关于小程序收集用户手机号行为的规范》（https://mp.weixin.qq.com/s/WHacxsm0J7D6Jb_Y_stdVA ）。PRD §6.1-2 的游客模式（未登录可浏览首页/商城/预告片）符合这一点。
- 运营规范 5.14.2：登录页、授权页、弹窗等界面“不得使用‘微信’‘腾讯’及其标识、近似标识或官方用语样式，使普通用户误认为该界面由腾讯提供或经腾讯授权；**包括调用手机号快速验证等能力组件的前置页面**”。原型按钮文案“微信手机号快捷登录”（`Login.txt:33,36`）、“微信手机号快捷验证并加入”（`Join.txt:29`）有被驳回风险，建议改为“手机号快捷登录”。

### 4.2 “一个手机号一个账号”的实现要点（【推断】）

1. 账号主键用自有 `user_id`；`phone` 唯一索引；另建 `user_wechat_identity(appid, openid, unionid, user_id)`，**一个账号可挂多个 openid**（老板换微信号、同手机号在另一微信登录），否则会出现“手机号已注册但这个微信登不进”的死结。
2. 登录流程：先 `wx.login` 静默换 openid → 命中身份表则直接发会话（**不花 0.03 元**）；未命中才展示手机号按钮 → 换到手机号后按 phone upsert 账号并绑定当前 openid。
3. 订阅消息只能发给 openid：发消息时取该账号**最近活跃的 openid**；订阅额度按 openid × 模板记账。
4. 用户在组件里可以选非微信绑定的号码（平台短信验证过），所以“登录手机号 ≠ 微信绑定手机号”是正常情况，不要用它推断微信身份。
5. 换绑（PRD §6.1-5“须验证原手机号或经人工审核”）：验证原手机号需要**自有短信验证码**通道（见第 8 节）；新手机号仍走组件。
6. 受邀加入（PRD §6.1-6、§6.16.2）：受邀者也走手机号组件；邀请 token 与手机号在服务端校验，不信任前端参数。
7. 成本：按 0.03 元/次，1 万次首登 300 元，可忽略；但要监控体验额度耗尽，后台提前购买资源包，否则登录按钮会直接报“使用次数已达上限”。
8. unionid：建议**上线前就把小程序绑定到开放平台**。它是三件事的前提：企业微信外部联系人与小程序用户对上号（6.2）、将来服务号模板消息（5.3）、V1.1 多端/PC 商家端同账号。参考工程里这一项也是“旧版记为已完成，待核”（`docs/07-platform-config.md:105`）。

---

## 5. 订阅消息

### 5.1 规则（【已核实】）

- 类型（https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html ）：
  - **一次性订阅**：“用户订阅后，开发者可不限时间地下发**一条**对应的服务消息；每条消息可单独订阅或退订。”
  - **长期订阅**：“目前长期性订阅消息仅向政务民生、医疗、交通、金融、教育等线下公共服务开放”；另有“长期订阅限频消息”，当前仅向金融等指定行业开放。
  - **新版一次性订阅（Beta，服务卡片）**：无需弹窗，以微信支付订单号或 `liveActivity` 按钮的 code 下发，平台定义模板；现有模板只覆盖购物、物流、保险、餐饮、酒店、机票、车票、景区、打车等类目（https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-2.html ），**没有商业服务/广告类**。
- 官方答复（知识库《【小程序-订阅消息】常见问题汇总 2026-2-16~2-22》）：“**商业服务类目不在长期订阅支持范围内**，上述场景建议通过一次性订阅或其他方式实现”；模板标题不能自定义，公共模板库没有合适的可提交新模板申请。来源：https://developers.weixin.qq.com/community/minihome/doc/000204f2f74468ac62b46dfaa6b009
- `wx.requestSubscribeMessage`（https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html ）：
  - 一次调用最多订阅 **5 条**模板（文档当前原文为“一次调用最多可订阅5条消息”）；一次性与长期模板不可混用；同一次调用里模板标题不能相同。
  - 2.8.2 起只有**用户点击或支付回调后**才能调起。
  - 返回每个模板 `accept / reject / ban / filter`。
  - 用户勾选“总是保持以上选择，不再询问”后，后续调用不再弹窗、沿用之前的选择。
- 下发：`POST /cgi-bin/message/subscribe/send`；日上限：开通支付的小程序 3 千万/日。用户订阅弹窗结果、在服务通知里拒收、下发结果都会以事件（`subscribe_msg_popup_event` / `subscribe_msg_change_event` / `subscribe_msg_sent_event`）推到开发者服务器。来源：https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message.html
- 模板来源：按小程序**所属类目**的公共模板库选用（`getpubtemplatetitles` 等接口），所以类目定了，可用模板集合也就定了。来源：https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/mp-message-management/subscribe-message/sendMessage.html

### 5.2 对 PRD 的影响

PRD 里依赖订阅消息的提醒：套餐到期前 7/3/1 天及当天（§2.2-7、§2.3-5）、建档审核结果（§6.3.5-2）、成片交付/上线日前 1 天/上线日当天（§6.10.1-1）、成员变动与素材反馈（§7.11-4）。

- 一次授权一条 → “到期前 7/3/1 天 + 当天”需要同一模板 **4 份额度**，用户不可能主动点 4 次；审核结果、交付通知这类“一次性结果”才是订阅消息的舒适区。
- 模板内容不能带营销性质，续费提醒要写成“服务到期提醒”而不是促销【推断】。

### 5.3 工程对策（【推断】）

1. **统一通知中心**：事件 → 渠道编排 → 发送记录。渠道优先级：站内消息中心（必达、无成本）→ 订阅消息（该 openid 该模板有额度才发）→ 短信（关键节点兜底）→ 企业微信应用消息推给服务经理，由人跟进。PRD §7.11-4 的“订阅消息与短信模板管理”对应这里的模板表。
2. **额度账本**：表 `subscribe_quota(openid, template_id, remaining)`。前端每次调用后上报结果，服务端同时消费 `subscribe_msg_popup_event` 做对账；发送成功减 1；收到 `43101`（用户拒绝或无额度）清零并走降级。
3. **多点蓄水**：在用户本来就要点的按钮上顺带请求订阅（支付成功回调、提交订购、确认方案、确认样片、点“下载成片”、回填链接、打开消息中心），每次带上 ≤5 个最相关模板。用户选过“总是保持”后，这些点击会静默累加额度。
4. 到期提醒分配：有几份额度发几次，优先保证“前 1 天”和“当天”；7 天、3 天缺额度时走短信 + 服务经理企微。
5. 订阅消息落地页版本：参考工程用 `miniprogram_state`（developer/trial/formal）控制点击后进哪个版本（`packages/services/src/providers/wechat/wechat.ts:8-16`），沿用。
6. 模板字段必须与后台模板逐字一致，否则 47003；模板未配置时全链路 no-op（参考工程的做法，`docs/07-platform-config.md:80,90`）。
7. 备选渠道评估：
   - **服务号模板消息**：需要已认证服务号、用户关注、用 unionid 把服务号 openid 与小程序账号对上；能力仍在（https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Template_Message_Interface.html ），但“小程序下发统一服务消息”接口已于 2023-09-20 收回（https://developers.weixin.qq.com/community/develop/doc/000ae8d6348af08e7030bc2546bc01 ）。服务号模板消息 2026 年的类目模板细则我没有逐条核对，【不确定】。建议放 V1.1 评估，不进 V1.0 关键路径。
   - **企业微信**：服务经理已加商家为好友（PRD §5.2 方案确认本来就走企微），到期提醒做成给服务经理的应用消息/待办最稳；企业群发给客户有频控（每位客户每天最多收 1 条群发，https://developer.work.weixin.qq.com/document/path/92135 ），只适合低频。

---

## 6. 客服与企业微信

### 6.1 在线客服：两条路

| 方案 | 接入 | 限制 | 来源 |
|---|---|---|---|
| 小程序客服消息 | `<button open-type="contact">`；消息/事件推到开发者服务器；可用官方网页客服工具或自建 | 用户发消息后 **48 小时内最多回 5 条**；用户进入会话后 1 分钟内可发 2 条 | https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/customer-message/customer-message.html ；https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/customer-message/send.html |
| 微信客服（企业微信体系） | `wx.openCustomerServiceChat({ extInfo:{url}, corpId, showMessageCard… })`，基础库 ≥2.19.0，**只能在点击事件里调用**；客服链接可由 `kf/add_contact_way` 带 `scene` 参数生成用于区分来源；可选“由企业微信接管”，员工在企业微信里接待，或用 API 自行分配会话、收发消息 | 不支持小程序插件内调用；需在小程序后台绑定企业 ID（【非官方】，多篇教程一致）；未认证企业的接待人数限制【不确定】 | https://developers.weixin.qq.com/miniprogram/dev/api/open-api/service-chat/wx.openCustomerServiceChat.html ；https://developer.work.weixin.qq.com/document/path/94638 ；https://developer.work.weixin.qq.com/document/path/94665 |

PRD §6.12-3 写的是“接入小程序客服消息；非工作时间自动回复，并引导提交工单”，§7.8-1 工单来源含“在线客服”。
**建议【推断】**：V1.0 用**微信客服**（企业微信接管）。理由：内部人员本来就在企业微信里（PRD §7.12-1 员工账号绑定企业微信）；微信客服自带接待人员、排队、欢迎语、非工作时间自动回复；需要把会话沉淀成工单时再接 `kf` API。若坚持 PRD 字面方案，就要自己实现客服工作台或让客服用官方网页客服工具，且受 48 小时/5 条限制。无论哪种，“在线客服→工单”在 V1.0 建议做成客服在后台**手动建单**，自动建单留到后续。

### 6.2 “添加服务经理企业微信”

资料：PRD §6.8-3 订购成功页有“添加服务经理企业微信”按钮；§6.12-2“展示姓名、企业微信二维码和电话，支持一键添加”；原型 `PayResult.txt:32-38`“长按识别二维码，添加服务经理”，`Service.txt:22-26`。

可行做法（【已核实】能力 + 【推断】方案）：

1. **「联系我」二维码（推荐主方案）**：`POST /cgi-bin/externalcontact/add_contact_way`，`type=1`（单人）、`scene=2`（二维码）、`user=[服务经理 userid]`、`state=<商家/主体 ID，≤30 字符>`、`skip_verify=true`；返回 `config_id` 与 `qr_code`。每企业 API 最多 50 万个；使用成员须已激活、实名并开通客户联系；`config_id` 要自己存好。来源：https://developer.work.weixin.qq.com/document/path/92228
   - 小程序里用 `<image show-menu-by-longpress>` 展示。官方“支持长按识别的码”表含**企业微信个人码（基础库 ≥2.18.0）**；企业微信文档也写明微信 iOS 8.0.6 / 安卓 8.0.3 及以上可在小程序内直接长按识别「联系我」二维码。来源：https://developers.weixin.qq.com/miniprogram/dev/component/image.html ；https://developer.work.weixin.qq.com/document/path/93582
   - 客户添加后，企业微信回调“添加企业客户”事件并带回 `state` → 自动建立 商家 ↔ external_userid ↔ 服务经理 的绑定；交付经理转移（PRD §7.4-4）时为新经理重新生成码并更新商家端展示。
2. **「联系我」小程序插件（一键，体验更顺）**：`scene=1` 配成按钮；小程序添加插件 `wx104a1a20c3f81ec2`（contactPlugin，文档示例版本 1.4.3，无需审核），页面放 `<cell plugid="…">`；回调能区分“已是好友”（-3006）。来源：https://developer.work.weixin.qq.com/document/path/93582
3. **获客助手链接**：`externalcontact/customer_acquisition/*` 接口可创建获客链接（https://developer.work.weixin.qq.com/document/path/97297 ）；计费为 50 次免费后约 1 元/次【非官方，https://open.work.weixin.qq.com/help2/pc/20713 及多篇文章】；从小程序内直接打开获客链接是否可行【不确定】。V1.0 不建议。
4. 身份打通：`add_contact_way` 的 `unionid` 等能力要求“企业微信客户联系中已绑定微信开发者账户”；外部联系人详情里的 unionid 只有在企业微信与小程序/开放平台主体打通时才返回。**企业微信主体、小程序主体、开放平台主体最好是同一家公司**（见开放问题）。

### 6.3 员工账号绑定企业微信、内部通知

- **后台登录/二次验证**：企业微信 Web 登录，构造 `https://login.work.weixin.qq.com/wwlogin/sso/login?login_type=CorpApp&appid=CORPID&agentid=AGENTID&redirect_uri=…&state=…`，或用 `@wecom/jssdk ≥2.3.2` 的 `ww.createWWLoginPanel` 内嵌扫码面板；回调拿 `code` → `GET /cgi-bin/auth/getuserinfo` 得 `userid`（code 一次性、5 分钟过期）；`redirect_uri` 域名须配置为应用可信域名。来源：https://developer.work.weixin.qq.com/document/path/98152 ；https://developer.work.weixin.qq.com/document/path/91023
  - PRD §10.2-4“后台登录须二次验证”可以直接落为“账号密码 + 企业微信扫码”，或只用企业微信扫码登录【推断】。
- **绑定方式**：员工表存 `wecom_userid`。首次绑定走扫码最稳；也可用“手机号获取 userid”`POST /cgi-bin/user/getuserid`，但要求应用对该成员有查看权限，且“出错次数超出企业人数上限的 20% 会导致 1 天不可调用”。来源：https://developer.work.weixin.qq.com/document/path/95402
- **通知内部员工**：`POST /cgi-bin/message/send`（文本、文本卡片、模板卡片、小程序通知等）；频率：每应用每天 ≤ 账号上限数 × 200 人次，对同一成员 ≤30 次/分钟、1000 次/小时，超出丢弃；官方建议避开整点与半点；支持 `enable_duplicate_check`。来源：https://developer.work.weixin.qq.com/document/path/90236
  - 适用场景【推断】：新工单分配、SLA 超时升级（PRD §7.8-4）、待审核建档、对公收款待确认、上线逾期跟进、套餐到期跟进。
- **部署约束**：自建应用调用接口需配置**企业可信 IP**（否则 60020），而配置可信 IP 前要先设可信域名或接收消息 URL【非官方，多篇教程一致，如 https://cloud.baidu.com/article/3382171 】→ 服务器出口 IP 要固定。
- 参考工程现状：没有任何企业微信集成（全仓检索 `wecom|qyapi|work.weixin` 无命中，仅有小程序侧 provider），这部分是新增模块。

---

## 7. 文件与媒体

### 7.1 平台硬限制（【已核实】）

| 能力 | 限制 | 来源 |
|---|---|---|
| 合法域名 | request / uploadFile / downloadFile / socket 域名都要在后台配置；仅 HTTPS/WSS；域名须 ICP 备案；不支持 IP；配置了端口就只能访问该端口；不能配父域名通配子域名 | https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html |
| 并发 | `wx.request`、`wx.uploadFile`、`wx.downloadFile` 合计最大并发 **10** | 同上 |
| 后台 | “小程序进入后台运行后，如果 **5s** 内网络请求没有结束，会回调错误信息 fail interrupted；在回到前台之前，网络请求接口调用都会无法调用” | 同上 |
| 超时 | 默认 60s，可在 app.json `networkTimeout` 或单次调用 `timeout` 配置 | 同上 |
| downloadFile | “单次下载允许的最大文件为 **200MB**”；HTTPS GET；需正确的 Content-Type | https://developers.weixin.qq.com/miniprogram/dev/api/network/download/wx.downloadFile.html |
| uploadFile | HTTPS POST、`multipart/form-data`；**API 文档未写大小上限**；微信官方开源库 README 写“wx.uploadFile 接口有大小限制（10M），采用分块上传解决” | https://developers.weixin.qq.com/miniprogram/dev/api/network/upload/wx.uploadFile.html ；https://github.com/wechat-miniprogram/miniprogram-file-uploader |
| 读文件 | `FileSystemManager.readFile`：“**单个文件大小上限为 100M**”；2.10.0 起支持 `position/length` 分段读 | https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readFile.html |
| 本地存储 | 临时文件运行时最多 4GB，退出后超过 2GB 会按最近使用清理；缓存文件 + 用户文件合计最多 200MB | https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html |
| 存相册 | `wx.saveVideoToPhotosAlbum`：“保存视频到系统相册。**支持 mp4 视频格式**”；需 `scope.writePhotosAlbum` 授权 | https://developers.weixin.qq.com/miniprogram/dev/api/media/video/wx.saveVideoToPhotosAlbum.html |
| 选媒体 | `wx.chooseMedia`：一次最多 20 个（2.25.0 起）；**拍摄**视频 `maxDuration` 3–60 秒，相册不限时长；`sizeType` 可选 compressed | https://developers.weixin.qq.com/miniprogram/dev/api/media/video/wx.chooseMedia.html |
| 选聊天文件 | `wx.chooseMessageFile`：一次 0–100 个，可按类型/扩展名过滤 | https://developers.weixin.qq.com/miniprogram/dev/api/media/image/wx.chooseMessageFile.html |
| 录音 | `RecorderManager.start`：`duration` 默认 60000ms，**最大 600000ms（10 分钟）**；格式 mp3 / aac / wav / PCM；采样率 8k–48k，与码率有对应范围；`frameSize` 分片回调仅 mp3、pcm | https://developers.weixin.qq.com/miniprogram/dev/api/media/recorder/RecorderManager.start.html |
| video 组件 | 支持 mp4、m3u8 等；编码 H.264；`referrer-policy` 默认 no-referrer，可设 origin（Referer 固定为 `https://servicewechat.com/{appid}/{version}/page-frame.html`） | https://developers.weixin.qq.com/miniprogram/dev/component/video.html |
| 转发文件 | `wx.shareVideoMessage`（转发视频到聊天）、`wx.shareFileMessage`（转发文件到聊天），基础库 ≥2.16.1，入参为本地路径 | https://developers.weixin.qq.com/miniprogram/dev/api/share/wx.shareVideoMessage.html ；…/wx.shareFileMessage.html |
| PC 端 | `wx.saveFileToDisk`：保存到用户磁盘，**仅 PC 端（Windows/Mac 微信）支持** | https://developers.weixin.qq.com/miniprogram/dev/api/file/wx.saveFileToDisk.html |
| web-view | 需配置业务域名；JSSDK 接口有限，**没有通用文件下载能力**；个人主体不可用 | https://developers.weixin.qq.com/miniprogram/dev/component/web-view.html |

iOS 存相册的经验性约束【非官方】：iOS 相册要求 H.264 编码的 mp4/mov，H.265 或异常封装会报 `saveVideoToPhotosAlbum:fail invalid video`（https://blog.csdn.net/qq_49661519/article/details/139349977 等）。

### 7.2 成片下载：现实可行路径与推荐

资料事实：PRD §6.10.1“成片包：按集下载或打包下载；下载链接 7 天有效，过期可重新生成”；§10.2-2“成片包下载链接签名、7 天有效，仅订单商家及其授权的服务商可下载”；原型 `Publish.txt:95-96` 显示“80 个视频 · 约 2.6 GB · 7 天内有效”“60 个视频 · 约 1.9 GB”，每部剧只有一个“下载”按钮（`Publish.txt:38-39`）。折算约 32MB/集。

逐条评估：

| 路径 | 可行性 | 说明 |
|---|---|---|
| A. 小程序内**打包下载 zip** | 不可行 | 超 200MB 上限；zip 进不了相册；iOS 上没有解压去处 |
| B. 小程序内**逐集下载并存相册** | 可行，体验一般 | 单集必须 ≤200MB 且为 H.264 mp4；80 集约 2.6GB 要求用户全程停在前台、不锁屏（切后台 5 秒中断）；临时文件要边存边删，否则顶到 4GB/2GB 清理线；之后还要在抖音/视频号 App 里从相册逐集选 80 次 |
| C. **电脑端提取页**（复制链接到电脑浏览器） | 可行，推荐给整部剧发布 | 抖音创作者服务平台、视频号助手都有 PC 网页上传；电脑上一次下 zip、批量拖拽上传，比手机高效得多 |
| D. PC 微信里打开小程序 → `saveFileToDisk` | 可行，可选 | 省去复制链接，但逐文件保存、仍受 200MB 限制 |
| E. `shareVideoMessage` 转发到“文件传输助手” | 仅适合单集应急 | 逐集操作，聊天视频可能被压缩【不确定】 |
| F. 第三方网盘 | 不建议产品化 | 不受控、与“签名 7 天有效、仅订单商家可下载”的安全要求冲突；可作为服务经理人工兜底 |

**推荐方案【推断】：B + C 双路径，C 为主推。**

1. **转码规格是硬约束**：成片每集输出 H.264 + AAC、mp4（`moov` 前置/faststart）、单文件 ≤200MB（按原型量级目标 ≤100MB）。这条要写进交付质检清单和转码模板。
2. **手机路径（B）**：下载管理器——并发 2–3（留出并发额度给其他请求）、逐集状态（待下载/下载中/已存相册/失败可重试）、断点粒度为“集”；每集 `downloadFile → saveVideoToPhotosAlbum → 删除临时文件`；`wx.setKeepScreenOn`；首次触发前处理 `scope.writePhotosAlbum` 拒绝后的 `openSetting` 引导；监听 `onAppHide` 提示“请勿切到后台”。埋点 `package_download`（PRD §9.3）按集上报。
3. **电脑路径（C）**：小程序里提供“在电脑上下载”——生成**提取链接 + 提取码**（或短链 + 一次性二维码），`wx.setClipboardData` 复制；H5 提取页部署在**独立的下载域名**（不走 web-view），校验提取码与有效期后给出：整部 zip（服务端异步打包到对象存储）与逐集签名直链。链接 7 天有效、可在小程序里“重新生成”（旧链接作废），访问与下载留痕。
4. 抖音/视频号一次性上线 40–80 集的操作成本主要在“上传发布”而非“下载”，所以发布指引（PRD §6.10.1“图文步骤”）应**以电脑端发布为主线**来写。
5. 下载域名要加入 downloadFile 合法域名；CDN 防盗链用**签名 URL**为主（小程序的 Referer 固定且可预测，只能作辅助）。

### 7.3 素材上传

资料事实：PRD §10.1“图片单张 ≤5MB，超出先压缩；视频单个 ≤200MB，支持断点续传”；PRD §6.16.3“拍摄视频最长 60 秒，相册视频单条不超过 5 分钟、**500MB**；录音单条最长 5 分钟”。两处视频上限不一致（200MB vs 500MB）。原型 `AssetUpload.txt:67-70` 的音频/文档标注“来自微信聊天”（即 `chooseMessageFile`）。

- 拍摄 60 秒与 `chooseMedia` 的 `maxDuration` 上限 60 秒一致 ✔。录音 5 分钟在 10 分钟上限内 ✔。
- 上传方式建议【推断】：**前端直传对象存储**（服务端签发 POST Policy，小程序 `wx.uploadFile` 表单直传），与参考工程一致（`apps/api/package.json` 依赖 `@aws-sdk/s3-presigned-post`）。对象存储域名加入 uploadFile 合法域名。
- 大文件的三个不确定点：
  1. `wx.uploadFile` 单文件上限：API 文档未写，官方开源库 README 称 10M；实践中直传几十上百 MB 的案例很多。【不确定】，**必须真机验证 200MB 直传**（iOS/安卓、4G/Wi-Fi、超时设置）。
  2. “断点续传”只能靠分片：`readFile(position,length)` 分块 + `wx.request` 逐片 PUT（S3/COS 分片上传）。但 readFile 写着“单个文件大小上限为 100M”，对 >100MB 文件做分段读是否受限【不确定】，需真机验证。
  3. 所以 500MB 相册视频在小程序里**没有被官方文档保证的上传路径**。
- 建议：V1.0 把相册视频上限统一为 **200MB**，选取时用 `sizeType:['compressed']`（或 `wx.compressVideo`）先压缩；≤100MB 走分片可续传，100–200MB 走整文件直传 + 失败重传；超限提示“请发给服务经理”（企业微信传文件）。等真机结论出来再决定是否放宽到 500MB。
- 录音：建议 `format: 'aac'` 或 `'mp3'`、16k 采样、单声道（转写够用、体积小）；需要 `scope.record` 与隐私指引声明；来电/切后台会中断，要处理 `onInterruptionBegin/End` 与分段保存【推断】。参考工程录音走“微信同声传译”插件边录边识别（`docs/07-platform-config.md:96`），本项目 PRD 是“上传后语音转文字”（§6.16.3），可沿用参考工程的腾讯云 ASR provider（`packages/services/src/providers/asr/tencent.ts`）。

### 7.4 邀请卡片（转发给好友，24 小时失效）

资料：PRD §6.16.2“以小程序卡片发送给微信好友，24 小时内有效；待接受的邀请占成员名额”；原型 `Invite.txt:26-30`、`Join.txt:29`。

- 【已核实】转发：`<button open-type="share">` 触发 `Page.onShareAppMessage`，返回 `title / path / imageUrl`；不自定义图片时默认截取页面顶部。运营规范 5.1 禁止强制/诱导分享。来源：https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/share.html ；https://developers.weixin.qq.com/miniprogram/product/ （#5.1）
- 【已核实】平台**没有“卡片过期”能力**，也拿不到“发给了谁”。可选的增强是**私密消息**：服务端 `createActivityId` → `wx.updateShareMenu({ isPrivateMessage:true, activityId, withShareTicket:true })`，私密消息“具有不可二次转发性”，接收方进入后用 `wx.authPrivateMessage` 校验自己是否为直接接收者；`activityId` 创建后 7 天内分享有效。来源：https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/share/private-message.html
- 实现【推断】：
  1. 服务端生成邀请记录 `invite(id, token, store_id, inviter_id, expires_at = now + 24h, status: pending/accepted/revoked/expired)`，创建即占成员名额；`path = /pages/join/index?t=<token>`。
  2. 受邀页先用 token 取邀请摘要（门店、邀请人、是否有效）→ 用户同意协议 → 手机号组件 → 服务端校验 token 未过期/未撤回/名额未超 → 加入并置 `accepted`（单次有效）。
  3. 过期由服务端判定（读时判断 + 定时任务释放名额），卡片本身仍可点开，落地页显示“邀请已失效”。
  4. 想防二次转发再叠加私密消息；V1.0 可以不做，因为 token 单次有效 + 老板可撤回已足够。
  5. 来源追踪（PRD §6.1-4 渠道码、邀请码）同理走 path 的 query 或小程序码 scene，服务端落库，不信任前端自报。

---

## 8. 短信（国内通知/营销）

以腾讯云短信为例（参考工程已有 `packages/services/src/providers/sms/tencent.ts`；其生产环境仍是 `SMS_DRIVER=console`，“签名与 3 个模板旧版记为已完成，待核”，`docs/07-platform-config.md:113,177`）。

【已核实】
- **签名类型收紧**：腾讯云 2026-04-20 公告《【国内短信】关于腾讯云短信签名申请规则更新的公告》——签名仅支持**公司、政府/机关事业单位/其他机构、商标**三类；**APP、网站、小程序、公众号等类型不再支持**；不合规签名“可以请求成功，但会大概率被运营商拦截发送失败”；优先推荐公司类、机构类。来源：https://cloud.tencent.com/announce/detail/2256
- 申请签名前要先完成**实名资质报备**；平台审核约 2 小时（工作日 9:00–21:00，周末 9:00–18:00）；审核通过后还需**运营商实名报备，通常 7–10 个工作日**，实际可能更长；长期不用的签名可能被运营商停用，建议保持发送。来源：https://cloud.tencent.com/document/product/382/37794 ；https://cloud.tencent.com/document/product/382/108275
- 营销短信仅企业认证用户可发，发送时段 8:00–22:00，须带退订方式；验证码变量最多 6 位数字；不支持全变量模板。来源：https://cloud.tencent.com/document/product/382/13444

对本项目【推断】：
1. 签名“狸有戏”属于**商标类**（需要商标注册证明）或改用**公司全称/简称**；现有签名若是按“小程序/APP”类型申请的，需要重新申请。这是有 1–2 周前置期的上线阻塞项。
2. 短信用途与模板清单：验证码（换绑手机号、后台二次验证备用）、通知类（建档审核结果、成片交付、上线提醒、套餐到期提醒、成员变动）。**到期续费提醒要按“服务通知”写，不带促销用语**，否则会被归为营销短信，受时段与退订要求约束。
3. 模板与变量在后台“消息模板”里维护（PRD §7.11-4），但模板本身要在云厂商侧预先审核，后台只做“模板 ID ↔ 事件 ↔ 变量映射”，不能自由编辑正文。
4. 频控、黑名单、发送记录、失败重试进通知中心统一处理；同一事件对同一手机号做幂等去重。

---

## 9. 视频号运营者机制、抖音代发布（核对 PRD §10.4）

| 平台 | PRD §10.4 的说法 | 核对结果（2026-10-02） | 来源 |
|---|---|---|---|
| 抖音 | “代替用户发布内容到抖音”能力的开发者主体须为党政机关或事业单位，仅支持内部多媒体管理平台，不可面向 C 端 | **仍成立**。能力页原文要点：开发者主体需为党政机关或事业单位；应用类型为正式**网站应用**；仅可在网站应用电脑端授权使用；场景仅限政务或媒体机构内部多媒体管理平台，不可对外面向 C 端用户；测试阶段 | https://developer.open-douyin.com/capacity-center-page/capacity-detail/7224121299067469881 |
| 抖音 | 不得大量发布同质化内容 | **仍成立**。规范原文：禁止“大量发布同质化内容，包括但不限于：同个账号多次发布相似视频、相似视频发布到多个账号上”；另要求“仅可用于企业内部或者签约的账号的内容管理”“实时发布或者预设发布需要用户自己在第三方应用上进行操作” | https://developer.open-douyin.com/docs/resource/zh-CN/dop/operation-standard/platform-capabilities/usage-spec |
| 视频号 | 已认证的视频号可由管理员设置最多 20 个运营者微信号，运营者可在视频号助手登录、发表、互动 | **基本成立，有两处需修正/待核**：①“每个视频号可由管理员设置 20 个运营者微信号，运营者可进行除账号设置外的所有操作，如登录、发表、互动、直播管理等”——这是视频号助手界面文案，见于多个社区帖的转述，我没有直接登录视频号助手核对；②PRD 引用的链接实际是一个用户提问帖（“视频号绑定的运营者可以发起直播吗？”），不是官方规则页；③“仅适用于已认证的视频号”我**没有查到出处，【不确定】** | https://developers.weixin.qq.com/community/minihome/doc/000882f50cc5304afd82eecd46b800 ；https://developers.weixin.qq.com/community/minihome/doc/000ae02293c890c8a9aef397c5b800 |

对 V1.1 代发布的补充提醒：
- 一个微信号最多能当多少个视频号的运营者：社区提问帖在问（https://developers.weixin.qq.com/community/develop/doc/000a48bbe801d01235a12eff76b000 ），搜索摘要称“个人微信号支持绑定 20 个视频号的运营者”，**无官方明文，【不确定】**。如果属实，平台代发布需要按“每 20 个商家视频号 1 个运营微信号”准备账号池，并做授权记录与回收管理（PRD §10.2-3）。
- 视频号没有面向第三方的视频发表开放接口（本次未查到任何官方发布接口文档；视频号开放能力集中在小店、直播、橱窗等），代发布只能是**人在视频号助手里操作**，系统侧做的是任务、凭证与核验留痕【推断】。
- 结论：V1.0“商家自助发布 + 回填链接 + 人工核验”的路线不用改；后台的“发布管理”不要预设任何自动发布接口。

---

## 10. 与参考工程的对齐点（供架构设计引用）

| 主题 | 参考工程现状 | 本项目建议 |
|---|---|---|
| 小程序框架 | Taro 4.2.1 + React 18 + NutUI（`apps/mobile/package.json`） | 可沿用；本报告涉及的原生能力（手机号组件、订阅、下载队列、录音、分享、插件）Taro 均可直接调用 wx API |
| 微信服务端接口 | 自研 provider：code2session / 手机号 / 订阅消息 / 内容安全，access_token 存 Redis，错误码分类重试（`packages/services/src/providers/wechat/wechat.ts`） | 复用该模式；新增 `WechatPayProvider`、`WecomProvider`（联系我、应用消息、Web 登录、微信客服） |
| 短信 | 腾讯云短信 provider 已有，生产未启用（`docs/07-platform-config.md:113`） | 复用；先解决签名类型与报备 |
| 对象存储直传 | S3 兼容 presigned POST（`apps/api/package.json`） | 复用；补“签名下载链接 + 提取页 + 异步打包” |
| 异步任务 | BullMQ（`apps/api/package.json`、`apps/worker`） | 支付回调后处理、账单对账、通知降级、到期扫描、zip 打包都放队列 |
| 平台配置清单 | `docs/07-platform-config.md` 的核对表写法 | 新项目照此建一份：类目、备案、隐私指引、域名、订阅模板、插件、开放平台绑定、商户号、企业微信应用、短信签名模板 |
| 支付 | **无**（全仓未见微信支付代码） | 全新模块，是 V1.0 技术评审重点（PRD §11.2-3 也把“支付、套餐与积分账户”列为评审项） |

---

## 11. 风险与 PRD 冲突清单

1. 【高】“会员套餐 + 积分充值”被认定为虚拟支付 → iOS 须走 Apple 支付（12%）、对公转账入口可能被视为违规引导；官方无“B2B 服务豁免”明文。
2. 【高】类目选错（工具-企业管理/办公、文娱类）会导致普通微信支付被关闭；误申请「文娱-微短剧」会锁死播放与支付。
3. 【高】原型“成片包一键下载（2.6GB）”在小程序内无法实现；需改为逐集存相册 + 电脑端提取页；并对转码输出提出“单集 ≤200MB、H.264 mp4”硬约束。
4. 【中】PRD §6.5“预告片默认静音自动播放”与审核规范 3.5.2 冲突。
5. 【中】登录按钮文案“微信手机号快捷登录”与运营规范 5.14.2 冲突。
6. 【中】订阅消息一次一条、商业服务类目无长期订阅 → 到期 4 次提醒、上线提醒不能只靠订阅消息；PRD 写的“通过订阅消息和短信提醒”要落成多通道降级 + 额度账本。
7. 【中】PRD 内部不一致：视频上传上限 §10.1 写 200MB、§6.16.3 写 500MB；且“断点续传”在小程序里没有官方保证的 >100MB 方案。
8. 【中】7.2 万/14.4 万年付超出多数银行卡单笔限额，微信支付成功率不可预期；对公转账人工确认的时效直接影响开通体验。
9. 【中】短信签名新规（2026-04-20）+ 运营商报备 7–10 工作日，是上线前置项；“狸有戏”签名需要商标或改公司名。
10. 【中】微信支付新商户默认公钥模式，选错 SDK（如停更的 wechatpay-node-v3）会在验签/证书下载上踩坑。
11. 【中】小程序展示“制作模型/AI 提炼要点”可能触发「深度合成」类目与算法备案要求。
12. 【低】手机号组件体验额度 1000 次耗尽后未购买资源包会导致无法登录。
13. 【低】企业微信自建应用需可信 IP，服务器出口 IP 须固定；企业微信/小程序/开放平台主体不一致会让 unionid 打通失败。
14. 【低】微信支付退款仅支持支付后 1 年内；账单 API 只留 3 个月。
15. 【低】V1.1 视频号代发布受“每号 20 个运营者”及（未证实的）“每微信号可运营的视频号数量”限制，需要运营账号池。

---

## 12. 需要拍板/进一步确认的问题

1. 小程序主体与 AppID：复用参考工程那个“狸有戏”小程序，还是新开？主体是否与企业微信、开放平台、微信支付商户号、短信签名资质为同一家公司？
2. 是否接受把“会员套餐/积分充值”改为“营销服务套餐/服务额度（预付款）”等去虚拟化表述，发票项目改为“广告制作服务费/营销服务费”？（涉及产品、财务、法务）
3. 若提审被判定为虚拟支付：接受“小程序内不售卖，线下签约 + 对公收款”的方案 B 吗？还是接受 Apple 12% 抽成（并限制 iOS 只卖小额）？
4. ≥5 万元付款单是否默认只给对公转账？对公到账确认的 SLA 是多少？是否要在 V1.0 就做转账附言码与（后续）银企直连预留？
5. 平台是否持有《广播电视节目制作经营许可证》/《信息网络传播视听节目许可证》？（决定被要求补「文娱-其他视频」时能否应对）
6. 预告片是否可以改为点击播放（取消默认自动播放）？商城是否避免全屏竖滑视频流形态？
7. 素材视频上限定 200MB 还是 500MB？是否接受 V1.0 先 200MB、超限走服务经理？
8. 在线客服用“微信客服（企业微信）”还是 PRD 字面的“小程序客服消息”？在线会话是否需要自动生成工单？
9. 短信签名用商标“狸有戏”（是否已注册商标）还是公司名？哪些事件必须短信兜底（成本与打扰度）？
10. 是否在 V1.0 就开通认证服务号用于模板消息触达，还是留到 V1.1？
11. 小程序端是否展示“模型/AI”字样？平台或技术方是否已有生成合成类算法备案？
12. 电脑端提取页（下载域名、提取码、zip 异步打包）是否纳入 V1.0 范围？发布指引是否以电脑端发布为主线？
13. 后台登录的二次验证是否直接采用企业微信扫码？

---

## 13. 需真机/提审验证的技术点（上线前 Spike 清单）

| # | 验证项 | 方法 |
|---|---|---|
| 1 | 虚拟支付定性 | 用最小可提审版本（类目=商业服务-广告/设计，含套餐付款页）提审；同时向平台咨询 |
| 2 | `wx.uploadFile` 直传 100MB/200MB 视频到对象存储的成功率与耗时 | iOS/安卓 × Wi-Fi/4G，调大 timeout |
| 3 | `readFile(position,length)` 对 >100MB 文件能否分段读 | 真机 |
| 4 | 逐集下载存相册：80 集约 2.6GB 的完整耗时、切后台中断恢复、临时文件清理 | 真机，含 iOS 低存储场景 |
| 5 | 成片编码在 iOS 存相册是否报 invalid video | 用实际转码模板产物测试 |
| 6 | 小程序内长按识别「联系我」二维码、插件一键添加、加好友回调带 state | 企业微信测试企业 |
| 7 | 微信支付公钥模式下的验签、回调、退款、账单下载全流程 | 用真实商户号小额测试 |
| 8 | 单笔 5 万以上微信支付的实际成功率 | 用不同银行卡试付后退款 |
| 9 | 订阅消息“总是保持以上选择”后静默累加额度的实际行为 | 真机，对照 `subscribe_msg_popup_event` |
| 10 | 一个微信号可作为多少个视频号的运营者 | 视频号助手实测（V1.1 前） |

---

## 14. 主要来源一览（查证日期均为 2026-10-02）

微信小程序
- 运营规范（5.1/5.12/5.13/5.14/5.33）：https://developers.weixin.qq.com/miniprogram/product/
- 审核常见拒绝情形（3.5.2）：https://developers.weixin.qq.com/miniprogram/product/reject.html
- 服务类目与资质：https://developers.weixin.qq.com/miniprogram/product/material/
- 备案指引：https://developers.weixin.qq.com/miniprogram/product/record/record_guidelines.html
- 虚拟支付产品文档：https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html
- 虚拟支付技术服务费：https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/devplan.html
- 虚拟支付业务运营指南（官方）：https://developers.weixin.qq.com/community/minihome/doc/00002cf077cd4810fee42f4b865c01
- iOS 虚拟支付能力指引（官方，02-11）：https://developers.weixin.qq.com/community/minihome/doc/0004a2d3214e90c38ea4e0fa661401
- iOS 渠道费率调整通知（官方，03-13）：https://developers.weixin.qq.com/community/minihome/doc/000a04a261c0f0d5edc4972a96f401
- 视频类插件规范（官方）：https://developers.weixin.qq.com/community/minihome/doc/000e465b3fc3b0765cbd57e8f57809
- 登录 / UnionID / 手机号：…/framework/open-ability/login.html ；…/union-id.html ；…/getPhoneNumber.html ；…/getRealtimePhoneNumber.html
- 订阅消息：…/framework/open-ability/subscribe-message-overview.html ；…/subscribe-message.html ；…/subscribe-message-2.html ；…/api/open-api/subscribe-message/wx.requestSubscribeMessage.html ；常见问题 https://developers.weixin.qq.com/community/minihome/doc/000204f2f74468ac62b46dfaa6b009
- 客服：…/framework/open-ability/customer-message/customer-message.html ；…/customer-message/send.html ；…/api/open-api/service-chat/wx.openCustomerServiceChat.html
- 网络/文件/媒体：…/framework/ability/network.html ；…/framework/ability/file-system.html ；…/api/network/download/wx.downloadFile.html ；…/api/network/upload/wx.uploadFile.html ；…/api/file/FileSystemManager.readFile.html ；…/api/media/video/wx.saveVideoToPhotosAlbum.html ；…/api/media/video/wx.chooseMedia.html ；…/api/media/recorder/RecorderManager.start.html ；…/component/video.html ；…/component/image.html ；…/component/web-view.html
- 转发：…/framework/open-ability/share.html ；…/share/private-message.html
- 隐私：…/framework/user-privacy/PrivacyAuthorize.html
- B2b 门店助手：https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/industry/B2b_store_assistant.html
（“…”＝https://developers.weixin.qq.com/miniprogram/dev）

微信支付
- 下单 4012791897、调起 4012791898、查单 4012791900、关单 4012791901、支付回调 4012791902、退款 4012791903、退款回调 4012791906、开发指引 4012791911、账单产品介绍 4013071215、申请交易账单 4013071227、公钥常见问题 4013038816、证书切公钥 4012154180（前缀 https://pay.weixin.qq.com/doc/v3/merchant/ ）；新商户默认公钥 https://pay.weixin.qq.com/doc/v3/partner/4015419376 ；官方 SDK 列表 https://pay.weixin.qq.com/docs/partner/sdk-tools/sdk-tool.html

企业微信
- 联系我 92228、联系我插件 93582、获客链接 97297、应用消息 90236、Web 登录 98152、获取访问用户身份 91023、手机号取 userid 95402、微信客服概述 94638、客服链接 94665、企业群发 92135（前缀 https://developer.work.weixin.qq.com/document/path/ ）

其他
- 腾讯云短信：https://cloud.tencent.com/announce/detail/2256 ；https://cloud.tencent.com/document/product/382/37794 ；https://cloud.tencent.com/document/product/382/13444
- 抖音开放平台：https://developer.open-douyin.com/capacity-center-page/capacity-detail/7224121299067469881 ；https://developer.open-douyin.com/docs/resource/zh-CN/dop/operation-standard/platform-capabilities/usage-spec
- npm：https://www.npmjs.com/package/wechatpay-axios-plugin ；https://www.npmjs.com/package/wechatpay-node-v3

未能核实、已在正文标注【不确定】的点：B2B 服务是否豁免虚拟支付；现行《微短剧小程序运营指引》全文；`wx.uploadFile` 大小上限；`readFile` 对 >100MB 文件的分段读；微信客服未认证企业的接待限制；从小程序打开获客链接；服务号模板消息 2026 年细则；视频号“仅已认证可设运营者”与“每微信号可运营的视频号数”；各银行与零钱的精确限额；微信支付费率。
