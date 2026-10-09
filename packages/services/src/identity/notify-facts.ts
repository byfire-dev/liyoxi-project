import type { Tx } from "../kernel/index.js";
import { assertLockOrder } from "../kernel/index.js";
import { openField } from "../security/index.js";
import type { Keyring } from "../security/index.js";
export async function merchantAccountForNotify(tx: Tx, id: string) {
  const row = await tx.merchantUser.findUnique({ where: { id } });
  return row?.status === "active"
    ? {
        bizType: "merchant_user",
        bizId: row.id,
        entityId: null,
        storeId: null,
        status: row.status,
        version: 0,
        name: "账号安全",
        merchantUserIds: [row.id],
      }
    : null;
}
/** Light lock serializes this recipient's collapse budget and blocks a concurrent disable. */
export async function merchantTargetForNotify(
  tx: Tx,
  id: string,
  keys: () => Keyring | null,
  locked = false,
) {
  if (locked) {
    assertLockOrder(tx, "merchant_user", [id]);
    await tx.$queryRaw`SELECT id FROM merchant_user WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
  }
  const row = await tx.merchantUser.findUnique({ where: { id } });
  if (!row || row.status !== "active") return null;
  const keyring = row.phoneEnc ? keys() : null;
  return {
    active: true,
    ...(keyring && row.phoneEnc && row.phoneBidx
      ? {
          phone: openField(keyring, "merchant_user.phone_enc", row.phoneEnc),
          phoneRef: Buffer.from(row.phoneBidx).toString("hex"),
          phoneMask: row.phoneMask ?? "",
        }
      : {}),
  };
}
export async function wechatTargetForNotify(
  tx: Tx,
  id: string,
  userId: string,
  appid: string | undefined,
) {
  if (!appid) return null;
  const row = await tx.wechatIdentity.findFirst({
    where: { id, merchantUserId: userId, appid, merchantUser: { status: "active" } },
    select: { openid: true },
  });
  return row?.openid ?? null;
}
