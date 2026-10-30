import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  audit,
  createDocsRenderRuntime,
  createLicensePdfRenderer,
  reconcileLetters,
  runSeed,
  uuidv7,
} from "@liyoxi/services";
import type { DocsRenderRuntime } from "@liyoxi/services";
import {
  createFactories,
  createLicenseConvergenceFixture,
  createTestLicenseTemplateCatalog,
  signInAsStaff,
  TEST_KEYRING,
  openSealed,
} from "@liyoxi/services/testing";
import type { FakeStorage, SignedInStaff } from "@liyoxi/services/testing";
import {
  AdminLicenseLetterViewSchema,
  LicenseLetterDetailSchema,
  LicenseLetterDownloadUrlSchema,
  LicenseLetterListSchema,
  LicenseLetterPageSchema,
  LicenseLetterRevisionViewSchema,
  LicenseLetterSummarySchema,
  LicenseLetterVoidResultSchema,
} from "@liyoxi/contract";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";

const handle = useTestApi();
const templateCatalog = createTestLicenseTemplateCatalog();
type Fixture = Awaited<ReturnType<typeof createLicenseConvergenceFixture>>;
let api: TestApi, fixture: Fixture, render: DocsRenderRuntime;
let owner: SignedInMerchant, clerk: SignedInMerchant, outsider: SignedInMerchant;
let admin: SignedInStaff, limited: SignedInStaff;
let prisma: Awaited<ReturnType<typeof handle.db.prisma>>;
let letterId: string, firstRevisionId: string, firstSnapshot: unknown, strangerStoreId: string;
let correctedRevisionId: string, correctedSnapshot: unknown;
let calls = 0;
const operations = [
  "m.licenseLetter.list",
  "m.licenseLetter.summary",
  "m.licenseLetter.get",
  "m.licenseLetter.downloadUrls",
  "admin.orderItem.licenseLetter.list",
  "admin.licenseLetter.correct",
  "admin.licenseLetter.void",
  "admin.licenseLetterRevision.rerender",
] as const;
async function request(
  path: string,
  options: { method?: string; json?: unknown; headers?: Record<string, string>; key?: string } = {},
) {
  return api.request(`/api/v1${path}`, {
    method: options.method ?? "GET",
    ...(options.json === undefined ? {} : { json: options.json }),
    headers: {
      ...(options.headers ??
        (path.startsWith("/admin") ? admin.headers : owner.withStore(fixture.merchant.store.id))),
      "Idempotency-Key": options.key ?? uuidv7(),
    },
    peer: `198.19.207.${++calls}`,
  });
}
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as { data: unknown }).data;
}
const detail = async () =>
  LicenseLetterDetailSchema.parse(await data(await request(`/m/license-letters/${letterId}`)));
const list = async () =>
  LicenseLetterListSchema.parse(
    await data(await request(`/admin/order-items/${fixture.order.itemId}/license-letters`)),
  );
const currentLetter = () =>
  prisma.licenseLetter.findUniqueOrThrow({
    where: { id: letterId },
    include: { revisions: { orderBy: { revNo: "desc" } } },
  });
const download = (json: unknown = {}) =>
  request(`/m/license-letters/${letterId}/download-urls`, { method: "POST", json });

