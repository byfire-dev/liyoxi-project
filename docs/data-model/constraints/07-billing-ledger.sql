-- 分组 07-billing-ledger：价目、订阅、积分账本（billing）的手写约束。
-- 依据：docs/appendix/design/d1-ledger.md 第 4.7 节的约束清单；docs/data-model/07-billing-ledger.md。
-- 只含 Prisma 表达不了的约束：CHECK、部分唯一索引、部分索引、排他约束、触发器。外键（含 M47 的归属复合外键）都在 Prisma 片段里。
-- 触发器函数用 00-common.sql 的 lyx_forbid_mutation()、lyx_write_once()，本文件不定义函数。
-- 排他约束依赖 btree_gist（00-common.sql 已启用）。语句可在 PostgreSQL 14 上执行。
-- 第二轮修订（rulings M33、M34、M57、M75 与复核意见）的改动见文档末尾“修订记录”。
-- 第三轮（rulings M93–M110 与其他分组的请求）没有约束改动：ck_ledger_operation_ref_type 已含 payment_exception（M100 的补记渠道退款）。

-- plan
-- CHECK：scope 取值
ALTER TABLE plan ADD CONSTRAINT ck_plan_scope
  CHECK (scope IN ('public','entity'));

-- plan_revision
-- CHECK：revision_no ≥ 1
ALTER TABLE plan_revision ADD CONSTRAINT ck_plan_revision_revision_no
  CHECK (revision_no >= 1);
-- CHECK：月费大于 0
ALTER TABLE plan_revision ADD CONSTRAINT ck_plan_revision_monthly_fee_fen
  CHECK (monthly_fee_fen > 0);
-- CHECK：每月积分大于 0
ALTER TABLE plan_revision ADD CONSTRAINT ck_plan_revision_monthly_points
  CHECK (monthly_points > 0);
-- CHECK：折扣 5000 到 10000
ALTER TABLE plan_revision ADD CONSTRAINT ck_plan_revision_discount_bp
  CHECK (discount_bp BETWEEN 5000 AND 10000);
-- CHECK：production_model 取值
ALTER TABLE plan_revision ADD CONSTRAINT ck_plan_revision_production_model
  CHECK (production_model IN ('standard','advanced','top'));
-- CHECK：门店数不小于 1
ALTER TABLE plan_revision ADD CONSTRAINT ck_plan_revision_max_stores
  CHECK (max_stores >= 1);
-- CHECK：成员数为空或不小于 1
ALTER TABLE plan_revision ADD CONSTRAINT ck_plan_revision_max_members
  CHECK (max_members IS NULL OR max_members >= 1);
-- CHECK：schedule_priority 取值
ALTER TABLE plan_revision ADD CONSTRAINT ck_plan_revision_schedule_priority
  CHECK (schedule_priority IN ('standard','priority','rush'));
-- CHECK：cycle_prices 是对象
ALTER TABLE plan_revision ADD CONSTRAINT ck_plan_revision_cycle_prices
  CHECK (jsonb_typeof(cycle_prices) = 'object');
-- CHECK：legacy_promo 为空或对象
ALTER TABLE plan_revision ADD CONSTRAINT ck_plan_revision_legacy_promo
  CHECK (legacy_promo IS NULL OR jsonb_typeof(legacy_promo) = 'object');
-- CHECK：公告时间与公告记录同有同无
ALTER TABLE plan_revision ADD CONSTRAINT ck_plan_revision_announce_pair
  CHECK ((announced_at IS NULL) = (site_notice_id IS NULL));
-- CHECK：只能在生效前撤销
ALTER TABLE plan_revision ADD CONSTRAINT ck_plan_revision_cancel_before_effective
  CHECK (cancelled_at IS NULL OR cancelled_at < effective_at);
-- 部分唯一索引：同一套餐同一生效时间至多一条未撤销的修订；也是“取当前价目”的索引（倒序扫描）
CREATE UNIQUE INDEX uq_plan_revision_plan_effective ON plan_revision (plan_id, effective_at)
  WHERE cancelled_at IS NULL;
-- 触发器：只允许把 cancelled_at 从空写一次，其余列不可改，不可删（lyx_write_once）
CREATE TRIGGER trg_plan_revision_write_once BEFORE UPDATE OR DELETE ON plan_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_write_once('cancelled_at');

-- plan_promo_claim
-- （无手写约束）

