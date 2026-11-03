import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createM1Support } from "@liyoxi/services/testing";
import { createM1Api } from "./e2e/in-process.js";
import { createM1Caller } from "./e2e/runner-api.js";
import { runM1Chain } from "./e2e/runner.js";

// Same fictional PNG and external providers as the main M1 chain; no business success is seeded.
const evidence = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4o8AAAAASUVORK5CYII=",
  "base64",
);

it("W6-03 真实二十集制作、推包与上线后经HTTP巡检正常，全仓full零违规", async () => {
  const started = performance.now();
  const support = await createM1Support();
  process.stdout.write(`W6-03隔离资源：${support.databaseName}；${support.redisPrefix}\n`);
  try {
    const full = support.runtime.assembly.invariants.filter((check) =>
      check.modes.includes("full"),
    );
    expect(full.map((check) => check.code)).toEqual(
      expect.arrayContaining(["publish.I14", "publish.I15", "timers.I7"]),
    );
    const report = await runM1Chain({
      api: createM1Api(support),
      support,
      // Preserve M1's 20 episodes, four upload workers and original whole-assembly full check.
      episodeCount: 20,
      uploadConcurrency: 4,
      say: (message) => process.stdout.write(`W6-03：${message}\n`),
      afterChain: async ({ api, admin, owner, scope, channelAccountId }) => {
        const call = createM1Caller(api);
        const launched = await support.readState(scope);
        expect(launched.order?.status).toBe("live");
        expect(launched.item).toMatchObject({ phase: "live", liveEpisodeCount: 20 });
        expect(launched.ticket?.step).toBe("in_service");
        expect(launched.launchTasks).toHaveLength(1);
        const launch = launched.launchTasks[0]!;
        expect(launch).toMatchObject({ isLive: true, channelAccountId });
        const created = await call("admin.patrolTask.create", admin.headers, {
          body: { launchTaskId: launch.id, reason: "真实制作上线链巡检验收" },
        });
        expect(created).toMatchObject({
          isNew: true,
          patrolTask: {
            status: "pending",
            source: "manual",
            launchTaskId: launch.id,
            orderItemId: scope.orderItemId,
            episodeCount: 20,
          },
        });
        const file = await call("admin.file.create", admin.headers, {
          body: {
            category: "evidence",
            storeId: owner.storeId,
            fileName: `patrol-${support.runId}.png`,
            mime: "image/png",
            sizeBytes: String(evidence.length),
            clientToken: randomUUID(),
          },
        });
        expect(file.mode).toBe("post");
        if (!file.post) throw new Error("巡检证据必须取得实际直传表单");
        expect(
          support.providers.storage.upload(
            { ...file.post, key: file.key, expiresAt: new Date(file.expiresAt) },
            evidence,
          ),
        ).toBe(204);
        const complete = () =>
          call("admin.file.complete", admin.headers, {
            params: { fileId: file.fileId },
            body: {},
          });
        if (support.completeWithPromote) await support.completeWithPromote(file.fileId, complete);
        else await complete();
        await support.promote(file.fileId);
        expect(
          await call("admin.file.get", admin.headers, { params: { fileId: file.fileId } }),
        ).toMatchObject({
          status: "stored",
          category: "evidence",
          scopeType: "store",
          entityId: owner.entityId,
          storeId: owner.storeId,
          liveRefCount: 0,
        });
        const templates = await call("admin.checklistTemplate.list", admin.headers, {
          query: { code: "patrol.check", status: "active" },
        });
        expect(templates.items).toHaveLength(1);
        const checklist = templates.items[0]!;
        expect(checklist.items.length).toBeGreaterThan(0);
        const params = { patrolTaskId: created.patrolTask.patrolTaskId };
        const checked = await call("admin.patrolTask.markNormal", admin.headers, {
          params,
          body: {
            checklistVersionNo: checklist.versionNo,
            results: checklist.items.map((item) => ({ key: item.key, result: "pass" as const })),
            evidenceFileIds: [file.fileId],
          },
        });
        expect(checked).toMatchObject({
          status: "normal",
          checklistCode: "patrol.check",
          checklistVersionNo: checklist.versionNo,
          evidenceFileIds: [file.fileId],
          checkedBy: { staffId: admin.staffId },
          orderItem: { orderItemId: scope.orderItemId, phase: "live", liveEpisodeCount: 20 },
          ticket: { deliveryTicketId: scope.deliveryTicketId, step: "in_service" },
        });
        expect(checked.checkedAt).not.toBeNull();
        await support.drainEvents();
        expect(await call("admin.patrolTask.get", admin.headers, { params })).toEqual(checked);
        expect(
          await call("admin.file.get", admin.headers, { params: { fileId: file.fileId } }),
        ).toMatchObject({ status: "stored", liveRefCount: 1, purgeAfter: null });
        expect(
          await call("admin.patrolTask.summary", admin.headers, {
            query: { storeId: owner.storeId },
          }),
        ).toMatchObject({ all: 1, pending: 0, abnormal: 0, normal: 1, checked: 1 });
      },
    });
    expect(report.episodeCount).toBe(20);
    expect(report.final).toEqual({
      order: "live",
      item: "live",
      ticket: "in_service",
      isLive: true,
    });
    expect(report.invariants).toEqual({
      status: "succeeded",
      violationsFound: 0,
      errors: 0,
      checksRun: full.length,
    });
    process.stdout.write(`W6-03主链完成：20集、巡检正常、全仓full ${full.length}项零违规\n`);
  } finally {
    await support.close();
  }
  expect(
    performance.now() - started,
    "装配、迁移、种子、真实制作上线、巡检、全量不变量与清理总墙钟",
  ).toBeLessThanOrEqual(90_000);
}, 90_000);
