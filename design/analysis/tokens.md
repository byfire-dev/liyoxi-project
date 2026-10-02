# 狸有戏 · 样式变量分析（商家端小程序 + 运营管理后台）

依据：`prototype/merchant/src/*.dc.html`（47 个）、`prototype/admin/src/*.dc.html`（56 个）、`stats.json`、PRD 8.3。

口径说明：

- **用量**记作 `M n / A n`：该色值在商家端 / 后台全部源码中的出现次数（含内联样式、脚本取色表、SVG 描边），由脚本对源码全文计数；与 stats.json 的 `hex` 一致。
- **文字节点数**：用 HTML 解析器把继承的 `color / font-size / font-weight` 和最近祖先的 `background` 解析到每个文字节点后计数（商家端 2,183 个，后台 6,971 个）。
- 出处写作 `画板:行号`。标注【建议】的是我的归纳，其余为源码原文。
- 两端不同色值总数：商家端 78、后台 113，并集 155，两端共有 36。大量长尾是相差 1–6 个色阶的近似色（见第 2 节）。

---

## 1. 颜色

### 1.1 主色与强调

| 语义名 | 值 | 语义（源码实际用途） | 用量 | 典型出处 | 两端 |
| --- | --- | --- | --- | --- | --- |
| color-primary | `#C4501B` | 主按钮底色；Tab 选中下划线；选中项描边；标签栏当前项；数字角标底；进度条；后台侧栏当前菜单底 | M 238 / A 484 | M AdDetail:55（46px 主按钮）、Main:121；A DataEntry:69、Accounts:34 | 一致 |
| color-primary-text | `#A63F12` | 强调文字、文字链接、“待处理”类标签文字、头像首字 | M 205 / A 350 | M Accounts:48；A Accounts:52、Calendar:105 | 一致 |
| color-primary-bg | `#FBEDE5` | 强调浅底：图标底、头像底、待处理标签底、提示条 | M 117 / A 186 | M Main:60（44px 图标底）；A Accounts:52 | 一致 |
| color-primary-bg-subtle | `#FFF8F3` | 选中项浅底（脚本 `bg: on ? '#FFF8F3' : '#FFFFFF'`）、强调区块底 | M 21 / A 60 | M PlanPick、TopUp 脚本 `mopt`；A Plans:66、Invoices:118 | 一致 |
| color-accent-on-dark | `#F2B48F` | 深色底上的强调文字（会员徽标、深色卡片内的数字） | M 17 / A 1 | M Detail:35（`background:#1D1A16; color:#F2B48F`） | 仅商家端 |
| color-primary-on-dark | `#E8864F` | 侧栏数字角标底（配 `#231F1B` 文字）、Logo 描边 | A 485 | A Accounts:27、Accounts:20 | 仅后台 |

### 1.2 中性色：文字

| 语义名 | 值 | 语义 | 用量 | 典型出处 | 两端 |
| --- | --- | --- | --- | --- | --- |
| color-text-primary | `#1D1A16` | 正文、标题（根节点 `color`）；同时作深色底（见 1.3） | M 461 / A 1056 | M Accounts:19；A Accounts:17 | 一致 |
| color-text-regular | `#4A433B` | 次级正文：图标描边（22px 图标 20 处）、要点说明、中性标签文字 | M 130 / A 6 | M Accounts:84、AdDetail:39 | 后台改用 `#5E564C`（A 69，MerchantDetail:156） |
| color-text-secondary | `#6F665B` | 辅助说明、表头、占位符（`input::placeholder{color:#6F665B}`）、未选中 Tab | M 706 / A 1805 | M Accounts:85；A Accounts:60 | 一致 |
| color-text-disabled | `#9A9084` | 后台：侧栏副标题、“V1.1”未开放项；商家端：占位计时、箭头 | M 5 / A 193 | A Accounts:21、DramaEdit:131；M AssetUpload:39 | 基本一致（后台为主） |
| （禁用图标） | `#C9C1B6` | 分页禁用箭头 | A 19 | A Dramas:72 | 仅后台 |
| color-text-inverse | `#FFFFFF` | 主色 / 深色底上的文字 | M 199 / A 419（color 属性） | M AdDetail:55 | 一致 |

### 1.3 中性色：底色与描边

| 语义名 | 值 | 语义 | 用量 | 典型出处 | 两端 |
| --- | --- | --- | --- | --- | --- |
| color-bg-page | `#F6F3EE` | 页面底色（`body` 与根容器） | M 125 / A 163 | M Accounts:19；A Accounts:17 | 一致 |
| color-bg-card | `#FFFFFF` | 卡片、底栏、输入框、弹窗 | M 621 / A 1245 | M Accounts:58；A Accounts:63 | 一致 |
| color-bg-subtle | `#FAF8F4` | 卡片内的浅块；后台表头、顶部搜索框底；上传占位底 | M 35 / A 198 | M AdDetail:40；A CreditAdjust:74、Accounts:50 | 一致 |
| color-bg-inverse | `#1D1A16` | 深色卡片（商家端）、轻提示底与选中筛选项底（后台） | 同 text-primary | M Service:30；A Accounts:55 | 一致 |
| color-fill-neutral | `#F1ECE4` / `#EFEBE4` / `#F3EFE9` | 中性标签底、中性说明块底 | M 57 / A 51 / A 95 | M Accounts:84；A MerchantDetail:156、DataEntry:62 | **不一致**（见 2） |
| color-fill-track | `#ECE6DD` | 分段控件轨道、步骤圆点底 | M 10（background） | M Mall:34、PayResult:40 | 仅商家端作底色 |
| color-fill-disabled | `#D6CFC4` | 禁用按钮底、未完成进度条 | M 16 / A 24 | M AdDetail:56；A 脚本 `okBg: … ? '#C4501B' : '#D6CFC4'` | 一致 |
| color-border | `#E7E1D8` | 输入框、选择框、小按钮、搜索框描边 | M 132 / A 359 | M Accounts:67；A Accounts:50 | 一致 |
| color-border-light | `#ECE6DD` | 后台卡片描边、顶栏底边；商家端底栏 / 标签栏顶边 | M 57 / A 437 | A Accounts:48、Accounts:63；M AdDetail:54 | 一致 |
| color-divider | `#F0EBE3` | 列表行分隔线、表格行线 | M 79 / A 194 | M Main:33；A Accounts:103 | 一致 |
| color-border-strong | `#C9C0B3`（M）/ `#DDD5C9`（A） | 次按钮描边；商家端虚线上传框 | M 61 / A 139 | M AdDetail:55、Accounts:55；A Accounts:153 | **不一致** |
| color-mask | `rgba(15,14,12,0.5)`（M）/ `rgba(29,26,22,0.45)`（A） | 弹层遮罩 | M 16 / A 50 | M AdDetail:63；A Accounts:136 | **不一致** |
| （胶囊占位） | `#E2DBD0` | 右上角原生胶囊的占位描边与分隔 | M 92 | M Accounts:23、:25 | 原生控件，不入变量 |

