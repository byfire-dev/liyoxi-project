import { afterAll, beforeAll, expect, it } from "vitest";
import { runSeed, uuidv7 } from "@liyoxi/services";
import {
  createPublishWorkbenchFixture,
  createM5DeliveryService,
  openSealed,
  signInAsStaff,
  TEST_KEYRING,
} from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { addDays, calendarDate, dayRange } from "@liyoxi/shared/time";
import type { TakedownTaskCheckBody, TakedownTaskDetail } from "@liyoxi/contract";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";

const handle = useTestApi();
let api: TestApi;
let h: ReturnType<typeof createPublishWorkbenchFixture>;
let secondFixture: ReturnType<typeof createPublishWorkbenchFixture>;
let live: Awaited<ReturnType<typeof h.release>>;
let unverified: Awaited<ReturnType<typeof h.release>>;
let liveSteps: ReturnType<typeof h.releaseSteps>;
let unverifiedSteps: ReturnType<typeof h.releaseSteps>;
let liveLaunchIds: string[];
let liveIds: string[];
let unverifiedIds: string[];
let owner: SignedInMerchant;
let otherOwner: SignedInMerchant;
let clerk: SignedInMerchant;
let admin: SignedInStaff;
let publisher: SignedInStaff;
let publishingLead: SignedInStaff;
let peer = 0;
const routes = [
  ["m.takedownTask.list", "GET", "/m/takedown-tasks"],
  ["m.takedownTask.summary", "GET", "/m/takedown-tasks/summary"],
  ["m.takedownTask.confirm", "POST", "/m/takedown-tasks/:id/confirm"],
  ["admin.takedownTask.list", "GET", "/admin/takedown-tasks"],
  ["admin.takedownTask.summary", "GET", "/admin/takedown-tasks/summary"],
  ["admin.takedownTask.get", "GET", "/admin/takedown-tasks/:id"],
  ["admin.takedownTask.check", "POST", "/admin/takedown-tasks/:id/check"],
  ["admin.takedownTask.batchCheck", "POST", "/admin/takedown-tasks/check"],
  ["admin.takedownTask.markOnline", "POST", "/admin/takedown-tasks/:id/mark-online"],
  ["admin.takedownTask.escalate", "POST", "/admin/takedown-tasks/:id/escalate"],
  ["admin.takedownTask.sendBreachNotice", "POST", "/admin/takedown-tasks/:id/send-breach-notice"],
] as const;
type Operation = (typeof routes)[number][0];
async function request(
  op: Operation,
  input: {
    id?: string;
    json?: unknown;
    query?: string;
    key?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const [, method, path] = routes.find(([id]) => id === op)!;
  return api.request(`/api/v1${path.replace(":id", input.id ?? liveIds[0]!)}${input.query ?? ""}`, {
    method,
    ...(method === "POST" ? { json: input.json ?? {} } : {}),
    headers: {
      ...(input.headers ??
        (op.startsWith("admin.") ? admin.headers : owner.withStore(live.o.store.id))),
      ...(method === "POST" ? { "Idempotency-Key": input.key ?? uuidv7() } : {}),
    },
    peer: `198.19.117.${(peer++ % 240) + 1}`,
  });
}
async function data<T = Record<string, unknown>>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
async function failure(response: Response, status: number, error: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  const result = (await response.json()) as { error: string; details?: unknown };
  expect(result).toMatchObject({ error });
  return result;
}
async function evidence(f: typeof live) {
  return (
    await h.make.fileObject({
      category: "evidence",
      bucket: "secure",
      scopeType: "store",
      entityId: f.o.entity.id,
      storeId: f.o.store.id,
      uploadActorType: "staff",
      uploadActorId: admin.staff.id,
      uploadClient: "admin",
    })
  ).id;
}
async function checkBody(
  f: typeof live,
  checklistCode: TakedownTaskCheckBody["checklistCode"],
): Promise<TakedownTaskCheckBody> {
  return {
    checklistCode,
    ...(await h.checks(checklistCode)),
    evidenceFileIds: [await evidence(f), await evidence(f)],
  };
}
async function businessSnapshot() {
  return Promise.all([
    h.prisma.takedownTask.findMany({ orderBy: { id: "asc" } }),
    h.prisma.orderItem.findMany({ orderBy: { id: "asc" } }),
    h.prisma.deliveryTicket.findMany({ orderBy: { id: "asc" } }),
    h.prisma.deliveryRelease.findMany({ orderBy: { id: "asc" } }),
    h.prisma.fileRef.findMany({ orderBy: { id: "asc" } }),
    h.prisma.timer.findMany({ orderBy: { id: "asc" } }),
    h.prisma.manualReminderLog.findMany({ orderBy: { id: "asc" } }),
    h.prisma.followUp.findMany({ orderBy: { id: "asc" } }),
    h.prisma.statusTransition.count(),
    h.prisma.outboxEvent.count(),
    h.prisma.auditLog.count(),
  ]);
}
function releaseInTakedownWindow(subject = h) {
  return subject.releaseSteps(true, 1, async (f) => {
    subject.clock.set(dayRange(addDays(f.item.usageEndDate.toISOString().slice(0, 10), -10)).start);
  });
}
beforeAll(async () => {
  api = await handle.start({ merchantKeyring: TEST_KEYRING });
  const prisma = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  h = createPublishWorkbenchFixture(prisma);
});
beforeAll(() => {
  // Actual production/QC/approval/push writers create the lower-window takedown tasks.
  // No HTTP fixture seeds a live/confirmed/checked/archived business state.
  // Each release phase runs once in its own hook, retaining the default 10s budget.
  liveSteps = releaseInTakedownWindow();
  return liveSteps.prepare();
});
beforeAll(() => liveSteps.sampleFile());
beforeAll(() => liveSteps.confirmSample());
beforeAll(async () => {
  live = await liveSteps.push();
  liveLaunchIds = (
    await h.prisma.launchTask.findMany({
      where: { deliveryTicketId: live.id },
      orderBy: { id: "asc" },
    })
  ).map((task) => task.id);
  expect(liveLaunchIds).toHaveLength(2);
});
for (const index of [0, 1])
  beforeAll(async () => {
    const taskId = liveLaunchIds[index]!;
    await h.deps.publish.submitLaunch(live.o.viewer, taskId, {
      linkKind: "collection",
      collectionUrl: `https://example.invalid/http-takedown/${taskId}`,
      reportedEpisodeCount: 1,
      actualLaunchDate: calendarDate(h.clock.now()),
    });
    const sub = await h.prisma.launchSubmission.findFirstOrThrow({
      where: { launchTaskId: taskId },
      include: { approvalRequest: true },
      orderBy: { roundNo: "desc" },
    });
    await h.deps.publish.approveLaunch(live.qc.ctx, live.qc.staff, sub.id, {
      lockVersion: sub.approvalRequest.lockVersion,
      confirm: { roundNo: sub.roundNo, reportedEpisodeCount: 1 },
      verifiedEpisodeCount: 1,
      ...(await h.checks("launch.verify")),
    });
  });
beforeAll(async () => {
  liveIds = (
    await h.prisma.takedownTask.findMany({
      where: { deliveryTicketId: live.id, status: { not: "void" } },
      orderBy: { id: "asc" },
    })
  ).map((row) => row.id);
  expect(liveIds).toHaveLength(2);
});
beforeAll(() => {
  // Each delivery fixture has its own business clock: the first order's window
  // advance must not make the second fixture's frozen draft date historical.
  secondFixture = createPublishWorkbenchFixture(h.prisma);
  unverifiedSteps = releaseInTakedownWindow(secondFixture);
  return unverifiedSteps.prepare();
});
beforeAll(() => unverifiedSteps.sampleFile());
beforeAll(() => unverifiedSteps.confirmSample());
beforeAll(async () => {
  unverified = await unverifiedSteps.push();
  unverifiedIds = (
    await h.prisma.takedownTask.findMany({
      where: { deliveryTicketId: unverified.id, status: { not: "void" } },
      orderBy: { id: "asc" },
    })
  ).map((row) => row.id);
  expect(unverifiedIds).toHaveLength(2);
});
beforeAll(async () => {
  // Establish each owned fake WeChat identity before the time advance. Re-login
  // later keeps that identity; it must not bypass the dormant-owner protection.
  await signInAsMerchant(api, {
    phone: openSealed("merchant_user.phone_enc", live.o.user.phoneEnc!),
    openid: "oLyxTakedownOwner",
  });
  await signInAsMerchant(api, {
    phone: openSealed("merchant_user.phone_enc", unverified.o.user.phoneEnc!),
    openid: "oLyxTakedownOther",
  });
});
beforeAll(async () => {
  api.clock.set(h.clock.now());
  owner = await signInAsMerchant(api, {
    phone: openSealed("merchant_user.phone_enc", live.o.user.phoneEnc!),
    openid: "oLyxTakedownOwner",
  });
  otherOwner = await signInAsMerchant(api, {
    phone: openSealed("merchant_user.phone_enc", unverified.o.user.phoneEnc!),
    openid: "oLyxTakedownOther",
  });
});
beforeAll(async () => {
  clerk = await signInAsMerchant(api);
  const member = await h.make.entityMember({
    entityId: live.o.entity.id,
    merchantUserId: clerk.merchantUserId,
  });
  await h.make.storeMember({
    entityMemberId: member.id,
    storeId: live.o.store.id,
    addedByMemberId: live.o.member.id,
  });
});
beforeAll(async () => {
  admin = await signInAsStaff(h.prisma, { roleKey: "super_admin", now: api.clock.now() });
  publisher = await signInAsStaff(h.prisma, {
    roleKey: "publisher",
    staffGroupId: null,
    now: api.clock.now(),
  });
});
beforeAll(async () => {
  const assignee = await signInAsStaff(h.prisma, { roleKey: "publisher", now: api.clock.now() });
  publishingLead = await signInAsStaff(h.prisma, {
    roleKey: "publisher",
    isLead: true,
    now: api.clock.now(),
  });
  await createM5DeliveryService(h).assignPublisher(live.qc.ctx, live.qc.staff, live.id, {
    staffId: assignee.staff.id,
  });
});
afterAll(async () => {
  await secondFixture?.close();
  await h?.close();
});

it("十一条正式HTTP挂载；两端列表/计数/详情GET零业务写，页签和响应字段各守原契约", async () => {
  expect(api.api.mountedOperations).toEqual(expect.arrayContaining(routes.map(([op]) => op)));
  const before = await businessSnapshot();
  for (const op of [
    "m.takedownTask.list",
    "m.takedownTask.summary",
    "admin.takedownTask.list",
    "admin.takedownTask.summary",
    "admin.takedownTask.get",
  ] as const) {
    const response = await request(op, {
      query: op.startsWith("admin.") && !op.endsWith(".get") ? `?storeId=${live.o.store.id}` : "",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    await data(response);
  }
  expect(await businessSnapshot()).toEqual(before);
  expect(await data(await request("m.takedownTask.summary"))).toMatchObject({
    pending: 2,
    done: 0,
    overdue: 0,
    nextTakedown: null,
  });
  expect(
    await data(
      await request("admin.takedownTask.summary", {
        query: `?storeId=${unverified.o.store.id}&isOverdue=false`,
      }),
    ),
  ).toMatchObject({ pending: 0, waiting: 2, checked: 0, overdue: 0 });
  const merchant = await data<{ items: Record<string, unknown>[] }>(
    await request("m.takedownTask.list"),
  );
  expect(merchant.items[0]).toHaveProperty("channelAccount");
  expect(merchant.items[0]).not.toHaveProperty("account");
  const detail = await data<TakedownTaskDetail>(await request("admin.takedownTask.get"));
  expect(detail).toMatchObject({
    basis: "live",
    expectedChecklistCode: "takedown.check",
    evidenceFileIds: [],
    merchantMethod: null,
    merchantConfirmedAt: null,
  });
  expect(detail).toHaveProperty("account");
  expect(detail).not.toHaveProperty("channelAccount");
});
it("店员三路均拒绝；另店老板404；后台显式store筛选与员工范围求交", async () => {
  const body = await checkBody(live, "takedown.check");
  const before = await businessSnapshot();
  for (const op of [
    "m.takedownTask.list",
    "m.takedownTask.summary",
    "m.takedownTask.confirm",
  ] as const)
    await failure(
      await request(op, { headers: clerk.withStore(live.o.store.id), json: { method: "delete" } }),
      403,
      "ROLE_FORBIDDEN",
    );
  await failure(
    await request("m.takedownTask.confirm", {
      headers: otherOwner.withStore(unverified.o.store.id),
      json: { method: "delete" },
    }),
    404,
    "NOT_FOUND",
  );
  const headers = publisher.headers,
    query = `?storeId=${live.o.store.id}`;
  expect(await data(await request("admin.takedownTask.list", { headers, query }))).toMatchObject({
    total: 0,
    items: [],
  });
  expect(await data(await request("admin.takedownTask.summary", { headers, query }))).toMatchObject(
    { pending: 0, waiting: 0, checked: 0 },
  );
  await failure(await request("admin.takedownTask.get", { headers }), 404, "NOT_FOUND");
  await failure(
    await request("admin.takedownTask.check", { headers, json: body }),
    404,
    "NOT_FOUND",
  );
  expect(
    await data(await request("admin.takedownTask.get", { headers: publishingLead.headers })),
  ).toMatchObject({ takedownTaskId: liveIds[0] });
  await failure(
    await request("admin.takedownTask.check", { headers: publishingLead.headers, json: body }),
    403,
    "PERMISSION_DENIED",
  );
  expect(await businessSnapshot()).toEqual(before);
});
it("confirm仅method、markOnline仅note；重复证据和重复任务在入口拒绝且不触发业务写", async () => {
  const body = await checkBody(live, "takedown.check"),
    before = await businessSnapshot();
  await failure(
    await request("m.takedownTask.confirm", {
      json: { method: "delete", evidenceFileIds: body.evidenceFileIds },
    }),
    400,
    "VALIDATION_FAILED",
  );
  await failure(
    await request("admin.takedownTask.markOnline", {
      json: { note: "仍在线", evidenceFileIds: body.evidenceFileIds },
    }),
    400,
    "VALIDATION_FAILED",
  );
  await failure(
    await request("admin.takedownTask.check", {
      json: { ...body, evidenceFileIds: [body.evidenceFileIds[0], body.evidenceFileIds[0]] },
    }),
    400,
    "VALIDATION_FAILED",
  );
  await failure(
    await request("admin.takedownTask.check", {
      json: { ...body, evidenceFileIds: body.evidenceFileIds.slice(0, 1) },
    }),
    400,
    "VALIDATION_FAILED",
  );
  await failure(
    await request("admin.takedownTask.batchCheck", {
      json: { items: [0, 1].map(() => ({ takedownTaskId: liveIds[0], ...body })) },
    }),
    400,
    "VALIDATION_FAILED",
  );
  expect(await businessSnapshot()).toEqual(before);
});
it("逾期升级/违约提醒真实落库且重放一次；未逾期返回dueDate，live排除not_published", async () => {
  const notOverdue = await failure(
    await request("admin.takedownTask.escalate", { id: unverifiedIds[0] }),
    409,
    "TAKEDOWN_NOT_OVERDUE",
  );
  expect(notOverdue.details).toEqual({
    dueDate: unverified.item.usageEndDate.toISOString().slice(0, 10),
  });
  api.clock.set(dayRange(addDays(live.item.usageEndDate.toISOString().slice(0, 10), 1)).start);
  h.clock.set(api.clock.now());
  secondFixture.clock.set(api.clock.now());
  // Sessions are real and expire when business time advances; authenticate again.
  owner = await signInAsMerchant(api, {
    phone: openSealed("merchant_user.phone_enc", live.o.user.phoneEnc!),
    openid: "oLyxTakedownOwner",
  });
  admin = await signInAsStaff(h.prisma, { roleKey: "super_admin", now: api.clock.now() });
  const forbidden = await failure(
    await request("m.takedownTask.confirm", { json: { method: "not_published" } }),
    409,
    "TAKEDOWN_METHOD_NOT_ALLOWED",
  );
  expect(forbidden.details).toEqual({ allowedMethods: ["delete", "private"] });
  for (const op of [
    "admin.takedownTask.escalate",
    "admin.takedownTask.sendBreachNotice",
  ] as const) {
    const key = uuidv7(),
      first = await data(await request(op, { key }));
    expect(await data(await request(op, { key }))).toEqual(first);
  }
  const repeated = await failure(
    await request("admin.takedownTask.sendBreachNotice"),
    409,
    "REMINDED_TODAY",
  );
  expect(repeated.details).toMatchObject({ scene: "breach" });
  expect(
    await h.prisma.manualReminderLog.count({ where: { subjectId: liveIds[0], scene: "breach" } }),
  ).toBe(1);
  expect(await h.prisma.followUp.count({ where: { subjectId: liveIds[0] } })).toBe(0);
});
it("商家确认重放不重复迁移且封面脱敏；仍在线重开；清单依据变化拒绝", async () => {
  const key = uuidv7(),
    json = { method: "delete" };
  expect(await data(await request("m.takedownTask.confirm", { key, json }))).toMatchObject({
    status: "merchant_confirmed",
    replayed: false,
  });
  expect(await data(await request("m.takedownTask.confirm", { key, json }))).toMatchObject({
    status: "merchant_confirmed",
    replayed: true,
    posterUrl: null,
  });
  expect(
    await h.prisma.statusTransition.count({
      where: { subjectId: liveIds[0], event: "takedown.merchant_confirm" },
    }),
  ).toBe(1);
  expect(await h.prisma.deliveryTicket.findUnique({ where: { id: live.id } })).not.toMatchObject({
    step: "archived",
  });
  expect(
    await data(
      await request("admin.takedownTask.markOnline", { json: { note: "真实核查仍在线" } }),
    ),
  ).toMatchObject({ status: "pending_merchant", stillOnlineCount: 1 });
  const stale = await checkBody(live, "takedown.absence_check"),
    before = await businessSnapshot();
  const failureBody = await failure(
    await request("admin.takedownTask.check", { json: stale }),
    409,
    "PRECONDITION_CHANGED",
  );
  expect(failureBody.details).toEqual({ expectedChecklistCode: "takedown.check" });
  expect(await businessSnapshot()).toEqual(before);
});
it("逐项核查与重放使用真实两张证据；全部确认再核查才归档", async () => {
  const body = await checkBody(live, "takedown.check"),
    key = uuidv7();
  expect(await data(await request("admin.takedownTask.check", { json: body, key }))).toMatchObject({
    status: "checked",
    checkMethod: "evidence",
    evidenceFileIds: body.evidenceFileIds,
  });
  await data(await request("admin.takedownTask.check", { json: body, key }));
  expect(
    await h.prisma.statusTransition.count({
      where: { subjectId: liveIds[0], event: "takedown.check_pass" },
    }),
  ).toBe(1);
  expect(await h.prisma.deliveryTicket.findUnique({ where: { id: live.id } })).not.toMatchObject({
    step: "archived",
  });
  await data(
    await request("m.takedownTask.confirm", { id: liveIds[1], json: { method: "private" } }),
  );
  expect(await h.prisma.deliveryTicket.findUnique({ where: { id: live.id } })).toMatchObject({
    step: "takedown",
  });
  await data(
    await request("admin.takedownTask.check", {
      id: liveIds[1],
      json: await checkBody(live, "takedown.check"),
    }),
  );
  expect(await h.prisma.deliveryTicket.findUnique({ where: { id: live.id } })).toMatchObject({
    step: "archived",
  });
  expect(await data(await request("m.takedownTask.summary"))).toMatchObject({
    pending: 0,
    done: 2,
    overdue: 0,
    nextTakedown: null,
  });
});
it("批量任一清单失败整批零写并定位items；合法整批按请求顺序返回且归档", async () => {
  const items = await Promise.all(
    [...unverifiedIds].reverse().map(async (takedownTaskId) => ({
      takedownTaskId,
      ...(await checkBody(unverified, "takedown.absence_check")),
    })),
  );
  const before = await businessSnapshot();
  const rejected = await failure(
    await request("admin.takedownTask.batchCheck", {
      json: { items: [items[0], { ...items[1], checklistCode: "takedown.check" }] },
    }),
    409,
    "TAKEDOWN_BATCH_REJECTED",
  );
  expect(rejected.details).toMatchObject({
    items: [
      {
        index: 1,
        takedownTaskId: items[1]!.takedownTaskId,
        error: "PRECONDITION_CHANGED",
        message: expect.any(String),
      },
    ],
  });
  expect(await businessSnapshot()).toEqual(before);
  const key = uuidv7(),
    result = await data<{
      items: { takedownTaskId: string; status: string }[];
      archivedTicketIds: string[];
    }>(await request("admin.takedownTask.batchCheck", { key, json: { items } }));
  expect(result.items.map((row) => row.takedownTaskId)).toEqual(
    items.map((row) => row.takedownTaskId),
  );
  expect(result.items.every((row) => row.status === "checked")).toBe(true);
  expect(result.archivedTicketIds).toEqual([unverified.id]);
  expect(
    await data(await request("admin.takedownTask.batchCheck", { key, json: { items } })),
  ).toEqual(result);
});
