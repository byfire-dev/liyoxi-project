import { beforeAll, describe, it, expect } from "vitest";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import {
  createIdentityContext,
  createTickets,
  prepareTicketAssignees,
  createSla,
  runSeed,
  uuidv7,
} from "@liyoxi/services";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";
const handle = useTestApi();
let api: TestApi,
  owner: SignedInMerchant,
  clerk: SignedInMerchant,
  stranger: SignedInMerchant,
  admin: SignedInStaff,
  limited: SignedInStaff;
let prisma: Awaited<ReturnType<typeof handle.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  storeId: string,
  entityId: string,
  planId: string,
  ticketId: string,
  itemId: string,
  accountId: string,
  managerId: string,
  peer = 0;
const routes = [
  ["admin.deliveryTicket.list", "GET", "/admin/delivery-tickets"],
  ["admin.deliveryTicket.summary", "GET", "/admin/delivery-tickets/summary"],
  ["admin.deliveryTicket.get", "GET", "/admin/delivery-tickets/:ticket"],
  ["admin.deliveryTicket.assignManager", "POST", "/admin/delivery-tickets/:ticket/assign-manager"],
  ["admin.deliveryPlan.get", "GET", "/admin/delivery-plans/:plan"],
  ["admin.deliveryPlan.draft.replace", "PUT", "/admin/delivery-plans/:plan/draft"],
  ["admin.deliveryPlan.push", "POST", "/admin/delivery-plans/:plan/push"],
  ["m.deliveryPlan.get", "GET", "/m/delivery-plans/:plan"],
  ["m.deliveryPlan.confirm", "POST", "/m/delivery-plans/:plan/confirm"],
  ["m.deliveryPlan.requestChange", "POST", "/m/delivery-plans/:plan/request-change"],
] as const;
async function request(
  op: (typeof routes)[number][0],
  json?: unknown,
  headers?: Record<string, string>,
  key = uuidv7(),
) {
  const [, method, path] = routes.find((r) => r[0] === op)!;
  return api.request(`/api/v1${path.replace(":ticket", ticketId).replace(":plan", planId)}`, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: {
      ...(headers ?? (op.startsWith("admin.") ? admin.headers : owner.withStore(storeId))),
      "Idempotency-Key": key,
    },
    peer: `198.19.116.${++peer}`,
  });
}
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}
beforeAll(async () => {
  api = await handle.start();
  prisma = await handle.db.prisma();
  make = createFactories({ db: prisma, clock: api.clock });
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  owner = await signInAsMerchant(api);
  clerk = await signInAsMerchant(api);
  stranger = await signInAsMerchant(api);
  admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  limited = await signInAsStaff(prisma, { roleKey: "publisher", now: api.clock.now() });
  const entity = await make.entity({
      createdByUserId: owner.merchantUserId,
      verificationStatus: "verified",
    }),
    store = await make.store({
      entityId: entity.id,
      isPrimary: true,
      qualificationStatus: "verified",
    }),
    member = await make.entityMember({
      entityId: entity.id,
      merchantUserId: owner.merchantUserId,
      role: "owner",
    });
  entityId = entity.id;
  storeId = store.id;
  const clerkMember = await make.entityMember({ entityId, merchantUserId: clerk.merchantUserId });
  await make.storeMember({ entityMemberId: clerkMember.id, storeId, addedByMemberId: member.id });
  const poster = await make.fileObject();
  const order = await make.dramaOrder({ entityId, storeId, status: "producing" }),
    item = await make.orderItem({
      dramaOrderId: order.id,
      phase: "producing",
      dramaSnapshot: { title: "接口测试剧", posterFileId: poster.id },
    });
  itemId = item.id;
  const r = api.runtime,
    created = await r.tx.run(async (tx) => {
      await prepareTicketAssignees(tx, order.id);
      return createTickets(
        tx,
        {
          tx: r.tx,
          clock: r.clock,
          assembly: r.assembly,
          flow: r.flow,
          events: r.events,
          sla: createSla({ clock: r.clock, assembly: r.assembly }),
        },
        createIdentityContext({
          actor: { type: "system", job: "lyxtest.api_seed" },
          entityId,
          storeId,
        }),
        { dramaOrderId: order.id },
      );
    });
  planId = created.deliveryPlanId;
  ticketId = created.deliveryTicketIds[0]!;
  managerId = (await make.staff({ staffRoleKey: "delivery_manager" })).id;
  await prisma.dictItem.create({
    data: {
      id: uuidv7(),
      dictTypeKey: "custom_focus",
      code: "CF01",
      name: "测试定制重点",
      isEnabled: true,
      position: 1,
      createdAt: r.clock.now(),
      updatedAt: r.clock.now(),
    },
  });
  // 账号事实走真实绑定与核验 API，避免把 available 伪装成无审批的夹具。
  const file = await make.fileObject({
    category: "channel_screenshot",
    bucket: "asset",
    scopeType: "store",
    entityId,
    storeId,
    uploadActorType: "merchant",
    uploadActorId: owner.merchantUserId,
    uploadClient: "weapp",
  });
  const bound = await data(
    await api.request("/api/v1/m/channel-accounts", {
      method: "POST",
      json: {
        platform: "douyin",
        accountName: "接口测试号",
        accountUid: uuidv7(),
        accountType: "none",
        screenshotFileIds: [file.id],
      },
      headers: { ...owner.withStore(storeId), "Idempotency-Key": uuidv7() },
      peer: `198.19.116.${++peer}`,
    }),
  );
  accountId = bound.channelAccountId as string;
  const sub = await prisma.channelAccountSubmission.findFirstOrThrow({
      where: { channelAccountId: accountId },
      include: { approvalRequest: true },
    }),
    checklist = await prisma.checklistTemplate.findFirstOrThrow({
      where: { code: "account.verify", status: "active" },
    });
  const { COMPARE_FIELDS, ChecklistItemsSchema } = await import("@liyoxi/contract");
  await data(
    await api.request(`/api/v1/admin/channel-account-submissions/${sub.id}/approve`, {
      method: "POST",
      json: {
        lockVersion: sub.approvalRequest.lockVersion,
        confirm: {
          roundNo: sub.roundNo,
          accountUid: (await prisma.channelAccount.findUniqueOrThrow({ where: { id: accountId } }))
            .accountUid,
        },
        accountType: "none",
        certSubjectName: null,
        compareRows: COMPARE_FIELDS.map((field) => ({ field, recognized: null, match: true })),
        checklistVersionNo: checklist.versionNo,
        results: ChecklistItemsSchema.parse(checklist.items).map((i) => ({
          key: i.key,
          result: "pass",
        })),
      },
      headers: { ...admin.headers, "Idempotency-Key": uuidv7() },
      peer: `198.19.116.${++peer}`,
    }),
  );
}, 180000);
describe("delivery PR1 十个真实 HTTP 入口", { timeout: 60000 }, () => {
  it("十条声明均挂载；普通、静态 summary 与签名读 no-store；店员三条 403、跨店无关系 404", async () => {
    for (const [id] of routes)
      expect(
        HANDLERS.some((h) => h.route.operationId === id),
        id,
      ).toBe(true);
    for (const op of [
      "admin.deliveryTicket.list",
      "admin.deliveryTicket.summary",
      "admin.deliveryTicket.get",
      "admin.deliveryPlan.get",
      "m.deliveryPlan.get",
    ] as const) {
      const response = await request(op);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const result = await data(response);
      if (op === "admin.deliveryTicket.get")
        expect(result.orderItem).toMatchObject({ ticket: { deliveryTicketId: ticketId } });
    }
    for (const [op, json] of [
      ["m.deliveryPlan.get", undefined],
      ["m.deliveryPlan.confirm", { versionNo: 1 }],
      ["m.deliveryPlan.requestChange", { kinds: ["other"], note: "调整" }],
    ] as const)
      expect((await request(op, json, clerk.withStore(storeId))).status).toBe(403);
    const other = await make.entity({
        createdByUserId: stranger.merchantUserId,
        verificationStatus: "verified",
      }),
      store = await make.store({
        entityId: other.id,
        isPrimary: true,
        qualificationStatus: "verified",
      });
    await make.entityMember({
      entityId: other.id,
      merchantUserId: stranger.merchantUserId,
      role: "owner",
    });
    expect(
      (await request("m.deliveryPlan.get", undefined, stranger.withStore(store.id))).status,
    ).toBe(404);
    expect((await request("admin.deliveryTicket.get", undefined, limited.headers)).status).toBe(
      404,
    );
    expect((await request("admin.deliveryPlan.get", undefined, limited.headers)).status).toBe(404);
  });
  it("assign/draft/push/requestChange 真实落库与回放；confirm 生产 W117 默认拒绝且不落确认", async () => {
    const key = uuidv7();
    await data(
      await request("admin.deliveryTicket.assignManager", { staffId: managerId }, undefined, key),
    );
    expect(
      await data(
        await request("admin.deliveryTicket.assignManager", { staffId: managerId }, undefined, key),
      ),
    ).toMatchObject({ replayed: true });
    const content = {
      focusCodes: ["CF01"],
      referenceAssetIds: [],
      launchMode: "merchant_self",
      items: [
        {
          orderItemId: itemId,
          channelAccountIds: [accountId],
          placements: [],
          agreedLaunchDate: "2026-01-20",
        },
      ],
    };
    const draftKey = uuidv7(),
      pushKey = uuidv7();
    await data(
      await request(
        "admin.deliveryPlan.draft.replace",
        { draftLockVersion: 0, content },
        undefined,
        draftKey,
      ),
    );
    expect(
      await data(
        await request(
          "admin.deliveryPlan.draft.replace",
          { draftLockVersion: 0, content },
          undefined,
          draftKey,
        ),
      ),
    ).toMatchObject({ replayed: true, draftLockVersion: 1 });
    await data(
      await request("admin.deliveryPlan.push", { draftLockVersion: 1 }, undefined, pushKey),
    );
    expect(
      await data(
        await request("admin.deliveryPlan.push", { draftLockVersion: 1 }, undefined, pushKey),
      ),
    ).toMatchObject({ replayed: true, currentVersionNo: 1 });
    const signedResponse = await request("m.deliveryPlan.get");
    expect(signedResponse.headers.get("Cache-Control")).toBe("no-store");
    expect((await data(signedResponse)).content).toMatchObject({
      items: [{ posterUrl: { url: expect.any(String), expiresAt: expect.any(String) } }],
    });
    const changeKey = uuidv7();
    await data(
      await request(
        "m.deliveryPlan.requestChange",
        { kinds: ["other"], note: "补充接口意见" },
        undefined,
        changeKey,
      ),
    );
    expect(
      await data(
        await request(
          "m.deliveryPlan.requestChange",
          { kinds: ["other"], note: "补充接口意见" },
          undefined,
          changeKey,
        ),
      ),
    ).toMatchObject({ replayed: true });
    await data(await request("admin.deliveryPlan.push", { draftLockVersion: 1 }));
    const response = await request("m.deliveryPlan.confirm", { versionNo: 2 });
    expect(response.status, await response.clone().text()).toBe(500);
    expect(await response.json()).toMatchObject({ error: "INTERNAL" });
    expect(
      (await prisma.deliveryPlan.findUniqueOrThrow({ where: { id: planId } })).confirmedVersionNo,
    ).toBeNull();
    expect(
      await prisma.deliveryPlanChangeRequest.count({ where: { deliveryPlanId: planId } }),
    ).toBe(1);
  });
});