### 1.4 状态色

脚本里的取色表是状态色的权威来源：商家端 `toastTone = { ok: ['#E6F2EA','#256A42'], warn: ['#FBEDE5','#A63F12'], info: ['#E8EEF9','#2E5AAC'] }`（23 个画板）；后台各画板的状态映射表（`on / done / passed`、`pending`、`rejected` 等键）。

| 语义名 | 文字色 | 底色 M | 底色 A | 取色表出现次数 | 典型出处 | 对应 PRD 8.3 第 4 条 |
| --- | --- | --- | --- | --- | --- | --- |
| color-success / -bg | `#256A42`（M 154 / A 206） | `#E6F2EA`（91） | `#E5F1E9`（80） | M 32 / A 40 | M Ads:65；A MerchantDetail:154 | 成功 = 绿 |
| color-info / -bg | `#2E5AAC`（M 85 / A 68） | `#E8EEF9`（74） | `#E8EEF8`（60） | M 31 / A 30 | M Accounts:30；A MerchantDetail:146 | 进行中 = 蓝 |
| color-warning / -bg | `#A63F12` | `#FBEDE5` | `#FBEDE5` | M 33 / A 30 | M Cart:34；A Main:178 | 待处理 = 橙（**与主色强调同值**） |
| color-danger / -bg | `#B42318`（M 86 / A 195） | `#FCEBEA`（9） | `#FBE9E7`（42） | A 13 | M Cart:35；A DataEntry:67 | 失效 / 错误 = 红 |
| color-neutral / -bg | `#4A433B`（M）/ `#5E564C`（A） | `#F1ECE4` | `#EFEBE4` | M 11 / A 31 | M Accounts:84；A MerchantDetail:156 | 已结束 = 灰 |
| color-purple / -bg | `#6B3E86`（A）/ `#5B3F63`（M 1 处） | `#EFE8F4` | `#F1E9F5` | A 4 / M 1 | A Orders、PointAccounts 脚本键“调整”；M Messages 脚本键“门店” | PRD 未定义 |

后台另有：危险实心按钮 `#B42318` 底白字（Accounts:154）、危险描边按钮 `1px solid #E8B4AE`（A 15，Accounts:123）、危险行底 `#FFF7F5`（A 12）、成功选中底 `#F4FAF6` + 描边 `#B9DCC5`（A 10 / 9，脚本 `ackBg / ackBorder`）、轻提示里的对勾 `#7FD19B`（A 55，Accounts:55）。

### 1.5 后台专有：深色侧栏

| 语义名 | 值 | 语义 | 用量 | 出处 |
| --- | --- | --- | --- | --- |
| color-sidebar-bg | `#231F1B` | 侧栏底色；也作 `#E8864F` 角标上的文字色 | A 427 | Accounts:18、:27 |
| color-sidebar-text | `#E9E2D8` | 菜单项文字 | A 898 | Accounts:24 |
| color-sidebar-text-base | `#D9D1C5` | `nav` 根 `color`（实际被菜单项的 `#E9E2D8` 覆盖） | A 56 | Accounts:18 |
| color-sidebar-text-muted | `#9A9084` | 副标题“运营管理后台”、V1.1 标记文字 | A 158（文字节点） | Accounts:21、:38 |
| color-sidebar-divider | `#3A332C` | Logo 区底边 | A 56 | Accounts:19 |
| color-sidebar-tag-border | `#5A5047` | V1.1 标记描边 | A 102 | Accounts:38 |
| color-sidebar-active-bg | `#C4501B` | 当前菜单底（白字 13px/600） | A 50 | Accounts:34 |

### 1.6 内容装饰色（不进入通用变量）

| 类别 | 值 | 出处 |
| --- | --- | --- |
| 短剧海报底色（数据字段 `d.color`） | `#6B2D2A` `#5B3F63` `#2F4A3F` `#7A5A2E` `#3D5A6B` `#1F2B45` `#4E6B5A` `#5A3E2B` `#8A5A3C` `#A34A3A` `#D2733F` 等 | M Main:85、Mall:55、Cart:33；A Dramas:58 |
| 证照示意 | `#D3C09F` `#F7EEDC` `#EADBC0` `#E2D3B8` `#B9A27E`，印章 `#C0392B` | M ProfileCert:53；A MerchantDetail:164（`#E6DED2` `#EADFCF`） |
| 音频波形 | `#E9C7B4`（40 处，仅 2 个画板） | M AssetDetail:39 |
| 预告片全屏底 | `#0F0E0C` | M Trailer（`body` 底色） |
| 海报上的半透明标注 | `rgba(15,14,12,0.45~0.6)`、`rgba(0,0,0,0.35)`、`rgba(255,255,255,0.12~0.85)` | M AssetLib:37、Trailer:34、Wallet:33 |
| 手机截图示意里的灰字 | `#8A8A8A` `#161616` | A DataEntry:69 |

后台报表的图表系列色只在 3 个画板出现，【建议】单列为图表色板而不是通用变量：`#C4501B`、`#E39463`（18）、`#963F16`（15）、`#2A6FC9`（17）、`#1D1A16`、空值 `#D9D1C6`、网格线 `#EFEAE2`（45，SVG）——出处 RptDelivery:71、RptAds:75、RptOverview:68。

---

## 2. 近似色与统一建议

“差值”为两色 RGB 三通道的最大差。

