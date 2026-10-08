import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createPrismaClient } from "@liyoxi/db";
import { dropTestDatabase, testDatabaseUrl } from "@liyoxi/db/testing/standalone";
import { buildStaffContext, normalizeRoleConfig } from "../../authz/index.js";
import { createDelivery } from "../../delivery/index.js";
import { createIdentityContext, systemClock } from "../../kernel/index.js";
import { createRuntime } from "../../runtime.js";
import { createLogger } from "../../logger.js";
import { assignDeliveryManager } from "../../profile/index.js";
import { createSla } from "../../sla/index.js";
import { createTenant } from "../../tenant/index.js";
import { createSeededDatabase } from "../data/seeded-db.js";
import { createFactories } from "../data/factories/index.js";
import { fakeKeyEnv } from "../staff.js";
import {
  cleanupDeliveryFile,
  knownVideoBytes,
  KNOWN_VIDEO,
  prepareDeliveryKnownMedia,
} from "./delivery-known-media.js";
import flowFixture from "./zz-delivery-flow.fixture.js";
import type { DeliveryLiveScope } from "./delivery-known-media.js";

it("严格本轮桥：实际 POST/copy/head/stored；错归属不触 Provider，未知元数据 QC 零写", async () => {
  const runId = randomBytes(8).toString("hex"),
    name = `lyx_test_admin_live_${runId}`,
    prefix = `lyx:test:admin_live_${runId}:`;
  await createSeededDatabase(name, { clock: systemClock });
  const connection = new URL(testDatabaseUrl(name));
  connection.search = "";
  connection.searchParams.set("options", "-c role=lyx_app");
  const env = {
    APP_ENV: "test" as const,
    LOG_LEVEL: "error" as const,
    DATABASE_URL: connection.toString(),
    REDIS_URL: "redis://127.0.0.1:6389/0",
    ...fakeKeyEnv(),
  };
  const runtime = createRuntime({
    entry: "api",
    env,
    version: "lyxtest.w119b_early",
    redisKeyPrefix: prefix,
    logger: createLogger({
      svc: "api",
      env: "test",
      level: "error",
      version: "lyxtest.w119b_early",
      destination: process.stderr,
    }),
  });
  const prisma = createPrismaClient({ connectionString: env.DATABASE_URL, max: 2 }),
    make = createFactories({ db: prisma, clock: runtime.clock });
  const owned: Parameters<typeof cleanupDeliveryFile>[1][] = [];
  try {
    const admin = await make.staff({
      name: "制作预检管理员",
      staffRoleKey: "super_admin",
      status: "active",
      isLead: true,
    });
    await make.staff({ name: "演练交付", staffRoleKey: "delivery_manager", status: "active" });
    for (const agreementKey of ["user", "privacy", "custom_license"])
      await make.agreementVersion({
        agreementKey,
        createdByStaffId: admin.id,
        effectiveAt: new Date(runtime.clock.now().getTime() - 60_000),
      });
    await runtime.tx.run((tx) =>
      tx.dictItem.create({
        data: {
          id: admin.id,
          dictTypeKey: "custom_focus",
          code: "W119F",
          name: "主推服务",
          isEnabled: true,
          position: 999,
          ext: {},
          createdAt: runtime.clock.now(),
          updatedAt: runtime.clock.now(),
        },
      }),
    );
    const fixture = (await flowFixture({ runtime, make })) as {
      scope: DeliveryLiveScope;
      planId: string;
      launchDate: string;
      deliveryDate: string;
    };
    const role = await runtime.tx.run((tx) =>
      tx.staffRole.findUniqueOrThrow({ where: { key: "super_admin" } }),
    );
    const staff = buildStaffContext({
      staff: {
        id: admin.id,
        roleKey: "super_admin",
        isLead: true,
        staffGroupId: admin.staffGroupId,
      },
      role: normalizeRoleConfig("super_admin", role),
      groupStaffIds: [],
      stepUpAt: runtime.clock.now(),
    });
    const ctx = createIdentityContext({ actor: { type: "staff", id: admin.id, client: "admin" } }),
      tenant = createTenant(runtime);
    const delivery = createDelivery({
      ...runtime,
      sla: createSla(runtime),
      profile: {
        assignDeliveryManager: (tx, identity, input) =>
          assignDeliveryManager(tx, { ...runtime, tenant }, identity, input),
      },
    });
    await delivery.assign(ctx, staff, fixture.scope.ticketId, { staffId: fixture.scope.managerId });
    const plan = await delivery.adminPlan(staff, fixture.planId);
    const saved = await delivery.replaceDraft(ctx, staff, fixture.planId, {
      draftLockVersion: plan.draftLockVersion,
      content: {
        focusCodes: ["W119F"],
        referenceAssetIds: [],
        note: "本域真实直传预检",
        launchMode: "merchant_self",
        items: plan.draft.items.map((i) => ({
          orderItemId: i.orderItemId,
          channelAccountIds: i.accounts.map((a) => a.channelAccountId),
          placements: [],
          agreedLaunchDate: fixture.launchDate,
          expectedDeliveryDate: fixture.deliveryDate,
        })),
      },
    });
    await delivery.push(ctx, staff, fixture.planId, { draftLockVersion: saved.draftLockVersion });
    const membership = await runtime.tx.run((tx) =>
      tx.entityMember.findFirstOrThrow({
        where: { entityId: fixture.scope.entityId, role: "owner" },
      }),
    );
    await delivery.confirm(
      {
        ctx: createIdentityContext({
          actor: {
            type: "merchant",
            id: membership.merchantUserId,
            client: "weapp",
            role: "owner",
          },
          entityId: fixture.scope.entityId,
          storeId: fixture.scope.storeId,
        }),
        membership: {
          memberId: membership.id,
          entityId: fixture.scope.entityId,
          storeId: fixture.scope.storeId,
          role: "owner",
          storeMode: "active",
        },
      },
      fixture.planId,
      { versionNo: 1 },
    );
    const actor = { identity: ctx, staff };
    const copy = vi.spyOn(runtime.providers.storage, "copy"),
      head = vi.spyOn(runtime.providers.storage, "head");
    for (const artifact of ["unknown_sample", "sample"] as const) {
      const clientToken = randomBytes(16).toString("hex");
      const registration = (
        await runtime.media.register(actor, {
          category: "sample_video",
          storeId: fixture.scope.storeId,
          files: [
            {
              fileName: `${runId}-${artifact}.mp4`,
              sizeBytes: String(KNOWN_VIDEO.bytes),
              clientToken,
            },
          ],
          production: {
            kind: "sample",
            orderItemId: fixture.scope.itemId,
            episodeNo: 1,
            aiUsage: { used: false, tools: [] },
          },
        })
      ).items[0]!;
      expect(registration.mode).toBe("post");
      if (!registration.post) throw new Error("旧小文件用例应取得 post 凭据");
      const input = { scope: fixture.scope, artifact, fileId: registration.fileId, clientToken };
      owned.push(input);
      if (process.env.LYX_W119_BROWSER_POST === "1") {
        const output = await new Promise<string>((resolve, reject) => {
          const child = spawn(
            "pnpm",
            [
              "--silent",
              "--filter",
              "@liyoxi/admin",
              "exec",
              "node",
              "test/e2e/w119-storage-post.mjs",
            ],
            {
              cwd: fileURLToPath(new URL("../../../../..", import.meta.url)),
              env: Object.fromEntries(
                ["PATH", "HOME", "USER", "PLAYWRIGHT_BROWSERS_PATH", "LYX_E2E_CHANNEL"].flatMap(
                  (key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]]),
                ),
              ),
              stdio: ["pipe", "pipe", "pipe"],
            },
          );
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0 ? resolve(stdout) : reject(new Error(`本机 browser POST 失败：${stderr}`)),
          );
          child.stdin.end(JSON.stringify(registration.post));
        });
        expect(JSON.parse(output)).toMatchObject({ browserPost: true, status: 204 });
      } else {
        const form = new FormData();
        for (const [key, value] of Object.entries(registration.post.fields))
          form.append(key, value);
        form.append(
          "file",
          new File([new Uint8Array(await knownVideoBytes())], "known.mp4", { type: "video/mp4" }),
        );
        expect((await fetch(registration.post.url, { method: "POST", body: form })).status).toBe(
          204,
        );
      }
      await runtime.media.complete(actor, registration.fileId);
      const beforeCopy = copy.mock.calls.length,
        beforeHead = head.mock.calls.length;
      for (const bad of [
        { ...input, clientToken: "wrong" },
        { ...input, artifact: "final_1" as const },
        { ...input, scope: { ...fixture.scope, runId: "abcdef1234567890" } },
        { ...input, scope: { ...fixture.scope, itemId: admin.id } },
      ])
        await expect(prepareDeliveryKnownMedia(runtime, bad)).rejects.toThrow();
      expect(copy.mock.calls).toHaveLength(beforeCopy);
      expect(head.mock.calls).toHaveLength(beforeHead);
      expect(await prepareDeliveryKnownMedia(runtime, input)).toEqual({
        fileId: registration.fileId,
        status: "stored",
        known: artifact === "sample",
      });
      expect(copy.mock.calls).toHaveLength(beforeCopy + 1);
      expect(head.mock.calls).toHaveLength(beforeHead + 1);
      if (artifact === "unknown_sample") {
        const sample = await delivery.sampleCreate(ctx, staff, fixture.scope.ticketId, {
          fileId: registration.fileId,
          adSlots: [],
        });
        const qct = await runtime.tx.run((tx) =>
          tx.checklistTemplate.findFirstOrThrow({ where: { code: "qc.sample", status: "active" } }),
        );
        const snapshot = () =>
          runtime.tx.run(async (tx) => ({
            qc: await tx.qcRecord.count(),
            audit: await tx.auditLog.count(),
            history: await tx.statusTransition.count(),
            events: await tx.outboxEvent.count(),
            timers: await tx.timer.count(),
          }));
        const before = await snapshot();
        const managerRole = await runtime.tx.run((tx) =>
          tx.staffRole.findUniqueOrThrow({ where: { key: "delivery_manager" } }),
        );
        const manager = buildStaffContext({
          staff: {
            id: fixture.scope.managerId,
            roleKey: "delivery_manager",
            isLead: false,
            staffGroupId: null,
          },
          role: normalizeRoleConfig("delivery_manager", managerRole),
          groupStaffIds: [],
          stepUpAt: runtime.clock.now(),
        });
        const { ChecklistItemsSchema } = await import("@liyoxi/contract");
        await expect(
          delivery.sampleInspect(
            createIdentityContext({
              actor: { type: "staff", id: fixture.scope.managerId, client: "admin" },
            }),
            manager,
            sample.sampleId,
            {
              checklistVersionNo: qct.versionNo,
              results: ChecklistItemsSchema.parse(qct.items).map((i) => ({
                key: i.key,
                result: "pass",
              })),
            },
          ),
        ).rejects.toMatchObject({ error: "PRODUCTION_NOT_READY" });
        expect(await snapshot()).toEqual(before);
        expect(
          await runtime.tx.run((tx) =>
            tx.mediaInfo.findUnique({ where: { fileId: registration.fileId } }),
          ),
        ).toBeNull();
      } else {
        const copied = copy.mock.calls.length;
        await expect(prepareDeliveryKnownMedia(runtime, input)).resolves.toMatchObject({
          known: true,
        });
        expect(copy.mock.calls).toHaveLength(copied);
      }
    }
  } finally {
    const cleanup = await Promise.allSettled(
      owned.map((file) => cleanupDeliveryFile(runtime, file)),
    );
    try {
      await Promise.allSettled([prisma.$disconnect(), runtime.close()]);
    } finally {
      await dropTestDatabase(name);
    }
    expect(
      cleanup.some((result) => result.status === "rejected"),
      "本域真实上传对象清理未完成",
    ).toBe(false);
  }
}, 180_000);
