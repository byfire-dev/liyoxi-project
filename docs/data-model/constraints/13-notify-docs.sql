-- 分组 13-notify-docs：通知与人工催办限频、协议、同意记录、授权书（notify 9 张 + docs 5 张）
-- 手写约束：枚举与范围 CHECK、按状态必填 CHECK、部分索引、部分唯一索引、只增与防改触发器、标量数组列的 NOT NULL。
-- 建表、普通索引、外键（含归属复合外键、同一对模型的第二个关系）由 Prisma 片段生成；通用触发器函数在 00-common.sql
-- （lyx_forbid_mutation、lyx_forbid_delete、lyx_forbid_column_change），本分组只另定义两个专用函数。
-- 目标 PostgreSQL 17，语句兼容 14。可空列上的 IN / 比较类 CHECK 在列为 NULL 时放行。
-- 草案（d6 第 1.4 节）里的 varchar(n) 落地为 text，长度上限合并成每表一条 ck_<表>_text_len。

-- 本分组的触发器函数（一）：协议版本的防改与状态次序。
-- 所属协议不可改。离开草稿后，除簿记列（status、activated_at、expected_consents、lock_version、updated_at）外一律不可改：
-- 内容（版本号、生效时间、两个文件、展示版、两个哈希、摘要、两个开关）、发布人与公告不变，改内容只能出新版本。
-- 状态只能 draft → pending → active → superseded；pending 可撤回为 withdrawn（终态，整行冻结），且该版本尚无同意记录。
-- 撤回不回退到草稿：重新编辑由应用在同一事务里复制出一行新草稿（新 id），使重新保存时能建新的公告。
-- 只有草稿可以删除。
CREATE OR REPLACE FUNCTION lyx_13_agreement_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bookkeeping text[] := ARRAY['status', 'activated_at', 'expected_consents', 'lock_version', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'agreement_version %: only a draft may be deleted', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.agreement_key IS DISTINCT FROM OLD.agreement_key THEN
    RAISE EXCEPTION 'agreement_version %: agreement_key is immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'pending') THEN
      RAISE EXCEPTION 'agreement_version %: illegal status change % -> %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - bookkeeping) IS DISTINCT FROM (to_jsonb(OLD) - bookkeeping) THEN
    RAISE EXCEPTION 'agreement_version %: content is frozen once status is %', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT ((OLD.status = 'pending' AND NEW.status IN ('pending', 'active', 'withdrawn'))
       OR (OLD.status = 'active' AND NEW.status IN ('active', 'superseded'))
       OR (OLD.status = 'superseded' AND NEW.status = 'superseded')
       OR (OLD.status = 'withdrawn' AND NEW.status = 'withdrawn' AND to_jsonb(NEW) = to_jsonb(OLD))) THEN
    RAISE EXCEPTION 'agreement_version %: illegal status change % -> %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'withdrawn'
     AND EXISTS (SELECT 1 FROM agreement_consent c WHERE c.agreement_version_id = OLD.id) THEN
    RAISE EXCEPTION 'agreement_version %: cannot withdraw, consent records exist', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- 本分组的触发器函数（二）：同意记录写入前核对所引用的版本。
-- 版本已发布且未撤回（pending、active、superseded）、已到生效时间，且记录里冗余的内容哈希与版本行一致。
CREATE OR REPLACE FUNCTION lyx_13_agreement_consent_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v record;
BEGIN
  SELECT status, effective_at, content_sha256 INTO v
    FROM agreement_version WHERE id = NEW.agreement_version_id;
  IF NOT FOUND THEN
    RETURN NEW; -- 交给外键报错
  END IF;
  IF v.status NOT IN ('pending', 'active', 'superseded') OR v.effective_at IS NULL OR v.effective_at > NEW.consented_at THEN
    RAISE EXCEPTION 'agreement_consent: version % is not in effect at %', NEW.agreement_version_id, NEW.consented_at
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF v.content_sha256 IS DISTINCT FROM NEW.content_sha256 THEN
    RAISE EXCEPTION 'agreement_consent: content_sha256 does not match version %', NEW.agreement_version_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- notify_scene
ALTER TABLE notify_scene ADD CONSTRAINT ck_notify_scene_audience
  CHECK (audience IN ('merchant', 'staff'));
ALTER TABLE notify_scene ADD CONSTRAINT ck_notify_scene_scene_key
  CHECK (scene_key ~ '^[ms]\.[a-z][a-z0-9_]*$'
         AND ((audience = 'merchant' AND scene_key LIKE 'm.%') OR (audience = 'staff' AND scene_key LIKE 's.%')));
ALTER TABLE notify_scene ADD CONSTRAINT ck_notify_scene_sms_policy
  CHECK (sms_policy IN ('never', 'fallback', 'always'));
ALTER TABLE notify_scene ADD CONSTRAINT ck_notify_scene_send_window
  CHECK (send_window IN ('immediate', 'window', 'scheduled'));
ALTER TABLE notify_scene ADD CONSTRAINT ck_notify_scene_sms_template
  CHECK (sms_policy = 'never' OR sms_template_key IS NOT NULL);
ALTER TABLE notify_scene ADD CONSTRAINT ck_notify_scene_staff_channels
  CHECK (audience = 'merchant' OR (wx_template_slot_key IS NULL AND sms_policy = 'never' AND sms_template_key IS NULL));
ALTER TABLE notify_scene ADD CONSTRAINT ck_notify_scene_sms_nodes
  CHECK (sms_nodes IS NULL OR jsonb_typeof(sms_nodes) = 'array');
ALTER TABLE notify_scene ADD CONSTRAINT ck_notify_scene_collapse_window_sec
  CHECK (collapse_window_sec >= 0);
ALTER TABLE notify_scene ADD CONSTRAINT ck_notify_scene_text_len
  CHECK (char_length(scene_key) <= 48 AND char_length(name) <= 32);

-- wx_template_slot
ALTER TABLE wx_template_slot ADD CONSTRAINT ck_wx_template_slot_slot_key
  CHECK (slot_key ~ '^[a-z][a-z0-9_]*$');
ALTER TABLE wx_template_slot ADD CONSTRAINT ck_wx_template_slot_status
  CHECK (status IN ('active', 'unconfigured', 'disabled'));
ALTER TABLE wx_template_slot ADD CONSTRAINT ck_wx_template_slot_disabled_reason
  CHECK (disabled_reason IN ('template_invalid', 'field_mismatch_streak', 'manual'));
ALTER TABLE wx_template_slot ADD CONSTRAINT ck_wx_template_slot_disabled
  CHECK ((status = 'disabled') = (disabled_reason IS NOT NULL));
ALTER TABLE wx_template_slot ADD CONSTRAINT ck_wx_template_slot_configured
  CHECK ((status <> 'active' OR provider_template_id IS NOT NULL)
         AND (status <> 'unconfigured' OR provider_template_id IS NULL));
ALTER TABLE wx_template_slot ADD CONSTRAINT ck_wx_template_slot_fail_streak
  CHECK (fail_streak >= 0);
ALTER TABLE wx_template_slot ADD CONSTRAINT ck_wx_template_slot_fields
  CHECK (jsonb_typeof(fields) = 'array');
ALTER TABLE wx_template_slot ADD CONSTRAINT ck_wx_template_slot_text_len
  CHECK (char_length(slot_key) <= 32 AND char_length(title) <= 32 AND char_length(provider_template_id) <= 64);

-- sms_template
ALTER TABLE sms_template ADD CONSTRAINT ck_sms_template_template_key
  CHECK (template_key ~ '^[a-z][a-z0-9_]*$');
ALTER TABLE sms_template ADD CONSTRAINT ck_sms_template_kind
  CHECK (kind IN ('verify', 'notice'));
ALTER TABLE sms_template ADD CONSTRAINT ck_sms_template_status
  CHECK (status IN ('active', 'pending_carrier', 'unconfigured', 'suspect', 'disabled'));
ALTER TABLE sms_template ADD CONSTRAINT ck_sms_template_configured
  CHECK (status NOT IN ('active', 'pending_carrier', 'suspect')
         OR (provider_template_id IS NOT NULL AND sign_name IS NOT NULL));
ALTER TABLE sms_template ADD CONSTRAINT ck_sms_template_params
  CHECK (jsonb_typeof(params) = 'array');
ALTER TABLE sms_template ADD CONSTRAINT ck_sms_template_text_len
  CHECK (char_length(template_key) <= 32 AND char_length(provider_template_id) <= 32 AND char_length(sign_name) <= 16);

-- notification
ALTER TABLE notification ADD CONSTRAINT ck_notification_recipient
  CHECK (num_nonnulls(merchant_user_id, staff_id) = 1);
ALTER TABLE notification ADD CONSTRAINT ck_notification_biz_type
  CHECK (biz_type ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE notification ADD CONSTRAINT ck_notification_biz_pair
  CHECK ((biz_type IS NULL) = (biz_id IS NULL));
ALTER TABLE notification ADD CONSTRAINT ck_notification_node
  CHECK (node ~ '^(N0|R[0-9]+|T-[0-9]+|M|C)$');
ALTER TABLE notification ADD CONSTRAINT ck_notification_copy_mode
  CHECK (copy_mode IN ('in_app', 'offline_contract', 'hidden'));
ALTER TABLE notification ADD CONSTRAINT ck_notification_copy_mode_audience
  CHECK ((merchant_user_id IS NOT NULL AND entity_id IS NOT NULL) = (copy_mode IS NOT NULL));
ALTER TABLE notification ADD CONSTRAINT ck_notification_source
  CHECK (num_nonnulls(source_outbox_event_id, source_rule) <= 1);
ALTER TABLE notification ADD CONSTRAINT ck_notification_store_entity
  CHECK (store_id IS NULL OR entity_id IS NOT NULL);
ALTER TABLE notification ADD CONSTRAINT ck_notification_vars
  CHECK (jsonb_typeof(vars) = 'object');
ALTER TABLE notification ADD CONSTRAINT ck_notification_text_len
  CHECK (char_length(dedupe_key) <= 160 AND char_length(source_rule) <= 24 AND char_length(node) <= 16);
CREATE INDEX ix_notification_source_outbox_event_id ON notification (source_outbox_event_id)
  WHERE source_outbox_event_id IS NOT NULL;

-- notification_delivery
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_channel
  CHECK (channel IN ('inbox', 'wx_subscribe', 'sms', 'wecom', 'mail'));
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_origin
  CHECK (origin IN ('primary', 'fallback', 'manual', 'direct'));
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_status
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'cancelled'));
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_reason
  CHECK (reason IN ('guard_invalid', 'scene_disabled', 'primary_late_success',
                    'no_target', 'no_quota', 'unconfigured', 'slot_disabled', 'policy_suppressed', 'rate_limited', 'collapsed',
                    'user_refused', 'provider_rejected', 'retry_exhausted', 'unknown_outcome', 'claim_exhausted'));
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_reason_by_status
  CHECK ((status IN ('pending', 'sending', 'sent') AND reason IS NULL)
      OR (status = 'cancelled' AND reason IS NOT NULL
          AND reason IN ('guard_invalid', 'scene_disabled', 'primary_late_success'))
      OR (status = 'skipped' AND reason IS NOT NULL
          AND reason IN ('no_target', 'no_quota', 'unconfigured', 'slot_disabled', 'policy_suppressed', 'rate_limited', 'collapsed'))
      OR (status = 'failed' AND reason IS NOT NULL
          AND reason IN ('user_refused', 'provider_rejected', 'retry_exhausted', 'unknown_outcome', 'claim_exhausted')));
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_purpose
  CHECK (purpose IN ('verify_code', 'staff_activation', 'account_notice', 'ops_alert', 'keepalive', 'test'));
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_direct
  CHECK (is_direct = (notification_id IS NULL));
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_direct_fields
  CHECK (is_direct = (origin = 'direct')
         AND is_direct = (purpose IS NOT NULL)
         AND (is_direct OR direct_key IS NULL)
         AND (NOT is_direct OR channel = 'sms' OR (channel = 'wx_subscribe' AND purpose = 'test')));
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_resend_no
  CHECK (resend_no >= 0 AND (origin = 'manual') = (resend_no > 0));
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_inbox
  CHECK (channel <> 'inbox' OR (status = 'sent' AND origin = 'primary'));
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_attempt
  CHECK (attempt_no >= 0 AND max_attempts >= 1 AND attempt_no <= max_attempts);
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_lease
  CHECK (status <> 'sending' OR lease_until IS NOT NULL);
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_sent
  CHECK (status <> 'sent' OR sent_at IS NOT NULL);
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_finished
  CHECK ((status IN ('sent', 'failed', 'skipped', 'cancelled')) = (finished_at IS NOT NULL));
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_sms_template
  CHECK ((channel = 'sms') = (sms_template_key IS NOT NULL));
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_receipt
  CHECK ((receipt_status IS NULL) = (receipt_reported_at IS NULL)
         AND (receipt_status IS NULL OR channel IN ('sms', 'wx_subscribe')));