-- point_pack
-- CHECK：积分数不小于 100
ALTER TABLE point_pack ADD CONSTRAINT ck_point_pack_points
  CHECK (points >= 100);
-- CHECK：价格大于 0
ALTER TABLE point_pack ADD CONSTRAINT ck_point_pack_price_fen
  CHECK (price_fen > 0);
-- 部分唯一索引：上架中的积分包积分数不重复
CREATE UNIQUE INDEX uq_point_pack_points_listed ON point_pack (points)
  WHERE is_listed;

-- price_tier_revision
-- CHECK：tier 取值
ALTER TABLE price_tier_revision ADD CONSTRAINT ck_price_tier_revision_tier
  CHECK (tier IN ('S','A','B','C'));
-- CHECK：模板价 100 到 20000
ALTER TABLE price_tier_revision ADD CONSTRAINT ck_price_tier_revision_points
  CHECK (points BETWEEN 100 AND 20000);
-- 触发器：不可改、不可删（lyx_forbid_mutation；M75 按只增处理）
CREATE TRIGGER trg_price_tier_revision_immutable BEFORE UPDATE OR DELETE ON price_tier_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();
-- 触发器：拦截 TRUNCATE（只增表的约定）
CREATE TRIGGER trg_price_tier_revision_no_truncate BEFORE TRUNCATE ON price_tier_revision
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- drama_price_revision
-- CHECK：mode 取值
ALTER TABLE drama_price_revision ADD CONSTRAINT ck_drama_price_revision_mode
  CHECK (mode IN ('template','custom'));
-- CHECK：custom 必填且不小于 100；template 为空
ALTER TABLE drama_price_revision ADD CONSTRAINT ck_drama_price_revision_custom_points
  CHECK ((mode = 'custom' AND custom_points IS NOT NULL AND custom_points >= 100) OR (mode = 'template' AND custom_points IS NULL));
-- CHECK：新价不小于 100；custom 时新价 = custom_points
ALTER TABLE drama_price_revision ADD CONSTRAINT ck_drama_price_revision_new_points
  CHECK (new_points >= 100 AND (mode <> 'custom' OR new_points = custom_points));
-- CHECK：新价不得等于旧价
ALTER TABLE drama_price_revision ADD CONSTRAINT ck_drama_price_revision_points_changed
  CHECK (prev_points IS NULL OR prev_points <> new_points);
-- CHECK：reason_code 取值
ALTER TABLE drama_price_revision ADD CONSTRAINT ck_drama_price_revision_reason_code
  CHECK (reason_code IN ('quality','genre_fit','release_timing','license_remaining','restore_template'));
-- CHECK：只能在生效前撤销
ALTER TABLE drama_price_revision ADD CONSTRAINT ck_drama_price_revision_cancel_before_effective
  CHECK (cancelled_at IS NULL OR cancelled_at < effective_at);
-- 部分唯一索引：同一部剧同一生效时间至多一条未撤销的修订；也是取 P 的索引
CREATE UNIQUE INDEX uq_drama_price_revision_drama_effective ON drama_price_revision (drama_id, effective_at)
  WHERE cancelled_at IS NULL;
-- 触发器：只允许把 cancelled_at 从空写一次，其余列不可改，不可删
CREATE TRIGGER trg_drama_price_revision_write_once BEFORE UPDATE OR DELETE ON drama_price_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_write_once('cancelled_at');

-- billing_param
-- CHECK：key 只能是 12 个登记的键
ALTER TABLE billing_param ADD CONSTRAINT ck_billing_param_key
  CHECK (key IN ('adUnitPoints','adFreeRevisions','topModelSurchargeBp','cancelDeductionBp','expiredTermRefund','minLicenseMonths','renewalReminderDays','prorationBaseDays','planRefundWindowHours','enabledCycles','maxScheduledTerms','noticeDays'));
-- CHECK：value 的 JSON 类型与键匹配：8 个数值键为 number，2 个列表键为 array，2 个映射键为 object
ALTER TABLE billing_param ADD CONSTRAINT ck_billing_param_value_shape
  CHECK (CASE
    WHEN key IN ('adUnitPoints','adFreeRevisions','topModelSurchargeBp','minLicenseMonths','prorationBaseDays','planRefundWindowHours','maxScheduledTerms','noticeDays') THEN jsonb_typeof(value) = 'number'
    WHEN key IN ('renewalReminderDays','enabledCycles') THEN jsonb_typeof(value) = 'array'
    WHEN key IN ('cancelDeductionBp','expiredTermRefund') THEN jsonb_typeof(value) = 'object'
    ELSE false
  END);
