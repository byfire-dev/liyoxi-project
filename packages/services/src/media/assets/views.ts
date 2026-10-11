import {
  AdminStoreAssetDetailSchema,
  AdminStoreAssetRowSchema,
  StoreAssetCardSchema,
  StoreAssetDetailSchema,
} from "@liyoxi/contract";
import type { StoreAsset, StoreAssetInsight, StoreAssetTag } from "@liyoxi/db";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import type { MediaActor, ReadSignInput } from "../context.js";
import { assetDisplayStatus, assetSelectable } from "./steps.js";
import { assetFiles, assetOf } from "./repo.js";
import type { AssetDeps } from "./context.js";
import { documentFacts } from "./doc.js";

export const objectContent = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const textOf = (value: unknown) => (typeof value === "string" ? value : null);
const integerOf = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const dateOf = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
export function latestInsights(insights: readonly StoreAssetInsight[]) {
  const rows = new Map<string, StoreAssetInsight>();
  for (const row of [...insights].sort(
    (a, b) => b.promptVersion - a.promptVersion || b.updatedAt.getTime() - a.updatedAt.getTime(),
  )) {
    const key = `${row.fileId ?? "asset"}:${row.kind}`;
    if (row.status === "ok" && !rows.has(key)) rows.set(key, row);
  }
  return [...rows.values()];
}
export function visibleAssetTags(tags: readonly StoreAssetTag[], dimension: string) {
  const rows = tags.filter((row) => row.dimension === dimension);
  const confirmed = rows.filter((row) => row.source === "reviewer" && row.isConfirmed);
  return confirmed.length
    ? confirmed
    : [...rows].sort(
        (a, b) =>
          Number(b.source === "uploader") - Number(a.source === "uploader") ||
          a.id.localeCompare(b.id),
      );
}
function transcript(content: Record<string, unknown> | undefined) {
  if (!content || typeof content.text !== "string") return null;
  const segments = Array.isArray(content.segments)
    ? content.segments.flatMap((value) => {
        const row = objectContent(value),
          fromMs = integerOf(row.fromMs),
          toMs = integerOf(row.toMs);
        return fromMs !== null && toMs !== null && fromMs <= toMs && typeof row.text === "string"
          ? [{ fromMs, toMs, text: row.text }]
          : [];
      })
    : [];
  return { text: content.text, segments };
}

