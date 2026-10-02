# 狸有戏 · 运营管理后台组件规格（从原型源码提取）

> 依据：`prototype/admin/src/*.dc.html`（56 个画板，1440×900）、`stats.json`、`prototype/admin/screens/*.webp`、PRD 8.3。
> 方法：对全部画板的内联样式做“完整样式串”去重计数（下文“N 板”= 出现该样式的画板数），再读代表画板核对。
> 约定：**【源码】**= 数值照抄源码；**【归纳】**= 我对多处写法的合并；**【建议】**= 落地意见，需确认。
> 原型没有任何 hover / focus / 过渡动画（56 个文件 `transition|animation` 计数均为 0，全局只有 `a:hover{color:inherit}`，输入框 `outline: none`），交互态全部需要补设计。

## 0. 基础色与字（后文引用）

| 角色 | 值 | 依据（admin 统计） |
|---|---|---|
| 页面底色 | `#F6F3EE` | 根容器与 body，56 板 |
| 容器底色 | `#FFFFFF` | background 560 次 |
| 主文字 | `#1D1A16` | 根容器 color；color 685 次 |
| 次文字 | `#6F665B` | color 1447 次 |
| 弱文字 / 禁用字 | `#9A9084` / `#C9C1B6` | 侧栏副标题、V1.1 角标 / 分页禁用箭头 |
| 品牌主色（实心底） | `#C4501B` | background 245 次（主按钮、菜单选中、页签下划线） |
| 品牌文字色（链接） | `#A63F12` | color 205 次 |
| 品牌浅底 | `#FBEDE5`、`#FFF8F3` | 头像底、选中卡片底 |
| 卡片描边 / 分隔线 | `#ECE6DD` | border 431 次 |
| 输入框描边 | `#E7E1D8` | border 277 次 |
| 表格行分隔 | `#F0EBE3` | border 170 次 |
| 按钮描边 | `#DDD5C9` | border 126 次 |
| 表头 / 浅填充 | `#FAF8F4`、`#F3EFE9`、`#EFEBE4` | 表头底、中性提示、分段控件轨道 |
| 禁用按钮底 / 关闭态开关 | `#D6CFC4` / `#CFC7BC` | script 三元表达式 18 / 40 处 |
| 正文字体 | `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif` | 根容器，56 板 |
| 标题 / 大数字字体 | `'Noto Serif SC', serif`（Google Fonts 加载 600;700;900） | h1、指标数字、品牌字 |
| 字号 | 13px（1666 次）、12px（1393）、14px（1219）、24px（h1）、18/16/15px（h2） | 根容器声明 `font-size: 14px` |
| 圆角 | 8px（1674 次，控件）、12px（卡片）、10px（子卡 / 队列项）、14px（对话框）、6px（小按钮） | |

## 1. 整体框架

根容器【源码】`Merchants.dc.html` L17：`width: 1440px; height: 900px; display: flex; overflow: hidden; position: relative; background: #F6F3EE; color: #1D1A16; font-size: 14px`。56 板完全一致。

### 1.1 侧栏（56 板一致，`Merchants.dc.html` L18–41）

| 部位 | 规格【源码】 |
|---|---|
| 容器 | `width: 216px; background: #231F1B; color: #D9D1C5`，纵向 flex，不可折叠 |
| 品牌区 | `height: 64px; padding: 0 20px; gap: 10px; border-bottom: 1px solid #3A332C`；图标 30×30 描边 `#E8864F` 线宽 3；“狸有戏”`Noto Serif SC 19px / 900 / letter-spacing 3px / line-height 1.1 / #FFFFFF`；“运营管理后台”`12px / line-height 1.2 / #9A9084` |
| 菜单容器 | `padding: 12px 10px; gap: 2px; overflow-y: auto` |
| 一级项 | `min-height: 36px; padding: 0 10px 0 12px; border-radius: 8px; gap: 10px; font-size: 14px; color: #E9E2D8`；图标 18×18、`stroke-width 1.8`、`currentColor`；右侧箭头 14×14 线宽 2（收起朝右、展开朝下） |
| 展开中的父级 | 同尺寸，无底色，`font-weight: 600; color: #FFFFFF`（51 板） |
| 二级项 | `min-height: 32px; padding: 0 10px 0 40px; border-radius: 8px; font-size: 13px; color: #E9E2D8; justify-content: space-between` |
| 选中态 | 二级：`background: #C4501B; color: #FFFFFF; font-weight: 600`（50 板）；无子级的一级（工作台、短剧库、客服）：同底色，`14px / 600`（5 板：Main、Dramas、DramaEdit、Service、ServiceDetail） |
| 数字角标 | `min-width: 20px; height: 18px; padding: 0 6px; border-radius: 9px; background: #E8864F; color: #231F1B; font-size: 12px; font-weight: 700; line-height: 1`；位于选中项上时改 `background: #FFFFFF; color: #A63F12`（17 板） |
| V1.1 角标 | `height: 18px; padding: 0 5px; border: 1px solid #5A5047; border-radius: 4px; font-size: 11px; line-height: 16px; color: #9A9084`；选中项上 `border: 1px solid rgba(255, 255, 255, 0.7); color: #FFFFFF`（8 板） |
| 分组标题 | **源码没有**。菜单是 13 个一级项平铺：工作台、短剧库、套餐与积分、商家、订单、交付、发布、客服、财务、报表、运营、系统、渠道（V1.1） |
| 底部信息 | **源码没有**。`<nav>` 在菜单列表后直接结束，没有版本号、退出、折叠按钮 |

【归纳】手风琴行为：截图中同一时刻只展开当前所在分组；详情页（MerchantDetail、TicketDetail、OrderDetail）保持其父列表的二级项为选中（见 `TicketDetail.webp` 的“工单池”）。

### 1.2 顶栏（56 板一致，`Merchants.dc.html` L42–48）

| 部位 | 规格【源码】 |
|---|---|
| 容器 | `height: 56px; padding: 0 24px; gap: 16px; background: #FFFFFF; border-bottom: 1px solid #ECE6DD` |
| 面包屑 | `gap: 6px; font-size: 13px; color: #6F665B`，分隔符为文本“/”，末级 `color: #1D1A16; font-weight: 600`；最多三级（“商家 / 商家列表 / 商家详情”） |
| 全局搜索 | `margin-left: auto; width: 300px; height: 36px; padding: 0 12px; border: 1px solid #E7E1D8; border-radius: 8px; background: #FAF8F4; gap: 8px`；图标 16×16 线宽 2；输入 `font-size: 13px`；占位“搜索商家、订单号、工单号” |
| 通知 | 按钮 `40×40; border-radius: 8px; background: transparent`；铃铛 20×20 线宽 1.8；未读点 `top: 8px; right: 9px; 8×8; border: 2px solid #FFFFFF; background: #C4501B` |
| 用户 | `padding-left: 16px; border-left: 1px solid #ECE6DD; gap: 10px`；头像 `32×32; border-radius: 16px; background: #FBEDE5; color: #A63F12; 14px / 700`（取姓氏首字）；姓名 `14px / 600 / line-height 1.3`；角色 `12px / line-height 1.3 / #6F665B` |

搜索结果、通知面板、用户下拉均无画板。

### 1.3 内容区与页头

