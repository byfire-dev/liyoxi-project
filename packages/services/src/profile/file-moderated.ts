import { FILE_OBJECT_CATEGORY } from "@liyoxi/contract/enums";
import { z } from "@liyoxi/contract";
import { lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { refreshCompleteness } from "./repo.js";
const input = z.strictObject({
  v: z.literal(1),
  fileId: z.uuid(),
  category: z.enum(FILE_OBJECT_CATEGORY.values),
  moderationState: z.enum(["pass", "review", "block"]),
  storeId: z.uuid().nullable(),
});
/** Read current facts: an older pass event must not undo a later block. */
export async function onFileModerated(tx: Tx, event: { payload: unknown }) {
  const { fileId } = input.parse(event.payload);
  const file = await tx.fileObject.findUnique({
    where: { id: fileId },
    select: { updatedAt: true },
  });
  if (!file) return;
  const [profiles, media, services] = await Promise.all([
    tx.storeProfile.findMany({ where: { logoFileId: fileId }, select: { storeId: true } }),
    tx.storeProfileMedia.findMany({
      where: { fileId, removedAt: null },
      select: { storeId: true },
    }),
    tx.storeServiceItem.findMany({
      where: { imageFileId: fileId, removedAt: null },
      select: { storeId: true },
    }),
  ]);
  const ids = [...new Set([...profiles, ...media, ...services].map((row) => row.storeId))].sort();
  await lockRows(tx, "store_profile", ids);
  for (const storeId of ids) {
    if (await tx.storeProfile.findUnique({ where: { storeId }, select: { storeId: true } }))
      await refreshCompleteness(tx, storeId, file.updatedAt);
  }
}
