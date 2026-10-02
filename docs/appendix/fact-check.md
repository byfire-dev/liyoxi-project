# 外部事实核实记录

| 项 | 内容 |
| --- | --- |
| 查证日期 | 2026-10-02 |
| 方法 | 对会影响架构与选型的外部结论逐条查一手来源（官方文档、官方公告、npm registry、云厂商文档与价格页），默认存疑 |

共 91 条：成立 60 条，部分成立 31 条，不成立 0 条，无法核实 0 条。“部分成立”的以“更正”一栏为准。

平台规则、限额与价格会变化，提审与签约前须再次核对。部分一手页面（微信开放社区帖子正文、腾讯文档、个别云厂商价格页）无法机读，相关条目已在“更正”或“额外发现”中注明。

## 小程序虚拟支付与服务类目

### vpay-1　成立

**待核结论**：自 2026-04-01 起，小程序内售卖虚拟商品在全终端（含安卓）都必须接入“小程序虚拟支付”，不得使用普通微信支付（JSAPI）

**依据**：找到了一手公告（原报告只引了二手的移动支付网）。微信公众平台公告《小程序虚拟支付业务管理规范更新公告》（作者“微信团队”，页面源码 online_time=1772189406，即 2026-02-27）原文：“若你的小程序内涉及虚拟支付业务，请在4月1日前全终端(包括iOS端、安卓端、Windows与鸿蒙端)接入虚拟支付，到期未接入将被判定为违规，根据违规程度将对该小程序采取风险提醒、限制功能直至暂停或终止提供服务等措施”。运营规范 5.13：“……虚拟商品（包括虚拟代币、解锁功能、订阅内容、付费功能、打赏、购买虚拟礼物等），购买和支付均需接入小程序虚拟支付”。虚拟支付文档：“适用于 Android、iOS、鸿蒙、Windows等所有终端”。《虚拟支付业务运营指南》：“若小程序仅包含以上虚拟类目，平台将关闭该小程序在安卓及其余非iOS系统的普通微信支付能力”。带“微信官方用户”标识的 Ben 于 2026-02-27 答复“目前接了小程序支付的还需要接虚拟支付吗”：“如小程序内服务内容涉及虚拟商品购买，如虚拟会员，VIP、在线课程等，需重新接入小程序虚拟支付能力”。补充：安卓端虚拟支付底层仍路由到微信支付，但走的是虚拟支付新开的二级商户号，不是自有商户号的 JSAPI。

**来源**：
- https://mp.weixin.qq.com/cgi-bin/announce?action=getannouncement&announce_id=11772091560sL6TW&version=&lang=zh_CN&token=
- https://developers.weixin.qq.com/miniprogram/product/#_5-13-虚拟支付行为
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html
- https://developers.weixin.qq.com/community/minihome/doc/00002cf077cd4810fee42f4b865c01
- https://developers.weixin.qq.com/community/minihome/doc/00028a621b00208dc0b48759d6ec00

### vpay-2　成立

**待核结论**：iOS 端虚拟支付走 Apple 支付，平台技术服务费/渠道费约 12%（2026 年口径），回款周期明显长于普通微信支付

**依据**：虚拟支付文档“设备路由”表：Android、鸿蒙、Windows → 微信支付；iOS → Apple 支付。结算原文：“结算周期：T+3”（非 iOS）；“iOS 端结算入账：……苹果公司 (Apple) 通常在自然月结束后 45～60 天内结算，并在扣除 Apple 佣金后，将款项结算给腾讯。腾讯收到汇款后……划转至开发者的虚拟支付账户”。技术服务费页 iOS 行：“标准费率 17%（含 12% Apple 佣金）｜当前生效费率 12%｜12% 全部为 Apple 佣金”。官方通知（微信团队，2026-03-13）：“小程序虚拟支付2026年实际收取的费率从15%下调至12%，全部为苹果收取的佣金（腾讯5%的技术服务费在2026年暂不收取）”。注意：12% 只是 2026 年的生效费率，标准费率是 17%，2027 年起腾讯 5% 是否恢复，官方未说明。iOS 端另有条件：iOS 15 及以上、微信 8.0.68 及以上、最低支付 1 元、仅支持中国大陆 App Store 账户、Apple 支付不支持沙箱。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/devplan.html
- https://developers.weixin.qq.com/community/minihome/doc/000a04a261c0f0d5edc4972a96f401

### vpay-3　成立

**待核结论**：运营规范禁止在小程序内引导用户到 App、公众号、H5、个人号、网站等小程序外渠道完成虚拟商品支付

**依据**：《微信小程序平台运营规范》5.13 原文：“……购买和支付均需接入小程序虚拟支付；不得引导至app、公众号、h5、个人号、网站完成支付。”处理规则：“一经发现将根据违规程度对该小程序采取风险提醒、限制功能直至暂停或终止提供服务等措施。”同页 14.7 重申并多列一项：“不得引导至app、公众号、h5、个人号、网站、安卓支付完成支付”。5.33 对微短剧/互动微短剧/网络小说类目额外点名“引导用户线下充值、引导用户跳转到其他小程序、APP、H5、公众号等”。

**来源**：
- https://developers.weixin.qq.com/miniprogram/product/#_5-13-虚拟支付行为
- https://developers.weixin.qq.com/miniprogram/product/

### vpay-4　部分成立

**待核结论**：官方对“虚拟商品”的举例包含 VIP 会员、充值代币/积分等；官方没有“面向企业的营销服务（B2B）不算虚拟商品”的明文豁免

**更正**：官方点名的举例是“VIP会员、充值代币、录制课程、录制音频视频”和“虚拟代币、解锁功能、订阅内容、付费功能、打赏、购买虚拟礼物”，并未点名“积分”；“充值积分”只能说与“充值代币/虚拟代币”同形，不能说官方已列举。“没有 B2B 明文豁免”成立，而且应加强表述：2026-03 官方客服已把面向企业的招聘会员（含线下服务）明确答复为虚拟支付行为。官方判定维度是“非实物 + 线上交付（解锁内容、开通权限、发放虚拟道具）”，不看付费方是企业还是个人；唯一有利依据是 2020 年“提供人工服务不属于虚拟支付”的旧答复。

**依据**：举例部分：2026-02-27 官方公告原文“虚拟支付业务是指购买非实物商品，比如:VIP会员、充值代币、录制课程、录制音频视频等虚拟产品”；运营规范 5.13 的举例是“虚拟代币、解锁功能、订阅内容、付费功能、打赏、购买虚拟礼物等”。官方举例里没有出现“积分”二字，“积分”是调研员按“代币”做的类推。豁免部分：《虚拟支付业务运营指南》（微信团队，04-08 发布，09-17 最后编辑）的豁免说明只列了两项：“线上问诊（仅限具备合法资质的医疗机构/医生提供的实时远程诊疗服务）及法律咨询（仅限持照律师/律所提供的实时专业咨询服务）不属于虚拟支付管控范畴”；全文没有任何 B2B 或企业服务豁免。还有比“没有豁免”更不利的官方口径：2026-03-06 招聘平台开发者询问“企业年付认证会员（含线上服务 + 线下服务）”是否须接虚拟支付，带“微信官方用户”标识的客服答复“会员属于明确的虚拟支付行为，在招聘、简历这个场景下，对用户的服务均是虚拟支付行为”。反向依据只有一条旧答复：2020-08-03 官方用户答律所合同审查服务“如若小程序提供人工服务，则不属于虚拟支付内容，平台……根据实际具体情况进行评估”。

**来源**：
- https://mp.weixin.qq.com/cgi-bin/announce?action=getannouncement&announce_id=11772091560sL6TW&version=&lang=zh_CN&token=
- https://developers.weixin.qq.com/miniprogram/product/#_5-13-虚拟支付行为
- https://developers.weixin.qq.com/community/minihome/doc/00002cf077cd4810fee42f4b865c01
- https://developers.weixin.qq.com/community/minihome/doc/00068e716401308756c4acc006bc00
- https://developers.weixin.qq.com/community/minihome/doc/00046aaabbcb6842ffbaef1b45f400
- https://developers.weixin.qq.com/community/minihome/doc/0004a2d3214e90c38ea4e0fa661401

### vpay-5　成立

**待核结论**：虚拟支付的管控类目表包含“工具>办公/企业管理”“文娱>微短剧/其他视频”“深度合成”等；仅含这些类目的小程序会被关闭普通微信支付

**依据**：我下载并直接读了《虚拟支付业务运营指南》第 4 节“虚拟支付管控类目”的表格图片。文娱：微短剧、互动微短剧、网络小说、宗教信息、学术期刊、资讯广场、视频广场、出版物、行业资讯、其他视频、语音、音乐、图片、时政新闻信息、电台、有声读物、动漫。工具：视频客服、兑换、设备管理、记账、投票、日历、天气、备忘录、办公、字典、图片处理、计算器、报价/比价、信息查询、网络代理、效率、健康管理、企业管理、预约/报名、发票查询。社交：直播、直播答题、陌生人交友、熟人交友、社区/论坛、婚恋、问答、笔记。资讯：信息资讯。深度合成：AI问答、AI换脸、AI绘画、AI创作。教育服务：在线教育、在线视频课程。体育：在线健身。表下原文：“若小程序仅包含以上虚拟类目，平台将关闭该小程序在安卓及其余非iOS系统的普通微信支付能力，需调用小程序虚拟支付能力进行交易，如小程序实际提供非虚拟业务，如实物或线下交易等，可按实际经营业务申请其他类目，相关能力限制会自动解除。”被关闭的范围按原文是“安卓及其余非 iOS 系统的普通微信支付能力”。

**来源**：
- https://developers.weixin.qq.com/community/minihome/doc/00002cf077cd4810fee42f4b865c01
- https://mmbiz.qpic.cn/sz_mmbiz_png/dx4Y70y9Xcs33p2Ng10WyOHibNic4Nfs8DzZVa0SpSicPWZ4fv1j4vX9Sk7B37v1NIgXuTtiahp0DAeLLgfO1OpkkicGTRVGzzxiboNWrhXClu98s/0?wx_fmt=png

### vpay-6　成立

**待核结论**：服务类目里存在“商业服务>广告/设计”，无特殊资质要求，且不在虚拟支付管控类目表内

**依据**：类目资质表“非个人主体小程序开放的服务类目 > 商业服务”一行：广告/设计｜资质要求“/”｜“适用于提供商业广告、产品设计等相关等服务。”｜备注“/”；相邻行“公关/推广/市场调查”同样无资质要求。管控类目表（见 vpay-5 的逐项清单）没有“广告/设计”，也没有“公关/推广/市场调查”。两点限制须同时知道：(1) 管控表并不严格按一级类目对齐，“企业管理”“网络代理”在非个人主体类目表里属于【商业服务】，却被列进管控表的【工具】行，所以“商业服务”一级类目本身不是安全区，只是“广告/设计”这个二级类目未被列入；(2) 运营指南第 3 节写“若包含以下服务场景，小程序须全终端接入小程序虚拟支付”，技术服务费页的表头也写“……及其他类目”，即是否属于虚拟支付按服务形态判定，选了不在管控表里的类目不等于豁免。

**来源**：
- https://developers.weixin.qq.com/miniprogram/product/material/
- https://developers.weixin.qq.com/community/minihome/doc/00002cf077cd4810fee42f4b865c01
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/devplan.html

### vpay-7　部分成立

**待核结论**：以企业营业执照主体开通的小程序可以正常使用微信支付 JSAPI 收取“服务费”类款项；线下对公转账后在后台人工确认开通不违反平台规则

**更正**：应改为有条件的表述：(1) 已认证的企业主体小程序具备开通微信支付 JSAPI 的资格；仅当所售内容不被平台认定为虚拟商品（即属于实物、线下或人工服务）时，才可用 JSAPI 收款。(2) “小程序内展示对公转账入口 + 后台人工确认开通”没有官方明文许可，也没有针对非虚拟业务的明文禁止；一旦业务被认定为虚拟支付，该入口即落入 5.13“不得引导至……完成支付”的范围。此项只能通过提审或向平台书面咨询确认，架构上不能当作确定合规的路径。

**依据**：前半句的一般前提有一手来源：微信支付《小程序支付-产品介绍》准入条件“1、支持的主体类型：个体工商户、企业、事业单位、政府机关、社会组织，(小程序支付、JSAPI支付共用一个权限)；2、支持的应用类型：已认证的小程序”。但“服务费”能否走 JSAPI 取决于平台是否把它判成虚拟商品：判成虚拟则 5.13 要求“购买和支付均需接入小程序虚拟支付”，且仅含管控类目的小程序安卓端普通微信支付会被关闭。后半句查不到任何一手来源正面说“允许”。我查过运营规范全文（5.13、5.33、14 支付及退款规范）、审核规范、虚拟支付运营指南，均无“线下对公转账/人工开通”的许可条款。能查到的相关条款是：5.13 禁止“引导至app、公众号、h5、个人号、网站完成支付”；5.33 对微短剧/小说类目点名禁止“引导用户线下充值”；官方 2018 年《小程序涉及iOS虚拟支付修改指引》写“任何为用户提供前往支付流程的路径/文案，都将被拒绝”。官方唯一成文的“银行转账”能力是 B2b 门店助手（“银行转账：适用单笔金额大于5万元的支付场景”），但限定“小程序的服务类目含有：商家自营-B2b(商品批发/门店管理)”，是实物批发场景，本产品不适用。原调研报告 §2.2 自己把这一点标为【不确定】，并写明一旦被认定为虚拟支付，小程序内的对公转账入口会被视为引导至其他渠道支付；待核结论比原报告说得更满。

**来源**：
- https://pay.weixin.qq.com/doc/v3/merchant/4012791894
- https://developers.weixin.qq.com/miniprogram/product/
- https://developers.weixin.qq.com/community/minihome/doc/00002cf077cd4810fee42f4b865c01
- https://developers.weixin.qq.com/community/minihome/doc/000464b5b3cb382b9d372b98f5ac08
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/industry/B2b_store_assistant.html
- research/ext-wechat.md

### vpay 组的额外发现

