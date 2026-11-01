import { implementKeyed, fileRefTypePort } from "../kernel/index.js";
import type { FileRefType } from "../kernel/index.js";
const reference: FileRefType = {
  roles: {
    reference: {
      categories: ["store_asset", "profile_image", "profile_video", "profile_promo"],
      retentionDays: 90,
      canRelease: async (tx, id) =>
        (await tx.ad.count({ where: { id, status: "cancelled", cancelledAt: { not: null } } })) ===
        1,
    },
  },
};
const version: FileRefType = {
  roles: { main: { categories: ["ad_video"], retentionDays: 90 } },
  inUse: async (tx, fileId) =>
    (
      await tx.adVersion.findMany({
        where: { fileId, ad: { status: { not: "cancelled" } } },
        select: { id: true },
      })
    ).map((v) => ({ fileId, refId: v.id, role: "main" })),
  readColumns: async (tx) =>
    (await tx.adVersion.findMany({ select: { id: true, fileId: true } })).map((v) => ({
      fileId: v.fileId,
      refId: v.id,
      role: "main",
    })),
};
const revision: FileRefType = {
  roles: { screenshot: { categories: ["ticket_attachment"], retentionDays: 180 } },
  inUse: async (tx, fileId) =>
    (
      await tx.adRevision.findMany({
        where: { screenshotFileIds: { has: fileId } },
        select: { id: true },
      })
    ).map((r) => ({ fileId, refId: r.id, role: "screenshot" })),
  readColumns: async (tx) =>
    (await tx.adRevision.findMany({ select: { id: true, screenshotFileIds: true } })).flatMap((r) =>
      r.screenshotFileIds.map((fileId) => ({ fileId, refId: r.id, role: "screenshot" })),
    ),
};
export const adFileRefs = [
  implementKeyed(fileRefTypePort, "ad", reference),
  implementKeyed(fileRefTypePort, "ad_version", version),
  implementKeyed(fileRefTypePort, "ad_revision", revision),
];