ALTER TABLE notification_delivery ADD CONSTRAINT ck_notification_delivery_text_len
  CHECK (char_length(target_ref) <= 64 AND char_length(target_masked) <= 64 AND char_length(direct_key) <= 120
         AND char_length(provider_template_id) <= 64 AND char_length(provider_msg_id) <= 64
         AND char_length(error_code) <= 32 AND char_length(error_msg) <= 200 AND char_length(receipt_status) <= 16);
CREATE INDEX ix_notification_delivery_pending_due ON notification_delivery (due_at)
  WHERE status = 'pending';
CREATE INDEX ix_notification_delivery_sending_lease ON notification_delivery (lease_until)
  WHERE status = 'sending';
CREATE INDEX ix_notification_delivery_provider_msg_id ON notification_delivery (channel, provider_msg_id)
  WHERE provider_msg_id IS NOT NULL;

-- merchant_message
ALTER TABLE merchant_message ADD CONSTRAINT ck_merchant_message_category
  CHECK (category IN ('order', 'delivery', 'launch', 'plan_points', 'review', 'store', 'service', 'system'));
ALTER TABLE merchant_message ADD CONSTRAINT ck_merchant_message_store_entity
  CHECK (store_id IS NULL OR entity_id IS NOT NULL);
ALTER TABLE merchant_message ADD CONSTRAINT ck_merchant_message_link
  CHECK (jsonb_typeof(link) = 'object' AND link ? 'route');