beforeAll(async () => {
  api = await handle.start({
    portalPublicOrigin: "https://license-test.invalid",
    merchantKeyring: TEST_KEYRING,
    licenseTemplateCatalog: templateCatalog,
  });
  prisma = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  await seedUserAgreements(handle, api);
  clerk = await signInAsMerchant(api);
  outsider = await signInAsMerchant(api);
  admin = await signInAsStaff(prisma, { roleKey: "super_admin", now: api.clock.now() });
  limited = await signInAsStaff(prisma, {
    roleKey: "delivery_manager",
    isLead: true,
    now: api.clock.now(),
  });
  fixture = await createLicenseConvergenceFixture(prisma, {
    databaseUrl: await handle.db.url(),
    redisUrl: api.runtime.env.REDIS_URL,
    redisKeyPrefix: `${handle.redis.prefix}:license-input`,
    clock: api.clock,
  });
  await fixture.start();
  await fixture.runtime.tx.run((tx) =>
    reconcileLetters(tx, fixture.licenseDeps, [fixture.order.itemId], "test:http-licenses"),
  );
  owner = await signInAsMerchant(api, {
    phone: openSealed("merchant_user.phone_enc", fixture.merchant.user.phoneEnc!),
  });
  expect(owner.merchantUserId).toBe(fixture.merchant.user.id);
  const make = createFactories({ db: prisma, clock: api.clock });
  const clerkMember = await make.entityMember({
    entityId: fixture.merchant.entity.id,
    merchantUserId: clerk.merchantUserId,
    role: "clerk",
  });
  await make.storeMember({
    entityMemberId: clerkMember.id,
    storeId: fixture.merchant.store.id,
    addedByMemberId: fixture.merchant.owner.id,
  });
  const strangerEntity = await make.entity({
    createdByUserId: outsider.merchantUserId,
    verificationStatus: "verified",
  });
  const strangerStore = await make.store({
    entityId: strangerEntity.id,
    isPrimary: true,
    qualificationStatus: "verified",
  });
  strangerStoreId = strangerStore.id;
  await make.entityMember({
    entityId: strangerEntity.id,
    merchantUserId: outsider.merchantUserId,
    role: "owner",
    lastStoreId: strangerStore.id,
  });
  const first = await prisma.licenseLetter.findFirstOrThrow({
    where: { orderItemId: fixture.order.itemId },
    include: { revisions: true },
    orderBy: { id: "asc" },
  });
  letterId = first.id;
  firstRevisionId = first.revisions[0]!.id;
  firstSnapshot = first.revisions[0]!.letterSnapshot;
  const renderer = createLicensePdfRenderer({
    fontDir: resolve(import.meta.dirname, "../../../infra/docker/server/fonts"),
    catalog: templateCatalog,
  });
  render = createDocsRenderRuntime({
    tx: api.runtime.tx,
    clock: api.clock,
    convergence: fixture.licenseDeps,
    media: api.runtime.media,
    channel: { enqueue: async () => undefined },
    engine: { renderer, signer: api.runtime.providers.esign, close: () => renderer.close() },
    allowStamp: true,
  });
}, 120000);
afterAll(async () => {
  await render?.close();
  await fixture?.close();
});

