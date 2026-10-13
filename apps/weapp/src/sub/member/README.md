# 门店与成员六页（W2-14）

门店管理、新店、本人店员档案位于 `sub/profile/stores`、`store-add`、`staff-profile`；成员管理、邀请、加入位于本目录。入口在既有“我的”和门店档案页。原环境上传页仍是 `sub/profile/store`，上传协议未改。

`members/api.ts` 直接消费生成的 merchant operations，生产经中央 request。老板的可写按钮只取真实 actions、额度和 SeatInfo；店员只展示所属门店、裁剪成员与本人素材事实。门店动作绑定对应卡片 ID；新建/接受后的选店使用返回 storeId，经账户后读、实际成员资格和当前选店记忆继续，不能用列表首项代替。

页面私有 action 以 token、门店、修订号和成员范围隔离意图，失败同体重试沿用键。旧读、旧错误和旧 finally 不写新上下文。选店另传页面存活守卫，允许自己的合法选店修订，但离页、切账号或额外切店后不能迟到导航。建店返回成功即显示回执并禁止重复 POST；后续选店失败可按该返回 ID 继续。

邀请创建只用正式自然 clientRequestId。原生分享发起时 markShared 只记分享尝试，未推断 accepted；未分享离页沿正式 unshared_leave 撤回。分享链接只含邀请 token，不含手机号或备注。加入先公开 lookup；四个真实状态和无效链接均正常展示。手机号登录用 member_join 当前协议版本；已有会话接受沿中央 428 恢复，用户级请求显式 store:false。登录后的自动接受只归属于本次新 token、页面代次及一次允许的自有 reload。

原档案私有增量包括变更确认与 pendingChange、initial/change/new_store 资质轮次、联系人发码/次数、证照查看/草稿移除/放弃和历史分页。证照与声明按真实编辑锁处理，联系人在审核及终局后仍可编辑，审核快照由后端保留；runtime 等待后、真正写请求前再次复核本次页面上下文。

默认地址沿字典与手填。正式建店 DTO 只有地址文本，结构化区划在原档案继续核对；不伪造区划字段、坐标或未批准地图能力。分享、微信手机号、短信真实投递和地图隐私审批仍由 W2-30 后继实机验证，离线样张不代表平台通过。

## 定点验证

六个私有 model/runtime 文件各一聚合组：

```sh
pnpm --filter @liyoxi/weapp exec vitest run \
  src/sub/profile/stores/model.test.ts \
  src/sub/profile/store-add/model.test.ts \
  src/sub/profile/staff-profile/model.test.ts \
  src/sub/member/members/model.test.ts \
  src/sub/member/invite/runtime.test.ts \
  src/sub/member/join/runtime.test.ts
```

八个新增 H5 样张保留原全部场景；附原审核进度一态兼容回归，一次构建精确选择：

```sh
LYX_E2E_CHANNEL=chrome pnpm weapp:shots -- \
  --scene tenant-stores-owner --scene tenant-store-add \
  --scene tenant-staff-profile --scene tenant-members-owner \
  --scene tenant-invite-owner --scene tenant-join-pending \
  --scene tenant-stores-clerk --scene tenant-join-expired \
  --scene review-rejected
```

数据在 `shots/tenant-data.ts`、私有运行替身在 `tenant-fixtures.ts`，场景与交互在 `tenant-scenes.ts`、`tenant-regressions.mjs`。仅 TARO_ENV=h5 且加载前显式 global 标记可启用，普通 URL 参数不能启用。未知请求直接失败，截图脚本继续拦截外发网络和页面错误，每场景独立浏览器上下文。状态文字复用商家中文标签，时刻与加入日期复用北京时间格式；回放等待成员遮罩卸载，新店回执滚入截图。新店场景提交一次并注入后续选店失败，验证成功回执及禁重复创建；成员场景保存真实第二家店范围，邀请场景保存新内容并撤回。PNG 在 `shots/dist/png/tenant__<scene>.png`。

ROOT 本地六聚合、八个新增样张及原审核进度一态、类型和正式构建均通过，唯一独审及显示修正已闭环。后续只复跑实际失败目标，保留原场景；体积与每轮来源见 W2-14 状态文件。
