// W2-11: "admin.followUp.list", "admin.followUp.create", "admin.followUp.update", "admin.followUp.complete".
import { beforeAll, describe, expect, it } from "vitest";
import { FollowUpItemSchema, FollowUpPageSchema } from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const h = useTestApi();
let api: TestApi,
  db: Awaited<ReturnType<typeof h.db.prisma>>,
  make: ReturnType<typeof createFactories>,
  admin: SignedInStaff,
  manager: SignedInStaff,
  editor: SignedInStaff,
  peer = 0;
beforeAll(async () => {
  api = await h.start();
  db = await h.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  make = createFactories({ db, clock: api.clock });
  admin = await signInAsStaff(db, { roleKey: "super_admin" });
  manager = await signInAsStaff(db, { roleKey: "delivery_manager" });
  editor = await signInAsStaff(db, { roleKey: "editor" });
}, 60000);
const request = (path: string, method = "GET", json?: unknown, who = admin, key?: string) =>
  api.request(`/api/v1${path}`, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: { ...who.headers, ...(key ? { "Idempotency-Key": key } : {}) },
    peer: `198.19.85.${++peer % 250}`,
  });
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as { data: unknown }).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
const next = (ms = 60000) => new Date(api.clock.now().getTime() + ms).toISOString();
const counts = async () => [
  await db.followUp.count(),
  await db.auditLog.count({ where: { category: "follow_up" } }),
  await db.outboxEvent.count(),
  await db.timer.count(),
];
async function graph(managed: boolean) {
  const own = await make.subscribedMerchant();
  if (managed)
    await db.store.update({
      where: { id: own.store.id },
      data: { deliveryManagerId: manager.staff.id },
    });
  const order = await make.dramaOrder({
    entityId: own.entity.id,
    storeId: own.store.id,
    subscriptionTermId: own.term.id,
  });
  const item = await make.orderItem({ dramaOrderId: order.id });
  return { ...own, item };
}

