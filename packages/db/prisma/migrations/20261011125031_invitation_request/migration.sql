-- W2-10 独立结构前置；SOURCE 草稿，正式旧库 Prisma diff 对照待 GLOBAL。
-- 保留五条旧迁移及冻结底稿；只保存真实请求绑定，不引入业务 producer。
BEGIN;

-- 写入与全状态回填同一窗口，不允许旧邀请在扫描期间变化。
LOCK TABLE "invitation" IN SHARE ROW EXCLUSIVE MODE;

CREATE UNIQUE INDEX "uq_invitation_id_inviter_entity_store"
  ON "invitation"("id", "inviter_member_id", "entity_id", "store_id");

CREATE TABLE "invitation_request" (
    "id" UUID NOT NULL,
    "inviter_member_id" UUID NOT NULL,
    "client_request_id" UUID NOT NULL,
    "invitation_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_invitation_request" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_invitation_request_inviter_client"
  ON "invitation_request"("inviter_member_id", "client_request_id");

CREATE INDEX "ix_invitation_request_invitation_id"
  ON "invitation_request"("invitation_id");

ALTER TABLE "invitation_request" ADD CONSTRAINT "fk_invitation_request_entity_id"
  FOREIGN KEY ("entity_id") REFERENCES "entity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "invitation_request" ADD CONSTRAINT "fk_invitation_request_store_entity"
  FOREIGN KEY ("store_id", "entity_id") REFERENCES "store"("id", "entity_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "invitation_request" ADD CONSTRAINT "fk_invitation_request_inviter_entity"
  FOREIGN KEY ("inviter_member_id", "entity_id") REFERENCES "entity_member"("id", "entity_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "invitation_request" ADD CONSTRAINT "fk_invitation_request_invitation_scope"
  FOREIGN KEY ("invitation_id", "inviter_member_id", "entity_id", "store_id")
  REFERENCES "invitation"("id", "inviter_member_id", "entity_id", "store_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER "trg_invitation_request_append_only"
  BEFORE UPDATE OR DELETE ON "invitation_request"
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();

CREATE TRIGGER "trg_invitation_request_no_truncate"
  BEFORE TRUNCATE ON "invitation_request"
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

-- 不筛状态；旧请求只有原创建键，不能推断未持久化的复用键。
INSERT INTO "invitation_request"
  ("id", "inviter_member_id", "client_request_id", "invitation_id", "entity_id", "store_id", "created_at")
SELECT "id", "inviter_member_id", "client_request_id", "id", "entity_id", "store_id", "created_at"
FROM "invitation";

-- 任一漏行、错绑或多余行都回滚整条迁移，不以 ON CONFLICT 掩盖差异。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "invitation" i
    FULL JOIN "invitation_request" r ON r."id" = i."id"
    WHERE i."id" IS NULL OR r."id" IS NULL
       OR (r."inviter_member_id", r."client_request_id", r."invitation_id", r."entity_id", r."store_id", r."created_at")
          IS DISTINCT FROM (i."inviter_member_id", i."client_request_id", i."id", i."entity_id", i."store_id", i."created_at")
  ) THEN
    RAISE EXCEPTION 'invitation_request backfill mismatch';
  END IF;
END;
$$;

GRANT SELECT, INSERT ON TABLE "invitation_request" TO lyx_app;
-- readonly 的 SELECT 沿原属主默认授权，无 PUBLIC/UPDATE/DELETE/TRUNCATE 授权。
COMMIT;
