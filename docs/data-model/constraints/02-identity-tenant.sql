-- 分组 02-identity-tenant：身份与租户的手写约束
-- 内容：枚举与范围 CHECK、按状态必填 CHECK、数组列的 NOT NULL、部分索引与部分唯一索引、不可变列触发器。
-- 先于本文件执行：Prisma 生成的建表语句（含全部外键与复合外键）、00-common.sql。
-- 本分组没有只增表。不可变列用公共函数 lyx_forbid_column_change（M50）；
-- 另有一个本分组函数 lyx_02_clear_only：指定列只允许从非空改为 NULL（公共文件没有这类逻辑）。

-- 本分组的触发器函数：参数列出的列在 UPDATE 时只允许“原值 → NULL”这一种变化（用于执行后清除的密文）。
-- 用法：CREATE TRIGGER trg_<表>_clear_only BEFORE UPDATE OF 列 ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_02_clear_only('列');
CREATE OR REPLACE FUNCTION lyx_02_clear_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
  c text;
BEGIN
  FOREACH c IN ARRAY TG_ARGV::text[] LOOP
    IF (o -> c) IS DISTINCT FROM (n -> c) AND (n -> c) IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'table %: column % may only be cleared', TG_TABLE_NAME, c
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- merchant_user
ALTER TABLE merchant_user ADD CONSTRAINT ck_merchant_user_status
  CHECK (status IN ('active', 'disabled', 'deleted'));
ALTER TABLE merchant_user ADD CONSTRAINT ck_merchant_user_source_type
  CHECK (source_type IN ('organic', 'sales', 'campaign', 'partner'));
-- 来源不是 organic 当且仅当命中了登记码（M6：来源由服务端按 referral_code 判定，端上不自报）
ALTER TABLE merchant_user ADD CONSTRAINT ck_merchant_user_source_referral
  CHECK ((source_referral_code_id IS NULL) = (source_type = 'organic'));
ALTER TABLE merchant_user ADD CONSTRAINT ck_merchant_user_phone_bidx_len
  CHECK (phone_bidx IS NULL OR octet_length(phone_bidx) = 32);
ALTER TABLE merchant_user ADD CONSTRAINT ck_merchant_user_phone_last4
  CHECK (phone_last4 IS NULL OR phone_last4 ~ '^[0-9]{4}$');
ALTER TABLE merchant_user ADD CONSTRAINT ck_merchant_user_deleted
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL));
ALTER TABLE merchant_user ADD CONSTRAINT ck_merchant_user_pii_by_status
  CHECK (
    (status = 'deleted'
      AND phone_enc IS NULL AND phone_bidx IS NULL AND phone_mask IS NULL
      AND phone_last4 IS NULL AND display_name IS NULL)
    OR
    (status <> 'deleted'
      AND phone_enc IS NOT NULL AND phone_bidx IS NOT NULL AND phone_mask IS NOT NULL
      AND phone_last4 IS NOT NULL)
  );
CREATE TRIGGER trg_merchant_user_immutable
  BEFORE UPDATE OF source_type, source_channel_code, source_invite_code, source_scene, source_referral_code_id
  ON merchant_user
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'source_type', 'source_channel_code', 'source_invite_code', 'source_scene', 'source_referral_code_id');

-- wechat_identity
-- 唯一性 (appid, openid) 由 Prisma 片段生成。改绑按“删旧行、插新行”实现，行上的账号与 openid 不可改。
CREATE TRIGGER trg_wechat_identity_immutable
  BEFORE UPDATE OF merchant_user_id, appid, openid
  ON wechat_identity
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('merchant_user_id', 'appid', 'openid');

-- user_session
ALTER TABLE user_session ADD CONSTRAINT ck_user_session_revoke_reason
  CHECK (revoke_reason IS NULL OR revoke_reason IN (
    'logout', 'identity_rebound', 'identity_removed', 'phone_change', 'admin', 'evicted', 'account_deleted'));
ALTER TABLE user_session ADD CONSTRAINT ck_user_session_revoked
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL));
ALTER TABLE user_session ADD CONSTRAINT ck_user_session_token_hash_len
  CHECK (octet_length(token_hash) = 32);
