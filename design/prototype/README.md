# 原型快照

| 项 | 内容 |
| --- | --- |
| 快照日期 | 2026-10-02 |
| 用途 | 后续开发的界面依据。视觉与交互以这里的源码为准，不依赖 Figma |
| 配套 | [设计规范](../design-spec.md)、[样式变量](../tokens.json)；逐画板的字段、交互与接口梳理见 [docs/appendix/research](../../docs/appendix/research/) 的 `proto-*.md` |

## 目录

```
prototype/
  merchant/src/      商家端 47 个画板的源码（.dc.html）与画板索引 canvas.json
  merchant/screens/  商家端截图（.webp，2 倍像素，长页面完整展开）
  admin/src/         运营管理后台 56 个画板的源码与画板索引
  admin/screens/     运营管理后台截图（.webp，长页面完整展开）
  scripts/           重新生成截图的脚本
```

## 怎么用

- **看样子**：打开 `screens/` 里的截图。需要滚动的页面已完整展开，所以手机截图的高度不是 844。
- **看数值**：打开 `src/` 里的源码。每个元素的颜色、字号、间距、圆角都写在内联 `style` 里，可以直接照抄；`{{...}}` 是模板占位，`<sc-if>`、`<sc-for>` 是条件与循环。
- **看交互与状态**：源码末尾的 `<script type="text/x-dc">` 是这个画板的状态逻辑，里面有示例数据、各状态的取值与取色、按钮点击后的变化。截图只有打开时的默认状态，弹层、切换页签、表单校验等要看这段脚本。
- **看可点击的演示**：打开下表的在线原型，进入演示模式。

源码是为网页写的（手机按 390 宽）。小程序用 Taro 与 NutUI 实现，尺寸要按[设计规范](../design-spec.md)换算，组件要对应到 NutUI，不是照搬 HTML。

## 来源

| 端 | 在线原型 | 版本号 | 画板尺寸 | 画板数 |
| --- | --- | --- | --- | --- |
| 商家端小程序 | <https://claude.ai/artifact/TMmhyFnWMNipsFj2V6n4Gr> | `1790914997-20b1` | 390 × 844 | 47 |
| 运营管理后台 | <https://claude.ai/artifact/8pTEg2oDj1wHX2EseGwVXW> | `1790915061-764c` | 1440 × 900 | 56 |

在线原型改动后，这里不会自动更新。更新步骤见文末。

## 商家端小程序

### ① 登录与选剧

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| M01 登录授权 | [Login.dc.html](merchant/src/Login.dc.html) | [Login.webp](merchant/screens/Login.webp) |
| M02 首页 | [Main.dc.html](merchant/src/Main.dc.html) | [Main.webp](merchant/screens/Main.webp) |
| M03 搜索页 | [Search.dc.html](merchant/src/Search.dc.html) | [Search.webp](merchant/screens/Search.webp) |
| M04 短剧商城 | [Mall.dc.html](merchant/src/Mall.dc.html) | [Mall.webp](merchant/screens/Mall.webp) |
| M05 预告片模式 | [Trailer.dc.html](merchant/src/Trailer.dc.html) | [Trailer.webp](merchant/screens/Trailer.webp) |
| M06 短剧详情（《心动便利店》） | [Detail.dc.html](merchant/src/Detail.dc.html) | [Detail.webp](merchant/screens/Detail.webp) |

### ② 订购与交付

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| M08 选剧单 | [Cart.dc.html](merchant/src/Cart.dc.html) | [Cart.webp](merchant/screens/Cart.webp) |
| M09 确认订购（扣积分） | [Checkout.dc.html](merchant/src/Checkout.dc.html) | [Checkout.webp](merchant/screens/Checkout.webp) |
| M11 订购成功 | [PayResult.dc.html](merchant/src/PayResult.dc.html) | [PayResult.webp](merchant/screens/PayResult.webp) |
| M20 我的订单 | [Orders.dc.html](merchant/src/Orders.dc.html) | [Orders.webp](merchant/screens/Orders.webp) |
| M21 订单详情 | [OrderDetail.dc.html](merchant/src/OrderDetail.dc.html) | [OrderDetail.webp](merchant/screens/OrderDetail.webp) |
| M22 方案确认（09-28 待确认） | [Plan.dc.html](merchant/src/Plan.dc.html) | [Plan.webp](merchant/screens/Plan.webp) |
| M23 样片确认 | [Sample.dc.html](merchant/src/Sample.dc.html) | [Sample.webp](merchant/screens/Sample.webp) |
| M28 发布任务（成片交付后） | [Publish.dc.html](merchant/src/Publish.dc.html) | [Publish.webp](merchant/screens/Publish.webp) |
| M24 上线记录（《家有萌娃》） | [LaunchRecord.dc.html](merchant/src/LaunchRecord.dc.html) | [LaunchRecord.webp](merchant/screens/LaunchRecord.webp) |

