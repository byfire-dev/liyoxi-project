# 授权书用的中文字体

| 项 | 内容 |
| --- | --- |
| 放什么 | 《定制内容授权书》PDF 渲染用的静态 TTF，共 3 个文件，外加两份许可文本 |
| 谁放的 | 工作包 X-03（`docs/plan/tasks/X-03.md` 第 4 节、第 11 节第 1、2 项） |
| 谁用 | W1-22 把本目录的 `.ttf` 拷进 server 镜像；G5-B 的授权书渲染读它。验证工程 `spikes/license-pdf` 默认也读这里 |
| 为什么入库 | 生产机没有系统中文字体，字体随镜像分发（D7 第 7.4 节）。入库是任务书的默认；业主可改为构建时按固定地址与校验和下载 |
| 总体积 | 40,163,236 字节（约 38.3 MiB） |
| 结论出处 | `docs/adr/` 下 X-03 的 ADR |

## 1. 文件

取数日期：2026-10-04。

| 文件 | 字体与字重 | 用在哪 | 字节数 | 字体内版本串 | 校验和 |
| --- | --- | --- | --- | --- | --- |
| `NotoSerifSC-Regular.ttf` | Noto Serif SC（宋体）常规 400 | 正文 | 14,807,636 | Version 2.003-H1 | sha256 `c358a69de3df5f423a8946a7b03e3126fb6ba116f1130a463455b4e39e1f0742` |
| `NotoSerifSC-Bold.ttf` | Noto Serif SC（宋体）粗体 700 | 正文里加粗的小标题、要素表的表头 | 14,806,580 | Version 2.003-H1 | sha256 `9c6a2ba736e4b499c84f65ce366bd3625c0401885fd3e585ace50fb738b96ff6` |
| `NotoSansSC-Bold.ttf` | Noto Sans SC（黑体）粗体 700 | 标题、条款标题 | 10,549,020 | Version 2.004-H2 | sha256 `9a38ae0ab28cd5a256f9ea8e00dedc688aac17f7915fcb000572990afa956b96` |
| `OFL-NotoSerifSC.txt` | — | Noto Serif SC 的许可文本 | 4,445 | — | — |
| `OFL-NotoSansSC.txt` | — | Noto Sans SC 的许可文本 | 4,481 | — | — |

核对：在本目录跑 `shasum -a 256 *.ttf`，与上表逐个比。

三个文件都是静态 TrueType（`glyf` 轮廓，没有 `fvar` 表，不是可变字体，不是 OTF）。

## 2. 来源

| 字体 | 来源 | Google Fonts 的版本号 | 下载地址 |
| --- | --- | --- | --- |
| Noto Serif SC | Google Fonts 的下载清单 `https://fonts.google.com/download/list?family=Noto%20Serif%20SC` 里的 `static/NotoSerifSC-Regular.ttf`、`static/NotoSerifSC-Bold.ttf` | v36 | `https://fonts.gstatic.com/s/notoserifsc/v36/H4cyBXePl9DZ0Xe7gG9cyOj7uK2-n-D2rd4FY7SCqyWv847hdDWC.ttf`（常规）；`https://fonts.gstatic.com/s/notoserifsc/v36/H4cyBXePl9DZ0Xe7gG9cyOj7uK2-n-D2rd4FY7RlrCWv847hdDWC.ttf`（粗体） |
| Noto Sans SC | 同上，`family=Noto%20Sans%20SC` 里的 `static/NotoSansSC-Bold.ttf` | v41 | `https://fonts.gstatic.com/s/notosanssc/v41/k3kCo84MPvpLmixcA63oeAL7Iqp5IZJF9bmaGzjCnYxNbPzS5HE.ttf` |

许可文本取自同一份下载清单里的 `OFL.txt`，原样保存，只改了文件名。Noto Serif SC 那一份的抬头写的是 Google（2012），字体内的版权字段写的是 Adobe（2017–2024）；两处都是上游原样。

为什么不是思源的官方发行（任务书 第 11 节第 1 项，2026-10-04 查实）：

| 查了什么 | 结果 |
| --- | --- |
| Adobe 的 `adobe-fonts/source-han-serif` 发行 2.003R、`adobe-fonts/source-han-sans` 发行 2.005R | 只有 OTF、OTC、子集 OTF 与可变字体，没有静态 TTF |
| Google 的 `notofonts/noto-cjk` 发行 Serif2.003、Sans2.004 | 同上：静态的只有 OTF，TTF 只有可变字体 |
| Google Fonts 的 Noto Serif SC、Noto Sans SC | 下载包的 `static/` 目录提供各字重的静态 TTF。本目录取的就是它 |

是否同源：是。Noto CJK 与思源是 Adobe 与 Google 合作的同一套字形，两个名字。本目录三个文件的版权字段写的都是 Adobe；版本串 2.003、2.004 与思源宋体 2.003、思源黑体 2.004 的版本号相同。思源黑体官方已到 2.005（2025-06），Google Fonts 的 Noto Sans SC 还是 2.004。

## 3. 许可

| 项 | 内容 |
| --- | --- |
| 许可 | SIL Open Font License 1.1，与思源系列相同（D6 第 12 节） |
| 能不能随镜像分发 | 能。许可第 2 条允许与任何软件捆绑、再分发，条件是带上版权声明与许可文本：本目录的两份 `OFL-*.txt` 要跟着 `.ttf` 一起进镜像 |
| 生成的 PDF | 许可写明：用字体生成的文档不受本许可约束。授权书 PDF 里嵌入的是用到的字的子集 |
| 不能做什么 | 不能单独售卖字体文件。Noto Sans SC 的许可带保留字体名 “Source”：改过的字体不能用这个名字 |
| 本目录的约定 | 字体文件原样使用，不改、不裁剪、不改名。要换版本就整个文件替换，同时改本文的校验和 |

## 4. 收了哪些字

读字体的 `cmap` 表得出（验证工程的 `src/coverage.ts`）。

| 范围 | Noto Serif SC（常规、粗体相同） | Noto Sans SC 粗体 |
| --- | --- | --- |
| 码位总数 | 30,928 | 30,890 |
| 基本区 U+4E00–U+9FFF | 20,992，全收 | 20,976 |
| 扩展 A 区 U+3400–U+4DBF | 6,592，全收 | 6,582 |
| 扩展 B 区 | 52 个 | 54 个 |
| 扩展 C、D、E、F 区 | 44、8、108、1 个 | 44、8、108、1 个 |
| 扩展 G 区 | 0 | 3 个 |
| 表情符号 | 没有 | 没有 |

- 三个文件共同收的码位是 30,880 个。渲染前按这个交集查：一个字要三个字体都收了才算收了。
- 收了的生僻字举例：䶮、龘、㙟。《通用规范汉字表》里落在扩展区的字，抽查的 6 个（𬌗、𫖯、𬭚、𫓧、𬬮、𫚕）都收了。
- 没收的字举例：𠮷（U+20BB7）、𰻝（U+30EDD，宋体没收）、全部表情符号。没收的字怎么处理见 ADR。
- 官方没有“收全 6 万多字”的静态 TTF：全量版只有 OTF 与可变字体两种形态，渲染库不支持（D7 第 7.4 节）。

## 5. 更新办法

1. 从第 2 节的下载清单重新取文件，核对版权字段与版本串。
2. 替换文件，改第 1 节的字节数、版本串、校验和与取数日期。
3. 跑 `pnpm --dir spikes/license-pdf render` 与 `test`（验证工程还在的话），看页数与缺字有没有变化。
4. 字体换了款式或换了来源，写一条新 ADR。
