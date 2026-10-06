// m08 第 2.2 节：各块总出现；匿名的个性化块为 null。
import {
  InstantSchema,
  IdSchema,
  PendingConsentSchema,
  openEnum,
  orNull,
} from "../../common/index.js";
import { SUBSCRIBE_POINT_KEYS } from "../../notify/index.js";
import { z } from "../../zod.js";

export const BOOTSTRAP_BLOCKS = [
  "flags",
  "versions",
  "consents",
  "subscribe",
  "copy",
  "notice",
  "context",
] as const;
export const MaintenanceNoticeSchema = z
  .object({
    title: z.string(),
    body: z.string(),
    expectedEndAt: orNull(InstantSchema),
  })
  .openapi("MaintenanceNotice");
export const BootstrapSchema = z
  .object({
    serverTime: InstantSchema,
    minClientVersion: z.string(),
    flags: z.record(z.string(), z.unknown()),
    versions: z.object({
      dict: z.record(z.string(), z.int().nonnegative()),
      site: z.record(z.string(), z.int().nonnegative()),
      agreement: z.string(),
    }),
    uploadLimits: z.object({ weappVideoMaxMb: z.int().positive(), imageMaxMb: z.int().positive() }),
    download: z.object({ weappSaveMode: openEnum(["temp", "user_dir"]) }),
    copy: z.record(z.string(), z.string()),
    support: z.object({
      mode: openEnum(["wecom_kf", "contact"]),
      corpId: orNull(z.string()),
      kfUrl: orNull(z.string()),
    }),
    notice: orNull(MaintenanceNoticeSchema),
    degraded: z.array(openEnum(BOOTSTRAP_BLOCKS)),
    pendingConsents: orNull(z.array(PendingConsentSchema)),
    subscribePlan: orNull(
      z.array(
        z.object({
          point: openEnum(SUBSCRIBE_POINT_KEYS as readonly [string, ...string[]]),
          slots: z.array(z.object({ slotKey: z.string(), tmplId: z.string() })),
        }),
      ),
    ),
    subscribeCooldownDays: z.int().nonnegative(),
    subscribeMaxPerAsk: z.int().positive(),
    context: orNull(z.object({ storeId: orNull(IdSchema) })),
  })
  .openapi("Bootstrap");
export type Bootstrap = z.infer<typeof BootstrapSchema>;
