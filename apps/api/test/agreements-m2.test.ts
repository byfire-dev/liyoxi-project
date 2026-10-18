// Actual handlers, middleware, owned Storage bytes and API-built CPU worker. All text is fictional.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createIdentityContext, runSeed, SEED_MODULES } from "@liyoxi/services";
import type { AgreementActor } from "@liyoxi/services";
import type { operations } from "@liyoxi/contract/types/admin";
import type {
  AgreementDetail,
  AgreementVersionMutationResult,
  AgreementConsentDetail,
  AgreementConsentItem,
  AgreementVersionScheduleResultSchema,
  AgreementVersionWithdrawResultSchema,
  z,
} from "@liyoxi/contract";
import {
  createDocsAdminFixture,
  createFactories,
  fictionalDocumentPdf,
  sampleStaffContext,
  signInAsStaff,
} from "@liyoxi/services/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const testApi = useTestApi();
const apiDir = fileURLToPath(new URL("../", import.meta.url));
const output = `dist/test-agreement-http-${process.pid}-${Date.now().toString(36)}`;
let api: TestApi;
let fixture: ReturnType<typeof createDocsAdminFixture>;
let editor: Awaited<ReturnType<typeof signInAsStaff>>;
type Schedule = z.infer<typeof AgreementVersionScheduleResultSchema>;
type Withdrawal = z.infer<typeof AgreementVersionWithdrawResultSchema>;
interface Envelope<T> {
  readonly data: T;
  readonly error?: string;
  readonly details?: unknown;
}
async function actorFor(
  signed: Awaited<ReturnType<typeof signInAsStaff>>,
): Promise<AgreementActor> {
  const requestId = crypto.randomUUID();
  return {
    staff: await sampleStaffContext(fixture.prisma, signed.staff.id, { stepUpAt: api.clock.now() }),
    identity: createIdentityContext({
      actor: { type: "staff", id: signed.staff.id, client: "admin" },
      requestId,
    }),
    meta: {
      requestId,
      sessionId: signed.sessionId,
      authMethod: "password+totp",
      ip: null,
      userAgent: null,
    },
  };
}
type AgreementOperation = Extract<keyof operations, `admin.agreement${string}`>;
function requestPath(operationId: AgreementOperation, path: string, method: string) {
  const route = api.api.mounted.find((entry) => entry.operationId === operationId);
  if (!route) throw new Error(`实际路由未挂载：${operationId}`);
  expect(route.method).toBe(method);
  expect(`/api/v1${path.split("?")[0]}`.split("/")).toEqual(
    route.path
      .split("/")
      .map((part) => (/^\{[^}]+\}$/.test(part) ? expect.stringMatching(/^[^/]+$/) : part)),
  );
  return `/api/v1${path}`;
}
async function call<T>(
  operationId: AgreementOperation,
  path: string,
  method = "GET",
  json?: unknown,
  headers = editor.headers,
) {
  const response = await api.request(requestPath(operationId, path, method), {
    method,
    headers: {
      ...headers,
      ...(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }),
    },
    ...(json === undefined ? {} : { json }),
  });
  return { response, body: (await response.json()) as Envelope<T> };
}
beforeAll(async () => {
  await promisify(execFile)(process.execPath, ["scripts/build.mjs", "--outdir", output], {
    cwd: apiDir,
  });
  api = await testApi.start({
    documentConverterWorkerUrl: pathToFileURL(`${apiDir}${output}/document-converter.js`),
  });
  api.clock.set(new Date("2026-10-09T04:00:00.000Z"));
  await runSeed({ tx: api.runtime.tx, clock: api.clock, modules: SEED_MODULES });
  const prisma = await testApi.db.prisma();
  fixture = createDocsAdminFixture(prisma, null, {
    clock: api.clock,
    storage: api.runtime.providers.storage,
  });
  editor = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
}, 120_000);
afterAll(async () => {
  await fixture?.close();
  rmSync(`${apiDir}${output}`, { recursive: true, force: true });
});