ALTER TABLE merchant_message ADD CONSTRAINT ck_merchant_message_text_len
  CHECK (char_length(title) <= 40 AND char_length(body) <= 200 AND char_length(cta_text) <= 12);
CREATE INDEX ix_merchant_message_unread ON merchant_message (merchant_user_id, entity_id, category, store_id)
  WHERE read_at IS NULL;

-- staff_message
ALTER TABLE staff_message ADD CONSTRAINT ck_staff_message_kind
  CHECK (kind IN ('todo', 'alert', 'approval', 'system'));
ALTER TABLE staff_message ADD CONSTRAINT ck_staff_message_link
  CHECK (jsonb_typeof(link) = 'object' AND link ? 'route');
ALTER TABLE staff_message ADD CONSTRAINT ck_staff_message_text_len
  CHECK (char_length(title) <= 40 AND char_length(body) <= 200);
CREATE INDEX ix_staff_message_unread ON staff_message (staff_id)
  WHERE read_at IS NULL;

-- wx_subscribe_quota
ALTER TABLE wx_subscribe_quota ADD CONSTRAINT ck_wx_subscribe_quota_state
  CHECK (state IN ('ok', 'rejected', 'banned'));
ALTER TABLE wx_subscribe_quota ADD CONSTRAINT ck_wx_subscribe_quota_est_remaining
  CHECK (est_remaining >= 0);