-- CHECK：只能在生效前撤销
ALTER TABLE billing_param ADD CONSTRAINT ck_billing_param_cancel_before_effective
  CHECK (cancelled_at IS NULL OR cancelled_at < effective_at);
-- 部分唯一索引：同一个键同一生效时间至多一条未撤销的行；也是 paramsAt 的索引
CREATE UNIQUE INDEX uq_billing_param_key_effective ON billing_param (key, effective_at)
  WHERE cancelled_at IS NULL;
-- 触发器：只允许把 cancelled_at 从空写一次，其余列不可改，不可删
CREATE TRIGGER trg_billing_param_write_once BEFORE UPDATE OR DELETE ON billing_param
  FOR EACH ROW EXECUTE FUNCTION lyx_write_once('cancelled_at');

-- billing_account
-- CHECK：sub_status 取值
ALTER TABLE billing_account ADD CONSTRAINT ck_billing_account_sub_status
  CHECK (sub_status IN ('none','active','expired'));
-- CHECK：三个缓存列非负（d1:616）
ALTER TABLE billing_account ADD CONSTRAINT ck_billing_account_cache_nonneg
  CHECK (plan_available_qty >= 0 AND addon_available_qty >= 0 AND held_total_qty >= 0);
-- CHECK：active ⇔ 有当前周期
ALTER TABLE billing_account ADD CONSTRAINT ck_billing_account_current_term
  CHECK ((sub_status = 'active') = (current_subscription_term_id IS NOT NULL));
-- CHECK：最近清零的数量与时刻同有同无，数量非负
ALTER TABLE billing_account ADD CONSTRAINT ck_billing_account_last_expired
  CHECK ((last_expired_qty IS NULL) = (last_expired_at IS NULL) AND (last_expired_qty IS NULL OR last_expired_qty >= 0));

-- subscription_term
-- CHECK：term_no ≥ 1
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_term_no
  CHECK (term_no >= 1);
-- CHECK：origin 取值
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_origin
  CHECK (origin IN ('new','renew','resume'));
-- CHECK：月数不小于 1
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_months
  CHECK (months >= 1);
-- CHECK：金额非负
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_amounts
  CHECK (price_total_fen >= 0 AND monthly_equiv_fen >= 0);
-- CHECK：权益快照的范围同 plan_revision
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_entitlement
  CHECK (monthly_points > 0 AND discount_bp BETWEEN 5000 AND 10000 AND max_stores >= 1 AND (max_members IS NULL OR max_members >= 1));
-- CHECK：production_model 取值
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_production_model
  CHECK (production_model IN ('standard','advanced','top'));
-- CHECK：schedule_priority 取值
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_schedule_priority
  CHECK (schedule_priority IN ('standard','priority','rush'));
-- CHECK：锚定日 1 到 31
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_anchor_day
  CHECK (anchor_day BETWEEN 1 AND 31);
-- CHECK：ends_at > starts_at，end_date ≥ start_date
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_period
  CHECK (ends_at > starts_at AND end_date >= start_date);
-- CHECK：start_date = starts_at 的北京时间日期
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_start_date
  CHECK (start_date = (starts_at AT TIME ZONE 'Asia/Shanghai')::date);
