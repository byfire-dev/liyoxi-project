import type { Tx } from "../kernel/index.js";
/** 只读查其他已认证主体；在审信用代码相同不阻止送审。 */
export function findVerifiedEntityByUsccBidx(
  tx: Tx,
  bidx: Uint8Array<ArrayBuffer>,
  excludeEntityId?: string,
) {
  return tx.entity.findFirst({
    where: {
      verificationStatus: "verified",
      usccBidx: bidx,
      ...(excludeEntityId === undefined ? {} : { id: { not: excludeEntityId } }),
    },
    select: { id: true },
  });
}