describe("跟进四正式HTTP路由", { timeout: 30000 }, () => {
  it("创建/分页/改期/完成与同键重放，真实归属和owner/recorder固定；只一审计且零额外timer/outbox", async () => {
    const g = await graph(true),
      before = await counts(),
      key = uuidv7();
    const body = {
      subjectType: "subscription_term",
      subjectId: g.term.id,
      content: "虚构续费沟通",
      intent: "considering",
      channel: "phone",
      nextFollowAt: next(),
    };
    const created = FollowUpItemSchema.parse(
      await data(await request("/admin/follow-ups", "POST", body, manager, key)),
    );
    expect(created).toMatchObject({
      entityId: g.entity.id,
      storeId: null,
      owner: { staffId: manager.staff.id },
      recorder: { actorType: "staff", staff: { staffId: manager.staff.id } },
      isOpen: true,
      lockVersion: 0,
      actions: ["update", "complete"],
    });
    expect(await data(await request("/admin/follow-ups", "POST", body, manager, key))).toEqual(
      created,
    );
    const stable = await counts();
    expect(stable).toEqual([before[0]! + 1, before[1]! + 1, before[2], before[3]]);
    const page = FollowUpPageSchema.parse(
      await data(
        await request(
          `/admin/follow-ups?subjectType=subscription_term&subjectId=${g.term.id}`,
          "GET",
          undefined,
          manager,
        ),
      ),
    );
    expect(page).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(page.items).toEqual([created]);
    expect(await counts()).toEqual(stable);
    const patch = { lockVersion: 0, nextFollowAt: next(120000) },
      patchKey = uuidv7(),
      path = `/admin/follow-ups/${created.followUpId}`;
    const changed = FollowUpItemSchema.parse(
      await data(await request(path, "PATCH", patch, manager, patchKey)),
    );
    expect(changed).toMatchObject({ lockVersion: 1, nextFollowAt: patch.nextFollowAt });
    expect(await data(await request(path, "PATCH", patch, manager, patchKey))).toEqual(changed);
    const doneBody = { lockVersion: 1, doneNote: "确认续费意向" },
      doneKey = uuidv7();
    const done = FollowUpItemSchema.parse(
      await data(await request(`${path}/complete`, "POST", doneBody, manager, doneKey)),
    );
    expect(done).toMatchObject({
      isOpen: false,
      lockVersion: 2,
      doneNote: doneBody.doneNote,
      actions: [],
    });
    expect(
      await data(await request(`${path}/complete`, "POST", doneBody, manager, doneKey)),
    ).toEqual(done);
    expect(
      await db.auditLog.findMany({
        where: { targetId: created.followUpId, category: "follow_up" },
        orderBy: { seq: "asc" },
        select: { stream: true, action: true, entityId: true, storeId: true },
      }),
    ).toEqual([
      {
        stream: "activity",
        action: "staff.follow_up.create",
        entityId: g.entity.id,
        storeId: null,
      },
      {
        stream: "activity",
        action: "staff.follow_up.update",
        entityId: g.entity.id,
        storeId: null,
      },
      {
        stream: "activity",
        action: "staff.follow_up.complete",
        entityId: g.entity.id,
        storeId: null,
      },
    ]);
    expect((await counts()).slice(2)).toEqual(before.slice(2));
    expect(
      FollowUpPageSchema.parse(
        await data(
          await request(
            `/admin/follow-ups?entityId=${g.entity.id}&isOpen=true`,
            "GET",
            undefined,
            manager,
          ),
        ),
      ).total,
    ).toBe(0);
  });

  it("会话/动态模块/own范围与required、V1非法字段零写；两请求CAS只一胜且旧版本不能覆盖", async () => {
    const g = await graph(true),
      foreign = await graph(false),
      body = {
        subjectType: "order_item",
        subjectId: g.item.id,
        content: "虚构逾期沟通",
        nextFollowAt: next(),
      },
      before = await counts();
    await error(
      await api.request(`/api/v1/admin/follow-ups?storeId=${g.store.id}`),
      401,
      "AUTH_REQUIRED",
    );
    await error(
      await request(
        `/admin/follow-ups?subjectType=subscription_term&subjectId=${g.term.id}`,
        "GET",
        undefined,
        editor,
      ),
      403,
      "PERMISSION_DENIED",
    );
    await error(
      await request(`/admin/follow-ups?storeId=${foreign.store.id}`, "GET", undefined, manager),
      404,
      "NOT_FOUND",
    );
    await error(
      await request("/admin/follow-ups", "POST", body, manager),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    for (const bad of [
      { ...body, subjectType: "store", subjectId: g.store.id },
      { ...body, intent: "confirmed" },
      { ...body, ownerStaffId: admin.staff.id },
      { ...body, channel: "system" },
    ])
      await error(
        await request("/admin/follow-ups", "POST", bad, manager, uuidv7()),
        400,
        "VALIDATION_FAILED",
      );
    await error(
      await request("/admin/follow-ups?mine=false", "GET", undefined, manager),
      400,
      "VALIDATION_FAILED",
    );
    expect(await counts()).toEqual(before);
    const created = FollowUpItemSchema.parse(
        await data(await request("/admin/follow-ups", "POST", body, manager, uuidv7())),
      ),
      path = `/admin/follow-ups/${created.followUpId}`;
    const race = await Promise.all([
      request(path, "PATCH", { lockVersion: 0, nextFollowAt: next(120000) }, manager, uuidv7()),
      request(
        `${path}/complete`,
        "POST",
        { lockVersion: 0, doneNote: "并发完成" },
        manager,
        uuidv7(),
      ),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = race.find((r) => r.status === 409);
    if (!loser) throw new Error("缺少唯一冲突响应");
    await error(loser, 409, "VERSION_CONFLICT");
    expect(
      await db.followUp.findUniqueOrThrow({ where: { id: created.followUpId } }),
    ).toMatchObject({ lockVersion: 1 });
    await error(
      await request(
        path,
        "PATCH",
        { lockVersion: 0, nextFollowAt: next(180000) },
        manager,
        uuidv7(),
      ),
      409,
      "VERSION_CONFLICT",
    );
    await error(
      await request(
        `/admin/follow-ups/${uuidv7()}/complete`,
        "POST",
        { lockVersion: 0 },
        admin,
        uuidv7(),
      ),
      404,
      "NOT_FOUND",
    );
    expect(
      await db.auditLog.count({ where: { targetId: created.followUpId, category: "follow_up" } }),
    ).toBe(2);
  });
});
