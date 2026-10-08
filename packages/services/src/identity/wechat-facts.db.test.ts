import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { currentSessionOpenid } from "./index.js";
import { buildHarness, META, TEST_APPID } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";

const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
});
afterAll(async () => {
  vi.restoreAllMocks();
  await h?.prisma.$disconnect();
});
const meta = META;
const counts = async () =>
  Promise.all([
    h.prisma.merchantUser.count(),
    h.prisma.wechatIdentity.count(),
    h.prisma.userSession.count(),
    h.prisma.agreementConsent.count(),
  ]);

it.each([
  { phone: "13800138000", countryCode: "1", purePhoneNumber: "13800138000" },
  { phone: "13800138000", countryCode: "86", purePhoneNumber: "13900139000" },
])("区号与纯号码事实矛盾不能绑定同形大陆账号 %#", async (fact) => {
  const input = h.codes({ openid: `fake_${fact.countryCode}`, phone: fact.phone });
  const before = await counts();
  const runs = h.txRuns();
  const spy = vi.spyOn(h.wechat, "getPhoneNumber").mockResolvedValue({ ok: true, value: fact });
  try {
    await expect(
      h.identity.phoneLogin(meta, { ...input, consents: h.consents() }),
    ).rejects.toMatchObject({
      error: "PHONE_REGION_UNSUPPORTED",
    });
    expect(h.txRuns()).toBe(runs);
    expect(await counts()).toEqual(before);
  } finally {
    spy.mockRestore();
  }
});

it("只phone旧替身仍可登录，当前会话openid不跨AppID使用", async () => {
  const input = h.codes({ openid: "fake_current_openid", phone: "13900139000" });
  const result = await h.identity.phoneLogin(meta, { ...input, consents: h.consents() });
  const identity = await h.prisma.wechatIdentity.findFirstOrThrow({
    where: { openid: "fake_current_openid" },
  });
  const session = await h.prisma.userSession.findFirstOrThrow({
    where: { wechatIdentityId: identity.id },
  });
  expect(result.token).toBeTruthy();
  const principal = {
    sessionId: session.id,
    merchantUserId: identity.merchantUserId,
    wechatIdentityId: identity.id,
    consentStamp: null,
  };
  expect(await h.tx.run((tx) => currentSessionOpenid(tx, principal, TEST_APPID))).toBe(
    "fake_current_openid",
  );
  await expect(
    h.tx.run((tx) => currentSessionOpenid(tx, principal, "wx_other_app")),
  ).rejects.toMatchObject({
    error: "SESSION_INVALID",
  });
});