ALTER TABLE wx_subscribe_quota ADD CONSTRAINT ck_wx_subscribe_quota_state_remaining
  CHECK (state = 'ok' OR est_remaining = 0);
ALTER TABLE wx_subscribe_quota ADD CONSTRAINT ck_wx_subscribe_quota_text_len
  CHECK (char_length(last_error_code) <= 16);
-- 冗余的 merchant_user_id 创建时取自身份行；身份行的账号不可改（02 分组，改绑按删旧行、插新行），本行三列也不可改。
CREATE TRIGGER trg_wx_subscribe_quota_immutable
  BEFORE UPDATE OF wechat_identity_id, wx_template_slot_key, merchant_user_id
  ON wx_subscribe_quota
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('wechat_identity_id', 'wx_template_slot_key', 'merchant_user_id');

-- manual_reminder_log
ALTER TABLE manual_reminder_log ADD CONSTRAINT ck_manual_reminder_log_subject_type
  CHECK (subject_type IN ('delivery_ticket', 'ad', 'order_item', 'takedown_task', 'patrol_task', 'subscription_term'));
ALTER TABLE manual_reminder_log ADD CONSTRAINT ck_manual_reminder_log_scene
  CHECK (scene IN ('confirm_plan', 'confirm_ad', 'confirm_sample', 'golive', 'takedown', 'breach', 'patrol_fix', 'renewal'));
