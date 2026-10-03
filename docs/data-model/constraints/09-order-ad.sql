-- 分组 09-order-ad：选剧单、订购单、订单项、取消申请（order）与广告（ad）的手写约束。
-- 依据：docs/appendix/design/d3-flow.md 第 4、5、9、16 节；docs/data-model/09-order-ad.md。
-- 只含 Prisma 表达不了的约束：CHECK、数组列的 NOT NULL、部分唯一索引、部分索引、触发器。
-- 建表、普通索引、外键（含归属复合外键与三条指向 ad_version (ad_id, version_no) 的复合外键）由 Prisma 片段生成。
-- “创建后不可改”的触发器用公共函数 lyx_forbid_column_change（M50）。

-- 本分组专用：指定列只能从 NULL 写一次，写入后不可再改；不限制其他列（与公共的 lyx_write_once 不同）。
-- 用法：CREATE TRIGGER trg_<表>_<名> BEFORE UPDATE OF 列1, 列2 ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_09_set_once('列1', '列2');
CREATE OR REPLACE FUNCTION lyx_09_set_once() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
  c text;
BEGIN
  FOREACH c IN ARRAY TG_ARGV::text[] LOOP
    IF (o -> c) IS DISTINCT FROM 'null'::jsonb AND (o -> c) IS DISTINCT FROM (n -> c) THEN
      RAISE EXCEPTION 'table %: column % can be written only once', TG_TABLE_NAME, c
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- cart_item
ALTER TABLE cart_item ADD CONSTRAINT ck_cart_item_list_price_points
  CHECK (list_price_points > 0);

-- drama_order
-- 数组列非空：Prisma 给标量数组列建的是可空列（只带默认值），这里补 NOT NULL。
ALTER TABLE drama_order ALTER COLUMN focus_codes SET NOT NULL;
ALTER TABLE drama_order ADD CONSTRAINT ck_drama_order_status
  CHECK (status IN ('pending_start','producing','to_launch','live','ended','cancelled','after_sale','refunded'));
-- 子状态的取值随状态；任何状态下都允许为空，已结束与已退回积分没有子状态。
ALTER TABLE drama_order ADD CONSTRAINT ck_drama_order_sub_status
  CHECK (CASE status
           WHEN 'pending_start' THEN sub_status IN ('qualification_reviewing','qualification_rejected','starting')
           WHEN 'producing'     THEN sub_status IN ('assigning','plan_confirm','ad_prep','sample_making','sample_confirm',
                                                    'batch_compose','delivering')
           WHEN 'to_launch'     THEN sub_status IN ('awaiting_links','verifying','need_fix','expired_unlaunched')
           WHEN 'live'          THEN sub_status IN ('in_service','takedown_pending','takedown_overdue')
           WHEN 'after_sale'    THEN sub_status IN ('cancel_reviewing','refund_executing')
           WHEN 'cancelled'     THEN sub_status IN ('cancelled_before_start','terminated_no_return')
           ELSE sub_status IS NULL
         END);
ALTER TABLE drama_order ADD CONSTRAINT ck_drama_order_item_count
  CHECK (item_count BETWEEN 1 AND 50);
ALTER TABLE drama_order ADD CONSTRAINT ck_drama_order_total_charge_points
  CHECK (total_charge_points > 0);
ALTER TABLE drama_order ADD CONSTRAINT ck_drama_order_discount_bp
  CHECK (discount_bp BETWEEN 1 AND 10000);
-- 加扣比例：未勾选顶级模型时为 0（旗舰版勾选与否都为 0）。
ALTER TABLE drama_order ADD CONSTRAINT ck_drama_order_surcharge_bp
  CHECK (surcharge_bp >= 0 AND (is_top_model OR surcharge_bp = 0));
ALTER TABLE drama_order ADD CONSTRAINT ck_drama_order_focus_codes
  CHECK (cardinality(focus_codes) >= 1);
-- “售后处理中”当且仅当有在途的取消申请（不变量 I2 的行内部分）。
ALTER TABLE drama_order ADD CONSTRAINT ck_drama_order_after_sale
  CHECK ((status = 'after_sale') = (open_cancel_request_id IS NOT NULL));
