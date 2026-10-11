import type { Tx } from "../../kernel/index.js";

export interface MemberAssetCounts {
  readonly uploadCount: number;
  readonly adoptedCount: number;
}

export interface MemberAssetCountsInput {
  readonly entityId: string;
  readonly storeId: string;
  readonly merchantUserIds: readonly string[];
}

/** 本门店按商家账号批量读历史素材条数；调用方负责成员权限，不要求上传人仍是成员。 */
export async function readMemberAssetCounts(
  tx: Tx,
  input: MemberAssetCountsInput,
): Promise<ReadonlyMap<string, MemberAssetCounts>> {
  const ids = [...new Set(input.merchantUserIds)];
  if (ids.length === 0) return new Map();

  // 两值来自同一个SQL快照；LEFT JOIN保留实际无匹配素材的目标账号。
  // adoptedCount是至少被采用过一次的素材条数，不累计采用次数。
  const rows = await tx.$queryRaw<Array<MemberAssetCounts & { merchantUserId: string }>>`
    WITH requested AS (SELECT unnest(${ids}::uuid[]) AS id)
    SELECT requested.id::text AS "merchantUserId",
           count(asset.id)::int AS "uploadCount",
           (count(asset.id) FILTER (WHERE asset.adopted_count > 0))::int AS "adoptedCount"
    FROM requested
    LEFT JOIN store_asset AS asset
      ON asset.upload_actor_id = requested.id
     AND asset.upload_actor_type = 'merchant'
     AND asset.entity_id = ${input.entityId}::uuid
     AND asset.store_id = ${input.storeId}::uuid
     AND asset.deleted_at IS NULL
    GROUP BY requested.id
    ORDER BY requested.id
  `;
  return new Map(
    rows.map(({ merchantUserId, uploadCount, adoptedCount }) => [
      merchantUserId,
      { uploadCount, adoptedCount },
    ]),
  );
}
