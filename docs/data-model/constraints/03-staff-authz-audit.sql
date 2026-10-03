-- 分组 03-staff-authz-audit：员工、运营跟进记录、权限、审计与统一审批单
-- 手写约束：CHECK、部分唯一索引、部分索引、序列、触发器、清理函数。
-- 依赖 00-common.sql（lyx_forbid_mutation、lyx_forbid_update、lyx_forbid_column_change）。本文件自定义的函数以 lyx_03_ 开头。
-- 外键全部在 Prisma 片段里（含 M47 的门店复合外键），本文件不写外键。
-- 语句可在 PostgreSQL 14 上执行。

-- staff_role
ALTER TABLE staff_role ADD CONSTRAINT ck_staff_role_key
  CHECK (key IN ('super_admin','cs','delivery_manager','editor','publisher','content_ops','channel_ops','finance'));
ALTER TABLE staff_role ADD CONSTRAINT ck_staff_role_data_scope
  CHECK (data_scope IN ('own','group','all'));
ALTER TABLE staff_role ADD CONSTRAINT ck_staff_role_available_from
  CHECK (available_from IN ('v1.0','v1.1'));
ALTER TABLE staff_role ADD CONSTRAINT ck_staff_role_json_shape
  CHECK (jsonb_typeof(module_levels) = 'object' AND jsonb_typeof(actions) = 'object');
ALTER TABLE staff_role ADD CONSTRAINT ck_staff_role_super_admin_locked
  CHECK (key <> 'super_admin' OR is_locked);

-- staff_group
CREATE UNIQUE INDEX uq_staff_group_default_role ON staff_group (staff_role_key) WHERE is_default;

-- staff
ALTER SEQUENCE staff_staff_no_seq RESTART WITH 1001;
ALTER TABLE staff ADD CONSTRAINT ck_staff_staff_no
  CHECK (staff_no >= 1001);
ALTER TABLE staff ADD CONSTRAINT ck_staff_status
  CHECK (status IN ('pending','active','disabled'));
ALTER TABLE staff ADD CONSTRAINT ck_staff_phone_bidx_len
  CHECK (octet_length(phone_bidx) = 32);
ALTER TABLE staff ADD CONSTRAINT ck_staff_phone_last4
  CHECK (phone_last4 ~ '^[0-9]{4}$');
ALTER TABLE staff ADD CONSTRAINT ck_staff_wecom_bind_status
  CHECK (wecom_bind_status IN ('none','invited','bound','unbound'));
-- 已绑定必有 userid 与绑定时间；从未绑定（none）没有 userid；解绑（unbound）与再次邀请（invited）可保留原 userid，
-- 供企业微信回调（外部联系人变更、离职继承）对到员工。
ALTER TABLE staff ADD CONSTRAINT ck_staff_wecom_bound
  CHECK ((wecom_bind_status <> 'bound' OR (wecom_userid IS NOT NULL AND wecom_bound_at IS NOT NULL))
         AND (wecom_bind_status <> 'none' OR wecom_userid IS NULL));
ALTER TABLE staff ADD CONSTRAINT ck_staff_totp_enrolled
  CHECK ((totp_secret_enc IS NULL) = (totp_enrolled_at IS NULL));
ALTER TABLE staff ADD CONSTRAINT ck_staff_totp_pending
  CHECK ((totp_pending_secret_enc IS NULL) = (totp_pending_at IS NULL));
ALTER TABLE staff ADD CONSTRAINT ck_staff_recovery_codes
  CHECK (jsonb_typeof(recovery_codes) = 'array');
ALTER TABLE staff ADD CONSTRAINT ck_staff_fail_counts
  CHECK (fail_untrusted >= 0 AND fail_trusted >= 0);
ALTER TABLE staff ADD CONSTRAINT ck_staff_disabled_reason
  CHECK (disabled_reason IS NULL OR disabled_reason IN ('resigned','reassigned','long_leave','other'));
ALTER TABLE staff ADD CONSTRAINT ck_staff_disabled_fields
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL)
         AND (status = 'disabled') = (disabled_reason IS NOT NULL)
         AND (status = 'disabled' OR (disabled_by_staff_id IS NULL AND handover_to_staff_id IS NULL)));
