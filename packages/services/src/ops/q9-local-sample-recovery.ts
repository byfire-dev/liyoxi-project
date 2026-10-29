import {
  ChecklistItemsSchema,
  FlagRulesSchema,
  IdSchema,
  SampleInspectBodySchema,
  z,
} from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { assertAccess, assertPermission, hasPermission, taskScope } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { matchesRule } from "../config/index.js";
import type { Config, ConfigAdmin } from "../config/index.js";
import { createDelivery } from "../delivery/index.js";
import type { Events } from "../events/index.js";
import type { Flow } from "../flow/index.js";
import {
  AppError,
  createIdempotencyContext,
  createIdentityContext,
  isAppError,
  isIdempotencyKey,
} from "../kernel/index.js";
import type { Assembly, Clock, Env, TxRunner } from "../kernel/index.js";
import type { Media } from "../media/index.js";
import type { Providers } from "../providers/types.js";
import { createSla } from "../sla/index.js";
import { loadCliStaffContext } from "../staff/index.js";
import { q9LocalSampleRecoveryEnv } from "./q9-local-sample-recovery-env.js";

const FLAG = "weapp.video.sample.enabled";
const SCOPE = "cli.q9.sample.recover";
const reason = z.string().trim().min(10).max(200);
export const Q9LocalSampleRecoveryInputSchema = z.strictObject({
  storeId: IdSchema,
  sampleId: IdSchema,
  versionNo: z.int().positive(),
  staffId: IdSchema,
  configStaffId: IdSchema,
  reason,
  quality: SampleInspectBodySchema,
  idempotencyKey: z.string().refine(isIdempotencyKey),
  apply: z.boolean().default(false),
});
export type Q9LocalSampleRecoveryInput = z.infer<typeof Q9LocalSampleRecoveryInputSchema>;

interface Q9LocalSampleRecoveryDeps {
  readonly env: Pick<Env, "APP_ENV" | "DATABASE_URL" | "REDIS_URL" | "MINIO" | "MEDIA_PRODUCTION">;
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly assembly: Assembly;
  readonly flow: Flow;
  readonly events: Events;
  readonly media: Pick<
    Media,
    "signRead" | "link" | "release" | "prepareDeliveryProduction" | "deliveryProductionFacts"
  >;
  readonly providers: Pick<Providers, "storage">;
  readonly config: Pick<Config, "cache" | "flags">;
  readonly configAdmin: Pick<ConfigAdmin, "updateFlag">;
}

function ticketScope(staff: StaffContext): Prisma.DeliveryTicketWhereInput {
  const scope = taskScope<Prisma.DeliveryTicketWhereInput>(staff.scope, {
    assignees: [
      {
        col: "deliveryManagerId",
        ...(staff.staff.isLead && hasPermission(staff, "merchant.manager.assign")
          ? { pool: "store_manager" as const }
          : {}),
      },
      { col: "editorId" },
      { col: "publisherId", pool: "ticket_publisher" },
    ],
  });
  return staff.moduleLevels.delivery === "o"
    ? { AND: [scope, { OR: [{ editorId: staff.staff.id }, { publisherId: staff.staff.id }] }] }
    : scope;
}

