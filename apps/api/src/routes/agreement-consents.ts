// W1-04b：三条已登录协议接口。重新同意的事务与指纹更新归 identity。
import {
  AgreementConsentReceiptSchema,
  AgreementConsentSummarySchema,
  SignedAgreementListSchema,
  mAgreementConsentCreate,
  mAgreementConsentList,
  mAgreementConsentSummary,
} from "@liyoxi/contract";
import type { SignedAgreementList } from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import { idemOf } from "../http/idempotency.js";
import { merchantSessionOf } from "../http/merchant-auth.js";
import { respondByRole } from "../http/respond-by-role.js";
import { CLIENT_VERSION_HEADER } from "../http/version-gate.js";
import { merchantServicesOf } from "../merchant/services.js";
import { defineHandler } from "../routing/define.js";

export const agreementConsentHandlers = [
  defineHandler(mAgreementConsentCreate, async (c) => {
    const result = await merchantServicesOf(c.var.runtime).identity.reconsent(
      merchantSessionOf(c),
      {
        requestId: c.get("requestId"),
        ip: c.get("clientIp"),
        userAgent: c.req.header("User-Agent") ?? null,
        clientVersion: c.req.header(CLIENT_VERSION_HEADER)?.slice(0, 32) ?? null,
      },
      c.req.valid("json"),
      { idem: idemOf(c) },
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(
      c,
      { owner: AgreementConsentReceiptSchema, clerk: AgreementConsentReceiptSchema },
      result,
    );
  }),
  defineHandler(mAgreementConsentList, async (c) => {
    const membership = c.get("membership");
    if (membership === undefined) throw new AppError("NOT_A_MEMBER");
    const result = await merchantServicesOf(c.var.runtime).docs.listSignedAgreements(
      {
        role: membership.role,
        entityId: membership.entityId,
        merchantUserId: merchantSessionOf(c).merchantUserId,
      },
      c.req.valid("query"),
    );
    c.header("Cache-Control", "no-store");
    return respondByRole<SignedAgreementList>(
      c,
      {
        owner: SignedAgreementListSchema.options[0],
        clerk: SignedAgreementListSchema.options[1],
      },
      result,
    );
  }),
  defineHandler(mAgreementConsentSummary, async (c) => {
    const membership = c.get("membership");
    if (membership === undefined) throw new AppError("NOT_A_MEMBER");
    const result = await merchantServicesOf(c.var.runtime).docs.countSignedAgreements(
      { entityId: membership.entityId, merchantUserId: merchantSessionOf(c).merchantUserId },
      c.req.valid("query"),
    );
    c.header("Cache-Control", "no-store");
    return respondByRole(c, { owner: AgreementConsentSummarySchema }, result);
  }),
];
