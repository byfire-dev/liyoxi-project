import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LaunchCalendarSchema,
  LaunchSubmissionDetailSchema,
  LaunchTrackPageSchema,
  LaunchTrackSummarySchema,
  PortalTicketCreatedSchema,
  PortalTicketExchangeResultSchema,
  PublishListAdminViewSchema,
  PublishListImportResultSchema,
  PublishListSaveResultSchema,
  PublishListViewSchema,
  EVENT_PAYLOAD_SCHEMAS,
} from "@liyoxi/contract";
import type { PublishListReplaceBody } from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import {
  assertSnapshotsEqual,
  createPublishWorkbenchFixture,
  openSealed,
  signInAsStaff,
  snapshotTables,
  TEST_KEYRING,
} from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi, TestRequestInit } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";

const handle = useTestApi();
const origin = "https://portal.example.invalid";
let api: TestApi;
let h: ReturnType<typeof createPublishWorkbenchFixture>;
let released: Awaited<ReturnType<typeof h.release>>;
let otherReleased: Awaited<ReturnType<typeof h.release>>;
let owner: SignedInMerchant;
let otherOwner: SignedInMerchant;
let clerk: SignedInMerchant;
let admin: SignedInStaff;
let publisher: SignedInStaff;
let cs: SignedInStaff;
let peer = 0;

const routes = [
  ["admin.deliveryTicket.publishList.get", "GET", "/admin/delivery-tickets/:id/publish-list"],
  ["admin.deliveryTicket.publishList.replace", "PUT", "/admin/delivery-tickets/:id/publish-list"],
  [
    "admin.deliveryTicket.publishList.import",
    "POST",
    "/admin/delivery-tickets/:id/publish-list/import",
  ],
  ["m.orderItem.publishList.get", "GET", "/m/order-items/:id/publish-list"],
  ["portal.orderItem.publishList.get", "GET", "/portal/order-items/:id/publish-list"],
  ["admin.launchCalendar.get", "GET", "/admin/launch-calendar"],
  ["admin.launchTask.list", "GET", "/admin/launch-tasks"],
  ["admin.launchTask.summary", "GET", "/admin/launch-tasks/summary"],
  ["admin.launchSubmission.revoke", "POST", "/admin/launch-submissions/:id/revoke"],
] as const;

const businessTables = [
  "drama_order",
  "order_item",
  "delivery_ticket",
  "delivery_release",
  "episode_output",
  "publish_list",
  "publish_list_episode",
  "launch_task",
  "launch_submission",
  "approval_request",
  "file_object",
  "file_ref",
  "zip_bundle",
  "delivery_download_log",
  "status_transition",
  "outbox_event",
  "audit_log",
];

async function call(path: string, init: TestRequestInit = {}) {
  return api.request(`/api/v1${path}`, {
    peer: `198.19.115.${(peer++ % 240) + 1}`,
    ...init,
  });
}

async function request(
  op: (typeof routes)[number][0],
  options: {
    id?: string;
    query?: string;
    json?: unknown;
    headers?: Record<string, string>;
    key?: string;
  } = {},
) {
  const [, method, path] = routes.find(([operation]) => operation === op)!;
  const headers =
    options.headers ??
    (op.startsWith("admin.") ? admin.headers : owner.withStore(released.o.store.id));
  return call(`${path.replace(":id", options.id ?? released.id)}${options.query ?? ""}`, {
    method,
    headers: {
      ...headers,
      ...(method === "GET" ? {} : { "Idempotency-Key": options.key ?? uuidv7() }),
    },
    ...(options.json === undefined ? {} : { json: options.json }),
  });
}

async function data(response: Response): Promise<unknown> {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: unknown }).data;
}

async function failure(response: Response, status: number, error: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error });
}

async function consumeLicenseFact(type: "order.item.went_live" | "order.item.live_revoked") {
  const event = await h.prisma.outboxEvent.findFirstOrThrow({
    where: { eventType: type, aggregateId: released.item.id },
    orderBy: { occurredAt: "desc" },
  });
  const consumer = api.runtime.assembly.subscriber("docs.onLicenseFacts")!;
  expect(consumer.events).toContain(type);
  await api.runtime.tx.run((tx) =>
    consumer.handle(tx, {
      id: event.id,
      type,
      payload: EVENT_PAYLOAD_SCHEMAS[type].parse(event.payload),
    }),
  );
  return h.prisma.licenseLetter.findMany({
    where: { orderItemId: released.item.id, status: { not: "voided" } },
    orderBy: { createdAt: "desc" },
  });
}