ALTER TABLE user_session ADD CONSTRAINT ck_user_session_identity_live
  CHECK (wechat_identity_id IS NOT NULL OR revoked_at IS NOT NULL);
ALTER TABLE user_session ADD CONSTRAINT ck_user_session_expiry
  CHECK (absolute_expires_at > created_at AND idle_expires_at > created_at);
CREATE INDEX ix_user_session_merchant_user_id_live
  ON user_session (merchant_user_id) WHERE revoked_at IS NULL;

-- portal_session
ALTER TABLE portal_session ADD CONSTRAINT ck_portal_session_grant_scope
  CHECK (grant_scope IN ('store'));
ALTER TABLE portal_session ADD CONSTRAINT ck_portal_session_revoke_reason
  CHECK (revoke_reason IS NULL OR revoke_reason IN (
    'owner_revoked', 'membership_changed', 'account_action', 'portal_logout', 'expired'));
ALTER TABLE portal_session ADD CONSTRAINT ck_portal_session_revoked
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL));
ALTER TABLE portal_session ADD CONSTRAINT ck_portal_session_token_hash_len
  CHECK (octet_length(token_hash) = 32);
ALTER TABLE portal_session ADD CONSTRAINT ck_portal_session_expiry
  CHECK (expires_at > created_at);
CREATE INDEX ix_portal_session_approved_by_user_id_live
  ON portal_session (approved_by_user_id) WHERE revoked_at IS NULL;
CREATE INDEX ix_portal_session_entity_id_live
  ON portal_session (entity_id) WHERE revoked_at IS NULL;
CREATE TRIGGER trg_portal_session_immutable
  BEFORE UPDATE OF token_hash, portal_ticket_id, approved_by_user_id, entity_id, store_id, grant_scope
  ON portal_session
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'token_hash', 'portal_ticket_id', 'approved_by_user_id', 'entity_id', 'store_id', 'grant_scope');

-- merchant_user_notice
ALTER TABLE merchant_user_notice ADD CONSTRAINT ck_merchant_user_notice_kind
  CHECK (kind IN ('new_wechat_bound'));

-- sms_verification
ALTER TABLE sms_verification ADD CONSTRAINT ck_sms_verification_purpose
  CHECK (purpose IN ('phone_change', 'contact_phone', 'login'));
ALTER TABLE sms_verification ADD CONSTRAINT ck_sms_verification_user_required
  CHECK (purpose = 'login' OR merchant_user_id IS NOT NULL);
ALTER TABLE sms_verification ADD CONSTRAINT ck_sms_verification_phone_bidx_len
  CHECK (octet_length(phone_bidx) = 32);
ALTER TABLE sms_verification ADD CONSTRAINT ck_sms_verification_code_hash_len
  CHECK (octet_length(code_hash) = 32);
ALTER TABLE sms_verification ADD CONSTRAINT ck_sms_verification_attempts
  CHECK (attempts >= 0);
ALTER TABLE sms_verification ADD CONSTRAINT ck_sms_verification_expiry
  CHECK (expires_at > created_at);

-- wecom_contact
ALTER TABLE wecom_contact ADD CONSTRAINT ck_wecom_contact_external_userid_bidx_len
  CHECK (octet_length(external_userid_bidx) = 32);
ALTER TABLE wecom_contact ADD CONSTRAINT ck_wecom_contact_removed_after_added
  CHECK (removed_at IS NULL OR removed_at >= added_at);
CREATE UNIQUE INDEX uq_wecom_contact_staff_external_active
  ON wecom_contact (staff_id, external_userid_bidx) WHERE removed_at IS NULL;
-- 未对上商家用户的有效关系：商家登录取得 unionid、或开放平台打通后补取 unionid 时按它回填
CREATE INDEX ix_wecom_contact_unmatched
  ON wecom_contact (unionid) WHERE merchant_user_id IS NULL AND removed_at IS NULL;

-- account_change_request
ALTER TABLE account_change_request ALTER COLUMN proof_file_ids SET NOT NULL;
ALTER TABLE account_change_request ADD CONSTRAINT ck_account_change_request_kind
  CHECK (kind IN ('phone_rebind', 'owner_transfer', 'owner_reverify'));
