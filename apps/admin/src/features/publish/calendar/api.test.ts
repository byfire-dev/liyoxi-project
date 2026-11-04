import { expect, it } from "vitest";
import { createCalendarApi } from "./api";
import { calendarFixture, denied, id, ok, transport } from "./test-fixture";
it("日历只发实际月/经理查询，缺历与截断统计原样保留；取消传入中央请求", async () => {
  const t = transport(() => ok(calendarFixture())),
    api = createCalendarApi(t),
    controller = new AbortController();
  expect(await api.get({ month: "2026-10", managerId: id(1) }, controller.signal)).toEqual(
    calendarFixture(),
  );
  const request = t.requests[0]!,
    url = new URL(request.url);
  expect(url.pathname).toBe("/api/v1/admin/launch-calendar");
  expect(Object.fromEntries(url.searchParams)).toEqual({ month: "2026-10", managerId: id(1) });
  expect(request.method).toBe("GET");
  expect(request.headers.get("X-Client-Version")).toBeTruthy();
  controller.abort();
  expect(request.signal.aborted).toBe(true);
});
it("无权限保留中央错误，不把403变为空日历；拒绝缺少workCalendar的旧响应", async () => {
  const t = transport(denied);
  await expect(createCalendarApi(t).get({ month: "2026-10" })).rejects.toThrow();
  expect(t.handlers.refreshAccess).toHaveBeenCalledTimes(1);
  const { workCalendar: _work, ...old } = calendarFixture();
  await expect(
    createCalendarApi(transport(() => ok(old))).get({ month: "2026-10" }),
  ).rejects.toThrow();
});
it("经理候选使用实际页码与pool，系统查看不强塞pool", async () => {
  const t = transport(() => ok({ items: [], page: 2, pageSize: 100, total: 101 })),
    api = createCalendarApi(t);
  await api.managers(2, true);
  await api.managers(1, false);
  expect(Object.fromEntries(new URL(t.requests[0]!.url).searchParams)).toEqual({
    page: "2",
    pageSize: "100",
    roleKey: "delivery_manager",
    status: "active",
    pool: "delivery_manager",
  });
  expect(new URL(t.requests[1]!.url).searchParams.has("pool")).toBe(false);
});
