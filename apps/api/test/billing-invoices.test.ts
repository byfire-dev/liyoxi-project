// W4-13：两组真实 HTTP；只验证本十六接口，资金前置经正式 applyPayment。
import { beforeAll, expect, it } from "vitest";
import {
  AdminInvoiceSummarySchema,
  FinanceConfigListSchema,
  FinanceConfigViewSchema,
  InvoiceDownloadSchema,
  InvoiceRequestAdminDetailSchema,
  InvoiceRequestAdminPageSchema,
  InvoiceRequestCardSchema,
  InvoiceRequestListSchema,
  InvoiceRequestSummarySchema,
} from "@liyoxi/contract";
import { runSeed, security, seedPlaceholderFinanceConfig, uuidv7 } from "@liyoxi/services";
import {
  applyReceipt,
  createFactories,
  createPaymentHarness,
  pendingPlanOrder,
  sealerOf,
  signInAsStaff,
  snapshotTables,
  transferReceipt,
} from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { DEFAULT_CONTROLS } from "@liyoxi/shared/purchase-policy";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";

const h = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof h.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  proposer: SignedInStaff,
  reviewer: SignedInStaff,
  editor: SignedInStaff,
  peer = 0;
const ids = [
  "m.invoiceRequest.create",
  "m.invoiceRequest.list",
  "m.invoiceRequest.summary",
  "m.invoiceRequest.downloadUrls",
  "admin.invoiceRequest.list",
  "admin.invoiceRequest.summary",
  "admin.invoiceRequest.get",
  "admin.invoiceRequest.issue",
  "admin.invoiceRequest.issueRed",
  "admin.invoiceRequest.reject",
  "admin.invoiceRequest.resend",
  "admin.financeConfigRevision.list",
  "admin.financeConfigRevision.create",
  "admin.financeConfigRevision.approve",
  "admin.financeConfigRevision.reject",
  "admin.financeConfigRevision.withdraw",
] as const;
type Operation = (typeof ids)[number];
function request(
  op: Operation,
  headers: Record<string, string>,
  options: { id?: string; query?: string; body?: unknown; key?: string | null } = {},
) {
  const route = api.api.mounted.find((row) => row.operationId === op);
  expect(route, op).toBeDefined();
  const path =
    route!.path.replace(/\{[^}]+\}/g, options.id ?? "") +
    (options.query ? `?${options.query}` : "");
  const key = options.key === undefined ? uuidv7() : options.key;
  return api.request(path, {
    method: route!.method,
    ...(options.body === undefined ? {} : { json: options.body }),
    headers: {
      ...headers,
      ...(route!.method !== "GET" && key !== null ? { "Idempotency-Key": key } : {}),
    },
    peer: `198.19.87.${++peer % 250}`,
  });
}
async function data(response: Response): Promise<unknown> {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as { data: unknown }).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
const tables = [
  "invoice_request",
  "invoice_doc",
  "file_ref",
  "status_transition",
  "audit_log",
  "outbox_event",
  "timer",
  "idempotency_record",
  "approval_request",
  "finance_config_revision",
];
beforeAll(async () => {
  api = await h.start();
  db = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(h, api);
  make = createFactories({
    db,
    clock: api.clock,
    seal: sealerOf(security.loadKeyring(api.runtime.env)),
  });
  proposer = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() });
  reviewer = await signInAsStaff(db, { roleKey: "finance", now: api.clock.now() });
  editor = await signInAsStaff(db, { roleKey: "editor", now: api.clock.now() });
  await seedPlaceholderFinanceConfig(
    {
      tx: api.runtime.tx,
      clock: api.clock,
      assembly: api.runtime.assembly,
      bizNo: api.runtime.bizNo,
      keyring: security.loadKeyring(api.runtime.env),
    },
    { proposerId: proposer.staff.id, approverId: reviewer.staff.id },
  );
  await db.paramValue.create({
    data: {
      id: uuidv7(),
      key: "invoice.item_name.plan_new",
      value: "测试开票项目",
      effectiveAt: api.clock.now(),
      createdAt: api.clock.now(),
      createdByStaffId: proposer.staff.id,
    },
  });
  api.clock.advance(1);
}, 60000);
async function buyer() {
  const user = await signInAsMerchant(api);
  const entity = await make.entity({
    createdByUserId: user.merchantUserId,
    verificationStatus: "verified",
  });
  const store = await make.store({
    entityId: entity.id,
    isPrimary: true,
    qualificationStatus: "verified",
  });
  await make.entityMember({
    entityId: entity.id,
    merchantUserId: user.merchantUserId,
    role: "owner",
    lastStoreId: store.id,
  });
  await make.billingAccount({ entityId: entity.id });
  return { user, entity, store, headers: user.withStore(store.id) };
}

