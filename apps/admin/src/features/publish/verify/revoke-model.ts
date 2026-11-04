import type { RevokeBody, VerifyDetail } from "./api";
export function canRevoke(detail: VerifyDetail) {
  return (
    detail.isCurrentRound &&
    detail.approval.status === "approved" &&
    detail.actions.includes("revoke") &&
    detail.revoke?.canRevoke === true &&
    (detail.verifiedEpisodeCount ?? 0) > 0
  );
}
export function revokeBody(detail: VerifyDetail, reason: string): RevokeBody | null {
  const text = reason.trim();
  return canRevoke(detail) && text.length > 0 && text.length <= 200
    ? {
        reason: text,
        confirm: { roundNo: detail.roundNo, verifiedEpisodeCount: detail.verifiedEpisodeCount! },
      }
    : null;
}
