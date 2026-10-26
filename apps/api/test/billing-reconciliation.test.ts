import { beforeAll, expect, it } from "vitest";
import { ReconDayRowSchema, ReconMonthSchema } from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { signInAsStaff, snapshotTables } from "@liyoxi/services/testing";
import type { FakeWechatPay, SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi();
const identity = { appid: "wx0000000000000000", mchid: "1900000109" };
let api: TestApi,
  db: Awaited<ReturnType<typeof handle.db.prisma>>,
  admin: SignedInStaff,
  editor: SignedInStaff;
let peer = 0;
type Operation = "admin.reconciliation.list" | "admin.reconciliation.rerun";
function request(
  op: Operation,
  who: SignedInStaff | null,
  options: { id?: string; query?: string; body?: unknown; key?: string | null } = {},
) {
  const route = api.api.mounted.find((r) => r.operationId === op);
  expect(route).toBeDefined();
  return api.request(
    route!.path.replace(/\{[^}]+\}/g, options.id ?? "") +
      (options.query ? `?${options.query}` : ""),
    {
      method: route!.method,
      headers: {
        ...who?.headers,
        ...(route!.method !== "GET" && options.key !== null
          ? { "Idempotency-Key": options.key ?? uuidv7() }
          : {}),
      },
      ...(options.body === undefined ? {} : { json: options.body }),
      peer: `198.19.79.${++peer % 250}`,
    },
  );
}
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return ((await response.json()) as { data: unknown }).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
const tables = [
  "billing_order",
  "payment_txn",
  "refund_txn",
  "payment_exception",
  "wx_bill_file",
  "wx_bill_line",
  "recon_day",
  "outbox_event",
  "point_ledger_entry",
];
beforeAll(async () => {
  api = await handle.start({ wechatPay: identity });
  api.clock.set(new Date("2026-10-19T04:00:00.000Z"));
  db = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  admin = await signInAsStaff(db, { roleKey: "super_admin", now: api.clock.now() });
  editor = await signInAsStaff(db, { roleKey: "editor", now: api.clock.now() });
}, 60_000);

it("月读经过真实鉴权与持久投影，保留bigint精度/全局财务范围，拒绝未来月且零业务写", async () => {
  const billDate = new Date("2026-10-17T00:00:00.000Z");
  // 只准备只读技术投影，不伪造收款成功或资金履约。
  await db.reconDay.createMany({
    data: [
      {
        id: uuidv7(),
        billDate,
        channel: "wechat_jsapi",
        status: "wait",
        platformPayCount: 1,
        platformPayFen: 9_007_199_254_740_993n,
        createdAt: api.clock.now(),
        updatedAt: api.clock.now(),
      },
      {
        id: uuidv7(),
        billDate,
        channel: "bank_transfer",
        status: "ok",
        bankCount: 1,
        bankFen: 7n,
        createdAt: api.clock.now(),
        updatedAt: api.clock.now(),
      },
    ],
  });
  await db.staffRole.update({ where: { key: "finance" }, data: { dataScope: "own" } });
  api.runtime.staffAuth.roles.invalidate();
  const finance = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() });
  const before = await snapshotTables(db, tables);
  expect(
    (await request("admin.reconciliation.list", null, { query: "month=2026-10" })).status,
  ).toBe(401);
  await error(
    await request("admin.reconciliation.list", editor, { query: "month=2026-10" }),
    403,
    "PERMISSION_DENIED",
  );
  await error(
    await request("admin.reconciliation.list", admin, { query: "month=2026-11" }),
    400,
    "VALIDATION_FAILED",
  );
  const month = ReconMonthSchema.parse(
    await data(await request("admin.reconciliation.list", finance, { query: "month=2026-10" })),
  );
  expect(month.items).toHaveLength(31);
  expect(month.items[0]?.billDate).toBe("2026-10-31");
  expect(month.items.at(-1)?.billDate).toBe("2026-10-01");
  expect(month.items.find((r) => r.billDate === "2026-10-17")).toMatchObject({
    platformPay: { count: 1, amountFen: "9007199254740993" },
    bank: { count: 1, amountFen: "7" },
    billPay: null,
    status: "wait",
    actions: [],
  });
  expect(month.overview.platform).toEqual({
    count: 2,
    wechatCount: 1,
    bankCount: 1,
    amountFen: "9007199254741000",
  });
  expect(month.openExceptions).toEqual([]);
  expect(await snapshotTables(db, tables)).toEqual(before);
});

