// 登录后的重新同意：记录与账号指纹同一事务提交；不经 docs 的独立事务入口。
import type { AgreementConsentReceipt, ConsentInput, DeviceInfo } from "@liyoxi/contract";
import type { ConsentSigner, Docs } from "../docs/index.js";
import { createIdentityContext, lockRows } from "../kernel/index.js";
import type { Clock, IdempotencyContext, Tx, TxRunner } from "../kernel/index.js";
import type { RequestMeta, SessionPrincipal } from "./types.js";
import { recordUserConsents } from "./user-consents.js";

export interface ReconsentBody {
  readonly consents: readonly ConsentInput[];
  readonly device?: DeviceInfo | undefined;
}
interface ReconsentDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly docs: Docs;
  readonly signerOf: (tx: Tx, principal: SessionPrincipal) => Promise<ConsentSigner>;
}

export async function reconsent(
  deps: ReconsentDeps,
  principal: SessionPrincipal,
  meta: RequestMeta,
  input: ReconsentBody,
  options: { idem?: IdempotencyContext } = {},
): Promise<AgreementConsentReceipt> {
  return deps.tx.run(async (tx) => {
    await lockRows(tx, "merchant_user", [principal.merchantUserId], "update");
    const ctx = createIdentityContext({
      actor: { type: "merchant", id: principal.merchantUserId, client: "weapp" },
      requestId: meta.requestId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    const result = await recordUserConsents(tx, deps.docs, deps.clock.now(), ctx, {
      scene: "reconsent",
      method: "checkbox",
      consents: input.consents,
      signer: await deps.signerOf(tx, principal),
      device: {
        ...input.device,
        ...(meta.clientVersion === null ? {} : { appVersion: meta.clientVersion }),
      },
    });
    return { consents: result.consents, pendingConsents: result.pendingConsents };
  }, options);
}
