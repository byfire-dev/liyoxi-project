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
