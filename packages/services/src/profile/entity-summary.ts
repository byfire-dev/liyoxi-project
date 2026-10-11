import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";

export interface EntityStoreProfileSummary {
  readonly lastDecidedAt: string | null;
  readonly reviewDueAt: string | null;
  readonly openQualificationSubmissionId: string | null;
  readonly address: {
    readonly city: { code: string; name: string } | null;
    readonly district: { code: string; name: string } | null;
    readonly detail: string | null;
  };
  readonly copiedFromStoreId: string | null;
}

/** 仅档案摘要；不建档、不读取证照/文件/完整度，不替代调用方后台范围鉴权。 */
export async function readEntityStoreProfileFacts(
  tx: Tx,
  input: { readonly entityId: string; readonly storeIds: readonly string[] },
): Promise<ReadonlyMap<string, EntityStoreProfileSummary>> {
  const ids = [...new Set(input.storeIds)];
  if (!ids.length) return new Map();
  const where = { entityId: input.entityId, storeId: { in: ids } };
  const stores = await tx.store.findMany({
    where: { entityId: input.entityId, id: { in: ids } },
    select: { id: true },
  });
  if (stores.length !== ids.length) throw new AppError("NOT_FOUND");
  const [profiles, rounds] = await Promise.all([
    tx.storeProfile.findMany({
      where,
      select: {
        storeId: true,
        lastDecidedAt: true,
        cityCode: true,
        districtCode: true,
        addressDetail: true,
        copiedFromStoreId: true,
      },
    }),
    tx.qualificationSubmission.findMany({
      where: { ...where, closedAt: null, submittedAt: { not: null } },
      select: {
        id: true,
        storeId: true,
        approvalRequest: {
          select: {
            kind: true,
            subjectType: true,
            subjectId: true,
            entityId: true,
            storeId: true,
            dueAt: true,
          },
        },
      },
    }),
  ]);
  for (const round of rounds) {
    const a = round.approvalRequest;
    if (
      !a ||
      a.kind !== "qualification" ||
      a.subjectType !== "store" ||
      a.subjectId !== round.storeId ||
      a.storeId !== round.storeId ||
      a.entityId !== input.entityId
    )
      throw new AppError("INTERNAL");
  }
  const codes = [...new Set(profiles.flatMap((p) => [p.cityCode, p.districtCode]))].filter(
    (code): code is string => code !== null,
  );
  const names = new Map(
    (
      await tx.dictItem.findMany({
        where: { dictTypeKey: "region", code: { in: codes } },
        select: { code: true, name: true },
      })
    ).map((d) => [d.code, d.name]),
  );
  const dict = (code: string | null) =>
    code === null ? null : { code, name: names.get(code) ?? code };
  const profileByStore = new Map(profiles.map((p) => [p.storeId, p]));
  const roundByStore = new Map(rounds.map((r) => [r.storeId, r]));
  return new Map(
    ids.map((id) => {
      const p = profileByStore.get(id);
      const r = roundByStore.get(id);
      return [
        id,
        {
          lastDecidedAt: p?.lastDecidedAt?.toISOString() ?? null,
          reviewDueAt: r?.approvalRequest?.dueAt?.toISOString() ?? null,
          openQualificationSubmissionId: r?.id ?? null,
          address: {
            city: dict(p?.cityCode ?? null),
            district: dict(p?.districtCode ?? null),
            detail: p?.addressDetail ?? null,
          },
          copiedFromStoreId: p?.copiedFromStoreId ?? null,
        },
      ] as const;
    }),
  );
}
