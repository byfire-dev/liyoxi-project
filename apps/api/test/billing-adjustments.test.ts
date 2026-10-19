import { afterAll, beforeAll, expect, it } from "vitest";
import { createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import {
  applyReceipt,
  createPaymentHarness,
  createFactories,
  pendingPlanOrder,
  signInAsStaff,
  snapshotTables,
  transferReceipt,
} from "@liyoxi/services/testing";
import {
  PointAccountDetailSchema,
  PointAccountPageSchema,
  PointAccountSummarySchema,
  AccountLedgerPageSchema,
  MerchantLedgerPageSchema,
  PointAdjustmentQuoteSchema,
  PointAdjustmentRequestDetailSchema,
  TermExtensionRequestDetailSchema,
  ExtensionQuoteSchema,
} from "@liyoxi/contract";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import { merchantServicesOf } from "../src/merchant/services.js";

const h = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof h.db.prisma>>,
  peer = 0;
const operations = [
  "m.pointLedgerEntry.list",
  "admin.pointAccount.adjustmentQuote",
  "admin.pointAccount.get",
  "admin.pointAccount.list",
  "admin.pointAccount.pointLedgerEntry.list",
  "admin.pointAccount.summary",
  "admin.pointAdjustmentRequest.create",
  "admin.pointAdjustmentRequest.get",
  "admin.pointAdjustmentRequest.approve",
  "admin.pointAdjustmentRequest.reject",
  "admin.pointAdjustmentRequest.withdraw",
  "admin.subscriptionTerm.extensionQuote",
  "admin.termExtensionRequest.create",
  "admin.termExtensionRequest.get",
  "admin.termExtensionRequest.approve",
  "admin.termExtensionRequest.reject",
  "admin.termExtensionRequest.withdraw",
] as const;
type Operation = (typeof operations)[number];
const seen = new Set<Operation>();
const businessTables = [
  "billing_account",
  "subscription_term",
  "subscription_event",
  "grant_schedule",
  "point_lot",
  "point_ledger_entry",
  "ledger_operation",
  "point_adjustment_request",
  "term_extension_request",
  "approval_request",
  "audit_log",
  "status_transition",
  "outbox_event",
];
function request(
  op: Operation,
  headers: Record<string, string>,
  options: { id?: string; query?: string; body?: unknown; key?: string | null } = {},
) {
  const mounted = api.api.mounted.find((r) => r.operationId === op);
  expect(mounted, op).toBeDefined();
  seen.add(op);
  const path = mounted!.path.replace(/\{[^}]+\}/, options.id ?? "") + (options.query ?? "");
  return api.request(path, {
    method: mounted!.method,
    headers: {
      ...headers,
      ...(mounted!.method === "POST" && options.key !== null
        ? { "Idempotency-Key": options.key ?? uuidv7() }
        : {}),
    },
    ...(options.body === undefined ? {} : { json: options.body }),
    peer: `198.19.88.${++peer % 250}`,
  });
}
async function data(r: Response): Promise<unknown> {
  expect(r.status, await r.clone().text()).toBe(200);
  return ((await r.json()) as { data: unknown }).data;
}
async function denied(r: Response, status: number, error: string) {
  expect(r.status, await r.clone().text()).toBe(status);
  expect(await r.json()).toMatchObject({ error });
}
async function buyer() {
  const owner = await signInAsMerchant(api, { headers: { "X-Client-Platform": "android" } });
  const scope = await merchantServicesOf(api.runtime).tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  const payment = createPaymentHarness(db, { clock: api.clock }),
    order = await pendingPlanOrder(payment, { entityId: scope.entityId });
  await applyReceipt(payment, await transferReceipt(payment, order));
  const term = await db.subscriptionTerm.findUniqueOrThrow({
    where: { sourceBillingOrderId: order.id },
  });
  const name = `W408-${scope.entityId}`;
  await db.entity.update({ where: { id: scope.entityId }, data: { name } });
  return { ...scope, owner, term, name };
}
const staff = (
  roleKey: "super_admin" | "finance" | "delivery_manager" | "editor" = "super_admin",
) => signInAsStaff(db, { roleKey, now: api.clock.now() });
const createBody = (entityId: string) => ({
  pointAccountId: entityId,
  direction: "increase",
  lotKind: "plan",
  adjustPoints: 100,
  reasonCode: "compensation",
  note: "交付延期真实补偿",
  confirm: { spendableBeforePoints: 6600 },
});
const pointApprove = (r: ReturnType<typeof PointAdjustmentRequestDetailSchema.parse>) => ({
  lockVersion: r.approval.lockVersion,
  confirm: { requestNo: r.requestNo, direction: r.direction, adjustPoints: r.adjustPoints },
  confirmChecks: ["basis_checked"],
});
const extendBody = (b: Awaited<ReturnType<typeof buyer>>) => ({
  subscriptionTermId: b.term.id,
  days: 7,
  reasonCode: "EX001",
  note: "制作延期补偿",
  confirm: { subscriptionTermId: b.term.id, endDate: b.term.endDate.toISOString().slice(0, 10) },
});
const extendApprove = (r: ReturnType<typeof TermExtensionRequestDetailSchema.parse>) => ({
  lockVersion: r.approval.lockVersion,
  confirm: { requestNo: r.requestNo, days: r.days },
  confirmChecks: ["effect_preview_checked"],
});
beforeAll(async () => {
  api = await h.start();
  db = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(h, api);
  await db.dictItem.create({
    data: {
      id: uuidv7(),
      dictTypeKey: "extend_reason",
      code: "EX001",
      name: "交付延期补偿",
      createdAt: api.clock.now(),
      updatedAt: api.clock.now(),
    },
  });
}, 60000);
afterAll(() => expect([...seen].sort()).toEqual([...operations].sort()));