/** Unsigned data only: safe for the existing idempotency transaction/cache. */
export async function assetView(
  tx: Tx,
  deps: AssetDeps,
  actor: MediaActor,
  asset: StoreAsset,
  detail: boolean,
) {
  const links = await assetFiles(tx, asset.id);
  const insights = latestInsights(
    await tx.storeAssetInsight.findMany({ where: { storeAssetId: asset.id } }),
  );
  const tags = await tx.storeAssetTag.findMany({
    where: { storeAssetId: asset.id },
    orderBy: { id: "asc" },
  });
  const dictionary = await tx.dictItem.findMany({ where: { dictTypeKey: "asset_tag" } });
  const dictRef = (code: string) => ({
    code,
    name: dictionary.find((row) => row.code === code)?.name ?? code,
  });
  const tagView = (row: StoreAssetTag) => ({
    dimension: row.dimension,
    tag: dictRef(row.tagCode),
    source: row.source,
    isConfirmed: row.isConfirmed,
    validStartDate: dateOf(row.validStartDate),
    validEndDate: dateOf(row.validEndDate),
  });
  const byDimension = Object.fromEntries(
    ["content", "usage", "timeliness"].map((dimension) => [
      dimension,
      visibleAssetTags(tags, dimension).map(tagView),
    ]),
  );
  const fileInsights = (kind: string) =>
    links.flatMap((link) =>
      insights.filter((row) => row.fileId === link.fileId && row.kind === kind),
    );
  const content = (row?: StoreAssetInsight) => (row ? objectContent(row.content) : {});
  const digestRow = insights.find((row) => row.fileId === null && row.kind === "digest"),
    digest = content(digestRow);
  const transcriptions = fileInsights("transcript").flatMap((row) => {
    const value = transcript(content(row));
    return value && row.fileId ? [{ ...value, fileId: row.fileId }] : [];
  });
  const structuredItems = fileInsights("structured_items").flatMap((row) => {
    const items = content(row).items;
    return Array.isArray(items)
      ? items.flatMap((item) => {
          const value = objectContent(item);
          return typeof value.name === "string"
            ? [{ name: value.name, priceText: textOf(value.price) }]
            : [];
        })
      : [];
  });
  const pageCounts = fileInsights("doc_text")
    .map((row) => {
      const ext = links.find((link) => link.fileId === row.fileId)?.file.ext;
      return ext === "pdf" ? (documentFacts(row.content, ext)?.pageCount ?? null) : null;
    })
    .filter((value) => value !== null);
  const firstMedia = links.find((row) => /^(audio|video)\//.test(row.file.mime ?? ""));
  const uploaded = await deps.assets.readUploader(tx, {
    entityId: asset.entityId,
    actorType: asset.uploadActorType,
    actorId: asset.uploadActorId,
  });
  const reviewed = asset.reviewedByStaffId
    ? await deps.assets.readUploader(tx, {
        entityId: asset.entityId,
        actorType: "staff",
        actorId: asset.reviewedByStaffId,
      })
    : null;
  const uploader = {
    actorType: asset.uploadActorType,
    role: asset.uploadActorRole,
    displayName: uploaded.displayName,
    isMe:
      actor.identity.actor.type === "merchant" &&
      asset.uploadActorType === "merchant" &&
      asset.uploadActorId === actor.identity.actor.id,
  };
  const files = links.map(({ file }) => ({
    fileId: file.id,
    kind: file.mime?.startsWith("image/")
      ? "image"
      : file.mime?.startsWith("video/")
        ? "video"
        : file.mime?.startsWith("audio/")
          ? "audio"
          : "document",
    url: null,
    expiresAt: null,
    coverUrl: null,
    durationMs: file.mediaInfo?.durationMs ?? null,
    displayWidth: file.mediaInfo?.displayWidth ?? null,
    displayHeight: file.mediaInfo?.displayHeight ?? null,
    moderationState: file.moderationState,
  }));
  const card = {
    storeAssetId: asset.id,
    type: asset.type,
    title: asset.title,
    displayStatus: assetDisplayStatus(
      asset.processingState,
      asset.reviewState,
      asset.usability,
      asset.adoptedCount,
    ),
    processingState: asset.processingState,
    reviewState: asset.reviewState,
    usability: asset.usability,
    adoptedCount: asset.adoptedCount,
    moderationState: asset.moderationState,
    fileCount: links.length,
    durationMs: firstMedia?.file.mediaInfo?.durationMs ?? null,
    pageCount: pageCounts.length ? pageCounts.reduce((a, b) => a + b, 0) : null,
    thumbnail: null,
    quote: (asset.textBody ?? transcriptions[0]?.text)?.slice(0, 60) ?? null,
    tags: (byDimension.content ?? [])
      .filter(
        (row, index, all) => all.findIndex((other) => other.tag.code === row.tag.code) === index,
      )
      .slice(0, 4),
    techSpecLabel: textOf(content(fileInsights("tech_spec")[0]).label),
    structuredItemCount: fileInsights("structured_items").length ? structuredItems.length : null,
    isSelectableAsReference: assetSelectable(asset),
    uploader,
    createdAt: asset.createdAt.toISOString(),
  };
  const usages = await tx.storeAssetUsage.findMany({
    where: { storeAssetId: asset.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const usageViews = [];
  for (const row of usages) {
    const usedBy = await deps.assets.readUsage(tx, {
      usedByType: row.usedByType,
      usedById: row.usedById,
      entityId: asset.entityId,
      storeId: asset.storeId,
    });
    usageViews.push({ row, usedBy });
  }
  const portraitAuth = {
    fileCount: asset.portraitAuthFileIds.length,
    authorizedAt: asset.portraitAuthorizedAt?.toISOString() ?? null,
  };
  if (actor.staff) {
    const store = await deps.assets.readStore(tx, asset.storeId, actor.staff.scope);
    const allowed = (permission: string) =>
      actor.staff!.permissions.has(permission as Parameters<typeof actor.staff.permissions.has>[0]);
    const row = AdminStoreAssetRowSchema.parse({
      ...Object.fromEntries(
        Object.entries(card).filter(
          ([key]) =>
            ![
              "displayStatus",
              "reviewState",
              "quote",
              "tags",
              "techSpecLabel",
              "structuredItemCount",
              "isSelectableAsReference",
            ].includes(key),
        ),
      ),
      storeId: asset.storeId,
      storeName: store?.name ?? null,
      charCount: asset.textBody?.length ?? null,
      uploader: {
        actorType: asset.uploadActorType,
        role: asset.uploadActorRole,
        displayName: uploaded.displayName,
        merchantUserId: asset.uploadActorType === "merchant" ? asset.uploadActorId : null,
        staffId: asset.uploadActorType === "staff" ? asset.uploadActorId : null,
      },
      contentTags: byDimension.content,
      usageTags: byDimension.usage,
      timelinessTag: byDimension.timeliness?.[0] ?? null,
      hasUnconfirmedAutoTags:
        asset.reviewState === "unreviewed" &&
        tags.some(
          (tag) => tag.source === "auto" && !tag.isConfirmed && tag.dimension === "content",
        ),
      adminStatus:
        asset.reviewState === "unreviewed"
          ? "organizing"
          : asset.adoptedCount > 0
            ? "adopted"
            : "organized",
      isInsightPartial: asset.isInsightPartial,
      portraitAuth,
      reviewDueAt: asset.dueAt?.toISOString() ?? null,
      isReviewOverdue:
        asset.reviewState === "unreviewed" && !!asset.dueAt && asset.dueAt < deps.clock.now(),
      assetDemandId: asset.storeAssetDemandId,
      sourceStoreAssetId: asset.sourceStoreAssetId,
      actions: [
        ...(allowed("merchant.asset.review")
          ? [
              "review",
              "delete",
              ...(asset.processingState === "processed" && asset.moderationState !== "block"
                ? ["reprocess"]
                : []),
              ...(asset.usability === "need_portrait_auth" && asset.portraitAuthFileIds.length
                ? ["confirm-portrait-auth"]
                : []),
            ]
          : []),
        ...(allowed("merchant.asset.upload_on_behalf") && asset.usability === "need_portrait_auth"
          ? ["portrait-auth"]
          : []),
      ],
    });
    if (!detail) return row;
    const timeliness = objectContent(digest.suggestedTimeliness);
    return AdminStoreAssetDetailSchema.parse({
      ...row,
      textBody: asset.textBody,
      note: asset.note,
      files,
      transcript: transcriptions[0]
        ? { text: transcriptions[0].text, segments: transcriptions[0].segments }
        : null,
      keypoints: strings(digest.keypoints),
      structuredItems,
      techSpecLabel: card.techSpecLabel,
      suggestion: digestRow
        ? {
            contentTags: strings(digest.contentTags).map(dictRef),
            usageTags: strings(digest.suggestedUsage).map(dictRef),
            timeliness:
              typeof timeliness.code === "string"
                ? {
                    tag: dictRef(timeliness.code),
                    validStartDate: textOf(timeliness.from),
                    validEndDate: textOf(timeliness.to),
                  }
                : null,
            faceHint: ["none", "people_unclear", "identifiable_customer"].includes(
              String(digest.faceHint),
            )
              ? digest.faceHint
              : "none",
            qualityNotes: strings(digest.qualityNotes),
            description: textOf(content(fileInsights("vision")[0]).description),
          }
        : null,
      insightSteps: (
        await tx.storeAssetInsight.findMany({
          where: { storeAssetId: asset.id },
          orderBy: [{ promptVersion: "desc" }, { id: "asc" }],
        })
      ).map((row) => ({ kind: row.kind, status: row.status })),
      portraitAuthFileIds: asset.portraitAuthFileIds,
      reviewedBy: reviewed?.staff ?? null,
      reviewedAt: asset.reviewedAt?.toISOString() ?? null,
      usages: usageViews.map(({ row, usedBy }) => ({
        usedByType: row.usedByType,
        usedById: row.usedById,
        usedByNo: (() => {
          if (!usedBy) throw new AppError("PROVIDER_UNAVAILABLE");
          return usedBy.no;
        })(),
        role: row.role,
        at: row.createdAt.toISOString(),
      })),
      lockVersion: asset.lockVersion,
    });
  }
  if (!detail) return StoreAssetCardSchema.parse(card);
  const demand = asset.storeAssetDemandId
    ? await tx.storeAssetDemand.findUnique({ where: { id: asset.storeAssetDemandId } })
    : null;
  const timeline = [
    {
      kind: "uploaded",
      at: asset.createdAt.toISOString(),
      actorName: uploaded.displayName,
      usedBy: null,
    },
    ...(digestRow
      ? [
          {
            kind: "processed",
            at: digestRow.createdAt.toISOString(),
            actorName: null,
            usedBy: null,
          },
        ]
      : []),
    ...(asset.reviewedAt
      ? [
          {
            kind: "reviewed",
            at: asset.reviewedAt.toISOString(),
            actorName: reviewed?.displayName ?? null,
            usedBy: null,
          },
        ]
      : []),
    ...usageViews.map(({ row, usedBy }) => ({
      kind: row.role === "reference" ? "used_as_reference" : "adopted",
      at: row.createdAt.toISOString(),
      actorName: null,
      usedBy,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return StoreAssetDetailSchema.parse({
    ...card,
    textBody: asset.textBody,
    note: asset.note,
    files,
    transcript: transcriptions[0]
      ? { text: transcriptions[0].text, segments: transcriptions[0].segments }
      : null,
    fileTranscripts: transcriptions,
    highlights: strings(digest.keypoints),
    structuredItems,
    isInsightPartial: asset.isInsightPartial,
    tagsByDimension: byDimension,
    reviewedBy: reviewed?.displayName ? { displayName: reviewed.displayName } : null,
    reviewedAt: asset.reviewedAt?.toISOString() ?? null,
    portraitAuth,
    assetDemand: demand ? { assetDemandId: demand.id, title: demand.title } : null,
    timeline,
    actions: [
      "feedback",
      ...(asset.usability === "need_portrait_auth" &&
      (actor.identity.actor.role === "owner" || uploader.isMe)
        ? ["portrait-auth"]
        : []),
    ],
  });
}

/** C18/C50: authorize/read, sign outside TX, then recheck the current resource. */
export async function attachAssetUrls<T extends { storeAssetId: string; thumbnail: unknown }>(
  deps: AssetDeps,
  actor: MediaActor,
  raw: T,
  signRead: (input: ReadSignInput) => Promise<{ url: string; expiresAt: string }>,
  replayed = false,
): Promise<T> {
  if (replayed) return raw;
  const snapshot = await deps.tx.run(async (tx) => {
    const asset = await assetOf(tx, actor, raw.storeAssetId);
    return { asset, links: await assetFiles(tx, asset.id) };
  });
  if (snapshot.asset.moderationState === "block") return raw;
  const signed = new Map<string, { url: string; expiresAt: string }>();
  const sign = async (fileId: string) => {
    const cached = signed.get(fileId);
    if (cached) return cached;
    const value = await signRead({ fileId, audience: actor.staff ? "staff" : "merchant" });
    signed.set(fileId, value);
    return value;
  };
  const first = snapshot.links[0]?.file;
  const thumbnailId = first?.mime?.startsWith("image/") ? first.id : first?.mediaInfo?.coverFileId;
  const thumbnail = thumbnailId ? await sign(thumbnailId) : null;
  const source = raw as T & {
    files?: readonly {
      fileId: string;
      url: string | null;
      expiresAt: string | null;
      coverUrl: string | null;
    }[];
  };
  const files = source.files
    ? await Promise.all(
        source.files.map(async (view) => {
          const file = snapshot.links.find((row) => row.fileId === view.fileId)?.file;
          if (!file || file.status !== "stored" || file.moderationState === "block") return view;
          const value = await sign(file.id);
          const cover = file.mediaInfo?.coverFileId ? await sign(file.mediaInfo.coverFileId) : null;
          return {
            ...view,
            url: value.url,
            expiresAt: value.expiresAt,
            coverUrl: cover?.url ?? null,
          };
        }),
      )
    : undefined;
  await deps.tx.run(async (tx) => {
    const current = await assetOf(tx, actor, raw.storeAssetId);
    const links = await assetFiles(tx, current.id);
    if (
      current.lockVersion !== snapshot.asset.lockVersion ||
      current.moderationState === "block" ||
      links.length !== snapshot.links.length ||
      links.some((row, index) => {
        const previous = snapshot.links[index]?.file;
        return (
          !previous ||
          row.fileId !== previous.id ||
          row.file.status !== "stored" ||
          row.file.moderationState === "block" ||
          row.file.etag !== previous.etag ||
          row.file.mediaInfo?.coverFileId !== previous.mediaInfo?.coverFileId
        );
      })
    )
      throw new AppError("FILE_NOT_AVAILABLE");
  });
  return { ...raw, thumbnail, ...(files ? { files } : {}) };
}
