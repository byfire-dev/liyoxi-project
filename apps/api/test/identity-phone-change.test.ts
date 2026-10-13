import { MeUserSchema, SmsCodeResultSchema } from "@liyoxi/contract";
import { createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories } from "@liyoxi/services/testing";
import type { FakeSms } from "@liyoxi/services/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";

const handle = useTestApi();
let api: TestApi, sms: FakeSms, db: Awaited<ReturnType<typeof handle.db.prisma>>;
beforeAll(async () => {
  api = await handle.start();
  db = await handle.db.prisma();
  sms = api.runtime.providers.sms as FakeSms;
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  await configure();
}, 180_000);
async function configure() {
  await db.smsTemplate.updateMany({
    where: { templateKey: { in: ["verify_code", "account_notice"] } },
    data: {
      status: "active",
      signName: "虚构公司",
      providerTemplateId: "fictional-sms",
      updatedAt: api.clock.now(),
    },
  });
}
function write(
  path: string,
  who?: SignedInMerchant,
  json: unknown = {},
  key: string | null = uuidv7(),
) {
  return api.request(`/api/v1${path}`, {
    method: "POST",
    json,
    headers: { ...(who?.headers ?? {}), ...(key ? { "Idempotency-Key": key } : {}) },
  });
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  const body = (await response.json()) as { error: string; details?: unknown };
  expect(body.error).toBe(symbol);
  return body;
}
async function code(who: SignedInMerchant) {
  const response = await write("/m/sms-codes", who, { purpose: "phone_change" });
  expect(response.status, await response.clone().text()).toBe(200);
  return (
    sms
      .callsOf("sendSubscribeFallback")
      .filter((row) => (row.input as { phone: string }).phone === who.phone)
      .at(-1)!.input as { params: { code: string } }
  ).params.code;
}
function phoneBody(oldSmsCode: string, phone: string) {
  const newPhoneCode = `phone-change-${uuidv7()}`;
  api.wechat.phones.set(newPhoneCode, phone);
  return { oldSmsCode, newPhoneCode };
}
let phoneSeq = 0;
const newPhone = () => `137${String(20000000 + ++phoneSeq)}`;

