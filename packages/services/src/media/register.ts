import {
  implementKeyed as notifyReaderImplementation,
  notifyReadPort as currentNotifyReadPort,
} from "../kernel/index.js";
import { assetMerchantFacts } from "./assets/facts.js";
import { findAssetViolations } from "./assets/invariants.js";
import { implementMerchantFacts } from "../kernel/index.js";
import { assetForNotify, assetDemandForNotify } from "./notify-facts.js";
import { defineRegistration, implementKeyed, invariantNow } from "../kernel/index.js";
import { fileCategoryGuardPort, fileRefTypePort } from "./ports.js";
import { findI2Violations, findI14Violations } from "./invariants.js";
import { mediaDeliveryRefTypes } from "./production-stub.js";
const unboundMediaJobs = (): never => {
  throw new Error("媒体执行器未绑定实际运行时");
};
import { findI10Violations, findI11Violations } from "./jobs/invariants.js";
export const registration = defineRegistration("media", {
  ports: [fileRefTypePort, fileCategoryGuardPort],
  portImplementations: [
    notifyReaderImplementation(currentNotifyReadPort, "assetForNotify", assetForNotify),
    notifyReaderImplementation(currentNotifyReadPort, "assetDemandForNotify", assetDemandForNotify),
    implementMerchantFacts("asset", assetMerchantFacts),
    implementKeyed(fileRefTypePort, "store_asset", {
      inUse: async (tx, fileId) =>
        (
          await tx.storeAsset.findMany({
            where: {
              deletedAt: null,
              OR: [
                { portraitAuthFileIds: { has: fileId } },
                { storeAssetFiles: { some: { fileId } } },
              ],
            },
            select: {
              id: true,
              portraitAuthFileIds: true,
              storeAssetFiles: { where: { fileId }, select: { fileId: true } },
            },
          })
        ).flatMap((row) => [
          ...(row.storeAssetFiles.length ? [{ fileId, refId: row.id, role: "main" }] : []),
          ...(row.portraitAuthFileIds.includes(fileId)
            ? [{ fileId, refId: row.id, role: "portrait_auth" }]
            : []),
        ]),
      roles: {
        main: { categories: ["store_asset"], retentionDays: 7 },
        portrait_auth: { categories: ["portrait_auth"], retentionDays: 7 },
      },
      readColumns: async (tx) => {
        const rows = await tx.storeAsset.findMany({
          where: { deletedAt: null },
          select: {
            id: true,
            portraitAuthFileIds: true,
            storeAssetFiles: { select: { fileId: true } },
          },
        });
        return rows.flatMap((row) => [
          ...row.storeAssetFiles.map((file) => ({
            fileId: file.fileId,
            refId: row.id,
            role: "main",
          })),
          ...row.portraitAuthFileIds.map((fileId) => ({
            fileId,
            refId: row.id,
            role: "portrait_auth",
          })),
        ]);
      },
    }),

    implementKeyed(fileRefTypePort, "playable_asset", mediaDeliveryRefTypes.playable_asset),
    implementKeyed(fileRefTypePort, "upload_batch", mediaDeliveryRefTypes.upload_batch),
    implementKeyed(fileRefTypePort, "media_info", {
      inUse: async (tx, fileId) =>
        (
          await tx.mediaInfo.findMany({
            where: { coverFileId: fileId, file: { status: "stored" } },
            select: { fileId: true },
          })
        ).map((row) => ({ fileId, refId: row.fileId, role: "cover" })),
      roles: { cover: { categories: ["video_cover"], retentionDays: 30 } },
      readColumns: async (tx) =>
        (await tx.mediaInfo.findMany({ where: { coverFileId: { not: null } } })).map((info) => ({
          fileId: info.coverFileId!,
          refId: info.fileId,
          role: "cover",
        })),
    }),
    implementKeyed(fileRefTypePort, "production_record", {
      inUse: async (tx, fileId) =>
        (
          await tx.productionRecord.findMany({
            where: { derivedFromFileId: fileId, file: { status: "stored" } },
            select: { fileId: true },
          })
        ).map((row) => ({ fileId, refId: row.fileId, role: "source" })),
      roles: {
        source: { categories: ["sample_video", "final_episode", "ad_video"], retentionDays: 30 },
      },
      readColumns: async (tx) =>
        (await tx.productionRecord.findMany({ where: { derivedFromFileId: { not: null } } })).map(
          (record) => ({ fileId: record.derivedFromFileId!, refId: record.fileId, role: "source" }),
        ),
    }),
  ],
  subscribers: [
    {
      name: "media.onCalendarImported",
      events: ["calendar.imported"],
      handle: async () => {
        throw new TypeError("素材日历运行时尚未装配");
      },
    },
  ],
  invariants: [
    ...(["I12", "I16", "I17"] as const).map((code) => ({
      code: `media.${code}`,
      severity: "P2" as const,
      modes: ["full"] as const,
      heal: "none" as const,
      run: (
        tx: Parameters<typeof findAssetViolations>[0],
        scope: Parameters<typeof findAssetViolations>[1],
      ) => findAssetViolations(tx, scope, code),
    })),
    {
      code: "media.I10",
      severity: "P2",
      modes: ["quick", "full"],
      heal: "heal_only",
      run: (tx, scope, ctx) => findI10Violations(tx, scope, invariantNow(ctx), unboundMediaJobs),
    },
    {
      code: "media.I11",
      severity: "P2",
      modes: ["quick", "full"],
      heal: "heal_only",
      run: (tx, scope, ctx) => findI11Violations(tx, scope, invariantNow(ctx), unboundMediaJobs),
    },
    {
      code: "media.I2",
      severity: "P2",
      modes: ["full"],
      heal: "none",
      run: (tx) => findI2Violations(tx),
    },
    {
      code: "media.I14",
      severity: "P2",
      modes: ["full"],
      every: "week",
      heal: "none",
      run: (tx) => findI14Violations(tx),
    },
  ],
});