it("发票十一HTTP通过真实身份、付款与开具，幂等/隔离/签名脱敏及GET零写", async () => {
  expect(
    api.api.mounted
      .filter((r) => ids.some((id) => id === r.operationId))
      .map((r) => r.operationId)
      .sort(),
  ).toEqual([...ids].sort());
  const own = await buyer(),
    other = await buyer();
  const pay = createPaymentHarness(db, { clock: api.clock });
  const order = await pendingPlanOrder(pay, { entityId: own.entity.id });
  const receipt = await transferReceipt(pay, order);
  await applyReceipt(pay, receipt);
  expect(await db.billingOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
    status: "paid",
    fulfillmentStatus: "done",
  });
  const body = {
    paymentOrderId: order.id,
    invoiceType: "normal",
    medium: "electronic",
    recvEmail: "invoice-private@example.invalid",
  };
  await error(
    await request("m.invoiceRequest.create", own.headers, { body, key: null }),
    400,
    "IDEMPOTENCY_KEY_REQUIRED",
  );
  const beforeForeign = await snapshotTables(db, tables);
  await error(await request("m.invoiceRequest.create", other.headers, { body }), 404, "NOT_FOUND");
  expect(await snapshotTables(db, tables)).toEqual(beforeForeign);
  const key = uuidv7();
  const first = InvoiceRequestCardSchema.parse(
    await data(await request("m.invoiceRequest.create", own.headers, { body, key })),
  );
  expect(first).toMatchObject({
    paymentOrderId: order.id,
    status: "pending",
    amountFen: order.amountFen,
    itemName: "测试开票项目",
    docs: [],
  });
  expect(JSON.stringify(first)).not.toContain(body.recvEmail);
  expect(await data(await request("m.invoiceRequest.create", own.headers, { body, key }))).toEqual(
    first,
  );
  expect(await db.invoiceRequest.count({ where: { billingOrderId: order.id } })).toBe(1);
  const reason = await db.dictItem.findFirstOrThrow({
    where: {
      dictTypeKey: "reject_reason",
      isEnabled: true,
      ext: { path: ["scene"], equals: "invoice" },
    },
  });
  const rejected = InvoiceRequestAdminDetailSchema.parse(
    await data(
      await request("admin.invoiceRequest.reject", reviewer.headers, {
        id: first.invoiceRequestId,
        body: { reasonCode: reason.code, note: "测试补正后重新申请" },
      }),
    ),
  );
  expect(rejected.status).toBe("rejected");
  const current = InvoiceRequestCardSchema.parse(
    await data(await request("m.invoiceRequest.create", own.headers, { body })),
  );
  expect(current.invoiceRequestId).not.toBe(first.invoiceRequestId);
  const readBefore = await snapshotTables(db, tables);
  const list = InvoiceRequestListSchema.parse(
    await data(await request("m.invoiceRequest.list", own.headers)),
  );
  expect(list.items.map((row) => row.invoiceRequestId)).toEqual(
    expect.arrayContaining([first.invoiceRequestId, current.invoiceRequestId]),
  );
  expect(
    InvoiceRequestSummarySchema.parse(
      await data(await request("m.invoiceRequest.summary", own.headers)),
    ).total,
  ).toBe(2);
  expect(
    InvoiceRequestListSchema.parse(
      await data(await request("m.invoiceRequest.list", other.headers)),
    ).items,
  ).toEqual([]);
  expect(
    InvoiceRequestAdminPageSchema.parse(
      await data(await request("admin.invoiceRequest.list", reviewer.headers)),
    ).items.some((row) => row.invoiceRequestId === current.invoiceRequestId),
  ).toBe(true);
  expect(
    AdminInvoiceSummarySchema.parse(
      await data(await request("admin.invoiceRequest.summary", reviewer.headers)),
    ).pending,
  ).toBeGreaterThan(0);
  const detail = InvoiceRequestAdminDetailSchema.parse(
    await data(
      await request("admin.invoiceRequest.get", reviewer.headers, { id: current.invoiceRequestId }),
    ),
  );
  expect(detail.status).toBe("pending");
  expect(JSON.stringify(detail)).not.toContain(body.recvEmail);
  expect(await snapshotTables(db, tables)).toEqual(readBefore);
  await error(
    await request("admin.invoiceRequest.get", editor.headers, { id: current.invoiceRequestId }),
    403,
    "PERMISSION_DENIED",
  );
  const file = await make.fileObject({
    category: "invoice",
    bucket: "secure",
    scopeType: "entity",
    entityId: own.entity.id,
    storeId: null,
    uploadActorType: "staff",
    uploadActorId: reviewer.staff.id,
    uploadClient: "admin",
    ext: "pdf",
    mime: "application/pdf",
    declaredMime: "application/pdf",
  });
  const issue = {
    invoiceNo: "12345678901234567890",
    fileId: file.id,
    confirm: { requestNo: current.requestNo, amountFen: current.amountFen },
  };
  const failedBefore = await snapshotTables(db, tables);
  await error(
    await request("admin.invoiceRequest.issue", reviewer.headers, {
      id: current.invoiceRequestId,
      body: { ...issue, confirm: { ...issue.confirm, amountFen: 1 } },
    }),
    409,
    "CONFIRM_MISMATCH",
  );
  expect(await snapshotTables(db, tables)).toEqual(failedBefore);
  const issueKey = uuidv7();
  const issued = InvoiceRequestAdminDetailSchema.parse(
    await data(
      await request("admin.invoiceRequest.issue", reviewer.headers, {
        id: current.invoiceRequestId,
        body: issue,
        key: issueKey,
      }),
    ),
  );
  expect(issued).toMatchObject({
    status: "issued",
    docs: [{ docKind: "blue", invoiceNo: issue.invoiceNo, emailState: "queued", hasFile: true }],
  });
  expect(
    await data(
      await request("admin.invoiceRequest.issue", reviewer.headers, {
        id: current.invoiceRequestId,
        body: issue,
        key: issueKey,
      }),
    ),
  ).toEqual(issued);
  const downloadKey = uuidv7();
  const signed = InvoiceDownloadSchema.parse(
    await data(
      await request("m.invoiceRequest.downloadUrls", own.headers, {
        id: current.invoiceRequestId,
        body: { docKind: "blue" },
        key: downloadKey,
      }),
    ),
  );
  expect(Date.parse(signed.expiresAt) - api.clock.now().getTime()).toBe(300000);
  expect(signed.fileFormat).toBe("pdf");
  expect(signed.url).not.toContain(body.recvEmail);
  api.clock.advance(1000);
  const fresh = InvoiceDownloadSchema.parse(
    await data(
      await request("m.invoiceRequest.downloadUrls", own.headers, {
        id: current.invoiceRequestId,
        body: { docKind: "blue" },
        key: downloadKey,
      }),
    ),
  );
  expect(Date.parse(fresh.expiresAt) - Date.parse(signed.expiresAt)).toBe(1000);
  expect(await db.idempotencyRecord.count({ where: { key: downloadKey } })).toBe(0);
  const foreignBefore = await snapshotTables(db, tables);
  await error(
    await request("m.invoiceRequest.downloadUrls", other.headers, {
      id: current.invoiceRequestId,
      body: { docKind: "blue" },
    }),
    404,
    "NOT_FOUND",
  );
  expect(await snapshotTables(db, tables)).toEqual(foreignBefore);
  // 未发生退款审批或投递失败时，两入口必须拒绝，不能靠HTTP跳过真实业务前置。
  await error(
    await request("admin.invoiceRequest.issueRed", reviewer.headers, {
      id: current.invoiceRequestId,
      body: {
        invoiceNo: "12345678901234567891",
        fileId: file.id,
        redReason: "测试",
        confirm: {
          requestNo: current.requestNo,
          blueInvoiceNo: issue.invoiceNo,
          amountFen: current.amountFen,
        },
      },
    }),
    409,
    "STATE_NOT_ALLOWED",
  );
  await error(
    await request("admin.invoiceRequest.resend", reviewer.headers, {
      id: current.invoiceRequestId,
    }),
    409,
    "STATE_NOT_ALLOWED",
  );
  const clerk = await signInAsMerchant(api);
  const clerkMember = await make.entityMember({
    entityId: own.entity.id,
    merchantUserId: clerk.merchantUserId,
    role: "clerk",
    lastStoreId: own.store.id,
  });
  await make.storeMember({ storeId: own.store.id, entityMemberId: clerkMember.id });
  await error(
    await request("m.invoiceRequest.list", clerk.withStore(own.store.id)),
    403,
    "ROLE_FORBIDDEN",
  );
}, 30000);