| 部位 | 规格【源码】 | 出现 |
|---|---|---|
| `<main>` | `padding: 20px 24px 24px; gap: 16px; overflow-y: auto`，纵向 flex；可用宽 1224，内容宽 1176 | 55 板 |
| 页头行 | `display: flex; align-items: flex-end; justify-content: space-between; gap: 24px` | 37 板 |
| 页标题 h1 | `font-family: 'Noto Serif SC', serif; font-size: 24px; font-weight: 700; line-height: 1.3; margin: 0` | 56 板 |
| 副标题 | `font-size: 13px; color: #6F665B`，与标题间距 `gap: 4px`；允许内嵌强调（`color: #B42318; font-weight: 600`，见 Service） | 56 板 |
| 页头右侧 | 操作按钮（高 36）、行内统计（见 1.4）、月份切换器、岗位分段控件 | |
| 标题旁状态 | `height: 24px; padding: 0 10px; border-radius: 12px; font-size: 13px; font-weight: 600`（TicketDetail、MerchantDetail）；V1.1 页用描边标签 `height: 22px; padding: 0 8px; border: 1px solid #DDD5C9; border-radius: 11px; 12px / 600 / #6F665B`，文案“V1.1”（13 板） | |
| V1.1 说明条 | `padding: 6px 12px; border-radius: 8px; background: #F3EFE9; font-size: 12px; line-height: 1.6; color: #5E564C`，文案“本页为 V1.1 功能设计，页面数据为示例数据…” | 13 板 |
| 页脚注释 | `font-size: 12px; line-height: 1.7; color: #6F665B`，每句一个 `display: block` 的 span | 26 板 |

### 1.4 指标卡

| 变体 | 规格【源码】 | 画板 |
|---|---|---|
| 报表指标卡（主流） | 卡 `padding: 14px 18px; border: 1px solid #ECE6DD; border-radius: 12px; background: #FFFFFF; gap: 2px`；标签 `13px #6F665B`；数字 `Noto Serif SC 24px / 700 / line-height 1.3`；辅助行 `12px #6F665B`，环比向好用 `#256A42` | Overdue、Payments、Reconcile、RptAds、RptDelivery、RptDramas、RptPartners、RptPoints、RptService（38 张卡） |
| 工作台指标卡 | `padding: 16px 20px; gap: 4px`；数字 `28px / 700 / line-height 1.25`；容器 `grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px` | Main |
| 经营概览 | `repeat(7, …); gap: 12px`；卡 `padding: 12px 14px`；数字 `22px`；首卡强调 `border: 1px solid #F0C9B3; background: #FFF8F3` | RptOverview |
| 详情页指标卡 | `padding: 12px 16px`；数字 24px；`repeat(5, …)` | MerchantDetail |
| 待办卡（可点） | `min-height: 92px; padding: 12px; border: 1px solid #F0EBE3; border-radius: 10px; background: #FAF8F4; gap: 2px`；数字 `26px / 700`；异常辅助行 `12px / 600 / #B42318`；`repeat(5, …); gap: 12px` | Main |
| 页头行内统计 | `<dl style="display: flex; gap: 28px">`；`dt 12px #6F665B`；`dd 16px / 700 / tabular-nums`，单位 `12px / 400 / #6F665B / margin-left 6px` | CreditAdjust、Invoices、Plans、PointAccounts、PointPacks、Refunds 等 8 板 |

## 2. 筛选表格页

代表画板：Merchants、Orders、Tickets、Service、Dramas、Payments、Reconcile、PointAccounts、Pricing、PartnerBinding、SysLogs、SysStaff。带页签的列表：Tickets、Service、CreditAdjust、FinSettle、OpsNotice、PartnerBinding、PartnerReview、Renewals、RptDramas。

| 部位 | 规格【源码】 |
|---|---|
| 表格卡 | `border: 1px solid #ECE6DD; border-radius: 12px; background: #FFFFFF; overflow: hidden`，纵向 flex（45 板）。页签、筛选条、表格、分页都在同一张卡内，无阴影 |
| 页签条 | `display: flex; gap: 4px`（12 板）或 `2px`（7 板）；`padding: 0 12px; border-bottom: 1px solid #ECE6DD` |
| 页签 | `min-height: 46px; padding: 0 10px; font-size: 14px; border-bottom: 2px solid`；选中 `线 #C4501B / 字 #1D1A16 / 600`，未选 `线 transparent / 字 #6F665B / 400`（35 个脚本里同一份 `tab()` 定义，如 `Merchants.dc.html` L89） |
| 页签计数 | `min-width: 20px; padding: 1px 6px; border-radius: 10px; font-size: 12px; font-weight: 600; line-height: 16px`；选中 `#FBEDE5 / #A63F12`，未选 `#F3EFE9 / #6F665B` |
| 筛选条 | `display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid #ECE6DD`（8 板）；Merchants 为 `flex-wrap: wrap; gap: 8px; padding: 14px 16px` |
| 搜索框 | `width: 196px`（Merchants）/ `230px`（Service）；`height: 36px; padding: 0 10px; border: 1px solid #E7E1D8; border-radius: 8px`；图标 16×16；白底（顶栏搜索才是 `#FAF8F4`） |
| 下拉 | 原生 `<select>`：`height: 36px; padding: 0 8px; border: 1px solid #E7E1D8; border-radius: 8px; background: #FFFFFF; font-size: 13px`（13 板 38 处）；“全部”即默认项，如“全部区域” |
| 分段控件 | 轨道 `display: inline-flex; padding: 3px; border-radius: 8px; background: #EFEBE4; gap: 2px`；项 `min-height: 30px; padding: 0 12px; border-radius: 6px; font-size: 13px`；选中 `#FFFFFF / #1D1A16 / 600`，未选 `transparent / #6F665B / 400`（OpsHome、PartnerSettle、PointAccounts、SysLogs） |
| 胶囊单选 | `min-height: 32px; padding: 0 14px; border-radius: 16px; border: 1px solid; font-size: 13px`；选中 `边 / 底 #1D1A16、字 #FFFFFF`，未选 `边 #E7E1D8、底 #FFFFFF、字 #1D1A16`（7 板 12 处） |
| 勾选筛选 | `<input type="checkbox">` `16×16; accent-color: #C4501B` + 13px 文案（“仅看响应超时”） |
| 重置 | 文字按钮 `margin-left: auto; min-height: 36px; padding: 0 12px; background: transparent; color: #A63F12; font-size: 13px` |
| 表格结构 | 不是 `<table>`，是 `role="table"` 的 div + 每行 `display: grid; grid-template-columns: …; column-gap: 12px; align-items: center`，列宽写死 px、仅一列 `minmax(0, 1fr)` |
| 表头 | `min-height: 40px; padding: 0 16px; background: #FAF8F4; border-bottom: 1px solid #ECE6DD; font-size: 12px; font-weight: 600; color: #6F665B`（25 板）；数值列 `text-align: right` |
| 数据行 | `font-size: 13px; border-bottom: 1px solid #F0EBE3`；内边距 `4px 16px`（23 处）/ `6px 16px`（15 处）/ `8px 16px`（7 处）；`min-height` 42（12 处）、40（10）、58（9）、52（7）、54（6）等 16 种 |
| 斑马纹 | **无**。只有行分隔线 `#F0EBE3` |
| 行强调 | 超时 / 异常行 `background: #FFF7F5`（Tickets `rowBg: r.lv === 2 ? '#FFF7F5' : '#FFFFFF'`、Service、Reconcile）；可点行的选中态 `background: #FFF8F3; box-shadow: inset 3px 0 0 #C4501B`（PartnerSettle、SysLogs、Partners、OpsTemplates） |
| 单元格 | 双行：`flex-direction: column; gap: 2px`，主行 13px（名称 `font-weight: 600`），副行 `12px #6F665B`；数值 `text-align: right; font-variant-numeric: tabular-nums`；截断 `white-space: nowrap; overflow: hidden; text-overflow: ellipsis` |
| 时效文字 | 三档：`#B42318`（已超时）/ `#A63F12`（今天到期）/ `#1D1A16`，前两档 `font-weight: 600`（Tickets `dueColor`） |
| 操作列 | 末列，文字链 `color: #A63F12`，`min-height: 30px`（11 处）；危险操作 `#B42318`；行内主按钮 `min-height: 30px; padding: 0 12px; border-radius: 6px; background: #C4501B; 13px / 600`（Tickets 的“分配”，3 板）；表头“操作”的对齐不统一（Merchants 右对齐，Service、Tickets 左对齐） |
| 分页 | 容器 `padding: 10px 16px; font-size: 13px; color: #6F665B; justify-content: space-between`；左“共 N 条 · 每页 10 条”；右：上一页 / 下一页 `30×30; border: 1px solid #ECE6DD; border-radius: 6px`（不可用 `color: #C9C1B6`），当前页 `30×30; border-radius: 6px; background: #1D1A16; color: #FFFFFF; font-weight: 600`，后跟“/ N 页”。11 板：Dramas（每页 12）、MerchantDetail、Merchants、Orders、PartnerBinding、Payments、PointAccounts、Pricing、Reconcile、Service、Tickets |
| 导出按钮 | `min-height: 36px; padding: 0 14px`（10 板）或 `0 16px`（Merchants、Service 等）；`border: 1px solid #DDD5C9; border-radius: 8px; background: #FFFFFF; font-size: 14px; gap: 6px`；下载图标 16×16 线宽 1.8；位于页头右侧 |
| 空状态 | `padding: 56px 24px; gap: 8px; text-align: center`；标题 `15px / 600`（“没有符合条件的商家”），说明 `13px #6F665B`（“可调整筛选条件后再试”）；无插图（14 板） |
| 卡内注释 | `padding: 10px 16px 12px; font-size: 12px; line-height: 1.7; color: #6F665B`（7 板） |

