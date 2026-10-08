import { beforeAll, expect, it } from "vitest";
import { createLogger, createRuntime, loadEnv } from "@liyoxi/services";
import {
  createClock,
  createProviderHarness,
  fakeKeyEnv,
  useTestDatabase,
  useTestRedis,
} from "@liyoxi/services/testing";
import { createApp } from "../src/app.js";
import { HANDLERS } from "../src/routes/index.js";
import { PLACEHOLDER_WEAPP_APPID, provideMerchantDeps } from "../src/merchant/services.js";
import { TEST_API_KEYRING } from "../src/testing/index.js";
import { seedUserAgreements } from "../src/testing/merchant.js";

const db = useTestDatabase("api");
const redis = useTestRedis();
beforeAll(async () => {
  await db.url();
  await redis.client();
});
let versionsPromise: ReturnType<typeof seedUserAgreements> | undefined;
let sequence = 0;
const wechat = {
  appid: "wx_configured_app",
  secret: "public-fake-secret",
  messageToken: "public-fake-token",
  messageEncodingAESKey: "A".repeat(43),
};

it.each([
  { configured: true, override: undefined, expected: wechat.appid },
  { configured: true, override: "wx_explicit_override", expected: "wx_explicit_override" },
  { configured: false, override: undefined, expected: PLACEHOLDER_WEAPP_APPID },
])("真实手机号登录HTTP使用配置或显式AppID %#", async ({ configured, override, expected }) => {
  const clock = createClock();
  const harness = createProviderHarness({ clock });
  const runtime = createRuntime({
    entry: "api",
    version: "test",
    clock,
    redisKeyPrefix: redis.prefix,
    providers: harness.providers,
    env: {
      ...loadEnv(),
      ...fakeKeyEnv(),
      DATABASE_URL: await db.url(),
      ...(configured ? { WECHAT: wechat } : {}),
    },
    logger: createLogger({
      svc: "api",
      env: "test",
      level: "debug",
      version: "test",
      destination: { write() {} },
    }),
  });
  try {
    provideMerchantDeps(runtime, {
      keyring: TEST_API_KEYRING,
      ...(override ? { appid: override } : {}),
    });
    const versions = await (versionsPromise ??= seedUserAgreements({ db }, { runtime, clock }));
    const api = createApp({ runtime, handlers: HANDLERS });
    harness.providers.wechat.sessions.set("fake-login", { openid: `fake-${expected}` });
    harness.providers.wechat.phones.set("fake-phone", `137${String(++sequence).padStart(8, "0")}`);
    const response = await api.app.request(
      "/api/v1/m/sessions/phone-login",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-client-version": "1.4.0" },
        body: JSON.stringify({
          loginCode: "fake-login",
          phoneCode: "fake-phone",
          consents: [
            { agreementKey: "user", agreementVersionId: versions.user },
            { agreementKey: "privacy", agreementVersionId: versions.privacy },
          ],
        }),
      },
      { incoming: { socket: { remoteAddress: "198.19.100.17" } } },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const prisma = await db.prisma();
    expect(
      await prisma.wechatIdentity.findUniqueOrThrow({
        where: { appid_openid: { appid: expected, openid: `fake-${expected}` } },
      }),
    ).toMatchObject({ appid: expected });
    expect(
      await prisma.agreementConsent.count({ where: { appid: expected } }),
    ).toBeGreaterThanOrEqual(2);
    expect(harness.providers.wechat.callsOf("code2Session")).toHaveLength(1);
  } finally {
    await runtime.close();
  }
});