async function portalLogin() {
  const headers = { Origin: origin, "X-LYX-Portal": "1" };
  const ticket = PortalTicketCreatedSchema.parse(
    await data(
      await call("/portal/portal-tickets", {
        method: "POST",
        headers,
        json: {},
      }),
    ),
  );
  await data(
    await call(`/m/portal-tickets/${ticket.portalTicketId}/approve`, {
      method: "POST",
      headers: { ...owner.withStore(released.o.store.id), "Idempotency-Key": uuidv7() },
      json: { pairDigits: ticket.pairDigits },
    }),
  );
  const exchanged = await call(`/portal/portal-tickets/${ticket.portalTicketId}/exchange`, {
    method: "POST",
    headers,
    json: { pollSecret: ticket.pollSecret },
  });
  expect(PortalTicketExchangeResultSchema.parse(await data(exchanged)).status).toBe("consumed");
  const cookie = exchanged.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toMatch(/^__Host-lyx_portal=/);
  return { Cookie: cookie! };
}

beforeAll(async () => {
  api = await handle.start({ merchantKeyring: TEST_KEYRING, portalPublicOrigin: origin });
  const prisma = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  h = createPublishWorkbenchFixture(prisma);
  // The shared public fixture runs the actual sample/QC/approval/push writers; neither HTTP
  // test nor fixture fabricates a successful delivery release or a passed launch submission.
  released = await h.release();
  otherReleased = await h.release();
  api.clock.set(h.clock.now());
  owner = await signInAsMerchant(api, {
    phone: openSealed("merchant_user.phone_enc", released.o.user.phoneEnc!),
  });
  otherOwner = await signInAsMerchant(api, {
    phone: openSealed("merchant_user.phone_enc", otherReleased.o.user.phoneEnc!),
  });
  expect(owner.merchantUserId).toBe(released.o.user.id);
  expect(otherOwner.merchantUserId).toBe(otherReleased.o.user.id);
  clerk = await signInAsMerchant(api);
  const member = await h.make.entityMember({
    entityId: released.o.entity.id,
    merchantUserId: clerk.merchantUserId,
  });
  await h.make.storeMember({
    entityMemberId: member.id,
    storeId: released.o.store.id,
    addedByMemberId: released.o.member.id,
  });
  admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  publisher = await signInAsStaff(prisma, { roleKey: "publisher", now: api.clock.now() });
  cs = await signInAsStaff(prisma, { roleKey: "cs", now: api.clock.now() });
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe("W6-02 发布清单与上线工作台九条真实 HTTP API", { timeout: 60_000 }, () => {
  it("九条真实挂载；推包后的清单保存、同键重放、版本冲突和导入全失败回滚", async () => {
    expect(api.api.mountedOperations).toEqual(expect.arrayContaining(routes.map(([op]) => op)));
    const initial = PublishListAdminViewSchema.parse(
      await data(await request("admin.deliveryTicket.publishList.get")),
    );
    expect(initial).toMatchObject({
      isEditable: true,
      activeRelease: { deliveryReleaseId: released.release.deliveryReleaseId, releaseNo: 1 },
    });
    const body: PublishListReplaceBody = {
      lockVersion: initial.lockVersion,
      collectionName: "HTTP 发布合集",
      coverFileId: initial.cover?.fileId ?? null,
      titleTemplate: "{剧名} 第{集数}集",
      topics: ["#悬疑"],
      intro: "HTTP 真实保存简介",
      episodes: [
        {
          episodeNo: 1,
          title: "HTTP 保存标题",
          highlight: "第一集看点",
          topics: ["#追剧"],
          intro: "逐集简介",
        },
      ],
    };
    const key = uuidv7();
    const saved = PublishListSaveResultSchema.parse(
      await data(await request("admin.deliveryTicket.publishList.replace", { json: body, key })),
    );
    expect(saved).toMatchObject({
      replayed: false,
      lockVersion: initial.lockVersion + 1,
      topics: ["悬疑"],
      episodes: [{ episodeNo: 1, title: "HTTP 保存标题", topics: ["追剧"] }],
    });
    const afterSave = await snapshotTables(h.prisma, businessTables);
    const replay = PublishListSaveResultSchema.parse(
      await data(await request("admin.deliveryTicket.publishList.replace", { json: body, key })),
    );
    expect(replay).toMatchObject({ replayed: true, lockVersion: saved.lockVersion });
    if (replay.cover) expect(replay.cover).toMatchObject({ url: null, expiresAt: null });
    assertSnapshotsEqual(afterSave, await snapshotTables(h.prisma, businessTables));
    await failure(
      await request("admin.deliveryTicket.publishList.replace", { json: body }),
      409,
      "VERSION_CONFLICT",
    );
    const invalid = await request("admin.deliveryTicket.publishList.import", {
      json: {
        lockVersion: saved.lockVersion,
        format: "csv",
        content: "集号,标题\n1,不得部分保存\n2,越界",
      },
    });
    expect(invalid.status, await invalid.clone().text()).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: "PUBLISH_LIST_IMPORT_INVALID",
      details: {
        rows: [
          { rowNo: 1, episodeNo: null, column: "content", message: "数据行数须为 1 到 1" },
          { rowNo: 3, episodeNo: 2, column: "集号", message: "集号须为 1 到 1 的整数" },
        ],
      },
    });
    assertSnapshotsEqual(afterSave, await snapshotTables(h.prisma, businessTables));
    const imported = PublishListImportResultSchema.parse(
      await data(
        await request("admin.deliveryTicket.publishList.import", {
          json: {
            lockVersion: saved.lockVersion,
            format: "csv",
            content: "集号,标题\n1,HTTP 导入标题",
          },
        }),
      ),
    );
    expect(imported).toMatchObject({
      replayed: false,
      importedRowCount: 1,
      updatedEpisodeNos: [1],
      publishList: {
        lockVersion: saved.lockVersion + 1,
        episodes: [
          {
            episodeNo: 1,
            title: "HTTP 导入标题",
            highlight: "第一集看点",
            topics: ["追剧"],
            intro: "逐集简介",
          },
        ],
      },
    });
    expect(
      await h.prisma.deliveryRelease.findUnique({
        where: { id: released.release.deliveryReleaseId },
      }),
    ).toMatchObject({ state: "pushed", publishListText: expect.stringContaining("HTTP 导入标题") });
  });

  it("六个 GET 真实投影、no-store 与零写；后台工单范围、商家/Portal 跨店和店员权限", async () => {
    const portalHeaders = await portalLogin();
    const tables = [
      ...businessTables,
      "portal_ticket",
      "portal_session",
      "auth_event",
      "idempotency_record",
    ];
    const before = await snapshotTables(h.prisma, tables);
    const adminListResponse = await request("admin.deliveryTicket.publishList.get");
    const adminList = PublishListAdminViewSchema.parse(await data(adminListResponse));
    const calendarResponse = await request("admin.launchCalendar.get", { query: "?month=2026-01" });
    const calendar = LaunchCalendarSchema.parse(await data(calendarResponse));
    const listResponse = await request("admin.launchTask.list", {
      query: `?tab=all&orderItemId=${released.item.id}`,
    });
    const list = LaunchTrackPageSchema.parse(await data(listResponse));
    const summaryResponse = await request("admin.launchTask.summary", {
      query: `?days=30&orderItemId=${released.item.id}`,
    });
    const summary = LaunchTrackSummarySchema.parse(await data(summaryResponse));
    const merchantResponse = await request("m.orderItem.publishList.get", { id: released.item.id });
    const merchant = PublishListViewSchema.parse(await data(merchantResponse));
    const portalResponse = await request("portal.orderItem.publishList.get", {
      id: released.item.id,
      headers: portalHeaders,
    });
    const portal = PublishListViewSchema.parse(await data(portalResponse));
    for (const response of [
      adminListResponse,
      calendarResponse,
      listResponse,
      summaryResponse,
      merchantResponse,
      portalResponse,
    ])
      expect(response.headers.get("cache-control")).toBe("no-store");
    expect(adminList.episodes[0]?.title).toBe("HTTP 导入标题");
    expect(calendar.days.flatMap((day) => day.items).map((item) => item.orderItemId)).toEqual(
      expect.arrayContaining([released.item.id, otherReleased.item.id]),
    );
    expect(calendar.stats.total).toBe(2);
    expect(list).toMatchObject({
      total: 1,
      items: [
        {
          orderItem: { orderItemId: released.item.id },
          isDelivered: true,
          tasks: [{ reviewStatus: "pending" }],
        },
      ],
    });
    expect(summary).toMatchObject({ all: 1, upcoming: 1, deliveringSoon: 0, overdue: 0 });
    expect(merchant.text).toContain("HTTP 导入标题");
    expect(portal).toEqual(merchant);
    expect(merchant.episodes).toEqual([
      {
        episodeNo: 1,
        title: "HTTP 导入标题",
        topics: ["追剧"],
        intro: "逐集简介",
        isUpdated: false,
      },
    ]);
    // Both sides have an actual pushed release: 404 proves scope rather than missing delivery.
    expect(
      PublishListViewSchema.parse(
        await data(
          await request("m.orderItem.publishList.get", {
            id: otherReleased.item.id,
            headers: otherOwner.withStore(otherReleased.o.store.id),
          }),
        ),
      ).orderItemId,
    ).toBe(otherReleased.item.id);
    for (const op of ["m.orderItem.publishList.get", "portal.orderItem.publishList.get"] as const) {
      await failure(
        await request(op, {
          id: otherReleased.item.id,
          headers: op.startsWith("portal.") ? portalHeaders : owner.withStore(released.o.store.id),
        }),
        404,
        "NOT_FOUND",
      );
    }
    await failure(
      await request("m.orderItem.publishList.get", {
        id: released.item.id,
        headers: clerk.withStore(released.o.store.id),
      }),
      403,
      "ROLE_FORBIDDEN",
    );
    await failure(
      await request("portal.orderItem.publishList.get", { id: released.item.id, headers: {} }),
      401,
      "AUTH_REQUIRED",
    );
    await failure(
      await request("admin.deliveryTicket.publishList.get", { headers: publisher.headers }),
      404,
      "NOT_FOUND",
    );
    const hidden = LaunchTrackPageSchema.parse(
      await data(
        await request("admin.launchTask.list", {
          headers: publisher.headers,
          query: `?tab=all&orderItemId=${released.item.id}`,
        }),
      ),
    );
    expect(hidden).toMatchObject({ total: 0, items: [] });
    const hiddenSummary = LaunchTrackSummarySchema.parse(
      await data(
        await request("admin.launchTask.summary", {
          headers: publisher.headers,
          query: `?orderItemId=${released.item.id}`,
        }),
      ),
    );
    expect(hiddenSummary).toMatchObject({
      all: 0,
      overdue: 0,
      upcoming: 0,
      last30Days: { overdueItemCount: 0, liveItemCount: 0 },
    });
    const hiddenCalendar = LaunchCalendarSchema.parse(
      await data(
        await request("admin.launchCalendar.get", {
          headers: publisher.headers,
          query: "?month=2026-01",
        }),
      ),
    );
    expect(hiddenCalendar).toMatchObject({ total: 0, days: [], stats: { total: 0 } });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  });

  it("写权限和严格查询校验不被业务可见性绕过", async () => {
    const initial = PublishListAdminViewSchema.parse(
      await data(await request("admin.deliveryTicket.publishList.get")),
    );
    await failure(
      await request("admin.deliveryTicket.publishList.import", {
        headers: cs.headers,
        json: {
          lockVersion: initial.lockVersion,
          format: "tsv",
          content: "集号\t标题\n1\t不可保存",
        },
      }),
      403,
      "PERMISSION_DENIED",
    );
    await failure(
      await request("admin.launchSubmission.revoke", {
        id: uuidv7(),
        headers: publisher.headers,
        json: { reason: "没有撤销权限", confirm: { roundNo: 1, verifiedEpisodeCount: 1 } },
      }),
      403,
      "PERMISSION_DENIED",
    );
    expect(
      (
        await request("admin.launchCalendar.get", {
          query: "?month=2026-01&from=2026-01-01&to=2026-01-02",
        })
      ).status,
    ).toBe(400);
    expect((await request("admin.launchTask.list", { query: "?readyOnly=invalid" })).status).toBe(
      400,
    );
    expect((await request("admin.launchTask.summary", { query: "?days=31" })).status).toBe(400);
  });

  it("真实 HTTP 提交与核验后撤销成功：旧审批保留、新轮重开、订单回退和同键重放", async () => {
    const task = await h.prisma.launchTask.findFirstOrThrow({
      where: { deliveryTicketId: released.id },
    });
    await data(
      await call(`/m/launch-tasks/${task.id}/submit`, {
        method: "POST",
        headers: { ...owner.withStore(released.o.store.id), "Idempotency-Key": uuidv7() },
        json: {
          linkKind: "collection",
          collectionUrl: "https://example.invalid/m6-http-launch",
          reportedEpisodeCount: 1,
          actualLaunchDate: "2026-01-05",
        },
      }),
    );
    const submission = await h.prisma.launchSubmission.findFirstOrThrow({
      where: { launchTaskId: task.id },
      include: { approvalRequest: true },
    });
    const approved = LaunchSubmissionDetailSchema.parse(
      await data(
        await call(`/admin/launch-submissions/${submission.id}/approve`, {
          method: "POST",
          headers: { ...admin.headers, "Idempotency-Key": uuidv7() },
          json: {
            lockVersion: submission.approvalRequest.lockVersion,
            confirm: { roundNo: 1, reportedEpisodeCount: 1 },
            verifiedEpisodeCount: 1,
            ...(await h.checks("launch.verify")),
          },
        }),
      ),
    );
    expect(approved).toMatchObject({
      result: "passed",
      task: { isLive: true },
      orderItem: { phase: "live" },
      ticket: { step: "in_service" },
    });
    expect(
      (await consumeLicenseFact("order.item.went_live")).filter(
        (letter) => letter.status !== "superseded",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "effective", periodStart: new Date("2026-01-05") }),
      ]),
    );
    const locked = PublishListAdminViewSchema.parse(
      await data(await request("admin.deliveryTicket.publishList.get")),
    );
    expect(locked).toMatchObject({ isEditable: false, lockReason: "links_submitted" });
    await failure(
      await request("admin.deliveryTicket.publishList.import", {
        json: { lockVersion: locked.lockVersion, format: "csv", content: "集号,标题\n1,不可再改" },
      }),
      409,
      "PUBLISH_LIST_LOCKED",
    );
    const body = {
      reason: "HTTP 复核发现上线链接需重新确认",
      confirm: { roundNo: 1, verifiedEpisodeCount: 1 },
    };
    await failure(
      await request("admin.launchSubmission.revoke", {
        id: submission.id,
        json: { ...body, confirm: { roundNo: 2, verifiedEpisodeCount: 1 } },
      }),
      409,
      "CONFIRM_MISMATCH",
    );
    const key = uuidv7();
    const reopened = LaunchSubmissionDetailSchema.parse(
      await data(
        await request("admin.launchSubmission.revoke", { id: submission.id, json: body, key }),
      ),
    );
    expect(reopened).toMatchObject({
      roundNo: 2,
      result: "pending",
      reopenOfLaunchSubmissionId: submission.id,
      task: { reviewStatus: "verifying", isLive: false },
      orderItem: { phase: "to_launch", liveEpisodeCount: 0 },
      ticket: { step: "launch_verify" },
    });
    expect(reopened.link).toEqual(approved.link);
    expect(
      await h.prisma.launchSubmission.findUnique({ where: { id: submission.id } }),
    ).toMatchObject({ result: "revoked" });
    expect(
      await h.prisma.approvalRequest.findUnique({ where: { id: submission.approvalRequestId } }),
    ).toMatchObject({ status: "approved" });
    const newSubmission = await h.prisma.launchSubmission.findUniqueOrThrow({
      where: { id: reopened.launchSubmissionId },
      include: { approvalRequest: true },
    });
    expect(newSubmission.approvalRequest).toMatchObject({
      status: "pending",
      requesterStaffId: admin.staff.id,
    });
    expect(newSubmission.approvalRequest.dedupeKey).toBe(`launch_link:${task.id}`);
    expect(newSubmission.approvalRequest.dueAt).toBeInstanceOf(Date);
    expect(
      await h.prisma.timer.findFirst({
        where: {
          subjectType: "approval_request",
          subjectId: newSubmission.approvalRequestId,
          kind: "sla.breach",
          status: "scheduled",
        },
      }),
    ).not.toBeNull();
    expect(await h.prisma.deliveryTicket.findUnique({ where: { id: released.id } })).toMatchObject({
      step: "launch_verify",
      liveAt: null,
    });
    expect(await h.prisma.orderItem.findUnique({ where: { id: released.item.id } })).toMatchObject({
      phase: "to_launch",
      usageStartDate: null,
      liveEpisodeCount: 0,
    });
    const currentLetters = (await consumeLicenseFact("order.item.live_revoked")).filter(
      (letter) => letter.status !== "superseded",
    );
    expect(currentLetters).not.toHaveLength(0);
    expect(
      currentLetters.every(
        (letter) => letter.status === "pending_effective" && letter.periodStart === null,
      ),
    ).toBe(true);
    const afterRevoke = await snapshotTables(h.prisma, businessTables);
    const replay = LaunchSubmissionDetailSchema.parse(
      await data(
        await request("admin.launchSubmission.revoke", { id: submission.id, json: body, key }),
      ),
    );
    expect(replay).toEqual(reopened);
    assertSnapshotsEqual(afterRevoke, await snapshotTables(h.prisma, businessTables));
    expect(
      await h.prisma.launchSubmission.count({
        where: { reopenOfLaunchSubmissionId: submission.id },
      }),
    ).toBe(1);
    const current = LaunchTrackPageSchema.parse(
      await data(
        await request("admin.launchTask.list", {
          query: `?tab=all&orderItemId=${released.item.id}`,
        }),
      ),
    );
    expect(current.items[0]?.tasks[0]).toMatchObject({
      currentSubmissionId: reopened.launchSubmissionId,
      latestPassedSubmissionId: null,
      reviewStatus: "verifying",
    });
  });
});