ALTER TABLE staff ADD CONSTRAINT ck_staff_not_self
  CHECK ((handover_to_staff_id IS NULL OR handover_to_staff_id <> id)
         AND (disabled_by_staff_id IS NULL OR disabled_by_staff_id <> id));

-- staff_activation
ALTER TABLE staff_activation ADD CONSTRAINT ck_staff_activation_purpose
  CHECK (purpose IN ('activate','reset_password'));
ALTER TABLE staff_activation ADD CONSTRAINT ck_staff_activation_delivery
  CHECK (delivery IN ('sms','manual'));
ALTER TABLE staff_activation ADD CONSTRAINT ck_staff_activation_code_hash_len
  CHECK (octet_length(code_hash) = 32);
ALTER TABLE staff_activation ADD CONSTRAINT ck_staff_activation_attempts
  CHECK (attempts BETWEEN 0 AND 5);
ALTER TABLE staff_activation ADD CONSTRAINT ck_staff_activation_used_or_revoked
  CHECK (used_at IS NULL OR revoked_at IS NULL);
ALTER TABLE staff_activation ADD CONSTRAINT ck_staff_activation_expires
  CHECK (expires_at > created_at);
CREATE UNIQUE INDEX uq_staff_activation_live ON staff_activation (staff_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- staff_session
ALTER TABLE staff_session ADD CONSTRAINT ck_staff_session_auth_method
  CHECK (auth_method IN ('password+totp','password+recovery'));
ALTER TABLE staff_session ADD CONSTRAINT ck_staff_session_token_hash_len
  CHECK (octet_length(token_hash) = 32);
ALTER TABLE staff_session ADD CONSTRAINT ck_staff_session_revoke_reason
  CHECK (revoke_reason IS NULL OR revoke_reason IN ('logout','disabled','password_reset','mfa_reset','phone_changed','admin'));
ALTER TABLE staff_session ADD CONSTRAINT ck_staff_session_revoked
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL));
ALTER TABLE staff_session ADD CONSTRAINT ck_staff_session_expiry
  CHECK (absolute_expires_at > created_at AND idle_expires_at > created_at AND stepup_at >= created_at);
CREATE INDEX ix_staff_session_staff_id_active ON staff_session (staff_id) WHERE revoked_at IS NULL;

-- assignment_pool_member
ALTER TABLE assignment_pool_member ADD CONSTRAINT ck_assignment_pool_member_pool
  CHECK (pool IN ('delivery_manager','editor','publisher','cs'));
ALTER TABLE assignment_pool_member ADD CONSTRAINT ck_assignment_pool_member_city
  CHECK (pool = 'delivery_manager' OR city_code = '');
ALTER TABLE assignment_pool_member ADD CONSTRAINT ck_assignment_pool_member_on_duty
  CHECK (pool = 'cs' OR on_duty);

-- assignment_cursor
ALTER TABLE assignment_cursor ADD CONSTRAINT ck_assignment_cursor_pool
  CHECK (pool IN ('delivery_manager','editor','publisher','cs'));
ALTER TABLE assignment_cursor ADD CONSTRAINT ck_assignment_cursor_scope_key
  CHECK (scope_key <> '' AND (pool = 'delivery_manager' OR scope_key = 'all'));

-- assignment_history
ALTER TABLE assignment_history ADD CONSTRAINT ck_assignment_history_source
  CHECK (source IN ('store_manager','ticket_editor','ticket_publisher','ad_editor','service_ticket_owner','follow_up_owner'));
ALTER TABLE assignment_history ADD CONSTRAINT ck_assignment_history_subject_type
  CHECK (subject_type IN ('store','drama_order','delivery_ticket','ad','service_ticket','follow_up'));
ALTER TABLE assignment_history ADD CONSTRAINT ck_assignment_history_source_subject
  CHECK (CASE source
           WHEN 'store_manager'        THEN subject_type IN ('store','drama_order','delivery_ticket','service_ticket')
           WHEN 'ticket_editor'        THEN subject_type = 'delivery_ticket'
           WHEN 'ticket_publisher'     THEN subject_type = 'delivery_ticket'
           WHEN 'ad_editor'            THEN subject_type = 'ad'
           WHEN 'service_ticket_owner' THEN subject_type = 'service_ticket'
           WHEN 'follow_up_owner'      THEN subject_type = 'follow_up'
           ELSE false
         END);
