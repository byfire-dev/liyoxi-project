import type { QualificationDocCreateBody } from "@liyoxi/contract";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { qualificationFileVersion, qualificationOcrFile } from "../media/index.js";
import { draftPreconditions } from "./draft.js";
import type { ProfileDeps, ProfileViewer } from "./context.js";
import { assertOwner } from "./validate.js";

export interface RecognitionIntent {
  readonly roundId: string | null;
  readonly roundVersion: number | null;
  readonly fileVersion: string;
}
export const recognitionInput = (viewer: ProfileViewer, input: QualificationDocCreateBody) => ({
  ...input,
  entityId: viewer.membership.entityId,
  storeId: viewer.membership.storeId,
  merchantUserId: viewer.principal.merchantUserId,
});
/** claim只读：留下真实轮次/文件版本，并复核当前老板身份。 */
export async function recognitionIntent(
  tx: Tx,
  deps: ProfileDeps,
  viewer: ProfileViewer,
  input: QualificationDocCreateBody,
): Promise<RecognitionIntent> {
  const membership = await deps.tenant.resolveMembership(tx, {
    merchantUserId: viewer.principal.merchantUserId,
    storeId: viewer.membership.storeId,
  });
  if (
    !membership ||
    membership.memberId !== viewer.membership.memberId ||
    membership.entityId !== viewer.membership.entityId
  )
    throw new AppError("NOT_A_MEMBER");
  assertOwner({ ...viewer, membership });
  const { open } = await draftPreconditions(tx, viewer.membership.storeId);
  return {
    roundId: open?.id ?? null,
    roundVersion: open?.lockVersion ?? null,
    fileVersion: qualificationFileVersion(
      await qualificationOcrFile(tx, recognitionInput(viewer, input)),
    ),
  };
}
/** 必须在原ensureDraft及file锁之后调用；迟到识别不覆盖新轮、已改草稿或不同文件版本。 */
export async function assertRecognitionIntent(
  tx: Tx,
  viewer: ProfileViewer,
  input: QualificationDocCreateBody,
  intent: RecognitionIntent,
  round: { id: string; lockVersion: number },
  created: boolean,
) {
  if (
    intent.roundId === null
      ? !created
      : intent.roundId !== round.id || intent.roundVersion !== round.lockVersion
  )
    throw new AppError("PRECONDITION_CHANGED");
  if (
    qualificationFileVersion(await qualificationOcrFile(tx, recognitionInput(viewer, input))) !==
    intent.fileVersion
  )
    throw new AppError("PRECONDITION_CHANGED");
}

export function entityTypeCheck(recognized: Record<string, string> | null, claimed: string | null) {
  const type = recognized?.subjectType ?? null;
  return recognized
    ? {
        recognizedSubjectType: type,
        claimedEntityType: claimed,
        isMismatch: !!claimed && !!type && type !== "unknown" && type !== claimed,
      }
    : null;
}