-- 开工时间：待开工没有；制作中及以后必有。
ALTER TABLE drama_order ADD CONSTRAINT ck_drama_order_started
  CHECK ((status <> 'pending_start' OR started_at IS NULL)
         AND (status NOT IN ('producing','to_launch','live','ended','refunded') OR started_at IS NOT NULL)
         AND (started_at IS NULL OR started_at >= submitted_at));
ALTER TABLE drama_order ADD CONSTRAINT ck_drama_order_closed
  CHECK ((closed_at IS NOT NULL) = (status IN ('ended','cancelled','refunded')));
-- 资质通过事件的订阅者与待开工补偿扫描：按门店找待开工的订购单。
CREATE INDEX ix_drama_order_pending_start_store_id ON drama_order (store_id) WHERE status = 'pending_start';
-- 取消申请关闭时找到要清空 open_cancel_request_id 的订购单；不变量 I2。
CREATE INDEX ix_drama_order_open_cancel_request_id ON drama_order (open_cancel_request_id)
  WHERE open_cancel_request_id IS NOT NULL;
-- 归属、单号与下单时的快照不可改。
CREATE TRIGGER trg_drama_order_immutable
  BEFORE UPDATE OF order_no, entity_id, store_id, placed_by_user_id, item_count, total_charge_points,
                   subscription_term_id, plan_code, discount_bp, is_top_model, surcharge_bp,
                   agreement_consent_id, submitted_at
  ON drama_order
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'order_no', 'entity_id', 'store_id', 'placed_by_user_id', 'item_count', 'total_charge_points',
    'subscription_term_id', 'plan_code', 'discount_bp', 'is_top_model', 'surcharge_bp',
    'agreement_consent_id', 'submitted_at');

-- order_item
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_item_no
  CHECK (item_no >= 1);
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_episode_count
  CHECK (episode_count >= 1);
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_list_price_points
  CHECK (list_price_points > 0);
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_discount_bp
  CHECK (discount_bp BETWEEN 1 AND 10000);
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_surcharge_bp
  CHECK (surcharge_bp >= 0);
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_charge_points
  CHECK (charge_points > 0);
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_production_model
  CHECK (production_model IN ('standard','advanced','top'));
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_phase
  CHECK (phase IN ('pending_start','producing','to_launch','live','ended','cancelled','refunded','terminated'));
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_usage_end_source
  CHECK (usage_end_source IN ('license','early_end','expired'));
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_cancel_reason_code
  CHECK (cancel_reason_code IN ('merchant_request','store_closed','platform_fault','qualification_final'));
-- 退回的四个数：请求量 = 三个实际去向之和，且不超过应扣。
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_refund_sum
  CHECK (refund_requested_points = returned_points + converted_points + forfeited_points);
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_refund_range
  CHECK (returned_points >= 0 AND converted_points >= 0 AND forfeited_points >= 0
         AND refund_requested_points <= charge_points);
-- 冻结与阶段一致（不变量 I4 的行内部分）：待开工、开工前取消的没有扣减时间，其余阶段必有。
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_capture
  CHECK ((phase IN ('pending_start','cancelled')) = (captured_at IS NULL));
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_usage_dates
  CHECK ((usage_start_date IS NULL OR usage_start_date <= usage_end_date)
         AND (phase <> 'live' OR usage_start_date IS NOT NULL));
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_live_episode_count
  CHECK (live_episode_count BETWEEN 0 AND episode_count);
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_cancelled
  CHECK ((cancelled_at IS NULL) = (cancel_reason_code IS NULL)
         AND (phase <> 'cancelled' OR cancelled_at IS NOT NULL));
ALTER TABLE order_item ADD CONSTRAINT ck_order_item_snapshots
  CHECK (jsonb_typeof(drama_snapshot) = 'object' AND jsonb_typeof(pricing_snapshot) = 'object');
-- 使用期结束扫描、止日对账（每小时）：只看待上线与上线中的订单项。
CREATE INDEX ix_order_item_usage_end_date_active ON order_item (usage_end_date)
  WHERE phase IN ('to_launch','live');
