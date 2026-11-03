import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  createM1Support,
  runM6TakedownCreate,
  settleM6TakedownBackground,
} from "@liyoxi/services/testing";
import { createM1Api } from "./e2e/in-process.js";
import { createM1Caller } from "./e2e/runner-api.js";
import { runM1Chain } from "./e2e/runner.js";
import { loginM1Staff } from "./e2e/m1-auth.js";

const evidence = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4o8AAAAASUVORK5CYII=",
  "base64",
);

it("W6-04 真实二十集制作上线、创建下架、商家确认和留证核查归档，全仓full零违规", async () => {
  const started = performance.now(),
    support = await createM1Support();
  process.stdout.write(`W6-04隔离资源：${support.databaseName}；${support.redisPrefix}\n`);
  try {
    const full = support.runtime.assembly.invariants.filter((check) =>
      check.modes.includes("full"),
    );
    expect(full.map((check) => check.code)).toEqual(
      expect.arrayContaining([
        "publish.I16",
        "publish.I17",
        "publish.I18",
        "publish.I19",
        "publish.I20",
        "timers.I7",
      ]),
    );
    const report = await runM1Chain({
      api: createM1Api(support),
      support,
      episodeCount: 20,
      uploadConcurrency: 4,
      say: (message) => process.stdout.write(`W6-04：${message}\n`),
      afterChain: async ({ api, admin, owner, scope }) => {
        const call = createM1Caller(api);
        const live = await support.readState(scope);
        expect(live.item).toMatchObject({ phase: "live", liveEpisodeCount: 20 });
        expect(live.ticket?.step).toBe("in_service");
        await runM6TakedownCreate(support, scope);
        await settleM6TakedownBackground(support, scope);
        // A distinct operations client follows the M2/M3/M4 clock-advance checks;
        // Redis keeps its real-time login limits while the business clock advances.
        const operationsApi = {
          ...api,
          request: (path: string, init?: Parameters<typeof api.request>[1]) =>
            api.request(path, { ...init, peer: "198.19.6.4" }),
        };
        const freshAdmin = await loginM1Staff(operationsApi, admin);
        const agreements = await call("m.agreement.list", {}, { query: { scene: "login" } });
        const consents = agreements.items
          .filter((a) => a.subjectKind === "user" && a.currentVersion)
          .map((a) => ({
            agreementKey: a.agreementKey,
            agreementVersionId: a.currentVersion!.agreementVersionId,
          }));
        const login = await call(
          "m.session.phoneLogin",
          {},
          {
            body: {
              loginCode: `m1-login-${support.runId}`,
              phoneCode: `m1-phone-${support.runId}`,
              consents,
            },
          },
        );
        expect(login.me.user.merchantUserId).toBe(owner.merchantUserId);
        const merchantHeaders = {
          authorization: `Bearer ${login.token}`,
          "X-Store-Id": owner.storeId,
          "X-Client-Version": "1.0.0",
        };
        const listed = await call("m.takedownTask.list", merchantHeaders, {
          query: { orderId: scope.orderId, tab: "pending" },
        });
        expect(listed.items).toHaveLength(1);
        const task = listed.items[0]!;
        expect(task).toMatchObject({
          status: "pending_merchant",
          basis: "live",
          episodeCount: 20,
          allowedMethods: ["delete", "private"],
        });
        const params = { takedownTaskId: task.takedownTaskId };
        expect(
          await call("m.takedownTask.confirm", merchantHeaders, {
            params,
            body: { method: "delete" },
          }),
        ).toMatchObject({
          status: "merchant_confirmed",
          merchantMethod: "delete",
          replayed: false,
        });
        expect((await support.readState(scope)).ticket?.step).toBe("takedown");
        const files: string[] = [];
        for (let n = 0; n < 2; n++) {
          const file = await call("admin.file.create", freshAdmin.headers, {
            body: {
              category: "evidence",
              storeId: owner.storeId,
              fileName: `takedown-${n}.png`,
              mime: "image/png",
              sizeBytes: String(evidence.length),
              clientToken: randomUUID(),
            },
          });
          if (!file.post) throw new Error("下架证据需要实际直传表单");
          expect(
            support.providers.storage.upload(
              { ...file.post, key: file.key, expiresAt: new Date(file.expiresAt) },
              evidence,
            ),
          ).toBe(204);
          const complete = () =>
            call("admin.file.complete", freshAdmin.headers, {
              params: { fileId: file.fileId },
              body: {},
            });
          if (support.completeWithPromote) await support.completeWithPromote(file.fileId, complete);
          else await complete();
          await support.promote(file.fileId);
          files.push(file.fileId);
        }
        const templates = await call("admin.checklistTemplate.list", freshAdmin.headers, {
          query: { code: "takedown.check", status: "active" },
        });
        expect(templates.items).toHaveLength(1);
        const checklist = templates.items[0]!;
        expect(
          await call("admin.takedownTask.check", freshAdmin.headers, {
            params,
            body: {
              checklistCode: "takedown.check",
              checklistVersionNo: checklist.versionNo,
              results: checklist.items.map((item) => ({ key: item.key, result: "pass" as const })),
              evidenceFileIds: files,
            },
          }),
        ).toMatchObject({
          status: "checked",
          checkMethod: "evidence",
          evidenceFileIds: files,
          ticket: { step: "archived" },
        });
        await settleM6TakedownBackground(support, scope);
        const closed = await support.readState(scope);
        expect(closed.ticket?.step).toBe("archived");
        expect(closed.item?.phase).toBe("ended");
        expect(closed.order?.status).toBe("ended");
        for (const fileId of files)
          expect(
            await call("admin.file.get", freshAdmin.headers, { params: { fileId } }),
          ).toMatchObject({ status: "stored", liveRefCount: 1, purgeAfter: null });
        expect(
          await call("m.takedownTask.summary", merchantHeaders, {
            query: { orderId: scope.orderId },
          }),
        ).toMatchObject({ pending: 0, done: 1, overdue: 0 });
      },
    });
    expect(report.episodeCount).toBe(20);
    // The runner records this snapshot before afterChain; archived state is freshly read above.
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
    process.stdout.write(`W6-04主链完成：20集、下架归档、全仓full ${full.length}项零违规\n`);
  } finally {
    await support.close();
  }
  expect(
    performance.now() - started,
    "迁移、制作、下架归档、全量不变量与清理总墙钟",
  ).toBeLessThanOrEqual(90_000);
}, 90_000);