ALTER TABLE manual_reminder_log ADD CONSTRAINT ck_manual_reminder_log_scene_subject
  CHECK ((scene IN ('confirm_plan', 'confirm_sample') AND subject_type = 'delivery_ticket')
      OR (scene = 'confirm_ad' AND subject_type = 'ad')
      OR (scene = 'golive' AND subject_type = 'order_item')
      OR (scene IN ('takedown', 'breach') AND subject_type = 'takedown_task')
      OR (scene = 'patrol_fix' AND subject_type = 'patrol_task')
      OR (scene = 'renewal' AND subject_type = 'subscription_term'));
CREATE TRIGGER trg_manual_reminder_log_append_only BEFORE UPDATE OR DELETE ON manual_reminder_log
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();
CREATE TRIGGER trg_manual_reminder_log_no_truncate BEFORE TRUNCATE ON manual_reminder_log
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- agreement
ALTER TABLE agreement ADD CONSTRAINT ck_agreement_key
  CHECK (key ~ '^[a-z][a-z0-9_]*$');
ALTER TABLE agreement ADD CONSTRAINT ck_agreement_subject_kind
  CHECK (subject_kind IN ('user', 'entity', 'partner'));
ALTER TABLE agreement ADD CONSTRAINT ck_agreement_consent_mode
  CHECK (consent_mode IN ('checkbox', 'by_action', 'esign'));
ALTER TABLE agreement ALTER COLUMN scenes SET NOT NULL;
ALTER TABLE agreement ADD CONSTRAINT ck_agreement_scenes
  CHECK (scenes <@ ARRAY['login', 'reconsent', 'member_join', 'plan_purchase', 'topup', 'order_submit', 'ad_request']::text[]);
ALTER TABLE agreement ADD CONSTRAINT ck_agreement_since_version
  CHECK (since_version IN ('V1.0', 'V1.1'));
ALTER TABLE agreement ADD CONSTRAINT ck_agreement_text_len
  CHECK (char_length(key) <= 24);

-- agreement_version
ALTER TABLE agreement_version ADD CONSTRAINT ck_agreement_version_status
  CHECK (status IN ('draft', 'pending', 'active', 'superseded', 'withdrawn'));
ALTER TABLE agreement_version ADD CONSTRAINT ck_agreement_version_version_no
  CHECK (major >= 1 AND minor >= 0);
ALTER TABLE agreement_version ADD CONSTRAINT ck_agreement_version_effective_at
  CHECK (status = 'draft' OR effective_at IS NOT NULL);
ALTER TABLE agreement_version ADD CONSTRAINT ck_agreement_version_published
  CHECK (status = 'draft'
         OR (pdf_file_id IS NOT NULL AND content_sha256 IS NOT NULL AND summary IS NOT NULL
             AND is_legal_approved AND published_by_staff_id IS NOT NULL));
ALTER TABLE agreement_version ADD CONSTRAINT ck_agreement_version_html
  CHECK ((content_html IS NULL) = (html_sha256 IS NULL) AND (content_html IS NULL OR source_file_id IS NOT NULL));