**行详情侧栏**（列表 + 右侧固定宽详情，点行切换）：外层 `display: flex; gap: 16px; align-items: flex-start`；右栏 `width: 372px`（Partners、PartnerSettle）/ `360px`（SysLogs）/ `380px`（OpsTemplates）；`padding: 18px; gap: 14px`；标题 `15px / 600`。

## 3. 队列工作台（左队列 + 右详情）

出现在 9 个画板：Accounts、AdTasks、Delivery、Invoices、Offline、Receipts、Refunds、Review、Verify。截图参考 `Review.webp`、`Refunds.webp`。

| 部位 | 规格【源码】 |
|---|---|
| 外层 | `display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 16px; align-items: start`（Accounts、Delivery、Invoices、Refunds）；另 5 板左列为 `360px` |
| 左卡 | 标准表格卡 + 页签条（“待审核 4 / 今日已审核 0”，计数直接拼在文字后，不用计数徽标） |
| 队列列表 | `<ul style="margin: 0; padding: 8px; list-style: none; gap: 6px">`（9 板一致） |
| 队列项 | `<button>`：`width: 100%; padding: 12px; border-radius: 10px; text-align: left; gap: 5px`，纵向三行；默认 `border: 1px solid #F0EBE3; background: #FFFFFF` |
| 队列项选中 | `border: 2px solid #C4501B; background: #FFF8F3`（7 板）；Invoices、Refunds 为 `1.5px solid #C4501B` |
| 队列项内容 | 第 1 行：名称 `14px / 600` + 右侧标签 `padding: 1px 8px; border-radius: 10px; 12px / 600`（底 / 字按状态）或金额；第 2 行 `13px`；第 3 行 `12px #6F665B` |
| 队列空态 | `padding: 48px 16px; text-align: center; font-size: 13px; color: #6F665B`（8 板） |
| 右详情卡 | `padding: 20px; border: 1px solid #ECE6DD; border-radius: 12px; background: #FFFFFF; gap: 16px` |
| 详情页头 | 左：h2 `18px / 600` + 说明 `13px #6F665B`（`gap: 4px`）；右：状态胶囊 `padding: 3px 10px; border-radius: 12px; 13px / 600`（8 板） |
| 详情分区 | 内层再分栏：`grid-template-columns: 330px minmax(0, 1fr); gap: 24px`（Delivery）、`240px …; gap: 20px`（Review）、`220px`（Receipts）、`210px`（Accounts）；分区标题 h3 `14px / 600`；子卡 `padding: 14px 16px; border: 1px solid #F0EBE3; border-radius: 10px; gap: 10px`；记录块 `padding: 12px 16px; border-radius: 10px; background: #FAF8F4` |
| 核对清单（可勾） | `<fieldset>` + `<legend>` `14px / 600`，后缀“（n/4）”`400 / #6F665B`；每项 `<label>`：`min-height: 40px; padding: 6px 10px; border: 1px solid; border-radius: 8px; gap: 10px; font-size: 13px`；未勾 `边 #F0EBE3 / 底 #FFFFFF`，已勾 `边 #B9DCC5 / 底 #F4FAF6`（Delivery L208–209、Verify L218–219）；复选框 `accent-color: #256A42`，16px（Delivery、Patrol）或 18px（Offline、Verify） |
| 质检清单（只读） | `<ul>` `border: 1px solid #F0EBE3; border-radius: 10px`；项 `min-height: 38px; padding: 6px 12px; border-bottom: 1px solid #F0EBE3; 13px`；结果文字 `600 / #256A42`（TicketDetail） |
| 底部操作条 | `display: flex; align-items: center; justify-content: flex-end; gap: 10px`，在详情卡内最后一行，不吸底；左侧提示 `margin-right: auto; 12px`（普通 `#6F665B`，阻断原因 `#B42318`） |
| 操作按钮 | 高 40。次要 `border: 1px solid #DDD5C9; background: #FFFFFF; padding: 0 16px 或 18px`；驳回 `border: 1px solid #E8B4AE; color: #B42318; font-weight: 600`（6 板）；通过 `#FFFFFF 字 / 600`，底色 `#256A42`（Accounts、Offline、Receipts、Verify）或 `#C4501B`（Review、Delivery、AdTasks、Invoices、Refunds）；未满足条件时 `background: #D6CFC4` + `disabled` |
| 处理结果条 | 处理后操作条换成 `padding: 10px 12px; border-radius: 8px; 13px; line-height: 1.6`，通过 `#E5F1E9 / #256A42`，驳回 `#FBE9E7 / #B42318` |

## 4. 详情页

画板：MerchantDetail（11 个页签）、TicketDetail（5 个页签 + 进度条）、OrderDetail、ServiceDetail、DramaEdit。

