# 单剧价格修订（W3-10）

写侧在 billing，剧名/状态/授权期通过 content 公开只读接口取得。
调价和撤销都用剧目 UUID 命名的事务级咨询锁串行，然后在该锁内读取注入时钟和当前价格。
保存确认的是此刻 P；未来 newPoints 是生效时的自定义价或模板价快照。
修订只增，撤销只记录 cancelledAt；冻结订单和积分流水均不改写。
模板模式必须有热度等级、customPoints=null、restore_template；自定义为整数且至少100。
归档、已过授权期及停止订购期拒绝调价；未生效且未撤销才可撤销。

P(drama,time) 按修订与模板的 effectiveAt 读取，timer 延迟不改变真实当前价格。
立即修改同事务发 price_changed；未来 timer 使用正式去重键，只发一次。
等级订阅仅对事件发生时 template 模式的实际价变化发事实，custom 不受影响。
商城内部 home 快照键含 SQL 读取的价目来源修订/等级版本，因此时间边界或等级变化立即失效。
这是内部缓存键，无新增公开 siteVersion；即时 API 的既有 site.bump 只是额外信号。

等级模板接口只读，模板修改仍归 W4-07；价格接口和详情均下发服务端 actions/planPrices。
W3-12 使用 confirm.currentPoints，过时确认必须刷新；不计算价格、不把 future 记录提前当当前价。