-- 上线提醒与逾期未上线：只看制作中与待上线的订单项。
CREATE INDEX ix_order_item_agreed_launch_date_active ON order_item (agreed_launch_date)
  WHERE phase IN ('producing','to_launch');
-- 归属、序号、剧目与计价快照不可改。
CREATE TRIGGER trg_order_item_immutable
  BEFORE UPDATE OF drama_order_id, item_no, entity_id, store_id, drama_id, drama_snapshot, episode_count,
                   list_price_points, discount_bp, surcharge_bp, charge_points, pricing_snapshot,
                   production_model, point_hold_id
  ON order_item
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'drama_order_id', 'item_no', 'entity_id', 'store_id', 'drama_id', 'drama_snapshot', 'episode_count',
    'list_price_points', 'discount_bp', 'surcharge_bp', 'charge_points', 'pricing_snapshot',
    'production_model', 'point_hold_id');

-- order_item_account
ALTER TABLE order_item_account ADD CONSTRAINT ck_order_item_account_platform
  CHECK (platform IN ('douyin','wechat_channels'));

-- order_item_placement
ALTER TABLE order_item_placement ADD CONSTRAINT ck_order_item_placement_slot
  CHECK (slot IN ('opening','ending','corner','mid_roll'));
ALTER TABLE order_item_placement ADD CONSTRAINT ck_order_item_placement_duration_sec
  CHECK (duration_sec > 0);
-- 钉住：版本号与钉住时间同有同无。
ALTER TABLE order_item_placement ADD CONSTRAINT ck_order_item_placement_pin
  CHECK ((bound_version_no IS NULL) = (pinned_at IS NULL)
         AND (bound_version_no IS NULL OR bound_version_no >= 1));

-- cancel_request
ALTER TABLE cancel_request ALTER COLUMN exec_confirm_checks SET NOT NULL;
ALTER TABLE cancel_request ADD CONSTRAINT ck_cancel_request_kind
  CHECK (kind IN ('order_cancel','ad_cancel','qualification_cancel'));
ALTER TABLE cancel_request ADD CONSTRAINT ck_cancel_request_reason_code
  CHECK (reason_code IN ('merchant_request','store_closed','platform_fault','qualification_final'));
ALTER TABLE cancel_request ADD CONSTRAINT ck_cancel_request_status
  CHECK (status IN ('pending_approval','pending_execution','done','not_executed'));
ALTER TABLE cancel_request ADD CONSTRAINT ck_cancel_request_close_reason
  CHECK (close_reason IN ('rejected','withdrawn','voided'));
-- 对象按类型：订购取消指向订购单，广告取消指向广告，整店取消的对象是门店（store_id）。
ALTER TABLE cancel_request ADD CONSTRAINT ck_cancel_request_target
  CHECK (CASE kind
           WHEN 'order_cancel'         THEN drama_order_id IS NOT NULL AND ad_id IS NULL
           WHEN 'ad_cancel'            THEN ad_id IS NOT NULL AND drama_order_id IS NULL
           WHEN 'qualification_cancel' THEN drama_order_id IS NULL AND ad_id IS NULL
           ELSE false
         END);
-- 资质终局驳回这一原因只用于系统生成的整店取消。
ALTER TABLE cancel_request ADD CONSTRAINT ck_cancel_request_qualification
  CHECK ((kind = 'qualification_cancel') = (reason_code = 'qualification_final'));
ALTER TABLE cancel_request ADD CONSTRAINT ck_cancel_request_totals
  CHECK (line_count >= 1 AND total_base_points >= 0 AND total_deduct_points >= 0 AND total_refund_points >= 0
         AND total_refund_points = total_base_points - total_deduct_points);
-- 关闭：两个终态必有关闭时间；未执行即关闭必有原因；通过后作废必有说明（M54）。
ALTER TABLE cancel_request ADD CONSTRAINT ck_cancel_request_closed
  CHECK ((closed_at IS NOT NULL) = (status IN ('done','not_executed'))
         AND (close_reason IS NOT NULL) = (status = 'not_executed')
         AND (close_reason IS NOT DISTINCT FROM 'voided') = (close_note IS NOT NULL));