| # | 语义 | 现值 A | 现值 B | 差值 | 【建议】保留 | 理由 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 成功底 | M `#E6F2EA`（91） | A `#E5F1E9`（80） | 1 | `#E6F2EA` | 用量略多；对 `#256A42` 对比度 5.67 / 5.62 都达标 |
| 2 | 提示底 | M `#E8EEF9`（74） | A `#E8EEF8`（60） | 1 | `#E8EEF9` | 同上，对比度同为 5.68 |
| 3 | 危险底 | M `#FCEBEA`（9） | A `#FBE9E7`（42） | 3 | `#FBE9E7` | 后台用量多；对 `#B42318` 5.61 达标 |
| 4 | 中性标签底 | M `#F1ECE4`（57） | A `#EFEBE4`（51）、`#F3EFE9`（95）、网格线 `#EFEAE2`（45） | 1–5 | `#F0EBE3` | 与分隔线色同值，两端已共有（M 79 / A 194）；`#6F665B` 在其上 4.75 达标 |
| 5 | 中性标签文字 | M `#4A433B`（130） | A `#5E564C`（69） | 20 | `#4A433B` | 对比度更高（白底 9.73），后台已有 6 处 |
| 6 | 次按钮描边 | M `#C9C0B3`（61） | A `#DDD5C9`（139）、`#D9D1C6`（42）、`#D9D1C5`（56） | 4–20 | 需拍板 | `#C9C0B3` 对白底 1.80，`#DDD5C9` 仅 1.45；后台三个值应先并成一个 |
| 7 | 禁用 / 开关关闭 | `#D6CFC4`（M 16 / A 24） | A `#CFC7BC`（40）、`#C9C1B6`（19） | 3–13 | `#D6CFC4` | 两端共有 |
| 8 | 控件描边 | `#E7E1D8` | A `#E9E2D8`（侧栏文字）、`#E9E3DA`（M 7 / A 2）、`#E6DED2`（17） | 2–6 | `#E7E1D8` | `#E9E2D8` 是侧栏文字色，语义不同，单独保留 |
| 9 | 浅底 | `#FAF8F4` | A `#FBF8F2`（4）、`#F7F4EF`、`#FBFAF7`、`#FCFBF9`（各 1） | 2–5 | `#FAF8F4` | 零星手误 |
| 10 | 强调极浅底 | `#FFF8F3` | A `#FFF7F5`（12，危险行底）、`#FFFCF9`、M `#FFF3EB`（2） | 2–6 | `#FFF8F3`；危险行底改用 danger-bg 的更浅一档或直接 `#FFF8F3` | 肉眼难辨 |
| 11 | 深色 | `#1D1A16` | A `#231F1B`（427，侧栏）、M `#2B2621`（2）、A `#2A2521`（1） | 6–14 | 侧栏保留 `#231F1B`，其余并入 `#1D1A16` | 侧栏用量大且整体一致 |
| 12 | 遮罩 | M `rgba(15,14,12,0.5)` | A `rgba(29,26,22,0.45)` | — | `rgba(29,26,22,0.45)` | 与文字主色同色相；商家端另有 0.45 / 0.55 / 0.6 三档散用 |
| 13 | 紫色标签 | M `#5B3F63` on `#EFE8F4` | A `#6B3E86` on `#F1E9F5` | 2（底） | `#6B3E86` on `#F1E9F5` | 后台 4 处、商家端 1 处 |

---

## 3. 对比度（WCAG 2.x 相对亮度公式，脚本计算）

达标线：正文 ≥ 4.5；大字（≥ 24px，或 ≥ 18.66px 且加粗）≥ 3。半透明叠在海报上的文字（7 组）底色不定，未计算。带模板占位的 223 组已用脚本取色表回填，状态标签四组全部达标。

### 3.1 主要组合（达标）

| 文字 × 底 | 对比度 | 文字节点数 | 说明 |
| --- | --- | --- | --- |
| `#1D1A16` × `#FFFFFF` / `#F6F3EE` / `#FAF8F4` | 17.33 / 15.66 / 16.34 | M 582+128；A 2070+189+97 | 正文 |
| `#6F665B` × `#FFFFFF` / `#FAF8F4` / `#F6F3EE` | 5.63 / 5.31 / 5.09 | M 462+38+85；A 1110+444+134 | 辅助文字，含 12px |
| `#4A433B` × `#FFFFFF` | 9.73 | M 46 | |
| `#FFFFFF` × `#C4501B` | **4.66** | M 98；A 130 | 主按钮；达标但余量只有 0.16，含 11–12px 角标 |
| `#A63F12` × `#FFFFFF` / `#FBEDE5` | 6.29 / 5.49 | M 41；A 91+82 | 强调文字 |
| `#256A42` × `#E6F2EA` / `#E5F1E9` | 5.67 / 5.62 | M 54；A 18 | |
| `#2E5AAC` × `#E8EEF9` | 5.68 | M 55；A 19 | |
| `#B42318` × `#FFFFFF` / `#FBE9E7` / `#FCEBEA` | 6.57 / 5.61 / 5.70 | M 53；A 74+13 | |
| `#5E564C` × `#EFEBE4` / `#F3EFE9` | 6.07 / 6.30 | A 18+ | |
| `#E9E2D8` × `#231F1B` | 12.73 | A 897 | 侧栏菜单 |
| `#231F1B` × `#E8864F` | 6.20 | A 371 | 侧栏角标（若改白字只有 2.64，不可用） |
| `#9A9084` × `#231F1B` | 5.22 | A 158 | 侧栏弱文字 |
| `#F2B48F` × `#1D1A16` | 9.66 | M 11 | |

### 3.2 不达标或贴线的组合

| 文字 × 底 | 对比度 | 字号 / 字重 | 出处 | 性质 | 【建议】 |
| --- | --- | --- | --- | --- | --- |
| `#C4501B` × `#F6F3EE` | 4.21 | 13px / 600 | M Main:91（推荐位“积分”价格） | 正文不达标 | 文字一律用 `#A63F12`（同底 5.68） |
| `#C4501B` × `#FAF8F4` | 4.39 | 17px / 700 | M Invoices:49（金额） | 不达标（未到大字门槛） | 同上（5.93） |
| `#C4501B` × `#FFFFFF` | 4.66 | 12px/600 ×11、15px/700 ×6 | M Cart:33、标签栏当前项 Main:121 | 贴线 | 同上；`#C4501B` 只作填充色与图标色 |
| `#9A9084` × `#FFFFFF` / `#FAF8F4` | 3.14 / 2.96 | 11–13px | A DramaEdit:131、:144、MerchantDetail:79 | “V1.1 未开放”项，视为禁用态 | 若承载需读的说明，改 `#6F665B` |
| `#B3AA9E` × `#FFFFFF` | 2.29 | 14px | A MerchantDetail:80（未开放的 Tab） | 禁用态 | 并入 text-disabled |
| `#C9C1B6` × `#FFFFFF` | 1.78 | 13px | A Dramas:72、Merchants:76、MerchantDetail:149（分页禁用箭头） | 禁用态 | 可接受，统一到 `#D6CFC4` |
| `#FFFFFF` × `#D6CFC4` | 1.55 | 15px / 600 | M AdDetail:56、Plan:81（禁用主按钮） | 禁用态但文字是状态说明（“第 2 版制作中”） | 禁用按钮文字改 `#4A433B`（同底 6.30） |
| `#8A7F73` × `#FFFFFF` | 3.92 | 12px | A OpsTemplates:66 | 正文不达标 | 改 `#6F665B` |
| `#6F665B` × `#E9E3DA` | 4.42 | 11px | A Offline:115（缩略图占位标注） | 略低 | 底改 `#F0EBE3` |
| `#6F665B` × `#ECE6DD` | 4.54 | 12–13px | M Mall:36、Detail:40（分段控件未选中项） | 贴线 | 保持，轨道色不要再加深 |
| `#8A8A8A` × `#FFFFFF` | 3.45 | 10–11px | A DataEntry:69（手机截图示意） | 内容装饰 | 不处理 |