| 部位 | 规格【源码】 |
|---|---|
| 页头 | h1 + 状态胶囊（24 高，见 1.3）+ 属性胶囊 `background: #F3EFE9; color: #5E564C; 13px`；下方说明 `13px #6F665B`；右侧操作按钮高 40（TicketDetail）/ 44（MerchantDetail）。MerchantDetail 另有头像块 `56×56; border-radius: 14px; background: #C4501B; Noto Serif SC 26px / 700 白字` 与负责人卡 `min-height: 44px; padding: 4px 6px 4px 8px; border: 1px solid #ECE6DD; border-radius: 10px` |
| 主次分栏 | `grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start`（TicketDetail、DramaEdit）；OrderDetail 右栏 `340px` |
| 侧栏信息卡 | `padding: 14px 16px; border: 1px solid #ECE6DD; border-radius: 12px; gap: 8px`；标题 h2 `14px / 600`；右上链接“商家详情 ›”`13px #A63F12` |
| 多页签 | 与列表页签同一规格；面板 `padding: 20px`（TicketDetail）/ `18px 20px 20px`（MerchantDetail）；页签内计数 `min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: #F3EFE9; color: #5E564C; 12px / 600`；未开放页签 `color: #B3AA9E` + V1.1 描边角标，不可点 |
| 信息分组（dl） | `display: grid; grid-template-columns: <标签宽> minmax(0, 1fr)`；`dt color: #6F665B`、`dd margin: 0`。最常见：标签宽 64px、`row-gap: 8px; column-gap: 12px; font-size: 13px`（7 板）。主档案用大号：`84px / row-gap 12px / column-gap 16px / 14px / line-height 1.5`（MerchantDetail）、`110px`（TicketDetail）、`132px`（DramaEdit）。均为“一列标签 + 一列值”，多列靠外层 `repeat(2, minmax(0, 1fr)); gap: 12px` 并排两个 dl（8 板） |
| 强调值 | `dd font-weight: 600; color: #A63F12`（截止时间）；金额 `16px / 700` |
| 进度条（步骤） | TicketDetail L63：`<ol style="display: flex">` 11 步等分。节点 `28×28; border-radius: 14px; 13px / 700`：已完成 `background: #256A42` 白色对勾；当前 `background: #C4501B; box-shadow: 0 0 0 4px #FBEDE5`；未到 `background: #FFFFFF; border: 1.5px solid #D6CFC4; color: #6F665B`。连线 `top: 13px; height: 2px`，已过 `#256A42`、未到 `#E7E1D8`。名称 13px（当前 `600 / #A63F12`，已完成 `#1D1A16`，未到 `#6F665B`）；时间 `12px tabular-nums` |
| 时间线 / 操作日志 | 不是圆点竖线式，是三列行表：`<li style="display: grid; grid-template-columns: 96px 72px minmax(0, 1fr); gap: 12px; align-items: baseline; padding: 9px 0; border-bottom: 1px solid #F0EBE3; font-size: 13px">`，时间 `#6F665B tabular-nums`、操作人 `600`、内容（MerchantDetail、TicketDetail）。抽屉内简化为两列 `92px minmax(0, 1fr); line-height: 1.6`（Orders） |
| 并排比对表 | 外框 `border: 1px solid #F0EBE3; border-radius: 10px; overflow: hidden`；表头 `min-height: 36px; padding: 0 12px; background: #FAF8F4; 12px / 600 / #6F665B`；行 `min-height: 42px; padding: 6px 12px; border-top: 1px solid #F0EBE3; 13px`；异常行 `background: #FFF7F5`；比对结论列 `font-weight: 600`，一致 `#256A42`、不一致 `#B42318`。列：Review `120px 1fr 120px`（字段 / OCR 识别结果 / 系统比对）；Accounts `84px 1fr 1fr 84px`；Receipts `84px 1fr 1fr 110px` |
| 变更前后 | `repeat(2, minmax(0, 1fr)); gap: 8px`；块 `padding: 10px 12px; border-radius: 8px`；变更前 `#FBE9E7` + 标签 `12px #B42318`，变更后 `#E5F1E9` + `#256A42`（SysLogs） |

## 5. 表单与弹层

| 组件 | 规格【源码】 | 画板 |
|---|---|---|
| 字段结构 | 标签 `13px / 600`，与控件 `gap: 6px`；字段间 `gap: 14px`；两列 `repeat(2, minmax(0, 1fr)); gap: 12px`；标签在上，无必填星号 | SysStaff、DramaEdit |
| 输入框 | `height: 38px; padding: 0 10px; border: 1px solid #E7E1D8; border-radius: 8px; font-size: 13px; color: #1D1A16`（表单，12 板）；筛选条与队列详情内为 `height: 36px` | DramaEdit、MerchantDetail、OpsHome |
| 数值输入 | `height: 32px; padding: 0 8px; text-align: right; tabular-nums`；校验失败 `border: #B42318`（`Params.dc.html` L132） | Params、SysParams |
| 下拉 | `height: 36px; padding: 0 8px`（表单内 4 板为 38px） | 27 板 |
| 多行输入 | `width: 100%; padding: 8px 10px; border: 1px solid #E7E1D8; border-radius: 8px; 13px; resize: none`；`line-height: 1.6`（16 板）或 `1.5`（15 板）；字数 `n/200` 放在标签行右侧 `400 / #6F665B` | 29 板 |
| 只读值 | `height: 38px; padding: 0 10px; border-radius: 8px; background: #F3EFE9; 13px` | SysStaff |
| 提示 / 错误 | 提示 `12px #6F665B`；错误 `role="alert"`，`13px #B42318`（24 板）或 `12px`（12 板），位于控件下方或按钮行左侧 | |
| 复选框 | 原生控件 `accent-color: #C4501B`；16px（10 板）、18px（10 板）、14px（7 板） | |
| 带框勾选行 | `min-height: 40px; padding: 8px 12px; border: 1px solid #E7E1D8; border-radius: 10px; gap: 10px; 13px` + 18px 复选框 | SysStaff、Plans、Overdue、OpsNotice、OpsAgreements、Dramas、FinSettle（7 板） |
| 原因单选 | `<label>` 内含原生 radio（14px）：`min-height: 38px; padding: 0 14px; border-radius: 19px; gap: 6px; 13px`；选中 `border: 2px solid #C4501B; background: #FFF8F3`，未选 `1px solid #E7E1D8 / #FFFFFF` | Accounts、Receipts、Review、Refunds、Invoices |
| 多选标签 | `min-height: 32px; padding: 0 12px; border-radius: 16px; border: 1px solid; 13px`；选中 `边 #C4501B / 底 #FFF8F3 / 字 #A63F12`，未选 `边 #E7E1D8 / 底 #FFFFFF / 字 #1D1A16`（L632，与胶囊单选的深色选中不同） | MerchantDetail |
| 开关 | `width: 36px; height: 20px; border-radius: 10px`；开 `#256A42`、关 `#CFC7BC`；滑块 `16×16; top: 2px; left: 18px / 2px; background: #FFFFFF; box-shadow: 0 1px 2px rgba(29, 26, 22, 0.25)`（35 个脚本同一份 `sw()`） | OpsAgreements、OpsMall、OpsTemplates、SysDict |
| 上传区 | `<button>`：`width: 100%; height: 64px; border: 1px dashed #D9D1C6; border-radius: 10px; background: #FAF8F4; gap: 8px; 13px`（FinSettle 为 56px）；品牌色变体 `border: 1px dashed #D9A08A; background: #FFF8F3; color: #A63F12`（DramaEdit）。原型没有 `type="file"`，也没有进度、失败、预览态 | DataEntry、DramaEdit、OpsAgreements、FinSettle |
| 按钮 | 圆角 8、字号 14。主按钮 `background: #C4501B; color: #FFFFFF; font-weight: 600; border: none`；次按钮 `border: 1px solid #DDD5C9; background: #FFFFFF; color: #1D1A16`（字重常规）；危险实心 `#B42318`；危险描边 `border: 1px solid #E8B4AE; color: #B42318`；文字按钮 `color: #A63F12; 13px`。高度：页头 36、对话框与详情操作 40；内边距 `0 16px`（36 高）/ `0 18px`（40 高）。图标按钮 `32×32; border-radius: 8px; background: #F6F3EE`（关闭 ×，34 板） | |

