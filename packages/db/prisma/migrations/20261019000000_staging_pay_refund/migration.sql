-- W4-09 独立结构与读兼容前置；不注册系统退款 writer/job。
-- 旧人工来源和审批类型逐支保留；新类型只表达明确的预发系统意图。
BEGIN;

ALTER TABLE refund_request
  ADD COLUMN is_executed_by_system boolean NOT NULL DEFAULT false;

-- lyx:allow W4-09精确扩展ck_approval_request_kind，旧来源/类型条件保留，新系统分支另有限制。
ALTER TABLE approval_request DROP CONSTRAINT ck_approval_request_kind;
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_kind
  CHECK (kind IN ('qualification','channel_account','launch_link','order_cancel','ad_cancel','qualification_cancel',
                  'plan_refund','points_adjust','subscription_extend','finance_config_change','account_change',
                  'transfer_confirm','staging_pay_refund'));

-- lyx:allow W4-09精确扩展ck_approval_request_subject_type，旧来源/类型条件保留，新系统分支另有限制。
ALTER TABLE approval_request DROP CONSTRAINT ck_approval_request_subject_type;
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_subject_type
  CHECK (CASE kind
           WHEN 'qualification'         THEN subject_type = 'store'
           WHEN 'channel_account'       THEN subject_type = 'channel_account'
           WHEN 'launch_link'           THEN subject_type = 'launch_submission'
           WHEN 'order_cancel'          THEN subject_type = 'drama_order'
           WHEN 'ad_cancel'             THEN subject_type = 'ad'
           WHEN 'qualification_cancel'  THEN subject_type = 'store'
           WHEN 'staging_pay_refund'    THEN subject_type = 'billing_order'
           WHEN 'plan_refund'           THEN subject_type IN ('billing_order','payment_txn')
           WHEN 'points_adjust'         THEN subject_type = 'billing_account'
           WHEN 'subscription_extend'   THEN subject_type = 'subscription_term'
           WHEN 'finance_config_change' THEN subject_type = 'finance_config_revision'
           WHEN 'account_change'        THEN subject_type IN ('merchant_user','entity')
           WHEN 'transfer_confirm'      THEN subject_type = 'transfer_proof'
           ELSE false
         END);

-- lyx:allow W4-09精确扩展ck_approval_request_tenant，旧来源/类型条件保留，新系统分支另有限制。
ALTER TABLE approval_request DROP CONSTRAINT ck_approval_request_tenant;
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_tenant
  CHECK ((store_id IS NULL OR entity_id IS NOT NULL)
         AND CASE
               WHEN kind IN ('qualification','channel_account','launch_link','order_cancel','ad_cancel','qualification_cancel')
                 THEN entity_id IS NOT NULL AND store_id IS NOT NULL
               WHEN kind IN ('points_adjust','subscription_extend','transfer_confirm')
                 THEN entity_id IS NOT NULL
               WHEN kind = 'staging_pay_refund'
                 THEN entity_id IS NOT NULL AND store_id IS NULL
               WHEN kind = 'plan_refund'
                 THEN entity_id IS NOT NULL OR subject_type = 'payment_txn'
               WHEN kind = 'finance_config_change'
                 THEN entity_id IS NULL AND store_id IS NULL
               WHEN kind = 'account_change'
                 THEN store_id IS NULL AND (subject_type <> 'entity' OR entity_id IS NOT NULL)
               ELSE false
             END);

-- lyx:allow W4-09精确扩展ck_approval_request_request_no，旧来源/类型条件保留，新系统分支另有限制。
ALTER TABLE approval_request DROP CONSTRAINT ck_approval_request_request_no;
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_request_no
  CHECK ((request_no IS NOT NULL) = (kind IN ('order_cancel','ad_cancel','qualification_cancel','plan_refund',
                                              'points_adjust','subscription_extend','account_change','staging_pay_refund')));