-- 执行留痕：已执行（done）必有执行时间，执行人与“系统执行”二选一；其余状态三列为空。
ALTER TABLE cancel_request ADD CONSTRAINT ck_cancel_request_executed
  CHECK ((status = 'done') = (executed_at IS NOT NULL)
         AND (status = 'done' OR (executed_by_staff_id IS NULL AND NOT is_executed_by_system))
         AND (status <> 'done' OR (executed_by_staff_id IS NOT NULL) <> is_executed_by_system));
-- 执行时限在审批通过时写入，与参数快照同有同无（M60：快照列叫 sla_snapshot）。
ALTER TABLE cancel_request ADD CONSTRAINT ck_cancel_request_sla
  CHECK ((exec_due_at IS NULL) = (sla_snapshot IS NULL)
         AND (status <> 'pending_approval' OR exec_due_at IS NULL)
         AND (status <> 'pending_execution' OR exec_due_at IS NOT NULL));
ALTER TABLE cancel_request ADD CONSTRAINT ck_cancel_request_recheck_log
  CHECK (recheck_log IS NULL OR jsonb_typeof(recheck_log) = 'object');
-- 同一对象只允许一张在途申请（M12）：在途 = closed_at 为空。
CREATE UNIQUE INDEX uq_cancel_request_drama_order_id_open ON cancel_request (drama_order_id)
  WHERE closed_at IS NULL AND drama_order_id IS NOT NULL;
CREATE UNIQUE INDEX uq_cancel_request_ad_id_open ON cancel_request (ad_id)
  WHERE closed_at IS NULL AND ad_id IS NOT NULL;
CREATE UNIQUE INDEX uq_cancel_request_store_id_qualification_open ON cancel_request (store_id)
  WHERE closed_at IS NULL AND kind = 'qualification_cancel';
-- 申请内容提交后不可改。
CREATE TRIGGER trg_cancel_request_immutable
  BEFORE UPDATE OF approval_request_id, kind, entity_id, store_id, drama_order_id, ad_id, reason_code, note,
                   line_count, total_base_points, total_deduct_points, total_refund_points
  ON cancel_request
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'approval_request_id', 'kind', 'entity_id', 'store_id', 'drama_order_id', 'ad_id', 'reason_code', 'note',
    'line_count', 'total_base_points', 'total_deduct_points', 'total_refund_points');

-- cancel_request_line
ALTER TABLE cancel_request_line ADD CONSTRAINT ck_cancel_request_line_target_type
  CHECK (target_type IN ('order_item','ad'));
ALTER TABLE cancel_request_line ADD CONSTRAINT ck_cancel_request_line_mode
  CHECK (mode IN ('release','refund','terminate_only'));
ALTER TABLE cancel_request_line ADD CONSTRAINT ck_cancel_request_line_stage
  CHECK (stage IN ('pending_start','plan_confirm','ad_and_sample','sample_pending','post_sample','live',
                   'ad_unassigned','ad_in_production'));
ALTER TABLE cancel_request_line ADD CONSTRAINT ck_cancel_request_line_reason_class
  CHECK (reason_class IN ('merchant','platform','qualification'));
ALTER TABLE cancel_request_line ADD CONSTRAINT ck_cancel_request_line_usage_end_source
  CHECK (usage_end_source IN ('license','early_end','expired'));
-- 阶段与对象类型一致：广告只有两个阶段。
ALTER TABLE cancel_request_line ADD CONSTRAINT ck_cancel_request_line_stage_target
  CHECK ((target_type = 'ad') = (stage IN ('ad_unassigned','ad_in_production')));
-- 恒等式：扣除 + 请求退回 = 应扣 − 提交时已请求退回。
ALTER TABLE cancel_request_line ADD CONSTRAINT ck_cancel_request_line_amounts
  CHECK (charge_points > 0 AND prior_requested_points >= 0 AND deduct_points >= 0 AND refund_points >= 0
         AND deduct_points + refund_points = charge_points - prior_requested_points);
