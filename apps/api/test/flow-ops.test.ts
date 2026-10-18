// W2-23：生产七handler/真实鉴权、required幂等、技术迁移与安全响应。
import { beforeAll, describe, expect, it } from "vitest";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { RATE_LIMIT_QUOTAS } from "../src/http/rate-limit-quotas.js";
const handle = useTestApi();
let app: TestApi,
  prisma: Awaited<ReturnType<typeof handle.db.prisma>>,
  admin: SignedInStaff,
  viewer: SignedInStaff,
  editor: SignedInStaff;
const prefix = "/api/v1/admin";
const operations = new Set<string>();
function request(
  operation: string,
  path: string,
  method = "GET",
  json?: unknown,
  session = admin,
  key: string | null = uuidv7(),
) {
  operations.add(operation);
  return app.request(prefix + path, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: { ...session.headers, ...(method !== "GET" && key ? { "Idempotency-Key": key } : {}) },
  });
}
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}
const timer = (status = "failed") =>
  prisma.timer.create({
    data: {
      id: uuidv7(),
      kind: "ops.retention",
      fireAt: app.clock.now(),
      dedupeKey: "w223-api:" + uuidv7(),
      status,
      attempts: 6,
      dispatchNo: 6,
      payload: { secret: "fixture-token" },
      result: { arbitrary: "fixture-secret" },
    },
  });
const webhook = () =>
  prisma.webhookEvent.create({
    data: {
      id: uuidv7(),
      provider: "wecom",
      eventId: uuidv7(),
      eventType: "fictional-api",
      mode: "inbox",
      payloadDigest: Buffer.alloc(32, 0x23),
      processState: "dead",
      attempts: 8,
      error: "Bearer fixture-token",
      payload: { summary: { arbitrary: "fixture-secret" } },
    },
  });