### 弹层

| 组件 | 规格【源码】 |
|---|---|
| 遮罩 | `position: absolute; inset: 0; z-index: 10; background: rgba(29, 26, 22, 0.45)`，内容居中（33 板 50 处） |
| 对话框 | `padding: 24px; border-radius: 14px; background: #FFFFFF; gap: 16px; box-shadow: 0 24px 48px rgba(29, 26, 22, 0.24)`；长内容加 `max-height: 820px; overflow-y: auto`。宽度：520（14 处）、560（11）、500（8）、540（7）、480（3）、580 / 600 / 640（各 2）、680（1） |
| 对话框头 | 左：h2 `18px / 600` + 说明 `13px / line-height 1.6 / #6F665B`（`gap: 4px`）；右：32×32 关闭按钮。无分隔线 |
| 对话框底 | `display: flex; justify-content: flex-end; gap: 10px`；取消（次按钮）在左、确认在右，均 `min-height: 40px; padding: 0 18px`。无分隔线 |
| 抽屉 | 仅 `Orders.dc.html` L97：遮罩 `rgba(29, 26, 22, 0.35)`，右对齐；面板 `width: 480px; height: 100%; padding: 24px; gap: 16px; box-shadow: -12px 0 32px rgba(29, 26, 22, 0.18)`，无圆角；头部同对话框；内含金额块 `padding: 14px 16px; border-radius: 12px; background: #FFF8F3`（数字 `Noto Serif SC 26px / 700`） |
| 二次确认 | `Refunds.dc.html` L151，宽 500。①回显：`<dl>` `padding: 12px 14px; border-radius: 10px; background: #FAF8F4; grid 72px 1fr; row-gap: 6px; column-gap: 12px; 13px`，关键金额 `16px / 700 / #A63F12`；②强制勾选：`min-height: 40px; padding: 8px 12px; border-radius: 10px`，未勾 `边 #F0EBE3 / 底 #FFFFFF`，已勾 `边 #B9DCC5 / 底 #F4FAF6`，18px 复选框；③确认按钮未勾选时 `background: #D6CFC4` + `disabled`，勾选后 `#C4501B`。同样的勾选确认配色（`#B9DCC5` / `#F4FAF6`）还出现在 CreditAdjust、Reconcile、Receipts 的脚本里 |
| 驳回弹层 | `Review.dc.html` L127（宽 540）、`Refunds.dc.html` L173（宽 560）：说明文字 + 原因单选（见上）+“说明”多行输入 + 错误提示“请选择驳回原因并填写说明”+ 确认按钮 `background: #B42318` |
| Toast | `position: absolute; top: 68px; right: 24px; z-index: 5; max-width: 540px; padding: 10px 8px 10px 14px; border-radius: 10px; background: #1D1A16; color: #FFFFFF; gap: 10px; font-size: 13px; box-shadow: 0 8px 24px rgba(29, 26, 22, 0.18)`；左对勾 16×16 `stroke: #7FD19B` 线宽 2.4；右关闭 `28×28; border-radius: 6px`（55 板，Main 没有）。只有成功一种样式 |

## 6. 状态标签、徽标、提示条配色

### 6.1 色调（六组，PRD 8.3 第 4 条：成功绿、进行中蓝、待处理橙、失效或错误红、已结束灰）

| 色调 | 底 / 字【源码】 | 映射表出现 | 含义【归纳】 |
|---|---|---|---|
| 绿 | `#E5F1E9` / `#256A42` | 27 处 16 板 | 成功、生效、已完成 |
| 蓝 | `#E8EEF8` / `#2E5AAC` | 26 处 16 板 | 进行中、等待对方 |
| 橙 | `#FBEDE5` / `#A63F12` | 22 处 15 板 | 待我方处理、需关注 |
| 灰 | `#EFEBE4` / `#5E564C` | 25 处 13 板 | 已结束、中性类别 |
| 红 | `#FBE9E7` / `#B42318` | 6 处 5 板 | 驳回、过期、异常 |
| 紫 | `#F1E9F5` / `#6B3E86` | 4 处 4 板 | 人工调整类 |

### 6.2 业务状态取色（照抄各画板 script）

| 业务 | 橙 | 蓝 | 绿 | 灰 | 红 / 紫 | 出处 |
|---|---|---|---|---|---|---|
| 订购单 | 待开工、售后处理中 | 制作中、待上线 | 上线中 | 已结束、已取消、已退回积分 | — | Orders `SC` |
| 付款单 | 待支付、待确认收款 | — | 已支付 | 已退款 | — | Orders `SC` |
| 付款单类型 | 升级 | 开通 | 续费 | — | 紫：加购积分 | Orders `TC` |
| 交付工单阶段 | 待分配 | 其余进行中阶段 | 服务中 | 到期下架 | — | Tickets `colors()` |
| 商家审核 | 审核中 | — | 已通过 | 未提交 | 红：已驳回 | Merchants `RC` |
| 套餐版本 | 旗舰版 | 专业版 | — | 基础版；未开通 `#F3EFE9 / #6F665B` | 红：已过期 | Merchants `PC` |
| 短剧 | 热度 S | 热度 A | 已上架、热度 B | 草稿、热度 C；已下架 `#F3EFE9 / #6F665B` | — | Dramas `HC` `SC` |
| 客服工单 | 待受理 | 处理中、待商家确认 | 已解决 | 已关闭 | — | Service `sColors` |
| 退款 | 待审批 | 待执行 | 已退款 | — | 红：已驳回 | Refunds `labels` |
| 发票 | 待开票 | — | 已开具 / 已寄出 | — | 红：已驳回 | Invoices `labels` |
| 对账 | — | — | 已对平、已处理差异 | 待对账 | 红：有差异 | Reconcile `sMap` |
| 积分调整审批 | 待审批 | — | 已通过 | — | 红：已驳回 | CreditAdjust `sMap` |
| 续费意向 | 考虑中 | 延长审批中 | 已确认续费、已续费 | 暂不续费 | 红：待跟进、已过期、剩 ≤3 天 | Renewals |
| 积分流水 | 冻结 | 加购 | 发放、退回 | 扣减、清零 | 紫：调整 | PointAccounts `KC` |
| 员工账号 | — | 待启用 | 启用 | 已禁用 | — | SysStaff `SL` |
| 巡检 | — | — | 正常 | 待巡检 `#F3EFE9 / #5E564C` | 红：异常 | Patrol `colors` |

### 6.3 形态