-- 账本动作与阶段：释放只用于未扣减的对象且为全额；退回的数量大于 0；仅终止不动积分。
ALTER TABLE cancel_request_line ADD CONSTRAINT ck_cancel_request_line_mode_rule
  CHECK ((mode = 'release') = (stage IN ('pending_start','ad_unassigned'))
         AND (mode <> 'release' OR (deduct_points = 0 AND prior_requested_points = 0))
         AND (mode <> 'refund' OR refund_points > 0)
         AND (mode <> 'terminate_only' OR refund_points = 0));
ALTER TABLE cancel_request_line ADD CONSTRAINT ck_cancel_request_line_ratio_bp
  CHECK ((ratio_bp IS NULL OR ratio_bp BETWEEN 0 AND 10000)
         AND (ratio_bp IS NULL OR (mode <> 'release' AND stage <> 'live')));
-- 没有比例、又不是释放或已上线折算的行，扣除数是人工录入的，必须写依据。
ALTER TABLE cancel_request_line ADD CONSTRAINT ck_cancel_request_line_manual_deduct
  CHECK (ratio_bp IS NOT NULL OR mode = 'release' OR stage = 'live' OR deduct_note IS NOT NULL);
-- 已上线：终止日与使用期快照齐全；终止日不早于上线首日、不晚于使用期止日与提交日（北京时间，d3:2092）；只有平台原因。
ALTER TABLE cancel_request_line ADD CONSTRAINT ck_cancel_request_line_live
  CHECK ((stage = 'live') = (termination_date IS NOT NULL)
         AND (stage = 'live') = (usage_start_date IS NOT NULL)
         AND (stage = 'live') = (usage_end_date IS NOT NULL)
         AND (stage = 'live') = (usage_end_source IS NOT NULL)
         AND (stage <> 'live' OR (termination_date BETWEEN usage_start_date AND usage_end_date
                                  AND termination_date <= (created_at AT TIME ZONE 'Asia/Shanghai')::date
                                  AND reason_class = 'platform')));
-- 待开工订单项没有工单步骤；其余都有提交时的步骤或广告状态。
ALTER TABLE cancel_request_line ADD CONSTRAINT ck_cancel_request_line_step_at_submit
  CHECK ((stage = 'pending_start') = (step_at_submit IS NULL));
-- 执行结果五列同有同无；三个实际去向之和 = 请求退回量。
ALTER TABLE cancel_request_line ADD CONSTRAINT ck_cancel_request_line_result
  CHECK ((executed_at IS NULL) = (result_snapshot IS NULL)
         AND (executed_at IS NULL) = (returned_points IS NULL)
         AND (executed_at IS NULL) = (converted_points IS NULL)
         AND (executed_at IS NULL) = (forfeited_points IS NULL)
         AND (executed_at IS NULL OR (returned_points >= 0 AND converted_points >= 0 AND forfeited_points >= 0
                                      AND returned_points + converted_points + forfeited_points = refund_points)));
ALTER TABLE cancel_request_line ADD CONSTRAINT ck_cancel_request_line_snapshots
  CHECK (jsonb_typeof(preview_snapshot) = 'object'
         AND (result_snapshot IS NULL OR jsonb_typeof(result_snapshot) = 'object'));
-- 明细提交后不可改、不可删；只允许把执行结果五列从 NULL 写一次。
CREATE TRIGGER trg_cancel_request_line_write_once
  BEFORE UPDATE OR DELETE ON cancel_request_line
  FOR EACH ROW EXECUTE FUNCTION lyx_write_once(
    'result_snapshot', 'returned_points', 'converted_points', 'forfeited_points', 'executed_at');

-- ad
ALTER TABLE ad ALTER COLUMN promo_point_codes SET NOT NULL;
ALTER TABLE ad ADD CONSTRAINT ck_ad_type
  CHECK (type IN ('opening','ending','corner','mid_roll'));
ALTER TABLE ad ADD CONSTRAINT ck_ad_status
  CHECK (status IN ('pending_assign','producing','returned','pending_confirm','revising','confirmed','cancelled'));
ALTER TABLE ad ADD CONSTRAINT ck_ad_returned_from
  CHECK (returned_from IN ('pending_assign','producing'));
ALTER TABLE ad ADD CONSTRAINT ck_ad_cancel_reason_code
  CHECK (cancel_reason_code IN ('merchant_request','store_closed','platform_fault','qualification_final'));