非文字对比度（WCAG 1.4.11 要求 3:1，供参考）：输入框描边 `#E7E1D8` 对白底 1.30，卡片描边 `#ECE6DD` 1.24，次按钮描边 `#DDD5C9` 1.45 / `#C9C0B3` 1.80，开关关闭轨道 `#CFC7BC` 1.67。整套设计的控件边界靠底色差而不是描边识别，是否接受见待定问题。

---

## 4. 字体

### 4.1 字体族

| 字体族 | 源码原文 | 用在哪 | 用量 |
| --- | --- | --- | --- |
| font-family-sans | `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif` | 根容器；按钮 / 输入框用 `font-family: inherit` 继承 | 全部画板 |
| font-family-serif | `'Noto Serif SC', serif`（`<link>` 从 Google Fonts 载入 600 / 700 / 900 三个字重） | 商家端：品牌字“狸有戏”（Main:20、Login:27）、海报剧名（Main:107、Detail:33）、头像首字（Mine:35、Members:37）；后台：品牌字（Accounts:21）、页面标题 h1（Accounts:59）、统计大数字（Main:64、MerchantDetail:70） | M 73 个文字节点 / 29 个画板；A 199 个 / 56 个画板 |
| font-family-mono | `ui-monospace, Menlo, monospace` | 后台的编码字段 | A 3 处（SysDict:59、PartnerBinding:76、OpsTemplates:66） |

数字列大量使用 `font-variant-numeric: tabular-nums`（M 32 / A 514）。

### 4.2 商家端字号阶梯

| 字号 | 文字节点数 | 字重 | 行高 | 用途 | 出处 |
| --- | --- | --- | --- | --- | --- |
| 17px | 79 | 600（69） | 默认 | 页面标题 h1（45 个画板）、底部弹层标题 | Accounts:22、AdDetail:66 |
| 16px | 90 | 600（83） | 默认 | 卡片 / 区块标题 h2（45）、h3（8） | Accounts:59、Detail:36 |
| 15px | 259 | 600（171）/ 400（69） | 默认 | 主按钮文字（15/600）、输入框文字（15/400，22 处）、列表主标题（15/600） | AdDetail:55、Accounts:67、Accounts:34 |
| 14px | 356 | 400（180）/ 600（170） | 1.55、1.5 | 表单标签（14/600）、多行输入、Tab、数值与次级正文、必填星号 | AdDetail:72、Orders:34 |
| 13px | 641 | 400（573） | 1.5（267） | 辅助说明、描述段落、小按钮（32px 高） | Accounts:30、AssetDetail:42 |
| 12px | 567 | 400（424）/ 600（133） | 1.5（121） | 标签（12/600）、次要说明（12/400 `#6F665B`）、标签栏文字 | Accounts:84、Main:121 |
| 11px / 10px | 48 / 14 | 600、900（衬线） | 16px、18px、15px | 数字角标（11/600，高 16）、海报小字、缩略图标注 | Cart:47、AssetLib:37 |
| 18 / 20 / 22px | 15 / 15 / 16 | 700（无衬线数字）、900（衬线） | 默认 | 积分与金额强调、结果页标题 22/700、头像首字 | Cart:39、Checkout:83、PayResult:31 |
| 26–32px | 18 | 700 | 1.1 | 余额大数字 | Ledger:34、Mine:39、Ads:38 |
| 7 / 8 / 9.5 / 10.5px | 19 | — | — | 缩略预览里的示意文字，属内容装饰 | Plan:63、Ads:53、MyDramas:43 |

**与 PRD 8.3 第 2 条核对**（页面标题 17 / 正文 15 / 辅助 13 / 标签 12）：17、13、12 三档与源码一致。15px 在源码里主要是按钮、输入框和列表主标题；**14px（356 个节点）与 16px（90 个节点）是高频档位但 PRD 没有**。【建议】PRD 补两档：区块标题 16px/600、表单与次级正文 14px；或把 14px 并入 15px（需设计确认，会影响 356 处）。

### 4.3 后台字号阶梯

| 字号 | 文字节点数 | 字重 | 行高 | 用途 | 出处 |
| --- | --- | --- | --- | --- | --- |
| 24px 衬线 | 101 | 700 | 1.3 | 页面标题 h1（56）、统计数字（45） | Accounts:59、MerchantDetail:70 |
| 26 / 28 / 30px 衬线 | 17 | 700 | 1.3 / 1.25 / 1.2 | 工作台大数字 | Main:90、Main:64、PartnerLevels:59 |
| 19px 衬线 | 56 | 900，字间距 3px | 1.1 | 侧栏品牌字 | Accounts:21 |
| 18px | 133 | 600（64） | 默认 | 详情面板 / 弹窗标题 h2；关闭按钮“×” | Accounts:85、Accounts:139 |
| 16px | 144 | 600（43）/ 700（36） | 默认 | 区块标题 h2（42）、统计值 dd（16/700，30） | Calendar:77、CreditAdjust:62 |
| 15px | 88 | 600（74） | 默认 | 卡片小标题 h2（46） | DramaEdit:153 |
| 14px | 1384 | 400（976）/ 600（307） | 1.3 | 根字号（Accounts:17）；侧栏一级菜单、按钮、Tab、h3（14/600） | Accounts:24、Accounts:153、Accounts:110 |
| 13px | 3040 | 400（2489）/ 600（462） | 1.6（133） | **实际基准**：表格正文、输入框、下拉、说明文字、侧栏二级菜单、面包屑 | Accounts:60、Accounts:31、Calendar:70 |
| 12px | 1815 | 400（893）/ 600（515）/ 700（403） | 1、1.6、1.7 | 表头（12/600 `#6F665B`）、状态标签（12/600）、辅助说明、侧栏角标（12/700） | CreditAdjust:74、CreditAdjust:85、Accounts:27 |
| 11px | 164 | 400 | 16px | 小标记（V1.1） | Accounts:38 |

