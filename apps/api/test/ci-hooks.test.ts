import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { security, uuidv7 } from "@liyoxi/services";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
const handle = useTestApi();
const key = "public-fake-ci-callback-key-with-32-bytes";
let app: TestApi, db: Awaited<ReturnType<typeof handle.db.prisma>>;
const operationId = "hooks.ci.mediaJob.wake";
beforeAll(async () => {
  app = await handle.start({
    webhookSources: [
      security.createCiWebhookSource({
        key,
        wake: (tx, input) => app.runtime.media.wakeCiJob(tx, input),
      }),
    ],
  });
  db = await handle.db.prisma();
}, 180_000);
async function job(state = "submitted", externalJobId = "jnative") {
  const id = uuidv7();
  return db.mediaJob.create({
    data: {
      id,
      kind: "transcode_mp4",
      provider: "ci",
      mode: "remote",
      subjectType: "file_object",
      subjectId: uuidv7(),
      input: {},
      dedupeKey: `w303ci:${id}`,
      state,
      attemptNo: 2,
      leaseOwner: "owner-fixture",
      externalJobId,
      finishedAt: ["succeeded", "failed", "canceled"].includes(state) ? app.clock.now() : null,
      nextRunAt: new Date(app.clock.now().getTime() + 60_000),
      deadlineAt: new Date(app.clock.now().getTime() + 1_800_000),
      createdAt: app.clock.now(),
      updatedAt: app.clock.now(),
    },
  });
}
function request(
  id: string,
  body: unknown = {
    EventName: "TaskFinish",
    JobsDetail: [{ JobId: "jnative", State: "Success", UserInfo: "fictional-sensitive" }],
  },
  signature = createHmac("sha256", key).update(id).digest("base64url"),
) {
  return app.request(`/api/v1/hooks/ci/media-jobs/${id}?sig=${signature}`, {
    method: "POST",
    ...(typeof body === "string"
      ? { body, headers: { "Content-Type": "application/xml" } }
      : { json: body }),
  });
}
describe(operationId + "实际只唤醒回调", () => {
  it("官方JSON单JobsDetail数组：只submitted nextRunAt，自然去重且无payload/input/output外来结果", async () => {
    const row = await job();
    expect((await request(row.id)).status).toBe(200);
    const woke = await db.mediaJob.findUniqueOrThrow({ where: { id: row.id } });
    expect(woke).toEqual({ ...row, nextRunAt: app.clock.now(), updatedAt: app.clock.now() });
    expect((await request(row.id)).status).toBe(200);
    const receipt = await db.webhookEvent.findMany({
      where: { provider: "ci", eventId: `${row.id}:jnative` },
    });
    expect(receipt).toHaveLength(1);
    expect(receipt[0]).toMatchObject({ mode: "inline", payload: null, processState: "processed" });
    expect(JSON.stringify(receipt)).not.toContain("fictional-sensitive");
  });
  it("官方XML格式仅抽取JobId，坏结构/多任务/DTD拒绝400零入箱", async () => {
    const row = await job();
    expect(
      (
        await request(
          row.id,
          "<Response><EventName>TaskFinish</EventName><JobsDetail><JobId>jnative</JobId><State>Failed</State></JobsDetail></Response>",
        )
      ).status,
    ).toBe(200);
    for (const body of [
      "<Response><JobsDetail><JobId>jnative</JobId>",
      "<!DOCTYPE X><Response><JobsDetail><JobId>x</JobId></JobsDetail></Response>",
      { JobsDetail: [{ JobId: "x" }, { JobId: "y" }] },
      { JobsDetail: { JobId: 123 } },
      { secret: "fictional-sensitive" },
    ]) {
      const id = uuidv7();
      expect((await request(id, body)).status).toBe(400);
      expect(await db.webhookEvent.count({ where: { eventId: { startsWith: id } } })).toBe(0);
    }
  });
  it("签错/未配/落库失败分别401/500，ACK不暴露密钥/结果正文", async () => {
    const id = uuidv7(),
      bad = await request(id, undefined, "A".repeat(43));
    expect(bad.status).toBe(401);
    expect(await bad.text()).toBe("");
    const unconfigured = await handle.start();
    const response = await unconfigured.request(
      `/api/v1/hooks/ci/media-jobs/${id}?sig=${"A".repeat(43)}`,
      { method: "POST", json: { JobsDetail: { JobId: "x" } } },
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
    const failing = await handle.start({
      webhookSources: [
        security.createCiWebhookSource({
          key,
          wake: async () => {
            throw new Error("fictional-sensitive-db");
          },
        }),
      ],
    });
    const signed = createHmac("sha256", key).update(id).digest("base64url");
    const failed = await failing.request(`/api/v1/hooks/ci/media-jobs/${id}?sig=${signed}`, {
      method: "POST",
      json: { JobsDetail: { JobId: "jfail" } },
    });
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe("");
    expect(await db.webhookEvent.count({ where: { provider: "ci", eventId: `${id}:jfail` } })).toBe(
      0,
    );
  });
  it("错attempt外部号/非submitted/不存在记ignored，租约与结果整行不改", async () => {
    for (const state of ["queued", "running", "submitting", "succeeded", "failed", "canceled"]) {
      const row = await job(state);
      expect((await request(row.id)).status).toBe(200);
      expect(await db.mediaJob.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
      expect(
        (
          await db.webhookEvent.findUniqueOrThrow({
            where: { provider_eventId: { provider: "ci", eventId: `${row.id}:jnative` } },
          })
        ).processState,
      ).toBe("ignored");
    }
    const oldAttempt = await job("submitted", "jcurrent");
    expect((await request(oldAttempt.id)).status).toBe(200);
    expect(await db.mediaJob.findUniqueOrThrow({ where: { id: oldAttempt.id } })).toEqual(
      oldAttempt,
    );
    const id = uuidv7();
    expect((await request(id)).status).toBe(200);
    expect(
      (
        await db.webhookEvent.findUniqueOrThrow({
          where: { provider_eventId: { provider: "ci", eventId: `${id}:jnative` } },
        })
      ).processState,
    ).toBe("ignored");
  });
});
