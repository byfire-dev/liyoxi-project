import { fileRefTypePort, implementKeyed } from "../kernel/index.js";
export const homeBannerFiles = implementKeyed(fileRefTypePort, "home_banner", {
  roles: { image: { categories: ["banner"], retentionDays: 180 } },
  readColumns: async (tx) =>
    (
      await tx.homeBanner.findMany({
        select: { id: true, imageFileId: true },
      })
    ).map((row) => ({ refId: row.id, fileId: row.imageFileId, role: "image" })),
});