**与商家端的差别**：后台基准是 13px（商家端辅助档），整体小两档；页面标题是 24px 衬线 700，商家端是 17px 无衬线 600；后台没有 17px 档（仅 7 处）；后台多出 18px 标题档；后台 700 用得多（679 个节点，商家端 84 个）。PRD 8.3 没有给后台规定字号。

### 4.4 字重与字间距

| 字重 | 商家端 | 后台 |
| --- | --- | --- |
| 400 | 正文、说明（1,312 个节点） | 正文、表格、菜单（4,624） |
| 600 | 标题、按钮、表单标签、标签（706） | 标题、表头、标签、主按钮、当前菜单（1,493） |
| 700 | 只用于数字强调：积分、金额、余额（84） | 侧栏角标 12/700（401）、衬线标题与统计数字、统计值 16/700（679）；另有 56 处 `<strong>` 未写字重，按浏览器默认 700 |
| 900 | 只与衬线体搭配：品牌字、海报剧名、头像首字（69） | 只与衬线体搭配：品牌字、头像首字（61） |
| 800 | 2 处，贴片广告预览示意（AdDetail:36） | 无 |

字间距只用于装饰性文字：品牌字（M 2px@19px Main:20、6px@44px Login:27；A 3px@19px Accounts:21）、海报竖排剧名（4px@22px Main:107、8px@38px Detail:33）、证照 / 授权书示意（3px Contracts:50；A Review:90 4px）、小号眉题（2px@12px Detail:33）。正文、按钮、标签都不设字间距。

---

## 5. 间距

### 5.1 常用值（把 `gap` 与 `padding` 拆成单个数值后计数）

| 值 | 商家端 gap / padding | 后台 gap / padding | 备注 |
| --- | --- | --- | --- |
| 2px | 161 / 30 | 390 / 18 | 图标与文字上下、主副标题之间 |
| 4px | 115 / 100 | 177 / 45 | |
| 6px | 192 / 122 | 417 / 515 | 标签左右内边距 |
| 8px | 257 / 97 | 602 / 362 | |
| 10px | 133 / 125 | 1126 / 1482 | 后台最常用（菜单项图标间距、控件左右内边距） |
| 12px | 301 / 243 | 280 / 1147 | 商家端最常用（卡片间距、卡片内分组） |
| 14px | 23 / 75 | 65 / 255 | |
| 16px | 21 / 360 | 308 / 376 | 商家端页面边距与卡片内边距 |
| 18px | 2 / 3 | 1 / 211 | 仅后台：卡片 `16px 18px`、按钮 `0 18px` |
| 20px | — / 40 | 10 / 202 | |
| 24px | — / 38 | 45 / 241 | 后台页面边距、弹窗内边距 |
| 40px | — | — / 279 | 后台二级菜单左缩进，属布局值 |

【建议】间距阶梯：`2 / 4 / 6 / 8 / 10 / 12 / 14 / 16 / 20 / 24`。18px 只在后台出现且不在 2 的阶梯惯例里，建议并入 16 或 20。

### 5.2 固定用法

| 用法 | 商家端 | 后台 |
| --- | --- | --- |
| 页面边距 | `main` 的 `padding: 4px 16px 20px`（22 个画板）；另有 `4px 16px 24px`（6）、`0 16px 20px`（4）、`2px 16px 24px`（5）——左右恒为 16px | `main` 的 `padding: 20px 24px 24px`（56 个画板全部一致，Accounts:57） |
| 区块间距 | `main` 的 `gap: 12px`（个别 14px） | `main` 的 `gap: 16px` |
| 卡片内边距 | `padding: 16px`（89 个 section，Accounts:58）；内部 `gap` 12（45）/ 10（27）/ 8 / 14 | 表格卡片无内边距；内容卡片 `16px 18px`（44）、`20px`（6）、统计卡 `16px 20px`（Main:62）；弹窗 `24px`，`gap: 16px` |
| 底部弹层 | `padding: 16px 16px 24px; gap: 16px`（16 处，AdDetail:64） | — |
| 底部操作栏 | `padding: 0 16px 8px; gap: 12px`（23 处，AdDetail:54） | — |
| 列表行 | `min-height: 52px` + `border-bottom: 1px solid #F0EBE3`（Main:33，共 20+ 处）；另有 40 / 48 / 60 / 64 | 表头 `min-height: 40px; padding: 0 16px`（26）；表体两行内容 `58px; 6px 16px`（9），单行 `40–42px; 4px 16px`（15）；列间 `column-gap: 12px` |
| 顶栏 / 侧栏 | 顶栏高 48px（原生导航栏占位） | 顶栏 `padding: 0 24px; gap: 16px`；侧栏菜单区 `padding: 12px 10px; gap: 2px` |
| 控件内边距 | 输入框 `0 12px`；多行输入 `10px 12px`；主按钮 `0 16px`；小按钮 `0 12px`；标签 `1px 6px` | 输入框 `0 10px`；下拉 `0 8px`；多行输入 `8px 10px`；按钮 `0 16px` / `0 18px` / `0 14px`；状态标签 `0 8px` |

---

## 6. 圆角

| 档位 | 商家端用途（次数，出处） | 后台用途（次数，出处） |
| --- | --- | --- |
| 2–3px | 进度条、波形条、细指示条（129+15） | 图例色块、进度条（40+30） |
| 4px | **标签**（134；Ads:65） | 小标记 V1.1（120；Accounts:38）、方角标签 |
| 6px | 小海报缩略图（14） | 28–30px 的图标按钮、分页格（181；Accounts:55） |
| 8px | 缩略图、海报、32px 图标底（45） | **控件统一圆角**：按钮、输入框、下拉、菜单项（1,674；Accounts:24、Calendar:70） |
| 10px | **输入框 / 多行输入 / 提示条 / 轻提示**（180；Accounts:67、Accounts:30） | 内嵌浅块、轻提示、可选卡片（253；Accounts:55、Accounts:103） |
| 12px | 小卡片、40px 图标底、商城剧目卡（44；Mall:54、Login:32） | **卡片**（228；Accounts:63） |
| 14px | **卡片**（section 114 + article 22；Accounts:58）、44px 图标底 | **弹窗**（50；Accounts:137） |
| 16px（上两角） | **底部弹层** `16px 16px 0 0`（16；AdDetail:64）；深色卡片 16px（Service:30） | — |
| 胶囊（高度的一半） | 主 / 次按钮 23px@46px（69）、22px@44px（28）、24px@48px（7）、20px@40px（36，含搜索框）；小按钮 16px@32px；筛选项 17px@34px | 状态标签 11px@22px（93）、数字角标 9px@18px（391）、筛选项 16px@32px（89）、头像 16px@32px |

