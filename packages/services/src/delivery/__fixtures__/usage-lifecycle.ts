import { z } from "@liyoxi/contract";
import {
  createContent,
  createContentCopyright,
  createContentLicense,
  DramaPricePort,
} from "../../content/index.js";
import { createTimers } from "../../timers/index.js";
import type { M5Harness } from "./m5.js";
import type { released } from "./m5.js";

export async function reviseUsage(
  h: M5Harness,
  f: Awaited<ReturnType<typeof released>>,
  end: string,
) {
  const d = f.item.dramaId,
    timers = createTimers({ assembly: h.assembly });
  const license = createContentLicense({ ...h.deps, timers });
  const content = createContent({ ...h.deps, media: h.media, license });
  const drama = await h.prisma.drama.findUniqueOrThrow({ where: { id: d } });
  if (drama.status === "listed")
    await h.tx.run((tx) =>
      content.delist(tx, f.qc.ctx, d, {
        reasonCode: "ops_strategy",
        note: "隔离用例暂停售卖后修订版权",
      }),
    );
  const old = await h.prisma.dramaCopyright.findUniqueOrThrow({ where: { dramaId: d } });
  const proof = await h.make.fileObject({
    category: "drama_license_doc",
    bucket: "secure",
    ext: "pdf",
    mime: "application/pdf",
  });
  const revision = await h.tx.run((tx) =>
    createContentCopyright({
      ...h.deps,
      media: h.media,
      prices: h.assembly.port(DramaPricePort),
      license,
    }).revise(tx, f.qc.ctx, d, {
      lockVersion: old.lockVersion,
      changeKind: "extend",
      reason: "真实续期顺延",
      confirm: { prevEndDate: old.licenseEndDate!.toISOString().slice(0, 10) },
      revisionProofFileIds: [proof.id],
      copyright: {
        source: "licensed",
        platforms: z.array(z.enum(["douyin", "wechat_channels"])).parse(old.platforms),
        territory: old.territory!,
        hasNetworkRight: true,
        canSublicense: true,
        canEditEmbed: true,
        canAdapt: true,
        licenseStartDate: "2020-01-01",
        licenseEndDate: end,
        proofFileIds: [proof.id],
      },
    }),
  );
  const event = await h.prisma.outboxEvent.findFirstOrThrow({
    where: { eventType: "drama.license_extended", aggregateId: d },
    orderBy: { createdAt: "desc" },
  });
  return { revision, event };
}
