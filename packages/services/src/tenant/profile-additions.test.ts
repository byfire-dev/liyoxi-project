import { beforeAll, describe, expect, it } from "vitest";
import { createIdentityContext, createTxRunner } from "../kernel/index.js";
import { createClock, createFactories, useSeededDatabase } from "../testing/index.js";
import { clearDraftStoreName, findVerifiedEntityByUsccBidx } from "./index.js";
const db = useSeededDatabase("services");
let prisma: Awaited<ReturnType<typeof db.prisma>>;
const clock = createClock();
beforeAll(async () => {
  prisma = await db.prisma();
}, 120000);
const ctx = createIdentityContext({ actor: { type: "system", job: "lyxtest.profile_tenant" } });
describe("profile 所需 tenant 新入口", () => {
  it("清空真实null，重复不额外审计", async () => {
    const make = createFactories({ db: prisma, clock }),
      store = await make.store();
    const tx = createTxRunner({ prisma, appEnv: "test" });
    for (let i = 0; i < 2; i++)
      expect(
        await tx.run((handle) =>
          clearDraftStoreName(handle, clock.now(), ctx, { storeId: store.id }),
        ),
      ).toEqual({ storeId: store.id, name: null });
    expect((await prisma.store.findUniqueOrThrow({ where: { id: store.id } })).name).toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { storeId: store.id, action: "tenant.store.clear_name" },
      }),
    ).toBe(1);
  });
  it.each(["rejected", "pending", "verified"])("%s 不可清空", async (qualificationStatus) => {
    const store = await createFactories({ db: prisma, clock }).store({ qualificationStatus });
    await expect(
      createTxRunner({ prisma, appEnv: "test" }).run((tx) =>
        clearDraftStoreName(tx, clock.now(), ctx, { storeId: store.id }),
      ),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
  });
  it("停用未提交不可清空；盲索引只找其他已认证主体", async () => {
    const make = createFactories({ db: prisma, clock }),
      store = await make.store({
        lifecycle: "archived",
        archiveReason: "by_owner",
        archivedAt: clock.now(),
        archiveActorType: "system",
      });
    const tx = createTxRunner({ prisma, appEnv: "test" });
    await expect(
      tx.run((handle) => clearDraftStoreName(handle, clock.now(), ctx, { storeId: store.id })),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    const entity = await make.entity({ verificationStatus: "verified" });
    expect(
      await tx.run((handle) => findVerifiedEntityByUsccBidx(handle, entity.usccBidx!)),
    ).toEqual({ id: entity.id });
    expect(
      await tx.run((handle) => findVerifiedEntityByUsccBidx(handle, entity.usccBidx!, entity.id)),
    ).toBeNull();
  });
});
