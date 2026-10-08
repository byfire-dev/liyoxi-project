import { MessageDeepLinkSchema } from "@liyoxi/contract";
import type { MessageItem } from "@liyoxi/contract";
import type { Tx } from "../kernel/index.js";

export type AgreementNoticeLinkReader = (
  tx: Tx,
  input: {
    siteNoticeId: string;
    agreementVersionId: string;
    noticeStatus: string;
  },
) => Promise<MessageItem["link"] | null>;

export async function normalizeSiteNoticeLink(
  tx: Tx,
  notice: {
    id: string;
    kind: string;
    refId: string;
    status: string;
    link: unknown;
  },
  agreementLink: AgreementNoticeLinkReader,
): Promise<MessageItem["link"] | null> {
  if (notice.kind === "agreement_version")
    return agreementLink(tx, {
      siteNoticeId: notice.id,
      agreementVersionId: notice.refId,
      noticeStatus: notice.status,
    });
  const link = MessageDeepLinkSchema.safeParse(notice.link);
  return link.success ? link.data : null;
}

const scopes: { read: AgreementNoticeLinkReader }[] = [];
/** The injected reader uses only the caller's tx and reference; no environment state is captured. */
export function bindAgreementNoticeLink(read: AgreementNoticeLinkReader) {
  const scope = { read };
  scopes.push(scope);
  return () => {
    const index = scopes.indexOf(scope);
    if (index >= 0) scopes.splice(index, 1);
  };
}

export async function siteNoticeForNotify(tx: Tx, id: string) {
  const row = await tx.siteNotice.findUnique({ where: { id } });
  if (!row) return null;
  const read = scopes.at(-1)?.read;
  const link =
    row.kind === "agreement_version" && !read
      ? null
      : await normalizeSiteNoticeLink(tx, row, read ?? (async () => null));
  return link
    ? {
        bizType: "site_notice",
        bizId: row.id,
        entityId: null,
        storeId: null,
        status: row.status,
        version: 0,
        name: row.title,
        summary: row.summary,
        summaryNoPrice: row.summaryNoPrice,
        link,
      }
    : null;
}