it("17口真实接线第一片：账户五口和商家流水只读，提交积分零动账、二人通过与required同键重放", async () => {
  const b = await buyer(),
    author = await staff(),
    reviewer = await staff("finance");
  const before = await snapshotTables(db, businessTables);
  expect(
    PointAccountPageSchema.parse(
      await data(
        await request("admin.pointAccount.list", reviewer.headers, {
          query: `?q=${encodeURIComponent(b.name)}&page=1&pageSize=20`,
        }),
      ),
    ),
  ).toMatchObject({ page: 1, items: [{ pointAccountId: b.entityId }] });
  expect(
    PointAccountSummarySchema.parse(
      await data(await request("admin.pointAccount.summary", reviewer.headers)),
    ),
  ).toMatchObject({ activeAccountCount: 1 });
  expect(
    PointAccountDetailSchema.parse(
      await data(await request("admin.pointAccount.get", reviewer.headers, { id: b.entityId })),
    ),
  ).toMatchObject({ pointAccountId: b.entityId, spendablePoints: 6600 });
  expect(
    AccountLedgerPageSchema.parse(
      await data(
        await request("admin.pointAccount.pointLedgerEntry.list", reviewer.headers, {
          id: b.entityId,
        }),
      ),
    ),
  ).toMatchObject({ items: [{ opType: "grant", deltaPoints: 6600 }] });
  expect(
    MerchantLedgerPageSchema.parse(
      await data(await request("m.pointLedgerEntry.list", b.owner.withStore(b.storeId))),
    ),
  ).toMatchObject({ items: [{ opType: "grant", deltaPoints: 6600 }] });
  expect(
    PointAdjustmentQuoteSchema.parse(
      await data(
        await request("admin.pointAccount.adjustmentQuote", author.headers, {
          id: b.entityId,
          body: {
            direction: "increase",
            lotKind: "plan",
            adjustPoints: 100,
            reasonCode: "compensation",
          },
        }),
      ),
    ),
  ).toMatchObject({ isAllowed: true, spendableAfterPoints: 6700 });
  expect(await snapshotTables(db, businessTables)).toEqual(before);
  const p = PointAdjustmentRequestDetailSchema.parse(
    await data(
      await request("admin.pointAdjustmentRequest.create", author.headers, {
        body: createBody(b.entityId),
      }),
    ),
  );
  expect(p).toMatchObject({ applied: null, approval: { status: "pending" } });
  const pending = await snapshotTables(db, businessTables);
  expect(
    PointAdjustmentRequestDetailSchema.parse(
      await data(
        await request("admin.pointAdjustmentRequest.get", reviewer.headers, {
          id: p.pointAdjustmentRequestId,
        }),
      ),
    ),
  ).toMatchObject({ pointAdjustmentRequestId: p.pointAdjustmentRequestId });
  await denied(
    await request("admin.pointAdjustmentRequest.approve", author.headers, {
      id: p.pointAdjustmentRequestId,
      body: pointApprove(p),
    }),
    403,
    "APPROVAL_SELF_FORBIDDEN",
  );
  await denied(
    await request("admin.pointAdjustmentRequest.approve", reviewer.headers, {
      id: p.pointAdjustmentRequestId,
      body: { ...pointApprove(p), confirmChecks: ["basis_checked", "basis_checked"] },
    }),
    400,
    "VALIDATION_FAILED",
  );
  expect(await snapshotTables(db, businessTables)).toEqual(pending);
  const key = uuidv7(),
    body = pointApprove(p),
    approved = PointAdjustmentRequestDetailSchema.parse(
      await data(
        await request("admin.pointAdjustmentRequest.approve", reviewer.headers, {
          id: p.pointAdjustmentRequestId,
          body,
          key,
        }),
      ),
    );
  expect(approved).toMatchObject({
    approval: { status: "approved" },
    applied: { spendableAfterPoints: 6700 },
  });
  const done = await snapshotTables(db, businessTables),
    replay = await request("admin.pointAdjustmentRequest.approve", reviewer.headers, {
      id: p.pointAdjustmentRequestId,
      body,
      key,
    });
  expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
  expect(await data(replay)).toEqual(approved);
  expect(await snapshotTables(db, businessTables)).toEqual(done);
}, 60000);

