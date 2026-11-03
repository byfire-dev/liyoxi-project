# 首页原生客服接入

首页第四项「联系客服」使用 Taro 原生 `Button` 的 `openType="contact"`，直接打开当前小程序的微信客服会话。老板、店员、游客均可点击，无需先登录业务账号；其他三项业务入口仍保持老板权限。会话来源为固定值 `home`，不传手机号、门店资料或登录凭证。

H5 只提示「请在微信小程序内联系客服」。真实会话与收发必须在微信内验收；微信官方按钮文档当前标明鸿蒙 OS 暂不支持 `contact`，不能把 H5 或其他平台的界面检查当作该平台可用证明。

## 运营需要配置

1. 用小程序管理员账号登录[微信公众平台](https://mp.weixin.qq.com/)，选择与本项目 `WEAPP_APPID` 对应的小程序，进入「客服」管理，添加并绑定实际接待人员的微信号。菜单位置以当前后台为准。
2. 绑定后的客服人员打开「客服小助手」小程序，选择本小程序；或扫码登录[微信网页客服工具](https://mpkf.weixin.qq.com/)。确认能够看到待接入会话，并安排人员接待。
3. 保留本项目已有的消息推送配置。不要为这次客服接入关闭消息推送、另换 URL 或重新生成 Token / EncodingAESKey：同一入口还承接订阅消息事件和内容安全回调。
4. 如果客服工具收不到用户消息，检查「设置 → 第三方设置 → 第三方平台授权管理」中的客服权限是否交给其他平台，以及是否启用了接管消息的云函数或云托管；按实际接管方排查，不直接撤销现有授权。

这次接入不需要企业微信账号、企业微信同主体关联、`corpId`、`kfLink` 或新增自建聊天服务。客服回复仍受微信规定的时间与条数限制，具体以官方指南和客服工具提示为准。

## 现有消息推送与部署

[平台配置台账](../../../docs/plan/platform-config.md)记载：2026-10-19 已启用消息推送，当时 URL 是 `https://api.stg.liyoxi.timavia.com/api/v1/hooks/wechat/messages`。这是已有记录，本次没有读取线上微信后台，也没有验证当前运行版本；如果后续已经切换生产，保留当前正确的生产地址。

本项目回调使用 **JSON 数据格式 + 安全模式**，AppID、Token、EncodingAESKey 必须与后端部署一致。已有配置齐备时无需新增环境变量；只有排查环境缺失时，才按[微信驱动配置说明](../../../infra/compose/providers/README.md)核对 `LYX_NODE_PROVIDERS` 中的 `wechat`、`WECHAT_APPID` 以及 `wechat-secret`、`wechat-message-token`、`wechat-message-aes-key` 密钥文件。密钥不放进小程序代码。

后端 [`wechat-message.ts`](../../../packages/services/src/security/wechat-message.ts) 已对文本、图片、小程序卡片和进入客服会话事件回复加密的 `transfer_customer_service`，把消息交给微信人工客服，不保存客服会话正文。无需为首页按钮新增业务 API；线上仍须确认运行版本包含此转接逻辑。

## 发布与真机验收

- 构建和上传时沿用真实 `WEAPP_APPID` 与 API 地址；`touristappid` 占位构建不能作为客服收发验收依据。
- 上传新体验版后，分别以老板、店员、游客身份点击首页「联系客服」，确认打开的是本小程序的客服会话，且入口不再显示「暂未开放」。
- 用户发送一条文本或图片，客服在「客服小助手」或网页工具中接入并回复，用户确认收到；只打开会话不代表人工收发已经通过。
- 返回小程序后确认首页布局正常，店员与游客仍不能使用其他老板专属快捷入口。

本次源码接入及本地构建不代表后台客服人员已绑定，也不代表体验版已上传或真机收发已完成。

官方依据：[客服功能使用指南](https://developers.weixin.qq.com/miniprogram/introduction/custom.html)、[button 开放能力](https://developers.weixin.qq.com/miniprogram/dev/component/button.html)（2026-11-03 核对）。
