import type { Tx } from "../../kernel/index.js";

interface Candidate {
  id: string;
  category: string;
  bucket: string;
  sizeBytes: bigint | null;
}
/** 缓存限量补偿不能限制每日候选数；只派生media自有refs/24h事实，不读其他域。 */
export async function purgeCandidates(
  tx: Tx,
  now: Date,
  options: { take: 1 | 100 | 5000; candidateIds?: readonly string[]; includeDeleting?: boolean },
) {
  return tx.$queryRawUnsafe<Candidate[]>(
    `
    SELECT f.id, f.category, f.bucket, f.size_bytes AS "sizeBytes" FROM file_object f
    WHERE ($2::uuid[] IS NULL OR f.id=ANY($2::uuid[])) AND (
      ($3::boolean AND f.status='deleting') OR
      (f.status='stored' AND (
        f.purge_after <= $1::timestamptz OR (
          NOT EXISTS(SELECT 1 FROM file_ref r WHERE r.file_id=f.id AND (r.state='live' OR r.keep_until IS NULL))
          AND COALESCE((SELECT max(r.keep_until) FROM file_ref r WHERE r.file_id=f.id),
              CASE WHEN f.first_linked_at IS NULL THEN f.stored_at + interval '24 hours' ELSE NULL END) <= $1::timestamptz
        )
      ))
    ) ORDER BY f.id LIMIT $4::int`,
    now,
    options.candidateIds ? [...options.candidateIds] : null,
    options.includeDeleting ?? false,
    options.take,
  );
}
