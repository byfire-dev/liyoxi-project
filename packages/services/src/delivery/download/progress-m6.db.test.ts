import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "@liyoxi/db";
import { calendarDate, dayRange } from "@liyoxi/shared/time";
import { createPortalDownloadFixture, useSeededDatabase } from "../../testing/index.js";
import { createIdempotencyContext, createTxRunner, uuidv7 } from "../../kernel/index.js";
import { createDeliveryDownloads } from "./index.js";

const db = useSeededDatabase("services", { label: "downprogress" });
let h: ReturnType<typeof createPortalDownloadFixture>, steps: ReturnType<typeof h.releaseSteps>;
let f: Awaited<ReturnType<typeof steps.push>>, world: Awaited<ReturnType<typeof h.authorize>>;
beforeAll(async () => {
  h = createPortalDownloadFixture(await db.prisma());
  steps = h.releaseSteps(1);
});
beforeAll(() => steps.prepare());
beforeAll(() => steps.sampleFile());
beforeAll(() => steps.confirmSample());
beforeAll(async () => {
  f = await steps.push();
});
beforeAll(async () => {
  world = await h.authorize(f.o);
});
afterAll(() => h?.close());
const meta = () => ({
  ...world.meta,
  authMethod: "weapp" as const,
  sessionId: world.owner.principal.sessionId,
});
const options = (scope: string, body: unknown, key = uuidv7()) => ({
  idem: createIdempotencyContext({
    mode: "required",
    scope,
    actor: f.o.viewer.ctx.actor,
    key,
    request: { method: "POST", body, storeId: f.o.store.id },
  }),
});
const grant = (key?: string) =>
  h.downloads.createGrant(
    f.o.viewer,
    f.item.id,
    options("m.orderItem.downloadGrant.create", {}, key),
  );
const sign = () =>
  h.downloads.episodeUrl(f.o.viewer, f.item.id, { kind: "episode", episodeNo: 1 }, meta());
const report = (id: string, result: "saved" | "failed", key?: string) =>
  h.downloads.report(f.o.viewer, id, { result }, options("m.download.report", { result }, key));

it("真实逐集签发后同键重放和同结果重报保持一次ack，不同结果拒绝", async () => {
  const signed = await sign(),
    key = uuidv7();
  const first = await report(signed.downloadId, "saved", key);
  h.clock.advance(1000);
  expect(await report(signed.downloadId, "saved", key)).toEqual(first);
  expect(await report(signed.downloadId, "saved")).toEqual(first);
  await expect(report(signed.downloadId, "failed")).rejects.toMatchObject({
    error: "STATE_NOT_ALLOWED",
  });
  expect(
    await h.prisma.deliveryDownloadLog.findUniqueOrThrow({ where: { id: signed.downloadId } }),
  ).toMatchObject({ clientAck: "saved", clientAckAt: new Date(first.clientAckAt) });
  expect(await h.downloads.release(f.o.viewer, f.item.id)).toMatchObject({ savedEpisodeCount: 1 });
});

it("portal记录、其他用户和其他门店记录均不能作为本人weapp回报", async () => {
  const signed = await h.portalDownloads.downloadUrls(
    world.principal,
    f.item.id,
    { kind: "episode", episodeNo: 1 },
    { ...meta(), authMethod: "portal", sessionId: world.principal.sessionId },
  );
  await expect(report(signed.downloadId!, "saved")).rejects.toMatchObject({ error: "NOT_FOUND" });
  const weapp = await sign(),
    other = await h.make.merchant();
  const member = await h.prisma.entityMember.findFirstOrThrow({
    where: { merchantUserId: other.user.id, entityId: other.entity.id },
  });
  const viewer = {
    ctx: {
      ...f.o.viewer.ctx,
      actor: {
        type: "merchant" as const,
        client: "weapp" as const,
        id: other.user.id,
        role: "owner" as const,
      },
    },
    membership: {
      memberId: member.id,
      entityId: other.entity.id,
      storeId: other.store.id,
      role: "owner" as const,
      storeMode: "active" as const,
    },
  };
  await expect(
    h.downloads.report(
      viewer,
      weapp.downloadId,
      { result: "saved" },
      {
        idem: createIdempotencyContext({
          mode: "required",
          scope: "m.download.report",
          actor: viewer.ctx.actor,
          key: uuidv7(),
          request: { method: "POST", body: { result: "saved" } },
        }),
      },
    ),
  ).rejects.toMatchObject({ error: "NOT_FOUND" });
  expect(
    await h.prisma.deliveryDownloadLog.findUniqueOrThrow({ where: { id: weapp.downloadId } }),
  ).toMatchObject({ clientAck: null });
  expect(
    await h.prisma.deliveryDownloadLog.findUniqueOrThrow({ where: { id: signed.downloadId! } }),
  ).toMatchObject({ clientAck: null });
});

