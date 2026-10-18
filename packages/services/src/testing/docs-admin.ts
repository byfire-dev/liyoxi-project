// Fictional stored inputs for actual docs/media/Storage composition; never legal approval.
import { createHash } from "node:crypto";
import type { PrismaClient } from "@liyoxi/db";
import type { StaffRoleKey } from "@liyoxi/contract/authz";
import { createConfig } from "../config/index.js";
import { createEvents } from "../events/index.js";
import { createIdentityContext, createTxRunner, uuidv7 } from "../kernel/index.js";
import type { DocumentConverter } from "../kernel/index.js";
import type { StorageProvider } from "../providers/types.js";
import type { AdjustableClock } from "./clock.js";
import { createMedia } from "../media/index.js";
import { createDocsAssembly, createRuntimeDocs } from "../ops/index.js";
import type { AgreementActor } from "../docs/index.js";
import { assembleForTest } from "./assembly.js";
import { sampleStaffContext } from "./approval.js";
import { createClock } from "./clock.js";
import { createFactories } from "./data/index.js";
import { docx, pdf } from "./document-fixtures.js";
import { createFakeProviders } from "./providers/index.js";

export function createDocsAdminFixture(
  prisma: PrismaClient,
  converter: DocumentConverter | null = null,
  options: { clock?: AdjustableClock; storage?: StorageProvider } = {},
) {
  const clock = options.clock ?? createClock(new Date("2026-10-09T04:00:00.000Z"));
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const make = createFactories({ db: prisma, clock });
  const providers = createFakeProviders({ clock });
  const storage = options.storage ?? providers.storage;
  const scope = createDocsAssembly(assembleForTest({ entry: "api" }));
  const assembly = scope.assembly;
  const config = createConfig({ db: prisma, clock, redis: null });
  const events = createEvents({ tx, clock, assembly });
  const media = createMedia({ tx, clock, assembly, events, storage });
  const cacheBumps: string[] = [];
  const services = createRuntimeDocs({
    tx,
    clock,
    assembly,
    config,
    events,
    media,
    storage,
    converter,
    bumpAgreement: async () => {
      cacheBumps.push("agreement");
    },
  });
  scope.attach(services.jobs);
  async function actor(
    role: StaffRoleKey = "super_admin",
    stepUpAt: Date | null = clock.now(),
  ): Promise<AgreementActor> {
    const staff = await make.staff({ staffRoleKey: role });
    const requestId = uuidv7();
    return {
      staff: await sampleStaffContext(prisma, staff.id, { stepUpAt }),
      identity: createIdentityContext({
        actor: { type: "staff", id: staff.id, client: "admin" },
        requestId,
      }),
      meta: { requestId, ip: null, userAgent: null, sessionId: null, authMethod: "password+totp" },
    };
  }
  async function file(
    actor: AgreementActor,
    ext: "docx" | "pdf",
    bytes = ext === "docx" ? docx() : pdf(),
  ) {
    const id = uuidv7(),
      objectKey = `legal-docs/fictional/${id}.${ext}`;
    const mime =
      ext === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/pdf";
    const uploaded = await storage.putObject({
      bucket: "secure",
      key: objectKey,
      body: bytes,
      contentType: mime,
    });
    if (!uploaded.ok) throw new TypeError("虚构协议输入写入失败");
    const etag = uploaded.value.etag;
    return make.fileObject({
      id,
      objectKey,
      bucket: "secure",
      category: "legal_doc",
      ext,
      mime,
      declaredMime: mime,
      originalName: `虚构协议.${ext}`,
      declaredSize: bytes.byteLength,
      sizeBytes: bytes.byteLength,
      etag,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      uploadActorType: "staff",
      uploadActorId: actor.staff.staff.id,
      uploadClient: "admin",
    });
  }
  // Domain lifecycle fixtures explicitly arrange already-converted draft facts. They do not
  // prove conversion or media ingestion; the separate real converter test does that.
  async function draft(
    actor: AgreementActor,
    key: string,
    effectiveAt = new Date(clock.now().getTime() + 86400000 * 31),
  ) {
    const source = await file(actor, "docx"),
      document = await file(actor, "pdf");
    const contentHtml = "<p>虚构协议：仅供自动化测试</p>";
    const version = await make.agreementVersion({
      agreementKey: key,
      status: "draft",
      createdByStaffId: actor.staff.staff.id,
      sourceFileId: source.id,
      pdfFileId: document.id,
      contentSha256: document.sha256,
      contentHtml,
      htmlSha256: createHash("sha256").update(contentHtml).digest("hex"),
      summary: "虚构测试变更",
      effectiveAt,
      isLegalApproved: true,
    });
    await tx.run(async (t) => {
      await media.link(t, {
        fileId: source.id,
        refType: "agreement_version",
        refId: version.id,
        role: "source",
        entityId: null,
        storeId: null,
      });
      await media.link(t, {
        fileId: document.id,
        refType: "agreement_version",
        refId: version.id,
        role: "pdf",
        entityId: null,
        storeId: null,
      });
    });
    return { version, source, pdf: document };
  }
  return {
    prisma,
    tx,
    clock,
    make,
    providers,
    scope,
    assembly,
    media,
    config,
    events,
    cacheBumps,
    ...services,
    actor,
    file,
    draft,
    close: async () => {
      await scope.close();
      await media.jobs.shutdown();
    },
  };
}
