import { AnalyticsEventBatchSchema, ClientAnalyticsEventSchema } from "@liyoxi/contract";
import type { AnalyticsEventBatch, AnalyticsIngestResult } from "@liyoxi/contract";
import { AppError, uuidv7 } from "../kernel/index.js";
import type { Alerts, Clock, IdempotencyContext, TxRunner } from "../kernel/index.js";
import type { Config, FlagContext } from "../config/index.js";
import type { Tenant, StoreMembership } from "../tenant/index.js";

export interface AnalyticsReceiverDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly config: Pick<Config, "params" | "flags">;
  readonly tenant: Pick<Tenant, "resolveMembership">;
  readonly alerts: Alerts;
}
export interface AnalyticsRequest {
  readonly merchantUserId: string | null;
  readonly storeId: string | null;
  readonly flagContext: Omit<FlagContext, "entityId">;
  readonly idem?: IdempotencyContext;
}
const DAY_MS = 86_400_000;
/** Asia/Shanghai 不实行夏令时；日限额按服务端接收日计，补报不能逃逸当日上限。 */
export function analyticsDayStart(now: Date): Date {
  return new Date(Math.floor((now.getTime() + 8 * 3_600_000) / DAY_MS) * DAY_MS - 8 * 3_600_000);
}
export function createAnalyticsReceiver(deps: AnalyticsReceiverDeps) {
  return {
    async receive(
      raw: AnalyticsEventBatch,
      request: AnalyticsRequest,
    ): Promise<AnalyticsIngestResult> {
      const parsed = AnalyticsEventBatchSchema.safeParse(raw);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED");
      const batch = parsed.data;
      const now = deps.clock.now();
      const headerMembership =
        request.merchantUserId && request.storeId
          ? await deps.tx.run((tx) =>
              deps.tenant.resolveMembership(tx, {
                merchantUserId: request.merchantUserId!,
                storeId: request.storeId!,
              }),
            )
          : null;
      await deps.config.flags.requireEnabled("analytics.ingest.enabled", {
        ...request.flagContext,
        entityId: headerMembership?.entityId ?? null,
      });
      const cap = await deps.config.params.get("analytics.anon.daily_cap");
      const result = await deps.tx.run(
        async (tx) => {
          const outcome = { accepted: 0, duplicated: 0, rejected: 0, dropped: 0 };
          let anonymousCount = 0;
          if (request.merchantUserId === null) {
            // 单个全站日闸。应用角色已有 DML 权限；不新增表/索引/DDL或绕过父表触发器。
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('analytics.anon.daily_cap'))`;
            anonymousCount = await tx.analyticsEvent.count({
              where: {
                source: "client",
                merchantUserId: null,
                receivedAt: {
                  gte: analyticsDayStart(now),
                  lt: new Date(analyticsDayStart(now).getTime() + DAY_MS),
                },
              },
            });
          } else {
            await tx.analyticsIdentity.createMany({
              data: [
                {
                  anonymousId: batch.anonymousId.toLowerCase(),
                  merchantUserId: request.merchantUserId,
                  linkedAt: now,
                },
              ],
              skipDuplicates: true,
            });
          }
          const memberships = new Map<string, StoreMembership | null>();
          for (const rawEvent of batch.events) {
            const checked = ClientAnalyticsEventSchema.safeParse(rawEvent);
            if (!checked.success) {
              outcome.rejected++;
              continue;
            }
            const event = checked.data;
            const corrected = new Date(
              Math.min(
                now.getTime(),
                Date.parse(event.occurredAt) + now.getTime() - Date.parse(batch.sentAt),
              ),
            );
            if (
              !Number.isFinite(corrected.getTime()) ||
              corrected.getTime() < now.getTime() - 7 * DAY_MS
            ) {
              outcome.rejected++;
              continue;
            }
            const eventId = event.eventId.toLowerCase();
            // 超限只丢新事件：重放仍能正确计 duplicated，丢弃的 eventId 不占去重键。
            if (request.merchantUserId === null && anonymousCount >= cap) {
              if (
                await tx.analyticsEventDedup.findUnique({
                  where: { eventId },
                  select: { eventId: true },
                })
              )
                outcome.duplicated++;
              else outcome.dropped++;
              continue;
            }
            const claimed = await tx.$queryRaw<
              { eventId: string }[]
            >`INSERT INTO analytics_event_dedup (event_id, received_at) VALUES (${eventId}, ${now}::timestamptz) ON CONFLICT DO NOTHING RETURNING event_id AS "eventId"`;
            if (claimed.length === 0) {
              outcome.duplicated++;
              continue;
            }
            const storeId = event.storeId ?? request.storeId;
            let membership: StoreMembership | null = null;
            if (request.merchantUserId && storeId) {
              if (!memberships.has(storeId))
                memberships.set(
                  storeId,
                  await deps.tenant.resolveMembership(tx, {
                    merchantUserId: request.merchantUserId,
                    storeId,
                  }),
                );
              membership = memberships.get(storeId) ?? null;
            }
            const profile = membership
              ? await tx.storeProfile.findUnique({
                  where: { storeId: membership.storeId },
                  select: { cityCode: true, categoryCode: true },
                })
              : null;
            await tx.analyticsEvent.create({
              data: {
                id: uuidv7(),
                eventId,
                name: event.name,
                occurredAt: corrected,
                receivedAt: now,
                source: "client",
                actorType: "merchant",
                actorId: request.merchantUserId,
                merchantUserId: request.merchantUserId,
                client: "weapp",
                anonymousId: batch.anonymousId.toLowerCase(),
                sessionId: batch.sessionId.toLowerCase(),
                role: membership?.role ?? null,
                entityId: membership?.entityId ?? null,
                storeId: membership?.storeId ?? null,
                cityCode: profile?.cityCode ?? null,
                categoryCode: profile?.categoryCode ?? null,
                clientPlatform: batch.platform,
                clientVersion: batch.clientVersion,
                scene: batch.scene ?? null,
                props: event.props,
              },
            });
            outcome.accepted++;
            if (request.merchantUserId === null) anonymousCount++;
          }
          return outcome;
        },
        request.idem === undefined ? {} : { idem: request.idem },
      );
      if (result.dropped > 0)
        await deps.alerts.raise({
          rule: "analytics.anon_daily_cap",
          severity: "P3",
          detail: { dropped: result.dropped },
        });
      return result;
    },
  };
}
export type AnalyticsReceiver = ReturnType<typeof createAnalyticsReceiver>;