ALTER TABLE agreement_version ADD CONSTRAINT ck_agreement_version_content_sha256
  CHECK (content_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE agreement_version ADD CONSTRAINT ck_agreement_version_html_sha256
  CHECK (html_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE agreement_version ADD CONSTRAINT ck_agreement_version_activated
  CHECK ((status IN ('active', 'superseded')) = (activated_at IS NOT NULL));
ALTER TABLE agreement_version ADD CONSTRAINT ck_agreement_version_expected_consents
  CHECK (expected_consents IS NULL OR (expected_consents >= 0 AND status IN ('active', 'superseded')));
ALTER TABLE agreement_version ADD CONSTRAINT ck_agreement_version_notice
  CHECK ((site_notice_id IS NULL OR agreement_key IN ('member', 'points'))
         AND (short_notice_reason IS NULL OR site_notice_id IS NOT NULL)
         AND (status = 'draft' OR agreement_key NOT IN ('member', 'points') OR site_notice_id IS NOT NULL));
ALTER TABLE agreement_version ADD CONSTRAINT ck_agreement_version_text_len
  CHECK (char_length(summary) BETWEEN 1 AND 60 AND char_length(short_notice_reason) <= 100);
CREATE UNIQUE INDEX uq_agreement_version_agreement_key_major_minor ON agreement_version (agreement_key, major, minor)
  WHERE status <> 'withdrawn';
CREATE UNIQUE INDEX uq_agreement_version_one_draft ON agreement_version (agreement_key) WHERE status = 'draft';
CREATE UNIQUE INDEX uq_agreement_version_one_pending ON agreement_version (agreement_key) WHERE status = 'pending';
CREATE UNIQUE INDEX uq_agreement_version_one_active ON agreement_version (agreement_key) WHERE status = 'active';
CREATE TRIGGER trg_agreement_version_guard BEFORE UPDATE OR DELETE ON agreement_version
  FOR EACH ROW EXECUTE FUNCTION lyx_13_agreement_version_guard();

-- agreement_consent
ALTER TABLE agreement_consent ADD CONSTRAINT ck_agreement_consent_scene
  CHECK (scene IN ('login', 'reconsent', 'member_join', 'plan_purchase', 'topup', 'order_submit', 'ad_request'));
ALTER TABLE agreement_consent ADD CONSTRAINT ck_agreement_consent_method
  CHECK (method IN ('checkbox', 'by_action', 'prior_consent'));
ALTER TABLE agreement_consent ADD CONSTRAINT ck_agreement_consent_method_scene
  CHECK ((method <> 'by_action' OR scene IN ('plan_purchase', 'topup'))
         AND (method <> 'prior_consent' OR scene = 'ad_request'));
ALTER TABLE agreement_consent ADD CONSTRAINT ck_agreement_consent_role
  CHECK (role IN ('owner', 'clerk'));
ALTER TABLE agreement_consent ADD CONSTRAINT ck_agreement_consent_biz_type
  CHECK (biz_type IN ('billing_order', 'drama_order', 'ad'));
ALTER TABLE agreement_consent ADD CONSTRAINT ck_agreement_consent_biz_pair
  CHECK ((biz_type IS NULL) = (biz_id IS NULL) AND (biz_id IS NULL) = (biz_no IS NULL));
ALTER TABLE agreement_consent ADD CONSTRAINT ck_agreement_consent_biz_no
  CHECK ((biz_type IS NULL AND biz_no IS NULL)
      OR (biz_no IS NOT NULL
          AND ((biz_type = 'billing_order' AND biz_no ~ '^T?FK[0-9]+$')
            OR (biz_type = 'drama_order' AND biz_no ~ '^T?LYX[0-9]+$')
            OR (biz_type = 'ad' AND biz_no ~ '^T?GG[0-9]+$'))));
ALTER TABLE agreement_consent ADD CONSTRAINT ck_agreement_consent_scene_biz
  CHECK ((scene IN ('login', 'reconsent', 'member_join') AND biz_type IS NULL)
      OR (scene IN ('plan_purchase', 'topup') AND biz_type IS NOT NULL AND biz_type = 'billing_order')
      OR (scene = 'order_submit' AND biz_type IS NOT NULL AND biz_type = 'drama_order')
      OR (scene = 'ad_request' AND biz_type IS NOT NULL AND biz_type = 'ad'));
ALTER TABLE agreement_consent ADD CONSTRAINT ck_agreement_consent_content_sha256
  CHECK (content_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE agreement_consent ADD CONSTRAINT ck_agreement_consent_openid
  CHECK ((appid IS NULL) = (openid_hmac IS NULL) AND (openid_hmac IS NULL OR octet_length(openid_hmac) = 32));
ALTER TABLE agreement_consent ADD CONSTRAINT ck_agreement_consent_scope
  CHECK ((scene NOT IN ('plan_purchase', 'topup', 'order_submit', 'ad_request') OR entity_id IS NOT NULL)
         AND (scene NOT IN ('order_submit', 'ad_request') OR store_id IS NOT NULL)
         AND (store_id IS NULL OR entity_id IS NOT NULL));
ALTER TABLE agreement_consent ADD CONSTRAINT ck_agreement_consent_entity_snapshot
  CHECK ((entity_id IS NOT NULL OR (entity_name IS NULL AND uscc_enc IS NULL))
         AND (uscc_enc IS NULL) = (uscc_mask IS NULL));
ALTER TABLE agreement_consent ADD CONSTRAINT ck_agreement_consent_device_snapshot
  CHECK (jsonb_typeof(device_snapshot) = 'object');
ALTER TABLE agreement_consent ADD CONSTRAINT ck_agreement_consent_text_len
  CHECK (char_length(appid) <= 32 AND char_length(user_agent) <= 300 AND char_length(request_id) <= 40
         AND char_length(operator_name_mask) <= 20 AND char_length(biz_no) <= 40);
CREATE UNIQUE INDEX uq_agreement_consent_biz ON agreement_consent (merchant_user_id, agreement_version_id, biz_type, biz_id)
  WHERE biz_id IS NOT NULL;
CREATE UNIQUE INDEX uq_agreement_consent_no_biz ON agreement_consent (merchant_user_id, agreement_version_id)
  WHERE biz_id IS NULL;
CREATE TRIGGER trg_agreement_consent_before_insert BEFORE INSERT ON agreement_consent
  FOR EACH ROW EXECUTE FUNCTION lyx_13_agreement_consent_before_insert();
CREATE TRIGGER trg_agreement_consent_append_only BEFORE UPDATE OR DELETE ON agreement_consent
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();
CREATE TRIGGER trg_agreement_consent_no_truncate BEFORE TRUNCATE ON agreement_consent
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- license_letter
ALTER TABLE license_letter ADD CONSTRAINT ck_license_letter_platform
  CHECK (platform IN ('douyin', 'wechat_channels'));
ALTER TABLE license_letter ADD CONSTRAINT ck_license_letter_status
  CHECK (status IN ('pending_effective', 'effective', 'voided'));
ALTER TABLE license_letter ADD CONSTRAINT ck_license_letter_void_reason
  CHECK (void_reason IN ('cancelled', 'terminated', 'account_removed', 'manual'));
ALTER TABLE license_letter ADD CONSTRAINT ck_license_letter_voided
  CHECK ((status = 'voided') = (voided_at IS NOT NULL) AND (voided_at IS NULL) = (void_reason IS NULL));
ALTER TABLE license_letter ADD CONSTRAINT ck_license_letter_period
  CHECK ((status = 'voided'
          OR (status = 'pending_effective' AND period_start IS NULL)
          OR (status = 'effective' AND period_start IS NOT NULL))
         AND (period_start IS NULL OR period_start <= period_end));
ALTER TABLE license_letter ADD CONSTRAINT ck_license_letter_letter_no
  CHECK (char_length(letter_no) <= 40
         AND ((platform = 'douyin' AND letter_no ~ '^T?SQ[0-9]+-[0-9]+-DY(-[0-9]+)?$')
           OR (platform = 'wechat_channels' AND letter_no ~ '^T?SQ[0-9]+-[0-9]+-SPH(-[0-9]+)?$')));
ALTER TABLE license_letter ADD CONSTRAINT ck_license_letter_verify_code
  CHECK (verify_code ~ '^[A-Za-z0-9]{16}$');
CREATE UNIQUE INDEX uq_license_letter_active ON license_letter (order_item_id, channel_account_id)
  WHERE status <> 'voided';
CREATE TRIGGER trg_license_letter_immutable
  BEFORE UPDATE OF letter_no, drama_order_id, order_item_id, channel_account_id, entity_id, store_id, drama_id, platform, verify_code
  ON license_letter
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'letter_no', 'drama_order_id', 'order_item_id', 'channel_account_id', 'entity_id', 'store_id', 'drama_id', 'platform', 'verify_code');
CREATE TRIGGER trg_license_letter_no_delete BEFORE DELETE ON license_letter
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_license_letter_no_truncate BEFORE TRUNCATE ON license_letter
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- license_letter_revision
ALTER TABLE license_letter_revision ADD CONSTRAINT ck_license_letter_revision_reason
  CHECK (reason IN ('initial', 'go_live', 'period_changed', 'correction', 'resign'));
ALTER TABLE license_letter_revision ADD CONSTRAINT ck_license_letter_revision_render_status
  CHECK (render_status IN ('queued', 'rendering', 'ready', 'failed'));
ALTER TABLE license_letter_revision ADD CONSTRAINT ck_license_letter_revision_sign_mode
  CHECK (sign_mode IN ('platform_cert', 'esign_seal', 'stamp'));
ALTER TABLE license_letter_revision ADD CONSTRAINT ck_license_letter_revision_rev_no
  CHECK (rev_no >= 1 AND (rev_no = 1) = (reason = 'initial'));
ALTER TABLE license_letter_revision ADD CONSTRAINT ck_license_letter_revision_content_fp
  CHECK (content_fp ~ '^[0-9a-f]{64}$');
ALTER TABLE license_letter_revision ADD CONSTRAINT ck_license_letter_revision_pdf_sha256
  CHECK (pdf_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE license_letter_revision ADD CONSTRAINT ck_license_letter_revision_letter_snapshot
  CHECK (jsonb_typeof(letter_snapshot) = 'object');
ALTER TABLE license_letter_revision ADD CONSTRAINT ck_license_letter_revision_render_attempt_no
  CHECK (render_attempt_no >= 0);
ALTER TABLE license_letter_revision ADD CONSTRAINT ck_license_letter_revision_render_lease
  CHECK (render_status <> 'rendering' OR render_lease_until IS NOT NULL);
ALTER TABLE license_letter_revision ADD CONSTRAINT ck_license_letter_revision_ready
  CHECK ((render_status = 'ready') = (ready_at IS NOT NULL)
         AND (render_status <> 'ready'
              OR (file_id IS NOT NULL AND pdf_sha256 IS NOT NULL AND sign_mode IS NOT NULL AND platform_signed_at IS NOT NULL))
         AND (render_status = 'ready'
              OR (file_id IS NULL AND pdf_sha256 IS NULL AND platform_signed_at IS NULL AND merchant_signed_at IS NULL)));
ALTER TABLE license_letter_revision ADD CONSTRAINT ck_license_letter_revision_cert
  CHECK ((sign_mode IS DISTINCT FROM 'stamp' OR (cert_serial IS NULL AND cert_issuer IS NULL))
         AND (sign_mode IS DISTINCT FROM 'platform_cert' OR render_status <> 'ready' OR (cert_serial IS NOT NULL AND cert_issuer IS NOT NULL)));
ALTER TABLE license_letter_revision ADD CONSTRAINT ck_license_letter_revision_esign
  CHECK ((esign_flow_id IS NULL OR esign_provider IS NOT NULL)
         AND (merchant_signed_at IS NULL OR esign_flow_id IS NOT NULL));
ALTER TABLE license_letter_revision ADD CONSTRAINT ck_license_letter_revision_text_len
  CHECK (char_length(trigger_ref) <= 80 AND char_length(template_version) <= 12);
CREATE INDEX ix_license_letter_revision_render_queue ON license_letter_revision (created_at)
  WHERE render_status IN ('queued', 'rendering');
CREATE TRIGGER trg_license_letter_revision_immutable
  BEFORE UPDATE OF license_letter_id, rev_no, reason, trigger_ref, letter_snapshot, content_fp, template_version
  ON license_letter_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'license_letter_id', 'rev_no', 'reason', 'trigger_ref', 'letter_snapshot', 'content_fp', 'template_version');
CREATE TRIGGER trg_license_letter_revision_no_delete BEFORE DELETE ON license_letter_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_license_letter_revision_no_truncate BEFORE TRUNCATE ON license_letter_revision
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();
