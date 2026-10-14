import { z } from "zod";
import type { SqlRunner } from "./binding.js";
import type { ProbeRule } from "./probe-rules.js";
import { readBackupSummary } from "./backup.js";

const row = z.strictObject({ firedAt: z.date().nullable(), result: z.unknown() });
export const BACKUP_STALE_MS = 26 * 60 * 60 * 1000;

/** 只读取真实成功期次；缺失/损坏不作为正常备份，也不写入或修复timer。 */
export function backupProbeRules(db: SqlRunner): readonly ProbeRule[] {
  return [
    {
      key: "backup",
      targets: [{ rule: "backup.stale" }],
      async sample(at) {
        const rows = z
          .array(row)
          .max(1)
          .parse(
            await db.$queryRawUnsafe(
              `SELECT fired_at AS "firedAt", result FROM timer
         WHERE kind='backup.pgdump' AND subject_type IS NULL AND status='fired'
         ORDER BY fired_at DESC NULLS FIRST,id DESC LIMIT 1`,
            ),
          );
        const latest = rows[0];
        if (!latest)
          return [{ rule: "backup.stale", severity: "P1", detail: { reason: "missing" } }];
        if (!latest.firedAt || latest.firedAt > at || !readBackupSummary(latest.result))
          throw new TypeError("备份成功事实无法验证");
        const ageMs = at.getTime() - latest.firedAt.getTime();
        return ageMs > BACKUP_STALE_MS
          ? [
              {
                rule: "backup.stale",
                severity: "P1",
                detail: { ageSeconds: Math.floor(ageMs / 1000) },
              },
            ]
          : [];
      },
    },
  ];
}