ALTER TABLE ad ADD CONSTRAINT ck_ad_duration_sec
  CHECK (duration_sec > 0);
ALTER TABLE ad ADD CONSTRAINT ck_ad_promo_point_codes
  CHECK (cardinality(promo_point_codes) >= 1);
ALTER TABLE ad ADD CONSTRAINT ck_ad_unit_price_points
  CHECK (unit_price_points > 0);
ALTER TABLE ad ADD CONSTRAINT ck_ad_discount_bp
  CHECK (discount_bp BETWEEN 1 AND 10000);
ALTER TABLE ad ADD CONSTRAINT ck_ad_charge_points
  CHECK (charge_points > 0);
ALTER TABLE ad ADD CONSTRAINT ck_ad_refund_sum
  CHECK (refund_requested_points = returned_points + converted_points + forfeited_points);
ALTER TABLE ad ADD CONSTRAINT ck_ad_refund_range
  CHECK (returned_points >= 0 AND converted_points >= 0 AND forfeited_points >= 0
         AND refund_requested_points <= charge_points);
ALTER TABLE ad ADD CONSTRAINT ck_ad_revision_counters
  CHECK (free_revision_quota >= 0 AND revision_count >= 0 AND latest_version_no >= 0);
-- 确认版本：与确认时间同有同无；不超过最新版本；已确认状态下就是最新版本；待确认至少有一个版本。
ALTER TABLE ad ADD CONSTRAINT ck_ad_confirmed_version
  CHECK ((confirmed_version_no IS NULL) = (confirmed_at IS NULL)
         AND (confirmed_version_no IS NULL OR confirmed_version_no BETWEEN 1 AND latest_version_no)
         AND (status <> 'confirmed' OR confirmed_version_no IS NOT DISTINCT FROM latest_version_no)
         AND (status <> 'pending_confirm' OR latest_version_no >= 1));
ALTER TABLE ad ADD CONSTRAINT ck_ad_returned
  CHECK (status <> 'returned'
         OR (returned_from IS NOT NULL AND returned_at IS NOT NULL AND return_reason IS NOT NULL));
-- 指派即扣减：剪辑师与扣减时间同有同无；各状态下是否已扣减固定（不变量 I4、I11 的行内部分）。
ALTER TABLE ad ADD CONSTRAINT ck_ad_assign_capture
  CHECK ((editor_id IS NULL) = (captured_at IS NULL)
         AND CASE
               WHEN status = 'pending_assign' THEN captured_at IS NULL
               WHEN status IN ('producing','pending_confirm','revising','confirmed') THEN captured_at IS NOT NULL
               WHEN status = 'returned' THEN (returned_from = 'pending_assign') = (captured_at IS NULL)
               ELSE true
             END);
-- 时限与参数快照同有同无；待补充期间不计时。
ALTER TABLE ad ADD CONSTRAINT ck_ad_sla
  CHECK ((due_at IS NULL) = (sla_snapshot IS NULL)
         AND (status <> 'returned' OR due_at IS NULL));
ALTER TABLE ad ADD CONSTRAINT ck_ad_cancelled
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)
         AND (cancelled_at IS NULL) = (cancel_reason_code IS NULL));
ALTER TABLE ad ADD CONSTRAINT ck_ad_pricing_snapshot
  CHECK (jsonb_typeof(pricing_snapshot) = 'object');
ALTER TABLE ad ADD CONSTRAINT ck_ad_resubmit_count
  CHECK (resubmit_count >= 0);
-- 在途取消（M69）：已确认的广告不可取消；取消执行时与 status = cancelled 同一条 UPDATE 清空。
ALTER TABLE ad ADD CONSTRAINT ck_ad_open_cancel_request
  CHECK (open_cancel_request_id IS NULL OR status NOT IN ('confirmed','cancelled'));
-- 取消申请关闭时找回要清空 open_cancel_request_id 的广告；不变量核对。
CREATE INDEX ix_ad_open_cancel_request_id ON ad (open_cancel_request_id)
  WHERE open_cancel_request_id IS NOT NULL;