| 形态 | 规格【源码】 | 用处 |
|---|---|---|
| 表格状态标签 | `height: 22px; padding: 0 8px; border-radius: 11px; font-size: 12px; font-weight: 600`，无描边（27 板 44 处） | 列表、抽屉、侧栏 |
| 页头状态胶囊 | `height: 24px; padding: 0 10px; border-radius: 12px; 13px / 600`；队列详情为 `padding: 3px 10px` | 详情页、队列详情 |
| 队列项标签 | `padding: 1px 8px; border-radius: 10px; 12px / 600` | 队列项右上 |
| 方角小标签 | `padding: 0 6px; border-radius: 4px; 12px; line-height: 18px` | 热度、“固定”、“广告” |
| 文字状态 | 不带底，仅 `600` + 色调字色 | 比对结论、时效 |
| 提示条 | `padding: 10px 12px; border-radius: 8px; font-size: 13px; line-height: 1.6`，无描边、默认无图标；绿 `#E5F1E9 / #256A42`、橙 `#FBEDE5 / #A63F12`、红 `#FBE9E7 / #B42318`、蓝 `#E8EEF8 / #2E5AAC`、中性 `#FAF8F4 / #6F665B`；带图标时 `display: flex; gap: 8px`（Review） | 队列详情、对话框 |
| 侧栏徽标 / 未读点 | 见 1.1、1.2 | |
| 排名圆标 | `24×24; border-radius: 12px; 12px / 700`（RptDramas） | 排行榜 |

## 7. 图表

全部是手写内联 SVG 或 div，没有引用图表库；没有 tooltip 样式（折线图上有 `r=10` 的透明命中圆，说明预期有悬停提示）。

| 类型 | 画板与尺寸 | 规格【源码】 |
|---|---|---|
| 单系列柱状 | RptOverview 每日收款额 700×200、近 6 个月 MRR 380×200；PointPacks 660×200；RptAds 720×172 与 364×152；RptPartners 324×168；RptService 340×176 | 柱为 `<path>`，仅顶部两角圆角 4；主色 `#C4501B`；“近 N 个月”类图把历史月画成 `#D9D1C6`、当前月 `#C4501B`，并在当前柱顶标数值；“今日（截至 10:30）”半柱 `#E39463` |
| 分组柱状 | RptPoints 700×230 | 发放 `#2A6FC9`、消耗 `#C4501B`、清零 `#D9D1C6` |
| 折线 + 面积 | RptDelivery 660×180、RptService 340×176 | 折线 `stroke: #C4501B; stroke-width: 2`，圆头圆角；面积 `fill: #C4501B; fill-opacity: 0.1`；末点 `r: 4.5; fill: #C4501B; stroke: #FFFFFF; stroke-width: 2`；末点数值 `12px / 600 / #1D1A16`；目标线 `stroke: #8A7F73` 1px + 文字“目标 6 个工作日”`11px #1D1A16` |
| 堆叠条（横向单条） | RptOverview 收款构成（按类型 / 版本 / 购买周期） | div：`display: flex; gap: 2px; border-radius: 4px; overflow: hidden`；段 `height: 14px; min-width: 2px`，宽度用 `flex` 比例；色序 `#C4501B`、`#E39463`、`#963F16`、`#2A6FC9`；图例在条下方 `gap: 6px 16px`，含金额与占比 |
| 横向条形列表 | RptOverview 付费主体分布等（`border-radius: 0 4px 4px 0` 共 47 处） | 行 `grid-template-columns: 76px minmax(0, 1fr) 56px; column-gap: 12px; 13px`；条 `height: 10px; border-radius: 0 4px 4px 0; background: #C4501B`，轨道高 18px 无底色；右侧数值右对齐 |
| 进度条 | MerchantDetail 档案完整度（`role="progressbar"`） | 绿色实心条 + 右上百分比 |
| 坐标轴 | 全部 SVG 图 | 基线 `stroke: #DDD5C9` 1px；横向网格线 `#EFEAE2` 1px（3–4 条）；无纵轴线、无刻度线；刻度文字 `font-size: 11; fill: #6F665B`，纵轴 `text-anchor: end`，横轴 `middle`；纵轴单位写进刻度（“8 万”）或卡片右上“单位：元”`12px #6F665B` |
| 图例 | 卡片标题行右侧 | 项 `gap: 6px; 12px; #6F665B`，项间 `gap: 16px`；柱图色块 `10×10; border-radius: 2px`，折线图色条 `14×2; border-radius: 1px` |
| 图表卡 | | `padding: 16px 18px; border: 1px solid #ECE6DD; border-radius: 12px; gap: 12px`；标题 h2 `15px / 600`；报表页分栏 `minmax(0, 1fr) 400–440px; gap: 16px` |
| 月份切换 | RptOverview 页头 | 外框 `height: 36px; padding: 0 4px; border: 1px solid #E7E1D8; border-radius: 8px`；左右箭头 `28×28; border-radius: 6px`；月份 `min-width: 96px; 14px / 600` |

## 8. Ant Design 6 落地建议【建议】

> token 名称按 antd 5/6 主题文档写出，实现时以安装版本的类型定义为准；组件级 token 不存在时用 CSS 覆盖。

### 8.1 `ConfigProvider theme.token`

| token | 取值 | 依据 |
|---|---|---|
| `colorPrimary` | `#C4501B` | 主按钮、菜单选中、页签下划线（background 245 次） |
| `colorLink` | `#A63F12` | 全部文字链与文字按钮 |
| `colorSuccess` / `colorError` / `colorInfo` | `#256A42` / `#B42318` / `#2E5AAC` | 6.1 |
| `colorWarning` | `#A63F12`（待确认） | 原型的“待处理”直接用品牌橙，没有独立的黄色 |
| `colorSuccessBg` / `colorErrorBg` / `colorInfoBg` / `colorWarningBg` | `#E5F1E9` / `#FBE9E7` / `#E8EEF8` / `#FBEDE5` | 6.1 |
| `colorSuccessBorder` / `colorErrorBorder` | `#B9DCC5` / `#E8B4AE` | 已勾清单描边、驳回按钮描边 |
| `colorPrimaryBg` / `colorPrimaryBgHover` | `#FFF8F3` / `#FBEDE5` | 选中卡片底、头像底 |
| `colorTextBase` / `colorText` | `#1D1A16` | 根容器 |
| `colorTextSecondary` | `#6F665B` | 1447 次 |
| `colorTextTertiary` / `colorTextQuaternary` | `#9A9084` / `#C9C1B6` | 弱文字、禁用箭头 |
| `colorTextPlaceholder` | `#9A9084` | 原型未定义占位符颜色，取弱文字色 |
| `colorBorder` | `#E7E1D8` | 输入框、下拉 |
| `colorBorderSecondary` | `#ECE6DD` | 卡片、顶栏、页签条 |
| `colorSplit` | `#F0EBE3` | 表格行、日志行 |
| `colorBgLayout` | `#F6F3EE` | 页面底 |
| `colorBgContainer` / `colorBgElevated` | `#FFFFFF` | |
| `colorFillAlter` | `#FAF8F4` | 表头、记录块 |
| `colorFillSecondary` / `colorFillTertiary` | `#F3EFE9` / `#F6F3EE` | 中性标签底、关闭按钮底 |
| `colorBgMask` | `rgba(29, 26, 22, 0.45)` | 对话框遮罩 |
| `colorBgSpotlight` | `#1D1A16` | Toast、Tooltip |
| `borderRadius` | `8` | 1674 次 |
| `borderRadiusLG` / `borderRadiusSM` / `borderRadiusXS` | `12` / `6` / `4` | 卡片 / 分页与小按钮 / 方角标签 |
| `controlHeight` | `36` | 筛选控件、页头按钮（`min-height: 36px` 最多） |
| `controlHeightLG` / `controlHeightSM` | `40` / `30` | 对话框按钮 / 行内按钮、分段项 |
| `fontSize` | `14` | 根容器声明 14px；按钮、页签、一级菜单为 14。表格、输入、描述、面包屑为 13，用组件 token 下调（见 8.2）。不建议把基准设为 13：按 antd 默认算法推算，派生的 `fontSizeSM` 会小于 12（实现时验证） |
| `fontSizeSM` / `fontSizeLG` / `fontSizeHeading*` | `12` / `16` / 按 24、18、16、15 逐个指定 | 标签 12；h1 24；h2 18 / 16 / 15 |
| `fontFamily` | `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif` | 根容器 |
| `fontWeightStrong` | `600` | font-weight 600 共 1178 次 |
| `boxShadow` / `boxShadowSecondary` | `0 8px 24px rgba(29, 26, 22, 0.18)` | Toast 阴影（55 次）；卡片本身无阴影 |
| `wireframe` | `false` | |
| `motion` | 保持默认 | 原型无动效定义 |