两端差异：卡片 14（M）对 12（A）；输入框 10（M）对 8（A）；按钮商家端是胶囊、后台是 8px 圆角矩形；标签商家端是 4px 方角、后台以 22px 高胶囊为主。

---

## 7. 阴影与描边

### 7.1 阴影

| 档位 | 值 | 用途 | 次数 / 出处 |
| --- | --- | --- | --- |
| 商家端：无层级阴影 | — | 卡片、底栏、弹层全部不带阴影，靠白底与 `#F6F3EE` 的色差区分 | — |
| 商家端：头像叠放描边 | `0 0 0 2px #FFFFFF` | 重叠小圆头像的白色外环 | 10；Profile:45 |
| 商家端：个例 | `0 6px 16px rgba(196,80,27,0.28)`、`0 2px 8px rgba(29,26,22,0.06)` | 录音圆按钮、邀请卡片 | 各 1；AssetUpload:39、Invite:43 |
| 后台：轻提示 | `0 8px 24px rgba(29, 26, 22, 0.18)` | 右上角深色轻提示 | 55；Accounts:55 |
| 后台：弹窗 | `0 24px 48px rgba(29, 26, 22, 0.24)` | 居中对话框 | 50；Accounts:137 |
| 后台：抽屉 | `-12px 0 32px rgba(29, 26, 22, 0.18)` | 右侧抽屉（宽 480px） | 1；Orders:97 |
| 后台：开关滑块 | `0 1px 2px rgba(29, 26, 22, 0.25)` | 16px 滑块 | 6；OpsAgreements:79 |
| 后台：选中行标记 | `inset 3px 0 0 #C4501B` | 列表选中行左侧色条 | 6；OpsTemplates:65、Patrol:76 |

### 7.2 描边

| 写法 | 用途 | 商家端 | 后台 |
| --- | --- | --- | --- |
| `1px solid #E7E1D8` | 输入框、小按钮、搜索框 | 86（Accounts:67） | 277（Accounts:50） |
| `1px solid #ECE6DD` | 卡片四边（后台）；顶栏底边、底栏顶边 | 45（AdDetail:54） | 431（Accounts:63、:48） |
| `1px solid #F0EBE3` | 行分隔线，单边使用（`border-bottom` / `border-top`） | 75（Main:33） | 170（Accounts:103） |
| `1px solid #C9C0B3` / `1px solid #DDD5C9` | 次按钮 | 28（AdDetail:55） | 126（Accounts:153） |
| `1px dashed #C9C0B3` / `1px dashed #D9D1C6` | 上传占位、待添加项 | 22（Accounts:55） | 5（DataEntry:93） |
| `2px solid` + `#C4501B` / `transparent` | Tab 选中下划线（`border-bottom`） | Orders:34 | 24（Accounts:66） |
| 选中项描边 | 选项卡片选中 | 颜色切为 `#C4501B`，宽度仍 1px（14 处；1 处 2px） | `2px solid #C4501B`（19）与 `1.5px solid #C4501B`（9）并存 |
| `1px solid #E8B4AE` | 危险描边按钮 | — | 14（Accounts:123） |
| `2px solid #FFFFFF` | 通知红点的白色外环 | — | 56（Accounts:51） |

商家端卡片**不带描边**；后台卡片**带 1px 描边、不带阴影**。

---

## 8. 尺寸

### 8.1 商家端

| 控件 | 尺寸（源码） | 次数 / 出处 |
| --- | --- | --- |
| 顶部导航栏 | 高 48px，标题 17px/600 居中；返回键 44×44px；右上胶囊占位 87×32px | 46 个画板；Accounts:20–23。PRD 8.3 第 1 条要求用原生导航栏，48px 只是画板占位 |
| 底部标签栏 | 高 64px（含 `padding-bottom: 8px`），4 列，文字 12px，当前项 `#C4501B` + 600 | 5 个画板；Main:120 |
| 底部操作栏 | 高 72px，`padding: 0 16px 8px`，顶边 `1px solid #ECE6DD` | 23 处；AdDetail:54。个例 76px（Detail:44）、80px（Join:46） |
| 主 / 次按钮 | 高 46px，圆角 23px，15px/600，`padding: 0 16px` | 69 处；AdDetail:55 |
| 按钮其他高度 | 44px（卡片内表单，28 处，Accounts:76）、48px（结果页，7 处，PayResult:63）、40px（横幅内，9 处，Ads:41） | — |
| 小按钮 | `min-height: 32px`，圆角 16px，13px，`padding: 0 12px`，描边 `#E7E1D8` | 40 处；AssetDetail:42 |
| 筛选项 | `min-height: 34px`，圆角 17px，13–14px | 22 处；Mall:41 |
| 输入框 | 高 44px，圆角 10px，15px，`padding: 0 12px` | 21 处；Accounts:67 |
| 搜索框 | 高 40px，圆角 20px，14px | Mall:30、Main:30 |
| 标签 | `padding: 1px 6px`，圆角 4px，12px/600，无固定高度（约 20px） | 85 处；Accounts:84 |
| 数字角标 | 高 16px，`min-width: 16px`，圆角 8px，11px/600 | Main:123、Cart:47 |
| Tab | `min-height: 44px`，`padding: 0 10px`，14px，下划线 2px | Orders:34 |
| 列表行 | `min-height: 52px` | Main:33 |
| 图标 | 20 / 22 / 24px 为主（129 / 80 / 79），描边宽 1.8；图标底 44×44px 圆角 14px、40×40px 圆角 12px | Main:60、Login:32 |
| 复选 / 单选 | 18×18px（16 处）、20×20px（4 处，Cart:33）、16×16px（2 处）；`accent-color: #C4501B` | Checkout:43 |
| 开关 | 34×20px，滑块 16px，开 `#C4501B` / 关 `#D6CFC4` | 1 处；Mall:46 |
| 最小触控 | 明确做到 44px 的：返回键 44×44（39 处）、Tab 与文字按钮 `min-height: 44px`（22 处）。低于 44px 的可点元素：小按钮 32px（47 处）、筛选项 34px（16 处）、图片删除键 28×28px（ProfileStore:51）、24×24px（AssetUpload:40）、未设高度的 `<a>`（87 处，含文字链接与整卡链接） | — |