### ③ 商家建档

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| M12 商家档案 | [Profile.dc.html](merchant/src/Profile.dc.html) | [Profile.webp](merchant/screens/Profile.webp) |
| M13 建档·基础信息 | [ProfileBasic.dc.html](merchant/src/ProfileBasic.dc.html) | [ProfileBasic.webp](merchant/screens/ProfileBasic.webp) |
| M14 建档·门店形象 | [ProfileStore.dc.html](merchant/src/ProfileStore.dc.html) | [ProfileStore.webp](merchant/screens/ProfileStore.webp) |
| M15 建档·服务与价格 | [ProfileService.dc.html](merchant/src/ProfileService.dc.html) | [ProfileService.webp](merchant/screens/ProfileService.webp) |
| M16 建档·资质认证（首次提交 · 06-12） | [ProfileCert.dc.html](merchant/src/ProfileCert.dc.html) | [ProfileCert.webp](merchant/screens/ProfileCert.webp) |
| M17 审核结果（06-12 提交 → 06-13 通过） | [ProfileReview.dc.html](merchant/src/ProfileReview.dc.html) | [ProfileReview.webp](merchant/screens/ProfileReview.webp) |

### ④ 广告、账号与客服

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| M18 我的广告（含 M42 提交制作需求） | [Ads.dc.html](merchant/src/Ads.dc.html) | [Ads.webp](merchant/screens/Ads.webp) |
| M19 广告视频详情（国庆双人套餐待确认） | [AdDetail.dc.html](merchant/src/AdDetail.dc.html) | [AdDetail.webp](merchant/screens/AdDetail.webp) |
| M26 渠道账号 | [Accounts.dc.html](merchant/src/Accounts.dc.html) | [Accounts.webp](merchant/screens/Accounts.webp) |
| M29 客服中心 | [Service.dc.html](merchant/src/Service.dc.html) | [Service.webp](merchant/screens/Service.webp) |
| M31 工单详情 · 处理中 | [Ticket.dc.html](merchant/src/Ticket.dc.html) | [Ticket.webp](merchant/screens/Ticket.webp) |
| M31 工单详情 · 待您确认（09-28） | [TicketDone.dc.html](merchant/src/TicketDone.dc.html) | [TicketDone.webp](merchant/screens/TicketDone.webp) |

### ⑤ 个人中心

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| M32 我的 | [Mine.dc.html](merchant/src/Mine.dc.html) | [Mine.webp](merchant/screens/Mine.webp) |
| M33 我的短剧 | [MyDramas.dc.html](merchant/src/MyDramas.dc.html) | [MyDramas.webp](merchant/screens/MyDramas.webp) |
| M34 合同与授权书 | [Contracts.dc.html](merchant/src/Contracts.dc.html) | [Contracts.webp](merchant/screens/Contracts.webp) |
| M35 发票管理 | [Invoices.dc.html](merchant/src/Invoices.dc.html) | [Invoices.webp](merchant/screens/Invoices.webp) |
| M36 消息中心 | [Messages.dc.html](merchant/src/Messages.dc.html) | [Messages.webp](merchant/screens/Messages.webp) |

### ⑥ 套餐与积分

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| M43 套餐与积分 | [Wallet.dc.html](merchant/src/Wallet.dc.html) | [Wallet.webp](merchant/screens/Wallet.webp) |
| M43 套餐与积分 · 已过期（假设 10-13 仍未续费） | [WalletExpired.dc.html](merchant/src/WalletExpired.dc.html) | [WalletExpired.webp](merchant/screens/WalletExpired.webp) |
| M44 选择套餐（含 M10 对公转账、付款结果） | [PlanPick.dc.html](merchant/src/PlanPick.dc.html) | [PlanPick.webp](merchant/screens/PlanPick.webp) |
| M45 加购积分 | [TopUp.dc.html](merchant/src/TopUp.dc.html) | [TopUp.webp](merchant/screens/TopUp.webp) |
| M46 积分明细 | [Ledger.dc.html](merchant/src/Ledger.dc.html) | [Ledger.webp](merchant/screens/Ledger.webp) |

