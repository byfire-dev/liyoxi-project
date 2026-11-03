import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  LaunchSubmissionDetailSchema,
  PublishListAdminViewSchema,
  PublishListSaveResultSchema,
} from "@liyoxi/contract";
import type { PublishListReplaceBody } from "@liyoxi/contract";
import { createM1Support } from "@liyoxi/services/testing";
import { createM1Api, m1Data } from "./in-process.js";
import type { M1Api } from "./in-process.js";
import { createM1Caller } from "./runner-api.js";
import { runM1Chain } from "./runner.js";
import type { M1ProductionHookContext } from "./runner.js";

it("W6-02 完整二十集真实链：清单保存、核验撤销及全域 full 不变量零违规", async () => {
  const started = performance.now();
  const support = await createM1Support();
  process.stdout.write(`W6-02隔离资源：${support.databaseName}；${support.redisPrefix}\n`);
  try {
    const base = createM1Api(support),
      call = createM1Caller(base);
    let context: M1ProductionHookContext | undefined;
    let savedBody: PublishListReplaceBody | undefined;
    let savedVersion: number | undefined;
    let edits = 0;
    let revoked = false;
    // The existing hook precedes production, while afterChain follows the first link.
    // Add the real edit immediately before that link; forward every original request unchanged.
    const api: M1Api = {
      ...base,
      async request(path, init = {}) {
        if (init.method === "POST" && /^\/api\/v1\/m\/launch-tasks\/[^/]+\/submit$/.test(path)) {
          expect(edits).toBe(0);
          if (!context) throw new Error("真实制作上下文尚未进入");
          const listPath = `/api/v1/admin/delivery-tickets/${context.scope.deliveryTicketId}/publish-list`;
          const headers = context.admin.headers;
          const before = PublishListAdminViewSchema.parse(
            await m1Data(
              await base.request(listPath, { headers }),
              "admin.deliveryTicket.publishList.get",
            ),
          );
          expect(before).toMatchObject({ isEditable: true, ticket: { step: "awaiting_launch" } });
          expect(before.episodes).toHaveLength(20);
          savedBody = {
            lockVersion: before.lockVersion,
            collectionName: before.collectionName,
            coverFileId: before.cover?.fileId ?? null,
            titleTemplate: before.titleTemplate,
            topics: before.topics,
            intro: before.intro,
            episodes: before.episodes.map((episode) => ({
              episodeNo: episode.episodeNo,
              title: `整装清单第${episode.episodeNo}集`,
              highlight: episode.highlight,
              topics: episode.topics,
              intro: episode.intro,
            })),
          };
          const saved = PublishListSaveResultSchema.parse(
            await m1Data(
              await base.request(listPath, {
                method: "PUT",
                headers: { ...headers, "Idempotency-Key": randomUUID() },
                json: savedBody,
              }),
              "admin.deliveryTicket.publishList.replace",
            ),
          );
          savedVersion = saved.lockVersion;
          expect(savedVersion).toBe(before.lockVersion + 1);
          const current = PublishListAdminViewSchema.parse(
            await m1Data(await base.request(listPath, { headers })),
          );
          expect(current.lockVersion).toBe(savedVersion);
          expect(current.episodes.map((episode) => episode.renderedTitle)).toEqual(
            savedBody.episodes.map((episode) => episode.title),
          );
          edits++;
        }
        return base.request(path, init);
      },
    };
    const report = await runM1Chain({
      api,
      support,
      episodeCount: 20,
      uploadConcurrency: 4,
      say: (message) => process.stdout.write(`W6-02整装：${message}\n`),
      beforeEpisodes: async (current) => {
        context = current;
      },
      afterChain: async ({ scope, admin, owner }) => {
        expect(edits).toBe(1);
        const listPath = `/api/v1/admin/delivery-tickets/${scope.deliveryTicketId}/publish-list`;
        const locked = PublishListAdminViewSchema.parse(
          await m1Data(await base.request(listPath, { headers: admin.headers })),
        );
        expect(locked).toMatchObject({
          lockVersion: savedVersion,
          isEditable: false,
          lockReason: "links_submitted",
        });
        const rejected = await base.request(listPath, {
          method: "PUT",
          headers: { ...admin.headers, "Idempotency-Key": randomUUID() },
          json: { ...savedBody, lockVersion: locked.lockVersion },
        });
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toMatchObject({ error: "PUBLISH_LIST_LOCKED" });
        const ticket = await call("admin.deliveryTicket.get", admin.headers, {
          params: { deliveryTicketId: scope.deliveryTicketId },
        });
        const submissionId = ticket.launch.tasks[0]?.currentLaunchSubmissionId;
        expect(submissionId).toBeTruthy();
        if (!submissionId) throw new Error("真实已核验回填缺失");
        const old = await call("admin.launchSubmission.get", admin.headers, {
          params: { launchSubmissionId: submissionId },
        });
        expect(old).toMatchObject({ result: "passed", verifiedEpisodeCount: 20 });
        const reopened = LaunchSubmissionDetailSchema.parse(
          await m1Data(
            await base.request(`/api/v1/admin/launch-submissions/${submissionId}/revoke`, {
              method: "POST",
              headers: { ...admin.headers, "Idempotency-Key": randomUUID() },
              json: {
                reason: "整装验收复核后撤销上线事实",
                confirm: { roundNo: old.roundNo, verifiedEpisodeCount: 20 },
              },
            }),
            "admin.launchSubmission.revoke",
          ),
        );
        expect(reopened).toMatchObject({
          result: "pending",
          roundNo: old.roundNo + 1,
          reopenOfLaunchSubmissionId: submissionId,
          task: { reviewStatus: "verifying", isLive: false },
          orderItem: { phase: "to_launch", usageStartDate: null, liveEpisodeCount: 0 },
          ticket: { step: "launch_verify" },
        });
        expect(reopened.link).toEqual(old.link);
        const history = await call("admin.launchSubmission.get", admin.headers, {
          params: { launchSubmissionId: submissionId },
        });
        expect(history).toMatchObject({ result: "revoked", approval: { status: "approved" } });
        await support.drainEvents();
        const state = await support.readState({ ...scope, launchTaskId: old.launchTaskId });
        expect(state.ticket).toMatchObject({ step: "launch_verify", liveAt: null });
        expect(state.item).toMatchObject({
          phase: "to_launch",
          usageStartDate: null,
          liveEpisodeCount: 0,
        });
        expect(
          state.approvalRequests.filter(
            (row) => row.kind === "launch_link" && row.status === "pending",
          ),
        ).toMatchObject([
          { requesterStaffId: admin.staffId, dedupeKey: `launch_link:${old.launchTaskId}` },
        ]);
        const letters = await call("m.licenseLetter.list", owner.headers, {
          query: { orderId: scope.orderId },
        });
        expect(letters.items).toHaveLength(1);
        expect(letters.items[0]).toMatchObject({ status: "pending_effective" });
        revoked = true;
      },
    });
    expect(revoked).toBe(true);
    expect(report.episodeCount).toBe(20);
    // The runner's original live assertions precede afterChain; its full run follows the revoke.
    expect(report.final).toEqual({
      order: "live",
      item: "live",
      ticket: "in_service",
      isLive: true,
    });
    expect(report.invariants).toMatchObject({ status: "succeeded", violationsFound: 0, errors: 0 });
    expect(report.invariants.checksRun).toBe(
      support.runtime.assembly.invariants.filter((check) => check.modes.includes("full")).length,
    );
  } finally {
    await support.close();
  }
  expect(
    performance.now() - started,
    "装配、二十集、清单、撤销、full 与清理总墙钟",
  ).toBeLessThanOrEqual(90_000);
}, 90_000);