### 8.2 后台

| 控件 | 尺寸（源码） | 次数 / 出处 |
| --- | --- | --- |
| 侧栏 | 宽 216px；Logo 区高 64px；一级菜单 `min-height: 36px`，圆角 8px，14px，图标 18px；二级菜单 `min-height: 32px`，13px，左缩进 40px | 56 个画板；Accounts:18–34 |
| 顶栏 | 高 56px；全局搜索 300×36px；图标按钮 40×40px；头像 32×32px | Accounts:48–52 |
| 按钮 | 页面内 `min-height: 36px`（83 处，`padding: 0 16px` / `0 14px` / `0 18px`）；弹窗底部 `min-height: 40px; padding: 0 18px`（80 处）；另有 38px（20）、34px（25，13px 字）、32 / 30 / 28px；圆角 8px；14px，主按钮 600 | DataEntry:81、Accounts:153、OrderDetail:97 |
| 输入框 / 下拉 | 下拉高 36px（61 处，Calendar:70）；表单输入框高 38px（35 处，DramaEdit:77）；另有 34px、32px；圆角 8px，13px | — |
| Tab | `min-height: 46px`，`padding: 0 10px`，14px，下划线 2px | 21 个画板；Accounts:66 |
| 表格 | 表头 `min-height: 40px`（26）/ 38px（11）/ 36px（3），12px/600，底 `#FAF8F4`；表体行 58px（两行内容）/ 40–42px（单行） | CreditAdjust:74、Orders:61 |
| 状态标签 | 高 22px，圆角 11px，`padding: 0 8px`，12px/600 | 81 处；CreditAdjust:85 |
| 小标记 | 高 18px，圆角 4px，`padding: 0 5px`，11px，行高 16px，带 1px 描边 | 120 处；Accounts:38 |
| 数字角标 | 高 18px，`min-width: 20px`，圆角 9px，`padding: 0 6px`，12px/700，行高 1 | 387 处；Accounts:27 |
| 弹窗 | 宽 480–680px 共 9 个值（520 ×14、560 ×11、500 ×8、540 ×7）；圆角 14px；`padding: 24px`；关闭键 32×32px 圆角 8px 底 `#F6F3EE` | Accounts:137–140 |
| 轻提示 | 右上角 `top: 68px; right: 24px`，圆角 10px，`padding: 10px 8px 10px 14px`，13px 白字，关闭键 28×28px | Accounts:55 |
| 复选 / 单选 | 复选 18px（16 处）、16px（11 处）；单选 16px（12）、14px（7）、13px（1）；`accent-color` 多为 `#C4501B`，6 处为 `#256A42` | CreditAdjust:117、Offline:110 |
| 开关 | 36×20px，滑块 16px，开 `#256A42` / 关 `#CFC7BC` | 脚本 `sw()`；OpsMall:68 |
| 最小点击尺寸 | 常规 32–36px；最小 20px（开关）、24px（OpsNotice:77）、28px（轻提示关闭键） | 桌面端，无 44px 要求 |

---

## 9. 建议的变量清单

值取自源码；存在两端差异的，按第 2 节的建议取值并在“用途”里注明。

### 9.1 两端共用

| 名称 | 值 | 用途 |
| --- | --- | --- |
| color-primary | `#C4501B` | 主按钮底、选中描边、Tab 下划线、角标、图标强调；不作小字文字色 |
| color-primary-text | `#A63F12` | 强调文字、文字链接 |
| color-primary-bg | `#FBEDE5` | 强调浅底、图标底、头像底 |
| color-primary-bg-subtle | `#FFF8F3` | 选中项浅底 |
| color-text-primary | `#1D1A16` | 正文、标题 |
| color-text-regular | `#4A433B` | 次级正文、中性标签文字、图标（后台把 `#5E564C` 并入） |
| color-text-secondary | `#6F665B` | 辅助说明、表头、占位符 |
| color-text-disabled | `#9A9084` | 禁用与未开放项；不承载必须阅读的信息 |
| color-text-inverse | `#FFFFFF` | 主色 / 深色底上的文字 |
| color-bg-page / color-bg-card | `#F6F3EE` / `#FFFFFF` | 页面底色 / 卡片、输入框、弹层 |
| color-bg-subtle | `#FAF8F4` | 卡片内浅块、表头、上传占位 |
| color-bg-inverse | `#1D1A16` | 深色卡片、轻提示、选中筛选项 |
| color-fill-neutral | `#F0EBE3` | 中性标签底、中性说明块（合并 `#F1ECE4` `#EFEBE4` `#F3EFE9`） |
| color-fill-disabled | `#D6CFC4` | 禁用按钮底、开关关闭轨道（合并 `#CFC7BC`） |
| color-border | `#E7E1D8` | 输入框、小按钮描边 |
| color-border-light | `#ECE6DD` | 卡片描边、顶栏 / 底栏分隔 |
| color-divider | `#F0EBE3` | 行分隔线 |
| color-border-strong | `#C9C0B3` | 次按钮描边、虚线占位（后台现为 `#DDD5C9`，待拍板） |
| color-success / color-success-bg | `#256A42` / `#E6F2EA` | 成功、已完成 |
| color-info / color-info-bg | `#2E5AAC` / `#E8EEF9` | 进行中 |
| color-warning / color-warning-bg | `#A63F12` / `#FBEDE5` | 待处理（与 primary-text / primary-bg 同值） |
| color-danger / color-danger-bg | `#B42318` / `#FBE9E7` | 错误、失效、危险操作 |
| color-mask | `rgba(29, 26, 22, 0.45)` | 弹层遮罩 |
| font-family-sans | `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif` | 全部界面文字 |
| font-family-serif | `'Noto Serif SC', serif` | 品牌字、海报剧名、头像首字；后台页面标题与统计数字 |
| font-weight-regular / semibold / bold / black | `400` / `600` / `700` / `900` | 正文 / 标题与按钮 / 数字强调 / 仅衬线体 |
| font-size-11 / 12 / 13 / 14 / 15 / 16 | `11px` … `16px` | 共用的字号刻度，语义别名分端定义 |
| space-2 / 4 / 6 / 8 / 10 / 12 / 14 / 16 / 20 / 24 | 同名数值（px） | 间距阶梯 |
| radius-xs / radius-sm | `2px` / `4px` | 进度条、细条 / 方角标签、小标记 |
| radius-md | `8px` | 缩略图（M）、控件（A） |
| radius-lg | `10px` | 提示条、轻提示、内嵌块；商家端输入框 |
| radius-pill | `999px` | 胶囊按钮、筛选项、角标、状态标签 |
| border-width / border-width-strong | `1px` / `2px` | 常规描边 / Tab 下划线与选中描边 |
| size-checkbox / size-switch | `18px` / `36px × 20px`（滑块 `16px`） | 复选框与单选框 / 开关（商家端现为 34×20） |

