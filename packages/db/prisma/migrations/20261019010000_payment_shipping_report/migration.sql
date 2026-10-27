-- W4-09 发货受理状态结构前置；仅声明，不安装 writer/job，不触发渠道调用。
BEGIN;

ALTER TABLE payment_txn
  ADD COLUMN shipping_report_state text,
  ADD COLUMN shipping_report_appid text,
  ADD COLUMN shipping_report_mchid text,
  ADD COLUMN shipping_report_item_desc text,
  ADD COLUMN shipping_report_upload_time timestamptz(3),
  ADD COLUMN shipping_report_confirmed_at timestamptz(3);

ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_shipping_report_state
  CHECK (shipping_report_state IN ('unknown','not_accepted','confirmed'));

-- 显式 IS NOT NULL 防止 CHECK 将部分意图的 SQL UNKNOWN 当作通过。
-- 仅行内资格；付款单反向关联/配置一致及状态迁移须由后继 writer 在原锁序下校验。
ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_shipping_report_intent
  CHECK (
    (shipping_report_state IS NULL
      AND shipping_report_appid IS NULL AND shipping_report_mchid IS NULL
      AND shipping_report_item_desc IS NULL AND shipping_report_upload_time IS NULL
      AND shipping_report_confirmed_at IS NULL)
    OR (shipping_report_state IS NOT NULL
      AND shipping_report_appid IS NOT NULL AND shipping_report_appid ~ '^[A-Za-z0-9_-]{1,128}$'
      AND shipping_report_mchid IS NOT NULL AND shipping_report_mchid ~ '^[0-9]{6,20}$'
      AND shipping_report_item_desc IS NOT NULL
      AND char_length(btrim(shipping_report_item_desc)) > 0 AND char_length(shipping_report_item_desc) <= 120
      AND shipping_report_upload_time IS NOT NULL
      AND channel = 'wechat_jsapi' AND status = 'succeeded'
      AND entity_id IS NOT NULL AND billing_order_id IS NOT NULL AND applied_at IS NOT NULL
      AND channel_txn_no IS NOT NULL AND char_length(btrim(channel_txn_no)) > 0
      AND channel_amount_fen IS NOT NULL
      AND channel_payer_ref IS NOT NULL AND char_length(btrim(channel_payer_ref)) > 0)
  );

ALTER TABLE payment_txn ADD CONSTRAINT ck_payment_txn_shipping_report_confirmation
  CHECK (
    (shipping_report_state IS DISTINCT FROM 'confirmed' AND shipping_report_confirmed_at IS NULL)
    OR (shipping_report_state IS NOT DISTINCT FROM 'confirmed'
      AND shipping_report_confirmed_at IS NOT NULL AND shipping_report_upload_time IS NOT NULL
      AND shipping_report_confirmed_at >= shipping_report_upload_time)
  );

COMMIT;