/** A narrow local adapter: the delivery owner remains the only recovery writer. */
export function createQ9LocalSampleRecovery(runtime: Q9LocalSampleRecoveryDeps) {
  // Recheck the typed runtime too; callers cannot bypass the command's environment boundary.
  const production = runtime.env.MEDIA_PRODUCTION;
  q9LocalSampleRecoveryEnv({
    APP_ENV: runtime.env.APP_ENV,
    DATABASE_URL: runtime.env.DATABASE_URL,
    REDIS_URL: runtime.env.REDIS_URL,
    MINIO_ENDPOINT: runtime.env.MINIO?.endpoint,
    MINIO_PUBLIC_ENDPOINT: runtime.env.MINIO?.publicEndpoint,
    LYX_Q9_MEDIA_WORK_DIR: production && "mode" in production ? production.workDir : undefined,
    LYX_Q9_MEDIA_SOCKET: production && "mode" in production ? production.socketPath : undefined,
  });
  if (!production || !("mode" in production) || production.mode !== "local_sample_watermark")
    throw new AppError("STATE_NOT_ALLOWED");
  if (runtime.providers.storage.status !== "local") throw new AppError("STATE_NOT_ALLOWED");
  const delivery = createDelivery({
    tx: runtime.tx,
    clock: runtime.clock,
    assembly: runtime.assembly,
    flow: runtime.flow,
    events: runtime.events,
    media: runtime.media,
    sla: createSla({ clock: runtime.clock, assembly: runtime.assembly }),
    // This adapter exposes samplePush only; unrelated manager assignment is fail-closed.
    profile: {
      assignDeliveryManager: async () => {
        throw new AppError("PROVIDER_UNAVAILABLE");
      },
    },
    samplePlayback: (entityId) => runtime.config.flags.isEnabled(FLAG, { entityId }),
  });

  return {
    async run(input: Q9LocalSampleRecoveryInput, signal?: AbortSignal) {
      const value = Q9LocalSampleRecoveryInputSchema.parse(input);
      signal?.throwIfAborted();
      const identity = createIdentityContext({
        actor: { type: "staff", id: value.staffId, client: "cli" },
      });
      const intent = {
        storeId: value.storeId,
        sampleId: value.sampleId,
        versionNo: value.versionNo,
        staffId: value.staffId,
        configStaffId: value.configStaffId,
        reason: value.reason,
        quality: value.quality,
      };
      const idem = createIdempotencyContext({
        mode: "required",
        scope: SCOPE,
        actor: identity.actor,
        key: value.idempotencyKey,
        request: { method: "CLI", body: intent },
      });
      // No audit, idempotency claim, file reference or business write occurs in preflight.
      const inspected = await runtime.tx.run(async (tx) => {
        const staffContexts = new Map<string, StaffContext>();
        for (const id of [...new Set([value.staffId, value.configStaffId])].sort())
          staffContexts.set(id, await loadCliStaffContext(tx, id));
        const staff = staffContexts.get(value.staffId)!;
        const configStaff = staffContexts.get(value.configStaffId)!;
        assertAccess(staff, { module: { module: "delivery", need: "edit" }, permission: null });
        assertPermission(staff, "delivery.sample.push", runtime.clock.now());
        assertPermission(staff, "delivery.sample.qc", runtime.clock.now());
        assertPermission(configStaff, "sys.super_admin", runtime.clock.now());
        const sample = await tx.sample.findFirst({
          where: {
            id: value.sampleId,
            storeId: value.storeId,
            deliveryTicket: ticketScope(staff),
          },
          include: {
            deliveryTicket: {
              select: {
                id: true,
                step: true,
                currentSampleVersionNo: true,
                pauseCount: true,
                orderItemId: true,
                orderItem: { select: { phase: true } },
                dramaOrder: { select: { status: true } },
              },
            },
            store: { select: { name: true, lifecycle: true } },
          },
        });
        if (!sample) throw new AppError("NOT_FOUND");
        const flag = await tx.featureFlag.findUnique({ where: { key: FLAG } });
        if (!flag || flag.valueType !== "bool" || typeof flag.defaultValue !== "boolean")
          throw new AppError("VALIDATION_FAILED");
        const rules = FlagRulesSchema.parse(flag.rules);
        if (rules.some((rule) => typeof rule.value !== "boolean"))
          throw new AppError("VALIDATION_FAILED");
        // Same entity-only context as delivery.samplePlayback; preserve every existing rule.
        const hit = rules.find((rule) => matchesRule(rule.when, { entityId: sample.entityId }));
        const enabledAfterDefaultChange = hit ? hit.value === true : true;
        const existing = await tx.idempotencyRecord.findUnique({
          where: {
            scope_actorKey_key: {
              scope: SCOPE,
              actorKey: idem.actorKey!,
              key: value.idempotencyKey,
            },
          },
          select: { requestHash: true, state: true },
        });
        if (existing && existing.requestHash !== idem.requestHash)
          throw new AppError("IDEMPOTENCY_KEY_REUSED");
        if (existing && existing.state !== "done") throw new AppError("IDEMPOTENCY_IN_PROGRESS");
        const replay = !!existing;
        const template = await tx.checklistTemplate.findFirst({
          where: { code: "qc.sample", status: "active" },
          select: { versionNo: true, items: true },
        });
        const items = template ? ChecklistItemsSchema.parse(template.items) : [];
        const productionFacts = await runtime.media.deliveryProductionFacts(tx, sample.fileId);
        const sourceQc = sample.qcRecordId
          ? await tx.qcRecord.findUnique({ where: { id: sample.qcRecordId } })
          : null;
        const latest = await tx.sample.findFirst({
          where: { deliveryTicketId: sample.deliveryTicketId },
          orderBy: { versionNo: "desc" },
          select: { id: true },
        });
        const blockers: string[] = [];
        if (!replay && !enabledAfterDefaultChange) blockers.push("FLAG_RULE_STILL_DISABLED");
        if (!replay) {
          if (
            sample.status !== "pushed" ||
            !sample.previewChannels.length ||
            !sample.previewChannels.every((channel) =>
              ["album", "portal", "wecom"].includes(channel),
            ) ||
            sample.decidedAt ||
            sample.decidedByUserId ||
            sample.decideClient ||
            sample.confirmViewedVia ||
            sample.onBehalfStaffId ||
            sample.feedbackKind ||
            sample.feedbackNote ||
            sample.feedbackTimeMs !== null ||
            sample.feedbackFileIds.length ||
            sample.viewedAckAt ||
            sample.deliveryTicket.step !== "sample_confirm" ||
            sample.deliveryTicket.currentSampleVersionNo !== value.versionNo ||
            sample.versionNo !== value.versionNo ||
            latest?.id !== sample.id
          )
            blockers.push("LEGACY_SAMPLE_STATE_CHANGED");
          if (
            sample.store.lifecycle !== "active" ||
            sample.deliveryTicket.orderItem.phase !== "producing" ||
            ["cancelled", "refunded"].includes(sample.deliveryTicket.dramaOrder.status)
          )
            blockers.push("ORDER_OR_STORE_CLOSED");
          if (sample.deliveryTicket.pauseCount) blockers.push("TICKET_ON_HOLD");
          if (sample.uploadedByStaffId === value.staffId) blockers.push("QC_SELF_INSPECTION");
          if (!productionFacts.ready || !productionFacts.playable)
            blockers.push("SAMPLE_PREVIEW_NOT_READY");
          if (
            !sourceQc ||
            sourceQc.verdict !== "pass" ||
            sourceQc.checklistCode !== "qc.sample" ||
            sourceQc.targetType !== "sample" ||
            sourceQc.targetId !== sample.id ||
            sourceQc.deliveryTicketId !== sample.deliveryTicketId ||
            sourceQc.entityId !== sample.entityId ||
            sourceQc.storeId !== sample.storeId ||
            sourceQc.inspectedByStaffId === sample.uploadedByStaffId
          )
            blockers.push("SOURCE_QC_NOT_VALID");
          if (!template || template.versionNo !== value.quality.checklistVersionNo)
            blockers.push("CHECKLIST_VERSION_STALE");
          if (
            !items.length ||
            items.some((item) => {
              const result = value.quality.results.find((row) => row.key === item.key);
              if (!result) return true;
              const aigcState = productionFacts.production?.aigcState;
              const effective =
                item.key === "ai_label" &&
                (aigcState === "not_required" || aigcState === "verified")
                  ? aigcState === "not_required" && item.allowNa
                    ? "na"
                    : "pass"
                  : result.result;
              return effective === "fail" || (effective === "na" && !item.allowNa);
            }) ||
            value.quality.results.some((row) => !items.some((item) => item.key === row.key))
          )
            blockers.push("CHECKLIST_NOT_PASSED");
        }
        return {
          staff,
          configStaff,
          entityId: sample.entityId,
          flag,
          report: {
            mode: value.apply ? "apply" : "dry-run",
            canApply: blockers.length === 0,
            blockers,
            idempotentReplay: replay,
            sample: {
              sampleId: sample.id,
              storeId: sample.storeId,
              storeName: sample.store.name,
              deliveryTicketId: sample.deliveryTicketId,
              orderItemId: sample.deliveryTicket.orderItemId,
              versionNo: sample.versionNo,
              status: sample.status,
              previewChannels: sample.previewChannels,
              pushedAt: sample.pushedAt?.toISOString() ?? null,
              durationMs: sample.durationMs,
              fileId: sample.fileId,
              qcRecordId: sample.qcRecordId,
              decidedAt: sample.decidedAt?.toISOString() ?? null,
              viewedAckAt: sample.viewedAckAt?.toISOString() ?? null,
              proposedVersionNo: value.versionNo + 1,
            },
            quality: {
              activeChecklistVersionNo: template?.versionNo ?? null,
              submittedChecklistVersionNo: value.quality.checklistVersionNo,
              items,
              submittedResults: value.quality.results,
              productionReady: productionFacts.ready,
              watermarkReady: !!productionFacts.playable,
              aigcState: productionFacts.production?.aigcState ?? null,
            },
            flag: {
              key: FLAG,
              currentDefaultValue: flag.defaultValue,
              proposedDefaultValue: true,
              rulesPreserved: true,
              ruleCount: rules.length,
              effectiveForEntityAfterChange: enabledAfterDefaultChange,
              lockVersion: flag.lockVersion,
              willEnable: !replay && flag.defaultValue !== true,
            },
          },
        };
      });
      if (!value.apply || !inspected.report.canApply) return inspected.report;
      signal?.throwIfAborted();
      let flagCommitted = false;
      let flagWriteStarted = false;
      // A successful flag write is independently committed; recovery never claims to roll it back.
      try {
        if (!inspected.report.idempotentReplay && inspected.flag.defaultValue !== true) {
          flagWriteStarted = true;
          await runtime.configAdmin.updateFlag(
            {
              staff: inspected.configStaff,
              identity: createIdentityContext({
                actor: { type: "staff", id: value.configStaffId, client: "cli" },
              }),
              meta: {
                requestId: null,
                ip: null,
                userAgent: null,
                authMethod: null,
                sessionId: null,
                jobName: "cli.q9.sample.recover.flag",
                actorRole: inspected.configStaff.staff.roleKey,
              },
            },
            FLAG,
            { lockVersion: inspected.flag.lockVersion, defaultValue: true },
          );
          flagCommitted = true;
        }
        signal?.throwIfAborted();
        runtime.config.cache.invalidate("flag");
        if (
          !inspected.report.idempotentReplay &&
          !(await runtime.config.flags.isEnabled(FLAG, { entityId: inspected.entityId }))
        )
          throw new AppError("FEATURE_DISABLED");
        const result = await delivery.samplePush(
          createIdentityContext({
            actor: { type: "staff", id: value.staffId, client: "cli" },
            entityId: inspected.entityId,
            storeId: value.storeId,
          }),
          inspected.staff,
          value.sampleId,
          {
            legacyRecovery: {
              versionNo: value.versionNo,
              reason: value.reason,
              quality: value.quality,
            },
          },
          { idem },
        );
        return {
          mode: "applied",
          flagCommitted,
          sampleId: result.sampleId,
          versionNo: result.versionNo,
          status: result.status,
          replayed: result.replayed,
          merchantConfirmation: "pending",
        };
      } catch (error) {
        return {
          mode: "failed",
          flagCommitted,
          flagWriteOutcome: flagCommitted
            ? "committed"
            : flagWriteStarted
              ? "unknown"
              : "not_changed",
          error: isAppError(error)
            ? error.error
            : signal?.aborted
              ? "CANCELLED"
              : "RECOVERY_FAILED",
        };
      }
    },
  };
}
