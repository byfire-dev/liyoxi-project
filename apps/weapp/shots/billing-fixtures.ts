import type { Body, Data } from "../src/lib/account-api";
import type { RequestLayer } from "../src/lib/request";
import { createUploadApi } from "../src/lib/upload/api";
import type { UploadDeps } from "../src/lib/upload/queue";

export const BILLING_ID = "00000000-0000-4000-8000-000000000001";
export const BILLING_NOW = "2026-10-06T00:00:00.000Z";
export const billingPolicy: Data<"m.purchasePolicy.get"> = {
  mode: "in_app",
  isPriceShown: true,
  isPurchasePromptAllowed: true,
  channels: [
    { code: "bank_transfer", isEnabled: true, isRecommended: true, hintKey: null },
    { code: "wechat_jsapi", isEnabled: false, isRecommended: false, hintKey: null },
  ],
  copy: {
    planNounKey: "plan",
    pointsNounKey: "points",
    payButtonKey: "pay",
    agreementKeys: ["member", "points"],
  },
};
export const billingPlans: Data<"m.plan.list"> = {
  items: [
    {
      planId: BILLING_ID,
      planRevisionId: BILLING_ID,
      code: "PRO",
      name: "专业版",
      rank: 2,
      isCurrent: false,
      monthlyFeeFen: 600000,
      cyclePrices: [
        { months: 1, priceFen: 600000 },
        { months: 6, priceFen: 3600000 },
      ],
      monthlyPoints: 6600,
      discountBp: 9000,
      productionModel: "advanced",
      schedulePriority: "priority",
      maxStores: 3,
      maxMembers: 10,
      hasMonthlyReport: true,
    },
  ],
};
export function billingWallet(scene: string): Data<"m.wallet.get"> {
  const status =
    scene === "wallet-expired" ? "expired" : scene === "wallet-none" ? "none" : "active";
  const active = status === "active",
    never = status === "none";
  return {
    subscription: {
      status,
      isRefundPending: false,
      plan: never ? null : { planId: BILLING_ID, code: "PRO", name: "专业版" },
      months: never ? null : 1,
      startDate: never ? null : "2026-09-13",
      endDate: never ? null : active ? "2026-10-12" : "2026-10-05",
      endsAt: never ? null : active ? "2026-10-12T16:00:00.000Z" : "2026-10-05T16:00:00.000Z",
      remainingDays: active ? 6 : never ? null : 0,
      benefits: never ? null : billingPlans.items[0]!,
      scheduledTerms: [],
    },
    usage: {
      storesUsed: 2,
      storeLimit: active ? 3 : 1,
      seatsUsed: 3,
      memberLimit: active ? 10 : null,
      limitReason: active ? "plan" : "inactive",
    },
    points: {
      spendablePoints: active ? 2920 : 0,
      planAvailablePoints: active ? 1920 : 0,
      addonAvailablePoints: never ? 0 : 1000,
      heldPoints: active ? 180 : 0,
      isAddonSuspended: !active,
      planGrantedThisTermPoints: active ? 6600 : 0,
      planPointsExpireAt: active ? "2026-10-12T16:00:00.000Z" : null,
      lastExpired:
        status === "expired"
          ? { expiredPoints: 1920, expiredAt: "2026-10-05T16:00:00.000Z" }
          : null,
    },
    topUp: { canTopUp: false, blockReason: active ? "not_offered" : "no_active_plan" },
    rules: {
      adUnitPoints: 50,
      discountedAdUnitPoints: active ? 45 : null,
      adFreeRevisions: 2,
      topModelSurchargeBp: 2000,
    },
  };
}
export const billingQuote: Data<"m.plan.quote"> = {
  action: "subscribe",
  orderType: "plan_new",
  planId: BILLING_ID,
  planRevisionId: BILLING_ID,
  planName: "专业版",
  fromPlanName: null,
  months: 1,
  payFen: 600000,
  formula: {
    code: "plan_monthly",
    args: { monthlyFeeFen: 600000, months: 1 },
    text: "专业版 · 1 个月 · 应付 ¥6,000",
  },
  effectiveMode: "immediate",
  newTerm: { startDate: "2026-10-06", endDate: "2026-11-05" },
  firstGrantDate: "2026-10-06",
  benefits: billingPlans.items[0]!,
  upgrade: null,
  downgradeImpact: null,
  promo: null,
  validUntil: null,
  quotedAt: BILLING_NOW,
  policy: billingPolicy,
};
export const billingAgreements: Data<"m.agreement.list"> = {
  items: ["member", "points"].map((agreementKey, index) => ({
    agreementKey,
    name: index ? "积分使用规则" : "套餐服务协议",
    subjectKind: "entity",
    consentMode: "by_action",
    scenes: ["plan_purchase"],
    currentVersion: {
      agreementVersionId: index ? "00000000-0000-4000-8000-000000000002" : BILLING_ID,
      versionLabel: "v1.0",
      effectiveAt: BILLING_NOW,
      summary: "请阅读后确认购买",
      isReconsentRequired: false,
    },
    upcomingVersion: null,
  })),
  nextCursor: null,
  hasMore: false,
};
/** 本地内嵌回单样张，不触发离线场景外发请求。 */
export const billingReceipt = {
  path:
    "data:image/svg+xml," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="white"/><text x="25" y="45" font-size="22">银行电子回单</text><text x="25" y="85">收款：狸有戏科技有限公司</text><text x="25" y="120">金额：人民币 6,000.00 元</text><text x="25" y="150">用途：LYX2026100600001</text></svg>',
    ),
  name: "receipt.png",
  size: 1200,
};
const receiptPost = {
  url: "https://fake-storage.invalid/billing-receipt",
  fields: { key: "billing/receipt.png" },
};
export const billingUploadEvidence: string[] = [];
/** 只替代本域 H5 的原生字节读取与对象直传；完整流程仍由统一 createUpload 执行。 */
export function billingReceiptDeps(
  call: RequestLayer["request"],
  key: UploadDeps["key"],
  context: UploadDeps["context"],
): UploadDeps {
  return {
    api: createUploadApi(call),
    key,
    context,
    head: async (path, length) => {
      if (path !== billingReceipt.path) throw new Error("回单场景不能读取其他文件");
      billingUploadEvidence.push("head");
      return new TextEncoder().encode(decodeURIComponent(path.split(",")[1]!)).slice(0, length);
    },
    post: (ticket, file, progress) => {
      if (
        file.path !== billingReceipt.path ||
        file.name !== billingReceipt.name ||
        ticket.fileId !== BILLING_ID ||
        ticket.post?.url !== receiptPost.url ||
        JSON.stringify(ticket.post.fields) !== JSON.stringify(receiptPost.fields)
      )
        throw new Error("回单场景不能直传其他文件或目标");
      billingUploadEvidence.push("post");
      progress(100);
      return { done: Promise.resolve(), abort() {} };
    },
    now: () => Date.parse(BILLING_NOW),
    sleep: async () => undefined,
  };
}
export function billingPayment(scene: string): Data<"m.paymentOrder.get"> {
  const active = scene === "payment-active",
    processing = scene === "payment-processing",
    cancelled = scene === "payment-cancelled",
    rejected = scene === "payment-rejected",
    waiting = scene === "payment-waiting";
  return {
    paymentOrderId: BILLING_ID,
    orderNo: "LYX2026100600001",
    type: "plan_new",
    status: cancelled
      ? "cancelled"
      : active || processing
        ? "paid"
        : waiting
          ? "pending_confirmation"
          : "pending_payment",
    channel: "bank_transfer",
    transferState: rejected ? "proof_rejected" : waiting ? "proof_submitted" : "awaiting_proof",
    amountFen: 600000,
    title: "专业版 · 1 个月",
    createdAt: BILLING_NOW,
    paidAt: active || processing ? BILLING_NOW : null,
    invoiceItemName: null,
    invoiceState: "not_eligible",
    activeInvoiceRequest: null,
    actions: !active && !processing && !cancelled && !waiting ? ["submit-proof"] : [],
    paidAmountFen: active || processing ? 600000 : 0,
    refundedAmountFen: 0,
    fulfillmentStatus: active ? "done" : processing ? "blocked" : "none",
    formula: billingQuote.formula,
    content: {
      kind: "plan",
      planId: BILLING_ID,
      planName: "专业版",
      months: 1,
      pointPackId: null,
      points: 6600,
      upgrade: null,
    },
    expiresAt: "2026-10-07T00:00:00.000Z",
    isConfirmingResult: false,
    isProcessingReceipt: processing,
    cancelledAt: cancelled ? BILLING_NOW : null,
    cancelReason: cancelled ? "付款单已到期取消" : null,
    refundedAt: null,
    fulfillment: active
      ? {
          effectiveAt: BILLING_NOW,
          isQueuedBehindActive: false,
          term: { planName: "专业版", startDate: "2026-10-06", endDate: "2026-11-05" },
          points: 6600,
        }
      : null,
    bankAccount: {
      accountName: "狸有戏科技有限公司",
      bankName: "示例银行上海支行",
      accountNo: "6222000000000000000",
      accountNoMask: "6222 **** 0000",
      transferRemark: "LYX2026100600001",
    },
    latestTransferProof:
      rejected || waiting
        ? {
            transferProofId: BILLING_ID,
            uploadNo: 1,
            reviewStatus: rejected ? "rejected" : "pending",
            uploadedAt: BILLING_NOW,
            dueAt: "2026-10-07T00:00:00.000Z",
            reviewedAt: rejected ? BILLING_NOW : null,
            rejectReason: null,
            rejectNote: rejected ? "回单金额看不清，请重新上传完整银行回单" : null,
          }
        : null,
    channels: billingPolicy.channels,
  };
}
/** 固定 DTO 的单一注入口，只在 H5 明确标记时启用。 */
export function offlineBillingRequest(scene: string): RequestLayer["request"] {
  if (
    scene.startsWith("topup-") ||
    scene === "plan-renew" ||
    scene === "plan-upgrade" ||
    scene === "wechat-pending"
  )
    return offlinePurchaseRequest(scene);
  let receiptRegistered = false,
    receiptConfirmed = false;
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    let value: unknown;
    if (path === "/m/wallet") value = billingWallet(scene);
    else if (path === "/m/purchase-policy") value = billingPolicy;
    else if (path === "/m/plans") value = billingPlans;
    else if (path === "/m/plans/quote") value = billingQuote;
    else if (path.startsWith("/m/agreements?")) value = billingAgreements;
    else if (path === "/m/payment-orders" && options?.method === "POST")
      value = { ...billingPayment(scene), replayed: false } satisfies Data<"m.paymentOrder.create">;
    else if (path.endsWith("/transfer-proofs")) value = billingPayment("payment-waiting");
    else if (path.startsWith("/m/payment-orders/")) value = billingPayment(scene);
    else if (path === "/m/files") {
      const body = options?.data as Body<"m.file.create">;
      if (
        options?.method !== "POST" ||
        body.category !== "pay_receipt" ||
        body.files.length !== 1 ||
        body.files[0]?.fileName !== billingReceipt.name ||
        body.files[0]?.sizeBytes !== String(billingReceipt.size) ||
        !/^[0-9a-f]{40}$/.test(body.files[0]?.clientToken ?? "")
      )
        throw new Error("回单必须经统一上传登记");
      receiptRegistered = true;
      billingUploadEvidence.push("register");
      value = {
        items: [
          {
            fileId: BILLING_ID,
            clientToken: body.files[0]!.clientToken,
            status: "pending",
            mode: "post",
            bucket: "fake-secure",
            region: "ap-shanghai",
            key: "receipt.png",
            post: receiptPost,
            sts: null,
            chunkSize: null,
            chunkParallel: null,
            expiresAt: "2026-10-07T00:00:00.000Z",
            uploadExpiresAt: "2026-10-07T00:00:00.000Z",
            credentialsLeft: 30,
          },
        ],
      } satisfies Data<"m.file.create">;
    } else if (path === `/m/files/${BILLING_ID}/complete` || path === `/m/files/${BILLING_ID}`) {
      if (!receiptRegistered || !billingUploadEvidence.includes("post"))
        throw new Error("回单必须登记并直传后才能确认");
      const complete = path.endsWith("/complete");
      if (complete) {
        if (!options?.idempotencyKey) throw new Error("回单确认缺少幂等键");
        receiptConfirmed = true;
      } else if (!receiptConfirmed) throw new Error("回单必须确认后才能查询入库");
      billingUploadEvidence.push(complete ? "complete" : "get");
      value = {
        fileId: BILLING_ID,
        category: "pay_receipt",
        status: complete ? "promoting" : "stored",
        rejectReason: null,
        declaredSizeBytes: String(billingReceipt.size),
        sizeBytes: complete ? null : String(billingReceipt.size),
        mime: "image/png",
        moderationState: "not_required",
        storedAt: complete ? null : BILLING_NOW,
        uploadExpiresAt: "2026-10-07T00:00:00.000Z",
        createdAt: BILLING_NOW,
      } satisfies Data<"m.file.get">;
    } else throw new Error(`离线账单场景未登记调用：${path}`);
    return value as T;
  };
}

