import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upgradeOrderContentSchema } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { createIdempotencyContext, uuidv7 } from "@liyoxi/services";
import { snapshotTables, useSeededDatabase, useTestRedis } from "@liyoxi/services/testing";
import { runStagingPayQrCommand } from "../src/cli/staging-pay-qr-command.js";
import { stagingQrWorld } from "./staging-pay-qr.fixture.js";
const db = useSeededDatabase("worker", { label: "stagingqr", max: 1 });
const redis = useTestRedis();
let w: Awaited<ReturnType<typeof stagingQrWorld>> | undefined;
let directory: string | undefined;
afterEach(async () => {
  await w?.closeAll();
  w = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
const stdin = async function* (value: unknown) {
  yield JSON.stringify(value);
};
const tables = [
  "billing_order",
  "payment_txn",
  "agreement_consent",
  "idempotency_record",
  "ledger_operation",
  "point_ledger_entry",
  "subscription_term",
  "audit_log",
  "outbox_event",
];
async function world() {
  if (!w) throw new Error("必须经本组beforeEach准备真实夹具");
  return w;
}
async function folder() {
  return (directory ??= await mkdtemp(join(tmpdir(), "lyx-staging-qr-")));
}
it("凭证不接argv，非JSON/超16KiB/取消先拒绝；已有文件不覆盖且不启动运行时", async () => {
  const runtime = vi.fn(() => {
    throw new Error("不可启动");
  });
  const aborted = AbortSignal.abort();
  const secret = "fictional-opaque-session-do-not-echo";
  const output: string[] = [];
  for (const options of [
    { argv: [secret], stdin: stdin({}) },
    {
      argv: [],
      stdin: (async function* () {
        yield secret;
      })(),
    },
    {
      argv: [],
      stdin: (async function* () {
        yield secret.repeat(1024);
      })(),
    },
    { argv: [], stdin: stdin({ request: {}, outputFile: "/tmp/unused" }), signal: aborted },
  ])
    expect(
      await runStagingPayQrCommand({
        ...options,
        runtime,
        out: (s) => output.push(s),
        err: (s) => output.push(s),
      }),
    ).toBe(1);
  const outputFile = join(await folder(), "exists.png");
  await writeFile(outputFile, "original");
  expect(
    await runStagingPayQrCommand({
      argv: [],
      stdin: stdin({ request: { secret }, outputFile }),
      runtime,
      err: (s) => output.push(s),
    }),
  ).toBe(2);
  expect(await readFile(outputFile, "utf8")).toBe("original");
  expect(runtime).not.toHaveBeenCalled();
  expect(output.join("\n")).not.toContain(secret);
});
describe("真实预发支付入口", () => {
  beforeEach(async () => {
    await db.reset();
    w = await stagingQrWorld(db, redis.prefix);
  }, 60_000);
  it("真实价目/会话/创建只产待付款TFK；码失败后同body同key恢复，0600输出零预支付/资金事实", async () => {
    const h = await world(),
      outputFile = join(await folder(), "entry.png");
    const before = await snapshotTables(h.prisma, [
      "payment_txn",
      "ledger_operation",
      "point_ledger_entry",
      "subscription_term",
    ]);
    h.provider.wechat.failNext("createMiniProgramCode", { reason: "unavailable" });
    const output: string[] = [],
      errors: string[] = [];
    const run = (r = h.r) =>
      runStagingPayQrCommand({
        argv: [],
        runtime: () => r,
        stdin: stdin({ request: h.request, outputFile }),
        out: (s) => output.push(s),
        err: (s) => errors.push(s),
      });
    expect(await run()).toBe(1);
    await expect(stat(outputFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await h.prisma.billingOrder.count({ where: { entityId: h.request.entityId } })).toBe(1);
    const r = h.runtime();
    expect(await run(r)).toBe(0);
    const receipt = JSON.parse(output[0]!) as {
      orderNo: string;
      paymentOrderId: string;
      replayed: boolean;
    };
    expect(receipt).toMatchObject({ orderNo: expect.stringMatching(/^TFK\d+$/), replayed: true });
    expect((await stat(outputFile)).mode & 0o777).toBe(0o600);
    expect((await readFile(outputFile)).length).toBeGreaterThan(0);
    const order = await h.prisma.billingOrder.findUniqueOrThrow({
      where: { id: receipt.paymentOrderId },
    });
    expect(order).toMatchObject({ amountFen: 1, status: "pending_payment", paidAt: null });
    expect(h.provider.wechat.callsOf("createMiniProgramCode").at(-1)?.input).toEqual({
      page: "sub/order/result/index",
      scene: receipt.paymentOrderId.replaceAll("-", ""),
    });
    expect(h.provider.wechatPay.callsOf("createJsapiOrder")).toHaveLength(0);
    expect(
      await snapshotTables(h.prisma, [
        "payment_txn",
        "ledger_operation",
        "point_ledger_entry",
        "subscription_term",
      ]),
    ).toEqual(before);
    expect([...output, ...errors].join("\n")).not.toContain(h.request.sessionToken);
    expect(await h.prisma.agreementConsent.count({ where: { bizId: order.id } })).toBe(2);
  });
  it("环境/白名单/小额/配置/会话/协议错误拒绝且无订单/consent/幂等/码外呼", async () => {
    const h = await world();
    // 先以实际认证暖同日会话活动，后续零写快照仅关注业务与同意事实。
    await h.identity.authenticate(h.request.sessionToken, { ip: null });
    const before = await snapshotTables(h.prisma, tables);
    const cases = [
      { r: h.runtime({ APP_ENV: "prod" }), body: h.request },
      { r: h.runtime({ STAGING_PAY: { entityIds: [] } }), body: h.request },
      { r: h.r, body: { ...h.request, purchase: { ...h.request.purchase, expectAmountFen: 101 } } },
      { r: h.r, body: { ...h.request, sessionToken: "wrong-session" } },
      { r: h.runtime({}, true), body: h.request },
      {
        r: h.runtime({ WECHAT: { ...h.env.WECHAT!, appid: "wx1111111111111111" } }),
        body: h.request,
      },
      {
        r: h.r,
        body: {
          ...h.request,
          purchase: { ...h.request.purchase, agreementVersionIds: [uuidv7()] },
        },
      },
      { r: h.r, body: { ...h.request, purchase: { ...h.request.purchase, expectAmountFen: 2 } } },
    ];
    for (const { r, body } of cases)
      await expect(r.stagingPay.create(body)).rejects.toHaveProperty("error");
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
    expect(h.provider.wechat.callsOf("createMiniProgramCode")).toHaveLength(0);
  });
  it("原API仍可创建FK；旧普通open单/错误金额类型同TX拒绝且零写", async () => {
    const h = await world();
    const {
      sessionToken: _session,
      entityId: _entity,
      storeId,
      client,
      purchase,
      idempotencyKey: _key,
    } = h.request;
    const body = { ...purchase, channel: "wechat_jsapi" as const };
    const normal = h.runtime({ APP_ENV: "test" });
    const original = await normal.billing.createOrder(h.buyer, client, body, {
      idem: createIdempotencyContext({
        mode: "required",
        scope: "m.paymentOrder.create",
        actor: h.buyer.ctx.actor,
        key: uuidv7(),
        request: { method: "POST", body, storeId },
      }),
    });
    expect(original.orderNo).toMatch(/^FK\d+$/);
    for (const override of [
      {},
      { orderNo: `T${original.orderNo}`, amountFen: 101 },
      {
        amountFen: 1,
        type: "plan_upgrade",
        contentSnapshot: upgradeOrderContentSchema.parse({
          v: 1,
          kind: "upgrade",
          termId: uuidv7(),
          fromPlanRevisionId: uuidv7(),
          toPlanRevisionId: uuidv7(),
          quotedAt: h.clock.now().toISOString(),
          quotedOn: calendarDate(h.clock.now()),
          monthIndex: 0,
          remainingDays: 30,
          baseDays: 30,
          remainingFullMonths: 0,
          feeDeltaPerMonthFen: 1,
          pointsDeltaPerMonth: 1,
          proratedFen: 1,
          payFen: 1,
          topupPoints: 1,
          validUntil: new Date(h.clock.now().getTime() + 86400000).toISOString(),
        }),
      },
    ]) {
      await h.prisma.billingOrder.update({
        where: { id: original.paymentOrderId },
        data: override,
      });
      const before = await snapshotTables(h.prisma, tables);
      await expect(h.r.stagingPay.create(h.request)).rejects.toMatchObject({
        error: "PRECONDITION_CHANGED",
      });
      expect(await snapshotTables(h.prisma, tables)).toEqual(before);
    }
    expect(h.provider.wechat.callsOf("createMiniProgramCode")).toHaveLength(0);
  });
  it("真实创建事务中途取消回滚新订单、协议与幂等记录", async () => {
    const h = await world();
    const controller = new AbortController(),
      originalAssert = h.r.docs.assertConsents;
    const assertion = vi.spyOn(h.r.docs, "assertConsents").mockImplementation(async (...args) => {
      const result = await originalAssert(...args);
      controller.abort();
      return result;
    });
    const before = await snapshotTables(h.prisma, tables);
    try {
      await expect(
        h.r.stagingPay.create({ ...h.request, idempotencyKey: uuidv7() }, controller.signal),
      ).rejects.toThrow();
    } finally {
      assertion.mockRestore();
    }
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
    expect(h.provider.wechat.callsOf("createMiniProgramCode")).toHaveLength(0);
    expect(await h.prisma.billingOrder.count({ where: { entityId: h.request.entityId } })).toBe(0);
  });
});