-- CHECK：ends_at = end_date 次日 00:00（北京时间）
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_ends_at
  CHECK (ends_at = ((end_date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai'));
-- CHECK：延长天数非负
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_extended_days
  CHECK (extended_days >= 0);
-- CHECK：status 取值
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_status
  CHECK (status IN ('scheduled','active','ended','refunded','cancelled'));
-- CHECK：refund_rule 取值
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_refund_rule
  CHECK (refund_rule IN ('window','qualification_failed','override'));
-- CHECK：退款处理中标记两列同有同无
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_refund_mark
  CHECK ((refund_request_id IS NULL) = (refund_rule IS NULL));
-- CHECK：scheduled、cancelled 没有生效时刻，其余必有
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_activated_at
  CHECK ((status IN ('scheduled','cancelled')) = (activated_at IS NULL));
-- CHECK：refunded、cancelled ⇔ 有退款作废时刻
ALTER TABLE subscription_term ADD CONSTRAINT ck_subscription_term_refunded_at
  CHECK ((status IN ('refunded','cancelled')) = (refunded_at IS NOT NULL));
-- 部分唯一索引：一个主体至多一个生效周期（d1:355、612）
CREATE UNIQUE INDEX uq_subscription_term_entity_active ON subscription_term (entity_id)
  WHERE status = 'active';
-- 排他约束：同一主体的 scheduled / active / ended 周期两两不重叠；延迟到提交时检查（d1:355；依赖 btree_gist）
ALTER TABLE subscription_term ADD CONSTRAINT ex_subscription_term_no_overlap
  EXCLUDE USING gist (entity_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
  WHERE (status IN ('scheduled','active','ended'))
  DEFERRABLE INITIALLY DEFERRED;

-- subscription_event
-- CHECK：type 取值
ALTER TABLE subscription_event ADD CONSTRAINT ck_subscription_event_type
  CHECK (type IN ('activated','renewal_scheduled','rolled_over','upgraded','downgrade_scheduled','extended','expired','resumed','refund_suspended','refund_resumed','refunded','cancelled'));
-- CHECK：actor_type 取值
ALTER TABLE subscription_event ADD CONSTRAINT ck_subscription_event_actor_type
  CHECK (actor_type IN ('merchant','staff','system','partner'));
-- CHECK：system 时 actor_id、client 为空，其余 actor_id 必填
ALTER TABLE subscription_event ADD CONSTRAINT ck_subscription_event_actor
  CHECK ((actor_type = 'system' AND actor_id IS NULL AND client IS NULL) OR (actor_type <> 'system' AND actor_id IS NOT NULL));
-- CHECK：client 取值
ALTER TABLE subscription_event ADD CONSTRAINT ck_subscription_event_client
  CHECK (client IN ('weapp','portal','admin'));
-- 触发器：拦截 UPDATE、DELETE（lyx_forbid_mutation）
CREATE TRIGGER trg_subscription_event_append_only BEFORE UPDATE OR DELETE ON subscription_event
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();
-- 触发器：拦截 TRUNCATE
CREATE TRIGGER trg_subscription_event_no_truncate BEFORE TRUNCATE ON subscription_event
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- grant_schedule
-- CHECK：月序号非负
ALTER TABLE grant_schedule ADD CONSTRAINT ck_grant_schedule_month_no
  CHECK (month_no >= 0);
-- CHECK：应发积分大于 0
ALTER TABLE grant_schedule ADD CONSTRAINT ck_grant_schedule_points
  CHECK (points > 0);
-- CHECK：分摊金额非负
ALTER TABLE grant_schedule ADD CONSTRAINT ck_grant_schedule_value_fen
  CHECK (value_fen >= 0);
-- CHECK：due_date = due_at 的北京时间日期
ALTER TABLE grant_schedule ADD CONSTRAINT ck_grant_schedule_due_date
  CHECK (due_date = (due_at AT TIME ZONE 'Asia/Shanghai')::date);
-- CHECK：status 取值
ALTER TABLE grant_schedule ADD CONSTRAINT ck_grant_schedule_status
  CHECK (status IN ('pending','granted','cancelled'));
-- CHECK：granted ⇔ 有批次与发放时刻
ALTER TABLE grant_schedule ADD CONSTRAINT ck_grant_schedule_granted
  CHECK ((status = 'granted') = (point_lot_id IS NOT NULL) AND (status = 'granted') = (granted_at IS NOT NULL));

-- point_lot
-- CHECK：kind 取值
ALTER TABLE point_lot ADD CONSTRAINT ck_point_lot_kind
  CHECK (kind IN ('plan','addon'));
-- CHECK：source_type 取值
ALTER TABLE point_lot ADD CONSTRAINT ck_point_lot_source_type
  CHECK (source_type IN ('grant_monthly','grant_upgrade','purchase','adjust','conversion'));
-- CHECK：序号非负
ALTER TABLE point_lot ADD CONSTRAINT ck_point_lot_source_no
  CHECK (source_no >= 0);
-- CHECK：发放类来源只能是套餐积分；加购、转加购只能是加购积分；调整两者皆可
ALTER TABLE point_lot ADD CONSTRAINT ck_point_lot_source_kind
  CHECK ((source_type IN ('grant_monthly','grant_upgrade') AND kind = 'plan') OR (source_type IN ('purchase','conversion') AND kind = 'addon') OR source_type = 'adjust');
-- CHECK：plan ⇔ 有所属周期与到期时刻（d1:611）
ALTER TABLE point_lot ADD CONSTRAINT ck_point_lot_plan_term
  CHECK ((kind = 'plan') = (subscription_term_id IS NOT NULL) AND (kind = 'plan') = (expires_at IS NOT NULL));
-- CHECK：plan ⇔ 有来源版本；版本与价目修订同有同无（报表按版本分组，d1:401、1570）
ALTER TABLE point_lot ADD CONSTRAINT ck_point_lot_plan_version
  CHECK ((kind = 'plan') = (plan_id IS NOT NULL) AND (plan_id IS NULL) = (plan_revision_id IS NULL));
-- CHECK：conversion ⇔ 有原批次与原流水
ALTER TABLE point_lot ADD CONSTRAINT ck_point_lot_origin
  CHECK ((source_type = 'conversion') = (origin_point_lot_id IS NOT NULL) AND (source_type = 'conversion') = (origin_point_ledger_entry_id IS NOT NULL));
-- CHECK：入账数量大于 0
ALTER TABLE point_lot ADD CONSTRAINT ck_point_lot_original_qty
  CHECK (original_qty > 0);
-- CHECK：七个桶非负（d1:611）
ALTER TABLE point_lot ADD CONSTRAINT ck_point_lot_buckets_nonneg
  CHECK (available_qty >= 0 AND held_qty >= 0 AND consumed_qty >= 0 AND expired_qty >= 0 AND revoked_qty >= 0 AND converted_out_qty >= 0 AND adjusted_out_qty >= 0);
-- CHECK：七个桶之和 = 入账数量（d1:416）
ALTER TABLE point_lot ADD CONSTRAINT ck_point_lot_buckets_sum
  CHECK (original_qty = available_qty + held_qty + consumed_qty + expired_qty + revoked_qty + converted_out_qty + adjusted_out_qty);
-- CHECK：入账成本非负；仅 conversion 为空（d1:611）
ALTER TABLE point_lot ADD CONSTRAINT ck_point_lot_cost_basis
  CHECK ((source_type = 'conversion') = (cost_basis_fen IS NULL) AND (cost_basis_fen IS NULL OR cost_basis_fen >= 0));
-- 部分索引：冻结时选批次：只含还有可用的批次，按扣减顺序排列（d1:417、1203）
CREATE INDEX ix_point_lot_pick ON point_lot (entity_id, kind, expires_at, granted_at, id)
  WHERE available_qty > 0;

-- point_hold
-- CHECK：purpose 取值
ALTER TABLE point_hold ADD CONSTRAINT ck_point_hold_purpose
  CHECK (purpose IN ('order_item','ad','ad_revision'));
-- CHECK：ref_type 取值
ALTER TABLE point_hold ADD CONSTRAINT ck_point_hold_ref_type
  CHECK (ref_type IN ('order_item','ad','ad_revision'));
-- CHECK：应扣积分大于 0
ALTER TABLE point_hold ADD CONSTRAINT ck_point_hold_qty
  CHECK (qty > 0);
-- CHECK：status 取值
ALTER TABLE point_hold ADD CONSTRAINT ck_point_hold_status
  CHECK (status IN ('held','captured','released','refunded_partial','refunded_full'));
-- CHECK：退回与不予退回非负，合计不超过应扣
ALTER TABLE point_hold ADD CONSTRAINT ck_point_hold_return_qty
  CHECK (returned_qty >= 0 AND forfeited_qty >= 0 AND returned_qty + forfeited_qty <= qty);
-- CHECK：状态与已处理数量一致：冻结、已扣减为 0；部分退回在 0 与应扣之间；已释放、全额退回等于应扣
ALTER TABLE point_hold ADD CONSTRAINT ck_point_hold_status_qty
  CHECK ((status IN ('held','captured') AND returned_qty + forfeited_qty = 0)
    OR (status = 'refunded_partial' AND returned_qty + forfeited_qty > 0 AND returned_qty + forfeited_qty < qty)
    OR (status IN ('released','refunded_full') AND returned_qty + forfeited_qty = qty));
-- CHECK：已扣减及其后的状态 ⇔ 有扣减时刻
ALTER TABLE point_hold ADD CONSTRAINT ck_point_hold_captured_at
  CHECK ((status IN ('captured','refunded_partial','refunded_full')) = (captured_at IS NOT NULL));
-- CHECK：released、refunded_full ⇔ 有关闭时刻
ALTER TABLE point_hold ADD CONSTRAINT ck_point_hold_closed_at
  CHECK ((status IN ('released','refunded_full')) = (closed_at IS NOT NULL));
-- CHECK：快照是对象
ALTER TABLE point_hold ADD CONSTRAINT ck_point_hold_pricing_snapshot
  CHECK (jsonb_typeof(pricing_snapshot) = 'object');
-- CHECK：actor_type 取值
ALTER TABLE point_hold ADD CONSTRAINT ck_point_hold_actor_type
  CHECK (actor_type IN ('merchant','staff','system','partner'));
-- CHECK：system 时 actor_id、client 为空，其余 actor_id 必填
ALTER TABLE point_hold ADD CONSTRAINT ck_point_hold_actor
  CHECK ((actor_type = 'system' AND actor_id IS NULL AND client IS NULL) OR (actor_type <> 'system' AND actor_id IS NOT NULL));
-- CHECK：client 取值
ALTER TABLE point_hold ADD CONSTRAINT ck_point_hold_client
  CHECK (client IN ('weapp','portal','admin'));

-- point_hold_alloc
-- CHECK：顺序号从 1 起
ALTER TABLE point_hold_alloc ADD CONSTRAINT ck_point_hold_alloc_alloc_no
  CHECK (alloc_no >= 1);
-- CHECK：lot_kind 取值
ALTER TABLE point_hold_alloc ADD CONSTRAINT ck_point_hold_alloc_lot_kind
  CHECK (lot_kind IN ('plan','addon'));
-- CHECK：数量大于 0；退回与清零非负，合计不超过冻结数量
ALTER TABLE point_hold_alloc ADD CONSTRAINT ck_point_hold_alloc_qty
  CHECK (qty > 0 AND returned_qty >= 0 AND forfeited_qty >= 0 AND returned_qty + forfeited_qty <= qty);

-- ledger_operation
-- CHECK：op_type 取值
ALTER TABLE ledger_operation ADD CONSTRAINT ck_ledger_operation_op_type
  CHECK (op_type IN ('grant','purchase','hold','capture','release','refund','expire','unexpire','adjust','revoke','addon_suspend','addon_resume','refund_suspend','refund_resume','fulfill','extend','fix'));
-- CHECK：ref_type 取值（最终表名）
ALTER TABLE ledger_operation ADD CONSTRAINT ck_ledger_operation_ref_type
  CHECK (ref_type IN ('order_item','ad','ad_revision','billing_order','grant_schedule','subscription_term','approval_request','refund_request','payment_exception','cancel_request_line'));
-- CHECK：ref_type 与 ref_id 同有同无
ALTER TABLE ledger_operation ADD CONSTRAINT ck_ledger_operation_ref_pair
  CHECK ((ref_type IS NULL) = (ref_id IS NULL));
-- CHECK：只有人工修复可以不带关联单据
ALTER TABLE ledger_operation ADD CONSTRAINT ck_ledger_operation_ref_required
  CHECK (op_type = 'fix' OR ref_type IS NOT NULL);
-- CHECK：冻结、扣减、释放、退回必须带冻结单
ALTER TABLE ledger_operation ADD CONSTRAINT ck_ledger_operation_hold
  CHECK (op_type NOT IN ('hold','capture','release','refund') OR point_hold_id IS NOT NULL);
-- CHECK：扣减、闸门开合、只做幂等登记的履约与延长不改变可用积分
ALTER TABLE ledger_operation ADD CONSTRAINT ck_ledger_operation_zero_delta
  CHECK (op_type NOT IN ('capture','addon_suspend','addon_resume','refund_suspend','refund_resume','fulfill','extend') OR (plan_delta_qty = 0 AND addon_delta_qty = 0));
-- CHECK：操作后的可花与冻结非负
ALTER TABLE ledger_operation ADD CONSTRAINT ck_ledger_operation_after_nonneg
  CHECK (spendable_after_qty >= 0 AND held_after_qty >= 0);
-- CHECK：actor_type 取值
ALTER TABLE ledger_operation ADD CONSTRAINT ck_ledger_operation_actor_type
  CHECK (actor_type IN ('merchant','staff','system','partner'));
-- CHECK：system 时 actor_id、client 为空，其余 actor_id 必填
ALTER TABLE ledger_operation ADD CONSTRAINT ck_ledger_operation_actor
  CHECK ((actor_type = 'system' AND actor_id IS NULL AND client IS NULL) OR (actor_type <> 'system' AND actor_id IS NOT NULL));
-- CHECK：client 取值
ALTER TABLE ledger_operation ADD CONSTRAINT ck_ledger_operation_client
  CHECK (client IN ('weapp','portal','admin'));
-- 触发器：拦截 UPDATE、DELETE（lyx_forbid_mutation）
CREATE TRIGGER trg_ledger_operation_append_only BEFORE UPDATE OR DELETE ON ledger_operation
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();
-- 触发器：拦截 TRUNCATE
CREATE TRIGGER trg_ledger_operation_no_truncate BEFORE TRUNCATE ON ledger_operation
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- point_ledger_entry
-- CHECK：lot_kind 取值
ALTER TABLE point_ledger_entry ADD CONSTRAINT ck_point_ledger_entry_lot_kind
  CHECK (lot_kind IN ('plan','addon'));
-- CHECK：from_bucket 取值
ALTER TABLE point_ledger_entry ADD CONSTRAINT ck_point_ledger_entry_from_bucket
  CHECK (from_bucket IN ('external','available','held','consumed','expired','revoked','converted_out','adjusted_out'));
-- CHECK：to_bucket 取值
ALTER TABLE point_ledger_entry ADD CONSTRAINT ck_point_ledger_entry_to_bucket
  CHECK (to_bucket IN ('external','available','held','consumed','expired','revoked','converted_out','adjusted_out'));
-- CHECK：(from_bucket, to_bucket) 只能是 14 种合法移动（d1:482-497、615）
ALTER TABLE point_ledger_entry ADD CONSTRAINT ck_point_ledger_entry_move
  CHECK ((from_bucket, to_bucket) IN (
    ('external','available'),
    ('available','held'),
    ('held','available'),
    ('held','consumed'),
    ('consumed','available'),
    ('available','expired'),
    ('expired','available'),
    ('held','converted_out'),
    ('consumed','converted_out'),
    ('available','revoked'),
    ('expired','revoked'),
    ('available','adjusted_out'),
    ('held','expired'),
    ('consumed','expired')
  ));
-- CHECK：数量大于 0
ALTER TABLE point_ledger_entry ADD CONSTRAINT ck_point_ledger_entry_qty
  CHECK (qty > 0);
-- CHECK：涉及冻结、已消耗两个桶的移动必须带冻结单
ALTER TABLE point_ledger_entry ADD CONSTRAINT ck_point_ledger_entry_hold_required
  CHECK ((from_bucket NOT IN ('held','consumed') AND to_bucket NOT IN ('held','consumed')) OR point_hold_id IS NOT NULL);
-- CHECK：套餐批次的流水 ⇔ 带来源版本
ALTER TABLE point_ledger_entry ADD CONSTRAINT ck_point_ledger_entry_plan_id
  CHECK ((lot_kind = 'plan') = (plan_id IS NOT NULL));
-- 触发器：拦截 UPDATE、DELETE（lyx_forbid_mutation）
CREATE TRIGGER trg_point_ledger_entry_append_only BEFORE UPDATE OR DELETE ON point_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();
-- 触发器：拦截 TRUNCATE
CREATE TRIGGER trg_point_ledger_entry_no_truncate BEFORE TRUNCATE ON point_ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- billing_entity_daily
-- CHECK：sub_status 取值
ALTER TABLE billing_entity_daily ADD CONSTRAINT ck_billing_entity_daily_sub_status
  CHECK (sub_status IN ('none','active','expired'));
-- CHECK：生效时周期、版本、月数必填
ALTER TABLE billing_entity_daily ADD CONSTRAINT ck_billing_entity_daily_active_term
  CHECK (sub_status <> 'active' OR (subscription_term_id IS NOT NULL AND plan_id IS NOT NULL AND plan_revision_id IS NOT NULL AND term_months IS NOT NULL));
-- CHECK：未生效时 MRR 为 0；MRR 非负
ALTER TABLE billing_entity_daily ADD CONSTRAINT ck_billing_entity_daily_mrr
  CHECK (mrr_fen >= 0 AND (sub_status = 'active' OR mrr_fen = 0));
-- CHECK：各余额与金额非负
ALTER TABLE billing_entity_daily ADD CONSTRAINT ck_billing_entity_daily_nonneg
  CHECK (plan_available_points >= 0 AND addon_available_points >= 0 AND held_points >= 0 AND liability_value_fen >= 0 AND deferred_plan_fee_fen >= 0);
-- CHECK：负债 = 套餐可用 + 加购可用 + 冻结
ALTER TABLE billing_entity_daily ADD CONSTRAINT ck_billing_entity_daily_liability
  CHECK (liability_points = plan_available_points + addon_available_points + held_points);

-- valuation_policy
-- CHECK：版本号从 1 起
ALTER TABLE valuation_policy ADD CONSTRAINT ck_valuation_policy_version_no
  CHECK (version_no >= 1);
-- CHECK：rule 是对象
ALTER TABLE valuation_policy ADD CONSTRAINT ck_valuation_policy_rule
  CHECK (jsonb_typeof(rule) = 'object');

-- point_entry_valuation
-- CHECK：effect 取值
ALTER TABLE point_entry_valuation ADD CONSTRAINT ck_point_entry_valuation_effect
  CHECK (effect IN ('inflow','recognize','recognize_breakage','reverse','reverse_transfer','reverse_breakage','reverse_breakage_refund','transfer_out','refund_out','adjust_out','none'));
-- CHECK：价值非负
ALTER TABLE point_entry_valuation ADD CONSTRAINT ck_point_entry_valuation_values
  CHECK (value_fen >= 0 AND remaining_value_fen >= 0);

-- point_adjustment_request
-- CHECK：direction 取值
ALTER TABLE point_adjustment_request ADD CONSTRAINT ck_point_adjustment_request_direction
  CHECK (direction IN ('increase','decrease'));
-- CHECK：lot_kind 取值
ALTER TABLE point_adjustment_request ADD CONSTRAINT ck_point_adjustment_request_lot_kind
  CHECK (lot_kind IN ('plan','addon'));
-- CHECK：数量大于 0
ALTER TABLE point_adjustment_request ADD CONSTRAINT ck_point_adjustment_request_adjust_points
  CHECK (adjust_points > 0);
-- CHECK：reason_code 取值
ALTER TABLE point_adjustment_request ADD CONSTRAINT ck_point_adjustment_request_reason_code
  CHECK (reason_code IN ('compensation','platform_refund','correction','campaign','other'));
-- CHECK：说明 5 到 200 字
ALTER TABLE point_adjustment_request ADD CONSTRAINT ck_point_adjustment_request_note
  CHECK (char_length(note) BETWEEN 5 AND 200);
-- CHECK：platform_refund 只能是增加，且必须关联冻结单
ALTER TABLE point_adjustment_request ADD CONSTRAINT ck_point_adjustment_request_platform_refund
  CHECK (reason_code <> 'platform_refund' OR (direction = 'increase' AND point_hold_id IS NOT NULL));
-- CHECK：由延长单带出的调整只能是增加
ALTER TABLE point_adjustment_request ADD CONSTRAINT ck_point_adjustment_request_extension
  CHECK (term_extension_request_id IS NULL OR direction = 'increase');
-- CHECK：发起时的可花积分非负
ALTER TABLE point_adjustment_request ADD CONSTRAINT ck_point_adjustment_request_spendable_before
  CHECK (spendable_before_points >= 0);
-- CHECK：入账操作与入账时刻同有同无
ALTER TABLE point_adjustment_request ADD CONSTRAINT ck_point_adjustment_request_applied
  CHECK ((ledger_operation_id IS NULL) = (applied_at IS NULL));

-- term_extension_request
-- CHECK：延长天数 1 到 90
ALTER TABLE term_extension_request ADD CONSTRAINT ck_term_extension_request_days
  CHECK (days BETWEEN 1 AND 90);
-- CHECK：说明不为空
ALTER TABLE term_extension_request ADD CONSTRAINT ck_term_extension_request_note
  CHECK (char_length(btrim(note)) > 0);
-- CHECK：applied_mode 取值
ALTER TABLE term_extension_request ADD CONSTRAINT ck_term_extension_request_applied_mode
  CHECK (applied_mode IN ('extend','revive'));
-- CHECK：执行结果六列同有同无；执行后的止日晚于执行前
ALTER TABLE term_extension_request ADD CONSTRAINT ck_term_extension_request_applied
  CHECK ((applied_at IS NULL AND applied_subscription_term_id IS NULL AND applied_mode IS NULL AND prev_end_date IS NULL AND new_end_date IS NULL AND ledger_operation_id IS NULL)
    OR (applied_at IS NOT NULL AND applied_subscription_term_id IS NOT NULL AND applied_mode IS NOT NULL AND prev_end_date IS NOT NULL AND new_end_date IS NOT NULL
        AND ledger_operation_id IS NOT NULL AND new_end_date > prev_end_date));
