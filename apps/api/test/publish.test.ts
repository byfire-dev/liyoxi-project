import { beforeAll, describe, expect, it } from "vitest";
import { ChecklistItemsSchema, COMPARE_FIELDS } from "@liyoxi/contract";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import { HANDLERS } from "../src/routes/index.js";
import { publishOf } from "../src/routes/publish.js";
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
  publisher: SignedInStaff,
  storeId: string,
  entityId: string;
let prisma: Awaited<ReturnType<typeof handle.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  peer = 0;
const routes = [
  ["m.channelAccount.list", "GET", "/m/channel-accounts"],
  ["m.channelAccount.create", "POST", "/m/channel-accounts"],
  ["m.channelAccount.submit", "POST", "/m/channel-accounts/:id/submit"],
  ["m.launchTask.list", "GET", "/m/launch-tasks"],
  ["m.launchTask.summary", "GET", "/m/launch-tasks/summary"],
  ["m.launchTask.get", "GET", "/m/launch-tasks/:id"],
  ["m.launchTask.submit", "POST", "/m/launch-tasks/:id/submit"],
  ["admin.channelAccount.get", "GET", "/admin/channel-accounts/:id"],
  ["admin.channelAccountSubmission.get", "GET", "/admin/channel-account-submissions/:id"],
  [
    "admin.channelAccountSubmission.approve",
    "POST",
    "/admin/channel-account-submissions/:id/approve",
  ],
  [
    "admin.channelAccountSubmission.reject",
    "POST",
    "/admin/channel-account-submissions/:id/reject",
  ],
  ["admin.launchSubmission.get", "GET", "/admin/launch-submissions/:id"],
  ["admin.launchSubmission.approve", "POST", "/admin/launch-submissions/:id/approve"],
  ["admin.launchSubmission.reject", "POST", "/admin/launch-submissions/:id/reject"],
  ["admin.checklistTemplate.list", "GET", "/admin/checklist-templates"],
] as const;
async function request(
  op: (typeof routes)[number][0],
  options: {
    id?: string;
    json?: unknown;
    key?: string;
    headers?: Record<string, string>;
    query?: string;
  } = {},
) {
  const [, method, path] = routes.find((r) => r[0] === op)!;
  return api.request(
    `/api/v1${path.replace(":id", options.id ?? uuidv7())}${options.query ?? ""}`,
    {
      method,
      ...(options.json === undefined ? {} : { json: options.json }),
      headers: options.headers ?? {
        ...(op.startsWith("admin.") ? admin.headers : owner.withStore(storeId)),
        "Idempotency-Key": options.key ?? uuidv7(),
      },
      peer: `198.19.114.${++peer}`,
    },
  );
}
async function data<T = Record<string, unknown>>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
async function checks(code: string) {
  const r = await prisma.checklistTemplate.findFirstOrThrow({ where: { code, status: "active" } });
  return {
    checklistVersionNo: r.versionNo,
    results: ChecklistItemsSchema.parse(r.items).map((i) => ({
      key: i.key,
      result: "pass" as const,
    })),
  };
}
const compareRows = () => COMPARE_FIELDS.map((field) => ({ field, recognized: null, match: true }));
async function screenshot() {
  return make.fileObject({
    category: "channel_screenshot",
    bucket: "asset",
    scopeType: "store",
    entityId,
    storeId,
    uploadActorType: "merchant",
    uploadActorId: owner.merchantUserId,
    uploadClient: "weapp",
  });
}
async function createAccount(uid: string) {
  return data<{ channelAccountId: string }>(
    await request("m.channelAccount.create", {
      json: {
        platform: "douyin",
        accountName: "接口测试号",
        accountUid: uid,
        accountType: "none",
        screenshotFileIds: [(await screenshot()).id],
      },
    }),
  );
}
beforeAll(async () => {
  api = await handle.start();
  prisma = await handle.db.prisma();
  make = createFactories({ db: prisma, clock: api.clock });
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  owner = await signInAsMerchant(api);
  const entity = await make.entity({
      createdByUserId: owner.merchantUserId,
      verificationStatus: "verified",
    }),
    store = await make.store({
      entityId: entity.id,
      qualificationStatus: "verified",
      isPrimary: true,
    });
  entityId = entity.id;
  storeId = store.id;
  const member = await make.entityMember({
    entityId,
    merchantUserId: owner.merchantUserId,
    role: "owner",
  });
  clerk = await signInAsMerchant(api);
  const clerkMember = await make.entityMember({ entityId, merchantUserId: clerk.merchantUserId });
  await make.storeMember({ entityMemberId: clerkMember.id, storeId, addedByMemberId: member.id });
  stranger = await signInAsMerchant(api);
  admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  publisher = await signInAsStaff(prisma, { roleKey: "publisher", now: api.clock.now() });
}, 180000);
describe("publish 十五条真实 API", { timeout: 60000 }, () => {
  it("十五条挂载、店员七条先拒、跨店无关系者不可取当前店", async () => {
    expect(routes.every(([op]) => HANDLERS.some((h) => h.route.operationId === op))).toBe(true);
    for (const [op, method] of routes.filter(([op]) => op.startsWith("m."))) {
      const r = await request(op, {
        headers: { ...clerk.withStore(storeId), "Idempotency-Key": uuidv7() },
        ...(method === "POST" ? { json: {} } : {}),
      });
      expect(r.status, op).toBe(403);
      expect(await r.json()).toMatchObject({ error: "ROLE_FORBIDDEN" });
    }
    const r = await request("m.channelAccount.list", { headers: stranger.withStore(storeId) });
    expect(r.status).toBe(403);
  });
  it("账号创建、列表、详情、决定守卫、驳回/重提/通过与两种同键重放脱敏", async () => {
    const card = await createAccount("api_account"),
      accountId = card.channelAccountId;
    const list = await request("m.channelAccount.list");
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await data<{ items: unknown[] }>(list)).toMatchObject({
      items: [{ channelAccountId: accountId }],
    });
    await data(await request("admin.channelAccount.get", { id: accountId }));
    const first = await prisma.channelAccountSubmission.findFirstOrThrow({
      where: { channelAccountId: accountId },
    });
    const get = await request("admin.channelAccountSubmission.get", { id: first.id });
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(await data<{ screenshots: Array<{ url: string }> }>(get)).toMatchObject({
      screenshots: [{ url: expect.any(String) }],
    });
    const approve = {
      lockVersion: 0,
      confirm: { roundNo: 1, accountUid: "api_account" },
      accountType: "none",
      certSubjectName: null,
      compareRows: compareRows(),
      ...(await checks("account.verify")),
    };
    const missing = { ...approve, confirm: undefined };
    const badVersion = await request("admin.channelAccountSubmission.approve", {
      id: first.id,
      json: { ...missing, lockVersion: 99 },
    });
    expect(badVersion.status).toBe(409);
    expect(await badVersion.json()).toMatchObject({ error: "VERSION_CONFLICT" });
    const noConfirm = await request("admin.channelAccountSubmission.approve", {
      id: first.id,
      json: missing,
    });
    expect(noConfirm.status).toBe(409);
    expect(await noConfirm.json()).toMatchObject({ error: "CONFIRM_MISMATCH" });
    const key = uuidv7(),
      rejectedBody = { reasonCode: "R12", note: "请补主页", compareRows: compareRows() };
    await data(
      await request("admin.channelAccountSubmission.reject", {
        id: first.id,
        json: rejectedBody,
        key,
      }),
    );
    expect(
      await data(
        await request("admin.channelAccountSubmission.reject", {
          id: first.id,
          json: rejectedBody,
          key,
        }),
      ),
    ).toMatchObject({ replayed: true, screenshots: [{ url: null, expiresAt: null }] });
    await data(
      await request("m.channelAccount.submit", {
        id: accountId,
        json: { accountType: "none", screenshotFileIds: [(await screenshot()).id] },
      }),
    );
    const second = await prisma.channelAccountSubmission.findFirstOrThrow({
        where: { channelAccountId: accountId, roundNo: 2 },
      }),
      approvedBody = { ...approve, confirm: { roundNo: 2, accountUid: "api_account" } },
      passKey = uuidv7();
    await data(
      await request("admin.channelAccountSubmission.approve", {
        id: second.id,
        json: approvedBody,
        key: passKey,
      }),
    );
    expect(
      await data(
        await request("admin.channelAccountSubmission.approve", {
          id: second.id,
          json: approvedBody,
          key: passKey,
        }),
      ),
    ).toMatchObject({ replayed: true, screenshots: [{ url: null, expiresAt: null }] });
  });
  it("上线 list/summary/get/submit 和 get/return/approve 真实主链；订单项回写留给 delivery", async () => {
    const account = await prisma.channelAccount.findFirstOrThrow({
        where: { accountUid: "api_account" },
      }),
      order = await make.dramaOrder({ entityId, storeId, status: "to_launch" }),
      item = await make.orderItem({
        dramaOrderId: order.id,
        phase: "to_launch",
        agreedLaunchDate: new Date("2026-01-07"),
      }),
      ticket = await make.deliveryTicket({
        orderItemId: item.id,
        step: "awaiting_launch",
        deliveredAt: new Date("2026-01-01T16:00:00Z"),
      });
    await prisma.orderItemAccount.create({
      data: {
        orderItemId: item.id,
        channelAccountId: account.id,
        platform: account.platform,
        createdAt: api.clock.now(),
      },
    });
    const ctx = createIdentityContext({
        actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
        entityId,
        storeId,
      }),
      [id] = await api.runtime.tx.run((tx) =>
        publishOf(api.runtime).createLaunchTasks(tx, ctx, {
          orderItemId: item.id,
          deliveryTicketId: ticket.id,
          channelAccountIds: [account.id],
        }),
      );
    for (const op of ["m.launchTask.list", "m.launchTask.summary", "m.launchTask.get"] as const) {
      const r = await request(op, { id });
      expect(r.headers.get("cache-control")).toBe("no-store");
      await data(r);
    }
    const body = {
      linkKind: "collection",
      collectionUrl: "https://example.invalid/作品",
      reportedEpisodeCount: 3,
      actualLaunchDate: "2026-01-04",
    };
    await data(await request("m.launchTask.submit", { id, json: body }));
    let round = await prisma.launchSubmission.findFirstOrThrow({
      where: { launchTaskId: id, roundNo: 1 },
    });
    await data(await request("admin.launchSubmission.get", { id: round.id }));
    await data(
      await request("admin.launchSubmission.reject", {
        id: round.id,
        json: { reasonCodes: ["R06"], note: "请补链接" },
      }),
    );
    await data(await request("m.launchTask.submit", { id, json: body }));
    round = await prisma.launchSubmission.findFirstOrThrow({
      where: { launchTaskId: id, roundNo: 2 },
    });
    await data(
      await request("admin.launchSubmission.approve", {
        id: round.id,
        json: {
          lockVersion: 0,
          confirm: { roundNo: 2, reportedEpisodeCount: 3 },
          verifiedEpisodeCount: 3,
          ...(await checks("launch.verify")),
        },
      }),
    );
    expect(await prisma.orderItem.findUnique({ where: { id: item.id } })).toMatchObject({
      usageStartDate: null,
      liveEpisodeCount: 0,
    });
    expect(await data(await request("m.launchTask.summary"))).toMatchObject({ todo: 0, done: 1 });
  });
  it("已登录即可读九个 active 版本；全版本查询需专门权限", async () => {
    expect(
      await data<{ items: unknown[] }>(
        await request("admin.checklistTemplate.list", { headers: publisher.headers }),
      ),
    ).toMatchObject({ items: expect.any(Array) });
    const list = await data<{ items: unknown[] }>(await request("admin.checklistTemplate.list"));
    expect(list.items).toHaveLength(9);
    const denied = await request("admin.checklistTemplate.list", {
      headers: publisher.headers,
      query: "?allVersions=true",
    });
    expect(denied.status).toBe(403);
  });
});