it("财务五HTTP真实双人审批、版本确认、驳回撤回及敏感配置不出明文", async () => {
  const current = FinanceConfigListSchema.parse(
    await data(await request("admin.financeConfigRevision.list", proposer.headers)),
  );
  const base = current.items.find(
    (row) => row.configKey === "controls" && row.state === "effective",
  );
  const body = {
    configKey: "controls",
    payload: { ...DEFAULT_CONTROLS, adminCreateOrder: true },
    changeNote: "测试内控变更",
    confirm: { configKey: "controls", baseRevisionId: base?.financeConfigRevisionId ?? null },
  };
  await error(
    await request("admin.financeConfigRevision.list", editor.headers),
    403,
    "PERMISSION_DENIED",
  );
  await error(
    await request("admin.financeConfigRevision.create", proposer.headers, { body, key: null }),
    400,
    "IDEMPOTENCY_KEY_REQUIRED",
  );
  const key = uuidv7();
  const proposal = FinanceConfigViewSchema.parse(
    await data(
      await request("admin.financeConfigRevision.create", proposer.headers, { body, key }),
    ),
  );
  expect(proposal.state).toBe("pending");
  expect(
    await data(
      await request("admin.financeConfigRevision.create", proposer.headers, { body, key }),
    ),
  ).toEqual(proposal);
  const decision = {
    lockVersion: proposal.approval.lockVersion,
    confirmChecks: ["change_reviewed"],
    confirm: { configKey: "controls", financeConfigRevisionId: proposal.financeConfigRevisionId },
  };
  await error(
    await request("admin.financeConfigRevision.approve", proposer.headers, {
      id: proposal.financeConfigRevisionId,
      body: decision,
    }),
    403,
    "APPROVAL_SELF_FORBIDDEN",
  );
  await error(
    await request("admin.financeConfigRevision.approve", reviewer.headers, {
      id: proposal.financeConfigRevisionId,
      body: { ...decision, lockVersion: decision.lockVersion + 1 },
    }),
    409,
    "VERSION_CONFLICT",
  );
  const approveKey = uuidv7();
  const approved = FinanceConfigViewSchema.parse(
    await data(
      await request("admin.financeConfigRevision.approve", reviewer.headers, {
        id: proposal.financeConfigRevisionId,
        body: decision,
        key: approveKey,
      }),
    ),
  );
  expect(approved.state).toBe("effective");
  expect(
    await data(
      await request("admin.financeConfigRevision.approve", reviewer.headers, {
        id: proposal.financeConfigRevisionId,
        body: decision,
        key: approveKey,
      }),
    ),
  ).toEqual(approved);
  const bank = current.items.find(
    (row) => row.configKey === "bank_account" && row.state === "effective",
  );
  const bankBody = {
    configKey: "bank_account",
    payload: {
      accountName: "测试财务账户",
      bankName: "测试银行",
      accountNo: "6222021234567890123",
    },
    changeNote: "测试待审银行信息",
    confirm: { configKey: "bank_account", baseRevisionId: bank?.financeConfigRevisionId ?? null },
  };
  const bankProposal = FinanceConfigViewSchema.parse(
    await data(
      await request("admin.financeConfigRevision.create", proposer.headers, { body: bankBody }),
    ),
  );
  expect(JSON.stringify(bankProposal)).not.toContain(bankBody.payload.accountNo);
  const rejected = FinanceConfigViewSchema.parse(
    await data(
      await request("admin.financeConfigRevision.reject", reviewer.headers, {
        id: bankProposal.financeConfigRevisionId,
        body: { note: "测试驳回" },
      }),
    ),
  );
  expect(rejected.state).toBe("rejected");
  const retry = FinanceConfigViewSchema.parse(
    await data(
      await request("admin.financeConfigRevision.create", proposer.headers, { body: bankBody }),
    ),
  );
  const withdrawn = FinanceConfigViewSchema.parse(
    await data(
      await request("admin.financeConfigRevision.withdraw", proposer.headers, {
        id: retry.financeConfigRevisionId,
        body: { note: "测试主动撤回" },
      }),
    ),
  );
  expect(withdrawn.state).toBe("withdrawn");
  const before = await snapshotTables(db, tables);
  const history = FinanceConfigListSchema.parse(
    await data(
      await request("admin.financeConfigRevision.list", reviewer.headers, { query: "tab=history" }),
    ),
  );
  expect(history.items.map((row) => row.financeConfigRevisionId)).toEqual(
    expect.arrayContaining([
      proposal.financeConfigRevisionId,
      bankProposal.financeConfigRevisionId,
      retry.financeConfigRevisionId,
    ]),
  );
  expect(JSON.stringify(history)).not.toContain(bankBody.payload.accountNo);
  expect(await snapshotTables(db, tables)).toEqual(before);
}, 30000);