it("延长预览/详情/通过及四个驳回撤回入口沿真实审批，全部无额外执行步骤", async () => {
  const b = await buyer(),
    author = await staff(),
    reviewer = await staff(),
    finance = await staff("finance");
  const quote = ExtensionQuoteSchema.parse(
    await data(
      await request("admin.subscriptionTerm.extensionQuote", author.headers, {
        id: b.term.id,
        body: { days: 7 },
      }),
    ),
  );
  expect(quote).toMatchObject({ blockReasons: [], mode: "extend", restorePoints: 0 });
  const e = TermExtensionRequestDetailSchema.parse(
    await data(
      await request("admin.termExtensionRequest.create", author.headers, { body: extendBody(b) }),
    ),
  );
  expect(
    TermExtensionRequestDetailSchema.parse(
      await data(
        await request("admin.termExtensionRequest.get", reviewer.headers, {
          id: e.termExtensionRequestId,
        }),
      ),
    ),
  ).toMatchObject({ applied: null });
  expect(
    TermExtensionRequestDetailSchema.parse(
      await data(
        await request("admin.termExtensionRequest.approve", reviewer.headers, {
          id: e.termExtensionRequestId,
          body: extendApprove(e),
        }),
      ),
    ),
  ).toMatchObject({
    approval: { status: "approved" },
    applied: { appliedMode: "extend", appliedSubscriptionTermId: b.term.id },
  });
  for (const action of ["reject", "withdraw"] as const) {
    const p = PointAdjustmentRequestDetailSchema.parse(
      await data(
        await request("admin.pointAdjustmentRequest.create", author.headers, {
          body: createBody(b.entityId),
        }),
      ),
    );
    const before = await snapshotTables(db, [
      "ledger_operation",
      "point_ledger_entry",
      "point_lot",
    ]);
    expect(
      PointAdjustmentRequestDetailSchema.parse(
        await data(
          await request(
            `admin.pointAdjustmentRequest.${action}`,
            action === "reject" ? finance.headers : author.headers,
            { id: p.pointAdjustmentRequestId, body: { note: "核实后取消本申请" } },
          ),
        ),
      ),
    ).toMatchObject({
      approval: { status: action === "reject" ? "rejected" : "withdrawn" },
      applied: null,
    });
    expect(
      await snapshotTables(db, ["ledger_operation", "point_ledger_entry", "point_lot"]),
    ).toEqual(before);
    const term = await db.subscriptionTerm.findUniqueOrThrow({ where: { id: b.term.id } }),
      extBody = {
        ...extendBody(b),
        confirm: { subscriptionTermId: term.id, endDate: term.endDate.toISOString().slice(0, 10) },
      };
    const next = TermExtensionRequestDetailSchema.parse(
      await data(
        await request("admin.termExtensionRequest.create", author.headers, { body: extBody }),
      ),
    );
    expect(
      TermExtensionRequestDetailSchema.parse(
        await data(
          await request(
            `admin.termExtensionRequest.${action}`,
            action === "reject" ? reviewer.headers : author.headers,
            { id: next.termExtensionRequestId, body: { note: "取消延长申请" } },
          ),
        ),
      ),
    ).toMatchObject({
      approval: { status: action === "reject" ? "rejected" : "withdrawn" },
      applied: null,
    });
    expect(
      await snapshotTables(db, ["ledger_operation", "point_ledger_entry", "point_lot"]),
    ).toEqual(before);
  }
}, 60000);

