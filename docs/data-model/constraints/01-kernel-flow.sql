-- 分组 01-kernel-flow：内核与流程基础（kernel、events、timers、flow、sla）的手写约束。
-- 依据：docs/data-model/01-kernel-flow.md；docs/appendix/design/d3-flow.md 第 19–22、25 节；d7-platform.md 第 3.1 节。
-- 只含 Prisma 表达不了的约束：CHECK、部分唯一索引、部分索引、表达式索引、触发器。本分组没有放在这里的外键。
-- 触发器函数用 00-common.sql 里的 lyx_forbid_mutation()、lyx_write_once()。
-- 跨模块多态类型列（outbox_event.aggregate_type、timer.subject_type、status_transition.machine）只做格式校验（M52）：
-- 取值一律是最终表名（M19），清单登记在 packages/contract，启动时对照表名单校验；数据库不逐值 CHECK。

-- idempotency_record
ALTER TABLE idempotency_record ADD CONSTRAINT ck_idempotency_record_state
  CHECK (state IN ('done','in_progress'));
-- 操作人键的类型段只用四类操作人；下载页请求写商家用户，不写 portal。
ALTER TABLE idempotency_record ADD CONSTRAINT ck_idempotency_record_actor_key
  CHECK (actor_key ~ '^(merchant|staff|system|partner):.+$');
ALTER TABLE idempotency_record ADD CONSTRAINT ck_idempotency_record_key
  CHECK (key ~ '^[A-Za-z0-9:_-]{1,128}$');
ALTER TABLE idempotency_record ADD CONSTRAINT ck_idempotency_record_request_hash
  CHECK (request_hash ~ '^[0-9a-f]{64}$');
-- 三段式占用中必有占用到期时间。
ALTER TABLE idempotency_record ADD CONSTRAINT ck_idempotency_record_lock
  CHECK (state <> 'in_progress' OR locked_until IS NOT NULL);
ALTER TABLE idempotency_record ADD CONSTRAINT ck_idempotency_record_expires
  CHECK (expires_at > created_at);

-- biz_sequence
ALTER TABLE biz_sequence ADD CONSTRAINT ck_biz_sequence_prefix
  CHECK (prefix ~ '^[A-Z]{2,4}$');
ALTER TABLE biz_sequence ADD CONSTRAINT ck_biz_sequence_next_val
  CHECK (next_val >= 1);

-- outbox_event
ALTER TABLE outbox_event ADD CONSTRAINT ck_outbox_event_event_type
  CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');
-- 聚合类型：格式校验（小写蛇形的表名），已知取值见文档 3.4（M52）。
ALTER TABLE outbox_event ADD CONSTRAINT ck_outbox_event_aggregate_type
  CHECK (aggregate_type ~ '^[a-z][a-z0-9_]*$');
-- 聚合类型与聚合 id 同有同无（没有聚合行的系统级事件两列都为空）。
ALTER TABLE outbox_event ADD CONSTRAINT ck_outbox_event_aggregate_pair
  CHECK ((aggregate_type IS NULL) = (aggregate_id IS NULL));
-- 有门店必有主体。
ALTER TABLE outbox_event ADD CONSTRAINT ck_outbox_event_tenant
  CHECK (store_id IS NULL OR entity_id IS NOT NULL);