### 9.2 仅商家端

| 名称 | 值 | 用途 |
| --- | --- | --- |
| color-accent-on-dark | `#F2B48F` | 深色卡片上的强调文字、会员徽标 |
| color-fill-track | `#ECE6DD` | 分段控件轨道 |
| font-size-title | `17px`（600） | 页面标题、弹层标题 |
| font-size-heading | `16px`（600） | 卡片 / 区块标题 |
| font-size-body | `15px` | 按钮、输入框、列表主标题 |
| font-size-body-sm | `14px` | 表单标签、多行输入、Tab |
| font-size-caption / -tag / -mini | `13px` / `12px` / `11px` | 辅助说明与小按钮 / 标签与标签栏文字 / 数字角标 |
| font-size-number-md / -lg / -xl | `20px` / `28px` / `32px`（700，行高 1.1） | 积分、金额、余额（源码有 18 / 20 / 22 与 26 / 28 / 30 / 32，建议收敛） |
| line-height-body | `1.5` | 多行说明 |
| space-page / space-section | `16px` / `12px` | 页面左右边距与卡片内边距 / 卡片之间与卡片内分组 |
| radius-card / radius-input / radius-sheet | `14px` / `10px` / `16px 16px 0 0` | 卡片 / 输入框 / 底部弹层 |
| height-tabbar / height-footer | `64px` / `72px` | 底部标签栏 / 底部操作栏 |
| height-button / -sm / height-chip | `46px` / `32px` / `34px` | 主次按钮 / 小按钮 / 筛选项 |
| height-input / height-search | `44px` / `40px` | 输入框 / 搜索框 |
| height-list-row | `52px` | 列表行最小高度 |
| size-touch-min | `44px` | 最小触控尺寸 |
| size-icon / size-icon-tile | `22px`（描边 1.8）/ `44px` | 图标 / 图标底 |
| color-switch-on | `#C4501B` | 开关开启（后台为绿色，待拍板） |

### 9.3 仅后台

| 名称 | 值 | 用途 |
| --- | --- | --- |
| color-sidebar-bg | `#231F1B` | 侧栏底色 |
| color-sidebar-text / -muted | `#E9E2D8` / `#9A9084` | 菜单文字 / 副标题与标记 |
| color-sidebar-divider / -tag-border | `#3A332C` / `#5A5047` | 侧栏分隔 / 标记描边 |
| color-sidebar-badge-bg / -text | `#E8864F` / `#231F1B` | 侧栏数字角标 |
| color-danger-border / color-danger-bg-subtle | `#E8B4AE` / `#FFF7F5` | 危险描边按钮 / 异常行底色 |
| color-success-bg-subtle / color-success-border | `#F4FAF6` / `#B9DCC5` | 已确认项的底与描边 |
| color-purple / color-purple-bg | `#6B3E86` / `#F1E9F5` | “调整”类标签 |
| color-toast-icon / color-switch-on | `#7FD19B` / `#256A42` | 深色轻提示里的对勾 / 开关开启 |
| color-chart-1…4 / -empty / -grid | `#C4501B` `#E39463` `#963F16` `#2A6FC9` / `#D9D1C6` / `#EFEAE2` | 报表图表 |
| font-size-base / -body | `14px` / `13px` | 根字号、菜单、按钮、Tab / 表格、表单、说明 |
| font-size-caption / -mini | `12px` / `11px` | 表头、标签、辅助 / 小标记 |
| font-size-h1 | `24px`（衬线 700，行高 1.3） | 页面标题 |
| font-size-h2 / h3 / h4 | `18px` / `16px` / `15px`（600） | 面板与弹窗标题 / 区块标题 / 卡片小标题 |
| font-size-stat | `24px`、`28px`（衬线 700） | 统计数字 |
| line-height-body / -title | `1.6` / `1.3` | 段落 / 标题与两行单元格 |
| layout-sidebar-width / layout-header-height | `216px` / `56px` | 侧栏 / 顶栏 |
| layout-content-padding / layout-section-gap | `20px 24px 24px` / `16px` | 内容区 / 区块间距 |
| radius-control / radius-icon-button | `8px` / `6px` | 按钮、输入框、下拉、菜单项 / 28–30px 图标按钮 |
| radius-card / radius-modal | `12px` / `14px` | 卡片 / 弹窗 |
| height-control-sm / -md / -lg | `32px` / `36px` / `40px` | 按钮与输入框三档（把 34、38 并入） |
| height-tab / height-table-header | `46px` / `40px` | Tab / 表头 |
| height-table-row / -row-double | `42px` / `58px` | 单行 / 两行内容的表体行 |
| height-tag / height-badge | `22px` / `18px` | 状态标签 / 数字角标与小标记 |
| width-modal-sm / -md / -lg | `480px` / `560px` / `680px` | 弹窗（现有 9 个值，建议收敛）；抽屉 480px |
| shadow-toast / shadow-modal | `0 8px 24px rgba(29, 26, 22, 0.18)` / `0 24px 48px rgba(29, 26, 22, 0.24)` | 轻提示与浮层 / 弹窗 |
| shadow-drawer / shadow-knob | `-12px 0 32px rgba(29, 26, 22, 0.18)` / `0 1px 2px rgba(29, 26, 22, 0.25)` | 右侧抽屉 / 开关滑块 |

---

落地提示（归纳，非源码结论）：后台接入 Ant Design 6 时主题种子可取 `colorPrimary #C4501B`、`colorSuccess #256A42`、`colorInfo #2E5AAC`、`colorError #B42318`、`colorTextBase #1D1A16`、`colorBgLayout #F6F3EE`、`colorBorder #E7E1D8`、`borderRadius 8`、`fontSize 13`、`controlHeight 36`，主色文字单独指定为 `#A63F12`；商家端接入 NutUI React Taro 时主按钮为纯色，主色的渐变端点变量需设成同一个值（变量名以 NutUI 文档为准）；原型按 390px 宽绘制，与 NutUI 的 375px 基准、Taro 默认 750px 设计稿宽的换算比例需先定。
