import type { Tx } from "../kernel/index.js";
/** Bookkeeping row has no lock rank; caller has already locked the recipient scope. */
export async function lockSiteNoticeForNotify(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM site_notice WHERE id = ${id}::uuid FOR SHARE`;
  return rows.length === 1;
}
