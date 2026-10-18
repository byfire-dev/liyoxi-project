-- W2-17 独立结构能力：公告通知持久化分页；原三份迁移及冻结底稿保持不变。
-- 表/普通索引/FK 来自实际三份旧迁移库 → 当前 schema 的只读 Prisma 草稿。
-- 已审删除唯一已知的 ix_store_asset_search 假 DROP；该 DROP 未执行。
BEGIN;

CREATE TABLE "notification_fanout" (
    "id" UUID NOT NULL,
    "source_outbox_event_id" UUID NOT NULL,
    "notify_scene_key" TEXT NOT NULL,
    "site_notice_id" UUID NOT NULL,
    "cursor_merchant_user_id" UUID,
    "cursor_entity_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "attempt_no" INTEGER NOT NULL DEFAULT 0,
    "lease_until" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_notification_fanout" PRIMARY KEY ("id")
);

CREATE INDEX "ix_notification_fanout_site_notice_id" ON "notification_fanout"("site_notice_id");

CREATE UNIQUE INDEX "uq_notification_fanout_scene_notice" ON "notification_fanout"("notify_scene_key", "site_notice_id");

ALTER TABLE "notification_fanout" ADD CONSTRAINT "fk_notification_fanout_notify_scene_key" FOREIGN KEY ("notify_scene_key") REFERENCES "notify_scene"("scene_key") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_fanout" ADD CONSTRAINT "fk_notification_fanout_site_notice_id" FOREIGN KEY ("site_notice_id") REFERENCES "site_notice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 下列 CHECK、部分索引及授权按正式设计人工补充。
-- 场景沿现有注册表/FK，消费端仅接公告/撤回；不另建场景枚举。
ALTER TABLE "notification_fanout"
  ADD CONSTRAINT "ck_notification_fanout_scene" CHECK (notify_scene_key ~ '^m\.[a-z][a-z0-9_]*$'),
  ADD CONSTRAINT "ck_notification_fanout_status" CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'cancelled')),
  ADD CONSTRAINT "ck_notification_fanout_cursor" CHECK ((cursor_merchant_user_id IS NULL) = (cursor_entity_id IS NULL)),
  ADD CONSTRAINT "ck_notification_fanout_attempt" CHECK (attempt_no >= 0 AND attempt_no <= 3),
  ADD CONSTRAINT "ck_notification_fanout_lease" CHECK ((status = 'sending') = (lease_until IS NOT NULL)),
  ADD CONSTRAINT "ck_notification_fanout_finished" CHECK ((status IN ('sent', 'failed', 'skipped', 'cancelled')) = (finished_at IS NOT NULL));
CREATE INDEX "ix_notification_fanout_pending_due" ON "notification_fanout" ("due_at", "id") WHERE status = 'pending';
CREATE INDEX "ix_notification_fanout_sending_lease" ON "notification_fanout" ("lease_until", "id") WHERE status = 'sending';
GRANT SELECT, INSERT, UPDATE ON TABLE "notification_fanout" TO lyx_app;
-- readonly 的 SELECT 继承原迁移属主默认授权，不增加 PUBLIC 或应用 DDL 权限。
COMMIT;
