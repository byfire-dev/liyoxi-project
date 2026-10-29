import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@liyoxi/db";
import { ProductionRecordViewSchema } from "@liyoxi/contract";
import { createIdentityContext, createIdempotencyContext, uuidv7 } from "../kernel/index.js";
import {
  createProductionActionsTools,
  sampleStaffContext,
  useSeededDatabase,
} from "../testing/index.js";
import type { MediaActor } from "./index.js";

const handle = useSeededDatabase("services");
let db: PrismaClient;
const close: Array<() => Promise<void>> = [];
beforeAll(async () => {
  db = await handle.prisma();
});
afterEach(async () => {
  for (const action of close.splice(0)) await action();
});

async function fixture(kind: "final" | "sample" = "final") {
  const h = await createProductionActionsTools(db, kind);
  close.push(h.close);
  expect(h.source.pipelineState).toBe("ready");
  return h;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const tools = [{ name: "AI剪辑", version: "1", usedFor: "画面处理" }];
function idem(h: Fixture, action: string, key: string, body: unknown) {
  return {
    idem: createIdempotencyContext({
      mode: "required",
      scope: `admin.productionRecord.${action}`,
      actor: h.actor.identity.actor,
      key,
      request: { method: "POST", body },
    }),
  };
}
async function probeTarget(h: Fixture, id: string) {
  const job = await db.mediaJob.findFirstOrThrow({
    where: { kind: "probe", subjectId: id, state: "queued" },
    orderBy: { id: "desc" },
  });
  await h.media.jobs.run({ jobId: job.id });
  return h.tx.run((tx) => h.media.deliveryProductionFacts(tx, id));
}
async function writes() {
  const [files, records, jobs, audits, events] = await Promise.all([
    db.fileObject.count(),
    db.productionRecord.count(),
    db.mediaJob.count(),
    db.auditLog.count(),
    db.outboxEvent.count(),
  ]);
  return { files, records, jobs, audits, events };
}

describe("人工制作公口沿原任务受理与回读", { timeout: 60000 }, () => {
  it("人工重检规则升级后复用在途，原worker取消后显示恢复入口并以新规则成功", async () => {
    const h = await fixture(),
      first = await h.media.productionActions.recheck(h.actor, h.source.fileId, {});
    h.setRuleVersion(2);
    expect(await h.media.productionActions.recheck(h.actor, h.source.fileId, {})).toEqual(first);
    await h.media.jobs.run({ jobId: first.mediaJobId });
    expect((await db.mediaJob.findUniqueOrThrow({ where: { id: first.mediaJobId } })).state).toBe(
      "canceled",
    );
    expect(
      (await db.productionRecord.findUniqueOrThrow({ where: { fileId: h.source.fileId } }))
        .pipelineState,
    ).toBe("checking");
    const before = await writes(),
      view = await h.media.productionActions.list(h.actor, {
        fileIds: [h.source.fileId],
        page: 1,
        pageSize: 20,
      });
    expect(view.items[0]!.actions).toEqual(["recheck"]);
    expect(await writes()).toEqual(before);
    const next = await h.media.productionActions.recheck(h.actor, h.source.fileId, {});
    expect(next.mediaJobId).not.toBe(first.mediaJobId);
    expect(next.pipelineState).toBe("checking");
    expect(
      (await h.tx.run((tx) => h.media.deliveryProductionFacts(tx, h.source.fileId))).ready,
    ).toBe(false);
    await h.media.jobs.run({ jobId: next.mediaJobId });
    expect(
      (await h.tx.run((tx) => h.media.deliveryProductionFacts(tx, h.source.fileId))).ready,
    ).toBe(true);
    expect(
      (await db.mediaCheck.findUniqueOrThrow({ where: { fileId: h.source.fileId } })).ruleVersion,
    ).toBe(2);
  });

  it("人工重检真实失败后可重发；无manual终态证明的checking不开放恢复", async () => {
    const h = await fixture(),
      first = await h.media.productionActions.recheck(h.actor, h.source.fileId, {});
    h.setProbeFailure(true);
    await h.media.jobs.run({ jobId: first.mediaJobId });
    expect((await db.mediaJob.findUniqueOrThrow({ where: { id: first.mediaJobId } })).state).toBe(
      "failed",
    );
    expect(
      (
        await h.media.productionActions.list(h.actor, {
          fileIds: [h.source.fileId],
          page: 1,
          pageSize: 20,
        })
      ).items[0]!.actions,
    ).toEqual(["recheck"]);
    h.setProbeFailure(false);
    const next = await h.media.productionActions.recheck(h.actor, h.source.fileId, {});
    await h.media.jobs.run({ jobId: next.mediaJobId });
    expect(
      (await h.tx.run((tx) => h.media.deliveryProductionFacts(tx, h.source.fileId))).ready,
    ).toBe(true);
    // Rejection fixture: a checking flag alone cannot manufacture manual recovery evidence.
    await db.productionRecord.update({
      where: { fileId: h.source.fileId },
      data: { pipelineState: "checking" },
    });
    await expect(
      h.media.productionActions.recheck(h.actor, h.source.fileId, {}),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(
      (
        await h.media.productionActions.list(h.actor, {
          fileIds: [h.source.fileId],
          page: 1,
          pageSize: 20,
        })
      ).items[0]!.actions,
    ).toEqual([]);
  });

  it("广告3秒片头与6秒片尾从uploading经实际probe成为ready且无需原片context", async () => {
    for (const [adKind, durationMs] of [
      ["head", 3000],
      ["tail", 6000],
    ] as const) {
      const h = await createProductionActionsTools(db, "ad", {
        adKind,
        durationMs,
        skipInitialProbe: true,
      });
      close.push(h.close);
      expect(h.ad).toMatchObject({ status: "producing", confirmedVersionNo: null });
      expect(h.initial).toMatchObject({
        kind: "ad",
        pipelineState: "uploading",
        dramaEpisodeMasterId: null,
        orderItemId: null,
      });
      expect(await db.mediaCheck.findUnique({ where: { fileId: h.source.fileId } })).toBeNull();
      expect((await h.tx.run((tx) => h.media.adProductionFacts(tx, h.source.fileId))).ready).toBe(
        false,
      );
      await h.media.jobs.run({ jobId: h.probe });
      const facts = await h.tx.run((tx) => h.media.adProductionFacts(tx, h.source.fileId));
      expect(facts).toMatchObject({ valid: true, ready: true, gate: "pass", durationMs });
      expect(facts.production).toMatchObject({
        kind: "ad",
        adId: h.ad!.id,
        pipelineState: "ready",
        aigcState: "not_required",
      });
      expect(
        (await h.tx.run((tx) => h.media.deliveryProductionFacts(tx, h.source.fileId))).ready,
      ).toBe(false);
    }
  });

  it("广告事实拒绝错时长、旧规则和伪来源，不以持久化ready替代原probe证明", async () => {
    const wrong = await createProductionActionsTools(db, "ad", {
      adKind: "head",
      durationMs: 6000,
    });
    close.push(wrong.close);
    expect(
      await wrong.tx.run((tx) => wrong.media.adProductionFacts(tx, wrong.source.fileId)),
    ).toMatchObject({ valid: true, ready: false, gate: "reject" });
    const h = await createProductionActionsTools(db, "ad", { adKind: "head", durationMs: 3000 });
    close.push(h.close);
    expect((await h.tx.run((tx) => h.media.adProductionFacts(tx, h.source.fileId))).ready).toBe(
      true,
    );
    h.setRuleVersion(2);
    expect((await h.tx.run((tx) => h.media.adProductionFacts(tx, h.source.fileId))).ready).toBe(
      false,
    );
    const recheck = await h.media.productionActions.recheck(h.actor, h.source.fileId, {});
    await h.media.jobs.run({ jobId: recheck.mediaJobId });
    expect((await h.tx.run((tx) => h.media.adProductionFacts(tx, h.source.fileId))).ready).toBe(
      true,
    );
    await db.productionRecord.update({
      where: { fileId: h.source.fileId },
      data: { source: "render" },
    });
    expect((await h.tx.run((tx) => h.media.adProductionFacts(tx, h.source.fileId))).ready).toBe(
      false,
    );
  });

  it("广告人工补标沿真实派生及probe来源证明，AI回读或来源摘要漂移即拒绝", async () => {
    const h = await createProductionActionsTools(db, "ad", { adKind: "tail", durationMs: 6000 });
    close.push(h.close);
    const accepted = await h.media.productionActions.restamp(h.actor, h.source.fileId, {
      tools,
      note: "更正广告AI声明",
    });
    await h.media.jobs.run({ jobId: accepted.mediaJobId });
    const probe = await db.mediaJob.findFirstOrThrow({
      where: { kind: "probe", subjectId: accepted.productionRecordId, state: "queued" },
    });
    await h.media.jobs.run({ jobId: probe.id });
    const facts = await h.tx.run((tx) =>
      h.media.adProductionFacts(tx, accepted.productionRecordId),
    );
    expect(facts).toMatchObject({ valid: true, ready: true, automaticRestamp: false });
    expect(facts.production).toMatchObject({
      aiUsage: { used: true },
      aigcState: "verified",
      derivedFromFileId: h.source.fileId,
    });
    const info = await db.mediaInfo.findUniqueOrThrow({
      where: { fileId: accepted.productionRecordId },
    });
    await db.mediaInfo.update({
      where: { fileId: accepted.productionRecordId },
      data: {
        aigcMeta: { ...(info.aigcMeta as Record<string, string>), ProduceID: "tampered-readback" },
      },
    });
    expect(
      (await h.tx.run((tx) => h.media.adProductionFacts(tx, accepted.productionRecordId))).ready,
    ).toBe(false);
    await db.fileObject.update({
      where: { id: h.source.fileId },
      data: { sha256: "0".repeat(64) },
    });
    expect(
      (await h.tx.run((tx) => h.media.adProductionFacts(tx, accepted.productionRecordId))).valid,
    ).toBe(false);
    expect(
      (await db.productionRecord.findUniqueOrThrow({ where: { fileId: h.source.fileId } })).aiUsage,
    ).toEqual(h.source.aiUsage);
    expect(await db.adVersion.count({ where: { fileId: accepted.productionRecordId } })).toBe(0);
  });

  it("规则升级仍复用有效人工进行中目标，原worker取消后才允许新代次", async () => {
    for (const action of ["normalize", "restamp"] as const) {
      const h = await fixture(),
        body = { tools, note: "核验规则升级期间的重复提交" },
        request = () =>
          action === "normalize"
            ? h.media.productionActions.normalize(h.actor, h.source.fileId, { note: body.note })
            : h.media.productionActions.restamp(h.actor, h.source.fileId, body);
      const first = await request(),
        before = await writes();
      h.setRuleVersion(2);
      expect(await request()).toEqual(first);
      expect(await writes()).toEqual(before);
      expect(
        await db.mediaJob.count({
          where: {
            kind: action,
            subjectId: h.source.fileId,
            state: { in: ["queued", "running", "submitting", "submitted"] },
          },
        }),
      ).toBe(1);
      await h.media.jobs.run({ jobId: first.mediaJobId });
      expect((await db.mediaJob.findUniqueOrThrow({ where: { id: first.mediaJobId } })).state).toBe(
        "canceled",
      );
      const next = await request();
      expect(next.productionRecordId).not.toBe(first.productionRecordId);
      expect(
        (await db.mediaJob.findUniqueOrThrow({ where: { id: next.mediaJobId } })).input,
      ).toMatchObject({ ruleVersion: 2 });
      expect(
        await db.mediaJob.count({
          where: {
            kind: action,
            subjectId: h.source.fileId,
            state: { in: ["queued", "running", "submitting", "submitted"] },
          },
        }),
      ).toBe(1);
    }
  });

  it("补标预建真实目标、幂等重放与进行中复用，原声明不变且成功仍不采纳", async () => {
    const h = await fixture(),
      body = { tools, note: "补充遗漏的AI声明" },
      key = uuidv7();
    const first = await h.media.productionActions.restamp(
      h.actor,
      h.source.fileId,
      body,
      idem(h, "restamp", key, body),
    );
    expect(first).toMatchObject({
      sourceFileId: h.source.fileId,
      pipelineState: "uploading",
      jobKind: "restamp",
      jobState: "queued",
    });
    expect(first.productionRecordId).not.toBe(h.source.fileId);
    const pendingFile = await db.fileObject.findUniqueOrThrow({
        where: { id: first.productionRecordId },
      }),
      target = await db.productionRecord.findUniqueOrThrow({
        where: { fileId: first.productionRecordId },
      });
    expect(pendingFile).toMatchObject({
      status: "pending",
      uploadBatchId: null,
      sha256: null,
      sizeBytes: null,
    });
    expect(target).toMatchObject({
      pipelineState: "uploading",
      source: "restamped",
      derivedFromFileId: h.source.fileId,
      uploadedByStaffId: null,
      aiUsage: { used: true, tools, declaredBy: h.actor.staff!.staff.id },
    });
    const snapshot = await writes();
    expect(
      await h.media.productionActions.restamp(
        h.actor,
        h.source.fileId,
        body,
        idem(h, "restamp", key, body),
      ),
    ).toEqual(first);
    expect(await h.media.productionActions.restamp(h.actor, h.source.fileId, body)).toEqual(first);
    expect(await writes()).toEqual(snapshot);
    await h.media.jobs.run({ jobId: first.mediaJobId });
    expect(
      (await db.productionRecord.findUniqueOrThrow({ where: { fileId: target.fileId } }))
        .pipelineState,
    ).toBe("checking");
    const facts = await probeTarget(h, target.fileId);
    expect(facts).toMatchObject({ valid: true, ready: true, automaticRestamp: false });
    expect(facts.production!.aiUsage).toEqual(target.aiUsage);
    expect(
      (await db.productionRecord.findUniqueOrThrow({ where: { fileId: h.source.fileId } })).aiUsage,
    ).toEqual(h.source.aiUsage);
    expect(await db.episodeOutput.count({ where: { fileId: target.fileId } })).toBe(0);
    expect(await db.sample.count({ where: { fileId: target.fileId } })).toBe(0);
    expect(await db.adVersion.count({ where: { fileId: target.fileId } })).toBe(0);
    const next = await h.media.productionActions.restamp(h.actor, h.source.fileId, body);
    expect(next.productionRecordId).not.toBe(target.fileId);
  });

  it("规格化使用既有远端处理器，复制上下文并以真实派生与probe证明完成", async () => {
    const h = await fixture(),
      accepted = await h.media.productionActions.normalize(h.actor, h.source.fileId, {
        note: "统一交付规格",
      });
    const record = await db.productionRecord.findUniqueOrThrow({
      where: { fileId: accepted.productionRecordId },
    });
    expect(record).toMatchObject({
      source: "normalized",
      pipelineState: "uploading",
      aiUsage: h.source.aiUsage,
      dramaEpisodeMasterId: h.master!.id,
      derivedFromFileId: h.source.fileId,
    });
    await h.media.jobs.run({ jobId: accepted.mediaJobId });
    h.clock.advance(5000);
    await h.media.jobs.run({ jobId: accepted.mediaJobId });
    const job = await db.mediaJob.findUniqueOrThrow({ where: { id: accepted.mediaJobId } });
    expect(job.state).toBe("succeeded");
    const facts = await probeTarget(h, record.fileId);
    expect(facts).toMatchObject({ valid: true, ready: true, automaticRestamp: false });
    expect(await db.episodeOutput.count({ where: { fileId: record.fileId } })).toBe(0);
  });

  it("当前规则重检仍创建新代次，检查期间不能冒充ready，进行中请求复用", async () => {
    const h = await fixture(),
      first = await h.media.productionActions.recheck(h.actor, h.source.fileId, {});
    expect(first).toMatchObject({
      productionRecordId: h.source.fileId,
      pipelineState: "checking",
      jobKind: "probe",
      jobState: "queued",
    });
    expect((await h.tx.run((t) => h.media.deliveryProductionFacts(t, h.source.fileId))).ready).toBe(
      false,
    );
    expect(await h.media.productionActions.recheck(h.actor, h.source.fileId, {})).toEqual(first);
    await h.media.jobs.run({ jobId: first.mediaJobId });
    expect((await h.tx.run((t) => h.media.deliveryProductionFacts(t, h.source.fileId))).ready).toBe(
      true,
    );
    const next = await h.media.productionActions.recheck(h.actor, h.source.fileId, {});
    expect(next.mediaJobId).not.toBe(first.mediaJobId);
  });

  it("GET按真实父对象裁剪、分页且无写入，无raw；不支持操作按状态与权限拒绝", async () => {
    const h = await fixture("sample"),
      before = await writes(),
      result = await h.media.productionActions.list(h.actor, {
        fileIds: [h.source.fileId],
        page: 1,
        pageSize: 20,
      });
    expect(result.total).toBe(1);
    const view = ProductionRecordViewSchema.parse(result.items[0]);
    expect(view.actions).toEqual(["restamp", "recheck"]);
    expect(view.master).toMatchObject({ dramaEpisodeMasterId: h.master!.id, revNo: 1 });
    expect(view.media).not.toHaveProperty("raw");
    expect(await writes()).toEqual(before);
    await expect(
      h.media.productionActions.normalize(h.actor, h.source.fileId, {}),
    ).rejects.toMatchObject({
      error: "PRODUCTION_ACTION_NOT_ALLOWED",
      details: { reason: "kind" },
    });
    const outsider = await h.make.staff({ staffRoleKey: "editor", isLead: false }),
      otherActor: MediaActor = {
        staff: await sampleStaffContext(db, outsider.id),
        identity: createIdentityContext({
          actor: { type: "staff", id: outsider.id, client: "admin" },
        }),
      };
    expect(
      (
        await h.media.productionActions.list(otherActor, {
          fileIds: [h.source.fileId],
          page: 1,
          pageSize: 20,
        })
      ).items,
    ).toEqual([]);
    await expect(
      h.media.productionActions.recheck(otherActor, h.source.fileId, {}),
    ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    await expect(
      h.media.productionActions.list(h.actor, { page: 1, pageSize: 20 }),
    ).rejects.toThrow();
  });

  it("处理失败与目标声明被改时均不能产生成功事实", async () => {
    const h = await fixture(),
      accepted = await h.media.productionActions.restamp(h.actor, h.source.fileId, {
        tools,
        note: "修正AI声明",
      });
    h.codec.failStamp(true);
    await h.media.jobs.run({ jobId: accepted.mediaJobId });
    expect(
      (await db.mediaJob.findUniqueOrThrow({ where: { id: accepted.mediaJobId } })).state,
    ).toBe("failed");
    expect(
      (
        await db.productionRecord.findUniqueOrThrow({
          where: { fileId: accepted.productionRecordId },
        })
      ).pipelineState,
    ).toBe("uploading");
    expect(
      await db.mediaCheck.findUnique({ where: { fileId: accepted.productionRecordId } }),
    ).toBeNull();
    h.codec.failStamp(false);
    const next = await h.media.productionActions.restamp(h.actor, h.source.fileId, {
      tools,
      note: "重新申请",
    });
    // A malicious/stale declaration mutation is a rejection fixture, never a success shortcut.
    await db.productionRecord.update({
      where: { fileId: next.productionRecordId },
      data: { aiUsage: h.source.aiUsage! },
    });
    await h.media.jobs.run({ jobId: next.mediaJobId });
    expect((await db.mediaJob.findUniqueOrThrow({ where: { id: next.mediaJobId } })).state).toBe(
      "canceled",
    );
    expect(
      await db.mediaCheck.findUnique({ where: { fileId: next.productionRecordId } }),
    ).toBeNull();
  });
});
