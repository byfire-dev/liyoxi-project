import { afterAll, beforeAll, expect, it } from "vitest";
import { useSeededDatabase, notificationFixture } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { createNotifyDispatcher } from "./service.js";
const db = useSeededDatabase("services");
let h: ReturnType<typeof notificationFixture>;
beforeAll(async () => {
  h = notificationFixture(await db.prisma());
}, 120_000);
afterAll(async () => {
  await h?.service.close();
});
const input = (phone: string, key = uuidv7()) => ({
  purpose: "staff_activation" as const,
  templateKey: "verify_code",
  phone,
  params: { code: "A7K9M2Q4" },
  directKey: `staff_act:${key}`,
});
const configure = () =>
  h.prisma.smsTemplate.update({
    where: { templateKey: "verify_code" },
    data: {
      status: "active",
      providerTemplateId: "fictional-activation",
      signName: "虚构公司",
      updatedAt: h.clock.now(),
    },
  });
it("未配置真实降级：不调用Provider，不把phone/八字符code/params写入任何通知变量", async () => {
  const request = input("13811112222"),
    result = await h.service.sendDirect(request);
  expect(result.status).toBe("skipped");
  const row = await h.prisma.notificationDelivery.findUniqueOrThrow({
    where: { id: result.deliveryId },
  });
  expect(row).toMatchObject({
    isDirect: true,
    origin: "direct",
    notificationId: null,
    reason: "unconfigured",
    attemptNo: 0,
  });
  expect(JSON.stringify(row)).not.toContain(request.phone);
  expect(JSON.stringify(row)).not.toContain(request.params.code);
  expect(h.providers.sms.callsOf("sendActivationCode")).toHaveLength(0);
});
it("配置后同幂等键并发只发一次，真实TX外guard、码保持8字符、同key返回原行", async () => {
  await configure();
  const request = input("13811113333");
  const values = await Promise.all([h.service.sendDirect(request), h.service.sendDirect(request)]);
  expect(new Set(values.map((v) => v.deliveryId)).size).toBe(1);
  const row = await h.prisma.notificationDelivery.findUniqueOrThrow({
    where: { id: values[0]!.deliveryId },
  });
  expect(row).toMatchObject({ status: "sent", attemptNo: 1, maxAttempts: 1, leaseUntil: null });
  expect(
    h.providers.sms
      .callsOf("sendActivationCode")
      .filter((v) => (v.input as { phone: string }).phone === request.phone),
  ).toHaveLength(1);
  expect(
    h.providers.sms
      .callsOf("sendActivationCode")
      .find((v) => (v.input as { phone: string }).phone === request.phone)?.input,
  ).toMatchObject({ code: request.params.code });
  expect(JSON.stringify(row)).not.toContain(request.params.code);
  await expect(h.tx.run(() => h.service.sendDirect(input("13811114444")))).rejects.toThrow();
});
it("同号码60秒预算串行拒绝第二key；60秒相等合法，历史direct_key不重复扣预算", async () => {
  const request = input("13811115555");
  const first = await h.service.sendDirect(request);
  await expect(h.service.sendDirect(input(request.phone))).rejects.toMatchObject({
    error: "RATE_LIMITED",
  });
  expect(await h.service.sendDirect(request)).toEqual(first);
  h.clock.advance(60_000);
  expect((await h.service.sendDirect(input(request.phone))).status).toBe("sent");
});
it("直发未知结果不重试/不补发，同key重放不新增外呼；拒绝擅自把八字符激活码缩短", async () => {
  const request = input("13811116666");
  h.providers.sms.failNext("sendActivationCode");
  const first = await h.service.sendDirect(request);
  expect(first.status).toBe("failed");
  expect(
    await h.prisma.notificationDelivery.findUnique({ where: { id: first.deliveryId } }),
  ).toMatchObject({ reason: "unknown_outcome", attemptNo: 1 });
  expect(await h.service.sendDirect(request)).toEqual(first);
  expect(
    h.providers.sms
      .callsOf("sendActivationCode")
      .filter((v) => (v.input as { phone: string }).phone === request.phone),
  ).toHaveLength(1);
  await expect(
    h.service.sendDirect({ ...input("13811117777"), params: { code: "123456" } }),
  ).rejects.toThrow("八字符");
});
it("跨两个实际SMS模板的同号码并发仍只消费最后一个自然日名额", async () => {
  const phone = "13811118888",
    target = h.deps.directTarget(phone)!;
  for (const templateKey of ["account_notice", "ops_alert"])
    await h.prisma.smsTemplate.update({
      where: { templateKey },
      data: {
        status: "active",
        providerTemplateId: `fictional-${templateKey}`,
        signName: "虚构公司",
        updatedAt: h.clock.now(),
      },
    });
  const now = h.clock.now();
  for (let n = 0; n < 5; n++)
    await h.prisma.notificationDelivery.create({
      data: {
        id: uuidv7(),
        notificationId: null,
        isDirect: true,
        origin: "direct",
        channel: "sms",
        purpose: "account_notice",
        smsTemplateKey: "account_notice",
        status: "sent",
        dueAt: now,
        maxAttempts: 1,
        attemptNo: 1,
        callStartedAt: now,
        sentAt: now,
        finishedAt: now,
        targetRef: target.phoneRef,
        targetMasked: target.phoneMask,
        createdAt: now,
        updatedAt: now,
      },
    });
  const results = await Promise.allSettled([
    h.service.sendDirect({
      purpose: "account_notice",
      templateKey: "account_notice",
      phone,
      params: {},
      directKey: `notice:${uuidv7()}`,
    }),
    h.service.sendDirect({
      purpose: "ops_alert",
      templateKey: "ops_alert",
      phone,
      params: {},
      directKey: `ops:${uuidv7()}`,
    }),
  ]);
  expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
  expect(results.find((value) => value.status === "rejected")).toMatchObject({
    status: "rejected",
    reason: { error: "RATE_LIMITED" },
  });
  expect(
    await h.prisma.notificationDelivery.count({
      where: { channel: "sms", targetRef: target.phoneRef, callStartedAt: { not: null } },
    }),
  ).toBe(6);
  expect(
    h.providers.sms
      .callsOf("sendSubscribeFallback")
      .filter((value) => (value.input as { phone: string }).phone === phone),
  ).toHaveLength(1);
});

it("关闭等待直发认领TX结束，尚未外呼不能遗留租约或在已关连接上结算", async () => {
  await configure();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const local = createNotifyDispatcher({
    ...h.deps,
    smsEnabled: async () => {
      enter();
      await gate;
      return true;
    },
  });
  const request = input("13811119999"),
    sending = local.sendDirect(request);
  let shut = false;
  let shutdown: Promise<void> | undefined;
  try {
    await entered;
    shutdown = local.close().then(() => {
      shut = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shut).toBe(false);
    release();
    const [sent] = await Promise.all([sending, shutdown]);
    expect(sent.status).toBe("failed");
    expect(
      await h.prisma.notificationDelivery.findUnique({ where: { id: sent.deliveryId } }),
    ).toMatchObject({ status: "failed", errorCode: "aborted", leaseUntil: null });
    expect(
      h.providers.sms
        .callsOf("sendActivationCode")
        .filter((value) => (value.input as { phone: string }).phone === request.phone),
    ).toHaveLength(0);
  } finally {
    release();
    await Promise.allSettled([sending, shutdown]);
    await local.close();
  }
});