ALTER TABLE account_change_request ADD CONSTRAINT ck_account_change_request_target
  CHECK (
    (kind = 'owner_transfer' AND entity_id IS NOT NULL AND merchant_user_id IS NULL)
    OR
    (kind IN ('phone_rebind', 'owner_reverify') AND merchant_user_id IS NOT NULL)
  );
-- 新手机号：复核两列都空；换绑、老板更换必有脱敏串，密文在执行或关闭后置空
ALTER TABLE account_change_request ADD CONSTRAINT ck_account_change_request_new_phone
  CHECK (
    (kind = 'owner_reverify' AND new_phone_enc IS NULL AND new_phone_mask IS NULL)
    OR
    (kind IN ('phone_rebind', 'owner_transfer') AND new_phone_mask IS NOT NULL)
  );
ALTER TABLE account_change_request ADD CONSTRAINT ck_account_change_request_new_phone_cleared
  CHECK (applied_at IS NULL OR new_phone_enc IS NULL);
ALTER TABLE account_change_request ADD CONSTRAINT ck_account_change_request_proof
  CHECK (
    array_position(proof_file_ids, NULL) IS NULL
    AND (kind = 'owner_reverify' OR cardinality(proof_file_ids) >= 1)
  );
ALTER TABLE account_change_request ADD CONSTRAINT ck_account_change_request_verify
  CHECK (
    (kind = 'owner_reverify' AND verify_method IS NOT NULL AND verify_record IS NOT NULL)
    OR
    (kind <> 'owner_reverify' AND verify_method IS NULL AND verify_record IS NULL)
  );
ALTER TABLE account_change_request ADD CONSTRAINT ck_account_change_request_applied
  CHECK ((applied_at IS NULL) = (result_snapshot IS NULL));
ALTER TABLE account_change_request ADD CONSTRAINT ck_account_change_request_result_object
  CHECK (result_snapshot IS NULL OR jsonb_typeof(result_snapshot) = 'object');
CREATE TRIGGER trg_account_change_request_immutable
  BEFORE UPDATE OF approval_request_id, kind, merchant_user_id, entity_id, new_phone_mask,
    proof_file_ids, verify_method, verify_record, reason_code, reason_text
  ON account_change_request
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'approval_request_id', 'kind', 'merchant_user_id', 'entity_id', 'new_phone_mask',
    'proof_file_ids', 'verify_method', 'verify_record', 'reason_code', 'reason_text');
CREATE TRIGGER trg_account_change_request_clear_only
  BEFORE UPDATE OF new_phone_enc
  ON account_change_request
  FOR EACH ROW EXECUTE FUNCTION lyx_02_clear_only('new_phone_enc');

-- entity
ALTER TABLE entity ADD CONSTRAINT ck_entity_lifecycle
  CHECK (lifecycle IN ('active', 'abandoned', 'closed'));
ALTER TABLE entity ADD CONSTRAINT ck_entity_verification_status
  CHECK (verification_status IN ('unsubmitted', 'pending', 'verified', 'rejected'));
ALTER TABLE entity ADD CONSTRAINT ck_entity_entity_type
  CHECK (entity_type IS NULL OR entity_type IN ('enterprise', 'individual'));
ALTER TABLE entity ADD CONSTRAINT ck_entity_source_type
  CHECK (source_type IN ('organic', 'sales', 'campaign', 'partner'));
ALTER TABLE entity ADD CONSTRAINT ck_entity_source_referral
  CHECK ((source_referral_code_id IS NULL) = (source_type = 'organic'));
ALTER TABLE entity ADD CONSTRAINT ck_entity_uscc_bidx_len
  CHECK (uscc_bidx IS NULL OR octet_length(uscc_bidx) = 32);
ALTER TABLE entity ADD CONSTRAINT ck_entity_uscc_triple
  CHECK ((uscc_enc IS NULL) = (uscc_bidx IS NULL) AND (uscc_enc IS NULL) = (uscc_mask IS NULL));
ALTER TABLE entity ADD CONSTRAINT ck_entity_legal_rep_pair
  CHECK ((legal_rep_name_enc IS NULL) = (legal_rep_name_mask IS NULL));