beforeAll(async () => {
  app = await handle.start();
  await runSeed({ tx: app.runtime.tx, clock: app.clock });
  prisma = await handle.db.prisma();
  admin = await signInAsStaff(prisma, { roleKey: "super_admin" });
  viewer = await signInAsStaff(prisma, { roleKey: "finance" });
  editor = await signInAsStaff(prisma, { roleKey: "editor" });
  const role = await prisma.staffRole.findUniqueOrThrow({ where: { key: "finance" } });
  await prisma.staffRole.update({
    where: { key: role.key },
    data: { moduleLevels: { ...(role.moduleLevels as Record<string, string>), system: "v" } },
  });
  app.runtime.staffAuth.roles.invalidate();
}, 180000);
describe("七条流程运维生产管线", { timeout: 120000 }, () => {
  it("三列表默认/真实权限OR/no-store/安全projection", async () => {
    const t = await timer(),
      w = await webhook();
    for (const [op, path] of [
      ["admin.timer.list", "/timers"],
      ["admin.outboxDelivery.list", "/outbox-deliveries"],
      ["admin.webhookEvent.list", "/webhook-events"],
    ]) {
      const response = await request(op!, path!, "GET", undefined, viewer);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const page = await data(response);
      expect(page["items"]).toBeInstanceOf(Array);
      expect(await (await request(op!, path!, "GET", undefined, editor)).json()).toMatchObject({
        error: "PERMISSION_DENIED",
      });
      expect((await app.request(prefix + path)).status).toBe(401);
    }
    const timers = await data(await request("admin.timer.list", "/timers"));
    expect(JSON.stringify(timers)).not.toContain("fixture-token");
    expect(JSON.stringify(timers)).not.toContain("fixture-secret");
    expect(JSON.stringify(timers)).toContain(t.id);
    const inbox = await data(await request("admin.webhookEvent.list", "/webhook-events"));
    expect(JSON.stringify(inbox)).toContain(w.id);
    expect(JSON.stringify(inbox)).not.toContain("fixture-secret");
    const superRole = await prisma.staffRole.findUniqueOrThrow({ where: { key: "super_admin" } });
    try {
      await prisma.staffRole.update({
        where: { key: "super_admin" },
        data: {
          moduleLevels: { ...(superRole.moduleLevels as Record<string, string>), system: "n" },
        },
      });
      app.runtime.staffAuth.roles.invalidate();
      expect((await request("admin.timer.list", "/timers", "GET", undefined, admin)).status).toBe(
        200,
      );
    } finally {
      await prisma.staffRole.update({
        where: { key: "super_admin" },
        data: { moduleLevels: superRole.moduleLevels! },
      });
      app.runtime.staffAuth.roles.invalidate();
    }
  });
  it("reschedule required重放一次、不改到期/序号；无stepup/confirm且空note可用", async () => {
    const row = await timer(),
      key = uuidv7(),
      path = `/timers/${row.id}/reschedule`;
    const first = await data(await request("admin.timer.reschedule", path, "POST", {}, admin, key));
    const replay = await data(
      await request("admin.timer.reschedule", path, "POST", {}, admin, key),
    );
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      status: "scheduled",
      fireAt: row.fireAt.toISOString(),
      dispatchNo: row.dispatchNo,
      attempts: 0,
      retryAt: null,
    });
    expect(
      await prisma.auditLog.count({ where: { action: "flow.timer.reschedule", targetId: row.id } }),
    ).toBe(1);
    expect((await request("admin.timer.reschedule", path, "POST", {}, admin)).status).toBe(409);
    expect(
      (
        await request(
          "admin.timer.reschedule",
          path,
          "POST",
          { fireAt: row.fireAt.toISOString() },
          admin,
        )
      ).status,
    ).toBe(400);
    expect(
      (await request("admin.timer.reschedule", path, "POST", { note: "内容改变" }, admin, key))
        .status,
    ).toBe(409);
    expect(
      (await request("admin.timer.reschedule", `/timers/${uuidv7()}/reschedule`, "POST", {}, admin))
        .status,
    ).toBe(404);
    expect((await request("admin.timer.reschedule", path, "POST", {}, viewer)).status).toBe(403);
    expect((await request("admin.timer.reschedule", path, "POST", {}, admin, null)).status).toBe(
      400,
    );
  });
  it("cancel只failed/原因5字/并发一成功，原Origin防线仍在", async () => {
    const row = await timer(),
      path = `/timers/${row.id}/cancel`;
    expect((await request("admin.timer.cancel", path, "POST", { reason: "短" })).status).toBe(400);
    const results = await Promise.all([
      request("admin.timer.cancel", path, "POST", { reason: "已核对需要取消" }),
      request("admin.timer.cancel", path, "POST", { reason: "已核对需要取消" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await prisma.auditLog.count({ where: { action: "flow.timer.cancel", targetId: row.id } }),
    ).toBe(1);
    expect(
      (
        await app.request(prefix + path, {
          method: "POST",
          json: { reason: "已核对需要取消" },
          headers: {
            ...admin.headers,
            origin: "https://attacker.invalid",
            "Idempotency-Key": uuidv7(),
          },
        })
      ).status,
    ).toBe(403);
    const scheduled = await timer("scheduled");
    expect(
      (
        await request("admin.timer.cancel", `/timers/${scheduled.id}/cancel`, "POST", {
          reason: "误操作应被拒绝",
        })
      ).status,
    ).toBe(409);
  });
  it("outbox精确复合目标无载荷；callback不重复received且证据不变", async () => {
    const event = await prisma.outboxEvent.create({
      data: {
        id: uuidv7(),
        eventType: "calendar.imported",
        actorType: "system",
        payload: { v: 1, secret: "fixture-secret" },
        occurredAt: app.clock.now(),
      },
    });
    await prisma.outboxDelivery.create({
      data: {
        outboxEventId: event.id,
        subscriber: "staff.onCalendarImported",
        status: "dead",
        attempts: 10,
        dispatchNo: 10,
      },
    });
    const list = await data(await request("admin.outboxDelivery.list", "/outbox-deliveries"));
    expect(JSON.stringify(list)).not.toContain("fixture-secret");
    const path = `/outbox-events/${event.id}/retry`,
      key = uuidv7();
    const first = await data(
      await request(
        "admin.outboxEvent.retry",
        path,
        "POST",
        { subscriber: "staff.onCalendarImported" },
        admin,
        key,
      ),
    );
    expect(first).toMatchObject({ status: "retry", attempts: 0, dispatchNo: 10 });
    expect(
      await data(
        await request(
          "admin.outboxEvent.retry",
          path,
          "POST",
          { subscriber: "staff.onCalendarImported" },
          admin,
          key,
        ),
      ),
    ).toEqual(first);
    expect(
      (await request("admin.outboxEvent.retry", path, "POST", { subscriber: "support.onBizEvent" }))
        .status,
    ).toBe(404);
    expect(
      (await request("admin.outboxEvent.retry", path, "POST", { subscriber: "attacker" })).status,
    ).toBe(400);
    expect(await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual(event);
    const row = await webhook(),
      count = await prisma.outboxEvent.count(),
      wkey = uuidv7(),
      wpath = `/webhook-events/${row.id}/retry`;
    const reset = await data(
      await request("admin.webhookEvent.retry", wpath, "POST", {}, admin, wkey),
    );
    expect(reset).toMatchObject({ processState: "received", attempts: 0 });
    expect(
      await data(await request("admin.webhookEvent.retry", wpath, "POST", {}, admin, wkey)),
    ).toEqual(reset);
    expect(await prisma.outboxEvent.count()).toBe(count);
    expect(
      await prisma.auditLog.count({ where: { action: "ops.webhook.retry", targetId: row.id } }),
    ).toBe(1);
    expect((await request("admin.webhookEvent.retry", wpath, "POST", {})).status).toBe(409);
    expect(
      (await request("admin.webhookEvent.list", "/webhook-events?cursor=invalid")).status,
    ).toBe(400);
    expect([...operations].sort()).toEqual([
      "admin.outboxDelivery.list",
      "admin.outboxEvent.retry",
      "admin.timer.cancel",
      "admin.timer.list",
      "admin.timer.reschedule",
      "admin.webhookEvent.list",
      "admin.webhookEvent.retry",
    ]);
  });
  it("实际admin.global超限429，不增加新限流档位", async () => {
    const limited = await handle.start({
      rateLimitQuotas: {
        ...RATE_LIMIT_QUOTAS,
        "admin.global": [{ by: "ip", limit: 1, windowSec: 60 }],
      },
    });
    expect((await limited.request(prefix + "/timers", { headers: admin.headers })).status).toBe(
      200,
    );
    const response = await limited.request(prefix + "/timers", { headers: admin.headers });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).not.toBeNull();
  });
});