### ⑦ 门店、成员与素材

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| M47 切换门店（弹层） | [StoreSwitch.dc.html](merchant/src/StoreSwitch.dc.html) | [StoreSwitch.webp](merchant/screens/StoreSwitch.webp) |
| M48 我的门店 | [Stores.dc.html](merchant/src/Stores.dc.html) | [Stores.webp](merchant/screens/Stores.webp) |
| M49 新增门店 | [StoreAdd.dc.html](merchant/src/StoreAdd.dc.html) | [StoreAdd.webp](merchant/screens/StoreAdd.webp) |
| M50 门店素材 | [AssetLib.dc.html](merchant/src/AssetLib.dc.html) | [AssetLib.webp](merchant/screens/AssetLib.webp) |
| M51 上传素材 | [AssetUpload.dc.html](merchant/src/AssetUpload.dc.html) | [AssetUpload.webp](merchant/screens/AssetUpload.webp) |
| M52 素材详情（录音） | [AssetDetail.dc.html](merchant/src/AssetDetail.dc.html) | [AssetDetail.webp](merchant/screens/AssetDetail.webp) |
| M53 门店成员 | [Members.dc.html](merchant/src/Members.dc.html) | [Members.webp](merchant/screens/Members.webp) |
| M54 邀请店员 | [Invite.dc.html](merchant/src/Invite.dc.html) | [Invite.webp](merchant/screens/Invite.webp) |
| M55 受邀者加入门店 | [Join.dc.html](merchant/src/Join.dc.html) | [Join.webp](merchant/screens/Join.webp) |
| M56 店员视角 · 商家档案 | [StaffProfile.dc.html](merchant/src/StaffProfile.dc.html) | [StaffProfile.webp](merchant/screens/StaffProfile.webp) |

## 运营管理后台

### ① 工作台与交付

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| 工作台 | [Main.dc.html](admin/src/Main.dc.html) | [Main.webp](admin/screens/Main.webp) |
| 交付 · 工单池 | [Tickets.dc.html](admin/src/Tickets.dc.html) | [Tickets.webp](admin/screens/Tickets.webp) |
| 交付 · 工单详情 | [TicketDetail.dc.html](admin/src/TicketDetail.dc.html) | [TicketDetail.webp](admin/screens/TicketDetail.webp) |
| 交付 · 广告制作任务 | [AdTasks.dc.html](admin/src/AdTasks.dc.html) | [AdTasks.webp](admin/screens/AdTasks.webp) |

### ② 成片与上线

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| 发布 · 成片交付 | [Delivery.dc.html](admin/src/Delivery.dc.html) | [Delivery.webp](admin/screens/Delivery.webp) |
| 发布 · 上线日历 | [Calendar.dc.html](admin/src/Calendar.dc.html) | [Calendar.webp](admin/screens/Calendar.webp) |
| 发布 · 链接核验 | [Verify.dc.html](admin/src/Verify.dc.html) | [Verify.webp](admin/screens/Verify.webp) |
| 发布 · 账号核验 | [Accounts.dc.html](admin/src/Accounts.dc.html) | [Accounts.webp](admin/screens/Accounts.webp) |

### ③ 逾期、巡检、下架与数据录入

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| 发布 · 逾期跟踪 | [Overdue.dc.html](admin/src/Overdue.dc.html) | [Overdue.webp](admin/screens/Overdue.webp) |
| 发布 · 作品巡检 | [Patrol.dc.html](admin/src/Patrol.dc.html) | [Patrol.webp](admin/screens/Patrol.webp) |
| 发布 · 下架核查 | [Offline.dc.html](admin/src/Offline.dc.html) | [Offline.webp](admin/screens/Offline.webp) |
| 发布 · 数据录入（V1.1） | [DataEntry.dc.html](admin/src/DataEntry.dc.html) | [DataEntry.webp](admin/screens/DataEntry.webp) |

