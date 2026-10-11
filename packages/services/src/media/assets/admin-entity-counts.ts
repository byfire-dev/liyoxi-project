import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";

export interface EntityStoreAssetCounts {
  readonly assetCount: number;
  readonly reviewedAssetCount: number;
  readonly copiedAssetCount: number;
}
export interface EntityMemberAssetCounts {
  readonly uploadedAssetCount: number;
  readonly adoptedAssetCount: number;
}
export interface EntityAssetCounts {
  readonly stores: ReadonlyMap<string, EntityStoreAssetCounts>;
  readonly members: ReadonlyMap<string, EntityMemberAssetCounts>;
}

/** 同一语句读取店级及主体全店成员计数；真实历史不因当前成员失效而丢失。 */
export async function readEntityAssetCounts(
  tx: Tx,
  input: {
    readonly entityId: string;
    readonly storeIds: readonly string[];
    readonly merchantUserIds: readonly string[];
  },
): Promise<EntityAssetCounts> {
  const storeIds = [...new Set(input.storeIds)];
  const users = [...new Set(input.merchantUserIds)];
  const stores = new Map<string, EntityStoreAssetCounts>();
  const members = new Map<string, EntityMemberAssetCounts>();
  if (!storeIds.length && !users.length) return { stores, members };
  const rows = await tx.$queryRaw<
    {
      kind: string;
      id: string;
      present: boolean;
      total: number;
      reviewed: number;
      copied: number;
    }[]
  >`
    WITH requested_stores AS (SELECT unnest(${storeIds}::uuid[]) AS id),
         requested_users AS (SELECT unnest(${users}::uuid[]) AS id)
    SELECT 'store' AS kind, r.id, s.id IS NOT NULL AS present,
           count(a.id)::int AS total,
           count(a.id) FILTER (WHERE a.review_state = 'reviewed')::int AS reviewed,
           count(a.id) FILTER (WHERE a.source_store_asset_id IS NOT NULL)::int AS copied
      FROM requested_stores r
      LEFT JOIN store s ON s.id = r.id AND s.entity_id = ${input.entityId}::uuid
      LEFT JOIN store_asset a ON a.store_id = s.id AND a.entity_id = ${input.entityId}::uuid
                            AND a.deleted_at IS NULL
     GROUP BY r.id, s.id
    UNION ALL
    SELECT 'member', r.id, true, count(a.id)::int,
           count(a.id) FILTER (WHERE a.adopted_count > 0)::int, 0
      FROM requested_users r
      LEFT JOIN store_asset a ON a.upload_actor_id = r.id
                            AND a.entity_id = ${input.entityId}::uuid
                            AND a.upload_actor_type = 'merchant' AND a.deleted_at IS NULL
     GROUP BY r.id`;
  for (const row of rows) {
    if (
      ![row.total, row.reviewed, row.copied].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      row.reviewed > row.total ||
      row.copied > row.total ||
      typeof row.present !== "boolean"
    )
      throw new AppError("INTERNAL");
    if (row.kind === "store") {
      if (!storeIds.includes(row.id) || stores.has(row.id)) throw new AppError("INTERNAL");
      if (!row.present) throw new AppError("NOT_FOUND");
      stores.set(row.id, {
        assetCount: row.total,
        reviewedAssetCount: row.reviewed,
        copiedAssetCount: row.copied,
      });
    } else if (row.kind === "member" && row.present) {
      if (!users.includes(row.id) || members.has(row.id)) throw new AppError("INTERNAL");
      members.set(row.id, { uploadedAssetCount: row.total, adoptedAssetCount: row.reviewed });
    } else throw new AppError("INTERNAL");
  }
  if (stores.size !== storeIds.length || members.size !== users.length)
    throw new AppError("INTERNAL");
  return { stores, members };
}
