-- 首版迁移（W0-05）：建全 166 张表与 00–15 的手写约束。本文件由 packages/db/scripts/build-init-migration.mjs 拼出，不手改。
-- 来源：① prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script 的输出；
--       ② docs/data-model/constraints/ 下的 00–15，按文件名顺序原样接在后面。
-- 语义一字未改，只加了注释：本段、每个来源前的分隔行、四类语句前的 “-- lyx:allow <理由>”（D7 第 8.3 节第 5 条）。
-- 核对：pnpm --filter @liyoxi/db migration:build --check（重拼的结果应与本文件逐字节相同）。

-- ===== 来源 ①：schema.prisma 的建表语句 =====
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "idempotency_record" (
    "scope" TEXT NOT NULL,
    "actor_key" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "locked_until" TIMESTAMPTZ(3),
    "result" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_idempotency_record" PRIMARY KEY ("scope","actor_key","key")
);

-- CreateTable
CREATE TABLE "biz_sequence" (
    "prefix" TEXT NOT NULL,
    "biz_date" DATE NOT NULL,
    "next_val" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_biz_sequence" PRIMARY KEY ("prefix","biz_date")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT,
    "aggregate_id" UUID,
    "entity_id" UUID,
    "store_id" UUID,
    "payload" JSONB NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "client" TEXT,
    "actor_role" TEXT,
    "client_platform" TEXT,
    "client_version" TEXT,
    "request_id" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "dedupe_key" TEXT,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_outbox_event" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_delivery" (
    "outbox_event_id" UUID NOT NULL,
    "subscriber" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "dispatch_no" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMPTZ(3),
    "is_enqueued" BOOLEAN NOT NULL DEFAULT false,
    "last_error" TEXT,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_outbox_delivery" PRIMARY KEY ("outbox_event_id","subscriber")
);

-- CreateTable
CREATE TABLE "timer" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "subject_type" TEXT,
    "subject_id" UUID,
    "entity_id" UUID,
    "store_id" UUID,
    "fire_at" TIMESTAMPTZ(3) NOT NULL,
    "retry_at" TIMESTAMPTZ(3),
    "dedupe_key" TEXT NOT NULL,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "dispatch_no" INTEGER NOT NULL DEFAULT 0,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "is_enqueued" BOOLEAN NOT NULL DEFAULT false,
    "lease_until" TIMESTAMPTZ(3),
    "fired_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_timer" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_transition" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "machine" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "state_field" TEXT NOT NULL,
    "entity_id" UUID,
    "store_id" UUID,
    "from_state" TEXT,
    "to_state" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "client" TEXT,
    "on_behalf_of_user_id" UUID,
    "reason_code" TEXT,
    "note" TEXT,
    "payload" JSONB,
    "is_forced" BOOLEAN NOT NULL DEFAULT false,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "biz_date" DATE NOT NULL,
    "elapsed_seconds" INTEGER,
    "elapsed_work_min" INTEGER,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_status_transition" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_calendar_day" (
    "day" DATE NOT NULL,
    "is_workday" BOOLEAN NOT NULL DEFAULT true,
    "kind" TEXT NOT NULL,
    "note" TEXT,
    "calendar_version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_work_calendar_day" PRIMARY KEY ("day")
);

-- CreateTable
CREATE TABLE "merchant_user" (
    "id" UUID NOT NULL,
    "phone_enc" TEXT,
    "phone_bidx" BYTEA,
    "phone_mask" TEXT,
    "phone_last4" TEXT,
    "display_name" TEXT,
    "status" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_channel_code" TEXT,
    "source_invite_code" TEXT,
    "source_scene" INTEGER,
    "source_referral_code_id" UUID,
    "consent_stamp" TEXT,
    "last_active_at" TIMESTAMPTZ(3) NOT NULL,
    "dormant_bypass_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "pk_merchant_user" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wechat_identity" (
    "id" UUID NOT NULL,
    "merchant_user_id" UUID NOT NULL,
    "appid" TEXT NOT NULL,
    "openid" TEXT NOT NULL,
    "unionid" TEXT,
    "silent_login_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(3) NOT NULL,
    "last_active_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_wechat_identity" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_session" (
    "id" UUID NOT NULL,
    "merchant_user_id" UUID NOT NULL,
    "wechat_identity_id" UUID,
    "token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_ip" TEXT NOT NULL,
    "device_info" TEXT,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" TEXT,

    CONSTRAINT "pk_user_session" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_session" (
    "id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "portal_ticket_id" UUID NOT NULL,
    "approved_by_user_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "grant_scope" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "ip" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" TEXT,

    CONSTRAINT "pk_portal_session" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_user_notice" (
    "id" UUID NOT NULL,
    "merchant_user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "acked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_merchant_user_notice" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_verification" (
    "id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "merchant_user_id" UUID,
    "phone_bidx" BYTEA NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_sms_verification" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wecom_contact" (
    "id" UUID NOT NULL,
    "merchant_user_id" UUID,
    "staff_id" UUID NOT NULL,
    "external_userid_enc" TEXT NOT NULL,
    "external_userid_bidx" BYTEA NOT NULL,
    "unionid" TEXT,
    "added_at" TIMESTAMPTZ(3) NOT NULL,
    "removed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_wecom_contact" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_change_request" (
    "id" UUID NOT NULL,
    "approval_request_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "merchant_user_id" UUID,
    "entity_id" UUID,
    "new_phone_enc" TEXT,
    "new_phone_mask" TEXT,
    "proof_file_ids" UUID[],
    "verify_method" TEXT,
    "verify_record" TEXT,
    "reason_code" TEXT NOT NULL,
    "reason_text" TEXT NOT NULL,
    "applied_at" TIMESTAMPTZ(3),
    "result_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_account_change_request" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity" (
    "id" UUID NOT NULL,
    "lifecycle" TEXT NOT NULL,
    "verification_status" TEXT NOT NULL,
    "name" TEXT,
    "entity_type" TEXT,
    "uscc_enc" TEXT,
    "uscc_bidx" BYTEA,
    "uscc_mask" TEXT,
    "legal_rep_name_enc" TEXT,
    "legal_rep_name_mask" TEXT,
    "verified_at" TIMESTAMPTZ(3),
    "store_limit_override" INTEGER,
    "member_limit_override" INTEGER,
    "source_type" TEXT NOT NULL,
    "source_channel_code" TEXT,
    "source_invite_code" TEXT,
    "source_referral_code_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "pk_entity" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "name" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "lifecycle" TEXT NOT NULL,
    "qualification_status" TEXT NOT NULL DEFAULT 'unsubmitted',
    "delivery_manager_id" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "archive_actor_type" TEXT,
    "archive_actor_id" UUID,
    "archive_client" TEXT,
    "archive_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_store" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_member" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "merchant_user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "display_name" TEXT,
    "last_store_id" UUID,
    "invitation_id" UUID,
    "invited_by_member_id" UUID,
    "removed_at" TIMESTAMPTZ(3),
    "remove_actor_type" TEXT,
    "remove_actor_id" UUID,
    "remove_client" TEXT,
    "remove_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_entity_member" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_member" (
    "entity_member_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "added_by_member_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_store_member" PRIMARY KEY ("entity_member_id","store_id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "inviter_member_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "token_enc" TEXT,
    "remark_name" TEXT,
    "target_phone_bidx" BYTEA,
    "status" TEXT NOT NULL,
    "shared_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_by_user_id" UUID,
    "accepted_member_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_actor_type" TEXT,
    "revoke_actor_id" UUID,
    "revoke_client" TEXT,
    "revoke_reason" TEXT,
    "client_request_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_invitation" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_code" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "owner_staff_id" UUID,
    "label" TEXT,
    "status" TEXT NOT NULL,
    "disabled_at" TIMESTAMPTZ(3),
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_referral_code" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_ticket" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "short_code" TEXT NOT NULL,
    "poll_secret_hash" BYTEA NOT NULL,
    "pair_digits" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "ip" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL,
    "approved_by_user_id" UUID,
    "entity_id" UUID,
    "store_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "consumed_at" TIMESTAMPTZ(3),
    "exchange_attempts" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "pk_portal_ticket" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_role" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "module_levels" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "data_scope" TEXT NOT NULL,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "available_from" TEXT NOT NULL,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "updated_by_staff_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_staff_role" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "staff_group" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "staff_role_key" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_staff_group" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" UUID NOT NULL,
    "staff_no" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "phone_bidx" BYTEA NOT NULL,
    "phone_mask" TEXT NOT NULL,
    "phone_last4" TEXT NOT NULL,
    "staff_role_key" TEXT NOT NULL,
    "is_lead" BOOLEAN NOT NULL DEFAULT false,
    "staff_group_id" UUID,
    "status" TEXT NOT NULL,
    "password_hash" TEXT,
    "password_changed_at" TIMESTAMPTZ(3),
    "totp_secret_enc" TEXT,
    "totp_enrolled_at" TIMESTAMPTZ(3),
    "totp_pending_secret_enc" TEXT,
    "totp_pending_at" TIMESTAMPTZ(3),
    "totp_last_step" INTEGER,
    "recovery_codes" JSONB NOT NULL DEFAULT '[]',
    "wecom_userid" TEXT,
    "wecom_bind_status" TEXT NOT NULL DEFAULT 'none',
    "wecom_bound_at" TIMESTAMPTZ(3),
    "wecom_qr_file_id" UUID,
    "display_name" TEXT,
    "service_phone" TEXT,
    "fail_untrusted" INTEGER NOT NULL DEFAULT 0,
    "locked_until_untrusted" TIMESTAMPTZ(3),
    "fail_trusted" INTEGER NOT NULL DEFAULT 0,
    "locked_until_trusted" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "last_login_ip" TEXT,
    "disabled_at" TIMESTAMPTZ(3),
    "disabled_reason" TEXT,
    "disabled_by_staff_id" UUID,
    "handover_to_staff_id" UUID,
    "created_by_staff_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "lock_version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_staff" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_activation" (
    "id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "delivery" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_by_staff_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_staff_activation" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_session" (
    "id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "auth_method" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "stepup_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_staff_session" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_pool_member" (
    "pool" TEXT NOT NULL,
    "staff_id" UUID NOT NULL,
    "city_code" TEXT NOT NULL DEFAULT '',
    "on_duty" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_assignment_pool_member" PRIMARY KEY ("pool","staff_id","city_code")
);

-- CreateTable
CREATE TABLE "assignment_cursor" (
    "pool" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "last_staff_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_assignment_cursor" PRIMARY KEY ("pool","scope_key")
);

-- CreateTable
CREATE TABLE "assignment_history" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "batch_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "from_staff_id" UUID NOT NULL,
    "to_staff_id" UUID NOT NULL,
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "client" TEXT,
    "contact_due_at" TIMESTAMPTZ(3),
    "sla_snapshot" JSONB,
    "contacted_at" TIMESTAMPTZ(3),
    "contacted_by_staff_id" UUID,
    "contact_voided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_assignment_history" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow_up" (
    "id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID,
    "channel" TEXT,
    "content" TEXT NOT NULL,
    "intent" TEXT,
    "next_follow_at" TIMESTAMPTZ(3),
    "owner_staff_id" UUID,
    "done_at" TIMESTAMPTZ(3),
    "done_note" TEXT,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "client" TEXT,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_follow_up" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "log_no" TEXT NOT NULL DEFAULT '',
    "stream" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "client" TEXT,
    "actor_name" TEXT NOT NULL,
    "actor_role" TEXT NOT NULL,
    "on_behalf_of_entity_id" UUID,
    "target_type" TEXT,
    "target_id" UUID,
    "target_key" TEXT,
    "target_label" TEXT,
    "entity_id" UUID,
    "store_id" UUID,
    "reason_code" TEXT,
    "reason_text" TEXT,
    "before" JSONB,
    "after" JSONB,
    "meta" JSONB,
    "request_id" TEXT,
    "session_id" UUID,
    "auth_method" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "job_name" TEXT,
    "timer_id" UUID,

    CONSTRAINT "pk_audit_log" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_event" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "space" TEXT NOT NULL,
    "subject_id" UUID,
    "event" TEXT NOT NULL,
    "method" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "detail" JSONB,

    CONSTRAINT "pk_auth_event" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_request" (
    "id" UUID NOT NULL,
    "request_no" TEXT,
    "kind" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "entity_id" UUID,
    "store_id" UUID,
    "delivery_ticket_id" UUID,
    "round_no" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "summary_snapshot" JSONB NOT NULL,
    "checklist_code" TEXT,
    "checklist_version_no" INTEGER,
    "checklist_result" JSONB,
    "reason_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "decision_note" TEXT,
    "submit_actor_type" TEXT NOT NULL,
    "submit_actor_id" UUID,
    "submit_client" TEXT,
    "requester_staff_id" UUID,
    "requester_staff_group_id" UUID,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "due_at" TIMESTAMPTZ(3),
    "sla_snapshot" JSONB,
    "decided_by_staff_id" UUID,
    "is_decided_by_system" BOOLEAN NOT NULL DEFAULT false,
    "decided_at" TIMESTAMPTZ(3),
    "confirm_checks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dedupe_key" TEXT,
    "idempotency_key" TEXT,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_approval_request" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_profile" (
    "store_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "brand_name" TEXT,
    "logo_file_id" UUID,
    "industry_code" TEXT,
    "category_code" TEXT,
    "province_code" TEXT,
    "city_code" TEXT,
    "district_code" TEXT,
    "zone_code" TEXT,
    "address_detail" TEXT,
    "poi_name" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "business_hours" JSONB NOT NULL DEFAULT '[]',
    "store_tel" TEXT,
    "avg_spend_fen" INTEGER,
    "brand_intro" TEXT,
    "promo_text" TEXT,
    "group_buy_text" TEXT,
    "selling_point_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "selling_note" TEXT,
    "ad_style_code" TEXT,
    "banned_terms" TEXT,
    "contact_name" TEXT,
    "contact_phone_enc" TEXT,
    "contact_phone_mask" TEXT,
    "contact_phone_source" TEXT,
    "contact_phone_verified_at" TIMESTAMPTZ(3),
    "completeness_pct" SMALLINT NOT NULL DEFAULT 0,
    "required_filled" SMALLINT NOT NULL DEFAULT 0,
    "required_total" SMALLINT NOT NULL DEFAULT 0,
    "copied_from_store_id" UUID,
    "copy_options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "effective_qualification_submission_id" UUID,
    "first_submitted_at" TIMESTAMPTZ(3),
    "first_verified_at" TIMESTAMPTZ(3),
    "last_decided_at" TIMESTAMPTZ(3),
    "final_rejected_at" TIMESTAMPTZ(3),
    "last_edited_at" TIMESTAMPTZ(3),
    "last_edit_actor_type" TEXT,
    "last_edit_actor_id" UUID,
    "last_edit_client" TEXT,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_store_profile" PRIMARY KEY ("store_id")
);

-- CreateTable
CREATE TABLE "store_profile_media" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "media_group" TEXT NOT NULL,
    "position" SMALLINT NOT NULL,
    "file_id" UUID NOT NULL,
    "media_kind" TEXT NOT NULL,
    "caption" TEXT,
    "copied_from_store_id" UUID,
    "create_actor_type" TEXT NOT NULL,
    "create_actor_id" UUID,
    "create_client" TEXT,
    "removed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_store_profile_media" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_service_item" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "name" TEXT NOT NULL,
    "price_fen" INTEGER NOT NULL,
    "original_price_fen" INTEGER,
    "image_file_id" UUID,
    "intro" TEXT,
    "removed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_store_service_item" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qualification_submission" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "resubmit_of_qualification_submission_id" UUID,
    "round_no" INTEGER,
    "claimed_entity_type" TEXT,
    "proposed_store_name" TEXT,
    "proposed_industry_code" TEXT,
    "proposed_category_code" TEXT,
    "proposed_address_snapshot" JSONB,
    "changed_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contact_snapshot" JSONB,
    "declaration_confirmed_at" TIMESTAMPTZ(3),
    "declaration_version" TEXT,
    "check_summary" JSONB,
    "checks_ran_at" TIMESTAMPTZ(3),
    "approval_request_id" UUID,
    "submitted_at" TIMESTAMPTZ(3),
    "submitted_by_user_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "outcome" TEXT,
    "approve_mode" TEXT,
    "system_reject_code" TEXT,
    "final_rejected_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID NOT NULL,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_qualification_submission" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qualification_doc" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "qualification_submission_id" UUID NOT NULL,
    "doc_type" TEXT NOT NULL,
    "permit_type" TEXT,
    "scope" TEXT NOT NULL,
    "file_id" UUID NOT NULL,
    "ocr_result_id" UUID,
    "origin" TEXT NOT NULL,
    "carried_from_qualification_doc_id" UUID,
    "submitted_fields_enc" TEXT,
    "reviewed_fields_enc" TEXT,
    "field_checks" JSONB NOT NULL DEFAULT '[]',
    "holder_name" TEXT,
    "cert_no_enc" TEXT,
    "cert_no_bidx" BYTEA,
    "cert_no_mask" TEXT,
    "principal_name_enc" TEXT,
    "principal_name_mask" TEXT,
    "principal_role" TEXT,
    "subject_type" TEXT,
    "valid_start_date" DATE,
    "valid_end_date" DATE,
    "is_long_term" BOOLEAN NOT NULL DEFAULT false,
    "verdict" TEXT,
    "effective_at" TIMESTAMPTZ(3),
    "superseded_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "uploaded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_qualification_doc" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drama" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL,
    "first_listed_at" TIMESTAMPTZ(3),
    "listed_at" TIMESTAMPTZ(3),
    "delisted_at" TIMESTAMPTZ(3),
    "delist_reason_code" TEXT,
    "delist_note" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "poster_file_id" UUID,
    "total_episodes" INTEGER,
    "episode_duration_sec" INTEGER,
    "genre_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "selling_tag_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "producer_name" TEXT,
    "cast_names" TEXT,
    "synopsis" TEXT,
    "roles" JSONB NOT NULL DEFAULT '[]',
    "drama_class" TEXT,
    "heat_tier" TEXT,
    "industry_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "target_audience" TEXT,
    "allowed_placements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "trial_episode_count" INTEGER,
    "manual_boost" SMALLINT NOT NULL DEFAULT 0,
    "is_ai_generated" BOOLEAN NOT NULL DEFAULT false,
    "body_edit_policy" TEXT NOT NULL DEFAULT 'undecided',
    "is_permit_recheck_required" BOOLEAN NOT NULL DEFAULT false,
    "created_by_staff_id" UUID NOT NULL,
    "updated_by_staff_id" UUID NOT NULL,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_drama" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drama_episode" (
    "id" UUID NOT NULL,
    "drama_id" UUID NOT NULL,
    "episode_no" INTEGER NOT NULL,
    "title" TEXT,
    "duration_ms" INTEGER,
    "insert_points" JSONB,
    "custom_slots" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_drama_episode" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drama_permit" (
    "id" UUID NOT NULL,
    "drama_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "permit_kind" TEXT NOT NULL,
    "permit_no" TEXT NOT NULL,
    "scan_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "status" TEXT NOT NULL,
    "retired_at" TIMESTAMPTZ(3),
    "retire_reason" TEXT,
    "note" TEXT,
    "created_by_staff_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_drama_permit" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drama_copyright" (
    "drama_id" UUID NOT NULL,
    "source" TEXT,
    "platforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "territory" TEXT,
    "has_network_right" BOOLEAN NOT NULL DEFAULT false,
    "can_sublicense" BOOLEAN NOT NULL DEFAULT false,
    "can_edit_embed" BOOLEAN NOT NULL DEFAULT false,
    "can_adapt" BOOLEAN NOT NULL DEFAULT false,
    "license_start_date" DATE,
    "license_end_date" DATE,
    "proof_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "current_drama_copyright_revision_id" UUID,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_drama_copyright" PRIMARY KEY ("drama_id")
);

-- CreateTable
CREATE TABLE "drama_copyright_revision" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "drama_id" UUID NOT NULL,
    "change_kind" TEXT NOT NULL,
    "copyright_snapshot" JSONB NOT NULL,
    "prev_end_date" DATE,
    "new_end_date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "proof_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_by_staff_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_drama_copyright_revision" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drama_stat" (
    "drama_id" UUID NOT NULL,
    "orders_30d" INTEGER NOT NULL DEFAULT 0,
    "orders_mtd" INTEGER NOT NULL DEFAULT 0,
    "live_items" INTEGER NOT NULL DEFAULT 0,
    "refreshed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_drama_stat" PRIMARY KEY ("drama_id")
);

-- CreateTable
CREATE TABLE "file_object" (
    "id" UUID NOT NULL,
    "bucket" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "incoming_bucket" TEXT,
    "incoming_key" TEXT,
    "category" TEXT NOT NULL,
    "scope_type" TEXT NOT NULL,
    "entity_id" UUID,
    "store_id" UUID,
    "upload_actor_type" TEXT NOT NULL,
    "upload_actor_id" UUID,
    "upload_client" TEXT,
    "on_behalf_store_id" UUID,
    "status" TEXT NOT NULL,
    "reject_reason" TEXT,
    "upload_mode" TEXT,
    "client_token" TEXT,
    "upload_batch_id" UUID,
    "declared_size" BIGINT NOT NULL,
    "declared_mime" TEXT NOT NULL,
    "ext" TEXT NOT NULL,
    "original_name" TEXT,
    "size_bytes" BIGINT,
    "mime" TEXT,
    "etag" TEXT,
    "crc64" TEXT,
    "incoming_etag" TEXT,
    "incoming_crc64" TEXT,
    "sha256" TEXT,
    "moderation_state" TEXT NOT NULL DEFAULT 'none',
    "moderation_detail" JSONB,
    "sts_issued" INTEGER NOT NULL DEFAULT 0,
    "upload_expires_at" TIMESTAMPTZ(3),
    "confirming_until" TIMESTAMPTZ(3),
    "stored_at" TIMESTAMPTZ(3),
    "first_linked_at" TIMESTAMPTZ(3),
    "purge_after" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "erased_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_file_object" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_ref" (
    "id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'main',
    "state" TEXT NOT NULL,
    "keep_until" TIMESTAMPTZ(3),
    "released_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_file_ref" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_purge_run" (
    "id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "candidate_count" INTEGER NOT NULL,
    "candidate_bytes" BIGINT NOT NULL,
    "by_category" JSONB NOT NULL,
    "candidate_ids" UUID[],
    "held_reason" TEXT,
    "decided_by_staff_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "deleted_count" INTEGER,
    "guard_trips" INTEGER,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_file_purge_run" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_info" (
    "file_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "container" TEXT,
    "duration_ms" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "rotation" SMALLINT NOT NULL DEFAULT 0,
    "display_width" INTEGER,
    "display_height" INTEGER,
    "fps_num" INTEGER,
    "fps_den" INTEGER,
    "vcodec" TEXT,
    "vprofile" TEXT,
    "pix_fmt" TEXT,
    "acodec" TEXT,
    "audio_sample_rate" INTEGER,
    "audio_channels" SMALLINT,
    "audio_stream_count" SMALLINT,
    "bitrate_kbps" INTEGER,
    "is_faststart" BOOLEAN NOT NULL DEFAULT false,
    "av_drift_ms" INTEGER,
    "aigc_meta" JSONB,
    "cover_file_id" UUID,
    "probe_version" SMALLINT NOT NULL,
    "raw" JSONB NOT NULL,
    "probed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_media_info" PRIMARY KEY ("file_id")
);

-- CreateTable
CREATE TABLE "media_check" (
    "file_id" UUID NOT NULL,
    "profile" TEXT NOT NULL,
    "rule_version" SMALLINT NOT NULL,
    "gate" TEXT NOT NULL,
    "hard" JSONB NOT NULL,
    "soft" JSONB NOT NULL,
    "context_snapshot" JSONB,
    "checked_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_media_check" PRIMARY KEY ("file_id")
);

-- CreateTable
CREATE TABLE "upload_batch" (
    "id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "variant" TEXT NOT NULL DEFAULT 'common',
    "created_by_staff_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "expected_count" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "replace_reason" TEXT,
    "is_content_changed" BOOLEAN NOT NULL DEFAULT false,
    "ai_usage" JSONB,
    "production_ctx" JSONB,
    "note" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "committed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_upload_batch" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_batch_item" (
    "id" UUID NOT NULL,
    "upload_batch_id" UUID NOT NULL,
    "file_id" UUID NOT NULL,
    "original_name" TEXT NOT NULL,
    "episode_no" INTEGER,
    "match_method" TEXT,
    "state" TEXT NOT NULL,
    "ai_usage" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_upload_batch_item" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_job" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "parent_type" TEXT,
    "parent_id" UUID,
    "dedupe_key" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "attempt_no" SMALLINT NOT NULL DEFAULT 0,
    "max_attempts" SMALLINT NOT NULL DEFAULT 3,
    "lease_owner" TEXT,
    "external_job_id" TEXT,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "is_retryable" BOOLEAN NOT NULL DEFAULT false,
    "next_run_at" TIMESTAMPTZ(3) NOT NULL,
    "deadline_at" TIMESTAMPTZ(3) NOT NULL,
    "billable_qty" DECIMAL(12,3),
    "billable_unit" TEXT,
    "est_cost_micro" BIGINT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_media_job" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_record" (
    "file_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "order_item_id" UUID,
    "ad_id" UUID,
    "episode_no" INTEGER,
    "variant" TEXT NOT NULL DEFAULT 'common',
    "source" TEXT NOT NULL,
    "derived_from_file_id" UUID,
    "render_item_id" UUID,
    "production_tier" TEXT,
    "drama_episode_master_id" UUID,
    "master_source" TEXT,
    "head_ad_version_id" UUID,
    "tail_ad_version_id" UUID,
    "ai_usage" JSONB NOT NULL,
    "aigc_state" TEXT NOT NULL,
    "aigc_origin" TEXT,
    "pipeline_state" TEXT NOT NULL,
    "similarity" JSONB,
    "uploaded_by_staff_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_production_record" PRIMARY KEY ("file_id")
);

-- CreateTable
CREATE TABLE "master_checkout" (
    "order_item_id" UUID NOT NULL,
    "episode_no" INTEGER NOT NULL,
    "staff_id" UUID NOT NULL,
    "drama_episode_master_id" UUID NOT NULL,
    "checked_out_at" TIMESTAMPTZ(3) NOT NULL,
    "checkout_count" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_master_checkout" PRIMARY KEY ("order_item_id","episode_no","staff_id")
);

-- CreateTable
CREATE TABLE "playable_asset" (
    "id" UUID NOT NULL,
    "entity_id" UUID,
    "store_id" UUID,
    "kind" TEXT NOT NULL,
    "source_file_id" UUID NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "duration_ms" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "renditions" JSONB,
    "cover_file_id" UUID,
    "watermark" JSONB,
    "spec_version" SMALLINT NOT NULL,
    "error" TEXT,
    "ready_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_playable_asset" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zip_bundle" (
    "id" UUID NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "zip_state" TEXT NOT NULL DEFAULT 'none',
    "zip_gen" INTEGER NOT NULL DEFAULT 0,
    "zip_file_id" UUID,
    "publish_list_file_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_zip_bundle" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drama_trailer" (
    "drama_id" UUID NOT NULL,
    "target_playable_asset_id" UUID NOT NULL,
    "current_playable_asset_id" UUID,
    "set_by_staff_id" UUID NOT NULL,
    "set_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_drama_trailer" PRIMARY KEY ("drama_id")
);

-- CreateTable
CREATE TABLE "drama_episode_master" (
    "id" UUID NOT NULL,
    "drama_id" UUID NOT NULL,
    "episode_no" INTEGER NOT NULL,
    "rev_no" INTEGER NOT NULL,
    "file_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "duration_ms" INTEGER,
    "upload_batch_id" UUID,
    "replace_reason" TEXT,
    "is_content_changed" BOOLEAN NOT NULL DEFAULT false,
    "created_by_staff_id" UUID NOT NULL,
    "activated_at" TIMESTAMPTZ(3),
    "mezzanine_file_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_drama_episode_master" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_asset" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT,
    "text_body" TEXT,
    "note" TEXT,
    "upload_actor_type" TEXT NOT NULL,
    "upload_actor_id" UUID NOT NULL,
    "upload_client" TEXT NOT NULL,
    "upload_actor_role" TEXT,
    "store_asset_demand_id" UUID,
    "source_store_asset_id" UUID,
    "processing_state" TEXT NOT NULL,
    "is_insight_partial" BOOLEAN NOT NULL DEFAULT false,
    "review_state" TEXT NOT NULL,
    "usability" TEXT,
    "portrait_auth_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "portrait_authorized_at" TIMESTAMPTZ(3),
    "adopted_count" INTEGER NOT NULL DEFAULT 0,
    "moderation_state" TEXT NOT NULL DEFAULT 'none',
    "search_text" TEXT,
    "reviewed_by_staff_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "due_at" TIMESTAMPTZ(3),
    "sla_snapshot" JSONB,
    "deleted_at" TIMESTAMPTZ(3),
    "idempotency_key" TEXT NOT NULL,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_store_asset" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_asset_file" (
    "store_asset_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "file_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_store_asset_file" PRIMARY KEY ("store_asset_id","position")
);

-- CreateTable
CREATE TABLE "store_asset_insight" (
    "id" UUID NOT NULL,
    "store_asset_id" UUID NOT NULL,
    "file_id" UUID,
    "kind" TEXT NOT NULL,
    "prompt_version" SMALLINT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "status" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "reused_from_store_asset_insight_id" UUID,
    "media_job_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_store_asset_insight" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_asset_tag" (
    "id" UUID NOT NULL,
    "store_asset_id" UUID NOT NULL,
    "dimension" TEXT NOT NULL,
    "tag_code" TEXT NOT NULL,
    "valid_start_date" DATE,
    "valid_end_date" DATE,
    "source" TEXT NOT NULL,
    "is_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_store_asset_tag" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_asset_usage" (
    "id" UUID NOT NULL,
    "store_asset_id" UUID NOT NULL,
    "used_by_type" TEXT NOT NULL,
    "used_by_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_store_asset_usage" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_asset_demand" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "shooting_note" TEXT,
    "due_date" DATE NOT NULL,
    "notify_scope" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_by_staff_id" UUID NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_store_asset_demand" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ocr_result" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID,
    "file_id" UUID NOT NULL,
    "doc_type" TEXT NOT NULL,
    "permit_type" TEXT,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "fields_enc" TEXT,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "raw_enc" TEXT,
    "raw_purge_at" TIMESTAMPTZ(3),
    "request_actor_type" TEXT NOT NULL,
    "request_actor_id" UUID,
    "request_client" TEXT,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_ocr_result" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'public',
    "is_listed" BOOLEAN NOT NULL DEFAULT false,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_plan" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_revision" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "monthly_fee_fen" INTEGER NOT NULL,
    "monthly_points" INTEGER NOT NULL,
    "discount_bp" INTEGER NOT NULL,
    "production_model" TEXT NOT NULL,
    "max_stores" INTEGER NOT NULL,
    "max_members" INTEGER,
    "schedule_priority" TEXT NOT NULL,
    "has_monthly_report" BOOLEAN NOT NULL DEFAULT false,
    "cycle_prices" JSONB NOT NULL,
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "announced_at" TIMESTAMPTZ(3),
    "site_notice_id" UUID,
    "legacy_promo" JSONB,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_by_staff_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_plan_revision" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_promo_claim" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "plan_revision_id" UUID NOT NULL,
    "billing_order_id" UUID NOT NULL,
    "used_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_plan_promo_claim" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_pack" (
    "id" UUID NOT NULL,
    "points" INTEGER NOT NULL,
    "price_fen" INTEGER NOT NULL,
    "is_listed" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_point_pack" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_tier_revision" (
    "id" UUID NOT NULL,
    "tier" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "batch_id" UUID NOT NULL,
    "created_by_staff_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_price_tier_revision" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drama_price_revision" (
    "id" UUID NOT NULL,
    "drama_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "custom_points" INTEGER,
    "prev_points" INTEGER,
    "new_points" INTEGER NOT NULL,
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_by_staff_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_drama_price_revision" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_param" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "change_id" UUID NOT NULL,
    "note" TEXT,
    "site_notice_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_by_staff_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_billing_param" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_account" (
    "entity_id" UUID NOT NULL,
    "sub_status" TEXT NOT NULL DEFAULT 'none',
    "current_subscription_term_id" UUID,
    "plan_available_qty" INTEGER NOT NULL DEFAULT 0,
    "addon_available_qty" INTEGER NOT NULL DEFAULT 0,
    "held_total_qty" INTEGER NOT NULL DEFAULT 0,
    "next_due_at" TIMESTAMPTZ(3),
    "last_op_at" TIMESTAMPTZ(3),
    "last_expired_qty" INTEGER,
    "last_expired_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_billing_account" PRIMARY KEY ("entity_id")
);

-- CreateTable
CREATE TABLE "subscription_term" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "term_no" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "plan_id" UUID NOT NULL,
    "plan_revision_id" UUID NOT NULL,
    "initial_plan_revision_id" UUID NOT NULL,
    "months" INTEGER NOT NULL,
    "price_total_fen" INTEGER NOT NULL,
    "monthly_equiv_fen" INTEGER NOT NULL,
    "monthly_points" INTEGER NOT NULL,
    "discount_bp" INTEGER NOT NULL,
    "production_model" TEXT NOT NULL,
    "max_stores" INTEGER NOT NULL,
    "max_members" INTEGER,
    "schedule_priority" TEXT NOT NULL,
    "has_monthly_report" BOOLEAN NOT NULL DEFAULT false,
    "anchor_day" SMALLINT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "extended_days" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "refund_request_id" UUID,
    "refund_rule" TEXT,
    "source_billing_order_id" UUID NOT NULL,
    "activated_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "refunded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_subscription_term" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_event" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "entity_id" UUID NOT NULL,
    "subscription_term_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "from_plan_id" UUID,
    "to_plan_id" UUID,
    "from_plan_revision_id" UUID,
    "to_plan_revision_id" UUID,
    "billing_order_id" UUID,
    "payload" JSONB,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "biz_date" DATE NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "client" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_subscription_event" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grant_schedule" (
    "id" UUID NOT NULL,
    "subscription_term_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "month_no" SMALLINT NOT NULL,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "due_date" DATE NOT NULL,
    "points" INTEGER NOT NULL,
    "value_fen" INTEGER NOT NULL,
    "plan_id" UUID NOT NULL,
    "plan_revision_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "point_lot_id" UUID,
    "granted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_grant_schedule" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_lot" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "source_no" SMALLINT NOT NULL DEFAULT 0,
    "subscription_term_id" UUID,
    "plan_id" UUID,
    "plan_revision_id" UUID,
    "origin_point_lot_id" UUID,
    "origin_point_ledger_entry_id" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL,
    "biz_date" DATE NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "original_qty" INTEGER NOT NULL,
    "available_qty" INTEGER NOT NULL,
    "held_qty" INTEGER NOT NULL DEFAULT 0,
    "consumed_qty" INTEGER NOT NULL DEFAULT 0,
    "expired_qty" INTEGER NOT NULL DEFAULT 0,
    "revoked_qty" INTEGER NOT NULL DEFAULT 0,
    "converted_out_qty" INTEGER NOT NULL DEFAULT 0,
    "adjusted_out_qty" INTEGER NOT NULL DEFAULT 0,
    "cost_basis_fen" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_point_lot" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_hold" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" UUID NOT NULL,
    "group_ref" TEXT,
    "qty" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "returned_qty" INTEGER NOT NULL DEFAULT 0,
    "forfeited_qty" INTEGER NOT NULL DEFAULT 0,
    "pricing_snapshot" JSONB NOT NULL,
    "subscription_term_id" UUID NOT NULL,
    "held_at" TIMESTAMPTZ(3) NOT NULL,
    "captured_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "client" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_point_hold" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_hold_alloc" (
    "point_hold_id" UUID NOT NULL,
    "alloc_no" SMALLINT NOT NULL,
    "point_lot_id" UUID NOT NULL,
    "lot_kind" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "returned_qty" INTEGER NOT NULL DEFAULT 0,
    "forfeited_qty" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_point_hold_alloc" PRIMARY KEY ("point_hold_id","alloc_no")
);

-- CreateTable
CREATE TABLE "ledger_operation" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "op_key" TEXT NOT NULL,
    "op_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID,
    "ref_type" TEXT,
    "ref_id" UUID,
    "point_hold_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "biz_date" DATE NOT NULL,
    "plan_delta_qty" INTEGER NOT NULL DEFAULT 0,
    "addon_delta_qty" INTEGER NOT NULL DEFAULT 0,
    "spendable_after_qty" INTEGER NOT NULL,
    "held_after_qty" INTEGER NOT NULL,
    "title_code" TEXT,
    "title_args" JSONB,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "client" TEXT,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_ledger_operation" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "point_ledger_entry" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "ledger_operation_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "point_lot_id" UUID NOT NULL,
    "point_hold_id" UUID,
    "lot_kind" TEXT NOT NULL,
    "plan_id" UUID,
    "from_bucket" TEXT NOT NULL,
    "to_bucket" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "biz_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_point_ledger_entry" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_entity_daily" (
    "biz_date" DATE NOT NULL,
    "entity_id" UUID NOT NULL,
    "sub_status" TEXT NOT NULL,
    "plan_id" UUID,
    "plan_revision_id" UUID,
    "subscription_term_id" UUID,
    "term_months" INTEGER,
    "mrr_fen" INTEGER NOT NULL DEFAULT 0,
    "plan_available_points" INTEGER NOT NULL DEFAULT 0,
    "addon_available_points" INTEGER NOT NULL DEFAULT 0,
    "held_points" INTEGER NOT NULL DEFAULT 0,
    "liability_points" INTEGER NOT NULL DEFAULT 0,
    "liability_value_fen" INTEGER NOT NULL DEFAULT 0,
    "deferred_plan_fee_fen" INTEGER NOT NULL DEFAULT 0,
    "recomputed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_billing_entity_daily" PRIMARY KEY ("biz_date","entity_id")
);

-- CreateTable
CREATE TABLE "valuation_policy" (
    "version_no" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "rule" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_valuation_policy" PRIMARY KEY ("version_no")
);

-- CreateTable
CREATE TABLE "point_entry_valuation" (
    "point_ledger_entry_id" UUID NOT NULL,
    "valuation_policy_version_no" INTEGER NOT NULL,
    "point_ledger_entry_seq" BIGINT NOT NULL,
    "point_lot_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "biz_date" DATE NOT NULL,
    "effect" TEXT NOT NULL,
    "value_fen" INTEGER NOT NULL,
    "remaining_value_fen" INTEGER NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_point_entry_valuation" PRIMARY KEY ("point_ledger_entry_id","valuation_policy_version_no")
);

-- CreateTable
CREATE TABLE "point_adjustment_request" (
    "id" UUID NOT NULL,
    "approval_request_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "lot_kind" TEXT NOT NULL,
    "adjust_points" INTEGER NOT NULL,
    "reason_code" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "point_hold_id" UUID,
    "term_extension_request_id" UUID,
    "spendable_before_points" INTEGER NOT NULL,
    "ledger_operation_id" UUID,
    "applied_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_point_adjustment_request" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "term_extension_request" (
    "id" UUID NOT NULL,
    "approval_request_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "subscription_term_id" UUID NOT NULL,
    "days" INTEGER NOT NULL,
    "reason_code" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "applied_subscription_term_id" UUID,
    "applied_mode" TEXT,
    "prev_end_date" DATE,
    "new_end_date" DATE,
    "ledger_operation_id" UUID,
    "applied_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_term_extension_request" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_order" (
    "id" UUID NOT NULL,
    "order_no" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "content_snapshot" JSONB NOT NULL,
    "formula_code" TEXT,
    "formula_args" JSONB,
    "quote_hash" TEXT NOT NULL,
    "amount_fen" INTEGER NOT NULL,
    "paid_amount_fen" INTEGER NOT NULL DEFAULT 0,
    "refunded_amount_fen" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "transfer_state" TEXT,
    "bank_account_finance_config_revision_id" UUID,
    "paid_at" TIMESTAMPTZ(3),
    "paid_payment_txn_id" UUID,
    "applied_at" TIMESTAMPTZ(3),
    "fulfillment_status" TEXT NOT NULL DEFAULT 'none',
    "fulfilled_at" TIMESTAMPTZ(3),
    "fulfillment_note" TEXT,
    "fulfillment_result" JSONB,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "refunded_at" TIMESTAMPTZ(3),
    "has_open_exception" BOOLEAN NOT NULL DEFAULT false,
    "client_platform" TEXT,
    "client_version" TEXT,
    "contract_no" TEXT,
    "placed_by_user_id" UUID,
    "created_by_staff_id" UUID,
    "proxy_actor_type" TEXT,
    "proxy_actor_id" UUID,
    "proxy_client" TEXT,
    "rebuilt_from" TEXT,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_billing_order" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_txn" (
    "id" UUID NOT NULL,
    "entity_id" UUID,
    "billing_order_id" UUID,
    "channel" TEXT NOT NULL,
    "attempt_no" SMALLINT NOT NULL,
    "out_trade_no" TEXT NOT NULL,
    "amount_fen" INTEGER NOT NULL,
    "channel_amount_fen" INTEGER,
    "payer_openid" TEXT,
    "channel_payer_ref" TEXT,
    "attach" TEXT,
    "channel_attach" TEXT,
    "status" TEXT NOT NULL,
    "applied_at" TIMESTAMPTZ(3),
    "refunded_fen" INTEGER NOT NULL DEFAULT 0,
    "prepay_id" TEXT,
    "prepay_expires_at" TIMESTAMPTZ(3),
    "channel_txn_no" TEXT,
    "bank_serial_raw" TEXT,
    "payer_bank" TEXT,
    "channel_success_at" TIMESTAMPTZ(3),
    "trade_state_raw" TEXT,
    "bank_type" TEXT,
    "fee_fen" INTEGER,
    "transfer_proof_id" UUID,
    "confirmed_by_staff_id" UUID,
    "reviewed_by_staff_id" UUID,
    "recon_state" TEXT NOT NULL DEFAULT 'pending',
    "recon_bill_date" DATE,
    "last_queried_at" TIMESTAMPTZ(3),
    "query_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_payment_txn" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_proof" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "billing_order_id" UUID NOT NULL,
    "upload_no" INTEGER NOT NULL,
    "file_id" UUID NOT NULL,
    "uploaded_by_user_id" UUID,
    "uploaded_by_staff_id" UUID,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL,
    "ocr_result_id" UUID,
    "check_result" JSONB,
    "review_status" TEXT NOT NULL,
    "first_confirm" JSONB,
    "review_approval_request_id" UUID,
    "reviewed_by_staff_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "reject_reason_code" TEXT,
    "reject_note" TEXT,
    "due_at" TIMESTAMPTZ(3),
    "sla_snapshot" JSONB,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_transfer_proof" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_request" (
    "id" UUID NOT NULL,
    "approval_request_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "entity_id" UUID,
    "billing_order_id" UUID,
    "payment_txn_id" UUID NOT NULL,
    "base_amount_fen" INTEGER NOT NULL,
    "deduct_amount_fen" INTEGER NOT NULL DEFAULT 0,
    "amount_fen" INTEGER NOT NULL,
    "breakdown_snapshot" JSONB NOT NULL,
    "rule_code" TEXT NOT NULL,
    "rule_text" TEXT NOT NULL,
    "recheck_log" JSONB,
    "is_override" BOOLEAN NOT NULL DEFAULT false,
    "reason_code" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL,
    "exec_route" TEXT,
    "exec_due_at" TIMESTAMPTZ(3),
    "sla_snapshot" JSONB,
    "entitlement_revoked_at" TIMESTAMPTZ(3),
    "executed_by_staff_id" UUID,
    "executed_at" TIMESTAMPTZ(3),
    "done_at" TIMESTAMPTZ(3),
    "voided_by_staff_id" UUID,
    "exec_error" JSONB,
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "close_note" TEXT,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_refund_request" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_txn" (
    "id" UUID NOT NULL,
    "entity_id" UUID,
    "refund_request_id" UUID,
    "billing_order_id" UUID,
    "payment_txn_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "out_refund_no" TEXT NOT NULL,
    "amount_fen" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "channel_refund_no" TEXT,
    "submit_count" INTEGER NOT NULL DEFAULT 0,
    "last_submit_at" TIMESTAMPTZ(3),
    "is_retry_halted" BOOLEAN NOT NULL DEFAULT false,
    "success_at" TIMESTAMPTZ(3),
    "user_received_account" TEXT,
    "fail_code" TEXT,
    "fail_message" TEXT,
    "is_late_success" BOOLEAN NOT NULL DEFAULT false,
    "transfer_date" DATE,
    "payee_name" TEXT,
    "payee_bank" TEXT,
    "payee_account_enc" TEXT,
    "payee_account_mask" TEXT,
    "receipt_file_id" UUID,
    "registered_by_staff_id" UUID,
    "note" TEXT,
    "fee_refund_fen" INTEGER,
    "recon_state" TEXT NOT NULL DEFAULT 'pending',
    "recon_bill_date" DATE,
    "last_queried_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_refund_txn" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_exception" (
    "id" UUID NOT NULL,
    "exception_no" TEXT NOT NULL,
    "entity_id" UUID,
    "kind" TEXT NOT NULL,
    "detected_by" TEXT NOT NULL,
    "bill_date" DATE NOT NULL,
    "billing_order_id" UUID,
    "payment_txn_id" UUID,
    "refund_txn_id" UUID,
    "wx_bill_line_id" UUID,
    "amount_fen" INTEGER NOT NULL,
    "bill_fact" JSONB,
    "platform_fact" JSONB,
    "cause_text" TEXT,
    "status" TEXT NOT NULL,
    "resolution" TEXT NOT NULL DEFAULT 'none',
    "resolution_note" TEXT,
    "resolved_by_staff_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "refund_request_id" UUID,
    "dedupe_key" TEXT NOT NULL,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_payment_exception" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wx_bill_file" (
    "id" UUID NOT NULL,
    "mchid" TEXT NOT NULL,
    "bill_date" DATE NOT NULL,
    "bill_type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "file_id" UUID,
    "sha1" TEXT,
    "is_hash_verified" BOOLEAN NOT NULL DEFAULT false,
    "line_count" INTEGER,
    "summary" JSONB,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "downloaded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_wx_bill_file" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wx_bill_line" (
    "id" UUID NOT NULL,
    "wx_bill_file_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "bill_date" DATE NOT NULL,
    "line_kind" TEXT NOT NULL,
    "traded_at" TIMESTAMPTZ(3) NOT NULL,
    "appid" TEXT NOT NULL,
    "mchid" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "out_trade_no" TEXT NOT NULL,
    "trade_state" TEXT NOT NULL,
    "order_amount_fen" INTEGER NOT NULL,
    "settle_amount_fen" INTEGER NOT NULL,
    "refund_id" TEXT,
    "out_refund_no" TEXT,
    "refund_amount_fen" INTEGER,
    "refund_state" TEXT,
    "attach" TEXT,
    "fee_fen" INTEGER NOT NULL,
    "rate_text" TEXT,
    "is_foreign" BOOLEAN NOT NULL DEFAULT false,
    "match_state" TEXT NOT NULL,
    "matched_payment_txn_id" UUID,
    "matched_refund_txn_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_wx_bill_line" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recon_day" (
    "id" UUID NOT NULL,
    "bill_date" DATE NOT NULL,
    "channel" TEXT NOT NULL,
    "platform_pay_count" INTEGER NOT NULL DEFAULT 0,
    "platform_pay_fen" BIGINT NOT NULL DEFAULT 0,
    "bill_pay_count" INTEGER NOT NULL DEFAULT 0,
    "bill_pay_fen" BIGINT NOT NULL DEFAULT 0,
    "platform_refund_count" INTEGER NOT NULL DEFAULT 0,
    "platform_refund_fen" BIGINT NOT NULL DEFAULT 0,
    "bill_refund_count" INTEGER NOT NULL DEFAULT 0,
    "bill_refund_fen" BIGINT NOT NULL DEFAULT 0,
    "bank_count" INTEGER NOT NULL DEFAULT 0,
    "bank_fen" BIGINT NOT NULL DEFAULT 0,
    "fee_fen" BIGINT NOT NULL DEFAULT 0,
    "diff_count" INTEGER NOT NULL DEFAULT 0,
    "diff_fen" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_recon_day" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_request" (
    "id" UUID NOT NULL,
    "request_no" TEXT NOT NULL,
    "billing_order_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "amount_fen" INTEGER NOT NULL,
    "invoice_type" TEXT NOT NULL,
    "medium" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "tax_no_enc" TEXT NOT NULL,
    "tax_no_mask" TEXT NOT NULL,
    "addr_tel_enc" TEXT,
    "addr_tel_mask" TEXT,
    "bank_account_enc" TEXT,
    "bank_account_mask" TEXT,
    "recv_email_enc" TEXT,
    "recv_email_mask" TEXT,
    "mail_to_enc" TEXT,
    "mail_to_mask" TEXT,
    "item_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "held_by_refund_request_id" UUID,
    "reject_kind" TEXT,
    "reject_reason_code" TEXT,
    "reject_note" TEXT,
    "rejected_by_staff_id" UUID,
    "rejected_at" TIMESTAMPTZ(3),
    "applied_by_user_id" UUID NOT NULL,
    "applied_at" TIMESTAMPTZ(3) NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "due_at" TIMESTAMPTZ(3),
    "sla_snapshot" JSONB,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_invoice_request" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_doc" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "invoice_request_id" UUID NOT NULL,
    "doc_kind" TEXT NOT NULL,
    "invoice_no" TEXT NOT NULL,
    "invoice_code" TEXT,
    "amount_fen" INTEGER NOT NULL,
    "file_id" UUID,
    "file_format" TEXT,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "issued_by_staff_id" UUID NOT NULL,
    "express_company" TEXT,
    "tracking_no" TEXT,
    "shipped_at" TIMESTAMPTZ(3),
    "email_state" TEXT NOT NULL DEFAULT 'none',
    "email_sent_at" TIMESTAMPTZ(3),
    "original_invoice_doc_id" UUID,
    "red_reason" TEXT,
    "provider_ref" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_invoice_doc" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_config_revision" (
    "id" UUID NOT NULL,
    "config_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "account_no_enc" TEXT,
    "account_no_mask" TEXT,
    "change_note" TEXT NOT NULL,
    "approval_request_id" UUID NOT NULL,
    "effective_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_finance_config_revision" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_item" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "drama_id" UUID NOT NULL,
    "added_by_user_id" UUID NOT NULL,
    "list_price_points" INTEGER NOT NULL,
    "price_acked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_cart_item" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drama_order" (
    "id" UUID NOT NULL,
    "order_no" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "placed_by_user_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "sub_status" TEXT,
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL,
    "item_count" SMALLINT NOT NULL,
    "total_charge_points" INTEGER NOT NULL,
    "subscription_term_id" UUID NOT NULL,
    "plan_code" TEXT NOT NULL,
    "discount_bp" INTEGER NOT NULL,
    "is_top_model" BOOLEAN NOT NULL DEFAULT false,
    "surcharge_bp" INTEGER NOT NULL,
    "focus_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "expected_launch_date" DATE,
    "agreement_consent_id" UUID NOT NULL,
    "delivery_manager_id" UUID,
    "open_cancel_request_id" UUID,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_drama_order" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item" (
    "id" UUID NOT NULL,
    "drama_order_id" UUID NOT NULL,
    "item_no" SMALLINT NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "drama_id" UUID NOT NULL,
    "drama_snapshot" JSONB NOT NULL,
    "episode_count" INTEGER NOT NULL,
    "list_price_points" INTEGER NOT NULL,
    "discount_bp" INTEGER NOT NULL,
    "surcharge_bp" INTEGER NOT NULL,
    "charge_points" INTEGER NOT NULL,
    "pricing_snapshot" JSONB NOT NULL,
    "production_model" TEXT NOT NULL,
    "point_hold_id" UUID NOT NULL,
    "captured_at" TIMESTAMPTZ(3),
    "refund_requested_points" INTEGER NOT NULL DEFAULT 0,
    "returned_points" INTEGER NOT NULL DEFAULT 0,
    "converted_points" INTEGER NOT NULL DEFAULT 0,
    "forfeited_points" INTEGER NOT NULL DEFAULT 0,
    "phase" TEXT NOT NULL,
    "phase_changed_at" TIMESTAMPTZ(3) NOT NULL,
    "agreed_launch_date" DATE,
    "usage_start_date" DATE,
    "usage_end_date" DATE NOT NULL,
    "usage_end_source" TEXT NOT NULL DEFAULT 'license',
    "live_episode_count" INTEGER NOT NULL DEFAULT 0,
    "cancel_reason_code" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_order_item" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_account" (
    "order_item_id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_order_item_account" PRIMARY KEY ("order_item_id","channel_account_id")
);

-- CreateTable
CREATE TABLE "order_item_placement" (
    "id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "slot" TEXT NOT NULL,
    "ad_id" UUID NOT NULL,
    "bound_version_no" SMALLINT,
    "duration_sec" SMALLINT NOT NULL,
    "pinned_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_order_item_placement" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancel_request" (
    "id" UUID NOT NULL,
    "approval_request_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "drama_order_id" UUID,
    "ad_id" UUID,
    "reason_code" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "line_count" SMALLINT NOT NULL,
    "total_base_points" INTEGER NOT NULL,
    "total_deduct_points" INTEGER NOT NULL,
    "total_refund_points" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "exec_due_at" TIMESTAMPTZ(3),
    "sla_snapshot" JSONB,
    "executed_by_staff_id" UUID,
    "is_executed_by_system" BOOLEAN NOT NULL DEFAULT false,
    "executed_at" TIMESTAMPTZ(3),
    "exec_confirm_checks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "recheck_log" JSONB,
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "close_note" TEXT,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_cancel_request" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancel_request_line" (
    "id" UUID NOT NULL,
    "cancel_request_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "point_hold_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "step_at_submit" TEXT,
    "reason_class" TEXT NOT NULL,
    "charge_points" INTEGER NOT NULL,
    "prior_requested_points" INTEGER NOT NULL,
    "ratio_bp" INTEGER,
    "deduct_points" INTEGER NOT NULL,
    "deduct_note" TEXT,
    "refund_points" INTEGER NOT NULL,
    "termination_date" DATE,
    "usage_start_date" DATE,
    "usage_end_date" DATE,
    "usage_end_source" TEXT,
    "preview_snapshot" JSONB NOT NULL,
    "result_snapshot" JSONB,
    "returned_points" INTEGER,
    "converted_points" INTEGER,
    "forfeited_points" INTEGER,
    "executed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_cancel_request_line" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad" (
    "id" UUID NOT NULL,
    "ad_no" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "duration_sec" SMALLINT NOT NULL,
    "promo_point_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "copy" TEXT,
    "remark" TEXT,
    "status" TEXT NOT NULL,
    "returned_from" TEXT,
    "returned_at" TIMESTAMPTZ(3),
    "return_reason" TEXT,
    "resubmit_count" SMALLINT NOT NULL DEFAULT 0,
    "editor_id" UUID,
    "unit_price_points" INTEGER NOT NULL,
    "discount_bp" INTEGER NOT NULL,
    "charge_points" INTEGER NOT NULL,
    "pricing_snapshot" JSONB NOT NULL,
    "point_hold_id" UUID NOT NULL,
    "captured_at" TIMESTAMPTZ(3),
    "refund_requested_points" INTEGER NOT NULL DEFAULT 0,
    "returned_points" INTEGER NOT NULL DEFAULT 0,
    "converted_points" INTEGER NOT NULL DEFAULT 0,
    "forfeited_points" INTEGER NOT NULL DEFAULT 0,
    "free_revision_quota" SMALLINT NOT NULL,
    "revision_count" SMALLINT NOT NULL DEFAULT 0,
    "latest_version_no" SMALLINT NOT NULL DEFAULT 0,
    "confirmed_version_no" SMALLINT,
    "agreement_consent_id" UUID NOT NULL,
    "open_cancel_request_id" UUID,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "first_due_at" TIMESTAMPTZ(3) NOT NULL,
    "first_breached_at" TIMESTAMPTZ(3),
    "due_at" TIMESTAMPTZ(3),
    "sla_snapshot" JSONB,
    "confirmed_at" TIMESTAMPTZ(3),
    "cancel_reason_code" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_ad" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_version" (
    "id" UUID NOT NULL,
    "ad_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "version_no" SMALLINT NOT NULL,
    "file_id" UUID NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "segments" JSONB,
    "uploaded_by_staff_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL,
    "pushed_at" TIMESTAMPTZ(3),
    "preview_channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "offline_sent_at" TIMESTAMPTZ(3),
    "offline_sent_by_staff_id" UUID,
    "decision" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "confirm_viewed_via" TEXT,
    "viewed_ack_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_ad_version" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_revision" (
    "id" UUID NOT NULL,
    "ad_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "revision_no" SMALLINT NOT NULL,
    "on_version_no" SMALLINT NOT NULL,
    "source" TEXT NOT NULL,
    "is_chargeable" BOOLEAN NOT NULL DEFAULT false,
    "charge_points" INTEGER NOT NULL DEFAULT 0,
    "charge_point_hold_id" UUID,
    "time_start_ms" INTEGER,
    "time_end_ms" INTEGER,
    "segment_index" SMALLINT,
    "note" TEXT NOT NULL,
    "screenshot_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "client" TEXT,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "breached_at" TIMESTAMPTZ(3),
    "fulfilled_by_version_no" SMALLINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_ad_revision" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_ticket" (
    "id" UUID NOT NULL,
    "ticket_no" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "drama_order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "drama_id" UUID NOT NULL,
    "step" TEXT NOT NULL,
    "step_entered_at" TIMESTAMPTZ(3) NOT NULL,
    "step_due_at" TIMESTAMPTZ(3),
    "waiting_on" TEXT NOT NULL,
    "pause_count" SMALLINT NOT NULL DEFAULT 0,
    "paused_at" TIMESTAMPTZ(3),
    "pause_remaining_min" INTEGER,
    "delivery_manager_id" UUID,
    "editor_id" UUID,
    "publisher_id" UUID,
    "schedule_priority" TEXT NOT NULL DEFAULT 'standard',
    "sample_round_no" SMALLINT NOT NULL DEFAULT 0,
    "current_sample_version_no" SMALLINT,
    "delivery_target_at" TIMESTAMPTZ(3) NOT NULL,
    "assigned_at" TIMESTAMPTZ(3),
    "plan_confirmed_at" TIMESTAMPTZ(3),
    "ads_ready_at" TIMESTAMPTZ(3),
    "sample_first_pushed_at" TIMESTAMPTZ(3),
    "sample_confirmed_at" TIMESTAMPTZ(3),
    "composed_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "links_submitted_at" TIMESTAMPTZ(3),
    "live_at" TIMESTAMPTZ(3),
    "usage_ended_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "terminated_at" TIMESTAMPTZ(3),
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_delivery_ticket" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_ticket_stage" (
    "id" UUID NOT NULL,
    "delivery_ticket_id" UUID NOT NULL,
    "step" TEXT NOT NULL,
    "visit_no" SMALLINT NOT NULL,
    "entered_at" TIMESTAMPTZ(3) NOT NULL,
    "due_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "exit_event" TEXT,
    "paused_minutes" INTEGER NOT NULL DEFAULT 0,
    "is_breached" BOOLEAN NOT NULL DEFAULT false,
    "sla_snapshot" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_delivery_ticket_stage" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_ticket_pause" (
    "id" UUID NOT NULL,
    "delivery_ticket_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "client" TEXT,
    "released_at" TIMESTAMPTZ(3),
    "release_event" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_delivery_ticket_pause" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_plan" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "drama_order_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "draft_lock_version" INTEGER NOT NULL DEFAULT 0,
    "current_version_no" INTEGER NOT NULL DEFAULT 0,
    "confirmed_version_no" INTEGER,
    "pushed_at" TIMESTAMPTZ(3),
    "confirmed_at" TIMESTAMPTZ(3),
    "staff_due_at" TIMESTAMPTZ(3),
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_delivery_plan" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_plan_version" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "delivery_plan_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "content_snapshot" JSONB NOT NULL,
    "change_summary" TEXT,
    "pushed_by_staff_id" UUID NOT NULL,
    "pushed_at" TIMESTAMPTZ(3) NOT NULL,
    "decision" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "decide_actor_type" TEXT,
    "decide_actor_id" UUID,
    "decide_client" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_delivery_plan_version" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_plan_change_request" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "delivery_plan_id" UUID NOT NULL,
    "on_version_no" INTEGER NOT NULL,
    "kinds" TEXT[],
    "note" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "resolved_by_version_no" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_delivery_plan_change_request" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "delivery_ticket_id" UUID NOT NULL,
    "version_no" SMALLINT NOT NULL,
    "file_id" UUID NOT NULL,
    "duration_ms" INTEGER,
    "ad_slots" JSONB NOT NULL,
    "ad_versions_used" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "uploaded_by_staff_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL,
    "qc_record_id" UUID,
    "pushed_by_staff_id" UUID,
    "pushed_at" TIMESTAMPTZ(3),
    "preview_channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "offline_sent_at" TIMESTAMPTZ(3),
    "offline_sent_by_staff_id" UUID,
    "first_viewed_at" TIMESTAMPTZ(3),
    "viewed_ack_at" TIMESTAMPTZ(3),
    "viewed_ack_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_user_id" UUID,
    "decide_client" TEXT,
    "confirm_viewed_via" TEXT,
    "on_behalf_staff_id" UUID,
    "feedback_kind" TEXT,
    "feedback_note" TEXT,
    "feedback_time_ms" INTEGER,
    "feedback_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_sample" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "episode_output" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "delivery_ticket_id" UUID NOT NULL,
    "episode_no" INTEGER NOT NULL,
    "variant" TEXT NOT NULL DEFAULT 'common',
    "revision_no" SMALLINT NOT NULL DEFAULT 1,
    "file_id" UUID NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "duration_ms" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'manual_upload',
    "status" TEXT NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "delivery_reissue_id" UUID,
    "qc_record_id" UUID,
    "uploaded_by_staff_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_episode_output" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_record" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "delivery_ticket_id" UUID NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "checklist_code" TEXT NOT NULL,
    "checklist_version_no" INTEGER NOT NULL,
    "results" JSONB NOT NULL,
    "verdict" TEXT NOT NULL,
    "reject_reason" TEXT,
    "inspected_by_staff_id" UUID NOT NULL,
    "inspected_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_qc_record" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_release" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "delivery_ticket_id" UUID NOT NULL,
    "release_no" INTEGER NOT NULL,
    "variant" TEXT NOT NULL DEFAULT 'common',
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "episode_count" INTEGER NOT NULL,
    "total_bytes" BIGINT NOT NULL,
    "manifest_snapshot" JSONB NOT NULL,
    "changed_episode_nos" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "publish_list_text" TEXT,
    "checklist_code" TEXT NOT NULL,
    "checklist_version_no" INTEGER NOT NULL,
    "precheck_results" JSONB NOT NULL,
    "reason_code" TEXT,
    "note" TEXT,
    "pushed_by_staff_id" UUID NOT NULL,
    "pushed_at" TIMESTAMPTZ(3) NOT NULL,
    "superseded_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_delivery_release" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_reissue" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "delivery_ticket_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "episode_nos" INTEGER[],
    "reason_code" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "opened_by_staff_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL,
    "published_delivery_release_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_delivery_reissue" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "download_grant" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "delivery_release_id" UUID NOT NULL,
    "grantee_type" TEXT NOT NULL,
    "grantee_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "valid_days" SMALLINT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "client" TEXT,
    "revoke_reason" TEXT,
    "ended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_download_grant" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_download_log" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "delivery_release_id" UUID NOT NULL,
    "download_grant_id" UUID,
    "order_item_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "episode_no" INTEGER,
    "file_id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "client" TEXT NOT NULL,
    "url_ttl_sec" INTEGER NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "client_ack" TEXT,
    "client_ack_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_delivery_download_log" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_list" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "delivery_ticket_id" UUID NOT NULL,
    "collection_name" TEXT,
    "cover_file_id" UUID,
    "title_template" TEXT,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "intro" TEXT,
    "is_ai_declaration_required" BOOLEAN NOT NULL DEFAULT false,
    "saved_by_staff_id" UUID,
    "saved_at" TIMESTAMPTZ(3),
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_publish_list" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_list_episode" (
    "delivery_ticket_id" UUID NOT NULL,
    "episode_no" INTEGER NOT NULL,
    "highlight" TEXT,
    "title" TEXT,
    "topics" TEXT[],
    "intro" TEXT,
    "changed_in_release_no" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_publish_list_episode" PRIMARY KEY ("delivery_ticket_id","episode_no")
);

-- CreateTable
CREATE TABLE "channel_account" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "account_uid" TEXT NOT NULL,
    "account_uid_norm" TEXT NOT NULL,
    "account_type" TEXT,
    "cert_subject_name" TEXT,
    "status" TEXT NOT NULL,
    "abnormal_source" TEXT,
    "abnormal_reason_code" TEXT,
    "abnormal_note" TEXT,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "verified_at" TIMESTAMPTZ(3),
    "verified_by_staff_id" UUID,
    "unbound_at" TIMESTAMPTZ(3),
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_channel_account" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_account_submission" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "round_no" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "filled_snapshot" JSONB NOT NULL,
    "screenshot_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "compare_result" JSONB,
    "approval_request_id" UUID NOT NULL,
    "submitted_by_user_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_channel_account_submission" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "launch_task" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "delivery_ticket_id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "review_status" TEXT NOT NULL,
    "is_live" BOOLEAN NOT NULL DEFAULT false,
    "went_live_at" TIMESTAMPTZ(3),
    "current_round_no" INTEGER NOT NULL DEFAULT 0,
    "first_launch_date" DATE,
    "verified_episode_count" INTEGER NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMPTZ(3),
    "last_patrolled_at" TIMESTAMPTZ(3),
    "last_patrol_result" TEXT,
    "void_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_launch_task" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "launch_submission" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "launch_task_id" UUID NOT NULL,
    "round_no" INTEGER NOT NULL,
    "link_kind" TEXT NOT NULL,
    "collection_url" TEXT,
    "episode_urls" JSONB,
    "reported_episode_count" INTEGER NOT NULL,
    "actual_launch_date" DATE NOT NULL,
    "submit_actor_type" TEXT NOT NULL,
    "submit_actor_id" UUID,
    "submit_client" TEXT,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "approval_request_id" UUID NOT NULL,
    "result" TEXT NOT NULL DEFAULT 'pending',
    "verified_episode_count" INTEGER,
    "evidence_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "reopen_of_launch_submission_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_launch_submission" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patrol_batch" (
    "id" UUID NOT NULL,
    "week_start_date" DATE NOT NULL,
    "live_total" INTEGER NOT NULL DEFAULT 0,
    "sampled_count" INTEGER NOT NULL DEFAULT 0,
    "generated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_patrol_batch" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patrol_task" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "patrol_batch_id" UUID NOT NULL,
    "launch_task_id" UUID NOT NULL,
    "delivery_ticket_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "checklist_code" TEXT,
    "checklist_version_no" INTEGER,
    "results" JSONB,
    "abnormal_kind_code" TEXT,
    "note" TEXT,
    "evidence_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "checked_at" TIMESTAMPTZ(3),
    "checked_by_staff_id" UUID,
    "found_at" TIMESTAMPTZ(3),
    "notified_at" TIMESTAMPTZ(3),
    "recovered_at" TIMESTAMPTZ(3),
    "remind_count" SMALLINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_patrol_task" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "takedown_task" (
    "id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "delivery_ticket_id" UUID NOT NULL,
    "launch_task_id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "trigger_kind" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "usage_end_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "merchant_method" TEXT,
    "merchant_confirmed_at" TIMESTAMPTZ(3),
    "merchant_confirmed_by_user_id" UUID,
    "check_due_at" TIMESTAMPTZ(3),
    "sla_snapshot" JSONB,
    "still_online_count" SMALLINT NOT NULL DEFAULT 0,
    "escalated_at" TIMESTAMPTZ(3),
    "breach_notice_count" SMALLINT NOT NULL DEFAULT 0,
    "check_method" TEXT,
    "checklist_code" TEXT,
    "checklist_version_no" INTEGER,
    "results" JSONB,
    "evidence_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "checked_by_staff_id" UUID,
    "checked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_takedown_task" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_ticket" (
    "id" UUID NOT NULL,
    "ticket_no" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "submitter_user_id" UUID,
    "registered_by_staff_id" UUID,
    "type_code" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "image_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "contact_phone_enc" TEXT,
    "contact_phone_mask" TEXT,
    "owner_staff_id" UUID,
    "status" TEXT NOT NULL,
    "close_reason" TEXT,
    "withdraw_reason_code" TEXT,
    "close_note" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "response_due_at" TIMESTAMPTZ(3),
    "first_response_at" TIMESTAMPTZ(3),
    "solution_due_at" TIMESTAMPTZ(3) NOT NULL,
    "solution_at" TIMESTAMPTZ(3),
    "awaiting_confirm_at" TIMESTAMPTZ(3),
    "auto_resolve_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_via" TEXT,
    "reopened_count" SMALLINT NOT NULL DEFAULT 0,
    "escalated_at" TIMESTAMPTZ(3),
    "sla_snapshot" JSONB NOT NULL,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_service_ticket" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_ticket_entry" (
    "id" UUID NOT NULL,
    "service_ticket_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "tag" TEXT,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "client" TEXT,
    "body" TEXT,
    "merchant_body" TEXT,
    "image_file_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "link" JSONB,
    "is_visible_to_merchant" BOOLEAN NOT NULL DEFAULT false,
    "is_solution" BOOLEAN NOT NULL DEFAULT false,
    "outbox_event_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_service_ticket_entry" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_ticket_ref" (
    "service_ticket_id" UUID NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_service_ticket_ref" PRIMARY KEY ("service_ticket_id","ref_type","ref_id")
);

-- CreateTable
CREATE TABLE "notify_scene" (
    "scene_key" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ext_enabled" BOOLEAN NOT NULL DEFAULT true,
    "scene_enabled" BOOLEAN NOT NULL DEFAULT true,
    "wx_template_slot_key" TEXT,
    "sms_policy" TEXT NOT NULL DEFAULT 'never',
    "sms_template_key" TEXT,
    "sms_nodes" JSONB,
    "send_window" TEXT NOT NULL,
    "manager_escalation_enabled" BOOLEAN NOT NULL DEFAULT false,
    "collapse_window_sec" INTEGER NOT NULL DEFAULT 0,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "updated_by_staff_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_notify_scene" PRIMARY KEY ("scene_key")
);

-- CreateTable
CREATE TABLE "wx_template_slot" (
    "slot_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "provider_template_id" TEXT,
    "fields" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "fail_streak" INTEGER NOT NULL DEFAULT 0,
    "disabled_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_wx_template_slot" PRIMARY KEY ("slot_key")
);

-- CreateTable
CREATE TABLE "sms_template" (
    "template_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider_template_id" TEXT,
    "sign_name" TEXT,
    "params" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "last_ok_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_sms_template" PRIMARY KEY ("template_key")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL,
    "notify_scene_key" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "source_outbox_event_id" UUID,
    "source_rule" TEXT,
    "biz_type" TEXT,
    "biz_id" UUID,
    "node" TEXT NOT NULL DEFAULT 'N0',
    "merchant_user_id" UUID,
    "staff_id" UUID,
    "entity_id" UUID,
    "store_id" UUID,
    "vars" JSONB NOT NULL,
    "copy_mode" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_notification" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_delivery" (
    "id" UUID NOT NULL,
    "notification_id" UUID,
    "is_direct" BOOLEAN NOT NULL DEFAULT false,
    "channel" TEXT NOT NULL,
    "resend_no" SMALLINT NOT NULL DEFAULT 0,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "attempt_no" SMALLINT NOT NULL DEFAULT 0,
    "max_attempts" SMALLINT NOT NULL DEFAULT 3,
    "lease_until" TIMESTAMPTZ(3),
    "call_started_at" TIMESTAMPTZ(3),
    "target_ref" TEXT,
    "target_masked" TEXT,
    "purpose" TEXT,
    "direct_key" TEXT,
    "sms_template_key" TEXT,
    "provider_template_id" TEXT,
    "provider_msg_id" TEXT,
    "error_code" TEXT,
    "error_msg" TEXT,
    "receipt_status" TEXT,
    "receipt_reported_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_notification_delivery" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_message" (
    "id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "merchant_user_id" UUID NOT NULL,
    "entity_id" UUID,
    "store_id" UUID,
    "is_owner_only" BOOLEAN NOT NULL DEFAULT false,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "cta_text" TEXT,
    "link" JSONB NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_merchant_message" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_message" (
    "id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" JSONB NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_staff_message" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wx_subscribe_quota" (
    "wechat_identity_id" UUID NOT NULL,
    "wx_template_slot_key" TEXT NOT NULL,
    "merchant_user_id" UUID NOT NULL,
    "est_remaining" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'ok',
    "last_accept_at" TIMESTAMPTZ(3),
    "last_send_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_wx_subscribe_quota" PRIMARY KEY ("wechat_identity_id","wx_template_slot_key")
);

-- CreateTable
CREATE TABLE "manual_reminder_log" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "scene" TEXT NOT NULL,
    "biz_date" DATE NOT NULL,
    "sent_by_staff_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_manual_reminder_log" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agreement" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "consent_mode" TEXT NOT NULL,
    "scenes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sign_scene_label" TEXT NOT NULL,
    "audience_label" TEXT NOT NULL,
    "since_version" TEXT NOT NULL,
    "sort_no" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_agreement" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "agreement_version" (
    "id" UUID NOT NULL,
    "agreement_key" TEXT NOT NULL,
    "major" SMALLINT NOT NULL,
    "minor" SMALLINT NOT NULL,
    "status" TEXT NOT NULL,
    "effective_at" TIMESTAMPTZ(3),
    "summary" TEXT,
    "is_reconsent_required" BOOLEAN NOT NULL DEFAULT true,
    "source_file_id" UUID,
    "pdf_file_id" UUID,
    "content_html" TEXT,
    "content_sha256" TEXT,
    "html_sha256" TEXT,
    "is_legal_approved" BOOLEAN NOT NULL DEFAULT false,
    "site_notice_id" UUID,
    "short_notice_reason" TEXT,
    "expected_consents" INTEGER,
    "created_by_staff_id" UUID NOT NULL,
    "published_by_staff_id" UUID,
    "activated_at" TIMESTAMPTZ(3),
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_agreement_version" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agreement_consent" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "agreement_key" TEXT NOT NULL,
    "agreement_version_id" UUID NOT NULL,
    "content_sha256" TEXT NOT NULL,
    "merchant_user_id" UUID NOT NULL,
    "appid" TEXT,
    "openid_hmac" BYTEA,
    "phone_enc" TEXT NOT NULL,
    "phone_mask" TEXT NOT NULL,
    "operator_name_mask" TEXT,
    "role" TEXT,
    "entity_id" UUID,
    "entity_name" TEXT,
    "uscc_enc" TEXT,
    "uscc_mask" TEXT,
    "store_id" UUID,
    "scene" TEXT NOT NULL,
    "biz_type" TEXT,
    "biz_id" UUID,
    "biz_no" TEXT,
    "method" TEXT NOT NULL,
    "consented_at" TIMESTAMPTZ(3) NOT NULL,
    "ip" TEXT NOT NULL,
    "user_agent" TEXT,
    "device_snapshot" JSONB NOT NULL,
    "request_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_agreement_consent" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "license_letter" (
    "id" UUID NOT NULL,
    "letter_no" TEXT NOT NULL,
    "drama_order_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "channel_account_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "drama_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "period_start" DATE,
    "period_end" DATE NOT NULL,
    "current_revision_id" UUID,
    "verify_code" TEXT NOT NULL,
    "void_reason" TEXT,
    "voided_at" TIMESTAMPTZ(3),
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_license_letter" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "license_letter_revision" (
    "id" UUID NOT NULL,
    "license_letter_id" UUID NOT NULL,
    "rev_no" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "trigger_ref" TEXT NOT NULL,
    "letter_snapshot" JSONB NOT NULL,
    "content_fp" TEXT NOT NULL,
    "template_version" TEXT NOT NULL,
    "render_status" TEXT NOT NULL,
    "render_attempt_no" SMALLINT NOT NULL DEFAULT 0,
    "render_lease_until" TIMESTAMPTZ(3),
    "file_id" UUID,
    "pdf_sha256" TEXT,
    "sign_mode" TEXT,
    "cert_serial" TEXT,
    "cert_issuer" TEXT,
    "platform_signed_at" TIMESTAMPTZ(3),
    "merchant_signed_at" TIMESTAMPTZ(3),
    "esign_provider" TEXT,
    "esign_flow_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "ready_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_license_letter_revision" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dict_type" (
    "type_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "structure" TEXT NOT NULL,
    "max_depth" SMALLINT NOT NULL,
    "code_prefix" TEXT,
    "code_width" SMALLINT,
    "next_code_no" INTEGER NOT NULL DEFAULT 1,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "can_create" BOOLEAN NOT NULL DEFAULT true,
    "disable_policy" TEXT NOT NULL,
    "is_merchant_visible" BOOLEAN NOT NULL DEFAULT false,
    "version_no" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_dict_type" PRIMARY KEY ("type_key")
);

-- CreateTable
CREATE TABLE "dict_item" (
    "id" UUID NOT NULL,
    "dict_type_key" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "parent_code" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ext" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL DEFAULT 0,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_by_staff_id" UUID,
    "updated_by_staff_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_dict_item" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "param_value" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3),
    "reason" TEXT,
    "created_by_staff_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_param_value" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_config_revision" (
    "id" UUID NOT NULL,
    "config_key" TEXT NOT NULL,
    "rev_no" INTEGER,
    "status" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "base_rev_no" INTEGER,
    "note" TEXT,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_by_staff_id" UUID,
    "published_by_staff_id" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_site_config_revision" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "home_banner" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "image_file_id" UUID NOT NULL,
    "jump_kind" TEXT NOT NULL,
    "jump_target" JSONB,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3),
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_by_staff_id" UUID NOT NULL,
    "updated_by_staff_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_home_banner" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_notice" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "ref_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "summary_no_price" TEXT,
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "announced_at" TIMESTAMPTZ(3) NOT NULL,
    "lead_days" INTEGER NOT NULL,
    "short_notice_reason" TEXT,
    "link" JSONB NOT NULL,
    "bar_enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'announced',
    "created_by_staff_id" UUID NOT NULL,
    "withdrawn_by_staff_id" UUID,
    "withdrawn_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_site_notice" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flag" (
    "key" TEXT NOT NULL,
    "value_type" TEXT NOT NULL,
    "default_value" JSONB NOT NULL,
    "rules" JSONB NOT NULL DEFAULT '[]',
    "exposed_to" TEXT NOT NULL,
    "description" TEXT,
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "updated_by_staff_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_feature_flag" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "checklist_template" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "items" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "activated_at" TIMESTAMPTZ(3),
    "retired_at" TIMESTAMPTZ(3),
    "lock_version" INTEGER NOT NULL DEFAULT 0,
    "created_by_staff_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_checklist_template" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_event" (
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "client" TEXT,
    "merchant_user_id" UUID,
    "anonymous_id" UUID,
    "role" TEXT,
    "entity_id" UUID,
    "store_id" UUID,
    "city_code" TEXT,
    "category_code" TEXT,
    "client_platform" TEXT,
    "client_version" TEXT,
    "session_id" UUID,
    "scene" INTEGER,
    "props" JSONB NOT NULL DEFAULT '{}',
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_analytics_event" PRIMARY KEY ("occurred_at","id")
);

-- CreateTable
CREATE TABLE "analytics_event_dedup" (
    "event_id" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_analytics_event_dedup" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "analytics_identity" (
    "anonymous_id" UUID NOT NULL,
    "merchant_user_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_analytics_identity" PRIMARY KEY ("anonymous_id")
);

-- CreateTable
CREATE TABLE "report_month_close" (
    "id" UUID NOT NULL,
    "report_key" TEXT NOT NULL,
    "month_date" DATE NOT NULL,
    "revision_no" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "finality" JSONB NOT NULL,
    "metric_def_version" INTEGER NOT NULL,
    "cutoff_at" TIMESTAMPTZ(3) NOT NULL,
    "billing_month_close_id" UUID,
    "closed_at" TIMESTAMPTZ(3) NOT NULL,
    "closed_by_staff_id" UUID,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_report_month_close" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_job" (
    "id" UUID NOT NULL,
    "job_no" TEXT NOT NULL,
    "export_key" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "params_hash" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "requested_by_staff_id" UUID NOT NULL,
    "request_scope_snapshot" JSONB NOT NULL,
    "is_masked" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempt_no" SMALLINT NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ(3),
    "row_count" INTEGER,
    "file_id" UUID,
    "size_bytes" BIGINT,
    "sha256" TEXT,
    "error" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "last_downloaded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_export_job" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_event" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,
    "payload_digest" BYTEA NOT NULL,
    "key_version" TEXT,
    "process_state" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "processed_at" TIMESTAMPTZ(3),
    "error" TEXT,
    "payload_purge_at" TIMESTAMPTZ(3),
    "payload_purged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_webhook_event" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_lease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "holder_version" TEXT NOT NULL,
    "acquired_at" TIMESTAMPTZ(3) NOT NULL,
    "heartbeat_at" TIMESTAMPTZ(3) NOT NULL,
    "probe_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_worker_lease" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "alert_event" (
    "id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "ok_streak" SMALLINT NOT NULL DEFAULT 0,
    "last_value" JSONB,
    "last_notified_at" TIMESTAMPTZ(3),
    "notify_count" INTEGER NOT NULL DEFAULT 0,
    "acked_by_staff_id" UUID,
    "acked_at" TIMESTAMPTZ(3),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_alert_event" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invariant_run" (
    "id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "scope" JSONB,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),
    "checks_run" INTEGER NOT NULL DEFAULT 0,
    "violations_found" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_invariant_run" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invariant_violation" (
    "id" UUID NOT NULL,
    "invariant_run_id" UUID,
    "code" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "subject_type" TEXT,
    "subject_id" UUID,
    "subject_key" TEXT,
    "detail" JSONB NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "auto_healed_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_staff_id" UUID,
    "resolution" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_invariant_violation" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_idempotency_record_expires_at" ON "idempotency_record"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_outbox_event_seq" ON "outbox_event"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "uq_outbox_event_dedupe_key" ON "outbox_event"("dedupe_key");

-- CreateIndex
CREATE INDEX "ix_outbox_event_aggregate_type_aggregate_id" ON "outbox_event"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "ix_timer_kind_fire_at" ON "timer"("kind", "fire_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_status_transition_seq" ON "status_transition"("seq");

-- CreateIndex
CREATE INDEX "ix_status_transition_machine_subject_id_state_field_seq" ON "status_transition"("machine", "subject_id", "state_field", "seq");

-- CreateIndex
CREATE INDEX "ix_status_transition_machine_state_field_to_state_occurred_at" ON "status_transition"("machine", "state_field", "to_state", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_merchant_user_phone_bidx" ON "merchant_user"("phone_bidx");

-- CreateIndex
CREATE INDEX "ix_merchant_user_phone_last4" ON "merchant_user"("phone_last4");

-- CreateIndex
CREATE INDEX "ix_merchant_user_source_referral_code_id" ON "merchant_user"("source_referral_code_id");

-- CreateIndex
CREATE INDEX "ix_wechat_identity_merchant_user_id" ON "wechat_identity"("merchant_user_id");

-- CreateIndex
CREATE INDEX "ix_wechat_identity_unionid" ON "wechat_identity"("unionid");

-- CreateIndex
CREATE UNIQUE INDEX "uq_wechat_identity_appid_openid" ON "wechat_identity"("appid", "openid");

-- CreateIndex
CREATE INDEX "ix_user_session_wechat_identity_id" ON "user_session"("wechat_identity_id");

-- CreateIndex
CREATE INDEX "ix_user_session_absolute_expires_at" ON "user_session"("absolute_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_portal_session_token_hash" ON "portal_session"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "uq_portal_session_portal_ticket_id" ON "portal_session"("portal_ticket_id");

-- CreateIndex
CREATE INDEX "ix_portal_session_expires_at" ON "portal_session"("expires_at");

-- CreateIndex
CREATE INDEX "ix_merchant_user_notice_merchant_user_id" ON "merchant_user_notice"("merchant_user_id");

-- CreateIndex
CREATE INDEX "ix_sms_verification_phone_bidx_created_at" ON "sms_verification"("phone_bidx", "created_at");

-- CreateIndex
CREATE INDEX "ix_sms_verification_merchant_user_id_purpose" ON "sms_verification"("merchant_user_id", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "ix_sms_verification_expires_at" ON "sms_verification"("expires_at");

-- CreateIndex
CREATE INDEX "ix_wecom_contact_merchant_user_id_staff_id" ON "wecom_contact"("merchant_user_id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_account_change_request_approval_request_id" ON "account_change_request"("approval_request_id");

-- CreateIndex
CREATE INDEX "ix_account_change_request_merchant_user_id" ON "account_change_request"("merchant_user_id");

-- CreateIndex
CREATE INDEX "ix_account_change_request_entity_id" ON "account_change_request"("entity_id");

-- CreateIndex
CREATE INDEX "ix_entity_uscc_bidx" ON "entity"("uscc_bidx");

-- CreateIndex
CREATE INDEX "ix_entity_created_by_user_id" ON "entity"("created_by_user_id");

-- CreateIndex
CREATE INDEX "ix_entity_source_referral_code_id" ON "entity"("source_referral_code_id");

-- CreateIndex
CREATE INDEX "ix_store_entity_id_lifecycle" ON "store"("entity_id", "lifecycle");

-- CreateIndex
CREATE INDEX "ix_store_delivery_manager_id" ON "store"("delivery_manager_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_store_id_entity_id" ON "store"("id", "entity_id");

-- CreateIndex
CREATE INDEX "ix_entity_member_entity_id" ON "entity_member"("entity_id");

-- CreateIndex
CREATE INDEX "ix_entity_member_merchant_user_id" ON "entity_member"("merchant_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_entity_member_id_entity_id" ON "entity_member"("id", "entity_id");

-- CreateIndex
CREATE INDEX "ix_store_member_store_id" ON "store_member"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_invitation_token_hash" ON "invitation"("token_hash");

-- CreateIndex
CREATE INDEX "ix_invitation_entity_id_created_at" ON "invitation"("entity_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_invitation_store_id" ON "invitation"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_invitation_inviter_member_id_client_request_id" ON "invitation"("inviter_member_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_referral_code_code" ON "referral_code"("code");

-- CreateIndex
CREATE INDEX "ix_referral_code_owner_staff_id" ON "referral_code"("owner_staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_portal_ticket_public_id" ON "portal_ticket"("public_id");

-- CreateIndex
CREATE INDEX "ix_portal_ticket_created_at" ON "portal_ticket"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_staff_group_staff_role_key_name" ON "staff_group"("staff_role_key", "name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_staff_staff_no" ON "staff"("staff_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_staff_phone_bidx" ON "staff"("phone_bidx");

-- CreateIndex
CREATE UNIQUE INDEX "uq_staff_wecom_userid" ON "staff"("wecom_userid");

-- CreateIndex
CREATE INDEX "ix_staff_staff_role_key_status" ON "staff"("staff_role_key", "status");

-- CreateIndex
CREATE INDEX "ix_staff_staff_group_id" ON "staff"("staff_group_id");

-- CreateIndex
CREATE INDEX "ix_staff_phone_last4" ON "staff"("phone_last4");

-- CreateIndex
CREATE INDEX "ix_staff_activation_staff_id" ON "staff_activation"("staff_id");

-- CreateIndex
CREATE INDEX "ix_staff_activation_expires_at" ON "staff_activation"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_staff_session_token_hash" ON "staff_session"("token_hash");

-- CreateIndex
CREATE INDEX "ix_staff_session_absolute_expires_at" ON "staff_session"("absolute_expires_at");

-- CreateIndex
CREATE INDEX "ix_assignment_pool_member_staff_id" ON "assignment_pool_member"("staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_assignment_history_seq" ON "assignment_history"("seq");

-- CreateIndex
CREATE INDEX "ix_assignment_history_subject" ON "assignment_history"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "ix_assignment_history_batch_id" ON "assignment_history"("batch_id");

-- CreateIndex
CREATE INDEX "ix_assignment_history_from_staff_id" ON "assignment_history"("from_staff_id");

-- CreateIndex
CREATE INDEX "ix_assignment_history_to_staff_id" ON "assignment_history"("to_staff_id");

-- CreateIndex
CREATE INDEX "ix_follow_up_subject_created_at" ON "follow_up"("subject_type", "subject_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_follow_up_entity_id_created_at" ON "follow_up"("entity_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_follow_up_store_id_created_at" ON "follow_up"("store_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_audit_log_seq" ON "audit_log"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "uq_audit_log_log_no" ON "audit_log"("log_no");

-- CreateIndex
CREATE INDEX "ix_audit_log_stream_created_at" ON "audit_log"("stream", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_audit_log_stream_category_created_at" ON "audit_log"("stream", "category", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_audit_log_actor_created_at" ON "audit_log"("actor_type", "actor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_audit_log_target" ON "audit_log"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_auth_event_seq" ON "auth_event"("seq");

-- CreateIndex
CREATE INDEX "ix_auth_event_space_subject_created_at" ON "auth_event"("space", "subject_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_auth_event_event_created_at" ON "auth_event"("event", "created_at");

-- CreateIndex
CREATE INDEX "ix_auth_event_created_at" ON "auth_event"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_approval_request_request_no" ON "approval_request"("request_no");

-- CreateIndex
CREATE INDEX "ix_approval_request_kind_status_due_at" ON "approval_request"("kind", "status", "due_at");

-- CreateIndex
CREATE INDEX "ix_approval_request_delivery_ticket_id_status" ON "approval_request"("delivery_ticket_id", "status");

-- CreateIndex
CREATE INDEX "ix_approval_request_store_id_kind" ON "approval_request"("store_id", "kind");

-- CreateIndex
CREATE INDEX "ix_approval_request_entity_id_kind" ON "approval_request"("entity_id", "kind");

-- CreateIndex
CREATE INDEX "ix_approval_request_subject_kind" ON "approval_request"("subject_type", "subject_id", "kind");

-- CreateIndex
CREATE INDEX "ix_approval_request_requester_staff_id_status" ON "approval_request"("requester_staff_id", "status");

-- CreateIndex
CREATE INDEX "ix_store_profile_entity_id" ON "store_profile"("entity_id");

-- CreateIndex
CREATE INDEX "ix_store_profile_city_code_district_code" ON "store_profile"("city_code", "district_code");

-- CreateIndex
CREATE INDEX "ix_store_profile_industry_code_category_code" ON "store_profile"("industry_code", "category_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_store_profile_store_id_entity_id" ON "store_profile"("store_id", "entity_id");

-- CreateIndex
CREATE INDEX "ix_store_profile_media_file_id" ON "store_profile_media"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_qualification_submission_approval_request_id" ON "qualification_submission"("approval_request_id");

-- CreateIndex
CREATE INDEX "ix_qualification_submission_store_id_submitted_at" ON "qualification_submission"("store_id", "submitted_at" DESC);

-- CreateIndex
CREATE INDEX "ix_qualification_submission_entity_id_kind" ON "qualification_submission"("entity_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "uq_qualification_submission_id_store_id_entity_id" ON "qualification_submission"("id", "store_id", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_qualification_submission_store_id_round_no" ON "qualification_submission"("store_id", "round_no");

-- CreateIndex
CREATE INDEX "ix_drama_status" ON "drama"("status");

-- CreateIndex
CREATE INDEX "ix_drama_genre_codes" ON "drama" USING GIN ("genre_codes");

-- CreateIndex
CREATE INDEX "ix_drama_industry_codes" ON "drama" USING GIN ("industry_codes");

-- CreateIndex
CREATE UNIQUE INDEX "uq_drama_episode_drama_id_episode_no" ON "drama_episode"("drama_id", "episode_no");

-- CreateIndex
CREATE INDEX "ix_drama_permit_drama_id" ON "drama_permit"("drama_id");

-- CreateIndex
CREATE INDEX "ix_drama_copyright_license_end_date" ON "drama_copyright"("license_end_date");

-- CreateIndex
CREATE UNIQUE INDEX "uq_drama_copyright_revision_seq" ON "drama_copyright_revision"("seq");

-- CreateIndex
CREATE INDEX "ix_drama_copyright_revision_drama_id_seq" ON "drama_copyright_revision"("drama_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "uq_drama_copyright_revision_id_drama_id" ON "drama_copyright_revision"("id", "drama_id");

-- CreateIndex
CREATE INDEX "ix_file_object_store_id_category_id" ON "file_object"("store_id", "category", "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_file_object_bucket_object_key" ON "file_object"("bucket", "object_key");

-- CreateIndex
CREATE INDEX "ix_file_ref_ref_type_ref_id" ON "file_ref"("ref_type", "ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_file_ref_file_id_ref_type_ref_id_role" ON "file_ref"("file_id", "ref_type", "ref_id", "role");

-- CreateIndex
CREATE INDEX "ix_file_purge_run_state_created_at" ON "file_purge_run"("state", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_upload_batch_purpose_target_id" ON "upload_batch"("purpose", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_upload_batch_created_by_staff_id_idempotency_key" ON "upload_batch"("created_by_staff_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "ix_upload_batch_item_file_id" ON "upload_batch_item"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_upload_batch_item_upload_batch_id_file_id" ON "upload_batch_item"("upload_batch_id", "file_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_media_job_dedupe_key" ON "media_job"("dedupe_key");

-- CreateIndex
CREATE INDEX "ix_media_job_subject_type_subject_id_kind" ON "media_job"("subject_type", "subject_id", "kind");

-- CreateIndex
CREATE INDEX "ix_media_job_kind_created_at" ON "media_job"("kind", "created_at");

-- CreateIndex
CREATE INDEX "ix_playable_asset_owner_type_owner_id_kind" ON "playable_asset"("owner_type", "owner_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "uq_playable_asset_kind_source_file_id_spec_version" ON "playable_asset"("kind", "source_file_id", "spec_version");

-- CreateIndex
CREATE UNIQUE INDEX "uq_zip_bundle_owner_type_owner_id" ON "zip_bundle"("owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "ix_drama_episode_master_file_id" ON "drama_episode_master"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_drama_episode_master_drama_id_episode_no_rev_no" ON "drama_episode_master"("drama_id", "episode_no", "rev_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_store_asset_store_id_idempotency_key" ON "store_asset"("store_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_store_asset_id_entity_id" ON "store_asset"("id", "entity_id");

-- CreateIndex
CREATE INDEX "ix_store_asset_file_file_id" ON "store_asset_file"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_store_asset_file_store_asset_id_file_id" ON "store_asset_file"("store_asset_id", "file_id");

-- CreateIndex
CREATE INDEX "ix_store_asset_insight_file_id_kind" ON "store_asset_insight"("file_id", "kind");

-- CreateIndex
CREATE INDEX "ix_store_asset_tag_tag_code_dimension" ON "store_asset_tag"("tag_code", "dimension");

-- CreateIndex
CREATE UNIQUE INDEX "uq_store_asset_tag_store_asset_id_dimension_tag_code_source" ON "store_asset_tag"("store_asset_id", "dimension", "tag_code", "source");

-- CreateIndex
CREATE INDEX "ix_store_asset_usage_used_by_type_used_by_id" ON "store_asset_usage"("used_by_type", "used_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_store_asset_usage_store_asset_id_used_by_role" ON "store_asset_usage"("store_asset_id", "used_by_type", "used_by_id", "role");

-- CreateIndex
CREATE INDEX "ix_store_asset_demand_store_id_status_due_date" ON "store_asset_demand"("store_id", "status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "uq_store_asset_demand_id_store_id" ON "store_asset_demand"("id", "store_id");

-- CreateIndex
CREATE INDEX "ix_ocr_result_file_id_id" ON "ocr_result"("file_id", "id" DESC);

-- CreateIndex
CREATE INDEX "ix_ocr_result_store_id_created_at" ON "ocr_result"("store_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_plan_code" ON "plan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_plan_rank" ON "plan"("rank");

-- CreateIndex
CREATE UNIQUE INDEX "uq_plan_revision_plan_id_revision_no" ON "plan_revision"("plan_id", "revision_no");

-- CreateIndex
CREATE INDEX "ix_plan_promo_claim_billing_order_id" ON "plan_promo_claim"("billing_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_plan_promo_claim_entity_id_plan_revision_id" ON "plan_promo_claim"("entity_id", "plan_revision_id");

-- CreateIndex
CREATE INDEX "ix_price_tier_revision_batch_id" ON "price_tier_revision"("batch_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_price_tier_revision_tier_effective_at" ON "price_tier_revision"("tier", "effective_at");

-- CreateIndex
CREATE INDEX "ix_drama_price_revision_drama_id_effective_at" ON "drama_price_revision"("drama_id", "effective_at");

-- CreateIndex
CREATE INDEX "ix_billing_param_change_id" ON "billing_param"("change_id");

-- CreateIndex
CREATE INDEX "ix_billing_account_next_due_at" ON "billing_account"("next_due_at");

-- CreateIndex
CREATE INDEX "ix_billing_account_sub_status" ON "billing_account"("sub_status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_subscription_term_source_billing_order_id" ON "subscription_term"("source_billing_order_id");

-- CreateIndex
CREATE INDEX "ix_subscription_term_entity_id_status_starts_at" ON "subscription_term"("entity_id", "status", "starts_at");

-- CreateIndex
CREATE INDEX "ix_subscription_term_status_ends_at" ON "subscription_term"("status", "ends_at");

-- CreateIndex
CREATE INDEX "ix_subscription_term_refund_request_id" ON "subscription_term"("refund_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_subscription_term_entity_id_term_no" ON "subscription_term"("entity_id", "term_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_subscription_event_seq" ON "subscription_event"("seq");

-- CreateIndex
CREATE INDEX "ix_subscription_event_entity_id_occurred_at" ON "subscription_event"("entity_id", "occurred_at");

-- CreateIndex
CREATE INDEX "ix_subscription_event_subscription_term_id" ON "subscription_event"("subscription_term_id");

-- CreateIndex
CREATE INDEX "ix_subscription_event_type_biz_date" ON "subscription_event"("type", "biz_date");

-- CreateIndex
CREATE INDEX "ix_grant_schedule_status_due_at" ON "grant_schedule"("status", "due_at");

-- CreateIndex
CREATE INDEX "ix_grant_schedule_entity_id_status" ON "grant_schedule"("entity_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_grant_schedule_subscription_term_id_month_no" ON "grant_schedule"("subscription_term_id", "month_no");

-- CreateIndex
CREATE INDEX "ix_point_lot_entity_id" ON "point_lot"("entity_id");

-- CreateIndex
CREATE INDEX "ix_point_lot_subscription_term_id" ON "point_lot"("subscription_term_id");

-- CreateIndex
CREATE INDEX "ix_point_lot_updated_at" ON "point_lot"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_point_lot_source_type_source_id_source_no" ON "point_lot"("source_type", "source_id", "source_no");

-- CreateIndex
CREATE INDEX "ix_point_hold_subscription_term_id" ON "point_hold"("subscription_term_id");

-- CreateIndex
CREATE INDEX "ix_point_hold_entity_id_status" ON "point_hold"("entity_id", "status");

-- CreateIndex
CREATE INDEX "ix_point_hold_store_id" ON "point_hold"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_point_hold_ref_type_ref_id" ON "point_hold"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "ix_point_hold_alloc_point_lot_id" ON "point_hold_alloc"("point_lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_point_hold_alloc_point_hold_id_point_lot_id" ON "point_hold_alloc"("point_hold_id", "point_lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ledger_operation_seq" ON "ledger_operation"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ledger_operation_op_key" ON "ledger_operation"("op_key");

-- CreateIndex
CREATE INDEX "ix_ledger_operation_entity_id_occurred_at" ON "ledger_operation"("entity_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "ix_ledger_operation_ref_type_ref_id" ON "ledger_operation"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "ix_ledger_operation_point_hold_id" ON "ledger_operation"("point_hold_id");

-- CreateIndex
CREATE INDEX "ix_ledger_operation_biz_date" ON "ledger_operation"("biz_date");

-- CreateIndex
CREATE UNIQUE INDEX "uq_point_ledger_entry_seq" ON "point_ledger_entry"("seq");

-- CreateIndex
CREATE INDEX "ix_point_ledger_entry_entity_id_seq" ON "point_ledger_entry"("entity_id", "seq");

-- CreateIndex
CREATE INDEX "ix_point_ledger_entry_point_lot_id_seq" ON "point_ledger_entry"("point_lot_id", "seq");

-- CreateIndex
CREATE INDEX "ix_point_ledger_entry_biz_date" ON "point_ledger_entry"("biz_date");

-- CreateIndex
CREATE INDEX "ix_point_ledger_entry_ledger_operation_id" ON "point_ledger_entry"("ledger_operation_id");

-- CreateIndex
CREATE INDEX "ix_point_ledger_entry_point_hold_id" ON "point_ledger_entry"("point_hold_id");

-- CreateIndex
CREATE INDEX "ix_billing_entity_daily_entity_id_biz_date" ON "billing_entity_daily"("entity_id", "biz_date");

-- CreateIndex
CREATE INDEX "ix_point_entry_valuation_lot_version_entry_seq" ON "point_entry_valuation"("point_lot_id", "valuation_policy_version_no", "point_ledger_entry_seq");

-- CreateIndex
CREATE INDEX "ix_point_entry_valuation_entity_id_biz_date" ON "point_entry_valuation"("entity_id", "biz_date");

-- CreateIndex
CREATE INDEX "ix_point_entry_valuation_valuation_policy_version_no_biz_date" ON "point_entry_valuation"("valuation_policy_version_no", "biz_date");

-- CreateIndex
CREATE UNIQUE INDEX "uq_point_adjustment_request_approval_request_id" ON "point_adjustment_request"("approval_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_point_adjustment_request_ledger_operation_id" ON "point_adjustment_request"("ledger_operation_id");

-- CreateIndex
CREATE INDEX "ix_point_adjustment_request_entity_id" ON "point_adjustment_request"("entity_id");

-- CreateIndex
CREATE INDEX "ix_point_adjustment_request_point_hold_id" ON "point_adjustment_request"("point_hold_id");

-- CreateIndex
CREATE INDEX "ix_point_adjustment_request_term_extension_request_id" ON "point_adjustment_request"("term_extension_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_term_extension_request_approval_request_id" ON "term_extension_request"("approval_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_term_extension_request_ledger_operation_id" ON "term_extension_request"("ledger_operation_id");

-- CreateIndex
CREATE INDEX "ix_term_extension_request_entity_id" ON "term_extension_request"("entity_id");

-- CreateIndex
CREATE INDEX "ix_term_extension_request_subscription_term_id" ON "term_extension_request"("subscription_term_id");

-- CreateIndex
CREATE INDEX "ix_term_extension_request_applied_subscription_term_id" ON "term_extension_request"("applied_subscription_term_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_billing_order_order_no" ON "billing_order"("order_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_billing_order_paid_payment_txn_id" ON "billing_order"("paid_payment_txn_id");

-- CreateIndex
CREATE INDEX "ix_billing_order_entity_created" ON "billing_order"("entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_billing_order_status_channel_created" ON "billing_order"("status", "channel", "created_at");

-- CreateIndex
CREATE INDEX "ix_billing_order_store_id" ON "billing_order"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payment_txn_out_trade_no" ON "payment_txn"("out_trade_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payment_txn_transfer_proof_id" ON "payment_txn"("transfer_proof_id");

-- CreateIndex
CREATE INDEX "ix_payment_txn_billing_order_attempt" ON "payment_txn"("billing_order_id", "attempt_no");

-- CreateIndex
CREATE INDEX "ix_payment_txn_status_success" ON "payment_txn"("status", "channel_success_at");

-- CreateIndex
CREATE INDEX "ix_payment_txn_recon_success" ON "payment_txn"("recon_state", "channel_success_at");

-- CreateIndex
CREATE INDEX "ix_payment_txn_entity_success" ON "payment_txn"("entity_id", "channel_success_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_transfer_proof_review_approval_request_id" ON "transfer_proof"("review_approval_request_id");

-- CreateIndex
CREATE INDEX "ix_transfer_proof_review_status_uploaded" ON "transfer_proof"("review_status", "uploaded_at");

-- CreateIndex
CREATE INDEX "ix_transfer_proof_entity_id" ON "transfer_proof"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_transfer_proof_billing_order_upload_no" ON "transfer_proof"("billing_order_id", "upload_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_refund_request_approval_request_id" ON "refund_request"("approval_request_id");

-- CreateIndex
CREATE INDEX "ix_refund_request_status_created" ON "refund_request"("status", "created_at");

-- CreateIndex
CREATE INDEX "ix_refund_request_status_exec_due_at" ON "refund_request"("status", "exec_due_at");

-- CreateIndex
CREATE INDEX "ix_refund_request_billing_order_id" ON "refund_request"("billing_order_id");

-- CreateIndex
CREATE INDEX "ix_refund_request_payment_txn_id" ON "refund_request"("payment_txn_id");

-- CreateIndex
CREATE INDEX "ix_refund_request_entity_created" ON "refund_request"("entity_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_refund_txn_out_refund_no" ON "refund_txn"("out_refund_no");

-- CreateIndex
CREATE INDEX "ix_refund_txn_refund_request_id" ON "refund_txn"("refund_request_id");

-- CreateIndex
CREATE INDEX "ix_refund_txn_payment_txn_id" ON "refund_txn"("payment_txn_id");

-- CreateIndex
CREATE INDEX "ix_refund_txn_billing_order_id" ON "refund_txn"("billing_order_id");

-- CreateIndex
CREATE INDEX "ix_refund_txn_status_success" ON "refund_txn"("status", "success_at");

-- CreateIndex
CREATE INDEX "ix_refund_txn_recon_success" ON "refund_txn"("recon_state", "success_at");

-- CreateIndex
CREATE INDEX "ix_refund_txn_entity_id" ON "refund_txn"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payment_exception_exception_no" ON "payment_exception"("exception_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payment_exception_dedupe_key" ON "payment_exception"("dedupe_key");

-- CreateIndex
CREATE INDEX "ix_payment_exception_status_kind" ON "payment_exception"("status", "kind");

-- CreateIndex
CREATE INDEX "ix_payment_exception_bill_date_status" ON "payment_exception"("bill_date", "status");

-- CreateIndex
CREATE INDEX "ix_payment_exception_billing_order_id" ON "payment_exception"("billing_order_id");

-- CreateIndex
CREATE INDEX "ix_payment_exception_payment_txn_id" ON "payment_exception"("payment_txn_id");

-- CreateIndex
CREATE INDEX "ix_payment_exception_refund_txn_id" ON "payment_exception"("refund_txn_id");

-- CreateIndex
CREATE INDEX "ix_payment_exception_wx_bill_line_id" ON "payment_exception"("wx_bill_line_id");

-- CreateIndex
CREATE INDEX "ix_payment_exception_refund_request_id" ON "payment_exception"("refund_request_id");

-- CreateIndex
CREATE INDEX "ix_payment_exception_entity_id" ON "payment_exception"("entity_id");

-- CreateIndex
CREATE INDEX "ix_wx_bill_file_status_bill_date" ON "wx_bill_file"("status", "bill_date");

-- CreateIndex
CREATE UNIQUE INDEX "uq_wx_bill_file_mchid_bill_date_bill_type" ON "wx_bill_file"("mchid", "bill_date", "bill_type");

-- CreateIndex
CREATE INDEX "ix_wx_bill_line_out_trade_no" ON "wx_bill_line"("out_trade_no");

-- CreateIndex
CREATE INDEX "ix_wx_bill_line_out_refund_no" ON "wx_bill_line"("out_refund_no");

-- CreateIndex
CREATE INDEX "ix_wx_bill_line_bill_date_match" ON "wx_bill_line"("bill_date", "match_state");

-- CreateIndex
CREATE INDEX "ix_wx_bill_line_matched_payment_txn_id" ON "wx_bill_line"("matched_payment_txn_id");

-- CreateIndex
CREATE INDEX "ix_wx_bill_line_matched_refund_txn_id" ON "wx_bill_line"("matched_refund_txn_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_wx_bill_line_file_line_no" ON "wx_bill_line"("wx_bill_file_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_recon_day_bill_date_channel" ON "recon_day"("bill_date", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "uq_invoice_request_request_no" ON "invoice_request"("request_no");

-- CreateIndex
CREATE INDEX "ix_invoice_request_status_applied" ON "invoice_request"("status", "applied_at");

-- CreateIndex
CREATE INDEX "ix_invoice_request_entity_applied" ON "invoice_request"("entity_id", "applied_at" DESC);

-- CreateIndex
CREATE INDEX "ix_invoice_request_billing_order_id" ON "invoice_request"("billing_order_id");

-- CreateIndex
CREATE INDEX "ix_invoice_request_held_by_refund_request_id" ON "invoice_request"("held_by_refund_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_invoice_doc_original_invoice_doc_id" ON "invoice_doc"("original_invoice_doc_id");

-- CreateIndex
CREATE INDEX "ix_invoice_doc_entity_issued" ON "invoice_doc"("entity_id", "issued_at");

-- CreateIndex
CREATE INDEX "ix_invoice_doc_issued_at" ON "invoice_doc"("issued_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_invoice_doc_request_kind" ON "invoice_doc"("invoice_request_id", "doc_kind");

-- CreateIndex
CREATE UNIQUE INDEX "uq_finance_config_revision_approval_request_id" ON "finance_config_revision"("approval_request_id");

-- CreateIndex
CREATE INDEX "ix_cart_item_store_id_created_at" ON "cart_item"("store_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_cart_item_store_id_drama_id" ON "cart_item"("store_id", "drama_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_drama_order_order_no" ON "drama_order"("order_no");

-- CreateIndex
CREATE INDEX "ix_drama_order_store_id_submitted_at" ON "drama_order"("store_id", "submitted_at" DESC);

-- CreateIndex
CREATE INDEX "ix_drama_order_entity_id_submitted_at" ON "drama_order"("entity_id", "submitted_at" DESC);

-- CreateIndex
CREATE INDEX "ix_drama_order_status_submitted_at" ON "drama_order"("status", "submitted_at" DESC);

-- CreateIndex
CREATE INDEX "ix_drama_order_delivery_manager_id_status" ON "drama_order"("delivery_manager_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_order_item_point_hold_id" ON "order_item"("point_hold_id");

-- CreateIndex
CREATE INDEX "ix_order_item_store_id_phase" ON "order_item"("store_id", "phase");

-- CreateIndex
CREATE INDEX "ix_order_item_drama_id_phase" ON "order_item"("drama_id", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "uq_order_item_drama_order_id_item_no" ON "order_item"("drama_order_id", "item_no");

-- CreateIndex
CREATE INDEX "ix_order_item_account_channel_account_id" ON "order_item_account"("channel_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_order_item_account_order_item_id_platform" ON "order_item_account"("order_item_id", "platform");

-- CreateIndex
CREATE INDEX "ix_order_item_placement_ad_id" ON "order_item_placement"("ad_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_order_item_placement_order_item_id_slot" ON "order_item_placement"("order_item_id", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cancel_request_approval_request_id" ON "cancel_request"("approval_request_id");

-- CreateIndex
CREATE INDEX "ix_cancel_request_store_id_created_at" ON "cancel_request"("store_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_cancel_request_entity_id_created_at" ON "cancel_request"("entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_cancel_request_status_exec_due_at" ON "cancel_request"("status", "exec_due_at");

-- CreateIndex
CREATE INDEX "ix_cancel_request_drama_order_id" ON "cancel_request"("drama_order_id");

-- CreateIndex
CREATE INDEX "ix_cancel_request_ad_id" ON "cancel_request"("ad_id");

-- CreateIndex
CREATE INDEX "ix_cancel_request_line_target_type_target_id" ON "cancel_request_line"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "ix_cancel_request_line_point_hold_id" ON "cancel_request_line"("point_hold_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cancel_request_line_cancel_request_id_target" ON "cancel_request_line"("cancel_request_id", "target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ad_ad_no" ON "ad"("ad_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ad_point_hold_id" ON "ad"("point_hold_id");

-- CreateIndex
CREATE INDEX "ix_ad_store_id_status" ON "ad"("store_id", "status");

-- CreateIndex
CREATE INDEX "ix_ad_editor_id_status" ON "ad"("editor_id", "status");

-- CreateIndex
CREATE INDEX "ix_ad_status_due_at" ON "ad"("status", "due_at");

-- CreateIndex
CREATE INDEX "ix_ad_entity_id" ON "ad"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ad_version_ad_id_version_no" ON "ad_version"("ad_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ad_revision_charge_point_hold_id" ON "ad_revision"("charge_point_hold_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ad_revision_ad_id_revision_no" ON "ad_revision"("ad_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_delivery_ticket_ticket_no" ON "delivery_ticket"("ticket_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_delivery_ticket_order_item_id" ON "delivery_ticket"("order_item_id");

-- CreateIndex
CREATE INDEX "ix_delivery_ticket_delivery_manager_id_step" ON "delivery_ticket"("delivery_manager_id", "step");

-- CreateIndex
CREATE INDEX "ix_delivery_ticket_editor_id_step" ON "delivery_ticket"("editor_id", "step");

-- CreateIndex
CREATE INDEX "ix_delivery_ticket_publisher_id_step" ON "delivery_ticket"("publisher_id", "step");

-- CreateIndex
CREATE INDEX "ix_delivery_ticket_store_id" ON "delivery_ticket"("store_id");

-- CreateIndex
CREATE INDEX "ix_delivery_ticket_entity_id" ON "delivery_ticket"("entity_id");

-- CreateIndex
CREATE INDEX "ix_delivery_ticket_drama_order_id" ON "delivery_ticket"("drama_order_id");

-- CreateIndex
CREATE INDEX "ix_delivery_ticket_drama_id" ON "delivery_ticket"("drama_id");

-- CreateIndex
CREATE INDEX "ix_delivery_ticket_stage_step_entered_at" ON "delivery_ticket_stage"("step", "entered_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_delivery_ticket_stage_delivery_ticket_id_step_visit_no" ON "delivery_ticket_stage"("delivery_ticket_id", "step", "visit_no");

-- CreateIndex
CREATE INDEX "ix_delivery_ticket_pause_ref_type_ref_id" ON "delivery_ticket_pause"("ref_type", "ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_delivery_ticket_pause_delivery_ticket_id_reason_ref_id" ON "delivery_ticket_pause"("delivery_ticket_id", "reason", "ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_delivery_plan_drama_order_id" ON "delivery_plan"("drama_order_id");

-- CreateIndex
CREATE INDEX "ix_delivery_plan_store_id" ON "delivery_plan"("store_id");

-- CreateIndex
CREATE INDEX "ix_delivery_plan_entity_id" ON "delivery_plan"("entity_id");

-- CreateIndex
CREATE INDEX "ix_delivery_plan_status_staff_due_at" ON "delivery_plan"("status", "staff_due_at");

-- CreateIndex
CREATE INDEX "ix_delivery_plan_version_store_id" ON "delivery_plan_version"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_delivery_plan_version_delivery_plan_id_version_no" ON "delivery_plan_version"("delivery_plan_id", "version_no");

-- CreateIndex
CREATE INDEX "ix_delivery_plan_change_request_delivery_plan_id_created_at" ON "delivery_plan_change_request"("delivery_plan_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_delivery_plan_change_request_store_id" ON "delivery_plan_change_request"("store_id");

-- CreateIndex
CREATE INDEX "ix_sample_store_id" ON "sample"("store_id");

-- CreateIndex
CREATE INDEX "ix_sample_file_id" ON "sample"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sample_delivery_ticket_id_version_no" ON "sample"("delivery_ticket_id", "version_no");

-- CreateIndex
CREATE INDEX "ix_episode_output_store_id" ON "episode_output"("store_id");

-- CreateIndex
CREATE INDEX "ix_episode_output_file_id" ON "episode_output"("file_id");

-- CreateIndex
CREATE INDEX "ix_episode_output_delivery_reissue_id" ON "episode_output"("delivery_reissue_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_episode_output_ticket_episode_variant_revision" ON "episode_output"("delivery_ticket_id", "episode_no", "variant", "revision_no");

-- CreateIndex
CREATE INDEX "ix_qc_record_delivery_ticket_id_target_type" ON "qc_record"("delivery_ticket_id", "target_type");

-- CreateIndex
CREATE INDEX "ix_qc_record_target_type_target_id" ON "qc_record"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "ix_qc_record_store_id" ON "qc_record"("store_id");

-- CreateIndex
CREATE INDEX "ix_delivery_release_delivery_ticket_id" ON "delivery_release"("delivery_ticket_id");

-- CreateIndex
CREATE INDEX "ix_delivery_release_store_id" ON "delivery_release"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_delivery_release_order_item_id_release_no" ON "delivery_release"("order_item_id", "release_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_delivery_release_order_item_id_idempotency_key" ON "delivery_release"("order_item_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "ix_delivery_reissue_delivery_ticket_id_opened_at" ON "delivery_reissue"("delivery_ticket_id", "opened_at");

-- CreateIndex
CREATE INDEX "ix_delivery_reissue_store_id" ON "delivery_reissue"("store_id");

-- CreateIndex
CREATE INDEX "ix_download_grant_order_item_id_created_at" ON "download_grant"("order_item_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_download_grant_delivery_release_id" ON "download_grant"("delivery_release_id");

-- CreateIndex
CREATE INDEX "ix_download_grant_store_id" ON "download_grant"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_delivery_download_log_seq" ON "delivery_download_log"("seq");

-- CreateIndex
CREATE INDEX "ix_delivery_download_log_order_item_id_episode_no_created_at" ON "delivery_download_log"("order_item_id", "episode_no", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_delivery_download_log_store_id_created_at" ON "delivery_download_log"("store_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_publish_list_delivery_ticket_id" ON "publish_list"("delivery_ticket_id");

-- CreateIndex
CREATE INDEX "ix_publish_list_store_id" ON "publish_list"("store_id");

-- CreateIndex
CREATE INDEX "ix_channel_account_store_id_status" ON "channel_account"("store_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_channel_account_submission_approval_request_id" ON "channel_account_submission"("approval_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_channel_account_submission_channel_account_id_round_no" ON "channel_account_submission"("channel_account_id", "round_no");

-- CreateIndex
CREATE INDEX "ix_launch_task_review_status" ON "launch_task"("review_status");

-- CreateIndex
CREATE INDEX "ix_launch_task_channel_account_id" ON "launch_task"("channel_account_id");

-- CreateIndex
CREATE INDEX "ix_launch_task_store_id_review_status" ON "launch_task"("store_id", "review_status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_launch_task_order_item_id_channel_account_id" ON "launch_task"("order_item_id", "channel_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_launch_submission_approval_request_id" ON "launch_submission"("approval_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_launch_submission_reopen_of_launch_submission_id" ON "launch_submission"("reopen_of_launch_submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_launch_submission_launch_task_id_round_no" ON "launch_submission"("launch_task_id", "round_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_patrol_batch_week_start_date" ON "patrol_batch"("week_start_date");

-- CreateIndex
CREATE INDEX "ix_patrol_task_patrol_batch_id_launch_task_id" ON "patrol_task"("patrol_batch_id", "launch_task_id");

-- CreateIndex
CREATE INDEX "ix_patrol_task_status_delivery_ticket_id" ON "patrol_task"("status", "delivery_ticket_id");

-- CreateIndex
CREATE INDEX "ix_patrol_task_launch_task_id" ON "patrol_task"("launch_task_id");

-- CreateIndex
CREATE INDEX "ix_takedown_task_status_due_date" ON "takedown_task"("status", "due_date");

-- CreateIndex
CREATE INDEX "ix_takedown_task_store_id_status" ON "takedown_task"("store_id", "status");

-- CreateIndex
CREATE INDEX "ix_takedown_task_launch_task_id" ON "takedown_task"("launch_task_id");

-- CreateIndex
CREATE INDEX "ix_takedown_task_channel_account_id_status" ON "takedown_task"("channel_account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_service_ticket_ticket_no" ON "service_ticket"("ticket_no");

-- CreateIndex
CREATE INDEX "ix_service_ticket_store_id_created_at" ON "service_ticket"("store_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_service_ticket_owner_staff_id_status" ON "service_ticket"("owner_staff_id", "status");

-- CreateIndex
CREATE INDEX "ix_service_ticket_status_created_at" ON "service_ticket"("status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_service_ticket_id_entity_id_store_id" ON "service_ticket"("id", "entity_id", "store_id");

-- CreateIndex
CREATE INDEX "ix_service_ticket_entry_service_ticket_id_created_at" ON "service_ticket_entry"("service_ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_service_ticket_ref_ref_type_ref_id" ON "service_ticket_ref"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "ix_notify_scene_wx_template_slot_key" ON "notify_scene"("wx_template_slot_key");

-- CreateIndex
CREATE INDEX "ix_notify_scene_sms_template_key" ON "notify_scene"("sms_template_key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_notification_dedupe_key" ON "notification"("dedupe_key");

-- CreateIndex
CREATE INDEX "ix_notification_notify_scene_key_created_at" ON "notification"("notify_scene_key", "created_at");

-- CreateIndex
CREATE INDEX "ix_notification_biz_type_biz_id" ON "notification"("biz_type", "biz_id");

-- CreateIndex
CREATE INDEX "ix_notification_merchant_user_id_created_at" ON "notification"("merchant_user_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_notification_staff_id_created_at" ON "notification"("staff_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_notification_entity_id" ON "notification"("entity_id");

-- CreateIndex
CREATE INDEX "ix_notification_store_id" ON "notification"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_notification_delivery_direct_key" ON "notification_delivery"("direct_key");

-- CreateIndex
CREATE INDEX "ix_notification_delivery_channel_created_at" ON "notification_delivery"("channel", "created_at");

-- CreateIndex
CREATE INDEX "ix_notification_delivery_target_ref_channel_created_at" ON "notification_delivery"("target_ref", "channel", "created_at");

-- CreateIndex
CREATE INDEX "ix_notification_delivery_sms_template_key_created_at" ON "notification_delivery"("sms_template_key", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_notification_delivery_notification_channel_resend" ON "notification_delivery"("notification_id", "channel", "resend_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_merchant_message_notification_id" ON "merchant_message"("notification_id");

-- CreateIndex
CREATE INDEX "ix_merchant_message_merchant_user_id_entity_id_id" ON "merchant_message"("merchant_user_id", "entity_id", "id" DESC);

-- CreateIndex
CREATE INDEX "ix_merchant_message_entity_id" ON "merchant_message"("entity_id");

-- CreateIndex
CREATE INDEX "ix_merchant_message_store_id" ON "merchant_message"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_staff_message_notification_id" ON "staff_message"("notification_id");

-- CreateIndex
CREATE INDEX "ix_staff_message_staff_id_id" ON "staff_message"("staff_id", "id" DESC);

-- CreateIndex
CREATE INDEX "ix_wx_subscribe_quota_merchant_user_id_slot" ON "wx_subscribe_quota"("merchant_user_id", "wx_template_slot_key");

-- CreateIndex
CREATE INDEX "ix_wx_subscribe_quota_wx_template_slot_key" ON "wx_subscribe_quota"("wx_template_slot_key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_manual_reminder_log_seq" ON "manual_reminder_log"("seq");

-- CreateIndex
CREATE INDEX "ix_manual_reminder_log_sent_by_staff_id_created_at" ON "manual_reminder_log"("sent_by_staff_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_manual_reminder_log_subject_scene_biz_date" ON "manual_reminder_log"("subject_type", "subject_id", "scene", "biz_date");

-- CreateIndex
CREATE INDEX "ix_agreement_version_agreement_key_effective_at" ON "agreement_version"("agreement_key", "effective_at" DESC);

-- CreateIndex
CREATE INDEX "ix_agreement_version_pdf_file_id" ON "agreement_version"("pdf_file_id");

-- CreateIndex
CREATE INDEX "ix_agreement_version_source_file_id" ON "agreement_version"("source_file_id");

-- CreateIndex
CREATE INDEX "ix_agreement_version_site_notice_id" ON "agreement_version"("site_notice_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_agreement_version_id_agreement_key" ON "agreement_version"("id", "agreement_key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_agreement_consent_seq" ON "agreement_consent"("seq");

-- CreateIndex
CREATE INDEX "ix_agreement_consent_agreement_version_id" ON "agreement_consent"("agreement_version_id");

-- CreateIndex
CREATE INDEX "ix_agreement_consent_merchant_user_id_agreement_key" ON "agreement_consent"("merchant_user_id", "agreement_key", "consented_at");

-- CreateIndex
CREATE INDEX "ix_agreement_consent_entity_id_agreement_key" ON "agreement_consent"("entity_id", "agreement_key", "consented_at");

-- CreateIndex
CREATE INDEX "ix_agreement_consent_biz_type_biz_id" ON "agreement_consent"("biz_type", "biz_id");

-- CreateIndex
CREATE INDEX "ix_agreement_consent_consented_at" ON "agreement_consent"("consented_at");

-- CreateIndex
CREATE INDEX "ix_agreement_consent_store_id" ON "agreement_consent"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_license_letter_letter_no" ON "license_letter"("letter_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_license_letter_current_revision_id" ON "license_letter"("current_revision_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_license_letter_verify_code" ON "license_letter"("verify_code");

-- CreateIndex
CREATE INDEX "ix_license_letter_entity_id_created_at" ON "license_letter"("entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_license_letter_store_id" ON "license_letter"("store_id");

-- CreateIndex
CREATE INDEX "ix_license_letter_order_item_id" ON "license_letter"("order_item_id");

-- CreateIndex
CREATE INDEX "ix_license_letter_drama_order_id" ON "license_letter"("drama_order_id");

-- CreateIndex
CREATE INDEX "ix_license_letter_drama_id" ON "license_letter"("drama_id");

-- CreateIndex
CREATE INDEX "ix_license_letter_revision_file_id" ON "license_letter_revision"("file_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_license_letter_revision_license_letter_id_rev_no" ON "license_letter_revision"("license_letter_id", "rev_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_license_letter_revision_id_license_letter_id" ON "license_letter_revision"("id", "license_letter_id");

-- CreateIndex
CREATE INDEX "ix_dict_item_dict_type_key_parent_code_position" ON "dict_item"("dict_type_key", "parent_code", "position");

-- CreateIndex
CREATE UNIQUE INDEX "uq_dict_item_dict_type_key_code" ON "dict_item"("dict_type_key", "code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_param_value_seq" ON "param_value"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "uq_site_config_revision_config_key_rev_no" ON "site_config_revision"("config_key", "rev_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_checklist_template_code_version_no" ON "checklist_template"("code", "version_no");

-- CreateIndex
CREATE INDEX "ix_analytics_event_name_occurred_at" ON "analytics_event"("name", "occurred_at");

-- CreateIndex
CREATE INDEX "ix_analytics_event_dedup_received_at" ON "analytics_event_dedup"("received_at");

-- CreateIndex
CREATE INDEX "ix_analytics_identity_merchant_user_id" ON "analytics_identity"("merchant_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_report_month_close_report_key_month_date_revision_no" ON "report_month_close"("report_key", "month_date", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_export_job_job_no" ON "export_job"("job_no");

-- CreateIndex
CREATE INDEX "ix_export_job_requested_by_staff_id_created_at" ON "export_job"("requested_by_staff_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ix_export_job_file_id" ON "export_job"("file_id");

-- CreateIndex
CREATE INDEX "ix_webhook_event_provider_received_at" ON "webhook_event"("provider", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_webhook_event_provider_event_id" ON "webhook_event"("provider", "event_id");

-- CreateIndex
CREATE INDEX "ix_alert_event_resolved_at" ON "alert_event"("resolved_at");

-- CreateIndex
CREATE INDEX "ix_alert_event_severity_last_seen_at" ON "alert_event"("severity", "last_seen_at");

-- CreateIndex
CREATE INDEX "ix_alert_event_acked_by_staff_id" ON "alert_event"("acked_by_staff_id");

-- CreateIndex
CREATE INDEX "ix_invariant_run_mode_started_at" ON "invariant_run"("mode", "started_at");

-- CreateIndex
CREATE INDEX "ix_invariant_violation_invariant_run_id" ON "invariant_violation"("invariant_run_id");

-- CreateIndex
CREATE INDEX "ix_invariant_violation_subject" ON "invariant_violation"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "ix_invariant_violation_resolved_by_staff_id" ON "invariant_violation"("resolved_by_staff_id");

-- AddForeignKey
ALTER TABLE "outbox_delivery" ADD CONSTRAINT "fk_outbox_delivery_outbox_event_id" FOREIGN KEY ("outbox_event_id") REFERENCES "outbox_event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_user" ADD CONSTRAINT "fk_merchant_user_source_referral_code_id" FOREIGN KEY ("source_referral_code_id") REFERENCES "referral_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wechat_identity" ADD CONSTRAINT "fk_wechat_identity_merchant_user_id" FOREIGN KEY ("merchant_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_session" ADD CONSTRAINT "fk_user_session_merchant_user_id" FOREIGN KEY ("merchant_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_session" ADD CONSTRAINT "fk_user_session_wechat_identity_id" FOREIGN KEY ("wechat_identity_id") REFERENCES "wechat_identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_session" ADD CONSTRAINT "fk_portal_session_approved_by_user_id" FOREIGN KEY ("approved_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_session" ADD CONSTRAINT "fk_portal_session_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_session" ADD CONSTRAINT "fk_portal_session_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_user_notice" ADD CONSTRAINT "fk_merchant_user_notice_merchant_user_id" FOREIGN KEY ("merchant_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sms_verification" ADD CONSTRAINT "fk_sms_verification_merchant_user_id" FOREIGN KEY ("merchant_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wecom_contact" ADD CONSTRAINT "fk_wecom_contact_merchant_user_id" FOREIGN KEY ("merchant_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wecom_contact" ADD CONSTRAINT "fk_wecom_contact_staff_id" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_change_request" ADD CONSTRAINT "fk_account_change_request_approval_request_id" FOREIGN KEY ("approval_request_id") REFERENCES "approval_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_change_request" ADD CONSTRAINT "fk_account_change_request_merchant_user_id" FOREIGN KEY ("merchant_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_change_request" ADD CONSTRAINT "fk_account_change_request_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity" ADD CONSTRAINT "fk_entity_created_by_user_id" FOREIGN KEY ("created_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity" ADD CONSTRAINT "fk_entity_source_referral_code_id" FOREIGN KEY ("source_referral_code_id") REFERENCES "referral_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store" ADD CONSTRAINT "fk_store_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store" ADD CONSTRAINT "fk_store_delivery_manager_id" FOREIGN KEY ("delivery_manager_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_member" ADD CONSTRAINT "fk_entity_member_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_member" ADD CONSTRAINT "fk_entity_member_merchant_user_id" FOREIGN KEY ("merchant_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_member" ADD CONSTRAINT "fk_entity_member_last_store_entity" FOREIGN KEY ("last_store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_member" ADD CONSTRAINT "fk_entity_member_invitation_id" FOREIGN KEY ("invitation_id") REFERENCES "invitation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_member" ADD CONSTRAINT "fk_entity_member_invited_by_member_entity" FOREIGN KEY ("invited_by_member_id", "entity_id") REFERENCES "entity_member"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_member" ADD CONSTRAINT "fk_store_member_entity_member_entity" FOREIGN KEY ("entity_member_id", "entity_id") REFERENCES "entity_member"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_member" ADD CONSTRAINT "fk_store_member_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_member" ADD CONSTRAINT "fk_store_member_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_member" ADD CONSTRAINT "fk_store_member_added_by_member_entity" FOREIGN KEY ("added_by_member_id", "entity_id") REFERENCES "entity_member"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "fk_invitation_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "fk_invitation_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "fk_invitation_inviter_member_entity" FOREIGN KEY ("inviter_member_id", "entity_id") REFERENCES "entity_member"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "fk_invitation_accepted_by_user_id" FOREIGN KEY ("accepted_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "fk_invitation_accepted_member_entity" FOREIGN KEY ("accepted_member_id", "entity_id") REFERENCES "entity_member"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_code" ADD CONSTRAINT "fk_referral_code_owner_staff_id" FOREIGN KEY ("owner_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_ticket" ADD CONSTRAINT "fk_portal_ticket_approved_by_user_id" FOREIGN KEY ("approved_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_ticket" ADD CONSTRAINT "fk_portal_ticket_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_ticket" ADD CONSTRAINT "fk_portal_ticket_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_role" ADD CONSTRAINT "fk_staff_role_updated_by_staff_id" FOREIGN KEY ("updated_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_group" ADD CONSTRAINT "fk_staff_group_staff_role_key" FOREIGN KEY ("staff_role_key") REFERENCES "staff_role"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "fk_staff_staff_role_key" FOREIGN KEY ("staff_role_key") REFERENCES "staff_role"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "fk_staff_staff_group_id" FOREIGN KEY ("staff_group_id") REFERENCES "staff_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "fk_staff_wecom_qr_file_id" FOREIGN KEY ("wecom_qr_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "fk_staff_disabled_by_staff_id" FOREIGN KEY ("disabled_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "fk_staff_handover_to_staff_id" FOREIGN KEY ("handover_to_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "fk_staff_created_by_staff_id" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_activation" ADD CONSTRAINT "fk_staff_activation_staff_id" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_activation" ADD CONSTRAINT "fk_staff_activation_created_by_staff_id" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_session" ADD CONSTRAINT "fk_staff_session_staff_id" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_pool_member" ADD CONSTRAINT "fk_assignment_pool_member_staff_id" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_cursor" ADD CONSTRAINT "fk_assignment_cursor_last_staff_id" FOREIGN KEY ("last_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_history" ADD CONSTRAINT "fk_assignment_history_from_staff_id" FOREIGN KEY ("from_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_history" ADD CONSTRAINT "fk_assignment_history_to_staff_id" FOREIGN KEY ("to_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_history" ADD CONSTRAINT "fk_assignment_history_contacted_by_staff_id" FOREIGN KEY ("contacted_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up" ADD CONSTRAINT "fk_follow_up_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up" ADD CONSTRAINT "fk_follow_up_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up" ADD CONSTRAINT "fk_follow_up_owner_staff_id" FOREIGN KEY ("owner_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "fk_approval_request_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "fk_approval_request_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "fk_approval_request_requester_staff_id" FOREIGN KEY ("requester_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "fk_approval_request_requester_staff_group_id" FOREIGN KEY ("requester_staff_group_id") REFERENCES "staff_group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "fk_approval_request_decided_by_staff_id" FOREIGN KEY ("decided_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_profile" ADD CONSTRAINT "fk_store_profile_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_profile" ADD CONSTRAINT "fk_store_profile_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_profile" ADD CONSTRAINT "fk_store_profile_logo_file_id" FOREIGN KEY ("logo_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_profile" ADD CONSTRAINT "fk_store_profile_copied_from_store_entity" FOREIGN KEY ("copied_from_store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_profile" ADD CONSTRAINT "fk_store_profile_effective_qualification_submission_id" FOREIGN KEY ("effective_qualification_submission_id", "store_id", "entity_id") REFERENCES "qualification_submission"("id", "store_id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_profile_media" ADD CONSTRAINT "fk_store_profile_media_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_profile_media" ADD CONSTRAINT "fk_store_profile_media_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_profile_media" ADD CONSTRAINT "fk_store_profile_media_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_profile_media" ADD CONSTRAINT "fk_store_profile_media_copied_from_store_entity" FOREIGN KEY ("copied_from_store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_service_item" ADD CONSTRAINT "fk_store_service_item_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_service_item" ADD CONSTRAINT "fk_store_service_item_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_service_item" ADD CONSTRAINT "fk_store_service_item_image_file_id" FOREIGN KEY ("image_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_submission" ADD CONSTRAINT "fk_qualification_submission_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_submission" ADD CONSTRAINT "fk_qualification_submission_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_submission" ADD CONSTRAINT "fk_qualification_submission_resubmit_of" FOREIGN KEY ("resubmit_of_qualification_submission_id") REFERENCES "qualification_submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_submission" ADD CONSTRAINT "fk_qualification_submission_approval_request_id" FOREIGN KEY ("approval_request_id") REFERENCES "approval_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_submission" ADD CONSTRAINT "fk_qualification_submission_submitted_by_user_id" FOREIGN KEY ("submitted_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_submission" ADD CONSTRAINT "fk_qualification_submission_created_by_user_id" FOREIGN KEY ("created_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_doc" ADD CONSTRAINT "fk_qualification_doc_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_doc" ADD CONSTRAINT "fk_qualification_doc_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_doc" ADD CONSTRAINT "fk_qualification_doc_qualification_submission_id" FOREIGN KEY ("qualification_submission_id", "store_id", "entity_id") REFERENCES "qualification_submission"("id", "store_id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_doc" ADD CONSTRAINT "fk_qualification_doc_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_doc" ADD CONSTRAINT "fk_qualification_doc_ocr_result_id" FOREIGN KEY ("ocr_result_id") REFERENCES "ocr_result"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_doc" ADD CONSTRAINT "fk_qualification_doc_carried_from_qualification_doc_id" FOREIGN KEY ("carried_from_qualification_doc_id") REFERENCES "qualification_doc"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qualification_doc" ADD CONSTRAINT "fk_qualification_doc_uploaded_by_user_id" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama" ADD CONSTRAINT "fk_drama_poster_file_id" FOREIGN KEY ("poster_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama" ADD CONSTRAINT "fk_drama_created_by_staff_id" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama" ADD CONSTRAINT "fk_drama_updated_by_staff_id" FOREIGN KEY ("updated_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_episode" ADD CONSTRAINT "fk_drama_episode_drama_id" FOREIGN KEY ("drama_id") REFERENCES "drama"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_permit" ADD CONSTRAINT "fk_drama_permit_drama_id" FOREIGN KEY ("drama_id") REFERENCES "drama"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_permit" ADD CONSTRAINT "fk_drama_permit_created_by_staff_id" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_copyright" ADD CONSTRAINT "fk_drama_copyright_drama_id" FOREIGN KEY ("drama_id") REFERENCES "drama"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_copyright" ADD CONSTRAINT "fk_drama_copyright_current_drama_copyright_revision_id" FOREIGN KEY ("current_drama_copyright_revision_id", "drama_id") REFERENCES "drama_copyright_revision"("id", "drama_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_copyright_revision" ADD CONSTRAINT "fk_drama_copyright_revision_drama_id" FOREIGN KEY ("drama_id") REFERENCES "drama"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_copyright_revision" ADD CONSTRAINT "fk_drama_copyright_revision_created_by_staff_id" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_stat" ADD CONSTRAINT "fk_drama_stat_drama_id" FOREIGN KEY ("drama_id") REFERENCES "drama"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_object" ADD CONSTRAINT "fk_file_object_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_object" ADD CONSTRAINT "fk_file_object_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_object" ADD CONSTRAINT "fk_file_object_on_behalf_store_id" FOREIGN KEY ("on_behalf_store_id") REFERENCES "store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_object" ADD CONSTRAINT "fk_file_object_upload_batch_id" FOREIGN KEY ("upload_batch_id") REFERENCES "upload_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_ref" ADD CONSTRAINT "fk_file_ref_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_purge_run" ADD CONSTRAINT "fk_file_purge_run_decided_by_staff_id" FOREIGN KEY ("decided_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_info" ADD CONSTRAINT "fk_media_info_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_info" ADD CONSTRAINT "fk_media_info_cover_file_id" FOREIGN KEY ("cover_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_check" ADD CONSTRAINT "fk_media_check_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_batch" ADD CONSTRAINT "fk_upload_batch_created_by_staff_id" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_batch_item" ADD CONSTRAINT "fk_upload_batch_item_upload_batch_id" FOREIGN KEY ("upload_batch_id") REFERENCES "upload_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_batch_item" ADD CONSTRAINT "fk_upload_batch_item_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_record" ADD CONSTRAINT "fk_production_record_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_record" ADD CONSTRAINT "fk_production_record_derived_from_file_id" FOREIGN KEY ("derived_from_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_record" ADD CONSTRAINT "fk_production_record_drama_episode_master_id" FOREIGN KEY ("drama_episode_master_id") REFERENCES "drama_episode_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_record" ADD CONSTRAINT "fk_production_record_uploaded_by_staff_id" FOREIGN KEY ("uploaded_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_checkout" ADD CONSTRAINT "fk_master_checkout_staff_id" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "master_checkout" ADD CONSTRAINT "fk_master_checkout_drama_episode_master_id" FOREIGN KEY ("drama_episode_master_id") REFERENCES "drama_episode_master"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playable_asset" ADD CONSTRAINT "fk_playable_asset_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playable_asset" ADD CONSTRAINT "fk_playable_asset_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playable_asset" ADD CONSTRAINT "fk_playable_asset_source_file_id" FOREIGN KEY ("source_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playable_asset" ADD CONSTRAINT "fk_playable_asset_cover_file_id" FOREIGN KEY ("cover_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zip_bundle" ADD CONSTRAINT "fk_zip_bundle_zip_file_id" FOREIGN KEY ("zip_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zip_bundle" ADD CONSTRAINT "fk_zip_bundle_publish_list_file_id" FOREIGN KEY ("publish_list_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_trailer" ADD CONSTRAINT "fk_drama_trailer_drama_id" FOREIGN KEY ("drama_id") REFERENCES "drama"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_trailer" ADD CONSTRAINT "fk_drama_trailer_target_playable_asset_id" FOREIGN KEY ("target_playable_asset_id") REFERENCES "playable_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_trailer" ADD CONSTRAINT "fk_drama_trailer_current_playable_asset_id" FOREIGN KEY ("current_playable_asset_id") REFERENCES "playable_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_trailer" ADD CONSTRAINT "fk_drama_trailer_set_by_staff_id" FOREIGN KEY ("set_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_episode_master" ADD CONSTRAINT "fk_drama_episode_master_drama_id" FOREIGN KEY ("drama_id") REFERENCES "drama"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_episode_master" ADD CONSTRAINT "fk_drama_episode_master_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_episode_master" ADD CONSTRAINT "fk_drama_episode_master_mezzanine_file_id" FOREIGN KEY ("mezzanine_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_episode_master" ADD CONSTRAINT "fk_drama_episode_master_upload_batch_id" FOREIGN KEY ("upload_batch_id") REFERENCES "upload_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_episode_master" ADD CONSTRAINT "fk_drama_episode_master_created_by_staff_id" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset" ADD CONSTRAINT "fk_store_asset_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset" ADD CONSTRAINT "fk_store_asset_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset" ADD CONSTRAINT "fk_store_asset_store_asset_demand_id" FOREIGN KEY ("store_asset_demand_id", "store_id") REFERENCES "store_asset_demand"("id", "store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset" ADD CONSTRAINT "fk_store_asset_source_store_asset_id" FOREIGN KEY ("source_store_asset_id", "entity_id") REFERENCES "store_asset"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset" ADD CONSTRAINT "fk_store_asset_reviewed_by_staff_id" FOREIGN KEY ("reviewed_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset_file" ADD CONSTRAINT "fk_store_asset_file_store_asset_id" FOREIGN KEY ("store_asset_id") REFERENCES "store_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset_file" ADD CONSTRAINT "fk_store_asset_file_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset_insight" ADD CONSTRAINT "fk_store_asset_insight_store_asset_id" FOREIGN KEY ("store_asset_id") REFERENCES "store_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset_insight" ADD CONSTRAINT "fk_store_asset_insight_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset_insight" ADD CONSTRAINT "fk_store_asset_insight_reused_from_store_asset_insight_id" FOREIGN KEY ("reused_from_store_asset_insight_id") REFERENCES "store_asset_insight"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset_insight" ADD CONSTRAINT "fk_store_asset_insight_media_job_id" FOREIGN KEY ("media_job_id") REFERENCES "media_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset_tag" ADD CONSTRAINT "fk_store_asset_tag_store_asset_id" FOREIGN KEY ("store_asset_id") REFERENCES "store_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset_usage" ADD CONSTRAINT "fk_store_asset_usage_store_asset_id" FOREIGN KEY ("store_asset_id") REFERENCES "store_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset_demand" ADD CONSTRAINT "fk_store_asset_demand_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset_demand" ADD CONSTRAINT "fk_store_asset_demand_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_asset_demand" ADD CONSTRAINT "fk_store_asset_demand_created_by_staff_id" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_result" ADD CONSTRAINT "fk_ocr_result_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_result" ADD CONSTRAINT "fk_ocr_result_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_result" ADD CONSTRAINT "fk_ocr_result_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_revision" ADD CONSTRAINT "fk_plan_revision_plan_id" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_revision" ADD CONSTRAINT "fk_plan_revision_site_notice_id" FOREIGN KEY ("site_notice_id") REFERENCES "site_notice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_revision" ADD CONSTRAINT "fk_plan_revision_created_by_staff_id" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_promo_claim" ADD CONSTRAINT "fk_plan_promo_claim_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_promo_claim" ADD CONSTRAINT "fk_plan_promo_claim_plan_revision_id" FOREIGN KEY ("plan_revision_id") REFERENCES "plan_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_promo_claim" ADD CONSTRAINT "fk_plan_promo_claim_billing_order_id" FOREIGN KEY ("billing_order_id") REFERENCES "billing_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_tier_revision" ADD CONSTRAINT "fk_price_tier_revision_created_by_staff_id" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_price_revision" ADD CONSTRAINT "fk_drama_price_revision_drama_id" FOREIGN KEY ("drama_id") REFERENCES "drama"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_price_revision" ADD CONSTRAINT "fk_drama_price_revision_created_by_staff_id" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_param" ADD CONSTRAINT "fk_billing_param_site_notice_id" FOREIGN KEY ("site_notice_id") REFERENCES "site_notice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_param" ADD CONSTRAINT "fk_billing_param_created_by_staff_id" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_account" ADD CONSTRAINT "fk_billing_account_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_account" ADD CONSTRAINT "fk_billing_account_current_subscription_term_id" FOREIGN KEY ("current_subscription_term_id") REFERENCES "subscription_term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_term" ADD CONSTRAINT "fk_subscription_term_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_term" ADD CONSTRAINT "fk_subscription_term_plan_id" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_term" ADD CONSTRAINT "fk_subscription_term_plan_revision_id" FOREIGN KEY ("plan_revision_id") REFERENCES "plan_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_term" ADD CONSTRAINT "fk_subscription_term_initial_plan_revision_id" FOREIGN KEY ("initial_plan_revision_id") REFERENCES "plan_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_term" ADD CONSTRAINT "fk_subscription_term_refund_request_id" FOREIGN KEY ("refund_request_id") REFERENCES "refund_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_term" ADD CONSTRAINT "fk_subscription_term_source_billing_order_id" FOREIGN KEY ("source_billing_order_id") REFERENCES "billing_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_event" ADD CONSTRAINT "fk_subscription_event_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_event" ADD CONSTRAINT "fk_subscription_event_subscription_term_id" FOREIGN KEY ("subscription_term_id") REFERENCES "subscription_term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_event" ADD CONSTRAINT "fk_subscription_event_from_plan_id" FOREIGN KEY ("from_plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_event" ADD CONSTRAINT "fk_subscription_event_to_plan_id" FOREIGN KEY ("to_plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_event" ADD CONSTRAINT "fk_subscription_event_from_plan_revision_id" FOREIGN KEY ("from_plan_revision_id") REFERENCES "plan_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_event" ADD CONSTRAINT "fk_subscription_event_to_plan_revision_id" FOREIGN KEY ("to_plan_revision_id") REFERENCES "plan_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_event" ADD CONSTRAINT "fk_subscription_event_billing_order_id" FOREIGN KEY ("billing_order_id") REFERENCES "billing_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_schedule" ADD CONSTRAINT "fk_grant_schedule_subscription_term_id" FOREIGN KEY ("subscription_term_id") REFERENCES "subscription_term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_schedule" ADD CONSTRAINT "fk_grant_schedule_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_schedule" ADD CONSTRAINT "fk_grant_schedule_plan_id" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_schedule" ADD CONSTRAINT "fk_grant_schedule_plan_revision_id" FOREIGN KEY ("plan_revision_id") REFERENCES "plan_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_schedule" ADD CONSTRAINT "fk_grant_schedule_point_lot_id" FOREIGN KEY ("point_lot_id") REFERENCES "point_lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_lot" ADD CONSTRAINT "fk_point_lot_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_lot" ADD CONSTRAINT "fk_point_lot_subscription_term_id" FOREIGN KEY ("subscription_term_id") REFERENCES "subscription_term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_lot" ADD CONSTRAINT "fk_point_lot_plan_id" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_lot" ADD CONSTRAINT "fk_point_lot_plan_revision_id" FOREIGN KEY ("plan_revision_id") REFERENCES "plan_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_lot" ADD CONSTRAINT "fk_point_lot_origin_point_lot_id" FOREIGN KEY ("origin_point_lot_id") REFERENCES "point_lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_lot" ADD CONSTRAINT "fk_point_lot_origin_point_ledger_entry_id" FOREIGN KEY ("origin_point_ledger_entry_id") REFERENCES "point_ledger_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_hold" ADD CONSTRAINT "fk_point_hold_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_hold" ADD CONSTRAINT "fk_point_hold_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_hold" ADD CONSTRAINT "fk_point_hold_subscription_term_id" FOREIGN KEY ("subscription_term_id") REFERENCES "subscription_term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_hold_alloc" ADD CONSTRAINT "fk_point_hold_alloc_point_hold_id" FOREIGN KEY ("point_hold_id") REFERENCES "point_hold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_hold_alloc" ADD CONSTRAINT "fk_point_hold_alloc_point_lot_id" FOREIGN KEY ("point_lot_id") REFERENCES "point_lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_operation" ADD CONSTRAINT "fk_ledger_operation_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_operation" ADD CONSTRAINT "fk_ledger_operation_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_operation" ADD CONSTRAINT "fk_ledger_operation_point_hold_id" FOREIGN KEY ("point_hold_id") REFERENCES "point_hold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_ledger_entry" ADD CONSTRAINT "fk_point_ledger_entry_ledger_operation_id" FOREIGN KEY ("ledger_operation_id") REFERENCES "ledger_operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_ledger_entry" ADD CONSTRAINT "fk_point_ledger_entry_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_ledger_entry" ADD CONSTRAINT "fk_point_ledger_entry_point_lot_id" FOREIGN KEY ("point_lot_id") REFERENCES "point_lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_ledger_entry" ADD CONSTRAINT "fk_point_ledger_entry_point_hold_id" FOREIGN KEY ("point_hold_id") REFERENCES "point_hold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_ledger_entry" ADD CONSTRAINT "fk_point_ledger_entry_plan_id" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_entity_daily" ADD CONSTRAINT "fk_billing_entity_daily_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_entity_daily" ADD CONSTRAINT "fk_billing_entity_daily_plan_id" FOREIGN KEY ("plan_id") REFERENCES "plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_entity_daily" ADD CONSTRAINT "fk_billing_entity_daily_plan_revision_id" FOREIGN KEY ("plan_revision_id") REFERENCES "plan_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_entity_daily" ADD CONSTRAINT "fk_billing_entity_daily_subscription_term_id" FOREIGN KEY ("subscription_term_id") REFERENCES "subscription_term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_entry_valuation" ADD CONSTRAINT "fk_point_entry_valuation_point_ledger_entry_id" FOREIGN KEY ("point_ledger_entry_id") REFERENCES "point_ledger_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_entry_valuation" ADD CONSTRAINT "fk_point_entry_valuation_valuation_policy_version_no" FOREIGN KEY ("valuation_policy_version_no") REFERENCES "valuation_policy"("version_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_entry_valuation" ADD CONSTRAINT "fk_point_entry_valuation_point_lot_id" FOREIGN KEY ("point_lot_id") REFERENCES "point_lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_entry_valuation" ADD CONSTRAINT "fk_point_entry_valuation_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_adjustment_request" ADD CONSTRAINT "fk_point_adjustment_request_approval_request_id" FOREIGN KEY ("approval_request_id") REFERENCES "approval_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_adjustment_request" ADD CONSTRAINT "fk_point_adjustment_request_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_adjustment_request" ADD CONSTRAINT "fk_point_adjustment_request_point_hold_id" FOREIGN KEY ("point_hold_id") REFERENCES "point_hold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_adjustment_request" ADD CONSTRAINT "fk_point_adjustment_request_term_extension_request_id" FOREIGN KEY ("term_extension_request_id") REFERENCES "term_extension_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "point_adjustment_request" ADD CONSTRAINT "fk_point_adjustment_request_ledger_operation_id" FOREIGN KEY ("ledger_operation_id") REFERENCES "ledger_operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_extension_request" ADD CONSTRAINT "fk_term_extension_request_approval_request_id" FOREIGN KEY ("approval_request_id") REFERENCES "approval_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_extension_request" ADD CONSTRAINT "fk_term_extension_request_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_extension_request" ADD CONSTRAINT "fk_term_extension_request_subscription_term_id" FOREIGN KEY ("subscription_term_id") REFERENCES "subscription_term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_extension_request" ADD CONSTRAINT "fk_term_extension_request_applied_subscription_term_id" FOREIGN KEY ("applied_subscription_term_id") REFERENCES "subscription_term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_extension_request" ADD CONSTRAINT "fk_term_extension_request_ledger_operation_id" FOREIGN KEY ("ledger_operation_id") REFERENCES "ledger_operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_order" ADD CONSTRAINT "fk_billing_order_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_order" ADD CONSTRAINT "fk_billing_order_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_order" ADD CONSTRAINT "fk_billing_order_bank_account_finance_config_revision_id" FOREIGN KEY ("bank_account_finance_config_revision_id") REFERENCES "finance_config_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_order" ADD CONSTRAINT "fk_billing_order_paid_payment_txn_id" FOREIGN KEY ("paid_payment_txn_id") REFERENCES "payment_txn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_order" ADD CONSTRAINT "fk_billing_order_placed_by_user_id" FOREIGN KEY ("placed_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_order" ADD CONSTRAINT "fk_billing_order_created_by_staff_id" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_txn" ADD CONSTRAINT "fk_payment_txn_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_txn" ADD CONSTRAINT "fk_payment_txn_billing_order_id" FOREIGN KEY ("billing_order_id") REFERENCES "billing_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_txn" ADD CONSTRAINT "fk_payment_txn_transfer_proof_id" FOREIGN KEY ("transfer_proof_id") REFERENCES "transfer_proof"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_txn" ADD CONSTRAINT "fk_payment_txn_confirmed_by_staff_id" FOREIGN KEY ("confirmed_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_txn" ADD CONSTRAINT "fk_payment_txn_reviewed_by_staff_id" FOREIGN KEY ("reviewed_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_proof" ADD CONSTRAINT "fk_transfer_proof_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_proof" ADD CONSTRAINT "fk_transfer_proof_billing_order_id" FOREIGN KEY ("billing_order_id") REFERENCES "billing_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_proof" ADD CONSTRAINT "fk_transfer_proof_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_proof" ADD CONSTRAINT "fk_transfer_proof_uploaded_by_user_id" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_proof" ADD CONSTRAINT "fk_transfer_proof_uploaded_by_staff_id" FOREIGN KEY ("uploaded_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_proof" ADD CONSTRAINT "fk_transfer_proof_ocr_result_id" FOREIGN KEY ("ocr_result_id") REFERENCES "ocr_result"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_proof" ADD CONSTRAINT "fk_transfer_proof_review_approval_request_id" FOREIGN KEY ("review_approval_request_id") REFERENCES "approval_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_proof" ADD CONSTRAINT "fk_transfer_proof_reviewed_by_staff_id" FOREIGN KEY ("reviewed_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_request" ADD CONSTRAINT "fk_refund_request_approval_request_id" FOREIGN KEY ("approval_request_id") REFERENCES "approval_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_request" ADD CONSTRAINT "fk_refund_request_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_request" ADD CONSTRAINT "fk_refund_request_billing_order_id" FOREIGN KEY ("billing_order_id") REFERENCES "billing_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_request" ADD CONSTRAINT "fk_refund_request_payment_txn_id" FOREIGN KEY ("payment_txn_id") REFERENCES "payment_txn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_request" ADD CONSTRAINT "fk_refund_request_executed_by_staff_id" FOREIGN KEY ("executed_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_request" ADD CONSTRAINT "fk_refund_request_voided_by_staff_id" FOREIGN KEY ("voided_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_txn" ADD CONSTRAINT "fk_refund_txn_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_txn" ADD CONSTRAINT "fk_refund_txn_refund_request_id" FOREIGN KEY ("refund_request_id") REFERENCES "refund_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_txn" ADD CONSTRAINT "fk_refund_txn_billing_order_id" FOREIGN KEY ("billing_order_id") REFERENCES "billing_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_txn" ADD CONSTRAINT "fk_refund_txn_payment_txn_id" FOREIGN KEY ("payment_txn_id") REFERENCES "payment_txn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_txn" ADD CONSTRAINT "fk_refund_txn_receipt_file_id" FOREIGN KEY ("receipt_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_txn" ADD CONSTRAINT "fk_refund_txn_registered_by_staff_id" FOREIGN KEY ("registered_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_exception" ADD CONSTRAINT "fk_payment_exception_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_exception" ADD CONSTRAINT "fk_payment_exception_billing_order_id" FOREIGN KEY ("billing_order_id") REFERENCES "billing_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_exception" ADD CONSTRAINT "fk_payment_exception_payment_txn_id" FOREIGN KEY ("payment_txn_id") REFERENCES "payment_txn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_exception" ADD CONSTRAINT "fk_payment_exception_refund_txn_id" FOREIGN KEY ("refund_txn_id") REFERENCES "refund_txn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_exception" ADD CONSTRAINT "fk_payment_exception_wx_bill_line_id" FOREIGN KEY ("wx_bill_line_id") REFERENCES "wx_bill_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_exception" ADD CONSTRAINT "fk_payment_exception_resolved_by_staff_id" FOREIGN KEY ("resolved_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_exception" ADD CONSTRAINT "fk_payment_exception_refund_request_id" FOREIGN KEY ("refund_request_id") REFERENCES "refund_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wx_bill_file" ADD CONSTRAINT "fk_wx_bill_file_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wx_bill_line" ADD CONSTRAINT "fk_wx_bill_line_wx_bill_file_id" FOREIGN KEY ("wx_bill_file_id") REFERENCES "wx_bill_file"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wx_bill_line" ADD CONSTRAINT "fk_wx_bill_line_matched_payment_txn_id" FOREIGN KEY ("matched_payment_txn_id") REFERENCES "payment_txn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wx_bill_line" ADD CONSTRAINT "fk_wx_bill_line_matched_refund_txn_id" FOREIGN KEY ("matched_refund_txn_id") REFERENCES "refund_txn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_request" ADD CONSTRAINT "fk_invoice_request_billing_order_id" FOREIGN KEY ("billing_order_id") REFERENCES "billing_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_request" ADD CONSTRAINT "fk_invoice_request_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_request" ADD CONSTRAINT "fk_invoice_request_held_by_refund_request_id" FOREIGN KEY ("held_by_refund_request_id") REFERENCES "refund_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_request" ADD CONSTRAINT "fk_invoice_request_rejected_by_staff_id" FOREIGN KEY ("rejected_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_request" ADD CONSTRAINT "fk_invoice_request_applied_by_user_id" FOREIGN KEY ("applied_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_doc" ADD CONSTRAINT "fk_invoice_doc_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_doc" ADD CONSTRAINT "fk_invoice_doc_invoice_request_id" FOREIGN KEY ("invoice_request_id") REFERENCES "invoice_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_doc" ADD CONSTRAINT "fk_invoice_doc_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_doc" ADD CONSTRAINT "fk_invoice_doc_issued_by_staff_id" FOREIGN KEY ("issued_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_doc" ADD CONSTRAINT "fk_invoice_doc_original_invoice_doc_id" FOREIGN KEY ("original_invoice_doc_id") REFERENCES "invoice_doc"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_config_revision" ADD CONSTRAINT "fk_finance_config_revision_approval_request_id" FOREIGN KEY ("approval_request_id") REFERENCES "approval_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_item" ADD CONSTRAINT "fk_cart_item_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_item" ADD CONSTRAINT "fk_cart_item_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_item" ADD CONSTRAINT "fk_cart_item_drama_id" FOREIGN KEY ("drama_id") REFERENCES "drama"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_item" ADD CONSTRAINT "fk_cart_item_added_by_user_id" FOREIGN KEY ("added_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_order" ADD CONSTRAINT "fk_drama_order_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_order" ADD CONSTRAINT "fk_drama_order_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_order" ADD CONSTRAINT "fk_drama_order_placed_by_user_id" FOREIGN KEY ("placed_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_order" ADD CONSTRAINT "fk_drama_order_subscription_term_id" FOREIGN KEY ("subscription_term_id") REFERENCES "subscription_term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_order" ADD CONSTRAINT "fk_drama_order_agreement_consent_id" FOREIGN KEY ("agreement_consent_id") REFERENCES "agreement_consent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_order" ADD CONSTRAINT "fk_drama_order_delivery_manager_id" FOREIGN KEY ("delivery_manager_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drama_order" ADD CONSTRAINT "fk_drama_order_open_cancel_request_id" FOREIGN KEY ("open_cancel_request_id") REFERENCES "cancel_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "fk_order_item_drama_order_id" FOREIGN KEY ("drama_order_id") REFERENCES "drama_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "fk_order_item_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "fk_order_item_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "fk_order_item_drama_id" FOREIGN KEY ("drama_id") REFERENCES "drama"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item" ADD CONSTRAINT "fk_order_item_point_hold_id" FOREIGN KEY ("point_hold_id") REFERENCES "point_hold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_account" ADD CONSTRAINT "fk_order_item_account_order_item_id" FOREIGN KEY ("order_item_id") REFERENCES "order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_account" ADD CONSTRAINT "fk_order_item_account_channel_account_id" FOREIGN KEY ("channel_account_id") REFERENCES "channel_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_placement" ADD CONSTRAINT "fk_order_item_placement_order_item_id" FOREIGN KEY ("order_item_id") REFERENCES "order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_placement" ADD CONSTRAINT "fk_order_item_placement_ad_id" FOREIGN KEY ("ad_id") REFERENCES "ad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_placement" ADD CONSTRAINT "fk_order_item_placement_bound_version" FOREIGN KEY ("ad_id", "bound_version_no") REFERENCES "ad_version"("ad_id", "version_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancel_request" ADD CONSTRAINT "fk_cancel_request_approval_request_id" FOREIGN KEY ("approval_request_id") REFERENCES "approval_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancel_request" ADD CONSTRAINT "fk_cancel_request_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancel_request" ADD CONSTRAINT "fk_cancel_request_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancel_request" ADD CONSTRAINT "fk_cancel_request_drama_order_id" FOREIGN KEY ("drama_order_id") REFERENCES "drama_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancel_request" ADD CONSTRAINT "fk_cancel_request_ad_id" FOREIGN KEY ("ad_id") REFERENCES "ad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancel_request" ADD CONSTRAINT "fk_cancel_request_executed_by_staff_id" FOREIGN KEY ("executed_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancel_request_line" ADD CONSTRAINT "fk_cancel_request_line_cancel_request_id" FOREIGN KEY ("cancel_request_id") REFERENCES "cancel_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancel_request_line" ADD CONSTRAINT "fk_cancel_request_line_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancel_request_line" ADD CONSTRAINT "fk_cancel_request_line_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancel_request_line" ADD CONSTRAINT "fk_cancel_request_line_point_hold_id" FOREIGN KEY ("point_hold_id") REFERENCES "point_hold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad" ADD CONSTRAINT "fk_ad_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad" ADD CONSTRAINT "fk_ad_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad" ADD CONSTRAINT "fk_ad_requested_by_user_id" FOREIGN KEY ("requested_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad" ADD CONSTRAINT "fk_ad_editor_id" FOREIGN KEY ("editor_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad" ADD CONSTRAINT "fk_ad_point_hold_id" FOREIGN KEY ("point_hold_id") REFERENCES "point_hold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad" ADD CONSTRAINT "fk_ad_agreement_consent_id" FOREIGN KEY ("agreement_consent_id") REFERENCES "agreement_consent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad" ADD CONSTRAINT "fk_ad_open_cancel_request_id" FOREIGN KEY ("open_cancel_request_id") REFERENCES "cancel_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_version" ADD CONSTRAINT "fk_ad_version_ad_id" FOREIGN KEY ("ad_id") REFERENCES "ad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_version" ADD CONSTRAINT "fk_ad_version_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_version" ADD CONSTRAINT "fk_ad_version_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_version" ADD CONSTRAINT "fk_ad_version_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_version" ADD CONSTRAINT "fk_ad_version_uploaded_by_staff_id" FOREIGN KEY ("uploaded_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_version" ADD CONSTRAINT "fk_ad_version_offline_sent_by_staff_id" FOREIGN KEY ("offline_sent_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_revision" ADD CONSTRAINT "fk_ad_revision_ad_id" FOREIGN KEY ("ad_id") REFERENCES "ad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_revision" ADD CONSTRAINT "fk_ad_revision_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_revision" ADD CONSTRAINT "fk_ad_revision_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_revision" ADD CONSTRAINT "fk_ad_revision_charge_point_hold_id" FOREIGN KEY ("charge_point_hold_id") REFERENCES "point_hold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_revision" ADD CONSTRAINT "fk_ad_revision_on_version" FOREIGN KEY ("ad_id", "on_version_no") REFERENCES "ad_version"("ad_id", "version_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_revision" ADD CONSTRAINT "fk_ad_revision_fulfilled_by_version" FOREIGN KEY ("ad_id", "fulfilled_by_version_no") REFERENCES "ad_version"("ad_id", "version_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_ticket" ADD CONSTRAINT "fk_delivery_ticket_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_ticket" ADD CONSTRAINT "fk_delivery_ticket_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_ticket" ADD CONSTRAINT "fk_delivery_ticket_drama_order_id" FOREIGN KEY ("drama_order_id") REFERENCES "drama_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_ticket" ADD CONSTRAINT "fk_delivery_ticket_order_item_id" FOREIGN KEY ("order_item_id") REFERENCES "order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_ticket" ADD CONSTRAINT "fk_delivery_ticket_drama_id" FOREIGN KEY ("drama_id") REFERENCES "drama"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_ticket" ADD CONSTRAINT "fk_delivery_ticket_delivery_manager_id" FOREIGN KEY ("delivery_manager_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_ticket" ADD CONSTRAINT "fk_delivery_ticket_editor_id" FOREIGN KEY ("editor_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_ticket" ADD CONSTRAINT "fk_delivery_ticket_publisher_id" FOREIGN KEY ("publisher_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_ticket_stage" ADD CONSTRAINT "fk_delivery_ticket_stage_delivery_ticket_id" FOREIGN KEY ("delivery_ticket_id") REFERENCES "delivery_ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_ticket_pause" ADD CONSTRAINT "fk_delivery_ticket_pause_delivery_ticket_id" FOREIGN KEY ("delivery_ticket_id") REFERENCES "delivery_ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_plan" ADD CONSTRAINT "fk_delivery_plan_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_plan" ADD CONSTRAINT "fk_delivery_plan_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_plan" ADD CONSTRAINT "fk_delivery_plan_drama_order_id" FOREIGN KEY ("drama_order_id") REFERENCES "drama_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_plan_version" ADD CONSTRAINT "fk_delivery_plan_version_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_plan_version" ADD CONSTRAINT "fk_delivery_plan_version_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_plan_version" ADD CONSTRAINT "fk_delivery_plan_version_delivery_plan_id" FOREIGN KEY ("delivery_plan_id") REFERENCES "delivery_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_plan_version" ADD CONSTRAINT "fk_delivery_plan_version_pushed_by_staff_id" FOREIGN KEY ("pushed_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_plan_change_request" ADD CONSTRAINT "fk_delivery_plan_change_request_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_plan_change_request" ADD CONSTRAINT "fk_delivery_plan_change_request_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_plan_change_request" ADD CONSTRAINT "fk_delivery_plan_change_request_delivery_plan_id" FOREIGN KEY ("delivery_plan_id") REFERENCES "delivery_plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_plan_change_request" ADD CONSTRAINT "fk_delivery_plan_change_request_created_by_user_id" FOREIGN KEY ("created_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_plan_change_request" ADD CONSTRAINT "fk_delivery_plan_change_request_on_version" FOREIGN KEY ("delivery_plan_id", "on_version_no") REFERENCES "delivery_plan_version"("delivery_plan_id", "version_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_plan_change_request" ADD CONSTRAINT "fk_delivery_plan_change_request_resolved_by_version" FOREIGN KEY ("delivery_plan_id", "resolved_by_version_no") REFERENCES "delivery_plan_version"("delivery_plan_id", "version_no") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "fk_sample_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "fk_sample_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "fk_sample_delivery_ticket_id" FOREIGN KEY ("delivery_ticket_id") REFERENCES "delivery_ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "fk_sample_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "fk_sample_qc_record_id" FOREIGN KEY ("qc_record_id") REFERENCES "qc_record"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "fk_sample_uploaded_by_staff_id" FOREIGN KEY ("uploaded_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "fk_sample_pushed_by_staff_id" FOREIGN KEY ("pushed_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "fk_sample_offline_sent_by_staff_id" FOREIGN KEY ("offline_sent_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "fk_sample_on_behalf_staff_id" FOREIGN KEY ("on_behalf_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "fk_sample_decided_by_user_id" FOREIGN KEY ("decided_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample" ADD CONSTRAINT "fk_sample_viewed_ack_by_user_id" FOREIGN KEY ("viewed_ack_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episode_output" ADD CONSTRAINT "fk_episode_output_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episode_output" ADD CONSTRAINT "fk_episode_output_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episode_output" ADD CONSTRAINT "fk_episode_output_delivery_ticket_id" FOREIGN KEY ("delivery_ticket_id") REFERENCES "delivery_ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episode_output" ADD CONSTRAINT "fk_episode_output_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episode_output" ADD CONSTRAINT "fk_episode_output_delivery_reissue_id" FOREIGN KEY ("delivery_reissue_id") REFERENCES "delivery_reissue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episode_output" ADD CONSTRAINT "fk_episode_output_qc_record_id" FOREIGN KEY ("qc_record_id") REFERENCES "qc_record"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "episode_output" ADD CONSTRAINT "fk_episode_output_uploaded_by_staff_id" FOREIGN KEY ("uploaded_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_record" ADD CONSTRAINT "fk_qc_record_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_record" ADD CONSTRAINT "fk_qc_record_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_record" ADD CONSTRAINT "fk_qc_record_delivery_ticket_id" FOREIGN KEY ("delivery_ticket_id") REFERENCES "delivery_ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qc_record" ADD CONSTRAINT "fk_qc_record_inspected_by_staff_id" FOREIGN KEY ("inspected_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_release" ADD CONSTRAINT "fk_delivery_release_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_release" ADD CONSTRAINT "fk_delivery_release_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_release" ADD CONSTRAINT "fk_delivery_release_order_item_id" FOREIGN KEY ("order_item_id") REFERENCES "order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_release" ADD CONSTRAINT "fk_delivery_release_delivery_ticket_id" FOREIGN KEY ("delivery_ticket_id") REFERENCES "delivery_ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_release" ADD CONSTRAINT "fk_delivery_release_pushed_by_staff_id" FOREIGN KEY ("pushed_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_reissue" ADD CONSTRAINT "fk_delivery_reissue_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_reissue" ADD CONSTRAINT "fk_delivery_reissue_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_reissue" ADD CONSTRAINT "fk_delivery_reissue_delivery_ticket_id" FOREIGN KEY ("delivery_ticket_id") REFERENCES "delivery_ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_reissue" ADD CONSTRAINT "fk_delivery_reissue_opened_by_staff_id" FOREIGN KEY ("opened_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_reissue" ADD CONSTRAINT "fk_delivery_reissue_published_delivery_release_id" FOREIGN KEY ("published_delivery_release_id") REFERENCES "delivery_release"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "download_grant" ADD CONSTRAINT "fk_download_grant_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "download_grant" ADD CONSTRAINT "fk_download_grant_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "download_grant" ADD CONSTRAINT "fk_download_grant_order_item_id" FOREIGN KEY ("order_item_id") REFERENCES "order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "download_grant" ADD CONSTRAINT "fk_download_grant_delivery_release_id" FOREIGN KEY ("delivery_release_id") REFERENCES "delivery_release"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_download_log" ADD CONSTRAINT "fk_delivery_download_log_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_download_log" ADD CONSTRAINT "fk_delivery_download_log_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_download_log" ADD CONSTRAINT "fk_delivery_download_log_delivery_release_id" FOREIGN KEY ("delivery_release_id") REFERENCES "delivery_release"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_download_log" ADD CONSTRAINT "fk_delivery_download_log_download_grant_id" FOREIGN KEY ("download_grant_id") REFERENCES "download_grant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_download_log" ADD CONSTRAINT "fk_delivery_download_log_order_item_id" FOREIGN KEY ("order_item_id") REFERENCES "order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_download_log" ADD CONSTRAINT "fk_delivery_download_log_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_list" ADD CONSTRAINT "fk_publish_list_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_list" ADD CONSTRAINT "fk_publish_list_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_list" ADD CONSTRAINT "fk_publish_list_delivery_ticket_id" FOREIGN KEY ("delivery_ticket_id") REFERENCES "delivery_ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_list" ADD CONSTRAINT "fk_publish_list_cover_file_id" FOREIGN KEY ("cover_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_list" ADD CONSTRAINT "fk_publish_list_saved_by_staff_id" FOREIGN KEY ("saved_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_list_episode" ADD CONSTRAINT "fk_publish_list_episode_delivery_ticket_id" FOREIGN KEY ("delivery_ticket_id") REFERENCES "delivery_ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_account" ADD CONSTRAINT "fk_channel_account_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_account" ADD CONSTRAINT "fk_channel_account_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_account" ADD CONSTRAINT "fk_channel_account_verified_by_staff_id" FOREIGN KEY ("verified_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_account_submission" ADD CONSTRAINT "fk_channel_account_submission_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_account_submission" ADD CONSTRAINT "fk_channel_account_submission_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_account_submission" ADD CONSTRAINT "fk_channel_account_submission_channel_account_id" FOREIGN KEY ("channel_account_id") REFERENCES "channel_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_account_submission" ADD CONSTRAINT "fk_channel_account_submission_approval_request_id" FOREIGN KEY ("approval_request_id") REFERENCES "approval_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_account_submission" ADD CONSTRAINT "fk_channel_account_submission_submitted_by_user_id" FOREIGN KEY ("submitted_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_task" ADD CONSTRAINT "fk_launch_task_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_task" ADD CONSTRAINT "fk_launch_task_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_task" ADD CONSTRAINT "fk_launch_task_order_item_id" FOREIGN KEY ("order_item_id") REFERENCES "order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_task" ADD CONSTRAINT "fk_launch_task_delivery_ticket_id" FOREIGN KEY ("delivery_ticket_id") REFERENCES "delivery_ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_task" ADD CONSTRAINT "fk_launch_task_channel_account_id" FOREIGN KEY ("channel_account_id") REFERENCES "channel_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_submission" ADD CONSTRAINT "fk_launch_submission_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_submission" ADD CONSTRAINT "fk_launch_submission_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_submission" ADD CONSTRAINT "fk_launch_submission_launch_task_id" FOREIGN KEY ("launch_task_id") REFERENCES "launch_task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_submission" ADD CONSTRAINT "fk_launch_submission_approval_request_id" FOREIGN KEY ("approval_request_id") REFERENCES "approval_request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "launch_submission" ADD CONSTRAINT "fk_launch_submission_reopen_of_launch_submission_id" FOREIGN KEY ("reopen_of_launch_submission_id") REFERENCES "launch_submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patrol_task" ADD CONSTRAINT "fk_patrol_task_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patrol_task" ADD CONSTRAINT "fk_patrol_task_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patrol_task" ADD CONSTRAINT "fk_patrol_task_patrol_batch_id" FOREIGN KEY ("patrol_batch_id") REFERENCES "patrol_batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patrol_task" ADD CONSTRAINT "fk_patrol_task_launch_task_id" FOREIGN KEY ("launch_task_id") REFERENCES "launch_task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patrol_task" ADD CONSTRAINT "fk_patrol_task_delivery_ticket_id" FOREIGN KEY ("delivery_ticket_id") REFERENCES "delivery_ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patrol_task" ADD CONSTRAINT "fk_patrol_task_order_item_id" FOREIGN KEY ("order_item_id") REFERENCES "order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patrol_task" ADD CONSTRAINT "fk_patrol_task_checked_by_staff_id" FOREIGN KEY ("checked_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "takedown_task" ADD CONSTRAINT "fk_takedown_task_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "takedown_task" ADD CONSTRAINT "fk_takedown_task_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "takedown_task" ADD CONSTRAINT "fk_takedown_task_order_item_id" FOREIGN KEY ("order_item_id") REFERENCES "order_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "takedown_task" ADD CONSTRAINT "fk_takedown_task_delivery_ticket_id" FOREIGN KEY ("delivery_ticket_id") REFERENCES "delivery_ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "takedown_task" ADD CONSTRAINT "fk_takedown_task_launch_task_id" FOREIGN KEY ("launch_task_id") REFERENCES "launch_task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "takedown_task" ADD CONSTRAINT "fk_takedown_task_channel_account_id" FOREIGN KEY ("channel_account_id") REFERENCES "channel_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "takedown_task" ADD CONSTRAINT "fk_takedown_task_merchant_confirmed_by_user_id" FOREIGN KEY ("merchant_confirmed_by_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "takedown_task" ADD CONSTRAINT "fk_takedown_task_checked_by_staff_id" FOREIGN KEY ("checked_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket" ADD CONSTRAINT "fk_service_ticket_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket" ADD CONSTRAINT "fk_service_ticket_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket" ADD CONSTRAINT "fk_service_ticket_submitter_user_id" FOREIGN KEY ("submitter_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket" ADD CONSTRAINT "fk_service_ticket_owner_staff_id" FOREIGN KEY ("owner_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket" ADD CONSTRAINT "fk_service_ticket_registered_by_staff_id" FOREIGN KEY ("registered_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket_entry" ADD CONSTRAINT "fk_service_ticket_entry_service_ticket_id" FOREIGN KEY ("service_ticket_id", "entity_id", "store_id") REFERENCES "service_ticket"("id", "entity_id", "store_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket_entry" ADD CONSTRAINT "fk_service_ticket_entry_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket_entry" ADD CONSTRAINT "fk_service_ticket_entry_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_ticket_ref" ADD CONSTRAINT "fk_service_ticket_ref_service_ticket_id" FOREIGN KEY ("service_ticket_id") REFERENCES "service_ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notify_scene" ADD CONSTRAINT "fk_notify_scene_wx_template_slot_key" FOREIGN KEY ("wx_template_slot_key") REFERENCES "wx_template_slot"("slot_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notify_scene" ADD CONSTRAINT "fk_notify_scene_sms_template_key" FOREIGN KEY ("sms_template_key") REFERENCES "sms_template"("template_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notify_scene" ADD CONSTRAINT "fk_notify_scene_updated_by_staff_id" FOREIGN KEY ("updated_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "fk_notification_notify_scene_key" FOREIGN KEY ("notify_scene_key") REFERENCES "notify_scene"("scene_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "fk_notification_merchant_user_id" FOREIGN KEY ("merchant_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "fk_notification_staff_id" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "fk_notification_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "fk_notification_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_delivery" ADD CONSTRAINT "fk_notification_delivery_notification_id" FOREIGN KEY ("notification_id") REFERENCES "notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_delivery" ADD CONSTRAINT "fk_notification_delivery_sms_template_key" FOREIGN KEY ("sms_template_key") REFERENCES "sms_template"("template_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_message" ADD CONSTRAINT "fk_merchant_message_notification_id" FOREIGN KEY ("notification_id") REFERENCES "notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_message" ADD CONSTRAINT "fk_merchant_message_merchant_user_id" FOREIGN KEY ("merchant_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_message" ADD CONSTRAINT "fk_merchant_message_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_message" ADD CONSTRAINT "fk_merchant_message_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_message" ADD CONSTRAINT "fk_staff_message_notification_id" FOREIGN KEY ("notification_id") REFERENCES "notification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_message" ADD CONSTRAINT "fk_staff_message_staff_id" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wx_subscribe_quota" ADD CONSTRAINT "fk_wx_subscribe_quota_wechat_identity_id" FOREIGN KEY ("wechat_identity_id") REFERENCES "wechat_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wx_subscribe_quota" ADD CONSTRAINT "fk_wx_subscribe_quota_wx_template_slot_key" FOREIGN KEY ("wx_template_slot_key") REFERENCES "wx_template_slot"("slot_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wx_subscribe_quota" ADD CONSTRAINT "fk_wx_subscribe_quota_merchant_user_id" FOREIGN KEY ("merchant_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_reminder_log" ADD CONSTRAINT "fk_manual_reminder_log_sent_by_staff_id" FOREIGN KEY ("sent_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_version" ADD CONSTRAINT "fk_agreement_version_agreement_key" FOREIGN KEY ("agreement_key") REFERENCES "agreement"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_version" ADD CONSTRAINT "fk_agreement_version_pdf_file_id" FOREIGN KEY ("pdf_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_version" ADD CONSTRAINT "fk_agreement_version_source_file_id" FOREIGN KEY ("source_file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_version" ADD CONSTRAINT "fk_agreement_version_site_notice_id" FOREIGN KEY ("site_notice_id") REFERENCES "site_notice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_version" ADD CONSTRAINT "fk_agreement_version_created_by_staff_id" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_version" ADD CONSTRAINT "fk_agreement_version_published_by_staff_id" FOREIGN KEY ("published_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_consent" ADD CONSTRAINT "fk_agreement_consent_agreement_version_id" FOREIGN KEY ("agreement_version_id", "agreement_key") REFERENCES "agreement_version"("id", "agreement_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_consent" ADD CONSTRAINT "fk_agreement_consent_merchant_user_id" FOREIGN KEY ("merchant_user_id") REFERENCES "merchant_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_consent" ADD CONSTRAINT "fk_agreement_consent_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_consent" ADD CONSTRAINT "fk_agreement_consent_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_letter" ADD CONSTRAINT "fk_license_letter_entity_id" FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_letter" ADD CONSTRAINT "fk_license_letter_store_entity" FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_letter" ADD CONSTRAINT "fk_license_letter_drama_id" FOREIGN KEY ("drama_id") REFERENCES "drama"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_letter" ADD CONSTRAINT "fk_license_letter_current_revision_id" FOREIGN KEY ("current_revision_id", "id") REFERENCES "license_letter_revision"("id", "license_letter_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "license_letter_revision" ADD CONSTRAINT "fk_license_letter_revision_license_letter_id" FOREIGN KEY ("license_letter_id") REFERENCES "license_letter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_letter_revision" ADD CONSTRAINT "fk_license_letter_revision_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dict_item" ADD CONSTRAINT "fk_dict_item_dict_type_key" FOREIGN KEY ("dict_type_key") REFERENCES "dict_type"("type_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dict_item" ADD CONSTRAINT "fk_dict_item_parent_code" FOREIGN KEY ("dict_type_key", "parent_code") REFERENCES "dict_item"("dict_type_key", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_month_close" ADD CONSTRAINT "fk_report_month_close_closed_by_staff_id" FOREIGN KEY ("closed_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_job" ADD CONSTRAINT "fk_export_job_requested_by_staff_id" FOREIGN KEY ("requested_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_job" ADD CONSTRAINT "fk_export_job_file_id" FOREIGN KEY ("file_id") REFERENCES "file_object"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_event" ADD CONSTRAINT "fk_alert_event_acked_by_staff_id" FOREIGN KEY ("acked_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invariant_violation" ADD CONSTRAINT "fk_invariant_violation_invariant_run_id" FOREIGN KEY ("invariant_run_id") REFERENCES "invariant_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invariant_violation" ADD CONSTRAINT "fk_invariant_violation_resolved_by_staff_id" FOREIGN KEY ("resolved_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== 来源 ②：constraints/00-common.sql =====
-- 公共：扩展与通用触发器函数。所有分组的手写约束都可以使用，先于各分组的 SQL 执行。
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 只增表：拦截 UPDATE、DELETE、TRUNCATE。
-- 用法：
--   CREATE TRIGGER trg_<表>_append_only BEFORE UPDATE OR DELETE ON <表>
--     FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();
--   CREATE TRIGGER trg_<表>_no_truncate BEFORE TRUNCATE ON <表>
--     FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();
CREATE OR REPLACE FUNCTION lyx_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only: % not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- 只拦 UPDATE（DELETE 由清理函数执行）的表。
-- 用法：CREATE TRIGGER trg_<表>_no_update BEFORE UPDATE ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_forbid_update();
CREATE OR REPLACE FUNCTION lyx_forbid_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table %: UPDATE not allowed', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- 只允许“把指定列从 NULL 写一次”，其余列不可改；DELETE 一律拦截。
-- 用于带生效时间的修订行（只可在生效前写一次 cancelled_at）与下载日志的回执列。
-- 用法：CREATE TRIGGER trg_<表>_write_once BEFORE UPDATE OR DELETE ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_write_once('cancelled_at', 'cancelled_by_staff_id');
CREATE OR REPLACE FUNCTION lyx_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := TG_ARGV::text[];
  o jsonb;
  n jsonb;
  c text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'table %: DELETE not allowed', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  o := to_jsonb(OLD);
  n := to_jsonb(NEW);
  IF (o - allowed) IS DISTINCT FROM (n - allowed) THEN
    RAISE EXCEPTION 'table %: only columns % may be written', TG_TABLE_NAME, allowed USING ERRCODE = 'restrict_violation';
  END IF;
  FOREACH c IN ARRAY allowed LOOP
    IF (o -> c) IS DISTINCT FROM 'null'::jsonb AND (o -> c) IS DISTINCT FROM (n -> c) THEN
      RAISE EXCEPTION 'table %: column % is write-once', TG_TABLE_NAME, c USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- 只拦 DELETE 与 TRUNCATE（行可改、不可删）的表。
-- 用法：CREATE TRIGGER trg_<表>_no_delete BEFORE DELETE ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
--       CREATE TRIGGER trg_<表>_no_truncate BEFORE TRUNCATE ON <表>
--         FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();
CREATE OR REPLACE FUNCTION lyx_forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table %: % not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- 指定列创建后不可改（归属列、来源列等）。
-- 用法：CREATE TRIGGER trg_<表>_immutable BEFORE UPDATE ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('entity_id', 'store_id');
CREATE OR REPLACE FUNCTION lyx_forbid_column_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c text;
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
BEGIN
  FOREACH c IN ARRAY TG_ARGV::text[] LOOP
    IF (o -> c) IS DISTINCT FROM (n -> c) THEN
      RAISE EXCEPTION 'table %: column % is immutable', TG_TABLE_NAME, c USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- ===== 来源 ②：constraints/01-kernel-flow.sql =====
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

-- ===== 来源 ②：constraints/02-identity-tenant.sql =====
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
-- lyx:allow 首版迁移，表刚建出来、没有数据：Prisma 把标量数组列建成可空，这里补非空；该列没有默认值
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

-- ===== 来源 ②：constraints/03-staff-authz-audit.sql =====
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

-- ===== 来源 ②：constraints/04-profile.sql =====
-- 分组 04-profile：门店档案与资质审核（模块 profile）
-- 手写约束：CHECK、部分唯一索引、表达式索引、部分索引、数组列的 NOT NULL、防改触发器。外键全部由 Prisma 片段生成（M46、M47）。
-- 依据：docs/appendix/design/d9-profile.md 第 3.2–3.6、3.10 节；标“补”的是字段级阶段按写作规范补的列间关系。
-- 先执行 00-common.sql。本分组没有只增表；防改触发器用公共函数 lyx_forbid_column_change（M50）。

-- 公共：数组列的元素不重复、不含 NULL（count(DISTINCT) 不计 NULL，所以两种情形都会使等式不成立）
CREATE OR REPLACE FUNCTION lyx_04_text_array_is_set(a text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(a) = (SELECT count(DISTINCT e) FROM unnest(a) AS e)
$$;

-- store_profile
-- Prisma 的标量数组列建表时不带 NOT NULL，这里补上（d9:127、137 要求 NOT NULL 默认 '{}'；M49）
ALTER TABLE store_profile ALTER COLUMN selling_point_codes SET NOT NULL;
ALTER TABLE store_profile ALTER COLUMN copy_options SET NOT NULL;
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_contact_phone_source
  CHECK (contact_phone_source IN ('login', 'sms_verified', 'unverified'));
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_completeness_pct
  CHECK (completeness_pct BETWEEN 0 AND 100);
-- 卖点至多 5 个；不重复、不含 NULL
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_selling_point_codes
  CHECK (cardinality(selling_point_codes) <= 5 AND lyx_04_text_array_is_set(selling_point_codes));
-- 复制项只能是四个取值；不重复
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_copy_options
  CHECK (copy_options <@ ARRAY['basic', 'service', 'media', 'brand_assets']::text[] AND lyx_04_text_array_is_set(copy_options));
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_avg_spend_fen
  CHECK (avg_spend_fen >= 0);
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_last_edit_actor_type
  CHECK (last_edit_actor_type IN ('merchant', 'staff', 'system', 'partner'));
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_last_edit_client
  CHECK (last_edit_client IN ('weapp', 'portal', 'admin'));
-- 补：已填必填项数不超过全部必填项数
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_required_counts
  CHECK (required_filled >= 0 AND required_filled <= required_total);
-- 补：最近修改的四列同有同无；system 没有操作人 id 与客户端来源，其余类型两者都必有
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_last_edit
  CHECK (
    (last_edited_at IS NULL AND last_edit_actor_type IS NULL AND last_edit_actor_id IS NULL AND last_edit_client IS NULL)
    OR (
      last_edited_at IS NOT NULL AND last_edit_actor_type IS NOT NULL
      AND (last_edit_actor_type = 'system') = (last_edit_actor_id IS NULL)
      AND (last_edit_actor_type = 'system') = (last_edit_client IS NULL)
    )
  );
-- 补：联系人手机号的密文、脱敏串、来源同有同无
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_contact_phone
  CHECK (
    (contact_phone_enc IS NULL) = (contact_phone_mask IS NULL)
    AND (contact_phone_enc IS NULL) = (contact_phone_source IS NULL)
  );
-- 补：验证时间只在来源为短信验证时有
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_contact_phone_verified_at
  CHECK ((contact_phone_verified_at IS NOT NULL) = (contact_phone_source IS NOT DISTINCT FROM 'sms_verified'));
-- 补：经纬度成对出现并在合法范围内
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_geo
  CHECK (
    (latitude IS NULL) = (longitude IS NULL)
    AND (latitude IS NULL OR latitude BETWEEN -90 AND 90)
    AND (longitude IS NULL OR longitude BETWEEN -180 AND 180)
  );
-- 补：复制项只在有复制来源时出现；来源不能是自己
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_copy_source
  CHECK (
    (copied_from_store_id IS NOT NULL OR cardinality(copy_options) = 0)
    AND (copied_from_store_id IS NULL OR copied_from_store_id <> store_id)
  );
-- 补：营业时间的顶层必须是数组（防止写入 JSON null 或对象）
ALTER TABLE store_profile ADD CONSTRAINT ck_store_profile_business_hours
  CHECK (jsonb_typeof(business_hours) = 'array');
-- 后台按功能区筛选
CREATE INDEX ix_store_profile_zone_code ON store_profile (zone_code) WHERE zone_code IS NOT NULL;
-- 补：归属列与复制来源、复制项创建后不可改
CREATE TRIGGER trg_store_profile_immutable BEFORE UPDATE ON store_profile
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('store_id', 'entity_id', 'copied_from_store_id', 'copy_options');

-- store_profile_media
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_media_group
  CHECK (media_group IN ('door', 'interior', 'product', 'promo'));
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_media_kind
  CHECK (media_kind IN ('image', 'video'));
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_position
  CHECK (position >= 1);
-- 补：门头照片、店内环境只收图片
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_group_kind
  CHECK (media_group NOT IN ('door', 'interior') OR media_kind = 'image');
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_create_actor_type
  CHECK (create_actor_type IN ('merchant', 'staff', 'system', 'partner'));
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_create_client
  CHECK (create_client IN ('weapp', 'portal', 'admin'));
-- 补：system 没有创建人 id 与客户端来源，其余类型两者都必有（M44）
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_create_actor
  CHECK (
    (create_actor_type = 'system') = (create_actor_id IS NULL)
    AND (create_actor_type = 'system') = (create_client IS NULL)
  );
-- 补：复制来源不能是本门店
ALTER TABLE store_profile_media ADD CONSTRAINT ck_store_profile_media_copy_source
  CHECK (copied_from_store_id IS NULL OR copied_from_store_id <> store_id);
-- 同一组内同一个文件只出现一次（未移除的行）
CREATE UNIQUE INDEX uq_store_profile_media_active_file
  ON store_profile_media (store_id, media_group, file_id) WHERE removed_at IS NULL;
-- 按门店、分组、顺序读未移除的行
CREATE INDEX ix_store_profile_media_active_position
  ON store_profile_media (store_id, media_group, position) WHERE removed_at IS NULL;
-- 补：归属列、文件与创建人创建后不可改（替换文件 = 移除旧行、另起新行）
CREATE TRIGGER trg_store_profile_media_immutable BEFORE UPDATE ON store_profile_media
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'entity_id', 'store_id', 'file_id', 'copied_from_store_id', 'create_actor_type', 'create_actor_id', 'create_client');

-- store_service_item
ALTER TABLE store_service_item ADD CONSTRAINT ck_store_service_item_position
  CHECK (position >= 1);
ALTER TABLE store_service_item ADD CONSTRAINT ck_store_service_item_price_fen
  CHECK (price_fen > 0);
ALTER TABLE store_service_item ADD CONSTRAINT ck_store_service_item_original_price_fen
  CHECK (original_price_fen IS NULL OR original_price_fen >= price_fen);
-- 补：按门店、顺序读未移除的主推服务
CREATE INDEX ix_store_service_item_active_position
  ON store_service_item (store_id, position) WHERE removed_at IS NULL;
-- 补：归属列创建后不可改
CREATE TRIGGER trg_store_service_item_immutable BEFORE UPDATE ON store_service_item
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('entity_id', 'store_id');

-- qualification_submission
-- Prisma 的标量数组列建表时不带 NOT NULL，这里补上（d9:207 要求 NOT NULL 默认 '{}'；M49）
ALTER TABLE qualification_submission ALTER COLUMN changed_fields SET NOT NULL;
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_kind
  CHECK (kind IN ('initial', 'new_store', 'change'));
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_claimed_entity_type
  CHECK (claimed_entity_type IN ('enterprise', 'individual'));
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_outcome
  CHECK (outcome IN ('approved', 'rejected', 'withdrawn', 'discarded'));
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_approve_mode
  CHECK (approve_mode IN ('normal', 'corrected', 'override'));
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_system_reject_code
  CHECK (system_reject_code IN ('duplicate_entity'));
-- 变更类别只能是五个取值；不重复
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_changed_fields
  CHECK (
    changed_fields <@ ARRAY['store_name', 'address', 'industry', 'docs', 'entity_license']::text[]
    AND lyx_04_text_array_is_set(changed_fields)
  );
-- 提交标记与审批单同有同无（提交时用一条 UPDATE 写齐）
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_submitted
  CHECK ((submitted_at IS NULL) = (approval_request_id IS NULL));
-- 关闭时间与结论同有同无
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_closed
  CHECK ((closed_at IS NULL) = (outcome IS NULL));
-- 丢弃只发生在未提交的草稿上
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_discarded
  CHECK (outcome <> 'discarded' OR submitted_at IS NULL);
-- 终局驳回只出现在被驳回的 initial、new_store 轮次（结论为空时同样拦住）
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_final_rejected
  CHECK (final_rejected_at IS NULL OR (outcome IS NOT DISTINCT FROM 'rejected' AND kind <> 'change'));
-- 补：轮次号从 1 起
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_round_no
  CHECK (round_no >= 1);
-- 补：轮次号、提交人与提交时间同有同无
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_submit_fields
  CHECK (
    (submitted_at IS NULL) = (round_no IS NULL)
    AND (submitted_at IS NULL) = (submitted_by_user_id IS NULL)
  );
-- 补：已提交的轮次，送审值四项填全（d9:204-206“提交时填全”；提交的那一条 UPDATE 同时写入）
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_submitted_proposed
  CHECK (
    submitted_at IS NULL
    OR (proposed_store_name IS NOT NULL AND proposed_industry_code IS NOT NULL
        AND proposed_category_code IS NOT NULL AND proposed_address_snapshot IS NOT NULL)
  );
-- 补：已提交的 initial 轮次必有所选主体类型（通过时写 entity.entity_type，ck_entity_verified_fields 要求非空）
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_initial_entity_type
  CHECK (kind <> 'initial' OR submitted_at IS NULL OR claimed_entity_type IS NOT NULL);
-- 补：通过、驳回、撤回只发生在已提交的轮次上
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_decided_submitted
  CHECK (outcome IS NULL OR outcome = 'discarded' OR submitted_at IS NOT NULL);
-- 补：通过方式只在结论为通过时有，且通过时必有
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_approve_mode_outcome
  CHECK ((approve_mode IS NOT NULL) = (outcome IS NOT DISTINCT FROM 'approved'));
-- 补：系统驳回原因只出现在被驳回的轮次上
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_system_reject_outcome
  CHECK (system_reject_code IS NULL OR outcome IS NOT DISTINCT FROM 'rejected');
-- 补：信息确认的时间与文案版本同有同无；已提交的轮次必有信息确认
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_declaration
  CHECK (
    (declaration_confirmed_at IS NULL) = (declaration_version IS NULL)
    AND (submitted_at IS NULL OR declaration_confirmed_at IS NOT NULL)
  );
-- 补：变更类别只出现在 change 轮次
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_changed_fields_kind
  CHECK (kind = 'change' OR cardinality(changed_fields) = 0);
-- 补：上一轮不能是自己
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_resubmit_of
  CHECK (resubmit_of_qualification_submission_id IS NULL OR resubmit_of_qualification_submission_id <> id);
-- 补：三个 jsonb 列的顶层必须是对象
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_proposed_address_snapshot
  CHECK (proposed_address_snapshot IS NULL OR jsonb_typeof(proposed_address_snapshot) = 'object');
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_contact_snapshot
  CHECK (contact_snapshot IS NULL OR jsonb_typeof(contact_snapshot) = 'object');
ALTER TABLE qualification_submission ADD CONSTRAINT ck_qualification_submission_check_summary
  CHECK (check_summary IS NULL OR jsonb_typeof(check_summary) = 'object');
-- 在途唯一（M12）：一家门店同时只有一轮未关闭（草稿或在审）
CREATE UNIQUE INDEX uq_qualification_submission_open
  ON qualification_submission (store_id) WHERE closed_at IS NULL;
-- 主体未认证时，同一主体同时只有一轮带主体营业执照
CREATE UNIQUE INDEX uq_qualification_submission_entity_open
  ON qualification_submission (entity_id) WHERE closed_at IS NULL AND kind = 'initial';
-- 补：归属列、轮次类型、上一轮与创建人创建后不可改
CREATE TRIGGER trg_qualification_submission_immutable BEFORE UPDATE ON qualification_submission
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'entity_id', 'store_id', 'kind', 'resubmit_of_qualification_submission_id', 'created_by_user_id');

-- qualification_doc
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_doc_type
  CHECK (doc_type IN ('business_license', 'branch_license', 'industry_permit'));
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_scope
  CHECK (scope IN ('entity', 'store'));
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_origin
  CHECK (origin IN ('uploaded', 'carried'));
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_principal_role
  CHECK (principal_role IN ('legal_rep', 'operator', 'branch_head'));
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_subject_type
  CHECK (subject_type IN ('enterprise', 'individual', 'branch', 'unknown'));
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_verdict
  CHECK (verdict IN ('accepted', 'rejected'));
-- 营业执照属主体，其余属门店
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_scope_doc_type
  CHECK ((doc_type = 'business_license') = (scope = 'entity'));
-- 行业许可证必填许可证类型，其余证照不填
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_permit_type
  CHECK ((doc_type = 'industry_permit') = (permit_type IS NOT NULL));
-- 带入的行必有来源行，新上传的行没有
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_carried
  CHECK ((origin = 'carried') = (carried_from_qualification_doc_id IS NOT NULL));
-- 被取代的行必定生效过
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_superseded
  CHECK (superseded_at IS NULL OR effective_at IS NOT NULL);
-- 补：生效的行本轮结论必为通过
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_effective_accepted
  CHECK (effective_at IS NULL OR verdict IS NOT DISTINCT FROM 'accepted');
-- 补：已移除的行不会有结论，也不会生效
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_removed
  CHECK (removed_at IS NULL OR (verdict IS NULL AND effective_at IS NULL));
-- 补：证件号的密文与脱敏串同有同无；盲索引不单独存在
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_cert_no
  CHECK (
    (cert_no_enc IS NULL) = (cert_no_mask IS NULL)
    AND (cert_no_bidx IS NULL OR cert_no_enc IS NOT NULL)
  );
-- 补：营业执照行的信用代码三件套同有同无（通过时写 entity.uscc_*，ck_entity_uscc_triple 要求三列同有同无）
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_license_bidx
  CHECK (doc_type <> 'business_license' OR (cert_no_enc IS NULL) = (cert_no_bidx IS NULL));
-- 补：盲索引是 HMAC-SHA256，32 字节（同 ck_entity_uscc_bidx_len）
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_cert_no_bidx_len
  CHECK (cert_no_bidx IS NULL OR octet_length(cert_no_bidx) = 32);
-- 补：负责人姓名的密文与脱敏串同有同无
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_principal_name
  CHECK ((principal_name_enc IS NULL) = (principal_name_mask IS NULL));
-- 补：截止日不早于起始日；营业期限为“长期”时没有截止日
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_valid_range
  CHECK (
    (valid_start_date IS NULL OR valid_end_date IS NULL OR valid_end_date >= valid_start_date)
    AND (NOT is_long_term OR valid_end_date IS NULL)
  );
-- 补：比对结论的顶层必须是数组
ALTER TABLE qualification_doc ADD CONSTRAINT ck_qualification_doc_field_checks
  CHECK (jsonb_typeof(field_checks) = 'array');
-- 一轮里每种证照一行（未移除的行）
CREATE UNIQUE INDEX uq_qualification_doc_round_type
  ON qualification_doc (qualification_submission_id, doc_type, COALESCE(permit_type, ''))
  WHERE removed_at IS NULL;
-- 生效唯一：每个主体至多一张生效的营业执照
CREATE UNIQUE INDEX uq_qualification_doc_effective_entity
  ON qualification_doc (entity_id)
  WHERE scope = 'entity' AND effective_at IS NOT NULL AND superseded_at IS NULL;
-- 生效唯一：每家门店每种门店级证照至多一张生效
CREATE UNIQUE INDEX uq_qualification_doc_effective_store
  ON qualification_doc (store_id, doc_type, COALESCE(permit_type, ''))
  WHERE scope = 'store' AND effective_at IS NOT NULL AND superseded_at IS NULL;
-- 信用代码查重：按营业执照行的盲索引找其他主体的轮次（已移除的行不参与）
CREATE INDEX ix_qualification_doc_license_bidx
  ON qualification_doc (cert_no_bidx) WHERE doc_type = 'business_license' AND removed_at IS NULL;
-- 证照到期提醒：按截止日扫生效证照
CREATE INDEX ix_qualification_doc_expiring
  ON qualification_doc (valid_end_date)
  WHERE effective_at IS NOT NULL AND superseded_at IS NULL AND valid_end_date IS NOT NULL;
-- 补：归属、所属轮次、类型、文件、来源与上传人创建后不可改（重新上传 = 移除旧行、另起新行）
CREATE TRIGGER trg_qualification_doc_immutable BEFORE UPDATE ON qualification_doc
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'entity_id', 'store_id', 'qualification_submission_id', 'doc_type', 'permit_type', 'scope',
    'file_id', 'origin', 'carried_from_qualification_doc_id', 'uploaded_by_user_id');

-- ===== 来源 ②：constraints/05-content.sql =====
-- 分组 05-content：短剧库（content）的手写约束。
-- 依据：docs/appendix/design/d8-content.md 第 3.10 节；docs/data-model/05-content.md；rulings M49、M50、M74。
-- 只含 Prisma 表达不了的约束：CHECK、数组列的 NOT NULL、部分唯一索引、部分索引、触发器。
-- 外键（含 drama_copyright 指向修订的复合外键）、GIN 索引都在 Prisma 片段里；本文件不写外键。

-- 公用：数组列的元素非空且不重复（每个数组列一条 CHECK 调用它）。
CREATE OR REPLACE FUNCTION lyx_05_array_is_set(a anyarray) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT count(DISTINCT x) = cardinality(a) FROM unnest(a) AS t(x)
$$;

-- drama
-- 数组列非空：Prisma 给标量数组列建的是可空列（只带默认值），这里补 NOT NULL（M49）。
ALTER TABLE drama ALTER COLUMN genre_codes SET NOT NULL;
ALTER TABLE drama ALTER COLUMN selling_tag_codes SET NOT NULL;
ALTER TABLE drama ALTER COLUMN industry_codes SET NOT NULL;
ALTER TABLE drama ALTER COLUMN allowed_placements SET NOT NULL;
ALTER TABLE drama ADD CONSTRAINT ck_drama_status
  CHECK (status IN ('draft','listed','delisted'));
ALTER TABLE drama ADD CONSTRAINT ck_drama_delist_reason_code
  CHECK (delist_reason_code IN ('ops_strategy','rights_issue','content_revision','other','license_expired'));
ALTER TABLE drama ADD CONSTRAINT ck_drama_drama_class
  CHECK (drama_class IN ('class_1','class_2','class_3'));
ALTER TABLE drama ADD CONSTRAINT ck_drama_heat_tier
  CHECK (heat_tier IN ('S','A','B','C'));
ALTER TABLE drama ADD CONSTRAINT ck_drama_body_edit_policy
  CHECK (body_edit_policy IN ('undecided','allowed','forbidden'));
ALTER TABLE drama ADD CONSTRAINT ck_drama_allowed_placements
  CHECK (allowed_placements <@ ARRAY['opening','ending','corner','mid_roll']::text[]);
ALTER TABLE drama ADD CONSTRAINT ck_drama_selling_tag_codes_max
  CHECK (cardinality(selling_tag_codes) <= 3);
-- 数组元素非空且不重复。
ALTER TABLE drama ADD CONSTRAINT ck_drama_genre_codes_elements
  CHECK (lyx_05_array_is_set(genre_codes));
ALTER TABLE drama ADD CONSTRAINT ck_drama_selling_tag_codes_elements
  CHECK (lyx_05_array_is_set(selling_tag_codes));
ALTER TABLE drama ADD CONSTRAINT ck_drama_industry_codes_elements
  CHECK (lyx_05_array_is_set(industry_codes));
ALTER TABLE drama ADD CONSTRAINT ck_drama_allowed_placements_elements
  CHECK (lyx_05_array_is_set(allowed_placements));
ALTER TABLE drama ADD CONSTRAINT ck_drama_total_episodes
  CHECK (total_episodes >= 1);
ALTER TABLE drama ADD CONSTRAINT ck_drama_episode_duration_sec
  CHECK (episode_duration_sec > 0);
ALTER TABLE drama ADD CONSTRAINT ck_drama_trial_episode_count
  CHECK (trial_episode_count BETWEEN 0 AND 10);
ALTER TABLE drama ADD CONSTRAINT ck_drama_manual_boost
  CHECK (manual_boost BETWEEN 0 AND 100);
ALTER TABLE drama ADD CONSTRAINT ck_drama_roles_array
  CHECK (jsonb_typeof(roles) = 'array');
-- 草稿从未上架：上架、下架、归档的时间与原因都为空。
ALTER TABLE drama ADD CONSTRAINT ck_drama_draft_clean
  CHECK (status <> 'draft' OR (first_listed_at IS NULL AND listed_at IS NULL AND delisted_at IS NULL
                               AND delist_reason_code IS NULL AND archived_at IS NULL));
-- 已上架、已下架的剧必有首次上架时间与最近上架时间，且前者不晚于后者。
ALTER TABLE drama ADD CONSTRAINT ck_drama_listed_times
  CHECK (status = 'draft' OR (first_listed_at IS NOT NULL AND listed_at IS NOT NULL AND first_listed_at <= listed_at));
-- 已下架的剧必有下架时间与原因，且下架时间不早于最近一次上架：每次下架都要重写 delisted_at，
-- 重新上架后残留的上一次下架时间过不了这条。
ALTER TABLE drama ADD CONSTRAINT ck_drama_delisted_fields
  CHECK (status <> 'delisted' OR (delisted_at IS NOT NULL AND delist_reason_code IS NOT NULL AND delisted_at >= listed_at));
-- 系统到期下架没有人工说明：原因为 license_expired 时 delist_note 为空。
ALTER TABLE drama ADD CONSTRAINT ck_drama_delist_note_expired
  CHECK (delist_reason_code IS DISTINCT FROM 'license_expired' OR delist_note IS NULL);
-- 只有已下架的剧可以归档；配合触发器，归档后不能重新上架。
ALTER TABLE drama ADD CONSTRAINT ck_drama_archived_delisted
  CHECK (archived_at IS NULL OR status = 'delisted');

-- “最新上架”排序、“新剧”判定：只扫已上架的剧。
CREATE INDEX ix_drama_listed_first_listed_at ON drama (first_listed_at DESC) WHERE status = 'listed';

-- first_listed_at、archived_at 写入后不可改（重新上架不重置首次上架时间；归档是终态）。
-- 公共的 lyx_write_once 会锁住其余所有列，lyx_forbid_column_change 不允许从 NULL 写一次，所以本组自定义。
CREATE OR REPLACE FUNCTION lyx_05_drama_write_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_listed_at IS NOT NULL AND NEW.first_listed_at IS DISTINCT FROM OLD.first_listed_at THEN
    RAISE EXCEPTION 'table drama: column first_listed_at is write-once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.archived_at IS NOT NULL AND NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    RAISE EXCEPTION 'table drama: column archived_at is write-once (archive is terminal)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_drama_write_once BEFORE UPDATE ON drama
  FOR EACH ROW EXECUTE FUNCTION lyx_05_drama_write_once();
-- 剧目不做物理删除（d8:49；07、09、10、13 的外键都指向它）。
CREATE TRIGGER trg_drama_no_delete BEFORE DELETE ON drama
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_drama_no_truncate BEFORE TRUNCATE ON drama
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- drama_episode
ALTER TABLE drama_episode ADD CONSTRAINT ck_drama_episode_episode_no
  CHECK (episode_no >= 1);
ALTER TABLE drama_episode ADD CONSTRAINT ck_drama_episode_duration_ms
  CHECK (duration_ms > 0);

-- drama_permit
ALTER TABLE drama_permit ALTER COLUMN scan_file_ids SET NOT NULL;
ALTER TABLE drama_permit ADD CONSTRAINT ck_drama_permit_platform
  CHECK (platform IN ('all','douyin','wechat_channels'));
ALTER TABLE drama_permit ADD CONSTRAINT ck_drama_permit_permit_kind
  CHECK (permit_kind IN ('license_no','approval_no','program_no'));
ALTER TABLE drama_permit ADD CONSTRAINT ck_drama_permit_status
  CHECK (status IN ('active','retired'));
-- 停用行必有停用时间；活动行的停用时间与停用原因都为空。
ALTER TABLE drama_permit ADD CONSTRAINT ck_drama_permit_retired_fields
  CHECK ((status = 'retired') = (retired_at IS NOT NULL) AND (status = 'retired' OR retire_reason IS NULL));
ALTER TABLE drama_permit ADD CONSTRAINT ck_drama_permit_scan_file_ids_elements
  CHECK (lyx_05_array_is_set(scan_file_ids));
-- 每个（剧, 平台, 编号种类）至多一条活动行。
CREATE UNIQUE INDEX uq_drama_permit_active ON drama_permit (drama_id, platform, permit_kind) WHERE status = 'active';
-- 许可行的留痕防线：停用行是换号留痕，不可改、不可删；drama_id 创建后不可改；
-- 上架过的剧（drama.first_listed_at 非空）不原地改号（平台、种类、编号），活动行也不可删，只能停用。
CREATE OR REPLACE FUNCTION lyx_05_drama_permit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ever_listed boolean;
BEGIN
  IF OLD.status = 'retired' THEN
    RAISE EXCEPTION 'table drama_permit: retired row % is evidence, % not allowed', OLD.id, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT d.first_listed_at IS NOT NULL INTO ever_listed FROM drama d WHERE d.id = OLD.drama_id;
  IF TG_OP = 'DELETE' THEN
    IF ever_listed THEN
      RAISE EXCEPTION 'table drama_permit: rows of a drama that has been listed cannot be deleted, retire instead'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.drama_id IS DISTINCT FROM OLD.drama_id THEN
    RAISE EXCEPTION 'table drama_permit: column drama_id is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF ever_listed AND (NEW.platform, NEW.permit_kind, NEW.permit_no)
                     IS DISTINCT FROM (OLD.platform, OLD.permit_kind, OLD.permit_no) THEN
    RAISE EXCEPTION 'table drama_permit: permit number of a listed drama cannot be changed in place, retire and insert'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_drama_permit_guard BEFORE UPDATE OR DELETE ON drama_permit
  FOR EACH ROW EXECUTE FUNCTION lyx_05_drama_permit_guard();
CREATE TRIGGER trg_drama_permit_no_truncate BEFORE TRUNCATE ON drama_permit
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- drama_copyright
ALTER TABLE drama_copyright ALTER COLUMN platforms SET NOT NULL;
ALTER TABLE drama_copyright ALTER COLUMN proof_file_ids SET NOT NULL;
ALTER TABLE drama_copyright ADD CONSTRAINT ck_drama_copyright_source
  CHECK (source IN ('own','licensed'));
ALTER TABLE drama_copyright ADD CONSTRAINT ck_drama_copyright_platforms
  CHECK (platforms <@ ARRAY['douyin','wechat_channels']::text[]);
ALTER TABLE drama_copyright ADD CONSTRAINT ck_drama_copyright_platforms_elements
  CHECK (lyx_05_array_is_set(platforms));
ALTER TABLE drama_copyright ADD CONSTRAINT ck_drama_copyright_proof_file_ids_elements
  CHECK (lyx_05_array_is_set(proof_file_ids));
ALTER TABLE drama_copyright ADD CONSTRAINT ck_drama_copyright_license_dates
  CHECK (license_end_date >= license_start_date);
-- 版权当前值与剧目一对一，不做物理删除。
CREATE TRIGGER trg_drama_copyright_no_delete BEFORE DELETE ON drama_copyright
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_drama_copyright_no_truncate BEFORE TRUNCATE ON drama_copyright
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- drama_copyright_revision
ALTER TABLE drama_copyright_revision ALTER COLUMN proof_file_ids SET NOT NULL;
ALTER TABLE drama_copyright_revision ADD CONSTRAINT ck_drama_copyright_revision_change_kind
  CHECK (change_kind IN ('initial','extend','shorten','scope_change','correction'));
-- 修订类型与止日前后值不矛盾（new_end_date 列本身非空）：initial 没有前值；其余类型前值必有，
-- extend 变晚、shorten 变早、scope_change 不变、correction 不限方向。
ALTER TABLE drama_copyright_revision ADD CONSTRAINT ck_drama_copyright_revision_end_dates
  CHECK (CASE change_kind
           WHEN 'initial' THEN prev_end_date IS NULL
           WHEN 'extend' THEN prev_end_date IS NOT NULL AND new_end_date > prev_end_date
           WHEN 'shorten' THEN prev_end_date IS NOT NULL AND new_end_date < prev_end_date
           WHEN 'scope_change' THEN prev_end_date IS NOT NULL AND new_end_date = prev_end_date
           WHEN 'correction' THEN prev_end_date IS NOT NULL
           ELSE false
         END);
ALTER TABLE drama_copyright_revision ADD CONSTRAINT ck_drama_copyright_revision_copyright_snapshot
  CHECK (jsonb_typeof(copyright_snapshot) = 'object');
ALTER TABLE drama_copyright_revision ADD CONSTRAINT ck_drama_copyright_revision_proof_file_ids_elements
  CHECK (lyx_05_array_is_set(proof_file_ids));
-- 每部剧至多一条 initial 修订（首次上架时写入）。
CREATE UNIQUE INDEX uq_drama_copyright_revision_initial ON drama_copyright_revision (drama_id) WHERE change_kind = 'initial';
-- 只增：拦截 UPDATE、DELETE、TRUNCATE。
CREATE TRIGGER trg_drama_copyright_revision_append_only BEFORE UPDATE OR DELETE ON drama_copyright_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();
CREATE TRIGGER trg_drama_copyright_revision_no_truncate BEFORE TRUNCATE ON drama_copyright_revision
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- drama_stat
ALTER TABLE drama_stat ADD CONSTRAINT ck_drama_stat_counts
  CHECK (orders_30d >= 0 AND orders_mtd >= 0 AND live_items >= 0);

-- ===== 来源 ②：constraints/06-media.sql =====
-- 分组 06-media：文件、媒体任务、素材、素材理解、证照识别、ZIP 缓存（模块 media）的手写约束。
-- 依据：docs/appendix/design/d5-media.md 第 4 节；docs/data-model/06-media.md。
-- 只含 Prisma 表达不了的约束：CHECK、部分索引、部分唯一索引、数组列的 NOT NULL、触发器，另有一条依赖扩展的 GIN 索引。
-- 外键（含归属复合外键）都在 Prisma 片段里（M46、M47）；pg_trgm 扩展在 00-common.sql（M49），本文件不再启用。
-- 三元组 GIN 索引 ix_store_asset_search 仍写在这里：它的操作符类依赖 pg_trgm，而校验与合并先执行 Prisma 的建表语句。
-- 本组没有只增表；触发器只用公共函数 lyx_forbid_delete()、lyx_forbid_column_change()（M50），没有自定义函数。

-- file_object
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_bucket
  CHECK (bucket IN ('secure','asset','media','pub'));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_incoming_bucket
  CHECK (incoming_bucket IN ('secure','asset','media'));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_category
  CHECK (category IN (
    'kyc_license','kyc_permit','pay_receipt','invoice','legal_doc','seal_image','consent_digest',
    'drama_license_doc','evidence','export',
    'profile_image','profile_video','profile_promo','store_asset','channel_screenshot','ticket_attachment','video_cover',
    'drama_master','trailer_src','ad_video','sample_video','sample_wm','final_episode','package_zip','publish_list',
    'trailer_out','poster','banner',
    'pay_bill','wecom_qr','account_proof','portrait_auth'));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_scope_type
  CHECK (scope_type IN ('platform','entity','store'));
-- 归属列随范围：平台级两列为空；主体级只有 entity_id；门店级两列齐全。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_scope
  CHECK ((scope_type = 'platform' AND entity_id IS NULL AND store_id IS NULL)
      OR (scope_type = 'entity' AND entity_id IS NOT NULL AND store_id IS NULL)
      OR (scope_type = 'store' AND entity_id IS NOT NULL AND store_id IS NOT NULL));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_upload_actor_type
  CHECK (upload_actor_type IN ('merchant','staff','system'));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_upload_client
  CHECK (upload_client IN ('weapp','portal','admin'));
-- 系统生成的文件没有上传人与客户端来源；其余两列必填。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_upload_actor_system
  CHECK ((upload_actor_type = 'system' AND upload_actor_id IS NULL AND upload_client IS NULL)
      OR (upload_actor_type <> 'system' AND upload_actor_id IS NOT NULL AND upload_client IS NOT NULL));
-- 代传门店只出现在员工上传的文件上。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_on_behalf
  CHECK (on_behalf_store_id IS NULL OR upload_actor_type = 'staff');
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_status
  CHECK (status IN ('pending','promoting','stored','rejected','expired','deleting','deleted'));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_reject_reason
  CHECK (reject_reason IN ('size_mismatch','bad_magic','changed_after_confirm','copy_verify_failed','stamp_failed'));
-- 拒收原因与拒收状态同时出现。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_reject_reason_status
  CHECK ((status = 'rejected') = (reject_reason IS NOT NULL));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_upload_mode
  CHECK (upload_mode IN ('post','multipart','server'));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_moderation_state
  CHECK (moderation_state IN ('none','pending','pass','review','block'));
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_declared_size
  CHECK (declared_size >= 0);
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_size_bytes
  CHECK (size_bytes >= 0);
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_sts_issued
  CHECK (sts_issued BETWEEN 0 AND 30);
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_sha256
  CHECK (sha256 ~ '^[0-9a-f]{64}$');
-- 续传标识只来自客户端上传。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_client_token_actor
  CHECK (client_token IS NULL OR upload_actor_type <> 'system');
-- 已入库（含清除中、已清除）的文件必有入库时间与实际大小。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_stored_facts
  CHECK (status NOT IN ('stored','deleting','deleted') OR (stored_at IS NOT NULL AND size_bytes IS NOT NULL));
-- 写入区键只出现在待确认、入库中、被拒收的文件上（d5 不变量 I9 的单行部分）。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_incoming_key_status
  CHECK (incoming_key IS NULL OR status IN ('pending','promoting','rejected'));
-- 清除完成时间与已清除状态同时出现；恢复时置空。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_deleted_at
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL));
-- 彻底删除标记只出现在已清除的文件上（A141）；有标记的文件不再恢复（应用守卫）。
ALTER TABLE file_object ADD CONSTRAINT ck_file_object_erased_at
  CHECK (erased_at IS NULL OR status = 'deleted');
-- 续传幂等：同一上传人、分类、归属、批次下，待确认的 client_token 唯一。
-- 草案用 COALESCE(列, 0) 作哨兵，改为三条部分唯一索引：批次内、门店内、无门无批次。
CREATE UNIQUE INDEX uq_file_object_client_token_batch ON file_object
  (upload_actor_type, upload_actor_id, category, upload_batch_id, client_token)
  WHERE status = 'pending' AND client_token IS NOT NULL AND upload_batch_id IS NOT NULL;
CREATE UNIQUE INDEX uq_file_object_client_token_store ON file_object
  (upload_actor_type, upload_actor_id, category, store_id, client_token)
  WHERE status = 'pending' AND client_token IS NOT NULL AND upload_batch_id IS NULL AND store_id IS NOT NULL;
CREATE UNIQUE INDEX uq_file_object_client_token_noscope ON file_object
  (upload_actor_type, upload_actor_id, category, client_token)
  WHERE status = 'pending' AND client_token IS NOT NULL AND upload_batch_id IS NULL AND store_id IS NULL;
-- 清扫：待确认且过期的文件。
CREATE INDEX ix_file_object_pending ON file_object (upload_expires_at)
  WHERE status = 'pending';
-- 清扫：已入库但从未被引用的文件。
CREATE INDEX ix_file_object_orphan ON file_object (stored_at)
  WHERE status = 'stored' AND first_linked_at IS NULL AND purge_after IS NULL;
-- 清除任务的候选扫描。
CREATE INDEX ix_file_object_purge ON file_object (purge_after)
  WHERE status = 'stored' AND purge_after IS NOT NULL;
-- 批次名下的文件。
CREATE INDEX ix_file_object_upload_batch_id ON file_object (upload_batch_id)
  WHERE upload_batch_id IS NOT NULL;
-- 识别结果在同一主体内复用：按主体、CRC64、大小找同内容文件。
CREATE INDEX ix_file_object_entity_crc64 ON file_object (entity_id, crc64, size_bytes)
  WHERE status = 'stored' AND entity_id IS NOT NULL AND crc64 IS NOT NULL;
-- 后台“已清除文件”列表。
CREATE INDEX ix_file_object_deleted ON file_object (deleted_at DESC)
  WHERE status = 'deleted';
-- 清扫：被拒收但写入区对象还没删的文件（每 10 分钟）。
CREATE INDEX ix_file_object_rejected_incoming ON file_object (updated_at)
  WHERE status = 'rejected' AND incoming_key IS NOT NULL;
-- 文件行不物理删除（留痕；行没了桶里的对象就成了无主对象）。
CREATE TRIGGER trg_file_object_no_delete BEFORE DELETE ON file_object
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_file_object_no_truncate BEFORE TRUNCATE ON file_object
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();
-- 归属与落点创建后不可改。
CREATE TRIGGER trg_file_object_immutable BEFORE UPDATE ON file_object
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'entity_id', 'store_id', 'scope_type', 'bucket', 'object_key', 'category');

-- file_ref
ALTER TABLE file_ref ADD CONSTRAINT ck_file_ref_state
  CHECK (state IN ('live','released'));
-- 引用类型与角色是代码登记表的键，这里只约束写法（小写蛇形，长度上限）。
ALTER TABLE file_ref ADD CONSTRAINT ck_file_ref_ref_type
  CHECK (ref_type ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE file_ref ADD CONSTRAINT ck_file_ref_role
  CHECK (role ~ '^[a-z][a-z0-9_]{1,23}$');
-- 在用的引用没有保留期与释放时间；已释放的两者都有。
ALTER TABLE file_ref ADD CONSTRAINT ck_file_ref_state_times
  CHECK ((state = 'live' AND keep_until IS NULL AND released_at IS NULL)
      OR (state = 'released' AND keep_until IS NOT NULL AND released_at IS NOT NULL));
-- 清除复核：文件是否还有在用的引用。
CREATE INDEX ix_file_ref_live ON file_ref (file_id)
  WHERE state = 'live';

-- file_purge_run
-- Prisma 给标量数组列建的是可空列，这里补 NOT NULL。
-- lyx:allow 首版迁移，表刚建出来、没有数据：Prisma 把标量数组列建成可空，这里补非空；该列没有默认值
ALTER TABLE file_purge_run ALTER COLUMN candidate_ids SET NOT NULL;
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_mode
  CHECK (mode IN ('list_only','auto'));
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_state
  CHECK (state IN ('proposed','held','approved','running','done','aborted','rejected'));
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_candidate_count
  CHECK (candidate_count BETWEEN 0 AND 5000 AND candidate_count = cardinality(candidate_ids));
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_candidate_bytes
  CHECK (candidate_bytes >= 0);
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_counts
  CHECK (deleted_count >= 0 AND guard_trips >= 0);
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_by_category
  CHECK (jsonb_typeof(by_category) = 'object');
-- 决定人与决定时间同时出现。
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_decided
  CHECK ((decided_by_staff_id IS NULL) = (decided_at IS NULL));
-- 放行、驳回必有决定；只出清单的运行进入执行（含其后的完成、中止）也必有放行。
-- auto 模式未熔断时直接建为 running，没有决定。
ALTER TABLE file_purge_run ADD CONSTRAINT ck_file_purge_run_decided_state
  CHECK (decided_at IS NOT NULL
      OR (state NOT IN ('approved','rejected')
          AND NOT (mode = 'list_only' AND state IN ('running','done','aborted'))));
-- 同一时刻只有一个清除运行在执行。
CREATE UNIQUE INDEX uq_file_purge_run_running ON file_purge_run ((true))
  WHERE state = 'running';

-- media_info
ALTER TABLE media_info ADD CONSTRAINT ck_media_info_kind
  CHECK (kind IN ('video','audio','image'));
ALTER TABLE media_info ADD CONSTRAINT ck_media_info_rotation
  CHECK (rotation IN (0, 90, 180, 270));
ALTER TABLE media_info ADD CONSTRAINT ck_media_info_non_negative
  CHECK (duration_ms >= 0 AND width >= 0 AND height >= 0 AND display_width >= 0 AND display_height >= 0
     AND fps_num >= 0 AND fps_den > 0 AND audio_sample_rate >= 0 AND audio_channels >= 0
     AND audio_stream_count >= 0 AND bitrate_kbps >= 0 AND av_drift_ms >= 0);
ALTER TABLE media_info ADD CONSTRAINT ck_media_info_probe_version
  CHECK (probe_version >= 1);

-- media_check
ALTER TABLE media_check ADD CONSTRAINT ck_media_check_profile
  CHECK (profile IN ('master','trailer_src','ad','sample','final','asset'));
ALTER TABLE media_check ADD CONSTRAINT ck_media_check_gate
  CHECK (gate IN ('pass','reject'));
ALTER TABLE media_check ADD CONSTRAINT ck_media_check_rule_version
  CHECK (rule_version >= 1);
ALTER TABLE media_check ADD CONSTRAINT ck_media_check_items_array
  CHECK (jsonb_typeof(hard) = 'array' AND jsonb_typeof(soft) = 'array');

-- upload_batch
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_purpose
  CHECK (purpose IN ('drama_master','final_release'));
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_variant
  CHECK (variant IN ('common','douyin','wechat_channels'));
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_state
  CHECK (state IN ('matching','uploading','verifying','ready','committed','canceled','expired'));
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_scope
  CHECK (scope IN ('full','partial'));
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_expected_count
  CHECK (expected_count >= 1);
-- 成片批次必须带整批的 AI 使用声明。
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_final_ai_usage
  CHECK (purpose <> 'final_release' OR ai_usage IS NOT NULL);
-- 提交时间与已提交状态同时出现。
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_committed_at
  CHECK ((state = 'committed') = (committed_at IS NOT NULL));
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_note_len
  CHECK (char_length(note) <= 200);
-- 替换原因三选一（选“其他”时说明写 note）；只出现在原片批次上。
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_replace_reason
  CHECK (replace_reason IN ('quality_fix','license_info_fix','other'));
ALTER TABLE upload_batch ADD CONSTRAINT ck_upload_batch_replace_reason_purpose
  CHECK (replace_reason IS NULL OR purpose = 'drama_master');
-- 过期扫描：未结束的批次。
CREATE INDEX ix_upload_batch_open ON upload_batch (expires_at)
  WHERE state IN ('matching','uploading','verifying','ready');

-- upload_batch_item
ALTER TABLE upload_batch_item ADD CONSTRAINT ck_upload_batch_item_match_method
  CHECK (match_method IN ('pattern','sequence','manual'));
ALTER TABLE upload_batch_item ADD CONSTRAINT ck_upload_batch_item_state
  CHECK (state IN ('pending','uploaded','checked','rejected','skipped','replaced'));
ALTER TABLE upload_batch_item ADD CONSTRAINT ck_upload_batch_item_episode_no
  CHECK (episode_no >= 1);
-- 同一批次内一集只有一个有效条目（被跳过、被替换的不算）。
CREATE UNIQUE INDEX uq_upload_batch_item_episode ON upload_batch_item (upload_batch_id, episode_no)
  WHERE episode_no IS NOT NULL AND state NOT IN ('skipped','replaced');

-- media_job
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_kind
  CHECK (kind IN ('promote','probe','restamp',
                  'transcode_mp4','watermark_sample','normalize','zip_package',
                  'audit_image','audit_image_wx','audit_video','audit_text',
                  'asr','vision','doc_extract','digest','ocr'));
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_mode
  CHECK (mode IN ('local','remote'));
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_subject_type
  CHECK (subject_type IN ('file_object','zip_bundle','store_asset','ocr_result'));
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_parent_type
  CHECK (parent_type IN ('store_asset','playable_asset','upload_batch','production_record','zip_bundle'));
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_parent
  CHECK ((parent_type IS NULL) = (parent_id IS NULL));
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_state
  CHECK (state IN ('queued','running','submitting','submitted','succeeded','failed','canceled'));
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_attempts
  CHECK (attempt_no >= 0 AND max_attempts >= 1);
-- 结束时间与结束状态同时出现；人工重试回到 queued 时清空。
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_finished_at
  CHECK ((state IN ('succeeded','failed','canceled')) = (finished_at IS NOT NULL));
ALTER TABLE media_job ADD CONSTRAINT ck_media_job_billable
  CHECK (billable_qty >= 0 AND est_cost_micro >= 0 AND (billable_qty IS NULL) = (billable_unit IS NULL));
-- 执行循环：到期的未结束任务（next_run_at 对 running、submitting 即租约到期时间）。
CREATE INDEX ix_media_job_due ON media_job (next_run_at)
  WHERE state IN ('queued','running','submitting','submitted');
-- 收尾与收敛扫描：父对象名下的任务。
CREATE INDEX ix_media_job_parent ON media_job (parent_type, parent_id)
  WHERE parent_id IS NOT NULL;
-- 后台“媒体任务”失败列表。
CREATE INDEX ix_media_job_failed ON media_job (finished_at DESC)
  WHERE state = 'failed';
-- 微信内容安全的异步结果按 trace_id 找任务。
CREATE INDEX ix_media_job_external_job_id ON media_job (external_job_id)
  WHERE external_job_id IS NOT NULL;

-- production_record
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_kind
  CHECK (kind IN ('sample','final','ad'));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_variant
  CHECK (variant IN ('common','douyin','wechat_channels'));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_source
  CHECK (source IN ('manual_upload','normalized','restamped','render','ai_assisted'));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_production_tier
  CHECK (production_tier IN ('standard','advanced','top'));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_master_source
  CHECK (master_source IN ('checkout','declared','current_fallback'));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_aigc_state
  CHECK (aigc_state IN ('not_required','pending','verified','failed'));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_aigc_origin
  CHECK (aigc_origin IN ('upstream','stamped'));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_pipeline_state
  CHECK (pipeline_state IN ('uploading','checking','ready','rejected'));
-- 样片、成片必有订购项；广告必有广告 id。
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_order_item
  CHECK (kind = 'ad' OR order_item_id IS NOT NULL);
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_ad
  CHECK (kind <> 'ad' OR ad_id IS NOT NULL);
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_episode_no
  CHECK (episode_no >= 1);
-- 原片版本与认定方式同时出现。
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_master
  CHECK ((drama_episode_master_id IS NULL) = (master_source IS NULL));
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_ai_usage
  CHECK (jsonb_typeof(ai_usage) = 'object');
-- 流水线就绪时，AI 标识要么不需要、要么已回读验证（d5 不变量 I15 的单行部分）。
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_ready_aigc
  CHECK (pipeline_state <> 'ready' OR aigc_state IN ('not_required','verified'));
-- 就绪的成片必有集号（批次里未匹配的条目登记时集号可以为空）。
ALTER TABLE production_record ADD CONSTRAINT ck_production_record_final_episode
  CHECK (kind <> 'final' OR pipeline_state <> 'ready' OR episode_no IS NOT NULL);
-- 按订购项取制作文件。
CREATE INDEX ix_production_record_order_item ON production_record (order_item_id, kind, episode_no)
  WHERE order_item_id IS NOT NULL;
-- 收敛扫描：流水线未结束的制作文件。
CREATE INDEX ix_production_record_pipeline ON production_record (pipeline_state)
  WHERE pipeline_state IN ('uploading','checking');

-- master_checkout
ALTER TABLE master_checkout ADD CONSTRAINT ck_master_checkout_episode_no
  CHECK (episode_no >= 1);
ALTER TABLE master_checkout ADD CONSTRAINT ck_master_checkout_checkout_count
  CHECK (checkout_count >= 1);

-- playable_asset
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_kind
  CHECK (kind IN ('trailer','sample','ad'));
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_owner_type
  CHECK (owner_type IN ('drama','order_item','ad'));
-- 资产种类与属主类型一一对应。
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_kind_owner
  CHECK ((kind = 'trailer' AND owner_type = 'drama')
      OR (kind = 'sample' AND owner_type = 'order_item')
      OR (kind = 'ad' AND owner_type = 'ad'));
-- 预告片是平台级资产，归属列为空；样片与广告归门店，两列齐全。
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_tenant
  CHECK ((kind = 'trailer' AND entity_id IS NULL AND store_id IS NULL)
      OR (kind <> 'trailer' AND entity_id IS NOT NULL AND store_id IS NOT NULL));
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_state
  CHECK (state IN ('processing','ready','failed','retired'));
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_spec_version
  CHECK (spec_version >= 1);
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_ready_at
  CHECK (state <> 'ready' OR ready_at IS NOT NULL);
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_retired_at
  CHECK ((state = 'retired') = (retired_at IS NOT NULL));
ALTER TABLE playable_asset ADD CONSTRAINT ck_playable_asset_renditions
  CHECK (jsonb_typeof(renditions) = 'array');
-- 收敛扫描：停在处理中的资产。
CREATE INDEX ix_playable_asset_processing ON playable_asset (updated_at)
  WHERE state = 'processing';
-- 归属、种类、来源与属主创建后不可改。
CREATE TRIGGER trg_playable_asset_immutable BEFORE UPDATE ON playable_asset
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'entity_id', 'store_id', 'kind', 'source_file_id', 'owner_type', 'owner_id');

-- zip_bundle
ALTER TABLE zip_bundle ADD CONSTRAINT ck_zip_bundle_owner_type
  CHECK (owner_type IN ('delivery_release'));
ALTER TABLE zip_bundle ADD CONSTRAINT ck_zip_bundle_zip_state
  CHECK (zip_state IN ('none','building','ready','failed'));
ALTER TABLE zip_bundle ADD CONSTRAINT ck_zip_bundle_zip_gen
  CHECK (zip_gen >= 0);
-- 只有就绪时才有 ZIP 文件（d5 不变量 I8 的单行部分）。
ALTER TABLE zip_bundle ADD CONSTRAINT ck_zip_bundle_file_state
  CHECK ((zip_state = 'ready') = (zip_file_id IS NOT NULL));
-- 发布清单文件与 ZIP 同代次生成，只在就绪时出现（清单文本为空时没有）。
ALTER TABLE zip_bundle ADD CONSTRAINT ck_zip_bundle_publish_list_file
  CHECK (publish_list_file_id IS NULL OR zip_state = 'ready');
-- 清除后钩子按 ZIP 文件找到所属缓存行；一个 ZIP 文件只属于一行。
CREATE UNIQUE INDEX uq_zip_bundle_zip_file_id ON zip_bundle (zip_file_id)
  WHERE zip_file_id IS NOT NULL;
-- 同上，发布清单文件。
CREATE UNIQUE INDEX uq_zip_bundle_publish_list_file_id ON zip_bundle (publish_list_file_id)
  WHERE publish_list_file_id IS NOT NULL;

-- drama_trailer
-- 没有手写约束。

-- drama_episode_master
ALTER TABLE drama_episode_master ADD CONSTRAINT ck_drama_episode_master_episode_no
  CHECK (episode_no >= 1);
ALTER TABLE drama_episode_master ADD CONSTRAINT ck_drama_episode_master_rev_no
  CHECK (rev_no >= 1);
ALTER TABLE drama_episode_master ADD CONSTRAINT ck_drama_episode_master_state
  CHECK (state IN ('ready','superseded'));
-- 当前版本一定是 ready。
ALTER TABLE drama_episode_master ADD CONSTRAINT ck_drama_episode_master_current_ready
  CHECK (NOT is_current OR state = 'ready');
-- 替换原因从批次复制，取值同 upload_batch.replace_reason。
ALTER TABLE drama_episode_master ADD CONSTRAINT ck_drama_episode_master_replace_reason
  CHECK (replace_reason IN ('quality_fix','license_info_fix','other'));
-- 每集至多一个当前版本。
CREATE UNIQUE INDEX uq_drama_episode_master_current ON drama_episode_master (drama_id, episode_no)
  WHERE is_current;

-- store_asset
-- Prisma 给标量数组列建的是可空列，这里补 NOT NULL（M49、M80）。
ALTER TABLE store_asset ALTER COLUMN portrait_auth_file_ids SET NOT NULL;
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_type
  CHECK (type IN ('image','video','recording','audio','document','text'));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_upload_actor_type
  CHECK (upload_actor_type IN ('merchant','staff'));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_upload_client
  CHECK (upload_client IN ('weapp','portal','admin'));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_upload_actor_role
  CHECK (upload_actor_role IN ('owner','clerk'));
-- 商家上传必有角色快照；员工代传没有。
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_upload_actor_role_merchant
  CHECK ((upload_actor_type = 'merchant') = (upload_actor_role IS NOT NULL));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_processing_state
  CHECK (processing_state IN ('pending','processing','processed'));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_review_state
  CHECK (review_state IN ('unreviewed','reviewed'));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_usability
  CHECK (usability IN ('ready','reference_only','need_reshoot','need_portrait_auth'));
-- 未复核时没有可用性与复核人；已复核时三者齐全。
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_review
  CHECK ((review_state = 'unreviewed' AND usability IS NULL AND reviewed_by_staff_id IS NULL AND reviewed_at IS NULL)
      OR (review_state = 'reviewed' AND usability IS NOT NULL AND reviewed_by_staff_id IS NOT NULL AND reviewed_at IS NOT NULL));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_moderation_state
  CHECK (moderation_state IN ('none','pending','pass','review','block'));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_adopted_count
  CHECK (adopted_count >= 0);
-- 文字类素材必有正文，其余类型没有。
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_text_body
  CHECK ((type = 'text') = (text_body IS NOT NULL));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_lengths
  CHECK (char_length(title) <= 60 AND char_length(text_body) <= 500 AND char_length(note) <= 200);
-- 复核截止时间与时限参数快照同时出现。
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_due
  CHECK ((due_at IS NULL) = (sla_snapshot IS NULL));
-- 确认肖像授权必有授权材料，且确认后可用性不再是“需肖像授权”。
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_portrait_auth
  CHECK (portrait_authorized_at IS NULL
      OR (cardinality(portrait_auth_file_ids) >= 1 AND usability IS DISTINCT FROM 'need_portrait_auth'));
ALTER TABLE store_asset ADD CONSTRAINT ck_store_asset_lock_version
  CHECK (lock_version >= 0);
-- 门店素材列表（未删除，按上传倒序）。
CREATE INDEX ix_store_asset_store ON store_asset (store_id, id DESC)
  WHERE deleted_at IS NULL;
-- 复核队列：已处理完、未删除。
CREATE INDEX ix_store_asset_review ON store_asset (review_state, id)
  WHERE deleted_at IS NULL AND processing_state = 'processed';
-- 复核时限：未复核素材按截止时间排序，供待办的派生查询与“审核时效”指标。
CREATE INDEX ix_store_asset_review_due ON store_asset (due_at)
  WHERE deleted_at IS NULL AND review_state = 'unreviewed' AND due_at IS NOT NULL;
-- 收敛扫描：停在处理中的素材。
CREATE INDEX ix_store_asset_stuck ON store_asset (updated_at)
  WHERE processing_state IN ('pending','processing');
-- 某条素材需求已收到的素材。
CREATE INDEX ix_store_asset_store_asset_demand_id ON store_asset (store_asset_demand_id)
  WHERE store_asset_demand_id IS NOT NULL;
-- 关键词检索（模糊匹配）。gin_trgm_ops 来自 00-common.sql 的 pg_trgm；Prisma 的建表语句先于公共文件执行，所以这条索引留在这里。
CREATE INDEX ix_store_asset_search ON store_asset USING gin (search_text gin_trgm_ops);
-- 归属、类型、上传人与复制来源创建后不可改。
CREATE TRIGGER trg_store_asset_immutable BEFORE UPDATE ON store_asset
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'entity_id', 'store_id', 'type', 'upload_actor_type', 'upload_actor_id', 'source_store_asset_id');

-- store_asset_file
ALTER TABLE store_asset_file ADD CONSTRAINT ck_store_asset_file_position
  CHECK (position >= 1);

-- store_asset_insight
ALTER TABLE store_asset_insight ADD CONSTRAINT ck_store_asset_insight_kind
  CHECK (kind IN ('transcript','vision','doc_text','structured_items','digest','tech_spec'));
ALTER TABLE store_asset_insight ADD CONSTRAINT ck_store_asset_insight_status
  CHECK (status IN ('ok','skipped','failed'));
ALTER TABLE store_asset_insight ADD CONSTRAINT ck_store_asset_insight_prompt_version
  CHECK (prompt_version >= 1);
ALTER TABLE store_asset_insight ADD CONSTRAINT ck_store_asset_insight_content
  CHECK (jsonb_typeof(content) = 'object');
-- 一个素材、一个文件、一个步骤、一个提示词版本只有一行；汇总步骤没有文件，单独一条。
-- 草案用 COALESCE(file_id, 0) 作哨兵，改为两条部分唯一索引。
CREATE UNIQUE INDEX uq_store_asset_insight_file_step ON store_asset_insight (store_asset_id, file_id, kind, prompt_version)
  WHERE file_id IS NOT NULL;
CREATE UNIQUE INDEX uq_store_asset_insight_asset_step ON store_asset_insight (store_asset_id, kind, prompt_version)
  WHERE file_id IS NULL;

-- store_asset_tag
ALTER TABLE store_asset_tag ADD CONSTRAINT ck_store_asset_tag_dimension
  CHECK (dimension IN ('content','usage','timeliness'));
ALTER TABLE store_asset_tag ADD CONSTRAINT ck_store_asset_tag_source
  CHECK (source IN ('auto','uploader','reviewer'));
-- 日期区间只用于时效维度，且起不晚于止。
ALTER TABLE store_asset_tag ADD CONSTRAINT ck_store_asset_tag_valid_range
  CHECK ((dimension = 'timeliness' OR (valid_start_date IS NULL AND valid_end_date IS NULL))
     AND (valid_start_date IS NULL OR valid_end_date IS NULL OR valid_start_date <= valid_end_date));

-- store_asset_usage
ALTER TABLE store_asset_usage ADD CONSTRAINT ck_store_asset_usage_used_by_type
  CHECK (used_by_type IN ('ad','drama_order','order_item','ad_version','episode_output'));
ALTER TABLE store_asset_usage ADD CONSTRAINT ck_store_asset_usage_role
  CHECK (role IN ('reference','adopted'));

-- store_asset_demand
ALTER TABLE store_asset_demand ADD CONSTRAINT ck_store_asset_demand_status
  CHECK (status IN ('open','done','canceled'));
ALTER TABLE store_asset_demand ADD CONSTRAINT ck_store_asset_demand_notify_scope
  CHECK (notify_scope IN ('owner_and_clerks','owner_only'));
ALTER TABLE store_asset_demand ADD CONSTRAINT ck_store_asset_demand_lengths
  CHECK (char_length(title) BETWEEN 1 AND 20 AND char_length(shooting_note) <= 200);
-- 结束时间与结束状态同时出现。
ALTER TABLE store_asset_demand ADD CONSTRAINT ck_store_asset_demand_closed_at
  CHECK ((status = 'open') = (closed_at IS NULL));
-- 到期扫描：进行中的需求按完成日期排序。
CREATE INDEX ix_store_asset_demand_open_due ON store_asset_demand (due_date)
  WHERE status = 'open';
-- 归属创建后不可改。
CREATE TRIGGER trg_store_asset_demand_immutable BEFORE UPDATE ON store_asset_demand
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('entity_id', 'store_id');

-- ocr_result
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_doc_type
  CHECK (doc_type IN ('business_license','industry_permit','bank_receipt'));
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_status
  CHECK (status IN ('pending','ok','unavailable','unreadable'));
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_request_actor_type
  CHECK (request_actor_type IN ('merchant','staff','system'));
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_request_client
  CHECK (request_client IN ('weapp','portal','admin'));
-- 系统发起的识别没有操作人与客户端来源；其余两列必填。
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_request_actor_system
  CHECK ((request_actor_type = 'system' AND request_actor_id IS NULL AND request_client IS NULL)
      OR (request_actor_type <> 'system' AND request_actor_id IS NOT NULL AND request_client IS NOT NULL));
-- 许可证类型只出现在行业许可证上。
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_permit_type
  CHECK (doc_type = 'industry_permit' OR permit_type IS NULL);
-- 识别成功必有字段密文。
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_ok_fields
  CHECK (status <> 'ok' OR fields_enc IS NOT NULL);
-- 原始返回在库时必有清空时间。
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_raw_purge
  CHECK (raw_enc IS NULL OR raw_purge_at IS NOT NULL);
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_warnings
  CHECK (jsonb_typeof(warnings) = 'array');
ALTER TABLE ocr_result ADD CONSTRAINT ck_ocr_result_latency_ms
  CHECK (latency_ms >= 0);
-- 原始返回到期清空的扫描。
CREATE INDEX ix_ocr_result_raw_purge ON ocr_result (raw_purge_at)
  WHERE raw_enc IS NOT NULL;
-- 归属、被识别的文件与证照类型创建后不可改。
CREATE TRIGGER trg_ocr_result_immutable BEFORE UPDATE ON ocr_result
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('entity_id', 'store_id', 'file_id', 'doc_type');

-- ===== 来源 ②：constraints/07-billing-ledger.sql =====
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

-- ===== 来源 ②：constraints/08-billing-payment.sql =====
-- 分组 08-billing-payment：付款单、收款交易、退款、对账、发票（billing 模块的付款部分）
-- 手写约束：CHECK、部分唯一索引、表达式唯一索引、部分索引、防改触发器。
-- 建表、普通索引、全部外键（含复合外键）由 Prisma 片段生成（M46、M47）；通用触发器函数在 00-common.sql。
-- 目标 PostgreSQL 17，语句兼容 14。可空列上的 IN / 比较类 CHECK 在列为 NULL 时放行。

-- billing_order
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_type CHECK (type IN ('plan_new', 'plan_renew', 'plan_upgrade', 'topup'));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_status CHECK (status IN ('pending_payment', 'pending_confirmation', 'paid', 'cancelled', 'refunded'));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_channel CHECK (channel IN ('wechat_jsapi', 'bank_transfer'));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_source CHECK (source IN ('weapp', 'admin'));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_transfer_state CHECK (transfer_state IN ('awaiting_proof', 'proof_submitted', 'proof_rejected', 'confirm_review'));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_fulfillment_status CHECK (fulfillment_status IN ('none', 'done', 'blocked'));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_cancel_reason CHECK (cancel_reason IN ('timeout', 'user', 'staff', 'transfer_ttl', 'amount_mismatch', 'payer_mismatch'));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_client_platform CHECK (client_platform IN ('ios', 'android', 'harmony', 'windows', 'mac', 'devtools', 'unknown'));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_proxy_actor_type CHECK (proxy_actor_type IN ('merchant', 'partner'));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_proxy_client CHECK (proxy_client IN ('weapp', 'portal', 'admin'));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_amount_fen CHECK (amount_fen > 0);
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_paid_amount_fen CHECK (paid_amount_fen >= 0);
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_refunded_amount_fen CHECK (refunded_amount_fen >= 0);
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_content_kind CHECK (jsonb_typeof(content_snapshot) = 'object' AND content_snapshot->>'kind' IS NOT NULL AND ((type IN ('plan_new','plan_renew') AND content_snapshot->>'kind' = 'plan') OR (type = 'plan_upgrade' AND content_snapshot->>'kind' = 'upgrade') OR (type = 'topup' AND content_snapshot->>'kind' = 'topup')));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_channel_fields CHECK ((channel = 'wechat_jsapi' AND transfer_state IS NULL AND bank_account_finance_config_revision_id IS NULL AND status <> 'pending_confirmation') OR (channel = 'bank_transfer' AND bank_account_finance_config_revision_id IS NOT NULL));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_transfer_state_by_status CHECK (channel <> 'bank_transfer' OR (status = 'pending_payment' AND transfer_state IS NOT NULL AND transfer_state IN ('awaiting_proof','proof_rejected')) OR (status = 'pending_confirmation' AND transfer_state IS NOT NULL AND transfer_state IN ('proof_submitted','confirm_review')) OR (status IN ('paid','cancelled','refunded') AND transfer_state IS NULL));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_creator CHECK (num_nonnulls(placed_by_user_id, created_by_staff_id) = 1);
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_admin_source CHECK (source <> 'admin' OR (created_by_staff_id IS NOT NULL AND contract_no IS NOT NULL AND channel = 'bank_transfer'));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_proxy_actor CHECK ((proxy_actor_type IS NULL) = (proxy_actor_id IS NULL) AND (proxy_actor_type IS NULL) = (proxy_client IS NULL));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_paid_facts CHECK ((status IN ('paid','refunded') AND paid_at IS NOT NULL AND paid_payment_txn_id IS NOT NULL AND applied_at IS NOT NULL AND paid_amount_fen > 0) OR (status NOT IN ('paid','refunded') AND paid_at IS NULL AND paid_payment_txn_id IS NULL AND applied_at IS NULL AND paid_amount_fen = 0));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_cancelled CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL) AND (status <> 'cancelled' OR cancelled_at IS NOT NULL));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_refunded CHECK (status <> 'refunded' OR (refunded_at IS NOT NULL AND refunded_amount_fen >= paid_amount_fen));
ALTER TABLE billing_order ADD CONSTRAINT ck_billing_order_fulfillment CHECK ((fulfillment_status = 'done') = (fulfilled_at IS NOT NULL) AND (fulfillment_status = 'none' OR status IN ('paid','refunded')));
CREATE UNIQUE INDEX uq_billing_order_open_plan ON billing_order (entity_id) WHERE status IN ('pending_payment','pending_confirmation') AND type IN ('plan_new','plan_renew','plan_upgrade');
CREATE INDEX ix_billing_order_pending_expires ON billing_order (expires_at) WHERE status = 'pending_payment';
CREATE INDEX ix_billing_order_blocked ON billing_order (paid_at) WHERE fulfillment_status = 'blocked';

-- payment_txn
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_channel CHECK (channel IN ('wechat_jsapi', 'bank_transfer'));
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_status CHECK (status IN ('created', 'prepaid', 'succeeded', 'closed'));
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_recon_state CHECK (recon_state IN ('pending', 'matched', 'diff', 'resolved'));
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_attempt_no CHECK (attempt_no >= 1);
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_amount_fen CHECK (amount_fen > 0);
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_channel_amount_fen CHECK (channel_amount_fen > 0);
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_refunded_fen CHECK (refunded_fen >= 0);
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_query_count CHECK (query_count >= 0);
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_succeeded_facts CHECK (status <> 'succeeded' OR (channel_amount_fen IS NOT NULL AND channel_txn_no IS NOT NULL AND channel_success_at IS NOT NULL));
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_applied CHECK (applied_at IS NULL OR (status = 'succeeded' AND billing_order_id IS NOT NULL));
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_entity CHECK (billing_order_id IS NULL OR entity_id IS NOT NULL);
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_wechat_fields CHECK (channel = 'wechat_jsapi' OR (payer_openid IS NULL AND prepay_id IS NULL AND prepay_expires_at IS NULL AND attach IS NULL AND channel_attach IS NULL AND bank_type IS NULL));
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_bank_fields CHECK (channel = 'bank_transfer' OR (bank_serial_raw IS NULL AND payer_bank IS NULL AND transfer_proof_id IS NULL AND confirmed_by_staff_id IS NULL AND reviewed_by_staff_id IS NULL));
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_bank_confirmed CHECK (channel <> 'bank_transfer' OR (status = 'succeeded' AND bank_serial_raw IS NOT NULL AND confirmed_by_staff_id IS NOT NULL));
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_reviewer CHECK (reviewed_by_staff_id IS NULL OR reviewed_by_staff_id <> confirmed_by_staff_id);
CREATE UNIQUE INDEX uq_payment_txn_channel_txn_no ON payment_txn (channel, channel_txn_no, COALESCE(payer_bank, '')) WHERE channel_txn_no IS NOT NULL;
CREATE UNIQUE INDEX uq_payment_txn_open_attempt ON payment_txn (billing_order_id) WHERE status IN ('created','prepaid');
CREATE UNIQUE INDEX uq_payment_txn_applied ON payment_txn (billing_order_id) WHERE applied_at IS NOT NULL;
CREATE INDEX ix_payment_txn_payer_success ON payment_txn (payer_openid, channel_success_at) WHERE status = 'succeeded';
CREATE INDEX ix_payment_txn_unapplied ON payment_txn (channel_success_at) WHERE status = 'succeeded' AND applied_at IS NULL;

-- transfer_proof
ALTER TABLE transfer_proof ADD CONSTRAINT ck_transfer_proof_review_status CHECK (review_status IN ('pending', 'accepted', 'rejected', 'superseded'));
ALTER TABLE transfer_proof ADD CONSTRAINT ck_transfer_proof_upload_no CHECK (upload_no >= 1);
ALTER TABLE transfer_proof ADD CONSTRAINT ck_transfer_proof_uploader CHECK (num_nonnulls(uploaded_by_user_id, uploaded_by_staff_id) = 1);
ALTER TABLE transfer_proof ADD CONSTRAINT ck_transfer_proof_reviewed CHECK ((review_status <> 'pending' OR (reviewed_by_staff_id IS NULL AND reviewed_at IS NULL)) AND (review_status NOT IN ('accepted','rejected') OR (reviewed_by_staff_id IS NOT NULL AND reviewed_at IS NOT NULL)));
ALTER TABLE transfer_proof ADD CONSTRAINT ck_transfer_proof_rejected CHECK (review_status <> 'rejected' OR (reject_reason_code IS NOT NULL AND reject_note IS NOT NULL));
ALTER TABLE transfer_proof ADD CONSTRAINT ck_transfer_proof_reject_note CHECK (char_length(reject_note) <= 200);
ALTER TABLE transfer_proof ADD CONSTRAINT ck_transfer_proof_first_confirm CHECK (first_confirm IS NULL OR review_approval_request_id IS NOT NULL);
ALTER TABLE transfer_proof ADD CONSTRAINT ck_transfer_proof_sla CHECK ((due_at IS NULL) = (sla_snapshot IS NULL));
CREATE UNIQUE INDEX uq_transfer_proof_pending ON transfer_proof (billing_order_id) WHERE review_status = 'pending';
CREATE INDEX ix_transfer_proof_pending_due ON transfer_proof (due_at) WHERE review_status = 'pending';

-- refund_request
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_source CHECK (source IN ('customer_service', 'exception'));
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_rule_code CHECK (rule_code IN ('window', 'qualification_failed', 'override', 'fulfillment_blocked', 'unapplied_receipt'));
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_status CHECK (status IN ('pending_approval', 'pending_execution', 'executing', 'done', 'not_executed'));
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_exec_route CHECK (exec_route IN ('wechat_original', 'offline'));
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_close_reason CHECK (close_reason IN ('rejected', 'withdrawn', 'voided'));
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_amount CHECK (amount_fen = base_amount_fen - deduct_amount_fen AND amount_fen > 0 AND deduct_amount_fen >= 0);
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_rule_source CHECK ((source = 'exception') = (rule_code IN ('fulfillment_blocked','unapplied_receipt')));
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_override CHECK (is_override = (rule_code = 'override'));
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_reason CHECK ((source = 'customer_service') = (reason_code IS NOT NULL));
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_subject CHECK ((billing_order_id IS NOT NULL OR rule_code = 'unapplied_receipt') AND (entity_id IS NOT NULL OR billing_order_id IS NULL));
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_closed CHECK ((closed_at IS NOT NULL) = (status IN ('done','not_executed')) AND (close_reason IS NOT NULL) = (status = 'not_executed'));
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_voided CHECK ((close_reason IS NOT DISTINCT FROM 'voided') = (voided_by_staff_id IS NOT NULL) AND (close_reason IS NOT DISTINCT FROM 'voided') = (close_note IS NOT NULL));
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_executed CHECK (status NOT IN ('executing','done') OR (exec_route IS NOT NULL AND executed_by_staff_id IS NOT NULL AND executed_at IS NOT NULL));
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_executing_route CHECK (status <> 'executing' OR exec_route = 'wechat_original');
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_done CHECK ((status = 'done') = (done_at IS NOT NULL));
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_revoked CHECK (entitlement_revoked_at IS NULL OR (status IN ('pending_execution','executing','done') AND rule_code IN ('window','qualification_failed','override')));
-- 执行时限在审批通过时写入，与参数快照同有同无（与 09 的 ck_cancel_request_sla 同义）；审批中、驳回、撤回没有，审批通过之后（待执行、执行中、已退款、作废）必有
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_sla CHECK ((exec_due_at IS NULL) = (sla_snapshot IS NULL) AND (exec_due_at IS NULL) = (status = 'pending_approval' OR COALESCE(close_reason IN ('rejected','withdrawn'), false)));
CREATE UNIQUE INDEX uq_refund_request_open_payment_txn ON refund_request (payment_txn_id) WHERE closed_at IS NULL;
CREATE INDEX ix_refund_request_open_billing_order ON refund_request (billing_order_id) WHERE closed_at IS NULL AND rule_code <> 'unapplied_receipt';

-- refund_txn
ALTER TABLE refund_txn ADD CONSTRAINT ck_refund_txn_channel CHECK (channel IN ('wechat_jsapi', 'offline'));
ALTER TABLE refund_txn ADD CONSTRAINT ck_refund_txn_origin CHECK (origin IN ('system', 'external'));
ALTER TABLE refund_txn ADD CONSTRAINT ck_refund_txn_status CHECK (status IN ('created', 'processing', 'succeeded', 'closed', 'abnormal', 'not_accepted', 'abandoned'));
ALTER TABLE refund_txn ADD CONSTRAINT ck_refund_txn_recon_state CHECK (recon_state IN ('pending', 'matched', 'diff', 'resolved'));
ALTER TABLE refund_txn ADD CONSTRAINT ck_refund_txn_amount_fen CHECK (amount_fen > 0);
ALTER TABLE refund_txn ADD CONSTRAINT ck_refund_txn_submit_count CHECK (submit_count >= 0);
ALTER TABLE refund_txn ADD CONSTRAINT ck_refund_txn_succeeded CHECK (status <> 'succeeded' OR success_at IS NOT NULL);
ALTER TABLE refund_txn ADD CONSTRAINT ck_refund_txn_late_success CHECK (NOT is_late_success OR status = 'succeeded');
ALTER TABLE refund_txn ADD CONSTRAINT ck_refund_txn_entity CHECK (billing_order_id IS NULL OR entity_id IS NOT NULL);
ALTER TABLE refund_txn ADD CONSTRAINT ck_refund_txn_request CHECK (refund_request_id IS NOT NULL OR origin = 'external' OR channel = 'offline');
ALTER TABLE refund_txn ADD CONSTRAINT ck_refund_txn_external CHECK (origin <> 'external' OR (channel = 'wechat_jsapi' AND status = 'succeeded'));
ALTER TABLE refund_txn ADD CONSTRAINT ck_refund_txn_offline CHECK ((channel = 'offline' AND status = 'succeeded' AND transfer_date IS NOT NULL AND channel_refund_no IS NOT NULL AND payee_name IS NOT NULL AND payee_bank IS NOT NULL AND payee_account_enc IS NOT NULL AND payee_account_mask IS NOT NULL AND receipt_file_id IS NOT NULL AND registered_by_staff_id IS NOT NULL) OR (channel <> 'offline' AND transfer_date IS NULL AND payee_name IS NULL AND payee_bank IS NULL AND payee_account_enc IS NULL AND payee_account_mask IS NULL AND receipt_file_id IS NULL AND registered_by_staff_id IS NULL));
CREATE UNIQUE INDEX uq_refund_txn_open ON refund_txn (refund_request_id) WHERE status IN ('created','processing','abnormal');
CREATE UNIQUE INDEX uq_refund_txn_channel_refund_no ON refund_txn (channel, channel_refund_no) WHERE channel_refund_no IS NOT NULL;
CREATE INDEX ix_refund_txn_open_submit ON refund_txn (last_submit_at) WHERE status IN ('created','processing','abnormal');

-- payment_exception
ALTER TABLE payment_exception ADD CONSTRAINT ck_payment_exception_kind CHECK (kind IN ('paid_after_cancel', 'amount_mismatch', 'payer_mismatch', 'duplicate_receipt', 'fulfillment_blocked', 'bill_only', 'platform_only', 'status_mismatch', 'bank_unmatched', 'refund_bill_only', 'refund_platform_only', 'refund_amount_mismatch', 'refund_over', 'entitlement_unrecovered'));
ALTER TABLE payment_exception ADD CONSTRAINT ck_payment_exception_detected_by CHECK (detected_by IN ('callback', 'query', 'apply', 'reconciliation', 'manual'));
ALTER TABLE payment_exception ADD CONSTRAINT ck_payment_exception_status CHECK (status IN ('open', 'resolving', 'resolved', 'auto_healed', 'ignored'));
ALTER TABLE payment_exception ADD CONSTRAINT ck_payment_exception_resolution CHECK (resolution IN ('restore', 'refund', 'retried', 'rebuild_order', 'link_order', 'offline_return', 'record_channel_refund', 'corrected', 'written_off', 'none'));
ALTER TABLE payment_exception ADD CONSTRAINT ck_payment_exception_amount_fen CHECK (amount_fen >= 0);
ALTER TABLE payment_exception ADD CONSTRAINT ck_payment_exception_resolution_note CHECK (char_length(resolution_note) <= 200);
ALTER TABLE payment_exception ADD CONSTRAINT ck_payment_exception_open CHECK (status <> 'open' OR (resolution = 'none' AND resolution_note IS NULL AND resolved_at IS NULL AND resolved_by_staff_id IS NULL AND refund_request_id IS NULL));
ALTER TABLE payment_exception ADD CONSTRAINT ck_payment_exception_resolving CHECK (status <> 'resolving' OR (resolution = 'refund' AND refund_request_id IS NOT NULL AND resolution_note IS NOT NULL AND resolved_by_staff_id IS NOT NULL AND resolved_at IS NULL));
ALTER TABLE payment_exception ADD CONSTRAINT ck_payment_exception_resolved CHECK (status <> 'resolved' OR (resolution <> 'none' AND resolution_note IS NOT NULL AND resolved_by_staff_id IS NOT NULL AND resolved_at IS NOT NULL));
ALTER TABLE payment_exception ADD CONSTRAINT ck_payment_exception_refund_link CHECK (refund_request_id IS NULL OR resolution = 'refund');

-- wx_bill_file
ALTER TABLE wx_bill_file ADD CONSTRAINT ck_wx_bill_file_bill_type CHECK (bill_type IN ('trade_all'));
ALTER TABLE wx_bill_file ADD CONSTRAINT ck_wx_bill_file_status CHECK (status IN ('pending', 'downloaded', 'parsed', 'empty', 'failed'));
ALTER TABLE wx_bill_file ADD CONSTRAINT ck_wx_bill_file_downloaded CHECK (status NOT IN ('downloaded','parsed') OR (file_id IS NOT NULL AND downloaded_at IS NOT NULL));
ALTER TABLE wx_bill_file ADD CONSTRAINT ck_wx_bill_file_counts CHECK (attempt_count >= 0 AND (line_count IS NULL OR line_count >= 0));

-- wx_bill_line
ALTER TABLE wx_bill_line ADD CONSTRAINT ck_wx_bill_line_line_kind CHECK (line_kind IN ('payment', 'refund'));
ALTER TABLE wx_bill_line ADD CONSTRAINT ck_wx_bill_line_match_state CHECK (match_state IN ('matched', 'matched_pending', 'diff', 'unmatched', 'foreign'));
ALTER TABLE wx_bill_line ADD CONSTRAINT ck_wx_bill_line_line_no CHECK (line_no >= 1);
ALTER TABLE wx_bill_line ADD CONSTRAINT ck_wx_bill_line_foreign CHECK (is_foreign = (match_state = 'foreign'));
ALTER TABLE wx_bill_line ADD CONSTRAINT ck_wx_bill_line_refund CHECK (line_kind <> 'refund' OR (out_refund_no IS NOT NULL AND refund_amount_fen IS NOT NULL));
ALTER TABLE wx_bill_line ADD CONSTRAINT ck_wx_bill_line_matched CHECK (match_state NOT IN ('matched','matched_pending') OR matched_payment_txn_id IS NOT NULL OR matched_refund_txn_id IS NOT NULL);

-- recon_day
ALTER TABLE recon_day ADD CONSTRAINT ck_recon_day_channel CHECK (channel IN ('wechat_jsapi', 'bank_transfer'));
ALTER TABLE recon_day ADD CONSTRAINT ck_recon_day_status CHECK (status IN ('wait', 'ok', 'diff', 'fixed'));
ALTER TABLE recon_day ADD CONSTRAINT ck_recon_day_counts CHECK (platform_pay_count >= 0 AND bill_pay_count >= 0 AND platform_refund_count >= 0 AND bill_refund_count >= 0 AND bank_count >= 0 AND diff_count >= 0 AND run_count >= 0);
ALTER TABLE recon_day ADD CONSTRAINT ck_recon_day_amounts CHECK (platform_pay_fen >= 0 AND bill_pay_fen >= 0 AND platform_refund_fen >= 0 AND bill_refund_fen >= 0 AND bank_fen >= 0 AND diff_fen >= 0);

-- invoice_request
ALTER TABLE invoice_request ADD CONSTRAINT ck_invoice_request_invoice_type CHECK (invoice_type IN ('normal', 'special'));
ALTER TABLE invoice_request ADD CONSTRAINT ck_invoice_request_medium CHECK (medium IN ('electronic', 'paper'));
ALTER TABLE invoice_request ADD CONSTRAINT ck_invoice_request_status CHECK (status IN ('pending', 'issued', 'rejected', 'red_pending', 'red_issued'));
ALTER TABLE invoice_request ADD CONSTRAINT ck_invoice_request_reject_kind CHECK (reject_kind IN ('manual', 'order_refunded'));
ALTER TABLE invoice_request ADD CONSTRAINT ck_invoice_request_provider CHECK (provider IN ('manual'));
ALTER TABLE invoice_request ADD CONSTRAINT ck_invoice_request_amount_fen CHECK (amount_fen > 0);
ALTER TABLE invoice_request ADD CONSTRAINT ck_invoice_request_type_medium CHECK (invoice_type = 'special' OR medium = 'electronic');
ALTER TABLE invoice_request ADD CONSTRAINT ck_invoice_request_special_fields CHECK (invoice_type <> 'special' OR (addr_tel_enc IS NOT NULL AND bank_account_enc IS NOT NULL));
ALTER TABLE invoice_request ADD CONSTRAINT ck_invoice_request_recipient CHECK ((medium = 'electronic' AND recv_email_enc IS NOT NULL) OR (medium = 'paper' AND mail_to_enc IS NOT NULL));
ALTER TABLE invoice_request ADD CONSTRAINT ck_invoice_request_enc_mask CHECK ((addr_tel_enc IS NULL) = (addr_tel_mask IS NULL) AND (bank_account_enc IS NULL) = (bank_account_mask IS NULL) AND (recv_email_enc IS NULL) = (recv_email_mask IS NULL) AND (mail_to_enc IS NULL) = (mail_to_mask IS NULL));
ALTER TABLE invoice_request ADD CONSTRAINT ck_invoice_request_rejected CHECK ((status = 'rejected') = (rejected_at IS NOT NULL) AND (status = 'rejected') = (reject_kind IS NOT NULL) AND (reject_kind IS NOT DISTINCT FROM 'manual') = (reject_reason_code IS NOT NULL) AND (reject_kind IS NOT DISTINCT FROM 'manual') = (rejected_by_staff_id IS NOT NULL));
ALTER TABLE invoice_request ADD CONSTRAINT ck_invoice_request_reject_note CHECK (char_length(reject_note) <= 200);
ALTER TABLE invoice_request ADD CONSTRAINT ck_invoice_request_sla CHECK ((due_at IS NULL) = (sla_snapshot IS NULL));
CREATE UNIQUE INDEX uq_invoice_request_active ON invoice_request (billing_order_id) WHERE status IN ('pending','issued','red_pending');
CREATE INDEX ix_invoice_request_pending_due ON invoice_request (due_at) WHERE status = 'pending';

-- invoice_doc
ALTER TABLE invoice_doc ADD CONSTRAINT ck_invoice_doc_doc_kind CHECK (doc_kind IN ('blue', 'red'));
ALTER TABLE invoice_doc ADD CONSTRAINT ck_invoice_doc_file_format CHECK (file_format IN ('pdf', 'ofd', 'xml'));
ALTER TABLE invoice_doc ADD CONSTRAINT ck_invoice_doc_email_state CHECK (email_state IN ('none', 'queued', 'sent', 'failed', 'skipped'));
ALTER TABLE invoice_doc ADD CONSTRAINT ck_invoice_doc_amount CHECK ((doc_kind = 'blue' AND amount_fen > 0) OR (doc_kind = 'red' AND amount_fen < 0));
ALTER TABLE invoice_doc ADD CONSTRAINT ck_invoice_doc_red CHECK ((doc_kind = 'red') = (original_invoice_doc_id IS NOT NULL) AND (original_invoice_doc_id IS NULL OR original_invoice_doc_id <> id));
ALTER TABLE invoice_doc ADD CONSTRAINT ck_invoice_doc_file CHECK ((file_id IS NULL) = (file_format IS NULL));
ALTER TABLE invoice_doc ADD CONSTRAINT ck_invoice_doc_express CHECK ((express_company IS NULL) = (tracking_no IS NULL));
ALTER TABLE invoice_doc ADD CONSTRAINT ck_invoice_doc_email_sent CHECK (email_state <> 'sent' OR email_sent_at IS NOT NULL);
CREATE UNIQUE INDEX uq_invoice_doc_code_no ON invoice_doc (COALESCE(invoice_code, ''), invoice_no);

-- finance_config_revision
ALTER TABLE finance_config_revision ADD CONSTRAINT ck_finance_config_revision_config_key CHECK (config_key IN ('bank_account', 'purchase_policy', 'controls'));
ALTER TABLE finance_config_revision ADD CONSTRAINT ck_finance_config_revision_account_no CHECK ((config_key = 'bank_account') = (account_no_enc IS NOT NULL) AND (account_no_enc IS NULL) = (account_no_mask IS NULL));
ALTER TABLE finance_config_revision ADD CONSTRAINT ck_finance_config_revision_change_note CHECK (char_length(btrim(change_note)) > 0);
CREATE INDEX ix_finance_config_revision_effective ON finance_config_revision (config_key, effective_at DESC) WHERE effective_at IS NOT NULL;
CREATE TRIGGER trg_finance_config_revision_write_once BEFORE UPDATE OR DELETE ON finance_config_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_write_once('effective_at');
CREATE TRIGGER trg_finance_config_revision_no_truncate BEFORE TRUNCATE ON finance_config_revision
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- ===== 来源 ②：constraints/09-order-ad.sql =====
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

-- ===== 来源 ②：constraints/10-delivery.sql =====
-- 分组 10-delivery：交付工单、方案、样片、成片、质检、成片包（delivery）的手写约束。
-- 依据：docs/appendix/design/d3-flow.md 第 7、8、10、11 节；d5-media.md 第 4.7、8 节；docs/data-model/10-delivery.md。
-- 只含 Prisma 表达不了的约束：CHECK、数组列的 NOT NULL、部分唯一索引、部分索引、触发器。
-- 外键（含归属复合外键、指向 staff / merchant_user 的多条关系）全部由 Prisma 片段生成（M46、M47）。

-- delivery_ticket
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_step
  CHECK (step IN ('assigning','plan_confirm','ad_prep','sample_making','sample_confirm','batch_compose',
                  'delivering','awaiting_launch','launch_verify','in_service','takedown','archived','terminated'));
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_waiting_on
  CHECK (waiting_on IN ('staff','merchant','none'));
-- 制作排期：取值与 billing 的 plan_revision、subscription_term 相同。
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_schedule_priority
  CHECK (schedule_priority IN ('standard','priority','rush'));
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_sample_no
  CHECK (sample_round_no >= 0 AND current_sample_version_no >= 1);
-- 暂停三列一致：未暂停时两列为空；暂停时有起始时间，剩余分钟不为负。
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_pause
  CHECK (pause_count >= 0
         AND (pause_count > 0) = (paused_at IS NOT NULL)
         AND (pause_count > 0 OR pause_remaining_min IS NULL)
         AND pause_remaining_min >= 0);
-- 暂停只发生在步骤 1～9（待分配至上线核验）。
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_pause_steps
  CHECK (pause_count = 0 OR step IN ('assigning','plan_confirm','ad_prep','sample_making','sample_confirm',
                                     'batch_compose','delivering','awaiting_launch','launch_verify'));
-- 离开待分配之后必有交付经理（从待分配直接终止的除外）。
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_delivery_manager_required
  CHECK (step IN ('assigning','terminated') OR delivery_manager_id IS NOT NULL);
-- 终态与里程碑时间一一对应。
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_archived
  CHECK ((step = 'archived') = (archived_at IS NOT NULL));
ALTER TABLE delivery_ticket ADD CONSTRAINT ck_delivery_ticket_terminated
  CHECK ((step = 'terminated') = (terminated_at IS NOT NULL));
-- 工单池与超时扫描：只扫在办工单。
CREATE INDEX ix_delivery_ticket_step_step_due_at ON delivery_ticket (step, step_due_at)
  WHERE step NOT IN ('archived','terminated');

-- delivery_ticket_stage
ALTER TABLE delivery_ticket_stage ADD CONSTRAINT ck_delivery_ticket_stage_step
  CHECK (step IN ('assigning','plan_confirm','ad_prep','sample_making','sample_confirm','batch_compose',
                  'delivering','awaiting_launch','launch_verify','in_service','takedown'));
ALTER TABLE delivery_ticket_stage ADD CONSTRAINT ck_delivery_ticket_stage_visit_no
  CHECK (visit_no >= 1);
ALTER TABLE delivery_ticket_stage ADD CONSTRAINT ck_delivery_ticket_stage_paused_minutes
  CHECK (paused_minutes >= 0);
-- 完成时间与离开事件同时有或同时无；完成不早于进入。
ALTER TABLE delivery_ticket_stage ADD CONSTRAINT ck_delivery_ticket_stage_completed
  CHECK ((completed_at IS NULL) = (exit_event IS NULL) AND completed_at >= entered_at);
ALTER TABLE delivery_ticket_stage ADD CONSTRAINT ck_delivery_ticket_stage_exit_event
  CHECK (exit_event ~ '^[a-z][a-z0-9_.]{1,63}$');
ALTER TABLE delivery_ticket_stage ADD CONSTRAINT ck_delivery_ticket_stage_sla_snapshot
  CHECK (sla_snapshot IS NULL OR jsonb_typeof(sla_snapshot) = 'object');
-- 一张工单同时至多一个未完成的环节。
CREATE UNIQUE INDEX uq_delivery_ticket_stage_open ON delivery_ticket_stage (delivery_ticket_id)
  WHERE completed_at IS NULL;
-- 超时环节统计（按环节、周期分组）。
CREATE INDEX ix_delivery_ticket_stage_breached ON delivery_ticket_stage (step, entered_at)
  WHERE is_breached;

-- delivery_ticket_pause
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_reason
  CHECK (reason IN ('cancel_review','plan_amendment'));
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_ref_type
  CHECK (ref_type IN ('approval_request','delivery_plan_version'));
-- 原因决定引用对象：取消审批引用审批单，方案修订引用方案版本。
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_reason_ref
  CHECK ((reason = 'cancel_review' AND ref_type = 'approval_request')
      OR (reason = 'plan_amendment' AND ref_type = 'delivery_plan_version'));
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_actor_type
  CHECK (actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_client
  CHECK (client IN ('weapp','portal','admin'));
-- 系统动作没有操作人 id 与客户端来源；其余类型两者都有（M44）。
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_actor
  CHECK ((actor_type = 'system') = (actor_id IS NULL)
         AND (actor_type = 'system') = (client IS NULL));
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_release_event
  CHECK (release_event IN ('rejected','withdrawn','voided','plan_confirmed','superseded','terminated','self_heal'));
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_released
  CHECK ((released_at IS NULL) = (release_event IS NULL));
-- 解除事件与原因匹配：驳回、撤回、通过后作废只属于取消审批（与 cancel_request.close_reason 同名，M54）；
-- 方案确认、被新版本取代只属于方案修订。
ALTER TABLE delivery_ticket_pause ADD CONSTRAINT ck_delivery_ticket_pause_release_event_reason
  CHECK (release_event IS NULL
      OR release_event IN ('terminated','self_heal')
      OR (reason = 'cancel_review' AND release_event IN ('rejected','withdrawn','voided'))
      OR (reason = 'plan_amendment' AND release_event IN ('plan_confirmed','superseded')));
-- 未解除的暂停原因：求 pause_count、恢复时判断集合是否为空。
CREATE INDEX ix_delivery_ticket_pause_open ON delivery_ticket_pause (delivery_ticket_id)
  WHERE released_at IS NULL;

-- delivery_plan
ALTER TABLE delivery_plan ADD CONSTRAINT ck_delivery_plan_status
  CHECK (status IN ('drafting','pending_confirm','revising','confirmed'));
ALTER TABLE delivery_plan ADD CONSTRAINT ck_delivery_plan_draft
  CHECK (jsonb_typeof(draft) = 'object');
ALTER TABLE delivery_plan ADD CONSTRAINT ck_delivery_plan_version_no
  CHECK (draft_lock_version >= 0 AND current_version_no >= 0
         AND confirmed_version_no BETWEEN 1 AND current_version_no);
-- 起草中当且仅当尚未推送过。
ALTER TABLE delivery_plan ADD CONSTRAINT ck_delivery_plan_drafting
  CHECK ((status = 'drafting') = (current_version_no = 0)
         AND (current_version_no = 0) = (pushed_at IS NULL));
-- 已确认：确认的就是当前版本；确认版本号与确认时间同时有或同时无。
ALTER TABLE delivery_plan ADD CONSTRAINT ck_delivery_plan_confirmed
  CHECK ((confirmed_version_no IS NULL) = (confirmed_at IS NULL)
         AND (status <> 'confirmed'
              OR (confirmed_version_no IS NOT NULL AND confirmed_version_no = current_version_no)));

-- delivery_plan_version
ALTER TABLE delivery_plan_version ADD CONSTRAINT ck_delivery_plan_version_version_no
  CHECK (version_no >= 1);
ALTER TABLE delivery_plan_version ADD CONSTRAINT ck_delivery_plan_version_content_snapshot
  CHECK (jsonb_typeof(content_snapshot) = 'object');
ALTER TABLE delivery_plan_version ADD CONSTRAINT ck_delivery_plan_version_decision
  CHECK (decision IN ('confirmed','change_requested','superseded'));
ALTER TABLE delivery_plan_version ADD CONSTRAINT ck_delivery_plan_version_decide_actor_type
  CHECK (decide_actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE delivery_plan_version ADD CONSTRAINT ck_delivery_plan_version_decide_client
  CHECK (decide_client IN ('weapp','portal','admin'));
-- 决定、时间、决定人类型同时有或同时无；系统动作没有操作人 id 与客户端来源，其余类型两者都有（M44）。
ALTER TABLE delivery_plan_version ADD CONSTRAINT ck_delivery_plan_version_decided
  CHECK ((decision IS NULL) = (decided_at IS NULL)
         AND (decision IS NULL) = (decide_actor_type IS NULL)
         AND (decide_actor_type IS NULL
              OR ((decide_actor_type = 'system') = (decide_actor_id IS NULL)
                  AND (decide_actor_type = 'system') = (decide_client IS NULL)))
         AND (decide_actor_type IS NOT NULL OR (decide_actor_id IS NULL AND decide_client IS NULL)));
-- 内容快照不可变：只允许把决定相关的五列从空写一次，其余列不可改，不可删。
CREATE TRIGGER trg_delivery_plan_version_write_once BEFORE UPDATE OR DELETE ON delivery_plan_version
  FOR EACH ROW EXECUTE FUNCTION lyx_write_once('decision', 'decided_at', 'decide_actor_type', 'decide_actor_id', 'decide_client');

-- delivery_plan_change_request
-- Prisma 给标量数组列建的是可空列，这里补 NOT NULL。
-- lyx:allow 首版迁移，表刚建出来、没有数据：Prisma 把标量数组列建成可空，这里补非空；该列没有默认值
ALTER TABLE delivery_plan_change_request ALTER COLUMN kinds SET NOT NULL;
ALTER TABLE delivery_plan_change_request ADD CONSTRAINT ck_delivery_plan_change_request_kinds
  CHECK (cardinality(kinds) >= 1
         AND kinds <@ ARRAY['launch_date','account','customization','placement','ad','other']::text[]);
ALTER TABLE delivery_plan_change_request ADD CONSTRAINT ck_delivery_plan_change_request_note
  CHECK (char_length(btrim(note)) > 0);
ALTER TABLE delivery_plan_change_request ADD CONSTRAINT ck_delivery_plan_change_request_on_version_no
  CHECK (on_version_no >= 1);
-- 只能被更晚的版本解决。
ALTER TABLE delivery_plan_change_request ADD CONSTRAINT ck_delivery_plan_change_request_resolved_by_version_no
  CHECK (resolved_by_version_no > on_version_no);
-- 未解决的修改请求：推送新版本时回写 resolved_by_version_no。
CREATE INDEX ix_delivery_plan_change_request_open ON delivery_plan_change_request (delivery_plan_id)
  WHERE resolved_by_version_no IS NULL;

-- sample
-- Prisma 给标量数组列建的是可空列，这里补 NOT NULL。
ALTER TABLE sample ALTER COLUMN preview_channels SET NOT NULL;
ALTER TABLE sample ALTER COLUMN feedback_file_ids SET NOT NULL;
ALTER TABLE sample ADD CONSTRAINT ck_sample_status
  CHECK (status IN ('uploaded','check_rejected','qc_rejected','qc_passed','pushed','confirmed','change_requested','superseded'));
ALTER TABLE sample ADD CONSTRAINT ck_sample_version_no
  CHECK (version_no >= 1);
-- 时长在体检通过时回写：进入质检及以后的状态必有，且大于 0。
ALTER TABLE sample ADD CONSTRAINT ck_sample_duration_ms
  CHECK (duration_ms > 0
         AND (status NOT IN ('qc_rejected','qc_passed','pushed','confirmed','change_requested')
              OR duration_ms IS NOT NULL));
ALTER TABLE sample ADD CONSTRAINT ck_sample_ad_slots
  CHECK (jsonb_typeof(ad_slots) = 'array');
ALTER TABLE sample ADD CONSTRAINT ck_sample_ad_versions_used
  CHECK (jsonb_typeof(ad_versions_used) = 'array');
ALTER TABLE sample ADD CONSTRAINT ck_sample_preview_channels
  CHECK (preview_channels <@ ARRAY['weapp','album','portal','wecom']::text[]);
ALTER TABLE sample ADD CONSTRAINT ck_sample_confirm_viewed_via
  CHECK (confirm_viewed_via IN ('weapp','album','portal','wecom'));
ALTER TABLE sample ADD CONSTRAINT ck_sample_decide_client
  CHECK (decide_client IN ('weapp','portal','admin'));
-- 决定人：决定时间、客户端来源与决定人同时有或同时无；决定人恰为商家用户或代录员工之一；代录来自后台，商家不从后台决定。
ALTER TABLE sample ADD CONSTRAINT ck_sample_decided
  CHECK ((decided_at IS NULL) = (decide_client IS NULL)
         AND (decided_at IS NULL) = (decided_by_user_id IS NULL AND on_behalf_staff_id IS NULL)
         AND NOT (decided_by_user_id IS NOT NULL AND on_behalf_staff_id IS NOT NULL)
         AND (on_behalf_staff_id IS NULL OR decide_client = 'admin')
         AND (decided_by_user_id IS NULL OR decide_client <> 'admin'));
ALTER TABLE sample ADD CONSTRAINT ck_sample_feedback_kind
  CHECK (feedback_kind IN ('compose','ad_content'));
ALTER TABLE sample ADD CONSTRAINT ck_sample_feedback_time_ms
  CHECK (feedback_time_ms >= 0);
-- 质检过的版本必有质检记录。
ALTER TABLE sample ADD CONSTRAINT ck_sample_qc_record
  CHECK (status NOT IN ('qc_rejected','qc_passed','pushed','confirmed','change_requested') OR qc_record_id IS NOT NULL);
-- 推送人与推送时间同时有或同时无；推送过的版本必有；推送时至少确定一种查看方式。
ALTER TABLE sample ADD CONSTRAINT ck_sample_pushed
  CHECK ((pushed_at IS NULL) = (pushed_by_staff_id IS NULL)
         AND (status NOT IN ('pushed','confirmed','change_requested') OR pushed_at IS NOT NULL)
         AND (pushed_at IS NULL OR cardinality(preview_channels) >= 1));
-- 线下提供：时间与操作人同时有或同时无；查看方式含企业微信时必须已标记“已发送”。
ALTER TABLE sample ADD CONSTRAINT ck_sample_offline_sent
  CHECK ((offline_sent_at IS NULL) = (offline_sent_by_staff_id IS NULL)
         AND (NOT ('wecom' = ANY (preview_channels)) OR offline_sent_at IS NOT NULL));
-- “我已查看”的勾选：时间与用户同时有或同时无。
ALTER TABLE sample ADD CONSTRAINT ck_sample_viewed_ack
  CHECK ((viewed_ack_at IS NULL) = (viewed_ack_by_user_id IS NULL));
-- 已确认：由商家本人确认，带查看方式，且查看方式在推送时确定的集合内；不是小程序内播放的必须勾选过“我已查看”。
ALTER TABLE sample ADD CONSTRAINT ck_sample_confirmed
  CHECK (status <> 'confirmed'
      OR (decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL AND on_behalf_staff_id IS NULL
          AND confirm_viewed_via IS NOT NULL AND confirm_viewed_via = ANY (preview_channels)
          AND (confirm_viewed_via = 'weapp' OR viewed_ack_at IS NOT NULL)));
-- 查看方式声明只在确认时填写。
ALTER TABLE sample ADD CONSTRAINT ck_sample_confirm_viewed_via_status
  CHECK (confirm_viewed_via IS NULL OR status IN ('confirmed','superseded'));
-- 提出修改：有类型、有意见；由商家提出或交付经理代录，二者必居其一。
ALTER TABLE sample ADD CONSTRAINT ck_sample_change_requested
  CHECK (status <> 'change_requested'
      OR (decided_at IS NOT NULL AND feedback_kind IS NOT NULL
          AND feedback_note IS NOT NULL AND char_length(btrim(feedback_note)) > 0
          AND (decided_by_user_id IS NOT NULL) <> (on_behalf_staff_id IS NOT NULL)));
-- 修改意见的类型与正文同时有或同时无。
ALTER TABLE sample ADD CONSTRAINT ck_sample_feedback
  CHECK ((feedback_kind IS NULL) = (feedback_note IS NULL)
         AND (feedback_kind IS NOT NULL OR (feedback_time_ms IS NULL AND cardinality(feedback_file_ids) = 0)));
-- 一张工单同时至多一个“活着”的样片版本（待质检、质检通过、已推送、已确认）；上传新版本前先把旧版本置 superseded。
CREATE UNIQUE INDEX uq_sample_live ON sample (delivery_ticket_id)
  WHERE status IN ('uploaded','qc_passed','pushed','confirmed');

-- episode_output
ALTER TABLE episode_output ADD CONSTRAINT ck_episode_output_variant
  CHECK (variant IN ('common','douyin','wechat_channels'));
-- normalized：云端规格化产物（admin.productionRecord.normalize 生成，剪辑师登记；接口裁决 A142）。
ALTER TABLE episode_output ADD CONSTRAINT ck_episode_output_source
  CHECK (source IN ('manual_upload','normalized','sample_adopted','restamped','auto_compose'));
ALTER TABLE episode_output ADD CONSTRAINT ck_episode_output_status
  CHECK (status IN ('uploaded','check_rejected','qc_passed','qc_rejected','replaced'));
ALTER TABLE episode_output ADD CONSTRAINT ck_episode_output_no
  CHECK (episode_no >= 1 AND revision_no >= 1);
ALTER TABLE episode_output ADD CONSTRAINT ck_episode_output_size
  CHECK (size_bytes > 0 AND duration_ms > 0);
-- 当前版本必须质检通过。
ALTER TABLE episode_output ADD CONSTRAINT ck_episode_output_current
  CHECK (NOT is_current OR status = 'qc_passed');
-- 质检过的版本必有质检记录。
ALTER TABLE episode_output ADD CONSTRAINT ck_episode_output_qc_record
  CHECK (status NOT IN ('qc_passed','qc_rejected') OR qc_record_id IS NOT NULL);
-- 每集每变体至多一个当前版本；换版时先把旧行的 is_current 置假。
CREATE UNIQUE INDEX uq_episode_output_current ON episode_output (delivery_ticket_id, episode_no, variant)
  WHERE is_current;

-- qc_record
-- 成片包级质检在推送之前，对象是工单（M70）。
ALTER TABLE qc_record ADD CONSTRAINT ck_qc_record_target_type
  CHECK (target_type IN ('sample','episode_output','delivery_ticket'));
-- 成片包级质检的对象就是本行所属的工单。
ALTER TABLE qc_record ADD CONSTRAINT ck_qc_record_target_id
  CHECK (target_type <> 'delivery_ticket' OR target_id = delivery_ticket_id);
-- 对象类型决定清单模板。
ALTER TABLE qc_record ADD CONSTRAINT ck_qc_record_checklist_code
  CHECK ((target_type = 'sample' AND checklist_code = 'qc.sample')
      OR (target_type = 'episode_output' AND checklist_code = 'qc.episode')
      OR (target_type = 'delivery_ticket' AND checklist_code = 'qc.package'));
ALTER TABLE qc_record ADD CONSTRAINT ck_qc_record_checklist_version_no
  CHECK (checklist_version_no >= 1);
ALTER TABLE qc_record ADD CONSTRAINT ck_qc_record_results
  CHECK (jsonb_typeof(results) = 'array');
ALTER TABLE qc_record ADD CONSTRAINT ck_qc_record_verdict
  CHECK (verdict IN ('pass','fail'));
-- 不通过必须写原因（去掉首尾空白后非空）；通过不写原因。
ALTER TABLE qc_record ADD CONSTRAINT ck_qc_record_reject_reason
  CHECK ((verdict = 'fail') = (reject_reason IS NOT NULL)
         AND (reject_reason IS NULL OR char_length(btrim(reject_reason)) > 0));
-- 质检记录是证据：不可改、不可删、不可截断（M70）。
CREATE TRIGGER trg_qc_record_no_update BEFORE UPDATE ON qc_record
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_update();
CREATE TRIGGER trg_qc_record_no_delete BEFORE DELETE ON qc_record
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_qc_record_no_truncate BEFORE TRUNCATE ON qc_record
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- delivery_release
-- Prisma 给标量数组列建的是可空列，这里补 NOT NULL。
ALTER TABLE delivery_release ALTER COLUMN changed_episode_nos SET NOT NULL;
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_variant
  CHECK (variant IN ('common','douyin','wechat_channels'));
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_kind
  CHECK (kind IN ('initial','reissue'));
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_state
  CHECK (state IN ('pushed','superseded','closed'));
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_close_reason
  CHECK (close_reason IN ('cancelled','usage_ended'));
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_counts
  CHECK (release_no >= 1 AND episode_count >= 1 AND total_bytes > 0 AND checklist_version_no >= 1);
-- 交付前检查的清单模板编码固定（M56：清单引用一律是编码 + 版本号）。
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_checklist_code
  CHECK (checklist_code = 'delivery.precheck');
-- 变更集号：没有空元素，都不小于 1。
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_changed_episode_nos
  CHECK (array_position(changed_episode_nos, NULL) IS NULL AND 1 <= ALL (changed_episode_nos));
-- 清单是数组，条数等于集数。
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_manifest_snapshot
  CHECK (jsonb_typeof(manifest_snapshot) = 'array' AND jsonb_array_length(manifest_snapshot) = episode_count);
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_precheck_results
  CHECK (jsonb_typeof(precheck_results) = 'array');
-- 发布清单文本不超过 200KB。
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_publish_list_text
  CHECK (octet_length(publish_list_text) <= 204800);
-- 补发必须写原因，且有变更的集。
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_reissue
  CHECK (kind <> 'reissue' OR (reason_code IS NOT NULL AND cardinality(changed_episode_nos) >= 1));
-- 状态与时间一致：已取代必有取代时间；已关闭必有关闭时间与原因，重开后三者清空。
ALTER TABLE delivery_release ADD CONSTRAINT ck_delivery_release_state_times
  CHECK ((state = 'superseded') = (superseded_at IS NOT NULL)
         AND (state = 'closed') = (closed_at IS NOT NULL)
         AND (closed_at IS NULL) = (close_reason IS NULL));
-- 同一订单项同一变体至多一个生效中的成片包。
CREATE UNIQUE INDEX uq_delivery_release_live ON delivery_release (order_item_id, variant)
  WHERE state = 'pushed';
-- 清单快照不可变：只允许改状态与发布清单相关的列，不可删。
CREATE OR REPLACE FUNCTION lyx_10_delivery_release_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := ARRAY['state','superseded_at','closed_at','close_reason',
                          'publish_list_text','updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'table delivery_release: DELETE not allowed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'table delivery_release: only columns % may be updated (manifest is immutable)', mutable
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_delivery_release_guard BEFORE UPDATE OR DELETE ON delivery_release
  FOR EACH ROW EXECUTE FUNCTION lyx_10_delivery_release_guard();

-- delivery_reissue
-- Prisma 给标量数组列建的是可空列，这里补 NOT NULL。
-- lyx:allow 首版迁移，表刚建出来、没有数据：Prisma 把标量数组列建成可空，这里补非空；该列没有默认值
ALTER TABLE delivery_reissue ALTER COLUMN episode_nos SET NOT NULL;
ALTER TABLE delivery_reissue ADD CONSTRAINT ck_delivery_reissue_status
  CHECK (status IN ('open','published','cancelled'));
-- 至少 1 个集号；没有空元素，都不小于 1（1 <= ALL 遇到空元素得 NULL，须另判）。
ALTER TABLE delivery_reissue ADD CONSTRAINT ck_delivery_reissue_episode_nos
  CHECK (cardinality(episode_nos) >= 1
         AND array_position(episode_nos, NULL) IS NULL AND 1 <= ALL (episode_nos));
ALTER TABLE delivery_reissue ADD CONSTRAINT ck_delivery_reissue_note
  CHECK (char_length(btrim(note)) > 0);
-- 在途当且仅当未关闭；已发布当且仅当有对应的成片包。
ALTER TABLE delivery_reissue ADD CONSTRAINT ck_delivery_reissue_closed
  CHECK ((status = 'open') = (closed_at IS NULL)
         AND (status = 'published') = (published_delivery_release_id IS NOT NULL));
-- 同一工单同时只有一张在途补发单。
CREATE UNIQUE INDEX uq_delivery_reissue_open ON delivery_reissue (delivery_ticket_id)
  WHERE status = 'open';

-- download_grant
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_grantee_type
  CHECK (grantee_type IN ('entity','partner'));
-- 被授权方是主体时，就是本行的归属主体。
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_grantee
  CHECK (grantee_type <> 'entity' OR grantee_id = entity_id);
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_state
  CHECK (state IN ('active','superseded','revoked'));
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_valid_days
  CHECK (valid_days BETWEEN 1 AND 30);
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_expires_at
  CHECK (expires_at > created_at);
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_actor_type
  CHECK (actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_client
  CHECK (client IN ('weapp','portal','admin'));
-- 系统动作没有操作人 id 与客户端来源；其余类型两者都有（M44）。
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_actor
  CHECK ((actor_type = 'system') = (actor_id IS NULL)
         AND (actor_type = 'system') = (client IS NULL));
-- 有效当且仅当没有结束时间；撤销原因只出现在已撤销的行上。
ALTER TABLE download_grant ADD CONSTRAINT ck_download_grant_ended
  CHECK ((state = 'active') = (ended_at IS NULL)
         AND (revoke_reason IS NULL OR state = 'revoked'));
-- 同一成片包、同一被授权方至多一条有效授权。
CREATE UNIQUE INDEX uq_download_grant_active ON download_grant (delivery_release_id, grantee_type, grantee_id)
  WHERE state = 'active';

-- delivery_download_log
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_kind
  CHECK (kind IN ('episode','zip','publish_list'));
-- 单集下载必有集号，其余没有。
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_episode_no
  CHECK ((kind = 'episode') = (episode_no IS NOT NULL) AND episode_no >= 1);
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_actor_type
  CHECK (actor_type IN ('merchant','staff','partner'));
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_client
  CHECK (client IN ('weapp','portal','admin'));
-- 员工只从后台下载且不经授权表；商家与服务商凭授权下载。
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_actor
  CHECK ((actor_type = 'staff') = (client = 'admin')
         AND (actor_type = 'staff') = (download_grant_id IS NULL));
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_url_ttl_sec
  CHECK (url_ttl_sec > 0);
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_client_ack
  CHECK (client_ack IN ('saved','failed'));
ALTER TABLE delivery_download_log ADD CONSTRAINT ck_delivery_download_log_client_ack_at
  CHECK ((client_ack IS NULL) = (client_ack_at IS NULL));
-- 后台“商家已保存 45 / 80”：按成片包数已保存的集。
CREATE INDEX ix_delivery_download_log_saved ON delivery_download_log (delivery_release_id, episode_no)
  WHERE client_ack = 'saved';
-- 只增表：只允许把回执两列从空写一次，其余列不可改，不可删；另拦 TRUNCATE。
CREATE TRIGGER trg_delivery_download_log_write_once BEFORE UPDATE OR DELETE ON delivery_download_log
  FOR EACH ROW EXECUTE FUNCTION lyx_write_once('client_ack', 'client_ack_at');
CREATE TRIGGER trg_delivery_download_log_no_truncate BEFORE TRUNCATE ON delivery_download_log
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- publish_list
-- Prisma 给标量数组列建的是可空列，这里补 NOT NULL。
ALTER TABLE publish_list ALTER COLUMN topics SET NOT NULL;
-- 保存人与保存时间同时有或同时无。
ALTER TABLE publish_list ADD CONSTRAINT ck_publish_list_saved
  CHECK ((saved_at IS NULL) = (saved_by_staff_id IS NULL));

-- publish_list_episode
ALTER TABLE publish_list_episode ADD CONSTRAINT ck_publish_list_episode_episode_no
  CHECK (episode_no >= 1);
ALTER TABLE publish_list_episode ADD CONSTRAINT ck_publish_list_episode_changed_in_release_no
  CHECK (changed_in_release_no >= 2);

-- ===== 来源 ②：constraints/11-publish.sql =====
-- 分组 11-publish：渠道账号与账号核验提交、上线任务与链接回填、巡检、下架（模块 publish）的手写约束。
-- 依据：docs/appendix/design/d3-flow.md 第 12–15 节；rulings M4，第二轮 M46–M49、M56、M59、M60、M71–M73；docs/data-model/11-publish.md。
-- 只含 Prisma 表达不了的约束：CHECK、部分唯一索引、部分索引、数组列的 NOT NULL，以及 CHECK 用的一个函数。
-- 外键全部由 Prisma 片段生成（M46、M47），本文件不写外键。本分组没有只增表，不使用触发器。先执行 00-common.sql。
-- 标“补”的是字段级阶段按写作规范补的列间关系（草案只在状态机的守卫里写了规则）。

-- 公共：uuid 数组的元素不含 NULL、不重复（count(DISTINCT) 不计 NULL，两种情形都会使等式不成立）
CREATE OR REPLACE FUNCTION lyx_11_uuid_array_is_set(a uuid[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(a) = (SELECT count(DISTINCT e) FROM unnest(a) AS e)
$$;

-- channel_account
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_platform
  CHECK (platform IN ('douyin','wechat_channels'));
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_account_type
  CHECK (account_type IN ('enterprise','personal','none'));
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_status
  CHECK (status IN ('pending_verify','available','abnormal','unbound'));
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_abnormal_source
  CHECK (abnormal_source IN ('verify','manual'));
-- 补：规范化值非空、已转小写、不含空白（规范化本身在应用层做，这里只挡明显没做的情况）
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_account_uid_norm
  CHECK (account_uid_norm <> '' AND account_uid_norm = lower(account_uid_norm) AND account_uid_norm !~ '\s');
-- 补：异常时来源、原因、说明三列齐全；待核验与可用时三列为空（已解绑的行保留解绑前的值）
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_abnormal_fields
  CHECK ((status <> 'abnormal'
          OR (abnormal_source IS NOT NULL AND abnormal_reason_code IS NOT NULL AND abnormal_note IS NOT NULL))
     AND (status NOT IN ('pending_verify','available')
          OR (abnormal_source IS NULL AND abnormal_reason_code IS NULL AND abnormal_note IS NULL)));
-- 补：核验时间与核验人同有同无；可用的账号必有核验记录与账号类型
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_verified
  CHECK ((verified_at IS NULL) = (verified_by_staff_id IS NULL)
     AND (status <> 'available' OR (verified_at IS NOT NULL AND account_type IS NOT NULL)));
-- 补：已解绑 ⇔ 有解绑时间
ALTER TABLE channel_account ADD CONSTRAINT ck_channel_account_unbound
  CHECK ((status = 'unbound') = (unbound_at IS NOT NULL));
-- 同一账号不能同时绑定两家门店；已解绑的行不占键
CREATE UNIQUE INDEX uq_channel_account_platform_uid_active
  ON channel_account (platform, account_uid_norm) WHERE status <> 'unbound';

-- channel_account_submission
-- Prisma 给标量数组列建的是可空列（只带默认值），这里补 NOT NULL（M49）
ALTER TABLE channel_account_submission ALTER COLUMN screenshot_file_ids SET NOT NULL;
ALTER TABLE channel_account_submission ADD CONSTRAINT ck_channel_account_submission_kind
  CHECK (kind IN ('new_binding','resubmit'));
-- 第 1 轮是新绑定，之后各轮是重新提交
ALTER TABLE channel_account_submission ADD CONSTRAINT ck_channel_account_submission_round_no
  CHECK (round_no >= 1 AND (round_no = 1) = (kind = 'new_binding'));
-- 主页截图至少 1 张；不含 NULL、不重复
ALTER TABLE channel_account_submission ADD CONSTRAINT ck_channel_account_submission_screenshot_file_ids
  CHECK (cardinality(screenshot_file_ids) >= 1 AND lyx_11_uuid_array_is_set(screenshot_file_ids));
-- 填报快照是对象，且四个必填键齐全（M72：商家选的账号类型进快照）
ALTER TABLE channel_account_submission ADD CONSTRAINT ck_channel_account_submission_filled_snapshot
  CHECK (jsonb_typeof(filled_snapshot) = 'object'
     AND filled_snapshot ?& ARRAY['platform','accountName','accountUid','accountType']);
ALTER TABLE channel_account_submission ADD CONSTRAINT ck_channel_account_submission_compare_result
  CHECK (compare_result IS NULL
      OR CASE WHEN jsonb_typeof(compare_result) = 'array' THEN jsonb_array_length(compare_result) >= 1 ELSE false END);

-- launch_task
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_platform
  CHECK (platform IN ('douyin','wechat_channels'));
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_review_status
  CHECK (review_status IN ('pending','verifying','need_fix','passed','void'));
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_last_patrol_result
  CHECK (last_patrol_result IN ('normal','abnormal','recovered'));
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_void_reason
  CHECK (void_reason IN ('terminated','usage_expired','account_changed'));
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_counts
  CHECK (current_round_no >= 0 AND verified_episode_count >= 0);
-- 补：作废 ⇔ 有作废原因；只有未上线的任务会被作废（已上线的任务在使用期结束或终止时走 launch.settle）
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_void
  CHECK ((review_status = 'void') = (void_reason IS NOT NULL)
     AND (review_status <> 'void' OR NOT is_live));
-- 补：已上线 ⇔ 有上线时间；已上线 ⇒ 已核验集数 > 0（不变量 publish.I6 的行内部分）
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_live
  CHECK (is_live = (went_live_at IS NOT NULL)
     AND (NOT is_live OR verified_episode_count > 0));
-- 补：上线首日与已核验集数同有同无（都由“已通过的回填”算出）
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_verified
  CHECK ((first_launch_date IS NULL) = (verified_episode_count = 0));
-- 补：待回填的任务轮次为 0；核验中、需补充、已通过的任务至少回填过一轮
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_round
  CHECK ((review_status <> 'pending' OR current_round_no = 0)
     AND (review_status NOT IN ('verifying','need_fix','passed') OR current_round_no >= 1));
-- 补：满集核验通过的任务必已上线，且停在“已通过”
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_completed
  CHECK (completed_at IS NULL OR (is_live AND review_status = 'passed'));
-- 补：最近巡检时间与结论同有同无
ALTER TABLE launch_task ADD CONSTRAINT ck_launch_task_patrol
  CHECK ((last_patrolled_at IS NULL) = (last_patrol_result IS NULL));
-- 巡检候选、下架任务生成、工单求值都只看已上线的任务
CREATE INDEX ix_launch_task_order_item_id_live ON launch_task (order_item_id) WHERE is_live;

-- launch_submission
ALTER TABLE launch_submission ALTER COLUMN evidence_file_ids SET NOT NULL;
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_link_kind
  CHECK (link_kind IN ('collection','episodes'));
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_result
  CHECK (result IN ('pending','passed','passed_partial','returned','revoked','withdrawn'));
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_round_no
  CHECK (round_no >= 1);
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_reported_episode_count
  CHECK (reported_episode_count >= 1);
-- 按链接形态必填：合集链接或逐集链接至少其一，且与 link_kind 对应
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_links
  CHECK ((link_kind = 'collection' AND collection_url IS NOT NULL)
      OR (link_kind = 'episodes' AND episode_urls IS NOT NULL));
-- 补：链接校验的数据库兜底——只接受 https，长度不超过 2000（完整校验在契约层与服务层）
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_collection_url
  CHECK (collection_url IS NULL
      OR (collection_url ~ '^https://[^/[:space:]]' AND char_length(collection_url) <= 2000));
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_episode_urls
  CHECK (episode_urls IS NULL
      OR CASE WHEN jsonb_typeof(episode_urls) = 'array' THEN jsonb_array_length(episode_urls) >= 1 ELSE false END);
-- 补：实际上线日期不晚于回填当天（按 Asia/Shanghai 取日）
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_actual_launch_date
  CHECK (actual_launch_date <= (submitted_at AT TIME ZONE 'Asia/Shanghai')::date);
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_submit_actor_type
  CHECK (submit_actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_submit_client
  CHECK (submit_client IN ('weapp','portal','admin'));
-- 提交人：系统 ⇔ 无操作人 id ⇔ 无客户端来源；商家从小程序或下载页提交，员工从后台提交
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_submitter
  CHECK ((submit_actor_type = 'system') = (submit_actor_id IS NULL)
     AND (submit_actor_type = 'system') = (submit_client IS NULL)
     AND (submit_actor_type <> 'merchant' OR submit_client IN ('weapp','portal'))
     AND (submit_actor_type <> 'staff' OR submit_client = 'admin'));
-- 补：通过过的行（含之后被撤销的）必有核验集数，且在 1 与本次声明集数之间；其余结果没有核验集数
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_verified
  CHECK (CASE WHEN result IN ('passed','passed_partial','revoked')
              THEN verified_episode_count IS NOT NULL
                   AND verified_episode_count BETWEEN 1 AND reported_episode_count
              ELSE verified_episode_count IS NULL
         END);
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_reopen_of
  CHECK (reopen_of_launch_submission_id IS NULL OR reopen_of_launch_submission_id <> id);
-- 链接核验截图选填；有则不含 NULL、不重复
ALTER TABLE launch_submission ADD CONSTRAINT ck_launch_submission_evidence_file_ids
  CHECK (lyx_11_uuid_array_is_set(evidence_file_ids));

-- patrol_batch
-- 周起始日是周一
ALTER TABLE patrol_batch ADD CONSTRAINT ck_patrol_batch_week_start_date
  CHECK (EXTRACT(ISODOW FROM week_start_date) = 1);
ALTER TABLE patrol_batch ADD CONSTRAINT ck_patrol_batch_counts
  CHECK (live_total >= 0 AND sampled_count >= 0 AND sampled_count <= live_total);

-- patrol_task
ALTER TABLE patrol_task ALTER COLUMN evidence_file_ids SET NOT NULL;
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_source
  CHECK (source IN ('weekly_sample','manual','reissue'));
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_status
  CHECK (status IN ('pending','normal','abnormal','recovered','void'));
-- 清单模板编码与版本同有同无；巡检只用 patrol.check；版本号从 1 起（M56）
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_checklist
  CHECK ((checklist_code IS NULL) = (checklist_version_no IS NULL)
     AND (checklist_code IS NULL OR checklist_code = 'patrol.check')
     AND (checklist_version_no IS NULL OR checklist_version_no >= 1));
-- 清单结果为空或是非空 JSON 数组
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_results
  CHECK (results IS NULL
      OR CASE WHEN jsonb_typeof(results) = 'array' THEN jsonb_array_length(results) >= 1 ELSE false END);
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_remind_count
  CHECK (remind_count >= 0);
-- 补：结论时间与结论人同有同无；待巡检没有结论，正常、异常、已恢复必有结论
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_checked
  CHECK ((checked_at IS NULL) = (checked_by_staff_id IS NULL)
     AND (status <> 'pending' OR checked_at IS NULL)
     AND (status NOT IN ('normal','abnormal','recovered') OR checked_at IS NOT NULL));
-- 补：正常与已恢复都要求清单全部通过，必有清单结果与模板版本
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_passed
  CHECK (status NOT IN ('normal','recovered') OR (results IS NOT NULL AND checklist_code IS NOT NULL));
-- 补：异常四列与状态一致
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_abnormal
  CHECK ((status NOT IN ('pending','normal')
          OR (abnormal_kind_code IS NULL AND found_at IS NULL AND notified_at IS NULL AND recovered_at IS NULL))
     AND (status NOT IN ('abnormal','recovered')
          OR (abnormal_kind_code IS NOT NULL AND note IS NOT NULL AND found_at IS NOT NULL))
     AND (status = 'recovered') = (recovered_at IS NOT NULL)
     AND (notified_at IS NULL OR found_at IS NOT NULL));
-- 补：巡检截图不含 NULL、不重复；给出结论（正常、异常、已恢复）时至少 1 张（03:319“人工检查并截图”）
ALTER TABLE patrol_task ADD CONSTRAINT ck_patrol_task_evidence_file_ids
  CHECK (lyx_11_uuid_array_is_set(evidence_file_ids)
     AND (status NOT IN ('normal','abnormal','recovered') OR cardinality(evidence_file_ids) >= 1));
-- 每周生成的行（每周抽样与补发后优先）按“批次 × 上线任务”幂等；手动发起的不受此限
CREATE UNIQUE INDEX uq_patrol_task_batch_launch_task_generated
  ON patrol_task (patrol_batch_id, launch_task_id) WHERE source <> 'manual';
-- 同一上线任务同时至多一条在办（待巡检、异常）的巡检
CREATE UNIQUE INDEX uq_patrol_task_launch_task_id_open
  ON patrol_task (launch_task_id) WHERE status IN ('pending','abnormal');

-- takedown_task
ALTER TABLE takedown_task ALTER COLUMN evidence_file_ids SET NOT NULL;
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_trigger_kind
  CHECK (trigger_kind IN ('expiry','early_end','platform_termination','terminated_after_delivery'));
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_basis
  CHECK (basis IN ('live','delivered_unverified'));
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_status
  CHECK (status IN ('pending_merchant','merchant_confirmed','checked','void'));
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_merchant_method
  CHECK (merchant_method IN ('delete','private','not_published'));
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_check_method
  CHECK (check_method IN ('evidence','sampled_out'));
-- 清单模板编码与版本同有同无；版本号从 1 起（M56）
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_checklist
  CHECK ((checklist_code IS NULL) = (checklist_version_no IS NULL)
     AND (checklist_code IS NULL OR checklist_code IN ('takedown.check','takedown.absence_check'))
     AND (checklist_version_no IS NULL OR checklist_version_no >= 1));
-- 清单结果为空或是非空 JSON 数组
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_results
  CHECK (results IS NULL
      OR CASE WHEN jsonb_typeof(results) = 'array' THEN jsonb_array_length(results) >= 1 ELSE false END);
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_counts
  CHECK (still_online_count >= 0 AND breach_notice_count >= 0);
-- 补：商家确认三列同有同无；已确认必有，待商家下架必空（抽查仍在线、依据变更退回时清空）
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_merchant_confirm
  CHECK ((merchant_method IS NULL) = (merchant_confirmed_at IS NULL)
     AND (merchant_method IS NULL) = (merchant_confirmed_by_user_id IS NULL)
     AND (status <> 'merchant_confirmed' OR merchant_method IS NOT NULL)
     AND (status <> 'pending_merchant' OR merchant_method IS NULL));
-- 补：核查时限与参数快照同有同无，快照是 JSON 对象；商家确认后必有，待商家下架时为空（M60：快照列名 sla_snapshot）
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_check_due
  CHECK ((check_due_at IS NULL) = (sla_snapshot IS NULL)
     AND (sla_snapshot IS NULL OR jsonb_typeof(sla_snapshot) = 'object')
     AND (status <> 'merchant_confirmed' OR check_due_at IS NOT NULL)
     AND (status <> 'pending_merchant' OR check_due_at IS NULL));
-- 补：已核查 ⇔ 有核查时间 ⇔ 有核查方式。
--     逐条核查（evidence）：有核查人、清单模板与结果、不少于 2 张不重复的证据截图（d3:1940）；
--     按抽查放行（sampled_out）：只能来自商家已确认的任务，没有核查人、清单与证据（d3:1998 的 takedown.check_mode）
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_checked
  CHECK ((status = 'checked') = (checked_at IS NOT NULL)
     AND (status = 'checked') = (check_method IS NOT NULL)
     AND (checked_by_staff_id IS NOT NULL) = COALESCE(check_method = 'evidence', false)
     AND (check_method IS DISTINCT FROM 'evidence'
          OR (checklist_code IS NOT NULL AND results IS NOT NULL AND cardinality(evidence_file_ids) >= 2))
     AND (check_method IS DISTINCT FROM 'sampled_out'
          OR (merchant_method IS NOT NULL AND checklist_code IS NULL AND results IS NULL
              AND cardinality(evidence_file_ids) = 0)));
-- 补：证据截图不含 NULL、不重复
ALTER TABLE takedown_task ADD CONSTRAINT ck_takedown_task_evidence_file_ids
  CHECK (lyx_11_uuid_array_is_set(evidence_file_ids));
-- 同一订单项的同一账号至多一条未作废的下架任务
CREATE UNIQUE INDEX uq_takedown_task_item_account_active
  ON takedown_task (order_item_id, channel_account_id) WHERE status <> 'void';

-- ===== 来源 ②：constraints/12-support.sql =====
-- 分组 12-support：客服工单（support 模块）的手写约束。
-- 依据：docs/appendix/design/d3-flow.md 第 18 节；docs/data-model/12-support.md。
-- 只含 Prisma 表达不了的约束：CHECK、数组列的 NOT NULL、部分索引与部分唯一索引、触发器。
-- 建表、普通索引、全部外键（含门店归属复合外键、条目指向工单的三列复合外键）由 Prisma 片段生成（M46、M47）。
-- 触发器函数只用公共文件 00-common.sql 里的（M50），本分组不定义函数。

-- service_ticket
-- Prisma 的标量数组列建表时不带 NOT NULL。
ALTER TABLE service_ticket ALTER COLUMN image_file_ids SET NOT NULL;
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_source
  CHECK (source IN ('weapp','online_chat','phone'));
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_priority
  CHECK (priority IN ('high','mid','low'));
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_status
  CHECK (status IN ('pending','processing','awaiting_confirm','resolved','closed'));
-- 关闭原因是系统枚举（M55：状态机依赖 withdrawn）。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_close_reason
  CHECK (close_reason IN ('duplicate','invalid','withdrawn'));
-- 撤回原因是字典 ticket_withdraw_reason 的编码，不逐值校验（M55：不参与逻辑的保持为字典）。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_withdraw_reason_code
  CHECK (withdraw_reason_code <> '');
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_resolved_via
  CHECK (resolved_via IN ('merchant','auto'));
-- 小程序提交：有提交人、没有登记人；后台登记：有登记人，提交人可空。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_creator
  CHECK ((source = 'weapp') = (registered_by_staff_id IS NULL)
         AND (source <> 'weapp' OR submitter_user_id IS NOT NULL));
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_type_code
  CHECK (type_code <> '');
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_description
  CHECK (btrim(description) <> '');
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_image_file_ids
  CHECK (cardinality(image_file_ids) <= 9);
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_contact_phone
  CHECK ((contact_phone_enc IS NULL) = (contact_phone_mask IS NULL));
-- 待受理只出现在小程序提交的工单上，且此时还没有首次回复。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_pending
  CHECK (status <> 'pending' OR (source = 'weapp' AND first_response_at IS NULL));
-- 响应截止时间只在待受理、处理中期间有值（回复后、结束后清空）。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_response_due
  CHECK (response_due_at IS NULL OR status IN ('pending','processing'));
-- 提交处理结果即视为给出方案：进入待商家确认、已解决时必有方案时间。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_solution
  CHECK (status NOT IN ('awaiting_confirm','resolved') OR solution_at IS NOT NULL);
-- 自动解决时间只在待商家确认期间有值，且晚于进入待确认的时间。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_awaiting
  CHECK ((status = 'awaiting_confirm') = (auto_resolve_at IS NOT NULL)
         AND (status <> 'awaiting_confirm' OR awaiting_confirm_at IS NOT NULL)
         AND (auto_resolve_at IS NULL OR awaiting_confirm_at IS NULL OR auto_resolve_at > awaiting_confirm_at));
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_resolved
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)
         AND (resolved_at IS NULL) = (resolved_via IS NULL));
-- 关闭：时间与原因同有同无；撤回原因只在商家撤回时有；关闭时“关闭说明”与“撤回原因”至少有一个。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_closed
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)
         AND (closed_at IS NULL) = (close_reason IS NULL)
         AND (withdraw_reason_code IS NULL OR (close_reason IS NOT NULL AND close_reason = 'withdrawn'))
         AND (close_note IS NULL OR (closed_at IS NOT NULL AND btrim(close_note) <> ''))
         AND (closed_at IS NULL OR close_note IS NOT NULL OR withdraw_reason_code IS NOT NULL));
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_reopened_count
  CHECK (reopened_count >= 0);
-- 有截止时间时，快照里必有对应的一段，且这一段是对象（JSON null 不算）；方案时限必有，solution 段恒在。
ALTER TABLE service_ticket ADD CONSTRAINT ck_service_ticket_sla_snapshot
  CHECK (jsonb_typeof(sla_snapshot) = 'object'
         AND jsonb_typeof(sla_snapshot -> 'solution') = 'object'
         AND (response_due_at IS NULL OR jsonb_typeof(sla_snapshot -> 'response') = 'object')
         AND (auto_resolve_at IS NULL OR jsonb_typeof(sla_snapshot -> 'autoResolve') = 'object'));
-- 工单池“仅看响应超时”、工作台“响应超时数”、timers.I7 的检查项：只索引还在等待响应的工单。
CREATE INDEX ix_service_ticket_response_due_at ON service_ticket (response_due_at)
  WHERE response_due_at IS NOT NULL;
-- 没有负责人的未结工单（没有当班客服时留空），进入客服主管待办，可“分配”。
CREATE INDEX ix_service_ticket_unassigned ON service_ticket (created_at)
  WHERE owner_staff_id IS NULL AND status IN ('pending','processing','awaiting_confirm');
-- 归属、单号、来源、提交人与提交内容不可改。
CREATE TRIGGER trg_service_ticket_immutable
  BEFORE UPDATE OF ticket_no, entity_id, store_id, source, submitter_user_id, registered_by_staff_id,
                   description, image_file_ids, created_at
  ON service_ticket
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'ticket_no', 'entity_id', 'store_id', 'source', 'submitter_user_id', 'registered_by_staff_id',
    'description', 'image_file_ids', 'created_at');

-- service_ticket_entry
ALTER TABLE service_ticket_entry ALTER COLUMN image_file_ids SET NOT NULL;
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_kind
  CHECK (kind IN ('merchant_message','staff_reply','internal_note','system_event'));
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_tag
  CHECK (tag IN ('submit','supplement','reopen','reply','solution','result','transfer','status','biz_event'));
-- 标签按条目类型取值；回复与系统事件必有标签。
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_kind_tag
  CHECK (CASE kind
           WHEN 'merchant_message' THEN tag IS NULL OR tag IN ('submit','supplement','reopen')
           WHEN 'staff_reply'      THEN tag IS NOT NULL AND tag IN ('reply','solution','result')
           WHEN 'internal_note'    THEN tag IS NULL OR tag = 'transfer'
           WHEN 'system_event'     THEN tag IS NOT NULL AND tag IN ('transfer','status','biz_event')
           ELSE false
         END);
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_actor_type
  CHECK (actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_client
  CHECK (client IN ('weapp','portal','admin'));
-- 系统动作没有操作人 id 与客户端；其余操作人两列都必填（M44）。
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_actor
  CHECK ((actor_type = 'system') = (actor_id IS NULL)
         AND (actor_type = 'system') = (client IS NULL));
-- 商家消息由商家写（后台登记时的提交条目由登记人代录）；回复与内部备注由员工写；关联业务事件由系统写。
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_kind_actor
  CHECK (CASE kind
           WHEN 'merchant_message' THEN actor_type = 'merchant'
                                        OR (actor_type = 'staff' AND tag IS NOT NULL AND tag = 'submit')
           WHEN 'staff_reply'      THEN actor_type = 'staff'
           WHEN 'internal_note'    THEN actor_type = 'staff'
           ELSE tag IS DISTINCT FROM 'biz_event' OR actor_type = 'system'
         END);
-- 内部备注商家不可见；商家消息与回复商家可见；系统事件逐条决定。
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_visible
  CHECK (CASE kind
           WHEN 'internal_note' THEN NOT is_visible_to_merchant
           WHEN 'system_event'  THEN true
           ELSE is_visible_to_merchant
         END);
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_body
  CHECK (body IS NULL OR btrim(body) <> '');
-- 系统事件必有正文、不带图片；其余条目正文与图片至少有一样。
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_content
  CHECK (CASE WHEN kind = 'system_event'
              THEN body IS NOT NULL AND cardinality(image_file_ids) = 0
              ELSE body IS NOT NULL OR cardinality(image_file_ids) > 0
         END);
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_image_file_ids
  CHECK (cardinality(image_file_ids) <= 9);
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_merchant_body
  CHECK (merchant_body IS NULL
         OR (kind = 'system_event' AND is_visible_to_merchant AND btrim(merchant_body) <> ''));
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_solution
  CHECK (is_solution = (kind = 'staff_reply' AND tag IS NOT NULL AND tag IN ('solution','result')));
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_link
  CHECK (link IS NULL OR (jsonb_typeof(link) = 'object' AND link ? 'route'));
-- 来源出站事件：关联业务事件条目必有，其余条目没有。
ALTER TABLE service_ticket_entry ADD CONSTRAINT ck_service_ticket_entry_outbox_event
  CHECK ((outbox_event_id IS NOT NULL) = (tag IS NOT NULL AND tag = 'biz_event'));
-- 同一事件在同一张工单上只写一条（重复投递、一个事件命中同一工单的多条关联行时都靠它兜底）。
CREATE UNIQUE INDEX uq_service_ticket_entry_outbox_event_id ON service_ticket_entry (service_ticket_id, outbox_event_id)
  WHERE outbox_event_id IS NOT NULL;
-- 条目写入后不改（没有编辑、撤回消息的功能）。
CREATE TRIGGER trg_service_ticket_entry_no_update
  BEFORE UPDATE ON service_ticket_entry
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_update();

-- service_ticket_ref
ALTER TABLE service_ticket_ref ADD CONSTRAINT ck_service_ticket_ref_ref_type
  CHECK (ref_type IN ('drama_order','billing_order','delivery_ticket','ad','approval_request'));
-- 关联行只增删，不改；关联错的行允许物理删除（M95），所以不拦 DELETE。
-- 增删的状态守卫与“审批单关联不可删”在应用层判断（12-support.md 2.3；A92），库里不拦。
CREATE TRIGGER trg_service_ticket_ref_no_update
  BEFORE UPDATE ON service_ticket_ref
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_update();

-- ===== 来源 ②：constraints/13-notify-docs.sql =====
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

-- ===== 来源 ②：constraints/14-config-data.sql =====
-- 分组 14-config-data：字典、参数、站点配置、开关、清单模板（config）；埋点（analytics）；报表快照（reports）；导出（exports）的手写约束。
-- 依据：docs/data-model/14-config-data.md；docs/appendix/design/d6-notify-docs-data.md 第 4、5 节；d3-flow.md 第 10.1、10.2 节。
-- 先于本文件执行：Prisma 生成的建表语句、00-common.sql（lyx_forbid_mutation、lyx_write_once、lyx_forbid_delete、lyx_forbid_column_change）。
-- 内容：枚举与范围 CHECK、部分唯一索引、部分索引、表达式唯一索引、防改触发器，以及 analytics_event 的分区改造。
-- 例外（写作规范第 4 节“不写 CREATE TABLE”；M77 已确认）：Prisma 表达不了分区表，analytics_event 在本文件里
-- 以 Prisma 建出的表为模板（LIKE）重建为按 occurred_at 月度 RANGE 分区的表，列定义不在这里重复。
-- 新增枚举取值按“先声明、下一版再写入”，用 NOT VALID + VALIDATE 替换 CHECK。
-- 第二轮（M50）：不可删除、指定列不可改改用公共函数 lyx_forbid_delete()、lyx_forbid_column_change()，
-- 本分组只保留公共文件没有的三个触发器函数（lyx_14_status_transition、lyx_14_freeze_after、lyx_14_mutable_columns_only）。
-- 第三轮（M101、M109、M110 与各分组的请求）没有约束改动：只改文档里的播种数据、参数键与登记说明。

-- 本分组的触发器函数（lyx_14_ 开头）

-- status 列只允许按参数列出的方向迁移，参数形如 '原状态>新状态'。
-- 用法：CREATE TRIGGER trg_<表>_status BEFORE UPDATE ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_14_status_transition('draft>published', 'published>archived');
CREATE OR REPLACE FUNCTION lyx_14_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status || '>' || NEW.status) = ANY (TG_ARGV::text[])) THEN
    RAISE EXCEPTION 'table %: status transition % -> % not allowed', TG_TABLE_NAME, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- 行离开某个状态之后内容冻结：第 1 个参数是“可自由编辑”的状态，其余参数是冻结后仍可改的列。
-- 用法：CREATE TRIGGER trg_<表>_freeze BEFORE UPDATE ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_14_freeze_after('draft', 'status', 'updated_at');
CREATE OR REPLACE FUNCTION lyx_14_freeze_after() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := COALESCE(TG_ARGV[1:], ARRAY[]::text[]);
BEGIN
  IF OLD.status <> TG_ARGV[0]
     AND (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'table %: row is frozen once status leaves %; only columns % may be updated',
      TG_TABLE_NAME, TG_ARGV[0], mutable
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- 只有参数列出的列可以更新，其余列创建后只读。
-- 用法：CREATE TRIGGER trg_<表>_mutable BEFORE UPDATE ON <表>
--         FOR EACH ROW EXECUTE FUNCTION lyx_14_mutable_columns_only('status', 'updated_at');
CREATE OR REPLACE FUNCTION lyx_14_mutable_columns_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable text[] := TG_ARGV::text[];
BEGIN
  IF (to_jsonb(OLD) - mutable) IS DISTINCT FROM (to_jsonb(NEW) - mutable) THEN
    RAISE EXCEPTION 'table %: only columns % may be updated', TG_TABLE_NAME, mutable
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- dict_type
ALTER TABLE dict_type ADD CONSTRAINT ck_dict_type_type_key
  CHECK (type_key ~ '^[a-z][a-z0-9_]{1,23}$');
ALTER TABLE dict_type ADD CONSTRAINT ck_dict_type_structure
  CHECK (structure IN ('flat','tree'));
ALTER TABLE dict_type ADD CONSTRAINT ck_dict_type_disable_policy
  CHECK (disable_policy IN ('free','block_if_referenced','never'));
-- 平铺只有一层；树为 2 或 3 层。
ALTER TABLE dict_type ADD CONSTRAINT ck_dict_type_max_depth
  CHECK ((structure = 'flat' AND max_depth = 1) OR (structure = 'tree' AND max_depth BETWEEN 2 AND 3));
-- 顺序生成编码的前缀与位数同有同无。
ALTER TABLE dict_type ADD CONSTRAINT ck_dict_type_code_rule
  CHECK ((code_prefix IS NULL) = (code_width IS NULL)
         AND (code_prefix IS NULL OR code_prefix ~ '^[A-Z]{1,4}$')
         AND (code_width IS NULL OR code_width BETWEEN 1 AND 6));
ALTER TABLE dict_type ADD CONSTRAINT ck_dict_type_counters
  CHECK (next_code_no >= 1 AND version_no >= 1);
-- 系统枚举不可新增。
ALTER TABLE dict_type ADD CONSTRAINT ck_dict_type_system
  CHECK (NOT is_system OR NOT can_create);

-- dict_item
-- Prisma 的标量数组列建表时不带 NOT NULL，这里补上。
ALTER TABLE dict_item ALTER COLUMN tags SET NOT NULL;
ALTER TABLE dict_item ADD CONSTRAINT ck_dict_item_code
  CHECK (code ~ '^[A-Za-z0-9_-]{1,16}$');
ALTER TABLE dict_item ADD CONSTRAINT ck_dict_item_parent_code
  CHECK (parent_code IS NULL OR parent_code <> code);
ALTER TABLE dict_item ADD CONSTRAINT ck_dict_item_name
  CHECK (char_length(name) BETWEEN 1 AND 20);
ALTER TABLE dict_item ADD CONSTRAINT ck_dict_item_description
  CHECK (char_length(description) <= 40);
ALTER TABLE dict_item ADD CONSTRAINT ck_dict_item_ext
  CHECK (jsonb_typeof(ext) = 'object');
ALTER TABLE dict_item ADD CONSTRAINT ck_dict_item_position
  CHECK (position >= 0);
-- 同级不重名（一级项的上级编码按空串参与唯一）。
CREATE UNIQUE INDEX uq_dict_item_sibling_name ON dict_item (dict_type_key, COALESCE(parent_code, ''), name);
-- 编码保存后不可改；所属类型与上级同样不可改（编码由上级编码加序号生成）。
CREATE TRIGGER trg_dict_item_immutable BEFORE UPDATE ON dict_item
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('dict_type_key', 'code', 'parent_code');
-- 字典项只停用、不删除（行级 DELETE 与整表 TRUNCATE 都拦）。
CREATE TRIGGER trg_dict_item_no_delete BEFORE DELETE ON dict_item
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_dict_item_no_truncate BEFORE TRUNCATE ON dict_item
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- param_value
-- 键是代码里登记的常量，数据库只校验写法：小写点分，2 至 6 段，总长不超过 64。
ALTER TABLE param_value ADD CONSTRAINT ck_param_value_key
  CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,5}$' AND char_length(key) <= 64);
-- 只能在生效前撤销。
ALTER TABLE param_value ADD CONSTRAINT ck_param_value_cancel_before_effective
  CHECK (cancelled_at IS NULL OR cancelled_at < effective_at);
ALTER TABLE param_value ADD CONSTRAINT ck_param_value_reason
  CHECK (char_length(reason) <= 100);
-- 同一个键在同一生效时刻只有一行未撤销的值；也是“取当前值”查询用的索引。
CREATE UNIQUE INDEX uq_param_value_key_effective_at ON param_value (key, effective_at DESC)
  WHERE cancelled_at IS NULL;
-- 受限更新（M14）：只允许把 cancelled_at 从空写一次，其余列不可改，不可删。
CREATE TRIGGER trg_param_value_write_once BEFORE UPDATE OR DELETE ON param_value
  FOR EACH ROW EXECUTE FUNCTION lyx_write_once('cancelled_at');
CREATE TRIGGER trg_param_value_no_truncate BEFORE TRUNCATE ON param_value
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- site_config_revision
ALTER TABLE site_config_revision ADD CONSTRAINT ck_site_config_revision_config_key
  CHECK (config_key IN ('mall','home_recommend'));
ALTER TABLE site_config_revision ADD CONSTRAINT ck_site_config_revision_status
  CHECK (status IN ('draft','published','archived'));
-- 修订号与发布时间在发布时写入：草稿两者为空，已发布与已归档两者必有。
ALTER TABLE site_config_revision ADD CONSTRAINT ck_site_config_revision_published
  CHECK ((status = 'draft') = (rev_no IS NULL)
         AND (status = 'draft') = (published_at IS NULL)
         AND (status <> 'draft' OR published_by_staff_id IS NULL));
ALTER TABLE site_config_revision ADD CONSTRAINT ck_site_config_revision_rev_no
  CHECK ((rev_no IS NULL OR rev_no >= 1)
         AND (base_rev_no IS NULL OR base_rev_no >= 1)
         AND (rev_no IS NULL OR base_rev_no IS NULL OR rev_no > base_rev_no));
ALTER TABLE site_config_revision ADD CONSTRAINT ck_site_config_revision_content
  CHECK (jsonb_typeof(content) = 'object');
ALTER TABLE site_config_revision ADD CONSTRAINT ck_site_config_revision_note
  CHECK (char_length(note) <= 100);
-- 每个配置键至多一份草稿、至多一份已发布（“恰有一份已发布”由不变量校验）。
CREATE UNIQUE INDEX uq_site_config_revision_draft ON site_config_revision (config_key)
  WHERE status = 'draft';
CREATE UNIQUE INDEX uq_site_config_revision_published ON site_config_revision (config_key)
  WHERE status = 'published';
-- 修订行不删；配置键不可改；状态只能 草稿 → 已发布 → 已归档；发布后内容冻结。
CREATE TRIGGER trg_site_config_revision_no_delete BEFORE DELETE ON site_config_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_site_config_revision_no_truncate BEFORE TRUNCATE ON site_config_revision
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_site_config_revision_immutable BEFORE UPDATE ON site_config_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('config_key', 'created_by_staff_id', 'created_at');
CREATE TRIGGER trg_site_config_revision_status BEFORE UPDATE ON site_config_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_14_status_transition('draft>published', 'published>archived');
CREATE TRIGGER trg_site_config_revision_freeze BEFORE UPDATE ON site_config_revision
  FOR EACH ROW EXECUTE FUNCTION lyx_14_freeze_after('draft', 'status', 'updated_at', 'lock_version');

-- home_banner
ALTER TABLE home_banner ADD CONSTRAINT ck_home_banner_jump_kind
  CHECK (jump_kind IN ('drama','mall','page','none'));
-- 跳转目标与跳转类型：不跳转时没有目标，其余必有且为对象。
ALTER TABLE home_banner ADD CONSTRAINT ck_home_banner_jump_target
  CHECK ((jump_kind = 'none') = (jump_target IS NULL)
         AND (jump_target IS NULL OR jsonb_typeof(jump_target) = 'object'));
ALTER TABLE home_banner ADD CONSTRAINT ck_home_banner_window
  CHECK (end_at IS NULL OR end_at > start_at);
ALTER TABLE home_banner ADD CONSTRAINT ck_home_banner_title
  CHECK (char_length(title) BETWEEN 1 AND 30);
ALTER TABLE home_banner ADD CONSTRAINT ck_home_banner_position
  CHECK (position >= 0);

-- site_notice
-- 公告类型即 ref_id 的多态类型，用最终表名（M19）；V1.1 的人工公告（ops）启用时再登记。
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_kind
  CHECK (kind IN ('plan_revision','billing_param','agreement_version'));
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_status
  CHECK (status IN ('announced','withdrawn'));
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_lead
  CHECK (lead_days >= 0 AND effective_at >= announced_at);
-- 公告期不足的原因只可能来自协议版本。
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_short_notice
  CHECK (short_notice_reason IS NULL
         OR (kind = 'agreement_version' AND char_length(short_notice_reason) BETWEEN 1 AND 100));
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_text
  CHECK (char_length(title) BETWEEN 1 AND 40 AND char_length(summary) BETWEEN 1 AND 200);
-- 不含价格数字的摘要：计费类公告（价目修订、计费参数）必填，供 offline_contract 模式（showPrice = false）使用。
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_summary_no_price
  CHECK ((kind NOT IN ('plan_revision','billing_param') OR summary_no_price IS NOT NULL)
         AND (summary_no_price IS NULL OR char_length(summary_no_price) BETWEEN 1 AND 200));
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_link
  CHECK (jsonb_typeof(link) = 'object' AND link ? 'route');
-- 已撤回必有撤回时间与撤回人；未撤回两者为空。
ALTER TABLE site_notice ADD CONSTRAINT ck_site_notice_withdrawn
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)
         AND (status = 'withdrawn') = (withdrawn_by_staff_id IS NOT NULL));
-- 同一变更至多一条已公告的记录；已撤回的行保留，撤回后再次公告（如协议版本 pending → draft → pending）新建一行。
-- notices.announce：INSERT … ON CONFLICT (kind, ref_id) WHERE status = 'announced' DO NOTHING RETURNING id，无返回行时按同一条件查出已有 id。
CREATE UNIQUE INDEX uq_site_notice_kind_ref_id_announced ON site_notice (kind, ref_id)
  WHERE status = 'announced';
-- 首页公告条：status = 'announced' AND bar_enabled 中 announced_at 最新的一条。
CREATE INDEX ix_site_notice_bar ON site_notice (announced_at DESC)
  WHERE status = 'announced' AND bar_enabled;
-- 公告不可编辑、不可删：只允许撤回一次，撤回后整行冻结。
CREATE TRIGGER trg_site_notice_no_delete BEFORE DELETE ON site_notice
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_site_notice_no_truncate BEFORE TRUNCATE ON site_notice
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_site_notice_status BEFORE UPDATE ON site_notice
  FOR EACH ROW EXECUTE FUNCTION lyx_14_status_transition('announced>withdrawn');
CREATE TRIGGER trg_site_notice_mutable BEFORE UPDATE ON site_notice
  FOR EACH ROW EXECUTE FUNCTION lyx_14_mutable_columns_only('status', 'withdrawn_at', 'withdrawn_by_staff_id', 'updated_at');
CREATE TRIGGER trg_site_notice_freeze BEFORE UPDATE ON site_notice
  FOR EACH ROW EXECUTE FUNCTION lyx_14_freeze_after('announced');

-- feature_flag
ALTER TABLE feature_flag ADD CONSTRAINT ck_feature_flag_key
  CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,5}$' AND char_length(key) <= 48);
ALTER TABLE feature_flag ADD CONSTRAINT ck_feature_flag_value_type
  CHECK (value_type IN ('bool','enum','json'));
ALTER TABLE feature_flag ADD CONSTRAINT ck_feature_flag_exposed_to
  CHECK (exposed_to IN ('client','server'));
-- 默认值的 JSON 类型与值类型一致：bool 为布尔，enum 为字符串，json 不限。
ALTER TABLE feature_flag ADD CONSTRAINT ck_feature_flag_default_value
  CHECK (CASE value_type
           WHEN 'bool' THEN jsonb_typeof(default_value) = 'boolean'
           WHEN 'enum' THEN jsonb_typeof(default_value) = 'string'
           ELSE true
         END);
ALTER TABLE feature_flag ADD CONSTRAINT ck_feature_flag_rules
  CHECK (jsonb_typeof(rules) = 'array');

-- checklist_template
ALTER TABLE checklist_template ADD CONSTRAINT ck_checklist_template_code
  CHECK (code IN ('qc.sample','qc.episode','qc.package','delivery.precheck','launch.verify',
                  'patrol.check','takedown.check','takedown.absence_check','account.verify'));
ALTER TABLE checklist_template ADD CONSTRAINT ck_checklist_template_status
  CHECK (status IN ('draft','active','retired'));
ALTER TABLE checklist_template ADD CONSTRAINT ck_checklist_template_version_no
  CHECK (version_no >= 1);
-- 条目是数组；启用过的版本至少有一个条目。
ALTER TABLE checklist_template ADD CONSTRAINT ck_checklist_template_items
  CHECK (jsonb_typeof(items) = 'array' AND (status = 'draft' OR jsonb_array_length(items) >= 1));
-- 状态与时间一致：草稿没有启用与停用时间；启用中必有启用时间、没有停用时间；已停用必有停用时间。
ALTER TABLE checklist_template ADD CONSTRAINT ck_checklist_template_state_times
  CHECK ((status = 'draft' AND activated_at IS NULL AND retired_at IS NULL)
      OR (status = 'active' AND activated_at IS NOT NULL AND retired_at IS NULL)
      OR (status = 'retired' AND retired_at IS NOT NULL
          AND (activated_at IS NULL OR retired_at >= activated_at)));
-- 每个编码至多一个启用中的版本。
CREATE UNIQUE INDEX uq_checklist_template_active ON checklist_template (code)
  WHERE status = 'active';
-- 模板行不删；编码与版本号不可改；状态只能向前；启用后条目冻结（业务记录按编码与版本号还原当时的清单）。
CREATE TRIGGER trg_checklist_template_no_delete BEFORE DELETE ON checklist_template
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_checklist_template_no_truncate BEFORE TRUNCATE ON checklist_template
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_checklist_template_immutable BEFORE UPDATE ON checklist_template
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('code', 'version_no', 'created_by_staff_id', 'created_at');
CREATE TRIGGER trg_checklist_template_status BEFORE UPDATE ON checklist_template
  FOR EACH ROW EXECUTE FUNCTION lyx_14_status_transition('draft>active', 'draft>retired', 'active>retired');
CREATE TRIGGER trg_checklist_template_freeze BEFORE UPDATE ON checklist_template
  FOR EACH ROW EXECUTE FUNCTION lyx_14_freeze_after('draft', 'status', 'retired_at', 'updated_at', 'lock_version');

-- analytics_event
-- 分区改造：以 Prisma 建出的表为模板，重建为按 occurred_at 月度 RANGE 分区的表（列、默认值、NOT NULL 原样带过来）。
-- lyx:allow 首版迁移，表刚建出来、没有数据：分区改造，Prisma 建出的表让出名字，作模板重建为按月分区的表
ALTER TABLE analytics_event RENAME TO analytics_event_plain;
CREATE TABLE analytics_event (LIKE analytics_event_plain INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
  PARTITION BY RANGE (occurred_at);
-- lyx:allow 首版迁移，表刚建出来、没有数据：分区改造，按模板建出分区表之后删掉模板
DROP TABLE analytics_event_plain;
ALTER TABLE analytics_event ADD CONSTRAINT pk_analytics_event PRIMARY KEY (occurred_at, id);
-- 索引建在父表上，自动下推到各分区。
CREATE INDEX ix_analytics_event_name_occurred_at ON analytics_event (name, occurred_at);
CREATE INDEX ix_analytics_event_entity_id_occurred_at ON analytics_event (entity_id, occurred_at)
  WHERE entity_id IS NOT NULL;
CREATE INDEX ix_analytics_event_merchant_user_id_occurred_at ON analytics_event (merchant_user_id, occurred_at)
  WHERE merchant_user_id IS NOT NULL;
-- 漏斗拼接：从用户反查匿名标识后，按 anonymous_id 取登录前的访问事件。
CREATE INDEX ix_analytics_event_anonymous_id_occurred_at ON analytics_event (anonymous_id, occurred_at)
  WHERE anonymous_id IS NOT NULL;
-- 去重标识上限 128：uuid 化之后，出站派生 out-{uuid}-{name} 最长 81，直记 srv-pkgdl-{uuid}-{uuid}-{方式}-{日} 约 100。
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_event_id
  CHECK (char_length(event_id) BETWEEN 1 AND 128);
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_name
  CHECK (name ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_source
  CHECK (source IN ('client','outbox','direct'));
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_actor_type
  CHECK (actor_type IN ('merchant','staff','system','partner'));
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_client
  CHECK (client IN ('weapp','portal','admin'));
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_role
  CHECK (role IN ('owner','clerk'));
-- client_platform、client_version 取自请求头，不做 CHECK：取值随微信客户端增加，
-- 直记事件与业务写同事务，写不进会连带业务事务失败（与 outbox_event 同一处理）。
-- 操作人：系统动作没有操作人 id 与客户端来源；员工与服务商必有操作人 id；
-- 商家要么有操作人 id（已登录），要么只有匿名标识（游客）。
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_actor
  CHECK (CASE actor_type
           WHEN 'system' THEN actor_id IS NULL AND client IS NULL
           WHEN 'merchant' THEN actor_id IS NOT NULL OR anonymous_id IS NOT NULL
           ELSE actor_id IS NOT NULL
         END);
-- 端上事件只来自小程序里的商家，批次头必带匿名标识与会话标识。
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_client_source
  CHECK (source <> 'client'
         OR (actor_type = 'merchant' AND client IS NOT NULL AND client = 'weapp'
             AND anonymous_id IS NOT NULL AND session_id IS NOT NULL));
-- 有门店必有主体；角色快照只在有归属用户时出现。
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_scope
  CHECK ((store_id IS NULL OR entity_id IS NOT NULL) AND (role IS NULL OR merchant_user_id IS NOT NULL));
ALTER TABLE analytics_event ADD CONSTRAINT ck_analytics_event_props
  CHECK (jsonb_typeof(props) = 'object');
-- 只增：行级触发器建在父表上，自动带到各分区；到期清理按整分区 DETACH + DROP，不逐行删除。
CREATE TRIGGER trg_analytics_event_append_only BEFORE UPDATE OR DELETE ON analytics_event
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();
CREATE TRIGGER trg_analytics_event_no_truncate BEFORE TRUNCATE ON analytics_event
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();
-- 兜底分区：正常应为空，有数据即告警。
CREATE TABLE analytics_event_default PARTITION OF analytics_event DEFAULT;
CREATE TRIGGER trg_analytics_event_default_no_truncate BEFORE TRUNCATE ON analytics_event_default
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();
-- 建某个月的分区（已存在则跳过）；月界按 Asia/Shanghai 取。周期任务 analytics.partitions 与迁移都调用它。
-- 语句级的 TRUNCATE 触发器不会从父表带到分区，这里逐个分区补上。
CREATE OR REPLACE FUNCTION lyx_14_analytics_event_ensure_partition(p_month date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  m date := date_trunc('month', p_month)::date;
  part text := 'analytics_event_y' || to_char(m, 'YYYY') || 'm' || to_char(m, 'MM');
  lo timestamptz := m::timestamp AT TIME ZONE 'Asia/Shanghai';
  hi timestamptz := (m + interval '1 month')::timestamp AT TIME ZONE 'Asia/Shanghai';
BEGIN
  IF to_regclass(part) IS NULL THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF analytics_event FOR VALUES FROM (%L) TO (%L)', part, lo, hi);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation()',
                   'trg_' || part || '_no_truncate', part);
  END IF;
  RETURN part;
END;
$$;
-- 预建当月与未来 3 个月的分区。
SELECT lyx_14_analytics_event_ensure_partition(
         ((now() AT TIME ZONE 'Asia/Shanghai')::date + make_interval(months => i))::date)
  FROM generate_series(0, 3) AS i;

-- analytics_event_dedup
ALTER TABLE analytics_event_dedup ADD CONSTRAINT ck_analytics_event_dedup_event_id
  CHECK (char_length(event_id) BETWEEN 1 AND 128);

-- analytics_identity
-- 本表没有 Prisma 表达不了的约束：主键与普通索引都在片段里。

-- report_month_close
ALTER TABLE report_month_close ADD CONSTRAINT ck_report_month_close_report_key
  CHECK (report_key IN ('overview'));
ALTER TABLE report_month_close ADD CONSTRAINT ck_report_month_close_status
  CHECK (status IN ('closed','superseded'));
-- 月份取当月 1 日。
ALTER TABLE report_month_close ADD CONSTRAINT ck_report_month_close_month_date
  CHECK (EXTRACT(DAY FROM month_date) = 1);
ALTER TABLE report_month_close ADD CONSTRAINT ck_report_month_close_numbers
  CHECK (revision_no >= 1 AND metric_def_version >= 1);
ALTER TABLE report_month_close ADD CONSTRAINT ck_report_month_close_json
  CHECK (jsonb_typeof(payload) = 'object' AND jsonb_typeof(finality) = 'object');
-- 固化时刻不早于次月 1 日零点（Asia/Shanghai），写入时间不早于固化时刻。
ALTER TABLE report_month_close ADD CONSTRAINT ck_report_month_close_times
  CHECK (closed_at >= cutoff_at
         AND cutoff_at >= ((month_date + interval '1 month') AT TIME ZONE 'Asia/Shanghai'));
-- 员工重出快照必填原因。
ALTER TABLE report_month_close ADD CONSTRAINT ck_report_month_close_reason
  CHECK ((closed_by_staff_id IS NULL OR reason IS NOT NULL) AND char_length(reason) <= 100);
-- 同一报表同一月份至多一行当前有效的快照。
CREATE UNIQUE INDEX uq_report_month_close_current ON report_month_close (report_key, month_date)
  WHERE status = 'closed';
-- 快照内容不可改、不可删：只允许把状态从 closed 改为 superseded。
CREATE TRIGGER trg_report_month_close_no_delete BEFORE DELETE ON report_month_close
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_report_month_close_no_truncate BEFORE TRUNCATE ON report_month_close
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_report_month_close_status BEFORE UPDATE ON report_month_close
  FOR EACH ROW EXECUTE FUNCTION lyx_14_status_transition('closed>superseded');
CREATE TRIGGER trg_report_month_close_mutable BEFORE UPDATE ON report_month_close
  FOR EACH ROW EXECUTE FUNCTION lyx_14_mutable_columns_only('status', 'updated_at');

-- export_job
-- 单号：DC + 8 位日期 + 流水（至少 3 位）；预发环境加 T 前缀。
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_job_no
  CHECK (job_no ~ '^T?DC[0-9]{8}[0-9]{3,}$');
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_export_key
  CHECK (export_key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$' AND char_length(export_key) <= 40);
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_format
  CHECK (format IN ('xlsx','csv'));
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_status
  CHECK (status IN ('queued','running','succeeded','failed','expired','cancelled'));
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_hashes
  CHECK (params_hash ~ '^[0-9a-f]{64}$' AND (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'));
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_json
  CHECK (jsonb_typeof(params) = 'object' AND jsonb_typeof(request_scope_snapshot) = 'object');
-- 不脱敏导出必填原因。
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_reason
  CHECK ((is_masked OR (reason IS NOT NULL AND char_length(btrim(reason)) > 0))
         AND (reason IS NULL OR char_length(reason) <= 100));
-- 认领序号：自动重试 1 次，最多认领 2 次。
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_counters
  CHECK (attempt_no BETWEEN 0 AND 2 AND download_count >= 0
         AND (row_count IS NULL OR row_count >= 0) AND (size_bytes IS NULL OR size_bytes >= 0));
-- 按状态必填：执行中必有租约与开始时间；成功与过期必有文件、行数、字节数、哈希、过期时间；
-- 成功、失败、取消必有结束时间；失败必有原因。
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_state_fields
  CHECK ((status <> 'running' OR (lease_until IS NOT NULL AND started_at IS NOT NULL AND attempt_no >= 1))
     AND (status NOT IN ('succeeded','expired')
          OR (file_id IS NOT NULL AND row_count IS NOT NULL AND size_bytes IS NOT NULL
              AND sha256 IS NOT NULL AND expires_at IS NOT NULL))
     AND (status NOT IN ('succeeded','failed','cancelled','expired') OR finished_at IS NOT NULL)
     AND (status <> 'failed' OR error IS NOT NULL)
     AND (status IN ('succeeded','expired') OR file_id IS NULL));
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_error
  CHECK (char_length(error) <= 200);
ALTER TABLE export_job ADD CONSTRAINT ck_export_job_downloads
  CHECK ((download_count = 0) = (last_downloaded_at IS NULL));
-- 同一申请人、同一导出、同一参数只允许一个进行中的任务：重复点击返回同一个任务。
CREATE UNIQUE INDEX uq_export_job_inflight ON export_job (requested_by_staff_id, export_key, params_hash)
  WHERE status IN ('queued','running');
-- worker 认领：WHERE status = 'queued' ORDER BY created_at。
CREATE INDEX ix_export_job_queued ON export_job (created_at)
  WHERE status = 'queued';
-- export.sweep 回收过期租约：WHERE status = 'running' AND lease_until < now。
CREATE INDEX ix_export_job_running_lease ON export_job (lease_until)
  WHERE status = 'running';
-- export.sweep 置过期并删文件：WHERE status = 'succeeded' AND expires_at < now。
CREATE INDEX ix_export_job_expiry ON export_job (expires_at)
  WHERE status = 'succeeded';
-- 申请内容不可改（留痕）：申请时写入的列创建后只读。format 例外，执行中可由 xlsx 改为 csv。
CREATE TRIGGER trg_export_job_immutable BEFORE UPDATE ON export_job
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change(
    'job_no', 'export_key', 'params', 'params_hash', 'requested_by_staff_id',
    'request_scope_snapshot', 'is_masked', 'reason', 'created_at');
CREATE TRIGGER trg_export_job_no_delete BEFORE DELETE ON export_job
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_export_job_no_truncate BEFORE TRUNCATE ON export_job
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- ===== 来源 ②：constraints/15-integration-ops.sql =====
-- 分组 15-integration-ops：回调收件（security）、租约与告警、不变量校验结果（ops）的手写约束。
-- 依据：docs/data-model/15-integration-ops.md；docs/appendix/design/d4-identity.md 第 9.6 节；
--       d2-payment.md 第 3.10 节；d7-platform.md 第 7.6、9.3、9.6 节；d3-flow.md 第 25.5 节；
--       rulings M19、M23、M42、M44、M50、M52、M63、M76、M96；第三轮各分组的检查项登记请求（14 分组 5.4）。
-- 只含 Prisma 表达不了的约束：CHECK、部分唯一索引、表达式唯一索引、部分索引与表达式索引、触发器。
-- 触发器一律用公共文件 00-common.sql 的函数（M50），本分组不定义自己的触发器函数。
-- 新增枚举取值按“先声明、下一版再写入”，用 NOT VALID + VALIDATE 替换 CHECK。
-- 不写跨节点时钟之间的先后关系 CHECK（first_seen_at 与 last_seen_at、started_at 与 finished_at 等）：
-- 写入方可能在不同节点，时钟偏差不应让告警或校验结果写不进去。

-- webhook_event
-- 回调来源：与 /api/v1/hooks/{provider}/ 的路径段一致；esign 在 V1.0 只声明。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_provider
  CHECK (provider IN ('wechatpay','wechat','wecom','ci','asr','sms','esign'));
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_mode
  CHECK (mode IN ('inline','inbox'));
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_process_state
  CHECK (process_state IN ('received','processed','ignored','failed','dead'));
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_event_id
  CHECK (event_id <> '' AND length(event_id) <= 200);
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_event_type
  CHECK (event_type <> '');
-- 原始报文的 sha256，32 字节。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_payload_digest
  CHECK (octet_length(payload_digest) = 32);
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_attempts
  CHECK (attempts >= 0);
-- 内联模式的行只可能是已处理或已忽略（去重行与处理结果同事务，d4 的 I21）。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_inline_state
  CHECK (mode <> 'inline' OR process_state IN ('processed','ignored'));
-- 处理完成时间与终态成对。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_processed_at
  CHECK ((process_state IN ('processed','ignored')) = (processed_at IS NOT NULL));
-- 待处理的行必有下一次处理时间，否则扫描永远捞不到它。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_next_attempt
  CHECK (process_state NOT IN ('received','failed') OR next_attempt_at IS NOT NULL);
-- 失败与死信必有错误摘要。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_error
  CHECK (process_state NOT IN ('failed','dead') OR error IS NOT NULL);
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_payload_object
  CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object');
-- 微信支付（M23）：载荷必有 summary（对象，长期保留），此外只允许 resourceCipher；
-- 摘要里任何层级都不得出现付款人标识（键名含 openid，不区分大小写，或键名为 payer）；
-- 密文必须是完整的三元组（AEAD_AES_256_GCM 解密要用 associated_data 与 nonce，d2 第 4.4 节第 5 步）。
-- 不保存解密后的明文。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_wechatpay_payload
  CHECK (provider <> 'wechatpay' OR (
    payload IS NOT NULL
    AND jsonb_typeof(payload -> 'summary') = 'object'
    AND (payload - ARRAY['summary','resourceCipher']) = '{}'::jsonb
    AND NOT jsonb_path_exists(payload -> 'summary',
          'strict $.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "openid" flag "i" || @.key == "payer")')
    AND (NOT (payload ? 'resourceCipher')
         OR (payload -> 'resourceCipher') ?& ARRAY['ciphertext','nonce','associated_data'])
  ));
-- 存了密文就必须记下密钥版本，否则轮换后无法回放。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_cipher_key_version
  CHECK (payload IS NULL OR NOT (payload ? 'resourceCipher') OR key_version IS NOT NULL);
-- summary 之外的载荷必须有计划清除时间。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_purge_required
  CHECK (payload IS NULL OR payload_purge_at IS NOT NULL OR (payload - 'summary') = '{}'::jsonb);
-- 计划清除时间不早于到达时间；有实际清除时间就必有计划清除时间。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_purge_plan
  CHECK ((payload_purge_at IS NULL OR payload_purge_at >= received_at)
         AND (payload_purged_at IS NULL OR payload_purge_at IS NOT NULL));
-- 清除之后载荷为空，或只剩 summary。
ALTER TABLE webhook_event ADD CONSTRAINT ck_webhook_event_payload_purged
  CHECK (payload_purged_at IS NULL OR payload IS NULL OR (payload - 'summary') = '{}'::jsonb);
-- 收件箱扫描：WHERE process_state IN ('received','failed') AND next_attempt_at <= now ORDER BY next_attempt_at。
CREATE INDEX ix_webhook_event_due ON webhook_event (next_attempt_at)
  WHERE process_state IN ('received','failed');
-- 死信列表与“回调积压”探针。
CREATE INDEX ix_webhook_event_dead ON webhook_event (received_at)
  WHERE process_state = 'dead';
-- 每日清除到期的载荷。
CREATE INDEX ix_webhook_event_purge_due ON webhook_event (payload_purge_at)
  WHERE payload_purge_at IS NOT NULL AND payload_purged_at IS NULL;
-- 举证用的列不可改（M50 的公共函数）。
CREATE TRIGGER trg_webhook_event_immutable BEFORE UPDATE ON webhook_event
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_column_change('provider', 'event_id', 'event_type', 'received_at', 'payload_digest');
-- 行不可删、表不可清空（保留期未定之前不清理；载荷到期清除是 UPDATE）。
CREATE TRIGGER trg_webhook_event_no_delete BEFORE DELETE ON webhook_event
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_webhook_event_no_truncate BEFORE TRUNCATE ON webhook_event
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- worker_lease
-- 至多一行（连同主键）；行由第一次续约插入，不靠迁移播种。名字被 CHECK 固定，不需要另设防改触发器。
ALTER TABLE worker_lease ADD CONSTRAINT ck_worker_lease_name
  CHECK (name = 'primary');
ALTER TABLE worker_lease ADD CONSTRAINT ck_worker_lease_holder
  CHECK (holder <> '' AND holder_version <> '');
-- 租约行不可删、表不可清空：删掉后虽然下一次续约会重新插入，但可能被另一实例抢先插入而接任，
-- 两个实例在一个续约周期内同时工作；租约只能经“让出”（把 heartbeat_at 改早）交出（M50 的公共函数）。
CREATE TRIGGER trg_worker_lease_no_delete BEFORE DELETE ON worker_lease
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_delete();
CREATE TRIGGER trg_worker_lease_no_truncate BEFORE TRUNCATE ON worker_lease
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_delete();

-- alert_event
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_severity
  CHECK (severity IN ('P1','P2','P3'));
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_kind
  CHECK (kind IN ('probe','event'));
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_status
  CHECK (status IN ('open','acked','resolved'));
-- 规则键：小写点分，至少两段。
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_rule
  CHECK (rule ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');
-- 指纹 = 规则键，或 规则键 + ':' + 维度。
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_fingerprint
  CHECK (left(fingerprint, length(rule)) = rule
         AND (length(fingerprint) = length(rule)
              OR (substr(fingerprint, length(rule) + 1, 1) = ':' AND length(fingerprint) > length(rule) + 1)));
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_counts
  CHECK (occurrences >= 1 AND ok_streak >= 0 AND notify_count >= 0);
-- 连续正常次数只对探针型有意义。
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_ok_streak_kind
  CHECK (kind = 'probe' OR ok_streak = 0);
-- 恢复时间与已恢复状态成对。
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_resolved
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL));
-- 未认领的没有认领时间；已认领的必有认领时间；认领人与认领时间同有同无
-- （后台与命令行都以员工身份认领，M44 的单一操作人类型）。
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_acked
  CHECK ((status <> 'open' OR acked_at IS NULL)
         AND (status <> 'acked' OR acked_at IS NOT NULL)
         AND ((acked_at IS NULL) = (acked_by_staff_id IS NULL)));
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_notified
  CHECK ((notify_count = 0) = (last_notified_at IS NULL));
ALTER TABLE alert_event ADD CONSTRAINT ck_alert_event_last_value
  CHECK (last_value IS NULL OR jsonb_typeof(last_value) = 'object');
-- 同一指纹至多一条未恢复的告警；探针与 raise() 的写入用它做 ON CONFLICT，
-- 命中时 severity = LEAST(旧值, 新值)（'P1' < 'P2' < 'P3'），只升不降。
CREATE UNIQUE INDEX uq_alert_event_open_fingerprint ON alert_event (fingerprint)
  WHERE status IN ('open','acked');

-- invariant_run
ALTER TABLE invariant_run ADD CONSTRAINT ck_invariant_run_mode
  CHECK (mode IN ('quick','full'));
ALTER TABLE invariant_run ADD CONSTRAINT ck_invariant_run_trigger
  CHECK (trigger IN ('schedule','deploy','drill','manual'));
ALTER TABLE invariant_run ADD CONSTRAINT ck_invariant_run_status
  CHECK (status IN ('running','succeeded','failed'));
-- 结束时间与运行状态成对。
ALTER TABLE invariant_run ADD CONSTRAINT ck_invariant_run_finished
  CHECK ((status = 'running') = (finished_at IS NULL));
-- 失败必有错误摘要，成功没有。
ALTER TABLE invariant_run ADD CONSTRAINT ck_invariant_run_error
  CHECK ((status <> 'failed' OR error IS NOT NULL) AND (status <> 'succeeded' OR error IS NULL));
ALTER TABLE invariant_run ADD CONSTRAINT ck_invariant_run_counts
  CHECK (checks_run >= 0 AND violations_found >= 0);
ALTER TABLE invariant_run ADD CONSTRAINT ck_invariant_run_scope
  CHECK (scope IS NULL OR jsonb_typeof(scope) = 'object');

-- invariant_violation
-- 检查项编号：<命名空间>.<编号>，如 billing.I3、payment.I5、flow.STUCK_TICKET。
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_code
  CHECK (code ~ '^[a-z][a-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$');
-- 登记检查项的模块：01 第 5 节的模块名。
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_module
  CHECK (module IN (
    'kernel','events','timers','flow','sla','audit','config','security','authz','providers',
    'identity','tenant','staff','approval','portal','profile','content','media','notify','docs',
    'billing','order','ad','delivery','publish','support','workbench',
    'analytics','reports','exports','ops'));
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_severity
  CHECK (severity IN ('P1','P2'));
-- 违规对象的类型取最终表名（M19）；数据库只校验格式，取值由检查项登记表在启动时对照表名单校验。
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_subject_type
  CHECK (subject_type IS NULL OR subject_type ~ '^[a-z][a-z0-9_]*$');
-- 全局性违规：subject_type、subject_id 为空；subject_key 可选，用来区分同一检查项下的多条全局违规
-- （参数键、开关键、清单编码等不是某张表一行的对象，14 分组 5.4）。
-- 有对象时 subject_type 必填，subject_id 与 subject_key 恰填一个。
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_subject
  CHECK ((subject_type IS NULL AND subject_id IS NULL)
         OR (subject_type IS NOT NULL AND (subject_id IS NULL) <> (subject_key IS NULL)));
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_subject_key
  CHECK (subject_key IS NULL OR subject_key <> '');
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_detail
  CHECK (jsonb_typeof(detail) = 'object');
-- 所属主体写在 detail.entityId（全局表不带归属列）：有这个键就必须是 uuid 文本，按主体查询走表达式索引。
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_detail_entity_id
  CHECK (NOT (detail ? 'entityId')
         OR (detail ->> 'entityId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
-- 处理时间与处理结论成对；处理结论不能是空白；有处理人就有处理时间；
-- 已解决的行要么有处理人（后台与命令行都以员工身份处理，M44），要么是 heal_only 检查项自愈后自动关闭的（auto_healed_at 非空）。
ALTER TABLE invariant_violation ADD CONSTRAINT ck_invariant_violation_resolved
  CHECK ((resolved_at IS NULL) = (resolution IS NULL)
         AND (resolution IS NULL OR btrim(resolution) <> '')
         AND (resolved_by_staff_id IS NULL OR resolved_at IS NOT NULL)
         AND (resolved_at IS NULL OR resolved_by_staff_id IS NOT NULL OR auto_healed_at IS NOT NULL));
-- 同一检查项对同一对象至多一条未解决的违规；持续存在时更新 last_seen_at、detail、auto_healed_at。
-- 可空列参与唯一：用 COALESCE 表达式索引，写入方的 ON CONFLICT 用同一组表达式。
CREATE UNIQUE INDEX uq_invariant_violation_open ON invariant_violation
  (code, COALESCE(subject_type, ''), COALESCE(subject_id::text, subject_key, ''))
  WHERE resolved_at IS NULL;
-- 后台“系统健康”“流程运维”两页的未解决列表；告警规则“不变量校验失败”按级别计数。
CREATE INDEX ix_invariant_violation_unresolved ON invariant_violation (severity, first_seen_at)
  WHERE resolved_at IS NULL;
-- /health 计费分节的 openViolations 与后台按模块计数（d1:1530）。
CREATE INDEX ix_invariant_violation_module_unresolved ON invariant_violation (module, severity)
  WHERE resolved_at IS NULL;
-- 按主体查看违规（d1:1539、1714 的单主体校验与处理；商家详情）。
CREATE INDEX ix_invariant_violation_entity_id ON invariant_violation ((detail ->> 'entityId'), first_seen_at);