it("权限/主体scope/required键先于业务，过期stepup仅驳回跳过；商家不能借别店或店员读流水", async () => {
  const b = await buyer(),
    author = await staff(),
    finance = await signInAsStaff(db, {
      roleKey: "finance",
      now: new Date(api.clock.now().getTime() - 600001),
    }),
    editor = await staff("editor"),
    outside = await staff("delivery_manager");
  await denied(
    await request("admin.pointAccount.get", outside.headers, { id: b.entityId }),
    404,
    "NOT_FOUND",
  );
  await denied(
    await request("admin.pointAccount.get", editor.headers, { id: b.entityId }),
    403,
    "PERMISSION_DENIED",
  );
  await denied(
    await request("admin.pointAdjustmentRequest.create", author.headers, {
      body: createBody(b.entityId),
      key: null,
    }),
    400,
    "IDEMPOTENCY_KEY_REQUIRED",
  );
  const r = PointAdjustmentRequestDetailSchema.parse(
    await data(
      await request("admin.pointAdjustmentRequest.create", author.headers, {
        body: createBody(b.entityId),
      }),
    ),
  );
  const before = await snapshotTables(db, businessTables);
  await denied(
    await request("admin.pointAdjustmentRequest.approve", finance.headers, {
      id: r.pointAdjustmentRequestId,
      body: pointApprove(r),
    }),
    403,
    "STEP_UP_REQUIRED",
  );
  await denied(
    await request("admin.pointAdjustmentRequest.approve", editor.headers, {
      id: r.pointAdjustmentRequestId,
      body: pointApprove(r),
    }),
    403,
    "PERMISSION_DENIED",
  );
  expect(await snapshotTables(db, businessTables)).toEqual(before);
  expect(
    PointAdjustmentRequestDetailSchema.parse(
      await data(
        await request("admin.pointAdjustmentRequest.reject", finance.headers, {
          id: r.pointAdjustmentRequestId,
          body: { note: "依据不足驳回" },
        }),
      ),
    ),
  ).toMatchObject({ approval: { status: "rejected" } });
  const foreign = await signInAsMerchant(api);
  await denied(
    await request("m.pointLedgerEntry.list", foreign.withStore(b.storeId)),
    403,
    "NOT_A_MEMBER",
  );
  const make = createFactories({ db, clock: api.clock }),
    member = await make.entityMember({
      entityId: b.entityId,
      merchantUserId: foreign.merchantUserId,
      role: "clerk",
    });
  await make.storeMember({ entityId: b.entityId, entityMemberId: member.id, storeId: b.storeId });
  await denied(
    await request("m.pointLedgerEntry.list", foreign.withStore(b.storeId)),
    403,
    "ROLE_FORBIDDEN",
  );
}, 60000);