-- 归属、编号、类型与提交时的计价快照不可改。
CREATE TRIGGER trg_ad_immutable
  BEFORE UPDATE OF ad_no, entity_id, store_id, requested_by_user_id, type, unit_price_points, discount_bp,
                   charge_points, pricing_snapshot, point_hold_id, free_revision_quota, agreement_consent_id,
                   submitted_at
  ON ad
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'ad_no', 'entity_id', 'store_id', 'requested_by_user_id', 'type', 'unit_price_points', 'discount_bp',
    'charge_points', 'pricing_snapshot', 'point_hold_id', 'free_revision_quota', 'agreement_consent_id',
    'submitted_at');

-- ad_version
ALTER TABLE ad_version ALTER COLUMN preview_channels SET NOT NULL;
ALTER TABLE ad_version ADD CONSTRAINT ck_ad_version_version_no
  CHECK (version_no >= 1);
ALTER TABLE ad_version ADD CONSTRAINT ck_ad_version_media
  CHECK (duration_ms > 0 AND width > 0 AND height > 0);
ALTER TABLE ad_version ADD CONSTRAINT ck_ad_version_decision
  CHECK (decision IN ('confirmed','revision_requested','superseded'));
-- 决定与决定时间同有同无；商家只能对已推送的版本作决定；推送不早于上传。
ALTER TABLE ad_version ADD CONSTRAINT ck_ad_version_decided
  CHECK ((decision IS NULL) = (decided_at IS NULL)
         AND (decision IS NULL OR decision = 'superseded' OR pushed_at IS NOT NULL)
         AND (pushed_at IS NULL OR pushed_at >= uploaded_at));
-- 查看方式取值与 sample 相同（M62）。
ALTER TABLE ad_version ADD CONSTRAINT ck_ad_version_confirm_viewed_via
  CHECK ((confirm_viewed_via IS NULL OR confirm_viewed_via IN ('weapp','album','portal','wecom'))
         AND (confirm_viewed_via IS NULL OR decision IS NOT DISTINCT FROM 'confirmed'));
-- 推送时确定查看方式：取值在四种之内，推送后至少 1 项（d3:1532、1543）。
ALTER TABLE ad_version ADD CONSTRAINT ck_ad_version_preview_channels
  CHECK (preview_channels <@ ARRAY['weapp','album','portal','wecom']::text[]
         AND (pushed_at IS NULL OR cardinality(preview_channels) >= 1)
         AND (pushed_at IS NOT NULL OR cardinality(preview_channels) = 0));
-- 经企业微信提供：时间与员工同有同无；查看方式含 wecom 时必须已提供。
ALTER TABLE ad_version ADD CONSTRAINT ck_ad_version_offline_sent
  CHECK ((offline_sent_at IS NULL) = (offline_sent_by_staff_id IS NULL)
         AND (NOT ('wecom' = ANY (preview_channels)) OR offline_sent_at IS NOT NULL));
-- 确认的证据（与 sample 的 ck_sample_confirmed 同口径）：必有查看方式且在推送时确定的范围内；不是小程序内播放的要有勾选确认。
ALTER TABLE ad_version ADD CONSTRAINT ck_ad_version_confirmed
  CHECK (decision IS DISTINCT FROM 'confirmed'
         OR (confirm_viewed_via IS NOT NULL
             AND confirm_viewed_via = ANY (preview_channels)
             AND (confirm_viewed_via = 'weapp' OR viewed_ack_at IS NOT NULL)));
ALTER TABLE ad_version ADD CONSTRAINT ck_ad_version_viewed_ack
  CHECK (viewed_ack_at IS NULL OR decision IS NOT DISTINCT FROM 'confirmed');
ALTER TABLE ad_version ADD CONSTRAINT ck_ad_version_segments
  CHECK (segments IS NULL OR jsonb_typeof(segments) = 'array');