-- lyx:allow W4-09精确扩展ck_approval_request_submitter，旧来源/类型条件保留，新系统分支另有限制。
ALTER TABLE approval_request DROP CONSTRAINT ck_approval_request_submitter;
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_submitter
  CHECK ((submit_actor_type = 'system') = (submit_actor_id IS NULL)
         AND (submit_actor_type <> 'system' OR submit_client IS NULL)
         AND (submit_actor_type <> 'staff'
              OR (submit_client IS NOT DISTINCT FROM 'admin' AND submit_actor_id IS NOT DISTINCT FROM requester_staff_id))
         AND (submit_actor_type <> 'merchant' OR COALESCE(submit_client IN ('weapp','portal'), false))
         AND (category <> 'approval' OR requester_staff_id IS NOT NULL OR kind = 'staging_pay_refund')
         AND (requester_staff_group_id IS NULL OR requester_staff_id IS NOT NULL));

-- lyx:allow W4-09精确扩展ck_approval_request_dedupe_key，旧来源/类型条件保留，新系统分支另有限制。
ALTER TABLE approval_request DROP CONSTRAINT ck_approval_request_dedupe_key;
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_dedupe_key
  CHECK ((dedupe_key IS NULL) = (kind IN ('order_cancel','ad_cancel','qualification_cancel','plan_refund','staging_pay_refund')));

-- lyx:allow W4-09精确扩展ck_refund_request_source，旧来源/类型条件保留，新系统分支另有限制。
ALTER TABLE refund_request DROP CONSTRAINT ck_refund_request_source;
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_source CHECK (source IN ('customer_service', 'exception', 'staging_probe'));

-- lyx:allow W4-09精确扩展ck_refund_request_executed，旧来源/类型条件保留，新系统分支另有限制。
ALTER TABLE refund_request DROP CONSTRAINT ck_refund_request_executed;
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_executed CHECK (status NOT IN ('executing','done') OR (exec_route IS NOT NULL AND executed_at IS NOT NULL
    AND ((source <> 'staging_probe' AND executed_by_staff_id IS NOT NULL AND NOT is_executed_by_system)
      OR (source = 'staging_probe' AND executed_by_staff_id IS NULL AND is_executed_by_system))));

-- 仅新类型免真实发起员工；人工类型仍受原submitter/decision/职责分离约束。
ALTER TABLE approval_request ADD CONSTRAINT ck_approval_request_staging_system
  CHECK (kind <> 'staging_pay_refund' OR (
    submit_actor_type = 'system' AND submit_actor_id IS NULL AND submit_client IS NULL
    AND requester_staff_id IS NULL AND requester_staff_group_id IS NULL
    AND decided_by_staff_id IS NULL
    AND (status NOT IN ('approved','rejected') OR is_decided_by_system)
  ));

-- 新来源只能既有window原路小额退款；false默认保留全部旧执行事实。
-- 失败后回待执行可能已有真实执行意图：按executed_at保留执行者事实，不按状态清空历史。
-- pending_approval无执行事实；已置系统位还须由payment.I11核真实退款交易，不能先冒标。
ALTER TABLE refund_request ADD CONSTRAINT ck_refund_request_staging_system
  CHECK (
    (source <> 'staging_probe' AND NOT is_executed_by_system)
    OR (source = 'staging_probe'
      AND rule_code = 'window' AND NOT is_override AND amount_fen BETWEEN 1 AND 100
      AND entity_id IS NOT NULL AND billing_order_id IS NOT NULL AND reason_code IS NULL
      AND executed_by_staff_id IS NULL
      AND (exec_route IS NULL OR exec_route = 'wechat_original')
      AND is_executed_by_system = (executed_at IS NOT NULL)
      AND (NOT is_executed_by_system OR exec_route IS NOT DISTINCT FROM 'wechat_original')
      AND (status <> 'pending_approval' OR NOT is_executed_by_system)
    )
  );

COMMIT;
