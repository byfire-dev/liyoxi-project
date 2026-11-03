import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createIdentityContext, staffWorkSourcesOf, uuidv7 } from "../kernel/index.js";
import {
  createPatrolTestRuntime,
  createPatrolTestSubject,
  sampleStaffContext,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
const db = useSeededDatabase("services", { max: 2 }),
  redis = useTestRedis();
let stack: ReturnType<typeof createPatrolTestRuntime>;
beforeAll(async () => {
  stack = createPatrolTestRuntime({
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  });
});
beforeEach(() => stack.clock.set(new Date("2026-01-05T04:00:00Z")));
afterAll(async () => {
  await stack?.runtime.close();
});
const subject = async () => createPatrolTestSubject(stack.runtime, await db.prisma());
it("账号搜索保留名称包含，ID仅按去空格小写前缀匹配，列表summary同口径", async () => {
  const h = await subject();
  const screenshot = await h.make.fileObject({
    category: "channel_screenshot",
    bucket: "asset",
    scopeType: "store",
    entityId: h.merchant.entity.id,
    storeId: h.merchant.store.id,
    uploadActorType: "merchant",
    uploadActorId: h.merchant.user.id,
    uploadClient: "weapp",
  });
  const bind = (accountName: string, accountUid: string) =>
    h.publish.bind(h.viewer, {
      platform: "douyin",
      accountName,
      accountUid: `${accountUid}${uuidv7()}`,
      accountType: "none",
      screenshotFileIds: [screenshot.id],
    });
  const suffix = await bind("仅账号中段命中", "zzABC123");
  const prefix = await bind("规范化前缀", " A b C 123 ");
  const named = await bind("名称中段ABC123匹配", "name");
  for (const [q, ids] of [
    ["ABC", [prefix.channelAccountId, named.channelAccountId]],
    [" a B c ", [prefix.channelAccountId]],
    ["zzABC", [suffix.channelAccountId]],
  ] as const) {
    const filter = { storeId: h.merchant.store.id, q };
    const list = await h.health.list(h.staff, { ...filter, page: 1, pageSize: 20 });
    expect(list.items.map((item) => item.channelAccountId).sort()).toEqual([...ids].sort());
    expect(list.total).toBe(ids.length);
    expect(await h.health.summary(h.staff, filter)).toEqual({
      total: ids.length,
      pendingVerify: ids.length,
      available: 0,
      abnormal: 0,
      unbound: 0,
    });
  }
});
it("账号人工异常只改变健康状态、列表summary一致，真实订购引用仍阻止解绑", async () => {
  const h = await subject(),
    live = await h.launch();
  const reason = await h.prisma.dictItem.findFirstOrThrow({
    where: {
      dictTypeKey: "reject_reason",
      isEnabled: true,
      ext: { path: ["scene"], equals: "account_verify" },
    },
  });
  const result = await h.health.markAbnormal(h.adminCtx, h.staff, live.accountId, {
    reasonCode: reason.code,
    note: "账号人工核查异常",
  });
  expect(result).toMatchObject({ status: "abnormal", abnormalSource: "manual" });
  expect(await h.prisma.orderItem.findUnique({ where: { id: live.itemId } })).toMatchObject({
    phase: "live",
  });
  expect(await h.health.summary(h.staff, { storeId: h.merchant.store.id })).toEqual({
    total: 1,
    pendingVerify: 0,
    available: 0,
    abnormal: 1,
    unbound: 0,
  });
  expect(
    await h.health.list(h.staff, { storeId: h.merchant.store.id, page: 1, pageSize: 20 }),
  ).toMatchObject({ total: 1, items: [{ channelAccountId: live.accountId, status: "abnormal" }] });
  await expect(h.health.unbind(h.viewer, live.accountId)).rejects.toMatchObject({
    error: "CHANNEL_ACCOUNT_IN_USE",
  });
});
it("待审解绑通过真实审批系统撤回，原提交和证据保留，直接越权撤回仍拒绝", async () => {
  const h = await subject(),
    account = await h.bindAccount(false);
  await expect(
    h.runtime.tx.run((tx) =>
      h.runtime.approval.withdraw(
        tx,
        createIdentityContext({ actor: { type: "system", job: "lyxtest_untrusted" } }),
        { approvalId: account.sub.approvalRequestId, note: "非解绑调用" },
      ),
    ),
  ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
  expect(await h.health.unbind(h.viewer, account.id)).toMatchObject({ status: "unbound" });
  expect(
    await h.prisma.approvalRequest.findUnique({ where: { id: account.sub.approvalRequestId } }),
  ).toMatchObject({ status: "withdrawn", isDecidedBySystem: true });
  expect(
    await h.prisma.channelAccountSubmission.findUnique({ where: { id: account.sub.id } }),
  ).toMatchObject({ screenshotFileIds: account.sub.screenshotFileIds });
  expect(
    await h.prisma.timer.count({
      where: {
        subjectId: account.sub.approvalRequestId,
        status: { in: ["scheduled", "dispatched"] },
      },
    }),
  ).toBe(0);
  await expect(h.health.unbind(h.viewer, account.id)).rejects.toMatchObject({
    error: "STATE_NOT_ALLOWED",
  });
});
it("核验和解绑并发沿审批→账号锁序，只保留合法最终结果、零在途核验", async () => {
  const h = await subject(),
    account = await h.bindAccount(false);
  const results = await Promise.allSettled([
    h.publish.approveAccount(h.adminCtx, h.staff, account.sub.id, account.approvalBody),
    h.health.unbind(h.viewer, account.id),
  ]);
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  expect(await h.prisma.channelAccount.findUnique({ where: { id: account.id } })).toMatchObject({
    status: "unbound",
  });
  expect(
    await h.prisma.approvalRequest.findUnique({ where: { id: account.sub.approvalRequestId } }),
  ).not.toMatchObject({ status: "pending" });
  expect(
    await h.prisma.statusTransition.count({
      where: { subjectId: account.id, event: "account.unbind" },
    }),
  ).toBe(1);
});
it("跨店解绑拒绝，后台指定越范围storeId不能覆盖原范围；巡检列表summary同样受控", async () => {
  const h = await subject(),
    foreign = await subject(),
    account = await foreign.bindAccount();
  await expect(h.health.unbind(h.viewer, account.id)).rejects.toMatchObject({ error: "NOT_FOUND" });
  await h.launch();
  const other = await foreign.launch();
  await foreign.patrol.create(foreign.adminCtx, foreign.staff, { launchTaskId: other.taskId });
  const limited = await sampleStaffContext(h.prisma, h.publisher.id);
  expect(
    await h.health.list(limited, { storeId: foreign.merchant.store.id, page: 1, pageSize: 20 }),
  ).toMatchObject({ items: [], total: 0 });
  expect(await h.health.summary(limited, { storeId: foreign.merchant.store.id })).toMatchObject({
    total: 0,
    pendingVerify: 0,
    available: 0,
    abnormal: 0,
    unbound: 0,
  });
  expect(
    await h.patrol.list(limited, { storeId: foreign.merchant.store.id, page: 1, pageSize: 20 }),
  ).toMatchObject({ items: [], total: 0 });
  expect(await h.patrol.summary(limited, { storeId: foreign.merchant.store.id })).toMatchObject({
    all: 0,
    pending: 0,
  });
});
it("异常三日才真实创建经理系统待办，重复定时器去重，恢复同事务关闭并保原证据", async () => {
  const h = await subject(),
    live = await h.launch();
  const id = (await h.patrol.create(h.adminCtx, h.staff, { launchTaskId: live.taskId })).patrolTask
    .patrolTaskId;
  const kind = await h.prisma.dictItem.findFirstOrThrow({
    where: { dictTypeKey: "patrol_issue", isEnabled: true },
  });
  const evidence = await h.evidence();
  await h.patrol.decide(h.adminCtx, h.staff, id, "abnormal", {
    abnormalKindCode: kind.code,
    note: "未恢复异常",
    evidenceFileIds: [evidence],
  });
  const timer = await h.prisma.timer.findFirstOrThrow({
    where: { kind: "patrol.followup", subjectId: id },
  });
  expect(timer.fireAt.getTime() - stack.clock.now().getTime()).toBe(3 * 86400000);
  const fired = {
    id: timer.id,
    kind: timer.kind,
    subjectType: timer.subjectType,
    subjectId: id,
    payload: null,
  };
  await expect(h.runtime.tx.run((tx) => h.patrol.followup(tx, fired))).rejects.toMatchObject({
    error: "STATE_NOT_ALLOWED",
  });
  expect(await h.prisma.followUp.count({ where: { subjectId: id } })).toBe(0);
  stack.clock.advance(3 * 86400000);
  for (let replay = 0; replay < 2; replay++)
    expect(await h.runtime.tx.run((tx) => h.patrol.followup(tx, fired))).toBe("fired");
  const rows = await h.prisma.followUp.findMany({ where: { subjectId: id } });
  expect(rows).toHaveLength(1);
  expect(
    await h.prisma.auditLog.count({
      where: { action: "staff.follow_up.create", targetId: rows[0]!.id },
    }),
  ).toBe(1);
  const managerWork = await h.runtime.tx.run((tx) =>
    staffWorkSourcesOf(h.runtime.assembly).read(tx, {
      staffId: h.manager.id,
      now: stack.clock.now(),
    }),
  );
  expect(managerWork).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: "follow_up_owner",
        subjectId: rows[0]!.id,
        reassignOwner: "staff",
      }),
    ]),
  );
  const publisherWork = await h.runtime.tx.run((tx) =>
    staffWorkSourcesOf(h.runtime.assembly).read(tx, {
      staffId: h.publisher.id,
      now: stack.clock.now(),
    }),
  );
  expect(
    publisherWork.filter((r) => r.source === "ticket_publisher" && r.subjectId === live.ticketId),
  ).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    subjectType: "patrol_task",
    channel: "system",
    actorType: "system",
    actorId: null,
    client: null,
    ownerStaffId: h.manager.id,
    nextFollowAt: stack.clock.now(),
    doneAt: null,
  });
  await h.patrol.decide(h.adminCtx, h.staff, id, "recover", {
    ...(await h.checks("patrol.check")),
    evidenceFileIds: [await h.evidence()],
  });
  expect(await h.prisma.followUp.findUnique({ where: { id: rows[0]!.id } })).toMatchObject({
    doneAt: stack.clock.now(),
    doneNote: "巡检已复查恢复，关闭系统跟进",
  });
  expect(await h.runtime.tx.run((tx) => h.patrol.followup(tx, fired))).toBe("skipped");
  expect(await h.prisma.followUp.count({ where: { subjectId: id } })).toBe(1);
});
