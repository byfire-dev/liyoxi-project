-- Prisma diff from all previously deployed migrations; only the documented search-index false DROP removed.
BEGIN;

-- CreateTable
CREATE TABLE "subscription_event_daily_supplement" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "entity_id" UUID NOT NULL,
    "subscription_term_id" UUID NOT NULL,
    "event_fingerprint" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "evidence_hash" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "source_sha" TEXT NOT NULL,
    "baseline_sha" TEXT NOT NULL,
    "authorized_by_staff_id" UUID NOT NULL,
    "operator" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pk_subscription_event_daily_supplement" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX uq_subscription_daily_supplement_event_id ON subscription_event_daily_supplement(event_id);

-- CreateIndex
CREATE UNIQUE INDEX "uq_subscription_event_id_entity_term" ON "subscription_event"("id", "entity_id", "subscription_term_id");

-- AddForeignKey
ALTER TABLE "subscription_event_daily_supplement" ADD CONSTRAINT "fk_subscription_event_daily_supplement_event_scope" FOREIGN KEY ("event_id", "entity_id", "subscription_term_id") REFERENCES "subscription_event"("id", "entity_id", "subscription_term_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "subscription_event_daily_supplement" ADD CONSTRAINT "fk_subscription_event_daily_supplement_authorizer" FOREIGN KEY ("authorized_by_staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


ALTER TABLE subscription_event_daily_supplement
  ADD CONSTRAINT ck_subscription_daily_supplement_hashes CHECK (
    event_fingerprint ~ '^[0-9a-f]{64}$' AND payload_hash ~ '^[0-9a-f]{64}$' AND evidence_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT ck_subscription_daily_supplement_sources CHECK (
    source_sha ~ '^[0-9a-f]{40}$' AND baseline_sha ~ '^[0-9a-f]{40}$'),
  ADD CONSTRAINT ck_subscription_daily_supplement_strategy CHECK (strategy = 'legacy_activation_v1'),
  ADD CONSTRAINT ck_subscription_daily_supplement_objects CHECK (jsonb_typeof(payload) = 'object' AND jsonb_typeof(evidence) = 'object'),
  ADD CONSTRAINT ck_subscription_daily_supplement_operator CHECK (char_length(btrim(operator)) BETWEEN 1 AND 200),
  ADD CONSTRAINT ck_subscription_daily_supplement_reason CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000);

CREATE TRIGGER trg_subscription_daily_supplement_append_only
  BEFORE UPDATE OR DELETE ON subscription_event_daily_supplement
  FOR EACH ROW EXECUTE FUNCTION lyx_forbid_mutation();
CREATE TRIGGER trg_subscription_daily_supplement_no_truncate
  BEFORE TRUNCATE ON subscription_event_daily_supplement
  FOR EACH STATEMENT EXECUTE FUNCTION lyx_forbid_mutation();

GRANT SELECT, INSERT ON TABLE subscription_event_daily_supplement TO lyx_app;
COMMIT;
