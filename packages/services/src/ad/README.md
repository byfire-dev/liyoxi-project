# 广告取消拥有者公口

`claimAdCancelRequest` 在调用方稳定锁图内占用本广告指针；`cancelAd` 只实现正式 ad.cancel 的09:808/809两行，returned 按真实 returnedFrom 选择，不新增 M5 广告生命周期 producer。取消状态、时间、原因及指针同一 UPDATE，真实账本回调随后在同 Tx 返回实际数量，四个累计列一起写，最后发送严格 ad.cancelled（returnedPoints 表示原路＋转加购，三值分别存行）。

调用方须先按全局顺序锁全申请/明细/主体/门店/广告/活跃绑定订单及项，并在唯一账户420前预锁本广告相关 timer；本入口只重入已持广告锁。取消精确匹配本广告首版/修改版 SLA 及待补充陈旧 timer，保留其他用途、其他广告、历史版本和超次修改扣减。关闭未执行申请仍复用 clearAdCancelRequestPointers，仅清本申请，历史客服引用不删除。

执行回调、实际数量、事件、历史全属同事务；调用方失败全部回滚。未提供广告提交、指派、版本推送、确认或其到点 producer，也没有 delivery_ticket 暂停。