describe.sequential("授权书八条真实Hono接口", () => {
  it("八条只各挂一次；老板同主体列表/计数/首版详情，GET零写；店员与异主体拒绝", async () => {
    for (const operationId of operations)
      expect(HANDLERS.filter((entry) => entry.route.operationId === operationId)).toHaveLength(1);
    const before = await prisma.auditLog.count();
    const page = LicenseLetterPageSchema.parse(
      await data(await request(`/m/license-letters?orderId=${fixture.order.id}&limit=1`)),
    );
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    const second = LicenseLetterPageSchema.parse(
      await data(
        await request(
          `/m/license-letters?orderId=${fixture.order.id}&limit=1&cursor=${page.nextCursor}`,
        ),
      ),
    );
    expect(second.items[0]!.licenseLetterId).not.toBe(page.items[0]!.licenseLetterId);
    expect(second.hasMore).toBe(false);
    expect(
      LicenseLetterSummarySchema.parse(
        await data(await request(`/m/license-letters/summary?orderId=${fixture.order.id}`)),
      ),
    ).toEqual({ all: 2, effective: 0 });
    expect(await detail()).toMatchObject({
      preview: null,
      currentRevNo: null,
      canDownload: false,
      isRendering: true,
      renderIssue: null,
    });
    expect((await list()).items).toHaveLength(2);
    expect(await prisma.auditLog.count()).toBe(before);
    expect(
      (
        await request(`/m/license-letters/${letterId}`, {
          headers: clerk.withStore(fixture.merchant.store.id),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/m/license-letters/${letterId}`, {
          headers: outsider.withStore(strangerStoreId),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`/admin/order-items/${fixture.order.itemId}/license-letters`, {
          headers: limited.headers,
        })
      ).status,
    ).toBe(404);
    expect((await request("/m/license-letters?includeVoided=no")).status).toBe(400);
    expect((await request("/m/license-letters?unexpected=1")).status).toBe(400);
    expect((await download()).status).toBe(409);
  });
  it("正式worker出件后预览脱敏，签发300秒私签且每次留痕；空/未ready版次不签", async () => {
    const rows = await prisma.licenseLetterRevision.findMany({
      where: { licenseLetter: { orderItemId: fixture.order.itemId } },
    });
    for (const revision of rows) await render.process({ revisionId: revision.id });
    const shown = await detail();
    expect(shown).toMatchObject({
      currentRevNo: 1,
      canDownload: true,
      isRendering: false,
      renderIssue: null,
      preview: { signMode: "stamp" },
    });
    expect(shown.preview?.clauses).toEqual(
      templateCatalog["v1"]!.clauses.map((clause) => ({
        key: clause.key,
        title: clause.title,
        text: clause.paragraphs.join("\n"),
      })),
    );
    const snapshot = firstSnapshot as {
      licensee: { creditCode: string };
      licensor: { creditCode: string };
    };
    expect(JSON.stringify(shown)).not.toContain(snapshot.licensee.creditCode);
    expect(JSON.stringify(shown)).not.toContain(snapshot.licensor.creditCode);
    const storage = api.runtime.providers.storage as FakeStorage;
    const auditBefore = await prisma.auditLog.count({
      where: { action: "docs.license_letter.download" },
    });
    const result = LicenseLetterDownloadUrlSchema.parse(await data(await download()));
    const historical = LicenseLetterDownloadUrlSchema.parse(
      await data(await download({ revNo: 1 })),
    );
    expect(result.revNo).toBe(1);
    expect(historical.revNo).toBe(1);
    expect(new Date(result.expiresAt).getTime() - api.clock.now().getTime()).toBe(300_000);
    const signedCalls = storage.callsOf("presignGet").slice(-2);
    for (const call of signedCalls)
      expect(call.input).toMatchObject({
        bucket: "secure",
        expiresSec: 300,
        disposition: "attachment",
        downloadName: result.fileName,
      });
    expect(storage.fetch(result.url)).toMatchObject({ status: 200, mime: "application/pdf" });
    expect(await prisma.auditLog.count({ where: { action: "docs.license_letter.download" } })).toBe(
      auditBefore + 2,
    );
    const access = await prisma.auditLog.findFirstOrThrow({
      where: { action: "docs.license_letter.download" },
      orderBy: { seq: "desc" },
    });
    expect(access).toMatchObject({
      stream: "access",
      category: "file_access",
      targetType: "license_letter",
      targetId: letterId,
      entityId: fixture.merchant.entity.id,
      storeId: fixture.merchant.store.id,
      meta: { revisionId: firstRevisionId, fileCategory: "legal_doc", urlTtlSec: 300 },
    });
    expect((await download({ revNo: 999 })).status).toBe(409);
    expect((await download({ revNo: 1, fileId: uuidv7() })).status).toBe(400);
    const presign = storage.presignGet;
    const changed = vi.spyOn(storage, "presignGet").mockImplementationOnce(async (input) => {
      const signed = await presign(input);
      await prisma.entityMember.update({
        where: { id: fixture.merchant.owner.id },
        data: { role: "clerk" },
      });
      return signed;
    });
    try {
      const denied = await download();
      expect(denied.status).toBe(404);
      expect(denied.headers.get("Cache-Control")).toBe("no-store");
      expect(await denied.json()).toMatchObject({ error: "NOT_FOUND" });
      expect(
        await prisma.auditLog.count({ where: { action: "docs.license_letter.download" } }),
      ).toBe(auditBefore + 2);
    } finally {
      changed.mockRestore();
      await prisma.entityMember.update({
        where: { id: fixture.merchant.owner.id },
        data: { role: "owner" },
      });
    }
    api.clock.advance(300_001);
    expect(storage.fetch(result.url)).toEqual({ status: 403 });
  }, 30000);
  it("更正共用owner快照；缺字精确诊断仅授权读可见，failed才重渲且清旧错，修正资料出新版本", async () => {
    const same = await request(`/admin/license-letters/${letterId}/correct`, {
      method: "POST",
      json: { correctionKinds: ["store_name"], note: "源资料未变" },
    });
    expect(same.status).toBe(409);
    expect(await same.json()).toMatchObject({ error: "LICENSE_LETTER_UNCHANGED" });
    expect(
      (
        await request(`/admin/license-letter-revisions/${firstRevisionId}/rerender`, {
          method: "POST",
          json: {},
        })
      ).status,
    ).toBe(409);
    await prisma.store.update({
      where: { id: fixture.merchant.store.id },
      data: { name: "修订门店\u{10FFFF}" },
    });
    const corrected = AdminLicenseLetterViewSchema.parse(
      await data(
        await request(`/admin/license-letters/${letterId}/correct`, {
          method: "POST",
          json: { correctionKinds: ["store_name"], note: "测试上游门店资料更正" },
        }),
      ),
    );
    correctedRevisionId = corrected.revisions[0]!.licenseLetterRevisionId;
    correctedSnapshot = (await currentLetter()).revisions[0]!.letterSnapshot;
    expect(corrected.revisions[0]).toMatchObject({
      revNo: 2,
      reason: "correction",
      renderStatus: "queued",
    });
    await render.process({ revisionId: correctedRevisionId });
    const blocked = await detail();
    expect(blocked).toMatchObject({
      currentRevNo: 1,
      isRendering: true,
      renderIssue: {
        kind: "missing_glyph",
        missing: [{ character: "\u{10FFFF}", codePoint: "U+10FFFF", fields: ["licensee.store"] }],
      },
    });
    expect(
      (await list()).items.find((letter) => letter.licenseLetterId === letterId)!.revisions[0],
    ).toMatchObject({ renderStatus: "failed", renderIssue: blocked.renderIssue });
    expect(
      (
        await request(`/m/license-letters/${letterId}`, {
          headers: outsider.withStore(strangerStoreId),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`/admin/license-letter-revisions/${correctedRevisionId}/rerender`, {
          method: "POST",
          json: { force: true },
        })
      ).status,
    ).toBe(400);
    const retry = LicenseLetterRevisionViewSchema.parse(
      await data(
        await request(`/admin/license-letter-revisions/${correctedRevisionId}/rerender`, {
          method: "POST",
          json: {},
        }),
      ),
    );
    expect(retry).toMatchObject({ renderStatus: "queued", renderAttemptNo: 0, renderIssue: null });
    expect((await detail()).renderIssue).toBeNull();
    expect(
      (
        await request(`/admin/license-letter-revisions/${correctedRevisionId}/rerender`, {
          method: "POST",
          json: {},
        })
      ).status,
    ).toBe(409);
    await prisma.store.update({
      where: { id: fixture.merchant.store.id },
      data: { name: "修订门店已校正" },
    });
    const fixed = AdminLicenseLetterViewSchema.parse(
      await data(
        await request(`/admin/license-letters/${letterId}/correct`, {
          method: "POST",
          json: { correctionKinds: ["store_name"], note: "修正缺字资料后重出" },
        }),
      ),
    );
    await render.process({ revisionId: fixed.revisions[0]!.licenseLetterRevisionId });
    expect(await detail()).toMatchObject({
      currentRevNo: 3,
      isRendering: false,
      renderIssue: null,
    });
    const durable = await currentLetter();
    expect(
      durable.revisions.find((revision) => revision.id === firstRevisionId)!.letterSnapshot,
    ).toEqual(firstSnapshot);
    expect(
      durable.revisions.find((revision) => revision.id === correctedRevisionId)!.letterSnapshot,
    ).toEqual(correctedSnapshot);
  }, 30000);
  it("旧版本实签、作废保留原信并按当前账号集新编号重建；后台范围复查与逐次审计", async () => {
    const history = LicenseLetterDownloadUrlSchema.parse(await data(await download({ revNo: 1 })));
    expect(history.revNo).toBe(1);
    const old = await currentLetter();
    const key = uuidv7();
    const result = LicenseLetterVoidResultSchema.parse(
      await data(
        await request(`/admin/license-letters/${letterId}/void`, {
          method: "POST",
          json: { note: "历史文件失效测试" },
          key,
        }),
      ),
    );
    expect(result.voided.status).toBe("voided");
    expect(result.reissued).not.toBeNull();
    expect(result.reissued!.letterNo).not.toBe(old.letterNo);
    expect(result.reissued!.currentRevision).toBeNull();
    const repeat = LicenseLetterVoidResultSchema.parse(
      await data(
        await request(`/admin/license-letters/${letterId}/void`, {
          method: "POST",
          json: { note: "历史文件失效测试" },
          key,
        }),
      ),
    );
    expect(repeat.reissued!.licenseLetterId).toBe(result.reissued!.licenseLetterId);
    expect((await detail()).renderIssue).toBeNull();
    expect((await download({ revNo: 1 })).status).toBe(200);
    const readyFile = old.revisions.find(
      (revision) => revision.id === old.currentRevisionId,
    )!.fileId!;
    const staffDownload = await request(`/admin/files/${readyFile}/download-urls`, {
      method: "POST",
      json: { disposition: "attachment" },
    });
    expect(staffDownload.status, await staffDownload.clone().text()).toBe(200);
    expect(staffDownload.headers.get("Cache-Control")).toBe("no-store");
    const staffSigned = (await staffDownload.json()) as { data: { expiresAt: string } };
    expect(new Date(staffSigned.data.expiresAt).getTime() - api.clock.now().getTime()).toBe(
      300_000,
    );
    expect(
      (
        await request(`/admin/files/${readyFile}/download-urls`, {
          method: "POST",
          json: {},
          headers: limited.headers,
        })
      ).status,
    ).toBe(404);
    const previousBytes = (api.runtime.providers.storage as FakeStorage).fetch(history.url);
    if (previousBytes.status !== 200) throw new Error("历史出件对象不可读");
    const orphan = await api.runtime.media.putSystemFile({
      category: "legal_doc",
      entityId: fixture.merchant.entity.id,
      storeId: null,
      objectKey: `license/orphan-${uuidv7()}.pdf`,
      fileName: "技术出件未提交.pdf",
      body: previousBytes.body,
    });
    expect(
      (await request(`/admin/files/${orphan.fileId}/download-urls`, { method: "POST", json: {} }))
        .status,
    ).toBe(404);
    // A newer clearing record supersedes the old blocked record by actual global audit seq.
    const results = await api.runtime.tx.run((tx) =>
      audit.readLicenseRenderResults(tx, {
        letterId,
        entityId: fixture.merchant.entity.id,
        storeId: fixture.merchant.store.id,
        revisionIds: [correctedRevisionId],
      }),
    );
    expect(results.get(correctedRevisionId)?.outcome).toBe("rerender");
  });
});
