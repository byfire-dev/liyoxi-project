import {
  implementKeyed as notifyReaderImplementation,
  notifyReadPort as currentNotifyReadPort,
} from "../kernel/index.js";
import { assetMerchantFacts } from "./assets/facts.js";
import { findAssetViolations } from "./assets/invariants.js";
import { implementMerchantFacts } from "../kernel/index.js";
import { assetForNotify, assetDemandForNotify } from "./notify-facts.js";
import { defineRegistration, implementKeyed, invariantNow } from "../kernel/index.js";
import type { Clock, ExpectedFileRef, Tx } from "../kernel/index.js";
import { fileCategoryGuardPort, fileRefTypePort } from "./ports.js";
import type { StoreBoundFileRefType } from "./ports.js";
import type { MediaAssetsDeps } from "./assets/types.js";
import { findI2Violations, findI14Violations } from "./invariants.js";
import { mediaDeliveryRefTypes } from "./production-stub.js";
import { findI13Violations } from "./retention/sweep-invariants.js";
const unboundMediaJobs = (): never => {
  throw new Error("媒体执行器未绑定实际运行时");
};
import { findI10Violations, findI11Violations } from "./jobs/invariants.js";
async function currentStoreAssetRefs(
  tx: Tx,
  fileId: string,
  readStore?: MediaAssetsDeps["readStore"],
  clock?: Clock,
): Promise<ExpectedFileRef[]> {
  const rows = await tx.storeAsset.findMany({
    where: {
      deletedAt: null,
      OR: [{ portraitAuthFileIds: { has: fileId } }, { storeAssetFiles: { some: { fileId } } }],
    },
    select: {
      id: true,
      storeId: true,
      entityId: true,
      portraitAuthFileIds: true,
      storeAssetFiles: { where: { fileId }, select: { fileId: true } },
    },
  });
  const facts = new Map<string, Awaited<ReturnType<MediaAssetsDeps["readStore"]>>>();
  const refs: ExpectedFileRef[] = [];
  const now = clock?.now();
  for (const row of rows) {
    let mainInUse = true,
      portraitInUse = true;
    if (readStore) {
      if (!facts.has(row.storeId)) facts.set(row.storeId, await readStore(tx, row.storeId));
      const store = facts.get(row.storeId);
      // 漏file_ref时也保留归档缓冲；只有真实拥有者确认日期且各角色期限已到才退出。
      // 未装配、缺事实/时钟或归档时间不完整时保守保留，不能猜测已经释放。
      if (
        now &&
        store?.id === row.storeId &&
        store.entityId === row.entityId &&
        store.lifecycle === "archived" &&
        store.archivedAt instanceof Date &&
        Number.isFinite(store.archivedAt.getTime())
      ) {
        mainInUse = store.archivedAt.getTime() + 180 * 86_400_000 > now.getTime();
        const portraitUntil = new Date(store.archivedAt.getTime()),
          month = portraitUntil.getUTCMonth();
        portraitUntil.setUTCFullYear(portraitUntil.getUTCFullYear() + 3);
        if (portraitUntil.getUTCMonth() !== month) portraitUntil.setUTCDate(0);
        portraitInUse = portraitUntil > now;
      }
    }
    if (mainInUse && row.storeAssetFiles.length) refs.push({ fileId, refId: row.id, role: "main" });
    if (portraitInUse && row.portraitAuthFileIds.includes(fileId))
      refs.push({ fileId, refId: row.id, role: "portrait_auth" });
  }
  return refs;
}
const storeAssetRef: StoreBoundFileRefType = {
  inUse: currentStoreAssetRefs,
  withStoreFacts(readStore, clock) {
    return { ...this, inUse: (tx, fileId) => currentStoreAssetRefs(tx, fileId, readStore, clock) };
  },
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
      ...row.storeAssetFiles.map((file) => ({ fileId: file.fileId, refId: row.id, role: "main" })),
      ...row.portraitAuthFileIds.map((fileId) => ({
        fileId,
        refId: row.id,
        role: "portrait_auth",
      })),
    ]);
  },
};
export const registration = defineRegistration("media", {
  ports: [fileRefTypePort, fileCategoryGuardPort],
  portImplementations: [
    notifyReaderImplementation(currentNotifyReadPort, "assetForNotify", assetForNotify),
    notifyReaderImplementation(currentNotifyReadPort, "assetDemandForNotify", assetDemandForNotify),
    implementMerchantFacts("asset", assetMerchantFacts),
    implementKeyed(fileRefTypePort, "store_asset", storeAssetRef),

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
  recurringJobs: [
    {
      kind: "media.sweep",
      schedule: { every: "minutes", minutes: 10 },
      mode: "job",
      leaseSec: 60,
      maxAttempts: 3,
      deadlineMin: 30,
      missSeverity: "P2",
      catchUp: true,
      run: async () => {
        throw new TypeError("media.sweep尚未绑定真实运行时");
      },
    },
  ],
  invariants: [
    {
      code: "media.I8",
      severity: "P2",
      modes: ["quick", "full"],
      every: "hour",
      heal: "heal_only",
      run: async () => {
        throw new TypeError("媒体清除补偿运行时尚未绑定");
      },
    },
    {
      code: "media.I13",
      severity: "P2",
      modes: ["full"],
      heal: "none",
      run: (tx, scope, ctx) => findI13Violations(tx, scope, invariantNow(ctx)),
    },
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
