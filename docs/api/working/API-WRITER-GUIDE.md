# 接口文档：写作规范（每份接口文档的作者必读）

你负责 20 份接口文档中的一份。产出两个文件，两者一致：

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| 文档 | `docs/api/<文档>.md` | 给人读的接口定义 |
| 结构化清单 | `docs/api/working/frag/<文档>.json` | 供脚本核对的接口清单（格式见第 4 节） |

## 1. 依据与优先级

1. `docs/api/working/api-rulings.md`（接口裁决 A1–A156）
2. `docs/api/00-conventions.md`（通用约定，按裁决修订过；单个接口的写法模板在里面）与 `docs/api/working/resources.json`（资源登记表）
3. `docs/api/working/routemap.json` 里 `doc` 等于你这份文档的全部接口：**接口清单以它为准**，一个不少；确需增删时不要直接改，写进返回的 `routemap_changes`
4. 数据模型（字段、枚举、状态机、守卫、快照结构的唯一依据）：`docs/data-model/*.md`、`schema.prisma`、`constraints/`
5. 设计草案 `docs/appendix/design/d1–d9` 的接口章节（请求、响应、错误码的细节常在这里）
6. 页面：`design/design-spec.md`（第 11、12 节）、`docs/appendix/research/proto-*.md`、`design/prototype/*/src/*.dc.html`（页面上显示与录入的每个字段，都要在接口里有来源或去处）
7. 《PRD》第 7 稿（不在仓库里）

## 2. 文档格式（`docs/api/<文档>.md`）

```
# <文档标题>

| 项 | 内容 |
| 范围 | 本文覆盖的页面与功能（画板名） |
| 接口数 | N（V1.0 x，V1.1 y） |
| 依据 | 数据模型分组、草案章节 |

## 1. 概览
一段话 + 一张表：operationId | 方法 路径 | 用途 | 鉴权 | 幂等。

## 2. 公共结构
本文多个接口共用的请求与响应结构（如 OrderCard、OrderDetail）。每个结构一张字段表：
| 字段 | 类型 | 必有 | 说明 | 来源（表.列 或计算规则） |
类型写 JSON 类型并注明格式：string(uuid)、integer(分)、integer(积分)、string(date-time)、string(date)、string(bigint)、enum(取值见…)、boolean、array<…>、object、可空写 “| null”。
店员视图（clerkView = trimmed）的结构单列一张表，或在老板视图上标出“店员不返回”的字段。

## 3. 接口

### 3.x <operationId>　<中文名>
`METHOD /path`

| 项 | 内容 |
| 鉴权 | xAuth；能力点或权限点；店员视图 |
| 幂等 | required / natural（约束名）/ none（理由） |
| 乐观锁 | 是否带 lockVersion |
| 对应画板 | … |

**请求**：路径参数、查询参数、请求体，各一张表（字段 | 类型 | 必填 | 约束 | 说明）。没有的写“无”。
**响应**：`data` 的结构（引用第 2 节的结构或单列字段表）；列表接口写分页方式。
**错误**：本接口可能返回的错误码（只列业务错误；通用错误按约定不必重复）：| 错误码 | HTTP | 何时 |
**副作用**：触发的状态迁移（按数据模型状态机表写“表: 旧状态 → 新状态”）、发出的出站事件、写的审计、登记或取消的定时器。没有写“无”。
**说明**：守卫、计算规则、与页面的对应、受平台约束的改动、待确认点。

## 4. 枚举
本文用到的枚举：名称、取值、含义；与数据模型同名枚举一致时写“同数据模型 <表.列>”。

## 5. 错误码
本文新定义的领域错误码：符号名、数值、HTTP、含义。数值按约定的模块分段取，不与其他文档冲突（在你的模块段内取号）。

## 6. 待确认
会影响接口形态、需要产品、业务、法务决定的问题，各带默认做法。

## 7. 修订记录
```

文风：中文，短句，表格优先，不写实现代码。字段名用小驼峰（接口），表列名用蛇形（数据库）；说明里引用表列写 `表.列`。

## 3. 写作要求

- `routemap.json` 里本文的每一条接口都要写到上面的粒度，包括 V1.1 的（V1.1 可以只写一行用途并标“V1.1，细节待设计”）。
- 请求与响应的字段要能追到数据模型：返回的业务字段写清楚来自哪张表的哪一列，或怎样算出来；写入的字段写清楚落到哪一列。数据模型里没有的列不要凭空返回；需要时写进 `routemap_changes` 或 `issues`。
- 金额一律整数分、积分一律整数；时间一律 ISO 8601（约定的格式）；bigint 出接口为字符串；枚举取值与数据模型完全一致（小写蛇形）。
- 状态迁移按数据模型状态机表逐行对上（迁移名、守卫、副作用）；守卫不满足返回哪个错误码要写出来。
- 页面上显示的每个字段、每个操作都要有接口承载；页面需要而接口没有的，写进 `issues`。
- 受平台约束（设计规范第 11 节）与业务确认（docs/05 第 0 节）的改动要体现。

## 4. 结构化清单（`docs/api/working/frag/<文档>.json`）

```json
{
  "doc": "m04-mall-order",
  "endpoints": [
    {
      "operationId": "m.order.create",
      "method": "POST",
      "path": "/m/orders",
      "section": "3.5",
      "requestSchemas": ["OrderCreateBody"],
      "responseSchema": "OrderDetail",
      "errors": ["DRAMA_NOT_ORDERABLE", "POINTS_INSUFFICIENT"],
      "events": ["order.placed"],
      "permission": null,
      "capability": "order.place",
      "transitions": ["drama_order: (新建) → pending_start"]
    }
  ],
  "schemas": [ { "name": "OrderDetail", "fields": ["orderId", "orderNo", "status"] } ],
  "errorCodes": [ { "symbol": "DRAMA_NOT_ORDERABLE", "code": 44021, "http": 409, "meaning": "剧目当前不可订购" } ],
  "permissions": [ "order.cancel.request" ],
  "capabilities": [ "order.place" ]
}
```

`errors` 里的符号要么在约定的通用错误码里，要么在本文件的 `errorCodes` 里定义（或在其他文档的清单里定义，写明来源）。`permissions` / `capabilities` 列出本文用到的全部权限点与能力点。

## 5. 返回

返回结构化摘要：两个文件路径、接口数、`issues`（需要主负责人处理的）、`routemap_changes`（建议增删改的接口）、`cross_doc`（需要其他文档配合的，写明文档与内容）。
