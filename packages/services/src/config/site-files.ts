import { fileRefTypePort, implementKeyed } from "../kernel/index.js";
export const homeBannerFiles = implementKeyed(fileRefTypePort, "home_banner", {
  inUse: async (tx, fileId) =>
    (
      await tx.homeBanner.findMany({
        where: { imageFileId: fileId },
        select: { id: true },
      })
    ).map((row) => ({ fileId, refId: row.id, role: "image" })),
  roles: { image: { categories: ["banner"], retentionDays: 180 } },
  readColumns: async (tx) =>
    (
      await tx.homeBanner.findMany({
        select: { id: true, imageFileId: true },
      })
    ).map((row) => ({ refId: row.id, fileId: row.imageFileId, role: "image" })),
});