ALTER TABLE assignment_history ADD CONSTRAINT ck_assignment_history_reason_code
  CHECK (reason_code IN ('resigned','reassigned','long_leave','workload','merchant_request','staff_change','invariant_fix','other'));
ALTER TABLE assignment_history ADD CONSTRAINT ck_assignment_history_from_to
  CHECK (from_staff_id <> to_staff_id);
ALTER TABLE assignment_history ADD CONSTRAINT ck_assignment_history_actor_type
  CHECK (actor_type IN ('staff','system'));
-- 员工操作只来自后台（client = admin）；系统动作 client 为空。
ALTER TABLE assignment_history ADD CONSTRAINT ck_assignment_history_actor
  CHECK ((actor_type = 'system') = (actor_id IS NULL)
         AND (actor_type = 'system') = (client IS NULL));
ALTER TABLE assignment_history ADD CONSTRAINT ck_assignment_history_client
  CHECK (client IS NULL OR client = 'admin');
-- 门店交付经理变更的行必带联系截止时间与快照（含禁用移交与不变量自动改派），其余行没有；
-- “已联系”与“作废”互斥，两者都要求有截止时间。
ALTER TABLE assignment_history ADD CONSTRAINT ck_assignment_history_contact
  CHECK ((contact_due_at IS NULL) = (sla_snapshot IS NULL)
         AND (contact_due_at IS NOT NULL) = (source = 'store_manager' AND subject_type = 'store')
         AND (contact_due_at IS NOT NULL OR (contacted_at IS NULL AND contact_voided_at IS NULL))
         AND (contacted_at IS NULL) = (contacted_by_staff_id IS NULL)
         AND (contacted_at IS NULL OR contact_voided_at IS NULL));
CREATE INDEX ix_assignment_history_contact_pending ON assignment_history (to_staff_id, contact_due_at)
  WHERE contact_due_at IS NOT NULL AND contacted_at IS NULL AND contact_voided_at IS NULL;

-- 受限更新：只允许补“已联系”或“作废”标记、（关闭前）重算联系截止时间；其余列不可改，不可删。
CREATE OR REPLACE FUNCTION lyx_03_assignment_history_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := ARRAY['contact_due_at','sla_snapshot','contacted_at','contacted_by_staff_id','contact_voided_at','updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'table %: DELETE not allowed', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'table %: only columns % may be written', TG_TABLE_NAME, mutable USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD.contacted_at IS NOT NULL OR OLD.contact_voided_at IS NOT NULL)
     AND ROW(NEW.contacted_at, NEW.contacted_by_staff_id, NEW.contact_voided_at, NEW.contact_due_at, NEW.sla_snapshot)
         IS DISTINCT FROM ROW(OLD.contacted_at, OLD.contacted_by_staff_id, OLD.contact_voided_at, OLD.contact_due_at, OLD.sla_snapshot) THEN
    RAISE EXCEPTION 'table %: contact columns are frozen once contacted_at or contact_voided_at is set', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD.contact_due_at IS NULL) <> (NEW.contact_due_at IS NULL) THEN
    RAISE EXCEPTION 'table %: contact_due_at can be recomputed but not added or removed', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_assignment_history_guard BEFORE UPDATE OR DELETE ON assignment_history
  FOR EACH ROW EXECUTE FUNCTION lyx_03_assignment_history_guard();
CREATE TRIGGER trg_assignment_history_no_truncate BEFORE TRUNCATE ON assignment_history
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- follow_up
ALTER TABLE follow_up ADD CONSTRAINT ck_follow_up_subject_type
  CHECK (subject_type IN ('order_item','subscription_term','store','patrol_task','takedown_task','delivery_reissue'));
-- channel 为空 = 未注明（“逾期跟踪”的记录弹窗没有方式这一项）。
ALTER TABLE follow_up ADD CONSTRAINT ck_follow_up_channel
  CHECK (channel IS NULL OR channel IN ('wecom','phone','visit','system'));
ALTER TABLE follow_up ADD CONSTRAINT ck_follow_up_intent
  CHECK (intent IS NULL OR (intent IN ('confirmed','considering','declined') AND subject_type = 'subscription_term'));
ALTER TABLE follow_up ADD CONSTRAINT ck_follow_up_actor_type
  CHECK (actor_type IN ('staff','system'));