it("重跑经真实权限/再验证/C51，缺原件零写；可信归档后同键冻结且异键真实加一次运行", async () => {
  const day = "2026-10-18",
    billDate = new Date(`${day}T00:00:00.000Z`);
  const row = await db.reconDay.create({
    data: {
      id: uuidv7(),
      billDate,
      channel: "wechat_jsapi",
      status: "wait",
      createdAt: api.clock.now(),
      updatedAt: api.clock.now(),
    },
  });
  const other = await db.reconDay.create({
    data: {
      id: uuidv7(),
      billDate: new Date("2026-10-16T00:00:00.000Z"),
      channel: "wechat_jsapi",
      status: "wait",
      createdAt: api.clock.now(),
      updatedAt: api.clock.now(),
    },
  });
  const stale = await signInAsStaff(db, {
    roleKey: "finance",
    now: new Date(api.clock.now().getTime() - 600_001),
  });
  const body = { confirm: { billDate: day } },
    before = await snapshotTables(db, tables);
  await error(
    await request("admin.reconciliation.rerun", admin, { id: row.id, body, key: null }),
    400,
    "IDEMPOTENCY_KEY_REQUIRED",
  );
  await error(
    await request("admin.reconciliation.rerun", editor, { id: row.id, body }),
    403,
    "PERMISSION_DENIED",
  );
  await error(
    await request("admin.reconciliation.rerun", stale, { id: row.id, body }),
    403,
    "STEP_UP_REQUIRED",
  );
  await error(
    await request("admin.reconciliation.rerun", admin, {
      id: row.id,
      body: { confirm: { billDate: "2026-10-17" } },
    }),
    409,
    "CONFIRM_MISMATCH",
  );
  await error(
    await request("admin.reconciliation.rerun", admin, { id: row.id, body }),
    409,
    "RECON_BILL_NOT_READY",
  );
  expect(await snapshotTables(db, tables)).toEqual(before);

  const provider = api.runtime.providers.wechatPay as FakeWechatPay;
  provider.useWireFormat(identity);
  // 真实校验的零明细原件有七列汇总；它与missing返回有不同的可核证据。
  provider.setTradeBill(
    day,
    [
      "交易时间,公众账号ID,商户号,微信订单号,商户订单号,交易状态,货币种类,应结订单金额,微信退款单号,商户退款单号,退款金额,充值券退款金额,退款状态,商户数据包,手续费,费率,订单金额,申请退款金额",
      "总交易单数,应结订单总金额,退款总金额,充值券退款总金额,手续费总金额,订单总金额,申请退款总金额",
      "`0,`0.00,`0.00,`0.00,`0.00,`0.00,`0.00",
    ].join("\n"),
  );
  const job = api.runtime.assembly.recurringJob("bill.download");
  expect(job).toBeDefined();
  await job!.run({
    scheduledFor: api.clock.now(),
    signal: new AbortController().signal,
    runTx: (fn) => api.runtime.tx.run(fn),
  });
  const file = await db.wxBillFile.findUniqueOrThrow({
    where: {
      mchid_billDate_billType: { mchid: identity.mchid, billDate, billType: "trade_all" },
    },
  });
  expect(file).toMatchObject({ status: "parsed", isHashVerified: true, lineCount: 0 });
  expect(file.fileId).not.toBeNull();
  expect(file.sha1).toMatch(/^[0-9a-f]{40}$/);
  const prior = await db.reconDay.findUniqueOrThrow({ where: { id: row.id } });
  const key = uuidv7();
  const first = ReconDayRowSchema.parse(
    await data(await request("admin.reconciliation.rerun", admin, { id: row.id, body, key })),
  );
  expect(first).toMatchObject({ billDate: day, status: "ok", runCount: prior.runCount + 1 });
  const after = await snapshotTables(db, tables);
  const replay = ReconDayRowSchema.parse(
    await data(await request("admin.reconciliation.rerun", admin, { id: row.id, body, key })),
  );
  expect(replay).toEqual(first);
  expect(await snapshotTables(db, tables)).toEqual(after);
  await error(
    await request("admin.reconciliation.rerun", admin, {
      id: other.id,
      body: { confirm: { billDate: "2026-10-16" } },
      key,
    }),
    409,
    "IDEMPOTENCY_KEY_REUSED",
  );
  expect(await snapshotTables(db, tables)).toEqual(after);
  const second = ReconDayRowSchema.parse(
    await data(await request("admin.reconciliation.rerun", admin, { id: row.id, body })),
  );
  expect(second.runCount).toBe(first.runCount + 1);
}, 60_000);
