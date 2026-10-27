import { z } from "zod";
import { IdSchema, PlanQuoteBodySchema } from "@liyoxi/contract";
import { assertCapability, standingOf } from "../../authz/index.js";
import { assertCurrentSession } from "../../identity/index.js";
import type { Identity } from "../../identity/index.js";
import { AppError, createIdempotencyContext, createIdentityContext } from "../../kernel/index.js";
import type { Env } from "../../kernel/index.js";
import type { WechatProvider } from "../../providers/types.js";
import type { BillingPurchase } from "../payment/purchase.js";
import type { BillingPurchaseDeps } from "../payment/purchase-context.js";
import { createOrder } from "../payment/purchase-write.js";

const purchaseSchema = PlanQuoteBodySchema.extend({
  expectAmountFen: z.int().min(1).max(100),
  agreementVersionIds: z.array(IdSchema).min(1).max(2),
}).strict();
const inputSchema = z
  .object({
    sessionToken: z.string().min(1).max(1024),
    entityId: IdSchema,
    storeId: IdSchema,
    client: z
      .object({
        platform: z.enum(["ios", "android", "harmony", "windows", "mac"]),
        appVersion: z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/),
      })
      .strict(),
    purchase: purchaseSchema,
    idempotencyKey: z.string().min(1).max(128),
  })
  .strict();

interface Deps {
  env: Pick<Env, "APP_ENV" | "STAGING_PAY" | "WECHAT" | "WECHAT_PAY">;
  purchaseDeps: BillingPurchaseDeps;
  identity: () => Pick<Identity, "authenticate" | "pendingConsents" | "isClientOutdated">;
  purchase: Pick<BillingPurchase, "quotePlanPurchase" | "getOrder">;
  wechat: Pick<WechatProvider, "configured" | "createMiniProgramCode">;
  wechatPayConfigured: boolean;
}

/** 只生成体验版小程序入口；实际预支付/确认付款仍由手机上的原付款页执行。 */
export function createStagingPayEntry(deps: Deps) {
  const { tx, clock, tenant } = deps.purchaseDeps;
  return {
    async create(raw: unknown, signal?: AbortSignal) {
      const input = inputSchema.safeParse(raw);
      if (!input.success) throw new AppError("VALIDATION_FAILED");
      const { env } = deps;
      if (env.APP_ENV !== "stg" || !env.STAGING_PAY?.entityIds.includes(input.data.entityId))
        throw new AppError("PERMISSION_DENIED");
      if (
        !env.WECHAT ||
        !env.WECHAT_PAY ||
        env.WECHAT.appid !== env.WECHAT_PAY.appid ||
        !deps.wechat.configured ||
        !deps.wechatPayConfigured
      )
        throw new AppError("WECHAT_UNAVAILABLE");
      signal?.throwIfAborted();
      const { sessionToken, entityId, storeId, client, purchase, idempotencyKey } = input.data;
      const identity = deps.identity();
      if (
        await identity.isClientOutdated(client.appVersion, {
          platform: client.platform,
          clientVersion: client.appVersion,
          envVersion: "trial",
        })
      )
        throw new AppError("CLIENT_OUTDATED");
      const check = await identity.authenticate(sessionToken, { ip: null });
      if (!check.ok) throw new AppError("SESSION_INVALID");
      const session = check.principal;
      await tx.run((tx) => assertCurrentSession(tx, session, clock.now(), env.WECHAT!.appid));
      const membership = await tx.run((tx) =>
        tenant.resolveMembership(tx, {
          merchantUserId: session.merchantUserId,
          storeId,
        }),
      );
      if (!membership || membership.entityId !== entityId) throw new AppError("NOT_A_MEMBER");
      assertCapability(standingOf(membership.role, membership.storeMode), "plan.purchase");
      if (membership.role !== "owner") throw new AppError("ROLE_FORBIDDEN");
      const pendingConsents = await identity.pendingConsents(session);
      if (pendingConsents.length)
        throw new AppError("CONSENT_REQUIRED", { details: { pendingConsents } });
      const actor = {
        ctx: createIdentityContext({
          actor: { type: "merchant", id: session.merchantUserId, client: "weapp", role: "owner" },
          entityId,
          storeId,
          requestId: null,
          ip: null,
          userAgent: null,
        }),
        membership,
      };
      const { expectAmountFen, agreementVersionIds, ...plan } = purchase;
      const quote = await deps.purchase.quotePlanPurchase(actor, client, plan);
      // 现窗口退款只接受开通/同档续费；不能生成一个自动退款必拒的升级探针。
      if (
        !(["subscribe", "renew"] as readonly string[]).includes(quote.action) ||
        !(["plan_new", "plan_renew"] as readonly string[]).includes(quote.orderType)
      )
        throw new AppError("PRECONDITION_CHANGED");
      if (!Number.isInteger(quote.payFen) || quote.payFen < 1 || quote.payFen > 100)
        throw new AppError("PRECONDITION_CHANGED");
      if (quote.payFen !== expectAmountFen) throw new AppError("QUOTE_CHANGED");
      const body = {
        ...plan,
        expectAmountFen,
        agreementVersionIds,
        channel: "wechat_jsapi" as const,
      };
      const idem = createIdempotencyContext({
        mode: "required",
        scope: "m.paymentOrder.create",
        actor: actor.ctx.actor,
        key: idempotencyKey,
        request: { method: "POST", pathParams: {}, body, storeId },
      });
      signal?.throwIfAborted();
      // 同一正式公口会在锁内再次报价/校验金额和协议；不提供特殊价格或伪付款事实。
      const order = await tx.run(
        async (handle) => {
          signal?.throwIfAborted();
          const created = await createOrder(handle, deps.purchaseDeps, actor, client, body, true);
          signal?.throwIfAborted();
          return created;
        },
        { idem },
      );
      const current = await deps.purchase.getOrder(actor, client, order.paymentOrderId);
      if (
        !/^TFK\d+$/.test(current.orderNo) ||
        current.channel !== "wechat_jsapi" ||
        current.status !== "pending_payment" ||
        current.amountFen !== expectAmountFen ||
        !current.actions.includes("wechat-prepay")
      )
        throw new AppError("PRECONDITION_CHANGED");
      const scene = current.paymentOrderId.replaceAll("-", "");
      if (!/^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(scene))
        throw new AppError("INTERNAL");
      signal?.throwIfAborted();
      const code = await deps.wechat.createMiniProgramCode({
        scene,
        page: "sub/order/result/index",
      });
      if (!code.ok) throw new AppError("WECHAT_UNAVAILABLE");
      return {
        paymentOrderId: current.paymentOrderId,
        orderNo: current.orderNo,
        amountFen: current.amountFen,
        expiresAt: current.expiresAt,
        replayed: idem.replayed,
        image: code.value.image,
        contentType: code.value.contentType,
      };
    },
  };
}
