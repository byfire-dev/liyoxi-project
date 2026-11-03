// Cross-domain composition only: production/QC/ZIP, order derivation, login and portal exchange are real.
import type { PrismaClient } from "@liyoxi/db";
import { createConfig } from "../config/index.js";
import { createDocs } from "../docs/index.js";
import { createIdentity, assertPortalPrincipal } from "../identity/index.js";
import type { PortalOwnerRequest } from "../identity/index.js";
import { createDeliveryDownloads, createPortalDeliveryDownloads } from "../delivery/index.js";
import { createTenant } from "../tenant/index.js";
import { uuidv7 } from "../kernel/index.js";
import { TEST_KEYRING, openSealed } from "./data/seal.js";
import { createPortalTestStack, createPortalTestSession } from "./portal-auth.fixture.js";
import { createZipPackageFixture } from "./zip-package-fixture.js";
import { bindUsageLifecycleOrderForTest } from "./usage-lifecycle.fixture.js";
import { checks, m5Service, productionFile } from "./delivery-release.fixture.js";

export const PORTAL_DOWNLOAD_TEST_APPID = "wxlyxtest00000001";
export const PORTAL_DOWNLOAD_TEST_ORIGIN = "https://portal.example.invalid";
export function createPortalDownloadFixture(
  prisma: PrismaClient,
  options: { appid?: string } = {},
) {
  const appid = options.appid ?? PORTAL_DOWNLOAD_TEST_APPID;
  const h = createZipPackageFixture(prisma),
    unbind = bindUsageLifecycleOrderForTest(h);
  const docs = createDocs({ tx: h.tx, clock: h.clock });
  const identity = createIdentity({
    ...h.deps,
    docs,
    tenant: createTenant(h),
    config: createConfig({ db: prisma, clock: h.clock, redis: null }),
    keyring: () => TEST_KEYRING,
    wechat: h.fake.wechat,
    appid,
  });
  const portalStack = createPortalTestStack({
    ...h,
    appid,
    origin: PORTAL_DOWNLOAD_TEST_ORIGIN,
    ticketTtlSeconds: 120,
  });
  const portalDeps = { ...h, media: h.zipMedia, assertPortalPrincipal };
  const downloads = createDeliveryDownloads({ ...h.deps, media: h.zipMedia });
  return {
    ...h,
    identity,
    docs,
    portalStack,
    portalDeps,
    downloads,
    portalDownloads: createPortalDeliveryDownloads(portalDeps),
    reissueSteps(f: Awaited<ReturnType<ReturnType<typeof h.releaseSteps>["push"]>>) {
      const service = m5Service(h);
      let reissueId: string, fileId: string;
      return {
        async create() {
          const code = "portal_fix";
          await prisma.dictItem.upsert({
            where: { dictTypeKey_code: { dictTypeKey: "reissue_reason", code } },
            create: {
              id: uuidv7(),
              dictTypeKey: "reissue_reason",
              code,
              name: "测试内容修正",
              isEnabled: true,
              position: 1,
              createdAt: h.clock.now(),
              updatedAt: h.clock.now(),
            },
            update: {},
          });
          reissueId = (
            await service.reissueCreate(f.qc.ctx, f.qc.staff, f.id, {
              episodeNos: [1],
              reasonCode: code,
              note: "本轮下载版本竞争验收",
            })
          ).reissueId;
        },
        async file() {
          fileId = await productionFile(h, f.o, f.editor, "final_episode", 1);
        },
        async inspect() {
          const outputs = await h.delivery.episodeRegister(f.editor.ctx, f.editor.staff, f.id, {
            reissueId,
            items: [{ episodeNo: 1, fileId }],
          });
          const q = await checks(h, "qc.episode");
          await h.delivery.episodeInspect(f.qc.ctx, f.qc.staff, f.id, {
            episodeOutputIds: outputs.items.map((item) => item.episodeOutputId),
            checklistVersionNo: q.checklistVersionNo,
            defaultResults: q.results,
          });
        },
        async publish() {
          return service.reissuePublish(f.qc.ctx, f.qc.staff, reissueId, {
            precheck: await checks(h, "delivery.precheck"),
          });
        },
      };
    },
    async authorize(o: Awaited<ReturnType<typeof h.order>>) {
      const meta = {
        requestId: uuidv7(),
        ip: "198.19.116.6",
        userAgent: "LYX fictional portal download",
        clientVersion: "1.4.0",
      };
      const user = await prisma.merchantUser.findUniqueOrThrow({ where: { id: o.user.id } });
      if (!user.phoneEnc) throw new Error("prepared owner has no test phone");
      const code = uuidv7();
      h.fake.wechat.sessions.set(code, { openid: `portal-download-${user.id}` });
      h.fake.wechat.phones.set(code, openSealed("merchant_user.phone_enc", user.phoneEnc));
      const consents = [];
      for (const agreementKey of ["user", "privacy"]) {
        const version =
          (await prisma.agreementVersion.findFirst({
            where: { agreementKey, status: "active" },
          })) ?? (await h.make.agreementVersion({ agreementKey }));
        consents.push({ agreementKey, agreementVersionId: version.id });
      }
      const login = await identity.phoneLogin(meta, { loginCode: code, phoneCode: code, consents });
      const checked = await identity.authenticate(login.token, { ip: meta.ip });
      if (!checked.ok || checked.principal.merchantUserId !== user.id)
        throw new Error("real prepared-owner login failed");
      const owner: PortalOwnerRequest = { ctx: o.viewer.ctx, principal: checked.principal };
      const world = await createPortalTestSession(portalStack, owner, meta);
      return {
        ...world,
        owner,
        principal: await world.sessions.authenticate(world.token),
        merchantToken: login.token,
        meta,
      };
    },
    async finishZip(releaseId: string) {
      const input = await h.input(releaseId),
        status = await h.tx.run((tx) => h.zipMedia.ensureZip(tx, input));
      if (!status.zipBundleId) throw new Error("release ZIP missing");
      const job = await prisma.mediaJob.findFirstOrThrow({
        where: { parentId: status.zipBundleId, kind: "zip_package" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      await h.zipMedia.jobs.run({ jobId: job.id });
      const submitted = await prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
      if (submitted.state !== "submitted")
        throw new Error(`ZIP not submitted: ${submitted.errorCode ?? submitted.state}`);
      h.clock.set(submitted.nextRunAt);
      await h.zipMedia.jobs.run({ jobId: job.id });
      const ready = await h.tx.run((tx) => h.zipMedia.ensureZip(tx, input, { peek: true }));
      if (ready.zipState !== "ready") throw new Error("real ZIP verification failed");
      return ready;
    },
    async close() {
      unbind();
      await h.close();
    },
  };
}
