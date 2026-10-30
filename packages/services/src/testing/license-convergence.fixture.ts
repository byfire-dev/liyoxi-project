import { ChecklistItemsSchema, COMPARE_FIELDS } from "@liyoxi/contract";
import type { PrismaClient } from "@liyoxi/db";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { recordChannelSuccess } from "../billing/index.js";
import { createDelivery } from "../delivery/index.js";
import { createIdentityContext, loadEnv, uuidv7 } from "../kernel/index.js";
import { createRuntimeDocsLicense } from "../ops/index.js";
import type { OrderActor } from "../order/index.js";
import { createProfile } from "../profile/index.js";
import { createPublish } from "../publish/index.js";
import { createRuntime } from "../runtime.js";
import { createSla } from "../sla/index.js";
import { createTenant } from "../tenant/index.js";
import { sampleStaffContext } from "./approval.js";
import {
  applyReceipt,
  createPaymentHarness,
  pendingPlanOrder,
  pendingWechatReceipt,
} from "./billing-payment.js";
import { createClock } from "./clock.js";
import type { AdjustableClock } from "./clock.js";
import {
  assertM1LicenseTestDatabase,
  M1_LICENSE_TEST_INPUTS,
  prepareM1LicenseInputs,
} from "./m1-license-inputs.js";
import { TEST_KEYRING } from "./data/seal.js";
import { prepareOrderAgreement, prepareOrderDrama, prepareOrderProfile } from "./order.fixture.js";
import { createFakeProviders } from "./providers/index.js";