-- 系统生成 ⇔ 无记录人 ⇔ 无客户端 ⇔ channel = system。
ALTER TABLE follow_up ADD CONSTRAINT ck_follow_up_actor
  CHECK ((actor_type = 'system') = (actor_id IS NULL)
         AND (actor_type = 'system') = (client IS NULL)
         AND (actor_type = 'system') = (channel IS NOT DISTINCT FROM 'system'));
ALTER TABLE follow_up ADD CONSTRAINT ck_follow_up_client
  CHECK (client IS NULL OR client = 'admin');
-- 系统生成的行都是待办，写入时必带下次跟进时间（在办 = next_follow_at 非空且 done_at 为空）。
ALTER TABLE follow_up ADD CONSTRAINT ck_follow_up_system_todo
  CHECK (actor_type <> 'system' OR next_follow_at IS NOT NULL);
ALTER TABLE follow_up ADD CONSTRAINT ck_follow_up_done
  CHECK (done_note IS NULL OR done_at IS NOT NULL);
ALTER TABLE follow_up ADD CONSTRAINT ck_follow_up_subject_store
  CHECK (subject_type <> 'store' OR subject_id IS NOT DISTINCT FROM store_id);
CREATE INDEX ix_follow_up_next_follow_at ON follow_up (next_follow_at)
  WHERE next_follow_at IS NOT NULL AND done_at IS NULL;
CREATE INDEX ix_follow_up_owner_open ON follow_up (owner_staff_id, next_follow_at)
  WHERE owner_staff_id IS NOT NULL AND next_follow_at IS NOT NULL AND done_at IS NULL;

-- audit_log
-- 展示用编号的序列：循环范围取 7 位，日内不可能绕回。
CREATE SEQUENCE audit_no_seq MINVALUE 1 MAXVALUE 9999999 CYCLE;

-- 插入触发器：同一次取 clock_timestamp()，同时生成 created_at 与 log_no，应用传入的值被覆盖。
CREATE OR REPLACE FUNCTION lyx_03_audit_log_before_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  n bigint := nextval('audit_no_seq');
BEGIN
  NEW.created_at := clock_timestamp();
  NEW.log_no := 'RZ' || to_char(NEW.created_at AT TIME ZONE 'Asia/Shanghai', 'YYYYMMDD')
                     || lpad(n::text, greatest(5, length(n::text)), '0');
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_audit_log_bi BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION lyx_03_audit_log_before_insert();
CREATE TRIGGER trg_audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();
CREATE TRIGGER trg_audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- CHECK 只加在由类型化代码写入的列上（stream、actor_type、client 是代码枚举，target_type 取自契约登记的表名）。
-- 列间关系（操作人与客户端、target_id 与 target_key、门店与主体）由 audit.record 规范化保证、每日校验复核，
-- 不写 CHECK：record 的契约是“永不因内容格式失败”（d4:1609），审计写失败会让业务事务回滚。
ALTER TABLE audit_log ADD CONSTRAINT ck_audit_log_stream
  CHECK (stream IN ('ops','activity','access'));
ALTER TABLE audit_log ADD CONSTRAINT ck_audit_log_actor_type
  CHECK (actor_type IN ('merchant','staff','system','partner'));
-- cli：运维命令行以员工身份执行的操作（M102），只在审计日志上允许；其他表的 client 仍是 weapp、portal、admin。
ALTER TABLE audit_log ADD CONSTRAINT ck_audit_log_client
  CHECK (client IS NULL OR client IN ('weapp','portal','admin','cli'));
-- 跨模块多态类型列只写格式 CHECK（M52），取值清单在 packages/contract 登记。
ALTER TABLE audit_log ADD CONSTRAINT ck_audit_log_target_type
  CHECK (target_type IS NULL OR target_type ~ '^[a-z][a-z0-9_]*$');
CREATE INDEX ix_audit_log_store_created_at ON audit_log (store_id, created_at DESC)
  WHERE store_id IS NOT NULL;
-- 主体级事件（没有门店）：门店活动流的第二条有序查询。
CREATE INDEX ix_audit_log_entity_created_at ON audit_log (entity_id, created_at DESC)
  WHERE entity_id IS NOT NULL AND store_id IS NULL;
CREATE INDEX ix_audit_log_target_key ON audit_log (target_type, target_key)
  WHERE target_key IS NOT NULL;

