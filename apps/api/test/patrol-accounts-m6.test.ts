import { beforeAll, expect, it } from "vitest";
import { runSeed, uuidv7 } from "@liyoxi/services";
import {
  createPatrolTestSubject,
  openSealed,
  signInAsStaff,
  TEST_KEYRING,
} from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
const handle = useTestApi();
let api: TestApi,
  prisma: Awaited<ReturnType<typeof handle.db.prisma>>,
  admin: SignedInStaff,
  peer = 0;
const routes = [
  ["admin.channelAccount.list", "GET", "/admin/channel-accounts"],
  ["admin.channelAccount.summary", "GET", "/admin/channel-accounts/summary"],
  ["admin.channelAccount.markAbnormal", "POST", "/admin/channel-accounts/:id/mark-abnormal"],
  ["m.channelAccount.unbind", "POST", "/m/channel-accounts/:id/unbind"],
  ["admin.patrolTask.list", "GET", "/admin/patrol-tasks"],
  ["admin.patrolTask.summary", "GET", "/admin/patrol-tasks/summary"],
  ["admin.patrolTask.get", "GET", "/admin/patrol-tasks/:id"],
  ["admin.patrolTask.create", "POST", "/admin/patrol-tasks"],
  ["admin.patrolTask.markNormal", "POST", "/admin/patrol-tasks/:id/mark-normal"],
  ["admin.patrolTask.markAbnormal", "POST", "/admin/patrol-tasks/:id/mark-abnormal"],
  ["admin.patrolTask.recover", "POST", "/admin/patrol-tasks/:id/recover"],
  ["admin.patrolTask.remind", "POST", "/admin/patrol-tasks/:id/remind"],
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
  const [, method, path] = routes.find((r) => r[0] === op)!;
  return api.request(`/api/v1${path.replace(":id", input.id ?? uuidv7())}${input.query ?? ""}`, {
    method,
    ...(method === "POST" ? { json: input.json ?? {} } : {}),
    headers: { ...(input.headers ?? admin.headers), "Idempotency-Key": input.key ?? uuidv7() },
    peer: `198.19.116.${++peer}`,
  });
}
async function data<T = Record<string, unknown>>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
const subject = () => createPatrolTestSubject(api.runtime, prisma);
async function businessSnapshot() {
  return Promise.all([
    prisma.patrolBatch.findMany({ orderBy: { id: "asc" } }),
    prisma.patrolTask.findMany({ orderBy: { id: "asc" } }),
    prisma.channelAccount.findMany({ orderBy: { id: "asc" } }),
    prisma.timer.findMany({ orderBy: { id: "asc" } }),
    prisma.followUp.findMany({ orderBy: { id: "asc" } }),
    prisma.manualReminderLog.findMany({ orderBy: { id: "asc" } }),
    prisma.statusTransition.count(),
    prisma.outboxEvent.count(),
    prisma.auditLog.count(),
  ]);
}
beforeAll(async () => {
  api = await handle.start({ merchantKeyring: TEST_KEYRING });
  prisma = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
});
it("十二条真实挂载；正常、异常、提醒、恢复与账号异常/解绑均走正式HTTP，重放不重复写", async () => {
  expect(routes.every(([op]) => HANDLERS.some((h) => h.route.operationId === op))).toBe(true);
  const h = await subject(),
    live = await h.launch(),
    key = uuidv7();
  const createBody = { launchTaskId: live.taskId, reason: "接口人工巡检" };
  const created = await data<{ isNew: boolean; patrolTask: { patrolTaskId: string } }>(
    await request("admin.patrolTask.create", { json: createBody, key }),
  );
  const id = created.patrolTask.patrolTaskId;
  async function rejectsReminderWithoutWrites(patrolTaskId: string) {
    const before = await businessSnapshot();
    // A fresh intent must reach the real status guard, not replay an earlier reminder.
    const response = await request("admin.patrolTask.remind", {
      id: patrolTaskId,
      key: uuidv7(),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(await businessSnapshot()).toEqual(before);
  }
  expect(created.isNew).toBe(true);
  expect(await data(await request("admin.patrolTask.create", { json: createBody, key }))).toEqual(
    created,
  );
  expect(await prisma.patrolTask.count({ where: { launchTaskId: live.taskId } })).toBe(1);
  await rejectsReminderWithoutWrites(id);
  const normalBody = { ...(await h.checks("patrol.check")), evidenceFileIds: [await h.evidence()] },
    normalKey = uuidv7();
  expect(
    await data(
      await request("admin.patrolTask.markNormal", { id, json: normalBody, key: normalKey }),
    ),
  ).toMatchObject({ status: "normal" });
  await data(
    await request("admin.patrolTask.markNormal", { id, json: normalBody, key: normalKey }),
  );
  expect(
    await prisma.statusTransition.count({ where: { subjectId: id, event: "patrol.ok" } }),
  ).toBe(1);
  await rejectsReminderWithoutWrites(id);
  api.clock.advance(1);
  const second = await data<{ patrolTask: { patrolTaskId: string } }>(
    await request("admin.patrolTask.create", { json: createBody }),
  );
  const abnormalId = second.patrolTask.patrolTaskId;
  const kind = await prisma.dictItem.findFirstOrThrow({
    where: { dictTypeKey: "patrol_issue", isEnabled: true },
  });
  await data(
    await request("admin.patrolTask.markAbnormal", {
      id: abnormalId,
      json: {
        abnormalKindCode: kind.code,
        note: "截图可证异常",
        evidenceFileIds: [await h.evidence()],
      },
    }),
  );
  const remindKey = uuidv7();
  await data(await request("admin.patrolTask.remind", { id: abnormalId, key: remindKey }));
  await data(await request("admin.patrolTask.remind", { id: abnormalId, key: remindKey }));
  expect(
    await prisma.manualReminderLog.count({ where: { subjectId: abnormalId, scene: "patrol_fix" } }),
  ).toBe(1);
  const repeated = await request("admin.patrolTask.remind", { id: abnormalId });
  expect(await repeated.json()).toMatchObject({ error: "REMINDED_TODAY" });
  expect(
    await data(
      await request("admin.patrolTask.recover", {
        id: abnormalId,
        json: { ...(await h.checks("patrol.check")), evidenceFileIds: [await h.evidence()] },
      }),
    ),
  ).toMatchObject({ status: "recovered" });
  await rejectsReminderWithoutWrites(abnormalId);
  const query = `?storeId=${h.merchant.store.id}`;
  const snapshot = await businessSnapshot();
  for (const op of [
    "admin.patrolTask.list",
    "admin.patrolTask.summary",
    "admin.patrolTask.get",
    "admin.channelAccount.list",
    "admin.channelAccount.summary",
  ] as const) {
    const response = await request(op, { id: abnormalId, query: op.endsWith(".get") ? "" : query });
    expect(response.headers.get("cache-control")).toBe("no-store");
    await data(response);
  }
  expect(await businessSnapshot()).toEqual(snapshot);
  expect(await data(await request("admin.patrolTask.summary", { query }))).toMatchObject({
    all: 2,
    pending: 0,
    abnormal: 0,
    normal: 2,
    checked: 2,
  });
  const reason = await prisma.dictItem.findFirstOrThrow({
    where: {
      dictTypeKey: "reject_reason",
      isEnabled: true,
      ext: { path: ["scene"], equals: "account_verify" },
    },
  });
  expect(
    await data(
      await request("admin.channelAccount.markAbnormal", {
        id: live.accountId,
        json: { reasonCode: reason.code, note: "账号异常独立于巡检结论" },
      }),
    ),
  ).toMatchObject({ status: "abnormal" });
  expect(await data(await request("admin.channelAccount.summary", { query }))).toMatchObject({
    total: 1,
    abnormal: 1,
  });
  const owner = await signInAsMerchant(api, {
    phone: openSealed("merchant_user.phone_enc", h.merchant.user.phoneEnc!),
  });
  const headers = owner.withStore(h.merchant.store.id);
  expect(
    await (await request("m.channelAccount.unbind", { id: live.accountId, headers })).json(),
  ).toMatchObject({ error: "CHANNEL_ACCOUNT_IN_USE" });
  const account = await h.bindAccount(false),
    unbindKey = uuidv7();
  expect(
    await data(
      await request("m.channelAccount.unbind", { id: account.id, headers, key: unbindKey }),
    ),
  ).toMatchObject({ status: "unbound" });
  await data(await request("m.channelAccount.unbind", { id: account.id, headers, key: unbindKey }));
  expect(
    await prisma.statusTransition.count({
      where: { subjectId: account.id, event: "account.unbind" },
    }),
  ).toBe(1);
  expect(
    await prisma.approvalRequest.findUnique({ where: { id: account.sub.approvalRequestId } }),
  ).toMatchObject({ status: "withdrawn" });
});
it("指定范围外storeId的列表和summary仍为零，后台详情/写入不可越范围", async () => {
  const h = await subject(),
    live = await h.launch();
  const patrol = await h.patrol.create(h.adminCtx, h.staff, { launchTaskId: live.taskId });
  const limited = await signInAsStaff(prisma, { roleKey: "publisher", now: api.clock.now() });
  const query = `?storeId=${h.merchant.store.id}`,
    headers = limited.headers;
  const snapshot = await businessSnapshot();
  for (const op of ["admin.channelAccount.list", "admin.patrolTask.list"] as const)
    expect(await data(await request(op, { query, headers }))).toMatchObject({
      total: 0,
      items: [],
    });
  expect(
    await data(await request("admin.channelAccount.summary", { query, headers })),
  ).toMatchObject({ total: 0, available: 0 });
  expect(await data(await request("admin.patrolTask.summary", { query, headers }))).toMatchObject({
    all: 0,
    pending: 0,
  });
  const hidden = await request("admin.patrolTask.get", {
    id: patrol.patrolTask.patrolTaskId,
    headers,
  });
  expect(hidden.status).toBe(404);
  const denied = await request("admin.patrolTask.create", {
    json: { launchTaskId: live.taskId },
    headers,
  });
  expect(denied.status).toBe(404);
  expect(await businessSnapshot()).toEqual(snapshot);
});
it("店员不能解绑，非本店老板不能取用账号，权限失败不消费幂等业务写入", async () => {
  const h = await subject(),
    account = await h.bindAccount(false);
  const clerk = await signInAsMerchant(api),
    outsider = await signInAsMerchant(api);
  const member = await h.make.entityMember({
    entityId: h.merchant.entity.id,
    merchantUserId: clerk.merchantUserId,
  });
  await h.make.storeMember({
    entityMemberId: member.id,
    storeId: h.merchant.store.id,
    addedByMemberId: h.merchant.owner.id,
  });
  const before = await businessSnapshot();
  const denied = await request("m.channelAccount.unbind", {
    id: account.id,
    headers: clerk.withStore(h.merchant.store.id),
  });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ error: "ROLE_FORBIDDEN" });
  expect(
    (
      await request("m.channelAccount.unbind", {
        id: account.id,
        headers: outsider.withStore(h.merchant.store.id),
      })
    ).status,
  ).toBe(403);
  expect(await businessSnapshot()).toEqual(before);
});
