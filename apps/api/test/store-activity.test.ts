import { beforeAll, describe, expect, it } from "vitest";
import { StoreActivityPageSchema, staffRoleDefault } from "@liyoxi/contract";
import { audit, createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import { signInAsStaff } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { harness } from "./admin-profile-fixtures.js";
import type { Harness } from "./admin-profile-fixtures.js";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi();
let api: TestApi, h: Harness, admin: SignedInStaff, manager: SignedInStaff, editor: SignedInStaff;
let peer = 0;
beforeAll(async () => {
  api = await handle.start();
  h = harness(api, await handle.db.prisma());
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  admin = await signInAsStaff(h.prisma, { roleKey: "super_admin" });
  manager = await signInAsStaff(h.prisma, { roleKey: "delivery_manager" });
  editor = await signInAsStaff(h.prisma, { roleKey: "editor" });
}, 120000);
const read = (storeId: string, query = "", staff = admin) =>
  api.request(`/api/v1/admin/stores/${storeId}/activities${query ? `?${query}` : ""}`, {
    headers: staff.headers,
    peer: `198.19.211.${++peer}`,
  });
async function page(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return StoreActivityPageSchema.parse(((await response.json()) as { data: unknown }).data);
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
async function write(
  entityId: string,
  storeId: string | null,
  stream: "ops" | "activity" | "access" = "activity",
  actor = createIdentityContext({ actor: { type: "staff", id: admin.staff.id, client: "admin" } })
    .actor,
) {
  return h.tx.run((tx) =>
    audit.record(
      tx,
      actor,
      {
        requestId: "store-activity-test",
        ip: "198.19.211.1",
        userAgent: "private-agent",
        authMethod: null,
        sessionId: null,
      },
      {
        stream,
        category: "profile_edit",
        action: "profile.store.save",
        summary: "保存门店资料",
        target: { type: "store_profile", id: storeId ?? entityId },
        entityId,
        storeId,
        before: null,
        after: { brandName: "DO_NOT_RETURN_BRAND", contactPhone: "13987654321" },
        fields: ["brandName", "contactPhone"],
        reason: { code: "manual", text: "已核对原资料" },
      },
    ),
  );
}
describe("W2-11门店活动流真实HTTP", { timeout: 60000 }, () => {
  it("admin.store.activity.list 合并主体/本店稳定分页、actor筛选、裁剪且GET零业务写", async () => {
    expect(HANDLERS.some((h) => h.route.operationId === "admin.store.activity.list")).toBe(true);
    const own = await h.owner(),
      other = await h.owner();
    const sibling = await h.make.store({ entityId: own.entity.id, isPrimary: false });
    const local = await write(own.entity.id, own.store.id, "ops");
    const entity = await write(own.entity.id, null, "activity", own.viewer.ctx.actor);
    const system = await write(
      own.entity.id,
      own.store.id,
      "activity",
      createIdentityContext({ actor: { type: "system", job: "lyxtest.activity" } }).actor,
    );
    await write(own.entity.id, sibling.id);
    await write(other.entity.id, null);
    await write(own.entity.id, own.store.id, "access");
    const before = {
      logs: await h.prisma.auditLog.count(),
      events: await h.prisma.outboxEvent.count(),
      store: await h.prisma.store.findUniqueOrThrow({ where: { id: own.store.id } }),
    };
    const first = await page(await read(own.store.id, "limit=1"));
    expect(first).toMatchObject({
      totalApprox: 3,
      hasMore: true,
      items: [{ auditLogId: system.id, isEntityLevel: false }],
    });
    const second = await page(await read(own.store.id, `limit=2&cursor=${first.nextCursor}`));
    expect(second).toMatchObject({
      totalApprox: 3,
      hasMore: false,
      nextCursor: null,
      items: [
        { auditLogId: entity.id, isEntityLevel: true },
        { auditLogId: local.id, isEntityLevel: false },
      ],
    });
    expect(second.items[0]).toMatchObject({
      reason: { code: "manual", text: "已核对原资料" },
      changedKeys: ["brandName", "contactPhone"],
    });
    const filtered = await page(await read(own.store.id, "actorType=staff"));
    expect(filtered.items.map((row) => row.auditLogId)).toEqual([local.id]);
    const multi = await page(await read(own.store.id, "actorType=merchant,system,merchant"));
    expect(multi.items.map((row) => row.auditLogId)).toEqual([system.id, entity.id]);
    const wire = JSON.stringify([first, second]);
    for (const secret of ["DO_NOT_RETURN_BRAND", "13987654321", "private-agent", "198.19.211.1"])
      expect(wire).not.toContain(secret);
    for (const row of [...first.items, ...second.items])
      for (const key of ["before", "after", "meta", "ip", "requestId", "seq"])
        expect(row).not.toHaveProperty(key);
    expect(await h.prisma.auditLog.count()).toBe(before.logs);
    expect(await h.prisma.outboxEvent.count()).toBe(before.events);
    expect(await h.prisma.store.findUniqueOrThrow({ where: { id: own.store.id } })).toEqual(
      before.store,
    );
  });
  it("own范围与merchant模块先行；跨店及变更actor游标不能复用", async () => {
    const own = await h.owner(),
      outside = await h.owner();
    await h.prisma.store.update({
      where: { id: own.store.id },
      data: { deliveryManagerId: manager.staff.id },
    });
    await write(own.entity.id, own.store.id);
    await write(own.entity.id, null);
    const first = await page(await read(own.store.id, "limit=1", manager));
    await error(await read(outside.store.id, "", manager), 404, "NOT_FOUND");
    await h.prisma.staffRole.update({
      where: { key: "editor" },
      data: { moduleLevels: { ...staffRoleDefault("editor")!.moduleLevels, merchant: "n" } },
    });
    await error(await read(own.store.id, "", editor), 403, "PERMISSION_DENIED");
    await error(
      await read(outside.store.id, `cursor=${first.nextCursor}`),
      400,
      "VALIDATION_FAILED",
    );
    await error(
      await read(own.store.id, `actorType=staff&cursor=${first.nextCursor}`),
      400,
      "VALIDATION_FAILED",
    );
    await h.prisma.store.update({ where: { id: own.store.id }, data: { deliveryManagerId: null } });
    await error(await read(own.store.id, `cursor=${first.nextCursor}`, manager), 404, "NOT_FOUND");
  });
  it("缺失门店、严格查询及损坏游标受控；无活动返回空页", async () => {
    const own = await h.owner();
    expect(await page(await read(own.store.id))).toMatchObject({
      items: [],
      hasMore: false,
      nextCursor: null,
      totalApprox: 0,
    });
    await error(await read(uuidv7()), 404, "NOT_FOUND");
    const overflow = Buffer.from(
      JSON.stringify({
        storeId: own.store.id,
        entityId: own.entity.id,
        actors: "",
        at: new Date().toISOString(),
        seq: "9223372036854775808",
      }),
    ).toString("base64url");
    for (const query of [
      "limit=101",
      "limit=0",
      "actorType=access",
      "actorType=staff,",
      "cursor=garbage",
      `cursor=${overflow}`,
    ])
      await error(await read(own.store.id, query), 400, "VALIDATION_FAILED");
  });
});
