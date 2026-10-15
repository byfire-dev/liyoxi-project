import { expect, it } from "vitest";
import type { M1Api } from "./in-process.js";
import { createM2Http } from "./m2-http.js";

it("M2 专用键原样传入、路径参数编码且预期错误只读符号名", async () => {
  const calls: { path: string; headers: Readonly<Record<string, string>> | undefined }[] = [];
  const api: M1Api = {
    support: {} as M1Api["support"],
    async request(path, init) {
      calls.push({ path, headers: init?.headers });
      return Response.json(
        { error: "NOT_FOUND", message: "fixture private diagnostic" },
        { status: 404 },
      );
    },
  };
  const http = createM2Http(api),
    reportId = "01900000-0000-7000-8000-000000000001";
  await http.request(
    "m.subscribeResult.create",
    { authorization: "Bearer fixture" },
    {
      body: {
        reportId,
        point: "profile_submit",
        results: [{ tmplId: "unknown", result: "accept" }],
      },
      key: `subscribeReport:${reportId}`,
    },
  );
  expect(calls[0]).toEqual({
    path: "/api/v1/m/subscribe-results",
    headers: { authorization: "Bearer fixture", "Idempotency-Key": `subscribeReport:${reportId}` },
  });
  await http.denied(
    "admin.timer.reschedule",
    {},
    { params: { timerId: "path/segment" }, body: {}, key: "same-key" },
    404,
    "NOT_FOUND",
  );
  expect(calls[1]?.path).toBe("/api/v1/admin/timers/path%2Fsegment/reschedule");
  expect(calls[1]?.headers?.["Idempotency-Key"]).toBe("same-key");
  await expect(http.request("admin.timer.reschedule", {}, { body: {} })).rejects.toThrow(
    "缺 timerId",
  );
  expect(calls).toHaveLength(2);
});