/** W414固定虚构策略与支付状态，仅经显式H5样张标记进入；不模拟原生支付成功。 */
function offlinePurchaseRequest(scene: string): RequestLayer["request"] {
  const fallback = offlineBillingRequest("wallet-active");
  const policy: Data<"m.purchasePolicy.get"> = {
    ...billingPolicy,
    mode:
      scene === "topup-offline"
        ? "offline_contract"
        : scene === "topup-hidden"
          ? "hidden"
          : "in_app",
    channels: billingPolicy.channels.map((c) => ({ ...c, isEnabled: scene !== "topup-disabled" })),
  };
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]): Promise<T> => {
    let value: unknown;
    if (path === "/m/wallet")
      value = {
        ...billingWallet("wallet-active"),
        topUp: { canTopUp: true, blockReason: null },
      } satisfies Data<"m.wallet.get">;
    else if (path === "/m/purchase-policy") value = policy;
    else if (path === "/m/point-packs") {
      if (scene === "topup-error") throw new Error("固定积分包加载失败");
      value = {
        items: [
          { pointPackId: BILLING_ID, points: 1000, priceFen: 9900 },
          { pointPackId: "00000000-0000-4000-8000-000000000002", points: 3000, priceFen: 27900 },
        ],
      } satisfies Data<"m.pointPack.list">;
    } else if (path === "/m/plans")
      value = {
        items: billingPlans.items.map((p) => ({ ...p, isCurrent: scene === "plan-renew" })),
      } satisfies Data<"m.plan.list">;
    else if (path === "/m/plans/quote")
      value = {
        ...billingQuote,
        policy,
        action: scene === "plan-upgrade" ? "upgrade" : "renew",
        orderType: scene === "plan-upgrade" ? "plan_upgrade" : "plan_renew",
        months: scene === "plan-upgrade" ? null : 1,
        newTerm: scene === "plan-upgrade" ? null : billingQuote.newTerm,
        firstGrantDate: scene === "plan-upgrade" ? null : billingQuote.firstGrantDate,
        effectiveMode: scene === "plan-upgrade" ? "immediate" : "next_term",
        payFen: scene === "plan-upgrade" ? 38000 : billingQuote.payFen,
        formula: {
          ...billingQuote.formula,
          text:
            scene === "plan-upgrade"
              ? "服务端升级试算：剩余周期按差额折算"
              : "服务端续费报价：专业版 · 1个月",
        },
        upgrade:
          scene === "plan-upgrade"
            ? {
                currentTermEndDate: "2026-11-12",
                remainingDays: 6,
                baseDays: 30,
                remainingFullMonths: 0,
                feeDeltaPerMonthFen: 600000,
                monthlyDeltaPoints: 3000,
                proratedFen: 38000,
                topupPoints: 600,
              }
            : null,
      } satisfies Data<"m.plan.quote">;
    else if (path.startsWith("/m/payment-orders/"))
      value = {
        ...billingPayment("bank-waiting"),
        channel: "wechat_jsapi",
        transferState: null,
        actions: ["wechat-prepay", "sync", "cancel"],
        bankAccount: null,
      } satisfies Data<"m.paymentOrder.get">;
    else return fallback(path, options);
    return value as T;
  };
}
