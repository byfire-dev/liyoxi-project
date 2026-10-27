import { beforeAll, expect, it } from "vitest";
import { PaymentExceptionDetailSchema, PaymentExceptionPageSchema } from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import {
  createFactories,
  createPaymentHarness,
  pendingPlanOrder,
  signInAsStaff,
  snapshotTables,
} from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof handle.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  admin: SignedInStaff;
let peer = 0;
type Operation =
  | "admin.paymentException.create"
  | "admin.paymentException.get"
  | "admin.paymentException.list"
  | "admin.paymentException.resolve";
function request(
  op: Operation,
  who: SignedInStaff,
  options: { id?: string; body?: unknown; key?: string | null; query?: string } = {},
) {
  const route = api.api.mounted.find((r) => r.operationId === op);
  expect(route).toBeDefined();
  return api.request(
    route!.path.replace(/\{[^}]+\}/g, options.id ?? "") +
      (options.query ? `?${options.query}` : ""),
    {
      method: route!.method,
      headers: {
        ...who.headers,
        ...(route!.method !== "GET" && options.key !== null
          ? { "Idempotency-Key": options.key ?? uuidv7() }
          : {}),
      },
      ...(options.body === undefined ? {} : { json: options.body }),
      peer: `198.19.77.${++peer % 250}`,
    },
  );
}
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: unknown }).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
const tables = [
  "billing_order",
  "payment_txn",
  "payment_exception",
  "refund_request",
  "refund_txn",
  "approval_request",
  "status_transition",
  "outbox_event",
  "ledger_operation",
  "point_ledger_entry",
];
beforeAll(async () => {
  api = await handle.start();
  db = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  make = createFactories({ db, clock: api.clock });
  admin = await signInAsStaff(db, { roleKey: "super_admin", now: api.clock.now() });
}, 60_000);
function creation(amount: number, serial: string, payer: string) {
  return {
    receivedAt: api.clock.now().toISOString(),
    amountFen: amount,
    payerName: payer,
    bankSerialNo: serial,
    note: "HTTP隔离到账核对",
    confirm: { amountFen: amount, bankSerialNo: serial },
  };
}
it("4typed入口经过真实鉴权/幂等/handler/DB；合法关联真实履约，同键冻结与C50生效", async () => {
  const own = await make.merchant({ verified: true }),
    h = createPaymentHarness(db, { clock: api.clock }),
    order = await pendingPlanOrder(h, {
      entityId: own.entity.id,
      channel: "bank_transfer",
      status: "pending_payment",
    }),
    input = creation(order.amountFen, "W411-HTTP-0001", own.entity.name!);
  const missing = await request("admin.paymentException.create", admin, { body: input, key: null });
  await error(missing, 400, "IDEMPOTENCY_KEY_REQUIRED");
  const key = uuidv7(),
    created = PaymentExceptionDetailSchema.parse(
      await data(await request("admin.paymentException.create", admin, { body: input, key })),
    );
  const replay = PaymentExceptionDetailSchema.parse(
    await data(await request("admin.paymentException.create", admin, { body: input, key })),
  );
  expect(replay).toEqual(created);
  await error(
    await request("admin.paymentException.create", admin, {
      body: { ...input, note: "不同意图不能复用同一幂等键" },
      key,
    }),
    409,
    "IDEMPOTENCY_KEY_REUSED",
  );
  expect(
    PaymentExceptionDetailSchema.parse(
      await data(
        await request("admin.paymentException.get", admin, { id: created.paymentExceptionId }),
      ),
    ),
  ).toEqual(created);
  const page = PaymentExceptionPageSchema.parse(
    await data(
      await request("admin.paymentException.list", admin, {
        query: `kind=bank_unmatched&q=${created.exceptionNo}`,
      }),
    ),
  );
  expect(page.items.map((r) => r.paymentExceptionId)).toEqual([created.paymentExceptionId]);
  const resolve = {
    lockVersion: created.lockVersion,
    resolution: "link_order",
    linkPaymentOrderId: order.id,
    note: "HTTP已核对原付款单",
    confirm: { exceptionNo: created.exceptionNo, amountFen: created.amountFen },
  };
  const before = await snapshotTables(db, tables);
  await error(
    await request("admin.paymentException.resolve", admin, {
      id: created.paymentExceptionId,
      body: { ...resolve, lockVersion: created.lockVersion + 1 },
    }),
    409,
    "VERSION_CONFLICT",
  );
  await error(
    await request("admin.paymentException.resolve", admin, {
      id: created.paymentExceptionId,
      body: { ...resolve, confirm: { ...resolve.confirm, amountFen: created.amountFen + 1 } },
    }),
    409,
    "CONFIRM_MISMATCH",
  );
  expect(await snapshotTables(db, tables)).toEqual(before);
  const resolved = PaymentExceptionDetailSchema.parse(
    await data(
      await request("admin.paymentException.resolve", admin, {
        id: created.paymentExceptionId,
        body: resolve,
      }),
    ),
  );
  expect(resolved).toMatchObject({
    status: "resolved",
    resolution: "link_order",
    entity: { entityId: own.entity.id },
  });
  expect(await db.billingOrder.findUnique({ where: { id: order.id } })).toMatchObject({
    status: "paid",
    fulfillmentStatus: "done",
  });
  expect(
    await db.paymentTxn.count({ where: { outTradeNo: { startsWith: `${created.exceptionNo}-` } } }),
  ).toBe(1);
  expect(
    PaymentExceptionDetailSchema.parse(
      await data(
        await request("admin.paymentException.get", admin, { id: created.paymentExceptionId }),
      ),
    ),
  ).toMatchObject({ status: "resolved" });
});
it("普通角色/过期stepup/范围外与非法矩阵失败零业务写；孤儿事实不向本人范围泄露", async () => {
  const finance = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() }),
    editor = await signInAsStaff(db, { roleKey: "editor", now: api.clock.now() }),
    stale = await signInAsStaff(db, {
      roleKey: "finance",
      now: new Date(api.clock.now().getTime() - 600001),
    });
  const input = creation(12300, "W411-HTTP-ACL", "公开隔离户名"),
    before = await snapshotTables(db, tables);
  await error(
    await request("admin.paymentException.create", editor, { body: input }),
    403,
    "PERMISSION_DENIED",
  );
  await error(
    await request("admin.paymentException.create", stale, { body: input }),
    403,
    "STEP_UP_REQUIRED",
  );
  expect(await snapshotTables(db, tables)).toEqual(before);
  const created = PaymentExceptionDetailSchema.parse(
    await data(await request("admin.paymentException.create", admin, { body: input })),
  );
  const illegal = {
      lockVersion: created.lockVersion,
      resolution: "written_off",
      note: "普通财务不得核销",
      confirm: { exceptionNo: created.exceptionNo, amountFen: created.amountFen },
    },
    stable = await snapshotTables(db, tables);
  await error(
    await request("admin.paymentException.resolve", finance, {
      id: created.paymentExceptionId,
      body: illegal,
    }),
    403,
    "PERMISSION_DENIED",
  );
  await error(
    await request("admin.paymentException.resolve", admin, {
      id: created.paymentExceptionId,
      body: { ...illegal, resolution: "corrected" },
    }),
    409,
    "RESOLUTION_NOT_ALLOWED",
  );
  expect(await snapshotTables(db, tables)).toEqual(stable);
  // 仅测试角色夹具切为合法own范围，权限不变；请求仍通过生产authenticate生成带品牌的scope。
  await db.staffRole.update({ where: { key: "finance" }, data: { dataScope: "own" } });
  api.runtime.staffAuth.roles.invalidate();
  const restricted = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() });
  await error(
    await request("admin.paymentException.get", restricted, { id: created.paymentExceptionId }),
    404,
    "NOT_FOUND",
  );
  const page = PaymentExceptionPageSchema.parse(
    await data(
      await request("admin.paymentException.list", restricted, {
        query: `q=${created.exceptionNo}`,
      }),
    ),
  );
  expect(page.items).toEqual([]);
  expect(await snapshotTables(db, tables)).toEqual(stable);
});
