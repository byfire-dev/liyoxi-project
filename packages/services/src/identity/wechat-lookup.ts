import type { Tx } from "../kernel/index.js";

export async function findWechatIdentityId(
  tx: Tx,
  input: { readonly appid: string; readonly openid: string },
): Promise<string | null> {
  const row = await tx.wechatIdentity.findUnique({
    where: { appid_openid: { appid: input.appid, openid: input.openid } },
    select: { id: true },
  });
  return row?.id ?? null;
}

export async function recentWechatOpenid(
  tx: Tx,
  input: {
    readonly merchantUserId: string;
    readonly appid: string;
    readonly now: Date;
  },
): Promise<{ readonly wechatIdentityId: string; readonly openid: string } | null> {
  const rows = await tx.$queryRawUnsafe<Array<{ wechatIdentityId: string; openid: string }>>(
    `SELECT wi.id::text AS "wechatIdentityId", wi.openid
       FROM wechat_identity wi
       JOIN merchant_user mu ON mu.id = wi.merchant_user_id
      WHERE wi.merchant_user_id = $1::uuid AND wi.appid = $2::text
        AND mu.status = 'active' AND wi.last_active_at >= $3::timestamptz
      ORDER BY wi.last_active_at DESC, wi.id ASC LIMIT 1`,
    input.merchantUserId,
    input.appid,
    new Date(input.now.getTime() - 2 * 60 * 60 * 1000),
  );
  return rows[0] ?? null;
}
