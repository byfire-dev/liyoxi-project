// 登录第 5 步与重新同意共用：同意记录、完整性检查和账号指纹一起提交。
import type { AssertConsentsInput, AssertConsentsResult, Docs } from "../docs/index.js";
import { AppError } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";

export async function recordUserConsents(
  tx: Tx,
  docs: Docs,
  now: Date,
  ctx: IdentityContext,
  input: AssertConsentsInput,
  options: { requireComplete?: boolean; touchActive?: boolean } = {},
): Promise<AssertConsentsResult> {
  const result = await docs.assertConsents(tx, ctx, input);
  if (!result.complete && options.requireComplete) {
    throw new AppError("CONSENT_REQUIRED", {
      details: { pendingConsents: result.pendingConsents },
    });
  }
  if (result.complete) {
    await tx.merchantUser.update({
      where: { id: input.signer.merchantUserId },
      data: {
        consentStamp: result.stamp,
        ...(options.touchActive ? { lastActiveAt: now } : {}),
        updatedAt: now,
      },
    });
  }
  return result;
}