-- auth_event
ALTER TABLE auth_event ADD CONSTRAINT ck_auth_event_space
  CHECK (space IN ('merchant','staff','portal'));
ALTER TABLE auth_event ADD CONSTRAINT ck_auth_event_event
  CHECK (event IN ('login_success','login_fail','locked','step_up','identity_rebound','identity_removed',
                   'reverify_required','logout','offnet_denied'));
-- 只拦 UPDATE；DELETE 只经下面的清理函数（应用角色不授予 DELETE）。
CREATE TRIGGER trg_auth_event_no_update BEFORE UPDATE ON auth_event
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_update();
CREATE TRIGGER trg_auth_event_no_truncate BEFORE TRUNCATE ON auth_event
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- 清理函数：只能删除 12 个月以前的行；由迁移账号创建，worker 每日调用。
CREATE OR REPLACE FUNCTION lyx_03_purge_auth_event(p_before timestamptz) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n bigint;
BEGIN
  IF p_before IS NULL OR p_before > now() - interval '12 months' THEN
    RAISE EXCEPTION 'auth_event: rows newer than 12 months cannot be purged' USING ERRCODE = 'restrict_violation';
  END IF;
  DELETE FROM auth_event WHERE created_at < p_before;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- approval_request
-- Prisma 的标量数组列建表时不带 NOT NULL，这里补上。
ALTER TABLE approval_request ALTER COLUMN reason_codes SET NOT NULL;
ALTER TABLE approval_request ALTER COLUMN confirm_checks SET NOT NULL;
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_kind
  CHECK (kind IN ('qualification','channel_account','launch_link','order_cancel','ad_cancel','qualification_cancel',
                  'plan_refund','points_adjust','subscription_extend','finance_config_change','account_change',
                  'transfer_confirm'));
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_category
  CHECK (category IN ('review','approval')
         AND (category = 'review') = (kind IN ('qualification','channel_account','launch_link')));
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_status
  CHECK (status IN ('pending','approved','rejected','withdrawn'));
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_round_no
  CHECK (round_no >= 1);
-- 对象类型按 kind 固定（取值为最终表名，M19）。
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_subject_type
  CHECK (CASE kind
           WHEN 'qualification'         THEN subject_type = 'store'
           WHEN 'channel_account'       THEN subject_type = 'channel_account'
           WHEN 'launch_link'           THEN subject_type = 'launch_submission'
           WHEN 'order_cancel'          THEN subject_type = 'drama_order'
           WHEN 'ad_cancel'             THEN subject_type = 'ad'
           WHEN 'qualification_cancel'  THEN subject_type = 'store'
           WHEN 'plan_refund'           THEN subject_type IN ('billing_order','payment_txn')
           WHEN 'points_adjust'         THEN subject_type = 'billing_account'
           WHEN 'subscription_extend'   THEN subject_type = 'subscription_term'
           WHEN 'finance_config_change' THEN subject_type = 'finance_config_revision'
           WHEN 'account_change'        THEN subject_type IN ('merchant_user','entity')
           WHEN 'transfer_confirm'      THEN subject_type = 'transfer_proof'
           ELSE false
         END);
-- 归属列按 kind 必填（M13、M39）。
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_tenant
  CHECK ((store_id IS NULL OR entity_id IS NOT NULL)
         AND CASE
               WHEN kind IN ('qualification','channel_account','launch_link','order_cancel','ad_cancel','qualification_cancel')
                 THEN entity_id IS NOT NULL AND store_id IS NOT NULL
               WHEN kind IN ('points_adjust','subscription_extend','transfer_confirm')
                 THEN entity_id IS NOT NULL
               WHEN kind = 'plan_refund'
                 THEN entity_id IS NOT NULL OR subject_type = 'payment_txn'
               WHEN kind = 'finance_config_change'
                 THEN entity_id IS NULL AND store_id IS NULL
               WHEN kind = 'account_change'
                 THEN store_id IS NULL AND (subject_type <> 'entity' OR entity_id IS NOT NULL)
               ELSE false
             END);
-- 对象就是门店、主体或计费账户时，对象 id 与归属列一致。
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_subject_tenant
  CHECK ((subject_type <> 'store' OR subject_id IS NOT DISTINCT FROM store_id)
         AND (subject_type NOT IN ('entity','billing_account') OR subject_id IS NOT DISTINCT FROM entity_id));
