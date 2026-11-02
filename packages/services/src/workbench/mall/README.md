# 商城与首页读侧

`createMall` 在既有 workbench/mall 拼装公开 content/config/billing/media 事实，没有第二套商城域。列表 q 与 search 共用 content 三字段 matcher；搜索优先剧名，其次题材/主演，题材显示名双向包含。只搜索 shared/catalog 当前可见且可订的剧，游客和店员不带 discountedPoints，老板套餐价格每次取当前账本事实。

独立 search 未命中时，才按正式 catalog.search.industry_fallback 参数尝试精确二级品类名，取启用、可选品类的父一级行业推荐。list 的 q 不做兜底。totalApprox 封顶999，不持久化或上传关键词。

详情预告片 brief 在 `weapp.video.trailer.enabled` 开启时经 content/media 的公开只读投影取得：只返回已上架剧目的当前平台预告片，资产须 ready、未退役且有时长。替换 target 处理中仍使用原 current；没有合格 current 时返回 null。brief 复用详情已签的公共剧海报，不签播放源、不承诺最终可播；播放地址仍由 `m.playable.get` 重新校验当前引用、文件、开关并签发。此读取对游客、店员、老板一致，不新增后台或制作链。

查询快照最多128份，键含已发布 mall 修订号、真实价目修订 source、查询条件（不含 cursor）；每份固定排序标识与60秒期限。游标只编码快照令牌和 offset，坏游标、版本变化或期限到点重置第一页。同查询复用排序，其他查询不会覆盖它；每次仍取当前可见目录复核，停订和授权到期不泄露缓存真值。快照不包含任何用户钱包、折扣、签名或购买模式。

首页公共快照只保留一份 Banner/热门/新剧的标识排序，期限为 min(60秒, 下一个 Banner 或公告边界)。site 缓存版本、配置修订和真实价格版本变化会失效；签名与当前可见条件每次重校验。个性推荐、财务概览和购买策略公告正文现算。老板的设备事实来自 X-Client-Platform/X-App-Version，不能用后台通知的保守全平台模式代替。未授权真实运营发布，测试只在 APP_ENV=test 的隔离库与假存储执行。