### ④ 商家与订单

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| 商家 · 商家列表 | [Merchants.dc.html](admin/src/Merchants.dc.html) | [Merchants.webp](admin/screens/Merchants.webp) |
| 商家 · 商家详情 | [MerchantDetail.dc.html](admin/src/MerchantDetail.dc.html) | [MerchantDetail.webp](admin/screens/MerchantDetail.webp) |
| 商家 · 资质审核 | [Review.dc.html](admin/src/Review.dc.html) | [Review.webp](admin/screens/Review.webp) |
| 订单 · 订购单与付款单 | [Orders.dc.html](admin/src/Orders.dc.html) | [Orders.webp](admin/screens/Orders.webp) |
| 订单 · 订单详情 | [OrderDetail.dc.html](admin/src/OrderDetail.dc.html) | [OrderDetail.webp](admin/screens/OrderDetail.webp) |
| 订单 · 对公收款确认 | [Receipts.dc.html](admin/src/Receipts.dc.html) | [Receipts.webp](admin/screens/Receipts.webp) |
| 订单 · 套餐到期 | [Renewals.dc.html](admin/src/Renewals.dc.html) | [Renewals.webp](admin/screens/Renewals.webp) |

### ⑤ 短剧库与套餐积分

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| 短剧库 · 短剧列表 | [Dramas.dc.html](admin/src/Dramas.dc.html) | [Dramas.webp](admin/screens/Dramas.webp) |
| 短剧库 · 编辑短剧 | [DramaEdit.dc.html](admin/src/DramaEdit.dc.html) | [DramaEdit.webp](admin/screens/DramaEdit.webp) |
| 套餐与积分 · 套餐管理 | [Plans.dc.html](admin/src/Plans.dc.html) | [Plans.webp](admin/screens/Plans.webp) |
| 套餐与积分 · 积分包管理 | [PointPacks.dc.html](admin/src/PointPacks.dc.html) | [PointPacks.webp](admin/screens/PointPacks.webp) |
| 套餐与积分 · 积分价模板与参数 | [Params.dc.html](admin/src/Params.dc.html) | [Params.webp](admin/screens/Params.webp) |
| 套餐与积分 · 单剧积分价 | [Pricing.dc.html](admin/src/Pricing.dc.html) | [Pricing.webp](admin/screens/Pricing.webp) |
| 套餐与积分 · 积分账户与流水 | [PointAccounts.dc.html](admin/src/PointAccounts.dc.html) | [PointAccounts.webp](admin/screens/PointAccounts.webp) |

### ⑥ 客服工单

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| 客服 · 工单池 | [Service.dc.html](admin/src/Service.dc.html) | [Service.webp](admin/screens/Service.webp) |
| 客服 · 工单详情 | [ServiceDetail.dc.html](admin/src/ServiceDetail.dc.html) | [ServiceDetail.webp](admin/screens/ServiceDetail.webp) |

### ⑦ 财务管理

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| 财务 · 收款流水 | [Payments.dc.html](admin/src/Payments.dc.html) | [Payments.webp](admin/screens/Payments.webp) |
| 财务 · 退款管理 | [Refunds.dc.html](admin/src/Refunds.dc.html) | [Refunds.webp](admin/screens/Refunds.webp) |
| 财务 · 积分调整审批 | [CreditAdjust.dc.html](admin/src/CreditAdjust.dc.html) | [CreditAdjust.webp](admin/screens/CreditAdjust.webp) |
| 财务 · 发票管理 | [Invoices.dc.html](admin/src/Invoices.dc.html) | [Invoices.webp](admin/screens/Invoices.webp) |
| 财务 · 对账 | [Reconcile.dc.html](admin/src/Reconcile.dc.html) | [Reconcile.webp](admin/screens/Reconcile.webp) |
| 财务 · 服务商结算（V1.1） | [FinSettle.dc.html](admin/src/FinSettle.dc.html) | [FinSettle.webp](admin/screens/FinSettle.webp) |

