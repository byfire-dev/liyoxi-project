import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sampleStaffContext, useSeededDatabase } from "../testing/index.js";
import { createIdentityContext, notifyReadOf, uuidv7 } from "../kernel/index.js";
import { decisionGuard } from "./write.js";
import { getLaunchFacts } from "./service.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
describe("publish 账号与上线真实事务", { timeout: 60000 }, () => {
  it("真实门店闸门和上传人；规范化账号两连接唯一", async () => {
    const blocked = await h.owner("blocked"),
      parallel = await h.owner("parallel"),
      full = await h.owner();
    const body = async (v: typeof blocked.viewer, uid: string) => ({
      platform: "douyin" as const,
      accountName: "测试号",
      accountUid: uid,
      accountType: "none" as const,
      screenshotFileIds: [(await h.screenshot(v)).id],
    });
    await expect(
      h.publish.bind(blocked.viewer, await body(blocked.viewer, "blocked")),
    ).rejects.toMatchObject({ error: "STORE_NOT_QUALIFIED" });
    await h.publish.bind(parallel.viewer, await body(parallel.viewer, "parallel"));
    const wrong = await body(full.viewer, "wrong");
    wrong.screenshotFileIds = [(await h.screenshot(parallel.viewer)).id];
    await expect(h.publish.bind(full.viewer, wrong)).rejects.toMatchObject({
      error: "FILE_NOT_USABLE",
    });
    const inputs = [await body(full.viewer, " DUP 001 "), await body(parallel.viewer, "dup001")];
    const results = await Promise.allSettled([
      h.publish.bind(full.viewer, inputs[0]!),
      h.publish.bind(parallel.viewer, inputs[1]!),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { error: "CHANNEL_ACCOUNT_TAKEN" },
    });
  });
  it("账号驳回、重提、核验，八行中的四行历史/审计和引用归档保留", async () => {
    const { viewer } = await h.owner(),
      admin = await h.staff(),
      f = await h.screenshot(viewer);
    const card = await h.publish.bind(viewer, {
      platform: "douyin",
      accountName: "完整账号",
      accountUid: "testhistory",
      accountType: "none",
      screenshotFileIds: [f.id],
    });
    const first = await h.prisma.channelAccountSubmission.findFirstOrThrow({
      where: { channelAccountId: card.channelAccountId },
    });
    const rows = (await h.approveBody(first.id)).compareRows;
    const notify = notifyReadOf(h.assembly);
    expect(
      await h.tx.run((tx) => notify.read(tx, "channelAccountForNotify", card.channelAccountId)),
    ).toMatchObject({ channelAccountId: card.channelAccountId, status: "pending_verify" });
    await h.publish.rejectAccount(admin.ctx, admin.staff, first.id, {
      reasonCode: "R12",
      note: "请补完整主页",
      compareRows: rows,
    });
    expect(
      await h.prisma.channelAccount.findUnique({ where: { id: card.channelAccountId } }),
    ).toMatchObject({
      status: "abnormal",
      abnormalSource: "verify",
      abnormalReasonCode: "R12",
      abnormalNote: "请补完整主页",
    });
    const f2 = await h.screenshot(viewer);
    await h.publish.resubmit(viewer, card.channelAccountId, {
      accountType: "none",
      screenshotFileIds: [f2.id],
    });
    const second = await h.prisma.channelAccountSubmission.findFirstOrThrow({
      where: { channelAccountId: card.channelAccountId, roundNo: 2 },
    });
    const bad = await h.approveBody(second.id);
    bad.compareRows[0]!.match = false;
    await expect(
      h.publish.approveAccount(admin.ctx, admin.staff, second.id, bad),
    ).rejects.toMatchObject({ error: "ACCOUNT_COMPARE_MISMATCH" });
    await h.publish.approveAccount(
      admin.ctx,
      admin.staff,
      second.id,
      await h.approveBody(second.id),
    );
    expect(
      await h.prisma.channelAccount.findUnique({ where: { id: card.channelAccountId } }),
    ).toMatchObject({
      status: "available",
      accountType: "none",
      abnormalSource: null,
      abnormalReasonCode: null,
      abnormalNote: null,
    });
    expect(
      await h.prisma.statusTransition.findMany({
        where: { subjectId: card.channelAccountId },
        orderBy: { occurredAt: "asc" },
      }),
    ).toHaveLength(4);
    expect(await h.prisma.auditLog.count({ where: { targetId: card.channelAccountId } })).toBe(4);
    expect(
      await h.prisma.fileRef.count({
        where: {
          refType: "channel_account_submission",
          fileId: { in: [f.id, f2.id] },
          releasedAt: null,
        },
      }),
    ).toBe(2);
    const events = await h.prisma.outboxEvent.findMany({
      where: { aggregateId: card.channelAccountId },
    });
    expect(events.map((e) => e.eventType).sort()).toEqual(
      ["account.abnormal", "account.submitted", "account.submitted", "account.verified"].sort(),
    );
    expect(
      await h.tx.run((tx) => notify.read(tx, "channelAccountForNotify", card.channelAccountId)),
    ).toMatchObject({ status: "available", reasonCode: null, note: null });
  });
  it("账号两财务式并发决定仅一次迁移", async () => {
    const { viewer } = await h.owner(),
      a = await h.staff(),
      b = await h.staff(),
      file = await h.screenshot(viewer);
    const card = await h.publish.bind(viewer, {
      platform: "wechat_channels",
      accountName: "并发号",
      accountUid: "concurrent",
      accountType: "none",
      screenshotFileIds: [file.id],
    });
    const round = await h.prisma.channelAccountSubmission.findFirstOrThrow({
        where: { channelAccountId: card.channelAccountId },
      }),
      body = await h.approveBody(round.id);
    const r = await Promise.allSettled([
      h.publish.approveAccount(a.ctx, a.staff, round.id, body),
      h.publish.rejectAccount(b.ctx, b.staff, round.id, {
        reasonCode: "R12",
        note: "补传",
        compareRows: body.compareRows,
      }),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.find((x) => x.status === "rejected")).toMatchObject({
      reason: { error: "APPROVAL_NOT_PENDING" },
    });
  });
  it("账号角色队列跨店可见；上线范围、本人工单、自审守卫与两人竞争", async () => {
    const { viewer } = await h.owner(),
      a = await h.make.staff({ staffRoleKey: "publisher" }),
      b = await h.make.staff({ staffRoleKey: "publisher" }),
      aStaff = await sampleStaffContext(h.prisma, a.id),
      bOwn = await sampleStaffContext(h.prisma, b.id),
      aCtx = createIdentityContext({ actor: { type: "staff", id: a.id, client: "admin" } }),
      bCtx = createIdentityContext({ actor: { type: "staff", id: b.id, client: "admin" } }),
      accountId = await h.account(viewer),
      accountRound = await h.prisma.channelAccountSubmission.findFirstOrThrow({
        where: { channelAccountId: accountId },
      });
    // 尚未分派任何该门店任务，账号核验仍按角色队列读；普通账号详情仍套门店范围。
    await h.publish.accountSubmission(bOwn, accountRound.id);
    await expect(h.publish.accountDetail(bOwn, accountId)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    const fixture = await h.tasks(viewer, [accountId]),
      id = fixture.ids[0]!;
    await h.prisma.deliveryTicket.update({
      where: { id: fixture.ticket.id },
      data: { publisherId: a.id },
    });
    await h.publish.submitLaunch(viewer, id, {
      linkKind: "collection",
      collectionUrl: "https://example.invalid/guard",
      reportedEpisodeCount: 3,
      actualLaunchDate: "2026-01-04",
    });
    const round = await h.prisma.launchSubmission.findFirstOrThrow({ where: { launchTaskId: id } }),
      body = await h.launchBody(round.id, 3),
      admin = await h.staff();
    await expect(h.publish.launchSubmission(bOwn, round.id)).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    const role = await h.prisma.staffRole.findUniqueOrThrow({ where: { key: "publisher" } });
    try {
      await h.prisma.staffRole.update({ where: { key: "publisher" }, data: { dataScope: "all" } });
      const bAll = await sampleStaffContext(h.prisma, b.id);
      await h.publish.launchSubmission(bAll, round.id);
      // 全量数据范围不免除 o 级的本人工单守卫，且它先于版本与回显。
      await expect(
        h.publish.approveLaunch(bCtx, bAll, round.id, { ...body, lockVersion: -1 }),
      ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    } finally {
      await h.prisma.staffRole.update({
        where: { key: "publisher" },
        data: { dataScope: role.dataScope },
      });
    }
    // 未来撤销后重开由员工送审；用真实 submit 建不可变的发起人事实，自审失败后整个事务回滚。
    await expect(
      h.tx.run(async (tx) => {
        const submissionId = uuidv7(),
          self = await h.approval.submit(tx, aCtx, {
            kind: "launch_link",
            subjectType: "launch_submission",
            subjectId: submissionId,
            entityId: viewer.membership.entityId,
            storeId: viewer.membership.storeId,
            deliveryTicketId: fixture.ticket.id,
            input: { submissionId, roundNo: 1, title: "自审守卫夹具" },
          });
        await decisionGuard(tx, aStaff, self.approvalId, { ...body, lockVersion: -1 }, true, id);
      }),
    ).rejects.toMatchObject({ error: "APPROVAL_SELF_FORBIDDEN" });
    await expect(
      h.publish.approveLaunch(aCtx, aStaff, round.id, { ...body, verifiedEpisodeCount: 4 }),
    ).rejects.toMatchObject({ error: "LAUNCH_VERIFY_COUNT_OUT_OF_RANGE" });
    expect(
      await h.prisma.approvalRequest.findUnique({ where: { id: round.approvalRequestId } }),
    ).toMatchObject({ status: "pending" });
    const results = await Promise.allSettled([
      h.publish.approveLaunch(aCtx, aStaff, round.id, body),
      h.publish.rejectLaunch(admin.ctx, admin.staff, round.id, {
        reasonCodes: ["R06"],
        note: "补证据",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { error: "APPROVAL_NOT_PENDING" },
    });
    expect(await h.prisma.statusTransition.count({ where: { subjectId: id } })).toBe(3);
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: id, eventType: { in: ["launch.verified", "launch.returned"] } },
      }),
    ).toBe(1);
  });
  it("两账号粒度、重复建任务、暂停/日期/链接/集数边界与累计核验", async () => {
    const { viewer } = await h.owner(),
      admin = await h.staff();
    const ids = [await h.account(viewer), await h.account(viewer, "wechat_channels")],
      fixture = await h.tasks(viewer, ids),
      taskId = fixture.ids[0]!;
    expect(fixture.ids).toHaveLength(2);
    expect(
      await h.tx.run((t) => h.publish.createLaunchTasks(t, viewer.ctx, fixture.input)),
    ).toEqual(fixture.ids);
    const body = {
      linkKind: "collection" as const,
      collectionUrl: "https://example.invalid/test",
      episodeUrls: [{ episodeNo: 1, url: "https://example.invalid/1" }],
      reportedEpisodeCount: 2,
      actualLaunchDate: "2026-01-04",
    };
    for (const [patch, error] of [
      [{ collectionUrl: "http://example.invalid" }, "LINK_INVALID"],
      [{ collectionUrl: "https://a:b@example.invalid" }, "LINK_INVALID"],
      [{ reportedEpisodeCount: 4 }, "LAUNCH_SUBMISSION_OUT_OF_RANGE"],
      [{ actualLaunchDate: "2026-01-01" }, "LAUNCH_SUBMISSION_OUT_OF_RANGE"],
      [{ actualLaunchDate: "2026-01-06" }, "LAUNCH_SUBMISSION_OUT_OF_RANGE"],
    ] as const)
      await expect(
        h.publish.submitLaunch(viewer, taskId, { ...body, ...patch }),
      ).rejects.toMatchObject({ error });
    await h.prisma.deliveryTicket.update({
      where: { id: fixture.ticket.id },
      data: { pauseCount: 1, pausedAt: h.clock.now() },
    });
    await expect(h.publish.submitLaunch(viewer, taskId, body)).rejects.toMatchObject({
      error: "TICKET_ON_HOLD",
    });
    await h.prisma.deliveryTicket.update({
      where: { id: fixture.ticket.id },
      data: { pauseCount: 0, pausedAt: null },
    });
    await h.publish.submitLaunch(viewer, taskId, body);
    let r = await h.prisma.launchSubmission.findFirstOrThrow({
      where: { launchTaskId: taskId, roundNo: 1 },
    });
    expect(r).toMatchObject({ collectionUrl: body.collectionUrl, episodeUrls: body.episodeUrls });
    expect(h.changes.at(-1)).toMatchObject({ hasVerifying: true, hasLive: false });
    await h.publish.approveLaunch(admin.ctx, admin.staff, r.id, await h.launchBody(r.id, 2));
    const first = await h.prisma.launchTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(first).toMatchObject({
      reviewStatus: "passed",
      isLive: true,
      verifiedEpisodeCount: 2,
      completedAt: null,
    });
    await h.publish.submitLaunch(viewer, taskId, {
      ...body,
      reportedEpisodeCount: 3,
      actualLaunchDate: "2026-01-03",
    });
    r = await h.prisma.launchSubmission.findFirstOrThrow({
      where: { launchTaskId: taskId, roundNo: 2 },
    });
    await h.publish.rejectLaunch(admin.ctx, admin.staff, r.id, {
      reasonCodes: ["R06"],
      note: "请补充链接",
    });
    expect(await h.prisma.launchTask.findUnique({ where: { id: taskId } })).toMatchObject({
      reviewStatus: "need_fix",
      isLive: true,
      verifiedEpisodeCount: 2,
    });
    await h.prisma.deliveryTicket.update({
      where: { id: fixture.ticket.id },
      data: { pauseCount: 0, pausedAt: null },
    });
    await h.publish.submitLaunch(viewer, taskId, {
      ...body,
      reportedEpisodeCount: 3,
      actualLaunchDate: "2026-01-02",
    });
    r = await h.prisma.launchSubmission.findFirstOrThrow({
      where: { launchTaskId: taskId, roundNo: 3 },
    });
    await h.publish.approveLaunch(admin.ctx, admin.staff, r.id, await h.launchBody(r.id, 3));
    const full = await h.prisma.launchTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(full.completedAt).not.toBeNull();
    expect(full.wentLiveAt).toEqual(first.wentLiveAt);
    expect(full.firstLaunchDate?.toISOString().slice(0, 10)).toBe("2026-01-02");
    expect(h.changes.at(-1)).toMatchObject({
      hasLive: true,
      liveEpisodeCount: 3,
      firstLaunchDate: "2026-01-02",
    });
    expect(
      await h.tx.run((tx) => notifyReadOf(h.assembly).read(tx, "launchTaskForNotify", taskId)),
    ).toMatchObject({ isLive: true, verifiedEpisodeCount: 3, firstLaunchDate: "2026-01-02" });
    expect(
      await h.prisma.statusTransition.count({
        where: { subjectId: taskId, stateField: "review_status" },
      }),
    ).toBe(7);
    expect(await h.prisma.auditLog.count({ where: { targetId: taskId } })).toBe(7);
    expect(
      (await h.prisma.outboxEvent.findMany({ where: { aggregateId: taskId } }))
        .map((e) => e.eventType)
        .sort(),
    ).toEqual(
      [
        "launch.created",
        "launch.submitted",
        "launch.verified",
        "launch.submitted",
        "launch.returned",
        "launch.submitted",
        "launch.verified",
      ].sort(),
    );
  });
});
it("部分上线参数假、暂停核验仍可退回；游标稳定且绑定筛选", { timeout: 60000 }, async () => {
  const { viewer } = await h.owner(),
    admin = await h.staff(),
    accountIds = [await h.account(viewer), await h.account(viewer, "wechat_channels")],
    fixture = await h.tasks(viewer, accountIds),
    id = fixture.ids[0]!;
  h.clock.advance(1000);
  await h.prisma.paramValue.create({
    data: {
      id: (await import("../kernel/index.js")).uuidv7(),
      key: "launch.partial_goes_live",
      value: false,
      effectiveAt: h.clock.now(),
      createdAt: h.clock.now(),
      createdByStaffId: admin.row.id,
    },
  });
  const body = {
    linkKind: "episodes" as const,
    collectionUrl: "https://example.invalid/collection",
    episodeUrls: [{ episodeNo: 1, url: "https://example.invalid/1" }],
    reportedEpisodeCount: 1,
    actualLaunchDate: "2026-01-04",
  };
  await h.publish.submitLaunch(viewer, id, body);
  let round = await h.prisma.launchSubmission.findFirstOrThrow({
    where: { launchTaskId: id, roundNo: 1 },
  });
  expect(round).toMatchObject({ collectionUrl: body.collectionUrl, episodeUrls: body.episodeUrls });
  await h.prisma.deliveryTicket.update({
    where: { id: fixture.ticket.id },
    data: { pauseCount: 1, pausedAt: h.clock.now() },
  });
  await expect(
    h.publish.approveLaunch(admin.ctx, admin.staff, round.id, await h.launchBody(round.id, 1)),
  ).rejects.toMatchObject({ error: "TICKET_ON_HOLD" });
  await h.publish.rejectLaunch(admin.ctx, admin.staff, round.id, {
    reasonCodes: ["R06"],
    note: "暂停期间可退回",
  });
  await h.prisma.deliveryTicket.update({
    where: { id: fixture.ticket.id },
    data: { pauseCount: 0, pausedAt: null },
  });
  await h.publish.submitLaunch(viewer, id, body);
  round = await h.prisma.launchSubmission.findFirstOrThrow({
    where: { launchTaskId: id, roundNo: 2 },
  });
  await h.publish.approveLaunch(admin.ctx, admin.staff, round.id, await h.launchBody(round.id, 1));
  expect(await h.prisma.launchTask.findUnique({ where: { id } })).toMatchObject({
    reviewStatus: "passed",
    isLive: false,
    wentLiveAt: null,
    completedAt: null,
    verifiedEpisodeCount: 1,
  });
  const facts = () => h.tx.run((tx) => getLaunchFacts(tx, fixture.item.id));
  expect(await facts()).toMatchObject({
    hasLive: false,
    liveEpisodeCount: 1,
    firstLaunchDate: null,
  });
  expect(h.changes.at(-1)).toMatchObject({
    hasLive: false,
    liveEpisodeCount: 1,
    firstLaunchDate: null,
  });
  // 补充核验累计集数，未满集仍不触发部分上线。
  await h.publish.submitLaunch(viewer, id, { ...body, reportedEpisodeCount: 2 });
  round = await h.prisma.launchSubmission.findFirstOrThrow({
    where: { launchTaskId: id, roundNo: 3 },
  });
  await h.publish.approveLaunch(admin.ctx, admin.staff, round.id, await h.launchBody(round.id, 2));
  expect(await facts()).toMatchObject({
    hasLive: false,
    liveEpisodeCount: 2,
    firstLaunchDate: null,
  });
  // 多账号取最大值，不能求和；首日只取已上线任务。
  const otherId = fixture.ids[1]!;
  await h.publish.submitLaunch(viewer, otherId, {
    ...body,
    reportedEpisodeCount: 3,
    actualLaunchDate: "2026-01-03",
  });
  const otherRound = await h.prisma.launchSubmission.findFirstOrThrow({
    where: { launchTaskId: otherId, roundNo: 1 },
  });
  await h.publish.approveLaunch(
    admin.ctx,
    admin.staff,
    otherRound.id,
    await h.launchBody(otherRound.id, 3),
  );
  expect(await facts()).toMatchObject({
    hasLive: true,
    liveEpisodeCount: 3,
    firstLaunchDate: "2026-01-03",
  });
  // 后续里程碑才实现作废；此处直接写入符合 CHECK 的归档行，验证读侧排除。
  await h.prisma.launchTask.update({
    where: { id: otherId },
    data: {
      reviewStatus: "void",
      voidReason: "account_changed",
      isLive: false,
      wentLiveAt: null,
      completedAt: null,
    },
  });
  const withoutVoid = await facts();
  expect(withoutVoid).toMatchObject({
    hasLive: false,
    liveEpisodeCount: 2,
    firstLaunchDate: null,
  });
  expect(withoutVoid.accounts.map((account) => account.channelAccountId)).toEqual([accountIds[0]]);
  await expect(
    h.publish.submitLaunch(viewer, id, {
      ...body,
      episodeUrls: [
        { episodeNo: 1, url: "https://example.invalid/1" },
        { episodeNo: 1, url: "https://example.invalid/2" },
      ],
    }),
  ).rejects.toMatchObject({ error: "LINK_INVALID" });
  await h.prisma.orderItem.update({
    where: { id: fixture.item.id },
    data: { usageEndDate: new Date("2026-01-04") },
  });
  await expect(h.publish.submitLaunch(viewer, id, body)).rejects.toMatchObject({
    error: "LAUNCH_WINDOW_CLOSED",
  });
  await h.account(viewer, "wechat_channels");
  const first = await h.publish.channelAccounts(viewer, { limit: 1 });
  expect(first.hasMore).toBe(true);
  const second = await h.publish.channelAccounts(viewer, { limit: 1, cursor: first.nextCursor! });
  expect(second.items[0]!.channelAccountId).not.toBe(first.items[0]!.channelAccountId);
  await expect(
    h.publish.channelAccounts(viewer, { limit: 1, cursor: first.nextCursor!, platform: "douyin" }),
  ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
  h.clock.advance(1000);
  await h.prisma.paramValue.create({
    data: {
      id: (await import("../kernel/index.js")).uuidv7(),
      key: "launch.partial_goes_live",
      value: true,
      effectiveAt: h.clock.now(),
      createdAt: h.clock.now(),
      createdByStaffId: admin.row.id,
    },
  });
});
