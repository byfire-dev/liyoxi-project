import { expect, it } from "vitest";
import { writeIntent } from "../../system/staff-access";
import { denied, id, ok, transport } from "../calendar/test-fixture";
import { createOverdueApi } from "./api";
import { overdueSearch, trackFilters, trackQuery } from "./model";
it("实际list和summary路径使用相同筛选，独立总数不来自当前页", async () => {
  const stats = {
    overdue: 8,
    upcoming: 3,
    deliveringSoon: 2,
    all: 14,
    last30Days: { overdueItemCount: 9, avgOverdueDays: 1.5, liveItemCount: 4 },
  };
  const t = transport((request) =>
      ok(request.url.includes("summary") ? stats : { items: [], page: 2, pageSize: 20, total: 8 }),
    ),
    api = createOverdueApi(t);
  const search = overdueSearch({
    tab: "overdue",
    page: 2,
    managerId: id(1),
    readyOnly: true,
    q: "虚构",
  });
  const controller = new AbortController();
  expect((await api.list(trackQuery(search), controller.signal)).total).toBe(8);
  expect(await api.summary(trackFilters(search), controller.signal)).toEqual(stats);
  const list = new URL(t.requests[0]!.url),
    summary = new URL(t.requests[1]!.url);
  expect(list.pathname).toBe("/api/v1/admin/launch-tasks");
  expect(summary.pathname).toBe("/api/v1/admin/launch-tasks/summary");
  for (const key of ["tab", "page", "pageSize"]) list.searchParams.delete(key);
  expect(Object.fromEntries(list.searchParams)).toEqual(Object.fromEntries(summary.searchParams));
  controller.abort();
  expect(t.requests.every((request) => request.signal.aborted)).toBe(true);
});
it("跟进/提醒真实正文与中央幂等头，同意图双提交只发一条写入", async () => {
  let release!: (value: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const t = transport(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
        entered();
      }),
  );
  const api = createOverdueApi(t),
    intent = writeIntent("follow", () => "one-follow-intent");
  const body = { subjectType: "order_item" as const, subjectId: id(2), content: "已沟通" };
  const first = intent.run(body, (key) => api.follow(body, key));
  await expect(intent.run(body, (key) => api.follow(body, key))).resolves.toBeUndefined();
  await started;
  expect(t.requests).toHaveLength(1);
  release(
    ok({
      followUpId: id(3),
      subjectType: "order_item",
      subjectId: id(2),
      entityId: id(4),
      storeId: id(5),
      channel: null,
      content: "已沟通",
      intent: null,
      nextFollowAt: null,
      isOpen: false,
      owner: null,
      doneAt: null,
      doneNote: null,
      recorder: { actorType: "system", staff: null },
      createdAt: "2026-10-01T00:00:00.000Z",
      lockVersion: 0,
      actions: [],
    }),
  );
  await first;
  expect(await t.requests[0]!.clone().json()).toEqual(body);
  expect(t.requests[0]!.headers.get("Idempotency-Key")).toBe("one-follow-intent");
  expect(t.requests[0]!.headers.get("X-LYX-Admin")).toBe("1");
  await expect(intent.run(body, (key) => api.follow(body, key))).resolves.toBeUndefined();
  const reminder = transport(() =>
    ok({
      scene: "golive",
      subjectType: "order_item",
      subjectId: id(2),
      remindedAt: "2026-10-01T00:00:00.000Z",
      nextAvailableDate: "2026-10-02",
      replayed: false,
    }),
  );
  await createOverdueApi(reminder).remind(id(5), "remind-intent");
  expect(new URL(reminder.requests[0]!.url).pathname).toBe(
    `/api/v1/admin/delivery-tickets/${id(5)}/remind`,
  );
  expect(await reminder.requests[0]!.clone().json()).toEqual({ scene: "golive" });
});
it("跟进分页绑定真实订单项；403不会包装成空列表", async () => {
  const t = transport(() => ok({ items: [], total: 30, page: 2, pageSize: 20 }));
  expect((await createOverdueApi(t).follows(id(1), 2)).total).toBe(30);
  expect(Object.fromEntries(new URL(t.requests[0]!.url).searchParams)).toEqual({
    subjectType: "order_item",
    subjectId: id(1),
    page: "2",
    pageSize: "20",
  });
  const failure = transport(denied);
  await expect(createOverdueApi(failure).list({ tab: "overdue" })).rejects.toThrow();
  expect(failure.handlers.refreshAccess).toHaveBeenCalledTimes(1);
});