describe("m.smsCode.create", { timeout: 120_000 }, () => {
  it("本人号码真实发送、哈希落库、same-key不重复发送；号码429补偿且带Retry-After", async () => {
    const who = await signInAsMerchant(api),
      key = uuidv7(),
      input = { purpose: "phone_change" };
    const first = await write("/m/sms-codes", who, input, key);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    const data = SmsCodeResultSchema.parse(((await first.json()) as { data: unknown }).data);
    expect(data.targetPhoneMask).toBe(
      who.login.user
        ? (who.login.user as { phoneMask: string }).phoneMask
        : `${who.phone.slice(0, 3)}****${who.phone.slice(-4)}`,
    );
    expect(new Date(data.expiresAt).getTime() - api.clock.now().getTime()).toBe(300000);
    const count = sms.callsOf("sendSubscribeFallback").length;
    const replay = await write("/m/sms-codes", who, input, key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(((await replay.json()) as { data: unknown }).data).toEqual(data);
    expect(sms.callsOf("sendSubscribeFallback")).toHaveLength(count);
    const limited = await write("/m/sms-codes", who, input);
    await error(limited, 429, "RATE_LIMITED");
    expect(limited.headers.get("Retry-After")).not.toBeNull();
    const rows = await db.smsVerification.findMany({
      where: { merchantUserId: who.merchantUserId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).toHaveLength(32);
  });
  it("拒绝匿名/缺键/其他purpose/伪造目标手机号，任何拒绝均无发送", async () => {
    const who = await signInAsMerchant(api),
      count = sms.callsOf("sendSubscribeFallback").length;
    await error(
      await write("/m/sms-codes", undefined, { purpose: "phone_change" }),
      401,
      "AUTH_REQUIRED",
    );
    await error(
      await write("/m/sms-codes", who, { purpose: "phone_change" }, null),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    for (const input of [
      { purpose: "login" },
      { purpose: "contact_phone" },
      { purpose: "phone_change", phone: newPhone() },
    ])
      await error(await write("/m/sms-codes", who, input), 400, "VALIDATION_FAILED");
    expect(sms.callsOf("sendSubscribeFallback")).toHaveLength(count);
  });
  it("模板未配置与真实发送失败返回503并删除本次码，同键可以重试", async () => {
    const who = await signInAsMerchant(api),
      input = { purpose: "phone_change" },
      key = uuidv7();
    await db.smsTemplate.update({
      where: { templateKey: "verify_code" },
      data: { status: "unconfigured", providerTemplateId: null, signName: null },
    });
    try {
      await error(await write("/m/sms-codes", who, input, key), 503, "SMS_UNAVAILABLE");
    } finally {
      await configure();
    }
    sms.failNext("sendSubscribeFallback");
    await error(await write("/m/sms-codes", who, input, key), 503, "SMS_UNAVAILABLE");
    expect(await db.smsVerification.count({ where: { merchantUserId: who.merchantUserId } })).toBe(
      0,
    );
    api.clock.advance(60000);
    expect((await write("/m/sms-codes", who, input, key)).status).toBe(200);
  });
});

describe("m.me.changePhone", { timeout: 120_000 }, () => {
  it("老板无需门店头换绑，保留当前token、其他设备失效；same-key不重复取微信号码及旧号通知", async () => {
    const who = await signInAsMerchant(api),
      other = await signInAsMerchant(api, { phone: who.phone });
    await merchantServicesOf(api.runtime).tenant.createEntity(
      createIdentityContext({
        actor: { type: "merchant", id: who.merchantUserId, client: "weapp" },
      }),
    );
    const phone = newPhone(),
      input = phoneBody(await code(who), phone),
      key = uuidv7();
    const first = await write("/m/me/change-phone", who, input, key);
    expect(first.status, await first.clone().text()).toBe(200);
    const data = MeUserSchema.parse(((await first.json()) as { data: unknown }).data);
    expect(data).toMatchObject({
      merchantUserId: who.merchantUserId,
      phoneMask: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
    });
    expect((await api.request("/api/v1/m/me", { headers: who.headers })).status).toBe(200);
    await error(
      await api.request("/api/v1/m/me", { headers: other.headers }),
      401,
      "SESSION_INVALID",
    );
    expect(sms.callsOf("sendSubscribeFallback").at(-1)!.input).toMatchObject({
      phone: who.phone,
      templateKey: "account_notice",
    });
    const calls = api.wechat.callsOf("getPhoneNumber").length,
      direct = sms.callsOf("sendSubscribeFallback").length;
    api.wechat.phones.delete(input.newPhoneCode);
    const replay = await write("/m/me/change-phone", who, input, key);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(((await replay.json()) as { data: unknown }).data).toEqual(data);
    expect(api.wechat.callsOf("getPhoneNumber")).toHaveLength(calls);
    expect(sms.callsOf("sendSubscribeFallback")).toHaveLength(direct);
  });
  it("店员个人范围与老板相同，无X-Store-Id可换本人；老板号码PHONE_TAKEN且两人事实不变", async () => {
    const owner = await signInAsMerchant(api),
      clerk = await signInAsMerchant(api);
    const entity = await merchantServicesOf(api.runtime).tenant.createEntity(
      createIdentityContext({
        actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
      }),
    );
    const make = createFactories({ db, clock: api.clock });
    const member = await make.entityMember({
      entityId: entity.entityId,
      merchantUserId: clerk.merchantUserId,
    });
    await make.storeMember({
      storeId: entity.storeId,
      entityMemberId: member.id,
      addedByMemberId: entity.memberId,
    });
    const oldSmsCode = await code(clerk);
    await error(
      await write("/m/me/change-phone", clerk, phoneBody(oldSmsCode, owner.phone)),
      409,
      "PHONE_TAKEN",
    );
    const row = await db.smsVerification.findFirstOrThrow({
      where: { merchantUserId: clerk.merchantUserId },
      orderBy: { createdAt: "desc" },
    });
    expect(row.usedAt).toBeNull();
    const phone = newPhone(),
      changed = await write("/m/me/change-phone", clerk, phoneBody(oldSmsCode, phone));
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(MeUserSchema.parse(((await changed.json()) as { data: unknown }).data).phoneMask).toBe(
      `${phone.slice(0, 3)}****${phone.slice(-4)}`,
    );
    expect((await api.request("/api/v1/m/me", { headers: owner.headers })).status).toBe(200);
  });
  it("匿名/缺键/体裁拒绝；错码有attemptsLeft，微信code无效与同号码均不消费正确旧码", async () => {
    const who = await signInAsMerchant(api),
      oldSmsCode = await code(who);
    const input = phoneBody(oldSmsCode, newPhone());
    await error(await write("/m/me/change-phone", undefined, input), 401, "AUTH_REQUIRED");
    await error(
      await write("/m/me/change-phone", who, input, null),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    await error(
      await write("/m/me/change-phone", who, { ...input, oldSmsCode: "x" }),
      400,
      "VALIDATION_FAILED",
    );
    const wrong = oldSmsCode === "000000" ? "111111" : "000000";
    expect(
      (
        await error(
          await write("/m/me/change-phone", who, { ...input, oldSmsCode: wrong }),
          400,
          "SMS_CODE_INVALID",
        )
      ).details,
    ).toEqual({ attemptsLeft: 4 });
    await error(
      await write("/m/me/change-phone", who, { oldSmsCode, newPhoneCode: "missing-code" }),
      400,
      "WECHAT_CODE_INVALID",
    );
    await error(
      await write("/m/me/change-phone", who, phoneBody(oldSmsCode, who.phone)),
      400,
      "PHONE_UNCHANGED",
    );
    const row = await db.smsVerification.findFirstOrThrow({
      where: { merchantUserId: who.merchantUserId },
    });
    expect(row).toMatchObject({ usedAt: null, attempts: 1 });
  });
});