衬线字体不进 token：另设 CSS 变量 `--font-serif: 'Noto Serif SC', serif`，只用于页标题、指标数字、品牌字、头像块。

### 8.2 组件级 token

| 组件 | 建议 |
|---|---|
| Layout | `siderBg: '#231F1B'`、`headerBg: '#FFFFFF'`、`headerHeight: 56`、`headerPadding: '0 24px'`、`bodyBg: '#F6F3EE'`；`<Sider width={216}>`；内容区 `padding: 20px 24px 24px` |
| Menu（`theme="dark"`、`mode="inline"`） | `darkItemBg` 与 `darkSubMenuItemBg: '#231F1B'`（子菜单不加深）、`darkItemColor: '#E9E2D8'`、`darkItemSelectedBg: '#C4501B'`、`darkItemSelectedColor: '#FFFFFF'`、`itemHeight: 36`、`itemBorderRadius: 8`、`itemMarginInline: 10`、`itemMarginBlock: 2`、`iconSize: 18`；二级项高 32、字号 13、左缩进 40 需 CSS 覆盖；悬停底色原型未给，建议 `rgba(255, 255, 255, 0.06)`；角标与 V1.1 标记通过自定义 `label` 渲染 |
| Table | `headerBg: '#FAF8F4'`、`headerColor: '#6F665B'`、`headerSplitColor: 'transparent'`、`borderColor: '#F0EBE3'`、`rowSelectedBg: '#FFF8F3'`、`rowHoverBg: '#FAF8F4'`（原型无悬停态）、`cellFontSize: 13`、`cellPaddingInline: 8`（首末列补到 16）、`cellPaddingBlock: 10`、`headerBorderRadius: 0`；表头 12px / 600 与表头底线 `#ECE6DD` 用 CSS；不开斑马纹、不开竖线 |
| Tag | 原型标签是 22 高全圆角、无描边、600 字重，与 antd Tag 差异大；建议自建 `StatusTag`，或 `Tag bordered={false}` + `borderRadiusSM: 11`、`defaultBg: '#EFEBE4'`、`defaultColor: '#5E564C'` 再用 CSS 调字重 |
| Button | `borderRadius: 8`、`paddingInline: 16`、`paddingInlineLG: 18`、`defaultBorderColor: '#DDD5C9'`、`defaultColor: '#1D1A16'`、`primaryShadow` / `defaultShadow` / `dangerShadow: 'none'`、`contentFontSize: 14`；主按钮字重 600、次按钮 400，需按类型 CSS 覆盖；禁用主按钮是 `#D6CFC4` 底白字，与 antd 默认（灰底灰字）不同，需覆盖；“通过”绿色按钮用 `color`/`variant` 自定义或局部 `ConfigProvider` |
| Modal | `borderRadiusLG: 14`、`titleFontSize: 18`、`titleColor: '#1D1A16'`、`contentBg` 与 `headerBg: '#FFFFFF'`、`boxShadow: '0 24px 48px rgba(29, 26, 22, 0.24)'`；内边距统一 24；默认宽 520，另留 560 / 640 两档；页脚取消在左、确认在右、间距 10；关闭按钮改 32×32、`#F6F3EE` 底 |
| Drawer | 宽 480、`padding: 24`、阴影 `-12px 0 32px rgba(29, 26, 22, 0.18)`；遮罩建议与 Modal 统一为 0.45 |
| Tabs | `inkBarColor: '#C4501B'`、`itemColor: '#6F665B'`、`itemSelectedColor` 与 `itemHoverColor: '#1D1A16'`、`titleFontSize: 14`、`horizontalItemPadding: '12px 10px'`（合 46 高）、`horizontalItemGutter: 4`、`horizontalMargin: '0'`；选中字重 600 用 CSS；计数徽标放进 `label` |
| Input / Select / InputNumber | `controlHeight: 36`、`paddingInline: 10`、`inputFontSize: 13`（Select 用 `fontSize: 13`）、`activeBorderColor: '#C4501B'`、`hoverBorderColor: '#DDD5C9'`、`activeShadow: '0 0 0 2px #FBEDE5'`（原型没有焦点样式，必须补）；表单内输入高度 38 与 36 二选一（见不一致清单） |
| Form | `labelFontSize: 13`、`labelColor: '#1D1A16'`、`itemMarginBottom: 14`、`verticalLabelPadding: '0 0 6px'`；`layout="vertical"`、`requiredMark` 待定 |
| Segmented | `trackBg: '#EFEBE4'`、`trackPadding: 3`、`itemSelectedBg: '#FFFFFF'`、`itemColor: '#6F665B'`、`itemSelectedColor: '#1D1A16'` |
| Switch | 局部 `colorPrimary: '#256A42'`（开启是绿色不是品牌色）、`colorTextQuaternary: '#CFC7BC'`、`trackHeight: 20`、`trackMinWidth: 36`、`handleSize: 16`、`trackPadding: 2` |
| Checkbox / Radio | `controlInteractiveSize: 16`；清单场景的绿色勾选用局部 `colorPrimary: '#256A42'` |
| Pagination | 原型是“‹ 1 / N 页 ›”的简化分页，当前页深色实心；用 `simple` 模式 + CSS，或自建；`itemSize: 30`、圆角 6 |
| Breadcrumb | `itemColor` 与 `separatorColor: '#6F665B'`、`lastItemColor: '#1D1A16'`、`fontSize: 13`、`separatorMargin: 6`；末级 600 用 CSS |
| Alert | `defaultPadding: '10px 12px'`、圆角 8、描边色设为与底色相同（原型无描边）、默认 `showIcon={false}` |
| Card | `borderRadiusLG: 12`、`colorBorderSecondary: '#ECE6DD'`、无阴影；`bodyPadding` 按场景 16 / 20 |
| Descriptions | 原型是“固定标签宽 + 值”的两列网格，建议自建 `InfoList`（props：`labelWidth`、`size: 13 | 14`、`columns`）；若用 Descriptions 则 `colon={false}`、`labelColor: '#6F665B'`、`itemPaddingBottom: 8` |
| Message / Notification | 原型 Toast 为右上、深色底、带关闭；antd `message` 是顶部居中白底。建议用 `notification`（`placement: 'topRight'`、`top: 68`）并把底色覆盖为 `#1D1A16`，或自建 |
| Upload | `Upload.Dragger` 覆盖为高 64、`1px dashed #D9D1C6`、`#FAF8F4` 底、圆角 10 |

