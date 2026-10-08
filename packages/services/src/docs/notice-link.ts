import { MessageDeepLinkSchema } from "@liyoxi/contract";
import type { MessageItem } from "@liyoxi/contract";
import type { Tx } from "../kernel/index.js";

/** Normalize the version's own notice; a cancellation links to the current agreement page. */
export async function readAgreementNoticeLink(
  tx: Tx,
  input: { siteNoticeId: string; agreementVersionId: string; noticeStatus: string },
): Promise<MessageItem["link"] | null> {
  const row = await tx.agreementVersion.findUnique({
    where: { id: input.agreementVersionId },
    select: { agreementKey: true, siteNoticeId: true, status: true },
  });
  if (!row || row.siteNoticeId !== input.siteNoticeId) return null;
  const valid = input.noticeStatus === "announced"
    ? ["pending", "active", "superseded"].includes(row.status)
    : input.noticeStatus === "withdrawn" && row.status === "withdrawn";
  if (!valid) return null;
  return MessageDeepLinkSchema.parse({
    route: "agreement.view", params: { key: row.agreementKey },
  });
}