ALTER TABLE entity ADD CONSTRAINT ck_entity_verified_fields
  CHECK (
    verification_status <> 'verified'
    OR (name IS NOT NULL AND entity_type IS NOT NULL AND uscc_enc IS NOT NULL AND verified_at IS NOT NULL)
  );
ALTER TABLE entity ADD CONSTRAINT ck_entity_closed
  CHECK ((lifecycle = 'active') = (closed_at IS NULL));
ALTER TABLE entity ADD CONSTRAINT ck_entity_limit_override
  CHECK ((store_limit_override IS NULL OR store_limit_override >= 1)
     AND (member_limit_override IS NULL OR member_limit_override >= 0));
ALTER TABLE entity ADD CONSTRAINT ck_entity_lock_version
  CHECK (lock_version >= 0);
CREATE UNIQUE INDEX uq_entity_uscc_bidx_verified
  ON entity (uscc_bidx) WHERE verification_status = 'verified' AND lifecycle = 'active';
CREATE TRIGGER trg_entity_immutable
  BEFORE UPDATE OF source_type, source_channel_code, source_invite_code, source_referral_code_id, created_by_user_id
  ON entity
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'source_type', 'source_channel_code', 'source_invite_code', 'source_referral_code_id', 'created_by_user_id');

-- store
ALTER TABLE store ADD CONSTRAINT ck_store_lifecycle
  CHECK (lifecycle IN ('active', 'archived'));
ALTER TABLE store ADD CONSTRAINT ck_store_qualification_status
  CHECK (qualification_status IN ('unsubmitted', 'pending', 'verified', 'rejected'));
ALTER TABLE store ADD CONSTRAINT ck_store_archive_reason
  CHECK (archive_reason IS NULL OR archive_reason IN ('by_owner', 'draft_deleted', 'entity_closed', 'entity_abandoned'));
ALTER TABLE store ADD CONSTRAINT ck_store_archive_actor_type
  CHECK (archive_actor_type IS NULL OR archive_actor_type IN ('merchant', 'staff', 'system', 'partner'));
ALTER TABLE store ADD CONSTRAINT ck_store_archive_client
  CHECK (archive_client IS NULL OR archive_client IN ('weapp', 'portal', 'admin'));
ALTER TABLE store ADD CONSTRAINT ck_store_archived
  CHECK (
    (lifecycle = 'active'
      AND archived_at IS NULL AND archive_reason IS NULL
      AND archive_actor_type IS NULL AND archive_actor_id IS NULL AND archive_client IS NULL)
    OR
    (lifecycle = 'archived'
      AND archived_at IS NOT NULL AND archive_reason IS NOT NULL AND archive_actor_type IS NOT NULL
      AND (archive_actor_type = 'system') = (archive_actor_id IS NULL)
      AND (archive_actor_type <> 'system' OR archive_client IS NULL))
  );
ALTER TABLE store ADD CONSTRAINT ck_store_name_required
  CHECK (qualification_status = 'unsubmitted' OR name IS NOT NULL);
CREATE UNIQUE INDEX uq_store_entity_primary
  ON store (entity_id) WHERE is_primary;
CREATE TRIGGER trg_store_immutable
  BEFORE UPDATE OF entity_id, is_primary
  ON store
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('entity_id', 'is_primary');

-- entity_member
ALTER TABLE entity_member ADD CONSTRAINT ck_entity_member_role
  CHECK (role IN ('owner', 'clerk'));
ALTER TABLE entity_member ADD CONSTRAINT ck_entity_member_status
  CHECK (status IN ('active', 'removed'));
ALTER TABLE entity_member ADD CONSTRAINT ck_entity_member_remove_reason
  CHECK (remove_reason IS NULL OR remove_reason IN (
    'by_owner', 'self', 'dormant', 'owner_transfer', 'account_deleted',
    'draft_abandoned', 'store_archived', 'entity_closed'));
ALTER TABLE entity_member ADD CONSTRAINT ck_entity_member_remove_actor_type
  CHECK (remove_actor_type IS NULL OR remove_actor_type IN ('merchant', 'staff', 'system', 'partner'));
