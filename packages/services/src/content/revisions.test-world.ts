import {
  createClock,
  createFactories,
  assembleForTest,
  createProviderHarness,
} from "../testing/index.js";
import type { useSeededDatabase } from "../testing/index.js";
import { createTxRunner, createIdentityContext, uuidv7 } from "../kernel/index.js";
import { createEvents } from "../events/index.js";
import { createFlow } from "../flow/index.js";
import { createTimers } from "../timers/index.js";
import { createMedia } from "../media/index.js";
import {
  createContent,
  createContentLicense,
  createContentCopyright,
  DramaPricePort,
} from "./index.js";
export async function revisionsWorld(db: ReturnType<typeof useSeededDatabase>) {
  const prisma = await db.prisma(),
    clock = createClock(),
    tx = createTxRunner({ prisma, appEnv: "test" }),
    assembly = assembleForTest({ entry: "worker" });
  const events = createEvents({ tx, clock, assembly }),
    flow = createFlow({ clock, assembly, events }),
    timers = createTimers({ assembly }),
    providers = createProviderHarness({ clock }).providers;
  const media = createMedia({ tx, clock, assembly, events, storage: providers.storage }),
    license = createContentLicense({ clock, flow, timers }),
    content = createContent({ clock, flow, assembly, media, events, license });
  const copyright = createContentCopyright({
    clock,
    media,
    events,
    prices: assembly.port(DramaPricePort),
    license,
  });
  const make = createFactories({ db: prisma, clock }),
    employee = await make.staff({ staffRoleKey: "super_admin" });
  const actor = {
    identity: createIdentityContext({ actor: { type: "staff", id: employee.id, client: "admin" } }),
  };

  const proof = () =>
    make.fileObject({
      category: "drama_license_doc",
      bucket: "secure",
      ext: "pdf",
      mime: "application/pdf",
      moderationState: "none",
    });
  async function drama(status: "draft" | "listed" | "delisted" = "draft", end = "2027-12-31") {
    const d = await make.drama({
      status,
      heatTier: "A",
      createdByStaffId: employee.id,
      updatedByStaffId: employee.id,
    });
    const file = await proof();
    const snapshot = {
      source: "licensed" as const,
      platforms: ["douyin" as const, "wechat_channels" as const],
      territory: "中国大陆",
      hasNetworkRight: true,
      canSublicense: true,
      canEditEmbed: true,
      canAdapt: true,
      licenseStartDate: "2026-01-01",
      licenseEndDate: end,
      proofFileIds: [file.id],
    };
    const revisionId = status === "draft" ? null : uuidv7();
    if (revisionId)
      await prisma.dramaCopyrightRevision.create({
        data: {
          id: revisionId,
          dramaId: d.id,
          changeKind: "initial",
          copyrightSnapshot: snapshot,
          prevEndDate: null,
          newEndDate: new Date(`${end}T00:00:00Z`),
          reason: "测试合法初始授权",
          proofFileIds: [file.id],
          createdByStaffId: employee.id,
          createdAt: clock.now(),
        },
      });
    await prisma.dramaCopyright.create({
      data: {
        dramaId: d.id,
        ...snapshot,
        licenseStartDate: new Date("2026-01-01T00:00:00Z"),
        licenseEndDate: new Date(`${end}T00:00:00Z`),
        currentDramaCopyrightRevisionId: revisionId,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    await tx.run(async (t) => {
      await media.link(t, {
        fileId: file.id,
        refType: "drama_copyright",
        refId: d.id,
        role: "proof",
        entityId: null,
        storeId: null,
      });
      if (revisionId)
        await media.link(t, {
          fileId: file.id,
          refType: "drama_copyright_revision",
          refId: revisionId,
          role: "proof",
          entityId: null,
          storeId: null,
        });
    });
    return { d, snapshot, file, revisionId };
  }
  return {
    prisma,
    clock,
    tx,
    assembly,
    events,
    flow,
    timers,
    providers,
    media,
    license,
    content,
    copyright,
    make,
    actor,
    employee,
    proof,
    drama,
  };
}
export type RevisionsWorld = Awaited<ReturnType<typeof revisionsWorld>>;
