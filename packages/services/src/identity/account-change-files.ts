import { hasPermission } from "../authz/index.js";
import { AppError, fileRefTypePort, implementKeyed } from "../kernel/index.js";
import type { ExpectedFileRef } from "../kernel/index.js";
import { fileCategoryGuardPort } from "../media/index.js";
import type { ClockBoundFileRefType } from "../media/index.js";
const accountChangeProofRef: ClockBoundFileRefType = {
  async inUse() {
    throw new TypeError("账号变更证明在用事实须绑定 media 业务时钟");
  },
  roles: {
    proof: {
      categories: ["account_proof"],
      retentionDays: 0,
      async canRelease() {
        throw new TypeError("账号变更证明释放须绑定 media 业务时钟");
      },
    },
  },
  withClock(clock) {
    return {
      ...this,
      async inUse(tx, fileId) {
        const cutoff = new Date(clock.now().getTime()),
          month = cutoff.getUTCMonth();
        cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 3);
        if (cutoff.getUTCMonth() !== month) cutoff.setUTCDate(0);
        return (
          await tx.accountChangeRequest.findMany({
            where: {
              proofFileIds: { has: fileId },
              NOT: {
                OR: [
                  { merchantUser: { deletedAt: { lte: cutoff } } },
                  { entity: { closedAt: { lte: cutoff } } },
                ],
              },
            },
            select: { id: true },
          })
        ).map((row) => ({ fileId, refId: row.id, role: "proof" }));
      },
      roles: {
        proof: {
          ...this.roles.proof!,
          async canRelease(tx, id) {
            const request = await tx.accountChangeRequest.findUnique({
              where: { id },
              select: {
                merchantUser: { select: { deletedAt: true } },
                entity: { select: { closedAt: true } },
              },
            });
            const cutoff = new Date(clock.now().getTime()),
              month = cutoff.getUTCMonth();
            cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 3);
            if (cutoff.getUTCMonth() !== month) cutoff.setUTCDate(0);
            return [request?.merchantUser?.deletedAt, request?.entity?.closedAt].some(
              (endedAt) => endedAt != null && endedAt <= cutoff,
            );
          },
        },
      },
    };
  },
  async readColumns(tx) {
    const rows = await tx.accountChangeRequest.findMany({
      select: { id: true, proofFileIds: true },
    });
    return rows.flatMap((row): ExpectedFileRef[] =>
      row.proofFileIds.map((fileId) => ({ fileId, refId: row.id, role: "proof" })),
    );
  },
};
export const accountChangeFiles = [
  implementKeyed(fileCategoryGuardPort, "account_proof", {
    async assert(_tx, actor) {
      if (
        !actor.staff ||
        actor.identity.actor.type !== "staff" ||
        actor.identity.actor.client !== "admin" ||
        actor.identity.actor.id !== actor.staff.staff.id ||
        !hasPermission(actor.staff, "merchant.account_change.request")
      )
        throw new AppError("PERMISSION_DENIED");
    },
  }),
  implementKeyed(fileRefTypePort, "account_change_request", accountChangeProofRef),
];
