import { beforeAll, describe, expect, it } from "vitest";
import { CancelQuoteSchema, CancelRequestDetailSchema } from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import {
  createFactories,
  prepareOrderFixture,
  signInAsStaff,
  snapshotTables,
} from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { HANDLERS } from "../src/routes/index.js";

const h = useTestApi();
let api: TestApi,
  prisma: Awaited<ReturnType<typeof h.db.prisma>>,
  requester: SignedInStaff,
  denied: SignedInStaff,
  customerService: SignedInStaff,
  adId: string,
  ticketId: string,
  holdId: string;
let peer = 0;
const request = (path: string, json: unknown, who = requester, key = uuidv7()) =>
  api.request(`/api/v1/admin${path}`, {
    method: "POST",
    json,
    headers: { ...who.headers, "Idempotency-Key": key },
    peer: `198.19.108.${++peer % 250}`,
  });
async function data(r: Response) {
  expect(r.status, await r.clone().text()).toBe(200);
  expect(r.headers.get("Cache-Control")).toBe("no-store");
  return ((await r.json()) as { data: unknown }).data;
}
async function fail(r: Response, status: number, error: string) {
  expect(r.status, await r.clone().text()).toBe(status);
  expect(await r.json()).toMatchObject({ error });
}
const money = [
  "billing_account",
  "point_lot",
  "point_hold",
  "point_hold_alloc",
  "ledger_operation",
  "point_ledger_entry",
];

beforeAll(async () => {
  api = await h.start();
  prisma = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  requester = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  denied = await signInAsStaff(prisma, { roleKey: "editor", now: api.clock.now() });
  customerService = await signInAsStaff(prisma, { roleKey: "cs", now: api.clock.now() });
  const make = createFactories({ db: prisma, clock: api.clock }),
    m = await make.merchant();
  const fixture = await prepareOrderFixture(prisma, api.runtime, api.clock, {
    entityId: m.entity.id,
    storeId: m.store.id,
    memberId: m.owner.id,
    merchantUserId: m.user.id,
  });
  await make.agreementVersion({ agreementKey: "ad_service" });
  const promo = await prisma.dictItem.findFirstOrThrow({
      where: { dictTypeKey: "ad_promo_point", isEnabled: true },
    }),
    quote = await api.runtime.ads.quote(fixture.actor, { type: "opening" }),
    option = quote.typeOptions.find((value) => value.type === "opening")!;
  const created = await api.runtime.ads.create(fixture.actor, {
    type: "opening",
    durationSec: option.durationOptions[0]!,
    promoPointCodes: [promo.code],
    expectChargePoints: quote.chargePoints!,
    agreementVersionId: quote.agreement.agreementVersionId,
    isAgreementChecked: true,
  });
  adId = created.adId;
  holdId = (await prisma.ad.findUniqueOrThrow({ where: { id: adId } })).pointHoldId;
  const now = api.clock.now();
  const ticket = await prisma.serviceTicket.create({
    data: {
      id: uuidv7(),
      ticketNo: "KF2026010500808",
      entityId: m.entity.id,
      storeId: m.store.id,
      source: "weapp",
      submitterUserId: m.user.id,
      typeCode: "K01",
      priority: "mid",
      description: "广告取消引用前置客服工单",
      status: "pending",
      solutionDueAt: new Date(now.getTime() + 86_400_000),
      slaSnapshot: { solution: {} },
      createdAt: now,
      updatedAt: now,
    },
  });
  ticketId = ticket.id;
}, 120_000);

describe("W5-08 广告取消两条真实HTTP", { timeout: 60_000 }, () => {
  it("真实挂载、试算零写、角色和不存在对象拒绝及坏客服引用整TX回滚", async () => {
    for (const operationId of ["admin.ad.cancelQuote", "admin.ad.cancelRequest.create"])
      expect(HANDLERS.some((handler) => handler.route.operationId === operationId)).toBe(true);
    const before = await snapshotTables(prisma, [
        ...money,
        "ad",
        "cancel_request",
        "cancel_request_line",
        "approval_request",
        "service_ticket_ref",
      ]),
      quote = CancelQuoteSchema.parse(
        await data(await request(`/ads/${adId}/cancel-quote`, { reasonCode: "merchant_request" })),
      );
    expect(quote.lines).toHaveLength(1);
    expect(quote.lines[0]).toMatchObject({ targetType: "ad", targetId: adId, mode: "release" });
    await fail(
      await request(`/ads/${adId}/cancel-quote`, { reasonCode: "merchant_request" }, denied),
      403,
      "PERMISSION_DENIED",
    );
    expect(
      CancelQuoteSchema.parse(
        await data(
          await request(
            `/ads/${adId}/cancel-quote`,
            { reasonCode: "merchant_request" },
            customerService,
          ),
        ),
      ).totalRefundPoints,
    ).toBe(quote.totalRefundPoints);
    await fail(
      await request(
        `/ads/${uuidv7()}/cancel-quote`,
        { reasonCode: "merchant_request" },
        customerService,
      ),
      404,
      "NOT_FOUND",
    );
    await fail(
      await request(`/ads/${adId}/cancel-requests`, {
        reasonCode: "merchant_request",
        note: "不合法客服关联应回滚",
        expect: quote.expect,
        serviceTicketId: uuidv7(),
      }),
      404,
      "NOT_FOUND",
    );
    expect(
      await snapshotTables(prisma, [
        ...money,
        "ad",
        "cancel_request",
        "cancel_request_line",
        "approval_request",
        "service_ticket_ref",
      ]),
    ).toEqual(before);
  });
  it("原申请链读回真实客服关联与冻结预览，同key零重复", async () => {
    const quote = CancelQuoteSchema.parse(
        await data(await request(`/ads/${adId}/cancel-quote`, { reasonCode: "merchant_request" })),
      ),
      body = {
        reasonCode: "merchant_request",
        note: "老板申请取消未开工广告",
        expect: quote.expect,
        serviceTicketId: ticketId,
      },
      key = uuidv7();
    const detail = CancelRequestDetailSchema.parse(
      await data(await request(`/ads/${adId}/cancel-requests`, body, requester, key)),
    );
    expect(detail).toMatchObject({ kind: "ad_cancel", totalRefundPoints: quote.totalRefundPoints });
    expect(detail.serviceTickets).toEqual(
      expect.arrayContaining([expect.objectContaining({ serviceTicketId: ticketId })]),
    );
    expect(
      await prisma.serviceTicketRef.count({
        where: {
          serviceTicketId: ticketId,
          refType: "approval_request",
          refId: detail.approval.approvalId,
        },
      }),
    ).toBe(1);
    const actual = await prisma.ad.findUniqueOrThrow({ where: { id: adId } }),
      hold = await prisma.pointHold.findUniqueOrThrow({ where: { id: holdId } });
    expect(detail.status).toBe("pending_approval");
    expect(actual.openCancelRequestId).toBe(detail.cancelRequestId);
    expect(hold).toMatchObject({ status: "held", qty: quote.totalRefundPoints, returnedQty: 0 });
    const before = await snapshotTables(prisma, [
      ...money,
      "ad",
      "cancel_request",
      "cancel_request_line",
      "service_ticket_ref",
    ]);
    expect(
      CancelRequestDetailSchema.parse(
        await data(await request(`/ads/${adId}/cancel-requests`, body, requester, key)),
      ).cancelRequestId,
    ).toBe(detail.cancelRequestId);
    expect(
      await snapshotTables(prisma, [
        ...money,
        "ad",
        "cancel_request",
        "cancel_request_line",
        "service_ticket_ref",
      ]),
    ).toEqual(before);
  });
});