- 【对定性最不利的官方口径】2026-03-06，带“微信官方用户”标识的客服在开放社区答复招聘平台（企业年付认证会员，含线上 + 线下服务）：“会员属于明确的虚拟支付行为，在招聘、简历这个场景下，对用户的服务均是虚拟支付行为。”这是面向企业付费方的会员被官方直接判为虚拟支付的实例，与本产品“会员套餐 + 积分充值”高度同形；“B2B 所以不算虚拟”不能作为架构前提。https://developers.weixin.qq.com/community/minihome/doc/00068e716401308756c4acc006bc00
- 【唯一有利的官方口径，但较旧】2020-08-03 官方用户答复律所合同审查服务：“如若小程序提供人工服务，则不属于虚拟支付内容，平台对于违规小程序的处理是根据实际具体情况进行评估。”运营指南也写“如小程序实际提供非虚拟业务，如实物或线下交易等，可按实际经营业务申请其他类目”。若要走普通微信支付，产品形态和文案应突出“人工定制制作 + 线下/人工交付”，而不是“会员/充值/积分兑换”。https://developers.weixin.qq.com/community/minihome/doc/00046aaabbcb6842ffbaef1b45f400
- 【判定按服务形态，不按类目】运营指南判定表（图片已直接核读）：商品形态=“非实物商品，以数字内容、虚拟权益、线上服务等形式存在”；交付方式=“线上交付，如解锁内容、开通权限、发放虚拟道具等形式存在”。典型形态七：“摄影修图、文档编辑等……帮助用户完成图片美化、AI 生成与文档编辑排版等创作工作”。混合型：“同时包含虚拟商品和实物商品……将被认定为虚拟支付，建议拆分为两笔交易分别处理”。本产品“套餐含积分 + 权益”的打包售卖需要评估拆单。https://developers.weixin.qq.com/community/minihome/doc/00002cf077cd4810fee42f4b865c01
- 【类目表与管控表不对齐】在非个人主体类目表里，“企业管理”“网络代理”属于【商业服务】，【工具】下没有“企业管理”“效率”“字典”；管控表却把“企业管理”“网络代理”列在【工具】行。因此“商业服务 > 企业管理”应视为已在管控范围，不要作为补充类目；原报告对它标“谨慎”是对的。https://developers.weixin.qq.com/miniprogram/product/material/
- 【虚拟支付开通条件现已不含类目门槛，但未验证】现行文档 1.1 开通条件只有三条：已认证小程序；企业/事业单位/个体工商户；主体信息完备。社区文章（2026-02-28，非官方）称当时还要求“运营资质属于文娱、工具、社交、资讯、深度合成等相关类目”，另有非官方用户称“和类目有关，否则不能开通虚拟支付”。如果架构预留 wechat_virtual 兜底通道，需在 MP 后台实测只选“商业服务 > 广告/设计”类目时能否开通虚拟支付。https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html
- 【虚拟支付是独立商户号与独立资金流】开通时“开通一个新的微信支付商户号”（二级商户号）；发起支付用 wx.requestVirtualPayment，签名为 HMAC-SHA256（appKey / session_key），服务端接口是 /xpay/* 系列，发货靠 xpay_goods_deliver_notify 等消息推送，推送最多重试 15 次；非 iOS 结算 T+3；iOS 月账单要单独下载（/xpay/download_ios_settlement_bill）；支付 180 天内退款才退手续费。它与 APIv3 JSAPI（RSA 签名、自有商户号、回调解密）是两套完全不同的接入，若要预留，支付抽象层须把下单、回调、对账、退款全部做成按渠道可替换。
- 【iOS Apple 支付硬约束】用户须 iOS 15 及以上、微信 8.0.68 及以上；最低支付金额 1 元；仅支持中国大陆 App Store 账户；Apple 支付不支持沙箱，只能用现网环境测试；须先配置小程序简称。单笔金额上限我没有在官方文档查到（未核实）；对 3.6 万至 14.4 万的客单价，除 12% 佣金外还需单独确认上限。
- 【安卓/鸿蒙/Windows 费率的时效】技术服务费页：主动支付标准 10%、当前生效 1%；会员订阅（自动续费）首笔 1%、第二笔起 10%。“当前生效费率”没有写截止日期，财务测算不能把 1% 当长期值。微短剧/互动微短剧/网络小说类目为 5%–10%。https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/devplan.html
- 【另有一份未定位到 URL 的官方文档线索】2026-09-14 社区帖引用了《小程序虚拟支付业务说明》的截图，其中“形态三：会员与特权服务——用户付费开通 VIP 会员或购买特权，获得专属功能、去广告、优先服务、加速等权益”，案例含“付费置顶”。该帖还反映：审核以“任何为用户提供前往支付流程的路径/文案都将被拒绝”驳回付费发布/置顶，客服称“发布付费置顶是平台未开放的”。我未找到该文档的官方 URL（运营指南在 09-17 又被编辑过，可能是其旧版本），只能当线索。https://developers.weixin.qq.com/community/minihome/doc/0004a8a4804fb07d64b50501361800
- 【运营规范 14.7 的措辞】14.7 写“不得引导至app、公众号、h5、个人号、网站、安卓支付完成支付”，比 5.13 多出“安卓支付”一项，含义官方未解释。另外类目资质表里微短剧等类目的备注仍是旧措辞（“如需实现安卓等非iOS端的小程序内购买交易……”），与 2026 年全终端口径并存，引用时以 2026-02-27 公告和运营指南为准。

## 订阅消息、手机号组件与审核规范

### msg-1　成立

**待核结论**：小程序一次性订阅消息：用户每次授权只能下发一条；一次 requestSubscribeMessage 最多请求若干个模板（原结论为 5 个），且必须由用户点击或支付回调触发

**依据**：2026-10-02 直接抓取官方页原文。(1) 订阅消息概述页：“用户订阅后，开发者可不限时间地下发一条对应的服务消息；每条消息可单独订阅或退订。”(2) wx.requestSubscribeMessage 页 tmplIds 说明：“需要订阅的消息模板的id的集合，一次调用最多可订阅5条消息（注意：iOS客户端7.0.6版本、Android客户端7.0.7版本之后的一次性订阅/长期订阅才支持多个模板消息…）…每个tmplId对应的模板标题需要不相同，否则会被过滤。”(3) 同页注意事项：“2.8.2 版本开始，用户发生点击行为或者发起支付回调后，才可以调起订阅消息界面。”“一次性模板 id 和永久模板 id 不可同时使用。”现行上限确为 5（部分旧博客写的 3 是过时信息）。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html
- https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html
- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message.html

### msg-2　成立

**待核结论**：长期订阅消息仅对政务民生、医疗、交通、金融、教育等特定类目开放，“商业服务”类目不能申请长期订阅

**依据**：(1) 官方概述页原文：“目前长期性订阅消息仅向政务民生、医疗、交通、金融、教育等线下公共服务开放，后期将逐步支持到其他线下公共服务业务。”另有“长期订阅限频消息…当前限频消息暂向金融等指定行业开放”。(2) 官方知识库《【小程序-订阅消息】常见问题汇总【2026-2-16~2026-2-22】》（带“官方”标识，02-23 发布）：“商业服务类目不在长期订阅支持范围内，上述场景建议通过一次性订阅或其他方式实现。”“长期订阅消息目前只对政务民生、医疗、交通、金融、教育、设备等部分二级行业类目进行开放，仅支持少量民生公共服务节点通知。”(3) 该答复对应的原帖（2026-02-10，提问者正是一个“广告设计接单”小程序，申请用长期订阅同步设计进度/交付提醒），“社区技术运营专员”02-11 回复同一句话。场景与本产品几乎一致。补充：同一知识库还写明“当前在线教育类目暂不支持开通长期订阅模板”，即“教育”也只是部分二级类目。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html
- https://developers.weixin.qq.com/community/minihome/doc/000204f2f74468ac62b46dfaa6b009
- https://developers.weixin.qq.com/community/minihome/doc/000ca4138f0fb89e67a4bb39466000

### msg-3　成立

**待核结论**：手机号快速验证组件（getPhoneNumber）每次成功调用收费 0.03 元，每个小程序有 1000 次体验额度，额度耗尽且未购买资源包时接口不可用

**依据**：官方页原文：“自2023年8月28日起，手机号快速验证组件将需要付费使用。标准单价为：每次组件调用成功，收费0.03元。更多套餐价格请见微信公众平台-付费管理。”“体验额度：每个小程序账号将有1000次体验额度…该1000次的体验额度为正式版、体验版和开发版小程序共用，超额后，体验版和开发版小程序调用同正式版小程序一样，均收费”。“查询节点：用户点击button时，进行资源包额度查询。若查询额度不足，开发者将收到错误码 e.detail.errno===1400001，同时用户侧将收到平台默认半屏提示‘该功能使用次数已达当前小程序上限，暂时无法使用’…可将 phone-number-no-quota-toast 设置为 false”。“扣费节点：开发者获得 bindgetphonenumber 事件的 success 回调信息时，进行扣费。”code“有效期为5分钟，且只能消费一次”。需要注意的细节（不改变结论）：扣费发生在前端拿到 success 回调时，而不是服务端用 code 换手机号时，所以回调成功但后端未消费 code 也会扣费；官方人员在社区确认同一用户可多次调用、每次都扣费；免费规则只覆盖政府/非营利组织/政务民生事业单位/公立医疗/学历教育，本产品不适用；实时验证组件为 0.04 元/次。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html
- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getRealtimePhoneNumber.html
- https://developers.weixin.qq.com/community/minihome/doc/000a6edd5c8c48c4a0913bd0566c00

### msg-4　成立

**待核结论**：运营规范要求手机号快速验证组件的前置按钮/页面不得使用“微信”字样造成误认（原结论引 5.14.2）

**依据**：《微信小程序平台运营规范》现行版“5.14 混淆行为”原文：“5.14.2 小程序的登录页、授权页、弹窗等界面中，不得使用"微信""腾讯"及其标识、近似标识或官方用语样式，使普通用户误认为该界面由腾讯提供或经腾讯授权；包括调用手机号快速验证等能力组件的前置页面。”条款编号与内容均与原结论一致。两点说明：(a) 条文是“使用‘微信’‘腾讯’及其标识/近似标识/官方用语样式 + 致使误认”的组合，包含图标（微信 logo）和样式，不只是文字；(b) 我没有找到官方对“微信手机号快捷登录”这类具体文案的判例或解读，“该文案会被驳回”属于调研员的风险推断，但改成“手机号快捷登录”且不放微信 logo 是稳妥做法。

**来源**：
- https://developers.weixin.qq.com/miniprogram/product/

### msg-5　部分成立

**待核结论**：小程序审核规范有“禁止多媒体内容自动播放”一类条款（原结论引 3.5.2），静音自动播放的视频也可能被判违规；核对条款原文与适用范围

**更正**：准确说法：条款原文为“禁止视频、音乐、语音等多媒体的自动播放”，出处是《常见拒绝情形》3.5.2 与《运营规范》12.5.3（原报告只引了前者），适用于所有小程序、字面上不区分是否静音。静音自动播放是否会被判违规属于“字面上落入禁止范围、实际执行口径查不到一手来源”，不能当作已核实事实，也不能当作安全。架构上按原报告建议处理即可：默认点击播放，自动播放做成服务端可关的开关，提审版本关闭。

**依据**：条款存在且编号正确，并且有两处：(1)《微信小程序平台常见拒绝情形》“3. 小程序整体审核规则 > 3.5 技术实现规范性”：“3.5.2 禁止视频、音乐、语音等多媒体的自动播放”；(2)《微信小程序平台运营规范》“12. 技术实现规范 > 12.5 其它要求”：“12.5.3 禁止视频、音乐、语音等多媒体的自动播放。”两处都是面向全部小程序的通用条款，原文只有这一句，没有“静音除外”“首屏除外”等任何限定或豁免。但“静音自动播放也会被判违规”没有一手依据：官方 video 组件文档本身提供 autoplay（“是否自动播放”）和 muted（“是否静音播放”）属性；我在官方社区检索不到任何以 3.5.2/12.5.3 驳回静音自动播放的官方答复或案例（检索到的视频类驳回几乎都是“需补充文娱-其他视频类目”）。

**来源**：
- https://developers.weixin.qq.com/miniprogram/product/reject.html
- https://developers.weixin.qq.com/miniprogram/product/
- https://developers.weixin.qq.com/miniprogram/dev/component/video.html

### msg-6　部分成立

**待核结论**：同一手机号可以对应多个 openid；unionid 需要小程序绑定到微信开放平台帐号后才能获得

**更正**：后半句成立。前半句方向正确但属于由官方机制推出的结论，没有官方原话；更准确的表述是“手机号与微信身份不是一一对应：一个微信号可授权多个手机号（含自主添加的号码），多个微信号也可授权同一手机号，所以不能用手机号反推 openid，也不能假设 phone↔openid 一对一”。原报告“账号以 phone 唯一、另建 (appid, openid, unionid)→user 的多对一身份表”的设计不受影响。另需补充绑定前提，见 extraFindings 第 2 条。

**依据**：后半句有一手来源：登录文档“调用 auth.code2Session 接口，换取 用户唯一标识 OpenID、用户在微信开放平台账号下的唯一标识UnionID（若当前小程序已绑定到微信开放平台账号）和会话密钥 session_key”；UnionID 机制说明页“绑定了开发者账号的小程序，可以通过以下途径获取 UnionID…wx.login + code2Session 获取到该用户 UnionID，无须用户授权”，绑定入口“微信开发者平台…『我的业务 - 开放平台 - 绑定关系 - 小程序』”。前半句官方没有逐字表述，只有机制支持：手机号组件文档写“该能力使用时，用户可选择绑定号码，或自主添加号码”，即返回的手机号不必是该微信号的绑定手机号，而 openid 是按“微信号 × appid”生成的；官方社区多个开发者帖子报告“两个微信授权了同一个手机号，出现两个 openid”（均为开发者互答，非官方人员回复）。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html
- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/union-id.html
- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html
- https://developers.weixin.qq.com/community/minihome/doc/000ee878fc0ac8a6b5de22d6f50800
- https://developers.weixin.qq.com/community/minihome/doc/000a42d83344e8467d9ba8a7050800

### msg-7　成立

**待核结论**：小程序正式上线前必须完成小程序备案（ICP），request/uploadFile/downloadFile 合法域名必须是已备案域名且支持 HTTPS

**依据**：备案：官方《小程序备案常见问答》：“小程序因为没备案导致发布失败，返回的错误码是？"errcode":86369,"errmsg":"小程序上架需先完成备案"”；《小程序备案操作指引》：“新增（未上架）小程序于2023年9月4日开放备案入口”“未上架小程序：开发者可在小程序首页点击【去备案】”。微信 2023-08-09《关于开展微信小程序备案的通知》（“自2023年9月1日起，微信小程序须完成备案后才可上架”，存量 2024-03-31 前完成、4 月 1 日起清退）我只取到新华网/北京日报等转载，未抓到官方原帖。备案时效：平台初审 1-2 个工作日，各省通信管理局 1-20 个工作日。域名：网络文档“域名只支持 https (wx.request、wx.uploadFile、wx.downloadFile) 和 wss (wx.connectSocket) 协议；域名不能使用 IP 地址（小程序的局域网 IP 除外）或 localhost；…域名必须经过 ICP 备案；出于安全考虑，api.weixin.qq.com 不能被配置为服务器域名…；不支持配置父域名，使用子域名。”“小程序必须使用 HTTPS/WSS 发起网络请求”，TLS 须支持 1.2 及以上。唯一例外是用微信云托管作后端时（callContainer/connectContainer）无需配置通讯域名。注意“小程序备案”和“服务器域名的 ICP 备案”是两件独立的事，都要做。

**来源**：
- https://developers.weixin.qq.com/miniprogram/product/record/record_faq.html
- https://developers.weixin.qq.com/miniprogram/product/record/record_guidelines.html
- https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html
- https://xinwen.bjd.com.cn/content/s64d42e11e4b03d11a64e6373.html

### msg 组的额外发现

- 【一次性订阅“额度可累加”没有官方出处】原报告 5.3 的“多点蓄水/额度账本”依赖“同一模板多次订阅可累加多条下发额度，勾选‘总是保持’后每次静默调用 +1”。官方文档只写“下发一条”和“勾选后下次调用不会弹窗，保持之前的选择”，没有写累加、上限或有效期；我查到的说法全部来自社区开发者互答（如 https://developers.weixin.qq.com/community/minihome/doc/0000aece718e20510291aa69a66c00 、https://developers.weixin.qq.com/community/minihome/doc/000888ffe3058865efcff679256800 ，回答者不是官方人员）。这是业内普遍经验，但应标为“非官方”，额度账本需以发送接口返回 43101 为准做对账，不能只信本地计数。
- 【unionid 的前置条件比原报告写的多】官方《绑定开放平台账号》：“开放平台账号需完成开发者资质认证”；“一个小程序账号只能绑定一个开放平台账号”；同主体/关联主体最多绑 50 个小程序，异主体最多 5 个；要把 unionid 与企业微信 external_userid 打通，“企业微信、开放平台、公众号、服务号、小程序都需要认证并且是主体相同”。如果复用参考工程的 AppID，要先确认它是否已绑定到别的开放平台账号。认证费用搜索摘要称 300 元，我未在官方页核到。来源：https://developers.weixin.qq.com/doc/oplatform/developers/product/open/bind.html
- 【运营规范 5.21 滥用订阅消息，直接约束“蓄水”做法】原文：“强制用户订阅：订阅后才能继续下一步操作”“利诱用户订阅：订阅后用户可获得奖励（…优惠券、代金券、积分…）”均属违规，处罚为“删除订阅消息或短期、长期或永久封禁小程序的订阅消息接口能力”；12.8 还禁止“恶意诱导用户进行触发操作，以达到可向用户下发模板目的”和“下发营销目的的模板”。在支付/提交等按钮上顺带请求订阅时，用户拒绝后必须能继续流程，不能送积分换订阅，续费提醒不能写成促销。来源：https://developers.weixin.qq.com/miniprogram/product/ （5.21、12.8）
- 【运营规范 12.6 授权登录，与 5.14.2 需同时满足】原文：“12.6.1 微信小程序内存在账号体系时，必须提供微信授权登录。”“12.6.3 应提供功能正常且易于发现的‘退出’选项。”（常见拒绝情形 3.5.5 同样要求“退出”账户选项）。即登录必须基于微信授权能力，但界面文案和图标不能让人误认为是腾讯提供的页面；同时必须有退出登录入口。来源：https://developers.weixin.qq.com/miniprogram/product/ 、https://developers.weixin.qq.com/miniprogram/product/reject.html

## 小程序文件上传下载能力

### file-1　成立

**待核结论**：wx.downloadFile 单次下载文件最大 200MB

**依据**：2026-10-02 直接 curl 官方文档原文：“下载文件资源到本地。客户端直接发起一个 HTTPS GET 请求，返回文件的本地临时路径 (本地路径)，单次下载允许的最大文件为 200MB。”同页 timeout 默认 60000ms（2.10.0 起可配）。注意这是文档上限：搜索结果里有多条微信开放社区帖子标题反映部分机型/iOS 在小于上限时也报 “downloadFile:fail exceed max file size”（社区需登录，未能读到正文，只能作线索）。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/api/network/download/wx.downloadFile.html
- curl -sL https://developers.weixin.qq.com/miniprogram/dev/api/network/download/wx.downloadFile.html（本地抽取正文）

### file-2　成立

**待核结论**：小程序网络请求（request/uploadFile/downloadFile）并发上限为 10；小程序切到后台后 5 秒内未完成的网络请求会被中断

**依据**：官方《网络》文档“使用限制”原文：“wx.request、wx.uploadFile、wx.downloadFile 的最大并发限制是 10 个；wx.connectSocket 的最大并发限制是 5 个。小程序进入后台运行后，如果 5s 内网络请求没有结束，会回调错误信息 fail interrupted；在回到前台之前，网络请求接口调用都会无法调用。”默认超时 60s。口径提示：原文没有“合计”二字（原报告表格写的是“合计最大并发 10”，属解读，按三者共用 10 个额度设计是保守做法）；downloadFile/uploadFile 文档的 profile.queueStart 说明为“达到并行上限时才需要排队”，即超限是排队而非直接失败。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html
- https://developers.weixin.qq.com/miniprogram/dev/api/network/download/wx.downloadFile.html

### file-3　部分成立

**待核结论**：wx.saveVideoToPhotosAlbum 只支持 mp4 格式

**更正**：官方口径是“支持 mp4 视频格式”，并未明文写“只支持”。工程上应按“只有 mp4 被官方保证”处理（成片统一转 mp4），但“其他封装一定失败”“必须 H.264”都不是官方文档内容，后者在原报告里也只是非官方经验，需真机验证。

**依据**：官方文档功能描述全文只有一句：“保存视频到系统相册。支持mp4视频格式。”需 scope.writePhotosAlbum 授权；filePath 可为临时或永久文件路径。文档没有“仅/只”字样，也没有列出其他格式，更没有写编码要求（H.264/H.265）。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/api/media/video/wx.saveVideoToPhotosAlbum.html

### file-4　部分成立

**待核结论**：wx.uploadFile 官方文档没有写明单文件大小上限；FileSystemManager.readFile 单次读取有大小限制（原结论 100MB），但支持 position/length 分段读取

**更正**：正确说法：uploadFile 的 API 文档确实未写大小上限（成立）。readFile 的官方限制口径是“单个文件大小上限为 100M”（针对文件大小，而非单次读取量）；2.10.0 起支持 position/length 分段读。>100MB 文件能否靠分段读绕过该上限，没有一手来源支持，属未决风险，必须真机 PoC（iOS/Android 各验证 150MB、300MB、500MB）。原报告 ext-wechat §7.3 已标注此不确定性，但 ext-media §“技术上分块上传两者都能支持”把它当成了已定结论。

**依据**：(1) wx.uploadFile 文档正文（功能描述+参数表）经全文检索无任何大小上限表述，只写“客户端发起一个 HTTPS POST 请求，其中 content-type 为 multipart/form-data”——该部分成立。微信官方开源库 miniprogram-file-uploader README 写“wx.uploadFile 接口有大小限制（10M）”，但该仓库已 archived（最后 push 2024-12-09），与 API 文档不一致。(2) readFile 文档原文：“读取本地文件内容。单个文件大小上限为100M。”position/length 参数最低版本 2.10.0（“读取的范围应该是左闭右开区间 [position, position+length)”）；错误码 1300202 说明为“存储空间不足，或文件大小超出上限（上限100M）”。即官方措辞是“单个文件大小上限”，不是“单次读取上限”。(3) 对大于 100M 的文件用 position/length 分段读是否可行，官方文档没有任何说明；相关微信开放社区帖（《大文件上传wx.readfile为啥要限制100m啊？》等）需登录无法读取；miniprogram-file-uploader issue #10 中有用户称“超过100M就没办法上传了”（非官方、无回复确认）。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/api/network/upload/wx.uploadFile.html
- https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readFile.html
- https://github.com/wechat-miniprogram/miniprogram-file-uploader
- https://github.com/wechat-miniprogram/miniprogram-file-uploader/issues/10
- curl -s https://api.github.com/repos/wechat-miniprogram/miniprogram-file-uploader

### file-5　部分成立

**待核结论**：cos-wx-sdk-v5 的 uploadFile（高级上传）在文件大于 SliceSize 时自动分块上传并支持断点续传，可在微信小程序内上传 200MB–500MB 的视频文件

**更正**：“大于 SliceSize 自动分块 + 默认断点续传”成立（一手源码与官方文档均支持）；但“可上传 200MB–500MB 视频”没有任何一手来源保证：SDK 分块用的正是 FileSystemManager.readFile(position/length)，受微信“单个文件大小上限为100M”这句官方限制是否适用于分段读的不确定性影响。应表述为“≤100MB 有文档依据；100–500MB 须真机 PoC 后才能写进架构”，并准备降级方案（选取时压缩 / 限制 ≤100MB / 超限走电脑端或企业微信传文件）。另：源码默认 SimpleUploadMethod 为 'postObject'（src/cos.js:41，走 wx.uploadFile），与文档写的 putObject 不一致，README“强烈建议”显式设为 putObject。

**依据**：已 clone 源码核对（master 864d7b8，2026-03-25，package.json 1.8.1；npm latest=1.8.0，beta=1.9.0-beta.1）。成立部分：src/advance.js:1001 `var api = FileSize > SliceSize ? 'sliceUploadFile' : simpleUploadMethod;`；默认 SliceSize=ChunkSize=1MB、ChunkParallelLimit=3、MaxPartNumber=10000（src/cos.js:16-24）；分块读取确实是 `wxfs.readFile({filePath, position: start, length: end - start})`（src/util.js:224-231），分块经 wx.request 发送（lib/request.js:141），基础库 <2.10.0 时退回简单上传（util.js:743 canFileSlice）；续传：UploadId 用 wx.setStorageSync 缓存（src/session.js），并通过 ListMultipartUploads + ListParts 找远端任务、逐块重算 MD5 比对 ETag（advance.js:205-510）。腾讯云文档（更新于 2026-09-29）原文：“uploadFile 实现高级上传，传入参数 SliceSize 可以控制文件大小超出一个数值（默认1MB）时自动使用分块上传（sliceUploadFile），否则使用简单上传(putObject)，其中分块上传默认支持断点续传。”“小程序刷新后，如果将同一个文件上传到同一个存储桶路径下，SDK 内部会自动校验内容，校验通过后，续传文件。”不成立/无依据部分：腾讯云文档、README、CHANGELOG 均未给出小程序端可上传文件大小的任何承诺；SDK 完全依赖 readFile，而微信文档写明 readFile“单个文件大小上限为100M”。GitHub issues 检索“100M/大文件/readFile”无相关结论。

**来源**：
- https://github.com/tencentyun/cos-wx-sdk-v5
- git clone --depth 1 https://github.com/tencentyun/cos-wx-sdk-v5.git（本地：fc/cos-wx-sdk-v5，src/util.js:224-231、src/advance.js:937-1008、src/cos.js:16-41、src/session.js、lib/request.js:91,141）
- npm view cos-wx-sdk-v5 dist-tags time --json
- https://cloud.tencent.com/document/product/436/64991
- https://cloud.tencent.com/document/product/436/31953
- https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.readFile.html

### file-6　成立

**待核结论**：wx.chooseMedia 选择相册视频时可拿到临时文件路径与大小；从相册选的视频默认可能被压缩（compressed），可通过参数控制

**依据**：官方文档：success 返回 tempFiles[]，含“tempFilePath 本地临时文件路径”“size 本地临时文件大小，单位 B”“duration 视频的时间长度”、width/height、thumbTempFilePath。参数 sizeType 默认值 ['original', 'compressed']，说明为“是否压缩所选文件，基础库2.25.0前仅对 mediaType 为 image 时有效，2.25.0及以后对全量 mediaType 有效”。maxDuration：“拍摄视频最长拍摄时间…3s 至 60s 之间。不限制相册。”count 2.25.0 起最多 20。补充口径：文档未说明默认两项并存时由谁决定是否压缩、压缩码率多少；也没有任何限制相册视频大小/时长的入参，PRD 的“≤5 分钟、500MB”只能在选完后用 size/duration 自行校验。cos-wx-sdk-v5 README 示例用的是 sizeType: ['original']。旧接口 wx.chooseVideo（2.21.0 起停止维护）compressed 默认 true。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/api/media/video/wx.chooseMedia.html
- https://developers.weixin.qq.com/miniprogram/dev/api/media/video/wx.chooseVideo.html
- https://github.com/tencentyun/cos-wx-sdk-v5/blob/master/README.md

### file-7　成立

**待核结论**：小程序本地临时文件/缓存有总量上限（原结论“运行时临时文件上限 4GB”），核对现行数值

**依据**：官方《文件系统》文档现行原文：“本地临时文件：临时产生，随时会被回收的文件。运行时最多存储 4GB，结束运行后，如果已使用超过 2GB，会以文件为维度按照最近使用时间从远到近进行清理至少于2GB。”“本地缓存文件…跟本地用户文件共计，小程序（含小游戏）最多可存储 200MB。”另有原报告未提的一条：“同时也会检查所有小程序的临时文件占用，若超过6GB则以小程序为维度进行清理。”以及“本地临时文件产生后，仅在当前生命周期内保证有效，重启之后不一定可用。”

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html

### file 组的额外发现

- 【最大风险】ext-media 把“视频（≤200/500MB）改用 cos-wx-sdk-v5 分块上传”当成已定方案，但该 SDK 的分块读取就是 FileSystemManager.readFile(position,length)（src/util.js:224），而微信官方对 readFile 的限制措辞是“单个文件大小上限为100M”。>100MB 能否分段读没有任何一手来源背书（微信开放社区相关帖需登录，未能读取）。在真机 PoC 通过前，架构上只能承诺 ≤100MB 的小程序内分块上传；PRD 6.16.3 的 500MB 与 10.1 的 200MB 都落在未验证区间。
- 备选读取路径：FileSystemManager.open + FileSystemManager.read(fd, arrayBuffer, position, length)（基础库 2.16.1 起），其功能描述只有“读文件”，未写 100M 文件上限（但错误码表同样列有 1300202“上限100M”，为共用表）。cos-wx-sdk-v5 不使用该接口；若 PoC 证明 readFile 对 >100MB 文件失败，需要自研“fd 分段读 + 后端预签名 UploadPart”或限制上限。来源：https://developers.weixin.qq.com/miniprogram/dev/api/file/FileSystemManager.read.html
- 断点续传所需 STS 权限比普通分块上传多：腾讯云文档写明续传需要 cos:InitiateMultipartUpload、cos:UploadPart、cos:CompleteMultipartUpload、cos:ListMultipartUploads、cos:ListParts（仅分块不续传则不需要后两个）。ext-media 提到“STS 按主体/门店/本次上传 key 收窄权限”，收窄时必须包含这两个 List 动作，否则 SDK 找不到远端 UploadId、续传退化为重传。来源：https://cloud.tencent.com/document/product/436/64991
- 续传的前提是“同一个文件上传到同一个存储桶路径（Key）”：SDK 本地缓存键含 FilePath + size + lastModifiedTime + ChunkSize + Bucket + Key（src/session.js getFileId），本地缓存未命中时按 Key 列远端任务并逐块重算 MD5 比对。chooseMedia 的临时文件“重启之后不一定可用”，且缓存/用户文件合计上限 200MB，>200MB 的视频无法持久化到用户目录；冷启动后续传通常需要用户重新选同一视频，并要求后端为同一素材下发同一个 Key（Key 不能每次随机生成）。
- 域名白名单：腾讯云快速入门原文“cos.uploadFile 会调用 wx.uploadFile、wx.request；cos.postObject 会调用 wx.uploadFile；其他方法会调用 wx.request”，COS 桶域名必须同时配置到 request 合法域名与 uploadFile 合法域名（ext-media 标为“推断”的这条可升级为已核实）。来源：https://cloud.tencent.com/document/product/436/31953
- 上传同样受“切后台 5 秒 fail interrupted”和并发 10 的约束：SDK 默认 ChunkParallelLimit=3、FileParallelLimit=3（最多 9 路 wx.request 并发），几乎占满 10 个并发额度，会让业务接口排队；需要调低并发或错峰。大文件上传期间用户必须停留前台，产品上要有“请勿切出”的提示与中断后续传。
- 版本信息：cos-wx-sdk-v5 npm latest 为 1.8.0（2025-05-19 发布），beta 1.9.0-beta.1（2025-05-27）；GitHub master 的 package.json 为 1.8.1（最近提交 2026-03-25），尚未发布到 npm latest。高级上传的 SliceSize 入参在未传 ChunkSize 时也会被当作分块大小（src/advance.js:28 `params.ChunkSize || params.SliceSize || self.options.ChunkSize`）；默认分块 1MB，500MB 文件即 500 块，建议显式设 ChunkSize 5–10MB。
- 微信官方开源的 miniprogram-file-uploader 仓库已归档（archived=true，最后 push 2024-12-09，12 个 issue 全部无官方处理），其 README 的“wx.uploadFile 有 10M 限制”不应作为现行依据，也不宜选型该库。
- 未能核实的线索（仅搜索结果标题，社区需登录）：多帖反映 wx.downloadFile 在部分 iOS/安卓机型上对小于文档上限的视频报 “fail exceed max file size”；一篇 2019 年个人博客称 iOS 上 100 多 MB 的相册视频用 wx.uploadFile 表现不稳定、400MB 以上必报错（年代久远，非一手）。成片“逐集下载存相册”和大视频上传都应纳入真机兼容性测试矩阵，单集体积目标宜远低于 200MB。

## 微信支付 APIv3

### pay-1　成立

**待核结论**：新申请的商户号默认使用“微信支付公钥”验签模式（而非平台证书），回调验签需根据 Wechatpay-Serial（以 PUB_KEY_ID_ 开头）选择公钥

**依据**：商户文档《如何从微信支付公钥切换成平台证书》（更新 2026.03.17）原文：“微信支付APIv3支持平台证书和微信支付公钥两种模式构造签名验签，新申请的商户号默认为微信支付公钥模式。商户可通过自主操作，切换至平台证书模式。”支付成功回调通知页原文：“商户可通过HTTP头"Wechatpay-Serial"中的证书序列号判断选择对应的证书验签，微信支付公钥的序列号固定采用"PUB_KEY_ID_数字串"格式（例如：PUB_KEY_ID_3000000001），若请求头中的序列号不符合该格式，则应使用平台证书进行验签。”公钥常见问题：“每个商户号只有一个微信支付公钥。”（均为直接 curl 官方页面后逐字核对）

**来源**：
- https://pay.weixin.qq.com/doc/v3/merchant/4015419357
- https://pay.weixin.qq.com/doc/v3/partner/4015419376
- https://pay.weixin.qq.com/doc/v3/merchant/4012791902
- https://pay.weixin.qq.com/doc/v3/merchant/4012154180
- https://pay.weixin.qq.com/doc/v3/merchant/4013038816

### pay-2　成立

**待核结论**：微信支付官方只提供 Java / PHP / Go 的 SDK，没有官方 Node.js SDK

**依据**：官方《SDK概述》（更新 2026.04.24）服务端 SDK 表只有三行：Java wechatpay-java / PHP wechatpay-php / Go wechatpay-go；并写明“社区 SDK 由广大的微信支付开发者自发提供，我们仅提供展示的平台，不对资源的质量负责，建议大家以参考为主，不要直接拷贝使用”。官方 GitHub 组织 wechatpay-apiv3 仓库列表（GitHub API 取数）：wechatpay-java、wechatpay-go、wechatpay-apache-httpclient、wechatpay-php、wechatpay-guzzle-middleware、wechatpay-postman-script、wechatpay-skills、CertificateDownloader 等，无 Node.js 服务端 SDK。客户端侧另有 JS-SDK/小程序 API，但不是服务端 SDK。

**来源**：
- https://pay.weixin.qq.com/doc/v3/merchant/4012076498
- https://pay.weixin.qq.com/docs/partner/sdk-tools/sdk-tool.html
- curl -s https://api.github.com/orgs/wechatpay-apiv3/repos?per_page=100

### pay-3　成立

**待核结论**：JSAPI/小程序下单金额单位为分（整数）；prepay_id 有效期 2 小时；不传 time_expire 时订单默认有效期较长（原结论 7 天，核对）

**依据**：下单 API 页原文：“【总金额】订单总金额，单位为分，整型，必须大于0。示例：1元应填写 100”；“prepay_id…有效期为2小时，失效后需要重新请求该接口以获取新的prepay_id”；time_expire：“若未指定支付结束时间，系统默认以下单时间为起始点计算时效；超过 7 天未支付的订单，无法再支付”“支付结束时间不能早于下单时间后1分钟…需在下单时间的15天以内，如超过15天，微信支付会自动将该时间调整为下单时间后的第15天”。开发指引（更新 2026.06.09）：“若不传该参数，默认订单支付有效期为7天…超出7天，订单将被关闭”“prepay_id有效期为2小时，超过2小时，商户需要使用原下单参数重新请求下单接口，获取新的prepay_id”。7 天默认值成立。

**来源**：
- https://pay.weixin.qq.com/doc/v3/merchant/4012791897
- https://pay.weixin.qq.com/doc/v3/merchant/4012791911

### pay-4　成立

**待核结论**：支付结果回调要求商户在 5 秒内应答，失败会按退避策略重试，总共最多约 15 次

**依据**：支付成功回调通知页原文：“商户接收到回调通知报文后，需在5秒内完成对报文的验签，并应答回调通知。”“若商户应答回调接收失败，或超时(5s)未应答时，微信支付会按照（15s/15s/30s/3m/10m/20m/30m/30m/30m/60m/3h/3h/3h/6h/6h）的频次重复发送回调通知，直至微信支付接收到商户应答成功，或达到最大发送次数（15次）”。应答规则：验签通过返回 HTTP 200 或 204 无包体；验签不通过返回 4XX/5XX 并带 {code:FAIL}。并写明“商户系统不能仅依赖回调通知获取结果，需结合查询接口使用”“请做好重入设计”。退款结果回调页的 5 秒/15 次表述相同。按间隔累加，重试窗口约 24 小时 4 分钟（我的计算）。

**来源**：
- https://pay.weixin.qq.com/doc/v3/merchant/4012791902
- https://pay.weixin.qq.com/doc/v3/merchant/4012791906

### pay-5　成立

**待核结论**：退款须在支付成功后 1 年内发起，单笔订单最多可分多次部分退款（原结论 50 次）；退款为异步，有退款回调与查询接口

**依据**：退款申请页（更新 2025.01.09）原文：“在交易完成后的一年内（以支付成功时间为起点+365天计算）…”；“一笔订单最多支持50次部分退款（若需多次部分退款，请更换商户退款单号并间隔1分钟后再次调用）”；“在申请退款失败后进行重试时，请务必使用原商户退款单号”；“申请退款接口返回成功仅表示退款单已受理成功，具体的退款结果需依据退款结果通知及查询退款的返回信息为准”；“调用成功的频率限制为150QPS，而调用失败报错时的频率限制为6QPS”。退款产品介绍（更新 2025.06.27）：“订单只能在支付后1年内(支付时间+365天)发起退款，超出时间的订单，无法退款”“最多支持50次部分退款”。退款结果回调通知（REFUND.SUCCESS/ABNORMAL/CLOSED）与“查询单笔退款（通过商户退款单号）”接口页面均存在。

**来源**：
- https://pay.weixin.qq.com/doc/v3/merchant/4012791903
- https://pay.weixin.qq.com/doc/v3/merchant/4013071001
- https://pay.weixin.qq.com/doc/v3/merchant/4012791906
- https://pay.weixin.qq.com/doc/v3/merchant/4012791904

### pay-6　成立

**待核结论**：交易账单与资金账单在次日 10 点后可下载，API 只能下载近 3 个月内的账单

**依据**：账单产品介绍（更新 2025.04.24）原文：“微信支付按日(00:00:00~23:59:59)生成交易和资金账单，商户需在次日10点后，通过接口或商户平台下载账单对账。”下载方式表：商户平台“支持5年内的账单下载…时间跨度最多31天”；API 接口“仅支持下载3个月内的账单”“每次API请求仅支持单日账单下载”。申请交易账单 API：“微信支付在每日10点后生成昨日交易账单文件…此接口仅可下载三个月内的账单”“账单金额单位为人民币‘元’”。申请资金账单 API：“当日账单将在次日上午9点开始生成，建议商户在次日上午10点以后获取”“bill_date…仅支持三个月内的账单下载申请”“以商户号维度频率限制为3QPS”。

**来源**：
- https://pay.weixin.qq.com/doc/v3/merchant/4013071215
- https://pay.weixin.qq.com/doc/v3/merchant/4012791907
- https://pay.weixin.qq.com/doc/v3/merchant/4012791908
- https://pay.weixin.qq.com/doc/v3/merchant/4013071227

### pay-7　部分成立

**待核结论**：微信支付下单接口本身没有统一的金额上限，但用户侧受银行卡/零钱单笔与单日限额约束，5 万元以上的大额付款成功率不可预期；官方另有 B2B 场景的银行转账能力

**更正**：应改为：下单接口文档没有写金额上限，但并非“没有统一上限”——腾讯客服官方页写明付款人对同一商户的限额随商户号行业属性而定：实物行业单笔/单日 8 万元，虚拟行业单笔 6000 元、单日 9000 元（是否按每个支付工具分别计、现行是否仍是这组数字，需向微信支付商家助手/客服确认）。因此：14.4 万元一笔在任何行业属性下都超过 8 万上限，不能单笔付成；7.2 万元仅在商户号被归为实物行业时才在上限内，且仍受付款人银行卡限额与零钱 20 万/年限额约束；若商户号被归为虚拟行业，单笔上限 6000 元，连 12,000 元月付和 3.6 万元年付都无法单笔完成。“5 万元”只是 B2b 门店助手里银行转账的起点金额（≥5 万），不是微信支付的限额线；该 B2b 银行转账能力限「商家自营-B2b(商品批发/门店管理)」类目，本产品用不上。银行卡各行限额没有官方一手表格，属未核实。

**依据**：成立的部分：(1) 下单 API 页对 amount.total 只写“必须大于0”，未写上限。(2) 官方 JSAPI 常见问题（更新 2026.08.05）：“小微商户日收款额度为1万-30万…信用卡日收款限额为1000元，月收款限额调整为10000元。其他类型商户没有限额”。(3) 腾讯客服官方页：“根据监管法规要求，你名下全部账户零钱支付总额度最高为20万/年；零钱达到支付限额后，你可以选择银行卡或其他方式进行支付”。(4) 小程序 B2b 门店助手文档：“银行转账：适用单笔金额大于5万元的支付场景，无需填写付款信息，到账自动认款对账”，错误码 702009“未开通银行转账，或订单金额小于5万”；准入“小程序的服务类目含有：商家自营-B2b(商品批发/门店管理)”。
有出入的部分：腾讯客服官方页《商户收款限额是多少？》（kf.qq.com，页面仍在线，未标更新时间，文号显示 2020-07 创建）原文：“普通商户（有营业执照入驻）：每日收款营业额无上限，但买家付款时根据商户选择的行业属性不同对应的支付限额不同：①实物行业：付款方使用同个微信支付，单笔/单日限额为8万元；②虚拟行业：付款方使用同个微信支付，单笔限额6000元，单日限额9000元。”原报告把这组数字标为“社区流传、未在官方页核到”，实际有官方客服页出处，且原文未限定为信用卡。各银行快捷支付单笔/单日限额的官方一手表格我没有查到（只有二手文章），“5 万以上成功率不可预期”属于推断而非官方表述。开放社区相关问答的官方回复需登录才能取到，未能核读。

**来源**：
- https://pay.weixin.qq.com/doc/v3/merchant/4012791897
- https://pay.weixin.qq.com/doc/v3/merchant/4012791869
- https://kf.qq.com/touch/faq/200726QjeQFF200726Vryay6.html
- https://kf.qq.com/touch/sappfaq/210928mim2i62109283uaiQN.html
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/industry/B2b_store_assistant.html
- https://developers.weixin.qq.com/community/develop/doc/000260b2568fe8c927a2068636b000

### pay-8　部分成立

**待核结论**：关闭订单（close）后仍可能收到已支付回调的边界情况存在，官方建议关单前先查单，并以对账单为准

**更正**：应改为：官方建议的顺序是“查单 → 仍未支付才关单 → 关单成功（204）后可把订单当失败终态”，CLOSED 是终态；官方文档没有说关单成功后还会收到支付成功回调。真正的风险点在商户侧：本地超时取消但没有调用或没有成功调用关单接口时，用户仍可在微信侧付成（默认 7 天有效）；或查单与关单之间用户付款，此时关单接口会报错（V2 文档明确为 ORDERPAID，要按已支付处理）。所以设计上应以关单接口的返回结果而非本地定时器作为“取消成功”的依据，关单失败时再查单。对账单的官方定位是 T+1 逐笔核对的兜底手段（微信侧成功而商户侧未成功 → 补发货或退款），不是“以对账单为准”的原话。

**依据**：“先查单再关单”有官方出处：小程序支付开发指引（更新 2026.06.09）“若因特殊原因需在用户可支付时间范围内关闭订单，商户可通过调用查询订单API接口确认订单状态，若订单仍是未支付状态，商户可以调用关闭订单API接口关单，关单后可以将订单当作失败终态处理。”状态流转图说明把 CLOSED、SUCCESS、REFUND 列为终态。
“关单后仍可能收到已支付回调”没有查到官方出处：v3 关闭订单页（更新 2024.12.11）只写两种关单场景和错误码（INVALID_REQUEST/RULE_LIMIT/TRADE_ERROR 等），没有这类提示；官方表述方向相反（关单成功后可当失败终态）。V2 关闭订单文档写的是已支付订单关单会报错：“ORDERPAID 订单已支付，不能发起关单，请当作已支付的正常交易”，以及“订单生成后不能马上调用关单接口，最短调用时间间隔为5分钟”（仅 V2 文档有，v3 页未写）。
“以对账单为准”不是官方原话：《支付回调和查单实现指引》写的是“商户在T+1日从微信支付侧获取T日的交易账单，并与商户系统中的订单核对。如出现订单在微信支付侧成功，但是在商户侧未成功的情况，商户需要给用户补发货或者退款处理”，并给出轮询查单后仍未支付再调关单的方案。

**来源**：
- https://pay.weixin.qq.com/doc/v3/merchant/4012791911
- https://pay.weixin.qq.com/doc/v3/merchant/4012791901
- https://pay.weixin.qq.com/doc/v3/merchant/4012075249
- https://pay.weixin.qq.com/doc/v2/partner/4011984036

### pay 组的额外发现

- 【对架构影响最大】腾讯客服官方页（https://kf.qq.com/touch/faq/200726QjeQFF200726Vryay6.html）写明普通商户按行业属性有付款人限额：实物行业单笔/单日 8 万元，虚拟行业单笔 6000 元/单日 9000 元。原报告把它标成“社区流传、未核到”，并以 5 万元作为分界来设计。按此页：14.4 万年付不可能单笔微信支付；若商户号被归为虚拟行业（本产品“会员套餐+积分充值”的形态有此风险），12,000 元月付和 3.6 万年付也付不成。商户号申请时的行业/经营类目选择因此是支付可用性的前置条件，须在进件前向微信支付确认现行限额与归类；该页未标更新时间（文号显示 2020-07），现行数字需再确认。
- 原报告未覆盖“订单发货管理”：小程序支付开发指引（https://pay.weixin.qq.com/doc/v3/merchant/4012791911）写明“若为交易类小程序，需要满足公众平台的《交易类小程序运营规范》，按照规范接入订单发货管理功能，若不满足，可能被公众平台限制使用小程序进行支付的权限，无法在正式环境下调起小程序支付”。《小程序发货信息管理服务》文档（https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/order-shipping/order-shipping.html）写明“特定类型的小程序需要在平台完成发货信息录入及确认收货流程后方可进行资金结算”“用户交易后，默认资金将会进入冻结状态”，接口 /wxa/sec/order/upload_shipping_info，并有 trade_manage_remind_shipping（超过 48 小时未发货提醒）、trade_manage_order_settlement 等事件推送。本产品是否属于被管控的小程序类型我没有核实，但支付模块应预留“支付成功后录入发货信息”与相关事件处理，否则有资金冻结、支付权限受限的风险。
- 回调验签有“签名探测流量”：支付回调页原文“微信支付会在极少数通知回调中返回以 WECHATPAY/SIGNTEST/ 开头的错误【Wechatpay-Signature】，以检测商户系统是否正确验证签名”。自研封装必须真实验签，并对验签失败返回 4XX/5XX 加 {code:FAIL}，不能一律回 200。
- 公钥模式的实现细节（官方常见问题 https://pay.weixin.qq.com/doc/v3/merchant/4013038816 ）：请求头需带 “Wechatpay-Serial: PUB_KEY_ID_…”，微信才会用公钥对应的私钥签名应答；老商户“申请公钥后默认不开启公钥切换”，需在商户平台手动开启。如果本项目复用参考工程已有的老商户号而不是新申请，就不是默认公钥模式，需要走平台证书→公钥的切换流程（https://pay.weixin.qq.com/doc/v3/merchant/4012154180 ），切换期间验签要同时兼容两种。
- 原报告 1.3 节的 npm 数据经取数核对属实：wechatpay-axios-plugin latest 0.9.6（2026-02-10 发布，依赖 axios ^1.8.2、fast-xml-parser ^5.0.8、@thenorthmemory/multipart，engines node>=12，2026-09 月下载 6,619）；wechatpay-node-v3 latest 2.2.1（2024-08-19 发布，2026-09 月下载 30,730）。命令：npm view <pkg> dist-tags/time --json；https://api.npmjs.org/downloads/point/last-month/<pkg>。
- 官方文档中心现有“Skills&开发工具”栏目（微信支付接入 Skill，GitHub wechatpay-apiv3/wechatpay-skills，2026-09 仍在更新），每个文档页提供“以 Markdown 格式查看 / 复制给 LLM”和 llms.txt；另有 Go/Java 官方示例代码与验签工具、Postman 脚本。若采用自研 Node 薄封装，可以用这些官方示例和验签工具做对照测试。
- 退款的两处细节（https://pay.weixin.qq.com/doc/v3/merchant/4012791903 、4013071001）：退款资金从商户基本账户原路退回；对一个月前的订单退款可能报“频率限制，1个月之前的订单请降低申请频率再重试”。年付套餐的后期退款要考虑账户余额是否足够和这条限频。
- 未能核实的部分：微信开放社区里关于限额的若干问答（如 https://developers.weixin.qq.com/community/pay/doc/000a06dbe207182566f4186c26b400 “小程序支付有没有限额，受什么控制？”2026-04-14）的官方回复需要登录才能读取，我只取到了提问正文；各银行快捷支付单笔/单日限额没有找到官方一手表格。

## 微短剧类目、视频类目与资质

### cat-1　成立

**待核结论**：“文娱>微短剧”类目的小程序必须使用官方媒资管理/短剧播放器、只能播放平台审核过的剧目，并要求剧目备案或《网络剧片发行许可证》等材料

**依据**：(1) 官方类目表·微短剧备注4：“类目申请通过后，播放管控能力将同步生效，账号内仅支持播放官方过审链接，未经平台审核的内容将无法正常播放”；备注6：“如误申请通过导致相关能力被封禁，可自行删除类目解除封禁”。(2) 微信学堂《短剧小程序上线准备》(2026-03-19 发布，03-23 更新)：“已申请获得【文娱-微短剧】类目的小程序，平台将自动开通【媒资管理】功能…实现剧目【内容上传】和【提审】”“开发者需统一通过微信官方提供的短剧播放器播放视频”，且按流量资源包收费。(3) 剧目提审 API auditdrama：qualification_type“1-取得《网络剧片发行许可证》或重点节目备案号；2-未取得…且制作成本小于100万元”，后者需上传《成本配置比例情况报告》，由平台下发仅限微信小程序使用的备案号（门槛 2026-01-14 起由 30 万调为 100 万）；另需权利声明/播放授权材料。(4) 短剧播放器文档：“短剧播放器是微信官方为微短剧类目小程序提供的播放器插件”。细节补充：成本<100万的剧不需要广电备案号，交成本报告即可；类目本身还要主体资质（视听许可证/备案，或登记表+《广播电视节目制作经营许可证》等一整套）。

**来源**：
- https://developers.weixin.qq.com/miniprogram/product/material/
- https://developers.weixin.qq.com/community/business/doc/0004c2be1f40b89a5fd478b426bc0d
- curl -s https://developers.weixin.qq.com/community/ngi/doc/detail/0004c2be1f40b89a5fd478b426bc0d
- https://developers.weixin.qq.com/miniprogram/dev/server/API/minidrama/auditdrama/api_auditdrama
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/industry/mini-drama/mini_drama.html
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/industry/videoplayer.html

### cat-2　成立

**待核结论**：小程序若以视频播放为主要功能，会被要求补充“文娱>其他视频”类目，需要《信息网络传播视听节目许可证》或《广播电视节目制作经营许可证》等资质

**依据**：官方《关于小程序使用“视频类插件”的规范》(2022-03-29，2022-05-18 更新)：“需补充‘文娱-其他视频’类目的小程序——对象：将提供视频播放、观看服务作为主要服务内容，同时另含一定比例的其他合规服务内容的小程序…否则平台将按照‘类目不符’违规对其下架处理”。官方类目表·其他视频资质“（6选1）：1、《信息网络传播视听节目许可证》2、《广播电视节目制作经营许可证》3/4 电视台许可证 5 政府主体 6 事业单位”，企业主体实际是前两项二选一；备注“选择该类目后首次提交代码审核，需经当地互联网主管机关审核确认，预计审核时长7天左右”。注意两点边界：视频是全部内容/视频集合时要的是“文娱-视频广场”（企业需视听许可证或全国网络视听平台信息登记备案，制作经营许可证不够）；视频内容是微短剧时要的是“文娱-微短剧”。另，官方《文娱-其他视频和文娱-视频广场指引说明》的触发措辞更宽：“当小程序涉及视频播放、观看等服务，需要补充…类目或通过接入视频类目插件合规提审”。

**来源**：
- https://developers.weixin.qq.com/community/minihome/doc/000e465b3fc3b0765cbd57e8f57809
- curl -s https://developers.weixin.qq.com/community/ngi/doc/detail/000e465b3fc3b0765cbd57e8f57809
- https://developers.weixin.qq.com/miniprogram/product/material/
- https://developers.weixin.qq.com/community/develop/doc/000e0c5226c1f010346b0e4145b409

### cat-3　部分成立

**待核结论**：非视听类目的小程序可以把视频作为主营业务的辅助展示（如商品介绍视频）而不需要视听资质；预告片作为“商品展示”是否被接受没有官方明文，存在审核不确定性

**更正**：正确说法：官方明文允许的是“已有合规主营业务的小程序通过接入视频类插件提供补充性视频”，自托管视频作辅助展示属于实践中常见但无明文保障的灰区；影视剧类视频不支持走插件。对短剧预告片，官方既无豁免明文，又有“涉及微短剧播放即需微短剧类目，否则移除微短剧内容及分类标签”的指引，被判类目不符的风险是实打实的，不能当作“商品介绍视频”的同等情形来设计。

**依据**：前半句的官方原文带有前提：2022 规范写的是“对于将视频播放能力作为补充服务的小程序，可…通过接入‘视频类插件’实现视频功能”，举例主营为电商平台、餐饮、房地产、教育。即官方明文豁免的路径是“接入视频类插件”，没有一句写明自托管 <video> 的补充视频免类目（video 组件文档本身无类目门槛，已核对）。官方《文娱-其他视频和文娱-视频广场指引说明》流程图还注明“影视剧类视频暂不支持使用文娱-其他视频插件”，所以短剧预告片这类内容连插件豁免路径都走不了。后半句成立且风险比原表述更高：官方《【文娱-微短剧】类目修改指引说明》(2025-09-25 更新)写“当小程序涉及提供网络微短剧视频播放、观看等服务，需要申请【文娱-微短剧】类目合规提审，否则…因类目不符被驳回”，整改二选一：补类目，或“移除微短剧相关功能服务，包括但不限于移除前端、后台代码中所存在微短剧内容、分类标签等”；所附驳回案例截图是一个“短剧”Tab 下的海报宫格 +“更新至第N集”+ 播放量。预告片/片花/样片在类目表、运营规范、上述指引中均无任何明文。社区用户帖（非官方，仅作线索）有“只有产品介绍/培训视频也被要求补文娱-其他视频”的案例（2020-08、2024-11）。未能核对：现行《微短剧小程序运营指引》(docs.qq.com) 抓取失败。

**来源**：
- https://developers.weixin.qq.com/community/minihome/doc/000e465b3fc3b0765cbd57e8f57809
- https://developers.weixin.qq.com/community/develop/doc/000e0c5226c1f010346b0e4145b409
- https://developers.weixin.qq.com/community/develop/doc/0008a07576c90006c1fe2c58956c09
- curl -s https://developers.weixin.qq.com/community/ngi/doc/detail/0008a07576c90006c1fe2c58956c09
- https://developers.weixin.qq.com/miniprogram/dev/component/video.html
- https://developers.weixin.qq.com/community/develop/doc/000844849881082f0862bfc3d66800
- https://developers.weixin.qq.com/community/develop/doc/0008ec7e544cd832f8ba093bf56400

### cat-4　部分成立

**待核结论**：用户上传视频/图片等 UGC 内容的小程序需要接入内容安全审核（官方 security.mediaCheckAsync / msgSecCheck 或等效能力）

**更正**：需要内容安全机制这一点成立，但 security.mediaCheckAsync 只支持图片和音频（≤10MB），不支持视频；规范明文强制的是文本/图片检测。上传的视频必须用等效能力（第三方视频审核、截帧后送图片检测或人工审核）自行覆盖，不能指望官方接口。

**依据**：义务本身成立：运营规范 5.18“小程序涉及未设置过滤违法、违规等不当信息内容的机制。必须调用内容安全检测接口校验文本/图片是否含有敏感内容”；10.2“应设置过滤违法、违规等不当信息内容的机制，通过使用内容安全API接口、人工审核等机制做好内容把关”。但官方接口不覆盖视频：mediaCheckAsync 文档“本接口用于异步校验图片/音频是否含有违法违规内容”，media_type 仅“1:音频;2:图片”，错误码说明“目前支持多媒体类型 1 音频；2 图片”；单文件 ≤10M；2000 次/分钟、200,000 次/天；必须传 openid 且“用户需在近两小时访问过小程序”；结果“在 30 分钟内会推送到你的消息接收服务器”。msgSecCheck：文本 ≤2500 字，需 openid + scene，4000 次/分钟、2,000,000 次/天，“若为未上架小程序，调用上限为100 次/天”。服务端内容安全目录下只有这两个接口。规范原文点名的也只是“文本/图片”。

**来源**：
- https://developers.weixin.qq.com/miniprogram/product/
- https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_mediacheckasync.html
- https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_msgseccheck.html

### cat-5　成立

**待核结论**：小程序中涉及 AI 生成/深度合成能力的功能可能被要求选择“深度合成”相关类目并提供算法备案；仅展示“使用 AI 模型制作”的服务说明、不在小程序内提供生成功能的情形是否触发，没有官方明文

**依据**：官方类目表·深度合成（AI问答/AI绘画/AI换脸/AI创作/拟人化互动）：资质“（2选1）1、使用自研技术：小程序主体的《互联网信息服务算法备案》（算法类型为‘生成合成类’）2、使用第三方技术，同时提供：①技术主体的算法备案 ②小程序主体与技术主体的合作协议”；备注“需在AI生成内容显著位置进行标注”。官方《【深度合成-AI绘画、AI换脸、AI问答】修改指引说明》(2025-10-29 更新)：“当小程序服务内容涉及深度合成技术…需补充对应的服务类目…否则代码审核环节将面临因类目/内容不符被驳回”，整改二选一：补类目并加“AI生成”标注，或“移除提供文本深度合成技术等内容及相关分类标签”。后半句：已查类目表、运营规范全文（无“深度合成/AI生成/算法备案”条款）、上述修改指引，均只按“提供深度合成技术服务”界定，未涉及“只描述服务用了 AI、不在小程序内生成”的情形，确无明文。需留意整改措辞包含“相关分类标签”，意味着页面上的 AI 模型字样本身就可能成为审核员的触发点。

**来源**：
- https://developers.weixin.qq.com/miniprogram/product/material/
- https://developers.weixin.qq.com/community/develop/doc/000eac48498a3084b3902193a69409
- curl -s https://developers.weixin.qq.com/community/ngi/doc/detail/000eac48498a3084b3902193a69409
- https://developers.weixin.qq.com/community/develop/doc/00000cb0824678ee89d062b496e409
- https://developers.weixin.qq.com/miniprogram/product/

### cat 组的额外发现

- 【两难，影响最大】原报告的兜底思路是“不申请微短剧类目，被要求时再补”。但官方明文：一旦微短剧类目通过，“账号内仅支持播放官方过审链接，未经平台审核的内容将无法正常播放”，且须统一用官方短剧播放器、按流量包付费、逐剧提审（每部剧要发行许可证/备案号或成本报告）。也就是说补类目后，自托管的预告片和给商家看的样片都会播不出来。真正可行的兜底只有官方给的另一条：移除小程序内的微短剧视频内容及分类标签。架构上应把“小程序内是否播放视频”做成服务端开关，并预留纯图文（海报+剧情简介）形态。来源：https://developers.weixin.qq.com/miniprogram/product/material/ ；https://developers.weixin.qq.com/community/develop/doc/0008a07576c90006c1fe2c58956c09
- 官方对“微短剧小程序”的判定口径（微信学堂 2026-03）：“‘微短剧’指单集时长在数十秒到15分钟左右、有相对明确主题以及完整故事情节的网络电视剧。而涉及提供‘微短剧播出服务’的小程序统一划归为【微短剧小程序】”，符合者“须申请【文娱-微短剧】类目”。≤3 分钟的预告片在时长上落在该区间内，是否算“播出服务”无明文，只能靠提审或向平台咨询确认。官方驳回案例截图的形态是“短剧”Tab + 海报宫格 + “更新至第N集” + 播放量，商城页应避免做成这种样子（推断）。来源：https://developers.weixin.qq.com/community/business/doc/0004c2be1f40b89a5fd478b426bc0d
- 视频类插件这条退路对本产品不通：官方《文娱-其他视频和文娱-视频广场指引说明》流程图注明“影视剧类视频暂不支持使用文娱-其他视频插件”，正文写“影视剧类型视频播放暂不支持使用插件视频”。来源：https://developers.weixin.qq.com/community/develop/doc/000e0c5226c1f010346b0e4145b409
- 内容安全的工程约束：mediaCheckAsync 不支持视频、单文件 ≤10MB、必须带近两小时访问过小程序的用户 openid、结果 30 分钟内异步推送到消息接收服务器；msgSecCheck 在小程序未上架时上限 100 次/天。因此（推断）：商家上传的视频、大于 10MB 的图片/录音、以及运营后台员工上传的内容（没有 openid）都不能走微信接口，需要独立的视频/大文件审核通道；审核必须做成异步状态机（待审/通过/拦截），并配置消息推送接收端。来源：https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_mediacheckasync.html ；https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_msgseccheck.html
- AI 标识是独立于类目的法定义务：《人工智能生成合成内容标识办法》自 2025-09-01 施行，视频需在“起始画面和视频播放周边的适当位置添加显著的提示标识”，并要求文件元数据隐式标识；用户发布生成合成内容“应当主动声明”。本产品用 AI 制作的预告片、样片、成片无论小程序选什么类目都应带显式+隐式标识（推断：应写进转码/交付规格）。来源：https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm
- 微信侧剧目提审已要求 AI 声明：auditdrama 接口 content_declared=1（视频包含 AI 生成内容）时，自 2026-07-28 12:00 起必须上传“使用AI软件生成内容的证明截图”；drama_type 自 2026-04-20 新增“3-数字真人”（AI 生成的逼真虚拟角色出演，无需演员信息）。若商家或平台日后要把成片上到微信短剧小程序，后台短剧库的数据模型需要这些字段（推断）。来源：https://developers.weixin.qq.com/miniprogram/dev/server/API/minidrama/auditdrama/api_auditdrama
- 原报告 3.2 称剧目备案号/《网络剧片发行许可证》是“后台短剧库的上架必填项”。按微信现行口径，制作成本 100 万以下的剧不需要这两项，交《成本配置比例情况报告》后由平台下发仅限微信小程序使用的备案号（门槛 2026-01-14 起由 30 万调到 100 万）。后台字段应设计成“资质类型二选一”而非备案号必填（推断）；其他平台（抖音、视频号）的口径本次未核。来源同上一条。
- 互动微短剧类目“审核通过后不支持删除且不支持申请其他类目”，比微短剧类目（可自行删除解除封禁）更不可逆，任何情况下都不要误选。来源：https://developers.weixin.qq.com/miniprogram/product/material/
- 未能核实项：现行《微信公众平台微短剧小程序运营指引》(https://docs.qq.com/doc/DTXFMZmp1ZE9UVnpM) 与其公众号版 (mp.weixin.qq.com/s/oM71NMsFDNwkKFWo45xV3Q) 均抓取失败（腾讯文档需渲染、公众号触发环境验证）；社区帖的官方回复评论接口需登录，未能读取。预告片是否有专门条款以这两处为准，建议人工打开核对。抓取的原文与截图留存在 fc-cat/

## 抖音/视频号发布规则与 AI 标识义务

### pub-1　成立

**待核结论**：抖音开放平台“代替用户发布内容到抖音”能力目前仅对党政机关/事业单位等主体开放，一般企业的第三方工具无法通过官方接口代发视频

**依据**：直接调用能力页背后的官方接口取到正文（2026-10-02）：『当前能力仅支持网站应用进行申请开通，仅可在网站应用的电脑端网站中进行授权、使用』『可用场景范围：仅支持政务或媒体机构，做内部的多媒体管理平台，但不可对外面向C端用户使用』『准入条件：开发者主体需为党政机关或事业单位；应用类型为抖音开放平台正式网站应用』。《移动/网站应用能力申请及使用规范》原文另有：『开发者在使用代替用户发布内容到抖音的相关能力时，仅可用于企业内部或者签约的账号的内容管理。同时，实时发布或者预设发布需要用户自己在第三方应用上进行操作』『不得大量发布同质化内容，包括但不限于：同个账号多次发布相似视频、相似视频发布到多个账号上』。我还核了另一条可能的替代路径——『发布内容至抖音』（SDK/H5 拉起抖音发布页）：『仅对创作工具、社区、硬件配套、游戏类应用开放』『如涉及企业宣传、商品介绍、诱导分享等营销类内容分享，将不开放该能力准入』，同样走不通。未能证伪。

**来源**：
- https://developer.open-douyin.com/capacity-center-page/capacity-detail/7224121299067469881
- curl 'https://developer.open-douyin.com/bff_api_v2/capacityCenterService/getCapacitySetDetailV2?CapacitySetID=7224121299067469881'
- curl 'https://developer.open-douyin.com/bff_api_v2/capacityCenterService/getCapacitySetDetailV2?CapacitySetID=7180322911280955447'
- https://developer.open-douyin.com/docs/resource/zh-CN/dop/operation-standard/platform-capabilities/usage-spec

### pub-2　成立

**待核结论**：已认证的视频号可由管理员在视频号助手中添加运营者微信号（原结论最多 20 个），运营者可登录视频号助手发表视频

**依据**：微信开放社区官方账号『社区技术运营专员-channels』2022-10-11 的回答原文：『已认证的视频号，视频号管理员可以通过“视频号助手”增加帐号运营者，每个视频号可由管理员设置最多20个运营者微信号。运营者可在视频号助手（https://channels.weixin.qq.com/platform）进行除帐号设置外的所有操作，如登录、发表、互动、直播管理等。』同一官方账号 2021-06-29、2021-12-07 的两条回答也写『每个视频号可由管理员设置20个运营者微信号……如登录、发表、互动』（这两条没有“已认证”前提）。2024-06、2024-12 的用户帖转述绑定页文案仍为 20 个。注意三点局限：(1) 官方表述最晚是 2022 年，未找到 2026 年的官方帮助文档，上线前需登录视频号助手实看；(2)“认证是否为硬前提”官方回答前后不一致，PRD 写的“仅适用于已认证的视频号”不能视为已证实；(3) 一个微信号最多可当多少个视频号的运营者，官方无答复（2024-06 提问帖至 2025-12 仍无官方回复）。原 ext-wechat 报告称“已认证”无出处，其实出处就在 PRD 引用的那个帖子的官方回答里。

**来源**：
- https://developers.weixin.qq.com/community/minihome/doc/000ae02293c890c8a9aef397c5b800
- https://developers.weixin.qq.com/community/minihome/doc/0000e450578ac037de5c43a6353c00
- https://developers.weixin.qq.com/community/minihome/doc/000262f85d4fd026812d5314e51c00
- https://developers.weixin.qq.com/community/minihome/doc/000882f50cc5304afd82eecd46b800
- https://developers.weixin.qq.com/community/minihome/doc/000a48bbe801d01235a12eff76b000

### pub-3　部分成立

**待核结论**：抖音对单个账号单日发布视频数量或短剧合集的上传有上限或风控（原结论：二手资料称 30 条/天上下，未见官方原文）

**更正**：“存在上限或风控”方向成立，但数字不能用：(1) 没有任何官方原文支持“30 条/天”；二手原话是“短剧/漫剧 30 部/天”，与“一天发 40–100 集”不是同一口径；(2) 官方可查的硬数字只有开放接口通道的 75 个作品/用户/应用/天；(3) 蓝V 20–30 条/天的说法若属实会直接卡死“一次性上线 40–100 集”，但同样无官方出处。结论应写成：一次性上线是否可行“官方资料无法确认”，架构上发布任务必须支持分批、跨日排期和逐集回填/核验，并在上线前用真实企业号实测单日可发条数与合集容量。

**依据**：查到的唯一官方数字在开放平台『创建视频』接口错误码表：『2114007 视频发布数量超过每日上限：一个用户在一个应用下，一天最多发布75个作品』『2114006 视频时长不能超过15分钟』——但这是 pub-1 那个拿不到的接口通道，不是 App/创作者服务平台的规则。“30”的出处是搜狐/知乎 2026-03-09 的自媒体文，原话是『短剧/漫剧内容：单个账号单日最多发 30 部，超出部分系统直接拦截』（单位是“部”不是“集/条”），同文还称『普通内容官方没设固定数量限制』『蓝V企业号基础能发20条/天，认证后可申请升到30条/天』，全文无任何官方公告名、链接或日期。另：多家媒体转述“抖音创作者中心”规则称 2026-06-05 起真人短剧单集硬上限 3 分钟（中华网稿写明是“无法在短剧创作者中心上传”），未见官方原文。抖音合集单个合集的作品数上限、普通账号单日发布硬上限，均未查到官方原文（搜过抖音开放平台文档、公告、抖音黑板报转载、微信/抖音规则相关检索）。视频号侧：官方社区 2021-05-11 答复『暂时没有数量限制』；但官方《短剧组件发表指引》写『频次不建议过高，如果一个账号每天所发布的内容量异常过多会影响推荐分发』。

**来源**：
- https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-create
- https://www.sohu.com/a/994227568_121231944
- https://www.tvoao.com/a/224298.aspx
- https://hea.china.com/articles/20260617/202606171896130.html
- https://developers.weixin.qq.com/community/minihome/doc/000c2845210a18e40c2c68a3756000
- https://support.weixin.qq.com/cgi-bin/mmsupportacctnodeweb-bin/pages/SIpzHE629sgfRQdD

### pub-4　部分成立

**待核结论**：抖音对“短剧/微短剧”类内容的发布有额外的备案或资质要求（例如需在抖音侧提交剧目备案信息、挂载备案号），普通商家账号直接上传整部短剧可能被限制或下架

**更正**：应拆成两句：①“微短剧在抖音播出须有许可证/批准文件/平台审核后的节目编号，平台有核验与自审义务”——已证实（法规 + 抖音小程序侧官方公告）；②“普通商家账号直接上传整部短剧会被限制或下架”——是合理推断，官方规则未明示，状态为未证实。另外术语需更新：2026-09-01 后法规口径是一类《微短剧发行许可证》、二类批准文件编号、三类由播出单位审核并标注的节目编号，不再是“备案号”一个词；且三类剧的节目编号按平台各自发放、不可跨平台使用（见 extraFindings 第 1 条），这比“挂载备案号”严重得多。

**依据**：前半句有一手依据：(1) 广电总局令第 16 号第十七条『未按本办法规定取得《微短剧发行许可证》、批准文件，以及未经过播出单位审核并标注节目编号的微短剧，不得播出』；第三十三条：播出单位对一类、二类『播出前应当核验其《微短剧发行许可证》或者批准文件』，对三类『播出前应当按照本办法规定进行审核，并同步将相关剧目信息和节目编号在线上系统报广播电视主管部门；对非独播的三类微短剧，播出单位应当根据各自审核版本标注本播出单位的节目编号，不得使用其他播出单位的节目编号』；(三) 对『非专业制作、总时长较短的具有微短剧特征的网络视听内容』平台也要履行内容管理职责。(2) 抖音开放平台 2024-05-31 官方公告（对象是微短剧小程序开发者）：『自2024年6月1日起，凡是未通过审核，未获取《网络剧片发行许可证》或相关备案号的微短剧作品，将无法在平台进行经营推广』，三档备案，材料经内容库接口 record_audit_info 字段提交，违者『封禁、下架小程序』。(3) 二手：澎湃/知乎称短剧创作者中心（原抖音集团短剧版权中心）上传需填『剧壳信息+制作团队+备案信息+合同信息+版权信息』；2024-05 媒体转述抖音向『短剧开发者和作者』发通知要求上传成本配置比例报告与片酬承诺书。后半句没有一手依据：我没有查到任何抖音官方规则原文，说明普通企业号/商家号把一部已有许可的剧当普通视频或合集整部上传时，是否必须填备案信息、是否有专门入口、是否会被限制或下架。

**来源**：
- https://www.nrta.gov.cn/art/2026/7/31/art_113_73785.html
- https://developer.open-douyin.com/forum/bulletin/post/665945486cddcc2c8ecfaee1
- https://www.thepaper.cn/newsDetail_forward_32966480
- https://news.bjd.com.cn/2024/05/21/10780102.shtml
- https://m.thepaper.cn/newsDetail_forward_27441172

### pub-5　部分成立

**待核结论**：视频号对发布微短剧同样有备案号/许可证信息要求

**更正**：准确说法：微信对微短剧的备案/许可证要求是明确的，但官方落点是“微短剧类目小程序的剧目提审”（填许可证号或由平台下发仅限微信小程序使用的备案号）；视频号上官方认可的短剧发表方式是挂载已提审剧目的“短剧组件”，且只面向持微短剧类目小程序的机构及其授权的最多 50 个自营视频号。商家视频号把整部剧当普通视频直接发表，官方规则没有给出备案填写入口，也没有明示允许或禁止——不能表述为“视频号发表时要求填备案号”，应表述为“规则未明示的灰区，平台按第 16 号令负有核验/自审义务，存在被处置风险”。

**依据**：微信侧一手资料都落在“微短剧类目小程序”上，而不是视频号账号发表环节：(1) 微信开放文档『剧目提审』接口：qualification_type『1-取得《网络剧片发行许可证》或重点节目备案号；2-未取得……且制作成本小于100万元』；registration_number『剧目备案号，当qualification_type=1时必填』；『剧目经平台审核后由平台下发备案号（备案号仅适用微信小程序平台）并在视频播放环节展示备案号水印』。(2) 微信官方《【视频号】短剧组件发表指引文档》：视频号发短剧的官方路径是『短剧机构进行账号授权，绑定后即可发表短剧内容并挂载相关短剧小程序』，小程序须『有“微短剧”类目』且『接入播放器』，在视频号助手发表时选『链接-短剧』并从『小程序剧目列表』选剧；『管理员最多可以将该短剧小程序组件授权给50个视频号创作者』；『合作作者……不可以，目前功能适用于自营账号』。(3) 法规层面第 16 号令第十七、三十三条对视频号作为播出单位同样适用。未查到：视频号官方关于“普通视频号直接上传整部微短剧须填写备案号/许可证”的规则原文或填写入口；微信珊瑚安全的处置公告对象均为“微短剧类小程序/剧目”。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/server/API/minidrama/auditdrama/api_auditdrama.html
- https://support.weixin.qq.com/cgi-bin/mmsupportacctnodeweb-bin/pages/SIpzHE629sgfRQdD
- https://www.nrta.gov.cn/art/2026/7/31/art_113_73785.html
- https://m.thepaper.cn/newsDetail_forward_27441172

### pub-6　成立

**待核结论**：《人工智能生成合成内容标识办法》已于 2025-09-01 施行，要求显式标识（视频起始画面等位置）与隐式标识（文件元数据），传播平台须核验并提示，用户发布 AI 生成内容应主动声明

**依据**：网信办官网原文（国信办通字〔2025〕2号，四部门，2025-03-07 印发）：第十四条『本办法自2025年9月1日起施行』；第四条(四)『在视频起始画面和视频播放周边的适当位置添加显著的提示标识，可以在视频末尾和中间适当位置添加显著的提示标识』；第五条『在生成合成内容的文件元数据中添加隐式标识，隐式标识包含生成合成内容属性信息、服务提供者名称或者编码、内容编号等制作要素信息』；第六条：传播平台『核验文件元数据中是否含有隐式标识……在发布内容周边添加显著的提示标识』『提供必要的标识功能，并提醒用户主动声明』；第十条『用户使用网络信息内容传播服务发布生成合成内容的，应当主动声明并使用服务提供者提供的标识功能进行标识。任何组织和个人不得恶意删除、篡改、伪造、隐匿本办法规定的生成合成内容标识』。需要留意义务主体：第四、五条约束的是“服务提供者”（生成合成服务方），第十条约束用户（即发布成片的商家）；制作机构的每集标识义务来自第 16 号令第三十四条。平台已落地：抖音黑板报 2026-08-31 公告称『2026年5月，抖音发布《抖音内容标识使用规范》，要求创作者发布使用平台AI特效或第三方AI工具生成的内容时，应添加“内容由AI生成”的标识』，并对『元数据中已包含AI内容标识的作品，补充添加显式标识』。

**来源**：
- https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm
- https://finance.sina.com.cn/wm/2026-08-31/doc-iniqfqsp8758781.shtml
- https://xinwen.bjd.com.cn/content/s68b3c56ce4b02424b0bf8cd5.html

### pub-7　成立

**待核结论**：《微短剧发展管理办法》（国家广电总局令第 16 号）自 2026-09-01 起施行，要求 AI 生成制作的微短剧每集明显位置添加提示标识

**依据**：广电总局官网页面真实存在（HTTP 200，2026-07-31 16:15 发布，来源网络视听节目管理司），原文：『国家广播电视总局令 第16号 《微短剧发展管理办法》已经2026年7月27日国家广播电视总局局务会审议通过，现予公布，自2026年9月1日起施行。国家广播电视总局局长：曹淑敏 2026年7月30日』；第三十四条『使用人工智能技术生成、制作的微短剧，制作机构和播出单位应当遵守国家有关规定，并依据有关规定在每集明显位置添加提示标识』；第五十四条『本办法自2026年9月1日起施行』。新华网 2026-07-31 转载全文一致。PRD §10.3 引用的第十七、二十七、二十八、三十一、三十五条我也逐条对过原文，引述无误（第二十七条完整表述还有『展示方式可根据特定类型微短剧的总时长、情节设置及传播特点，单独呈现或者与剧情融合呈现』）。未能证伪。

**来源**：
- https://www.nrta.gov.cn/art/2026/7/31/art_113_73785.html
- https://www.news.cn/legal/20260731/4b8eea40226644d0a347c72ea1b21b75/c.html

### pub 组的额外发现

- 【重大，PRD 未覆盖】第 16 号令第三十三条(二)：『对非独播的三类微短剧，播出单位应当根据各自审核版本标注本播出单位的节目编号，不得使用其他播出单位的节目编号』；微信开放文档同样写明平台下发的备案号『仅适用微信小程序平台』。含义：三类剧的节目编号按平台各发各的、不可跨平台携带。短剧库的“许可信息”不能是一条记录，至少要按「剧 × 播出平台」建模（一类许可证号 / 二类批准文件编号 / 三类各平台节目编号），并在选剧、订购、发布清单上按目标平台校验；PRD §10.3“成片保留片头信息”对三类剧在抖音、视频号双发时不成立（片头烧的是哪家的编号）。“各自审核版本”也意味着按门店改过的成片可能被视为另一个审核版本，需法务确认。
- 第 16 号令的罚则与边界（原文）：第四十六条『未按照备案的内容制作、未按照许可通过的内容播出或者转移送审的……可以并处十万元以下罚款』；第四十四条擅自播出按《广播电视管理条例》第五十条处罚；第二十九条播出单位须有广播电视或网络视听相应资质；第二条微短剧定义为『单集时长少于二十分钟』的剧集。一类、二类剧改动正片后播出的风险是有明确罚则的，不只是“限流”。
- 抖音“半自动发布”路径也被堵死：『发布内容至抖音』（SDK/H5 拉起抖音发布页）能力『仅对创作工具、社区、硬件配套、游戏类应用开放』『如涉及企业宣传、商品介绍、诱导分享等营销类内容分享，将不开放该能力准入』。加上产品载体是微信小程序，V1.0 的抖音发布只能是“成片下载到手机相册后，商家在抖音 App 手动发布”，后台不要预留任何抖音发布/拉起接口。来源：curl https://developer.open-douyin.com/bff_api_v2/capacityCenterService/getCapacitySetDetailV2?CapacitySetID=7180322911280955447
- 视频号官方的短剧发表机制是“短剧组件”：需要一个有“微短剧”类目且接入官方播放器（校验播放器曝光 pv 占比 >90%）的小程序，管理员在视频号助手把组件授权给最多 50 个视频号，且『30天内最多解绑旧账号15个、并绑定新账号15个，365天内最多……50个』，『合作作者不可以』用此方式。这条官方路径的 50 账号上限与“每个商家一个视频号”的规模不匹配，且要求平台自己持微短剧类目小程序；V1.1 视频号代发布只能走运营者人工在视频号助手发普通视频。来源：https://support.weixin.qq.com/cgi-bin/mmsupportacctnodeweb-bin/pages/SIpzHE629sgfRQdD
- V1.1 运营者代发与 AI 声明可能冲突（线索，非官方）：微信开放社区 Bug 反馈帖（页面显示 04-12，未显示年份，推断为 2026 年；无官方回复）称『设置的运营者微信号，在转发中没有“视频标注/添加声明”的按钮，无法对视频进行“含AI生成内容”标注。视频在视频号助手发布页面，也没有……功能选项』。若属实，运营者代发的 AI 成片无法由运营者完成主动声明，只能由管理员（商家本人）在手机端补标——发布任务流程需要留“商家补做 AI 声明”一步，上线前真机验证。来源：https://developers.weixin.qq.com/community/minihome/doc/000e826c33c260c546f45c2e366400
- 平台 AI 声明入口（发布清单/指引要写进去）：抖音——官方公告称『将“自主声明”功能前置至投稿一级页面』，对『元数据中已包含AI内容标识的作品，补充添加显式标识』，并为所有 AI 内容『添加或更新隐式标识』；即成片若带 AIGC 元数据，抖音会自动打标，合成环节保留/写入元数据会直接影响平台展示。视频号——媒体转载的《微信视频号关于加强AI生成内容治理的公告》（2026-03-06）给出入口『视频发表页 > 添加标注 > 含AI生成内容』（二手转载，未取到微信原文）。来源：https://finance.sina.com.cn/wm/2026-08-31/doc-iniqfqsp8758781.shtml ；https://www.sohu.com/a/993360229_121106991
- 真人短剧单集 3 分钟上限（二手，未见官方原文）：多家媒体转述“抖音创作者中心”规则，2026-06-05 起『平台真人短剧单集硬性时长上限为3分钟，不再支持上传单集时长超出该标准的内容』，中华网稿称是『无法在短剧创作者中心上传』，AI 短剧、漫剧暂不受限。是否适用于普通账号发布的视频未明。若适用，片头 3–5 秒 + 片尾 5–10 秒贴片会让原片 2:45 以上的剧集越线——短剧库入库体检应记录每集时长并在选剧/合成时预警。来源：https://www.tvoao.com/a/224298.aspx ；https://hea.china.com/articles/20260617/202606171896130.html
- 平台规则与新法规术语尚未对齐：微信剧目提审文档仍用『《网络剧片发行许可证》或重点节目备案号 / 制作成本小于100万元』两档（文档注明 2026-01-14 起用新模板、2026-07-28 起弃用 authorized_material_id），抖音 2024 年公告用 100 万/30 万三档与“节目唯一登记备案号”，而第 16 号令是一/二/三类 +《微短剧发行许可证》/批准文件编号/节目编号，分类标准『由国务院广播电视主管部门制定』（本次未查到金额标准的官方原文，二手说法 300 万/100 万不一致，不要写进系统）。短剧库许可字段要同时容纳新旧两套证号格式，类别用可配置字典。
- 抖音《移动/网站应用能力申请及使用规范》对代发能力的附加约束（即便将来拿到能力也适用）：『仅可用于企业内部或者签约的账号的内容管理』『实时发布或者预设发布需要用户自己在第三方应用上进行操作』『支持用户勾选「是否同步」「是否删除」』。PRD §12.3 第 1 项“服务商代发布的授权方式，尤其是抖音账号”在官方接口层面没有可行解，只剩人工登录代运营，而 PRD §10.2-3 又规定不收集、不存储商家平台账号密码——两者需要业务取舍。

## 企业微信与微信客服

### wc-1　成立

**待核结论**：企业微信“客户联系 > 配置客户联系「联系我」方式”（externalcontact/add_contact_way）可生成带 state 参数的二维码，客户添加后企业会收到带 state 的添加外部联系人事件回调

**依据**：官方文档 92228：请求地址 https://qyapi.weixin.qq.com/cgi-bin/externalcontact/add_contact_way；参数 scene“1-在小程序中联系，2-通过二维码联系”；state“企业自定义的state参数，用于区分不同的添加渠道，在调用“获取客户详情”时会返回该参数值，不超过30个字符”；返回 qr_code“联系我二维码链接，仅在scene为2时返回”。官方文档 92130（添加企业客户事件，Event=change_external_contact，ChangeType=add_external_contact）：State“添加此用户的「联系我」方式配置的state参数，或在获客链接中指定的customer_channel参数，可用于识别添加此用户的渠道”。补充限制（同页原文）：“每个企业可通过API最多配置50万个「联系我」”“通过API添加的「联系我」不会在管理端进行展示”“配置的使用成员必须在企业微信激活且已经过实名认证且配置了客户联系功能”；type=1 时 user 必填且只能一个。另有一个实现细节：成员开启免验证时会先回调 add_half_external_contact（“此时成员尚未确认添加对方为好友”），该事件同样带 State，需两种 ChangeType 都处理并做幂等。

**来源**：
- https://developer.work.weixin.qq.com/document/path/92228
- https://developer.work.weixin.qq.com/document/path/92130

### wc-2　成立

**待核结论**：小程序 image 组件开启 show-menu-by-longpress 后，可长按识别企业微信个人名片码/「联系我」二维码并跳转添加（核对支持的码类型与基础库版本）

**依据**：小程序官方 image 组件文档（直接抓取正文）：show-menu-by-longpress 属性最低版本 2.7.0，说明为“长按图片显示发送给朋友、收藏、保存图片、搜一搜、打开名片/前往群聊/打开小程序（若图片中包含对应二维码或小程序码）的菜单”；“支持长按识别的码”表：小程序码（无版本）、微信个人码 2.18.0、企业微信个人码 2.18.0、普通群码 2.18.0、互通群码 2.18.0、公众号二维码 2.18.0。企业微信官方文档 93582 原文：“微信iOS系统V8.0.6和安卓系统V8.0.3及以上版本的用户可直接在小程序内长按识别「联系我」二维码了，之前版本的用户仍需通过接收服务通知获取联系方式。”两处一手来源互相吻合。注意点：(1) 小程序文档表里写的是“企业微信个人码”，没有逐字列出「联系我」码，后者的依据来自企业微信侧文档，且该文档未指明是 image 组件还是 previewImage；(2) 2021-06 社区《小程序内嵌二维码长按识别内测QA》（作者非官方账号标记，仅作线索）称 image 组件场景需 iOS 8.0.8/安卓 8.0.7，并称“企业微信活码不支持识别，暂无放开计划”（语境为群码）；多人「联系我」(type=2) 是否可识别未找到一手说明。建议只用单人码 (type=1) 并真机验证。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/component/image.html
- https://developer.work.weixin.qq.com/document/path/93582
- https://developers.weixin.qq.com/community/develop/article/doc/000ae09dcfc8887e4b4c287e75b813

### wc-3　成立

**待核结论**：自建后台可用企业微信 Web 登录（扫码/OAuth）拿到成员 userid，从而把后台员工账号与企业微信成员绑定

**依据**：官方文档 98152（企业微信 Web 登录）：登录链接 https://login.work.weixin.qq.com/wwlogin/sso/login?login_type=LOGIN_TYPE&appid=APPID&redirect_uri=...&state=...，自建应用 login_type=CorpApp 并填 agentid；也可用“@wecom/jssdk >=2.3.2”的 ww.createWWLoginPanel 内嵌面板；“redirect_uri的域名必须配置为可信域名”，自建应用为“OAuth可信域名或者Web网页授权回调域名”；授权后回跳 redirect_uri?code=CODE&state=STATE。官方文档 98176（获取用户登录身份）：GET https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?access_token=...&code=...，“适用于自建应用与代开发应用”；“code只能使用一次，5分钟未被使用自动过期”；“当用户为企业成员时（无论是否在应用可见范围之内）”返回 userid；非企业成员只返回 openid（及可能的 external_userid）。npm 实测：@wecom/jssdk latest = 2.4.4（2026-09-04 发布）。附带约束见 extraFindings（可信域名备案主体、可信 IP、敏感信息不再直接返回）。

**来源**：
- https://developer.work.weixin.qq.com/document/path/98152
- https://developer.work.weixin.qq.com/document/path/98176
- https://developer.work.weixin.qq.com/document/path/91023
- npm view @wecom/jssdk dist-tags --json

### wc-4　成立

**待核结论**：企业微信自建应用可通过 message/send 给成员发送应用消息，有频率限制（原结论：对同一成员每分钟 30 次、每小时 1000 次）

**依据**：官方文档 90236（发送应用消息，POST https://qyapi.weixin.qq.com/cgi-bin/message/send）原文：“频率限制：每应用不可超过账号上限数*200人次/天（注：若调用api一次发给1000人，算1000人次；若企业账号上限是500人，则每个应用每天可发送100000人次的消息）。每应用对同一个成员不可超过30次/分钟，1000次/小时，超过部分会被丢弃不下发”。同页“调用建议：大部分企业应用在每小时的0分或30分触发推送消息……建议尽量避开这两个时间点”。enable_duplicate_check 默认 0，duplicate_check_interval 默认 1800 秒、最长不超过 4 小时。注意超限是静默丢弃而非报错，业务侧需自己做限流与发送记录。

**来源**：
- https://developer.work.weixin.qq.com/document/path/90236

### wc-5　成立

**待核结论**：企业微信自建应用调用服务端 API 需配置“企业可信 IP”，服务器出口 IP 必须固定

**依据**：官方《开发前必读》90664 原文：“为了企业的数据安全，从2022年6月20号20点之后，新开启的通讯录同步助手与新创建的自建应用必须在管理端配置可信IP，仅配置的可信IP能调用接口。”官方公告《自建及代开发应用安全性升级》：“企业新开启的通讯录同步和新创建的自建应用，需将本企业服务器的IP地址配置到新增的“企业可信IP”字段，仅所配IP可调用企业微信接口。若未配置“企业可信IP”，则该应用无法调用企业微信接口。”“‘企业可信IP’不可配置第三方服务商的IP”；2022-06-20 灰度、06-28 全量；历史已创建的自建应用暂不受影响。全局错误码 90313：60020“不安全的访问IP……请确认该IP是本企业服务器IP，并已经配置到应用详情的‘企业可信IP’项目中……配置完可信IP之后，需要1分钟后才生效”。“出口 IP 必须固定”是白名单机制的直接推论（可配置多个 IP，但必须可枚举）；本项目是新建应用，必然受此约束。可配置 IP 数量上限、是否支持网段，官方文档未查到。

**来源**：
- https://developer.work.weixin.qq.com/document/path/90664
- https://work.weixin.qq.com/nl/act/p/32d807ad4c554975
- https://developer.work.weixin.qq.com/document/path/90313

### wc-6　部分成立

**待核结论**：小程序可通过 wx.openCustomerServiceChat 打开“微信客服”会话，需要企业微信侧开通微信客服并将小程序与企业关联；也可用 button open-type="contact" 的小程序原生客服消息

**更正**：两条路径都成立，但“将小程序与企业关联”需改成准确说法：绑定动作在**小程序管理后台「功能-客服-微信客服」**里填写企业ID完成（不是在企业微信侧），且官方明确要求绑定**同主体**的微信客服企业ID、仅支持**非个人主体**小程序、企业需先完成**企业验证**。原报告把“需在小程序后台绑定企业ID”标为【非官方】，实际有官方文档；原报告漏了“同主体”这一硬约束——小程序主体与企业微信主体不是同一家公司时该方案不可用（未绑定时报 openCustomerServiceChat:fail corpId is not bound to current miniprogram）。

**依据**：小程序官方文档 wx.openCustomerServiceChat（直接抓取正文）：“基础库 2.19.0 开始支持”“小程序插件：不支持”“限制：仅在点击行为时调用”；参数 extInfo.url（客服链接，必填）、corpId（企业ID，必填）、showMessageCard / sendMessageTitle / sendMessagePath / sendMessageImg。企业微信官方文档 97013 原文：“该功能已向非个人的全体小程序开放，小程序开发者在小程序管理后台处，绑定同主体的微信客服（企业ID）后，即可调用小程序相关接口，接入微信客服。”企业微信官方指引页：“登录企业微信管理后台，进入「我的企业」，完成企业验证”“在小程序管理后台的「功能-客服-微信客服」处，填写对应的企业ID，完成绑定。（备注：暂仅支持绑定非个人小程序）”。原生客服：小程序官方《客服消息使用指南》“需要将 button 组件 open-type 的值设置为 contact”，下发限制“用户发送信息 5 条 / 48 小时；用户进入客服消息 2 条 / 1 分钟”。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/api/open-api/service-chat/wx.openCustomerServiceChat.html
- https://developer.work.weixin.qq.com/document/path/97013
- https://work.weixin.qq.com/nl/act/p/a733314375294bdd
- https://developers.weixin.qq.com/miniprogram/introduction/custom.html
- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/customer-message/customer-message.html

### wc 组的额外发现

- 【主体一致性是总前提】企业微信官方《企业内部开发配置域名指引》：“企业内部开发包括自建应用、通讯录同步、客户联系等，配置域名的备案主体需要与企业认证主体相同，或具有关联关系，否则将无法配置。”（关联关系限母子公司、总分公司、同一集团绝对控股、同一自然人绝对控股）。这直接影响后台 Web 登录的 redirect_uri 可信域名、回调 URL 域名；叠加微信客服要求“绑定同主体的企业ID”，结论是：企业微信主体、小程序主体、后台域名 ICP 备案主体应为同一家（或可证明的关联）公司，否则 wc-3 / wc-6 落不了地。来源：https://open.work.weixin.qq.com/wwopen/common/readDocument/40754
- 【未核实的前置条件】原报告称“配置可信 IP 前要先设置可信域名或接收消息 URL”，我只在 CSDN/百度云等二手文章中见到，企业微信官方文档（90664、90313、安全性升级公告）均未写明，按 unverifiable 对待；但因可信域名本身受备案主体校验约束，部署前应在真实企业后台实操确认一次。
- 【新建自建应用拿不到成员敏感信息】官方安全性升级公告：“新创建的自建应用及新授权的代开发应用，成员敏感信息需要成员在登录应用时自主授权，通过「获取访问用户敏感信息」接口获取”；通过客户联系/微信客服等基础 secret 访问成员信息时不再返回头像、性别、手机号、邮箱、地址、员工二维码。后台员工表只应依赖 userid 做绑定，不要假设能直接拉到手机号/头像做自动匹配。来源：https://work.weixin.qq.com/nl/act/p/32d807ad4c554975
- 【微信客服走 API 时同样有 48 小时/5 条限制】官方 kf/send_msg 文档：“当微信客户处于‘新接入待处理’或‘由智能助手接待’状态下，可调用该接口给用户发送消息。注意仅当微信客户在主动发送消息给客服后的48小时内，企业可发送消息给客户，最多可发送5条消息”。即原报告用来否定“小程序客服消息”的 48h/5 条限制，在微信客服的 API 自动回复路径上同样存在；选微信客服的理由应是“人工接待在企业微信内完成”，而不是“没有条数限制”。另外自建应用须在“微信客服应用-API-可调用接口的应用”中配置，且一旦某客服账号设为由 API 管理，“官方原生设置的接待规则将暂不生效”。来源：https://developer.work.weixin.qq.com/document/path/94677 ，https://developer.work.weixin.qq.com/document/path/94638
- 【免验证加好友的回调事件】成员开启免验证（add_contact_way 的 skip_verify 默认 true）时，企业微信会回调 ChangeType=add_half_external_contact（“此时成员尚未确认添加对方为好友”），同样带 State；商家与 external_userid 的自动绑定逻辑需同时处理 add_half_external_contact 与 add_external_contact 并做幂等。来源：https://developer.work.weixin.qq.com/document/path/92130
- 【群活码不可识别（线索级）】2021-06 微信开放社区《小程序内嵌二维码长按识别内测QA》称“企业微信活码不支持识别，暂无放开计划”（语境为企业微信群码），并提示“请勿使用利诱等方式诱导用户添加好友或者加入群聊……若发现违反规范的行为将封禁识别能力”。作者账号无官方标记，仅作线索：若后续想在小程序里放“客户群活码”，大概率不可行；添加服务经理的页面文案也不要带利诱。来源：https://developers.weixin.qq.com/community/develop/article/doc/000ae09dcfc8887e4b4c287e75b813
- 【「联系我」小程序插件】官方文档 93582 确认插件 AppID wx104a1a20c3f81ec2，仅支持微信小程序环境；可作为长按识别二维码之外的一键添加方案（scene=1 的配置不返回 qr_code，只返回 config_id）。
- 【可信 IP 生效延迟与不可用第三方 IP】官方错误码文档：配置可信 IP 后“需要1分钟后才生效”，且“第三方服务商IP不能调用”。若后端部署在 Serverless / 无固定出口的容器平台，需要 NAT 网关或固定出口代理；企业微信相关调用（gettoken、message/send、externalcontact、kf）都受此限制。来源：https://developer.work.weixin.qq.com/document/path/90313

## 腾讯云 COS / 数据万象 / CDN / 点播

### cos-1　成立

**待核结论**：COS 预签名 URL：使用临时密钥（STS）签名时，URL 实际有效期受临时密钥有效期约束（主账号最长 2 小时、子账号最长 36 小时）；S3 兼容 SigV4 预签名最长 7 天

**依据**：(1) COS《使用预签名 URL 访问 COS》(更新 2024-06-21) 原文：“临时密钥最长为36小时，预签名 URL 的有效期会取您设置的签名有效期和临时密钥有效期的最小值”，并给出 T=min(X,Y)；永久密钥一节标题为“任意时长”。(2) STS GetFederationToken 的 DurationSeconds 原文：“默认1800秒，主账号最长可设定有效期为7200秒，子账号最长可设定有效期为129600秒”。(3) SigV4 7 天：AWS SDK 源码 @smithy/signature-v4@5.7.4 中 `MAX_PRESIGNED_TTL = 60 * 60 * 24 * 7`，超出即 reject “must have an expiration date less than one week in the future”；AWS 官方文档检索摘要为“maximum is 604800 (seven days)”（该页 WebFetch 抓取为空，未逐字核对原页）。注意两点出入但不影响结论：2h/36h 是 GetFederationToken 的上限，若改用 AssumeRole 上限为 43200 秒（12 小时，默认 7200）；7 天上限由 AWS SDK 在客户端强制，COS 服务端对 SigV4 预签名是否另有上限，COS 文档未写。

**来源**：
- https://cloud.tencent.com/document/product/436/68284
- https://cloud.tencent.com/document/product/1312/48195
- https://cloud.tencent.com/document/product/1312/48197
- https://unpkg.com/@smithy/signature-v4/dist-cjs/index.js
- https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
- https://cloud.tencent.com/document/product/436/37421

### cos-2　部分成立

**待核结论**：数据万象“多文件打包压缩”是异步任务，单任务文件数上限 1000、总大小上限 50GB，支持 zip，按打包前文件大小计费（约 0.05 元/GB）

**更正**：多文件打包压缩为异步任务，支持 zip/tar/tar.gz，按打包前大小 0.05 元/GB 计费。文件数 1000 的上限仅针对 KeyConfig 入参方式；用 Prefix 或 UrlList(CSV 索引文件)可打更多。现行官方限制是单包最多 1000 万个文件、压缩包不大于 50TB；“50GB”是旧 SDK 文档口径，不应作为设计上限（保守起见可在 PoC 中实测）。

**依据**：成立部分：API 文档(更新 2026-05-12)“以提交任务的方式进行多文件打包压缩，异步返回打包后的文件”；Format“有效值：zip、tar、tar.gz”；文件处理费用(更新 2026-03-09)“多文件打包压缩 0.05元/GB”“按照打包前的文件大小收费”。不成立部分：1000 只是 KeyConfig 方式的限制，原文“个数不能超过 1000，如需打包更多文件，请使用 UrlList 或 Prefix 参数”。现行《使用限制》(更新 2026-09-03) 写的是“文件数量限制：最多支持将1000万个文件打包到一个压缩包中”“压缩包大小限制：打包后的压缩包不得大于50TB”。“总大小不超过50G”只出现在 2024-07-11 的 Go SDK 示例页（同页还写 Prefix 方式“最多不超过10000个文件”），与现行限制页不一致，应以限制页为准。另：异步任务记录只保留一个月。

**来源**：
- https://cloud.tencent.com/document/api/436/83112
- https://cloud.tencent.com/document/product/460/36620
- https://cloud.tencent.com/document/product/460/82333
- https://cloud.tencent.com/document/product/460/108574
- https://cloud.tencent.com/document/product/460/102156

### cos-3　成立

**待核结论**：私有读桶接入 CDN 的官方做法是开启“回源鉴权”并在 CDN 侧开启时间戳鉴权（URL 鉴权），可按文件后缀限定鉴权对象

**依据**：COS《域名管理概述》(更新 2024-10-14)：“如果源站为私有读存储桶，则建议用户开启 CDN 回源鉴权和 CDN 鉴权配置两个选项”；组合表中“私有读+CDN 服务授权 / 开启 / 开启 → 需使用 URL 鉴权 / 需使用 COS 鉴权 / 全链路保护”；只开回源鉴权为“源站保护”，并注明“强烈建议同时开启 CDN 鉴权配置”。回源鉴权前提是“已添加 CDN 服务授权”。CDN 鉴权实践文档(228/76110)：“鉴权范围：指定文件后缀鉴权”“推荐选择指定文件后缀鉴权”。鉴权模式 TypeA–D，TypeA 有效时间“最大可输入630720000s”。

**来源**：
- https://cloud.tencent.com/document/product/436/18424
- https://cloud.tencent.com/document/product/228/76110
- https://cloud.tencent.com/document/product/228/41622
- https://cloud.tencent.com/document/product/228/41623

### cos-4　成立

**待核结论**：数据万象/媒体处理支持把 MP4 转为 HLS 并生成多码率自适应码流（master playlist）；小程序原生 video 组件在 iOS 与安卓上均支持播放 HLS(m3u8)

**依据**：CI 功能概览(更新 2026-09-21)与《自适应码流》：“自适应码流能够从单一原视频一次性生成多码率自适应的 HLS 或 DASH 目标文件”。创建工作流 API 中有 StreamPackConfig(PackType 默认 HLS，可选 HLS/DASH)、多个 VideoStream 子流节点、StreamPack 节点(每子流 BandWidth)，子流输出如 `${RunId}_Substream_1/video.m3u8`；CI 词汇表：“Master Playlist 格式下的 HLS 是目前应用最广泛的自适应码流格式”。微信官方 video 组件文档“支持的格式”表：m3u8 行 iOS √、Android √。两点限定：CI 文档写明“您可通过工作流方式使用自适应码流功能”（不是单个任务接口），工作流数量默认上限 10 个；微信文档只保证 m3u8 格式可播，未承诺主清单多码率切换在所有机型上的表现，仍需真机验证。

**来源**：
- https://cloud.tencent.com/document/product/460/53155
- https://cloud.tencent.com/document/product/460/58430
- https://cloud.tencent.com/document/product/460/76856
- https://cloud.tencent.com/document/product/460/78927
- https://cloud.tencent.com/document/product/460/30206
- https://developers.weixin.qq.com/miniprogram/dev/component/video.html

### cos-5　成立

**待核结论**：cos-js-sdk-v5（浏览器）支持分块上传、断点续传与并发分块，可用临时密钥（STS）授权；单文件最大 48.82TB

**依据**：JS SDK《上传对象》：高级接口“支持并发分块上传，支持断点续传，支持上传任务的取消，暂停和重新开始”；“uploadFile 实现高级上传，传入参数 SliceSize 可以控制文件大小超出一个数值（默认1MB）时自动使用分块上传…分块上传默认支持断点续传”。SDK 源码 cos-js-sdk-v5@1.10.1（npm latest，`npm view` 取得）：默认 `ChunkParallelLimit: 3`、`FileParallelLimit: 3`、`ChunkSize: 1MB`，并按文件大小自动放大分块（SIZE 档位最高 5GB，保证分块数不超上限）。快速入门：推荐“服务端使用固定密钥调用 STS 服务申请临时密钥…返回临时密钥到前端使用”，通过 getAuthorization 回调提供。COS《规格与限制》：API/SDK 上传“单个对象最大48.82TB (50,000GB)”，分块“1MB - 5GB”“分块数1 - 10000”，简单上传单对象最大 5GB。

**来源**：
- https://cloud.tencent.com/document/product/436/64960
- https://cloud.tencent.com/document/product/436/11459
- https://cloud.tencent.com/document/product/436/14518
- npm view cos-js-sdk-v5 dist-tags --json
- https://unpkg.com/cos-js-sdk-v5@1.10.1/src/advance.js
- https://unpkg.com/cos-js-sdk-v5@1.10.1/src/cos.js

### cos-6　部分成立

**待核结论**：腾讯云点播（VOD）的溯源水印/幽灵水印只支持 HLS 且对视频时长有下限（原结论：7 分钟以上才能做溯源检测）

**更正**：“仅支持 HLS、仅支持 7 分钟及以上视频做溯源检测、与版权水印互斥、仍在公测”只适用于 VOD 溯源水印。幽灵水印是播放器端按播放器签名显示的可见闪现水印，文档未规定 HLS 限制或时长下限，但需要使用云点播播放器（Web 端），不适用于小程序原生 video 直链播放。短剧单集 1–3 分钟不满足溯源检测时长这一结论仍成立。

**依据**：溯源水印部分成立，《溯源水印》(更新 2026-06-23) 原文：“溯源水印功能目前处于公测阶段，仅支持对时长7分钟及以上的视频进行溯源检测”“仅支持对 HLS 格式的视频添加水印”“版权水印和溯源水印不能同时添加，否则会提取失败”；且会生成 A、B 两路转码文件、收两次转码费。幽灵水印是另一项功能，《幽灵水印》(更新 2024-10-29)：水印文本写在播放器签名的 ghostWatermarkInfo 里，由云点播播放器在画面上短暂闪现，文档只写“推荐搭配 HLS 私有加密使用”，没有“仅支持 HLS”或时长下限的限制；版权保护综述写“Web 端携带了幽灵水印，移动端携带了浮动水印”，即它依赖点播播放器/播放器签名，小程序原生 video 直接播 URL 用不上。

**来源**：
- https://cloud.tencent.com/document/product/266/75789
- https://cloud.tencent.com/document/product/266/94228
- https://cloud.tencent.com/document/product/266/45552

### cos-7　部分成立

**待核结论**：数据万象视频转码 1080P（H.264）单价量级约 0.03–0.07 元/分钟；视频明水印可在转码模板中配置

**更正**：1080P H.264 普通转码 0.063 元/分钟（按输出时长）成立。明水印不是配置在转码模板里，而是另建水印模板（或直接传水印参数），在转码任务/工作流节点上通过 WatermarkTemplateId 或 Watermark 关联，每个任务最多 3 个；自适应码流工作流的 VideoStream 子流节点也支持 WatermarkTemplateId。

**依据**：价格成立：CI《媒体处理费用》(更新 2026-06-05) 普通音视频转码中国境内 H.264：标清 SD 0.016、高清 HD(1280x720) 0.0325、全高清 FHD 0.063 元/分钟，“根据输出视频时长及输出视频分辨率收费”（H.265 FHD 为 0.3112，极速高清 H.264 FHD 为 0.195，差距很大）。水印位置不准确：转码模板(Tag=Transcode)的创建模板文档中没有任何水印字段；水印是单独的“水印模板”或任务级参数，在提交转码任务时传 `Operation.WatermarkTemplateId`（“可以传多个水印模板 ID，最多传3个”）或 `Operation.Watermark`（“同创建水印模板接口中的 Request.Watermark，最多传3个”）；工作流的 Transcode / VideoStream 节点同样有 WatermarkTemplateId 字段。

**来源**：
- https://cloud.tencent.com/document/product/460/58120
- https://cloud.tencent.com/document/product/460/84790
- https://cloud.tencent.com/document/product/460/84733
- https://cloud.tencent.com/document/product/460/78927
- https://cloud.tencent.com/document/product/460/94314

### cos-8　部分成立

**待核结论**：COS 事件通知/数据万象任务回调可以回调到自有 HTTPS 接口（或经 SCF/消息队列），回调带任务 ID 与结果，可据此更新业务状态

**更正**：数据万象任务（转码、打包、审核等）可直接回调自有 URL（HTTP POST，XML 或 JSON）或投递到 TDMQ，回调体带 JobId、Code/State 与结果。COS 事件通知本身只能投递到同地域的云函数 SCF，要通知自有接口需由 SCF 转发；若要 COS 在上传完成时直接回调自有服务器，需申请白名单的“上传回调 Callback”功能。回调文档未提供验签机制，状态应以回查任务为准。

**依据**：数据万象部分成立：提交任务文档 `CallBackType`“任务回调类型，Url 或 TDMQ，默认 Url”，`CallBack`“任务回调地址”，`CallBackFormat` JSON/XML；回调信息文档：“在任务完成后，系统向该 URL 发送 HTTP POST 请求，请求体中包含通知内容”，示例体含 EventName=TaskFinish、JobsDetail.Code、JobId、Message、Input、Operation 等；队列级回调可选 URL 或 TDMQ-CMQ / TDMQ-CKAFKA。COS 事件通知部分不成立：《事件通知》(更新 2026-02-25) 原文“通知目标：仅支持通知发送至同地域的 SCF 函数”，不能直接打到自有 HTTPS 接口。另有一个独立功能“上传回调 Callback”(更新 2026-05-27)：PutObject/PostObject/CompleteMultipartUpload 携带 callback 参数后由 COS 向 callbackUrl 发 POST（支持 HTTP/HTTPS），但“本接口白名单开放，如需使用 Callback，请联系我们开通白名单”。所查回调文档中未见回调签名/验签机制的说明；限制页还写“异步任务记录保留一个月…建议配置回调获取任务结果”。

**来源**：
- https://cloud.tencent.com/document/product/460/84790
- https://cloud.tencent.com/document/product/460/84947
- https://cloud.tencent.com/document/product/460/46487
- https://cloud.tencent.com/document/product/436/35526
- https://cloud.tencent.com/document/product/436/106770
- https://cloud.tencent.com/document/product/460/36620

### cos-9　成立

**待核结论**：COS 标准存储约 0.1 元/GB/月量级，低频与归档存储单价更低但有最短存储期与取回费用；CDN 流量约 0.2 元/GB 量级

**依据**：COS《存储容量费用》(更新 2026-08-18)：“标准存储容量：0.118 元/GB/月”“北京低频存储刊例价是0.08元/GB/月”，并有不足最短期的“提前删除费用”算例；《计费示例》归档 0.03 元/GB/月。《计费概述》(更新 2026-07-30)：低频“存储时间不足30天，按30天计算”，归档“不足90天，按90天计算”，深度归档“不足180天，按180天计算”，且单文件不足 64KB 按 64KB 计。《数据取回费用》(更新 2026-08-18)：低频取回算例 0.02 元/GB；归档需先恢复（快速 1–5 分钟、标准 3–5 小时、批量 5–12 小时）。CDN《基础服务计费》(更新 2026-02-10) 中国大陆流量阶梯：0–2TB 0.21、2–10TB 0.20、10–50TB 0.18、50–100TB 0.15、≥100TB 0.11 元/GB。说明：COS 数字取自官方文档正文与算例，官网定价页 buy.cloud.tencent.com/price/cos 为前端渲染，未能直接取数。

**来源**：
- https://cloud.tencent.com/document/product/436/53482
- https://cloud.tencent.com/document/product/436/16871
- https://cloud.tencent.com/document/product/436/53862
- https://cloud.tencent.com/document/product/436/33417
- https://cloud.tencent.com/document/product/436/6241
- https://cloud.tencent.com/document/product/228/75562

### cos 组的额外发现

- 走 CDN 的真实流量成本不是 0.21 元/GB：COS 侧还要收“CDN 回源流量费用”0.15 元/GB（COS 计费示例，回源未命中缓存的部分），成片这类大文件、低复用内容缓存命中率低，合计接近 0.36 元/GB；不走 CDN 时 COS 外网下行在官方算例中为 0.5 元/GB（436/53863、436/53862 算例）。成本测算应按“CDN + 回源”两段计。来源：https://cloud.tencent.com/document/product/436/6241 、https://cloud.tencent.com/document/product/436/53863
- CDN TypeA 鉴权文档写明“不支持含 ？带参数的 URL 鉴权”，且“访问 URL 中不能包含中文”。若成片/样片走 CDN 鉴权 URL，就不能再附带 response-content-disposition 之类的查询参数来指定下载文件名，中文文件名需预先编码；需要在选鉴权模式（TypeA 与 TypeB/C/D 的路径式签名）时一并考虑。来源：https://cloud.tencent.com/document/product/228/41623
- 归档/深度归档对象不能直接读取，必须先恢复（归档：快速 1–5 分钟、标准 3–5 小时、批量 5–12 小时；深度归档 12–48 小时），且有 90/180 天最短计费期和提前删除费用、64KB 最小计费单元。若“成片到期转归档”，商家重新下载或“重新生成下载链接”时会遇到等待与取回费用，业务流程要有“恢复中”状态。来源：https://cloud.tencent.com/document/product/436/33417 、https://cloud.tencent.com/document/product/436/53482
- 数据万象自适应码流（多码率 HLS/DASH）官方只给出“通过工作流方式使用”，单桶工作流数量默认上限 10 个；子流由 VideoStream 节点各自引用转码模板，并可挂 WatermarkTemplateId（最多 3 个）。预告片方案 A 的实现形态应是“工作流 + 触发任务”，而不是单个转码任务。来源：https://cloud.tencent.com/document/product/460/58430 、https://cloud.tencent.com/document/product/460/78927 、https://cloud.tencent.com/document/product/460/36620
- 数据万象异步任务记录只保留一个月，超期无法查询（使用限制页原文），业务侧必须自行落库任务 ID、状态与结果，不能把云端任务记录当作长期凭据。来源：https://cloud.tencent.com/document/product/460/36620
- COS 提供白名单功能“上传回调 Callback”：PutObject / PostObject / CompleteMultipartUpload 带 callback 参数后，COS 在返回上传结果前先向自有服务器 callbackUrl 发 POST（最多 5 个 URL，支持 HTTP/HTTPS，可带自定义变量并可选回调身份验证）。这可作为参考工程“客户端调 confirm + 服务端 HEAD”之外的备选，但需工单开通，不宜作为默认依赖。来源：https://cloud.tencent.com/document/product/436/106770
- 临时密钥上限因接口而异：GetFederationToken 为主账号 7200 秒、子账号 129600 秒；AssumeRole 默认 7200 秒、最长 43200 秒（12 小时）。若后端以角色方式（AssumeRole）签发上传凭证，36 小时的说法不适用。来源：https://cloud.tencent.com/document/product/1312/48195 、https://cloud.tencent.com/document/product/1312/48197
- 用 AWS S3 SDK 访问 COS 的官方适配文档（更新 2025-08-12）在 Go SDK v2 示例中明确“需要禁止 x-amz-trailer 功能”（RequestChecksumCalculation = WhenRequired）；文档的 Node.js 示例仍停留在 AWS JS SDK 2.509.0（v2），没有覆盖 v3。参考工程用的是 AWS SDK v3 的 S3 兼容驱动，新版 v3 默认开启的请求校验和（trailer checksum）在 COS 上是否需要同样关闭，文档未写，需在升级 SDK 时实测。来源：https://cloud.tencent.com/document/product/436/37421
- VOD 幽灵水印与浮动水印依赖云点播播放器与播放器签名（文档：Web 端携带幽灵水印，移动端携带浮动水印）；若退到方案 C（VOD + 小程序原生 video 直接播 Key 防盗链 URL），这些播放器端水印都不可用，预告片/样片的水印只能靠转码时压制的明水印。来源：https://cloud.tencent.com/document/product/266/94228 、https://cloud.tencent.com/document/product/266/45552
- npm registry 当前版本：cos-js-sdk-v5 latest 1.10.1（beta 1.11.0-beta.2，registry 最后修改 2025-10-30）；cos-wx-sdk-v5 latest 1.8.0（beta 1.9.0-beta.1，最后修改 2025-06-18）。两者近一年无正式版发布，选型时可按“稳定但更新缓慢”看待。来源：npm view cos-js-sdk-v5 dist-tags --json；npm view cos-wx-sdk-v5 dist-tags --json

## 腾讯云数据库、Redis、短信、OCR、ASR

### inf-1　部分成立

**待核结论**：腾讯云数据库 PostgreSQL 支持 PG 17/18，默认一主一备高可用，支持按时间点恢复（PITR），备份保留天数可配（原结论 7–1830 天）

**更正**：四项字面上都成立，但 PITR 有两点出入需写进架构：(1) 恢复方式是“克隆出新实例”，之后要用 DTS 迁回或切换连接地址，新实例存储默认至少为压缩备份的 4 倍；(2) 可选时间点窗口官方文档自相矛盾（“日志备份保留时长内任意时间点” vs “最近 7 天”），把备份保留调到 30 天后能否做 30 天内任意时间点恢复未被文档明确保证，需在控制台实测确认。另外 PG 11/12 只有本地盘实例，云盘实例为 13–18。

**依据**：版本：产品概述写明提供 11–18；实例规格页（2026-09-11 更新）“双机高可用（一主一从）实例”本地盘支持 11–18、云盘支持 13–18；内核版本页（2026-09-28）最新为 v18.4_r1.12、v17.10_r1.21；公告 2140（2025-09-25/26）“全面支持 PG 18”。架构：产品特性页原文“默认为您提供一主一备架构的部署模式，默认启动同步复制”；主实例架构为“高可用版”，只读实例为“单节点只读”。保留天数：备份数据页（2026-06-12）原文“数据文件保留时间：支持设置保存7～1830天的备份数据”；增量备份为 WAL，“默认自动开启，不可关闭”。PITR：克隆实例页原文“支持通过克隆将实例恢复到日志备份保留时间内的任意时间点”，但同页操作步骤又写“按时间点恢复……可选择的时间范围为最近7天”，两处表述不一致；克隆是“创建一个新实例”，不是原地回滚。

**来源**：
- https://cloud.tencent.com/document/product/409/4989
- https://cloud.tencent.com/document/product/409/7562
- https://cloud.tencent.com/document/product/409/67017
- https://cloud.tencent.cn/announce/detail/2140
- https://cloud.tencent.cn/document/product/409/4991
- https://cloud.tencent.com/document/product/409/33945
- https://cloud.tencent.com/document/product/409/94889
- https://cloud.tencent.com/document/product/409/68277

### inf-2　部分成立

**待核结论**：腾讯云分布式缓存（Redis 版）标准架构自带 Proxy；BullMQ 依赖 Lua 脚本与阻塞命令（BZPOPMIN/BRPOPLPUSH 等）并要求 maxmemory-policy 为 noeviction——核对腾讯云 Redis 是否支持这些命令与配置，有无已知不兼容

**更正**：逐项核对结果：标准架构带 Proxy（成立）；BZPOPMIN、EVAL/EVALSHA/SCRIPT LOAD 在 Redis 5.0+ 标准架构均受支持（成立）；maxmemory-policy 默认就是 noeviction（无需改，且不要按腾讯云建议改成 allkeys-lru）。需要更正/补充：(1) BullMQ 最低 Redis 5.0、推荐 6.2，不是“要求 ≥6.2”；现行版本用 BZPOPMIN 而非 BRPOPLPUSH；(2) 端到端兼容性没有一手背书，仍需 PoC，重点看 Proxy 下阻塞连接数与断连重连；(3) 集群架构有明确不兼容风险：腾讯云要求“redis.call 中 Key 的位置必须来自 KEYS 数组，否则返回 ERR bad lua script for redis cluster…”，而 BullMQ 脚本在 Lua 内拼 key（addStandardJob-9.lua：jobIdKey = args[1] .. jobId），仅靠 hash tag 不够——早期只用标准架构（此条为两份一手资料的推断，未实测）；(4) 腾讯云命令使用准则明文写“禁止将 Redis 当作消息队列使用”“缓存实例仅作为缓存使用”，属厂商定位而非技术封禁，但出问题时不在其推荐用法内。

**依据**：腾讯云侧（一手）：产品概述（2026-08-06）标准架构“代理组件：内置 Proxy 组件，负责请求路由和负载均衡”，版本 Redis 4.0/5.0/6.2/7.0、Valkey 8.0/9.0。Sorted Sets 命令页：“zpopmax、zpopmin、bzpopmax、bzpopmin，仅 Redis 5.0、6.2、7.0 版本及 Valkey 8.0、9.0 版本支持”。Scripting 命令页：eval、evalsha、script load 等“标准架构与集群架构均支持”。Proxy 特性页（2026-07-20）：Lua/事务/INFO 转发主节点；“为避免超过连接数限制，您需要谨慎使用以下命令。阻塞类命令：BRPOP、BRPOPLPUSH、BLPOP、BZPOPMAX、BZPOPMIN…”（阻塞命令会在数据分片上建额外连接）。淘汰策略页：“默认策略为 noeviction”，可在实例参数中改。不支持的命令：CONFIG、HELLO（RESP3）等。BullMQ 侧（一手）：文档“configure the maxmemory-policy setting to noeviction. This is the only setting that guarantees the correct behavior”；源码 minimumVersion='5.0.0'、recommendedMinimumVersion='6.2.0'，阻塞等待用 bzpopmin（现行版本已不用 BRPOPLPUSH），通过 INFO 读取 maxmemory_policy；ioredis 的 keyPrefix 不兼容，须用 BullMQ 自己的 prefix。BullMQ 官方“兼容性/托管”章节只列了 Dragonfly、AWS MemoryDB、AWS ElastiCache，没有腾讯云；未查到任何一手来源声明 BullMQ 在腾讯云 Redis（Proxy 后）端到端可用或不可用。

**来源**：
- https://cloud.tencent.com/document/product/239/3205
- https://cloud.tencent.com/document/product/239/104577
- https://cloud.tencent.com/document/product/239/79850
- https://cloud.tencent.com/document/product/239/79854
- https://cloud.tencent.com/document/product/239/76287
- https://cloud.tencent.com/document/product/239/90960
- https://cloud.tencent.com/document/product/239/90961
- https://raw.githubusercontent.com/taskforcesh/bullmq/master/docs/gitbook/guide/going-to-production.md
- https://raw.githubusercontent.com/taskforcesh/bullmq/master/docs/gitbook/guide/connections.md
- https://raw.githubusercontent.com/taskforcesh/bullmq/master/src/classes/redis-connection.ts
- https://raw.githubusercontent.com/taskforcesh/bullmq/master/src/commands/addStandardJob-9.lua
- https://raw.githubusercontent.com/taskforcesh/bullmq/master/docs/gitbook/guide/redis-tm-compatibility/README.md

### inf-3　成立

**待核结论**：腾讯云短信自 2026-04-20 起签名类型只支持公司、机构、商标等，不再支持以小程序/APP 名称作签名；运营商实名报备通常需要 7–10 个工作日

**依据**：公告《【国内短信】关于腾讯云短信签名申请规则更新的公告》（2026-04-20）原文：“自即日起，短信签名仅支持申请公司类、政府/机关事业单位/其他机构、商标类签名。”FAQ：“不满足公告中要求的签名类型（如 APP、网站、小程序、公众号等）……不建议继续使用，即使部分不合规签名您可以请求成功，但会大概率被运营商拦截发送失败。”签名管理文档（2026-09-23 更新）原文：“状态为已生效签名在腾讯云平台已审核通过，但还需要到运营商实名报备。目前报备流程据观测一般需要 7-10 个工作日，运营商未对此时效做承诺，实际可能需要更长时间。”平台审核“预计2小时”。

**来源**：
- https://cloud.tencent.com/announce/detail/2256
- https://cloud.tencent.com/document/product/382/37794
- https://cloud.tencent.com/document/product/382/108275

### inf-4　成立

**待核结论**：腾讯云营业执照识别（BizLicenseOCR）后付费约 0.15 元/次，每月有 1000 次免费额度，可返回翻拍/复印件告警

**依据**：计费概述（2026-09-30 更新）后付费表：营业执照识别 0.15 元/次（月 0–1 万）、0.10（1–10 万）、0.06（10–100 万）。免费额度原文：“通用文字识别、卡证文字识别……等部分服务开通后即可享受1,000次/月的免费调用额度，以免费资源包的形式在每个月1号自动发放……仅在当月有效……属于同一个共享资源包的接口共同享受1,000次/月”。接口文档（2026-08-06 更新）：EnableCopyWarn“是否返回告警码，默认为false”；“Code 告警码列表和释义：-9102 黑白复印件告警 -9104 翻拍件告警”；默认限频 10 次/秒；图片 Base64 后 ≤7M。注意两点（不改变结论）：告警默认关闭，需显式传 EnableCopyWarn=true；后付费需在控制台手动开通，否则免费包耗尽后“服务将面临不可用风险”。

**来源**：
- https://cloud.tencent.com/document/product/866/17619
- https://cloud.tencent.com/document/product/866/36215

### inf-5　部分成立

**待核结论**：腾讯云语音识别“录音文件识别”约 1.75 元/小时量级，每月有 10 小时免费额度，支持通过 URL 提交音频并回调或轮询结果

**更正**：1.75 元/小时 + 每月 10 小时免费只适用于通用引擎（如 16k_zh）。原报告推荐的方言引擎 16k_zh_en_2.0 属“大模型2.0版”，后付费 0.8 元/小时、没有免费额度；若用 16k_zh_en（大模型1.0版）则是 2.40 元/小时、同样无免费额度。URL 提交、回调或轮询成立。成本应按 0.8 元/小时且不扣免费额度重算（100 小时/月约 80 元）；后付费默认关闭，需手动开启或买资源包，否则额度耗尽即停服。

**依据**：计费概述（2026-09-08 更新）后付费表：录音文件识别 0–12 万小时 1.75 元/小时（月结）；录音文件识别（大模型1.0版）2.40 元/小时；录音文件识别（大模型2.0版）0.8 元/小时（无阶梯）。产品计费框架表“免费额度”列：录音文件识别=有；录音文件识别（大模型2.0版）=无；录音文件识别（大模型1.0版）=无。免费额度表：录音文件识别“每月10小时”。说明原文：“大模型2.0版：指……引擎参数被标记为【大模型2.0】的引擎，产品将按大模型2.0版定价体系进行扣费”。接口文档（2026-09-09 更新）：“16k_zh_en_2.0：中英大模型引擎【大模型2.0版】……31种方言”；16k_zh_en、8k_zh_large 属【大模型1.0版】；16k_zh 等为通用引擎。SourceType 0=音频 URL（≤5 小时、≤1GB），1=post body（≤5MB）；CallbackUrl 可选，“如果用户使用轮询方式获取识别结果，则无需提交该参数”；默认限频 20 次/秒；“自2022年5月起，所有开通服务的新用户默认关闭后付费”。

**来源**：
- https://cloud.tencent.com/document/product/1093/35686
- https://cloud.tencent.com/document/product/1093/37823

### inf-6　部分成立

**待核结论**：腾讯云有“食品经营许可证”等行业证照的专用或通用结构化识别能力（核对产品名与价格）；阿里云有专用的食品经营许可证识别接口

**更正**：腾讯云没有“食品经营许可证”专用接口，只有通用路线：企业证照识别 EnterpriseLicenseOCR（约 0.15 元/次，固定字段，食品许可特有字段如经营项目、许可证编号是否返回未见文档保证）或文档抽取（多模态版）。产品名与接口名要对上：文档抽取（多模态版）的接口是 ExtractDocMulti，不是原报告写的 SmartStructuralOCR（后者是“智能结构化识别”）；多模态版价格 0.48 元/次（自适应首档）或 0.288 元/次（固定价格）。阿里云部分成立：RecognizeFoodManageLicense，0.0825 元/次（≤1 万次/月），每月 200 次免费。

**依据**：腾讯云 API 概览（2026-09-16 更新）没有食品经营许可证专用接口；相关的有：EnterpriseLicenseOCR“企业证照识别”（“支持智能化识别各类企业登记证书、许可证书、企业执照、三证合一类证书”，输出统一社会信用代码、公司名称、法定代表人、地址、有效期等固定字段，默认 5 次/秒）；ExtractDocMulti“文档抽取（多模态版）”（ItemNames 自定义字段，ConfigId=General，默认 5 次/秒）；ExtractDocBasic“文档抽取（基础版）”；SmartStructuralOCR“智能结构化识别”（独立的另一接口，官方实践文档 77836 的示例代码用的是它，该文档 2025-06-17 更新）。价格（计费概述 2026-09-30）：文档抽取（多模态版）短文本自适应 0.48/0.34/0.24 元/次、固定价格 0.288 元/次；文档抽取（基础版）0.40/0.28/0.20；企业证照识别与“通用证照识别”同组，0.15/0.10/0.06 元/次。阿里云按量付费页“企业资质识别”下列有“食品经营许可证识别”“食品生产许可证识别”，标准档 0.0825（≤1 万）/0.0495/0.0415/0.0248/0.009 元/次，免费 200 次/月；接口 RecognizeFoodManageLicense 文档返回 operatorName、creditCode、licenceNumber、validToDate 等字段。

**来源**：
- https://cloud.tencent.com/document/product/866/33515
- https://cloud.tencent.com/document/api/866/38849
- https://cloud.tencent.com/document/api/866/119451
- https://cloud.tencent.com/document/api/866/60877
- https://cloud.tencent.com/document/product/866/77836
- https://cloud.tencent.com/document/product/866/17619
- https://help.aliyun.com/zh/ocr/product-overview/pay-as-you-go
- https://help.aliyun.com/zh/ocr/developer-reference/api-ocr-api-2021-07-07-recognizefoodmanagelicense

### inf-7　成立

**待核结论**：国内 OpenAI 兼容端点（火山方舟豆包、阿里云百炼通义千问、DeepSeek 官方）目前都提供图片理解能力；DeepSeek 官方 API 是否支持图片输入需核对

**依据**：DeepSeek：价格页功能表“图像理解 | deepseek-flash 支持 | deepseek-v4-pro 不支持”；视觉指南原文“deepseek-flash 模型支持在文本之外输入图片……均使用标准的 OpenAI 兼容对话补全格式”，支持 JPEG/PNG/GIF/WebP，可用 base64 data URL、外部 URL、Files API file_id；单图 ≤32 MiB、请求体 ≤48 MiB；图片只能出现在 user 消息。火山方舟：《图片理解》文档（UpdatedTime 2026-09-22）“部分大模型具备图片视觉理解能力，支持本地文件和图片 URL 方式传入图片”，OpenAI SDK 示例 base_url='https://ark.cn-beijing.volces.com/api/v3'，Chat API（/chat/completions）与 Responses API 均支持，示例模型 doubao-seed-2-1-pro-260628，URL/Base64 单图 ≤10MB。阿里云百炼：视觉理解文档有“OpenAI兼容”示例，content 用 image_url，base_url 为 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1，示例模型 qwen3.8-max。使用时注意：三家都是“部分模型支持”，DeepSeek 仅 deepseek-flash 支持、deepseek-v4-pro 不支持；均不含视频输入的核对。

**来源**：
- https://api-docs.deepseek.com/zh-cn/quick_start/pricing
- https://api-docs.deepseek.com/zh-cn/guides/vision/
- https://www.volcengine.com/api/doc/getDocDetail?LibraryID=82379&DocumentID=1362931
- https://www.volcengine.com/docs/82379/1362931
- https://help.aliyun.com/zh/model-studio/vision

### inf-8　部分成立

**待核结论**：腾讯云轻量/云服务器（CVM）与云数据库在同地域内网互通，同地域访问 COS 走内网不计外网流量费

**更正**：要分两种主机：(1) CVM 与云数据库内网互通的条件是同账号、同地域且同一 VPC（不同 VPC 要对等连接/云联网），不是“同地域即通”；(2) 轻量应用服务器默认与云数据库、CVM 内网不通，必须把轻量所在 VPC 关联云联网（同地域 ≤5Gbps 免费，需在云联网控制台 7 天内同意申请，且要避免网段冲突）。COS 部分成立：同地域 CVM/轻量经 COS 默认桶域名访问自动走内网、流量免费，但请求次数仍计费；文档只对“默认域名/源站域名”作此保证，走自定义域名或 CDN 域名不在此列。

**依据**：轻量应用服务器《内网互联》（2026-02-12 更新）原文：“轻量应用服务器使用腾讯云自动分配的私有网络 VPC 进行网络隔离，默认情况下内网不与云服务器 CVM、云数据库等其他处于私有网络 VPC 中的腾讯云资源内网互通，需通过关联云联网实现。”“同地域下轻量应用服务器与对象存储 COS 默认内网互通，无需通过关联云联网实现。”“当前腾讯云云联网同地域 5Gbps 及以下带宽免费”。《地域与网络连通性》（2026-09-23）：轻量访问云数据库=“通过云联网实现内网连通”。PG《连接实例》（2026-09-17）内网连接条件：“CVM 和数据库为同一账号，且处于同一个 VPC 内（保障同一个地域），或同在基础网络内”，不同 VPC 需对等连接。COS：《流量费用》（2026-08-26）内网上/下行流量“免费”，“相同地域内，腾讯云产品之间会自动使用内网访问，不产生流量费用”；《地域和访问域名》：“在云服务器上，通过 COS 默认域名访问文件，若为同地域访问，可实现内网访问……不会产生流量费用，但仍然有请求次数的收费”；跨地域“暂不支持内网访问，默认将会解析到外网地址”。

**来源**：
- https://cloud.tencent.com/document/product/1207/56847
- https://cloud.tencent.com/document/product/1207/50103
- https://cloud.tencent.com/document/product/409/40429
- https://cloud.tencent.com/document/product/436/53863
- https://cloud.tencent.com/document/product/436/6224
- https://cloud.tencent.com/document/product/213/57441

### inf 组的额外发现

- BullMQ 已到 6.x：`npm view bullmq dist-tags` 返回 latest=6.3.11（2026-10-01 发布），6.0.0 发布于 2026-07-30；5.x 线仍在维护（release-v5.x=5.81.5，2026-09-10）。6.x 的 ioredis（>=5）、redis（>=5）、pg（>=8）都是可选 peerDependency，需自行安装。参考工程若锁在 5.x，升级 6.x 属大版本迁移（例如高层类不再暴露 client getter，改为 getBackend()）。
- BullMQ 6 自带 PostgreSQL 后端（createPostgresBackend，要求 PostgreSQL 13+，推荐 14+，依赖 pg 包，用 LISTEN/NOTIFY 唤醒 worker），官方原话：Redis 后端“remains the default and the most battle-tested option”。这给架构多了一个选项：队列直接落在托管 PG 上，不必为 BullMQ 单独购买/验证托管 Redis（Redis 只留给限流、会话、token 缓存）。成熟度需自行评估，文档列有 Feature parity and limitations 一节。来源：https://raw.githubusercontent.com/taskforcesh/bullmq/master/docs/gitbook/guide/postgresql.md
- 腾讯云 Redis 官方开发准则与 BullMQ 用法相悖：命令使用准则第九节“禁止将 Redis 当作消息队列使用……如有消息队列需求，建议使用专业的消息中间件，例如 CKafka 或 TDMQ”；缓存定位准则“缓存实例仅作为缓存使用……不能作为唯一的数据来源”，并建议建实例后立刻把淘汰策略从 noeviction 改成 allkeys-lru（BullMQ 恰恰要求保持 noeviction）。产品优势页只描述了“RDB 持久化”（按备份策略周期性快照），未查到可配置 AOF 的官方说明，而 BullMQ 生产指南建议开启 AOF。结论：托管 Redis 上的队列数据要按“可丢、可从 PG 重建”设计，且 BullMQ 用的实例不要与缓存共用（淘汰策略冲突）。
- 腾讯云 Redis 集群架构对 Lua 的硬限制（Key 必须来自 KEYS 数组、同一节点/Slot，EVAL 必须传 key）与 BullMQ 脚本在 Lua 内拼接 job key 的写法冲突，仅加 hash tag 前缀大概率不够；另外 CONFIG、HELLO（RESP3）在腾讯云 Redis 不支持，客户端不要启用 RESP3，也不要依赖 CONFIG GET/SET 做自检。以上为文档推断，未实测。
- 腾讯云 ASR 与 OCR 的后付费都是默认关闭：ASR“自2022年5月起，所有开通服务的新用户默认关闭后付费……预付费额度耗尽后会自动停服”；OCR“当您的免费资源包耗尽时，服务将面临不可用风险”。上线清单里要加“开通后付费或预购资源包 + 余量告警”，否则免费额度用完当月功能直接不可用。OCR 的 1000 次/月是同组接口共享的资源包，不是每个接口各 1000 次。
- 腾讯云录音文件识别三档定价与原报告口径不同：通用引擎 1.75 元/小时（有 10 小时/月免费）、大模型 1.0 版 2.40 元/小时（无免费）、大模型 2.0 版 0.8 元/小时（无免费，含 31 种方言的 16k_zh_en_2.0）。大模型 2.0 反而最便宜，与火山豆包录音文件识别的 0.8 元/小时持平，原报告“备选火山更便宜”的理由不再成立。
- 短信签名细则（同一公告）：公司简称“须连续包含在营业执照全称中，且须与其他企业无混淆、重名”；商标签名要求“已在国家知识产权局商标局中国商标网完成注册”，商标对应多家企业时运营商可能要求加企业信息。也就是说“狸有戏”只有在它是公司全称的连续子串或已注册商标时才能用作签名。另外签名报备通过后长期不发会被运营商失效（“闲置时限在7天-6个月不等，且失效前不会提前告知”），恢复要重新报备 7–10 个工作日——低频短信场景需要保活发送。
- 轻量应用服务器不能直接内网访问云数据库 PostgreSQL/Redis，必须关联云联网；若架构选“轻量 + 托管 PG/Redis”，要把云联网关联、网段规划写进部署步骤，或直接选 CVM 与数据库同 VPC。腾讯云 PG 外网地址仅部分地域的主实例支持，且官方提示有被入侵风险，不应作为跨云访问方案。
- 模型清单可能已过期：火山方舟《图片理解》文档（2026-09-22 更新）的示例模型已是 doubao-seed-2-1-pro-260628（Seed 2.1 代），原报告按 Seed 2.0 lite/mini 给的型号与价格需要重查；阿里云百炼 OpenAI 兼容地址在文档中已写成带 WorkspaceId 的 https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1，与旧的 dashscope.aliyuncs.com/compatible-mode/v1 不同，LlmProvider 的 base URL 配置要按新格式预留。DeepSeek 只有 deepseek-flash 能看图，且价格分高峰/低谷两档。
- 腾讯云 OCR 官方“企业资质证书识别实践”文档（77836）最近更新是 2025-06-17，示例仍用 SmartStructuralOCR；而 API 概览里已有 ExtractDocBasic / ExtractDocMulti / ExtractDocAgent 一组新接口，ExtractDocMulti 自 2026-07-20 起默认版本为“2.0”。选型时以 API 概览与计费概述为准，不要照抄实践文档的接口名。

## 后端与工具链版本

### ver-1　成立

**待核结论**：Node.js 24 于 2026-10-20 进入 Maintenance LTS；Node.js 26 于 2026-10-28 成为 Active LTS

**依据**：nodejs/Release schedule.json 原文：v24 {start:2025-05-06, lts:2025-10-28, maintenance:2026-10-20, end:2028-04-30, codename:Krypton}；v26 {start:2026-05-05, lts:2026-10-28, maintenance:2027-10-20, end:2029-04-30}。注意两者都是计划日期，今天（2026-10-02）尚未发生：nodejs.org/dist/index.json 显示当前 v24.21.0（2026-09-07，lts: Krypton，仍是 Active LTS），v26.10.0（2026-09-21，lts:false，仍是 Current）。另：v22 (Jod) 维护至 2027-04-30；v20 已于 2026-04-30 EOL。

**来源**：
- curl -s https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
- curl -s https://nodejs.org/dist/index.json

### ver-2　成立

**待核结论**：npm 上 typescript 的 latest 标签已是 7.x（Go 原生实现），而 openapi-typescript 最新稳定版的 peerDependencies 仍要求 typescript ^5.x，typescript-eslint 最新版的 peer 上限也低于 7

**依据**：npm 实测：typescript dist-tags.latest=7.0.2（发布于 2026-07-08），依赖为 @typescript/typescript-<平台> 原生二进制包，unpackedSize 2.5MB（6.0.3 为 24MB），exports 仅有 "."→./lib/version.cjs 与 ./unstable/*，不再有 lib/typescript.js 的旧编程 API。微软官方博客 "Announcing TypeScript 7.0"（2026-07-08）称其为 Go 原生移植。openapi-typescript@7.13.0（latest，2026-02-11 发布）peerDependencies: {typescript: "^5.x"}（连 TS 6 都不在范围内）。typescript-eslint@8.71.0（latest，2026-09-28）与 canary 8.71.1-alpha.5 的 peer 均为 typescript ">=4.8.4 <6.1.0"。JS 实现的最后一条线是 6.0.x（6.0.3）。参考工程锁定 typescript 5.9.3。

**来源**：
- npm view typescript dist-tags --json
- npm view typescript@7.0.2 exports dependencies --json
- npm view openapi-typescript@latest version peerDependencies --json
- npm view typescript-eslint@latest version peerDependencies --json
- npm view typescript-eslint@canary peerDependencies --json
- https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/

### ver-3　成立

**待核结论**：ESLint 9 已于 2026-08 停止维护，当前稳定线为 ESLint 10；eslint-plugin-react 最新版的 peer 尚不包含 ESLint 10

**依据**：eslint.org/version-support 原文："ESLint v9.x reached end-of-life on 2026-08-06 and is no longer maintained"；表格 v10.x=Current（首发 2026-02-06），v9.0.0-v9.39.5=EOL（最后发布 2026-07-10，EOL 2026-08-06）。npm：eslint latest=10.11.0（2026-09-18），maintenance 标签=9.39.5。eslint-plugin-react latest=7.37.5（发布于 2025-04-03，此后无新版），peer eslint: "^3 || ^4 || ^5 || ^6 || ^7 || ^8 || ^9.7"；GitHub master 的 package.json 同样没有 ^10，ESLint 10 兼容 PR #4022 仍为 open，issue #4018 报告在 ESLint 10 下 "contextOrFilename.getFilename is not a function" 运行时错误。对比：eslint-plugin-react-hooks@7.1.1 的 peer 已含 ^10.0.0；typescript-eslint@8.71.0 的 peer 含 ^10.0.0。

**来源**：
- https://eslint.org/version-support/
- npm view eslint dist-tags --json
- npm view eslint-plugin-react@latest version peerDependencies --json
- https://raw.githubusercontent.com/jsx-eslint/eslint-plugin-react/master/package.json
- https://github.com/jsx-eslint/eslint-plugin-react/pull/4022
- https://github.com/jsx-eslint/eslint-plugin-react/issues/4018

### ver-4　部分成立

**待核结论**：npm 上 prisma 与 @prisma/client 的 latest 标签指向 8.0.0 的 rc 版本，7.10.0 是最新的 7.x 稳定版

**更正**：只有 prisma（CLI）的 latest 指向 8.0.0-rc.19；@prisma/client 的 latest 仍是 7.10.0（稳定版），且 @prisma/client 没有 8.0.0 rc 版本（Prisma 8 不再使用 @prisma/client）。7.10.0 是最新的 7.x 稳定版这一点成立（prisma 的 prev 标签即 7.10.0）。

**依据**：npm 实测：prisma dist-tags: latest=8.0.0-rc.19（2026-09-29 发布），next=8.0.0-rc.10，prev=7.10.0（2026-08-25）。但 @prisma/client dist-tags: latest=7.10.0，prev=6.19.3，dev=8.1.0-dev.7；@prisma/client 根本没有任何 8.0.0-rc.* 版本（grep 计数为 0）。@prisma/adapter-pg latest 也是 7.10.0。prisma 的 7.x 稳定版列表末尾为 7.9.0、7.9.1、7.10.0，无更高 7.x，也无 8.x 正式版。Prisma 官方文档原文："Prisma ORM 8 is a release candidate, not yet a final release, and it is what `npm install prisma` gives you today"，且 v8 "there is no `@prisma/client` package"。

**来源**：
- npm view prisma dist-tags --json
- npm view @prisma/client dist-tags --json
- npm view @prisma/client versions --json
- npm view prisma time --json
- https://www.prisma.io/docs/orm
- curl -s https://registry.npmjs.org/prisma

### ver-5　成立

**待核结论**：Prisma 7 官方支持的 PostgreSQL 版本范围包含 17 与 18（核对官方 supported databases 表）

**依据**：Prisma 官方 v7 文档页（标题 "Databases supported by Prisma ORM (Prisma ORM v7)"）自托管数据库表原文列出：PostgreSQL 9.6、10、11、12、13、14、15、16、17、18。注意未带版本号的 /docs/orm/reference/supported-databases 现在已是 Prisma ORM 8 的页面，不再列具体版本，必须看 /docs/orm/v7/ 路径。

**来源**：
- https://www.prisma.io/docs/orm/v7/reference/supported-databases
- https://www.prisma.io/docs/orm/reference/supported-databases

### ver-6　成立

**待核结论**：PostgreSQL 当前最新稳定大版本是 18（最新小版本 18.6 左右），PostgreSQL 19 尚未 GA

**依据**：postgresql.org/support/versioning 表格：18 当前小版本 18.6（首发 2025-09-25，支持到 2030-11-14）；17→17.11；16→16.15；15→15.19；14→14.24（2026-11-12 终止支持）。表中无 19。页面顶部公告原文："September 24, 2026: PostgreSQL 19 Beta 4 Released!"，即 19 仍在 beta。

**来源**：
- https://www.postgresql.org/support/versioning/

### ver-7　成立

**待核结论**：BullMQ 最新稳定大版本为 6.x，6.0 移除了旧的 repeatable jobs API，定时任务须使用 Job Schedulers（upsertJobScheduler）

**依据**：npm：bullmq latest=6.3.11（2026-10-01），release-v5.x=5.81.5；6.0.0 发布于 2026-07-30。官方 changelog 6.0.0 BREAKING CHANGES 原文："Legacy repeatable jobs and their APIs are removed. This includes the repeat option on Queue#add and Queue#addBulk, the Repeat class, Queue#getRepeatableJobs(), Queue#removeRepeatable(), and Queue#removeRepeatableByKey(). Migrate recurring jobs to Job Schedulers." 官方 v5→v6 迁移指南给出替代 API：upsertJobScheduler / getJobSchedulers / removeJobScheduler，并说明 v6 遇到 v5 遗留的 repeatable 元数据会直接报错。

**来源**：
- npm view bullmq dist-tags --json
- https://raw.githubusercontent.com/taskforcesh/bullmq/master/docs/gitbook/changelog.md
- https://raw.githubusercontent.com/taskforcesh/bullmq/master/docs/gitbook/guide/migrations/migrate-from-v5-to-v6.md
- https://raw.githubusercontent.com/taskforcesh/bullmq/master/docs/gitbook/guide/jobs/repeatable.md

### ver-8　部分成立

**待核结论**：pnpm 当前最新稳定大版本（核对是 10 还是更高）；Vitest 最新稳定大版本为 4；tsup 已声明不再积极维护，官方推荐迁移到 tsdown

**更正**：pnpm 最新稳定大版本是 12（12.8.1），不是 10；10.x（10.34.6）与 11.x 仍有维护补丁。Vitest 最新稳定大版本是 5（5.0.3，2026-09-03 GA），不是 4；4.1.11 是上一条线。tsup 部分成立（但 npm 包未标 deprecated，仓库未归档；tsdown 仍为 0.x）。

**依据**：pnpm：dist-tags latest=12.8.1（2026-09-28），latest-11=11.28.2，latest-10=10.34.6；12.0.0 首发 2026-08-26，11.0.0 首发 2026-04-28；10.x 与 11.x 仍在同步发补丁。Vitest：dist-tags latest=5.0.3（2026-09-30），V4=4.1.11（2026-08-18）；5.0.0 于 2026-09-03 发布，GitHub release 非 prerelease，原文 "Vitest 5 is officially out!"；vitest@5.0.3 engines node "^22.12.0 || ^24.0.0 || >=26.0.0"，peer vite "^6.4.0 || ^7.0.0 || ^8.0.0"。tsup：latest=8.5.1（2025-11-12，此后无新版），README 首行原文 "This project is not actively maintained anymore. Please consider using tsdown instead"；tsdown latest=0.23.0（仍是 0.x）。

**来源**：
- npm view pnpm dist-tags --json
- npm view pnpm time --json
- npm view vitest dist-tags --json
- npm view vitest@latest engines peerDependencies --json
- https://github.com/vitest-dev/vitest/releases/tag/v5.0.0
- https://raw.githubusercontent.com/egoist/tsup/main/README.md
- npm view tsdown dist-tags --json

### ver-9　成立

**待核结论**：hono 最新稳定版为 4.x，@hono/zod-openapi 最新版与 zod 4 兼容；zod 最新稳定大版本为 4

**依据**：npm：hono latest=4.13.12（2026-09-30），无 5.x 标签；@hono/zod-openapi latest=1.6.3（2026-09-04），peerDependencies {zod: "^4.0.0", hono: ">=4.10.0"}，依赖 @asteasolutions/zod-to-openapi ^9.1.0 与 @hono/zod-validator ^0.9.1；zod latest=4.6.5（2026-09-13），4.0.0 首发 2025-07-09。注意 @hono/zod-openapi 1.x 的 peer 只接受 zod 4，不再接受 zod 3。

**来源**：
- npm view hono dist-tags --json
- npm view @hono/zod-openapi@latest version peerDependencies dependencies --json
- npm view zod dist-tags --json

### ver-10　部分成立

**待核结论**：Redis 8 的开源许可（AGPLv3 等）与 Valkey 8/9 的现状：BullMQ 官方是否声明支持 Valkey

**更正**：Redis 8 许可为三选一（RSALv2 / SSPLv1 / AGPLv3），成立。BullMQ 没有在官方文档的兼容性章节中正式声明支持 Valkey 服务端（正式列出的只有 Dragonfly）；实际状态是：CI 对 Valkey 8 跑测试、内置 Valkey Glide 客户端适配器、维护者在 Discussion 中口头确认兼容。Valkey 9 没有官方测试或声明，应视为未验证。

**依据**：Redis：redis/redis LICENSE.txt 原文 "Starting with Redis 8, Redis Open Source is moving to a tri-licensing model ... (a) RSALv2; or (b) SSPLv1; or (c) AGPLv3"；官方博客（2025-05-01）确认自 Redis 8 起增加 AGPLv3 选项。当前 Redis 最新为 8.10.2（2026-09-17），并行维护 8.2/8.4/8.6/8.8。Valkey：BSD 3-Clause；稳定线 8.0.11、8.1.10、9.0.6、9.1.2（均 2026-08-31/09-01 发布），9.2.0-rc1 为预发布。BullMQ：官方文档 "Redis Compatibility" 页原文 "BullMQ is full Redis compliant with version 6.2.0 or newer ... we present the vendors that officially support BullMQ and that we regularly test"，该章节下只有 Dragonfly 一页，没有 Valkey 页；README 与 connections 文档只提到 Valkey Glide 客户端适配器 createValkeyGlideClient。但 CI（.github/workflows/test.yml）有 node-valkey 任务，镜像 valkey/valkey:8-alpine3.20（只测 Valkey 8，不测 9），另有 valkey-glide-test.yml。维护者在 Discussion #2642 的非正式表态：manast（2024-07-11）"if Valkey is 100% compatible with Redis then it will work with BullMQ"；roggervalf（2024-12-13）"Valkey is compatible with bullmq as all our tests are passing"。CI 中 Redis 只测 7-alpine 与 6-alpine，未见 Redis 8 矩阵。

**来源**：
- https://raw.githubusercontent.com/redis/redis/unstable/LICENSE.txt
- https://redis.io/blog/agplv3/
- https://api.github.com/repos/redis/redis/releases
- https://api.github.com/repos/valkey-io/valkey/releases
- https://raw.githubusercontent.com/taskforcesh/bullmq/master/docs/gitbook/guide/redis-tm-compatibility/README.md
- https://raw.githubusercontent.com/taskforcesh/bullmq/master/.github/workflows/test.yml
- https://raw.githubusercontent.com/taskforcesh/bullmq/master/docs/gitbook/guide/connections.md
- https://github.com/taskforcesh/bullmq/discussions/2642

### ver 组的额外发现

- Prisma 8 是换架构而非普通大版本：prisma@8.0.0-rc.19 的仓库变为 prisma/prisma-cli，描述为 "one binary for the ORM, Composer, and the Prisma Developer Platform"，engines node >=22.18.0；官方文档称 v8 没有 @prisma/client，代码改为从 src/prisma/db.ts 导入 db。由于 prisma 的 latest 已指向 rc，不带版本号执行 `pnpm add prisma` 会装到 8.0.0-rc，而 @prisma/client 与 @prisma/adapter-pg 的 latest 仍是 7.10.0，两者会错配。新项目若用 Prisma 7 必须精确锁定 prisma / @prisma/client / @prisma/adapter-pg 均为 7.10.0（参考工程即如此）。
- TypeScript 7.0.2 不再提供旧的 JS 编程 API（exports 只有 version.cjs 与 ./unstable/*），所以 typescript-eslint、openapi-typescript、tsup 的 dts 生成等依赖 TS API 的工具在 TS 7 下不只是 peer 警告，而是无法工作。可选组合：TS 5.9.3（openapi-typescript ^5.x 与 typescript-eslint 都满足，参考工程用此版本）或 TS 6.0.3（typescript-eslint <6.1.0 满足，但超出 openapi-typescript 的 ^5.x）。不带版本号安装 typescript 会拿到 7.0.2，必须锁版本。二手来源称编程 API 计划在 TS 7.1 提供，未经一手核实。
- 参考工程 timavia-liyo-project/package.json 使用 eslint 9.39.5，该线已于 2026-08-06 EOL。升到 ESLint 10 的阻塞点是 eslint-plugin-react 7.37.5（peer 最高 ^9.7，且有 ESLint 10 下 getFilename 运行时报错的 issue #4018，修复 PR #4022 未合并，npm 上自 2025-04 起无新版）。eslint-plugin-react-hooks 7.1.1 与 typescript-eslint 8.71.0 均已支持 ESLint 10。
- BullMQ 6 的其他破坏性变更对架构有影响：ioredis 不再是直接依赖而是可选 peer（ioredis >=5.0.0，须显式安装；ioredis latest 已是 6.0.0，参考工程用 6.0.0）；Queue#client、Worker#blockingClient 等 Redis 内部句柄被移除，改为 getBackend()；paused 状态从 JobType 移除；debounce 选项移除改用 deduplication；Job#discard() 移除；Worker#resume() 变为异步。6.0 还引入可插拔后端，官方自带 PostgreSQL 后端 createPostgresBackend（CI 只测 postgres 16），理论上可以不部署 Redis，但这是 2026-07-30 才发布的新能力，成熟度未核实。
- Vitest 5（latest 5.0.3）要求 Node ^22.12 || ^24 || >=26 与 vite ^6.4 || ^7 || ^8；参考工程用 vitest 4.1.11（V4 标签，最后发布 2026-08-18）。参考工程的 apps/mobile（Taro 4.2.1）锁 vite ^4.5.0，若根目录升 Vitest 5 需注意与该 vite 版本隔离。
- pnpm 12 首发于 2026-08-26，仅一个多月；12.0.0 的 Major Changes 包括：pnpm-workspace.yaml 中出现未识别设置时，在项目锁定了 pnpm 版本的情况下会以 ERR_PNPM_UNRECOGNIZED_WORKSPACE_SETTINGS 失败。参考工程锁定 pnpm@10.30.0，10.x 仍在发补丁（10.34.6，2026-09-28）。pnpm 11.28.2 的 engines 为 node >=22.13。
- Node 发布节奏已变：schedule.json 中 v27 出现 alpha 字段（alpha: 2026-10-28，start: 2027-04-22，end: 2030-04-30），不再有 2026-10 的奇数版 Current 首发。参考工程 engines 为 node ">=24.0.0 <25"；Node 24 在 2026-10-20 后进入 Maintenance（支持到 2028-04-30），Node 26 的 LTS 到 2029-04-30。Prisma 7.10.0 engines 为 "^20.19 || ^22.12 || >=24.0"，bullmq 6 为 >=14.17.0，二者对 Node 24/26 均不构成限制。
- BullMQ 官方 CI 的 Redis 矩阵只有 7-alpine 与 6-alpine，未见 Redis 8；Valkey 只测 8，不测 9。官方 AWS ElastiCache 指引要求用标准节点（非 serverless）并设 maxmemory-policy=noeviction。选用国内云厂商的 Redis 兼容服务时，兼容性需自行验证，BullMQ 官方无相关声明（本次未查国内云厂商文档）。
- PostgreSQL 14 将于 2026-11-12 终止支持；PostgreSQL 19 截至 2026-09-24 仍是 Beta 4，GA 时间未在官网公布。Prisma 7 支持表目前最高列到 18，选 18.x 或 17.x 都在官方支持范围内。

## 前端技术栈版本

### fe-1　成立

**待核结论**：@tarojs/taro 最新稳定版为 4.3.x（4.3.0 发布于 2026-09 下旬），其 React 相关 peerDependencies 仍为 react ^18，不支持 React 19

**依据**：npm 实测：@tarojs/taro dist-tags.latest = 4.3.0，发布时间 2026-09-29T08:08:31Z（alpha 标签已到 4.3.1-alpha.0，2026-09-30）。GitHub release v4.3.0 同日发布、非 prerelease。React peer 的精确位置：@tarojs/react@4.3.0 peerDependencies = {react: ^18}，且 dependencies.react-reconciler 固定为 0.29.0（React 18 线）；@tarojs/plugin-framework-react@4.3.0 peer react ^18（optional）；@tarojs/taro 自身只声明 @types/react ^18（optional），没有直接的 react peer。4.3.1-alpha.0 的 peer 同样是 react ^18。官方仓库 issue #16996「支持 react 19」自 2024-12-06 开启至今仍 open，最近评论（2026-07-18）仍在追问；官方默认模板 package.json.tmpl 写的是 react/react-dom ^18.0.0。issue #19468 宣称的「已支持 React 19 / Vite 8」是第三方项目 sep2/vite-plugin-taro（作者 author_association=NONE），不是 Taro 官方能力。

**来源**：
- npm view @tarojs/taro dist-tags --json
- npm view @tarojs/taro time --json
- npm view @tarojs/react@4.3.0 peerDependencies dependencies.react-reconciler --json
- npm view @tarojs/plugin-framework-react@4.3.0 peerDependencies --json
- https://github.com/NervJS/taro/issues/16996
- https://github.com/NervJS/taro/issues/19468
- https://github.com/NervJS/taro/releases/tag/v4.3.0
- https://raw.githubusercontent.com/NervJS/taro/main/packages/taro-cli/templates/default/package.json.tmpl

### fe-2　部分成立

**待核结论**：@nutui/nutui-react-taro 的 latest 标签指向带 -cpp 后缀的变体版本，普通稳定线最新为 3.0.20 左右；其 peer 为 react ^18

**更正**：前两点成立（latest → 3.0.23-cpp；普通稳定线最新 3.0.20）。peer 的准确写法是 react "^16.8.0 || ^17.0.0 || ^18.0.0"，而非 "^18"；「不含 React 19」这一结论不受影响。安装时必须显式写版本（如 @nutui/nutui-react-taro@3.0.20），裸 npm i 会装到鸿蒙 C++ 变体 3.0.23-cpp。

**依据**：npm 实测 dist-tags：latest = 3.0.23-cpp（2026-09-03 发布），beta = 4.0.0-beta.7（2026-08-31），latest-2 = 2.7.14，cpp3.0.18 = 3.0.18-cpp。不带后缀的 3.x 稳定版最高为 3.0.20（2026-05-20 发布），之后只有 3.0.21-cpp / 3.0.22-cpp / 3.0.23-cpp 与 3.1.0-beta.x、4.0.0-beta.x。peerDependencies（3.0.20、3.0.23-cpp、4.0.0-beta.7、2.7.14 全部一致）= {react: "^16.8.0 || ^17.0.0 || ^18.0.0"}，不是单纯的 ^18。-cpp 版依赖 @nutui/icons-react-taro 固定为 3.0.2-cpp.3.beta.9（一个 beta 依赖）；仓库 README 把 cpp 对应到「harmony cpp」（pnpm dev:jdtaro:jdharmonycpp），仓库默认分支已是 feat_v4.x。

**来源**：
- npm view @nutui/nutui-react-taro dist-tags --json
- npm view @nutui/nutui-react-taro time --json
- npm view @nutui/nutui-react-taro@3.0.20 peerDependencies --json
- npm view @nutui/nutui-react-taro@3.0.23-cpp peerDependencies dependencies --json
- https://raw.githubusercontent.com/jdf2e/nutui-react/HEAD/README.md
- https://api.github.com/repos/jdf2e/nutui-react

### fe-3　成立

**待核结论**：antd 最新稳定大版本为 6.x（核对最新小版本）；antd 5 已进入或即将结束维护期

**依据**：npm 实测：antd latest = 6.6.5（2026-09-20 发布）；6.0.0 发布于 2025-11-21T16:34Z；peer react/react-dom >=18.0.0。v5 线：latest-5 = 5.29.3，发布于 2025-12-18，此后 9 个多月无 v5 新版本。官方 v6 发布公告（issue #55804）原文：v5 主分支切到 v5.x-stable 并进入「1-year maintenance period」，未给出具体截止日；按 6.0.0 发布日推算约在 2026-11 下旬到期，即距今（2026-10-02）约 7 周。

**来源**：
- npm view antd dist-tags --json
- npm view antd time --json
- npm view antd@6.6.5 peerDependencies --json
- https://github.com/ant-design/ant-design/issues/55804

### fe-4　成立

**待核结论**：@ant-design/pro-components 的稳定版（2.8.x）只声明支持 antd 4/5；支持 antd 6 的 3.x 仍是预发布（beta/rc）

**依据**：npm 实测：latest = 2.8.10（2025-07-17 发布，此后 2.x 无新版，已 14 个多月），peerDependencies = {antd: "^4.24.15 || ^5.11.2", react: ">=17.0.0", react-dom: ">=17.0.0"}。3.x 全部是 semver 预发布号：3.0.0-beta.1~3、3.0.1-0 … 3.1.15-3，没有任何不带后缀的 3.x 正式版；dist-tag beta = 3.1.15-3（2026-09-29 发布），其 peer = {antd: "^6.0.0", react: ">=18.0.0"}。仓库 master 的 package.json 版本即 3.1.15-3，仓库 2026-10-02 仍有提交。

**来源**：
- npm view @ant-design/pro-components dist-tags --json
- npm view @ant-design/pro-components@2.8.10 peerDependencies --json
- npm view @ant-design/pro-components@beta version peerDependencies --json
- npm view @ant-design/pro-components time --json
- https://raw.githubusercontent.com/ant-design/pro-components/master/package.json

### fe-5　成立

**待核结论**：@refinedev/antd 最新版仍锁定 antd 5，不支持 antd 6

**依据**：npm 实测：@refinedev/antd latest = 6.0.3（2025-10-23 发布，此后近一年无新版）；peerDependencies.antd = "^5.23.0"，dependencies 里也直接依赖 antd ^5.23.0、@ant-design/icons ^5.5.1、@ant-design/pro-layout ^7.21.1；react peer 为 ^18 || ^19。官方仓库 issue #7140「[FEAT] Support Ant Design v6」自 2025-12-02 开启至今仍 open，被 stale bot 两次标记（2026-05-14、2026-09-05），2026-07-07 有用户追问 antd 是否会被移出支持列表，未见维护者答复。

**来源**：
- npm view @refinedev/antd dist-tags --json
- npm view @refinedev/antd@6.0.3 peerDependencies dependencies --json
- npm view @refinedev/antd time --json
- https://github.com/refinedev/refine/issues/7140

### fe-6　成立

**待核结论**：vite 最新稳定大版本（核对是 7 还是 8）；@vitejs/plugin-react 对应版本

**依据**：核对结果：是 8。npm 实测 vite latest = 8.3.2（2026-10-01 发布）；8.0.0 发布于 2026-03-12；previous 标签 = 7.3.6（2026-06-25）。vite@8.3.2 engines.node = "^20.19.0 || >=22.12.0"，dependencies 含 rolldown ~1.2.11（打包器已换为 Rolldown）。@vitejs/plugin-react latest = 6.1.1（2026-08-28 发布），peer vite = "^8.0.0"（只支持 Vite 8）；5.x 最后一版 5.2.0 的 peer 为 vite ^4.2.0 || ^5 || ^6 || ^7 || ^8。@vitejs/plugin-react-swc latest = 4.3.3，peer vite ^4 || ^5 || ^6 || ^7 || ^8。

**来源**：
- npm view vite dist-tags --json
- npm view vite time --json
- npm view vite@8.3.2 engines dependencies --json
- npm view @vitejs/plugin-react dist-tags --json
- npm view @vitejs/plugin-react@6.1.1 peerDependencies engines --json
- npm view @vitejs/plugin-react-swc@4.3.3 peerDependencies --json

### fe-7　成立

**待核结论**：React 最新稳定版为 19.x；react-router 最新稳定大版本（核对 7 还是 8）；@tanstack/react-router 与 @tanstack/react-query 最新稳定大版本

**依据**：npm 实测：react / react-dom latest = 19.3.0（2026-09-09 发布；19.2.8、19.1.9、19.0.8 为 2026-07-21 的补丁）。react-router latest = 8.4.0（2026-09-15），8.0.0 发布于 2026-06-17，version-7 标签 = 7.18.4；react-router@8.4.0 peer react/react-dom ">=19.2.7"，engines.node ">=22.22.0"。官方 CHANGELOG v8.0.0 原文：最低 Node 22.22.0+、React 19.2.7+、Vite 7+，ESM-only，并「dropped react-router-dom」——npm 上 react-router-dom 没有任何 8.x 版本，latest 停在 7.18.4。@tanstack/react-router latest = 1.170.41（2026-09-30），无 2.x；@tanstack/react-query latest = 5.104.0（2026-09-26），无 6.x，peer react ^18 || ^19。

**来源**：
- npm view react dist-tags --json
- npm view react time --json
- npm view react-router dist-tags --json
- npm view react-router@8.4.0 peerDependencies engines --json
- npm view react-router-dom dist-tags --json
- https://github.com/remix-run/react-router/blob/main/CHANGELOG.md#v800
- npm view @tanstack/react-router dist-tags --json
- npm view @tanstack/react-query dist-tags --json

### fe-8　成立

**待核结论**：echarts 最新稳定大版本为 6.x；echarts-for-react 或官方 React 封装的现状

**依据**：npm 实测：echarts latest = 6.1.0（2026-05-19 发布，发布者 100pah，与 GitHub release 6.1.0 时间吻合，无 deprecated 标记）；6.0.0 发布于 2025-07-30。echarts-for-react：latest 标签 = 3.0.6（2026-01-21）；registry 中还有一个 3.0.7（2026-05-19T01:47Z），已被标记 deprecated，原文：「Use 3.0.6 instead of 3.0.7, reason: antv-block list, redirect to last clean version before 2026-05-19」。GitHub Advisory GHSA-2w6w-qxwv-qv2q「Malware in echarts-for-react」（critical，2026-05-19）确认该包因维护者账号（atool）被盗发布过恶意版本。echarts-for-react 3.0.6 的 peer：echarts ^3 || ^4 || ^5 || ^6，react ^15 || >=16。官方 React 封装：ECharts 官网扩展页只把 echarts-for-react（维护者 hustcc 个人）等列为社区扩展，没有任何由 Apache ECharts 团队维护的官方 React 封装。

**来源**：
- npm view echarts dist-tags --json
- npm view echarts time --json
- npm view echarts-for-react dist-tags --json
- npm view echarts-for-react@3.0.7 deprecated
- https://github.com/advisories/GHSA-2w6w-qxwv-qv2q
- https://echarts.apache.org/en/download-extension.html
- https://api.github.com/repos/apache/echarts/releases

### fe-9　成立

**待核结论**：npm 上 xlsx（SheetJS）停在 0.18.5 且有已知 CVE，修复版只在 cdn.sheetjs.com 分发；exceljs 自 4.4.0（2023-10）后未再发版

**依据**：xlsx：npm dist-tags 只有 latest = 0.18.5，发布于 2022-03-24。GitHub Advisory API 对 xlsx@0.18.5 返回两条 high：CVE-2023-30533（原型污染，影响 < 0.19.3）与 CVE-2024-22363（ReDoS，影响 < 0.20.2），两条的 npm first_patched_version 均为 None（即 npm 上无修复版）。SheetJS 官方文档原文：npm registry 上的 xlsx「is out of date. The latest version on that registry is 0.18.5」，SheetJS CDN「is the authoritative source」，当前版本 0.20.3，安装方式为 npm i --save https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz（实测该 URL 返回 HTTP 200）。exceljs：latest = 4.4.0，发布于 2023-10-19；此后唯一的发布是预发布 4.4.1-prerelease.0（2024-12-20，prerelease 标签），没有新的正式版；GitHub Advisory 对 exceljs@4.4.0 本体无记录。

**来源**：
- npm view xlsx dist-tags --json
- npm view xlsx time --json
- https://api.github.com/advisories?ecosystem=npm&affects=xlsx@0.18.5
- https://docs.sheetjs.com/docs/getting-started/installation/nodejs
- https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
- npm view exceljs dist-tags --json
- npm view exceljs time --json
- https://api.github.com/advisories?ecosystem=npm&affects=exceljs@4.4.0

### fe-10　成立

**待核结论**：openapi-fetch 与 openapi-typescript 最新稳定版本及其配套关系；zustand 最新稳定大版本为 5

**依据**：npm 实测：openapi-fetch latest = 0.17.0，openapi-typescript latest = 7.13.0，两者都发布于 2026-02-11T16:02Z（同一 monorepo 同批发布），此后约 8 个月无新版。配套关系：openapi-fetch@0.17.0 唯一依赖是 openapi-typescript-helpers ^0.1.0（同日发布），对 openapi-typescript 没有 peer 约束；官方文档的安装方式是 npm i openapi-fetch 加 npm i -D openapi-typescript typescript，未声明两者的版本对应表，文档只覆盖 7.x，无 v8。openapi-react-query latest = 0.5.4，peer openapi-fetch ^0.17.0、@tanstack/react-query ^5.80.0。需要注意：openapi-typescript@7.13.0 的 peerDependencies 是 typescript "^5.x"（非 optional），而 typescript 的 npm latest 已是 7.0.2（2026-07-08；6.0.3 发布于 2026-04-16）。zustand latest = 5.0.15（2026-08-13），5.0.0 发布于 2024-10-14，peer react >=18.0.0。

**来源**：
- npm view openapi-fetch dist-tags --json
- npm view openapi-fetch@latest dependencies peerDependencies --json
- npm view openapi-typescript dist-tags --json
- npm view openapi-typescript@latest peerDependencies peerDependenciesMeta --json
- npm view openapi-react-query dist-tags peerDependencies --json
- npm view typescript dist-tags --json
- https://openapi-ts.dev/openapi-fetch/
- npm view zustand dist-tags --json
- npm view zustand@latest peerDependencies --json

### fe 组的额外发现

- 【供应链安全，重大】2026-05-19 发生 Mini Shai-Hulud 供应链攻击：npm 维护者账号 atool 被盗，echarts-for-react 被发布恶意版本（registry 上的 3.0.7 已 deprecated，GitHub Advisory GHSA-2w6w-qxwv-qv2q 定级 critical 并要求视整机为已失陷、轮换所有密钥），多家安全厂商报告同批波及大量 @antv 包。本项目含支付密钥，建议：所有依赖精确锁版本并提交 lockfile、CI 用 npm ci / pnpm --frozen-lockfile、关闭 install 脚本、设置最小发布时长（如 pnpm minimumReleaseAge）；echarts-for-react 固定 3.0.6。厂商博客（StepSecurity、Aikido、Chainguard 等）仅作线索，一手依据是 npm deprecated 信息与 GitHub Advisory。
- 【小程序端与后台必须是两套 React 大版本】Taro 4.3.0 官方只支持 React 18（@tarojs/react peer react ^18，react-reconciler 0.29.0），而后台侧若选 react-router 8 则强制 React >=19.2.7。monorepo 里两端要各自独立安装 react，跨端共享的代码（类型、请求层、工具函数）不能依赖 React 19 专有 API，也要避免 React 被 hoist 成单一版本。
- 【Taro 的构建链被锁在旧版本】@tarojs/vite-runner@4.3.0 peer vite ^4；@tarojs/plugin-framework-react@4.3.0 peer vite ^4、@vitejs/plugin-react ^4；@tarojs/webpack5-runner@4.3.0 peer webpack 精确为 5.91.0；官方模板 TypeScript 为 ^5.4.5。后台可用 Vite 8，但小程序端无法与后台共用同一份 Vite / plugin-react 版本，构建配置需分开。
- 【react-router 8 的硬性门槛】官方 CHANGELOG：v8 要求 Node >=22.22.0、React >=19.2.7、Vite 7+，ESM-only，并移除了 react-router-dom 包（npm 上 react-router-dom 没有 8.x，latest 停在 7.18.4）。选 v8 时只能 import 自 react-router 与 react-router/dom；CI 和部署镜像的 Node 版本需 >=22.22。若想保留 React 18 兼容，只能用 react-router 7.18.x（peer react >=18，Node >=20）。
- 【TypeScript 已到 7.0.2，与部分工具 peer 冲突】typescript 的 npm latest = 7.0.2（2026-07-08），6.0.3 为 2026-04-16。openapi-typescript@7.13.0 的 peer 是 typescript ^5.x（必需），Taro 模板也写 ^5.4.5。裸装 typescript 会拿到 7.x 并触发 peer 冲突；建议全仓显式固定 typescript 5.9.x，升级前单独验证。
- 【后台 UI 选型的现实约束】antd 6 的生态配套都未就绪：@ant-design/pro-components 稳定版 2.8.10 只支持 antd 4/5 且自 2025-07-17 起无新版，支持 antd 6 的 3.x 只有预发布（3.1.15-3）；@refinedev/antd 6.0.3 锁 antd ^5.23.0 且自 2025-10-23 起无新版，antd 6 支持 issue #7140 开了 10 个月无维护者答复。而 antd 5 的 1 年维护期按 v6 发布日推算约在 2026-11 下旬结束，v5 最后一版 5.29.3 发于 2025-12-18。即：选 antd 5 + ProComponents 2.8 / Refine 是稳定但即将停止维护的组合；选 antd 6 则要么不用 ProComponents / Refine，要么接受预发布版本。
- 【NutUI 安装陷阱】@nutui/nutui-react-taro 的 latest 标签指向鸿蒙 C++ 变体 3.0.23-cpp，其依赖的图标包固定为 beta 版（@nutui/icons-react-taro 3.0.2-cpp.3.beta.9）。微信小程序项目必须显式固定 3.0.20；仓库默认分支已切到 feat_v4.x，4.0.0-beta.7 在推进中，3.x 普通线自 2026-05-20 后未再发版，后续可能面临 3→4 迁移。
- 【Vite 8 的运行环境要求】vite@8.3.2 要求 Node ^20.19.0 || >=22.12.0，底层打包器已换成 Rolldown（dependencies: rolldown ~1.2.11）；@vitejs/plugin-react 6.x 只支持 Vite 8。依赖 Rollup 专有插件钩子的旧插件需单独验证兼容性。
- 【Excel 导出库两难】xlsx 的 npm 版 0.18.5 有两个 high 级 CVE 且 npm 上无修复版，修复版 0.20.3 只能用 tarball URL 从 cdn.sheetjs.com 安装（不走 npm registry，镜像源、内网代理与依赖审计工具都需特殊处理）；exceljs 正式版停在 2023-10 的 4.4.0。若后台只需导出，可考虑由后端生成文件，前端不引入这两个库。

## 电子签、发票与监控

### misc-1　成立

**待核结论**：按《电子签名法》，仅在 PDF 上叠加印章图片不构成“可靠的电子签名”；可靠电子签名通常需要经 CA 数字证书签署（电子签平台提供）

**依据**：(1)《电子签名法》（2019 修正，工信部官网文本）第十三条：可靠电子签名须同时满足四项条件——制作数据属签名人专有、签署时仅由签名人控制、签署后对电子签名的任何改动能够被发现、对数据电文内容和形式的任何改动能够被发现；第十四条：可靠的电子签名与手写签名或者盖章具有同等的法律效力；第十六条：电子签名需要第三方认证的，由依法设立的电子认证服务提供者提供认证服务。单纯贴图没有签名制作数据，也无法发现改动，不满足第十三条。(2) 国办发〔2025〕33号《电子印章管理办法》（2025-09-27 成文，2025-10-09 发布，印发之日起施行）第二条：电子印章是“基于密码技术和相关数字技术表征印章的特定格式数据，用于实现电子文件的可靠电子签名”，包含印章图像数据、电子签名认证证书及其关联的签名制作数据；证书须由依法设立的电子认证服务机构签发。注意三点限定：a) 法条没有“印章图片不构成可靠电子签名”的明文，这是由四要件推出的结论；b) 第十三条末款“当事人也可以选择使用符合其约定的可靠条件的电子签名”，CA 证书不是法律上唯一途径；c) 第三条：约定使用电子签名、数据电文的文书，不得仅因其采用电子形式而否定其法律效力，所以“不可靠”不等于“无效”，只是不能直接等同于盖章。

**来源**：
- https://www.miit.gov.cn/jgsj/zfs/fl/art/2022/art_e3f623f70c23497e88a941170093446a.html
- https://www.gov.cn/zhengce/content/202510/content_7043696.htm
- https://www.cac.gov.cn/2004-08/28/c_126468489.htm

### misc-2　部分成立

**待核结论**：主流电子签平台（腾讯电子签、e签宝、法大大）都提供企业对企业合同的 API 签署能力，企业方签署前需完成企业实名认证与经办人授权；按份计费约数元/份

**更正**：“企业实名 + 经办人授权后才能签”和“三家都有 B2B API”成立。“约数元/份”只有 e签宝有官方依据（5～6.5 元/份）；腾讯与法大大没有公开官方单价，且不是纯按份计费：腾讯“第三方应用集成暂时只支持专业版、旗舰版用户使用”，即 API 有版本门槛（版本订阅 + 附赠份数 + 合同加量包 1 千/1 万份两档），CreateOrganizationAuthUrl 还“需要购买单独的实名套餐包方可调用”；法大大基础版无 API 集成，专业版“集成应用许可（可增购）”。腾讯“仅需在发起合同时付费，签署合同不收费”，合同发起成功即扣一份，任一方签过后撤回不返还。成本估算应按“版本年费/门槛 + 份数包 + 实名认证包”三部分询价，不能只按单价乘份数。

**依据**：API 与 B2B 能力成立：腾讯电子签企业版 CreateFlowByFiles 文档支持本企业、他方企业（ApproverType=0）与个人签署方；CreateOrganizationAuthUrl 用于生成合作企业认证链接，认证方式为法人授权或“授权书+对公打款”，授权书方式下超管姓名和手机号必填。法大大官方 Node SDK（@fddnpm/fasc-openapi-node-sdk 5.4.7，维护者邮箱为 fadada.com）的 GetCorpAuthUrlRequest 含 corpIdentMethod（legalRep 法人认证 / agent 代理人认证）、oprIdentInfo（经办人实名：face/mobile/bank）、authScopes（含 signtask_init 代表企业发起签署）。e签宝开放平台提供公有云 SaaS API；企业实名需办理人先完成个人实名一条只见于其官方文档页的搜索摘要，正文未能抓取。计费只部分成立：e签宝官方报价页 100 份 650 元、500 份 3000 元、1000 份 5500 元、2000 份 10000 元（5～6.5 元/份，有效期一年）；腾讯官方定价页是 SPA 抓不到数字，购买指南（2026-09-29 更新）无具体价格，旗舰版写“专属销售经理为您报价”；法大大官方价格页四档均“请联系商务经理”，且未提按份计费。

**来源**：
- http://qian.tencent.com/developers/companyApis/startFlows/CreateFlowByFiles/
- https://qian.tencent.com/developers/companyApis/organizations/CreateOrganizationAuthUrl/
- https://cloud.tencent.com/document/product/1323/71859
- https://cloud.tencent.com/document/product/1323/53795
- https://cloud.tencent.com/document/product/1323/78868
- https://www.esign.cn/site/quotation
- https://open.esign.cn/prices
- https://open.esign.cn/doc/opendoc/paas_api/mf2v1g
- https://www.fadada.com/price
- https://www.fadada.com/product/saasapi
- npm pack @fddnpm/fasc-openapi-node-sdk@5.4.7（src/services/eui/eui_model.ts）

### misc-3　部分成立

**待核结论**：数电发票（全面数字化的电子发票）可通过第三方服务商（诺诺、百望、高灯等）API 开具，需企业税务数字账户授权；版式文件有 PDF/OFD/XML

**更正**：“PDF/OFD/XML 三种格式”和“可经第三方 API 开具”成立，但“需企业税务数字账户授权”表述不准。税务数字账户是电子发票服务平台里查询、下载、用途确认的账户，不是授权对象。实际授权形态有两种：(a) 非乐企通道——企业把电子税务局登录身份交给服务商（账号密码或短信，加开票员实名扫脸，按风险等级定期重扫）；(b) 乐企联用通道——服务商本身是税务机关准入的直连单位，使用单位经邀请接入并按要求上传经营信息。诺诺、百望、高灯各自走哪种、接口字段与价格，今天没有读到官方文档，需商务与技术对接时确认。

**依据**：版式文件一手确认：税务总局新媒体（2024-11-27）“数电发票取消了特定版式，增加了XML的数据电文格式便利交付，同时保留PDF、OFD等格式”；江苏税务 12366 答复（2023-11-07）“数电票支持PDF、OFD以及XML文档格式，企业可以自行选择一种格式进行下载保存”。国家税务总局公告 2024 年第 11 号：2024-12-01 起施行，数电发票与纸质发票同等法律效力，已用途确认或入账的蓝票红冲须经对方确认《红字发票信息确认单》。第三方 API 开具：能读到正文的厂商一手文档只有用友税务云 OpenAPI——支持数电专票(31)/普票(32)，“如果发票类型是数电发票用户名必填”，要传电子税务局用户名和密码（国密密文），回调含 pdf/ofd/xml 下载地址。诺诺、百望、高灯的开放平台文档都是 SPA 或未发布页面，今天抓不到正文（nuonuo.com/open 实际只有 5993 字节的壳，百望 apifox 文档显示“该文档尚未发布”，高灯旧版产品页未提数电），这三家的数电接口细节只有二手文章。官方合规通道见上海税务《乐企联用的规范指引（试行）》（2026-01-28）：直连单位可向无控制关系的使用单位提供数电发票服务，准入门槛为实缴注册资本 1000 万元以上、申请前 12 个月交易累计收入 1 亿元以上、纳税信用近 3 年 A/B 级等。

**来源**：
- https://www.gov.cn/zhengce/zhengceku/202411/content_6989164.htm
- https://www.chinatax.gov.cn/chinatax/n810356/n3010387/c5236173/content.html
- https://jiangsu.chinatax.gov.cn/art/2023/11/9/art_16876_3162.html
- https://shanghai.chinatax.gov.cn/xxgk/tzgg/202601/t479230.html
- https://shanghai.chinatax.gov.cn/xxgk/tzgg/202304/t466805.html
- https://fapiao.yonyoucloud.com/apidoc/api/%E9%94%80%E9%A1%B9-%E5%BC%80%E7%A5%A8%E7%94%B3%E8%AF%B7.html
- https://nuonuo.com/open/
- https://open.baiwang.com/openplatform-ui/home
- https://cloud-old.goldentec.com/open/product/1000/10001

### misc-4　成立

**待核结论**：微信小程序无法直连 sentry.io（域名未备案不能配置为 request 合法域名），需通过自有已备案域名转发或自建上报接口

**依据**：微信官方《网络》文档“配置流程”原文：域名只支持 https/wss；“域名不能使用 IP 地址（小程序的局域网 IP 除外）或 localhost”；“域名必须经过 ICP 备案”；“不支持配置父域名，使用子域名”。阿里云备案文档：“未列入域名后缀列表中的域名无法进行 ICP 备案”，页面列出的已批复英文顶级域（.COM .NET .CLUB .XYZ .CO .CC .ME .TV 等约 140 个）不含 .IO，所以 sentry.io 及其 *.ingest.sentry.io 上报域名无法备案，也就进不了 request 合法域名。微信开放社区有帖标题为“sentry.io加入不了合法域名 提示没有ICP”（仅搜索索引可见，正文未能抓取，作旁证）。转发方案可行：Sentry 官方文档说明 tunnel 是“an HTTP endpoint that acts as a proxy between Sentry and your application”，服务端解析 envelope 头后转发到 https://{host}/api/{projectId}/envelope/；sentry-miniapp@1.20.4 的 dist 中含 tunnel 选项。未做的核查：没有在工信部备案系统直接查 sentry.io（查询需验证码）。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html
- https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/prepare-and-check-the-domain-name
- https://developers.weixin.qq.com/community/develop/doc/0002c6fb7c40b0bfe977aa3a55ec00
- https://docs.sentry.io/platforms/javascript/troubleshooting/
- npm pack sentry-miniapp@1.20.4 && grep -rno tunnel package/dist

### misc-5　成立

**待核结论**：微信“We分析”基础版免费，自定义事件上报有日条数限制（原结论 5000 条/日）

**依据**：微信官方《We 分析计费说明》原文：“We分析自2023/12/18起，提供免费使用的‘基础版’和按量付费的‘专业版’”。版本表“数据上报额度”：业务类数据上报⑥ 基础版 5,000条/日、专业版 50,000条/日；开发类数据上报⑦ 同为 5,000 / 50,000 条/日；注⑥“包含自定义事件、经营事件”。基础版行为分析“仅支持‘事件分析’”，分析数量 10 个，业务类上报数据保存 30 天。专业版基础价：日均打开 <100 次 588 元/年（优惠后 388）、100～1000 次 888（688）、1000～10000 次 2,388（1,888），与原报告一致。

**来源**：
- https://developers.weixin.qq.com/miniprogram/analysis/wedata/price

### misc-6　成立

**待核结论**：@react-pdf/renderer 可在 Node 服务端渲染 PDF 并支持注册中文字体；pdf-lib 可对已有 PDF 叠加图片与文字

**依据**：react-pdf 官方文档 Node API：renderToFile / renderToString / renderToBuffer（“render a PDF into a Node Buffer”）/ renderToStream。Fonts 页：Font.register({family, src, ...})，src “can either be a valid URL, or an absolute path if you're using react-pdf on Node”；“Currently, only TTF and WOFF fonts files are supported”；“Any OpenType Variable fonts (such as Noto Sans variable weights font) does not work properly”。npm：@react-pdf/renderer latest 4.9.0，peer react ^16.8 || ^17 || ^18 || ^19。pdf-lib 官方 README：“Modify Document”一节用 PDFDocument.load 后 drawText；embedPng / embedJpg + page.drawImage；自定义字体须 @pdf-lib/fontkit 并 pdfDoc.registerFontkit(fontkit)。npm：pdf-lib latest 1.17.1 发布于 2021-11-06，GitHub 仓库最后 push 2024-07-17、317 个未关 issue；分支 @cantoo/pdf-lib 2.11.1（2026-09）在维护。

**来源**：
- https://react-pdf.org/node
- https://react-pdf.org/fonts
- npm view @react-pdf/renderer dist-tags version peerDependencies --json
- https://raw.githubusercontent.com/Hopding/pdf-lib/master/README.md
- npm view pdf-lib time --json
- https://api.github.com/repos/Hopding/pdf-lib
- npm view @cantoo/pdf-lib dist-tags time.modified --json

### misc-7　部分成立

**待核结论**：otplib 等库可实现 RFC 6238 TOTP；Node 内置 crypto 支持 scrypt，argon2 需原生模块（argon2 包）或 Node 24+ 内置支持（核对 Node 是否已内置 argon2）

**更正**：Node 确实已内置 argon2，但不是“24+”一概而论：crypto.argon2 / argon2Sync 自 v24.7.0 加入，当时是 Release candidate 级，到 v24.19.0（2026-08-03）才标为稳定；Node 22 LTS 没有。要用内置实现，engines 应写 >=24.19.0（至少 >=24.7.0）。内置接口只返回原始派生密钥，PHC 编码串、盐与参数要自己拼和存。另外“需原生模块”不是唯一选项：hash-wasm 4.12.0（WASM）与 @noble/hashes 2.4.0（纯 JS，导出 ./argon2.js）都不需要原生编译。其余两句（otplib 实现 RFC 6238、scrypt 内置）成立。

**依据**：otplib：npm latest 13.5.0（2026-08-21），官方 README“RFC Compliant - RFC 6238 (TOTP) and RFC 4226 (HOTP) + Google Authenticator Compatible”，并注明 v13 已移除独立 authenticator 包。scrypt：Node 文档 crypto.scrypt “added: v10.5.0”。argon2：Node v24 文档 crypto.argon2(algorithm, parameters, callback) 与 argon2Sync “added: v24.7.0”（支持 argon2d/argon2i/argon2id，返回 derivedKey Buffer）；v24.7.0 当时的文档标注“Stability: 1.2 - Release candidate”；CHANGELOG_V24 在 24.19.0（2026-08-03）条目下有“doc,crypto: mark argon2 and encap/decap as stable”(#63924)；latest-v22.x 的 crypto 文档中 argon2 出现 0 次。本机 Node v24.20.0 实测 argon2Sync('argon2id', …) 无警告返回 32 字节 Buffer。argon2 npm 包 0.45.1 是原生模块（install 脚本为 node-gyp-build，依赖 node-addon-api）；@node-rs/argon2 latest 2.2.1。

**来源**：
- npm view otplib dist-tags version description --json
- https://raw.githubusercontent.com/yeojz/otplib/main/README.md
- https://nodejs.org/docs/latest-v24.x/api/crypto.md
- https://nodejs.org/docs/v24.7.0/api/crypto.md
- https://nodejs.org/docs/latest-v22.x/api/crypto.md
- https://raw.githubusercontent.com/nodejs/node/main/doc/changelogs/CHANGELOG_V24.md
- node -e "require('node:crypto').argon2Sync('argon2id',{message:'pw',nonce:crypto.randomBytes(16),parallelism:1,tagLength:32,memory:19456,passes:2})"（本机 v24.20.0）
- npm view argon2 dist-tags version engines dependencies --json
- npm view @noble/hashes version exports --json
- npm view hash-wasm version description --json

### misc 组的额外发现

- 【电子签】原报告引用的《电子签名法》页面（cac.gov.cn/2004-08/28）是 2004 年原始文本；现行为 2019-04-23 第二次修正版。第十三、十四条实质内容未变，但原报告漏了第十三条末款“当事人也可以选择使用符合其约定的可靠条件的电子签名”——可以在《定制内容授权使用协议》里约定双方认可的签署与验真方式，这对“点击同意 + 平台单方盖章”方案是有利条款，建议法务评估时引用 2019 版。https://www.miit.gov.cn/jgsj/zfs/fl/art/2022/art_e3f623f70c23497e88a941170093446a.html
- 【电子签】原报告未提国办发〔2025〕33号《电子印章管理办法》（2025-10-09 发布，印发之日起施行）。它适用于行政机关、企业事业单位、社会组织等的法定名称章、业务专用章等，规定“符合本办法规定的电子印章与实物印章具有同等法律效力”，电子印章必须含由依法设立的电子认证服务机构签发的电子签名认证证书；第三十五条允许仅用于单位内部业务的电子印章参照自行制作。含义：对外出具的《定制内容授权书》若只贴印章图片，不属于该办法意义上的电子印章；原报告 4.3 的折中方案（平台单方用机构数字证书签 PDF）应以此办法为合规基线。https://www.gov.cn/zhengce/content/202510/content_7043696.htm
- 【电子签】腾讯电子签的三个成本与流程约束（官方文档）：(1) API（第三方应用集成）只对专业版、旗舰版开放，旗舰版由销售报价，官方页面无公开单价；(2) 给商家生成企业认证链接的 CreateOrganizationAuthUrl “需要购买单独的实名套餐包方可调用”，链接有效期 30 天；(3) 只有发起方付费，合同发起成功即扣一份，任一方签过后撤回不返还份额，版本附赠份数随版本到期清零、加量包有效期一年。https://cloud.tencent.com/document/product/1323/71859
- 【电子签】法大大官方 SDK 的企业授权接口里企业组织类型含 individual_biz（个体工商户），认证方式含法人认证与代理人认证。原报告担心的“个体工商户能否完成企业认证”在法大大侧接口层面是支持的；腾讯、e签宝侧今天未查到同等明确的文档。来源：npm 包 @fddnpm/fasc-openapi-node-sdk@5.4.7 的 src/services/eui/eui_model.ts。
- 【发票】本项目自己走不了“乐企”直连：上海税务乐企自用指引（2025 版）要求直连单位上年营业收入 5000 万元以上、12 个月开票不低于 1 万份或 1 亿元；乐企联用指引（2026-01-28 试行）要求实缴注册资本 1000 万元以上、12 个月交易收入 1 亿元以上。将来自动开票只能经已是直连单位的服务商，或经“托管电子税务局登录身份”的服务商。后者要把电子税务局账号密码交给第三方并定期扫脸（用友税务云文档明确要传电子税务局用户名与密码），是 InvoiceProvider 选型时要单独评估的安全与运维风险。https://shanghai.chinatax.gov.cn/xxgk/tzgg/202601/t479230.html
- 【监控】原报告称 sentry-miniapp“已升到 11”，与 registry 不符：sentry-miniapp@1.20.4（2026-09-20，latest）的依赖是 @sentry/core 10.74.0，而 @sentry/core latest 为 11.2.0（v10 线为 10.75.3）。小程序端与服务端 SDK 主版本不同不影响上报，但不要按“全栈统一 Sentry 11”来写依赖约束。命令：npm view sentry-miniapp@latest dependencies --json
- 【监控】sentry-miniapp 官方 README 与 FAQ 的示例是把 DSN 的 host（如 o0.ingest.sentry.io）直接加入 request 合法域名，没提备案问题。这与微信“域名必须经过 ICP 备案”的规则冲突，照做会在小程序后台配置失败。本项目应直接走 tunnel 到自有已备案 API 域名，或自建 /client-logs。https://sentry-miniapp.pages.dev/guide/faq
- 【监控】原报告 7.1 写“request 合法域名……每月可改 50 次”并引微信《网络》文档；今天抓取该页，全文没有修改次数的表述（只查到 HTTPS、备案、端口、不支持父域名等规则）。这个数字未获该出处支持，需在小程序后台界面另行核实。https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html
- 【埋点】We分析基础版的 5,000 条/日是“业务类数据上报”总额度，自定义事件与经营事件共用，上报数据只保存 30 天，只能做“事件分析”且最多 10 个分析，没有数据下载和拉取 API。另：新发布的小程序“在发布首个版本后的200天内，可免费体验We分析专业版”，试点期可以先白用专业版的漏斗与留存做交叉校验。https://developers.weixin.qq.com/miniprogram/analysis/wedata/price
- 【PDF】@react-pdf/renderer 的中文字体有两个硬约束：只支持 TTF 和 WOFF（不支持 OTF），可变字体不能正常工作。思源黑体/宋体官方发行以 OTF、TTC 和可变字体为主，需要准备静态 TTF 版本并按字重分别注册。另外中文自动换行有未关闭的 issue（diegomura/react-pdf #2917，2024-10 提出、2026-02 仍 open；更早的 #1662、#692 的做法是用 Font.registerHyphenationCallback 逐字切分）。选定前应先用真实授权书长文本做换行与分页验证。https://react-pdf.org/fonts
- 【PDF】pdf-lib 原版自 2021-11-06 后没有发版，内置标准字体不含中文，叠加中文文字必须配 @pdf-lib/fontkit 嵌入字体。若采用“在模板 PDF 上贴章填字”的路线，建议用仍在维护的 @cantoo/pdf-lib（2.11.1，2026-09）。
- 【密码哈希】本机 Node 为 v24.20.0，内置 argon2 可用且已是稳定接口（24.19.0 起）。若项目 engines 允许锁到 >=24.19.0，argon2id 可以零依赖实现，原报告“沿用 scrypt，因为不想引原生依赖”的理由不再是唯一选择；仍需自己实现 PHC 串编码与参数升级逻辑。
- 【核查局限】以下一手页面今天无法机读，相关结论只能给 partially：腾讯电子签定价页（qian.tencent.com/pricing，SPA）、e签宝与法大大开放平台文档正文、诺诺/百望/高灯开放平台文档、微信开放社区帖子正文；工信部备案系统需验证码，未直接查询 sentry.io。

## 补充核实（2026-10-02，针对业务答复）

业务答复后追加的两组核实，共 11 条：成立 3 条，部分成立 8 条。

### 小程序内短信验证码登录的平台规则

#### login-1　部分成立

**待核结论**：运营规范 12.6.1 要求“小程序内存在账号体系时，必须提供微信授权登录”；在提供微信授权登录的前提下，可以同时提供“手机号 + 短信验证码”自建登录。

**结论**：条文成立：现行《微信小程序平台运营规范》原文为“12.6.1 微信小程序内存在账号体系时，必须提供微信授权登录。”，同节还有 12.6.2（用户拒绝授权后，可在其表现出授权意向时再次提醒）和 12.6.3（“应提供功能正常且易于发现的‘退出’选项”）。“可以同时提供短信验证码登录”没有明文依据：我没有查到禁止并存的条文，也没有查到明文允许的条文，“不得只提供短信登录”只是 12.6.1 的反面推论；“wx.login + 手机号组件”是否算“微信授权登录”，规范也未定义。并存时仍受这些条款约束：15.1.3（除法律要求或用户同意外，不得要求输入手机号等个人信息才可使用功能）、15.1.3.1（未触发相关功能前不得提前弹窗申请权限或收集个人信息）、15.1.3.2（用户拒绝后不得停止全部服务）、5.14.2（登录页不得用“微信”字样或标识致误认）。

**来源**：
- https://developers.weixin.qq.com/miniprogram/product/
- https://developers.weixin.qq.com/miniprogram/product/reject.html

#### login-2　部分成立

**待核结论**：手机号快速验证组件的授权弹窗里，用户可“使用其他手机号 / 添加手机号”，由微信发短信验证码验证后返回该号码；换一个微信号，只要能收到目标手机号的短信，也能通过该组件取得这个手机号。

**结论**：核心能力有官方原文：“该能力使用时，用户可选择绑定号码，或自主添加号码。平台会基于中国三大运营商提供的短信等底层能力对号码进行验证，但不保证是实时验证”。也就是组件返回的号码不必是该微信的绑定手机号，现有设计已能满足“换微信登录同一手机号账号”的诉求。未能在官方文档核到的部分：弹窗文案“使用其他手机号”和“输入短信验证码”的具体流程（官方页没有“验证码”字样，只有社区开发者帖子标题佐证）、一个微信可添加号码的数量上限、是否所有用户可用。官方只写了开放范围“非个人主体，且完成了认证的小程序”，以及 code 5 分钟有效、只能消费一次。注意“不保证实时验证”：以前添加过的号码之后可能不再发短信就直接返回。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html
- https://developers.weixin.qq.com/community/develop/doc/000404b590c508446689b917257800
- https://developers.weixin.qq.com/community/develop/doc/00066ce7f84d28a1615b66ea051800
- https://developers.weixin.qq.com/community/develop/doc/0004aa70c20d406df3317a50e61c00

#### login-3　部分成立

**待核结论**：微信另有“手机号实时验证组件”（getRealtimePhoneNumber），每次使用都由微信向手机号发短信验证，单价 0.04 元/次，高于快速验证组件。

**结论**：用途与价格成立：官方原文“在每次请求时，平台均会对用户选择的手机号进行实时验证”；“自2023年8月28日起，手机号实时验证组件将需要付费使用。标准单价为：每次组件调用成功，收费0.04元”（快速验证为 0.03 元）。另有 1000 次体验额度（正式版、体验版、开发版共用），仅对非个人主体且已认证的小程序开放；用法是 button open-type="getRealtimePhoneNumber" + bindgetrealtimephonenumber，后端同样用 phonenumber.getPhoneNumber 消费 code，额度不足时返回 1400001。“每次都发短信验证码”不是官方原话：文档只说基于运营商“短信等底层能力”实时验证，没有写每次必发验证码。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getRealtimePhoneNumber.html
- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html

#### login-4　成立

**待核结论**：收集手机号须在用户隐私保护指引中声明；不得在用户未使用相关功能前强制要求授权手机号（常见拒绝情形里的相关条款）。

**结论**：两点都有一手原文，但条款出处要更正：禁止提前或强制收集的条文在《运营规范》15.1.3 系列，不在“常见拒绝情形”。隐私指引：“仅有在指引中声明所处理的用户信息，才可以调用平台提供的对应接口或组件。若未声明，对应接口或组件将直接禁用。”（报错 errno 112），快速验证和实时验证组件都列为“手机号”类隐私接口，且须先同步用户已同意隐私指引才能调用。运营规范 15.1.3.1：“用户未触发需使用权限或用户个人信息的相关功能或服务时，你不得提前向用户弹窗申请权限或收集用户个人信息”；15.1.3.2：拒绝授权后不得“通过自动退出、关闭或其他任何方式停止向用户提供小程序全部服务”。常见拒绝情形只有通用的 3.4.1（收集任何数据须明确告知用途并经用户同意）；组件文档另写明“不合理地要求用户提供手机号…中断了正常的使用流程”平台有权处理。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html
- https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/
- https://developers.weixin.qq.com/miniprogram/product/
- https://developers.weixin.qq.com/miniprogram/product/reject.html
- https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html

#### login-5　部分成立

**待核结论**：腾讯云国内验证码短信的单价量级、默认频率限制（同一手机号 30 秒 1 条、1 小时 5 条、1 个自然日 10 条之类），以及验证码短信同样受“签名只支持公司、机构、商标”和运营商报备 7–10 个工作日约束。

**结论**：单价成立：国内短信为预付费套餐包，0.041–0.050 元/条（1 万条 470 元即 0.047 元/条；自定义包最低 1000 条、0.050 元/条），验证码、通知、营销同价共用，2 年有效，70 字以内计 1 条。频率限制需更正：“30 秒 1 条、1 小时 5 条、1 天 10 条”是个人认证用户可设置的上限，不是默认值。默认策略是“同一号码同一内容30秒内最多发送1条”和“同一手机号一个自然日最多发送2条”（2024-05-22 之前创建的应用为 10 条）；企业认证可在控制台自定义，运营商侧另有“同一号码非营销短信10条/天”。签名与报备约束成立：国内短信一律是“签名 + 正文”，签名文档未按短信类型区分，验证码短信没有豁免；签名类型只有公司、商标、政府/机关事业单位/其他机构，生效后还需运营商实名报备，“一般需要 7-10 个工作日”。

**来源**：
- https://cloud.tencent.com/document/product/382/36132
- https://cloud.tencent.com/document/product/382/18058
- https://cloud.tencent.com/document/product/382/37809
- https://cloud.tencent.com/document/product/382/37794
- https://cloud.tencent.com/document/product/382/39022
- https://cloud.tencent.com/announce/detail/2256

#### login 组的额外发现

- 【现有设计已满足“换微信登录”】手机号快速验证组件官方写明“用户可选择绑定号码，或自主添加号码”，所以换一个微信也能授权同一手机号进入同一账号，不必为这个诉求自建短信登录。后端只需保证账号按手机号归并、一个账号可挂多个 openid（原记录 msg-6 已按此设计）。来源：https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html
- 【自建短信登录成本更高、依赖更多】自建短信 0.045–0.050 元/条，高于快速验证 0.03 元和实时验证 0.04 元，还要先完成签名审核和运营商报备（7–10 个工作日）。签名只能是公司名、已注册商标或机构名，“狸有戏”须是营业执照全称的连续子串或已注册商标才能用。签名闲置会失效（“闲置时限在7天-6个月不等，且失效前不会提前告知”），登录短信量低时有风险。来源：https://cloud.tencent.com/document/product/382/36132 、https://cloud.tencent.com/document/product/382/37794
- 【腾讯云新应用默认每号每天只能发 2 条】2024-05-22 之后创建的应用，默认“同一手机号一个自然日最多发送2条”，登录验证码场景必须在控制台“频率及发送状态回调配置 > 发送频率限制”调高。运营商侧对同一号码非营销短信另有 10 条/天上限；白名单最多 300 个号码不受频率策略限制。这些数值由抓取工具摘要读出，上线前请在控制台核对一次。来源：https://cloud.tencent.com/document/product/382/37809
- 【驳回原因一：未体验即要求手机号登录】官方社区帖《关于收集用户手机号码授权登录案例解析和整改建议》列举的违规情形包括“一进入未浏览体验功能服务，即要求授权手机号码登录”，以及授权手机号时没有取消或拒绝选项；整改方向是先让用户浏览体验，再由用户自行选择登录。帖子正文我未能抓取（页面为脚本渲染），以上来自搜索摘要，对应条文是运营规范 15.1.3.1 和 15.1.3.2。来源：https://developers.weixin.qq.com/community/develop/doc/0000ccf58c05402478534e85f61809
- 【驳回原因二：审核员无法登录】常见拒绝情形 3.3.4 原文：“若小程序中存在账号体系，需提供测试号，包含账号和密码（可以体验所有功能）。”短信验证码登录下审核员收不到验证码，需要给审核专用的测试账号通道（例如测试手机号配固定验证码）；手机号组件登录同样要给审核员一个可进入的测试账号。来源：https://developers.weixin.qq.com/miniprogram/product/reject.html
- 【驳回原因三（二手线索，未核实）】社区帖《小程序审核不通过问题?》的搜索摘要称：仅限特定人员使用的小程序用“手机号 + 验证码”登录时，审核要求对无权限号码明确提示无权登录或不支持下发验证码，并要求页面有《用户协议》《隐私协议》；另有“账号可以是手机号，但密码不能是短信验证码”的整改口径。发帖人身份和原文未核实，只能作风险提示。来源：https://developers.weixin.qq.com/community/develop/doc/000c4e0082803846431276dcb64400
- 【驳回原因四：只有短信登录、没有微信授权登录】这直接违反 12.6.1。如果增加短信登录，微信侧登录入口必须保留且易于发现，登录页文案和图标仍受 5.14.2 约束，不能出现“微信”字样或标识。来源：https://developers.weixin.qq.com/miniprogram/product/
- 【安全提示（我的推断，非官方表述）】快速验证组件“不保证是实时验证”，以前在某个微信里添加过的号码，之后可能不再发短信就直接返回。账号以手机号为唯一标识时，号码易主或二次放号存在被旧微信登录的理论风险；改绑、退款、敏感设置等操作可改用实时验证组件（0.04 元/次）做二次确认。
- 【核实范围的限制】微信开放社区帖子页抓取结果为空，所以“使用其他手机号”弹窗的具体交互、可添加号码的数量上限、官方人员的相关答复都没有核到一手原文。本次共用 25 次工具调用，已到上限。

### 已开通的微信支付商户号与支付定性

#### mch-1　成立

**待核结论**：是否属于虚拟支付取决于小程序所售商品/服务的形态（由平台在审核与上线后判定），不取决于是否已有微信支付商户号；已有普通商户号绑定小程序后，若所售内容被认定为虚拟商品，普通微信支付（JSAPI）仍会被限制或被要求改用虚拟支付。

**结论**：核心结论成立：开通商户号不解决定性问题。运营规范 5.13、2026-02-27 公告和《虚拟支付业务运营指南》都按“非实物商品 + 线上交付”的形态判定，全文没有把“是否已有商户号”作为条件；带官方标识的客服对“目前接了小程序支付的还需要接虚拟支付吗”的答复是“如小程序内服务内容涉及虚拟商品购买，如虚拟会员，VIP、在线课程等，需重新接入小程序虚拟支付能力”（此条沿用既有核实记录，本次未重读）。限定条件有两点。第一，官方写的认定主体是“平台”，时点是提审以及上线后“一经发现”，没有逐字出现“日常巡查”。第二，后果分两种：仅含管控类目的小程序会被直接关闭“安卓及其余非iOS系统的普通微信支付能力”；其余情形按违规处理（风险提醒、限制功能直至暂停或终止服务），不是自动关停支付。

**来源**：
- https://developers.weixin.qq.com/miniprogram/product/#_5-13-虚拟支付行为
- https://mp.weixin.qq.com/cgi-bin/announce?action=getannouncement&announce_id=11772091560sL6TW&version=&lang=zh_CN&token=
- https://developers.weixin.qq.com/community/minihome/doc/00002cf077cd4810fee42f4b865c01
- https://developers.weixin.qq.com/community/minihome/doc/00028a621b00208dc0b48759d6ec00

#### mch-2　部分成立

**待核结论**：小程序虚拟支付开通时会创建一个新的、独立于现有普通商户号的二级商户号；现有普通商户号不能直接用于虚拟支付收款。

**结论**：前半句有官方原文：虚拟支付文档写“点击【开通】按钮进行协议签署及资料上传，开通新的商户号”，需重新填写营业执照、提现账户、支付管理员信息，审核 1-7 个工作日，“若状态显示「已签约」……二级商户号开通成功”；结算为 T+3 分账并扣技术服务费。后半句没有官方明文：文档既没写“不能使用已有商户号”，也没有提供绑定已有商户号的入口，只能从流程推断成立。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html
- https://developers.weixin.qq.com/community/pay/doc/0008e6cafd4dc8d000e47bf4361c00

#### mch-3　部分成立

**待核结论**：商户号进件时选择的行业/经营类目决定费率与付款人限额（原记录：实物行业单笔与单日 8 万元，虚拟行业单笔 6,000 元、单日 9,000 元）；商户可在商户平台查看类目与费率；常见实物类 0.6%、虚拟类 1%；类目可自助或通过客服变更。

**结论**：“类目决定费率与限额”成立：腾讯客服页写“结算规则是指接入行业对应的结算费率、周期及限额信息”“具体费率以商家在微信支付商户平台中的核准记录为准”；多数行业 0.6%、T+1，“游戏、在线音视频等虚拟业务”1% 并带“虚拟限额”，“门户论坛/网络广告及推广/软件开发/其他互联网服务”为 0.6%、无特殊资质。限额数字有冲突，须重新确认：2020 年的客服页写实物 8 万、虚拟单笔 6,000/单日 9,000，而 2026-06-12 更新的《入驻结算规则、行业属性及特殊资质》页末注为“虚拟额度是单笔5w，单日50w”（该句由抓取工具摘要得到，我未逐字核读原页，哪些规则 ID 带虚拟限额也需人工再看）。查看路径只查到搜索摘要里的“【账户中心】->【商户信息】->【结算信息】”（未打开原页核对）；“能否自助或经客服变更类目”没有找到任何一手来源，属未核实。

**来源**：
- https://kf.qq.com/faq/220228IJb2UV220228uEjU3Q.html
- https://kf.qq.com/faq/140225MveaUz1504092YFjeM.html
- https://kf.qq.com/touch/faq/200726QjeQFF200726Vryay6.html
- https://kf.qq.com/faq/140225MveaUz150107u2eu6b.html

#### mch-4　部分成立

**待核结论**：普通商户号要在小程序里发起 JSAPI 支付，须在商户平台“AppID 账号管理”里关联该小程序 AppID，并在小程序后台确认授权；同主体直接关联，不同主体需授权并有数量限制。

**结论**：关联与确认的流程成立，但两处细节要更正。入口在商户平台“产品中心 > APPID授权管理（AppID账号管理）> +关联AppID”，随后到小程序后台“微信支付 > 商户号管理”确认；小程序须已认证。主体一致时只填 AppID 即可提交；主体不一致也可以关联，但要补填 AppID 的认证主体信息（抓取摘要称还需签署《微信支付联合营运承诺函》，我未逐字核到）。数量限制是“一个商户号最多可关联50个AppID账号”，文档没有针对不同主体另设数量上限；特殊行业费率的商户号提交绑定后会增加 1-3 个工作日审核。文档更新于 2025.07.02，未写小程序侧确认的时限。

**来源**：
- https://pay.weixin.qq.com/doc/v3/merchant/4013287504
- https://pay.weixin.qq.com/doc/v3/merchant/4013287010
- https://pay.weixin.qq.com/doc/v3/merchant/4012791894

#### mch-5　部分成立

**待核结论**：使用微信支付的小程序在用户付款后需上传发货信息（订单发货管理），否则影响资金结算或被限制支付能力；需核对适用范围、虚拟或服务类订单如何上报、不上报的后果。

**结论**：不是所有开通支付的小程序都适用：官方文档写的是“特定类型的小程序需要在平台完成发货信息录入及确认收货流程后方可进行资金结算”，运营规范的适用对象是“在小程序生态中提供商品/服务在线销售及配送的小程序”，可用 /wxa/sec/order/is_trade_managed 查询本小程序是否已被纳入；本产品（商业服务类目）是否被纳入，我没有查到依据。被纳入后的后果有原文：“用户交易后，默认资金将会进入冻结状态”；超过 48 小时未发货会收到提醒，超时或虚假发货按“警告 → 支付风险提示 → 暂停交易”处理，并可延迟结算；自动确认收货为物流发货后第 10 天、自提/同城配送后第 2 天；支付开发指引另写“可能被公众平台限制使用小程序进行支付的权限”。logistics_type 的四个值（1 实体物流、2 同城配送、3 虚拟商品、4 用户自提）以及“服务类可申请变更交易类型后免上传”只来自搜索摘要，本次未在官方页逐字核到，后者尤其不能当作已核实。

**来源**：
- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/order-shipping/order-shipping.html
- https://developers.weixin.qq.com/miniprogram/product/jiaoyilei/yunyingguifan.html
- https://pay.weixin.qq.com/doc/v3/merchant/4012791911

#### mch-6　成立

**待核结论**：较早开通的商户号默认使用平台证书验签，新商户号默认微信支付公钥；老商户需在商户平台申请并手动开启公钥；核对商户在哪里查看当前模式。

**结论**：结论成立：官方写“新申请的商户号默认为微信支付公钥模式”；公钥常见问题（更新 2025.03.04）写老商户“申请公钥后默认不开启公钥切换，需要在【商户平台】->【账户中心】->【API安全】->【微信支付公钥】->【管理公钥】页面点击开启公钥切换按钮后才可以使用”。查看位置就是“账户中心 > API安全”：看该页是否已申请微信支付公钥以及切换是否开启；官方文档没有一句专门讲“如何查看当前模式”，也没有写明从哪一天起新商户默认公钥，这两点是按页面入口推断的。回调侧也可自查：Wechatpay-Serial 以 PUB_KEY_ID_ 开头即公钥模式。

**来源**：
- https://pay.weixin.qq.com/doc/v3/merchant/4015419357
- https://pay.weixin.qq.com/doc/v3/merchant/4013038816
- https://pay.weixin.qq.com/doc/v3/merchant/4012154180
- https://pay.weixin.qq.com/doc/v3/merchant/4012791902

#### merchant 组的额外发现

- 【对业务方回复的直接结论】已开通微信支付商户号只满足了“能用普通微信支付收款”的前提，不改变平台对业务形态的认定。商户号真正有用的场景是：产品被认定为非虚拟（人工定制服务）时走自有商户号的 JSAPI。此时还要逐项确认：商户号主体与小程序主体是否一致、进件类目与费率、付款人限额、是否被纳入发货信息管理、验签模式。
- 【限额数字出现冲突，影响客单价可行性】原记录引用的 2020 年客服页写虚拟行业单笔 6,000 元/单日 9,000 元、实物 8 万元；而 2026-06-12 更新的客服页《入驻结算规则、行业属性及特殊资质》页末写“虚拟额度是单笔5w，单日50w”。后者是抓取工具的摘要，我没有逐字读到原页，须人工打开 https://kf.qq.com/faq/220228IJb2UV220228uEjU3Q.html 核对，并以商户平台里本商户号的核准记录为准。若按 5 万计，3.6 万年付可单笔完成，7.2 万与 14.4 万仍不行。
- 【商户号进件类目的线索】同一客服页列有“门户论坛/网络广告及推广/软件开发/其他互联网服务”，费率 0.6%、无特殊资质；1% 且带虚拟限额的是“游戏、在线音视频等虚拟业务”。业务方应先在商户平台看自己商户号实际核准的类目与费率，再判断是否与“广告/设计类人工服务”的定位一致。
- 【咨询渠道：没有找到官方的“事前书面认定”渠道】《虚拟支付业务运营指南》页面只有通用的“客服中心”链接，没有写咨询或申诉方式。能找到的官方答疑场所是微信开放社区：搜索结果显示有“虚拟行业小程序交流专区”（https://developers.weixin.qq.com/community/minihome/mixflow/4308645307338031123 ，本次抓取失败，内容未核读），既有记录里的几条官方口径也都来自带“微信官方用户”标识的社区回复。实际具有约束力的认定只发生在提审与上线后的平台处置；社区答复可作参考，不等于审核结论。
- 【微信支付侧客服管不了定性】商户号的类目、费率、限额问题归微信支付（商户平台与腾讯客服）；“是否属于虚拟支付”归小程序平台。这是按两套文档各自的管辖范围得出的推断，没有官方原话。
- 【未核实线索】搜索摘要显示一条社区帖称：小程序一旦选择 B2B 类目（商品批发/门店管理），关联的微信支付会变成 B2B 支付，删除类目也不会恢复为普通微信支付。来源 https://developers.weixin.qq.com/community/develop/doc/000686b83480c849373254a5c66000 ，未读到正文与回复者身份，选类目前需自行确认。
- 【本次核查的局限】受 25 次工具调用上限约束，以下内容只拿到抓取摘要或搜索摘要、未逐字核读原文：发货接口 logistics_type 枚举、服务类小程序免上传发货信息的说法、商户平台查看费率的具体菜单、不同主体关联所需的承诺函名称、公钥切换的灰度步骤。社区帖 000a2031a2cd709eb86f63a8d51400 与虚拟行业专区页面均未能读取。