describe("W212八条后台协议接口真实pipeline", () => {
  it("admin.agreement.list / admin.agreement.get：真实六协议分页、actions、GET零业务写", async () => {
    const prisma = await testApi.db.prisma();
    const before = await Promise.all([
      prisma.agreementVersion.count(),
      prisma.fileRef.count(),
      prisma.outboxEvent.count(),
      prisma.auditLog.count({ where: { category: "agreement" } }),
    ]);
    const list = await call<{ items: { agreementKey: string }[]; total: number }>(
      "admin.agreement.list",
      "/admin/agreements?page=1&pageSize=3",
    );
    expect(list.response.status).toBe(200);
    expect(list.body.data).toMatchObject({ total: 6 });
    expect(list.body.data.items).toHaveLength(3);
    const detail = await call<AgreementDetail>("admin.agreement.get", "/admin/agreements/user");
    expect(detail.response.status).toBe(200);
    expect(detail.body.data.agreementKey).toBe("user");
    expect(
      await Promise.all([
        prisma.agreementVersion.count(),
        prisma.fileRef.count(),
        prisma.outboxEvent.count(),
        prisma.auditLog.count({ where: { category: "agreement" } }),
      ]),
    ).toEqual(before);
    expect((await call("admin.agreement.get", "/admin/agreements/unknown")).response.status).toBe(
      404,
    );
  });
  it("admin.agreement.agreementVersion.create / admin.agreementVersion.update：同一实际worker转换、Idem与版本冲突", async () => {
    const signed = await signInAsStaff(await testApi.db.prisma(), {
      roleKey: "super_admin",
      now: api.clock.now(),
    });
    const actor = await actorFor(signed);
    // Only the file's staff owner matters here; HTTP authorization uses the real session above.
    const source = await fixture.file(actor, "docx"),
      pdf = await fixture.file(actor, "pdf");
    const input = { sourceFileId: source.id, pdfFileId: pdf.id };
    const key = crypto.randomUUID(),
      path = requestPath(
        "admin.agreement.agreementVersion.create",
        "/admin/agreements/user/agreement-versions",
        "POST",
      );
    const request = () =>
      api.request(path, {
        method: "POST",
        json: input,
        headers: { ...signed.headers, "idempotency-key": key },
      });
    const first = await request();
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const dto = ((await first.json()) as Envelope<AgreementVersionMutationResult>).data;
    expect(dto).toMatchObject({
      conversion: { state: "converted", warnings: [] },
      version: { isLegalApproved: false, contentSha256: pdf.sha256 },
    });
    expect(dto.contentHtml).toContain("狸有戏虚构协议");
    const replay = await request();
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as Envelope<AgreementVersionMutationResult>).data).toEqual(dto);
    const replacement = await fixture.file(actor, "pdf");
    const update = {
      lockVersion: dto.version.lockVersion,
      pdfFileId: replacement.id,
      summary: "真实接口虚构变更",
    };
    const updateKey = crypto.randomUUID(),
      updatePath = requestPath(
        "admin.agreementVersion.update",
        `/admin/agreement-versions/${dto.version.agreementVersionId}`,
        "PATCH",
      );
    const patch = () =>
      api.request(updatePath, {
        method: "PATCH",
        json: update,
        headers: { ...signed.headers, "idempotency-key": updateKey },
      });
    const changed = await patch();
    expect(changed.status).toBe(200);
    const changedDto = ((await changed.json()) as Envelope<AgreementVersionMutationResult>).data;
    expect(changedDto.conversion.state).toBe("converted");
    const again = await patch();
    expect(again.status).toBe(200);
    expect(((await again.json()) as Envelope<AgreementVersionMutationResult>).data).toEqual(
      changedDto,
    );
    const unavailable = vi.spyOn(api.runtime.providers.storage, "readObject").mockResolvedValue({
      ok: false,
      reason: "unavailable",
      message: "fictional object store unavailable",
    });
    try {
      const saved = await patch();
      expect(saved.status).toBe(200);
      expect(((await saved.json()) as Envelope<AgreementVersionMutationResult>).data).toEqual(
        changedDto,
      );
      const fresh = await call(
        "admin.agreementVersion.update",
        updatePath.replace("/api/v1", ""),
        "PATCH",
        {
          ...update,
          lockVersion: changedDto.version.lockVersion,
        },
        signed.headers,
      );
      expect(fresh.response.status).toBe(409);
      expect(fresh.body.error).toBe("FILE_NOT_AVAILABLE");
    } finally {
      unavailable.mockRestore();
    }
    const conflict = await call(
      "admin.agreementVersion.update",
      `/admin/agreement-versions/${dto.version.agreementVersionId}`,
      "PATCH",
      update,
      signed.headers,
    );
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error).toBe("VERSION_CONFLICT");
    expect(
      await fixture.prisma.auditLog.count({
        where: {
          targetId: dto.version.agreementVersionId,
          action: "docs.agreement_version.update",
        },
      }),
    ).toBe(1);
  });
  it("admin.agreementVersion.schedule / admin.agreementVersion.withdraw：实际公告同TX、撤回新id与保留原PDF", async () => {
    const signed = await signInAsStaff(fixture.prisma, {
      roleKey: "super_admin",
      now: api.clock.now(),
    });
    const actor = await actorFor(signed);
    const d = await fixture.draft(actor, "member");
    const scheduled = await call<Schedule>(
      "admin.agreementVersion.schedule",
      `/admin/agreement-versions/${d.version.id}/schedule`,
      "POST",
      { lockVersion: 0 },
      signed.headers,
    );
    expect(scheduled.response.status).toBe(200);
    expect(scheduled.body.data.siteNotice).toMatchObject({
      status: "announced",
      refId: d.version.id,
    });
    const withdrawn = await call<Withdrawal>(
      "admin.agreementVersion.withdraw",
      `/admin/agreement-versions/${d.version.id}/withdraw`,
      "POST",
      { reason: "虚构接口撤回" },
      signed.headers,
    );
    expect(withdrawn.response.status).toBe(200);
    expect(withdrawn.body.data).toMatchObject({
      withdrawn: { status: "withdrawn" },
      siteNotice: { status: "withdrawn" },
    });
    expect(withdrawn.body.data.newDraft?.agreementVersionId).not.toBe(d.version.id);
    expect(
      await fixture.prisma.fileRef.count({ where: { refId: d.version.id, releasedAt: null } }),
    ).toBe(2);
  });
  it("admin.agreementConsent.list / admin.agreementConsent.get：脱敏、固定device白名单与日期双端包含", async () => {
    const make = createFactories({ db: fixture.prisma, clock: api.clock });
    const version = await make.agreementVersion({
      agreementKey: "privacy",
      effectiveAt: new Date("2026-10-08T16:00:00.000Z"),
    });
    const signed = await make.agreementConsent({
      agreementKey: "privacy",
      agreementVersionId: version.id,
      scene: "reconsent",
      consentedAt: new Date("2026-10-08T16:00:00.000Z"),
      deviceSnapshot: {
        model: "Fictional",
        token: "must-not-leak",
        headers: { authorization: "Bearer never" },
      },
      ip: "203.0.113.20",
    });
    const result = await call<{ items: AgreementConsentItem[]; total: number }>(
      "admin.agreementConsent.list",
      "/admin/agreement-consents?consentedFrom=2026-10-09&consentedTo=2026-10-09",
    );
    expect(result.response.status).toBe(200);
    expect(result.body.data.items.map((r) => r.agreementConsentId)).toContain(signed.id);
    const detail = await call<AgreementConsentDetail>(
      "admin.agreementConsent.get",
      `/admin/agreement-consents/${signed.id}`,
    );
    expect(detail.response.status).toBe(200);
    expect(detail.body.data).toMatchObject({
      device: { model: "Fictional" },
      isContentHashConsistent: true,
    });
    expect(detail.body.data.phoneMask).toContain("*");
    expect(JSON.stringify(detail.body)).not.toMatch(
      /must-not-leak|Bearer never|phoneEnc|openidHmac/,
    );
    expect(
      (
        await call(
          "admin.agreementConsent.list",
          "/admin/agreement-consents?consentedFrom=2024-01-01",
        )
      ).response.status,
    ).toBe(400);
    expect(
      (
        await call(
          "admin.agreementConsent.list",
          "/admin/agreement-consents?bizId=01890000-0000-7000-8000-000000000001",
        )
      ).response.status,
    ).toBe(400);
  });
  it("索引六键与默认30天：单号不解除日期窗口，日期单侧补界且366天包含", async () => {
    const make = createFactories({ db: fixture.prisma, clock: api.clock });
    const version = await make.agreementVersion({
      agreementKey: "custom_license",
      effectiveAt: new Date(api.clock.now().getTime() - 41 * 86400000),
    });
    const old = await make.agreementConsent({
      agreementVersionId: version.id,
      consentedAt: new Date(api.clock.now().getTime() - 40 * 86400000),
    });
    const plain = await call<{ items: AgreementConsentItem[] }>(
      "admin.agreementConsent.list",
      `/admin/agreement-consents?no=${old.bizNo}`,
    );
    expect(plain.body.data.items.map((r) => r.agreementConsentId)).not.toContain(old.id);
    const indexed = await call<{ items: AgreementConsentItem[] }>(
      "admin.agreementConsent.list",
      `/admin/agreement-consents?consentNo=${old.seq}`,
    );
    expect(indexed.body.data.items.map((r) => r.agreementConsentId)).toContain(old.id);
    expect(
      (
        await call(
          "admin.agreementConsent.list",
          "/admin/agreement-consents?consentedFrom=2025-10-10&consentedTo=2026-10-10",
        )
      ).response.status,
    ).toBe(200);
    expect(
      (
        await call(
          "admin.agreementConsent.list",
          "/admin/agreement-consents?consentedFrom=2025-10-09&consentedTo=2026-10-10",
        )
      ).response.status,
    ).toBe(400);
  });
  it("模块权限/Idem/严格输入在prepare前拒绝；外员工文件不可枚举且无写入", async () => {
    const limited = await signInAsStaff(fixture.prisma, {
      roleKey: "delivery_manager",
      now: api.clock.now(),
    });
    const denied = await call(
      "admin.agreement.list",
      "/admin/agreements",
      "GET",
      undefined,
      limited.headers,
    );
    expect(denied.response.status).toBe(403);
    const missing = await api.request(
      requestPath(
        "admin.agreement.agreementVersion.create",
        "/admin/agreements/ad_service/agreement-versions",
        "POST",
      ),
      {
        method: "POST",
        json: {},
        headers: editor.headers,
      },
    );
    expect(missing.status).toBe(400);
    const strict = await call(
      "admin.agreement.agreementVersion.create",
      "/admin/agreements/ad_service/agreement-versions",
      "POST",
      {
        contentHtml: "should-not-accept-client-html",
      },
    );
    expect(strict.response.status).toBe(400);
    const owner = await fixture.actor(),
      pdf = await fixture.file(owner, "pdf");
    const foreign = await call(
      "admin.agreement.agreementVersion.create",
      "/admin/agreements/ad_service/agreement-versions",
      "POST",
      {
        pdfFileId: pdf.id,
      },
    );
    expect(foreign.response.status).toBe(404);
    expect(await fixture.prisma.fileRef.count({ where: { fileId: pdf.id } })).toBe(0);
  });
  it("m.agreementVersion.get：实际PDF现签/过期，重放读取新URL且正文不伪造", async () => {
    const actor = await fixture.actor(),
      d = await fixture.draft(actor, "ad_service", new Date(api.clock.now().getTime() + 600001));
    await fixture.admin.scheduleVersion(actor, d.version.id, { lockVersion: 0 });
    const path = `/api/v1/m/agreement-versions/${d.version.id}`;
    const response = await api.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const first = (
      (await response.json()) as Envelope<{
        pdf: { url: string; expiresAt: string };
        contentSha256: string;
      }>
    ).data;
    expect(first.pdf.url).toMatch(/^https:\/\/fake-storage\.invalid\//);
    expect(new Date(first.pdf.expiresAt).getTime()).toBeGreaterThan(api.clock.now().getTime());
    expect(first.contentSha256).toBe(
      createHash("sha256").update(fictionalDocumentPdf()).digest("hex"),
    );
    api.clock.advance(1000);
    const next = ((await (await api.request(path)).json()) as Envelope<typeof first>).data;
    expect(next.pdf.url).not.toBe(first.pdf.url);
    expect(next.contentSha256).toBe(first.contentSha256);

    // Invoke the default API-owned assembly, never a recording alert substitute.
    const digestJob = api.runtime.assembly.recurringJob("evidence.consent_digest");
    if (!digestJob) throw new Error("实际文书摘要任务没有装配");
    const storage = api.runtime.providers.storage;
    const day = "2026-10-06";
    const ref = { bucket: "secure" as const, key: `evidence/consents/${day}.json` };
    const run = () => digestJob.run({ scheduledFor: new Date("2026-10-06T16:40:00.000Z") });
    await run();
    const original = await storage.readObject({ ...ref, maxBytes: 4096 });
    if (!original.ok) throw new Error("实际摘要回读失败");
    const digest: unknown = JSON.parse(Buffer.from(original.value).toString("utf8"));
    if (!digest || typeof digest !== "object" || Array.isArray(digest))
      throw new Error("实际摘要结构不合法");
    try {
      expect(
        (
          await storage.putObject({
            ...ref,
            body: Buffer.from(JSON.stringify({ ...digest, sha256: "0".repeat(64) })),
            contentType: "application/json",
          })
        ).ok,
      ).toBe(true);
      await expect(run()).rejects.toMatchObject({ error: "FILE_NOT_AVAILABLE" });
      const rows = await fixture.prisma.alertEvent.findMany({
        where: {
          fingerprint: {
            in: [
              `evidence.consent_digest_mismatch:${day}`,
              `evidence.consent_digest_unavailable:${day}`,
            ],
          },
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        rule: "evidence.consent_digest_mismatch",
        severity: "P1",
        occurrences: 1,
        lastValue: { day, rows: 0 },
      });
    } finally {
      expect(
        (await storage.putObject({ ...ref, body: original.value, contentType: "application/json" }))
          .ok,
      ).toBe(true);
    }
    const unavailableDay = "2026-10-07";
    expect(
      (
        await storage.putObject({
          bucket: "secure",
          key: `evidence/consents/${unavailableDay}.json`,
          body: Buffer.from('{"phone":"never-log-this"'),
          contentType: "application/json",
        })
      ).ok,
    ).toBe(true);
    await expect(
      digestJob.run({ scheduledFor: new Date("2026-10-07T16:40:00.000Z") }),
    ).rejects.toMatchObject({ error: "FILE_NOT_AVAILABLE" });
    const unavailableFact = await fixture.prisma.alertEvent.findMany({
      where: { fingerprint: `evidence.consent_digest_unavailable:${unavailableDay}` },
    });
    expect(unavailableFact).toHaveLength(1);
    expect(unavailableFact[0]).toMatchObject({
      severity: "P2",
      occurrences: 1,
      lastValue: { day: unavailableDay },
    });
    expect(JSON.stringify(unavailableFact)).not.toContain("never-log-this");
  });
}, 60_000);