-- 同一条广告同一时刻至多一个未决版本：上传新版本前，旧的未决版本先置 superseded。
CREATE UNIQUE INDEX uq_ad_version_ad_id_undecided ON ad_version (ad_id) WHERE decision IS NULL;
-- 版本的归属、版本号、文件、分段与上传信息不可改（被复合外键引用；修改轮次按 index 引用分段）。
CREATE TRIGGER trg_ad_version_immutable
  BEFORE UPDATE OF ad_id, entity_id, store_id, version_no, file_id, segments, uploaded_by_staff_id, uploaded_at
  ON ad_version
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'ad_id', 'entity_id', 'store_id', 'version_no', 'file_id', 'segments', 'uploaded_by_staff_id', 'uploaded_at');
-- 商家决定只写一次：已确认的版本不会再被改成别的决定（从已确认再次提出修改时不动版本行）。
CREATE TRIGGER trg_ad_version_decision_once
  BEFORE UPDATE OF decision, decided_at, confirm_viewed_via, viewed_ack_at
  ON ad_version
  FOR EACH ROW EXECUTE FUNCTION lyx_09_set_once('decision', 'decided_at', 'confirm_viewed_via', 'viewed_ack_at');

-- ad_revision
ALTER TABLE ad_revision ALTER COLUMN screenshot_file_ids SET NOT NULL;
ALTER TABLE ad_revision ADD CONSTRAINT ck_ad_revision_revision_no
  CHECK (revision_no >= 1);
ALTER TABLE ad_revision ADD CONSTRAINT ck_ad_revision_source
  CHECK (source IN ('ad_page','sample_feedback','staff_on_behalf'));
ALTER TABLE ad_revision ADD CONSTRAINT ck_ad_revision_actor_type
  CHECK (actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE ad_revision ADD CONSTRAINT ck_ad_revision_client
  CHECK (client IN ('weapp','portal','admin'));
ALTER TABLE ad_revision ADD CONSTRAINT ck_ad_revision_actor
  CHECK ((actor_type = 'system') = (actor_id IS NULL)
         AND (actor_type <> 'system' OR client IS NULL));
-- 计费：是否计费、扣减数量、冻结单三者一致；只有商家本人提交的修改可以产生扣减。
ALTER TABLE ad_revision ADD CONSTRAINT ck_ad_revision_charge
  CHECK (charge_points >= 0
         AND is_chargeable = (charge_points > 0)
         AND is_chargeable = (charge_point_hold_id IS NOT NULL)
         AND (NOT is_chargeable OR actor_type = 'merchant'));
ALTER TABLE ad_revision ADD CONSTRAINT ck_ad_revision_time_range
  CHECK ((time_start_ms IS NULL) = (time_end_ms IS NULL)
         AND (time_start_ms IS NULL OR (time_start_ms >= 0 AND time_end_ms > time_start_ms)));
-- 选用预置分段时，起止时间取该分段的起止（应用层从 segments 复制），因而必有。
ALTER TABLE ad_revision ADD CONSTRAINT ck_ad_revision_segment_index
  CHECK (segment_index IS NULL OR (segment_index >= 0 AND time_start_ms IS NOT NULL));
ALTER TABLE ad_revision ADD CONSTRAINT ck_ad_revision_fulfilled
  CHECK (fulfilled_by_version_no IS NULL OR fulfilled_by_version_no > on_version_no);
-- 同一条广告同一时刻至多一个未被满足的修改轮次（修改中不能再次提出修改）。
CREATE UNIQUE INDEX uq_ad_revision_ad_id_unfulfilled ON ad_revision (ad_id) WHERE fulfilled_by_version_no IS NULL;
-- 修改意见的内容与计费结果不可改；只有 due_at（日历重算）、breached_at、fulfilled_by_version_no、updated_at 可写。
CREATE TRIGGER trg_ad_revision_immutable
  BEFORE UPDATE OF ad_id, entity_id, store_id, revision_no, on_version_no, source, is_chargeable, charge_points,
                   charge_point_hold_id, time_start_ms, time_end_ms, segment_index, note, screenshot_file_ids,
                   actor_type, actor_id, client, created_at
  ON ad_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'ad_id', 'entity_id', 'store_id', 'revision_no', 'on_version_no', 'source', 'is_chargeable', 'charge_points',
    'charge_point_hold_id', 'time_start_ms', 'time_end_ms', 'segment_index', 'note', 'screenshot_file_ids',
    'actor_type', 'actor_id', 'client', 'created_at');