ALTER TABLE entity_member ADD CONSTRAINT ck_entity_member_remove_client
  CHECK (remove_client IS NULL OR remove_client IN ('weapp', 'portal', 'admin'));
ALTER TABLE entity_member ADD CONSTRAINT ck_entity_member_removed
  CHECK (
    (status = 'active'
      AND removed_at IS NULL AND remove_reason IS NULL
      AND remove_actor_type IS NULL AND remove_actor_id IS NULL AND remove_client IS NULL)
    OR
    (status = 'removed'
      AND removed_at IS NOT NULL AND remove_reason IS NOT NULL AND remove_actor_type IS NOT NULL
      AND (remove_actor_type = 'system') = (remove_actor_id IS NULL)
      AND (remove_actor_type <> 'system' OR remove_client IS NULL))
  );
-- 因休眠保护、注销被移除的成员关系不留称呼（d4:456、d4 第 9.7 节）
ALTER TABLE entity_member ADD CONSTRAINT ck_entity_member_name_cleared
  CHECK (remove_reason IS NULL OR remove_reason NOT IN ('dormant', 'account_deleted') OR display_name IS NULL);
CREATE UNIQUE INDEX uq_entity_member_entity_user_active
  ON entity_member (entity_id, merchant_user_id) WHERE status = 'active';
-- 唯一索引不能延迟检查：老板更换须在同一事务里先移除原老板，再升店员或新建老板行（文档 2.11，A143）。
CREATE UNIQUE INDEX uq_entity_member_one_owner
  ON entity_member (entity_id) WHERE status = 'active' AND role = 'owner';
-- V1.0 专用：一个账号只属于一个主体。V1.1 上线“一个账号管理多个主体”时删除。
CREATE UNIQUE INDEX uq_entity_member_one_entity
  ON entity_member (merchant_user_id) WHERE status = 'active';
CREATE TRIGGER trg_entity_member_immutable
  BEFORE UPDATE OF entity_id, merchant_user_id
  ON entity_member
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('entity_id', 'merchant_user_id');

-- store_member
-- 没有手写约束：复合主键与三条复合外键由 Prisma 片段生成。

-- invitation
ALTER TABLE invitation ADD CONSTRAINT ck_invitation_role
  CHECK (role IN ('clerk'));
ALTER TABLE invitation ADD CONSTRAINT ck_invitation_status
  CHECK (status IN ('pending', 'accepted', 'revoked', 'expired'));
ALTER TABLE invitation ADD CONSTRAINT ck_invitation_revoke_reason
  CHECK (revoke_reason IS NULL OR revoke_reason IN (
    'by_owner', 'unshared_leave', 'store_archived', 'entity_closed'));
ALTER TABLE invitation ADD CONSTRAINT ck_invitation_revoke_actor_type
  CHECK (revoke_actor_type IS NULL OR revoke_actor_type IN ('merchant', 'staff', 'system', 'partner'));
ALTER TABLE invitation ADD CONSTRAINT ck_invitation_revoke_client
  CHECK (revoke_client IS NULL OR revoke_client IN ('weapp', 'portal', 'admin'));
ALTER TABLE invitation ADD CONSTRAINT ck_invitation_token_hash_len
  CHECK (octet_length(token_hash) = 32);
ALTER TABLE invitation ADD CONSTRAINT ck_invitation_target_phone_bidx_len
  CHECK (target_phone_bidx IS NULL OR octet_length(target_phone_bidx) = 32);
ALTER TABLE invitation ADD CONSTRAINT ck_invitation_accepted
  CHECK (
    (status = 'accepted'
      AND accepted_at IS NOT NULL AND accepted_by_user_id IS NOT NULL AND accepted_member_id IS NOT NULL)
    OR
    (status <> 'accepted'
      AND accepted_at IS NULL AND accepted_by_user_id IS NULL AND accepted_member_id IS NULL)
  );