-- 有业务单号的类型：TK（四类取消与退款）、TZ（积分调整）、YQ（补偿延长）、ZH（账号变更）。
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_request_no
  CHECK ((request_no IS NOT NULL) = (kind IN ('order_cancel','ad_cancel','qualification_cancel','plan_refund',
                                              'points_adjust','subscription_extend','account_change')));
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_submit_actor_type
  CHECK (submit_actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_submit_client
  CHECK (submit_client IS NULL OR submit_client IN ('weapp','portal','admin'));
-- 提交人：系统无 id、无客户端；员工只从后台提交且就是发起员工；商家从小程序或下载页提交。
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_submitter
  CHECK ((submit_actor_type = 'system') = (submit_actor_id IS NULL)
         AND (submit_actor_type <> 'system' OR submit_client IS NULL)
         AND (submit_actor_type <> 'staff'
              OR (submit_client IS NOT DISTINCT FROM 'admin' AND submit_actor_id IS NOT DISTINCT FROM requester_staff_id))
         AND (submit_actor_type <> 'merchant' OR COALESCE(submit_client IN ('weapp','portal'), false))
         AND (category <> 'approval' OR requester_staff_id IS NOT NULL)
         AND (requester_staff_group_id IS NULL OR requester_staff_id IS NOT NULL));
-- 发起人 ≠ 审批人（职责分离的数据库兜底）。
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_decider_not_requester
  CHECK (decided_by_staff_id IS NULL OR requester_staff_id IS NULL OR decided_by_staff_id <> requester_staff_id);
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_decision
  CHECK ((status = 'pending') = (decided_at IS NULL)
         AND (status <> 'pending' OR NOT is_decided_by_system)
         AND (status IN ('approved','rejected') OR decided_by_staff_id IS NULL)
         AND (status NOT IN ('approved','rejected') OR (decided_by_staff_id IS NOT NULL) <> is_decided_by_system)
         AND (status <> 'rejected' OR decision_note IS NOT NULL)
         AND (decided_at IS NULL OR decided_at >= submitted_at));
-- 审核类（资质、账号核验、链接核验）由员工驳回时至少选 1 个驳回原因（d3:2316；d9:523）。
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_reject_reasons
  CHECK (status <> 'rejected' OR category <> 'review' OR is_decided_by_system OR cardinality(reason_codes) >= 1);
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_checklist
  CHECK ((checklist_code IS NULL) = (checklist_version_no IS NULL)
         AND (checklist_result IS NULL OR checklist_code IS NOT NULL));
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_sla
  CHECK ((due_at IS NULL) = (sla_snapshot IS NULL));
-- 摘要由处理器在提交时生成，必有标题。
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_summary_snapshot
  CHECK (jsonb_typeof(summary_snapshot) = 'object' AND summary_snapshot ? 'title');
-- 没有执行步的 8 类必填去重键；有执行步的 4 类不填，在途唯一由领域表的 closed_at 索引表达（M12）。
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_dedupe_key
  CHECK ((dedupe_key IS NULL) = (kind IN ('order_cancel','ad_cancel','qualification_cancel','plan_refund')));
-- 链接核验的处理人按所属工单的发布专员取，工单必填。
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_delivery_ticket
  CHECK (kind <> 'launch_link' OR delivery_ticket_id IS NOT NULL);
-- 在途去重只覆盖 pending（M12），只供没有执行步的类型使用。
CREATE UNIQUE INDEX uq_approval_request_dedupe_key_pending ON approval_request (dedupe_key)
  WHERE status = 'pending' AND dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX uq_approval_request_requester_idempotency_key ON approval_request (requester_staff_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- 创建后不可改的列（M50）：单号是账本幂等键的一段（07 分组），归属、对象、提交人与摘要是证据。
-- 状态迁移要写的列（status、decided_*、decision_note、reason_codes、checklist_*、confirm_checks、due_at、sla_snapshot、
-- lock_version、updated_at）不在其中。
CREATE TRIGGER trg_approval_request_immutable BEFORE UPDATE ON approval_request
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'request_no','kind','category','subject_type','subject_id','entity_id','store_id','delivery_ticket_id','round_no',
    'summary_snapshot','submit_actor_type','submit_actor_id','submit_client','requester_staff_id','requester_staff_group_id',
    'submitted_at','dedupe_key','idempotency_key','created_at');
