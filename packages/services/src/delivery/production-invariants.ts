import type { InvariantViolation, Tx } from "../kernel/index.js";
export async function productionViolations(tx: Tx, code: string): Promise<InvariantViolation[]> {
  const out: InvariantViolation[] = [],
    bad = (type: string, id: string, entityId: string, detail: Record<string, unknown>) =>
      out.push({ subject: { type, id }, entityId, detail });
  if (code === "I4") {
    const tickets = new Map((await tx.deliveryTicket.findMany()).map((t) => [t.id, t]));
    const children = [
      ...(await tx.sample.findMany()).map((r) => ({ ...r, type: "sample" })),
      ...(await tx.episodeOutput.findMany()).map((r) => ({ ...r, type: "episode_output" })),
      ...(await tx.qcRecord.findMany()).map((r) => ({ ...r, type: "qc_record" })),
      ...(await tx.deliveryRelease.findMany()).map((r) => ({ ...r, type: "delivery_release" })),
      ...(await tx.publishList.findMany()).map((r) => ({ ...r, type: "publish_list" })),
      ...(await tx.deliveryReissue.findMany()).map((r) => ({ ...r, type: "delivery_reissue" })),
    ];
    for (const r of children) {
      const t = tickets.get(r.deliveryTicketId);
      if (!t || r.entityId !== t.entityId || r.storeId !== t.storeId)
        bad(r.type, r.id, r.entityId, { parentMismatch: true });
    }
    const releases = new Map((await tx.deliveryRelease.findMany()).map((r) => [r.id, r]));
    for (const r of [
      ...(await tx.downloadGrant.findMany()).map((r) => ({ ...r, type: "download_grant" })),
      ...(await tx.deliveryDownloadLog.findMany()).map((r) => ({
        ...r,
        type: "delivery_download_log",
      })),
    ]) {
      const p = releases.get(r.deliveryReleaseId);
      if (
        !p ||
        p.entityId !== r.entityId ||
        p.storeId !== r.storeId ||
        p.orderItemId !== r.orderItemId
      )
        bad(r.type, r.id, r.entityId, { parentMismatch: true });
    }
  }
  if (code === "I7")
    for (const t of await tx.deliveryTicket.findMany({
      where: { step: "sample_confirm" },
      include: { samples: true },
    }))
      if (
        t.samples.filter((s) => s.status === "pushed" && s.versionNo === t.currentSampleVersionNo)
          .length !== 1
      )
        bad("delivery_ticket", t.id, t.entityId, { currentVersionNo: t.currentSampleVersionNo });
  if (code === "I8")
    for (const e of await tx.episodeOutput.findMany({
      where: { status: "qc_passed", isCurrent: false },
      include: { deliveryReissue: true },
    }))
      if (!e.deliveryReissue || e.deliveryReissue.status !== "open")
        bad("episode_output", e.id, e.entityId, { notCurrentWithoutOpenReissue: true });
  if (code === "I9")
    for (const q of await tx.qcRecord.findMany()) {
      const tpl = await tx.checklistTemplate.findUnique({
        where: { code_versionNo: { code: q.checklistCode, versionNo: q.checklistVersionNo } },
      });
      const target =
        q.targetType === "sample"
          ? await tx.sample.findUnique({ where: { id: q.targetId } })
          : q.targetType === "episode_output"
            ? await tx.episodeOutput.findUnique({ where: { id: q.targetId } })
            : await tx.deliveryTicket.findUnique({ where: { id: q.targetId } });
      const targetTicket =
        target && ("deliveryTicketId" in target ? target.deliveryTicketId : target.id);
      if (
        !tpl ||
        tpl.status === "draft" ||
        targetTicket !== q.deliveryTicketId ||
        q.checklistCode !==
          (
            {
              sample: "qc.sample",
              episode_output: "qc.episode",
              delivery_ticket: "qc.package",
            } as Record<string, string>
          )[q.targetType]
      )
        bad("qc_record", q.id, q.entityId, { invalidTemplateOrTarget: true });
    }
  if (["I10", "I11", "I12", "I13"].includes(code)) {
    const releases = await tx.deliveryRelease.findMany({ include: { orderItem: true } }),
      keys = new Map<string, number>();
    for (const r of releases.filter((r) => r.state === "pushed")) {
      const key = `${r.orderItemId}:${r.variant}`;
      keys.set(key, (keys.get(key) ?? 0) + 1);
    }
    for (const r of releases) {
      if (
        code === "I10" &&
        r.state === "pushed" &&
        (keys.get(`${r.orderItemId}:${r.variant}`) ?? 0) > 1
      )
        bad("delivery_release", r.id, r.entityId, { duplicatePushed: true });
      const manifest = Array.isArray(r.manifestSnapshot)
        ? (r.manifestSnapshot as Array<{ episodeNo?: number; outputId?: string; fileId?: string }>)
        : [];
      if (code === "I11" && r.state === "pushed") {
        const n = r.orderItem.episodeCount;
        if (
          manifest.length !== n ||
          new Set(manifest.map((m) => m.episodeNo)).size !== n ||
          manifest.some((m) => !m.episodeNo || m.episodeNo < 1 || m.episodeNo > n)
        )
          bad("delivery_release", r.id, r.entityId, { invalidEpisodeCount: true });
        for (const m of manifest) {
          const f = m.fileId ? await tx.fileObject.findUnique({ where: { id: m.fileId } }) : null,
            ref = m.fileId
              ? await tx.fileRef.findUnique({
                  where: {
                    fileId_refType_refId_role: {
                      fileId: m.fileId,
                      refType: "delivery_release",
                      refId: r.id,
                      role: "ep",
                    },
                  },
                })
              : null;
          if (
            f?.status !== "stored" ||
            f.entityId !== r.entityId ||
            f.storeId !== r.storeId ||
            ref?.state !== "live"
          )
            bad("delivery_release", r.id, r.entityId, {
              fileId: m.fileId ?? null,
              invalidLiveFile: true,
            });
        }
      }
      if (code === "I12")
        for (const m of manifest) {
          const f = m.fileId ? await tx.fileObject.findUnique({ where: { id: m.fileId } }) : null,
            p = m.fileId
              ? await tx.productionRecord.findUnique({ where: { fileId: m.fileId } })
              : null;
          if (
            !f?.sizeBytes ||
            f.sizeBytes > 200n * 1024n * 1024n ||
            !p ||
            !["not_required", "verified"].includes(p.aigcState)
          )
            bad("delivery_release", r.id, r.entityId, {
              fileId: m.fileId ?? null,
              invalidSizeOrAigc: true,
            });
        }
      if (code === "I13") {
        const tpl = await tx.checklistTemplate.findUnique({
          where: { code_versionNo: { code: r.checklistCode, versionNo: r.checklistVersionNo } },
        });
        if (!tpl || tpl.status === "draft")
          bad("delivery_release", r.id, r.entityId, { invalidTemplate: true });
        for (const m of manifest) {
          const e = m.outputId
            ? await tx.episodeOutput.findUnique({ where: { id: m.outputId } })
            : null;
          if (
            e?.deliveryTicketId !== r.deliveryTicketId ||
            e.fileId !== m.fileId ||
            e.episodeNo !== m.episodeNo
          )
            bad("delivery_release", r.id, r.entityId, {
              outputId: m.outputId ?? null,
              invalidManifestOutput: true,
            });
        }
      }
    }
  }
  if (code === "I15") {
    const rows = await tx.downloadGrant.findMany({
        where: { state: "active" },
        include: { deliveryRelease: true },
      }),
      keys = new Map<string, number>();
    for (const r of rows) {
      const key = `${r.deliveryReleaseId}:${r.granteeType}:${r.granteeId}`;
      keys.set(key, (keys.get(key) ?? 0) + 1);
    }
    for (const r of rows)
      if (
        r.deliveryRelease.state !== "pushed" ||
        (keys.get(`${r.deliveryReleaseId}:${r.granteeType}:${r.granteeId}`) ?? 0) > 1
      )
        bad("download_grant", r.id, r.entityId, { invalidActiveGrant: true });
  }
  return out;
}
