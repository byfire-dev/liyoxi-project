import {
  createIdentity,
  createIdentityContext,
  createNotices,
  createRuntime,
  loadEnv,
  proposeFinanceConfig,
  uuidv7,
} from "@liyoxi/services";
import type { Env } from "@liyoxi/services";
import { merchantCertificateForTest } from "@liyoxi/services/testing";
import { createRefundHarnessForTest, fakeKeyEnv, TEST_KEYRING } from "@liyoxi/services/testing";
import type { useSeededDatabase } from "@liyoxi/services/testing";
import { dayRange } from "@liyoxi/shared/time";

export async function stagingQrWorld(
  db: ReturnType<typeof useSeededDatabase>,
  redisKeyPrefix: string,
) {
  const h = createRefundHarnessForTest(await db.prisma());
  const runtimes: ReturnType<typeof createRuntime>[] = [];
  try {
    const approval = h.deps.approval;
    if (!approval) throw new Error("必须装配实际配置审批");
    const identity = createIdentity({
      ...h.deps,
      wechat: h.provider.wechat,
      appid: "wx0000000000000000",
    });
    const operator = await h.staff("super_admin");
    const notices = createNotices({ clock: h.clock, events: h.events });
    const versions: string[] = [],
      loginConsents: { agreementKey: string; agreementVersionId: string }[] = [];
    for (const agreementKey of ["user", "privacy", "member", "points"]) {
      const id = uuidv7();
      const siteNoticeId = ["member", "points"].includes(agreementKey)
        ? (
            await h.tx.run((tx) =>
              notices.announce(tx, operator.ctx, {
                kind: "agreement_version",
                refId: id,
                title: "预发隔离协议",
                summary: "预发隔离协议",
                effectiveAt: h.clock.now(),
                shortNoticeReason: "隔离夹具",
                link: { route: "agreement.version", params: { agreementVersionId: id } },
                createdByStaffId: operator.row.id,
              }),
            )
          ).siteNoticeId
        : undefined;
      const version = await h.make.agreementVersion({ id, agreementKey, siteNoticeId });
      if (siteNoticeId) versions.push(version.id);
      else loginConsents.push({ agreementKey, agreementVersionId: version.id });
    }
    h.provider.wechat.sessions.set("staging-login", { openid: "o_staging_qr_fixture" });
    h.provider.wechat.phones.set("staging-phone", "13770000001");
    let login = await identity.phoneLogin(
      { requestId: null, ip: null, userAgent: null, clientVersion: "1.0.0" },
      {
        loginCode: "staging-login",
        phoneCode: "staging-phone",
        consents: loginConsents,
      },
    );
    const scope = await h.deps.tenant.createEntity(
      createIdentityContext({
        actor: { type: "merchant", id: login.me.user.merchantUserId, client: "weapp" },
      }),
    );
    // 与既有支付HTTP夹具一致：仅准备主体资质；订单/价目/协议/付款事实均走实际公口。
    await h.prisma.entity.update({
      where: { id: scope.entityId },
      data: { verificationStatus: "pending" },
    });
    const certificate = merchantCertificateForTest();
    const env: Env = {
      ...loadEnv({
        APP_ENV: "test",
        DATABASE_URL: await db.url(),
        REDIS_URL: process.env.REDIS_URL,
      }),
      ...fakeKeyEnv(),
      APP_ENV: "stg",
      STAGING_PAY: { entityIds: [scope.entityId] },
      WECHAT: {
        appid: "wx0000000000000000",
        secret: "explicit-test-provider",
        messageToken: "explicit-test-provider",
        messageEncodingAESKey: Buffer.alloc(32, 0x61).toString("base64").slice(0, -1),
      },
      WECHAT_PAY: {
        appid: "wx0000000000000000",
        mchid: "1900000109",
        merchantSerialNo: certificate.serial,
        merchantPrivateKeyPem: certificate.privateKeyPem,
        publicKeyPem: certificate.publicKeyPem,
        publicKeyId: "PUB_KEY_ID_TEST",
        apiV3Key: "00000000000000000000000000000000",
        notifyUrl: "https://example.invalid/hooks/wechatpay",
      },
    };
    function runtime(overrides: Partial<Env> = {}, omitWechat = false) {
      const configured = { ...env, ...overrides, LOG_LEVEL: "fatal" as const };
      if (omitWechat) delete configured.WECHAT;
      const built = createRuntime({
        entry: "worker",
        version: "staging-qr-test",
        env: configured,
        clock: h.clock,
        providers: h.provider,
        billingKeyring: TEST_KEYRING,
        redisKeyPrefix,
      });
      runtimes.push(built);
      return built;
    }
    const r = runtime();
    const actor = { identity: operator.ctx, staff: operator.staff };
    const plan = await h.prisma.plan.findUniqueOrThrow({ where: { code: "basic" } });
    const { earliestNoticedEffectiveDate: effectiveDate } = await r.billingParameters.list(
      operator.staff,
    );
    // 真实W407价目入口，遵守完整公告期；不改种子价目行或直接覆盖价格。
    await r.billingPlansAdmin.createRevision(actor, plan.id, {
      monthlyFeeFen: 1,
      monthlyPoints: 1,
      discountBp: 10000,
      productionModel: "standard",
      maxStores: 1,
      maxMembers: 1,
      schedulePriority: "standard",
      hasMonthlyReport: false,
      effectiveDate,
      firstCyclePromo: false,
    });
    h.clock.set(dayRange(effectiveDate).start);
    // 公告期可能超过原session空闲期；走新code真实重登，绝不调整TTL或续写旧会话。
    h.provider.wechat.sessions.set("staging-current-login", { openid: "o_staging_qr_fixture" });
    h.provider.wechat.phones.set("staging-current-phone", "13770000001");
    const refreshed = await identity.phoneLogin(
      { requestId: null, ip: null, userAgent: null, clientVersion: "1.0.0" },
      {
        loginCode: "staging-current-login",
        phoneCode: "staging-current-phone",
        consents: loginConsents,
      },
    );
    if (refreshed.me.user.merchantUserId !== login.me.user.merchantUserId)
      throw new Error("重新登录必须仍为原老板");
    login = refreshed;
    const proposer = await h.staff("super_admin"),
      reviewer = await h.staff("super_admin");
    const proposal = await h.tx.run((tx) =>
      proposeFinanceConfig(
        tx,
        { approval, clock: h.clock, keyring: TEST_KEYRING },
        proposer.ctx,
        {
          configKey: "controls",
          payload: {
            adminCreateOrder: false,
            wechatSingleLimitFen: 100,
            wechatDailyLimitFen: 100,
            receiptSecondReviewFen: null,
            shippingReport: false,
          },
          changeNote: "预发隔离小额通道",
        },
        proposer.staff,
      ),
    );
    await h.tx.run((tx) =>
      approval.approve(tx, reviewer.ctx, {
        approvalId: proposal.approvalId,
        staff: reviewer.staff,
        lockVersion: 0,
      }),
    );
    const request = {
      sessionToken: login.token,
      entityId: scope.entityId,
      storeId: scope.storeId,
      client: { platform: "android", appVersion: "1.0.0" },
      purchase: { planId: plan.id, months: 1, expectAmountFen: 1, agreementVersionIds: versions },
      idempotencyKey: uuidv7(),
    };
    const membership = await h.tx.run((tx) =>
      h.deps.tenant.resolveMembership(tx, {
        merchantUserId: login.me.user.merchantUserId,
        storeId: scope.storeId,
      }),
    );
    if (!membership) throw new Error("真实老板上下文缺失");
    const buyer = {
      ctx: createIdentityContext({
        actor: {
          type: "merchant",
          id: login.me.user.merchantUserId,
          client: "weapp",
          role: "owner",
        },
        ...scope,
      }),
      membership,
    };
    return {
      ...h,
      env,
      identity,
      runtime,
      r,
      request,
      buyer,
      async closeAll() {
        const results = await Promise.allSettled(runtimes.map((item) => item.close()));
        await h.close();
        const failed = results.find((item) => item.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      },
    };
  } catch (error) {
    await Promise.allSettled([...runtimes.map((item) => item.close()), h.close()]);
    throw error;
  }
}
