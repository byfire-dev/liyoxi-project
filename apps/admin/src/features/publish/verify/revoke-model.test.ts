import { expect, it } from "vitest";
import type { VerifyDetail } from "./api";
import { canRevoke, revokeBody } from "./revoke-model";
const detail = {
  isCurrentRound: true,
  approval: { status: "approved" },
  actions: ["revoke"],
  revoke: { canRevoke: true },
  verifiedEpisodeCount: 2,
  roundNo: 3,
} as VerifyDetail;
it("撤销只取真实轮次与已核验集数，不添加审批版本", () => {
  expect(revokeBody(detail, "  链接核验有误  ")).toEqual({
    reason: "链接核验有误",
    confirm: { roundNo: 3, verifiedEpisodeCount: 2 },
  });
  for (const reason of ["", " ", "x".repeat(201)]) expect(revokeBody(detail, reason)).toBeNull();
});
it("历史轮、无action、无撤销资格或非通过状态均不可撤销", () => {
  for (const patch of [
    { isCurrentRound: false },
    { actions: [] },
    { revoke: null },
    { verifiedEpisodeCount: null },
    { approval: { status: "pending" } },
  ])
    expect(canRevoke({ ...detail, ...patch } as VerifyDetail)).toBeFalsy();
});
