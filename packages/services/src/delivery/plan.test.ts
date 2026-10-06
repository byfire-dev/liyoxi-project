import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { createIdempotencyContext, uuidv7 } from "../kernel/index.js";
import { draft, harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
describe("方案版本、校验和回放", { timeout: 60000 }, () => {
  it("保存只查结构，推送完整业务校验；草稿版本及约定上线日边界", async () => {
    const o = await h.order(true),
      a = await h.staff(),
      content = draft(o);
    await expect(
      h.delivery.replaceDraft(a.ctx, a.staff, o.deliveryPlanId, { draftLockVersion: 4, content }),
    ).rejects.toMatchObject({ error: "VERSION_CONFLICT", details: { draftLockVersion: 0 } });
    content.items[0]!.agreedLaunchDate = "2026-01-06";
    await h.delivery.replaceDraft(a.ctx, a.staff, o.deliveryPlanId, {
      draftLockVersion: 0,
      content,
    });
    await expect(
      h.delivery.push(a.ctx, a.staff, o.deliveryPlanId, { draftLockVersion: 1 }),
    ).rejects.toMatchObject({
      error: "LAUNCH_DATE_OUT_OF_RANGE",
      details: { orderItemId: o.items[0]!.id, minDate: "2026-01-14", maxDate: "2027-01-05" },
    });
    content.items[0]!.agreedLaunchDate = "2026-01-20";
    content.items[0]!.channelAccountIds = [];
    await h.delivery.replaceDraft(a.ctx, a.staff, o.deliveryPlanId, {
      draftLockVersion: 1,
      content,
    });
    await expect(
      h.delivery.push(a.ctx, a.staff, o.deliveryPlanId, { draftLockVersion: 2 }),
    ).rejects.toMatchObject({
      error: "PLAN_CONTENT_INVALID",
      details: { issues: [{ reason: "account_missing" }] },
    });
    expect(
      await h.prisma.deliveryPlanVersion.count({ where: { deliveryPlanId: o.deliveryPlanId } }),
    ).toBe(0);
  });
  it("旧版本确认拒绝，重复意见不改终局；新推送保留 change_requested，再推时未决旧版 superseded", async () => {
    const o = await h.order(true),
      a = await h.staff();
    await h.delivery.replaceDraft(a.ctx, a.staff, o.deliveryPlanId, {
      draftLockVersion: 0,
      content: draft(o),
    });
    await h.delivery.push(a.ctx, a.staff, o.deliveryPlanId, { draftLockVersion: 1 });
    await expect(
      h.delivery.confirm(o.viewer, o.deliveryPlanId, { versionNo: 0 }),
    ).rejects.toMatchObject({ error: "PLAN_VERSION_STALE", details: { currentVersionNo: 1 } });
    await h.delivery.requestChange(o.viewer, o.deliveryPlanId, {
      kinds: ["other"],
      note: " 调整定制内容 ",
    });
    await h.delivery.requestChange(o.viewer, o.deliveryPlanId, {
      kinds: ["account"],
      note: "补充账号意见",
    });
    expect(
      (
        await h.prisma.deliveryPlanVersion.findFirstOrThrow({
          where: { deliveryPlanId: o.deliveryPlanId },
        })
      ).decision,
    ).toBe("change_requested");
    await h.delivery.push(a.ctx, a.staff, o.deliveryPlanId, { draftLockVersion: 1 });
    await h.delivery.push(a.ctx, a.staff, o.deliveryPlanId, { draftLockVersion: 1 });
    const versions = await h.prisma.deliveryPlanVersion.findMany({
      where: { deliveryPlanId: o.deliveryPlanId },
      orderBy: { versionNo: "asc" },
    });
    expect(versions.map((v) => v.decision)).toEqual(["change_requested", "superseded", null]);
    expect((await h.delivery.merchantPlan(o.viewer, o.deliveryPlanId)).version?.versionNo).toBe(3);
    await h.delivery.confirm(o.viewer, o.deliveryPlanId, { versionNo: 3 });
    await expect(
      h.delivery.push(a.ctx, a.staff, o.deliveryPlanId, { draftLockVersion: 1 }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
  });
  it("W1-17 未实现时生产默认 INTERNAL，确认、历史和决定全部回滚", async () => {
    const production = harness(h.prisma, false);
    try {
      const o = await production.order(true),
        a = await production.staff();
      await production.delivery.replaceDraft(a.ctx, a.staff, o.deliveryPlanId, {
        draftLockVersion: 0,
        content: draft(o),
      });
      await production.delivery.push(a.ctx, a.staff, o.deliveryPlanId, { draftLockVersion: 1 });
      await expect(
        production.delivery.confirm(o.viewer, o.deliveryPlanId, { versionNo: 1 }),
      ).rejects.toMatchObject({ error: "INTERNAL" });
      expect(
        (await h.prisma.deliveryPlan.findUniqueOrThrow({ where: { id: o.deliveryPlanId } })).status,
      ).toBe("pending_confirm");
      expect(
        (
          await h.prisma.deliveryPlanVersion.findFirstOrThrow({
            where: { deliveryPlanId: o.deliveryPlanId },
          })
        ).decision,
      ).toBeNull();
      expect(
        await h.prisma.statusTransition.count({ where: { subjectId: o.deliveryPlanId } }),
      ).toBe(1);
    } finally {
      production.unbind();
    }
  });
  it("5 required 写各同键回放，副作用一次；商家签名初次有效、幂等落库与重放 null", async () => {
    const poster = await h.make.fileObject(),
      o = await h.order(false, 1, poster.id),
      a = await h.staff(),
      manager = await h.make.staff({ staffRoleKey: "delivery_manager" });
    const replay = async (
      scope: string,
      actor: typeof a.ctx.actor,
      body: unknown,
      run: (idem: ReturnType<typeof createIdempotencyContext>) => Promise<unknown>,
    ) => {
      const key = uuidv7(),
        context = () =>
          createIdempotencyContext({
            mode: "required",
            scope,
            actor,
            key,
            request: { method: "POST", body },
            redact: scope.startsWith("m.") ? ["content.items[].posterUrl"] : [],
          });
      const first = await run(context()),
        c = context(),
        second = await run(c);
      expect(c.replayed, scope).toBe(true);
      return { first, second };
    };
    await replay(
      "admin.deliveryTicket.assignManager",
      a.ctx.actor,
      { staffId: manager.id },
      (idem) =>
        h.delivery.assign(
          a.ctx,
          a.staff,
          o.deliveryTicketIds[0]!,
          { staffId: manager.id },
          { idem },
        ),
    );
    await replay("admin.deliveryPlan.draft.replace", a.ctx.actor, draft(o), (idem) =>
      h.delivery.replaceDraft(
        a.ctx,
        a.staff,
        o.deliveryPlanId,
        { draftLockVersion: 0, content: draft(o) },
        { idem },
      ),
    );
    await replay("admin.deliveryPlan.push", a.ctx.actor, { draftLockVersion: 1 }, (idem) =>
      h.delivery.push(a.ctx, a.staff, o.deliveryPlanId, { draftLockVersion: 1 }, { idem }),
    );
    const change = await replay(
      "m.deliveryPlan.requestChange",
      o.viewer.ctx.actor,
      { kinds: ["other"], note: "请调整" },
      (idem) =>
        h.delivery.requestChange(
          o.viewer,
          o.deliveryPlanId,
          { kinds: ["other"], note: "请调整" },
          { idem },
        ),
    );
    expect(change.first).toMatchObject({
      content: { items: [{ posterUrl: { url: expect.any(String) } }] },
    });
    expect(change.second).toMatchObject({
      replayed: true,
      content: { items: [{ posterUrl: null }] },
    });
    await h.delivery.push(a.ctx, a.staff, o.deliveryPlanId, { draftLockVersion: 1 });
    await replay("m.deliveryPlan.confirm", o.viewer.ctx.actor, { versionNo: 2 }, (idem) =>
      h.delivery.confirm(o.viewer, o.deliveryPlanId, { versionNo: 2 }, { idem }),
    );
    expect(h.applications.filter((id) => id === o.deliveryPlanId)).toHaveLength(1);
    expect(
      await h.prisma.deliveryPlanChangeRequest.count({
        where: { deliveryPlanId: o.deliveryPlanId },
      }),
    ).toBe(1);
    const caches = await h.prisma.idempotencyRecord.findMany({
      where: { actorKey: `merchant:${o.user.id}` },
    });
    expect(JSON.stringify(caches)).not.toContain("https://");
  });
});
