import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@liyoxi/db";
import { createTxRunner, lockRows, uuidv7, assertNotInTransaction } from "../../kernel/index.js";
import {
  createClock,
  createFactories,
  createFakeMedia,
  useSeededDatabase,
} from "../../testing/index.js";
import { failed, ok } from "../../providers/types.js";
import { createMediaJobs } from "./runner.js";
import type { MediaJobs } from "./runner.js";
import { createRemoteMediaHandler } from "./remote.js";
import type { MediaProvider } from "../../providers/types.js";
const handle = useSeededDatabase("services"),
  clock = createClock();
let db: Awaited<ReturnType<typeof handle.prisma>>,
  tx: ReturnType<typeof createTxRunner>,
  fileId: string;
const owned: MediaJobs[] = [],
  ids: string[] = [];
beforeAll(async () => {
  db = await handle.prisma();
  tx = createTxRunner({ prisma: db, appEnv: "test" });
  fileId = (await createFactories({ db, clock }).fileObject()).id;
});
afterEach(async () => {
  await Promise.all(owned.splice(0).map((one) => one.shutdown()));
  await db.mediaJob.deleteMany({ where: { id: { in: ids.splice(0) } } });
});
async function row(override: Partial<Prisma.MediaJobUncheckedCreateInput> = {}) {
  const id = uuidv7();
  ids.push(id);
  return db.mediaJob.create({
    data: {
      id,
      kind: "transcode_mp4",
      provider: "fake",
      mode: "remote",
      subjectType: "file_object",
      subjectId: fileId,
      input: { version: 1 },
      dedupeKey: `w303remote:${id}`,
      state: "queued",
      nextRunAt: clock.now(),
      deadlineAt: new Date(clock.now().getTime() + 1_800_000),
      createdAt: clock.now(),
      updatedAt: clock.now(),
      ...override,
    },
  });
}
function runner(provider: MediaProvider, current: () => boolean = () => true) {
  const handler = createRemoteMediaHandler({
    provider,
    now: () => clock.now(),
    definition: {
      kind: "transcode_mp4",
      validInput: (input) => JSON.stringify(input) === '{"version":1}',
      validOutput: (output) => JSON.stringify(output) === "{}",
      current: async (t, job) => {
        await lockRows(t, "file_object", [job.subjectId]);
        return current();
      },
    },
    submission: () => ({
      tag: "Transcode",
      src: { bucket: "media", key: "test/input.mp4" },
      dst: { bucket: "media", key: "test/result.mp4" },
      template: "public-fixture-template",
    }),
  });
  const jobs = createMediaJobs({ tx, clock, ownerId: uuidv7(), handlers: [handler] });
  owned.push(jobs);
  return jobs;
}
describe("远端受理未知回查", () => {
  it("首次只记submitted，回调/假done不能跳过真实query与userData", async () => {
    const fake = createFakeMedia({ clock }),
      jobs = runner(fake),
      job = await row();
    await jobs.run({ jobId: job.id });
    expect(await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      state: "submitted",
      externalJobId: "fake-transcode-1",
      attemptNo: 1,
    });
    expect(fake.callsOf("describe")).toHaveLength(0);
    clock.advance(5000);
    await jobs.run({ jobId: job.id });
    expect((await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe(
      "succeeded",
    );
    expect(fake.callsOf("describe")).toHaveLength(1);
  });
  it("提交已受理但响应丢失，另一实例先find并恢复同号/同attempt，不重发", async () => {
    const fake = createFakeMedia({ clock });
    const accepted = fake.transcode;
    fake.transcode = async (input) => {
      assertNotInTransaction("ci-submit");
      await accepted(input);
      return failed("unavailable", "fictional response lost");
    };
    const a = runner(fake),
      b = runner(fake),
      job = await row();
    await a.run({ jobId: job.id });
    expect((await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe(
      "submitting",
    );
    clock.advance(120_001);
    await b.run({ jobId: job.id });
    expect(fake.callsOf("transcode")).toHaveLength(1);
    expect(fake.callsOf("find")).toHaveLength(1);
    expect(await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      state: "submitted",
      externalJobId: "fake-transcode-1",
      attemptNo: 1,
    });
    clock.advance(5000);
    await b.run({ jobId: job.id });
    expect((await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe(
      "succeeded",
    );
  });
  it("查找截断不是未提交证据，仅完整none才可同attempt重提", async () => {
    const fake = createFakeMedia({ clock });
    let complete = false;
    fake.find = async () => ok({ job: null, complete });
    fake.transcode = async () => failed("unavailable", "response lost");
    const jobs = runner(fake),
      job = await row();
    await jobs.run({ jobId: job.id });
    clock.advance(120_001);
    await jobs.run({ jobId: job.id });
    expect((await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe(
      "submitting",
    );
    let submissions = 0;
    fake.transcode = async () => {
      submissions++;
      return ok({ processed: true, jobId: "new-native-job", state: "submitted" });
    };
    complete = true;
    clock.advance(120_001);
    await jobs.run({ jobId: job.id });
    expect(submissions).toBe(1);
    expect(await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      state: "submitted",
      attemptNo: 1,
      externalJobId: "new-native-job",
    });
  });
  it("遗留替身缺find/describe受控pending，直到deadline，不盲目重发", async () => {
    const fake = createFakeMedia({ clock });
    const { find: _find, describe: _describe, cancel: _cancel, ...legacy } = fake;
    let calls = 0;
    const provider: MediaProvider = {
      ...legacy,
      transcode: async () => {
        calls++;
        return failed("unavailable", "lost");
      },
    };
    const jobs = runner(provider),
      job = await row();
    await jobs.run({ jobId: job.id });
    clock.advance(120_001);
    await jobs.run({ jobId: job.id });
    expect(calls).toBe(1);
    expect((await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe(
      "submitting",
    );
    clock.advance(1_800_000);
    await jobs.run({ jobId: job.id });
    expect((await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe("failed");
  });
  it("错误attempt userData或processed:false结果不持久成功/敏感结果", async () => {
    const fake = createFakeMedia({ clock }),
      jobs = runner(fake),
      job = await row();
    await jobs.run({ jobId: job.id });
    fake.describe = async () =>
      ok({
        jobId: "fake-transcode-1",
        userData: `${job.id}:2`,
        state: "succeeded",
        processed: true,
        output: {},
      });
    clock.advance(5000);
    await jobs.run({ jobId: job.id });
    expect(await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      state: "failed",
      errorCode: "MEDIA_REMOTE_RESULT_INVALID",
      output: null,
    });
    const second = await row();
    fake.transcode = async () => ok({ jobId: "fake-no-process", state: "done", processed: false });
    await jobs.run({ jobId: second.id });
    expect(await db.mediaJob.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({
      state: "failed",
      errorCode: "MEDIA_NOT_PROCESSED",
    });
  });
  it("业务删除后的已提交job同TX取消，TX外仅取消该外部号", async () => {
    const fake = createFakeMedia({ clock });
    let needed = true;
    const jobs = runner(fake, () => needed),
      job = await row();
    await jobs.run({ jobId: job.id });
    const cancel = fake.cancel!;
    fake.cancel = async (input) => {
      assertNotInTransaction("ci-cancel");
      return cancel(input);
    };
    needed = false;
    clock.advance(5000);
    await jobs.run({ jobId: job.id });
    expect((await db.mediaJob.findUniqueOrThrow({ where: { id: job.id } })).state).toBe("canceled");
    expect(fake.callsOf("cancel")).toHaveLength(1);
    expect(fake.jobs[0]?.canceled).toBe(true);
  });
});