### ⑧ 数据报表

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| 报表 · 经营概览 | [RptOverview.dc.html](admin/src/RptOverview.dc.html) | [RptOverview.webp](admin/screens/RptOverview.webp) |
| 报表 · 积分报表 | [RptPoints.dc.html](admin/src/RptPoints.dc.html) | [RptPoints.webp](admin/screens/RptPoints.webp) |
| 报表 · 短剧销售排行（V1.1） | [RptDramas.dc.html](admin/src/RptDramas.dc.html) | [RptDramas.webp](admin/screens/RptDramas.webp) |
| 报表 · 交付效率（V1.1） | [RptDelivery.dc.html](admin/src/RptDelivery.dc.html) | [RptDelivery.webp](admin/screens/RptDelivery.webp) |
| 报表 · 广告制作（V1.1） | [RptAds.dc.html](admin/src/RptAds.dc.html) | [RptAds.webp](admin/screens/RptAds.webp) |
| 报表 · 客服报表（V1.1） | [RptService.dc.html](admin/src/RptService.dc.html) | [RptService.webp](admin/screens/RptService.webp) |
| 报表 · 服务商业绩（V1.1） | [RptPartners.dc.html](admin/src/RptPartners.dc.html) | [RptPartners.webp](admin/screens/RptPartners.webp) |

### ⑨ 内容运营

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| 运营 · 首页配置 | [OpsHome.dc.html](admin/src/OpsHome.dc.html) | [OpsHome.webp](admin/screens/OpsHome.webp) |
| 运营 · 商城配置 | [OpsMall.dc.html](admin/src/OpsMall.dc.html) | [OpsMall.webp](admin/screens/OpsMall.webp) |
| 运营 · 协议管理 | [OpsAgreements.dc.html](admin/src/OpsAgreements.dc.html) | [OpsAgreements.webp](admin/screens/OpsAgreements.webp) |
| 运营 · 消息模板 | [OpsTemplates.dc.html](admin/src/OpsTemplates.dc.html) | [OpsTemplates.webp](admin/screens/OpsTemplates.webp) |
| 运营 · 公告与常见问题（V1.1） | [OpsNotice.dc.html](admin/src/OpsNotice.dc.html) | [OpsNotice.webp](admin/screens/OpsNotice.webp) |

### ⑩ 系统设置

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| 系统 · 员工账号 | [SysStaff.dc.html](admin/src/SysStaff.dc.html) | [SysStaff.webp](admin/screens/SysStaff.webp) |
| 系统 · 角色权限 | [SysRoles.dc.html](admin/src/SysRoles.dc.html) | [SysRoles.webp](admin/screens/SysRoles.webp) |
| 系统 · 数据字典 | [SysDict.dc.html](admin/src/SysDict.dc.html) | [SysDict.webp](admin/screens/SysDict.webp) |
| 系统 · 参数配置 | [SysParams.dc.html](admin/src/SysParams.dc.html) | [SysParams.webp](admin/screens/SysParams.webp) |
| 系统 · 操作日志 | [SysLogs.dc.html](admin/src/SysLogs.dc.html) | [SysLogs.webp](admin/screens/SysLogs.webp) |

### ⑪ 渠道管理（V1.1）

| 画板 | 源码 | 截图 |
| --- | --- | --- |
| 渠道 · 服务商列表（V1.1） | [Partners.dc.html](admin/src/Partners.dc.html) | [Partners.webp](admin/screens/Partners.webp) |
| 渠道 · 入驻审核（V1.1） | [PartnerReview.dc.html](admin/src/PartnerReview.dc.html) | [PartnerReview.webp](admin/screens/PartnerReview.webp) |
| 渠道 · 等级与返佣（V1.1） | [PartnerLevels.dc.html](admin/src/PartnerLevels.dc.html) | [PartnerLevels.webp](admin/screens/PartnerLevels.webp) |
| 渠道 · 商家归属（V1.1） | [PartnerBinding.dc.html](admin/src/PartnerBinding.dc.html) | [PartnerBinding.webp](admin/screens/PartnerBinding.webp) |
| 渠道 · 结算单（V1.1） | [PartnerSettle.dc.html](admin/src/PartnerSettle.dc.html) | [PartnerSettle.webp](admin/screens/PartnerSettle.webp) |

## 原型更新后怎么同步

1. 从在线原型取回各画板的源码与 `canvas.json`，覆盖对应的 `src/` 目录。
2. 取回原型自带的运行时文件 `artifact-type/dc-runtime.js`，放在本机任意位置。运行时不随仓库保存。
3. 重新生成截图（需要本机装有 Google Chrome，Node 22 及以上）：

```bash
node design/prototype/scripts/snapshot.mjs <dc-runtime.js 的路径>
```

4. 更新本文件“来源”表里的版本号与快照日期；样式有变化时同步更新设计规范与样式变量。