/** Upstream historical identity/media inputs; payment, account approval and order writers are real. */
export async function createLicenseConvergenceFixture(
  prisma: PrismaClient,
  options: {
    databaseUrl: string;
    redisUrl: string;
    redisKeyPrefix: string;
    clock?: AdjustableClock;
  },
) {
  await assertM1LicenseTestDatabase(prisma, options.databaseUrl);
  const clock = options.clock ?? createClock(),
    providers = createFakeProviders({ clock }),
    runtime = createRuntime({
      entry: "api",
      version: "test",
      clock,
      env: loadEnv({
        APP_ENV: "test",
        DATABASE_URL: options.databaseUrl,
        REDIS_URL: options.redisUrl,
        PORTAL_PUBLIC_ORIGIN: M1_LICENSE_TEST_INPUTS.portalPublicOrigin,
      }),
      providers,
      billingKeyring: TEST_KEYRING,
      redisKeyPrefix: options.redisKeyPrefix,
    });
  try {
    const h = createPaymentHarness(prisma, { clock }),
      merchant = await h.make.merchant({ verified: true }),
      ctx = createIdentityContext({
        actor: { type: "merchant", id: merchant.user.id, client: "weapp" },
        entityId: merchant.entity.id,
        storeId: merchant.store.id,
      }),
      actor: OrderActor = {
        ctx,
        membership: {
          memberId: merchant.owner.id,
          entityId: merchant.entity.id,
          storeId: merchant.store.id,
          role: "owner",
          storeMode: "active",
        },
      },
      admin = await h.make.staff({ staffRoleKey: "super_admin" }),
      staff = await sampleStaffContext(prisma, admin.id, { stepUpAt: clock.now() }),
      adminCtx = createIdentityContext({
        actor: { type: "staff", id: admin.id, client: "admin" },
      });
    await prepareM1LicenseInputs({
      db: prisma,
      clock,
      env: runtime.env,
      inputs: M1_LICENSE_TEST_INPUTS,
    });
    const paymentOrder = await pendingPlanOrder(h, {
        entityId: merchant.entity.id,
        channel: "wechat_jsapi",
      }),
      receipt = await pendingWechatReceipt(h, paymentOrder),
      appid = "wx0000000000000000",
      mchid = "1900000109";
    providers.wechatPay.useWireFormat({ appid, mchid });
    const prepay = await providers.wechatPay.createJsapiOrder({
      outTradeNo: receipt.outTradeNo,
      description: "授权收敛测试真实套餐付款",
      amountFen: receipt.amountFen,
      payerOpenid: receipt.payerOpenid!,
      attach: receipt.attach!,
      expireAt: paymentOrder.expiresAt,
    });
    if (!prepay.ok) throw new Error("测试渠道预下单失败");
    const paid = providers.wechatPay.pay(receipt.outTradeNo);
    if (paid.kind !== "transaction") throw new Error("测试渠道未返回交易事实");
    // Each isolated fake provider restarts its local transaction counter; the shared DB does not.
    providers.wechatPay.setQueryResult(receipt.outTradeNo, {
      ...paid.transaction,
      transactionId: `420${uuidv7().replaceAll("-", "").slice(0, 29)}`,
    });
    const verified = await providers.wechatPay.queryByOutTradeNo({
      outTradeNo: receipt.outTradeNo,
    });
    if (!verified.ok) throw new Error("测试渠道查单失败");
    await h.tx.run((tx) =>
      recordChannelSuccess(
        tx,
        { ...h.paymentDeps, appid, mchid },
        createIdentityContext({ actor: { type: "system", job: "lyxtest.license_paid" } }),
        { paymentTxnId: receipt.id, transaction: verified.value },
      ),
    );
    await applyReceipt(h, receipt);
    await prepareOrderProfile(prisma, h, actor);
    const drama = await prepareOrderDrama(h),
      dramaId = drama.id;
    await prisma.dramaCopyright.update({ where: { dramaId }, data: { territory: "中国大陆" } });
    await prepareOrderAgreement(h);
    const common = {
        tx: runtime.tx,
        clock,
        assembly: runtime.assembly,
        flow: runtime.flow,
        events: runtime.events,
      },
      tenant = createTenant(common),
      publish = createPublish({ ...common, approval: runtime.approval, media: runtime.media }),
      profile = createProfile({
        ...common,
        tenant,
        approval: runtime.approval,
        media: runtime.media,
        keyring: () => TEST_KEYRING,
        wechat: providers.wechat,
        currentOpenid: async () => "lyxtest_license_convergence",
      }),
      delivery = createDelivery({
        ...common,
        media: runtime.media,
        sla: createSla({ clock, assembly: runtime.assembly }),
        profile,
        publish,
        samplePlayback: (entityId) =>
          runtime.config.flags.isEnabled("weapp.video.sample.enabled", { entityId }),
      });
    const checklist = await prisma.checklistTemplate.findFirstOrThrow({
      where: { code: "account.verify", status: "active" },
      orderBy: { versionNo: "desc" },
    });
    const accounts: [string, string] = ["", ""];
    for (const [index, platform] of (["douyin", "wechat_channels"] as const).entries()) {
      const screenshot = await h.make.fileObject({
          category: "channel_screenshot",
          bucket: "asset",
          scopeType: "store",
          entityId: merchant.entity.id,
          storeId: merchant.store.id,
          uploadActorType: "merchant",
          uploadActorId: merchant.user.id,
          uploadClient: "weapp",
        }),
        bound = await publish.bind(actor, {
          platform,
          accountName: `授权收敛测试账号${index + 1}`,
          accountUid: uuidv7(),
          accountType: "none",
          screenshotFileIds: [screenshot.id],
        }),
        submission = await prisma.channelAccountSubmission.findFirstOrThrow({
          where: { channelAccountId: bound.channelAccountId },
          include: { approvalRequest: true, channelAccount: true },
          orderBy: { roundNo: "desc" },
        });
      await publish.approveAccount(adminCtx, staff, submission.id, {
        lockVersion: submission.approvalRequest.lockVersion,
        confirm: { roundNo: submission.roundNo, accountUid: submission.channelAccount.accountUid },
        accountType: "none",
        certSubjectName: null,
        compareRows: COMPARE_FIELDS.map((field) => ({ field, recognized: null, match: true })),
        checklistVersionNo: checklist.versionNo,
        results: ChecklistItemsSchema.parse(checklist.items).map((item) => ({
          key: item.key,
          result: "pass",
        })),
      });
      accounts[index] = bound.channelAccountId;
    }
    const quote = await runtime.order.quote(actor, {
        dramaIds: [dramaId],
        channelAccountIds: accounts,
        isTopModel: false,
      }),
      created = await runtime.order.create(actor, {
        dramaIds: [dramaId],
        channelAccountIds: accounts,
        focusCodes: ["W115F"],
        isTopModel: false,
        agreementVersionId: quote.agreement.agreementVersionId,
        expect: quote.expect,
      }),
      item = await prisma.orderItem.findFirstOrThrow({ where: { dramaOrderId: created.orderId } }),
      order = { id: created.orderId, itemId: item.id };
    let starting: Promise<{ planId: string; ticketId: string }> | undefined;
    const start = () =>
      (starting ??= (async () => {
        const timer = await prisma.timer.findFirstOrThrow({
          where: { kind: "order.start", subjectId: order.id, status: "scheduled" },
        });
        clock.set(timer.fireAt);
        const handler = runtime.assembly.timerHandler("order.start");
        if (!handler) throw new Error("未装配真实order.start");
        const payload = timer.payload;
        if (payload !== null && (typeof payload !== "object" || Array.isArray(payload)))
          throw new Error("真实开工timer载荷不是对象");
        const result = await runtime.tx.run((tx) =>
          handler.handle(tx, {
            id: timer.id,
            kind: timer.kind,
            subjectType: timer.subjectType,
            subjectId: timer.subjectId,
            payload,
          }),
        );
        if (result !== "fired") throw new Error("真实订单开工未完成");
        const ticket = await prisma.deliveryTicket.findUniqueOrThrow({
            where: { orderItemId: order.itemId },
          }),
          manager = await h.make.staff({ staffRoleKey: "delivery_manager" });
        await delivery.assign(adminCtx, staff, ticket.id, { staffId: manager.id });
        const plan = await prisma.deliveryPlan.findUniqueOrThrow({
          where: { dramaOrderId: order.id },
        });
        return { planId: plan.id, ticketId: ticket.id };
      })());
    let confirmationAttempted = false;
    async function confirmAccounts(ids: readonly string[]): Promise<void> {
      if (confirmationAttempted)
        throw new Error("当前真实产品仅支持首次方案确认，不提供账号重选producer");
      if (
        !ids.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !accounts.includes(id))
      )
        throw new Error("方案只能选择本fixture已实际审核的账号子集");
      confirmationAttempted = true;
      const { planId } = await start(),
        plan = await prisma.deliveryPlan.findUniqueOrThrow({ where: { id: planId } });
      await delivery.replaceDraft(adminCtx, staff, planId, {
        draftLockVersion: plan.draftLockVersion,
        content: {
          focusCodes: ["W115F"],
          referenceAssetIds: [],
          launchMode: "merchant_self",
          note: "授权收敛测试首次真实方案",
          items: [
            {
              orderItemId: order.itemId,
              channelAccountIds: [...ids],
              placements: [],
              agreedLaunchDate: addDays(calendarDate(clock.now()), 14),
              expectedDeliveryDate: null,
            },
          ],
        },
      });
      await delivery.push(adminCtx, staff, planId, { draftLockVersion: plan.draftLockVersion + 1 });
      await delivery.confirm(actor, planId, { versionNo: 1 });
    }
    return {
      runtime,
      clock,
      merchant,
      ctx,
      actor,
      dramaId,
      accounts,
      order,
      start,
      confirmAccounts,
      close: () => runtime.close(),
      licenseDeps: createRuntimeDocsLicense({
        clock,
        flow: runtime.flow,
        events: runtime.events,
        portalOrigin: runtime.env.PORTAL_PUBLIC_ORIGIN!,
        keyring: () => TEST_KEYRING,
      }),
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}
