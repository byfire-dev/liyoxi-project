import { afterAll, expect, it, vi } from "vitest";
import {
  AdTaskDetailSchema,
  AdminAdPageSchema,
  AdSummarySchema,
  AdminAdVersionViewSchema,
  FileRegistrationSchema,
  AdminAdRequestChangeBodySchema,
} from "@liyoxi/contract";
import { createIdempotencyContext, createIdentityContext, runSeed, uuidv7 } from "@liyoxi/services";
import {
  createDeliveryProductionTools,
  createW508OrderAdFixture,
  sampleStaffContext,
  signInAsStaff,
} from "@liyoxi/services/testing";
import type { FakeStorage, SignedInStaff } from "@liyoxi/services/testing";
import { useTestApi } from "../src/testing/index.js";
import { HANDLERS } from "../src/routes/index.js";
const h = useTestApi();
let f: Awaited<ReturnType<typeof createW508OrderAdFixture>> | undefined;
afterAll(async () => {
  vi.restoreAllMocks();
  await f?.close();
});

it(
  "十条后台广告真实HTTP：本人上传/真实probe、推送证据、代提和退回；角色范围与幂等重放不重新签名",
  { timeout: 120_000 },
  async () => {
    let codec!: ReturnType<typeof createDeliveryProductionTools>;
    const api = await h.start({
      mediaProduction: (providers) => {
        codec = createDeliveryProductionTools(providers);
        return { config: codec.env, tools: codec.tools };
      },
    });
    const p = await h.db.prisma();
    await runSeed({ tx: api.runtime.tx, clock: api.clock });
    f = await createW508OrderAdFixture(p, {
      databaseUrl: await h.db.url(),
      redisUrl: api.runtime.env.REDIS_URL,
      redisKeyPrefix: `${h.redis.prefix}admin-ad:`,
      clock: api.clock,
    });
    const target = f,
      ad = await target.createAd(),
      extra = await target.createAd();
    const admin = await signInAsStaff(p, { roleKey: "super_admin", now: api.clock.now() });
    const editor = await signInAsStaff(p, { roleKey: "editor", now: api.clock.now() });
    const oldEditorActor = {
      ctx: createIdentityContext({
        actor: { type: "staff", id: editor.staff.id, client: "admin" },
      }),
      staff: await sampleStaffContext(p, editor.staff.id, { stepUpAt: api.clock.now() }),
    };
    const denied = await signInAsStaff(p, { roleKey: "finance", now: api.clock.now() });
    let peer = 0;
    const call = (path: string, body?: unknown, who: SignedInStaff = admin, key = uuidv7()) =>
      api.request(`/api/v1/admin${path}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined ? {} : { json: body }),
        headers: { ...who.headers, "Idempotency-Key": key },
        peer: `198.19.219.${++peer}`,
      });
    async function unwrapped(response: Response): Promise<unknown> {
      const body = (await response.json()) as {
        data?: unknown;
        error?: unknown;
        details?: { fieldErrors?: { path: unknown }[]; issues?: { path: unknown }[] };
      };
      const diagnostic = {
        error: typeof body.error === "string" ? body.error : undefined,
        paths: [...(body.details?.fieldErrors ?? []), ...(body.details?.issues ?? [])].map(
          (row) => row.path,
        ),
      };
      expect(response.status, JSON.stringify(diagnostic)).toBe(200);
      return body.data;
    }
    async function data<T>(response: Response): Promise<T> {
      const value = await unwrapped(response);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      return value as T;
    }
    async function failure(response: Response, status: number, error: string) {
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error });
    }
    const operations = [
      "admin.ad.list",
      "admin.ad.summary",
      "admin.ad.get",
      "admin.ad.assign",
      "admin.ad.return",
      "admin.ad.adVersion.create",
      "admin.adVersion.markSent",
      "admin.adVersion.push",
      "admin.ad.requestChange",
      "admin.ad.remind",
    ];
    expect(HANDLERS.filter((entry) => operations.includes(entry.route.operationId))).toHaveLength(
      10,
    );
    await failure(await call(`/ads/${ad.adId}`, undefined, denied), 403, "PERMISSION_DENIED");
    await failure(await call(`/ads/${extra.adId}`, undefined, editor), 404, "NOT_FOUND");
    await data(await call(`/ads/${ad.adId}/assign`, { staffId: editor.staff.id }));
    const bytes = new Uint8Array(1234);
    bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
    const upload = FileRegistrationSchema.parse(
      await unwrapped(
        await call(
          "/files",
          {
            category: "ad_video",
            storeId: target.actor.membership.storeId,
            fileName: "ad-http.mp4",
            sizeBytes: String(bytes.length),
            clientToken: uuidv7(),
            production: { kind: "ad", adId: ad.adId, aiUsage: { used: false, tools: [] } },
          },
          editor,
        ),
      ),
    );
    const fileId = upload.fileId,
      file = await p.fileObject.findUniqueOrThrow({ where: { id: fileId } });
    (api.runtime.providers.storage as FakeStorage).put(
      { bucket: "media", key: file.incomingKey! },
      bytes,
      "video/mp4",
    );
    await unwrapped(await call(`/files/${fileId}/complete`, {}, editor));
    const promote = await p.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${fileId}` },
    });
    await api.runtime.media.jobs.run({ jobId: promote.id });
    const probe = await p.mediaJob.findFirstOrThrow({
      where: { kind: "probe", subjectId: fileId },
    });
    const original = codec.tool.probe,
      durationMs = (await p.ad.findUniqueOrThrow({ where: { id: ad.adId } })).durationSec * 1000;
    codec.tool.probe = async (input) => {
      const result = await original(input);
      if (!result.ok) return result;
      return {
        ...result,
        value: {
          ...result.value,
          format: { ...result.value.format, durationMs },
          streams: result.value.streams.map((stream) => ({
            ...stream,
            durationMs,
            nbFrames: stream.codecType === "video" ? (durationMs * 30) / 1000 : stream.nbFrames,
          })),
        },
      };
    };
    try {
      await api.runtime.media.jobs.run({ jobId: probe.id });
    } finally {
      codec.tool.probe = original;
    }
    const createKey = uuidv7(),
      createBody = { fileId, segments: [{ index: 0, fromMs: 0, toMs: durationMs, label: "整条" }] };
    const registered = AdTaskDetailSchema.parse(
      await data(await call(`/ads/${ad.adId}/ad-versions`, createBody, editor, createKey)),
    );
    const version = registered.versions[0]!;
    expect(version.preview).not.toBeNull();
    expect(version.durationMs).toBe(durationMs);
    const sign = vi.spyOn(api.runtime.media, "signRead");
    const replay = AdTaskDetailSchema.parse(
      await data(await call(`/ads/${ad.adId}/ad-versions`, createBody, editor, createKey)),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.versions[0]?.preview).toBeNull();
    expect(sign).not.toHaveBeenCalled();
    sign.mockRestore();
    await failure(
      await call(`/ads/${ad.adId}/ad-versions`, { fileId }, editor, createKey),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
    const marked = AdminAdVersionViewSchema.parse(
      await data(await call(`/ad-versions/${version.adVersionId}/mark-sent`, {})),
    );
    expect(marked.offlineSentBy?.staffId).toBe(admin.staff.id);
    const pushed = AdTaskDetailSchema.parse(
      await data(
        await call(`/ad-versions/${version.adVersionId}/push`, { includeWecom: true }, editor),
      ),
    );
    expect(pushed.status).toBe("pending_confirm");
    expect(pushed.versions[0]?.previewChannels).toEqual(["album", "portal", "wecom"]);
    const screenshotLimit = await api.runtime.config.params.get("ad.revision_screenshot_max");
    expect(screenshotLimit).toBe(1);
    const overCurrentLimit = {
      versionNo: version.versionNo,
      note: "截图超过当前配置",
      screenshotFileIds: [uuidv7(), uuidv7()],
    };
    expect(AdminAdRequestChangeBodySchema.safeParse(overCurrentLimit).success).toBe(true);
    const beforeRevision = await p.adRevision.count();
    await failure(
      await call(`/ads/${ad.adId}/request-change`, overCurrentLimit),
      400,
      "VALIDATION_FAILED",
    );
    expect(await p.adRevision.count()).toBe(beforeRevision);
    await data(await call(`/ads/${ad.adId}/remind`, {}));
    await failure(await call(`/ads/${ad.adId}/remind`, {}), 409, "REMINDED_TODAY");
    const changed = AdTaskDetailSchema.parse(
      await data(
        await call(`/ads/${ad.adId}/request-change`, {
          versionNo: version.versionNo,
          note: "实际电话代录",
          segmentIndex: 0,
        }),
      ),
    );
    expect(changed.status).toBe("revising");
    expect(changed.revisions[0]?.source).toBe("staff_on_behalf");
    const returned = AdTaskDetailSchema.parse(
      await data(await call(`/ads/${extra.adId}/return`, { reason: "请补充门店素材" })),
    );
    expect(returned.status).toBe("returned");
    expect(
      returned.recentActivities.find((row) => row.action === "ad.status.return")?.reasonText,
    ).toBe("请补充门店素材");
    const counts = await Promise.all([
      p.auditLog.count(),
      p.statusTransition.count(),
      p.outboxEvent.count(),
    ]);
    const page = AdminAdPageSchema.parse(
      await data(await call(`/ads?tab=all&storeId=${target.actor.membership.storeId}`)),
    );
    const summary = AdSummarySchema.parse(
      await data(await call(`/ads/summary?storeId=${target.actor.membership.storeId}`)),
    );
    expect(page.total).toBe(2);
    expect(summary.tabs.todo + summary.tabs.returned).toBe(page.total);
    expect(AdTaskDetailSchema.parse(await data(await call(`/ads/${ad.adId}`))).adId).toBe(ad.adId);
    expect(
      await Promise.all([p.auditLog.count(), p.statusTransition.count(), p.outboxEvent.count()]),
    ).toEqual(counts);
    // An isolated real role configuration gives group read access while revoking editing.
    // Production defaults remain unchanged; the original default-o own positive/negative cases ran above.
    const role = await api.runtime.staffRoles.get(target.admin.staff, "editor");
    await api.runtime.staffRoles.replace(
      target.admin.staff,
      target.admin.ctx.actor,
      { requestId: uuidv7(), ip: null, userAgent: null, sessionId: null, authMethod: null },
      "editor",
      {
        moduleLevels: { ...role.moduleLevels, delivery: "v" },
        actions: role.actions,
        dataScope: "group",
        lockVersion: role.lockVersion,
      },
    );
    const oldKeySign = vi.spyOn(api.runtime.media, "signRead"),
      versionCount = await p.adVersion.count();
    await expect(
      api.runtime.adminAds.registerVersion(oldEditorActor, ad.adId, createBody, {
        idem: createIdempotencyContext({
          mode: "required",
          scope: "admin.ad.adVersion.create",
          actor: oldEditorActor.ctx.actor,
          key: createKey,
          request: { method: "POST", body: createBody, storeId: target.actor.membership.storeId },
        }),
      }),
    ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    await failure(
      await call(`/ads/${ad.adId}/ad-versions`, createBody, editor, createKey),
      403,
      "PERMISSION_DENIED",
    );
    expect(oldKeySign).not.toHaveBeenCalled();
    expect(await p.adVersion.count()).toBe(versionCount);
    oldKeySign.mockRestore();
    const group = await p.staffGroup.create({
      data: {
        id: uuidv7(),
        name: "W509广告组",
        staffRoleKey: "editor",
        isDefault: false,
        createdAt: api.clock.now(),
        updatedAt: api.clock.now(),
      },
    });
    const groupLead = await signInAsStaff(p, {
      roleKey: "editor",
      isLead: true,
      staffGroupId: group.id,
      now: api.clock.now(),
    });
    const peerEditor = await signInAsStaff(p, {
      roleKey: "editor",
      staffGroupId: group.id,
      now: api.clock.now(),
    });
    await target.runtime.ads.submit(target.actor, extra.adId, {});
    await data(await call(`/ads/${extra.adId}/assign`, { staffId: peerEditor.staff.id }));
    const groupPage = AdminAdPageSchema.parse(
      await data(await call(`/ads?tab=all&editorId=${peerEditor.staff.id}`, undefined, groupLead)),
    );
    expect(groupPage.items.map((row) => row.adId)).toEqual([extra.adId]);
    expect(
      AdTaskDetailSchema.parse(await data(await call(`/ads/${extra.adId}`, undefined, groupLead)))
        .editor?.staffId,
    ).toBe(peerEditor.staff.id);
    await failure(await call(`/ads/${ad.adId}`, undefined, groupLead), 404, "NOT_FOUND");
    await failure(await call(`/ads/${extra.adId}`, undefined, editor), 404, "NOT_FOUND");
    expect(AdTaskDetailSchema.parse(await data(await call(`/ads/${extra.adId}`))).adId).toBe(
      extra.adId,
    );
    await failure(await call(`/ads/${uuidv7()}`), 404, "NOT_FOUND");
  },
);