### 8.3 antd 没有现成的、需要自建

| 组件 | 说明 |
|---|---|
| `AppShell` 的菜单标签 | 带数字角标、V1.1 标记、选中后角标反色 |
| `PageHeader` | 衬线 h1 + 副标题 + 右侧操作 / 行内统计 / V1.1 标签与说明条 |
| `KpiCard`、`TodoCard`、`StatInline` | 衬线大数字；三种密度 |
| `FilterBar` | 搜索 + 下拉 + 分段 + 勾选 + 重置的横条（基础 antd 无此组合） |
| `StatusTag` + 状态字典 | 6 色调；把 6.2 的映射收敛为一份常量 |
| `QueueWorkbench` | `QueueList`、`QueueItem`、详情卡、底部操作条、处理结果条 |
| `CheckList` / `AckCheckbox` | 勾选后变绿底的清单行；只读质检清单 |
| `ReasonChips` | 内含 radio 的胶囊单选 |
| `ConfirmDialog` | 回显 + 强制勾选 + 原因 + 说明的组合，基于 Modal |
| `CompareTable`、`DiffBlock` | 字段 / 值 / 比对结论；变更前后 |
| `Stepper` | 11 步横向进度（antd Steps 的完成态与进行态同色，且无光环，改造成本高于自建） |
| `LogList` | 时间 / 操作人 / 内容三列行（antd Timeline 是圆点竖线式，不符） |
| `Toast`、`SimplePager`、`MonthSwitcher` | 见 5、2、7 |
| 图表 | `BarChart`、`GroupedBar`、`LineArea`、`StackedBar`、`HBarList`；antd 不含图表 |
| 业务专用 | 上线日历月视图（Calendar）、客服会话流（ServiceDetail）、竖版视频预览块（TicketDetail、AdTasks）、证照占位图（Review） |

## 9. 原型内不一致（建议统一）

| # | 现象 | 出处 | 建议 |
|---|---|---|---|
| 1 | 队列左列宽 340 与 360 并存 | Accounts、Delivery、Invoices、Refunds vs AdTasks、Offline、Receipts、Review、Verify | 统一 360 |
| 2 | 队列项选中描边 2px 与 1.5px | 7 板 vs Invoices、Refunds | 统一 2px |
| 3 | “通过”按钮绿色与品牌色并存 | Accounts、Offline、Receipts、Verify（`#256A42`）vs Review、Invoices、Refunds、Delivery（`#C4501B`） | 需拍板 |
| 4 | 对话框宽度 9 种（480–680） | 34 板 | 收敛为 520 / 560 / 640 |
| 5 | 主按钮高 36 / 38 / 40，内边距 14–22 | 全局 125 种按钮样式串 | 页头 36、弹层与详情 40 |
| 6 | 表头高 40 / 38 / 36 / 34，左右内边距 16 / 18 / 12 | 25 板 vs Params、PointPacks、OrderDetail、PointAccounts 等 | 主表 40 + 16，嵌入表 36 + 12 |
| 7 | 数据行 `min-height` 16 种（35–64），上下内边距 2–8 | 43 板 | 单行 44、双行 56 两档 |
| 8 | 页签条 `gap` 4 与 2，页签左右内边距 10 / 8 / 12 / 6 | 12 板 vs 7 板；AdTasks、TicketDetail、Tickets | 统一 |
| 9 | 多行输入 `line-height` 1.6 与 1.5 | 16 板 vs 15 板 | 统一 1.6 |
| 10 | 同一表单里输入框 38 高、下拉 36 高 | SysStaff 对话框（姓名 / 手机号 38，角色 36） | 统一 36 |
| 11 | 复选框 16 / 18 / 14 / 13 四种尺寸；DramaEdit 两处没有 `accent-color` | 多板 | 统一 16 |
| 12 | 卡片标题 h2 有 18 / 17 / 16 / 15 / 14 五种 | 64 / 6 / 42 / 46 / 6 处 | 弹层与详情 18、卡片 15、侧栏卡 14 |
| 13 | Toast `max-width` 540 / 520 / 480 / 460 / 560 | 44 / 5 / 2 / 3 / 1 板 | 统一 540 |
| 14 | 遮罩透明度 0.45 与 0.35 | 对话框 vs Orders 抽屉 | 统一 0.45 |
| 15 | 中性标签有三组配色 | `#EFEBE4/#5E564C`（多数）、`#F3EFE9/#6F665B`（Merchants 未开通、Dramas 已下架）、`#F3EFE9/#5E564C`（Patrol） | 统一第一组 |
| 16 | 指标卡四种密度（数字 28 / 24 / 22，内边距各异） | Main、报表、RptOverview、MerchantDetail | 保留 24 一档 + 工作台 28 |
| 17 | 导出按钮内边距 16 与 14 | Merchants、Service vs 10 板 | 统一 |
| 18 | 错误文字 13px 与 12px；红色浅底 `#FBE9E7` 与 `#FFF7F5` 混用于提示条 | 24 板 vs 12 板；DataEntry | 12px；提示条用 `#FBE9E7`，行底用 `#FFF7F5` |
| 19 | dl 标签宽 10 种（48–132），行距 5 / 6 / 8 / 10 / 12 | 30 板 | 64 / 84 / 110 三档 |
| 20 | 筛选条内边距 `14px 16px` 与 `10px 16px` | Merchants vs 8 板 | 统一 `10px 16px` |
| 21 | 分段控件四种外观 | 标准（`#EFEBE4` 轨道）、Main（白底描边、选中深色）、ServiceDetail（`#F3EFE9` 轨道圆角 9）、SysRoles（`padding: 2px` 圆角 7） | 统一标准款 |
| 22 | 图表蓝 `#2A6FC9` 与状态蓝 `#2E5AAC` 不同 | RptPoints、RptOverview vs 状态标签 | 确认是否有意区分 |
| 23 | 胶囊类高度 38 / 34 / 32 / 30 | 原因单选 38、Review 证照页签与 SysStaff 34、胶囊单选 32、MerchantDetail 30 | 统一 32 |

## 10. 待拍板

1. 悬停、焦点、按下、加载、禁用输入框的样式原型全无，是否由开发按 antd 默认派生，还是补一版设计？
2. 侧栏是否需要分组标题、底部信息（版本、退出）、折叠？退出登录入口在哪里（顶栏用户区没有下拉）？
3. 全局搜索结果与通知面板没有画板，交互形态待定。
4. 画板固定 1440×900、表格列宽写死；最小支持宽度是多少，更宽屏幕下哪一列伸展？
5. Noto Serif SC 走 Google Fonts，国内访问不稳定；是否自托管并做子集化？
6. “通过”类按钮用绿色还是品牌色（不一致 #3）。
7. “待处理”与品牌色同为橙，antd 的 `colorWarning` 是否也取 `#A63F12`？
8. 表格是否需要列排序、批量勾选、每页条数切换、跳页？原型只有下拉排序和简化分页。
9. 原型没有日期 / 日期范围选择器（时间筛选用下拉和分段），正式版是否需要？
10. 图表库选型（ECharts、@ant-design/charts 或手写 SVG）与 tooltip 样式。
11. 抽屉只在 Orders 出现一次，其余用对话框或右侧详情栏；三者的使用边界需要定规则。
12. Toast 只有成功态；失败、警告的样式与自动消失时长待定。
13. 标 V1.1 的菜单与页签在 V1.0 上线时是隐藏还是保留占位？