ALTER TABLE invitation ADD CONSTRAINT ck_invitation_revoked
  CHECK (
    (status = 'revoked'
      AND revoked_at IS NOT NULL AND revoke_reason IS NOT NULL AND revoke_actor_type IS NOT NULL
      AND (revoke_actor_type = 'system') = (revoke_actor_id IS NULL)
      AND (revoke_actor_type <> 'system' OR revoke_client IS NULL))
    OR
    (status <> 'revoked'
      AND revoked_at IS NULL AND revoke_reason IS NULL
      AND revoke_actor_type IS NULL AND revoke_actor_id IS NULL AND revoke_client IS NULL)
  );
ALTER TABLE invitation ADD CONSTRAINT ck_invitation_token_enc_pending
  CHECK (status = 'pending' OR token_enc IS NULL);
ALTER TABLE invitation ADD CONSTRAINT ck_invitation_expiry
  CHECK (expires_at > created_at);
CREATE INDEX ix_invitation_entity_id_pending
  ON invitation (entity_id) WHERE status = 'pending';
CREATE TRIGGER trg_invitation_immutable
  BEFORE UPDATE OF entity_id, store_id, role, inviter_member_id, token_hash, client_request_id
  ON invitation
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'entity_id', 'store_id', 'role', 'inviter_member_id', 'token_hash', 'client_request_id');

-- referral_code
ALTER TABLE referral_code ADD CONSTRAINT ck_referral_code_source_type
  CHECK (source_type IN ('sales', 'campaign', 'partner'));
ALTER TABLE referral_code ADD CONSTRAINT ck_referral_code_status
  CHECK (status IN ('active', 'disabled'));
ALTER TABLE referral_code ADD CONSTRAINT ck_referral_code_disabled
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL));
ALTER TABLE referral_code ADD CONSTRAINT ck_referral_code_owner
  CHECK (source_type <> 'sales' OR owner_staff_id IS NOT NULL);
ALTER TABLE referral_code ADD CONSTRAINT ck_referral_code_code_format
  CHECK (code ~ '^[0-9A-Z]{4,16}$');
ALTER TABLE referral_code ADD CONSTRAINT ck_referral_code_lock_version
  CHECK (lock_version >= 0);
CREATE TRIGGER trg_referral_code_immutable
  BEFORE UPDATE OF code, source_type, owner_staff_id
  ON referral_code
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('code', 'source_type', 'owner_staff_id');

-- portal_ticket
ALTER TABLE portal_ticket ADD CONSTRAINT ck_portal_ticket_status
  CHECK (status IN ('pending', 'approved', 'rejected', 'consumed'));
ALTER TABLE portal_ticket ADD CONSTRAINT ck_portal_ticket_public_id
  CHECK (public_id ~ '^[0-9A-Za-z_-]{22}$');
ALTER TABLE portal_ticket ADD CONSTRAINT ck_portal_ticket_short_code
  CHECK (short_code ~ '^[0-9A-HJKMNP-TV-Z]{8}$');
ALTER TABLE portal_ticket ADD CONSTRAINT ck_portal_ticket_pair_digits
  CHECK (pair_digits ~ '^[0-9]{2}$');
ALTER TABLE portal_ticket ADD CONSTRAINT ck_portal_ticket_poll_secret_hash_len
  CHECK (octet_length(poll_secret_hash) = 32);
ALTER TABLE portal_ticket ADD CONSTRAINT ck_portal_ticket_exchange_attempts
  CHECK (exchange_attempts >= 0);
ALTER TABLE portal_ticket ADD CONSTRAINT ck_portal_ticket_expiry
  CHECK (expires_at > created_at);
ALTER TABLE portal_ticket ADD CONSTRAINT ck_portal_ticket_approval
  CHECK (
    (approved_by_user_id IS NULL AND entity_id IS NULL AND store_id IS NULL AND approved_at IS NULL
      AND status IN ('pending', 'rejected'))
    OR
    (approved_by_user_id IS NOT NULL AND entity_id IS NOT NULL AND store_id IS NOT NULL AND approved_at IS NOT NULL
      AND status IN ('approved', 'consumed', 'rejected'))
  );
ALTER TABLE portal_ticket ADD CONSTRAINT ck_portal_ticket_consumed
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL));
CREATE UNIQUE INDEX uq_portal_ticket_short_code_pending
  ON portal_ticket (short_code) WHERE status = 'pending';