ALTER TABLE outbox_event ADD CONSTRAINT ck_outbox_event_actor_type
  CHECK (actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE outbox_event ADD CONSTRAINT ck_outbox_event_client
  CHECK (client IN ('weapp','portal','admin'));
ALTER TABLE outbox_event ADD CONSTRAINT ck_outbox_event_actor_role
  CHECK (actor_role IN ('owner','clerk'));
-- 系统动作没有操作人 id 与客户端来源；其余类型必有操作人 id；角色快照只属于商家。
ALTER TABLE outbox_event ADD CONSTRAINT ck_outbox_event_actor
  CHECK ((actor_type = 'system') = (actor_id IS NULL)
         AND (actor_type <> 'system' OR client IS NULL)
         AND (actor_role IS NULL OR actor_type = 'merchant'));
-- 负载是对象，且带数字版本号 v。
ALTER TABLE outbox_event ADD CONSTRAINT ck_outbox_event_payload
  CHECK (jsonb_typeof(payload) = 'object' AND payload ? 'v' AND jsonb_typeof(payload -> 'v') = 'number');
-- 中继扫描：WHERE published_at IS NULL ORDER BY seq LIMIT 200 FOR UPDATE SKIP LOCKED。
CREATE INDEX ix_outbox_event_unpublished ON outbox_event (seq) WHERE published_at IS NULL;
-- 受限更新：只允许把 published_at 从空写一次，其余列不可改，不可删（V1.0 不清理事件行，M65）。
CREATE TRIGGER trg_outbox_event_write_once BEFORE UPDATE OR DELETE ON outbox_event
  FOR EACH ROW EXECUTE FUNCTION lyx_write_once('published_at');
CREATE TRIGGER trg_outbox_event_no_truncate BEFORE TRUNCATE ON outbox_event
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- outbox_delivery
ALTER TABLE outbox_delivery ADD CONSTRAINT ck_outbox_delivery_status
  CHECK (status IN ('pending','leased','done','retry','dead'));
-- 订阅者注册名进任务 jobId：只排除冒号、连字符等会破坏 jobId 的字符，大小写都允许（如 support.onBizEvent）。
ALTER TABLE outbox_delivery ADD CONSTRAINT ck_outbox_delivery_subscriber
  CHECK (subscriber ~ '^[A-Za-z][A-Za-z0-9_.]{0,63}$');
ALTER TABLE outbox_delivery ADD CONSTRAINT ck_outbox_delivery_counters
  CHECK (attempts >= 0 AND dispatch_no >= 0);
ALTER TABLE outbox_delivery ADD CONSTRAINT ck_outbox_delivery_lease
  CHECK (status <> 'leased' OR lease_until IS NOT NULL);
ALTER TABLE outbox_delivery ADD CONSTRAINT ck_outbox_delivery_consumed
  CHECK ((status = 'done') = (consumed_at IS NOT NULL));
-- 派发扫描：到期的待派发行。
CREATE INDEX ix_outbox_delivery_due ON outbox_delivery (next_attempt_at) WHERE status IN ('pending','retry');
-- 派发扫描：租约过期的行（入队丢失、Redis 丢数据、处理器失联）。
CREATE INDEX ix_outbox_delivery_lease ON outbox_delivery (lease_until) WHERE status = 'leased';
-- 后台“流程运维”的死信列表与死信数探针。
CREATE INDEX ix_outbox_delivery_dead ON outbox_delivery (subscriber, outbox_event_id) WHERE status = 'dead';

-- timer
ALTER TABLE timer ADD CONSTRAINT ck_timer_kind
  CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');
ALTER TABLE timer ADD CONSTRAINT ck_timer_status
  CHECK (status IN ('scheduled','dispatched','fired','skipped','cancelled','failed'));
-- 主体类型：格式校验（小写蛇形的表名），已知取值见文档 3.3（M52）。
ALTER TABLE timer ADD CONSTRAINT ck_timer_subject_type
  CHECK (subject_type ~ '^[a-z][a-z0-9_]*$');
-- 周期任务的定时器行没有主体：两列同为空（M45）。
ALTER TABLE timer ADD CONSTRAINT ck_timer_subject_pair
  CHECK ((subject_type IS NULL) = (subject_id IS NULL));
-- 有门店必有主体。
ALTER TABLE timer ADD CONSTRAINT ck_timer_tenant
  CHECK (store_id IS NULL OR entity_id IS NOT NULL);
ALTER TABLE timer ADD CONSTRAINT ck_timer_counters
  CHECK (attempts >= 0 AND dispatch_no >= 0);
ALTER TABLE timer ADD CONSTRAINT ck_timer_lease
  CHECK (status <> 'dispatched' OR lease_until IS NOT NULL);
ALTER TABLE timer ADD CONSTRAINT ck_timer_fired
  CHECK ((status IN ('fired','skipped')) = (fired_at IS NOT NULL));
ALTER TABLE timer ADD CONSTRAINT ck_timer_payload
  CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object');
ALTER TABLE timer ADD CONSTRAINT ck_timer_result
  CHECK (result IS NULL OR jsonb_typeof(result) = 'object');
-- 同一语义目标在未取消的行里唯一；已取消的行不占键。
CREATE UNIQUE INDEX uq_timer_dedupe_key_live ON timer (dedupe_key) WHERE status <> 'cancelled';
-- 扫描认领：到期（或到重试时间）的 scheduled 行；也是“定时器滞后”探针的索引。
CREATE INDEX ix_timer_due ON timer ((COALESCE(retry_at, fire_at))) WHERE status = 'scheduled';
-- 扫描认领：租约过期的 dispatched 行。
CREATE INDEX ix_timer_lease ON timer (lease_until) WHERE status = 'dispatched';
-- timers.cancel(subject, …) 与不变量 I7 按主体找未完成的定时器。
CREATE INDEX ix_timer_subject ON timer (subject_type, subject_id) WHERE status IN ('scheduled','dispatched');
-- 后台“失败的定时器”列表与失败数探针。
CREATE INDEX ix_timer_failed ON timer (fire_at) WHERE status = 'failed';

-- status_transition
-- 状态机名：格式校验（小写蛇形的表名），只收 25 张业务状态机表，已知取值见文档 3.2（M52）。
ALTER TABLE status_transition ADD CONSTRAINT ck_status_transition_machine
  CHECK (machine ~ '^[a-z][a-z0-9_]*$');
-- 被迁移的状态列名（M53），如 status、lifecycle、qualification_status。
ALTER TABLE status_transition ADD CONSTRAINT ck_status_transition_state_field
  CHECK (state_field ~ '^[a-z][a-z0-9_]*$');
-- 有门店必有主体。
ALTER TABLE status_transition ADD CONSTRAINT ck_status_transition_tenant
  CHECK (store_id IS NULL OR entity_id IS NOT NULL);
ALTER TABLE status_transition ADD CONSTRAINT ck_status_transition_actor_type
  CHECK (actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE status_transition ADD CONSTRAINT ck_status_transition_client
  CHECK (client IN ('weapp','portal','admin'));
-- 系统动作没有操作人 id 与客户端来源；其余类型必有操作人 id。
ALTER TABLE status_transition ADD CONSTRAINT ck_status_transition_actor
  CHECK ((actor_type = 'system') = (actor_id IS NULL)
         AND (actor_type <> 'system' OR client IS NULL));
-- 业务日 = 发生时间按 Asia/Shanghai 取日。
ALTER TABLE status_transition ADD CONSTRAINT ck_status_transition_biz_date
  CHECK (biz_date = (occurred_at AT TIME ZONE 'Asia/Shanghai')::date);
-- 两个时长都是与同一链（machine, subject_id, state_field）上一行之间的时长，from = to 的行照常切段（A144）。
ALTER TABLE status_transition ADD CONSTRAINT ck_status_transition_elapsed
  CHECK (elapsed_seconds >= 0 AND elapsed_work_min >= 0);
-- 人工纠偏：事件名 admin.force 与 is_forced 一一对应；只能由员工发起，说明去掉首尾空白后不少于 10 个字。
ALTER TABLE status_transition ADD CONSTRAINT ck_status_transition_forced
  CHECK ((event = 'admin.force') = is_forced
         AND (NOT is_forced OR (actor_type = 'staff' AND note IS NOT NULL AND char_length(btrim(note)) >= 10)));
ALTER TABLE status_transition ADD CONSTRAINT ck_status_transition_payload
  CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object');
-- 只增表：拦截 UPDATE、DELETE、TRUNCATE。
CREATE TRIGGER trg_status_transition_append_only BEFORE UPDATE OR DELETE ON status_transition
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();
CREATE TRIGGER trg_status_transition_no_truncate BEFORE TRUNCATE ON status_transition
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- work_calendar_day
ALTER TABLE work_calendar_day ADD CONSTRAINT ck_work_calendar_day_kind
  CHECK (kind IN ('weekday','weekend','holiday','adjusted_workday'));
-- 是否工作日由类型决定：平日、调休上班是工作日；周末、放假不是。
ALTER TABLE work_calendar_day ADD CONSTRAINT ck_work_calendar_day_kind_workday
  CHECK (is_workday = (kind IN ('weekday','adjusted_workday')));
-- 类型与星期一致：平日只能落在周一至周五，周末与调休上班只能落在周六、周日；放假不限。
ALTER TABLE work_calendar_day ADD CONSTRAINT ck_work_calendar_day_kind_dow
  CHECK (CASE kind
           WHEN 'weekday' THEN EXTRACT(ISODOW FROM day) BETWEEN 1 AND 5
           WHEN 'weekend' THEN EXTRACT(ISODOW FROM day) IN (6, 7)
           WHEN 'adjusted_workday' THEN EXTRACT(ISODOW FROM day) IN (6, 7)
           ELSE true
         END);
ALTER TABLE work_calendar_day ADD CONSTRAINT ck_work_calendar_day_calendar_version
  CHECK (calendar_version >= 1);