it("账号在新写边界前停用，regrant/report和幂等重放都拒绝且零写", async () => {
  const signed = await sign(),
    key = uuidv7();
  await report(signed.downloadId, "failed", key);
  const grants = await h.prisma.downloadGrant.count({ where: { orderItemId: f.item.id } });
  // 模拟已完成的账号停用事实；不将此注入算作账号管理功能验收。
  await h.prisma.merchantUser.update({ where: { id: f.o.user.id }, data: { status: "disabled" } });
  try {
    await expect(grant()).rejects.toMatchObject({ error: "SESSION_INVALID" });
    await expect(report(signed.downloadId, "failed", key)).rejects.toMatchObject({
      error: "SESSION_INVALID",
    });
    expect(await h.prisma.downloadGrant.count({ where: { orderItemId: f.item.id } })).toBe(grants);
  } finally {
    await h.prisma.merchantUser.update({ where: { id: f.o.user.id }, data: { status: "active" } });
  }
});

it("重签同键仅一次；两真实连接竞争最后名额，业务日仍最多五次并仅一行active", async () => {
  const key = uuidv7(),
    first = await grant(key);
  expect(await grant(key)).toEqual(first);
  expect(first).toMatchObject({
    regrantRemainingToday: 4,
    grant: { validDays: 7, state: "active", isExpired: false },
  });
  for (let index = 0; index < 3; index++) await grant();
  const connectionString = await db.url(),
    clients = [
      createPrismaClient({ connectionString, max: 1 }),
      createPrismaClient({ connectionString, max: 1 }),
    ];
  try {
    const services = clients.map((prisma) =>
      createDeliveryDownloads({
        ...h.deps,
        media: h.zipMedia,
        tx: createTxRunner({ prisma, appEnv: "test" }),
      }),
    );
    const results = await Promise.allSettled(
      services.map((service) =>
        service.createGrant(f.o.viewer, f.item.id, options("m.orderItem.downloadGrant.create", {})),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      {
        reason: {
          error: "DOWNLOAD_REGRANT_LIMIT",
          details: { nextAvailableAt: dayRange(calendarDate(h.clock.now())).end.toISOString() },
        },
      },
    ]);
    expect(
      await h.prisma.downloadGrant.count({
        where: { orderItemId: f.item.id, actorType: "merchant" },
      }),
    ).toBe(5);
    expect(
      await h.prisma.downloadGrant.count({ where: { orderItemId: f.item.id, state: "active" } }),
    ).toBe(1);
  } finally {
    await Promise.all(clients.map((client) => client.$disconnect()));
  }
});

it("北京时间次日零点重置业务计数，旧授权superseded且有效期仍按参数快照", async () => {
  h.clock.set(dayRange(calendarDate(h.clock.now())).end);
  const result = await grant();
  expect(result.regrantRemainingToday).toBe(4);
  expect(new Date(result.grant.expiresAt).getTime() - h.clock.now().getTime()).toBe(
    result.grant.validDays * 86_400_000,
  );
  expect(
    await h.prisma.downloadGrant.count({ where: { orderItemId: f.item.id, state: "active" } }),
  ).toBe(1);
});

describe("真实补发版本替换", () => {
  let replacement: ReturnType<typeof h.reissueSteps>, late: Awaited<ReturnType<typeof sign>>;
  beforeAll(async () => {
    world = await h.authorize(f.o);
    late = await sign();
    replacement = h.reissueSteps(f);
    await replacement.create();
  });
  beforeAll(() => replacement.file());
  beforeAll(() => replacement.inspect());
  it("签名期间新包发布拒绝旧URL；旧真实下载允许迟报但不计入新包saved", async () => {
    const original = h.zipMedia.signDeliveryDownload,
      before = await h.prisma.deliveryDownloadLog.count({ where: { orderItemId: f.item.id } });
    const signer = vi
      .spyOn(h.zipMedia, "signDeliveryDownload")
      .mockImplementation(async (input) => {
        const result = await original(input);
        await replacement.publish();
        return result;
      });
    try {
      await expect(
        h.portalDownloads.downloadUrls(
          world.principal,
          f.item.id,
          { kind: "episode", episodeNo: 1 },
          { ...meta(), authMethod: "portal", sessionId: world.principal.sessionId },
        ),
      ).rejects.toMatchObject({
        error: "DOWNLOAD_NOT_AVAILABLE",
        details: { reason: "release_closed" },
      });
      expect(await h.prisma.deliveryDownloadLog.count({ where: { orderItemId: f.item.id } })).toBe(
        before,
      );
    } finally {
      signer.mockRestore();
    }
    const ack = await report(late.downloadId, "saved");
    expect(ack.clientAck).toBe("saved");
    const current = await h.downloads.release(f.o.viewer, f.item.id);
    expect(current.deliveryReleaseId).not.toBe(f.release.deliveryReleaseId);
    expect(current.savedEpisodeCount).toBe(0);
    expect(current.episodes[0]!.lastSavedAt).toBeNull();
  });
});
