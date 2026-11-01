import type { PrismaClient } from "@liyoxi/db";
import { createIdentityContext } from "../../kernel/index.js";
import {
  createFactories,
  createLicenseConvergenceFixture,
  prepareAdVideoForTest,
  sampleStaffContext,
  TEST_KEYRING,
  openSealed,
} from "../../testing/index.js";
import { createIdentity } from "../../identity/index.js";
import { createTenant } from "../../tenant/index.js";
export async function adFixture(
  db: PrismaClient,
  options: { databaseUrl: string; redisUrl: string; redisKeyPrefix: string },
) {
  const h = await createLicenseConvergenceFixture(db, { ...options, withAdProduction: true });
  try {
    const make = createFactories({ db, clock: h.clock }),
      staff = await make.staff({ staffRoleKey: "super_admin" }),
      context = await sampleStaffContext(db, staff.id, { stepUpAt: h.clock.now() }),
      adminActor = {
        ctx: createIdentityContext({ actor: { type: "staff", id: staff.id, client: "admin" } }),
        staff: context,
      };
    const editor = await make.staff({ staffRoleKey: "editor" }),
      editorContext = await sampleStaffContext(db, editor.id, { stepUpAt: h.clock.now() }),
      staffActor = {
        ctx: createIdentityContext({ actor: { type: "staff", id: editor.id, client: "admin" } }),
        staff: editorContext,
      };
    const r = h.runtime,
      common = { tx: r.tx, clock: h.clock, flow: r.flow, events: r.events, assembly: r.assembly };
    for (const agreementKey of ["user", "privacy", "ad_service"]) {
      const versions = await r.tx.run((tx) => r.docs.currentVersions(tx));
      if (!versions.has(agreementKey)) await make.agreementVersion({ agreementKey });
    }
    const identity = createIdentity({
      ...common,
      docs: r.docs,
      tenant: createTenant(common),
      config: r.config,
      keyring: () => TEST_KEYRING,
      wechat: h.providers.wechat,
      appid: "wx0000000000000000",
    });
    const loginCode = `ad-login-${staff.id}`,
      phoneCode = `ad-phone-${staff.id}`;
    h.providers.wechat.sessions.set(loginCode, { openid: `ad-openid-${staff.id}` });
    h.providers.wechat.phones.set(
      phoneCode,
      openSealed("merchant_user.phone_enc", h.merchant.user.phoneEnc!),
    );
    const agreements = await r.tx.run((tx) => r.docs.currentVersions(tx)),
      consents = ["user", "privacy"].map((agreementKey) => ({
        agreementKey,
        agreementVersionId: agreements.get(agreementKey)!.id,
      }));
    const login = await identity.phoneLogin(
      {
        requestId: h.ctx.requestId,
        ip: "198.19.1.2",
        userAgent: "lyxtest-ad",
        clientVersion: "1.4.0",
      },
      { loginCode, phoneCode, consents },
    );
    const session = await identity.authenticate(login.token, { ip: "198.19.1.2" });
    if (!session.ok) throw new Error("广告测试真实登录失败");
    const actor = { ...h.actor, principal: session.principal };
    const promo = await db.dictItem.findFirstOrThrow({
        where: { dictTypeKey: "ad_promo_point", isEnabled: true },
      }),
      quote = await h.runtime.ads.quote(actor, { type: "opening", durationSec: 3 });
    const created = await h.runtime.ads.create(actor, {
      type: "opening",
      durationSec: 3,
      promoPointCodes: [promo.code],
      expectChargePoints: quote.chargePoints!,
      agreementVersionId: quote.agreement.agreementVersionId,
      isAgreementChecked: true,
    });
    await h.runtime.tx.run((tx) =>
      h.runtime.ads.production.assignTx(tx, adminActor, created.adId, editor.id),
    );
    const push = async () => {
      const video = await prepareAdVideoForTest(h, db, created.adId, staffActor);
      const version = await h.runtime.tx.run((tx) =>
        h.runtime.ads.production.registerVersionTx(tx, staffActor, created.adId, video),
      );
      await h.runtime.tx.run((tx) =>
        h.runtime.ads.production.pushVersionTx(tx, staffActor, version.adVersionId),
      );
      return version;
    };
    const createBody = {
      type: "opening" as const,
      durationSec: 3,
      promoPointCodes: [promo.code],
      expectChargePoints: quote.chargePoints!,
      agreementVersionId: quote.agreement.agreementVersionId,
      isAgreementChecked: true,
    };
    const playback = async (enabled: boolean) => {
      const flag = (await r.configAdmin.flags()).items.find(
        (f) => f.flagKey === "weapp.video.ad.enabled",
      )!;
      await r.configAdmin.updateFlag(
        { identity: adminActor.ctx, staff: adminActor.staff },
        flag.flagKey,
        { lockVersion: flag.lockVersion, defaultValue: enabled },
      );
    };
    return {
      ...h,
      actor,
      created,
      staffActor,
      adminActor,
      editorId: editor.id,
      push,
      createBody,
      playback,
    };
  } catch (error) {
    await h.close();
    throw error;
  }
}
